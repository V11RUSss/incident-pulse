'use strict';

const GROUPS = Object.freeze(['active', 'critical', 'coordination', 'high', 'research', 'closed']);
const GROUP_SET = new Set(GROUPS);
const PRIORITY_SET = new Set([1, 2, 3, 4]);
const STATE_SET = new Set([0, 2, 20, 7, 10]);
const SLA_SET = new Set(['ok', 'risk', 'overdue', 'risk_or_overdue']);
const SORT_SET = new Set(['priority_desc', 'due_asc', 'affected_desc', 'started_desc']);
const FILTER_KEYS = new Set([
  'groups', 'stateIds', 'priorityIds', 'regions', 'products', 'services', 'teams',
  'needsTeam', 'unassignedCoordinator', 'affectedUsersMin', 'affectedUsersMax',
  'reportCountMin', 'reportCountMax', 'sla', 'dueWithinMinutes', 'startedWithinMinutes',
  'isNeedUp', 'isMaster', 'isEffect', 'text', 'sort', 'limit'
]);
const MAX_ARRAY = 20;
const MAX_TEXT = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

class FilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FilterError';
    this.status = 400;
    this.code = 'invalid_filter';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY) {
    throw new FilterError(field + ' должен быть непустым массивом (до ' + MAX_ARRAY + ' значений)');
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 120) {
      throw new FilterError(field + ' должен содержать непустые строки');
    }
    const normalized = item.trim();
    if (!result.some(existing => existing.toLowerCase() === normalized.toLowerCase())) result.push(normalized);
  }
  return result;
}

function intValue(value, field, minimum = 0, maximum = 1000000000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FilterError(field + ' должен быть целым числом от ' + minimum + ' до ' + maximum);
  }
  return value;
}

function boolValue(value, field) {
  if (typeof value !== 'boolean') throw new FilterError(field + ' должен быть boolean');
  return value;
}

function validateFilter(input) {
  if (!isObject(input)) throw new FilterError('filter должен быть объектом');
  for (const key of Object.keys(input)) {
    if (!FILTER_KEYS.has(key)) throw new FilterError('Неподдерживаемое поле фильтра: ' + key);
  }
  const filter = {};

  if (input.groups !== undefined) {
    const groups = stringList(input.groups, 'groups');
    for (const group of groups) {
      if (!GROUP_SET.has(group)) throw new FilterError('Неизвестная группа: ' + group);
    }
    filter.groups = groups;
  }
  if (input.stateIds !== undefined) {
    if (!Array.isArray(input.stateIds) || !input.stateIds.length) throw new FilterError('stateIds должен быть массивом');
    filter.stateIds = [...new Set(input.stateIds.map(id => intValue(id, 'stateIds', 0, 20)))];
    for (const id of filter.stateIds) if (!STATE_SET.has(id)) throw new FilterError('Неизвестный stateId: ' + id);
  }
  if (input.priorityIds !== undefined) {
    if (!Array.isArray(input.priorityIds) || !input.priorityIds.length) throw new FilterError('priorityIds должен быть массивом');
    filter.priorityIds = [...new Set(input.priorityIds.map(id => intValue(id, 'priorityIds', 1, 4)))];
    for (const id of filter.priorityIds) if (!PRIORITY_SET.has(id)) throw new FilterError('Неизвестный priorityId: ' + id);
  }
  for (const field of ['regions', 'products', 'services', 'teams']) {
    if (input[field] !== undefined) filter[field] = stringList(input[field], field);
  }
  for (const field of ['needsTeam', 'unassignedCoordinator', 'isNeedUp', 'isMaster', 'isEffect']) {
    if (input[field] !== undefined) filter[field] = boolValue(input[field], field);
  }
  for (const field of ['affectedUsersMin', 'affectedUsersMax', 'reportCountMin', 'reportCountMax']) {
    if (input[field] !== undefined) filter[field] = intValue(input[field], field);
  }
  if (filter.affectedUsersMin !== undefined && filter.affectedUsersMax !== undefined && filter.affectedUsersMin > filter.affectedUsersMax) {
    throw new FilterError('affectedUsersMin больше affectedUsersMax');
  }
  if (filter.reportCountMin !== undefined && filter.reportCountMax !== undefined && filter.reportCountMin > filter.reportCountMax) {
    throw new FilterError('reportCountMin больше reportCountMax');
  }
  if (input.sla !== undefined) {
    if (!SLA_SET.has(input.sla)) throw new FilterError('sla должен быть ok, risk, overdue или risk_or_overdue');
    filter.sla = input.sla;
  }
  for (const field of ['dueWithinMinutes', 'startedWithinMinutes']) {
    if (input[field] !== undefined) filter[field] = intValue(input[field], field, 1, 10080);
  }
  if (input.text !== undefined) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_TEXT) {
      throw new FilterError('text должен содержать от 1 до ' + MAX_TEXT + ' символов');
    }
    filter.text = input.text.trim();
  }
  if (input.sort !== undefined) {
    if (!SORT_SET.has(input.sort)) throw new FilterError('Неподдерживаемая сортировка');
    filter.sort = input.sort;
  }
  if (input.limit !== undefined) filter.limit = intValue(input.limit, 'limit', 1, MAX_LIMIT);
  return filter;
}

function includesText(value, query) {
  if (value === null || value === undefined) return false;
  return String(value).toLocaleLowerCase('ru').includes(query);
}

function exactList(value, list) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).toLocaleLowerCase('ru');
  return list.some(item => item.toLocaleLowerCase('ru') === normalized);
}

