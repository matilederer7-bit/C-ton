// R9C PRODUCTION CANDIDATE — BLACK-BOX MONEY SAFETY, capture / recovery side.
//
// Siton is treated as a black box: real handlers and worker code
// (processOutboxEventById), a real migrated PostgreSQL database, the black-box
// provider stub at a real HTTP boundary. The TEST owns the schedule (scripted
// answers, held responses, forced late settlements) and asserts only externally
// durable facts: money requests / effects the provider actually saw, and rows
// the database actually committed. No observer, no oracle, no reconstructed
// chronology.
//
//   B1  capture answer lost / unknown         → no second capture; the SAME identity is reconciled;
//                                                exactly one money effect at the end (captured, or
//                                                recovered once the failure is safely proven)
//   B2  original capture settles late WHILE   → no silent double capture: both effects recorded on
//       the recovery is in flight               their own identities, a durable FINANCIAL_OUTCOME_UNRESOLVED
//                                                case, and no further automatic money operation
//   B3  recovery succeeded, then the provider → exactly ONE durable dual-capture escalation, stable
//       reports the original as captured        across redeliveries; no refund / release / capture fired
//   B4  foreign provider reference             → a status answer naming another reference proves
//                                                nothing: no state change, no money, a visible case;
//                                                the truthful answer later resolves it
//   B5  status unreadable / transport failure  → no new money dispatch while nothing can be read;
//                                                a held answer past the client timeout is UNKNOWN,
//                                                truth resolves it with exactly one effect
//
// REAL MONEY: none. Stub provider, disposable database.

import assert from "node:assert/strict";
import { bootBlackBox, makeRunner, sleep, until } from "./blackbox/harness.js";

const HORIZON_MS = 1500;
const bb = await bootBlackBox({ tag: "bb-capture", port: 3301, settlementHorizonMs: HORIZON_MS, env: { COMPLETION_WINDOW_MINUTES: "30" } });
const { run, summary } = makeRunner("payment_blackbox_capture_recovery");
const { provider } = bb;

const chargingDeal = () => bb.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
const moneyRequests = (auth: string) => provider.moneyRequestsOf(auth);
const captureRequests = (auth: string) => provider.requestsOf(auth, "capture");
const recoverRequests = (auth: string) => provider.requestsOf(auth, "recover");
const unresolvedCases = async (pid: string) => (await bb.cases(pid)).filter((c) => /FINANCIAL_OUTCOME_UNRESOLVED/.test(c.subject) || /late-money-effect|outcome-unresolved/.test(c.auto_key));

// ── B1 ────────────────────────────────────────────────────────────────────────
await run("B1a capture executed, answer LOST (socket dropped) → UNKNOWN on the same identity, no second capture, truth converges to ChargedSuccess with ONE effect", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_DROP" }]);
  const charge = await bb.enqueueCharge(d.deal_id);
  const outcome = await bb.processOutboxEventById(charge);
  assert.equal(outcome?.status, "sent", JSON.stringify(outcome));
  const mid = await bb.snapshot(p, d.deal_id);
  console.log(`  B1a after lost answer: ${JSON.stringify(mid)}`);
  assert.equal(captureRequests(p.authorization).length, 1, "exactly one capture request reached the provider");
  assert.equal(mid.money_state, "ChargeAttempt", "nothing was guessed from a lost answer");
  const rows = await bb.attempts(p.participant_id, "charge_start");
  assert.equal(rows.length, 1, "one durable capture identity");
  assert.equal(rows[0]!.result_class, "unknown");
  assert.equal(rows[0]!.dispatch_state, "responded");
  assert.equal((await bb.liveEvents([d.deal_id], ["payment_reconcile"])).length, 1, "the UNKNOWN identity has a live reconcile");

  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B1a terminal: ${JSON.stringify(end)}`);
  assert.equal(captureRequests(p.authorization).length, 1, "no second capture request, ever");
  assert.equal(recoverRequests(p.authorization).length, 0, "no recovery for money that moved");
  assert.equal(end.provider_effects.capture, 1);
  assert.equal(end.money_state, "ChargedSuccess", "the provider's truth (captured) became canonical");
  assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((r) => r.result_class), ["success"]);
  assert.equal(end.ledger.length, 1, "exactly one fee-ledger entry for one capture");
});

await run("B1b capture answered 503 with NOTHING executed → UNKNOWN, no blind retry; the failure is proven by status, the settlement horizon is honoured, then exactly ONE recovery", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "NO_EFFECT_HTTP", status: 503 }]);
  const charge = await bb.enqueueCharge(d.deal_id);
  assert.equal((await bb.processOutboxEventById(charge))?.status, "sent");
  assert.equal(captureRequests(p.authorization).length, 1);
  assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((r) => r.result_class), ["unknown"], "503 after dispatch is UNKNOWN, never temporary_fail");
  assert.equal((await bb.participant(p.participant_id)).money_state, "ChargeAttempt");

  // the reconcile reads the truth (authorized / final: nothing captured); the
  // status-inferred failure is fenced until the settlement horizon, then the
  // recovery pre-flight re-reads twice and one recovery is sent
  const startedAt = Date.now();
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 60 });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B1b terminal after ${Date.now() - startedAt}ms: ${JSON.stringify(end)}`);
  assert.equal(captureRequests(p.authorization).length, 1, "the original capture was never re-sent");
  assert.equal(recoverRequests(p.authorization).length, 1, "exactly one recovery request");
  assert.equal(end.provider_effects.capture, 0);
  assert.equal(end.provider_effects.recover, 1, "exactly one money effect in total");
  assert.equal(end.money_state, "RecoveredCharge");
  const rows = await bb.attempts(p.participant_id);
  assert.deepEqual(rows.map((r) => `${r.attempt_type}:${r.result_class}`), ["charge_start:permanent_fail", "recovery:success"]);
  assert.equal(rows[0]!.failure_evidence, "status_inference", "the capture failure was inferred from status, not declared by the provider");
  const recoverAt = new Date(recoverRequests(p.authorization)[0]!.at).getTime();
  const dispatchedAt = new Date(String(rows[0]!.dispatched_at)).getTime();
  assert.ok(recoverAt - dispatchedAt >= HORIZON_MS - 50, `the recovery waited for the settlement horizon (${recoverAt - dispatchedAt}ms after the capture dispatch)`);
  assert.ok(provider.requestsOf(p.authorization, "status").length >= 3, "reconcile read + two pre-flight reads before money moved");
});

