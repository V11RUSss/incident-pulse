import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CRITICAL_EVERY, generateDemoIncident } from '../src/generator.js';
import { IncidentStore } from '../src/store.js';

const CONTINUATION_START = 12;
const TICK_COUNT = 40;
const NOW = '2026-01-01T00:00:00.000Z';

function isCritical(record) {
  return record.affectedUsers >= 1000 || record.priorityId === 4;
}

test('40 demo ticks keep ids unique, criticals regular and impact monotonic', () => {
  const records = new Map();
  const criticalTicks = [];

  for (let demoStep = 0; demoStep < TICK_COUNT; demoStep += 1) {
    const before = new Map([...records].map(([id, record]) => [id, record.affectedUsers]));
    const result = generateDemoIncident(records, demoStep, NOW);
    const record = result.record;

    if (result.added) {
      assert.equal(records.has(record.id), false, `duplicate created id ${record.id} at tick ${demoStep}`);
    } else {
      assert.equal(records.has(record.id), true, `missing updated id ${record.id} at tick ${demoStep}`);
    }
    records.set(record.id, record);

    for (const [id, affectedUsers] of before) {
      assert.ok(
        records.get(id).affectedUsers >= affectedUsers,
        `affectedUsers decreased for ${id} at tick ${demoStep}`
      );
    }

    if (isCritical(record)) criticalTicks.push(demoStep);
  }

  for (let index = 1; index < criticalTicks.length; index += 1) {
    const gap = criticalTicks[index] - criticalTicks[index - 1];
    if (criticalTicks[index] >= CONTINUATION_START && criticalTicks[index - 1] >= CONTINUATION_START) {
      assert.ok(gap <= CRITICAL_EVERY, `critical gap ${gap} > ${CRITICAL_EVERY}`);
    }
  }

  const criticalCreates = [...records.values()].filter((record) => record.id.startsWith('MTS-CRIT-'));
  assert.ok(criticalCreates.length >= 2, 'expected several generated critical records');
  assert.equal(new Set(criticalCreates.map((record) => record.id)).size, criticalCreates.length);
});

test('continuation criticals alternate between new incidents and escalations', () => {
  const records = new Map();
  const created = [];
  const escalated = [];

  for (let demoStep = 0; demoStep <= CONTINUATION_START + CRITICAL_EVERY * 2; demoStep += 1) {
    const result = generateDemoIncident(records, demoStep, NOW);
    records.set(result.record.id, result.record);
    if (demoStep < CONTINUATION_START) continue;
    const continuationIndex = demoStep - CONTINUATION_START;
    if (continuationIndex % CRITICAL_EVERY !== 0) continue;
    if (result.added) created.push(demoStep);
    else escalated.push(demoStep);
  }

  assert.ok(created.length > 0, 'expected at least one new critical incident');
  assert.ok(escalated.length > 0, 'expected at least one escalated critical incident');
  assert.equal(created[0], CONTINUATION_START);
  assert.equal(escalated[0], CONTINUATION_START + CRITICAL_EVERY);
});

test('critical cadence constant stays at 12', () => {
  assert.equal(CRITICAL_EVERY, 12);
});

test('demo data has semantic twins with different keys and one keyless sample', () => {
  const records = new Map();
  for (let step = 0; step < CONTINUATION_START; step += 1) {
    const result = generateDemoIncident(records, step, NOW);
    records.set(result.record.id, result.record);
  }
  assert.equal(records.size, 8, 'seven base records plus the keyless sample');

  const base = records.get('MTS-MOBILE-0001');
  const twin = records.get('MTS-MOBILE-0002');
  assert.ok(base, 'base mobile incident is missing');
  assert.ok(twin, 'semantic twin is missing');
  assert.equal(base.correlationKey, 'mobile-voice-moscow-outage');
  assert.equal(twin.correlationKey, 'mobile-voice-moscow-regional');
  assert.notEqual(twin.correlationKey, base.correlationKey, 'twins must not share a correlation key');
  assert.equal(twin.productName, base.productName);
  assert.equal(twin.service, base.service);
  assert.equal(twin.scenarioName, base.scenarioName);
  assert.equal(twin.region, base.region);
  assert.equal(twin.stateId, 0, 'twins stay open so triage can suggest a merge');

  const keyless = [...records.values()].filter((record) => record.correlationKey === null);
  assert.equal(keyless.length, 1, 'exactly one deterministic keyless sample');
  assert.equal(keyless[0].id, 'MTS-MOBILE-0003');
  assert.equal(keyless[0].productName, base.productName);
  assert.equal(keyless[0].service, base.service);
  assert.equal(keyless[0].scenarioName, base.scenarioName);
  assert.equal(keyless[0].region, base.region);
  assert.equal(keyless[0].stateId, 0);
  assert.equal(keyless[0].isMaster, false);
  assert.equal(keyless[0].isEffect, false);

  for (const record of records.values()) {
    assert.equal(record.assignedGroupName, null, `no auto-team for ${record.id}`);
  }
});

