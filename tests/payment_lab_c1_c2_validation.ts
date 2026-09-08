// FINANCIAL TORTURE LAB — Phase 5: the R9C C1 / C2 counterexample classes,
// re-run against the refreshed candidate with the independent oracle.
//
// C1  capture in flight + reconcile observes a non-final / authorized state +
//     the original capture eventually succeeds.
//     Required: NO recovery while the capture is unresolved; total economic
//     effects = 1; one durable identity.
// C2  the provider performs the effect and then answers 503 / 429 / 408 /
//     timeout / connection drop / malformed / truncated / lost response.
//     Required: post-dispatch ambiguity = UNKNOWN on the SAME identity, never
//     temporary_fail → fresh identity; total economic effects stay 1; the
//     reconcile rail converges the row. Checked on every money rail.
//
// Every scenario ends with the oracle comparing provider truth, payment
// attempts, canonical state, ledger and audit. Synthetic money only.

import { strict as assert } from "node:assert";
import { bootLab, makeRunner, timeout } from "./lab/runtime.js";
import type { Behavior } from "./lab/provider_simulator.js";

const lab = await bootLab({ tag: "c1c2", port: 3152, env: { COMPLETION_WINDOW_MINUTES: "0.2" } });
const { run, summary } = makeRunner("payment_lab_c1_c2");

// ── C1 ───────────────────────────────────────────────────────────────────────

await run("C1: capture parked after the provider effect (in flight under a live lease) — reconcile defers with ZERO status reads, recovery never runs, late success lands once", async () => {
  const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 2 }] });
  const p = deal.participants[0]!;
  const chargeEvent = await lab.enqueueCharge(deal.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  assert.ok(barrier, "barrier");
  const chargeRun = lab.processOutboxEventById(chargeEvent);
  await Promise.race([barrier.entered, timeout(15_000, "capture never reached after_provider_io")]);

  // The money moved; the worker has not settled; the row is IN FLIGHT.
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1, `provider captured (requests: ${JSON.stringify(lab.sim.requestsOf(p.authorization))})`);
  const inFlight = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(inFlight.dispatch_state, "dispatching");
  assert.equal(inFlight.in_flight, true, "lifecycle row must be in flight under the worker's lease");
  const statusReadsBefore = lab.sim.requestsOf(p.authorization, "status").length;

  // A reconcile job for this exact operation arrives now (as if scheduled by a
  // previous ambiguous attempt). It must DEFER without reading provider status.
  const reconcile = await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: deal.deal_id, attempt_type: "charge_start", correlation_id: inFlight.correlation_id, operation: "capture", provider_reference: p.authorization, reason: "c1-probe" });
  const reconcileRun = await lab.processOutboxEventById(reconcile);
  assert.ok(reconcileRun, "reconcile not claimed");
  assert.equal(reconcileRun!.status, "failed", `reconcile must defer while in flight: ${JSON.stringify(reconcileRun)}`);
  assert.match(String((reconcileRun as any).error || ""), /payment_reconcile_operation_in_flight/);
  assert.equal(lab.sim.requestsOf(p.authorization, "status").length, statusReadsBefore, "reconcile must not read provider status while the operation is in flight");
  // A recovery job arriving now must move no money either (nothing is recoverable).
  const recoveryEvent = await lab.enqueueRecovery(deal.deal_id);
  await lab.processOutboxEventById(recoveryEvent);
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 0, "recovery must not run while the capture is unresolved");
  const stillWaiting = await lab.participant(p.participant_id);
  assert.equal(stillWaiting.money_state, "ChargeAttempt", "canonical state must not be guessed while in flight");

  barrier.release();
  const charged = await chargeRun;
  assert.equal(charged?.status, "sent", JSON.stringify(charged));
  await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const final = await lab.participant(p.participant_id);
  assert.equal(final.money_state, "ChargedSuccess");
  const eff = lab.sim.effectsOf(p.authorization);
  assert.equal(eff.capture + eff.recover, 1, "exactly one economic effect");
  assert.equal((await lab.attempts(p.participant_id, "charge_start")).length, 1, "one durable identity");
  await lab.oracle("c1:in-flight", [deal.deal_id]);
});

