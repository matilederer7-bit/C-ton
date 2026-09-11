// R9C ROUND 5 — ORACLE SOUNDNESS: OBSERVED-EVIDENCE controls.
//
// Codex (round 4) showed the round-4 oracle still leaked time in ONE place:
// it positioned a provider STATUS answer by the provider's own request log
// position (`seq`/`at` — assigned when the provider RECEIVED the query and
// generated its answer), not by the moment that answer was DELIVERED to the
// app. A status response held by the provider for 1 000 ms was therefore
// treated as known to Siton 1 000 ms before Siton could possibly have read it,
// and a second capture dispatched inside that hold was judged legal.
//
//   PROVIDER KNOWLEDGE != SITON KNOWLEDGE.
//
// THE RULE THIS FILE ENFORCES (tests/lab/dispatch_legality.ts, round 5):
//
//   A dispatch D is legal only from evidence that Siton had actually OBSERVED
//   before D:
//     * a provider answer (exact response or status read) counts only once the
//       provider had WRITTEN it back to Siton — `delivered_seq` in the
//       simulator's single monotonic log — and that position is before D
//       arrived at the provider (`delivered_seq < D.seq`);
//     * and, when Siton's ledger carries the identity the evidence is about,
//       Siton must have RECORDED the verdict before it ARMED D
//       (`resolved_at <= D.dispatched_at`, both database instants);
//     * callbacks and operator verdicts stay ordered by their database
//       receipt/record instant against the arm instant (round 4, E3/E4).
//   Provider-internal knowledge (an answer generated but not yet written), a
//   status response delivered after the dispatch, the final history, a later
//   reconciliation, a later late-money effect, or an UNKNOWN answer are never
//   evidence for an earlier dispatch.
//
// Part 1 drives the REAL simulator (the same unmodified HTTP simulator the
// financial lab uses) through Codex's exact chronology and asks the shipped
// oracle for a verdict. Part 2 feeds synthetic histories with explicit
// delivery positions. Every control asserts its chronology independently of
// the oracle, so no control can pass by accident of ordering.
//
// Against the round-4 oracle: Part 1 and the REJECT controls A, C, F and R
// FAIL (the unsafe history is accepted) — that failing run is the permanent
// reproduction of Codex's round-4 finding. Against the round-5 oracle every
// control passes.
//
// No production source is exercised; no database; synthetic money only.

import { strict as assert } from "node:assert";
import { auditFinancialTruth } from "./lab/oracle.js";
import { auditDispatchLegality } from "./lab/dispatch_legality.js";
import { startProviderSimulator, type ProviderLedgerSnapshot, type ProviderRequestRecord } from "./lab/provider_simulator.js";

const PID = "11111111-1111-4111-8111-111111111111";
const DID = "22222222-2222-4222-8222-222222222222";
const AUTH = "auth-observation-control";
const T0 = Date.parse("2026-09-11T12:00:00.000Z");
const T = (msOffset: number) => new Date(T0 + msOffset).toISOString();
const HORIZON_MS = 1500;

type ObservedRequest = ProviderRequestRecord & { delivered_seq?: number | null; delivered_at?: string | null };
type Row = {
  attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; in_flight: boolean; owner_event_uuid: string | null;
  outcome_note: string | null; dispatched_at: string | null; failure_evidence: string | null; updated_at: string | null; resolved_at: string | null;
};
type Callback = { event_type: string; correlation_id: string | null; provider_reference: string | null; received_at: string };

function row(partial: Partial<Row> & { attempt_type: string; correlation_id: string; result_class: string }): Row {
  return { dispatch_state: "responded", in_flight: false, owner_event_uuid: null, outcome_note: null, dispatched_at: null, failure_evidence: null, updated_at: null, resolved_at: null, ...partial };
}
/** a money request that ARRIVED at position `seq`; `delivered` = the position at which the provider wrote its answer back (null: never) */
function money(seq: number, at: string, op: ProviderRequestRecord["op"], key: string, answered: string, effect: boolean, delivered: number | null, deliveredAt?: string, replayed = false): ObservedRequest {
  return { seq, at, op, authorization: AUTH, idempotency_key: key, amount_minor: 4200, behavior: answered, effect_applied: effect, replayed, answered, delivered_seq: delivered, delivered_at: delivered === null ? null : (deliveredAt ?? at) };
}
/** a status read that ARRIVED at `seq` (the provider generated its answer then) and was written back at position `delivered` (null: never) */
function status(seq: number, at: string, operation: string, state: string | null, final: boolean | null, delivered: number | null, deliveredAt?: string): ObservedRequest {
  return { seq, at, op: "status", authorization: AUTH, idempotency_key: `status-${seq}`, amount_minor: null, behavior: `${operation}:control`, effect_applied: false, replayed: false, answered: "200",
    declared: { operation, state, final, delivered: delivered !== null, reference_ok: true, amount_ok: true }, delivered_seq: delivered, delivered_at: delivered === null ? null : (deliveredAt ?? at) };
}

