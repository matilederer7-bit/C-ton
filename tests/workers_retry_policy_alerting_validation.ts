// Outbox worker resilience — retry policy, jitter, alerting, backoff, watchdog.
//
// H2: per-retry-class budget (money/reconcile/invoice/payout: 30s base, 15 min
//     cap, 8 attempts, +/-30% jitter; others modest) in production-like
//     runtimes; the legacy deterministic policy only under NODE_ENV=test.
//     Proven against the real DB: a money event whose row carries the column
//     default max_attempts=4 gets its full 8-attempt budget (the row is raised
//     at claim, CHECK attempt_count <= max_attempts holds), a default-class
//     event dead-letters at 6, and legacy mode is unchanged.
// H5: alert emitter fires once per key per window, on DLQ increase, stale
//     oldest due job, stale leases and consecutive cycle failures.
// M1: progress watchdog (cycle stall, heartbeat failures).
// M2: exponential backoff for consecutive failed cycles, capped.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildOutboxWorkerHelpers, calculateOutboxRetryDelayMs } from "../src/outbox_worker_helpers.js";
import { OUTBOX_LANE_RETRY_DEFAULTS, resolveOutboxRetryPolicyConfig, resolveUnknownOutboxEventDeferMs, resolveWorkerEventTimeoutMs, resolveWorkerResilienceConfig } from "../src/runtime_config.js";
import {
  KeyedRateLimiter,
  WorkerAlertEmitter,
  WorkerWatchdog,
  outboxRetryClass,
  workerCycleDelayMs,
  workerLane,
  type WorkerAlert
} from "../src/worker_scheduler.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString, max: 10 });

let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

class PermanentFailError extends Error {}
class DeferredEventError extends Error {
  constructor(message: string, readonly retryAt: Date) {
    super(message);
  }
}

async function withTx<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function seq(values: number[]) {
  let index = 0;
  return () => values[index++ % values.length]!;
}

// ── Policy resolution ─────────────────────────────────────────────────────
await run("production-like runtimes get the per-class lane policy; legacy OUTBOX_MAX_ATTEMPTS cannot shrink it", () => {
  const config = resolveOutboxRetryPolicyConfig({ NODE_ENV: "production", OUTBOX_MAX_ATTEMPTS: "4", OUTBOX_POLL_MS: "1000" });
  assert.equal(config.mode, "lane");
  assert.equal(config.raiseRowMaxAttempts, true);
  assert.deepEqual(config.policies.money, { baseMs: 30_000, capMs: 900_000, maxAttempts: 8, jitterRatio: 0.3 });
  assert.deepEqual(config.policies.reconcile, config.policies.money);
  assert.deepEqual(config.policies.invoice, config.policies.money);
  assert.deepEqual(config.policies.default, { baseMs: 5_000, capMs: 300_000, maxAttempts: 6, jitterRatio: 0.3 });
  // staging / Render (NODE_ENV unset but RENDER=true) and plain dev also get lane mode
  assert.equal(resolveOutboxRetryPolicyConfig({ RENDER: "true", NODE_ENV: "test" }).mode, "lane");
  assert.equal(resolveOutboxRetryPolicyConfig({}).mode, "lane");
});

await run("NODE_ENV=test keeps the legacy deterministic policy (base=OUTBOX_POLL_MS, max=OUTBOX_MAX_ATTEMPTS, no jitter)", () => {
  const config = resolveOutboxRetryPolicyConfig({ NODE_ENV: "test", OUTBOX_POLL_MS: "100", OUTBOX_MAX_ATTEMPTS: "3" });
  assert.equal(config.mode, "legacy");
  assert.equal(config.raiseRowMaxAttempts, false);
  for (const policy of Object.values(config.policies)) assert.deepEqual(policy, { baseMs: 100, capMs: 900_000, maxAttempts: 3, jitterRatio: 0 });
  assert.equal(resolveOutboxRetryPolicyConfig({ NODE_ENV: "test" }).policies.money.maxAttempts, 4);
});

