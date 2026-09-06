// FINANCIAL TORTURE LAB — Phase 16 (terminal-state attacks) and Phase 17
// (money / rounding / economics fuzz).
//
// Phase 16: after Completed / Failed / Cancelled / Refunded / AuthReleased /
// RecoveredCharge, every plausible late provider event is delivered (signed
// webhooks and status answers): duplicates, out-of-order events, wrong or
// missing references, contradictions. Late economically-real truth must never
// be discarded silently; when provider and local truth conflict an explicit
// operational case must exist.
//
// Phase 17: integer-agorot economics under an EXPLICIT VAT policy (17 % product,
// 17 % delivery; platform fee VAT 18 %): minimum amounts, 1 agora, odd agorot,
// delivery 0 / delivery > item, large amounts and quantities, many participants,
// threshold boundaries. The production ledger must agree with the oracle's
// independent computation of exactly 8 % of (gross incl. delivery − buyer VAT)
// with distributor share 0 — on every row.
//
// Synthetic money only. Disposable database.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { bootLab, makeRunner } from "./lab/runtime.js";
import { oracleEconomics } from "./lab/oracle.js";

const lab = await bootLab({
  tag: "terminal-econ", port: 3157, outboxMaxAttempts: 4,
  env: { COMPLETION_WINDOW_MINUTES: "0.1", SITON_VAT_MODE: "explicit", SITON_VAT_RATE_PRODUCT: "0.17", SITON_VAT_RATE_DELIVERY: "0.17", SITON_PLATFORM_FEE_VAT_RATE: "0.18" }
});
const { run, summary } = makeRunner("payment_lab_terminal_economics");

async function converged(qty = 1, delivery = 0, price = 42) {
  const d = await lab.seedDeal({ state: "Charging", price_per_unit: price, participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty, delivery_cost: delivery }] });
  const p = d.participants[0]!;
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
  return { d, p };
}
async function snapshot(pid: string) {
  const s = await lab.participant(pid);
  const audits = await lab.moneyAudits(pid);
  const ledger = await lab.ledger(pid);
  return { money_state: s.money_state, buyer_state: s.buyer_state, audits: audits.length, ledger: ledger.length };
}

// ── Phase 16 ─────────────────────────────────────────────────────────────────

