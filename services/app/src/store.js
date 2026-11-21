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
  validateRawBatch
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

class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'incident-pulse.sqlite'));
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
    `);
    this.ensureUserRoleColumn();
    this.ensureAdmin();
    this.ensureCanonicalVersion();
  }

  ensureUserRoleColumn() {
    const columns = this.db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
    if (!columns.includes('role')) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'coordinator';");
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

  listCases() {
    return this.db.prepare('SELECT canonical_json FROM cases').all()
      .map(row => JSON.parse(row.canonical_json))
      .filter(canonical => Array.isArray(canonical.groups))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || a.id.localeCompare(b.id));
  }

  getCurrentRevision() {
    const value = Number(this.getMetadata('itsmRevision'));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  findOpenCase(key) {
    const rows = this.db.prepare(`
      SELECT id, canonical_json FROM cases WHERE correlation_key = ? ORDER BY created_at, id
    `).all(key);
    for (const row of rows) {
      let canonical;
      try {
        canonical = JSON.parse(row.canonical_json);
      } catch {
        continue;
      }
      // A freshly created case still holds the '{}' placeholder until the next
      // rebuild, so it must count as open for subsequent records in the same delta.
      if (!Array.isArray(canonical.groups) || !canonical.groups.includes('closed')) return row.id;
    }
    return null;
  }

  createCase(raw, now) {
    const id = crypto.randomUUID();
    const override = integer(raw.priorityOverrideId);
    this.db.prepare(`
      INSERT INTO cases (
        id, correlation_key, priority_override_id, version, canonical_json, created_at, updated_at
      ) VALUES (?, ?, ?, 0, '{}', ?, ?)
    `).run(id, correlationKey(raw), override, now, now);
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

  resetSyncState() {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.exec('DELETE FROM raw_incidents;');
      this.db.exec('DELETE FROM cases;');
      this.setMetadata('itsmRevision', '0');
      this.setMetadata('syncError', null);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  applyDelta(records, revision, syncedAt = Date.now()) {
    validateRawBatch(records);
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
        revision,
        lastSyncedAt: syncedAt,
        syncError: null
      };
    }

    const before = new Map();
    for (const row of this.db.prepare('SELECT id, canonical_json FROM cases').all()) {
      before.set(row.id, JSON.parse(row.canonical_json));
    }

    let unchanged = 0;
    let stale = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const raw of records) {
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
          this.db.prepare(`
            UPDATE raw_incidents
            SET version = ?, correlation_key = ?, raw_json = ?, updated_at = ?
            WHERE id = ?
          `).run(version, correlationKey(raw), serialized, syncedAt, id);
          continue;
        }

        const caseId = this.findOpenCase(correlationKey(raw)) || this.createCase(raw, syncedAt);
        this.db.prepare(`
          INSERT INTO raw_incidents (id, version, correlation_key, case_id, raw_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, version, correlationKey(raw), caseId, serialized, syncedAt, syncedAt);
      }

      const after = this.rebuildCases(syncedAt);
      let added = 0;
      let updated = 0;
      for (const [caseId, canonical] of after) {
        if (!before.has(caseId)) added += 1;
        else if (canonicalSignature(before.get(caseId)) !== canonicalSignature(canonical)) updated += 1;
      }

      this.setMetadata('itsmRevision', String(revision));
      this.setMetadata('lastSyncedAt', String(syncedAt));
      this.setMetadata('syncError', null);
      this.db.exec('COMMIT;');
      return {
        added,
        updated,
        unchanged,
        stale,
        revision,
        lastSyncedAt: syncedAt,
        syncError: null
      };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  setPriorityOverride(caseId, priorityId) {
    this.db.prepare('UPDATE cases SET priority_override_id = ? WHERE id = ?').run(priorityId, caseId);
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
