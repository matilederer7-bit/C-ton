# Full E2E Gate

Status: PASS for provider sandbox validation. This gate does not mark the system live-ready and did not connect live money.

## Verdict

- `full_e2e_gate`: pass
- `provider_sandbox_ready`: yes
- `live_money_ready`: no
- `live_money_performed`: no
- `state_machine_changed`: no
- `money_logic_changed`: no

The next gate is Provider Sandbox / Live Money Validation. Real provider credentials, real captures, real refunds, real payouts and live-ready status remain blocked until that gate produces evidence.

## Scope Covered

The gate is implemented by `npm run test:full-e2e-gate` and validates an integrated demo-provider journey across:

1. Seller onboarding, KYC blocking, admin approval and seller publish terms.
2. Public buyer deal surface with Hebrew RTL shell, legal footer, quantity and no marketplace/search posture.
3. OTP, demo authorization and participant tracking token enforcement with hash-only persistence.
4. Demo payment flow with no raw card data and no live money.
5. Deal progression, same-buyer repeat purchase, target reached and max-unit blocking.
6. Close joining, charge preparation, outbox event visibility, webhook idempotency and trace correlation.
7. Recovery and 90 percent completion contracts via runtime/source contract assertions.
8. Completed/failed outcome invariants, invoice/notification/export safety and distributor no-commission posture.
9. Mission Control readiness sections and live money blocked verdict.
10. Admin Control Plane safe actions, RBAC/MFA/session identity and emergency pause behavior.
11. Support Operations, Storage readiness and read-only orphan report.
12. Legal/trust/accessibility baseline and API/webhook security controls.

## Previous Tail Closure

`test:preprod-torture` and `test:full-system` were failing because their harness imported the app before disabling the background outbox worker. The worker could process deadline/charge events concurrently with deterministic join tests and move state before assertions. Both harnesses now set `DISABLE_OUTBOX_WORKER=1` and fixed test ports before dynamic app import.

This was classified as test isolation, not a production state-machine or money-logic bug. The worker remains exercised by the dedicated worker/outbox/security suites and by the full gate contracts.

## Validation Commands

Passed on 2026-05-08:

- `npx tsc --noEmit`
- `npx tsc -p tsconfig.test.json`
- `npm run test:full-e2e-gate`
- `npm run test:mvp-completion`
- `npm run test:security-identity-tracking`
- `npm run test:security-hardening`
- `npm run test:mission-control`
- `npm run test:admin-control-plane`
- `npm run test:provider-live-money-readiness`
- `npm run test:refund-policy`
- `npm run test:scale-readiness`
- `npm run test:cache-policy`
- `npm run test:adversarial`
- `npm run test:frontend-browser-smoke`
- `npm run test:seller-onboarding`
- `npm run test:storage-readiness`
- `npm run test:notifications-readiness`
- `npm run test:support-operations`
- `npm run test:admin-intervention`
- `npm run test:legal-trust`
- `npm run test:production-launch-readiness`
- `npm run test:preprod-torture`
- `npm run test:full-system`
- `npm run bootstrap:demo-db`
- Bootstrap rerun with 0 migration warnings
- `npm audit --omit=dev`
- `npm audit`

No migration was added by this gate, but bootstrap and a rerun were executed after the final suite to keep the gate evidence current.

## Open Before Live Money

- Provider sandbox evidence for payment authorization, capture, refund/release, reconcile and webhooks.
- Provider sandbox evidence for invoice retry/idempotency and payout freeze/unfreeze behavior.
- Real provider credentials and webhook secrets managed outside the repository.
- Object storage before multi-instance/live.
- Production admin provisioning, MFA enrollment operations and shared-key fallback retirement or strict containment.
- Live-money runbook sign-off and explicit business approval.

## JSON / JSONB Boundary

JSON / JSONB does not act as a source of truth for money, state, eligibility,
invoice issuance, payout eligibility, admin permissions, or legal compliance.
The boundary is documented and guarded by
[`PAYMENT_JSON_BOUNDARY_AUDIT.md`](PAYMENT_JSON_BOUNDARY_AUDIT.md) and
`npm run test:json-boundary`. Mission Control reports `json_boundary_readiness`.

## Refund Policy

Refunds are system-mandated only. No seller, admin, or support user can initiate a manual commercial refund through Siton, and partial commercial refunds are forbidden. The only allowed refund path is the automatic failed-deal path after the completion window when actual charged/recovered units do not satisfy the stored 90% threshold. `npm run test:refund-policy` guards this contract and Mission Control reports `refund_policy_readiness`.
