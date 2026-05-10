# Support Operations

Status: foundation completed for the MVP completion pass. Lifecycle, SLA reporting, audit and Mission Control integration are present. Destructive remediation is not allowed.

## Case Lifecycle

Statuses on `siton.operational_cases`:

- `Open`
- `NeedsSeller`
- `NeedsAdmin`
- `WaitingExternal`
- `Resolved`
- `Closed`

Closing (`Resolved` / `Closed`) requires a non-empty `resolution_note` (DB CHECK constraint). Cases cannot be deleted; evidence is preserved.

## Severity / Priority

`Low` < `Normal` < `High` < `Urgent`. Severity is operator-driven. Critical anomalies flowing through Mission Control open `Urgent` or `High` cases automatically.

## Case Types

```
RefundRequest
DeliveryIssue
SellerRisk
BuyerComplaint
PaymentMismatch
InvoiceIssue
ContentReport
SystemException
Other
```

`RefundRequest` is a legacy internal alias only. It must be treated as `commercial dispute` / `buyer complaint` evidence, not refund eligibility and not refund approval. Support can document a delivery issue, buyer complaint, seller-buyer dispute, chargeback evidence, or payment mismatch. Support cannot execute, approve, enqueue, or trigger a refund.

## Correlation Linking

Each case is linked, where possible, to:

- `deal_id`
- `participant_id`
- `seller_id`
- `correlation_id`
- `request_id`
- `auto_key` — used to dedupe automatically opened cases for the same anomaly

`siton.operational_case_events` carries the audit trail (`case.create`, `case.update_status`, `case.assign`, `case.close`, `case.escalate`). Each event row carries `request_id`, `idempotency_key`, and a JSON payload.

## SLA

SLA is advisory, not auto-enforced:

| Priority | Warning after |
|----------|---------------|
| Urgent   | 4 hours       |
| High     | 24 hours      |
| Normal   | 72 hours      |
| Low      | 7 days        |

Mission Control surfaces the count of breached cases per priority and the overdue case sample.

## Admin Endpoints

- `GET /api/admin/support-cases` — filtered list.
- `POST /api/admin/support-cases` — create with subject, type, priority, optional links, reason.
- `PATCH /api/admin/support-cases/:caseId` — update status / priority / assignee / note (reason recorded).
- `POST /api/admin/support-cases/:caseId/escalate` — set priority to `Urgent` and event `case.escalate`.
- `POST /api/admin/support` — legacy alias.

Closing requires a `resolution_note`. Reason is required on every state change.

## Forbidden Remediations

- Executing a support refund.
- Approving a commercial refund.
- Turning a support case into a refund action.
- Resolving a `PaymentMismatch` by editing money state.
- Deleting a case.
- Deleting case events.
- Editing past event payloads.
- Bypassing the `resolution_note` requirement.

## Mission Control

`mission_control.support_readiness` reports:

- `open` — total open in any non-resolved status
- `urgent_open`, `high_open`
- `overdue_count`
- `sla` per priority — breach count
- `sla_breached_cases` — sample
- `verdict` — `ready` / `warning` / `blocked` (`blocked` only when at least one Urgent case is overdue)

## Validation

- `npm run test:support-operations`
- `npm run test:admin-support-cases`
- `npm run test:mission-control`