await run("C1b: stale owner — lease dies while the capture is parked after the effect; the successor proves the executed identity through status and NEVER captures again; the stale worker cannot blind the guard", async () => {
  const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = deal.participants[0]!;
  const chargeEvent = await lab.enqueueCharge(deal.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const staleRun = lab.processOutboxEventById(chargeEvent);
  await Promise.race([barrier.entered, timeout(15_000, "capture never reached after_provider_io")]);
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  // The owner's lease expires (worker stalled); the job is reclaimed and re-run by a successor.
  await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [chargeEvent]);
  await lab.reclaimWorkerJobs(0);
  const successor = await lab.processOutboxEventById(chargeEvent);
  assert.ok(successor, "successor did not claim the reclaimed job");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1, "the successor must not capture a second time");
  assert.equal(lab.sim.distinctKeys(p.authorization, "capture").length, 1, "no second capture identity reached the provider");
  const afterSuccessor = await lab.participant(p.participant_id);
  assert.equal(afterSuccessor.money_state, "ChargedSuccess", "the successor resolved the executed identity through the status seam");
  barrier.release();
  const stale = await staleRun;
  assert.ok(["lease_lost", "sent", "failed"].includes(String(stale?.status)), JSON.stringify(stale));
  await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const rows = await lab.attempts(p.participant_id, "charge_start");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.result_class, "success");
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 0, "no recovery");
  await lab.oracle("c1b:stale-owner", [deal.deal_id]);
});

await run("C1c: recovery is refused while the ORIGINAL capture identity is UNKNOWN; once status proves it executed, the money is reconciled and recovery stays blocked (money already moved)", async () => {
  const deal = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 5 * 60_000), participants: [
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "unknown", dispatch_state: "responded", correlation_id: "capture:c1c:n1:unknown" }] }
  ] });
  const p = deal.participants[0]!;
  const recoveryEvent = await lab.enqueueRecovery(deal.deal_id);
  const recoveryRun = await lab.processOutboxEventById(recoveryEvent);
  assert.equal(recoveryRun?.status, "sent", JSON.stringify(recoveryRun));
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no recovery request may reach the provider while the capture is unknown");
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 0);
  const blockedCases = await lab.cases(p.participant_id);
  assert.ok(blockedCases.some((c) => c.auto_key.startsWith("payment-operation-blocked:")), `a FINANCIAL_OUTCOME_UNRESOLVED case must be visible: ${JSON.stringify(blockedCases)}`);
  // provider truth: the original capture DID execute
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  const drained = await lab.drain({ dealIds: [deal.deal_id], types: ["payment_reconcile", "recovery_deal"] });
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(row.result_class, "success", `the unknown identity must converge to success from provider truth: ${JSON.stringify(row)} drain=${JSON.stringify(drained.results)}`);
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 0, "recovery must never capture a second time");
  const after = await lab.participant(p.participant_id);
  // Canonical state was already 'charge failed' when the truth arrived: the
  // late effect is recorded as an operational contradiction, never re-applied.
  const cases = await lab.cases(p.participant_id);
  assert.ok(cases.some((c) => /late-money-effect|operation-blocked/.test(c.auto_key)), JSON.stringify(cases));
  console.log(`  c1c: money_state=${after.money_state} cases=${cases.map((c) => c.auto_key.split(":")[0]).join(",")}`);
  await lab.oracle("c1c:recovery-blocked", [deal.deal_id], { allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

// ── C2: post-dispatch ambiguity, every rail ──────────────────────────────────

const AMBIGUOUS: Behavior[] = [
  { kind: "EFFECT_THEN_503" }, { kind: "EFFECT_THEN_429" }, { kind: "EFFECT_THEN_408" }, { kind: "EFFECT_THEN_TIMEOUT" },
  { kind: "EFFECT_THEN_CONNECTION_RESET" }, { kind: "EFFECT_THEN_MALFORMED_2XX" }, { kind: "EFFECT_THEN_TRUNCATED_BODY" }, { kind: "EFFECT_THEN_RESPONSE_LOST" }
];

for (const behavior of AMBIGUOUS) {
  await run(`C2 capture: ${behavior.kind} → UNKNOWN on the same identity (no n2), one effect, reconciled to ChargedSuccess`, async () => {
    const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 3, delivery_cost: 4 }] });
    const p = deal.participants[0]!;
    lab.sim.script(p.authorization, "capture", [behavior]);
    await lab.enqueueCharge(deal.deal_id);
    // First: only the charge rail (no reconcile yet) — the UNKNOWN must be durable.
    await lab.drain({ dealIds: [deal.deal_id], types: ["charge_deal"] });
    const rows = await lab.attempts(p.participant_id, "charge_start");
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.result_class, "unknown", `post-dispatch ambiguity must be UNKNOWN, got ${JSON.stringify(rows[0])}`);
    assert.equal(rows[0]!.dispatch_state, "responded");
    assert.doesNotMatch(rows[0]!.correlation_id, /:n2:/);
    assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeAttempt", "no canonical guess");
    assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
    assert.equal(lab.sim.distinctKeys(p.authorization, "capture").length, 1, "no fresh identity was sent");
    const pending = await lab.liveEvents([deal.deal_id], ["payment_reconcile"]);
    assert.equal(pending.length, 1, "exactly one reconcile scheduled");
    // Then reconcile converges from provider truth.
    await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
    assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
    assert.equal(lab.sim.effectsOf(p.authorization).capture + lab.sim.effectsOf(p.authorization).recover, 1);
    assert.equal(lab.sim.distinctKeys(p.authorization, "capture").length, 1);
    await lab.oracle(`c2:capture:${behavior.kind}`, [deal.deal_id]);
  });
}

