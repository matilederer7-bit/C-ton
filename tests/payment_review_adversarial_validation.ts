// INDEPENDENT ADVERSARIAL FINANCIAL REVIEW — counterexamples against
// claude/r9c-financial-torture-candidate @ 5dcee1ff29fc2159d27ddc80a355d8d01b8a46dc.
//
// Written BEFORE any remediation, against the candidate's own lab instruments
// (tests/lab/*). Every scenario asserts the SAFE behaviour the owner's financial
// truth decisions require, so a red scenario here is a finding, never a flake:
//
//   RA-1  automatic recovery while the original capture can still settle
//         (status says failed / authorized FINAL during an asynchronous settlement)
//   RA-2  AuthReleased without authoritative release proof (F-6)
//   RA-3  currency of a status answer is never verified
//   RA-4  false provider truth (the trust boundary, documented + oracle-detected)
//   RA-5  exact operation identity: a status echo naming another reference
//   RA-6  recovery pre-flight that cannot verify must hold, never proceed
//   RA-7  release vs release (two workers)
//   RA-8  oracle anti-vacuity: false audit, missing case, reference drift, wrong amount
//   RA-9  terminal deal decision while a capture may still settle
//
// Synthetic money only. Disposable database. Non-idempotent provider: any repeat
// Siton ever sends shows up as a second economic effect.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner, sleep, timeout } from "./lab/runtime.js";
import { auditFinancialTruth } from "./lab/oracle.js";
import type { StatusBehavior } from "./lab/provider_simulator.js";

const HORIZON_MS = Number(process.env.LAB_SETTLEMENT_HORIZON_MS || 1500);
const lab = await bootLab({
  tag: "review",
  port: 3161,
  simulator: { nativeIdempotency: false },
  env: { COMPLETION_WINDOW_MINUTES: "1", PAYMENT_SETTLEMENT_HORIZON_MS: String(HORIZON_MS) },
  outboxMaxAttempts: 4
});
const { run, summary } = makeRunner("payment_review_adversarial");

// F-6 is NOT tolerated in this suite: AuthReleased must carry provider proof.
const STRICT: string[] = [];

async function seedCharging(opts: { completionWindowUntil?: Date | null } = {}) {
  const d = await lab.seedDeal({ state: "Charging", completionWindowUntil: opts.completionWindowUntil ?? null, participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  return { d, p: d.participants[0]! };
}
async function seedRecoverable(prior: "permanent_fail" | "unknown" = "permanent_fail", evidence?: "dispatch_response" | "status_inference" | null) {
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 5 * 60_000), participants: [
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: prior, correlation_id: `capture:review-prior:n1:${randomUUID()}`, dispatch_state: "responded", ...(evidence !== undefined ? { failure_evidence: evidence } : {}) }] }
  ] });
  return { d, p: d.participants[0]! };
}
async function seedCharged() {
  const d = await lab.seedDeal({ state: "Failed", participants: [
    { buyer_state: "DealFailed", money_state: "ChargedSuccess", qty: 2, delivery_cost: 3.5, priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: `capture:review-prior:n1:${randomUUID()}` }] }
  ] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  return { d, p };
}
async function seedHeld() {
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
  return { d, p: d.participants[0]! };
}
const skipFinalize = (e: { event_type: string }) => e.event_type === "finalize_deal";

// ── RA-1 — automatic recovery while the original capture can still settle ──────
//
// The candidate's F-9 fix reads the status twice and holds on a flap or a
// "pending". A provider that answers a CONSISTENT wrong final state for the
// whole time an asynchronous settlement is in progress (and the truth after it
// landed) is not a flap: both reads agree, the recovery proceeds, the delayed
// capture lands — two captures for one obligation. The only structural defence
// is a provider-specific settlement horizon before any automatic recovery.

async function delayedCaptureUnderWrongStatus(label: string, statusScript: StatusBehavior[], delayMs: number) {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "DELAYED_EFFECT", delayMs }]);
  lab.sim.scriptStatus(p.authorization, statusScript);
  const startedAt = Date.now();
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 120 });
  const remaining = delayMs + 300 - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 60 });
  const eff = lab.sim.effectsOf(p.authorization);
  const recoverRequests = lab.sim.requestsOf(p.authorization, "recover").length;
  const reads = lab.sim.requestsOf(p.authorization, "status").map((r) => r.behavior.replace(/^capture:/, "")).join(",");
  const row = await lab.participant(p.participant_id);
  console.log(`  ${label}: effects=${JSON.stringify(eff)} recover_requests=${recoverRequests} state=${row.buyer_state}/${row.money_state} status_reads=[${reads}] cases=${(await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]).join(",")}`);
  assert.equal(recoverRequests, 0, `${label}: an automatic recovery was sent while the original capture could still settle`);
  assert.equal(eff.capture + eff.recover, 1, `${label}: money must move exactly once, provider ledger ${JSON.stringify(eff)}`);
  return { d, p };
}

