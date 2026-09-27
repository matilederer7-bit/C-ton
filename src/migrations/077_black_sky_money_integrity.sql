-- 077 — Black-Sky money integrity.
--
-- A-F1: a deal paused (ClosedForJoining) while still below its threshold must
-- FAIL at its deadline exactly like an open one. Before, the only exits from a
-- paused deal were ReadyForCharging / reopen, so a below-threshold paused deal
-- either sat forever holding every buyer's authorization or was charged below
-- its minimum. The worker's deadline_check now fails it; the DB transition
-- authority must admit ClosedForJoining -> Failed (mirrored in the TS
-- DEAL_TRANSITIONS map). prepare_charging separately refuses below threshold.
--
-- D5: payout rail forward-only status and monotonic settlement amounts, so a
-- stale writer (a pre-dispatch snapshot committed after paid, a racing refund
-- recompute) cannot regress money state. The rank is inlined in each trigger
-- function (no separately-granted helper: staging revokes default EXECUTE on
-- new siton functions from the runtime roles).
--
-- Amount CHECKs are added NOT VALID (enforced for every new/updated row at
-- once) and then validated; a legacy row that violates one leaves that
-- constraint NOT VALID with a WARNING instead of failing the migration — the
-- read-only money invariants checker (scripts/money_invariants.cjs) reports
-- the offending rows for manual review.

BEGIN;

SET search_path TO siton, public;

CREATE OR REPLACE FUNCTION siton.is_valid_deal_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'Draft' AND v_to IN ('PendingTarget', 'Cancelled') THEN true
    WHEN v_from = 'PendingTarget' AND v_to IN ('TargetReached', 'Failed', 'ClosedForJoining') THEN true
    WHEN v_from = 'TargetReached' AND v_to = 'ClosedForJoining' THEN true
    WHEN v_from = 'ClosedForJoining' AND v_to IN ('ReadyForCharging', 'PendingTarget', 'TargetReached', 'Failed') THEN true
    WHEN v_from = 'ReadyForCharging' AND v_to = 'Charging' THEN true
    WHEN v_from = 'Charging' AND v_to = 'CompletionWindow' THEN true
    WHEN v_from = 'CompletionWindow' AND v_to IN ('Completed', 'Failed') THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.enforce_payout_status_forward_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old int;
  v_new int;
BEGIN
  IF NEW.payout_status IS DISTINCT FROM OLD.payout_status THEN
    v_old := CASE OLD.payout_status WHEN 'pending' THEN 0 WHEN 'ready' THEN 0 WHEN 'batched' THEN 2
      WHEN 'processing' THEN 3 WHEN 'failed' THEN 4 WHEN 'returned' THEN 4 WHEN 'paid' THEN 5
      WHEN 'reconciled' THEN 6 END;
    v_new := CASE NEW.payout_status WHEN 'pending' THEN 0 WHEN 'ready' THEN 0 WHEN 'batched' THEN 2
      WHEN 'processing' THEN 3 WHEN 'failed' THEN 4 WHEN 'returned' THEN 4 WHEN 'paid' THEN 5
      WHEN 'reconciled' THEN 6 END;
    IF v_old > 0 AND v_new <= v_old THEN
      RAISE EXCEPTION 'payout_status_regression: % -> % on %', OLD.payout_status, NEW.payout_status, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_seller_settlements_status_forward_only ON siton.seller_settlements;
CREATE TRIGGER trg_seller_settlements_status_forward_only
  BEFORE UPDATE OF payout_status ON siton.seller_settlements
  FOR EACH ROW EXECUTE FUNCTION siton.enforce_payout_status_forward_only();
DROP TRIGGER IF EXISTS trg_seller_payout_batches_status_forward_only ON siton.seller_payout_batches;
CREATE TRIGGER trg_seller_payout_batches_status_forward_only
  BEFORE UPDATE OF payout_status ON siton.seller_payout_batches
  FOR EACH ROW EXECUTE FUNCTION siton.enforce_payout_status_forward_only();
DROP TRIGGER IF EXISTS trg_seller_payout_batch_items_status_forward_only ON siton.seller_payout_batch_items;
CREATE TRIGGER trg_seller_payout_batch_items_status_forward_only
  BEFORE UPDATE OF payout_status ON siton.seller_payout_batch_items
  FOR EACH ROW EXECUTE FUNCTION siton.enforce_payout_status_forward_only();