type History = {
  name: string;
  money_state: string; buyer_state: string; deal_state: string;
  rows: Row[]; requests: ObservedRequest[]; callbacks?: Callback[]; cases?: number;
  effects: { capture: number; recover: number; refund: number; release: number; capture_amount_minor: number; recover_amount_minor: number; refund_amount_minor: number };
  expect: { verdict: "reject" | "accept"; codes?: string[]; forbid?: string[] };
  chronology: () => void;
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
  const provider: ProviderLedgerSnapshot = { effects: { [AUTH]: h.effects }, totals: h.effects, requests: h.requests as ProviderRequestRecord[] };
  return auditFinancialTruth(pool, {
    label: `observation:${h.name}`, dealIds: [DID], provider, vat: { product_rate: 0, delivery_rate: 0, platform_fee_vat_rate: 0.18 }, seededStates: true, allowUnresolved: true,
    dispatchLegality: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true }
  } as any);
}

const CAPTURED = { capture: 1, recover: 0, refund: 0, release: 0, capture_amount_minor: 4200, recover_amount_minor: 0, refund_amount_minor: 0 };
const RECOVERED = { capture: 0, recover: 1, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 4200, refund_amount_minor: 0 };
const K1 = `capture:evt:n1:${PID}`, K2 = `capture:evt:n2:${PID}`, R1 = `recovery:evt:n1:${PID}`;
const REPEAT = ["AUTOMATIC_REPEAT_WHILE_UNKNOWN"];

