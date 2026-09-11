/**
 * R9C ROUND 4 — CONCURRENCY FINAL-STATE FAILURE: reconstruction, root cause,
 * terminal-state proof, and two adjacent defects found by the analysis.
 *
 * Codex (rounds 2 and 3) observed, in the two-worker concurrency matrix, a deal
 * in state `Completed` whose participant was still `buyer_state=ChargedSuccess`
 * (money_state ChargedSuccess) when the oracle ran — the final assertion
 * COMPLETED_DEAL_PARTICIPANT_NOT_FINAL. An isolated rerun passed. Their log
 * preserved only the oracle line (worker output is in-memory), so the
 * chronology had to be re-derived from the production source and reproduced.
 *
 * MECHANISM (src/app.ts, read — not guessed):
 *   1. handleFinalizeDealEvent runs at the completion window's end. Its F-2
 *      gate defers while ANY capture-side identity is UNKNOWN or executed-but-
 *      unapplied (R-11). The only participant it can read as non-final and
 *      still proceed is one with NO capture identity yet — never attempted,
 *      e.g. a charge_deal re-run after a lost lease has not reached it. With
 *      threshold 1 met by the other participant it commits deal -> Completed
 *      in its OWN transaction, reads the participants, and then transitions
 *      each in a SEPARATE transaction from the state it read
 *      (ChargingAttempt -> DealFailed for the un-attempted one).
 *   2. Concurrently that participant's capture lands on the other worker
 *      (arm, dispatch, settle, ingest -> ChargedSuccess / ChargedSuccess).
 *   3. If the ingest commits between finalize's participant read and
 *      finalize's CAS, the CAS finds the row changed: STATE_CONFLICT, the
 *      handler throws, the outbox marks the finalize job failed and schedules a
 *      retry with backoff. The two-worker test drains only money events, stops
 *      the workers and audits at once — the deferred retry (which takes the
 *      R-11 path) never runs before the oracle reads deal=Completed,
 *      participant=ChargedSuccess. That is Codex's observation (RC-1/RC-2), and
 *      the retry heals it with no money movement (RC-3/RC-4).
 *
 * TWO ADJACENT DEFECTS the same analysis exposes (fixed in this round, with
 * the failing-first evidence below):
 *   F-15  the OTHER order of the same race: finalize's DealFailed CAS commits
 *         between the capture's ARM (identity row minted, money about to move
 *         or already moved) and its INGEST. The ingest then fails on the
 *         buyer-state CAS, and the participant ends DealFailed with captured
 *         money and no refund path — "failed while money captured".
 *         Fix: the fail-participant CAS refuses, in its own transaction, any
 *         participant that owns a capture-side identity other than
 *         permanent_fail; the job retries and the F-2 gate then defers.
 *   F-14  the R-11 retry path only completed PAID participants. A finalize
 *         aborted mid-loop (by the conflict above) left every unpaid sibling
 *         that came after the conflicting participant non-terminal on a
 *         Completed deal, with its authorization hold never released.
 *         Fix: the retry path applies the whole completed-deal outcome
 *         (complete paid, fail unpaid, release held authorizations,
 *         notifications, receipts, fulfillment, payout) — every step idempotent.
 *
 * Every scenario drives the REAL handlers in-process against a disposable
 * database and the in-process provider simulator. The interleavings are forced
 * with a row lock on the participant: transactions queue on it in the order
 * they arrive, so the same mechanism yields both orders deterministically and
 * independently of the finalize loop's row order. Synthetic money only.
 */

import assert from "node:assert/strict";
import { bootLab, makeRunner, sleep, timeout } from "./lab/runtime.js";
import type { PoolClient } from "pg";

const lab = await bootLab({ tag: "finalize-race", port: 3231, env: { COMPLETION_WINDOW_MINUTES: "0.2" } });
const { run, summary } = makeRunner("review_finalize_participant_race_terminal_state");

type Seeded = Awaited<ReturnType<typeof lab.seedDeal>>;

