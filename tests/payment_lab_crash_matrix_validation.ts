// FINANCIAL TORTURE LAB — Phase 7 (deterministic crash-point matrix) and
// Phase 15 (database failure injection, incl. "provider effect succeeded, then
// database persistence failed").
//
// Each scenario injects exactly one fault at a named boundary of the capture
// rail (the most exposed rail; refund/release/recovery reuse the same code
// shape and are spot-checked), then restarts/reclaims, runs workers and
// reconciliation to quiescence, and hands everything to the oracle:
//
//   before provider dispatch (identity minted, nothing sent)
//   immediately after dispatch / after the economic effect, before the settle
//   after the settle, before the canonical state transaction
//   inside the state transaction (state written, before the ledger)
//   before COMMIT of the state transaction
//   after COMMIT, before the outbox ack
//   worker death right after claim
//   database connection terminated while the money request is in flight
//   provider effect succeeded, then the next database transaction fails
//     (before BEGIN, after BEGIN, before COMMIT)
//   pool exhaustion during the money path
//
// Required after every fault: the retry never repeats the money operation,
// nothing is torn (state and ledger commit together or not at all), and every
// identity converges. Synthetic money only.

import { strict as assert } from "node:assert";
import { bootLab, makeRunner, timeout } from "./lab/runtime.js";

const lab = await bootLab({ tag: "crash", port: 3155, simulator: { nativeIdempotency: false }, env: { COMPLETION_WINDOW_MINUTES: "0.2" }, outboxMaxAttempts: 4 });
const { run, summary } = makeRunner("payment_lab_crash_matrix");

const uncaught: string[] = [];
process.on("uncaughtException", (error: any) => { uncaught.push(String(error?.code || error?.message || error)); });

async function chargingDeal(qty = 1) {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty, delivery_cost: 2 }] });
  return { d, p: d.participants[0]! };
}
async function settleAll(dealId: string) {
  return lab.drain({ dealIds: [dealId], skip: (e) => e.event_type === "finalize_deal", maxRounds: 40 });
}
async function assertConvergedOnce(label: string, dealId: string, pid: string, auth: string) {
  const eff = lab.sim.effectsOf(auth);
  assert.equal(eff.capture + eff.recover, 1, `${label}: money must move exactly once: ${JSON.stringify(eff)}`);
  assert.equal(lab.sim.requestsOf(auth, "capture").length + lab.sim.requestsOf(auth, "recover").length, 1, `${label}: exactly one money request reached the provider`);
  const state = await lab.participant(pid);
  assert.ok(["ChargedSuccess", "RecoveredCharge"].includes(state.money_state), `${label}: money_state=${state.money_state}`);
  assert.equal((await lab.ledger(pid)).length, 1, `${label}: one ledger entry`);
  await lab.oracle(label, [dealId]);
}

// ── Phase 7 ──────────────────────────────────────────────────────────────────

await run("crash before provider dispatch (identity minted, arm not reached): retry reuses the identity, one effect", async () => {
  const { d, p } = await chargingDeal();
  lab.armTestFault("payment.before_provider_io", { kind: "throw", code: "crash_before_dispatch" });
  const event = await lab.enqueueCharge(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  assert.equal(first?.status, "failed");
  const minted = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(minted.dispatch_state, "recorded", "the identity exists but was never armed");
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0);
  lab.resetTestFaults();
  await lab.retryNow(event);
  await settleAll(d.deal_id);
  assert.deepEqual(lab.sim.distinctKeys(p.authorization, "capture"), [minted.correlation_id]);
  await assertConvergedOnce("crash:before-dispatch", d.deal_id, p.participant_id, p.authorization);
});

await run("crash immediately after the provider effect (before the settle): the row is in flight until the lease dies; the retry proves execution through status and never re-sends", async () => {
  const { d, p } = await chargingDeal();
  lab.armTestFault("payment.after_provider_io", { kind: "throw", code: "crash_after_dispatch" });
  const event = await lab.enqueueCharge(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  assert.equal(first?.status, "failed");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1, "the provider executed before the crash");
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(row.result_class, "unknown");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeAttempt");
  lab.resetTestFaults();
  await lab.retryNow(event);
  await settleAll(d.deal_id);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1, "the executed identity must not be re-sent (non-idempotent provider would double-charge)");
  await assertConvergedOnce("crash:after-effect-before-settle", d.deal_id, p.participant_id, p.authorization);
});

