'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROUTING_TEAMS,
  RoutingError,
  buildRoutingPrompt,
  parseRoutingResponse,
  ruleSuggestion
} = require('../lib/routing');
const { suggestTeam } = require('../src/routing');

function incident(overrides = {}) {
  return {
    caseId: 'case-1',
    id: 'INC-1',
    title: 'Деградация сервиса',
    product: 'Mobile voice',
    service: 'Голосовая связь',
    scenario: 'Звонок',
    description: 'Пользователи не могут совершать звонки',
    affectedUsers: 5000,
    ...overrides
  };
}

test('routing targets exclude the coordination team', () => {
  assert.equal(ROUTING_TEAMS.includes('КЦ ИТ Координаторы Массовых Инцидентов'), false);
  assert.equal(ROUTING_TEAMS.length, 11);
});

test('deterministic product rules', () => {
  assert.equal(ruleSuggestion(incident()).team, 'МТС ИТ Поддержка Mobile voice');
  assert.equal(ruleSuggestion(incident({ product: 'KION' })).team, 'МТС ИТ Поддержка KION');
  assert.equal(ruleSuggestion(incident({ product: 'МТС Cloud' })).team, 'МТС ИТ Поддержка МТС Cloud');
  assert.equal(ruleSuggestion(incident({ product: 'Неизвестный продукт', scenario: 'авторизация' })).team, 'Платформа идентификации');
  assert.equal(ruleSuggestion(incident({ product: 'Неизвестный продукт', scenario: 'неизвестно' })), null);
});

test('parses and canonicalizes a valid suggestion', () => {
  const result = parseRoutingResponse(JSON.stringify({
    team: 'мтс ит поддержка kion',
    rationale: 'Продукт KION',
    confidence: 0.9
  }));
  assert.equal(result.team, 'МТС ИТ Поддержка KION');
  assert.equal(result.confidence, 0.9);
});

test('strips thinking and fences, accepts null team', () => {
  const fence = String.fromCharCode(96, 96, 96);
  const content = '<think>размышление</think>\n' + fence + 'json\n' +
    '{"team":null,"rationale":"мало данных","confidence":0.2}\n' + fence;
  const result = parseRoutingResponse(content);
  assert.equal(result.team, null);
});

test('rejects a team outside the whitelist', () => {
  assert.throws(
    () => parseRoutingResponse(JSON.stringify({ team: 'Секретная команда', rationale: 'x', confidence: 1 })),
    RoutingError
  );
  assert.throws(
    () => parseRoutingResponse(JSON.stringify({ team: 'КЦ ИТ Координаторы Массовых Инцидентов', rationale: 'x', confidence: 1 })),
    RoutingError
  );
});

test('prompt contains only current case context and team list', () => {
  const prompt = buildRoutingPrompt(incident());
  assert.match(prompt, /Mobile voice/);
  assert.match(prompt, /Пользователи не могут совершать звонки/);
  assert.match(prompt, /МТС ИТ Поддержка KION/);
  assert.doesNotMatch(prompt, /INC-|affectedUsers|5000/);
});

test('AI suggestion wins when valid and confident', async () => {
  const ai = { complete: async () => JSON.stringify({ team: 'МТС ИТ Поддержка KION', rationale: 'Видео', confidence: 0.91 }) };
  const result = await suggestTeam(ai, incident({ product: 'KION' }));
  assert.equal(result.team, 'МТС ИТ Поддержка KION');
  assert.equal(result.source, 'ai');
});

test('invalid or failed AI falls back to the product rule', async () => {
  const broken = { complete: async () => { throw new Error('network'); } };
  const fallback = await suggestTeam(broken, incident());
  assert.equal(fallback.team, 'МТС ИТ Поддержка Mobile voice');
  assert.equal(fallback.source, 'rule');

  const invalid = { complete: async () => JSON.stringify({ team: 'Unknown', rationale: 'x', confidence: 1 }) };
  const result = await suggestTeam(invalid, incident());
  assert.equal(result.team, 'МТС ИТ Поддержка Mobile voice');
  assert.equal(result.source, 'rule');
});

test('low confidence falls back, unknown product yields no suggestion', async () => {
  const low = { complete: async () => JSON.stringify({ team: 'МТС ИТ Поддержка KION', rationale: 'x', confidence: 0.1 }) };
  const fallback = await suggestTeam(low, incident());
  assert.equal(fallback.team, 'МТС ИТ Поддержка Mobile voice');

  const none = await suggestTeam(
    { complete: async () => { throw new Error('network'); } },
    incident({ product: 'Неизвестный продукт', scenario: 'неизвестно' })
  );
  assert.equal(none.team, null);
  assert.equal(none.source, 'none');
});
