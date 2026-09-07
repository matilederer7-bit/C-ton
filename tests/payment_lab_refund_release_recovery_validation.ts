// FINANCIAL TORTURE LAB — Phases 11, 12, 13: refund, release and recovery torture.
//
// This suite runs against a provider WITHOUT native idempotency: every request
// that reaches the simulator executes. Any second request Siton ever sends for
// the same logical operation therefore shows up as a second economic effect —
// so "refund_count = 1", "release_count = 1", "recovery_count = 1" here prove
// that the application itself never repeats a money operation, independently
// of what a provider might deduplicate.
//
// Absolute invariants under test:
//   * ambiguous refund → fail closed (same identity reconciled, never a second
//     refund request)
//   * never release something that has economically been captured
//   * RECOVERY MUST NOT RUN WHILE THE ORIGINAL CAPTURE MAY HAVE SUCCEEDED
//
// Synthetic money only. Disposable database.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner, timeout } from "./lab/runtime.js";
import type { Behavior } from "./lab/provider_simulator.js";

const lab = await bootLab({ tag: "rrr", port: 3154, simulator: { nativeIdempotency: false }, env: { COMPLETION_WINDOW_MINUTES: "0.2" }, outboxMaxAttempts: 3 });
const { run, summary } = makeRunner("payment_lab_refund_release_recovery");

async function seedCharged(kind: "refund" | "cancel" = "refund") {
  const d = await lab.seedDeal({ state: kind === "cancel" ? "Cancelled" : "Failed", participants: [
    { buyer_state: "DealFailed", money_state: "ChargedSuccess", qty: 2, delivery_cost: 3.5, priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: `capture:rrr-prior:n1:${randomUUID()}` }] }
  ] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  return { d, p };
}
async function seedHeld() {
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
  return { d, p: d.participants[0]! };
}
async function seedRecoverable(prior: "permanent_fail" | "unknown" | "success" = "permanent_fail") {
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 5 * 60_000), participants: [
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: prior, correlation_id: `capture:rrr-prior:n1:${randomUUID()}`, dispatch_state: "responded" }] }
  ] });
  return { d, p: d.participants[0]! };
}

// ── Phase 11: refund ─────────────────────────────────────────────────────────

await run("refund: success → Refunded, exactly one refund request/effect, ledger charge + refund_adjustment", async () => {
  const { d, p } = await seedCharged();
  await lab.enqueueRefund(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  assert.equal(lab.sim.requestsOf(p.authorization, "refund").length, 1);
  await lab.oracle("refund:success", [d.deal_id]);
});

await run("refund: duplicate refund jobs (second refund_issue after Refunded, replayed cancel_refund) send nothing", async () => {
  const { d, p } = await seedCharged();
  await lab.enqueueRefund(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id] });
  await lab.enqueueRefund(d.deal_id, "duplicate");
  await lab.enqueue("cancel_refund", "deal", d.deal_id, { deal_id: d.deal_id });
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal(lab.sim.requestsOf(p.authorization, "refund").length, 1, "no second refund request");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  await lab.oracle("refund:duplicate-jobs", [d.deal_id]);
});

const REFUND_AMBIGUOUS: Behavior[] = [{ kind: "EFFECT_THEN_503" }, { kind: "EFFECT_THEN_429" }, { kind: "EFFECT_THEN_TIMEOUT" }, { kind: "EFFECT_THEN_RESPONSE_LOST" }, { kind: "EFFECT_THEN_CONNECTION_RESET" }];
for (const behavior of REFUND_AMBIGUOUS) {
  await run(`refund: ${behavior.kind} on a NON-idempotent provider → UNKNOWN, same identity reconciled, refund_count stays 1`, async () => {
    const { d, p } = await seedCharged();
    lab.sim.script(p.authorization, "refund", [behavior]);
    await lab.enqueueRefund(d.deal_id);
    await lab.drain({ dealIds: [d.deal_id], types: ["refund_issue"] });
    const row = (await lab.attempts(p.participant_id, "refund"))[0]!;
    assert.equal(row.result_class, "unknown");
    await lab.drain({ dealIds: [d.deal_id] });
    assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
    assert.equal(lab.sim.effectsOf(p.authorization).refund, 1, "a second refund request would have executed here");
    assert.equal(lab.sim.requestsOf(p.authorization, "refund").length, 1);
    await lab.oracle(`refund:${behavior.kind}`, [d.deal_id]);
  });
}

