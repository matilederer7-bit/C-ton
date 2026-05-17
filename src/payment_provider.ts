import { createHash, randomUUID, createHmac, timingSafeEqual } from "crypto";
import {
  MOCK_SEED,
  PAYMENT_AUTH_DECLINE_SUFFIX,
  PAYMENT_PROVIDER_API_KEY,
  PAYMENT_PROVIDER_AUTH_PATH,
  PAYMENT_PROVIDER_BASE_URL,
  PAYMENT_PROVIDER_CAPTURE_PATH,
  PAYMENT_PROVIDER_RECOVERY_PATH,
  PAYMENT_PROVIDER_REFUND_PATH,
  PAYMENT_PROVIDER_CURRENCY,
  PAYMENT_PROVIDER_MODE,
  PAYMENT_PROVIDER_PUBLIC_KEY,
  PAYMENT_PROVIDER,
  PAYMENT_PROVIDER_TIMEOUT_MS,
  PAYMENT_WEBHOOK_PROVIDER,
  PAYMENT_WEBHOOK_SECRET,
  PAYMENT_WEBHOOK_SECRET_IS_DEFAULT,
  STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION,
  APP_DEPLOYMENT_MODE
} from "./runtime_config.js";

export type PaymentResultClass = "success" | "permanent_fail" | "temporary_fail";

export type PaymentTokenizationResult =
  | {
      ok: true;
      provider: string;
      payment_method_id: string;
      provider_reference: string;
      correlation_id: string;
      mock: boolean;
    }
  | {
      ok: false;
      provider: string;
      error: string;
      message: string;
      statusCode: number;
      retryable: boolean;
      mock: boolean;
    };

export type PaymentAuthorizationResult =
  | {
      ok: true;
      provider: string;
      authorization_id: string;
      provider_reference: string;
      correlation_id: string;
      authorization: "authorized";
      hold_message: string;
      mock: boolean;
    }
  | {
      ok: false;
      provider: string;
      error: string;
      message: string;
      statusCode: number;
      retryable: boolean;
      mock: boolean;
    };

export type PaymentExecutionResult = {
  provider: string;
  result_class: PaymentResultClass;
  retryable: boolean;
  mock: boolean;
  provider_reference?: string | null;
  correlation_id?: string | null;
  reconciliation_event_type?:
    | "charge_captured"
    | "charge_failed"
    | "recovery_captured"
    | "recovery_failed"
    | "refund_issued"
    | null;
};

export type AuthorizePaymentInput = {
  payer_name?: string;
  payment_method_id?: string;
  amount_minor?: number;
  currency?: string;
  buyer_id?: string;
  deal_id?: string;
  correlation_id?: string;
  request_id?: string;
};

export type TokenizePaymentInput = Omit<AuthorizePaymentInput, "amount_minor" | "currency">;

export type CapturePaymentInput = {
  authorization_id?: string;
  amount_minor?: number;
  currency?: string;
  participant_id?: string;
  deal_id?: string;
  buyer_id?: string;
  correlation_id?: string;
  request_id?: string;
};

export type RecoverPaymentInput = {
  authorization_id?: string;
  amount_minor?: number;
  currency?: string;
  participant_id?: string;
  deal_id?: string;
  buyer_id?: string;
  correlation_id?: string;
  request_id?: string;
  within_window?: boolean;
};

export type RefundPaymentInput = {
  authorization_id?: string;
  capture_reference?: string;
  amount_minor?: number;
  currency?: string;
  participant_id?: string;
  deal_id?: string;
  buyer_id?: string;
  correlation_id?: string;
  request_id?: string;
};

export interface PaymentProvider {
  readonly providerCode: string;
  readonly mode: "mock-backed" | "provider-ready" | "stripe";
  readonly webhookProvider: string;
  readonly configured: boolean;
  tokenize?(input: TokenizePaymentInput): Promise<PaymentTokenizationResult>;
  authorize(input: AuthorizePaymentInput): Promise<PaymentAuthorizationResult>;
  capture(input: CapturePaymentInput): Promise<PaymentExecutionResult>;
  recover(input: RecoverPaymentInput, withinWindow: boolean): Promise<PaymentExecutionResult>;
  refund(input: RefundPaymentInput): Promise<PaymentExecutionResult>;
  verifyWebhook?(args: { rawBody: string; signatureHeader?: string; timestampHeader?: string; secret?: string }): boolean;
  parseWebhookEvent?(body: Record<string, unknown>): {
    provider: string;
    event_id: string;
    event_type: string;
    correlation_id: string | null;
    participant_id: string | null;
    deal_id: string | null;
    provider_reference: string | null;
    payload: Record<string, unknown>;
  } | null;
}

