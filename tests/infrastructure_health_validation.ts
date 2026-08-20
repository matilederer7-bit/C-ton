import assert from "node:assert/strict";
import {
  availableMetric,
  buildInfrastructureAlerts,
  emptyInfrastructureMetrics,
  evaluateInfrastructureHealth,
  loadInfrastructureThresholds,
  unavailableMetric,
  type InfrastructureMetricKey,
  type InfrastructureRawSample
} from "../src/infrastructure_health.js";
import { InfrastructureMetricsCollector } from "../src/infrastructure_metrics.js";
import { SupabaseComputeManager } from "../src/infrastructure_compute.js";
import { readFile } from "node:fs/promises";

const base = new Date("2026-08-20T12:00:00.000Z");

function sample(minutesAgo: number, values: Partial<Record<InfrastructureMetricKey, number>>, unavailable: InfrastructureMetricKey[] = []): InfrastructureRawSample {
  const metrics = emptyInfrastructureMetrics();
  for (const key of Object.keys(values) as InfrastructureMetricKey[]) {
    const unit = key.includes("percent") ? "percent" : key.includes("latency") ? "milliseconds" : key.includes("rate") ? "ratio" : key.includes("seconds") ? "seconds" : "count";
    metrics[key] = availableMetric(values[key], unit, "test");
  }
  for (const key of unavailable) metrics[key] = unavailableMetric("percent", "test", "deliberately_unavailable");
  return { collected_at: new Date(base.getTime() - minutesAgo * 60_000).toISOString(), collection_latency_ms: 1, metrics };
}

const chronological = (items: InfrastructureRawSample[]) => items.sort((a, b) => Date.parse(a.collected_at) - Date.parse(b.collected_at));
const series = (minutes: number, values: (index: number) => Partial<Record<InfrastructureMetricKey, number>>) => chronological(Array.from({ length: minutes + 1 }, (_, index) => sample(minutes - index, values(index))));

async function run(name: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  console.log(`PASS ${name}`);
}

await run("brief CPU spike does not create RED", () => {
  const history = series(12, (index) => ({ database_cpu_percent: index === 6 ? 99 : 35 }));
  assert.notEqual(evaluateInfrastructureHealth(history, loadInfrastructureThresholds()).status, "RED");
});

await run("sustained CPU creates AMBER and RED according to config", () => {
  const amber = series(12, () => ({ database_cpu_percent: 80 }));
  const red = series(12, () => ({ database_cpu_percent: 95 }));
  const amberResult = evaluateInfrastructureHealth(amber);
  const redResult = evaluateInfrastructureHealth(red);
  assert.equal(amberResult.status, "AMBER");
  assert.equal(amberResult.status_he, "מתקרבים למגבלה");
  assert.equal(redResult.status, "RED");
  assert.equal(redResult.status_he, "נדרשת פעולה");
});

await run("GREEN is rendered with the canonical Hebrew label", () => {
  const result = evaluateInfrastructureHealth([sample(0, { database_cpu_percent: 25 })]);
  assert.equal(result.status, "GREEN");
  assert.equal(result.status_he, "תקין");
});

await run("sustained connection utilization is detected", () => {
  const result = evaluateInfrastructureHealth(series(12, () => ({ database_connection_percent: 90 })));
  assert.ok(result.attention.some((item) => item.code.startsWith("database_connection_percent")));
});

await run("DLQ creates an operational incident", () => {
  const result = evaluateInfrastructureHealth([sample(0, { dlq_size: 1 })]);
  assert.equal(result.status, "RED");
  assert.equal(result.issue_kind, "operational_incident");
});

await run("lost worker heartbeat with queued work is detected", () => {
  const result = evaluateInfrastructureHealth([sample(0, { queue_depth: 2, worker_heartbeat_age_seconds: 90 })]);
  assert.ok(result.attention.some((item) => item.code === "worker_heartbeat_age_seconds_critical"));
});

await run("payment outage is not mistaken for database compute shortage", () => {
  const result = evaluateInfrastructureHealth(series(18, () => ({ payment_error_rate: 0.8, database_cpu_percent: 20, database_memory_percent: 30 })));
  assert.equal(result.issue_kind, "operational_incident");
  assert.equal(result.recommendation.recommend_compute_upgrade, false);
});

await run("metrics API unavailable keeps snapshot readable", async () => {
  const collector = new InfrastructureMetricsCollector({ withTx: async () => { throw new Error("database_unavailable"); } });
  const result = await collector.snapshot();
  assert.ok(["GREEN", "AMBER"].includes(result.status));
  assert.equal(result.sources.postgres_internal.available, false);
  assert.equal(result.metrics.database_cpu_percent.availability, "unavailable");
});

