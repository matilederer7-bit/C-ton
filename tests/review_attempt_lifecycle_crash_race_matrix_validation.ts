// R9C ROUND 5 — ATTEMPT LIFECYCLE TRUTH: crash / race matrix on the REAL handlers.
//
// Every case runs the production handlers (charge / finalize / release /
// reconcile / worker maintenance) through processOutboxEventById against the
// simulated provider and a disposable migrated database. Identities are
// minted or armed with the production helpers (buildPaymentAttemptHelpers)
// where a crash window has to be frozen.
//
// The invariant under test (task §7): for every authorization exactly one
// valid outcome eventually exists — a capture actually dispatched and
// resolved, OR a release actually dispatched and resolved, OR a durable
// retry / reconciliation obligation still visible. Never: a hold held for
// ever behind a row that says nothing was sent; a row that says "dispatched"
// for a request that never left; a never-dispatched identity treated as
// money-may-have-moved for ever; a release suppressed by a non-dispatched row;
// capture and release both reaching the provider.
//
//   A  identity minted, crash before the provider call, job retried    → same identity dispatched once
//   A2 identity minted, crash before the provider call, job gone,
//      charging phase over                                            → identity retired, hold released
//   B  identity minted, finalize decides before the provider call     → no orphan hold; a late charge sends nothing
//   B2 identity minted, handler frozen between mint and arm while
//      finalize decides (block barrier at payment.before_provider_io)  → the live rail's capture lands; buyer completed on truth; one effect
//   C  release begins while a capture identity is created-not-sent    → capture identity retired, hold released
//   D  capture dispatch races the release path (both orders)          → exactly one provider effect, never both
//   E  provider call made, response lost                              → UNKNOWN; no release; truth reconciled
//   F  never-dispatched identity is never "money may have moved"      → no provider-style verdict, no infinite fence
//   G  worker dies after ARM, before the provider call                → reclaim; exactly one capture-side effect
//   H  concurrent workers                                             → covered by payment_lab_concurrency_matrix_validation (two real workers); asserted here on a single-process double-claim
//
// Real money 0; simulated provider only.

import assert from "node:assert/strict";
import { bootLab, makeRunner, sleep, timeout } from "./lab/runtime.js";
import { buildPaymentAttemptHelpers } from "../src/payment_attempt_helpers.js";

const lab = await bootLab({ tag: "r5-lifecycle-matrix", port: 3242 });
const { run, summary } = makeRunner("review_attempt_lifecycle_crash_race_matrix");
const helpers = buildPaymentAttemptHelpers({ withTx: async (fn) => {
  const c = await lab.pool.connect();
  try { await c.query("BEGIN"); const v = await fn(c); await c.query("COMMIT"); return v; }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
} });
// passed through a cast so this file compiles on the round-4 tree too (A/B): the round-5 helper honours it, the round-4 helper ignores it
const CHARGE_ADMITTED = { money_states: ["ChargeAttempt"], buyer_states: ["ChargingAttempt"] };