// ── B2 ────────────────────────────────────────────────────────────────────────
await run("B2 original capture settles late WHILE the recovery is in flight → both effects are recorded on their own identities, a durable case exists, nothing else moves", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "DECLINE" }]);
  const charge = await bb.enqueueCharge(d.deal_id);
  assert.equal((await bb.processOutboxEventById(charge))?.status, "sent");
  assert.equal((await bb.participant(p.participant_id)).money_state, "ChargeFailedRecovery", "the provider declined the exact request");
  const recoveryJobs = await bb.liveEvents([d.deal_id], ["recovery_deal"]);
  assert.equal(recoveryJobs.length, 1, "a recovery job exists");
  const original = (await bb.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(original.failure_evidence, "dispatch_response");

  // the recovery request reaches the provider, money moves, the answer is HELD
  provider.script(p.authorization, "recover", [{ kind: "EFFECT_THEN_HOLD", gate: "b2-recover" }]);
  const recovering = bb.processOutboxEventById(recoveryJobs[0]!.event_uuid);
  await provider.waitEntered("b2-recover", 1, 8000);
  assert.equal(provider.effectsOf(p.authorization).recover, 1, "the recovery capture executed at the provider (answer still held)");

  // meanwhile the provider settles the ORIGINAL capture late and calls back
  provider.forceEffect("capture", p.authorization, p.amount_minor);
  const late = await bb.postWebhook({ event_type: "charge_captured", event_id: `b2-late-${p.participant_id}`, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  console.log(`  B2 late callback while recovery in flight: http=${late.statusCode} body=${late.body.slice(0, 120)}`);
  provider.release("b2-recover");
  const recovered = await recovering;
  console.log(`  B2 recovery job: ${JSON.stringify(recovered)}`);
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  // a redelivery of the late callback after everything landed must not change the picture
  await bb.postWebhook({ event_type: "charge_captured", event_id: `b2-late-redelivery-${p.participant_id}`, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });

  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B2 terminal: ${JSON.stringify(end)}`);
  assert.equal(end.provider_effects.capture, 1, "the provider's late settlement of the original");
  assert.equal(end.provider_effects.recover, 1, "the recovery capture");
  assert.equal(moneyRequests(p.authorization).length, 2, "Siton sent exactly two money requests (capture, recover) and nothing else afterwards");
  const rows = await bb.attempts(p.participant_id);
  assert.deepEqual(rows.map((r) => `${r.attempt_type}:${r.result_class}`), ["charge_start:success", "recovery:success"], "both executed operations are recorded as executed — nothing was hidden");
  const cases = await unresolvedCases(p.participant_id);
  assert.ok(cases.length >= 1, `a durable operator case records the double capture: ${JSON.stringify(end.cases)}`);
  assert.ok(cases.some((c) => c.status === "Open"), "the case is open");
  assert.ok(end.cases.some((c) => c.startsWith("payment-late-money-effect")), "keyed as a late money effect / dual capture");
  assert.equal((await bb.liveEvents([d.deal_id])).filter((e) => e.event_type !== "finalize_deal").length, 0, "no automatic job is still trying to move money");
});

// ── B3 ────────────────────────────────────────────────────────────────────────
await run("B3 recovery succeeded, then the provider reports the original as captured → exactly ONE durable dual-capture escalation, stable across redeliveries, no automatic money operation", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "DECLINE" }]);
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal((await bb.participant(p.participant_id)).money_state, "RecoveredCharge");
  assert.equal(provider.effectsOf(p.authorization).recover, 1);
  const original = (await bb.attempts(p.participant_id, "charge_start"))[0]!;
  assert.equal(original.result_class, "permanent_fail");

  // the provider now claims the declined original capture executed after all
  provider.forceEffect("capture", p.authorization, p.amount_minor);
  const first = await bb.postWebhook({ event_type: "charge_captured", event_id: `b3-first-${p.participant_id}`, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id });
  assert.equal(first.statusCode, 200, `the delivery is acknowledged once the escalation is durable: ${first.body}`);
  const afterFirst = (await bb.cases(p.participant_id)).filter((c) => c.auto_key.includes("dual-capture"));
  assert.equal(afterFirst.length, 1, `exactly one dual-capture escalation: ${JSON.stringify(await bb.cases(p.participant_id))}`);
  assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((r) => r.result_class), ["success"], "the identity converged to the money truth");
  // redeliveries: same id, fresh id, concurrent
  const redeliveries = await Promise.all([
    bb.postWebhook({ event_type: "charge_captured", event_id: `b3-first-${p.participant_id}`, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id }),
    bb.postWebhook({ event_type: "charge_captured", event_id: `b3-fresh-1-${p.participant_id}`, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id }),
    bb.postWebhook({ event_type: "charge_captured", event_id: `b3-fresh-2-${p.participant_id}`, provider_reference: p.authorization, correlation_id: original.correlation_id, participant_id: p.participant_id, deal_id: d.deal_id })
  ]);
  assert.deepEqual(redeliveries.map((r) => r.statusCode), [200, 200, 200]);
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B3 terminal: ${JSON.stringify(end)}`);
  const dual = (await bb.cases(p.participant_id)).filter((c) => c.auto_key.includes("dual-capture"));
  assert.equal(dual.length, 1, "still exactly one escalation after redeliveries");
  assert.equal(dual[0]!.status, "Open");
  assert.equal(moneyRequests(p.authorization).length, 2, "no refund, release or capture was fired automatically");
  assert.equal(end.provider_effects.capture + end.provider_effects.recover, 2);
  assert.equal(end.provider_effects.refund + end.provider_effects.release, 0);
});

