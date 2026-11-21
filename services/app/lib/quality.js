'use strict';

const crypto = require('node:crypto');
const { STATES } = require('./incidents');

const SEVERITY_WEIGHTS = Object.freeze({ high: 12, medium: 6, low: 2 });
const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
const TYPES = Object.freeze(['team', 'solution', 'duplicate', 'status', 'field', 'sla']);
const MAX_FINDINGS = 200;
const MAX_AI_ISSUES = 50;
const AI_CANDIDATE_LIMIT = 8;
const MAX_AI_CASE_IDS = 20;
const MAX_DUPLICATE_PAIRS = 500;
const MAX_DUPLICATE_COMPARISONS = 50000;
const GENERIC_SOLUTION_MIN_LENGTH = 40;
const DUPLICATE_HIGH_SIMILARITY = 0.7;
const DUPLICATE_MIN_SIMILARITY = 0.5;

const TITLE_STOPWORDS = new Set([
  'для', 'при', 'что', 'это', 'как', 'или', 'без', 'после', 'через', 'между',
  'также', 'если', 'все', 'весь', 'она', 'они', 'его', 'ее', 'её', 'их', 'над',
  'под', 'про', 'чем', 'кого', 'чего', 'где', 'когда', 'очень', 'более', 'менее',
  'только', 'уже', 'еще', 'ещё', 'был', 'была', 'были', 'быть', 'есть', 'нет',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about'
]);

const GENERIC_SOLUTION_PATTERNS = Object.freeze([
  /^(?:ок|ok|окей|готово|done|fixed|resolved|решено|исправлено|устранено|восстановлено|восстановлена|закрыто|закрыт|нет|без комментариев|без деталей|стандартно|по инструкции|по стандартной процедуре|проблема решена|всё работает|все работает|перезагружено|перезапущено|проверено|выполнено)[\s.!]*$/iu,
  /^(?:tbd|n\/a|na|none|null|todo|-{1,}|\.{3})[\s.!]*$/iu
]);

const RESOLVED_PATTERN = /(?:восстановлена|восстановлены|восстановлено|восстановлен|исправлены|исправлена|исправлено|исправлен|устранены|устранена|устранено|устранён|устранен|завершены|завершена|завершено|завершён|завершен|закрыта|закрыто|закрыт|решены|решена|решено|решён)/giu;
const IN_PROGRESS_PATTERN = /(?:в работе|в процессе|идёт|идет|продолжается|продолжаются|проверяем|проверяют|расследуем|расследуется|диагностика|диагностируем|не восстановлены|не восстановлена|не восстановлено|не восстановлен|не решены|не решена|не решено|не завершены|не завершена|не завершено|не работает|уточняем)/giu;

const QUALITY_SYSTEM_PROMPT = [
  'Ты — аудитор качества данных массовых ИТ-инцидентов МТС.',
  'Анализируй только переданные поля кандидатов: не придумывай другие инциденты, пользователей, команды и события.',
  'Отделяй факт от гипотезы: evidence должен опираться на текст из полей кандидата.',
  'Ищи смысловые проблемы: решение не описывает устранение или противоречит описанию; статус противоречит тексту.',
  'Не повторяй формальные проблемы, которые уже ловятся правилами.',
  'Пиши по-русски, кратко и по делу.',
  'Ответ — только один JSON-объект без Markdown и текста вокруг.'
].join('\n');

class QualityAiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QualityAiError';
    this.status = 502;
    this.code = 'quality_ai_parse_failed';
  }
}

function normalizedText(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stateId(incident) {
  return Number.isInteger(incident.stateId) ? incident.stateId : null;
}

function hasGroup(incident, group) {
  return Array.isArray(incident.groups) && incident.groups.includes(group);
}

function stateKind(incident) {
  const current = stateId(incident);
  if (current === 0 || current === 2) return 'active';
  if (current === 20) return 'research';
  if (current === 7 || current === 10) return 'closed';
  if (hasGroup(incident, 'active')) return 'active';
  if (hasGroup(incident, 'research')) return 'research';
  if (hasGroup(incident, 'closed')) return 'closed';
  return 'unknown';
}

function isActive(incident) {
  return stateKind(incident) === 'active';
}

function statusLabel(incident) {
  const label = normalizedText(incident.status);
  if (label) return label;
  return STATES[stateId(incident)] || 'неизвестный статус';
}

function clip(value, max) {
  const text = normalizedText(value);
  return text.length > max ? text.slice(0, max) : text;
}

function isLetterAt(text, index) {
  if (index < 0 || index >= text.length) return false;
  return /\p{L}/u.test(text[index]);
}

function isNegated(text, start) {
  const before = text.slice(Math.max(0, start - 12), start);
  return /(?:не|ещё\s+не|еще\s+не)\s*$/iu.test(before);
}

function hasMeaningfulMatch(text, pattern) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isLetterAt(text, start - 1) || isLetterAt(text, end)) continue;
    if (isNegated(text, start)) continue;
    return true;
  }
  return false;
}

