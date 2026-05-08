# Provider Live Money Readiness

Status: demo-ready architecture audit added; Full E2E Gate passed; live money remains blocked.

## Verdict

- `demo_ready`: yes
- `sandbox_ready`: partial, depends on configured provider secrets and webhook secrets
- `live_ready`: no
- `blocked`: yes

This audit does not connect to a live provider, run live charges, expose secrets, or activate live money.

## Supported Provider Architecture

Payment:

- provider abstraction exists
- authorization/capture/recovery/refund paths are worker/outbox oriented
- webhook ingestion and dedupe are expected through provider/event IDs
- idempotency is expected through DB-backed logs and provider request IDs

Invoices:

- invoice rail exists
- provider summary is exposed
- duplicate issuance prevention and retry behavior are audited by existing invoice tests

Payouts:

- payout rail exists
- provider summary is exposed
- live external transfer is not treated as proven

## Live Money Blockers

- `payment_provider_not_live_validated`
- `payment_webhook_secret_missing_for_live` when real webhook secrets are absent
- `reconcile_runbook_or_live_provider_status_validation_required_before_live_money`
- `freeze_payouts_admin_action_foundation_only`
- live refund and payout provider validation are not complete
- admin identity/MFA and second-approval identity are not production-complete
- Security Identity Tracking Gate passes for demo foundation, but live money remains blocked until named admins are provisioned, MFA is operationally enforced, shared-key fallback is retired or constrained, and participant tracking is token-only in live mode.

## Required Environment Variables

Presence is checked without exposing values:

- `PAYMENT_PROVIDER`
- `PAYMENT_WEBHOOK_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `INVOICE_PROVIDER`
- `PAYOUT_PROVIDER`

Real/live mode must fail closed or report blocked when required secrets are missing. It must not silently fall back to demo behavior.

## Required Webhooks

- payment provider webhook with signature verification
- invoice provider webhook with signature verification when external issuance is enabled
- dedupe by provider and provider event ID
- late or duplicate webhooks must not mutate terminal state twice

## Required Tests Before Pilot

- provider sandbox authorization/capture/refund/reconcile
- duplicate webhook replay
- late webhook after terminal deal state
- unknown payment result over 24 hours
- invoice duplicate issuance retry
- payout freeze and unfreeze
- failed payout return handling
- admin emergency pause and second approval
- no raw card data in responses/logs

## Recommended Next Actions

1. Complete sandbox provider validation with recorded request IDs and webhook event IDs.
2. Implement or prove production-grade reconcile for stale `UNKNOWN` payment attempts.
3. Implement real `freeze_payouts` enforcement before live money.
4. Add production admin identity/MFA and second approval.
5. Run provider sandbox validation with no real card charges and record provider request/webhook IDs.

## Validation

- `npm run test:provider-live-money-readiness` passed.
- `npm run test:full-e2e-gate` passed with demo providers only.
- No live provider connection was made.
- No secrets were added or exposed.
- No manual money action was added.
