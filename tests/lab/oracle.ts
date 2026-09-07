// FINANCIAL TORTURE LAB — independent financial truth oracle.
//
// This module derives what MUST be true after a synthetic scenario from two
// sources that production code does not control: the provider simulator's own
// economic ledger (tests/lab/provider_simulator.ts) and raw rows read from the
// database with plain SQL. It deliberately re-implements the financial
// constitution in integer agorot instead of importing the production helpers
// (platform_fee_money.ts, vat_authority.ts, payment_attempt_helpers.ts), so a
// wrong constant, a wrong rounding rule or a wrong state guard in production
// is caught rather than mirrored.
//
// Tracked separately for every participant:
//   A provider effects      B payment_attempt rows   C money_state
//   D buyer_state           E deal state              F platform-fee ledger
//   G audit log             H outbox / events         I unresolved operational cases
//
// Invariants (each violation is named; a scenario passes only with zero):
//   NO duplicate money effect              NO lost provider effect
//   NO canonical success without provider  NO provider success invisible to truth
//   NO ledger mismatch                     NO unresolved ambiguity without a case
//   NO automatic fresh money attempt while the prior exact operation is UNKNOWN
//   Siton fee = exactly 8 % of (gross incl. delivery − buyer VAT); distributor 0.

import type { ProviderLedgerSnapshot, EffectCounters } from "./provider_simulator.js";

export type OracleVatPolicy = { product_rate: number; delivery_rate: number; platform_fee_vat_rate: number };

export type OracleOptions = {
  label: string;
  dealIds: string[];
  /**
   * Provider ledger, or a function producing it. A FUNCTION is read AFTER the
   * database rows: effects only ever grow, so a canonical success observed in
   * the database is then always compared against a ledger that already
   * contains its effect (a snapshot taken before the reads would report a
   * capture that settled during the reads as "success without effect").
   */
  provider: ProviderLedgerSnapshot | (() => ProviderLedgerSnapshot);
  vat: OracleVatPolicy;
  /** true while a scenario is still expected to hold UNKNOWN rows with a case/reconcile pending */
  allowUnresolved?: boolean;
  /** authorizations the scenario deliberately captured out-of-band (provider-side truth the app never saw) */
  expectLateEffects?: string[];
  /** authoritative participant → authorization map from the seeding side (defeats reference rewriting by the app) */
  participantAuthorizations?: Record<string, string>;
  /** participants may have been SEEDED directly in captured / refunded states (no in-scenario capture, no ledger entry of their own) */
  seededStates?: boolean;
};

export type OracleViolation = { code: string; participant_id: string | null; detail: string };

export type OracleReport = {
  label: string;
  participants: number;
  violations: OracleViolation[];
  counts: {
    capture_effects: number;
    recovery_effects: number;
    refund_effects: number;
    release_effects: number;
    canonical_charged: number;
    canonical_recovered: number;
    canonical_refunded: number;
    canonical_released: number;
    unknown_attempts: number;
    unresolved_visible: number;
    operational_cases: number;
    distinct_capture_keys: number;
    ledger_entries: number;
    live_money_events: number;
  };
  totals: {
    TOTAL_CAPTURED_MINOR: number;
    TOTAL_RECOVERED_MINOR: number;
    TOTAL_REFUNDED_MINOR: number;
    TOTAL_RELEASED_COUNT: number;
    TOTAL_PLATFORM_FEES_MINOR: number;
    TOTAL_NET_MINOR: number;
    LEDGER_GROSS_MINOR: number;
    LEDGER_FEES_MINOR: number;
    LEDGER_NET_MINOR: number;
  };
};

// ── independent economics (integer agorot) ────────────────────────────────────

export const ORACLE_FEE_RATE_NUMERATOR = 8;   // exactly 8 %
export const ORACLE_FEE_RATE_DENOMINATOR = 100;

export function oracleMinor(value: number) {
  return Math.round(Number(value || 0) * 100);
}

export function oracleGrossMinor(args: { qty: number; price_per_unit: number; delivery_cost: number }) {
  return oracleMinor(args.qty * args.price_per_unit) + oracleMinor(args.delivery_cost);
}

function vatOfGrossMinor(grossMinor: number, rate: number) {
  if (!(rate > 0)) return 0;
  // VAT-inclusive gross: vat = gross − gross / (1 + rate), rounded to whole agorot.
  return Math.round(grossMinor - grossMinor / (1 + rate));
}

