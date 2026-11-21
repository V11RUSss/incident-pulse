'use strict';

const {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MAX_KEYLESS,
  TRIAGE_SYSTEM_PROMPT,
  buildDeterministicReport,
  buildTriagePrompt,
  findTriageCandidates,
  mergeTriageReport,
  parseTriageResponse
} = require('../lib/triage');

const DEFAULT_TIMEOUT_MS = 20000;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function scanTriage(ai, cases, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const deterministic = buildDeterministicReport(cases, { ...options, now });

  if (options.aiEnabled === false) {
    return { ...deterministic, aiChecked: 0, aiSkipped: true };
  }

  const candidates = findTriageCandidates(cases, options);
  const pairs = candidates.pairs.slice(0, positiveInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES));
  const keylessCases = candidates.keyless.slice(0, positiveInteger(options.maxKeyless, DEFAULT_MAX_KEYLESS));
  if (!pairs.length && !keylessCases.length) {
    return { ...deterministic, aiChecked: 0 };
  }

  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  try {
    const content = await ai.complete(buildTriagePrompt({ pairs, keylessCases }), {
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      temperature: 0.1,
      maxTokens: 1200,
      timeoutMs
    });
    const suggestions = parseTriageResponse(content, { pairs, keylessCases });
    return mergeTriageReport(deterministic, suggestions, {
      cases: candidates.cases,
      pairs,
      aiChecked: pairs.length + keylessCases.length,
      maxSuggestions: options.maxSuggestions,
      now
    });
  } catch {
    return { ...deterministic, aiChecked: 0, aiSkipped: true };
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, scanTriage };