async function createStore(t, state) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'itsm-mock-recovery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  if (state !== undefined) {
    await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
  const store = new IncidentStore({ dataDir });
  await store.init();
  return store;
}

function replayScenario(steps) {
  const records = new Map();
  const revisions = {};
  for (let step = 0; step < steps; step += 1) {
    const result = generateDemoIncident(records, step, NOW);
    records.set(result.record.id, result.record);
    revisions[result.record.id] = step + 1;
  }
  return { records, revisions };
}

test('recovery recreates a missing base record and still advances the demo', () => {
  const records = new Map();
  const recovered = generateDemoIncident(records, 1, NOW);

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.added, true);
  assert.equal(recovered.record.id, 'MTS-MOBILE-0001');
  assert.equal(recovered.record.affectedUsers, 1000);
  assert.equal(recovered.record.reportCount, 9);
  assert.equal(recovered.record.stateId, 0);
  assert.equal(recovered.record.isMaster, true);

  records.set(recovered.record.id, recovered.record);
  const next = generateDemoIncident(records, 2, NOW);
  assert.equal(next.added, true);
  assert.equal(next.record.id, 'MTS-MOBILE-0002');
  const after = generateDemoIncident(records, 3, NOW);
  assert.equal(after.record.id, 'MTS-ID-0001');
});

test('recovery recreates each missing later scenario record before applying its step', () => {
  const cases = [
    { step: 9, id: 'MTS-BANK-0001', stateId: 20, group: null },
    { step: 10, id: 'MTS-KION-0001', stateId: 7, group: null },
    { step: 11, id: 'MTS-SMS-0001', stateId: 0, group: null },
  ];

  for (const expected of cases) {
    const records = new Map();
    const result = generateDemoIncident(records, expected.step, NOW);

    assert.equal(result.recovered, true, `step ${expected.step} was not recovered`);
    assert.equal(result.record.id, expected.id);
    assert.equal(result.record.stateId, expected.stateId);
    assert.equal(result.record.assignedGroupName, expected.group);
    assert.ok(result.record.version >= 2, 'the current step is applied on top of the recreated base');
    if (expected.step === 9) assert.equal(result.record.isNeedUp, true, 'base flags survive recovery');
    if (expected.step === 10) assert.equal(result.record.completionDate, NOW);
    if (expected.step === 11) assert.equal(result.record.affectedUsers, 60);
  }
});

test('demo tick self-heals a persisted state whose base scenario record is missing', async (t) => {
  const store = await createStore(t, { revision: 0, incidents: [], demoStep: 1 });

  const tick = await store.tick();
  assert.equal(tick.revision, 1);
  assert.equal(tick.added, 1);
  assert.equal(tick.updated, 0);
  assert.equal(tick.incidents.length, 1);
  assert.equal(tick.incidents[0].id, 'MTS-MOBILE-0001');
  assert.equal(tick.incidents[0].affectedUsers, 1000);
  assert.equal(tick.incidents[0].reportCount, 9);

  const snapshot = store.snapshot();
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.incidents.map((record) => record.id), ['MTS-MOBILE-0001']);
});

