'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store');

const APP_ROOT = path.resolve(__dirname, '..');

function raw(overrides = {}) {
  return {
    id: 'INC-1', correlationKey: 'corr-1', version: 1, stateId: 0, priorityId: 2,
    affectedUsers: 10, reportCount: 1, submitDate: '2026-01-01T00:00:00.000Z',
    deadline: null, completionDate: null, updatedAt: '2026-01-01T00:00:00.000Z',
    header: 'Инцидент', description: 'Описание', productName: 'Mobile voice',
    service: 'Голосовая связь', scenarioName: 'Звонок', region: 'Москва',
    assignedGroupName: null, coordinatorId: null, coordinatorName: null,
    solution: null, priorityOverrideId: null, isNeedUp: false, isMaster: false, isEffect: false,
    ...overrides
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-pulse-hardening-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function waitForOutput(child, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + pattern + '; ' + buffer.slice(-2000))), timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString();
      const match = buffer.match(pattern);
      if (match) { clearTimeout(timer); resolve(match); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function startApp(dataDir, env = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      STATIC_DIR: path.resolve(APP_ROOT, '..', '..'),
      ITSM_MOCK_URL: 'http://127.0.0.1:1',
      POLL_INTERVAL_MS: '100',
      DEMO_GENERATION: 'false',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { child, ready: waitForOutput(child, /listening on (\d+); ITSM mock:/) };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

async function register(baseUrl, login, password = 'secret-pass') {
  const response = await fetch(baseUrl + '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'QA ' + login, login, password })
  });
  const payload = await response.json();
  const cookie = response.headers.getSetCookie()[0] ? response.headers.getSetCookie()[0].split(';')[0] : null;
  return { status: response.status, payload, cookie };
}

async function request(baseUrl, pathName, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(baseUrl + pathName, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : null };
}

test('registration can be closed and rejects short passwords', async (t) => {
  const dir = tempDir(t);
  const app = startApp(dir, { REGISTRATION_ENABLED: 'false' });
  t.after(() => stop(app.child));
  const match = await app.ready;
  const baseUrl = 'http://127.0.0.1:' + match[1];
  const closed = await register(baseUrl, 'closed');
  assert.equal(closed.status, 403);
  assert.equal(closed.payload.code, 'registration_disabled');
  await stop(app.child);

  const open = startApp(tempDir(t));
  t.after(() => stop(open.child));
  const openMatch = await open.ready;
  const openBase = 'http://127.0.0.1:' + openMatch[1];
  const short = await register(openBase, 'short', '1234567');
  assert.equal(short.status, 400);
  assert.match(short.payload.error, /не менее 8/);
});

test('closed cases, unknown teams and foreign claims are rejected', async (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  store.applyDelta([
    raw({ id: 'INC-ACTIVE', correlationKey: 'active', stateId: 0, coordinatorId: 'other', coordinatorName: 'Другой' }),
    raw({ id: 'INC-CLOSED', correlationKey: 'closed', stateId: 7, version: 2, completionDate: '2026-01-02T00:00:00.000Z' })
  ], 1);
  store.close();

  const app = startApp(dir);
  t.after(() => stop(app.child));
  const match = await app.ready;
  const baseUrl = 'http://127.0.0.1:' + match[1];
  const registered = await register(baseUrl, 'qa-admin');
  assert.equal(registered.status, 201);
  const cookie = registered.cookie;

  const dashboard = await request(baseUrl, '/api/v1/incidents', { cookie });
  assert.equal(dashboard.status, 200);
  const active = dashboard.payload.incidents.find(item => item.id === 'INC-ACTIVE');
  const closedCase = dashboard.payload.incidents.find(item => item.id === 'INC-CLOSED');
  assert.ok(active && closedCase);

  const ready = await request(baseUrl, '/api/v1/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.payload.db, 'ok');

  const unknownTeam = await request(baseUrl, '/api/v1/incidents/' + active.caseId + '/team', {
    cookie, method: 'POST', body: { team: 'evil-team', expectedVersion: active.version }
  });
  assert.equal(unknownTeam.status, 400);
  assert.equal(unknownTeam.payload.code, 'unknown_team');

  const foreignClaim = await request(baseUrl, '/api/v1/incidents/' + active.caseId + '/claim', {
    cookie, method: 'POST', body: { expectedVersion: active.version }
  });
  assert.equal(foreignClaim.status, 409);
  assert.equal(foreignClaim.payload.code, 'already_assigned');

  const priorityAfterClose = await request(baseUrl, '/api/v1/incidents/' + closedCase.caseId + '/priority', {
    cookie, method: 'POST', body: { priorityId: 1, expectedVersion: closedCase.version }
  });
  assert.equal(priorityAfterClose.status, 409);
  assert.equal(priorityAfterClose.payload.code, 'case_closed');
});