function slaState(incident, now, windowMs) {
  if (!Array.isArray(incident.groups) || !incident.groups.includes('active')) return null;
  const dueAt = incident.dueAt;
  if (dueAt === null || dueAt === undefined) return 'ok';
  if (dueAt < now) return 'overdue';
  if (dueAt - now <= windowMs) return 'risk';
  return 'ok';
}

function matchesFilter(incident, filter, now, riskWindowMs) {
  if (filter.groups && !filter.groups.some(group => incident.groups.includes(group))) return false;
  if (filter.stateIds && !filter.stateIds.includes(incident.stateId)) return false;
  if (filter.priorityIds && !filter.priorityIds.includes(incident.priorityId)) return false;
  if (filter.regions && !exactList(incident.region, filter.regions)) return false;
  if (filter.products && !exactList(incident.product, filter.products)) return false;
  if (filter.services && !exactList(incident.service, filter.services)) return false;
  if (filter.teams && !exactList(incident.team, filter.teams)) return false;

  const isActive = incident.groups.includes('active');
  if (filter.needsTeam && !(isActive && !incident.team)) return false;
  if (filter.unassignedCoordinator && !(isActive && !incident.coordinatorId)) return false;
  if (filter.isNeedUp !== undefined && incident.isNeedUp !== filter.isNeedUp) return false;
  if (filter.isMaster !== undefined && incident.isMaster !== filter.isMaster) return false;
  if (filter.isEffect !== undefined && incident.isEffect !== filter.isEffect) return false;

  if (filter.affectedUsersMin !== undefined && incident.affectedUsers < filter.affectedUsersMin) return false;
  if (filter.affectedUsersMax !== undefined && incident.affectedUsers > filter.affectedUsersMax) return false;
  if (filter.reportCountMin !== undefined && incident.reportCount < filter.reportCountMin) return false;
  if (filter.reportCountMax !== undefined && incident.reportCount > filter.reportCountMax) return false;

  if (filter.sla) {
    const state = slaState(incident, now, riskWindowMs);
    if (state === null) return false;
    if (filter.sla === 'risk_or_overdue') {
      if (state !== 'risk' && state !== 'overdue') return false;
    } else if (state !== filter.sla) {
      return false;
    }
  }
  if (filter.dueWithinMinutes !== undefined) {
    if (!isActive || incident.dueAt === null || incident.dueAt === undefined) return false;
    if (incident.dueAt < now || incident.dueAt > now + filter.dueWithinMinutes * 60000) return false;
  }
  if (filter.startedWithinMinutes !== undefined) {
    if (incident.startedAt === null || incident.startedAt === undefined) return false;
    if (incident.startedAt < now - filter.startedWithinMinutes * 60000) return false;
  }
  if (filter.text) {
    const query = filter.text.toLocaleLowerCase('ru');
    const fields = [
      incident.id, incident.title, incident.description, incident.product,
      incident.service, incident.scenario, incident.region, incident.coordinatorName,
      incident.team, ...(incident.sourceIds || [])
    ];
    if (!fields.some(value => includesText(value, query))) return false;
  }
  return true;
}

function compare(a, b, sort) {
  if (sort === 'due_asc') {
    if (a.dueAt === null || a.dueAt === undefined) return b.dueAt === null || b.dueAt === undefined ? 0 : 1;
    if (b.dueAt === null || b.dueAt === undefined) return -1;
    return a.dueAt - b.dueAt;
  }
  if (sort === 'affected_desc') return (b.affectedUsers || 0) - (a.affectedUsers || 0);
  if (sort === 'started_desc') return (b.startedAt || 0) - (a.startedAt || 0);
  const priority = (b.priorityId || 0) - (a.priorityId || 0);
  if (priority) return priority;
  if (a.dueAt !== null && a.dueAt !== undefined && b.dueAt !== null && b.dueAt !== undefined) return a.dueAt - b.dueAt;
  if (a.dueAt !== null && a.dueAt !== undefined) return -1;
  if (b.dueAt !== null && b.dueAt !== undefined) return 1;
  return (b.startedAt || 0) - (a.startedAt || 0);
}

function filterIncidents(incidents, filter, now = Date.now(), riskWindowMs = 15 * 60 * 1000) {
  const normalized = validateFilter(filter);
  const matches = (incidents || []).filter(incident => matchesFilter(incident, normalized, now, riskWindowMs));
  matches.sort((a, b) => compare(a, b, normalized.sort || 'priority_desc'));
  const limit = normalized.limit || DEFAULT_LIMIT;
  const activeCount = matches.filter(incident => incident.groups.includes('active')).length;
  const closedCount = matches.filter(incident => incident.groups.includes('closed')).length;
  return {
    items: matches.slice(0, limit),
    total: matches.length,
    activeCount,
    closedCount,
    truncated: matches.length > limit,
    filter: normalized
  };
}

function filterCatalog(incidents) {
  const products = new Set();
  const regions = new Set();
  const services = new Set();
  const teams = new Set();
  for (const incident of incidents || []) {
    if (incident.product) products.add(incident.product);
    if (incident.region) regions.add(incident.region);
    if (incident.service) services.add(incident.service);
    if (incident.team) teams.add(incident.team);
  }
  const sorted = set => [...set].sort((a, b) => a.localeCompare(b, 'ru')).slice(0, 60);
  return {
    products: sorted(products),
    regions: sorted(regions),
    services: sorted(services),
    teams: sorted(teams)
  };
}

module.exports = {
  DEFAULT_LIMIT,
  FilterError,
  MAX_LIMIT,
  filterCatalog,
  filterIncidents,
  validateFilter
};
