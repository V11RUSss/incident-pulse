import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { generateDemoIncident } from './generator.js';

export class StoreError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const PATCH_STATE_IDS = new Set([0, 2, 20, 7, 10]);
const PATCH_PRIORITY_IDS = new Set([1, 2, 3, 4]);
const PATCH_STRING_FIELDS = ['header', 'description', 'productName', 'service', 'scenarioName', 'region'];
const PATCH_NULLABLE_STRING_FIELDS = [
  'assignedGroupName',
  'coordinatorId',
  'coordinatorName',
  'solution',
  'correlationKey',
];
const PATCH_DATE_FIELDS = ['submitDate', 'deadline', 'completionDate', 'updatedAt'];
const PATCH_BOOLEAN_FIELDS = [
  'isNeedUp',
  'isMaster',
  'isEffect',
  'isDouble',
  'isReason',
  'isRootIncident',
];

function isIsoDate(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function invalidPatchField(field, expectation) {
  throw new StoreError(400, `Patch field ${field} ${expectation}`);
}

function validatePatch(patch) {
  if (Object.hasOwn(patch, 'stateId') && !PATCH_STATE_IDS.has(patch.stateId)) {
    invalidPatchField('stateId', 'must be one of 0, 2, 20, 7, 10');
  }
  if (Object.hasOwn(patch, 'priorityId') && !PATCH_PRIORITY_IDS.has(patch.priorityId)) {
    invalidPatchField('priorityId', 'must be one of 1, 2, 3, 4');
  }
  if (Object.hasOwn(patch, 'priorityOverrideId') &&
      patch.priorityOverrideId !== null &&
      !PATCH_PRIORITY_IDS.has(patch.priorityOverrideId)) {
    invalidPatchField('priorityOverrideId', 'must be one of 1, 2, 3, 4 or null');
  }
  for (const field of ['affectedUsers', 'reportCount']) {
    if (Object.hasOwn(patch, field) && (!Number.isSafeInteger(patch[field]) || patch[field] < 0)) {
      invalidPatchField(field, 'must be a non-negative safe integer');
    }
  }
  for (const field of PATCH_DATE_FIELDS) {
    if (Object.hasOwn(patch, field) && patch[field] !== null && !isIsoDate(patch[field])) {
      invalidPatchField(field, 'must be a valid ISO date string or null');
    }
  }
  for (const field of PATCH_STRING_FIELDS) {
    if (Object.hasOwn(patch, field) && typeof patch[field] !== 'string') {
      invalidPatchField(field, 'must be a string');
    }
  }
  for (const field of PATCH_NULLABLE_STRING_FIELDS) {
    if (Object.hasOwn(patch, field) && patch[field] !== null && typeof patch[field] !== 'string') {
      invalidPatchField(field, 'must be a string or null');
    }
  }
  for (const field of PATCH_BOOLEAN_FIELDS) {
    if (Object.hasOwn(patch, field) && typeof patch[field] !== 'boolean') {
      invalidPatchField(field, 'must be a boolean');
    }
  }
}

function normalizePatch(payload) {
  if (!isObject(payload)) {
    throw new StoreError(400, 'Patch must be a JSON object');
  }
  if (Object.hasOwn(payload, 'version') || Object.hasOwn(payload, 'updatedAt')) {
    throw new StoreError(400, 'version and updatedAt are managed by the ITSM mock');
  }
  validatePatch(payload);
  return structuredClone(payload);
}

function normalizeState(state) {
  if (!isObject(state) || !Array.isArray(state.incidents) || !isRevision(state.revision)) {
    throw new Error('Invalid ITSM mock state');
  }
  if (!isRevision(state.demoStep ?? 0)) {
    throw new Error('Invalid demo scenario position');
  }

  const records = new Map();
  for (const record of state.incidents) {
    if (!isObject(record) || typeof record.id !== 'string' || record.id.trim() === '') {
      throw new Error('Invalid incident in ITSM mock state');
    }
    if (records.has(record.id)) {
      throw new Error(`Duplicate incident id in state: ${record.id}`);
    }
    if (!Number.isSafeInteger(record.version) || record.version < 1) {
      throw new Error(`Invalid incident version: ${record.id}`);
    }
    records.set(record.id, record);
  }

  const revisions = new Map();
  if (state.revisions === undefined) {
    for (const id of records.keys()) revisions.set(id, state.revision);
  } else {
    if (!isObject(state.revisions)) throw new Error('Invalid incident revisions');
    for (const [id, revision] of Object.entries(state.revisions)) {
      if (!records.has(id) || !isRevision(revision) || revision > state.revision) {
        throw new Error(`Invalid revision for incident: ${id}`);
      }
      revisions.set(id, revision);
    }
    for (const id of records.keys()) {
      if (!revisions.has(id)) throw new Error(`Missing revision for incident: ${id}`);
    }
  }

  return {
    revision: state.revision,
    records,
    revisions,
    demoStep: state.demoStep ?? 0,
  };
}

async function readState(statePath) {
  const text = await readFile(statePath, 'utf8');
  try {
    return normalizeState(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${statePath}`);
    throw error;
  }
}

export class IncidentStore {
  #statePath;
  #revision = 0;
  #records = new Map();
  #revisions = new Map();
  #demoStep = 0;
  #queue = Promise.resolve();

  constructor({ dataDir }) {
    this.#statePath = path.join(dataDir, 'state.json');
    this.dataDir = dataDir;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const state = await readState(this.#statePath);
      this.#apply(state);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') {
        const state = { revision: 0, records: new Map(), revisions: new Map(), demoStep: 0 };
        await this.#persist(state);
        this.#apply(state);
        return;
      }
      if (error.code) throw error;
      const quarantinePath = `${this.#statePath}.corrupt-${Date.now()}`;
      await rename(this.#statePath, quarantinePath);
      console.warn(`itsm-mock: ${error.message}; moved to ${quarantinePath} and starting with an empty state`);
    }
    const state = { revision: 0, records: new Map(), revisions: new Map(), demoStep: 0 };
    await this.#persist(state);
    this.#apply(state);
  }

  snapshot(since) {
    if (since !== undefined && since > this.#revision) {
      const error = new StoreError(400, 'since cannot exceed the current revision');
      error.code = 'revision_ahead';
      error.revision = this.#revision;
      throw error;
    }
    const records = [...this.#records.values()].filter((record) => (
      since === undefined || (this.#revisions.get(record.id) ?? 0) > since
    ));
    return {
      revision: this.#revision,
      generatedAt: new Date().toISOString(),
      incidents: structuredClone(records),
    };
  }

  get(id) {
    const record = this.#records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  tick() {
    return this.#enqueue(async () => {
      const demoStep = this.#demoStep;
      const revision = this.#revision + 1;
      const result = generateDemoIncident(this.#records, demoStep);
      const record = result.record;
      const existed = this.#records.has(record.id);
      if (result.recovered) {
        console.warn(
          `itsm-mock: demo step ${demoStep} referenced missing incident ${record.id}; base record recreated`
        );
      }
      const records = new Map(this.#records);
      const revisions = new Map(this.#revisions);
      records.set(record.id, record);
      revisions.set(record.id, revision);
      const state = {
        revision,
        records,
        revisions,
        demoStep: demoStep + 1,
      };
      await this.#persist(state);
      this.#apply(state);
      return {
        revision,
        added: existed ? 0 : 1,
        updated: existed ? 1 : 0,
        incidents: [structuredClone(record)],
      };
    });
  }

  critical() {
    return this.#enqueue(async () => {
      const demoStep = this.#demoStep;
      const revision = this.#revision + 1;
      const now = new Date();
      const affectedUsers = 1200 + ((demoStep * 137) % 1801);
      const record = {
        id: `MTS-CRIT-${String(demoStep).padStart(4, '0')}`,
        correlationKey: `critical-manual-${demoStep}`,
        header: 'Критический массовый инцидент (демонстрация)',
        description: 'Критический инцидент создан администратором через панель управления для проверки эскалации.',
        productName: 'МТС Cloud',
        service: 'Облачные виртуальные машины',
        scenarioName: 'Доступ к виртуальной машине',
        region: 'Москва',
        affectedUsers,
        reportCount: 1,
        priorityId: 4,
        priorityOverrideId: null,
        stateId: 0,
        submitDate: now.toISOString(),
        deadline: new Date(now.getTime() + (10 + (demoStep % 6)) * 60 * 1000).toISOString(),
        completionDate: null,
        assignedGroupName: null,
        coordinatorId: null,
        coordinatorName: null,
        solution: null,
        isNeedUp: true,
        isMaster: true,
        isEffect: true,
        version: 1,
        updatedAt: now.toISOString(),
      };
      const records = new Map(this.#records);
      const revisions = new Map(this.#revisions);
      records.set(record.id, record);
      revisions.set(record.id, revision);
      const state = { revision, records, revisions, demoStep: demoStep + 1 };
      await this.#persist(state);
      this.#apply(state);
      return { revision, added: 1, updated: 0, incident: structuredClone(record) };
    });
  }

  reset() {
    return this.#enqueue(async () => {
      const state = { revision: 0, records: new Map(), revisions: new Map(), demoStep: 0 };
      await this.#persist(state);
      this.#apply(state);
      return { revision: 0, incidents: [] };
    });
  }

  patch(id, payload) {
    const patch = normalizePatch(payload);
    return this.#enqueue(async () => {
      const existing = this.#records.get(id);
      if (!existing) throw new StoreError(404, `Incident not found: ${id}`);
      if (Object.hasOwn(patch, 'id') && patch.id !== id) {
        throw new StoreError(409, 'Incident id cannot be changed');
      }

      const merged = { ...existing, ...patch };
      if (isDeepStrictEqual(existing, merged)) {
        return { updated: 0, incident: structuredClone(existing) };
      }

      const revision = this.#revision + 1;
      const record = {
        ...merged,
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      const records = new Map(this.#records);
      const revisions = new Map(this.#revisions);
      records.set(id, record);
      revisions.set(id, revision);
      const state = { revision, records, revisions, demoStep: this.#demoStep };
      await this.#persist(state);
      this.#apply(state);
      return { updated: 1, incident: structuredClone(record) };
    });
  }

  bulkUpdate(payload) {
    if (!isObject(payload) || !Array.isArray(payload.ids)) {
      throw new StoreError(400, 'Bulk update requires an ids array and a patch object');
    }
    const ids = structuredClone(payload.ids);
    const patch = normalizePatch(payload.patch);
    const uniqueIds = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new StoreError(400, 'Every bulk update id must be a non-empty string');
      }
      if (uniqueIds.has(id)) {
        throw new StoreError(409, `Duplicate incident id in bulk update: ${id}`);
      }
      uniqueIds.add(id);
    }
    if (Object.hasOwn(patch, 'id')) {
      throw new StoreError(409, 'Incident id cannot be changed');
    }

    return this.#enqueue(async () => {
      const existing = ids.map((id) => {
        const record = this.#records.get(id);
        if (!record) throw new StoreError(404, `Incident not found: ${id}`);
        return record;
      });
      const changed = existing.filter((record) => (
        !isDeepStrictEqual(record, { ...record, ...patch })
      ));
      if (changed.length === 0) return { updated: 0, revision: this.#revision };

      const revision = this.#revision + 1;
      const now = new Date().toISOString();
      const records = new Map(this.#records);
      const revisions = new Map(this.#revisions);
      for (const record of changed) {
        const updated = {
          ...record,
          ...patch,
          version: record.version + 1,
          updatedAt: now,
        };
        records.set(record.id, updated);
        revisions.set(record.id, revision);
      }
      const state = { revision, records, revisions, demoStep: this.#demoStep };
      await this.#persist(state);
      this.#apply(state);
      return { updated: changed.length, revision };
    });
  }

  #enqueue(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #apply(state) {
    this.#revision = state.revision;
    this.#records = state.records;
    this.#revisions = state.revisions;
    this.#demoStep = state.demoStep;
  }

  async #persist(state) {
    const snapshot = {
      revision: state.revision,
      incidents: [...state.records.values()],
    };
    if (state.demoStep > 0) snapshot.demoStep = state.demoStep;
    if (state.revisions.size > 0) snapshot.revisions = Object.fromEntries(state.revisions);

    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.#statePath);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}
