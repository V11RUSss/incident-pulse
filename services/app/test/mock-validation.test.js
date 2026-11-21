'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STORE_MODULE_URL = pathToFileURL(path.resolve(__dirname, '../../itsm-mock/src/store.js')).href;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-pulse-mock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function makeStore(t) {
  const { IncidentStore, StoreError } = await import(STORE_MODULE_URL);
  const dir = tempDir(t);
  const store = new IncidentStore({ dataDir: dir });
  await store.init();
  await store.tick();
  return { store, StoreError };
}

test('mock patch validation rejects invalid known fields', async (t) => {
  const { store, StoreError } = await makeStore(t);
  const cases = [
    [{ stateId: 5 }, /stateId/],
    [{ stateId: '2' }, /stateId/],
    [{ priorityId: 9 }, /priorityId/],
    [{ priorityOverrideId: 0 }, /priorityOverrideId/],
    [{ affectedUsers: -1 }, /affectedUsers/],
    [{ affectedUsers: 1.5 }, /affectedUsers/],
    [{ reportCount: '3' }, /reportCount/],
    [{ submitDate: 'not-a-date' }, /submitDate/],
    [{ deadline: '2026-13-01T00:00:00Z' }, /deadline/],
    [{ header: 42 }, /header/],
    [{ assignedGroupName: 7 }, /assignedGroupName/],
    [{ solution: 1 }, /solution/],
    [{ isNeedUp: 'yes' }, /isNeedUp/]
  ];
  for (const [patch, pattern] of cases) {
    assert.throws(() => store.patch('MTS-MOBILE-0001', patch), (error) => {
      assert.equal(error instanceof StoreError, true);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, pattern);
      return true;
    });
  }
  assert.throws(() => store.bulkUpdate({ ids: ['MTS-MOBILE-0001'], patch: { stateId: 99 } }), (error) => {
    assert.equal(error instanceof StoreError, true);
    assert.match(error.message, /stateId/);
    return true;
  });
});

test('mock patch keeps version and updatedAt immutable', async (t) => {
  const { store, StoreError } = await makeStore(t);
  for (const patch of [{ version: 2 }, { updatedAt: '2026-01-01T00:00:00.000Z' }]) {
    assert.throws(() => store.patch('MTS-MOBILE-0001', patch), (error) => {
      assert.equal(error instanceof StoreError, true);
      assert.match(error.message, /version and updatedAt/);
      return true;
    });
  }
});

test('mock patch accepts valid known fields and rejects unknown fields', async (t) => {
  const { store, StoreError } = await makeStore(t);
  const result = await store.patch('MTS-MOBILE-0001', {
    affectedUsers: 1000,
    isNeedUp: true,
    assignedGroupName: null
  });
  assert.equal(result.updated, 1);
  assert.equal(result.incident.affectedUsers, 1000);
  assert.equal(result.incident.isNeedUp, true);
  assert.equal(Object.hasOwn(result.incident, 'customField'), false);
  assert.ok(result.incident.version > 1);

  assert.throws(() => store.patch('MTS-MOBILE-0001', { customField: 'allowed' }), (error) => {
    assert.equal(error instanceof StoreError, true);
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, 'Patch field customField is not supported');
    return true;
  });
});

test('mock snapshot reports revision_ahead with current revision', async (t) => {
  const { store, StoreError } = await makeStore(t);
  const current = store.snapshot().revision;
  assert.throws(() => store.snapshot(current + 1), (error) => {
    assert.equal(error instanceof StoreError, true);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, 'revision_ahead');
    assert.equal(error.revision, current);
    return true;
  });
});

test('mock critical() creates a unique critical record and increments revision', async (t) => {
  const { store } = await makeStore(t);
  const startRevision = store.snapshot().revision;
  const first = await store.critical();
  const second = await store.critical();
  assert.equal(first.added, 1);
  assert.equal(first.revision, startRevision + 1);
  assert.equal(second.revision, startRevision + 2);
  assert.notEqual(first.incident.id, second.incident.id);
  assert.notEqual(first.incident.correlationKey, second.incident.correlationKey);
  for (const { incident } of [first, second]) {
    assert.ok(incident.affectedUsers >= 1200 && incident.affectedUsers <= 3000);
    assert.equal(incident.stateId, 0);
    assert.equal(incident.isNeedUp, true);
    assert.equal(incident.version, 1);
    const delayMs = Date.parse(incident.deadline) - Date.parse(incident.submitDate);
    assert.ok(delayMs >= 10 * 60 * 1000 && delayMs <= 15 * 60 * 1000);
  }
});

test('mock reset() returns to revision zero with an empty state', async (t) => {
  const { store } = await makeStore(t);
  await store.critical();
  const result = await store.reset();
  assert.deepEqual(result, { revision: 0, incidents: [] });
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual(store.snapshot().incidents, []);
});

test('mock quarantines a corrupt state file instead of failing to start', async (t) => {
  const { IncidentStore } = await import(STORE_MODULE_URL);
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'state.json'), '{ not json', 'utf8');
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    const store = new IncidentStore({ dataDir: dir });
    await store.init();
    assert.equal(store.snapshot().revision, 0);
    assert.deepEqual(store.snapshot().incidents, []);
  } finally {
    console.warn = originalWarn;
  }
  const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(warnings.length, 1);
});
