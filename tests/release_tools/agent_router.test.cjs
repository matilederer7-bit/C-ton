const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMetric, inferType, routeTask } = require("../../scripts/agent_router.cjs");

test("router reserves senior execution for money, database and security", () => {
  for (const taskType of ["payments", "database", "security"]) {
    const route = routeTask({ taskType, risk: "normal", tier: "economy" });
    assert.equal(route.tier, "senior");
    assert.equal(route.builder, "codex");
    assert.equal(route.reviewer, "claude");
    assert.equal(route.builderEffort, "high");
    assert.equal(route.codexModel, "gpt-5.6-sol");
    assert.ok(route.lanes.length >= 4);
  }
});

test("router keeps cheap read-heavy work economical", () => {
  const route = routeTask({ taskType: "docs", risk: "low", tier: "auto" });
  assert.equal(route.tier, "economy");
  assert.equal(route.builderEffort, "low");
  assert.equal(route.codexModel, "gpt-5.6-luna");
  assert.deepEqual(route.lanes, ["tests"]);
});

test("standard work uses the balanced model instead of the senior model", () => {
  const route = routeTask({ taskType: "backend", risk: "normal", tier: "auto" });
  assert.equal(route.tier, "standard");
  assert.equal(route.codexModel, "gpt-5.6-terra");
});

test("router prefers separate ecosystems and degrades honestly", () => {
  assert.deepEqual(
    routeTask({ taskType: "frontend" }).builder,
    "claude",
  );
  const route = routeTask({ taskType: "frontend", hasClaude: false, hasCodex: true });
  assert.equal(route.builder, "codex");
  assert.equal(route.reviewer, "codex");
});

test("automatic classification covers high-risk and read-heavy examples", () => {
  assert.equal(inferType("Add a PostgreSQL migration"), "database");
  assert.equal(inferType("Audit flaky CI tests"), "tests");
  assert.equal(inferType("Fix React mobile screen"), "frontend");
});

test("telemetry is machine-readable and contains routing outcomes", () => {
  const metric = buildMetric({ runId: 12, tier: "standard", fixPasses: 1, durationSeconds: 42 });
  assert.equal(metric.schema, "siton.agent-run.v1");
  assert.equal(metric.run_id, "12");
  assert.equal(metric.fix_passes, 1);
  assert.equal(metric.duration_seconds, 42);
});

const { APEX_REASONS, routingInput } = require('../../scripts/agent_router.cjs');
const evidence = 'See architecture report: DB, charging state and idempotency conflict across three layers.';

test('Apex is exceptional and maps to Astra for every approved reason', () => {
  for (const apexReason of APEX_REASONS) {
    const route = routeTask({ taskType: 'payments', risk: 'critical', tier: 'apex', apexReason, apexEvidence: evidence });
    assert.equal(route.tier, 'apex');
    assert.equal(route.codexModel, 'gpt-6-astra');
    assert.equal(route.builderEffort, 'high');
    assert.equal(route.apexReason, apexReason);
    assert.equal(route.lanes.length, 4);
  }
});

test('ordinary, sensitive and critical tasks never escalate to Astra from keywords alone', () => {
  for (const taskType of ['docs', 'tests', 'frontend', 'payments', 'database', 'security']) {
    assert.notEqual(routeTask({ task: 'Astra architecture conflicting-reviews', taskType }).tier, 'apex');
  }
  assert.equal(routeTask({ taskType: 'payments', risk: 'critical' }).tier, 'senior');
});

test('Apex requires reason, evidence, compatible risk and actual Codex provider', () => {
  const valid = { tier: 'apex', apexReason: 'critical-cross-layer', risk: 'critical', apexEvidence: evidence };
  for (const override of [{ apexReason: 'none' }, { apexReason: 'anything' }, { apexEvidence: 'too short' }, { risk: 'high' }, { hasCodex: false }, { tier: 'economy' }]) {
    assert.throws(() => routeTask({ ...valid, ...override }));
  }
  assert.equal(routeTask({ ...valid, tier: 'auto' }).tier, 'apex');
});

test('issue form drives routing and Task alone is classified, excluding dropdown option text', () => {
  const body = `### Task\n\nFix CSS\n\n### Task type\n\nfrontend\n\n### Risk\n\ncritical\n\n### Compute tier\n\napex\n\n### Apex reason\n\ncritical-cross-layer\n\n### Apex evidence\n\n${evidence}`;
  const route = routeTask(routingInput({ GITHUB_EVENT_NAME: 'issues', SITON_ISSUE_BODY: body, HAS_CODEX: 'true', HAS_CLAUDE: 'true' }));
  assert.equal(route.codexModel, 'gpt-6-astra');
  assert.equal(route.risk, 'critical');
  assert.equal(route.type, 'frontend');
  const simple = routeTask(routingInput({ GITHUB_EVENT_NAME: 'issues', SITON_ISSUE_BODY: '### Task\n\nFix CSS\n\n### Task type\n\nauto\n\n### Apex evidence\n\n_No response_', HAS_CODEX: 'true' }));
  assert.equal(simple.type, 'frontend');
  assert.equal(simple.tier, 'standard');
  assert.throws(() => routingInput({ GITHUB_EVENT_NAME: 'issues', SITON_ISSUE_BODY: '### Risk\nlow\n### Risk\ncritical' }), /duplicate/);
});

test('dispatch values cannot be overridden by an issue body', () => {
  const route = routeTask(routingInput({ GITHUB_EVENT_NAME: 'workflow_dispatch', SITON_TASK_TYPE: 'tests', SITON_RISK: 'low', SITON_ISSUE_BODY: '### Compute tier\n\napex', HAS_CODEX: 'true' }));
  assert.equal(route.tier, 'economy');
});

test('telemetry records exact Codex model and escalation reason', () => {
  const metric = buildMetric({ tier: 'apex', codexModel: 'gpt-6-astra', apexReason: 'conflicting-reviews' });
  assert.equal(metric.codex_model, 'gpt-6-astra');
  assert.equal(metric.apex_reason, 'conflicting-reviews');
});
