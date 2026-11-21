'use strict';

const MINUTE = 60_000;
const SLA_RISK_WINDOW_MS = 15 * MINUTE;
const THEME_KEY = 'incident-pulse-theme';
const LIVE_KEY = 'incident-pulse-live';
const TZ = 'Europe/Moscow';

const FALLBACK_META = Object.freeze({
  priorities: { 4: 'critical', 3: 'high', 2: 'medium', 1: 'low' },
  priorityLabels: { 4: 'Наивысший', 3: 'Высокий', 2: 'Средний', 1: 'Низкий' },
  states: { 0: 'Назначен', 2: 'Выполняется', 20: 'Исследование ситуации', 7: 'Завершен', 10: 'Закрыт' },
  transitions: { 0: [2, 20, 7, 10], 2: [20, 7, 10], 20: [7, 10], 7: [10], 10: [] },
  assistantEnabled: true,
  routingEnabled: true,
  postmortemEnabled: true,
  triageEnabled: true,
  triageAiEnabled: true,
  teams: [
    'КЦ ИТ Координаторы Массовых Инцидентов',
    'МТС ИТ Поддержка Mobile voice',
    'МТС ИТ Поддержка МТС ID',
    'МТС ИТ Поддержка МТС Банка',
    'МТС ИТ Поддержка SMS',
    'МТС ИТ Поддержка KION',
    'МТС ИТ Поддержка МТС Cloud',
    'Платформа идентификации',
    'Эксплуатация сети / Регион',
    'Digital-каналы',
    'Расчёты и биллинг',
    'Cloud Platform / API Gateway'
  ]
});

const ACTION_LABELS = Object.freeze({
  claim: 'Взятие в координацию',
  reassign: 'Передача координатору',
  priority: 'Изменение приоритета',
  'priority-override.delete': 'Возврат к автоприоритету',
  deadline: 'Изменение срока SLA',
  team: 'Назначение команды',
  status: 'Изменение статуса'
});

const ADMIN_ACTION_LABELS = Object.freeze({
  'user.delete': 'Удаление пользователя',
  'user.role': 'Изменение роли',
  'user.logout': 'Завершение сессий',
  'demo.tick': 'Шаг демо',
  'demo.critical': 'Критический инцидент',
  'demo.reset': 'Сброс демо',
  'sync.manual': 'Ручная синхронизация'
});

const groupKeys = ['critical', 'coordination', 'high', 'research'];

const relativeTime = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
const numberFormat = new Intl.NumberFormat('ru');
const dateTime = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fullDateTime = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const clockFormat = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ });

const state = {
  incidents: [],
  counts: null,
  lastSyncedAt: null,
  syncError: null,
  user: null,
  coordinators: [],
  meta: null,
  filters: { search: '', product: 'all', riskOnly: false, unassigned: false, archive: false },
  productsKey: null,
  activeId: null,
  lastOpenedCaseId: null,
  dialogStateId: null,
  dialogDueAt: null,
  latestCriticalId: null,
  bannerDismissed: false,
  syncing: false,
  live: false,
  liveEnabled: readLivePreference(),
  suppressNotificationsUntil: 0,
  eventSource: null,
  toastTimer: null,
  announcementTimer: null,
  notifications: {
    items: [],
    unread: 0,
    open: false,
    loaded: false,
    loading: false
  },
  inProgress: {
    observer: null,
    inView: true
  },
  triage: {
    report: null,
    clusters: [],
    loading: false,
    scanning: false,
    autoScanned: false,
    error: null,
    aiError: null,
    open: false,
    focusCaseId: null,
    preserveAi: false,
    reportSignature: null,
    merge: null
  },
  admin: { users: [], audit: [], system: null, tab: 'users', confirmTimer: null },
  assistant: {
    open: false,
    busy: false,
    pending: null,
    caseIds: null,
    filter: null,
    count: 0,
    closed: 0,
    truncated: false,
    controller: null
  },
  routing: {
    suggestion: null,
    requestedKey: null,
    loading: false,
    controller: null,
    cache: new Map(),
    queueOpen: false,
    queueRun: 0,
    queueController: null
  },
  postmortem: {
    loading: false,
    controller: null,
    data: null,
    cache: new Map(),
    history: [],
    caseId: null,
    signature: null
  }
};

const elements = {
  search: document.querySelector('#search'),
  product: document.querySelector('#product-filter'),
  risk: document.querySelector('#risk-filter'),
  coordinator: document.querySelector('#coordinator-filter'),
  reset: document.querySelector('#reset-filters'),
  syncButton: document.querySelector('#sync-button'),
  archiveButton: document.querySelector('#archive-button'),
  dialog: document.querySelector('#incident-dialog'),
  adminDialog: document.querySelector('#admin-dialog'),
  banner: document.querySelector('#critical-banner'),
  toast: document.querySelector('#toast'),
  resultsStatus: document.querySelector('#results-status'),
  criticalAnnouncer: document.querySelector('#critical-announcer'),
  assistantButton: document.querySelector('#assistant-button'),
  assistantPanel: document.querySelector('#assistant-panel'),
  assistantClose: document.querySelector('#assistant-close'),
  assistantLog: document.querySelector('#assistant-log'),
  assistantForm: document.querySelector('#assistant-form'),
  assistantInput: document.querySelector('#assistant-input'),
  assistantSubmit: document.querySelector('#assistant-submit'),
  assistantFilter: document.querySelector('#assistant-filter'),
  assistantFilterLabel: document.querySelector('#assistant-filter-label'),
  assistantFilterClear: document.querySelector('#assistant-filter-clear'),
  routingHint: document.querySelector('#routing-hint'),
  routingHintTitle: document.querySelector('#routing-hint-title'),
  routingHintReason: document.querySelector('#routing-hint-reason'),
  routingHintSource: document.querySelector('#routing-hint-source'),
  routingAccept: document.querySelector('#routing-accept'),
  routingOther: document.querySelector('#routing-other'),
  routingStatus: document.querySelector('#routing-status'),
  routingQueueButton: document.querySelector('#routing-queue-button'),
  routingQueueCount: document.querySelector('#routing-queue-count'),
  routingPanel: document.querySelector('#routing-panel'),
  routingClose: document.querySelector('#routing-close'),
  routingList: document.querySelector('#routing-list'),
  postmortemButton: document.querySelector('#postmortem-button'),
  postmortemButtonLabel: document.querySelector('#postmortem-button-label'),
  postmortemPanel: document.querySelector('#postmortem-panel'),
  postmortemSource: document.querySelector('#postmortem-source'),
  postmortemStatus: document.querySelector('#postmortem-status'),
  postmortemContent: document.querySelector('#postmortem-content'),
  postmortemSummary: document.querySelector('#postmortem-summary'),
  postmortemTimeline: document.querySelector('#postmortem-timeline'),
  postmortemCauses: document.querySelector('#postmortem-causes'),
  postmortemImprovements: document.querySelector('#postmortem-improvements'),
  postmortemWentWellSection: document.querySelector('#postmortem-wentwell-section'),
  postmortemWentWell: document.querySelector('#postmortem-wentwell'),
  postmortemQuestionsSection: document.querySelector('#postmortem-questions-section'),
  postmortemQuestions: document.querySelector('#postmortem-questions'),
  postmortemClose: document.querySelector('#postmortem-close'),
  postmortemCopy: document.querySelector('#postmortem-copy'),
  postmortemDownload: document.querySelector('#postmortem-download'),
  notificationBell: document.querySelector('#notification-bell'),
  notificationBadge: document.querySelector('#notification-badge'),
  notificationPanel: document.querySelector('#notification-panel'),
  notificationList: document.querySelector('#notification-list'),
  notificationEmpty: document.querySelector('#notification-empty'),
  notificationReadAll: document.querySelector('#notification-read-all'),
  triageChip: document.querySelector('#triage-chip'),
  triagePanel: document.querySelector('#triage-panel'),
  triageTitle: document.querySelector('#triage-title'),
  triageClose: document.querySelector('#triage-close'),
  triageSummary: document.querySelector('#triage-summary'),
  triageScanned: document.querySelector('#triage-scanned'),
  triageSource: document.querySelector('#triage-source'),
  triageAiStatus: document.querySelector('#triage-ai-status'),
  triageGenerated: document.querySelector('#triage-generated'),
  triageTruncated: document.querySelector('#triage-truncated'),
  triageFocus: document.querySelector('#triage-focus'),
  triageFocusCase: document.querySelector('#triage-focus-case'),
  triageFocusClear: document.querySelector('#triage-focus-clear'),
  triageList: document.querySelector('#triage-list'),
  triageEmpty: document.querySelector('#triage-empty'),
  triageError: document.querySelector('#triage-error'),
  triageCasePanel: document.querySelector('#triage-case-panel'),
  triageCaseSummary: document.querySelector('#triage-case-summary'),
  triageCaseSource: document.querySelector('#triage-case-source'),
  triageCaseList: document.querySelector('#triage-case-list'),
  triageCaseEmpty: document.querySelector('#triage-case-empty'),
  triageCaseOpen: document.querySelector('#triage-case-open'),
  mergeDialog: document.querySelector('#merge-dialog'),
  mergeTitle: document.querySelector('#merge-title'),
  mergeSubtitle: document.querySelector('#merge-subtitle'),
  mergeOptions: document.querySelector('#merge-options'),
  mergeWarning: document.querySelector('#merge-warning'),
  mergeNote: document.querySelector('#merge-note'),
  mergeError: document.querySelector('#merge-error'),
  mergeConfirm: document.querySelector('#merge-confirm'),
  mergeCancel: document.querySelector('#merge-cancel'),
  mergeClose: document.querySelector('#merge-close'),
  takeWorkButton: document.querySelector('#take-work-button'),
};

/* ----------------------------------------------------------------- utils */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value ?? '';
}

function formatNumber(value) {
  return numberFormat.format(Number(value) || 0);
}

function plural(number, one, few, many) {
  const n = Math.abs(Number(number) || 0);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function findIncident(caseId) {
  return state.incidents.find(incident => incident.caseId === caseId);
}

function formatRelative(timestamp) {
  if (timestamp === null || timestamp === undefined) return '—';
  const minutes = Math.round((Date.now() - timestamp) / MINUTE);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return relativeTime.format(-minutes, 'minute');
  return dateTime.format(timestamp);
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Math.abs(milliseconds) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatUptime(milliseconds) {
  const minutes = Math.max(0, Math.floor((Number(milliseconds) || 0) / MINUTE));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} д ${hours % 24} ч`;
}

function toneClass(tone) {
  return tone === 'normal' ? '' : `is-${tone}`;
}

function meta() {
  return state.meta || FALLBACK_META;
}

function priorityLabel(priorityId) {
  return (meta().priorityLabels || {})[String(priorityId)] || FALLBACK_META.priorityLabels[String(priorityId)] || 'Приоритет';
}

function stateLabel(stateId) {
  return (meta().states || {})[String(stateId)] || FALLBACK_META.states[String(stateId)] || 'Статус';
}

function transitionsFor(stateId) {
  const transitions = (meta().transitions || {})[String(stateId)];
  return Array.isArray(transitions) ? transitions : [];
}

function teamOptions() {
  const teams = meta().teams;
  return Array.isArray(teams) && teams.length ? teams : FALLBACK_META.teams;
}

/* ----------------------------------------------------------- theme, clock */

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, { persist = true } = {}) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage may be blocked */ }
  }
  const metaTheme = document.querySelector('#theme-color');
  if (metaTheme) metaTheme.setAttribute('content', next === 'light' ? '#f2f4f8' : '#0a0d12');
  const button = document.querySelector('#theme-toggle');
  if (button) {
    const isLight = next === 'light';
    button.setAttribute('aria-pressed', String(isLight));
    button.setAttribute('aria-label', isLight ? 'Переключить на тёмную тему' : 'Переключить на светлую тему');
    const use = document.querySelector('#theme-icon');
    if (use) use.setAttribute('href', isLight ? '#i-moon' : '#i-sun');
  }
}

function toggleTheme() {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

function readLivePreference() {
  try {
    const stored = localStorage.getItem(LIVE_KEY);
    return stored === null ? true : stored !== 'off';
  } catch {
    return true;
  }
}

function persistLivePreference(enabled) {
  try { localStorage.setItem(LIVE_KEY, enabled ? 'on' : 'off'); } catch { /* storage may be blocked */ }
}

function renderClock() {
  const clock = document.querySelector('#clock');
  if (!clock) return;
  clock.textContent = `${clockFormat.format(new Date())} МСК`;
  clock.setAttribute('datetime', new Date().toISOString());
}

function renderLive() {
  const pill = document.querySelector('#live-status');
  const text = document.querySelector('#live-text');
  if (!pill || !text) return;
  const dashboardVisible = !document.querySelector('#dashboard-view').hidden;
  if (!state.user || !dashboardVisible) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  const syncButton = document.querySelector('#sync-button');
  if (syncButton) {
    syncButton.title = state.liveEnabled
      ? 'Синхронизировать с ITSM'
      : 'Live выкл: синхронизация добавит одно событие';
  }
  pill.classList.remove('is-live', 'is-stale', 'is-connecting', 'is-off');
  pill.setAttribute('aria-pressed', String(state.liveEnabled));
  if (!state.liveEnabled) {
    pill.classList.add('is-off');
    text.textContent = 'live выкл';
    pill.title = 'Автообновление выключено. Новые события — только по кнопке «Синхронизировать с ITSM».';
    pill.setAttribute('aria-label', 'Включить автообновление инцидентов');
  } else if (state.live) {
    pill.classList.add('is-live');
    text.textContent = 'live';
    pill.title = 'Автообновление включено. Нажмите, чтобы выключить.';
    pill.setAttribute('aria-label', 'Выключить автообновление инцидентов');
  } else if (state.eventSource) {
    pill.classList.add('is-stale');
    text.textContent = 'Нет связи';
    pill.title = 'Соединение с сервером потеряно, выполняется переподключение';
    pill.setAttribute('aria-label', 'Нет связи. Нажмите, чтобы выключить автообновление');
  } else {
    pill.classList.add('is-connecting');
    text.textContent = 'подключение…';
    pill.title = 'Автообновление включено. Нажмите, чтобы выключить.';
    pill.setAttribute('aria-label', 'Выключить автообновление инцидентов');
  }
}

function setLiveEnabled(enabled) {
  const next = Boolean(enabled);
  if (state.liveEnabled === next) return;
  state.liveEnabled = next;
  persistLivePreference(next);
  if (next) connectEvents();
  else closeEvents();
  renderLive();
}

function toggleLive() {
  setLiveEnabled(!state.liveEnabled);
  announce(state.liveEnabled ? 'Автообновление включено.' : 'Автообновление выключено.');
}

/* -------------------------------------------------------------------- slа */

function getSla(incident) {
  const now = Date.now();
  const closed = incident.groups.includes('closed');
  const research = incident.groups.includes('research');
  const dueAt = incident.dueAt;

  if (closed || research) {
    if (dueAt !== null && dueAt !== undefined && incident.resolvedAt && incident.resolvedAt > dueAt) {
      return { label: 'SLA нарушен', value: `+${formatCountdown(incident.resolvedAt - dueAt)}`, tone: 'overdue' };
    }
    if (research) {
      if (dueAt !== null && dueAt !== undefined && dueAt < now) {
        return { label: 'Срок истёк, идёт разбор', value: `+${formatCountdown(dueAt - now)}`, tone: 'overdue' };
      }
      return { label: 'Идёт разбор ситуации', value: dueAt ? formatCountdown(dueAt - now) : '—', tone: 'resolved' };
    }
    return { label: 'SLA соблюдён', value: 'завершён', tone: 'resolved' };
  }

  if (dueAt === null || dueAt === undefined) {
    return { label: 'Без SLA', value: '—', tone: 'none' };
  }
  const remaining = dueAt - now;
  if (remaining < 0) {
    return { label: 'SLA нарушен', value: `+${formatCountdown(remaining)}`, tone: 'overdue' };
  }
  if (remaining <= SLA_RISK_WINDOW_MS) {
    return { label: 'До нарушения SLA', value: formatCountdown(remaining), tone: 'urgent' };
  }
  return { label: 'До нарушения SLA', value: formatCountdown(remaining), tone: 'normal' };
}

function slaProgress(incident) {
  const sla = getSla(incident);
  if (sla.tone === 'resolved') return { pct: 100, tone: 'resolved' };
  if (sla.tone === 'overdue') return { pct: 100, tone: 'overdue' };
  if (sla.tone === 'none') return { pct: 0, tone: 'none' };
  const dueAt = incident.dueAt;
  const now = Date.now();
  const startedAt = incident.startedAt !== null && incident.startedAt !== undefined ? incident.startedAt : dueAt - 30 * MINUTE;
  const total = Math.max(1, dueAt - startedAt);
  const pct = Math.max(0, Math.min(100, ((dueAt - now) / total) * 100));
  return { pct, tone: sla.tone };
}

function isSlaRisk(incident) {
  return Boolean(
    incident.groups.includes('active')
    && incident.dueAt !== null
    && incident.dueAt !== undefined
    && incident.dueAt - Date.now() <= SLA_RISK_WINDOW_MS
  );
}

function itsmUrl(incident) {
  return `/itsm/incidents/${encodeURIComponent(incident.id)}/view`;
}

/* -------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body, signal } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  };
  if (signal) options.signal = signal;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const error = new Error(payload && typeof payload.error === 'string' ? payload.error : `Ошибка HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/* ------------------------------------------------------------------- auth */

function showView(name) {
  document.querySelector('#boot-view').hidden = name !== 'boot';
  document.querySelector('#auth-view').hidden = name !== 'auth';
  document.querySelector('#dashboard-view').hidden = name !== 'dashboard';
  renderLive();
  renderNotifications();
  renderTriageChip();
  syncAssistantVisibility();
  syncRoutingVisibility();
}

function setUser(user) {
  state.user = user;
  const block = document.querySelector('#coordinator');
  const adminButton = document.querySelector('#admin-button');
  const roleBadge = document.querySelector('#coordinator-role');
  if (!user) {
    block.hidden = true;
    if (adminButton) adminButton.hidden = true;
    closeNotificationPanel();
    syncAssistantVisibility();
    syncRoutingVisibility();
    renderNotifications();
    return;
  }
  block.hidden = false;
  setText('#coordinator-display-name', user.name);
  setText('#coordinator-login', user.login);
  document.querySelector('#coordinator-avatar').textContent = (user.name || user.login || 'К').trim().charAt(0).toUpperCase() || 'К';
  const isAdmin = user.role === 'admin';
  if (roleBadge) roleBadge.hidden = !isAdmin;
  if (adminButton) adminButton.hidden = !isAdmin;
  syncAssistantVisibility();
  syncRoutingVisibility();
  renderNotifications();
}

function handleUnauthorized() {
  closeEvents();
  resetAssistantUi();
  resetRoutingUi();
  resetPostmortem({ abort: true, clearHistory: true, clearCache: true });
  resetTriage();
  setUser(null);
  state.incidents = [];
  state.counts = null;
  state.activeId = null;
  if (elements.dialog.open) elements.dialog.close();
  if (elements.adminDialog && elements.adminDialog.open) elements.adminDialog.close();
  showView('auth');
}

async function loadMeta() {
  try {
    const data = await api('/api/v1/meta');
    if (data && data.states && data.transitions && Array.isArray(data.teams)) {
      state.meta = {
        priorities: data.priorities || FALLBACK_META.priorities,
        priorityLabels: data.priorityLabels || FALLBACK_META.priorityLabels,
        states: data.states,
        transitions: data.transitions,
        teams: data.teams.length ? data.teams : FALLBACK_META.teams,
        assistantEnabled: data.assistantEnabled !== false,
        routingEnabled: data.routingEnabled !== false,
        postmortemEnabled: data.postmortemEnabled !== false,
        triageEnabled: data.triageEnabled !== false,
        triageAiEnabled: data.triageAiEnabled !== false,
      };
    } else {
      state.meta = FALLBACK_META;
    }
  } catch {
    state.meta = FALLBACK_META;
  }
  syncAssistantVisibility();
  syncRoutingVisibility();
  updatePostmortemButton();
  renderTriageChip();
}

async function loadCoordinators() {
  try {
    const data = await api('/api/v1/coordinators');
    state.coordinators = Array.isArray(data.coordinators) ? data.coordinators : [];
  } catch (error) {
    if (error.status === 401) handleUnauthorized();
    else state.coordinators = [];
  }
}

function incidentCaseSignature() {
  return state.incidents.map(incident => String(incident.caseId)).sort().join('|');
}

function invalidateAiReportsForIncidentSet() {
  const signature = incidentCaseSignature();
  if (state.triage.report && state.triage.reportSignature !== signature) {
    state.triage.preserveAi = false;
  }
}

async function refreshIncidents({ notify = false } = {}) {
  const data = await api('/api/v1/incidents');
  const previous = state.incidents;
  state.incidents = Array.isArray(data.incidents) ? data.incidents : [];
  state.counts = data.counts || null;
  state.lastSyncedAt = data.lastSyncedAt ?? null;
  invalidateAiReportsForIncidentSet();
  state.syncError = data.syncError ?? null;
  render();
  if (notify) detectChanges(previous, state.incidents);
  queueTriageRefresh();
  return data;
}

let refreshChain = Promise.resolve();
function queueRefresh(options) {
  refreshChain = refreshChain.then(() => refreshIncidents(options)).catch(error => {
    if (error && error.status === 401) {
      handleUnauthorized();
    } else if (error) {
      state.syncError = error.message;
      render();
    }
  });
  return refreshChain;
}

async function enterDashboard() {
  showView('dashboard');
  await loadMeta();
  await loadCoordinators();
  try {
    await queueRefresh({ notify: false });
  } catch (error) {
    if (error && error.status === 401) handleUnauthorized();
  }
  if (state.liveEnabled) connectEvents();
  else closeEvents();
  loadNotifications();
}

async function bootstrap() {
  try {
    const data = await api('/api/v1/auth/me');
    setUser(data.user);
    await enterDashboard();
  } catch (error) {
    setUser(null);
    showView('auth');
    if (error.status !== 401) {
      const globalError = document.querySelector('#auth-global-error');
      globalError.textContent = `Не удалось подключиться: ${error.message}`;
      globalError.hidden = false;
    }
  }
}

/* ------------------------------------------------------------------- live */

function connectEvents() {
  closeEvents();
  const source = new EventSource('/api/v1/events');
  state.eventSource = source;
  source.onopen = () => {
    state.live = true;
    renderLive();
  };
  source.onerror = () => {
    state.live = false;
    renderLive();
  };
  source.addEventListener('sync', () => {
    queueRefresh({ notify: false });
  });
  source.addEventListener('incidents', event => {
    let change = null;
    try {
      change = JSON.parse(event.data);
    } catch {
      return;
    }
    if (change && change.type === 'incidents.changed') {
      const notify = Date.now() >= state.suppressNotificationsUntil;
      queueRefresh({ notify });
    }
  });
  source.addEventListener('notification', event => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || payload.type !== 'notification.created') return;
    const notification = payload.notification;
    if (!notification || notification.id === undefined || notification.id === null) return;
    applyNotificationCreated(notification, payload.unread);
  });
}