await run("terminal ChargedSuccess: duplicate, out-of-order and stale callbacks change nothing; duplicates are recognised as duplicates", async () => {
  const { d, p } = await converged(2, 5);
  const before = await snapshot(p.participant_id);
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  const evt = `lab-dup-${randomUUID()}`;
  const first = await lab.postWebhook({ event_type: "charge_captured", event_id: evt, provider_reference: p.authorization, correlation_id: row.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  const second = await lab.postWebhook({ event_type: "charge_captured", event_id: evt, provider_reference: p.authorization, correlation_id: row.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.ok(first.statusCode < 300 && second.statusCode < 300, `${first.statusCode} ${second.statusCode}`);
  assert.match(second.body, /duplicate/i, `the second delivery of one event id must be recognised as a duplicate: ${second.body}`);
  // out of order: an authorization event and a failure event AFTER success
  for (const type of ["payment_authorized", "charge_failed", "recovery_failed"]) {
    const r = await lab.postWebhook({ event_type: type, provider_reference: p.authorization, correlation_id: row.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
    assert.ok(r.statusCode < 500, `${type}: ${r.statusCode} ${r.body}`);
  }
  assert.deepEqual(await snapshot(p.participant_id), before, "a terminal captured participant must not move on stale/out-of-order events");
  await lab.oracle("terminal:charged-stale-callbacks", [d.deal_id]);
});

await run("terminal Refunded: a late 'charge_captured' or second 'refund_issued' changes nothing; provider truth stays one capture + one refund", async () => {
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "ChargedSuccess", qty: 1, delivery_cost: 9.99, priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }] });
  const p = d.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  await lab.enqueueRefund(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "Refunded");
  const before = await snapshot(p.participant_id);
  const refundRow = (await lab.attempts(p.participant_id, "refund"))[0]!;
  for (const type of ["refund_issued", "charge_captured", "recovery_captured"]) {
    const r = await lab.postWebhook({ event_type: type, provider_reference: p.authorization, correlation_id: refundRow.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
    assert.ok(r.statusCode < 500, `${type}: ${r.statusCode} ${r.body}`);
  }
  await lab.enqueueRefund(d.deal_id, "late");
  await lab.drain({ dealIds: [d.deal_id] });
  assert.deepEqual(await snapshot(p.participant_id), before);
  assert.equal(lab.sim.effectsOf(p.authorization).refund, 1);
  await lab.oracle("terminal:refunded-late", [d.deal_id]);
});

await run("terminal AuthReleased: late 'charge_captured' for a released hold is a CONTRADICTION → operational case, no state guess, no automatic recovery/refund", async () => {
  const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] });
  const p = d.participants[0]!;
  await lab.enqueueRelease(p.participant_id, d.deal_id);
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased");
  // the provider now claims the released hold was captured (economically real on its side)
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  const r = await lab.postWebhook({ event_type: "charge_captured", provider_reference: p.authorization, participant_id: p.participant_id, deal_id: d.deal_id, correlation_id: `capture:late:n1:${p.participant_id}` });
  assert.ok(r.statusCode < 500, r.body);
  assert.equal((await lab.participant(p.participant_id)).money_state, "AuthReleased", "local terminal state must not be flipped by a contradicting late event");
  const cases = await lab.cases(p.participant_id);
  assert.ok(cases.some((c) => c.auto_key.startsWith("payment-late-money-effect")), `a late-money-effect case must be visible: ${JSON.stringify(cases)}`);
  await lab.oracle("terminal:released-then-captured", [d.deal_id], { allowedCodes: ["RELEASE_OF_CAPTURED_MONEY", "PROVIDER_SUCCESS_INVISIBLE", "LOST_PROVIDER_EFFECT"] });
});

await run("terminal Completed deal: late refund/failure events for a DealCompleted participant are ignored or cased, never applied; late 'refund_issued' for a captured participant is a contradiction case", async () => {
  const d = await lab.seedDeal({ state: "Charging", threshold_units: 1, participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const window = await lab.deal(d.deal_id);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, new Date(window.completion_window_until!).getTime() - Date.now()) + 300));
  await lab.drain({ dealIds: [d.deal_id] });
  assert.equal((await lab.deal(d.deal_id)).state, "Completed");
  assert.equal((await lab.participant(p.participant_id)).buyer_state, "DealCompleted");
  const before = await snapshot(p.participant_id);
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  const late = await lab.postWebhook({ event_type: "refund_issued", provider_reference: p.authorization, correlation_id: row.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.ok(late.statusCode < 500, late.body);
  const after = await snapshot(p.participant_id);
  console.log(`  completed deal, late refund_issued: before=${JSON.stringify(before)} after=${JSON.stringify(after)} cases=${(await lab.cases(p.participant_id)).map((c) => c.auto_key.split(":")[0]).join(",")}`);
  assert.ok(["ChargedSuccess", "Refunded"].includes(after.money_state));
  if (after.money_state === "ChargedSuccess") {
    // the provider said refunded while we hold captured money: contradiction must be visible
    assert.ok((await lab.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-late-money-effect")), "refund claimed by the provider but not applied must open a case");
  }
  await lab.oracle("terminal:completed-late-refund", [d.deal_id], { allowedCodes: ["FALSE_CANONICAL_REFUND", "PROVIDER_SUCCESS_INVISIBLE", "LOST_PROVIDER_EFFECT"] });
});

await run("terminal Cancelled draft: cancel_refund finds no money, late money events for a participant-less deal are rejected without a crash", async () => {
  const d = await lab.seedDeal({ state: "Cancelled", participants: [] });
  await lab.enqueue("cancel_refund", "deal", d.deal_id, { deal_id: d.deal_id });
  const stats = await lab.drain({ dealIds: [d.deal_id] });
  assert.ok(stats.results.every((r) => r.status === "sent"), JSON.stringify(stats.results));
  const r = await lab.postWebhook({ event_type: "charge_captured", provider_reference: `auth-${randomUUID().slice(0, 8)}`, deal_id: d.deal_id, participant_id: null });
  assert.ok(r.statusCode < 500, r.body);
  await lab.oracle("terminal:cancelled-draft", [d.deal_id]);
});

await run("terminal RecoveredCharge: wrong-reference and missing-reference callbacks never move money; a duplicate 'recovery_captured' is a duplicate", async () => {
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 5 * 60_000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] }] });
  const p = d.participants[0]!;
  await lab.enqueueRecovery(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await lab.participant(p.participant_id)).money_state, "RecoveredCharge");
  const before = await snapshot(p.participant_id);
  const wrong = await lab.postWebhook({ event_type: "recovery_captured", provider_reference: `other-${randomUUID().slice(0, 8)}`, participant_id: p.participant_id, deal_id: d.deal_id });
  const missing = await lab.postWebhook({ event_type: "recovery_captured", provider_reference: null, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.ok(wrong.statusCode < 500 && missing.statusCode < 500);
  assert.deepEqual(await snapshot(p.participant_id), before);
  assert.equal(lab.sim.effectsOf(p.authorization).recover, 1);
  await lab.oracle("terminal:recovered-late", [d.deal_id]);
});

// ── Phase 17: economics ──────────────────────────────────────────────────────

