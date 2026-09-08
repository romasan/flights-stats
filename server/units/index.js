'use strict';

// Реестр аэропортов ("units"). Чтобы добавить новый аэропорт — создайте
// модуль наподобие led.js и добавьте его сюда.

const led = require('./led');
const ufa = require('./ufa');
const ovb = require('./ovb');

const UNITS = [led, ufa, ovb];

const byCode = new Map(UNITS.map(u => [u.code, u]));

module.exports = {
  list: UNITS,
  get(code) {
    return byCode.get(String(code || '').toUpperCase());
  }
};
