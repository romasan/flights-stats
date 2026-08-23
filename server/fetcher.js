'use strict';

const archive = require('./archive');
const store = require('./store');

const FETCH_TIMEOUT_MS = 30_000;

async function fetchJson(url, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: controller.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error('Ответ API не является массивом');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Загружает и сохраняет один тип рейсов (arrival|departure) для аэропорта
 * за указанную дату (YYYYMMDD). Не делает ретраев сама — этим управляет
 * scheduler. Бросает исключение при неудаче.
 */
async function fetchAndStoreOne(unit, type, fileDate) {
  const url = unit.urls[type];
  const raw = await fetchJson(url, unit.userAgent);
  archive.saveRaw(unit.code, type, fileDate, raw);
  const flights = raw.map(item => unit.parseFlight(item, type));
  store.replaceFlights(unit.code, type, fileDate, flights);
  return flights.length;
}

module.exports = { fetchAndStoreOne };
