'use strict';

const { PRIORITY_TEXT, STATES } = require('./incidents');

const ACTION_LABELS = Object.freeze({
  claim: 'Взятие в координацию',
  reassign: 'Передача координатору',
  priority: 'Изменение приоритета',
  'priority-override.delete': 'Возврат к автоприоритету',
  deadline: 'Изменение срока SLA',
  team: 'Назначение команды',
  status: 'Изменение статуса'
});

const CONFIDENCE = new Set(['low', 'medium', 'high']);
const PRIORITIES = new Set(['low', 'medium', 'high']);

class PostmortemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PostmortemError';
    this.status = 502;
    this.code = 'postmortem_parse_failed';
  }
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'время не указано';
  return date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
}

function formatDetails(item) {
  const details = item.details && typeof item.details === 'object' ? item.details : {};
  switch (item.action) {
    case 'claim':
      return 'Взял инцидент в координацию';
    case 'reassign':
      return details.coordinatorName ? 'Передал координатору: ' + details.coordinatorName : 'Передал координатору';
    case 'priority':
      return 'Приоритет: ' + (PRIORITY_TEXT[details.priorityId] || details.priorityId || 'не указан');
    case 'priority-override.delete':
      return 'Возврат к автоматическому приоритету';
    case 'deadline':
      return details.deadline ? 'Срок SLA: ' + formatTime(details.deadline) : 'Срок SLA снят';
    case 'team':
      return details.team ? 'Команда: ' + details.team : 'Команда назначена';
    case 'status': {
      const status = STATES[details.stateId] || 'неизвестный статус';
      return 'Статус: ' + status + (details.solution ? '. Решение: ' + details.solution : '');
    }
    default:
      return ACTION_LABELS[item.action] || String(item.action || 'Событие');
  }
}

function buildTimeline(history) {
  return (Array.isArray(history) ? history : [])
    .filter(item => item && Number.isFinite(item.createdAt))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.id || 0) - (b.id || 0))
    .map(item => ({
      id: item.id,
      at: item.createdAt,
      actor: item.userName || 'Система',
      action: item.action,
      event: formatDetails(item),
      kind: 'fact'
    }));
}

function describeIncident(incident) {
  return [
    incident.id,
    incident.title,
    incident.product,
    incident.service,
    incident.scenario
  ].filter(Boolean).join(' · ');
}

function buildFallbackPostmortem(incident, timeline) {
  const events = timeline || [];
  const summaryParts = [];
  if (!events.length) {
    summaryParts.push('История изменений по инциденту пуста: зафиксировать ход работ пока нельзя.');
  } else {
    summaryParts.push('Зафиксировано ' + events.length + ' событий: с ' + formatTime(events[0].at) + ' по ' + formatTime(events[events.length - 1].at) + '.');
    summaryParts.push(describeIncident(incident) + '.');
  }

  const improvements = [];
  const claim = events.find(event => event.action === 'claim');
  const team = events.find(event => event.action === 'team');
  if (claim && team && team.at - claim.at > 10 * 60 * 1000) {
    improvements.push({
      action: 'Сократить время между взятием в координацию и назначением команды — в истории это заняло ' + Math.round((team.at - claim.at) / 60000) + ' мин.',
      owner: 'Координация',
      priority: 'high'
    });
  }
  if (!team && incident.groups && incident.groups.includes('active')) {
    improvements.push({ action: 'Назначить профильную команду: инцидент активен без команды.', owner: 'Координация', priority: 'high' });
  }
  if (incident.dueAt && incident.resolvedAt && incident.resolvedAt > incident.dueAt) {
    improvements.push({ action: 'Разобрать причины нарушения SLA: инцидент завершён позже срока.', owner: 'Эксплуатация', priority: 'medium' });
  }

  return {
    timeline: events,
    summary: summaryParts.join(' '),
    causes: [],
    improvements: improvements.slice(0, 5),
    wentWell: incident.groups && incident.groups.includes('closed') && !(incident.dueAt && incident.resolvedAt && incident.resolvedAt > incident.dueAt)
      ? ['Инцидент завершён, нарушение SLA в доступных данных не зафиксировано.']
      : [],
    openQuestions: events.length
      ? ['Причина возникновения в истории не зафиксирована.']
      : ['История пуста: нужны события координации и решения.'],
    source: 'fallback',
    generatedAt: Date.now()
  };
}