function closeEvents() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.live = false;
}

function noteLocalChange() {
  state.suppressNotificationsUntil = Date.now() + 2000;
}

function detectChanges(previous, next) {
  const prevMap = new Map(previous.map(incident => [incident.caseId, incident]));
  let newCritical = null;
  let escalated = null;
  let newSlaRisk = null;
  const teamChanges = [];
  const coordinatorChanges = [];

  for (const incident of next) {
    const prev = prevMap.get(incident.caseId);
    if (prev) {
      if (incident.priorityId > prev.priorityId) escalated = escalated || incident;
      if ((prev.team ?? null) !== (incident.team ?? null)) teamChanges.push(incident);
      if ((prev.coordinatorId ?? null) !== (incident.coordinatorId ?? null)) coordinatorChanges.push(incident);
      if (!isSlaRisk(prev) && isSlaRisk(incident)) newSlaRisk = newSlaRisk || incident;
    } else if (incident.groups.includes('critical')) {
      newCritical = newCritical || incident;
    }
  }

  if (teamChanges.length) showToast('Команда изменена', teamChanges.map(item => item.id).join(', '));
  if (coordinatorChanges.length) showToast('Координатор изменён', coordinatorChanges.map(item => item.id).join(', '));
  if (newSlaRisk) showToast('Риск нарушения SLA', `${newSlaRisk.id} · ${newSlaRisk.title}`, true);
  if (newCritical) {
    state.latestCriticalId = newCritical.caseId;
    state.bannerDismissed = false;
    renderBanner();
    showToast('Новый критический инцидент', `${newCritical.id} · ${newCritical.product}`, true);
    announce(`Новый критический инцидент ${newCritical.id}. ${newCritical.title}.`, true);
  } else if (escalated) {
    const critical = escalated.groups.includes('critical');
    showToast(critical ? 'Эскалация до критического' : 'Приоритет повышен', `${escalated.id} · ${escalated.priorityText}`, critical);
  }
}

/* ----------------------------------------------------------- notifications */

function notificationUnread(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return fallback;
}

function notificationTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function notificationTime(value) {
  const timestamp = notificationTimestamp(value);
  return timestamp === null ? '' : formatRelative(timestamp);
}

function renderNotificationList() {
  const list = elements.notificationList;
  if (!list) return;
  list.replaceChildren();
  for (const notification of state.notifications.items) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'notification-item' + (notification.readAt ? '' : ' is-unread');
    button.dataset.notificationId = String(notification.id);
    const title = document.createElement('strong');
    title.textContent = notification.title || 'Уведомление';
    button.append(title);
    if (notification.message) {
      const message = document.createElement('span');
      message.textContent = notification.message;
      button.append(message);
    }
    const time = document.createElement('time');
    time.textContent = notificationTime(notification.createdAt);
    const createdAt = notificationTimestamp(notification.createdAt);
    if (createdAt !== null) time.dateTime = new Date(createdAt).toISOString();
    button.append(time);
    item.append(button);
    list.append(item);
  }
  if (elements.notificationEmpty) elements.notificationEmpty.hidden = state.notifications.items.length > 0;
}

function renderNotifications() {
  const bell = elements.notificationBell;
  if (!bell) return;
  const dashboardVisible = !document.querySelector('#dashboard-view').hidden;
  const visible = Boolean(state.user) && dashboardVisible;
  bell.hidden = !visible;
  if (!visible && state.notifications.open) closeNotificationPanel();
  const unread = notificationUnread(state.notifications.unread, 0);
  if (elements.notificationBadge) {
    elements.notificationBadge.hidden = unread === 0;
    elements.notificationBadge.textContent = unread > 99 ? '99+' : String(unread);
  }
  bell.setAttribute('aria-label', unread ? `Уведомления: ${unread} новых` : 'Уведомления');
  if (elements.notificationReadAll) elements.notificationReadAll.disabled = unread === 0;
  renderNotificationList();
}

function openNotificationPanel() {
  if (!elements.notificationPanel || !elements.notificationBell || elements.notificationBell.hidden) return;
  if (state.triage.open) closeTriagePanel({ restoreFocus: false });
  state.notifications.open = true;
  elements.notificationPanel.hidden = false;
  elements.notificationBell.setAttribute('aria-expanded', 'true');
  if (!state.notifications.loaded) loadNotifications();
}

function closeNotificationPanel() {
  state.notifications.open = false;
  if (elements.notificationPanel) elements.notificationPanel.hidden = true;
  if (elements.notificationBell) elements.notificationBell.setAttribute('aria-expanded', 'false');
}

function toggleNotificationPanel() {
  if (state.notifications.open) closeNotificationPanel();
  else openNotificationPanel();
}

async function loadNotifications() {
  if (!state.user || state.notifications.loading) return;
  state.notifications.loading = true;
  try {
    const data = await api('/api/v1/notifications');
    const items = Array.isArray(data.notifications) ? data.notifications : [];
    state.notifications.items = items;
    state.notifications.unread = notificationUnread(
      data.unread,
      items.filter(notification => !notification.readAt).length
    );
    state.notifications.loaded = true;
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    // The notifications backend is optional: keep an empty, working bell on failure.
  } finally {
    state.notifications.loading = false;
  }
  renderNotifications();
}

function applyNotificationCreated(notification, unread) {
  const items = state.notifications.items;
  const exists = items.some(item => String(item.id) === String(notification.id));
  if (!exists) items.unshift(notification);
  if (items.length > 100) items.length = 100;
  state.notifications.unread = notificationUnread(
    unread,
    notification.readAt ? state.notifications.unread : state.notifications.unread + 1
  );
  state.notifications.loaded = true;
  renderNotifications();
  showToast(notification.title || 'Новое уведомление', notification.message || 'Открыть список уведомлений', false);
}

function findIncidentForNotification(notification) {
  const keys = [notification.caseId, notification.incidentId]
    .filter(value => value !== undefined && value !== null)
    .map(String);
  if (!keys.length) return null;
  return state.incidents.find(incident => keys.includes(String(incident.caseId)) || keys.includes(String(incident.id))) || null;
}

async function markNotificationRead(notification) {
  let unread = state.notifications.unread;
  try {
    const data = await api(`/api/v1/notifications/${encodeURIComponent(String(notification.id))}/read`, { method: 'POST' });
    unread = notificationUnread(data && data.unread, Math.max(0, state.notifications.unread - 1));
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    unread = Math.max(0, state.notifications.unread - 1);
  }
  notification.readAt = notification.readAt || Date.now();
  state.notifications.unread = unread;
  renderNotifications();
}

async function markAllNotificationsRead() {
  try {
    await api('/api/v1/notifications/read-all', { method: 'POST' });
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    showToast('Не удалось отметить уведомления', error.message, false);
    return;
  }
  const readAt = Date.now();
  for (const notification of state.notifications.items) {
    if (!notification.readAt) notification.readAt = readAt;
  }
  state.notifications.unread = 0;
  renderNotifications();
}

function resetNotifications() {
  closeNotificationPanel();
  state.notifications.items = [];
  state.notifications.unread = 0;
  state.notifications.loaded = false;
  state.notifications.loading = false;
  renderNotifications();
}

function onNotificationClick(event) {
  const button = event.target.closest('[data-notification-id]');
  if (!button) return;
  const notification = state.notifications.items.find(item => String(item.id) === button.dataset.notificationId);
  if (!notification) return;
  closeNotificationPanel();
  if (!notification.readAt) markNotificationRead(notification);
  const incident = findIncidentForNotification(notification);
  if (incident) openIncident(incident.caseId);
  else if (notification.caseId || notification.incidentId) {
    showToast('Инцидент недоступен', 'Он не найден в текущем списке', false);
  }
}


/* --------------------------------------------------------------- triage */

const TRIAGE_CONFIDENCE_LABELS = Object.freeze({ high: 'Высокая', medium: 'Средняя', low: 'Низкая' });
const TRIAGE_CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });
let triageRequest = null;

function triageEnabled() {
  return meta().triageEnabled !== false;
}

function triageAiEnabled() {
  return triageEnabled() && meta().triageAiEnabled !== false;
}

function triageModalOpen() {
  return Boolean(elements.mergeDialog && elements.mergeDialog.open);
}

function triageNum(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function triageText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function triageConfidence(value) {
  const raw = String(value === null || value === undefined ? '' : value).toLowerCase();
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return '';
}

function triageConfidenceLabel(value) {
  return TRIAGE_CONFIDENCE_LABELS[value] || '';
}

function triageConfidenceRank(value) {
  return TRIAGE_CONFIDENCE_RANK[value] || 0;
}

function triageIncidentFor(caseId) {
  if (caseId === null || caseId === undefined) return null;
  const key = String(caseId);
  return state.incidents.find(incident => String(incident.caseId) === key) || null;
}

function triageCaseInfo(caseId, extra = {}) {
  const incident = triageIncidentFor(caseId);
  const key = String(caseId);
  return {
    caseId: key,
    incidentId: incident ? incident.id : triageText(extra.incidentId),
    title: incident ? incident.title : (triageText(extra.title) || 'Кейс ' + key),
    product: incident ? incident.product : '',
    team: incident ? (incident.team || '') : '',
    startedAt: incident ? incident.startedAt : null,
    affectedUsers: incident ? triageNum(incident.affectedUsers) : 0,
    reportCount: incident ? triageNum(incident.reportCount) : 0,
    version: incident && Number.isInteger(incident.version) ? incident.version : null
  };
}

function triageMergeWeight(info) {
  return triageNum(info.affectedUsers) + triageNum(info.reportCount) * 2;
}

function triagePickTarget(cases) {
  if (!cases || !cases.length) return null;
  const sorted = cases.slice().sort((a, b) => {
    const weightDiff = triageMergeWeight(b) - triageMergeWeight(a);
    if (weightDiff) return weightDiff;
    const startA = notificationTimestamp(a.startedAt);
    const startB = notificationTimestamp(b.startedAt);
    if (startA !== null && startB !== null && startA !== startB) return startA - startB;
    return String(a.caseId).localeCompare(String(b.caseId));
  });
  return sorted[0].caseId;
}

function normalizeTriageSuggestion(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'merge') return null;
  if (!raw.sourceCaseId || !raw.targetCaseId) return null;
  if (String(raw.sourceCaseId) === String(raw.targetCaseId)) return null;
  return {
    id: triageText(raw.id) || ('merge:' + raw.targetCaseId + ':' + raw.sourceCaseId),
    sourceCaseId: String(raw.sourceCaseId),
    targetCaseId: String(raw.targetCaseId),
    confidence: triageConfidence(raw.confidence),
    rationale: triageText(raw.rationale),
    evidence: triageText(raw.evidence),
    sourceTitle: triageText(raw.sourceTitle),
    targetTitle: triageText(raw.targetTitle),
    sourceIncidentId: triageText(raw.sourceIncidentId),
    targetIncidentId: triageText(raw.targetIncidentId),
    similarity: raw.similarity === null || raw.similarity === undefined ? null : triageNum(raw.similarity)
  };
}

function triageSuggestionCaseExtra(suggestion, caseId) {
  if (String(caseId) === suggestion.sourceCaseId) return { incidentId: suggestion.sourceIncidentId, title: suggestion.sourceTitle };
  if (String(caseId) === suggestion.targetCaseId) return { incidentId: suggestion.targetIncidentId, title: suggestion.targetTitle };
  return {};
}

function buildTriageClusters(suggestions) {
  const parent = new Map();
  const find = key => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = key;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const add = key => { if (!parent.has(key)) parent.set(key, key); };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  for (const suggestion of suggestions) {
    add(suggestion.sourceCaseId);
    add(suggestion.targetCaseId);
    union(suggestion.sourceCaseId, suggestion.targetCaseId);
  }
  const groups = new Map();
  for (const suggestion of suggestions) {
    const root = find(suggestion.sourceCaseId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(suggestion);
  }
  const clusters = [];
  for (const edges of groups.values()) {
    const caseIds = [...new Set(edges.flatMap(edge => [edge.sourceCaseId, edge.targetCaseId]))];
    const cases = caseIds.map(caseId => {
      const edge = edges.find(item => item.sourceCaseId === caseId || item.targetCaseId === caseId);
      return triageCaseInfo(caseId, edge ? triageSuggestionCaseExtra(edge, caseId) : {});
    });
    const best = edges.slice().sort((a, b) => {
      const rankDiff = triageConfidenceRank(b.confidence) - triageConfidenceRank(a.confidence);
      if (rankDiff) return rankDiff;
      return (b.similarity || 0) - (a.similarity || 0);
    })[0];
    const preferredTarget = caseIds.includes(best.targetCaseId) ? best.targetCaseId : triagePickTarget(cases);
    const confidence = edges.reduce((max, edge) => Math.max(max, triageConfidenceRank(edge.confidence)), 0);
    const confidenceLabel = confidence === 3 ? 'high' : confidence === 2 ? 'medium' : 'low';
    clusters.push({
      id: 'cluster:' + caseIds.slice().sort().join('|'),
      caseIds,
      cases,
      suggestions: edges,
      preferredTarget,
      confidence: confidenceLabel
    });
  }
  clusters.sort((a, b) => {
    const rankDiff = triageConfidenceRank(b.confidence) - triageConfidenceRank(a.confidence);
    if (rankDiff) return rankDiff;
    return String(a.caseIds[0]).localeCompare(String(b.caseIds[0]), 'ru');
  });
  return clusters;
}

function applyTriageReport(raw) {
  if (!triageEnabled() || !raw || typeof raw !== 'object') return;
  if (!state.incidents.length) {
    state.triage.report = {
      suggestions: [], clusters: [], scannedCases: 0, candidatePairs: 0, truncated: false,
      source: 'rules', generatedAt: raw.generatedAt === undefined ? null : raw.generatedAt,
      aiChecked: null, aiSkipped: null, counts: { groups: 0, cases: 0 }
    };
    state.triage.clusters = [];
    state.triage.reportSignature = '';
    state.triage.preserveAi = false;
    state.triage.error = null;
    state.triage.aiError = null;
    return;
  }
  const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : [])
    .map(normalizeTriageSuggestion)
    .filter(Boolean);
  const clusters = buildTriageClusters(suggestions);
  const caseIds = new Set(clusters.flatMap(cluster => cluster.caseIds));
  state.triage.report = {
    suggestions,
    clusters,
    scannedCases: triageNum(raw.scannedCases),
    candidatePairs: triageNum(raw.candidatePairs),
    truncated: Boolean(raw.truncated),
    source: raw.source === 'rules+ai' ? 'rules+ai' : 'rules',
    generatedAt: raw.generatedAt === undefined ? null : raw.generatedAt,
    aiChecked: raw.aiChecked === undefined ? null : raw.aiChecked,
    aiSkipped: raw.aiSkipped === undefined ? null : raw.aiSkipped,
    counts: {
      groups: clusters.length,
      cases: caseIds.size
    }
  };
  state.triage.clusters = clusters;
  state.triage.reportSignature = incidentCaseSignature();
  state.triage.preserveAi = state.triage.report.source === 'rules+ai';
  state.triage.error = null;
  state.triage.aiError = null;
  const focus = state.triage.focusCaseId;
  if (focus && !clusters.some(cluster => triageClusterMatches(cluster, focus))) state.triage.focusCaseId = null;
}

function triageClusterMatches(cluster, caseId) {
  if (!cluster || caseId === null || caseId === undefined) return false;
  return cluster.caseIds.includes(String(caseId));
}

