'use strict';

// Keep SQLite/WAL and any backup files private to the app user.
process.umask(0o077);

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Auth, AuthError } = require('./auth');
const { AiClient, AiError } = require('./ai');
const { askAssistant } = require('./assistant');
const { suggestTeam } = require('./routing');
const { generatePostmortem } = require('./postmortem');
const { buildDeterministicReport } = require('../lib/triage');
const { scanTriage } = require('./triage');
const { filterIncidents } = require('../lib/filters');
const { ItsmClient, ItsmError } = require('./itsm');
const { Store } = require('./store');
const {
  PRIORITIES,
  PRIORITY_TEXT,
  STATES,
  ValidationError,
  countIncidents,
  integer,
  isObject,
  nullableText,
  parseTimestamp
} = require('../lib/incidents');
const { MTS_TEAMS, STATUS_TRANSITIONS } = require('../lib/meta');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');
if (process.env.NODE_ENV === 'production' && !process.env.STATIC_DIR) {
  throw new Error('STATIC_DIR обязателен в production: не раздавайте корень репозитория');
}
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || REPOSITORY_ROOT);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(REPOSITORY_ROOT, '.data'));
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_MERGE_SOURCES = 100;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
});
const HTML_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
});

function configuredInteger(value, fallback, minimum = 1) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const converted = Number(value);
  return Number.isInteger(converted) && converted >= minimum ? converted : fallback;
}

const port = configuredInteger(process.env.PORT, 3000, 0);
const pollIntervalMs = configuredInteger(process.env.POLL_INTERVAL_MS, 2000);
const itsmTimeoutMs = configuredInteger(process.env.ITSM_TIMEOUT_MS, 5000);
const demoGeneration = process.env.DEMO_GENERATION === 'true';
const demoMinIntervalMs = configuredInteger(process.env.DEMO_MIN_INTERVAL_MS, 3000, 1000);
const demoMaxIntervalMs = Math.max(
  demoMinIntervalMs,
  configuredInteger(process.env.DEMO_MAX_INTERVAL_MS, 9000, 1000)
);
const demoBatchMin = configuredInteger(process.env.DEMO_BATCH_MIN, 1, 1);
const demoBatchMax = Math.max(
  demoBatchMin,
  configuredInteger(process.env.DEMO_BATCH_MAX, 3, 1)
);
const demoMaxActive = configuredInteger(process.env.DEMO_MAX_ACTIVE, 20, 0);
let demoNextAt = 0;
const aiFallback = process.env.AI_FALLBACK !== 'false';
const aiRateLimitPerMinute = configuredInteger(process.env.AI_RATE_LIMIT_PER_MIN, 10, 0);
const assistantEnabled = process.env.ASSISTANT_ENABLED !== 'false';
const assistantRateLimitPerMinute = configuredInteger(process.env.ASSISTANT_RATE_LIMIT_PER_MIN, 20, 0);
const routingEnabled = process.env.ROUTING_ENABLED !== 'false';
const routingRateLimitPerMinute = configuredInteger(process.env.ROUTING_RATE_LIMIT_PER_MIN, 30, 0);
const routingTimeoutMs = configuredInteger(process.env.ROUTING_TIMEOUT_MS, 20000, 1000);
const postmortemEnabled = process.env.POSTMORTEM_ENABLED !== 'false';
const postmortemRateLimitPerMinute = configuredInteger(process.env.POSTMORTEM_RATE_LIMIT_PER_MIN, 10, 0);
const postmortemTimeoutMs = configuredInteger(process.env.POSTMORTEM_TIMEOUT_MS, 60000, 1000);
const triageEnabled = process.env.TRIAGE_ENABLED !== 'false';
const triageAiEnabled = process.env.TRIAGE_AI_ENABLED !== 'false';
const triageRateLimitPerMinute = configuredInteger(process.env.TRIAGE_AI_RATE_LIMIT_PER_MIN, 10, 0);
const triageTimeoutMs = configuredInteger(process.env.TRIAGE_AI_TIMEOUT_MS, 20000, 1000);
const registrationEnabled = process.env.REGISTRATION_ENABLED !== 'false';
const registrationToken = String(process.env.REGISTRATION_TOKEN || '').trim();
const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
const APP_VERSION = require('../package.json').version;
const MAX_SSE_CLIENTS = configuredInteger(process.env.MAX_SSE_CLIENTS, 500, 1);
const AI_RATE_WINDOW_MS = 60 * 1000;
const ASSISTANT_CACHE_TTL_MS = 10 * 60 * 1000;
const ASSISTANT_CACHE_MAX = 200;
const ASSISTANT_TEXT_MAX = 400;
const ROUTING_CACHE_TTL_MS = 10 * 60 * 1000;
const ROUTING_CACHE_MAX = 500;
const POSTMORTEM_CACHE_TTL_MS = 10 * 60 * 1000;
const POSTMORTEM_CACHE_MAX = 300;
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_KEYS_LIMIT = 5000;
const aiUsage = new Map();
const assistantUsage = new Map();
const assistantCache = new Map();
const routingUsage = new Map();
const routingCache = new Map();
const postmortemUsage = new Map();
const postmortemCache = new Map();
const triageUsage = new Map();
const loginFailures = new Map();
const registerUsage = new Map();
const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const store = new Store(DATA_DIR);
const auth = new Auth(store);
const ai = new AiClient();
const itsm = new ItsmClient(process.env.ITSM_MOCK_URL || 'http://127.0.0.1:3001', itsmTimeoutMs);
const eventClients = new Set();
const wallEventClients = new Set();

let operationTail = Promise.resolve();
let pendingOperations = 0;
let pollTimer;
let sessionCleanupTimer;
let shuttingDown = false;
let storeClosed = false;

class HttpError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

class ConflictError extends HttpError {
  constructor(incident) {
    super('Версия инцидента изменилась; повторите действие с актуальным expectedVersion', 409);
    this.incident = incident;
  }
}

function enqueue(operation) {
  pendingOperations += 1;
  const result = operationTail.then(operation, operation);
  operationTail = result.catch(() => {});
  return result.finally(() => {
    pendingOperations -= 1;
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  const payload = { error: status === 500 ? 'Внутренняя ошибка сервера' : error.message };
  if (status !== 500 && typeof error.code === 'string' && error.code) payload.code = error.code;
  if (error instanceof ConflictError) {
    payload.incident = error.incident;
    payload.currentVersion = error.incident.version;
  }
  if (status === 500) console.error(error);
  if (!res.headersSent) sendJson(res, status, payload);
  else res.destroy();
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    req.resume();
    throw new HttpError('Ожидался Content-Type: application/json', 415);
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    req.resume();
    throw new HttpError('JSON body превышает 5 MiB', 413);
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) throw new HttpError('JSON body превышает 5 MiB', 413);
  if (size === 0) throw new HttpError('JSON body не должен быть пустым', 400);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError('Некорректный JSON', 400);
  }
}

async function readObject(req) {
  const body = await readJson(req);
  if (!isObject(body)) throw new HttpError('Ожидался JSON-объект', 400);
  return body;
}

async function readOptionalObject(req) {
  const declaredLength = req.headers['content-length'];
  const chunked = req.headers['transfer-encoding'] !== undefined;
  const hasBody = chunked || (declaredLength !== undefined && Number(declaredLength) !== 0);
  if (!hasBody) return {};
  return readObject(req);
}

function checkOrigin(req) {
  if (!MUTATING_METHODS.has(req.method) || req.headers.origin === undefined) return;
  const host = req.headers.host;
  if (!host) throw new HttpError('Origin не совпадает с origin запроса', 403);
  const expected = publicOrigin || `${auth.secure ? 'https' : 'http'}://${host}`;
  let actual;
  try {
    actual = new URL(String(req.headers.origin)).origin;
  } catch {
    throw new HttpError('Origin не совпадает с origin запроса', 403);
  }
  if (actual !== expected) throw new HttpError('Origin не совпадает с origin запроса', 403);
}

function sessionTokenHash(token) {
  return token ? crypto.createHash('sha256').update(token).digest('hex') : null;
}

function requireUser(req) {
  const token = auth.tokenFromRequest(req);
  const user = auth.userForToken(token);
  if (!user) throw new HttpError('Требуется аутентификация', 401);
  return { token, user };
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') {
    throw new HttpError('Требуются права администратора', 403, 'forbidden');
  }
}

function enforceAiRateLimit(user) {
  if (aiRateLimitPerMinute === 0) return;
  const now = Date.now();
  const timestamps = (aiUsage.get(user.id) || [])
    .filter(timestamp => timestamp > now - AI_RATE_WINDOW_MS);
  if (timestamps.length >= aiRateLimitPerMinute) {
    aiUsage.set(user.id, timestamps);
    throw new HttpError('Слишком много запросов ИИ; повторите позже', 429, 'rate_limited');
  }
  timestamps.push(now);
  aiUsage.set(user.id, timestamps);
}

