'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TriageAiError,
  buildDeterministicReport,
  buildTriagePrompt,
  findTriageCandidates,
  isFallbackCorrelationKey,
  isKeylessCase,
  normalizeSuggestedKey,
  parseTriageResponse
} = require('../lib/triage');
const { scanTriage } = require('../src/triage');

const NOW = Date.parse('2026-11-21T18:00:00.000Z');

function incident(overrides = {}) {
  return {
    caseId: 'case-a',
    id: 'INC-A',
    title: 'Деградация голосовой связи в Москве',
    description: 'Абоненты сообщают об обрывах голосовых вызовов при звонках.',
    product: 'Mobile voice',
    service: 'Голосовая связь',
    scenario: 'Звонок',
    region: 'Москва',
    stateId: 2,
    status: 'Выполняется',
    groups: ['active'],
    correlationKey: 'mobile-voice-moscow',
    priorityId: 4,
    startedAt: NOW - 2 * 3600000,
    affectedUsers: 100,
    version: 1,
    ...overrides
  };
}

function twin(overrides = {}) {
  return incident({
    caseId: 'case-b',
    id: 'INC-B',
    startedAt: NOW - 3600000,
    correlationKey: 'id:INC-B',
    ...overrides
  });
}

function partialTwin(overrides = {}) {
  return incident({
    caseId: 'case-p',
    id: 'INC-P',
    title: 'Сбой голосовой связи в Москве',
    description: 'Пользователи жалуются на обрывы голосовых вызовов',
    startedAt: NOW - 3600000,
    correlationKey: 'id:INC-P',
    ...overrides
  });
}

function reportKeys(report) {
  return Object.keys(report);
}

function fakeAi(handler) {
  const calls = [];
  return {
    calls,
    async complete(prompt, options) {
      calls.push({ prompt, options });
      return handler(prompt, options, calls.length);
    }
  };
}

// --- deterministic candidate finder ----------------------------------------

test('empty input is safe and returns the documented rules report', () => {
  const report = buildDeterministicReport([]);
  assert.deepEqual(reportKeys(report), [
    'suggestions', 'byType', 'byConfidence', 'scannedCases', 'candidatePairs',
    'keylessCases', 'truncated', 'source', 'generatedAt', 'aiChecked', 'aiSkipped'
  ]);
  assert.deepEqual(report.suggestions, []);
  assert.deepEqual(report.byType, { merge: 0, correlation_key: 0 });
  assert.deepEqual(report.byConfidence, { high: 0, medium: 0, low: 0 });
  assert.equal(report.scannedCases, 0);
  assert.equal(report.candidatePairs, 0);
  assert.equal(report.keylessCases, 0);
  assert.equal(report.truncated, false);
  assert.equal(report.source, 'rules');
  assert.equal(report.aiChecked, 0);
  assert.equal(report.aiSkipped, false);
  assert.equal(typeof report.generatedAt, 'number');
});

test('similar open cases produce one merge suggestion with the full contract', () => {
  const report = buildDeterministicReport([incident(), twin()], { now: NOW });
  assert.equal(report.suggestions.length, 1);
  const suggestion = report.suggestions[0];
  assert.deepEqual(Object.keys(suggestion), [
    'id', 'type', 'sourceCaseId', 'targetCaseId', 'caseId', 'suggestedKey',
    'confidence', 'rationale', 'evidence', 'sourceTitle', 'targetTitle', 'title',
    'sourceIncidentId', 'targetIncidentId', 'incidentId',
    'similarity', 'titleSimilarity', 'descriptionSimilarity'
  ]);
  assert.equal(suggestion.id, 'merge:case-a:case-b');
  assert.equal(suggestion.type, 'merge');
  assert.equal(suggestion.targetCaseId, 'case-a');
  assert.equal(suggestion.sourceCaseId, 'case-b');
  assert.equal(suggestion.caseId, 'case-b');
  assert.equal(suggestion.suggestedKey, null);
  assert.equal(suggestion.confidence, 'high');
  assert.equal(suggestion.title, 'Деградация голосовой связи в Москве');
  assert.equal(suggestion.sourceTitle, suggestion.title);
  assert.equal(suggestion.sourceIncidentId, 'INC-B');
  assert.equal(suggestion.targetIncidentId, 'INC-A');
  assert.equal(suggestion.incidentId, 'INC-B');
  assert.equal(suggestion.similarity, 1);
  assert.equal(suggestion.titleSimilarity, 1);
  assert.equal(suggestion.descriptionSimilarity, 1);
  assert.match(suggestion.rationale, /Одинаковые продукт/);
  assert.match(suggestion.evidence, /Разница старта/);
  assert.deepEqual(report.byType, { merge: 1, correlation_key: 0 });
  assert.deepEqual(report.byConfidence, { high: 1, medium: 0, low: 0 });
  assert.equal(report.candidatePairs, 1);
  assert.equal(report.truncated, false);
});

