'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCanonicalIncident } = require('../lib/incidents');

function source(overrides = {}) {
  return {
    id: 'SRC-X',
    correlationKey: 'corr-x',
    version: 1,
    stateId: 0,
    priorityId: 1,
    affectedUsers: 10,
    reportCount: 1,
    submitDate: '2026-01-01T00:00:00.000Z',
    deadline: null,
    completionDate: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    header: 'Заголовок',
    description: 'Описание',
    productName: 'Mobile voice',
    service: 'Голосовая связь',
    scenarioName: 'Звонок',
    region: 'Москва',
    assignedGroupName: null,
    coordinatorId: null,
    coordinatorName: null,
    solution: null,
    priorityOverrideId: null,
    isNeedUp: false,
    isMaster: false,
    isEffect: false,
    ...overrides
  };
}

function canonical(overrides = {}, caseOverrides = {}) {
  return buildCanonicalIncident({
    caseId: 'case-x',
    correlationKey: 'corr-x',
    sources: [source(overrides)],
    priorityOverrideId: caseOverrides.priorityOverrideId ?? null,
    version: caseOverrides.version ?? 1
  });
}

test('critical case is only in critical, never in coordination or high', () => {
  const incident = canonical({ affectedUsers: 1200 });
  assert.equal(incident.priorityId, 4);
  assert.deepEqual(incident.groups, ['active', 'critical']);
});

test('high case is only in high, never in coordination or critical', () => {
  const incident = canonical({ affectedUsers: 600 });
  assert.equal(incident.priorityId, 3);
  assert.deepEqual(incident.groups, ['active', 'high']);
});

test('medium/low active case without a team stays in coordination', () => {
  const incident = canonical({ affectedUsers: 120 });
  assert.equal(incident.priorityId, 2);
  assert.deepEqual(incident.groups, ['active', 'coordination']);
});

test('assigning a team removes coordination but keeps priority groups', () => {
  const medium = canonical({ affectedUsers: 120, assignedGroupName: 'МТС ИТ Поддержка Mobile voice' });
  assert.deepEqual(medium.groups, ['active']);

  const high = canonical({ affectedUsers: 600, assignedGroupName: 'МТС ИТ Поддержка Mobile voice' });
  assert.deepEqual(high.groups, ['active', 'high']);
});

test('manual override to critical also suppresses coordination', () => {
  const incident = buildCanonicalIncident({
    caseId: 'case-manual',
    correlationKey: 'corr-manual',
    sources: [source({ affectedUsers: 10 })],
    priorityOverrideId: 4,
    version: 1
  });
  assert.deepEqual(incident.groups, ['active', 'critical']);
});
