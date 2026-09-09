'use strict';

// Конфигурация аэропорта Уфа (UFA).
//
// В отличие от Пулково (LED) API Уфы:
//   * принимает POST с телом application/x-www-form-urlencoded и конкретной датой
//     (filter_date=DD.MM.YYYY) — дата передаётся динамически для каждого запроса;
//   * возвращает не массив JSON, а JSON с HTML-фрагментом ({ status, data: { html } }),
//     где каждый рейс лежит в карточке a.b-scoreboard-card.
//
// Для Уфы данные за «вчера» выдаются не в полном объёме, поэтому юнит запрашивает
// рейсы за текущий день и каждый час обновляет их статус (аккумулируя по externalId,
// без удаления уже виденных рейсов). Ретраи не нужны — раз запрос идёт каждый час.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

const API_URL =
  'https://www.airportufa.ru/bitrix/services/main/ajax.php?mode=class&c=kr%3Aboard&action=flightsGet';

// fileDate YYYYMMDD -> YYYY-MM-DD
const fileDateISO = fd => `${fd.slice(0, 4)}-${fd.slice(4, 6)}-${fd.slice(6, 8)}`;
// fileDate YYYYMMDD -> DD.MM.YYYY (для filter_date)
const fileDateDDMMYYYY = fd => `${fd.slice(6, 8)}.${fd.slice(4, 6)}.${fd.slice(0, 4)}`;

// Прибавляет n дней к ISO-дате YYYY-MM-DD (в UTC).
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const Y = dt.getUTCFullYear();
  const M = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const D = String(dt.getUTCDate()).padStart(2, '0');
  return `${Y}-${M}-${D}`;
};

// "HH:MM" -> минуты от полуночи, либо null.
const toMin = hhmm => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};

// Первое совпадение регэкспа в строке, с обрезкой пробелов.
const pick = (re, s, idx = 1) => {
  const m = s.match(re);
  return m ? (m[idx] || '').trim() : '';
};

// Приводит «сырой» статус рейса с сайта Уфы к каноническому виду, который
// понимает остальной код (агрегация, графики, расчёт задержек по времени).
// Возвращает null (значит «Без статуса» на фронтенде) для всех прочих
// значений (Ожидается, В пути, Посадка завершена, Идет регистрация, …).
// Сравнение по ключевым словам: «задерж» → Задержан, «отмен» → Отмена,
// выполненный вылет → Отправлен / прилёт → Прибыл.
const canonicalStatus = (raw, type) => {
  const s = (raw == null ? '' : String(raw)).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('задерж')) return 'Задержан';
  if (s.includes('отмен')) return 'Отмена';
  if (type === 'departure' && s.includes('вылет')) return 'Отправлен';
  if (type === 'arrival' && (s.includes('прилет') || s.includes('прибыл'))) return 'Прибыл';
  return null;
};

module.exports = {
  code: 'UFA',
  name: 'Уфа',
  normalizeStatus: canonicalStatus, // переиспользуется скриптом миграции старых данных
  userAgent: USER_AGENT,

  // Расписание и ретраи, переопределяющие глобальные настройки планировщика.
  dateMode: 'today',            // запрашиваем данные за текущий день
  timeZone: 'Asia/Yekaterinburg', // «текущий день» считаем по времени Уфы (UTC+5)
  schedule: 'interval',         // запускаемся по интервалу, а не раз в сутки
  intervalMs: 60 * 60 * 1000,   // каждый час
  maxAttempts: 1,               // ретраи не нужны — опрос и так каждый час
  retryDelayMs: 0,
  merge: true,                  // дополняем/обновляем рейсы, но не удаляем уже виденные

  // Собирает параметры HTTP-запроса для заданного типа рейсов и даты (YYYYMMDD).
  buildRequest(type, fileDate) {
    const state = type === 'arrival' ? 'Arrived' : 'Departured';
    const body = new URLSearchParams({
      filter_str: '',
      filter_date: fileDateDDMMYYYY(fileDate),
      filter_terminal: '',
      state,
      language: 'RU'
    }).toString();
    return {
      url: API_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    };
  },

  // Разбирает HTML-карточки рейсов из ответа API и нормализует их в единый вид.
  parseFlights(raw, type, fileDate) {
    if (!raw || raw.status !== 'success' || !raw.data || typeof raw.data.html !== 'string') {
      throw new Error('Неожиданный формат ответа UFA API');
    }
    const html = raw.data.html;
    const flights = [];

    // Карточка рейса: <a class="b-scoreboard-card" href="/scoreboard/flight/<hash>/">…</a>
    const cardRe = /<a[^>]*class="b-scoreboard-card[^>]*href="\/scoreboard\/flight\/([a-f0-9]+)\/"[^>]*>([\s\S]*?)<\/a>/g;

    for (const m of html.matchAll(cardRe)) {
      const id = m[1];
      const block = m[2];

      const current = pick(/b-scoreboard-card__date-current[^>]*>([\s\S]*?)<\/time>/, block);
      const old = pick(/b-scoreboard-card__date-old[^>]*>([\s\S]*?)<\/time>/, block);

      // Футер «Рейс N выполняется за DD.MM.YYYY» — дата рейса (есть не у всех).
      const footer = pick(/b-scoreboard-card__footer-title[^>]*>([\s\S]*?)<\/span>/, block);
      const fmd = footer.match(/(\d{2})\.(\d{2})\.(\d{4})/);

      // Дата рейса: из футера, иначе — запрошенный день (текущий).
      const eventDate = fmd
        ? `${fmd[3]}-${fmd[2]}-${fmd[1]}`
        : fileDateISO(fileDate);

      // plan/actual: есть «старое» время → план=старое, факт=текущее;
      // только «текущее» → план=текущее (рейс ещё не выполнен), факта нет.
      let plan = null;
      let actual = null;
      if (old) {
        plan = `${eventDate}T${old}:00`;
        actual = `${eventDate}T${current}:00`;
        // Переход через полночь: фактическое время раньше планового → следующий день.
        const pm = toMin(old);
        const am = toMin(current);
        if (pm != null && am != null && am < pm) {
          actual = `${addDays(eventDate, 1)}T${current}:00`;
        }
      } else if (current) {
        plan = `${eventDate}T${current}:00`;
      }

      // Исходный статус сайта Уфы (например, «Вылетел», «Задержка», «Отменен»,
      // «Ожидается»). В status кладём канонический статус (для агрегации/графиков),
      // а исходный текст сохраняем в statusRaw — он показывается в попапе.
      const rawStatus = pick(/b-scoreboard-card__td_status[\s\S]*?<strong>([\s\S]*?)<\/strong>/, block) || null;

      flights.push({
        externalId: id,
        flightNumber: pick(/b-scoreboard-card__td_number[\s\S]*?<strong>([\s\S]*?)<\/strong>/, block) || null,
        status: canonicalStatus(rawStatus, type),
        statusRaw: rawStatus || null,
        plan,
        actual,
        airportCode: pick(/b-scoreboard-card__label">([\s\S]*?)<\/span>/, block) || null,
        airportName: pick(/b-scoreboard-card__title">([\s\S]*?)<\/div>/, block) || null,
        eventDate
      });
    }

    return flights;
  }
};