function enforceAssistantRateLimit(user) {
  if (assistantRateLimitPerMinute === 0) return;
  const now = Date.now();
  const timestamps = (assistantUsage.get(user.id) || [])
    .filter(timestamp => timestamp > now - AI_RATE_WINDOW_MS);
  if (timestamps.length >= assistantRateLimitPerMinute) {
    assistantUsage.set(user.id, timestamps);
    throw new HttpError('Слишком много запросов к ассистенту; повторите позже', 429, 'rate_limited');
  }
  timestamps.push(now);
  assistantUsage.set(user.id, timestamps);
}

function enforceRoutingRateLimit(user) {
  if (routingRateLimitPerMinute === 0) return;
  const now = Date.now();
  const timestamps = (routingUsage.get(user.id) || [])
    .filter(timestamp => timestamp > now - AI_RATE_WINDOW_MS);
  if (timestamps.length >= routingRateLimitPerMinute) {
    routingUsage.set(user.id, timestamps);
    throw new HttpError('Слишком много запросов маршрутизации; повторите позже', 429, 'rate_limited');
  }
  timestamps.push(now);
  routingUsage.set(user.id, timestamps);
}

function enforcePostmortemRateLimit(user) {
  if (postmortemRateLimitPerMinute === 0) return;
  const now = Date.now();
  const timestamps = (postmortemUsage.get(user.id) || [])
    .filter(timestamp => timestamp > now - AI_RATE_WINDOW_MS);
  if (timestamps.length >= postmortemRateLimitPerMinute) {
    postmortemUsage.set(user.id, timestamps);
    throw new HttpError('Слишком много запросов постмортема; повторите позже', 429, 'rate_limited');
  }
  timestamps.push(now);
  postmortemUsage.set(user.id, timestamps);
}

function enforceTriageRateLimit(user) {
  if (triageRateLimitPerMinute === 0) return;
  const now = Date.now();
  const timestamps = (triageUsage.get(user.id) || [])
    .filter(timestamp => timestamp > now - AI_RATE_WINDOW_MS);
  if (timestamps.length >= triageRateLimitPerMinute) {
    triageUsage.set(user.id, timestamps);
    throw new HttpError('Слишком много запросов сканирования триажа; повторите позже', 429, 'rate_limited');
  }
  timestamps.push(now);
  triageUsage.set(user.id, timestamps);
}

function cachedAssistantResult(key) {
  const entry = assistantCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    assistantCache.delete(key);
    return null;
  }
  return entry.result;
}

function rememberAssistantResult(key, result) {
  if (assistantCache.size >= ASSISTANT_CACHE_MAX) {
    const oldest = assistantCache.keys().next().value;
    if (oldest !== undefined) assistantCache.delete(oldest);
  }
  assistantCache.set(key, { result, expiresAt: Date.now() + ASSISTANT_CACHE_TTL_MS });
}

function cachedRoutingResult(key) {
  const entry = routingCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    routingCache.delete(key);
    return null;
  }
  return entry.result;
}

function rememberRoutingResult(key, result) {
  if (routingCache.size >= ROUTING_CACHE_MAX) {
    const oldest = routingCache.keys().next().value;
    if (oldest !== undefined) routingCache.delete(oldest);
  }
  routingCache.set(key, { result, expiresAt: Date.now() + ROUTING_CACHE_TTL_MS });
}

function cachedPostmortem(key) {
  const entry = postmortemCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    postmortemCache.delete(key);
    return null;
  }
  return entry.result;
}

function rememberPostmortem(key, result) {
  if (postmortemCache.size >= POSTMORTEM_CACHE_MAX) {
    const oldest = postmortemCache.keys().next().value;
    if (oldest !== undefined) postmortemCache.delete(oldest);
  }
  postmortemCache.set(key, { result, expiresAt: Date.now() + POSTMORTEM_CACHE_TTL_MS });
}

function loginThrottleKey(req, body) {
  const login = isObject(body) && typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
  return `${req.socket.remoteAddress || 'unknown'}|${login}`;
}

function recentLoginFailures(key, now) {
  const timestamps = (loginFailures.get(key) || [])
    .filter(timestamp => timestamp > now - LOGIN_FAILURE_WINDOW_MS);
  if (timestamps.length) loginFailures.set(key, timestamps);
  else loginFailures.delete(key);
  return timestamps;
}

function checkLoginRateLimit(key, now) {
  if (recentLoginFailures(key, now).length >= LOGIN_FAILURE_LIMIT) {
    throw new HttpError('Слишком много попыток входа; повторите позже', 429, 'rate_limited');
  }
}

function checkRegisterRateLimit(req, now) {
  const key = req.socket.remoteAddress || 'unknown';
  const timestamps = (registerUsage.get(key) || []).filter(timestamp => timestamp > now - REGISTER_WINDOW_MS);
  if (timestamps.length >= REGISTER_LIMIT) {
    throw new HttpError('Слишком много регистраций с этого адреса; повторите позже', 429, 'rate_limited');
  }
  timestamps.push(now);
  registerUsage.set(key, timestamps);
  if (registerUsage.size > 5000) registerUsage.delete(registerUsage.keys().next().value);
}

function recordLoginFailure(key, now) {
  const timestamps = recentLoginFailures(key, now);
  timestamps.push(now);
  loginFailures.set(key, timestamps);
  while (loginFailures.size > LOGIN_FAILURE_KEYS_LIMIT) {
    loginFailures.delete(loginFailures.keys().next().value);
  }
}

function openEvents(req, res, userId = null, tokenHash = null) {
  if (eventClients.size >= MAX_SSE_CLIENTS) {
    throw new HttpError('Слишком много открытых потоков; повторите позже', 503, 'too_many_streams');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });
  res.write('retry: 3000\n: connected\n\n');
  const client = {
    res,
    heartbeat: null,
    userId: userId === null ? null : String(userId),
    tokenHash: tokenHash || null
  };
  const cleanup = () => {
    if (!eventClients.has(client)) return;
    clearInterval(client.heartbeat);
    eventClients.delete(client);
  };
  client.heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);
  eventClients.add(client);
  req.once('close', cleanup);
  res.once('close', cleanup);
}

// The public wall has its own subscriber set: it must never enable or count
// toward coordinator Live demo generation.
function openWallEvents(req, res) {
  if (wallEventClients.size >= MAX_SSE_CLIENTS) {
    throw new HttpError('Слишком много открытых потоков; повторите позже', 503, 'too_many_streams');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });
  res.write('retry: 3000\n: connected\n\n');
  const client = { res, heartbeat: null, userId: null };
  const cleanup = () => {
    if (!wallEventClients.has(client)) return;
    clearInterval(client.heartbeat);
    wallEventClients.delete(client);
  };
  client.heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);
  wallEventClients.add(client);
  req.once('close', cleanup);
  res.once('close', cleanup);
  try {
    if (!res.destroyed) res.write(`event: wallboard\ndata: ${JSON.stringify(wallboardPayload())}\n\n`);
  } catch {
    res.destroy();
  }
}

function writeEvent(client, event, data) {
  if (client.res.destroyed) return;
  try {
    // Drop hopeless consumers instead of buffering the whole dashboard in memory.
    if (client.res.writableLength > 1024 * 1024) {
      client.res.destroy();
      return;
    }
    client.res.write(`event: ${event}\ndata: ${data}\n\n`);
  } catch {
    client.res.destroy();
  }
}

function closeEventClients(predicate) {
  for (const client of eventClients) {
    if (!predicate(client)) continue;
    clearInterval(client.heartbeat);
    eventClients.delete(client);
    try { client.res.end(); } catch { client.res.destroy(); }
  }
}

function broadcastIncidents(changes) {
  if (changes.added === 0 && changes.updated === 0) return;
  const data = JSON.stringify({
    type: 'incidents.changed',
    added: changes.added,
    updated: changes.updated,
    source: changes.source
  });
  for (const client of eventClients) writeEvent(client, 'incidents', data);
  for (const client of wallEventClients) writeEvent(client, 'incidents', data);
}

function broadcastSync(payload) {
  const data = JSON.stringify(payload);
  for (const client of eventClients) writeEvent(client, 'sync', data);
  for (const client of wallEventClients) writeEvent(client, 'sync', data);
}

function broadcastNotification(userId, notification, unread) {
  if (!userId || !notification) return;
  const targetUserId = String(userId);
  const data = JSON.stringify({ type: 'notification.created', notification, unread });
  for (const client of eventClients) {
    if (client.userId === targetUserId) writeEvent(client, 'notification', data);
  }
}

