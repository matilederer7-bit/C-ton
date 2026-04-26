-- Migration 029: provider-ready notification rail
-- Notifications are side effects only; they never own deal, participant, or money state.

CREATE TABLE IF NOT EXISTS siton.notification_events (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'buyer_joined_authorized',
    'buyer_deal_target_reached',
    'buyer_deal_completed',
    'buyer_deal_failed',
    'buyer_recovery_required',
    'buyer_payment_recovered',
    'seller_deal_published',
    'seller_target_reached',
    'seller_deal_completed',
    'seller_deal_failed',
    'seller_excel_ready'
  )),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('buyer','seller','admin')),
  recipient_ref TEXT NULL,
  deal_id UUID NULL,
  participant_id UUID NULL,
  seller_id TEXT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email','whatsapp_link','internal')),
  template_key TEXT NOT NULL CHECK (template_key IN (
    'buyer_joined_authorized_he',
    'buyer_deal_target_reached_he',
    'buyer_deal_completed_he',
    'buyer_deal_failed_he',
    'buyer_recovery_required_he',
    'buyer_payment_recovered_he',
    'seller_deal_published_he',
    'seller_target_reached_he',
    'seller_deal_completed_he',
    'seller_deal_failed_he',
    'seller_excel_ready_he'
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

CREATE TABLE IF NOT EXISTS siton.notification_attempts (
  attempt_id BIGSERIAL PRIMARY KEY,
  notification_id UUID NOT NULL REFERENCES siton.notification_events(notification_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('success','temporary_fail','permanent_fail','skipped')),
  provider_message_id TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_events_status_schedule
  ON siton.notification_events (status, scheduled_for, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_events_deal
  ON siton.notification_events (deal_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_events_participant
  ON siton.notification_events (participant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_events_seller
  ON siton.notification_events (seller_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_attempts_notification
  ON siton.notification_attempts (notification_id, created_at);
