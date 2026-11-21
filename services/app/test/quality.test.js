'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const {
  QualityAiError,
  buildQualityPrompt,
  buildQualityReport,
  descriptionSaysInProgress,
  descriptionSaysResolved,
  isGenericSolution,
  mergeQualityReport,
  parseQualityResponse,
  selectQualityCandidates,
  summarizeFindings
} = require('../lib/quality');
const { clearQualityAiCache, scanQuality } = require('../src/quality');

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const APP_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(APP_ROOT, '../..');
const MOCK_ROOT = path.join(REPOSITORY_ROOT, 'services/itsm-mock');
const VALID_SOLUTION = 'Откатили конфигурацию CDN на стабильную версию, воспроизведение видео восстановлено.';

beforeEach(() => clearQualityAiCache());

function incident(overrides = {}) {
  return {
    caseId: 'case-1',
    id: 'INC-1',
    title: 'Деградация голосовой связи в Москве',
    description: 'Пользователи сообщают об обрывах голосовых вызовов.',
    product: 'Mobile voice',
    service: 'Голосовая связь',
    scenario: 'Звонок',
    region: 'Москва',
    priorityId: 4,
    priorityText: 'Наивысший',
    stateId: 2,
    status: 'Выполняется',
    team: 'МТС ИТ Поддержка Mobile voice',
    coordinatorId: 'user-1',
    coordinatorName: 'Иван',
    groups: ['active'],
    dueAt: null,
    resolvedAt: null,
    solution: null,
    isNeedUp: false,
    version: 1,
    startedAt: 1000,
    ...overrides
  };
}

function closedIncident(overrides = {}) {
  return incident({
    caseId: 'case-closed',
    id: 'INC-CLOSED',
    title: 'Сбой доставки SMS',
    product: 'SMS',
    stateId: 10,
    status: 'Закрыт',
    groups: ['closed'],
    description: 'Наблюдалась задержка доставки SMS с кодами подтверждения.',
    solution: VALID_SOLUTION,
    ...overrides
  });
}

function rulesOf(report) {
  return report.findings.map(finding => finding.rule);
}

function build(cases, now = NOW) {
  return buildQualityReport(cases, { now });
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

// --- deterministic rules ----------------------------------------------------

test('clean case produces an empty good report with the documented contract', () => {
  const report = build([incident()]);
  assert.deepEqual(Object.keys(report), [
    'score', 'status', 'byType', 'bySeverity', 'scannedCases', 'truncated', 'findings', 'source', 'generatedAt'
  ]);
  assert.equal(report.score, 100);
  assert.equal(report.status, 'good');
  assert.deepEqual(report.bySeverity, { high: 0, medium: 0, low: 0 });
  assert.deepEqual(report.byType, { team: 0, solution: 0, duplicate: 0, status: 0, field: 0, sla: 0 });
  assert.equal(report.scannedCases, 1);
  assert.equal(report.truncated, false);
  assert.deepEqual(report.findings, []);
  assert.equal(report.source, 'rules');
  assert.equal(report.generatedAt, NOW);
});

test('finding objects follow the UI contract', () => {
  const report = build([incident({ team: null })]);
  const finding = report.findings[0];
  assert.deepEqual(Object.keys(finding), [
    'id', 'rule', 'type', 'severity', 'caseId', 'incidentId', 'title', 'priorityId', 'message', 'evidence'
  ]);
  assert.equal(finding.id, 'team.missing:case-1');
  assert.equal(finding.type, 'team');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.caseId, 'case-1');
  assert.equal(finding.incidentId, 'INC-1');
  assert.equal(finding.priorityId, 4);
  assert.match(finding.message, /без профильной команды/);
  assert.match(finding.evidence, /команда не назначена/);
});

test('active without team is high and active without coordinator is medium', () => {
  const withoutTeam = build([incident({ team: null })]);
  assert.deepEqual(rulesOf(withoutTeam), ['team.missing']);
  assert.equal(withoutTeam.score, 88);
  assert.equal(withoutTeam.status, 'good');

  const withoutBoth = build([incident({ team: null, coordinatorId: null, coordinatorName: null })]);
  assert.deepEqual(rulesOf(withoutBoth).sort(), ['coordinator.missing', 'team.missing']);
  assert.equal(withoutBoth.score, 82);
  assert.equal(withoutBoth.status, 'attention');
  assert.equal(withoutBoth.byType.team, 2);
});

