import { createHash, randomUUID } from "crypto";
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
  PAYMENT_WEBHOOK_PROVIDER
} from "./runtime_config.js";

export type PaymentResultClass = "success" | "permanent_fail" | "temporary_fail";

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
  holder_name: string;
  card_number: string;
  expiry: string;
  cvv: string;
  amount_minor?: number;
  currency?: string;
  buyer_id?: string;
  deal_id?: string;
  correlation_id?: string;
  request_id?: string;
};

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
  readonly mode: "mock-backed" | "provider-ready";
  readonly webhookProvider: string;
  readonly configured: boolean;
  authorize(input: AuthorizePaymentInput): Promise<PaymentAuthorizationResult>;
  capture(input: CapturePaymentInput): Promise<PaymentExecutionResult>;
  recover(input: RecoverPaymentInput, withinWindow: boolean): Promise<PaymentExecutionResult>;
  refund(input: RefundPaymentInput): Promise<PaymentExecutionResult>;
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

function paymentAuthorizationId(cardNumber: string) {
  return `auth_${createHash("sha256").update(cardNumber).digest("hex").slice(0, 12)}`;
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

function parseExpiry(expiry: string) {
  const match = String(expiry || "").trim().match(/^(\d{2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const rawYear = String(match[2]);
  const year = rawYear.length === 2 ? Number(`20${rawYear}`) : Number(rawYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return {
    expiry_month: String(month).padStart(2, "0"),
    expiry_year: String(year)
  };
}

function normalizeProviderBaseUrl(raw: string) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function normalizeProviderPath(raw: string) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "/authorize";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
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
      const holderName = String(input.holder_name || "").trim();
      const cardNumber = String(input.card_number || "").replace(/\s+/g, "");
      const expiry = String(input.expiry || "").trim();
      const cvv = String(input.cvv || "").trim();

      if (!holderName || !cardNumber || !expiry || !cvv) {
        return {
          ok: false,
          provider: PAYMENT_PROVIDER,
          error: "payment_details_required",
          message: "holder_name, card_number, expiry and cvv are required",
          statusCode: 400,
          retryable: false,
          mock: true
        };
      }

      if (!/^\d{12,19}$/.test(cardNumber)) {
        return {
          ok: false,
          provider: PAYMENT_PROVIDER,
          error: "invalid_card_number",
          message: "card number must contain 12 to 19 digits",
          statusCode: 400,
          retryable: false,
          mock: true
        };
      }

      if (cardNumber.endsWith(PAYMENT_AUTH_DECLINE_SUFFIX)) {
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
        authorization_id: paymentAuthorizationId(cardNumber),
        provider_reference: paymentAuthorizationId(cardNumber),
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
      const holderName = String(input.holder_name || "").trim();
      const cardNumber = String(input.card_number || "").replace(/\s+/g, "");
      const expiry = String(input.expiry || "").trim();
      const cvv = String(input.cvv || "").trim();
      const expiryParts = parseExpiry(expiry);
      const amountMinor = Number(input.amount_minor);
      const currency = String(input.currency || "").trim().toUpperCase();
      const correlationId = String(input.correlation_id || "").trim() || buildAuthorizationCorrelationId();
      const requestId = String(input.request_id || "").trim() || correlationId;

      if (!holderName || !cardNumber || !expiry || !cvv) {
        return authorizationValidationFailure(
          "holder_name, card_number, expiry and cvv are required",
          "payment_details_required"
        );
      }

      if (!/^\d{12,19}$/.test(cardNumber)) {
        return authorizationValidationFailure("card number must contain 12 to 19 digits", "invalid_card_number");
      }

      if (!expiryParts) {
        return authorizationValidationFailure("expiry must be in MM/YY format", "invalid_expiry");
      }

      if (!/^\d{3,4}$/.test(cvv)) {
        return authorizationValidationFailure("cvv must contain 3 or 4 digits", "invalid_cvv");
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
              type: "card",
              card: {
                holder_name: holderName,
                card_number: cardNumber,
                expiry_month: expiryParts.expiry_month,
                expiry_year: expiryParts.expiry_year,
                cvv
              }
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

export function buildPaymentProvider(): PaymentProvider {
  if (PAYMENT_PROVIDER_MODE === "provider-ready") {
    return buildProviderReadyPaymentProvider();
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
    authorization_transport_live: provider.mode === "provider-ready" && provider.configured,
    capture_transport_live: provider.mode === "provider-ready" && provider.configured,
    recovery_transport_live: provider.mode === "provider-ready" && provider.configured,
    refund_transport_live: provider.mode === "provider-ready" && provider.configured,
    timeout_ms: PAYMENT_PROVIDER_TIMEOUT_MS,
    supported_modes: ["mock-backed", "provider-ready"],
    adapter_contract: {
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
