import {
  PAYOUT_PROVIDER,
  PAYOUT_PROVIDER_API_KEY,
  PAYOUT_PROVIDER_BASE_URL,
  PAYOUT_PROVIDER_DISPATCH_PATH,
  PAYOUT_PROVIDER_MODE,
  PAYOUT_PROVIDER_RECONCILE_PATH,
  PAYOUT_PROVIDER_TIMEOUT_MS
} from "./runtime_config.js";

export type PayoutResultClass = "success" | "permanent_fail" | "temporary_fail" | "unknown";
export type PayoutLifecycleStatus =
  | "pending"
  | "ready"
  | "batched"
  | "processing"
  | "paid"
  | "failed"
  | "returned"
  | "reconciled";

export type CreatePayoutInput = {
  payout_batch_id: string;
  seller_id: string;
  payout_amount: number;
  item_count: number;
  currency: string;
  correlation_id: string;
  request_id?: string;
};

export type GetPayoutStatusInput = {
  payout_batch_id: string;
  seller_id: string;
  payout_reference?: string | null;
  correlation_id: string;
};

export type CancelPayoutInput = {
  payout_batch_id: string;
  seller_id: string;
  payout_reference?: string | null;
  correlation_id: string;
  reason: string;
};

export type ReconcilePayoutInput = {
  payout_batch_id: string;
  seller_id: string;
  expected_item_count: number;
  expected_payout_amount: number;
  observed_item_count: number;
  observed_payout_amount: number;
  payout_reference?: string | null;
  correlation_id: string;
};

export type ParsedPayoutWebhookEvent = {
  provider: string;
  event_id: string;
  payout_reference: string | null;
  payout_status: PayoutLifecycleStatus | null;
  correlation_id: string | null;
  seller_id: string | null;
  payout_batch_id: string | null;
  payload: Record<string, unknown>;
};

export type NormalizedPayoutResult = {
  provider: string;
  result_class: PayoutResultClass;
  retryable: boolean;
  payout_status: PayoutLifecycleStatus | null;
  payout_reference?: string | null;
  correlation_id?: string | null;
  external_transfer_executed: boolean;
  raw?: Record<string, unknown>;
};

export type PayoutReconciliationResult = NormalizedPayoutResult & {
  reconciliation_outcome: "matched" | "mismatched";
  observed_item_count: number;
  observed_payout_amount: number;
};

export interface PayoutProvider {
  readonly providerCode: string;
  readonly mode: "internal-truth-only" | "adapter-ready";
  readonly configured: boolean;
  createPayout(input: CreatePayoutInput): Promise<NormalizedPayoutResult>;
  getPayoutStatus(input: GetPayoutStatusInput): Promise<NormalizedPayoutResult>;
  cancelPayout(input: CancelPayoutInput): Promise<NormalizedPayoutResult>;
  reconcilePayout(input: ReconcilePayoutInput): Promise<PayoutReconciliationResult>;
  parsePayoutWebhookEvent(payload: Record<string, unknown>): ParsedPayoutWebhookEvent;
}

