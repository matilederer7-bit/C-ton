-- 078 — Black-Sky database integrity.
--
-- D2 (HIGH) A deal DELETE could wipe money and audit history: the web runtime
--    holds DELETE on siton.deals (seller draft-delete route) and the FKs from
--    participants, payment_attempts, platform_fee_money_events, the payout
--    rail and fulfillment_units were ON DELETE CASCADE. Now:
--      * those money FKs are ON DELETE RESTRICT (dropped and re-added by name,
--        NOT VALID then VALIDATE);
--      * a BEFORE DELETE guard on siton.deals refuses any deal that was ever
--        published, is past Draft/Cancelled, or has participant/money rows
--        (participants, payment attempts, fee ledger, webhook evidence,
--        authorization bindings, invoice documents). A never-published draft
--        with none of those stays deletable and its CONTENT rows (images,
--        delivery options, terms, chat, field-change audit of the draft) still
--        cascade exactly as before;
--      * test fixtures keep their cleanup through an explicit escape hatch that
--        exists ONLY when siton.allow_test_actions = '1' (set per disposable
--        test database by the isolation helpers, never on staging/production)
--        AND neither current_user nor session_user is a runtime role or a
--        non-superuser member of one (a superuser acting as itself is the
--        operator; a superuser that SET ROLEs to a runtime role is caught via
--        current_user; the staging login roles are non-superuser members).
--        The hatch purges the deal's money rows itself (RESTRICT would refuse
--        otherwise) and records what it purged in siton.fixture_purge_audit
--        (append-only).
-- D3 'test.%' action names are valid only when siton.allow_test_actions = '1'.
--    The outbox requirement is additionally keyed by the TRANSITION whose
--    target state must enqueue work (Draft->PendingTarget deadline_check,
--    ReadyForCharging->Charging charge_deal, Charging->CompletionWindow
--    finalize_deal, CompletionWindow->Failed refund_issue, Draft->Cancelled
--    cancel_refund), whatever the action name; the 076 per-action mapping is
--    kept unchanged on top.
-- D10 price_per_unit > 0 and participant delivery_cost >= 0 (NOT VALID, then
--    validated; a legacy violation leaves the constraint NOT VALID with a
--    WARNING instead of failing the migration); seller_id is frozen once a
--    deal is published; a participant's delivery fields are frozen once a
--    charge began.
-- D9 an issued invoice document (status issued/reconciled, or issued_at /
--    provider_document_id set) is immutable in identity and amounts, never
--    returns to pending/processing and is never deleted (outside the fixture
--    hatch); at most one issued charge/refund receipt per participant.
--    payment_attempts identity columns are immutable; webhook_events
--    provider/event_id/received_at are immutable and deal_id/participant_id/
--    request_id are set-once.
-- D12 the constraints left NOT VALID by 007/045 are validated (a legacy
--    violation leaves the constraint NOT VALID with a WARNING).
--
-- Every new function is a TRIGGER function (no runtime EXECUTE needed; see
-- supabase/staging/024) and runs with the caller's rights; nothing here is
-- SECURITY DEFINER. The web runtime can read every table the deal-delete guard
-- probes (supabase/staging/006 + 018).

BEGIN;

SET search_path TO siton, public;

