// INDEPENDENT ADVERSARIAL FINANCIAL REVIEW — F-1 … F-9 reconstructed with DIFFERENT
// adversarial variations than the author's regressions, plus independent
// concurrency probes on rails the author's matrix covers only partially.
//
//   FR-2   finalize defers while a RECOVERY identity is UNKNOWN even when the threshold
//          is already met by another participant (author: capture identities)
//   FR-3   HTTP webhook path: a late recovery_captured for a Dropped participant whose
//          recovery was declared failed → contradiction case, identity success, the
//          pending release is blocked (no release of captured money)
//   FR-4   a reconcile request behind a reconcile of ANOTHER identity that is
//          `processing` under a dead lease → visible (queued-behind case), resolved after reclaim
//   FR-5b  refund_issued carrying the CAPTURE correlation for a never-captured participant →
//          the capture identity is never marked executed; the contradiction is a case
//   FR-7   release answered 2xx `status: "processing"` → UNKNOWN, reconciled to one real release;
//   FR-7b  refund / release answered 2xx with an id and NO declared status → UNKNOWN (fixed)
//   FR-8   pre-flight holds (pending) then the participant is Dropped by a provider event →
//          no orphan NOT_DISPATCHED recovery identity (pre-flight before mint)
//   FR-9   FLAP(failed, failed, captured): the third read is the truth — no recovery
//   FR-C2  a recovery_deal replayed after a successful recovery sends nothing
//   FR-C3  refund vs reconcile: reconcile defers while the refund is in flight (0 status
//          reads), one refund effect, Refunded once
//   FR-C4  release vs capture (documented residual): a release in flight when the charge runs —
//          the capture IS dispatched, declined by the provider, its negative settlement fenced;
//          never double money, consistent end state
//
// Synthetic money only. Disposable database. Non-idempotent provider.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner, sleep } from "./lab/runtime.js";
import { auditFinancialTruth } from "./lab/oracle.js";

const HORIZON_MS = 1200;
const lab = await bootLab({
  tag: "findings",
  port: 3165,
  simulator: { nativeIdempotency: false },
  env: { COMPLETION_WINDOW_MINUTES: "1", PAYMENT_SETTLEMENT_HORIZON_MS: String(HORIZON_MS) },
  outboxMaxAttempts: 4
});
const { run, summary } = makeRunner("payment_review_findings_reconstruction");
const skipFinalize = (e: { event_type: string }) => e.event_type === "finalize_deal";
const casesOf = async (pid: string) => (await lab.cases(pid)).map((c) => c.auto_key.split(":")[0]);

// ── FR-2 ───────────────────────────────────────────────────────────────────────
await run("FR-2 finalize defers while a RECOVERY identity is UNKNOWN, even though the threshold is met by another participant", async () => {
  const d = await lab.seedDeal({ state: "CompletionWindow", threshold_units: 1, completionWindowUntil: new Date(Date.now() - 1000), participants: [
    { buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] },
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [
      { attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "dispatch_response" },
      { attempt_type: "recovery", result_class: "unknown", dispatch_state: "responded" }
    ] }
  ] });
  const [charged, unresolved] = d.participants as [typeof d.participants[0], typeof d.participants[0]];
  lab.sim.forceEffect("capture", charged.authorization, charged.amount_minor);
  lab.sim.scriptStatus(unresolved.authorization, Array.from({ length: 12 }, () => ({ kind: "HTTP_500" as const })));
  const event = await lab.enqueueFinalize(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  const row = await lab.outboxRow(event);
  console.log(`  finalize: ${first?.status} error=${String((first as any)?.error || "").slice(0, 60)} deal=${(await lab.deal(d.deal_id)).state}`);
  assert.equal((await lab.deal(d.deal_id)).state, "CompletionWindow", "no decision while a recovery identity may have moved money");
  assert.match(String(row?.last_error || ""), /finalize_waiting_for_unresolved_captures/);
  assert.ok((await lab.liveEvents([d.deal_id], ["payment_reconcile"])).length === 1, "a reconcile is live for the unknown recovery");
  lab.sim.clearStatusScript(unresolved.authorization);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 60, waitDeferredUpToMs: 2000 });
  const deal = await lab.deal(d.deal_id);
  console.log(`  after truth: deal=${deal.state} unresolved=${(await lab.participant(unresolved.participant_id)).money_state}`);
  assert.equal(deal.state, "Completed");
  await lab.oracle("fr2", [d.deal_id], { allowUnresolved: true });
});