// ── Part 2: synthetic histories with explicit delivery positions ────────────
//
// Chronology vocabulary (task §1): T1 previous money operation dispatched,
// T2 status query issued, T3 provider has/generates the final answer,
// T4 retry dispatched, T5 answer delivered to / observed by Siton.
const histories: History[] = [
  // A — retry before the status response is delivered, although the provider already generated it
  {
    name: "A retry-before-status-delivery (provider knows, Siton does not)",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(4000), updated_at: T(4000) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(2990), updated_at: T(3100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false, 2),               // T1: K1 pending (no effect)
      status(3, T(2000), "capture", "authorized", true, 6, T(4000)),          // T2/T3: query arrives, provider generates authorized/final ... written back only at position 6 (T5)
      money(4, T(3000), "capture", K2, "200", true, 5)                        // T4: K2 dispatched INSIDE the hold  ← illegal
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(3 < 4 && 6 > 4, "status arrived (3) before K2 (4) but was delivered (6) after it"); assert.ok(Date.parse(T(4000)) > Date.parse(T(2990)), "Siton recorded the verdict after arming K2"); }
  },
  // A' — the SAME history but Siton waited: delivered before K2, recorded before arm
  {
    name: "A' retry-after-status-delivery (control of A)",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(2100), updated_at: T(2100) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(2990), updated_at: T(3100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false, 2),
      status(3, T(2000), "capture", "authorized", true, 4, T(2050)),          // written back at position 4, before K2
      money(5, T(3000), "capture", K2, "200", true, 6)
    ],
    expect: { verdict: "accept", forbid: REPEAT },
    chronology() { assert.ok(4 < 5, "status delivered (4) before K2 arrived (5)"); assert.ok(Date.parse(T(2100)) <= Date.parse(T(2990)), "verdict recorded before K2 was armed"); }
  },
  // B — retry before a failure callback is delivered (the callback is received after the arm)
  {
    name: "B retry-before-callback-delivery",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "provider_event", dispatched_at: T(0), resolved_at: T(3000), updated_at: T(3000) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false, 2),                        // K1: 503 after dispatch → UNKNOWN
      money(3, T(2010), "recover", R1, "200", true, 4)                        // recovery dispatched before the callback existed
    ],
    callbacks: [{ event_type: "charge_failed", correlation_id: K1, provider_reference: AUTH, received_at: T(3000) }],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(Date.parse(T(3000)) > Date.parse(T(2000)), "callback received after the recovery was armed"); }
  },
  // C — retry while the prior outcome is unknown TO SITON: the exact decline was generated but never delivered
  {
    name: "C retry-while-decline-never-delivered",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "unknown", dispatch_state: "responded", dispatched_at: T(0), updated_at: T(300) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "402", false, null),                     // provider DECLINED but the answer never reached Siton (socket lost)
      money(2, T(1010), "capture", K2, "200", true, 3)                        // K2 while K1's outcome is unknown to Siton  ← illegal
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.equal((histories.find((h) => h.name.startsWith("C "))!.requests[0] as ObservedRequest).delivered_seq, null, "the 402 was never delivered"); }
  },
  // D — retry legalised only by a LATER reconciliation (round-4 control C, kept)
  {
    name: "D retry-legalised-only-by-later-reconciliation",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(5000), updated_at: T(5000) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false, 2),
      money(3, T(1010), "capture", K2, "200", true, 4),
      status(5, T(5000), "capture", "failed", true, 6)                        // reconciliation AFTER the retry
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(5 > 3, "reconciliation read positioned after the retry"); }
  },
  // E — retry legalised only by a LATER late-money effect (round-4 control B, kept)
  {
    name: "E retry-legalised-only-by-later-late-money-effect",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED, cases: 1,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", outcome_note: "late_money_effect:charge_captured:late", dispatched_at: T(0), resolved_at: T(5000), updated_at: T(5000) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(1000), resolved_at: T(1100), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false, 2),
      money(3, T(1010), "capture", K2, "402", false, 4)
    ],
    callbacks: [{ event_type: "charge_captured", correlation_id: K1, provider_reference: AUTH, received_at: T(5000) }],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(Date.parse(T(5000)) > Date.parse(T(1000)), "late effect after the retry"); }
  },
  // F — recovery dispatched using FUTURE provider knowledge (status generated before, delivered after the recovery)
  {
    name: "F recovery-on-undelivered-status",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(2600), updated_at: T(2600) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2190), updated_at: T(2300) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false, 2),
      status(3, T(1700), "capture", "failed", true, 6, T(2600)),              // post-horizon, final, authoritative — but delivered only at position 6
      money(4, T(2200), "recover", R1, "200", true, 5)                        // recovery inside the hold  ← illegal
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(1700 >= 10 + HORIZON_MS, "read is post-horizon (so ONLY delivery order can reject it)"); assert.ok(6 > 4, "delivered after the recovery arrived"); }
  },
  // R — delivered before the dispatch, but Siton armed the retry BEFORE recording the verdict (later DB state must not legalise it)
  {
    name: "R delivered-but-recorded-after-arm",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(3200), updated_at: T(3200) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(2990), updated_at: T(3100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false, 2),
      status(3, T(2000), "capture", "authorized", true, 4, T(2050)),          // delivered before K2 …
      money(5, T(3000), "capture", K2, "200", true, 6)                        // … but K2 was armed (T2990) before the verdict was recorded (T3200)
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(4 < 5, "delivered before K2"); assert.ok(Date.parse(T(3200)) > Date.parse(T(2990)), "recorded after arm"); }
  },
  // G — retry after the final authoritative status response was actually observed and recorded
  {
    name: "G retry-after-observed-final-status",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(1650), updated_at: T(1650) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(1700), updated_at: T(1800) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false, 2),
      status(3, T(1600), "capture", "failed", true, 4, T(1620)),
      money(5, T(1710), "recover", R1, "200", true, 6)
    ],
    expect: { verdict: "accept", forbid: REPEAT },
    chronology() { assert.ok(4 < 5 && Date.parse(T(1650)) <= Date.parse(T(1700)), "observed and recorded before the recovery"); }
  },
  // H — retry after an exact synchronous decline was returned to Siton
  {
    name: "H retry-after-returned-exact-decline",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(0), resolved_at: T(40), updated_at: T(40) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "402", false, 2, T(30)),
      money(3, T(1010), "capture", K2, "200", true, 4)
    ],
    expect: { verdict: "accept", forbid: REPEAT },
    chronology() { assert.ok(2 < 3 && Date.parse(T(40)) <= Date.parse(T(1000)), "decline returned and recorded before K2"); }
  },
  // I — retry after an authenticated failure callback was received
  {
    name: "I retry-after-received-failure-callback",
    money_state: "RecoveredCharge", buyer_state: "DealCompleted", deal_state: "Completed", effects: RECOVERED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "provider_event", dispatched_at: T(0), resolved_at: T(800), updated_at: T(800) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false, 2),
      money(3, T(2010), "recover", R1, "200", true, 4)
    ],
    callbacks: [{ event_type: "charge_failed", correlation_id: K1, provider_reference: AUTH, received_at: T(800) }],
    expect: { verdict: "accept", forbid: REPEAT },
    chronology() { assert.ok(Date.parse(T(800)) < Date.parse(T(2000)), "callback received before the arm"); }
  },
  // ── layer isolation: the ledger CLAIMS an early verdict (a lying or buggy app); only the provider log can reject ──
  // A2 — as A, but Siton's rows claim the verdict was recorded before the arm: the undelivered answer must still not count
  {
    name: "A2 provider-held-answer, ledger claims early record",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(2100), updated_at: T(2100) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(2990), updated_at: T(3100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "200-pending", false, 2),
      status(3, T(2000), "capture", "authorized", true, 6, T(4000)),          // generated at 3, written back only at 6
      money(4, T(3000), "capture", K2, "200", true, 5)
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(6 > 4, "provider wrote the answer after K2 arrived"); assert.ok(Date.parse(T(2100)) <= Date.parse(T(2990)), "the ledger (untrusted) claims an early record"); }
  },
  // C2 — as C, but the ledger claims the decline was recorded: a never-delivered decline must still not count
  {
    name: "C2 decline-never-delivered, ledger claims early record",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(0), resolved_at: T(50), updated_at: T(50) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "402", false, null),                     // declined, never written back
      money(2, T(1010), "capture", K2, "200", true, 3)
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(Date.parse(T(50)) <= Date.parse(T(1000)), "the ledger (untrusted) claims an early record"); }
  },
  // L1 — an ambiguous 503 was delivered and the ledger claims a verdict: UNKNOWN is never failed, whatever the row says
  {
    name: "L1 503-delivered, ledger claims early verdict",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(0), resolved_at: T(50), updated_at: T(50) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false, 2),                        // ambiguous answer, delivered
      money(3, T(1010), "capture", K2, "200", true, 4)
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(2 < 3, "delivered before K2 — only its ambiguity can reject it"); }
  },
  // U — an UNKNOWN / non-final answer delivered before the retry is still not evidence (UNKNOWN is never failed)
  {
    name: "U non-final-status-delivered-is-not-evidence",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [
      row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(2100), updated_at: T(2100) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(2990), updated_at: T(3100) })
    ],
    requests: [
      money(1, T(10), "capture", K1, "503", false, 2),
      status(3, T(2000), "capture", "authorized", false, 4, T(2050)),         // delivered, post-horizon, a non-executed STATE — but NOT final → unknown
      money(5, T(3000), "capture", K2, "200", true, 6)
    ],
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(4 < 5, "delivered before K2 — only its non-finality can reject it"); }
  },
  // J — safe duplicate delivery: the same identity replayed, no second provider dispatch
  {
    name: "J same-identity-replay-no-second-dispatch",
    money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed", effects: CAPTURED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "success", dispatched_at: T(0), resolved_at: T(100), updated_at: T(100) })],
    requests: [
      money(1, T(10), "capture", K1, "200", true, 2),
      money(3, T(500), "capture", K1, "200", false, 4, undefined, true)       // replay of the SAME key: provider dedupes, no effect
    ],
    expect: { verdict: "accept", forbid: [...REPEAT, "DUPLICATE_CAPTURE"] },
    chronology() { assert.ok(true); }
  }
];

