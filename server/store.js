'use strict';

const db = require('./db');

const upsertFlightsStmt = db.prepare(`
  INSERT INTO flights (
    unit_code, type, file_date, external_id, flight_number,
    status_ru, plan_time, actual_time, event_date, airport_code, airport_name
  ) VALUES (
    @unitCode, @type, @fileDate, @externalId, @flightNumber,
    @status, @plan, @actual, @eventDate, @airportCode, @airportName
  )
  ON CONFLICT(unit_code, type, file_date, external_id) DO UPDATE SET
    flight_number = excluded.flight_number,
    status_ru     = excluded.status_ru,
    plan_time     = excluded.plan_time,
    actual_time   = excluded.actual_time,
    event_date    = excluded.event_date,
    airport_code  = excluded.airport_code,
    airport_name  = excluded.airport_name
`);

const deleteFlightsStmt = db.prepare(`
  DELETE FROM flights WHERE unit_code = ? AND type = ? AND file_date = ?
`);

const replaceFlights = db.transaction((unitCode, type, fileDate, flights) => {
  deleteFlightsStmt.run(unitCode, type, fileDate);
  for (const f of flights) {
    upsertFlightsStmt.run({
      unitCode,
      type,
      fileDate,
      externalId: f.externalId != null ? String(f.externalId) : `noid-${Math.random()}`,
      flightNumber: f.flightNumber,
      status: f.status,
      plan: f.plan,
      actual: f.actual,
      eventDate: f.eventDate,
      airportCode: f.airportCode,
      airportName: f.airportName
    });
  }
});

const mergeFlights = db.transaction((unitCode, type, fileDate, flights) => {
  for (const f of flights) {
    upsertFlightsStmt.run({
      unitCode,
      type,
      fileDate,
      externalId: f.externalId != null ? String(f.externalId) : `noid-${Math.random()}`,
      flightNumber: f.flightNumber,
      status: f.status,
      plan: f.plan,
      actual: f.actual,
      eventDate: f.eventDate,
      airportCode: f.airportCode,
      airportName: f.airportName
    });
  }
});

const upsertFetchLogStmt = db.prepare(`
  INSERT INTO fetch_log (unit_code, type, file_date, status, attempts, message, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(unit_code, type, file_date) DO UPDATE SET
    status = excluded.status,
    attempts = excluded.attempts,
    message = excluded.message,
    updated_at = excluded.updated_at
`);

const getFlightsStmt = db.prepare(`
  SELECT file_date AS fileDate, flight_number AS flightNumber, status_ru AS status,
         plan_time AS plan, actual_time AS actual, event_date AS eventDate,
         airport_code AS airportCode, airport_name AS airportName
  FROM flights
  WHERE unit_code = ? AND type = ?
  ORDER BY event_date, plan_time
`);

const getFetchErrorsStmt = db.prepare(`
  SELECT type, file_date AS fileDate, message, attempts
  FROM fetch_log
  WHERE unit_code = ? AND status = 'error'
  ORDER BY file_date
`);

const getFetchLogEntryStmt = db.prepare(`
  SELECT status, attempts, message
  FROM fetch_log
  WHERE unit_code = ? AND type = ? AND file_date = ?
`);

module.exports = {
  /** Заменяет весь набор рейсов для указанного (unit, type, fileDate). */
  replaceFlights(unitCode, type, fileDate, flights) {
    replaceFlights(unitCode, type, fileDate, flights);
  },

  /** Дополняет/обновляет рейсы по (unit, type, fileDate, external_id), не удаляя уже сохранённые. */
  mergeFlights(unitCode, type, fileDate, flights) {
    mergeFlights(unitCode, type, fileDate, flights);
  },

  recordFetchResult(unitCode, type, fileDate, status, attempts, message) {
    upsertFetchLogStmt.run(unitCode, type, fileDate, status, attempts, message || null);
  },

  getFetchLogEntry(unitCode, type, fileDate) {
    return getFetchLogEntryStmt.get(unitCode, type, fileDate) || null;
  },

  getFlights(unitCode, type) {
    return getFlightsStmt.all(unitCode, type);
  },

  getFetchErrors(unitCode) {
    return getFetchErrorsStmt.all(unitCode);
  }
};
