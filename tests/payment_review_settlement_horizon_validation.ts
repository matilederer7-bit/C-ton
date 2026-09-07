// INDEPENDENT ADVERSARIAL FINANCIAL REVIEW — SETTLEMENT HORIZON policy (migration 064).
//
// Provider-neutral recovery fencing contract, proven on the synthetic provider:
//
//   H-1  the horizon opens at dispatch, is durable on the identity, fences the
//        automatic recovery (job deferred to the horizon, visible case) and the
//        original capture is re-verified AT the horizon (late effect → case, no recovery)
//   H-2  exact-request evidence (the provider DECLINED the capture request itself)
//        is never fenced: recovery proceeds inside the horizon
//   H-3  horizon × late-effect matrix: every settlement that lands before the horizon
//        ends as ONE capture and zero recoveries; NEGATIVE CONTROL: the very same
//        schedule with the horizon forced closed double-captures (the fence is the defence)
//   H-4  the horizon is monotonic at the database (never shortened, never cleared)
//        and a "pending" status read extends it
//   H-5  the fence holds the RELEASE rail too (no release-then-capture)
//   H-6  the terminal deal decision (finalize) waits for the horizon
//   H-7  DB backstop: the INSERT trigger refuses a recovery / release identity while
//        fenced, admits it once the horizon passed
//   H-8  identity rotation / a later exact-evidence row does not reset the fence
//        (the fence reads EVERY capture-side row of the participant)
//
// Synthetic money only. Disposable database. Non-idempotent provider.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner, sleep } from "./lab/runtime.js";
import { auditFinancialTruth } from "./lab/oracle.js";

const HORIZON_MS = 1200;
const lab = await bootLab({
  tag: "horizon",
  port: 3164,
  simulator: { nativeIdempotency: false },
  env: { COMPLETION_WINDOW_MINUTES: "1", PAYMENT_SETTLEMENT_HORIZON_MS: String(HORIZON_MS) },
  outboxMaxAttempts: 4
});
const { run, summary } = makeRunner("payment_review_settlement_horizon");
const skipFinalize = (e: { event_type: string }) => e.event_type === "finalize_deal";

type AttemptRow = { attempt_type: string; correlation_id: string; result_class: string; failure_evidence: string | null; settlement_horizon_at: string | null; dispatched_at: string | null };
async function attemptRows(participantId: string): Promise<AttemptRow[]> {
  return (await lab.pool.query(
    `SELECT attempt_type, correlation_id, result_class, failure_evidence, settlement_horizon_at::text AS settlement_horizon_at, dispatched_at::text AS dispatched_at
     FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at ASC`,
    [participantId]
  )).rows as AttemptRow[];
}
async function fenceOf(participantId: string, dealId: string): Promise<Date | null> {
  const r = await lab.pool.query(`SELECT siton.payment_capture_settlement_fence($1::uuid,$2::uuid) AS fence`, [participantId, dealId]);
  return r.rows[0]?.fence ? new Date(r.rows[0].fence) : null;
}
async function seedCharging() {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  return { d, p: d.participants[0]! };
}
/** capture executed, answer lost (503), status "authorized/final" once → reconcile infers charge_failed → recovery armed */
async function inferredFailureAfterExecutedCapture(statusScript: Parameters<typeof lab.sim.scriptStatus>[1] = [{ kind: "STALE_AUTHORIZED", final: true }]) {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, statusScript);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal", "payment_reconcile"], maxRounds: 20 });
  const rows = await attemptRows(p.participant_id);
  const capture = rows.find((r) => r.attempt_type === "charge_start")!;
  return { d, p, capture };
}

