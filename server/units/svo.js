'use strict';

// Конфигурация аэропорта Шереметьево (SVO, Москва).
//
// Официальное онлайн-табло svo.aero — это SPA (Angular), но сами данные оно
// получает из простого JSON-API без авторизации:
//   GET https://www.svo.aero/bitrix/timetable/
//       ?direction=departure|arrival
//       &dateStart=<ISO c +03:00>&dateEnd=<ISO c +03:00>
//       &perPage=9999&page=0&locale=ru
// В отличие от «живого» табло DME, это API отдаёт рейсы произвольного
// диапазона дат целиком (проверено: запрос за сутки возвращает все рейсы дня,
// pagination.totalItems совпадает с числом элементов) — то есть подходит под
// модель ежедневного сбора «вчера», как у LED/OVB.
//
// Ключевые факты об источнике:
//   * direction=departure → mar1 = SVO (аэропорт вылета), mar2 = город назначения;
//     direction=arrival    → mar1 = город отправления, mar2 = SVO.
//   * время во всех полях — локальное московское, ISO-строка с «+03:00».
//   * план (STD/STA) — поле t_st; факт: у вылета — t_otpr (фактическое
//     отруливание/вылет), у прилёта — t_at (фактическое прибытие).
//   * дата рейса («за какой день») — поле dat (календарный день в Москве).
//   * статус у SVO «сворачивается» в итоговый текст (у вылетов это даже
//     «Прибыл в <город> HH:MM ~ Рейс за DD.MM.YY»), поэтому «вылетел/не
//     вылетел» определяем не по словам, а по наличию фактического времени:
//     выполненный вылет → «Отправлен», прилёт → «Прибыл»; отмены распознаём
//     по слову «отмен…». Фронтенд сам переводит «Отправлен/Прибыл» в
//     «Задержан», если факт позже плана (см. effectiveStatus в index.html).

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const API_URL = 'https://www.svo.aero/bitrix/timetable/';

// Вытаскивает YYYY-MM-DD из начала ISO-строки.
const dateOnly = s => {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

// Сдвиг даты YYYYMMDD на days календарных дней (в UTC-арифметике).
function shiftFileDate(yyyymmdd, days) {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const Y = dt.getUTCFullYear();
  const M = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const D = String(dt.getUTCDate()).padStart(2, '0');
  return `${Y}${M}${D}`;
}

// Канонический статус (словарь такой же, как у LED/UFA/OVB): отмена по слову
// «отмен…», выполненный вылет → «Отправлен», прилёт → «Прибыл». «Задержан» не
// ставим — фронтенд вычисляет его сам по факту/плану для статусов
// «Отправлен»/«Прибыл».
function canonicalStatus(rawStatus, hasActual, type) {
  const s = String(rawStatus == null ? '' : rawStatus).trim().toLowerCase();
  if (s.includes('отмен')) return 'Отмена';
  if (type === 'departure' && hasActual) return 'Отправлен';
  if (type === 'arrival' && hasActual) return 'Прибыл';
  return null; // «Без статуса» на фронтенде
}

module.exports = {
  code: 'SVO',
  name: 'Шереметьево',
  userAgent: USER_AGENT,

  // Ежедневный сбор данных за «вчера», как у LED/OVB. «Вчера» считаем в
  // московском времени (UTC+3) — так определяет сутки сам источник.
  dateMode: 'yesterday',
  timeZone: 'Europe/Moscow',
  schedule: 'daily',

  // Собирает URL запроса к табло для заданного типа рейсов и даты (YYYYMMDD).
  buildRequest(type, fileDate) {
    const start = `${fileDate.slice(0, 4)}-${fileDate.slice(4, 6)}-${fileDate.slice(6, 8)}`;
    const end = shiftFileDate(fileDate, 1);
    const endISO = `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`;
    const qs = new URLSearchParams({
      direction: type === 'arrival' ? 'arrival' : 'departure',
      dateStart: `${start}T00:00:00+03:00`,
      dateEnd: `${endISO}T00:00:00+03:00`,
      perPage: '9999',
      page: '0',
      locale: 'ru'
    });
    return {
      url: `${API_URL}?${qs.toString()}`,
      method: 'GET',
      headers: { Accept: 'application/json' }
    };
  },

  // Разбирает JSON табло SVO и нормализует рейсы в единый вид для БД.
  parseFlights(raw, type, fileDate) {
    if (!raw || !Array.isArray(raw.items)) {
      throw new Error('Неожиданный формат ответа SVO API (нет массива items)');
    }
    const isArrival = type === 'arrival';
    const flights = [];

    for (const it of raw.items) {
      // mar1/mar2 — аэропорты на концах маршрута. Для прилёта дальний — mar1
      // (откуда прилетел), для вылета — mar2 (куда летит).
      const remote = isArrival ? it.mar1 : it.mar2;
      const code = (it.co && it.co.code) || '';
      const flt = it.flt || '';
      const flightNumber = (code + flt).trim() || null;

      const plan = it.t_st || null;
      const actual = isArrival ? (it.t_at || null) : (it.t_otpr || null);
      const rawStatus = it.vip_status_rus || it.vip_status_eng || null;

      flights.push({
        externalId: it.i_id != null ? String(it.i_id) : null,
        flightNumber,
        status: canonicalStatus(rawStatus, !!actual, type),
        statusRaw: rawStatus,
        plan,
        actual,
        airportCode: (remote && remote.iata) || null,
        airportName: (remote && (remote.city || remote.description_r || remote.airport_rus)) || null,
        eventDate: dateOnly(it.dat) || dateOnly(actual) || dateOnly(plan)
      });
    }

    return flights;
  }
};