for (const behavior of AMBIGUOUS.slice(0, 5)) {
  await run(`C2 recovery: ${behavior.kind} → UNKNOWN same identity, one recovery effect, reconciled to RecoveredCharge`, async () => {
    const deal = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 5 * 60_000), participants: [
      { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] }
    ] });
    const p = deal.participants[0]!;
    lab.sim.script(p.authorization, "recover", [behavior]);
    await lab.enqueueRecovery(deal.deal_id);
    await lab.drain({ dealIds: [deal.deal_id], types: ["recovery_deal"] });
    const rows = await lab.attempts(p.participant_id, "recovery");
    assert.equal(rows.length, 1); assert.equal(rows[0]!.result_class, "unknown");
    assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
    await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
    assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
    assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
    assert.equal(lab.sim.distinctKeys(p.authorization, "recover").length, 1);
    await lab.oracle(`c2:recovery:${behavior.kind}`, [deal.deal_id]);
  });
}

for (const behavior of AMBIGUOUS.slice(0, 5)) {
  await run(`C2 refund: ${behavior.kind} → UNKNOWN same identity, one refund effect, reconciled to Refunded`, async () => {
    const deal = await lab.seedDeal({ state: "Failed", participants: [
      { buyer_state: "DealFailed", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }
    ] });
    const p = deal.participants[0]!;
    lab.sim.forceEffect("capture", p.authorization, p.amount_minor); // the earlier capture really happened
    lab.sim.script(p.authorization, "refund", [behavior]);
    await lab.enqueueRefund(deal.deal_id);
    await lab.drain({ dealIds: [deal.deal_id], types: ["refund_issue"] });
    const rows = await lab.attempts(p.participant_id, "refund");
    assert.equal(rows.length, 1, JSON.stringify(rows)); assert.equal(rows[0]!.result_class, "unknown");
    assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
    assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess", "no canonical guess before reconcile");
    await lab.drain({ dealIds: [deal.deal_id] });
    assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
    assert.equal(lab.sim.effectsOf(p.authorization).refund, 1, "exactly one refund");
    assert.equal(lab.sim.distinctKeys(p.authorization, "refund").length, 1);
    await lab.oracle(`c2:refund:${behavior.kind}`, [deal.deal_id]);
  });
}

for (const behavior of AMBIGUOUS.slice(0, 5)) {
  await run(`C2 release: ${behavior.kind} → UNKNOWN same identity, one release effect, reconciled to AuthReleased`, async () => {
    const deal = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
    const p = deal.participants[0]!;
    lab.sim.script(p.authorization, "release", [behavior]);
    await lab.enqueueRelease(p.participant_id, deal.deal_id, "c2");
    await lab.drain({ dealIds: [deal.deal_id], types: ["payment_release"] });
    const rows = await lab.attempts(p.participant_id, "release");
    assert.equal(rows.length, 1, JSON.stringify(rows)); assert.equal(rows[0]!.result_class, "unknown");
    assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
    await lab.drain({ dealIds: [deal.deal_id] });
    assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
    assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
    assert.equal(lab.sim.distinctKeys(p.authorization, "release").length, 1);
    await lab.oracle(`c2:release:${behavior.kind}`, [deal.deal_id]);
  });
}

await run("C2 pre-dispatch definite failure: a participant without any authorization never reaches the provider; the SAME identity is retried; nothing moves; the stuck job is visible in the DLQ", async () => {
  // no binding and no authorization in the join audit: the adapter proves dispatched:false
  const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", withoutAuthorization: true }] });
  const p = deal.participants[0]!;
  const chargeEvent = await lab.enqueueCharge(deal.deal_id);
  const stats = await lab.drain({ dealIds: [deal.deal_id], types: ["charge_deal"], maxRounds: 12 });
  const rows = await lab.attempts(p.participant_id, "charge_start");
  assert.equal(rows.length, 1, `one identity across every retry: ${JSON.stringify(rows)}`);
  assert.equal(rows[0]!.result_class, "unknown");
  assert.equal(rows[0]!.dispatch_state, "recorded", "a pre-dispatch failure disarms back to NOT_DISPATCHED");
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, "nothing reached the provider");
  const outbox = await lab.outboxRow(chargeEvent);
  assert.equal(outbox?.status, "dlq", `the job must end in the DLQ, got ${JSON.stringify(outbox)} after ${JSON.stringify(stats.results.map((r) => r.status))}`);
  await lab.oracle("c2:pre-dispatch", [deal.deal_id]);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
