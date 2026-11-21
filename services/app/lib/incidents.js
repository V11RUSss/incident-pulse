'use strict';

const CANONICAL_VERSION = 2;
const PRIORITIES = Object.freeze({ 4: 'critical', 3: 'high', 2: 'medium', 1: 'low' });
const PRIORITY_TEXT = Object.freeze({ 4: 'Наивысший', 3: 'Высокий', 2: 'Средний', 1: 'Низкий' });
const STATES = Object.freeze({
  0: 'Назначен',
  2: 'Выполняется',
  20: 'Исследование ситуации',
  7: 'Завершен',
  10: 'Закрыт'
});

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value) {
  if (value === null || value === undefined || value === '') return null;
  const converted = Number(value);
  return Number.isSafeInteger(converted) ? converted : null;
}

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function nullableText(value) {
  const converted = text(value).trim();
  return converted || null;
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let input = value.trim();
  if (!input) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(input) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) {
    input = `${input.replace(' ', 'T')}Z`;
  }
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function incidentId(raw) {
  return raw && raw.id !== null && raw.id !== undefined ? String(raw.id) : '';
}

function correlationKey(raw) {
  return nullableText(raw.correlationKey) || `id:${incidentId(raw)}`;
}

function validateRawIncident(raw, path = 'incident') {
  if (!isObject(raw)) throw new ValidationError(`${path} должен быть объектом`);
  if (!['string', 'number'].includes(typeof raw.id) || !incidentId(raw).trim()) {
    throw new ValidationError(`${path}.id обязателен`);
  }
  if (integer(raw.version) === null || integer(raw.version) < 0) {
    throw new ValidationError(`${path}.version должен быть неотрицательным целым числом`);
  }
  const stateId = integer(raw.stateId);
  if (stateId === null || !Object.hasOwn(STATES, stateId)) {
    throw new ValidationError(`${path}.stateId должен быть равен 0, 2, 20, 7 или 10`);
  }
  if (!Object.hasOwn(PRIORITIES, integer(raw.priorityId))) {
    throw new ValidationError(`${path}.priorityId должен быть равен 1, 2, 3 или 4`);
  }
  for (const field of ['affectedUsers', 'reportCount']) {
    if (integer(raw[field]) === null || integer(raw[field]) < 0) {
      throw new ValidationError(`${path}.${field} должен быть неотрицательным целым числом`);
    }
  }
  if (parseTimestamp(raw.submitDate) === null) {
    throw new ValidationError(`${path}.submitDate должен содержать корректную дату`);
  }
  for (const field of ['deadline', 'completionDate', 'updatedAt']) {
    if (raw[field] !== null && raw[field] !== undefined && raw[field] !== '' && parseTimestamp(raw[field]) === null) {
      throw new ValidationError(`${path}.${field} должен содержать корректную дату или null`);
    }
  }
  if (raw.priorityOverrideId !== null && raw.priorityOverrideId !== undefined &&
      !Object.hasOwn(PRIORITIES, integer(raw.priorityOverrideId))) {
    throw new ValidationError(`${path}.priorityOverrideId должен быть равен 1, 2, 3 или 4`);
  }
}

function validateRawBatch(value) {
  if (!Array.isArray(value)) throw new ValidationError('Ожидался массив raw-инцидентов');
  const ids = new Set();
  value.forEach((raw, index) => {
    validateRawIncident(raw, `incidents[${index}]`);
    const id = incidentId(raw);
    if (ids.has(id)) throw new ValidationError(`Дублирующийся id в delta: ${id}`);
    ids.add(id);
  });
  return value;
}

function automaticPriority(affectedUsers) {
  if (affectedUsers >= 1000) return 4;
  if (affectedUsers >= 500) return 3;
  if (affectedUsers >= 50) return 2;
  return 1;
}

function hasActiveImpact(source) {
  const stateId = integer(source.stateId);
  return stateId === 0 || stateId === 2 || stateId === 20;
}

function compareSources(a, b) {
  const aStarted = parseTimestamp(a.submitDate) ?? Number.MAX_SAFE_INTEGER;
  const bStarted = parseTimestamp(b.submitDate) ?? Number.MAX_SAFE_INTEGER;
  return aStarted - bStarted || incidentId(a).localeCompare(incidentId(b));
}

function latestTimestamp(sources, field) {
  const values = sources.map(source => parseTimestamp(source[field])).filter(value => value !== null);
  return values.length ? Math.max(...values) : null;
}

function earliestTimestamp(sources, field) {
  const values = sources.map(source => parseTimestamp(source[field])).filter(value => value !== null);
  return values.length ? Math.min(...values) : null;
}