// ── Part 1: the real simulator, Codex's exact chronology ────────────────────
async function realSimulatorHeldStatus(): Promise<{ reject: boolean; accept: boolean; detail: Record<string, unknown> }> {
  const sim = startProviderSimulator({ clientTimeoutMs: 2000 });
  const base = await sim.ready;
  const auth = "auth-observation-real";
  const send = async (key: string) => {
    const response = await fetch(`${base}/capture`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ authorization_id: auth, amount_minor: 4200 }) });
    return response.json();
  };
  const rowsFor = (requests: ObservedRequest[], resolvedAt: string) => {
    const captures = requests.filter((r) => r.op === "capture");
    return [
      row({ attempt_type: "charge_start", correlation_id: "first", result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: new Date(Date.parse(captures[0]!.at) - 1).toISOString(), resolved_at: resolvedAt, updated_at: resolvedAt }),
      row({ attempt_type: "charge_start", correlation_id: "second", result_class: "success", dispatched_at: new Date(Date.parse(captures[1]!.at) - 1).toISOString(), updated_at: new Date(Date.parse(captures[1]!.at) + 5).toISOString() })
    ];
  };
  const legalityOf = (requests: ObservedRequest[], rows: Row[]) => auditDispatchLegality({ authorization: auth, requests: requests as any, rows: rows as any, callbacks: [], policy: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true } });
  try {
    // ── unsafe chronology: T1 pending capture · T2 status query · T3 provider generated authorized/final · T4 second capture · T5 delivery ──
    sim.script(auth, "capture", [{ kind: "PENDING_NO_EFFECT" }, { kind: "SUCCESS" }]);
    await send("first");                                                                  // T1
    await new Promise((r) => setTimeout(r, HORIZON_MS + 50));                              // respect the settlement horizon (only delivery order can reject)
    sim.scriptStatus(auth, [{ kind: "TIMEOUT", holdMs: 1000 }]);                           // provider HOLDS its final answer for 1 000 ms (inside the client timeout)
    let received = false;
    const statusRead = fetch(`${base}/status/${auth}?operation=capture`).then((r) => r.json()).then((b) => { received = true; return b; });   // T2
    const deadline = Date.now() + 500;
    while (!sim.requestsOf(auth, "status").length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(sim.requestsOf(auth, "status").length, 1, "the query reached the provider (T3: answer generated)");
    assert.equal(received, false, "the answer has NOT reached Siton");
    await send("second");                                                                 // T4: second capture inside the hold
    assert.equal(received, false, "second capture completed BEFORE the status answer was delivered");
    const atDispatch = sim.snapshot().requests.map((r) => ({ ...r })) as ObservedRequest[];
    const statusBody = await statusRead;                                                  // T5: delivery
    const deliveredAt = new Date().toISOString();
    const finalRequests = sim.snapshot().requests as ObservedRequest[];
    const unsafe = legalityOf(finalRequests, rowsFor(finalRequests, deliveredAt));
    const reject = unsafe.violations.some((v) => v.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN");

    // ── control: the SAME steps, but Siton waits for the delivered answer before the second capture ──
    const auth2 = "auth-observation-real-control";
    sim.script(auth2, "capture", [{ kind: "PENDING_NO_EFFECT" }, { kind: "SUCCESS" }]);
    const send2 = async (key: string) => (await fetch(`${base}/capture`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ authorization_id: auth2, amount_minor: 4200 }) })).json();
    await send2("first");
    await new Promise((r) => setTimeout(r, HORIZON_MS + 50));
    sim.scriptStatus(auth2, [{ kind: "TIMEOUT", holdMs: 300 }]);
    await fetch(`${base}/status/${auth2}?operation=capture`).then((r) => r.json());       // delivered (awaited)
    const recordedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await send2("second");
    const controlRequests = sim.snapshot().requests.filter((r) => r.authorization === auth2) as ObservedRequest[];
    const control = auditDispatchLegality({ authorization: auth2, requests: controlRequests as any, rows: rowsFor(controlRequests, recordedAt) as any, callbacks: [], policy: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true } });
    const accept = !control.violations.some((v) => v.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN");
    return { reject, accept, detail: { status_delivered_when_second_dispatched: false, status_body_state: statusBody?.state, requests_at_dispatch: atDispatch, final_requests: finalRequests, unsafe_judgements: unsafe.judgements, unsafe_violations: unsafe.violations, control_violations: control.violations, effects: sim.effectsOf(auth) } };
  } finally { await sim.close(); }
}

