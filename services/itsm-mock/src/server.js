import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncidentStore, StoreError } from './store.js';

const BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer from 0 to 65535');
}

const store = new IncidentStore({
  dataDir: process.env.DATA_DIR ?? path.join(serviceDirectory, '.data'),
});

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendHtml(response, value) {
  const body = Buffer.from(value);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

async function readJson(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new HttpError(400, 'Content-Type must be application/json');
  }

  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT_BYTES) {
    request.resume();
    throw new HttpError(413, 'JSON body exceeds the 5 MiB limit');
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) throw new HttpError(413, 'JSON body exceeds the 5 MiB limit');
  if (size === 0) throw new HttpError(400, 'JSON body is required');

  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

function decodeId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'Invalid incident id encoding');
  }
}

function parseSince(searchParams) {
  const values = searchParams.getAll('since');
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^\d+$/.test(values[0])) {
    throw new HttpError(400, 'since must be a non-negative integer');
  }
  const since = Number(values[0]);
  if (!Number.isSafeInteger(since)) {
    throw new HttpError(400, 'since must be a non-negative safe integer');
  }
  return since;
}

function escapeHtml(value) {
  return String(value ?? '—').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function detail(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function flagLabel(value) {
  return value ? 'да' : 'нет';
}

function renderIncident(record) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(record.id)} — ITSM</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; background: #f3f5f8; color: #20242a; }
    body { margin: 0; padding: 32px; }
    main { max-width: 960px; margin: 0 auto; background: white; border: 1px solid #d8dde5; border-radius: 12px; padding: 28px; }
    h1 { margin: 8px 0 20px; font-size: 26px; }
    p { line-height: 1.55; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 28px; }
    dl div { border-top: 1px solid #e5e8ed; padding-top: 10px; }
    dt { color: #626b78; font-size: 13px; margin-bottom: 5px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .label { color: #b51f2e; font-size: 13px; font-weight: bold; text-transform: uppercase; }
    .description { background: #f7f8fa; padding: 16px; border-radius: 8px; overflow-wrap: anywhere; }
    @media (max-width: 640px) { body { padding: 12px; } main { padding: 18px; } dl { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="label">Демонстрационная карточка ITSM</div>
    <h1>${escapeHtml(record.header)}</h1>
    <p class="description">${escapeHtml(record.description)}</p>
    <dl>
      ${detail('Инцидент', record.id)}
      ${detail('Ключ корреляции', record.correlationKey)}
      ${detail('Продукт', record.productName)}
      ${detail('Сервис', record.service)}
      ${detail('Сценарий', record.scenarioName)}
      ${detail('Регион', record.region)}
      ${detail('Затронуто пользователей', record.affectedUsers)}
      ${detail('Обращения', record.reportCount)}
      ${detail('Приоритет', record.priorityId)}
      ${detail('Ручной приоритет', record.priorityOverrideId)}
      ${detail('Статус', record.stateId)}
      ${detail('Команда', record.assignedGroupName)}
      ${detail('Координатор', record.coordinatorName)}
      ${detail('ID координатора', record.coordinatorId)}
      ${detail('Зарегистрирован', record.submitDate)}
      ${detail('Дедлайн', record.deadline)}
      ${detail('Завершён', record.completionDate)}
      ${detail('Обновлён', record.updatedAt)}
      ${detail('Версия', record.version)}
      ${detail('Решение', record.solution)}
      ${detail('Требует эскалации', flagLabel(record.isNeedUp))}
      ${detail('Мастер-инцидент', flagLabel(record.isMaster))}
      ${detail('Эффект подтверждён', flagLabel(record.isEffect))}
    </dl>
  </main>
</body>
</html>`;
}

async function handle(request, response) {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && pathname === '/itsm/incidents') {
      sendJson(response, 200, store.snapshot(parseSince(url.searchParams)));
      return;
    }
    if (request.method === 'POST' && pathname === '/itsm/demo/tick') {
      request.resume();
      sendJson(response, 200, await store.tick());
      return;
    }
    if (request.method === 'POST' && pathname === '/itsm/demo/critical') {
      request.resume();
      sendJson(response, 200, await store.critical());
      return;
    }
    if (request.method === 'POST' && pathname === '/itsm/demo/reset') {
      request.resume();
      sendJson(response, 200, await store.reset());
      return;
    }
    if (request.method === 'POST' && pathname === '/itsm/incidents/bulk-update') {
      sendJson(response, 200, await store.bulkUpdate(await readJson(request)));
      return;
    }

    const viewMatch = /^\/itsm\/incidents\/([^/]+)\/view$/.exec(pathname);
    if (request.method === 'GET' && viewMatch) {
      const id = decodeId(viewMatch[1]);
      const record = store.get(id);
      if (!record) throw new HttpError(404, `Incident not found: ${id}`);
      sendHtml(response, renderIncident(record));
      return;
    }

    const incidentMatch = /^\/itsm\/incidents\/([^/]+)$/.exec(pathname);
    if (incidentMatch) {
      const id = decodeId(incidentMatch[1]);
      if (request.method === 'GET') {
        const record = store.get(id);
        if (!record) throw new HttpError(404, `Incident not found: ${id}`);
        sendJson(response, 200, record);
        return;
      }
      if (request.method === 'PATCH') {
        sendJson(response, 200, await store.patch(id, await readJson(request)));
        return;
      }
    }

    request.resume();
    throw new HttpError(404, 'Not found');
  } catch (error) {
    const known = error instanceof HttpError || error instanceof StoreError;
    const statusCode = known ? error.statusCode : 500;
    if (!known) console.error(`Request failed: ${error.message}`);
    if (!response.headersSent) {
      const payload = { error: known ? error.message : 'Internal server error' };
      if (known && typeof error.code === 'string') payload.code = error.code;
      if (known && Number.isSafeInteger(error.revision)) payload.revision = error.revision;
      sendJson(response, statusCode, payload);
    }
  }
}

try {
  await store.init();
} catch (error) {
  console.error(`itsm-mock failed to start: ${error.message}`);
  process.exit(1);
}

const server = http.createServer(handle);
server.on('clientError', (_error, socket) => {
  if (socket.writable) {
    const body = JSON.stringify({ error: 'Bad request' });
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '0.0.0.0', resolve);
});

const address = server.address();
console.log(`itsm-mock listening on port ${address.port}`);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    process.exitCode = 0;
  });
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
