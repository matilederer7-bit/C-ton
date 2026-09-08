// FINAL FINANCIAL INTEGRATION — RESIDUAL C: CAPTURE / RECOVERY WHILE A RELEASE
// OF THE SAME AUTHORIZATION IS ECONOMICALLY UNRESOLVED.
//
// Rule under test: no capture and no recovery may START while a release of the
// relevant authorization is unresolved (in flight, or answered ambiguously) or
// executed. The application fence (beginProviderAttempt) defers or refuses the
// capture-side operation; migration 064's INSERT trigger refuses the identity at
// the database; a hold released while a charge was pending ends AuthReleased with
// the capture never dispatched.
//
//   RC-1  capture vs release in flight (release effect applied, worker parked)
//   RC-2  recovery vs release in flight
//   RC-3  two in-process workers: the charge job runs while the release job holds its lease
//   RC-4  lease loss: the release owner dies, a successor reclaims and proves the release; the capture never starts
//   RC-5  release effect then 503 → release UNKNOWN → capture deferred → reconcile proves the release → AuthReleased
//   RC-6  release effect then timeout → same
//   RC-7  release status UNKNOWN for ever → capture stays held (bounded, DLQ + case); never dispatched
//   RC-8  release definitely failed (declined) → the hold is intact → the capture proceeds once
//   RC-9  DB backstop: a charge_start / recovery identity cannot be minted while a release is unknown or executed
//
// Synthetic money only. Non-idempotent provider.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner, sleep } from "./lab/runtime.js";
import type { Behavior } from "./lab/provider_simulator.js";

const lab = await bootLab({
  tag: "residual-c",
  port: 3169,
  simulator: { nativeIdempotency: false },
  env: { COMPLETION_WINDOW_MINUTES: "1", PAYMENT_SETTLEMENT_HORIZON_MS: "700" },
  outboxMaxAttempts: 4
});
const { run, summary } = makeRunner("payment_final_residual_c");
const skipFinalize = (e: { event_type: string }) => e.event_type === "finalize_deal";
const casesOf = async (pid: string) => (await lab.cases(pid)).map((c) => c.auto_key.split(":")[0]);

/** the deal-level charging.start transition (LockedIn/AuthLocked → ChargingAttempt/ChargeAttempt) as the app performs it */
async function chargingStart(p: { participant_id: string }, dealId: string) {
  const c = await lab.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('siton.action_name','charging.start',true), set_config('siton.is_worker','true',true), set_config('siton.request_id','residual-c',true)`);
    for (const [stateType, fromState, toState] of [["buyer_state", "LockedIn", "ChargingAttempt"], ["money_state", "AuthLocked", "ChargeAttempt"]] as const) {
      await c.query(`INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload) VALUES ('participant',$1,$2,$3,$4,$5,'charging.start','residual-c',$6,'{}')`, [p.participant_id, dealId, stateType, fromState, toState, `residual-c:${stateType}:${p.participant_id}:${randomUUID().slice(0, 8)}`]);
    }
    await c.query(`SELECT set_config('siton.audit_written','1',true)`);
    await c.query(`UPDATE siton.participants SET buyer_state='ChargingAttempt', money_state='ChargeAttempt' WHERE participant_id=$1`, [p.participant_id]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; } finally { c.release(); }
}
async function seedLocked() {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "LockedIn", money_state: "AuthLocked" }] });
  return { d, p: d.participants[0]! };
}
async function assertNoContradiction(label: string, p: { participant_id: string; authorization: string }, dealId: string) {
  const eff = lab.sim.effectsOf(p.authorization);
  const state = await lab.participant(p.participant_id);
  const rows = await lab.attempts(p.participant_id);
  console.log(`  ${label}: state=${state.buyer_state}/${state.money_state} effects=${JSON.stringify(eff)} capture_requests=${lab.sim.requestsOf(p.authorization, "capture").length} recover_requests=${lab.sim.requestsOf(p.authorization, "recover").length} identities=${rows.map((r) => `${r.attempt_type}=${r.result_class}`).join(",")} cases=${(await casesOf(p.participant_id)).join(",")}`);
  assert.equal(eff.capture + eff.recover, 0, `${label}: a capture-side effect on a released/unresolved hold`);
  assert.ok(!(eff.release > 0 && eff.capture + eff.recover > 0), `${label}: contradictory economic operations`);
  assert.ok(eff.release <= 1, `${label}: duplicate release`);
  return { eff, state, rows };
}

// ── RC-1 ───────────────────────────────────────────────────────────────────────
await run("RC-1 capture vs release IN FLIGHT: the capture is never dispatched; the release truth ends the hold as AuthReleased (ChargeAttempt → AuthReleased)", async () => {
  const { d, p } = await seedLocked();
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const releaseRun = lab.processOutboxEventById(releaseEvent);
  await barrier!.entered; // released at the provider, worker parked before it can settle
  await chargingStart(p, d.deal_id);
  const chargeEvent = await lab.enqueueCharge(d.deal_id);
  const charge = await lab.processOutboxEventById(chargeEvent);
  console.log(`  RC-1 charge while release in flight: ${charge?.status} ${String((charge as any)?.error || "").slice(0, 70)}`);
  assert.match(String((charge as any)?.error || ""), /charge_held_behind_unresolved_release/, "the charge job must defer, not dispatch");
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, "no capture request while the release is in flight");
  assert.ok((await casesOf(p.participant_id)).includes("payment-operation-blocked"));
  barrier!.release();
  await releaseRun;
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const { state } = await assertNoContradiction("RC-1", p, d.deal_id);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, "the capture was never dispatched");
  assert.equal(state.money_state, "AuthReleased", "the money truth is the provider-proofed release");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  await lab.oracle("RC-1", [d.deal_id], { allowUnresolved: true });
});

// ── RC-2 ───────────────────────────────────────────────────────────────────────
await run("RC-2 recovery vs release IN FLIGHT: no recovery request; the release truth wins", async () => {
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "dispatch_response" }] }] });
  const p = d.participants[0]!;
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const releaseRun = lab.processOutboxEventById(releaseEvent);
  await barrier!.entered;
  const recoveryEvent = await lab.enqueueRecovery(d.deal_id);
  const recovery = await lab.processOutboxEventById(recoveryEvent);
  console.log(`  RC-2 recovery while release in flight: ${recovery?.status} ${String((recovery as any)?.error || "").slice(0, 70)}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no recovery request while the release is in flight");
  barrier!.release();
  await releaseRun;
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const { state } = await assertNoContradiction("RC-2", p, d.deal_id);
  assert.equal(state.money_state, "AuthReleased");
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  await lab.oracle("RC-2", [d.deal_id], { allowUnresolved: true });
});

