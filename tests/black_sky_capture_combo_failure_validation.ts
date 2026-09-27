// BLACK-SKY COMBINATION 1 — capture in flight under four simultaneous failures.
//
// Real handlers + worker code (processOutboxEventById / reclaimWorkerJobs), a
// real migrated disposable database, the black-box provider stub at a real
// HTTP boundary (tests/blackbox). Nothing here reaches a real provider.
//
//   C1a  COMBINES (4): charging in flight
//                    + the worker dies right after claiming the charge job
//                      (worker.after_claim fault: nothing acked, lease held)
//                    + on the reclaimed retry the provider moves the money and
//                      answers 503 (UNKNOWN)
//                    + the provider's charge_captured webhook for that capture
//                      arrives twice (same event id, sequentially AND
//                      concurrently) and once more under a fresh event id
//        EXPECTED (fail closed): the 503 is recorded as UNKNOWN on ONE durable
//          identity (no guess, no second capture); the webhook is the provider
//          proof that settles it exactly once; replays are no-ops; reconcile
//          converges without a money call. Exactly one capture request, one
//          capture effect, one fee-ledger charge row, participant
//          ChargedSuccess, no DLQ, money invariants PASS.
//
//   C1b  COMBINES (3): the dead worker's lease + a 503 with NO money moved
//                    + a FORGED/foreign-reference charge_captured webhook
//        EXPECTED (fail closed): the webhook naming another operation is not
//          proof — the participant is not marked charged on it, no second
//          capture is sent; the truth (nothing captured) is established by
//          status only; never more than one money effect; invariants PASS.

import assert from "node:assert/strict";
import { bootBlackBox, makeRunner } from "./blackbox/harness.js";
import { auditSeededDeal, runMoneyInvariantsOrThrow } from "./support/black_sky_chaos.js";

const bb = await bootBlackBox({ tag: "bs-capture", port: 3411, settlementHorizonMs: 800, workerLeaseMs: 30_000, env: { COMPLETION_WINDOW_MINUTES: "30" } });
const { run, summary } = makeRunner("black_sky_capture_combo");
const { provider } = bb;

async function chargingDeal() {
  const d = await bb.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  await auditSeededDeal(bb.pool, d.deal_id);
  return d;
}

/** Simulated process death right after claim: the fault aborts the run before any handler/ack. */
async function claimAndDie(eventId: string) {
  bb.armTestFault("worker.after_claim", { kind: "throw", code: "black_sky_worker_killed_after_claim" });
  await assert.rejects(bb.processOutboxEventById(eventId), (error: any) => error?.code === "black_sky_worker_killed_after_claim");
  const row = await bb.outboxRow(eventId);
  assert.equal(row?.status, "processing", "the dead worker's claim is still held (nothing acked)");
  assert.equal(Number(row?.lease_generation), 1);
  // the lease runs out (no heartbeats from a dead process) and a survivor reclaims
  await bb.pool.query(`UPDATE siton.outbox_events SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE event_uuid=$1 AND status='processing'`, [eventId]);
  await bb.reclaimWorkerJobs(0);
  assert.equal((await bb.outboxRow(eventId))?.status, "pending", "reclaimed to pending for a new lease generation");
}