test('research and closed cases require a solution', () => {
  const research = build([incident({
    stateId: 20, status: 'Исследование ситуации', groups: ['research'], solution: null
  })]);
  assert.deepEqual(rulesOf(research), ['solution.missing']);
  assert.equal(research.findings[0].severity, 'high');

  const closed = build([closedIncident({ solution: null })]);
  assert.deepEqual(rulesOf(closed), ['solution.missing']);
  assert.equal(closed.score, 88);
});

test('generic or short solutions are medium findings', () => {
  const short = build([closedIncident({ solution: 'Решено' })]);
  assert.deepEqual(rulesOf(short), ['solution.generic']);
  assert.equal(short.findings[0].severity, 'medium');
  assert.match(short.findings[0].message, /короче 40 символов/);

  const placeholder = build([closedIncident({ solution: 'без деталей' })]);
  assert.deepEqual(rulesOf(placeholder), ['solution.generic']);
  assert.equal(placeholder.score, 94);

  assert.equal(isGenericSolution(VALID_SOLUTION), null);
  assert.equal(isGenericSolution('Решено').short, true);
  assert.ok(isGenericSolution('N/A'));
});

test('solution on an active case is medium', () => {
  const report = build([incident({ solution: VALID_SOLUTION })]);
  assert.deepEqual(rulesOf(report), ['solution.on_active']);
  assert.equal(report.findings[0].type, 'solution');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.score, 94);
});

test('missing product, scenario or region is a single low finding', () => {
  const report = build([closedIncident({ product: '', scenario: '', region: '' })]);
  assert.deepEqual(rulesOf(report), ['field.missing']);
  assert.equal(report.findings[0].severity, 'low');
  assert.equal(report.findings[0].type, 'field');
  assert.match(report.findings[0].message, /продукт, сценарий, регион/);
  assert.equal(report.score, 98);
  assert.equal(report.status, 'good');
});

test('description/status conflicts are detected in both directions', () => {
  assert.equal(descriptionSaysResolved('Проблема решена, сервис восстановлен.'), true);
  assert.equal(descriptionSaysResolved('Проблема не решена, работы продолжаются.'), false);
  assert.equal(descriptionSaysInProgress('Инженеры проверяют кластер, работы продолжаются.'), true);

  const active = build([incident({ description: 'Проблема решена, сервис восстановлен.' })]);
  assert.deepEqual(rulesOf(active), ['status.description_conflict']);
  assert.equal(active.findings[0].severity, 'medium');
  assert.match(active.findings[0].message, /ещё активен/);

  const closed = build([closedIncident({ description: 'Инженеры проверяют кластер, работы продолжаются.' })]);
  assert.deepEqual(rulesOf(closed), ['status.description_conflict']);
  assert.match(closed.findings[0].message, /закрыт/);

  const negated = build([incident({ description: 'Проблема не решена, работы продолжаются.' })]);
  assert.deepEqual(rulesOf(negated), []);
  assert.equal(negated.score, 100);
});

test('overdue SLA without escalation is high, escalated and null deadlines are skipped', () => {
  const overdue = build([incident({ dueAt: NOW - 60000 })]);
  assert.deepEqual(rulesOf(overdue), ['sla.overdue']);
  assert.equal(overdue.findings[0].severity, 'high');
  assert.equal(overdue.findings[0].type, 'sla');

  assert.deepEqual(rulesOf(build([incident({ dueAt: NOW - 60000, isNeedUp: true })])), []);
  assert.deepEqual(rulesOf(build([incident({ dueAt: null })])), []);
  assert.deepEqual(rulesOf(build([closedIncident({ dueAt: NOW - 60000 })])), []);
});