// ── RC-3 ───────────────────────────────────────────────────────────────────────
await run("RC-3 two in-process workers: the charge job races the parked release job → no capture, one release, consistent end state", async () => {
  const { d, p } = await seedLocked();
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const releaseRun = lab.processOutboxEventById(releaseEvent);
  await barrier!.entered;
  await chargingStart(p, d.deal_id);
  const chargeEvent = await lab.enqueueCharge(d.deal_id);
  const [charge] = await Promise.all([lab.processOutboxEventById(chargeEvent), sleep(80).then(() => { barrier!.release(); return releaseRun; })]);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, `no capture request (charge job: ${charge?.status} ${String((charge as any)?.error || "").slice(0, 60)})`);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const { state } = await assertNoContradiction("RC-3", p, d.deal_id);
  assert.equal(state.money_state, "AuthReleased");
  await lab.oracle("RC-3", [d.deal_id], { allowUnresolved: true });
});

// ── RC-4 ───────────────────────────────────────────────────────────────────────
await run("RC-4 lease loss: the release owner dies after the effect; a successor reclaims and proves the release; the capture never starts; the stale owner is fenced", async () => {
  const { d, p } = await seedLocked();
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const staleRun = lab.processOutboxEventById(releaseEvent);
  await barrier!.entered;
  await chargingStart(p, d.deal_id);
  // the owner's lease dies; a successor reclaims the job
  await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [releaseEvent]);
  await lab.reclaimWorkerJobs(0);
  const chargeEvent = await lab.enqueueCharge(d.deal_id);
  const charge = await lab.processOutboxEventById(chargeEvent);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, `no capture while the release is unresolved (charge: ${charge?.status} ${String((charge as any)?.error || "").slice(0, 60)})`);
  const successor = await lab.processOutboxEventById(releaseEvent);
  console.log(`  RC-4 successor: ${successor?.status} ${String((successor as any)?.error || "").slice(0, 60)}`);
  barrier!.release();
  const stale = await staleRun;
  console.log(`  RC-4 stale owner: ${stale?.status} ${String((stale as any)?.error || "").slice(0, 60)}`);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const { state } = await assertNoContradiction("RC-4", p, d.deal_id);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1, "exactly one release effect");
  assert.equal(state.money_state, "AuthReleased");
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0);
  await lab.oracle("RC-4", [d.deal_id], { allowUnresolved: true });
});

