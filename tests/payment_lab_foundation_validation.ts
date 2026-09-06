// FINANCIAL TORTURE LAB — foundation: provider simulator contract + oracle
// anti-vacuity (Phases 3 and 4 of the synthetic money war room).
//
// Before any torture matrix is trusted, this suite proves the instruments:
//   1. every scripted provider behaviour drives the REAL capture rail to the
//      outcome the adapter contract promises (declared success, declared
//      failure, or UNKNOWN on the same identity resolved by reconciliation)
//      and the simulator's economic counters record exactly what moved;
//   2. the counters are the provider's private truth: a same-identity replay
//      never moves money on an idempotent provider and DOES on a provider
//      without native idempotency (so later suites can prove Siton never sends
//      that second request at all);
//   3. the oracle is not vacuous: planted corruptions of provider truth
//      (duplicate effect, effect the app never saw, a fresh identity while the
//      prior one is unknown) and of ledger truth are each reported.
//
// Synthetic money only. Disposable database. No real provider.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner } from "./lab/runtime.js";
import { startProviderSimulator, type Behavior } from "./lab/provider_simulator.js";
import { auditFinancialTruth, oracleEconomics } from "./lab/oracle.js";

// A 6-second completion window: long enough for every same-drain recovery,
// short enough to finalize inside this suite (the window is immutable once set).
const lab = await bootLab({ tag: "foundation", port: 3151, env: { COMPLETION_WINDOW_MINUTES: "0.1" } });
const { run, summary } = makeRunner("payment_lab_foundation");