await run("RA-1a status answers failed/FINAL on every read while the capture is still settling (no flap) → no automatic recovery, exactly one capture", async () => {
  const { d } = await delayedCaptureUnderWrongStatus("failed-while-settling", [{ kind: "WHILE_SETTLING", state: "failed", final: true }], 900);
  await lab.oracle("ra1a", [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

await run("RA-1b status seam temporarily unavailable (500, 500) then failed/FINAL while still settling → no automatic recovery, exactly one capture", async () => {
  const { d } = await delayedCaptureUnderWrongStatus("unavailable-then-failed", [{ kind: "HTTP_500" }, { kind: "HTTP_500" }, { kind: "WHILE_SETTLING", state: "failed", final: true }], 1200);
  await lab.oracle("ra1b", [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

await run("RA-1c status answers authorized/FINAL (stale hold) while the capture is still settling → no automatic recovery, exactly one capture", async () => {
  const { d } = await delayedCaptureUnderWrongStatus("authorized-while-settling", [{ kind: "WHILE_SETTLING", state: "authorized", final: true }], 900);
  await lab.oracle("ra1c", [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

await run("RA-1d RESIDUAL BY CONTRACT (documented, not a candidate defect): a provider that keeps answering authorized/FINAL for ever for an EXECUTED capture defeats any client; the oracle must at least see the double", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "STALE_AUTHORIZED", final: true }, { kind: "STALE_AUTHORIZED", final: true }, { kind: "STALE_AUTHORIZED", final: true }, { kind: "STALE_AUTHORIZED", final: true }, { kind: "STALE_AUTHORIZED", final: true }, { kind: "STALE_AUTHORIZED", final: true }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 120, waitDeferredUpToMs: HORIZON_MS + 500 });
  const eff = lab.sim.effectsOf(p.authorization);
  const report = await auditFinancialTruth(lab.pool, { label: "ra1d", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  console.log(`  RESIDUAL provider lies about finality beyond any horizon: effects=${JSON.stringify(eff)} oracle=${report.violations.map((v) => v.code).join(",") || "clean"}`);
  if (eff.capture + eff.recover > 1) assert.ok(report.violations.some((v) => v.code === "DUPLICATE_CAPTURE"), "the oracle must report a double capture when it happens");
});

// ── RA-2 — F-6: AuthReleased is money truth and needs authoritative release proof ─

async function assertReleaseTruth(p: { participant_id: string; authorization: string }, label: string) {
  const row = await lab.participant(p.participant_id);
  const eff = lab.sim.effectsOf(p.authorization);
  const audits = (await lab.moneyAudits(p.participant_id)).filter((a) => a.state_type === "money_state").map((a) => `${a.from_state}->${a.to_state}(${a.action_name})`);
  console.log(`  ${label}: state=${row.buyer_state}/${row.money_state} provider=${JSON.stringify(eff)} money_audits=${audits.join(" ")} cases=${(await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]).join(",")}`);
  if (row.money_state === "AuthReleased") assert.equal(eff.release, 1, `${label}: AuthReleased without a provider release effect (hold left to provider expiry by assumption)`);
  return row;
}

await run("RA-2a F-6: recovery DECLINED by the provider → business state Dropped, money state released ONLY through a provider release (proof), never by assumption", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  lab.sim.script(p.authorization, "recover", [{ kind: "DECLINED" }]);
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize });
  const row = await assertReleaseTruth(p, "declined-recovery");
  assert.equal(row.buyer_state, "Dropped", "the business outcome (Dropped) is independent of the money truth");
  assert.equal(row.money_state, "AuthReleased", "with a provider that honours release the hold ends released WITH proof");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1, "exactly one provider release");
  await lab.oracle("ra2a", [d.deal_id], { allowedCodes: STRICT });
});

await run("RA-2b F-6 via reconciliation: recovery UNKNOWN (503 before effect), status proves not executed → recovery_failed → hold released only WITH proof", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  lab.sim.script(p.authorization, "recover", [{ kind: "NO_EFFECT_503" }]);
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 60 });
  const row = await assertReleaseTruth(p, "reconciled-recovery-failed");
  assert.equal(row.buyer_state, "Dropped");
  assert.equal(row.money_state, "AuthReleased");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  await lab.oracle("ra2b", [d.deal_id], { allowedCodes: STRICT });
});

await run("RA-2c F-6 when the provider REFUSES the release: money stays honestly held (ChargeFailedRecovery) with an operator case, business state Dropped, never AuthReleased", async () => {
  const { d, p } = await seedRecoverable("permanent_fail");
  lab.sim.script(p.authorization, "recover", [{ kind: "DECLINED" }]);
  lab.sim.script(p.authorization, "release", [{ kind: "DECLINED" }, { kind: "DECLINED" }, { kind: "DECLINED" }, { kind: "DECLINED" }]);
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 60 });
  const row = await assertReleaseTruth(p, "release-refused");
  assert.equal(row.buyer_state, "Dropped");
  assert.notEqual(row.money_state, "AuthReleased", "no release proof exists — AuthReleased would be a false money truth");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0);
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-release-failed")), "the unreleased hold must be an operator case");
  await lab.oracle("ra2c", [d.deal_id], { allowUnresolved: true, allowedCodes: STRICT });
});

