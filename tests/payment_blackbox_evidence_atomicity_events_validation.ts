// R9C PRODUCTION CANDIDATE — BLACK-BOX MONEY SAFETY, evidence atomicity and duplicate provider events.
//
// Real application through the signed webhook seam and processOutboxEventById,
// a real migrated database, the black-box provider stub. Failures are injected
// at the database (a trigger that makes every operational_cases INSERT fail)
// and at the production fault point between the money evidence and its
// escalation; assertions use only committed rows, webhook rows and provider facts.
//
//   B9   case insertion failure during dual-money evidence → the delivery is NOT
//        acknowledged, the money evidence did NOT commit on its own (atomic),
//        the provider event stays retryable; once persistence is back the SAME
//        event id repairs both halves; a fresh id creates no duplicate
//   B10  duplicate webhook / duplicate provider event → idempotent outcome:
//        one state transition, one fee-ledger entry, no case, for capture,
//        recovery and refund; a late contradicting failure after a success never
//        flips the terminal state; concurrent duplicates behave the same
//
// REAL MONEY: none. Stub provider, disposable database.

import assert from "node:assert/strict";
import { bootBlackBox, makeRunner } from "./blackbox/harness.js";

const bb = await bootBlackBox({ tag: "bb-events", port: 3304, env: { COMPLETION_WINDOW_MINUTES: "30" } });
const { run, summary } = makeRunner("payment_blackbox_evidence_atomicity_events");
const { provider } = bb;

const BLOCK_TRIGGER = "trg_blackbox_block_operational_cases";
async function blockCasePersistence() {
  await bb.pool.query(`CREATE OR REPLACE FUNCTION siton.blackbox_block_operational_cases() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blackbox_injected_operational_cases_failure' USING ERRCODE = 'SN500'; END $$;`);
  await bb.pool.query(`DROP TRIGGER IF EXISTS ${BLOCK_TRIGGER} ON siton.operational_cases`);
  await bb.pool.query(`CREATE TRIGGER ${BLOCK_TRIGGER} BEFORE INSERT ON siton.operational_cases FOR EACH ROW EXECUTE FUNCTION siton.blackbox_block_operational_cases()`);
}
async function restoreCasePersistence() { await bb.pool.query(`DROP TRIGGER IF EXISTS ${BLOCK_TRIGGER} ON siton.operational_cases`); }

/** a recovered participant whose declined original capture the provider later claims to have executed: two captures for one obligation */
async function dualCaptureObligation() {
  const d = await bb.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "DECLINE" }]);
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await bb.participant(p.participant_id)).money_state, "RecoveredCharge");
  const original = (await bb.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(original.result_class, "permanent_fail");
  provider.forceEffect("capture", p.authorization, p.amount_minor);          // the provider settled the declined capture after all
  return { d, p, original };
}
const dualCases = async (pid: string) => (await bb.cases(pid)).filter((c) => c.auto_key.includes("dual-capture"));
const chargeClass = async (pid: string) => (await bb.attempts(pid, "charge_start")).map((r) => r.result_class).join(",");

