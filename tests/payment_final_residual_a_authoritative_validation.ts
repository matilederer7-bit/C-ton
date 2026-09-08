// FINAL FINANCIAL INTEGRATION — RESIDUAL A on a provider whose NEGATIVE
// FINALITY IS DECLARED AUTHORITATIVE (the provider-ready lab contract: a
// negative status proves non-execution of the exact operation).
//
// Rule under test: automatic recovery after a dispatched capture needs BOTH an
// elapsed settlement horizon AND authoritative exact-operation negative
// evidence. On this contract a CONSISTENT, VERIFIED negative beyond the horizon
// is such evidence; anything the answer cannot tie to the exact obligation
// (unknown, unavailable, another reference, another currency) is not.
//
//   AA-1  consistent failed/final beyond the horizon, capture never executed → ONE recovery
//   AA-3  unknown beyond the horizon → held (unverifiable), no recovery
//   AA-4  provider unavailable beyond the horizon → held, no recovery
//   AA-5  wrong-reference negative beyond the horizon → mismatch case, no recovery
//   AA-6  wrong-currency negative beyond the horizon → mismatch case, no recovery
//   AA-2  CONTRACT BOUNDARY (documented): a provider that answers a consistent negative
//         beyond ITS OWN declared horizon and then settles is in breach of the contract
//         it declared authoritative; the system recovers exactly once after the horizon
//         (never before) and the oracle reports the provider's late effect as a double.
//   AA-7  CONTRACT BOUNDARY (documented): stale cached final status beyond the horizon.
//
// Synthetic money only.

import { strict as assert } from "node:assert";
import { bootLab, makeRunner, sleep } from "./lab/runtime.js";
import { auditFinancialTruth } from "./lab/oracle.js";

const HORIZON_MS = 700;
const lab = await bootLab({
  tag: "residual-a-auth",
  port: 3167,
  simulator: { nativeIdempotency: false },
  env: { COMPLETION_WINDOW_MINUTES: "1", PAYMENT_SETTLEMENT_HORIZON_MS: String(HORIZON_MS) },
  outboxMaxAttempts: 4
});
const { run, summary } = makeRunner("payment_final_residual_a_authoritative");
const skipFinalize = (e: { event_type: string }) => e.event_type === "finalize_deal";
const casesOf = async (pid: string) => (await lab.cases(pid)).map((c) => c.auto_key.split(":")[0]);

async function seedCharging() {
  const d = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  return { d, p: d.participants[0]! };
}
async function driveBeyondHorizon(dealId: string) {
  await lab.drain({ dealIds: [dealId], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  await sleep(HORIZON_MS + 200);
  await lab.drain({ dealIds: [dealId], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
}
function recoverRequestsBefore(auth: string, instant: number) {
  return lab.sim.requestsOf(auth, "recover").filter((r) => new Date(r.at).getTime() < instant).length;
}

// ── AA-1 ───────────────────────────────────────────────────────────────────────
await run("AA-1 consistent failed/final beyond the horizon, capture never executed → recovery exactly once, only after the horizon", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "NO_EFFECT_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "FLAP", states: ["failed"] }]);
  const dispatchedAt = Date.now();
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  const eff = lab.sim.effectsOf(p.authorization);
  const horizonAt = dispatchedAt + HORIZON_MS;
  console.log(`  AA-1: effects=${JSON.stringify(eff)} recover_before_horizon=${recoverRequestsBefore(p.authorization, horizonAt)} state=${(await lab.participant(p.participant_id)).money_state}`);
  assert.equal(recoverRequestsBefore(p.authorization, horizonAt), 0, "no recovery before the horizon");
  assert.equal(eff.recover, 1, "one recovery on authoritative negative evidence after the horizon");
  assert.equal(eff.capture, 0);
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  lab.sim.clearStatusScript(p.authorization);
  await lab.oracle("AA-1", [d.deal_id]);
});

// ── AA-3 / AA-4 ────────────────────────────────────────────────────────────────
for (const [label, script] of [["AA-3 unknown", [{ kind: "UNKNOWN" as const, persist: true }]], ["AA-4 provider unavailable (500)", [{ kind: "HTTP_500" as const, persist: true }]]] as const) {
  await run(`${label} beyond the horizon → held (unverifiable), no recovery, no rotation, case`, async () => {
    const { d, p } = await seedCharging();
    lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
    lab.sim.scriptStatus(p.authorization, [...script]);
    await lab.enqueueCharge(d.deal_id);
    await driveBeyondHorizon(d.deal_id);
    const eff = lab.sim.effectsOf(p.authorization);
    const rows = await lab.attempts(p.participant_id);
    console.log(`  ${label}: effects=${JSON.stringify(eff)} identities=${rows.map((r) => `${r.attempt_type}=${r.result_class}`).join(",")} cases=${(await casesOf(p.participant_id)).join(",")}`);
    assert.equal(eff.recover, 0);
    assert.equal(rows.filter((r) => r.attempt_type === "charge_start").length, 1, "no identity rotation");
    assert.ok((await casesOf(p.participant_id)).length > 0, "unresolved without a case");
    lab.sim.clearStatusScript(p.authorization);
    await lab.oracle(label, [d.deal_id], { allowUnresolved: true, allowedCodes: ["PROVIDER_SUCCESS_INVISIBLE"] });
  });
}

// ── AA-5 / AA-6 ────────────────────────────────────────────────────────────────
await run("AA-5 wrong-reference negative beyond the horizon → reference mismatch case, no verdict from it, no recovery", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "NO_EFFECT_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_REFERENCE", persist: true }]);
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  const eff = lab.sim.effectsOf(p.authorization);
  const cases = await casesOf(p.participant_id);
  console.log(`  AA-5: effects=${JSON.stringify(eff)} cases=${cases.join(",")} identities=${(await lab.attempts(p.participant_id)).map((r) => `${r.attempt_type}=${r.result_class}`).join(",")}`);
  assert.equal(eff.recover, 0, "a status answer naming another reference authorised a recovery");
  assert.ok(cases.includes("payment-reconcile-reference-mismatch") || cases.includes("payment-recovery-preflight-mismatch"), `expected a reference-mismatch case, got ${cases.join(",")}`);
  // once the provider names the right reference, the authoritative negative lets exactly one recovery run
  lab.sim.clearStatusScript(p.authorization);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1, "one recovery after a verifiable negative");
  await lab.oracle("AA-5", [d.deal_id], { allowUnresolved: true });
});