// ── FR-3 ───────────────────────────────────────────────────────────────────────
await run("FR-3 HTTP webhook: late recovery_captured for a Dropped participant (recovery declared failed, effect real) → contradiction case, recovery identity success, the pending release is BLOCKED", async () => {
  const recoveryCorrelation = `recovery:fr3:n1:${randomUUID()}`;
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [
    { buyer_state: "Dropped", money_state: "ChargeFailedRecovery", priorAttempts: [
      { attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "dispatch_response" },
      { attempt_type: "recovery", result_class: "permanent_fail", correlation_id: recoveryCorrelation, failure_evidence: "dispatch_response" }
    ] }
  ] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("recover", p.authorization, p.amount_minor); // the "failed" recovery in fact landed
  const hook = await lab.postWebhook({ event_type: "recovery_captured", provider_reference: `rec-${p.authorization}`, correlation_id: recoveryCorrelation, participant_id: p.participant_id, deal_id: d.deal_id });
  const attempts = await lab.attempts(p.participant_id, "recovery");
  const cases = await casesOf(p.participant_id);
  console.log(`  webhook=${hook.statusCode} ${hook.body.slice(0, 80)} recovery_identity=${attempts[0]?.result_class} cases=${cases.join(",")}`);
  assert.equal(hook.statusCode, 200);
  assert.equal(attempts[0]?.result_class, "success", "the late recovery effect converged the identity (family-matched)");
  assert.ok(cases.includes("payment-late-money-effect"), "the contradiction is an operator case");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeFailedRecovery", "canonical state is not flipped by a contradicting late event");
  await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 20 });
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0, "captured money is never released");
  assert.ok((await casesOf(p.participant_id)).includes("payment-operation-blocked"));
  await lab.oracle("fr3", [d.deal_id], { allowUnresolved: true });
});

