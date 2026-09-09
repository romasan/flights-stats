'use strict';

const units = require('./units');
const store = require('./store');
const { fetchAndStoreOne } = require('./fetcher');

const RUN_HOUR = Number(process.env.FETCH_HOUR || 1); // час запуска ежедневного сбора (для daily-юнитов)
const DEFAULT_RETRY_DELAY_MS = Number(process.env.FETCH_RETRY_DELAY_MS || 60 * 60 * 1000); // 1 час
const DEFAULT_MAX_ATTEMPTS = Number(process.env.FETCH_MAX_ATTEMPTS || 4); // 1 попытка + 3 ретрая

function yesterdayFileDate(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Текущая дата (YYYYMMDD) в заданном часовом поясе. */
function todayFileDate(timeZone = 'UTC', now = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}${parts.month}${parts.day}`;
}

/** Сдвиг даты YYYYMMDD на days календарных дней (в UTC-арифметике). */
function shiftFileDate(yyyymmdd, days) {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const Y = dt.getUTCFullYear();
  const M = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const D = String(dt.getUTCDate()).padStart(2, '0');
  return `${Y}${M}${D}`;
}

/** Дата «вчера» в заданном часовом поясе (для фиксированных поясов без DST). */
function yesterdayFileDateInTz(timeZone, now = new Date()) {
  return shiftFileDate(todayFileDate(timeZone, now), -1);
}

/**
 * Целевая дата (YYYYMMDD) сбора для юнита: «сегодня» для dateMode='today'
 * (по поясу юнита), иначе — «вчера» (по поясу юнита либо по локальному времени).
 */
function unitFileDate(unit, now) {
  if (unit.dateMode === 'today') return todayFileDate(unit.timeZone || 'UTC', now);
  return unit.timeZone ? yesterdayFileDateInTz(unit.timeZone, now) : yesterdayFileDate(now);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Ретраи конкретного юнита (переопределяют глобальные значения). */
function retryConfig(unit) {
  return {
    retryDelayMs: unit.retryDelayMs != null ? unit.retryDelayMs : DEFAULT_RETRY_DELAY_MS,
    maxAttempts: unit.maxAttempts != null ? unit.maxAttempts : DEFAULT_MAX_ATTEMPTS
  };
}

/** Есть ли успешно загруженные данные обоих типов рейсов за дату (YYYYMMDD). */
function unitHasDataFor(unit, fileDate) {
  return ['arrival', 'departure'].every(type => {
    const entry = store.getFetchLogEntry(unit.code, type, fileDate);
    return entry && entry.status === 'success';
  });
}

/**
 * Пытается загрузить один тип рейсов с ретраями: при неудаче ждёт
 * retryDelayMs и повторяет, всего до maxAttempts попыток. Итог (успех или
 * ошибка после всех попыток) фиксируется в таблице fetch_log.
 */
async function fetchWithRetries(unit, type, fileDate, log) {
  const { retryDelayMs, maxAttempts } = retryConfig(unit);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const count = await fetchAndStoreOne(unit, type, fileDate);
      store.recordFetchResult(unit.code, type, fileDate, 'success', attempt, null);
      log(`✅ [${unit.code}/${type}] ${fileDate}: сохранено ${count} рейсов (попытка ${attempt}/${maxAttempts})`);
      return true;
    } catch (err) {
      lastError = err;
      log(`❌ [${unit.code}/${type}] ${fileDate}: ошибка попытки ${attempt}/${maxAttempts} — ${err.message}`);
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    }
  }
  store.recordFetchResult(
    unit.code, type, fileDate, 'error', maxAttempts,
    lastError ? lastError.message : 'unknown error'
  );
  return false;
}

/**
 * Запускает сбор данных для одного аэропорта за его целевую дату
 * (вчера для daily-юнитов, сегодня для interval-юнитов) по обоим типам рейсов.
 */
async function runUnitFetch(unit, log = console.log) {
  const fileDate = unitFileDate(unit);
  log(`📅 [${unit.code}] загружаем данные за ${fileDate} (${unit.dateMode})`);
  for (const type of ['arrival', 'departure']) {
    // Для вчерашних данных не перезапрашиваем уже успешно загруженное
    // (например, при рестарте сервера в тот же день). Для «сегодня» всегда
    // обновляем статусы по интервалу.
    if (unit.dateMode !== 'today') {
      const existing = store.getFetchLogEntry(unit.code, type, fileDate);
      if (existing && existing.status === 'success') {
        log(`↷ [${unit.code}/${type}] ${fileDate}: уже загружено, пропускаем`);
        continue;
      }
    }
    await fetchWithRetries(unit, type, fileDate, log);
  }
}

function msUntilNextDailyRun(now, hour) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

const timers = new Map();

/**
 * Планирует следующий запуск сбора для одного юнита. У interval-юнитов
 * (например, UFA) первый запуск происходит сразу при старте сервера, далее —
 * через intervalMs. У daily-юнитов (LED, OVB) сбор идёт за «вчера» в заданный час
 * (unit.fetchHour или RUN_HOUR); если при старте сервера данных за «вчера» ещё нет
 * (например, после ночного простоя сервера), первый запуск выполняется сразу,
 * чтобы не потерять сутки, а затем сервер возвращается к обычному ежедневному расписанию.
 */
function scheduleUnit(unit, log, first = false) {
  if (timers.has(unit.code)) clearTimeout(timers.get(unit.code));

  let delay;
  if (unit.schedule === 'interval') {
    delay = first ? 0 : (unit.intervalMs || DEFAULT_RETRY_DELAY_MS);
    if (!first) {
      log(`⏰ [${unit.code}] следующий сбор через ${Math.round(delay / 60000)} мин`);
    }
  } else {
    const now = new Date();
    const hour = unit.fetchHour != null ? unit.fetchHour : RUN_HOUR;
    // Ежедневный юнит собирает «вчерашние» данные (dateMode != 'today'). Если
    // данных за целевую дату ещё нет — при старте запускаемся немедленно.
    const targetDate = unitFileDate(unit, now);
    const needStartupFetch = first && unit.dateMode !== 'today' && !unitHasDataFor(unit, targetDate);
    delay = needStartupFetch ? 0 : msUntilNextDailyRun(now, hour);
    if (needStartupFetch) {
      log(`🚀 [${unit.code}] данных за ${targetDate} ещё нет — собираем сразу при старте сервера`);
    } else {
      const runAt = new Date(Date.now() + delay);
      log(`⏰ [${unit.code}] следующий сбор запланирован на ${runAt.toLocaleString('ru-RU')}`);
    }
  }

  const timer = setTimeout(async () => {
    try {
      await runUnitFetch(unit, log);
    } catch (err) {
      log(`❌ [${unit.code}] Непредвиденная ошибка планового сбора: ${err.message}`);
    }
    scheduleUnit(unit, log, false);
  }, delay);
  timers.set(unit.code, timer);
}

function start(log = console.log) {
  for (const unit of units.list) scheduleUnit(unit, log, true);
}

function stop() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

module.exports = { start, stop, runUnitFetch, fetchWithRetries, yesterdayFileDate, todayFileDate };