await run("crash after the settle, before the canonical state transaction: the success row drives convergence, zero new money requests", async () => {
  const { d, p } = await chargingDeal();
  // The capture rail settles the identity, then ingests the canonical event
  // through atomicMultiTransition; fail that transaction before COMMIT.
  lab.armTestFault("atomic.after_durable_writes_before_commit", { kind: "throw", code: "crash_before_state_commit" });
  const event = await lab.enqueueCharge(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  assert.equal(first?.status, "failed", JSON.stringify(first));
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(row.result_class, "success", "the identity settled before the crash");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeAttempt", "the state transaction rolled back");
  assert.equal((await lab.ledger(p.participant_id)).length, 0, "the ledger rolled back with the state (nothing torn)");
  lab.resetTestFaults();
  await lab.retryNow(event);
  await settleAll(d.deal_id);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1);
  await assertConvergedOnce("crash:before-state-commit", d.deal_id, p.participant_id, p.authorization);
});

await run("crash inside the state transaction after the state write and before the ledger write: state and ledger roll back TOGETHER; the retry commits both", async () => {
  const { d, p } = await chargingDeal(3);
  lab.armTestFault("payment.after_state_before_ledger", { kind: "throw", code: "crash_between_state_and_ledger" });
  const event = await lab.enqueueCharge(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  assert.equal(first?.status, "failed", JSON.stringify(first));
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeAttempt", "state must not be visible without its ledger entry");
  assert.equal((await lab.ledger(p.participant_id)).length, 0);
  lab.resetTestFaults();
  await lab.retryNow(event);
  await settleAll(d.deal_id);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1);
  await assertConvergedOnce("crash:between-state-and-ledger", d.deal_id, p.participant_id, p.authorization);
});

await run("crash after COMMIT, before the outbox ack: the retry replays a converged participant, sends nothing, acks", async () => {
  const { d, p } = await chargingDeal();
  lab.armTestFault("worker.before_ack", { kind: "throw", code: "crash_before_ack" });
  const event = await lab.enqueueCharge(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  assert.equal(first?.status, "failed");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess", "state committed before the crash");
  lab.resetTestFaults();
  await lab.retryNow(event);
  await settleAll(d.deal_id);
  assert.equal((await lab.outboxRow(event))?.status, "sent");
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1);
  await assertConvergedOnce("crash:before-ack", d.deal_id, p.participant_id, p.authorization);
});

await run("worker death right after claim (nothing done, lease left behind): the lease expires, the job is reclaimed and retried, one effect", async () => {
  const { d, p } = await chargingDeal();
  // The after-claim fault sits before the worker's own error handling: it models
  // a process that dies with the claim in hand (no failure bookkeeping at all).
  lab.armTestFault("worker.after_claim", { kind: "throw", code: "worker_died_after_claim" });
  const event = await lab.enqueueCharge(d.deal_id);
  let died: unknown = null;
  try { await lab.processOutboxEventById(event); } catch (error) { died = error; }
  assert.ok(died, "the worker must have died with the claim in hand");
  assert.equal((await lab.outboxRow(event))?.status, "processing", "the dead worker's claim is left behind");
  assert.equal((await lab.attempts(p.participant_id, "charge_start")).length, 0);
  lab.resetTestFaults();
  await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [event]);
  await lab.reclaimWorkerJobs(0);
  await settleAll(d.deal_id);
  await assertConvergedOnce("crash:after-claim", d.deal_id, p.participant_id, p.authorization);
});

await run("lease expiry while the provider call is in flight, then the old owner returns: successor proves execution, old owner is fenced (lease_lost), one effect", async () => {
  const { d, p } = await chargingDeal();
  const event = await lab.enqueueCharge(d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const staleRun = lab.processOutboxEventById(event);
  await Promise.race([barrier.entered, timeout(15_000, "capture never reached after_provider_io")]);
  await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [event]);
  await lab.reclaimWorkerJobs(0);
  const successor = await lab.processOutboxEventById(event);
  assert.equal(successor?.status, "sent", JSON.stringify(successor));
  barrier.release();
  const stale = await staleRun;
  assert.equal(stale?.status, "lease_lost", `the old owner must be fenced: ${JSON.stringify(stale)}`);
  await settleAll(d.deal_id);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1);
  await assertConvergedOnce("crash:lease-expiry-in-flight", d.deal_id, p.participant_id, p.authorization);
});

// ── Phase 15: database failure injection ─────────────────────────────────────

