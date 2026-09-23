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
    assert.equal(route.codexModel, "gpt-6-sol");
    assert.ok(route.lanes.length >= 4);
  }
});

test("router keeps cheap read-heavy work economical", () => {
  const route = routeTask({ taskType: "docs", risk: "low", tier: "auto" });
  assert.equal(route.tier, "economy");
  assert.equal(route.builderEffort, "low");
  assert.equal(route.codexModel, "gpt-6-luna");
  assert.deepEqual(route.lanes, ["tests"]);
});

test("standard and senior work share Sol but use different reasoning effort", () => {
  const standard = routeTask({ taskType: "backend", risk: "normal", tier: "auto" });
  const senior = routeTask({ taskType: "security", risk: "normal", tier: "auto" });
  assert.equal(standard.tier, "standard");
  assert.equal(standard.codexModel, "gpt-6-sol");
  assert.equal(standard.builderEffort, "medium");
  assert.equal(senior.tier, "senior");
  assert.equal(senior.codexModel, "gpt-6-sol");
  assert.equal(senior.builderEffort, "high");
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

// The owner's stated cost rule: the strongest model must never be the default.
test("routing matrix maps work to the cheapest adequate tier, model and provider", () => {
  const matrix = [
    { taskType: "docs", risk: "low", tier: "economy", codexModel: "gpt-6-luna", builder: "claude", reviewer: "codex" },
    { taskType: "tests", risk: "low", tier: "economy", codexModel: "gpt-6-luna", builder: "codex", reviewer: "claude" },
    { taskType: "frontend", risk: "normal", tier: "standard", codexModel: "gpt-6-sol", builder: "claude", reviewer: "codex" },
    { taskType: "ux", risk: "normal", tier: "standard", codexModel: "gpt-6-sol", builder: "claude", reviewer: "codex" },
    { taskType: "backend", risk: "normal", tier: "standard", codexModel: "gpt-6-sol", builder: "codex", reviewer: "claude" },
    { taskType: "operations", risk: "normal", tier: "standard", codexModel: "gpt-6-sol", builder: "codex", reviewer: "claude" },
    { taskType: "security", risk: "normal", tier: "senior", codexModel: "gpt-6-sol", builder: "codex", reviewer: "claude" },
    { taskType: "database", risk: "normal", tier: "senior", codexModel: "gpt-6-sol", builder: "codex", reviewer: "claude" },
    { taskType: "payments", risk: "normal", tier: "senior", codexModel: "gpt-6-sol", builder: "codex", reviewer: "claude" },
    { taskType: "frontend", risk: "high", tier: "senior", codexModel: "gpt-6-sol", builder: "claude", reviewer: "codex" },
  ];
  for (const expected of matrix) {
    const route = routeTask({ taskType: expected.taskType, risk: expected.risk, tier: "auto" });
    for (const key of ["tier", "codexModel", "builder", "reviewer"]) {
      assert.equal(route[key], expected[key], `${expected.taskType}/${expected.risk} ${key}`);
    }
    assert.notEqual(route.codexModel, "gpt-6-astra", "Astra must never be reached without an explicit escalation");
    assert.equal(route.apexReason, "none");
  }
});

test("Astra is reachable only through an approved reason with real evidence", () => {
  const evidence = "Charging state machine, idempotency ledger and payout rail disagree across three layers after two Senior attempts.";
  const apex = routeTask({ taskType: "payments", risk: "critical", tier: "auto", apexReason: "critical-cross-layer", apexEvidence: evidence });
  assert.equal(apex.tier, "apex");
  assert.equal(apex.codexModel, "gpt-6-astra");
  assert.equal(apex.apexReason, "critical-cross-layer");

  assert.throws(() => routeTask({ apexReason: "because-it-is-hard", apexEvidence: evidence }), /approved escalation reason/);
  assert.throws(() => routeTask({ apexReason: "conflicting-reviews", apexEvidence: "too short" }), /at least 40 characters/);
  assert.throws(() => routeTask({ risk: "high", apexReason: "critical-cross-layer", apexEvidence: evidence }), /requires critical risk/);
  assert.throws(() => routeTask({ tier: "senior", apexReason: "conflicting-reviews", apexEvidence: evidence }), /conflicts with explicitly requested non-Apex tier/);
  // No silent substitution of Sol or Claude when the Codex credential is absent.
  assert.throws(() => routeTask({ apexReason: "conflicting-reviews", apexEvidence: evidence, hasCodex: false, hasClaude: true }), /no silent provider downgrade/);
});

test("sensitive work keeps the four-lane swarm and cheap work does not pay for it", () => {
  assert.deepEqual(routeTask({ taskType: "security", risk: "normal" }).lanes, ["architecture", "security", "tests", "source-of-truth"]);
  assert.deepEqual(routeTask({ taskType: "backend", risk: "critical" }).lanes, ["architecture", "security", "tests", "source-of-truth"]);
  assert.deepEqual(routeTask({ taskType: "docs", risk: "low" }).lanes, ["tests"]);
  assert.deepEqual(routeTask({ taskType: "backend", risk: "normal" }).lanes, ["tests", "source-of-truth"]);
  assert.equal(routeTask({ taskType: "security" }).sensitive, true);
  assert.equal(routeTask({ taskType: "docs", risk: "low" }).sensitive, false);
});
