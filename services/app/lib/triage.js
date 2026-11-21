'use strict';

const { STATES } = require('./incidents');

const TRIAGE_TYPES = Object.freeze(['merge', 'correlation_key']);
const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
const CONFIDENCE_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SUGGESTIONS = 50;
const DEFAULT_MAX_CANDIDATES = 12;
const DEFAULT_MAX_KEYLESS = 12;
const MIN_SIMILARITY = 0.25;
const CLASSIFICATION_MIN_TITLE_SIMILARITY = 0.1;
const HIGH_SIMILARITY = 0.65;
const MEDIUM_SIMILARITY = 0.35;
const TITLE_WEIGHT = 0.5;
const DESCRIPTION_WEIGHT = 0.5;
const MAX_AI_SUGGESTIONS = 50;
const FALLBACK_KEY_PREFIX = 'id:';
const SUGGESTED_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const TITLE_STOPWORDS = new Set([
  'для', 'при', 'что', 'это', 'как', 'или', 'без', 'после', 'через', 'между',
  'также', 'если', 'все', 'весь', 'она', 'они', 'его', 'ее', 'её', 'их', 'над',
  'под', 'про', 'чем', 'кого', 'чего', 'где', 'когда', 'очень', 'более', 'менее',
  'только', 'уже', 'еще', 'ещё', 'был', 'была', 'были', 'быть', 'есть', 'нет',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about'
]);

const TRIAGE_SYSTEM_PROMPT = [
  'Ты — аналитик триажа массовых ИТ-инцидентов МТС.',
  'Работай только с переданными кандидатами: не придумывай другие инциденты, пользователей, команды и события.',
  'Отделяй факт от гипотезы: rationale и evidence должны опираться на поля кандидатов.',
  'Объединять (merge) можно только открытые инциденты одного типа: active+active или research+research, с одинаковыми продуктом и регионом.',
  'correlationKey предлагай только для кандидатов без ключа; ключ не должен начинаться с id:.',
  'Пиши по-русски, кратко. Ответ — только JSON без Markdown и текста вокруг.'
].join('\n');

class TriageAiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TriageAiError';
    this.status = 502;
    this.code = 'triage_ai_parse_failed';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedText(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function normalizedKey(value) {
  return normalizedText(value).toLowerCase();
}

function stateIdOf(incident) {
  return Number.isInteger(incident.stateId) ? incident.stateId : null;
}

function hasGroup(incident, group) {
  return Array.isArray(incident.groups) && incident.groups.includes(group);
}

function openKind(incident) {
  const stateId = stateIdOf(incident);
  if (stateId === 0 || stateId === 2) return 'active';
  if (stateId === 20) return 'research';
  if (hasGroup(incident, 'active')) return 'active';
  if (hasGroup(incident, 'research')) return 'research';
  return null;
}

function isOpen(incident) {
  return openKind(incident) !== null;
}

function statusOf(incident) {
  return normalizedText(incident.status) || STATES[stateIdOf(incident)] || 'неизвестный статус';
}

function caseIdOf(incident) {
  return incident && incident.caseId !== null && incident.caseId !== undefined ? String(incident.caseId) : '';
}

function incidentIdOf(incident) {
  return incident && incident.id !== null && incident.id !== undefined ? String(incident.id) : caseIdOf(incident);
}

function clip(value, max) {
  const text = normalizedText(value);
  return text.length > max ? text.slice(0, max) : text;
}

function tokens(value) {
  const raw = normalizedText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!raw) return new Set();
  return new Set(raw.split(' ').filter(token => token.length >= 3 && !TITLE_STOPWORDS.has(token)));
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function hoursBetween(left, right) {
  const leftStart = Number(left.startedAt);
  const rightStart = Number(right.startedAt);
  if (!Number.isFinite(leftStart) || !Number.isFinite(rightStart)) return null;
  return Math.round(Math.abs(leftStart - rightStart) / 36000) / 100;
}

function correlationKeyOf(incident) {
  return normalizedText(incident.correlationKey);
}

function isFallbackCorrelationKey(value) {
  const key = normalizedText(value);
  return !key || key.startsWith(FALLBACK_KEY_PREFIX);
}

function isKeylessCase(incident) {
  return isOpen(incident) && isFallbackCorrelationKey(correlationKeyOf(incident));
}

function normalizeSuggestedKey(value) {
  const raw = normalizedText(value).toLowerCase();
  if (!raw || raw.startsWith(FALLBACK_KEY_PREFIX)) return null;
  const key = raw
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(0, 128);
  if (!key || key.startsWith(FALLBACK_KEY_PREFIX) || !SUGGESTED_KEY_PATTERN.test(key)) return null;
  return key;
}

function orderPair(left, right) {
  const leftStart = Number(left.startedAt);
  const rightStart = Number(right.startedAt);
  const startsKnown = Number.isFinite(leftStart) && Number.isFinite(rightStart);
  if (startsKnown && leftStart !== rightStart) {
    return leftStart < rightStart
      ? { target: left, source: right }
      : { target: right, source: left };
  }
  const leftUsers = Number(left.affectedUsers) || 0;
  const rightUsers = Number(right.affectedUsers) || 0;
  if (leftUsers !== rightUsers) {
    return leftUsers > rightUsers
      ? { target: left, source: right }
      : { target: right, source: left };
  }
  return caseIdOf(left).localeCompare(caseIdOf(right), 'ru') <= 0
    ? { target: left, source: right }
    : { target: right, source: left };
}

function candidatePair(left, right, options = {}) {
  const kind = openKind(left);
  if (!kind || kind !== openKind(right)) return null;
  const product = normalizedKey(left.product);
  if (!product || product !== normalizedKey(right.product)) return null;
  const region = normalizedKey(left.region);
  if (region !== normalizedKey(right.region)) return null;

  const hoursApart = hoursBetween(left, right);
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : DEFAULT_WINDOW_MS;
  if (hoursApart !== null && hoursApart * 3600000 > windowMs) return null;

  const titleSimilarity = jaccard(tokens(left.title), tokens(right.title));
  const descriptionSimilarity = jaccard(tokens(left.description), tokens(right.description));
  const similarity = TITLE_WEIGHT * titleSimilarity + DESCRIPTION_WEIGHT * descriptionSimilarity;

  const serviceMatch = Boolean(normalizedKey(left.service)) && normalizedKey(left.service) === normalizedKey(right.service);
  const scenarioMatch = Boolean(normalizedKey(left.scenario)) && normalizedKey(left.scenario) === normalizedKey(right.scenario);
  const classificationMatch = serviceMatch && scenarioMatch;
  const textualCandidate = similarity >= MIN_SIMILARITY;
  const classifiedCandidate = classificationMatch
    && titleSimilarity >= CLASSIFICATION_MIN_TITLE_SIMILARITY;
  if (!textualCandidate && !classifiedCandidate) return null;

  const ordered = orderPair(left, right);
  const target = ordered.target;
  const source = ordered.source;
  const confidence = similarity >= HIGH_SIMILARITY
    ? 'high'
    : similarity >= MEDIUM_SIMILARITY || classifiedCandidate ? 'medium' : 'low';
  const productLabel = normalizedText(target.product);
  const regionLabel = normalizedText(target.region) || 'не указан';
  const hoursLabel = hoursApart === null ? 'неизвестно' : String(hoursApart) + ' ч';
  const classificationNote = classificationMatch ? '; совпадают сервис и сценарий' : '';
  return {
    pairKey: caseIdOf(target) + '|' + caseIdOf(source),
    target,
    source,
    targetCaseId: caseIdOf(target),
    sourceCaseId: caseIdOf(source),
    targetIncidentId: incidentIdOf(target),
    sourceIncidentId: incidentIdOf(source),
    targetTitle: normalizedText(target.title),
    sourceTitle: normalizedText(source.title),
    titleSimilarity: round2(titleSimilarity),
    descriptionSimilarity: round2(descriptionSimilarity),
    similarity: round2(similarity),
    hoursApart,
    confidence,
    rationale: 'Одинаковые продукт «' + productLabel + '» и регион «' + regionLabel + '»'
      + classificationNote + '. Заголовки совпадают на ' + Math.round(titleSimilarity * 100)
      + '%, описания — на ' + Math.round(descriptionSimilarity * 100) + '%.',
    evidence: 'Заголовки: «' + clip(target.title, 180) + '» / «' + clip(source.title, 180)
      + '». Продукт: ' + productLabel + '. Регион: ' + regionLabel
      + (classificationMatch ? '. Сервис и сценарий совпадают.' : '.')
      + ' Разница старта: ' + hoursLabel + '.'
  };
}

function compareCandidates(left, right) {
  return (typeof right.similarity === 'number' ? right.similarity : 0)
    - (typeof left.similarity === 'number' ? left.similarity : 0)
    || String(left.pairKey).localeCompare(String(right.pairKey), 'ru');
}

function compareKeyless(left, right) {
  const kindRank = incident => (openKind(incident) === 'active' ? 0 : 1);
  return kindRank(left) - kindRank(right)
    || (Number.isInteger(right.priorityId) ? right.priorityId : 0) - (Number.isInteger(left.priorityId) ? left.priorityId : 0)
    || (Number(right.startedAt) || 0) - (Number(left.startedAt) || 0)
    || caseIdOf(left).localeCompare(caseIdOf(right), 'ru');
}

function filterCases(cases, caseIds) {
  const filter = Array.isArray(caseIds) && caseIds.length
    ? new Set(caseIds.map(String))
    : null;
  return (Array.isArray(cases) ? cases : []).filter((incident) => {
    if (!incident || typeof incident !== 'object' || !incident.caseId) return false;
    return !filter || filter.has(caseIdOf(incident));
  });
}

function findTriageCandidates(cases, options = {}) {
  const list = filterCases(cases, options.caseIds);
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const pair = candidatePair(list[i], list[j], options);
      if (pair) pairs.push(pair);
    }
  }
  pairs.sort(compareCandidates);
  const keyless = list.filter(isKeylessCase).sort(compareKeyless);
  return { cases: list, pairs, keyless, keylessCases: keyless };
}

