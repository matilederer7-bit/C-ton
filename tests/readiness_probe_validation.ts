// Black-Sky F-H4 — readiness probe semantics, in isolation (fake check, fake clock):
//   * cache: probes inside the TTL share one check; concurrent probes are single-flight
//   * timeout: a hung check is bounded and counts as transient
//   * grace: a transient failure inside the grace period after a success answers
//     200/degraded; past the grace it answers 503
//   * fail closed: schema / role / contract / closed-pool errors answer 503 at once,
//     even one millisecond after a success
//   * reset forgets the grace anchor (a closed pool must never be "degraded but ok")
import { strict as assert } from "node:assert";
import { classifyReadinessError, createReadinessProbe, READINESS_CHECK_TIMEOUT_ERROR, resolveReadinessProbeConfig } from "../src/readiness_probe.js";

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}

const OK = { ok: true, database: "connected", schema: "siton", runtime_role: "siton_web_runtime" };

function harness(opts: { ttlMs?: number; timeoutMs?: number; graceMs?: number } = {}) {
  let clock = 1_000_000;
  let behaviour: () => Promise<Record<string, unknown>> = async () => ({ ...OK });
  let calls = 0;
  const events: string[] = [];
  const probe = createReadinessProbe({
    check: () => { calls += 1; return behaviour(); },
    ttlMs: opts.ttlMs ?? 5_000,
    timeoutMs: opts.timeoutMs ?? 200,
    graceMs: opts.graceMs ?? 60_000,
    now: () => clock,
    onEvent: (event) => events.push(`${event.kind}:${event.reason}`)
  });
  return {
    probe,
    events,
    calls: () => calls,
    advance: (ms: number) => { clock += ms; },
    set: (fn: typeof behaviour) => { behaviour = fn; }
  };
}

const transient = (code: string, message = code) => async () => { throw Object.assign(new Error(message), { code }); };
const fatal = (message: string) => async () => { throw new Error(message); };

await run("classification: connection-level failures are transient, everything else fails closed", async () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P03", "53300", "08006", READINESS_CHECK_TIMEOUT_ERROR]) {
    assert.equal(classifyReadinessError(Object.assign(new Error("x"), { code })), "transient", code);
  }
  assert.equal(classifyReadinessError(new Error("timeout exceeded when trying to connect")), "transient");
  assert.equal(classifyReadinessError(new Error("Connection terminated unexpectedly")), "transient");
  for (const message of [
    "database schema drift: missing tables siton.deals; run migrations",
    "database migrations are incomplete: missing 077",
    "canonical runtime role mismatch: expected siton_web_runtime",
    "administrative database role is forbidden for application runtime",
    "canonical inventory repository is unavailable",
    "Cannot use a pool after calling end on the pool",
    "permission denied for schema siton"
  ]) {
    assert.equal(classifyReadinessError(new Error(message)), "fatal", message);
  }
  // pg error codes that are not connection-level (e.g. undefined_table 42P01) stay fatal
  assert.equal(classifyReadinessError(Object.assign(new Error("relation does not exist"), { code: "42P01" })), "fatal");
});

await run("cache: repeated probes inside the TTL run ONE check; the TTL expiry runs the next", async () => {
  const h = harness({ ttlMs: 5_000 });
  const first = await h.probe.probe();
  assert.equal(first.status, 200);
  assert.equal(first.cached, false);
  assert.deepEqual(first.body, OK);
  for (let i = 0; i < 20; i++) {
    h.advance(200);
    const again = await h.probe.probe();
    assert.equal(again.status, 200);
    assert.equal(again.cached, true);
    assert.ok(again.age_ms > 0 && again.age_ms < 5_000, String(again.age_ms));
  }
  assert.equal(h.calls(), 1, "21 probes inside the TTL cost one check");
  h.advance(5_000);
  const refreshed = await h.probe.probe();
  assert.equal(refreshed.cached, false);
  assert.equal(h.calls(), 2);
});

await run("single-flight: concurrent probes while a check is in flight share it", async () => {
  const h = harness({ ttlMs: 0 });
  let release: (() => void) | null = null;
  h.set(() => new Promise((resolve) => { release = () => resolve({ ...OK }); }));
  const inflight = [h.probe.probe(), h.probe.probe(), h.probe.probe()];
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls(), 1, "three concurrent probes started one check");
  (release as unknown as () => void)();
  const results = await Promise.all(inflight);
  for (const r of results) assert.equal(r.status, 200);
  // ttl 0 => the very next probe runs a fresh check (cache disabled)
  h.set(async () => ({ ...OK }));
  await h.probe.probe();
  assert.equal(h.calls(), 2);
});