function triageScopedClusters() {
  const clusters = state.triage.clusters || [];
  const focus = state.triage.focusCaseId;
  if (!focus) return clusters;
  return clusters.filter(cluster => triageClusterMatches(cluster, focus));
}

function triageFocusCaseLabel(caseId) {
  const incident = triageIncidentFor(caseId);
  return incident ? incident.id : String(caseId);
}

function triageSourceLabel(report) {
  return report && report.source === 'rules+ai' ? 'Правила + ИИ' : 'Правила';
}

function renderTriageChip() {
  const chip = elements.triageChip;
  if (!chip) return;
  const report = triageEnabled() ? state.triage.report : null;
  const visible = Boolean(report && report.counts && report.counts.groups > 0);
  chip.hidden = !visible;
  if (!visible) {
    if (state.triage.open) closeTriagePanel({ restoreFocus: false });
    return;
  }
  const groups = report.counts.groups;
  setText('#triage-chip-count', groups);
  chip.classList.toggle('triage-chip--active', groups > 0);
  chip.title = 'Дубли: ' + groups + ' ' + plural(groups, 'группа', 'группы', 'групп') + '. Открыть панель дублей.';
  chip.setAttribute('aria-label', chip.title);
  chip.setAttribute('aria-expanded', String(state.triage.open));
}

function triageLoadError(error) {
  const code = error && error.payload ? error.payload.code : '';
  if (code === 'triage_disabled') return 'Дубли отключены на сервере.';
  if (error.status === 429) return 'Слишком часто — попробуйте через минуту.';
  return error.message || 'Не удалось загрузить список дублей.';
}

function triageAiStatusText(report) {
  if (state.triage.scanning) return 'ИИ уточняет группы дублей…';
  if (state.triage.aiError) return 'Ошибка ИИ: ' + state.triage.aiError;
  if (!report) return '';
  if (report.aiSkipped === true) return 'ИИ-проверка недоступна: показан детерминированный список дублей.';
  if (report.source !== 'rules+ai') return '';
  const checked = report.aiChecked;
  if (checked === null || checked === undefined) return 'ИИ-проверка выполнена.';
  const count = triageNum(checked);
  return 'ИИ проверил ' + count + ' ' + plural(count, 'кейс', 'кейса', 'кейсов') + '.';
}

function triageCaseButton(caseId, extra = {}) {
  const info = triageCaseInfo(caseId, extra);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'triage-case';
  button.dataset.triageOpen = info.caseId;
  const strong = document.createElement('strong');
  strong.textContent = info.incidentId || info.caseId;
  button.append(strong);
  const title = document.createElement('span');
  title.textContent = info.title;
  button.append(title);
  if (info.team) {
    const team = document.createElement('small');
    team.textContent = info.team;
    button.append(team);
  }
  return button;
}

function triageWhyDetails(cluster) {
  const details = document.createElement('details');
  details.className = 'triage-why';
  const summary = document.createElement('summary');
  summary.textContent = 'Почему?';
  details.append(summary);
  const list = document.createElement('ul');
  list.className = 'triage-why-list';
  const seen = new Set();
  for (const suggestion of cluster.suggestions) {
    const text = suggestion.rationale || suggestion.evidence;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const item = document.createElement('li');
    item.textContent = text;
    if (suggestion.evidence && suggestion.evidence !== text) {
      const evidence = document.createElement('span');
      evidence.textContent = suggestion.evidence;
      item.append(evidence);
    }
    list.append(item);
  }
  details.append(list);
  return details;
}

function triageClusterNode(cluster) {
  const item = document.createElement('li');
  item.className = 'triage-cluster';
  item.dataset.clusterId = cluster.id;
  const head = document.createElement('div');
  head.className = 'triage-cluster-head';
  const badge = document.createElement('span');
  badge.className = 'triage-badge triage-badge--merge';
  badge.textContent = 'Дубли';
  head.append(badge);
  if (cluster.confidence) {
    const confidence = document.createElement('span');
    confidence.className = 'triage-confidence triage-confidence--' + cluster.confidence;
    confidence.textContent = triageConfidenceLabel(cluster.confidence);
    head.append(confidence);
  }
  const count = document.createElement('span');
  count.className = 'triage-cluster-count';
  count.textContent = cluster.caseIds.length + ' ' + plural(cluster.caseIds.length, 'кейс', 'кейса', 'кейсов');
  head.append(count);
  item.append(head);
  const cases = document.createElement('div');
  cases.className = 'triage-cluster-cases';
  for (const info of cluster.cases) cases.append(triageCaseButton(info.caseId, { incidentId: info.incidentId, title: info.title }));
  item.append(cases);
  const teams = [...new Set(cluster.cases.map(info => info.team).filter(Boolean))];
  if (teams.length > 1) {
    const crossTeam = document.createElement('p');
    crossTeam.className = 'triage-cross-team';
    crossTeam.textContent = 'Разные команды: ' + teams.join(', ');
    item.append(crossTeam);
  }
  const targetRow = document.createElement('label');
  targetRow.className = 'triage-target-row';
  const targetLabel = document.createElement('span');
  targetLabel.textContent = 'Целевой кейс';
  const select = document.createElement('select');
  select.className = 'triage-cluster-target';
  for (const info of cluster.cases) {
    const option = document.createElement('option');
    option.value = info.caseId;
    option.textContent = (info.incidentId || info.caseId) + ' · ' + info.title;
    option.selected = String(info.caseId) === String(cluster.preferredTarget);
    select.append(option);
  }
  targetRow.append(targetLabel, select);
  item.append(targetRow);
  item.append(triageWhyDetails(cluster));
  const actions = document.createElement('div');
  actions.className = 'triage-cluster-actions';
  const merge = document.createElement('button');
  merge.type = 'button';
  merge.className = 'button button-primary button-sm';
  merge.dataset.triageMerge = cluster.caseIds.join('|');
  merge.textContent = 'Объединить ' + cluster.caseIds.length + ' ' + plural(cluster.caseIds.length, 'кейс', 'кейса', 'кейсов');
  actions.append(merge);
  item.append(actions);
  return item;
}

function renderTriagePanel() {
  const panel = elements.triagePanel;
  if (!panel) return;
  if (!triageEnabled()) {
    if (state.triage.open) closeTriagePanel({ restoreFocus: false });
    return;
  }
  if (panel.hidden) return;
  const report = state.triage.report;
  if (elements.triageSummary) {
    if (!report) {
      elements.triageSummary.textContent = state.triage.loading ? 'Загружаем дубли…' : 'Нет данных';
    } else if (report.counts.groups) {
      elements.triageSummary.textContent = report.counts.groups + ' ' + plural(report.counts.groups, 'группа', 'группы', 'групп') + ' · ' + report.counts.cases + ' ' + plural(report.counts.cases, 'кейс', 'кейса', 'кейсов');
    } else {
      elements.triageSummary.textContent = 'Групп дублей нет';
    }
  }
  if (elements.triageScanned) {
    elements.triageScanned.textContent = report
      ? 'Проверено ' + report.scannedCases + ' ' + plural(report.scannedCases, 'кейс', 'кейса', 'кейсов') + ' · ' + report.candidatePairs + ' ' + plural(report.candidatePairs, 'пара', 'пары', 'пар')
      : '';
  }
  if (elements.triageSource) elements.triageSource.textContent = triageSourceLabel(report);
  if (elements.triageGenerated) {
    const timestamp = report ? notificationTimestamp(report.generatedAt) : null;
    elements.triageGenerated.textContent = timestamp === null ? '' : 'Обновлено ' + formatRelative(timestamp);
  }
  if (elements.triageTruncated) elements.triageTruncated.hidden = !(report && report.truncated);
  if (elements.triageAiStatus) {
    const text = triageAiStatusText(report);
    elements.triageAiStatus.hidden = !text;
    elements.triageAiStatus.textContent = text;
    elements.triageAiStatus.classList.toggle('is-error', Boolean(state.triage.aiError) && !state.triage.scanning);
  }
  if (elements.triageError) {
    const error = state.triage.loading ? '' : (state.triage.error || '');
    elements.triageError.hidden = !error;
    elements.triageError.textContent = error ? 'Не удалось загрузить дубли: ' + error : '';
  }
  const focus = state.triage.focusCaseId;
  if (elements.triageFocus) elements.triageFocus.hidden = !focus;
  if (focus && elements.triageFocusCase) elements.triageFocusCase.textContent = triageFocusCaseLabel(focus);
  const list = elements.triageList;
  if (list) {
    list.replaceChildren();
    if (report) {
      for (const cluster of triageScopedClusters()) list.append(triageClusterNode(cluster));
    }
  }
  if (elements.triageEmpty) {
    const visibleCount = list ? list.children.length : 0;
    elements.triageEmpty.hidden = !report || visibleCount > 0;
    elements.triageEmpty.textContent = report && report.counts.groups
      ? 'По выбранному кейсу дублей нет.'
      : 'Групп дублей не найдено.';
  }
}

function openTriagePanel(options = {}) {
  if (!triageEnabled() || !state.triage.report) return;
  const caseId = options && options.caseId ? String(options.caseId) : null;
  if (state.assistant.open) closeAssistant();
  if (state.routing.queueOpen) closeRoutingPanel();
  closeNotificationPanel();
  if (caseId) state.triage.focusCaseId = caseId;
  state.triage.open = true;
  if (elements.triagePanel) elements.triagePanel.hidden = false;
  if (elements.triageChip) elements.triageChip.setAttribute('aria-expanded', 'true');
  renderTriagePanel();
  if (elements.triageTitle) elements.triageTitle.focus({ preventScroll: true });
  maybeAutoScanTriage();
}

function closeTriagePanel(options = {}) {
  const wasOpen = state.triage.open;
  state.triage.open = false;
  if (elements.triagePanel) elements.triagePanel.hidden = true;
  if (elements.triageChip) elements.triageChip.setAttribute('aria-expanded', 'false');
  if (wasOpen && options.restoreFocus !== false && elements.triageChip && !elements.triageChip.hidden) {
    elements.triageChip.focus({ preventScroll: true });
  }
}

function toggleTriagePanel() {
  if (state.triage.open) closeTriagePanel();
  else openTriagePanel();
}

function maybeAutoScanTriage() {
  if (!triageAiEnabled() || state.triage.autoScanned || state.triage.scanning) return;
  if (!state.triage.report) return;
  state.triage.autoScanned = true;
  scanTriageSemantics();
}

function queueTriageRefresh() {
  if (!triageEnabled()) return Promise.resolve(null);
  if (state.triage.preserveAi && state.triage.reportSignature === incidentCaseSignature()) return Promise.resolve(state.triage.report);
  if (state.triage.preserveAi) state.triage.preserveAi = false;
  if (triageRequest) return triageRequest;
  triageRequest = (async () => {
    state.triage.loading = true;
    renderTriagePanel();
    try {
      const report = await api('/api/v1/triage');
      if (!state.user) return null;
      applyTriageReport(report);
      render();
      renderTriagePanel();
      return state.triage.report;
    } catch (error) {
      if (error.status === 401) {
        handleUnauthorized();
        return null;
      }
      state.triage.error = triageLoadError(error);
      if (error.payload && error.payload.code === 'triage_disabled') state.triage.report = null;
      renderTriagePanel();
      return null;
    } finally {
      state.triage.loading = false;
      triageRequest = null;
      renderTriageChip();
      renderTriagePanel();
    }
  })();
  return triageRequest;
}

async function scanTriageSemantics() {
  if (!triageAiEnabled() || state.triage.scanning) return;
  state.triage.scanning = true;
  state.triage.aiError = null;
  renderTriagePanel();
  try {
    const report = await api('/api/v1/triage/scan', { method: 'POST', body: {} });
    applyTriageReport(report);
    render();
    renderTriagePanel();
  } catch (error) {
    if (error.status === 401) handleUnauthorized();
    else state.triage.aiError = triageLoadError(error);
  } finally {
    state.triage.scanning = false;
    renderTriageChip();
    renderTriagePanel();
  }
}

function triageCaseClusterNode(cluster) {
  const item = document.createElement('li');
  item.className = 'triage-case-item';
  const head = document.createElement('div');
  head.className = 'triage-case-item-head';
  const badge = document.createElement('span');
  badge.className = 'triage-badge triage-badge--merge';
  badge.textContent = 'Дубли';
  head.append(badge);
  if (cluster.confidence) {
    const confidence = document.createElement('span');
    confidence.className = 'triage-confidence triage-confidence--' + cluster.confidence;
    confidence.textContent = triageConfidenceLabel(cluster.confidence);
    head.append(confidence);
  }
  item.append(head);
  const detail = document.createElement('p');
  detail.className = 'triage-case-detail';
  detail.textContent = 'Кейсы: ' + cluster.cases.map(info => info.incidentId || info.caseId).join(', ');
  item.append(detail);
  const actions = document.createElement('div');
  actions.className = 'triage-case-item-actions';
  const merge = document.createElement('button');
  merge.type = 'button';
  merge.className = 'button button-primary button-sm';
  merge.dataset.triageMerge = cluster.caseIds.join('|');
  merge.dataset.triageTarget = cluster.preferredTarget;
  merge.textContent = 'Объединить ' + cluster.caseIds.length + ' ' + plural(cluster.caseIds.length, 'кейс', 'кейса', 'кейсов');
  actions.append(merge);
  item.append(actions);
  return item;
}

function renderTriageCaseBlock(incident) {
  const panel = elements.triageCasePanel;
  if (!panel) return;
  const enabled = triageEnabled();
  const report = enabled ? state.triage.report : null;
  panel.hidden = !enabled || !report;
  if (panel.hidden) return;
  const clusters = (state.triage.clusters || []).filter(cluster => triageClusterMatches(cluster, incident.caseId));
  if (elements.triageCaseSource) elements.triageCaseSource.textContent = triageSourceLabel(report);
  if (elements.triageCaseSummary) {
    elements.triageCaseSummary.textContent = clusters.length
      ? 'Найдено групп: ' + clusters.length
      : 'Похожих кейсов не найдено';
  }
  const list = elements.triageCaseList;
  if (list) {
    list.replaceChildren();
    for (const cluster of clusters) list.append(triageCaseClusterNode(cluster));
  }
  if (elements.triageCaseEmpty) elements.triageCaseEmpty.hidden = clusters.length > 0;
}

function openTriageCase(caseId) {
  const incident = triageIncidentFor(caseId);
  if (!incident) {
    showToast('Кейс недоступен', 'Кейс не найден в текущем списке', false);
    return;
  }
  closeTriagePanel({ restoreFocus: false });
  openIncident(incident.caseId);
}

function onTriageActionClick(event) {
  const open = event.target.closest('[data-triage-open]');
  if (open) {
    openTriageCase(open.dataset.triageOpen);
    return;
  }
  const merge = event.target.closest('[data-triage-merge]');
  if (!merge) return;
  const ids = String(merge.dataset.triageMerge || '').split('|').filter(Boolean);
  const cluster = merge.closest('.triage-cluster');
  const select = cluster ? cluster.querySelector('.triage-cluster-target') : null;
  const preferredTarget = select ? select.value : (merge.dataset.triageTarget || null);
  openMergeDialog(ids, { preferredTarget });
}

/* ------------------------------------------------------- cluster merge */

function openMergeDialog(caseIds, options = {}) {
  if (!triageEnabled()) return;
  const unique = [...new Set((Array.isArray(caseIds) ? caseIds : [caseIds]).map(id => triageText(id)).filter(Boolean))];
  if (unique.length < 2) return;
  const cases = unique.map(caseId => triageCaseInfo(caseId));
  if (cases.some(info => info.version === null)) {
    showToast('Кейс не найден', 'Не удалось получить версии кейсов — обновите список', false);
    return;
  }
  const preferred = options && options.preferredTarget && unique.includes(String(options.preferredTarget))
    ? String(options.preferredTarget)
    : null;
  state.triage.merge = {
    caseIds: unique,
    targetCaseId: preferred || triagePickTarget(cases),
    busy: false,
    error: null
  };
  if (!elements.mergeDialog) return;
  renderMergeDialog();
  if (!elements.mergeDialog.open) elements.mergeDialog.showModal();
  syncMergeDialogState();
}

function renderMergeDialog() {
  const merge = state.triage.merge;
  const container = elements.mergeOptions;
  if (!merge || !container) return;
  container.replaceChildren();
  for (const caseId of merge.caseIds) {
    const info = triageCaseInfo(caseId);
    const label = document.createElement('label');
    label.className = 'merge-option';
    label.dataset.mergeCase = info.caseId;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'merge-target';
    input.value = info.caseId;
    input.checked = String(info.caseId) === String(merge.targetCaseId);
    const body = document.createElement('span');
    body.className = 'merge-option-body';
    const tag = document.createElement('span');
    tag.className = 'merge-option-tag';
    tag.textContent = input.checked ? 'Целевой' : 'Источник';
    const title = document.createElement('strong');
    title.textContent = (info.incidentId || info.caseId) + ' · ' + info.title;
    const meta = document.createElement('span');
    meta.className = 'merge-option-meta';
    const parts = [];
    if (info.team) parts.push('Команда: ' + info.team);
    if (info.startedAt) parts.push('Возникло: ' + formatRelative(info.startedAt));
    parts.push('Затронуто: ' + formatNumber(info.affectedUsers));
    meta.textContent = parts.join(' · ');
    body.append(tag, title, meta);
    label.append(input, body);
    container.append(label);
  }
  if (elements.mergeTitle) elements.mergeTitle.textContent = 'Объединение кейсов';
}

function triageMergeCases(merge) {
  if (!merge) return [];
  return merge.caseIds.map(caseId => triageCaseInfo(caseId));
}

function syncMergeDialogState() {
  const merge = state.triage.merge;
  if (!merge) return;
  const cases = triageMergeCases(merge);
  const target = triageCaseInfo(merge.targetCaseId);
  const sources = cases.filter(info => String(info.caseId) !== String(merge.targetCaseId));
  const labels = elements.mergeOptions ? [...elements.mergeOptions.querySelectorAll('.merge-option')] : [];
  for (const label of labels) {
    const isTarget = String(label.dataset.mergeCase) === String(merge.targetCaseId);
    label.classList.toggle('is-selected', isTarget);
    const tag = label.querySelector('.merge-option-tag');
    if (tag) tag.textContent = isTarget ? 'Целевой' : 'Источник';
    const input = label.querySelector('input[name="merge-target"]');
    if (input) input.checked = isTarget;
  }
  if (elements.mergeSubtitle) {
    elements.mergeSubtitle.textContent = sources.length + ' ' + plural(sources.length, 'кейс', 'кейса', 'кейсов') + ' будут объединены в «' + (target.incidentId || target.caseId) + '». Целевой кейс сохранится.';
  }
  const teams = [...new Set(cases.map(info => info.team).filter(Boolean))];
  if (elements.mergeWarning) {
    const crossTeam = teams.length > 1;
    elements.mergeWarning.hidden = !crossTeam;
    elements.mergeWarning.textContent = crossTeam
      ? 'Команды различаются: ' + teams.join(', ') + '. Команда целевого кейса «' + (target.team || 'не назначена') + '» останется без изменений.'
      : '';
  }
  if (elements.mergeNote) {
    elements.mergeNote.textContent = 'Команда целевого кейса сохранится: ' + (target.team || 'не назначена') + '. Источники, история и уведомления перейдут в целевой кейс.';
  }
  const blocked = cases.some(info => info.version === null);
  if (elements.mergeConfirm) {
    elements.mergeConfirm.disabled = Boolean(merge.busy || blocked);
    const total = merge.caseIds.length;
    elements.mergeConfirm.textContent = merge.busy ? 'Объединяем…' : 'Объединить ' + total + ' ' + plural(total, 'кейс', 'кейса', 'кейсов');
  }
  if (elements.mergeError) {
    elements.mergeError.hidden = !merge.error;
    elements.mergeError.textContent = merge.error || '';
  }
}