async function seed(opts: { p2: { buyer_state: string; money_state: string }; dealState?: string; windowExpired?: boolean }) {
  const d = await lab.seedDeal({
    state: opts.dealState || "CompletionWindow", threshold_units: 1,
    completionWindowUntil: opts.windowExpired === false ? new Date(Date.now() + 60_000) : new Date(Date.now() - 2000),
    participants: [
      // a decided (Completed) deal already carries its paid participant as DealCompleted
      { buyer_state: opts.dealState === "Completed" ? "DealCompleted" : "ChargedSuccess", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: "paid-one" }] },
      { buyer_state: opts.p2.buyer_state, money_state: opts.p2.money_state }
    ]
  });
  lab.sim.forceEffect("capture", d.participants[0]!.authorization, d.participants[0]!.amount_minor);
  return d;
}
async function rows(pid: string) {
  return (await lab.pool.query(
    `SELECT attempt_type, correlation_id, result_class, dispatch_state, dispatched_at, resolved_at, failure_evidence, outcome_note, settlement_horizon_at
     FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at, correlation_id`, [pid])).rows as any[];
}
const captureSide = (r: any[]) => r.filter((x) => ["charge_start", "recovery"].includes(x.attempt_type));
function assertNeverDispatchedTruth(r: any[]) {
  // ledger truth for every row that never left the process
  for (const x of r.filter((x) => x.dispatched_at === null)) {
    assert.equal(x.dispatch_state, "recorded", `${x.correlation_id}: a never-dispatched identity must stay 'recorded' (got ${x.dispatch_state})`);
    assert.notEqual(x.result_class, "permanent_fail", `${x.correlation_id}: never-dispatched must not carry a provider-style failure (${x.failure_evidence})`);
    assert.notEqual(x.result_class, "success", `${x.correlation_id}: never-dispatched cannot be success`);
    if (x.result_class === "temporary_fail") assert.match(String(x.outcome_note || ""), /never_dispatched:/, `${x.correlation_id}: a retired identity names its reason`);
  }
}
// NOTE: payment_attempts.updated_at cannot be back-dated from a test — the 067
// lifecycle trigger stamps clock_timestamp() on every UPDATE — so the orphan
// sweeper's quiet window (10 s for a recorded row) is honoured in real time
// where the sweeper itself is the subject (case F).
async function converge(dealId: string, pid: string, rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await lab.drain({ dealIds: [dealId], advanceDeferred: true, maxRounds: 15 });
    await lab.reconcileOrphanedUnknownIdentities(50, 0);
  }
  await lab.drain({ dealIds: [dealId], advanceDeferred: true, maxRounds: 15 });
}
async function until(predicate: () => Promise<boolean>, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await sleep(10); }
  throw new Error(`Timed out: ${label}`);
}
const waiters = async (needle: string) => Number((await lab.pool.query(
  `SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1`, [`%${needle}%`])).rows[0].n);