/** p1 fully captured; p2 not yet attempted (no capture identity — the only non-final shape F-2 lets through); window elapsed; threshold 1. */
async function raceDeal() {
  const d = await lab.seedDeal({
    state: "CompletionWindow",
    completionWindowUntil: new Date(Date.now() - 2_000),
    threshold_units: 1,
    participants: [
      { buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: "capture:lab:n1:p1" }] },
      { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }
    ]
  });
  lab.sim.forceEffect("capture", d.participants[0]!.authorization, d.participants[0]!.amount_minor);
  return d;
}

/** The capture of p2 landing: the provider's money effect plus the ingest that applies it — the same path the capture rail calls after dispatch. */
function landCapture(d: Seeded, correlationId: string | null = null) {
  const p2 = d.participants[1]!;
  lab.sim.forceEffect("capture", p2.authorization, p2.amount_minor);
  return lab.postWebhook({ event_type: "charge_captured", provider_reference: p2.authorization, participant_id: p2.participant_id, deal_id: d.deal_id, correlation_id: correlationId });
}

/** Hold a row lock on one participant so every UPDATE of that row queues behind it, in arrival order. */
async function lockParticipant(participantId: string): Promise<{ release: () => Promise<void> }> {
  const client: PoolClient = await lab.pool.connect();
  await client.query("BEGIN");
  // FOR NO KEY UPDATE: blocks every state UPDATE of the row (they take the same
  // lock) but not the KEY SHARE an FK insert takes (webhook_events references
  // participants), so the ingest can claim its event and then queue on the CAS.
  await client.query(`SELECT participant_id FROM siton.participants WHERE participant_id=$1 FOR NO KEY UPDATE`, [participantId]);
  let released = false;
  return { release: async () => { if (released) return; released = true; await client.query("COMMIT"); client.release(); } };
}

/** Hold the participant:deal advisory lock the finalize guard (and every rail) takes; the finalize then parks AFTER its stale participant read. */
async function holdParticipantDealLock(participantId: string, dealId: string): Promise<{ release: () => Promise<void> }> {
  const client: PoolClient = await lab.pool.connect();
  await client.query("BEGIN");
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`, [participantId, dealId]);
  let released = false;
  return { release: async () => { if (released) return; released = true; await client.query("COMMIT"); client.release(); } };
}
async function waitForLockWaiter(pattern: RegExp, label: string) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) { const w = await lockWaiters(); if (w.some((q) => pattern.test(q))) { console.log(`  WAITERS[${label}] ${JSON.stringify(w)}`); return; } await sleep(25); }
  throw new Error(`${label}: no statement matching ${pattern} is waiting; waiters=${JSON.stringify(await lockWaiters())}`);
}
/** Number of statements currently waiting on a lock while touching participants (the CAS, or the serialized row lock that precedes it). */
async function lockWaiters(): Promise<string[]> {
  const r = await lab.pool.query(`SELECT left(query, 120) AS q FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' ORDER BY pid`);
  return r.rows.map((x: any) => String(x.q).split(String.fromCharCode(10)).join(" "));
}
async function participantUpdateWaiters(): Promise<number> {
  return (await lockWaiters()).filter((q) => /participants/i.test(q)).length;
}
async function waitForWaiters(n: number, label: string) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) { if ((await participantUpdateWaiters()) >= n) { console.log(`  WAITERS[${label}] ${JSON.stringify(await lockWaiters())}`); return; } await sleep(25); }
  const dump = await lab.pool.query(`SELECT pid, state, wait_event_type, wait_event, left(query, 160) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid()`);
  throw new Error(`${label}: expected ${n} queued participant update(s), saw ${await participantUpdateWaiters()}; activity=${JSON.stringify(dump.rows)}`);
}
async function waitForDealState(dealId: string, state: string) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) { if ((await lab.deal(dealId)).state === state) return; await sleep(25); }
  throw new Error(`deal ${dealId} never reached ${state}`);
}
function providerRequestCount() { return lab.sim.snapshot().requests.length; }
async function auditChain(participantId: string) {
  return (await lab.pool.query(
    `SELECT state_type, from_state, to_state, action_name FROM siton.audit_log
     WHERE entity_type='participant' AND entity_id=$1 AND state_type IN ('buyer_state','money_state') ORDER BY created_at ASC, audit_id ASC`,
    [participantId]
  )).rows as Array<{ state_type: string; from_state: string; to_state: string; action_name: string }>;
}

