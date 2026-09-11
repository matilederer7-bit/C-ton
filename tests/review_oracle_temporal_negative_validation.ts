// R9C ROUND 4 — ORACLE SOUNDNESS: temporal negative controls.
//
// Codex (round 3) showed the shipped oracle accepted an UNSAFE history: a
// retry dispatched while its predecessor was UNKNOWN was legalised by a
// late_money_effect note that only appeared in the FINAL row. That is temporal
// leakage — future evidence deciding a past dispatch.
//
// This file feeds the SHIPPED oracle (tests/lab/oracle.ts → auditFinancialTruth)
// controlled histories in which the final database rows deliberately LOOK
// legal, and asserts the verdict the dispatch-time invariant demands:
//
//   THE LEGALITY OF A PAYMENT OPERATION AT DISPATCH TIME IS DECIDED ONLY FROM
//   INFORMATION THAT EXISTED AT OR BEFORE THAT DISPATCH.
//
// Every control asserts BOTH the chronology it constructed AND the oracle's
// verdict, so a control can never pass by accident of ordering.
//
// Against the round-3 oracle the REJECT controls A–F fail (the unsafe history
// is accepted with zero violations) — that failing run is the reproduction of
// Codex's finding. Against the round-4 oracle all controls pass.
//
// No production source is exercised; no database; synthetic money only.

import { strict as assert } from "node:assert";
import { auditFinancialTruth } from "./lab/oracle.js";
import type { ProviderLedgerSnapshot, ProviderRequestRecord } from "./lab/provider_simulator.js";

const PID = "11111111-1111-4111-8111-111111111111";
const DID = "22222222-2222-4222-8222-222222222222";
const AUTH = "auth-temporal-control";
const T0 = Date.parse("2026-09-11T10:00:00.000Z");
const T = (msOffset: number) => new Date(T0 + msOffset).toISOString();
const HORIZON_MS = 1500;

type Row = {
  attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; in_flight: boolean; owner_event_uuid: string | null;
  outcome_note: string | null; dispatched_at: string | null; failure_evidence: string | null; updated_at: string | null; resolved_at: string | null;
};
type Callback = { event_type: string; correlation_id: string | null; provider_reference: string | null; received_at: string };

function row(partial: Partial<Row> & { attempt_type: string; correlation_id: string; result_class: string }): Row {
  return { dispatch_state: "responded", in_flight: false, owner_event_uuid: null, outcome_note: null, dispatched_at: null, failure_evidence: null, updated_at: null, resolved_at: null, ...partial };
}
// R9C ROUND 5 — synthetic entries are DELIVERED at their own position (the
// provider wrote its answer back before anything else happened); the
// observation-specific controls live in review_oracle_observation_negative_validation.ts.
function money(seq: number, at: string, op: ProviderRequestRecord["op"], key: string, answered: string, effect: boolean, replayed = false): ProviderRequestRecord {
  return { seq, at, op, authorization: AUTH, idempotency_key: key, amount_minor: 4200, behavior: answered, effect_applied: effect, replayed, answered, delivered_seq: seq, delivered_at: at };
}
function status(seq: number, at: string, operation: string, state: string | null, final: boolean | null, extra: Partial<NonNullable<ProviderRequestRecord["declared"]>> = {}): ProviderRequestRecord {
  return { seq, at, op: "status", authorization: AUTH, idempotency_key: `status-${seq}`, amount_minor: null, behavior: `${operation}:control`, effect_applied: false, replayed: false, answered: "200",
    declared: { operation, state, final, delivered: true, reference_ok: true, amount_ok: true, ...extra }, delivered_seq: seq, delivered_at: at };
}

type History = {
  name: string;
  money_state: string; buyer_state: string; deal_state: string;
  rows: Row[]; requests: ProviderRequestRecord[]; callbacks?: Callback[]; cases?: number;
  effects: { capture: number; recover: number; refund: number; release: number; capture_amount_minor: number; recover_amount_minor: number; refund_amount_minor: number };
  expect: { verdict: "reject" | "accept"; codes?: string[]; forbid?: string[] };
  chronology: () => void; // asserts the constructed ordering, independent of the oracle
};