function roundSimilarity(value) {
  return Number.isFinite(value) ? round2(value) : 0;
}

function makeMergeSuggestion(pair, overrides = {}) {
  return {
    id: 'merge:' + pair.targetCaseId + ':' + pair.sourceCaseId,
    type: 'merge',
    sourceCaseId: pair.sourceCaseId,
    targetCaseId: pair.targetCaseId,
    caseId: pair.sourceCaseId,
    suggestedKey: null,
    confidence: overrides.confidence || pair.confidence,
    rationale: overrides.rationale || pair.rationale,
    evidence: overrides.evidence || pair.evidence,
    sourceTitle: pair.sourceTitle,
    targetTitle: pair.targetTitle,
    title: pair.sourceTitle,
    sourceIncidentId: pair.sourceIncidentId,
    targetIncidentId: pair.targetIncidentId,
    incidentId: pair.sourceIncidentId,
    similarity: roundSimilarity(pair.similarity),
    titleSimilarity: roundSimilarity(pair.titleSimilarity),
    descriptionSimilarity: roundSimilarity(pair.descriptionSimilarity)
  };
}

function makeCorrelationSuggestion(incident, suggestedKey, overrides = {}) {
  const caseId = caseIdOf(incident);
  return {
    id: 'correlation_key:' + caseId,
    type: 'correlation_key',
    sourceCaseId: null,
    targetCaseId: null,
    caseId,
    suggestedKey: normalizeSuggestedKey(suggestedKey) || normalizedText(suggestedKey),
    confidence: overrides.confidence || 'medium',
    rationale: overrides.rationale || 'У кейса нет correlationKey: предложен ключ для объединения будущих записей.',
    evidence: overrides.evidence || 'Текущий correlationKey отсутствует (fallback ' + (correlationKeyOf(incident) || 'id:' + incidentIdOf(incident)) + ').',
    sourceTitle: null,
    targetTitle: null,
    title: normalizedText(incident.title),
    sourceIncidentId: null,
    targetIncidentId: null,
    incidentId: incidentIdOf(incident),
    similarity: null,
    titleSimilarity: null,
    descriptionSimilarity: null
  };
}

function suggestionRank(suggestion) {
  const rank = CONFIDENCE_RANK[suggestion.confidence];
  return rank === undefined ? CONFIDENCES.length : rank;
}

function compareSuggestions(left, right) {
  return suggestionRank(left) - suggestionRank(right)
    || TRIAGE_TYPES.indexOf(left.type) - TRIAGE_TYPES.indexOf(right.type)
    || String(left.id).localeCompare(String(right.id), 'ru');
}