function descriptionSaysResolved(description) {
  const text = normalizedText(description).toLowerCase();
  return text ? hasMeaningfulMatch(text, RESOLVED_PATTERN) : false;
}

function descriptionSaysInProgress(description) {
  const text = normalizedText(description).toLowerCase();
  return text ? hasMeaningfulMatch(text, IN_PROGRESS_PATTERN) : false;
}

function isGenericSolution(solution) {
  const text = normalizedText(solution);
  if (!text) return null;
  if (text.length < GENERIC_SOLUTION_MIN_LENGTH) {
    return { short: true, text, length: text.length };
  }
  if (GENERIC_SOLUTION_PATTERNS.some(pattern => pattern.test(text))) {
    return { short: false, text, length: text.length };
  }
  return null;
}

function titleTokens(title) {
  const raw = normalizedText(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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

function severityRank(severity) {
  const index = SEVERITIES.indexOf(severity);
  return index === -1 ? SEVERITIES.length : index;
}

function compareFindings(a, b) {
  return severityRank(a.severity) - severityRank(b.severity)
    || String(a.rule).localeCompare(String(b.rule), 'ru')
    || String(a.caseId).localeCompare(String(b.caseId), 'ru')
    || String(a.id).localeCompare(String(b.id), 'ru');
}

function makeFinding({ rule, type, severity, incident, message, evidence, id, related }) {
  const finding = {
    id: id || rule + ':' + String(incident.caseId),
    rule,
    type,
    severity,
    caseId: String(incident.caseId),
    incidentId: incident.id === null || incident.id === undefined ? '' : String(incident.id),
    title: normalizedText(incident.title),
    priorityId: Number.isInteger(incident.priorityId) ? incident.priorityId : null,
    message,
    evidence
  };
  if (related) {
    finding.relatedCaseId = String(related.caseId);
    finding.relatedIncidentId = related.id === null || related.id === undefined ? '' : String(related.id);
    finding.relatedTitle = normalizedText(related.title);
  }
  return finding;
}

function caseFindings(incident, now) {
  const findings = [];
  const kind = stateKind(incident);
  const label = statusLabel(incident);
  const description = normalizedText(incident.description);
  const solution = normalizedText(incident.solution);

  if (kind === 'active') {
    if (!normalizedText(incident.team)) {
      findings.push(makeFinding({
        rule: 'team.missing',
        type: 'team',
        severity: 'high',
        incident,
        message: 'Активный инцидент без профильной команды',
        evidence: 'Статус: «' + label + '»; команда не назначена.'
      }));
    }
    if (!normalizedText(incident.coordinatorId) && !normalizedText(incident.coordinatorName)) {
      findings.push(makeFinding({
        rule: 'coordinator.missing',
        type: 'team',
        severity: 'medium',
        incident,
        message: 'Активный инцидент без координатора',
        evidence: 'Статус: «' + label + '»; координатор не назначен.'
      }));
    }
    if (solution) {
      findings.push(makeFinding({
        rule: 'solution.on_active',
        type: 'solution',
        severity: 'medium',
        incident,
        message: 'Решение указано у активного инцидента',
        evidence: 'Решение при статусе «' + label + '»: «' + clip(solution, 200) + '».'
      }));
    }
    if (description && descriptionSaysResolved(description)) {
      findings.push(makeFinding({
        rule: 'status.description_conflict',
        type: 'status',
        severity: 'medium',
        incident,
        message: 'Описание сообщает о решении, но инцидент ещё активен (статус «' + label + '»)',
        evidence: 'Описание: «' + clip(description, 200) + '».'
      }));
    }
  }

  if (kind === 'research' || kind === 'closed') {
    if (!solution) {
      findings.push(makeFinding({
        rule: 'solution.missing',
        type: 'solution',
        severity: 'high',
        incident,
        message: 'Нет решения для инцидента в статусе «' + label + '»',
        evidence: 'Статус: «' + label + '»; поле solution пустое.'
      }));
    } else {
      const generic = isGenericSolution(solution);
      if (generic) {
        findings.push(makeFinding({
          rule: 'solution.generic',
          type: 'solution',
          severity: 'medium',
          incident,
          message: generic.short
            ? 'Решение неинформативно: короче ' + GENERIC_SOLUTION_MIN_LENGTH + ' символов (' + generic.length + ')'
            : 'Решение шаблонное и не описывает устранение',
          evidence: 'Решение: «' + clip(generic.text, 200) + '».'
        }));
      }
    }
    if (kind === 'closed' && description && descriptionSaysInProgress(description)) {
      findings.push(makeFinding({
        rule: 'status.description_conflict',
        type: 'status',
        severity: 'medium',
        incident,
        message: 'Описание сообщает о продолжающейся работе, но инцидент закрыт (статус «' + label + '»)',
        evidence: 'Описание: «' + clip(description, 200) + '».'
      }));
    }
  }

  if (kind === 'active' || kind === 'research') {
    const dueAt = incident.dueAt === null || incident.dueAt === undefined || incident.dueAt === ''
      ? null
      : Number(incident.dueAt);
    if (Number.isFinite(dueAt) && dueAt < now && incident.isNeedUp !== true) {
      findings.push(makeFinding({
        rule: 'sla.overdue',
        type: 'sla',
        severity: 'high',
        incident,
        message: 'Срок SLA истёк, эскалация не зафиксирована',
        evidence: 'Срок: ' + new Date(dueAt).toISOString() + '; сейчас: ' + new Date(now).toISOString() + '; isNeedUp=false.'
      }));
    }
  }

  const emptyFields = [];
  if (!normalizedText(incident.product)) emptyFields.push(['product', 'продукт']);
  if (!normalizedText(incident.scenario)) emptyFields.push(['scenario', 'сценарий']);
  if (!normalizedText(incident.region)) emptyFields.push(['region', 'регион']);
  if (emptyFields.length) {
    const labels = emptyFields.map(item => item[1]).join(', ');
    findings.push(makeFinding({
      rule: 'field.missing',
      type: 'field',
      severity: 'low',
      incident,
      message: 'Не заполнены поля карточки: ' + labels,
      evidence: 'Пустые поля: ' + emptyFields.map(item => item[0]).join(', ') + '.'
    }));
  }

  return findings;
}

function duplicatePriority(a, b) {
  const rank = incident => {
    const kind = stateKind(incident);
    if (kind === 'active') return 0;
    if (kind === 'research') return 1;
    if (kind === 'closed') return 2;
    return 3;
  };
  const byRank = rank(a) - rank(b);
  if (byRank) return byRank;
  const byPriority = (Number.isInteger(b.priorityId) ? b.priorityId : 0) - (Number.isInteger(a.priorityId) ? a.priorityId : 0);
  if (byPriority) return byPriority;
  const byStarted = (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0);
  if (byStarted) return byStarted;
  return String(a.caseId).localeCompare(String(b.caseId), 'ru');
}

function duplicateFindings(cases) {
  const findings = [];
  const groups = new Map();
  for (const incident of cases) {
    const product = normalizedText(incident.product).toLowerCase();
    if (!product) continue;
    const region = normalizedText(incident.region).toLowerCase();
    const key = product + '|' + region;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(incident);
  }

  let pairs = 0;
  let comparisons = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const entries = group
      .map(incident => ({ incident, tokens: titleTokens(incident.title) }))
      .filter(entry => entry.tokens.size >= 2);
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (pairs >= MAX_DUPLICATE_PAIRS || findings.length >= MAX_FINDINGS) return findings;
        if (comparisons >= MAX_DUPLICATE_COMPARISONS) return findings;
        comparisons += 1;
        const left = entries[i].incident;
        const right = entries[j].incident;
        const similarity = jaccard(entries[i].tokens, entries[j].tokens);
        if (similarity < DUPLICATE_MIN_SIMILARITY) continue;
        pairs += 1;
        const primary = duplicatePriority(left, right) <= 0 ? left : right;
        const related = primary === left ? right : left;
        const openRelated = isActive(primary) || isActive(related)
          || stateKind(primary) === 'research' || stateKind(related) === 'research';
        const severity = similarity >= DUPLICATE_HIGH_SIMILARITY && openRelated ? 'high' : 'medium';
        const productLabel = normalizedText(primary.product);
        const regionLabel = normalizedText(primary.region) || 'не указан';
        findings.push(makeFinding({
          rule: 'duplicate.title',
          type: 'duplicate',
          severity,
          incident: primary,
          id: 'duplicate.title:' + String(primary.caseId) + ':' + String(related.caseId),
          message: 'Возможный дубликат: «' + normalizedText(related.title) + '» (' + String(related.id || related.caseId) + ').',
          evidence: 'Совпадение заголовков ' + Math.round(similarity * 100) + '% при общем продукте «' + productLabel + '» и регионе «' + regionLabel + '».',
          related
        }));
      }
    }
  }
  return findings;
}

