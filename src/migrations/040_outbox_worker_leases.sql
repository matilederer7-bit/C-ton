BEGIN;

SET search_path TO siton, public;

ALTER TABLE siton.outbox_events
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS worker_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;

ALTER TABLE siton.outbox_dlq
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS worker_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_claimable
  ON siton.outbox_events (available_at, created_at)
  WHERE status = 'pending' AND sent = false;

CREATE INDEX IF NOT EXISTS idx_outbox_active_lease
  ON siton.outbox_events (lease_expires_at, worker_id)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS siton.worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','ready','draining','stopped')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_freshness
  ON siton.worker_heartbeats (heartbeat_at DESC);

COMMIT;