CREATE OR REPLACE FUNCTION siton.enforce_seller_settlement_monotonic_amounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.refunds_total < OLD.refunds_total THEN
    RAISE EXCEPTION 'seller_settlement_refunds_total_decrease: % -> %', OLD.refunds_total, NEW.refunds_total
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.paid_amount < OLD.paid_amount THEN
    RAISE EXCEPTION 'seller_settlement_paid_amount_decrease: % -> %', OLD.paid_amount, NEW.paid_amount
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.payout_status NOT IN ('pending', 'ready') AND NEW.payout_amount IS DISTINCT FROM OLD.payout_amount THEN
    RAISE EXCEPTION 'seller_settlement_payout_amount_frozen_after_batch: % -> %', OLD.payout_amount, NEW.payout_amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_seller_settlements_monotonic_amounts ON siton.seller_settlements;
CREATE TRIGGER trg_seller_settlements_monotonic_amounts
  BEFORE UPDATE ON siton.seller_settlements
  FOR EACH ROW EXECUTE FUNCTION siton.enforce_seller_settlement_monotonic_amounts();

ALTER TABLE siton.seller_settlements
  DROP CONSTRAINT IF EXISTS seller_settlements_amounts_non_negative,
  DROP CONSTRAINT IF EXISTS seller_settlements_paid_le_payout,
  DROP CONSTRAINT IF EXISTS seller_settlements_prebatch_payout_le_net;
ALTER TABLE siton.seller_settlements
  ADD CONSTRAINT seller_settlements_amounts_non_negative CHECK (
    gross_collected >= 0 AND refunds_total >= 0 AND reserve_amount >= 0 AND payout_amount >= 0
    AND paid_amount >= 0 AND blocked_amount >= 0 AND delayed_amount >= 0) NOT VALID,
  ADD CONSTRAINT seller_settlements_paid_le_payout CHECK (paid_amount <= payout_amount) NOT VALID,
  ADD CONSTRAINT seller_settlements_prebatch_payout_le_net CHECK (
    payout_status NOT IN ('pending', 'ready') OR payout_amount <= GREATEST(seller_net_payable, 0)) NOT VALID;

ALTER TABLE siton.seller_payout_batches
  DROP CONSTRAINT IF EXISTS seller_payout_batches_amounts_non_negative,
  DROP CONSTRAINT IF EXISTS seller_payout_batches_paid_le_payout,
  DROP CONSTRAINT IF EXISTS seller_payout_batches_payout_le_net;
ALTER TABLE siton.seller_payout_batches
  ADD CONSTRAINT seller_payout_batches_amounts_non_negative CHECK (
    gross_collected >= 0 AND refunds_total >= 0 AND reserve_amount >= 0 AND payout_amount >= 0
    AND paid_amount >= 0) NOT VALID,
  ADD CONSTRAINT seller_payout_batches_paid_le_payout CHECK (paid_amount <= payout_amount) NOT VALID,
  ADD CONSTRAINT seller_payout_batches_payout_le_net CHECK (payout_amount <= seller_net_payable) NOT VALID;

ALTER TABLE siton.seller_payout_batch_items
  DROP CONSTRAINT IF EXISTS seller_payout_batch_items_amounts_non_negative,
  DROP CONSTRAINT IF EXISTS seller_payout_batch_items_payout_le_net;
ALTER TABLE siton.seller_payout_batch_items
  ADD CONSTRAINT seller_payout_batch_items_amounts_non_negative CHECK (
    gross_collected >= 0 AND refunds_total >= 0 AND reserve_amount >= 0 AND payout_amount >= 0) NOT VALID,
  ADD CONSTRAINT seller_payout_batch_items_payout_le_net CHECK (payout_amount <= seller_net_payable) NOT VALID;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('seller_settlements', 'seller_settlements_amounts_non_negative'),
    ('seller_settlements', 'seller_settlements_paid_le_payout'),
    ('seller_settlements', 'seller_settlements_prebatch_payout_le_net'),
    ('seller_payout_batches', 'seller_payout_batches_amounts_non_negative'),
    ('seller_payout_batches', 'seller_payout_batches_paid_le_payout'),
    ('seller_payout_batches', 'seller_payout_batches_payout_le_net'),
    ('seller_payout_batch_items', 'seller_payout_batch_items_amounts_non_negative'),
    ('seller_payout_batch_items', 'seller_payout_batch_items_payout_le_net')
  ) AS t(tbl, con) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE siton.%I VALIDATE CONSTRAINT %I', r.tbl, r.con);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'black_sky_077: % left NOT VALID (legacy rows violate it; see scripts/money_invariants.cjs)', r.con;
    END;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_payout_recon_cases_open_per_batch_type
  ON siton.seller_payout_reconciliation_cases (payout_batch_id, case_type)
  WHERE case_status = 'open' AND payout_batch_id IS NOT NULL;

COMMIT;