test('duplicates require matching product/region and title Jaccard', () => {
  const first = incident({
    caseId: 'dup-1', id: 'INC-DUP-1', title: 'Деградация голосовой связи в Москве', startedAt: 1001
  });
  const second = incident({
    caseId: 'dup-2', id: 'INC-DUP-2', title: 'Деградация голосовой связи в Москве', startedAt: 1002
  });
  const report = build([first, second]);
  const duplicates = report.findings.filter(finding => finding.type === 'duplicate');
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].rule, 'duplicate.title');
  assert.equal(duplicates[0].severity, 'high');
  assert.ok(duplicates[0].relatedCaseId);
  assert.ok(duplicates[0].relatedIncidentId);
  assert.ok(duplicates[0].relatedTitle);
  assert.match(duplicates[0].evidence, /общем продукте/);
  assert.equal(report.score, 88);

  const otherRegion = build([first, incident({
    caseId: 'dup-3', id: 'INC-DUP-3', region: 'Санкт-Петербург',
    title: 'Деградация голосовой связи в Москве', startedAt: 1003
  })]);
  assert.equal(otherRegion.findings.filter(finding => finding.type === 'duplicate').length, 0);

  const closedPair = build([
    closedIncident({ caseId: 'cdn-1', id: 'INC-CDN-1', title: 'Сбой доставки SMS' }),
    closedIncident({ caseId: 'cdn-2', id: 'INC-CDN-2', title: 'Сбой доставки SMS' })
  ]);
  const closedDuplicate = closedPair.findings.find(finding => finding.type === 'duplicate');
  assert.equal(closedDuplicate.severity, 'medium');
  assert.equal(closedPair.score, 94);
});

// --- scoring ----------------------------------------------------------------

test('score uses 12/6/2 weights, clamps to 0..100 and maps statuses', () => {
  assert.deepEqual(summarizeFindings([]), {
    score: 100,
    status: 'good',
    byType: { team: 0, solution: 0, duplicate: 0, status: 0, field: 0, sla: 0 },
    bySeverity: { high: 0, medium: 0, low: 0 }
  });
  assert.equal(summarizeFindings([{ severity: 'high', type: 'team' }]).score, 88);
  assert.equal(summarizeFindings([{ severity: 'high', type: 'team' }]).status, 'good');
  assert.equal(summarizeFindings([
    { severity: 'high', type: 'team' }, { severity: 'medium', type: 'solution' }
  ]).score, 82);
  assert.equal(summarizeFindings([
    { severity: 'high', type: 'team' }, { severity: 'medium', type: 'solution' }
  ]).status, 'attention');
  assert.equal(summarizeFindings([
    { severity: 'high', type: 'team' }, { severity: 'high', type: 'sla' }, { severity: 'high', type: 'status' }
  ]).score, 64);
  assert.equal(summarizeFindings([
    { severity: 'high', type: 'team' }, { severity: 'high', type: 'sla' }, { severity: 'high', type: 'status' }
  ]).status, 'critical');
  assert.equal(summarizeFindings([{ severity: 'low', type: 'field' }]).score, 98);
  assert.equal(summarizeFindings(Array.from({ length: 9 }, () => ({ severity: 'high', type: 'team' }))).score, 0);
});

test('report truncates findings above the cap but scores every finding', () => {
  const cases = Array.from({ length: 210 }, (_, index) => incident({
    caseId: 'bulk-' + index,
    id: 'INC-BULK-' + index,
    title: 'Уникальный сбой номер ' + index + ' в сегменте ' + index,
    product: 'Продукт ' + index,
    team: null,
    coordinatorId: 'user-1',
    coordinatorName: 'Иван'
  }));
  const report = build(cases);
  assert.equal(report.scannedCases, 210);
  assert.equal(report.truncated, true);
  assert.equal(report.findings.length, 200);
  assert.equal(report.bySeverity.high, 210);
  assert.equal(report.score, 0);
  assert.equal(report.status, 'critical');
});

// --- AI candidates and prompt ----------------------------------------------

test('AI candidates need description or solution, honor caseIds and the limit', () => {
  const activeHigh = incident({ caseId: 'cand-a', title: 'A', priorityId: 4, description: 'Описание A' });
  const activeLow = incident({ caseId: 'cand-b', title: 'B', priorityId: 2, description: 'Описание B' });
  const closed = closedIncident({ caseId: 'cand-c', title: 'C', priorityId: 4, startedAt: 500 });
  const empty = incident({ caseId: 'cand-d', title: 'D', description: '', solution: null });
  const candidates = selectQualityCandidates([closed, activeLow, empty, activeHigh], { limit: 2 });
  assert.deepEqual(candidates.map(item => item.caseId), ['cand-a', 'cand-b']);

  const filtered = selectQualityCandidates([closed, activeLow, empty, activeHigh], {
    caseIds: ['cand-c', 'cand-b'], limit: 5
  });
  assert.deepEqual(filtered.map(item => item.caseId), ['cand-b', 'cand-c']);

  const many = Array.from({ length: 10 }, (_, index) => incident({
    caseId: 'many-' + index, title: 'T' + index, description: 'Описание ' + index
  }));
  assert.equal(selectQualityCandidates(many).length, 8);
});

