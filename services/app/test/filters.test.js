'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FilterError, filterCatalog, filterIncidents, validateFilter } = require('../lib/filters');

const NOW = Date.parse('2026-01-01T12:00:00.000Z');

function incident(overrides = {}) {
  return {
    caseId: overrides.caseId || 'case-1',
    id: overrides.id || 'INC-1',
    title: overrides.title || 'Инцидент',
    description: overrides.description || 'Описание',
    product: overrides.product || 'Mobile voice',
    service: overrides.service || 'Голосовая связь',
    scenario: overrides.scenario || 'Звонок',
    region: overrides.region || 'Москва',
    affectedUsers: overrides.affectedUsers ?? 100,
    reportCount: overrides.reportCount ?? 5,
    priorityId: overrides.priorityId ?? 2,
    stateId: overrides.stateId ?? 0,
    groups: overrides.groups || ['active', 'coordination'],
    team: overrides.team ?? null,
    coordinatorId: overrides.coordinatorId ?? null,
    coordinatorName: overrides.coordinatorName ?? null,
    startedAt: overrides.startedAt ?? NOW - 10 * 60 * 1000,
    dueAt: overrides.dueAt ?? NOW + 10 * 60 * 1000,
    resolvedAt: overrides.resolvedAt ?? null,
    sourceIds: overrides.sourceIds || ['INC-1'],
    isNeedUp: overrides.isNeedUp ?? false,
    isMaster: overrides.isMaster ?? false,
    isEffect: overrides.isEffect ?? false,
    ...overrides
  };
}

test('validateFilter rejects unknown fields and bad types', () => {
  assert.throws(() => validateFilter({ sql: 'drop table' }), FilterError);
  assert.throws(() => validateFilter({ groups: ['nope'] }), FilterError);
  assert.throws(() => validateFilter({ limit: 1000 }), FilterError);
  assert.throws(() => validateFilter({ priorityIds: [9] }), FilterError);
  assert.throws(() => validateFilter({ needsTeam: 'yes' }), FilterError);
});

test('filters critical cases without a team', () => {
  const cases = [
    incident({ caseId: 'c1', id: 'C1', groups: ['active', 'critical'], priorityId: 4 }),
    incident({ caseId: 'c2', id: 'C2', groups: ['active', 'coordination'] }),
    incident({ caseId: 'c3', id: 'C3', groups: ['active', 'critical'], priorityId: 4, team: 'МТС ИТ Поддержка' })
  ];
  const result = filterIncidents(cases, { groups: ['critical'], needsTeam: true }, NOW);
  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map(item => item.caseId), ['c1']);
});

test('filters by SLA risk and overdue, excluding non-active closures', () => {
  const cases = [
    incident({ caseId: 'risk', dueAt: NOW + 5 * 60 * 1000 }),
    incident({ caseId: 'overdue', dueAt: NOW - 5 * 60 * 1000 }),
    incident({ caseId: 'ok', dueAt: NOW + 2 * 60 * 60 * 1000 }),
    incident({ caseId: 'closed', groups: ['closed'], stateId: 7, dueAt: NOW - 5 * 60 * 1000 })
  ];
  assert.deepEqual(filterIncidents(cases, { sla: 'risk' }, NOW).items.map(item => item.caseId), ['risk']);
  assert.deepEqual(filterIncidents(cases, { sla: 'overdue' }, NOW).items.map(item => item.caseId), ['overdue']);
  assert.deepEqual(filterIncidents(cases, { sla: 'risk_or_overdue' }, NOW).items.map(item => item.caseId).sort(), ['overdue', 'risk']);
});

test('region/product matching is case-insensitive and exact', () => {
  const cases = [
    incident({ caseId: 'mo', region: 'Московская область', product: 'МТС Банк' }),
    incident({ caseId: 'msk', region: 'Москва', product: 'МТС Банк' })
  ];
  const result = filterIncidents(cases, { regions: ['московская область'], products: ['мтс банк'] }, NOW);
  assert.deepEqual(result.items.map(item => item.caseId), ['mo']);
});

test('text search and limits work', () => {
  const cases = [
    incident({ caseId: 'a', title: 'Голосовая деградация', affectedUsers: 5000 }),
    incident({ caseId: 'b', title: 'Ошибки SMS', affectedUsers: 10 }),
    incident({ caseId: 'c', title: 'Голос и SMS', affectedUsers: 100 })
  ];
  const result = filterIncidents(cases, { text: 'голос', limit: 1, sort: 'affected_desc' }, NOW);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items.map(item => item.caseId), ['a']);
});

test('catalog returns distinct case metadata, not incident data', () => {
  const catalog = filterCatalog([
    incident({ product: 'A', region: 'Москва', service: 'S', team: 'T1' }),
    incident({ product: 'A', region: 'Казань', service: 'S', team: null })
  ]);
  assert.deepEqual(catalog.products, ['A']);
  assert.deepEqual(catalog.regions, ['Казань', 'Москва']);
  assert.deepEqual(catalog.teams, ['T1']);
  assert.equal(Object.keys(catalog).length, 4);
});