let shared: { deal: Seeded; finalize: string; conflictError: string | null } | null = null;

await run("RC-1 Codex's order — the capture lands after finalize's stale participant read: deal Completed, p2 ChargedSuccess, finalize failed on a state conflict, retry pending", async () => {
  const d = await raceDeal();
  const [p1, p2] = d.participants as [Seeded["participants"][0], Seeded["participants"][0]];
  // The guard serializes on the participant:deal advisory lock; holding it
  // parks the finalize exactly between its participant read (p2 =
  // ChargingAttempt) and its CAS — the window the two-worker race hits.
  const lock = await holdParticipantDealLock(p2.participant_id, d.deal_id);
  try {
    const finalize = await lab.enqueueFinalize(d.deal_id);
    const requestsBefore = providerRequestCount();
    const finalizeRun = lab.processOutboxEventById(finalize);
    await waitForDealState(d.deal_id, "Completed");
    await waitForLockWaiter(/pg_advisory_xact_lock/, "finalize guard");
    // the capture lands now (no identity row: the rail's own arm is not what
    // Codex's participant had — it was a late ingest against a stale read)
    const landed = await landCapture(d);
    assert.ok(landed.statusCode < 300, `capture ingest answered ${landed.statusCode}: ${landed.body}`);
    const p2Mid = await lab.participant(p2.participant_id);
    assert.equal(p2Mid.buyer_state, "ChargedSuccess");
    await lock.release();
    const result = await Promise.race([finalizeRun, timeout(20_000, "finalize never returned")]);
    assert.ok(result && result.status === "failed", `finalize should fail on the stale participant CAS, got ${JSON.stringify(result)}`);
    const row = await lab.outboxRow(finalize);
    assert.ok(row);
    assert.equal(row!.status, "pending", "finalize is retried (pending), not dead");
    assert.equal(row!.attempt_count, 1);
    assert.equal(row!.deferred, true, "the retry is deferred by backoff — the window in which the two-worker test stopped its workers");
    assert.ok(/STATE_CONFLICT|State mismatch|expected/i.test(String(row!.last_error || "")), `last_error names the participant state conflict: ${row!.last_error}`);
    // Codex's exact signature
    assert.equal((await lab.deal(d.deal_id)).state, "Completed");
    const p2Now = await lab.participant(p2.participant_id);
    assert.equal(p2Now.buyer_state, "ChargedSuccess");
    assert.equal(p2Now.money_state, "ChargedSuccess");
    const p1Now = await lab.participant(p1.participant_id);
    assert.ok(["DealCompleted", "ChargedSuccess"].includes(String(p1Now.buyer_state)), `p1 ${p1Now.buyer_state} (loop order decides whether p1 was reached before the abort)`);
    assert.equal(providerRequestCount(), requestsBefore, "finalize never talks to the provider");
    console.log(`  SIGNATURE deal=${d.deal_id} p2=${p2.participant_id} buyer=${p2Now.buyer_state} money=${p2Now.money_state} p1=${p1Now.buyer_state} finalize=${row!.status}#${row!.attempt_count} deferred=${row!.deferred} last_error="${String(row!.last_error).slice(0, 110)}"`);
    shared = { deal: d, finalize, conflictError: row!.last_error };
  } finally {
    await lock.release().catch(() => undefined);
  }
});

await run("RC-2 at that instant the oracle reports COMPLETED_DEAL_PARTICIPANT_NOT_FINAL and nothing about money — Codex's assertion", async () => {
  assert.ok(shared, "RC-1 must have produced the state");
  const report = await lab.oracle("finalize-race:intermediate", [shared!.deal.deal_id], { allowedCodes: ["COMPLETED_DEAL_PARTICIPANT_NOT_FINAL"], print: false });
  const codes = [...new Set(report.violations.map((v) => v.code))];
  assert.deepEqual(codes, ["COMPLETED_DEAL_PARTICIPANT_NOT_FINAL"], JSON.stringify(report.violations));
  assert.ok(report.violations.some((v) => v.participant_id === shared!.deal.participants[1]!.participant_id));
  assert.equal(report.counts.capture_effects, 2);
  assert.equal(report.counts.canonical_charged, 2);
  assert.equal(report.counts.unknown_attempts, 0);
});