test('AI prompt contains only candidate case fields and no other incidents or people', () => {
  const candidate = incident({
    caseId: 'prompt-case',
    id: 'INC-PROMPT',
    title: 'Сбой входа в приложение',
    description: 'Пользователи не могут войти в приложение.',
    product: 'МТС ID',
    service: 'Аутентификация',
    scenario: 'Вход',
    solution: '',
    coordinatorName: 'Секретный Координатор',
    team: 'Секретная команда'
  });
  const prompt = buildQualityPrompt([candidate]);
  assert.match(prompt, /prompt-case/);
  assert.match(prompt, /Сбой входа в приложение/);
  assert.match(prompt, /МТС ID/);
  assert.match(prompt, /Выполняется/);
  assert.match(prompt, /"issues"/);
  assert.doesNotMatch(prompt, /Секретный Координатор/);
  assert.doesNotMatch(prompt, /Секретная команда/);
  assert.doesNotMatch(prompt, /coordinatorName/);
  assert.doesNotMatch(prompt, /INC-OTHER/);
});

// --- AI parsing, merging, fallback and caching -----------------------------

test('AI response parser validates caseId/type/severity/strings and dedupes', () => {
  const candidates = [incident({ caseId: 'ai-1' }), incident({ caseId: 'ai-2' })];
  const fence = '\u0060\u0060\u0060';
  const content = fence + 'json\n' + JSON.stringify({
    issues: [
      { caseId: 'ai-1', type: 'solution', severity: 'high', message: '  Не описано устранение ', evidence: ' Описание A ' },
      { caseId: 'ai-1', type: 'status', severity: 'medium', message: 'Дубль', evidence: 'x' },
      { caseId: 'ai-1', type: 'status', severity: 'high', message: 'Дубль', evidence: 'x' },
      { caseId: 'unknown', type: 'solution', severity: 'high', message: 'm', evidence: 'e' },
      { caseId: 'ai-2', type: 'team', severity: 'high', message: 'm', evidence: 'e' },
      { caseId: 'ai-2', type: 'status', severity: 'critical', message: 'm', evidence: 'e' },
      { caseId: 'ai-2', type: 'status', severity: 'low', message: '', evidence: 'e' },
      { caseId: 'ai-2', type: 'status', severity: 'low', message: 'm', evidence: '' }
    ]
  }) + '\n' + fence;
  const issues = parseQualityResponse(content, candidates);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], {
    caseId: 'ai-1', type: 'solution', severity: 'high', message: 'Не описано устранение', evidence: 'Описание A'
  });
  assert.equal(issues[1].caseId, 'ai-1');
  assert.equal(issues[1].type, 'status');
});

test('AI response parser rejects malformed output', () => {
  assert.throws(() => parseQualityResponse('not json', [incident()]), QualityAiError);
  assert.throws(() => parseQualityResponse(JSON.stringify({ issues: {} }), [incident()]), QualityAiError);
  assert.throws(() => parseQualityResponse(JSON.stringify({}), [incident()]), QualityAiError);
  assert.deepEqual(parseQualityResponse(JSON.stringify({ issues: [] })), []);
});