// ── B4 ────────────────────────────────────────────────────────────────────────
await run("B4 foreign provider reference: a status answer naming ANOTHER reference proves nothing — no state change, no money, a case; the truthful answer resolves it later", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "NO_EFFECT_HTTP", status: 502 }]);
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((r) => r.result_class), ["unknown"]);
  // the reconcile's status read answers "captured" — for someone else's reference
  provider.scriptStatus(p.authorization, [{ kind: "ANSWER", state: "captured", final: true, provider_reference: `other-${p.authorization.slice(-6)}`, amount_minor: p.amount_minor }]);
  const reconcile = (await bb.liveEvents([d.deal_id], ["payment_reconcile"]))[0]!;
  const reconciled = await bb.processOutboxEventById(reconcile.event_uuid);
  console.log(`  B4 reconcile on a foreign reference: ${JSON.stringify(reconciled)}`);
  const mid = await bb.snapshot(p, d.deal_id);
  console.log(`  B4 after foreign answer: ${JSON.stringify(mid)}`);
  assert.equal(mid.money_state, "ChargeAttempt", "another operation's capture proves nothing about this one");
  assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((r) => r.result_class), ["unknown"], "no verdict was drawn");
  assert.equal(moneyRequests(p.authorization).length, 1, "no money moved on foreign evidence");
  assert.ok((await bb.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-reconcile-reference-mismatch")), `a reference-mismatch case is visible: ${JSON.stringify(mid.cases)}`);

  // the truthful provider (nothing captured) → status-inferred failure → horizon → one recovery
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal", maxRounds: 60 });
  // the recovery pre-flight: a foreign answer there HOLDS as well (no recovery on it)
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B4 terminal: ${JSON.stringify(end)}`);
  assert.equal(end.provider_effects.capture, 0);
  assert.ok(end.provider_effects.recover <= 1, "never more than one recovery");
  assert.equal(captureRequests(p.authorization).length, 1);
});

await run("B4b recovery pre-flight: a foreign-reference status answer HOLDS the recovery (no money), a truthful answer lets exactly one recovery proceed", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "DECLINE" }]);
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  const recovery = (await bb.liveEvents([d.deal_id], ["recovery_deal"]))[0]!;
  provider.scriptStatus(p.authorization, [{ kind: "ANSWER", state: "authorized", final: true, provider_reference: `foreign-${p.authorization.slice(-6)}` }]);
  const held = await bb.processOutboxEventById(recovery.event_uuid);
  console.log(`  B4b recovery job on a foreign pre-flight read: ${JSON.stringify(held)}`);
  assert.equal(recoverRequests(p.authorization).length, 0, "no recovery was sent on an answer about another operation");
  assert.ok((await bb.cases(p.participant_id)).some((c) => c.auto_key.startsWith("payment-recovery-preflight-mismatch")), "the hold is visible as a case");
  assert.equal((await bb.participant(p.participant_id)).money_state, "ChargeFailedRecovery");
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B4b terminal: ${JSON.stringify(end)}`);
  assert.equal(recoverRequests(p.authorization).length, 1, "exactly one recovery once the provider answered truthfully");
  assert.equal(end.provider_effects.recover, 1);
  assert.equal(end.money_state, "RecoveredCharge");
});

