# Invoice / Accounting Groundwork

Source of truth and operational reference for the invoice document issuance layer.
This document covers: data model, supported events, eligibility rules, idempotency,
provider modes, and what is still open.

---

## Source of Truth

| Layer | Location |
|-------|----------|
| Table schema | `src/migrations/018_invoice_documents.sql` |
| Dispatch logic | `src/invoice_dispatch.ts` |
| Business event integration | `src/app.ts` - `enqueueChargeReceiptForParticipant`, `enqueueRefundReceiptForParticipant` |
| Flush in worker | `src/app.ts` - `workerLoop` -> `flushPendingDocuments` |
| Proof tests | `tests/invoice_dispatch_proof.ts` |

The `siton.invoice_documents` table is the canonical truth for all document issuance.
Receipt IDs generated at runtime in the seller surface (`frontend_runtime.ts`) are
display-only and not backed by this table - they are a legacy surface that should
eventually reference this table.

---

## Supported Events

| Business Event | Document Type | Trigger Location |
|----------------|--------------|-----------------|
| Deal completed - charged participant | `charge_receipt` | `handleFinalizeDealEvent` -> Completed path, for each DealCompleted participant |
| Refund issued | `refund_receipt` | `applyPaymentWebhookClassification` -> `refund_issued` webhook |

---

## Eligibility Rules

### charge_receipt

**Eligible**: `buyer_state = DealCompleted`

This state is only reachable when:
1. The deal reached `Completed` state
2. The participant had `buyer_state` in `{ChargedSuccess, Recovered}` at finalization time

**Not eligible**:
- `DealFailed` - deal did not complete; refunds will be or were issued instead
- `Dropped` - charge failed permanently; no money collected
- `ChargedSuccess` / `RecoveredCharge` - intermediate states
- Any other state

### refund_receipt

**Eligible**: `money_state = Refunded`

This state is only set by the `refund_issued` webhook, which fires after the payment
provider confirms the refund. The document is enqueued at that point.

**Not eligible**:
- Any state that is not `Refunded`
- Double-refunds are prevented by the `document_key` idempotency constraint

---

## Document Key Format

`{document_type}:{participant_id}`

Examples:
- `charge_receipt:a1b2c3d4-...`
- `refund_receipt:a1b2c3d4-...`

The UNIQUE constraint on `document_key` in `siton.invoice_documents` prevents
double-issuance. Calling `enqueueInvoiceDocument` multiple times with the same key
is safe - it returns `"duplicate"` without inserting.

---

## Status Machine

```text
pending -> processing -> issued
                     -> failed
                     -> skipped
```

| Status | Meaning |
|--------|---------|
| `pending` | Queued, not yet attempted or scheduled for retry |
| `processing` | Claimed by the flush worker |
| `issued` | Successfully issued; `provider_document_id` and `issued_at` are set |
| `failed` | Permanently failed after exhausting `max_attempts`; `last_error` set |
| `skipped` | Reserved; not currently used |

---

## Business Snapshot (Immutable)

Each row captures a point-in-time financial snapshot at issuance:

| Column | Meaning |
|--------|---------|
| `deal_title` | Deal title at time of issuance |
| `qty` | Units purchased |
| `money_state_at_issue` | `ChargedSuccess`, `RecoveredCharge`, or `Refunded` |
| `gross_amount` | `qty * price_per_unit + delivery_cost` |
| `siton_fee_amount` | Total Siton fee charged to the seller: `platform_fee_base + VAT on Siton fee` |
| `seller_net_amount` | `gross - siton_fee_total` |

This grounding follows the canonical money model:

- Siton fee base = `8%` of the charged fee base
- buyer-side VAT is excluded from the fee base
- VAT is added on Siton's fee only
- `platform_fee_total = platform_fee_base + platform_fee_vat`

> Distributor commissions or payouts are not part of this contract. The old
> `affiliate_fee_amount` column was removed in migration 020 - distributors are
> attribution-only per spec.

These fields are written once and never updated after the row is created.

---

## Idempotency - No Duplicate Issuance

Four layers prevent duplicate documents:

1. **INSERT ON CONFLICT DO NOTHING** - `enqueueInvoiceDocument` uses `ON CONFLICT (document_key) DO NOTHING`.
2. **SKIP LOCKED in flush** - `flushPendingDocuments` uses `SELECT FOR UPDATE SKIP LOCKED`.
3. **Per-row max_attempts** - the flush reads `max_attempts` from each row.
4. **Calling context gates** - charge receipts only for completed charged participants, refund receipts only after confirmed `refund_issued`.
5. **Stuck processing reclaim** - `reclaimStuckInvoiceDocuments(pool, timeoutMs)` resets rows stuck in `processing` back to `pending`.

---

## Provider Mode

| Log message | Meaning |
|-------------|---------|
| `[invoice.document.log-only]` | Log-only mode - document is logged to console, `provider_document_id` starts with `log-doc-` |

Default mode is log-only. No external provider is configured.

To activate a real provider, extend `buildInvoiceProvider` in `src/invoice_dispatch.ts`
with the provider credentials.

---

## Retry Backoff Schedule

| Attempt | Delay before next try |
|---------|----------------------|
| 1 | 30 seconds |
| 2 | 90 seconds |
| 3+ | 270 seconds |

Default `max_attempts` is `3`.

---

## Stuck Processing - Reclaim Behaviour

If a worker process crashes while holding a row in `processing`,
`reclaimStuckInvoiceDocuments` resets it to `pending`.

- Rows with `updated_at < now() - timeoutMs` -> reset to `pending`
- Rows with `updated_at >= now() - timeoutMs` -> untouched
- `last_error` is set to `worker_reclaim_after_restart` on first reclaim
- Reclaimed rows are available for the next flush cycle and still issue exactly once

Default timeout: `WORKER_STUCK_TIMEOUT_MS` (default 60s).

---

## What Is Still Open

| Item | Status |
|------|--------|
| Real document provider (invoice SaaS, PDF generation, tax API) | Not wired - `buildInvoiceProvider` extends here |
| Email delivery of issued document to buyer | Not wired - no email column on participants yet |
| Seller surface linking to this table | `frontend_runtime.ts` receipt rows are still computed at runtime, not table-backed |
| `deal_cancelled` event document path | Not wired - cancel flow goes through `refund_receipt` path |
| Buyer-side VAT sourcing | Still explicit/manual input only; no external tax rail connected |
| Siton fee VAT | Internally modeled via `SITON_PLATFORM_FEE_VAT_RATE`; no external tax rail connected |
| Sequential invoice numbering authority | Not in scope - would require a counter table or external provider |
