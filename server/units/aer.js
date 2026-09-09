'use strict';

// Конфигурация аэропорта Сочи (AER, Сочи/Адлер).
//
// Официальное онлайн-табло aer.aero — Bitrix-страница /flights/online-schedule/,
// которая отдаётся сразу готовым HTML (обычный GET, без JS-челленджа и
// авторизации, как у DME). Внутри неё — «живое» табло текущего операционного дня
// в московском времени (UTC+3) с двумя панелями: вылеты (data-case-select="out")
// и прилёты (data-case-select="in"). У каждой строки — data-атрибуты планового
// времени (data-time / data-time-minute) и статус (data-status), а также две
// строки времени в тексте:
//   * если рейс идёт по расписанию — одна простая строка «<p>HH:MM</p>»;
//   * если время обновилось / рейс выполнен — две строки: discount (мелкая,
//     исходное расписание «DD.MM HH:MM») и discount-sum (крупная, «актуальное»:
//     фактическое, если рейс выполнен, либо обновлённое время).
//
// Источник не отдаёт архив произвольной даты, а показывает только текущий день
// (живое табло), поэтому юнит, как и DME/UFA, работает «вживую»: раз в час
// снимает табло текущего дня, а рейсы накапливает по externalId (режим merge),
// не удаляя уже виденные, чтобы к концу суток в БД лежал цельный «сегодняшний»
// день. Дата рейса для агрегации — плановый день (операционные сутки по Москве,
// которые и отдаёт табло); статус/факт подтягиваются в следующих снимках.
//
// ВНИМАНИЕ: разметка/логика парсера описана по наблюдению над реальным ответом
// сайта и требует проверки на «живых» данных в течение полного дня сбора.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const BOARD_URL = 'https://aer.aero/flights/online-schedule/';

const pad2 = n => String(n).padStart(2, '0');

// «Схлопывает» HTML-фрагмент в один текст: убирает теги и &nbsp;.
function collapse(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;|&ndash;/g, '-')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Первое совпадение регэкспа (с индексом idx), с обрезкой пробелов.
const pick = (re, s, idx = 1) => {
  const m = s.match(re);
  return m ? (m[idx] || '').trim() : '';
};

const fileDateISO = fd => `${fd.slice(0, 4)}-${fd.slice(4, 6)}-${fd.slice(6, 8)}`;

