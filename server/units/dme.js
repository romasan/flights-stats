'use strict';

// Конфигурация аэропорта Домодедово (DME, Москва).
//
// В отличие от Пулково (LED) у DME нет публичного API, отдающего произвольную
// дату: онлайн-табло dme.ru показывает только «живое» скользящее окно примерно
// на 2–3 часа вокруг текущего момента (и для вылетов, и для прилётов), а
// докручивание истории (OnlineTableWideScrolling) закрыто анти-бот защитой
// (`wv-data`), которую не хочется воспроизводить. Поэтому, как и у Уфы (UFA),
// юнит ходит «вживую»: раз в час снимает доступное окно табло, а рейсы
// накапливает по externalId (режим merge), не удаляя уже виденные.
//
// Табло отдаётся сервером сразу готовым HTML (JS-челленджа нет), поэтому юнит
// использует обычный HTTP GET, без headless-браузера. Каждая строка рейса —
// <tr class="vat "> с колонками: плановое время, фактическое время, номер рейса,
// город-аэропорт и «тикер» статуса (<ul class="ticker"><li>…).
//
// Важно про «сегодняшний» день: окно табло завязано на текущий момент и
// переходит через полночь. Чтобы к концу суток в БД лежал цельный день и не
// было дублей на границе дней, из каждого снимка сохраняем только рейсы, чей
// ПЛАНОВЫЙ день совпадает с целевой датой fileDate («сегодня» по Москве).
// Рейсы соседних дней (попавшие в окно) отбрасываем — они будут собраны, когда
// их день станет целевым. Дата рейса для агрегации берётся по плановому времени
// (рейс относится к своему операционному дню), а статус/факт приходят позже в
// следующих снимках и обновляют ту же строку.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const BOARD_URL = 'https://www.dme.ru/flight/live-board/';

// Сокращения русских месяцев («сен» ← «сентября» и т.п.) → номер месяца.
const RU_MONTH = {
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, июн: 6,
  июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12
};

const pad2 = n => String(n).padStart(2, '0');

