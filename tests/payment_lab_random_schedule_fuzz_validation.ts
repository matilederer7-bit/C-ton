// FINANCIAL TORTURE LAB — Phase 18: seeded random schedule fuzzing.
//
// Every scenario is generated from a deterministic seed (printed), chooses a
// money flow (capture / recovery / refund / release), one to three
// participants, a provider behaviour per participant, provider status
// misbehaviour, an injected crash point, lease expiry + reclaim, duplicate
// events, early/stale reconciles, late and duplicate callbacks, random
// interleavings — then drives everything to quiescence and audits all truth
// with the independent oracle.
//
//   LAB_FUZZ_SEED=<n>          fixed seed (default: time-based, printed)
//   LAB_FUZZ_SCENARIOS=<n>     number of scenarios (default 300)
//   LAB_FUZZ_REPLAY=<index>    replay exactly one scenario of the seed
//
// On the first failure the scenario descriptor is printed, persisted under
// .tmp_test_dist/lab_fuzz_failure_<seed>_<index>.json, and greedily MINIMISED
// (each optional ingredient removed while the failure persists) so the
// smallest reproducing schedule is reported with its exact seed/index.
//
// Synthetic money only. Disposable database.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { bootLab, timeout } from "./lab/runtime.js";
import type { Behavior, StatusBehavior } from "./lab/provider_simulator.js";

const SEED = Number(process.env.LAB_FUZZ_SEED || (Date.now() % 2_147_483_647)) >>> 0;
const SCENARIOS = Math.max(1, Number(process.env.LAB_FUZZ_SCENARIOS || 300));
const REPLAY = process.env.LAB_FUZZ_REPLAY !== undefined ? Number(process.env.LAB_FUZZ_REPLAY) : null;
console.log(`FUZZ_SEED=${SEED} scenarios=${SCENARIOS}${REPLAY !== null ? ` replay=${REPLAY}` : ""}`);

const lab = await bootLab({ tag: "fuzz", port: 3158, simulator: { nativeIdempotency: false }, env: { COMPLETION_WINDOW_MINUTES: "0.2" }, outboxMaxAttempts: 5 });

// ── deterministic PRNG (mulberry32), one stream per scenario ─────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function scenarioSeed(index: number) { let h = (SEED ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0; h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0; return (h ^ (h >>> 16)) >>> 0; }
function pick<T>(rnd: () => number, items: readonly T[]): T { return items[Math.floor(rnd() * items.length)] as T; }
function weighted<T>(rnd: () => number, items: ReadonlyArray<[T, number]>): T { const total = items.reduce((s, [, w]) => s + w, 0); let x = rnd() * total; for (const [item, w] of items) { x -= w; if (x <= 0) return item; } return items[items.length - 1]![0]; }

type Flow = "capture" | "recovery" | "refund" | "release";
type Fault = null | "payment.before_provider_io" | "payment.after_provider_io" | "payment.after_state_before_ledger" | "worker.before_ack" | "atomic.after_durable_writes_before_commit";
type Scenario = {
  index: number; seed: number; flow: Flow;
  participants: Array<{ qty: number; delivery: number; behavior: Behavior; status: StatusBehavior[] }>;
  fault: Fault; leaseExpiry: boolean; duplicateEvent: boolean; earlyReconcile: boolean; lateCallbacks: Array<"charge_captured" | "charge_failed" | "refund_issued" | "recovery_captured" | "payment_released">;
  duplicateCallback: boolean;
};

const BEHAVIORS: ReadonlyArray<[Behavior, number]> = [
  [{ kind: "SUCCESS" }, 40], [{ kind: "EFFECT_THEN_503" }, 6], [{ kind: "EFFECT_THEN_429" }, 4], [{ kind: "EFFECT_THEN_408" }, 2], [{ kind: "EFFECT_THEN_TIMEOUT" }, 4],
  [{ kind: "EFFECT_THEN_CONNECTION_RESET" }, 4], [{ kind: "EFFECT_THEN_MALFORMED_2XX" }, 3], [{ kind: "EFFECT_THEN_TRUNCATED_BODY" }, 3], [{ kind: "EFFECT_THEN_RESPONSE_LOST" }, 3],
  [{ kind: "DECLINED" }, 8], [{ kind: "NO_EFFECT_503" }, 5], [{ kind: "DELAYED_EFFECT", delayMs: 90 }, 3], [{ kind: "LATE_SUCCESS", delayMs: 350 }, 2], [{ kind: "HANG_NO_EFFECT" }, 2], [{ kind: "PENDING_NO_EFFECT" }, 2]
];
const STATUS: ReadonlyArray<[StatusBehavior | null, number]> = [[null, 60], [{ kind: "PENDING" }, 8], [{ kind: "STALE_AUTHORIZED", final: false }, 8], [{ kind: "HTTP_500" }, 6], [{ kind: "UNKNOWN" }, 6], [{ kind: "TIMEOUT" }, 4], [{ kind: "MALFORMED" }, 4], [{ kind: "FLAP", states: ["failed", "captured"] }, 4]];
const FAULTS: ReadonlyArray<[Fault, number]> = [[null, 55], ["payment.before_provider_io", 10], ["payment.after_provider_io", 12], ["payment.after_state_before_ledger", 8], ["worker.before_ack", 8], ["atomic.after_durable_writes_before_commit", 7]];

