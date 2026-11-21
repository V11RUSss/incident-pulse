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

const SLA_RISK_WINDOW_MS = 15 * 60 * 1000;
const ACTIVITY_LIMIT = 6;
const MOSCOW_TIME_ZONE = 'Europe/Moscow';

const PRIORITY_LABELS = Object.freeze({ 4: 'Наивысший', 3: 'Высокий', 2: 'Средний', 1: 'Низкий' });
const PRIORITY_TONES = Object.freeze({ 4: 'critical', 3: 'high', 2: 'medium', 1: 'low' });
const PRIORITY_ACTIVITY_TONES = Object.freeze({ 4: 'red', 3: 'amber', 2: 'blue', 1: 'gray' });
const STATE_LABELS = Object.freeze({ 0: 'Назначен', 2: 'Выполняется', 20: 'Исследование ситуации', 7: 'Завершен', 10: 'Закрыт' });
const STATE_TONES = Object.freeze({ 0: 'info', 2: 'progress', 20: 'research', 7: 'done', 10: 'closed' });
const CLASSIFICATION_FLAGS = Object.freeze([
  { key: 'isNeedUp', label: 'Требует эскалации', warn: true },
  { key: 'isDouble', label: 'Дубликат' },
  { key: 'isReason', label: 'Причина' },
  { key: 'isRootIncident', label: 'Корневой инцидент' },
]);

const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: MOSCOW_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const numberFormatter = new Intl.NumberFormat('ru-RU');

const ICONS = Object.freeze({
  search: '<circle cx="8.6" cy="8.6" r="4.7"/><path d="m12.2 12.2 3.6 3.6"/>',
  bell: '<path d="M5.6 8.1a4.4 4.4 0 0 1 8.8 0c0 3 .8 4 1.4 4.8H4.2c.6-.8 1.4-1.8 1.4-4.8Z"/><path d="M8.4 15.4a1.7 1.7 0 0 0 3.2 0"/>',
  help: '<circle cx="10" cy="10" r="7.2"/><path d="M7.9 7.7a2.2 2.2 0 1 1 2.9 2.1c-.6.2-.8.6-.8 1.2v.3"/><path d="M10 14.4v.2"/>',
  chevron: '<path d="m7.6 8.4 2.4 2.4 2.4-2.4"/>',
  pencil: '<path d="m4 16 .9-3.2L13 4.7a1.6 1.6 0 0 1 2.3 0l.1.1a1.6 1.6 0 0 1 0 2.2L7.2 15.1 4 16Z"/><path d="m12.1 5.9 2 2"/>',
  users: '<circle cx="7.6" cy="7.9" r="2.8"/><path d="M2.9 16c0-2.6 2.1-4.1 4.7-4.1s4.7 1.5 4.7 4.1"/><path d="M13.1 5.5a2.6 2.6 0 0 1 0 5"/><path d="M14.3 12.1c1.7.3 2.8 1.7 2.8 3.9"/>',
  user: '<circle cx="10" cy="7.4" r="3"/><path d="M4.2 16.2c0-2.8 2.4-4.4 5.8-4.4s5.8 1.6 5.8 4.4"/>',
  clock: '<circle cx="10" cy="10" r="7.2"/><path d="M10 6.2V10l2.6 1.7"/>',
  alert: '<path d="M10 3.4 17.4 16.6H2.6L10 3.4Z"/><path d="M10 8.2v3.5"/><path d="M10 14.5v.1"/>',
  link: '<path d="m8.2 11.8 3.6-3.6"/><path d="m6.9 8.8-1.3 1.3a2.9 2.9 0 0 0 4.1 4.1l1.3-1.3"/><path d="m13.1 11.2 1.3-1.3a2.9 2.9 0 0 0-4.1-4.1l-1.3 1.3"/>',
  lock: '<rect x="4.4" y="8.8" width="11.2" height="7.6" rx="1.8"/><path d="M6.9 8.8V7a3.1 3.1 0 0 1 6.2 0v1.8"/>',
  book: '<path d="M4 4.8h5.2a2 2 0 0 1 2 2v9.1a1.5 1.5 0 0 0-1.5-1.5H4V4.8Z"/><path d="M16 4.8h-2.9a2 2 0 0 0-2 2v9.1a1.5 1.5 0 0 1 1.5-1.5H16V4.8Z"/>',
  chart: '<path d="M3.7 16.3h12.6"/><rect x="5.2" y="9.2" width="2.3" height="4.8" rx=".6"/><rect x="8.9" y="5.9" width="2.3" height="8.1" rx=".6"/><rect x="12.6" y="11.2" width="2.3" height="2.8" rx=".6"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 3.3v1.9M10 14.8v1.9M3.3 10h1.9M14.8 10h1.9M5.3 5.3 6.6 6.6M13.4 13.4l1.3 1.3M14.7 5.3 13.4 6.6M6.6 13.4l-1.3 1.3"/>',
  list: '<path d="M6.6 6.6h9M6.6 10h9M6.6 13.4h9"/><circle cx="4" cy="6.6" r=".9"/><circle cx="4" cy="10" r=".9"/><circle cx="4" cy="13.4" r=".9"/>',
  check: '<path d="m4.5 10.4 3.7 3.7 7.3-8.2"/>',
  grid: '<rect x="3.6" y="3.6" width="5.2" height="5.2" rx="1.1"/><rect x="11.2" y="3.6" width="5.2" height="5.2" rx="1.1"/><rect x="3.6" y="11.2" width="5.2" height="5.2" rx="1.1"/><rect x="11.2" y="11.2" width="5.2" height="5.2" rx="1.1"/>',
  tag: '<path d="M4.2 4.2h5l6.6 6.6-4.9 4.9-6.7-6.6V4.2Z"/><circle cx="7.2" cy="7.2" r="1.1"/>',
  calendar: '<rect x="3.6" y="4.9" width="12.8" height="11.5" rx="1.7"/><path d="M3.6 8.5h12.8M7 3.2v3.2M13 3.2v3.2"/>',
  database: '<ellipse cx="10" cy="5.2" rx="6" ry="2.4"/><path d="M4 5.2v9.6c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5.2"/><path d="M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4"/>',
  dots: '<circle cx="4.7" cy="10" r="1.1"/><circle cx="10" cy="10" r="1.1"/><circle cx="15.3" cy="10" r="1.1"/>',
});

