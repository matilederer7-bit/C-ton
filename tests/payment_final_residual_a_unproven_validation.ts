// FINAL FINANCIAL INTEGRATION — RESIDUAL A on a provider whose NEGATIVE
// FINALITY IS UNPROVEN (PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE=false, the
// contract situation of Grow).
//
// Rule under test: horizon expiry BY ITSELF never authorises automatic recovery.
// After a dispatched capture, automatic recovery needs BOTH an elapsed
// settlement horizon AND exact-operation evidence whose negative finality is
// classified authoritative for the provider / operation contract. Here the
// contract proves nothing negative, so whatever the status seam answers —
// before or after the horizon — the participant stays UNRESOLVED with an
// operator case: no recovery, no fresh money identity, no release.
//
//   AU-1  consistent failed/final beyond the horizon + late capture
//   AU-2  consistent authorized/final beyond the horizon + late capture
//   AU-3  unknown beyond the horizon
//   AU-4  provider unavailable (500) beyond the horizon
//   AU-5  wrong-reference negative beyond the horizon
//   AU-6  wrong-currency negative beyond the horizon
//   AU-7  status reflects a sibling operation (executed recovery) — positive proof only
//   AU-8  stale cached final status (authorized/final for ever) after an executed capture
//   AU-9  a provider-EVENT failure (charge_failed callback) on this contract is fenced
//         permanently inside the window: recovery / release hold with cases + DB backstop;
//         the operator path (failure_evidence='operator') is the only way out — then
//         exactly one recovery (the recovery rail acts only inside the completion window)
//   AU-9b the terminal decision is held permanently (case, DLQ) on the same evidence;
//         operator evidence lets finalize decide — a proofed release, never a capture
//
// Economic duplicate effect must remain 0. Synthetic money only.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner, sleep } from "./lab/runtime.js";
import { auditFinancialTruth } from "./lab/oracle.js";

const HORIZON_MS = 700;
const lab = await bootLab({
  tag: "residual-a-unproven",
  port: 3166,
  simulator: { nativeIdempotency: false },
  env: { COMPLETION_WINDOW_MINUTES: "1", PAYMENT_SETTLEMENT_HORIZON_MS: String(HORIZON_MS), PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE: "false" },
  outboxMaxAttempts: 4
});
const { run, summary } = makeRunner("payment_final_residual_a_unproven");
const skipFinalize = (e: { event_type: string }) => e.event_type === "finalize_deal";
const casesOf = async (pid: string) => (await lab.cases(pid)).map((c) => c.auto_key.split(":")[0]);

async function seedCharging() {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  return { d, p: d.participants[0]! };
}

