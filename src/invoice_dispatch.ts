/**
 * Invoice Document Dispatch
 *
 * Provider abstraction for document issuance (receipts, invoices).
 * Mirrors the notification_dispatch pattern: idempotent enqueue, flush loop
 * with SKIP LOCKED, per-row max_attempts, exponential backoff.
 *
 * Provider modes:
 *
 *   "log-only"  — default; logs the document, records as issued with a fake document ID.
 *                  Used in demo/dev. No actual external issuance.
 *
 *   "real"      — activated when a real provider is configured (future).
 *
 *   "disabled"  — throws on every attempt; used to explicitly block issuance.
 *
 * Idempotency: enqueueInvoiceDocument() inserts into siton.invoice_documents
 * with ON CONFLICT DO NOTHING. The UNIQUE constraint on document_key prevents
 * duplicate rows. The flush loop processes pending rows and updates
 * status/issued_at/provider_document_id/last_error.
 *
 * Eligibility rules (enforced by the calling context, documented here):
 *
 *   charge_receipt — issued when a participant reaches DealCompleted state
 *                    (buyer_state = DealCompleted, meaning money_state was
 *                     ChargedSuccess or RecoveredCharge and deal is Completed)
 *
 *   refund_receipt — issued when money_state transitions to Refunded
 *                    (refund_issued webhook received and processed)
 *
 * NOT eligible:
 *   - Dropped participants (charge failed permanently, no money collected)
 *   - DealFailed participants (deal did not complete, charges refunded)
 *   - AuthReleased / ChargeFailedRecovery / other intermediate states
 */

import pg from "pg";

// ─── Provider interface ──────────────────────────────────────────────────────

export type InvoiceProviderMode = "log-only" | "real" | "disabled";

export interface InvoiceDocumentInput {
  documentKey: string;
  documentType: "charge_receipt" | "refund_receipt";
  dealId: string;
  participantId: string;
  dealTitle: string;
  qty: number;
  grossAmount: number;
  sitonFeeAmount: number;
  sellerNetAmount: number;
  affiliateFeeAmount: number;
  moneyStateAtIssue: string;
}

export interface InvoiceProvider {
  readonly providerCode: string;
  readonly mode: InvoiceProviderMode;
  issueDocument(input: InvoiceDocumentInput): Promise<{ documentId: string }>;
}

// ─── Eligibility helpers ─────────────────────────────────────────────────────

/** Buyer states that are eligible for a charge_receipt. */
export const CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES = ["DealCompleted"] as const;

/** Money states that are eligible for a refund_receipt. */
export const REFUND_RECEIPT_ELIGIBLE_MONEY_STATES = ["Refunded"] as const;

/**
 * Returns true if a participant's buyer_state makes them eligible
 * for a charge_receipt document.
 */
export function isEligibleForChargeReceipt(buyerState: string): boolean {
  return (CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES as readonly string[]).includes(buyerState);
}

/**
 * Returns true if a participant's money_state makes them eligible
 * for a refund_receipt document.
 */
export function isEligibleForRefundReceipt(moneyState: string): boolean {
  return (REFUND_RECEIPT_ELIGIBLE_MONEY_STATES as readonly string[]).includes(moneyState);
}

// ─── Log-only provider ───────────────────────────────────────────────────────

class LogOnlyInvoiceProvider implements InvoiceProvider {
  readonly providerCode = "log-only";
  readonly mode: InvoiceProviderMode = "log-only";

  constructor(private logger: Pick<Console, "info"> = console) {}