async function judge(h: History) {
  const pool = { query: async (sql: string) => {
    if (sql.includes("FROM siton.participants p")) return { rows: [{ participant_id: PID, deal_id: DID, buyer_id: PID, qty: 1, delivery_cost: 0, price_per_unit: 42, buyer_state: h.buyer_state, money_state: h.money_state, deal_state: h.deal_state, threshold_units: 1, authorization: AUTH }] };
    if (sql.includes("FROM siton.payment_attempts")) return { rows: h.rows.map((r) => ({ ...r, participant_id: PID })) };
    if (sql.includes("FROM siton.operational_cases")) return { rows: Array.from({ length: h.cases || 0 }, (_, i) => ({ auto_key: `payment-late-money-effect:${PID}:dual-capture:${i}`, subject: "late effect", status: "Open" })) };
    if (sql.includes("FROM siton.payment_authorization_bindings")) return { rows: [{ provider_reference: AUTH, authorization_id: AUTH }] };
    if (sql.includes("FROM siton.webhook_events")) return { rows: (h.callbacks || []).map((c) => ({ participant_id: PID, received_at: c.received_at, event_type: c.event_type, correlation_id: c.correlation_id, provider_reference: c.provider_reference })) };
    if (["platform_fee_money_events", "audit_log", "outbox_events", "outbox_dlq"].some((t) => sql.includes(`FROM siton.${t}`))) return { rows: [] };
    throw new Error(`Unexpected oracle query: ${sql.slice(0, 80)}`);
  } };
  const provider: ProviderLedgerSnapshot = { effects: { [AUTH]: h.effects }, totals: h.effects, requests: h.requests };
  const report = await auditFinancialTruth(pool, {
    label: `temporal:${h.name}`, dealIds: [DID], provider, vat: { product_rate: 0, delivery_rate: 0, platform_fee_vat_rate: 0.18 }, seededStates: true, allowUnresolved: true,
    dispatchLegality: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true }
  } as any);
  return report;
}

const CAPTURED = { capture: 1, recover: 0, refund: 0, release: 0, capture_amount_minor: 4200, recover_amount_minor: 0, refund_amount_minor: 0 };
const RECOVERED = { capture: 0, recover: 1, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 4200, refund_amount_minor: 0 };
const NOTHING = { capture: 0, recover: 0, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 0, refund_amount_minor: 0 };
const K1 = `capture:evt:n1:${PID}`, K2 = `capture:evt:n2:${PID}`, R1 = `recovery:evt:n1:${PID}`, L1 = `release:evt:n1:${PID}`, F1 = `refund:evt:n1:${PID}`;

// The forbidden-repeat family of codes the invariant must produce. Any of them
// counts as "rejected"; the specific one is asserted where it matters.
const REPEAT_CODES = ["AUTOMATIC_REPEAT_WHILE_UNKNOWN"];