// ── B9 ────────────────────────────────────────────────────────────────────────
await run("B9a escalation persistence unavailable: the dual-capture delivery is NOT acknowledged, the money evidence did NOT commit alone, the event stays retryable; the SAME id repairs both halves; a fresh id adds no duplicate", async () => {
  const { d, p, original } = await dualCaptureObligation();
  const eventId = `b9a-original-${p.participant_id}`;
  const deliver = (id: string) => bb.postWebhook({ event_type: "charge_captured", event_id: id, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  await blockCasePersistence();
  let blocked: { statusCode: number; body: string };
  try { blocked = await deliver(eventId); } finally { await restoreCasePersistence(); }
  const midCases = await dualCases(p.participant_id);
  const midClass = await chargeClass(p.participant_id);
  const midWebhook = await bb.webhookEvent(eventId);
  console.log(`  B9a blocked: ${JSON.stringify({ http: blocked.statusCode, cases: midCases.length, charge_start: midClass, webhook: midWebhook?.status })}`);
  assert.notEqual(blocked.statusCode, 200, "a double capture with no durable escalation must not be acknowledged");
  assert.equal(midCases.length, 0, "the injection prevented the case");
  assert.equal(midClass, "permanent_fail", "the money evidence must not commit without its escalation (atomic)");
  assert.equal(midWebhook?.status, "failed", "the provider event is left retryable");

  const repaired = await deliver(eventId);
  assert.equal(repaired.statusCode, 200, `the retry of the same event id is acknowledged: ${repaired.body}`);
  assert.equal((await dualCases(p.participant_id)).length, 1, "exactly one durable escalation");
  assert.equal(await chargeClass(p.participant_id), "success", "the evidence committed together with the escalation");
  assert.equal((await bb.webhookEvent(eventId))?.status, "ignored", "the canonical state guard still classifies the late effect as ignored — durably handled (case + evidence), no longer retryable");
  const fresh = await deliver(`b9a-fresh-${p.participant_id}`);
  assert.equal(fresh.statusCode, 200);
  assert.equal((await dualCases(p.participant_id)).length, 1, "a fresh delivery id creates no duplicate case");
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B9a terminal: ${JSON.stringify(end)}`);
  assert.equal(provider.moneyRequestsOf(p.authorization).length, 2, "no automatic money operation followed");
});

await run("B9b a failure between the evidence write and the escalation (production fault point) rolls BOTH back; the retry commits both", async () => {
  const { d, p, original } = await dualCaptureObligation();
  const eventId = `b9b-${p.participant_id}`;
  const deliver = () => bb.postWebhook({ event_type: "charge_captured", event_id: eventId, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  bb.armTestFault("payment.before_escalation_case", { kind: "throw", code: "blackbox_injected_escalation_failure" }, 1);
  const blocked = await deliver();
  const midCases = (await dualCases(p.participant_id)).length;
  const midClass = await chargeClass(p.participant_id);
  bb.resetTestFaults();
  const repaired = await deliver();
  console.log(`  B9b: ${JSON.stringify({ blocked_http: blocked.statusCode, blocked_cases: midCases, blocked_charge_start: midClass, repaired_http: repaired.statusCode, final_cases: (await dualCases(p.participant_id)).length, final_charge_start: await chargeClass(p.participant_id) })}`);
  assert.notEqual(blocked.statusCode, 200);
  assert.equal(midCases, 0);
  assert.equal(midClass, "permanent_fail", "rolled back with the escalation");
  assert.equal(repaired.statusCode, 200);
  assert.equal((await dualCases(p.participant_id)).length, 1);
  assert.equal(await chargeClass(p.participant_id), "success");
});

await run("B9c an unreadable identity evidence set fails CLOSED: the delivery is not acknowledged, nothing is written, the same id succeeds once the read works", async () => {
  const { d, p, original } = await dualCaptureObligation();
  const eventId = `b9c-${p.participant_id}`;
  const deliver = () => bb.postWebhook({ event_type: "charge_captured", event_id: eventId, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  bb.armTestFault("payment.before_dual_capture_identity_read", { kind: "throw", code: "blackbox_injected_identity_read_failure" }, 1);
  const blocked = await deliver();
  bb.resetTestFaults();
  console.log(`  B9c unreadable evidence: http=${blocked.statusCode} webhook=${(await bb.webhookEvent(eventId))?.status} charge_start=${await chargeClass(p.participant_id)} cases=${(await dualCases(p.participant_id)).length}`);
  assert.notEqual(blocked.statusCode, 200, "UNKNOWN evidence must never be answered as 'not a dual capture'");
  assert.equal(await chargeClass(p.participant_id), "permanent_fail");
  assert.equal((await dualCases(p.participant_id)).length, 0);
  const repaired = await deliver();
  assert.equal(repaired.statusCode, 200);
  assert.equal((await dualCases(p.participant_id)).length, 1);
  assert.equal(await chargeClass(p.participant_id), "success");
});

// ── B10 ───────────────────────────────────────────────────────────────────────
await run("B10a duplicate charge_captured deliveries (same id, fresh ids, concurrent) → one ChargedSuccess, one fee-ledger entry, no case", async () => {
  const d = await bb.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  assert.equal((await bb.participant(p.participant_id)).money_state, "ChargedSuccess");
  const correlation = (await bb.attempts(p.participant_id, "charge_start"))[0]!.correlation_id;
  const deliver = (id: string) => bb.postWebhook({ event_type: "charge_captured", event_id: id, provider_reference: p.authorization, correlation_id: correlation, participant_id: p.participant_id, deal_id: d.deal_id });
  const codes = [await deliver(`b10a-1-${p.participant_id}`), await deliver(`b10a-1-${p.participant_id}`), await deliver(`b10a-2-${p.participant_id}`)].map((r) => r.statusCode);
  const concurrent = (await Promise.all([1, 2, 3, 4, 5].map((i) => deliver(`b10a-c${i}-${p.participant_id}`)))).map((r) => r.statusCode);
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B10a: http=${JSON.stringify([...codes, ...concurrent])} ${JSON.stringify(end)}`);
  assert.ok([...codes, ...concurrent].every((c) => c === 200), "every duplicate is acknowledged");
  assert.equal(end.money_state, "ChargedSuccess");
  assert.equal(end.ledger.length, 1, "exactly one fee-ledger entry");
  assert.equal((await bb.cases(p.participant_id)).length, 0, "a duplicate of one capture never escalates");
  assert.equal(provider.moneyRequestsOf(p.authorization).length, 1);
  assert.equal(end.provider_effects.capture, 1);
  const audits = (await bb.moneyAudits(p.participant_id)).filter((a) => a.state_type === "money_state" && a.to_state === "ChargedSuccess");
  assert.equal(audits.length, 1, "one money transition");
});

await run("B10b a late contradicting charge_failed after a success never flips the terminal state; duplicates of the recovery success are idempotent", async () => {
  const d = await bb.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "DECLINE" }]);
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await bb.participant(p.participant_id)).money_state, "RecoveredCharge");
  const recovery = (await bb.attempts(p.participant_id, "recovery"))[0]!;
  const dupes = await Promise.all([1, 2, 3].map((i) => bb.postWebhook({ event_type: "recovery_captured", event_id: `b10b-rc${i}-${p.participant_id}`, provider_reference: p.authorization, correlation_id: recovery.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id })));
  assert.ok(dupes.every((r) => r.statusCode === 200));
  const late = await bb.postWebhook({ event_type: "recovery_failed", event_id: `b10b-late-fail-${p.participant_id}`, provider_reference: p.authorization, correlation_id: recovery.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.equal(late.statusCode, 200);
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B10b: ${JSON.stringify(end)}`);
  assert.equal(end.money_state, "RecoveredCharge", "a late failure never downgrades an executed recovery");
  assert.equal(end.buyer_state, "Recovered");
  assert.deepEqual((await bb.attempts(p.participant_id, "recovery")).map((r) => r.result_class), ["success"], "the identity is monotonic");
  assert.equal(end.ledger.length, 1);
  assert.equal(provider.moneyRequestsOf(p.authorization).length, 2, "capture (declined) + recovery; nothing else");
  assert.equal(end.provider_effects.recover, 1);
});

await run("B10c duplicate refund_issued deliveries → one Refunded, one refund request, one ledger adjustment", async () => {
  const d = await bb.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
  const p = d.participants[0]!;
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  assert.equal((await bb.participant(p.participant_id)).money_state, "ChargedSuccess");
  const refund = await bb.processOutboxEventById(await bb.enqueueRefund(d.deal_id, "blackbox_refund"));
  console.log(`  B10c refund job: ${JSON.stringify(refund)}`);
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const refundRow = (await bb.attempts(p.participant_id, "refund"))[0];
  const mid = await bb.snapshot(p, d.deal_id);
  console.log(`  B10c after the refund: ${JSON.stringify(mid)}`);
  assert.equal(mid.money_state, "Refunded");
  assert.equal(provider.requestsOf(p.authorization, "refund").length, 1);
  const dupes = await Promise.all([1, 2, 3].map((i) => bb.postWebhook({ event_type: "refund_issued", event_id: `b10c-${i}-${p.participant_id}`, provider_reference: p.authorization, correlation_id: refundRow?.correlation_id ?? null, participant_id: p.participant_id, deal_id: d.deal_id })));
  assert.ok(dupes.every((r) => r.statusCode === 200));
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B10c terminal: ${JSON.stringify(end)}`);
  assert.equal(end.money_state, "Refunded");
  assert.equal(provider.requestsOf(p.authorization, "refund").length, 1, "exactly one refund request");
  assert.equal(end.provider_effects.refund, 1);
  assert.equal(end.ledger.filter((l) => /refund|adjust|reversal/i.test(l)).length, 1, `exactly one refund adjustment in the ledger: ${JSON.stringify(end.ledger)}`);
  assert.equal((await bb.cases(p.participant_id)).length, 0);
});

const failed = summary();
await bb.close();
process.exit(failed ? 1 : 0);