  async issueDocument(input: InvoiceDocumentInput): Promise<{ documentId: string }> {
    const fakeId = `log-doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.logger.info("[invoice.document.log-only]", {
      documentKey: input.documentKey,
      documentType: input.documentType,
      grossAmount: input.grossAmount,
      documentId: fakeId
    });
    return { documentId: fakeId };
  }
}

// ─── Disabled provider ───────────────────────────────────────────────────────

class DisabledInvoiceProvider implements InvoiceProvider {
  readonly providerCode = "disabled";
  readonly mode: InvoiceProviderMode = "disabled";

  async issueDocument(_input: InvoiceDocumentInput): Promise<{ documentId: string }> {
    throw new Error("invoice_provider_disabled");
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build the invoice provider from environment variables.
 * Falls back to log-only by default.
 * Extend here when a real provider is wired (e.g. invoice SaaS, tax API).
 */
export function buildInvoiceProvider(
  _env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "info" | "error"> = console
): InvoiceProvider {
  // No real provider configured yet — use log-only.
  // When a real provider is activated, add its check here (similar to buildSmsProvider).
  return new LogOnlyInvoiceProvider(logger);
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

export type EnqueueInvoiceParams = {
  documentKey: string;
  documentType: "charge_receipt" | "refund_receipt";
  dealId: string;
  participantId: string;
  dealTitle: string;
  qty: number;
  grossAmount: number;
  sitonFeeAmount: number;
  sellerNetAmount: number;
  affiliateFeeAmount: number;
  moneyStateAtIssue: string;
  providerCode?: string;
};

/**
 * Enqueue an invoice document for issuance.
 * Uses ON CONFLICT DO NOTHING — safe to call multiple times for the same document_key.
 * Can be called with a pg client (inside a transaction) or a pool.
 */
export async function enqueueInvoiceDocument(
  params: EnqueueInvoiceParams,
  db: pg.Pool | pg.PoolClient
): Promise<"queued" | "duplicate"> {
  const result = await db.query(
    `INSERT INTO siton.invoice_documents
       (document_key, document_type, deal_id, participant_id,
        deal_title, qty, money_state_at_issue,
        gross_amount, siton_fee_amount, seller_net_amount, affiliate_fee_amount,
        status, attempt_count, max_attempts, provider_code,
        available_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4,
             $5, $6, $7,
             $8, $9, $10, $11,
             'pending', 0, 3, $12,
             now(), now(), now())
     ON CONFLICT (document_key) DO NOTHING`,
    [
      params.documentKey,
      params.documentType,
      params.dealId,
      params.participantId,
      params.dealTitle,
      params.qty,
      params.moneyStateAtIssue,
      params.grossAmount,
      params.sitonFeeAmount,
      params.sellerNetAmount,
      params.affiliateFeeAmount,
      params.providerCode || "log-only"
    ]
  );

  return (result.rowCount ?? 0) > 0 ? "queued" : "duplicate";
}

// ─── Flush ───────────────────────────────────────────────────────────────────

const INVOICE_BATCH_SIZE = 20;
// Exponential backoff: 30s, 90s, 270s
const RETRY_DELAY_MS = [30_000, 90_000, 270_000];

/**
 * Claim and issue a batch of pending invoice documents.
 * Returns the number of documents processed (issued + failed).
 *
 * This is safe to call concurrently — the UPDATE ... RETURNING uses
 * implicit row-level locking to prevent double-processing.
 */
export async function flushPendingDocuments(
  pool: pg.Pool,
  invoiceProvider: InvoiceProvider,
  logger: Pick<Console, "info" | "error"> = console
): Promise<number> {
  // Claim a batch atomically
  const claimed = await pool.query<{
    document_id: string;
    document_key: string;
    document_type: string;
    deal_id: string;
    participant_id: string;
    deal_title: string;
    qty: number;
    money_state_at_issue: string;
    gross_amount: string;
    siton_fee_amount: string;
    seller_net_amount: string;
    affiliate_fee_amount: string;
    attempt_count: number;
    max_attempts: number;
    provider_code: string;
  }>(
    `UPDATE siton.invoice_documents
     SET status='processing', attempt_count=attempt_count+1, updated_at=now()
     WHERE document_id IN (
       SELECT document_id FROM siton.invoice_documents
       WHERE status='pending' AND available_at <= now()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING document_id, document_key, document_type, deal_id, participant_id,
               deal_title, qty, money_state_at_issue,
               gross_amount, siton_fee_amount, seller_net_amount, affiliate_fee_amount,
               attempt_count, max_attempts, provider_code`,
    [INVOICE_BATCH_SIZE]
  );

  if (claimed.rowCount === 0) return 0;

  let processed = 0;
  for (const row of claimed.rows) {
    try {
      const input: InvoiceDocumentInput = {
        documentKey: row.document_key,
        documentType: row.document_type as "charge_receipt" | "refund_receipt",
        dealId: row.deal_id,
        participantId: row.participant_id,
        dealTitle: row.deal_title,
        qty: Number(row.qty),
        grossAmount: Number(row.gross_amount),
        sitonFeeAmount: Number(row.siton_fee_amount),
        sellerNetAmount: Number(row.seller_net_amount),
        affiliateFeeAmount: Number(row.affiliate_fee_amount),
        moneyStateAtIssue: row.money_state_at_issue
      };

      const result = await invoiceProvider.issueDocument(input);
      const documentId = result.documentId;

      await pool.query(
        `UPDATE siton.invoice_documents
         SET status='issued', provider_document_id=$2, issued_at=now(),
             last_error=NULL, updated_at=now()
         WHERE document_id=$1`,
        [row.document_id, documentId]
      );
      processed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const attemptCount = row.attempt_count;

      if (attemptCount >= row.max_attempts) {
        // Exhausted retries — mark permanently failed
        await pool.query(
          `UPDATE siton.invoice_documents
           SET status='failed', last_error=$2, updated_at=now()
           WHERE document_id=$1`,
          [row.document_id, `max_attempts_exceeded: ${msg}`]
        ).catch(() => undefined);
        logger.error("[invoice.flush] permanent failure", {
          document_id: row.document_id,
          document_key: row.document_key,
          error: msg
        });
      } else {
        // Transient failure — reschedule with backoff
        const delayIdx = Math.min(attemptCount, RETRY_DELAY_MS.length - 1);
        const nextAt = new Date(Date.now() + RETRY_DELAY_MS[delayIdx]!);
        await pool.query(
          `UPDATE siton.invoice_documents
           SET status='pending', last_error=$2, available_at=$3, updated_at=now()
           WHERE document_id=$1`,
          [row.document_id, msg, nextAt.toISOString()]
        ).catch(() => undefined);
        logger.error("[invoice.flush] transient failure, scheduled retry", {
          document_id: row.document_id,
          document_key: row.document_key,
          next_attempt_at: nextAt.toISOString(),
          error: msg
        });
      }
      processed++;
    }
  }

  return processed;
}

// ─── Reclaim stuck processing ────────────────────────────────────────────────

/**
 * Reset invoice_documents rows stuck in 'processing' back to 'pending'.
 *
 * A row gets stuck if the worker process crashed while it held the row in
 * 'processing' status. The flush loop sets updated_at=now() when it claims
 * a row, so `updated_at < now() - timeoutMs` is a safe stuck-detection proxy.
 *
 * Safe to call concurrently — the UPDATE is atomic and the WHERE clause
 * ensures only genuinely old rows are touched.
 *
 * Returns the number of rows reclaimed.
 */
export async function reclaimStuckInvoiceDocuments(
  pool: pg.Pool,
  timeoutMs: number,
  logger: Pick<Console, "warn" | "error"> = console
): Promise<number> {
  const r = await pool.query(
    `UPDATE siton.invoice_documents
     SET status='pending',
         last_error=COALESCE(last_error, 'worker_reclaim_after_restart'),
         available_at=now(),
         updated_at=now()
     WHERE status='processing'
       AND updated_at < now() - ($1::text || ' milliseconds')::interval`,
    [String(timeoutMs)]
  );
  const count = Number(r.rowCount || 0);
  if (count > 0) {
    logger.warn(`[invoice.reclaim] reclaimed ${count} stuck processing invoice document(s)`);
  }
  return count;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export function getInvoiceProviderSummary(provider: InvoiceProvider) {
  return {
    provider: provider.providerCode,
    mode: provider.mode,
    external_issuance: provider.mode === "real"
  };
}
