'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/store');
const { Auth } = require('../src/auth');

function raw(overrides = {}) {
  return {
    id: 'INC-1',
    correlationKey: 'corr-1',
    version: 1,
    stateId: 0,
    priorityId: 1,
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

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-pulse-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempStore(t) {
  const dir = tempDir(t);
  const store = new Store(dir);
  t.after(() => {
    try { store.close(); } catch {
      // already closed
    }
  });
  return store;
}

function user(id, createdAt, role = 'coordinator') {
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

test('applyDelta is idempotent for a repeated record', (t) => {
  const store = tempStore(t);
  const first = store.applyDelta([raw()], 1);
  assert.equal(first.added, 1);
  assert.equal(first.updated, 0);
  const before = store.listCases()[0];
  assert.equal(before.affectedUsers, 10);
  const second = store.applyDelta([raw()], 1);
  assert.deepEqual(
    { added: second.added, updated: second.updated, unchanged: second.unchanged, stale: second.stale },
    { added: 0, updated: 0, unchanged: 1, stale: 0 }
  );
  const after = store.getCase(before.caseId);
  assert.equal(after.version, before.version);
  assert.equal(after.affectedUsers, 10);
});

test('applyDelta ignores stale record versions', (t) => {
  const store = tempStore(t);
  store.applyDelta([raw()], 2);
  const before = store.listCases()[0];
  const result = store.applyDelta([raw({ version: 0, affectedUsers: 999 })], 2);
  assert.equal(result.stale, 1);
  assert.equal(result.added, 0);
  const after = store.getCase(before.caseId);
  assert.equal(after.affectedUsers, 10);
  assert.equal(after.version, before.version);
});

test('empty delta at the current revision does not rebuild cases or bump versions', (t) => {
  const store = tempStore(t);
  store.applyDelta([raw()], 3);
  const before = store.listCases()[0];
  const result = store.applyDelta([], 3, 123456);
  assert.deepEqual(result, {
    added: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    rejected: [],
    revision: 3,
    lastSyncedAt: 123456,
    syncError: null
  });
  const after = store.getCase(before.caseId);
  assert.equal(after.version, before.version);
  assert.equal(store.getSyncState().lastSyncedAt, 123456);
  assert.equal(store.getSyncState().syncError, null);
  assert.equal(store.getCurrentRevision(), 3);
});

test('activeSourceIds exposes only active source records of a mixed case', (t) => {
  const store = tempStore(t);
  store.applyDelta([
    raw({ id: 'INC-ACTIVE', correlationKey: 'mixed', stateId: 0 }),
    raw({
      id: 'INC-CLOSED', correlationKey: 'mixed', stateId: 7, version: 2,
      solution: 'исправлено', completionDate: '2026-01-02T00:00:00.000Z'
    })
  ], 1);
  const incident = store.listCases()[0];
  assert.equal(incident.sourceIds.length, 2);
  assert.deepEqual(store.activeSourceIds(incident.caseId), ['INC-ACTIVE']);
});

test('markUnreadAssignmentsForCase clears older duplicates for the same case', (t) => {
  const store = tempStore(t);
  store.createUser(user('u1', 1));
  store.createNotification({
    userId: 'u1', caseId: 'case-1', incidentId: 'INC-1', type: 'coordinator_assigned',
    title: 'Назначение', message: 'first', createdAt: 1
  });
  store.createNotification({
    userId: 'u1', caseId: 'case-1', incidentId: 'INC-1', type: 'coordinator_assigned',
    title: 'Назначение', message: 'second', createdAt: 2
  });
  assert.equal(store.countUnreadNotifications('u1'), 2);
  assert.equal(store.markUnreadAssignmentsForCase('u1', 'case-1'), 2);
  assert.equal(store.countUnreadNotifications('u1'), 0);
});

test('applyDelta dead-letters malformed records without blocking valid ones', (t) => {
  const store = tempStore(t);
  const result = store.applyDelta([
    raw({ id: 'BAD-1', stateId: 99 }),
    raw({ id: 'GOOD-1', version: 1, affectedUsers: 20, correlationKey: 'good-1' })
  ], 5);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].id, 'BAD-1');
  assert.match(result.syncError, /некорректных записей/);
  assert.equal(result.added, 1);
  assert.equal(store.getCurrentRevision(), 5);
  assert.equal(store.listCases().length, 1);
  assert.equal(store.listSyncFailures(5)[0].incidentId, 'BAD-1');
  assert.equal(store.getSyncState().syncError, result.syncError);
  const clean = store.applyDelta([raw({ id: 'GOOD-1', version: 2, affectedUsers: 25, correlationKey: 'good-1' })], 6);
  assert.equal(clean.rejected.length, 0);
  assert.equal(store.getSyncState().syncError, null);
});

test('backup writes a consistent snapshot file', (t) => {
  const store = tempStore(t);
  store.applyDelta([raw()], 1);
  const file = store.backup('test');
  assert.ok(fs.existsSync(file));
  assert.ok(fs.statSync(file).size > 0);
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM cases').get().count, 1);
  } finally {
    copy.close();
  }
});