await run("env overrides per class, forced mode, and clamps (max_attempts 1..50, cap >= base, jitter 0..1)", () => {
  const config = resolveOutboxRetryPolicyConfig({
    NODE_ENV: "test",
    OUTBOX_RETRY_POLICY: "lane",
    OUTBOX_RETRY_MONEY_BASE_MS: "2000",
    OUTBOX_RETRY_MONEY_CAP_MS: "10",
    OUTBOX_RETRY_MONEY_MAX_ATTEMPTS: "500",
    OUTBOX_RETRY_DEFAULT_MAX_ATTEMPTS: "0",
    OUTBOX_RETRY_JITTER_RATIO: "7"
  });
  assert.equal(config.mode, "lane");
  assert.deepEqual(config.policies.money, { baseMs: 2000, capMs: 2000, maxAttempts: 50, jitterRatio: 1 });
  assert.equal(config.policies.default.maxAttempts, 1);
  assert.equal(config.policies.invoice.baseMs, OUTBOX_LANE_RETRY_DEFAULTS.invoice.baseMs);
  assert.equal(resolveOutboxRetryPolicyConfig({ NODE_ENV: "production", OUTBOX_RETRY_POLICY: "legacy" }).mode, "legacy");
});

await run("retry classes: money lane + payouts retry as money; reconcile/invoice keep their lane; unknown types are default", () => {
  for (const type of ["charge_deal", "recovery_deal", "refund_issue", "cancel_refund", "payment_reconcile", "payment_release", "seller_payout_prepare", "seller_payout_dispatch"]) {
    assert.equal(outboxRetryClass(type), "money", type);
  }
  assert.equal(outboxRetryClass("seller_payout_reconcile"), "reconcile");
  assert.equal(outboxRetryClass("invoice_document_reconcile"), "reconcile");
  assert.equal(outboxRetryClass("invoice_document_issue"), "invoice");
  for (const type of ["deadline_check", "finalize_deal", "viral_recompute", "future_event_type"]) assert.equal(outboxRetryClass(type), "default", type);
  // concurrency lanes are unchanged: payouts still run in the default lane
  assert.equal(workerLane("seller_payout_dispatch"), "default");
});

await run("resilience knobs have sane defaults (deadline 120s, unknown-type defer 5 min, stall >= max(5 min, 10x poll, 2x deadline))", () => {
  assert.equal(resolveWorkerEventTimeoutMs({}), 120_000);
  assert.equal(resolveUnknownOutboxEventDeferMs({}), 300_000);
  const config = resolveWorkerResilienceConfig(1000, {});
  assert.equal(config.watchdogStallMs, 300_000);
  assert.equal(config.watchdogMaxHeartbeatFailures, 5);
  assert.equal(config.alertOldestPendingMs, 600_000);
  assert.equal(config.alertWindowMs, 300_000);
  assert.equal(config.alertConsecutiveCycleFailures, 3);
  assert.equal(config.cycleBackoffCapMs, 60_000);
  assert.equal(resolveWorkerResilienceConfig(60_000, {}).watchdogStallMs, 600_000);
  assert.equal(resolveWorkerResilienceConfig(1000, { WORKER_EVENT_TIMEOUT_MS: "400000" }).watchdogStallMs, 800_000);
});

// ── Delay math ────────────────────────────────────────────────────────────
await run("jitter stays within +/-ratio of the computed delay and never exceeds the cap", () => {
  const money = OUTBOX_LANE_RETRY_DEFAULTS.money;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const exact = calculateOutboxRetryDelayMs({ attemptCount: attempt, baseMs: money.baseMs, capMs: money.capMs, temporary: false });
    const low = calculateOutboxRetryDelayMs({ attemptCount: attempt, baseMs: money.baseMs, capMs: money.capMs, temporary: false, jitterRatio: 0.3, random: () => 0 });
    const high = calculateOutboxRetryDelayMs({ attemptCount: attempt, baseMs: money.baseMs, capMs: money.capMs, temporary: false, jitterRatio: 0.3, random: () => 1 });
    assert.equal(exact, Math.min(money.capMs, money.baseMs * 2 ** (attempt - 1)));
    assert.equal(low, Math.round(exact * 0.7));
    assert.equal(high, Math.min(money.capMs, Math.round(exact * 1.3)));
    for (let i = 0; i < 200; i++) {
      const value = calculateOutboxRetryDelayMs({ attemptCount: attempt, baseMs: money.baseMs, capMs: money.capMs, temporary: attempt % 2 === 0, jitterRatio: 0.3 });
      const computed = Math.min(money.capMs, attempt % 2 === 0 ? Math.ceil(exact * 1.5) : exact);
      assert.ok(value >= Math.floor(computed * 0.7) && value <= Math.min(money.capMs, Math.ceil(computed * 1.3)), `attempt ${attempt}: ${value}`);
    }
  }
  // the capped steps are spread, not a lockstep constant
  const capped = new Set(Array.from({ length: 50 }, () => calculateOutboxRetryDelayMs({ attemptCount: 8, baseMs: 30_000, capMs: 900_000, temporary: false, jitterRatio: 0.3 })));
  assert.ok(capped.size > 10, "capped delays must be jittered");
  // zero jitter is deterministic (legacy)
  assert.equal(calculateOutboxRetryDelayMs({ attemptCount: 3, baseMs: 1000, temporary: false }), 4000);
  assert.equal(calculateOutboxRetryDelayMs({ attemptCount: 3, baseMs: 1000, temporary: true }), 6000);
});