function summarizeFindings(findings) {
  let penalty = 0;
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byType = {};
  for (const type of TYPES) byType[type] = 0;
  for (const finding of findings) {
    penalty += SEVERITY_WEIGHTS[finding.severity] || 0;
    if (Object.hasOwn(bySeverity, finding.severity)) bySeverity[finding.severity] += 1;
    if (Object.hasOwn(byType, finding.type)) byType[finding.type] += 1;
  }
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const status = score >= 85 ? 'good' : score >= 70 ? 'attention' : 'critical';
  return { score, status, byType, bySeverity };
}

function buildQualityReport(cases, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const list = (Array.isArray(cases) ? cases : [])
    .filter(incident => incident && typeof incident === 'object' && incident.caseId);
  const findings = [];
  for (const incident of list) findings.push(...caseFindings(incident, now));
  findings.push(...duplicateFindings(list));
  findings.sort(compareFindings);
  const summary = summarizeFindings(findings);
  return {
    score: summary.score,
    status: summary.status,
    byType: summary.byType,
    bySeverity: summary.bySeverity,
    scannedCases: list.length,
    truncated: findings.length > MAX_FINDINGS,
    findings: findings.slice(0, MAX_FINDINGS),
    source: 'rules',
    generatedAt: now
  };
}

function compareCandidates(a, b) {
  const rank = incident => {
    const kind = stateKind(incident);
    if (kind === 'active') return 0;
    if (kind === 'research') return 1;
    if (kind === 'closed') return 2;
    return 3;
  };
  return rank(a) - rank(b)
    || (Number.isInteger(b.priorityId) ? b.priorityId : 0) - (Number.isInteger(a.priorityId) ? a.priorityId : 0)
    || (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0)
    || String(a.caseId).localeCompare(String(b.caseId), 'ru');
}

