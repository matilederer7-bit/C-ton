-- 079 — Black-Sky: operator-attested resolution of a payout
-- dispatch_outcome_unknown case.
--
-- Widens siton.admin_actions.action_type (migration 035) with
-- 'resolve_payout_dispatch_unknown' so the admin control plane can record the
-- dual-approved, MFA-gated attestation action (src/admin_control_plane.ts,
-- src/payout_rail.ts resolveDispatchUnknownByAttestationInTx). The action makes
-- no provider call and moves no money; it only advances payout status forward
-- on a provider reference the operator attests. Every existing action type is
-- kept. Without this migration the route answers 409
-- admin_action_type_requires_migration.

BEGIN;

ALTER TABLE siton.admin_actions DROP CONSTRAINT IF EXISTS admin_actions_action_type_check;
ALTER TABLE siton.admin_actions ADD CONSTRAINT admin_actions_action_type_check CHECK (action_type IN (
  'trigger_reconcile',
  'requeue_outbox_event',
  'retry_notification',
  'retry_invoice_failed',
  'freeze_payouts',
  'unfreeze_payouts',
  'open_support_case',
  'content_takedown_request',
  'pause_joining_emergency',
  'pause_charging_emergency',
  'resolve_payout_dispatch_unknown'
));

COMMIT;
