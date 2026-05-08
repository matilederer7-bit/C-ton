-- Phase 5 / Phase 2 foundations:
-- - admin_control_flags: bounded internal flags for emergency pauses, payout freezes,
--   content takedowns, and similar SuperAdmin actions. These flags are NOT money operations.
--   They block new joins / new charging jobs / payout eligibility but never alter
--   existing buyer state, deal state, money state, or amounts.
-- - storage_orphan_reports: read-only summary rows that the admin orphan report endpoint
--   produces. The reports are evidence; they never delete files.

BEGIN;
SET search_path TO siton, public;

CREATE SCHEMA IF NOT EXISTS siton;

CREATE TABLE IF NOT EXISTS siton.admin_control_flags (
  flag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_type TEXT NOT NULL CHECK (flag_type IN (
    'pause_joining_emergency',
    'pause_charging_emergency',
    'payout_freeze',
    'content_takedown'
  )),
  scope_type TEXT NOT NULL CHECK (scope_type IN (
    'global',
    'deal',
    'seller',
    'participant',
    'payout',
    'content'
  )),
  scope_id TEXT NOT NULL DEFAULT 'global',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired')),
  reason TEXT NOT NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by_admin_id TEXT NULL,
  approved_by_admin_id TEXT NULL,
  admin_action_id UUID NULL,
  request_id TEXT NULL,
  correlation_id TEXT NULL,
  expires_at TIMESTAMPTZ NULL,
  released_at TIMESTAMPTZ NULL,
  released_by_admin_id TEXT NULL,
  released_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_control_flags_active
  ON siton.admin_control_flags (flag_type, scope_type, scope_id, status)
  WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_admin_control_flags_scope
  ON siton.admin_control_flags (scope_type, scope_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_control_flags_expires
  ON siton.admin_control_flags (expires_at)
  WHERE expires_at IS NOT NULL AND status='active';

CREATE TABLE IF NOT EXISTS siton.admin_control_flag_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id UUID NOT NULL REFERENCES siton.admin_control_flags(flag_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('flag.create','flag.release','flag.expire','flag.extend')),
  actor_ref TEXT NOT NULL DEFAULT 'admin',
  reason TEXT NOT NULL DEFAULT '',
  request_id TEXT NULL,
  correlation_id TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_control_flag_events_flag
  ON siton.admin_control_flag_events (flag_id, created_at DESC);

CREATE TABLE IF NOT EXISTS siton.storage_orphan_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by_admin_id TEXT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  scanned_keys_count INTEGER NOT NULL DEFAULT 0,
  orphan_keys_count INTEGER NOT NULL DEFAULT 0,
  missing_files_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_storage_orphan_reports_generated
  ON siton.storage_orphan_reports (generated_at DESC);

COMMIT;
