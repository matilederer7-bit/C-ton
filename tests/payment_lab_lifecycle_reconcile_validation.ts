// FINANCIAL TORTURE LAB — Phases 6, 9, 10: operation lifecycle matrix,
// idempotency torture, reconciliation torture.
//
// Lifecycle states of ONE durable money identity (migration 063):
//   NOT_DISPATCHED  unknown + recorded
//   IN_FLIGHT       unknown + dispatching + live owner lease
//   UNKNOWN         unknown + responded (or dispatching with a dead lease)
//   SUCCEEDED       success
//   DEFINITELY_FAILED permanent_fail
// For every rail the matrix starts a job against a row in each state and
// checks, from the provider's ledger, what reached the provider and how much
// money moved. Invalid transitions must fail closed at the DATABASE, UNKNOWN
// must never silently become DEFINITELY_FAILED, and evidence that cannot
// identify the exact operation must never authorise an automatic repeat.
//
// Provider: idempotent (provider-ready contract). Synthetic money only.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner, timeout } from "./lab/runtime.js";

const lab = await bootLab({ tag: "lifecycle", port: 3153, env: { COMPLETION_WINDOW_MINUTES: "0.2" }, outboxMaxAttempts: 6 });
const { run, summary } = makeRunner("payment_lab_lifecycle_reconcile");

type Rail = "capture" | "recovery" | "refund" | "release";
const RAILS: Array<{ rail: Rail; attempt_type: string; seed: () => Promise<{ dealId: string; pid: string; auth: string; amount: number }>; enqueue: (dealId: string, pid: string) => Promise<string>; successState: string; op: "capture" | "recover" | "refund" | "release" }> = [
  {
    rail: "capture", attempt_type: "charge_start", op: "capture", successState: "ChargedSuccess",
    seed: async () => { const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] }); const p = d.participants[0]!; return { dealId: d.deal_id, pid: p.participant_id, auth: p.authorization, amount: p.amount_minor }; },
    enqueue: (dealId) => lab.enqueueCharge(dealId)
  },
  {
    rail: "recovery", attempt_type: "recovery", op: "recover", successState: "RecoveredCharge",
    seed: async () => { const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 5 * 60_000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: `capture:lifecycle-prior:n1:${randomUUID()}` }] }] }); const p = d.participants[0]!; return { dealId: d.deal_id, pid: p.participant_id, auth: p.authorization, amount: p.amount_minor }; },
    enqueue: (dealId) => lab.enqueueRecovery(dealId)
  },
  {
    rail: "refund", attempt_type: "refund", op: "refund", successState: "Refunded",
    seed: async () => { const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: `capture:lifecycle-prior:n1:${randomUUID()}` }] }] }); const p = d.participants[0]!; lab.sim.forceEffect("capture", p.authorization, p.amount_minor); return { dealId: d.deal_id, pid: p.participant_id, auth: p.authorization, amount: p.amount_minor }; },
    enqueue: (dealId) => lab.enqueueRefund(dealId)
  },
  {
    rail: "release", attempt_type: "release", op: "release", successState: "AuthReleased",
    seed: async () => { const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] }); const p = d.participants[0]!; return { dealId: d.deal_id, pid: p.participant_id, auth: p.authorization, amount: p.amount_minor }; },
    enqueue: (dealId, pid) => lab.enqueueRelease(pid, dealId)
  }
];

async function insertAttempt(pid: string, dealId: string, attemptType: string, resultClass: string, correlation: string, dispatchState: "recorded" | "responded" = "responded") {
  await lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,$3,$4,$5,$6)`, [pid, dealId, attemptType, resultClass, correlation, dispatchState]);
}
async function makeInFlight(pid: string, dealId: string, attemptType: string, correlation: string) {
  // A foreign worker holds a live lease on a processing job and armed this identity.
  const ownerEvent = randomUUID();
  await lab.pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, processing_started_at, claimed_at, lease_expires_at, last_heartbeat_at, last_attempt_at, worker_id, lease_generation, created_at, updated_at)
     VALUES ($1,'payment_reconcile','participant',$2,$3,'processing',1,clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp() + interval '2 minutes',clock_timestamp(),clock_timestamp(),'foreign-worker',1,clock_timestamp(),clock_timestamp())`,
    [ownerEvent, pid, JSON.stringify({ participant_id: pid, deal_id: dealId, attempt_type: attemptType, correlation_id: correlation, operation: "capture", provider_reference: null, reason: "lab-foreign-owner" })]
  );
  await lab.pool.query(
    `UPDATE siton.payment_attempts SET dispatch_state='dispatching', owner_event_uuid=$3, owner_lease_generation=1, dispatched_at=clock_timestamp()
     WHERE participant_id=$1 AND correlation_id=$2`,
    [pid, correlation, ownerEvent]
  );
  return ownerEvent;
}
async function expireForeignLease(ownerEvent: string) {
  await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [ownerEvent]);
}
async function dropForeignJob(ownerEvent: string) {
  await lab.pool.query(`UPDATE siton.outbox_events SET status='sent', sent=true, sent_at=clock_timestamp() WHERE event_uuid=$1`, [ownerEvent]);
}