function onMergeTargetChange(event) {
  const input = event.target.closest('input[name="merge-target"]');
  if (!input || !state.triage.merge) return;
  state.triage.merge.targetCaseId = input.value;
  state.triage.merge.error = null;
  syncMergeDialogState();
}

function triageMergeError(error) {
  const code = error && error.payload ? error.payload.code : '';
  if (code === 'triage_disabled') return 'Дубли отключены на сервере.';
  if (error.status === 409) {
    if (code === 'case_closed') return 'Кейс уже закрыт — объединение недоступно.';
    if (code === 'lifecycle_mismatch') return 'Объединять можно только активные с активными или исследование с исследованием.';
    if (code === 'case_not_open') return 'Кейс уже не открыт — обновите данные и попробуйте снова.';
    return 'Кейс изменился (конфликт версий). Данные обновлены, попробуйте снова.';
  }
  if (error.status === 404) return 'Целевой или исходный кейс не найден.';
  return error.message || 'Не удалось объединить кейсы.';
}

async function confirmTriageMerge() {
  const merge = state.triage.merge;
  if (!merge || merge.busy) return;
  const cases = triageMergeCases(merge);
  const target = triageCaseInfo(merge.targetCaseId);
  const sources = cases.filter(info => String(info.caseId) !== String(merge.targetCaseId));
  if (!target || !sources.length) {
    merge.error = 'Не удалось определить кейсы для объединения — обновите данные.';
    syncMergeDialogState();
    return;
  }
  if (target.version === null || sources.some(info => info.version === null)) {
    merge.error = 'Не удалось определить версию кейса — обновите данные.';
    syncMergeDialogState();
    return;
  }
  merge.busy = true;
  merge.error = null;
  syncMergeDialogState();
  const expectedVersions = {};
  for (const source of sources) expectedVersions[source.caseId] = source.version;
  const body = {
    sourceCaseIds: sources.map(source => source.caseId),
    expectedVersions,
    expectedVersion: target.version
  };
  if (sources.length === 1) {
    body.sourceCaseId = sources[0].caseId;
    body.expectedSourceVersion = sources[0].version;
  }
  try {
    await api('/api/v1/cases/' + encodeURIComponent(target.caseId) + '/merge', { method: 'POST', body });
    const sourceIds = sources.map(source => source.caseId);
    const total = merge.caseIds.length;
    closeMergeDialog();
    if (state.activeId && sourceIds.includes(String(state.activeId))) elements.dialog.close();
    state.triage.preserveAi = false;
    showToast('Кейсы объединены', total + ' ' + plural(total, 'кейс', 'кейса', 'кейсов') + ' → ' + (target.id || target.caseId));
    await queueRefresh({ notify: false });
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (state.triage.merge) state.triage.merge.error = triageMergeError(error);
    if (error.status === 409) {
      state.triage.preserveAi = false;
      queueRefresh({ notify: false }).catch(() => {});
    }
  } finally {
    if (state.triage.merge) {
      state.triage.merge.busy = false;
      syncMergeDialogState();
    }
  }
}

function closeMergeDialog() {
  state.triage.merge = null;
  if (elements.mergeDialog && elements.mergeDialog.open) elements.mergeDialog.close();
}

function resetTriage() {
  closeTriagePanel({ restoreFocus: false });
  closeMergeDialog();
  state.triage.report = null;
  state.triage.clusters = [];
  state.triage.loading = false;
  state.triage.scanning = false;
  state.triage.autoScanned = false;
  state.triage.error = null;
  state.triage.aiError = null;
  state.triage.focusCaseId = null;
  state.triage.preserveAi = false;
  renderTriageChip();
}

/* --------------------------------------------------------------- rendering */
/* --------------------------------------------------------------- rendering */


function priorityBadge(incident) {
  const manual = incident.prioritySource === 'manual';
  const glyph = incident.priority === 'critical' ? 'alert' : 'bolt';
  return `<span class="priority-badge priority-${incident.priorityId}">${icon(glyph)}${escapeHtml(priorityLabel(incident.priorityId))}${manual ? '<span class="manual-mark">· ручной</span>' : ''}</span>`;
}

function stateBadgeClass(incident) {
  if (incident.groups.includes('research')) return 'state-research';
  if (incident.groups.includes('closed')) return 'state-closed';
  return 'state-active';
}

function renderCard(incident, group) {
  const sla = getSla(incident);
  const progress = slaProgress(incident);
  const caseId = escapeHtml(incident.caseId);
  const flags = [];

  if (incident.isNeedUp) flags.push('<span class="flag flag--needup">Эскалация</span>');

  const cardGroup = group === 'archive' ? 'archive' : group || 'active';
  const coordinator = incident.coordinatorName || 'Не назначен';
  const due = incident.dueAt !== null && incident.dueAt !== undefined ? dateTime.format(incident.dueAt) : 'не задан';
  const dueClass = sla.tone === 'overdue' ? 'is-overdue' : sla.tone === 'urgent' ? 'is-urgent' : '';
  const isCoordinator = incident.groups.includes('active') && !incident.team;

  return `<li>
    <article class="incident-card card-${cardGroup}">
      <div class="card-topline">
        <div class="card-topline-main">
          ${priorityBadge(incident)}
        </div>
        <a class="card-itsm" href="${itsmUrl(incident)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть ${escapeHtml(incident.id)} в ITSM">${icon('external')}</a>
      </div>
      <p class="card-product">${escapeHtml(incident.product || 'ITSM')}<span class="card-service">${incident.service ? ' · ' + escapeHtml(incident.service) : ''}</span></p>
      <h3><button class="card-open" type="button" data-open-incident="${caseId}">${escapeHtml(incident.title)}</button></h3>
      <dl class="card-meta">
        <div><dt>Возникло</dt><dd>${incident.startedAt ? dateTime.format(incident.startedAt) : '—'}</dd></div>
        <div><dt>Координатор</dt><dd>${escapeHtml(coordinator)}</dd></div>
        <div><dt>Команда</dt><dd class="card-team${incident.team ? '' : ' is-empty'}">${escapeHtml(incident.team || 'Не назначена')}</dd></div>
        <div><dt>Срок</dt><dd class="${dueClass}">${due}</dd></div>
      </dl>
      ${flags.length ? '<div class="card-flags">' + flags.join('') + '</div>' : ''}
      <div class="sla-track ${toneClass(progress.tone)}" aria-hidden="true"><span class="sla-fill" data-sla-fill="${caseId}" style="inline-size:${progress.pct}%"></span></div>
      <footer class="card-footer">
        <span class="state-badge ${stateBadgeClass(incident)}">${escapeHtml(incident.status)}</span>
        <span class="card-numbers">${icon('users')}${formatNumber(incident.affectedUsers)} · ${formatNumber(incident.reportCount)} обр.</span>
        <span class="sla-value ${toneClass(sla.tone)}" data-sla-id="${caseId}">${sla.value}</span>
      </footer>
      ${isCoordinator ? '<div class="coordination-note">' + icon('forward') + 'Требуется передать профильной команде</div>' : ''}
    </article>
  </li>`;
}

function compareIncidents(a, b) {
  const priorityDifference = (b.priorityId ?? 0) - (a.priorityId ?? 0);
  if (priorityDifference) return priorityDifference;
  if (a.dueAt !== null && a.dueAt !== undefined && b.dueAt !== null && b.dueAt !== undefined) return a.dueAt - b.dueAt;
  if (a.dueAt !== null && a.dueAt !== undefined) return -1;
  if (b.dueAt !== null && b.dueAt !== undefined) return 1;
  return (b.startedAt ?? 0) - (a.startedAt ?? 0);
}

function getFilteredIncidents(list, { applyRisk = false } = {}) {
  const query = state.filters.search.trim().toLocaleLowerCase('ru');
  const assistantIds = state.assistant.caseIds;
  return list.filter(incident => {
    if (assistantIds && !assistantIds.has(incident.caseId)) return false;
    const haystack = [
      incident.id,
      incident.title,
      incident.product,
      incident.service,
      incident.scenario,
      incident.region,
      incident.coordinatorName,
      incident.team,
      ...(incident.sourceIds || [])
    ].filter(Boolean).join(' ').toLocaleLowerCase('ru');
    const matchesSearch = !query || haystack.includes(query);
    const matchesProduct = state.filters.product === 'all' || incident.product === state.filters.product;
    const matchesRisk = !applyRisk || !state.filters.riskOnly || isSlaRisk(incident);
    const matchesCoordinator = !state.filters.unassigned
      || (!incident.coordinatorId && !incident.coordinatorName);
    return matchesSearch && matchesProduct && matchesRisk && matchesCoordinator;
  });
}

function isInProgress(incident) {
  return incident.groups.includes('active')
    && Boolean(incident.team)
    && !incident.groups.includes('research');
}

function renderGroups() {
  const live = state.incidents.filter(incident => !incident.groups.includes('closed'));
  const filtered = getFilteredIncidents(live, { applyRisk: true });
  for (const group of groupKeys) {
    const items = filtered.filter(incident => incident.groups.includes(group)).sort(compareIncidents);
    const list = document.querySelector(`#list-${group}`);
    list.innerHTML = items.length
      ? items.map(incident => renderCard(incident, group)).join('')
      : '<li class="empty-state">Нет инцидентов по выбранным условиям</li>';
    setText(`#group-count-${group}`, items.length);
  }

  const inProgress = filtered.filter(isInProgress).sort(compareIncidents);
  const inProgressList = document.querySelector('#list-in-progress');
  const inProgressView = document.querySelector('#in-progress-view');
  if (inProgressList) {
    inProgressList.innerHTML = inProgress
      .map(incident => renderCard(incident, 'in-progress'))
      .join('');
  }
  setText('#group-count-in-progress', inProgress.length);
  setText('#in-progress-chip-count', inProgress.length);
  setText('#in-progress-fab-count', inProgress.length);
  const inProgressJump = document.querySelector('#in-progress-jump');
  if (inProgressJump) inProgressJump.hidden = state.filters.archive || !inProgress.length;
  if (inProgressView) inProgressView.hidden = state.filters.archive || !inProgress.length;
  observeInProgressView();
  updateInProgressFab();
}

function updateInProgressFab() {
  const fab = document.querySelector('#in-progress-fab');
  if (!fab) return;
  const view = document.querySelector('#in-progress-view');
  if (view && !state.inProgress.observer) state.inProgress.inView = isInProgressViewVisible(view);
  const dashboardVisible = !document.querySelector('#dashboard-view').hidden;
  const exists = Boolean(view) && !view.hidden && !state.filters.archive;
  const visible = Boolean(state.user) && dashboardVisible && exists && !state.inProgress.inView;
  fab.hidden = !visible;
}

function isInProgressViewVisible(view) {
  if (!view || view.hidden) return false;
  const rect = view.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}

function observeInProgressView() {
  const view = document.querySelector('#in-progress-view');
  const observer = state.inProgress.observer;
  if (!view || !observer) return;
  state.inProgress.inView = isInProgressViewVisible(view);
  observer.unobserve(view);
  observer.observe(view);
}

function setupInProgressObserver() {
  const view = document.querySelector('#in-progress-view');
  if (!view || typeof IntersectionObserver !== 'function') return;
  const observer = new IntersectionObserver(entries => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    state.inProgress.inView = entry.isIntersecting;
    updateInProgressFab();
  }, { threshold: 0 });
  state.inProgress.observer = observer;
  observer.observe(view);
}

function jumpToInProgress() {
  const view = document.querySelector('#in-progress-view');
  if (!view || view.hidden) return;
  view.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const count = document.querySelector('#group-count-in-progress');
  announce('В работе: ' + (count ? count.textContent : '0') + ' инцидентов.');
}

function renderArchive() {
  const archiveMode = state.filters.archive;
  document.querySelector('#groups-grid').hidden = archiveMode;
  document.querySelector('#archive-view').hidden = !archiveMode;
  if (archiveMode) {
    const inProgressView = document.querySelector('#in-progress-view');
    if (inProgressView) inProgressView.hidden = true;
  }
  elements.archiveButton.setAttribute('aria-pressed', String(archiveMode));
  if (!archiveMode) return;
  const closed = state.incidents.filter(incident => incident.groups.includes('closed'));
  const filtered = getFilteredIncidents(closed).sort((a, b) => (b.resolvedAt ?? b.startedAt ?? 0) - (a.resolvedAt ?? a.startedAt ?? 0));
  const list = document.querySelector('#list-archive');
  list.innerHTML = filtered.length
    ? filtered.map(incident => renderCard(incident, 'archive')).join('')
    : '<li class="empty-state">Завершённых инцидентов нет</li>';
  setText('#archive-count', filtered.length);
}

function renderSummary() {
  const counts = state.counts || {};
  const all = state.incidents;
  const total = all.length;
  const criticalTotal = all.filter(incident => incident.priorityId === 4).length;
  const highTotal = all.filter(incident => incident.priorityId === 3).length;
  const coordinationTotal = all.filter(incident => incident.groups.includes('coordination')).length;
  const researchTotal = all.filter(incident => incident.groups.includes('research')).length;

  setText('#critical-count', counts.critical ?? 0);
  setText('#coordination-count', counts.coordination ?? 0);
  setText('#high-count', counts.high ?? 0);
  setText('#research-count', counts.research ?? 0);
  setText('#total-count', counts.active ?? 0);
  setText('#critical-total', criticalTotal);
  setText('#coordination-total', coordinationTotal);
  setText('#high-total', highTotal);
  setText('#research-total', researchTotal);
  setText('#active-total', total);
  setText('#risk-count', counts.risk ?? 0);
  setText('#affected-count', formatNumber(counts.affectedUsers ?? 0));
  setText('#last-sync-label', state.lastSyncedAt ? formatRelative(state.lastSyncedAt) : '—');
  const archiveHint = document.querySelector('#archive-hint');
  if (archiveHint) archiveHint.hidden = !state.filters.archive;
}

function renderBanner() {
  const incident = findIncident(state.latestCriticalId);
  const visible = Boolean(incident && incident.groups.includes('critical') && !state.bannerDismissed);
  elements.banner.hidden = !visible;
  if (!visible) return;
  setText('#banner-title', incident.title);
  setText('#banner-product', `${incident.product} · ${incident.id}`);
  setText('#banner-time', formatRelative(incident.startedAt));
  document.querySelector('#banner-sla').dataset.slaId = incident.caseId;
  document.querySelector('#banner-open').dataset.openIncident = incident.caseId;
}