function summarizeSuggestions(suggestions) {
  const byType = { merge: 0, correlation_key: 0 };
  const byConfidence = { high: 0, medium: 0, low: 0 };
  for (const suggestion of suggestions) {
    if (Object.hasOwn(byType, suggestion.type)) byType[suggestion.type] += 1;
    if (Object.hasOwn(byConfidence, suggestion.confidence)) byConfidence[suggestion.confidence] += 1;
  }
  return { byType, byConfidence };
}

function buildDeterministicReport(cases, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxSuggestions = Number.isInteger(options.maxSuggestions) && options.maxSuggestions > 0
    ? options.maxSuggestions
    : DEFAULT_MAX_SUGGESTIONS;
  const candidates = findTriageCandidates(cases, options);
  const allSuggestions = candidates.pairs.slice(0, maxSuggestions).map(pair => makeMergeSuggestion(pair));
  allSuggestions.sort(compareSuggestions);
  const summary = summarizeSuggestions(allSuggestions);
  return {
    suggestions: allSuggestions,
    byType: summary.byType,
    byConfidence: summary.byConfidence,
    scannedCases: candidates.cases.length,
    candidatePairs: candidates.pairs.length,
    keylessCases: candidates.keyless.length,
    truncated: candidates.pairs.length > maxSuggestions,
    source: 'rules',
    generatedAt: now,
    aiChecked: 0,
    aiSkipped: false
  };
}

function caseSummary(incident) {
  return {
    caseId: caseIdOf(incident),
    incidentId: incidentIdOf(incident),
    title: clip(incident.title, 300),
    description: clip(incident.description, 600),
    product: normalizedText(incident.product),
    service: normalizedText(incident.service),
    scenario: normalizedText(incident.scenario),
    region: normalizedText(incident.region),
    status: statusOf(incident)
  };
}

function buildTriagePrompt(candidates) {
  const pairs = Array.isArray(candidates && candidates.pairs) ? candidates.pairs : [];
  const keylessCases = Array.isArray(candidates && candidates.keylessCases) ? candidates.keylessCases : [];
  const mergeCandidates = pairs.map(pair => ({
    sourceCaseId: pair.sourceCaseId,
    sourceIncidentId: pair.sourceIncidentId,
    sourceTitle: pair.sourceTitle,
    sourceDescription: clip(pair.source && pair.source.description, 500),
    targetCaseId: pair.targetCaseId,
    targetIncidentId: pair.targetIncidentId,
    targetTitle: pair.targetTitle,
    targetDescription: clip(pair.target && pair.target.description, 500),
    product: normalizedText(pair.target.product),
    region: normalizedText(pair.target.region),
    service: normalizedText(pair.target.service),
    scenario: normalizedText(pair.target.scenario),
    titleSimilarity: roundSimilarity(pair.titleSimilarity),
    descriptionSimilarity: roundSimilarity(pair.descriptionSimilarity),
    hoursApart: pair.hoursApart === null || pair.hoursApart === undefined ? null : pair.hoursApart
  }));
  const keyless = keylessCases.map(caseSummary);
  return [
    'Проверь семантические дубли и предложи correlationKey для кейсов без ключа.',
    'Кандидаты на объединение (только эти пары):',
    JSON.stringify(mergeCandidates),
    'Кейсы без correlationKey (fallback-ключ начинается с id:):',
    JSON.stringify(keyless),
    'Верни только JSON:',
    '{"suggestions":[{"type":"merge","sourceCaseId":"...","targetCaseId":"...","confidence":"high|medium|low","rationale":"...","evidence":"..."},{"type":"correlation_key","caseId":"...","suggestedKey":"...","confidence":"high|medium|low","rationale":"...","evidence":"..."}]}',
    'Правила:',
    '- ID строго из переданных кандидатов;',
    '- merge только для пар из списка merge-кандидатов;',
    '- correlation_key только для кейсов из списка без ключа; suggestedKey — только [a-z0-9._-], начинается с буквы/цифры, до 128 символов, без id:;',
    '- evidence — цитата/факт из полей кандидата, без выдуманных событий, чисел и людей;',
    '- если уверенности нет, не добавляй suggestion; пустой ответ: {"suggestions":[]};',
    '- без Markdown, только JSON.'
  ].join('\n');
}

