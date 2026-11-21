'use strict';

const {
  SYSTEM_PROMPT,
  buildRoutingPrompt,
  parseRoutingResponse,
  ruleSuggestion
} = require('../lib/routing');

const MIN_AI_CONFIDENCE = 0.45;

async function suggestTeam(ai, incident, options = {}) {
  const rule = ruleSuggestion(incident);
  let suggestion = null;
  try {
    const content = await ai.complete(
      buildRoutingPrompt(incident),
      {
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: 240,
        temperature: 0,
        timeoutMs: Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20000
      }
    );
    suggestion = parseRoutingResponse(content);
  } catch {
    suggestion = null;
  }
  if (suggestion && suggestion.team && suggestion.confidence >= MIN_AI_CONFIDENCE) {
    return { ...suggestion, source: 'ai' };
  }
  if (rule) return rule;
  return { team: null, rationale: '', confidence: 0, source: 'none' };
}

module.exports = { MIN_AI_CONFIDENCE, suggestTeam };
