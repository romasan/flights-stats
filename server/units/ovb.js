'use strict';

// Конфигурация аэропорта Толмачёво (OVB, Новосибирск).
//
// В отличие от LED и UFA ответы сайта защищены простым JS-челленджем (куки
// __jhash_, __hash_, __lhash_, …): прямой HTTP-запрос без «прогретого» браузера
// возвращает оболочку челленджа, а не табло. Поэтому юнит ходит на сайт через
// headless-Chromium (playwright-core): загружает страницу табло, дожидается
// прохождения челленджа и затем POST-ом к /ajax/ttable.php снимает HTML табло.
//
// Ключевые факты об источнике:
//   * запрос: POST /ajax/ttable.php, тело application/x-www-form-urlencoded
//     day=yesterday&items_count=0&rel=departure|arrival
//   * «вчера» определяется сайтом в часовом поясе Новосибирска (UTC+7);
//   * параметр rel фактически не фильтрует: ответ — смешанное табло суток, где
//     каждый рейс — карточка <article class="flight-item">, а направление видно
//     из fi-title: «Новосибирск → Город» (вылет) или «Город → Новосибирск» (прилёт);
//   * время в карточке — локальное (Новосибирск), вида «HH:MM, DD.MM».
//     Некоторые рейсы вечерних «вчерашних» суток пересекают полночь — у них
//     «Расчетное время» уже следующего календарного дня.
//   * кода аэропорта в карточке нет — только название города.

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const TT_URL = 'https://tolmachevo.ru/passengers/information/timetable/';
const AJAX_URL = 'https://tolmachevo.ru/ajax/ttable.php';
const DAY = 'yesterday';

// ==== Парсинг HTML-карточек рейсов (работает и на сохранённом сырье) ====

