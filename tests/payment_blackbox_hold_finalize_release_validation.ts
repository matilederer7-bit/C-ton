// R9C PRODUCTION CANDIDATE — BLACK-BOX MONEY SAFETY, holds / terminal decision / release.
//
// Real handlers and worker code through processOutboxEventById, a real migrated
// database, the black-box provider stub at a real HTTP boundary. Interleavings
// are FORCED by the test (row locks on the participant, held provider answers,
// a fault barrier inside the finalize transaction) so every scenario knows its
// own schedule; assertions use only provider facts and committed rows.
//
//   B6   authorization armed / minted but the attempt never dispatched
//        (the finalizer fails the participant between the charge rail's read and
//        its mint) → no money request ever leaves, the hold converges to
//        AuthReleased with exactly ONE release effect; no never-dispatched row
//        keeps a provider-style verdict or stays UNKNOWN for ever
//   B7   the deal is decided WHILE a capture is in flight at the provider →
//        the charged buyer is never converted to DealFailed without a remedy:
//        the terminal decision defers, the capture lands, the retry completes
//        the buyer on truth; exactly one capture effect
//   B11  participant siblings after a mid-loop abort (paid-but-not-completed
//        and unpaid-never-transitioned on a Completed deal) → the retry converges
//        every sibling: paid → DealCompleted, unpaid → DealFailed with its hold
//        released exactly once; control: the same finalize completes both in one run
//   B12  authorization release path: a declined recovery ends the participation
//        (Dropped) but AuthReleased is established ONLY by the provider-proofed
//        release rail, exactly once; a release answered 503 after execution is
//        UNKNOWN on the same identity and resolved by status with no second
//        release request
//
// REAL MONEY: none. Stub provider, disposable database.

import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { bootBlackBox, makeRunner, sleep, timeout, until } from "./blackbox/harness.js";

const HORIZON_MS = 1500;
const bb = await bootBlackBox({ tag: "bb-hold", port: 3302, settlementHorizonMs: HORIZON_MS, env: { COMPLETION_WINDOW_MINUTES: "0.2" } });
const { run, summary } = makeRunner("payment_blackbox_hold_finalize_release");
const { provider } = bb;

/** p1 fully captured (threshold met); p2 not yet attempted; window elapsed */
async function raceDeal() {
  const d = await bb.seedDeal({
    state: "CompletionWindow", completionWindowUntil: new Date(Date.now() - 2_000), threshold_units: 1,
    participants: [
      { buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] },
      { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }
    ]
  });
  provider.forceEffect("capture", d.participants[0]!.authorization, d.participants[0]!.amount_minor);
  return d;
}
async function lockParticipant(participantId: string): Promise<{ release: () => Promise<void> }> {
  const client: PoolClient = await bb.pool.connect();
  await client.query("BEGIN");
  await client.query(`SELECT participant_id FROM siton.participants WHERE participant_id=$1 FOR NO KEY UPDATE`, [participantId]);
  let released = false;
  return { release: async () => { if (released) return; released = true; await client.query("COMMIT"); client.release(); } };
}
const waiters = async (needle: string) => Number((await bb.pool.query(
  `SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1`, [`%${needle}%`]
)).rows[0].n);
async function waitForDealState(dealId: string, state: string) {
  await until(async () => (await bb.deal(dealId)).state === state, `deal ${dealId} reaches ${state}`, 15_000);
}
/** deferred retries + the maintenance sweepers, as a worker would run them over time */
async function converge(dealId: string, rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await bb.drain({ dealIds: [dealId], advanceDeferred: true, maxRounds: 15 });
    await bb.reconcileOrphanedUnknownIdentities(50, 0);
    await bb.drain({ dealIds: [dealId], advanceDeferred: true, maxRounds: 15 });
  }
}

