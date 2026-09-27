-- 076_per_row_audit_outbox_enforcement
-- Red-team hardening (Finding C-1, Medium): the BEFORE UPDATE triggers of
-- 008/009/022 proved only that SOME audit (or outbox) row had been written
-- SOMEWHERE in the current transaction — a transaction-global flag
-- (siton.audit_written / siton.outbox_written) set by the application. They did
-- not prove that THIS row's transition has a matching audit row, so the DB's
-- last line of defence was one refactor (or one forged flag) away from a
-- silent gap. This migration adds the per-row assertion on top of the flag:
--
--   * a deal state change requires an audit_log row for THIS deal with THIS
--     from/to transition and THIS action, written in the CURRENT transaction;
--   * a participant buyer_state / money_state change requires the same for the
--     changed column(s);
--   * the outbox-required deal actions (009) require an outbox row for THIS
--     deal, of the event type that action must enqueue (deal.publish →
--     deadline_check, charging.start → charge_deal, charging.to_completion_window
--     → finalize_deal, charging.finalize_failed → refund_issue, deal.cancel →
--     cancel_refund), written in the current transaction — not merely a flag.
--
-- "Written in the current transaction" is decided by TRANSACTION IDENTITY,
-- not by wall-clock: the candidate row's xmin must be the current top-level
-- transaction id, or a subtransaction (SAVEPOINT) of it. A timestamp predicate
-- (created_at >= now()) was rejected in review (Codex on PR #97): under READ
-- COMMITTED a long transaction can see a matching row that ANOTHER
-- transaction committed after this one started, and a deliberately
-- future-dated row would satisfy every later transaction. Row identity has
-- neither hole: a row is visible to this transaction AND its xid is still "in
-- progress" only when this transaction (or one of its savepoints) wrote it.
--
-- The flag checks are kept (defence in depth; their error texts are relied on
-- by existing tests). The function bodies below are the 022 (deals) / 008
-- (participants) / 009 (outbox) versions plus the per-row assertion — nothing
-- is loosened.

CREATE INDEX IF NOT EXISTS ix_audit_log_entity_state_created
  ON siton.audit_log (entity_id, state_type, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_outbox_events_aggregate_created
  ON siton.outbox_events (aggregate_id, created_at DESC);

-- Does the row whose xmin is p_xmin belong to the CURRENT transaction (top
-- level or any of its subtransactions)? Callers only pass the xmin of a row
-- they can already see; a row from any OTHER in-progress transaction is never
-- visible, so "visible + xid in progress" identifies our own writes exactly.
CREATE OR REPLACE FUNCTION siton.row_xmin_is_current_tx(p_xmin xid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_current xid8 := pg_catalog.pg_current_xact_id();
  v_current32 numeric;
  v_row32 numeric;
  v_delta numeric;
BEGIN
  IF p_xmin = v_current::xid THEN
    RETURN true;
  END IF;
  -- A subtransaction id is assigned after (i.e. is greater than, modulo the
  -- 32-bit wrap) the top-level id it belongs to. Rebuild the row's 64-bit id
  -- from the current epoch and ask the clog: only our own subtransactions can
  -- be both visible to us and still in progress.
  v_current32 := (v_current::text::numeric) % 4294967296;
  v_row32 := p_xmin::text::numeric;
  v_delta := ((v_row32 - v_current32) + 4294967296) % 4294967296;
  IF v_delta = 0 OR v_delta >= 2147483648 THEN
    RETURN false; -- frozen/bootstrap xids and anything assigned before us
  END IF;
  RETURN pg_catalog.pg_xact_status((v_current::text::numeric + v_delta)::text::xid8) = 'in progress';
END
$$;
REVOKE EXECUTE ON FUNCTION siton.row_xmin_is_current_tx(xid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION siton.audit_row_written_in_tx(
  p_entity_type text,
  p_entity_id uuid,
  p_state_type text,
  p_from_state text,
  p_to_state text,
  p_action_name text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM siton.audit_log a
    WHERE a.entity_id = p_entity_id
      AND a.entity_type = p_entity_type
      AND a.state_type = p_state_type
      AND a.from_state = p_from_state
      AND a.to_state = p_to_state
      AND a.action_name = p_action_name
      AND siton.row_xmin_is_current_tx(a.xmin)
  )
$$;

-- The outbox row must be for THIS deal AND carry the event type the action
-- requires (a same-deal row of any other type, e.g. a sent deadline_check,
-- must not let a deal enter Charging without its charge_deal job).
CREATE OR REPLACE FUNCTION siton.outbox_row_written_in_tx(
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM siton.outbox_events o
    WHERE o.aggregate_id = p_aggregate_id
      AND o.aggregate_type = p_aggregate_type
      AND o.event_type = p_event_type
      AND siton.row_xmin_is_current_tx(o.xmin)
  )
$$;

-- Least-privilege EXECUTE surface (mirrors supabase/staging/008 for the
-- existing trigger helpers): trigger bodies run with the CALLER's rights, so
-- the runtime roles need explicit EXECUTE on these non-mutating helpers, and
-- the browser roles must never have it. SECURITY DEFINER lets the EXISTS probe
-- read audit_log / outbox_events regardless of the caller's row policies; the
-- functions only ever return a boolean.
REVOKE EXECUTE ON FUNCTION siton.audit_row_written_in_tx(text, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION siton.outbox_row_written_in_tx(text, uuid, text) FROM PUBLIC;
DO $per_row_helper_grants$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION siton.audit_row_written_in_tx(text, uuid, text, text, text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION siton.outbox_row_written_in_tx(text, uuid, text) FROM %I', v_role);
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['siton_web_runtime', 'siton_worker_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION siton.audit_row_written_in_tx(text, uuid, text, text, text, text) TO %I', v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION siton.outbox_row_written_in_tx(text, uuid, text) TO %I', v_role);
    END IF;
  END LOOP;
END
$per_row_helper_grants$;

CREATE OR REPLACE FUNCTION siton.deals_before_update_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
BEGIN
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'deals.published_at is immutable once set';
  END IF;

  IF OLD.published_at IS NOT NULL THEN
    IF NEW.threshold_units IS DISTINCT FROM OLD.threshold_units THEN
      RAISE EXCEPTION 'deals.threshold_units is immutable after publish';
    END IF;
    IF NEW.price_per_unit IS DISTINCT FROM OLD.price_per_unit THEN
      RAISE EXCEPTION 'deals.price_per_unit is immutable after publish';
    END IF;
    IF NEW.min_units IS DISTINCT FROM OLD.min_units THEN
      RAISE EXCEPTION 'deals.min_units is immutable after publish';
    END IF;
    IF NEW.max_units IS DISTINCT FROM OLD.max_units THEN
      RAISE EXCEPTION 'deals.max_units is immutable after publish';
    END IF;
    IF NEW.deadline IS DISTINCT FROM OLD.deadline THEN
      RAISE EXCEPTION 'deals.deadline is immutable after publish';
    END IF;
  END IF;

  IF OLD.completion_window_until IS NOT NULL
     AND NEW.completion_window_until IS DISTINCT FROM OLD.completion_window_until THEN
    RAISE EXCEPTION 'deals.completion_window_until is immutable once set';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_action := siton.require_action_name();
    IF NOT siton.is_valid_deal_transition(OLD.state::text, NEW.state::text) THEN
      RAISE EXCEPTION 'illegal deal transition from=% to=% action=%', OLD.state, NEW.state, v_action;
    END IF;
    IF NOT siton.flag_is_set('siton.audit_written') THEN
      RAISE EXCEPTION 'deal state change requires audit_log in same transaction. action=%', v_action;
    END IF;
    -- Per-row assertion (C-1): the audit row must be for THIS deal and THIS transition.
    IF NOT siton.audit_row_written_in_tx('deal', NEW.deal_id, 'deal_state', OLD.state::text, NEW.state::text, v_action) THEN
      RAISE EXCEPTION 'deal state change requires a matching audit_log row for this deal in the same transaction. deal=% from=% to=% action=%',
        NEW.deal_id, OLD.state, NEW.state, v_action;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION siton.participants_before_update_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
BEGIN
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'participants.locked_at is immutable once set';
  END IF;

  IF OLD.locked_at IS NOT NULL AND NEW.qty IS DISTINCT FROM OLD.qty THEN
    RAISE EXCEPTION 'participants.qty is immutable once locked_at is set';
  END IF;

  IF NEW.buyer_state IS DISTINCT FROM OLD.buyer_state
     OR NEW.money_state IS DISTINCT FROM OLD.money_state THEN
    v_action := siton.require_action_name();

    IF NEW.buyer_state IS DISTINCT FROM OLD.buyer_state
       AND NOT siton.is_valid_buyer_transition(OLD.buyer_state::text, NEW.buyer_state::text) THEN
      RAISE EXCEPTION 'illegal participant buyer_state transition % -> % action=%', OLD.buyer_state, NEW.buyer_state, v_action;
    END IF;

    IF NEW.money_state IS DISTINCT FROM OLD.money_state
       AND NOT siton.is_valid_money_transition(OLD.money_state::text, NEW.money_state::text) THEN
      RAISE EXCEPTION 'illegal participant money_state transition % -> % action=%', OLD.money_state, NEW.money_state, v_action;
    END IF;

    IF NOT siton.flag_is_set('siton.audit_written') THEN
      RAISE EXCEPTION 'participant state change requires audit_log in same transaction. action=%', v_action;
    END IF;

    -- Per-row assertion (C-1): each changed column needs its own matching audit row.
    IF NEW.buyer_state IS DISTINCT FROM OLD.buyer_state
       AND NOT siton.audit_row_written_in_tx('participant', NEW.participant_id, 'buyer_state', OLD.buyer_state::text, NEW.buyer_state::text, v_action) THEN
      RAISE EXCEPTION 'participant buyer_state change requires a matching audit_log row for this participant in the same transaction. participant=% from=% to=% action=%',
        NEW.participant_id, OLD.buyer_state, NEW.buyer_state, v_action;
    END IF;
    IF NEW.money_state IS DISTINCT FROM OLD.money_state
       AND NOT siton.audit_row_written_in_tx('participant', NEW.participant_id, 'money_state', OLD.money_state::text, NEW.money_state::text, v_action) THEN
      RAISE EXCEPTION 'participant money_state change requires a matching audit_log row for this participant in the same transaction. participant=% from=% to=% action=%',
        NEW.participant_id, OLD.money_state, NEW.money_state, v_action;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION siton.deals_outbox_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
  v_event_type text;
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_action := siton.require_action_name();

    IF v_action IN (
      'deal.publish',
      'charging.start',
      'charging.to_completion_window',
      'charging.finalize_failed',
      'deal.cancel'
    ) THEN
      IF NOT siton.flag_is_set('siton.outbox_written') THEN
        RAISE EXCEPTION 'deal state change requires outbox in same transaction. action=%', v_action;
      END IF;
      -- Per-row assertion (C-1): the outbox row must be for THIS deal and
      -- must be the job this action exists to enqueue.
      v_event_type := CASE v_action
        WHEN 'deal.publish' THEN 'deadline_check'
        WHEN 'charging.start' THEN 'charge_deal'
        WHEN 'charging.to_completion_window' THEN 'finalize_deal'
        WHEN 'charging.finalize_failed' THEN 'refund_issue'
        WHEN 'deal.cancel' THEN 'cancel_refund'
      END;
      IF NOT siton.outbox_row_written_in_tx('deal', NEW.deal_id, v_event_type) THEN
        RAISE EXCEPTION 'deal state change requires a % outbox_events row for this deal in the same transaction. deal=% action=%', v_event_type, NEW.deal_id, v_action;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- The triggers themselves are unchanged (008/009 attach them to these function
-- names); CREATE OR REPLACE above swaps the bodies in place.