// ── RC-5 / RC-6 ────────────────────────────────────────────────────────────────
for (const [label, behavior] of [["RC-5 release effect then 503", { kind: "EFFECT_THEN_503" }], ["RC-6 release effect then timeout", { kind: "EFFECT_THEN_TIMEOUT" }]] as Array<[string, Behavior]>) {
  await run(`${label} → release UNKNOWN → the capture is held, the reconcile proves the release → AuthReleased, capture never dispatched`, async () => {
    const { d, p } = await seedLocked();
    lab.sim.script(p.authorization, "release", [behavior]);
    const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
    await lab.processOutboxEventById(releaseEvent);
    assert.equal((await lab.attempts(p.participant_id, "release"))[0]?.result_class, "unknown");
    await chargingStart(p, d.deal_id);
    const chargeEvent = await lab.enqueueCharge(d.deal_id);
    const charge = await lab.processOutboxEventById(chargeEvent);
    assert.match(String((charge as any)?.error || ""), /charge_held_behind_unresolved_release/);
    assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0);
    await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
    const { state } = await assertNoContradiction(label, p, d.deal_id);
    assert.equal(state.money_state, "AuthReleased");
    assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
    await lab.oracle(label, [d.deal_id], { allowUnresolved: true });
  });
}

// ── RC-7 ───────────────────────────────────────────────────────────────────────
await run("RC-7 release status UNKNOWN for ever → the capture stays held (bounded retries, DLQ + case); it is never dispatched", async () => {
  const { d, p } = await seedLocked();
  lab.sim.script(p.authorization, "release", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, Array.from({ length: 40 }, () => ({ kind: "HTTP_500" as const })));
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.processOutboxEventById(releaseEvent);
  await chargingStart(p, d.deal_id);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const { state } = await assertNoContradiction("RC-7", p, d.deal_id);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 0, "never dispatched");
  assert.equal(state.money_state, "ChargeAttempt", "still honestly undecided");
  const dlq = await lab.dlqRows(d.deal_id, "charge_deal");
  console.log(`  RC-7 charge_deal dlq=${dlq.length} cases=${(await casesOf(p.participant_id)).join(",")}`);
  assert.ok(dlq.length === 1 || (await lab.liveEvents([d.deal_id], ["charge_deal"])).length === 1, "the held charge is visible (DLQ or still live)");
  assert.ok((await casesOf(p.participant_id)).includes("payment-operation-blocked"));
  lab.sim.clearStatusScript(p.authorization);
});

// ── RC-8 ───────────────────────────────────────────────────────────────────────
await run("RC-8 release DEFINITELY failed (declined by the provider) → the hold is intact → the capture proceeds exactly once", async () => {
  const { d, p } = await seedLocked();
  lab.sim.script(p.authorization, "release", [{ kind: "DECLINED" }]);
  const releaseEvent = await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.processOutboxEventById(releaseEvent);
  assert.equal((await lab.attempts(p.participant_id, "release"))[0]?.result_class, "permanent_fail");
  await chargingStart(p, d.deal_id);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const eff = lab.sim.effectsOf(p.authorization);
  console.log(`  RC-8: effects=${JSON.stringify(eff)} state=${(await lab.participant(p.participant_id)).money_state}`);
  assert.equal(eff.capture, 1);
  assert.equal(eff.release, 0);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  await lab.oracle("RC-8", [d.deal_id]);
});

// ── RC-9 ───────────────────────────────────────────────────────────────────────
await run("RC-9 DB backstop: no charge_start / recovery identity while a release of the authorization is unknown or executed", async () => {
  for (const releaseClass of ["unknown", "success"] as const) {
    const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", priorAttempts: [{ attempt_type: "release", result_class: releaseClass, dispatch_state: "responded" }] }] });
    const p = d.participants[0]!;
    for (const type of ["charge_start", "recovery"]) {
      await assert.rejects(
        lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,$3,'unknown',$4,'recorded')`, [p.participant_id, d.deal_id, type, `${type}:rc9:${randomUUID()}`]),
        (error: any) => String(error?.code) === "SN409" && /capture_blocked_by_.*release/.test(String(error?.message)),
        `${type} identity must be refused while a release is ${releaseClass}`
      );
    }
  }
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
