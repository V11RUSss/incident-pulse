import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncidentStore, StoreError } from '../src/store.js';

const BASE_ID = 'MTS-MOBILE-0001';

async function createStore(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'itsm-mock-patch-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new IncidentStore({ dataDir });
  await store.init();
  await store.tick();
  return store;
}

test('patch rejects unknown fields instead of merging them', async (t) => {
  const store = await createStore(t);
  const before = store.get(BASE_ID);
  const revision = store.snapshot().revision;

  for (const patch of [
    { title: 'x' },
    { status: 'nope' },
    { customField: 'allowed' },
    { affectedUsers: before.affectedUsers + 1, title: 'x' },
  ]) {
    assert.throws(() => store.patch(BASE_ID, patch), (error) => {
      assert.equal(error instanceof StoreError, true);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /^Patch field \w+ is not supported$/);
      return true;
    });
    assert.throws(() => store.bulkUpdate({ ids: [BASE_ID], patch }), (error) => {
      assert.equal(error instanceof StoreError, true);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /is not supported$/);
      return true;
    });
  }

  assert.deepEqual(store.get(BASE_ID), before);
  assert.equal(store.snapshot().revision, revision);
});

test('empty or no-op patch does not bump version or revision', async (t) => {
  const store = await createStore(t);
  const before = store.get(BASE_ID);
  const revision = store.snapshot().revision;

  const empty = await store.patch(BASE_ID, {});
  assert.equal(empty.updated, 0);
  assert.deepEqual(empty.incident, before);

  const noop = await store.patch(BASE_ID, {
    stateId: before.stateId,
    affectedUsers: before.affectedUsers,
  });
  assert.equal(noop.updated, 0);
  assert.deepEqual(noop.incident, before);

  const bulk = await store.bulkUpdate({ ids: [BASE_ID], patch: {} });
  assert.equal(bulk.updated, 0);
  assert.equal(bulk.revision, revision);

  assert.deepEqual(store.get(BASE_ID), before);
  assert.equal(store.snapshot().revision, revision);
});

test('bulk-update accepts exactly the fields the app patches', async (t) => {
  const store = await createStore(t);
  const before = store.get(BASE_ID);
  const revision = store.snapshot().revision;

  const result = await store.bulkUpdate({
    ids: [BASE_ID],
    patch: {
      coordinatorId: 'user-1',
      coordinatorName: 'Анна Кузнецова',
      priorityOverrideId: 3,
      deadline: '2026-01-01T01:00:00.000Z',
      assignedGroupName: 'Линия 2',
      stateId: 2,
      solution: 'Обходной путь',
      completionDate: null,
    },
  });

  assert.equal(result.updated, 1);
  assert.equal(result.revision, revision + 1);
  const record = store.get(BASE_ID);
  assert.equal(record.version, before.version + 1);
  assert.equal(record.coordinatorId, 'user-1');
  assert.equal(record.coordinatorName, 'Анна Кузнецова');
  assert.equal(record.priorityOverrideId, 3);
  assert.equal(record.deadline, '2026-01-01T01:00:00.000Z');
  assert.equal(record.assignedGroupName, 'Линия 2');
  assert.equal(record.stateId, 2);
  assert.equal(record.solution, 'Обходной путь');
  assert.equal(record.completionDate, null);
});
