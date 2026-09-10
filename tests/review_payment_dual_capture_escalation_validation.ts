/**
 * INDEPENDENT REVIEW — finding F-12: a dual capture must be ESCALATED, never
 * silently absorbed.
 *
 * The review contract for recovery is explicit: "recovery + original late
 * success cannot create double money. If such a dual-success situation is
 * possible, the system must detect and escalate rather than silently accept
 * both." And for late events: "money actually observed at provider side must
 * still become an operator/reconciliation case if local state cannot safely
 * absorb it. Do not merely discard evidence of real money."
 *
 * `recordLateMoneyEffectException` is the mechanism that keeps a refused
 * provider effect visible. Its contradiction predicate was
 *
 *     captureEffect && !["ChargedSuccess", "RecoveredCharge", "Refunded"].includes(moneyState)
 *
 * which is right for an idempotent REPLAY (the money truth already says
 * captured, and the effect reports the very operation that captured) but wrong
 * for a DUAL capture: when a recovery has already succeeded and the ORIGINAL
 * capture then lands late, the money state is `RecoveredCharge`, so the
 * predicate is false and the effect is dropped — no case, no attempt row, no
 * operator. Two real captures exist at the provider and nothing says so.
 *
 * DS-1 proves the escalation. DS-2 is the control that must stay silent: a
 * duplicate delivery of the SAME capture is not double money and must not open
 * a case, or every retried webhook would page an operator.
 *
 * REAL MONEY: none. In-process simulator; the "second capture" is recorded
 * directly in the simulator's effect ledger to model money that really moved.
 */

import assert from "node:assert/strict";
import { bootLab, makeRunner } from "./lab/runtime.js";

const lab = await bootLab({ tag: "dual-capture-escalation", port: 3214 });
const { run, summary } = makeRunner("review_payment_dual_capture_escalation");

await run("DS-1 a late ORIGINAL capture after a successful recovery is escalated, not absorbed", async () => {
  const deal = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [
      {
        buyer_state: "Recovered",
        money_state: "RecoveredCharge",
        priorAttempts: [
          // A provider CALLBACK declared this capture failed. That is evidence a
          // later provider claim may legitimately supersede, so the late effect
          // may be recorded on the identity. An answer to the exact request
          // (dispatch_response) may NOT be overwritten — see DS-4.
          { attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: "charge_start:review-ds1:n1", failure_evidence: "provider_event" },
          { attempt_type: "recovery", result_class: "success", correlation_id: "recovery:review-ds1:n1" }
        ]
      }
    ]
  });
  const p = deal.participants[0]!;

  // Provider truth: the recovery captured, and now the ORIGINAL capture settles
  // too. Two real captures for one obligation.
  lab.sim.forceEffect("recover", p.authorization, p.amount_minor);
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);

  const response = await lab.postWebhook({
    event_type: "charge_captured",
    provider_reference: p.authorization,
    correlation_id: "charge_start:review-ds1:n1",
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });

  const participant = await lab.participant(p.participant_id);
  const attempts = await lab.attempts(p.participant_id);
  const cases = await lab.cases(p.participant_id);
  const ledger = await lab.ledger(p.participant_id);
  const effects = lab.sim.effectsOf(p.authorization);
  console.log(`  DUAL_CAPTURE_EVIDENCE DS-1 ${JSON.stringify({
    webhook_status: response.statusCode,
    money_state: participant.money_state,
    provider_effects: { capture: effects.capture, recover: effects.recover },
    attempts: attempts.map((a) => `${a.attempt_type}:${a.result_class}`),
    cases: cases.map((c) => c.auto_key),
    ledger: ledger.map((l) => `${l.logical_entry_type}:${l.platform_fee_amount}`)
  })}`);

  // The provider really did move money twice — that is the premise, not a bug
  // this code can undo.
  assert.equal(effects.capture, 1, "DS-1 fixture: the original capture effect");
  assert.equal(effects.recover, 1, "DS-1 fixture: the recovery effect");

  // Canonical money truth must NOT be guessed or rewritten.
  assert.equal(participant.money_state, "RecoveredCharge", "DS-1: the late effect rewrote canonical money truth");
  assert.equal(
    ledger.filter((l) => l.logical_entry_type === "charge").length,
    0,
    "DS-1: a second fee row was written for the late capture (this fixture seeds state, so the recovery's own row is absent)"
  );

  // THE POINT: the second capture must be visible to an operator.
  assert.ok(
    cases.some((c) => c.auto_key.includes("late-money-effect")),
    `DS-1: a second real capture was absorbed with NO operator case: ${JSON.stringify(cases.map((c) => c.auto_key))}`
  );
  // ...and the original identity must be recorded as executed, so the 067
  // rules block any further automatic money operation for this participant.
  assert.ok(
    attempts.some((a) => a.attempt_type === "charge_start" && a.result_class === "success"),
    `DS-1: the original capture identity was not recorded as executed: ${JSON.stringify(attempts.map((a) => `${a.attempt_type}:${a.result_class}`))}`
  );
});

