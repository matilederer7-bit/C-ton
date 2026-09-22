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