// ── FR-4 ───────────────────────────────────────────────────────────────────────
await run("FR-4 a reconcile request behind a reconcile of ANOTHER identity held by a DEAD lease is visible (queued-behind case) and resolves after reclaim", async () => {
  const stale = `capture:fr4:stale:${randomUUID()}`;
  const d = await lab.seedDeal({ state: "Charging", participants: [
    { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", priorAttempts: [
      { attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: stale, failure_evidence: "dispatch_response" }
    ] }
  ] });
  const p = d.participants[0]!;
  // a reconcile for the STALE (already resolved) identity, parked in `processing` under a dead lease
  const parked = randomUUID();
  await lab.pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at, worker_id, lease_generation, lease_expires_at, claimed_at, processing_started_at, last_heartbeat_at)
     VALUES ($1,'payment_reconcile','participant',$2,$3,'processing',1,clock_timestamp(),clock_timestamp(),clock_timestamp(),'dead-worker',1,clock_timestamp() - interval '5 seconds',clock_timestamp() - interval '10 seconds',clock_timestamp() - interval '10 seconds',clock_timestamp() - interval '10 seconds')`,
    [parked, p.participant_id, JSON.stringify({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: stale, operation: "capture", provider_reference: p.authorization, reason: "stale" })]
  );
  // the capture rail executes a NEW identity, the answer is lost: it asks for a
  // reconcile while the stale one still occupies the one-live-per-aggregate slot
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  const charge = await lab.enqueueCharge(d.deal_id);
  await lab.processOutboxEventById(charge);
  const rowsBefore = await lab.attempts(p.participant_id, "charge_start");
  const live = rowsBefore.find((r) => r.correlation_id !== stale)!;
  const casesBefore = await casesOf(p.participant_id);
  console.log(`  after capture: live=${live?.result_class}/${live?.dispatch_state} cases=${casesBefore.join(",")}`);
  assert.equal(live?.result_class, "unknown");
  assert.ok(casesBefore.includes("payment-reconcile-queued-behind"), "the queued-behind request is an operational case");
  // reclaim the dead lease and let everything run
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 30, waitDeferredUpToMs: 2000 });
  const rows = await lab.attempts(p.participant_id, "charge_start");
  const cases = await casesOf(p.participant_id);
  console.log(`  identities=${rows.map((r) => `${r.correlation_id.split(":")[2]}=${r.result_class}`).join(",")} state=${(await lab.participant(p.participant_id)).money_state} cases=${cases.join(",")}`);
  assert.equal(rows.find((r) => r.correlation_id === live.correlation_id)?.result_class, "success", "the live identity converged to provider truth after the dead reconcile was reclaimed");
  assert.equal(rows.find((r) => r.correlation_id === stale)?.result_class, "permanent_fail", "the STALE identity must not be marked executed by evidence that belongs to the live identity");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("fr4", [d.deal_id], { allowUnresolved: true });
});

// ── FR-5b ──────────────────────────────────────────────────────────────────────
await run("FR-5b refund_issued carrying the CAPTURE correlation for a never-captured participant → capture identity untouched (never 'success'), contradiction case, no refund identity fabricated", async () => {
  const captureCorrelation = `capture:fr5b:n1:${randomUUID()}`;
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: captureCorrelation, failure_evidence: "dispatch_response" }] }
  ] });
  const p = d.participants[0]!;
  const hook = await lab.postWebhook({ event_type: "refund_issued", provider_reference: `ref-${p.authorization}`, correlation_id: captureCorrelation, participant_id: p.participant_id, deal_id: d.deal_id });
  const rows = await lab.attempts(p.participant_id);
  const cases = await casesOf(p.participant_id);
  console.log(`  webhook=${hook.statusCode} ${hook.body.slice(0, 90)} identities=${rows.map((r) => `${r.attempt_type}=${r.result_class}`).join(",")} state=${(await lab.participant(p.participant_id)).money_state} cases=${cases.join(",")}`);
  assert.equal(rows.find((r) => r.correlation_id === captureCorrelation)?.result_class, "permanent_fail", "a refund event must never settle the capture identity");
  assert.ok(!rows.some((r) => r.attempt_type === "refund" || r.attempt_type === "cancel_refund"), "no refund identity was fabricated from a callback");
  assert.notEqual((await lab.participant(p.participant_id)).money_state, "Refunded");
  assert.ok(cases.includes("payment-late-money-effect"), "a provider claiming a refund for money it never captured is a visible contradiction");
  await lab.oracle("fr5b", [d.deal_id], { allowUnresolved: true });
});

// ── FR-7 ───────────────────────────────────────────────────────────────────────
await run("FR-7 release answered 200 {status:'processing'} (no effect) → UNKNOWN, never AuthReleased on a promise; reconciled to ONE real release", async () => {
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "release", [{ kind: "PENDING_NO_EFFECT" }]);
  const event = await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.processOutboxEventById(event);
  const after = await lab.participant(p.participant_id);
  const identity = (await lab.attempts(p.participant_id, "release"))[0];
  console.log(`  processing-release: state=${after.money_state} identity=${identity?.result_class}/${identity?.dispatch_state} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))}`);
  assert.equal(after.money_state, "AuthLocked", "no AuthReleased on an undeclared outcome");
  assert.equal(identity?.result_class, "unknown");
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1, "exactly one real release after reconciliation proved non-execution");
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.oracle("fr7", [d.deal_id]);
});

await run("FR-7b refund / release answered 2xx with an id and NO declared status (legacy shape) → UNKNOWN, never canonical on an undeclared outcome; reconciled to exactly one effect", async () => {
  // refund: the money DID move but the body declares nothing → UNKNOWN → status proves refunded → Refunded, one effect
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "ChargedSuccess", qty: 2, priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  lab.sim.script(p.authorization, "refund", [{ kind: "ID_ONLY_2XX", effect: true }]);
  const refundEvent = await lab.enqueueRefund(d.deal_id);
  await lab.processOutboxEventById(refundEvent);
  const refundIdentity = (await lab.attempts(p.participant_id, "refund"))[0];
  console.log(`  id-only refund: state=${(await lab.participant(p.participant_id)).money_state} identity=${refundIdentity?.result_class}`);
  assert.equal(refundIdentity?.result_class, "unknown", "an id-only 2xx is not a declared outcome");
  assert.notEqual((await lab.participant(p.participant_id)).money_state, "Refunded");
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1, "no second refund on a non-idempotent provider");
  await lab.oracle("fr7b:refund", [d.deal_id]);

  // release: the body declares nothing and the money did NOT move → UNKNOWN → status proves not released → one real release
  const d2 = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
  const p2 = d2.participants[0]!;
  lab.sim.script(p2.authorization, "release", [{ kind: "ID_ONLY_2XX", effect: false }]);
  const releaseEvent = await lab.enqueueRelease(p2.participant_id, d2.deal_id);
  await lab.processOutboxEventById(releaseEvent);
  assert.equal((await lab.participant(p2.participant_id)).money_state, "AuthLocked", "never AuthReleased on an undeclared outcome");
  assert.equal((await lab.attempts(p2.participant_id, "release"))[0]?.result_class, "unknown");
  await lab.drain({ dealIds: [d2.deal_id], maxRounds: 40 });
  assert.equal(lab.sim.effectsOf(p2.authorization).release, 1, "exactly one real release after the status proved non-execution");
  assert.equal((await lab.participant(p2.participant_id)).money_state, "AuthReleased");
  await lab.oracle("fr7b:release", [d2.deal_id]);
});

// ── FR-8 ───────────────────────────────────────────────────────────────────────
await run("FR-8 pre-flight holds (status pending) and a provider event then DROPS the participant → no orphan NOT_DISPATCHED recovery identity, nothing invisible", async () => {
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "dispatch_response" }] }
  ] });
  const p = d.participants[0]!;
  lab.sim.scriptStatus(p.authorization, [{ kind: "PENDING" }, { kind: "PENDING" }]);
  const event = await lab.enqueueRecovery(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  assert.equal((await lab.attempts(p.participant_id, "recovery")).length, 0, "a held recovery mints NO identity");
  const hook = await lab.postWebhook({ event_type: "recovery_failed", provider_reference: p.authorization, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.equal(hook.statusCode, 200);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 2000 });
  const rows = await lab.attempts(p.participant_id, "recovery");
  const part = await lab.participant(p.participant_id);
  console.log(`  held-then-dropped: first=${first?.status} recovery_identities=${rows.length} state=${part.buyer_state}/${part.money_state} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))}`);
  assert.equal(rows.length, 0, "no orphan recovery identity");
  assert.equal(part.buyer_state, "Dropped");
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 0);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1, "the hold of the dropped participant was released with proof (F-6)");
  assert.equal(part.money_state, "AuthReleased");
  await lab.oracle("fr8", [d.deal_id]);
});

// ── FR-9 ───────────────────────────────────────────────────────────────────────
await run("FR-9 FLAP(failed, failed, captured) on an executed capture: the reconcile infers failed, the horizon holds, the third read is the truth → one capture, no recovery", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "FLAP", states: ["failed", "failed", "captured"] }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 80, waitDeferredUpToMs: HORIZON_MS + 500 });
  const eff = lab.sim.effectsOf(p.authorization);
  const reads = lab.sim.requestsOf(p.authorization, "status").map((r) => r.behavior.replace(/^capture:/, "")).join(",");
  console.log(`  flap-3: effects=${JSON.stringify(eff)} reads=[${reads}] capture_identity=${(await lab.attempts(p.participant_id, "charge_start"))[0]?.result_class} cases=${(await casesOf(p.participant_id)).join(",")}`);
  assert.equal(eff.capture + eff.recover, 1);
  assert.equal(eff.recover, 0);
  await lab.oracle("fr9", [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

// ── FR-C2 ──────────────────────────────────────────────────────────────────────
await run("FR-C2 recovery vs recovery: a recovery that EXECUTED but never reached canonical state (crash between settle and state) is replayed by two workers → zero new provider requests, RecoveredCharge once", async () => {
  const recoveryCorrelation = `recovery:frc2:n1:${randomUUID()}`;
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [
      { attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "dispatch_response" },
      { attempt_type: "recovery", result_class: "success", correlation_id: recoveryCorrelation }
    ] }
  ] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("recover", p.authorization, p.amount_minor); // the recovery executed at the provider before the crash
  const replay = await lab.enqueueRecovery(d.deal_id);
  const [a, b] = await Promise.all([lab.processOutboxEventById(replay), lab.processOutboxEventById(replay)]);
  assert.equal([a, b].filter(Boolean).length, 1, "one worker claims the replay");
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 20 });
  const rows = await lab.attempts(p.participant_id, "recovery");
  console.log(`  replay: effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))} recover_requests=${lab.sim.requestsOf(p.authorization, "recover").length} identities=${rows.map((r) => r.result_class).join(",")} state=${(await lab.participant(p.participant_id)).money_state}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no recovery request at all on a non-idempotent provider — the executed identity is resolved through status");
  assert.equal(rows.length, 1, "no second recovery identity");
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge", "the executed identity re-applied canonical truth");
  await lab.oracle("frc2", [d.deal_id]);
});