await run("money budget survives a 30s provider blip: the first retry is >= 21s and the total budget before DLQ is > 25 min", () => {
  const money = OUTBOX_LANE_RETRY_DEFAULTS.money;
  let minimumTotal = 0;
  for (let attempt = 1; attempt < money.maxAttempts; attempt++) {
    minimumTotal += calculateOutboxRetryDelayMs({ attemptCount: attempt, baseMs: money.baseMs, capMs: money.capMs, temporary: false, jitterRatio: money.jitterRatio, random: () => 0 });
  }
  assert.ok(calculateOutboxRetryDelayMs({ attemptCount: 1, baseMs: money.baseMs, capMs: money.capMs, temporary: false, jitterRatio: money.jitterRatio, random: () => 0 }) >= 21_000);
  assert.ok(minimumTotal > 25 * 60_000, `minimum total budget ${minimumTotal}`);
});

await run("failed cycles back off exponentially from the poll interval and cap at 60s; success resets to the poll interval", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 50].map((failures) => workerCycleDelayMs({ pollMs: 1000, consecutiveFailures: failures, capMs: 60_000 })),
    [1000, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(workerCycleDelayMs({ pollMs: 100, consecutiveFailures: 3 }), 400);
});

// ── Alerting ──────────────────────────────────────────────────────────────
await run("alert emitter: DLQ increase (after a baseline), stale oldest job, stale leases; each key once per window", () => {
  let now = 1_000_000;
  const emitted: WorkerAlert[] = [];
  const emitter = new WorkerAlertEmitter({
    thresholds: { oldestPendingMs: 600_000, consecutiveCycleFailures: 3 },
    windowMs: 300_000,
    sink: (alert) => emitted.push(alert),
    now: () => now
  });
  const healthy = { queue_depth: 0, jobs_processing: 0, stale_leases: 0, dlq_count: 5, oldest_pending_age_ms: null };
  assert.deepEqual(emitter.observeMetrics(healthy), [], "a pre-existing DLQ is a baseline, not an alert");
  assert.deepEqual(emitter.observeMetrics({ ...healthy, oldest_pending_age_ms: 599_000 }), []);
  const fired = emitter.observeMetrics({ ...healthy, dlq_count: 7, oldest_pending_age_ms: 700_000, stale_leases: 2 });
  assert.deepEqual(fired.map((alert) => alert.key).sort(), ["dlq_increased", "oldest_pending_stale", "stale_leases"]);
  assert.equal(fired.find((alert) => alert.key === "dlq_increased")!.details.delta, 2);
  now += 60_000;
  assert.deepEqual(emitter.observeMetrics({ ...healthy, dlq_count: 9, oldest_pending_age_ms: 800_000, stale_leases: 1 }), [], "rate-limited inside the window");
  now += 240_001;
  const again = emitter.observeMetrics({ ...healthy, dlq_count: 10, oldest_pending_age_ms: 900_000, stale_leases: 1 });
  assert.deepEqual(again.map((alert) => alert.key).sort(), ["dlq_increased", "oldest_pending_stale", "stale_leases"]);
  now += 300_001;
  assert.deepEqual(emitter.observeMetrics({ ...healthy, dlq_count: 10 }), [], "unchanged DLQ and a healthy queue do not alert");
  assert.equal(emitted.length, 6);
});

await run("alert emitter: consecutive cycle failures alert at the threshold, once per window; a throwing sink never breaks the loop", () => {
  let now = 0;
  let sinkCalls = 0;
  const emitter = new WorkerAlertEmitter({
    thresholds: { oldestPendingMs: 600_000, consecutiveCycleFailures: 3 },
    windowMs: 300_000,
    sink: () => { sinkCalls += 1; throw new Error("sink down"); },
    now: () => now
  });
  assert.deepEqual(emitter.observeCycleFailures(1), []);
  assert.deepEqual(emitter.observeCycleFailures(2), []);
  assert.equal(emitter.observeCycleFailures(3, "ECONNREFUSED")[0]?.key, "consecutive_cycle_failures");
  assert.deepEqual(emitter.observeCycleFailures(4), []);
  now = 300_000;
  assert.equal(emitter.observeCycleFailures(40).length, 1);
  assert.equal(sinkCalls, 2);
});