/** Assert the unproven-contract invariants for one participant. */
async function assertFailClosed(label: string, p: { participant_id: string; authorization: string }, dealId: string) {
  const eff = lab.sim.effectsOf(p.authorization);
  const rows = await lab.attempts(p.participant_id);
  const state = await lab.participant(p.participant_id);
  const cases = await casesOf(p.participant_id);
  console.log(`  ${label}: state=${state.buyer_state}/${state.money_state} effects=${JSON.stringify(eff)} identities=${rows.map((r) => `${r.attempt_type}=${r.result_class}`).join(",")} cases=${cases.join(",")} status_reads=${lab.sim.requestsOf(p.authorization, "status").length}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, `${label}: an automatic recovery was sent on an unproven negative`);
  assert.equal(eff.recover, 0);
  assert.ok(eff.capture + eff.recover <= 1, `${label}: duplicate money effect ${JSON.stringify(eff)}`);
  assert.equal(rows.filter((r) => r.attempt_type === "charge_start").length, 1, `${label}: the capture identity rotated`);
  assert.equal(rows.filter((r) => r.attempt_type === "recovery").length, 0, `${label}: a recovery identity was minted`);
  assert.equal(eff.release, 0, `${label}: the hold was released while the capture outcome was unproven`);
  const resolved = ["ChargedSuccess", "RecoveredCharge"].includes(state.money_state);
  if (!resolved) assert.ok(cases.length > 0, `${label}: unresolved without an operator case`);
  void dealId;
  return { eff, rows, state, cases };
}

async function driveBeyondHorizon(dealId: string) {
  // charge + reconcile attempts (bounded), then let the horizon pass, then let
  // the recovery job / sweepers run — nothing must recover automatically
  await lab.drain({ dealIds: [dealId], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  await sleep(HORIZON_MS + 200);
  await lab.drain({ dealIds: [dealId], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
}

// ── AU-1 / AU-2 ────────────────────────────────────────────────────────────────
for (const [label, wrong] of [["AU-1 consistent failed/final", "failed"], ["AU-2 consistent authorized/final", "authorized"]] as const) {
  await run(`${label} beyond the horizon while the capture settles late → no verdict, no recovery, the late capture converges as positive proof`, async () => {
    const { d, p } = await seedCharging();
    lab.sim.script(p.authorization, "capture", [{ kind: "DELAYED_EFFECT", delayMs: HORIZON_MS + 300 }]);
    lab.sim.scriptStatus(p.authorization, [{ kind: "WHILE_SETTLING", state: wrong, final: true }]);
    await lab.enqueueCharge(d.deal_id);
    await driveBeyondHorizon(d.deal_id);
    const { state, cases } = await assertFailClosed(label, p, d.deal_id);
    assert.ok(cases.includes("payment-outcome-unresolved") || cases.includes("payment-reconcile-unresolved") || cases.includes("payment-operation-blocked"), `${label}: the negative was not surfaced as a case`);
    // positive proof (the truth once the effect landed) is the only automatic path
    await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
    const after = await lab.participant(p.participant_id);
    console.log(`  ${label}: after positive proof state=${after.money_state}`);
    assert.ok(["ChargedSuccess", "ChargeAttempt"].includes(after.money_state), `unexpected ${after.money_state}`);
    assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
    void state;
    await lab.oracle(label, [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
  });
}

// ── AU-3 / AU-4 ────────────────────────────────────────────────────────────────
for (const [label, script] of [["AU-3 unknown", [{ kind: "UNKNOWN" as const, persist: true }]], ["AU-4 provider unavailable (500)", [{ kind: "HTTP_500" as const, persist: true }]]] as const) {
  await run(`${label} beyond the horizon → stays UNRESOLVED with a case; no recovery, no rotation, no release`, async () => {
    const { d, p } = await seedCharging();
    lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
    lab.sim.scriptStatus(p.authorization, [...script]);
    await lab.enqueueCharge(d.deal_id);
    await driveBeyondHorizon(d.deal_id);
    const { rows } = await assertFailClosed(label, p, d.deal_id);
    assert.equal(rows.find((r) => r.attempt_type === "charge_start")?.result_class, "unknown", "no verdict without evidence");
    lab.sim.clearStatusScript(p.authorization);
    await lab.oracle(label, [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
  });
}

// ── AU-5 / AU-6 ────────────────────────────────────────────────────────────────
await run("AU-5 wrong-reference negative beyond the horizon → reference mismatch case, no verdict, no recovery", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "NO_EFFECT_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_REFERENCE", persist: true }]);
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  const { cases } = await assertFailClosed("AU-5", p, d.deal_id);
  assert.ok(cases.includes("payment-reconcile-reference-mismatch") || cases.includes("payment-outcome-unresolved"), `expected a reference-mismatch / unresolved case, got ${cases.join(",")}`);
  lab.sim.clearStatusScript(p.authorization);
  await lab.oracle("AU-5", [d.deal_id], { allowUnresolved: true });
});

await run("AU-6 wrong-currency negative beyond the horizon → currency mismatch case, no verdict, no recovery", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "NO_EFFECT_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_CURRENCY", currency: "USD", persist: true }]);
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  const { cases } = await assertFailClosed("AU-6", p, d.deal_id);
  assert.ok(cases.includes("payment-reconcile-currency-mismatch") || cases.includes("payment-outcome-unresolved"), `expected a currency-mismatch / unresolved case, got ${cases.join(",")}`);
  lab.sim.clearStatusScript(p.authorization);
  await lab.oracle("AU-6", [d.deal_id], { allowUnresolved: true });
});

// ── AU-7 ───────────────────────────────────────────────────────────────────────
await run("AU-7 status reflects a SIBLING operation (an executed recovery): positive proof converges that identity; no second recovery", async () => {
  const recoveryCorrelation = `recovery:au7:n1:${randomUUID()}`;
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [
    { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [
      { attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "dispatch_response", negative_finality_authoritative: false },
      { attempt_type: "recovery", result_class: "unknown", correlation_id: recoveryCorrelation, dispatch_state: "responded", negative_finality_authoritative: false }
    ] }
  ] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("recover", p.authorization, p.amount_minor); // the recovery executed; its answer was lost
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const rows = await lab.attempts(p.participant_id, "recovery");
  const state = await lab.participant(p.participant_id);
  console.log(`  AU-7: state=${state.money_state} recovery_identities=${rows.map((r) => r.result_class).join(",")} recover_requests=${lab.sim.requestsOf(p.authorization, "recover").length}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no second recovery request");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.result_class, "success", "positive proof converged the sibling identity");
  assert.equal(state.money_state, "RecoveredCharge");
  await lab.oracle("AU-7", [d.deal_id]);
});

