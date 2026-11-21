'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store');

const APP_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(APP_ROOT, '../..');
const MOCK_ROOT = path.join(REPOSITORY_ROOT, 'services/itsm-mock');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempStore(t) {
  const store = new Store(tempDir(t, 'incident-pulse-notifications-'));
  t.after(() => {
    try { store.close(); } catch {
      // already closed
    }
  });
  return store;
}

function user(id, createdAt = Date.now(), role = 'coordinator') {
  return {
    id,
    name: `Пользователь ${id}`,
    login: `login-${id}`,
    loginNormalized: `login-${id}`,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    role,
    createdAt
  };
}

function notification(store, userId, overrides = {}) {
  return store.createNotification({
    userId,
    caseId: 'case-1',
    incidentId: 'INC-1',
    type: 'coordinator_assigned',
    title: 'Вам назначен инцидент',
    message: 'INC-1 · Инцидент',
    ...overrides
  });
}

test('createNotification persists all fields and lists newest first', (t) => {
  const store = tempStore(t);
  store.createUser(user('u1', 1));
  store.createUser(user('u2', 2));

  const first = notification(store, 'u1', { createdAt: 1000 });
  const second = notification(store, 'u1', {
    caseId: 'case-2',
    incidentId: 'INC-2',
    title: 'Второе',
    message: 'INC-2 · Второй',
    createdAt: 2000
  });
  notification(store, 'u2', { incidentId: 'INC-3', createdAt: 3000 });

  assert.deepEqual(first, {
    id: first.id,
    caseId: 'case-1',
    incidentId: 'INC-1',
    type: 'coordinator_assigned',
    title: 'Вам назначен инцидент',
    message: 'INC-1 · Инцидент',
    createdAt: 1000,
    readAt: null
  });
  assert.ok(Number.isInteger(first.id) && first.id > 0);
  assert.ok(second.id > first.id);

  const list = store.listNotifications('u1');
  assert.deepEqual(list.map(row => row.id), [second.id, first.id]);
  assert.equal(store.listNotifications('u2').length, 1);
  assert.equal(store.countUnreadNotifications('u1'), 2);
  assert.equal(store.countUnreadNotifications('u2'), 1);
  assert.equal(store.countUnreadNotifications('unknown'), 0);
});

test('listNotifications honors the limit and defaults to 50', (t) => {
  const store = tempStore(t);
  store.createUser(user('u1', 1));
  for (let index = 0; index < 55; index += 1) {
    notification(store, 'u1', { incidentId: `INC-${index}`, createdAt: index });
  }
  assert.equal(store.listNotifications('u1').length, 50);
  assert.equal(store.listNotifications('u1', 5).length, 5);
  assert.equal(store.listNotifications('u1', 500).length, 55);
  assert.equal(store.listNotifications('u1', 0).length, 1);
  assert.equal(store.listNotifications('u1')[0].incidentId, 'INC-54');
});

test('markNotificationRead only reads the owner notification and is idempotent', (t) => {
  const store = tempStore(t);
  store.createUser(user('u1', 1));
  store.createUser(user('u2', 2));
  const row = notification(store, 'u1', { createdAt: 10 });

  assert.equal(store.markNotificationRead(row.id, 'u2'), null);
  assert.equal(store.countUnreadNotifications('u1'), 1);
  assert.equal(store.getNotification(row.id).readAt, null);

  const read = store.markNotificationRead(row.id, 'u1', 20);
  assert.equal(read.id, row.id);
  assert.equal(read.readAt, 20);
  assert.equal(store.countUnreadNotifications('u1'), 0);
  assert.equal(store.listNotifications('u1')[0].readAt, 20);

  const again = store.markNotificationRead(row.id, 'u1', 30);
  assert.equal(again.readAt, 20);
  assert.equal(store.markNotificationRead(999999, 'u1'), null);
});

test('markAllNotificationsRead clears only the target user unread rows', (t) => {
  const store = tempStore(t);
  store.createUser(user('u1', 1));
  store.createUser(user('u2', 2));
  notification(store, 'u1', { createdAt: 10 });
  notification(store, 'u1', { createdAt: 11 });
  notification(store, 'u2', { createdAt: 12 });

  assert.equal(store.markAllNotificationsRead('u1', 50), 2);
  assert.equal(store.countUnreadNotifications('u1'), 0);
  assert.equal(store.countUnreadNotifications('u2'), 1);
  assert.ok(store.listNotifications('u1').every(row => row.readAt === 50));
  assert.equal(store.markAllNotificationsRead('u1', 60), 0);
  assert.equal(store.markAllNotificationsRead('unknown', 60), 0);
});