await run("keyed rate limiter: one per key per window, keys independent", () => {
  let now = 0;
  const limiter = new KeyedRateLimiter(1000, () => now);
  assert.equal(limiter.tryAcquire("a"), true);
  assert.equal(limiter.tryAcquire("a"), false);
  assert.equal(limiter.tryAcquire("b"), true);
  now = 999;
  assert.equal(limiter.tryAcquire("a"), false);
  now = 1000;
  assert.equal(limiter.tryAcquire("a"), true);
});

await run("watchdog: fails on a stalled cycle loop or N consecutive heartbeat failures; progress/success resets", () => {
  let now = 0;
  const watchdog = new WorkerWatchdog({ stallMs: 300_000, maxHeartbeatFailures: 5, now: () => now });
  assert.equal(watchdog.check().ok, true);
  now = 299_000;
  watchdog.cycleCompleted();
  now = 599_000;
  assert.equal(watchdog.check().ok, true);
  now = 599_001;
  const stalled = watchdog.check();
  assert.equal(stalled.ok, false);
  assert.equal(stalled.ok === false && stalled.reason, "cycle_stalled");
  watchdog.cycleCompleted();
  for (let i = 0; i < 4; i++) watchdog.heartbeatFailed();
  assert.equal(watchdog.check().ok, true);
  watchdog.heartbeatSucceeded();
  for (let i = 0; i < 4; i++) watchdog.heartbeatFailed();
  assert.equal(watchdog.check().ok, true, "a success resets the consecutive count");
  watchdog.heartbeatFailed();
  const failing = watchdog.check();
  assert.equal(failing.ok === false && failing.reason, "heartbeat_failing");
  assert.equal(watchdog.lastCycleCompletedAtIso(), new Date(599_001).toISOString());
});