await run("refund: late refund success (client timed out, provider settles later) → pending status until landed, then Refunded once", async () => {
  const { d, p } = await seedCharged();
  lab.sim.script(p.authorization, "refund", [{ kind: "LATE_SUCCESS", delayMs: 400 }]);
  await lab.enqueueRefund(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  await lab.oracle("refund:late-success", [d.deal_id]);
});

await run("refund: two refund workers claim the same job — one executes, refund_count 1", async () => {
  const { d, p } = await seedCharged();
  const event = await lab.enqueueRefund(d.deal_id);
  const [a, b] = await Promise.all([lab.processOutboxEventById(event), lab.processOutboxEventById(event)]);
  assert.equal([a, b].filter(Boolean).length, 1, "exactly one worker may claim the job");
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  await lab.oracle("refund:two-workers", [d.deal_id]);
});

await run("refund vs reconcile: a reconcile arriving while the refund is in flight defers with zero status reads", async () => {
  const { d, p } = await seedCharged();
  const event = await lab.enqueueRefund(d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const refundRun = lab.processOutboxEventById(event);
  await Promise.race([barrier.entered, timeout(15_000, "refund never reached after_provider_io")]);
  const row = (await lab.attempts(p.participant_id, "refund"))[0]!;
  assert.equal(row.in_flight, true);
  const reconcile = await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "refund", correlation_id: row.correlation_id, operation: "refund", provider_reference: p.authorization });
  const r = await lab.processOutboxEventById(reconcile);
  assert.equal(r?.status, "failed"); assert.match(String((r as any).error), /operation_in_flight/);
  assert.equal(lab.sim.requestsOf(p.authorization, "status").length, 0);
  barrier.release();
  await refundRun;
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  await lab.oracle("refund:vs-reconcile", [d.deal_id]);
});

await run("refund with provider status unavailable forever: UNKNOWN stays UNKNOWN (never a verdict), no second refund, DLQ + case, the sweeper keeps re-queuing; a later truthful status converges", async () => {
  const { d, p } = await seedCharged();
  lab.sim.script(p.authorization, "refund", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, Array.from({ length: 200 }, () => ({ kind: "HTTP_500" as const })));
  await lab.enqueueRefund(d.deal_id);
  const stats = await lab.drain({ dealIds: [d.deal_id], maxRounds: 14 });
  assert.equal((await lab.attempts(p.participant_id, "refund"))[0]!.result_class, "unknown", "ambiguity must not decay into a verdict");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1, "no second refund while the first is unresolved");
  assert.equal(lab.sim.requestsOf(p.authorization, "refund").length, 1);
  assert.ok(stats.results.filter((r) => r.event_type === "payment_reconcile").every((r) => r.status !== "sent"));
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-reconcile-unresolved")));
  await lab.oracle("refund:status-unavailable", [d.deal_id], { allowUnresolved: true });
  assert.ok((await lab.dlqRows(p.participant_id, "payment_reconcile")).length >= 1, "each exhausted reconcile is archived in the DLQ");
  lab.sim.clearStatusScript(p.authorization);
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  await lab.oracle("refund:status-recovered", [d.deal_id]);
});

await run("refund after local terminal state and a declined refund: no blind repeat; a declared refund failure re-arms ONE fresh identity only after the negative verdict", async () => {
  const { d, p } = await seedCharged();
  lab.sim.script(p.authorization, "refund", [{ kind: "DECLINED" }, { kind: "SUCCESS" }]);
  await lab.enqueueRefund(d.deal_id);
  const first = await lab.drain({ dealIds: [d.deal_id], types: ["refund_issue"], maxRounds: 4 });
  console.log(`  declined refund: ${JSON.stringify(first.results.map((r) => `${r.status}:${String(r.error || "").slice(0, 40)}`))}`);
  const rows = await lab.attempts(p.participant_id, "refund");
  assert.ok(rows.some((r) => r.result_class === "permanent_fail"), JSON.stringify(rows));
  // a second refund job (operator) is legal now and mints n2
  await lab.enqueueRefund(d.deal_id, "after-decline");
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  assert.equal(lab.sim.distinctKeys(p.authorization, "refund").length, 2);
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  await lab.oracle("refund:declined-then-success", [d.deal_id]);
});

// ── Phase 12: release ────────────────────────────────────────────────────────

await run("release before capture: held authorization is released once → AuthReleased", async () => {
  const { d, p } = await seedHeld();
  await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  await lab.oracle("release:before-capture", [d.deal_id]);
});

