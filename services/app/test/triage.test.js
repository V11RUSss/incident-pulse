'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store');

const APP_ROOT = path.resolve(__dirname, '..');
const MOCK_ROOT = path.resolve(APP_ROOT, '../itsm-mock');
const ACTOR = { id: 'u-actor', name: 'Координатор Триажа' };

function raw(overrides = {}) {
  return {
    id: 'INC-1',
    correlationKey: 'corr-1',
    version: 1,
    stateId: 0,
    priorityId: 2,
    affectedUsers: 10,
    reportCount: 1,
    submitDate: '2026-01-01T00:00:00.000Z',
    deadline: null,
    completionDate: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    header: 'Инцидент',
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

function tempDir(t, prefix = 'incident-pulse-triage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempStore(t) {
  const store = new Store(tempDir(t));
  t.after(() => {
    try { store.close(); } catch {
      // already closed
    }
  });
  return store;
}

function user(id, createdAt = 1, role = 'coordinator') {
  return {
    id,
    name: 'Пользователь ' + id,
    login: 'login-' + id,
    loginNormalized: 'login-' + id,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    role,
    createdAt
  };
}

function seedActor(store) {
  store.createUser(user(ACTOR.id, 1));
}

function caseByKey(store, key) {
  return store.listCases().find(incident => incident.correlationKey === key) || null;
}

function caseBySource(store, incidentId) {
  return store.listCases().find(incident => incident.sourceIds.includes(incidentId)) || null;
}

// --- store: merge ------------------------------------------------------------

test('mergeCases moves raws, history and notifications, aliases the source key and keeps target', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([
    raw({
      id: 'INC-T',
      correlationKey: 'target-key',
      header: 'Целевой инцидент',
      assignedGroupName: 'Team Target',
      submitDate: '2026-01-01T00:00:00.000Z'
    }),
    raw({
      id: 'INC-S',
      correlationKey: 'source-key',
      header: 'Исходный инцидент',
      assignedGroupName: 'Team Source',
      submitDate: '2026-01-02T00:00:00.000Z'
    })
  ], 1);

  const target = caseByKey(store, 'target-key');
  const source = caseByKey(store, 'source-key');
  assert.ok(target && source);
  assert.notEqual(target.caseId, source.caseId);
  store.recordHistory({ caseId: source.caseId, user: ACTOR, action: 'note', details: {} });
  const notification = store.createNotification({
    userId: ACTOR.id,
    caseId: source.caseId,
    incidentId: 'INC-S',
    type: 'test',
    title: 'Уведомление'
  });

  const result = store.mergeCases(target.caseId, source.caseId, ACTOR);

  assert.equal(result.incident.caseId, target.caseId);
  assert.equal(result.incident.correlationKey, 'target-key');
  assert.equal(result.incident.team, 'Team Target');
  assert.deepEqual([...result.incident.sourceIds].sort(), ['INC-S', 'INC-T']);
  assert.equal(result.merge.targetCaseId, target.caseId);
  assert.equal(result.merge.sourceCaseId, source.caseId);
  assert.equal(result.merge.sourceKey, 'source-key');
  assert.equal(result.merge.targetKey, 'target-key');
  assert.equal(result.merge.movedRawIncidents, 1);
  assert.equal(result.merge.movedHistory, 1);
  assert.equal(result.merge.movedNotifications, 1);

  assert.equal(store.getCase(source.caseId), null);
  assert.equal(store.listCases().length, 1);
  assert.equal(store.findOpenCase('source-key'), target.caseId);
  assert.equal(store.getNotification(notification.id).caseId, target.caseId);

  const raws = store.db.prepare('SELECT id, case_id FROM raw_incidents ORDER BY id').all();
  assert.deepEqual(raws.map(row => ({ id: row.id, caseId: row.case_id })), [
    { id: 'INC-S', caseId: target.caseId },
    { id: 'INC-T', caseId: target.caseId }
  ]);

  const history = store.listHistory(target.caseId);
  assert.ok(history.some(row => row.action === 'note'));
  assert.ok(history.some(row => row.action === 'merge'));
  const mergeHistory = history.find(row => row.action === 'merge');
  assert.equal(mergeHistory.details.sourceKey, 'source-key');
  assert.equal(mergeHistory.details.movedRawIncidents, 1);

  const merges = store.listCaseMerges(target.caseId);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].rawCount, 1);
  assert.equal(merges[0].userId, ACTOR.id);
  assert.equal(merges[0].userName, ACTOR.name);

  // A record that still carries the merged-away ITSM key now joins the target.
  store.applyDelta([
    raw({ id: 'INC-N', correlationKey: 'source-key', submitDate: '2026-01-03T00:00:00.000Z' })
  ], 2);
  const after = store.listCases();
  assert.equal(after.length, 1);
  assert.deepEqual([...after[0].sourceIds].sort(), ['INC-N', 'INC-S', 'INC-T']);
});

