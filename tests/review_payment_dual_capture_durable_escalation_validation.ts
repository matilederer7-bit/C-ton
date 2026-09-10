/**
 * INDEPENDENT REVIEW — F-12 remediation: a known double capture can never be
 * acknowledged as safely handled without a DURABLE operator escalation.
 *
 * The Codex merge review found that the escalation was a best-effort side
 * effect committed AFTER the money evidence, with its error suppressed. If the
 * operational_cases INSERT failed, the webhook still returned 200, the delivery
 * counted as handled, and no case existed. Worse, the evidence that had already
 * committed made the condition permanently undetectable: the old predicate
 * asked whether EVERY executed capture-side identity differed from the reported
 * one, so the reported identity's own freshly committed success row made it
 * false. Neither a same-id retry nor a fresh-id redelivery could ever repair
 * it. Two real captures, both recorded, and no operator case.
 *
 * This suite proves the remediation on the real application through the signed
 * webhook seam, with a local simulated provider and a disposable database:
 *
 *   DE-1  escalation persistence unavailable -> the delivery is NOT acknowledged
 *         as handled, no case exists, and the money evidence did NOT commit
 *         either (the two halves are atomic)
 *   DE-2  restore persistence, retry the SAME event id -> durable escalation
 *   DE-3  fresh delivery id for the same condition -> still escalated, and
 *         still exactly ONE case
 *   DE-4  the same guarantee proved at the in-transaction seam itself
 *   DE-5  control: one capture plus a duplicate delivery stays silent
 *   DE-6  control: concurrent fresh deliveries of an escalated condition
 *         produce exactly one case
 *
 * REAL MONEY: none. In-process simulator; the second capture is recorded
 * directly in the simulator's effect ledger to model money that really moved.
 */

import assert from "node:assert/strict";
import { bootLab, makeRunner } from "./lab/runtime.js";

const lab = await bootLab({ tag: "dual-capture-durable", port: 3215 });
const { run, summary } = makeRunner("review_payment_dual_capture_durable_escalation");

const BLOCK_TRIGGER = "trg_review_block_operational_cases";

/** Make every operational_cases INSERT fail, as a broken table would. */
async function blockCasePersistence() {
  await lab.pool.query(`
    CREATE OR REPLACE FUNCTION siton.review_block_operational_cases()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'review_injected_operational_cases_failure' USING ERRCODE = 'SN500';
    END $$;`);
  await lab.pool.query(`DROP TRIGGER IF EXISTS ${BLOCK_TRIGGER} ON siton.operational_cases`);
  await lab.pool.query(
    `CREATE TRIGGER ${BLOCK_TRIGGER} BEFORE INSERT ON siton.operational_cases
     FOR EACH ROW EXECUTE FUNCTION siton.review_block_operational_cases()`
  );
}

async function restoreCasePersistence() {
  await lab.pool.query(`DROP TRIGGER IF EXISTS ${BLOCK_TRIGGER} ON siton.operational_cases`);
}

/** A participant whose recovery succeeded while the original capture had been declared failed. */
async function seedDualCaptureObligation(tag: string) {
  const deal = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [
      {
        buyer_state: "Recovered",
        money_state: "RecoveredCharge",
        priorAttempts: [
          { attempt_type: "charge_start", result_class: "permanent_fail", correlation_id: `charge_start:${tag}:n1`, failure_evidence: "dispatch_response" },
          { attempt_type: "recovery", result_class: "success", correlation_id: `recovery:${tag}:n1` }
        ]
      }
    ]
  });
  const p = deal.participants[0]!;
  // Provider truth: both operations really moved money.
  lab.sim.forceEffect("recover", p.authorization, p.amount_minor);
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  return { deal, p, correlation: `charge_start:${tag}:n1` };
}

async function lateEffectCases(participantId: string) {
  return (await lab.cases(participantId)).filter((c) => c.auto_key.includes("late-money-effect"));
}

