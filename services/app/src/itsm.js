'use strict';

class ItsmError extends Error {
  constructor(message, status = 502, code = null) {
    super(message);
    this.name = 'ItsmError';
    this.status = status;
    this.code = code;
  }
}

function requireObject(payload, message) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ItsmError(message);
  }
  return payload;
}

function requireCounter(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ItsmError(`ITSM mock вернул некорректное поле ${field}`);
  }
  return value;
}

class ItsmClient {
  constructor(baseUrl, timeoutMs = 5000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    const options = {
      method,
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs)
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let response;
    let text;
    try {
      response = await fetch(`${this.baseUrl}${path}`, options);
      text = await response.text();
    } catch {
      throw new ItsmError('ITSM mock недоступен или превысил время ожидания');
    }

    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ItsmError('ITSM mock вернул некорректный JSON');
      }
    }
    if (!response.ok) {
      const message = payload && typeof payload.error === 'string'
        ? payload.error
        : `ITSM mock вернул HTTP ${response.status}`;
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      const code = payload && typeof payload.code === 'string' ? payload.code : null;
      throw new ItsmError(message, status, code);
    }
    return payload;
  }

  async getChanges(since) {
    const payload = requireObject(
      await this.request('GET', `/itsm/incidents?since=${encodeURIComponent(since)}`),
      'ITSM mock вернул некорректный delta response'
    );
    requireCounter(payload.revision, 'revision');
    if (!Array.isArray(payload.incidents)) throw new ItsmError('ITSM mock вернул некорректный incidents delta');
    return payload;
  }

  async demoTick() {
    return this.demoCommand('/itsm/demo/tick');
  }

  async demoCritical() {
    return this.demoCommand('/itsm/demo/critical');
  }

  async demoReset() {
    const payload = requireObject(
      await this.request('POST', '/itsm/demo/reset'),
      'ITSM mock вернул некорректный demo reset response'
    );
    requireCounter(payload.revision, 'revision');
    if (!Array.isArray(payload.incidents)) throw new ItsmError('ITSM mock вернул некорректный demo reset response');
    return { revision: payload.revision, incidents: payload.incidents };
  }

  async demoCommand(path) {
    const payload = requireObject(
      await this.request('POST', path),
      'ITSM mock вернул некорректный demo response'
    );
    return {
      revision: requireCounter(payload.revision, 'revision'),
      added: requireCounter(payload.added, 'added'),
      updated: requireCounter(payload.updated, 'updated')
    };
  }

  async bulkUpdate(ids, patch) {
    const payload = requireObject(
      await this.request('POST', '/itsm/incidents/bulk-update', { ids, patch }),
      'ITSM mock вернул некорректный bulk-update response'
    );
    return {
      updated: requireCounter(payload.updated, 'updated'),
      revision: requireCounter(payload.revision, 'revision')
    };
  }
}

module.exports = { ItsmClient, ItsmError };