function collapse(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Текст внутри элемента с заданным CSS-классом (теги выкидываются).
function grab(html, cls) {
  const re = new RegExp(
    '<[a-z]+[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</[a-z]+>',
    'i'
  );
  const m = html.match(re);
  return m ? collapse(m[1]) : '';
}

// Пары «название → значение» из списка fi-info (Номер рейса, По расписанию, …).
function infoMap(html) {
  const map = {};
  const re = /<span class="fi-info__name">([\s\S]*?)<\/span>\s*<span class="fi-info__value">([\s\S]*?)<\/span>/g;
  for (const m of html.matchAll(re)) {
    const name = collapse(m[1]).replace(/[:：]\s*$/, '').toLowerCase();
    map[name] = collapse(m[2]);
  }
  return map;
}

// «HH:MM, DD.MM» -> { hh, mm, dd, mo }, либо null.
function parseTblTime(v) {
  const s = String(v == null ? '' : v);
  const m = s.match(/(\d{1,2}):(\d{2})\s*,?\s*(\d{1,2})\.(\d{2})/);
  return m ? { hh: +m[1], mm: +m[2], dd: +m[3], mo: +m[4] } : null;
}

const pad2 = n => String(n).padStart(2, '0');

// Год для даты DD.MM: выбираем из {refY-1, refY, refY+1} тот, где DD.MM ближе
// всего к референсной дате (fileDate — дата запрошенных «вчерашних» суток).
function resolveYear(mo, dd, refY, refM, refD) {
  const base = Date.UTC(refY, refM - 1, refD);
  let best = refY;
  let bestDist = Infinity;
  for (const y of [refY - 1, refY, refY + 1]) {
    const dist = Math.abs(Date.UTC(y, mo - 1, dd) - base) / 86400000;
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

const isoDate = (y, mo, dd) => `${y}-${pad2(mo)}-${pad2(dd)}`;
const isoDateTime = (y, mo, dd, hh, mm) => `${isoDate(y, mo, dd)}T${pad2(hh)}:${pad2(mm)}:00`;

// Город на противоположном конце маршрута (запасной вариант для названия).
function remoteCity(title) {
  const m = String(title || '').match(/^\s*([^\n→]+?)\s*→/);
  const m2 = String(title || '').match(/→\s*([^\n]+?)\s*$/);
  return (m && m[1]) || (m2 && m2[1]) || null;
}

// Канонический статус — тот же словарь, что у UFA: «задерж…» → Задержан,
// «отмен…» → Отмена; выполненный вылет → Отправлен, прилёт → Прибыл.
function canonicalStatus(raw, type) {
  const s = (raw == null ? '' : String(raw)).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('задерж')) return 'Задержан';
  if (s.includes('отмен')) return 'Отмена';
  if (type === 'departure' && s.includes('вылет')) return 'Отправлен';
  if (type === 'arrival' && (s.includes('прилет') || s.includes('прибыл'))) return 'Прибыл';
  return null;
}

module.exports = {
  code: 'OVB',
  name: 'Толмачёво',
  userAgent: DEFAULT_UA,

  // Ежедневный сбор данных за «вчера», как у LED. «Вчера» считаем в часовом
  // поясе Новосибирска (так его определяет сам источник).
  dateMode: 'yesterday',
  timeZone: 'Asia/Novosibirsk',
  schedule: 'daily',

  // Снимает сырой HTML табло через браузер (обходит JS-челлендж). Вызывается
  // fetcher'ом вместо обычного HTTP-запроса (см. server/fetcher.js).
  fetchRawHtml(type, fileDate) {
    return fetchBoardHtml();
  },

  // Разбирает HTML-карточки и оставляет только рейсы нужного типа
  // (arrival = прилёты «Город → Новосибирск», departure = вылеты
  // «Новосибирск → Город»). Нормализует в единый вид для БД.
  parseFlights(raw, type, fileDate) {
    if (typeof raw !== 'string' || raw.indexOf('flight-item') === -1) {
      throw new Error('Ответ OVB пуст или не похож на табло (вероятно JS-челлендж)');
    }

    const ref = { y: +fileDate.slice(0, 4), m: +fileDate.slice(4, 6), d: +fileDate.slice(6, 8) };
    const flights = [];
    const cardRe = /<article class="flight-item">([\s\S]*?)<\/article>/g;

    for (const m of raw.matchAll(cardRe)) {
      const block = m[1];
      const title = grab(block, 'fi-title');

      // Направление рейса по строке маршрута.
      const isOut = /Новосибирск\s*→/.test(title); // вылет из Новосибирска
      const isIn = /→\s*Новосибирск/.test(title);  // прилёт в Новосибирск
      // Пропускаем карточки, чьё направление однозначно противоположно нужному типу.
      if (type === 'departure' && isIn && !isOut) continue;
      if (type === 'arrival' && isOut && !isIn) continue;

      const info = infoMap(block);
      const flightNumber = info['номер рейса'] || grab(block, 'tth-flight') || null;
      const rawStatus = grab(block, 'tth-status') || null;

      // Дата/время: план — «По расписанию», факт — «Расчетное время».
      const planT = parseTblTime(info['по расписанию']);
      const actT = parseTblTime(info['расчетное время']);

      let plan = null;
      let planDate = null; // календарная дата по расписанию (событие рейса)
      if (planT) {
        const y = resolveYear(planT.mo, planT.dd, ref.y, ref.m, ref.d);
        planDate = isoDate(y, planT.mo, planT.dd);
        plan = isoDateTime(y, planT.mo, planT.dd, planT.hh, planT.mm);
      }

      let actual = null;
      if (actT) {
        const y = resolveYear(actT.mo, actT.dd, ref.y, ref.m, ref.d);
        actual = isoDateTime(y, actT.mo, actT.dd, actT.hh, actT.mm);
      }

      const fallbackDate = `${fileDate.slice(0, 4)}-${fileDate.slice(4, 6)}-${fileDate.slice(6, 8)}`;
      flights.push({
        externalId: flightNumber,
        flightNumber,
        status: canonicalStatus(rawStatus, type),
        statusRaw: rawStatus,
        plan,
        actual,
        airportCode: null, // в карточке Толмачёво нет кода, только название
        airportName: grab(block, 'tth-destination') || remoteCity(title) || null,
        eventDate: planDate || (actual ? actual.slice(0, 10) : fallbackDate)
      });
    }
    return flights;
  }
};

// ==== Загрузка через Playwright (обход JS-челленджа) ====

let _browser = null;
let _page = null;
let _sessAt = 0;
let _idleTimer = null;
let _htmlCache = null; // { key, html, at }

const SESSION_TTL_MS = 2 * 60 * 1000; // сессия живёт 2 минуты без использования
const IDLE_CLOSE_MS = 60 * 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Первый заход возвращает оболочку JS-челленджа, которая ставит куки и
// перезагружает страницу (~1 с). Дожидаемся перезагрузки, повторный заход уже
// с куками даёт настоящее табло.
async function passChallenge(page) {
  await page.goto(TT_URL, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
  try {
    await page.waitForNavigation({ waitUntil: 'load', timeout: 25_000 });
  } catch (e) { /* перезагрузка могла уже произойти */ }
  await sleep(2500);
  await page.goto(TT_URL, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
  await sleep(1200);
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
    if (_browser && Date.now() - _sessAt > IDLE_CLOSE_MS) {
      closeSession().catch(() => {});
    }
  }, IDLE_CLOSE_MS + 1000);
  if (_idleTimer.unref) _idleTimer.unref();
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

// Один POST-запрос к табло в контексте «прогретой» страницы (куки уже есть).
async function postBoard(page) {
  return page.evaluate(async ({ url, body }) => {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: '*/*'
      },
      body
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  }, { url: AJAX_URL, body: `day=${DAY}&items_count=0&rel=departure` });
}

function looksLikeBoard(html) {
  return typeof html === 'string' && html.indexOf('flight-item') !== -1 && html.indexOf('__jhash_') === -1;
}

async function fetchBoardHtml() {
  // Короткий кэш: оба типа рейсов за одну дату используют один и тот же ответ.
  if (_htmlCache && Date.now() - _htmlCache.at < 30 * 1000) return _htmlCache.html;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const page = await ensureSession();
      const html = await postBoard(page);
      if (looksLikeBoard(html)) {
        _sessAt = Date.now();
        _htmlCache = { key: DAY, html, at: Date.now() };
        return html;
      }
      lastErr = new Error('OVB: ответ не похож на табло (вероятно JS-челлендж)');
    } catch (err) {
      lastErr = err;
    }
    await closeSession();
    await sleep(3000);
  }
  _htmlCache = null;
  throw lastErr || new Error('OVB: не удалось получить табло');
}

