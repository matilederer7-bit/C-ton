-- 054 — R9A communications foundation: bounded notification retries, crash
-- reclaim, correlation, and a distinct blocked-by-safety terminal status.
--
-- Uses the existing 029 notification rail; this is NOT a second notification
-- system. No real delivery adapter exists or is enabled by this migration.

BEGIN;

SET search_path TO siton, public;

ALTER TABLE siton.notification_events
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ NULL;

ALTER TABLE siton.notification_events
  DROP CONSTRAINT IF EXISTS notification_events_status_check;
ALTER TABLE siton.notification_events
  ADD CONSTRAINT notification_events_status_check
  CHECK (status IN ('pending','processing','sent','failed','cancelled','skipped','blocked'));

ALTER TABLE siton.notification_events
  DROP CONSTRAINT IF EXISTS notification_events_attempt_count_nonnegative;
ALTER TABLE siton.notification_events
  ADD CONSTRAINT notification_events_attempt_count_nonnegative
  CHECK (attempt_count >= 0);

-- Reclaim scan: stranded 'processing' rows by claim age.
CREATE INDEX IF NOT EXISTS idx_notification_events_processing_reclaim
  ON siton.notification_events (processing_started_at)
  WHERE status = 'processing';

COMMIT;