export function oracleEconomics(args: { qty: number; price_per_unit: number; delivery_cost: number }, vat: OracleVatPolicy) {
  const productGross = oracleMinor(args.qty * args.price_per_unit);
  const deliveryGross = oracleMinor(args.delivery_cost);
  const gross = productGross + deliveryGross;
  const buyerVat = vatOfGrossMinor(productGross, vat.product_rate) + vatOfGrossMinor(deliveryGross, vat.delivery_rate);
  const feeBase = gross - buyerVat;                       // delivery INCLUDED, buyer VAT EXCLUDED
  const fee = Math.round((feeBase * ORACLE_FEE_RATE_NUMERATOR) / ORACLE_FEE_RATE_DENOMINATOR);
  const feeVat = Math.round(fee * vat.platform_fee_vat_rate);
  const feeTotal = fee + feeVat;
  const distributorCommission = 0;                        // constitution: distributor 0 / 0 / 0
  const sellerNet = gross - feeTotal - distributorCommission;
  return { gross, buyerVat, feeBase, fee, feeVat, feeTotal, sellerNet, distributorCommission };
}

// ── row shapes ──────────────────────────────────────────────────────────────

type ParticipantRow = {
  participant_id: string; deal_id: string; buyer_id: string; qty: number; delivery_cost: number; buyer_state: string; money_state: string;
  price_per_unit: number; deal_state: string; threshold_units: number; authorization: string | null;
};
type AttemptRow = { attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; in_flight: boolean; owner_event_uuid: string | null };
type LedgerRow = { logical_entry_type: string; event_type: string; gross_amount: string; vat_amount: string; fee_base_amount: string; platform_fee_rate: string; platform_fee_base_amount: string; platform_fee_vat_amount: string; platform_fee_total_amount: string; platform_fee_amount: string; seller_net_amount: string };
type AuditRow = { state_type: string; from_state: string; to_state: string; action_name: string };
type OutboxRow = { event_uuid: string; event_type: string; aggregate_type: string; aggregate_id: string; status: string; attempt_count: number };

// finalize_deal is a deal-lifecycle event scheduled for the END of the
// completion window; it moves no money and is legitimately pending for hours.
const MONEY_EVENT_TYPES = ["charge_deal", "recovery_deal", "refund_issue", "cancel_refund", "payment_reconcile", "payment_release"];
const CAPTURED_STATES = new Set(["ChargedSuccess", "RecoveredCharge"]);

function n(value: unknown) { return Number(value || 0); }
function minorOf(value: unknown) { return Math.round(Number(value || 0) * 100); }
// The simulator answers every money call with an operation-scoped reference
// (`cap-<auth>`, `rec-<auth>`, ...) and the application stores the newest one
// as the participant's provider reference; the ledger is keyed by the
// authorization itself, so both sides are normalised to it here.
export function canonicalAuthorization(reference: string | null | undefined) {
  return reference ? String(reference).replace(/^(cap|rec|ref|rel)-/, "") : null;
}

