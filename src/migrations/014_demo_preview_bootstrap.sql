BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS siton;
SET search_path TO siton, public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'deal_state' AND n.nspname = 'siton'
  ) THEN
    CREATE TYPE siton.deal_state AS ENUM (
      'Draft',
      'PendingTarget',
      'TargetReached',
      'ClosedForJoining',
      'ReadyForCharging',
      'Charging',
      'CompletionWindow',
      'Completed',
      'Failed',
      'Cancelled'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'buyer_state' AND n.nspname = 'siton'
  ) THEN
    CREATE TYPE siton.buyer_state AS ENUM (
      'NotJoined',
      'JoinedAuthorized',
      'LockedIn',
      'ChargingAttempt',
      'ChargedSuccess',
      'ChargeFailedCompletion',
      'Recovered',
      'Dropped',
      'DealCompleted',
      'DealFailed'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'money_state' AND n.nspname = 'siton'
  ) THEN
    CREATE TYPE siton.money_state AS ENUM (
      'NoFinancial',
      'AuthHeld',
      'AuthLocked',
      'ChargeAttempt',
      'ChargedSuccess',
      'ChargeFailedRecovery',
      'RecoveredCharge',
      'AuthReleased',
      'Refunded'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS siton.deals (
  deal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NULL,
  state siton.deal_state NOT NULL DEFAULT 'Draft',
  title TEXT NOT NULL DEFAULT '',
  price_per_unit NUMERIC(12,2) NOT NULL,
  min_units INT NOT NULL CHECK (min_units > 0),
  max_units INT NOT NULL CHECK (max_units >= min_units),
  threshold_units INT NOT NULL CHECK (threshold_units > 0),
  deadline TIMESTAMPTZ NOT NULL,
  -- Siton platform fee is the system constant SITON_PLATFORM_FEE_RATE = 0.08 (see src/platform_fee_money.ts).
  -- Not stored per-deal. Any legacy `commission_rate` column is dropped by migration 022.
  published_at TIMESTAMPTZ NULL,
  completion_window_until TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.participants (
  participant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  buyer_id TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0 AND qty <= 1000),
  buyer_state siton.buyer_state NOT NULL DEFAULT 'NotJoined',
  money_state siton.money_state NOT NULL DEFAULT 'NoFinancial',
  delivery_option_id UUID NULL,
  delivery_method_type TEXT NULL,
  delivery_method_label TEXT NULL,
  delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.deal_delivery_options (
  option_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  option_type TEXT NOT NULL CHECK (option_type IN ('delivery','pickup','distribution_point')),
  label TEXT NOT NULL,
  cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.audit_log (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('deal','participant')),
  entity_id UUID NOT NULL,
  deal_id UUID NULL,
  state_type TEXT NOT NULL CHECK (state_type IN ('deal_state','buyer_state','money_state')),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  action_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.idempotency_log (
  idempotency_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('deal','participant')),
  entity_id UUID NOT NULL,
  action_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NULL,
  response_code TEXT NOT NULL CHECK (response_code IN ('OK','ERROR')),
  response_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, action_name, idempotency_key)
);

CREATE TABLE IF NOT EXISTS siton.outbox_events (
  event_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('deal','participant')),
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 10 CHECK (max_attempts >= 1 AND max_attempts <= 50),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ NULL,
  processing_started_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_event_type_check CHECK (
    event_type IN (
      'charge_deal',
      'recovery_deal',
      'finalize_deal',
      'refund_issue',
      'deadline_check',
      'cancel_refund'
    )
  ),
  CONSTRAINT outbox_events_attempt_count_check CHECK (attempt_count <= max_attempts)
);

CREATE TABLE IF NOT EXISTS siton.outbox_dlq (
  LIKE siton.outbox_events INCLUDING ALL
);

CREATE TABLE IF NOT EXISTS siton.payment_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('charge_start','recovery','refund','deadline_check','cancel_refund')),
  result_class TEXT NOT NULL CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_unique_logical_attempt
ON siton.payment_attempts(participant_id, deal_id, attempt_type, correlation_id);

