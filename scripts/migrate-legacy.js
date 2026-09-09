#!/usr/bin/env node
'use strict';

/**
 * Разовый скрипт миграции старых данных в новую SQLite-схему.
 *
 * Ищет в указанной директории (по умолчанию — корень проекта) файлы вида
 * arrival-YYYYMMDD.json / departure-YYYYMMDD.json (формат старого
 * fetch_flights.sh для аэропорта Пулково, LED), а также лог
 * fetch_flights.log, и:
 *   1) сохраняет сырые JSON-ответы в архив data/raw/LED/<год>/...;
 *   2) парсит рейсы и записывает их в таблицу flights;
 *   3) по данным лога восстанавливает записи об ошибках загрузки в fetch_log
 *      (только для дней/типов, для которых нет успешно загруженного JSON-файла).
 *
 * Использование:
 *   node scripts/migrate-legacy.js [--src=/path/to/files] [--log=/path/to/fetch_flights.log]
 */

const fs = require('fs');
const path = require('path');

const archive = require('../server/archive');
const store = require('../server/store');
const units = require('../server/units');

const args = process.argv.slice(2);
function argValue(name, def) {
  const prefix = `--${name}=`;
  const found = args.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : def;
}

const SRC_DIR = path.resolve(argValue('src', path.join(__dirname, '..')));
const LOG_PATH = path.resolve(argValue('log', path.join(SRC_DIR, 'fetch_flights.log')));

// Пока миграция жёстко привязана к LED (это формат старого fetch_flights.sh).
// При добавлении новых аэропортов с другим форматом старых данных сюда можно
// добавить параметр --unit и соответствующую ветку.
const unit = units.get('LED');

function parseFetchLog(text) {
  const failedDays = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    if (cur.errors.length) failedDays.push(cur);
    cur = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const dateMatch = line.match(/Начинаем загрузку данных за (\d{8})/);
    if (dateMatch) {
      flush();
      cur = { date: dateMatch[1], errors: [], section: null };
      continue;
    }
    if (!cur) continue;
    if (line.includes('Загрузка прилетов')) {
      cur.section = 'arrival';
      continue;
    }
    if (line.includes('Загрузка вылетов')) {
      cur.section = 'departure';
      continue;
    }
    if (line.startsWith('❌')) {
      const errType = line.includes('прилет')
        ? 'arrival'
        : line.includes('вылет')
          ? 'departure'
          : cur.section || 'unknown';
      if (!cur.errors.includes(errType)) cur.errors.push(errType);
    }
  }
  flush();

  return failedDays;
}

function findLegacyFiles(dir) {
  const files = fs.readdirSync(dir);
  const result = [];
  for (const file of files) {
    const m = file.match(/^(arrival|departure)-(\d{8})\.json$/i);
    if (!m) continue;
    result.push({ type: m[1].toLowerCase(), fileDate: m[2], file: path.join(dir, file) });
  }
  return result;
}

function migrateFlightFiles() {
  const files = findLegacyFiles(SRC_DIR);
  files.sort((a, b) => a.fileDate.localeCompare(b.fileDate));
  console.log(`Найдено ${files.length} JSON-файлов в ${SRC_DIR}`);

  const loadedKeys = new Set(); // `${type}-${fileDate}` — успешно загруженные
  let ok = 0;
  let failed = 0;

  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('содержимое не является массивом');

      archive.saveRaw(unit.code, f.type, f.fileDate, raw);
      const flights = raw.map(item => unit.parseFlight(item, f.type));
      store.replaceFlights(unit.code, f.type, f.fileDate, flights);
      store.recordFetchResult(unit.code, f.type, f.fileDate, 'success', 1, null);

      loadedKeys.add(`${f.type}-${f.fileDate}`);
      ok++;
    } catch (err) {
      failed++;
      console.error(`❌ Ошибка миграции ${f.file}: ${err.message}`);
    }
  }

  console.log(`Загружено успешно: ${ok}, с ошибками: ${failed}`);
  return loadedKeys;
}

function migrateLog(loadedKeys) {
  if (!fs.existsSync(LOG_PATH)) {
    console.log(`Лог не найден по пути ${LOG_PATH}, пропускаем восстановление ошибок`);
    return;
  }

  const text = fs.readFileSync(LOG_PATH, 'utf8');
  const failedDays = parseFetchLog(text);
  console.log(`В логе найдено ${failedDays.length} дней с ошибками`);

  let recorded = 0;
  for (const day of failedDays) {
    const types = day.errors.includes('unknown') ? ['arrival', 'departure'] : day.errors;
    for (const type of types) {
      if (!['arrival', 'departure'].includes(type)) continue;
      const key = `${type}-${day.date}`;
      if (loadedKeys.has(key)) continue; // за этот день данные всё же есть — не считаем ошибкой
      store.recordFetchResult(unit.code, type, day.date, 'error', 4, 'Восстановлено из fetch_flights.log при миграции');
      recorded++;
    }
  }
  console.log(`Записей об ошибках восстановлено: ${recorded}`);
}

function main() {
  if (!unit) {
    console.error('Не найден конфиг аэропорта LED');
    process.exit(1);
  }
  const loadedKeys = migrateFlightFiles();
  migrateLog(loadedKeys);
  console.log('🎉 Миграция завершена.');
}

main();