test('merge keeps deterministic findings, dedupes by case/type and recomputes score', () => {
  const generic = closedIncident({
    caseId: 'merge-a', id: 'INC-MA', title: 'Шлюз SMS', product: 'SMS', solution: 'Решено'
  });
  const missing = closedIncident({
    caseId: 'merge-b', id: 'INC-MB', title: 'Биллинг', product: 'Биллинг', solution: null
  });
  const deterministic = build([generic, missing]);
  assert.equal(deterministic.score, 82);
  assert.deepEqual(rulesOf(deterministic).sort(), ['solution.generic', 'solution.missing']);

  const merged = mergeQualityReport(deterministic, [
    { caseId: 'merge-a', type: 'solution', severity: 'high', message: 'AI дубль', evidence: 'e' },
    { caseId: 'merge-b', type: 'status', severity: 'medium', message: 'AI статус', evidence: 'описание' },
    { caseId: 'unknown', type: 'solution', severity: 'high', message: 'skip', evidence: 'e' },
    { caseId: 'merge-b', type: 'team', severity: 'high', message: 'skip', evidence: 'e' }
  ], { cases: [generic, missing], aiChecked: 2, now: NOW });

  assert.equal(merged.source, 'rules+ai');
  assert.equal(merged.aiChecked, 2);
  assert.equal(merged.generatedAt, NOW);
  assert.equal(merged.score, 76);
  assert.equal(merged.status, 'attention');
  assert.equal(merged.findings.some(finding => finding.id === 'ai.solution:merge-a'), false);
  const aiStatus = merged.findings.find(finding => finding.id === 'ai.status:merge-b');
  assert.ok(aiStatus);
  assert.equal(aiStatus.rule, 'ai.status');
  assert.equal(aiStatus.type, 'status');
  assert.equal(aiStatus.severity, 'medium');
  assert.equal(aiStatus.caseId, 'merge-b');
  assert.equal(aiStatus.incidentId, 'INC-MB');
  assert.equal(aiStatus.title, 'Биллинг');
  assert.equal(aiStatus.priorityId, 4);
  assert.equal(aiStatus.message, 'AI статус');
  assert.equal(aiStatus.evidence, 'описание');
  assert.equal(merged.bySeverity.high, 1);
  assert.equal(merged.bySeverity.medium, 2);
});

test('scanQuality skips AI when disabled and returns the deterministic report', async () => {
  const cases = [incident({ caseId: 'scan-1' })];
  const ai = fakeAi(() => { throw new Error('must not be called'); });
  const result = await scanQuality(ai, cases, { aiEnabled: false, now: NOW });
  assert.equal(ai.calls.length, 0);
  assert.equal(result.source, 'rules');
  assert.equal(result.aiSkipped, true);
  assert.equal(result.aiChecked, 0);
  assert.equal(result.score, 100);
  assert.deepEqual(result.aiCandidateCaseIds, ['scan-1']);
});

test('scanQuality falls back to rules on AI failure without throwing', async () => {
  const cases = [incident({ caseId: 'scan-2' })];
  const ai = fakeAi(() => { throw new Error('timeout'); });
  const result = await scanQuality(ai, cases, { aiEnabled: true, timeoutMs: 1234, now: NOW });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].options.timeoutMs, 1234);
  assert.equal(result.source, 'rules');
  assert.equal(result.aiSkipped, true);
  assert.equal(result.aiChecked, 0);
  assert.equal(result.score, 100);
  assert.deepEqual(result.findings, []);
});

test('scanQuality merges AI issues, caches by case signature and reports aiChecked', async () => {
  const first = closedIncident({
    caseId: 'scan-a', id: 'INC-SA', title: 'Шлюз SMS', product: 'SMS', solution: 'Решено'
  });
  const second = closedIncident({
    caseId: 'scan-b', id: 'INC-SB', title: 'Биллинг', product: 'Биллинг', solution: null
  });
  const ai = fakeAi(() => JSON.stringify({
    issues: [{ caseId: 'scan-b', type: 'status', severity: 'high', message: 'Статус неверен', evidence: 'Описание' }]
  }));

  const result = await scanQuality(ai, [first, second], { aiEnabled: true, now: NOW });
  assert.equal(ai.calls.length, 1);
  assert.match(ai.calls[0].prompt, /scan-a/);
  assert.match(ai.calls[0].prompt, /scan-b/);
  assert.equal(result.source, 'rules+ai');
  assert.equal(result.aiChecked, 2);
  assert.equal(result.aiSkipped, undefined);
  assert.deepEqual(result.aiCandidateCaseIds, ['scan-a', 'scan-b']);
  assert.equal(result.score, 70);
  assert.equal(result.status, 'attention');
  assert.equal(result.findings.filter(finding => finding.rule === 'ai.status').length, 1);

  const cached = await scanQuality(ai, [first, second], { aiEnabled: true, now: NOW });
  assert.equal(ai.calls.length, 1);
  assert.equal(cached.source, 'rules+ai');
  assert.equal(cached.score, 70);

  const changed = { ...second, version: 2 };
  const afterChange = await scanQuality(ai, [first, changed], { aiEnabled: true, now: NOW });
  assert.equal(ai.calls.length, 2);
  assert.doesNotMatch(ai.calls[1].prompt, /scan-a/);
  assert.match(ai.calls[1].prompt, /scan-b/);
  assert.equal(afterChange.source, 'rules+ai');
  assert.equal(afterChange.aiChecked, 2);
});

