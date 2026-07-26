CREATE TABLE IF NOT EXISTS siton.storage_cleanup_tasks (
  task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local','s3')),
  storage_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_cleanup_tasks_active_key
  ON siton.storage_cleanup_tasks(storage_provider, storage_key)
  WHERE status IN ('pending','processing');

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_tasks_claim
  ON siton.storage_cleanup_tasks(status, available_at, created_at)
  WHERE status IN ('pending','processing');
