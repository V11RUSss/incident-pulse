'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  CANONICAL_VERSION,
  ValidationError,
  buildCanonicalIncident,
  correlationKey,
  incidentId,
  integer,
  nullableText,
  validateRawIncident
} = require('../lib/incidents');

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])]));
  }
  return value;
}

function serialize(value) {
  return JSON.stringify(sortedValue(value));
}

function canonicalSignature(canonical) {
  if (!canonical || !Array.isArray(canonical.groups)) return null;
  const copy = { ...canonical };
  delete copy.version;
  return serialize(copy);
}

function notificationView(row) {
  return {
    id: row.id,
    caseId: row.case_id,
    incidentId: row.incident_id,
    type: row.type,
    title: row.title,
    message: row.message,
    createdAt: row.created_at,
    readAt: row.read_at
  };
}

const CORRELATION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const FALLBACK_KEY_PREFIX = 'id:';

function invalidKeyError(message) {
  const error = new ValidationError(message);
  error.code = 'invalid_correlation_key';
  return error;
}

function validateCorrelationKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw invalidKeyError('correlationKey обязателен');
  if (key.startsWith(FALLBACK_KEY_PREFIX)) {
    throw invalidKeyError('correlationKey не должен начинаться с id: — это зарезервированный fallback-префикс');
  }
  if (!CORRELATION_KEY_PATTERN.test(key)) {
    throw invalidKeyError(
      'correlationKey должен быть slug из строчных латинских букв, цифр, точки, дефиса или подчёркивания длиной до 128 символов'
    );
  }
  return key;
}

function caseLifecycle(canonical) {
  const groups = canonical && Array.isArray(canonical.groups) ? canonical.groups : null;
  if (!groups) return 'unknown';
  if (groups.includes('closed')) return 'closed';
  if (groups.includes('active')) return 'active';
  if (groups.includes('research')) return 'research';
  return 'unknown';
}

function notFoundError(message) {
  const error = new ValidationError(message);
  error.status = 404;
  return error;
}

function conflictError(message, code = null) {
  const error = new ValidationError(message);
  error.status = 409;
  if (code) error.code = code;
  return error;
}

function isOpenCaseRow(row) {
  try {
    const canonical = JSON.parse(row.canonical_json);
    if (!Array.isArray(canonical.groups)) return true;
    const lifecycle = caseLifecycle(canonical);
    return lifecycle === 'active' || lifecycle === 'research';
  } catch {
    return false;
  }
}

function mergeRowView(row) {
  return {
    id: row.id,
    targetCaseId: row.target_case_id,
    sourceCaseId: row.source_case_id,
    sourceKey: row.source_key,
    targetKey: row.target_key,
    rawCount: row.raw_count,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: row.created_at,
    details: row.details_json ? JSON.parse(row.details_json) : {}
  };
}

