'use strict';

const { MTS_TEAMS } = require('./meta');

const COORDINATION_TEAM = 'КЦ ИТ Координаторы Массовых Инцидентов';
const ROUTING_TEAMS = Object.freeze(MTS_TEAMS.filter(team => team !== COORDINATION_TEAM));

const PRODUCT_RULES = Object.freeze([
  { keywords: ['mobile voice', 'мобильная связь', 'голосовая связь'], team: 'МТС ИТ Поддержка Mobile voice', rationale: 'Продукт Mobile voice относится к профильной команде Mobile voice.' },
  { keywords: ['мтс id', 'mts id', 'мтс-id'], team: 'МТС ИТ Поддержка МТС ID', rationale: 'Продукт МТС ID обслуживает профильная команда МТС ID.' },
  { keywords: ['мтс банк', 'mts bank'], team: 'МТС ИТ Поддержка МТС Банка', rationale: 'Продукт МТС Банк относится к поддержке МТС Банка.' },
  { keywords: ['sms', 'смс'], team: 'МТС ИТ Поддержка SMS', rationale: 'Продукт SMS относится к профильной команде SMS.' },
  { keywords: ['kion', 'кион'], team: 'МТС ИТ Поддержка KION', rationale: 'Продукт KION относится к профильной команде KION.' },
  { keywords: ['мтс cloud', 'mts cloud', 'облачные виртуальные'], team: 'МТС ИТ Поддержка МТС Cloud', rationale: 'Продукт МТС Cloud относится к поддержке облачных сервисов.' },
  { keywords: ['cloud platform', 'api gateway', 'api-шлюз'], team: 'Cloud Platform / API Gateway', rationale: 'Сценарий связан с Cloud Platform / API Gateway.' },
  { keywords: ['digital', 'цифровые каналы', 'сайт', 'приложение'], team: 'Digital-каналы', rationale: 'Сценарий относится к цифровым каналам.' },
  { keywords: ['биллинг', 'billing', 'расчёт', 'расчет', 'платеж', 'платёж'], team: 'Расчёты и биллинг', rationale: 'Сценарий относится к расчётам и биллингу.' },
  { keywords: ['эксплуатация сети'], team: 'Эксплуатация сети / Регион', rationale: 'Сценарий относится к эксплуатации сети.' },
  { keywords: ['платформа идентификации', 'идентификация'], team: 'Платформа идентификации', rationale: 'Сценарий относится к платформе идентификации.' }
]);

const SCENARIO_RULES = Object.freeze([
  { keywords: ['авторизац', 'аутентификац', 'логин', 'парол'], team: 'Платформа идентификации', rationale: 'Сценарий авторизации относится к платформе идентификации.' },
  { keywords: ['видео', 'стрим', 'воспроизвед'], team: 'МТС ИТ Поддержка KION', rationale: 'Сценарий связан с воспроизведением видео KION.' },
  { keywords: ['api', 'шлюз', 'gateway'], team: 'Cloud Platform / API Gateway', rationale: 'Сценарий связан с API Gateway.' },
  { keywords: ['биллинг', 'платеж', 'платёж', 'расчёт', 'расчет'], team: 'Расчёты и биллинг', rationale: 'Сценарий связан с расчётами и биллингом.' },
  { keywords: ['сайт', 'приложение', 'личный кабинет'], team: 'Digital-каналы', rationale: 'Сценарий связан с цифровыми каналами.' },
  { keywords: ['базовая станция'], team: 'Эксплуатация сети / Регион', rationale: 'Сценарий связан с сетевой инфраструктурой.' }
]);

class RoutingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutingError';
    this.status = 502;
    this.code = 'routing_parse_failed';
  }
}

function normalize(value) {
  return String(value || '').toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim();
}

function matchesKeyword(value, keyword) {
  const normalized = normalize(keyword);
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped, 'iu').test(value);
}

function findRule(incident, rules, field) {
  const value = normalize(incident[field]);
  if (!value) return null;
  for (const rule of rules) {
    if (rule.keywords.some(keyword => matchesKeyword(value, keyword))) return rule;
  }
  return null;
}

function ruleSuggestion(incident) {
  if (!incident || typeof incident !== 'object') return null;
  const productRule = findRule(incident, PRODUCT_RULES, 'product');
  if (productRule) {
    return { team: productRule.team, rationale: productRule.rationale, confidence: 0.55, source: 'rule' };
  }
  const scenarioRule = findRule(incident, SCENARIO_RULES, 'scenario');
  if (scenarioRule) {
    return { team: scenarioRule.team, rationale: scenarioRule.rationale, confidence: 0.5, source: 'rule' };
  }
  return null;
}

function canonizeTeam(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const canonical = ROUTING_TEAMS.find(team => team.toLocaleLowerCase('ru') === raw.toLocaleLowerCase('ru'));
  if (!canonical) throw new RoutingError('Модель предложила команду вне списка MTS_TEAMS');
  return canonical;
}

function stripThinking(content) {
  return String(content || '')
    .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
    .replace(/^\x60{3}(?:json)?\s*/i, '')
    .replace(/\x60{3}\s*$/, '')
    .trim();
}

function parseRoutingResponse(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripThinking(content));
  } catch {
    throw new RoutingError('Модель вернула не JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RoutingError('Модель вернула некорректный ответ');
  }
  const team = canonizeTeam(parsed.team);
  const rationale = typeof parsed.rationale === 'string' && parsed.rationale.trim()
    ? parsed.rationale.trim().slice(0, 300)
    : '';
  const confidence = Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;
  return { team, rationale, confidence };
}

function buildRoutingPrompt(incident, teams = ROUTING_TEAMS) {
  const description = String(incident.description || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return [
    'Выбери одну профильную команду для массового ИТ-инцидента.',
    'Название: ' + String(incident.title || '').slice(0, 300),
    'Продукт: ' + String(incident.product || 'не указан'),
    'Сервис: ' + String(incident.service || 'не указан'),
    'Сценарий: ' + String(incident.scenario || 'не указан'),
    'Описание: ' + (description || 'нет'),
    '',
    'Доступные команды (выбери ровно одну из этого списка):',
    ...teams.map((team, index) => String(index + 1) + '. ' + team),
    '',
    'Правила:',
    '- координаторская команда исключена из списка;',
    '- не придумывай команды и не меняй их названия;',
    '- если данных мало или ты не уверен, верни team:null;',
    '- rationale — одна короткая строка по-русски, без Markdown;',
    '- confidence — число от 0 до 1.',
    '',
    'Ответ только JSON:',
    '{"team":"точное название или null","rationale":"почему","confidence":0.0}'
  ].join('\n');
}

const SYSTEM_PROMPT = [
  'Ты — диспетчер массовых ИТ-инцидентов МТС.',
  'Твоя задача — предложить одну профильную команду по продукту, сценарию и описанию.',
  'Ты не назначаешь команду и не меняешь данные; решение принимает человек.',
  'Используй только команды из переданного списка. Не выдумывай команды.',
  'Если уверенности нет, верни team:null.',
  'Ответ — только один JSON-объект без Markdown и текста вокруг.'
].join('\n');

module.exports = {
  COORDINATION_TEAM,
  PRODUCT_RULES,
  ROUTING_TEAMS,
  RoutingError,
  SYSTEM_PROMPT,
  buildRoutingPrompt,
  parseRoutingResponse,
  ruleSuggestion
};