test('mergeCases rejects closed, mismatched lifecycle and self merges', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([
    raw({ id: 'INC-A', correlationKey: 'active-key' }),
    raw({ id: 'INC-C', correlationKey: 'closed-key', stateId: 10, solution: 'Устранено' }),
    raw({
      id: 'INC-R',
      correlationKey: 'research-key',
      stateId: 20,
      solution: 'Идёт исследование'
    })
  ], 1);

  const active = caseByKey(store, 'active-key');
  const closed = caseByKey(store, 'closed-key');
  const research = caseByKey(store, 'research-key');

  assert.throws(
    () => store.mergeCases(active.caseId, closed.caseId, ACTOR),
    error => error.status === 409 && error.code === 'case_closed'
  );
  assert.throws(
    () => store.mergeCases(active.caseId, research.caseId, ACTOR),
    error => error.status === 409 && error.code === 'lifecycle_mismatch'
  );
  assert.throws(
    () => store.mergeCases(active.caseId, active.caseId, ACTOR),
    error => error.status === 400
  );
  assert.ok(store.getCase(closed.caseId));
  assert.ok(store.getCase(research.caseId));
  assert.ok(store.getCase(active.caseId));
});

// --- store: correlation key --------------------------------------------------

test('setCorrelationKey overrides the fallback key and survives subsequent sync', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([raw({ id: 'INC-1', correlationKey: null })], 1);
  const fallback = store.listCases()[0];
  assert.equal(fallback.correlationKey, 'id:INC-1');

  const updated = store.setCorrelationKey(fallback.caseId, 'mobile-voice-moscow', ACTOR);
  assert.equal(updated.caseId, fallback.caseId);
  assert.equal(updated.correlationKey, 'mobile-voice-moscow');
  assert.ok(updated.version > fallback.version);
  assert.equal(store.getCorrelationOverride('INC-1'), 'mobile-voice-moscow');
  assert.equal(
    store.db.prepare('SELECT correlation_key FROM raw_incidents WHERE id = ?').get('INC-1').correlation_key,
    'mobile-voice-moscow'
  );
  const history = store.listHistory(fallback.caseId);
  assert.equal(history[0].action, 'correlation_key');
  assert.equal(history[0].details.correlationKey, 'mobile-voice-moscow');
  assert.equal(history[0].details.previousKey, 'id:INC-1');

  store.applyDelta([raw({ id: 'INC-1', correlationKey: null, version: 2, affectedUsers: 20 })], 2);
  const afterSync = store.getCase(fallback.caseId);
  assert.equal(afterSync.correlationKey, 'mobile-voice-moscow');
  assert.equal(store.getCorrelationOverride('INC-1'), 'mobile-voice-moscow');

  store.applyDelta([
    raw({ id: 'INC-2', correlationKey: 'mobile-voice-moscow', affectedUsers: 5 })
  ], 3);
  const cases = store.listCases();
  assert.equal(cases.length, 1);
  assert.equal(cases[0].caseId, fallback.caseId);
  assert.deepEqual([...cases[0].sourceIds].sort(), ['INC-1', 'INC-2']);
});

test('setCorrelationKey merges into an open case whose key or alias already exists', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([
    raw({ id: 'INC-A', correlationKey: null }),
    raw({ id: 'INC-B', correlationKey: 'shared-key', submitDate: '2026-01-02T00:00:00.000Z' })
  ], 1);
  const caseA = caseByKey(store, 'id:INC-A');
  const caseB = caseByKey(store, 'shared-key');

  const merged = store.setCorrelationKey(caseA.caseId, 'shared-key', ACTOR);
  assert.equal(merged.caseId, caseB.caseId);
  assert.equal(merged.correlationKey, 'shared-key');
  assert.equal(store.getCase(caseA.caseId), null);
  assert.equal(store.findOpenCase('id:INC-A'), caseB.caseId);
  assert.deepEqual([...merged.sourceIds].sort(), ['INC-A', 'INC-B']);

  const actions = store.listHistory(caseB.caseId).map(row => row.action);
  assert.ok(actions.includes('merge'));
  assert.ok(actions.includes('correlation_key'));
});

test('setCorrelationKey rejects non-keyless, invalid and closed-collision keys', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([
    raw({ id: 'INC-EXPLICIT', correlationKey: 'explicit-key' }),
    raw({ id: 'INC-KEYLESS', correlationKey: null }),
    raw({ id: 'INC-CLOSED', correlationKey: 'taken-key', stateId: 10, solution: 'Устранено' })
  ], 1);
  const explicit = caseByKey(store, 'explicit-key');
  const keyless = caseByKey(store, 'id:INC-KEYLESS');

  assert.throws(
    () => store.setCorrelationKey(explicit.caseId, 'new-key', ACTOR),
    error => error.status === 409 && error.code === 'not_keyless'
  );
  for (const invalid of ['', 'UPPER-CASE', 'id:INC-KEYLESS', 'bad key', 'кириллица']) {
    assert.throws(
      () => store.setCorrelationKey(keyless.caseId, invalid, ACTOR),
      error => error.status === 400 && error.code === 'invalid_correlation_key'
    );
  }
  assert.throws(
    () => store.setCorrelationKey(keyless.caseId, 'taken-key', ACTOR),
    error => error.status === 409 && error.code === 'correlation_key_conflict'
  );
  assert.equal(store.getCase(keyless.caseId).correlationKey, 'id:INC-KEYLESS');
});