test('demo tick recreates a missing later scenario record without losing the rest of the state', async (t) => {
  const played = replayScenario(9);
  assert.equal(played.records.has('MTS-BANK-0001'), true);
  played.records.delete('MTS-BANK-0001');
  delete played.revisions['MTS-BANK-0001'];

  const store = await createStore(t, {
    revision: 9,
    incidents: [...played.records.values()],
    revisions: played.revisions,
    demoStep: 9,
  });
  assert.equal(store.get('MTS-BANK-0001'), undefined);
  assert.equal(store.snapshot().incidents.length, played.records.size);

  const tick = await store.tick();
  assert.equal(tick.revision, 10);
  assert.equal(tick.added, 1);
  assert.equal(tick.updated, 0);
  assert.equal(tick.incidents[0].id, 'MTS-BANK-0001');
  assert.equal(tick.incidents[0].stateId, 20);
  assert.equal(tick.incidents[0].assignedGroupName, null);
  assert.equal(store.snapshot().incidents.length, played.records.size + 1);

  const next = await store.tick();
  assert.equal(next.revision, 11);
  assert.equal(next.incidents[0].id, 'MTS-KION-0001');
  assert.equal(next.incidents[0].stateId, 7);
});

test('reset followed by ticks replays the scenario from step 0', async (t) => {
  const store = await createStore(t);
  for (let step = 0; step < 4; step += 1) await store.tick();
  assert.equal(store.snapshot().revision, 4);
  assert.equal(store.snapshot().incidents.length, 3);

  await store.reset();
  const empty = store.snapshot();
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.incidents, []);

  const first = await store.tick();
  assert.equal(first.revision, 1);
  assert.equal(first.added, 1);
  assert.equal(first.incidents[0].id, 'MTS-MOBILE-0001');
  assert.equal(first.incidents[0].affectedUsers, 10);
  assert.equal(first.incidents[0].version, 1);

  const second = await store.tick();
  assert.equal(second.updated, 1);
  assert.equal(second.incidents[0].id, 'MTS-MOBILE-0001');
  assert.equal(second.incidents[0].affectedUsers, 1000);
  assert.equal(store.snapshot().revision, 2);
  assert.equal(store.snapshot().incidents.length, 1);
});

test('repeated ticks after recovery keep advancing demoStep and revision without loops', async (t) => {
  const store = await createStore(t, { revision: 0, incidents: [], demoStep: 1 });
  const seenIds = [];
  let revision = 0;
  let incidentCount = 0;

  for (let i = 0; i < 20; i += 1) {
    const tick = await store.tick();
    assert.equal(tick.revision, revision + 1, 'revision must advance by exactly one');
    assert.equal(tick.added + tick.updated, 1, 'every tick changes exactly one record');
    revision = tick.revision;
    seenIds.push(tick.incidents[0].id);

    const snapshot = store.snapshot();
    assert.equal(snapshot.revision, revision);
    assert.ok(snapshot.incidents.length >= incidentCount, 'incident count must not shrink');
    incidentCount = snapshot.incidents.length;
    const ids = snapshot.incidents.map((record) => record.id);
    assert.equal(new Set(ids).size, ids.length, 'incident ids stay unique');
  }

  assert.deepEqual(seenIds.slice(0, 3), ['MTS-MOBILE-0001', 'MTS-MOBILE-0002', 'MTS-ID-0001']);
  assert.equal(revision, 20);
  assert.ok(incidentCount > 3, 'continuation steps keep adding incidents');
});

test('manual critical followed by a tick recovers the skipped base step', async (t) => {
  const store = await createStore(t);
  const critical = await store.critical();
  assert.equal(critical.revision, 1);
  assert.equal(critical.incident.id, 'MTS-CRIT-0000');

  const tick = await store.tick();
  assert.equal(tick.revision, 2);
  assert.equal(tick.added, 1);
  assert.equal(tick.incidents[0].id, 'MTS-MOBILE-0001');
  assert.equal(tick.incidents[0].affectedUsers, 1000);

  const ids = store.snapshot().incidents.map((record) => record.id).sort();
  assert.deepEqual(ids, ['MTS-CRIT-0000', 'MTS-MOBILE-0001']);
});