export async function auditFinancialTruth(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, options: OracleOptions): Promise<OracleReport> {
  const violations: OracleViolation[] = [];
  const v = (code: string, participantId: string | null, detail: string) => violations.push({ code, participant_id: participantId, detail });
  const allowUnresolved = Boolean(options.allowUnresolved);
  const lateEffects = new Set(options.expectLateEffects || []);
  const dealIds = options.dealIds;
  if (!dealIds.length) throw new Error(`${options.label}: oracle needs at least one deal`);

  const participants = (await pool.query(
    `SELECT p.participant_id, p.deal_id, p.buyer_id, p.qty, p.delivery_cost, p.buyer_state, p.money_state,
            d.price_per_unit, d.state AS deal_state, d.threshold_units,
            COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id') AS authorization
     FROM siton.participants p
     JOIN siton.deals d ON d.deal_id = p.deal_id
     LEFT JOIN siton.payment_authorization_bindings pab ON pab.consumed_by_participant_id = p.participant_id
     LEFT JOIN LATERAL (
       SELECT payload FROM siton.audit_log
       WHERE entity_type='participant' AND entity_id=p.participant_id AND action_name='participant.join_authorize'
       ORDER BY created_at DESC LIMIT 1
     ) auth ON true
     WHERE p.deal_id = ANY($1::uuid[])
     ORDER BY p.created_at ASC`,
    [dealIds]
  )).rows as ParticipantRow[];

  const participantIds = participants.map((p) => p.participant_id);
  const attemptsAll = participantIds.length ? (await pool.query(
    `SELECT participant_id, attempt_type, correlation_id, result_class, dispatch_state, owner_event_uuid,
            siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight
     FROM siton.payment_attempts WHERE participant_id = ANY($1::uuid[]) ORDER BY created_at ASC, correlation_id ASC`,
    [participantIds]
  )).rows as Array<AttemptRow & { participant_id: string }> : [];
  const ledgerAll = participantIds.length ? (await pool.query(
    `SELECT participant_id, logical_entry_type, event_type, gross_amount, vat_amount, fee_base_amount, platform_fee_rate,
            platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount
     FROM siton.platform_fee_money_events WHERE participant_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
    [participantIds]
  )).rows as Array<LedgerRow & { participant_id: string }> : [];
  const auditAll = participantIds.length ? (await pool.query(
    `SELECT entity_id AS participant_id, state_type, from_state, to_state, action_name
     FROM siton.audit_log WHERE entity_type='participant' AND entity_id = ANY($1::uuid[]) AND state_type IN ('money_state','buyer_state')
     ORDER BY created_at ASC, audit_id ASC`,
    [participantIds]
  )).rows as Array<AuditRow & { participant_id: string }> : [];
  const outbox = (await pool.query(
    `SELECT event_uuid, event_type, aggregate_type, aggregate_id, status, attempt_count, (available_at <= clock_timestamp()) AS due
     FROM siton.outbox_events
     WHERE (aggregate_type='deal' AND aggregate_id = ANY($1::uuid[])) OR (aggregate_type='participant' AND aggregate_id = ANY($2::uuid[]))
     ORDER BY created_at ASC`,
    [dealIds, participantIds.length ? participantIds : ["00000000-0000-4000-8000-000000000000"]]
  )).rows as Array<OutboxRow & { due: boolean }>;
  // Independent review — the reference the APPLICATION stores for a participant
  // must still name the authorization the lab gave it: a status answer that
  // carried another operation's reference and was written back into the binding
  // (O-1) is reported here as BINDING_REFERENCE_DRIFT.
  for (const p of participants) {
    const stored = canonicalAuthorization(p.authorization);
    const seeded = options.participantAuthorizations?.[p.participant_id] ? canonicalAuthorization(options.participantAuthorizations[p.participant_id]) : null;
    if (seeded && stored && stored !== seeded) v("BINDING_REFERENCE_DRIFT", p.participant_id, `application stores reference ${stored} but the participant's authorization is ${seeded}`);
    p.authorization = seeded ?? stored;
  }
  const dlq = (await pool.query(
    `SELECT event_type, aggregate_id FROM siton.outbox_dlq
     WHERE (aggregate_type='deal' AND aggregate_id = ANY($1::uuid[])) OR (aggregate_type='participant' AND aggregate_id = ANY($2::uuid[]))`,
    [dealIds, participantIds.length ? participantIds : ["00000000-0000-4000-8000-000000000000"]]
  )).rows as Array<{ event_type: string; aggregate_id: string }>;
  const cases = participantIds.length ? (await pool.query(
    `SELECT auto_key, subject, status FROM siton.operational_cases
     WHERE auto_key IS NOT NULL AND (${participantIds.map((_, i) => `auto_key LIKE '%' || $${i + 1} || '%'`).join(" OR ")})`,
    participantIds
  )).rows as Array<{ auto_key: string; subject: string; status: string }> : [];
  // Provider truth is read AFTER every database row (see OracleOptions.provider).
  const providerLedger: ProviderLedgerSnapshot = typeof options.provider === "function" ? options.provider() : options.provider;

  const counts: OracleReport["counts"] = {
    capture_effects: 0, recovery_effects: 0, refund_effects: 0, release_effects: 0,
    canonical_charged: 0, canonical_recovered: 0, canonical_refunded: 0, canonical_released: 0,
    unknown_attempts: 0, unresolved_visible: 0, operational_cases: cases.length, distinct_capture_keys: 0,
    ledger_entries: ledgerAll.length, live_money_events: 0
  };
  const totals: OracleReport["totals"] = {
    TOTAL_CAPTURED_MINOR: 0, TOTAL_RECOVERED_MINOR: 0, TOTAL_REFUNDED_MINOR: 0, TOTAL_RELEASED_COUNT: 0,
    TOTAL_PLATFORM_FEES_MINOR: 0, TOTAL_NET_MINOR: 0, LEDGER_GROSS_MINOR: 0, LEDGER_FEES_MINOR: 0, LEDGER_NET_MINOR: 0
  };

  // ── H: outbox hygiene (index backstop re-checked by the oracle) ───────────
  const liveKey = new Map<string, number>();
  const liveMoney: string[] = [];
  for (const row of outbox) {
    if (row.status === "pending" || row.status === "processing") {
      const key = `${row.event_type}:${row.aggregate_id}`;
      liveKey.set(key, (liveKey.get(key) || 0) + 1);
      // A money event is LIVE when it is processing, or pending and already due.
      // A pending event scheduled for the future (bounded backoff) is not
      // quiescent either at the END of a scenario: the runtime pulls deferred
      // events forward, so anything still deferred here was left behind.
      if (MONEY_EVENT_TYPES.includes(row.event_type)) { counts.live_money_events += 1; liveMoney.push(`${row.event_type}:${row.aggregate_id}:${row.status}${row.due ? "" : "(deferred)"}`); }
    }
  }
  for (const [key, count] of liveKey) if (count > 1) v("DUPLICATE_LIVE_OUTBOX_EVENT", null, `${key} has ${count} live rows`);
  if (!allowUnresolved && counts.live_money_events > 0) v("MONEY_EVENTS_NOT_QUIESCENT", null, liveMoney.join(", "));

  // ── per participant ───────────────────────────────────────────────────────
  for (const p of participants) {
    const pid = p.participant_id;
    const auth = p.authorization;
    const eff: EffectCounters = (auth && providerLedger.effects[auth]) || { capture: 0, recover: 0, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 0, refund_amount_minor: 0 };
    const attempts = attemptsAll.filter((a) => a.participant_id === pid);
    const ledger = ledgerAll.filter((l) => l.participant_id === pid);
    const audits = auditAll.filter((a) => a.participant_id === pid);
    const participantCases = cases.filter((c) => c.auto_key.includes(pid));
    const pendingReconcile = outbox.some((r) => r.event_type === "payment_reconcile" && r.aggregate_id === pid && (r.status === "pending" || r.status === "processing"));
    const econ = oracleEconomics({ qty: n(p.qty), price_per_unit: n(p.price_per_unit), delivery_cost: n(p.delivery_cost) }, options.vat);

    counts.capture_effects += eff.capture; counts.recovery_effects += eff.recover; counts.refund_effects += eff.refund; counts.release_effects += eff.release;
    totals.TOTAL_CAPTURED_MINOR += eff.capture_amount_minor; totals.TOTAL_RECOVERED_MINOR += eff.recover_amount_minor; totals.TOTAL_REFUNDED_MINOR += eff.refund_amount_minor; totals.TOTAL_RELEASED_COUNT += eff.release;
    const captured = eff.capture + eff.recover;

    // A — duplicate money effects
    if (captured > 1) v("DUPLICATE_CAPTURE", pid, `capture=${eff.capture} recovery=${eff.recover} on ${auth}`);
    if (eff.refund > 1) v("DUPLICATE_REFUND", pid, `refund=${eff.refund} on ${auth}`);
    if (eff.release > 1) v("DUPLICATE_RELEASE", pid, `release=${eff.release} on ${auth}`);
    if (eff.refund > 0 && captured === 0) v("REFUND_WITHOUT_CAPTURE", pid, `refund=${eff.refund} capture=${captured}`);
    if (eff.release > 0 && captured > 0) v("RELEASE_OF_CAPTURED_MONEY", pid, `release=${eff.release} capture=${captured} (no compensation semantics exist)`);
    if (eff.refund > 0 && eff.refund_amount_minor !== eff.capture_amount_minor + eff.recover_amount_minor) v("REFUND_AMOUNT_MISMATCH", pid, `refunded ${eff.refund_amount_minor} vs captured ${eff.capture_amount_minor + eff.recover_amount_minor}`);
    if (captured > 0 && eff.capture_amount_minor + eff.recover_amount_minor !== econ.gross) v("CAPTURE_AMOUNT_MISMATCH", pid, `provider captured ${eff.capture_amount_minor + eff.recover_amount_minor} minor, authoritative gross ${econ.gross}`);

    // C/D — canonical state vs provider truth
    const ms = p.money_state;
    if (ms === "ChargedSuccess") counts.canonical_charged += 1;
    if (ms === "RecoveredCharge") counts.canonical_recovered += 1;
    if (ms === "Refunded") counts.canonical_refunded += 1;
    if (ms === "AuthReleased") counts.canonical_released += 1;
    const canonicalCaptured = CAPTURED_STATES.has(ms) || ms === "Refunded";
    if (canonicalCaptured && captured === 0) v("FALSE_CANONICAL_SUCCESS", pid, `money_state=${ms} but provider capture effects = 0 on ${auth}`);
    if (ms === "Refunded" && eff.refund === 0) v("FALSE_CANONICAL_REFUND", pid, `money_state=Refunded but provider refund effects = 0`);
    if (ms === "AuthReleased" && eff.release === 0 && captured === 0) {
      // Owner financial truth decision (independent review, F-6): AuthReleased
      // is money truth and REQUIRES authoritative release proof. Every path to
      // AuthReleased without a provider release effect is a false release —
      // the former recovery_failed allowance no longer exists.
      v("FALSE_CANONICAL_RELEASE", pid, `money_state=AuthReleased but provider release effects = 0 (${audits.filter((a) => a.state_type === "money_state" && a.to_state === "AuthReleased").map((a) => a.action_name).join(",") || "no audit"})`);
    }
    if (ms === "ChargedSuccess" && p.buyer_state !== "ChargedSuccess" && p.buyer_state !== "DealCompleted" && p.buyer_state !== "DealFailed") v("BUYER_STATE_INCONSISTENT", pid, `money=${ms} buyer=${p.buyer_state}`);
    if (ms === "RecoveredCharge" && !["Recovered", "DealCompleted", "DealFailed"].includes(p.buyer_state)) v("BUYER_STATE_INCONSISTENT", pid, `money=${ms} buyer=${p.buyer_state}`);

    // B — attempt rows: visibility of unresolved truth, identity discipline
    const unknownRows = attempts.filter((a) => a.result_class === "unknown");
    const unknownSettled = unknownRows.filter((a) => !(a.dispatch_state === "dispatching" && a.in_flight));
    counts.unknown_attempts += unknownRows.length;
    const visibleUnresolved = unknownSettled.length > 0 || participantCases.length > 0 || pendingReconcile;
    if (visibleUnresolved) counts.unresolved_visible += 1;
    // A job for this participant/deal that is still queued or parked in the DLQ
    // keeps a NOT_DISPATCHED identity operationally visible (nothing reached
    // the provider, so it is not financial ambiguity — but it must not vanish).
    const stuckJobVisible = outbox.some((r) => (r.aggregate_id === pid || r.aggregate_id === p.deal_id) && (r.status === "failed" || r.status === "pending" || r.status === "processing") && MONEY_EVENT_TYPES.includes(r.event_type))
      || dlq.some((r) => (r.aggregate_id === pid || r.aggregate_id === p.deal_id) && MONEY_EVENT_TYPES.includes(r.event_type));
    for (const row of unknownSettled) {
      if (row.dispatch_state === "recorded") {
        // NOT_DISPATCHED: nothing ever reached the provider (zero money risk). Such a
        // row is attended either by its own job / DLQ entry / case, or — once quiet —
        // by the worker-maintenance sweeper (F-8), which resolves it through status.
        // It is counted, never a violation; the sweeper itself is proven by the lab.
        if (!stuckJobVisible && participantCases.length === 0) counts.unresolved_visible += 0;
        continue;
      }
      if (!pendingReconcile && participantCases.length === 0) v("UNRESOLVED_WITHOUT_CASE", pid, `${row.attempt_type} ${row.correlation_id} is unknown/${row.dispatch_state} with no pending reconcile and no operational case`);
      if (!allowUnresolved && pendingReconcile) v("UNRESOLVED_AT_QUIESCENCE", pid, `${row.attempt_type} ${row.correlation_id} still unknown with a reconcile pending`);
    }
    if (attempts.some((a) => a.dispatch_state === "dispatching" && a.in_flight) && !allowUnresolved) v("OPERATION_STILL_IN_FLIGHT", pid, attempts.filter((a) => a.in_flight).map((a) => a.correlation_id).join(","));

    // provider effect that canonical truth does not know about
    if (captured > 0 && !canonicalCaptured) {
      const knownByAttempt = attempts.some((a) => (a.attempt_type === "charge_start" || a.attempt_type === "recovery") && (a.result_class === "unknown" || a.result_class === "success"));
      if (!knownByAttempt && participantCases.length === 0 && !pendingReconcile && !lateEffects.has(auth || "")) v("LOST_PROVIDER_EFFECT", pid, `provider captured (${captured}) but money_state=${ms} with no unknown/success attempt, no case, no reconcile`);
      if (!allowUnresolved && !lateEffects.has(auth || "") && participantCases.length === 0) v("PROVIDER_SUCCESS_INVISIBLE", pid, `provider captured (${captured}) but money_state=${ms} at quiescence without an operational case`);
    }
    if (eff.refund > 0 && ms !== "Refunded") {
      const knownByAttempt = attempts.some((a) => (a.attempt_type === "refund" || a.attempt_type === "cancel_refund") && (a.result_class === "unknown" || a.result_class === "success"));
      if (!knownByAttempt && participantCases.length === 0 && !pendingReconcile) v("LOST_PROVIDER_EFFECT", pid, `provider refunded but money_state=${ms} with no visibility`);
      if (!allowUnresolved && participantCases.length === 0) v("PROVIDER_SUCCESS_INVISIBLE", pid, `provider refunded but money_state=${ms} at quiescence without an operational case`);
    }
    if (eff.release > 0 && ms !== "AuthReleased") {
      const knownByAttempt = attempts.some((a) => a.attempt_type === "release" && (a.result_class === "unknown" || a.result_class === "success"));
      if (!knownByAttempt && participantCases.length === 0 && !pendingReconcile) v("LOST_PROVIDER_EFFECT", pid, `provider released but money_state=${ms} with no visibility`);
    }
    // success rows must be backed by provider truth
    for (const row of attempts) {
      if (row.result_class !== "success") continue;
      const backed = row.attempt_type === "charge_start" || row.attempt_type === "recovery" ? captured > 0 : row.attempt_type === "release" ? eff.release > 0 : eff.refund > 0;
      if (!backed) v("ATTEMPT_SUCCESS_WITHOUT_PROVIDER_EFFECT", pid, `${row.attempt_type} ${row.correlation_id} is success but the provider ledger shows no such effect`);
    }

    // identity discipline from the PROVIDER's point of view: a second distinct
    // idempotency key for the same operation is legal only after the previous
    // identity is provider-declared failed (permanent_fail) — never while UNKNOWN.
    for (const op of ["capture", "recover", "refund", "release"] as const) {
      const keys = auth ? [...new Set(providerLedger.requests.filter((r) => r.authorization === auth && r.op === op && !r.replayed).map((r) => r.idempotency_key))] : [];
      if (op === "capture") counts.distinct_capture_keys += keys.length;
      for (let i = 1; i < keys.length; i += 1) {
        const previous = attempts.find((a) => a.correlation_id === keys[i - 1]);
        if (!previous || previous.result_class !== "permanent_fail") {
          v("AUTOMATIC_REPEAT_WHILE_UNKNOWN", pid, `${op}: identity ${keys[i]} reached the provider while ${keys[i - 1]} is ${previous ? previous.result_class : "unknown to the database"}`);
        }
      }
      if (keys.length > 1 && op === "capture") {
        // even after a declared failure, a fresh capture identity must not make money move twice
        if (captured > 1) v("DUPLICATE_CAPTURE_ACROSS_IDENTITIES", pid, `keys=${keys.join("|")}`);
      }
    }

    // F — ledger truth vs independent economics
    const chargeEntries = ledger.filter((l) => l.logical_entry_type === "charge");
    const refundEntries = ledger.filter((l) => l.logical_entry_type === "refund_adjustment");
    const moneyAuditsForLedger = audits.filter((a) => a.state_type === "money_state");
    const captureRanInScenario = moneyAuditsForLedger.some((a) => a.to_state === "ChargedSuccess" || a.to_state === "RecoveredCharge");
    const seededCaptured = Boolean(options.seededStates) && !captureRanInScenario && (CAPTURED_STATES.has(ms) || ms === "Refunded");
    const expectCharge = CAPTURED_STATES.has(ms) || ms === "Refunded" ? 1 : 0;
    const expectRefund = ms === "Refunded" ? 1 : 0;
    // A participant seeded directly as captured owns no in-scenario charge entry;
    // a refund BACKFILLS one (settlement_status backfilled_from_refund), so after
    // a refund the count must be exactly one again.
    if (chargeEntries.length !== expectCharge && !(seededCaptured && ms !== "Refunded" && chargeEntries.length === 0)) v("LEDGER_CHARGE_ENTRY_COUNT", pid, `money_state=${ms} expected ${expectCharge} charge entries, found ${chargeEntries.length}`);
    if (refundEntries.length !== expectRefund) v("LEDGER_REFUND_ENTRY_COUNT", pid, `money_state=${ms} expected ${expectRefund} refund_adjustment entries, found ${refundEntries.length}`);
    for (const entry of ledger) {
      const sign = entry.logical_entry_type === "refund_adjustment" ? -1 : 1;
      const rate = Number(entry.platform_fee_rate);
      if (Math.abs(rate - 0.08) > 1e-12) v("FEE_RATE_NOT_8_PERCENT", pid, `platform_fee_rate=${entry.platform_fee_rate}`);
      const checks: Array<[string, number, number]> = [
        ["gross_amount", minorOf(entry.gross_amount), sign * econ.gross],
        ["vat_amount", minorOf(entry.vat_amount), sign * econ.buyerVat],
        ["fee_base_amount", minorOf(entry.fee_base_amount), sign * econ.feeBase],
        ["platform_fee_base_amount", minorOf(entry.platform_fee_base_amount), sign * econ.fee],
        ["platform_fee_vat_amount", minorOf(entry.platform_fee_vat_amount), sign * econ.feeVat],
        ["platform_fee_total_amount", minorOf(entry.platform_fee_total_amount), sign * econ.feeTotal],
        ["platform_fee_amount", minorOf(entry.platform_fee_amount), sign * econ.feeTotal],
        ["seller_net_amount", minorOf(entry.seller_net_amount), sign * econ.sellerNet]
      ];
      for (const [column, actual, expected] of checks) {
        if (actual !== expected) v("LEDGER_AMOUNT_MISMATCH", pid, `${entry.logical_entry_type}.${column}=${actual} minor, oracle expects ${expected} (qty=${p.qty} price=${p.price_per_unit} delivery=${p.delivery_cost})`);
      }
      totals.LEDGER_GROSS_MINOR += minorOf(entry.gross_amount);
      totals.LEDGER_FEES_MINOR += minorOf(entry.platform_fee_amount);
      totals.LEDGER_NET_MINOR += minorOf(entry.seller_net_amount);
    }
    if (CAPTURED_STATES.has(ms) && !seededCaptured) { totals.TOTAL_PLATFORM_FEES_MINOR += econ.feeTotal; totals.TOTAL_NET_MINOR += econ.sellerNet; }

    // G — audit truth: exactly one transition into each reached money state, and the chain ends where the row is
    const moneyAudits = audits.filter((a) => a.state_type === "money_state");
    const into = (state: string) => moneyAudits.filter((a) => a.to_state === state).length;
    // A lab participant may be SEEDED directly in a captured state (its capture
    // predates the audit chain); the capture-transition count is checked only
    // when the chain itself starts before the capture.
    const chainCoversCapture = moneyAudits.length > 0 && ["ChargeAttempt", "ChargeFailedRecovery", "AuthLocked", "AuthHeld"].includes(moneyAudits[0]!.from_state);
    if ((CAPTURED_STATES.has(ms) || ms === "Refunded") && chainCoversCapture) {
      const captureTransitions = into("ChargedSuccess") + into("RecoveredCharge");
      if (captureTransitions !== 1) v("AUDIT_CAPTURE_TRANSITION_COUNT", pid, `money_state=${ms}: ${captureTransitions} capture transitions in the audit log`);
    }
    if (into("ChargedSuccess") + into("RecoveredCharge") > 1) v("AUDIT_CAPTURE_TRANSITION_COUNT", pid, `${into("ChargedSuccess") + into("RecoveredCharge")} capture transitions in the audit log`);
    if (ms === "Refunded" && into("Refunded") !== 1) v("AUDIT_REFUND_TRANSITION_COUNT", pid, `${into("Refunded")} transitions into Refunded`);
    if (ms === "AuthReleased" && into("AuthReleased") !== 1) v("AUDIT_RELEASE_TRANSITION_COUNT", pid, `${into("AuthReleased")} transitions into AuthReleased`);
    const last = moneyAudits[moneyAudits.length - 1];
    if (last && last.to_state !== ms) v("AUDIT_CHAIN_DIVERGES", pid, `last money audit to_state=${last.to_state} but participant money_state=${ms}`);
    for (let i = 1; i < moneyAudits.length; i += 1) {
      const prev = moneyAudits[i - 1]!; const cur = moneyAudits[i]!;
      if (cur.from_state !== prev.to_state) v("AUDIT_CHAIN_BROKEN", pid, `${prev.from_state}->${prev.to_state} then ${cur.from_state}->${cur.to_state}`);
    }

    // E — deal-level consistency
    if (p.deal_state === "Completed" && !["DealCompleted", "DealFailed"].includes(p.buyer_state)) v("COMPLETED_DEAL_PARTICIPANT_NOT_FINAL", pid, `deal Completed, buyer_state=${p.buyer_state}`);
    if (p.deal_state === "Failed" && CAPTURED_STATES.has(ms) && !allowUnresolved && !seededCaptured) v("FAILED_DEAL_HOLDS_CAPTURED_MONEY", pid, `deal Failed but money_state=${ms} (refund expected)`);
  }

  // provider effects on authorizations no participant claims: money that moved
  // for nobody is a lost effect by definition (unless the scenario planted it).
  // The provider ledger is process-wide, so ownership is checked against EVERY
  // participant in the database, not only the deals under audit.
  const ledgerAuths = Object.keys(providerLedger.effects).filter((auth) => { const r = providerLedger.effects[auth]!; return r.capture + r.recover + r.refund + r.release > 0; });
  if (ledgerAuths.length) {
    const owned = new Set<string>();
    const bindingRows = (await pool.query(
      `SELECT provider_reference, authorization_id FROM siton.payment_authorization_bindings
       WHERE regexp_replace(provider_reference, '^(cap|rec|ref|rel)-', '') = ANY($1::text[]) OR regexp_replace(authorization_id, '^(cap|rec|ref|rel)-', '') = ANY($1::text[])`,
      [ledgerAuths]
    )).rows as Array<{ provider_reference: string; authorization_id: string }>;
    for (const row of bindingRows) { owned.add(canonicalAuthorization(row.provider_reference)!); owned.add(canonicalAuthorization(row.authorization_id)!); }
    const auditRows = (await pool.query(
      `SELECT payload->>'authorization_id' AS authorization FROM siton.audit_log
       WHERE action_name='participant.join_authorize' AND regexp_replace(payload->>'authorization_id', '^(cap|rec|ref|rel)-', '') = ANY($1::text[])`,
      [ledgerAuths]
    )).rows as Array<{ authorization: string }>;
    for (const row of auditRows) owned.add(canonicalAuthorization(row.authorization)!);
    for (const auth of ledgerAuths) {
      if (owned.has(auth) || lateEffects.has(auth)) continue;
      v("EFFECT_ON_UNKNOWN_AUTHORIZATION", null, `${auth}: ${JSON.stringify(providerLedger.effects[auth])}`);
    }
  }

  return { label: options.label, participants: participants.length, violations, counts, totals };
}

export function assertOracleClean(report: OracleReport, allowedCodes: string[] = []) {
  const blocking = report.violations.filter((x) => !allowedCodes.includes(x.code));
  if (blocking.length) {
    const lines = blocking.map((x) => `  [${x.code}] ${x.participant_id ?? "-"}: ${x.detail}`);
    throw new Error(`${report.label}: ${blocking.length} financial invariant violation(s)\n${lines.join("\n")}`);
  }
}

export function describeOracle(report: OracleReport) {
  const c = report.counts; const t = report.totals;
  return `${report.label}: participants=${report.participants} effects[cap=${c.capture_effects} rec=${c.recovery_effects} ref=${c.refund_effects} rel=${c.release_effects}] canonical[charged=${c.canonical_charged} recovered=${c.canonical_recovered} refunded=${c.canonical_refunded} released=${c.canonical_released}] unknown=${c.unknown_attempts} visible_unresolved=${c.unresolved_visible} cases=${c.operational_cases} ledger=${c.ledger_entries} live=${c.live_money_events} totals[captured=${t.TOTAL_CAPTURED_MINOR} recovered=${t.TOTAL_RECOVERED_MINOR} refunded=${t.TOTAL_REFUNDED_MINOR} fees=${t.TOTAL_PLATFORM_FEES_MINOR} ledger_fees=${t.LEDGER_FEES_MINOR}] violations=${report.violations.length}`;
}
