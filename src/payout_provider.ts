import {
  PAYOUT_PROVIDER,
  PAYOUT_PROVIDER_API_KEY,
  PAYOUT_PROVIDER_BASE_URL,
  PAYOUT_PROVIDER_DISPATCH_PATH,
  PAYOUT_PROVIDER_MODE,
  PAYOUT_PROVIDER_RECONCILE_PATH,
  PAYOUT_PROVIDER_TIMEOUT_MS
} from "./runtime_config.js";

export type PayoutResultClass = "success" | "permanent_fail" | "temporary_fail";

export type DispatchPayoutBatchInput = {
  payout_batch_id: string;
  seller_id: string;
  item_count: number;
  seller_net_amount: number;
  currency: string;
  correlation_id: string;
  request_id?: string;
};

export type ReconcilePayoutBatchInput = {
  payout_batch_id: string;
  seller_id: string;
  expected_item_count: number;
  expected_seller_net_amount: number;
  observed_item_count: number;
  observed_seller_net_amount: number;
  correlation_id: string;
  provider_batch_reference?: string | null;
};

export type PayoutDispatchResult = {
  provider: string;
  result_class: PayoutResultClass;
  retryable: boolean;
  provider_batch_reference?: string | null;
  correlation_id?: string | null;
  external_transfer_executed: boolean;
};

export type PayoutReconciliationResult = {
  provider: string;
  result_class: PayoutResultClass;
  retryable: boolean;
  reconciliation_status: "matched" | "manual_review";
  provider_batch_reference?: string | null;
  correlation_id?: string | null;
  observed_item_count: number;
  observed_seller_net_amount: number;
  external_transfer_executed: boolean;
};

export interface PayoutProvider {
  readonly providerCode: string;
  readonly mode: "internal-truth-only" | "adapter-ready";
  readonly configured: boolean;
  dispatchBatch(input: DispatchPayoutBatchInput): Promise<PayoutDispatchResult>;
  reconcileBatch(input: ReconcilePayoutBatchInput): Promise<PayoutReconciliationResult>;
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
  return "success";
}

function buildInternalTruthOnlyProvider(): PayoutProvider {
  return {
    providerCode: PAYOUT_PROVIDER,
    mode: "internal-truth-only",
    configured: true,
    async dispatchBatch(input: DispatchPayoutBatchInput): Promise<PayoutDispatchResult> {
      const resultClass = classifyInternalModeFailure(input.payout_batch_id);
      return {
        provider: PAYOUT_PROVIDER,
        result_class: resultClass,
        retryable: resultClass === "temporary_fail",
        provider_batch_reference: `internal-payout:${input.payout_batch_id}`,
        correlation_id: input.correlation_id,
        external_transfer_executed: false
      };
    },
    async reconcileBatch(input: ReconcilePayoutBatchInput): Promise<PayoutReconciliationResult> {
      const matched =
        Number(input.expected_item_count || 0) === Number(input.observed_item_count || 0)
        && Number(input.expected_seller_net_amount || 0) === Number(input.observed_seller_net_amount || 0);
      return {
        provider: PAYOUT_PROVIDER,
        result_class: "success",
        retryable: false,
        reconciliation_status: matched ? "matched" : "manual_review",
        provider_batch_reference: input.provider_batch_reference ?? `internal-payout:${input.payout_batch_id}`,
        correlation_id: input.correlation_id,
        observed_item_count: Number(input.observed_item_count || 0),
        observed_seller_net_amount: Number(input.observed_seller_net_amount || 0),
        external_transfer_executed: false
      };
    }
  };
}

export function buildPayoutProvider(): PayoutProvider {
  return buildInternalTruthOnlyProvider();
}

export function getPayoutProviderSummary(provider: PayoutProvider) {
  const dispatchPath = normalizePath(PAYOUT_PROVIDER_DISPATCH_PATH, "/payouts/dispatch");
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
    dispatch_path: dispatchPath,
    reconcile_path: reconcilePath,
    dispatch_transport_live: false,
    reconcile_transport_live: false,
    external_transfer_executed: false,
    timeout_ms: PAYOUT_PROVIDER_TIMEOUT_MS,
    supported_modes: ["internal-truth-only", "adapter-ready"]
  };
}