function hashToUint32(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcgNext(x: number) {
  return (Math.imul(1664525, x) + 1013904223) >>> 0;
}

function rand01Deterministic(key: string) {
  if (MOCK_SEED === null) return Math.random();
  let x = (MOCK_SEED ^ hashToUint32(key)) >>> 0;
  x = lcgNext(x);
  return (x >>> 0) / 0x100000000;
}

function paymentAuthorizationId(paymentMethodId: string) {
  return `auth_${createHash("sha256").update(paymentMethodId).digest("hex").slice(0, 12)}`;
}

function buildAuthorizationCorrelationId() {
  return `payauth_${randomUUID().replace(/-/g, "")}`;
}

function buildCaptureCorrelationId() {
  return `paycap_${randomUUID().replace(/-/g, "")}`;
}

function buildRecoveryCorrelationId() {
  return `payrec_${randomUUID().replace(/-/g, "")}`;
}

function normalizeProviderBaseUrl(raw: string) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function normalizeProviderPath(raw: string) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "/authorize";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeStripeBaseUrl(raw: string) {
  return normalizeProviderBaseUrl(raw || PAYMENT_PROVIDER_BASE_URL || "https://api.stripe.com");
}

function isProductionRuntime() {
  return ["production", "prod", "commercial-live"].includes(String(APP_DEPLOYMENT_MODE || "").trim().toLowerCase());
}

function stripeServerSideRawCardAllowed() {
  return !isProductionRuntime() && STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION;
}

function stripeFormEncode(values: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  return params;
}

async function stripePost(path: string, body: Record<string, string | number | boolean | null | undefined>, idempotencyKey: string) {
  const response = await fetch(`${normalizeStripeBaseUrl(PAYMENT_PROVIDER_BASE_URL)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PAYMENT_PROVIDER_API_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": idempotencyKey
    },
    body: stripeFormEncode(body),
    signal: AbortSignal.timeout(PAYMENT_PROVIDER_TIMEOUT_MS)
  });
  const payload = await parseJsonSafely(response);
  return { response, payload };
}

function stripeResultClass(statusCode: number, payload: any): PaymentResultClass {
  const errorType = String(payload?.error?.type || payload?.type || "").toLowerCase();
  if (statusCode >= 500 || statusCode === 429) return "temporary_fail";
  if (errorType === "api_connection_error" || errorType === "api_error" || errorType === "rate_limit_error") {
    return "temporary_fail";
  }
  return "permanent_fail";
}

function stripeErrorMessage(payload: any, fallback: string) {
  return String(payload?.error?.message || payload?.message || fallback);
}

function classifyCaptureEventType(payload: any): "charge_captured" | "charge_failed" | null {
  const value = String(
    payload?.event_type || payload?.status || payload?.result || payload?.capture_status || ""
  )
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (["charge_captured", "captured", "succeeded", "success", "approved"].includes(value)) {
    return "charge_captured";
  }
  if (["charge_failed", "failed", "declined", "rejected", "permanent_fail"].includes(value)) {
    return "charge_failed";
  }
  return null;
}

function classifyRecoveryEventType(payload: any): "recovery_captured" | "recovery_failed" | null {
  const value = String(
    payload?.event_type || payload?.status || payload?.result || payload?.recovery_status || ""
  )
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (["recovery_captured", "recovered", "captured", "succeeded", "success", "approved"].includes(value)) {
    return "recovery_captured";
  }
  if (["recovery_failed", "failed", "declined", "rejected", "permanent_fail"].includes(value)) {
    return "recovery_failed";
  }
  return null;
}

function authorizationValidationFailure(message: string, error: string, statusCode = 400, mock = false) {
  return {
    ok: false as const,
    provider: PAYMENT_PROVIDER,
    error,
    message,
    statusCode,
    retryable: statusCode >= 500,
    mock
  };
}

function mapProviderError(args: {
  statusCode: number;
  payload: any;
  fallbackError: string;
  fallbackMessage: string;
}) {
  const statusCode = Number(args.statusCode || 0) || 502;
  const payload = args.payload && typeof args.payload === "object" ? args.payload : {};
  const rawError = String(payload.error || payload.code || payload.status || args.fallbackError || "").trim();
  const rawMessage = String(payload.message || payload.detail || payload.reason || args.fallbackMessage || "").trim();
  return {
    ok: false as const,
    provider: PAYMENT_PROVIDER,
    error: rawError || args.fallbackError,
    message: rawMessage || args.fallbackMessage,
    statusCode,
    retryable: statusCode >= 500 || statusCode === 429,
    mock: false
  };
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

function buildMockPaymentProvider(): PaymentProvider {
  return {
    providerCode: PAYMENT_PROVIDER,
    mode: "mock-backed",
    webhookProvider: PAYMENT_WEBHOOK_PROVIDER,
    configured: true,
    async authorize(input: AuthorizePaymentInput): Promise<PaymentAuthorizationResult> {
      const payerName = String(input.payer_name || "").trim();
      const paymentMethodId = String(input.payment_method_id || "").trim();

      if (!payerName || !paymentMethodId) {
        return {
          ok: false,
          provider: PAYMENT_PROVIDER,
          error: "hosted_payment_method_required",
          message: "payer_name and payment_method_id are required",
          statusCode: 400,
          retryable: false,
          mock: true
        };
      }

      if (paymentMethodId.endsWith(PAYMENT_AUTH_DECLINE_SUFFIX)) {
        return {
          ok: false,
          provider: PAYMENT_PROVIDER,
          error: "authorization_failed",
          message: "authorization failed in payment provider",
          statusCode: 402,
          retryable: false,
          mock: true
        };
      }

      return {
        ok: true,
        provider: PAYMENT_PROVIDER,
        authorization_id: paymentAuthorizationId(paymentMethodId),
        provider_reference: paymentAuthorizationId(paymentMethodId),
        correlation_id: buildAuthorizationCorrelationId(),
        authorization: "authorized",
        hold_message: "Authorization accepted. Final capture happens only if the deal completes successfully.",
        mock: true
      };
    },
    async capture(input: CapturePaymentInput): Promise<PaymentExecutionResult> {
      const correlationKey = String(input.correlation_id || "").trim() || buildCaptureCorrelationId();
      const r = rand01Deterministic(correlationKey);
      if (r < 0.75) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "success",
          retryable: false,
          mock: true,
          provider_reference: String(input.authorization_id || "").trim() || null,
          correlation_id: correlationKey,
          reconciliation_event_type: "charge_captured"
        };
      }
      if (r < 0.9) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: true,
          provider_reference: String(input.authorization_id || "").trim() || null,
          correlation_id: correlationKey,
          reconciliation_event_type: null
        };
      }
      return {
        provider: PAYMENT_PROVIDER,
        result_class: "permanent_fail",
        retryable: false,
        mock: true,
        provider_reference: String(input.authorization_id || "").trim() || null,
        correlation_id: correlationKey,
        reconciliation_event_type: "charge_failed"
      };
    },
    async recover(input: RecoverPaymentInput, withinWindow: boolean): Promise<PaymentExecutionResult> {
      const correlationKey = String(input.correlation_id || "").trim() || buildRecoveryCorrelationId();
      const authorizationId = String(input.authorization_id || "").trim();
      if (!withinWindow) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "permanent_fail",
          retryable: false,
          mock: true,
          provider_reference: authorizationId || null,
          correlation_id: correlationKey,
          reconciliation_event_type: "recovery_failed"
        };
      }
      const r = rand01Deterministic(correlationKey);
      if (r < 0.5) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "success",
          retryable: false,
          mock: true,
          provider_reference: authorizationId || null,
          correlation_id: correlationKey,
          reconciliation_event_type: "recovery_captured"
        };
      }
      if (r < 0.8) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: true,
          provider_reference: authorizationId || null,
          correlation_id: correlationKey
        };
      }
      return {
        provider: PAYMENT_PROVIDER,
        result_class: "permanent_fail",
        retryable: false,
        mock: true,
        provider_reference: authorizationId || null,
        correlation_id: correlationKey,
        reconciliation_event_type: "recovery_failed"
      };
    },
    async refund(input: RefundPaymentInput): Promise<PaymentExecutionResult> {
      const correlationKey = String(input.correlation_id || "").trim() || "mock-refund";
      const r = rand01Deterministic(correlationKey);
      if (r < 0.8) return { provider: PAYMENT_PROVIDER, result_class: "success", retryable: false, mock: true, reconciliation_event_type: "refund_issued" };
      if (r < 0.95) return { provider: PAYMENT_PROVIDER, result_class: "temporary_fail", retryable: true, mock: true };
      return { provider: PAYMENT_PROVIDER, result_class: "permanent_fail", retryable: false, mock: true };
    }
  };
}

function buildProviderReadyPaymentProvider(): PaymentProvider {
  const configured = Boolean(PAYMENT_PROVIDER_BASE_URL && PAYMENT_PROVIDER_API_KEY);
  const authorizationUrl = `${normalizeProviderBaseUrl(PAYMENT_PROVIDER_BASE_URL)}${normalizeProviderPath(PAYMENT_PROVIDER_AUTH_PATH)}`;
  const captureUrl = `${normalizeProviderBaseUrl(PAYMENT_PROVIDER_BASE_URL)}${normalizeProviderPath(PAYMENT_PROVIDER_CAPTURE_PATH)}`;
  const recoveryUrl = `${normalizeProviderBaseUrl(PAYMENT_PROVIDER_BASE_URL)}${normalizeProviderPath(PAYMENT_PROVIDER_RECOVERY_PATH)}`;
  return {
    providerCode: PAYMENT_PROVIDER,
    mode: "provider-ready",
    webhookProvider: PAYMENT_WEBHOOK_PROVIDER,
    configured,
    async authorize(input: AuthorizePaymentInput): Promise<PaymentAuthorizationResult> {
      const payerName = String(input.payer_name || "").trim();
      const paymentMethodId = String(input.payment_method_id || "").trim();
      const amountMinor = Number(input.amount_minor);
      const currency = String(input.currency || "").trim().toUpperCase();
      const correlationId = String(input.correlation_id || "").trim() || buildAuthorizationCorrelationId();
      const requestId = String(input.request_id || "").trim() || correlationId;

      if (!payerName || !paymentMethodId) {
        return authorizationValidationFailure(
          "payer_name and payment_method_id are required",
          "hosted_payment_method_required"
        );
      }

      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        return authorizationValidationFailure("amount_minor must be a positive integer", "invalid_amount_minor");
      }

      if (!/^[A-Z]{3}$/.test(currency)) {
        return authorizationValidationFailure("currency must be a 3-letter ISO code", "invalid_currency");
      }

      if (!configured) {
        return mapProviderError({
          statusCode: 503,
          payload: null,
          fallbackError: "payment_provider_not_configured",
          fallbackMessage:
            "provider-ready mode is enabled but PAYMENT_PROVIDER_BASE_URL and PAYMENT_PROVIDER_API_KEY are not configured"
        });
      }

      try {
        const response = await fetch(authorizationUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${PAYMENT_PROVIDER_API_KEY}`,
            "idempotency-key": correlationId,
            "x-request-id": requestId
          },
          body: JSON.stringify({
            capture: false,
            amount_minor: amountMinor,
            currency,
            reference: correlationId,
            buyer_id: input.buyer_id ? String(input.buyer_id) : undefined,
            deal_id: input.deal_id ? String(input.deal_id) : undefined,
            payment_method: {
              type: "hosted",
              id: paymentMethodId,
              payer_name: payerName
            }
          }),
          signal: AbortSignal.timeout(PAYMENT_PROVIDER_TIMEOUT_MS)
        });

        const payload = await parseJsonSafely(response);
        if (!response.ok || payload?.ok === false) {
          return mapProviderError({
            statusCode: response.status,
            payload,
            fallbackError: "authorization_failed",
            fallbackMessage: "payment provider rejected the authorization request"
          });
        }

        const authorizationReference = String(
          payload.authorization_id || payload.provider_reference || payload.id || payload.reference || ""
        ).trim();
        if (!authorizationReference) {
          return mapProviderError({
            statusCode: 502,
            payload,
            fallbackError: "provider_response_invalid",
            fallbackMessage: "payment provider response did not include an authorization reference"
          });
        }

        return {
          ok: true,
          provider: PAYMENT_PROVIDER,
          authorization_id: authorizationReference,
          provider_reference: authorizationReference,
          correlation_id: String(payload.correlation_id || payload.reference || correlationId),
          authorization: "authorized",
          hold_message:
            String(payload.hold_message || "").trim() ||
            "Authorization accepted. Final capture happens only if the deal completes successfully.",
          mock: false
        };
      } catch (error: any) {
        const timeout =
          error?.name === "TimeoutError" ||
          error?.name === "AbortError" ||
          String(error?.message || "").toLowerCase().includes("timed out");
        return mapProviderError({
          statusCode: timeout ? 504 : 503,
          payload: null,
          fallbackError: timeout ? "payment_provider_timeout" : "payment_provider_unreachable",
          fallbackMessage: timeout
            ? "payment provider did not confirm the authorization request in time"
            : "payment provider could not be reached for authorization"
        });
      }
    },
    async capture(input: CapturePaymentInput): Promise<PaymentExecutionResult> {
      const authorizationId = String(input.authorization_id || "").trim();
      const amountMinor = Number(input.amount_minor);
      const currency = String(input.currency || PAYMENT_PROVIDER_CURRENCY || "").trim().toUpperCase();
      const correlationId = String(input.correlation_id || "").trim() || buildCaptureCorrelationId();
      const requestId = String(input.request_id || "").trim() || correlationId;

      if (!configured) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: false,
          provider_reference: authorizationId || null,
          correlation_id: correlationId,
          reconciliation_event_type: null
        };
      }

      if (!authorizationId || !Number.isInteger(amountMinor) || amountMinor <= 0 || !/^[A-Z]{3}$/.test(currency)) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: false,
          provider_reference: authorizationId || null,
          correlation_id: correlationId,
          reconciliation_event_type: null
        };
      }

      try {
        const response = await fetch(captureUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${PAYMENT_PROVIDER_API_KEY}`,
            "idempotency-key": correlationId,
            "x-request-id": requestId
          },
          body: JSON.stringify({
            authorization_id: authorizationId,
            amount_minor: amountMinor,
            currency,
            reference: correlationId,
            deal_id: input.deal_id ? String(input.deal_id) : undefined,
            participant_id: input.participant_id ? String(input.participant_id) : undefined,
            buyer_id: input.buyer_id ? String(input.buyer_id) : undefined
          }),
          signal: AbortSignal.timeout(PAYMENT_PROVIDER_TIMEOUT_MS)
        });

        const payload = await parseJsonSafely(response);
        if (!response.ok || payload?.ok === false) {
          const eventType = classifyCaptureEventType(payload);
          return {
            provider: PAYMENT_PROVIDER,
            result_class: response.status >= 500 || response.status === 429 ? "temporary_fail" : "permanent_fail",
            retryable: response.status >= 500 || response.status === 429,
            mock: false,
            provider_reference: String(payload?.provider_reference || payload?.capture_id || authorizationId || "").trim() || null,
            correlation_id: String(payload?.correlation_id || payload?.reference || correlationId),
            reconciliation_event_type: eventType
          };
        }

        return {
          provider: PAYMENT_PROVIDER,
          result_class: "success",
          retryable: false,
          mock: false,
          provider_reference:
            String(payload?.provider_reference || payload?.capture_id || payload?.authorization_id || authorizationId || "").trim() || null,
          correlation_id: String(payload?.correlation_id || payload?.reference || correlationId),
          reconciliation_event_type: classifyCaptureEventType(payload)
        };
      } catch (error: any) {
        const timeout =
          error?.name === "TimeoutError" ||
          error?.name === "AbortError" ||
          String(error?.message || "").toLowerCase().includes("timed out");
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: false,
          provider_reference: authorizationId || null,
          correlation_id: correlationId,
          reconciliation_event_type: null
        };
      }
    },
    async recover(input: RecoverPaymentInput, withinWindow: boolean): Promise<PaymentExecutionResult> {
      const authorizationId = String(input.authorization_id || "").trim();
      const amountMinor = Number(input.amount_minor);
      const currency = String(input.currency || PAYMENT_PROVIDER_CURRENCY || "").trim().toUpperCase();
      const correlationId = String(input.correlation_id || "").trim() || buildRecoveryCorrelationId();
      const requestId = String(input.request_id || "").trim() || correlationId;

      if (!withinWindow) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "permanent_fail",
          retryable: false,
          mock: false,
          provider_reference: authorizationId || null,
          correlation_id: correlationId,
          reconciliation_event_type: "recovery_failed"
        };
      }

      if (!configured) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: false,
          provider_reference: authorizationId || null,
          correlation_id: correlationId
        };
      }

      if (!authorizationId || !Number.isInteger(amountMinor) || amountMinor <= 0 || !/^[A-Z]{3}$/.test(currency)) {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: false,
          provider_reference: authorizationId || null,
          correlation_id: correlationId
        };
      }

      try {
        const response = await fetch(recoveryUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${PAYMENT_PROVIDER_API_KEY}`,
            "idempotency-key": correlationId,
            "x-request-id": requestId
          },
          body: JSON.stringify({
            authorization_id: authorizationId,
            amount_minor: amountMinor,
            currency,
            reference: correlationId,
            within_window: true,
            deal_id: input.deal_id ? String(input.deal_id) : undefined,
            participant_id: input.participant_id ? String(input.participant_id) : undefined,
            buyer_id: input.buyer_id ? String(input.buyer_id) : undefined
          }),
          signal: AbortSignal.timeout(PAYMENT_PROVIDER_TIMEOUT_MS)
        });

        const payload = await parseJsonSafely(response);
        const reconciliationEventType = classifyRecoveryEventType(payload);
        if (!response.ok || payload?.ok === false) {
          const retryable = response.status >= 500 || response.status === 429;
          return {
            provider: PAYMENT_PROVIDER,
            result_class: retryable ? "temporary_fail" : "permanent_fail",
            retryable,
            mock: false,
            provider_reference:
              String(payload?.provider_reference || payload?.recovery_id || payload?.capture_id || authorizationId || "").trim() || null,
            correlation_id: String(payload?.correlation_id || payload?.reference || correlationId),
            reconciliation_event_type: retryable ? null : reconciliationEventType
          };
        }

        return {
          provider: PAYMENT_PROVIDER,
          result_class: "success",
          retryable: false,
          mock: false,
          provider_reference:
            String(payload?.provider_reference || payload?.recovery_id || payload?.capture_id || authorizationId || "").trim() || null,
          correlation_id: String(payload?.correlation_id || payload?.reference || correlationId),
          reconciliation_event_type: reconciliationEventType
        };
      } catch {
        return {
          provider: PAYMENT_PROVIDER,
          result_class: "temporary_fail",
          retryable: true,
          mock: false,
          provider_reference: authorizationId || null,
          correlation_id: correlationId
        };
      }
    },
    async refund(input: RefundPaymentInput): Promise<PaymentExecutionResult> {
      const authorizationId = String(input.authorization_id || "").trim();
      const captureReference = String(input.capture_reference || "").trim();
      const amountMinor = Number(input.amount_minor);
      const currency = String(input.currency || PAYMENT_PROVIDER_CURRENCY || "").trim().toUpperCase();
      const correlationId = String(input.correlation_id || "").trim() || `payrefund_${randomUUID().replace(/-/g, "")}`;
      const requestId = String(input.request_id || "").trim() || correlationId;
      const refundUrl = `${normalizeProviderBaseUrl(PAYMENT_PROVIDER_BASE_URL)}${normalizeProviderPath(PAYMENT_PROVIDER_REFUND_PATH)}`;

      if (!configured) {
        return { provider: PAYMENT_PROVIDER, result_class: "temporary_fail", retryable: true, mock: false, correlation_id: correlationId };
      }

      try {
        const response = await fetch(refundUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${PAYMENT_PROVIDER_API_KEY}`,
            "idempotency-key": correlationId,
            "x-request-id": requestId
          },
          body: JSON.stringify({
            authorization_id: authorizationId || undefined,
            capture_reference: captureReference || authorizationId || undefined,
            amount_minor: Number.isInteger(amountMinor) && amountMinor > 0 ? amountMinor : undefined,
            currency: /^[A-Z]{3}$/.test(currency) ? currency : undefined,
            reference: correlationId,
            deal_id: input.deal_id ? String(input.deal_id) : undefined,
            participant_id: input.participant_id ? String(input.participant_id) : undefined,
            buyer_id: input.buyer_id ? String(input.buyer_id) : undefined
          }),
          signal: AbortSignal.timeout(PAYMENT_PROVIDER_TIMEOUT_MS)
        });

        const payload = await parseJsonSafely(response);
        if (!response.ok || payload?.ok === false) {
          return {
            provider: PAYMENT_PROVIDER,
            result_class: response.status >= 500 || response.status === 429 ? "temporary_fail" : "permanent_fail",
            retryable: response.status >= 500 || response.status === 429,
            mock: false,
            provider_reference: String(payload?.provider_reference || captureReference || authorizationId || "").trim() || null,
            correlation_id: String(payload?.correlation_id || payload?.reference || correlationId),
            reconciliation_event_type: null
          };
        }

        return {
          provider: PAYMENT_PROVIDER,
          result_class: "success",
          retryable: false,
          mock: false,
          provider_reference: String(payload?.provider_reference || payload?.refund_id || captureReference || authorizationId || "").trim() || null,
          correlation_id: String(payload?.correlation_id || payload?.reference || correlationId),
          reconciliation_event_type: "refund_issued"
        };
      } catch {
        return { provider: PAYMENT_PROVIDER, result_class: "temporary_fail", retryable: true, mock: false, correlation_id: correlationId };
      }
    }
  };
}

function buildStripePaymentProvider(): PaymentProvider {
  const configured = PAYMENT_PROVIDER === "stripe" && Boolean(PAYMENT_PROVIDER_API_KEY);
  const providerCode = "stripe";
  const webhookProvider = PAYMENT_WEBHOOK_PROVIDER || "stripe";
  async function tokenize(input: TokenizePaymentInput): Promise<PaymentTokenizationResult> {
    const correlationId = String(input.correlation_id || "").trim() || `stripe_tok_${randomUUID().replace(/-/g, "")}`;
    return {
      ok: false,
      provider: providerCode,
      error: "hosted_payment_required",
      message: "Use Stripe.js/Elements to create payment_method_id; C-ton server routes do not accept raw payment details.",
      statusCode: 403,
      retryable: false,
      mock: false
    };
  }

  function executionFromStripeFailure(args: {
    statusCode: number;
    payload: any;
    providerReference?: string | null;
    correlationId: string;
    failureEvent?: "charge_failed" | "recovery_failed" | null;
  }): PaymentExecutionResult {
    const resultClass = stripeResultClass(args.statusCode, args.payload);
    return {
      provider: providerCode,
      result_class: resultClass,
      retryable: resultClass === "temporary_fail",
      mock: false,
      provider_reference: args.providerReference ?? null,
      correlation_id: args.correlationId,
      reconciliation_event_type: resultClass === "permanent_fail" ? args.failureEvent ?? null : null
    };
  }

  function verifyWebhook(args: { rawBody: string; signatureHeader?: string; timestampHeader?: string; secret?: string }) {
    const secret = String(args.secret || process.env.STRIPE_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || "").trim();
    const header = String(args.signatureHeader || "").trim();
    if (!secret || !header) return false;
    const parts = Object.fromEntries(
      header.split(",").map((part) => {
        const [key, ...rest] = part.split("=");
        return [String(key || "").trim(), rest.join("=").trim()];
      })
    );
    const timestamp = String(parts.t || args.timestampHeader || "").trim();
    const signature = String(parts.v1 || "").trim();
    if (!timestamp || !signature) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > 5 * 60 * 1000) return false;
    try {
      const expected = createHmac("sha256", secret).update(`${timestamp}.${args.rawBody}`).digest("hex");
      const expectedBuf = Buffer.from(expected, "hex");
      const providedBuf = Buffer.from(signature, "hex");
      if (expectedBuf.length !== providedBuf.length) return false;
      return timingSafeEqual(expectedBuf, providedBuf);
    } catch {
      return false;
    }
  }

  function parseWebhookEvent(body: Record<string, unknown>) {
    const eventId = String(body.id || "").trim();
    const stripeType = String(body.type || "").trim();
    const data = (body.data as any)?.object || {};
    if (!eventId || !stripeType) return null;
    const metadata = data?.metadata || {};
    const providerReference = String(data.id || data.payment_intent || data.charge || "").trim() || null;
    const eventMap: Record<string, string> = {
      "payment_intent.amount_capturable_updated": "payment_authorized",
      "payment_intent.succeeded": "charge_captured",
      "payment_intent.payment_failed": "charge_failed",
      "charge.refunded": "refund_issued",
      "refund.succeeded": "refund_issued",
      "refund.failed": "charge_failed"
    };
    const eventType = eventMap[stripeType] || "";
    if (!eventType) return null;
    return {
      provider: providerCode,
      event_id: eventId,
      event_type: eventType,
      correlation_id: String(metadata.correlation_id || data.client_reference_id || "").trim() || null,
      participant_id: String(metadata.participant_id || "").trim() || null,
      deal_id: String(metadata.deal_id || "").trim() || null,
      provider_reference: providerReference,
      payload: {
        stripe_type: stripeType,
        provider_reference: providerReference,
        status: data.status || null,
        metadata
      }
    };
  }

  return {
    providerCode,
    mode: "stripe",
    webhookProvider,
    configured,
    tokenize,
    verifyWebhook,
    parseWebhookEvent,
    async authorize(input: AuthorizePaymentInput): Promise<PaymentAuthorizationResult> {
      const amountMinor = Number(input.amount_minor);
      const currency = String(input.currency || PAYMENT_PROVIDER_CURRENCY || "ILS").trim().toLowerCase();
      const correlationId = String(input.correlation_id || "").trim() || buildAuthorizationCorrelationId();
      const requestId = String(input.request_id || "").trim() || correlationId;

      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        return authorizationValidationFailure("amount_minor must be a positive integer", "invalid_amount_minor", 400, false);
      }
      if (!/^[a-z]{3}$/i.test(currency)) {
        return authorizationValidationFailure("currency must be a 3-letter ISO code", "invalid_currency", 400, false);
      }
      if (!configured) {
        return authorizationValidationFailure("Stripe adapter is missing PAYMENT_PROVIDER_API_KEY", "stripe_not_configured", 503, false);
      }

      let paymentMethodId = String(input.payment_method_id || "").trim();
      if (!paymentMethodId) {
        return authorizationValidationFailure(
          "payment_method_id is required; use the provider hosted payment component",
          "payment_method_required",
          403,
          false
        );
      }

      try {
        const { response, payload } = await stripePost("/v1/payment_intents", {
          amount: amountMinor,
          currency,
          payment_method: paymentMethodId,
          confirm: "true",
          capture_method: "manual",
          "metadata[buyer_id]": input.buyer_id ? String(input.buyer_id) : undefined,
          "metadata[deal_id]": input.deal_id ? String(input.deal_id) : undefined,
          "metadata[correlation_id]": correlationId,
          "metadata[request_id]": requestId
        }, correlationId);

        if (!response.ok || payload?.error) {
          return mapProviderError({
            statusCode: response.status,
            payload: payload?.error ? { error: payload.error.code || payload.error.type, message: payload.error.message } : payload,
            fallbackError: "stripe_authorization_failed",
            fallbackMessage: "Stripe rejected the authorization request"
          });
        }

        const paymentIntentId = String(payload?.id || "").trim();
        const status = String(payload?.status || "").trim();
        if (!paymentIntentId || !["requires_capture", "processing", "succeeded"].includes(status)) {
          return mapProviderError({
            statusCode: 502,
            payload,
            fallbackError: "stripe_authorization_unconfirmed",
            fallbackMessage: "Stripe did not return a capturable PaymentIntent"
          });
        }

        return {
          ok: true,
          provider: providerCode,
          authorization_id: paymentIntentId,
          provider_reference: paymentIntentId,
          correlation_id: String(payload?.metadata?.correlation_id || correlationId),
          authorization: "authorized",
          hold_message: "Stripe authorized the buyer payment. Capture remains worker/outbox-driven.",
          mock: false
        };
      } catch (error: any) {
        const timeout =
          error?.name === "TimeoutError" ||
          error?.name === "AbortError" ||
          String(error?.message || "").toLowerCase().includes("timed out");
        return mapProviderError({
          statusCode: timeout ? 504 : 503,
          payload: null,
          fallbackError: timeout ? "stripe_authorization_timeout" : "stripe_authorization_unreachable",
          fallbackMessage: timeout ? "Stripe authorization timed out" : "Stripe authorization could not be reached"
        });
      }
    },
    async capture(input: CapturePaymentInput): Promise<PaymentExecutionResult> {
      const paymentIntentId = String(input.authorization_id || "").trim();
      const amountMinor = Number(input.amount_minor);
      const correlationId = String(input.correlation_id || "").trim() || buildCaptureCorrelationId();
      if (!configured || !paymentIntentId) {
        return {
          provider: providerCode,
          result_class: "temporary_fail",
          retryable: true,
          mock: false,
          provider_reference: paymentIntentId || null,
          correlation_id: correlationId,
          reconciliation_event_type: null
        };
      }
      try {
        const { response, payload } = await stripePost(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`, {
          amount_to_capture: Number.isInteger(amountMinor) && amountMinor > 0 ? amountMinor : undefined,
          "metadata[correlation_id]": correlationId,
          "metadata[participant_id]": input.participant_id ? String(input.participant_id) : undefined,
          "metadata[deal_id]": input.deal_id ? String(input.deal_id) : undefined,
          "metadata[buyer_id]": input.buyer_id ? String(input.buyer_id) : undefined
        }, correlationId);
        if (!response.ok || payload?.error) {
          return executionFromStripeFailure({
            statusCode: response.status,
            payload,
            providerReference: paymentIntentId,
            correlationId,
            failureEvent: "charge_failed"
          });
        }
        return {
          provider: providerCode,
          result_class: "success",
          retryable: false,
          mock: false,
          provider_reference: String(payload?.id || paymentIntentId),
          correlation_id: String(payload?.metadata?.correlation_id || correlationId),
          reconciliation_event_type: "charge_captured"
        };
      } catch {
        return { provider: providerCode, result_class: "temporary_fail", retryable: true, mock: false, provider_reference: paymentIntentId, correlation_id: correlationId };
      }
    },
    async recover(input: RecoverPaymentInput, withinWindow: boolean): Promise<PaymentExecutionResult> {
      if (!withinWindow) {
        return {
          provider: providerCode,
          result_class: "permanent_fail",
          retryable: false,
          mock: false,
          provider_reference: input.authorization_id || null,
          correlation_id: input.correlation_id || buildRecoveryCorrelationId(),
          reconciliation_event_type: "recovery_failed"
        };
      }
      const captureInput: CapturePaymentInput = {
        correlation_id: input.correlation_id || buildRecoveryCorrelationId()
      };
      if (input.authorization_id) captureInput.authorization_id = input.authorization_id;
      if (input.amount_minor !== undefined) captureInput.amount_minor = input.amount_minor;
      if (input.currency) captureInput.currency = input.currency;
      if (input.participant_id) captureInput.participant_id = input.participant_id;
      if (input.deal_id) captureInput.deal_id = input.deal_id;
      if (input.buyer_id) captureInput.buyer_id = input.buyer_id;
      if (input.request_id) captureInput.request_id = input.request_id;
      const result = await this.capture(captureInput);
      const recoveryEvent =
        result.reconciliation_event_type === "charge_captured"
          ? "recovery_captured"
          : result.reconciliation_event_type === "charge_failed"
            ? "recovery_failed"
            : result.reconciliation_event_type ?? null;
      return {
        ...result,
        reconciliation_event_type: recoveryEvent
      };
    },
    async refund(input: RefundPaymentInput): Promise<PaymentExecutionResult> {
      const paymentIntentId = String(input.capture_reference || input.authorization_id || "").trim();
      const amountMinor = Number(input.amount_minor);
      const correlationId = String(input.correlation_id || "").trim() || `stripe_refund_${randomUUID().replace(/-/g, "")}`;
      if (!configured || !paymentIntentId) {
        return { provider: providerCode, result_class: "temporary_fail", retryable: true, mock: false, provider_reference: paymentIntentId || null, correlation_id: correlationId };
      }
      try {
        const { response, payload } = await stripePost("/v1/refunds", {
          payment_intent: paymentIntentId,
          amount: Number.isInteger(amountMinor) && amountMinor > 0 ? amountMinor : undefined,
          "metadata[correlation_id]": correlationId,
          "metadata[participant_id]": input.participant_id ? String(input.participant_id) : undefined,
          "metadata[deal_id]": input.deal_id ? String(input.deal_id) : undefined,
          "metadata[buyer_id]": input.buyer_id ? String(input.buyer_id) : undefined
        }, correlationId);
        if (!response.ok || payload?.error) {
          return executionFromStripeFailure({
            statusCode: response.status,
            payload,
            providerReference: paymentIntentId,
            correlationId,
            failureEvent: null
          });
        }
        return {
          provider: providerCode,
          result_class: "success",
          retryable: false,
          mock: false,
          provider_reference: String(payload?.id || paymentIntentId),
          correlation_id: String(payload?.metadata?.correlation_id || correlationId),
          reconciliation_event_type: "refund_issued"
        };
      } catch {
        return { provider: providerCode, result_class: "temporary_fail", retryable: true, mock: false, provider_reference: paymentIntentId, correlation_id: correlationId };
      }
    }
  };
}

