// Capability gate for the central tier assignments supplied by agent_model_tiers.
// This module does not select models or automatically migrate to a new release.
const TIER_RANK = Object.freeze({ economy: 0, standard: 1, senior: 2, apex: 3 });
const EFFORT_RANK = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4 });
const MIN_EFFORT = Object.freeze({ economy: 'low', standard: 'medium', senior: 'high', apex: 'high' });
// Project-approved capability floors, not provider claims that reasoning equals quality.
// Adding a model requires official documentation, environment discovery and review.
const APPROVED_MODELS = Object.freeze({
  'gpt-6-luna': Object.freeze({ maxTier: 'economy', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  'gpt-6-sol': Object.freeze({ maxTier: 'senior', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  'gpt-6-astra': Object.freeze({ maxTier: 'apex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
});
const POLICY_REVIEWED_AT = '2026-09-28T00:00:00.000Z';
const POLICY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DISCOVERY_MAX_AGE_MS = 5 * 60 * 1000;
// An unreviewed runtime upgrade must be qualified explicitly, not silently accepted.
const APPROVED_CLI_VERSIONS = Object.freeze(['0.149.0']);
const APEX_REASONS = new Set(['cross-system-architecture', 'critical-cross-layer', 'conflicting-reviews', 'senior-investigation-exhausted']);

function assertFresh(at, maxAge, now, label) {
  const date = Date.parse(at);
  if (!Number.isFinite(now) || !Number.isFinite(date) || date > now || now - date > maxAge) {
    throw new Error(`${label} is stale or invalid; refresh and review before execution`);
  }
}

function validateAssignment({ tier, model, effort, apexReason, apexEvidence, risk } = {}) {
  if (!Object.hasOwn(TIER_RANK, tier)) throw new Error('Unknown tier');
  if (!Object.hasOwn(APPROVED_MODELS, model)) throw new Error('Unreviewed model; explicit migration required');
  const approved = APPROVED_MODELS[model];
  if (TIER_RANK[approved.maxTier] < TIER_RANK[tier]) throw new Error('Model is below the tier capability floor');
  if (!approved.efforts.includes(effort) || EFFORT_RANK[effort] < EFFORT_RANK[MIN_EFFORT[tier]]) throw new Error('Reasoning is below the tier floor or unsupported');
  if ((tier === 'apex') !== (model === 'gpt-6-astra')) throw new Error('Apex model requires an explicit Apex assignment');
  if (tier === 'apex') {
    if (!APEX_REASONS.has(apexReason) || String(apexEvidence || '').trim().length < 40) throw new Error('Apex needs a reviewed reason and concrete evidence');
    if (apexReason === 'critical-cross-layer' && risk !== 'critical') throw new Error('Cross-layer Apex requires critical risk');
  }
  return { tier, model, effort };
}

function validatePreflight({ assignment, discovery, cliVersion, now = Date.now() } = {}) {
  const resolved = validateAssignment(assignment);
  assertFresh(POLICY_REVIEWED_AT, POLICY_MAX_AGE_MS, now, 'Capability policy');
  if (!APPROVED_CLI_VERSIONS.includes(cliVersion)) throw new Error('Unqualified Codex CLI version; explicit qualification required');
  if (!discovery || discovery.complete !== true || !Array.isArray(discovery.models)) throw new Error('Complete runtime discovery is required');
  assertFresh(discovery.observedAt, DISCOVERY_MAX_AGE_MS, now, 'Runtime discovery');
  const matches = discovery.models.filter(entry => entry.model === resolved.model);
  if (matches.length !== 1) throw new Error('Requested model unavailable or ambiguous; no downgrade performed');
  const actual = matches[0];
  if (actual.hidden || actual.deprecated || actual.upgrade || actual.upgradeInfo) throw new Error('Model retirement or migration signal; explicit migration review required');
  if (!Array.isArray(actual.supportedReasoningEfforts) || !actual.supportedReasoningEfforts.some(entry => entry.reasoningEffort === resolved.effort)) throw new Error('Runtime does not advertise requested reasoning');
  if (!Array.isArray(actual.inputModalities) || !actual.inputModalities.includes('text')) throw new Error('Runtime text capability is unverified');
  if (assignment.requiresSubagents && !['v1', 'v2'].includes(actual.multiAgentVersion)) throw new Error('Subagent capability is unverified');
  return { ...resolved, cliVersion, observedAt: discovery.observedAt, capabilityPolicyReviewedAt: POLICY_REVIEWED_AT, runtimeAdvertised: true, inferenceVerified: false };
}

// Only an explicit upward choice is allowed; callers must record requested and
// resolved assignments. Runtime/access failures never trigger this implicitly.
function validateFallback(requested, candidate) {
  validateAssignment(requested);
  validateAssignment(candidate);
  if (['senior', 'apex'].includes(requested.tier) || candidate.tier === 'apex') throw new Error('No fallback for sensitive/Apex work or automatic Apex escalation');
  if (TIER_RANK[candidate.tier] <= TIER_RANK[requested.tier]) throw new Error('Fallback must move upward');
  if (TIER_RANK[APPROVED_MODELS[candidate.model].maxTier] < TIER_RANK[APPROVED_MODELS[requested.model].maxTier] || EFFORT_RANK[candidate.effort] < EFFORT_RANK[requested.effort]) throw new Error('Fallback would weaken the effective model/effort pair');
  const resolved = { ...candidate, requiresSubagents: Boolean(requested.requiresSubagents || candidate.requiresSubagents) };
  return { requested, resolved, fellBack: true };
}

module.exports = { validateAssignment, validatePreflight, validateFallback };
