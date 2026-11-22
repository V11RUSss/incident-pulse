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

async function openSse(url, cookie = null) {
  const controller = new AbortController();
  const headers = { accept: 'text/event-stream' };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(url, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = '';
  const waiters = new Set();
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += Buffer.from(chunk.value).toString('utf8');
        for (const waiter of [...waiters]) waiter();
      }
    } catch {
      // aborted connection
    }
  })();
  return {
    get buffer() { return buffer; },
    waitFor(pattern, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!pattern.test(buffer)) return false;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(buffer);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error('timeout waiting for ' + pattern + '; SSE tail: ' + buffer.slice(-1500)));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close: async () => {
      controller.abort();
      try { await reader.cancel(); } catch { /* already closed */ }
      await pump;
    }
  };
}

function createUser(store, id) {
  store.createUser({
    id,
    name: 'Секретное Имя ' + id,
    login: 'login-' + id,
    loginNormalized: 'login-' + id,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    role: 'coordinator',
    createdAt: 1
  });
}

function seedWallCases(dataDir) {
  const store = new Store(dataDir);
  try {
    createUser(store, 'u-actor');
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    store.applyDelta([
      raw({
        id: 'WALL-CRIT',
        correlationKey: 'wall-crit',
        priorityId: 4,
        affectedUsers: 1200,
        header: 'Критический сбой голоса',
        productName: 'Mobile voice',
        region: 'Москва',
        assignedGroupName: 'Mobile voice',
        coordinatorId: 'u-coord',
        coordinatorName: 'Иван Петров',
        deadline: soon
      }),
      raw({
        id: 'WALL-HIGH',
        correlationKey: 'wall-high',
        priorityId: 3,
        affectedUsers: 500,
        header: 'Высокий риск оплаты',
        productName: 'MTS Bank',
        region: 'Москва',
        assignedGroupName: 'MTS Bank',
        deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      }),
      raw({
        id: 'WALL-FREE',
        correlationKey: 'wall-free',
        priorityId: 2,
        affectedUsers: 50,
        header: 'Без команды',
        productName: 'MTS ID',
        region: 'Регионы',
        assignedGroupName: null
      })
    ], 1);
    const target = store.listCases().find(incident => incident.id === 'WALL-CRIT');
    store.recordHistory({
      caseId: target.caseId,
      user: { id: 'u-actor', name: 'Секретное Имя u-actor' },
      action: 'priority',
      details: { coordinatorName: 'Иван Петров' }
    });
  } finally {
    store.close();
  }
}

async function mockSnapshot(mockUrl) {
  const snapshot = await jsonRequest(mockUrl + '/itsm/incidents');
  assert.equal(snapshot.status, 200);
  return snapshot.payload;
}

test('public wallboard and /wall are anonymous, aggregate-only and contain no personal names', { timeout: 90000 }, async (t) => {
  const dataDir = tempDir(t, 'incident-pulse-wall-data-');
  seedWallCases(dataDir);
  const staticDir = tempDir(t, 'incident-pulse-wall-static-');
  fs.writeFileSync(path.join(staticDir, 'wall.html'), '<!doctype html><html><head><title>Public Wall</title></head><body>wall</body></html>');

  const app = startApp(dataDir, { STATIC_DIR: staticDir });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);

  const page = await fetch(baseUrl + '/wall');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Public Wall/);

  const wallboard = await jsonRequest(baseUrl + '/api/v1/wallboard');
  assert.equal(wallboard.status, 200);
  const board = wallboard.payload;
  assert.equal(typeof board.generatedAt, 'number');
  assert.equal(typeof board.live, 'boolean');
  assert.deepEqual(
    Object.keys(board.counts).sort(),
    ['active', 'affectedUsers', 'coordination', 'critical', 'high', 'research', 'risk']
  );
  assert.equal(board.counts.active, 3);
  assert.equal(board.critical.length, 1);
  assert.equal(board.critical[0].incidentId, 'WALL-CRIT');
  assert.equal(board.high.length, 1);
  assert.equal(board.high[0].incidentId, 'WALL-HIGH');
  assert.ok(board.slaRisk.some(item => item.incidentId === 'WALL-CRIT'));
  assert.ok(board.slaRisk.every(item => typeof item.remainingMs === 'number'));
  assert.ok(board.teams.some(team => team.team === 'Mobile voice' && team.total === 1));
  assert.ok(board.products.some(product => product.product === 'MTS ID'));
  assert.ok(board.regions.some(region => region.region === 'Регионы'));
  assert.ok(board.unassigned.count >= 1);
  assert.ok(board.unassigned.cases.some(item => item.incidentId === 'WALL-FREE'));
  assert.ok(Array.isArray(board.recent));
  assert.ok(board.recent.some(item => item.action === 'priority'));
  assert.deepEqual(board.recentChanges, board.recent);

  for (const item of [...board.critical, ...board.high, ...board.unassigned.cases]) {
    assert.equal(Object.hasOwn(item, 'coordinatorName'), false);
    assert.equal(Object.hasOwn(item, 'coordinatorId'), false);
  }
  const serialized = JSON.stringify(board);
  assert.equal(/coordinatorName|coordinatorId|userName|Секретное Имя|Иван Петров/.test(serialized), false);

  const mutation = await jsonRequest(baseUrl + '/api/v1/wallboard', { method: 'POST' });
  assert.equal(mutation.status, 401);
});

test('wall SSE is public, does not enable demo generation, receives updates; coordinator SSE still does', { timeout: 120000 }, async (t) => {
  const mock = startMock(tempDir(t, 'incident-pulse-wall-mock-'));
  t.after(() => stopChild(mock.child));
  const mockUrl = 'http://127.0.0.1:' + Number((await mock.ready)[1]);

  const app = startApp(tempDir(t, 'incident-pulse-wall-live-'), {
    ITSM_MOCK_URL: mockUrl
  });
  t.after(() => stopChild(app.child));
  const baseUrl = 'http://127.0.0.1:' + Number((await app.ready)[1]);
  const user = await register(baseUrl, 'Wall', 'wall-user');

  const wall = await openSse(baseUrl + '/wall/events');
  t.after(() => wall.close());
  await wall.waitFor(/event: wallboard/);
  const initial = wall.buffer;
  assert.match(initial, /"counts"/);

  // Only the public wall is connected: auto demo must stay off.
  await delay(1300);
  const beforeManual = await mockSnapshot(mockUrl);
  assert.equal(beforeManual.revision, 0, 'public wall SSE must not enable demo generation');

  // Manual one-shot sync is explicitly allowed to create a tick and the wall
  // must receive the resulting incident update.
  const manual = await jsonRequest(baseUrl + '/api/v1/sync/itsm', { method: 'POST', cookie: user.cookie });
  assert.equal(manual.status, 200);
  assert.ok(manual.payload.demo);
  await wall.waitFor(/event: incidents/);
  const afterManual = await mockSnapshot(mockUrl);
  assert.equal(afterManual.revision, 1);
  await wall.close();

  // Coordinator /events has its own set and still enables auto generation.
  const coordinator = await openSse(baseUrl + '/api/v1/events', user.cookie);
  t.after(() => coordinator.close());
  const advanced = await waitForCondition(async () => {
    const snapshot = await mockSnapshot(mockUrl);
    return snapshot.revision >= 2;
  }, 8000, 100);
  assert.equal(advanced, true, 'coordinator SSE must still enable auto demo');
  await coordinator.waitFor(/event: incidents/);
});