function rebuildProducts() {
  const products = [...new Set(state.incidents.map(incident => incident.product).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const key = JSON.stringify(products);
  if (key === state.productsKey) return;
  state.productsKey = key;
  const select = elements.product;
  select.innerHTML = '<option value="all">Все продукты</option>'
    + products.map(product => `<option value="${escapeHtml(product)}">${escapeHtml(product)}</option>`).join('');
  if (products.includes(state.filters.product)) select.value = state.filters.product;
  else {
    select.value = 'all';
    state.filters.product = 'all';
  }
}

function renderToolbarState() {
  elements.reset.disabled = !state.filters.search && state.filters.product === 'all' && !state.filters.riskOnly && !state.filters.unassigned;
  elements.risk.disabled = state.filters.archive;
}

function renderSyncState() {
  const warning = document.querySelector('#sync-warning');
  if (!warning) return;
  warning.hidden = !state.syncError;
  if (state.syncError) warning.textContent = `Ошибка синхронизации: ${state.syncError}`;
  setText('#last-sync-label', state.lastSyncedAt ? formatRelative(state.lastSyncedAt) : '—');
}

function updateCountdowns() {
  for (const element of document.querySelectorAll('[data-sla-id]')) {
    const incident = findIncident(element.dataset.slaId);
    if (!incident) continue;
    const sla = getSla(incident);
    if (element.id === 'banner-sla') {
      element.textContent = sla.value;
      const label = document.querySelector('#banner-sla-label');
      if (label) label.textContent = sla.label;
      continue;
    }
    element.textContent = sla.value;
    if (element.classList.contains('sla-value')) element.className = `sla-value ${toneClass(sla.tone)}`;
  }

  for (const fill of document.querySelectorAll('[data-sla-fill]')) {
    const incident = findIncident(fill.dataset.slaFill);
    if (!incident) continue;
    const progress = slaProgress(incident);
    fill.style.inlineSize = `${progress.pct}%`;
    const track = fill.closest('.sla-track');
    if (track) track.className = `sla-track ${toneClass(progress.tone)}`;
  }

  if (state.activeId && elements.dialog.open) {
    const incident = findIncident(state.activeId);
    if (incident) {
      const sla = getSla(incident);
      setText('#dialog-sla-label', sla.label);
      const value = document.querySelector('#dialog-sla-value');
      if (value) {
        value.textContent = sla.value;
        value.className = toneClass(sla.tone);
      }
      const bar = document.querySelector('#dialog-sla-bar');
      if (bar) {
        const progress = slaProgress(incident);
        bar.style.inlineSize = `${progress.pct}%`;
        const track = bar.closest('.sla-track');
        if (track) track.className = `sla-track ${toneClass(progress.tone)}`;
      }
    }
  }
}

function captureFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const open = active.closest('[data-open-incident]');
  if (open) return { type: 'card', caseId: open.dataset.openIncident };
  if (active.id) return { type: 'id', id: active.id };
  return null;
}

function restoreFocus(token) {
  if (!token) return;
  if (token.type === 'card') {
    const buttons = [...document.querySelectorAll(`[data-open-incident="${CSS.escape(token.caseId)}"]`)];
    const target = buttons.find(button => button.offsetParent !== null) || buttons[0];
    if (target) target.focus({ preventScroll: true });
    return;
  }
  if (token.type === 'id') {
    const element = document.getElementById(token.id);
    if (element) element.focus({ preventScroll: true });
  }
}

function render() {
  const focus = captureFocus();
  rebuildProducts();
  renderSummary();
  renderGroups();
  renderArchive();
  renderBanner();
  renderToolbarState();
  renderSyncState();
  renderLive();
  renderTriageChip();
  renderAssistantChip();
  renderRoutingQueueButton();
  if (state.activeId && findIncident(state.activeId)) {
    populateDialog(findIncident(state.activeId), { resetInputs: false });
  }
  updateCountdowns();
  restoreFocus(focus);
}

/* --------------------------------------------------------------- assistant */

function groupLabel(group) {
  return ({
    active: 'Активные',
    critical: 'Критические',
    coordination: 'На координаторов',
    high: 'Высокий приоритет',
    research: 'Исследование',
    closed: 'Закрытые'
  })[group] || group;
}

function slaLabel(value) {
  return ({
    ok: 'SLA в норме',
    risk: 'SLA-риск',
    overdue: 'SLA просрочен',
    risk_or_overdue: 'SLA-риск или просрочка'
  })[value] || value;
}

function assistantFilterChips(filter) {
  if (!filter) return '';
  const labels = [];
  if (filter.groups) labels.push('Группы: ' + filter.groups.map(groupLabel).join(', '));
  if (filter.priorityIds) labels.push('Приоритет: ' + filter.priorityIds.map(priorityLabel).join(', '));
  if (filter.stateIds) labels.push('Статус: ' + filter.stateIds.map(stateLabel).join(', '));
  if (filter.regions) labels.push('Регион: ' + filter.regions.join(', '));
  if (filter.products) labels.push('Продукт: ' + filter.products.join(', '));
  if (filter.services) labels.push('Сервис: ' + filter.services.join(', '));
  if (filter.teams) labels.push('Команда: ' + filter.teams.join(', '));
  if (filter.needsTeam) labels.push('Без команды');
  if (filter.unassignedCoordinator) labels.push('Без координатора');
  if (filter.sla) labels.push(slaLabel(filter.sla));
  if (filter.dueWithinMinutes) labels.push('Дедлайн ≤ ' + filter.dueWithinMinutes + ' мин');
  if (filter.startedWithinMinutes) labels.push('Возникли ≤ ' + filter.startedWithinMinutes + ' мин назад');
  if (filter.affectedUsersMin !== undefined) labels.push('Затронуто ≥ ' + filter.affectedUsersMin);
  if (filter.affectedUsersMax !== undefined) labels.push('Затронуто ≤ ' + filter.affectedUsersMax);
  if (filter.reportCountMin !== undefined) labels.push('Обращений ≥ ' + filter.reportCountMin);
  if (filter.reportCountMax !== undefined) labels.push('Обращений ≤ ' + filter.reportCountMax);
  if (filter.isNeedUp) labels.push('Нужна эскалация');
  if (filter.isMaster) labels.push('Мастер');
  if (filter.isEffect) labels.push('Влияние');
  if (filter.text) labels.push('Поиск: ' + filter.text);
  if (!labels.length) labels.push('Все инциденты');
  const visible = labels.slice(0, 8);
  const extra = labels.length > visible.length ? labels.length - visible.length : 0;
  return visible.map(label => `<span class="assistant-chip">${escapeHtml(label)}</span>`).join('')
    + (extra ? `<span class="assistant-chip">ещё ${extra}</span>` : '');
}

function renderAssistantChip() {
  if (!elements.assistantFilter || !elements.assistantFilterLabel) return;
  const active = Boolean(state.assistant.caseIds);
  elements.assistantFilter.hidden = !active;
  if (!active) return;
  const shown = state.assistant.caseIds.size;
  let text = 'ИИ-фильтр: ' + state.assistant.count;
  if (state.assistant.truncated) text += ' · показаны ' + shown;
  if (state.assistant.closed > 0 && !state.filters.archive) text += ' · в архиве ' + state.assistant.closed;
  elements.assistantFilterLabel.textContent = text;
  elements.assistantFilter.title = state.assistant.filter ? JSON.stringify(state.assistant.filter) : '';
}

function syncAssistantVisibility() {
  if (!elements.assistantButton) return;
  const dashboardVisible = !document.querySelector('#dashboard-view').hidden;
  const enabled = meta().assistantEnabled !== false;
  const visible = Boolean(state.user) && dashboardVisible && enabled;
  elements.assistantButton.hidden = !visible;
  if (!visible) closeAssistant();
}

function openAssistant() {
  if (!elements.assistantButton || elements.assistantButton.hidden) return;
  if (state.routing.queueOpen) closeRoutingPanel();
  if (state.triage.open) closeTriagePanel({ restoreFocus: false });
  state.assistant.open = true;
  elements.assistantPanel.hidden = false;
  elements.assistantButton.setAttribute('aria-expanded', 'true');
  elements.assistantInput.focus();
}

function closeAssistant() {
  state.assistant.open = false;
  if (state.assistant.controller) {
    state.assistant.controller.abort();
    state.assistant.controller = null;
  }
  if (elements.assistantPanel) elements.assistantPanel.hidden = true;
  if (elements.assistantButton) elements.assistantButton.setAttribute('aria-expanded', 'false');
}

function resetAssistantUi() {
  state.assistant.caseIds = null;
  state.assistant.filter = null;
  state.assistant.pending = null;
  state.assistant.count = 0;
  state.assistant.closed = 0;
  state.assistant.truncated = false;
  state.assistant.busy = false;
  if (state.assistant.controller) {
    state.assistant.controller.abort();
    state.assistant.controller = null;
  }
  if (elements.assistantLog) {
    elements.assistantLog.querySelectorAll('.assistant-message').forEach(node => node.remove());
  }
  if (elements.assistantInput) elements.assistantInput.value = '';
  if (elements.assistantSubmit) elements.assistantSubmit.disabled = false;
  closeAssistant();
  renderAssistantChip();
}

function assistantAppendMessage(role, text) {
  const box = document.createElement('div');
  box.className = 'assistant-message assistant-message--' + role;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  box.appendChild(paragraph);
  elements.assistantLog.appendChild(box);
  elements.assistantLog.scrollTop = elements.assistantLog.scrollHeight;
  return box;
}

function assistantAppendClarify(result) {
  const box = assistantAppendMessage('assistant', result.clarification || 'Уточните запрос.');
  if (Array.isArray(result.options) && result.options.length) {
    const actions = document.createElement('div');
    actions.className = 'assistant-actions';
    for (const option of result.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-secondary button-sm';
      button.textContent = option;
      button.addEventListener('click', () => {
        elements.assistantInput.value = option;
        sendAssistant(option);
      });
      actions.appendChild(button);
    }
    box.appendChild(actions);
  }
  elements.assistantLog.scrollTop = elements.assistantLog.scrollHeight;
}

function assistantAppendPreview(result) {
  const count = result.matched ? result.matched.count : 0;
  const box = document.createElement('div');
  box.className = 'assistant-message assistant-message--assistant';

  const explanation = document.createElement('p');
  explanation.textContent = result.explanation || 'Фильтр по запросу';
  box.appendChild(explanation);

  const chips = document.createElement('div');
  chips.className = 'assistant-chips';
  chips.innerHTML = assistantFilterChips(result.filter);
  box.appendChild(chips);

  const summary = document.createElement('p');
  summary.className = 'assistant-count';
  summary.textContent = 'Найдено: ' + count
    + (result.matched && result.matched.closed ? ', в архиве ' + result.matched.closed : '')
    + (result.matched && result.matched.truncated ? ', показаны первые ' + result.matched.caseIds.length : '');
  box.appendChild(summary);

  if (!count) {
    const empty = document.createElement('p');
    empty.className = 'assistant-count';
    empty.textContent = 'Ничего не найдено — уточните запрос.';
    box.appendChild(empty);
  }

  const actions = document.createElement('div');
  actions.className = 'assistant-actions';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'button button-primary button-sm';
  apply.textContent = count ? 'Показать ' + count : 'Показать';
  apply.disabled = !count;
  apply.addEventListener('click', () => applyAssistantResult(result));
  actions.appendChild(apply);

  const refine = document.createElement('button');
  refine.type = 'button';
  refine.className = 'button button-secondary button-sm';
  refine.textContent = 'Уточнить';
  refine.addEventListener('click', () => elements.assistantInput.focus());
  actions.appendChild(refine);
  box.appendChild(actions);

  elements.assistantLog.appendChild(box);
  elements.assistantLog.scrollTop = elements.assistantLog.scrollHeight;
  state.assistant.pending = result;
}

function applyAssistantResult(result) {
  if (!result || !result.matched || !result.matched.count) return;
  state.assistant.caseIds = new Set(result.matched.caseIds || []);
  state.assistant.filter = result.filter;
  state.assistant.count = result.matched.count;
  state.assistant.closed = result.matched.closed || 0;
  state.assistant.truncated = Boolean(result.matched.truncated);
  state.filters.search = '';
  state.filters.product = 'all';
  state.filters.riskOnly = false;
  state.filters.archive = result.matched.closed === result.matched.count && result.matched.count > 0;
  if (elements.search) elements.search.value = '';
  if (elements.product) elements.product.value = 'all';
  if (elements.risk) elements.risk.checked = false;
  render();
  closeAssistant();
  announce('ИИ-фильтр: найдено ' + state.assistant.count + ' инцидентов.');
}

function clearAssistantFilter() {
  state.assistant.caseIds = null;
  state.assistant.filter = null;
  state.assistant.pending = null;
  state.assistant.count = 0;
  state.assistant.closed = 0;
  state.assistant.truncated = false;
  state.filters.archive = false;
  render();
  announce('ИИ-фильтр сброшен. Показан живой список.');
}

async function sendAssistant(text) {
  if (state.assistant.busy) return;
  const query = String(text || '').trim();
  if (!query) return;
  elements.assistantInput.value = '';
  assistantAppendMessage('user', query);
  state.assistant.busy = true;
  elements.assistantSubmit.disabled = true;
  const pending = assistantAppendMessage('assistant', 'Разбираю запрос…');
  const controller = new AbortController();
  state.assistant.controller = controller;
  try {
    const result = await api('/api/v1/assistant/parse', {
      method: 'POST',
      body: { text: query },
      signal: controller.signal
    });
    pending.remove();
    if (result.intent === 'clarify') assistantAppendClarify(result);
    else assistantAppendPreview(result);
  } catch (error) {
    pending.remove();
    if (error.name === 'AbortError') return;
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    assistantAppendMessage('error', 'Не удалось разобрать запрос: ' + error.message);
  } finally {
    state.assistant.busy = false;
    if (state.assistant.controller === controller) state.assistant.controller = null;
    elements.assistantSubmit.disabled = false;
    if (state.assistant.open) elements.assistantInput.focus();
  }
}

/* --------------------------------------------------------------- routing */

function routingKey(incident) {
  return String(incident.caseId) + ':' + String(incident.version);
}

function syncRoutingVisibility() {
  if (!elements.routingQueueButton) return;
  const dashboardVisible = !document.querySelector('#dashboard-view').hidden;
  const enabled = meta().routingEnabled !== false;
  if (!enabled || !state.user || !dashboardVisible) closeRoutingPanel();
  renderRoutingQueueButton();
}

function renderRoutingQueueButton() {
  if (!elements.routingQueueButton) return;
  const enabled = meta().routingEnabled !== false;
  const dashboardVisible = !document.querySelector('#dashboard-view').hidden;
  const unassigned = state.incidents.filter(incident => incident.groups.includes('active') && !incident.team).length;
  const visible = enabled && Boolean(state.user) && dashboardVisible && unassigned > 0;
  elements.routingQueueButton.hidden = !visible;
  if (elements.routingQueueCount) elements.routingQueueCount.textContent = String(unassigned);
  if (!visible && state.routing.queueOpen) closeRoutingPanel();
}

function clearRoutingHint() {
  if (elements.routingHint) elements.routingHint.hidden = true;
  if (elements.routingStatus) {
    elements.routingStatus.hidden = true;
    elements.routingStatus.textContent = '';
    elements.routingStatus.classList.remove('is-error');
  }
  state.routing.suggestion = null;
}

function setRoutingStatus(text, isError = false) {
  if (!elements.routingStatus) return;
  if (!text) {
    elements.routingStatus.hidden = true;
    elements.routingStatus.textContent = '';
    elements.routingStatus.classList.remove('is-error');
    return;
  }
  elements.routingStatus.hidden = false;
  elements.routingStatus.textContent = text;
  elements.routingStatus.classList.toggle('is-error', isError);
}

function renderRoutingSuggestion(incident, suggestion) {
  if (!incident || !suggestion || !suggestion.team || !incident.groups.includes('active') || incident.team) {
    clearRoutingHint();
    return;
  }
  state.routing.suggestion = suggestion;
  if (elements.routingHintTitle) elements.routingHintTitle.textContent = 'Предложено: ' + suggestion.team;
  if (elements.routingHintReason) elements.routingHintReason.textContent = suggestion.rationale || 'Профильная команда по продукту и сценарию.';
  if (elements.routingHintSource) elements.routingHintSource.textContent = suggestion.source === 'rule' ? 'правило' : 'ИИ';
  if (elements.routingHint) elements.routingHint.hidden = false;
  setRoutingStatus('');
}

function resetRoutingSuggestion({ abort = false } = {}) {
  if (abort && state.routing.controller) {
    state.routing.controller.abort();
    state.routing.controller = null;
  }
  if (abort) {
    state.routing.requestedKey = null;
    state.routing.loading = false;
  }
  clearRoutingHint();
}

async function getRoutingSuggestion(incident, signal) {
  const key = routingKey(incident);
  const cached = state.routing.cache.get(key);
  if (cached) return cached;
  const data = await api('/api/v1/routing/suggest', {
    method: 'POST',
    body: { caseId: incident.caseId },
    signal
  });
  state.routing.cache.set(key, data);
  return data;
}

async function requestRoutingSuggestion(incident) {
  if (!incident || meta().routingEnabled === false || !incident.groups.includes('active') || incident.team) {
    clearRoutingHint();
    return;
  }
  const key = routingKey(incident);
  if (state.routing.requestedKey === key) {
    if (state.routing.suggestion) renderRoutingSuggestion(incident, state.routing.suggestion);
    return;
  }
  const cached = state.routing.cache.get(key);
  if (cached) {
    state.routing.requestedKey = key;
    if (cached.team) renderRoutingSuggestion(incident, cached);
    else clearRoutingHint();
    return;
  }
  if (state.routing.controller) state.routing.controller.abort();
  const controller = new AbortController();
  state.routing.controller = controller;
  state.routing.requestedKey = key;
  state.routing.loading = true;
  clearRoutingHint();
  setRoutingStatus('Подбираю команду…');
  try {
    const data = await getRoutingSuggestion(incident, controller.signal);
    if (state.activeId !== incident.caseId) return;
    const current = findIncident(incident.caseId);
    if (!current || current.version !== incident.version || current.team || !current.groups.includes('active')) {
      clearRoutingHint();
      return;
    }
    state.routing.cache.set(key, data);
    if (data.team) renderRoutingSuggestion(incident, data);
    else clearRoutingHint();
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    clearRoutingHint();
  } finally {
    state.routing.loading = false;
    if (state.routing.controller === controller) state.routing.controller = null;
  }
}

async function acceptRoutingSuggestion() {
  const incident = currentIncident();
  const suggestion = state.routing.suggestion;
  if (!incident || !suggestion || !suggestion.team) return;
  await performAction(incident, 'team', { team: suggestion.team });
  resetRoutingSuggestion({ abort: true });
}

function focusTeamSelect() {
  const select = document.querySelector('#team-select');
  if (!select) return;
  select.focus();
  select.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function openRoutingPanel() {
  if (!elements.routingPanel || meta().routingEnabled === false || !state.user) return;
  if (state.assistant.open) closeAssistant();
  if (state.triage.open) closeTriagePanel({ restoreFocus: false });
  state.routing.queueOpen = true;
  elements.routingPanel.hidden = false;
  elements.routingQueueButton.setAttribute('aria-expanded', 'true');
  renderRoutingQueue();
}

function closeRoutingPanel() {
  state.routing.queueOpen = false;
  state.routing.queueRun += 1;
  if (state.routing.queueController) {
    state.routing.queueController.abort();
    state.routing.queueController = null;
  }
  if (elements.routingPanel) elements.routingPanel.hidden = true;
  if (elements.routingQueueButton) elements.routingQueueButton.setAttribute('aria-expanded', 'false');
}

function resetRoutingUi() {
  resetRoutingSuggestion({ abort: true });
  closeRoutingPanel();
  state.routing.cache.clear();
  state.routing.requestedKey = null;
  if (elements.routingList) elements.routingList.innerHTML = '';
}

function routingQueueCases() {
  return state.incidents
    .filter(incident => incident.groups.includes('active') && !incident.team)
    .sort((a, b) => {
      if ((b.priorityId || 0) !== (a.priorityId || 0)) return (b.priorityId || 0) - (a.priorityId || 0);
      const aDue = a.dueAt === null || a.dueAt === undefined ? Number.MAX_SAFE_INTEGER : a.dueAt;
      const bDue = b.dueAt === null || b.dueAt === undefined ? Number.MAX_SAFE_INTEGER : b.dueAt;
      return aDue - bDue;
    })
    .slice(0, 30);
}

function queueRow(incident) {
  const row = document.createElement('article');
  row.className = 'routing-item';
  row.dataset.routingCase = incident.caseId;

  const head = document.createElement('div');
  head.className = 'routing-item-head';
  const title = document.createElement('p');
  title.className = 'routing-item-title';
  title.textContent = incident.id + ' · ' + incident.title;
  const meta = document.createElement('span');
  meta.className = 'routing-item-meta';
  meta.textContent = priorityLabel(incident.priorityId) + ' · ' + formatNumber(incident.affectedUsers || 0);
  head.append(title, meta);

  const status = document.createElement('p');
  status.className = 'routing-item-status';
  status.textContent = 'Подбираю команду…';

  const suggestion = document.createElement('div');
  suggestion.className = 'routing-item-suggestion';
  suggestion.hidden = true;
  const team = document.createElement('strong');
  team.className = 'routing-item-team';
  const reason = document.createElement('p');
  reason.className = 'routing-item-reason';
  const source = document.createElement('span');
  source.className = 'routing-source';
  suggestion.append(team, reason, source);

  const actions = document.createElement('div');
  actions.className = 'routing-item-actions';
  const assign = document.createElement('button');
  assign.type = 'button';
  assign.className = 'button button-primary button-sm';
  assign.textContent = 'Назначить';
  assign.hidden = true;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'button button-secondary button-sm';
  open.textContent = 'Открыть';
  open.addEventListener('click', () => {
    closeRoutingPanel();
    openIncident(incident.caseId);
  });
  actions.append(assign, open);

  row.append(head, status, suggestion, actions);
  return { row, status, suggestion, team, reason, source, assign };
}

function renderRoutingQueue() {
  if (!state.routing.queueOpen || !elements.routingList) return;
  state.routing.queueRun += 1;
  const run = state.routing.queueRun;
  if (state.routing.queueController) state.routing.queueController.abort();
  const controller = new AbortController();
  state.routing.queueController = controller;
  elements.routingList.innerHTML = '';
  const cases = routingQueueCases();
  if (!cases.length) {
    const empty = document.createElement('p');
    empty.className = 'routing-empty';
    empty.textContent = 'Все активные инциденты уже с командой.';
    elements.routingList.appendChild(empty);
    return;
  }
  const rows = new Map();
  for (const incident of cases) {
    const row = queueRow(incident);
    rows.set(incident.caseId, row);
    elements.routingList.appendChild(row.row);
  }
  loadRoutingQueueSuggestions(cases, rows, run, controller.signal);
}

async function loadRoutingQueueSuggestions(cases, rows, run, signal) {
  const pending = [...cases];
  const worker = async () => {
    while (pending.length) {
      if (run !== state.routing.queueRun || signal.aborted) return;
      const incident = pending.shift();
      const row = rows.get(incident.caseId);
      if (!row) continue;
      await loadRoutingQueueItem(incident, row, run, signal);
    }
  };
  await Promise.all([worker(), worker()]);
}

async function loadRoutingQueueItem(incident, row, run, signal) {
  try {
    const data = await getRoutingSuggestion(incident, signal);
    if (run !== state.routing.queueRun || signal.aborted) return;
    row.status.hidden = true;
    if (data.team) {
      row.team.textContent = '→ ' + data.team;
      row.reason.textContent = data.rationale || '';
      row.source.textContent = data.source === 'rule' ? 'правило' : 'ИИ';
      row.source.hidden = false;
      row.suggestion.hidden = false;
      row.assign.hidden = false;
      row.assign.addEventListener('click', () => assignRoutingFromQueue(incident, data, row));
    } else {
      row.status.hidden = false;
      row.status.textContent = 'Нет уверенной подсказки — выберите вручную.';
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (run !== state.routing.queueRun) return;
    row.status.hidden = false;
    row.status.textContent = 'Подсказка недоступна — откройте инцидент.';
    row.status.classList.add('is-error');
  }
}

async function assignRoutingFromQueue(incident, data, row) {
  row.assign.disabled = true;
  row.status.hidden = false;
  row.status.classList.remove('is-error');
  row.status.textContent = 'Назначаю…';
  try {
    await api('/api/v1/incidents/' + encodeURIComponent(incident.caseId) + '/team', {
      method: 'POST',
      body: { team: data.team, expectedVersion: data.version }
    });
    await queueRefresh({ notify: false });
    announce('Команда назначена: ' + data.team);
    renderRoutingQueue();
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    row.status.classList.add('is-error');
    row.status.textContent = error.message;
    row.assign.disabled = false;
    if (error.status === 409 || error.status === 400) {
      await queueRefresh({ notify: false });
      renderRoutingQueue();
    }
  }
}

/* --------------------------------------------------------------- postmortem */

function postmortemSignature(incident, history) {
  if (!incident) return '';
  const items = Array.isArray(history) ? history : [];
  return String(incident.caseId) + ':' + String(incident.version) + ':' + items.length + ':' + (items[0] ? items[0].id : 0);
}

function updatePostmortemButton() {
  if (!elements.postmortemButton) return;
  const enabled = meta().postmortemEnabled !== false;
  elements.postmortemButton.hidden = !enabled;
  if (!enabled) {
    if (state.postmortem.controller) {
      state.postmortem.controller.abort();
      state.postmortem.controller = null;
    }
    state.postmortem.loading = false;
    if (elements.postmortemPanel) elements.postmortemPanel.hidden = true;
    return;
  }
  const incident = currentIncident();
  const hasHistory = state.postmortem.history.length > 0;
  const loading = state.postmortem.loading;
  elements.postmortemButton.disabled = !incident || !hasHistory || loading;
  if (elements.postmortemButtonLabel) {
    if (loading) elements.postmortemButtonLabel.textContent = 'Собираю…';
    else if (incident && (incident.groups.includes('closed') || incident.groups.includes('research'))) {
      elements.postmortemButtonLabel.textContent = 'Собрать постмортем';
    } else {
      elements.postmortemButtonLabel.textContent = 'Промежуточный разбор';
    }
  }
  elements.postmortemButton.title = !incident
    ? 'Откройте инцидент'
    : !hasHistory
      ? 'У инцидента пока нет истории изменений'
      : 'Собрать разбор по истории изменений';
}

function resetPostmortem({ abort = false, clearHistory = false, clearCache = false } = {}) {
  if (abort && state.postmortem.controller) {
    state.postmortem.controller.abort();
    state.postmortem.controller = null;
  }
  state.postmortem.loading = false;
  state.postmortem.data = null;
  state.postmortem.signature = null;
  if (clearHistory) {
    state.postmortem.history = [];
    state.postmortem.caseId = null;
  }
  if (clearCache) state.postmortem.cache.clear();
  if (elements.postmortemPanel) elements.postmortemPanel.hidden = true;
  if (elements.postmortemContent) elements.postmortemContent.hidden = true;
  if (elements.postmortemStatus) {
    elements.postmortemStatus.hidden = true;
    elements.postmortemStatus.textContent = '';
    elements.postmortemStatus.classList.remove('is-error');
  }
  if (elements.postmortemSource) {
    elements.postmortemSource.textContent = '';
    elements.postmortemSource.className = 'postmortem-source';
  }
  updatePostmortemButton();
}

function closePostmortem() {
  if (state.postmortem.controller) {
    state.postmortem.controller.abort();
    state.postmortem.controller = null;
  }
  state.postmortem.loading = false;
  if (elements.postmortemPanel) elements.postmortemPanel.hidden = true;
  updatePostmortemButton();
}

function postmortemBadge(label, level) {
  const badge = document.createElement('span');
  badge.className = 'postmortem-badge ' + (level || 'low');
  badge.textContent = label;
  return badge;
}

function confidenceLabel(value) {
  return ({ high: 'высокая', medium: 'средняя', low: 'низкая' })[value] || 'гипотеза';
}

function priorityLabelForRetro(value) {
  return ({ high: 'высокий', medium: 'средний', low: 'низкий' })[value] || 'средний';
}

function renderPostmortem(data) {
  const incident = currentIncident();
  if (!incident || !data) return;
  state.postmortem.data = data;
  state.postmortem.signature = postmortemSignature(incident, state.postmortem.history);
  if (elements.postmortemPanel) elements.postmortemPanel.hidden = false;
  if (elements.postmortemStatus) {
    elements.postmortemStatus.hidden = true;
    elements.postmortemStatus.textContent = '';
    elements.postmortemStatus.classList.remove('is-error');
  }
  if (elements.postmortemSource) {
    elements.postmortemSource.textContent = data.source === 'ai' ? 'ИИ' : 'Фактологический таймлайн';
    elements.postmortemSource.className = 'postmortem-source' + (data.source === 'ai' ? '' : ' is-fallback');
  }
  if (elements.postmortemSummary) elements.postmortemSummary.textContent = data.summary || '';
  if (elements.postmortemContent) elements.postmortemContent.hidden = false;

  if (elements.postmortemTimeline) {
    elements.postmortemTimeline.replaceChildren();
    for (const event of data.timeline || []) {
      const item = document.createElement('li');
      const eventText = document.createElement('span');
      eventText.className = 'postmortem-event';
      eventText.textContent = event.event;
      const meta = document.createElement('span');
      meta.className = 'postmortem-meta';
      meta.textContent = fullDateTime.format(event.at) + ' · ' + event.actor;
      item.append(eventText, meta);
      elements.postmortemTimeline.appendChild(item);
    }
    if (!data.timeline || !data.timeline.length) {
      const item = document.createElement('li');
      item.textContent = 'В истории пока нет событий.';
      elements.postmortemTimeline.appendChild(item);
    }
  }

  if (elements.postmortemCauses) {
    elements.postmortemCauses.replaceChildren();
    const causes = data.causes || [];
    if (!causes.length) {
      const item = document.createElement('li');
      item.textContent = 'Причины в истории не зафиксированы.';
      elements.postmortemCauses.appendChild(item);
    } else {
      for (const cause of causes) {
        const item = document.createElement('li');
        const text = document.createElement('strong');
        text.textContent = cause.text;
        item.appendChild(text);
        if (cause.evidence) {
          const evidence = document.createElement('span');
          evidence.className = 'postmortem-evidence';
          evidence.textContent = 'Evidence: ' + cause.evidence;
          item.appendChild(evidence);
        }
        item.appendChild(postmortemBadge(confidenceLabel(cause.confidence), cause.confidence));
        elements.postmortemCauses.appendChild(item);
      }
    }
  }

  if (elements.postmortemImprovements) {
    elements.postmortemImprovements.replaceChildren();
    const improvements = data.improvements || [];
    if (!improvements.length) {
      const item = document.createElement('li');
      item.textContent = 'Улучшения не предложены.';
      elements.postmortemImprovements.appendChild(item);
    } else {
      for (const improvement of improvements) {
        const item = document.createElement('li');
        const text = document.createElement('strong');
        text.textContent = improvement.action;
        item.appendChild(text);
        if (improvement.owner) {
          const owner = document.createElement('span');
          owner.className = 'postmortem-owner';
          owner.textContent = 'Владелец: ' + improvement.owner;
          item.appendChild(owner);
        }
        item.appendChild(postmortemBadge('приоритет: ' + priorityLabelForRetro(improvement.priority), improvement.priority));
        elements.postmortemImprovements.appendChild(item);
      }
    }
  }

  const renderStringList = (list, target, section) => {
    if (!target || !section) return;
    target.replaceChildren();
    const values = Array.isArray(list) ? list : [];
    section.hidden = !values.length;
    for (const value of values) {
      const item = document.createElement('li');
      item.textContent = value;
      target.appendChild(item);
    }
  };
  renderStringList(data.wentWell, elements.postmortemWentWell, elements.postmortemWentWellSection);
  renderStringList(data.openQuestions, elements.postmortemQuestions, elements.postmortemQuestionsSection);

  if (elements.postmortemPanel) {
    requestAnimationFrame(() => elements.postmortemPanel.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  updatePostmortemButton();
}

async function requestPostmortem() {
  const incident = currentIncident();
  if (!incident || state.postmortem.loading || meta().postmortemEnabled === false) return;
  if (!state.postmortem.history.length) return;
  const signature = postmortemSignature(incident, state.postmortem.history);
  const cached = state.postmortem.cache.get(signature);
  if (cached) {
    renderPostmortem(cached);
    return;
  }
  if (state.postmortem.controller) state.postmortem.controller.abort();
  const controller = new AbortController();
  state.postmortem.controller = controller;
  state.postmortem.loading = true;
  state.postmortem.signature = signature;
  updatePostmortemButton();
  if (elements.postmortemPanel) elements.postmortemPanel.hidden = false;
  if (elements.postmortemContent) elements.postmortemContent.hidden = true;
  if (elements.postmortemStatus) {
    elements.postmortemStatus.hidden = false;
    elements.postmortemStatus.textContent = 'Собираю постмортем…';
    elements.postmortemStatus.classList.remove('is-error');
  }
  if (elements.postmortemSource) {
    elements.postmortemSource.textContent = '';
    elements.postmortemSource.className = 'postmortem-source';
  }
  try {
    const data = await api('/api/v1/postmortem', {
      method: 'POST',
      body: { caseId: incident.caseId },
      signal: controller.signal
    });
    if (state.activeId !== incident.caseId) return;
    const current = findIncident(incident.caseId);
    if (!current || postmortemSignature(current, state.postmortem.history) !== signature) return;
    state.postmortem.cache.set(signature, data);
    renderPostmortem(data);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (elements.postmortemContent) elements.postmortemContent.hidden = true;
    if (elements.postmortemStatus) {
      elements.postmortemStatus.hidden = false;
      elements.postmortemStatus.textContent = 'Не удалось собрать постмортем: ' + error.message;
      elements.postmortemStatus.classList.add('is-error');
    }
  } finally {
    state.postmortem.loading = false;
    if (state.postmortem.controller === controller) state.postmortem.controller = null;
    updatePostmortemButton();
  }
}

function postmortemMarkdown(data) {
  const incident = currentIncident();
  if (!incident || !data) return '';
  const lines = [];
  lines.push('# Постмортем ' + incident.id);
  lines.push('');
  lines.push('**Источник:** ' + (data.source === 'ai' ? 'ИИ' : 'Фактологический таймлайн'));
  lines.push('**Сформирован:** ' + fullDateTime.format(data.generatedAt || Date.now()));
  lines.push('');
  lines.push('## Что произошло');
  lines.push(data.summary || '');
  lines.push('');
  lines.push('## Таймлайн');
  for (const event of data.timeline || []) {
    lines.push('- ' + fullDateTime.format(event.at) + ' · ' + event.actor + ' — ' + event.event);
  }
  lines.push('');
  lines.push('## Почему');
  if (!data.causes || !data.causes.length) lines.push('- Причины в истории не зафиксированы.');
  for (const cause of data.causes || []) {
    lines.push('- **' + cause.text + '**' + (cause.evidence ? ' — ' + cause.evidence : '') + ' (' + confidenceLabel(cause.confidence) + ')');
  }
  lines.push('');
  lines.push('## Что улучшить');
  if (!data.improvements || !data.improvements.length) lines.push('- Улучшения не предложены.');
  for (const item of data.improvements || []) {
    lines.push('- ' + item.action + (item.owner ? ' — ' + item.owner : '') + ' (' + priorityLabelForRetro(item.priority) + ')');
  }
  if (data.wentWell && data.wentWell.length) {
    lines.push('');
    lines.push('## Что прошло хорошо');
    for (const item of data.wentWell) lines.push('- ' + item);
  }
  if (data.openQuestions && data.openQuestions.length) {
    lines.push('');
    lines.push('## Открытые вопросы');
    for (const item of data.openQuestions) lines.push('- ' + item);
  }
  return lines.join('\n');
}

async function copyPostmortem() {
  const markdown = postmortemMarkdown(state.postmortem.data);
  if (!markdown) return;
  try {
    await navigator.clipboard.writeText(markdown);
    if (elements.postmortemStatus) {
      elements.postmortemStatus.hidden = false;
      elements.postmortemStatus.textContent = 'Скопировано в буфер обмена';
      elements.postmortemStatus.classList.remove('is-error');
    }
    setTimeout(() => {
      if (elements.postmortemStatus && elements.postmortemStatus.textContent === 'Скопировано в буфер обмена') {
        elements.postmortemStatus.hidden = true;
      }
    }, 1800);
  } catch {
    if (elements.postmortemStatus) {
      elements.postmortemStatus.hidden = false;
      elements.postmortemStatus.textContent = 'Не удалось скопировать';
      elements.postmortemStatus.classList.add('is-error');
    }
  }
}

function downloadPostmortem() {
  const markdown = postmortemMarkdown(state.postmortem.data);
  const incident = currentIncident();
  if (!markdown || !incident) return;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'postmortem-' + String(incident.id).replace(/[^a-zA-Z0-9._-]/g, '-') + '.md';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function announce(message, critical = false) {
  const target = critical ? elements.criticalAnnouncer : elements.resultsStatus;
  clearTimeout(state.announcementTimer);
  state.announcementTimer = setTimeout(() => {
    target.textContent = '';
    requestAnimationFrame(() => { target.textContent = message; });
  }, 120);
}

function announceResults(filtered) {
  const uniqueCount = new Set(filtered.map(incident => incident.caseId)).size;
  const suffix = uniqueCount === 1 ? 'инцидент' : uniqueCount > 1 && uniqueCount < 5 ? 'инцидента' : 'инцидентов';
  announce(`По выбранным условиям найдено ${uniqueCount} ${suffix}`);
}

function showToast(title, message, critical = false) {
  clearTimeout(state.toastTimer);
  setText('#toast-title', title);
  setText('#toast-message', message);
  elements.toast.classList.toggle('is-critical', critical);
  elements.toast.querySelector('.toast-icon use').setAttribute('href', critical ? '#i-alert' : '#i-check');
  elements.toast.hidden = false;
  announce(`${title}. ${message}`);
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 5500);
}

/* ------------------------------------------------------------------ dialog */

function dialogBadges(incident) {
  const badges = [];
  const priorityKey = incident.priority === 'critical' ? 'badge-critical' : incident.priority === 'high' ? 'badge-high' : 'badge-neutral';
  badges.push(`<span class="badge ${priorityKey}">${icon(incident.priority === 'critical' ? 'alert' : 'bolt')}${escapeHtml(priorityLabel(incident.priorityId))}</span>`);
  if (incident.prioritySource === 'manual') badges.push(`<span class="badge badge-manual">${icon('bolt')}Ручной приоритет</span>`);
  if (incident.groups.includes('active') && !incident.team) badges.push(`<span class="badge badge-coordination">${icon('forward')}Нет команды</span>`);
  if (incident.groups.includes('research')) badges.push(`<span class="badge badge-research">${icon('check')}Исследование</span>`);
  if (incident.groups.includes('closed')) badges.push(`<span class="badge badge-resolved">${icon('check')}Завершён</span>`);
  return badges.join('');
}

function populateSla(incident) {
  const sla = getSla(incident);
  const progress = slaProgress(incident);
  const panel = document.querySelector('#dialog-sla');
  panel.classList.toggle('is-research', incident.groups.includes('research') || incident.groups.includes('closed'));
  setText('#dialog-sla-label', sla.label);
  const value = document.querySelector('#dialog-sla-value');
  value.dataset.slaId = incident.caseId;
  value.textContent = sla.value;
  value.className = toneClass(sla.tone);
  const bar = document.querySelector('#dialog-sla-bar');
  bar.style.inlineSize = `${progress.pct}%`;
  bar.closest('.sla-track').className = `sla-track ${toneClass(progress.tone)}`;
  setText('#dialog-sla-date', incident.dueAt
    ? `Срок: ${fullDateTime.format(incident.dueAt)}`
    : incident.resolvedAt
      ? `Завершён: ${fullDateTime.format(incident.resolvedAt)}`
      : 'Дедлайн не задан');
}

function sourceSummary(incident) {
  const ids = incident.sourceIds || [];
  const shown = ids.slice(0, 3).join(', ');
  if (ids.length > 3) return `${ids.length} источников · ${shown} …`;
  return `${ids.length} ${plural(ids.length, 'источник', 'источника', 'источников')} · ${shown}`;
}

function populateDetails(incident) {
  setText('#dialog-status', incident.status);
  setText('#dialog-priority', `${incident.priorityText}${incident.prioritySource === 'manual' ? ' · ручной' : ' · авто'}`);
  setText('#dialog-started', incident.startedAt ? `${fullDateTime.format(incident.startedAt)} · ${formatRelative(incident.startedAt)}` : '—');
  setText('#dialog-resolved', incident.resolvedAt ? fullDateTime.format(incident.resolvedAt) : '—');
  setText('#dialog-coordinator', incident.coordinatorName || 'Не назначен');
  setText('#dialog-team', incident.team || 'Не назначена');
  setText('#dialog-sources', sourceSummary(incident));
  const activeAffected = incident.activeAffectedUsers;
  const affectedText = activeAffected !== null && activeAffected !== undefined && activeAffected !== incident.affectedUsers
    ? `${formatNumber(incident.affectedUsers)} (активных: ${formatNumber(activeAffected)})`
    : formatNumber(incident.affectedUsers);
  setText('#dialog-affected', affectedText);
  setText('#dialog-reports', formatNumber(incident.reportCount));
  setText('#dialog-region', incident.region || '—');
}

function toLocalInputValue(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return '';
  const date = new Date(milliseconds);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ensureOption(select, value) {
  if (!select) return;
  if (value === null || value === undefined || value === '') {
    // Сохраняем выбор координатора, ещё не отправленный на сервер, но не оставляем
    // селект без выбранной подписи: пустое значение — это placeholder.
    if (select.selectedIndex < 0) select.selectedIndex = 0;
    return;
  }
  const stringValue = String(value);
  if (![...select.options].some(option => option.value === stringValue)) {
    const option = document.createElement('option');
    option.value = stringValue;
    option.textContent = stringValue;
    select.appendChild(option);
  }
  select.value = stringValue;
}

function updateTakeWorkButton(incident) {
  const button = elements.takeWorkButton;
  if (!button) return;
  const active = incident.groups.includes('active');
  button.hidden = !active;
  const mine = Boolean(state.user) && incident.coordinatorId === state.user.id;
  const performing = incident.stateId === 2;
  button.disabled = mine && performing;
  button.textContent = mine && performing ? 'Инцидент в работе' : 'Взять в работу';
}

function populatePriorityInfo(incident) {
  setText('#priority-auto-value', `Автоматический: ${priorityLabel(incident.autoPriorityId)}`);
  const warning = document.querySelector('#priority-warning');
  const manual = incident.prioritySource === 'manual';
  const differs = manual && incident.priorityOverrideId !== null && incident.priorityOverrideId !== incident.autoPriorityId;
  warning.hidden = !manual;
  warning.textContent = differs ? 'Ручной приоритет отличается от автоматического' : 'Установлен ручной приоритет';
  document.querySelector('#priority-auto-button').hidden = !manual;
  const select = document.querySelector('#priority-select');
  if (document.activeElement !== select) select.value = String(incident.priorityId);
}

function setActionVisibility(incident) {
  const active = incident.groups.includes('active');
  const research = incident.groups.includes('research');
  const canTransition = active || research || incident.stateId === 7;
  document.querySelector('#section-coordinator').hidden = !active;
  document.querySelector('#section-priority').hidden = !active;
  document.querySelector('#section-deadline').hidden = !active;
  document.querySelector('#section-team').hidden = !active;
  document.querySelector('#section-status').hidden = !canTransition;
  document.querySelector('#readonly-note').hidden = canTransition;
}

function populateCoordinatorSelect(incident) {
  const select = document.querySelector('#coordinator-select');
  select.innerHTML = '';
  if (!state.coordinators.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Нет координаторов';
    option.disabled = true;
    select.appendChild(option);
    select.value = '';
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Выберите координатора';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  state.coordinators.forEach(coordinator => {
    const option = document.createElement('option');
    option.value = coordinator.id;
    option.textContent = coordinator.name || coordinator.login;
    select.appendChild(option);
  });
  const current = incident.coordinatorId || '';
  if (current && !state.coordinators.some(coordinator => coordinator.id === current)) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = `${incident.coordinatorName || 'Неизвестный координатор'} (нет в списке)`;
    select.appendChild(option);
  }
  select.value = current;
}

function populateTeamSelect(incident) {
  const select = document.querySelector('#team-select');
  const teams = [...teamOptions()];
  if (incident.team && !teams.includes(incident.team)) teams.unshift(incident.team);
  select.innerHTML = '<option value="" disabled selected>Выберите команду</option>'
    + teams.map(team => `<option value="${escapeHtml(team)}">${escapeHtml(team)}</option>`).join('');
  select.value = incident.team || '';
}

function updateSolutionField(value) {
  const field = document.querySelector('#solution-field');
  const input = document.querySelector('#solution-input');
  const numeric = Number(value);
  if (numeric === 0 || numeric === 2) {
    field.hidden = true;
    input.required = false;
  } else {
    field.hidden = false;
    input.required = numeric === 20;
  }
}

function populateStatusSelect(incident) {
  const select = document.querySelector('#status-select');
  const transitions = transitionsFor(incident.stateId);
  const noTransitions = document.querySelector('#no-transitions');
  const form = document.querySelector('#status-form');
  select.innerHTML = '';
  if (!transitions.length) {
    const option = document.createElement('option');
    option.value = String(incident.stateId);
    option.textContent = stateLabel(incident.stateId);
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    noTransitions.hidden = false;
    form.hidden = true;
    return;
  }
  transitions.forEach(stateId => {
    const option = document.createElement('option');
    option.value = String(stateId);
    option.textContent = stateLabel(stateId);
    select.appendChild(option);
  });
  select.value = String(transitions[0]);
  noTransitions.hidden = true;
  form.hidden = false;
  updateSolutionField(select.value);
}

function resetAiPanel() {
  const label = document.querySelector('#ai-label');
  if (label) {
    label.textContent = 'Не запрошена';
    label.className = 'ai-label';
  }
  const status = document.querySelector('#ai-status');
  if (status) status.hidden = true;
  const summary = document.querySelector('#ai-summary');
  if (summary) summary.textContent = 'Сводка ещё не запрошена';
  const note = document.querySelector('#ai-note');
  if (note) note.hidden = true;
  const recommendation = document.querySelector('#ai-recommendation');
  if (recommendation) recommendation.hidden = true;
  const button = document.querySelector('#ai-button');
  if (button) button.disabled = false;
}

function clearDialogMessages() {
  document.querySelector('#dialog-error').hidden = true;
  document.querySelector('#dialog-success').hidden = true;
}

function populateActions(incident, { resetInputs = false } = {}) {
  setActionVisibility(incident);
  updateTakeWorkButton(incident);
  populatePriorityInfo(incident);
  if (resetInputs) {
    populateCoordinatorSelect(incident);
    populateTeamSelect(incident);
    document.querySelector('#deadline-input').value = incident.dueAt ? toLocalInputValue(incident.dueAt) : '';
    populateStatusSelect(incident);
    state.dialogStateId = incident.stateId;
    state.dialogDueAt = incident.dueAt ?? null;
    return;
  }
  if (state.dialogStateId !== incident.stateId) {
    populateStatusSelect(incident);
    state.dialogStateId = incident.stateId;
  }
  if (document.activeElement !== document.querySelector('#coordinator-select')) {
    ensureOption(document.querySelector('#coordinator-select'), incident.coordinatorId || '');
  }
  if (document.activeElement !== document.querySelector('#team-select')) {
    ensureOption(document.querySelector('#team-select'), incident.team || '');
  }
  if (document.activeElement !== document.querySelector('#deadline-input') && (incident.dueAt ?? null) !== state.dialogDueAt) {
    document.querySelector('#deadline-input').value = incident.dueAt ? toLocalInputValue(incident.dueAt) : '';
    state.dialogDueAt = incident.dueAt ?? null;
  }
}

function populateDialog(incident, { resetInputs = false } = {}) {
  setText('#dialog-id', incident.id);
  setText('#dialog-title', incident.title);
  setText('#dialog-product', [incident.product, incident.service, incident.scenario].filter(Boolean).join(' · '));
  setText('#dialog-description', incident.description || 'Описание отсутствует');
  document.querySelector('#dialog-badges').innerHTML = dialogBadges(incident);
  populateSla(incident);
  populateDetails(incident);
  renderTriageCaseBlock(incident);
  populateActions(incident, { resetInputs });
  document.querySelector('#itsm-link').href = itsmUrl(incident);
  if (resetInputs) {
    resetAiPanel();
    resetRoutingSuggestion({ abort: true });
    resetPostmortem({ abort: true, clearHistory: true });
    clearDialogMessages();
    document.querySelector('#solution-input').value = '';
  }
  requestRoutingSuggestion(incident);
  updatePostmortemButton();
}

function openIncident(caseId) {
  const incident = findIncident(caseId);
  if (!incident) return;
  if (state.routing.queueOpen) closeRoutingPanel();
  state.activeId = caseId;
  state.lastOpenedCaseId = caseId;
  populateDialog(incident, { resetInputs: true });
  if (!elements.dialog.open) elements.dialog.showModal();
  document.querySelector('#dialog-title').focus();
  loadHistory(caseId);
}

function currentIncident() {
  return state.activeId ? findIncident(state.activeId) : null;
}

function setDialogBusy(busy) {
  document.querySelectorAll('#incident-actions button').forEach(button => {
    button.disabled = busy;
  });
  if (!busy) {
    const incident = currentIncident();
    if (incident) updateTakeWorkButton(incident);
  }
}

function showDialogSuccess(action) {
  const messages = {
    claim: 'Вы взяли инцидент в координацию',
    reassign: 'Координатор изменён',
    coordinator: 'Координатор изменён',
    priority: 'Приоритет сохранён',
    'priority-override': 'Возврат к автоматическому приоритету',
    deadline: 'Срок SLA обновлён',
    team: 'Команда назначена',
    status: 'Статус применён'
  };
  const success = document.querySelector('#dialog-success');
  success.textContent = messages[action] || 'Изменение сохранено';
  success.hidden = false;
  document.querySelector('#dialog-error').hidden = true;
}

function showDialogError(error) {
  const dialogError = document.querySelector('#dialog-error');
  dialogError.textContent = error.message;
  dialogError.hidden = false;
  document.querySelector('#dialog-success').hidden = true;
}

async function loadHistory(caseId) {
  const list = document.querySelector('#history-list');
  if (!list) return;
  list.innerHTML = '<li class="history-empty">Загрузка истории…</li>';
  try {
    const data = await api(`/api/v1/incidents/${encodeURIComponent(caseId)}/history`);
    const history = Array.isArray(data.history) ? data.history : [];
    state.postmortem.caseId = caseId;
    state.postmortem.history = history;
    const incident = findIncident(caseId);
    const signature = postmortemSignature(incident, history);
    if (state.postmortem.data && state.postmortem.signature !== signature) {
      resetPostmortem({ abort: true });
    }
    updatePostmortemButton();
    renderHistory(history);
  } catch (error) {
    if (error.status === 401) { handleUnauthorized(); return; }
    state.postmortem.history = [];
    if (state.postmortem.data) resetPostmortem({ abort: true });
    updatePostmortemButton();
    list.innerHTML = `<li class="history-empty">Не удалось загрузить историю: ${escapeHtml(error.message)}</li>`;
  }
}

function formatHistoryDetails(item) {
  const details = item.details || {};
  switch (item.action) {
    case 'claim':
    case 'reassign':
      return details.coordinatorName ? `→ ${escapeHtml(details.coordinatorName)}` : '';
    case 'priority':
      return escapeHtml(priorityLabel(details.priorityId));
    case 'priority-override.delete':
      return 'Возврат к автоприоритету';
    case 'deadline':
      return details.deadline ? `→ ${fullDateTime.format(details.deadline)}` : 'Срок снят';
    case 'team':
      return details.team ? `→ ${escapeHtml(details.team)}` : '';
    case 'status': {
      const status = stateLabel(details.stateId);
      const solution = details.solution ? ` · ${escapeHtml(details.solution)}` : '';
      return `→ ${escapeHtml(status)}${solution}`;
    }
    default:
      return '';
  }
}

function renderHistory(history) {
  const list = document.querySelector('#history-list');
  if (!history.length) {
    list.innerHTML = '<li class="history-empty">История изменений пуста</li>';
    return;
  }
  list.innerHTML = history.map(item => {
    const label = ACTION_LABELS[item.action] || item.action;
    const details = formatHistoryDetails(item);
    return `<li>
      <div class="history-head"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(item.userName || 'Система')}</span></div>
      ${details ? '<p class="history-details">' + details + '</p>' : ''}
      <time>${dateTime.format(item.createdAt)}</time>
    </li>`;
  }).join('');
}

/* ---------------------------------------------------------------------- ai */

function isFallback(data) {
  return Boolean(data && (data.fallback === true || data.label === 'fallback' || data.source === 'fallback'));
}

function renderAiResult(data) {
  const text = data.summary ?? data.text ?? data.aiSummary ?? data.content ?? '';
  document.querySelector('#ai-summary').textContent = text || 'Сводка пуста';
  const recommendationText = data.recommendation ?? data.action ?? data.advice
    ?? data.team ?? data.aiTeam ?? data.recommendedTeam ?? null;
  const rawAttentions = data.attentions ?? data.attention ?? data.reason ?? data.aiReason ?? null;
  const attentionText = Array.isArray(rawAttentions)
    ? rawAttentions.map(item => {
        if (item && typeof item === 'object') return String(item.summary ?? item.text ?? item.label ?? item);
        return String(item);
      }).filter(item => item.trim()).join(' • ')
    : (rawAttentions ? String(rawAttentions) : null);
  const recommendation = document.querySelector('#ai-recommendation');
  if (recommendationText || attentionText) {
    document.querySelector('#ai-team').textContent = recommendationText || '—';
    document.querySelector('#ai-reason').textContent = attentionText || '';
    recommendation.hidden = false;
  } else {
    recommendation.hidden = true;
  }
  const note = document.querySelector('#ai-note');
  if (note) {
    const reason = data.reason && typeof data.reason === 'object' ? data.reason : null;
    if (isFallback(data)) {
      note.hidden = false;
      note.textContent = reason && reason.message
        ? `ИИ недоступен, показана автоматическая сводка: ${reason.message}`
        : 'ИИ недоступен, показана автоматическая сводка.';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }
}

async function requestAiSummary(caseId) {
  const button = document.querySelector('#ai-button');
  const status = document.querySelector('#ai-status');
  const label = document.querySelector('#ai-label');
  const note = document.querySelector('#ai-note');
  if (button) button.disabled = true;
  if (status) {
    status.hidden = false;
    status.textContent = 'Формируем сводку…';
  }
  if (note) note.hidden = true;
  if (label) {
    label.textContent = 'Загружается';
    label.className = 'ai-label is-loading';
  }
  try {
    const data = await api('/api/v1/ai/summary', { method: 'POST', body: caseId ? { caseId } : {} });
    renderAiResult(data);
    if (status) status.hidden = true;
    if (label) {
      if (isFallback(data)) {
        label.textContent = 'Автоматическая сводка';
        label.className = 'ai-label is-fallback';
      } else {
        label.textContent = 'ИИ-сводка';
        label.className = 'ai-label';
      }
    }
  } catch (error) {
    if (error.status === 401) { handleUnauthorized(); return; }
    if (status) {
      status.hidden = false;
      status.textContent = `Не удалось получить сводку: ${error.message}`;
    }
    if (label) {
      label.textContent = 'Ошибка';
      label.className = 'ai-label is-error';
    }
    document.querySelector('#ai-summary').textContent = 'Сводка недоступна';
    document.querySelector('#ai-recommendation').hidden = true;
  } finally {
    if (button) button.disabled = false;
  }
}

/* ----------------------------------------------------------------- actions */

async function performAction(incident, action, body, method = 'POST') {
  const path = action === 'priority-override'
    ? `/api/v1/incidents/${encodeURIComponent(incident.caseId)}/priority-override`
    : `/api/v1/incidents/${encodeURIComponent(incident.caseId)}/${action}`;
  const payload = method === 'DELETE' ? undefined : { ...(body || {}), expectedVersion: incident.version };
  setDialogBusy(true);
  clearDialogMessages();
  let success = false;
  try {
    noteLocalChange();
    await api(path, { method, body: payload });
    await queueRefresh({ notify: false });
    showDialogSuccess(action);
    await loadHistory(incident.caseId);
    success = true;
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
    } else {
      showDialogError(error);
      if (error.status === 409 || error.status === 400) await queueRefresh({ notify: false });
    }
  } finally {
    setDialogBusy(false);
  }
  return success;
}

async function submitReassign(event) {
  event.preventDefault();
  const incident = currentIncident();
  if (!incident) return;
  const coordinatorId = document.querySelector('#coordinator-select').value;
  if (!coordinatorId) {
    clearDialogMessages();
    showDialogError(new Error('Выберите координатора, чтобы передать инцидент'));
    return;
  }
  await performAction(incident, 'coordinator', { coordinatorId });
}

async function submitPriority(event) {
  event.preventDefault();
  const incident = currentIncident();
  if (!incident) return;
  const success = await performAction(incident, 'priority', { priorityId: Number(document.querySelector('#priority-select').value) });
  if (!success) return;
  elements.dialog.close();
  showToast('Приоритет сохранён', incident.id);
}

async function submitDeadline(event) {
  event.preventDefault();
  const incident = currentIncident();
  if (!incident) return;
  const value = document.querySelector('#deadline-input').value;
  if (!value) return;
  await performAction(incident, 'deadline', { deadline: new Date(value).toISOString() });
}

async function submitTeam(event) {
  event.preventDefault();
  const incident = currentIncident();
  if (!incident) return;
  const team = document.querySelector('#team-select').value;
  if (!team) {
    clearDialogMessages();
    showDialogError(new Error('Выберите команду, чтобы назначить её инциденту'));
    return;
  }
  const success = await performAction(incident, 'team', { team });
  if (!success) return;
  elements.dialog.close();
  showToast('Команда назначена', incident.id);
}

async function submitStatus(event) {
  event.preventDefault();
  const incident = currentIncident();
  if (!incident) return;
  const stateId = Number(document.querySelector('#status-select').value);
  const solution = document.querySelector('#solution-input').value.trim() || null;
  await performAction(incident, 'status', { stateId, solution });
}

async function takeIncidentToWork() {
  const incident = currentIncident();
  if (!incident || !incident.groups.includes('active')) return;
  const mine = Boolean(state.user) && incident.coordinatorId === state.user.id;
  if (!mine) {
    const claimed = await performAction(incident, 'claim', {});
    if (!claimed) return;
  }
  const updated = currentIncident();
  if (!updated) return;
  if (updated.stateId !== 2 && transitionsFor(updated.stateId).includes(2)) {
    const moved = await performAction(updated, 'status', { stateId: 2, solution: null });
    if (!moved) return;
  }
  const finalIncident = currentIncident() || updated;
  showToast(
    finalIncident.stateId === 2 ? 'Взято в работу' : 'Инцидент взят в координацию',
    finalIncident.id,
    false
  );
}

async function clearPriorityOverride() {
  const incident = currentIncident();
  if (!incident) return;
  await performAction(incident, 'priority-override', undefined, 'DELETE');
}

function setSyncing(value) {
  state.syncing = value;
  elements.syncButton.disabled = value;
  elements.syncButton.classList.toggle('is-refreshing', value);
  renderSyncState();
}

async function syncNow() {
  if (state.syncing) return;
  setSyncing(true);
  const before = state.incidents;
  let result = null;
  let error = null;
  try {
    result = await api('/api/v1/sync/itsm', { method: 'POST' });
  } catch (caught) {
    error = caught;
  }
  noteLocalChange();
  await queueRefresh({ notify: false });
  if (error) {
    showToast('Ошибка синхронизации', error.message, true);
  } else {
    const added = result ? result.added ?? 0 : 0;
    const updated = result ? result.updated ?? 0 : 0;
    if (added || updated) {
      showToast('Синхронизация завершена', `Добавлено ${added} · обновлено ${updated}`);
      detectChanges(before, state.incidents);
    } else {
      showToast('Данные актуальны', 'Изменений в ITSM не найдено');
    }
  }
  setSyncing(false);
}

function applyFilters() {
  render();
  const active = state.filters.archive
    ? state.incidents.filter(incident => incident.groups.includes('closed'))
    : state.incidents.filter(incident => !incident.groups.includes('closed'));
  announceResults(getFilteredIncidents(active, { applyRisk: !state.filters.archive }));
}

/* ------------------------------------------------------------------ admin */

function adminSetError(message, { system = false } = {}) {
  const element = document.querySelector(system ? '#admin-system-error' : '#admin-error');
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || '';
}

function adminSetSuccess(message) {
  const element = document.querySelector('#admin-success');
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || '';
}

function adminDate(timestamp) {
  return timestamp ? fullDateTime.format(timestamp) : '—';
}

async function loadAdminUsers() {
  const data = await api('/api/v1/admin/users');
  state.admin.users = Array.isArray(data.users) ? data.users : [];
  renderAdminUsers();
}

function renderAdminUsers() {
  const list = document.querySelector('#admin-user-list');
  if (!list) return;
  setText('#admin-user-count', state.admin.users.length);
  if (!state.admin.users.length) {
    list.innerHTML = '<li class="empty-state">Пользователей нет</li>';
    return;
  }
  list.innerHTML = state.admin.users.map(user => {
    const isSelf = state.user && user.id === state.user.id;
    const isAdmin = user.role === 'admin';
    const initial = (user.name || user.login || '?').trim().charAt(0).toUpperCase();
    const sessionCount = Number(user.sessionCount) || 0;
    const sessions = `${sessionCount} ${plural(sessionCount, 'сессия', 'сессии', 'сессий')}`;
    return `<li class="admin-user" data-user-id="${escapeHtml(user.id)}">
      <span class="avatar" aria-hidden="true">${escapeHtml(initial)}</span>
      <div class="admin-user-main">
        <strong>${escapeHtml(user.name)}${isSelf ? ' · вы' : ''}</strong>
        <span>${escapeHtml(user.login)} · создан ${adminDate(user.createdAt)}</span>
      </div>
      ${isAdmin ? '<span class="role-badge">админ</span>' : '<span class="badge">координатор</span>'}
      <span class="admin-sessions">${sessions}</span>
      <div class="admin-user-actions">
        <button class="button button-secondary button-sm" type="button" data-admin-action="role" data-user-id="${escapeHtml(user.id)}" data-role="${user.role}" ${isSelf && isAdmin ? 'disabled title="Нельзя снять права с себя"' : ''}>${isAdmin ? 'Сделать координатором' : 'Назначить админом'}</button>
        <button class="button button-secondary button-sm" type="button" data-admin-action="logout" data-user-id="${escapeHtml(user.id)}">Завершить сессии</button>
        <button class="button button-danger button-sm" type="button" data-admin-action="delete" data-user-id="${escapeHtml(user.id)}" data-confirm="0" data-label="Удалить" ${isSelf ? 'disabled title="Нельзя удалить собственную учётную запись"' : ''}>Удалить</button>
      </div>
    </li>`;
  }).join('');
}

async function loadAdminSystem() {
  const data = await api('/api/v1/admin/system');
  state.admin.system = data;
  renderAdminSystem(data);
}

function adminStatRow(label, value, className = '') {
  return `<div><dt>${escapeHtml(label)}</dt><dd class="${className}">${value}</dd></div>`;
}

function renderAdminSystem(data) {
  const list = document.querySelector('#admin-system');
  if (!list) return;
  const counts = data.counts || {};
  list.innerHTML = [
    adminStatRow('Версия ITSM', escapeHtml(String(data.revision ?? '—'))),
    adminStatRow('Последняя синхронизация', escapeHtml(adminDate(data.lastSyncedAt))),
    adminStatRow('Ошибка синхронизации', escapeHtml(data.syncError || 'нет'), data.syncError ? 'is-bad' : 'is-good'),
    adminStatRow('ITSM mock', data.mockReachable ? 'доступен' : 'недоступен', data.mockReachable ? 'is-good' : 'is-bad'),
    adminStatRow('Активных кейсов', escapeHtml(String(counts.active ?? 0))),
    adminStatRow('Критических', escapeHtml(String(counts.critical ?? 0))),
    adminStatRow('На координации', escapeHtml(String(counts.coordination ?? 0))),
    adminStatRow('Исследование', escapeHtml(String(counts.research ?? 0))),
    adminStatRow('Пользователей', escapeHtml(String(data.users ?? 0))),
    adminStatRow('Сессий', escapeHtml(String(data.sessions ?? 0))),
    adminStatRow('Uptime', escapeHtml(formatUptime(data.uptimeMs)))
  ].join('');
}

async function loadAdminAudit() {
  const data = await api('/api/v1/admin/audit?limit=50');
  state.admin.audit = Array.isArray(data.audit) ? data.audit : [];
  renderAdminAudit();
}

function renderAdminAudit() {
  const list = document.querySelector('#admin-audit-list');
  if (!list) return;
  if (!state.admin.audit.length) {
    list.innerHTML = '<li class="empty-state">Журнал пуст</li>';
    return;
  }
  list.innerHTML = state.admin.audit.map(item => {
    const label = ADMIN_ACTION_LABELS[item.action] || item.action;
    const target = [item.targetType, item.targetId].filter(Boolean).join(' ');
    return `<li>
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(item.userName || 'Система')}${target ? ' → ' + escapeHtml(target) : ''}</span>
      <time>${dateTime.format(item.createdAt)}</time>
    </li>`;
  }).join('');
}

function switchAdminTab(name) {
  state.admin.tab = name;
  document.querySelectorAll('.admin-tab').forEach(tab => {
    const active = tab.dataset.adminTab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-admin-panel]').forEach(panel => {
    panel.hidden = panel.dataset.adminPanel !== name;
  });
  adminSetError('');
  adminSetSuccess('');
  if (name === 'users') loadAdminUsers().catch(error => adminSetError(error.message));
  if (name === 'system') loadAdminSystem().catch(error => adminSetError(error.message, { system: true }));
  if (name === 'audit') loadAdminAudit().catch(error => showToast('Журнал недоступен', error.message, true));
}

function openAdmin() {
  if (!state.user || state.user.role !== 'admin') return;
  adminSetError('');
  adminSetSuccess('');
  switchAdminTab('users');
  if (!elements.adminDialog.open) elements.adminDialog.showModal();
}

async function onAdminUserAction(event) {
  const button = event.target.closest('button[data-admin-action]');
  if (!button) return;
  const userId = button.dataset.userId;
  const user = state.admin.users.find(item => item.id === userId);
  if (!user) return;
  const action = button.dataset.adminAction;

  if (action === 'delete') {
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.textContent = 'Точно удалить?';
      clearTimeout(state.admin.confirmTimer);
      state.admin.confirmTimer = setTimeout(() => {
        if (button.isConnected) {
          button.dataset.confirm = '0';
          button.textContent = 'Удалить';
        }
      }, 4000);
      return;
    }
    button.disabled = true;
    try {
      await api(`/api/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      adminSetSuccess(`Пользователь ${user.login} удалён`);
      showToast('Пользователь удалён', user.login);
      await Promise.all([loadAdminUsers(), loadCoordinators()]);
    } catch (error) {
      adminSetError(error.message);
      button.disabled = false;
    }
    return;
  }

  if (action === 'role') {
    const nextRole = user.role === 'admin' ? 'coordinator' : 'admin';
    button.disabled = true;
    try {
      const data = await api(`/api/v1/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PATCH', body: { role: nextRole } });
      adminSetSuccess(`Роль ${user.login} изменена: ${nextRole === 'admin' ? 'администратор' : 'координатор'}`);
      if (state.user && state.user.id === userId) {
        state.user.role = data.user.role;
        setUser(state.user);
        if (data.user.role !== 'admin') {
          elements.adminDialog.close();
          return;
        }
      }
      await loadAdminUsers();
    } catch (error) {
      adminSetError(error.message);
      button.disabled = false;
    }
    return;
  }

  if (action === 'logout') {
    button.disabled = true;
    try {
      const data = await api(`/api/v1/admin/users/${encodeURIComponent(userId)}/logout`, { method: 'POST' });
      adminSetSuccess(`Сессии ${user.login} завершены: ${data.removedSessions ?? 0}`);
      await loadAdminUsers();
    } catch (error) {
      adminSetError(error.message);
      button.disabled = false;
    }
  }
}

async function onAdminReset() {
  const button = document.querySelector('#admin-reset');
  if (!button) return;
  if (button.dataset.confirm !== '1') {
    button.dataset.confirm = '1';
    button.textContent = 'Подтвердить сброс?';
    clearTimeout(state.admin.confirmTimer);
    state.admin.confirmTimer = setTimeout(() => {
      if (button.isConnected) {
        button.dataset.confirm = '0';
        button.textContent = 'Сбросить демо';
      }
    }, 4000);
    return;
  }
  button.dataset.confirm = '0';
  button.textContent = 'Сбросить демо';
  button.disabled = true;
  try {
    await api('/api/v1/admin/demo/reset', { method: 'POST' });
    await queueRefresh({ notify: false });
    await loadAdminSystem();
    adminSetSuccess('Демо-данные сброшены, локальные кейсы очищены.');
    showToast('Демо сброшено', 'Эмулятор и локальные кейсы очищены');
  } catch (error) {
    adminSetError(error.message, { system: true });
    showToast('Ошибка сброса', error.message, true);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------- auth */

function setFieldError(input, hasError) {
  const field = input.closest('.field');
  if (!field) return;
  input.setAttribute('aria-invalid', String(hasError));
  field.classList.toggle('has-error', hasError);
}

function validateForm(form) {
  const inputs = [...form.querySelectorAll('input[required], select[required]')];
  let firstInvalid = null;
  inputs.forEach(input => {
    const invalid = !input.value.trim();
    setFieldError(input, invalid);
    if (invalid && !firstInvalid) firstInvalid = input;
  });
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}

async function handleAuthSubmit(kind, form, errorSelector) {
  const formError = document.querySelector(errorSelector);
  formError.hidden = true;
  document.querySelector('#auth-global-error').hidden = true;
  if (!validateForm(form)) return;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(form).entries());
    const data = await api(`/api/v1/auth/${kind}`, { method: 'POST', body: fields });
    setUser(data.user);
    await enterDashboard();
  } catch (error) {
    formError.textContent = error.message;
    formError.hidden = false;
    formError.focus();
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  try {
    await api('/api/v1/auth/logout', { method: 'POST' });
  } catch {
    // Session invalidation is best-effort.
  }
  closeEvents();
  setUser(null);
  resetNotifications();
  resetTriage();
  state.incidents = [];
  state.counts = null;
  state.lastSyncedAt = null;
  state.syncError = null;
  state.filters = { search: '', product: 'all', riskOnly: false, unassigned: false, archive: false };
  elements.search.value = '';
  elements.product.value = 'all';
  elements.risk.checked = false;
  elements.coordinator.checked = false;
  resetAssistantUi();
  resetRoutingUi();
  resetPostmortem({ abort: true, clearHistory: true, clearCache: true });
  if (elements.adminDialog.open) elements.adminDialog.close();
  showView('auth');
}

/* ------------------------------------------------------------------- bind */

function bindEvents() {
  document.querySelector('#show-login').addEventListener('click', () => {
    document.querySelector('#login-form').hidden = false;
    document.querySelector('#register-form').hidden = true;
    document.querySelector('#show-login').setAttribute('aria-pressed', 'true');
    document.querySelector('#show-register').setAttribute('aria-pressed', 'false');
  });
  document.querySelector('#show-register').addEventListener('click', () => {
    document.querySelector('#login-form').hidden = true;
    document.querySelector('#register-form').hidden = false;
    document.querySelector('#show-login').setAttribute('aria-pressed', 'false');
    document.querySelector('#show-register').setAttribute('aria-pressed', 'true');
  });

  document.querySelector('#login-form').addEventListener('submit', event => {
    event.preventDefault();
    handleAuthSubmit('login', event.currentTarget, '#login-form-error');
  });
  document.querySelector('#register-form').addEventListener('submit', event => {
    event.preventDefault();
    handleAuthSubmit('register', event.currentTarget, '#register-form-error');
  });
  document.querySelector('#logout-button').addEventListener('click', logout);
  document.querySelector('#theme-toggle').addEventListener('click', toggleTheme);
  document.querySelector('#admin-button').addEventListener('click', openAdmin);
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => switchAdminTab(tab.dataset.adminTab));
  });
  document.querySelector('#admin-users-refresh').addEventListener('click', () => {
    adminSetError('');
    loadAdminUsers().catch(error => adminSetError(error.message));
  });
  document.querySelector('#admin-audit-refresh').addEventListener('click', () => {
    loadAdminAudit().catch(error => showToast('Журнал недоступен', error.message, true));
  });
  document.querySelector('#admin-user-list').addEventListener('click', onAdminUserAction);
  document.querySelector('#admin-sync').addEventListener('click', async () => {
    await syncNow();
    loadAdminSystem().catch(() => {});
  });
  document.querySelector('#admin-reset').addEventListener('click', onAdminReset);

  elements.search.addEventListener('input', event => {
    state.filters.search = event.target.value;
    applyFilters();
  });
  elements.product.addEventListener('change', event => {
    state.filters.product = event.target.value;
    applyFilters();
  });
  elements.risk.addEventListener('change', event => {
    state.filters.riskOnly = event.target.checked;
    applyFilters();
  });
  elements.coordinator.addEventListener('change', event => {
    state.filters.unassigned = event.target.checked;
    applyFilters();
  });
  elements.reset.addEventListener('click', () => {
    state.filters.search = '';
    state.filters.product = 'all';
    state.filters.riskOnly = false;
    state.filters.unassigned = false;
    elements.search.value = '';
    elements.product.value = 'all';
    elements.risk.checked = false;
    elements.coordinator.checked = false;
    applyFilters();
    elements.search.focus();
  });
  elements.archiveButton.addEventListener('click', () => {
    state.filters.archive = !state.filters.archive;
    render();
    announce(state.filters.archive ? 'Показан архив завершённых инцидентов.' : 'Показан живой список инцидентов.');
  });
  elements.syncButton.addEventListener('click', syncNow);
  document.querySelector('#live-status').addEventListener('click', toggleLive);

  elements.notificationBell.addEventListener('click', toggleNotificationPanel);
  elements.notificationReadAll.addEventListener('click', markAllNotificationsRead);
  elements.notificationList.addEventListener('click', onNotificationClick);

  elements.triageChip.addEventListener('click', toggleTriagePanel);
  elements.triageClose.addEventListener('click', () => closeTriagePanel());
  elements.triageList.addEventListener('click', onTriageActionClick);
  elements.triageCaseList.addEventListener('click', onTriageActionClick);
  elements.triageFocusClear.addEventListener('click', () => {
    state.triage.focusCaseId = null;
    renderTriagePanel();
  });
  elements.triageCaseOpen.addEventListener('click', () => {
    if (state.activeId) openTriagePanel({ caseId: state.activeId });
  });
  elements.takeWorkButton.addEventListener('click', takeIncidentToWork);
  elements.mergeOptions.addEventListener('change', onMergeTargetChange);
  elements.mergeConfirm.addEventListener('click', confirmTriageMerge);
  elements.mergeCancel.addEventListener('click', () => closeMergeDialog());
  elements.mergeClose.addEventListener('click', () => closeMergeDialog());
  elements.mergeDialog.addEventListener('close', () => { state.triage.merge = null; });

  document.addEventListener('click', event => {
    if (state.notifications.open && !event.target.closest('#notification-bell-wrap')) closeNotificationPanel();
    const trigger = event.target.closest('[data-open-incident]');
    if (trigger) openIncident(trigger.dataset.openIncident);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || elements.dialog.open) return;
    if (event.target.matches('input, select, textarea')) return;
    event.preventDefault();
    elements.search.focus();
  });

  document.querySelector('#banner-close').addEventListener('click', () => {
    state.bannerDismissed = true;
    elements.banner.hidden = true;
    announce('Уведомление скрыто. Критический инцидент остаётся в группе критических.');
  });
  document.querySelector('#toast-close').addEventListener('click', () => {
    clearTimeout(state.toastTimer);
    elements.toast.hidden = true;
  });

  document.querySelector('#reassign-form').addEventListener('submit', submitReassign);
  document.querySelector('#priority-form').addEventListener('submit', submitPriority);
  document.querySelector('#priority-auto-button').addEventListener('click', clearPriorityOverride);
  document.querySelector('#deadline-form').addEventListener('submit', submitDeadline);
  document.querySelector('#team-form').addEventListener('submit', submitTeam);
  document.querySelector('#status-form').addEventListener('submit', submitStatus);
  document.querySelector('#status-select').addEventListener('change', event => updateSolutionField(event.target.value));
  document.querySelector('#history-refresh').addEventListener('click', () => {
    if (state.activeId) loadHistory(state.activeId);
  });
  document.querySelector('#ai-button').addEventListener('click', () => {
    if (state.activeId) requestAiSummary(state.activeId);
  });

  elements.assistantButton.addEventListener('click', () => {
    if (state.assistant.open) closeAssistant();
    else openAssistant();
  });
  elements.assistantClose.addEventListener('click', () => {
    closeAssistant();
    elements.assistantButton.focus();
  });
  elements.assistantForm.addEventListener('submit', event => {
    event.preventDefault();
    sendAssistant(elements.assistantInput.value);
  });
  elements.assistantLog.addEventListener('click', event => {
    const suggestion = event.target.closest('[data-assistant-suggestion]');
    if (!suggestion) return;
    elements.assistantInput.value = suggestion.dataset.assistantSuggestion;
    sendAssistant(suggestion.dataset.assistantSuggestion);
  });
  elements.assistantFilterClear.addEventListener('click', clearAssistantFilter);
  elements.routingAccept.addEventListener('click', acceptRoutingSuggestion);
  elements.routingOther.addEventListener('click', focusTeamSelect);
  elements.routingQueueButton.addEventListener('click', () => {
    if (state.routing.queueOpen) closeRoutingPanel();
    else openRoutingPanel();
  });
  elements.routingClose.addEventListener('click', () => {
    closeRoutingPanel();
    elements.routingQueueButton.focus();
  });
  document.querySelector('#in-progress-jump').addEventListener('click', jumpToInProgress);
  document.querySelector('#in-progress-fab').addEventListener('click', jumpToInProgress);
  setupInProgressObserver();
  if (!state.inProgress.observer) {
    window.addEventListener('scroll', updateInProgressFab, { passive: true });
    window.addEventListener('resize', updateInProgressFab);
  }
  elements.postmortemButton.addEventListener('click', requestPostmortem);
  elements.postmortemClose.addEventListener('click', closePostmortem);
  elements.postmortemCopy.addEventListener('click', copyPostmortem);
  elements.postmortemDownload.addEventListener('click', downloadPostmortem);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      if (elements.dialog.open || (elements.adminDialog && elements.adminDialog.open) || triageModalOpen()) return;
      event.preventDefault();
      openAssistant();
      return;
    }
    if (event.key === 'Escape' && state.triage.open && !elements.dialog.open && !triageModalOpen()) {
      closeTriagePanel();
      return;
    }
    if (event.key === 'Escape' && state.notifications.open && !triageModalOpen()) {
      closeNotificationPanel();
      elements.notificationBell.focus();
      return;
    }
    if (event.key === 'Escape' && state.routing.queueOpen && !elements.dialog.open && !(elements.adminDialog && elements.adminDialog.open) && !triageModalOpen()) {
      closeRoutingPanel();
      elements.routingQueueButton.focus();
      return;
    }
    if (event.key === 'Escape' && state.assistant.open && !elements.dialog.open && !(elements.adminDialog && elements.adminDialog.open) && !triageModalOpen()) {
      closeAssistant();
      elements.assistantButton.focus();
    }
  });

  elements.dialog.addEventListener('close', () => {
    resetRoutingSuggestion({ abort: true });
    closePostmortem();
    state.activeId = null;
    const buttons = state.lastOpenedCaseId
      ? [...document.querySelectorAll(`[data-open-incident="${CSS.escape(state.lastOpenedCaseId)}"]`)]
      : [];
    const target = buttons.find(button => button.offsetParent !== null) || buttons[0];
    if (target) target.focus();
  });

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (event, dialog) => {
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    let pressedOutside = false;
    elements.dialog.addEventListener('pointerdown', event => {
      pressedOutside = outside(event, elements.dialog);
    });
    elements.dialog.addEventListener('pointerup', event => {
      if (pressedOutside && outside(event, elements.dialog)) elements.dialog.close();
    });
  }
}

bindEvents();
applyTheme(currentTheme(), { persist: false });
renderClock();
renderLive();
setInterval(renderClock, 1000);
setInterval(updateCountdowns, 1000);
bootstrap();