function stripAiPreamble(content) {
  return String(content === null || content === undefined ? '' : content)
    .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
    .replace(/^\s*\x60{3}(?:json)?\s*/i, '')
    .replace(/\x60{3}\s*$/, '')
    .trim();
}

function cleanString(value, max) {
  if (typeof value !== 'string') return '';
  const text = normalizedText(value);
  return text ? text.slice(0, max) : '';
}

function normalizeConfidence(value) {
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (CONFIDENCES.includes(text)) return text;
    return null;
  }
  if (Number.isFinite(value)) {
    if (value >= 0.7) return 'high';
    if (value >= 0.45) return 'medium';
    return 'low';
  }
  return null;
}

function parseTriageResponse(content, candidates = {}) {
  let parsed;
  try {
    parsed = JSON.parse(stripAiPreamble(content));
  } catch {
    throw new TriageAiError('Модель вернула не JSON');
  }
  let rawList = null;
  if (Array.isArray(parsed)) rawList = parsed;
  else if (isObject(parsed) && Array.isArray(parsed.suggestions)) rawList = parsed.suggestions;
  else if (isObject(parsed) && Array.isArray(parsed.items)) rawList = parsed.items;
  if (rawList === null) throw new TriageAiError('Модель вернула некорректный ответ');

  const pairs = Array.isArray(candidates.pairs) ? candidates.pairs : [];
  const keylessCases = Array.isArray(candidates.keylessCases)
    ? candidates.keylessCases
    : Array.isArray(candidates.keyless) ? candidates.keyless : [];
  const pairMap = new Map();
  for (const pair of pairs) {
    pairMap.set(pair.sourceCaseId + '|' + pair.targetCaseId, pair);
    pairMap.set(pair.targetCaseId + '|' + pair.sourceCaseId, pair);
  }
  const keylessIds = new Set(keylessCases.map(caseIdOf));

  const accepted = [];
  const mergeIndex = new Map();
  const correlationIndex = new Map();
  for (const raw of rawList.slice(0, MAX_AI_SUGGESTIONS)) {
    if (!isObject(raw)) continue;
    const confidence = normalizeConfidence(raw.confidence);
    if (!confidence) continue;
    const rationale = cleanString(raw.rationale, 500);
    if (!rationale) continue;
    const evidence = cleanString(raw.evidence, 500);

    if (raw.type === 'merge') {
      const sourceCaseId = cleanString(raw.sourceCaseId, 200);
      const targetCaseId = cleanString(raw.targetCaseId, 200);
      if (!sourceCaseId || !targetCaseId || sourceCaseId === targetCaseId) continue;
      const pair = pairMap.get(sourceCaseId + '|' + targetCaseId);
      if (!pair) continue;
      const suggestion = {
        type: 'merge',
        pairKey: pair.pairKey,
        sourceCaseId: pair.sourceCaseId,
        targetCaseId: pair.targetCaseId,
        confidence,
        rationale,
        evidence: evidence || pair.evidence
      };
      const existing = mergeIndex.get(pair.pairKey);
      if (existing === undefined) {
        mergeIndex.set(pair.pairKey, accepted.length);
        accepted.push(suggestion);
      } else if (suggestionRank(suggestion) < suggestionRank(accepted[existing])) {
        accepted[existing] = suggestion;
      }
      continue;
    }

    if (raw.type === 'correlation_key') {
      const caseId = cleanString(raw.caseId, 200);
      if (!caseId || !keylessIds.has(caseId)) continue;
      const suggestedKey = normalizeSuggestedKey(raw.suggestedKey);
      if (!suggestedKey) continue;
      const suggestion = {
        type: 'correlation_key',
        caseId,
        suggestedKey,
        confidence,
        rationale,
        evidence
      };
      const existing = correlationIndex.get(caseId);
      if (existing === undefined) {
        correlationIndex.set(caseId, accepted.length);
        accepted.push(suggestion);
      } else if (suggestionRank(suggestion) < suggestionRank(accepted[existing])) {
        accepted[existing] = suggestion;
      }
    }
  }
  return accepted;
}

function pairByKey(pairs, pairKey) {
  return (Array.isArray(pairs) ? pairs : []).find(pair => pair.pairKey === pairKey) || null;
}