-- ── D3: test action names only in test databases ─────────────────────────
CREATE OR REPLACE FUNCTION siton.is_valid_action_name(action_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT (
      COALESCE(action_name, '') LIKE 'test.%'
      AND COALESCE(current_setting('siton.allow_test_actions', true), '') = '1'
    )
    OR COALESCE(action_name, '') IN (
    'participant.join_authorize',
    'deal.publish',
    'deal.target_reached',
    'deal.close_joining',
    'deal.reopen_joining',
    'deal.prepare_charging',
    'charging.start',
    'charging.capture_success',
    'charging.capture_failed',
    'charging.recovery_success',
    'charging.recovery_failed',
    'charging.to_completion_window',
    'charging.finalize_completed',
    'charging.finalize_failed',
    'deal.complete_participant',
    'deal.fail_participant',
    'deal.fail_participant_after_completed',
    'deal.deadline_check',
    'deal.cancel',
    'refund.issue',
    'authorization.release'
  )
$$;

-- ── D3: outbox requirement keyed by transition (076 action keying kept) ───
CREATE OR REPLACE FUNCTION siton.deals_outbox_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
  v_action_event text;
  v_transition_event text;
  v_event_type text;
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_action := siton.require_action_name();

    v_action_event := CASE v_action
      WHEN 'deal.publish' THEN 'deadline_check'
      WHEN 'charging.start' THEN 'charge_deal'
      WHEN 'charging.to_completion_window' THEN 'finalize_deal'
      WHEN 'charging.finalize_failed' THEN 'refund_issue'
      WHEN 'deal.cancel' THEN 'cancel_refund'
    END;
    v_transition_event := CASE
      WHEN OLD.state::text = 'Draft' AND NEW.state::text = 'PendingTarget' THEN 'deadline_check'
      WHEN OLD.state::text = 'ReadyForCharging' AND NEW.state::text = 'Charging' THEN 'charge_deal'
      WHEN OLD.state::text = 'Charging' AND NEW.state::text = 'CompletionWindow' THEN 'finalize_deal'
      WHEN OLD.state::text = 'CompletionWindow' AND NEW.state::text = 'Failed' THEN 'refund_issue'
      WHEN OLD.state::text = 'Draft' AND NEW.state::text = 'Cancelled' THEN 'cancel_refund'
    END;

    IF v_action_event IS NOT NULL OR v_transition_event IS NOT NULL THEN
      IF NOT siton.flag_is_set('siton.outbox_written') THEN
        RAISE EXCEPTION 'deal state change requires outbox in same transaction. action=%', v_action;
      END IF;
      FOREACH v_event_type IN ARRAY ARRAY[v_action_event, v_transition_event] LOOP
        CONTINUE WHEN v_event_type IS NULL;
        IF NOT siton.outbox_row_written_in_tx('deal', NEW.deal_id, v_event_type) THEN
          RAISE EXCEPTION 'deal state change requires a % outbox_events row for this deal in the same transaction. deal=% action=% transition=%->%',
            v_event_type, NEW.deal_id, v_action, OLD.state, NEW.state;
        END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- ── D2: fixture purge audit (append-only) ────────────────────────────────
CREATE TABLE IF NOT EXISTS siton.fixture_purge_audit (
  purge_id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('deal', 'participant', 'invoice_document')),
  entity_id UUID NOT NULL,
  deal_id UUID NULL,
  purged JSONB NOT NULL DEFAULT '{}'::jsonb,
  db_session_user TEXT NOT NULL DEFAULT session_user,
  db_current_user TEXT NOT NULL DEFAULT current_user,
  txid BIGINT NOT NULL DEFAULT txid_current(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS ix_fixture_purge_audit_deal ON siton.fixture_purge_audit (deal_id, created_at DESC);

CREATE OR REPLACE FUNCTION siton.fixture_purge_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fixture_purge_audit is append-only';
END
$$;
DROP TRIGGER IF EXISTS trg_fixture_purge_audit_append_only ON siton.fixture_purge_audit;
CREATE TRIGGER trg_fixture_purge_audit_append_only
  BEFORE UPDATE OR DELETE ON siton.fixture_purge_audit
  FOR EACH ROW EXECUTE FUNCTION siton.fixture_purge_audit_append_only();

REVOKE ALL ON TABLE siton.fixture_purge_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE siton.fixture_purge_audit_purge_id_seq FROM PUBLIC;
DO $fixture_audit_grants$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'siton_web_runtime', 'siton_worker_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE siton.fixture_purge_audit FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE siton.fixture_purge_audit_purge_id_seq FROM %I', v_role);
    END IF;
  END LOOP;
END
$fixture_audit_grants$;

-- ── D2: money FKs → ON DELETE RESTRICT ───────────────────────────────────
DO $restrict_fks$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('participants', 'participants_deal_id_fkey', 'deal_id', 'deals', 'deal_id'),
    ('payment_attempts', 'payment_attempts_deal_id_fkey', 'deal_id', 'deals', 'deal_id'),
    ('payment_attempts', 'payment_attempts_participant_id_fkey', 'participant_id', 'participants', 'participant_id'),
    ('platform_fee_money_events', 'platform_fee_money_events_deal_id_fkey', 'deal_id', 'deals', 'deal_id'),
    ('platform_fee_money_events', 'platform_fee_money_events_participant_id_fkey', 'participant_id', 'participants', 'participant_id'),
    ('seller_settlements', 'seller_settlements_deal_id_fkey', 'deal_id', 'deals', 'deal_id'),
    ('seller_payout_batches', 'seller_payout_batches_trigger_deal_id_fkey', 'trigger_deal_id', 'deals', 'deal_id'),
    ('seller_payout_batch_items', 'seller_payout_batch_items_deal_id_fkey', 'deal_id', 'deals', 'deal_id'),
    ('seller_payout_batch_items', 'seller_payout_batch_items_participant_id_fkey', 'participant_id', 'participants', 'participant_id'),
    ('seller_payout_reconciliation_cases', 'seller_payout_reconciliation_cases_deal_id_fkey', 'deal_id', 'deals', 'deal_id'),
    ('fulfillment_units', 'fulfillment_units_deal_id_fkey', 'deal_id', 'deals', 'deal_id'),
    ('fulfillment_units', 'fulfillment_units_participant_id_fkey', 'participant_id', 'participants', 'participant_id')
  ) AS t(tbl, con, col, reftbl, refcol) LOOP
    IF to_regclass(format('siton.%I', r.tbl)) IS NULL THEN
      RAISE WARNING 'black_sky_078: table siton.% missing; FK % not re-created', r.tbl, r.con;
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE siton.%I DROP CONSTRAINT IF EXISTS %I, ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES siton.%I(%I) ON DELETE RESTRICT NOT VALID',
      r.tbl, r.con, r.con, r.col, r.reftbl, r.refcol);
    BEGIN
      EXECUTE format('ALTER TABLE siton.%I VALIDATE CONSTRAINT %I', r.tbl, r.con);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'black_sky_078: % left NOT VALID (orphaned legacy rows); it is still enforced for new rows', r.con;
    END;
  END LOOP;