// ── AU-8 ───────────────────────────────────────────────────────────────────────
await run("AU-8 stale cached final status (authorized/final for ever) after an EXECUTED capture → unresolved with a case; never a recovery", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "STALE_AUTHORIZED", final: true, persist: true }]);
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  const { eff, rows } = await assertFailClosed("AU-8", p, d.deal_id);
  assert.equal(eff.capture, 1);
  assert.equal(rows.find((r) => r.attempt_type === "charge_start")?.result_class, "unknown", "a stale negative on an unproven contract is not a verdict");
  lab.sim.clearStatusScript(p.authorization);
  await lab.oracle("AU-8", [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
});

// ── AU-9 ───────────────────────────────────────────────────────────────────────
await run("AU-9 a provider-EVENT failure on this contract is fenced PERMANENTLY inside the completion window (recovery / release hold with cases, DB backstop); operator evidence is the only way out — then exactly one recovery", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "NO_EFFECT_503" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"], maxRounds: 5 });
  const capture = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(capture.result_class, "unknown");
  assert.equal(capture.negative_finality_authoritative, false, "the contract's authority is recorded on the identity at dispatch");
  // the provider pushes charge_failed (a callback is not exact-request evidence)
  const hook = await lab.postWebhook({ event_type: "charge_failed", provider_reference: p.authorization, correlation_id: capture.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.equal(hook.statusCode, 200);
  const failed = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(failed.result_class, "permanent_fail");
  assert.equal(failed.failure_evidence, "provider_event");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeFailedRecovery");
  await sleep(HORIZON_MS + 200); // the horizon elapses — irrelevant on this contract
  // recovery: permanent fence (the charge_deal job already armed a recovery_deal at the window transition)
  const recovery = (await lab.liveEvents([d.deal_id], ["recovery_deal"]))[0]?.event_uuid || (await lab.enqueueRecovery(d.deal_id));
  const r = await lab.processOutboxEventById(recovery);
  console.log(`  AU-9 recovery: ${r?.status} ${String((r as any)?.error || "").slice(0, 60)} cases=${(await casesOf(p.participant_id)).join(",")}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no recovery beyond the horizon without authoritative negative finality");
  assert.ok((await casesOf(p.participant_id)).includes("payment-recovery-negative-finality-unproven"));
  assert.equal((await lab.attempts(p.participant_id, "recovery")).length, 0, "no recovery identity minted");
  // release: permanent fence
  const release = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const rel = await lab.processOutboxEventById(release);
  assert.match(String((rel as any)?.error || ""), /negative_finality_unproven/);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0);
  assert.ok((await casesOf(p.participant_id)).includes("payment-release-negative-finality-unproven"));
  // DB backstop: a recovery identity cannot be minted directly either
  await assert.rejects(
    lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,'recovery','unknown',$3,'recorded')`, [p.participant_id, d.deal_id, `recovery:au9:${randomUUID()}`]),
    (error: any) => String(error?.code) === "SN409" && /negative_finality_unproven/.test(String(error?.message))
  );
  // The operator verifies at the provider and records exact evidence. The fenced
  // recovery run completed with its case (a per-deal job never stays live for one
  // held participant), so the recovery job is re-armed the product way (the buyer's
  // recovery request / an operator re-arm enqueue recovery_deal) — nothing recovers
  // on evidence alone. The recovery rail acts only INSIDE the completion window
  // (after it, the terminal decision owns the participant — AU-9b).
  await lab.pool.query(`UPDATE siton.payment_attempts SET failure_evidence='operator' WHERE participant_id=$1 AND attempt_type='charge_start'`, [p.participant_id]);
  assert.equal((await lab.liveEvents([d.deal_id], ["recovery_deal"])).length, 0, "no recovery job is live while the hold is unresolved");
  const remainingMs = Number((await lab.pool.query(`SELECT CEIL(EXTRACT(EPOCH FROM (completion_window_until - clock_timestamp())) * 1000) AS ms FROM siton.deals WHERE deal_id=$1`, [d.deal_id])).rows[0]?.ms || 0);
  assert.ok(remainingMs > 5_000, `the completion window is still open (${remainingMs} ms left)`);
  await lab.enqueueRecovery(d.deal_id);
  const drained = await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const eff = lab.sim.effectsOf(p.authorization);
  const state = await lab.participant(p.participant_id);
  console.log(`  AU-9 after operator evidence: state=${state.money_state} effects=${JSON.stringify(eff)} status_reads=${lab.sim.requestsOf(p.authorization, "status").length} drain=${JSON.stringify(drained.results.map((x) => `${x.event_type}:${x.status}:${String(x.error || "").slice(0, 80)}`))}`);
  assert.equal(eff.recover, 1, "exactly one recovery once an operator recorded exact evidence");
  assert.equal(eff.capture, 0);
  assert.equal(state.money_state, "RecoveredCharge");
  await lab.oracle("AU-9", [d.deal_id], { allowUnresolved: true });
});

