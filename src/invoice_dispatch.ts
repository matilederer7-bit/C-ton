import pg from "pg";
import { createHmac, timingSafeEqual } from "crypto";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type InvoiceProviderMode = "internal-truth-only" | "adapter-ready" | "disabled" | "log-only" | "real";
export type InvoiceResultClass = "success" | "permanent_fail" | "temporary_fail" | "unknown";
export type InvoiceDocumentType =
  | "charge_receipt"
  | "refund_receipt"
  | "seller_settlement_invoice"
  | "platform_fee_invoice"
  | "credit_note";
export type InvoiceDocumentStatus =
  | "pending"
  | "ready"
  | "queued"
  | "processing"
  | "issued"
  | "failed"
  | "voided"
  | "reconciled"
  | "skipped";
export type InvoiceAttemptType =
  | "prepare"
  | "create_document"
  | "get_document_status"
  | "cancel_document"
  | "reconcile_document";

export interface InvoiceDocumentInput {
  documentKey: string;
  documentType: InvoiceDocumentType;
  dealId: string;
  participantId: string | null;
  dealTitle: string;
  qty: number;
  grossAmount: number;
  sitonFeeAmount: number;
  sellerNetAmount: number;
  moneyStateAtIssue: string;
  platformFeeBaseAmount?: number;
  platformFeeVatAmount?: number;
  platformFeeTotalAmount?: number;
  sellerSettlementId?: string | null;
  payoutBatchId?: string | null;
  correlationId?: string | null;
}

export type CreateInvoiceDocumentInput = InvoiceDocumentInput & {
  documentId: string;
  idempotencyKey: string;
  providerCode: string;
};

export type GetInvoiceDocumentStatusInput = {
  documentId: string;
  documentKey: string;
  providerDocumentId?: string | null;
  correlationId: string;
};

export type CancelInvoiceDocumentInput = GetInvoiceDocumentStatusInput & {
  reason: string;
};

export type ReconcileInvoiceDocumentInput = GetInvoiceDocumentStatusInput & {
  expectedAmount: number;
  observedAmount: number;
  expectedStatus: InvoiceDocumentStatus;
  observedStatus: InvoiceDocumentStatus;
};

export type ParsedInvoiceWebhookEvent = {
  provider: string;
  event_id: string;
  provider_document_id: string | null;
  document_status: InvoiceDocumentStatus | null;
  correlation_id: string | null;
  document_id: string | null;
  document_key: string | null;
  payload: Record<string, unknown>;
};

export type NormalizedInvoiceResult = {
  provider: string;
  result_class: InvoiceResultClass;
  retryable: boolean;
  document_status: InvoiceDocumentStatus | null;
  provider_document_id?: string | null;
  correlation_id?: string | null;
  external_document_issued: boolean;
  raw?: Record<string, unknown>;
};

export type InvoiceReconciliationResult = NormalizedInvoiceResult & {
  reconciliation_outcome: "matched" | "mismatched";
  observed_amount: number;
  observed_status: InvoiceDocumentStatus;
};

