'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AssistantError,
  buildAssistantPrompt,
  parseAssistantPayload
} = require('../src/assistant');

const catalog = { products: ['МТС Банк'], regions: ['Московская область'], services: ['SMS'], teams: ['T'] };
const FENCE = String.fromCharCode(96, 96, 96);

test('parses a valid filter payload', () => {
  const result = parseAssistantPayload(JSON.stringify({
    intent: 'filter',
    filters: { groups: ['critical'], needsTeam: true, regions: ['Московская область'] },
    explanation: 'Критические без команды в МО',
    confidence: 0.9
  }));
  assert.equal(result.intent, 'filter');
  assert.deepEqual(result.filter.groups, ['critical']);
  assert.equal(result.filter.needsTeam, true);
  assert.equal(result.confidence, 0.9);
});

test('strips Qwen thinking and code fences', () => {
  const payload = '<think>рассуждение</think>\n' + FENCE + 'json\n' +
    '{"intent":"clarify","clarification":"Уточните SLA","options":["риск","просрочка"]}\n' + FENCE;
  const result = parseAssistantPayload(payload);
  assert.equal(result.intent, 'clarify');
  assert.equal(result.clarification, 'Уточните SLA');
  assert.deepEqual(result.options, ['риск', 'просрочка']);
});

test('rejects unknown filter fields from the model', () => {
  assert.throws(
    () => parseAssistantPayload(JSON.stringify({
      intent: 'filter',
      filters: { sql: 'select * from cases' },
      confidence: 0.9
    })),
    AssistantError
  );
});

test('low confidence becomes clarification', () => {
  const result = parseAssistantPayload(JSON.stringify({
    intent: 'filter',
    filters: { groups: ['critical'] },
    confidence: 0.2
  }));
  assert.equal(result.intent, 'clarify');
});

test('empty filter becomes clarification', () => {
  const result = parseAssistantPayload(JSON.stringify({
    intent: 'filter',
    filters: {},
    confidence: 0.9
  }));
  assert.equal(result.intent, 'clarify');
});

test('prompt includes only catalog values, not incident records', () => {
  const prompt = buildAssistantPrompt('покажи критичные', catalog);
  assert.match(prompt, /Московская область/);
  assert.match(prompt, /МТС Банк/);
  assert.doesNotMatch(prompt, /INC-|caseId/);
});
