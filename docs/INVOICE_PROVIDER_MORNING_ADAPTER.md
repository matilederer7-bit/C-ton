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

## Mapping

Provider-specific statuses are normalized inside the adapter only. The domain sees only canonical statuses such as `issued`, `failed`, `voided`, and `reconciled`, plus result classes `success`, `permanent_fail`, `temporary_fail`, and `unknown`.

## Still External

Live credentials, final legal/tax template approval, production webhook endpoint validation, and PDF/delivery policy remain deployment activation work.