CREATE INDEX IF NOT EXISTS idx_participants_deal ON siton.participants(deal_id);
CREATE INDEX IF NOT EXISTS idx_participants_deal_locked_buyer ON siton.participants(deal_id, locked_at, buyer_state);
CREATE INDEX IF NOT EXISTS idx_participants_deal_buyer_money ON siton.participants(deal_id, buyer_state, money_state);
CREATE INDEX IF NOT EXISTS idx_participants_delivery_option ON siton.participants(delivery_option_id);
CREATE INDEX IF NOT EXISTS idx_deal_delivery_options_deal ON siton.deal_delivery_options(deal_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_deals_state_published_at ON siton.deals(state, published_at);
CREATE INDEX IF NOT EXISTS idx_deals_state_completion_window_until ON siton.deals(state, completion_window_until);
CREATE INDEX IF NOT EXISTS idx_deals_seller_created ON siton.deals(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON siton.outbox_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_lookup ON siton.payment_attempts(participant_id, deal_id, attempt_type, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_correlation ON siton.payment_attempts(correlation_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname='siton' AND indexname='ux_outbox_one_pending_per_aggregate_event'
  ) THEN
    EXECUTE '
      CREATE UNIQUE INDEX ux_outbox_one_pending_per_aggregate_event
      ON siton.outbox_events (event_type, aggregate_id)
      WHERE status IN (''pending'',''processing'')
    ';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION siton.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_deals_updated_at ON siton.deals;
CREATE TRIGGER trg_deals_updated_at
BEFORE UPDATE ON siton.deals
FOR EACH ROW EXECUTE FUNCTION siton.set_updated_at();

DROP TRIGGER IF EXISTS trg_participants_updated_at ON siton.participants;
CREATE TRIGGER trg_participants_updated_at
BEFORE UPDATE ON siton.participants
FOR EACH ROW EXECUTE FUNCTION siton.set_updated_at();

CREATE OR REPLACE FUNCTION siton.flag_is_set(flag_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT COALESCE(current_setting(flag_name, true), '') = '1'
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_action_name(action_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT COALESCE(action_name, '') LIKE 'test.%'
    OR COALESCE(action_name, '') IN (
      'participant.join_authorize',
      'deal.publish',
      'deal.target_reached',
      'deal.close_joining',
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
      'refund.issue'
    )
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_deal_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'Draft' AND v_to IN ('PendingTarget', 'Cancelled') THEN true
    WHEN v_from = 'PendingTarget' AND v_to IN ('TargetReached', 'Failed') THEN true
    WHEN v_from = 'TargetReached' AND v_to = 'ClosedForJoining' THEN true
    WHEN v_from = 'ClosedForJoining' AND v_to = 'ReadyForCharging' THEN true
    WHEN v_from = 'ReadyForCharging' AND v_to = 'Charging' THEN true
    WHEN v_from = 'Charging' AND v_to = 'CompletionWindow' THEN true
    WHEN v_from = 'CompletionWindow' AND v_to IN ('Completed', 'Failed') THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_buyer_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'NotJoined' AND v_to IN ('JoinedAuthorized', 'DealFailed') THEN true
    WHEN v_from = 'JoinedAuthorized' AND v_to IN ('LockedIn', 'DealFailed') THEN true
    WHEN v_from = 'LockedIn' AND v_to IN ('ChargingAttempt', 'DealFailed') THEN true
    WHEN v_from = 'ChargingAttempt' AND v_to IN ('ChargedSuccess', 'ChargeFailedCompletion', 'DealFailed') THEN true
    WHEN v_from = 'ChargeFailedCompletion' AND v_to IN ('Recovered', 'Dropped', 'DealFailed') THEN true
    WHEN v_from = 'ChargedSuccess' AND v_to IN ('DealCompleted', 'DealFailed') THEN true
    WHEN v_from = 'Recovered' AND v_to IN ('DealCompleted', 'DealFailed') THEN true
    WHEN v_from = 'Dropped' AND v_to = 'DealFailed' THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_money_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'NoFinancial' AND v_to = 'AuthHeld' THEN true
    WHEN v_from = 'AuthHeld' AND v_to = 'AuthLocked' THEN true
    WHEN v_from = 'AuthLocked' AND v_to = 'ChargeAttempt' THEN true
    WHEN v_from = 'ChargeAttempt' AND v_to IN ('ChargedSuccess', 'ChargeFailedRecovery') THEN true
    WHEN v_from = 'ChargeFailedRecovery' AND v_to IN ('RecoveredCharge', 'AuthReleased') THEN true
    WHEN v_from IN ('ChargedSuccess', 'RecoveredCharge') AND v_to = 'Refunded' THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_transition(v_state_type text, v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_state_type = 'deal_state' THEN siton.is_valid_deal_transition(v_from, v_to)
    WHEN v_state_type = 'buyer_state' THEN siton.is_valid_buyer_transition(v_from, v_to)
    WHEN v_state_type = 'money_state' THEN siton.is_valid_money_transition(v_from, v_to)
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.require_action_name()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v text;
BEGIN
  v := current_setting('siton.action_name', true);
  IF v IS NULL OR btrim(v) = '' THEN
    RAISE EXCEPTION 'missing siton.action_name in current transaction';
  END IF;
  IF NOT siton.is_valid_action_name(v) THEN
    RAISE EXCEPTION 'invalid siton.action_name in current transaction: %', v;
  END IF;
  RETURN v;
END
$$;

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
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_deals_before_update_enforce ON siton.deals;
CREATE TRIGGER trg_deals_before_update_enforce
BEFORE UPDATE ON siton.deals
FOR EACH ROW
EXECUTE FUNCTION siton.deals_before_update_enforce();

DROP TRIGGER IF EXISTS trg_participants_before_update_enforce ON siton.participants;
CREATE TRIGGER trg_participants_before_update_enforce
BEFORE UPDATE ON siton.participants
FOR EACH ROW
EXECUTE FUNCTION siton.participants_before_update_enforce();

CREATE OR REPLACE FUNCTION siton.audit_log_before_insert_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entity_type = 'deal' AND NEW.state_type <> 'deal_state' THEN
    RAISE EXCEPTION 'audit_log entity_type/state_type mismatch for deal';
  END IF;

  IF NEW.entity_type = 'participant' AND NEW.state_type NOT IN ('buyer_state', 'money_state') THEN
    RAISE EXCEPTION 'audit_log entity_type/state_type mismatch for participant';
  END IF;

  IF btrim(COALESCE(NEW.action_name, '')) = '' OR NOT siton.is_valid_action_name(NEW.action_name) THEN
    RAISE EXCEPTION 'audit_log action_name is invalid: %', NEW.action_name;
  END IF;

  IF NEW.from_state = NEW.to_state THEN
    RAISE EXCEPTION 'audit_log from_state must differ from to_state';
  END IF;

  IF NOT siton.is_valid_transition(NEW.state_type, NEW.from_state, NEW.to_state) THEN
    RAISE EXCEPTION 'audit_log illegal transition state_type=% from=% to=%', NEW.state_type, NEW.from_state, NEW.to_state;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION siton.audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$;

DROP TRIGGER IF EXISTS trg_audit_log_before_insert_enforce ON siton.audit_log;
CREATE TRIGGER trg_audit_log_before_insert_enforce
BEFORE INSERT ON siton.audit_log
FOR EACH ROW
EXECUTE FUNCTION siton.audit_log_before_insert_enforce();

DROP TRIGGER IF EXISTS trg_audit_log_append_only_update ON siton.audit_log;
CREATE TRIGGER trg_audit_log_append_only_update
BEFORE UPDATE ON siton.audit_log
FOR EACH ROW
EXECUTE FUNCTION siton.audit_log_append_only();

DROP TRIGGER IF EXISTS trg_audit_log_append_only_delete ON siton.audit_log;
CREATE TRIGGER trg_audit_log_append_only_delete
BEFORE DELETE ON siton.audit_log
FOR EACH ROW
EXECUTE FUNCTION siton.audit_log_append_only();

CREATE OR REPLACE FUNCTION siton.deals_outbox_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
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
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_deals_outbox_enforce ON siton.deals;
CREATE TRIGGER trg_deals_outbox_enforce
BEFORE UPDATE ON siton.deals
FOR EACH ROW
EXECUTE FUNCTION siton.deals_outbox_enforce();

COMMIT;
