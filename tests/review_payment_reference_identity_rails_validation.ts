/**
 * INDEPENDENT REVIEW — exact-operation identity across EVERY money rail.
 *
 * The candidate's own collision proof (payment_final_reference_collision) tests
 * ONE path: the reconcile capture lookup. The review question is broader — a
 * provider result must never be accepted merely because a reference exists,
 * some operation succeeded, another participant's transaction succeeded, or a
 * callback looks superficially valid. So this suite attacks the SAME class of
 * defect on every remaining rail that can move or unwind money:
 *
 *   RI-1  recovery pre-flight, foreign reference, negative answer
 *         -> the dangerous one: a wrong "not captured" verdict authorises a
 *            SECOND capture of the same obligation
 *   RI-2  recovery pre-flight, foreign reference, "captured" answer
 *         -> must not manufacture a capture either
 *   RI-3  refund lookup, foreign reference -> no Refunded, no second refund
 *   RI-4  release lookup, foreign reference -> no AuthReleased, no release
 *   RI-5  late signed callback with a foreign reference, after a terminal
 *         success -> newer truth is never overwritten
 *   RI-6  late signed callback claiming a capture, foreign reference, after a
 *         released hold -> no resurrection into ChargedSuccess
 *   RI-7  another participant's authorization answering this participant's
 *         capture lookup -> refused (a sibling's success is not this success)
 *   RI-8  recorded contract boundaries: the four DEFINED operation prefixes
 *         alias the queried authorization, and an answer that echoes NO
 *         reference is treated as answering the query. Asserted so the
 *         contract cannot drift silently.
 *
 * Every scenario reads provider truth from the simulator's own effect ledger,
 * so "no money moved" is a measured fact, not an inference from local state.
 *
 * REAL MONEY: none. In-process simulator; no Grow, no credentials, no network.
 */

import assert from "node:assert/strict";
import { bootLab, makeRunner } from "./lab/runtime.js";

const lab = await bootLab({ tag: "reference-identity-rails", port: 3213 });
const { run, summary } = makeRunner("review_payment_reference_identity_rails");

/**
 * Rewrite only the provider's STATUS answers, at the transport boundary, so the
 * adapter's own reference discipline is what is under test. Capture, recovery,
 * refund and release requests reach the simulator untouched, which is what
 * makes "zero money effects" a real measurement.
 */
function interceptStatus(rewrite: (body: any, queriedReference: string) => any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url || input);
    const response = await originalFetch(input, init);
    if (!url.includes("/status/")) return response;
    const queried = decodeURIComponent(url.split("/status/")[1]!.split("?")[0]!);
    let body: any = {};
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    const rewritten = rewrite(body, queried);
    if (rewritten === null) return response;
    return new Response(JSON.stringify(rewritten), { status: 200, headers: { "content-type": "application/json" } });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const FOREIGN = (queried: string) => `xyz-${queried}`;

/** Provider-side money effects for one authorization, from the simulator ledger. */
function effects(auth: string) {
  const e = lab.sim.effectsOf(auth);
  return { capture: e.capture, recover: e.recover, refund: e.refund, release: e.release, total: e.capture + e.recover + e.refund + e.release };
}

function evidence(name: string, payload: Record<string, unknown>) {
  console.log(`  REFERENCE_IDENTITY_EVIDENCE ${name} ${JSON.stringify(payload)}`);
}