// ── H-1 ────────────────────────────────────────────────────────────────────────
await run("H-1 the horizon opens at dispatch, is durable, fences the recovery job to the horizon (visible) and the capture is re-verified there → one capture, no recovery", async () => {
  const { d, p, capture } = await inferredFailureAfterExecutedCapture();
  assert.equal(capture.result_class, "permanent_fail", "the reconcile inferred charge_failed from authorized/final");
  assert.equal(capture.failure_evidence, "status_inference", "provenance: the verdict rests on a status read");
  assert.ok(capture.settlement_horizon_at && capture.dispatched_at, "horizon and dispatch instant are durable on the identity");
  const horizon = new Date(capture.settlement_horizon_at!).getTime();
  const dispatched = new Date(capture.dispatched_at!).getTime();
  assert.ok(Math.abs(horizon - dispatched - HORIZON_MS) < 150, `horizon = dispatched_at + ${HORIZON_MS} ms (got +${horizon - dispatched} ms)`);
  assert.ok((await fenceOf(p.participant_id, d.deal_id))!.getTime() === horizon, "the DB fence predicate returns that horizon");

  const recoveryJob = (await lab.liveEvents([d.deal_id], ["recovery_deal"]))[0];
  assert.ok(recoveryJob, "the reconcile verdict armed a recovery job");
  const first = await lab.processOutboxEventById(recoveryJob!.event_uuid);
  const row = await lab.outboxRow(recoveryJob!.event_uuid);
  console.log(`  recovery job: ${first?.status} error=${String((first as any)?.error || "").slice(0, 70)} deferred=${row?.deferred} recover_requests=${lab.sim.requestsOf(p.authorization, "recover").length}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no recovery request inside the horizon");
  assert.equal(row?.status, "pending");
  assert.equal(row?.deferred, true, "the job is deferred, not retried on a backoff");
  assert.match(String(row?.last_error || ""), /recovery_held/);
  const availableAt = new Date((await lab.pool.query(`SELECT available_at FROM siton.outbox_events WHERE event_uuid=$1`, [recoveryJob!.event_uuid])).rows[0].available_at as Date).getTime(); // pg Date, never String() (drops the milliseconds)
  assert.ok(Math.abs(availableAt - horizon) < 100, `the job wakes AT the horizon (delta ${availableAt - horizon} ms)`);
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-recovery-settlement-horizon")), "the hold is an operational case");

  // at the horizon: the capture is re-verified (truthful status now says captured) → late effect, no recovery
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 60, waitDeferredUpToMs: HORIZON_MS + 500 });
  const eff = lab.sim.effectsOf(p.authorization);
  const after = await attemptRows(p.participant_id);
  console.log(`  after horizon: effects=${JSON.stringify(eff)} capture_identity=${after.find((r) => r.attempt_type === "charge_start")?.result_class} cases=${(await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]).join(",")}`);
  assert.equal(eff.capture, 1);
  assert.equal(eff.recover, 0, "the late-verified capture blocks the recovery");
  assert.equal(after.find((r) => r.attempt_type === "charge_start")?.result_class, "success", "the capture identity converged to provider truth");
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-recovery-preflight-captured")));
  await lab.oracle("h1", [d.deal_id], { allowUnresolved: true });
});

// ── H-2 ────────────────────────────────────────────────────────────────────────
await run("H-2 exact-request evidence: the provider DECLINED the capture itself → dispatch_response, not fenced, recovery proceeds inside the horizon", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "DECLINED" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"], maxRounds: 10 });
  const capture = (await attemptRows(p.participant_id)).find((r) => r.attempt_type === "charge_start")!;
  assert.equal(capture.result_class, "permanent_fail");
  assert.equal(capture.failure_evidence, "dispatch_response", "the provider's own answer to the exact request");
  assert.ok(capture.settlement_horizon_at && new Date(capture.settlement_horizon_at).getTime() > Date.now(), "the horizon is still open (the fence must be lifted by EVIDENCE, not by time)");
  assert.equal(await fenceOf(p.participant_id, d.deal_id), null, "no fence for an exact-request decline");
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40 });
  const eff = lab.sim.effectsOf(p.authorization);
  console.log(`  declined-then-recovered: effects=${JSON.stringify(eff)} state=${(await lab.participant(p.participant_id)).money_state}`);
  assert.equal(eff.capture, 0);
  assert.equal(eff.recover, 1, "recovery ran without waiting for the horizon");
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  await lab.oracle("h2", [d.deal_id]);
});

// ── H-3 ────────────────────────────────────────────────────────────────────────
async function delayedCaptureUnderFailedStatus(delayMs: number) {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "DELAYED_EFFECT", delayMs }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WHILE_SETTLING", state: "failed", final: true }]);
  await lab.enqueueCharge(d.deal_id);
  // charge + reconcile verdict (inferred charge_failed) + recovery armed
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal", "payment_reconcile"], maxRounds: 20 });
  return { d, p };
}
for (const delayMs of [100, 600, 1100]) {
  await run(`H-3 late effect ${delayMs} ms < horizon ${HORIZON_MS} ms under a consistent failed/final status → exactly one capture, zero recoveries`, async () => {
    const { d, p } = await delayedCaptureUnderFailedStatus(delayMs);
    await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 80, waitDeferredUpToMs: HORIZON_MS + 500 });
    const eff = lab.sim.effectsOf(p.authorization);
    console.log(`  delay=${delayMs}: effects=${JSON.stringify(eff)} state=${(await lab.participant(p.participant_id)).buyer_state}/${(await lab.participant(p.participant_id)).money_state} cases=${(await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]).join(",")}`);
    assert.equal(eff.capture + eff.recover, 1, `money moved once: ${JSON.stringify(eff)}`);
    assert.equal(eff.recover, 0);
    await lab.oracle(`h3:${delayMs}`, [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
  });
}
await run("H-3 NEGATIVE CONTROL: the same 600 ms schedule with the horizon forced closed (DB trigger disabled for the test) double-captures — the fence is the defence, the proof is not vacuous", async () => {
  const { d, p } = await delayedCaptureUnderFailedStatus(600);
  await lab.pool.query(`ALTER TABLE siton.payment_attempts DISABLE TRIGGER trg_payment_attempts_settlement_horizon`);
  try {
    await lab.pool.query(`UPDATE siton.payment_attempts SET settlement_horizon_at = clock_timestamp() - interval '1 millisecond' WHERE participant_id=$1`, [p.participant_id]);
  } finally {
    await lab.pool.query(`ALTER TABLE siton.payment_attempts ENABLE TRIGGER trg_payment_attempts_settlement_horizon`);
  }
  assert.equal(await fenceOf(p.participant_id, d.deal_id), null, "fence forced closed");
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40 });
  await sleep(700);
  const eff = lab.sim.effectsOf(p.authorization);
  const report = await auditFinancialTruth(lab.pool, { label: "h3:negative", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  console.log(`  NEGATIVE CONTROL: effects=${JSON.stringify(eff)} oracle=${report.violations.map((v) => v.code).join(",")}`);
  assert.equal(eff.capture + eff.recover, 2, "without the fence the recovery is sent and the delayed capture lands: two captures");
  assert.ok(report.violations.some((v) => v.code === "DUPLICATE_CAPTURE"), "the oracle reports the double");
});

// ── H-4 ────────────────────────────────────────────────────────────────────────
await run("H-4 the horizon is monotonic at the database (never shortened, never cleared, evidence never downgraded) and a pending status read extends it", async () => {
  const { d, p, capture } = await inferredFailureAfterExecutedCapture();
  const original = new Date(capture.settlement_horizon_at!).getTime();
  await lab.pool.query(`UPDATE siton.payment_attempts SET settlement_horizon_at = clock_timestamp() - interval '1 hour', failure_evidence = 'status_inference' WHERE participant_id=$1 AND correlation_id=$2`, [p.participant_id, capture.correlation_id]);
  await lab.pool.query(`UPDATE siton.payment_attempts SET settlement_horizon_at = NULL WHERE participant_id=$1 AND correlation_id=$2`, [p.participant_id, capture.correlation_id]);
  let row = (await attemptRows(p.participant_id)).find((r) => r.correlation_id === capture.correlation_id)!;
  assert.equal(new Date(row.settlement_horizon_at!).getTime(), original, "an earlier or NULL horizon is refused (monotonic)");
  await lab.pool.query(`UPDATE siton.payment_attempts SET failure_evidence = 'dispatch_response' WHERE participant_id=$1 AND correlation_id=$2`, [p.participant_id, capture.correlation_id]);
  await lab.pool.query(`UPDATE siton.payment_attempts SET failure_evidence = 'status_inference' WHERE participant_id=$1 AND correlation_id=$2`, [p.participant_id, capture.correlation_id]);
  row = (await attemptRows(p.participant_id)).find((r) => r.correlation_id === capture.correlation_id)!;
  assert.equal(row.failure_evidence, "dispatch_response", "exact-request evidence is never downgraded to an inference");

  // a pending read extends: fresh participant, capture answered 200 pending (no effect yet), status PENDING once
  const { d: d2, p: p2 } = await seedCharging();
  lab.sim.script(p2.authorization, "capture", [{ kind: "PENDING_NO_EFFECT" }]);
  lab.sim.scriptStatus(p2.authorization, [{ kind: "PENDING" }]);
  await lab.enqueueCharge(d2.deal_id);
  await lab.drain({ dealIds: [d2.deal_id], types: ["charge_deal"], maxRounds: 5 });
  const before = new Date((await attemptRows(p2.participant_id))[0]!.settlement_horizon_at!).getTime();
  await sleep(120);
  const reconcile = (await lab.liveEvents([d2.deal_id], ["payment_reconcile"]))[0]!;
  await lab.processOutboxEventById(reconcile.event_uuid);
  const after = new Date((await attemptRows(p2.participant_id))[0]!.settlement_horizon_at!).getTime();
  console.log(`  pending read extended the horizon by ${after - before} ms`);
  assert.ok(after >= before + 100, "a pending status read pushed the horizon out");
  lab.sim.clearStatusScript(p2.authorization);
  await lab.drain({ dealIds: [d2.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: HORIZON_MS + 500 });
  void d;
});

// ── H-5 ────────────────────────────────────────────────────────────────────────
await run("H-5 the fence holds the RELEASE rail: no release while an inferred capture failure may still settle; one release after the horizon", async () => {
  const until = new Date(Date.now() + 900);
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "status_inference", settlement_horizon_at: until }] }] });
  const p = d.participants[0]!;
  const event = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const first = await lab.processOutboxEventById(event);
  const row = await lab.outboxRow(event);
  console.log(`  release job: ${first?.status} error=${String((first as any)?.error || "").slice(0, 60)} deferred=${row?.deferred} release_requests=${lab.sim.requestsOf(p.authorization, "release").length}`);
  assert.equal(lab.sim.requestsOf(p.authorization, "release").length, 0, "no release request inside the horizon");
  assert.equal(row?.deferred, true);
  assert.match(String(row?.last_error || ""), /payment_release_fenced/);
  assert.equal((await lab.attempts(p.participant_id, "release")).length, 0, "no release identity was minted while fenced");
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-release-settlement-horizon")));
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40, waitDeferredUpToMs: 2000 });
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1, "exactly one provider release after the horizon");
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.oracle("h5", [d.deal_id]);
});

// ── H-6 ────────────────────────────────────────────────────────────────────────
await run("H-6 the terminal deal decision waits for the horizon: finalize is deferred to it (case), then decides on verified truth and releases with proof", async () => {
  const until = new Date(Date.now() + 900);
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() - 1000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "status_inference", settlement_horizon_at: until }] }] });
  const p = d.participants[0]!;
  const event = await lab.enqueueFinalize(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  const row = await lab.outboxRow(event);
  console.log(`  finalize: ${first?.status} error=${String((first as any)?.error || "").slice(0, 70)} deferred=${row?.deferred} deal=${(await lab.deal(d.deal_id)).state}`);
  assert.equal((await lab.deal(d.deal_id)).state, "CompletionWindow", "no terminal decision inside the horizon");
  assert.equal(row?.deferred, true);
  assert.match(String(row?.last_error || ""), /finalize_waiting_for_settlement_horizon/);
  assert.ok((await lab.pool.query(`SELECT 1 FROM siton.operational_cases WHERE auto_key=$1`, [`deal-finalize-waiting-settlement-horizon:${d.deal_id}`])).rowCount === 1);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 60, waitDeferredUpToMs: 2000 });
  const deal = await lab.deal(d.deal_id);
  const part = await lab.participant(p.participant_id);
  console.log(`  after horizon: deal=${deal.state} participant=${part.buyer_state}/${part.money_state} status_reads=${lab.sim.requestsOf(p.authorization, "status").length} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))}`);
  assert.equal(deal.state, "Failed");
  assert.ok(lab.sim.requestsOf(p.authorization, "status").length >= 2, "the capture was re-verified at the provider before the decision");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1, "the hold was released WITH provider proof after the decision");
  assert.equal(part.money_state, "AuthReleased");
  await lab.oracle("h6", [d.deal_id]);
});

await run("H-6b finalize after the horizon: a capture that settled late under a failed/final status becomes visible truth before the decision (identity success + case), the hold is NOT released", async () => {
  const until = new Date(Date.now() + 700);
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() - 1000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "status_inference", settlement_horizon_at: until }] }] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor); // the "failed" capture in fact settled
  await lab.enqueueFinalize(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 60, waitDeferredUpToMs: 2000 });
  const rows = await attemptRows(p.participant_id);
  const part = await lab.participant(p.participant_id);
  const cases = (await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]);
  console.log(`  late-settled: deal=${(await lab.deal(d.deal_id)).state} participant=${part.buyer_state}/${part.money_state} capture_identity=${rows[0]?.result_class} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))} cases=${cases.join(",")}`);
  assert.equal(rows[0]?.result_class, "success", "the late capture became visible truth on the capture identity");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0, "captured money is never released");
  assert.notEqual(part.money_state, "AuthReleased");
  assert.ok(cases.includes("payment-recovery-preflight-captured") || cases.includes("payment-late-money-effect"), "the charged buyer is an operator case");
  await lab.oracle("h6b", [d.deal_id], { allowUnresolved: true, allowedCodes: ["FAILED_DEAL_HOLDS_CAPTURED_MONEY", "PROVIDER_SUCCESS_INVISIBLE"] });
});

// ── H-7 ────────────────────────────────────────────────────────────────────────
await run("H-7 DB backstop: the INSERT trigger refuses a recovery / release identity while fenced and admits it once the horizon passed", async () => {
  const until = new Date(Date.now() + 500);
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "status_inference", settlement_horizon_at: until }] }] });
  const p = d.participants[0]!;
  for (const type of ["recovery", "release"]) {
    await assert.rejects(
      lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,$3,'unknown',$4,'recorded')`, [p.participant_id, d.deal_id, type, `${type}:h7:${randomUUID()}`]),
      (error: any) => String(error?.code) === "SN409" && /money_operation_fenced_by_settlement_horizon/.test(String(error?.message)),
      `${type} identity must be refused by the database while fenced`
    );
  }
  await sleep(600);
  await lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,'recovery','unknown',$3,'recorded')`, [p.participant_id, d.deal_id, `recovery:h7:${randomUUID()}`]);
  assert.equal((await lab.attempts(p.participant_id, "recovery")).length, 1, "admitted after the horizon");
});

// ── H-8 ────────────────────────────────────────────────────────────────────────
await run("H-8 the fence reads EVERY capture-side row: a later exact-evidence row (or a rotated identity) does not lift an older open horizon", async () => {
  const until = new Date(Date.now() + 800);
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [
    { attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: `capture:h8:n1:${randomUUID()}`, failure_evidence: "status_inference", settlement_horizon_at: until },
    { attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: `capture:h8:n2:${randomUUID()}`, failure_evidence: "dispatch_response", settlement_horizon_at: null }
  ] }] });
  const p = d.participants[0]!;
  const fence = await fenceOf(p.participant_id, d.deal_id);
  assert.ok(fence && Math.abs(fence.getTime() - until.getTime()) < 5, "the older inferred failure still fences");
  const event = await lab.enqueueRecovery(d.deal_id);
  await lab.processOutboxEventById(event);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no recovery while any capture-side row is fenced");
  assert.equal((await lab.outboxRow(event))?.deferred, true);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 2000 });
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1, "one recovery once the horizon passed and the status verified");
  await lab.oracle("h8", [d.deal_id]);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
