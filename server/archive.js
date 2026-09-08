'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const RAW_DIR = path.join(DATA_DIR, 'raw');

function rawFilePath(unitCode, type, fileDate) {
  // fileDate: YYYYMMDD → группируем по году, чтобы не копить тысячи файлов в одной папке
  const year = fileDate.slice(0, 4);
  const dir = path.join(RAW_DIR, unitCode.toUpperCase(), year);
  return { dir, file: path.join(dir, `${type}-${fileDate}.json`) };
}

/** Сохраняет сырой ответ на диск. Объекты/массивы (LED, UFA) пишутся как JSON;
 *  строки (например, HTML-табло OVB) сохраняются как есть — для удобного просмотра. */
function saveRaw(unitCode, type, fileDate, data) {
  const { dir, file } = rawFilePath(unitCode, type, fileDate);
  fs.mkdirSync(dir, { recursive: true });
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  fs.writeFileSync(file, text);
  return file;
}

function readRaw(unitCode, type, fileDate) {
  const { file } = rawFilePath(unitCode, type, fileDate);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    return text; // сырой текст (например, HTML-табло OVB)
  }
}

module.exports = { DATA_DIR, RAW_DIR, saveRaw, readRaw, rawFilePath };