test('scanQuality does not call AI when there are no candidates', async () => {
  const ai = fakeAi(() => { throw new Error('must not be called'); });
  const result = await scanQuality(ai, [incident({ description: '', solution: null })], {
    aiEnabled: true, now: NOW
  });
  assert.equal(ai.calls.length, 0);
  assert.equal(result.source, 'rules');
  assert.equal(result.aiChecked, 0);
  assert.deepEqual(result.aiCandidateCaseIds, []);
  assert.equal(result.aiSkipped, undefined);
});

// --- HTTP endpoint contract -------------------------------------------------

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function waitForOutput(child, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for ' + pattern + '; output: ' + buffer.slice(-2000)));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(pattern);
      if (match) {
        cleanup();
        resolve(match);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error('child exited early (code ' + code + ', signal ' + signal + '); output: ' + buffer.slice(-2000)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  });
}

function startService(cwd, readyPattern, env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { child, ready: waitForOutput(child, readyPattern) };
}

async function jsonRequest(url, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

async function register(baseUrl, name, login) {
  const response = await fetch(baseUrl + '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, login, password: 'secret-pass' })
  });
  if (response.status !== 201) throw new Error(await response.text());
  const payload = await response.json();
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  return { user: payload.user, cookie };
}

test('quality API: deterministic report, AI-disabled scan, validation and rate limit', { timeout: 90000 }, async (t) => {
  const mockDir = tempDir(t, 'incident-pulse-quality-mock-');
  const appDir = tempDir(t, 'incident-pulse-quality-app-');
  const disabledDir = tempDir(t, 'incident-pulse-quality-disabled-');

  const mock = startService(MOCK_ROOT, /itsm-mock listening on port (\d+)/, {
    PORT: '0',
    DATA_DIR: mockDir
  });
  t.after(() => stopChild(mock.child));
  const mockPort = Number((await mock.ready)[1]);
  const mockUrl = 'http://127.0.0.1:' + mockPort;

  const app = startService(APP_ROOT, /listening on (\d+); ITSM mock:/, {
    PORT: '0',
    DATA_DIR: appDir,
    ITSM_MOCK_URL: mockUrl,
    POLL_INTERVAL_MS: '3600000',
    SESSION_TTL_MS: '600000',
    QUALITY_AI_ENABLED: 'false',
    QUALITY_AI_RATE_LIMIT_PER_MIN: '4'
  });
  t.after(() => stopChild(app.child));
  const appPort = Number((await app.ready)[1]);
  const baseUrl = 'http://127.0.0.1:' + appPort;

  const user = await register(baseUrl, 'QA', 'qa-user');
  const tick = await jsonRequest(mockUrl + '/itsm/demo/tick', { method: 'POST' });
  assert.equal(tick.status, 200);
  const sync = await jsonRequest(baseUrl + '/api/v1/sync/itsm', { method: 'POST', cookie: user.cookie });
  assert.equal(sync.status, 200);

  const meta = await jsonRequest(baseUrl + '/api/v1/meta', { cookie: user.cookie });
  assert.equal(meta.status, 200);
  assert.equal(meta.payload.qualityEnabled, true);
  assert.equal(meta.payload.qualityAiEnabled, false);
  assert.equal(typeof meta.payload.assistantEnabled, 'boolean');
  assert.equal(typeof meta.payload.routingEnabled, 'boolean');
  assert.equal(typeof meta.payload.postmortemEnabled, 'boolean');

  const dashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  assert.equal(dashboard.status, 200);
  const incidents = dashboard.payload.incidents;
  assert.ok(incidents.length > 0);

  const quality = await jsonRequest(baseUrl + '/api/v1/quality', { cookie: user.cookie });
  assert.equal(quality.status, 200);
  const report = quality.payload;
  assert.ok(Number.isInteger(report.score) && report.score >= 0 && report.score <= 100);
  assert.ok(['good', 'attention', 'critical'].includes(report.status));
  assert.deepEqual(Object.keys(report.byType).sort(), ['duplicate', 'field', 'sla', 'solution', 'status', 'team']);
  assert.deepEqual(Object.keys(report.bySeverity).sort(), ['high', 'low', 'medium']);
  assert.equal(report.scannedCases, incidents.length);
  assert.equal(report.truncated, false);
  assert.equal(report.source, 'rules');
  assert.equal(typeof report.generatedAt, 'number');
  assert.ok(Array.isArray(report.findings));
  for (const finding of report.findings) {
    assert.equal(typeof finding.id, 'string');
    assert.equal(typeof finding.rule, 'string');
    assert.ok(['team', 'solution', 'duplicate', 'status', 'field', 'sla'].includes(finding.type));
    assert.ok(['high', 'medium', 'low'].includes(finding.severity));
    assert.equal(typeof finding.caseId, 'string');
    assert.equal(typeof finding.incidentId, 'string');
    assert.equal(typeof finding.title, 'string');
    assert.equal(typeof finding.message, 'string');
    assert.equal(typeof finding.evidence, 'string');
    if (finding.type === 'duplicate') {
      assert.equal(typeof finding.relatedCaseId, 'string');
      assert.equal(typeof finding.relatedIncidentId, 'string');
      assert.equal(typeof finding.relatedTitle, 'string');
    }
  }

  const scan = await jsonRequest(baseUrl + '/api/v1/quality/scan', {
    method: 'POST',
    cookie: user.cookie
  });
  assert.equal(scan.status, 200);
  assert.equal(scan.payload.source, 'rules');
  assert.equal(scan.payload.aiSkipped, true);
  assert.equal(scan.payload.aiChecked, 0);
  assert.ok(Array.isArray(scan.payload.aiCandidateCaseIds));
  assert.ok(scan.payload.aiCandidateCaseIds.length <= 8);

  const target = incidents.find(row => row.description || row.solution);
  assert.ok(target);
  const filtered = await jsonRequest(baseUrl + '/api/v1/quality/scan', {
    method: 'POST',
    cookie: user.cookie,
    body: { caseIds: [target.caseId] }
  });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.payload.aiCandidateCaseIds, [target.caseId]);

  const invalid = await jsonRequest(baseUrl + '/api/v1/quality/scan', {
    method: 'POST',
    cookie: user.cookie,
    body: { caseIds: 'not-an-array' }
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.payload.code, 'invalid_case_ids');

  const tooMany = await jsonRequest(baseUrl + '/api/v1/quality/scan', {
    method: 'POST',
    cookie: user.cookie,
    body: { caseIds: Array.from({ length: 21 }, (_, index) => 'case-' + index) }
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.payload.code, 'invalid_case_ids');

  const limited = await jsonRequest(baseUrl + '/api/v1/quality/scan', {
    method: 'POST',
    cookie: user.cookie
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.payload.code, 'rate_limited');

  const afterLimit = await jsonRequest(baseUrl + '/api/v1/quality', { cookie: user.cookie });
  assert.equal(afterLimit.status, 200);
  assert.equal(afterLimit.payload.source, 'rules');

  const notifications = await jsonRequest(baseUrl + '/api/v1/notifications', { cookie: user.cookie });
  assert.equal(notifications.status, 200);

  const disabled = startService(APP_ROOT, /listening on (\d+); ITSM mock:/, {
    PORT: '0',
    DATA_DIR: disabledDir,
    ITSM_MOCK_URL: mockUrl,
    POLL_INTERVAL_MS: '3600000',
    QUALITY_ENABLED: 'false',
    QUALITY_AI_ENABLED: 'false'
  });
  t.after(() => stopChild(disabled.child));
  const disabledPort = Number((await disabled.ready)[1]);
  const disabledUrl = 'http://127.0.0.1:' + disabledPort;
  const disabledUser = await register(disabledUrl, 'QA Off', 'qa-off');

  const disabledMeta = await jsonRequest(disabledUrl + '/api/v1/meta', { cookie: disabledUser.cookie });
  assert.equal(disabledMeta.payload.qualityEnabled, false);
  assert.equal(disabledMeta.payload.qualityAiEnabled, false);

  const disabledGet = await jsonRequest(disabledUrl + '/api/v1/quality', { cookie: disabledUser.cookie });
  assert.equal(disabledGet.status, 404);
  assert.equal(disabledGet.payload.code, 'quality_disabled');

  const disabledPost = await jsonRequest(disabledUrl + '/api/v1/quality/scan', {
    method: 'POST',
    cookie: disabledUser.cookie
  });
  assert.equal(disabledPost.status, 404);
  assert.equal(disabledPost.payload.code, 'quality_disabled');
});

// --- AI-enabled endpoint contract -------------------------------------------

function startAiServer(t) {
  const state = { requests: 0, caseIds: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      state.requests += 1;
      let caseId = null;
      try {
        const payload = JSON.parse(body);
        const prompt = payload.messages.find(message => message.role === 'user').content;
        const candidateLine = prompt.split('\n').find(line => line.startsWith('['));
        const candidates = JSON.parse(candidateLine);
        caseId = candidates.length ? candidates[0].caseId : null;
      } catch {
        caseId = null;
      }
      state.caseIds.push(caseId);
      const content = JSON.stringify({
        issues: caseId
          ? [{ caseId, type: 'status', severity: 'high', message: 'AI: статус требует проверки', evidence: 'Описание из карточки' }]
          : []
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => server.close(done)));
      resolve({ state, url: 'http://127.0.0.1:' + server.address().port + '/v1' });
    });
  });
}

