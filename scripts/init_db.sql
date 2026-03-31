-- LEGACY BOOTSTRAP ONLY.
-- This file is not the canonical source of truth for the live runtime schema.
-- Canonical operational truth is defined by:
-- 1. src/migrations/*
-- 2. PROJECT_STATUS.md
-- 3. docs/BUYER_CAPACITY_RULE_OVERRIDE.md
-- 4. Stage 11 / Stage 12 runtime verification docs
-- In particular, product policy does NOT allow a uniqueness rule on (deal_id, buyer_id).

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- use public schema for canonical tables
SET search_path TO public;

DO $$
BEGIN
  PERFORM set_config('app.action_name','', true);
  PERFORM set_config('app.audit_written','0', true);
  PERFORM set_config('app.outbox_written','0', true);
  PERFORM set_config('app.in_atomic','false', true);
  PERFORM set_config('app.is_worker','false', true);
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deal_state') THEN
    CREATE TYPE deal_state AS ENUM (
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

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyer_state') THEN
    CREATE TYPE buyer_state AS ENUM (
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

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'money_state') THEN
    CREATE TYPE money_state AS ENUM (
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
END $$;

CREATE TABLE IF NOT EXISTS deals (
  deal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state deal_state NOT NULL DEFAULT 'Draft',

  title TEXT NOT NULL DEFAULT '',
  price_per_unit NUMERIC(12,2) NOT NULL,
  min_units INT NOT NULL CHECK (min_units > 0),
  max_units INT NOT NULL CHECK (max_units >= min_units),
  threshold_units INT NOT NULL CHECK (threshold_units > 0),
  deadline TIMESTAMPTZ NOT NULL,
  commission_rate NUMERIC(6,4) NOT NULL DEFAULT 0,

  published_at TIMESTAMPTZ NULL,
  completion_window_until TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participants (
  participant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,

  buyer_id TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0 AND qty <= 1000),

  buyer_state buyer_state NOT NULL DEFAULT 'NotJoined',
  money_state money_state NOT NULL DEFAULT 'NoFinancial',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
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

CREATE TABLE IF NOT EXISTS idempotency_log (
  idempotency_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('deal','participant')),
  entity_id UUID NOT NULL,
  action_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_code TEXT NOT NULL,
  response_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, action_name, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('deal','participant')),
  aggregate_id UUID NOT NULL,
  payload_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  attempt_count INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_dlq (
  LIKE outbox_events INCLUDING ALL
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL REFERENCES participants(participant_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('charge_start','recovery','refund','deadline_check','cancel_refund')),
  result_class TEXT NOT NULL CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_jsonb JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  deal_id UUID NULL REFERENCES deals(deal_id) ON DELETE RESTRICT,
  participant_id UUID NULL REFERENCES participants(participant_id) ON DELETE RESTRICT,
  CONSTRAINT webhook_events_pk PRIMARY KEY (provider, event_id),
  CONSTRAINT webhook_events_status_check CHECK (status IN ('pending','processed','ignored','failed'))
);

CREATE INDEX IF NOT EXISTS idx_participants_deal ON participants(deal_id);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_lookup ON payment_attempts(participant_id, deal_id, attempt_type, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_correlation ON payment_attempts(correlation_id);
CREATE INDEX IF NOT EXISTS idx_webhook_status_received ON webhook_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_provider_received ON webhook_events(provider, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deal_received ON webhook_events(deal_id, received_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_outbox_one_pending_per_aggregate_event'
  ) THEN
    EXECUTE '
      CREATE UNIQUE INDEX ux_outbox_one_pending_per_aggregate_event
      ON outbox_events (event_type, aggregate_id)
      WHERE status IN (''pending'',''processing'')
    ';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deals_updated_at ON deals;
CREATE TRIGGER trg_deals_updated_at
BEFORE UPDATE ON deals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_participants_updated_at ON participants;
CREATE TRIGGER trg_participants_updated_at
BEFORE UPDATE ON participants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_max_participants_per_deal()
RETURNS trigger AS $$
DECLARE
  cnt int;
BEGIN
  SELECT COUNT(*) INTO cnt FROM participants WHERE deal_id = NEW.deal_id;
  IF cnt >= 20000 THEN
    RAISE EXCEPTION 'Too many participants for deal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_max_participants_per_deal ON participants;
CREATE TRIGGER trg_max_participants_per_deal
BEFORE INSERT ON participants
FOR EACH ROW EXECUTE FUNCTION enforce_max_participants_per_deal();

CREATE OR REPLACE FUNCTION enforce_state_changes_only_in_atomic()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.in_atomic', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'P0 violation: direct state change forbidden outside atomic';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_only_atomic_deal_state ON deals;
CREATE TRIGGER trg_only_atomic_deal_state
BEFORE UPDATE OF state ON deals
FOR EACH ROW EXECUTE FUNCTION enforce_state_changes_only_in_atomic();

DROP TRIGGER IF EXISTS trg_only_atomic_participant_buyer_state ON participants;
CREATE TRIGGER trg_only_atomic_participant_buyer_state
BEFORE UPDATE OF buyer_state ON participants
FOR EACH ROW EXECUTE FUNCTION enforce_state_changes_only_in_atomic();

DROP TRIGGER IF EXISTS trg_only_atomic_participant_money_state ON participants;
CREATE TRIGGER trg_only_atomic_participant_money_state
BEFORE UPDATE OF money_state ON participants
FOR EACH ROW EXECUTE FUNCTION enforce_state_changes_only_in_atomic();

CREATE OR REPLACE FUNCTION enforce_worker_mode()
RETURNS trigger AS $$
BEGIN
    IF current_setting('app.in_atomic', true) IS DISTINCT FROM 'true'
      AND current_setting('app.is_worker', true) IS DISTINCT FROM 'true'
  THEN
    RAISE EXCEPTION 'Direct state update forbidden outside atomic or worker mode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_worker_mode_deals ON deals;
CREATE TRIGGER trg_worker_mode_deals
BEFORE UPDATE OF state ON deals
FOR EACH ROW EXECUTE FUNCTION enforce_worker_mode();

DROP TRIGGER IF EXISTS trg_worker_mode_participants_buyer ON participants;
CREATE TRIGGER trg_worker_mode_participants_buyer
BEFORE UPDATE OF buyer_state ON participants
FOR EACH ROW EXECUTE FUNCTION enforce_worker_mode();

DROP TRIGGER IF EXISTS trg_worker_mode_participants_money ON participants;
CREATE TRIGGER trg_worker_mode_participants_money
BEFORE UPDATE OF money_state ON participants
FOR EACH ROW EXECUTE FUNCTION enforce_worker_mode();

CREATE OR REPLACE FUNCTION enforce_audit_flag()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.audit_written', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'P0 violation: state change without audit in same tx';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_audit_deal ON deals;
CREATE TRIGGER trg_enforce_audit_deal
BEFORE UPDATE OF state ON deals
FOR EACH ROW EXECUTE FUNCTION enforce_audit_flag();

DROP TRIGGER IF EXISTS trg_enforce_audit_participant_buyer ON participants;
CREATE TRIGGER trg_enforce_audit_participant_buyer
BEFORE UPDATE OF buyer_state ON participants
FOR EACH ROW EXECUTE FUNCTION enforce_audit_flag();

DROP TRIGGER IF EXISTS trg_enforce_audit_participant_money ON participants;
CREATE TRIGGER trg_enforce_audit_participant_money
BEFORE UPDATE OF money_state ON participants
FOR EACH ROW EXECUTE FUNCTION enforce_audit_flag();

CREATE OR REPLACE FUNCTION enforce_outbox_for_critical_actions()
RETURNS trigger AS $$
DECLARE
  action text := current_setting('app.action_name', true);
BEGIN
  IF action = '' THEN
    RETURN NEW;
  END IF;

  IF action = 'charging.start'
     OR action LIKE 'charging.recovery%'
     OR action LIKE 'charging.finalize%'
     OR action LIKE 'refund.%'
     OR action = 'deal.deadline_check'
     OR action = 'deal.cancel'
  THEN
    IF current_setting('app.outbox_written', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'P0 violation: critical action % without outbox insert in same tx', action;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_outbox_deal ON deals;
CREATE TRIGGER trg_enforce_outbox_deal
BEFORE UPDATE OF state ON deals
FOR EACH ROW EXECUTE FUNCTION enforce_outbox_for_critical_actions();

CREATE OR REPLACE FUNCTION deals_before_update_enforce()
RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF NEW.price_per_unit IS DISTINCT FROM OLD.price_per_unit OR
       NEW.min_units IS DISTINCT FROM OLD.min_units OR
       NEW.max_units IS DISTINCT FROM OLD.max_units OR
       NEW.deadline IS DISTINCT FROM OLD.deadline OR
       NEW.commission_rate IS DISTINCT FROM OLD.commission_rate OR
       NEW.threshold_units IS DISTINCT FROM OLD.threshold_units THEN
      RAISE EXCEPTION 'P0 violation: critical fields immutable after publish';
    END IF;
  END IF;

  IF OLD.completion_window_until IS NOT NULL AND NEW.completion_window_until IS DISTINCT FROM OLD.completion_window_until THEN
    RAISE EXCEPTION 'P0 violation: completion_window_until immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deals_before_update_enforce ON deals;
CREATE TRIGGER trg_deals_before_update_enforce
BEFORE UPDATE ON deals
FOR EACH ROW EXECUTE FUNCTION deals_before_update_enforce();

CREATE OR REPLACE FUNCTION enforce_completion_window_rules()
RETURNS trigger AS $$
DECLARE
  action text := current_setting('app.action_name', true);
BEGIN
  IF OLD.state = 'CompletionWindow' AND NEW.state NOT IN ('Completed','Failed') THEN
    RAISE EXCEPTION 'P0 violation: from CompletionWindow only to Completed or Failed';
  END IF;

  IF action = 'charging.start' AND OLD.completion_window_until IS NOT NULL AND now() < OLD.completion_window_until THEN
    RAISE EXCEPTION 'P0 violation: charging.start forbidden while completion window active';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_window_rules ON deals;
CREATE TRIGGER trg_enforce_window_rules
BEFORE UPDATE ON deals
FOR EACH ROW EXECUTE FUNCTION enforce_completion_window_rules();

CREATE OR REPLACE FUNCTION enforce_retry_storm()
RETURNS trigger AS $$
DECLARE
  cnt int;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM payment_attempts
  WHERE participant_id = NEW.participant_id
    AND deal_id = NEW.deal_id
    AND created_at > now() - interval '30 minutes'
    AND attempt_type = NEW.attempt_type;

  IF cnt >= 3 THEN
    RAISE EXCEPTION 'Retry storm: max 3 attempts per 30 min for %', NEW.attempt_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_retry_storm ON payment_attempts;
CREATE TRIGGER trg_enforce_retry_storm
BEFORE INSERT ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_retry_storm();

COMMIT;