function generate(index: number): Scenario {
  const seed = scenarioSeed(index);
  const rnd = mulberry32(seed);
  const flow = weighted<Flow>(rnd, [["capture", 55], ["recovery", 15], ["refund", 18], ["release", 12]]);
  const n = flow === "capture" ? 1 + Math.floor(rnd() * 3) : 1;
  const participants = Array.from({ length: n }, () => {
    const statusCount = weighted(rnd, [[0, 55], [1, 25], [2, 15], [3, 5]]);
    const status: StatusBehavior[] = [];
    for (let i = 0; i < statusCount; i += 1) { const s = weighted(rnd, STATUS); if (s) status.push(s); }
    return { qty: 1 + Math.floor(rnd() * 4), delivery: pick(rnd, [0, 0, 5, 12.5, 0.01, 30.01]), behavior: weighted(rnd, BEHAVIORS), status };
  });
  const lateCallbacks: Scenario["lateCallbacks"] = [];
  const lateCount = weighted(rnd, [[0, 60], [1, 25], [2, 15]]);
  for (let i = 0; i < lateCount; i += 1) lateCallbacks.push(pick(rnd, ["charge_captured", "charge_failed", "refund_issued", "recovery_captured", "payment_released"] as const));
  return { index, seed, flow, participants, fault: weighted(rnd, FAULTS), leaseExpiry: rnd() < 0.2, duplicateEvent: rnd() < 0.25, earlyReconcile: rnd() < 0.2, lateCallbacks, duplicateCallback: rnd() < 0.15 };
}

const OP: Record<Flow, "capture" | "recover" | "refund" | "release"> = { capture: "capture", recovery: "recover", refund: "refund", release: "release" };