test('quality scan merges AI findings through the HTTP endpoint', { timeout: 90000 }, async (t) => {
  const mockDir = tempDir(t, 'incident-pulse-quality-ai-mock-');
  const appDir = tempDir(t, 'incident-pulse-quality-ai-app-');
  const aiServer = await startAiServer(t);

  const mock = startService(MOCK_ROOT, /itsm-mock listening on port (\d+)/, {
    PORT: '0',
    DATA_DIR: mockDir
  });
  t.after(() => stopChild(mock.child));
  const mockPort = Number((await mock.ready)[1]);
  const mockUrl = 'http://127.0.0.1:' + mockPort;

  const app = startService(APP_ROOT, /listening on (\d+); ITSM mock:/, {
    PORT: '0',
    DATA_DIR: appDir,
    ITSM_MOCK_URL: mockUrl,
    POLL_INTERVAL_MS: '3600000',
    SESSION_TTL_MS: '600000',
    AI_BASE_URL: aiServer.url,
    AI_MODEL: 'quality-test-model',
    AI_TIMEOUT_MS: '5000',
    QUALITY_ENABLED: 'true',
    QUALITY_AI_ENABLED: 'true',
    QUALITY_AI_RATE_LIMIT_PER_MIN: '10'
  });
  t.after(() => stopChild(app.child));
  const appPort = Number((await app.ready)[1]);
  const baseUrl = 'http://127.0.0.1:' + appPort;

  const user = await register(baseUrl, 'QA AI', 'qa-ai');
  const tick = await jsonRequest(mockUrl + '/itsm/demo/tick', { method: 'POST' });
  assert.equal(tick.status, 200);
  const sync = await jsonRequest(baseUrl + '/api/v1/sync/itsm', { method: 'POST', cookie: user.cookie });
  assert.equal(sync.status, 200);

  const meta = await jsonRequest(baseUrl + '/api/v1/meta', { cookie: user.cookie });
  assert.equal(meta.payload.qualityEnabled, true);
  assert.equal(meta.payload.qualityAiEnabled, true);

  const dashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  const incidents = dashboard.payload.incidents;
  const deterministic = buildQualityReport(incidents, { now: Date.now() });
  const target = incidents.find((incident) => {
    if (!incident.description && !incident.solution) return false;
    return !deterministic.findings.some(finding => finding.caseId === incident.caseId
      && (finding.type === 'status' || finding.type === 'solution'));
  });
  assert.ok(target, 'expected a candidate without a deterministic status/solution finding');

  const scan = await jsonRequest(baseUrl + '/api/v1/quality/scan', {
    method: 'POST',
    cookie: user.cookie,
    body: { caseIds: [target.caseId] }
  });
  assert.equal(scan.status, 200);
  assert.equal(scan.payload.source, 'rules+ai');
  assert.equal(scan.payload.aiChecked, 1);
  assert.equal(scan.payload.aiSkipped, undefined);
  assert.deepEqual(scan.payload.aiCandidateCaseIds, [target.caseId]);
  assert.equal(aiServer.state.requests, 1);
  assert.deepEqual(aiServer.state.caseIds, [target.caseId]);
  const aiFinding = scan.payload.findings.find(finding => finding.id === 'ai.status:' + target.caseId);
  assert.ok(aiFinding);
  assert.equal(aiFinding.rule, 'ai.status');
  assert.equal(aiFinding.type, 'status');
  assert.equal(aiFinding.severity, 'high');
  assert.equal(aiFinding.caseId, target.caseId);
  assert.equal(aiFinding.message, 'AI: статус требует проверки');
});