await run("RC-3 the deferred finalize retry heals through the completed-deal outcome with zero provider interaction and a clean oracle", async () => {
  assert.ok(shared);
  const { deal: d, finalize } = shared!;
  const requestsBefore = providerRequestCount();
  const effectsBefore = d.participants.map((p) => lab.sim.effectsOf(p.authorization));
  await lab.retryNow(finalize);
  const result = await lab.processOutboxEventById(finalize);
  assert.ok(result && result.status === "sent", `finalize retry should succeed, got ${JSON.stringify(result)}`);
  assert.equal((await lab.outboxRow(finalize))!.attempt_count, 2);
  for (const p of d.participants) {
    const state = await lab.participant(p.participant_id);
    assert.equal(state.buyer_state, "DealCompleted", `${p.participant_id} converged`);
    assert.equal(state.money_state, "ChargedSuccess");
  }
  assert.equal(providerRequestCount(), requestsBefore, "healing moved no money and asked the provider nothing");
  assert.deepEqual(d.participants.map((p) => lab.sim.effectsOf(p.authorization)), effectsBefore);
  const report = await lab.oracle("finalize-race:healed", [d.deal_id], { print: false });
  assert.equal(report.violations.length, 0, JSON.stringify(report.violations));
});

await run("RC-4 terminal-state invariant: effects <-> identities <-> money_state <-> buyer_state <-> deal state agree", async () => {
  assert.ok(shared);
  const d = shared!.deal;
  assert.equal((await lab.deal(d.deal_id)).state, "Completed");
  for (const p of d.participants) {
    const eff = lab.sim.effectsOf(p.authorization);
    const state = await lab.participant(p.participant_id);
    const rows = await lab.attempts(p.participant_id, "charge_start");
    const buyerState = String(state.buyer_state), moneyState = String(state.money_state);
    assert.equal(eff.capture + eff.recover, 1, "exactly one provider capture");
    assert.equal(rows.filter((r) => r.result_class === "unknown").length, 0, "no unresolved identity");
    assert.ok(rows.filter((r) => r.result_class === "success").length <= 1, "at most one successful capture identity");
    // the three prohibitions first (they are the invariant), then the exact expected terminal pair
    assert.ok(!(buyerState === "DealFailed" && eff.capture + eff.recover > 0), "failed while captured");
    assert.ok(!(moneyState === "ChargedSuccess" && eff.capture + eff.recover === 0), "success without capture");
    assert.ok(["DealCompleted", "DealFailed"].includes(buyerState), "no participant stuck non-terminal after every operation is terminal");
    assert.equal(moneyState, "ChargedSuccess");
    assert.equal(buyerState, "DealCompleted");
  }
  // the seed writes the join_authorize audit row; the chain under test starts after it
  const chain = (await auditChain(d.participants[1]!.participant_id)).filter((a) => a.action_name !== "participant.join_authorize");
  const buyer = chain.filter((a) => a.state_type === "buyer_state").map((a) => `${a.from_state}->${a.to_state}`);
  const money = chain.filter((a) => a.state_type === "money_state").map((a) => `${a.from_state}->${a.to_state}`);
  assert.deepEqual(buyer, ["ChargingAttempt->ChargedSuccess", "ChargedSuccess->DealCompleted"], JSON.stringify(chain));
  assert.deepEqual(money, ["ChargeAttempt->ChargedSuccess"], JSON.stringify(chain));
  assert.equal(chain.filter((a) => a.action_name === "deal.fail_participant_after_completed").length, 0, "the stale DealFailed transition never committed");
  console.log(`  TERMINAL deal=${d.deal_id} chain(p2)=${buyer.join(" | ")} money=${money.join(" | ")} finalize_error_seen="${String(shared!.conflictError).slice(0, 80)}"`);
});

/**
 * The capture rail's ARM, modelled the way armProviderDispatch does it: the
 * participant/deal advisory lock, the committed participant state, and only
 * then the identity row. Returns whether the rail would have dispatched.
 */