test('notifications cascade on user delete and survive a store reopen', (t) => {
  const dir = tempDir(t, 'incident-pulse-notifications-reopen-');
  let store = new Store(dir);
  store.createUser(user('u1', 1));
  store.createUser(user('u2', 2));
  const kept = notification(store, 'u2', { incidentId: 'INC-KEEP' });
  notification(store, 'u1');
  notification(store, 'u1');
  store.close();

  store = new Store(dir);
  t.after(() => store.close());
  assert.equal(store.listNotifications('u2').length, 1);
  assert.equal(store.listNotifications('u2')[0].id, kept.id);
  assert.equal(store.listNotifications('u1').length, 2);

  assert.equal(store.deleteUser('u1').id, 'u1');
  assert.equal(store.listNotifications('u1').length, 0);
  assert.equal(store.countUnreadNotifications('u1'), 0);
  assert.equal(store.listNotifications('u2').length, 1);
});

// --- HTTP + SSE integration -------------------------------------------------
// Spawns the real ITSM mock and the app against temporary data directories and
// verifies the full coordinator-assignment flow, including targeted SSE.

function waitForOutput(child, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${pattern}; output: ${buffer.slice(-2000)}`));
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
      reject(new Error(`child exited early (code ${code}, signal ${signal}); output: ${buffer.slice(-2000)}`));
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

async function waitForCondition(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
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
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload };
}

async function register(baseUrl, name, login) {
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, login, password: 'secret-pass' })
  });
  if (response.status !== 201) throw new Error(await response.text());
  const payload = await response.json();
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  return { user: payload.user, cookie };
}

function openSse(baseUrl, cookie) {
  const controller = new AbortController();
  const state = { text: '', error: null, controller };
  const ready = fetch(`${baseUrl}/api/v1/events`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controller.signal
  }).then((response) => {
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          state.text += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        if (error.name !== 'AbortError') state.error = error;
      }
    })();
    return response;
  });
  return { state, ready };
}

test('notification API and targeted SSE for coordinator assignment', { timeout: 60000 }, async (t) => {
  const mockDir = tempDir(t, 'incident-pulse-notify-mock-');
  const appDir = tempDir(t, 'incident-pulse-notify-app-');
  const mock = startService(MOCK_ROOT, /itsm-mock listening on port (\d+)/, {
    PORT: '0',
    DATA_DIR: mockDir
  });
  t.after(() => stopChild(mock.child));
  const mockPort = Number((await mock.ready)[1]);
  const mockUrl = `http://127.0.0.1:${mockPort}`;

  const app = startService(APP_ROOT, /listening on (\d+); ITSM mock:/, {
    PORT: '0',
    DATA_DIR: appDir,
    ITSM_MOCK_URL: mockUrl,
    POLL_INTERVAL_MS: '3600000',
    SESSION_TTL_MS: '600000'
  });
  t.after(() => stopChild(app.child));
  const appPort = Number((await app.ready)[1]);
  const baseUrl = `http://127.0.0.1:${appPort}`;

  const actor = await register(baseUrl, 'Актор', 'actor');
  const target = await register(baseUrl, 'Цель', 'target');

  const tick = await jsonRequest(`${mockUrl}/itsm/demo/tick`, { method: 'POST' });
  assert.equal(tick.status, 200);
  const sync = await jsonRequest(`${baseUrl}/api/v1/sync/itsm`, { method: 'POST', cookie: actor.cookie });
  assert.equal(sync.status, 200, JSON.stringify(sync.payload));

  const incidents = (await jsonRequest(`${baseUrl}/api/v1/incidents`, { cookie: actor.cookie })).payload.incidents;
  assert.ok(incidents.length > 0, 'expected at least one incident after mock tick');
  const incident = incidents.find(row => !row.coordinatorId);
  assert.ok(incident, 'expected an unassigned incident');

  const actorSse = openSse(baseUrl, actor.cookie);
  const targetSse = openSse(baseUrl, target.cookie);
  t.after(() => {
    actorSse.state.controller.abort();
    targetSse.state.controller.abort();
  });
  await Promise.all([actorSse.ready, targetSse.ready]);
  await waitForCondition(
    () => actorSse.state.text.includes(': connected') && targetSse.state.text.includes(': connected'),
    'SSE did not connect'
  );

  const assignment = await jsonRequest(`${baseUrl}/api/v1/incidents/${encodeURIComponent(incident.caseId)}/coordinator`, {
    method: 'POST',
    cookie: actor.cookie,
    body: { coordinatorId: target.user.id, expectedVersion: incident.version }
  });
  assert.equal(assignment.status, 200, JSON.stringify(assignment.payload));
  assert.equal(assignment.payload.incident.coordinatorId, target.user.id);

  const match = await waitForCondition(
    () => targetSse.state.text.match(/event: notification\ndata: (\{[^\n]+\})\n\n/),
    `no targeted notification event; received: ${targetSse.state.text}`
  );
  assert.equal(targetSse.state.error, null);
  const event = JSON.parse(match[1]);
  assert.equal(event.type, 'notification.created');
  assert.equal(event.unread, 1);
  assert.equal(event.notification.type, 'coordinator_assigned');
  assert.equal(event.notification.title, 'Вам назначен инцидент');
  assert.equal(event.notification.caseId, incident.caseId);
  assert.equal(event.notification.incidentId, incident.id);
  assert.equal(event.notification.message, `${incident.id} · ${incident.title}`);
  assert.equal(event.notification.readAt, null);

  // The targeted notification must not leak to another user's SSE stream, while
  // the global incident broadcast keeps working for every authenticated client.
  await waitForCondition(
    () => actorSse.state.text.includes('event: incidents'),
    `actor did not receive the global incidents event; received: ${actorSse.state.text}`
  );
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(actorSse.state.text.includes('event: notification'), false);
  assert.equal(actorSse.state.error, null);

  const actorList = await jsonRequest(`${baseUrl}/api/v1/notifications`, { cookie: actor.cookie });
  assert.equal(actorList.status, 200);
  assert.deepEqual(actorList.payload, { notifications: [], unread: 0 });

  const targetList = await jsonRequest(`${baseUrl}/api/v1/notifications`, { cookie: target.cookie });
  assert.equal(targetList.status, 200);
  assert.equal(targetList.payload.unread, 1);
  assert.equal(targetList.payload.notifications.length, 1);
  const stored = targetList.payload.notifications[0];
  assert.deepEqual(
    { caseId: stored.caseId, incidentId: stored.incidentId, type: stored.type, readAt: stored.readAt },
    { caseId: incident.caseId, incidentId: incident.id, type: 'coordinator_assigned', readAt: null }
  );

  const foreignRead = await jsonRequest(`${baseUrl}/api/v1/notifications/${stored.id}/read`, {
    method: 'POST',
    cookie: actor.cookie
  });
  assert.equal(foreignRead.status, 404);

  const ownRead = await jsonRequest(`${baseUrl}/api/v1/notifications/${stored.id}/read`, {
    method: 'POST',
    cookie: target.cookie
  });
  assert.equal(ownRead.status, 200);
  assert.deepEqual(ownRead.payload, { ok: true, unread: 0 });

  const missingRead = await jsonRequest(`${baseUrl}/api/v1/notifications/999999/read`, {
    method: 'POST',
    cookie: target.cookie
  });
  assert.equal(missingRead.status, 404);

  // A second assignment produces another unread notification, cleared by read-all.
  // Demo steps 1-2 update the same case, step 3 introduces a new unassigned case.
  for (let step = 0; step < 3; step += 1) {
    const tickResponse = await jsonRequest(`${mockUrl}/itsm/demo/tick`, { method: 'POST' });
    assert.equal(tickResponse.status, 200);
  }
  const secondSync = await jsonRequest(`${baseUrl}/api/v1/sync/itsm`, { method: 'POST', cookie: actor.cookie });
  assert.equal(secondSync.status, 200);
  const after = (await jsonRequest(`${baseUrl}/api/v1/incidents`, { cookie: actor.cookie })).payload.incidents;
  const secondIncident = after.find(row => !row.coordinatorId && row.caseId !== incident.caseId);
  assert.ok(secondIncident, 'expected a second unassigned incident');
  const secondAssignment = await jsonRequest(
    `${baseUrl}/api/v1/incidents/${encodeURIComponent(secondIncident.caseId)}/coordinator`,
    {
      method: 'POST',
      cookie: actor.cookie,
      body: { coordinatorId: target.user.id, expectedVersion: secondIncident.version }
    }
  );
  assert.equal(secondAssignment.status, 200, JSON.stringify(secondAssignment.payload));

  const unreadAgain = await jsonRequest(`${baseUrl}/api/v1/notifications`, { cookie: target.cookie });
  assert.equal(unreadAgain.payload.unread, 1);
  assert.equal(unreadAgain.payload.notifications.length, 2);
  const readAll = await jsonRequest(`${baseUrl}/api/v1/notifications/read-all`, {
    method: 'POST',
    cookie: target.cookie
  });
  assert.equal(readAll.status, 200);
  assert.deepEqual(readAll.payload, { ok: true, unread: 0 });
  const cleared = await jsonRequest(`${baseUrl}/api/v1/notifications`, { cookie: target.cookie });
  assert.equal(cleared.payload.unread, 0);
  assert.ok(cleared.payload.notifications.every(row => typeof row.readAt === 'number'));
});
