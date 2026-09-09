'use strict';

// Конфигурация аэропорта Внуково (VKO, Москва).
//
// Онлайн-табло vnukovo.ru — SPA на Vue: прямой HTTP-запрос возвращает оболочку
// JS-челленджа (настоящий контент ставится куками __js_p_, __hash_, … и
// открывается только после выполнения скрипта в браузере), а данные табло сайт
// получает из /rest/flights/online в зашифрованном виде и расшифровывает их на
// фронте. Поэтому юнит, как и OVB, ходит через headless-Chromium (playwright-core)
// и снимает уже отрендеренный DOM.
//
// Важные ограничения источника (из-за них юнит «best-effort»):
//   * табло — «живая» лента, идущая назад от текущего момента и переходящая через
//     границы дней; чтобы собрать весь завершённый «вчерашний» день, нужно много
//     раз дожимать кнопку «Загрузить предыдущие рейсы». Самый надёжный фильтр —
//     метка календарного дня у каждого рейса («8 сентября»): из ленты оставляем
//     только рейсы целевого дня (fileDate).
//   * у уже завершённых рейсов VKO почти всегда «схлопывает» статус в
//     «Совершил посадку» без фактического времени (факт «Вылетел в ЧЧ:ММ» /
//     «Прилетел в ЧЧ:ММ» остаётся лишь у части). Поэтому фактическое время и,
//     как следствие, задержки для вчерашнего дня в основном недоступны: юнит
//     корректно считает рейсы и отмены, а невыполненные (без факта) — помечает
//     как «Отправлен/Прибыл» без времени (фронтенд не выведет «Задержан»).
//   * код и город удалённого аэропорта — у первого сегмента маршрута рейса.

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const HOME_URL = 'https://www.vnukovo.ru/';
const TABLO_URL =
  'https://www.vnukovo.ru/ru/for-passengers/reysi/online-tablo/';

const SESSION_TTL_MS = 3 * 60 * 1000;
const IDLE_CLOSE_MS = 60 * 1000;
const LOAD_PREV_MAX_ITERS = 200;
const LOAD_PREV_IDLE_LIMIT = 6;

// ==== Разбор DOM (работает и на сохранённом «сырье»-массиве строк) ====

const RU_MONTHS = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12
};

const pad2 = n => String(n).padStart(2, '0');

const fileDateISO = fd => `${fd.slice(0, 4)}-${fd.slice(4, 6)}-${fd.slice(6, 8)}`;

// Прибавляет n дней к ISO-дате YYYY-MM-DD (в UTC).
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// «8 сентября» → { mo, dd } либо null.
function parseDayLabel(label) {
  const m = String(label || '').trim()
    .match(/^(\d{1,2})\s+(январ\S+|феврал\S+|март\S+|апрел\S+|ма[йя]\S*|июн\S+|июл\S+|август\S+|сентябр\S+|октябр\S+|ноябр\S+|декабр\S+)/i);
  if (!m) return null;
  const dd = +m[1];
  const name = m[2].toLowerCase();
  // В метке месяц уже в родительном падеже — ищем его как есть в словаре.
  const mo = RU_MONTHS[name];
  if (!mo) return null;
  return { mo, dd };
}

// Дата для «DD месяц»: выбираем из {refY-1, refY, refY+1} ближайшую к refIso.
function resolveDayDate(label, refIso) {
  const p = parseDayLabel(label);
  if (!p) return null;
  const ry = +refIso.slice(0, 4);
  const rmo = +refIso.slice(5, 7);
  const rd = +refIso.slice(8, 10);
  const base = Date.UTC(ry, rmo - 1, rd);
  let best = ry;
  let bestDist = Infinity;
  for (const y of [ry - 1, ry, ry + 1]) {
    const dist = Math.abs(Date.UTC(y, p.mo - 1, p.dd) - base) / 86400000;
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return `${best}-${pad2(p.mo)}-${pad2(p.dd)}`;
}

// Канонический статус (тот же словарь, что у UFA/OVB/SVO): отмена по слову
// «отмен…», иначе для прошедшего (целевого «вчерашнего») дня — рейс выполнен:
// вылет → «Отправлен», прилёт → «Прибыл». «Задержан» не ставим: фронтенд
// вычисляет его сам по факту/плану там, где факт доступен.
function canonicalStatus(rawStatus, type) {
  const s = String(rawStatus == null ? '' : rawStatus).trim().toLowerCase();
  if (s.includes('отмен')) return 'Отмена';
  return type === 'departure' ? 'Отправлен' : 'Прибыл';
}

// «HH:MM» → минуты от полуночи, либо null.
const toMin = hhmm => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : null;
};