// ── run ──────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const fail = (name: string, message: string) => { failed += 1; console.log(`FAIL ${name}: ${message}`); };
const pass = (name: string) => { passed += 1; console.log(`PASS ${name}`); };

console.log("R5 ORACLE OBSERVED-EVIDENCE CONTROLS");
{
  const name = "P1 real simulator: held status answer must not legalise a capture dispatched inside the hold";
  try {
    const r = await realSimulatorHeldStatus();
    console.log(`P1 detail: ${JSON.stringify({ unsafe_violations: r.detail.unsafe_violations, control_violations: r.detail.control_violations, effects: r.detail.effects })}`);
    if (!r.reject) fail(name, "UNSAFE HISTORY ACCEPTED: the second capture was judged legal on a status answer Siton had not received");
    else if (!r.accept) fail(name, "control rejected: a capture after the delivered answer must be legal");
    else pass(name);
  } catch (error) { fail(name, String((error as Error)?.stack || error)); }
}
for (const h of histories) {
  try {
    h.chronology();
    const report = await judge(h);
    const codes = report.violations.map((v: any) => v.code);
    if (h.expect.verdict === "reject") {
      const wanted = h.expect.codes || [];
      if (!wanted.some((c) => codes.includes(c))) { fail(h.name, `expected ${wanted.join("|")}, oracle produced [${codes.join(", ")}]`); continue; }
    } else {
      const forbidden = (h.expect.forbid || []).filter((c) => codes.includes(c));
      if (forbidden.length) { fail(h.name, `forbidden ${forbidden.join("|")} produced (all: [${codes.join(", ")}])`); continue; }
    }
    pass(h.name);
  } catch (error) { fail(h.name, String((error as Error)?.stack || error)); }
}
console.log(`\nSUMMARY review_oracle_observation_negative passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