test('demo semantic twin with different wording is still a candidate', () => {
  const first = incident({
    caseId: 'twin-1',
    id: 'MTS-MOBILE-0001',
    title: 'Деградация голосовой связи в Москве',
    description: 'Деградация распространилась на несколько коммутаторов. Зафиксирован массовый рост неуспешных вызовов, включён аварийный контур мониторинга.',
    service: 'Голосовая связь',
    scenario: 'Установление голосового соединения',
    correlationKey: 'mobile-voice-moscow-outage',
    startedAt: NOW - 2 * 3600000,
    affectedUsers: 1000
  });
  const second = incident({
    caseId: 'twin-2',
    id: 'MTS-MOBILE-0002',
    title: 'Обрывы голосовых вызовов в Москве',
    description: 'Абоненты сообщают о обрывах и невозможности установить голосовое соединение. Поток жалоб из Москвы продолжает расти, мониторинг фиксирует неуспешные вызовы.',
    product: 'Mobile voice',
    service: 'Голосовая связь',
    scenario: 'Установление голосового соединения',
    region: 'Москва',
    correlationKey: 'mobile-voice-moscow-regional',
    startedAt: NOW - 3600000,
    affectedUsers: 40
  });
  const report = buildDeterministicReport([first, second], { now: NOW });
  assert.equal(report.suggestions.length, 1);
  assert.equal(report.suggestions[0].targetCaseId, 'twin-1');
  assert.equal(report.suggestions[0].sourceCaseId, 'twin-2');
  assert.equal(report.suggestions[0].confidence, 'medium');
  assert.match(report.suggestions[0].rationale, /совпадают сервис и сценарий/);
});

test('pairs require same open kind, product, region and a close start time', () => {
  const base = incident();
  const differentProduct = buildDeterministicReport([base, twin({ product: 'SMS' })], { now: NOW });
  assert.equal(differentProduct.candidatePairs, 0);

  const differentRegion = buildDeterministicReport([base, twin({ region: 'Санкт-Петербург' })], { now: NOW });
  assert.equal(differentRegion.candidatePairs, 0);

  const mixedKind = buildDeterministicReport([base, twin({ stateId: 20, status: 'Исследование ситуации', groups: ['research'] })], { now: NOW });
  assert.equal(mixedKind.candidatePairs, 0);

  const closed = buildDeterministicReport([base, twin({ stateId: 10, status: 'Закрыт', groups: ['closed'] })], { now: NOW });
  assert.equal(closed.candidatePairs, 0);

  const old = buildDeterministicReport([base, twin({ startedAt: NOW - 48 * 3600000 })], { now: NOW });
  assert.equal(old.candidatePairs, 0);
  const wide = buildDeterministicReport([base, twin({ startedAt: NOW - 48 * 3600000 })], {
    now: NOW, windowMs: 72 * 3600000
  });
  assert.equal(wide.candidatePairs, 1);

  const emptyProduct = buildDeterministicReport([base, twin({ product: '' })], { now: NOW });
  assert.equal(emptyProduct.candidatePairs, 0);

  const dissimilar = buildDeterministicReport([base, twin({
    title: 'Сбой доставки SMS в Бишкеке',
    description: 'Сообщения приходят с задержкой несколько минут'
  })], { now: NOW });
  assert.equal(dissimilar.candidatePairs, 0);
});

