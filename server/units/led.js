'use strict';

// Конфигурация аэропорта Пулково (LED).
// Чтобы добавить новый аэропорт, создайте аналогичный модуль в этой же папке
// (реализующий { code, name, userAgent, urls, parseFlight }) и зарегистрируйте
// его в units/index.js.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

const dateOnly = s => {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const trimOrNull = v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

module.exports = {
  code: 'LED',
  name: 'Пулково',
  userAgent: USER_AGENT,

  // URL API для каждого типа рейсов. `when=-1` — данные за вчера (относительно
  // серверного времени API), поэтому файл сохраняется под датой "вчера" по
  // локальному времени нашего сервера — как и в прежнем bash-скрипте.
  urls: {
    arrival: 'https://pulkovoairport.ru/api/?type=arrival&when=-1',
    departure: 'https://pulkovoairport.ru/api/?type=departure&when=-1'
  },

  // Приводит один объект рейса из API к единому нормализованному виду,
  // который сохраняется в БД и отдаётся фронтенду.
  parseFlight(raw, type) {
    if (type === 'arrival') {
      const plan = raw.OA_STA || null;
      const actual = raw.OA_ATA || null;
      return {
        externalId: raw.OA_ID || null,
        flightNumber: trimOrNull(raw.OA_FLIGHT_NUMBER),
        status: trimOrNull(raw.OA_STATUS_RU),
        plan,
        actual,
        airportCode: trimOrNull(raw.OA_RAP_CODE_ORIGIN),
        airportName: trimOrNull(raw.OA_RAP_ORIGIN_NAME_RU),
        eventDate: dateOnly(actual) || dateOnly(plan)
      };
    }

    // departure
    const plan = raw.OD_STD || null;
    const actual = raw.OD_ATD || null;
    return {
      externalId: raw.OD_ID || null,
      flightNumber: trimOrNull(raw.OD_FLIGHT_NUMBER),
      status: trimOrNull(raw.OD_STATUS_RU),
      plan,
      actual,
      airportCode: trimOrNull(raw.OD_RAP_CODE_DESTINATION),
      airportName: trimOrNull(raw.OD_RAP_DESTINATION_NAME_RU),
      eventDate: dateOnly(actual) || dateOnly(plan)
    };
  }
};
