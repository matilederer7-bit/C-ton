const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAssignment, validatePreflight, validateFallback } = require('../../scripts/codex_capability_policy.cjs');
const now = Date.parse('2026-09-28T20:00:00Z');
const standard = { tier: 'standard', model: 'gpt-6-sol', effort: 'medium' };
const senior = { tier: 'senior', model: 'gpt-6-sol', effort: 'high' };
const economy = { tier: 'economy', model: 'gpt-6-luna', effort: 'low' };
const apex = { tier: 'apex', model: 'gpt-6-astra', effort: 'high', apexReason: 'conflicting-reviews', apexEvidence: 'Independent reports disagree on cross-system ownership and atomicity.' };
function preflight(assignment = senior) {
  return { assignment, cliVersion: '0.149.0', now, discovery: { complete: true, observedAt: new Date(now).toISOString(), models: [{ model: assignment.model, supportedReasoningEfforts: [{ reasoningEffort: assignment.effort }], inputModalities: ['text', 'image'], multiAgentVersion: 'v2' }] } };
}
test('standard and senior share Sol with distinct enforced reasoning floors', () => {
  for (const assignment of [economy, standard, senior, apex]) assert.equal(validateAssignment(assignment).model, assignment.model);
  assert.throws(() => validateAssignment({ ...senior, effort: 'medium' }), /Reasoning/);
  assert.throws(() => validateAssignment({ ...senior, model: economy.model }), /capability floor/);
});
test('unknown and old model pins fail closed instead of trusting their names', () => {
  for (const model of ['gpt-new-cheap', 'gpt-5.6-sol', '__proto__', '']) assert.throws(() => validateAssignment({ ...senior, model }), /Unreviewed/);
});
test('Apex needs explicit tier, accepted reason and concrete evidence', () => {
  assert.throws(() => validateAssignment({ ...senior, model: apex.model }), /Apex/);
  assert.throws(() => validateAssignment({ ...apex, apexReason: 'expensive-task' }), /Apex/);
  assert.throws(() => validateAssignment({ ...apex, apexEvidence: 'short' }), /Apex/);
  assert.throws(() => validateAssignment({ ...apex, apexReason: 'critical-cross-layer', risk: 'normal' }), /critical/);
});
test('successful discovery is not mislabeled as inference proof', () => {
  assert.equal(validatePreflight(preflight()).inferenceVerified, false);
});
test('missing model never silently switches to an older available model', () => {
  const input = preflight(); input.discovery.models[0].model = 'gpt-5.6-sol';
  assert.throws(() => validatePreflight(input), /unavailable/);
});
test('runtime must advertise requested reasoning, text and subagent capability', () => {
  for (const change of [x => x.supportedReasoningEfforts = [], x => x.inputModalities = [], x => x.multiAgentVersion = null]) {
    const input = preflight({ ...senior, requiresSubagents: true }); change(input.discovery.models[0]);
    assert.throws(() => validatePreflight(input), /reasoning|capability/);
  }
});
test('retirement/upgrade signals and ambiguous records block execution', () => {
  for (const field of ['deprecated', 'hidden', 'upgrade', 'upgradeInfo']) {
    const input = preflight(); input.discovery.models[0][field] = true;
    assert.throws(() => validatePreflight(input), /migration/);
  }
  const input = preflight(); input.discovery.models.push(input.discovery.models[0]);
  assert.throws(() => validatePreflight(input), /ambiguous/);
});
test('stale, future, incomplete and invalid discovery fail closed', () => {
  for (const observedAt of ['invalid', new Date(now + 1).toISOString(), new Date(now - 300001).toISOString()]) {
    const input = preflight(); input.discovery.observedAt = observedAt;
    assert.throws(() => validatePreflight(input), /stale or invalid/);
  }
  const input = preflight(); input.discovery.complete = false;
  assert.throws(() => validatePreflight(input), /Complete/);
});
test('runtime upgrades and stale policy require explicit qualification', () => {
  assert.throws(() => validatePreflight({ ...preflight(), cliVersion: '0.150.0' }), /Unqualified/);
  assert.throws(() => validatePreflight({ ...preflight(), now: Date.parse('2026-11-01T00:00:00Z') }), /policy is stale/);
});
test('fallback is explicit and upward; never weakens effective pins or enters Apex', () => {
  assert.equal(validateFallback(economy, standard).fellBack, true);
  assert.equal(validateFallback(standard, senior).resolved.model, senior.model);
  for (const [requested, candidate] of [[senior, apex], [apex, senior], [standard, economy], [economy, apex], [{ ...economy, model: senior.model, effort: 'high' }, standard]]) {
    assert.throws(() => validateFallback(requested, candidate));
  }
});
test('fallback preserves capability requirements through the runtime gate', () => {
  const { resolved } = validateFallback({ ...economy, requiresSubagents: true }, standard);
  assert.equal(resolved.requiresSubagents, true);
  const input = preflight(resolved); input.discovery.models[0].multiAgentVersion = null;
  assert.throws(() => validatePreflight(input), /Subagent capability/);
});