test('research+research pairs are allowed while closed cases are not', () => {
  const left = incident({
    caseId: 'res-1', id: 'INC-R1', stateId: 20, status: 'Исследование ситуации', groups: ['research'],
    correlationKey: 'id:INC-R1'
  });
  const right = incident({
    caseId: 'res-2', id: 'INC-R2', stateId: 20, status: 'Исследование ситуации', groups: ['research'],
    correlationKey: 'res-2-key', startedAt: NOW - 3600000
  });
  const report = buildDeterministicReport([left, right], { now: NOW });
  assert.equal(report.candidatePairs, 1);
  assert.equal(report.suggestions[0].targetCaseId, 'res-1');
});

test('merge target is the older case, then the larger case, regardless of input order', () => {
  const older = incident({ caseId: 'older', id: 'INC-OLD', startedAt: NOW - 4 * 3600000, affectedUsers: 10 });
  const newer = incident({ caseId: 'newer', id: 'INC-NEW', startedAt: NOW - 3600000, affectedUsers: 900 });
  const report = buildDeterministicReport([newer, older], { now: NOW });
  assert.equal(report.suggestions[0].targetCaseId, 'older');
  assert.equal(report.suggestions[0].sourceCaseId, 'newer');

  const sameStartLeft = incident({ caseId: 'tie-a', id: 'INC-TA', startedAt: NOW - 3600000, affectedUsers: 10 });
  const sameStartRight = incident({ caseId: 'tie-b', id: 'INC-TB', startedAt: NOW - 3600000, affectedUsers: 700 });
  const tie = buildDeterministicReport([sameStartLeft, sameStartRight], { now: NOW });
  assert.equal(tie.suggestions[0].targetCaseId, 'tie-b');
});

test('keyless open cases are counted and closed keyless cases are ignored', () => {
  const cases = [
    incident({ caseId: 'keyless-active', correlationKey: 'id:INC-KA' }),
    incident({ caseId: 'keyless-research', stateId: 20, status: 'Исследование ситуации', groups: ['research'], correlationKey: '' }),
    incident({ caseId: 'keyed', correlationKey: 'normal-key' }),
    incident({ caseId: 'keyless-closed', stateId: 10, status: 'Закрыт', groups: ['closed'], correlationKey: 'id:INC-KC' })
  ];
  const report = buildDeterministicReport(cases, { now: NOW });
  assert.equal(report.keylessCases, 2);
  assert.equal(isKeylessCase(cases[0]), true);
  assert.equal(isKeylessCase(cases[1]), true);
  assert.equal(isKeylessCase(cases[2]), false);
  assert.equal(isKeylessCase(cases[3]), false);
  assert.equal(isFallbackCorrelationKey('id:xxx'), true);
  assert.equal(isFallbackCorrelationKey(''), true);
  assert.equal(isFallbackCorrelationKey('some-key'), false);
});

test('caseIds filter and maxSuggestions truncation are respected', () => {
  const outside = incident({
    caseId: 'outside', id: 'INC-OUT', title: 'Полностью другой заголовок',
    description: 'Посторонний текст', product: 'KION', startedAt: NOW - 3600000
  });
  const filtered = buildDeterministicReport([incident(), twin(), outside], {
    now: NOW, caseIds: ['case-a', 'case-b']
  });
  assert.equal(filtered.scannedCases, 2);
  assert.equal(filtered.candidatePairs, 1);

  const third = incident({ caseId: 'case-c', id: 'INC-C', startedAt: NOW - 1800000 });
  const truncated = buildDeterministicReport([incident(), twin(), third], {
    now: NOW, maxSuggestions: 2
  });
  assert.equal(truncated.candidatePairs, 3);
  assert.equal(truncated.suggestions.length, 2);
  assert.equal(truncated.truncated, true);
});