function selectQualityCandidates(cases, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, MAX_AI_CASE_IDS)
    : AI_CANDIDATE_LIMIT;
  const filter = Array.isArray(options.caseIds) && options.caseIds.length
    ? new Set(options.caseIds.map(String))
    : null;
  const list = (Array.isArray(cases) ? cases : []).filter((incident) => {
    if (!incident || typeof incident !== 'object' || !incident.caseId) return false;
    if (filter && !filter.has(String(incident.caseId))) return false;
    return Boolean(normalizedText(incident.description) || normalizedText(incident.solution));
  });
  list.sort(compareCandidates);
  return list.slice(0, limit);
}

function buildQualityPrompt(candidates) {
  const payload = candidates.map(incident => ({
    caseId: String(incident.caseId),
    title: clip(incident.title, 300),
    description: clip(incident.description, 1200),
    product: normalizedText(incident.product),
    service: normalizedText(incident.service),
    scenario: normalizedText(incident.scenario),
    solution: clip(incident.solution, 800),
    status: statusLabel(incident)
  }));
  return [
    'Проверь качество данных по переданным кандидатам (только эти инциденты).',
    'Кандидаты:',
    JSON.stringify(payload),
    'Верни только JSON:',
    '{"issues":[{"caseId":"...","type":"solution|status","severity":"high|medium|low","message":"...","evidence":"..."}]}',
    'Правила:',
    '- caseId строго из списка кандидатов;',
    '- type=solution — решение отсутствует, неинформативно или не соответствует описанию;',
    '- type=status — статус противоречит тексту описания/решения;',
    '- evidence — цитата из полей кандидата, без выдуманных событий и чисел;',
    '- если проблем нет, верни {"issues":[]};',
    '- без Markdown, только JSON.'
  ].join('\n');
}

