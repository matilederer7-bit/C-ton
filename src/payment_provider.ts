import { createHash } from "crypto";
import {
  MOCK_SEED,
  PAYMENT_AUTH_DECLINE_SUFFIX,
  PAYMENT_PROVIDER,
  PAYMENT_WEBHOOK_PROVIDER
} from "./runtime_config.js";

export type PaymentResultClass = "success" | "permanent_fail" | "temporary_fail";

export type PaymentAuthorizationResult =
  | {
      ok: true;
      provider: string;
      authorization_id: string;
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
};

export type AuthorizePaymentInput = {
  holder_name: string;
  card_number: string;
  expiry: string;
  cvv: string;
};

export interface PaymentProvider {
  readonly providerCode: string;
  readonly mode: "mock-backed";
  readonly webhookProvider: string;
  authorize(input: AuthorizePaymentInput): Promise<PaymentAuthorizationResult>;
  capture(correlationKey: string): Promise<PaymentExecutionResult>;
  recover(correlationKey: string, withinWindow: boolean): Promise<PaymentExecutionResult>;
  refund(correlationKey: string): Promise<PaymentExecutionResult>;
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
  return (x >>> 0) / 0xffffffff;
}

function paymentAuthorizationId(cardNumber: string) {
  return `auth_${createHash("sha256").update(cardNumber).digest("hex").slice(0, 12)}`;
}

function buildMockPaymentProvider(): PaymentProvider {
  return {
    providerCode: PAYMENT_PROVIDER,
    mode: "mock-backed",
    webhookProvider: PAYMENT_WEBHOOK_PROVIDER,
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
        authorization: "authorized",
        hold_message: "Authorization accepted. Final capture happens only if the deal completes successfully.",
        mock: true
      };
    },
    async capture(correlationKey: string): Promise<PaymentExecutionResult> {
      const r = rand01Deterministic(correlationKey);
      if (r < 0.75) return { provider: PAYMENT_PROVIDER, result_class: "success", retryable: false, mock: true };
      if (r < 0.9) return { provider: PAYMENT_PROVIDER, result_class: "temporary_fail", retryable: true, mock: true };
      return { provider: PAYMENT_PROVIDER, result_class: "permanent_fail", retryable: false, mock: true };
    },
    async recover(correlationKey: string, withinWindow: boolean): Promise<PaymentExecutionResult> {
      if (!withinWindow) return { provider: PAYMENT_PROVIDER, result_class: "permanent_fail", retryable: false, mock: true };
      const r = rand01Deterministic(correlationKey);
      if (r < 0.5) return { provider: PAYMENT_PROVIDER, result_class: "success", retryable: false, mock: true };
      if (r < 0.8) return { provider: PAYMENT_PROVIDER, result_class: "temporary_fail", retryable: true, mock: true };
      return { provider: PAYMENT_PROVIDER, result_class: "permanent_fail", retryable: false, mock: true };
    },
    async refund(correlationKey: string): Promise<PaymentExecutionResult> {
      const r = rand01Deterministic(correlationKey);
      if (r < 0.8) return { provider: PAYMENT_PROVIDER, result_class: "success", retryable: false, mock: true };
      if (r < 0.95) return { provider: PAYMENT_PROVIDER, result_class: "temporary_fail", retryable: true, mock: true };
      return { provider: PAYMENT_PROVIDER, result_class: "permanent_fail", retryable: false, mock: true };
    }
  };
}

export function buildPaymentProvider(): PaymentProvider {
  return buildMockPaymentProvider();
}

export function getPaymentProviderSummary(provider: PaymentProvider) {
  return {
    provider: provider.providerCode,
    mode: provider.mode,
    webhook_provider: provider.webhookProvider,
    mock_backed: true,
    decline_suffix: PAYMENT_AUTH_DECLINE_SUFFIX
  };
}