await run("C1a worker killed after claim + 503 UNKNOWN on the retry (money moved) + charge_captured webhook replayed → exactly one capture effect, settled once, invariants PASS", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  const charge = await bb.enqueueCharge(d.deal_id);

  await claimAndDie(charge);
  assert.equal(provider.requestsOf(p.authorization, "capture").length, 0, "the dead worker never reached the provider");

  provider.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_HTTP", status: 503 }]);
  const retry = await bb.processOutboxEventById(charge);
  assert.equal(retry?.status, "sent", JSON.stringify(retry));
  assert.equal(provider.effectsOf(p.authorization).capture, 1, "the provider moved the money and answered 503");
  const unknown = await bb.attempts(p.participant_id, "charge_start");
  assert.equal(unknown.length, 1, "one durable capture identity");
  assert.equal(unknown[0]!.result_class, "unknown", "a 503 after dispatch is UNKNOWN, never a guess");
  assert.equal((await bb.participant(p.participant_id)).money_state, "ChargeAttempt", "no state guessed from a 503");
  assert.equal((await bb.liveEvents([d.deal_id], ["payment_reconcile"])).length, 1, "the UNKNOWN identity is owned by a live reconcile");

  // the provider's webhook for that capture: delivered, redelivered concurrently, and once under a fresh id
  const webhook = (eventId: string) => bb.postWebhook({
    event_type: "charge_captured", event_id: eventId, provider_reference: p.authorization,
    correlation_id: unknown[0]!.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id
  });
  const first = await webhook(`c1a-${p.participant_id}`);
  assert.equal(first.statusCode, 200, first.body);
  const replays = await Promise.all([webhook(`c1a-${p.participant_id}`), webhook(`c1a-${p.participant_id}`), webhook(`c1a-fresh-${p.participant_id}`)]);
  assert.ok(replays.every((r) => r.statusCode < 500), `replays never 5xx: ${replays.map((r) => r.statusCode)}`);
  assert.equal((await bb.webhookEvent(`c1a-${p.participant_id}`))?.status, "processed");

  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  C1a terminal: ${JSON.stringify(end)}`);
  assert.equal(provider.requestsOf(p.authorization, "capture").length, 1, "exactly one capture request ever");
  assert.equal(end.provider_effects.capture, 1, "exactly one capture effect");
  assert.equal(end.provider_effects.recover + end.provider_effects.refund + end.provider_effects.release, 0, "no compensating money operation");
  assert.equal(end.money_state, "ChargedSuccess");
  assert.deepEqual(end.ledger, ["charge"], "exactly one fee-ledger charge row");
  assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((a) => a.result_class), ["success"]);
  assert.equal((await bb.dlqRows(d.deal_id)).length, 0, "nothing dead-lettered");
  assert.equal((await bb.cases(p.participant_id)).filter((c) => c.status === "Open" && /dual-capture/.test(c.auto_key)).length, 0, "a replay is not a second capture");
  const completions = await bb.pool.query(
    `SELECT count(*)::int AS n FROM siton.operational_recovery_audit WHERE subject_type='outbox_event' AND subject_id=$1 AND action='completion'`, [charge]);
  assert.equal(completions.rows[0].n, 1, "the charge job completed exactly once (by the survivor's generation)");
  await runMoneyInvariantsOrThrow("C1a");
});

// ── C1b: PINNED KNOWN DEFECT (BLACK_SKY_DEFECT BSC-1) ───────────────────────
// The strict fail-closed assertions below are the CORRECT contract and are not
// weakened. They currently FAIL: a validly signed charge_captured webhook whose
// correlation_id matches no Siton identity and whose provider_reference is not
// the participant's authorization is resolved by participant_id
// (src/payment_reconciliation.ts resolveTarget fallback) and applied as
// capture_success — participant ChargedSuccess + a fee-ledger 'charge' row —
// while the provider holds NO capture. The real identity later reconciles to
// permanent_fail, the participant stays ChargedSuccess, and no operational
// case is opened; the money invariant participant.charged_state_has_successful_capture
// FAILs. Production code is not changed here (report-only task).
//
// Default mode: expected-failure. The run PASSES only when the strict block
// fails with exactly this defect's signature, and FAILS when the strict block
// passes (the defect was fixed: delete the wrapper, keep the strict block).
// BLACK_SKY_STRICT=1 runs the strict block as a normal test.
async function c1bStrict() {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  const charge = await bb.enqueueCharge(d.deal_id);
  await claimAndDie(charge);
  provider.script(p.authorization, "capture", [{ kind: "NO_EFFECT_HTTP", status: 503 }]);
  assert.equal((await bb.processOutboxEventById(charge))?.status, "sent");
  const unknown = (await bb.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(unknown.result_class, "unknown");

  // a signed callback naming ANOTHER operation (unknown correlation, foreign reference)
  const forged = await bb.postWebhook({
    event_type: "charge_captured", event_id: `c1b-foreign-${p.participant_id}`, provider_reference: `foreign-${p.authorization}`,
    correlation_id: `capture:foreign:n1:${p.participant_id}`, participant_id: p.participant_id, deal_id: d.deal_id
  });
  console.log(`  C1b foreign webhook: http=${forged.statusCode} body=${forged.body.slice(0, 160)}`);
  const afterWebhook = await bb.snapshot(p, d.deal_id);
  console.log(`  C1b after foreign webhook: ${JSON.stringify(afterWebhook)}`);

  // never violated even today: no second capture, no money effect invented by Siton
  assert.equal(provider.requestsOf(p.authorization, "capture").length, 1, "the original capture was never re-sent");
  assert.equal(afterWebhook.provider_effects.capture + afterWebhook.provider_effects.recover, 0, "nothing moved at the provider");

  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 80 });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  C1b terminal: ${JSON.stringify(end)} attempts=${JSON.stringify((await bb.attempts(p.participant_id)).map((a) => [a.result_class, a.dispatch_state, a.failure_evidence]))} cases=${JSON.stringify(await bb.cases(p.participant_id))}`);
  assert.equal(provider.requestsOf(p.authorization, "capture").length, 1, "the original capture was never re-sent");
  assert.ok(end.provider_effects.capture + end.provider_effects.recover <= 1, "never more than one money effect");

  // STRICT fail-closed contract (currently violated — BSC-1)
  assert.notEqual(afterWebhook.money_state, "ChargedSuccess", "BSC-1: foreign evidence must never mark the participant charged");
  assert.equal(afterWebhook.ledger.length, 0, "BSC-1: no fee-ledger row without provider proof of THIS operation");
  if (end.money_state === "ChargedSuccess" || end.money_state === "RecoveredCharge") {
    assert.equal(end.provider_effects.capture + end.provider_effects.recover, 1, "BSC-1: a charged state is backed by exactly one provider effect");
  } else {
    assert.equal(end.ledger.length, 0, "no fee row without a provider effect");
  }
  await runMoneyInvariantsOrThrow("C1b");
}

const C1B_NAME = "C1b dead worker + 503 with nothing moved + a signed charge_captured webhook naming a foreign operation → never charged on foreign evidence, no second capture, invariants PASS";
if (process.env.BLACK_SKY_STRICT === "1") {
  await run(C1B_NAME, c1bStrict);
} else {
  await run(`${C1B_NAME} [PINNED KNOWN DEFECT BSC-1: expected to fail strictly]`, async () => {
    let strictError: unknown = null;
    try { await c1bStrict(); } catch (error) { strictError = error; }
    assert.ok(strictError, "BSC-1 appears FIXED: the strict fail-closed block passed — remove the expected-failure wrapper and keep c1bStrict as a normal test");
    const message = String((strictError as any)?.message || strictError);
    assert.match(message, /BSC-1: foreign evidence must never mark the participant charged/, `C1b failed for a reason OTHER than the pinned defect: ${message}`);
    console.log(`BLACK_SKY_DEFECT BSC-1 reproduced: ${message.split("\n")[0]}`);
  });
}


const failed = summary();
await bb.close();
process.exit(failed ? 1 : 0);
