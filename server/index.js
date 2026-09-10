'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const dotenv = require('dotenv');

// Загружаем переменные из .env (не перезаписывает уже заданные в окружении).
dotenv.config();

const api = require('./api');
const scheduler = require('./scheduler');
const units = require('./units');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

const app = express();
app.use(compression());
app.use('/api', api);
app.use(express.static(PUBLIC_DIR));

// SPA-роутинг: ссылки вида /<код аэропорта>/ (например /ufa/) отдают index.html,
// чтобы страницу можно было сохранить в закладки или отправить. Клиент сам
// выбирает аэропорт по адресу. Неизвестные коды уходят дальше (404), а запросы
// /api/* обрабатываются выше и сюда не попадают.
app.get(/^\/([a-zA-Z]{3})\/?$/, (req, res, next) => {
  if (!units.get(req.params[0])) return next();
  res.sendFile(INDEX_FILE);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
  scheduler.start(console.log);
});