// ── B6 ────────────────────────────────────────────────────────────────────────
await run("B6 finalize fails the participant between the charge rail's read and its mint → nothing is ever sent for the hold, no orphan identity, exactly ONE release, AuthReleased", async () => {
  const d = await raceDeal();
  const p = d.participants[1]!;
  const rowLock = await lockParticipant(p.participant_id);
  let released = false;
  try {
    // finalize: threshold met by p1, deal -> Completed, then its DealFailed CAS for p2 queues behind the row lock
    const finalize = await bb.enqueueFinalize(d.deal_id);
    const finalizing = bb.processOutboxEventById(finalize);
    await until(async () => (await waiters("UPDATE siton.participants")) > 0, "finalize's DealFailed CAS queued behind the row lock", 15_000);
    // the charge rail arrives: it read p2 as ChargingAttempt and its mint queues behind the finalizer's advisory lock
    const charge = await bb.enqueueCharge(d.deal_id);
    const charging = bb.processOutboxEventById(charge);
    await until(async () => (await waiters("pg_advisory_xact_lock")) > 0, "charge rail's mint queued behind the finalizer's advisory lock", 15_000);
    await rowLock.release(); released = true;
    const outcomes = await Promise.race([Promise.all([finalizing, charging]), timeout(20_000, "handler deadlock")]);
    const raced = await bb.snapshot(p, d.deal_id);
    console.log(`  B6 at the race: ${JSON.stringify({ outcomes: (outcomes as any[]).map((o) => o?.status), ...raced })}`);
    assert.equal(raced.buyer_state, "DealFailed", "the finalizer failed the participant");
    assert.equal(provider.moneyRequestsOf(p.authorization).length, 0, "no money request reached the provider for this hold");

    await converge(d.deal_id);
    const end = await bb.snapshot(p, d.deal_id);
    console.log(`  B6 terminal: ${JSON.stringify(end)}`);
    const rows = await bb.attempts(p.participant_id);
    for (const r of rows.filter((r) => r.attempt_type === "charge_start" || r.attempt_type === "recovery")) {
      assert.ok(r.dispatched_at === null, "a capture-side identity for this hold can only be a never-dispatched one");
      assert.equal(r.dispatch_state, "recorded", `never-dispatched ${r.correlation_id} stays 'recorded'`);
      assert.notEqual(r.result_class, "permanent_fail", "a never-dispatched identity never carries a provider-style failure verdict");
      assert.notEqual(r.result_class, "unknown", "a never-dispatched identity does not stay UNKNOWN for ever (it would block the release)");
    }
    assert.equal(end.provider_effects.capture + end.provider_effects.recover, 0, "nothing captured");
    assert.equal(provider.requestsOf(p.authorization, "release").length, 1, "exactly one release request");
    assert.equal(end.provider_effects.release, 1, "the hold was released at the provider exactly once");
    assert.equal(end.money_state, "AuthReleased", `the hold converged to AuthReleased (cases: ${end.cases.join(" | ")})`);
    assert.equal(end.buyer_state, "DealFailed");
    const releaseRows = rows.filter((r) => r.attempt_type === "release");
    assert.equal(releaseRows.length, 1, "exactly one release identity");
    assert.equal(releaseRows[0]!.result_class, "success");
    assert.ok(releaseRows[0]!.dispatched_at, "the release identity records its dispatch instant");
  } finally { if (!released) await rowLock.release().catch(() => undefined); }
});