export interface InvoiceProvider {
  readonly providerCode: string;
  readonly mode: InvoiceProviderMode;
  readonly configured?: boolean;
  verifyWebhook?(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  createDocument?(input: CreateInvoiceDocumentInput): Promise<NormalizedInvoiceResult>;
  getDocumentStatus?(input: GetInvoiceDocumentStatusInput): Promise<NormalizedInvoiceResult>;
  cancelDocument?(input: CancelInvoiceDocumentInput): Promise<NormalizedInvoiceResult>;
  reconcileDocument?(input: ReconcileInvoiceDocumentInput): Promise<InvoiceReconciliationResult>;
  parseInvoiceWebhookEvent?(payload: Record<string, unknown>): ParsedInvoiceWebhookEvent;
  issueDocument(input: InvoiceDocumentInput): Promise<{ documentId: string }>;
}

export const CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES = ["DealCompleted"] as const;
export const REFUND_RECEIPT_ELIGIBLE_MONEY_STATES = ["Refunded"] as const;

let ensureInvoiceRailPromise: Promise<void> | null = null;
let ensureInvoiceRailDbPromise: Promise<void> | null = null;

function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeProviderMode(raw: string | undefined): InvoiceProviderMode {
  const value = String(raw || "").trim();
  if (value === "disabled") return "disabled";
  if (value === "real") return "real";
  if (value === "adapter-ready") return "adapter-ready";
  return "internal-truth-only";
}

function normalizeStatus(raw: string): InvoiceDocumentStatus | null {
  const value = String(raw || "").trim().toLowerCase();
  const statuses = ["pending", "ready", "queued", "processing", "issued", "failed", "voided", "reconciled", "skipped"];
  return statuses.includes(value) ? (value as InvoiceDocumentStatus) : null;
}

function classifyInternalModeFailure(anchor: string): InvoiceResultClass {
  const value = String(anchor || "").toLowerCase();
  if (value.includes("permfail")) return "permanent_fail";
  if (value.includes("tempfail")) return "temporary_fail";
  if (value.includes("unknown")) return "unknown";
  return "success";
}

function normalizeProviderBaseUrl(raw: string) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function normalizeProviderPath(raw: string, fallback: string) {
  const value = String(raw || fallback).trim();
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

async function parseJsonSafely(response: Response) {
  const rawText = await response.text();
  if (!rawText.trim()) return {};
  try {
    return JSON.parse(rawText);
  } catch {
    return { raw_body: rawText };
  }
}

function firstStringHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function safeHmacCompare(expected: string, received: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function invoiceResultClassFromHttp(statusCode: number, payload: any): InvoiceResultClass {
  const raw = String(payload?.result_class || payload?.error_class || payload?.classification || "").toLowerCase();
  if (["success", "permanent_fail", "temporary_fail", "unknown"].includes(raw)) return raw as InvoiceResultClass;
  if (statusCode >= 500 || statusCode === 429) return "temporary_fail";
  if (statusCode === 408 || statusCode === 409 || statusCode === 425) return "temporary_fail";
  return "permanent_fail";
}

function normalizeInvoiceStatus(raw: unknown): InvoiceDocumentStatus | null {
  const value = String(raw || "").trim().toLowerCase();
  const aliases: Record<string, InvoiceDocumentStatus> = {
    draft: "processing",
    created: "issued",
    sent: "issued",
    paid: "issued",
    open: "issued",
    active: "issued",
    canceled: "voided",
    cancelled: "voided",
    void: "voided",
    error: "failed"
  };
  return normalizeStatus(aliases[value] || value);
}

function invoiceDocumentAmount(input: CreateInvoiceDocumentInput) {
  if (input.documentType === "platform_fee_invoice" || input.documentType === "seller_settlement_invoice") {
    return roundMoney(input.platformFeeTotalAmount ?? input.sitonFeeAmount);
  }
  return roundMoney(input.grossAmount);
}

function invoiceProviderDocumentType(type: InvoiceDocumentType) {
  const map: Record<InvoiceDocumentType, string> = {
    charge_receipt: "receipt",
    refund_receipt: "refund_receipt",
    seller_settlement_invoice: "invoice",
    platform_fee_invoice: "invoice",
    credit_note: "credit_note"
  };
  return map[type];
}

async function replaceCheckConstraint(c: any, args: {
  tableName: string;
  constraintName: string;
  expectedSnippet: string;
  definitionSql: string;
}) {
  const tableName = args.tableName.replace(/'/g, "''");
  const constraintName = args.constraintName.replace(/'/g, "''");
  const expectedSnippet = args.expectedSnippet.replace(/'/g, "''");
  const definitionSql = args.definitionSql.replace(/'/g, "''");
  await c.query(`
    DO $$
    DECLARE
      v_def text;
    BEGIN
      SELECT pg_get_constraintdef(oid)
      INTO v_def
      FROM pg_constraint
      WHERE conrelid = '${tableName}'::regclass
        AND conname = '${constraintName}';

      IF v_def IS NULL OR position('${expectedSnippet}' in v_def) = 0 THEN
        EXECUTE 'ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName}';
        EXECUTE 'ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definitionSql} NOT VALID';
        EXECUTE 'ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${constraintName}';
      END IF;
    END $$`
  );
}

export async function ensureInvoiceRailTables(withTx: WithTx) {
  if (!ensureInvoiceRailPromise) {
    ensureInvoiceRailPromise = withTx(async (c) => {
      await replaceCheckConstraint(c, {
        tableName: "siton.outbox_events",
        constraintName: "outbox_events_aggregate_type_check",
        expectedSnippet: "invoice_document",
        definitionSql: "CHECK (aggregate_type IN ('deal','participant','seller_payout_batch','invoice_document'))"
      });
      await replaceCheckConstraint(c, {
        tableName: "siton.outbox_events",
        constraintName: "outbox_events_event_type_check",
        expectedSnippet: "invoice_document_reconcile",
        definitionSql: "CHECK (event_type IN ('charge_deal','recovery_deal','finalize_deal','refund_issue','deadline_check','cancel_refund','seller_payout_prepare','seller_payout_dispatch','seller_payout_reconcile','invoice_document_issue','invoice_document_reconcile'))"
      });

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.invoice_documents (
          document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_key TEXT NOT NULL,
          idempotency_key TEXT NULL,
          document_type TEXT NOT NULL,
          document_status TEXT NOT NULL DEFAULT 'pending',
          status TEXT NOT NULL DEFAULT 'pending',
          deal_id UUID NOT NULL,
          participant_id UUID NULL,
          seller_id TEXT NULL,
          seller_settlement_id UUID NULL,
          payout_batch_id UUID NULL,
          platform_fee_money_event_id UUID NULL,
          deal_title TEXT NOT NULL DEFAULT '',
          qty INT NOT NULL DEFAULT 1,
          money_state_at_issue TEXT NOT NULL DEFAULT '',
          gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          siton_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          seller_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          document_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          provider_code TEXT NOT NULL DEFAULT 'internal-invoice-ledger',
          provider_document_id TEXT NULL,
          correlation_id TEXT NULL,
          attempt_count INT NOT NULL DEFAULT 0,
          max_attempts INT NOT NULL DEFAULT 3,
          result_class TEXT NULL,
          external_document_issued BOOLEAN NOT NULL DEFAULT FALSE,
          issued_at TIMESTAMPTZ NULL,
          reconciled_at TIMESTAMPTZ NULL,
          available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_error TEXT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT ux_invoice_documents_key UNIQUE (document_key)
        )
      `);

      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS document_status TEXT NOT NULL DEFAULT 'pending'`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS seller_id TEXT NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS seller_settlement_id UUID NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS payout_batch_id UUID NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_money_event_id UUID NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS document_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS result_class TEXT NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS external_document_issued BOOLEAN NOT NULL DEFAULT FALSE`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL`);
      await c.query(`ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await c.query(`UPDATE siton.invoice_documents SET document_status=status WHERE document_status IS NULL OR document_status=''`);
      await c.query(`UPDATE siton.invoice_documents SET idempotency_key=document_key WHERE idempotency_key IS NULL`);
      await c.query(`UPDATE siton.invoice_documents SET platform_fee_total_amount=siton_fee_amount WHERE platform_fee_total_amount=0 AND siton_fee_amount <> 0`);
      await c.query(`UPDATE siton.invoice_documents SET document_amount=gross_amount WHERE document_amount=0 AND gross_amount <> 0`);
      await c.query(`UPDATE siton.invoice_documents SET taxable_amount=gross_amount WHERE taxable_amount=0 AND gross_amount <> 0`);

      await replaceCheckConstraint(c, {
        tableName: "siton.invoice_documents",
        constraintName: "invoice_documents_document_type_check",
        expectedSnippet: "platform_fee_invoice",
        definitionSql: "CHECK (document_type IN ('charge_receipt','refund_receipt','seller_settlement_invoice','platform_fee_invoice','credit_note'))"
      });
      await replaceCheckConstraint(c, {
        tableName: "siton.invoice_documents",
        constraintName: "invoice_documents_status_check",
        expectedSnippet: "reconciled",
        definitionSql: "CHECK (status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped'))"
      });
      await replaceCheckConstraint(c, {
        tableName: "siton.invoice_documents",
        constraintName: "invoice_documents_document_status_check",
        expectedSnippet: "reconciled",
        definitionSql: "CHECK (document_status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped'))"
      });

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.invoice_document_attempts (
          invoice_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID NOT NULL REFERENCES siton.invoice_documents(document_id) ON DELETE CASCADE,
          attempt_type TEXT NOT NULL,
          result_class TEXT NOT NULL,
          document_status TEXT NULL,
          correlation_id TEXT NOT NULL,
          provider_document_id TEXT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (document_id, attempt_type, correlation_id)
        )
      `);
      await replaceCheckConstraint(c, {
        tableName: "siton.invoice_document_attempts",
        constraintName: "invoice_document_attempts_attempt_type_check",
        expectedSnippet: "reconcile_document",
        definitionSql: "CHECK (attempt_type IN ('prepare','create_document','get_document_status','cancel_document','reconcile_document'))"
      });
      await replaceCheckConstraint(c, {
        tableName: "siton.invoice_document_attempts",
        constraintName: "invoice_document_attempts_result_class_check",
        expectedSnippet: "unknown",
        definitionSql: "CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown'))"
      });
      await replaceCheckConstraint(c, {
        tableName: "siton.invoice_document_attempts",
        constraintName: "invoice_document_attempts_document_status_check",
        expectedSnippet: "reconciled",
        definitionSql: "CHECK (document_status IS NULL OR document_status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped'))"
      });

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.invoice_reconciliation_cases (
          invoice_reconciliation_case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID NOT NULL REFERENCES siton.invoice_documents(document_id) ON DELETE CASCADE,
          case_status TEXT NOT NULL DEFAULT 'open',
          case_type TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          blocking_invoice BOOLEAN NOT NULL DEFAULT TRUE,
          expected_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          observed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          expected_status TEXT NOT NULL DEFAULT '',
          observed_status TEXT NOT NULL DEFAULT '',
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          resolved_at TIMESTAMPTZ NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await replaceCheckConstraint(c, {
        tableName: "siton.invoice_reconciliation_cases",
        constraintName: "invoice_reconciliation_cases_case_status_check",
        expectedSnippet: "resolved",
        definitionSql: "CHECK (case_status IN ('open','resolved'))"
      });

      await c.query(`CREATE INDEX IF NOT EXISTS idx_invoice_documents_pending ON siton.invoice_documents (status, available_at) WHERE status='pending'`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_invoice_documents_deal_created ON siton.invoice_documents (deal_id, created_at DESC)`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_invoice_documents_participant_created ON siton.invoice_documents (participant_id, created_at DESC)`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_invoice_document_attempts_document_created ON siton.invoice_document_attempts (document_id, created_at DESC)`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_invoice_reconciliation_cases_open ON siton.invoice_reconciliation_cases (document_id, created_at DESC)`);
    });
  }
  await ensureInvoiceRailPromise;
}

async function ensureInvoiceRailTablesForDb(db: pg.Pool | pg.PoolClient) {
  if (!ensureInvoiceRailDbPromise) {
    ensureInvoiceRailDbPromise = (async () => {
      await db.query(`
        ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_aggregate_type_check;
        ALTER TABLE siton.outbox_events
          ADD CONSTRAINT outbox_events_aggregate_type_check
          CHECK (aggregate_type IN ('deal','participant','seller_payout_batch','invoice_document'));
        ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
        ALTER TABLE siton.outbox_events
          ADD CONSTRAINT outbox_events_event_type_check
          CHECK (event_type IN ('charge_deal','recovery_deal','finalize_deal','refund_issue','deadline_check','cancel_refund','seller_payout_prepare','seller_payout_dispatch','seller_payout_reconcile','invoice_document_issue','invoice_document_reconcile'));
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS document_status TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS seller_id TEXT NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS seller_settlement_id UUID NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS payout_batch_id UUID NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_money_event_id UUID NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS document_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS result_class TEXT NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS external_document_issued BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL;
        ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
        UPDATE siton.invoice_documents SET document_status=status WHERE document_status IS NULL OR document_status='';
        UPDATE siton.invoice_documents SET idempotency_key=document_key WHERE idempotency_key IS NULL;
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS siton.invoice_document_attempts (
          invoice_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID NOT NULL REFERENCES siton.invoice_documents(document_id) ON DELETE CASCADE,
          attempt_type TEXT NOT NULL CHECK (attempt_type IN ('prepare','create_document','get_document_status','cancel_document','reconcile_document')),
          result_class TEXT NOT NULL CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
          document_status TEXT NULL,
          correlation_id TEXT NOT NULL,
          provider_document_id TEXT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (document_id, attempt_type, correlation_id)
        );
        CREATE TABLE IF NOT EXISTS siton.invoice_reconciliation_cases (
          invoice_reconciliation_case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID NOT NULL REFERENCES siton.invoice_documents(document_id) ON DELETE CASCADE,
          case_status TEXT NOT NULL DEFAULT 'open' CHECK (case_status IN ('open','resolved')),
          case_type TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          blocking_invoice BOOLEAN NOT NULL DEFAULT TRUE,
          expected_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          observed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          expected_status TEXT NOT NULL DEFAULT '',
          observed_status TEXT NOT NULL DEFAULT '',
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          resolved_at TIMESTAMPTZ NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
    })();
  }
  await ensureInvoiceRailDbPromise;
}

export function isEligibleForChargeReceipt(buyerState: string): boolean {
  return (CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES as readonly string[]).includes(buyerState);
}

export function isEligibleForRefundReceipt(moneyState: string): boolean {
  return (REFUND_RECEIPT_ELIGIBLE_MONEY_STATES as readonly string[]).includes(moneyState);
}

class InternalInvoiceProvider implements InvoiceProvider {
  readonly providerCode: string;
  readonly mode: InvoiceProviderMode;
  readonly configured: boolean;

  constructor(
    providerCode: string,
    mode: InvoiceProviderMode,
    private logger: Pick<Console, "info" | "error"> = console
  ) {
    this.providerCode = providerCode;
    this.mode = mode === "real" || mode === "log-only" ? "internal-truth-only" : mode;
    this.configured = this.mode !== "disabled";
  }

  async createDocument(input: CreateInvoiceDocumentInput): Promise<NormalizedInvoiceResult> {
    if (this.mode === "disabled") {
      return {
        provider: this.providerCode,
        result_class: "permanent_fail",
        retryable: false,
        document_status: "failed",
        provider_document_id: null,
        correlation_id: input.correlationId ?? null,
        external_document_issued: false,
        raw: { reason: "invoice_provider_disabled" }
      };
    }
    const resultClass = classifyInternalModeFailure(input.documentKey);
    const providerDocumentId = `internal-invoice:${input.documentId}`;
    this.logger.info("[invoice.document.internal-truth-only]", {
      document_key: input.documentKey,
      document_type: input.documentType,
      document_amount: input.grossAmount,
      provider_document_id: providerDocumentId
    });
    return {
      provider: this.providerCode,
      result_class: resultClass,
      retryable: resultClass === "temporary_fail" || resultClass === "unknown",
      document_status: resultClass === "success" ? "issued" : resultClass === "permanent_fail" ? "failed" : "processing",
      provider_document_id: providerDocumentId,
      correlation_id: input.correlationId ?? null,
      external_document_issued: false,
      raw: {
        mode: "internal-truth-only",
        document_type: input.documentType,
        gross_amount: input.grossAmount,
        platform_fee_total_amount: input.platformFeeTotalAmount ?? input.sitonFeeAmount
      }
    };
  }

  async getDocumentStatus(input: GetInvoiceDocumentStatusInput): Promise<NormalizedInvoiceResult> {
    return {
      provider: this.providerCode,
      result_class: "success",
      retryable: false,
      document_status: "issued",
      provider_document_id: input.providerDocumentId ?? `internal-invoice:${input.documentId}`,
      correlation_id: input.correlationId,
      external_document_issued: false,
      raw: { mode: "internal-truth-only" }
    };
  }

  async cancelDocument(input: CancelInvoiceDocumentInput): Promise<NormalizedInvoiceResult> {
    return {
      provider: this.providerCode,
      result_class: "success",
      retryable: false,
      document_status: "voided",
      provider_document_id: input.providerDocumentId ?? `internal-invoice:${input.documentId}`,
      correlation_id: input.correlationId,
      external_document_issued: false,
      raw: { mode: "internal-truth-only", reason: input.reason }
    };
  }

  async reconcileDocument(input: ReconcileInvoiceDocumentInput): Promise<InvoiceReconciliationResult> {
    const matched =
      roundMoney(input.expectedAmount) === roundMoney(input.observedAmount)
      && input.expectedStatus === input.observedStatus;
    return {
      provider: this.providerCode,
      result_class: "success",
      retryable: false,
      document_status: matched ? "reconciled" : "failed",
      provider_document_id: input.providerDocumentId ?? `internal-invoice:${input.documentId}`,
      correlation_id: input.correlationId,
      external_document_issued: false,
      reconciliation_outcome: matched ? "matched" : "mismatched",
      observed_amount: roundMoney(input.observedAmount),
      observed_status: input.observedStatus,
      raw: {
        mode: "internal-truth-only",
        expected_amount: roundMoney(input.expectedAmount),
        observed_amount: roundMoney(input.observedAmount)
      }
    };
  }

  parseInvoiceWebhookEvent(payload: Record<string, unknown>): ParsedInvoiceWebhookEvent {
    return {
      provider: this.providerCode,
      event_id: String(payload.event_id || payload.id || `internal-invoice-event:${Date.now()}`),
      provider_document_id: String(payload.provider_document_id || payload.document_id || "").trim() || null,
      document_status: normalizeStatus(String(payload.document_status || payload.status || "")),
      correlation_id: String(payload.correlation_id || "").trim() || null,
      document_id: String(payload.document_id || "").trim() || null,
      document_key: String(payload.document_key || "").trim() || null,
      payload
    };
  }

  async issueDocument(input: InvoiceDocumentInput): Promise<{ documentId: string }> {
    const result = await this.createDocument({
      ...input,
      documentId: input.correlationId || input.documentKey,
      idempotencyKey: input.documentKey,
      providerCode: this.providerCode
    });
    if (result.result_class !== "success") {
      throw new Error(`invoice_provider_${result.result_class}`);
    }
    return { documentId: result.provider_document_id || `internal-invoice:${input.documentKey}` };
  }
}

class MorningInvoiceProvider implements InvoiceProvider {
  readonly providerCode = "morning";
  readonly mode: InvoiceProviderMode;
  readonly configured: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly bearerToken: string;
  private readonly webhookSecret: string;
  private readonly timeoutMs: number;
  private readonly createPath: string;
  private readonly statusPath: string;
  private readonly cancelPath: string;

  constructor(private env: NodeJS.ProcessEnv = process.env) {
    this.mode = normalizeProviderMode(env.INVOICE_PROVIDER_MODE || env.INVOICE_PROVIDER_TRANSPORT_MODE || "real");
    this.baseUrl = normalizeProviderBaseUrl(env.INVOICE_PROVIDER_BASE_URL || "https://api.greeninvoice.co.il/api/v1");
    this.apiKey = String(env.INVOICE_PROVIDER_API_KEY || "").trim();
    this.bearerToken = String(env.INVOICE_PROVIDER_BEARER_TOKEN || env.INVOICE_PROVIDER_ACCESS_TOKEN || "").trim();
    this.webhookSecret = String(env.INVOICE_WEBHOOK_SECRET || "").trim();
    this.timeoutMs = Number(env.INVOICE_PROVIDER_TIMEOUT_MS || 8000);
    this.createPath = normalizeProviderPath(env.INVOICE_PROVIDER_CREATE_PATH || "", "/documents");
    this.statusPath = normalizeProviderPath(env.INVOICE_PROVIDER_STATUS_PATH || "", "/documents/{provider_document_id}");
    this.cancelPath = normalizeProviderPath(env.INVOICE_PROVIDER_CANCEL_PATH || "", "/documents/{provider_document_id}/cancel");
    this.configured = Boolean(this.baseUrl && (this.apiKey || this.bearerToken));
    if (this.mode === "real" && !this.configured) {
      throw new Error("INVOICE_PROVIDER=morning requires INVOICE_PROVIDER_BASE_URL and INVOICE_PROVIDER_API_KEY or INVOICE_PROVIDER_BEARER_TOKEN in real mode");
    }
  }

  private headers(idempotencyKey: string, correlationId: string) {
    const authorizationToken = this.bearerToken || this.apiKey;
    return {
      authorization: `Bearer ${authorizationToken}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-correlation-id": correlationId
    };
  }

  private async post(path: string, body: Record<string, unknown>, idempotencyKey: string, correlationId: string) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(idempotencyKey, correlationId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await parseJsonSafely(response);
    return { response, payload };
  }

  private async get(path: string, idempotencyKey: string, correlationId: string) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(idempotencyKey, correlationId),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await parseJsonSafely(response);
    return { response, payload };
  }

  private normalizeProviderDocumentId(payload: any) {
    return String(payload?.provider_document_id || payload?.document_id || payload?.id || payload?.data?.id || "").trim() || null;
  }

  private normalizeResult(payload: any, statusCode: number, fallbackStatus: InvoiceDocumentStatus | null, correlationId: string): NormalizedInvoiceResult {
    const resultClass = statusCode >= 200 && statusCode < 300
      ? invoiceResultClassFromHttp(statusCode, { result_class: payload?.result_class || "success" })
      : invoiceResultClassFromHttp(statusCode, payload);
    const documentStatus = normalizeInvoiceStatus(payload?.document_status || payload?.status || payload?.data?.status) || fallbackStatus;
    return {
      provider: this.providerCode,
      result_class: resultClass,
      retryable: resultClass === "temporary_fail" || resultClass === "unknown",
      document_status: resultClass === "success" ? (documentStatus || "issued") : resultClass === "permanent_fail" ? "failed" : "processing",
      provider_document_id: this.normalizeProviderDocumentId(payload),
      correlation_id: String(payload?.correlation_id || correlationId),
      external_document_issued: resultClass === "success",
      raw: {
        provider: this.providerCode,
        status_code: statusCode,
        payload
      }
    };
  }

  async createDocument(input: CreateInvoiceDocumentInput): Promise<NormalizedInvoiceResult> {
    const amount = invoiceDocumentAmount(input);
    const payload = {
      provider: this.providerCode,
      document_type: invoiceProviderDocumentType(input.documentType),
      siton_document_type: input.documentType,
      document_key: input.documentKey,
      document_id: input.documentId,
      correlation_id: input.correlationId,
      currency: this.env.INVOICE_PROVIDER_CURRENCY || "ILS",
      amount,
      gross_amount: roundMoney(input.grossAmount),
      taxable_amount: amount,
      platform_fee_base_amount: roundMoney(input.platformFeeBaseAmount ?? 0),
      platform_fee_vat_amount: roundMoney(input.platformFeeVatAmount ?? 0),
      platform_fee_total_amount: roundMoney(input.platformFeeTotalAmount ?? input.sitonFeeAmount),
      seller_net_amount: roundMoney(input.sellerNetAmount),
      deal_id: input.dealId,
      participant_id: input.participantId,
      description: input.dealTitle,
      quantity: input.qty
    };
    try {
      const { response, payload: responsePayload } = await this.post(
        this.createPath,
        payload,
        input.idempotencyKey,
        input.correlationId || input.idempotencyKey
      );
      return this.normalizeResult(responsePayload, response.status, "issued", input.correlationId || input.idempotencyKey);
    } catch (error: any) {
      return {
        provider: this.providerCode,
        result_class: "temporary_fail",
        retryable: true,
        document_status: "processing",
        provider_document_id: null,
        correlation_id: input.correlationId ?? null,
        external_document_issued: false,
        raw: { error: String(error?.message || error) }
      };
    }
  }

  async getDocumentStatus(input: GetInvoiceDocumentStatusInput): Promise<NormalizedInvoiceResult> {
    const providerDocumentId = String(input.providerDocumentId || "").trim();
    if (!providerDocumentId) {
      return {
        provider: this.providerCode,
        result_class: "permanent_fail",
        retryable: false,
        document_status: "failed",
        provider_document_id: null,
        correlation_id: input.correlationId,
        external_document_issued: false,
        raw: { error: "provider_document_id_required" }
      };
    }
    try {
      const path = this.statusPath.replace("{provider_document_id}", encodeURIComponent(providerDocumentId));
      const { response, payload } = await this.get(path, `status:${input.documentKey}`, input.correlationId);
      return {
        ...this.normalizeResult(payload, response.status, "issued", input.correlationId),
        provider_document_id: this.normalizeProviderDocumentId(payload) || providerDocumentId
      };
    } catch (error: any) {
      return {
        provider: this.providerCode,
        result_class: "temporary_fail",
        retryable: true,
        document_status: "processing",
        provider_document_id: providerDocumentId,
        correlation_id: input.correlationId,
        external_document_issued: false,
        raw: { error: String(error?.message || error) }
      };
    }
  }

  async cancelDocument(input: CancelInvoiceDocumentInput): Promise<NormalizedInvoiceResult> {
    const providerDocumentId = String(input.providerDocumentId || "").trim();
    if (!providerDocumentId) {
      return {
        provider: this.providerCode,
        result_class: "permanent_fail",
        retryable: false,
        document_status: "failed",
        provider_document_id: null,
        correlation_id: input.correlationId,
        external_document_issued: false,
        raw: { error: "provider_document_id_required" }
      };
    }
    try {
      const path = this.cancelPath.replace("{provider_document_id}", encodeURIComponent(providerDocumentId));
      const { response, payload } = await this.post(path, { reason: input.reason }, `cancel:${input.documentKey}`, input.correlationId);
      return {
        ...this.normalizeResult(payload, response.status, "voided", input.correlationId),
        provider_document_id: this.normalizeProviderDocumentId(payload) || providerDocumentId
      };
    } catch (error: any) {
      return {
        provider: this.providerCode,
        result_class: "temporary_fail",
        retryable: true,
        document_status: "processing",
        provider_document_id: providerDocumentId,
        correlation_id: input.correlationId,
        external_document_issued: false,
        raw: { error: String(error?.message || error) }
      };
    }
  }

  async reconcileDocument(input: ReconcileInvoiceDocumentInput): Promise<InvoiceReconciliationResult> {
    const status = await this.getDocumentStatus(input);
    const observedStatus = status.document_status || "failed";
    const rawAmount = (status.raw as any)?.payload?.amount ?? (status.raw as any)?.payload?.document_amount ?? input.observedAmount;
    const observedAmount = roundMoney(Number(rawAmount || 0));
    const matched = status.result_class === "success"
      && roundMoney(input.expectedAmount) === observedAmount
      && input.expectedStatus === observedStatus;
    return {
      ...status,
      document_status: matched ? "reconciled" : "failed",
      reconciliation_outcome: matched ? "matched" : "mismatched",
      observed_amount: observedAmount,
      observed_status: observedStatus
    };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.webhookSecret) return false;
    const signature = firstStringHeader(headers["x-invoice-signature"])
      || firstStringHeader(headers["x-morning-signature"])
      || firstStringHeader(headers["x-greeninvoice-signature"]);
    if (!signature) return false;
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const normalized = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
    return safeHmacCompare(expected, normalized);
  }

  parseInvoiceWebhookEvent(payload: Record<string, unknown>): ParsedInvoiceWebhookEvent {
    const data = (payload.data && typeof payload.data === "object" ? payload.data : {}) as Record<string, unknown>;
    return {
      provider: this.providerCode,
      event_id: String(payload.event_id || payload.id || data.event_id || data.id || "").trim() || `morning:${Date.now()}`,
      provider_document_id: String(payload.provider_document_id || payload.document_id || data.provider_document_id || data.document_id || data.id || "").trim() || null,
      document_status: normalizeInvoiceStatus(payload.document_status || payload.status || data.document_status || data.status),
      correlation_id: String(payload.correlation_id || data.correlation_id || "").trim() || null,
      document_id: String(payload.siton_document_id || payload.document_uuid || data.siton_document_id || data.document_uuid || "").trim() || null,
      document_key: String(payload.document_key || data.document_key || "").trim() || null,
      payload
    };
  }

  async issueDocument(input: InvoiceDocumentInput): Promise<{ documentId: string }> {
    const result = await this.createDocument({
      ...input,
      documentId: input.correlationId || input.documentKey,
      idempotencyKey: input.documentKey,
      providerCode: this.providerCode
    });
    if (result.result_class !== "success" || !result.provider_document_id) {
      throw new Error(`invoice_provider_${result.result_class}`);
    }
    return { documentId: result.provider_document_id };
  }
}

export function buildInvoiceProvider(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "info" | "error"> = console
): InvoiceProvider {
  const providerCode = env.INVOICE_PROVIDER || "internal-invoice-ledger";
  const mode = normalizeProviderMode(env.INVOICE_PROVIDER_MODE || env.INVOICE_PROVIDER_TRANSPORT_MODE);
  if (["morning", "greeninvoice", "green-invoice"].includes(String(providerCode).trim().toLowerCase())) {
    return new MorningInvoiceProvider(env);
  }
  return new InternalInvoiceProvider(providerCode, mode, logger);
}

export type EnqueueInvoiceParams = {
  documentKey: string;
  documentType: InvoiceDocumentType;
  dealId: string;
  participantId?: string | null;
  dealTitle: string;
  qty: number;
  grossAmount: number;
  sitonFeeAmount: number;
  sellerNetAmount: number;
  moneyStateAtIssue: string;
  providerCode?: string;
  platformFeeBaseAmount?: number;
  platformFeeVatAmount?: number;
  platformFeeTotalAmount?: number;
  sellerSettlementId?: string | null;
  payoutBatchId?: string | null;
  platformFeeMoneyEventId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function enqueueInvoiceDocument(
  params: EnqueueInvoiceParams,
  db: pg.Pool | pg.PoolClient
): Promise<"queued" | "duplicate"> {
  await ensureInvoiceRailTablesForDb(db);
  const correlationId = params.correlationId || `invoice-document:${params.documentKey}`;
  const providerCode = params.providerCode || process.env.INVOICE_PROVIDER || "internal-invoice-ledger";
  const platformFeeTotal = roundMoney(params.platformFeeTotalAmount ?? params.sitonFeeAmount);
  const result = await db.query(
    `INSERT INTO siton.invoice_documents
       (document_key, idempotency_key, document_type, document_status, status,
        deal_id, participant_id, seller_settlement_id, payout_batch_id, platform_fee_money_event_id,
        deal_title, qty, money_state_at_issue,
        gross_amount, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount,
        siton_fee_amount, seller_net_amount, taxable_amount, document_amount,
        provider_code, correlation_id, attempt_count, max_attempts,
        available_at, metadata, created_at, updated_at)
     VALUES ($1,$1,$2,'pending','pending',
             $3,$4,$5,$6,$7,
             $8,$9,$10,
             $11,$12,$13,$14,
             $14,$15,$11,$11,
             $16,$17,0,3,
             now(),$18,now(),now())
     ON CONFLICT (document_key) DO NOTHING
     RETURNING document_id`,
    [
      params.documentKey,
      params.documentType,
      params.dealId,
      params.participantId ?? null,
      params.sellerSettlementId ?? null,
      params.payoutBatchId ?? null,
      params.platformFeeMoneyEventId ?? null,
      params.dealTitle,
      params.qty,
      params.moneyStateAtIssue,
      roundMoney(params.grossAmount),
      roundMoney(params.platformFeeBaseAmount ?? 0),
      roundMoney(params.platformFeeVatAmount ?? 0),
      platformFeeTotal,
      roundMoney(params.sellerNetAmount),
      providerCode,
      correlationId,
      JSON.stringify(params.metadata ?? {})
    ]
  );

  if ((result.rowCount ?? 0) === 0) return "duplicate";
  const documentId = String(result.rows[0].document_id);
  await insertInvoiceOutboxIfMissing(db, documentId, {
    document_id: documentId,
    document_key: params.documentKey,
    document_type: params.documentType,
    deal_id: params.dealId,
    participant_id: params.participantId ?? null,
    correlation_id: correlationId
  });
  await recordInvoiceAttempt(db, {
    document_id: documentId,
    attempt_type: "prepare",
    result_class: "success",
    document_status: "pending",
    correlation_id: correlationId,
    payload: { document_key: params.documentKey, document_type: params.documentType }
  });
  return "queued";
}

async function insertInvoiceOutboxIfMissing(db: pg.Pool | pg.PoolClient, documentId: string, payload: Record<string, unknown>) {
  const existing = await db.query(
    `SELECT event_uuid
     FROM siton.outbox_events
     WHERE event_type='invoice_document_issue'
       AND aggregate_type='invoice_document'
       AND aggregate_id=$1
       AND status IN ('pending','processing','sent')
     LIMIT 1`,
    [documentId]
  );
  if (existing.rowCount) return false;
  await db.query(
    `INSERT INTO siton.outbox_events
       (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('invoice_document_issue','invoice_document',$1,$2,'pending',0,now())`,
    [documentId, JSON.stringify(payload)]
  );
  return true;
}

async function recordInvoiceAttempt(db: pg.Pool | pg.PoolClient, args: {
  document_id: string;
  attempt_type: InvoiceAttemptType;
  result_class: InvoiceResultClass;
  document_status: InvoiceDocumentStatus | null;
  correlation_id: string;
  provider_document_id?: string | null;
  payload?: Record<string, unknown>;
}) {
  await db.query(
    `INSERT INTO siton.invoice_document_attempts
       (document_id, attempt_type, result_class, document_status, correlation_id, provider_document_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (document_id, attempt_type, correlation_id) DO UPDATE
     SET result_class=EXCLUDED.result_class,
         document_status=EXCLUDED.document_status,
         provider_document_id=EXCLUDED.provider_document_id,
         payload=EXCLUDED.payload`,
    [
      args.document_id,
      args.attempt_type,
      args.result_class,
      args.document_status,
      args.correlation_id,
      args.provider_document_id ?? null,
      JSON.stringify(args.payload ?? {})
    ]
  );
}

async function loadInvoiceDocument(db: pg.Pool | pg.PoolClient, documentId: string) {
  const row = await db.query(
    `SELECT *
     FROM siton.invoice_documents
     WHERE document_id=$1
     LIMIT 1`,
    [documentId]
  );
  return row.rows[0] ?? null;
}

export async function processInvoiceDocumentById(args: {
  pool: pg.Pool;
  invoiceProvider: InvoiceProvider;
  documentId: string;
  eventId: string;
}): Promise<{ status: InvoiceDocumentStatus | "not_found" | "skipped"; result_class?: InvoiceResultClass }> {
  await ensureInvoiceRailTablesForDb(args.pool);
  const document = await loadInvoiceDocument(args.pool, args.documentId);
  if (!document) return { status: "not_found" };
  const currentStatus = String(document.status || document.document_status || "");
  if (["issued", "reconciled", "voided", "skipped"].includes(currentStatus)) {
    return { status: currentStatus as InvoiceDocumentStatus };
  }

  const correlationId = `invoice-document-create:${args.documentId}:${args.eventId}`;
  await args.pool.query(
    `UPDATE siton.invoice_documents
     SET status='processing',
         document_status='processing',
         attempt_count=attempt_count+1,
         correlation_id=$2,
         updated_at=now()
     WHERE document_id=$1`,
    [args.documentId, correlationId]
  );

  const createInput = {
    documentId: String(document.document_id),
    documentKey: String(document.document_key),
    idempotencyKey: String(document.idempotency_key || document.document_key),
    providerCode: args.invoiceProvider.providerCode,
    documentType: String(document.document_type) as InvoiceDocumentType,
    dealId: String(document.deal_id),
    participantId: document.participant_id ? String(document.participant_id) : null,
    dealTitle: String(document.deal_title || ""),
    qty: Number(document.qty || 0),
    grossAmount: roundMoney(Number(document.gross_amount || 0)),
    sitonFeeAmount: roundMoney(Number(document.siton_fee_amount || document.platform_fee_total_amount || 0)),
    sellerNetAmount: roundMoney(Number(document.seller_net_amount || 0)),
    moneyStateAtIssue: String(document.money_state_at_issue || ""),
    platformFeeBaseAmount: roundMoney(Number(document.platform_fee_base_amount || 0)),
    platformFeeVatAmount: roundMoney(Number(document.platform_fee_vat_amount || 0)),
    platformFeeTotalAmount: roundMoney(Number(document.platform_fee_total_amount || document.siton_fee_amount || 0)),
    sellerSettlementId: document.seller_settlement_id ? String(document.seller_settlement_id) : null,
    payoutBatchId: document.payout_batch_id ? String(document.payout_batch_id) : null,
    correlationId
  };
  const result = args.invoiceProvider.createDocument
    ? await args.invoiceProvider.createDocument(createInput)
    : {
        provider: args.invoiceProvider.providerCode,
        result_class: "success" as const,
        retryable: false,
        document_status: "issued" as const,
        provider_document_id: (await args.invoiceProvider.issueDocument(createInput)).documentId,
        correlation_id: correlationId,
        external_document_issued: args.invoiceProvider.mode === "real",
        raw: { compatibility_path: "issueDocument" }
      };

  await recordInvoiceAttempt(args.pool, {
    document_id: args.documentId,
    attempt_type: "create_document",
    result_class: result.result_class,
    document_status: result.document_status,
    correlation_id: correlationId,
    provider_document_id: result.provider_document_id ?? null,
    payload: result.raw ?? {}
  });

  if (result.result_class === "success") {
    await args.pool.query(
      `UPDATE siton.invoice_documents
       SET status='issued',
           document_status='issued',
           provider_document_id=$2,
           result_class=$3,
           external_document_issued=$4,
           issued_at=now(),
           last_error=NULL,
           updated_at=now()
       WHERE document_id=$1`,
      [args.documentId, result.provider_document_id ?? null, result.result_class, result.external_document_issued]
    );
    await insertInvoiceReconcileOutboxIfMissing(args.pool, args.documentId, {
      document_id: args.documentId,
      document_key: String(document.document_key),
      correlation_id: correlationId
    });
    return { status: "issued", result_class: result.result_class };
  }

  if (result.result_class === "permanent_fail") {
    await args.pool.query(
      `UPDATE siton.invoice_documents
       SET status='failed',
           document_status='failed',
           result_class=$2,
           last_error=$3,
           updated_at=now()
       WHERE document_id=$1`,
      [args.documentId, result.result_class, "invoice_create_permanent_fail"]
    );
    return { status: "failed", result_class: result.result_class };
  }

  await args.pool.query(
    `UPDATE siton.invoice_documents
     SET status='pending',
         document_status='pending',
         result_class=$2,
         last_error=$3,
         available_at=now() + interval '30 seconds',
         updated_at=now()
     WHERE document_id=$1`,
    [args.documentId, result.result_class, `invoice_create_${result.result_class}`]
  );
  throw new Error(`invoice_create_${result.result_class}`);
}

async function insertInvoiceReconcileOutboxIfMissing(db: pg.Pool | pg.PoolClient, documentId: string, payload: Record<string, unknown>) {
  const existing = await db.query(
    `SELECT event_uuid
     FROM siton.outbox_events
     WHERE event_type='invoice_document_reconcile'
       AND aggregate_type='invoice_document'
       AND aggregate_id=$1
       AND status IN ('pending','processing','sent')
     LIMIT 1`,
    [documentId]
  );
  if (existing.rowCount) return false;
  await db.query(
    `INSERT INTO siton.outbox_events
       (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('invoice_document_reconcile','invoice_document',$1,$2,'pending',0,now())`,
    [documentId, JSON.stringify(payload)]
  );
  return true;
}

export async function reconcileInvoiceDocumentById(args: {
  pool: pg.Pool;
  invoiceProvider: InvoiceProvider;
  documentId: string;
  eventId: string;
}): Promise<{ status: InvoiceDocumentStatus | "not_found"; result_class?: InvoiceResultClass }> {
  await ensureInvoiceRailTablesForDb(args.pool);
  const document = await loadInvoiceDocument(args.pool, args.documentId);
  if (!document) return { status: "not_found" };
  const correlationId = `invoice-document-reconcile:${args.documentId}:${args.eventId}`;
  const expectedAmount = roundMoney(Number(document.document_amount || document.gross_amount || 0));
  const observedAmount = roundMoney(Number(document.gross_amount || 0));
  const observedStatus = String(document.provider_document_id || "").trim() ? "issued" : "failed";
  const reconcileInput = {
    documentId: args.documentId,
    documentKey: String(document.document_key),
    providerDocumentId: document.provider_document_id ? String(document.provider_document_id) : null,
    correlationId,
    expectedAmount,
    observedAmount,
    expectedStatus: "issued",
    observedStatus
  } satisfies ReconcileInvoiceDocumentInput;
  const result = args.invoiceProvider.reconcileDocument
    ? await args.invoiceProvider.reconcileDocument(reconcileInput)
    : {
        provider: args.invoiceProvider.providerCode,
        result_class: "success" as const,
        retryable: false,
        document_status: "reconciled" as const,
        provider_document_id: reconcileInput.providerDocumentId,
        correlation_id: correlationId,
        external_document_issued: args.invoiceProvider.mode === "real",
        reconciliation_outcome: "matched" as const,
        observed_amount: observedAmount,
        observed_status: observedStatus,
        raw: { compatibility_path: "issueDocument" }
      };

  await recordInvoiceAttempt(args.pool, {
    document_id: args.documentId,
    attempt_type: "reconcile_document",
    result_class: result.result_class,
    document_status: result.document_status,
    correlation_id: correlationId,
    provider_document_id: result.provider_document_id ?? null,
    payload: result.raw ?? {}
  });

  if (result.reconciliation_outcome === "matched") {
    await args.pool.query(
      `UPDATE siton.invoice_documents
       SET status='reconciled',
           document_status='reconciled',
           reconciled_at=now(),
           last_error=NULL,
           updated_at=now()
       WHERE document_id=$1`,
      [args.documentId]
    );
    await args.pool.query(
      `UPDATE siton.invoice_reconciliation_cases
       SET case_status='resolved',
           resolved_at=now()
       WHERE document_id=$1
         AND case_status='open'`,
      [args.documentId]
    );
    return { status: "reconciled", result_class: result.result_class };
  }

  await args.pool.query(
    `UPDATE siton.invoice_documents
     SET status='failed',
         document_status='failed',
         last_error='invoice_reconciliation_mismatch',
         updated_at=now()
     WHERE document_id=$1`,
    [args.documentId]
  );
  await args.pool.query(
    `INSERT INTO siton.invoice_reconciliation_cases
       (document_id, case_status, case_type, correlation_id, blocking_invoice,
        expected_amount, observed_amount, expected_status, observed_status, details)
     VALUES ($1,'open','amount_or_status_mismatch',$2,true,$3,$4,$5,$6,$7)`,
    [
      args.documentId,
      correlationId,
      expectedAmount,
      result.observed_amount,
      "issued",
      result.observed_status,
      JSON.stringify(result.raw ?? {})
    ]
  );
  return { status: "failed", result_class: result.result_class };
}

export async function enqueuePendingInvoiceDocumentOutboxEvents(pool: pg.Pool, limit = 20): Promise<number> {
  await ensureInvoiceRailTablesForDb(pool);
  const rows = await pool.query(
    `SELECT document_id, document_key, document_type, deal_id, participant_id, correlation_id
     FROM siton.invoice_documents d
     WHERE d.status='pending'
       AND d.available_at <= now()
       AND NOT EXISTS (
         SELECT 1
         FROM siton.outbox_events o
         WHERE o.event_type='invoice_document_issue'
           AND o.aggregate_type='invoice_document'
           AND o.aggregate_id=d.document_id
           AND o.status IN ('pending','processing','sent')
       )
     ORDER BY d.created_at ASC
     LIMIT $1`,
    [limit]
  );
  for (const row of rows.rows) {
    await insertInvoiceOutboxIfMissing(pool, String(row.document_id), {
      document_id: String(row.document_id),
      document_key: String(row.document_key),
      document_type: String(row.document_type),
      deal_id: String(row.deal_id),
      participant_id: row.participant_id ? String(row.participant_id) : null,
      correlation_id: row.correlation_id ?? null
    });
  }
  return Number(rows.rowCount || 0);
}

const INVOICE_BATCH_SIZE = 20;
const RETRY_DELAY_MS = [30_000, 90_000, 270_000];

export async function flushPendingDocuments(
  pool: pg.Pool,
  invoiceProvider: InvoiceProvider,
  logger: Pick<Console, "info" | "error"> = console
): Promise<number> {
  await ensureInvoiceRailTablesForDb(pool);
  const claimed = await pool.query(
    `SELECT document_id
     FROM siton.invoice_documents
     WHERE status='pending'
       AND available_at <= now()
     ORDER BY created_at ASC
     LIMIT $1`,
    [INVOICE_BATCH_SIZE]
  );
  let processed = 0;
  for (const row of claimed.rows) {
    try {
      await processInvoiceDocumentById({
        pool,
        invoiceProvider,
        documentId: String(row.document_id),
        eventId: `direct-flush:${row.document_id}`
      });
      processed++;
    } catch (err: unknown) {
      const doc = await loadInvoiceDocument(pool, String(row.document_id));
      const attemptCount = Number(doc?.attempt_count || 0);
      const maxAttempts = Number(doc?.max_attempts || 3);
      const msg = err instanceof Error ? err.message : String(err);
      if (attemptCount >= maxAttempts) {
        await pool.query(
          `UPDATE siton.invoice_documents
           SET status='failed',
               document_status='failed',
               last_error=$2,
               updated_at=now()
           WHERE document_id=$1`,
          [row.document_id, `max_attempts_exceeded: ${msg}`]
        );
      } else {
        const delayIdx = Math.min(attemptCount, RETRY_DELAY_MS.length - 1);
        const nextAt = new Date(Date.now() + RETRY_DELAY_MS[delayIdx]!);
        await pool.query(
          `UPDATE siton.invoice_documents
           SET status='pending',
               document_status='pending',
               last_error=$2,
               available_at=$3,
               updated_at=now()
           WHERE document_id=$1`,
          [row.document_id, msg, nextAt.toISOString()]
        );
      }
      logger.error("[invoice.flush] failure", { document_id: row.document_id, error: msg });
      processed++;
    }
  }
  return processed;
}

export async function reclaimStuckInvoiceDocuments(
  pool: pg.Pool,
  timeoutMs: number,
  logger: Pick<Console, "warn" | "error"> = console
): Promise<number> {
  await ensureInvoiceRailTablesForDb(pool);
  const r = await pool.query(
    `UPDATE siton.invoice_documents
     SET status='pending',
         document_status='pending',
         last_error=COALESCE(last_error, 'worker_reclaim_after_restart'),
         available_at=now(),
         updated_at=now()
     WHERE status='processing'
       AND updated_at < now() - ($1::text || ' milliseconds')::interval`,
    [String(timeoutMs)]
  );
  const count = Number(r.rowCount || 0);
  if (count > 0) logger.warn(`[invoice.reclaim] reclaimed ${count} stuck processing invoice document(s)`);
  return count;
}

export function getInvoiceProviderSummary(provider: InvoiceProvider) {
  const isExternal = provider.providerCode !== "internal-invoice-ledger" && provider.mode !== "internal-truth-only" && provider.mode !== "disabled";
  return {
    provider: provider.providerCode,
    mode: provider.mode === "internal-truth-only" ? "log-only" : provider.mode,
    provider_mode: provider.mode,
    configured: provider.configured ?? provider.mode !== "disabled",
    create_document_transport_live: isExternal && Boolean(provider.createDocument) && Boolean(provider.configured),
    get_document_status_transport_live: isExternal && Boolean(provider.getDocumentStatus) && Boolean(provider.configured),
    cancel_document_transport_live: isExternal && Boolean(provider.cancelDocument) && Boolean(provider.configured),
    reconcile_document_transport_live: isExternal && Boolean(provider.reconcileDocument) && Boolean(provider.configured),
    webhook_verification_live: isExternal && Boolean(provider.verifyWebhook) && Boolean(provider.configured),
    external_issuance: isExternal && Boolean(provider.configured),
    external_document_issued: isExternal && Boolean(provider.configured),
    supported_modes: ["internal-truth-only", "adapter-ready", "real", "disabled"],
    supported_methods: [
      "createDocument",
      "getDocumentStatus",
      "cancelDocument",
      "reconcileDocument",
      "verifyWebhook",
      "parseInvoiceWebhookEvent"
    ]
  };
}