await run("AA-6 wrong-currency negative beyond the horizon → currency mismatch case, no recovery", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "NO_EFFECT_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WRONG_CURRENCY", currency: "USD", persist: true }]);
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  const eff = lab.sim.effectsOf(p.authorization);
  const cases = await casesOf(p.participant_id);
  console.log(`  AA-6: effects=${JSON.stringify(eff)} cases=${cases.join(",")}`);
  assert.equal(eff.recover, 0, "a status answer in another currency authorised a recovery");
  assert.ok(cases.includes("payment-reconcile-currency-mismatch") || cases.includes("payment-recovery-preflight-mismatch"), `expected a currency-mismatch case, got ${cases.join(",")}`);
  lab.sim.clearStatusScript(p.authorization);
  await lab.oracle("AA-6", [d.deal_id], { allowUnresolved: true });
});

// ── AA-2 / AA-7 — contract boundary ─────────────────────────────────────────────
await run("AA-2 CONTRACT BOUNDARY: consistent failed/final beyond the provider's OWN declared horizon, then a late settlement — no recovery before the horizon; the breach is oracle-visible", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "DELAYED_EFFECT", delayMs: HORIZON_MS + 500 }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "WHILE_SETTLING", state: "failed", final: true }]);
  const dispatchedAt = Date.now();
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  await sleep(700);
  await lab.drain({ dealIds: [d.deal_id], skip: skipFinalize, maxRounds: 40, waitDeferredUpToMs: 3_000 });
  const eff = lab.sim.effectsOf(p.authorization);
  const report = await auditFinancialTruth(lab.pool, { label: "AA-2", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  console.log(`  AA-2 BOUNDARY: effects=${JSON.stringify(eff)} recover_before_horizon=${recoverRequestsBefore(p.authorization, dispatchedAt + HORIZON_MS)} oracle=${report.violations.map((v) => v.code).join(",") || "clean"}`);
  assert.equal(recoverRequestsBefore(p.authorization, dispatchedAt + HORIZON_MS), 0, "never before the horizon");
  assert.ok(eff.recover <= 1, "at most one recovery");
  if (eff.capture + eff.recover > 1) assert.ok(report.violations.some((v) => v.code === "DUPLICATE_CAPTURE"), "the provider's breach must be visible to the oracle");
});

await run("AA-7 CONTRACT BOUNDARY: stale cached authorized/final beyond the horizon after an EXECUTED capture — no recovery before the horizon; a breach is oracle-visible", async () => {
  const { d, p } = await seedCharging();
  lab.sim.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_503" }]);
  lab.sim.scriptStatus(p.authorization, [{ kind: "STALE_AUTHORIZED", final: true, persist: true }]);
  const dispatchedAt = Date.now();
  await lab.enqueueCharge(d.deal_id);
  await driveBeyondHorizon(d.deal_id);
  const eff = lab.sim.effectsOf(p.authorization);
  const report = await auditFinancialTruth(lab.pool, { label: "AA-7", dealIds: [d.deal_id], provider: () => lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  console.log(`  AA-7 BOUNDARY: effects=${JSON.stringify(eff)} recover_before_horizon=${recoverRequestsBefore(p.authorization, dispatchedAt + HORIZON_MS)} oracle=${report.violations.map((v) => v.code).join(",") || "clean"}`);
  assert.equal(recoverRequestsBefore(p.authorization, dispatchedAt + HORIZON_MS), 0, "never before the horizon");
  if (eff.capture + eff.recover > 1) assert.ok(report.violations.some((v) => v.code === "DUPLICATE_CAPTURE"), "the provider's breach must be visible to the oracle");
  lab.sim.clearStatusScript(p.authorization);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