class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dataDir, 0o700); } catch { /* best effort on shared mounts */ }
    this.dataDir = dataDir;
    const dbPath = path.join(dataDir, 'incident-pulse.sqlite');
    this.db = new DatabaseSync(dbPath);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(dbPath + suffix, 0o600); } catch { /* best effort on shared mounts */ }
    }
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        login TEXT NOT NULL,
        login_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'coordinator',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        correlation_key TEXT NOT NULL,
        priority_override_id INTEGER,
        team_override TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        canonical_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cases_correlation_key_idx ON cases(correlation_key);

      CREATE TABLE IF NOT EXISTS raw_incidents (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        correlation_key TEXT,
        case_id TEXT NOT NULL REFERENCES cases(id),
        raw_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS raw_incidents_case_id_idx ON raw_incidents(case_id);

      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        user_name TEXT NOT NULL,
        action TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_case_id_idx ON history(case_id, id);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        user_name TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_id_idx ON audit(id DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        case_id TEXT,
        incident_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS notifications_read_at_idx ON notifications(user_id, read_at);

      CREATE TABLE IF NOT EXISTS case_merges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_case_id TEXT NOT NULL,
        source_case_id TEXT NOT NULL,
        source_key TEXT,
        target_key TEXT,
        raw_count INTEGER NOT NULL DEFAULT 0,
        user_id TEXT,
        user_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS case_merges_target_idx ON case_merges(target_case_id, id DESC);
      CREATE INDEX IF NOT EXISTS case_merges_source_idx ON case_merges(source_case_id, id DESC);

      CREATE TABLE IF NOT EXISTS correlation_overrides (
        raw_incident_id TEXT PRIMARY KEY REFERENCES raw_incidents(id) ON DELETE CASCADE,
        correlation_key TEXT NOT NULL,
        user_id TEXT,
        user_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS correlation_overrides_key_idx ON correlation_overrides(correlation_key);

      CREATE TABLE IF NOT EXISTS case_key_aliases (
        correlation_key TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS case_key_aliases_case_idx ON case_key_aliases(case_id);

      CREATE TABLE IF NOT EXISTS sync_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT,
        revision INTEGER,
        raw_json TEXT,
        error TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_failures_created_idx ON sync_failures(created_at DESC);
    `);
    this.ensureUserRoleColumn();
    this.ensureCaseTeamOverrideColumn();
    this.ensureAdmin();
    this.ensureCanonicalVersion();
  }

  ensureUserRoleColumn() {
    const columns = this.db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
    if (!columns.includes('role')) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'coordinator';");
    }
  }

  ensureCaseTeamOverrideColumn() {
    const columns = this.db.prepare('PRAGMA table_info(cases)').all().map(column => column.name);
    if (!columns.includes('team_override')) {
      this.db.exec('ALTER TABLE cases ADD COLUMN team_override TEXT;');
    }
  }

  ensureAdmin() {
    const users = this.db.prepare('SELECT COUNT(*) AS count FROM users').get();
    if (!users || users.count === 0) return;
    const admins = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
    if (admins && admins.count > 0) return;
    this.db.prepare(`
      UPDATE users SET role = 'admin'
      WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
    `).run();
  }

  close() {
    this.db.close();
  }

  createUser(user) {
    this.db.prepare(`
      INSERT INTO users (id, name, login, login_normalized, password_hash, password_salt, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.name,
      user.login,
      user.loginNormalized,
      user.passwordHash,
      user.passwordSalt,
      user.role === 'admin' ? 'admin' : 'coordinator',
      user.createdAt
    );
  }

  getUserByLogin(loginNormalized) {
    return this.db.prepare('SELECT * FROM users WHERE login_normalized = ?').get(loginNormalized) || null;
  }

  getUserById(id) {
    return this.db.prepare('SELECT id, name, login, role, created_at FROM users WHERE id = ?').get(id) || null;
  }

  countUsers() {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get();
    return row ? row.count : 0;
  }

  countAdmins() {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
    return row ? row.count : 0;
  }

  listCoordinators() {
    return this.db.prepare('SELECT id, name, login FROM users ORDER BY name, login').all();
  }

  listUsersWithSessions() {
    return this.db.prepare(`
      SELECT u.id, u.name, u.login, u.role, u.created_at AS createdAt,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessionCount,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS lastSessionAt
      FROM users u ORDER BY u.created_at, u.id
    `).all();
  }

  setUserRole(userId, role) {
    const result = this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    return result.changes ? this.getUserById(userId) : null;
  }

  deleteUser(userId) {
    const user = this.db.prepare('SELECT id, name, login, role FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return user;
  }

  deleteUserSessions(userId) {
    const result = this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return Number(result.changes);
  }

  recordAudit({ user, action, targetType = null, targetId = null, details = {}, createdAt = Date.now() }) {
    this.db.prepare(`
      INSERT INTO audit (user_id, user_name, action, target_type, target_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.name, action, targetType, targetId, JSON.stringify(details), createdAt);
  }

  listSyncFailures(limit = 50) {
    const bounded = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
    return this.db.prepare(`
      SELECT id, incident_id, revision, raw_json, error, created_at
      FROM sync_failures ORDER BY id DESC LIMIT ?
    `).all(bounded).map(row => ({
      id: row.id,
      incidentId: row.incident_id,
      revision: row.revision,
      raw: row.raw_json ? JSON.parse(row.raw_json) : null,
      error: row.error,
      createdAt: row.created_at
    }));
  }

  backup(reason = 'manual', keep = 5) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.dataDir, `incident-pulse.backup-${stamp}-${reason}.sqlite`);
    const escaped = target.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}';`);
    try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    const backups = fs.readdirSync(this.dataDir)
      .filter(name => name.startsWith('incident-pulse.backup-') && name.endsWith('.sqlite'))
      .sort()
      .reverse();
    for (const name of backups.slice(keep)) {
      try { fs.unlinkSync(path.join(this.dataDir, name)); } catch { /* best effort */ }
    }
    return target;
  }

  listAudit(limit) {
    return this.db.prepare(`
      SELECT id, user_id, user_name, action, target_type, target_id, details_json, created_at
      FROM audit ORDER BY id DESC LIMIT ?
    `).all(limit).map(row => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: JSON.parse(row.details_json),
      createdAt: row.created_at
    }));
  }

  createNotification({
    userId,
    caseId = null,
    incidentId = null,
    type,
    title,
    message = null,
    createdAt = Date.now()
  }) {
    const result = this.db.prepare(`
      INSERT INTO notifications (user_id, case_id, incident_id, type, title, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, caseId, incidentId, type, title, message, createdAt);
    return this.getNotification(Number(result.lastInsertRowid));
  }

  getNotification(id) {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    return row ? notificationView(row) : null;
  }

  listNotifications(userId, limit = 50) {
    const bounded = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
    return this.db.prepare(`
      SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?
    `).all(userId, bounded).map(notificationView);
  }

  countUnreadNotifications(userId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL
    `).get(userId);
    return row ? Number(row.count) : 0;
  }

  markNotificationRead(id, userId, readAt = Date.now()) {
    const result = this.db.prepare(`
      UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?
    `).run(readAt, id, userId);
    if (!result.changes) return null;
    return this.getNotification(id);
  }

  markUnreadAssignmentsForCase(userId, caseId, readAt = Date.now()) {
    if (!caseId) return 0;
    const result = this.db.prepare(`
      UPDATE notifications SET read_at = ?
      WHERE user_id = ? AND case_id = ? AND type = 'coordinator_assigned' AND read_at IS NULL
    `).run(readAt, userId, String(caseId));
    return Number(result.changes);
  }

  markAllNotificationsRead(userId, readAt = Date.now()) {
    const result = this.db.prepare(`
      UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL
    `).run(readAt, userId);
    return Number(result.changes);
  }

  createSession(session) {
    this.db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(session.tokenHash, session.userId, session.createdAt, session.expiresAt);
  }

  getSessionUser(tokenHash, now) {
    const session = this.db.prepare(`
      SELECT u.id, u.name, u.login, u.role, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash);
    if (!session) return null;
    if (session.expires_at <= now) {
      this.deleteSession(tokenHash);
      return null;
    }
    return { id: session.id, name: session.name, login: session.login, role: session.role };
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(now) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  countSessions(now) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?').get(now);
    return row ? row.count : 0;
  }

  getCase(caseId) {
    const row = this.db.prepare('SELECT canonical_json FROM cases WHERE id = ?').get(caseId);
    if (!row) return null;
    const canonical = JSON.parse(row.canonical_json);
    return Array.isArray(canonical.groups) ? canonical : null;
  }

  activeSourceIds(caseId) {
    return this.db.prepare('SELECT id, raw_json FROM raw_incidents WHERE case_id = ?').all(caseId)
      .filter(row => {
        try {
          const raw = JSON.parse(row.raw_json);
          return raw.stateId === 0 || raw.stateId === 2;
        } catch {
          return false;
        }
      })
      .map(row => row.id);
  }

  listCases() {
    return this.db.prepare('SELECT canonical_json FROM cases').all()
      .map(row => JSON.parse(row.canonical_json))
      .filter(canonical => Array.isArray(canonical.groups))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || a.id.localeCompare(b.id));
  }

  countActiveCases() {
    return this.listCases()
      .filter(incident => Array.isArray(incident.groups) && incident.groups.includes('active'))
      .length;
  }

  getCurrentRevision() {
    const value = Number(this.getMetadata('itsmRevision'));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  getCorrelationOverride(incidentIdValue) {
    const row = this.db.prepare(
      'SELECT correlation_key FROM correlation_overrides WHERE raw_incident_id = ?'
    ).get(String(incidentIdValue));
    return row ? row.correlation_key : null;
  }

  effectiveCorrelationKey(raw) {
    return this.getCorrelationOverride(incidentId(raw)) || correlationKey(raw);
  }

  findOpenCase(key) {
    const value = key === null || key === undefined ? '' : String(key);
    if (!value) return null;
    // A merged-away key is remembered as an alias of the surviving case, so new
    // records that still carry the old correlation key join the target case.
    const alias = this.db.prepare(`
      SELECT c.id, c.canonical_json FROM case_key_aliases a
      JOIN cases c ON c.id = a.case_id
      WHERE a.correlation_key = ?
    `).get(value);
    if (alias && isOpenCaseRow(alias)) return alias.id;
    const rows = this.db.prepare(`
      SELECT id, canonical_json FROM cases WHERE correlation_key = ? ORDER BY created_at, id
    `).all(value);
    for (const row of rows) {
      // A freshly created case still holds the '{}' placeholder until the next
      // rebuild, so it must count as open for subsequent records in the same delta.
      if (isOpenCaseRow(row)) return row.id;
    }
    return null;
  }

  createCase(raw, now, key = null) {
    const id = crypto.randomUUID();
    const override = integer(raw.priorityOverrideId);
    const caseKey = key === null ? this.effectiveCorrelationKey(raw) : key;
    this.db.prepare(`
      INSERT INTO cases (
        id, correlation_key, priority_override_id, version, canonical_json, created_at, updated_at
      ) VALUES (?, ?, ?, 0, '{}', ?, ?)
    `).run(id, caseKey, override, now, now);
    return id;
  }

  ensureCanonicalVersion() {
    const stored = Number(this.getMetadata('canonicalVersion'));
    if (stored === CANONICAL_VERSION) return false;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.rebuildCases(Date.now());
      this.setMetadata('canonicalVersion', String(CANONICAL_VERSION));
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return true;
  }

  rebuildCases(now) {
    const rows = this.db.prepare('SELECT * FROM cases ORDER BY created_at, id').all();
    const result = new Map();
    for (const row of rows) {
      const sources = this.db.prepare('SELECT raw_json FROM raw_incidents WHERE case_id = ? ORDER BY id')
        .all(row.id)
        .map(source => JSON.parse(source.raw_json));
      if (!sources.length) continue;

      let override = integer(row.priority_override_id);
      if (override === null) {
        const sourceWithOverride = sources.find(source => integer(source.priorityOverrideId) !== null);
        if (sourceWithOverride) override = integer(sourceWithOverride.priorityOverrideId);
      }
      const previous = JSON.parse(row.canonical_json);
      const previousSignature = canonicalSignature(previous);
      let canonical = buildCanonicalIncident({
        caseId: row.id,
        correlationKey: row.correlation_key,
        sources,
        priorityOverrideId: override,
        version: row.version
      });
      // A manual merge keeps the surviving case's team even when the merged
      // records would otherwise become the canonical primary.
      if (row.team_override !== null && row.team_override !== undefined) {
        const team = nullableText(row.team_override);
        const groups = canonical.groups.filter(group => group !== 'coordination');
        if (canonical.groups.includes('active') &&
            canonical.priorityId !== 4 && canonical.priorityId !== 3 && !team) {
          groups.push('coordination');
        }
        canonical = { ...canonical, team, groups };
      }
      if (previousSignature !== canonicalSignature(canonical)) {
        canonical = { ...canonical, version: row.version + 1 };
      }
      this.db.prepare(`
        UPDATE cases SET priority_override_id = ?, version = ?, canonical_json = ?, updated_at = ? WHERE id = ?
      `).run(override, canonical.version, serialize(canonical), now, row.id);
      result.set(row.id, canonical);
    }
    return result;
  }

  listCaseMerges(caseId = null, limit = 50) {
    const bounded = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
    if (caseId === null || caseId === undefined) {
      return this.db.prepare('SELECT * FROM case_merges ORDER BY id DESC LIMIT ?')
        .all(bounded)
        .map(mergeRowView);
    }
    return this.db.prepare(`
      SELECT * FROM case_merges
      WHERE target_case_id = ? OR source_case_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(String(caseId), String(caseId), bounded).map(mergeRowView);
  }

  mergeCases(targetId, sourceId, actor) {
    return this.mergeCasesBatch(targetId, [sourceId], actor);
  }

  mergeCasesBatch(targetId, sourceIds, actor) {
    const targetCaseId = String(targetId === null || targetId === undefined ? '' : targetId);
    const sourceCaseIds = [];
    const seenSourceIds = new Set();
    for (const value of Array.isArray(sourceIds) ? sourceIds : [sourceIds]) {
      const sourceCaseId = String(value === null || value === undefined ? '' : value);
      if (!sourceCaseId) {
        throw new ValidationError('sourceIds должен содержать непустые идентификаторы');
      }
      if (sourceCaseId === targetCaseId) {
        throw new ValidationError('Нельзя объединить инцидент с самим собой');
      }
      if (!seenSourceIds.has(sourceCaseId)) {
        seenSourceIds.add(sourceCaseId);
        sourceCaseIds.push(sourceCaseId);
      }
    }
    if (!targetCaseId) throw new ValidationError('targetId обязателен');
    if (!sourceCaseIds.length) throw new ValidationError('sourceIds обязателен');
    if (!actor || !actor.id || !actor.name) throw new ValidationError('actor обязателен');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const targetRow = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(targetCaseId);
      if (!targetRow) throw notFoundError('Целевой инцидент не найден');

      const target = JSON.parse(targetRow.canonical_json);
      const targetLifecycle = caseLifecycle(target);
      if (targetLifecycle === 'closed') {
        throw conflictError('Нельзя объединять закрытые инциденты', 'case_closed');
      }
      if (targetLifecycle === 'unknown') {
        throw conflictError('Инцидент ещё не синхронизирован; повторите после синхронизации', 'case_not_open');
      }
      if (targetLifecycle !== 'active' && targetLifecycle !== 'research') {
        throw conflictError('Объединять можно только активные или research инциденты', 'case_not_open');
      }

      // Validate every source before mutating anything: the batch is atomic.
      const now = Date.now();
      const sources = [];
      for (const sourceCaseId of sourceCaseIds) {
        const sourceRow = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(sourceCaseId);
        if (!sourceRow) throw notFoundError('Исходный инцидент не найден: ' + sourceCaseId);
        const source = JSON.parse(sourceRow.canonical_json);
        const sourceLifecycle = caseLifecycle(source);
        if (sourceLifecycle === 'closed') {
          throw conflictError('Нельзя объединять закрытые инциденты', 'case_closed');
        }
        if (sourceLifecycle === 'unknown') {
          throw conflictError('Инцидент ещё не синхронизирован; повторите после синхронизации', 'case_not_open');
        }
        if (sourceLifecycle !== targetLifecycle) {
          throw conflictError(
            'Объединять можно только инциденты одного жизненного цикла (active+active или research+research)',
            'lifecycle_mismatch'
          );
        }
        const rawRows = this.db.prepare('SELECT id FROM raw_incidents WHERE case_id = ?').all(sourceCaseId);
        if (!rawRows.length) {
          throw conflictError('Исходный инцидент не содержит записей: ' + sourceCaseId, 'empty_case');
        }
        sources.push({ sourceCaseId, sourceRow, rawCount: rawRows.length });
      }
      const targetKey = targetRow.correlation_key;
      this.db.prepare('UPDATE cases SET team_override = ? WHERE id = ?')
        .run(target.team === null || target.team === undefined ? null : String(target.team), targetCaseId);

      const insertMerge = this.db.prepare(`
        INSERT INTO case_merges (
          target_case_id, source_case_id, source_key, target_key, raw_count,
          user_id, user_name, created_at, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const mergeRows = [];
      let movedRawIncidents = 0;
      let movedHistory = 0;
      let movedNotifications = 0;
      for (const source of sources) {
        const sourceCaseId = source.sourceCaseId;
        const sourceKey = source.sourceRow.correlation_key;
        const rawResult = this.db.prepare(
          'UPDATE raw_incidents SET case_id = ?, updated_at = ? WHERE case_id = ?'
        ).run(targetCaseId, now, sourceCaseId);
        const historyResult = this.db.prepare(
          'UPDATE history SET case_id = ? WHERE case_id = ?'
        ).run(targetCaseId, sourceCaseId);
        const notificationResult = this.db.prepare(
          'UPDATE notifications SET case_id = ? WHERE case_id = ?'
        ).run(targetCaseId, sourceCaseId);
        this.db.prepare('UPDATE case_key_aliases SET case_id = ? WHERE case_id = ?')
          .run(targetCaseId, sourceCaseId);
        this.db.prepare(`
          INSERT INTO case_key_aliases (correlation_key, case_id, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(correlation_key) DO UPDATE
            SET case_id = excluded.case_id, created_at = excluded.created_at
        `).run(sourceKey, targetCaseId, now);

        const moved = {
          movedRawIncidents: Number(rawResult.changes),
          movedHistory: Number(historyResult.changes),
          movedNotifications: Number(notificationResult.changes)
        };
        movedRawIncidents += moved.movedRawIncidents;
        movedHistory += moved.movedHistory;
        movedNotifications += moved.movedNotifications;
        const sourceDetails = {
          targetCaseId,
          sourceCaseId,
          sourceKey,
          targetKey,
          ...moved
        };
        const mergeResult = insertMerge.run(
          targetCaseId,
          sourceCaseId,
          sourceKey,
          targetKey,
          moved.movedRawIncidents,
          actor.id,
          actor.name,
          now,
          JSON.stringify(sourceDetails)
        );
        mergeRows.push({
          id: Number(mergeResult.lastInsertRowid),
          sourceCaseId,
          sourceKey,
          rawCount: moved.movedRawIncidents,
          ...moved
        });
      }

      this.rebuildCases(now);
      for (const source of sources) {
        this.db.prepare('DELETE FROM cases WHERE id = ?').run(source.sourceCaseId);
      }
      const sourceKeys = sources.map(source => source.sourceRow.correlation_key);
      const details = {
        targetCaseId,
        sourceCaseId: sourceCaseIds[0],
        sourceCaseIds,
        sourceKey: sourceKeys[0],
        sourceKeys,
        targetKey,
        movedRawIncidents,
        movedHistory,
        movedNotifications,
        merges: mergeRows
      };
      this.recordHistory({
        caseId: targetCaseId,
        user: actor,
        action: 'merge',
        details: { ...details, mergeIds: mergeRows.map(row => row.id) },
        createdAt: now
      });
      const incident = this.getCase(targetCaseId);
      if (!incident) throw new Error('Не удалось пересобрать целевой инцидент после объединения');
      this.db.exec('COMMIT;');
      return {
        incident,
        merge: { id: mergeRows[0].id, ...details }
      };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  setCorrelationKey(caseId, value, actor) {
    const key = validateCorrelationKey(value);
    const caseIdValue = String(caseId === null || caseId === undefined ? '' : caseId);
    if (!caseIdValue) throw new ValidationError('caseId обязателен');
    if (!actor || !actor.id || !actor.name) throw new ValidationError('actor обязателен');

    const caseRow = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(caseIdValue);
    if (!caseRow) throw notFoundError('Инцидент не найден');
    const canonical = JSON.parse(caseRow.canonical_json);
    const lifecycle = caseLifecycle(canonical);
    if (lifecycle === 'closed') throw conflictError('Нельзя задать correlationKey закрытому инциденту', 'case_closed');
    if (lifecycle !== 'active' && lifecycle !== 'research') {
      throw conflictError('correlationKey можно задать только открытому инциденту', 'case_not_open');
    }

    const raws = this.db.prepare(
      'SELECT id, raw_json FROM raw_incidents WHERE case_id = ? ORDER BY id'
    ).all(caseIdValue);
    if (!raws.length) throw conflictError('Инцидент не содержит записей', 'empty_case');
    for (const rawRow of raws) {
      let rawJson;
      try {
        rawJson = JSON.parse(rawRow.raw_json);
      } catch {
        throw new ValidationError('Некорректные данные raw-инцидента');
      }
      const rawKey = nullableText(rawJson.correlationKey);
      if (rawKey !== null && rawKey !== `id:${rawRow.id}`) {
        throw conflictError(
          'У инцидента уже есть явный correlationKey из ITSM; для объединения используйте слияние дел',
          'not_keyless'
        );
      }
    }

    const collisionIds = [];
    const seen = new Set();
    const alias = this.db.prepare(
      'SELECT case_id FROM case_key_aliases WHERE correlation_key = ?'
    ).get(key);
    if (alias && alias.case_id !== caseIdValue) {
      collisionIds.push(alias.case_id);
      seen.add(alias.case_id);
    }
    for (const row of this.db.prepare(`
      SELECT id FROM cases WHERE correlation_key = ? AND id <> ? ORDER BY created_at, id
    `).all(key, caseIdValue)) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        collisionIds.push(row.id);
      }
    }

    let collisionCaseId = null;
    let closedCollision = false;
    for (const candidateId of collisionIds) {
      const candidate = this.db.prepare('SELECT id, canonical_json FROM cases WHERE id = ?').get(candidateId);
      if (!candidate) continue;
      const candidateLifecycle = caseLifecycle(JSON.parse(candidate.canonical_json));
      if (candidateLifecycle === 'closed') {
        closedCollision = true;
        continue;
      }
      if (candidateLifecycle === 'active' || candidateLifecycle === 'research') {
        collisionCaseId = candidateId;
        break;
      }
    }

    if (collisionCaseId) {
      const result = this.mergeCases(collisionCaseId, caseIdValue, actor);
      this.recordHistory({
        caseId: collisionCaseId,
        user: actor,
        action: 'correlation_key',
        details: {
          correlationKey: key,
          previousKey: caseRow.correlation_key,
          mergedFromCaseId: caseIdValue
        }
      });
      return result.incident;
    }
    if (closedCollision) {
      throw conflictError('correlationKey уже занят закрытым инцидентом', 'correlation_key_conflict');
    }

    if (caseRow.correlation_key === key) {
      return this.getCase(caseIdValue);
    }

    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('UPDATE raw_incidents SET correlation_key = ? WHERE case_id = ?')
        .run(key, caseIdValue);
      const upsert = this.db.prepare(`
        INSERT INTO correlation_overrides (raw_incident_id, correlation_key, user_id, user_name, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(raw_incident_id) DO UPDATE SET
          correlation_key = excluded.correlation_key,
          user_id = excluded.user_id,
          user_name = excluded.user_name,
          created_at = excluded.created_at
      `);
      for (const rawRow of raws) upsert.run(rawRow.id, key, actor.id, actor.name, now);
      this.db.prepare('UPDATE cases SET correlation_key = ? WHERE id = ?').run(key, caseIdValue);
      this.rebuildCases(now);
      this.recordHistory({
        caseId: caseIdValue,
        user: actor,
        action: 'correlation_key',
        details: { correlationKey: key, previousKey: caseRow.correlation_key },
        createdAt: now
      });
      const incident = this.getCase(caseIdValue);
      if (!incident) throw new Error('Не удалось пересобрать инцидент после смены correlationKey');
      this.db.exec('COMMIT;');
      return incident;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  resetSyncState() {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.exec('DELETE FROM case_merges;');
      this.db.exec('DELETE FROM raw_incidents;');
      this.db.exec('DELETE FROM cases;');
      // Keep the notification history in the bell, but mark it read: the
      // linked cases no longer exist, so unread counts would otherwise be
      // permanently misleading.
      this.db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?)').run(Date.now());
      this.db.exec('DELETE FROM correlation_overrides;');
      this.db.exec('DELETE FROM case_key_aliases;');
      this.setMetadata('itsmRevision', '0');
      this.setMetadata('syncError', null);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  applyDelta(records, revision, syncedAt = Date.now()) {
    if (!Array.isArray(records)) throw new ValidationError('Ожидался массив raw-инцидентов');
    const currentRevision = this.getCurrentRevision();
    if (!Number.isSafeInteger(revision) || revision < currentRevision) {
      throw new ValidationError('ITSM revision должен быть неотрицательным и не может уменьшаться');
    }
    if (records.length === 0 && revision === currentRevision) {
      this.setMetadata('lastSyncedAt', String(syncedAt));
      this.setMetadata('syncError', null);
      return {
        added: 0,
        updated: 0,
        unchanged: 0,
        stale: 0,
        rejected: [],
        revision,
        lastSyncedAt: syncedAt,
        syncError: null
      };
    }

    // One malformed upstream record must not stop the whole feed forever. Keep
    // valid records in the delta, acknowledge the revision, and dead-letter the
    // rest for operators. The next successful sync clears the warning.
    const validRecords = [];
    const rejected = [];
    const seenIds = new Set();
    records.forEach((raw, index) => {
      try {
        validateRawIncident(raw, `incidents[${index}]`);
        const id = incidentId(raw);
        if (!id) throw new ValidationError(`incidents[${index}].id обязателен`);
        if (seenIds.has(id)) throw new ValidationError(`Дублирующийся id в delta: ${id}`);
        seenIds.add(id);
        validRecords.push(raw);
      } catch (error) {
        const id = raw && raw.id !== null && raw.id !== undefined ? String(raw.id) : null;
        rejected.push({
          id,
          error: error && error.message ? error.message : 'Некорректная запись ITSM'
        });
      }
    });

    const before = new Map();
    for (const row of this.db.prepare('SELECT id, canonical_json FROM cases').all()) {
      before.set(row.id, JSON.parse(row.canonical_json));
    }

    let unchanged = 0;
    let stale = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (rejected.length) {
        const insertFailure = this.db.prepare(`
          INSERT INTO sync_failures (incident_id, revision, raw_json, error, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const failure of rejected) {
          const raw = records.find(item => item && item.id !== null && item.id !== undefined && String(item.id) === failure.id);
          insertFailure.run(failure.id, revision, raw ? serialize(raw) : null, failure.error, syncedAt);
        }
      }
      for (const raw of validRecords) {
        const id = incidentId(raw);
        const version = integer(raw.version);
        const serialized = serialize(raw);
        const existing = this.db.prepare('SELECT * FROM raw_incidents WHERE id = ?').get(id);
        if (existing) {
          if (version < existing.version) {
            stale += 1;
            continue;
          }
          if (version === existing.version) {
            if (existing.raw_json === serialized) unchanged += 1;
            else stale += 1;
            continue;
          }
          const updatedKey = this.effectiveCorrelationKey(raw);
          this.db.prepare(`
            UPDATE raw_incidents
            SET version = ?, correlation_key = ?, raw_json = ?, updated_at = ?
            WHERE id = ?
          `).run(version, updatedKey, serialized, syncedAt, id);
          continue;
        }

        // A manual correlation-key override wins over the ITSM key for both
        // case lookup and the stored raw key.
        const key = this.effectiveCorrelationKey(raw);
        const caseId = this.findOpenCase(key) || this.createCase(raw, syncedAt, key);
        this.db.prepare(`
          INSERT INTO raw_incidents (id, version, correlation_key, case_id, raw_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, version, key, caseId, serialized, syncedAt, syncedAt);
      }

      const after = this.rebuildCases(syncedAt);
      let added = 0;
      let updated = 0;
      for (const [caseId, canonical] of after) {
        if (!before.has(caseId)) added += 1;
        else if (canonicalSignature(before.get(caseId)) !== canonicalSignature(canonical)) updated += 1;
      }

      const syncError = rejected.length
        ? `ITSM прислал ${rejected.length} некорректных записей; они отложены в sync_failures`
        : null;
      this.setMetadata('itsmRevision', String(revision));
      this.setMetadata('lastSyncedAt', String(syncedAt));
      this.setMetadata('syncError', syncError);
      this.db.exec('COMMIT;');
      return {
        added,
        updated,
        unchanged,
        stale,
        rejected,
        revision,
        lastSyncedAt: syncedAt,
        syncError
      };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  setPriorityOverride(caseId, priorityId) {
    this.db.prepare('UPDATE cases SET priority_override_id = ? WHERE id = ?').run(priorityId, caseId);
  }

  clearTeamOverride(caseId) {
    this.db.prepare('UPDATE cases SET team_override = NULL WHERE id = ?').run(caseId);
  }

  recordHistory({ caseId, user, action, details, createdAt = Date.now() }) {
    const result = this.db.prepare(`
      INSERT INTO history (case_id, user_id, user_name, action, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(caseId, user.id, user.name, action, JSON.stringify(details), createdAt);
    return Number(result.lastInsertRowid);
  }

  listHistory(caseId) {
    return this.db.prepare(`
      SELECT id, case_id, user_id, user_name, action, details_json, created_at
      FROM history WHERE case_id = ? ORDER BY id DESC
    `).all(caseId).map(row => ({
      id: row.id,
      caseId: row.case_id,
      userId: row.user_id,
      userName: row.user_name,
      action: row.action,
      details: JSON.parse(row.details_json),
      createdAt: row.created_at
    }));
  }

  // Public wallboard feed: only case-level facts, never user or coordinator
  // identity. Personal names stay behind coordinator authentication.
  listRecentChanges(limit = 20) {
    const bounded = Math.min(Math.max(Number.isInteger(limit) ? limit : 20, 1), 100);
    return this.db.prepare(`
      SELECT h.id, h.case_id, h.action, h.created_at, c.canonical_json
      FROM history h JOIN cases c ON c.id = h.case_id
      ORDER BY h.id DESC LIMIT ?
    `).all(bounded).map(row => {
      let canonical = {};
      try {
        canonical = JSON.parse(row.canonical_json);
      } catch {
        canonical = {};
      }
      return {
        id: row.id,
        caseId: row.case_id,
        incidentId: canonical.id || null,
        title: canonical.title || null,
        action: row.action,
        status: canonical.status || null,
        priority: canonical.priority || null,
        priorityId: canonical.priorityId === undefined ? null : canonical.priorityId,
        team: canonical.team || null,
        createdAt: row.created_at
      };
    });
  }

  recordSyncError(message) {
    this.setMetadata('syncError', message);
  }

  getSyncState() {
    const lastSyncedAt = this.getMetadata('lastSyncedAt');
    const parsed = lastSyncedAt === null ? null : Number(lastSyncedAt);
    return {
      lastSyncedAt: Number.isFinite(parsed) ? parsed : null,
      syncError: this.getMetadata('syncError')
    };
  }

  getMetadata(key) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMetadata(key, value) {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

module.exports = { Store, canonicalSignature, serialize };
