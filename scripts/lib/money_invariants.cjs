// Money reconciliation invariants — the shared, READ-ONLY query set.
//
// Used by:
//   - scripts/money_invariants.cjs              (operator CLI, any DATABASE_URL,
//                                                hosted included: it only reads)
//   - scripts/db_backup_restore_rehearsal.cjs   (source vs restored must agree)
//   - tests/db_money_invariants_validation.ts   (PASS on a consistent dataset,
//                                                FAIL by name on corruption)
//
// Every invariant is a SELECT that returns the VIOLATING rows (column `id`).
// Zero rows = PASS. The runner wraps each one as
//   SELECT count(*), first 5 ids FROM (<invariant>) v
// inside ONE `BEGIN TRANSACTION READ ONLY` + REPEATABLE READ snapshot, so the
// whole report is one consistent point in time and nothing can be written even
// if a query were wrong. Each invariant runs under its own SAVEPOINT so one
// broken query (schema drift) is reported as ERROR without hiding the others.
//
// Canon (src/platform_fee_money.ts, migrations 019 / 021 / 014 / 053 / 067 / 068):
//   fee_base_amount           = gross_amount - vat_amount        (8% EXCLUDES VAT)
//   platform_fee_base_amount  = round(fee_base_amount * 0.08, 2)
//   platform_fee_vat_amount   = round(platform_fee_base_amount * platform_fee_vat_rate, 2)
//   platform_fee_total_amount = platform_fee_base_amount + platform_fee_vat_amount
//   platform_fee_amount       = platform_fee_total_amount
//   seller_net_amount         = gross_amount - platform_fee_total_amount
//   'charge' rows are positive, 'refund_adjustment' rows are the signed reversal.
//
// Money tolerance is 0.01 (one agora); rows that are within tolerance but not
// exactly equal are reported separately as `exact_mismatch` (rounding drift).
//
// Statuses: PASS | FAIL | SKIPPED (a required table/column is absent) |
// INFO (report-only: no durable linkage exists to decide FAIL) | ERROR (the
// query itself failed — counted as a failure).

const TOLERANCE = 0.01;
const PLATFORM_FEE_RATE = 0.08;
const SAMPLE_LIMIT = 5;

const CHARGED = "('ChargedSuccess','RecoveredCharge')";
const CHARGED_OR_REFUNDED = "('ChargedSuccess','RecoveredCharge','Refunded')";
// Money states in which a participant's units are held against the deal
// capacity (an authorization or a capture exists and is not released/refunded).
const HOLDING = "('AuthHeld','AuthLocked','ChargeAttempt','ChargedSuccess','ChargeFailedRecovery','RecoveredCharge')";
const OPEN_CASE = "('Open','NeedsSeller','NeedsAdmin','WaitingExternal')";
const FEE = "siton.platform_fee_money_events";

const FEE_COLS = ["participant_id", "deal_id", "seller_id", "event_type", "logical_entry_type", "gross_amount", "vat_amount", "fee_base_amount", "platform_fee_rate", "platform_fee_vat_rate", "platform_fee_base_amount", "platform_fee_vat_amount", "platform_fee_total_amount", "platform_fee_amount", "seller_net_amount", "created_at"];
const SIGNED_FEE_AMOUNTS = ["gross_amount", "vat_amount", "fee_base_amount", "platform_fee_base_amount", "platform_fee_vat_amount", "platform_fee_total_amount", "platform_fee_amount", "seller_net_amount"];

const feeRequires = { "siton.platform_fee_money_events": FEE_COLS };
const participantRequires = { "siton.participants": ["participant_id", "deal_id", "qty", "buyer_state", "money_state"] };
const dealRequires = { "siton.deals": ["deal_id", "state", "max_units", "seller_id"] };

function toleranceCheck(name, description, lhs, rhs) {
  return {
    name,
    group: "fee",
    description,
    requires: feeRequires,
    sql: `SELECT money_event_id AS id FROM ${FEE} WHERE abs((${lhs}) - (${rhs})) > ${TOLERANCE}`,
    exactSql: `SELECT money_event_id AS id FROM ${FEE} WHERE (${lhs}) <> (${rhs})`
  };
}

