# Admin Mission Control

Admin Mission Control is Siton's admin-only observability center. It is protected by admin session identity or the limited read-only `x-admin-key` bootstrap fallback, uses masked data only, and is designed for investigation before intervention.

## Mission Control Endpoints

- `GET /api/admin/mission-control`
- `GET /api/admin/mission-control/anomalies`
- `GET /api/admin/mission-control/deals/:dealId/trace`
- `GET /api/admin/mission-control/participants/:participantId/trace`
- `GET /api/admin/mission-control/correlation/:correlationId`
- `GET /api/admin/mission-control/outbox/:eventId`
- `GET /api/admin/mission-control/webhooks/:provider/:eventId`

## Sections

The main response includes:

- `system_summary`
- `frontend_surface`
- `api_surface`
- `database`
- `state_machine_integrity`
- `outbox`
- `workers`
- `webhooks`
- `payments`
- `invoices`
- `payouts`
- `notifications`
- `seller_onboarding_readiness`
- `storage_readiness`
- `support_readiness`
- `mvp_completion_readiness`
- `production_launch_readiness`
- `security`
- `storage_uploads`
- `scale_readiness`
- `accordion_scaling_readiness`
- `live_money_readiness`
- `security_hardening_gate`
- `json_boundary_readiness`
- `refund_policy_readiness`
- `deal_type_readiness`
- `fulfillment_readiness`
- `performance`
- `business_metrics`
- `anomaly_center`
- `admin_actions`
- `recommended_actions`

## Verdict

- `red`: critical failure or suspected impact to money, state, webhook, outbox, DB or security.
- `yellow`: non-blocking anomaly, stale data, retries, partial configuration or unknown coverage.
- `green`: only when current checks have positive evidence.

Unknown data is shown as `unknown` / "לא ידוע", never as success.

## Phase 2: Correlation

Every HTTP response includes:

- `x-request-id`
- `x-correlation-id`

Correlation trace aggregates audit, outbox, webhooks, payments, invoices, payouts, notifications, support cases and admin actions. Coverage is reported per domain and remains `partial` until every worker/provider path carries the same ID.

## Phase 2: Admin Safe Actions

`/app/admin` now shows Admin Actions history and Safe Action entry points from anomalies.

Action endpoints:

## Readiness Gates

`seller_onboarding_readiness`, `storage_readiness`, `support_readiness`, `mvp_completion_readiness` and `production_launch_readiness` report the MVP completion and launch-readiness surfaces that the Full E2E Gate consumes.

`scale_readiness` reports stateless API posture, in-memory risks, OTP/rate-limit/storage/worker/idempotency readiness, DB pool posture, load balancer readiness, and blockers before multi-instance deployment.

`accordion_scaling_readiness` reports docker packaging status, external DB readiness, storage mode, rate-limit/worker/load-balancer posture, cost guardrails posture, AWS blueprint status, estimated scale risk, per-tier (Tier 0–Tier 3) status, blockers and warnings — see [`AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md`](AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md), [`DOCKER_READINESS.md`](DOCKER_READINESS.md) and [`ENVIRONMENT_CONTRACT.md`](ENVIRONMENT_CONTRACT.md).

`live_money_readiness` reports payment, webhook, reconcile, refund, invoice, payout, admin intervention, and security posture. `live_ready` remains false unless required controls and validation evidence are present.

`security_hardening_gate` reports defensive security findings with `pass` / `warning` / `blocked`, P0/P1/P2/P3 severity, masked evidence only, blockers, and safe next actions. It now includes `admin_identity_status`, `mfa_status`, `rbac_status`, `participant_tracking_security`, `demo_security_verdict`, and `live_security_verdict`.

`json_boundary_readiness` reports the audit that JSON / JSONB columns are evidence, outbox job envelopes, or supplemental metadata only — never a source of truth for money, state, eligibility, invoice issuance, payout eligibility, admin permissions, or legal compliance. It exposes `verdict` (`pass` / `warning` / `blocked`), `jsonb_columns_total`, per-classification counts (`allowed_evidence_payload`, `allowed_job_payload`, `allowed_metadata`, `risky_business_source`, `forbidden_money_source`), the full `columns` classification list with `truth_source` per column, and findings (P0/P1/P2). The static guard `npm run test:json-boundary` enforces the boundary on every change. See [`PAYMENT_JSON_BOUNDARY_AUDIT.md`](PAYMENT_JSON_BOUNDARY_AUDIT.md).

These gates are audit/reporting surfaces only. They do not activate Redis, live providers, live charges, manual money changes, or destructive actions.

`refund_policy_readiness` reports the refund-policy alignment audit. It exposes `verdict` (`pass` / `warning` / `blocked`), `manual_refund_allowed=false`, `seller_refund_allowed=false`, `admin_commercial_refund_allowed=false`, `support_refund_allowed=false`, `partial_commercial_refund_allowed=false`, `system_refund_on_failed_deal_required=true`, route/action/UI scan results, `json_boundary_respected=true`, `provider_sandbox_required=true`, blockers and warnings. See [`REFUND_POLICY.md`](REFUND_POLICY.md).

`deal_type_readiness` and `fulfillment_readiness` report physical/voucher/ticket
counts, required table presence, fulfillment unit totals, and impossible
issuance anomalies. Mission Control safe queries are isolated with per-query
SAVEPOINT handling so one collector error cannot poison downstream readiness
sections.

Full E2E validation is documented in `docs/FULL_E2E_GATE.md`; Mission Control must keep `live_money_readiness.verdicts.live_ready` false after that gate.

- `GET /api/admin/actions`
- `GET /api/admin/actions/:adminActionId`
- `POST /api/admin/actions`
- `POST /api/admin/actions/:adminActionId/approve`
- `POST /api/admin/actions/:adminActionId/reject`
- `POST /api/admin/actions/:adminActionId/execute`

Safe Actions require:

- admin auth
- non-empty reason
- idempotency key
- correlation id
- second approval where required

## Forbidden Actions

The admin plane still blocks:

- manual capture
- manual refund
- admin refund
- merchant refund
- seller refund
- support refund
- partial refund
- manual credit
- manual void
- manual state edit
- manual money state edit
- manual buyer state edit
- manual DB patch
- webhook/outbox/audit deletion
- clear DLQ without repair
- manual payment success
- manual deal completion
- amount/fee/net edits

## Security

- No secrets are returned.
- No raw provider payloads are returned.
- No card data, cookies or authorization headers are returned.
- Payload summaries are masked.
- Sensitive admin actions require session identity, RBAC permission and recent MFA.

## Tests

```bash
npm run test:mission-control
npm run test:admin-control-plane
npm run test:security-hardening
npm run test:frontend-browser-smoke
npx tsc --noEmit
npx tsc -p tsconfig.test.json
```

## Related Docs

- `docs/OBSERVABILITY_CONTRACT.md`
- `docs/ADMIN_CONTROL_PLANE.md`