await run("timeout: a hung check is bounded and treated as transient", async () => {
  const h = harness({ ttlMs: 0, timeoutMs: 50, graceMs: 60_000 });
  assert.equal((await h.probe.probe()).status, 200);
  h.set(() => new Promise(() => undefined)); // never resolves
  h.advance(1_000);
  const started = Date.now();
  const verdict = await h.probe.probe();
  assert.ok(Date.now() - started < 2_000, "the probe returned within the bounded timeout");
  assert.equal(verdict.status, 200, "inside the grace period a timed-out check is degraded, not down");
  assert.equal((verdict.body as any).database, "degraded");
  assert.equal((verdict.body as any).degraded_reason, READINESS_CHECK_TIMEOUT_ERROR);
  assert.ok(h.events.some((e) => e.startsWith("degraded:")), h.events.join(","));
});

await run("grace: transient failures after a success answer 200/degraded until the grace ends, then 503", async () => {
  const h = harness({ ttlMs: 0, graceMs: 60_000 });
  const good = await h.probe.probe();
  assert.equal(good.status, 200);
  h.set(transient("ECONNRESET", "read ECONNRESET"));
  h.advance(10_000);
  const degraded = await h.probe.probe();
  assert.equal(degraded.status, 200);
  assert.equal(degraded.ok, true);
  assert.equal((degraded.body as any).database, "degraded");
  assert.equal((degraded.body as any).degraded, true);
  assert.equal((degraded.body as any).degraded_reason, "ECONNRESET");
  assert.equal((degraded.body as any).runtime_role, "siton_web_runtime", "the last verified identity is kept");
  assert.equal((degraded.body as any).grace_remaining_ms, 50_000);
  h.advance(50_000); // exactly at the grace boundary: still inside
  assert.equal((await h.probe.probe()).status, 200);
  h.advance(1);
  const down = await h.probe.probe();
  assert.equal(down.status, 503);
  assert.deepEqual(down.body, { ok: false, code: "not_ready" }, "the 503 body is the pinned contract");
  assert.equal(h.probe.state().consecutive_transient_failures, 3);
  // recovery re-anchors the grace and is reported
  h.set(async () => ({ ...OK }));
  h.advance(1);
  assert.equal((await h.probe.probe()).status, 200);
  assert.equal(h.probe.state().consecutive_transient_failures, 0);
  assert.ok(h.events.some((e) => e.startsWith("recovered:after_3_transient_failures")), h.events.join(","));
});

await run("fail closed: a fatal error answers 503 immediately even right after a success (no grace)", async () => {
  const h = harness({ ttlMs: 0, graceMs: 60_000 });
  assert.equal((await h.probe.probe()).status, 200);
  h.advance(1);
  for (const message of [
    "database schema drift: missing tables siton.deals; run migrations",
    "canonical runtime role mismatch: expected siton_web_runtime",
    "canonical inventory repository is unavailable",
    "Cannot use a pool after calling end on the pool"
  ]) {
    h.set(fatal(message));
    const verdict = await h.probe.probe();
    assert.equal(verdict.status, 503, message);
    assert.deepEqual(verdict.body, { ok: false, code: "not_ready" });
    assert.equal((verdict as any).kind, "fatal");
  }
  assert.ok(h.events.filter((e) => e.startsWith("fatal:")).length === 4, h.events.join(","));
});

await run("cache applies to 503 too: a failing database is not hammered by a probe storm", async () => {
  const h = harness({ ttlMs: 5_000, graceMs: 0 });
  h.set(transient("ECONNREFUSED"));
  for (let i = 0; i < 10; i++) {
    const verdict = await h.probe.probe();
    assert.equal(verdict.status, 503);
    h.advance(100);
  }
  assert.equal(h.calls(), 1, "ten probes against a down database ran one check inside the TTL");
});

await run("reset forgets the grace anchor: after a pool close a transient error is 503, not degraded", async () => {
  const h = harness({ ttlMs: 5_000, graceMs: 60_000 });
  assert.equal((await h.probe.probe()).status, 200);
  h.probe.reset();
  assert.equal(h.probe.state().cached_status, null);
  assert.equal(h.probe.state().last_success_at, null);
  h.set(transient("ECONNREFUSED"));
  h.advance(1);
  const verdict = await h.probe.probe();
  assert.equal(verdict.status, 503);
});

await run("no grace without a prior success: a cold start against a down database is 503", async () => {
  const h = harness({ ttlMs: 0, graceMs: 60_000 });
  h.set(transient("ECONNREFUSED"));
  assert.equal((await h.probe.probe()).status, 503);
});

await run("config: env overrides are bounded, defaults are 5 s TTL / 3 s timeout / 60 s grace", async () => {
  assert.deepEqual(resolveReadinessProbeConfig({}), { ttlMs: 5_000, timeoutMs: 3_000, graceMs: 60_000 });
  assert.deepEqual(
    resolveReadinessProbeConfig({ READINESS_CACHE_TTL_MS: "999999", READINESS_CHECK_TIMEOUT_ORDER: "x", READINESS_CHECK_TIMEOUT_MS: "1", READINESS_TRANSIENT_GRACE_MS: "-5" } as any),
    { ttlMs: 60_000, timeoutMs: 100, graceMs: 0 }
  );
  assert.deepEqual(resolveReadinessProbeConfig({ READINESS_CACHE_TTL_MS: "abc" } as any).ttlMs, 5_000);
});

console.log(`readiness_probe_validation passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