await run("release after capture: the rail refuses (state) and the DB refuses (guard); no release request ever reaches the provider", async () => {
  const { d, p } = await seedCharged();
  await lab.enqueueRelease(p.participant_id, d.deal_id, "after-capture");
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal(lab.sim.requestsOf(p.authorization, "release").length, 0);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  let refused = "";
  try { await lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'release','unknown',$3)`, [p.participant_id, d.deal_id, `release:rrr-guard:n1:${p.participant_id}`]); } catch (error: any) { refused = `${error.code}:${String(error.message).split(":")[0]}`; }
  assert.equal(refused, "SN409:release_blocked_by_captured_money");
  await lab.oracle("release:after-capture", [d.deal_id]);
});

await run("release vs capture race (release in flight while a charge job arrives): the capture rail does not touch a participant whose hold is being released; one release, zero captures", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "LockedIn", money_state: "AuthLocked" }] });
  const p = d.participants[0]!;
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id, "race");
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const releaseRun = lab.processOutboxEventById(releaseEvent);
  await Promise.race([barrier.entered, timeout(15_000, "release never reached after_provider_io")]);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  const chargeEvent = await lab.enqueueCharge(d.deal_id);
  await lab.processOutboxEventById(chargeEvent);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, "no capture while the hold is being released");
  barrier.release();
  await releaseRun;
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const eff = lab.sim.effectsOf(p.authorization);
  assert.equal(eff.capture + eff.recover, 0); assert.equal(eff.release, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.oracle("release:vs-capture", [d.deal_id]);
});

await run("release: duplicate / ambiguous / late / stale-callback — one release effect, AuthReleased, a late 'released' callback after the terminal state is ignored", async () => {
  const { d, p } = await seedHeld();
  lab.sim.script(p.authorization, "release", [{ kind: "EFFECT_THEN_TIMEOUT" }]);
  await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.enqueueRelease(p.participant_id, d.deal_id, "duplicate");
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal(lab.sim.requestsOf(p.authorization, "release").length, 1);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  const late = await lab.postWebhook({ event_type: "payment_released", provider_reference: p.authorization, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.ok(late.statusCode < 500, late.body);
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.oracle("release:duplicate-ambiguous-late", [d.deal_id]);
  const { d: d2, p: p2 } = await seedHeld();
  lab.sim.script(p2.authorization, "release", [{ kind: "LATE_SUCCESS", delayMs: 400 }]);
  await lab.enqueueRelease(p2.participant_id, d2.deal_id);
  await lab.drain({ dealIds: [d2.deal_id], maxRounds: 40 });
  assert.equal((await lab.participant(p2.participant_id)).money_state, "AuthReleased");
  assert.equal(lab.sim.effectsOf(p2.authorization).release, 1);
  await lab.oracle("release:late-response", [d2.deal_id]);
});

await run("reconcile during release: defers with zero status reads; the provider status 'captured' for a hold Siton tried to release opens a case and never guesses", async () => {
  const { d, p } = await seedHeld();
  const event = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const releaseRun = lab.processOutboxEventById(event);
  await Promise.race([barrier.entered, timeout(15_000, "release never reached after_provider_io")]);
  const row = (await lab.attempts(p.participant_id, "release"))[0]!;
  const reconcile = await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "release", correlation_id: row.correlation_id, operation: "release", provider_reference: p.authorization });
  const r = await lab.processOutboxEventById(reconcile);
  assert.equal(r?.status, "failed"); assert.match(String((r as any).error), /operation_in_flight/);
  assert.equal(lab.sim.requestsOf(p.authorization, "status").length, 0);
  barrier.release(); await releaseRun;
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.oracle("release:reconcile-during", [d.deal_id]);
  // captured-while-releasing contradiction: the release request hangs (no
  // effect), and the provider's truth for this hold is "captured" (an effect
  // Siton never recorded). Reconciliation must open a case and guess nothing.
  const { d: d2, p: p2 } = await seedHeld();
  lab.sim.script(p2.authorization, "release", [{ kind: "HANG_NO_EFFECT" }]);
  lab.sim.forceEffect("capture", p2.authorization, p2.amount_minor);
  await lab.enqueueRelease(p2.participant_id, d2.deal_id);
  await lab.drain({ dealIds: [d2.deal_id], maxRounds: 20 });
  const cases = await lab.cases(p2.participant_id);
  assert.ok(cases.some((c) => c.auto_key.startsWith("payment-reconcile-release-captured")), JSON.stringify(cases));
  assert.notEqual((await lab.participant(p2.participant_id)).money_state, "AuthReleased", "a captured hold must never be marked released");
  assert.equal(lab.sim.effectsOf(p2.authorization).release, 0);
  await lab.oracle("release:captured-contradiction", [d2.deal_id], { allowUnresolved: true, allowedCodes: ["LOST_PROVIDER_EFFECT"] });
});

// ── Phase 13: recovery ───────────────────────────────────────────────────────

await run("recovery: original capture definitely failed → exactly one recovery capture, RecoveredCharge, ledger entry", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
  await lab.oracle("recovery:after-declared-failure", [d.deal_id]);
});

await run("recovery: original capture UNKNOWN → recovery refused (app AND database); reconcile scheduled; case opened; zero recovery requests", async () => {
  const { d, p } = await seedRecoverable("unknown");
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["recovery_deal"] });
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-operation-blocked")));
  let refused = "";
  try { await lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'recovery','unknown',$3)`, [p.participant_id, d.deal_id, `recovery:rrr-guard:n1:${p.participant_id}`]); } catch (error: any) { refused = `${error.code}:${String(error.message).split(":")[0]}`; }
  assert.equal(refused, "SN409:recovery_blocked_by_unresolved_capture");
  await lab.oracle("recovery:capture-unknown", [d.deal_id], { allowUnresolved: true });
});