// «Схлопывает» HTML-фрагмент в один текст: убирает теги и &nbsp;.
const collapse = s => String(s || '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&mdash;|&ndash;/g, '-')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Первое совпадение регэкспа (с индексом idx), с обрезкой пробелов.
const pick = (re, s, idx = 1) => {
  const m = s.match(re);
  return m ? (m[idx] || '').trim() : '';
};

const fileDateISO = fd => `${fd.slice(0, 4)}-${fd.slice(4, 6)}-${fd.slice(6, 8)}`;

// «DD месяц ЧЧ:ММ» → { dd, mo, hh, mm }, либо null.
function parseBoardTime(txt) {
  const m = String(txt || '').match(/(\d{1,2})\s+([а-яё]+)\s+(\d{1,2}):(\d{2})/i);
  if (!m) return null;
  const mo = RU_MONTH[String(m[2]).toLowerCase().slice(0, 3)];
  if (!mo) return null;
  return { dd: +m[1], mo, hh: +m[3], mm: +m[4] };
}

// Год для даты { dd, mo }: среди { refY-1, refY, refY+1 } берём тот, где DD.MM
// ближе всего к референсной дате (для «живого» окна это почти всегда refY).
function resolveYear(p, refIso) {
  const ry = +refIso.slice(0, 4);
  const rm = +refIso.slice(5, 7);
  const rd = +refIso.slice(8, 10);
  const base = Date.UTC(ry, rm - 1, rd);
  let best = ry;
  let bestDist = Infinity;
  for (const y of [ry - 1, ry, ry + 1]) {
    const dist = Math.abs(Date.UTC(y, p.mo - 1, p.dd) - base) / 86400000;
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

const isoDate = p => `${p.y}-${pad2(p.mo)}-${pad2(p.dd)}`;

// Приводит «сырой» статус рейса с сайта DME к каноническому виду. Для ещё не
// выполненных рейсов («Регистрация», «Идет посадка», «Посадка окончена», …)
// возвращает null (фронтенд покажет «Без статуса»).
const canonicalStatus = (raw, type) => {
  const s = (raw == null ? '' : String(raw)).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('отмен')) return 'Отмена';
  if (s.includes('задерж')) return 'Задержан';
  if (type === 'departure' && s.includes('вылет')) return 'Отправлен';
  if (type === 'arrival' && (s.includes('прибыл') || s.includes('прилетел'))) return 'Прибыл';
  return null;
};

// Город/аэропорт в заглавных → в обычный регистр («ШАРМ ЭЛЬ ШЕЙХ» → «Шарм Эль Шейх»).
const titleCase = s => String(s || '').toLowerCase()
  .split(/\s+/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1))
  .join(' ');

module.exports = {
  code: 'DME',
  name: 'Домодедово',

  // Расписание и ретраи (как у Уфы): раз в час, ретраи не нужны.
  dateMode: 'today',                // целевой день — «сегодня» по Москве
  timeZone: 'Europe/Moscow',        // «сегодня» считаем по московскому времени
  schedule: 'interval',             // запускаемся по интервалу, а не раз в сутки
  intervalMs: 60 * 60 * 1000,       // каждый час
  maxAttempts: 1,                   // ретраи не нужны — опрос и так каждый час
  retryDelayMs: 0,
  merge: true,                      // накапливаем по externalId, не удаляя виденное

  // Обычный GET к странице табло нужного направления (HTML отдаётся сразу).
  async fetchRawHtml(type, fileDate) {
    const direction = type === 'arrival' ? 'A' : 'D';
    const url = `${BOARD_URL}?column=4&sort=1&direction=${direction}&page=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'ru-RU,ru;q=0.9'
        },
        signal: controller.signal
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      if (typeof html !== 'string' || html.indexOf('class="table_style_3') === -1) {
        throw new Error('Ответ DME не похож на онлайн-табло');
      }
      return html;
    } finally {
      clearTimeout(timer);
    }
  },

  // Разбирает строки рейсов из HTML окна табло и оставляет только рейсы
  // целевого дня (fileDate) по их плановому времени.
  parseFlights(raw, type, fileDate) {
    const refIso = fileDateISO(fileDate);
    const flights = [];

    const rowRe = /<tr class="vat ">([\s\S]*?)<\/tr>/g;
    for (const m of raw.matchAll(rowRe)) {
      const r = m[1];
      const id = pick(/<td id="(\d+)" class="timeflight"/, r);
      if (!id) continue;

      const planTxt = collapse(pick(/<td style="text-align: center;"[^>]*nowrap="nowrap">([\s\S]*?)<\/td>/, r));
      const actTxt = collapse(pick(new RegExp(`<td[^>]*id="time${id}"[^>]*>([\\s\\S]*?)<\\/td>`), r));
      const planP = parseBoardTime(planTxt);
      if (!planP) continue; // строка без времени (например, служебная) — пропускаем

      planP.y = resolveYear(planP, refIso);
      const eventDate = isoDate(planP);
      // Окно «живое» и пересекает полночь: берём только рейсы целевого дня.
      if (eventDate !== refIso) continue;

      let actual = null;
      const actP = parseBoardTime(actTxt);
      if (actP) {
        actP.y = resolveYear(actP, eventDate);
        actual = `${isoDate(actP)}T${pad2(actP.hh)}:${pad2(actP.mm)}:00`;
      }

      // Номер рейса: «<код авиакомпании> <номер>» внутри ссылки подробностей,
      // например «U6 8253», «SZ 202», «3F 314». Код — 1–2 символа с хотя бы
      // одной латинской буквой (могут быть цифры: U6, S7, 3F).
      let flightNumber = null;
      const fnRaw = collapse(pick(/<a href="#" class="dialogopen"[^>]*>([\s\S]*?)<\/a>/, r));
      const fm = fnRaw.match(/\b([A-Z0-9]{1,2})\s+(\d{1,5})\b/);
      if (fm && /[A-Z]/.test(fm[1])) flightNumber = fm[1] + fm[2];

      const airportRaw = collapse(pick(new RegExp(`id="course${id}"[\\s\\S]*?<div>([\\s\\S]*?)<\\/div>`), r));
      // Актуальный статус — первый <li> внутри ul.ticker (после скрытого div).
      let statusRaw = null;
      const ticker = r.match(/<ul[^>]*class="ticker"[^>]*>([\s\S]*?)<\/ul>/);
      if (ticker) {
        const li = ticker[1].match(/<li>\s*([\s\S]*?)\s*<\/li>/);
        if (li) statusRaw = collapse(li[1]) || null;
      }

      flights.push({
        externalId: id,
        flightNumber: flightNumber || null,
        status: canonicalStatus(statusRaw, type),
        statusRaw: statusRaw || null,
        plan: `${eventDate}T${pad2(planP.hh)}:${pad2(planP.mm)}:00`,
        actual,
        airportCode: null, // на табло только город, кода аэропорта нет
        airportName: titleCase(airportRaw) || null,
        eventDate
      });
    }

    return flights;
  }
};

