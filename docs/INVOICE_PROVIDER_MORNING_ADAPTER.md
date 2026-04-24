# Morning / Green Invoice Adapter

## Decision

Siton has a first real invoice-provider adapter named `morning`. The adapter is isolated inside `src/invoice_dispatch.ts`; the canonical invoice rail, outbox flow, idempotency keys, correlation IDs, and money columns stay unchanged.

Canonical fee columns remain:

- `platform_fee_base_amount`
- `platform_fee_vat_amount`
- `platform_fee_total_amount`

## Runtime Activation

Use:

- `INVOICE_PROVIDER=morning`
- `INVOICE_PROVIDER_MODE=real`
- `INVOICE_PROVIDER_BASE_URL`
- `INVOICE_PROVIDER_API_KEY` or `INVOICE_PROVIDER_BEARER_TOKEN`
- `INVOICE_WEBHOOK_SECRET`

`render.yaml` now declares these keys for manual deploy-time activation, but keeps them unset in-repo.

Optional path overrides:

- `INVOICE_PROVIDER_CREATE_PATH`
- `INVOICE_PROVIDER_STATUS_PATH`
- `INVOICE_PROVIDER_CANCEL_PATH`
- `INVOICE_PROVIDER_TIMEOUT_MS`

## Worker Boundary

Invoice document creation, cancel, status lookup, and reconcile stay worker/outbox driven. Request threads may only accept verified invoice webhooks, dedupe them, persist audit rows, and enqueue `invoice_document_reconcile`.

## Webhooks

`POST /webhooks/invoices` verifies the raw request body with HMAC SHA-256 using `INVOICE_WEBHOOK_SECRET`. Accepted signature headers:

- `x-invoice-signature`
- `x-morning-signature`
- `x-greeninvoice-signature`

Webhook dedupe is enforced by `(provider, event_id)` in `invoice_webhook_events`. Invalid signatures are recorded in `invoice_webhook_security_events`.

Late webhooks for terminal invoice documents are ignored. Verified invoice webhooks do not mutate invoice state directly; they only enqueue `invoice_document_reconcile`.

## Mapping

Provider-specific statuses are normalized inside the adapter only. The domain sees only canonical statuses such as `issued`, `failed`, `voided`, and `reconciled`, plus result classes `success`, `permanent_fail`, `temporary_fail`, and `unknown`.

## Fail-Fast Policy

`INVOICE_PROVIDER=morning` with `INVOICE_PROVIDER_MODE=real` now fails fast if any critical value is missing:

- provider base URL
- provider API key or bearer token
- `INVOICE_WEBHOOK_SECRET`

No fallback secret exists for Morning. No secret values are written to logs.

## Observability

`GET /api/admin/invoice-status` now exposes:

- provider activation/config surface
- provider failures by class
- invoice webhook counts
- invoice webhook signature failures
- reconcile backlog

`GET /api/admin/system-status` also exposes the canonical invoice webhook route and aggregate invoice webhook counters.

## What Passed Here

Validated from this environment:

- compile
- Morning adapter issue/status/cancel/reconcile transport against a local HTTP provider stub
- raw-body webhook verification
- webhook dedupe and security-event persistence
- reconcile enqueue-only behavior
- invoice rail compatibility regression
- fail-fast activation checks

## Still External

Not completed from this environment:

- setting real Morning secrets in the deploy platform
- deploying a runtime with those secrets
- hitting the public deployed `/webhooks/invoices`
- validating a real Morning callback against the public URL
- final legal/tax template approval
- production PDF/delivery policy

These steps remain blocked by external access to the deploy platform and the real Morning account secrets.