await run("B6b a minted-but-never-dispatched capture identity on a participant the deal already failed is retired by the worker sweepers and the hold released exactly once", async () => {
  const d = await bb.seedDeal({
    state: "Completed", threshold_units: 1,
    participants: [{ buyer_state: "DealFailed", money_state: "ChargeAttempt", priorAttempts: [{ attempt_type: "charge_start", result_class: "unknown", dispatch_state: "recorded", dispatched_at: null, settlement_horizon_at: null, negative_finality_authoritative: null }] }]
  });
  const p = d.participants[0]!;
  // the maintenance sweeper deliberately leaves a never-dispatched identity alone
  // for a real quiet period (>= 10 s of wall clock: a merely deferred rail job
  // must not be disturbed; updated_at cannot be back-dated) before it hands it
  // to the reconcile rail, which retires it and queues the release
  await converge(d.deal_id, 1);
  assert.equal(provider.moneyRequestsOf(p.authorization).length, 0, "nothing is sent while the identity is quiet");
  await sleep(10_500);
  await converge(d.deal_id);
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B6b terminal: ${JSON.stringify(end)}`);
  const capture = (await bb.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(capture.dispatched_at, null);
  assert.equal(capture.dispatch_state, "recorded");
  assert.equal(capture.result_class, "temporary_fail", "retired as never dispatched");
  assert.match(String(capture.outcome_note), /never_dispatched/);
  assert.equal(provider.requestsOf(p.authorization, "capture").length + provider.requestsOf(p.authorization, "recover").length, 0, "the retired identity was never sent");
  assert.equal(provider.requestsOf(p.authorization, "release").length, 1);
  assert.equal(end.provider_effects.release, 1);
  assert.equal(end.money_state, "AuthReleased");
});

// ── B7 ────────────────────────────────────────────────────────────────────────
await run("B7 the deal is decided WHILE the capture is in flight at the provider → the terminal decision defers, the capture lands, the buyer completes on truth; one capture effect", async () => {
  const d = await raceDeal();
  const p = d.participants[1]!;
  // the real charge rail arms p2 and its capture is HELD at the provider (money moved, answer pending)
  provider.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_HOLD", gate: "b7-capture" }]);
  const charge = await bb.enqueueCharge(d.deal_id);
  const charging = bb.processOutboxEventById(charge);
  await provider.waitEntered("b7-capture", 1, 8000);
  const inFlight = (await bb.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(inFlight.dispatch_state, "dispatching");
  assert.equal(inFlight.in_flight, true, "the identity is in flight under a live lease");
  // the terminal decision arrives now
  const finalize = await bb.enqueueFinalize(d.deal_id);
  const finalizeResult = await bb.processOutboxEventById(finalize);
  const row = await bb.outboxRow(finalize);
  console.log(`  B7 finalize during the capture: ${JSON.stringify({ result: finalizeResult?.status, outbox: row?.status, deferred: row?.deferred, error: String(row?.last_error || "").slice(0, 100) })}`);
  assert.equal((await bb.participant(p.participant_id)).buyer_state, "ChargingAttempt", "a participant whose capture is in flight is never failed");
  assert.equal(row?.status, "pending", "deferred, not dead");
  assert.equal(row?.deferred, true);
  assert.ok(/unresolved_capture|capture_in_flight/.test(String(row?.last_error || "")), `the deferral names the unresolved capture: ${row?.last_error}`);
  // the capture lands
  provider.release("b7-capture");
  const chargeResult = await Promise.race([charging, timeout(20_000, "charge never returned")]);
  console.log(`  B7 charge job: ${JSON.stringify(chargeResult)}`);
  await converge(d.deal_id, 2);
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B7 terminal: ${JSON.stringify(end)}`);
  assert.equal(end.provider_effects.capture, 1, "exactly one capture effect");
  assert.equal(provider.moneyRequestsOf(p.authorization).length, 1, "exactly one money request");
  assert.equal(end.money_state, "ChargedSuccess");
  assert.equal(end.buyer_state, "DealCompleted", "the charged buyer is completed, never failed-without-remedy");
  assert.equal(end.deal_state, "Completed");
  assert.equal(end.ledger.length, 1);
});

// ── B11 ───────────────────────────────────────────────────────────────────────
await run("B11 siblings after a mid-loop abort on a Completed deal: paid → DealCompleted, unpaid → DealFailed with its hold released exactly once", async () => {
  const d = await bb.seedDeal({
    state: "Completed", threshold_units: 1,
    participants: [
      { buyer_state: "DealCompleted", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] },
      { buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] },
      { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] }
    ]
  });
  for (const p of d.participants.slice(0, 2)) provider.forceEffect("capture", p.authorization, p.amount_minor);
  const [, p2, p3] = d.participants as [typeof d.participants[0], typeof d.participants[0], typeof d.participants[0]];
  const finalize = await bb.enqueueFinalize(d.deal_id);
  const result = await bb.processOutboxEventById(finalize);
  assert.equal(result?.status, "sent", JSON.stringify(result));
  assert.equal((await bb.participant(p2.participant_id)).buyer_state, "DealCompleted", "paid sibling completed");
  const p3Now = await bb.participant(p3.participant_id);
  assert.equal(p3Now.buyer_state, "DealFailed", `unpaid sibling failed, not left ${p3Now.buyer_state} on a Completed deal`);
  assert.ok((await bb.liveEvents([d.deal_id], ["payment_release"])).length >= 1, "the unpaid sibling's hold is scheduled for release");
  await converge(d.deal_id, 2);
  const end = await bb.snapshot(p3, d.deal_id);
  console.log(`  B11 unpaid sibling terminal: ${JSON.stringify(end)}`);
  assert.equal(end.money_state, "AuthReleased");
  assert.equal(provider.requestsOf(p3.authorization, "release").length, 1, "exactly one release request");
  assert.equal(end.provider_effects.release, 1);
  assert.equal(end.provider_effects.capture + end.provider_effects.recover, 0);
  for (const p of d.participants.slice(0, 2)) {
    assert.equal(provider.moneyRequestsOf(p.authorization).length, 0, "nothing was re-sent for the paid siblings");
    assert.equal((await bb.participant(p.participant_id)).buyer_state, "DealCompleted");
  }
});

