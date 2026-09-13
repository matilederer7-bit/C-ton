// R9C ROUND 6 — ORACLE SOUNDNESS: CAUSAL BINDING of evidence to ONE response.
//
// Codex's final merge gate (2026-09-13) showed that the round-5 oracle still
// legalised a retry on a status answer Siton had not received: a transport hop
// held the provider's post-horizon answer, and an attempt-level `resolved_at`
// written for an EARLIER, pre-horizon read satisfied the DB clause — although
// that timestamp is not a record of the later response at all.
//
//   PROVIDER KNOWLEDGE != SITON KNOWLEDGE
//   SOME EARLIER VERDICT != A RECORD OF THIS RESPONSE
//
// THE RULE THIS FILE ENFORCES (tests/lab/dispatch_legality.ts, round 6): a
// status-read result R authorises a later money dispatch D only through the
// complete chain Q → R → delivered → RECEIVED by Siton → RECORDED by Siton → D,
// every arrow before D was SENT, with R named by its query_id, Siton's receipt
// of R recorded by the Siton-side observer (status_received), Siton's durable
// verdict recorded at COMMIT (verdict_recorded) and causally sourced from a
// received answer, and D positioned by the app's own send (dispatch_sent).
// `resolved_at` proves nothing about a response any more.
//
// Part 1 drives the REAL simulator and the REAL Siton-side observer through
// Codex's exact chronology, with a localhost transport hop that HOLDS the
// provider's post-horizon answer until after the second capture was sent.
// Part 2 feeds synthetic histories with explicit positions (N1–N9 reject,
// P1–P4 accept). Every control asserts its own chronology.
//
// Codex's own transport-window script reproduces the finding against the
// frozen round-5 tree (43e4dfc: FULL_ORACLE_VIOLATIONS=[] while the answer is
// still withheld — .tmp_r6/r6-codex-transport-vs-43e4dfc.log); the round-5
// oracle has no notion of a Siton-side receipt or a response-bound verdict, so
// these controls cannot even be expressed against it. Against the round-6
// oracle every control passes; the mutants OM-8..OM-11 re-introduce each
// round-5 shortcut and are killed by these controls.
//
// No production source is exercised; no database; synthetic money only.

import { strict as assert } from "node:assert";
import http from "node:http";
import { auditFinancialTruth } from "./lab/oracle.js";
import { auditDispatchLegality, type ObservationLike } from "./lab/dispatch_legality.js";
import { startProviderSimulator, type ObservationRecord, type ProviderLedgerSnapshot, type ProviderRequestRecord } from "./lab/provider_simulator.js";
import { installSitonObserver } from "./lab/siton_observer.js";

const PID = "11111111-1111-4111-8111-111111111111";
const DID = "22222222-2222-4222-8222-222222222222";
const AUTH = "auth-causal-control";
const T0 = Date.parse("2026-09-13T12:00:00.000Z");
const T = (msOffset: number) => new Date(T0 + msOffset).toISOString();
const HORIZON_MS = 1500;
const K1 = `capture:evt:n1:${PID}`, K2 = `capture:evt:n2:${PID}`, R1 = `recovery:evt:n1:${PID}`;
const REPEAT = ["AUTOMATIC_REPEAT_WHILE_UNKNOWN"];

// ── synthetic builders: one timeline of integer positions per history ────────
type Row = { attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; in_flight: boolean; owner_event_uuid: string | null;
  outcome_note: string | null; dispatched_at: string | null; failure_evidence: string | null; updated_at: string | null; resolved_at: string | null };
