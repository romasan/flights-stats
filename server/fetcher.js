'use strict';

const archive = require('./archive');
const store = require('./store');

const FETCH_TIMEOUT_MS = 30_000;

async function fetchResponse(request, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(request.url, {
      method: request.method || 'GET',
      headers: Object.assign({ 'User-Agent': userAgent }, request.headers || {}),
      body: request.body,
      signal: controller.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Загружает и сохраняет один тип рейсов (arrival|departure) для аэропорта
 * за указанную дату (YYYYMMDD). Не делает ретраев сама — этим управляет
 * scheduler. Бросает исключение при неудаче.
 *
 * По умолчанию (например, LED) используется GET на unit.urls[type], а ответ —
 * массив, который разбирается через unit.parseFlight(item, type). Юниты с другим
 * форматом запроса/ответа (например, UFA) реализуют unit.buildRequest(type, fileDate)
 * и unit.parseFlights(raw, type, fileDate).
 */
async function fetchAndStoreOne(unit, type, fileDate) {
  const request = unit.buildRequest
    ? unit.buildRequest(type, fileDate)
    : { url: unit.urls[type], method: 'GET' };
  const raw = await fetchResponse(request, unit.userAgent);
  archive.saveRaw(unit.code, type, fileDate, raw);
  const flights = unit.parseFlights
    ? unit.parseFlights(raw, type, fileDate)
    : raw.map(item => unit.parseFlight(item, type));
  if (unit.merge) {
    store.mergeFlights(unit.code, type, fileDate, flights);
  } else {
    store.replaceFlights(unit.code, type, fileDate, flights);
  }
  return flights.length;
}

module.exports = { fetchAndStoreOne };
