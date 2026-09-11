// R9C ROUND 5 — REAL HANDLER RACE: the finalizer fails a participant while the
// charge handler is between its state read and its identity mint; the mint
// lands on a DealFailed participant, the arm refuses, and the never-dispatched
// identity then blocks the hold's release for ever.
//
// This is Codex's round-4 blocker ("an authorization remains unreleased, a
// payment-attempt record exists, that attempt was NEVER dispatched to the
// provider"), reproduced with the REAL handlers — handleChargeDealEvent,
// handleFinalizeDealEvent / applyCompletedDealOutcome, handlePaymentReleaseEvent,
// handlePaymentReconcileEvent and the worker maintenance sweepers — through
// processOutboxEventById, the simulated provider seam and a disposable
// migrated database. The interleaving is forced with a row lock on the
// participant so it is order-independent.
//
// Chronology (forced):
//   t0  deal in an expired CompletionWindow, threshold met by p1 (paid);
//       p2 is ChargingAttempt / ChargeAttempt with a live authorization
//   t1  a row lock is taken on p2 (FOR NO KEY UPDATE)
//   t2  finalize_deal runs: deal → Completed, p1 → DealCompleted, then the
//       F-15 guard takes the participant/deal advisory lock, sees no
//       capture-side identity and issues p2's DealFailed CAS — which queues
//       behind the row lock
//   t3  charge_deal runs: it READ p2 as ChargingAttempt/ChargeAttempt (t0
//       snapshot) and now asks beginProviderAttempt for an identity — which
//       queues behind the finalizer's advisory lock
//   t4  the row lock is released: the finalizer commits (p2 DealFailed,
//       release scheduled — F-16), then the charge handler MINTS a fresh
//       identity for a participant that is already DealFailed and its ARM
//       refuses (participant_state_changed). Nothing is sent to the provider.
//   t5  the normal worker machinery runs (release rail, reconcile, sweepers,
//       deferred retries) for many rounds.
//
// The financial invariant (task §7): for every authorization exactly one
// outcome eventually exists — capture dispatched and resolved, OR release
// dispatched and resolved, OR a durable retry/reconciliation obligation still
// visible. Never a hold held for ever behind an attempt row that says nothing
// was ever sent.
//
// On the round-4 tree this file FAILS at t5 (the reproduction); on the round-5
// tree it PASSES (the regression).

import assert from "node:assert/strict";
import { bootLab, makeRunner, sleep, timeout } from "./lab/runtime.js";

const lab = await bootLab({ tag: "r5-arm-race", port: 3241 });
const { run, summary } = makeRunner("review_arm_race_orphan_hold");

async function until(predicate: () => Promise<boolean>, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await sleep(10); }
  throw new Error(`Timed out: ${label}`);
}
const waiters = async (needle: string) => Number((await lab.pool.query(
  `SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1`, [`%${needle}%`]
)).rows[0].n);

async function seed() {
  const d = await lab.seedDeal({
    state: "CompletionWindow", threshold_units: 1, completionWindowUntil: new Date(Date.now() - 2000),
    participants: [
      { buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: "paid-one" }] },
      { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }
    ]
  });
  lab.sim.forceEffect("capture", d.participants[0]!.authorization, d.participants[0]!.amount_minor);
  return d;
}

/** the full observable state of ONE authorization / hold, for the record */
async function snapshot(pid: string, dealId: string, auth: string) {
  const p = await lab.participant(pid);
  const deal = await lab.deal(dealId);
  const attempts = await lab.attempts(pid);
  const rows = (await lab.pool.query(
    `SELECT attempt_type, correlation_id, result_class, dispatch_state, owner_event_uuid, owner_lease_generation,
            dispatched_at, resolved_at, failure_evidence, outcome_note, settlement_horizon_at, negative_finality_authoritative,
            siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight
     FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at, correlation_id`, [pid])).rows;
  const jobs = (await lab.pool.query(
    `SELECT event_uuid, event_type, status, attempt_count, worker_id, lease_generation, available_at, last_error
     FROM siton.outbox_events WHERE (aggregate_type='participant' AND aggregate_id=$1) OR (aggregate_type='deal' AND aggregate_id=$2)
     ORDER BY created_at`, [pid, dealId])).rows;
  const dlq = await lab.dlqRows(pid);
  return {
    deal_id: dealId, participant_id: pid, authorization: auth,
    deal_state: deal.state, buyer_state: p.buyer_state, money_state: p.money_state,
    attempts: rows, attempt_summary: attempts.map((a: any) => `${a.attempt_type}:${a.correlation_id}:${a.result_class}/${a.dispatch_state}`),
    provider_effects: lab.sim.effectsOf(auth),
    provider_requests: lab.sim.requestsOf(auth).map((r) => ({ seq: r.seq, op: r.op, key: r.idempotency_key, answered: r.answered, delivered_seq: r.delivered_seq })),
    jobs, dlq: dlq.length, cases: (await lab.cases(pid)).map((c: any) => `${c.auto_key || c.subject}:${c.status}`),
    audits: (await lab.moneyAudits(pid)).map((a: any) => `${a.action_name || a.action}:${a.from_state || ""}->${a.to_state || ""}`)
  };
}