async function armLikeTheRail(d: Seeded, correlationId: string): Promise<boolean> {
  const p2 = d.participants[1]!;
  const client: PoolClient = await lab.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`, [p2.participant_id, d.deal_id]);
    const state = (await client.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [p2.participant_id])).rows[0];
    const armed = state.buyer_state === "ChargingAttempt" && state.money_state === "ChargeAttempt";
    if (armed) {
      await client.query(
        `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, dispatched_at)
         VALUES ($1,$2,'charge_start','unknown',$3,'recorded',clock_timestamp())`,
        [p2.participant_id, d.deal_id, correlationId]
      );
    }
    await client.query("COMMIT");
    return armed;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

await run("RC-5a F-15 finalize first — its DealFailed CAS commits, the rail's arm then reads DealFailed and refuses: no money moves, hold released", async () => {
  const d = await raceDeal();
  const p2 = d.participants[1]!;
  const lock = await lockParticipant(p2.participant_id);
  let armed: boolean | null = null; let finalizeResult: any = null;
  try {
    // finalize: F-2 sees NO identity, commits deal -> Completed, reads p2 as
    // ChargingAttempt, takes the advisory lock, checks, and its CAS queues on the row
    const finalize = await lab.enqueueFinalize(d.deal_id);
    const finalizeRun = lab.processOutboxEventById(finalize);
    await waitForDealState(d.deal_id, "Completed");
    await waitForWaiters(1, "finalize DealFailed CAS");
    // the rail arrives now: it queues on the advisory lock the finalize holds
    const arming = armLikeTheRail(d, "capture:lab:n1:p2");
    await sleep(150);
    await lock.release();
    finalizeResult = await Promise.race([finalizeRun, timeout(20_000, "finalize never returned")]);
    armed = await Promise.race([arming, timeout(20_000, "arm never returned")]);
  } finally {
    await lock.release().catch(() => undefined);
  }
  console.log(`  F-15a finalize=${JSON.stringify(finalizeResult && { status: finalizeResult.status })} rail_armed=${armed} p2=${JSON.stringify(await lab.participant(p2.participant_id))}`);
  assert.equal(armed, false, "the rail must refuse to arm a participant the finalize already failed");
  await lab.drain({ dealIds: [d.deal_id], advanceDeferred: true, maxRounds: 40 });
  const p2Final = await lab.participant(p2.participant_id);
  const eff = lab.sim.effectsOf(p2.authorization);
  assert.equal(eff.capture + eff.recover, 0, "no capture executed");
  assert.equal(p2Final.buyer_state, "DealFailed");
  assert.equal(p2Final.money_state, "AuthReleased", `the never-attempted hold is released: ${JSON.stringify(p2Final)}`);
  assert.equal(eff.release, 1);
  const report = await lab.oracle("finalize-race:f15a", [d.deal_id], { print: false });
  assert.equal(report.violations.length, 0, JSON.stringify(report.violations));
});

await run("RC-5b F-15 arm lands after the F-2 gate and before the fail CAS — the guard sees the identity, defers, the capture lands, the retry completes", async () => {
  const d = await raceDeal();
  const p2 = d.participants[1]!;
  // Park finalize INSIDE its deal -> Completed transaction (its F-2 gate has
  // already passed with no identity for p2, the participants are not yet read).
  const barrier = lab.armTestFault("atomic.after_durable_writes_before_commit", { kind: "block" }, 1);
  const finalize = await lab.enqueueFinalize(d.deal_id);
  const finalizeRun = lab.processOutboxEventById(finalize);
  await Promise.race([barrier.entered, timeout(15_000, "finalize never reached the deal transition")]);
  // The rail arms p2 now (advisory lock, committed participant state, identity row).
  assert.equal(await armLikeTheRail(d, "capture:lab:n1:p2"), true, "the rail arms: p2 is still ChargingAttempt");
  barrier.release();
  const finalizeResult: any = await Promise.race([finalizeRun, timeout(20_000, "finalize never returned")]);
  lab.resetTestFaults();
  const row = await lab.outboxRow(finalize);
  console.log(`  F-15b finalize=${JSON.stringify(finalizeResult && { status: finalizeResult.status })} outbox=${row!.status}#${row!.attempt_count} deferred=${row!.deferred} last_error="${String(row!.last_error).slice(0, 110)}" p2=${JSON.stringify(await lab.participant(p2.participant_id))}`);
  assert.equal((await lab.deal(d.deal_id)).state, "Completed", "the deal decision itself was legitimate (threshold met by p1)");
  assert.equal((await lab.participant(p2.participant_id)).buyer_state, "ChargingAttempt", "the guard must not fail a participant whose capture is armed");
  assert.equal(row!.status, "pending", "deferred, not dead");
  assert.equal(row!.attempt_count, 1, "one claim; a deferral adds no failure backoff and no attempt beyond the claim");
  assert.equal(row!.deferred, true);
  assert.ok(/capture_in_flight/.test(String(row!.last_error || "")), `the deferral names the in-flight identity: ${row!.last_error}`);
  // the capture now lands (money moves, the ingest applies it)
  const landed = await landCapture(d, "capture:lab:n1:p2");
  assert.ok(landed.statusCode < 300, `ingest ${landed.statusCode}: ${landed.body}`);
  await lab.drain({ dealIds: [d.deal_id], advanceDeferred: true, maxRounds: 40 });
  const p2Final = await lab.participant(p2.participant_id);
  const eff = lab.sim.effectsOf(p2.authorization);
  assert.equal(eff.capture, 1);
  assert.equal(p2Final.money_state, "ChargedSuccess");
  assert.equal(p2Final.buyer_state, "DealCompleted", `captured participant on a Completed deal must complete: ${JSON.stringify(p2Final)}`);
  const report = await lab.oracle("finalize-race:f15b", [d.deal_id], { print: false });
  assert.equal(report.violations.length, 0, JSON.stringify(report.violations));
});

