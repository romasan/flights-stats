'use strict';

const units = require('./units');
const store = require('./store');
const { fetchAndStoreOne } = require('./fetcher');

const RUN_HOUR = Number(process.env.FETCH_HOUR || 1); // час запуска ежедневного сбора (0-23)
const RETRY_DELAY_MS = Number(process.env.FETCH_RETRY_DELAY_MS || 60 * 60 * 1000); // 1 час
const MAX_ATTEMPTS = Number(process.env.FETCH_MAX_ATTEMPTS || 4); // 1 попытка + 3 ретрая

function yesterdayFileDate(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Пытается загрузить один тип рейсов с ретраями: при неудаче ждёт
 * RETRY_DELAY_MS и повторяет, всего до MAX_ATTEMPTS попыток. Итог (успех или
 * ошибка после всех попыток) фиксируется в таблице fetch_log.
 */
async function fetchWithRetries(unit, type, fileDate, log) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const count = await fetchAndStoreOne(unit, type, fileDate);
      store.recordFetchResult(unit.code, type, fileDate, 'success', attempt, null);
      log(`✅ [${unit.code}/${type}] ${fileDate}: сохранено ${count} рейсов (попытка ${attempt}/${MAX_ATTEMPTS})`);
      return true;
    } catch (err) {
      lastError = err;
      log(`❌ [${unit.code}/${type}] ${fileDate}: ошибка попытки ${attempt}/${MAX_ATTEMPTS} — ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  store.recordFetchResult(
    unit.code, type, fileDate, 'error', MAX_ATTEMPTS,
    lastError ? lastError.message : 'unknown error'
  );
  return false;
}

/** Запускает сбор данных за вчера для всех аэропортов и обоих типов рейсов. */
async function runDailyFetch(log = console.log) {
  const fileDate = yesterdayFileDate();
  log(`📅 Начинаем загрузку данных за ${fileDate}...`);
  for (const unit of units.list) {
    for (const type of ['arrival', 'departure']) {
      // Не перезапрашиваем то, что уже успешно загружено (например, при
      // рестарте сервера в тот же день).
      const existing = store.getFetchLogEntry(unit.code, type, fileDate);
      if (existing && existing.status === 'success') {
        log(`↷ [${unit.code}/${type}] ${fileDate}: уже загружено, пропускаем`);
        continue;
      }
      await fetchWithRetries(unit, type, fileDate, log);
    }
  }
  log('🎉 Готово!');
}

function msUntilNextRun(now = new Date()) {
  const next = new Date(now);
  next.setHours(RUN_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let dailyTimer = null;

function scheduleNextRun(log = console.log) {
  const delay = msUntilNextRun();
  const runAt = new Date(Date.now() + delay);
  log(`⏰ Следующий сбор данных запланирован на ${runAt.toLocaleString('ru-RU')}`);
  dailyTimer = setTimeout(async () => {
    try {
      await runDailyFetch(log);
    } catch (err) {
      log(`❌ Непредвиденная ошибка планового сбора: ${err.message}`);
    }
    scheduleNextRun(log);
  }, delay);
}

function start(log = console.log) {
  scheduleNextRun(log);
}

function stop() {
  if (dailyTimer) clearTimeout(dailyTimer);
}

module.exports = { start, stop, runDailyFetch, yesterdayFileDate, fetchWithRetries };
