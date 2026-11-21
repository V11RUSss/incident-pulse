'use strict';

const MTS_TEAMS = Object.freeze([
  'КЦ ИТ Координаторы Массовых Инцидентов',
  'МТС ИТ Поддержка Mobile voice',
  'МТС ИТ Поддержка МТС ID',
  'МТС ИТ Поддержка МТС Банка',
  'МТС ИТ Поддержка SMS',
  'МТС ИТ Поддержка KION',
  'МТС ИТ Поддержка МТС Cloud',
  'Платформа идентификации',
  'Эксплуатация сети / Регион',
  'Digital-каналы',
  'Расчёты и биллинг',
  'Cloud Platform / API Gateway'
]);

const STATUS_TRANSITIONS = Object.freeze({
  0: Object.freeze([2, 20, 7, 10]),
  2: Object.freeze([20, 7, 10]),
  20: Object.freeze([7, 10]),
  7: Object.freeze([10]),
  10: Object.freeze([])
});

module.exports = { MTS_TEAMS, STATUS_TRANSITIONS };
