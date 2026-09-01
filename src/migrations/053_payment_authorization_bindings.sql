-- 053 — R9A payment foundation: server-authoritative payment authorization
-- bindings, legal release transitions, and the Worker-owned payment
-- reconciliation/release outbox rail.
--
-- Provider-neutral by design: no Grow (or any provider) semantics are encoded
-- here. The binding is Siton's durable financial-authority record for a
-- payment authorization; the browser never becomes financial authority.

BEGIN;

SET search_path TO siton, public;

-- ---------------------------------------------------------------------------
-- 1) Canonical payment authorization binding.
--
-- One row per server-created provider authorization intent. Join may move a
-- participant to AuthHeld only by consuming a matching row whose status is
-- canonically acceptable ('authorized'), exactly once. Browser redirect/query
-- data is never financial authority; the server writes and verifies this row.
-- provider_reference stores the server-issued opaque reference (for hosted
-- flows this may be an encrypted sealed reference); secrets never reach the
-- browser beyond the opaque handle the provider flow already requires.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS siton.payment_authorization_bindings (
  binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  provider_environment TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  provider_reference TEXT NOT NULL,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id),
  buyer_id TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty >= 1),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'ILS',
  delivery_option_id UUID NULL,
  delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN (
    'pending_provider_confirmation',
    'authorized',
    'consumed',
    'expired',
    'released',
    'failed'
  )),
  status_reason TEXT NULL,
  correlation_id TEXT NOT NULL,
  consumed_by_participant_id UUID NULL REFERENCES siton.participants(participant_id),
  consumed_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_payment_authorization_bindings_correlation UNIQUE (correlation_id),
  CONSTRAINT payment_binding_consumed_shape CHECK (
    (status = 'consumed' OR consumed_by_participant_id IS NULL)
    AND (consumed_by_participant_id IS NULL) = (consumed_at IS NULL)
  )
);

-- Join-time lookup: newest acceptable binding for this (deal, buyer, browser handle).
CREATE INDEX IF NOT EXISTS idx_payment_bindings_join_lookup
  ON siton.payment_authorization_bindings (deal_id, buyer_id, status, created_at DESC);

-- Reference lookup for reconciliation and hosted-completion confirmation.
CREATE INDEX IF NOT EXISTS idx_payment_bindings_authorization_id
  ON siton.payment_authorization_bindings (authorization_id);

CREATE INDEX IF NOT EXISTS idx_payment_bindings_status_created
  ON siton.payment_authorization_bindings (status, created_at);

-- A participant is backed by at most one consumed binding — the durable,
-- indexed provider-reference source for capture/recovery/refund/release.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_bindings_consumed_participant
  ON siton.payment_authorization_bindings (consumed_by_participant_id)
  WHERE consumed_by_participant_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_payment_bindings_updated_at ON siton.payment_authorization_bindings;
CREATE TRIGGER trg_payment_bindings_updated_at
BEFORE UPDATE ON siton.payment_authorization_bindings
FOR EACH ROW EXECUTE FUNCTION siton.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Legal release transitions. Migration 008 (never edited) permits
-- AuthReleased only from ChargeFailedRecovery; canonical TypeScript truth has
-- always additionally allowed AuthHeld → AuthReleased and
-- AuthLocked → AuthReleased for failed/cancelled deals before capture.
-- This forward migration closes the DB/TS drift.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.is_valid_money_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'NoFinancial' AND v_to = 'AuthHeld' THEN true
    WHEN v_from = 'AuthHeld' AND v_to IN ('AuthLocked', 'AuthReleased') THEN true
    WHEN v_from = 'AuthLocked' AND v_to IN ('ChargeAttempt', 'AuthReleased') THEN true
    WHEN v_from = 'ChargeAttempt' AND v_to IN ('ChargedSuccess', 'ChargeFailedRecovery') THEN true
    WHEN v_from = 'ChargeFailedRecovery' AND v_to IN ('RecoveredCharge', 'AuthReleased') THEN true
    WHEN v_from IN ('ChargedSuccess', 'RecoveredCharge') AND v_to = 'Refunded' THEN true
    ELSE false
  END
$$;

-- New canonical audit action for pre-capture authorization release.
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
    'refund.issue',
    'authorization.release'
  )
$$;

-- ---------------------------------------------------------------------------
-- 3) Worker-owned payment reconciliation + release outbox rail.
-- payment_reconcile: resolves UNKNOWN provider outcomes via authoritative
--   provider status lookup (bounded attempts, DLQ, manual-review case).
-- payment_release: provider-neutral release/void of held authorizations for
--   failed/cancelled deals.
-- Both are participant-scoped (aggregate_type 'participant').
-- ---------------------------------------------------------------------------
ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
ALTER TABLE siton.outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN (
    'charge_deal',
    'recovery_deal',
    'finalize_deal',
    'refund_issue',
    'deadline_check',
    'cancel_refund',
    'seller_payout_prepare',
    'seller_payout_dispatch',
    'seller_payout_reconcile',
    'invoice_document_issue',
    'invoice_document_reconcile',
    'viral_recompute',
    'payment_reconcile',
    'payment_release'
  ));

ALTER TABLE siton.outbox_dlq DROP CONSTRAINT IF EXISTS outbox_dlq_event_type_archive_check;
ALTER TABLE siton.outbox_dlq
  ADD CONSTRAINT outbox_dlq_event_type_archive_check
  CHECK (event_type IN (
    'charge_deal',
    'recovery_deal',
    'finalize_deal',
    'refund_issue',
    'deadline_check',
    'cancel_refund',
    'seller_payout_prepare',
    'seller_payout_dispatch',
    'seller_payout_reconcile',
    'invoice_document_issue',
    'invoice_document_reconcile',
    'viral_recompute',
    'payment_reconcile',
    'payment_release'
  )) NOT VALID;

-- Release provider attempts are durably recorded before I/O like every other
-- money action. They are NOT charge attempts: migration 050's rolling
-- three-attempt trigger only counts charge_start/recovery, unchanged.
ALTER TABLE siton.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_attempt_type_check;
ALTER TABLE siton.payment_attempts
  ADD CONSTRAINT payment_attempts_attempt_type_check
  CHECK (attempt_type IN ('charge_start','recovery','refund','deadline_check','cancel_refund','release'));

COMMIT;