// --- AI prompt --------------------------------------------------------------

test('AI prompt contains only candidate summaries and the strict schema', () => {
  const outside = incident({
    caseId: 'outside', id: 'INC-OUT', title: 'Посторонний заголовок', description: 'Посторонний текст',
    product: 'KION', coordinatorName: 'Секретный Координатор', team: 'Секретная команда'
  });
  const candidates = findTriageCandidates([incident(), twin(), outside], {});
  const prompt = buildTriagePrompt({
    pairs: candidates.pairs,
    keylessCases: candidates.keyless
  });
  assert.match(prompt, /case-a/);
  assert.match(prompt, /case-b/);
  assert.match(prompt, /Деградация голосовой связи в Москве/);
  assert.match(prompt, /"suggestions"/);
  assert.match(prompt, /correlation_key/);
  assert.match(prompt, /suggestedKey/);
  assert.doesNotMatch(prompt, /Посторонний заголовок/);
  assert.doesNotMatch(prompt, /Секретный Координатор/);
  assert.doesNotMatch(prompt, /Секретная команда/);
  assert.doesNotMatch(prompt, /coordinatorName/);
});

// --- AI parsing and validation ---------------------------------------------

test('AI parser canonicalizes IDs, normalizes keys and dedupes suggestions', () => {
  const candidates = findTriageCandidates([incident(), twin()], {});
  const content = JSON.stringify({
    suggestions: [
      { type: 'merge', sourceCaseId: 'case-a', targetCaseId: 'case-b', confidence: 'medium', rationale: 'Первый вариант', evidence: 'e1' },
      { type: 'merge', sourceCaseId: 'case-b', targetCaseId: 'case-a', confidence: 'high', rationale: 'Лучший вариант', evidence: 'e2' },
      { type: 'correlation_key', caseId: 'case-b', suggestedKey: 'Mobile Voice Moscow!', confidence: 0.9, rationale: 'Нет ключа', evidence: 'correlationKey=id:INC-B' },
      { type: 'correlation_key', caseId: 'case-a', suggestedKey: 'wrong-case', confidence: 'high', rationale: 'не keyless', evidence: 'x' },
      { type: 'correlation_key', caseId: 'case-b', suggestedKey: 'id:bad', confidence: 'high', rationale: 'плохой ключ', evidence: 'x' }
    ]
  });
  const suggestions = parseTriageResponse(content, candidates);
  assert.equal(suggestions.length, 2);

  const merge = suggestions.find(item => item.type === 'merge');
  assert.equal(merge.pairKey, 'case-a|case-b');
  assert.equal(merge.sourceCaseId, 'case-b');
  assert.equal(merge.targetCaseId, 'case-a');
  assert.equal(merge.confidence, 'high');
  assert.equal(merge.rationale, 'Лучший вариант');
  assert.equal(merge.evidence, 'e2');

  const key = suggestions.find(item => item.type === 'correlation_key');
  assert.equal(key.caseId, 'case-b');
  assert.equal(key.suggestedKey, 'mobile-voice-moscow');
  assert.equal(key.confidence, 'high');
});

test('AI parser drops invalid types, IDs, confidence and strings', () => {
  const candidates = findTriageCandidates([incident(), twin()], {});
  const content = JSON.stringify({
    suggestions: [
      { type: 'team', sourceCaseId: 'case-a', targetCaseId: 'case-b', confidence: 'high', rationale: 'm', evidence: 'e' },
      { type: 'merge', sourceCaseId: 'case-a', targetCaseId: 'unknown', confidence: 'high', rationale: 'm', evidence: 'e' },
      { type: 'merge', sourceCaseId: 'case-a', targetCaseId: 'case-a', confidence: 'high', rationale: 'm', evidence: 'e' },
      { type: 'merge', sourceCaseId: 'case-a', targetCaseId: 'case-b', confidence: 'urgent', rationale: 'm', evidence: 'e' },
      { type: 'merge', sourceCaseId: 'case-a', targetCaseId: 'case-b', confidence: 'high', rationale: '', evidence: 'e' },
      { type: 'correlation_key', caseId: 'case-b', suggestedKey: '', confidence: 'high', rationale: 'm', evidence: 'e' },
      { type: 'correlation_key', caseId: 'case-b', suggestedKey: 'id:bad', confidence: 'high', rationale: 'm', evidence: 'e' },
      { type: 'correlation_key', caseId: 'unknown', suggestedKey: 'good-key', confidence: 'high', rationale: 'm', evidence: 'e' },
      null,
      'bad'
    ]
  });
  assert.deepEqual(parseTriageResponse(content, candidates), []);
});