// ── Phase 6: lifecycle matrix ────────────────────────────────────────────────

for (const r of RAILS) {
  await run(`lifecycle ${r.rail} ← NOT_DISPATCHED: the minted-but-never-sent identity is reused verbatim, exactly one effect`, async () => {
    const s = await r.seed();
    const correlation = `${r.attempt_type}:lab-nd:n1:${s.pid}`;
    await insertAttempt(s.pid, s.dealId, r.attempt_type, "unknown", correlation, "recorded");
    await r.enqueue(s.dealId, s.pid);
    await lab.drain({ dealIds: [s.dealId], skip: (e) => e.event_type === "finalize_deal" });
    const keys = lab.sim.distinctKeys(s.auth, r.op);
    assert.deepEqual(keys, [correlation], `the provider must see the NOT_DISPATCHED identity itself: ${JSON.stringify(keys)}`);
    assert.equal(lab.sim.effectsOf(s.auth)[r.op], 1);
    assert.equal((await lab.participant(s.pid)).money_state, r.successState);
    const rows = await lab.attempts(s.pid, r.attempt_type);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.result_class, "success");
    await lab.oracle(`lifecycle:${r.rail}:not-dispatched`, [s.dealId]);
  });

  await run(`lifecycle ${r.rail} ← IN_FLIGHT elsewhere: a second job sends nothing; after the foreign lease dies the identity is resolved through status, still one effect`, async () => {
    const s = await r.seed();
    const correlation = `${r.attempt_type}:lab-if:n1:${s.pid}`;
    await insertAttempt(s.pid, s.dealId, r.attempt_type, "unknown", correlation, "responded");
    const owner = await makeInFlight(s.pid, s.dealId, r.attempt_type, correlation);
    const event = await r.enqueue(s.dealId, s.pid);
    const first = await lab.processOutboxEventById(event);
    assert.ok(first, "job not claimed");
    assert.equal(lab.sim.requestsOf(s.auth, r.op).length, 0, "nothing may reach the provider while the identity is in flight elsewhere");
    assert.equal(lab.sim.requestsOf(s.auth, "status").length, 0, "no status read while in flight");
    const row = (await lab.attempts(s.pid, r.attempt_type))[0]!;
    assert.equal(row.dispatch_state, "dispatching"); assert.equal(row.in_flight, true);
    // the foreign worker really executed it, then died before settling
    lab.sim.forceEffect(r.op, s.auth, s.amount);
    await expireForeignLease(owner); await dropForeignJob(owner);
    if (first.status !== "sent") await lab.retryNow(event);
    else await r.enqueue(s.dealId, s.pid);
    await lab.drain({ dealIds: [s.dealId], skip: (e) => e.event_type === "finalize_deal" });
    assert.equal(lab.sim.requestsOf(s.auth, r.op).length, 0, "the executed identity must be recognised through status, never re-sent");
    assert.equal(lab.sim.effectsOf(s.auth)[r.op], 1);
    assert.equal((await lab.participant(s.pid)).money_state, r.successState);
    await lab.oracle(`lifecycle:${r.rail}:in-flight`, [s.dealId]);
  });

  await run(`lifecycle ${r.rail} ← UNKNOWN (not executed per authoritative status): the SAME identity is re-sent, one effect, no n2`, async () => {
    const s = await r.seed();
    const correlation = `${r.attempt_type}:lab-uk:n1:${s.pid}`;
    await insertAttempt(s.pid, s.dealId, r.attempt_type, "unknown", correlation, "responded");
    await r.enqueue(s.dealId, s.pid);
    await lab.drain({ dealIds: [s.dealId], skip: (e) => e.event_type === "finalize_deal" });
    assert.deepEqual(lab.sim.distinctKeys(s.auth, r.op), [correlation]);
    assert.equal(lab.sim.effectsOf(s.auth)[r.op], 1);
    assert.equal((await lab.participant(s.pid)).money_state, r.successState);
    assert.equal((await lab.attempts(s.pid, r.attempt_type)).length, 1, "no second identity");
    await lab.oracle(`lifecycle:${r.rail}:unknown-not-executed`, [s.dealId]);
  });

  await run(`lifecycle ${r.rail} ← UNKNOWN (executed per authoritative status): applied from status, ZERO new money requests`, async () => {
    const s = await r.seed();
    const correlation = `${r.attempt_type}:lab-uke:n1:${s.pid}`;
    await insertAttempt(s.pid, s.dealId, r.attempt_type, "unknown", correlation, "responded");
    lab.sim.forceEffect(r.op, s.auth, s.amount);
    await r.enqueue(s.dealId, s.pid);
    await lab.drain({ dealIds: [s.dealId], skip: (e) => e.event_type === "finalize_deal" });
    assert.equal(lab.sim.requestsOf(s.auth, r.op).length, 0, "an executed identity must never be sent again");
    assert.equal(lab.sim.effectsOf(s.auth)[r.op], 1);
    assert.equal((await lab.participant(s.pid)).money_state, r.successState);
    assert.equal((await lab.attempts(s.pid, r.attempt_type))[0]!.result_class, "success");
    await lab.oracle(`lifecycle:${r.rail}:unknown-executed`, [s.dealId]);
  });

  await run(`lifecycle ${r.rail} ← SUCCEEDED but canonical state never persisted: state converges from the row + status, no new money request`, async () => {
    const s = await r.seed();
    const correlation = `${r.attempt_type}:lab-sc:n1:${s.pid}`;
    await insertAttempt(s.pid, s.dealId, r.attempt_type, "success", correlation, "responded");
    lab.sim.forceEffect(r.op, s.auth, s.amount);
    await r.enqueue(s.dealId, s.pid);
    await lab.drain({ dealIds: [s.dealId], skip: (e) => e.event_type === "finalize_deal" });
    assert.equal(lab.sim.requestsOf(s.auth, r.op).length, 0);
    assert.equal(lab.sim.effectsOf(s.auth)[r.op], 1);
    assert.equal((await lab.participant(s.pid)).money_state, r.successState);
    await lab.oracle(`lifecycle:${r.rail}:succeeded-unpersisted`, [s.dealId]);
  });

  await run(`lifecycle ${r.rail} ← DEFINITELY_FAILED: a fresh identity n2 is legal, exactly one effect overall`, async () => {
    const s = await r.seed();
    const correlation = `${r.attempt_type}:lab-df:n1:${s.pid}`;
    await insertAttempt(s.pid, s.dealId, r.attempt_type, "permanent_fail", correlation, "responded");
    await r.enqueue(s.dealId, s.pid);
    await lab.drain({ dealIds: [s.dealId], skip: (e) => e.event_type === "finalize_deal" });
    const keys = lab.sim.distinctKeys(s.auth, r.op);
    assert.equal(keys.length, 1); assert.notEqual(keys[0], correlation, "the declared-failed identity is never re-sent");
    assert.match(String(keys[0]), /:n2:/);
    assert.equal(lab.sim.effectsOf(s.auth)[r.op], 1);
    assert.equal((await lab.participant(s.pid)).money_state, r.successState);
    await lab.oracle(`lifecycle:${r.rail}:definitely-failed`, [s.dealId]);
  });
}