// ── RI-1 / RI-2 — the recovery pre-flight ───────────────────────────────────
// A capture whose failure was only INFERRED from status reads, inside an
// authoritative provider contract with an elapsed horizon, is the one shape in
// which the rails are allowed to send a recovery capture at all. If a FOREIGN
// status answer can drive that decision, a second capture of the same
// obligation follows — the double-money outcome this review exists to prevent.
async function recoveryPreflightScenario(name: string, foreignState: "failed" | "captured") {
  const deal = await lab.seedDeal({
    state: "CompletionWindow",
    threshold_units: 1,
    completionWindowUntil: new Date(Date.now() + 10 * 60_000),
    participants: [
      {
        buyer_state: "ChargeFailedCompletion",
        money_state: "ChargeFailedRecovery",
        priorAttempts: [
          {
            attempt_type: "charge_start",
            result_class: "permanent_fail",
            // a status-INFERRED failure: not the provider's answer to the exact
            // request, so the pre-flight must establish the truth itself
            failure_evidence: "status_inference",
            negative_finality_authoritative: true,
            settlement_horizon_at: new Date(Date.now() - 5_000),
            dispatched_at: new Date(Date.now() - 120_000)
          }
        ]
      }
    ]
  });
  const p = deal.participants[0]!;
  // A recovery, if it were dispatched, would succeed — so the ONLY thing that
  // can keep provider effects at zero is refusing the foreign evidence.
  lab.sim.script(p.authorization, "recover", [{ kind: "SUCCESS" }]);
  const restore = interceptStatus((body, queried) => ({
    ...body,
    provider_reference: FOREIGN(queried),
    state: foreignState,
    final: true,
    amount_minor: p.amount_minor,
    currency: "ILS"
  }));
  try {
    await lab.enqueueRecovery(deal.deal_id);
    await lab.drain({ dealIds: [deal.deal_id], maxRounds: 10, types: ["recovery_deal", "payment_reconcile", "payment_release"] });
  } finally {
    restore();
  }
  const participant = await lab.participant(p.participant_id);
  const attempts = await lab.attempts(p.participant_id);
  const cases = await lab.cases(p.participant_id);
  const eff = effects(p.authorization);
  evidence(name, {
    money_state: participant.money_state,
    buyer_state: participant.buyer_state,
    effects: eff,
    attempts: attempts.map((a) => `${a.attempt_type}:${a.result_class}`),
    cases: cases.map((c) => c.auto_key)
  });

  assert.equal(eff.recover, 0, `${name}: a recovery capture was dispatched on foreign evidence`);
  assert.equal(eff.capture, 0, `${name}: a capture was dispatched on foreign evidence`);
  assert.equal(eff.total, 0, `${name}: provider money moved on foreign evidence`);
  assert.ok(!attempts.some((a) => a.attempt_type === "recovery"), `${name}: a recovery identity was minted on foreign evidence`);
  assert.notEqual(participant.money_state, "RecoveredCharge", `${name}: false RecoveredCharge from foreign evidence`);
  assert.notEqual(participant.money_state, "ChargedSuccess", `${name}: false ChargedSuccess from foreign evidence`);
  assert.ok(
    cases.some((c) => c.auto_key.includes("mismatch") || c.auto_key.includes("unresolved") || c.auto_key.includes("unverifiable")),
    `${name}: the refusal left no visible operator case: ${JSON.stringify(cases.map((c) => c.auto_key))}`
  );
}

await run("RI-1 recovery pre-flight refuses a foreign negative answer (no second capture)", async () => {
  await recoveryPreflightScenario("RI-1", "failed");
});

await run("RI-2 recovery pre-flight refuses a foreign 'captured' answer (no false success)", async () => {
  await recoveryPreflightScenario("RI-2", "captured");
});