type Expect = { money_state: string; effects: number; attempt: string; recovered?: boolean };
const CAPTURE_BEHAVIORS: Array<{ behavior: Behavior; expect: Expect; note: string }> = [
  { behavior: { kind: "SUCCESS" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "declared success" },
  { behavior: { kind: "DECLINED" }, expect: { money_state: "RecoveredCharge", effects: 1, attempt: "permanent_fail", recovered: true }, note: "declared failure → recovery captures once" },
  { behavior: { kind: "NO_EFFECT_503" }, expect: { money_state: "RecoveredCharge", effects: 1, attempt: "permanent_fail", recovered: true }, note: "503 before any effect → UNKNOWN → status proves not executed → recovery captures once" },
  { behavior: { kind: "EFFECT_THEN_503" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then 503 → UNKNOWN → reconciled as captured" },
  { behavior: { kind: "EFFECT_THEN_429" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then 429" },
  { behavior: { kind: "EFFECT_THEN_408" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then 408" },
  { behavior: { kind: "EFFECT_THEN_TIMEOUT" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then client timeout" },
  { behavior: { kind: "EFFECT_THEN_CONNECTION_RESET" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then connection reset" },
  { behavior: { kind: "EFFECT_THEN_MALFORMED_2XX" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then malformed 2xx" },
  { behavior: { kind: "EFFECT_THEN_TRUNCATED_BODY" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then truncated body" },
  { behavior: { kind: "EFFECT_THEN_RESPONSE_LOST" }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "effect then response lost" },
  { behavior: { kind: "DELAYED_EFFECT", delayMs: 100 }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "200 pending, effect lands later, status pending until then" },
  { behavior: { kind: "LATE_SUCCESS", delayMs: 400 }, expect: { money_state: "ChargedSuccess", effects: 1, attempt: "success" }, note: "client times out, effect lands after, status pending until then" },
  { behavior: { kind: "HANG_NO_EFFECT" }, expect: { money_state: "RecoveredCharge", effects: 1, attempt: "permanent_fail", recovered: true }, note: "timeout with no effect → UNKNOWN → not executed → recovery captures once" },
  { behavior: { kind: "PENDING_NO_EFFECT" }, expect: { money_state: "RecoveredCharge", effects: 1, attempt: "permanent_fail", recovered: true }, note: "200 pending, nothing ever lands → not executed → recovery captures once" }
];

const seededDeals: string[] = [];

for (const { behavior, expect, note } of CAPTURE_BEHAVIORS) {
  await run(`simulator contract: capture behaviour ${behavior.kind} — ${note}`, async () => {
    const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 2, delivery_cost: 5 }] });
    seededDeals.push(deal.deal_id);
    const p = deal.participants[0]!;
    lab.sim.script(p.authorization, "capture", [behavior]);
    await lab.enqueueCharge(deal.deal_id);
    // finalize_deal is enqueued for the end of the completion window; do not
    // finalize here — this suite proves the capture rail, not completion.
    const stats = await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
    const after = await lab.participant(p.participant_id);
    const eff = lab.sim.effectsOf(p.authorization);
    const captureAttempts = await lab.attempts(p.participant_id, "charge_start");
    console.log(`  ${behavior.kind}: money_state=${after.money_state} effects=${JSON.stringify({ capture: eff.capture, recover: eff.recover })} attempts=${captureAttempts.map((a) => `${a.result_class}/${a.dispatch_state}`).join(",")} drain=${stats.processed}p/${stats.advanced}a`);
    assert.equal(after.money_state, expect.money_state, `money_state after ${behavior.kind}`);
    assert.equal(eff.capture + eff.recover, expect.effects, `total capture-side effects after ${behavior.kind}`);
    assert.equal(captureAttempts.length, 1, `exactly one capture identity after ${behavior.kind}: ${JSON.stringify(captureAttempts)}`);
    assert.equal(captureAttempts[0]!.result_class, expect.attempt, `capture identity outcome after ${behavior.kind}`);
    assert.equal(lab.sim.distinctKeys(p.authorization, "capture").length, 1, "the provider saw exactly one capture identity");
    if (expect.recovered) {
      assert.equal(eff.recover, 1, "recovery moved money exactly once");
      assert.equal(eff.capture, 0, "the original capture never moved money");
    }
    await lab.oracle(`foundation:${behavior.kind}`, [deal.deal_id]);
  });
}

await run("the finalize path completes a converged deal and the oracle stays clean end-to-end", async () => {
  const deal = await lab.seedDeal({ state: "Charging", threshold_units: 2, participants: [
    { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 1 },
    { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 1, delivery_cost: 12.5 }
  ] });
  seededDeals.push(deal.deal_id);
  await lab.enqueueCharge(deal.deal_id);
  await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const window = await lab.deal(deal.deal_id);
  assert.ok(window.completion_window_until, "the charge rail must have opened the completion window");
  // completion_window_until is immutable once set (DB trigger); wait it out.
  const waitMs = Math.max(0, new Date(window.completion_window_until!).getTime() - Date.now()) + 300;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await lab.drain({ dealIds: [deal.deal_id] });
  const state = await lab.deal(deal.deal_id);
  assert.equal(state.state, "Completed");
  for (const p of deal.participants) assert.equal((await lab.participant(p.participant_id)).buyer_state, "DealCompleted");
  const report = await lab.oracle("foundation:finalize", [deal.deal_id]);
  assert.equal(report.counts.canonical_charged, 2);
  assert.equal(report.counts.ledger_entries, 2);
  assert.equal(report.totals.TOTAL_PLATFORM_FEES_MINOR, report.totals.LEDGER_FEES_MINOR);
});

await run("economic counters are the provider's private truth: idempotent replay moves nothing, a non-idempotent provider moves money twice", async () => {
  const idem = startProviderSimulator({ nativeIdempotency: true });
  const naive = startProviderSimulator({ nativeIdempotency: false });
  const [idemUrl, naiveUrl] = await Promise.all([idem.ready, naive.ready]);
  const body = JSON.stringify({ authorization_id: "auth-counter-probe", amount_minor: 4200, currency: "ILS", reference: "k1" });
  const headers = { "content-type": "application/json", authorization: "Bearer x", "idempotency-key": "k1" };
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await fetch(`${idemUrl}/capture`, { method: "POST", headers, body })).status, 200);
    assert.equal((await fetch(`${naiveUrl}/capture`, { method: "POST", headers, body })).status, 200);
  }
  assert.equal(idem.effectsOf("auth-counter-probe").capture, 1, "idempotent provider: one effect for three identical requests");
  assert.equal(naive.effectsOf("auth-counter-probe").capture, 3, "non-idempotent provider: three effects for three identical requests");
  assert.equal(idem.requestsOf("auth-counter-probe", "capture").filter((r) => r.replayed).length, 2, "replays are recorded as replays");
  const snapshot = idem.snapshot();
  (snapshot.effects["auth-counter-probe"] as any).capture = 0; // a caller mutating a snapshot changes nothing
  assert.equal(idem.effectsOf("auth-counter-probe").capture, 1, "snapshots are copies; the ledger cannot be reset from outside");
  await idem.close(); await naive.close();
});

await run("oracle anti-vacuity: a duplicate provider effect is reported as DUPLICATE_CAPTURE", async () => {
  const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = deal.participants[0]!;
  await lab.enqueueCharge(deal.deal_id);
  await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  await lab.oracle("vacuity:clean-before-plant", [deal.deal_id]);
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor); // money moved a second time, app never asked
  const report = await auditFinancialTruth(lab.pool, { label: "vacuity:duplicate", dealIds: [deal.deal_id], provider: lab.sim.snapshot(), vat: lab.vat });
  assert.ok(report.violations.some((x) => x.code === "DUPLICATE_CAPTURE"), `expected DUPLICATE_CAPTURE, got ${JSON.stringify(report.violations)}`);
});

await run("oracle anti-vacuity: a provider effect the application never learned about is reported (LOST_PROVIDER_EFFECT / PROVIDER_SUCCESS_INVISIBLE)", async () => {
  const deal = await lab.seedDeal({ state: "ClosedForJoining", participants: [{ buyer_state: "LockedIn", money_state: "AuthLocked" }] });
  const p = deal.participants[0]!;
  await lab.oracle("vacuity:clean-locked", [deal.deal_id]);
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  const report = await auditFinancialTruth(lab.pool, { label: "vacuity:lost", dealIds: [deal.deal_id], provider: lab.sim.snapshot(), vat: lab.vat });
  const codes = report.violations.map((x) => x.code);
  assert.ok(codes.includes("LOST_PROVIDER_EFFECT") && codes.includes("PROVIDER_SUCCESS_INVISIBLE"), `expected lost/invisible effect, got ${JSON.stringify(report.violations)}`);
});

await run("oracle anti-vacuity: a fresh identity reaching the provider while the prior one is UNKNOWN is reported (AUTOMATIC_REPEAT_WHILE_UNKNOWN)", async () => {
  const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", priorAttempts: [{ attempt_type: "charge_start", result_class: "unknown", correlation_id: "capture:lab-prior:n1:unknown-probe" }] }] });
  const p = deal.participants[0]!;
  // Simulate what a broken rail would do: a NEW key for the same authorization.
  const body = JSON.stringify({ authorization_id: p.authorization, amount_minor: p.amount_minor, currency: "ILS", reference: "capture:lab-prior:n1:unknown-probe" });
  const base = process.env.PAYMENT_PROVIDER_BASE_URL!;
  await fetch(`${base}/capture`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x", "idempotency-key": "capture:lab-prior:n1:unknown-probe" }, body: body });
  await fetch(`${base}/capture`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x", "idempotency-key": "capture:lab-prior:n2:unknown-probe" }, body: body.replace("n1", "n2") });
  const report = await auditFinancialTruth(lab.pool, { label: "vacuity:repeat", dealIds: [deal.deal_id], provider: lab.sim.snapshot(), vat: lab.vat, allowUnresolved: true });
  const codes = report.violations.map((x) => x.code);
  assert.ok(codes.includes("AUTOMATIC_REPEAT_WHILE_UNKNOWN"), `expected AUTOMATIC_REPEAT_WHILE_UNKNOWN, got ${JSON.stringify(report.violations)}`);
  assert.ok(codes.includes("DUPLICATE_CAPTURE"), "two identities moved money twice — also a duplicate");
});

await run("oracle anti-vacuity: a wrong ledger amount / fee rate / missing entry is reported", async () => {
  const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 3, delivery_cost: 7.3 }] });
  const p = deal.participants[0]!;
  await lab.enqueueCharge(deal.deal_id);
  await lab.drain({ dealIds: [deal.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  await lab.oracle("vacuity:ledger-clean", [deal.deal_id]);
  const econ = oracleEconomics({ qty: 3, price_per_unit: deal.price_per_unit, delivery_cost: 7.3 }, lab.vat);
  const before = await lab.ledger(p.participant_id);
  assert.equal(before.length, 1);
  assert.equal(Math.round(Number(before[0]!.platform_fee_amount) * 100), econ.feeTotal, "sanity: the production ledger agrees with the oracle on a clean run");

  const attempt = async (sql: string, params: unknown[]) => {
    try { await lab.pool.query(sql, params); return true; } catch (error: any) { console.log(`  DB refused direct ledger mutation: ${String(error?.message || error).slice(0, 120)}`); return false; }
  };
  const mutated = await attempt(`UPDATE siton.platform_fee_money_events SET platform_fee_amount = platform_fee_amount + 0.01 WHERE participant_id=$1`, [p.participant_id]);
  if (mutated) {
    const r1 = await auditFinancialTruth(lab.pool, { label: "vacuity:fee-amount", dealIds: [deal.deal_id], provider: lab.sim.snapshot(), vat: lab.vat });
    assert.ok(r1.violations.some((x) => x.code === "LEDGER_AMOUNT_MISMATCH"), `expected LEDGER_AMOUNT_MISMATCH, got ${JSON.stringify(r1.violations)}`);
    await attempt(`UPDATE siton.platform_fee_money_events SET platform_fee_amount = platform_fee_amount - 0.01 WHERE participant_id=$1`, [p.participant_id]);
  }
  const rated = await attempt(`UPDATE siton.platform_fee_money_events SET platform_fee_rate = 0.07 WHERE participant_id=$1`, [p.participant_id]);
  if (rated) {
    const r2 = await auditFinancialTruth(lab.pool, { label: "vacuity:fee-rate", dealIds: [deal.deal_id], provider: lab.sim.snapshot(), vat: lab.vat });
    assert.ok(r2.violations.some((x) => x.code === "FEE_RATE_NOT_8_PERCENT"), `expected FEE_RATE_NOT_8_PERCENT, got ${JSON.stringify(r2.violations)}`);
    await attempt(`UPDATE siton.platform_fee_money_events SET platform_fee_rate = 0.08 WHERE participant_id=$1`, [p.participant_id]);
  }
  const deleted = await attempt(`DELETE FROM siton.platform_fee_money_events WHERE participant_id=$1`, [p.participant_id]);
  if (deleted) {
    const r3 = await auditFinancialTruth(lab.pool, { label: "vacuity:missing-entry", dealIds: [deal.deal_id], provider: lab.sim.snapshot(), vat: lab.vat });
    assert.ok(r3.violations.some((x) => x.code === "LEDGER_CHARGE_ENTRY_COUNT"), `expected LEDGER_CHARGE_ENTRY_COUNT, got ${JSON.stringify(r3.violations)}`);
  }
  assert.ok(mutated || rated || deleted, "no ledger corruption vector could be planted; the anti-vacuity check for the ledger is itself vacuous");
});

await run("oracle anti-vacuity: canonical success without provider success is reported (FALSE_CANONICAL_SUCCESS)", async () => {
  // Seed a participant that CLAIMS to be charged while the provider never captured.
  const deal = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 60_000), participants: [{ buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" }] });
  const report = await auditFinancialTruth(lab.pool, { label: "vacuity:false-success", dealIds: [deal.deal_id], provider: lab.sim.snapshot(), vat: lab.vat });
  const codes = report.violations.map((x) => x.code);
  assert.ok(codes.includes("FALSE_CANONICAL_SUCCESS"), `expected FALSE_CANONICAL_SUCCESS, got ${JSON.stringify(report.violations)}`);
  assert.ok(codes.includes("LEDGER_CHARGE_ENTRY_COUNT"), "a charged participant without a ledger entry is also a ledger violation");
});

await run("signed synthetic webhooks are accepted; a bad signature or a stale timestamp is refused", async () => {
  const deal = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = deal.participants[0]!;
  const bad = await lab.postWebhook({ event_type: "charge_captured", provider_reference: p.authorization, participant_id: p.participant_id, deal_id: deal.deal_id, badSignature: true });
  assert.equal(bad.statusCode, 401, bad.body);
  const stale = await lab.postWebhook({ event_type: "charge_captured", provider_reference: p.authorization, participant_id: p.participant_id, deal_id: deal.deal_id, timestampSkewSeconds: -3600 });
  assert.equal(stale.statusCode, 401, stale.body);
  // A well-signed capture callback for a participant the provider really captured.
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  const ok = await lab.postWebhook({ event_type: "charge_captured", provider_reference: p.authorization, participant_id: p.participant_id, deal_id: deal.deal_id, correlation_id: `capture:lab-webhook:n1:${p.participant_id}` });
  assert.ok(ok.statusCode >= 200 && ok.statusCode < 300, `${ok.statusCode} ${ok.body}`);
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  await lab.oracle("foundation:webhook", [deal.deal_id]);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