// An open operational case "about" an aggregate. operational_cases has no hard
// foreign key to outbox/payment rows; the runtime links them softly through
// deal_id / participant_id, the auto_key (which embeds the aggregate id) and
// the correlation id.
function openCaseAbout(idExpr, correlationExpr) {
  return `EXISTS (
      SELECT 1 FROM siton.operational_cases oc
      WHERE oc.status IN ${OPEN_CASE}
        AND (oc.deal_id = ${idExpr} OR oc.participant_id = ${idExpr}
             OR oc.auto_key LIKE '%' || ${idExpr}::text || '%'
             ${correlationExpr ? `OR (oc.correlation_id IS NOT NULL AND oc.correlation_id = ${correlationExpr})` : ""}))`;
}

const INVARIANTS = [
  // ── fee ledger row arithmetic ────────────────────────────────────────────
  toleranceCheck("fee.total_equals_base_plus_vat", "platform_fee_total_amount = platform_fee_base_amount + platform_fee_vat_amount",
    "platform_fee_total_amount", "platform_fee_base_amount + platform_fee_vat_amount"),
  toleranceCheck("fee.platform_fee_amount_equals_total", "platform_fee_amount (legacy alias) = platform_fee_total_amount",
    "platform_fee_amount", "platform_fee_total_amount"),
  toleranceCheck("fee.seller_net_equals_gross_minus_fee_total", "seller_net_amount = gross_amount - platform_fee_total_amount",
    "seller_net_amount", "gross_amount - platform_fee_total_amount"),
  toleranceCheck("fee.fee_base_excludes_vat", "fee_base_amount = gross_amount - vat_amount (the 8% base EXCLUDES VAT)",
    "fee_base_amount", "gross_amount - vat_amount"),
  toleranceCheck("fee.platform_fee_base_is_rate_times_fee_base", "platform_fee_base_amount = round(fee_base_amount * platform_fee_rate, 2)",
    "platform_fee_base_amount", "round(fee_base_amount * platform_fee_rate, 2)"),
  toleranceCheck("fee.platform_fee_vat_is_vat_rate_times_fee", "platform_fee_vat_amount = round(platform_fee_base_amount * platform_fee_vat_rate, 2)",
    "platform_fee_vat_amount", "round(platform_fee_base_amount * platform_fee_vat_rate, 2)"),
  {
    name: "fee.rate_is_8_percent",
    group: "fee",
    description: "platform_fee_rate = 0.08 on every row",
    requires: feeRequires,
    sql: `SELECT money_event_id AS id FROM ${FEE} WHERE platform_fee_rate <> ${PLATFORM_FEE_RATE}`
  },
  {
    name: "fee.sign_matches_entry_type",
    group: "fee",
    description: "charge rows have every amount >= 0; refund_adjustment rows have every amount <= 0",
    requires: feeRequires,
    sql: `SELECT money_event_id AS id FROM ${FEE}
          WHERE (logical_entry_type = 'charge' AND LEAST(${SIGNED_FEE_AMOUNTS.join(", ")}) < 0)
             OR (logical_entry_type = 'refund_adjustment' AND GREATEST(${SIGNED_FEE_AMOUNTS.join(", ")}) > 0)`
  },
  {
    name: "fee.event_type_matches_entry_type",
    group: "fee",
    description: "charge <-> charge_captured/recovery_captured; refund_adjustment <-> refund_issued",
    requires: feeRequires,
    sql: `SELECT money_event_id AS id FROM ${FEE}
          WHERE (logical_entry_type = 'charge' AND event_type NOT IN ('charge_captured','recovery_captured'))
             OR (logical_entry_type = 'refund_adjustment' AND event_type <> 'refund_issued')`
  },
  {
    name: "fee.abs_fee_le_abs_gross",
    group: "fee",
    description: "|platform_fee_total_amount| <= |gross_amount|",
    requires: feeRequires,
    sql: `SELECT money_event_id AS id FROM ${FEE} WHERE abs(platform_fee_total_amount) > abs(gross_amount)`
  },
  {
    name: "fee.deal_and_seller_match_participant",
    group: "fee",
    description: "a fee row's deal_id is its participant's deal and its seller_id is that deal's seller",
    requires: { ...feeRequires, ...participantRequires, ...dealRequires },
    sql: `SELECT m.money_event_id AS id FROM ${FEE} m
          JOIN siton.participants p ON p.participant_id = m.participant_id
          JOIN siton.deals d ON d.deal_id = p.deal_id
          WHERE m.deal_id <> p.deal_id OR m.seller_id IS DISTINCT FROM d.seller_id`
  },

  // ── per participant ledger shape ────────────────────────────────────────
  {
    name: "participant.at_most_one_charge_row",
    group: "participant",
    description: "at most one 'charge' fee row per participant (mirrors ux_platform_fee_money_charge_once)",
    requires: feeRequires,
    sql: `SELECT participant_id AS id FROM ${FEE} WHERE logical_entry_type = 'charge' GROUP BY participant_id HAVING count(*) > 1`
  },
  {
    name: "participant.at_most_one_refund_row",
    group: "participant",
    description: "at most one 'refund_adjustment' fee row per participant (mirrors ux_platform_fee_money_refund_once)",
    requires: feeRequires,
    sql: `SELECT participant_id AS id FROM ${FEE} WHERE logical_entry_type = 'refund_adjustment' GROUP BY participant_id HAVING count(*) > 1`
  },
  {
    name: "participant.refund_requires_charge",
    group: "participant",
    description: "a refund_adjustment row exists only next to a charge row",
    requires: feeRequires,
    sql: `SELECT participant_id AS id FROM ${FEE} GROUP BY participant_id
          HAVING count(*) FILTER (WHERE logical_entry_type = 'refund_adjustment') > 0
             AND count(*) FILTER (WHERE logical_entry_type = 'charge') = 0`
  },
  {
    name: "participant.refund_not_exceeding_charge",
    group: "participant",
    description: "sum |refund| never exceeds |charge| for gross, platform fee total and seller net",
    requires: feeRequires,
    sql: `SELECT participant_id AS id FROM ${FEE} GROUP BY participant_id
          HAVING COALESCE(sum(abs(gross_amount)) FILTER (WHERE logical_entry_type = 'refund_adjustment'), 0)
                   > COALESCE(sum(abs(gross_amount)) FILTER (WHERE logical_entry_type = 'charge'), 0) + ${TOLERANCE}
              OR COALESCE(sum(abs(platform_fee_total_amount)) FILTER (WHERE logical_entry_type = 'refund_adjustment'), 0)
                   > COALESCE(sum(abs(platform_fee_total_amount)) FILTER (WHERE logical_entry_type = 'charge'), 0) + ${TOLERANCE}
              OR COALESCE(sum(abs(seller_net_amount)) FILTER (WHERE logical_entry_type = 'refund_adjustment'), 0)
                   > COALESCE(sum(abs(seller_net_amount)) FILTER (WHERE logical_entry_type = 'charge'), 0) + ${TOLERANCE}`
  },
  {
    name: "participant.charged_state_has_charge_fee_row",
    group: "participant",
    description: "money_state ChargedSuccess/RecoveredCharge/Refunded => a 'charge' fee row exists",
    requires: { ...feeRequires, ...participantRequires },
    sql: `SELECT p.participant_id AS id FROM siton.participants p
          WHERE p.money_state::text IN ${CHARGED_OR_REFUNDED}
            AND NOT EXISTS (SELECT 1 FROM ${FEE} m WHERE m.participant_id = p.participant_id AND m.logical_entry_type = 'charge')`
  },
  {
    name: "participant.refunded_state_has_refund_fee_row",
    group: "participant",
    description: "money_state Refunded => a 'refund_adjustment' fee row exists",
    requires: { ...feeRequires, ...participantRequires },
    sql: `SELECT p.participant_id AS id FROM siton.participants p
          WHERE p.money_state::text = 'Refunded'
            AND NOT EXISTS (SELECT 1 FROM ${FEE} m WHERE m.participant_id = p.participant_id AND m.logical_entry_type = 'refund_adjustment')`
  },
  {
    name: "participant.charged_state_has_successful_capture",
    group: "participant",
    description: "money_state ChargedSuccess/RecoveredCharge => a payment_attempts capture (charge_start/recovery) with result_class success",
    requires: { ...participantRequires, "siton.payment_attempts": ["participant_id", "deal_id", "attempt_type", "result_class"] },
    sql: `SELECT p.participant_id AS id FROM siton.participants p
          WHERE p.money_state::text IN ${CHARGED}
            AND NOT EXISTS (SELECT 1 FROM siton.payment_attempts pa
                            WHERE pa.participant_id = p.participant_id AND pa.deal_id = p.deal_id
                              AND pa.attempt_type IN ('charge_start','recovery') AND pa.result_class = 'success')`
  },
  {
    name: "participant.charge_fee_row_implies_charged_state",
    group: "participant",
    description: "a 'charge' fee row => money_state ChargedSuccess/RecoveredCharge/Refunded",
    requires: { ...feeRequires, ...participantRequires },
    sql: `SELECT p.participant_id AS id FROM siton.participants p
          WHERE p.money_state::text NOT IN ${CHARGED_OR_REFUNDED}
            AND EXISTS (SELECT 1 FROM ${FEE} m WHERE m.participant_id = p.participant_id AND m.logical_entry_type = 'charge')`
  },
  {
    name: "participant.refund_fee_row_implies_refunded_state",
    group: "participant",
    description: "a 'refund_adjustment' fee row => money_state Refunded",
    requires: { ...feeRequires, ...participantRequires },
    sql: `SELECT p.participant_id AS id FROM siton.participants p
          WHERE p.money_state::text <> 'Refunded'
            AND EXISTS (SELECT 1 FROM ${FEE} m WHERE m.participant_id = p.participant_id AND m.logical_entry_type = 'refund_adjustment')`
  },

  // ── deals ───────────────────────────────────────────────────────────────
  {
    name: "deal.joined_units_within_max_units",
    group: "deal",
    description: "sum(qty) of participants holding an authorization or a capture <= deals.max_units",
    requires: { ...participantRequires, ...dealRequires },
    sql: `SELECT d.deal_id AS id FROM siton.deals d
          JOIN siton.participants p ON p.deal_id = d.deal_id AND p.money_state::text IN ${HOLDING}
          GROUP BY d.deal_id, d.max_units HAVING sum(p.qty) > d.max_units`
  },
  {
    name: "deal.completed_has_charged_participant",
    group: "deal",
    description: "a Completed deal has >= 1 ChargedSuccess/RecoveredCharge participant",
    requires: { ...participantRequires, ...dealRequires },
    sql: `SELECT d.deal_id AS id FROM siton.deals d
          WHERE d.state::text = 'Completed'
            AND NOT EXISTS (SELECT 1 FROM siton.participants p WHERE p.deal_id = d.deal_id AND p.money_state::text IN ${CHARGED})`
  },
  {
    name: "deal.charged_participant_only_in_charged_deal",
    group: "deal",
    description: "a charged/refunded participant belongs to a deal in Charging/CompletionWindow/Completed/Failed",
    requires: { ...participantRequires, ...dealRequires },
    sql: `SELECT p.participant_id AS id FROM siton.participants p JOIN siton.deals d ON d.deal_id = p.deal_id
          WHERE p.money_state::text IN ${CHARGED_OR_REFUNDED}
            AND d.state::text NOT IN ('Charging','CompletionWindow','Completed','Failed')`
  },
  {
    name: "deal.charging_has_live_work",
    group: "deal",
    description: "a deal in Charging has a pending/processing charge_deal job, a DLQ row, a live payment_reconcile for a participant, or an open operational case",
    requires: { ...dealRequires, "siton.outbox_events": ["event_type", "aggregate_id", "status"], "siton.outbox_dlq": ["aggregate_id"], "siton.operational_cases": ["status", "deal_id", "participant_id", "auto_key", "correlation_id"] },
    sql: `SELECT d.deal_id AS id FROM siton.deals d
          WHERE d.state::text = 'Charging'
            AND NOT EXISTS (SELECT 1 FROM siton.outbox_events o WHERE o.event_type = 'charge_deal' AND o.aggregate_id = d.deal_id AND o.status IN ('pending','processing'))
            AND NOT EXISTS (SELECT 1 FROM siton.outbox_dlq q WHERE q.aggregate_id = d.deal_id)
            AND NOT EXISTS (SELECT 1 FROM siton.outbox_events o JOIN siton.participants p ON p.participant_id = o.aggregate_id
                            WHERE p.deal_id = d.deal_id AND o.event_type = 'payment_reconcile' AND o.status IN ('pending','processing'))
            AND NOT ${openCaseAbout("d.deal_id", null)}`
  },

  // ── payment attempts ────────────────────────────────────────────────────
  {
    name: "payment.stale_unresolved_attempt_has_reconcile_or_case",
    group: "payment",
    description: "a payment_attempt left unknown/dispatching > 15 min has a live payment_reconcile job, a live owning job, or an open operational case",
    requires: { "siton.payment_attempts": ["attempt_id", "participant_id", "correlation_id", "result_class", "dispatch_state", "owner_event_uuid", "updated_at", "created_at"], "siton.outbox_events": ["event_uuid", "event_type", "aggregate_id", "status"], "siton.operational_cases": ["status", "deal_id", "participant_id", "auto_key", "correlation_id"] },
    sql: `SELECT pa.attempt_id AS id FROM siton.payment_attempts pa
          WHERE (pa.result_class = 'unknown' OR pa.dispatch_state = 'dispatching')
            AND COALESCE(pa.updated_at, pa.created_at) < now() - interval '15 minutes'
            AND NOT EXISTS (SELECT 1 FROM siton.outbox_events o WHERE o.event_type = 'payment_reconcile' AND o.aggregate_id = pa.participant_id AND o.status IN ('pending','processing'))
            AND NOT EXISTS (SELECT 1 FROM siton.outbox_events o WHERE pa.owner_event_uuid IS NOT NULL AND o.event_uuid = pa.owner_event_uuid AND o.status IN ('pending','processing'))
            AND NOT ${openCaseAbout("pa.participant_id", "pa.correlation_id")}`
  },

  // ── inventory (Supabase staging schema siton_inventory, when present) ───
  {
    name: "inventory.counters_match_reservations",
    group: "inventory",
    description: "inventory_deals.reserved_units = sum(qty) held+committed and committed_units = sum(qty) committed",
    requires: { "siton_inventory.inventory_deals": ["deal_id", "reserved_units", "committed_units"], "siton_inventory.inventory_reservations": ["deal_id", "qty", "status"] },
    sql: `SELECT i.deal_id AS id FROM siton_inventory.inventory_deals i
          LEFT JOIN (SELECT deal_id,
                            COALESCE(sum(qty) FILTER (WHERE status IN ('held','committed')), 0) AS reserved,
                            COALESCE(sum(qty) FILTER (WHERE status = 'committed'), 0) AS committed
                     FROM siton_inventory.inventory_reservations GROUP BY deal_id) r ON r.deal_id = i.deal_id
          WHERE i.reserved_units <> COALESCE(r.reserved, 0) OR i.committed_units <> COALESCE(r.committed, 0)`
  },
  {
    name: "inventory.max_units_match_deal",
    group: "inventory",
    description: "inventory_deals.max_units = siton.deals.max_units and committed_units <= max_units",
    requires: { "siton_inventory.inventory_deals": ["deal_id", "max_units", "committed_units"], ...dealRequires },
    sql: `SELECT i.deal_id AS id FROM siton_inventory.inventory_deals i JOIN siton.deals d ON d.deal_id = i.deal_id
          WHERE i.max_units <> d.max_units OR i.committed_units > d.max_units`
  },
  {
    name: "inventory.committed_reservation_matches_participant",
    group: "inventory",
    description: "every committed reservation is referenced by exactly one participant with the same qty",
    requires: { "siton_inventory.inventory_reservations": ["reservation_id", "qty", "status"], "siton.participants": ["participant_id", "qty", "inventory_reservation_id"] },
    sql: `SELECT r.reservation_id AS id FROM siton_inventory.inventory_reservations r
          LEFT JOIN siton.participants p ON p.inventory_reservation_id = r.reservation_id
          WHERE r.status = 'committed'
          GROUP BY r.reservation_id, r.qty
          HAVING count(p.participant_id) <> 1 OR min(p.qty) IS DISTINCT FROM r.qty`
  },

  // ── outbox ──────────────────────────────────────────────────────────────
  {
    name: "outbox.dlq_older_than_1h_without_open_case",
    group: "outbox",
    mode: "info",
    description: "DLQ rows older than 1h with no soft-linked open operational case (no durable DLQ->case linkage exists, so this is report-only)",
    requires: { "siton.outbox_dlq": ["event_uuid", "aggregate_id", "correlation_id", "updated_at"], "siton.operational_cases": ["status", "deal_id", "participant_id", "auto_key", "correlation_id"] },
    sql: `SELECT q.event_uuid AS id FROM siton.outbox_dlq q
          WHERE q.updated_at < now() - interval '1 hour'
            AND NOT ${openCaseAbout("q.aggregate_id", "q.correlation_id")}`
  },

  // ── audit trail ─────────────────────────────────────────────────────────
  {
    name: "audit.deal_state_has_latest_transition",
    group: "audit",
    description: "a deal not in its initial state (Draft) has an audit_log deal_state row into its current state",
    requires: { ...dealRequires, "siton.audit_log": ["entity_type", "entity_id", "state_type", "to_state"] },
    sql: `SELECT d.deal_id AS id FROM siton.deals d
          WHERE d.state::text <> 'Draft'
            AND NOT EXISTS (SELECT 1 FROM siton.audit_log a WHERE a.entity_type = 'deal' AND a.entity_id = d.deal_id
                            AND a.state_type = 'deal_state' AND a.to_state = d.state::text)`
  },
  {
    name: "audit.participant_buyer_state_has_latest_transition",
    group: "audit",
    description: "a participant whose buyer_state is not NotJoined has an audit_log buyer_state row into its current state",
    requires: { ...participantRequires, "siton.audit_log": ["entity_type", "entity_id", "state_type", "to_state"] },
    sql: `SELECT p.participant_id AS id FROM siton.participants p
          WHERE p.buyer_state::text <> 'NotJoined'
            AND NOT EXISTS (SELECT 1 FROM siton.audit_log a WHERE a.entity_type = 'participant' AND a.entity_id = p.participant_id
                            AND a.state_type = 'buyer_state' AND a.to_state = p.buyer_state::text)`
  },
  {
    name: "audit.participant_money_state_has_latest_transition",
    group: "audit",
    description: "a participant whose money_state is not NoFinancial has an audit_log money_state row into its current state",
    requires: { ...participantRequires, "siton.audit_log": ["entity_type", "entity_id", "state_type", "to_state"] },
    sql: `SELECT p.participant_id AS id FROM siton.participants p
          WHERE p.money_state::text <> 'NoFinancial'
            AND NOT EXISTS (SELECT 1 FROM siton.audit_log a WHERE a.entity_type = 'participant' AND a.entity_id = p.participant_id
                            AND a.state_type = 'money_state' AND a.to_state = p.money_state::text)`
  },

  // ── seller payouts ──────────────────────────────────────────────────────
  {
    name: "payouts.amounts_non_negative",
    group: "payouts",
    description: "settlement / batch / batch-item money columns are >= 0 (seller_net_payable on settlements may be negative: that is the has_open_mismatch signal)",
    requires: {
      "siton.seller_settlements": ["seller_settlement_id", "gross_collected", "platform_fee_total", "refunds_total", "reserve_amount", "payout_amount", "paid_amount", "failed_amount", "returned_amount", "blocked_amount", "delayed_amount"],
      "siton.seller_payout_batches": ["payout_batch_id", "gross_collected", "platform_fee_total", "refunds_total", "reserve_amount", "payout_amount", "paid_amount", "failed_amount", "returned_amount", "blocked_amount", "delayed_amount"],
      "siton.seller_payout_batch_items": ["payout_item_id", "gross_collected", "platform_fee_total", "refunds_total", "reserve_amount", "seller_net_payable", "payout_amount"]
    },
    sql: `SELECT 'settlement:' || seller_settlement_id AS id FROM siton.seller_settlements
            WHERE LEAST(gross_collected, platform_fee_total, refunds_total, reserve_amount, payout_amount, paid_amount, failed_amount, returned_amount, blocked_amount, delayed_amount) < 0
          UNION ALL
          SELECT 'batch:' || payout_batch_id FROM siton.seller_payout_batches
            WHERE LEAST(gross_collected, platform_fee_total, refunds_total, reserve_amount, payout_amount, paid_amount, failed_amount, returned_amount, blocked_amount, delayed_amount) < 0
          UNION ALL
          SELECT 'item:' || payout_item_id FROM siton.seller_payout_batch_items
            WHERE LEAST(gross_collected, platform_fee_total, refunds_total, reserve_amount, seller_net_payable, payout_amount) < 0`
  },
  {
    name: "payouts.paid_not_exceeding_payout",
    group: "payouts",
    description: "paid_amount <= payout_amount on settlements and batches",
    requires: { "siton.seller_settlements": ["seller_settlement_id", "payout_amount", "paid_amount"], "siton.seller_payout_batches": ["payout_batch_id", "payout_amount", "paid_amount"] },
    sql: `SELECT 'settlement:' || seller_settlement_id AS id FROM siton.seller_settlements WHERE paid_amount > payout_amount + ${TOLERANCE}
          UNION ALL
          SELECT 'batch:' || payout_batch_id FROM siton.seller_payout_batches WHERE paid_amount > payout_amount + ${TOLERANCE}`
  },
  {
    name: "payouts.settlement_matches_fee_ledger",
    group: "payouts",
    description: "a settlement's gross/fee/refunds and seller_net_payable + reserve equal the deal's fee ledger as of last_calculated_at (refund rows are negative, so the net sum is net of refunds)",
    requires: { ...feeRequires, "siton.seller_settlements": ["seller_settlement_id", "deal_id", "gross_collected", "platform_fee_total", "refunds_total", "reserve_amount", "seller_net_payable", "last_calculated_at"] },
    sql: `SELECT s.seller_settlement_id AS id FROM siton.seller_settlements s
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(CASE WHEN m.gross_amount > 0 THEN m.gross_amount ELSE 0 END), 0) AS gross,
                   COALESCE(sum(m.platform_fee_total_amount), 0) AS fee,
                   COALESCE(sum(CASE WHEN m.gross_amount < 0 THEN abs(m.gross_amount) ELSE 0 END), 0) AS refunds,
                   COALESCE(sum(m.seller_net_amount), 0) AS net
            FROM ${FEE} m WHERE m.deal_id = s.deal_id AND m.created_at <= s.last_calculated_at) l ON true
          WHERE abs(s.gross_collected - l.gross) > ${TOLERANCE}
             OR abs(s.platform_fee_total - l.fee) > ${TOLERANCE}
             OR abs(s.refunds_total - l.refunds) > ${TOLERANCE}
             OR abs((s.seller_net_payable + s.reserve_amount) - l.net) > ${TOLERANCE}`
  },
  {
    name: "payouts.batch_item_matches_participant_ledger",
    group: "payouts",
    description: "a batch item's seller_net_payable equals its participant's net fee-ledger sum at item creation, and payout_amount = seller_net_payable - reserve",
    requires: { ...feeRequires, "siton.seller_payout_batch_items": ["payout_item_id", "participant_id", "seller_net_payable", "reserve_amount", "payout_amount", "created_at"] },
    sql: `SELECT i.payout_item_id AS id FROM siton.seller_payout_batch_items i
          LEFT JOIN LATERAL (SELECT COALESCE(sum(m.seller_net_amount), 0) AS net FROM ${FEE} m
                             WHERE m.participant_id = i.participant_id AND m.created_at <= i.created_at) l ON true
          WHERE abs(i.seller_net_payable - l.net) > ${TOLERANCE}
             OR abs(i.payout_amount - (i.seller_net_payable - i.reserve_amount)) > ${TOLERANCE}`
  },
  {
    name: "payouts.batch_items_sum_matches_batch",
    group: "payouts",
    description: "a batch's payout_amount equals the sum of its items' payout_amount and item_count equals its item rows",
    requires: { "siton.seller_payout_batches": ["payout_batch_id", "payout_amount", "item_count"], "siton.seller_payout_batch_items": ["payout_batch_id", "payout_amount"] },
    sql: `SELECT b.payout_batch_id AS id FROM siton.seller_payout_batches b
          JOIN (SELECT payout_batch_id, sum(payout_amount) AS total, count(*) AS n FROM siton.seller_payout_batch_items GROUP BY payout_batch_id) i
            ON i.payout_batch_id = b.payout_batch_id
          WHERE abs(b.payout_amount - i.total) > ${TOLERANCE} OR b.item_count <> i.n`
  }
];

