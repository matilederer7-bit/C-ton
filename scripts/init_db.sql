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
  -- Siton platform fee is the system constant SITON_PLATFORM_FEE_RATE = 0.08 (see src/platform_fee_money.ts).
  -- It is not stored per-deal. Any legacy `commission_rate` column is dropped by migration 022.

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

  -- Delivery snapshot: captured at join time for seller shipping export
  buyer_name TEXT NULL,
  buyer_phone TEXT NULL,
  buyer_email TEXT NULL,
  delivery_address TEXT NULL,
  delivery_city TEXT NULL,
  delivery_notes TEXT NULL,

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

CREATE TABLE IF NOT EXISTS deal_images (
  image_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  public_url TEXT NULL,
  original_filename TEXT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes INT NOT NULL CHECK (size_bytes > 0),
  width INT NULL,
  height INT NULL,
  sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary BOOLEAN NOT NULL DEFAULT false,
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
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('deal','participant','seller_payout_batch','invoice_document')),
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

CREATE TABLE IF NOT EXISTS platform_fee_money_events (
  money_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL REFERENCES participants(participant_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('charge_captured','recovery_captured','refund_issued')),
  logical_entry_type TEXT NOT NULL
    CHECK (logical_entry_type IN ('charge','refund_adjustment')),
  provider_code TEXT NOT NULL,
  provider_event_id TEXT NULL,
  provider_reference TEXT NULL,
  correlation_id TEXT NULL,
  source_money_state TEXT NOT NULL,
  settlement_status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (settlement_status IN ('recorded','backfilled_from_refund')),
  payout_readiness_status TEXT NOT NULL
    CHECK (payout_readiness_status IN ('ready_for_settlement','reversed_after_refund')),
  gross_amount NUMERIC(12,2) NOT NULL,
  vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  fee_base_amount NUMERIC(12,2) NOT NULL,
  platform_fee_rate NUMERIC(6,4) NOT NULL DEFAULT 0.08,
  platform_fee_vat_rate NUMERIC(6,4) NOT NULL DEFAULT 0.18,
  platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_amount NUMERIC(12,2) NOT NULL,
  seller_net_amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seller_settlements (
  seller_settlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES seller_accounts(seller_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  payout_batch_id UUID NULL,
  payout_status TEXT NOT NULL CHECK (payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  calculation_version TEXT NOT NULL DEFAULT 'v1',
  gross_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserve_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_payable NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  failed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  returned_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  blocked_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  delayed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  mismatch_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  source_money_event_count INT NOT NULL DEFAULT 0,
  has_open_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  has_open_blocking_reconciliation_case BOOLEAN NOT NULL DEFAULT FALSE,
  final_truth_basis TEXT NOT NULL DEFAULT '',
  blocker_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  correlation_id TEXT NULL,
  idempotency_key TEXT NOT NULL,
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS seller_payout_batches (
  payout_batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES seller_accounts(seller_id) ON DELETE CASCADE,
  trigger_deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  payout_status TEXT NOT NULL CHECK (payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  provider_code TEXT NOT NULL,
  provider_batch_reference TEXT NULL,
  correlation_id TEXT NULL,
  idempotency_key TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ILS',
  settlement_count INT NOT NULL DEFAULT 0,
  item_count INT NOT NULL DEFAULT 0,
  gross_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserve_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_payable NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  failed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  returned_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  blocked_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  delayed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  blocker_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  external_transfer_executed BOOLEAN NOT NULL DEFAULT FALSE,
  created_payout_at TIMESTAMPTZ NULL,
  paid_at TIMESTAMPTZ NULL,
  reconciled_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS seller_payout_batch_items (
  payout_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_batch_id UUID NOT NULL REFERENCES seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
  seller_settlement_id UUID NULL REFERENCES seller_settlements(seller_settlement_id) ON DELETE SET NULL,
  participant_id UUID NOT NULL REFERENCES participants(participant_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL REFERENCES seller_accounts(seller_id) ON DELETE CASCADE,
  payout_status TEXT NOT NULL CHECK (payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  correlation_id TEXT NULL,
  idempotency_key TEXT NOT NULL,
  gross_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserve_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_payable NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  source_money_event_count INT NOT NULL DEFAULT 0,
  buyer_state_at_batch TEXT NOT NULL,
  money_state_at_batch TEXT NOT NULL,
  provider_item_reference TEXT NULL,
  external_transfer_executed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (participant_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS seller_payout_attempts (
  payout_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_batch_id UUID NOT NULL REFERENCES seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
  payout_item_id UUID NULL REFERENCES seller_payout_batch_items(payout_item_id) ON DELETE CASCADE,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('prepare','create_payout','get_payout_status','cancel_payout','reconcile_payout')),
  result_class TEXT NOT NULL CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
  payout_status TEXT NULL CHECK (payout_status IS NULL OR payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  correlation_id TEXT NOT NULL,
  provider_reference TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payout_batch_id, payout_item_id, attempt_type, correlation_id)
);

CREATE TABLE IF NOT EXISTS seller_payout_reconciliation_cases (
  payout_reconciliation_case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_settlement_id UUID NULL REFERENCES seller_settlements(seller_settlement_id) ON DELETE CASCADE,
  payout_batch_id UUID NULL REFERENCES seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL REFERENCES seller_accounts(seller_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  case_status TEXT NOT NULL CHECK (case_status IN ('open','resolved')),
  case_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  blocking_payout BOOLEAN NOT NULL DEFAULT TRUE,
  expected_payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  observed_payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_item_count INT NOT NULL DEFAULT 0,
  observed_item_count INT NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ NULL,
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
  -- Business profile fields (migration 028): shown publicly on deal pages
  business_name        TEXT NULL,
  contact_name         TEXT NULL,
  support_phone        TEXT NULL,
  support_email        TEXT NULL,
  business_description TEXT NULL,
  business_identifier  TEXT NULL,
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

-- Distributors are attribution-only: no commission, no payout, no settlement.
CREATE TABLE IF NOT EXISTS affiliate_accounts (
  affiliate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected')),
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
CREATE INDEX IF NOT EXISTS idx_deal_images_deal_order ON deal_images(deal_id, sort_order, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_images_one_primary ON deal_images(deal_id) WHERE is_primary = true;
CREATE INDEX IF NOT EXISTS idx_deals_seller_created ON deals(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_lookup ON payment_attempts(participant_id, deal_id, attempt_type, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_correlation ON payment_attempts(correlation_id);
CREATE INDEX IF NOT EXISTS idx_platform_fee_money_deal_created ON platform_fee_money_events(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_settlements_seller_created ON seller_settlements(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_settlements_status_created ON seller_settlements(payout_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_seller_created ON seller_payout_batches(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_status_created ON seller_payout_batches(payout_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_payout_items_batch_created ON seller_payout_batch_items(payout_batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_payout_attempts_batch_created ON seller_payout_attempts(payout_batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_payout_reconciliation_cases_open ON seller_payout_reconciliation_cases(seller_id, deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_status_received ON webhook_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_provider_received ON webhook_events(provider, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deal_received ON webhook_events(deal_id, received_at);

CREATE TABLE IF NOT EXISTS payment_webhook_security_events (
  security_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NULL,
  failure_reason TEXT NOT NULL,
  remote_hint TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_security_events_created
  ON payment_webhook_security_events(created_at DESC);

CREATE TABLE IF NOT EXISTS invoice_webhook_events (
  invoice_webhook_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  provider_document_id TEXT NULL,
  document_id UUID NULL,
  document_key TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','queued','ignored','failed')),
  correlation_id TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS invoice_webhook_security_events (
  security_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NULL,
  failure_reason TEXT NOT NULL,
  remote_hint TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_webhook_events_document
  ON invoice_webhook_events(document_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_webhook_security_events_created
  ON invoice_webhook_security_events(created_at DESC);

CREATE TABLE IF NOT EXISTS buyer_payment_methods (
  buyer_payment_method_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  provider_payment_method_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','invalid','expired','revoked')),
  last_authorized_at TIMESTAMPTZ NULL,
  last_failed_at TIMESTAMPTZ NULL,
  correlation_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_code, provider_payment_method_id)
);

CREATE INDEX IF NOT EXISTS idx_buyer_payment_methods_buyer_created
  ON buyer_payment_methods(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_deal ON affiliate_attributions(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_affiliate ON affiliate_attributions(affiliate_id, created_at DESC);
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_platform_fee_money_charge_once'
  ) THEN
    EXECUTE '
      CREATE UNIQUE INDEX ux_platform_fee_money_charge_once
      ON platform_fee_money_events (participant_id)
      WHERE logical_entry_type = ''charge''
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_platform_fee_money_refund_once'
  ) THEN
    EXECUTE '
      CREATE UNIQUE INDEX ux_platform_fee_money_refund_once
      ON platform_fee_money_events (participant_id)
      WHERE logical_entry_type = ''refund_adjustment''
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_platform_fee_money_provider_event'
  ) THEN
    EXECUTE '
      CREATE UNIQUE INDEX ux_platform_fee_money_provider_event
      ON platform_fee_money_events (provider_code, provider_event_id)
      WHERE provider_event_id IS NOT NULL
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

-- ─── Notification Rail ──────────────────────────────────────────────────────
-- Provider-ready notification events. Messages are side effects only and never
-- own deal, participant, or money state.
CREATE TABLE IF NOT EXISTS notification_events (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'buyer_joined_authorized','buyer_deal_target_reached','buyer_deal_completed','buyer_deal_failed',
    'buyer_recovery_required','buyer_payment_recovered','seller_deal_published','seller_target_reached',
    'seller_deal_completed','seller_deal_failed','seller_excel_ready'
  )),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('buyer','seller','admin')),
  recipient_ref TEXT NULL,
  deal_id UUID NULL,
  participant_id UUID NULL,
  seller_id TEXT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email','whatsapp_link','internal')),
  template_key TEXT NOT NULL CHECK (template_key IN (
    'buyer_joined_authorized_he','buyer_deal_target_reached_he','buyer_deal_completed_he','buyer_deal_failed_he',
    'buyer_recovery_required_he','buyer_payment_recovered_he','seller_deal_published_he','seller_target_reached_he',
    'seller_deal_completed_he','seller_deal_failed_he','seller_excel_ready_he'
  )),
  locale TEXT NOT NULL DEFAULT 'he-IL',
  payload_jsonb JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled','skipped')),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for TIMESTAMPTZ NULL,
  sent_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  CONSTRAINT ux_notification_events_idempotency_key UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS notification_attempts (
  attempt_id BIGSERIAL PRIMARY KEY,
  notification_id UUID NOT NULL REFERENCES notification_events(notification_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('success','temporary_fail','permanent_fail','skipped')),
  provider_message_id TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_events_status_schedule
  ON notification_events (status, scheduled_for, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_deal
  ON notification_events (deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_participant
  ON notification_events (participant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_seller
  ON notification_events (seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_attempts_notification
  ON notification_attempts (notification_id, created_at);

-- Legacy notification table retained for older local databases/tests. Runtime
-- writes use notification_events / notification_attempts.
CREATE TABLE IF NOT EXISTS notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL,
  notification_event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_params JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  provider_code TEXT NOT NULL DEFAULT 'log',
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

-- ─── Invoice Documents ───────────────────────────────────────────────────────
-- Document issuance tracking. document_key is the idempotency key:
--   "charge_receipt:{participant_id}" or "refund_receipt:{participant_id}"
CREATE TABLE IF NOT EXISTS invoice_documents (
  document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_key TEXT NOT NULL,
  idempotency_key TEXT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('charge_receipt','refund_receipt','seller_settlement_invoice','platform_fee_invoice','credit_note')),
  document_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (document_status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped')),
  deal_id UUID NOT NULL,
  participant_id UUID NULL,
  seller_id TEXT NULL,
  seller_settlement_id UUID NULL,
  payout_batch_id UUID NULL,
  platform_fee_money_event_id UUID NULL,
  deal_title TEXT NOT NULL DEFAULT '',
  qty INT NOT NULL DEFAULT 1,
  money_state_at_issue TEXT NOT NULL DEFAULT '',
  gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  siton_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  document_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped')),
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  provider_code TEXT NOT NULL DEFAULT 'internal-invoice-ledger',
  provider_document_id TEXT NULL,
  correlation_id TEXT NULL,
  result_class TEXT NULL,
  external_document_issued BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT NULL,
  issued_at TIMESTAMPTZ NULL,
  reconciled_at TIMESTAMPTZ NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_invoice_documents_key UNIQUE (document_key)
);

CREATE TABLE IF NOT EXISTS invoice_document_attempts (
  invoice_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES invoice_documents(document_id) ON DELETE CASCADE,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('prepare','create_document','get_document_status','cancel_document','reconcile_document')),
  result_class TEXT NOT NULL CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
  document_status TEXT NULL CHECK (document_status IS NULL OR document_status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped')),
  correlation_id TEXT NOT NULL,
  provider_document_id TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, attempt_type, correlation_id)
);

CREATE TABLE IF NOT EXISTS invoice_reconciliation_cases (
  invoice_reconciliation_case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES invoice_documents(document_id) ON DELETE CASCADE,
  case_status TEXT NOT NULL DEFAULT 'open' CHECK (case_status IN ('open','resolved')),
  case_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  blocking_invoice BOOLEAN NOT NULL DEFAULT TRUE,
  expected_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  observed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_status TEXT NOT NULL DEFAULT '',
  observed_status TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}',
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_documents_pending
  ON invoice_documents (status, available_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_invoice_documents_deal_created ON invoice_documents(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_documents_participant_created ON invoice_documents(participant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_document_attempts_document_created ON invoice_document_attempts(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_reconciliation_cases_open ON invoice_reconciliation_cases(document_id, created_at DESC);

COMMIT;
