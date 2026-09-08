// FINAL FINANCIAL INTEGRATION — RESIDUAL B: LEGACY ROWS (settlement_horizon_at
// NULL, failure_evidence NULL, negative_finality_authoritative NULL — capture-side
// operations that predate migration 064).
//
// Rule under test: a legacy row is NEVER "horizon already elapsed". It is fenced
// (fail closed) until an operator records exact evidence; where the original
// dispatch instant is durable, migration 064 reconstructs a conservative horizon
// (dispatched_at + 24 h) — informational, the authority stays unproven.
//
//   LB-1  legacy dispatched DEFINITELY_FAILED → recovery / release / finalize held with cases; operator evidence → one recovery
//   LB-2  legacy UNKNOWN → reconciled by an authoritative provider to permanent_fail, still fenced (authority unproven)
//   LB-3  legacy SUCCESS-unapplied → finalize defers (R-11), reconciled to ChargedSuccess
//   LB-4  legacy row missing its provider reference → fenced; nothing dispatched
//   LB-5  contrast: a legacy row WITH exact-request evidence is not fenced → one recovery
//   LB-6  backfill: re-applying 064 on a legacy row with a dispatch instant sets horizon = dispatched_at + 24 h and keeps it fenced
//   LB-7  DB backstop: no recovery / release identity for a legacy-fenced participant
//
// Negative control: mutant M33 (legacy rows admitted) turns LB-1 red.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { bootLab, makeRunner } from "./lab/runtime.js";

const HORIZON_MS = 700;
const lab = await bootLab({
  tag: "residual-b",
  port: 3168,
  simulator: { nativeIdempotency: false },
  env: { COMPLETION_WINDOW_MINUTES: "1", PAYMENT_SETTLEMENT_HORIZON_MS: String(HORIZON_MS) },
  outboxMaxAttempts: 4
});
const { run, summary } = makeRunner("payment_final_residual_b");
const skipFinalize = (e: { event_type: string }) => e.event_type === "finalize_deal";
const casesOf = async (pid: string) => (await lab.cases(pid)).map((c) => c.auto_key.split(":")[0]);
const anHourAgo = () => new Date(Date.now() - 60 * 60_000);

type Legacy = { evidence?: "dispatch_response" | null; withRef?: boolean; result?: "permanent_fail" | "unknown" | "success"; money?: string; buyer?: string; windowElapsed?: boolean };
async function seedLegacy(opts: Legacy = {}) {
  // the completion window is immutable once set: open by default (recovery /
  // release scenarios), elapsed on request (finalize scenarios)
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: opts.windowElapsed ? new Date(Date.now() - 1000) : new Date(Date.now() + 120_000), participants: [{
    buyer_state: opts.buyer ?? "ChargeFailedCompletion",
    money_state: opts.money ?? "ChargeFailedRecovery",
    ...(opts.withRef === false ? { withoutAuthorization: true, binding: false } : {}),
    priorAttempts: [{ attempt_type: "charge_start", result_class: opts.result ?? "permanent_fail", correlation_id: `capture:legacy:n1:${randomUUID()}`, dispatch_state: "responded", failure_evidence: opts.evidence ?? null, settlement_horizon_at: null, negative_finality_authoritative: null, dispatched_at: anHourAgo() }]
  }] });
  return { d, p: d.participants[0]! };
}

// ── LB-1 ───────────────────────────────────────────────────────────────────────
await run("LB-1 legacy dispatched DEFINITELY_FAILED (no horizon, no evidence, no authority) → recovery, release and finalize all HOLD with cases; operator evidence → exactly one recovery", async () => {
  const { d, p } = await seedLegacy();
  const fence = (await lab.pool.query(`SELECT siton.payment_capture_settlement_fence($1::uuid,$2::uuid)::text AS f`, [p.participant_id, d.deal_id])).rows[0].f;
  console.log(`  LB-1 fence=${fence}`);
  assert.equal(String(fence), "infinity", "a legacy row is fenced permanently, never 'elapsed'");
  const recovery = await lab.enqueueRecovery(d.deal_id);
  await lab.processOutboxEventById(recovery);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0, "legacy row recovered automatically");
  assert.ok((await casesOf(p.participant_id)).includes("payment-recovery-negative-finality-unproven"));
  const release = await lab.enqueueRelease(p.participant_id, d.deal_id);
  const rel = await lab.processOutboxEventById(release);
  assert.match(String((rel as any)?.error || ""), /negative_finality_unproven/);
  assert.equal(lab.sim.effectsOf(p.authorization).release, 0);
  // finalize on a second legacy deal whose window has elapsed: held, not decided
  const { d: dF, p: pF } = await seedLegacy({ windowElapsed: true });
  const finalize = await lab.enqueueFinalize(dF.deal_id);
  const fin = await lab.processOutboxEventById(finalize);
  console.log(`  LB-1 finalize: ${fin?.status} ${String((fin as any)?.error || "").slice(0, 60)} deal=${(await lab.deal(dF.deal_id)).state}`);
  assert.equal((await lab.deal(dF.deal_id)).state, "CompletionWindow", "no terminal decision on a legacy row");
  assert.equal((await lab.pool.query(`SELECT 1 FROM siton.operational_cases WHERE auto_key=$1`, [`deal-finalize-negative-finality-unproven:${dF.deal_id}`])).rowCount, 1);
  assert.equal(lab.sim.effectsOf(pF.authorization).release, 0);
  // the operator verifies at the provider and records exact evidence on the first deal
  await lab.pool.query(`UPDATE siton.payment_attempts SET failure_evidence='operator' WHERE participant_id=$1 AND attempt_type='charge_start'`, [p.participant_id]);
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const eff = lab.sim.effectsOf(p.authorization);
  console.log(`  LB-1 after operator evidence: effects=${JSON.stringify(eff)} state=${(await lab.participant(p.participant_id)).money_state}`);
  assert.equal(eff.recover, 1, "exactly one recovery once the operator recorded exact evidence");
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  await lab.oracle("LB-1", [d.deal_id], { allowUnresolved: true });
});