function normalizePath(raw: string, fallback: string) {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeBaseUrl(raw: string) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function classifyInternalModeFailure(anchor: string): PayoutResultClass {
  const value = String(anchor || "").toLowerCase();
  if (value.includes("permfail")) return "permanent_fail";
  if (value.includes("tempfail")) return "temporary_fail";
  if (value.includes("unknown")) return "unknown";
  return "success";
}

function buildInternalTruthOnlyProvider(): PayoutProvider {
  return {
    providerCode: PAYOUT_PROVIDER,
    mode: "internal-truth-only",
    configured: true,
    async createPayout(input: CreatePayoutInput): Promise<NormalizedPayoutResult> {
      const resultClass = classifyInternalModeFailure(input.payout_batch_id);
      return {
        provider: PAYOUT_PROVIDER,
        result_class: resultClass,
        retryable: resultClass === "temporary_fail" || resultClass === "unknown",
        payout_status: resultClass === "success" ? "processing" : resultClass === "permanent_fail" ? "failed" : "processing",
        payout_reference: `internal-payout:${input.payout_batch_id}`,
        correlation_id: input.correlation_id,
        external_transfer_executed: false,
        raw: {
          mode: "internal-truth-only",
          payout_amount: input.payout_amount,
          item_count: input.item_count
        }
      };
    },
    async getPayoutStatus(input: GetPayoutStatusInput): Promise<NormalizedPayoutResult> {
      return {
        provider: PAYOUT_PROVIDER,
        result_class: "success",
        retryable: false,
        payout_status: "processing",
        payout_reference: input.payout_reference ?? `internal-payout:${input.payout_batch_id}`,
        correlation_id: input.correlation_id,
        external_transfer_executed: false,
        raw: {
          mode: "internal-truth-only"
        }
      };
    },
    async cancelPayout(input: CancelPayoutInput): Promise<NormalizedPayoutResult> {
      return {
        provider: PAYOUT_PROVIDER,
        result_class: "success",
        retryable: false,
        payout_status: "returned",
        payout_reference: input.payout_reference ?? `internal-payout:${input.payout_batch_id}`,
        correlation_id: input.correlation_id,
        external_transfer_executed: false,
        raw: {
          reason: input.reason,
          mode: "internal-truth-only"
        }
      };
    },
    async reconcilePayout(input: ReconcilePayoutInput): Promise<PayoutReconciliationResult> {
      const matched =
        Number(input.expected_item_count || 0) === Number(input.observed_item_count || 0)
        && Number(input.expected_payout_amount || 0) === Number(input.observed_payout_amount || 0);
      return {
        provider: PAYOUT_PROVIDER,
        result_class: "success",
        retryable: false,
        payout_status: matched ? "reconciled" : "failed",
        payout_reference: input.payout_reference ?? `internal-payout:${input.payout_batch_id}`,
        correlation_id: input.correlation_id,
        observed_item_count: Number(input.observed_item_count || 0),
        observed_payout_amount: Number(input.observed_payout_amount || 0),
        reconciliation_outcome: matched ? "matched" : "mismatched",
        external_transfer_executed: false,
        raw: {
          mode: "internal-truth-only",
          expected_item_count: input.expected_item_count,
          expected_payout_amount: input.expected_payout_amount
        }
      };
    },
    parsePayoutWebhookEvent(payload: Record<string, unknown>): ParsedPayoutWebhookEvent {
      const payoutStatusRaw = String(payload?.payout_status || payload?.status || "").trim().toLowerCase();
      const payoutStatus: PayoutLifecycleStatus | null =
        [
          "pending",
          "ready",
          "batched",
          "processing",
          "paid",
          "failed",
          "returned",
          "reconciled"
        ].includes(payoutStatusRaw)
          ? (payoutStatusRaw as PayoutLifecycleStatus)
          : null;
      return {
        provider: PAYOUT_PROVIDER,
        event_id: String(payload?.event_id || payload?.id || `internal-event:${Date.now()}`),
        payout_reference: String(payload?.payout_reference || payload?.reference || "").trim() || null,
        payout_status: payoutStatus,
        correlation_id: String(payload?.correlation_id || "").trim() || null,
        seller_id: String(payload?.seller_id || "").trim() || null,
        payout_batch_id: String(payload?.payout_batch_id || "").trim() || null,
        payload
      };
    }
  };
}

export function buildPayoutProvider(): PayoutProvider {
  return buildInternalTruthOnlyProvider();
}

export function getPayoutProviderSummary(provider: PayoutProvider) {
  const createPath = normalizePath(PAYOUT_PROVIDER_DISPATCH_PATH, "/payouts/dispatch");
  const reconcilePath = normalizePath(PAYOUT_PROVIDER_RECONCILE_PATH, "/payouts/reconcile");
  const baseUrl = normalizeBaseUrl(PAYOUT_PROVIDER_BASE_URL);
  const configuredForAdapterReady =
    Boolean(baseUrl) && Boolean(String(PAYOUT_PROVIDER_API_KEY || "").trim());

  return {
    provider: provider.providerCode,
    mode: provider.mode,
    configured: provider.mode === "adapter-ready" ? configuredForAdapterReady : provider.configured,
    api_base_url_configured: Boolean(baseUrl),
    api_key_configured: Boolean(String(PAYOUT_PROVIDER_API_KEY || "").trim()),
    create_payout_path: createPath,
    reconcile_payout_path: reconcilePath,
    create_payout_transport_live: false,
    get_payout_status_transport_live: false,
    cancel_payout_transport_live: false,
    reconcile_payout_transport_live: false,
    external_transfer_executed: false,
    timeout_ms: PAYOUT_PROVIDER_TIMEOUT_MS,
    supported_modes: ["internal-truth-only", "adapter-ready"],
    supported_methods: [
      "createPayout",
      "getPayoutStatus",
      "cancelPayout",
      "reconcilePayout",
      "parsePayoutWebhookEvent"
    ]
  };
}