// Прибавляет n дней к ISO-дате YYYY-MM-DD (в UTC).
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// «DD.MM HH:MM» -> { dd, mo, hh, mm }, либо null.
function parseDmTime(txt) {
  const m = String(txt || '').match(/(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  return m ? { dd: +m[1], mo: +m[2], hh: +m[3], mm: +m[4] } : null;
}

// Год для даты DD.MM: из {refY-1, refY, refY+1} берём тот, где DD.MM ближе всего
// к референсной дате (fileDate). Строки табло живут в пределах ±1 дня от цели.
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
const isoDateTime = (p, hh, mm) => `${isoDate(p)}T${pad2(hh)}:${pad2(mm)}:00`;

// Город/аэропорт в заглавных → в обычный регистр («С.-ПЕТЕРБУРГ» → «С.-Петербург»).
const titleCase = s => String(s || '').toLowerCase()
  .split(/\s+/).filter(Boolean)
  .map(w => (w[0] || '').toUpperCase() + w.slice(1))
  .join(' ');

// Приводит «сырой» статус рейса с сайта Сочи к каноническому виду, который
// понимает остальной код (агрегация, графики, расчёт задержек). «Задержан» и
// «Отмена» — по ключевым словам; выполненный вылет → «Отправлен», прилёт →
// «Прибыл». Прочие («По расписанию», «Регистрация…», «В пути», …) → null
// («Без статуса» на фронтенде; «Отправлен/Прибыл» фронтенд сам превращает в
// «Задержан», если факт позже плана — см. effectiveStatus в index.html).
function canonicalStatus(raw, type) {
  const s = (raw == null ? '' : String(raw)).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('отмен')) return 'Отмена';
  if (s.includes('задерж')) return 'Задержан';
  if (type === 'departure' && s.includes('вылет')) return 'Отправлен';
  if (type === 'arrival' && (s.includes('прибыл') || s.includes('прилетел') ||
                             s.includes('совершил посадку') || s.includes('приземлился'))) return 'Прибыл';
  return null;
}

module.exports = {
  code: 'AER',
  name: 'Сочи',

  // Расписание и ретраи (как у DME/UFA): раз в час, ретраи не нужны.
  dateMode: 'today',                // целевой день — «сегодня» по Москве
  timeZone: 'Europe/Moscow',        // «сегодня» (и операционные сутки табло) — московское время
  schedule: 'interval',             // запускаемся по интервалу, а не раз в сутки
  intervalMs: 60 * 60 * 1000,       // каждый час
  maxAttempts: 1,                   // ретраи не нужны — опрос и так каждый час
  retryDelayMs: 0,
  merge: true,                      // накапливаем по externalId, не удаляя виденное

  // Обычный GET к странице онлайн-табло (HTML отдаётся сразу, без челленджа).
  // Ответ содержит и вылеты, и прилёты; нужное направление отбирает parseFlights.
  async fetchRawHtml(type, fileDate) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const resp = await fetch(BOARD_URL, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'ru-RU,ru;q=0.9'
        },
        signal: controller.signal
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      if (typeof html !== 'string' ||
          html.indexOf('main-widget__content__item-block') === -1) {
        throw new Error('Ответ AER не похож на онлайн-табло');
      }
      return html;
    } finally {
      clearTimeout(timer);
    }
  },

  // Разбирает строки рейсов из HTML табло и оставляет только рейсы нужного
  // направления (type). Каждая строка — <a href="/flights/online-schedule/<ID>/">.
  // Дата рейса (операционные сутки) совпадает с целевым днём табло (data-date),
  // т.е. с fileDate («сегодня» по Москве).
  parseFlights(raw, type, fileDate) {
    if (typeof raw !== 'string') {
      throw new Error('Неожиданный формат ответа AER (ожидался HTML)');
    }
    const isArrival = type === 'arrival';
    const refIso = fileDateISO(fileDate);
    const flights = [];

    // Строка-карточка рейса. В одном <a> есть и десктоп- и мобильная разметка,
    // но сам рейс уникален — внешний id берём из ссылки.
    const linkRe = /<a href="\/flights\/online-schedule\/(\d+)\/">([\s\S]*?)<\/a>/g;
    for (const m of raw.matchAll(linkRe)) {
      const id = m[1];
      const b = m[2];
      if (b.indexOf('main-widget__content__item-block') === -1) continue;

      // Направление: у прилётов в карточке есть класс main-widget-page--arrival.
      const rowArrival = b.indexOf('main-widget-page--arrival') !== -1;
      if (rowArrival !== isArrival) continue;

      const statusRaw = pick(/data-status="([^"]*)"/, b) || null;

      // Плановое время (STD/STA) — из data-атрибутов строки (data-time и
      // data-time-minute), дата — операционные сутки табло (fileDate).
      const hh = pick(/data-time="(\d+)"/, b);
      const mm = pick(/data-time-minute="(\d+)"/, b);
      if (!/^\d{1,2}$/.test(hh) || !/^\d{1,2}$/.test(mm)) continue; // строка без времени
      const eventDate = refIso;
      const plan = `${eventDate}T${pad2(+hh)}:${pad2(+mm)}:00`;

      // Фактическое время — только у выполненного рейса (иначе «актуальное»
      // может быть ещё просто обновлённым планом). Берём из строки discount-sum
      // (у неё есть реальная дата DD.MM); если её нет — из data-true-time с
      // датой планового дня (с переносом через полночь, если факт раньше плана).
      let actual = null;
      const status = canonicalStatus(statusRaw, type);
      if (status === 'Отправлен' || status === 'Прибыл') {
        const sumP = parseDmTime(collapse(pick(
          /class="main-widget__discount-sum"[^>]*>([\s\S]*?)<\/p>/, b
        )));
        if (sumP) {
          sumP.y = resolveYear(sumP, refIso);
          actual = isoDateTime(sumP, sumP.hh, sumP.mm);
        } else {
          const tt = (pick(/data-true-time="([^"]*)"/, b) || '').match(/^(\d{1,2}):(\d{2})$/);
          if (tt) {
            let aDate = eventDate;
            if (+tt[1] < +hh) aDate = addDaysIso(eventDate, 1); // факт после полуночи
            actual = `${aDate}T${pad2(+tt[1])}:${pad2(+tt[2])}:00`;
          }
        }
      }

      // Номер рейса (из span "__flight"): SU-1141, U6-548, 3F-1349, ...
      const fnRaw = collapse(pick(/class="main-widget-td1 main-widget-td1__flight">[\s\S]*?<span>([\s\S]*?)<\/span>/, b));
      const fm = fnRaw.match(/\b([A-Z0-9]{1,2})-(\d{1,5})\b/);
      const flightNumber = fm ? fm[1] + fm[2] : null;

      // Город на противоположном конце маршрута: текст сразу после
      // --country bold (у вылетов он внутри <span>, у прилётов - обычный текст).
      const cityRaw = collapse(pick(/main-widget-td1--country bold">([\s\S]*?)\s*<div class="main-widget-td1 main-widget-td1__flight--mobile"/, b));

      flights.push({
        externalId: id,
        flightNumber,
        status,
        statusRaw: statusRaw || null,
        plan,
        actual,
        airportCode: null, // на табло только город, кода аэропорта нет
        airportName: titleCase(cityRaw) || null,
        eventDate
      });
    }

    return flights;
  }
};

