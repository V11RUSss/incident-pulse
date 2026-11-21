'use strict';

const {
  SYSTEM_PROMPT,
  buildFallbackPostmortem,
  buildPostmortemPrompt,
  buildTimeline,
  parsePostmortemResponse
} = require('../lib/postmortem');

async function generatePostmortem(ai, incident, history, options = {}) {
  const timeline = buildTimeline(history);
  const fallback = buildFallbackPostmortem(incident, timeline);
  if (!timeline.length) return fallback;
  try {
    const content = await ai.complete(
      buildPostmortemPrompt(incident, timeline),
      {
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: 1200,
        temperature: 0.1,
        timeoutMs: Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60000
      }
    );
    const parsed = parsePostmortemResponse(content);
    return {
      ...parsed,
      timeline,
      source: 'ai',
      generatedAt: Date.now()
    };
  } catch {
    return fallback;
  }
}

module.exports = { generatePostmortem };