type Callback = { event_type: string; correlation_id: string | null; provider_reference: string | null; received_at: string };
function row(partial: Partial<Row> & { attempt_type: string; correlation_id: string; result_class: string }): Row {
  return { dispatch_state: "responded", in_flight: false, owner_event_uuid: null, outcome_note: null, dispatched_at: null, failure_evidence: null, updated_at: null, resolved_at: null, ...partial };
}
class Timeline {
  requests: ProviderRequestRecord[] = [];
  observations: ObservationLike[] = [];
  /** money request: sent by Siton at `sent`, arrives at `seq`, provider writes at `delivered`, Siton parses the answer at `received` */
  money(o: { sent: number | null; seq: number; at: string; op: ProviderRequestRecord["op"]; key: string; answered: string; effect: boolean; delivered: number | null; received: number | null; replayed?: boolean; process?: string; job?: string | null }) {
    this.requests.push({ seq: o.seq, at: o.at, op: o.op, authorization: AUTH, idempotency_key: o.key, amount_minor: 4200, behavior: o.answered, effect_applied: o.effect, replayed: Boolean(o.replayed), answered: o.answered,
      delivered_seq: o.delivered, delivered_at: o.delivered === null ? null : o.at, query_id: null });
    const opName = o.op === "recover" ? "recover" : o.op;
    if (o.sent !== null) this.observations.push({ seq: o.sent, kind: "dispatch_sent", process: o.process || "lab", op: opName, key: o.key, job: o.job ?? null });
    if (o.received !== null) this.observations.push({ seq: o.received, kind: "dispatch_received", process: o.process || "lab", op: opName, key: o.key, job: o.job ?? null });
    return this;
  }
  /** status query `qid`: arrives / answered at `seq` (`at` = provider clock), written at `delivered`, parsed by Siton at `received` (null: never) */
  status(o: { seq: number; at: string; qid: string; state: string; final: boolean; delivered: number | null; received: number | null; operation?: string; process?: string; job?: string | null }) {
    this.requests.push({ seq: o.seq, at: o.at, op: "status", authorization: AUTH, idempotency_key: o.qid, amount_minor: null, behavior: `${o.operation || "capture"}:control`, effect_applied: false, replayed: false, answered: "200",
      declared: { operation: o.operation || "capture", state: o.state, final: o.final, delivered: o.delivered !== null, reference_ok: true, amount_ok: true }, delivered_seq: o.delivered, delivered_at: o.delivered === null ? null : o.at, query_id: o.qid });
    if (o.received !== null) this.observations.push({ seq: o.received, kind: "status_received", process: o.process || "lab", query_id: o.qid, job: o.job ?? null });
    return this;
  }
  /** Siton COMMITTED a terminal verdict on `identity` at position `seq` */
  verdict(o: { seq: number; identity: string; result_class: "permanent_fail" | "success"; process?: string; job?: string | null }) {
    this.observations.push({ seq: o.seq, kind: "verdict_recorded", process: o.process || "lab", identities: [o.identity], result_class: o.result_class, job: o.job ?? null });
    return this;
  }
}

type History = {
  name: string;
  money_state: string; buyer_state: string; deal_state: string;
  rows: Row[]; timeline: Timeline; callbacks?: Callback[]; cases?: number;
  effects: { capture: number; recover: number; refund: number; release: number; capture_amount_minor: number; recover_amount_minor: number; refund_amount_minor: number };
  expect: { verdict: "reject" | "accept"; codes?: string[]; forbid?: string[]; evidence?: (e: any) => void };
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
  const provider: ProviderLedgerSnapshot = { effects: { [AUTH]: h.effects }, totals: h.effects, requests: h.timeline.requests, observations: h.timeline.observations as ObservationRecord[] };
  const report = await auditFinancialTruth(pool, {
    label: `causal:${h.name}`, dealIds: [DID], provider, vat: { product_rate: 0, delivery_rate: 0, platform_fee_vat_rate: 0.18 }, seededStates: true, allowUnresolved: true,
    dispatchLegality: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true }
  } as any);
  return report;
}

const CAPTURED = { capture: 1, recover: 0, refund: 0, release: 0, capture_amount_minor: 4200, recover_amount_minor: 0, refund_amount_minor: 0 };
const RECOVERED = { capture: 0, recover: 1, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 4200, refund_amount_minor: 0 };
const PAID = { money_state: "ChargedSuccess", buyer_state: "DealCompleted", deal_state: "Completed" };
const rowsFor = (secondKey: string, secondType: string, dispatchedAt: string, oldResolvedAt: string | null) => [
  row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: oldResolvedAt, updated_at: oldResolvedAt }),
  row({ attempt_type: secondType, correlation_id: secondKey, result_class: "success", dispatched_at: dispatchedAt, updated_at: dispatchedAt })
];