function notifyCoordinatorAssignment(incident, coordinator, actor) {
  if (!incident || !coordinator || coordinator.id === actor.id) return null;
  try {
    // Reassigning the same case repeatedly must not pile up duplicate unread
    // "you were assigned" items for the recipient.
    store.markUnreadAssignmentsForCase(coordinator.id, incident.caseId);
    const notification = store.createNotification({
      userId: coordinator.id,
      caseId: incident.caseId,
      incidentId: incident.id,
      type: 'coordinator_assigned',
      title: 'Вам назначен инцидент',
      message: `${incident.id} · ${incident.title}`
    });
    const unread = store.countUnreadNotifications(coordinator.id);
    broadcastNotification(coordinator.id, notification, unread);
    return notification;
  } catch (error) {
    console.error('Не удалось создать уведомление о назначении координатора', error);
    return null;
  }
}

async function loadDelta() {
  try {
    return { delta: await itsm.getChanges(store.getCurrentRevision()), reset: false };
  } catch (error) {
    if (!(error instanceof ItsmError) || error.code !== 'revision_ahead') throw error;
    try {
      const backup = store.backup('itsm-revision-reset');
      console.warn(`ITSM revision опережает локальную; сделан backup ${backup}; локальное состояние перечитывается`);
    } catch (backupError) {
      console.error('Не удалось создать backup перед перечитыванием состояния ITSM', backupError);
    }
    store.resetSyncState();
    return { delta: await itsm.getChanges(0), reset: true };
  }
}

async function demoTickSafe() {
  try {
    return await itsm.demoTick();
  } catch (error) {
    console.warn(
      'Демо-шаг mock пропущен:',
      error instanceof ItsmError ? error.message : 'не удалось выполнить tick'
    );
    return null;
  }
}

async function synchronize(source, generate = false) {
  const previousSyncError = store.getSyncState().syncError;
  try {
    const demo = generate && store.countActiveCases() < demoMaxActive ? await demoTickSafe() : null;
    const { delta, reset } = await loadDelta();
    const changes = store.applyDelta(delta.incidents, delta.revision);
    if (reset) {
      broadcastSync({ type: 'sync.recovered', lastSyncedAt: changes.lastSyncedAt, reset: true });
    } else if (previousSyncError !== null) {
      broadcastSync({ type: 'sync.recovered', lastSyncedAt: changes.lastSyncedAt });
    }
    if (Array.isArray(changes.rejected) && changes.rejected.length) {
      broadcastSync({ type: 'sync.warning', error: changes.syncError, rejected: changes.rejected });
    }
    broadcastIncidents({ ...changes, source });
    return { ...changes, ...(demo ? { demo } : {}) };
  } catch (error) {
    const safeMessage = error instanceof ItsmError || error instanceof ValidationError
      ? error.message
      : 'Не удалось синхронизировать данные с ITSM';
    store.recordSyncError(safeMessage);
    if (previousSyncError !== safeMessage) {
      broadcastSync({ type: 'sync.error', error: safeMessage });
    }
    throw error;
  }
}

function dashboard() {
  const incidents = store.listCases();
  return {
    incidents,
    counts: countIncidents(incidents),
    ...store.getSyncState()
  };
}

function wallCase(incident) {
  return {
    caseId: incident.caseId,
    incidentId: incident.id,
    title: incident.title,
    product: incident.product,
    service: incident.service,
    region: incident.region,
    priorityId: incident.priorityId,
    priority: incident.priority,
    priorityText: incident.priorityText,
    status: incident.status,
    stateId: incident.stateId,
    team: incident.team,
    startedAt: incident.startedAt,
    dueAt: incident.dueAt,
    affectedUsers: incident.affectedUsers,
    reportCount: incident.reportCount,
    isNeedUp: incident.isNeedUp,
    groups: Array.isArray(incident.groups) ? [...incident.groups] : []
  };
}

function compareWallQueue(a, b) {
  const aDue = a.dueAt === null || a.dueAt === undefined ? Number.POSITIVE_INFINITY : a.dueAt;
  const bDue = b.dueAt === null || b.dueAt === undefined ? Number.POSITIVE_INFINITY : b.dueAt;
  if (aDue !== bDue) return aDue - bDue;
  const byAffected = (b.affectedUsers || 0) - (a.affectedUsers || 0);
  if (byAffected) return byAffected;
  return String(a.caseId).localeCompare(String(b.caseId));
}

function aggregateWall(list, field) {
  const groups = new Map();
  for (const incident of list) {
    const key = typeof incident[field] === 'string' ? incident[field].trim() : '';
    if (!key) continue;
    let entry = groups.get(key);
    if (!entry) {
      entry = { [field]: key, total: 0, critical: 0, high: 0, affectedUsers: 0 };
      groups.set(key, entry);
    }
    entry.total += 1;
    if (incident.groups.includes('critical')) entry.critical += 1;
    if (incident.groups.includes('high')) entry.high += 1;
    entry.affectedUsers += Number(incident.affectedUsers) || 0;
  }
  return [...groups.values()]
    .sort((a, b) => b.total - a.total || String(a[field]).localeCompare(String(b[field]), 'ru'))
    .slice(0, WALL_LIST_LIMIT);
}

// Public wallboard: aggregate, read-only, and free of coordinator identity.
function wallboardPayload() {
  const generatedAt = Date.now();
  const incidents = store.listCases();
  const active = incidents.filter(incident => (
    Array.isArray(incident.groups) && incident.groups.includes('active')
  ));
  const sync = store.getSyncState();
  const critical = active
    .filter(incident => incident.groups.includes('critical'))
    .sort(compareWallQueue)
    .slice(0, WALL_LIST_LIMIT)
    .map(wallCase);
  const high = active
    .filter(incident => incident.groups.includes('high'))
    .sort(compareWallQueue)
    .slice(0, WALL_LIST_LIMIT)
    .map(wallCase);
  const slaRisk = active
    .filter(incident => incident.dueAt !== null && incident.dueAt !== undefined &&
      incident.dueAt <= generatedAt + SLA_RISK_WINDOW_MS)
    .sort(compareWallQueue)
    .slice(0, WALL_LIST_LIMIT)
    .map(incident => ({ ...wallCase(incident), remainingMs: incident.dueAt - generatedAt }));
  const unassignedAll = active.filter(incident => !incident.team).sort(compareWallQueue);
  const recent = store.listRecentChanges(WALL_RECENT_LIMIT);

  return {
    generatedAt,
    live: sync.syncError === null,
    sync,
    counts: countIncidents(incidents, generatedAt),
    critical,
    high,
    teams: aggregateWall(active, 'team'),
    slaRisk,
    unassigned: {
      count: unassignedAll.length,
      cases: unassignedAll.slice(0, WALL_LIST_LIMIT).map(wallCase)
    },
    products: aggregateWall(active, 'product'),
    regions: aggregateWall(active, 'region'),
    recent,
    recentChanges: recent
  };
}

function requiredCase(caseId) {
  const incident = store.getCase(caseId);
  if (!incident) throw new HttpError('Инцидент не найден', 404);
  return incident;
}

function checkExpectedVersion(body, incident) {
  const expectedVersion = integer(body.expectedVersion);
  if (expectedVersion === null || expectedVersion < 0) {
    throw new HttpError('expectedVersion должен быть неотрицательным целым числом', 400);
  }
  if (expectedVersion !== incident.version) throw new ConflictError(incident);
}

function checkOptionalExpectedVersion(body, incident) {
  if (!Object.hasOwn(body, 'expectedVersion')) return;
  const expectedVersion = integer(body.expectedVersion);
  if (expectedVersion === null || expectedVersion < 0) {
    throw new HttpError('expectedVersion должен быть неотрицательным целым числом', 400);
  }
  if (expectedVersion !== incident.version) throw new ConflictError(incident);
}

async function claimCase(caseId, user, body) {
  return enqueue(async () => {
    const current = requiredCase(caseId);
    checkExpectedVersion(body, current);
    if (current.groups.includes('closed')) {
      throw new HttpError('Нельзя взять в работу закрытый инцидент', 409, 'case_closed');
    }
    if (current.coordinatorId && current.coordinatorId !== user.id) {
      throw new HttpError('Инцидент уже назначен другому координатору', 409, 'already_assigned');
    }
    if (current.coordinatorId === user.id) return { incident: current };
    await itsm.bulkUpdate(current.sourceIds, { coordinatorId: user.id, coordinatorName: user.name });
    await synchronize('claim');
    store.recordHistory({
      caseId,
      user,
      action: 'claim',
      details: { coordinatorId: user.id, coordinatorName: user.name }
    });
    return { incident: requiredCase(caseId) };
  });
}

async function reassignCase(caseId, user, body) {
  return enqueue(async () => {
    const current = requiredCase(caseId);
    checkExpectedVersion(body, current);
    const coordinatorId = nullableText(body.coordinatorId);
    if (!coordinatorId) throw new HttpError('coordinatorId обязателен', 400);
    const coordinator = store.getUserById(coordinatorId);
    if (!coordinator) throw new HttpError('Координатор не найден', 404);
    if (current.coordinatorId === coordinator.id) return { incident: current };
    await itsm.bulkUpdate(current.sourceIds, {
      coordinatorId: coordinator.id,
      coordinatorName: coordinator.name
    });
    await synchronize('coordinator');
    store.recordHistory({
      caseId,
      user,
      action: 'reassign',
      details: { coordinatorId: coordinator.id, coordinatorName: coordinator.name }
    });
    const incident = requiredCase(caseId);
    notifyCoordinatorAssignment(incident, coordinator, user);
    return { incident };
  });
}