// ── RA-3 — currency is part of the exact-operation identity ──────────────────────

await run("RA-3 a status answer with the right amount but the WRONG currency is a mismatch hold (case), never a captured verdict; the next truthful read converges", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_CURRENCY", currency: "USD" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"] });
  const reconcile = (await lab.liveEvents([d.deal_id], ["payment_reconcile"]))[0];
  assert.ok(reconcile, "UNKNOWN capture schedules a reconcile");
  const r = await lab.processOutboxEventById(reconcile!.event_uuid);
  const after = await lab.participant(p.participant_id);
  console.log(`  wrong-currency read: reconcile=${r?.status}:${String((r as any)?.error || "").slice(0, 60)} money_state=${after.money_state} cases=${(await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]).join(",")}`);
  assert.notEqual(after.money_state, "ChargedSuccess", "a USD answer for an ILS obligation was applied as canonical truth");
  assert.ok((await lab.cases(p.participant_id)).some((c) => /currency/i.test(c.auto_key) || /currency/i.test(c.subject)), "the currency mismatch must be a visible case");
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 60 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess", "the next truthful (ILS) read converges to the executed capture");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("ra3", [d.deal_id]);
});

// ── RA-4 — false provider truth: the trust boundary ───────────────────────────────
// A provider that lies about its OWN ledger with a matching reference, amount and
// currency cannot be caught by any client. These scenarios document that
// boundary and prove the lab's oracle sees every such lie.

await run("RA-4a provider says CAPTURED but never captured → canonical follows the provider (contract); the oracle reports FALSE_CANONICAL_SUCCESS", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "NO_EFFECT_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "LIE", state: "captured", amount_minor: p.amount_minor }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize });
  const row = await lab.participant(p.participant_id);
  const report = await auditFinancialTruth(lab.pool, { label: "ra4a", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat });
  console.log(`  CONTRACT_TRUST captured-lie: money_state=${row.money_state} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))} oracle=${report.violations.map((v) => v.code).join(",")}`);
  if (row.money_state === "ChargedSuccess") assert.ok(report.violations.some((v) => v.code === "FALSE_CANONICAL_SUCCESS"), "the oracle must catch a canonical success the provider ledger does not back");
});