// ── FR-C3 ──────────────────────────────────────────────────────────────────────
await run("FR-C3 refund vs reconcile: a reconcile arriving while the refund is IN FLIGHT defers with zero status reads; one refund effect; Refunded once", async () => {
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "ChargedSuccess", qty: 2, priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  lab.sim.script(p.authorization, "refund", [{ kind: "EFFECT_THEN_503" }]);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const refundEvent = await lab.enqueueRefund(d.deal_id);
  const refundRun = lab.processOutboxEventById(refundEvent);
  await barrier!.entered; // the refund executed at the provider, the worker is parked after I/O
  const refundIdentity = (await lab.attempts(p.participant_id))[1];
  const reconcile = await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "refund", correlation_id: refundIdentity!.correlation_id, operation: "refund", provider_reference: p.authorization });
  const statusReadsBefore = lab.sim.requestsOf(p.authorization, "status").length;
  const r = await lab.processOutboxEventById(reconcile);
  console.log(`  reconcile-in-flight: ${r?.status} ${String((r as any)?.error || "").slice(0, 60)} status_reads=${lab.sim.requestsOf(p.authorization, "status").length - statusReadsBefore}`);
  assert.match(String((r as any)?.error || ""), /operation_in_flight/);
  assert.equal(lab.sim.requestsOf(p.authorization, "status").length, statusReadsBefore, "no status read while the exact operation is in flight");
  barrier!.release();
  await refundRun;
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  await lab.oracle("frc3", [d.deal_id]);
});

