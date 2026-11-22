'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store');

const APP_ROOT = path.resolve(__dirname, '..');
const MOCK_ROOT = path.resolve(APP_ROOT, '../itsm-mock');

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

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

function startApp(dataDir, env = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ITSM_MOCK_URL: 'http://127.0.0.1:1',
      POLL_INTERVAL_MS: '100',
      DEMO_GENERATION: 'true',
      AUTO_ROUTING_ENABLED: 'false',
      DEMO_MIN_INTERVAL_MS: '1000',
      DEMO_MAX_INTERVAL_MS: '1000',
      DEMO_BATCH_MIN: '1',
      DEMO_BATCH_MAX: '1',
      DEMO_MAX_ACTIVE: '1000',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { child, ready: waitForOutput(child, /listening on (\d+); ITSM mock:/) };
}

function startMock(dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: MOCK_ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { child, ready: waitForOutput(child, /itsm-mock listening on port (\d+)/) };
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(check, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(intervalMs);
  }
  return false;
}

async function openLive(baseUrl, cookie) {
  const controller = new AbortController();
  const response = await fetch(baseUrl + '/api/v1/events', {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    } catch {
      // aborted connection
    }
  })();
  return {
    close: async () => {
      controller.abort();
      try { await reader.cancel(); } catch { /* already closed */ }
      await pump;
    }
  };
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

async function mockSnapshot(mockUrl) {
  const snapshot = await jsonRequest(mockUrl + '/itsm/incidents');
  assert.equal(snapshot.status, 200);
  return snapshot.payload;
}

test('live off: background sync and actions do not generate; manual sync ticks exactly once', { timeout: 120000 }, async (t) => {
  const mock = startMock(tempDir(t, 'incident-pulse-live-mock-'));
  t.after(() => stopChild(mock.child));
  const mockUrl = 'http://127.0.0.1:' + Number((await mock.ready)[1]);

  // One explicit mock step gives the app a case to act on without involving
  // the app's own demo generator.
  const seedTick = await jsonRequest(mockUrl + '/itsm/demo/tick', { method: 'POST' });
  assert.equal(seedTick.status, 200);

  const app = startApp(tempDir(t, 'incident-pulse-live-app-'), {
    ITSM_MOCK_URL: mockUrl
  });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const user = await register(baseUrl, 'Live Off', 'live-off');

  const dashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.payload.incidents.length > 0);
  const observedIds = new Set(dashboard.payload.incidents.map(incident => incident.id));
  const beforeWait = await mockSnapshot(mockUrl);

  // No SSE subscribers -> the poll loop must synchronize, not generate.
  await delay(1300);
  const afterWait = await mockSnapshot(mockUrl);
  assert.equal(afterWait.revision, beforeWait.revision);
  assert.deepEqual(
    afterWait.incidents.map(incident => incident.id).sort(),
    beforeWait.incidents.map(incident => incident.id).sort()
  );

  // User actions (claim, priority, team) must never generate demo records.
  const target = dashboard.payload.incidents.find(incident => incident.groups.includes('active'));
  assert.ok(target);
  const claim = await jsonRequest(
    baseUrl + '/api/v1/incidents/' + encodeURIComponent(target.caseId) + '/claim',
    { method: 'POST', cookie: user.cookie, body: { expectedVersion: target.version } }
  );
  assert.equal(claim.status, 200);

  const afterClaim = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  const priorityTarget = afterClaim.payload.incidents.find(incident => incident.caseId === target.caseId);
  const priority = await jsonRequest(
    baseUrl + '/api/v1/incidents/' + encodeURIComponent(target.caseId) + '/priority',
    {
      method: 'POST',
      cookie: user.cookie,
      body: {
        priorityId: priorityTarget.priorityId === 3 ? 4 : 3,
        expectedVersion: priorityTarget.version
      }
    }
  );
  assert.equal(priority.status, 200);

  const meta = await jsonRequest(baseUrl + '/api/v1/meta', { cookie: user.cookie });
  const afterPriority = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  const teamTarget = afterPriority.payload.incidents.find(incident => incident.caseId === target.caseId);
  const team = await jsonRequest(
    baseUrl + '/api/v1/incidents/' + encodeURIComponent(target.caseId) + '/team',
    {
      method: 'POST',
      cookie: user.cookie,
      body: { team: meta.payload.teams[0], expectedVersion: teamTarget.version }
    }
  );
  assert.equal(team.status, 200);

  const afterActions = await mockSnapshot(mockUrl);
  assert.deepEqual(
    afterActions.incidents.map(incident => incident.id).sort(),
    [...observedIds].sort(),
    'actions must not add ITSM incidents'
  );

  // Manual one-shot sync explicitly creates one demo tick even with Live off.
  const beforeManual = await mockSnapshot(mockUrl);
  const manual = await jsonRequest(baseUrl + '/api/v1/sync/itsm', { method: 'POST', cookie: user.cookie });
  assert.equal(manual.status, 200);
  assert.ok(manual.payload.demo, 'manual sync must report the demo tick');
  const afterManual = await mockSnapshot(mockUrl);
  assert.equal(afterManual.revision, beforeManual.revision + 1);

  const secondManual = await jsonRequest(baseUrl + '/api/v1/sync/itsm', { method: 'POST', cookie: user.cookie });
  assert.equal(secondManual.status, 200);
  assert.ok(secondManual.payload.demo);
  const afterSecondManual = await mockSnapshot(mockUrl);
  assert.equal(afterSecondManual.revision, afterManual.revision + 1);

  // The manual ticks may add incidents by design; the original cases must stay.
  const finalDashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  for (const incidentId of observedIds) {
    assert.ok(
      finalDashboard.payload.incidents.some(incident => incident.sourceIds.includes(incidentId)),
      'original case must survive actions and manual sync'
    );
  }
});

