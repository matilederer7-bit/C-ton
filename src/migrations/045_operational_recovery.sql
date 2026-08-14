BEGIN;

SET search_path TO siton, public;

ALTER TABLE siton.outbox_events
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NULL;

ALTER TABLE siton.outbox_events
  ALTER COLUMN max_attempts SET DEFAULT 4;

ALTER TABLE siton.outbox_dlq
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NULL;

ALTER TABLE siton.outbox_dlq
  ALTER COLUMN max_attempts SET DEFAULT 4;

-- The DLQ is an archive. 014 created it with LIKE ... INCLUDING ALL, which
-- copied active-queue checks under outbox_events constraint names. Historical
-- rows may legitimately record more attempts than the policy in force when
-- they are inspected, and every currently valid active event must remain
-- archivable.
ALTER TABLE siton.outbox_dlq
  DROP CONSTRAINT IF EXISTS outbox_events_attempt_count_check,
  DROP CONSTRAINT IF EXISTS outbox_dlq_attempt_count_check,
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check,
  DROP CONSTRAINT IF EXISTS outbox_dlq_event_type_check,
  DROP CONSTRAINT IF EXISTS outbox_events_aggregate_type_check,
  DROP CONSTRAINT IF EXISTS outbox_dlq_aggregate_type_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_events_lease_generation_nonnegative'
      AND conrelid = 'siton.outbox_events'::regclass
  ) THEN
    ALTER TABLE siton.outbox_events
      ADD CONSTRAINT outbox_events_lease_generation_nonnegative
      CHECK (lease_generation >= 0);
  END IF;

  -- Existing generation-0 processing rows are intentionally left visible for
  -- the reviewed repair path. NOT VALID preserves them while rejecting every
  -- new/updated unfenced claim, including a rolling old worker binary.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_processing_requires_fenced_lease'
      AND conrelid = 'siton.outbox_events'::regclass
  ) THEN
    ALTER TABLE siton.outbox_events
      ADD CONSTRAINT outbox_processing_requires_fenced_lease
      CHECK (
        status <> 'processing' OR (
          lease_generation >= 1
          AND worker_id IS NOT NULL
          AND claimed_at IS NOT NULL
          AND processing_started_at IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND last_heartbeat_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_dlq_lease_generation_nonnegative'
      AND conrelid = 'siton.outbox_dlq'::regclass
  ) THEN
    ALTER TABLE siton.outbox_dlq
      ADD CONSTRAINT outbox_dlq_lease_generation_nonnegative
      CHECK (lease_generation >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_dlq_attempts_archive_check'
      AND conrelid = 'siton.outbox_dlq'::regclass
  ) THEN
    ALTER TABLE siton.outbox_dlq
      ADD CONSTRAINT outbox_dlq_attempts_archive_check
      CHECK (attempt_count >= 0 AND max_attempts >= 1 AND max_attempts <= 50)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_dlq_event_type_archive_check'
      AND conrelid = 'siton.outbox_dlq'::regclass
  ) THEN
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
        'invoice_document_reconcile'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_dlq_aggregate_type_archive_check'
      AND conrelid = 'siton.outbox_dlq'::regclass
  ) THEN
    ALTER TABLE siton.outbox_dlq
      ADD CONSTRAINT outbox_dlq_aggregate_type_archive_check
      CHECK (aggregate_type IN ('deal','participant','seller_payout_batch','invoice_document'))
      NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS siton.operational_recovery_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_sequence BIGSERIAL NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('outbox_event','inventory','deal_audit')),
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'claim','reclaim','heartbeat','completion','retry','failure','dlq',
    'repair_inventory','repair_lease','repair_audit_backfill'
  )),
  worker_id TEXT NULL,
  lease_generation BIGINT NULL CHECK (lease_generation IS NULL OR lease_generation >= 0),
  attempt_count INT NULL CHECK (attempt_count IS NULL OR attempt_count >= 0),
  from_status TEXT NULL,
  to_status TEXT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  reason_code TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE siton.operational_recovery_audit
  ADD COLUMN IF NOT EXISTS audit_sequence BIGSERIAL;