const INCIDENT_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  color-scheme: light;
  --bg: #eef2f7;
  --surface: #ffffff;
  --surface-soft: #f7f9fc;
  --line: #dde4ee;
  --line-soft: #e9eef5;
  --ink: #17202c;
  --ink-soft: #3d4a5c;
  --muted: #6b7889;
  --muted-soft: #8c98a8;
  --blue: #1668c1;
  --blue-dark: #0e4f9b;
  --blue-soft: #e9f2fc;
  --red: #c62b1f;
  --red-soft: #fdecea;
  --amber: #a46000;
  --amber-soft: #fff3df;
  --green: #1c7a4b;
  --green-soft: #e6f5ec;
  --violet: #5b41b4;
  --violet-soft: #f0ecfd;
  --slate: #4b5a6d;
  --slate-soft: #edf1f6;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(23, 32, 44, 0.06), 0 1px 8px rgba(23, 32, 44, 0.04);
  font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13.5px;
  line-height: 1.45;
}
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }
a { color: var(--blue-dark); }
.mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 0.92em; letter-spacing: -0.01em; }
.empty { color: var(--muted-soft); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.ico { width: 16px; height: 16px; flex: none; }
.topbar { position: sticky; top: 0; z-index: 20; background: var(--surface); border-bottom: 1px solid var(--line); box-shadow: 0 1px 3px rgba(23, 32, 44, 0.05); }
.topbar::before { content: ""; display: block; height: 3px; background: linear-gradient(90deg, #0f5cad, #2f8ae8 45%, #7fc4ff); }
.topbar__inner { display: flex; align-items: center; gap: 18px; padding: 0 20px; height: 58px; }
.topbar__brand { display: flex; align-items: center; gap: 10px; min-width: 212px; }
.logo-mark { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; background: linear-gradient(140deg, #2f8ae8, #0f5cad); color: #ffffff; font-weight: 700; font-size: 17px; letter-spacing: -0.04em; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28); }
.logo-text { display: flex; flex-direction: column; line-height: 1.15; }
.logo-text strong { font-size: 15.5px; letter-spacing: -0.02em; }
.logo-text span { color: var(--muted-soft); font-size: 10.5px; letter-spacing: 0.03em; text-transform: uppercase; }
.env-pill { display: inline-flex; align-items: center; gap: 5px; margin-left: 4px; padding: 2px 8px; border-radius: 999px; background: var(--amber-soft); color: var(--amber); border: 1px solid #f2ddb9; font-size: 11px; font-weight: 700; }
.env-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.topbar__search { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); color: var(--muted-soft); max-width: 560px; }
.search-input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 13px; color: var(--ink-soft); outline: none; cursor: default; }
.search-input::placeholder { color: var(--muted-soft); }
.topbar__actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.icon-btn { position: relative; width: 32px; height: 32px; display: inline-grid; place-items: center; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; }
.icon-btn:hover { background: var(--surface-soft); border-color: var(--line); color: var(--ink-soft); }
.icon-btn__dot { position: absolute; top: 6px; right: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 2px #ffffff; }
.topbar__divider { width: 1px; height: 24px; background: var(--line); }
.topbar__user { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 8px; }
.user-text { display: flex; flex-direction: column; line-height: 1.15; }
.user-text strong { font-size: 13px; }
.user-text span { color: var(--muted-soft); font-size: 11px; }
.user-chevron { display: inline-flex; color: var(--muted-soft); }
.avatar { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: var(--blue-soft); color: var(--blue-dark); border: 1px solid #cfe3f9; font-size: 11.5px; font-weight: 700; flex: none; }
.avatar .ico { width: 15px; height: 15px; }
.avatar--empty { background: var(--surface-soft); color: var(--muted-soft); border-style: dashed; }
.shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); align-items: start; }
.sidenav { position: sticky; top: 62px; height: calc(100vh - 62px); overflow-y: auto; background: var(--surface); border-right: 1px solid var(--line); padding: 14px 10px 18px; }
.nav-group { margin: 14px 10px 6px; color: var(--muted-soft); font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
.nav-group:first-child { margin-top: 4px; }
.nav-item { display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 7px; color: var(--ink-soft); font-size: 13px; line-height: 1.2; }
.nav-item .ico { color: var(--muted); }
.nav-item.is-active { background: var(--blue-soft); color: var(--blue-dark); font-weight: 600; box-shadow: inset 2px 0 0 var(--blue); }
.nav-item.is-active .ico { color: var(--blue); }
.sidenav__foot { margin: 18px 10px 0; padding-top: 12px; border-top: 1px solid var(--line-soft); color: var(--muted-soft); font-size: 11px; line-height: 1.5; }
.workspace { min-width: 0; padding: 16px 20px 34px; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; color: var(--muted); font-size: 12px; }
.crumbs__item { min-width: 0; overflow-wrap: anywhere; }
.crumbs__item--current { color: var(--ink-soft); font-weight: 600; }
.crumbs__sep { color: #b7c2d0; }
.record-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: start; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 16px 18px; }
.record-head__main { min-width: 0; }
.record-kicker { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: 0; color: var(--blue-dark); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.record-kicker .mono { padding: 1px 6px; border-radius: 5px; background: var(--blue-soft); color: var(--blue-dark); font-size: 11.5px; letter-spacing: 0; text-transform: none; }
h1 { margin: 7px 0 0; font-size: 21px; line-height: 1.3; letter-spacing: -0.015em; overflow-wrap: anywhere; }
.badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; font-size: 11.8px; font-weight: 600; line-height: 1.35; white-space: nowrap; }
.badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.badge .ico { width: 13px; height: 13px; }
.badge-mark { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; border: 1px dashed #c6d4e5; color: var(--muted); font-size: 11px; font-weight: 600; }
.record-lead { margin: 11px 0 0; max-width: 82ch; color: var(--ink-soft); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.record-lead--empty { color: var(--muted-soft); font-style: italic; }
.record-head__aside { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.readonly-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; background: var(--surface-soft); border: 1px solid var(--line); color: var(--muted); font-size: 11.5px; font-weight: 600; }
.record-actions { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
.record-head__note { margin: 0; color: var(--muted-soft); font-size: 10.8px; text-align: right; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--ink-soft); font: inherit; font-size: 12.8px; font-weight: 600; cursor: pointer; }
.btn:hover { border-color: #c3d2e4; background: #f8fbff; }
.btn:focus-visible { outline: 2px solid #8fc0f2; outline-offset: 1px; }
.btn--primary { border-color: #0f56a5; background: linear-gradient(180deg, #1d75cf, #115cb0); color: #ffffff; box-shadow: 0 1px 2px rgba(16, 84, 160, 0.28); }
.btn--primary:hover { background: linear-gradient(180deg, #2179d3, #0f57a8); }
.btn--icon { width: 32px; padding: 0; justify-content: center; }
.tabs { display: flex; align-items: center; gap: 2px; margin: 14px 0; border-bottom: 1px solid var(--line); }
.tab { padding: 8px 13px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--muted); font-size: 12.8px; font-weight: 600; }
.tab.is-active { color: var(--blue-dark); border-bottom-color: var(--blue); }
.tabs__note { margin-left: auto; padding-bottom: 8px; color: var(--muted-soft); font-size: 11px; }
.content { display: grid; grid-template-columns: minmax(0, 1fr) 336px; gap: 16px; align-items: start; }
.content__main { display: grid; gap: 14px; min-width: 0; }
.content__rail { display: grid; gap: 14px; min-width: 0; }
.card { min-width: 0; overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.card__head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line-soft); background: linear-gradient(180deg, #fdfefe, #f6f9fd); }
.card__head > .badge { margin-left: auto; }
.card__title { display: flex; align-items: center; gap: 7px; margin: 0; color: var(--ink-soft); font-size: 12px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; }
.card__title .ico { color: var(--blue); }
.card__hint { margin-left: auto; color: var(--muted-soft); font-size: 11.3px; white-space: nowrap; }
.card__body { padding: 13px 14px 15px; }
.card__divider { height: 1px; margin: 13px 0; background: var(--line-soft); }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(188px, 1fr)); gap: 13px 20px; margin: 0; }
.field { min-width: 0; }
.field dt { margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 600; }
.field dd { margin: 0; color: var(--ink); font-size: 13.2px; overflow-wrap: anywhere; }
.field--wide { grid-column: 1 / -1; }
.field-note { display: block; margin-top: 4px; color: var(--muted-soft); font-size: 11.3px; line-height: 1.4; }
.block { margin-top: 15px; padding-top: 13px; border-top: 1px solid var(--line-soft); }
.block__title { margin: 0 0 6px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.prose { margin: 0; color: var(--ink-soft); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.prose--empty { color: var(--muted-soft); font-style: italic; }
.section-note { margin: 12px 0 0; color: var(--muted-soft); font-size: 11px; }
.flags { display: flex; flex-wrap: wrap; gap: 6px; }
.flag { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); color: var(--muted); font-size: 11.8px; }
.flag b { color: var(--ink-soft); font-weight: 600; }
.flag--on { border-color: #c7e8d5; background: var(--green-soft); color: var(--green); }
.flag--on b { color: var(--green); }
.flag--warn { border-color: #f6dfba; background: var(--amber-soft); color: var(--amber); }
.flag--warn b { color: var(--amber); }
.flag--unset { border-style: dashed; background: var(--surface); }
.tone-critical { background: var(--red-soft); border-color: #f6cfc9; color: var(--red); }
.tone-high { background: #fff0e6; border-color: #f8d8bf; color: #b4530a; }
.tone-medium { background: var(--blue-soft); border-color: #cfe3f9; color: var(--blue-dark); }
.tone-low { background: var(--slate-soft); border-color: #dde5ee; color: var(--slate); }
.tone-info { background: var(--blue-soft); border-color: #cfe3f9; color: var(--blue-dark); }
.tone-progress { background: var(--amber-soft); border-color: #f6dfba; color: var(--amber); }
.tone-research { background: var(--violet-soft); border-color: #ded5fa; color: var(--violet); }
.tone-done { background: var(--green-soft); border-color: #c7e8d5; color: var(--green); }
.tone-closed { background: var(--slate-soft); border-color: #dde5ee; color: var(--slate); }
.tone-ok { background: var(--green-soft); border-color: #c7e8d5; color: var(--green); }
.tone-risk { background: var(--amber-soft); border-color: #f6dfba; color: var(--amber); }
.tone-breach { background: var(--red-soft); border-color: #f6cfc9; color: var(--red); }
.tone-neutral { background: var(--slate-soft); border-color: #dde5ee; color: var(--slate); }
.sla-hero { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
.sla-hero__value { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; overflow-wrap: anywhere; }
.sla-hero__note { margin: 0; color: var(--muted); font-size: 11.8px; }
.meter { height: 6px; border-radius: 999px; background: #edf1f7; overflow: hidden; }
.meter__fill { display: block; min-width: 4px; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #43a0ef, #1668c1); }
.meter__fill.is-ok { background: linear-gradient(90deg, #3cb371, #1c7a4b); }
.meter__fill.is-risk { background: linear-gradient(90deg, #efb64a, #c07c00); }
.meter__fill.is-breach { background: linear-gradient(90deg, #e0554a, #b32419); }
.meter__fill.is-neutral { background: #c9d3e0; }
.rail-rows { margin: 12px 0 0; }
.rail-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px dashed var(--line-soft); font-size: 12.2px; }
.rail-row:last-child { padding-bottom: 0; border-bottom: 0; }
.rail-row dt { flex: none; color: var(--muted); }
.rail-row dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.rail-row .badge { font-size: 11.3px; }
.timeline { position: relative; margin: 0; padding: 0; list-style: none; }
.timeline::before { content: ""; position: absolute; left: 5px; top: 7px; bottom: 9px; width: 1px; background: var(--line); }
.timeline__item { position: relative; padding: 0 0 12px 20px; }
.timeline__item:last-child { padding-bottom: 0; }
.timeline__dot { position: absolute; left: 1px; top: 3px; width: 9px; height: 9px; border-radius: 50%; background: var(--surface); border: 2px solid currentColor; }
.timeline__item.is-blue .timeline__dot { color: var(--blue); }
.timeline__item.is-violet .timeline__dot { color: var(--violet); }
.timeline__item.is-amber .timeline__dot { color: var(--amber); }
.timeline__item.is-red .timeline__dot { color: var(--red); }
.timeline__item.is-green .timeline__dot { color: var(--green); }
.timeline__item.is-gray .timeline__dot { color: #9aa7b7; }
.timeline__title { margin: 0; color: var(--ink); font-size: 12.6px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.timeline__detail { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 2px 0 0; color: var(--muted); font-size: 11.8px; line-height: 1.4; }
.timeline__time { margin: 3px 0 0; color: var(--muted-soft); font-size: 11px; }
.party { display: flex; align-items: center; gap: 10px; }
.party + .party { margin-top: 11px; }
.party__body { min-width: 0; }
.party__name { margin: 0; font-size: 12.8px; font-weight: 600; overflow-wrap: anywhere; }
.party__role { margin: 2px 0 0; color: var(--muted); font-size: 11.3px; overflow-wrap: anywhere; }
.tile { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; background: var(--blue-soft); border: 1px solid #d7e7fa; color: var(--blue); flex: none; }
.tile--muted { background: var(--surface-soft); border-color: var(--line); color: var(--muted-soft); }
.rel__label { margin: 0 0 4px; color: var(--muted); font-size: 11px; font-weight: 600; }
.rel__value { margin: 0; font-size: 12.6px; overflow-wrap: anywhere; }
.rel__note { margin: 4px 0 0; color: var(--muted-soft); font-size: 11.2px; line-height: 1.45; }
.mini-chip { display: inline-flex; align-items: center; padding: 1px 7px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); color: var(--muted); font-size: 11.2px; font-weight: 600; }
.mini-chip.is-yes { background: var(--blue-soft); border-color: #cfe3f9; color: var(--blue-dark); }
.mini-chip.is-no { background: var(--slate-soft); border-color: #dde5ee; color: var(--muted); }
.mini-chip.is-unset { border-style: dashed; background: var(--surface); color: var(--muted-soft); }
.raw { box-shadow: none; }
.raw summary { padding: 11px 14px; color: var(--muted); font-size: 12.2px; font-weight: 600; cursor: pointer; }
.raw summary:hover { color: var(--ink-soft); }
.raw pre { margin: 0; padding: 0 14px 14px; max-height: 340px; overflow: auto; color: var(--ink-soft); font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 11.3px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 18px; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted-soft); font-size: 11.2px; }
.footer__meta { overflow-wrap: anywhere; }
@media (max-width: 1180px) {
  .content { grid-template-columns: minmax(0, 1fr); }
  .content__rail { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
}
@media (max-width: 980px) {
  .topbar__brand { min-width: 0; }
  .logo-text span { display: none; }
  .record-head { grid-template-columns: minmax(0, 1fr); }
  .record-head__aside { align-items: flex-start; }
  .record-head__note { text-align: left; }
  .record-actions { justify-content: flex-start; }
}
@media (max-width: 860px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidenav { display: none; }
  .topbar__search { max-width: none; }
  .user-text { display: none; }
  .topbar__inner { gap: 12px; padding: 0 12px; }
  .workspace { padding: 12px 12px 26px; }
}
@media (max-width: 620px) {
  .topbar__search { display: none; }
  .env-pill { display: none; }
  h1 { font-size: 18px; }
  .tabs__note { display: none; }
  .fields { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .record-head { padding: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto; }
}
`;

function icon(name) {
  return '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] ?? '') + '</svg>';
}

function parseInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? null : instant;
}

function formatDateTime(value) {
  const instant = parseInstant(value);
  return instant === null ? '—' : dateTimeFormatter.format(instant);
}

function dateTimeValue(value) {
  const instant = parseInstant(value);
  return instant === null ? '<span class="empty">—</span>' : escapeHtml(dateTimeFormatter.format(instant));
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '<span class="empty">—</span>';
  return escapeHtml(value);
}

function countValue(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? escapeHtml(numberFormatter.format(value))
    : displayValue(value);
}

function monoValue(value) {
  if (value === null || value === undefined || value === '') return '<span class="empty">—</span>';
  return '<span class="mono">' + escapeHtml(value) + '</span>';
}

function humanDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60000));
  if (totalMinutes === 0) return 'менее минуты';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? days + ' д ' + hours + ' ч' : days + ' д';
  if (hours > 0) return minutes > 0 ? hours + ' ч ' + minutes + ' мин' : hours + ' ч';
  return minutes + ' мин';
}

function pluralEvents(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return count + ' событие';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return count + ' события';
  return count + ' событий';
}

function initials(value) {
  const words = String(value ?? '').trim().split(' ').filter(Boolean).slice(0, 2);
  return words.map((word) => word.charAt(0).toUpperCase()).join('') || '—';
}

function stateLabel(stateId) {
  if (!Number.isInteger(stateId)) return 'Статус не указан';
  return STATE_LABELS[stateId] ?? 'Статус ' + stateId;
}

function priorityLabel(priorityId) {
  if (!Number.isInteger(priorityId)) return 'Приоритет не указан';
  return PRIORITY_LABELS[priorityId] ?? 'Приоритет ' + priorityId;
}

function isClosedState(stateId) {
  return stateId === 7 || stateId === 10;
}

function stateBadge(stateId) {
  const tone = Number.isInteger(stateId) ? STATE_TONES[stateId] ?? 'neutral' : 'neutral';
  return '<span class="badge tone-' + tone + '"><span class="dot" aria-hidden="true"></span>' + escapeHtml(stateLabel(stateId)) + '</span>';
}

function priorityBadge(priorityId) {
  const tone = Number.isInteger(priorityId) ? PRIORITY_TONES[priorityId] ?? 'neutral' : 'neutral';
  return '<span class="badge tone-' + tone + '"><span class="dot" aria-hidden="true"></span>' + escapeHtml(priorityLabel(priorityId)) + '</span>';
}

function slaBadge(summary) {
  return '<span class="badge tone-' + summary.tone + '"><span class="dot" aria-hidden="true"></span>' + escapeHtml(summary.badge) + '</span>';
}

function yesNoBadge(value) {
  if (value === undefined || value === null) return '<span class="mini-chip is-unset">—</span>';
  return value ? '<span class="mini-chip is-yes">да</span>' : '<span class="mini-chip is-no">нет</span>';
}

function meterProgress(startMs, deadlineMs, pointMs) {
  if (startMs === null || deadlineMs === null || pointMs === null || deadlineMs <= startMs) return 0;
  const ratio = (pointMs - startMs) / (deadlineMs - startMs);
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

function slaSummary(record, nowMs) {
  const startMs = parseInstant(record.submitDate);
  const deadlineMs = parseInstant(record.deadline);
  const completionMs = parseInstant(record.completionDate);
  if (deadlineMs === null) {
    return {
      tone: 'neutral',
      badge: 'Не задан',
      headline: '—',
      headlineNote: 'Дедлайн SLA не установлен',
      detail: 'Срок SLA не задан',
      progress: 0,
    };
  }
  if (completionMs !== null) {
    const lateness = completionMs - deadlineMs;
    const progress = meterProgress(startMs, deadlineMs, completionMs);
    if (lateness <= 0) {
      return {
        tone: 'ok',
        badge: 'Выполнен в срок',
        headline: 'Выполнен',
        headlineNote: 'Закончен с запасом ' + humanDuration(-lateness),
        detail: 'Завершён в пределах SLA · запас ' + humanDuration(-lateness),
        progress,
      };
    }
    return {
      tone: 'breach',
      badge: 'Выполнен с просрочкой',
      headline: 'Просрочка ' + humanDuration(lateness),
      headlineNote: 'Работы завершены после дедлайна',
      detail: 'Просрочка ' + humanDuration(lateness),
      progress,
    };
  }
  if (isClosedState(record.stateId)) {
    return {
      tone: 'neutral',
      badge: 'Без отметки о завершении',
      headline: '—',
      headlineNote: 'Дата завершения не зафиксирована',
      detail: 'Статус завершён, дата завершения не зафиксирована',
      progress: 0,
    };
  }
  const remaining = deadlineMs - nowMs;
  if (remaining <= 0) {
    return {
      tone: 'breach',
      badge: 'Просрочен',
      headline: humanDuration(-remaining),
      headlineNote: 'Просрочка SLA',
      detail: 'Просрочен на ' + humanDuration(-remaining),
      progress: 100,
    };
  }
  const atRisk = remaining <= SLA_RISK_WINDOW_MS;
  return {
    tone: atRisk ? 'risk' : 'ok',
    badge: atRisk ? 'Риск нарушения' : 'В норме',
    headline: humanDuration(remaining),
    headlineNote: atRisk ? 'Осталось · риск нарушения' : 'Осталось до дедлайна',
    detail: (atRisk ? 'Риск нарушения' : 'В пределах SLA') + ' · осталось ' + humanDuration(remaining),
    progress: meterProgress(startMs, deadlineMs, nowMs),
  };
}

function field(label, valueHtml, options) {
  const wide = options && options.wide ? ' field--wide' : '';
  return '<div class="field' + wide + '"><dt>' + escapeHtml(label) + '</dt><dd>' + valueHtml + '</dd></div>';
}

function card(options) {
  const headingId = options.id + '-title';
  const hint = options.hint ? '<span class="card__hint">' + escapeHtml(options.hint) + '</span>' : '';
  return '<section class="card" aria-labelledby="' + headingId + '">'
    + '<header class="card__head"><h2 class="card__title" id="' + headingId + '">' + icon(options.icon) + escapeHtml(options.title) + '</h2>' + hint + '</header>'
    + '<div class="card__body">' + options.body + '</div>'
    + '</section>';
}

function flagsHtml(record) {
  return CLASSIFICATION_FLAGS.map((flag) => {
    const value = record[flag.key];
    if (value === undefined || value === null) {
      return '<span class="flag flag--unset"><b>' + escapeHtml(flag.label) + '</b><span>—</span></span>';
    }
    const tone = value ? (flag.warn ? ' flag--warn' : ' flag--on') : '';
    return '<span class="flag' + tone + '"><b>' + escapeHtml(flag.label) + '</b><span>' + (value ? 'да' : 'нет') + '</span></span>';
  }).join('');
}

function buildActivity(record) {
  const events = [];
  const push = (timestamp, title, detail, tone) => {
    const instant = parseInstant(timestamp);
    if (instant === null) return;
    events.push({ instant, title, detail, tone });
  };
  const priority = priorityLabel(record.priorityId);
  const priorityOrigin = Number.isInteger(record.priorityOverrideId)
    ? 'Ручной приоритет переопределяет автоматический расчёт'
    : 'Рассчитан автоматически по числу затронутых пользователей';
  const state = stateLabel(record.stateId);
  push(record.submitDate, 'Инцидент зарегистрирован', [
    record.productName ?? 'Продукт не указан',
    record.service ?? 'Сервис не указан',
  ].join(' · '), 'blue');
  push(record.submitDate, 'Присвоен приоритет «' + priority + '»', priorityOrigin, PRIORITY_ACTIVITY_TONES[record.priorityId] ?? 'gray');
  if (record.assignedGroupName) {
    push(record.updatedAt, 'Назначена команда', record.assignedGroupName, 'violet');
  }
  if (record.coordinatorName) {
    push(record.updatedAt, 'Назначен координатор', record.coordinatorName, 'violet');
  }
  if (Number.isInteger(record.stateId) && record.stateId !== 0) {
    push(record.updatedAt, 'Статус изменён на «' + state + '»', null, 'amber');
  }
  if (record.isNeedUp) {
    push(record.updatedAt, 'Инцидент помечен для эскалации', 'Флаг «Требует эскалации»', 'red');
  }
  if (record.completionDate) {
    push(record.completionDate, 'Работы завершены', 'Текущий статус: «' + state + '»', 'green');
  }
  if (record.solution) {
    push(record.completionDate ?? record.updatedAt, 'Зафиксировано решение', record.solution, 'green');
  }
  if (record.updatedAt && record.updatedAt !== record.submitDate) {
    push(record.updatedAt, 'Запись обновлена', 'Версия ' + (record.version ?? '—'), 'gray');
  }
  events.sort((left, right) => right.instant - left.instant);
  return events.slice(0, ACTIVITY_LIMIT);
}

function renderActivity(events) {
  if (events.length === 0) {
    return '<p class="prose prose--empty">Событий пока нет.</p>';
  }
  return '<ol class="timeline">' + events.map((event) => {
    const detail = event.detail
      ? '<p class="timeline__detail">' + escapeHtml(event.detail) + '</p>'
      : '';
    return '<li class="timeline__item is-' + event.tone + '">'
      + '<span class="timeline__dot" aria-hidden="true"></span>'
      + '<p class="timeline__title">' + escapeHtml(event.title) + '</p>'
      + detail
      + '<p class="timeline__time"><time datetime="' + new Date(event.instant).toISOString() + '">' + escapeHtml(formatDateTime(event.instant)) + '</time> · МСК</p>'
      + '</li>';
  }).join('') + '</ol>';
}

function renderParticipants(record) {
  const coordinatorName = record.coordinatorName ?? null;
  const coordinatorId = record.coordinatorId ?? null;
  const team = record.assignedGroupName ?? null;
  const coordinatorAvatar = coordinatorName
    ? '<span class="avatar" aria-hidden="true">' + escapeHtml(initials(coordinatorName)) + '</span>'
    : '<span class="avatar avatar--empty" aria-hidden="true">' + icon('user') + '</span>';
  const coordinatorRole = coordinatorName
    ? (coordinatorId ? 'Координатор · ID ' + escapeHtml(coordinatorId) : 'Координатор')
    : 'Ожидает назначения';
  const coordinatorNameHtml = coordinatorName ? escapeHtml(coordinatorName) : 'Координатор не назначен';
  const teamNameHtml = team ? escapeHtml(team) : 'Команда не назначена';
  const teamRole = team ? 'Группа поддержки' : 'Ожидает маршрутизации';
  return '<div class="party">' + coordinatorAvatar
    + '<div class="party__body"><p class="party__name">' + coordinatorNameHtml + '</p>'
    + '<p class="party__role">' + coordinatorRole + '</p></div></div>'
    + '<div class="party"><span class="tile' + (team ? '' : ' tile--muted') + '" aria-hidden="true">' + icon('users') + '</span>'
    + '<div class="party__body"><p class="party__name">' + teamNameHtml + '</p>'
    + '<p class="party__role">' + teamRole + '</p></div></div>';
}

function renderTopbar() {
  return '<header class="topbar"><div class="topbar__inner">'
    + '<div class="topbar__brand">'
    + '<span class="logo-mark" aria-hidden="true">S</span>'
    + '<span class="logo-text"><strong>SimpleOne</strong><span>ITSM · Service Management</span></span>'
    + '<span class="env-pill"><span class="env-dot" aria-hidden="true"></span>Демо</span>'
    + '</div>'
    + '<div class="topbar__search">' + icon('search')
    + '<input class="search-input" type="search" readonly placeholder="Поиск по инцидентам, задачам и базе знаний" aria-label="Поиск по ITSM (декоративный элемент демонстрационной страницы)">'
    + '</div>'
    + '<div class="topbar__actions">'
    + '<button type="button" class="icon-btn" title="Демонстрационный режим" aria-label="Справка (декоративно)">' + icon('help') + '</button>'
    + '<button type="button" class="icon-btn" title="Демонстрационный режим" aria-label="Уведомления (декоративно)">' + icon('bell') + '<span class="icon-btn__dot" aria-hidden="true"></span></button>'
    + '<span class="topbar__divider" aria-hidden="true"></span>'
    + '<div class="topbar__user"><span class="avatar" aria-hidden="true">АК</span>'
    + '<span class="user-text"><strong>Анна Кузнецова</strong><span>Старший диспетчер</span></span>'
    + '<span class="user-chevron" aria-hidden="true">' + icon('chevron') + '</span></div>'
    + '</div></div></header>';
}

function renderSidenav() {
  return '<aside class="sidenav" aria-label="Разделы ITSM (декоративное меню)">'
    + '<nav class="sidenav__inner">'
    + '<p class="nav-group">Операции</p>'
    + '<span class="nav-item is-active">' + icon('alert') + '<span>Инциденты</span><span class="sr-only">(текущий раздел)</span></span>'
    + '<span class="nav-item">' + icon('check') + '<span>Задачи</span></span>'
    + '<span class="nav-item">' + icon('link') + '<span>Проблемы</span></span>'
    + '<span class="nav-item">' + icon('calendar') + '<span>Изменения</span></span>'
    + '<span class="nav-item">' + icon('list') + '<span>Запросы</span></span>'
    + '<p class="nav-group">Знания и аналитика</p>'
    + '<span class="nav-item">' + icon('book') + '<span>База знаний</span></span>'
    + '<span class="nav-item">' + icon('chart') + '<span>Отчёты</span></span>'
    + '<span class="nav-item">' + icon('gear') + '<span>Настройки</span></span>'
    + '<p class="sidenav__foot">SimpleOne 3.2 · демо-стенд<br>Карточка открыта в режиме только чтения</p>'
    + '</nav></aside>';
}

function renderIncident(record) {
  const nowMs = Date.now();
  const sla = slaSummary(record, nowMs);
  const events = buildActivity(record);
  const headerText = String(record.header ?? '').trim() || String(record.id ?? '') || 'Инцидент';
  const hasOverride = Number.isInteger(record.priorityOverrideId);
  const priorityOrigin = hasOverride
    ? 'Приоритет задан вручную и переопределяет автоматический расчёт.'
    : 'Рассчитан автоматически по числу затронутых пользователей.';
  const leadHtml = record.description
    ? '<p class="record-lead">' + escapeHtml(record.description) + '</p>'
    : '<p class="record-lead record-lead--empty">Описание не заполнено.</p>';
  const solutionHtml = record.solution
    ? '<p class="prose">' + escapeHtml(record.solution) + '</p>'
    : '<p class="prose prose--empty">Решение пока не зафиксировано.</p>';

  const basicFields = [
    field('Номер инцидента', monoValue(record.id)),
    field('Продукт', displayValue(record.productName)),
    field('Сервис', displayValue(record.service)),
    field('Сценарий', displayValue(record.scenarioName)),
    field('Регион', displayValue(record.region)),
    field('Затронуто пользователей', countValue(record.affectedUsers)),
    field('Обращений', countValue(record.reportCount)),
  ].join('');

  const classificationFields = [
    field('Статус', stateBadge(record.stateId)),
    field('Приоритет', priorityBadge(record.priorityId) + '<span class="field-note">' + escapeHtml(priorityOrigin) + '</span>'),
    field('Ручной приоритет', hasOverride
      ? priorityBadge(record.priorityOverrideId) + '<span class="field-note">Переопределяет автоматический приоритет.</span>'
      : '<span class="empty">—</span><span class="field-note">Не задан.</span>'),
    field('Команда', displayValue(record.assignedGroupName)),
    field('Координатор', displayValue(record.coordinatorName)),
    field('ID координатора', monoValue(record.coordinatorId)),
    field('Флаги', '<div class="flags">' + flagsHtml(record) + '</div>', { wide: true }),
  ].join('');

  const slaFields = [
    field('Зарегистрирован', dateTimeValue(record.submitDate)),
    field('Дедлайн SLA', dateTimeValue(record.deadline)),
    field('Состояние SLA', slaBadge(sla) + '<span class="field-note">' + escapeHtml(sla.detail) + '</span>'),
    field('Завершён', record.completionDate
      ? dateTimeValue(record.completionDate)
      : isClosedState(record.stateId)
        ? '<span class="empty">—</span><span class="field-note">Дата завершения не зафиксирована.</span>'
        : '<span class="empty">—</span><span class="field-note">Инцидент ещё не завершён.</span>'),
    field('Обновлён', dateTimeValue(record.updatedAt)),
  ].join('');

  const systemFields = [
    field('Ключ корреляции', monoValue(record.correlationKey)),
    field('Версия записи', displayValue(record.version)),
    field('ID записи', monoValue(record.id)),
    field('Источник данных', escapeHtml('itsm-mock · демо-стенд')),
    field('Доступ', escapeHtml('Только чтение')),
  ].join('');

  const recordHead = '<section class="record-head" aria-labelledby="record-title">'
    + '<div class="record-head__main">'
    + '<p class="record-kicker">Инцидент ' + monoValue(record.id) + '</p>'
    + '<h1 id="record-title">' + escapeHtml(headerText) + '</h1>'
    + '<div class="badges">'
    + priorityBadge(record.priorityId)
    + stateBadge(record.stateId)
    + slaBadge(sla)
    + (hasOverride ? '<span class="badge-mark">приоритет вручную</span>' : '')
    + (record.isNeedUp ? '<span class="badge tone-critical">' + icon('alert') + 'Требует эскалации</span>' : '')
    + '</div>'
    + leadHtml
    + '</div>'
    + '<div class="record-head__aside">'
    + '<span class="readonly-pill">' + icon('lock') + 'Только чтение</span>'
    + '<div class="record-actions">'
    + '<button type="button" class="btn btn--primary" title="Демонстрационный режим — действие недоступно">' + icon('pencil') + 'Редактировать</button>'
    + '<button type="button" class="btn" title="Демонстрационный режим — действие недоступно">' + icon('users') + 'Назначить</button>'
    + '<button type="button" class="btn btn--icon" title="Демонстрационный режим — действие недоступно" aria-label="Дополнительные действия (декоративно)">' + icon('dots') + '</button>'
    + '</div>'
    + '<p class="record-head__note">Демо-карточка · действия отключены</p>'
    + '</div></section>';

  const tabs = '<div class="tabs">'
    + '<span class="tab is-active">Детали</span>'
    + '<span class="tab">История</span>'
    + '<span class="tab">Связанные</span>'
    + '<span class="tabs__note">вкладки декоративные</span>'
    + '</div>';

  const mainContent = '<div class="content__main">'
    + card({
      id: 'basic',
      title: 'Основное',
      icon: 'grid',
      hint: 'атрибуты инцидента',
      body: '<dl class="fields">' + basicFields + '</dl>'
        + '<div class="block"><h3 class="block__title">Решение</h3>' + solutionHtml + '</div>',
    })
    + card({
      id: 'classification',
      title: 'Классификация',
      icon: 'tag',
      hint: 'статус, приоритет, команда',
      body: '<dl class="fields">' + classificationFields + '</dl>',
    })
    + card({
      id: 'sla-details',
      title: 'SLA',
      icon: 'clock',
      hint: 'сроки и состояние',
      body: '<dl class="fields">' + slaFields + '</dl>'
        + '<p class="section-note">Время указано в Europe/Moscow (МСК).</p>',
    })
    + card({
      id: 'system',
      title: 'Система',
      icon: 'database',
      hint: 'технические поля',
      body: '<dl class="fields">' + systemFields + '</dl>',
    })
    + '<details class="card raw"><summary>Служебные поля записи (JSON)</summary>'
    + '<pre>' + escapeHtml(JSON.stringify(record, null, 2)) + '</pre></details>'
    + '</div>';

  const slaMeterHtml = parseInstant(record.deadline) !== null && !record.completionDate && !isClosedState(record.stateId)
    ? '<div class="meter" role="progressbar" aria-label="Использование срока SLA" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + sla.progress + '" aria-valuetext="' + escapeHtml(sla.detail) + '"><span class="meter__fill is-' + sla.tone + '" style="width:' + sla.progress + '%"></span></div>'
    : '';

  const rail = '<aside class="content__rail" aria-label="Сводка по инциденту">'
    + '<section class="card" aria-labelledby="sla-rail-title">'
    + '<header class="card__head"><h2 class="card__title" id="sla-rail-title">' + icon('clock') + 'SLA</h2>' + slaBadge(sla) + '</header>'
    + '<div class="card__body">'
    + '<div class="sla-hero"><p class="sla-hero__value">' + escapeHtml(sla.headline) + '</p>'
    + '<p class="sla-hero__note">' + escapeHtml(sla.headlineNote) + '</p></div>'
    + slaMeterHtml
    + '<dl class="rail-rows">'
    + '<div class="rail-row"><dt>Дедлайн</dt><dd>' + dateTimeValue(record.deadline) + '</dd></div>'
    + '<div class="rail-row"><dt>Зарегистрирован</dt><dd>' + dateTimeValue(record.submitDate) + '</dd></div>'
    + '<div class="rail-row"><dt>Завершён</dt><dd>' + dateTimeValue(record.completionDate) + '</dd></div>'
    + '</dl>'
    + '<p class="section-note">Время в МСК</p>'
    + '</div></section>'
    + card({
      id: 'activity',
      title: 'Активность',
      icon: 'list',
      hint: pluralEvents(events.length),
      body: renderActivity(events),
    })
    + '<section class="card" aria-labelledby="relations-title">'
    + '<header class="card__head"><h2 class="card__title" id="relations-title">' + icon('users') + 'Участники и связи</h2></header>'
    + '<div class="card__body">'
    + renderParticipants(record)
    + '<div class="card__divider"></div>'
    + '<div class="rel"><p class="rel__label">Ключ корреляции</p>'
    + '<p class="rel__value">' + monoValue(record.correlationKey) + '</p>'
    + '<p class="rel__note">По этому ключу инцидент группируется с другими источниками инцидентов.</p></div>'
    + '<dl class="rail-rows">'
    + '<div class="rail-row"><dt>Мастер-инцидент</dt><dd>' + yesNoBadge(record.isMaster) + '</dd></div>'
    + '<div class="rail-row"><dt>Эффект подтверждён</dt><dd>' + yesNoBadge(record.isEffect) + '</dd></div>'
    + '</dl>'
    + '</div></section>'
    + '</aside>';

  return '<!doctype html>\n<html lang="ru">\n<head>\n'
    + '  <meta charset="utf-8">\n'
    + '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '  <meta name="robots" content="noindex">\n'
    + '  <meta name="color-scheme" content="light">\n'
    + '  <title>' + escapeHtml(record.id) + ' · ' + escapeHtml(headerText) + ' — SimpleOne ITSM</title>\n'
    + '  <style>' + INCIDENT_STYLES + '</style>\n'
    + '</head>\n<body>\n'
    + renderTopbar()
    + '<div class="shell">' + renderSidenav()
    + '<main class="workspace">'
    + '<nav class="crumbs" aria-label="Навигационная цепочка">'
    + '<span class="crumbs__item">SimpleOne</span>'
    + '<span class="crumbs__sep" aria-hidden="true">/</span>'
    + '<span class="crumbs__item">Операции</span>'
    + '<span class="crumbs__sep" aria-hidden="true">/</span>'
    + '<span class="crumbs__item">Инциденты</span>'
    + '<span class="crumbs__sep" aria-hidden="true">/</span>'
    + '<span class="crumbs__item crumbs__item--current" aria-current="page">' + escapeHtml(record.id) + '</span>'
    + '</nav>'
    + recordHead
    + tabs
    + '<div class="content">' + mainContent + rail + '</div>'
    + '<footer class="footer">'
    + '<span>Демонстрационная карточка ITSM · SimpleOne mock · только чтение</span>'
    + '<span class="footer__meta">' + escapeHtml(record.id) + ' · версия ' + escapeHtml(record.version ?? '—') + ' · обновлено ' + escapeHtml(formatDateTime(record.updatedAt)) + ' МСК</span>'
    + '</footer>'
    + '</main></div>'
    + '</body>\n</html>';
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