async function execute(sc: Scenario): Promise<{ dealId: string; effects: number }> {
  const specs = sc.participants.map((p) => {
    if (sc.flow === "capture") return { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: p.qty, delivery_cost: p.delivery };
    if (sc.flow === "recovery") return { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", qty: p.qty, delivery_cost: p.delivery, priorAttempts: [{ attempt_type: "charge_start" as const, result_class: "permanent_fail" as const }] };
    if (sc.flow === "refund") return { buyer_state: "DealFailed", money_state: "ChargedSuccess", qty: p.qty, delivery_cost: p.delivery, priorAttempts: [{ attempt_type: "charge_start" as const, result_class: "success" as const }] };
    return { buyer_state: "DealFailed", money_state: "AuthLocked", qty: p.qty, delivery_cost: p.delivery };
  });
  const dealState = sc.flow === "capture" ? "Charging" : sc.flow === "recovery" ? "CompletionWindow" : "Failed";
  const d = await lab.seedDeal({ state: dealState, participants: specs, ...(sc.flow === "recovery" ? { completionWindowUntil: new Date(Date.now() + 5 * 60_000) } : {}) });
  for (const [i, p] of d.participants.entries()) {
    const spec = sc.participants[i]!;
    if (sc.flow === "refund") lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
    lab.sim.script(p.authorization, OP[sc.flow], [spec.behavior]);
    if (spec.status.length) lab.sim.scriptStatus(p.authorization, spec.status);
  }
  const enqueue = async () => {
    if (sc.flow === "capture") return lab.enqueueCharge(d.deal_id);
    if (sc.flow === "recovery") return lab.enqueueRecovery(d.deal_id);
    if (sc.flow === "refund") return lab.enqueueRefund(d.deal_id);
    return lab.enqueueRelease(d.participants[0]!.participant_id, d.deal_id);
  };
  const event = await enqueue();
  if (sc.earlyReconcile) {
    const p = d.participants[0]!;
    await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: sc.flow === "capture" ? "charge_start" : sc.flow === "recovery" ? "recovery" : sc.flow, correlation_id: `${sc.flow}:fuzz-early:n1:${p.participant_id}`, operation: sc.flow === "refund" ? "refund" : sc.flow === "release" ? "release" : "capture", provider_reference: p.authorization, reason: "fuzz-early" });
  }
  if (sc.fault) {
    lab.armTestFault(sc.fault, { kind: "throw", code: `fuzz_${sc.fault}` });
    try { await lab.processOutboxEventById(event); } catch { /* after_claim-style death is not in the fault list; other faults are handled by the worker */ }
    lab.resetTestFaults();
    await lab.retryNow(event);
  }
  if (sc.leaseExpiry) {
    const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
    const run = lab.processOutboxEventById(event).catch(() => null);
    const entered = await Promise.race([barrier.entered.then(() => true), run.then(() => false), timeout(10_000, "fuzz lease scenario never parked")]);
    if (entered) {
      await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [event]);
      await lab.reclaimWorkerJobs(0);
      await lab.processOutboxEventById(event);
      barrier.release();
      await run;
    } else {
      lab.resetTestFaults();
    }
  }
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 60 });
  if (sc.duplicateEvent) { await enqueue().catch(() => undefined); await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 30 }); }
  for (const type of sc.lateCallbacks) {
    const p = d.participants[0]!;
    // A callback is the PROVIDER's word: keep the simulator ledger consistent
    // with what the callback claims (an out-of-band effect the app never
    // requested), so the oracle judges the app against a truthful provider.
    const eff = lab.sim.effectsOf(p.authorization);
    if ((type === "charge_captured" || type === "recovery_captured") && eff.capture + eff.recover === 0) { if (eff.release > 0) continue; lab.sim.forceEffect(type === "charge_captured" ? "capture" : "recover", p.authorization, p.amount_minor); }
    if (type === "refund_issued") { if (eff.capture + eff.recover === 0) continue; if (eff.refund === 0) lab.sim.forceEffect("refund", p.authorization, p.amount_minor); }
    if (type === "payment_released") { if (eff.capture + eff.recover > 0) continue; if (eff.release === 0) lab.sim.forceEffect("release", p.authorization, null); }
    const rows = await lab.attempts(p.participant_id);
    const r = await lab.postWebhook({ event_type: type, provider_reference: p.authorization, participant_id: p.participant_id, deal_id: d.deal_id, correlation_id: rows[0]?.correlation_id ?? null, ...(sc.duplicateCallback ? { event_id: `fuzz-dup-${sc.seed}-${type}` } : {}) });
    assert.ok(r.statusCode < 500, `late callback ${type} answered ${r.statusCode}: ${r.body}`);
    if (sc.duplicateCallback) { const again = await lab.postWebhook({ event_type: type, provider_reference: p.authorization, participant_id: p.participant_id, deal_id: d.deal_id, correlation_id: rows[0]?.correlation_id ?? null, event_id: `fuzz-dup-${sc.seed}-${type}` }); assert.ok(again.statusCode < 500); }
  }
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 30 });
  // Late callbacks that contradict truth (e.g. refund_issued for a captured
  // participant) are DESIGNED to open contradiction cases; provider-side truth
  // still has to be consistent with those cases. Effects counted from the ledger.
  let effects = 0;
  for (const p of d.participants) { const e = lab.sim.effectsOf(p.authorization); effects += e.capture + e.recover + e.refund + e.release; }
  // F-6 is FIXED by the independent review (recovery_failed → Dropped + provider-proofed release rail):
  // AuthReleased without a provider release effect is a hard FALSE_CANONICAL_RELEASE here.
  const allowed = ["PROVIDER_SUCCESS_INVISIBLE", "LOST_PROVIDER_EFFECT", "UNRESOLVED_AT_QUIESCENCE", "FALSE_CANONICAL_REFUND"];
  // A capture that a lying/late provider first declared failed may legitimately end as
  // ChargeFailedRecovery with a case and a captured effect (F-1 keeps it at one effect).
  await lab.oracle(`fuzz:${sc.index}`, [d.deal_id], { allowUnresolved: true, allowedCodes: allowed, print: false });
  // Hard invariants regardless of allowances: never more than one capture-side, one refund, one release per participant.
  for (const p of d.participants) {
    const e = lab.sim.effectsOf(p.authorization);
    assert.ok(e.capture + e.recover <= 1, `DUPLICATE_CAPTURE for ${p.participant_id}: ${JSON.stringify(e)}`);
    assert.ok(e.refund <= 1, `DUPLICATE_REFUND for ${p.participant_id}`);
    assert.ok(e.release <= 1, `DUPLICATE_RELEASE for ${p.participant_id}`);
    assert.ok(!(e.release > 0 && e.capture + e.recover > 0), `RELEASE_AND_CAPTURE for ${p.participant_id}`);
    const keys = lab.sim.distinctKeys(p.authorization, OP[sc.flow]);
    if (keys.length > 1) {
      const rows = await lab.attempts(p.participant_id);
      // The invariant is the state of the previous identity AT DISPATCH TIME: a
      // repeat is legal only after that identity was provider-declared failed.
      // Reading the FINAL state alone would flag an identity that was
      // permanent_fail when the repeat was dispatched and only later converged
      // to success, because a late provider event proved the money had moved
      // after all. That convergence is required elsewhere — it is what blocks a
      // release of money that really moved (FR-3) — and it is identifiable by
      // its late_money_effect note. Same order-awareness as tests/lab/oracle.ts.
      for (let i = 1; i < keys.length; i += 1) {
        const prev = rows.find((r) => r.correlation_id === keys[i - 1]);
        const convergedLate = prev?.result_class === "success" && String(prev?.outcome_note || "").startsWith("late_money_effect:");
        assert.ok(
          prev?.result_class === "permanent_fail" || convergedLate,
          `AUTOMATIC_REPEAT for ${p.participant_id}: ${keys.join("|")} (previous is ${prev?.result_class ?? "absent"} note=${prev?.outcome_note ?? "none"})`
        );
      }
    }
  }
  return { dealId: d.deal_id, effects };
}