// Positions are one integer timeline per history. `at` is the provider clock
// (T offsets): K1 is answered PENDING at T(10); the horizon is 1500 ms, so a
// read at T(≥1510) is post-horizon and one at T(300) is pre-horizon.
const histories: History[] = [
  // N1 — provider generates the final post-horizon answer, transport withholds it, the retry is sent
  { name: "N1 status generated, withheld, retry sent", ...PAID, effects: CAPTURED,
    rows: rowsFor(K2, "charge_start", T(3000), null),
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "200-pending", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(2000), qid: "q1", state: "authorized", final: true, delivered: 6, received: 10 })      // written at 6, parsed only at 10
      .money({ sent: 7, seq: 8, at: T(3000), op: "capture", key: K2, answered: "200", effect: true, delivered: 9, received: 11 }),
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(6 < 7 && 10 > 7, "provider wrote q1 before K2 was sent, Siton parsed it after"); } },
  // N2 — Codex's key finding: an OLD, unrelated verdict already exists; the post-horizon answer is withheld
  { name: "N2 old verdict from a pre-horizon read + withheld post-horizon answer (Codex)", ...PAID, effects: CAPTURED,
    rows: rowsFor(K2, "charge_start", T(3000), T(400)),                                                                   // resolved_at EARLIER than the arm (round-5 clause satisfied)
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "200-pending", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(300), qid: "q0", state: "authorized", final: true, delivered: 6, received: 7 })          // PRE-horizon read, received
      .verdict({ seq: 8, identity: K1, result_class: "permanent_fail" })                                               // Siton recorded permanent_fail from q0
      .status({ seq: 9, at: T(2000), qid: "q1", state: "authorized", final: true, delivered: 10, received: 14 })        // POST-horizon read, written at 10, withheld until 14
      .money({ sent: 11, seq: 12, at: T(3000), op: "capture", key: K2, answered: "200", effect: true, delivered: 13, received: 15 }),
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(300 < 10 + HORIZON_MS, "q0 is pre-horizon"); assert.ok(8 < 11, "an old verdict is on record before K2"); assert.ok(14 > 11, "q1 reached Siton after K2 was sent"); } },
  // N3 — Q1 delivered and recorded but PRE-horizon; Q2 post-horizon generated and withheld
  { name: "N3 recorded pre-horizon Q1 cannot lend observation to withheld post-horizon Q2", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(350), updated_at: T(350) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2500), updated_at: T(2600) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(300), qid: "q1", state: "failed", final: true, delivered: 6, received: 7 })
      .verdict({ seq: 8, identity: K1, result_class: "permanent_fail" })
      .status({ seq: 9, at: T(1700), qid: "q2", state: "failed", final: true, delivered: 10, received: null })          // never reached Siton
      .money({ sent: 11, seq: 12, at: T(2500), op: "recover", key: R1, answered: "200", effect: true, delivered: 13, received: 14 }),
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(300 < 1510 && 1700 >= 1510, "q1 pre-horizon, q2 post-horizon"); } },
  // N4 — post-horizon answer delivered AND received, but Siton never durably recorded a verdict on K1 before the retry
  { name: "N4 received but no durable verdict before the retry", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "unknown", dispatched_at: T(0), updated_at: T(10) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2500), updated_at: T(2600) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(1700), qid: "q1", state: "failed", final: true, delivered: 6, received: 7 })             // observed
      .money({ sent: 8, seq: 9, at: T(2500), op: "recover", key: R1, answered: "200", effect: true, delivered: 10, received: 11 }),
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(7 < 8, "q1 observed before the recovery — only the missing durable verdict can reject it"); } },
  // N5 — answer delivered and received, and the verdict recorded, only AFTER the retry was sent
  { name: "N5 received and recorded after the retry was sent", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(2700), updated_at: T(2700) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2500), updated_at: T(2600) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(1700), qid: "q1", state: "failed", final: true, delivered: 6, received: 9 })
      .money({ sent: 7, seq: 8, at: T(2500), op: "recover", key: R1, answered: "200", effect: true, delivered: 10, received: 11 })
      .verdict({ seq: 12, identity: K1, result_class: "permanent_fail" }),
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(9 > 7 && 12 > 7, "receipt and record both after the send"); } },
  // N6 — two simultaneous queries; only q1 delivered/received: the evidence must be THAT response
  { name: "N6 two simultaneous queries, one delivered: evidence names the delivered one", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(1800), updated_at: T(1800) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2500), updated_at: T(2600) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(1700), qid: "q1", state: "failed", final: true, delivered: 7, received: 8 })
      .status({ seq: 6, at: T(1700), qid: "q2", state: "failed", final: true, delivered: 9, received: null })           // withheld for ever
      .verdict({ seq: 10, identity: K1, result_class: "permanent_fail" })
      .money({ sent: 11, seq: 12, at: T(2500), op: "recover", key: R1, answered: "200", effect: true, delivered: 13, received: 14 }),
    expect: { verdict: "accept", forbid: REPEAT, evidence: (e) => { assert.equal(e.kind, "status_non_executed"); assert.equal(e.query_id, "q1", "the evidence must be the delivered response, never its withheld twin"); assert.equal(e.verdict_source, "q1"); } },
    chronology() { assert.ok(8 < 11 && 10 < 11, "q1 received and its verdict committed before the recovery"); } },
  // N7 — an unrelated callback resolves K1 before a withheld status answer: the withheld answer must not be cited
  { name: "N7 callback resolves the identity; the withheld status answer is never cited", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "provider_event", dispatched_at: T(0), resolved_at: T(900), updated_at: T(900) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2500), updated_at: T(2600) })],
    callbacks: [{ event_type: "charge_failed", correlation_id: K1, provider_reference: AUTH, received_at: T(900) }],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .verdict({ seq: 5, identity: K1, result_class: "permanent_fail" })                                               // from the callback
      .status({ seq: 6, at: T(1700), qid: "q1", state: "failed", final: true, delivered: 7, received: null })           // withheld
      .money({ sent: 8, seq: 9, at: T(2500), op: "recover", key: R1, answered: "200", effect: true, delivered: 10, received: 11 }),
    expect: { verdict: "accept", forbid: REPEAT, evidence: (e) => { assert.equal(e.kind, "callback_failed", "legal through the callback only"); assert.notEqual(e.kind, "status_non_executed"); } },
    chronology() { assert.ok(Date.parse(T(900)) < Date.parse(T(2500)), "callback received before the arm"); } },
  // N8 — future final DB state (a resolved_at older than the arm, a permanent_fail row) must not back-propagate legality
  { name: "N8 final DB state cannot back-propagate: verdict committed after the send, row timestamps earlier", ...PAID, effects: CAPTURED,
    rows: rowsFor(K2, "charge_start", T(3000), T(100)),                                                                   // the row CLAIMS an early resolution
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "402", effect: false, delivered: 3, received: 4 })   // exact decline, received
      .money({ sent: 5, seq: 6, at: T(3000), op: "capture", key: K2, answered: "200", effect: true, delivered: 7, received: 8 })
      .verdict({ seq: 9, identity: K1, result_class: "permanent_fail" }),                                             // recorded only AFTER K2 was sent
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(9 > 5, "the verdict was committed after K2 was sent, whatever the row says"); } },
  // N9 — a verdict with no observed cause (no received answer, no decline, no callback) cannot prove observation
  { name: "N9 verdict without an observed source", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(500), updated_at: T(500) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2500), updated_at: T(2600) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .verdict({ seq: 5, identity: K1, result_class: "permanent_fail" })                                               // nothing received explains it
      .status({ seq: 6, at: T(1700), qid: "q1", state: "failed", final: true, delivered: 7, received: 8 })             // post-horizon, received
      .money({ sent: 9, seq: 10, at: T(2500), op: "recover", key: R1, answered: "200", effect: true, delivered: 11, received: 12 }),
    expect: { verdict: "reject", codes: REPEAT },
    chronology() { assert.ok(5 < 8, "the only received answer came after the verdict: it cannot be its source"); } },
  // P1 — exact synchronous decline returned and recorded before the retry
  { name: "P1 exact decline received and recorded before the retry", ...PAID, effects: CAPTURED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "dispatch_response", dispatched_at: T(0), resolved_at: T(40), updated_at: T(40) }),
      row({ attempt_type: "charge_start", correlation_id: K2, result_class: "success", dispatched_at: T(1000), updated_at: T(1100) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "402", effect: false, delivered: 3, received: 4 })
      .verdict({ seq: 5, identity: K1, result_class: "permanent_fail" })
      .money({ sent: 6, seq: 7, at: T(1000), op: "capture", key: K2, answered: "200", effect: true, delivered: 8, received: 9 }),
    expect: { verdict: "accept", forbid: REPEAT, evidence: (e) => assert.equal(e.kind, "exact_decline") },
    chronology() { assert.ok(4 < 5 && 5 < 6, "received → recorded → sent"); } },
  // P2 — status answer for Q delivered, received AND recorded before the retry
  { name: "P2 post-horizon answer received and its verdict recorded before the retry", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(1800), updated_at: T(1800) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2500), updated_at: T(2600) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(1700), qid: "q1", state: "failed", final: true, delivered: 6, received: 7 })
      .verdict({ seq: 8, identity: K1, result_class: "permanent_fail" })
      .money({ sent: 9, seq: 10, at: T(2500), op: "recover", key: R1, answered: "200", effect: true, delivered: 11, received: 12 }),
    expect: { verdict: "accept", forbid: REPEAT, evidence: (e) => { assert.equal(e.kind, "status_non_executed"); assert.equal(e.query_id, "q1"); assert.equal(e.verdict_source, "q1"); assert.ok(e.received_seq < e.sent_seq && e.verdict_seq < e.sent_seq); } },
    chronology() { assert.ok(7 < 8 && 8 < 9); } },
  // P3 — authenticated callback received and committed before the retry
  { name: "P3 callback received and committed before the retry", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "provider_event", dispatched_at: T(0), resolved_at: T(800), updated_at: T(800) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(2000), updated_at: T(2100) })],
    callbacks: [{ event_type: "charge_failed", correlation_id: K1, provider_reference: AUTH, received_at: T(800) }],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .verdict({ seq: 5, identity: K1, result_class: "permanent_fail" })
      .money({ sent: 6, seq: 7, at: T(2010), op: "recover", key: R1, answered: "200", effect: true, delivered: 8, received: 9 }),
    expect: { verdict: "accept", forbid: REPEAT, evidence: (e) => assert.equal(e.kind, "callback_failed") },
    chronology() { assert.ok(Date.parse(T(800)) < Date.parse(T(2000))); } },
  // P4 — an OLD delivered+recorded post-horizon Q1 stays valid although a later Q2 is still pending
  { name: "P4 earlier post-horizon Q1 fully observed stays valid while a later Q2 is pending", ...PAID, effects: RECOVERED,
    rows: [row({ attempt_type: "charge_start", correlation_id: K1, result_class: "permanent_fail", failure_evidence: "status_inference", dispatched_at: T(0), resolved_at: T(1800), updated_at: T(1800) }),
      row({ attempt_type: "recovery", correlation_id: R1, result_class: "success", dispatched_at: T(4000), updated_at: T(4100) })],
    timeline: new Timeline()
      .money({ sent: 1, seq: 2, at: T(10), op: "capture", key: K1, answered: "503", effect: false, delivered: 3, received: 4 })
      .status({ seq: 5, at: T(1700), qid: "q1", state: "failed", final: true, delivered: 6, received: 7 })
      .verdict({ seq: 8, identity: K1, result_class: "permanent_fail" })
      .status({ seq: 9, at: T(3500), qid: "q2", state: "failed", final: true, delivered: 10, received: null })          // still in transit when R1 is sent
      .money({ sent: 11, seq: 12, at: T(4000), op: "recover", key: R1, answered: "200", effect: true, delivered: 13, received: 14 }),
    expect: { verdict: "accept", forbid: REPEAT, evidence: (e) => { assert.equal(e.kind, "status_non_executed"); assert.equal(e.query_id, "q1", "Q1 settles the question; the pending Q2 is irrelevant"); } },
    chronology() { assert.ok(1700 >= 1510, "q1 is itself post-horizon"); assert.ok(7 < 11 && 8 < 11); } }
];