test('AI parser accepts fenced JSON, top-level arrays and item wrappers', () => {
  const candidates = findTriageCandidates([incident(), twin()], {});
  const suggestion = { type: 'merge', sourceCaseId: 'case-a', targetCaseId: 'case-b', confidence: 'high', rationale: 'm', evidence: 'e' };
  const fence = '\u0060\u0060\u0060';
  const fenced = fence + 'json\n' + JSON.stringify({ suggestions: [suggestion] }) + '\n' + fence;
  assert.equal(parseTriageResponse(fenced, candidates).length, 1);
  assert.equal(parseTriageResponse(JSON.stringify([suggestion]), candidates).length, 1);
  assert.equal(parseTriageResponse(JSON.stringify({ items: [suggestion] }), candidates).length, 1);
});

test('AI parser rejects malformed output', () => {
  assert.throws(() => parseTriageResponse('not json', {}), TriageAiError);
  assert.throws(() => parseTriageResponse(JSON.stringify({ suggestions: 'no' }), {}), TriageAiError);
  assert.throws(() => parseTriageResponse(JSON.stringify({ ok: true }), {}), (error) => {
    assert.ok(error instanceof TriageAiError);
    assert.equal(error.code, 'triage_ai_parse_failed');
    return true;
  });
});

test('suggested key normalization emits store-safe slugs', () => {
  assert.equal(normalizeSuggestedKey('Mobile Voice Moscow!'), 'mobile-voice-moscow');
  assert.equal(normalizeSuggestedKey('  MTS_ID: auth  '), 'mts_id-auth');
  assert.equal(normalizeSuggestedKey('id:abc'), null);
  assert.equal(normalizeSuggestedKey('ГОЛОС'), null);
  assert.equal(normalizeSuggestedKey(''), null);
});

// --- scanTriage -------------------------------------------------------------

test('scanTriage returns rules with aiSkipped when AI is disabled', async () => {
  const ai = fakeAi(() => { throw new Error('must not be called'); });
  const result = await scanTriage(ai, [incident(), twin()], { aiEnabled: false, now: NOW });
  assert.equal(ai.calls.length, 0);
  assert.equal(result.source, 'rules');
  assert.equal(result.aiChecked, 0);
  assert.equal(result.aiSkipped, true);
  assert.equal(result.suggestions.length, 1);
});

test('scanTriage falls back to rules when the AI call or parsing fails', async () => {
  const failing = fakeAi(() => { throw new Error('timeout'); });
  const fallback = await scanTriage(failing, [incident(), twin()], { aiEnabled: true, now: NOW });
  assert.equal(failing.calls.length, 1);
  assert.equal(fallback.source, 'rules');
  assert.equal(fallback.aiChecked, 0);
  assert.equal(fallback.aiSkipped, true);
  assert.equal(fallback.suggestions.length, 1);

  const malformed = fakeAi(() => 'not json');
  const parsedFallback = await scanTriage(malformed, [incident(), twin()], { aiEnabled: true, now: NOW });
  assert.equal(parsedFallback.source, 'rules');
  assert.equal(parsedFallback.aiSkipped, true);
});

