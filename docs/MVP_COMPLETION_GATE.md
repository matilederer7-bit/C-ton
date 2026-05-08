# MVP Completion Gate

Status: passed and followed by a passing Full E2E Gate. Pass means the project was ready for Full E2E and the next gate is now Provider Sandbox / Live Money Validation. Pass does not mean live-ready.

## Verdict Values

- `ready_for_full_e2e` — no demo/E2E blockers, no critical warnings.
- `warning` — non-blocking warnings remain (for example overdue support cases or scale partial posture).
- `blocked` — at least one demo/E2E blocker is present.

The gate is **never** `live_ready`. Full E2E has now passed; live readiness is still decided only by Provider Sandbox / Live Money Validation.

## Sections Evaluated

1. Seller onboarding (`seller_onboarding_readiness`)
2. Storage (`storage_readiness`)
3. Notifications (`notifications_readiness`)
4. Support operations (`support_readiness`)
5. Admin intervention (`admin_intervention_readiness`)
6. Operational runbooks (`docs/OPERATIONAL_RUNBOOKS.md` — file existence)
7. Legal / trust surfaces (`docs/LEGAL_TRUST_SURFACES.md` — file existence)
8. Production launch readiness (`production_launch_readiness`)
9. Security hardening (`security_hardening_gate`)
10. Scale readiness (`scale_readiness`)
11. Live money readiness (`live_money_readiness`) — must remain `blocked`. Not a Full E2E blocker.

## Invariants Asserted

- `siton_fee_pct = 8`
- `distributor_commission_present = false`
- `state_machine_changed = false`
- `money_logic_changed = false`
- `live_money_performed = false`
- `secrets_in_repo = false`
- `no_destructive_admin_action = true`

## Endpoint

`mission_control.mvp_completion_readiness` is exposed in the Mission Control response. It is a read-only audit surface.

## Test

`npm run test:mvp-completion` runs source-level checks for:

- Mission Control fields presence.
- Required documents existence.
- New migration `037` presence and content.
- Adapter contract presence.
- Admin intervention helper presence.
- Notification template additions.
- Publish flow KYC tightening for production-like mode.
- Payout freeze gate inside `payout_rail`.

The test is intentionally source-static. The DB-backed Full E2E Gate is documented in `docs/FULL_E2E_GATE.md` and runs through `npm run test:full-e2e-gate`.

## Post-E2E Live Money Blockers

The MVP completion gate explicitly records that live money remains blocked. The Full E2E Gate did not unblock live money. Live money requires a separate Provider Sandbox / Live Money Validation gate with:

- Provider sandbox authorization / capture / refund / reconcile evidence.
- Webhook signature secret rotation policy.
- Production admin identity / MFA enrollment.
- Token-only participant tracking.
- Distributed rate limiting or accepted single-instance posture.

These are documented in `docs/PROVIDER_LIVE_MONEY_READINESS.md` and `docs/PRODUCTION_LAUNCH_READINESS.md`.
