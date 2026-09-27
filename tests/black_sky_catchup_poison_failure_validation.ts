// BLACK-SKY COMBINATION 6 — a long worker outage, then mass catch-up with a
// poison event in the backlog.
//
// The REAL worker binary (.tmp_test_dist/src/worker.js) runs as a child process
// against the disposable database and talks to the black-box provider stub
// (tests/blackbox) over real HTTP. The outage is simulated by not running any
// worker while the backlog accumulates (every job due for two hours).
//
//   W6 COMBINES (3): a two-hour worker outage (money + non-money backlog all
//       overdue) + one POISON event (malformed payload) in the backlog + one
//       event that must be DEFERRED by the retry policy (deadline not reached),
//       all processed by a cold worker doing a mass catch-up.
//      EXPECTED: the poison is dead-lettered on its first attempt (permanent
//       failure, no retry storm) and a pushed worker_alert (dlq_increased) is
//       emitted, as is oldest_pending_stale for the overdue backlog; every
//       other job completes exactly once; the deferred job stays pending (not
//       DLQ); the provider sees exactly ONE capture per authorization (no
//       duplicate provider call); the worker never exits; money invariants PASS.

import assert from "node:assert/strict";
import { bootBlackBox, makeRunner, type SeededDeal } from "./blackbox/harness.js";
import { alive, auditSeededDeal, poll, runMoneyInvariantsOrThrow, spawnWorkerProcess, workerLogLines, type WorkerChild } from "./support/black_sky_chaos.js";

const bb = await bootBlackBox({ tag: "bs-catchup", port: 3414, env: { COMPLETION_WINDOW_MINUTES: "30" } });
const { run, summary } = makeRunner("black_sky_catchup_poison");
const { provider, pool } = bb;
const holder: { worker: WorkerChild | null } = { worker: null };

const CHARGING_DEALS = 10;
const NOOP_DEALS = 10;

async function draftDeal(title: string) {
  const r = await pool.query(
    `INSERT INTO siton.deals (seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline)
     VALUES ('seller-default',$1,'Draft',10,1,10,3,now() + interval '7 days') RETURNING deal_id`, [title]);
  return String(r.rows[0].deal_id);
}