await run("AU-9b the terminal decision on this contract is held PERMANENTLY (case, neither Completed nor Failed, no release) on a provider-event failure; operator evidence lets it decide — a proofed release, never a capture", async () => {
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() - 5_000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "provider_event", settlement_horizon_at: new Date(Date.now() - 1_000), negative_finality_authoritative: false }] }] });
  const p = d.participants[0]!;
  const finalize = await lab.enqueueFinalize(d.deal_id);
  const fin = await lab.processOutboxEventById(finalize);
  console.log(`  AU-9b finalize: ${fin?.status} ${String((fin as any)?.error || "").slice(0, 60)} deal=${(await lab.deal(d.deal_id)).state}`);
  assert.match(String((fin as any)?.error || ""), /finalize_negative_finality_unproven/);
  assert.equal((await lab.deal(d.deal_id)).state, "CompletionWindow", "no terminal decision on unproven negative finality");
  assert.equal((await lab.pool.query(`SELECT 1 FROM siton.operational_cases WHERE auto_key=$1`, [`deal-finalize-negative-finality-unproven:${d.deal_id}`])).rowCount, 1);
  assert.equal((await lab.dlqRows(d.deal_id, "finalize_deal")).length, 1, "the held finalize is parked in the DLQ (operator-visible), not retried blindly");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0, "no hold is released on the unproven negative");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeFailedRecovery");
  // the operator verifies at the provider and records exact evidence; the
  // maintenance rescheduler brings finalize back (window elapsed, nothing live)
  await lab.pool.query(`UPDATE siton.payment_attempts SET failure_evidence='operator' WHERE participant_id=$1 AND attempt_type='charge_start'`, [p.participant_id]);
  const drained = await lab.drain({ dealIds: [d.deal_id], maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const eff = lab.sim.effectsOf(p.authorization);
  const state = await lab.participant(p.participant_id);
  console.log(`  AU-9b after operator evidence: deal=${(await lab.deal(d.deal_id)).state} state=${state.buyer_state}/${state.money_state} effects=${JSON.stringify(eff)} drain=${JSON.stringify(drained.results.map((x) => `${x.event_type}:${x.status}:${String(x.error || "").slice(0, 80)}`))}`);
  assert.equal((await lab.deal(d.deal_id)).state, "Failed", "past the window the terminal decision decides on exact evidence");
  assert.equal(eff.capture + eff.recover, 0, "a terminal decision never captures");
  assert.equal(eff.release, 1, "the hold is released WITH provider proof");
  assert.equal(state.money_state, "AuthReleased");
  await lab.oracle("AU-9b", [d.deal_id]);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