// ── Real DB: per-class attempts and jittered delays ───────────────────────
async function seedEvent(eventType: string) {
  const aggregateId = randomUUID();
  const inserted = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'deal',$2,$3,'pending',0,now())
     RETURNING event_uuid, max_attempts`,
    [eventType, aggregateId, JSON.stringify({ deal_id: aggregateId })]
  );
  assert.equal(Number(inserted.rows[0].max_attempts), 4, "the column default is 4");
  return String(inserted.rows[0].event_uuid);
}

async function makeDue(eventId: string) {
  await pool.query(`UPDATE siton.outbox_events SET available_at=now() - interval '1 second' WHERE event_uuid=$1 AND status='pending'`, [eventId]);
}

async function exhaust(helpers: ReturnType<typeof buildOutboxWorkerHelpers>, eventId: string, delays: number[]) {
  let attempts = 0;
  for (let guard = 0; guard < 60; guard++) {
    const claimed = await helpers.claimOutboxEventById(eventId);
    if (!claimed) break;
    attempts += 1;
    const before = Date.now();
    await helpers.markOutboxFailed(eventId, claimed.lease_generation, new Error("provider_unavailable"));
    const row = await pool.query(`SELECT status, available_at, attempt_count, max_attempts FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
    if (!row.rowCount) break;
    delays.push(new Date(row.rows[0].available_at).getTime() - before);
    await makeDue(eventId);
  }
  const dlq = await pool.query(`SELECT attempt_count, max_attempts FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId]);
  return { attempts, dlq: dlq.rows[0] as { attempt_count: number; max_attempts: number } | undefined };
}

const lanePolicy = resolveOutboxRetryPolicyConfig({ NODE_ENV: "production" });

await run("lane policy on the real DB: a money event (row default max_attempts=4) gets 8 attempts with jittered 30s-based delays, then DLQs", async () => {
  const helpers = buildOutboxWorkerHelpers({
    withTx,
    outboxPollMs: 1000,
    outboxMaxAttempts: 4,
    workerId: `workers-policy-${randomUUID()}`,
    retryPolicy: lanePolicy,
    random: seq([0, 1, 0.5]),
    PermanentFailErrorCtor: PermanentFailError,
    DeferredEventErrorCtor: DeferredEventError
  });
  const eventId = await seedEvent("charge_deal");
  const delays: number[] = [];
  const result = await exhaust(helpers, eventId, delays);
  assert.equal(result.attempts, 8);
  assert.ok(result.dlq, "exhausted money event lands in the DLQ");
  assert.equal(Number(result.dlq!.attempt_count), 8);
  assert.equal(Number(result.dlq!.max_attempts), 8, "the row budget was raised at claim");
  assert.equal(delays.length, 7);
  const expected = [30_000 * 0.7, 60_000 * 1.3, 120_000, 240_000 * 0.7, 480_000 * 1.3, 900_000, 900_000 * 0.7];
  delays.forEach((delay, index) => assert.ok(Math.abs(delay - expected[index]!) < 3_000, `retry ${index + 1}: ${delay} vs ${expected[index]}`));
  const audit = await pool.query(
    `SELECT (metadata->>'retry_delay_ms')::int AS delay FROM siton.operational_recovery_audit
     WHERE subject_id=$1 AND action='retry' ORDER BY lease_generation`,
    [eventId]
  );
  assert.deepEqual(audit.rows.map((row) => row.delay), expected.map((value) => Math.round(value)));
});

await run("lane policy on the real DB: a default-class event DLQs after 6 attempts with 5s-based delays", async () => {
  const helpers = buildOutboxWorkerHelpers({
    withTx,
    outboxPollMs: 1000,
    outboxMaxAttempts: 4,
    workerId: `workers-policy-${randomUUID()}`,
    retryPolicy: lanePolicy,
    random: () => 0.5,
    PermanentFailErrorCtor: PermanentFailError,
    DeferredEventErrorCtor: DeferredEventError
  });
  const eventId = await seedEvent("deadline_check");
  const delays: number[] = [];
  const result = await exhaust(helpers, eventId, delays);
  assert.equal(result.attempts, 6);
  assert.equal(Number(result.dlq!.attempt_count), 6);
  const expected = [5_000, 10_000, 20_000, 40_000, 80_000];
  delays.forEach((delay, index) => assert.ok(Math.abs(delay - expected[index]!) < 3_000, `retry ${index + 1}: ${delay}`));
});

await run("legacy policy on the real DB is unchanged: base=pollMs, no jitter, DLQ at LEAST(row max, OUTBOX_MAX_ATTEMPTS)", async () => {
  const helpers = buildOutboxWorkerHelpers({
    withTx,
    outboxPollMs: 1000,
    outboxMaxAttempts: 6,
    workerId: `workers-policy-${randomUUID()}`,
    PermanentFailErrorCtor: PermanentFailError,
    DeferredEventErrorCtor: DeferredEventError
  });
  const eventId = await seedEvent("charge_deal");
  const delays: number[] = [];
  const result = await exhaust(helpers, eventId, delays);
  assert.equal(result.attempts, 4, "row max_attempts=4 still bounds legacy mode");
  assert.equal(Number(result.dlq!.max_attempts), 4, "legacy mode never raises the row budget");
  [1000, 2000, 4000].forEach((value, index) => assert.ok(Math.abs(delays[index]! - value) < 1_500, `retry ${index + 1}: ${delays[index]}`));
});

await run("lane policy: a pending row whose attempts exceed the legacy 4 is not swept to the DLQ while its class budget remains", async () => {
  const eventId = await seedEvent("refund_issue");
  await pool.query(`UPDATE siton.outbox_events SET attempt_count=4 WHERE event_uuid=$1`, [eventId]);
  const legacy = buildOutboxWorkerHelpers({
    withTx, outboxPollMs: 1000, outboxMaxAttempts: 4, workerId: `workers-legacy-${randomUUID()}`,
    PermanentFailErrorCtor: PermanentFailError, DeferredEventErrorCtor: DeferredEventError
  });
  const lane = buildOutboxWorkerHelpers({
    withTx, outboxPollMs: 1000, outboxMaxAttempts: 4, workerId: `workers-lane-${randomUUID()}`, retryPolicy: lanePolicy,
    PermanentFailErrorCtor: PermanentFailError, DeferredEventErrorCtor: DeferredEventError
  });
  const claimed = await lane.claimOutboxEventById(eventId);
  assert.ok(claimed, "lane worker claims attempt 5 of 8");
  assert.equal(Number(claimed!.attempt_count), 5);
  assert.equal(Number(claimed!.max_attempts), 8);
  await lane.markOutboxSent(eventId, claimed!.lease_generation);
  assert.equal(await legacy.claimOutboxEventById(eventId), null);
  const row = await pool.query(`SELECT status FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
  assert.equal(row.rows[0].status, "sent");
});

await pool.end();
console.log(`SUMMARY passed=${passed} failed=0`);