test('Store migrates a database created before triage tables existed', (t) => {
  const dir = tempDir(t, 'incident-pulse-triage-migrate-');
  let store = new Store(dir);
  store.db.exec(`
    DROP TABLE case_merges;
    DROP TABLE correlation_overrides;
    DROP TABLE case_key_aliases;
  `);
  store.db.exec('ALTER TABLE cases DROP COLUMN team_override;');
  store.close();

  store = new Store(dir);
  t.after(() => store.close());
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map(row => row.name);
  for (const table of ['case_merges', 'correlation_overrides', 'case_key_aliases']) {
    assert.ok(tables.includes(table), 'missing migrated table ' + table);
  }
  const caseColumns = store.db.prepare('PRAGMA table_info(cases)').all().map(column => column.name);
  assert.ok(caseColumns.includes('team_override'), 'missing migrated cases.team_override column');

  seedActor(store);
  store.applyDelta([
    raw({ id: 'INC-M1', correlationKey: 'migrate-target-key' }),
    raw({ id: 'INC-M2', correlationKey: 'migrate-source-key', submitDate: '2026-01-02T00:00:00.000Z' })
  ], 1);
  const target = caseByKey(store, 'migrate-target-key');
  const source = caseByKey(store, 'migrate-source-key');
  const result = store.mergeCases(target.caseId, source.caseId, ACTOR);
  assert.equal(result.incident.caseId, target.caseId);
  assert.equal(store.listCaseMerges(target.caseId).length, 1);
});

test('mergeCases preserves target team even when the source is older', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([
    raw({
      id: 'INC-NEW',
      correlationKey: 'new-target-key',
      assignedGroupName: 'New Team',
      submitDate: '2026-01-02T00:00:00.000Z'
    }),
    raw({
      id: 'INC-OLD',
      correlationKey: 'old-source-key',
      assignedGroupName: 'Old Team',
      submitDate: '2026-01-01T00:00:00.000Z'
    })
  ], 1);
  const target = caseByKey(store, 'new-target-key');
  const source = caseByKey(store, 'old-source-key');

  const result = store.mergeCases(target.caseId, source.caseId, ACTOR);
  assert.equal(result.incident.caseId, target.caseId);
  assert.equal(result.incident.team, 'New Team');
  assert.equal(result.incident.id, 'INC-OLD');

  // The preserved team survives a later rebuild driven by a sync delta.
  store.applyDelta([
    raw({
      id: 'INC-NEW',
      correlationKey: 'new-target-key',
      version: 2,
      assignedGroupName: 'New Team',
      submitDate: '2026-01-02T00:00:00.000Z'
    })
  ], 2);
  assert.equal(store.getCase(target.caseId).team, 'New Team');

  store.clearTeamOverride(target.caseId);
  store.applyDelta([
    raw({
      id: 'INC-OLD',
      correlationKey: 'old-source-key',
      version: 2,
      assignedGroupName: 'Old Team',
      submitDate: '2026-01-01T00:00:00.000Z'
    })
  ], 3);
  assert.equal(store.getCase(target.caseId).team, 'Old Team');
});

test('mergeCasesBatch moves all sources in one transaction and one merge history', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([
    raw({ id: 'B-T', correlationKey: 'batch-target-key', assignedGroupName: 'Batch Team', submitDate: '2026-01-01T00:00:00.000Z' }),
    raw({ id: 'B-S1', correlationKey: 'batch-source-one', submitDate: '2026-01-02T00:00:00.000Z' }),
    raw({ id: 'B-S2', correlationKey: 'batch-source-two', submitDate: '2026-01-03T00:00:00.000Z' })
  ], 1);
  const target = caseByKey(store, 'batch-target-key');
  const first = caseByKey(store, 'batch-source-one');
  const second = caseByKey(store, 'batch-source-two');
  store.recordHistory({ caseId: first.caseId, user: ACTOR, action: 'note', details: { source: 1 } });
  store.recordHistory({ caseId: second.caseId, user: ACTOR, action: 'note', details: { source: 2 } });
  const firstNotification = store.createNotification({
    userId: ACTOR.id, caseId: first.caseId, incidentId: 'B-S1', type: 'test', title: 'S1'
  });
  const secondNotification = store.createNotification({
    userId: ACTOR.id, caseId: second.caseId, incidentId: 'B-S2', type: 'test', title: 'S2'
  });

  const result = store.mergeCasesBatch(target.caseId, [first.caseId, second.caseId], ACTOR);

  assert.equal(result.incident.caseId, target.caseId);
  assert.equal(result.incident.team, 'Batch Team');
  assert.deepEqual([...result.incident.sourceIds].sort(), ['B-S1', 'B-S2', 'B-T']);
  assert.equal(result.merge.targetCaseId, target.caseId);
  assert.deepEqual(result.merge.sourceCaseIds, [first.caseId, second.caseId]);
  assert.equal(result.merge.sourceCaseId, first.caseId);
  assert.deepEqual(result.merge.sourceKeys, ['batch-source-one', 'batch-source-two']);
  assert.equal(result.merge.movedRawIncidents, 2);
  assert.equal(result.merge.movedHistory, 2);
  assert.equal(result.merge.movedNotifications, 2);
  assert.equal(result.merge.merges.length, 2);
  assert.equal(result.merge.merges[0].rawCount, 1);

  assert.equal(store.getCase(first.caseId), null);
  assert.equal(store.getCase(second.caseId), null);
  assert.equal(store.listCases().length, 1);
  assert.equal(store.findOpenCase('batch-source-one'), target.caseId);
  assert.equal(store.findOpenCase('batch-source-two'), target.caseId);
  assert.equal(store.getNotification(firstNotification.id).caseId, target.caseId);
  assert.equal(store.getNotification(secondNotification.id).caseId, target.caseId);

  const mergeHistory = store.listHistory(target.caseId).filter(row => row.action === 'merge');
  assert.equal(mergeHistory.length, 1);
  assert.deepEqual(mergeHistory[0].details.sourceCaseIds, [first.caseId, second.caseId]);
  assert.equal(mergeHistory[0].details.movedRawIncidents, 2);
  assert.equal(store.listCaseMerges(target.caseId).length, 2);
});

