#!/usr/bin/env node
'use strict';

/**
 * Мигрирует уже сохранённые рейсы Уфы (UFA) на каноническую классификацию
 * статусов (Отправлен/Прибыл, Задержан, Отмена, Без статуса), такую же,
 * как у Пулково (LED).
 *
 * Раньше в таблицу flights у рейсов UFA в status_ru попадал «сырой» статус
 * сайта (Вылетел, Прилетел, Задержка, Отменен, Ожидается, …). Теперь при
 * сборе данных (server/units/ufa.js) в status_ru пишется канонический статус,
 * а исходный текст сохраняется отдельно в status_raw.
 *
 * Скрипт для старых записей:
 *   1) кладёт текущий (исходный) status_ru в status_raw;
 *   2) пересчитывает status_ru в канонический вид той же функцией, что
 *      используется при новом сборе данных.
 *
 * Запуск:
 *   node scripts/migrate-ufa-status.js
 *
 * Скрипт идемпотентен: обрабатывает только строки, где status_raw ещё пуст,
 * поэтому повторный запуск ничего не портит. Рейсы LED не трогаются — у них
 * исходный статус уже канонический, а при новом сборе status_raw заполняется
 * автоматически.
 */

const db = require('../server/db'); // создаст/обновит схему, добавит колонку status_raw
const ufa = require('../server/units/ufa');

const UNIT = 'UFA';

const rows = db.prepare(`
  SELECT id, type, status_ru AS status
  FROM flights
  WHERE unit_code = ? AND status_raw IS NULL
    AND status_ru IS NOT NULL AND status_ru <> ''
`).all(UNIT);

const update = db.prepare('UPDATE flights SET status_ru = ?, status_raw = ? WHERE id = ?');

const apply = db.transaction(() => {
  for (const r of rows) {
    const original = r.status;
    const canonical = ufa.normalizeStatus(original, r.type);
    update.run(canonical, original, r.id);
  }
});

apply();

const dist = db.prepare(`
  SELECT status_ru AS status, COUNT(*) AS n
  FROM flights
  WHERE unit_code = ?
  GROUP BY status_ru
  ORDER BY n DESC
`).all(UNIT);

console.log(`Обработано записей UFA: ${rows.length}`);
console.log('Канонические статусы после миграции:');
for (const row of dist) {
  console.log(`  ${row.status === null ? '(Без статуса)' : row.status}: ${row.n}`);
}
console.log('🎉 Миграция статусов UFA завершена.');