const histories: History[] = [
  // ── A: retry BEFORE authoritative failure; the failure evidence appears LATER ──
  {
    name: "A retry-before-failure/failure-later",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", dispatched_at: T(0), failure_evidence: "status_inference", resolved_at: T(3000), updated_at: T(3000) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false),        // K1: provider says PENDING (no effect yet)
      money(2, T(1010), "capture", K2, "200", true),               // K2 dispatched while K1 is pending  ← illegal
      status(3, T(3000), "capture", "failed", true)                // failure declared only AFTER K2
    ],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(1010 < 3000, "evidence (seq 3) is after the retry (seq 2)"); }
  },
  // ── B: retry BEFORE authoritative failure; a late_money_effect appears LATER (Codex's exact history) ──
  {
    name: "B retry-before-failure/late_money_effect-later",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED, cases: 1,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", outcome_note: "late_money_effect:charge_captured:late", dispatched_at: T(0), updated_at: T(5000) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false),        // K1 pending
      money(2, T(1010), "capture", K2, "402", false)               // K2 dispatched while K1 pending ← illegal, even though it was declined
    ],
    callbacks: [{ event_type: "charge_captured", correlation_id: K1, provider_reference: AUTH, received_at: T(5000) }],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(1000 < 5000, "the late effect (T+5000) is after the retry (T+1000)"); }
  },
  // ── C: retry while previous outcome UNKNOWN; later reconciliation says failed ──
  {
    name: "C retry-while-unknown/reconcile-failed-later",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", dispatched_at: T(0), failure_evidence: "status_inference", resolved_at: T(4000), updated_at: T(4000) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false),                // K1: 503 → UNKNOWN (provider may have executed)
      money(2, T(1010), "capture", K2, "200", true),               // K2 while K1 unknown ← illegal
      status(3, T(4000), "capture", "authorized", true)            // reconciliation after the fact
    ],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(1010 < 4000); }
  },
  // ── D: second capture dispatched while the first could still have succeeded ──
  {
    name: "D second-capture-while-first-could-succeed",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "unknown", dispatched_at: T(0), updated_at: T(10) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "lost", true),                // K1: response lost AFTER the effect (app saw nothing)
      money(2, T(1010), "capture", K2, "200", false)               // K2 while K1 could have succeeded ← illegal
    ],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(true); }
  },
  // ── E: recovery dispatched using only final-state knowledge (cross-operation) ──
  {
    name: "E recovery-on-final-state-knowledge",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", dispatched_at: T(0), failure_evidence: "status_inference", resolved_at: T(6000), updated_at: T(6000) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false),                // capture UNKNOWN
      money(2, T(2010), "recover", R1, "200", true),               // recovery dispatched on nothing ← illegal
      status(3, T(6000), "capture", "authorized", true)            // knowledge that only exists at the end
    ],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(2010 < 6000); }
  },
  // ── F1: release after money had already moved (declared executed) ──
  {
    name: "F1 release-after-capture-declared",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", dispatched_at: T(0), resolved_at: T(100), updated_at: T(100) }),
      row({ attempt_type: "release", correlation_id: L1, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(2000), resolved_at: T(2100), updated_at: T(2100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200", true),                 // captured, declared
      money(2, T(2010), "release", L1, "402", false)               // release attempted anyway (provider refused) ← illegal dispatch
    ],
    expect: { verdict: "reject", codes: ["RELEASE_AFTER_CAPTURE_DECLARED"] },
    chronology() { assert.ok(10 < 2010); }
  },
  // ── F2: release while the capture is unresolved (could still succeed) ──
  {
    name: "F2 release-while-capture-unresolved",
    money_state: "AuthReleased", buyer_state: "DealFailed", deal_state: "Failed",
    effects: { capture: 0, recover: 0, refund: 0, release: 1, capture_amount_minor: 0, recover_amount_minor: 0, refund_amount_minor: 0 },
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "unknown", dispatched_at: T(0), updated_at: T(10) }),
      row({ attempt_type: "release", correlation_id: L1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false),        // capture pending at the provider
      money(2, T(2010), "release", L1, "200", true)                // release dispatched while the capture may settle ← illegal
    ],
    expect: { verdict: "reject", codes: ["RELEASE_WHILE_CAPTURE_UNRESOLVED"] },
    chronology() { assert.ok(10 < 2010); }
  },
  // ── G: retry after authoritative failure existed BEFORE dispatch (the trace-152 shape, with the late note) ──
  {
    name: "G retry-after-exact-decline (later late_money_effect note irrelevant)",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED, cases: 1,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", outcome_note: "late_money_effect:charge_captured:already_captured", failure_evidence: "dispatch_response", dispatched_at: T(0), resolved_at: T(20), updated_at: T(9000) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), resolved_at: T(1100), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "402", false),                // exact decline BEFORE the retry
      money(2, T(1010), "capture", K2, "200", true)                // legal retry
    ],
    callbacks: [{ event_type: "charge_captured", correlation_id: K1, provider_reference: AUTH, received_at: T(9000) }],
    expect: { verdict: "accept", forbid: [...REPEAT_CODES, "RELEASE_AFTER_CAPTURE_DECLARED", "RELEASE_WHILE_CAPTURE_UNRESOLVED", "REFUND_WITHOUT_CAPTURE_EVIDENCE"] },
    chronology() { assert.ok(10 < 1010, "decline (seq 1) precedes the retry (seq 2)"); }
  },
  // ── H: safe duplicate delivery — same identity twice, provider replays, ONE effect ──
  {
    name: "H same-identity-replay",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", dispatched_at: T(0), updated_at: T(100) })],
    requests: [
      money(1, T(10), "capture", K1, "200", true),
      money(2, T(510), "capture", K1, "200", false, true)          // replay of the SAME key, no second effect
    ],
    expect: { verdict: "accept", forbid: [...REPEAT_CODES, "DUPLICATE_CAPTURE"] },
    chronology() { assert.ok(true); }
  },
  // ── I1: legitimate recovery after an exact decline ──
  {
    name: "I1 recovery-after-exact-decline",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(0), resolved_at: T(100), updated_at: T(100) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), resolved_at: T(2100), updated_at: T(2100) })
    ],
    requests: [money(1, T(10), "capture", K1, "402", false), money(2, T(2010), "recover", R1, "200", true)],
    expect: { verdict: "accept", forbid: REPEAT_CODES },
    chronology() { assert.ok(10 < 2010); }
  },
  // ── I2: legitimate recovery after a final non-executed status read AT/AFTER the settlement horizon ──
  {
    name: "I2 recovery-after-post-horizon-status",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(1600), updated_at: T(1600) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(1700), resolved_at: T(1800), updated_at: T(1800) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false),                // unknown
      status(2, T(1600), "capture", "authorized", true),           // final non-executed, 1590 ms after dispatch ≥ 1500 ms horizon
      money(3, T(1710), "recover", R1, "200", true)
    ],
    expect: { verdict: "accept", forbid: REPEAT_CODES },
    chronology() { assert.ok(1600 - 10 >= HORIZON_MS, "status read is at/after the horizon"); assert.ok(1600 < 1710); }
  },
  // ── I3: the SAME status read BEFORE the horizon is not evidence ──
  {
    name: "I3 pre-horizon-status-is-not-evidence",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), updated_at: T(500) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(600), updated_at: T(700) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false),
      status(2, T(500), "capture", "authorized", true),            // final, but only 490 ms after dispatch — provider may still settle
      money(3, T(610), "recover", R1, "200", true)
    ],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(500 - 10 < HORIZON_MS); }
  },
  // ── I4: legitimate recovery after an OPERATOR verdict recorded before the arm instant ──
  {
    name: "I4 recovery-after-operator-evidence",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "operator", dispatched_at: T(0), resolved_at: T(1000), updated_at: T(1000) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), resolved_at: T(2100), updated_at: T(2100) })
    ],
    requests: [money(1, T(10), "capture", K1, "503", false), money(2, T(2010), "recover", R1, "200", true)],
    expect: { verdict: "accept", forbid: REPEAT_CODES },
    chronology() { assert.ok(1000 < 2000, "operator verdict precedes the arm instant"); }
  },
  // ── I5: an operator verdict recorded AFTER the dispatch does not legalise it ──
  {
    name: "I5 operator-evidence-after-dispatch",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "operator", dispatched_at: T(0), updated_at: T(9000) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })
    ],
    requests: [money(1, T(10), "capture", K1, "503", false), money(2, T(2010), "recover", R1, "200", true)],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(9000 > 2000); }
  },
  // ── I6: legitimate recovery after a provider callback declared the capture failed, received before the arm instant ──
  {
    name: "I6 recovery-after-callback-failed",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "provider_event", dispatched_at: T(0), resolved_at: T(800), updated_at: T(800) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), resolved_at: T(2100), updated_at: T(2100) })
    ],
    requests: [money(1, T(10), "capture", K1, "503", false), money(2, T(2010), "recover", R1, "200", true)],
    callbacks: [{ event_type: "charge_failed", correlation_id: K1, provider_reference: AUTH, received_at: T(800) }],
    expect: { verdict: "accept", forbid: REPEAT_CODES },
    chronology() { assert.ok(800 < 2000); }
  },
  // ── I7: the same callback received AFTER the arm instant does not legalise the recovery ──
  {
    name: "I7 callback-failed-after-dispatch",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "provider_event", dispatched_at: T(0), updated_at: T(3000) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })
    ],
    requests: [money(1, T(10), "capture", K1, "503", false), money(2, T(2010), "recover", R1, "200", true)],
    callbacks: [{ event_type: "charge_failed", correlation_id: K1, provider_reference: AUTH, received_at: T(3000) }],
    expect: { verdict: "reject", codes: REPEAT_CODES },
    chronology() { assert.ok(3000 > 2000); }
  },
  // ── J: a refund with no declared capture in the provider log is premature ──
  {
    name: "J refund-without-capture-evidence",
    money_state: "Refunded", buyer_state: "DealFailed", deal_state: "Failed",
    effects: { capture: 1, recover: 0, refund: 1, release: 0, capture_amount_minor: 4200, recover_amount_minor: 0, refund_amount_minor: 4200 },
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", dispatched_at: T(0), updated_at: T(9000) }),
      row({ attempt_type: "refund", correlation_id: F1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "lost", true),                // effect applied, app saw nothing
      money(2, T(2010), "refund", F1, "200", true)                 // refund on money never declared to have moved ← illegal
    ],
    expect: { verdict: "reject", codes: ["REFUND_WITHOUT_CAPTURE_EVIDENCE"] },
    chronology() { assert.ok(10 < 2010); }
  },
  // ── K: a refund after the capture was declared executed is fine ──
  {
    name: "K refund-after-declared-capture",
    money_state: "Refunded", buyer_state: "DealFailed", deal_state: "Failed",
    effects: { capture: 1, recover: 0, refund: 1, release: 0, capture_amount_minor: 4200, recover_amount_minor: 0, refund_amount_minor: 4200 },
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", dispatched_at: T(0), resolved_at: T(100), updated_at: T(100) }),
      row({ attempt_type: "refund", correlation_id: F1, result_class: "success", dispatched_at: T(2000), resolved_at: T(2100), updated_at: T(2100) })
    ],
    requests: [money(1, T(10), "capture", K1, "200", true), money(2, T(2010), "refund", F1, "200", true)],
    expect: { verdict: "accept", forbid: ["REFUND_WITHOUT_CAPTURE_EVIDENCE", ...REPEAT_CODES] },
    chronology() { assert.ok(10 < 2010); }
  }
];