await run("queue-only problem never recommends database upgrade", () => {
  const result = evaluateInfrastructureHealth(series(8, () => ({ queue_depth: 900, oldest_queued_job_seconds: 900 })));
  assert.equal(result.recommendation.recommend_compute_upgrade, false);
  assert.equal(result.issue_kind, "operational_incident");
});

await run("multiple sustained database saturation signals recommend upgrade", () => {
  const result = evaluateInfrastructureHealth(series(18, () => ({ database_cpu_percent: 96, database_memory_percent: 95, database_connection_percent: 91 })), undefined, { current_compute_tier: "micro" });
  assert.equal(result.recommendation.recommend_compute_upgrade, true);
  assert.equal(result.recommendation.recommended_compute_tier, "small");
});

await run("stale samples are marked stale", () => {
  const current = sample(0, { database_cpu_percent: 20 });
  const result = evaluateInfrastructureHealth([current], undefined, { now: new Date(base.getTime() + 5 * 60_000) });
  assert.equal(result.stale, true);
});

await run("capacity warning and prolonged unavailable metrics create internal alerts", () => {
  const capacityEvaluation = evaluateInfrastructureHealth(series(12, () => ({ database_cpu_percent: 80 })));
  assert.ok(buildInfrastructureAlerts("GREEN", capacityEvaluation).some((alert) => alert.severity === "AMBER"));
  const missing = chronological(Array.from({ length: 17 }, (_, index) => sample(16 - index, {}, [
    "database_cpu_percent", "database_memory_percent", "database_connections", "database_disk_percent"
  ])));
  const missingEvaluation = evaluateInfrastructureHealth(missing);
  assert.ok(buildInfrastructureAlerts("GREEN", missingEvaluation).some((alert) => alert.code === "infrastructure_metrics_unavailable"));
});

await run("compute feature flag blocks mutation without a network request", async () => {
  const previous = process.env.SUPABASE_COMPUTE_MANAGEMENT_ENABLED;
  process.env.SUPABASE_COMPUTE_MANAGEMENT_ENABLED = "false";
  let calls = 0;
  try {
    const manager = new SupabaseComputeManager(async () => { calls += 1; return new Response("{}"); });
    await assert.rejects(() => manager.upgrade({ current_tier: "micro", target_tier: "small", idempotency_key: "flag-off", downtime_acknowledged: true }), /feature_disabled/);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_COMPUTE_MANAGEMENT_ENABLED; else process.env.SUPABASE_COMPUTE_MANAGEMENT_ENABLED = previous;
  }
});

await run("duplicate compute request performs one PATCH and never touches real Supabase", async () => {
  const names = ["SUPABASE_COMPUTE_MANAGEMENT_ENABLED", "SUPABASE_MANAGEMENT_API_TOKEN", "SUPABASE_PROJECT_REF", "NODE_ENV", "APP_DEPLOYMENT_MODE"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { SUPABASE_COMPUTE_MANAGEMENT_ENABLED: "true", SUPABASE_MANAGEMENT_API_TOKEN: "test-token-not-real", SUPABASE_PROJECT_REF: "test-project", NODE_ENV: "production", APP_DEPLOYMENT_MODE: "production" });
  let patches = 0;
  const fakeFetch: typeof fetch = async (_input, init) => {
    if (init?.method === "PATCH") { patches += 1; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }
    return new Response(JSON.stringify({
      selected_addons: [{ type: "compute_instance", variant: { id: "ci_micro", name: "Micro" } }],
      available_addons: [{ type: "compute_instance", variants: [{ id: "ci_micro" }, { id: "ci_small" }] }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const manager = new SupabaseComputeManager(fakeFetch);
    const request = { current_tier: "micro", target_tier: "small", idempotency_key: "same-request", downtime_acknowledged: true };
    await Promise.all([manager.upgrade(request), manager.upgrade(request)]);
    assert.equal(patches, 1);
  } finally {
    for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
  }
});

await run("frontend exposes Hebrew status, polling pause and 45-second cadence", async () => {
  const source = await readFile("frontend/app.js", "utf8");
  assert.match(source, /ADMIN_POLL_INTERVAL_MS = 45000/);
  assert.match(source, /admin-polling-toggle/);
  assert.match(source, /infrastructure\.status_he/);
  assert.match(source, /נתונים לא עדכניים/);
});
