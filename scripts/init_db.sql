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
  PERFORM set_config('siton.action_name','', true);
  PERFORM set_config('siton.audit_written','0', true);
  PERFORM set_config('siton.outbox_written','0', true);
  PERFORM set_config('siton.in_atomic','false', true);
  PERFORM set_config('siton.is_worker','false', true);
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
  seller_id TEXT NULL,
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
  delivery_option_id UUID NULL,
  delivery_method_type TEXT NULL,
  delivery_method_label TEXT NULL,
  delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_delivery_options (
  option_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  option_type TEXT NOT NULL CHECK (option_type IN ('delivery','pickup','distribution_point')),
  label TEXT NOT NULL,
  cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS seller_accounts (
  seller_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  login_email TEXT NULL,
  auth_secret_hash TEXT NULL,
  auth_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auth_secret_updated_at TIMESTAMPTZ NULL,
  last_login_at TIMESTAMPTZ NULL,
  last_login_ip TEXT NOT NULL DEFAULT '',
  last_login_user_agent TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (verification_status IN ('pending','approved','rejected')),
  settlement_status TEXT NOT NULL DEFAULT 'active'
    CHECK (settlement_status IN ('active','review','hold')),
  payout_method TEXT NOT NULL DEFAULT 'bank_transfer',
  payout_details_masked TEXT NOT NULL DEFAULT '***1234',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_accounts_login_email
  ON seller_accounts (lower(login_email))
  WHERE login_email IS NOT NULL AND btrim(login_email) <> '';

CREATE TABLE IF NOT EXISTS seller_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES seller_accounts(seller_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_ip TEXT NOT NULL DEFAULT '',
  created_user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_seller_sessions_active
  ON seller_sessions (seller_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS affiliate_accounts (
  affiliate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected')),
  payout_status TEXT NOT NULL DEFAULT 'pending_profile'
    CHECK (payout_status IN ('pending_profile','pending_review','approved','paid','hold')),
  payout_method TEXT NOT NULL DEFAULT 'bank_transfer',
  payout_details_masked TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS affiliate_attributions (
  attribution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES affiliate_accounts(affiliate_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  participant_id UUID NOT NULL UNIQUE REFERENCES participants(participant_id) ON DELETE CASCADE,
  share_code TEXT NOT NULL,
  commission_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payout_status IN ('pending','approved','paid','void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_records (
  delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  participant_id UUID NOT NULL UNIQUE REFERENCES participants(participant_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ready_to_fulfill'
    CHECK (status IN ('ready_to_fulfill','shipped','delivered','issue')),
  tracking_number TEXT NULL,
  issue_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('deal','participant','affiliate','seller','system')),
  scope_key TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_participants_deal ON participants(deal_id);
CREATE INDEX IF NOT EXISTS idx_participants_delivery_option ON participants(delivery_option_id);
CREATE INDEX IF NOT EXISTS idx_deal_delivery_options_deal ON deal_delivery_options(deal_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_deals_seller_created ON deals(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_lookup ON payment_attempts(participant_id, deal_id, attempt_type, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_correlation ON payment_attempts(correlation_id);
CREATE INDEX IF NOT EXISTS idx_webhook_status_received ON webhook_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_provider_received ON webhook_events(provider, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deal_received ON webhook_events(deal_id, received_at);
CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_deal ON affiliate_attributions(deal_id, payout_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_affiliate ON affiliate_attributions(affiliate_id, payout_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_records_deal ON delivery_records(deal_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, created_at DESC);

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
  IF current_setting('siton.audit_written', true) IS DISTINCT FROM '1' THEN
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
  action text := current_setting('siton.action_name', true);
BEGIN
  IF action = '' THEN
    RETURN NEW;
  END IF;

  IF action IN (
       'deal.publish',
       'charging.start',
       'charging.to_completion_window',
       'charging.finalize_failed',
       'deal.cancel'
     )
  THEN
    IF current_setting('siton.outbox_written', true) IS DISTINCT FROM '1' THEN
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
  action text := current_setting('siton.action_name', true);
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

-- ─── Notifications ──────────────────────────────────────────────────────────
-- Delivery tracking table. event_key is the idempotency key:
--   "{notification_event_type}:{participant_id_or_deal_id}:{channel}"
CREATE TABLE IF NOT EXISTS notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL,
  notification_event_type TEXT NOT NULL CHECK (notification_event_type IN (
    'join_authorized','charge_succeeded','charge_failed_recovery',
    'deal_completed','deal_failed','refund_issued','deal_cancelled'
  )),
  channel TEXT NOT NULL CHECK (channel IN ('sms','email','log')),
  recipient TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_params JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  provider_code TEXT NOT NULL DEFAULT 'log-only',
  provider_message_id TEXT NULL,
  last_error TEXT NULL,
  sent_at TIMESTAMPTZ NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_notifications_event_key UNIQUE (event_key)
);

CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON notifications (status, available_at)
  WHERE status = 'pending';

COMMIT;