// Everything the checker ever sends. Tests assert this list never contains a
// write; the transaction is READ ONLY regardless.
const SESSION = Object.freeze({
  begin: "BEGIN TRANSACTION READ ONLY",
  isolation: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  timeout: "SET LOCAL statement_timeout = '120s'",
  verify: "SELECT current_setting('transaction_read_only') AS ro",
  catalog: `SELECT table_schema || '.' || table_name AS t, column_name AS c
            FROM information_schema.columns WHERE table_schema IN ('siton','siton_inventory')`,
  end: "ROLLBACK"
});

function wrapCount(sql) {
  return `SELECT count(*)::int AS n, (array_agg(v.id::text ORDER BY v.id::text))[1:${SAMPLE_LIMIT}] AS samples FROM (${sql}) v`;
}

function missingRequirements(requires, catalog) {
  const missing = [];
  for (const [table, columns] of Object.entries(requires || {})) {
    const cols = catalog.get(table);
    if (!cols) { missing.push(table); continue; }
    for (const column of columns) if (!cols.has(column)) missing.push(table + "." + column);
  }
  return missing;
}

/** Target description that never carries credentials: host:port and db name only. */
function describeTarget(url) {
  try {
    const parsed = new URL(String(url));
    const db = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "(default)";
    return "host=" + (parsed.hostname || "(socket)") + (parsed.port ? ":" + parsed.port : "") + " db=" + db;
  } catch {
    return "host=(unparsed) db=(unparsed)";
  }
}

