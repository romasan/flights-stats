'use strict';

const express = require('express');
const units = require('./units');
const store = require('./store');

const router = express.Router();

router.get('/units', (req, res) => {
  res.json(units.list.map(u => ({ code: u.code, name: u.name })));
});

router.get('/units/:code/flights', (req, res) => {
  const unit = units.get(req.params.code);
  if (!unit) return res.status(404).json({ error: 'Unknown airport code' });

  const departures = store.getFlights(unit.code, 'departure');
  const arrivals = store.getFlights(unit.code, 'arrival');
  const fetchErrorsRaw = store.getFetchErrors(unit.code);

  // Группируем ошибки загрузки по дате для удобства отображения на фронте:
  // [{ date: 'YYYYMMDD', types: ['arrival', 'departure'] }]
  const byDate = new Map();
  for (const e of fetchErrorsRaw) {
    if (!byDate.has(e.fileDate)) byDate.set(e.fileDate, { date: e.fileDate, types: [] });
    byDate.get(e.fileDate).types.push(e.type);
  }
  const fetchErrors = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    unit: { code: unit.code, name: unit.name },
    generatedAt: new Date().toISOString(),
    departures,
    arrivals,
    fetchErrors
  });
});

module.exports = router;