test('scanTriage merges AI suggestions, refines confidence and adds correlation keys', async () => {
  const first = incident({ caseId: 'scan-a', id: 'INC-SA', startedAt: NOW - 2 * 3600000 });
  const second = partialTwin({ caseId: 'scan-b', id: 'INC-SB', startedAt: NOW - 3600000 });
  const deterministic = buildDeterministicReport([first, second], { now: NOW });
  assert.equal(deterministic.suggestions[0].confidence, 'medium');

  const ai = fakeAi(() => JSON.stringify({
    suggestions: [
      { type: 'merge', sourceCaseId: 'scan-b', targetCaseId: 'scan-a', confidence: 'high', rationale: 'AI: это один инцидент', evidence: 'Заголовки почти совпадают' },
      { type: 'correlation_key', caseId: 'scan-b', suggestedKey: 'Mobile Voice Moscow', confidence: 'medium', rationale: 'Ключ отсутствует', evidence: 'correlationKey=id:INC-SB' }
    ]
  }));
  const result = await scanTriage(ai, [first, second], { aiEnabled: true, timeoutMs: 4321, now: NOW });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].options.timeoutMs, 4321);
  assert.equal(result.source, 'rules+ai');
  assert.equal(result.aiChecked, 2);
  assert.equal(result.aiSkipped, false);
  assert.equal(result.suggestions.length, 2);

  const merge = result.suggestions.find(item => item.type === 'merge');
  assert.equal(merge.targetCaseId, 'scan-a');
  assert.equal(merge.sourceCaseId, 'scan-b');
  assert.equal(merge.confidence, 'high');
  assert.equal(merge.rationale, 'AI: это один инцидент');
  assert.equal(merge.evidence, 'Заголовки почти совпадают');

  const key = result.suggestions.find(item => item.type === 'correlation_key');
  assert.equal(key.caseId, 'scan-b');
  assert.equal(key.suggestedKey, 'mobile-voice-moscow');
  assert.equal(key.id, 'correlation_key:scan-b');
  assert.equal(key.sourceCaseId, null);
  assert.equal(key.targetCaseId, null);
  assert.equal(key.sourceTitle, null);
  assert.equal(key.targetTitle, null);
  assert.equal(key.sourceIncidentId, null);
  assert.equal(key.targetIncidentId, null);
  assert.equal(key.title, 'Сбой голосовой связи в Москве');
  assert.equal(key.incidentId, 'INC-SB');
  assert.deepEqual(result.byType, { merge: 1, correlation_key: 1 });
  assert.deepEqual(result.byConfidence, { high: 1, medium: 1, low: 0 });
});

test('scanTriage does not call AI when there are no candidates', async () => {
  const ai = fakeAi(() => { throw new Error('must not be called'); });
  const keyed = incident({ correlationKey: 'keyed' });
  const result = await scanTriage(ai, [keyed], { aiEnabled: true, now: NOW });
  assert.equal(ai.calls.length, 0);
  assert.equal(result.source, 'rules');
  assert.equal(result.aiChecked, 0);
  assert.equal(result.aiSkipped, false);
  assert.deepEqual(result.suggestions, []);
});

test('scanTriage filters AI suggestions against candidate whitelist', async () => {
  const first = incident({ caseId: 'safe-a', id: 'INC-SA' });
  const second = twin({ caseId: 'safe-b', id: 'INC-SB' });
  const ai = fakeAi(() => JSON.stringify({
    suggestions: [
      { type: 'merge', sourceCaseId: 'safe-a', targetCaseId: 'outside', confidence: 'high', rationale: 'm', evidence: 'e' },
      { type: 'correlation_key', caseId: 'outside', suggestedKey: 'outside-key', confidence: 'high', rationale: 'm', evidence: 'e' }
    ]
  }));
  const result = await scanTriage(ai, [first, second], { aiEnabled: true, now: NOW });
  assert.equal(result.source, 'rules+ai');
  assert.equal(result.aiChecked, 2);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].type, 'merge');
  assert.equal(result.suggestions[0].targetCaseId, 'safe-a');
});