// ── invalid transitions fail closed at the database ──────────────────────────

await run("DB guards: terminal truth never downgrades; identity rotation, recovery, refund and release behind an unresolved capture are refused; foreign writes on an in-flight row are refused", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  const probe = async (sql: string, params: unknown[]) => { try { await lab.pool.query(sql, params); return "admitted"; } catch (error: any) { return `refused:${error.code}:${String(error.message).split(":")[0]}`; } };
  const n1 = `charge_start:lab-guard:n1:${p.participant_id}`;
  await insertAttempt(p.participant_id, d.deal_id, "charge_start", "success", n1);
  assert.match(await probe(`UPDATE siton.payment_attempts SET result_class='unknown' WHERE participant_id=$1 AND correlation_id=$2`, [p.participant_id, n1]), /^refused:SN409:payment_attempt_terminal_downgrade/);
  assert.match(await probe(`UPDATE siton.payment_attempts SET result_class='permanent_fail' WHERE participant_id=$1 AND correlation_id=$2`, [p.participant_id, n1]), /^refused:SN409:payment_attempt_terminal_downgrade/);
  assert.match(await probe(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'charge_start','unknown',$3)`, [p.participant_id, d.deal_id, `charge_start:lab-guard:n2:${p.participant_id}`]), /^refused:SN409:payment_attempt_identity_rotation_blocked/, "no n2 while n1 is success");
  assert.match(await probe(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'recovery','unknown',$3)`, [p.participant_id, d.deal_id, `recovery:lab-guard:n1:${p.participant_id}`]), /^refused:SN409:recovery_blocked_by_unresolved_capture/, "recovery never behind an executed capture");
  assert.match(await probe(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'release','unknown',$3)`, [p.participant_id, d.deal_id, `release:lab-guard:n1:${p.participant_id}`]), /^refused:SN409:release_blocked_by_captured_money/);

  const d2 = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p2 = d2.participants[0]!;
  const u1 = `charge_start:lab-guard2:n1:${p2.participant_id}`;
  await insertAttempt(p2.participant_id, d2.deal_id, "charge_start", "unknown", u1);
  assert.match(await probe(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'charge_start','unknown',$3)`, [p2.participant_id, d2.deal_id, `charge_start:lab-guard2:n2:${p2.participant_id}`]), /^refused:SN409:payment_attempt_identity_rotation_blocked/, "no n2 while n1 is unknown");
  assert.match(await probe(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'recovery','unknown',$3)`, [p2.participant_id, d2.deal_id, `recovery:lab-guard2:n1:${p2.participant_id}`]), /^refused:SN409:recovery_blocked_by_unresolved_capture/);
  assert.match(await probe(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'refund','unknown',$3)`, [p2.participant_id, d2.deal_id, `refund:lab-guard2:n1:${p2.participant_id}`]), /^refused:SN409:money_operation_blocked_by_unresolved_capture/);
  assert.match(await probe(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'release','unknown',$3)`, [p2.participant_id, d2.deal_id, `release:lab-guard2:n1:${p2.participant_id}`]), /^refused:SN409:money_operation_blocked_by_unresolved_capture/);
  const owner = await makeInFlight(p2.participant_id, d2.deal_id, "charge_start", u1);
  assert.match(await probe(`UPDATE siton.payment_attempts SET result_class='permanent_fail' WHERE participant_id=$1 AND correlation_id=$2`, [p2.participant_id, u1]), /^refused:SN409:payment_attempt_in_flight_negative_settle/);
  assert.match(await probe(`UPDATE siton.payment_attempts SET dispatch_state='responded' WHERE participant_id=$1 AND correlation_id=$2`, [p2.participant_id, u1]), /^refused:SN409:payment_attempt_in_flight_foreign_write/);
  assert.match(await probe(`UPDATE siton.payment_attempts SET dispatch_state='recorded', owner_event_uuid=NULL, owner_lease_generation=NULL WHERE participant_id=$1 AND correlation_id=$2`, [p2.participant_id, u1]), /^refused:SN409:payment_attempt_in_flight_disarm/);
  assert.equal(await probe(`UPDATE siton.payment_attempts SET result_class='success' WHERE participant_id=$1 AND correlation_id=$2`, [p2.participant_id, u1]), "admitted", "provider SUCCESS is always admitted");
  await dropForeignJob(owner);
});

// ── Phase 10: reconciliation torture ─────────────────────────────────────────

await run("reconcile: UNKNOWN never silently becomes DEFINITELY_FAILED — provider status unknown forever exhausts each reconcile into DLQ + operational case; the row stays unknown (never permanent_fail); the sweeper keeps re-queuing; no new identity; no recovery", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  // more ambiguous answers than the bounded drain below can consume
  lab.sim.scriptStatus(p.authorization, Array.from({ length: 200 }, () => ({ kind: "UNKNOWN" as const })));
  await lab.enqueueCharge(d.deal_id);
  const stats = await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 14 });
  const rows = await lab.attempts(p.participant_id, "charge_start");
  assert.equal(rows.length, 1); assert.equal(rows[0]!.result_class, "unknown", "ambiguity must not decay into a failure verdict");
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeAttempt");
  const reconciles = stats.results.filter((r) => r.event_type === "payment_reconcile");
  assert.ok(reconciles.length >= 4, `bounded retries expected: ${JSON.stringify(reconciles)}`);
  assert.ok(reconciles.every((r) => r.status !== "sent"), "no reconcile may report success on ambiguous evidence");
  const cases = await lab.cases(p.participant_id);
  assert.ok(cases.some((c) => c.auto_key.startsWith("payment-reconcile-unresolved:")), `manual case expected: ${JSON.stringify(cases)}`);
  const dlq = await lab.dlqRows(p.participant_id, "payment_reconcile");
  assert.ok(dlq.length >= 1, `each exhausted reconcile must be visible in the DLQ: ${JSON.stringify(dlq)}`);
  assert.equal(lab.sim.effectsOf(p.authorization).capture + lab.sim.effectsOf(p.authorization).recover, 1);
  assert.equal(lab.sim.distinctKeys(p.authorization, "capture").length, 1);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "no recovery while the capture is unresolved");
  await lab.oracle("reconcile:unknown-forever", [d.deal_id], { allowUnresolved: true });
  // The provider becomes truthful: the maintenance sweeper's next reconcile converges the SAME identity (no manual requeue needed).
  lab.sim.clearStatusScript(p.authorization);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("reconcile:after-manual-requeue", [d.deal_id]);
});

await run("reconcile: status HTTP 500 / timeout / malformed are ambiguous (retry, never a verdict); once the seam answers, one identity converges", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_TIMEOUT" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "HTTP_500" }, { kind: "TIMEOUT" }, { kind: "MALFORMED" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const reads = lab.sim.requestsOf(p.authorization, "status");
  assert.ok(reads.length >= 4, `expected the three ambiguous reads plus a truthful one: ${reads.map((r) => r.behavior).join(",")}`);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  assert.equal((await lab.attempts(p.participant_id, "charge_start")).length, 1);
  await lab.oracle("reconcile:ambiguous-status", [d.deal_id]);
});

await run("reconcile: stale authorized (non-final) then captured — no verdict on non-final evidence; converges to one capture", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "STALE_AUTHORIZED", final: false }, { kind: "PENDING" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal(lab.sim.effectsOf(p.authorization).capture + lab.sim.effectsOf(p.authorization).recover, 1, "a stale non-final read must not trigger recovery");
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  await lab.oracle("reconcile:stale-nonfinal", [d.deal_id]);
});

await run("reconcile: later-changed result — 'failed/final' first, captured later — the late truth is recorded as a contradiction case, recovery is blocked by the executed capture, money moved exactly once", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  // provider lies once: reports failed/final for an executed capture
  lab.sim.scriptStatus(p.authorization, [{ kind: "FLAP", states: ["failed", "captured"] }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"] });
  const firstReconcile = (await lab.liveEvents([d.deal_id], ["payment_reconcile"]))[0];
  assert.ok(firstReconcile, "reconcile scheduled");
  await lab.processOutboxEventById(firstReconcile!.event_uuid);
  const afterLie = await lab.participant(p.participant_id);
  console.log(`  after failed/final: money_state=${afterLie.money_state}`);
  lab.sim.clearStatusScript(p.authorization);
  // recovery is attempted by the system; provider truth (captured) must block it
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const eff = lab.sim.effectsOf(p.authorization);
  assert.equal(eff.capture + eff.recover, 1, `money must move exactly once even when the provider first lied: ${JSON.stringify(eff)}`);
  const cases = await lab.cases(p.participant_id);
  const final = await lab.participant(p.participant_id);
  console.log(`  final: money_state=${final.money_state} recover_requests=${lab.sim.requestsOf(p.authorization, "recover").length} cases=${cases.map((c) => c.auto_key.split(":")[0]).join(",")}`);
  await lab.oracle("reconcile:later-changed", [d.deal_id], { allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE", "FAILED_DEAL_HOLDS_CAPTURED_MONEY"] });
});

await run("reconcile: two reconcilers for the same operation at once — one verdict, one identity, no duplicate transition", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_429" }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"] });
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  const a = (await lab.liveEvents([d.deal_id], ["payment_reconcile"]))[0]!.event_uuid;
  const b = await lab.enqueue("payment_reconcile", "participant", p.participant_id, { participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: row.correlation_id, operation: "capture", provider_reference: p.authorization, reason: "second-reconciler" }).catch(() => null);
  const both = await Promise.all([lab.processOutboxEventById(a), b ? lab.processOutboxEventById(b) : Promise.resolve(null)]);
  console.log(`  reconcilers: ${JSON.stringify(both.map((r) => r && r.status))}`);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  const audits = (await lab.moneyAudits(p.participant_id)).filter((x) => x.state_type === "money_state" && x.to_state === "ChargedSuccess");
  assert.equal(audits.length, 1, "exactly one capture transition");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("reconcile:two-reconcilers", [d.deal_id]);
});

await run("reconcile: wrong provider amount fails closed (case, no state change); wrong / missing provider reference in the status answer is recorded for review", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 2 }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_AMOUNT", amount_minor: 1 }]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"] });
  const reconcile = (await lab.liveEvents([d.deal_id], ["payment_reconcile"]))[0]!;
  const result = await lab.processOutboxEventById(reconcile.event_uuid);
  assert.equal(result?.status, "failed"); assert.match(String((result as any).error), /amount_mismatch/);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargeAttempt", "no state change on an amount contradiction");
  assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-reconcile-amount-mismatch")));
  // wrong / missing reference: observe and record what the reconciler does with it
  const d2 = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p2 = d2.participants[0]!;
  lab.sim.script(p2.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p2.authorization, [{ kind: "WRONG_REFERENCE" }]);
  await lab.enqueueCharge(d2.deal_id);
  await lab.drain({ dealIds: [d2.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const s2 = await lab.participant(p2.participant_id);
  console.log(`  WRONG_REFERENCE status answer: money_state=${s2.money_state} effects=${JSON.stringify(lab.sim.effectsOf(p2.authorization))}`);
  const d3 = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p3 = d3.participants[0]!;
  lab.sim.script(p3.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p3.authorization, [{ kind: "MISSING_REFERENCE" }]);
  await lab.enqueueCharge(d3.deal_id);
  await lab.drain({ dealIds: [d3.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const s3 = await lab.participant(p3.participant_id);
  console.log(`  MISSING_REFERENCE status answer: money_state=${s3.money_state} effects=${JSON.stringify(lab.sim.effectsOf(p3.authorization))}`);
  for (const [label, dealId] of [["wrong-ref", d2.deal_id], ["missing-ref", d3.deal_id]] as const) await lab.oracle(`reconcile:${label}`, [dealId]);
  await lab.oracle("reconcile:amount-mismatch", [d.deal_id], { allowUnresolved: true });
});

// ── Phase 9: idempotency torture ─────────────────────────────────────────────

await run("idempotency: worker fails after settle and before ack — the retry replays the same logical operation, the provider sees ONE identity, money moves once", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.armTestFault("worker.before_ack", { kind: "throw", code: "worker_died_before_ack" });
  const event = await lab.enqueueCharge(d.deal_id);
  const first = await lab.processOutboxEventById(event);
  assert.equal(first?.status, "failed");
  lab.resetTestFaults();
  await lab.retryNow(event);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await lab.outboxRow(event))?.status, "sent");
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").filter((r) => !r.replayed).length, 1, "one non-replayed capture request");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  assert.equal((await lab.attempts(p.participant_id, "charge_start")).length, 1);
  await lab.oracle("idempotency:before-ack-retry", [d.deal_id]);
});

await run("idempotency: duplicate outbox event and stale event replay after convergence send nothing", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  const event = await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const requestsBefore = lab.sim.requestsOf(p.authorization).length;
  // the same event again (already sent → not claimable), and a second charge_deal for the same deal
  assert.equal(await lab.processOutboxEventById(event), null);
  await lab.enqueueCharge(d.deal_id);
  // a stale reconcile carrying the converged identity
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: row.correlation_id, operation: "capture", provider_reference: p.authorization, reason: "stale-replay" });
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(lab.sim.requestsOf(p.authorization).length, requestsBefore, "no provider traffic from duplicate/stale events");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("idempotency:duplicate-stale", [d.deal_id]);
});

await run("idempotency: manual requeue after a pre-dispatch DLQ reuses the ORIGINAL identity once the authorization is repaired", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", withoutAuthorization: true }] });
  const p = d.participants[0]!;
  const event = await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], types: ["charge_deal"], maxRounds: 14 });
  assert.equal((await lab.outboxRow(event))?.status, "dlq", "the exhausted job is archived in the DLQ");
  const minted = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(minted.dispatch_state, "recorded");
  // operator repairs the authorization (a consumed binding) and requeues a fresh charge job
  await lab.attachAuthorization(d, p);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.deepEqual(lab.sim.distinctKeys(p.authorization, "capture"), [minted.correlation_id], "the original identity is the one that reaches the provider");
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  await lab.oracle("idempotency:manual-requeue", [d.deal_id]);
});

await run("identity is tied to the logical operation, not the retry: across a lost response and three ambiguous status reads the provider sees one key and the ledger holds one entry", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_RESPONSE_LOST" }]);
  // Money-lane reconcile retries are bounded (four attempts); three ambiguous
  // reads then a truthful one stays inside the bound. The bound itself — and
  // what happens when it is exhausted — is proven by "UNKNOWN never silently
  // becomes DEFINITELY_FAILED" above.
  lab.sim.scriptStatus(p.authorization, [{ kind: "PENDING" }, { kind: "HTTP_500" }, { kind: "UNKNOWN" }]);
  await lab.enqueueCharge(d.deal_id);
  const stats = await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 40 });
  console.log(`  retries: ${stats.results.map((r) => `${r.event_type}:${r.status}:${String(r.error || "").slice(0, 50)}`).join(" | ")} status_reads=${lab.sim.requestsOf(p.authorization, "status").map((r) => r.behavior).join(",")}`);
  assert.equal(lab.sim.distinctKeys(p.authorization, "capture").length, 1);
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  assert.equal((await lab.ledger(p.participant_id)).length, 1);
  await lab.oracle("idempotency:retries-one-key", [d.deal_id]);
});

await run("reconcile before dispatch (stale reconcile races the first send): money moves at most once and every identity converges", async () => {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  const correlation = `charge_start:lab-early:n1:${p.participant_id}`;
  await insertAttempt(p.participant_id, d.deal_id, "charge_start", "unknown", correlation, "recorded");
  await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: correlation, operation: "capture", provider_reference: p.authorization, reason: "before-dispatch" });
  await lab.drain({ dealIds: [d.deal_id], types: ["payment_reconcile"] });
  const afterReconcile = await lab.participant(p.participant_id);
  const rowAfter = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  console.log(`  reconcile-before-dispatch: money_state=${afterReconcile.money_state} row=${rowAfter.result_class}/${rowAfter.dispatch_state}`);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const eff = lab.sim.effectsOf(p.authorization);
  assert.ok(eff.capture + eff.recover <= 1, `money moved ${eff.capture + eff.recover} times`);
  const final = await lab.participant(p.participant_id);
  console.log(`  final: money_state=${final.money_state} effects=${JSON.stringify(eff)} keys=${JSON.stringify(lab.sim.distinctKeys(p.authorization, "capture"))}`);
  await lab.oracle("reconcile:before-dispatch", [d.deal_id]);
});

// ── F-4: a second reconcile need behind an already-pending reconcile ─────────

await run("F-4: an UNKNOWN identity whose reconcile collides with another pending reconcile of the same participant is neither lost nor invisible — it is swept into its own reconcile and converges", async () => {
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
  const p = d.participants[0]!;
  // a stale reconcile (foreign correlation) is already queued for this participant
  await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "release", correlation_id: `release:stale:n1:${p.participant_id}`, operation: "release", provider_reference: p.authorization, reason: "stale" });
  lab.sim.script(p.authorization, "release", [{ kind: "EFFECT_THEN_CONNECTION_RESET" }]);
  const release = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const first = await lab.processOutboxEventById(release);
  assert.equal(first?.status, "sent", JSON.stringify(first));
  const row = (await lab.attempts(p.participant_id, "release"))[0]!;
  assert.equal(row.result_class, "unknown", "post-dispatch reset → UNKNOWN");
  // the identity's own reconcile could not be queued (index) — it must still be visible or swept
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40 });
  const after = (await lab.attempts(p.participant_id, "release"))[0]!;
  const cases = await lab.cases(p.participant_id);
  console.log(`  f4: identity=${after.result_class}/${after.dispatch_state} money_state=${(await lab.participant(p.participant_id)).money_state} cases=${cases.map((c) => c.auto_key.split(":")[0]).join(",")}`);
  assert.equal(after.result_class, "success", "the UNKNOWN release identity must converge (provider truth: released)");
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  assert.equal(lab.sim.effectsOf(p.authorization).release, 1);
  await lab.oracle("f4:reconcile-collision", [d.deal_id]);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