/** Strip anything that looks like a connection string or password from a message. */
function redact(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "<redacted-connection-string>")
    .replace(/(password\s*[=:]\s*)[^\s'"]+/gi, "$1<redacted>");
}

/**
 * Run the invariant set on an already-connected pg client inside ONE read-only
 * snapshot. Returns { results, overall, counts }. Never writes.
 */
async function runInvariants(client, options = {}) {
  const selected = options.only ? INVARIANTS.filter((inv) => options.only.includes(inv.name)) : INVARIANTS;
  const results = [];
  await client.query(SESSION.begin);
  try {
    await client.query(SESSION.isolation);
    await client.query(SESSION.timeout);
    const ro = await client.query(SESSION.verify);
    if (String(ro.rows[0] && ro.rows[0].ro) !== "on") throw new Error("transaction is not read-only; refusing to run");
    const catalogRows = (await client.query(SESSION.catalog)).rows;
    const catalog = new Map();
    for (const row of catalogRows) {
      if (!catalog.has(row.t)) catalog.set(row.t, new Set());
      catalog.get(row.t).add(row.c);
    }
    for (const inv of selected) {
      const base = { name: inv.name, group: inv.group, description: inv.description };
      const missing = missingRequirements(inv.requires, catalog);
      if (missing.length) { results.push({ ...base, status: "SKIPPED", count: 0, samples: [], reason: "absent: " + missing.join(", ") }); continue; }
      await client.query("SAVEPOINT money_invariant");
      try {
        const row = (await client.query(wrapCount(inv.sql))).rows[0] || { n: 0, samples: [] };
        const count = Number(row.n || 0);
        const result = { ...base, status: count === 0 ? "PASS" : (inv.mode === "info" ? "INFO" : "FAIL"), count, samples: row.samples || [] };
        if (inv.exactSql) result.exact_mismatch = Number(((await client.query(wrapCount(inv.exactSql))).rows[0] || {}).n || 0);
        results.push(result);
        await client.query("RELEASE SAVEPOINT money_invariant");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT money_invariant");
        results.push({ ...base, status: "ERROR", count: 0, samples: [], reason: redact(error && error.message ? error.message : error) });
      }
    }
  } finally {
    await client.query(SESSION.end).catch(() => undefined);
  }
  return summarize(results);
}

function summarize(results) {
  const counts = { PASS: 0, FAIL: 0, ERROR: 0, SKIPPED: 0, INFO: 0 };
  for (const result of results) counts[result.status] += 1;
  const overall = counts.FAIL || counts.ERROR ? "FAIL" : "PASS";
  return { overall, counts, results };
}

function formatResult(result) {
  const parts = ["MONEY_INVARIANT", result.status.padEnd(7), result.name, "count=" + result.count];
  if (result.exact_mismatch !== undefined) parts.push("exact_mismatch=" + result.exact_mismatch);
  parts.push("samples=[" + (result.samples || []).join(",") + "]");
  if (result.reason) parts.push("reason=" + JSON.stringify(result.reason));
  return parts.join(" ");
}

/** Stable, time-free projection for source-vs-restored comparison. */
function comparable(report) {
  return report.results.map((r) => ({ name: r.name, status: r.status, count: r.count, exact_mismatch: r.exact_mismatch, samples: r.samples }));
}

function failingNames(report) {
  return report.results.filter((r) => r.status === "FAIL" || r.status === "ERROR").map((r) => r.name);
}

module.exports = {
  INVARIANTS,
  SESSION,
  TOLERANCE,
  PLATFORM_FEE_RATE,
  SAMPLE_LIMIT,
  runInvariants,
  summarize,
  formatResult,
  describeTarget,
  redact,
  comparable,
  failingNames,
  wrapCount,
  missingRequirements
};
