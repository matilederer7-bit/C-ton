-- Migration 015: notifications delivery table
-- Tracks every notification dispatch attempt with full idempotency.
-- event_key is the idempotency key: {notification_event_type}:{entity_id}:{channel}
-- UNIQUE on event_key prevents double dispatch for the same business event + channel.

CREATE TABLE IF NOT EXISTS siton.notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Idempotency: one row per (event_type, entity, channel) combination.
  -- Format: "{notification_event_type}:{participant_id_or_deal_id}:{channel}"
  event_key TEXT NOT NULL,

  -- Notification event type (what happened, from the buyer's perspective)
  notification_event_type TEXT NOT NULL CHECK (notification_event_type IN (
    'join_authorized',
    'charge_succeeded',
    'charge_failed_recovery',
    'deal_completed',
    'deal_failed',
    'refund_issued',
    'deal_cancelled'
  )),

  -- Channel: sms | email | log
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'email', 'log')),

  -- Recipient: phone number (sms) or email address (email)
  recipient TEXT NOT NULL,

  -- Template used to render the message
  template_id TEXT NOT NULL,

  -- Template interpolation params (deal_title, buyer_id, etc.)
  template_params JSONB NOT NULL DEFAULT '{}',

  -- Delivery state machine: pending → sent | failed
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,

  -- Provider tracking
  provider_code TEXT NOT NULL DEFAULT 'log-only',
  provider_message_id TEXT NULL,   -- returned by provider on success
  last_error TEXT NULL,

  -- Timing
  sent_at TIMESTAMPTZ NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_notifications_event_key UNIQUE (event_key)
);

-- Claim-pending index: dispatcher queries status='pending' AND available_at <= now()
CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON siton.notifications (status, available_at)
  WHERE status = 'pending';