END
$restrict_fks$;

-- ── D2: BEFORE DELETE guard on deals (+ fixture hatch) ───────────────────
CREATE OR REPLACE FUNCTION siton.deals_before_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_history boolean;
  v_hatch boolean;
  v_purged jsonb := '{}'::jsonb;
  v_n bigint;
BEGIN
  v_history := EXISTS (SELECT 1 FROM siton.participants WHERE deal_id = OLD.deal_id)
    OR EXISTS (SELECT 1 FROM siton.payment_attempts WHERE deal_id = OLD.deal_id)
    OR EXISTS (SELECT 1 FROM siton.platform_fee_money_events WHERE deal_id = OLD.deal_id)
    OR EXISTS (SELECT 1 FROM siton.webhook_events WHERE deal_id = OLD.deal_id)
    OR EXISTS (SELECT 1 FROM siton.payment_authorization_bindings WHERE deal_id = OLD.deal_id)
    OR EXISTS (SELECT 1 FROM siton.invoice_documents WHERE deal_id = OLD.deal_id);

  IF OLD.published_at IS NULL AND OLD.state::text IN ('Draft', 'Cancelled') AND NOT v_history THEN
    RETURN OLD;
  END IF;

  -- Fixture escape hatch: test databases only, never a runtime role.
  v_hatch := COALESCE(pg_catalog.current_setting('siton.allow_test_actions', true), '') = '1'
    AND NOT EXISTS (
      WITH RECURSIVE runtime(oid) AS (
        SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname IN ('siton_web_runtime', 'siton_worker_runtime')
        UNION
        SELECT m.member FROM pg_catalog.pg_auth_members m JOIN runtime ON m.roleid = runtime.oid
      )
      SELECT 1 FROM runtime JOIN pg_catalog.pg_roles me ON me.oid = runtime.oid
      WHERE me.rolname IN (current_user::text, session_user::text) AND NOT me.rolsuper
    );
  IF NOT v_hatch THEN
    RAISE EXCEPTION 'deal_delete_refused: deal % (state=%, published_at=%) was published or carries participant/money history; such a deal is cancelled or failed, never deleted',
      OLD.deal_id, OLD.state, OLD.published_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  WITH d AS (
    DELETE FROM siton.seller_payout_batch_items
    WHERE deal_id = OLD.deal_id
       OR payout_batch_id IN (SELECT payout_batch_id FROM siton.seller_payout_batches WHERE trigger_deal_id = OLD.deal_id)
    RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('seller_payout_batch_items', v_n);
  WITH d AS (DELETE FROM siton.seller_payout_reconciliation_cases WHERE deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('seller_payout_reconciliation_cases', v_n);
  WITH d AS (DELETE FROM siton.seller_settlements WHERE deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('seller_settlements', v_n);
  WITH d AS (DELETE FROM siton.seller_payout_batches WHERE trigger_deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('seller_payout_batches', v_n);
  WITH d AS (DELETE FROM siton.platform_fee_money_events WHERE deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('platform_fee_money_events', v_n);
  WITH d AS (DELETE FROM siton.fulfillment_units WHERE deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('fulfillment_units', v_n);
  WITH d AS (DELETE FROM siton.payment_attempts WHERE deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('payment_attempts', v_n);
  WITH d AS (DELETE FROM siton.webhook_events WHERE deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('webhook_events', v_n);
  WITH d AS (
    DELETE FROM siton.payment_authorization_bindings
    WHERE deal_id = OLD.deal_id
       OR consumed_by_participant_id IN (SELECT participant_id FROM siton.participants WHERE deal_id = OLD.deal_id)
    RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('payment_authorization_bindings', v_n);
  WITH d AS (DELETE FROM siton.participants WHERE deal_id = OLD.deal_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_purged := v_purged || jsonb_build_object('participants', v_n,
    'state', OLD.state::text, 'published_at', OLD.published_at);

  INSERT INTO siton.fixture_purge_audit (entity_type, entity_id, deal_id, purged)
  VALUES ('deal', OLD.deal_id, OLD.deal_id, v_purged);
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_deals_before_delete_guard ON siton.deals;
CREATE TRIGGER trg_deals_before_delete_guard
  BEFORE DELETE ON siton.deals
  FOR EACH ROW EXECUTE FUNCTION siton.deals_before_delete_guard();

-- Participants: the web runtime has no DELETE here; RESTRICT protects the
-- money rows. In a test database the hatch purges this participant's money
-- rows first so fixture cleanups keep working (audited when anything is
-- purged). Outside the hatch this trigger changes nothing.
CREATE OR REPLACE FUNCTION siton.participants_before_delete_fixture_purge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_purged jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_n bigint;
BEGIN
  IF COALESCE(pg_catalog.current_setting('siton.allow_test_actions', true), '') <> '1' THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    WITH RECURSIVE runtime(oid) AS (
      SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname IN ('siton_web_runtime', 'siton_worker_runtime')
      UNION
      SELECT m.member FROM pg_catalog.pg_auth_members m JOIN runtime ON m.roleid = runtime.oid
    )
    SELECT 1 FROM runtime JOIN pg_catalog.pg_roles me ON me.oid = runtime.oid
    WHERE me.rolname IN (current_user::text, session_user::text) AND NOT me.rolsuper
  ) THEN
    RETURN OLD;
  END IF;

  WITH d AS (DELETE FROM siton.fulfillment_units WHERE participant_id = OLD.participant_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_total := v_total + v_n; v_purged := v_purged || jsonb_build_object('fulfillment_units', v_n);
  WITH d AS (DELETE FROM siton.seller_payout_batch_items WHERE participant_id = OLD.participant_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_total := v_total + v_n; v_purged := v_purged || jsonb_build_object('seller_payout_batch_items', v_n);
  WITH d AS (DELETE FROM siton.platform_fee_money_events WHERE participant_id = OLD.participant_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_total := v_total + v_n; v_purged := v_purged || jsonb_build_object('platform_fee_money_events', v_n);
  WITH d AS (DELETE FROM siton.payment_attempts WHERE participant_id = OLD.participant_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_total := v_total + v_n; v_purged := v_purged || jsonb_build_object('payment_attempts', v_n);
  WITH d AS (DELETE FROM siton.webhook_events WHERE participant_id = OLD.participant_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_total := v_total + v_n; v_purged := v_purged || jsonb_build_object('webhook_events', v_n);
  WITH d AS (DELETE FROM siton.payment_authorization_bindings WHERE consumed_by_participant_id = OLD.participant_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_total := v_total + v_n; v_purged := v_purged || jsonb_build_object('payment_authorization_bindings', v_n);

  IF v_total > 0 THEN
    INSERT INTO siton.fixture_purge_audit (entity_type, entity_id, deal_id, purged)
    VALUES ('participant', OLD.participant_id, OLD.deal_id, v_purged);
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_participants_before_delete_fixture_purge ON siton.participants;
CREATE TRIGGER trg_participants_before_delete_fixture_purge
  BEFORE DELETE ON siton.participants
  FOR EACH ROW EXECUTE FUNCTION siton.participants_before_delete_fixture_purge();

-- ── D10: seller_id frozen after publish ───────────────────────────────────
CREATE OR REPLACE FUNCTION siton.deals_seller_frozen_after_publish()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND NEW.seller_id IS DISTINCT FROM OLD.seller_id THEN
    RAISE EXCEPTION 'deals.seller_id is immutable after publish (deal=% % -> %)', OLD.deal_id, OLD.seller_id, NEW.seller_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_deals_seller_frozen_after_publish ON siton.deals;
CREATE TRIGGER trg_deals_seller_frozen_after_publish
  BEFORE UPDATE OF seller_id ON siton.deals
  FOR EACH ROW EXECUTE FUNCTION siton.deals_seller_frozen_after_publish();

-- ── D10: participant delivery fields frozen once a charge began ──────────
CREATE OR REPLACE FUNCTION siton.participants_delivery_frozen_after_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.money_state::text IN ('ChargeAttempt', 'ChargedSuccess', 'ChargeFailedRecovery', 'RecoveredCharge', 'Refunded')
     AND (NEW.delivery_option_id IS DISTINCT FROM OLD.delivery_option_id
       OR NEW.delivery_method_type IS DISTINCT FROM OLD.delivery_method_type
       OR NEW.delivery_method_label IS DISTINCT FROM OLD.delivery_method_label
       OR NEW.delivery_cost IS DISTINCT FROM OLD.delivery_cost) THEN
    RAISE EXCEPTION 'participants delivery fields are immutable once a charge began (participant=% money_state=%)', OLD.participant_id, OLD.money_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_participants_delivery_frozen_after_charge ON siton.participants;
CREATE TRIGGER trg_participants_delivery_frozen_after_charge
  BEFORE UPDATE OF delivery_option_id, delivery_method_type, delivery_method_label, delivery_cost ON siton.participants
  FOR EACH ROW EXECUTE FUNCTION siton.participants_delivery_frozen_after_charge();

-- ── D9: issued invoice documents are immutable ───────────────────────────
CREATE OR REPLACE FUNCTION siton.invoice_documents_issued_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_frozen boolean := OLD.status IN ('issued', 'reconciled') OR OLD.document_status IN ('issued', 'reconciled')
    OR OLD.issued_at IS NOT NULL OR OLD.provider_document_id IS NOT NULL;
BEGIN
  IF NOT v_frozen THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(pg_catalog.current_setting('siton.allow_test_actions', true), '') = '1'
       AND NOT EXISTS (
         WITH RECURSIVE runtime(oid) AS (
           SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname IN ('siton_web_runtime', 'siton_worker_runtime')
           UNION
           SELECT m.member FROM pg_catalog.pg_auth_members m JOIN runtime ON m.roleid = runtime.oid
         )
         SELECT 1 FROM runtime JOIN pg_catalog.pg_roles me ON me.oid = runtime.oid
         WHERE me.rolname IN (current_user::text, session_user::text) AND NOT me.rolsuper
       ) THEN
      INSERT INTO siton.fixture_purge_audit (entity_type, entity_id, deal_id, purged)
      VALUES ('invoice_document', OLD.document_id, OLD.deal_id,
              jsonb_build_object('document_key', OLD.document_key, 'status', OLD.status));
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice_document_issued_immutable: issued document % (%) cannot be deleted', OLD.document_id, OLD.document_key
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW.document_key, NEW.document_type, NEW.deal_id, NEW.participant_id, NEW.deal_title, NEW.qty,
      NEW.money_state_at_issue, NEW.gross_amount, NEW.siton_fee_amount, NEW.seller_net_amount,
      NEW.platform_fee_base_amount, NEW.platform_fee_vat_amount, NEW.platform_fee_total_amount,
      NEW.taxable_amount, NEW.document_amount, NEW.provider_code, NEW.provider_document_id, NEW.issued_at,
      NEW.idempotency_key, NEW.seller_id, NEW.seller_settlement_id, NEW.payout_batch_id,
      NEW.platform_fee_money_event_id, NEW.external_document_issued)
     IS DISTINCT FROM
     (OLD.document_key, OLD.document_type, OLD.deal_id, OLD.participant_id, OLD.deal_title, OLD.qty,
      OLD.money_state_at_issue, OLD.gross_amount, OLD.siton_fee_amount, OLD.seller_net_amount,
      OLD.platform_fee_base_amount, OLD.platform_fee_vat_amount, OLD.platform_fee_total_amount,
      OLD.taxable_amount, OLD.document_amount, OLD.provider_code, OLD.provider_document_id, OLD.issued_at,
      OLD.idempotency_key, OLD.seller_id, OLD.seller_settlement_id, OLD.payout_batch_id,
      OLD.platform_fee_money_event_id, OLD.external_document_issued) THEN
    RAISE EXCEPTION 'invoice_document_issued_immutable: identity/amount fields of issued document % (%) cannot change', OLD.document_id, OLD.document_key
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('pending', 'processing') OR NEW.document_status IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'invoice_document_issued_immutable: issued document % (%) cannot return to %', OLD.document_id, OLD.document_key, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_invoice_documents_issued_immutable ON siton.invoice_documents;
CREATE TRIGGER trg_invoice_documents_issued_immutable
  BEFORE UPDATE ON siton.invoice_documents
  FOR EACH ROW EXECUTE FUNCTION siton.invoice_documents_issued_immutable();
DROP TRIGGER IF EXISTS trg_invoice_documents_issued_no_delete ON siton.invoice_documents;
CREATE TRIGGER trg_invoice_documents_issued_no_delete
  BEFORE DELETE ON siton.invoice_documents
  FOR EACH ROW EXECUTE FUNCTION siton.invoice_documents_issued_immutable();

DO $issued_receipt_unique$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_documents_issued_receipt_per_participant
    ON siton.invoice_documents (participant_id, document_type)
    WHERE document_type IN ('charge_receipt', 'refund_receipt') AND status IN ('issued', 'reconciled');
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'black_sky_078: uq_invoice_documents_issued_receipt_per_participant NOT created (legacy duplicate issued receipts); review siton.invoice_documents';
END
$issued_receipt_unique$;

-- ── D9: payment_attempts / webhook_events identity immutability ──────────
CREATE OR REPLACE FUNCTION siton.payment_attempts_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.attempt_id, NEW.participant_id, NEW.deal_id, NEW.attempt_type, NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.attempt_id, OLD.participant_id, OLD.deal_id, OLD.attempt_type, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'payment_attempt_identity_immutable: % % identity columns cannot change', OLD.attempt_type, OLD.correlation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_payment_attempts_identity_immutable ON siton.payment_attempts;
CREATE TRIGGER trg_payment_attempts_identity_immutable
  BEFORE UPDATE ON siton.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION siton.payment_attempts_identity_immutable();

CREATE OR REPLACE FUNCTION siton.webhook_events_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.provider, NEW.event_id, NEW.received_at) IS DISTINCT FROM (OLD.provider, OLD.event_id, OLD.received_at)
     OR (OLD.deal_id IS NOT NULL AND NEW.deal_id IS DISTINCT FROM OLD.deal_id)
     OR (OLD.participant_id IS NOT NULL AND NEW.participant_id IS DISTINCT FROM OLD.participant_id)
     OR (OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
    RAISE EXCEPTION 'webhook_event_identity_immutable: % % identity/binding columns cannot change', OLD.provider, OLD.event_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_webhook_events_identity_immutable ON siton.webhook_events;
CREATE TRIGGER trg_webhook_events_identity_immutable
  BEFORE UPDATE ON siton.webhook_events
  FOR EACH ROW EXECUTE FUNCTION siton.webhook_events_identity_immutable();

-- ── D10 CHECKs + D12 validation of the older NOT VALID constraints ───────
ALTER TABLE siton.deals DROP CONSTRAINT IF EXISTS deals_price_per_unit_positive;
ALTER TABLE siton.deals ADD CONSTRAINT deals_price_per_unit_positive CHECK (price_per_unit > 0) NOT VALID;
ALTER TABLE siton.participants DROP CONSTRAINT IF EXISTS participants_delivery_cost_non_negative;
ALTER TABLE siton.participants ADD CONSTRAINT participants_delivery_cost_non_negative CHECK (delivery_cost >= 0) NOT VALID;

DO $validate$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('deals', 'deals_price_per_unit_positive'),
    ('participants', 'participants_delivery_cost_non_negative'),
    ('audit_log', 'audit_log_states_match_state_type_check'),
    ('outbox_events', 'outbox_processing_requires_fenced_lease'),
    ('outbox_dlq', 'outbox_dlq_aggregate_type_archive_check'),
    ('outbox_dlq', 'outbox_dlq_attempts_archive_check'),
    ('outbox_dlq', 'outbox_dlq_event_type_archive_check')
  ) AS t(tbl, con) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('siton.%I', r.tbl)) AND conname = r.con AND NOT convalidated
    ) THEN
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('ALTER TABLE siton.%I VALIDATE CONSTRAINT %I', r.tbl, r.con);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'black_sky_078: % left NOT VALID (legacy rows violate it; it is still enforced for new rows)', r.con;
    END;
  END LOOP;
END
$validate$;

COMMIT;
