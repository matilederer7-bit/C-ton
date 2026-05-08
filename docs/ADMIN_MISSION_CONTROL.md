# Admin Mission Control

Admin Mission Control is Siton's admin-only observability center. It is protected by `x-admin-key`, uses masked data only, and is designed for investigation before intervention.

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
- `security`
- `storage_uploads`
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
- MFA for admin actions is currently unavailable and surfaced as such.

## Tests

```bash
npm run test:mission-control
npm run test:admin-control-plane
npm run test:frontend-browser-smoke
npx tsc --noEmit
npx tsc -p tsconfig.test.json
```

## Related Docs

- `docs/OBSERVABILITY_CONTRACT.md`
- `docs/ADMIN_CONTROL_PLANE.md`