// ── FR-C4 ──────────────────────────────────────────────────────────────────────
await run("FR-C4 release vs capture (documented residual): the charge runs while the release is IN FLIGHT → the capture request IS dispatched (nothing fences it), the provider declines a released hold, the negative settlement is fenced until the release settles; no money moves twice, consistent end state", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "LockedIn", money_state: "AuthLocked" }] });
  const p = d.participants[0]!;
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const releaseRun = lab.processOutboxEventById(releaseEvent);
  await barrier!.entered; // hold released at the provider, worker parked
  // the deal-level charging.start transition lands WHILE the release is in flight
  // (nothing fences it): the participant becomes capture-eligible
  const c = await lab.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('siton.action_name','charging.start',true), set_config('siton.is_worker','true',true), set_config('siton.request_id','review-frc4',true)`);
    for (const [stateType, fromState, toState] of [["buyer_state", "LockedIn", "ChargingAttempt"], ["money_state", "AuthLocked", "ChargeAttempt"]] as const) {
      await c.query(`INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload) VALUES ('participant',$1,$2,$3,$4,$5,'charging.start','review-frc4',$6,'{}')`, [p.participant_id, d.deal_id, stateType, fromState, toState, `review-frc4:${stateType}:${p.participant_id}`]);
    }
    await c.query(`SELECT set_config('siton.audit_written','1',true)`);
    await c.query(`UPDATE siton.participants SET buyer_state='ChargingAttempt', money_state='ChargeAttempt' WHERE participant_id=$1`, [p.participant_id]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; } finally { c.release(); }
  const chargeEvent = await lab.enqueueCharge(d.deal_id);
  const charge = await lab.processOutboxEventById(chargeEvent);
  console.log(`  charge while release in flight: ${charge?.status} ${String((charge as any)?.error || "").slice(0, 60)} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))} state=${(await lab.participant(p.participant_id)).money_state}`);
  const releasedAt = Date.now();
  barrier!.release();
  await releaseRun;
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 2000 });
  const eff = lab.sim.effectsOf(p.authorization);
  const part = await lab.participant(p.participant_id);
  const report = await auditFinancialTruth(lab.pool, { label: "frc4", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  console.log(`  end: effects=${JSON.stringify(eff)} state=${part.buyer_state}/${part.money_state} cases=${(await casesOf(p.participant_id)).join(",")} oracle=${report.violations.map((v) => v.code).join(",") || "clean"}`);
  assert.match(String((charge as any)?.error || ""), /operation_in_flight/, "the NEGATIVE settlement of the declined capture is fenced while the release is in flight");
  assert.ok(lab.sim.requestsOf(p.authorization, "capture").filter((r) => new Date(r.at).getTime() < releasedAt).length >= 1, "documented residual: the capture request was dispatched while the release was in flight — the provider state machine is the defence");
  assert.equal(eff.capture + eff.recover, 0, "a released hold cannot be captured (provider state machine)");
  assert.equal(eff.release, 1);
  assert.ok(!report.violations.some((v) => ["DUPLICATE_CAPTURE", "DUPLICATE_RELEASE", "RELEASE_OF_CAPTURED_MONEY", "FALSE_CANONICAL_SUCCESS"].includes(v.code)), `money invariants: ${JSON.stringify(report.violations)}`);
  assert.ok(part.money_state === "AuthReleased" || part.money_state === "ChargeFailedRecovery", `consistent end state (${part.money_state})`);
  await sleep(50);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
