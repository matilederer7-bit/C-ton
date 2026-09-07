// FINANCIAL TORTURE LAB — F-2 regression: finalize_deal must not decide
// Completed / Failed while a participant's capture identity is unresolved.
//
// Found by the two-real-worker run (payment_lab_concurrency_matrix): captures
// that answered ambiguously (503 / timeout / reset / malformed) were still
// being reconciled when the completion window elapsed; finalize_deal counted
// zero captured units, declared the deal Failed and every participant
// DealFailed / ChargeAttempt. When reconciliation then proved the capture had
// executed, the participant was "not waiting for a capture" — the money was
// real (provider ledger: capture = 1), canonical money_state stayed
// ChargeAttempt, the deal's refund job skipped the participant (it refunds only
// ChargedSuccess / RecoveredCharge) and the only trace was an operational case:
// a charged buyer on a failed deal with no automatic refund path.
//
// Required: while any capture-side identity of the deal is UNKNOWN (recorded,
// dispatching or responded) finalize DEFERS, makes sure a reconcile is
// scheduled for it, and keeps the hold visible through an operational case;
// once every identity is resolved the deal is finalized on real truth.
//
// Synthetic money only. Disposable database.

import { strict as assert } from "node:assert";
import { bootLab, makeRunner, timeout } from "./lab/runtime.js";

const lab = await bootLab({ tag: "finalize-guard", port: 3160, simulator: { nativeIdempotency: false }, env: { COMPLETION_WINDOW_MINUTES: "0.05" }, outboxMaxAttempts: 6 });
const { run, summary } = makeRunner("payment_lab_finalize_guard");

async function elapsedWindow(dealId: string) {
  const deal = await lab.deal(dealId);
  assert.ok(deal.completion_window_until, "completion window must be set by the charge rail");
  const waitMs = Math.max(0, new Date(deal.completion_window_until!).getTime() - Date.now()) + 250;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

await run("F-2 reproduction shape: capture UNKNOWN (post-dispatch 503, reconcile still pending) when the window elapses → finalize DEFERS instead of failing the deal; after reconciliation the deal completes and the buyer is ChargedSuccess", async () => {
  const d = await lab.seedDeal({ state: "Charging", threshold_units: 1, participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  // status stays ambiguous for the first reads so the identity is still UNKNOWN when the window elapses
  lab.sim.scriptStatus(p.authorization, [{ kind: "PENDING" }, { kind: "PENDING" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"] });
  assert.equal((await lab.attempts(p.participant_id, "charge_start"))[0]!.result_class, "unknown");
  await elapsedWindow(d.deal_id);
  const finalize = (await lab.liveEvents([d.deal_id], ["finalize_deal"]))[0];
  assert.ok(finalize, "finalize_deal must be scheduled");
  const attempt1 = await lab.processOutboxEventById(finalize!.event_uuid);
  assert.equal(attempt1?.status, "failed", `finalize must defer while a capture is unresolved: ${JSON.stringify(attempt1)}`);
  assert.match(String((attempt1 as any).error), /unresolved/i);
  assert.equal((await lab.deal(d.deal_id)).state, "CompletionWindow", "the deal must not be finalized on unresolved captures");
  assert.equal((await lab.participant(p.participant_id)).buyer_state, "ChargingAttempt", "no participant may be failed while its capture is unresolved");
  assert.ok((await lab.liveEvents([d.deal_id], ["payment_reconcile"])).length >= 1, "a reconcile must be live for the unresolved identity");
  const cases = await lab.pool.query(`SELECT auto_key FROM siton.operational_cases WHERE auto_key LIKE 'deal-finalize-waiting%' AND auto_key LIKE '%' || $1 || '%'`, [d.deal_id]);
  assert.ok(cases.rowCount, "the deferred finalize must be visible as an operational case");
  // Reconciliation converges (truthful status now), then finalize completes the deal.
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 60 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal((await lab.deal(d.deal_id)).state, "Completed");
  assert.equal((await lab.participant(p.participant_id)).buyer_state, "DealCompleted");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("finalize-guard:unknown-then-completed", [d.deal_id], { seededStates: false });
});

await run("F-2 with an IN-FLIGHT capture: finalize arriving while the capture is parked after its effect defers with no verdict; the deal completes once the capture settles", async () => {
  const d = await lab.seedDeal({ state: "Charging", threshold_units: 1, participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  // open the window first with a second participant's normal capture so finalize is scheduled
  const chargeEvent = await lab.enqueueCharge(d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const chargeRun = lab.processOutboxEventById(chargeEvent);
  await Promise.race([barrier.entered, timeout(15_000, "capture never parked")]);
  // force a finalize job now (window not even open: seed it directly)
  await lab.pool.query(`UPDATE siton.deals SET state='CompletionWindow', completion_window_until = clock_timestamp() - interval '1 second' WHERE deal_id=$1 AND completion_window_until IS NULL`, [d.deal_id]).catch(() => undefined);
  const finalize = await lab.enqueueFinalize(d.deal_id);
  const r = await lab.processOutboxEventById(finalize);
  console.log(`  finalize while capture in flight: ${JSON.stringify(r)} deal=${(await lab.deal(d.deal_id)).state}`);
  assert.notEqual((await lab.deal(d.deal_id)).state, "Failed", "an in-flight capture must never let the deal fail");
  barrier.release();
  await chargeRun;
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 60 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("finalize-guard:in-flight", [d.deal_id], { seededStates: false, allowedCodes: ["COMPLETED_DEAL_PARTICIPANT_NOT_FINAL"] });
});

await run("F-2 fail-closed bound: a capture that stays UNKNOWN forever keeps the deal un-finalized and visible (reconcile DLQ + cases), never Failed with charged money", async () => {
  const d = await lab.seedDeal({ state: "Charging", threshold_units: 1, participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, Array.from({ length: 400 }, () => ({ kind: "UNKNOWN" as const })));
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"] });
  await elapsedWindow(d.deal_id);
  // bounded: the sweeper keeps re-queuing reconciles and finalizes; nothing may conclude
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 24 });
  const deal = await lab.deal(d.deal_id);
  const participant = await lab.participant(p.participant_id);
  const dlq = (await lab.dlqRows(d.deal_id)).concat(await lab.dlqRows(p.participant_id)).map((r) => r.event_type);
  console.log(`  unknown forever: deal=${deal.state} participant=${participant.buyer_state}/${participant.money_state} dlq=${JSON.stringify(dlq)}`);
  assert.notEqual(deal.state, "Failed", "charged money on a Failed deal is the exact defect");
  assert.equal(deal.state, "CompletionWindow", "the deal must stay un-finalized while its capture is unresolved");
  assert.equal(participant.money_state, "ChargeAttempt");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  const cases = await lab.cases(p.participant_id);
  assert.ok(cases.length >= 1, "the unresolved money must be visible as a case");
  await lab.oracle("finalize-guard:unknown-forever", [d.deal_id], { allowUnresolved: true, seededStates: false });
  // F-2b: once truth is available the maintenance sweepers converge the identity AND re-queue the exhausted finalize.
  lab.sim.clearStatusScript(p.authorization);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 60 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal((await lab.deal(d.deal_id)).state, "Completed", "a finalize that exhausted its attempts while waiting must be re-queued by maintenance");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("finalize-guard:unknown-then-truth", [d.deal_id], { seededStates: false });
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