// ── RI-3 — the refund lookup ────────────────────────────────────────────────
await run("RI-3 refund lookup refuses a foreign reference (no Refunded, no second refund)", async () => {
  const deal = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [
      {
        buyer_state: "DealCompleted",
        money_state: "ChargedSuccess",
        priorAttempts: [
          { attempt_type: "charge_start", result_class: "success" },
          { attempt_type: "refund", result_class: "unknown", correlation_id: "refund:review-ri3:n1" }
        ]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.script(p.authorization, "refund", [{ kind: "SUCCESS" }]);
  const restore = interceptStatus((body, queried) => ({
    ...body,
    provider_reference: FOREIGN(queried),
    state: "refunded",
    final: true,
    amount_minor: p.amount_minor,
    currency: "ILS"
  }));
  try {
    await lab.enqueueReconcile({
      participant_id: p.participant_id,
      deal_id: deal.deal_id,
      attempt_type: "refund",
      correlation_id: "refund:review-ri3:n1",
      operation: "refund",
      provider_reference: p.authorization
    });
    await lab.drain({ dealIds: [deal.deal_id], maxRounds: 8, types: ["payment_reconcile", "refund_issue"] });
  } finally {
    restore();
  }
  const participant = await lab.participant(p.participant_id);
  const attempts = await lab.attempts(p.participant_id, "refund");
  const cases = await lab.cases(p.participant_id);
  const eff = effects(p.authorization);
  const ledger = await lab.ledger(p.participant_id);
  evidence("RI-3", { money_state: participant.money_state, effects: eff, refund_attempts: attempts.map((a) => a.result_class), cases: cases.map((c) => c.auto_key), ledger: ledger.map((l) => l.logical_entry_type) });

  assert.equal(eff.refund, 0, "RI-3: a refund was dispatched on foreign evidence");
  assert.equal(participant.money_state, "ChargedSuccess", "RI-3: money state moved on foreign refund evidence");
  assert.ok(!attempts.some((a) => a.result_class === "success"), "RI-3: the refund identity was settled success on foreign evidence");
  assert.ok(!ledger.some((l) => l.logical_entry_type === "refund_adjustment"), "RI-3: a fee reversal was written on foreign evidence");
  assert.ok(cases.some((c) => c.auto_key.includes("mismatch")), `RI-3: no reference-mismatch case: ${JSON.stringify(cases.map((c) => c.auto_key))}`);
});

// ── RI-4 — the release lookup ──────────────────────────────────────────────
await run("RI-4 release lookup refuses a foreign reference (no AuthReleased)", async () => {
  const deal = await lab.seedDeal({
    state: "CompletionWindow",
    threshold_units: 1,
    completionWindowUntil: new Date(Date.now() + 10 * 60_000),
    participants: [
      {
        buyer_state: "ChargeFailedCompletion",
        money_state: "ChargeFailedRecovery",
        priorAttempts: [
          { attempt_type: "charge_start", result_class: "permanent_fail", failure_evidence: "dispatch_response" },
          { attempt_type: "release", result_class: "unknown", correlation_id: "release:review-ri4:n1" }
        ]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.script(p.authorization, "release", [{ kind: "SUCCESS" }]);
  const restore = interceptStatus((body, queried) => ({
    ...body,
    provider_reference: FOREIGN(queried),
    state: "released",
    final: true,
    currency: "ILS"
  }));
  try {
    await lab.enqueueReconcile({
      participant_id: p.participant_id,
      deal_id: deal.deal_id,
      attempt_type: "release",
      correlation_id: "release:review-ri4:n1",
      operation: "release",
      provider_reference: p.authorization
    });
    await lab.drain({ dealIds: [deal.deal_id], maxRounds: 8, types: ["payment_reconcile", "payment_release"] });
  } finally {
    restore();
  }
  const participant = await lab.participant(p.participant_id);
  const attempts = await lab.attempts(p.participant_id, "release");
  const cases = await lab.cases(p.participant_id);
  const eff = effects(p.authorization);
  evidence("RI-4", { money_state: participant.money_state, effects: eff, release_attempts: attempts.map((a) => a.result_class), cases: cases.map((c) => c.auto_key) });

  assert.equal(eff.release, 0, "RI-4: a release was dispatched on foreign evidence");
  assert.notEqual(participant.money_state, "AuthReleased", "RI-4: false AuthReleased from foreign evidence");
  assert.ok(!attempts.some((a) => a.result_class === "success"), "RI-4: the release identity was settled success on foreign evidence");
  assert.ok(cases.some((c) => c.auto_key.includes("mismatch")), `RI-4: no reference-mismatch case: ${JSON.stringify(cases.map((c) => c.auto_key))}`);
});

// ── RI-5 / RI-6 — late signed callbacks with a foreign reference ────────────
await run("RI-5 a late foreign-reference failure callback never overwrites a captured truth", async () => {
  const deal = await lab.seedDeal({
    state: "Completed",
    threshold_units: 1,
    participants: [{ buyer_state: "DealCompleted", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }]
  });
  const p = deal.participants[0]!;
  const response = await lab.postWebhook({
    event_type: "charge_failed",
    provider_reference: FOREIGN(p.authorization),
    correlation_id: "charge_start:review-ri5:foreign",
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const participant = await lab.participant(p.participant_id);
  const audits = await lab.moneyAudits(p.participant_id);
  evidence("RI-5", { webhook_status: response.statusCode, money_state: participant.money_state, audits: audits.map((a) => `${a.state_type}:${a.from_state}->${a.to_state}`) });
  assert.equal(participant.money_state, "ChargedSuccess", "RI-5: a late foreign failure callback changed a captured money truth");
  assert.ok(!audits.some((a) => a.state_type === "money_state" && a.to_state === "ChargeFailedRecovery"), "RI-5: money truth was downgraded by a late callback");
});

await run("RI-6 a late foreign-reference capture callback cannot resurrect a released hold", async () => {
  const deal = await lab.seedDeal({
    state: "Failed",
    threshold_units: 5,
    participants: [{ buyer_state: "Dropped", money_state: "AuthReleased", priorAttempts: [{ attempt_type: "release", result_class: "success" }] }]
  });
  const p = deal.participants[0]!;
  const response = await lab.postWebhook({
    event_type: "charge_captured",
    provider_reference: FOREIGN(p.authorization),
    correlation_id: "charge_start:review-ri6:foreign",
    participant_id: p.participant_id,
    deal_id: deal.deal_id
  });
  const participant = await lab.participant(p.participant_id);
  const ledger = await lab.ledger(p.participant_id);
  const cases = await lab.cases(p.participant_id);
  evidence("RI-6", { webhook_status: response.statusCode, money_state: participant.money_state, ledger: ledger.map((l) => l.logical_entry_type), cases: cases.map((c) => c.auto_key) });
  assert.equal(participant.money_state, "AuthReleased", "RI-6: a late foreign capture callback resurrected a released hold");
  assert.ok(!ledger.some((l) => l.logical_entry_type === "charge"), "RI-6: a fee row was written for a refused late capture");
});

// ── RI-7 — a sibling participant's successful transaction ──────────────────
await run("RI-7 another participant's successful authorization cannot settle this capture", async () => {
  const deal = await lab.seedDeal({
    state: "Charging",
    threshold_units: 1,
    participants: [
      { buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" },
      { buyer_state: "DealCompleted", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }
    ]
  });
  const waiting = deal.participants[0]!;
  const sibling = deal.participants[1]!;
  // the sibling really did capture at the provider
  lab.sim.forceEffect("capture", sibling.authorization, sibling.amount_minor);
  const restore = interceptStatus((body) => ({
    ...body,
    provider_reference: sibling.authorization,
    state: "captured",
    final: true,
    amount_minor: waiting.amount_minor,
    currency: "ILS"
  }));
  try {
    await lab.enqueueReconcile({
      participant_id: waiting.participant_id,
      deal_id: deal.deal_id,
      attempt_type: "charge_start",
      correlation_id: "charge_start:review-ri7:n1",
      operation: "capture",
      provider_reference: waiting.authorization
    });
    await lab.drain({ dealIds: [deal.deal_id], maxRounds: 8, types: ["payment_reconcile"] });
  } finally {
    restore();
  }
  const participant = await lab.participant(waiting.participant_id);
  const eff = effects(waiting.authorization);
  const ledger = await lab.ledger(waiting.participant_id);
  const cases = await lab.cases(waiting.participant_id);
  evidence("RI-7", { money_state: participant.money_state, effects: eff, ledger: ledger.map((l) => l.logical_entry_type), cases: cases.map((c) => c.auto_key) });
  assert.equal(eff.total, 0, "RI-7: money moved for the waiting participant");
  assert.equal(participant.money_state, "ChargeAttempt", "RI-7: a sibling's capture settled this participant");
  assert.ok(!ledger.some((l) => l.logical_entry_type === "charge"), "RI-7: a fee row was written from a sibling's evidence");
  assert.ok(cases.some((c) => c.auto_key.includes("mismatch")), `RI-7: no reference-mismatch case: ${JSON.stringify(cases.map((c) => c.auto_key))}`);
});

// ── RI-8 — recorded contract boundaries ────────────────────────────────────
// These two shapes ARE accepted by the provider-ready adapter, by design. They
// are asserted here so that the accepted set stays exactly this size: if a
// future change widened or narrowed it, this test says so.
await run("RI-8 contract boundary: defined operation prefixes alias the queried authorization; a missing echo answers the query", async () => {
  const accepted: Record<string, string> = {};
  for (const shape of ["cap", "rec", "ref", "rel", "none"] as const) {
    const deal = await lab.seedDeal({
      state: "Charging",
      threshold_units: 1,
      participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }]
    });
    const p = deal.participants[0]!;
    const restore = interceptStatus((body, queried) => {
      const next: any = { ...body, state: "captured", final: true, amount_minor: p.amount_minor, currency: "ILS" };
      if (shape === "none") delete next.provider_reference;
      else next.provider_reference = `${shape}-${queried}`;
      return next;
    });
    try {
      await lab.enqueueReconcile({
        participant_id: p.participant_id,
        deal_id: deal.deal_id,
        attempt_type: "charge_start",
        correlation_id: `charge_start:review-ri8-${shape}:n1`,
        operation: "capture",
        provider_reference: p.authorization
      });
      await lab.drain({ dealIds: [deal.deal_id], maxRounds: 6, types: ["payment_reconcile"] });
    } finally {
      restore();
    }
    const participant = await lab.participant(p.participant_id);
    accepted[shape] = participant.money_state;
    // whatever the verdict, no money request may be dispatched by a status read
    assert.equal(effects(p.authorization).total, 0, `RI-8 ${shape}: a status read dispatched a money request`);
  }
  evidence("RI-8", accepted);
  for (const shape of ["cap", "rec", "ref", "rel", "none"] as const) {
    assert.equal(
      accepted[shape],
      "ChargedSuccess",
      `RI-8: the ${shape} shape is a DOCUMENTED accepted form of the queried reference; it became ${accepted[shape]}. If this changed deliberately, update the review contract note.`
    );
  }
});

// ── RI-9 — identity REUSE before a new dispatch ─────────────────────────────
// resolvePriorProviderAttempt is the gate that decides whether an UNRESOLVED
// money identity may be re-sent. It settles that identity from a status read,
// so a foreign answer there writes the wrong terminal truth: a foreign
// "captured" would mark the obligation paid while no money ever moved at the
// provider (Siton ships and never collects), and a foreign "failed" would
// unblock a second dispatch.
async function priorResolutionScenario(name: string, foreignState: "captured" | "failed") {
  const deal = await lab.seedDeal({
    state: "Charging",
    threshold_units: 1,
    participants: [
      {
        buyer_state: "ChargingAttempt",
        money_state: "ChargeAttempt",
        // an identity that was dispatched and never resolved: the charge rail
        // must prove its outcome before it may send anything for this obligation
        priorAttempts: [{ attempt_type: "charge_start", result_class: "unknown", correlation_id: `charge_start:review-ri9-${foreignState}:n1`, dispatch_state: "responded" }]
      }
    ]
  });
  const p = deal.participants[0]!;
  lab.sim.script(p.authorization, "capture", [{ kind: "SUCCESS" }]);
  const restore = interceptStatus((body, queried) => ({
    ...body,
    provider_reference: FOREIGN(queried),
    state: foreignState,
    final: true,
    amount_minor: p.amount_minor,
    currency: "ILS"
  }));
  try {
    await lab.enqueueCharge(deal.deal_id);
    await lab.drain({ dealIds: [deal.deal_id], maxRounds: 10, types: ["charge_deal", "payment_reconcile"] });
  } finally {
    restore();
  }
  const participant = await lab.participant(p.participant_id);
  const attempts = await lab.attempts(p.participant_id);
  const cases = await lab.cases(p.participant_id);
  const ledger = await lab.ledger(p.participant_id);
  const eff = effects(p.authorization);
  evidence(name, {
    money_state: participant.money_state,
    effects: eff,
    attempts: attempts.map((a) => `${a.attempt_type}:${a.result_class}`),
    cases: cases.map((c) => c.auto_key),
    ledger: ledger.map((l) => l.logical_entry_type)
  });

  assert.equal(eff.total, 0, `${name}: provider money moved on foreign evidence`);
  assert.notEqual(participant.money_state, "ChargedSuccess", `${name}: false ChargedSuccess from a foreign prior-resolution answer`);
  assert.ok(!attempts.some((a) => a.result_class === "success"), `${name}: an identity was settled success on foreign evidence`);
  assert.ok(!ledger.some((l) => l.logical_entry_type === "charge"), `${name}: a fee row was written on foreign evidence`);
  assert.ok(
    cases.some((c) => c.auto_key.includes("mismatch") || c.auto_key.includes("unresolved") || c.auto_key.includes("unverifiable")),
    `${name}: the refusal left no visible operator case: ${JSON.stringify(cases.map((c) => c.auto_key))}`
  );
}

await run("RI-9 identity reuse refuses a foreign 'captured' answer (no unpaid ChargedSuccess)", async () => {
  await priorResolutionScenario("RI-9a", "captured");
});

await run("RI-9b identity reuse refuses a foreign 'failed' answer (no second dispatch)", async () => {
  await priorResolutionScenario("RI-9b", "failed");
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