test('mergeCasesBatch is atomic: an invalid source leaves every case untouched', (t) => {
  const store = tempStore(t);
  seedActor(store);
  store.applyDelta([
    raw({ id: 'AT-T', correlationKey: 'atomic-target-key' }),
    raw({ id: 'AT-OK', correlationKey: 'atomic-source-ok', submitDate: '2026-01-02T00:00:00.000Z' }),
    raw({ id: 'AT-BAD', correlationKey: 'atomic-source-closed', stateId: 10, solution: 'Устранено' })
  ], 1);
  const target = caseByKey(store, 'atomic-target-key');
  const good = caseByKey(store, 'atomic-source-ok');
  const closed = caseByKey(store, 'atomic-source-closed');

  assert.throws(
    () => store.mergeCasesBatch(target.caseId, [good.caseId, closed.caseId], ACTOR),
    error => error.status === 409 && error.code === 'case_closed'
  );
  assert.ok(store.getCase(target.caseId));
  assert.ok(store.getCase(good.caseId));
  assert.ok(store.getCase(closed.caseId));
  assert.equal(store.listCaseMerges(target.caseId).length, 0);
  assert.equal(store.listHistory(target.caseId).filter(row => row.action === 'merge').length, 0);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM raw_incidents WHERE case_id = ?').get(good.caseId).count,
    1
  );
});

// --- HTTP API ----------------------------------------------------------------