test('live on: SSE subscribers enable auto demo and disconnect stops it', { timeout: 120000 }, async (t) => {
  const mock = startMock(tempDir(t, 'incident-pulse-live-on-mock-'));
  t.after(() => stopChild(mock.child));
  const mockUrl = 'http://127.0.0.1:' + Number((await mock.ready)[1]);

  const app = startApp(tempDir(t, 'incident-pulse-live-on-app-'), {
    ITSM_MOCK_URL: mockUrl
  });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const user = await register(baseUrl, 'Live On', 'live-on');

  const empty = await mockSnapshot(mockUrl);
  assert.equal(empty.revision, 0);
  const live = await openLive(baseUrl, user.cookie);
  t.after(() => live.close());

  const generated = await waitForCondition(async () => {
    const snapshot = await mockSnapshot(mockUrl);
    return snapshot.revision >= 1;
  }, 8000, 100);
  assert.equal(generated, true, 'poll must generate demo ticks while a Live client is connected');

  await live.close();
  // Let the server observe the disconnect, then make sure auto ticks stopped.
  await delay(300);
  const afterDisconnect = await mockSnapshot(mockUrl);
  await delay(1500);
  const later = await mockSnapshot(mockUrl);
  assert.equal(later.revision, afterDisconnect.revision, 'auto demo must stop after the last Live client disconnects');
});

test('live on: DEMO_MAX_ACTIVE caps auto generation', { timeout: 120000 }, async (t) => {
  const mock = startMock(tempDir(t, 'incident-pulse-live-cap-mock-'));
  t.after(() => stopChild(mock.child));
  const mockUrl = 'http://127.0.0.1:' + Number((await mock.ready)[1]);

  const dataDir = tempDir(t, 'incident-pulse-live-cap-app-');
  seedActiveCases(dataDir, 20);
  const app = startApp(dataDir, {
    ITSM_MOCK_URL: mockUrl,
    DEMO_MAX_ACTIVE: '20'
  });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const user = await register(baseUrl, 'Live Cap', 'live-cap');

  const live = await openLive(baseUrl, user.cookie);
  t.after(() => live.close());
  await delay(1800);

  const snapshot = await mockSnapshot(mockUrl);
  assert.equal(snapshot.revision, 0, 'demo tick must be skipped at DEMO_MAX_ACTIVE even with Live on');
  const dashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  assert.equal(dashboard.payload.incidents.length, 20);
});

