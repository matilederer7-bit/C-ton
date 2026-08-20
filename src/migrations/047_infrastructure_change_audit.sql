BEGIN;

-- Isolated infrastructure-control audit. It is deliberately outside the
-- canonical business state machine and never stores credentials.
CREATE TABLE IF NOT EXISTS siton.infrastructure_change_audit (
  infrastructure_change_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL CHECK (action_type = 'supabase_compute_upgrade'),
  status TEXT NOT NULL CHECK (status IN ('requested','succeeded','failed')),
  requested_by_admin_id UUID NULL REFERENCES siton.admin_users(admin_user_id) ON DELETE SET NULL,
  current_tier TEXT NOT NULL,
  target_tier TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_id TEXT NULL,
  correlation_id TEXT NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_infrastructure_change_audit_created
  ON siton.infrastructure_change_audit(created_at DESC);

COMMIT;