function mergeTriageReport(report, aiSuggestions, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxSuggestions = Number.isInteger(options.maxSuggestions) && options.maxSuggestions > 0
    ? options.maxSuggestions
    : DEFAULT_MAX_SUGGESTIONS;
  const cases = Array.isArray(options.cases) ? options.cases : [];
  const caseMap = new Map(cases.map(incident => [caseIdOf(incident), incident]));
  const pairs = Array.isArray(options.pairs) ? options.pairs : [];
  const suggestions = (Array.isArray(report.suggestions) ? report.suggestions : []).slice();
  const mergeIndex = new Map();
  const correlationIndex = new Map();
  for (let index = 0; index < suggestions.length; index += 1) {
    const suggestion = suggestions[index];
    if (suggestion.type === 'merge') {
      mergeIndex.set(suggestion.targetCaseId + '|' + suggestion.sourceCaseId, index);
    } else if (suggestion.type === 'correlation_key') {
      correlationIndex.set(String(suggestion.caseId), index);
    }
  }

  for (const ai of Array.isArray(aiSuggestions) ? aiSuggestions : []) {
    if (ai.type === 'merge') {
      const pair = pairByKey(pairs, ai.pairKey);
      if (!pair) continue;
      const existing = mergeIndex.get(pair.pairKey);
      if (existing === undefined) {
        const suggestion = makeMergeSuggestion(pair, {
          confidence: ai.confidence,
          rationale: ai.rationale,
          evidence: ai.evidence
        });
        mergeIndex.set(pair.pairKey, suggestions.length);
        suggestions.push(suggestion);
      } else {
        const current = suggestions[existing];
        const confidence = suggestionRank(ai) < suggestionRank(current) ? ai.confidence : current.confidence;
        suggestions[existing] = {
          ...current,
          confidence,
          rationale: ai.rationale || current.rationale,
          evidence: ai.evidence || current.evidence
        };
      }
      continue;
    }
    if (ai.type === 'correlation_key') {
      const incident = caseMap.get(String(ai.caseId));
      if (!incident) continue;
      const existing = correlationIndex.get(String(ai.caseId));
      if (existing === undefined) {
        const suggestion = makeCorrelationSuggestion(incident, ai.suggestedKey, {
          confidence: ai.confidence,
          rationale: ai.rationale,
          evidence: ai.evidence
        });
        correlationIndex.set(String(ai.caseId), suggestions.length);
        suggestions.push(suggestion);
      } else {
        const current = suggestions[existing];
        const confidence = suggestionRank(ai) < suggestionRank(current) ? ai.confidence : current.confidence;
        suggestions[existing] = {
          ...current,
          suggestedKey: ai.suggestedKey || current.suggestedKey,
          confidence,
          rationale: ai.rationale || current.rationale,
          evidence: ai.evidence || current.evidence
        };
      }
    }
  }

  suggestions.sort(compareSuggestions);
  const truncated = report.truncated === true || suggestions.length > maxSuggestions;
  const limited = suggestions.slice(0, maxSuggestions);
  const summary = summarizeSuggestions(limited);
  return {
    suggestions: limited,
    byType: summary.byType,
    byConfidence: summary.byConfidence,
    scannedCases: report.scannedCases,
    candidatePairs: report.candidatePairs,
    keylessCases: report.keylessCases,
    truncated,
    source: 'rules+ai',
    generatedAt: now,
    aiChecked: Number.isInteger(options.aiChecked) && options.aiChecked >= 0 ? options.aiChecked : 0,
    aiSkipped: false
  };
}

module.exports = {
  CONFIDENCES,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MAX_KEYLESS,
  DEFAULT_MAX_SUGGESTIONS,
  DEFAULT_WINDOW_MS,
  MIN_SIMILARITY,
  TRIAGE_SYSTEM_PROMPT,
  TRIAGE_TYPES,
  TriageAiError,
  buildDeterministicReport,
  buildTriagePrompt,
  findTriageCandidates,
  isFallbackCorrelationKey,
  isKeylessCase,
  isOpen,
  jaccard,
  makeCorrelationSuggestion,
  makeMergeSuggestion,
  mergeTriageReport,
  normalizeConfidence,
  normalizeSuggestedKey,
  openKind,
  parseTriageResponse,
  summarizeSuggestions,
  tokens
};
