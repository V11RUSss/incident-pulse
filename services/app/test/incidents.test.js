'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS_TRANSITIONS } = require('../lib/meta');
const { buildCanonicalIncident } = require('../lib/incidents');

function source(overrides = {}) {
  return {
    id: 'SRC-1',
    correlationKey: 'corr-1',
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

function canonical(sources, overrides = {}) {
  return buildCanonicalIncident({
    caseId: 'case-1',
    correlationKey: 'corr-1',
    sources,
    priorityOverrideId: overrides.priorityOverrideId ?? null,
    version: overrides.version ?? 1
  });
}

test('buildCanonicalIncident sums correlated sources and derives automatic priority', () => {
  const incident = canonical([
    source({ id: 'SRC-2', submitDate: '2026-01-01T01:00:00.000Z', affectedUsers: 40, reportCount: 2 }),
    source({ id: 'SRC-1', affectedUsers: 10, reportCount: 1 })
  ]);
  assert.equal(incident.affectedUsers, 50);
  assert.equal(incident.activeAffectedUsers, 50);
  assert.equal(incident.reportCount, 3);
  assert.equal(incident.autoPriorityId, 2);
  assert.equal(incident.priorityId, 2);
  assert.deepEqual(incident.sourceIds, ['SRC-1', 'SRC-2']);
  assert.equal(incident.groups.includes('active'), true);
  assert.equal(incident.groups.includes('coordination'), true);
  assert.equal(incident.groups.includes('high'), false);
  assert.equal(incident.version, 1);
});

test('closed sources do not inflate activeAffectedUsers or automatic priority', () => {
  const incident = canonical([
    source({ id: 'OPEN', affectedUsers: 600, reportCount: 1 }),
    source({
      id: 'CLOSED',
      stateId: 7,
      affectedUsers: 600,
      reportCount: 2,
      completionDate: '2026-01-02T00:00:00.000Z'
    })
  ]);
  assert.equal(incident.affectedUsers, 1200);
  assert.equal(incident.activeAffectedUsers, 600);
  assert.equal(incident.autoPriorityId, 3);
  assert.equal(incident.priorityId, 3);
  assert.equal(incident.groups.includes('high'), true);
  assert.equal(incident.groups.includes('critical'), false);
});

test('a case with only closed sources stays closed with low automatic priority', () => {
  const incident = canonical([
    source({
      stateId: 10,
      affectedUsers: 5000,
      reportCount: 9,
      completionDate: '2026-01-02T00:00:00.000Z'
    })
  ]);
  assert.equal(incident.stateId, 10);
  assert.equal(incident.activeAffectedUsers, 0);
  assert.equal(incident.autoPriorityId, 1);
  assert.deepEqual(incident.groups, ['closed']);
  assert.equal(incident.resolvedAt, Date.parse('2026-01-02T00:00:00.000Z'));
});

test('research sources count toward activeAffectedUsers', () => {
  const incident = canonical([
    source({ stateId: 20, affectedUsers: 500, solution: 'Исследуем причину' })
  ]);
  assert.equal(incident.activeAffectedUsers, 500);
  assert.equal(incident.autoPriorityId, 3);
  assert.equal(incident.groups.includes('research'), true);
  assert.equal(incident.solution, 'Исследуем причину');
});

test('manual priority override wins over automatic priority', () => {
  const incident = canonical([source({ affectedUsers: 10 })], { priorityOverrideId: 4 });
  assert.equal(incident.autoPriorityId, 1);
  assert.equal(incident.priorityId, 4);
  assert.equal(incident.priorityOverrideId, 4);
  assert.equal(incident.prioritySource, 'manual');
  assert.equal(incident.priorityText, 'Наивысший');
  assert.equal(incident.groups.includes('critical'), true);
});

test('STATUS_TRANSITIONS matches the server-side lifecycle contract', () => {
  assert.deepEqual(STATUS_TRANSITIONS, {
    0: [2, 20, 7, 10],
    2: [20, 7, 10],
    20: [7, 10],
    7: [10],
    10: []
  });
});
