import { createHash } from "node:crypto";
import type {
  AuthorizePaymentInput,
  CapturePaymentInput,
  PaymentAuthorizationResult,
  PaymentExecutionResult,
  PaymentProvider,
  PaymentStatusInput,
  PaymentStatusResult,
  RecoverPaymentInput,
  RefundPaymentInput,
  ReleasePaymentInput
} from "./payment_provider.js";

export type SyntheticOutcome = "success" | "decline" | "temporary_fail" | "unknown" | "expired";
export type SyntheticOperation = "authorize" | "capture" | "recover" | "refund" | "release";
export type SyntheticProviderEvent = {
  event_id: string;
  event_type: "payment_authorized" | "payment_failed" | "charge_captured" | "charge_failed" | "recovery_captured" | "recovery_failed" | "refund_issued" | "authorization_released";
  correlation_id: string;
  provider_reference: string;
  sequence: number;
};

export type SyntheticPaymentScript = Partial<Record<SyntheticOperation, SyntheticOutcome[]>>;

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableReference(operation: string, correlationId: string) {
  return `synthetic_${operation}_${createHash("sha256").update(correlationId).digest("hex").slice(0, 20)}`;
}

export function buildSyntheticPaymentProvider(script: SyntheticPaymentScript = {}) {
  const cursors = new Map<SyntheticOperation, number>();
  const idempotency = new Map<string, { request_hash: string; result: unknown }>();
  const states = new Map<string, PaymentStatusResult["state"]>();
  const events: SyntheticProviderEvent[] = [];
  let sequence = 0;

  function outcome(operation: SyntheticOperation): SyntheticOutcome {
    const values = script[operation] || ["success"];
    const cursor = cursors.get(operation) || 0;
    cursors.set(operation, cursor + 1);
    return values[Math.min(cursor, values.length - 1)] || "success";
  }

  function replay<T>(operation: SyntheticOperation, correlationId: string, input: unknown, create: () => T): T {
    const key = `${operation}:${correlationId}`;
    const requestHash = digest(input);
    const prior = idempotency.get(key);
    if (prior) {
      if (prior.request_hash !== requestHash) throw new Error("synthetic_idempotency_conflict");
      return prior.result as T;
    }
    const result = create();
    idempotency.set(key, { request_hash: requestHash, result });
    return result;
  }

  function emit(eventType: SyntheticProviderEvent["event_type"], correlationId: string, providerReference: string) {
    sequence += 1;
    events.push({ event_id: `synthetic_event_${sequence}`, event_type: eventType, correlation_id: correlationId, provider_reference: providerReference, sequence });
  }

  function execution(operation: "capture" | "recover" | "refund" | "release", input: any): PaymentExecutionResult {
    const correlationId = String(input.correlation_id || `synthetic-${operation}`);
    return replay(operation, correlationId, input, () => {
      const selected = outcome(operation);
      const reference = String(input.capture_reference || input.authorization_id || stableReference(operation, correlationId));
      if (selected === "unknown") return { provider: "synthetic", result_class: "temporary_fail", retryable: true, mock: true, provider_reference: reference, correlation_id: correlationId };
      if (selected === "temporary_fail") return { provider: "synthetic", result_class: "temporary_fail", retryable: true, mock: true, provider_reference: reference, correlation_id: correlationId };
      if (selected === "decline" || selected === "expired") {
        const eventType = operation === "capture" ? "charge_failed" : operation === "recover" ? "recovery_failed" : operation === "release" ? "authorization_released" : "payment_failed";
        emit(eventType, correlationId, reference);
        states.set(reference, operation === "release" ? "released" : "failed");
        return { provider: "synthetic", result_class: "permanent_fail", retryable: false, mock: true, provider_reference: reference, correlation_id: correlationId, ...(operation === "capture" ? { reconciliation_event_type: "charge_failed" as const } : operation === "recover" ? { reconciliation_event_type: "recovery_failed" as const } : {}) };
      }
      const eventType = operation === "capture" ? "charge_captured" : operation === "recover" ? "recovery_captured" : operation === "refund" ? "refund_issued" : "authorization_released";
      emit(eventType, correlationId, reference);
      states.set(reference, operation === "capture" || operation === "recover" ? "captured" : operation === "refund" ? "refunded" : "released");
      return { provider: "synthetic", result_class: "success", retryable: false, mock: true, provider_reference: reference, correlation_id: correlationId, ...(operation === "capture" ? { reconciliation_event_type: "charge_captured" as const } : operation === "recover" ? { reconciliation_event_type: "recovery_captured" as const } : operation === "refund" ? { reconciliation_event_type: "refund_issued" as const } : {}) };
    });
  }

  const provider: PaymentProvider = {
    providerCode: "synthetic",
    mode: "mock-backed",
    webhookProvider: "synthetic",
    configured: true,
    async authorize(input: AuthorizePaymentInput): Promise<PaymentAuthorizationResult> {
      const correlationId = String(input.correlation_id || input.request_id || "synthetic-authorize");
      return replay("authorize", correlationId, input, () => {
        const selected = outcome("authorize");
        const reference = stableReference("authorization", correlationId);
        if (selected === "unknown" || selected === "temporary_fail") return { ok: false, provider: "synthetic", error: selected === "unknown" ? "authorization_unknown" : "authorization_temporarily_unavailable", message: "synthetic provider did not produce a final authorization outcome", statusCode: 503, retryable: true, mock: true };
        if (selected === "decline" || selected === "expired") {
          emit("payment_failed", correlationId, reference);
          states.set(reference, "failed");
          return { ok: false, provider: "synthetic", error: selected === "expired" ? "authorization_expired" : "authorization_declined", message: "synthetic authorization was not approved", statusCode: 402, retryable: false, mock: true };
        }
        emit("payment_authorized", correlationId, reference);
        states.set(reference, "authorized");
        return { ok: true, provider: "synthetic", authorization_id: reference, provider_reference: reference, correlation_id: correlationId, authorization: "authorized", hold_message: "Synthetic authorization only; no external network or money.", mock: true };
      });
    },
    async capture(input: CapturePaymentInput) { return execution("capture", input); },
    async recover(input: RecoverPaymentInput, withinWindow: boolean) {
      if (!withinWindow) return { provider: "synthetic", result_class: "permanent_fail", retryable: false, mock: true, provider_reference: input.authorization_id || null, correlation_id: input.correlation_id || null, reconciliation_event_type: "recovery_failed" };
      return execution("recover", input);
    },
    async refund(input: RefundPaymentInput) { return execution("refund", input); },
    async release(input: ReleasePaymentInput) { return execution("release", input); },
    async status(input: PaymentStatusInput): Promise<PaymentStatusResult> {
      const state = states.get(input.provider_reference) || "unknown";
      return { provider: "synthetic", provider_reference: input.provider_reference, correlation_id: input.correlation_id, state, amount_minor: null, currency: "ILS", provider_time: null, final: state !== "unknown" && state !== "pending", error_code: state === "unknown" ? "synthetic_outcome_unknown" : null };
    }
  };

  return {
    provider,
    events,
    duplicateLastEvent() {
      const last = events.at(-1);
      if (last) events.push({ ...last });
    },
    deliverOutOfOrder() {
      return [...events].sort((left, right) => right.sequence - left.sequence);
    },
    expireAuthorization(reference: string) { states.set(reference, "failed"); },
    snapshot() { return { operations: Object.fromEntries(cursors), idempotency_entries: idempotency.size, states: Object.fromEntries(states), events: [...events] }; }
  };
}