function stripAiPreamble(content) {
  return String(content === null || content === undefined ? '' : content)
    .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function cleanString(value, max) {
  if (typeof value !== 'string') return '';
  const text = normalizedText(value);
  return text ? text.slice(0, max) : '';
}

function parseQualityResponse(content, candidates = []) {
  let parsed;
  try {
    parsed = JSON.parse(stripAiPreamble(content));
  } catch {
    throw new QualityAiError('Модель вернула не JSON');
  }
  if (!isObject(parsed) || !Array.isArray(parsed.issues)) {
    throw new QualityAiError('Модель вернула некорректный ответ');
  }
  const known = new Set(candidates.map(incident => String(incident.caseId)));
  const issues = [];
  const seen = new Set();
  for (const raw of parsed.issues.slice(0, MAX_AI_ISSUES)) {
    if (!isObject(raw)) continue;
    const caseId = cleanString(raw.caseId, 200);
    if (!known.has(caseId)) continue;
    if (raw.type !== 'solution' && raw.type !== 'status') continue;
    if (raw.severity !== 'high' && raw.severity !== 'medium' && raw.severity !== 'low') continue;
    const message = cleanString(raw.message, 500);
    const evidence = cleanString(raw.evidence, 500);
    if (!message || !evidence) continue;
    const key = caseId + '|' + raw.type;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ caseId, type: raw.type, severity: raw.severity, message, evidence });
  }
  return issues;
}

function mergeQualityReport(report, issues, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const cases = Array.isArray(options.cases) ? options.cases : [];
  const caseMap = new Map(cases.map(incident => [String(incident.caseId), incident]));
  const existing = new Set(report.findings.map(finding => String(finding.caseId) + '|' + String(finding.type)));
  const usedIds = new Set(report.findings.map(finding => finding.id));
  const aiFindings = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const incident = caseMap.get(String(issue.caseId));
    if (!incident) continue;
    const key = String(issue.caseId) + '|' + String(issue.type);
    if (existing.has(key)) continue;
    if (issue.type !== 'solution' && issue.type !== 'status') continue;
    if (!Object.hasOwn(SEVERITY_WEIGHTS, issue.severity)) continue;
    if (!normalizedText(issue.message) || !normalizedText(issue.evidence)) continue;
    existing.add(key);
    let id = 'ai.' + issue.type + ':' + String(incident.caseId);
    let suffix = 2;
    while (usedIds.has(id)) {
      id = 'ai.' + issue.type + ':' + String(incident.caseId) + ':' + suffix;
      suffix += 1;
    }
    usedIds.add(id);
    aiFindings.push(makeFinding({
      id,
      rule: 'ai.' + issue.type,
      type: issue.type,
      severity: issue.severity,
      incident,
      message: normalizedText(issue.message).slice(0, 500),
      evidence: normalizedText(issue.evidence).slice(0, 500)
    }));
  }
  const findings = report.findings.concat(aiFindings).sort(compareFindings);
  const summary = summarizeFindings(findings);
  return {
    score: summary.score,
    status: summary.status,
    byType: summary.byType,
    bySeverity: summary.bySeverity,
    scannedCases: report.scannedCases,
    truncated: report.truncated || findings.length > MAX_FINDINGS,
    findings: findings.slice(0, MAX_FINDINGS),
    source: 'rules+ai',
    generatedAt: now,
    aiChecked: Number.isInteger(options.aiChecked) && options.aiChecked >= 0 ? options.aiChecked : 0
  };
}

function qualityCaseSignature(incident) {
  const digest = crypto.createHash('sha256')
    .update(normalizedText(incident.solution) + '\u0000' + normalizedText(incident.description))
    .digest('hex')
    .slice(0, 16);
  const version = Number.isInteger(incident.version) ? incident.version : 0;
  return String(incident.caseId) + ':' + version + ':' + digest;
}

module.exports = {
  AI_CANDIDATE_LIMIT,
  DUPLICATE_HIGH_SIMILARITY,
  DUPLICATE_MIN_SIMILARITY,
  GENERIC_SOLUTION_MIN_LENGTH,
  MAX_AI_CASE_IDS,
  MAX_FINDINGS,
  QUALITY_SYSTEM_PROMPT,
  QualityAiError,
  SEVERITIES,
  SEVERITY_WEIGHTS,
  TYPES,
  buildQualityPrompt,
  buildQualityReport,
  compareFindings,
  descriptionSaysInProgress,
  descriptionSaysResolved,
  isActive,
  isGenericSolution,
  jaccard,
  mergeQualityReport,
  parseQualityResponse,
  qualityCaseSignature,
  selectQualityCandidates,
  stateKind,
  summarizeFindings,
  titleTokens
};