const ECON_CASES: Array<{ label: string; price: number; qty: number; delivery: number }> = [
  { label: "minimum: 1 agora item, no delivery", price: 0.01, qty: 1, delivery: 0 },
  { label: "odd agorot: 0.07 × 3", price: 0.07, qty: 3, delivery: 0 },
  { label: "1 agora item + 1 agora delivery", price: 0.01, qty: 1, delivery: 0.01 },
  { label: "delivery greater than the item", price: 5, qty: 1, delivery: 49.9 },
  { label: "typical: 42 × 2 + 12.5 delivery", price: 42, qty: 2, delivery: 12.5 },
  { label: "odd rounding: 33.33 × 3 + 0.03", price: 33.33, qty: 3, delivery: 0.03 },
  { label: "large legal amount: 4999.99 × 20", price: 4999.99, qty: 20, delivery: 149.99 },
  { label: "large quantity: 0.99 × 500", price: 0.99, qty: 500, delivery: 0 },
  { label: "prime agorot: 0.13 × 7 + 0.11", price: 0.13, qty: 7, delivery: 0.11 }
];

for (const c of ECON_CASES) {
  await run(`economics: ${c.label} → ledger equals the oracle's 8 % of (gross incl. delivery − 17 % buyer VAT), distributor 0`, async () => {
    const { d, p } = await converged(c.qty, c.delivery, c.price);
    const econ = oracleEconomics({ qty: c.qty, price_per_unit: c.price, delivery_cost: c.delivery }, lab.vat);
    const entry = (await lab.pool.query(`SELECT * FROM siton.platform_fee_money_events WHERE participant_id=$1`, [p.participant_id])).rows[0];
    assert.ok(entry, "ledger entry");
    const m = (v: unknown) => Math.round(Number(v) * 100);
    console.log(`  gross=${econ.gross} vat=${econ.buyerVat} base=${econ.feeBase} fee=${econ.fee} feeVat=${econ.feeVat} net=${econ.sellerNet} | ledger fee=${m(entry.platform_fee_base_amount)} total=${m(entry.platform_fee_total_amount)} net=${m(entry.seller_net_amount)}`);
    assert.equal(m(entry.gross_amount), econ.gross);
    assert.equal(m(entry.vat_amount), econ.buyerVat, "buyer VAT");
    assert.equal(m(entry.fee_base_amount), econ.feeBase, "fee base = gross − buyer VAT (delivery included)");
    assert.equal(m(entry.platform_fee_base_amount), econ.fee, "8 % exactly");
    assert.equal(m(entry.platform_fee_total_amount), econ.feeTotal);
    assert.equal(m(entry.seller_net_amount), econ.sellerNet, "seller net = gross − Siton fee (no distributor share)");
    assert.equal(Number(entry.platform_fee_rate), 0.08);
    assert.equal(lab.sim.effectsOf(p.authorization).capture_amount_minor, econ.gross, "the provider captured exactly the authoritative gross");
    await lab.oracle(`economics:${c.label}`, [d.deal_id], { seededStates: false });
  });
}

await run("economics: VAT exclusion is real — the same gross under VAT 0 yields a HIGHER fee than under 17 % (fee base shrinks by the buyer VAT)", async () => {
  const withVat = oracleEconomics({ qty: 1, price_per_unit: 117, delivery_cost: 0 }, lab.vat);
  const zeroVat = oracleEconomics({ qty: 1, price_per_unit: 117, delivery_cost: 0 }, { product_rate: 0, delivery_rate: 0, platform_fee_vat_rate: lab.vat.platform_fee_vat_rate });
  assert.equal(withVat.buyerVat, 1700); assert.equal(withVat.feeBase, 10000); assert.equal(withVat.fee, 800);
  assert.equal(zeroVat.feeBase, 11700); assert.equal(zeroVat.fee, 936);
  assert.ok(zeroVat.fee > withVat.fee);
});

await run("economics: many participants, threshold boundary, mixed deliveries — every ledger row and the deal totals agree with the oracle", async () => {
  const specs = Array.from({ length: 12 }, (_, i) => ({ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 1 + (i % 4), delivery_cost: [0, 7.5, 12.49, 30.01][i % 4]! }));
  const d = await lab.seedDeal({ state: "Charging", price_per_unit: 19.9, threshold_units: 30, participants: specs });
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  let expectedFees = 0; let expectedNet = 0; let expectedGross = 0;
  for (const p of d.participants) {
    const econ = oracleEconomics({ qty: p.qty, price_per_unit: d.price_per_unit, delivery_cost: p.delivery_cost }, lab.vat);
    expectedFees += econ.feeTotal; expectedNet += econ.sellerNet; expectedGross += econ.gross;
  }
  const totals = (await lab.pool.query(`SELECT SUM(platform_fee_amount) AS fees, SUM(seller_net_amount) AS net, SUM(gross_amount) AS gross, COUNT(*)::int AS n FROM siton.platform_fee_money_events WHERE deal_id=$1`, [d.deal_id])).rows[0];
  assert.equal(totals.n, 12);
  assert.equal(Math.round(Number(totals.fees) * 100), expectedFees);
  assert.equal(Math.round(Number(totals.net) * 100), expectedNet);
  assert.equal(Math.round(Number(totals.gross) * 100), expectedGross);
  const report = await lab.oracle("economics:12-participants", [d.deal_id], { seededStates: false });
  assert.equal(report.totals.LEDGER_FEES_MINOR, expectedFees);
  assert.equal(report.totals.TOTAL_CAPTURED_MINOR, expectedGross);
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