function waitForOutput(child, pattern, timeoutMs = 20000) {
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

function startMock(dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: MOCK_ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { child, ready: waitForOutput(child, /itsm-mock listening on port (\d+)/) };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function seedActiveCases(dataDir, count) {
  const store = new Store(dataDir);
  try {
    const records = [];
    for (let index = 0; index < count; index += 1) {
      records.push(raw({
        id: 'CAP-' + index,
        correlationKey: 'cap-key-' + index,
        header: 'Demo cap ' + index,
        affectedUsers: 1
      }));
    }
    store.applyDelta(records, 0);
    assert.equal(store.countActiveCases(), count);
  } finally {
    store.close();
  }
}

function startApp(dataDir, env = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ITSM_MOCK_URL: 'http://127.0.0.1:1',
      POLL_INTERVAL_MS: '3600000',
      TRIAGE_AI_RATE_LIMIT_PER_MIN: '1',
      AUTO_ROUTING_ENABLED: 'false',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { child, ready: waitForOutput(child, /listening on (\d+); ITSM mock:/) };
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

function seedTriageData(dataDir) {
  const store = new Store(dataDir);
  try {
    store.applyDelta([
      raw({
        id: 'M-T',
        correlationKey: 'merge-target-key',
        header: 'Целевой merge',
        assignedGroupName: 'Team Target',
        submitDate: '2026-01-01T00:00:00.000Z'
      }),
      raw({
        id: 'M-S',
        correlationKey: 'merge-source-key',
        header: 'Исходный merge',
        assignedGroupName: 'Team Source',
        submitDate: '2026-01-02T00:00:00.000Z'
      }),
      raw({ id: 'V-T', correlationKey: 'conflict-target-key' }),
      raw({ id: 'V-S', correlationKey: 'conflict-source-key' }),
      raw({ id: 'K-1', correlationKey: null, header: 'Без ключа один' }),
      raw({ id: 'K-2', correlationKey: null, header: 'Без ключа два' }),
      raw({ id: 'EXP', correlationKey: 'exp-key' }),
      raw({ id: 'CL-A', correlationKey: 'closed-active-key' }),
      raw({ id: 'CL-B', correlationKey: 'closed-source-key', stateId: 10, solution: 'Устранено' }),
      raw({ id: 'LC-A', correlationKey: 'lifecycle-active-key' }),
      raw({
        id: 'LC-R',
        correlationKey: 'lifecycle-research-key',
        stateId: 20,
        solution: 'Идёт исследование'
      }),
      raw({
        id: 'B-T',
        correlationKey: 'batch-target-key',
        assignedGroupName: 'Batch Team',
        submitDate: '2026-01-01T00:00:00.000Z'
      }),
      raw({ id: 'B-S1', correlationKey: 'batch-source-one', submitDate: '2026-01-02T00:00:00.000Z' }),
      raw({ id: 'B-S2', correlationKey: 'batch-source-two', submitDate: '2026-01-03T00:00:00.000Z' }),
      raw({ id: 'C-T', correlationKey: 'batch-conflict-target' }),
      raw({ id: 'C-S1', correlationKey: 'batch-conflict-one', submitDate: '2026-01-02T00:00:00.000Z' }),
      raw({ id: 'C-S2', correlationKey: 'batch-conflict-two', submitDate: '2026-01-03T00:00:00.000Z' })
    ], 1);
  } finally {
    store.close();
  }
}

test('triage HTTP API: report, scan, merge and correlation-key contract', { timeout: 120000 }, async (t) => {
  const dataDir = tempDir(t, 'incident-pulse-triage-api-');
  seedTriageData(dataDir);
  const app = startApp(dataDir, { TRIAGE_AI_ENABLED: 'false' });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);

  const unauth = await jsonRequest(baseUrl + '/api/v1/triage');
  assert.equal(unauth.status, 401);

  const userSession = await register(baseUrl, 'Триаж', 'triage-user');
  const cookie = userSession.cookie;

  const meta = await jsonRequest(baseUrl + '/api/v1/meta', { cookie });
  assert.equal(meta.status, 200);
  assert.equal(meta.payload.triageEnabled, true);
  assert.equal(meta.payload.triageAiEnabled, false);

  const report = await jsonRequest(baseUrl + '/api/v1/triage', { cookie });
  assert.equal(report.status, 200);
  assert.ok(Array.isArray(report.payload.suggestions));
  assert.equal(report.payload.source, 'rules');
  assert.equal(typeof report.payload.generatedAt, 'number');
  assert.deepEqual(Object.keys(report.payload.byType).sort(), ['correlation_key', 'merge']);
  for (const suggestion of report.payload.suggestions) {
    assert.ok(['merge', 'correlation_key'].includes(suggestion.type));
    assert.ok(['high', 'medium', 'low'].includes(suggestion.confidence));
    assert.equal(typeof suggestion.id, 'string');
  }

  const scan = await jsonRequest(baseUrl + '/api/v1/triage/scan', {
    method: 'POST',
    cookie
  });
  assert.equal(scan.status, 200);
  assert.equal(scan.payload.source, 'rules');
  assert.equal(scan.payload.aiChecked, 0);
  assert.equal(scan.payload.aiSkipped, true);

  const limited = await jsonRequest(baseUrl + '/api/v1/triage/scan', {
    method: 'POST',
    cookie
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.payload.code, 'rate_limited');

  const dashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie });
  assert.equal(dashboard.status, 200);
  const incidents = dashboard.payload.incidents;
  const byKey = new Map(incidents.map(incident => [incident.correlationKey, incident]));

  const mergeTarget = byKey.get('merge-target-key');
  const mergeSource = byKey.get('merge-source-key');
  const merged = await jsonRequest(baseUrl + '/api/v1/cases/' + encodeURIComponent(mergeTarget.caseId) + '/merge', {
    method: 'POST',
    cookie,
    body: {
      sourceCaseId: mergeSource.caseId,
      expectedVersion: mergeTarget.version,
      expectedSourceVersion: mergeSource.version
    }
  });
  assert.equal(merged.status, 200);
  assert.equal(merged.payload.incident.caseId, mergeTarget.caseId);
  assert.equal(merged.payload.incident.correlationKey, 'merge-target-key');
  assert.equal(merged.payload.incident.team, 'Team Target');
  assert.deepEqual([...merged.payload.incident.sourceIds].sort(), ['M-S', 'M-T']);
  assert.equal(merged.payload.merge.movedRawIncidents, 1);

  const afterMerge = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie });
  assert.equal(afterMerge.payload.incidents.length, incidents.length - 1);
  assert.equal(afterMerge.payload.incidents.some(incident => incident.caseId === mergeSource.caseId), false);
  const targetHistory = await jsonRequest(
    baseUrl + '/api/v1/incidents/' + encodeURIComponent(mergeTarget.caseId) + '/history',
    { cookie }
  );
  assert.equal(targetHistory.status, 200);
  assert.ok(targetHistory.payload.history.some(row => row.action === 'merge'));

  // Batch merge: sourceCaseIds[] with an expectedVersions map, one atomic result.
  const batchTarget = byKey.get('batch-target-key');
  const batchFirst = byKey.get('batch-source-one');
  const batchSecond = byKey.get('batch-source-two');
  const beforeBatch = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie });
  const batch = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(batchTarget.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseIds: [batchFirst.caseId, batchSecond.caseId],
        expectedVersions: {
          [batchTarget.caseId]: batchTarget.version,
          [batchFirst.caseId]: batchFirst.version,
          [batchSecond.caseId]: batchSecond.version
        }
      }
    }
  );
  assert.equal(batch.status, 200);
  assert.equal(batch.payload.incident.caseId, batchTarget.caseId);
  assert.equal(batch.payload.incident.correlationKey, 'batch-target-key');
  assert.equal(batch.payload.incident.team, 'Batch Team');
  assert.deepEqual([...batch.payload.incident.sourceIds].sort(), ['B-S1', 'B-S2', 'B-T']);
  assert.deepEqual(batch.payload.merge.sourceCaseIds, [batchFirst.caseId, batchSecond.caseId]);
  assert.deepEqual(batch.payload.merge.sourceKeys, ['batch-source-one', 'batch-source-two']);
  assert.equal(batch.payload.merge.movedRawIncidents, 2);
  assert.equal(batch.payload.merge.merges.length, 2);
  const afterBatch = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie });
  assert.equal(afterBatch.payload.incidents.length, beforeBatch.payload.incidents.length - 2);

  const conflictTargetTwo = byKey.get('batch-conflict-target');
  const conflictOne = byKey.get('batch-conflict-one');
  const conflictTwo = byKey.get('batch-conflict-two');
  const beforeAtomic = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie });
  const atomicConflict = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(conflictTargetTwo.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseIds: [conflictOne.caseId, conflictTwo.caseId],
        expectedVersions: {
          [conflictTargetTwo.caseId]: conflictTargetTwo.version,
          [conflictOne.caseId]: conflictOne.version + 5,
          [conflictTwo.caseId]: conflictTwo.version
        }
      }
    }
  );
  assert.equal(atomicConflict.status, 409);
  assert.equal(atomicConflict.payload.incident.caseId, conflictOne.caseId);
  const afterAtomic = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie });
  assert.equal(afterAtomic.payload.incidents.length, beforeAtomic.payload.incidents.length);
  assert.ok(afterAtomic.payload.incidents.some(incident => incident.caseId === conflictOne.caseId));
  assert.ok(afterAtomic.payload.incidents.some(incident => incident.caseId === conflictTwo.caseId));

  const missingVersion = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(conflictTargetTwo.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseIds: [conflictOne.caseId, conflictTwo.caseId],
        expectedVersions: { [conflictTargetTwo.caseId]: conflictTargetTwo.version, [conflictOne.caseId]: conflictOne.version }
      }
    }
  );
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.payload.code, 'invalid_merge');

  const notArray = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(conflictTargetTwo.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: { sourceCaseIds: conflictOne.caseId, expectedVersions: {} }
    }
  );
  assert.equal(notArray.status, 400);
  assert.equal(notArray.payload.code, 'invalid_merge');

  // The documented batch shape: expectedVersions for the sources only, no
  // separate expectedVersion for the target.
  const batchWithoutTargetVersion = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(conflictTargetTwo.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseIds: [conflictOne.caseId, conflictTwo.caseId],
        expectedVersions: {
          [conflictOne.caseId]: conflictOne.version,
          [conflictTwo.caseId]: conflictTwo.version
        }
      }
    }
  );
  assert.equal(batchWithoutTargetVersion.status, 200);
  assert.equal(batchWithoutTargetVersion.payload.incident.caseId, conflictTargetTwo.caseId);
  assert.deepEqual(
    [...batchWithoutTargetVersion.payload.incident.sourceIds].sort(),
    ['C-S1', 'C-S2', 'C-T']
  );

  const selfMerge = await jsonRequest(baseUrl + '/api/v1/cases/' + encodeURIComponent(mergeTarget.caseId) + '/merge', {
    method: 'POST',
    cookie,
    body: {
      sourceCaseId: mergeTarget.caseId,
      expectedVersion: merged.payload.incident.version,
      expectedSourceVersion: merged.payload.incident.version
    }
  });
  assert.equal(selfMerge.status, 400);

  const conflictTarget = byKey.get('conflict-target-key');
  const conflictSource = byKey.get('conflict-source-key');
  const targetConflict = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(conflictTarget.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseId: conflictSource.caseId,
        expectedVersion: conflictTarget.version + 5,
        expectedSourceVersion: conflictSource.version
      }
    }
  );
  assert.equal(targetConflict.status, 409);
  assert.equal(targetConflict.payload.incident.caseId, conflictTarget.caseId);
  assert.equal(targetConflict.payload.currentVersion, conflictTarget.version);

  const sourceConflict = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(conflictTarget.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseId: conflictSource.caseId,
        expectedVersion: conflictTarget.version,
        expectedSourceVersion: conflictSource.version + 5
      }
    }
  );
  assert.equal(sourceConflict.status, 409);
  assert.equal(sourceConflict.payload.incident.caseId, conflictSource.caseId);

  const closedTarget = byKey.get('closed-active-key');
  const closedSource = byKey.get('closed-source-key');
  const closedMerge = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(closedTarget.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseId: closedSource.caseId,
        expectedVersion: closedTarget.version,
        expectedSourceVersion: closedSource.version
      }
    }
  );
  assert.equal(closedMerge.status, 409);
  assert.equal(closedMerge.payload.code, 'case_closed');

  const lifecycleActive = byKey.get('lifecycle-active-key');
  const lifecycleResearch = byKey.get('lifecycle-research-key');
  const lifecycleMerge = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(lifecycleActive.caseId) + '/merge',
    {
      method: 'POST',
      cookie,
      body: {
        sourceCaseId: lifecycleResearch.caseId,
        expectedVersion: lifecycleActive.version,
        expectedSourceVersion: lifecycleResearch.version
      }
    }
  );
  assert.equal(lifecycleMerge.status, 409);
  assert.equal(lifecycleMerge.payload.code, 'lifecycle_mismatch');

  // Correlation key: manual key on a keyless case survives and joins future records.
  const keylessOne = caseBySourceFromList(incidents, 'K-1');
  const keylessTwo = caseBySourceFromList(incidents, 'K-2');
  const setKey = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(keylessOne.caseId) + '/correlation-key',
    {
      method: 'POST',
      cookie,
      body: { correlationKey: 'triage-manual-key', expectedVersion: keylessOne.version }
    }
  );
  assert.equal(setKey.status, 200);
  assert.equal(setKey.payload.merged, false);
  assert.equal(setKey.payload.incident.correlationKey, 'triage-manual-key');

  const collision = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(keylessTwo.caseId) + '/correlation-key',
    {
      method: 'POST',
      cookie,
      body: { correlationKey: 'triage-manual-key', expectedVersion: keylessTwo.version }
    }
  );
  assert.equal(collision.status, 200);
  assert.equal(collision.payload.merged, true);
  assert.equal(collision.payload.incident.caseId, keylessOne.caseId);
  assert.equal(collision.payload.sourceCaseId, keylessTwo.caseId);
  assert.deepEqual([...collision.payload.incident.sourceIds].sort(), ['K-1', 'K-2']);

  const explicitCase = byKey.get('exp-key');
  const notKeyless = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(explicitCase.caseId) + '/correlation-key',
    {
      method: 'POST',
      cookie,
      body: { correlationKey: 'new-key', expectedVersion: explicitCase.version }
    }
  );
  assert.equal(notKeyless.status, 409);
  assert.equal(notKeyless.payload.code, 'not_keyless');

  const invalidKey = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(explicitCase.caseId) + '/correlation-key',
    {
      method: 'POST',
      cookie,
      body: { correlationKey: 'UPPER CASE', expectedVersion: explicitCase.version }
    }
  );
  assert.equal(invalidKey.status, 400);
  assert.equal(invalidKey.payload.code, 'invalid_correlation_key');

  const noVersion = await jsonRequest(
    baseUrl + '/api/v1/cases/' + encodeURIComponent(explicitCase.caseId) + '/correlation-key',
    {
      method: 'POST',
      cookie,
      body: { correlationKey: 'new-key' }
    }
  );
  assert.equal(noVersion.status, 400);

  const afterKeys = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie });
  const manual = afterKeys.payload.incidents.find(incident => incident.correlationKey === 'triage-manual-key');
  assert.ok(manual);
  assert.deepEqual([...manual.sourceIds].sort(), ['K-1', 'K-2']);
});