export function buildPaymentProvider(): PaymentProvider {
  if (PAYMENT_PROVIDER === "stripe" || PAYMENT_PROVIDER_MODE === "stripe") {
    if (isProductionRuntime()) {
      if (!PAYMENT_PROVIDER_API_KEY) {
        throw new Error("PAYMENT_PROVIDER=stripe requires PAYMENT_PROVIDER_API_KEY in production");
      }
      if (!PAYMENT_PROVIDER_PUBLIC_KEY) {
        throw new Error("PAYMENT_PROVIDER=stripe requires PAYMENT_PROVIDER_PUBLIC_KEY in production");
      }
      if (!PAYMENT_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET_IS_DEFAULT) {
        throw new Error("PAYMENT_PROVIDER=stripe requires a non-default PAYMENT_WEBHOOK_SECRET in production");
      }
      if (STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION) {
        throw new Error("STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION must be disabled in production");
      }
    }
    return buildStripePaymentProvider();
  }
  if (PAYMENT_PROVIDER_MODE === "provider-ready") {
    if (isProductionRuntime()) {
      if (!PAYMENT_PROVIDER_BASE_URL) {
        throw new Error("PAYMENT_PROVIDER_MODE=provider-ready requires PAYMENT_PROVIDER_BASE_URL in production");
      }
      if (!PAYMENT_PROVIDER_API_KEY) {
        throw new Error("PAYMENT_PROVIDER_MODE=provider-ready requires PAYMENT_PROVIDER_API_KEY in production");
      }
      if (!PAYMENT_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET_IS_DEFAULT) {
        throw new Error("PAYMENT_PROVIDER_MODE=provider-ready requires a non-default PAYMENT_WEBHOOK_SECRET in production");
      }
    }
    return buildProviderReadyPaymentProvider();
  }
  if (isProductionRuntime()) {
    throw new Error("production payment provider cannot use mock-backed mode; set PAYMENT_PROVIDER=stripe or PAYMENT_PROVIDER_MODE=provider-ready");
  }
  return buildMockPaymentProvider();
}

