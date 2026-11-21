import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoIncident } from '../src/generator.js';

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

  for (let start = CONTINUATION_START; start <= TICK_COUNT - 3; start += 1) {
    assert.ok(
      criticalTicks.some((tick) => tick >= start && tick <= start + 2),
      `no critical record in 3-tick window ${start}..${start + 2}`
    );
  }

  const criticalCreates = [...records.values()].filter((record) => record.id.startsWith('MTS-CRIT-'));
  assert.ok(criticalCreates.length >= 4, 'expected several generated critical records');
  assert.equal(new Set(criticalCreates.map((record) => record.id)).size, criticalCreates.length);
});

test('continuation criticals alternate between new incidents and escalations', () => {
  const records = new Map();
  const created = [];
  const escalated = [];

  for (let demoStep = 0; demoStep <= 30; demoStep += 1) {
    const result = generateDemoIncident(records, demoStep, NOW);
    records.set(result.record.id, result.record);
    if (demoStep < CONTINUATION_START) continue;
    const continuationIndex = demoStep - CONTINUATION_START;
    if (continuationIndex % 3 !== 0) continue;
    if (result.added) created.push(demoStep);
    else escalated.push(demoStep);
  }

  assert.ok(created.length > 0, 'expected at least one new critical incident');
  assert.ok(escalated.length > 0, 'expected at least one escalated critical incident');
  assert.equal(created[0], CONTINUATION_START);
  assert.equal(escalated[0], CONTINUATION_START + 3);
});