await run("RC-6 F-14 the retry path must also fail the unpaid siblings and release their holds", async () => {
  // The state a mid-loop abort leaves behind: deal Completed, p1 done, p2 paid
  // but not completed (the R-11 case), p3 declined earlier and never transitioned.
  const d = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [
      { buyer_state: "DealCompleted", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: "capture:lab:n1:q1" }] },
      { buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: "capture:lab:n1:q2" }] },
      { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: "capture:lab:n1:q3" }] }
    ]
  });
  for (const p of d.participants.slice(0, 2)) lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  const [, p2, p3] = d.participants as [Seeded["participants"][0], Seeded["participants"][0], Seeded["participants"][0]];
  const finalize = await lab.enqueueFinalize(d.deal_id);
  const result = await lab.processOutboxEventById(finalize);
  assert.ok(result && result.status === "sent", JSON.stringify(result));
  assert.equal((await lab.participant(p2.participant_id)).buyer_state, "DealCompleted", "paid sibling completed");
  const p3Now = await lab.participant(p3.participant_id);
  assert.equal(p3Now.buyer_state, "DealFailed", `F-14: unpaid sibling must be failed, not left ${p3Now.buyer_state} on a Completed deal`);
  const release = await lab.liveEvents([d.deal_id], ["payment_release"]);
  assert.ok(release.length >= 1, "F-14: the unpaid sibling's authorization hold must be scheduled for release");
  // the release rail then proves the hold was released at the provider
  await lab.drain({ dealIds: [d.deal_id], advanceDeferred: true, maxRounds: 40 });
  const p3End = await lab.participant(p3.participant_id);
  assert.equal(p3End.money_state, "AuthReleased", `hold released: ${JSON.stringify(p3End)}`);
  assert.equal(lab.sim.effectsOf(p3.authorization).release, 1);
  const report = await lab.oracle("finalize-race:f14", [d.deal_id], { print: false });
  assert.equal(report.violations.length, 0, JSON.stringify(report.violations));
});

await run("RC-7 control: without the interleaving the same finalize completes both participants in one run", async () => {
  const d = await raceDeal();
  await landCapture(d);
  const finalize = await lab.enqueueFinalize(d.deal_id);
  const result = await lab.processOutboxEventById(finalize);
  assert.ok(result && result.status === "sent", JSON.stringify(result));
  for (const p of d.participants) assert.equal((await lab.participant(p.participant_id)).buyer_state, "DealCompleted");
  const report = await lab.oracle("finalize-race:control", [d.deal_id], { print: false });
  assert.equal(report.violations.length, 0, JSON.stringify(report.violations));
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
