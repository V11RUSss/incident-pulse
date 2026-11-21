'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
const DEFAULT_MODEL = 'qwen3-8b';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 700;
const MAX_RESPONSE_BYTES = 128 * 1024;

class AiError extends Error {
  constructor(message, { status = 502, code = 'ai_error', details } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function configuredInteger(value, fallback, minimum = 1) {
  const converted = Number(value);
  return Number.isInteger(converted) && converted >= minimum ? converted : fallback;
}

const SYSTEM_PROMPT = [
  'Ты — помощник координатора массовых ИТ-инцидентов МТС.',
  'Отвечай строго по предоставленным данным, не выдумывай факты и не меняй данные.',
  'Верни только один JSON-объект без Markdown и пояснений, с полями:',
  'summary — краткая сводка ситуации;',
  'attentions — массив строк с пунктами, требующими внимания;',
  'recommendation — конкретная рекомендация по действию или команде.'
].join(' ');

function sanitizedBody(text) {
  if (!text) return undefined;
  return text.slice(0, 500);
}

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('AI-сервис вернул некорректный JSON', { status: 502, code: 'bad_json' });
  }
}

function extractContent(payload) {
  const content = payload && Array.isArray(payload.choices) && payload.choices[0] &&
    payload.choices[0].message && payload.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return content.trim();
}

function parseResult(content) {
  const withoutThinking = content
    .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
    .trim();
  const stripped = withoutThinking.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON: keep the raw text as a summary.
  }
  return { summary: stripped };
}

class AiClient {
  constructor(options = {}) {
    this.baseUrl = (
      options.baseUrl
      || process.env.AI_BASE_URL
      || process.env.DEEPSEEK_BASE_URL
      || DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.model = options.model || process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
    this.timeoutMs = configuredInteger(
      options.timeoutMs ?? process.env.AI_TIMEOUT_MS ?? process.env.DEEPSEEK_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    );
    this.maxTokens = configuredInteger(options.maxTokens ?? process.env.AI_MAX_TOKENS, DEFAULT_MAX_TOKENS);
    this.apiKey = String(
      options.apiKey ?? process.env.AI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? ''
    ).trim();
  }

  async complete(prompt, options = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new AiError('Пустой prompt для ИИ', { status: 500, code: 'invalid_prompt' });
    }
    const systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
    const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.2;
    const maxTokens = Number.isInteger(options.maxTokens) && options.maxTokens > 0
      ? options.maxTokens
      : this.maxTokens;
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this.timeoutMs;
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature,
      max_tokens: maxTokens,
      stream: false
    });

    let response;
    let text;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      text = await response.text();
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new AiError(
        timedOut ? 'AI-сервис превысил время ожидания' : 'AI-сервис недоступен',
        { status: 502, code: timedOut ? 'timeout' : 'network' }
      );
    }

    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new AiError('Ответ AI-сервиса превысил допустимый размер', { status: 502, code: 'response_too_large' });
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new AiError('AI-сервис отклонил ключ доступа (401)', { status: 502, code: 'auth_failed' });
      }
      if (response.status === 429) {
        throw new AiError('AI-сервис ограничил частоту запросов (429)', { status: 502, code: 'rate_limited', details: sanitizedBody(text) });
      }
      if (response.status === 400) {
        throw new AiError('AI-сервис отклонил запрос (некорректная модель или параметры)', {
          status: 502,
          code: 'invalid_request',
          details: sanitizedBody(text)
        });
      }
      throw new AiError(`AI-сервис вернул HTTP ${response.status}`, {
        status: response.status === 503 ? 503 : 502,
        code: 'provider_error',
        details: sanitizedBody(text)
      });
    }

    const content = extractContent(parsePayload(text));
    if (!content) throw new AiError('AI-сервис вернул пустой ответ', { status: 502, code: 'empty_response' });
    return content;
  }

  async summarize(prompt) {
    return parseResult(await this.complete(prompt));
  }
}

module.exports = { AiClient, AiError };
