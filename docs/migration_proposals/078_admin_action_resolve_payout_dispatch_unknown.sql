-- PROPOSED migration (not applied; src/migrations was out of scope for the
-- Black-Sky hardening task). Promote to src/migrations/078_*.sql (or the next
-- free number) after owner review.
--
-- Widens siton.admin_actions.action_type to allow the operator-attested
-- resolution of a payout dispatch_outcome_unknown case
-- (src/admin_control_plane.ts, src/payout_rail.ts
-- resolveDispatchUnknownByAttestationInTx). Until it is applied the admin
-- route answers 409 admin_action_type_requires_migration for that action.
-- tests/admin_payout_dispatch_attestation_validation.ts applies this exact
-- statement to its isolated test database.

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