function buildCanonicalIncident({ caseId, correlationKey: caseCorrelationKey, sources, priorityOverrideId, version }) {
  if (!sources.length) throw new Error(`Case ${caseId} не содержит source records`);
  const sorted = [...sources].sort(compareSources);
  const activeSources = sorted.filter(source => integer(source.stateId) === 0 || integer(source.stateId) === 2);
  const researchSources = sorted.filter(source => integer(source.stateId) === 20);
  const primaryPool = activeSources.length ? activeSources : researchSources.length ? researchSources : sorted;
  const primary = primaryPool[0];
  const stateId = activeSources.length
    ? integer(primary.stateId)
    : researchSources.length
      ? 20
      : integer(primary.stateId);
  const active = stateId === 0 || stateId === 2;
  const research = stateId === 20;
  const closed = stateId === 7 || stateId === 10;
  const affectedUsers = sorted.reduce((sum, source) => sum + integer(source.affectedUsers), 0);
  const activeAffectedUsers = sorted
    .filter(hasActiveImpact)
    .reduce((sum, source) => sum + integer(source.affectedUsers), 0);
  const reportCount = sorted.reduce((sum, source) => sum + integer(source.reportCount), 0);
  const autoPriorityId = automaticPriority(activeAffectedUsers);
  const override = Object.hasOwn(PRIORITIES, integer(priorityOverrideId)) ? integer(priorityOverrideId) : null;
  const priorityId = override ?? autoPriorityId;
  const team = nullableText(primary.assignedGroupName);
  // Display groups are exclusive for active cases: priority first, then coordination.
  // A critical/high case is shown only in its priority column even when no team is assigned.
  const groups = [];
  if (active) {
    groups.push('active');
    if (priorityId === 4) groups.push('critical');
    else if (priorityId === 3) groups.push('high');
    else if (!team) groups.push('coordination');
  }
  if (research) groups.push('research');
  if (closed) groups.push('closed');

  const solutionSource = [...sorted]
    .filter(source => nullableText(source.solution))
    .sort((a, b) => (parseTimestamp(b.updatedAt) ?? 0) - (parseTimestamp(a.updatedAt) ?? 0) || integer(b.version) - integer(a.version))[0];

  return {
    caseId,
    id: incidentId(primary),
    sourceIds: sorted.map(incidentId),
    correlationKey: caseCorrelationKey,
    title: text(primary.header),
    description: text(primary.description),
    product: text(primary.productName),
    service: text(primary.service),
    scenario: text(primary.scenarioName),
    region: text(primary.region),
    affectedUsers,
    activeAffectedUsers,
    reportCount,
    priority: PRIORITIES[priorityId],
    priorityId,
    autoPriorityId,
    priorityOverrideId: override,
    prioritySource: override === null ? 'auto' : 'manual',
    priorityText: PRIORITY_TEXT[priorityId],
    status: STATES[stateId] || 'Неизвестный статус',
    stateId,
    team,
    coordinatorId: nullableText(primary.coordinatorId),
    coordinatorName: nullableText(primary.coordinatorName),
    startedAt: earliestTimestamp(sorted, 'submitDate'),
    dueAt: earliestTimestamp(active ? activeSources : sorted, 'deadline'),
    resolvedAt: active ? null : latestTimestamp(sorted, 'completionDate'),
    groups,
    solution: active ? null : nullableText(solutionSource && solutionSource.solution),
    isNeedUp: sorted.some(source => source.isNeedUp === true),
    isMaster: sorted.some(source => source.isMaster === true),
    isEffect: sorted.some(source => source.isEffect === true),
    aiSummary: null,
    aiTeam: null,
    aiReason: null,
    aiRisk: null,
    version
  };
}

function countIncidents(incidents, now = Date.now(), riskWindowMs = 15 * 60 * 1000) {
  const counts = { active: 0, critical: 0, coordination: 0, high: 0, research: 0, risk: 0, affectedUsers: 0 };
  for (const incident of incidents) {
    for (const group of ['active', 'critical', 'coordination', 'high', 'research']) {
      if (incident.groups.includes(group)) counts[group] += 1;
    }
    if (incident.groups.includes('active')) {
      counts.affectedUsers += incident.affectedUsers;
      if (incident.dueAt !== null && incident.dueAt <= now + riskWindowMs) counts.risk += 1;
    }
  }
  return counts;
}

module.exports = {
  CANONICAL_VERSION,
  PRIORITIES,
  PRIORITY_TEXT,
  STATES,
  ValidationError,
  automaticPriority,
  buildCanonicalIncident,
  correlationKey,
  countIncidents,
  incidentId,
  integer,
  isObject,
  nullableText,
  parseTimestamp,
  validateRawBatch,
  validateRawIncident
};
