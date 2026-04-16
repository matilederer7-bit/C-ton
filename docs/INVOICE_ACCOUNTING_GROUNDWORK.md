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
| Business event integration | `src/app.ts` — `enqueueChargeReceiptForParticipant`, `enqueueRefundReceiptForParticipant` |
| Flush in worker | `src/app.ts` — `workerLoop` → `flushPendingDocuments` |
| Proof tests | `tests/invoice_dispatch_proof.ts` |

The `siton.invoice_documents` table is the canonical truth for all document issuance.
Receipt IDs generated at runtime in the seller surface (`frontend_runtime.ts`) are
display-only and not backed by this table — they are a legacy surface that should
eventually reference this table.

---

## Supported Events

| Business Event | Document Type | Trigger Location |
|----------------|--------------|-----------------|
| Deal completed — charged participant | `charge_receipt` | `handleFinalizeDealEvent` → Completed path, for each DealCompleted participant |
| Refund issued | `refund_receipt` | `applyPaymentWebhookClassification` → `refund_issued` webhook |

---

## Eligibility Rules

### charge_receipt

**Eligible**: `buyer_state = DealCompleted`

This state is only reachable when:
1. The deal reached `Completed` state (threshold met, finalization passed)
2. The participant had `buyer_state` in `{ChargedSuccess, Recovered}` at finalization time

**Not eligible**:
- `DealFailed` — deal did not complete; refunds will be/were issued instead
- `Dropped` — charge failed permanently; no money collected
- `ChargedSuccess` / `RecoveredCharge` — intermediate states (deal not yet finalized)
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
- `charge_receipt:a1b2c3d4-...` — one charge receipt per participant
- `refund_receipt:a1b2c3d4-...` — one refund receipt per participant

The UNIQUE constraint on `document_key` in `siton.invoice_documents` prevents
double-issuance. Calling `enqueueInvoiceDocument` multiple times with the same key
is safe — it returns `"duplicate"` without inserting.

---

## Status Machine

```
pending → processing → issued
                     → failed
                     → skipped  (reserved for future use)
```

| Status | Meaning |
|--------|---------|
| `pending` | Queued, not yet attempted or scheduled for retry |
| `processing` | Claimed by the flush worker (transient — milliseconds) |
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
| `gross_amount` | `qty × price_per_unit` |
| `siton_fee_amount` | `gross × commission_rate` |
| `seller_net_amount` | `gross - siton_fee` |
| `affiliate_fee_amount` | Affiliate commission (0 if no attribution) |

These fields are written once and never updated after the row is created.

---

## Idempotency — No Duplicate Issuance

Four layers prevent duplicate documents:

1. **INSERT ON CONFLICT DO NOTHING** — `enqueueInvoiceDocument` uses `ON CONFLICT (document_key) DO NOTHING`. Concurrent inserts for the same key produce exactly one row.

2. **SKIP LOCKED in flush** — `flushPendingDocuments` uses `SELECT FOR UPDATE SKIP LOCKED`. Two concurrent flush calls cannot claim the same row.

3. **Per-row max_attempts** — The flush reads `max_attempts` from each row (not a hardcoded constant). A row exhausting its attempts is permanently failed; subsequent flush calls skip it.

4. **Calling context gates** — `enqueueChargeReceiptForParticipant` is only called for `DealCompleted` participants. `enqueueRefundReceiptForParticipant` is only called after a confirmed `refund_issued` webhook. The business state machine prevents these events from firing more than once per participant.

5. **Stuck processing reclaim** — `reclaimStuckInvoiceDocuments(pool, timeoutMs)` resets rows that have been stuck in `processing` longer than `timeoutMs` back to `pending`. Called in `workerLoop` every `RECLAIM_EVERY_N_POLLS` cycles alongside `reclaimStuckProcessing`. A reclaimed row can be re-issued by the next flush — the `document_key` UNIQUE constraint and SKIP LOCKED in the flush ensure exactly one issuance, even after a reclaim.

---

## Provider Mode

| Log message | Meaning |
|-------------|---------|
| `[invoice.document.log-only]` | Log-only mode — document is logged to console, `provider_document_id` starts with `log-doc-` |

Default mode is **log-only**. No external provider is configured.

To activate a real provider, extend `buildInvoiceProvider` in `src/invoice_dispatch.ts`
with the provider's credentials (similar to how `buildSmsProvider` activates Twilio).

---

## Retry Backoff Schedule

| Attempt | Delay before next try |
|---------|----------------------|
| 1 (first failure) | 30 seconds |
| 2 | 90 seconds |
| 3+ | 270 seconds |

Default `max_attempts` is 3.

---

## Stuck Processing — Reclaim Behaviour

If a worker process crashes while holding a row in `processing`, `reclaimStuckInvoiceDocuments`
resets it to `pending`. The timing reference is `updated_at`, which is set to `now()` when
the flush claims the row.

- Rows with `updated_at < now() - timeoutMs` → reset to `pending`
- Rows with `updated_at >= now() - timeoutMs` → untouched (still being processed)
- `last_error` is set to `worker_reclaim_after_restart` on first reclaim (preserved if already set)
- Reclaimed rows are available for the next flush cycle and issue exactly once (UNIQUE constraint + SKIP LOCKED)

Default timeout: `WORKER_STUCK_TIMEOUT_MS` (default 60s, same as outbox reclaim).

---

## What Is Still Open

| Item | Status |
|------|--------|
| Real document provider (e.g. invoice SaaS, PDF generation, tax API) | Not wired — `buildInvoiceProvider` extends here |
| Email delivery of issued document to buyer | Not wired — no email column on participants yet |
| Seller surface linking to this table | `frontend_runtime.ts` receipt rows are still computed at runtime, not table-backed |
| deal_cancelled event document path | Not wired — cancel flow triggers `refund_issue` outbox which goes through `refund_receipt` path |
| Tax / VAT fields | Not in scope for groundwork — schema extension point when needed |
| Sequential invoice numbering authority | Not in scope — would require a counter table or external provider |