function startAiServer(t) {
  const state = { requests: 0, prompts: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      state.requests += 1;
      try {
        const payload = JSON.parse(body);
        const prompt = payload.messages.find(message => message.role === 'user').content;
        state.prompts.push(prompt);
      } catch {
        state.prompts.push(null);
      }
      const content = JSON.stringify({ suggestions: [] });
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

test('triage AI scan uses scanTriage through the HTTP endpoint', { timeout: 90000 }, async (t) => {
  const dataDir = tempDir(t, 'incident-pulse-triage-ai-');
  const store = new Store(dataDir);
  try {
    store.applyDelta([
      raw({
        id: 'AI-1',
        correlationKey: 'ai-pair-one',
        header: 'Деградация голосовой связи в Москве',
        submitDate: '2026-01-01T00:00:00.000Z'
      }),
      raw({
        id: 'AI-2',
        correlationKey: 'ai-pair-two',
        header: 'Деградация голосовой связи в Москве',
        submitDate: '2026-01-01T01:00:00.000Z'
      })
    ], 1);
  } finally {
    store.close();
  }
  const aiServer = await startAiServer(t);
  const app = startApp(dataDir, {
    TRIAGE_AI_ENABLED: 'true',
    TRIAGE_AI_RATE_LIMIT_PER_MIN: '10',
    TRIAGE_AI_TIMEOUT_MS: '5000',
    AI_BASE_URL: aiServer.url,
    AI_MODEL: 'triage-test-model',
    AI_TIMEOUT_MS: '5000'
  });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const userSession = await register(baseUrl, 'Триаж AI', 'triage-ai');

  const meta = await jsonRequest(baseUrl + '/api/v1/meta', { cookie: userSession.cookie });
  assert.equal(meta.payload.triageEnabled, true);
  assert.equal(meta.payload.triageAiEnabled, true);

  const report = await jsonRequest(baseUrl + '/api/v1/triage', { cookie: userSession.cookie });
  assert.equal(report.status, 200);
  assert.equal(report.payload.source, 'rules');
  assert.equal(report.payload.candidatePairs, 1);
  assert.equal(report.payload.suggestions.length, 1);
  assert.equal(report.payload.suggestions[0].type, 'merge');

  const scan = await jsonRequest(baseUrl + '/api/v1/triage/scan', {
    method: 'POST',
    cookie: userSession.cookie
  });
  assert.equal(scan.status, 200);
  assert.equal(scan.payload.source, 'rules+ai');
  assert.equal(scan.payload.aiChecked, 1);
  assert.equal(scan.payload.aiSkipped, false);
  assert.equal(scan.payload.suggestions.length, 1);
  assert.equal(aiServer.state.requests, 1);
  assert.match(aiServer.state.prompts[0], /Кандидаты на объединение/);
});

test('demo generation stops at DEMO_MAX_ACTIVE while sync keeps running', { timeout: 120000 }, async (t) => {
  const mock = startMock(tempDir(t, 'incident-pulse-triage-cap-mock-'));
  t.after(() => stopChild(mock.child));
  const mockUrl = 'http://127.0.0.1:' + Number((await mock.ready)[1]);

  const cappedDir = tempDir(t, 'incident-pulse-triage-cap-app-');
  seedActiveCases(cappedDir, 20);
  const capped = startApp(cappedDir, {
    ITSM_MOCK_URL: mockUrl,
    DEMO_GENERATION: 'true',
    POLL_INTERVAL_MS: '100',
    DEMO_MIN_INTERVAL_MS: '1000',
    DEMO_MAX_INTERVAL_MS: '1000',
    DEMO_BATCH_MIN: '1',
    DEMO_BATCH_MAX: '1',
    DEMO_MAX_ACTIVE: '20'
  });
  t.after(() => stopChild(capped.child));
  const cappedUrl = 'http://127.0.0.1:' + Number((await capped.ready)[1]);
  const cappedUser = await register(cappedUrl, 'Cap', 'triage-cap');

  const before = await jsonRequest(cappedUrl + '/api/v1/incidents', { cookie: cappedUser.cookie });
  assert.equal(before.payload.incidents.length, 20);
  await delay(1500);
  const after = await jsonRequest(cappedUrl + '/api/v1/incidents', { cookie: cappedUser.cookie });
  assert.equal(after.payload.incidents.length, 20);
  assert.ok(
    after.payload.lastSyncedAt > before.payload.lastSyncedAt,
    'poll must keep synchronizing when the demo cap is reached'
  );
  const cappedMock = await jsonRequest(mockUrl + '/itsm/incidents');
  assert.equal(cappedMock.payload.revision, 0, 'demo tick must be skipped at the cap');

  const manualSync = await jsonRequest(cappedUrl + '/api/v1/sync/itsm', {
    method: 'POST',
    cookie: cappedUser.cookie
  });
  assert.equal(manualSync.status, 200);
  const afterManualSync = await jsonRequest(mockUrl + '/itsm/incidents');
  assert.equal(afterManualSync.payload.revision, 0, 'manual sync must not generate demo traffic at the cap');
});

function caseBySourceFromList(incidents, incidentId) {
  const incident = incidents.find(row => row.sourceIds.includes(incidentId));
  assert.ok(incident, 'case for ' + incidentId + ' not found');
  return incident;
}

test('triage flags disable endpoints and meta reports it', { timeout: 90000 }, async (t) => {
  const dataDir = tempDir(t, 'incident-pulse-triage-disabled-');
  const app = startApp(dataDir, { TRIAGE_ENABLED: 'false' });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const userSession = await register(baseUrl, 'Триаж Off', 'triage-off');

  const meta = await jsonRequest(baseUrl + '/api/v1/meta', { cookie: userSession.cookie });
  assert.equal(meta.status, 200);
  assert.equal(meta.payload.triageEnabled, false);
  assert.equal(meta.payload.triageAiEnabled, true);

  const report = await jsonRequest(baseUrl + '/api/v1/triage', { cookie: userSession.cookie });
  assert.equal(report.status, 404);
  assert.equal(report.payload.code, 'triage_disabled');

  const scan = await jsonRequest(baseUrl + '/api/v1/triage/scan', {
    method: 'POST',
    cookie: userSession.cookie
  });
  assert.equal(scan.status, 404);
  assert.equal(scan.payload.code, 'triage_disabled');

  const merge = await jsonRequest(baseUrl + '/api/v1/cases/any-case/merge', {
    method: 'POST',
    cookie: userSession.cookie,
    body: { sourceCaseId: 'other-case', expectedVersion: 1, expectedSourceVersion: 1 }
  });
  assert.equal(merge.status, 404);
  assert.equal(merge.payload.code, 'triage_disabled');

  const key = await jsonRequest(baseUrl + '/api/v1/cases/any-case/correlation-key', {
    method: 'POST',
    cookie: userSession.cookie,
    body: { correlationKey: 'manual-key', expectedVersion: 1 }
  });
  assert.equal(key.status, 404);
  assert.equal(key.payload.code, 'triage_disabled');
});
