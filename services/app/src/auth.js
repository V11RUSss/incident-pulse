'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'incident_pulse_session';
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DUMMY_SALT = Buffer.alloc(16);

class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    login: user.login,
    role: user.role === 'admin' ? 'admin' : 'coordinator'
  };
}

function validateCredentials(body, registration) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthError('Ожидался JSON-объект');
  }
  if (typeof body.login !== 'string' || !body.login.trim() || body.login.length > 128) {
    throw new AuthError('login обязателен и должен содержать не более 128 символов');
  }
  if (typeof body.password !== 'string' || !body.password.trim() || body.password.length > 1024) {
    throw new AuthError('password обязателен и должен содержать не более 1024 символов');
  }
  if (registration && body.password.length < 8) {
    throw new AuthError('password должен содержать не менее 8 символов');
  }
  if (registration && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200)) {
    throw new AuthError('name обязателен и должен содержать не более 200 символов');
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class Auth {
  constructor(store, options = {}) {
    this.store = store;
    this.secure = options.secure ?? process.env.COOKIE_SECURE === 'true';
    const configuredTtl = Number(options.ttlMs ?? process.env.SESSION_TTL_MS);
    this.ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0
      ? configuredTtl
      : DEFAULT_SESSION_TTL_MS;
  }

  async register(body) {
    validateCredentials(body, true);
    const login = body.login.trim();
    const loginNormalized = login.toLowerCase();
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(body.password, salt, 64);
    const user = {
      id: crypto.randomUUID(),
      name: body.name.trim(),
      login,
      loginNormalized,
      passwordHash: Buffer.from(hash).toString('base64'),
      passwordSalt: salt.toString('base64'),
      role: this.store.countUsers() === 0 ? 'admin' : 'coordinator',
      createdAt: Date.now()
    };

    try {
      this.store.createUser(user);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        throw new AuthError('Пользователь с таким login уже существует', 409);
      }
      throw error;
    }

    return this.createSession(publicUser(user));
  }

  async login(body) {
    validateCredentials(body, false);
    const user = this.store.getUserByLogin(body.login.trim().toLowerCase());
    if (!user) {
      await scrypt(body.password, DUMMY_SALT, 64);
      throw new AuthError('Неверный login или password', 401);
    }

    const expected = Buffer.from(user.password_hash, 'base64');
    const actual = Buffer.from(await scrypt(body.password, Buffer.from(user.password_salt, 'base64'), 64));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new AuthError('Неверный login или password', 401);
    }

    return this.createSession(publicUser(user));
  }

  createSession(user) {
    this.store.deleteExpiredSessions(Date.now());
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.store.createSession({
      tokenHash: tokenHash(token),
      userId: user.id,
      createdAt: Date.now(),
      expiresAt
    });
    return { user, token, expiresAt };
  }

  userForToken(token) {
    if (!token) return null;
    return this.store.getSessionUser(tokenHash(token), Date.now());
  }

  logout(token) {
    if (token) this.store.deleteSession(tokenHash(token));
  }

  sessionCookie(token) {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`
    ];
    if (this.secure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie() {
    const parts = [
      `${SESSION_COOKIE}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ];
    if (this.secure) parts.push('Secure');
    return parts.join('; ');
  }

  tokenFromRequest(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator === -1 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

module.exports = { Auth, AuthError, SESSION_COOKIE, publicUser };