ALTER TABLE siton.operational_recovery_audit
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_recovery_audit_sequence
  ON siton.operational_recovery_audit (audit_sequence);

CREATE INDEX IF NOT EXISTS idx_operational_recovery_audit_subject
  ON siton.operational_recovery_audit (subject_type, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_recovery_audit_worker
  ON siton.operational_recovery_audit (worker_id, created_at DESC)
  WHERE worker_id IS NOT NULL;

CREATE OR REPLACE FUNCTION siton.enforce_outbox_fencing_cutover()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'processing' AND OLD.lease_generation = 0 THEN
      RAISE EXCEPTION 'legacy generation-0 processing event requires explicit fenced repair'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'processing' AND OLD.lease_generation = 0 THEN
    IF NOT (
      OLD.event_type = 'deadline_check'
      AND NEW.event_uuid = OLD.event_uuid
      AND NEW.event_type = OLD.event_type
      AND NEW.aggregate_type = OLD.aggregate_type
      AND NEW.aggregate_id = OLD.aggregate_id
      AND NEW.payload IS NOT DISTINCT FROM OLD.payload
      AND NEW.attempt_count = OLD.attempt_count
      AND NEW.max_attempts = OLD.max_attempts
      AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
      AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
      AND NEW.created_at = OLD.created_at
      AND NEW.status = 'pending'
      AND NEW.lease_generation = 1
      AND NEW.sent = false
      AND NEW.sent_at IS NULL
      AND NEW.worker_id IS NULL
      AND NEW.claimed_at IS NULL
      AND NEW.processing_started_at IS NULL
      AND NEW.lease_expires_at IS NULL
      AND NEW.last_heartbeat_at IS NULL
      AND NEW.available_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM siton.operational_recovery_audit audit
        WHERE audit.subject_type = 'outbox_event'
          AND audit.subject_id = OLD.event_uuid::text
          AND audit.action = 'repair_lease'
          AND audit.lease_generation = NEW.lease_generation
          AND audit.attempt_count = OLD.attempt_count
          AND audit.from_status = 'processing'
          AND audit.to_status = 'pending'
          AND audit.reason_code = 'stage32b_controlled_repair'
      )
    ) THEN
      RAISE EXCEPTION 'legacy generation-0 processing event requires explicit fenced repair'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_outbox_fencing_cutover_update ON siton.outbox_events;
CREATE TRIGGER trg_outbox_fencing_cutover_update
BEFORE UPDATE ON siton.outbox_events
FOR EACH ROW EXECUTE FUNCTION siton.enforce_outbox_fencing_cutover();

DROP TRIGGER IF EXISTS trg_outbox_fencing_cutover_delete ON siton.outbox_events;
CREATE TRIGGER trg_outbox_fencing_cutover_delete
BEFORE DELETE ON siton.outbox_events
FOR EACH ROW EXECUTE FUNCTION siton.enforce_outbox_fencing_cutover();

CREATE OR REPLACE FUNCTION siton.prevent_operational_recovery_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operational_recovery_audit is append-only';
END
$$;

DROP TRIGGER IF EXISTS trg_operational_recovery_audit_append_only_update
  ON siton.operational_recovery_audit;
CREATE TRIGGER trg_operational_recovery_audit_append_only_update
BEFORE UPDATE ON siton.operational_recovery_audit
FOR EACH ROW EXECUTE FUNCTION siton.prevent_operational_recovery_audit_mutation();

DROP TRIGGER IF EXISTS trg_operational_recovery_audit_append_only_delete
  ON siton.operational_recovery_audit;
CREATE TRIGGER trg_operational_recovery_audit_append_only_delete
BEFORE DELETE ON siton.operational_recovery_audit
FOR EACH ROW EXECUTE FUNCTION siton.prevent_operational_recovery_audit_mutation();

COMMIT;
