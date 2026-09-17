import { createHash } from "node:crypto";
import type {
  AuthorizePaymentInput,
  CapturePaymentInput,
  PaymentAuthorizationResult,
  PaymentExecutionResult,
  PaymentProvider,
  PaymentStatusInput,
  PaymentStatusResult,
  ReauthorizePaymentInput,
  RecoverPaymentInput,
  RefundPaymentInput,
  ReleasePaymentInput
} from "./payment_provider.js";

export type SyntheticOutcome = "success" | "decline" | "temporary_fail" | "unknown" | "expired";
export type SyntheticOperation = "authorize" | "reauthorize" | "capture" | "recover" | "refund" | "release";
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

export type SyntheticProviderOptions = {
  /**
   * LONG_HORIZON_DEALS — declared validity of every authorization this
   * provider creates (ms), or null for "no declared validity" (default). Lets a
   * lifecycle test create a join-time authorization that is already past its
   * validity by the time the deal charges.
   */
  authorization_ttl_ms?: number | null;
};

export function buildSyntheticPaymentProvider(script: SyntheticPaymentScript = {}, options: SyntheticProviderOptions = {}) {
  const cursors = new Map<SyntheticOperation, number>();
  const idempotency = new Map<string, { request_hash: string; result: unknown }>();
  const states = new Map<string, PaymentStatusResult["state"]>();
  // LONG_HORIZON_DEALS — authorizations the lab has expired (never capturable)
  const expired = new Set<string>();
  const events: SyntheticProviderEvent[] = [];
  let sequence = 0;
  const declaredExpiry = () => (options.authorization_ttl_ms === null || options.authorization_ttl_ms === undefined)
    ? null
    : new Date(Date.now() + Number(options.authorization_ttl_ms)).toISOString();

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
      // LONG_HORIZON_DEALS — a capture-side operation on an EXPIRED authorization
      // is a provider-declared failure of the INSTRUMENT: nothing is charged,
      // and the rails may re-establish the authorization instead of failing the
      // buyer. The scripted outcome is not consumed (the request never became a
      // real attempt at the provider).
      if ((operation === "capture" || operation === "recover") && expired.has(reference)) {
        cursors.set(operation, (cursors.get(operation) || 1) - 1);
        const eventType = operation === "capture" ? "charge_failed" : "recovery_failed";
        emit(eventType, correlationId, reference);
        return { provider: "synthetic", result_class: "permanent_fail", retryable: false, mock: true, dispatched: true, provider_reference: reference, correlation_id: correlationId, reconciliation_event_type: eventType, authorization_unusable: true, failure_code: "authorization_expired" };
      }
      // Synthetic lab: neither outcome moves anything outside this process, so
      // both are honest PRE-dispatch failures (dispatched: false) — the rails may
      // retry them with the SAME durable identity.
      if (selected === "unknown") return { provider: "synthetic", result_class: "temporary_fail", retryable: true, mock: true, dispatched: false, provider_reference: reference, correlation_id: correlationId };
      if (selected === "temporary_fail") return { provider: "synthetic", result_class: "temporary_fail", retryable: true, mock: true, dispatched: false, provider_reference: reference, correlation_id: correlationId };
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
    ambiguityPolicy: {
      same_identity_repeat_safe: true,
      negative_status_authoritative: true,
      settlement_horizon_ms: 0,
      basis: "synthetic in-process provider: no external side effects; idempotency replay table per correlation; settles synchronously (no settlement horizon)"
    },
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
        return { ok: true, provider: "synthetic", authorization_id: reference, provider_reference: reference, correlation_id: correlationId, authorization: "authorized", hold_message: "Synthetic authorization only; no external network or money.", mock: true, expires_at: declaredExpiry() };
      });
    },
    // LONG_HORIZON_DEALS — stored-instrument re-authorization: a NEW
    // authorization reference for the same obligation, idempotent on the
    // worker's durable identity (replay returns the same reference), scripted
    // like every other operation.
    async reauthorize(input: ReauthorizePaymentInput): Promise<PaymentAuthorizationResult> {
      const correlationId = String(input.correlation_id || "");
      if (!String(input.payment_method_ref || "").trim() || !correlationId) {
        return { ok: false, provider: "synthetic", error: "payment_method_ref_required", message: "payment_method_ref and correlation_id are required", statusCode: 400, retryable: false, mock: true, dispatched: false };
      }
      return replay("reauthorize", correlationId, input, () => {
        const selected = outcome("reauthorize");
        const reference = stableReference("reauthorization", correlationId);
        if (selected === "unknown" || selected === "temporary_fail") return { ok: false, provider: "synthetic", error: selected === "unknown" ? "reauthorization_unknown" : "reauthorization_temporarily_unavailable", message: "synthetic provider did not produce a final re-authorization outcome", statusCode: 503, retryable: true, mock: true, dispatched: true };
        if (selected === "decline" || selected === "expired") {
          emit("payment_failed", correlationId, reference);
          states.set(reference, "failed");
          return { ok: false, provider: "synthetic", error: "reauthorization_declined", message: "synthetic re-authorization was not approved", statusCode: 402, retryable: false, mock: true, dispatched: true };
        }
        emit("payment_authorized", correlationId, reference);
        states.set(reference, "authorized");
        return { ok: true, provider: "synthetic", authorization_id: reference, provider_reference: reference, correlation_id: correlationId, authorization: "authorized", hold_message: "Synthetic re-authorization from the stored payment method; no external network or money.", mock: true, expires_at: declaredExpiry() };
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
      // an expired authorization is authoritatively NOT capturable: "failed"
      // for capture-side questions, with the instrument reason named
      const expiredNow = expired.has(input.provider_reference) && state === "authorized";
      return { provider: "synthetic", provider_reference: input.provider_reference, correlation_id: input.correlation_id, state: expiredNow ? "failed" : state, amount_minor: null, currency: "ILS", provider_time: null, final: state !== "unknown" && state !== "pending", error_code: expiredNow ? "authorization_expired" : state === "unknown" ? "synthetic_outcome_unknown" : null };
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
    /** LONG_HORIZON_DEALS — the provider-side hold lapsed: the reference is no longer capturable (status reads say failed/authorization_expired) */
    expireAuthorization(reference: string) { expired.add(reference); },
    isExpired(reference: string) { return expired.has(reference); },
    snapshot() { return { operations: Object.fromEntries(cursors), idempotency_entries: idempotency.size, states: Object.fromEntries(states), events: [...events] }; }
  };
}