test('live on: batch is clamped so active cases never exceed DEMO_MAX_ACTIVE', { timeout: 120000 }, async (t) => {
  const mock = startMock(tempDir(t, 'incident-pulse-live-batch-cap-mock-'));
  t.after(() => stopChild(mock.child));
  const mockUrl = 'http://127.0.0.1:' + Number((await mock.ready)[1]);

  const dataDir = tempDir(t, 'incident-pulse-live-batch-cap-app-');
  seedActiveCases(dataDir, 19);
  const app = startApp(dataDir, {
    ITSM_MOCK_URL: mockUrl,
    DEMO_MAX_ACTIVE: '20',
    DEMO_BATCH_MIN: '1',
    DEMO_BATCH_MAX: '3'
  });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const user = await register(baseUrl, 'Live Batch Cap', 'live-batch-cap');

  const live = await openLive(baseUrl, user.cookie);
  t.after(() => live.close());
  await delay(1800);

  const snapshot = await mockSnapshot(mockUrl);
  assert.equal(snapshot.revision, 1, 'only the remaining one slot may be generated');
  const dashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  assert.equal(dashboard.payload.incidents.length, 20);
  assert.equal(dashboard.payload.counts.active, 20);
});


test('auto-routing assigns a profile team and records history', { timeout: 60000 }, async (t) => {
  const mock = startMock(tempDir(t, 'incident-pulse-auto-route-mock-'));
  t.after(() => stopChild(mock.child));
  const mockUrl = 'http://127.0.0.1:' + Number((await mock.ready)[1]);
  const tick = await jsonRequest(mockUrl + '/itsm/demo/tick', { method: 'POST' });
  assert.equal(tick.status, 200);

  const app = startApp(tempDir(t, 'incident-pulse-auto-route-app-'), {
    ITSM_MOCK_URL: mockUrl,
    DEMO_GENERATION: 'false',
    AUTO_ROUTING_ENABLED: 'true'
  });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const user = await register(baseUrl, 'Auto Route', 'auto-route');

  const dashboard = await jsonRequest(baseUrl + '/api/v1/incidents', { cookie: user.cookie });
  assert.equal(dashboard.status, 200);
  const incident = dashboard.payload.incidents.find(row => row.id === 'MTS-MOBILE-0001');
  assert.ok(incident, 'expected the seeded incident');
  assert.equal(incident.team, 'МТС ИТ Поддержка Mobile voice');
  assert.equal(incident.stateId, 2);
  assert.equal(incident.groups.includes('coordination'), false);

  const history = await jsonRequest(baseUrl + '/api/v1/incidents/' + encodeURIComponent(incident.caseId) + '/history', { cookie: user.cookie });
  assert.equal(history.status, 200);
  const auto = history.payload.history.find(entry => entry.action === 'auto_team');
  assert.ok(auto, 'expected auto_team history');
  assert.equal(auto.details.team, 'МТС ИТ Поддержка Mobile voice');
  assert.equal(auto.userName, 'Автоматическая маршрутизация');

  const snapshot = await mockSnapshot(mockUrl);
  assert.equal(snapshot.incidents.find(row => row.id === 'MTS-MOBILE-0001').assignedGroupName, 'МТС ИТ Поддержка Mobile voice');

  // A delta that triggers auto-routing must return the final revision, not
  // the revision before the routing writes.
  const nextTick = await jsonRequest(mockUrl + '/itsm/demo/tick', { method: 'POST' });
  assert.equal(nextTick.status, 200);
  const manual = await jsonRequest(baseUrl + '/api/v1/sync/itsm', { method: 'POST', cookie: user.cookie });
  assert.equal(manual.status, 200);
  const after = await mockSnapshot(mockUrl);
  assert.equal(manual.payload.revision, after.revision);
});