async function setPriority(caseId, user, body) {
  const priorityId = integer(body.priorityId);
  if (!Object.hasOwn(PRIORITIES, priorityId)) {
    throw new HttpError('priorityId должен быть равен 1, 2, 3 или 4', 400);
  }
  return enqueue(async () => {
    const current = requiredCase(caseId);
    checkOptionalExpectedVersion(body, current);
    if (current.groups.includes('closed')) {
      throw new HttpError('Нельзя менять приоритет закрытого инцидента', 409, 'case_closed');
    }
    if (current.priorityOverrideId === priorityId) return { incident: current };
    await itsm.bulkUpdate(current.sourceIds, { priorityOverrideId: priorityId });
    store.setPriorityOverride(caseId, priorityId);
    await synchronize('priority');
    store.recordHistory({
      caseId,
      user,
      action: 'priority',
      details: { priorityId, autoPriorityId: current.autoPriorityId }
    });
    return { incident: requiredCase(caseId) };
  });
}

async function clearPriorityOverride(caseId, user) {
  return enqueue(async () => {
    const current = requiredCase(caseId);
    if (current.groups.includes('closed')) {
      throw new HttpError('Нельзя менять приоритет закрытого инцидента', 409, 'case_closed');
    }
    if (current.priorityOverrideId === null) return { incident: current };
    await itsm.bulkUpdate(current.sourceIds, { priorityOverrideId: null });
    store.setPriorityOverride(caseId, null);
    await synchronize('priority');
    store.recordHistory({
      caseId,
      user,
      action: 'priority-override.delete',
      details: { autoPriorityId: current.autoPriorityId }
    });
    return { incident: requiredCase(caseId) };
  });
}

async function setDeadline(caseId, user, body) {
  if (body.deadline !== null && body.deadline !== undefined && parseTimestamp(body.deadline) === null) {
    throw new HttpError('deadline должен содержать корректную дату или null', 400);
  }
  const deadlineMs = body.deadline === undefined ? null : parseTimestamp(body.deadline);
  if (deadlineMs !== null && Math.abs(deadlineMs) > 8.64e15) {
    throw new HttpError('deadline выходит за допустимый диапазон дат', 400);
  }
  const deadline = deadlineMs === null ? null : new Date(deadlineMs).toISOString();
  return enqueue(async () => {
    const current = requiredCase(caseId);
    checkOptionalExpectedVersion(body, current);
    if (current.groups.includes('closed')) {
      throw new HttpError('Нельзя менять срок закрытого инцидента', 409, 'case_closed');
    }
    if (current.dueAt === deadlineMs) return { incident: current };
    await itsm.bulkUpdate(current.sourceIds, { deadline });
    await synchronize('deadline');
    store.recordHistory({ caseId, user, action: 'deadline', details: { deadline: deadlineMs } });
    return { incident: requiredCase(caseId) };
  });
}

async function setTeam(caseId, user, body) {
  const team = nullableText(body.team);
  if (!team || team.length > 200) throw new HttpError('team обязателен и должен содержать не более 200 символов', 400);
  if (!MTS_TEAMS.includes(team)) {
    throw new HttpError('team должен быть одной из команд МТС из справочника', 400, 'unknown_team');
  }
  return enqueue(async () => {
    const current = requiredCase(caseId);
    checkOptionalExpectedVersion(body, current);
    if (!current.groups.includes('active')) {
      throw new HttpError('Передать команду можно только активному инциденту', 409);
    }
    if (current.team === team && current.stateId === 2) return { incident: current };
    await itsm.bulkUpdate(current.sourceIds, {
      assignedGroupName: team,
      stateId: 2,
      solution: null,
      completionDate: null
    });
    // An explicit team action wins over the team preserved by a manual merge.
    store.clearTeamOverride(caseId);
    await synchronize('team');
    store.recordHistory({ caseId, user, action: 'team', details: { team, stateId: 2 } });
    return { incident: requiredCase(caseId) };
  });
}

async function setStatus(caseId, user, body) {
  const stateId = integer(body.stateId);
  if (!Object.hasOwn(STATES, stateId)) {
    throw new HttpError('stateId должен быть равен 0, 2, 20, 7 или 10', 400);
  }
  if (body.solution !== undefined && body.solution !== null && typeof body.solution !== 'string') {
    throw new HttpError('solution должен быть строкой или null', 400);
  }
  if (typeof body.solution === 'string' && body.solution.length > 10000) {
    throw new HttpError('solution должен содержать не более 10000 символов', 400);
  }

  return enqueue(async () => {
    const current = requiredCase(caseId);
    checkOptionalExpectedVersion(body, current);
    const allowedTransitions = STATUS_TRANSITIONS[current.stateId] || [];
    if (!allowedTransitions.includes(stateId)) {
      throw new HttpError(`Недопустимый переход статуса: ${current.stateId} → ${stateId}`, 409);
    }
    const active = stateId === 0 || stateId === 2;
    const research = stateId === 20;
    const closed = stateId === 7 || stateId === 10;
    let solution = body.solution === undefined ? current.solution : nullableText(body.solution);
    if (research && !solution) throw new HttpError('Для research требуется непустой solution', 400);

    const patch = { stateId };
    if (active) {
      solution = null;
      patch.solution = null;
      patch.completionDate = null;
    } else if (research) {
      patch.solution = solution;
      patch.completionDate = null;
    } else if (closed) {
      patch.solution = solution;
      patch.completionDate = current.groups.includes('closed')
        ? current.resolvedAt === null ? null : new Date(current.resolvedAt).toISOString()
        : new Date().toISOString();
    }

    if (current.stateId === stateId && current.solution === solution) return { incident: current };
    await itsm.bulkUpdate(current.sourceIds, patch);
    await synchronize('status');
    store.recordHistory({ caseId, user, action: 'status', details: { stateId, solution } });
    return { incident: requiredCase(caseId) };
  });
}

function decodeCaseId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError('Некорректный caseId', 400);
  }
}

const SLA_RISK_WINDOW_MS = 15 * 60 * 1000;
const WALL_LIST_LIMIT = 20;
const WALL_RECENT_LIMIT = 12;
const MAX_AI_ATTENTIONS = 20;
const MAX_AI_HISTORY = 30;
const MAX_AI_DETAILS_LENGTH = 1000;
const AI_TIME_ZONE = 'Europe/Moscow';
const AI_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  timeZone: AI_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});
const AI_TIME_RULES = 'Формат дат: ДД.ММ.ГГГГ ЧЧ:ММ МСК. Не выводи сырые числовые таймстемпы (epoch) и не пересчитывай даты самостоятельно.';

