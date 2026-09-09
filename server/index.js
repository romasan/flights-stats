'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const dotenv = require('dotenv');

// Загружаем переменные из .env (не перезаписывает уже заданные в окружении).
dotenv.config();

const api = require('./api');
const scheduler = require('./scheduler');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(compression());
app.use('/api', api);
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
  scheduler.start(console.log);
});