async function webhookStatus(eventId: string) {
  const r = await lab.pool.query(`SELECT status FROM siton.webhook_events WHERE event_id=$1`, [eventId]);
  return String(r.rows[0]?.status || "absent");
}

async function chargeStartClass(participantId: string) {
  const rows = await lab.attempts(participantId, "charge_start");
  return rows.map((r) => r.result_class).join(",");
}

// ── DE-1 / DE-2 / DE-3 — the Codex scenario, end to end ────────────────────
await run("DE-1 escalation persistence unavailable: the delivery is not acknowledged and NOTHING half-commits", async () => {
  const { deal, p, correlation } = await seedDualCaptureObligation("de1");
  const eventId = "review-de1-original-delivery";
  await blockCasePersistence();
  let response: { statusCode: number; body: string };
  try {
    response = await lab.postWebhook({
      event_type: "charge_captured",
      event_id: eventId,
      provider_reference: p.authorization,
      correlation_id: correlation,
      participant_id: p.participant_id,
      deal_id: deal.deal_id
    });
  } finally {
    // leave it blocked for the assertions, restored by DE-2
  }
  const cases = await lateEffectCases(p.participant_id);
  const effects = lab.sim.effectsOf(p.authorization);
  console.log(`  DURABLE_ESCALATION_EVIDENCE DE-1 ${JSON.stringify({
    http: response.statusCode,
    webhook_row: await webhookStatus(eventId),
    charge_start: await chargeStartClass(p.participant_id),
    provider_effects: { capture: effects.capture, recover: effects.recover },
    late_effect_cases: cases.length
  })}`);

  assert.equal(effects.capture, 1, "DE-1 fixture: one original capture at the provider");
  assert.equal(effects.recover, 1, "DE-1 fixture: one recovery capture at the provider");

  // 1. NOT acknowledged as safely handled.
  assert.notEqual(response.statusCode, 200, `DE-1: a double capture with no durable escalation was acknowledged (HTTP ${response.statusCode})`);
  // 2. No escalation exists (that is the injected condition).
  assert.equal(cases.length, 0, "DE-1 fixture: the injection must actually prevent the case");
  // 3. ATOMIC: the money evidence must not have committed on its own, because
  //    that committed row is exactly what used to make the condition
  //    undetectable for ever.
  assert.equal(
    await chargeStartClass(p.participant_id),
    "permanent_fail",
    "DE-1: the late-effect evidence committed without its escalation — the two halves are not atomic"
  );
  // 4. The delivery is durably marked retryable, so the observation is not lost.
  assert.equal(await webhookStatus(eventId), "failed", "DE-1: the provider event must be left retryable");

  // hand state to DE-2
  (globalThis as any).__de1 = { deal, p, correlation, eventId };
});

