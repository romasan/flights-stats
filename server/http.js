'use strict';

// HTTP-клиент для запросов к сайтам аэропортов.
//
// Зачем свой клиент, а не глобальный fetch: сайты иногда переходят на новые
// цепочки сертификатов, которых ещё нет во встроенном в Node хранилище CA.
// Пример — Пулково: с 12.10.2026 отдаёт сертификат от
// «GlobalSign GCC R46 DV TLS CA 2025», не присылая промежуточный сертификат
// в TLS-рукопожатии. Встроенное в Node 18 хранилище не содержит ни этого
// промежуточного, ни корневого «GlobalSign Root R46», поэтому запрос падал с
// `unable to verify the first certificate` / `fetch failed`.
//
// Решение: к встроенным корневым сертификатам Node добавляются сертификаты из
// каталога `server/certs/` (промежуточный + корневой GlobalSign). Каталог
// читается один раз при старте процесса.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const tls = require('tls');

const CERTS_DIR = path.join(__dirname, 'certs');
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

function loadExtraCa() {
  if (!fs.existsSync(CERTS_DIR)) return [];
  return fs
    .readdirSync(CERTS_DIR)
    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
    .sort()
    .map(f => fs.readFileSync(path.join(CERTS_DIR, f), 'utf8'));
}

// Встроенные корни Node + наши дополнительные сертификаты.
const CA = [...tls.rootCertificates, ...loadExtraCa()];

/**
 * Выполняет HTTP(S)-запрос и возвращает тело ответа строкой.
 * Бросает исключение при сетевой ошибке, не-2xx статусе или превышении таймаута.
 *
 * @param {{url: string, method?: string, headers?: object, body?: string}} request
 * @param {string} [userAgent]
 * @returns {Promise<string>}
 */
function requestText(request, userAgent, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const target = new URL(request.url);
    const transport = target.protocol === 'http:' ? http : https;
    const headers = Object.assign(
      { 'User-Agent': userAgent || 'flights-stats' },
      request.headers || {}
    );
    if (request.body != null) {
      headers['Content-Length'] = Buffer.byteLength(request.body);
    }

    const req = transport.request(
      target,
      {
        method: request.method || 'GET',
        headers,
        ca: CA,
        timeout: FETCH_TIMEOUT_MS
      },
      res => {
        const status = res.statusCode || 0;

        // Редирект: повторяем запрос по новому адресу.
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          requestText(Object.assign({}, request, { url: next }), userAgent, redirectsLeft - 1)
            .then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`timeout ${FETCH_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);

    if (request.body != null) req.write(request.body);
    req.end();
  });
}

/**
 * Запрашивает JSON и парсит его.
 * @returns {Promise<any>}
 */
async function requestJson(request, userAgent) {
  const text = await requestText(request, userAgent);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Ответ не является корректным JSON');
  }
}

module.exports = { requestText, requestJson, CA, FETCH_TIMEOUT_MS };