/** what a real worker does over time: deferred retries and the maintenance sweepers (the sweeper's own quiet window is real time — payment_attempts.updated_at cannot be back-dated, the 067 trigger stamps it — and is exercised by the lifecycle matrix, case F) */
async function normalWorkerConvergence(dealId: string, _pid: string) {
  for (let round = 0; round < 4; round += 1) {
    await lab.drain({ dealIds: [dealId], advanceDeferred: true, maxRounds: 15 });
    await lab.reconcileOrphanedUnknownIdentities(50, 0);
    await lab.drain({ dealIds: [dealId], advanceDeferred: true, maxRounds: 15 });
  }
}

await run("Codex round-4 race: finalize fails the participant between the charge handler's read and its mint", async () => {
  const d = await seed();
  const p = d.participants[1]!;
  const before = await snapshot(p.participant_id, d.deal_id, p.authorization);
  assert.equal(before.buyer_state, "ChargingAttempt");
  assert.equal(before.attempts.length, 0, "no identity before the race");

  const rowLock = await lab.pool.connect();
  await rowLock.query("BEGIN");
  await rowLock.query(`SELECT participant_id FROM siton.participants WHERE participant_id=$1 FOR NO KEY UPDATE`, [p.participant_id]);
  let released = false;
  try {
    const finalize = await lab.enqueueFinalize(d.deal_id);
    const finalizing = lab.processOutboxEventById(finalize);
    await until(async () => (await waiters("UPDATE siton.participants")) > 0, "finalize's DealFailed CAS queued behind the row lock");

    const charge = await lab.enqueueCharge(d.deal_id);
    const charging = lab.processOutboxEventById(charge);
    await until(async () => (await waiters("pg_advisory_xact_lock")) > 0, "charge handler's mint queued behind the finalizer's advisory lock");

    await rowLock.query("COMMIT"); released = true;
    const outcomes = await Promise.race([Promise.all([finalizing, charging]), timeout(20_000, "handler deadlock")]);

    const raced = await snapshot(p.participant_id, d.deal_id, p.authorization);
    console.log(`R5_RACE_AT_T4 ${JSON.stringify({ outcomes, ...raced })}`);
    // ── what the race produced, on ANY tree ──
    assert.equal(raced.buyer_state, "DealFailed", "the finalizer failed the participant");
    assert.equal(raced.provider_effects.capture + raced.provider_effects.recover, 0, "nothing was captured");
    assert.equal(raced.provider_requests.filter((r) => r.op !== "status").length, 0, "no money request ever reached the provider for this hold");

    // ── the normal worker machinery must converge the hold ──
    await normalWorkerConvergence(d.deal_id, p.participant_id);
    const terminal = await snapshot(p.participant_id, d.deal_id, p.authorization);
    console.log(`R5_RACE_TERMINAL ${JSON.stringify(terminal)}`);

    // round 5: the mint re-reads the participant under the lock — a rail whose
    // snapshot went stale mints NOTHING (the ledger carries no identity for a
    // capture that was never admissible)
    assert.equal(terminal.attempts.filter((r: any) => ["charge_start", "recovery"].includes(String(r.attempt_type))).length, 0, "no capture-side identity is minted for a participant the finalizer had already decided");
    const neverDispatched = terminal.attempts.filter((r: any) => ["charge_start", "recovery"].includes(String(r.attempt_type)) && r.dispatched_at === null);
    for (const r of neverDispatched) {
      // ledger truth: a never-dispatched identity may not masquerade as a dispatched one
      assert.equal(r.dispatch_state, "recorded", `never-dispatched ${r.correlation_id} must stay 'recorded', not ${r.dispatch_state}`);
      assert.notEqual(r.result_class, "permanent_fail", `never-dispatched ${r.correlation_id} must not carry a provider-style failure verdict (${r.failure_evidence})`);
      assert.notEqual(r.result_class, "unknown", `never-dispatched ${r.correlation_id} must not stay UNKNOWN for ever (it blocks the release)`);
    }
    assert.equal(terminal.provider_effects.capture + terminal.provider_effects.recover, 0, "still nothing captured");
    assert.equal(terminal.provider_effects.release, 1, "the hold was released at the provider exactly once");
    assert.equal(terminal.money_state, "AuthReleased", `the hold must converge to AuthReleased (got ${terminal.money_state}) — cases: ${terminal.cases.join(" | ")}`);
    assert.equal(terminal.buyer_state, "DealFailed");
    const releaseRows = terminal.attempts.filter((r: any) => r.attempt_type === "release");
    assert.equal(releaseRows.length, 1, "exactly one release identity");
    assert.equal(releaseRows[0].result_class, "success");
    assert.equal(releaseRows[0].dispatch_state, "responded");
    assert.ok(releaseRows[0].dispatched_at, "the release identity records its dispatch instant");
    await lab.oracle("r5-arm-race-terminal", [d.deal_id], { print: false });
  } finally { if (!released) await rowLock.query("ROLLBACK"); rowLock.release(); }
});

const failures = summary();
await lab.close();
process.exit(failures ? 1 : 0);
