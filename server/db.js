'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'flights.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS flights (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_code     TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('arrival', 'departure')),
    file_date     TEXT NOT NULL,        -- YYYYMMDD, дата за которую запрашивались данные
    external_id   TEXT,                 -- исходный ID рейса из API (для идемпотентной записи)
    flight_number TEXT,
    status_ru     TEXT,
    plan_time     TEXT,                 -- STD/STA, ISO-строка как пришла из API
    actual_time   TEXT,                 -- ATD/ATA, ISO-строка как пришла из API
    event_date    TEXT,                 -- YYYY-MM-DD, дата рейса для агрегации (факт → план)
    airport_code  TEXT,
    airport_name  TEXT,
    status_raw    TEXT,                  -- исходный статус с сайта аэропорта (до нормализации)
    UNIQUE(unit_code, type, file_date, external_id)
  );

  CREATE INDEX IF NOT EXISTS idx_flights_event_date ON flights(unit_code, type, event_date);
  CREATE INDEX IF NOT EXISTS idx_flights_file_date ON flights(unit_code, type, file_date);

  CREATE TABLE IF NOT EXISTS fetch_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_code   TEXT NOT NULL,
    type        TEXT NOT NULL,          -- arrival | departure
    file_date   TEXT NOT NULL,          -- YYYYMMDD
    status      TEXT NOT NULL,          -- success | error
    attempts    INTEGER NOT NULL DEFAULT 1,
    message     TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(unit_code, type, file_date)
  );
`);

// Идемпотентная миграция схемы: добавляем колонку status_raw в уже существующие
// базы (в свежих она уже есть в CREATE TABLE).
const flightCols = db.pragma('table_info(flights)').map(c => c.name);
if (!flightCols.includes('status_raw')) {
  db.exec('ALTER TABLE flights ADD COLUMN status_raw TEXT');
}

module.exports = db;