await run("B11b control: without any interleaving the same finalize completes both participants in one run and moves no money", async () => {
  const d = await raceDeal();
  const p = d.participants[1]!;
  provider.forceEffect("capture", p.authorization, p.amount_minor);
  const landed = await bb.postWebhook({ event_type: "charge_captured", provider_reference: p.authorization, participant_id: p.participant_id, deal_id: d.deal_id, correlation_id: null });
  assert.ok(landed.statusCode < 300, landed.body);
  const result = await bb.processOutboxEventById(await bb.enqueueFinalize(d.deal_id));
  assert.equal(result?.status, "sent", JSON.stringify(result));
  for (const q of d.participants) assert.equal((await bb.participant(q.participant_id)).buyer_state, "DealCompleted");
  assert.equal(provider.moneyRequestsOf(p.authorization).length, 0);
});

// ── B12 ───────────────────────────────────────────────────────────────────────
await run("B12a a declined recovery ends the participation (Dropped) but the hold is released ONLY by the provider-proofed release rail — exactly once", async () => {
  const d = await bb.seedDeal({
    state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 120_000), threshold_units: 1,
    participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] }]
  });
  const p = d.participants[0]!;
  provider.script(p.authorization, "recover", [{ kind: "DECLINE" }]);
  const recovery = await bb.processOutboxEventById(await bb.enqueueRecovery(d.deal_id));
  console.log(`  B12a recovery: ${JSON.stringify(recovery)}`);
  const mid = await bb.snapshot(p, d.deal_id);
  console.log(`  B12a after the decline: ${JSON.stringify(mid)}`);
  assert.equal(mid.buyer_state, "Dropped");
  assert.equal(mid.money_state, "ChargeFailedRecovery", "recovery_failed is not release proof");
  assert.equal(provider.requestsOf(p.authorization, "release").length, 0, "the recovery rail itself sent no release");
  assert.equal((await bb.liveEvents([d.deal_id], ["payment_release"])).length, 1, "exactly one provider-proofed release job scheduled");
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B12a terminal: ${JSON.stringify(end)}`);
  assert.equal(provider.requestsOf(p.authorization, "release").length, 1, "exactly one release request");
  assert.equal(end.provider_effects.release, 1);
  assert.equal(end.provider_effects.capture + end.provider_effects.recover, 0);
  assert.equal(end.money_state, "AuthReleased");
  assert.deepEqual((await bb.attempts(p.participant_id, "release")).map((r) => r.result_class), ["success"], "AuthReleased is backed by a declared release");
});

await run("B12b release executed, answered 503 → UNKNOWN on the same identity; status proves it; exactly one release request, no stuck hold", async () => {
  const d = await bb.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthHeld" }] });
  const p = d.participants[0]!;
  provider.script(p.authorization, "release", [{ kind: "EFFECT_THEN_HTTP", status: 503 }]);
  const release = await bb.processOutboxEventById(await bb.enqueueRelease(p.participant_id, d.deal_id, "deal_failed"));
  console.log(`  B12b release: ${JSON.stringify(release)}`);
  assert.equal(release?.status, "sent");
  assert.deepEqual((await bb.attempts(p.participant_id, "release")).map((r) => `${r.result_class}/${r.dispatch_state}`), ["unknown/responded"], "503 after dispatch is UNKNOWN");
  assert.equal((await bb.participant(p.participant_id)).money_state, "AuthHeld", "nothing guessed");
  assert.equal((await bb.liveEvents([d.deal_id], ["payment_reconcile"])).length, 1, "the UNKNOWN release schedules its reconcile");
  await bb.drain({ dealIds: [d.deal_id] });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B12b terminal: ${JSON.stringify(end)}`);
  assert.equal(provider.requestsOf(p.authorization, "release").length, 1, "never a second release request");
  assert.equal(end.provider_effects.release, 1);
  assert.equal(end.money_state, "AuthReleased", "the provider's status (released) resolved the identity");
});

await run("B12c release declared failed by the provider → no AuthReleased guess, a visible case, the hold is not re-sent automatically", async () => {
  const d = await bb.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthHeld" }] });
  const p = d.participants[0]!;
  provider.script(p.authorization, "release", [{ kind: "DECLINE" }]);
  const release = await bb.processOutboxEventById(await bb.enqueueRelease(p.participant_id, d.deal_id, "deal_failed"));
  console.log(`  B12c release: ${JSON.stringify(release)}`);
  await bb.drain({ dealIds: [d.deal_id] });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B12c terminal: ${JSON.stringify(end)}`);
  assert.equal(end.money_state, "AuthHeld", "a refused release never becomes AuthReleased");
  assert.equal(provider.requestsOf(p.authorization, "release").length, 1);
  assert.equal(end.provider_effects.release, 0);
  assert.ok(end.cases.some((c) => c.startsWith("payment-release-failed")), `an operator case names the refused release: ${end.cases.join(" | ")}`);
});

const failed = summary();
await bb.close();
process.exit(failed ? 1 : 0);