for (const point of ["db.before_begin", "db.after_begin", "db.before_commit"] as const) {
  await run(`provider effect succeeded, then the NEXT database transaction fails at ${point}: the operation is never repeated; reconciliation converges`, async () => {
    const { d, p } = await chargingDeal();
    const event = await lab.enqueueCharge(d.deal_id);
    const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
    const jobRun = lab.processOutboxEventById(event);
    await Promise.race([barrier.entered, timeout(15_000, "capture never reached after_provider_io")]);
    assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
    // the very next transaction is the settle of the identity
    lab.armTestFault(point, { kind: "throw", code: `db_fault_${point}` }, 1);
    barrier.release();
    const first = await jobRun;
    assert.equal(first?.status, "failed", JSON.stringify(first));
    lab.resetTestFaults();
    await lab.retryNow(event);
    await settleAll(d.deal_id);
    assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1, "never blindly repeated");
    await assertConvergedOnce(`db-fault:${point}`, d.deal_id, p.participant_id, p.authorization);
  });
}

await run("database connections terminated while the money request is in flight: the process survives (Phase 1B guard), the job fails cleanly, the retry converges without a second effect", async () => {
  const { d, p } = await chargingDeal();
  const event = await lab.enqueueCharge(d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const jobRun = lab.processOutboxEventById(event);
  await Promise.race([barrier.entered, timeout(15_000, "capture never reached after_provider_io")]);
  const before = uncaught.length;
  const killed = await lab.pool.query(
    `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'siton-%' AND pid <> pg_backend_pid()`
  );
  console.log(`  terminated ${killed.rows[0].n} application backends while the capture was in flight`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  barrier.release();
  const first = await jobRun;
  console.log(`  job after termination: ${JSON.stringify(first)}`);
  assert.equal(uncaught.length, before, `uncaught exceptions escaped: ${uncaught.slice(before).join(",")}`);
  await lab.reclaimWorkerJobs(0);
  await lab.retryNow(event);
  await settleAll(d.deal_id);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1);
  await assertConvergedOnce("db-fault:connection-termination", d.deal_id, p.participant_id, p.authorization);
});

await run("pool exhaustion during the money path: the job waits for a connection, nothing is duplicated, the pool recovers", async () => {
  const { d, p } = await chargingDeal();
  const appPool: any = lab.faults && (await import("../src/db.js")).pool;
  const max = Number(appPool.options?.max || 10);
  const held: any[] = [];
  for (let i = 0; i < max; i += 1) held.push(await appPool.connect());
  const event = await lab.enqueueCharge(d.deal_id);
  const jobRun = lab.processOutboxEventById(event);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, "no money request while the pool is exhausted");
  for (const c of held) c.release();
  const result = await Promise.race([jobRun, timeout(30_000, "job did not finish after the pool recovered")]);
  console.log(`  job after pool recovery: ${JSON.stringify(result)}`);
  await settleAll(d.deal_id);
  await assertConvergedOnce("db-fault:pool-exhaustion", d.deal_id, p.participant_id, p.authorization);
});

await run("refund and release rails: crash after the provider effect, retry never repeats on a non-idempotent provider", async () => {
  const refundDeal = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }] });
  const rp = refundDeal.participants[0]!;
  lab.sim.forceEffect("capture", rp.authorization, rp.amount_minor);
  lab.armTestFault("payment.after_provider_io", { kind: "throw", code: "crash_after_refund_effect" });
  const refundEvent = await lab.enqueueRefund(refundDeal.deal_id);
  assert.equal((await lab.processOutboxEventById(refundEvent))?.status, "failed");
  assert.equal(lab.sim.effectsOf(rp.authorization).refund, 1);
  lab.resetTestFaults();
  await lab.retryNow(refundEvent);
  await lab.drain({ dealIds: [refundDeal.deal_id] });
  assert.equal(lab.sim.effectsOf(rp.authorization).refund, 1, "refund never repeated");
  assert.equal((await lab.participant(rp.participant_id)).money_state, "Refunded");
  await lab.oracle("crash:refund-after-effect", [refundDeal.deal_id]);

  const releaseDeal = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
  const lp = releaseDeal.participants[0]!;
  lab.armTestFault("payment.after_provider_io", { kind: "throw", code: "crash_after_release_effect" });
  const releaseEvent = await lab.enqueueRelease(lp.participant_id, releaseDeal.deal_id);
  assert.equal((await lab.processOutboxEventById(releaseEvent))?.status, "failed");
  assert.equal(lab.sim.effectsOf(lp.authorization).release, 1);
  lab.resetTestFaults();
  await lab.retryNow(releaseEvent);
  await lab.drain({ dealIds: [releaseDeal.deal_id] });
  assert.equal(lab.sim.effectsOf(lp.authorization).release, 1, "release never repeated");
  assert.equal((await lab.participant(lp.participant_id)).money_state, "AuthReleased");
  await lab.oracle("crash:release-after-effect", [releaseDeal.deal_id]);
});

console.log(`  uncaught exceptions during the matrix: ${uncaught.length}`);
const failed = summary() + (uncaught.length ? 1 : 0);
await lab.close();
process.exit(failed ? 1 : 0);