// ── Part 1: the REAL simulator + the REAL Siton-side observer, Codex's exact chronology ──
async function realTransportHold(): Promise<{ unsafeRejected: boolean; controlAccepted: boolean; detail: Record<string, unknown> }> {
  const sim = startProviderSimulator({ clientTimeoutMs: 4000 });
  const base = await sim.ready;
  // a transport hop between Siton and the provider that can HOLD an answer after the provider wrote it
  let holdAnswers = false;
  let releaseHold: () => void = () => {};
  let held: Promise<void> = Promise.resolve();
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const init: RequestInit = { method: req.method || "GET", headers: req.headers as any };
      if (chunks.length) init.body = Buffer.concat(chunks);
      const upstream = await fetch(`${base}${req.url}`, init);
      const body = await upstream.text();                                   // the provider has WRITTEN its answer (delivered_seq assigned)
      if (holdAnswers && String(req.url).startsWith("/status/")) await held;   // …but the transport holds it
      res.statusCode = upstream.status; res.setHeader("content-type", "application/json"); res.end(body);
    });
  });
  await new Promise<void>((r) => { proxy.listen(0, "127.0.0.1", () => r()); });
  const proxyBase = `http://127.0.0.1:${(proxy.address() as any).port}`;
  // the observer wraps THIS process's fetch — Siton's boundary — and mints positions on the simulator's sequencer
  const observer = installSitonObserver({ providerBaseUrl: proxyBase, observe: (e) => sim.observe(e), process: "lab" });
  const auth = "auth-causal-real";
  const send = async (key: string) => (await fetch(`${proxyBase}/capture`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ authorization_id: auth, amount_minor: 4200 }) })).json();
  const read = async () => (await fetch(`${proxyBase}/status/${auth}?operation=capture`)).json();
  const recordVerdict = (identity: string) => sim.observe({ kind: "verdict_recorded", process: "lab", identities: [identity], result_class: "permanent_fail" });
  try {
    sim.script(auth, "capture", [{ kind: "PENDING_NO_EFFECT" }, { kind: "SUCCESS" }]);
    await send("first");                                                     // T1
    await read();                                                            // pre-horizon read, received → Siton records permanent_fail from it (Codex's "prior verdict")
    recordVerdict("first");
    await new Promise((r) => setTimeout(r, HORIZON_MS + 50));                 // past the settlement horizon
    holdAnswers = true; held = new Promise<void>((r) => { releaseHold = r; });
    let received = false;
    const pending = read().then((b) => { received = true; return b; });      // T2/T3: provider generates + writes the post-horizon answer; transport holds it
    const deadline = Date.now() + 2000;
    while (sim.requestsOf(auth, "status").length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    while (!sim.requestsOf(auth, "status")[1]?.delivered_seq && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(sim.requestsOf(auth, "status").length, 2);
    assert.ok(sim.requestsOf(auth, "status")[1]!.delivered_seq, "the provider wrote the post-horizon answer");
    assert.equal(received, false, "Siton has not received it");
    await send("second");                                                    // T4: second capture sent inside the hold
    assert.equal(received, false, "second capture completed before the answer reached Siton");
    const atDispatch = sim.snapshot();
    releaseHold(); await pending;                                            // T5: delivery
    holdAnswers = false;
    const unsafe = auditDispatchLegality({ authorization: auth, requests: sim.snapshot().requests, observations: sim.snapshot().observations, rows: [], callbacks: [], policy: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true } });
    const unsafeRejected = unsafe.violations.some((v) => v.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN");

    // control: the same steps, but Siton WAITS for the post-horizon answer, records its verdict, then sends
    const auth2 = "auth-causal-real-control";
    sim.script(auth2, "capture", [{ kind: "PENDING_NO_EFFECT" }, { kind: "SUCCESS" }]);
    const send2 = async (key: string) => (await fetch(`${proxyBase}/capture`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ authorization_id: auth2, amount_minor: 4200 }) })).json();
    await send2("control-first");                                                   // identities are globally unique in production; the observer keys on them
    await new Promise((r) => setTimeout(r, HORIZON_MS + 50));
    await (await fetch(`${proxyBase}/status/${auth2}?operation=capture`)).json();   // received
    recordVerdict("control-first");                                                  // recorded
    await send2("control-second");
    const control = auditDispatchLegality({ authorization: auth2, requests: sim.snapshot().requests, observations: sim.snapshot().observations, rows: [], callbacks: [], policy: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true } });
    const controlAccepted = !control.violations.some((v) => v.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN");
    return { unsafeRejected, controlAccepted, detail: { requests_at_dispatch: atDispatch.requests, observations_at_dispatch: atDispatch.observations, unsafe_judgements: unsafe.judgements, unsafe_violations: unsafe.violations, control_judgements: control.judgements, control_violations: control.violations, effects: sim.effectsOf(auth) } };
  } finally {
    observer.uninstall();
    releaseHold();
    proxy.closeAllConnections(); await new Promise<void>((r) => proxy.close(() => r()));
    await sim.close();
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const fail = (name: string, message: string) => { failed += 1; console.log(`FAIL ${name}: ${message}`); };
const pass = (name: string) => { passed += 1; console.log(`PASS ${name}`); };

console.log("R6 ORACLE CAUSAL-BINDING CONTROLS");
{
  const name = "T1 real simulator + real observer: a post-horizon answer held in transport must not legalise a capture sent inside the hold, and the waited variant must";
  try {
    const r = await realTransportHold();
    console.log(`T1 detail: ${JSON.stringify({ unsafe_violations: r.detail.unsafe_violations, unsafe_judgements: r.detail.unsafe_judgements, control_violations: r.detail.control_violations, control_judgements: r.detail.control_judgements, effects: r.detail.effects })}`);
    if (!r.unsafeRejected) fail(name, "UNSAFE HISTORY ACCEPTED: the second capture was judged legal on an answer Siton had not received (transport hold)");
    else if (!r.controlAccepted) fail(name, "control rejected: a capture after the received and recorded answer must be legal");
    else pass(name);
  } catch (error) { fail(name, String((error as Error)?.stack || error)); }
}
for (const h of histories) {
  try {
    h.chronology();
    const report = await judge(h);
    const codes = report.violations.map((v: any) => v.code);
    const judgement = (report.dispatch_judgements || []).find((j: any) => j.verdict !== "first");
    if (h.expect.verdict === "reject") {
      const wanted = h.expect.codes || [];
      if (!wanted.some((c) => codes.includes(c))) { fail(h.name, `expected ${wanted.join("|")}, oracle produced [${codes.join(", ")}] (evidence ${JSON.stringify(judgement?.evidence || null)})`); continue; }
    } else {
      const forbidden = (h.expect.forbid || []).filter((c) => codes.includes(c));
      if (forbidden.length) { fail(h.name, `forbidden ${forbidden.join("|")} produced (all: [${codes.join(", ")}])`); continue; }
      if (h.expect.evidence) { try { h.expect.evidence(judgement?.evidence); } catch (e) { fail(h.name, `evidence check: ${String((e as Error).message)} — evidence ${JSON.stringify(judgement?.evidence || null)}`); continue; } }
    }
    pass(h.name);
  } catch (error) { fail(h.name, String((error as Error)?.stack || error)); }
}
console.log(`\nSUMMARY review_oracle_causal_binding passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