function stripThinking(content) {
  return String(content || '')
    .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
    .replace(/^\x60{3}(?:json)?\s*/i, '')
    .replace(/\x60{3}\s*$/, '')
    .trim();
}

function stringArray(value, max) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim().slice(0, 500))
    .slice(0, max);
}

function parsePostmortemResponse(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripThinking(content));
  } catch {
    throw new PostmortemError('Модель вернула не JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PostmortemError('Модель вернула некорректный ответ');
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 3000) : '';
  if (!summary) throw new PostmortemError('Модель не вернула summary');

  const causes = Array.isArray(parsed.causes) ? parsed.causes
    .filter(item => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim())
    .map(item => ({
      text: item.text.trim().slice(0, 500),
      evidence: typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 500) : '',
      confidence: CONFIDENCE.has(item.confidence) ? item.confidence : 'low'
    }))
    .slice(0, 10) : [];

  const improvements = Array.isArray(parsed.improvements) ? parsed.improvements
    .filter(item => item && typeof item === 'object' && typeof item.action === 'string' && item.action.trim())
    .map(item => ({
      action: item.action.trim().slice(0, 500),
      owner: typeof item.owner === 'string' ? item.owner.trim().slice(0, 120) : '',
      priority: PRIORITIES.has(item.priority) ? item.priority : 'medium'
    }))
    .slice(0, 10) : [];

  return {
    summary,
    causes,
    improvements,
    wentWell: stringArray(parsed.wentWell, 10),
    openQuestions: stringArray(parsed.openQuestions, 10)
  };
}

function buildPostmortemPrompt(incident, timeline) {
  const lines = timeline.map(event => [
    formatTime(event.at),
    event.actor,
    event.action,
    event.event
  ].join(' | '));
  return [
    'Проанализируй историю массового ИТ-инцидента и подготовь постмортем.',
    'Название: ' + String(incident.title || ''),
    'Номер: ' + String(incident.id || ''),
    'Продукт: ' + String(incident.product || 'не указан'),
    'Сервис: ' + String(incident.service || 'не указан'),
    'Сценарий: ' + String(incident.scenario || 'не указан'),
    'Приоритет: ' + (PRIORITY_TEXT[incident.priorityId] || 'не указан'),
    'Статус: ' + (STATES[incident.stateId] || 'не указан'),
    'Команда: ' + String(incident.team || 'не назначена'),
    'Координатор: ' + String(incident.coordinatorName || 'не назначен'),
    'Описание: ' + String(incident.description || 'нет').replace(/\s+/g, ' ').trim().slice(0, 1200),
    '',
    'Хронология из истории изменений (факты, не переписывай события):',
    ...(lines.length ? lines : ['История пуста.']),
    '',
    'Верни только JSON:',
    '{"summary":"что произошло, 2–4 предложения","causes":[{"text":"причина или гипотеза","evidence":"какое событие/интервал подтверждает","confidence":"low|medium|high"}],"improvements":[{"action":"конкретное улучшение","owner":"команда или роль","priority":"low|medium|high"}],"wentWell":["что сработало"],"openQuestions":["чего не хватает в данных"]}',
    'Правила:',
    '- не выдумывай события, причины и цифры;',
    '- если причина не следует из истории, не утверждай её — добавь в openQuestions;',
    '- evidence должен ссылаться на события из хронологии;',
    '- улучшения — конкретные, связанные с задержками или пробелами в истории;',
    '- без Markdown, только JSON.'
  ].join('\n');
}

const SYSTEM_PROMPT = [
  'Ты — аналитик постмортемов массовых ИТ-инцидентов МТС.',
  'Ты работаешь только с переданной хронологией и карточкой инцидента.',
  'Не выдумывай факты, причины, владельцев и цифры.',
  'Разделяй подтверждённые факты и гипотезы; для гипотез указывай evidence.',
  'Пиши по-русски, кратко и по делу.',
  'Ответ — только один JSON-объект без Markdown и текста вокруг.'
].join('\n');

module.exports = {
  ACTION_LABELS,
  PostmortemError,
  SYSTEM_PROMPT,
  buildFallbackPostmortem,
  buildPostmortemPrompt,
  buildTimeline,
  formatTime,
  parsePostmortemResponse
};