export function getPaymentProviderSummary(provider: PaymentProvider) {
  return {
    provider: provider.providerCode,
    mode: provider.mode,
    configured: provider.configured,
    webhook_provider: provider.webhookProvider,
    mock_backed: provider.mode === "mock-backed",
    decline_suffix: PAYMENT_AUTH_DECLINE_SUFFIX,
    api_base_url_configured: Boolean(PAYMENT_PROVIDER_BASE_URL),
    api_key_configured: Boolean(PAYMENT_PROVIDER_API_KEY),
    public_key_configured: Boolean(PAYMENT_PROVIDER_PUBLIC_KEY),
    authorization_path: PAYMENT_PROVIDER_AUTH_PATH,
    capture_path: PAYMENT_PROVIDER_CAPTURE_PATH,
    recovery_path: PAYMENT_PROVIDER_RECOVERY_PATH,
    refund_path: PAYMENT_PROVIDER_REFUND_PATH,
    tokenization_transport_live: provider.mode === "stripe" && provider.configured,
    authorization_transport_live: provider.mode !== "mock-backed" && provider.configured,
    capture_transport_live: provider.mode !== "mock-backed" && provider.configured,
    recovery_transport_live: provider.mode !== "mock-backed" && provider.configured,
    refund_transport_live: provider.mode !== "mock-backed" && provider.configured,
    webhook_verification_live: provider.mode === "stripe" && provider.configured,
    payment_reconcile_live: provider.mode !== "mock-backed",
    hosted_payment_required:
      provider.mode === "stripe" ? stripeServerSideRawCardAllowed() : provider.mode !== "mock-backed",
    pci_tokenization_policy:
      provider.mode === "stripe"
        ? "production requires Stripe.js/Elements payment_method_id; server-side raw card tokenization is blocked unless explicit non-production test flag is set"
        : "provider-specific",
    timeout_ms: PAYMENT_PROVIDER_TIMEOUT_MS,
    supported_modes: ["mock-backed", "provider-ready", "stripe"],
    adapter_contract: {
      tokenize: "Stripe PaymentMethod creation when PAYMENT_PROVIDER=stripe",
      authorize: "authorization intent only, no capture side-effects",
      capture: "charge capture result with reconciliation event mapping",
      recover: "completion-window recovery capture result with reconciliation event mapping",
      refund: "refund result with duplicate-safe reconciliation handoff"
    },
    idempotency_contract: {
      outbound_headers: ["idempotency-key", "x-request-id"],
      correlation_field: "correlation_id",
      provider_event_identity: "provider_code + provider_event_id"
    },
    replacement_path: "Implement live provider HTTP client inside payment_provider.ts and keep webhook reconciliation in app/webhook path."
  };
}
