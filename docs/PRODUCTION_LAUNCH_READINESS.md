# Production Launch Readiness

Status: foundation map. Live launch remains intentionally blocked until provider sandbox / live money validation is complete.

## Verdict

- `demo_ready`: yes
- `e2e_ready`: yes when scale and security demo gates are not blocked
- `sandbox_ready`: partial, depends on provider env presence
- `live_ready`: no
- `blocked`: yes

This document is a checklist surface for the operator. Mission Control returns the same data as `mission_control.production_launch_readiness`.

## Sections

1. **Environment** — `APP_DEPLOYMENT_MODE`, required env presence, missing envs.
2. **Secrets** — no secrets in repo policy, required secrets list (presence checked, never values).
3. **Domain / HTTPS** — TLS termination at platform/load balancer.
4. **Database** — managed DB before live, backup policy, migration policy (additive idempotent only).
5. **Storage** — object storage required before multi-instance / live.
6. **Providers** — payment, invoice, payout, notification statuses.
7. **Security** — admin identity, MFA, RBAC, participant tracking, rate-limit scale.
8. **Observability** — Mission Control, Control Plane, runbooks.
9. **Legal** — terms, privacy, refund, payment disclosure, seller terms.
10. **Cost guardrails** — operator-set max instances, DB pool alerts, error rate alerts.
11. **Rollback** — deploy rollback plan, additive migration policy.
12. **Data retention** — audit and document retention before live.
13. **Support** — operational cases status, SLA advisory.
14. **Seller onboarding** — KYC pending / rejected counts, deals blocked.
15. **Admin intervention** — payout freeze / emergency pause active flags.

## Live Blockers

- `live_money_blocked` until provider sandbox / live validation runs.
- `object_storage_required_before_multi_instance` until an object storage adapter is connected.
- `live_security_blocked` until named admins are provisioned and shared-key fallback is retired.
- `payment_provider_not_live_validated` from `provider_live_money_readiness`.

## Next Gate

`Full E2E Gate`. After Full E2E, the next and final gate before live money is provider sandbox / live money validation.

## Validation

- `npm run test:production-launch-readiness`
- `npm run test:provider-live-money-readiness`
- `npm run test:scale-readiness`
- `npm run test:security-hardening`
