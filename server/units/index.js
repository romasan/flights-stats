'use strict';

// Реестр аэропортов ("units"). Чтобы добавить новый аэропорт — создайте
// модуль наподобие led.js и добавьте его сюда.

const led = require('./led');
const ufa = require('./ufa');
const ovb = require('./ovb');
const svo = require('./svo');
const vko = require('./vko');
const dme = require('./dme');

const UNITS = [led, ufa, ovb, svo, vko, dme];

const byCode = new Map(UNITS.map(u => [u.code, u]));

module.exports = {
  list: UNITS,
  get(code) {
    return byCode.get(String(code || '').toUpperCase());
  }
};