await run("DS-2 control: a duplicate delivery of the SAME capture stays silent", async () => {
  const deal = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [
      {
        buyer_state: "DealCompleted",
        money_state: "ChargedSuccess",
        priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: "charge_start:review-ds2:n1" }]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);

  // the same operation, delivered twice
  for (const attempt of [1, 2]) {
    await lab.postWebhook({
      event_type: "charge_captured",
      event_id: `lab-evt-review-ds2-${attempt}`,
      provider_reference: p.authorization,
      correlation_id: "charge_start:review-ds2:n1",
      participant_id: p.participant_id,
      deal_id: deal.deal_id
    });
  }

  const participant = await lab.participant(p.participant_id);
  const cases = await lab.cases(p.participant_id);
  const effects = lab.sim.effectsOf(p.authorization);
  console.log(`  DUAL_CAPTURE_EVIDENCE DS-2 ${JSON.stringify({
    money_state: participant.money_state,
    provider_effects: { capture: effects.capture, recover: effects.recover },
    cases: cases.map((c) => c.auto_key)
  })}`);

  assert.equal(participant.money_state, "ChargedSuccess", "DS-2: a duplicate delivery changed money truth");
  assert.equal(effects.capture, 1, "DS-2: a duplicate delivery moved money again");
  assert.ok(
    !cases.some((c) => c.auto_key.includes("late-money-effect")),
    `DS-2: an idempotent duplicate opened a false late-money-effect case: ${JSON.stringify(cases.map((c) => c.auto_key))}`
  );
});

await run("DS-3 control: a late capture on a participant whose money never captured is still escalated", async () => {
  const deal = await lab.seedDeal({
    state: "Failed",
    threshold_units: 5,
    participants: [
      {
        buyer_state: "Dropped",
        money_state: "AuthReleased",
        priorAttempts: [{ attempt_type: "release", result_class: "success", correlation_id: "release:review-ds3:n1" }]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  await lab.postWebhook({
    event_type: "charge_captured",
    provider_reference: p.authorization,
    correlation_id: "charge_start:review-ds3:n1",
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const participant = await lab.participant(p.participant_id);
  const cases = await lab.cases(p.participant_id);
  console.log(`  DUAL_CAPTURE_EVIDENCE DS-3 ${JSON.stringify({ money_state: participant.money_state, cases: cases.map((c) => c.auto_key) })}`);
  assert.equal(participant.money_state, "AuthReleased", "DS-3: a late capture resurrected a released hold");
  assert.ok(
    cases.some((c) => c.auto_key.includes("late-money-effect")),
    "DS-3: the pre-existing escalation for a non-captured money state regressed"
  );
});

// ── DS-4 — a late claim never overwrites the provider's answer to the exact
// request. Found while fixing this: recording a fabricated success there both
// invents money truth and destroys the retry-order evidence, because a second
// identity that was dispatched LEGALLY while this one was a declared failure
// then retroactively looks like a repeat over a successful operation. That is
// exactly what tripped the financial oracle on fuzz seed 209752203 index 152.
await run("DS-4 a late capture claim contradicting the provider's own exact-request decline is escalated, not written", async () => {
  const deal = await lab.seedDeal({
    state: "CompletionWindow",
    threshold_units: 1,
    completionWindowUntil: new Date(Date.now() + 10 * 60_000),
    participants: [
      {
        buyer_state: "Recovered",
        money_state: "RecoveredCharge",
        priorAttempts: [
          { attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: "charge_start:review-ds4:n1", failure_evidence: "dispatch_response" },
          { attempt_type: "recovery", result_class: "success", correlation_id: "recovery:review-ds4:n1" }
        ]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.forceEffect("recover", p.authorization, p.amount_minor);

  const response = await lab.postWebhook({
    event_type: "charge_captured",
    provider_reference: p.authorization,
    correlation_id: "charge_start:review-ds4:n1",
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const participant = await lab.participant(p.participant_id);
  const attempts = await lab.attempts(p.participant_id);
  const cases = await lab.cases(p.participant_id);
  const row = attempts.find((a) => a.correlation_id === "charge_start:review-ds4:n1");
  console.log(`  DUAL_CAPTURE_EVIDENCE DS-4 ${JSON.stringify({
    http: response.statusCode,
    money_state: participant.money_state,
    charge_start: `${row?.result_class}/${row?.failure_evidence}`,
    cases: cases.map((c) => c.auto_key)
  })}`);

  // The contradiction still reaches an operator.
  assert.ok(
    cases.some((c) => c.auto_key.includes("late-money-effect")),
    `DS-4: the contradiction must still be escalated: ${JSON.stringify(cases.map((c) => c.auto_key))}`
  );
  // But the provider's answer to the exact request is left exactly as given.
  assert.equal(row?.result_class, "permanent_fail", "DS-4: an exact-request decline must not be overwritten with a fabricated success");
  assert.equal(row?.failure_evidence, "dispatch_response", "DS-4: the exact-request evidence must be preserved");
  assert.equal(participant.money_state, "RecoveredCharge", "DS-4: canonical money truth must not move");
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