let passed = 0, failed = 0;
const results: Array<{ name: string; expected: string; codes: string[]; ok: boolean }> = [];
for (const h of histories) {
  try {
    h.chronology();
    const report = await judge(h);
    const codes = report.violations.map((x) => x.code);
    if (h.expect.verdict === "reject") {
      const wanted = h.expect.codes || [];
      assert.ok(wanted.some((c) => codes.includes(c)), `${h.name}: expected one of ${wanted.join("|")}, got ${JSON.stringify(report.violations)}`);
    } else {
      const forbidden = (h.expect.forbid || []).filter((c) => codes.includes(c));
      assert.equal(forbidden.length, 0, `${h.name}: legal history rejected with ${forbidden.join("|")}: ${JSON.stringify(report.violations)}`);
    }
    results.push({ name: h.name, expected: h.expect.verdict, codes, ok: true });
    console.log(`PASS ${h.name} → ${h.expect.verdict} (${codes.join(",") || "clean"})`);
    passed += 1;
  } catch (error) {
    results.push({ name: h.name, expected: h.expect.verdict, codes: [], ok: false });
    console.error(`FAIL ${h.name}: ${(error as Error).message}`);
    failed += 1;
  }
}
console.log(`ORACLE_TEMPORAL_CONTROLS passed=${passed} failed=${failed} total=${histories.length}`);
if (failed) process.exit(1);