await run("DE-2 restoring persistence and retrying the SAME event id repairs the escalation", async () => {
  const { deal, p, correlation, eventId } = (globalThis as any).__de1;
  await restoreCasePersistence();
  const response = await lab.postWebhook({
    event_type: "charge_captured",
    event_id: eventId,
    provider_reference: p.authorization,
    correlation_id: correlation,
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const cases = await lateEffectCases(p.participant_id);
  console.log(`  DURABLE_ESCALATION_EVIDENCE DE-2 ${JSON.stringify({
    http: response.statusCode,
    webhook_row: await webhookStatus(eventId),
    charge_start: await chargeStartClass(p.participant_id),
    cases: cases.map((c) => c.auto_key)
  })}`);
  assert.equal(response.statusCode, 200, "DE-2: the repaired delivery must be acknowledged");
  assert.equal(cases.length, 1, `DE-2: exactly one durable escalation expected, got ${JSON.stringify(cases.map((c) => c.auto_key))}`);
  assert.ok(cases[0]!.auto_key.includes("dual-capture"), `DE-2: the escalation must be keyed as a dual capture: ${cases[0]!.auto_key}`);
  assert.equal(await chargeStartClass(p.participant_id), "success", "DE-2: the money evidence must now be recorded with the escalation");
});

await run("DE-3 a FRESH delivery id for the same condition stays escalated and creates no duplicate", async () => {
  const { deal, p, correlation } = (globalThis as any).__de1;
  const before = await lateEffectCases(p.participant_id);
  const response = await lab.postWebhook({
    event_type: "charge_captured",
    event_id: "review-de3-fresh-delivery",
    provider_reference: p.authorization,
    correlation_id: correlation,
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const after = await lateEffectCases(p.participant_id);
  console.log(`  DURABLE_ESCALATION_EVIDENCE DE-3 ${JSON.stringify({ http: response.statusCode, before: before.length, after: after.length, keys: after.map((c) => c.auto_key) })}`);
  assert.equal(response.statusCode, 200, "DE-3: a redelivery of an escalated condition must be acknowledged");
  assert.equal(after.length, 1, `DE-3: exactly one case must exist, got ${after.length}`);
  assert.deepEqual(after.map((c) => c.auto_key), before.map((c) => c.auto_key), "DE-3: the escalation key must be stable across deliveries");
});

// ── DE-4 — the same guarantee at the in-transaction seam ───────────────────
await run("DE-4 a failure between the evidence and the escalation rolls BOTH back, and the retry commits both", async () => {
  const { deal, p, correlation } = await seedDualCaptureObligation("de4");
  lab.armTestFault("payment.before_escalation_case", { kind: "throw", code: "review_injected_escalation_failure" }, 1);
  const blocked = await lab.postWebhook({
    event_type: "charge_captured",
    event_id: "review-de4-blocked",
    provider_reference: p.authorization,
    correlation_id: correlation,
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const midCases = await lateEffectCases(p.participant_id);
  const midClass = await chargeStartClass(p.participant_id);
  lab.resetTestFaults();
  const repaired = await lab.postWebhook({
    event_type: "charge_captured",
    event_id: "review-de4-blocked",
    provider_reference: p.authorization,
    correlation_id: correlation,
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const finalCases = await lateEffectCases(p.participant_id);
  console.log(`  DURABLE_ESCALATION_EVIDENCE DE-4 ${JSON.stringify({
    blocked_http: blocked.statusCode,
    blocked_cases: midCases.length,
    blocked_charge_start: midClass,
    repaired_http: repaired.statusCode,
    final_cases: finalCases.map((c) => c.auto_key),
    final_charge_start: await chargeStartClass(p.participant_id)
  })}`);
  assert.notEqual(blocked.statusCode, 200, "DE-4: a failed escalation must not be acknowledged");
  assert.equal(midCases.length, 0, "DE-4: no case may exist when the transaction aborted");
  assert.equal(midClass, "permanent_fail", "DE-4: the evidence must roll back with the escalation");
  assert.equal(repaired.statusCode, 200, "DE-4: the retry must succeed");
  assert.equal(finalCases.length, 1, "DE-4: the retry must leave exactly one escalation");
  assert.equal(await chargeStartClass(p.participant_id), "success", "DE-4: the retry must commit the evidence");
});

// ── DE-5 — control: an ordinary duplicate of ONE capture stays silent ──────
await run("DE-5 control: one capture plus a duplicate delivery raises no escalation", async () => {
  const deal = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [
      {
        buyer_state: "DealCompleted",
        money_state: "ChargedSuccess",
        priorAttempts: [{ attempt_type: "charge_start", result_class: "success", correlation_id: "charge_start:de5:n1" }]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  const codes: number[] = [];
  for (const id of ["review-de5-a", "review-de5-b", "review-de5-c"]) {
    const r = await lab.postWebhook({
      event_type: "charge_captured",
      event_id: id,
      provider_reference: p.authorization,
      correlation_id: "charge_start:de5:n1",
      participant_id: p.participant_id,
      deal_id: deal.deal_id
    });
    codes.push(r.statusCode);
  }
  const cases = await lateEffectCases(p.participant_id);
  const effects = lab.sim.effectsOf(p.authorization);
  console.log(`  DURABLE_ESCALATION_EVIDENCE DE-5 ${JSON.stringify({ http: codes, provider_captures: effects.capture, cases: cases.map((c) => c.auto_key) })}`);
  assert.deepEqual(codes, [200, 200, 200], "DE-5: ordinary duplicates must be acknowledged");
  assert.equal(effects.capture, 1, "DE-5: no extra money moved");
  assert.equal(cases.length, 0, `DE-5: a single capture must never escalate: ${JSON.stringify(cases.map((c) => c.auto_key))}`);
});

// ── DE-6 — control: concurrent redeliveries produce exactly one case ───────
await run("DE-6 control: concurrent fresh deliveries of a dual capture create exactly one escalation", async () => {
  const { deal, p, correlation } = await seedDualCaptureObligation("de6");
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      lab.postWebhook({
        event_type: "charge_captured",
        event_id: `review-de6-concurrent-${i}`,
        provider_reference: p.authorization,
        correlation_id: correlation,
        participant_id: p.participant_id,
        deal_id: deal.deal_id
      })
    )
  );
  const cases = await lateEffectCases(p.participant_id);
  const allCases = await lab.cases(p.participant_id);
  console.log(`  DURABLE_ESCALATION_EVIDENCE DE-6 ${JSON.stringify({
    http: results.map((r) => r.statusCode),
    late_effect_cases: cases.map((c) => c.auto_key),
    all_cases: allCases.length
  })}`);
  assert.ok(results.every((r) => r.statusCode === 200), `DE-6: every concurrent delivery must be acknowledged: ${JSON.stringify(results.map((r) => r.statusCode))}`);
  assert.equal(cases.length, 1, `DE-6: exactly one escalation must exist under concurrency, got ${cases.length}`);
  assert.equal(await chargeStartClass(p.participant_id), "success", "DE-6: the evidence must be recorded once");
});

// ── DE-7 — the predicate itself: evidence already committed, no case yet ───
// This is the state the old code could reach and never escape. BOTH capture-side
// identities are already recorded as executed and no escalation exists, which is
// exactly what the first delivery used to leave behind. The old predicate asked
// whether EVERY executed identity differed from the reported one, so the
// reported identity's own success row made it false and every later delivery was
// silently ignored. Counting distinct executed identities still sees two.
await run("DE-7 an already-recorded dual capture with no case is still escalated by a fresh delivery", async () => {
  const deal = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [
      {
        buyer_state: "Recovered",
        money_state: "RecoveredCharge",
        // recovery first: migration 067 refuses a recovery identity once a
        // charge_start is already recorded as executed
        priorAttempts: [
          { attempt_type: "recovery", result_class: "success", correlation_id: "recovery:de7:n1" },
          { attempt_type: "charge_start", result_class: "success", correlation_id: "charge_start:de7:n1" }
        ]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.forceEffect("recover", p.authorization, p.amount_minor);
  lab.sim.forceEffect("capture", p.authorization, p.amount_minor);
  assert.equal((await lateEffectCases(p.participant_id)).length, 0, "DE-7 fixture: no escalation exists yet");

  const response = await lab.postWebhook({
    event_type: "charge_captured",
    event_id: "review-de7-fresh-delivery",
    provider_reference: p.authorization,
    correlation_id: "charge_start:de7:n1",
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const cases = await lateEffectCases(p.participant_id);
  console.log(`  DURABLE_ESCALATION_EVIDENCE DE-7 ${JSON.stringify({
    http: response.statusCode,
    charge_start: await chargeStartClass(p.participant_id),
    cases: cases.map((c) => c.auto_key)
  })}`);
  assert.equal(response.statusCode, 200, "DE-7: the delivery must be acknowledged once escalated");
  assert.equal(cases.length, 1, "DE-7: a committed dual capture with no case must still escalate — this is the state the old predicate could never escape");
  assert.ok(cases[0]!.auto_key.includes("dual-capture"), `DE-7: must be keyed as a dual capture: ${cases[0]!.auto_key}`);
});

const failed = summary();
await restoreCasePersistence().catch(() => undefined);
await lab.close();
process.exit(failed ? 1 : 0);