await run("RA-4b provider says REFUNDED but never refunded → the oracle reports FALSE_CANONICAL_REFUND", async () => {
  const { d, p } = await seedCharged();
  lab.sim.script(p.authorization, "refund", [{ kind: "NO_EFFECT_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "LIE", state: "refunded", amount_minor: p.amount_minor }]);
  await lab.enqueueRefund(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id] });
  const row = await lab.participant(p.participant_id);
  const report = await auditFinancialTruth(lab.pool, { label: "ra4b", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat });
  console.log(`  CONTRACT_TRUST refunded-lie: money_state=${row.money_state} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))} oracle=${report.violations.map((v) => v.code).join(",")}`);
  if (row.money_state === "Refunded") assert.ok(report.violations.some((v) => v.code === "FALSE_CANONICAL_REFUND"));
});

await run("RA-4c provider says RELEASED but the hold remains → the oracle reports FALSE_CANONICAL_RELEASE", async () => {
  const { d, p } = await seedHeld();
  lab.sim.script(p.authorization, "release", [{ kind: "HANG_NO_EFFECT" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "LIE", state: "released" }]);
  await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  const row = await lab.participant(p.participant_id);
  const report = await auditFinancialTruth(lab.pool, { label: "ra4c", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat });
  console.log(`  CONTRACT_TRUST released-lie: money_state=${row.money_state} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))} oracle=${report.violations.map((v) => v.code).join(",")}`);
  if (row.money_state === "AuthReleased") assert.ok(report.violations.some((v) => v.code === "FALSE_CANONICAL_RELEASE"));
});

await run("RA-4d provider says captured with the WRONG amount → mismatch case, no verdict (amount is part of the identity)", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_AMOUNT", amount_minor: p.amount_minor + 100 }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"] });
  const reconcile = (await lab.liveEvents([d.deal_id], ["payment_reconcile"]))[0]!;
  await lab.processOutboxEventById(reconcile.event_uuid);
  assert.notEqual((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-reconcile-amount-mismatch")));
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 60 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess", "a later truthful read converges");
  await lab.oracle("ra4d", [d.deal_id]);
});

// ── RA-5 — exact operation identity: a status echo naming ANOTHER reference ──────

await run("RA-5 a status answer for reference X that names reference Y must not rewrite the participant's binding (evidence not tied to the exact operation)", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_REFERENCE" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize });
  const binding = (await lab.pool.query(`SELECT provider_reference FROM siton.payment_authorization_bindings WHERE consumed_by_participant_id=$1`, [p.participant_id])).rows[0] as { provider_reference: string };
  const stored = String(binding.provider_reference).replace(/^(cap|rec|ref|rel)-/, "");
  console.log(`  wrong-reference echo: binding now ${binding.provider_reference} (authorization ${p.authorization}) money_state=${(await lab.participant(p.participant_id)).money_state}`);
  assert.equal(stored, p.authorization, `the binding reference drifted to ${binding.provider_reference}`);
  await lab.oracle("ra5", [d.deal_id]);
});

// ── RA-6 — the recovery pre-flight that cannot verify must hold ─────────────────

await run("RA-6 recovery pre-flight: status seam answers 500 on every read → the recovery is HELD (visible), never sent; a truthful seam later lets it run once", async () => {
  // the capture failure was INFERRED (status) and its horizon elapsed: only a verifiable status may let money move
  const { d, p } = await seedRecoverable("permanent_fail", "status_inference");
  lab.sim.scriptStatus(p.authorization, Array.from({ length: 12 }, () => ({ kind: "HTTP_500" as const })));
  const event = await lab.enqueueRecovery(d.deal_id);
  const r = await lab.processOutboxEventById(event);
  console.log(`  unverifiable pre-flight: job=${r?.status}:${String((r as any)?.error || "").slice(0, 70)} recover_requests=${lab.sim.requestsOf(p.authorization, "recover").length} cases=${(await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]).join(",")}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "a recovery capture was sent although the original capture could not be verified");
  assert.notEqual((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  lab.sim.clearStatusScript(p.authorization);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 60 });
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge", "once the seam answers truthfully the recovery runs exactly once");
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
  await lab.oracle("ra6", [d.deal_id]);
});

// ── RA-7 — release vs release ─────────────────────────────────────────────────────

await run("RA-7 release vs release: two workers claim one release job → exactly one provider release, AuthReleased once", async () => {
  const { d, p } = await seedHeld();
  const event = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const [a, b] = await Promise.all([lab.processOutboxEventById(event), lab.processOutboxEventById(event)]);
  assert.equal([a, b].filter(Boolean).length, 1, "exactly one worker may claim the job");
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.oracle("ra7", [d.deal_id]);
});

// ── RA-8 — oracle anti-vacuity (plants the author did not plant) ─────────────────

await run("RA-8a plant: a FALSE money audit row is reported (AUDIT_CHAIN_DIVERGES)", async () => {
  const { d, p } = await seedCharging();
  await lab.oracle("ra8a:clean", [d.deal_id]);
  await lab.pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'money_state','ChargeAttempt','ChargedSuccess','test.plant_false_audit','review-plant',$3,'{}')`,
    [p.participant_id, d.deal_id, `plant:${randomUUID()}`]
  );
  const report = await auditFinancialTruth(lab.pool, { label: "ra8a", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat });
  assert.ok(report.violations.some((v) => v.code === "AUDIT_CHAIN_DIVERGES"), `expected AUDIT_CHAIN_DIVERGES, got ${JSON.stringify(report.violations)}`);
});

