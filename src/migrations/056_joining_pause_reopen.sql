-- 056 — P0.3: manual joining pause/reopen becomes a canonical, reversible
-- product action.
--
-- Owner-reported defect: manual close only worked from TargetReached — a deal
-- still awaiting its minimum (PendingTarget, the common case) hit an illegal
-- transition and stayed open. And a manual close was irreversible.
--
-- Canonical changes (mirrored in the TS DEAL_TRANSITIONS map):
--   * PendingTarget    → ClosedForJoining   (manual pause before the target)
--   * ClosedForJoining → PendingTarget      (reopen, still below threshold)
--   * ClosedForJoining → TargetReached      (reopen, threshold already met)
-- Reopen is permitted ONLY for a manual close (close_reason='manual') while
-- the deadline has not passed, capacity is not full, and charging has not
-- begun — enforced in the route; the DB stays the transition authority.
--
-- New metadata: WHY joining closed, and when.

BEGIN;

SET search_path TO siton, public;

ALTER TABLE siton.deals
  ADD COLUMN IF NOT EXISTS close_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS closed_for_joining_at TIMESTAMPTZ NULL;

ALTER TABLE siton.deals DROP CONSTRAINT IF EXISTS deals_close_reason_check;
ALTER TABLE siton.deals
  ADD CONSTRAINT deals_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN ('manual','deadline','capacity','system'));

CREATE OR REPLACE FUNCTION siton.is_valid_deal_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'Draft' AND v_to IN ('PendingTarget', 'Cancelled') THEN true
    WHEN v_from = 'PendingTarget' AND v_to IN ('TargetReached', 'Failed', 'ClosedForJoining') THEN true
    WHEN v_from = 'TargetReached' AND v_to = 'ClosedForJoining' THEN true
    WHEN v_from = 'ClosedForJoining' AND v_to IN ('ReadyForCharging', 'PendingTarget', 'TargetReached') THEN true
    WHEN v_from = 'ReadyForCharging' AND v_to = 'Charging' THEN true
    WHEN v_from = 'Charging' AND v_to = 'CompletionWindow' THEN true
    WHEN v_from = 'CompletionWindow' AND v_to IN ('Completed', 'Failed') THEN true
    ELSE false
  END
$$;

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
    'deal.reopen_joining',
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

COMMIT;