function describe(sc: Scenario) { return JSON.stringify({ ...sc, participants: sc.participants.map((p) => ({ ...p, behavior: p.behavior.kind, status: p.status.map((s) => s.kind) })) }); }

async function minimise(sc: Scenario, failure: string): Promise<{ scenario: Scenario; failure: string }> {
  let current = sc; let currentFailure = failure;
  const variants = (s: Scenario): Scenario[] => {
    const out: Scenario[] = [];
    if (s.fault) out.push({ ...s, fault: null });
    if (s.leaseExpiry) out.push({ ...s, leaseExpiry: false });
    if (s.duplicateEvent) out.push({ ...s, duplicateEvent: false });
    if (s.earlyReconcile) out.push({ ...s, earlyReconcile: false });
    if (s.lateCallbacks.length) out.push({ ...s, lateCallbacks: [] });
    if (s.duplicateCallback) out.push({ ...s, duplicateCallback: false });
    if (s.participants.length > 1) out.push({ ...s, participants: s.participants.slice(0, -1) });
    for (const [i, p] of s.participants.entries()) if (p.status.length) out.push({ ...s, participants: s.participants.map((q, j) => (j === i ? { ...q, status: [] } : q)) });
    return out;
  };
  let progress = true;
  while (progress) {
    progress = false;
    for (const candidate of variants(current)) {
      try { await execute(candidate); } catch (error) { current = candidate; currentFailure = String((error as Error)?.message || error); progress = true; break; }
    }
  }
  return { scenario: current, failure: currentFailure };
}

let passed = 0; let failed = 0; let totalEffects = 0; let totalParticipants = 0;
const startedAt = Date.now();
const indices = REPLAY !== null ? [REPLAY] : Array.from({ length: SCENARIOS }, (_, i) => i);
for (const index of indices) {
  const sc = generate(index);
  totalParticipants += sc.participants.length;
  try {
    const r = await execute(sc);
    totalEffects += r.effects;
    passed += 1;
    if (passed % 50 === 0) console.log(`  progress ${passed}/${indices.length} (${Math.round((Date.now() - startedAt) / 1000)}s) effects=${totalEffects}`);
  } catch (error) {
    failed += 1;
    const failure = String((error as Error)?.stack || (error as Error)?.message || error);
    console.error(`FUZZ_FAIL seed=${SEED} index=${index} scenario_seed=${sc.seed}\n  ${describe(sc)}\n  ${failure.split("\n").slice(0, 6).join("\n  ")}`);
    const outDir = path.join(process.cwd(), ".tmp_test_dist");
    try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `lab_fuzz_failure_${SEED}_${index}.json`), JSON.stringify({ seed: SEED, index, scenario: sc, failure }, null, 2)); } catch { /* best effort */ }
    console.log("  minimising…");
    const min = await minimise(sc, failure);
    console.error(`FUZZ_MINIMISED seed=${SEED} index=${index}\n  ${describe(min.scenario)}\n  ${min.failure.split("\n")[0]}`);
    break; // one failure at a time: preserve the exact evidence
  }
}
console.log(`\nSUMMARY payment_lab_random_schedule_fuzz seed=${SEED} scenarios=${indices.length} passed=${passed} failed=${failed} participants=${totalParticipants} provider_effects=${totalEffects} duration_s=${Math.round((Date.now() - startedAt) / 1000)}`);
await lab.close();
process.exit(failed ? 1 : 0);