await run("RA-8b plant: an UNKNOWN identity whose operational case is deleted is reported (UNRESOLVED_WITHOUT_CASE)", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, Array.from({ length: 30 }, () => ({ kind: "HTTP_500" as const })));
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 12 });
  const before = await auditFinancialTruth(lab.pool, { label: "ra8b:before", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  assert.ok(!before.violations.some((v) => v.code === "UNRESOLVED_WITHOUT_CASE"), `clean before the plant: ${JSON.stringify(before.violations)}`);
  await lab.pool.query(`DELETE FROM siton.operational_cases WHERE auto_key LIKE '%' || $1 || '%'`, [p.participant_id]);
  await lab.pool.query(`DELETE FROM siton.outbox_events WHERE event_type='payment_reconcile' AND aggregate_id=$1`, [p.participant_id]);
  const report = await auditFinancialTruth(lab.pool, { label: "ra8b", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  assert.ok(report.violations.some((v) => v.code === "UNRESOLVED_WITHOUT_CASE"), `expected UNRESOLVED_WITHOUT_CASE, got ${JSON.stringify(report.violations)}`);
  lab.sim.clearStatusScript(p.authorization);
});

await run("RA-8c plant: a binding whose provider reference no longer names the participant's authorization is reported (BINDING_REFERENCE_DRIFT)", async () => {
  const { d, p } = await seedCharging();
  await lab.pool.query(`UPDATE siton.payment_authorization_bindings SET provider_reference=$2 WHERE consumed_by_participant_id=$1`, [p.participant_id, `other-${randomUUID().slice(0, 8)}`]);
  const report = await auditFinancialTruth(lab.pool, { label: "ra8c", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, participantAuthorizations: { [p.participant_id]: p.authorization } });
  assert.ok(report.violations.some((v) => v.code === "BINDING_REFERENCE_DRIFT"), `expected BINDING_REFERENCE_DRIFT, got ${JSON.stringify(report.violations)}`);
});

await run("RA-8d plant: a provider capture of the WRONG amount is reported (CAPTURE_AMOUNT_MISMATCH)", async () => {
  const d = await lab.seedDeal({ state: "ClosedForJoining", participants: [{ buyer_state: "LockedIn", money_state: "AuthLocked" }] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor + 1);
  const report = await auditFinancialTruth(lab.pool, { label: "ra8d", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, participantAuthorizations: { [p.participant_id]: p.authorization } });
  assert.ok(report.violations.some((v) => v.code === "CAPTURE_AMOUNT_MISMATCH"), `expected CAPTURE_AMOUNT_MISMATCH, got ${JSON.stringify(report.violations)}`);
});

// ── RA-9 — a terminal deal decision while a capture may still settle ─────────────

await run("RA-9 the completion window ends while a status-inferred 'failed' capture is still settling → the deal is not finalized on that verdict; the late capture becomes VISIBLE truth (identity success + case), never a released-then-captured hold", async () => {
  const { d, p } = await seedCharging({ completionWindowUntil: new Date(Date.now() + 600) });
  lab.sim.script(p.authorization, "capture", [{ kind: "DELAYED_EFFECT", delayMs: 900 }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WHILE_SETTLING", state: "failed", final: true }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 150, waitDeferredUpToMs: HORIZON_MS + 500 });
  await sleep(200);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 60, waitDeferredUpToMs: HORIZON_MS + 500 });
  const eff = lab.sim.effectsOf(p.authorization);
  const row = await lab.participant(p.participant_id);
  const deal = await lab.deal(d.deal_id);
  const capture = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  const cases = (await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]);
  console.log(`  window-end race: deal=${deal.state} state=${row.buyer_state}/${row.money_state} capture_identity=${capture.result_class} effects=${JSON.stringify(eff)} cases=${cases.join(",")}`);
  assert.equal(eff.capture + eff.recover, 1, `money must move exactly once: ${JSON.stringify(eff)}`);
  assert.equal(eff.release, 0, "a hold whose capture was still settling must not be released (release-then-capture)");
  assert.equal(capture.result_class, "success", "the late capture must become visible truth on the capture identity");
  assert.ok(cases.some((c) => c === "payment-late-money-effect" || c === "payment-recovery-preflight-captured"), "the charged buyer on a non-completed deal must be an operator case");
  await lab.oracle("ra9", [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE", "FAILED_DEAL_HOLDS_CAPTURED_MONEY", "MONEY_EVENTS_NOT_QUIESCENT"] });
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