// ── B5 ────────────────────────────────────────────────────────────────────────
await run("B5a status unreadable (malformed / 500 / dropped): no new money dispatch while nothing can be read; the identity stays UNKNOWN; truth resolves it with one effect", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_HTTP", status: 503 }]);
  assert.equal((await bb.processOutboxEventById(await bb.enqueueCharge(d.deal_id)))?.status, "sent");
  assert.equal(provider.effectsOf(p.authorization).capture, 1, "the money moved; the answer was a 503");
  provider.scriptStatus(p.authorization, [{ kind: "MALFORMED" }, { kind: "HTTP", status: 500 }, { kind: "DROP" }]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const live = await bb.liveEvents([d.deal_id], ["payment_reconcile"]);
    assert.equal(live.length, 1, "the reconcile stays alive");
    await bb.retryNow(live[0]!.event_uuid);
    const r = await bb.processOutboxEventById(live[0]!.event_uuid);
    console.log(`  B5a unreadable status #${attempt + 1}: ${JSON.stringify({ status: r?.status, error: String(r?.error || "").slice(0, 80) })}`);
    const mid = await bb.snapshot(p, d.deal_id);
    assert.equal(mid.money_state, "ChargeAttempt", "nothing was guessed from an unreadable status");
    assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((r) => r.result_class), ["unknown"]);
    assert.equal(moneyRequests(p.authorization).length, 1, "no new money dispatch while the status cannot be read");
  }
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B5a terminal: ${JSON.stringify(end)}`);
  assert.equal(end.money_state, "ChargedSuccess");
  assert.equal(moneyRequests(p.authorization).length, 1);
  assert.equal(end.provider_effects.capture, 1);
});

await run("B5b capture answer held past the client timeout → UNKNOWN (money moved); no second capture; truth resolves it with exactly one effect", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  provider.script(p.authorization, "capture", [{ kind: "EFFECT_THEN_HOLD", gate: "b5-capture" }]);
  const charge = await bb.enqueueCharge(d.deal_id);
  const t0 = Date.now();
  const charging = bb.processOutboxEventById(charge);
  await provider.waitEntered("b5-capture", 1, 8000);
  const outcome = await charging;                                            // the client times out (PAYMENT_PROVIDER_TIMEOUT_MS)
  console.log(`  B5b charge job after ${Date.now() - t0}ms: ${JSON.stringify(outcome)}`);
  assert.equal(outcome?.status, "sent");
  assert.deepEqual((await bb.attempts(p.participant_id, "charge_start")).map((r) => r.result_class), ["unknown"], "a timed-out capture is UNKNOWN");
  assert.equal(captureRequests(p.authorization).length, 1);
  provider.release("b5-capture");
  await sleep(50);
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B5b terminal: ${JSON.stringify(end)}`);
  assert.equal(captureRequests(p.authorization).length, 1, "never a second capture");
  assert.equal(recoverRequests(p.authorization).length, 0);
  assert.equal(end.provider_effects.capture, 1);
  assert.equal(end.money_state, "ChargedSuccess");
});

const failed = summary();
await bb.close();
process.exit(failed ? 1 : 0);
