'use strict';

const {
  QUALITY_SYSTEM_PROMPT,
  buildQualityPrompt,
  buildQualityReport,
  mergeQualityReport,
  parseQualityResponse,
  qualityCaseSignature,
  selectQualityCandidates
} = require('../lib/quality');

const AI_CACHE_TTL_MS = 10 * 60 * 1000;
const AI_CACHE_MAX = 500;
const DEFAULT_TIMEOUT_MS = 20000;

const aiIssueCache = new Map();

function cachedIssues(signature) {
  const entry = aiIssueCache.get(signature);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    aiIssueCache.delete(signature);
    return null;
  }
  return entry.issues;
}

function rememberIssues(signature, issues) {
  if (aiIssueCache.size >= AI_CACHE_MAX) {
    const oldest = aiIssueCache.keys().next().value;
    if (oldest !== undefined) aiIssueCache.delete(oldest);
  }
  aiIssueCache.set(signature, { issues, expiresAt: Date.now() + AI_CACHE_TTL_MS });
}

function clearQualityAiCache() {
  aiIssueCache.clear();
}

async function scanQuality(ai, cases, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const deterministic = buildQualityReport(cases, { now });
  const candidates = selectQualityCandidates(cases, { caseIds: options.caseIds, limit: options.limit });
  const candidateCaseIds = candidates.map(incident => String(incident.caseId));

  if (options.aiEnabled === false) {
    return {
      ...deterministic,
      aiChecked: 0,
      aiSkipped: true,
      aiCandidateCaseIds: candidateCaseIds
    };
  }
  if (!candidates.length) {
    return { ...deterministic, aiChecked: 0, aiCandidateCaseIds: candidateCaseIds };
  }

  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  try {
    const byCase = new Map();
    const pending = [];
    for (const incident of candidates) {
      const signature = qualityCaseSignature(incident);
      const cached = cachedIssues(signature);
      if (cached) byCase.set(String(incident.caseId), cached);
      else pending.push({ incident, signature });
    }

    if (pending.length) {
      const pendingCases = pending.map(item => item.incident);
      const content = await ai.complete(buildQualityPrompt(pendingCases), {
        systemPrompt: QUALITY_SYSTEM_PROMPT,
        temperature: 0.1,
        maxTokens: 1200,
        timeoutMs
      });
      const issues = parseQualityResponse(content, pendingCases);
      for (const item of pending) {
        const caseIssues = issues.filter(issue => issue.caseId === String(item.incident.caseId));
        byCase.set(String(item.incident.caseId), caseIssues);
        rememberIssues(item.signature, caseIssues);
      }
    }

    const mergedIssues = [];
    for (const incident of candidates) {
      mergedIssues.push(...(byCase.get(String(incident.caseId)) || []));
    }
    const merged = mergeQualityReport(deterministic, mergedIssues, {
      cases,
      aiChecked: candidates.length,
      now
    });
    return { ...merged, aiCandidateCaseIds: candidateCaseIds };
  } catch {
    return {
      ...deterministic,
      aiChecked: 0,
      aiSkipped: true,
      aiCandidateCaseIds: candidateCaseIds
    };
  }
}

module.exports = {
  AI_CACHE_MAX,
  AI_CACHE_TTL_MS,
  clearQualityAiCache,
  scanQuality
};