function aiTimeLabel(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${AI_TIME_FORMATTER.format(date).replace(',', '')} МСК`;
}

function promptCase(brief) {
  return {
    ...brief,
    startedAt: aiTimeLabel(brief.startedAt),
    dueAt: aiTimeLabel(brief.dueAt)
  };
}

function promptHistoryDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return details;
  const formatted = { ...details };
  if (Object.hasOwn(formatted, 'deadline')) formatted.deadline = aiTimeLabel(formatted.deadline);
  return formatted;
}

function incidentBrief(incident) {
  return {
    id: incident.id,
    title: incident.title,
    product: incident.product,
    service: incident.service,
    region: incident.region,
    affectedUsers: incident.affectedUsers,
    reportCount: incident.reportCount,
    priority: incident.priority,
    priorityId: incident.priorityId,
    priorityText: incident.priorityText,
    status: incident.status,
    team: incident.team,
    coordinatorName: incident.coordinatorName,
    startedAt: incident.startedAt,
    dueAt: incident.dueAt,
    isNeedUp: incident.isNeedUp,
    isMaster: incident.isMaster,
    isEffect: incident.isEffect
  };
}

function topCases(incidents) {
  return incidents
    .filter(incident => Array.isArray(incident.groups) && incident.groups.includes('active'))
    .map(incidentBrief)
    .sort((a, b) => {
      const priorityDifference = (b.priorityId ?? 0) - (a.priorityId ?? 0);
      if (priorityDifference) return priorityDifference;
      if (a.dueAt !== null && b.dueAt !== null) return a.dueAt - b.dueAt;
      if (a.dueAt !== null) return -1;
      if (b.dueAt !== null) return 1;
      return (b.affectedUsers ?? 0) - (a.affectedUsers ?? 0);
    })
    .slice(0, 8);
}

function compactDetails(details) {
  if (details === undefined || details === null) return undefined;
  const serialized = JSON.stringify(details);
  if (!serialized || serialized === '{}') return undefined;
  return serialized.length > MAX_AI_DETAILS_LENGTH ? `${serialized.slice(0, MAX_AI_DETAILS_LENGTH)}…` : serialized;
}

function buildDashboardPrompt(data) {
  const incidents = Array.isArray(data.incidents) ? data.incidents : [];
  const lines = [
    'Составь краткую общую сводку по текущим инцидентам координатора: сколько активных/критических/research/SLA, затронутых пользователей, и три приоритетных внимания.',
    AI_TIME_RULES,
    'Текущее время:',
    aiTimeLabel(Date.now()),
    'Счётчики:',
    JSON.stringify(data.counts || {}),
    'Наиболее приоритетные/SLA-рисковые/массовые активные инциденты:',
    JSON.stringify(topCases(incidents).map(promptCase))
  ];
  return lines.join('\n');
}

function buildIncidentPrompt(incident, history) {
  const lines = [
    'Составь сводку по инциденту: ситуация, динамика, SLA, рекомендуемая команда/действие.',
    AI_TIME_RULES,
    'Текущее время:',
    aiTimeLabel(Date.now()),
    'Данные инцидента:',
    JSON.stringify({
      ...incidentBrief(incident),
      startedAt: aiTimeLabel(incident.startedAt),
      dueAt: aiTimeLabel(incident.dueAt),
      description: incident.description,
      scenario: incident.scenario,
      prioritySource: incident.prioritySource,
      groups: incident.groups,
      resolvedAt: aiTimeLabel(incident.resolvedAt),
      solution: incident.solution
    }),
    'История изменений (новые записи первыми):',
    JSON.stringify((history || []).slice(0, MAX_AI_HISTORY).map(item => ({
      action: item.action,
      user: item.userName,
      at: aiTimeLabel(item.createdAt),
      details: compactDetails(promptHistoryDetails(item.details))
    })))
  ];
  return lines.join('\n');
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item)).filter(item => item.trim()).slice(0, MAX_AI_ATTENTIONS);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (value !== null && value !== undefined) return [String(value)];
  return [];
}

function normalizeAiResult(result) {
  return {
    summary: firstString(result.summary, result.text, result.content),
    attentions: asStringArray(
      result.attentions ?? result.attention ?? result.alerts ?? result.warnings
    ),
    recommendation: firstString(result.recommendation, result.recommendations, result.advice, result.action)
  };
}

function fallbackSummary() {
  const data = dashboard();
  const counts = data.counts || {};
  const top = topCases(data.incidents || []);
  const summary = `Автоматическая сводка. Активных инцидентов: ${counts.active ?? 0}, критических: ${counts.critical ?? 0}, высоких: ${counts.high ?? 0}, на исследовании: ${counts.research ?? 0}, в зоне риска SLA: ${counts.risk ?? 0}, затронуто пользователей: ${counts.affectedUsers ?? 0}.`;
  const attentions = [];
  if (counts.critical) attentions.push(`Требуют немедленного внимания ${counts.critical} критических инцидентов.`);
  if (counts.coordination) attentions.push(`${counts.coordination} инцидентов ожидают назначения профильной команды.`);
  if (counts.risk) attentions.push(`${counts.risk} инцидентов находятся в зоне риска SLA.`);
  if (!attentions.length) attentions.push('Критических замечаний нет.');
  if (top.length) attentions.push(`Крупнейший по охвату: ${top[0].id} (${top[0].affectedUsers ?? 0} пользователей).`);
  const recommendation = counts.coordination
    ? 'Приоритетно распределить инциденты, ожидающие назначения команды.'
    : 'Продолжать мониторинг SLA и динамики массовых инцидентов.';
  return { summary, attentions, recommendation };
}

function fallbackIncidentSummary(incident) {
  const summary = `Автоматическая сводка. ${incident.title} (${incident.id}) — ${incident.product}, затронуто ${incident.affectedUsers} пользователей, приоритет ${incident.priorityText}, статус ${incident.status}.`;
  const attentions = [];
  if (incident.groups.includes('critical')) attentions.push('Критический приоритет требует немедленной реакции.');
  if (incident.groups.includes('coordination')) attentions.push('Инцидент находится на координации и требует назначения профильной команды.');
  if (incident.dueAt !== null && incident.dueAt !== undefined && incident.dueAt <= Date.now() + SLA_RISK_WINDOW_MS) {
    attentions.push('Риск нарушения SLA: срок близок или уже истёк.');
  }
  if (incident.isNeedUp) attentions.push('Запись требует эскалации (isNeedUp).');
  if (!attentions.length) attentions.push('Особых рисков не выявлено.');
  const recommendation = incident.groups.includes('coordination')
    ? 'Назначить профильную команду для обработки инцидента.'
    : 'Контролировать SLA и динамику обращений.';
  return { summary, attentions, recommendation };
}

async function postmortemGenerate(body) {
  if (!postmortemEnabled) {
    throw new HttpError('Постмортем отключён', 404, 'postmortem_disabled');
  }
  const caseId = nullableText(body.caseId);
  if (!caseId) throw new HttpError('caseId обязателен', 400, 'invalid_case');
  const incident = requiredCase(caseId);
  const history = store.listHistory(caseId);
  const signature = caseId + ':' + incident.version + ':' + history.length + ':' + (history[0] ? history[0].id : 0);
  const cached = cachedPostmortem(signature);
  if (cached) return cached;
  const result = await generatePostmortem(ai, incident, history, { timeoutMs: postmortemTimeoutMs });
  const payload = { caseId, version: incident.version, ...result };
  rememberPostmortem(signature, payload);
  return payload;
}

function triageReport() {
  return buildDeterministicReport(store.listCases());
}

async function triageScan() {
  return scanTriage(ai, store.listCases(), {
    aiEnabled: triageAiEnabled,
    timeoutMs: triageTimeoutMs
  });
}

function incidentLifecycle(incident) {
  const groups = Array.isArray(incident.groups) ? incident.groups : [];
  if (groups.includes('closed')) return 'closed';
  if (groups.includes('active')) return 'active';
  if (groups.includes('research')) return 'research';
  return 'unknown';
}

function requiredLifecycleVersion(value, label) {
  const version = integer(value);
  if (version === null || version < 0) {
    throw new HttpError(label + ' должен быть неотрицательным целым числом', 400);
  }
  return version;
}

function mergeSourceCaseIds(body, targetCaseId) {
  const values = [];
  if (body.sourceCaseIds !== undefined && body.sourceCaseIds !== null) {
    if (!Array.isArray(body.sourceCaseIds)) {
      throw new HttpError('sourceCaseIds должен быть массивом caseId', 400, 'invalid_merge');
    }
    values.push(...body.sourceCaseIds);
  }
  if (body.sourceCaseId !== undefined && body.sourceCaseId !== null) {
    values.push(body.sourceCaseId);
  }

  const sourceCaseIds = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new HttpError('sourceCaseIds должен содержать непустые строки', 400, 'invalid_merge');
    }
    const sourceCaseId = value.trim();
    if (sourceCaseId.length > 200) {
      throw new HttpError('sourceCaseId слишком длинный', 400, 'invalid_merge');
    }
    if (sourceCaseId === targetCaseId) {
      throw new HttpError('Нельзя объединить инцидент с самим собой', 400, 'invalid_merge');
    }
    if (!seen.has(sourceCaseId)) {
      seen.add(sourceCaseId);
      sourceCaseIds.push(sourceCaseId);
    }
  }
  if (!sourceCaseIds.length) {
    throw new HttpError('sourceCaseIds обязателен', 400, 'invalid_merge');
  }
  if (sourceCaseIds.length > MAX_MERGE_SOURCES) {
    throw new HttpError('sourceCaseIds должен содержать не более ' + MAX_MERGE_SOURCES + ' значений', 400, 'invalid_merge');
  }
  return sourceCaseIds;
}

function mergeExpectedVersions(body, targetCaseId, sourceCaseIds) {
  let expectedVersions = {};
  if (body.expectedVersions !== undefined && body.expectedVersions !== null) {
    if (!isObject(body.expectedVersions)) {
      throw new HttpError('expectedVersions должен быть объектом {caseId: version}', 400, 'invalid_merge');
    }
    expectedVersions = body.expectedVersions;
  }
  const batch = Array.isArray(body.sourceCaseIds);
  const targetRaw = Object.hasOwn(body, 'expectedVersion') &&
      body.expectedVersion !== null && body.expectedVersion !== undefined
    ? body.expectedVersion
    : Object.hasOwn(expectedVersions, targetCaseId)
      ? expectedVersions[targetCaseId]
      : null;
  if (targetRaw === null || targetRaw === undefined) {
    if (!batch) {
      throw new HttpError('expectedVersion должен быть неотрицательным целым числом', 400, 'invalid_merge');
    }
  } else {
    requiredLifecycleVersion(targetRaw, 'expectedVersion');
  }

  const sourceVersions = new Map();
  for (const sourceCaseId of sourceCaseIds) {
    let raw;
    if (Object.hasOwn(expectedVersions, sourceCaseId)) {
      raw = expectedVersions[sourceCaseId];
    } else if (sourceCaseIds.length === 1 && Object.hasOwn(body, 'expectedSourceVersion')) {
      raw = body.expectedSourceVersion;
    }
    if (raw === null || raw === undefined) {
      throw new HttpError('expectedVersions["' + sourceCaseId + '"] обязателен', 400, 'invalid_merge');
    }
    sourceVersions.set(sourceCaseId, requiredLifecycleVersion(raw, 'expectedVersions["' + sourceCaseId + '"]'));
  }
  return {
    targetExpected: targetRaw === null || targetRaw === undefined
      ? null
      : requiredLifecycleVersion(targetRaw, 'expectedVersion'),
    sourceVersions
  };
}

async function mergeCasesRequest(targetCaseId, user, body) {
  const sourceCaseIds = mergeSourceCaseIds(body, targetCaseId);
  const { targetExpected, sourceVersions } = mergeExpectedVersions(body, targetCaseId, sourceCaseIds);

  return enqueue(async () => {
    const target = requiredCase(targetCaseId);
    if (targetExpected !== null && target.version !== targetExpected) throw new ConflictError(target);
    const sources = sourceCaseIds.map(sourceCaseId => requiredCase(sourceCaseId));
    for (const source of sources) {
      if (source.version !== sourceVersions.get(source.caseId)) throw new ConflictError(source);
    }

    const targetLifecycle = incidentLifecycle(target);
    const lifecycles = [targetLifecycle, ...sources.map(incidentLifecycle)];
    if (lifecycles.includes('closed')) {
      throw new HttpError('Нельзя объединять закрытые инциденты', 409, 'case_closed');
    }
    if (lifecycles.includes('unknown')) {
      throw new HttpError('Инцидент ещё не синхронизирован; повторите после синхронизации', 409, 'case_not_open');
    }
    if (lifecycles.some(lifecycle => lifecycle !== targetLifecycle)) {
      throw new HttpError(
        'Объединять можно только инциденты одного жизненного цикла (active+active или research+research)',
        409,
        'lifecycle_mismatch'
      );
    }
    if (targetLifecycle !== 'active' && targetLifecycle !== 'research') {
      throw new HttpError('Объединять можно только активные или research инциденты', 409, 'case_not_open');
    }

    const result = store.mergeCasesBatch(targetCaseId, sourceCaseIds, user);
    broadcastIncidents({ added: 0, updated: sourceCaseIds.length, source: 'merge' });
    return result;
  });
}

async function setCorrelationKeyRequest(caseId, user, body) {
  const correlationKey = nullableText(body.correlationKey);
  if (!correlationKey) {
    throw new HttpError('correlationKey обязателен', 400, 'invalid_correlation_key');
  }
  const expectedVersion = requiredLifecycleVersion(body.expectedVersion, 'expectedVersion');

  return enqueue(async () => {
    const current = requiredCase(caseId);
    if (current.version !== expectedVersion) throw new ConflictError(current);
    const incident = store.setCorrelationKey(caseId, correlationKey, user);
    const merged = incident.caseId !== caseId;
    if (merged || incident.version !== current.version) {
      broadcastIncidents({ added: 0, updated: 1, source: 'correlation-key' });
    }
    return {
      incident,
      merged,
      ...(merged ? { sourceCaseId: caseId } : {})
    };
  });
}

async function routingSuggest(body) {
  if (!routingEnabled) {
    throw new HttpError('Маршрутизация отключена', 404, 'routing_disabled');
  }
  const caseId = nullableText(body.caseId);
  if (!caseId) throw new HttpError('caseId обязателен', 400, 'invalid_case');
  const incident = requiredCase(caseId);
  if (!incident.groups.includes('active')) {
    throw new HttpError('Подсказка доступна только для активного инцидента', 409, 'not_active');
  }
  if (incident.team) {
    throw new HttpError('Команда уже назначена', 409, 'team_assigned');
  }
  const cacheKey = caseId + ':' + incident.version;
  const cached = cachedRoutingResult(cacheKey);
  if (cached) return cached;
  const suggestion = await suggestTeam(ai, incident, { timeoutMs: routingTimeoutMs });
  const result = {
    caseId,
    version: incident.version,
    team: suggestion.team,
    rationale: suggestion.rationale,
    confidence: suggestion.confidence,
    source: suggestion.source
  };
  rememberRoutingResult(cacheKey, result);
  return result;
}

async function assistantParse(body) {
  if (!assistantEnabled) {
    throw new HttpError('Ассистент отключён', 404, 'assistant_disabled');
  }
  const text = nullableText(body.text);
  if (!text) throw new HttpError('text обязателен', 400, 'invalid_text');
  if (text.length > ASSISTANT_TEXT_MAX) {
    throw new HttpError('text должен содержать не более ' + ASSISTANT_TEXT_MAX + ' символов', 400, 'invalid_text');
  }
  const cacheKey = crypto.createHash('sha256').update(text.toLocaleLowerCase('ru')).digest('hex');
  const cached = cachedAssistantResult(cacheKey);
  let parsed = cached;
  if (!parsed) {
    parsed = await askAssistant(ai, text, store.listCases());
    rememberAssistantResult(cacheKey, parsed);
  }
  if (parsed.intent === 'clarify') {
    return { intent: 'clarify', clarification: parsed.clarification, options: parsed.options || [] };
  }
  const matched = filterIncidents(store.listCases(), parsed.filter);
  return {
    intent: 'filter',
    filter: matched.filter,
    explanation: parsed.explanation,
    confidence: parsed.confidence,
    matched: {
      count: matched.total,
      active: matched.activeCount,
      closed: matched.closedCount,
      truncated: matched.truncated,
      caseIds: matched.items.map(incident => incident.caseId)
    }
  };
}

async function aiSummary(body) {
  const caseId = nullableText(body.caseId);
  const incident = caseId ? requiredCase(caseId) : null;
  const prompt = incident
    ? buildIncidentPrompt(incident, store.listHistory(caseId))
    : buildDashboardPrompt(dashboard());
  try {
    const result = await ai.summarize(prompt);
    return { ...normalizeAiResult(result), fallback: false };
  } catch (error) {
    if (!aiFallback || !(error instanceof AiError)) throw error;
    return {
      ...(incident ? fallbackIncidentSummary(incident) : fallbackSummary()),
      fallback: true,
      reason: { code: error.code, message: error.message }
    };
  }
}

function metaPayload() {
  return {
    priorities: { ...PRIORITIES },
    priorityLabels: { ...PRIORITY_TEXT },
    states: { ...STATES },
    transitions: STATUS_TRANSITIONS,
    teams: MTS_TEAMS,
    assistantEnabled,
    routingEnabled,
    postmortemEnabled,
    triageEnabled,
    triageAiEnabled,
    registrationEnabled
  };
}

function decodePathId(value, label = 'id') {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(`Некорректный ${label}`, 400);
  }
}

function userView(row) {
  return {
    id: row.id,
    name: row.name,
    login: row.login,
    role: row.role,
    createdAt: row.createdAt,
    sessionCount: row.sessionCount,
    lastSessionAt: row.lastSessionAt === null || row.lastSessionAt === undefined ? null : row.lastSessionAt
  };
}

function adminAudit(user, action, targetType, targetId, details = {}) {
  store.recordAudit({ user, action, targetType, targetId, details });
}

async function mockReachable() {
  try {
    const response = await fetch(`${itsm.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function handleApi(req, res, pathname, search = '') {
  if (req.method === 'GET' && pathname === '/api/v1/health') {
    sendJson(res, 200, {
      status: 'ok',
      version: APP_VERSION,
      uptimeMs: Math.round(process.uptime() * 1000)
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v1/ready') {
    const sync = store.getSyncState();
    try {
      store.db.prepare('SELECT 1 AS ok').get();
      sendJson(res, 200, {
        status: 'ok',
        version: APP_VERSION,
        db: 'ok',
        sync,
        uptimeMs: Math.round(process.uptime() * 1000)
      });
    } catch (error) {
      sendJson(res, 503, {
        status: 'error',
        version: APP_VERSION,
        db: 'unavailable',
        error: error.message
      });
    }
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/auth/register') {
    if (!registrationEnabled) {
      throw new HttpError('Самостоятельная регистрация отключена', 403, 'registration_disabled');
    }
    const body = await readJson(req);
    if (registrationToken && String(body.registrationToken || '') !== registrationToken) {
      throw new HttpError('Неверный код регистрации', 403, 'invalid_registration_token');
    }
    checkRegisterRateLimit(req, Date.now());
    const session = await auth.register(body);
    sendJson(res, 201, { user: session.user }, { 'Set-Cookie': auth.sessionCookie(session.token) });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/auth/login') {
    const body = await readJson(req);
    const now = Date.now();
    const throttleKey = loginThrottleKey(req, body);
    checkLoginRateLimit(throttleKey, now);
    let session;
    try {
      session = await auth.login(body);
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) recordLoginFailure(throttleKey, now);
      throw error;
    }
    loginFailures.delete(throttleKey);
    sendJson(res, 200, { user: session.user }, { 'Set-Cookie': auth.sessionCookie(session.token) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/auth/config') {
    sendJson(res, 200, {
      registrationEnabled,
      registrationTokenRequired: Boolean(registrationToken)
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/wallboard') {
    sendJson(res, 200, wallboardPayload());
    return;
  }

  const session = requireUser(req);

  if (req.method === 'GET' && pathname === '/api/v1/auth/me') {
    sendJson(res, 200, { user: session.user });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/auth/logout') {
    auth.logout(session.token);
    if (session.token) closeEventClients(client => client.tokenHash === sessionTokenHash(session.token));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v1/coordinators') {
    sendJson(res, 200, { coordinators: store.listCoordinators() });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v1/meta') {
    sendJson(res, 200, metaPayload());
    return;
  }

  if (pathname === '/api/v1/admin/users' && req.method === 'GET') {
    requireAdmin(session.user);
    sendJson(res, 200, { users: store.listUsersWithSessions().map(userView) });
    return;
  }

  const adminUserMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)(\/role|\/logout)?$/);
  if (adminUserMatch) {
    requireAdmin(session.user);
    const userId = decodePathId(adminUserMatch[1], 'userId');
    const suffix = adminUserMatch[2] || '';
    if (suffix === '' && req.method === 'DELETE') {
      const result = await enqueue(async () => {
        const target = store.getUserById(userId);
        if (!target) throw new HttpError('Пользователь не найден', 404);
        if (target.id === session.user.id) {
          throw new HttpError('Нельзя удалить собственную учётную запись', 409);
        }
        if (target.role === 'admin' && store.countAdmins() <= 1) {
          throw new HttpError('Нельзя удалить последнего администратора', 409);
        }
        const deleted = store.deleteUser(userId);
        closeEventClients(client => client.userId === String(userId));
        adminAudit(session.user, 'user.delete', 'user', userId, { login: deleted.login, role: deleted.role });
        return {
          ok: true,
          deletedUser: { id: deleted.id, name: deleted.name, login: deleted.login, role: deleted.role }
        };
      });
      sendJson(res, 200, result);
      return;
    }
    if (suffix === '/role' && req.method === 'PATCH') {
      const body = await readObject(req);
      if (body.role !== 'admin' && body.role !== 'coordinator') {
        throw new HttpError('role должен быть admin или coordinator', 400);
      }
      const result = await enqueue(async () => {
        const target = store.getUserById(userId);
        if (!target) throw new HttpError('Пользователь не найден', 404);
        if (target.role === body.role) {
          return { user: { id: target.id, name: target.name, login: target.login, role: target.role } };
        }
        if (target.role === 'admin' && body.role === 'coordinator' && store.countAdmins() <= 1) {
          throw new HttpError('Нельзя лишить прав последнего администратора', 409);
        }
        const updated = store.setUserRole(userId, body.role);
        adminAudit(session.user, 'user.role', 'user', userId, { from: target.role, to: updated.role });
        return { user: { id: updated.id, name: updated.name, login: updated.login, role: updated.role } };
      });
      sendJson(res, 200, result);
      return;
    }
    if (suffix === '/logout' && req.method === 'POST') {
      const result = await enqueue(async () => {
        const target = store.getUserById(userId);
        if (!target) throw new HttpError('Пользователь не найден', 404);
        const removedSessions = store.deleteUserSessions(userId);
        closeEventClients(client => client.userId === String(userId));
        adminAudit(session.user, 'user.logout', 'user', userId, { removedSessions });
        return { ok: true, removedSessions };
      });
      sendJson(res, 200, result);
      return;
    }
  }

  if (pathname === '/api/v1/admin/system' && req.method === 'GET') {
    requireAdmin(session.user);
    const data = dashboard();
    sendJson(res, 200, {
      revision: store.getCurrentRevision(),
      lastSyncedAt: data.lastSyncedAt,
      syncError: data.syncError,
      counts: data.counts,
      users: store.countUsers(),
      sessions: store.countSessions(Date.now()),
      uptimeMs: Math.round(process.uptime() * 1000),
      mockReachable: await mockReachable()
    });
    return;
  }

  if (pathname === '/api/v1/admin/demo/reset' && req.method === 'POST') {
    requireAdmin(session.user);
    sendJson(res, 200, await enqueue(async () => {
      try {
        store.backup('demo-reset');
      } catch (error) {
        console.error('Не удалось создать backup перед сбросом демо', error);
      }
      await itsm.demoReset();
      store.resetSyncState();
      await synchronize('reset');
      adminAudit(session.user, 'demo.reset', 'demo', null, {});
      return { ok: true, revision: 0 };
    }));
    return;
  }

  if (pathname === '/api/v1/admin/audit' && req.method === 'GET') {
    requireAdmin(session.user);
    const params = new URLSearchParams(search);
    const rawLimit = params.get('limit');
    let limit = 50;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) {
        throw new HttpError('limit должен быть целым числом от 1 до 200', 400);
      }
      limit = Number(rawLimit);
    }
    sendJson(res, 200, { audit: store.listAudit(limit) });
    return;
  }

  if (pathname === '/api/v1/admin/sync-failures' && req.method === 'GET') {
    requireAdmin(session.user);
    const params = new URLSearchParams(search);
    const rawLimit = params.get('limit');
    let limit = 50;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) {
        throw new HttpError('limit должен быть целым числом от 1 до 200', 400);
      }
      limit = Number(rawLimit);
    }
    sendJson(res, 200, { failures: store.listSyncFailures(limit) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/notifications') {
    const params = new URLSearchParams(search);
    const rawLimit = params.get('limit');
    let limit = 50;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) {
        throw new HttpError('limit должен быть целым числом от 1 до 200', 400);
      }
      limit = Number(rawLimit);
    }
    sendJson(res, 200, {
      notifications: store.listNotifications(session.user.id, limit),
      unread: store.countUnreadNotifications(session.user.id)
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/notifications/read-all') {
    store.markAllNotificationsRead(session.user.id);
    sendJson(res, 200, { ok: true, unread: store.countUnreadNotifications(session.user.id) });
    return;
  }
  const notificationReadMatch = pathname.match(/^\/api\/v1\/notifications\/(\d+)\/read$/);
  if (req.method === 'POST' && notificationReadMatch) {
    const notification = store.markNotificationRead(Number(notificationReadMatch[1]), session.user.id);
    if (!notification) throw new HttpError('Уведомление не найдено', 404);
    sendJson(res, 200, { ok: true, unread: store.countUnreadNotifications(session.user.id) });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v1/events') {
    openEvents(req, res, session.user.id, sessionTokenHash(session.token));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v1/incidents') {
    sendJson(res, 200, dashboard());
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/sync/itsm') {
    sendJson(res, 200, await enqueue(async () => {
      const changes = await synchronize('sync', demoGeneration);
      adminAudit(session.user, 'sync.manual', 'sync', null, {
        revision: changes.revision,
        added: changes.added,
        updated: changes.updated,
        rejected: Array.isArray(changes.rejected) ? changes.rejected.length : 0
      });
      return changes;
    }));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/ai/summary') {
    enforceAiRateLimit(session.user);
    sendJson(res, 200, await aiSummary(await readOptionalObject(req)));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/assistant/parse') {
    enforceAssistantRateLimit(session.user);
    sendJson(res, 200, await assistantParse(await readObject(req)));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/routing/suggest') {
    enforceRoutingRateLimit(session.user);
    sendJson(res, 200, await routingSuggest(await readObject(req)));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/postmortem') {
    enforcePostmortemRateLimit(session.user);
    sendJson(res, 200, await postmortemGenerate(await readObject(req)));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v1/triage') {
    if (!triageEnabled) throw new HttpError('Триаж отключён', 404, 'triage_disabled');
    sendJson(res, 200, triageReport());
    return;
  }
  if (req.method === 'POST' && pathname === '/api/v1/triage/scan') {
    if (!triageEnabled) throw new HttpError('Триаж отключён', 404, 'triage_disabled');
    enforceTriageRateLimit(session.user);
    await readOptionalObject(req);
    sendJson(res, 200, await triageScan());
    return;
  }

  const mergeCasesMatch = pathname.match(/^\/api\/v1\/cases\/([^/]+)\/merge$/);
  if (mergeCasesMatch) {
    if (req.method !== 'POST') throw new HttpError('Метод не поддерживается', 405);
    if (!triageEnabled) throw new HttpError('Триаж отключён', 404, 'triage_disabled');
    sendJson(res, 200, await mergeCasesRequest(
      decodeCaseId(mergeCasesMatch[1]),
      session.user,
      await readObject(req)
    ));
    return;
  }
  const correlationKeyMatch = pathname.match(/^\/api\/v1\/cases\/([^/]+)\/correlation-key$/);
  if (correlationKeyMatch) {
    if (req.method !== 'POST') throw new HttpError('Метод не поддерживается', 405);
    if (!triageEnabled) throw new HttpError('Триаж отключён', 404, 'triage_disabled');
    sendJson(res, 200, await setCorrelationKeyRequest(
      decodeCaseId(correlationKeyMatch[1]),
      session.user,
      await readObject(req)
    ));
    return;
  }

  const actionMatch = pathname.match(/^\/api\/v1\/incidents\/([^/]+)\/(claim|coordinator|priority|deadline|team|status|history)$/);
  if (actionMatch) {
    const caseId = decodeCaseId(actionMatch[1]);
    const action = actionMatch[2];
    if (action === 'history' && req.method === 'GET') {
      requiredCase(caseId);
      sendJson(res, 200, { history: store.listHistory(caseId) });
      return;
    }
    if (action === 'claim' && req.method === 'POST') {
      sendJson(res, 200, await claimCase(caseId, session.user, await readObject(req)));
      return;
    }
    if (action === 'coordinator' && req.method === 'POST') {
      sendJson(res, 200, await reassignCase(caseId, session.user, await readObject(req)));
      return;
    }
    if (action === 'priority' && req.method === 'POST') {
      sendJson(res, 200, await setPriority(caseId, session.user, await readObject(req)));
      return;
    }
    if (action === 'deadline' && req.method === 'POST') {
      sendJson(res, 200, await setDeadline(caseId, session.user, await readObject(req)));
      return;
    }
    if (action === 'team' && req.method === 'POST') {
      sendJson(res, 200, await setTeam(caseId, session.user, await readObject(req)));
      return;
    }
    if (action === 'status' && req.method === 'POST') {
      sendJson(res, 200, await setStatus(caseId, session.user, await readObject(req)));
      return;
    }
  }

  const overrideMatch = pathname.match(/^\/api\/v1\/incidents\/([^/]+)\/priority-override$/);
  if (req.method === 'DELETE' && overrideMatch) {
    sendJson(res, 200, await clearPriorityOverride(decodeCaseId(overrideMatch[1]), session.user));
    return;
  }

  throw new HttpError('API endpoint не найден', 404);
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isSafeItsmPath(pathname) {
  for (const segment of pathname.split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded === '..') return false;
  }
  return true;
}

async function proxyItsm(req, res, pathname, search) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError('Метод не поддерживается', 405);
  if (!isSafeItsmPath(pathname)) throw new HttpError('Путь запрещён', 403);

  let response;
  try {
    response = await fetch(`${itsm.baseUrl}${pathname}${search}`, {
      method: req.method,
      headers: { Accept: req.headers.accept || '*/*' },
      signal: AbortSignal.timeout(itsmTimeoutMs)
    });
  } catch {
    throw new HttpError('ITSM mock недоступен', 502);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    response.body?.cancel().catch(() => {});
    throw new HttpError('Ответ ITSM превышает допустимый размер', 502);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_JSON_BYTES) {
    throw new HttpError('Ответ ITSM превышает допустимый размер', 502);
  }

  const proxiedType = response.headers.get('content-type') || 'application/octet-stream';
  res.writeHead(response.status, {
    'Content-Type': proxiedType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(proxiedType.includes('text/html') ? HTML_SECURITY_HEADERS : {})
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(Buffer.from(body));
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError('Метод не поддерживается', 405);
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError('Некорректный путь', 400);
  }
  if (decoded.includes('\0')) throw new HttpError('Некорректный путь', 400);
  if (decoded === '/') decoded = '/index.html';
  if (decoded.split('/').some(segment => segment.startsWith('.'))) {
    throw new HttpError('Файл не найден', 404);
  }

  const root = await fs.promises.realpath(STATIC_DIR);
  const candidate = path.resolve(root, `.${decoded}`);
  if (!isInside(root, candidate)) throw new HttpError('Путь запрещён', 403);
  let realPath;
  let stat;
  try {
    realPath = await fs.promises.realpath(candidate);
    if (!isInside(root, realPath)) throw new HttpError('Путь запрещён', 403);
    stat = await fs.promises.stat(realPath);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError('Файл не найден', 404);
    throw error;
  }
  if (!stat.isFile()) throw new HttpError('Файл не найден', 404);

  const contentType = MIME_TYPES[path.extname(realPath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(contentType === MIME_TYPES['.html'] ? HTML_SECURITY_HEADERS : {})
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(realPath);
  stream.once('error', () => res.destroy());
  stream.pipe(res);
}

async function handleRequest(req, res) {
  checkOrigin(req);
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, 'http://localhost');
  } catch {
    throw new HttpError('Некорректный URL', 400);
  }
  const pathname = parsedUrl.pathname;
  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
    await handleApi(req, res, pathname, parsedUrl.search);
    return;
  }
  if (pathname === '/wall/events') {
    if (req.method !== 'GET') throw new HttpError('Метод не поддерживается', 405);
    openWallEvents(req, res);
    return;
  }
  if (pathname === '/wall' || pathname === '/wall/') {
    await serveStatic(req, res, '/wall.html');
    return;
  }
  if (pathname === '/itsm' || pathname.startsWith('/itsm/')) {
    requireUser(req);
    await proxyItsm(req, res, pathname, parsedUrl.search);
    return;
  }
  await serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => sendError(res, error));
});
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

