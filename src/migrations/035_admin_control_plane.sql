BEGIN;

SET search_path TO siton, public;

SELECT pg_advisory_xact_lock(hashtext('siton_admin_control_plane_ddl'));

ALTER TABLE IF EXISTS siton.audit_log ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE IF EXISTS siton.idempotency_log ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE IF EXISTS siton.idempotency_log ADD COLUMN IF NOT EXISTS request_id TEXT NULL;
ALTER TABLE IF EXISTS siton.outbox_events ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE IF EXISTS siton.outbox_events ADD COLUMN IF NOT EXISTS request_id TEXT NULL;
ALTER TABLE IF EXISTS siton.outbox_dlq ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE IF EXISTS siton.outbox_dlq ADD COLUMN IF NOT EXISTS request_id TEXT NULL;
ALTER TABLE IF EXISTS siton.webhook_events ADD COLUMN IF NOT EXISTS request_id TEXT NULL;
ALTER TABLE IF EXISTS siton.notification_events ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE IF EXISTS siton.notification_events ADD COLUMN IF NOT EXISTS request_id TEXT NULL;
ALTER TABLE IF EXISTS siton.operational_cases ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE IF EXISTS siton.operational_cases ADD COLUMN IF NOT EXISTS request_id TEXT NULL;
ALTER TABLE IF EXISTS siton.operational_case_events ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;

CREATE TABLE IF NOT EXISTS siton.admin_actions (
  admin_action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'trigger_reconcile',
    'requeue_outbox_event',
    'retry_notification',
    'retry_invoice_failed',
    'freeze_payouts',
    'unfreeze_payouts',
    'open_support_case',
    'content_takedown_request',
    'pause_joining_emergency',
    'pause_charging_emergency'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'Requested',
    'AwaitingSecondApproval',
    'Approved',
    'Rejected',
    'Executing',
    'Completed',
    'Failed',
    'Cancelled'
  )),
  target_type TEXT NOT NULL CHECK (target_type IN (
    'deal','participant','payment','invoice','payout','webhook','outbox','seller','support_case','content','system'
  )),
  target_id TEXT NOT NULL,
  requested_by_admin_id TEXT NULL,
  reason TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  request_id TEXT NULL,
  idempotency_key TEXT NOT NULL,
  requires_second_approval BOOLEAN NOT NULL DEFAULT false,
  approved_by_admin_id TEXT NULL,
  approved_at TIMESTAMPTZ NULL,
  executed_at TIMESTAMPTZ NULL,
  failed_at TIMESTAMPTZ NULL,
  result_code TEXT NULL,
  result_message TEXT NULL,
  metadata_jsonb JSONB NULL,
  result_jsonb JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (action_type, target_type, target_id, idempotency_key)
);

ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS request_id TEXT NULL;
ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS requires_second_approval BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS result_code TEXT NULL;
ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS result_message TEXT NULL;
UPDATE siton.admin_actions
SET correlation_id=COALESCE(NULLIF(correlation_id,''), 'legacy-admin-action:' || admin_action_id::text)
WHERE correlation_id IS NULL OR btrim(correlation_id)='';
ALTER TABLE IF EXISTS siton.admin_actions ALTER COLUMN correlation_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_actions_status_created ON siton.admin_actions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_action_created ON siton.admin_actions (action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON siton.admin_actions (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_correlation ON siton.admin_actions (correlation_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='siton' AND table_name='audit_log' AND column_name='correlation_id') THEN
    CREATE INDEX IF NOT EXISTS idx_audit_log_correlation ON siton.audit_log (correlation_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='siton' AND table_name='outbox_events' AND column_name='correlation_id') THEN
    CREATE INDEX IF NOT EXISTS idx_outbox_events_correlation ON siton.outbox_events (correlation_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='siton' AND table_name='webhook_events' AND column_name='correlation_id') THEN
    CREATE INDEX IF NOT EXISTS idx_webhook_events_correlation ON siton.webhook_events (correlation_id);
  END IF;
END $$;

COMMIT;