test('resetSyncState clears cases and history and accepts a fresh snapshot', (t) => {
  const store = tempStore(t);
  store.createUser(user('u1', 1));
  store.applyDelta([raw()], 4);
  const caseId = store.listCases()[0].caseId;
  store.recordHistory({
    caseId,
    user: { id: 'u1', name: 'Пользователь' },
    action: 'test',
    details: {}
  });
  assert.equal(store.listHistory(caseId).length, 1);
  store.createNotification({
    userId: 'u1',
    caseId,
    incidentId: 'MTS-TEST-0001',
    type: 'coordinator_assigned',
    title: 'Вам назначен инцидент',
    message: 'MTS-TEST-0001 · Тестовый инцидент'
  });
  assert.equal(store.listNotifications('u1').length, 1);
  store.resetSyncState();
  assert.equal(store.listCases().length, 0);
  assert.equal(store.getCurrentRevision(), 0);
  assert.equal(store.listHistory(caseId).length, 0);
  const keptNotifications = store.listNotifications('u1');
  assert.equal(keptNotifications.length, 1);
  assert.ok(keptNotifications[0].readAt);
  const result = store.applyDelta([raw({ version: 2, affectedUsers: 600 })], 9);
  assert.equal(result.added, 1);
  assert.equal(store.getCurrentRevision(), 9);
  assert.equal(store.listCases()[0].affectedUsers, 600);
  assert.equal(store.listCases()[0].activeAffectedUsers, 600);
});

test('Store promotes the earliest user when the database has no admin', (t) => {
  const dir = tempDir(t);
  let store = new Store(dir);
  store.createUser(user('u1', 1));
  store.createUser(user('u2', 2));
  assert.equal(store.countAdmins(), 0);
  store.close();
  store = new Store(dir);
  t.after(() => store.close());
  assert.equal(store.getUserById('u1').role, 'admin');
  assert.equal(store.getUserById('u2').role, 'coordinator');
  assert.equal(store.countAdmins(), 1);
});


test('Store migrates an existing users table without a role column', (t) => {
  const dir = tempDir(t);
  const db = new DatabaseSync(path.join(dir, 'incident-pulse.sqlite'));
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      login TEXT NOT NULL,
      login_normalized TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO users (id, name, login, login_normalized, password_hash, password_salt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('u-old', 'Старый', 'old', 'old', 'hash', 'salt', 5);
  db.close();
  const store = new Store(dir);
  t.after(() => store.close());
  assert.equal(store.getUserById('u-old').role, 'admin');
  assert.equal(store.countAdmins(), 1);
});
test('the first registered user becomes admin and the next one a coordinator', async (t) => {
  const store = tempStore(t);
  const auth = new Auth(store);
  const first = await auth.register({ name: 'Первый', login: 'first', password: 'secret-pass' });
  const second = await auth.register({ name: 'Второй', login: 'second', password: 'secret-pass' });
  assert.equal(first.user.role, 'admin');
  assert.equal(second.user.role, 'coordinator');
  const session = await auth.login({ login: 'FIRST', password: 'secret-pass' });
  assert.equal(session.user.role, 'admin');
});

test('user sessions cascade on delete and audit rows stay readable', (t) => {
  const store = tempStore(t);
  store.createUser(user('u1', 1));
  store.createSession({ tokenHash: 'hash-1', userId: 'u1', createdAt: 10, expiresAt: Date.now() + 1000 });
  store.createSession({ tokenHash: 'hash-2', userId: 'u1', createdAt: 20, expiresAt: Date.now() + 1000 });
  const listed = store.listUsersWithSessions();
  assert.equal(listed[0].sessionCount, 2);
  assert.equal(listed[0].lastSessionAt, 20);
  assert.equal(store.deleteUserSessions('u1'), 2);
  assert.equal(store.countSessions(Date.now()), 0);
  store.recordAudit({
    user: { id: 'admin-1', name: 'Администратор' },
    action: 'user.delete',
    targetType: 'user',
    targetId: 'u1',
    details: { login: 'login-u1' }
  });
  assert.equal(store.deleteUser('u1').id, 'u1');
  assert.equal(store.getUserById('u1'), null);
  const audit = store.listAudit(10);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'user.delete');
  assert.equal(audit[0].targetId, 'u1');
  assert.deepEqual(audit[0].details, { login: 'login-u1' });
});