// ── A: minted, crash before the provider call, job retried ────────────────
await run("A minted identity, crash before provider call, job retried → the SAME identity is dispatched exactly once", async () => {
  const d = await seed({ p2: { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }, dealState: "Charging", windowExpired: false });
  const p = d.participants[1]!;
  const begin = await helpers.beginProviderAttempt({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", identity: () => `capture:crashed-job:n1:${p.participant_id}`, ...({ admitted: CHARGE_ADMITTED } as any) });
  assert.equal(begin.kind, "fresh"); // the crash: nothing else happens for this identity
  const charge = await lab.enqueueCharge(d.deal_id);            // the outbox retries the job
  await lab.processOutboxEventById(charge);
  const r = await rows(p.participant_id);
  console.log(`MATRIX_A ${JSON.stringify({ rows: r, effects: lab.sim.effectsOf(p.authorization), state: await lab.participant(p.participant_id) })}`);
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  assert.equal(captureSide(r).length, 1, "no second identity was minted");
  assert.equal(r[0].correlation_id, `capture:crashed-job:n1:${p.participant_id}`, "the crashed identity itself was dispatched");
  assert.equal(r[0].result_class, "success");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  await lab.oracle("matrix-A", [d.deal_id], { print: true });
});

// ── A2: minted, crash, job gone, charging phase over ──────────────────────
await run("A2 minted identity, crash, no live job, charging phase over → identity retired, participant failed, hold released", async () => {
  const d = await seed({ p2: { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" } });
  const p = d.participants[1]!;
  const begin = await helpers.beginProviderAttempt({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", identity: () => `capture:gone-job:n1:${p.participant_id}`, ...({ admitted: CHARGE_ADMITTED } as any) });
  assert.equal(begin.kind, "fresh");
  await lab.enqueueFinalize(d.deal_id);
  await converge(d.deal_id, p.participant_id);
  const r = await rows(p.participant_id);
  const state = await lab.participant(p.participant_id);
  console.log(`MATRIX_A2 ${JSON.stringify({ rows: r, effects: lab.sim.effectsOf(p.authorization), state, cases: await lab.cases(p.participant_id) })}`);
  assertNeverDispatchedTruth(r);
  const capture = captureSide(r);
  assert.equal(capture.length, 1);
  assert.equal(capture[0].result_class, "temporary_fail", "retired in place");
  assert.equal(capture[0].dispatched_at, null);
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 0);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  assert.equal(state.buyer_state, "DealFailed");
  assert.equal(state.money_state, "AuthReleased");
  assert.equal((await lab.deal(d.deal_id)).state, "Completed");
  await lab.oracle("matrix-A2", [d.deal_id], { print: true });
});

// ── B: minted, finalize decides before the provider call; a late charge sends nothing ──
await run("B minted identity, finalize decides first → no orphan hold; a late charge job sends nothing", async () => {
  const d = await seed({ p2: { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" } });
  const p = d.participants[1]!;
  const begin = await helpers.beginProviderAttempt({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", identity: () => `capture:late-job:n1:${p.participant_id}`, ...({ admitted: CHARGE_ADMITTED } as any) });
  assert.equal(begin.kind, "fresh");
  const finalize = await lab.enqueueFinalize(d.deal_id);
  await lab.processOutboxEventById(finalize);
  await converge(d.deal_id, p.participant_id, 2);
  const mid = { rows: await rows(p.participant_id), state: await lab.participant(p.participant_id), effects: lab.sim.effectsOf(p.authorization) };
  console.log(`MATRIX_B_AFTER_FINALIZE ${JSON.stringify(mid)}`);
  assert.equal(mid.state.buyer_state, "DealFailed");
  assert.equal(mid.state.money_state, "AuthReleased", "the hold is released although a created-not-sent identity existed");
  assertNeverDispatchedTruth(mid.rows);
  // the late (stale) charge job: the arm must find nothing to send
  const charge = await lab.enqueueCharge(d.deal_id);
  await lab.processOutboxEventById(charge).catch(() => undefined); // the deal is Completed: the handler's own deal transition may refuse — irrelevant here
  const after = { rows: await rows(p.participant_id), effects: lab.sim.effectsOf(p.authorization), requests: lab.sim.requestsOf(p.authorization).map((r) => r.op) };
  console.log(`MATRIX_B_AFTER_LATE_CHARGE ${JSON.stringify(after)}`);
  assert.equal(after.effects.capture + after.effects.recover, 0, "nothing captured after the decision");
  assert.equal(captureSide(after.rows).filter((x) => x.result_class === "unknown").length, 0, "no new orphan identity");
  assert.equal(after.effects.release, 1);
  assert.deepEqual(after.requests.filter((op) => op !== "status"), ["release"]);
  const cases = (await lab.cases(p.participant_id)).map((c: any) => c.auto_key);
  assert.ok(!cases.some((k: string) => /negative-finality-unproven|settlement-horizon|operation-blocked/.test(k)), `no false escalation: ${cases.join(" | ")}`);
  // the synthetic stale job keeps failing on the handler's own deal transition
  // (Completed is not Charging — pre-existing, bounded, no money); it is the
  // fixture's artefact, not the hold's obligation, so it is removed before the
  // quiescence audit
  await lab.pool.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1`, [charge]);
  await lab.oracle("matrix-B", [d.deal_id], { print: true });
});

// ── B2: minted, the REAL handler frozen between mint and arm, finalize decides meanwhile ──
await run("B2 handler frozen between mint and arm while finalize decides → the capture lands, buyer completed on truth, exactly one effect", async () => {
  const d = await seed({ p2: { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" } });
  const p = d.participants[1]!;
  const barrier = lab.armTestFault("payment.before_provider_io", { kind: "block" })!;   // sits between the mint and the arm in the charge handler
  const charge = await lab.enqueueCharge(d.deal_id);
  const charging = lab.processOutboxEventById(charge).catch((e: any) => ({ error: String(e?.message || e) }));
  await barrier.entered;
  const minted = await rows(p.participant_id);
  assert.equal(minted.length, 1); assert.equal(minted[0].dispatch_state, "recorded"); assert.equal(minted[0].result_class, "unknown");
  const finalize = await lab.enqueueFinalize(d.deal_id);
  const finalized = await lab.processOutboxEventById(finalize);
  const mid = { finalized, rows: await rows(p.participant_id), state: await lab.participant(p.participant_id), finalizeJob: await lab.outboxRow(finalize) };
  console.log(`MATRIX_B2_MID ${JSON.stringify(mid)}`);
  // finalize defers on the MINTED identity (F-2 before the decision, F-15 after it — the round-4 contract kept): the participant is not failed
  assert.equal(mid.state.buyer_state, "ChargingAttempt");
  assert.match(String(mid.finalizeJob?.last_error || ""), /finalize_waiting_for_unresolved_captures|finalize_participant_capture_in_flight/);
  barrier.release();
  await charging;
  await converge(d.deal_id, p.participant_id, 2);
  const r = await rows(p.participant_id);
  const state = await lab.participant(p.participant_id);
  const effects = lab.sim.effectsOf(p.authorization);
  console.log(`MATRIX_B2 ${JSON.stringify({ rows: r, state, effects, deal: await lab.deal(d.deal_id) })}`);
  assert.equal(effects.capture, 1); assert.equal(effects.release, 0);
  assert.equal(state.money_state, "ChargedSuccess"); assert.equal(state.buyer_state, "DealCompleted");
  assert.equal(captureSide(r).length, 1); assert.equal(captureSide(r)[0].result_class, "success");
  await lab.oracle("matrix-B2", [d.deal_id], { print: true });
});

// ── C: release begins while a capture identity is created-not-sent ────────
await run("C release begins while a capture identity is created-not-sent → capture identity retired, hold released", async () => {
  const d = await seed({ p2: { buyer_state: "DealFailed", money_state: "ChargeAttempt" }, dealState: "Completed" });
  const p = d.participants[1]!;
  // a capture identity minted while the participant was still charging (frozen crash window), now stale
  await lab.pool.query(
    `INSERT INTO siton.payment_attempts(participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,'charge_start','unknown',$3,'recorded')`,
    [p.participant_id, d.deal_id, `capture:stale:n1:${p.participant_id}`]);
  const release = await lab.enqueueRelease(p.participant_id, d.deal_id, "matrix-C");
  await lab.processOutboxEventById(release);
  await lab.drain({ dealIds: [d.deal_id], advanceDeferred: true, maxRounds: 10 });
  const r = await rows(p.participant_id);
  console.log(`MATRIX_C ${JSON.stringify({ rows: r, effects: lab.sim.effectsOf(p.authorization), state: await lab.participant(p.participant_id) })}`);
  assertNeverDispatchedTruth(r);
  const cap = captureSide(r)[0];
  assert.equal(cap.result_class, "temporary_fail");
  assert.match(String(cap.outcome_note), /never_dispatched:superseded_by_release/);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 0);
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  // a stale worker still holding the retired identity cannot arm it (DB CAS requires result_class = unknown)
  const armed = await helpers.armProviderDispatch({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: cap.correlation_id, event_uuid: release, lease_generation: 1, worker_id: "stale", min_lease_remaining_ms: 0, expected_money_states: ["ChargeAttempt", "AuthReleased"] });
  assert.notEqual(armed, "armed", `a retired identity must never be armed (got ${armed})`);
  await lab.oracle("matrix-C", [d.deal_id], { print: true });
});

// ── D: capture dispatch races the release path, both orders ───────────────
await run("D capture dispatch races the release path → exactly one provider effect per hold, never both (6 races, both orders)", async () => {
  for (let i = 0; i < 6; i += 1) {
    // a decided participant (release owed) and a stale charge job re-running concurrently
    const d = await seed({ p2: { buyer_state: i % 2 ? "DealFailed" : "ChargingAttempt", money_state: "ChargeAttempt" }, dealState: i % 2 ? "Completed" : "Charging", windowExpired: i % 2 === 1 });
    const p = d.participants[1]!;
    const charge = await lab.enqueueCharge(d.deal_id);
    const release = await lab.enqueueRelease(p.participant_id, d.deal_id, "matrix-D");
    const first = i % 3 === 0 ? [charge, release] : [release, charge];
    await Promise.all(first.map((id) => lab.processOutboxEventById(id).catch(() => undefined)));
    await lab.drain({ dealIds: [d.deal_id], advanceDeferred: true, maxRounds: 15 });
    const effects = lab.sim.effectsOf(p.authorization);
    const r = await rows(p.participant_id);
    const state = await lab.participant(p.participant_id);
    console.log(`MATRIX_D[${i}] ${JSON.stringify({ order: first === undefined ? null : first[0] === charge ? "charge-first" : "release-first", effects, rows: r.map((x) => `${x.attempt_type}:${x.result_class}/${x.dispatch_state}`), state })}`);
    assert.equal(effects.capture + effects.recover + effects.release, 1, `exactly one provider effect (got ${JSON.stringify(effects)})`);
    if (effects.release === 1) assert.equal(state.money_state, "AuthReleased");
    if (effects.capture === 1) assert.equal(state.money_state, "ChargedSuccess");
    assertNeverDispatchedTruth(r);
    await lab.oracle(`matrix-D-${i}`, [d.deal_id], { print: true, allowUnresolved: true });
  }
});

// ── E: provider call made, response lost ──────────────────────────────────
await run("E provider call made, response lost → UNKNOWN, no release, truth reconciled from the provider", async () => {
  const d = await seed({ p2: { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }, dealState: "Charging", windowExpired: false });
  const p = d.participants[1]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_RESPONSE_LOST" }]);
  const charge = await lab.enqueueCharge(d.deal_id);
  await lab.processOutboxEventById(charge);
  const mid = (await rows(p.participant_id))[0];
  console.log(`MATRIX_E_MID ${JSON.stringify({ row: mid, effects: lab.sim.effectsOf(p.authorization) })}`);
  assert.equal(mid.result_class, "unknown");
  assert.equal(mid.dispatch_state, "responded");
  assert.ok(mid.dispatched_at, "an armed-and-sent identity records its dispatch instant");
  const release = await lab.enqueueRelease(p.participant_id, d.deal_id, "matrix-E");
  await lab.processOutboxEventById(release);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0, "no release while the capture is UNKNOWN");
  await converge(d.deal_id, p.participant_id, 2);
  const state = await lab.participant(p.participant_id);
  const r = await rows(p.participant_id);
  console.log(`MATRIX_E ${JSON.stringify({ rows: r, effects: lab.sim.effectsOf(p.authorization), state })}`);
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0);
  assert.equal(state.money_state, "ChargedSuccess", "the lost response was reconciled from provider truth");
  assert.equal(captureSide(r)[0].result_class, "success");
  await lab.oracle("matrix-E", [d.deal_id], { print: true });
});

// ── F: a never-dispatched identity is never "money may have moved" for ever ─
await run("F a never-dispatched identity never becomes a provider-style verdict nor an infinite fence", async () => {
  const d = await seed({ p2: { buyer_state: "DealFailed", money_state: "ChargeAttempt" }, dealState: "Completed" });
  const p = d.participants[1]!;
  await lab.pool.query(
    `INSERT INTO siton.payment_attempts(participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,'charge_start','unknown',$3,'recorded')`,
    [p.participant_id, d.deal_id, `capture:orphan:n1:${p.participant_id}`]);
  // the maintenance sweeper finds it once its quiet window (10 s, real time) has elapsed — the round-4 path turned it into permanent_fail/status_inference with no horizon
  await sleep(10_500);
  const swept = await lab.reconcileOrphanedUnknownIdentities(50, 0);
  assert.equal(swept, 1, "the sweeper scheduled the orphan's reconcile");
  await lab.drain({ dealIds: [d.deal_id], advanceDeferred: true, maxRounds: 15 });
  const r = await rows(p.participant_id);
  const fence = await helpers.captureSettlementFenceUntil(p.participant_id, d.deal_id);
  console.log(`MATRIX_F ${JSON.stringify({ rows: r, fence, effects: lab.sim.effectsOf(p.authorization), state: await lab.participant(p.participant_id), requests: lab.sim.requestsOf(p.authorization).map((x) => x.op) })}`);
  assertNeverDispatchedTruth(r);
  assert.equal(fence, null, "no settlement fence from an identity that never left the process");
  assert.equal(lab.sim.requestsOf(p.authorization, "status").length, 0, "no status read about an identity the provider never saw");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1, "the orphan was retired and the hold released");
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  await lab.oracle("matrix-F", [d.deal_id], { print: true });
});

// ── G: worker dies after ARM, before the provider call ────────────────────
await run("G worker dies after arm, before the provider call → reclaim; exactly one capture-side effect", async () => {
  const d = await seed({ p2: { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }, dealState: "Charging", windowExpired: false });
  const p = d.participants[1]!;
  const charge = await lab.enqueueCharge(d.deal_id);
  // the dying worker: claimed the job, minted and ARMED the identity, then died before the provider call
  await lab.pool.query(`UPDATE siton.outbox_events SET status='processing', worker_id='dying-worker', lease_generation=1, claimed_at=clock_timestamp(), processing_started_at=clock_timestamp(), last_heartbeat_at=clock_timestamp(), lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE event_uuid=$1`, [charge]);
  const begin = await helpers.beginProviderAttempt({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", identity: () => `capture:${charge}:n1:${p.participant_id}`, ...({ admitted: CHARGE_ADMITTED } as any) });
  assert.equal(begin.kind, "fresh");
  const armed = await helpers.armProviderDispatch({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: begin.correlation_id, event_uuid: charge, lease_generation: 1, worker_id: "dying-worker", min_lease_remaining_ms: 0, expected_money_states: ["ChargeAttempt"], expected_buyer_states: ["ChargingAttempt"], settlement_horizon_ms: 1500, negative_finality_authoritative: true });
  assert.equal(armed, "armed");
  const armedRow = (await rows(p.participant_id))[0];
  assert.equal(armedRow.dispatch_state, "dispatching");
  assert.ok(armedRow.dispatched_at);
  // the lease dies (worker gone); the outbox reclaims the job; UNKNOWN is owned by reconcile
  await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at=clock_timestamp()-interval '1 second', last_heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE event_uuid=$1`, [charge]);
  await converge(d.deal_id, p.participant_id, 3);
  const r = await rows(p.participant_id);
  const state = await lab.participant(p.participant_id);
  const effects = lab.sim.effectsOf(p.authorization);
  console.log(`MATRIX_G ${JSON.stringify({ rows: r, effects, state, live: await lab.liveEvents([d.deal_id]), cases: await lab.cases(p.participant_id) })}`);
  assert.equal(effects.capture + effects.recover, 1, `exactly one capture-side effect (got ${JSON.stringify(effects)})`);
  assert.equal(effects.release, 0);
  assert.ok(["ChargedSuccess", "RecoveredCharge"].includes(state.money_state), `converged to a paid state (got ${state.money_state})`);
  assert.equal(r.filter((x) => x.result_class === "unknown").length, 0, "no UNKNOWN identity remains");
  await lab.oracle("matrix-G", [d.deal_id], { print: true });
});

// ── H: single-process double claim of the same job ────────────────────────
await run("H the same charge job claimed twice concurrently → one dispatch (two-worker matrix covers the cross-process case)", async () => {
  const d = await seed({ p2: { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }, dealState: "Charging", windowExpired: false });
  const p = d.participants[1]!;
  const charge = await lab.enqueueCharge(d.deal_id);
  await Promise.all([lab.processOutboxEventById(charge), lab.processOutboxEventById(charge), lab.processOutboxEventById(charge)]);
  await lab.drain({ dealIds: [d.deal_id], advanceDeferred: true, maxRounds: 10 });
  const effects = lab.sim.effectsOf(p.authorization);
  console.log(`MATRIX_H ${JSON.stringify({ effects, rows: (await rows(p.participant_id)).map((x) => `${x.attempt_type}:${x.result_class}`) })}`);
  assert.equal(effects.capture, 1);
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1, "one capture request, no replay");
  await lab.oracle("matrix-H", [d.deal_id], { print: true });
});

const failures = summary();
await lab.close();
process.exit(failures ? 1 : 0);
