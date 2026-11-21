'use strict';

(function () {
  const WALLBOARD_URL = '/api/v1/wallboard';
  const EVENTS_URL = '/wall/events';
  const REFRESH_MS = 30000;
  const POLL_MS = 8000;
  const SSE_RETRY_MS = 30000;
  const SSE_WATCHDOG_MS = 20000;
  const FETCH_TIMEOUT_MS = 8000;
  const ROTATION_MS = 24000;
  const MAX_CRITICAL = 7;
  const MAX_ROWS = 6;
  const MAX_AGG = 6;
  const MAX_RECENT = 8;
  const MAX_FEED = 8;
  const MINUTE = 60 * 1000;

  const PHASES = [
    { id: 'overview', label: 'Обзор' },
    { id: 'critical', label: 'Критические' },
    { id: 'sla', label: 'SLA' },
    { id: 'teams', label: 'Команды' }
  ];

  const PRIORITY_LABELS = { 4: 'Наивысший', 3: 'Высокий', 2: 'Средний', 1: 'Низкий' };
  const PRIORITY_KEYS = { 4: 'critical', 3: 'high', 2: 'medium', 1: 'low' };
  const STATE_LABELS = { 0: 'Назначен', 2: 'Выполняется', 20: 'Исследование', 7: 'Завершен', 10: 'Закрыт' };
  const STATE_KEYS = { 0: 'assigned', 2: 'progress', 20: 'research', 7: 'done', 10: 'closed' };
  const LIVE_LABELS = {
    connecting: 'подключение…',
    live: 'LIVE',
    reconnecting: 'переподключение…',
    polling: 'резервный режим',
    offline: 'нет связи'
  };
  const LIVE_TITLES = {
    connecting: 'Устанавливаем соединение с сервером',
    live: 'Поток SSE активен, данные обновляются в реальном времени',
    reconnecting: 'SSE переподключается, на экране последние полученные данные',
    polling: 'SSE недоступен — резервное обновление через API',
    offline: 'Нет связи с сервером, показаны последние полученные данные'
  };
  const UNASSIGNED_LABEL = 'Без команды';

  const numberFormatter = new Intl.NumberFormat('ru-RU');
  const hmFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const hmsFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });

  const els = {};
  const state = {
    data: null,
    sse: null,
    sseOpen: false,
    sseFailures: 0,
    sseWatchdog: null,
    pollTimer: null,
    sseRetryTimer: null,
    refreshTimer: null,
    debounceTimer: null,
    fetchInFlight: false,
    fetchFailures: 0,
    lastSuccessAt: 0,
    systemEvents: [],
    feedSeenAt: Date.now(),
    phaseIndex: 0,
    phaseStartedAt: 0,
    rotationPaused: false,
    focusPinned: false,
    lastErrorNotified: false,
    lastSyncError: null
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    els.summary = byId('summary');
    els.criticalList = byId('critical-list');
    els.criticalCount = byId('critical-count');
    els.criticalNote = byId('critical-note');
    els.criticalSummary = byId('critical-summary');
    els.teamsList = byId('teams-list');
    els.teamsCount = byId('teams-count');
    els.slaList = byId('sla-list');
    els.slaCount = byId('sla-count');
    els.recentList = byId('recent-list');
    els.recentCount = byId('recent-count');
    els.unassignedList = byId('unassigned-list');
    els.unassignedCount = byId('unassigned-count');
    els.productsList = byId('products-list');
    els.productsCount = byId('products-count');
    els.regionsList = byId('regions-list');
    els.regionsCount = byId('regions-count');
    els.feedList = byId('feed-list');
    els.feedCount = byId('feed-count');
    els.feedNote = byId('feed-note');
    els.livePill = byId('live-pill');
    els.liveText = byId('live-text');
    els.updateAge = byId('update-age');
    els.clock = byId('clock');
    els.clockDate = byId('clock-date');
    els.shiftLabel = byId('shift-label');
    els.footerStatusText = byId('footer-status-text');
    els.footerFocus = byId('footer-focus');
    els.phaseCountdown = byId('phase-countdown');
    els.rotationDots = byId('rotation-dots');
  }

  /* -------------------------------------------------------------- helpers */

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll(String.fromCharCode(39), '&#39;');
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asNumber(value) {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  function numericOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }

  function timestampOf(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  function formatNumber(value) {
    return numberFormatter.format(asNumber(value));
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatRemaining(milliseconds) {
    const negative = milliseconds < 0;
    const totalSeconds = Math.floor(Math.abs(milliseconds) / 1000);
    let text;
    if (totalSeconds < 3600) {
      text = pad2(Math.floor(totalSeconds / 60)) + ':' + pad2(totalSeconds % 60);
    } else if (totalSeconds < 86400) {
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      text = hours + ':' + pad2(minutes) + ':' + pad2(seconds);
    } else {
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      text = days + ' д ' + hours + ' ч';
    }
    return (negative ? '−' : '') + text;
  }

  function formatAge(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 5) return 'только что';
    if (seconds < 60) return seconds + ' с';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' мин';
    const hours = Math.floor(minutes / 60);
    return hours + ' ч';
  }

  function toneForRemaining(milliseconds) {
    if (milliseconds < 0) return 'is-overdue';
    if (milliseconds <= 5 * MINUTE) return 'is-critical';
    if (milliseconds <= 15 * MINUTE) return 'is-warn';
    return 'is-ok';
  }

  function progressPercent(started, due) {
    if (due === null) return 0;
    const start = started === null ? due - 30 * MINUTE : started;
    if (due <= start) return 100;
    const ratio = (Date.now() - start) / (due - start);
    if (!Number.isFinite(ratio)) return 0;
    return Math.min(100, Math.max(0, Math.round(ratio * 100)));
  }

  function parseJson(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  /* ---------------------------------------------------------- case fields */

  function caseId(item) {
    if (!item || typeof item !== 'object') return '';
    return String(item.incidentId || item.caseId || item.id || '');
  }

  function caseTitle(item) {
    if (!item || typeof item !== 'object') return 'Без описания';
    return String(item.title || item.header || 'Без описания');
  }

  function caseText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function priorityFromValue(value) {
    const direct = numericOrNull(value);
    if (direct !== null) return direct;
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    const map = {
      critical: 4, high: 3, medium: 2, low: 1,
      'наивысший': 4, 'высокий': 3, 'средний': 2, 'низкий': 1
    };
    return Object.prototype.hasOwnProperty.call(map, normalized) ? map[normalized] : null;
  }

  function casePriorityId(item) {
    if (!item || typeof item !== 'object') return null;
    const direct = numericOrNull(item.priorityId);
    if (direct !== null) return direct;
    return priorityFromValue(item.priority);
  }

  function casePriorityText(item) {
    if (!item || typeof item !== 'object') return 'Приоритет';
    if (typeof item.priorityText === 'string' && item.priorityText.trim() !== '') return item.priorityText.trim();
    const id = casePriorityId(item);
    return (id !== null && PRIORITY_LABELS[id]) || 'Приоритет';
  }

  function caseStateId(item) {
    if (!item || typeof item !== 'object') return null;
    return numericOrNull(item.stateId);
  }

  function caseStatusText(item) {
    if (!item || typeof item !== 'object') return 'Статус';
    if (typeof item.status === 'string' && item.status.trim() !== '') return item.status.trim();
    const id = caseStateId(item);
    return (id !== null && STATE_LABELS[id]) || 'Статус';
  }

  function caseTeam(item) {
    if (!item || typeof item !== 'object') return '';
    return caseText(item.team || item.assignedGroupName);
  }

  function caseAffected(item) {
    if (!item || typeof item !== 'object') return 0;
    return asNumber(item.affectedUsers);
  }

  function caseDue(item) {
    if (!item || typeof item !== 'object') return null;
    const direct = timestampOf(item.dueAt) || timestampOf(item.deadline);
    if (direct !== null) return direct;
    const remaining = numericOrNull(item.remainingMs);
    return remaining === null ? null : Date.now() + remaining;
  }

  function caseStarted(item) {
    if (!item || typeof item !== 'object') return null;
    return timestampOf(item.startedAt) || timestampOf(item.submitDate);
  }

  function changeAction(change) {
    if (!change || typeof change !== 'object') return 'изменение';
    if (typeof change.action === 'string' && change.action.trim() !== '') return change.action.trim();
    const bits = [];
    if (change.status) bits.push(String(change.status));
    if (change.priorityText) bits.push(String(change.priorityText));
    if (change.team) bits.push(String(change.team));
    return bits.length ? bits.join(' · ') : 'изменение';
  }

  /* --------------------------------------------------------------- markup */

  function emptyState(title, hint) {
    return '<div class="empty-state"><strong>' + esc(title) + '</strong>'
      + (hint ? '<span>' + esc(hint) + '</span>' : '')
      + '</div>';
  }

  function priorityBadge(item) {
    const id = casePriorityId(item);
    const key = (id !== null && PRIORITY_KEYS[id]) || 'unknown';
    return '<span class="badge p-' + key + '">' + esc(casePriorityText(item)) + '</span>';
  }

  function statusBadge(item) {
    const id = caseStateId(item);
    const key = (id !== null && STATE_KEYS[id]) || 'unknown';
    return '<span class="badge s-' + key + '">' + esc(caseStatusText(item)) + '</span>';
  }

  function countdownHtml(due, started) {
    if (due === null) return '<span class="countdown is-none">—</span>';
    return '<span class="countdown" data-due="' + due + '"'
      + (started !== null ? ' data-started="' + started + '"' : '')
      + '>' + esc(formatRemaining(due - Date.now())) + '</span>';
  }

  function trackHtml(due, started) {
    if (due === null) return '';
    const width = progressPercent(started, due);
    return '<div class="sla-track" data-due="' + due + '"'
      + (started !== null ? ' data-started="' + started + '"' : '')
      + '><i class="sla-fill" style="width:' + width + '%"></i></div>';
  }

  function dedupeCases(list) {
    const seen = Object.create(null);
    const result = [];
    for (const item of list) {
      const key = caseId(item) || caseTitle(item);
      if (seen[key]) continue;
      seen[key] = true;
      result.push(item);
    }
    return result;
  }

  function compareCritical(a, b) {
    const priorityA = casePriorityId(a) || 0;
    const priorityB = casePriorityId(b) || 0;
    if (priorityA !== priorityB) return priorityB - priorityA;
    const dueA = caseDue(a);
    const dueB = caseDue(b);
    if (dueA !== dueB) {
      if (dueA === null) return 1;
      if (dueB === null) return -1;
      return dueA - dueB;
    }
    const affectedA = caseAffected(a);
    const affectedB = caseAffected(b);
    if (affectedA !== affectedB) return affectedB - affectedA;
    return caseId(a).localeCompare(caseId(b));
  }

  function criticalItem(item) {
    const due = caseDue(item);
    const started = caseStarted(item);
    const product = [caseText(item.product), caseText(item.service)].filter(Boolean).join(' · ');
    const region = caseText(item.region);
    const affected = caseAffected(item);
    const team = caseTeam(item);
    const meta = [];
    if (product) meta.push('<span>' + esc(product) + '</span>');
    if (region) meta.push('<span>' + esc(region) + '</span>');
    if (affected > 0) meta.push('<span>' + esc(formatNumber(affected)) + ' польз.</span>');
    meta.push('<span>' + (team ? esc(team) : 'без команды') + '</span>');
    return '<article class="critical-item">'
      + '<div class="crit-body">'
      + '<div class="crit-top">' + priorityBadge(item) + statusBadge(item)
      + (item.isNeedUp ? '<span class="badge flag-escalation">эскалация</span>' : '')
      + '</div>'
      + '<h3 class="crit-title">' + esc(caseTitle(item)) + '</h3>'
      + '<div class="crit-meta">' + meta.join('') + '</div>'
      + (due !== null ? '<div class="sla-block">' + trackHtml(due, started) + '</div>' : '')
      + '</div>'
      + '<div class="crit-timer">' + countdownHtml(due, started) + '<small>' + (due === null ? 'без SLA' : 'до SLA') + '</small></div>'
      + '</article>';
  }

  function teamRow(item, maxTotal) {
    const total = asNumber(item.total);
    const critical = asNumber(item.critical);
    const high = asNumber(item.high);
    const affected = asNumber(item.affectedUsers);
    const meta = [];
    if (item.note) {
      meta.push('<span>' + esc(item.note) + '</span>');
    } else {
      if (critical > 0) meta.push('<span>' + critical + ' крит.</span>');
      if (high > 0) meta.push('<span>' + high + ' выс.</span>');
      if (affected > 0) meta.push('<span>' + esc(formatNumber(affected)) + ' польз.</span>');
    }
    const width = maxTotal > 0 ? Math.max(3, Math.round((total / maxTotal) * 100)) : 3;
    const unassigned = item.team === UNASSIGNED_LABEL;
    return '<div class="team-row' + (unassigned ? ' is-unassigned' : '') + '">'
      + '<div class="team-top"><span class="team-name">' + esc(item.team || 'Без названия') + '</span>'
      + '<span class="team-total">' + esc(formatNumber(total)) + '</span></div>'
      + '<div class="team-meta">' + (meta.length ? meta.join('') : '<span>активные</span>') + '</div>'
      + '<div class="team-bar"><i style="width:' + width + '%"></i></div>'
      + '</div>';
  }

  function slaRow(item) {
    const due = caseDue(item);
    const started = caseStarted(item);
    return '<div class="sla-row">'
      + '<span class="sla-line"><span class="sla-id">' + esc(caseId(item) || '—') + '</span>'
      + '<span class="sla-title">' + esc(caseTitle(item)) + '</span></span>'
      + countdownHtml(due, started)
      + trackHtml(due, started)
      + '</div>';
  }

  function changeRow(change) {
    const at = timestampOf(change.createdAt) || timestampOf(change.updatedAt) || timestampOf(change.at);
    const time = at === null ? '—' : hmFormatter.format(at);
    const id = change.incidentId || change.caseId || '';
    const priorityId = casePriorityId(change);
    const priorityClass = priorityId === 4 ? ' priority-critical' : priorityId === 3 ? ' priority-high' : '';
    const text = id
      ? '<b>' + esc(id) + '</b> ' + esc(changeAction(change))
      : esc(changeAction(change));
    return '<div class="change-row' + priorityClass + '">'
      + '<span class="change-time">' + esc(time) + '</span>'
      + '<span class="change-main">' + text + '</span>'
      + '</div>';
  }

  function unassignedRow(item) {
    return '<div class="unassigned-row">'
      + priorityBadge(item)
      + '<span class="u-title">' + esc(caseTitle(item)) + '</span>'
      + '<span class="u-affected">' + (caseAffected(item) > 0 ? esc(formatNumber(caseAffected(item))) : '—') + '</span>'
      + '</div>';
  }

  function aggregateRow(item, kind) {
    const name = kind === 'regions' ? caseText(item.region) : caseText(item.product);
    const total = asNumber(item.total);
    const critical = asNumber(item.critical);
    const high = asNumber(item.high);
    const affected = asNumber(item.affectedUsers);
    const meta = [];
    if (total > 0) meta.push(total + ' активных');
    if (critical > 0) meta.push(critical + ' крит.');
    if (high > 0) meta.push(high + ' выс.');
    return '<div class="agg-row">'
      + '<span class="agg-name">' + esc(name || 'Не указано') + '</span>'
      + '<span class="agg-value">' + (affected > 0 ? esc(formatNumber(affected)) : '—') + '</span>'
      + '<span class="agg-sub">' + esc(meta.length ? meta.join(' · ') : 'активные') + '</span>'
      + '</div>';
  }

  function feedRow(item) {
    const system = item.kind === 'system';
    const isNew = item.at > state.feedSeenAt;
    const text = item.id
      ? '<b>' + esc(item.id) + '</b> ' + esc(item.text)
      : esc(item.text);
    return '<div class="feed-row' + (system ? ' is-system' : '') + (isNew ? ' is-new' : '') + '">'
      + '<span class="feed-time">' + esc(hmsFormatter.format(item.at)) + '</span>'
      + '<span class="feed-text">' + text + '</span>'
      + '</div>';
  }

  /* -------------------------------------------------------------- renders */

  function renderSummary(data) {
    const cards = [
      { key: 'critical', value: data.counts.critical, label: 'Критические', sub: 'требуют внимания' },
      { key: 'high', value: data.counts.high, label: 'Высокий', sub: 'приоритет' },
      { key: 'coordination', value: data.unassigned.count, label: 'Без команды', sub: 'координация' },
      { key: 'risk', value: data.counts.risk, label: 'SLA риск', sub: 'до нарушения' },
      { key: 'active', value: data.counts.active, label: 'Активных', sub: 'затронуто ' + formatNumber(data.counts.affectedUsers) }
    ];
    let html = '';
    for (const card of cards) {
      html += '<article class="summary-card" data-summary="' + card.key + '">'
        + '<span class="summary-num">' + esc(formatNumber(card.value)) + '</span>'
        + '<span class="summary-label">' + esc(card.label) + '</span>'
        + '<span class="summary-sub">' + esc(card.sub) + '</span>'
        + '</article>';
    }
    els.summary.innerHTML = html;
  }

  function renderCritical(data) {
    const all = dedupeCases(toArray(data.critical).concat(toArray(data.high))).sort(compareCritical);
    const visible = all.slice(0, MAX_CRITICAL);
    const total = Math.max(data.counts.critical + data.counts.high, all.length);
    els.criticalCount.textContent = formatNumber(total);
    els.criticalNote.textContent = total > visible.length
      ? 'показаны ' + visible.length + ' из ' + formatNumber(total)
      : 'срок SLA';
    const affectedTotal = all.reduce(function (sum, item) { return sum + caseAffected(item); }, 0);
    if (els.criticalSummary) {
      els.criticalSummary.textContent = 'критических ' + formatNumber(data.counts.critical)
        + ' · высоких ' + formatNumber(data.counts.high)
        + ' · затронуто ' + formatNumber(affectedTotal) + ' польз.';
    }
    if (!visible.length) {
      els.criticalList.innerHTML = emptyState('Критических и высоких инцидентов нет', 'активные приоритеты 4 и 3');
      return;
    }
    let html = '';
    for (const item of visible) html += criticalItem(item);
    els.criticalList.innerHTML = html;
  }

  function isCompactLayout() {
    return window.innerWidth > 1280 && window.innerHeight < 950;
  }

  function renderTeams(data) {
    const unassignedCount = data.unassigned.count;
    const compact = isCompactLayout();
    const limit = unassignedCount > 0
      ? (compact ? 3 : 4)
      : (compact ? 4 : 5);
    const rows = toArray(data.teams)
      .slice()
      .sort(function (a, b) { return asNumber(b.total) - asNumber(a.total); })
      .slice(0, limit);
    const maxTotal = rows.reduce(function (max, item) { return Math.max(max, asNumber(item.total)); }, 1);
    if (unassignedCount > 0) {
      rows.push({ team: UNASSIGNED_LABEL, total: unassignedCount, critical: 0, high: 0, affectedUsers: 0, note: 'ждут распределения' });
    }
    els.teamsCount.textContent = formatNumber(Math.max(data.counts.active, rows.length));
    if (!rows.length) {
      els.teamsList.innerHTML = emptyState('Команды не назначены', 'нет активных инцидентов');
      return;
    }
    let html = '';
    for (const item of rows) html += teamRow(item, maxTotal);
    if (!toArray(data.teams).length) {
      html += '<div class="panel-footnote">назначенных команд пока нет</div>';
    }
    els.teamsList.innerHTML = html;
  }

  function renderSla(data) {
    const all = toArray(data.slaRisk).slice().sort(function (a, b) {
      const dueA = caseDue(a);
      const dueB = caseDue(b);
      if (dueA === dueB) return 0;
      if (dueA === null) return 1;
      if (dueB === null) return -1;
      return dueA - dueB;
    });
    const visible = all.slice(0, MAX_ROWS);
    els.slaCount.textContent = formatNumber(Math.max(data.counts.risk, all.length));
    if (!visible.length) {
      els.slaList.innerHTML = emptyState('Риска нарушения SLA нет', 'все сроки в пределах нормы');
      return;
    }
    let html = '';
    for (const item of visible) html += slaRow(item);
    els.slaList.innerHTML = html;
  }

  function renderRecent(data) {
    const all = toArray(data.recent);
    const visible = all.slice(0, MAX_RECENT);
    els.recentCount.textContent = formatNumber(all.length);
    if (!visible.length) {
      els.recentList.innerHTML = emptyState('Изменений пока нет', 'лента обновляется по SSE');
      return;
    }
    let html = '';
    for (const change of visible) html += changeRow(change);
    els.recentList.innerHTML = html;
  }

  function renderUnassigned(data) {
    const count = data.unassigned.count;
    const cases = toArray(data.unassigned.cases);
    const visible = cases.slice(0, MAX_ROWS);
    els.unassignedCount.textContent = formatNumber(count);
    if (!visible.length) {
      els.unassignedList.innerHTML = count > 0
        ? emptyState('Детализация недоступна', 'инцидентов без команды: ' + formatNumber(count))
        : emptyState('Все инциденты распределены', 'команды назначены');
      return;
    }
    let html = '';
    for (const item of visible) html += unassignedRow(item);
    els.unassignedList.innerHTML = html;
  }

  function renderAggregates(listEl, countEl, rows, kind, emptyTitle) {
    const all = toArray(rows).slice().sort(function (a, b) {
      const affected = asNumber(b.affectedUsers) - asNumber(a.affectedUsers);
      if (affected !== 0) return affected;
      return asNumber(b.total) - asNumber(a.total);
    });
    const visible = all.slice(0, MAX_AGG);
    countEl.textContent = formatNumber(all.length);
    if (!visible.length) {
      listEl.innerHTML = emptyState(emptyTitle, 'нет активных инцидентов');
      return;
    }
    let html = '';
    for (const item of visible) html += aggregateRow(item, kind);
    listEl.innerHTML = html;
  }

  function renderFeed() {
    const items = [];
    const recent = state.data ? toArray(state.data.recent) : [];
    for (const change of recent) {
      const at = timestampOf(change.createdAt) || timestampOf(change.updatedAt) || timestampOf(change.at);
      if (at === null) continue;
      items.push({
        at: at,
        kind: 'change',
        id: change.incidentId || change.caseId || '',
        text: changeAction(change)
      });
    }
    for (const event of state.systemEvents) items.push(event);
    items.sort(function (a, b) { return b.at - a.at; });
    const seen = Object.create(null);
    const unique = [];
    for (const item of items) {
      const key = item.at + '|' + item.kind + '|' + (item.id || '') + '|' + item.text;
      if (seen[key]) continue;
      seen[key] = true;
      unique.push(item);
    }
    const visible = unique.slice(0, MAX_FEED);
    els.feedCount.textContent = formatNumber(visible.length);
    if (!visible.length) {
      els.feedList.innerHTML = emptyState('Поток событий пуст', 'ожидаем изменения по SSE');
      return;
    }
    let html = '';
    for (const item of visible) html += feedRow(item);
    els.feedList.innerHTML = html;
    if (visible[0].at > state.feedSeenAt) state.feedSeenAt = visible[0].at;
  }

  function emptyWallboard() {
    return {
      counts: { active: 0, critical: 0, high: 0, coordination: 0, research: 0, risk: 0, affectedUsers: 0 },
      unassigned: { count: 0, cases: [] },
      critical: [],
      high: [],
      teams: [],
      slaRisk: [],
      products: [],
      regions: [],
      recent: []
    };
  }

  function renderLoading() {
    if (!els.summary) return;
    renderSummary(emptyWallboard());
  }

  function renderNoData() {
    renderLoading();
    const targets = [els.criticalList, els.teamsList, els.slaList, els.recentList, els.unassignedList, els.productsList, els.regionsList, els.feedList];
    for (const target of targets) {
      if (target) target.innerHTML = emptyState('Нет данных', 'нет связи с сервером');
    }
    if (els.criticalCount) els.criticalCount.textContent = '0';
    if (els.teamsCount) els.teamsCount.textContent = '0';
    if (els.slaCount) els.slaCount.textContent = '0';
    if (els.recentCount) els.recentCount.textContent = '0';
    if (els.unassignedCount) els.unassignedCount.textContent = '0';
    if (els.productsCount) els.productsCount.textContent = '0';
    if (els.regionsCount) els.regionsCount.textContent = '0';
    if (els.feedCount) els.feedCount.textContent = '0';
  }

  function renderAll() {
    if (!state.data) return;
    try {
      renderSummary(state.data);
      renderCritical(state.data);
      renderTeams(state.data);
      renderSla(state.data);
      renderRecent(state.data);
      renderUnassigned(state.data);
      renderAggregates(els.productsList, els.productsCount, state.data.products, 'products', 'Нет данных по продуктам');
      renderAggregates(els.regionsList, els.regionsCount, state.data.regions, 'regions', 'Нет данных по регионам');
      renderFeed();
      updateCountdowns();
      updateHeaderStatus();
    } catch (error) {
      console.error('wall render failed', error);
    }
  }

  function updateCountdowns() {
    const now = Date.now();
    const countdowns = document.querySelectorAll('.countdown[data-due]');
    for (let index = 0; index < countdowns.length; index += 1) {
      const node = countdowns[index];
      const due = Number(node.getAttribute('data-due'));
      if (!Number.isFinite(due)) continue;
      const remaining = due - now;
      node.textContent = formatRemaining(remaining);
      node.classList.remove('is-ok', 'is-warn', 'is-critical', 'is-overdue');
      node.classList.add(toneForRemaining(remaining));
    }
    const tracks = document.querySelectorAll('.sla-track[data-due]');
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      const due = Number(track.getAttribute('data-due'));
      if (!Number.isFinite(due)) continue;
      const startedRaw = track.getAttribute('data-started');
      const started = startedRaw === null ? null : Number(startedRaw);
      const width = progressPercent(Number.isFinite(started) ? started : null, due);
      const fill = track.querySelector('.sla-fill');
      if (fill) {
        fill.style.width = width + '%';
        fill.classList.remove('is-ok', 'is-warn', 'is-critical', 'is-overdue');
        fill.classList.add(toneForRemaining(due - now));
      }
    }
  }

  /* ---------------------------------------------------------- live status */

  function computeLiveMode() {
    if (state.pollTimer) return state.fetchFailures >= 2 ? 'offline' : 'polling';
    if (state.sseOpen) return 'live';
    if (!state.data) return state.fetchFailures > 0 || state.sseFailures > 0 ? 'offline' : 'connecting';
    if (state.fetchFailures > 0 || state.sseFailures > 0) return 'reconnecting';
    return 'reconnecting';
  }

  function updateLivePill() {
    const mode = computeLiveMode();
    document.body.dataset.live = mode;
    if (els.liveText) els.liveText.textContent = LIVE_LABELS[mode] || '—';
    if (els.livePill) els.livePill.title = LIVE_TITLES[mode] || '';
    updateHeaderStatus();
  }

  function updateHeaderStatus() {
    const now = Date.now();
    if (els.updateAge) {
      if (!state.lastSuccessAt) {
        els.updateAge.textContent = 'данные ещё не получены';
        els.updateAge.classList.remove('is-stale', 'is-error');
      } else {
        const age = now - state.lastSuccessAt;
        let text = 'обновлено ' + formatAge(age) + ' назад';
        if (state.lastSyncError) text += ' · ошибка синхронизации';
        els.updateAge.textContent = text;
        els.updateAge.classList.toggle('is-stale', age > 45000 && !state.lastSyncError);
        els.updateAge.classList.toggle('is-error', Boolean(state.lastSyncError));
      }
    }
    if (els.footerStatusText) {
      const mode = computeLiveMode();
      let text;
      if (mode === 'live') text = 'LIVE · SSE';
      else if (mode === 'polling') text = 'резервный режим · опрос ' + Math.round(POLL_MS / 1000) + ' с';
      else if (mode === 'offline' && state.pollTimer) text = 'нет связи · опрос API не отвечает';
      else if (mode === 'reconnecting') text = 'SSE переподключается' + (state.lastSuccessAt ? ' · данные ' + formatAge(now - state.lastSuccessAt) + ' назад' : '');
      else if (mode === 'offline') text = 'нет связи' + (state.lastSuccessAt ? ' · последние данные ' + hmsFormatter.format(state.lastSuccessAt) : ' · данных нет');
      else text = 'ожидание данных';
      if (state.lastSyncError) text += ' · ошибка синхронизации';
      els.footerStatusText.textContent = text;
    }
    if (els.feedNote) {
      const mode = computeLiveMode();
      els.feedNote.textContent = mode === 'polling' ? 'опрос API' : mode === 'live' ? 'SSE · live' : 'последние данные';
    }
  }

  /* -------------------------------------------------------------- rotation */

  function buildRotationDots() {
    if (!els.rotationDots) return;
    let html = '';
    for (let index = 0; index < PHASES.length; index += 1) html += '<i></i>';
    els.rotationDots.innerHTML = html;
  }

  function updatePhaseCountdown() {
    if (!els.phaseCountdown) return;
    if (state.focusPinned) {
      els.phaseCountdown.textContent = 'фиксированный фокус';
      return;
    }
    const elapsed = Date.now() - state.phaseStartedAt;
    const remaining = Math.max(0, Math.ceil((ROTATION_MS - elapsed) / 1000));
    els.phaseCountdown.textContent = remaining + ' с';
  }

  function setPhase(index) {
    state.phaseIndex = ((index % PHASES.length) + PHASES.length) % PHASES.length;
    state.phaseStartedAt = Date.now();
    const phase = PHASES[state.phaseIndex];
    document.body.dataset.phase = phase.id;
    if (els.rotationDots) {
      const dots = els.rotationDots.querySelectorAll('i');
      for (let dotIndex = 0; dotIndex < dots.length; dotIndex += 1) {
        dots[dotIndex].classList.toggle('is-on', dotIndex === state.phaseIndex);
      }
    }
    if (els.footerFocus) els.footerFocus.textContent = 'Фокус: ' + phase.label;
    updatePhaseCountdown();
  }

  function maybeRotate() {
    if (state.focusPinned || state.rotationPaused) return;
    if (Date.now() - state.phaseStartedAt >= ROTATION_MS) setPhase(state.phaseIndex + 1);
    else updatePhaseCountdown();
  }

  /* ---------------------------------------------------------------- feed */

  function pushSystemEvent(text) {
    const now = Date.now();
    const last = state.systemEvents[0];
    if (last && last.text === text && now - last.at < 4000) return;
    state.systemEvents.unshift({ at: now, kind: 'system', id: '', text: text });
    if (state.systemEvents.length > 6) state.systemEvents.length = 6;
    if (state.data) renderFeed();
  }

  /* ---------------------------------------------------------------- data */

  function normalizeWallboard(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const counts = source.counts && typeof source.counts === 'object' ? source.counts : {};
    const sync = source.sync && typeof source.sync === 'object' ? source.sync : {};
    const unassignedRaw = source.unassigned;
    const unassignedIsArray = Array.isArray(unassignedRaw);
    const unassignedCases = unassignedIsArray ? unassignedRaw : toArray(unassignedRaw && unassignedRaw.cases);
    const unassignedCount = unassignedIsArray
      ? unassignedCases.length
      : Math.max(asNumber(unassignedRaw && unassignedRaw.count), 0);
    const recent = toArray(source.recent).length ? toArray(source.recent) : toArray(source.recentChanges);
    return {
      generatedAt: timestampOf(source.generatedAt),
      live: source.live !== false,
      sync: { lastSyncedAt: timestampOf(sync.lastSyncedAt), syncError: sync.syncError || null },
      counts: {
        active: asNumber(counts.active),
        critical: asNumber(counts.critical),
        high: asNumber(counts.high),
        coordination: asNumber(counts.coordination),
        research: asNumber(counts.research),
        risk: asNumber(counts.risk),
        affectedUsers: asNumber(counts.affectedUsers)
      },
      critical: toArray(source.critical),
      high: toArray(source.high),
      teams: toArray(source.teams),
      slaRisk: toArray(source.slaRisk),
      unassigned: { count: unassignedCount, cases: unassignedCases },
      products: toArray(source.products),
      regions: toArray(source.regions),
      recent: recent
    };
  }

  function applyData(raw) {
    if (!raw || typeof raw !== 'object') return;
    const data = normalizeWallboard(raw);
    const first = !state.data;
    state.data = data;
    state.lastSuccessAt = Date.now();
    state.fetchFailures = 0;
    state.lastSyncError = data.sync.syncError;
    renderAll();
    updateLivePill();
    if (first) pushSystemEvent('данные загружены');
    if (state.lastErrorNotified) {
      pushSystemEvent('связь с API восстановлена');
      state.lastErrorNotified = false;
    }
  }

  async function fetchWallboard() {
    if (state.fetchInFlight) return;
    state.fetchInFlight = true;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS)
      : null;
    try {
      const response = await fetch(WALLBOARD_URL, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      applyData(payload);
    } catch (error) {
      state.fetchFailures += 1;
      if (!state.lastErrorNotified) {
        pushSystemEvent('ошибка получения данных');
        state.lastErrorNotified = true;
      }
      if (!state.data && state.fetchFailures >= 2) renderNoData();
    } finally {
      if (timeout) clearTimeout(timeout);
      state.fetchInFlight = false;
      updateLivePill();
    }
  }

  function scheduleRefresh(delay) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(function () {
      state.debounceTimer = null;
      fetchWallboard();
    }, delay || 900);
  }

  /* ----------------------------------------------------------------- SSE */

  function closeEvents() {
    clearTimeout(state.sseWatchdog);
    state.sseWatchdog = null;
    if (state.sse) {
      state.sse.onopen = null;
      state.sse.onerror = null;
      state.sse.close();
      state.sse = null;
    }
    state.sseOpen = false;
  }

  function activatePolling(reason) {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(fetchWallboard, POLL_MS);
    state.sseRetryTimer = setInterval(function () {
      if (!state.sseOpen) connectEvents();
    }, SSE_RETRY_MS);
    pushSystemEvent('резервный режим: опрос API');
    updateLivePill();
    fetchWallboard();
  }

  function deactivatePolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.sseRetryTimer) {
      clearInterval(state.sseRetryTimer);
      state.sseRetryTimer = null;
    }
    updateLivePill();
  }

  function connectEvents() {
    closeEvents();
    if (typeof window.EventSource !== 'function') {
      activatePolling('EventSource недоступен');
      return;
    }
    let source;
    try {
      source = new EventSource(EVENTS_URL);
    } catch (error) {
      activatePolling('SSE не создан');
      return;
    }
    state.sse = source;
    state.sseFailures = 0;
    clearTimeout(state.sseWatchdog);
    state.sseWatchdog = setTimeout(function () {
      if (!state.sseOpen) activatePolling('таймаут SSE');
    }, SSE_WATCHDOG_MS);
    source.onopen = function () {
      state.sseOpen = true;
      state.sseFailures = 0;
      clearTimeout(state.sseWatchdog);
      deactivatePolling();
      pushSystemEvent('SSE-канал подключён');
      updateLivePill();
      fetchWallboard();
    };
    source.onerror = function () {
      state.sseOpen = false;
      state.sseFailures += 1;
      pushSystemEvent('SSE переподключается');
      updateLivePill();
      scheduleRefresh(1200);
      if (state.sseFailures >= 2) activatePolling('SSE недоступен');
    };
    source.addEventListener('wallboard', function (event) {
      const payload = parseJson(event.data);
      if (!payload) return;
      state.sseOpen = true;
      applyData(payload);
      updateLivePill();
    });
    source.addEventListener('incidents', function (event) {
      const payload = parseJson(event.data);
      const added = asNumber(payload && payload.added);
      const updated = asNumber(payload && payload.updated);
      scheduleRefresh(added > 0 || updated > 0 ? 800 : 1500);
    });
    source.addEventListener('sync', function (event) {
      const payload = parseJson(event.data);
      if (payload && payload.type === 'sync.error') pushSystemEvent('ошибка синхронизации');
      else pushSystemEvent('синхронизация восстановлена');
      scheduleRefresh(800);
    });
  }

  /* ---------------------------------------------------------------- clock */

  function shiftLabel(date) {
    const hours = date.getHours();
    return hours >= 8 && hours < 20
      ? 'Дневная смена · 08:00–20:00'
      : 'Ночная смена · 20:00–08:00';
  }

  function tickClock() {
    const now = new Date();
    if (els.clock) {
      els.clock.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    }
    if (els.clockDate) els.clockDate.textContent = dateFormatter.format(now);
    if (els.shiftLabel) els.shiftLabel.textContent = shiftLabel(now);
    updateCountdowns();
    updateHeaderStatus();
    maybeRotate();
  }

  /* ----------------------------------------------------------------- init */

  function applyFocusOverride() {
    const params = new URLSearchParams(window.location.search);
    const focus = params.get('focus');
    const allowed = { overview: true, critical: true, sla: true, teams: true };
    if (focus && allowed[focus]) {
      state.focusPinned = true;
      const index = PHASES.findIndex(function (phase) { return phase.id === focus; });
      setPhase(index >= 0 ? index : 0);
      return;
    }
    setPhase(0);
  }

  function init() {
    cacheElements();
    buildRotationDots();
    applyFocusOverride();
    tickClock();
    setInterval(tickClock, 1000);
    document.addEventListener('visibilitychange', function () {
      state.rotationPaused = document.hidden;
      if (!document.hidden) {
        state.phaseStartedAt = Date.now();
        fetchWallboard();
      }
    });
    window.addEventListener('offline', function () {
      pushSystemEvent('сеть недоступна');
      updateLivePill();
    });
    window.addEventListener('online', function () {
      pushSystemEvent('сеть восстановлена');
      fetchWallboard();
    });
    renderLoading();
    fetchWallboard();
    connectEvents();
    state.refreshTimer = setInterval(fetchWallboard, REFRESH_MS);
    updateLivePill();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