// ── LB-2 ───────────────────────────────────────────────────────────────────────
await run("LB-2 legacy UNKNOWN → an authoritative provider status resolves it to permanent_fail, but the row's authority is unproven → still fenced, no recovery", async () => {
  const { d, p } = await seedLegacy({ result: "unknown", money: "ChargeAttempt", buyer: "ChargingAttempt" });
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  await lab.enqueueRecovery(d.deal_id).catch(() => undefined);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 20, waitDeferredUpToMs: 3_000 });
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  const state = await lab.participant(p.participant_id);
  console.log(`  LB-2: identity=${row.result_class}/${row.failure_evidence}/auth=${row.negative_finality_authoritative} state=${state.buyer_state}/${state.money_state} effects=${JSON.stringify(lab.sim.effectsOf(p.authorization))} cases=${(await casesOf(p.participant_id)).join(",")}`);
  assert.equal(row.result_class, "permanent_fail", "the sweeper reconciled the legacy UNKNOWN row");
  assert.equal(row.negative_finality_authoritative, null, "a legacy row never acquires authority after the fact");
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 0, "no automatic recovery on a legacy row");
  assert.ok((await casesOf(p.participant_id)).includes("payment-recovery-negative-finality-unproven"));
  await lab.oracle("LB-2", [d.deal_id], { allowUnresolved: true });
});

// ── LB-3 ───────────────────────────────────────────────────────────────────────
await run("LB-3 legacy SUCCESS-unapplied → finalize defers (R-11) and the identity converges to ChargedSuccess", async () => {
  const { d, p } = await seedLegacy({ result: "success", money: "ChargeAttempt", buyer: "ChargingAttempt", windowElapsed: true });
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  const finalize = await lab.enqueueFinalize(d.deal_id);
  const fin = await lab.processOutboxEventById(finalize);
  assert.match(String((fin as any)?.error || ""), /finalize_waiting_for_unresolved_captures/);
  await lab.drain({ dealIds: [d.deal_id], maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const state = await lab.participant(p.participant_id);
  console.log(`  LB-3: state=${state.buyer_state}/${state.money_state} deal=${(await lab.deal(d.deal_id)).state}`);
  assert.equal(state.money_state, "ChargedSuccess");
  assert.equal((await lab.deal(d.deal_id)).state, "Completed");
  await lab.oracle("LB-3", [d.deal_id]);
});

// ── LB-4 ───────────────────────────────────────────────────────────────────────
await run("LB-4 legacy row missing its provider reference → fenced; nothing is dispatched; case", async () => {
  const { d, p } = await seedLegacy({ withRef: false });
  const recovery = await lab.enqueueRecovery(d.deal_id);
  await lab.processOutboxEventById(recovery);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  assert.equal(lab.sim.snapshot().requests.filter((r) => r.op === "recover" && r.at > new Date(Date.now() - 5_000).toISOString() && r.authorization === "").length, 0, "no recovery request with an empty reference");
  assert.ok((await casesOf(p.participant_id)).includes("payment-recovery-negative-finality-unproven"));
});

// ── LB-5 ───────────────────────────────────────────────────────────────────────
await run("LB-5 contrast: a legacy row WITH exact-request evidence (the provider declined the capture itself) is not fenced → exactly one recovery", async () => {
  const { d, p } = await seedLegacy({ evidence: "dispatch_response" });
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  await lab.oracle("LB-5", [d.deal_id]);
});

// ── LB-6 ───────────────────────────────────────────────────────────────────────
await run("LB-6 backfill: re-applying migration 064 on a legacy row with a dispatch instant reconstructs horizon = dispatched_at + 24 h and keeps it fenced (authority unproven)", async () => {
  const { d, p } = await seedLegacy();
  const sql = readFileSync("src/migrations/067_payment_settlement_horizon.sql", "utf8");
  await lab.pool.query(sql); // idempotent: IF NOT EXISTS / CREATE OR REPLACE / conditional UPDATE
  const row = (await lab.pool.query(`SELECT settlement_horizon_at, dispatched_at, negative_finality_authoritative, (settlement_horizon_at = dispatched_at + interval '24 hours') AS reconstructed FROM siton.payment_attempts WHERE participant_id=$1`, [p.participant_id])).rows[0];
  const fence = (await lab.pool.query(`SELECT siton.payment_capture_settlement_fence($1::uuid,$2::uuid)::text AS f`, [p.participant_id, d.deal_id])).rows[0].f;
  console.log(`  LB-6: reconstructed=${row.reconstructed} authority=${row.negative_finality_authoritative} fence=${fence}`);
  assert.equal(row.reconstructed, true, "horizon reconstructed from the durable dispatch instant");
  assert.equal(row.negative_finality_authoritative, null);
  assert.equal(String(fence), "infinity", "a reconstructed horizon does not lift the fence: the authority is still unproven");
});

// ── LB-7 ───────────────────────────────────────────────────────────────────────
await run("LB-7 DB backstop: no recovery / release identity can be minted for a legacy-fenced participant", async () => {
  const { d, p } = await seedLegacy();
  for (const type of ["recovery", "release"]) {
    await assert.rejects(
      lab.pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,$3,'unknown',$4,'recorded')`, [p.participant_id, d.deal_id, type, `${type}:lb7:${randomUUID()}`]),
      (error: any) => String(error?.code) === "SN409" && /negative_finality_unproven/.test(String(error?.message)),
      `${type} identity must be refused for a legacy-fenced participant`
    );
  }
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
