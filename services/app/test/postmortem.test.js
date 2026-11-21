'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostmortemError,
  buildFallbackPostmortem,
  buildPostmortemPrompt,
  buildTimeline,
  parsePostmortemResponse
} = require('../lib/postmortem');
const { generatePostmortem } = require('../src/postmortem');

const NOW = Date.parse('2026-11-21T04:40:00.000Z');

function incident(overrides = {}) {
  return {
    caseId: 'case-1',
    id: 'INC-1',
    title: 'Деградация сервиса',
    description: 'Пользователи не могут звонить',
    product: 'Mobile voice',
    service: 'Голосовая связь',
    scenario: 'Звонок',
    priorityId: 4,
    stateId: 2,
    team: 'МТС ИТ Поддержка Mobile voice',
    coordinatorName: 'Даниил',
    groups: ['active', 'critical'],
    dueAt: NOW + 60 * 60 * 1000,
    resolvedAt: null,
    ...overrides
  };
}

function history() {
  return [
    { id: 3, action: 'team', userName: 'Даниил', details: { team: 'МТС ИТ Поддержка Mobile voice' }, createdAt: NOW + 7 * 60 * 1000 },
    { id: 2, action: 'claim', userName: 'Даниил', details: {}, createdAt: NOW + 2 * 60 * 1000 },
    { id: 1, action: 'status', userName: 'Даниил', details: { stateId: 2 }, createdAt: NOW + 5 * 60 * 1000 }
  ];
}

test('builds a chronological factual timeline', () => {
  const timeline = buildTimeline(history());
  assert.deepEqual(timeline.map(event => event.id), [2, 1, 3]);
  assert.match(timeline[0].event, /Взял инцидент/);
  assert.match(timeline[2].event, /Команда/);
  assert.equal(timeline[0].kind, 'fact');
});

test('fallback contains only factual history and no invented causes', () => {
  const timeline = buildTimeline(history());
  const result = buildFallbackPostmortem(incident(), timeline);
  assert.equal(result.source, 'fallback');
  assert.equal(result.causes.length, 0);
  assert.equal(result.timeline.length, 3);
  assert.match(result.summary, /Зафиксировано 3 событий/);
  assert.ok(result.openQuestions.length > 0);
});

test('parses AI JSON and clamps arrays', () => {
  const result = parsePostmortemResponse(JSON.stringify({
    summary: 'Краткий итог',
    causes: [{ text: 'Задержка команды', evidence: '7 минут', confidence: 'medium' }],
    improvements: [{ action: 'Автоподсказка команды', owner: 'Координация', priority: 'high' }],
    wentWell: ['SLA не нарушен'],
    openQuestions: ['Причина не зафиксирована']
  }));
  assert.equal(result.causes[0].confidence, 'medium');
  assert.equal(result.improvements[0].priority, 'high');
});

test('rejects malformed AI output', () => {
  assert.throws(() => parsePostmortemResponse('not json'), PostmortemError);
  assert.throws(() => parsePostmortemResponse(JSON.stringify({ causes: [] })), PostmortemError);
});

test('prompt includes current case and history, not other cases', () => {
  const prompt = buildPostmortemPrompt(incident(), buildTimeline(history()));
  assert.match(prompt, /INC-1/);
  assert.match(prompt, /Команда: МТС ИТ Поддержка Mobile voice/);
  assert.match(prompt, /Хронология/);
  assert.doesNotMatch(prompt, /другой инцидент/);
});

test('AI output is combined with the deterministic timeline', async () => {
  const ai = {
    complete: async () => JSON.stringify({
      summary: 'Инцидент обработан за 7 минут.',
      causes: [{ text: 'Задержка назначения команды', evidence: 'claim → team', confidence: 'medium' }],
      improvements: [{ action: 'Автоматически предлагать команду', owner: 'Координация', priority: 'high' }],
      wentWell: ['SLA не нарушен'],
      openQuestions: []
    })
  };
  const result = await generatePostmortem(ai, incident(), history());
  assert.equal(result.source, 'ai');
  assert.equal(result.timeline.length, 3);
  assert.equal(result.causes.length, 1);
  assert.match(result.summary, /7 минут/);
});

test('AI failure falls back to the factual timeline', async () => {
  const ai = { complete: async () => { throw new Error('timeout'); } };
  const result = await generatePostmortem(ai, incident(), history());
  assert.equal(result.source, 'fallback');
  assert.equal(result.causes.length, 0);
  assert.equal(result.timeline.length, 3);
});

test('empty history returns a factual fallback without an AI call', async () => {
  let called = false;
  const ai = { complete: async () => { called = true; return '{}'; } };
  const result = await generatePostmortem(ai, incident(), []);
  assert.equal(called, false);
  assert.equal(result.source, 'fallback');
  assert.equal(result.timeline.length, 0);
});