await run("recovery: original capture UNKNOWN, status proves NOT executed → the SAME capture identity is retried by reconcile (charge_failed), recovery then captures once", async () => {
  const { d, p } = await seedRecoverable("unknown");
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const eff = lab.sim.effectsOf(p.authorization);
  assert.equal(eff.capture + eff.recover, 1, `exactly one capture-side effect: ${JSON.stringify(eff)}`);
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  await lab.oracle("recovery:capture-unknown-then-not-executed", [d.deal_id]);
});

await run("recovery: original capture eventually SUCCEEDS while recovery is pending → recovery never captures; capture truth is recorded; money moved once", async () => {
  const { d, p } = await seedRecoverable("unknown");
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const eff = lab.sim.effectsOf(p.authorization);
  assert.equal(eff.recover, 0, "recovery must not run: the original capture succeeded");
  assert.equal(eff.capture, 1);
  assert.equal((await lab.attempts(p.participant_id, "charge_start"))[0]!.result_class, "success");
  await lab.oracle("recovery:capture-eventually-succeeds", [d.deal_id], { allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

await run("recovery: original capture recorded as SUCCESS (money moved, state lost) → recovery refused, no second capture", async () => {
  const { d, p } = await seedRecoverable("success");
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  assert.equal(lab.sim.effectsOf(p.authorization).capture + lab.sim.effectsOf(p.authorization).recover, 1);
  // Either fence may answer first: the F-1 pre-flight (status says captured →
  // late-effect case) or the identity discipline (capture success → blocked case).
  const fenceCases = await lab.cases(p.participant_id);
  assert.ok(fenceCases.some((c) => c.auto_key.startsWith("payment-operation-blocked") || c.auto_key.startsWith("payment-recovery-preflight-captured")), JSON.stringify(fenceCases));
  await lab.oracle("recovery:capture-success-unpersisted", [d.deal_id], { allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

await run("recovery: ambiguous recovery response on a NON-idempotent provider → same identity reconciled, recovery_count 1; duplicate recovery jobs and two workers send nothing more", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  lab.sim.script(p.authorization, "recover", [{ kind: "EFFECT_THEN_RESPONSE_LOST" }]);
  const event = await lab.enqueueRecovery(d.deal_id);
  const [a, b] = await Promise.all([lab.processOutboxEventById(event), lab.processOutboxEventById(event)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  await lab.oracle("recovery:ambiguous-duplicate", [d.deal_id]);
});

await run("recovery vs reconcile of the original capture: while recovery is in flight the reconciler defers; after it lands the original identity converges without a capture", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  const event = await lab.enqueueRecovery(d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const recoveryRun = lab.processOutboxEventById(event);
  await Promise.race([barrier.entered, timeout(15_000, "recovery never reached after_provider_io")]);
  const original = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  const statusReads = lab.sim.requestsOf(p.authorization, "status").length;
  const reconcile = await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: original.correlation_id, operation: "capture", provider_reference: p.authorization });
  const r = await lab.processOutboxEventById(reconcile);
  // The original identity is already terminal (permanent_fail) and the
  // participant is not waiting on it: the reconciler either has nothing to do
  // or defers on the in-flight recovery — never a verdict, never a status read.
  assert.ok(r?.status === "sent" || (r?.status === "failed" && /operation_in_flight/.test(String((r as any).error))), JSON.stringify(r));
  assert.equal(lab.sim.requestsOf(p.authorization, "status").length, statusReads, "no status read while the recovery is in flight");
  barrier.release(); await recoveryRun;
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 0);
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  await lab.oracle("recovery:vs-reconcile", [d.deal_id]);
});

// ── F-7: a 2xx "pending" answer is not an executed refund / release ──────────

await run("F-7 refund: provider answers 200 {status:'pending'} and never refunds → UNKNOWN (never Refunded on a promise), reconcile proves not refunded, one fresh identity later refunds once", async () => {
  const { d, p } = await seedCharged();
  lab.sim.script(p.authorization, "refund", [{ kind: "PENDING_NO_EFFECT" }, { kind: "SUCCESS" }]);
  await lab.enqueueRefund(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["refund_issue"] });
  const first = (await lab.attempts(p.participant_id, "refund"))[0]!;
  assert.equal(first.result_class, "unknown", `a pending answer must not be an issued refund: ${JSON.stringify(first)}`);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess", "canonical truth must not run ahead of the provider");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 0);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1, "exactly one refund executed");
  await lab.oracle("f7:refund-pending", [d.deal_id]);
});

await run("F-7 release: provider answers 200 {status:'pending'} and never releases → UNKNOWN (never AuthReleased on a promise), then one real release", async () => {
  const { d, p } = await seedHeld();
  lab.sim.script(p.authorization, "release", [{ kind: "PENDING_NO_EFFECT" }, { kind: "SUCCESS" }]);
  await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["payment_release"] });
  const first = (await lab.attempts(p.participant_id, "release"))[0]!;
  assert.equal(first.result_class, "unknown", `a pending answer must not be an executed release: ${JSON.stringify(first)}`);
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthLocked");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  await lab.oracle("f7:release-pending", [d.deal_id]);
});

// ── F-9: a flapping status must never license a recovery capture ─────────────
// Found by the random-seed fuzz during the full repository regression
// (seed 2061983203, scenario #141, minimised to one participant): the capture
// answered 200 "pending" with a delayed effect while the status seam flapped
// failed ↔ captured; the reconcile rail read "failed", the single-read pre-flight
// read "failed" again, the recovery captured, then the delayed capture landed —
// 8 400 minor captured for a 4 200 minor participant.

const F9_ALLOWED = ["PROVIDER_SUCCESS_INVISIBLE", "LOST_PROVIDER_EFFECT", "UNRESOLVED_AT_QUIESCENCE", "FALSE_CANONICAL_REFUND", "CANONICAL_RELEASE_WITHOUT_PROVIDER_PROOF"];

await run("F-9 pinned (fuzz seed 2061983203 #141): capture answers 200 pending with a delayed effect while status flaps failed↔captured → no recovery capture, exactly one capture-side effect", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 1, delivery_cost: 0 }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "DELAYED_EFFECT", delayMs: 90 }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "FLAP", states: ["failed", "captured"] }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 60 });
  const eff = lab.sim.effectsOf(p.authorization);
  assert.equal(eff.capture + eff.recover, 1, `exactly one capture-side effect: ${JSON.stringify(eff)}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "a flapping status must never license a recovery capture");
  await lab.oracle("f9:pinned-fuzz-141", [d.deal_id], { allowUnresolved: true, allowedCodes: F9_ALLOWED });
});

await run("F-9: original capture declared failed, status flaps failed↔captured (capture executed) → pre-flight holds on the captured read, late-effect case, zero recovery requests", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  lab.sim.scriptStatus(p.authorization, [{ kind: "FLAP", states: ["failed", "captured"] }]);
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 40 });
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 0);
  const cases = await lab.cases(p.participant_id);
  assert.ok(cases.some((c) => c.auto_key.startsWith("payment-recovery-preflight-captured")), JSON.stringify(cases));
  await lab.oracle("f9:flap-captured", [d.deal_id], { allowUnresolved: true, allowedCodes: F9_ALLOWED });
});

await run("F-9: two consecutive negative reads that DISAGREE (failed↔authorized) → recovery held, flapping case, zero recovery requests, job stays visible", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  lab.sim.scriptStatus(p.authorization, [{ kind: "FLAP", states: ["failed", "authorized"] }]);
  const event = await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 40 });
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  assert.notEqual((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  const cases = await lab.cases(p.participant_id);
  assert.ok(cases.some((c) => c.auto_key.startsWith("payment-recovery-preflight-flapping")), JSON.stringify(cases));
  const row = await lab.outboxRow(event);
  assert.ok(row && ["pending", "failed", "dlq"].includes(String(row.status)), `held recovery job must stay visible: ${JSON.stringify(row)}`);
  await lab.oracle("f9:flap-disagree", [d.deal_id], { allowUnresolved: true, allowedCodes: F9_ALLOWED });
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