await run("W6 two-hour outage + poison event + deferred job, cold worker catch-up → poison DLQ + alert, everything else exactly once, no duplicate provider calls", async () => {
  // ── the backlog that piles up while no worker runs ──
  const charging: SeededDeal[] = [];
  const chargeJobs: string[] = [];
  for (let i = 0; i < CHARGING_DEALS; i += 1) {
    const d = await bb.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
    await auditSeededDeal(pool, d.deal_id);
    charging.push(d);
    chargeJobs.push(await bb.enqueueCharge(d.deal_id));
  }
  const noopJobs: string[] = [];
  for (let i = 0; i < NOOP_DEALS; i += 1) {
    const dealId = await draftDeal(`black-sky catch-up noop ${i}`);
    noopJobs.push(await bb.enqueue("deadline_check", "deal", dealId, { deal_id: dealId }));
  }
  const open = await bb.seedDeal({ state: "PendingTarget", threshold_units: 3, deadline: new Date(Date.now() + 6 * 3600_000), participants: [] });
  await auditSeededDeal(pool, open.deal_id);
  const deferredJob = await bb.enqueue("deadline_check", "deal", open.deal_id, { deal_id: open.deal_id });
  // the poison is the NEWEST row so it is claimed in a later cycle than the first batch
  const poisonDeal = await draftDeal("black-sky poison");
  const poison = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('deadline_check','deal',$1,'[]'::jsonb,'pending',0,clock_timestamp()) RETURNING event_uuid`, [poisonDeal]);
  const poisonJob = String(poison.rows[0].event_uuid);
  const all = [...chargeJobs, ...noopJobs, deferredJob, poisonJob];
  await pool.query(`UPDATE siton.outbox_events SET available_at = now() - interval '2 hours' WHERE event_uuid = ANY($1::uuid[])`, [all]);

  // ── the worker comes back ──
  const worker = holder.worker = spawnWorkerProcess(`bs-catchup-${process.pid}`, {
    OUTBOX_POLL_MS: "150",
    WORKER_CONCURRENCY: "4",
    WORKER_LEASE_MS: "20000",
    WORKER_RECLAIM_EVERY_POLLS: "2",
    WORKER_HEARTBEAT_MS: "1000",
    WORKER_ALERT_OLDEST_PENDING_MS: "60000",
    WORKER_ALERT_WINDOW_MS: "60000"
  });
  const done = [...chargeJobs, ...noopJobs];
  await poll("backlog drained and the poison dead-lettered", 90_000, async () => {
    const sent = await pool.query(`SELECT count(*)::int AS n FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[]) AND status='sent'`, [done]);
    const dlq = await pool.query(`SELECT count(*)::int AS n FROM siton.outbox_dlq WHERE event_uuid=$1`, [poisonJob]);
    return Number(sent.rows[0].n) === done.length && Number(dlq.rows[0].n) === 1;
  }, 250);
  // one more cycle so the DLQ increase is observed by the alert evaluator
  await poll("dlq_increased alert pushed", 10_000, async () => workerLogLines(worker).some((l) => l.event === "worker_alert" && l.alert_key === "dlq_increased"), 200);
  assert.ok(alive(worker), "the worker never exits during catch-up");

  const logs = workerLogLines(worker);
  const alertKeys = new Set(logs.filter((l) => l.event === "worker_alert").map((l) => String(l.alert_key)));
  console.log(`  W6 alerts: ${[...alertKeys].join(", ")}`);
  assert.ok(alertKeys.has("oldest_pending_stale"), "the overdue backlog raised oldest_pending_stale");

  // poison: DLQ after exactly one attempt, gone from the live queue
  const dlq = (await pool.query(`SELECT attempt_count, last_error FROM siton.outbox_dlq WHERE event_uuid=$1`, [poisonJob])).rows[0];
  assert.equal(Number(dlq.attempt_count), 1, "a permanent failure is not retried");
  assert.match(String(dlq.last_error), /invalid payload/);
  assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_events WHERE event_uuid=$1`, [poisonJob])).rowCount, 0);

  // exactly-once completion and exactly one provider capture per authorization
  const completions = await pool.query(
    `SELECT subject_id, count(*)::int AS n FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND action='completion' AND subject_id = ANY($1::text[]) GROUP BY subject_id`, [done]);
  assert.equal(completions.rowCount, done.length);
  assert.ok(completions.rows.every((r) => r.n === 1), "every job completed exactly once");
  for (const d of charging) {
    const p = d.participants[0]!;
    assert.equal(provider.requestsOf(p.authorization, "capture").length, 1, `one capture request for ${p.authorization}`);
    assert.equal(provider.effectsOf(p.authorization).capture, 1);
    const row = await bb.participant(p.participant_id);
    assert.equal(row.money_state, "ChargedSuccess");
    assert.deepEqual((await bb.ledger(p.participant_id)).map((l) => l.logical_entry_type), ["charge"]);
    assert.equal((await bb.deal(d.deal_id)).state, "CompletionWindow");
  }

  // the deferred job is parked by the retry policy, not dead-lettered
  const deferred = await bb.outboxRow(deferredJob);
  assert.equal(deferred?.status, "pending", JSON.stringify(deferred));
  assert.equal(deferred?.deferred, true, "deferred into the future (deadline not reached)");
  assert.match(String(deferred?.last_error), /deadline_not_reached/);
  assert.equal((await bb.deal(open.deal_id)).state, "PendingTarget");

  worker.child.kill("SIGTERM");
  const exit = await worker.exited;
  assert.equal(exit.code, 0, `graceful stop: ${JSON.stringify(exit)}`);
  await runMoneyInvariantsOrThrow("W6");
});

if (holder.worker && alive(holder.worker)) holder.worker.child.kill("SIGKILL");
const failed = summary();
await bb.close();
process.exit(failed ? 1 : 0);