function closeStore() {
  if (!storeClosed) {
    storeClosed = true;
    store.close();
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(pollTimer);
  clearInterval(sessionCleanupTimer);
  for (const client of eventClients) {
    clearInterval(client.heartbeat);
    client.res.end();
  }
  eventClients.clear();
  for (const client of wallEventClients) {
    clearInterval(client.heartbeat);
    client.res.end();
  }
  wallEventClients.clear();
  let forced = false;
  const forceTimer = setTimeout(() => {
    forced = true;
    server.closeAllConnections();
    try { closeStore(); } catch { /* already closed */ }
    process.exit(1);
  }, 5000);
  forceTimer.unref();
  server.close(() => {
    clearTimeout(forceTimer);
    operationTail.finally(() => {
      closeStore();
      if (!forced) process.exitCode = 0;
    });
  });
  server.closeIdleConnections();
}

async function main() {
  await enqueue(() => synchronize('startup')).catch(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log(`Incident Pulse app listening on ${server.address().port}; ITSM mock: ${itsm.baseUrl}`);
  pollTimer = setInterval(() => {
    if (shuttingDown || pendingOperations > 0) return;
    const now = Date.now();
    // Demo generation is a Live-only feature: without active SSE subscribers
    // the poll loop still synchronizes, but must not create incidents.
    if (demoGeneration && eventClients.size > 0 && now >= demoNextAt) {
      const delay = demoMinIntervalMs + Math.floor(Math.random() * (demoMaxIntervalMs - demoMinIntervalMs + 1));
      const activeCases = store.countActiveCases();
      const availableSlots = demoMaxActive - activeCases;
      // Clamp the whole batch to the remaining cap. A demo tick changes at
      // most one source record, so this cannot overshoot active-case cap.
      const batch = Math.min(
        demoBatchMin + Math.floor(Math.random() * (demoBatchMax - demoBatchMin + 1)),
        Math.max(0, availableSlots)
      );
      demoNextAt = now + delay;
      // Do not grow the demo stream past the active-case cap; keep syncing so
      // external ITSM changes and closures are still picked up.
      if (batch <= 0) {
        enqueue(() => synchronize('poll')).catch(() => {});
        return;
      }
      enqueue(async () => {
        for (let index = 0; index < batch; index += 1) {
          // The last Live client may disconnect while this batch is queued.
          if (eventClients.size === 0) break;
          const demo = await demoTickSafe();
          if (!demo) break;
        }
        return synchronize('poll');
      }).catch(() => {});
      return;
    }
    enqueue(() => synchronize('poll')).catch(() => {});
  }, pollIntervalMs);
  pollTimer.unref();
  sessionCleanupTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      store.deleteExpiredSessions(Date.now());
    } catch (error) {
      console.error('Не удалось очистить истёкшие сессии', error);
    }
  }, 60 * 60 * 1000);
  sessionCleanupTimer.unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.on('unhandledRejection', error => {
  console.error('unhandledRejection', error);
  if (!shuttingDown) shutdown();
});
process.on('uncaughtException', error => {
  console.error('uncaughtException', error);
  if (!shuttingDown) shutdown();
});
main().catch(error => {
  console.error(error);
  closeStore();
  process.exitCode = 1;
});