function extractHhMm(text) {
  const m = String(text || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${pad2(m[1])}:${m[2]}` : null;
}

// Нормализует массив «сырых» строк рейсов (что вернул браузер / сохранено на
// диск) в единый вид для БД. Оставляет только рейсы целевого дня (fileDate).
function normalizeRows(rawRows, type, fileDate) {
  const expected = fileDateISO(fileDate);
  const seen = new Set();
  const flights = [];

  for (const r of rawRows || []) {
    if (!r || !r.id) continue;
    const eventDate = resolveDayDate(r.timeDay || r.dayLabel || '', expected);
    // Оставляем только рейсы запрошенного календарного дня.
    if (!eventDate || eventDate !== expected) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);

    const planTime = extractHhMm(r.time);
    const rawStatus = r.status || null;

    // Фактическое время, если источник его раскрыл («Вылетел в ЧЧ:ММ» у вылета,
    // «Прилетел в ЧЧ:ММ» у прилёта); иначе — null (задержку не посчитать).
    let actual = null;
    const actualCap = rawStatus
      ? rawStatus.match(type === 'departure' ? /Вылетел в\s*(\d{1,2}:\d{2})/ : /Прилетел в\s*(\d{1,2}:\d{2})/)
      : null;
    const actualText = actualCap ? extractHhMm(actualCap[1]) : null;
    if (actualText) {
      let d = eventDate;
      const pm = planTime ? toMin(planTime) : null;
      const am = toMin(actualText);
      // Переход через полночь у «полуночных» рейсов (план поздно вечером, факт
      // ранним утром следующего дня). Разрыв «план − факт» в минутах огромный
      // (несколько часов), тогда как ранний прилёт того же вечера даёт малый
      // разрыв — его на следующий день не переносим.
      if (pm != null && am != null && pm - am > 600) d = addDaysIso(d, 1);
      actual = `${d}T${actualText}:00`;
    }

    const plan = planTime ? `${eventDate}T${planTime}:00` : null;

    flights.push({
      externalId: r.id,
      flightNumber: (Array.isArray(r.fl) && r.fl[0]) || null,
      status: canonicalStatus(rawStatus, type),
      statusRaw: rawStatus,
      plan,
      actual,
      airportCode: r.code || null,
      airportName: r.city || null,
      eventDate
    });
  }
  return flights;
}

module.exports = {
  code: 'VKO',
  name: 'Внуково',
  userAgent: DEFAULT_UA,

  // Ежедневный сбор данных за «вчера». «Вчера» считаем в московском времени
  // (UTC+3) — так его показывает и сам источник (табло VKO).
  dateMode: 'yesterday',
  timeZone: 'Europe/Moscow',
  schedule: 'daily',

  // Снимает DOM-строки рейсов через браузер (обходит JS-челлендж и дешифровку
  // табло на фронте). Вызывается fetcher'ом вместо обычного HTTP-запроса.
  fetchRawHtml(type, fileDate) {
    return collectType(type, fileDate);
  },

  // Разбирает «сырые» строки рейсов в нормализованный вид для БД.
  parseFlights(raw, type, fileDate) {
    if (!Array.isArray(raw)) {
      throw new Error('Ответ VKO не является массивом строк рейсов');
    }
    return normalizeRows(raw, type, fileDate);
  }
};

// ==== Загрузка через Playwright (обход JS-челленджа) ====
let _browser = null;
let _page = null;
let _sessAt = 0;
let _idleTimer = null;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function closeSession() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (_browser) {
    try {
      await _browser.close();
    } catch (e) { /* не критично */ }
  }
  _browser = null;
  _page = null;
  _sessAt = 0;
}

function armIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    if (_browser && Date.now() - _sessAt > IDLE_CLOSE_MS) closeSession().catch(() => {});
  }, IDLE_CLOSE_MS + 1000);
  if (_idleTimer.unref) _idleTimer.unref();
}

// Первый заход на сайт возвращает оболочку JS-челленджа, которая ставит куки и
// перезагружает страницу; дожидаемся реальной главной.
async function passChallenge(page) {
  for (let i = 0; i < 20; i++) {
    try {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (e) { /* ретрай */ }
    const title = await page.title().catch(() => '');
    const cookies = await page.context().cookies().catch(() => []);
    if (title && !/подождите|challenge|verify|проверк|доступ/i.test(title) && cookies.length > 0) {
      return;
    }
    await sleep(1800);
  }
  throw new Error('VKO: не удалось пройти JS-челлендж главной страницы');
}

async function ensureSession() {
  if (_browser && _page && Date.now() - _sessAt < SESSION_TTL_MS) return _page;
  await closeSession();
  const { chromium } = require('playwright-core');
  _browser = await chromium.launch({ headless: true });
  const ctx = await _browser.newContext({
    userAgent: DEFAULT_UA,
    locale: 'ru-RU',
    viewport: { width: 1366, height: 900 }
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  _page = await ctx.newPage();
  _sessAt = Date.now();
  await passChallenge(_page);
  armIdleClose();
  return _page;
}

// Собирает «сырые» строки рейсов одного типа из отрендеренного табло.
async function scrapeRawRows(page) {
  return page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a.timetable__row[role="article"]')) {
      const href = a.getAttribute('href') || '';
      const idm = href.match(/(\d+)\s*$/);
      const timeEl = a.querySelector('._time time');
      const dayEl = timeEl && timeEl.nextElementSibling;
      const airportEl = a.querySelector('.fl-airport');
      let city = '';
      if (airportEl) {
        for (const node of airportEl.childNodes) {
          if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim()) {
            city = node.textContent.trim();
            break;
          }
        }
      }
      out.push({
        id: idm ? idm[1] : null,
        time: (timeEl ? timeEl.textContent : '').trim(),
        timeDay: (dayEl ? dayEl.textContent : '').trim(),
        dayLabel: (a.querySelector('._time') ? (a.querySelector('._time').textContent || '') : '').trim(),
        fl: [...a.querySelectorAll('.fl-number')].map(x => (x.textContent || '').trim()),
        city,
        code: ((a.querySelector('.fl-airport-code') || {}).textContent || '').trim(),
        status: ((a.querySelector('.fl-status__content') || {}).textContent || '').trim(),
        statusCls: ((a.querySelector('.fl-status') || {}).className || '').trim()
      });
    }
    return out;
  }).catch(() => []);
}

// Идём по «живой» ленте кнопкой «Загрузить предыдущие рейсы», пока целевой день
// (fileDate) не будет пройден целиком (появится день раньше) либо лента станет.
async function collectType(type, fileDate) {
  const bound = type === 'arrival' ? 'arrival' : 'departure';
  const expected = fileDateISO(fileDate);

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const page = await ensureSession();
      _sessAt = Date.now();

      await page.goto(`${TABLO_URL}?bound=${bound}`, {
        waitUntil: 'domcontentloaded',
        timeout: 40_000
      }).catch(() => {});
      await sleep(9000);

      const hasFeed = await page
        .locator('a.timetable__row[role="article"]')
        .count()
        .catch(() => 0);
      if (!hasFeed) throw new Error('VKO: табло не отрисовалось');

      const allById = new Map();
      let seenEarlierDay = false;
      let idle = 0;

      const ingest = rows => {
        for (const r of rows) {
          if (!r || !r.id) continue;
          allById.set(r.id, r);
          const d = resolveDayDate(r.timeDay || r.dayLabel || '', expected);
          if (d && d < expected) seenEarlierDay = true;
        }
      };

      for (let i = 0; i < LOAD_PREV_MAX_ITERS; i++) {
        const before = allById.size;
        ingest(await scrapeRawRows(page));
        if (seenEarlierDay) break; // целевой день пройден целиком

        const btn = page.locator('button:has-text("Загрузить предыдущие рейсы")');
        const hasBtn = await btn.count().catch(() => 0);
        if (!hasBtn) break;
        const grew = allById.size > before;
        idle = grew ? 0 : idle + 1;
        if (idle >= LOAD_PREV_IDLE_LIMIT) break;

        await btn.first().click({ force: true }).catch(() => {});
        await sleep(1600);
      }
      ingest(await scrapeRawRows(page));

      const rawRows = [...allById.values()];
      if (rawRows.length === 0) throw new Error('VKO: пустая лента табло');
      _sessAt = Date.now();
      return rawRows;
    } catch (err) {
      lastErr = err;
    }
    await closeSession();
    await sleep(3000);
  }
  throw lastErr || new Error('VKO: не удалось получить табло');
}



