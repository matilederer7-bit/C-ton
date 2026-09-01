import { assertRequiredTables } from "./schema_contract.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type PaymentBindingStatus =
  | "pending_provider_confirmation"
  | "authorized"
  | "consumed"
  | "expired"
  | "released"
  | "failed";

export type PaymentAuthorizationBinding = {
  binding_id: string;
  provider_code: string;
  provider_mode: string;
  provider_environment: string;
  authorization_id: string;
  provider_reference: string;
  deal_id: string;
  buyer_id: string;
  qty: number;
  amount_minor: number;
  currency: string;
  delivery_option_id: string | null;
  delivery_cost: number;
  status: PaymentBindingStatus;
  status_reason: string | null;
  correlation_id: string;
  consumed_by_participant_id: string | null;
  consumed_at: string | null;
  expires_at: string | null;
};

export class PaymentBindingError extends Error {
  constructor(readonly code: string, message?: string, readonly statusCode = 409) {
    super(message || code);
    this.name = "PaymentBindingError";
  }
}

const BINDING_COLUMNS = `
  binding_id, provider_code, provider_mode, provider_environment,
  authorization_id, provider_reference, deal_id, buyer_id,
  qty, amount_minor, currency, delivery_option_id, delivery_cost,
  status, status_reason, correlation_id,
  consumed_by_participant_id, consumed_at, expires_at`;

function toBinding(row: any): PaymentAuthorizationBinding {
  return {
    ...row,
    qty: Number(row.qty),
    amount_minor: Number(row.amount_minor),
    delivery_cost: Number(row.delivery_cost || 0)
  } as PaymentAuthorizationBinding;
}

export function buildPaymentAuthorizationBindings(deps: { withTx: WithTx }) {
  async function ensureStorage() {
    await deps.withTx(async (c) => assertRequiredTables(c, ["payment_authorization_bindings"]));
  }

  /**
   * Durably record a server-created provider authorization intent. Idempotent
   * on correlation_id: a replay returns the existing row unchanged.
   */
  async function createBinding(input: {
    provider_code: string;
    provider_mode: string;
    provider_environment: string;
    authorization_id: string;
    provider_reference: string;
    deal_id: string;
    buyer_id: string;
    qty: number;
    amount_minor: number;
    currency: string;
    delivery_option_id?: string | null;
    delivery_cost?: number;
    status: "pending_provider_confirmation" | "authorized";
    correlation_id: string;
    expires_at?: Date | string | null;
  }): Promise<PaymentAuthorizationBinding> {
    return deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.payment_authorization_bindings (
           provider_code, provider_mode, provider_environment,
           authorization_id, provider_reference, deal_id, buyer_id,
           qty, amount_minor, currency, delivery_option_id, delivery_cost,
           status, correlation_id, expires_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (correlation_id) DO NOTHING
         RETURNING ${BINDING_COLUMNS}`,
        [
          input.provider_code,
          input.provider_mode,
          input.provider_environment,
          input.authorization_id,
          input.provider_reference,
          input.deal_id,
          input.buyer_id,
          input.qty,
          input.amount_minor,
          input.currency,
          input.delivery_option_id ?? null,
          Number(input.delivery_cost || 0),
          input.status,
          input.correlation_id,
          input.expires_at ? new Date(input.expires_at).toISOString() : null
        ]
      );
      if (inserted.rowCount) return toBinding(inserted.rows[0]);
      const existing = await c.query(
        `SELECT ${BINDING_COLUMNS}
         FROM siton.payment_authorization_bindings
         WHERE correlation_id=$1`,
        [input.correlation_id]
      );
      return toBinding(existing.rows[0]);
    });
  }

  /**
   * Flip a pending hosted authorization to 'authorized' after an AUTHORITATIVE
   * server-to-provider proof (status lookup / verified webhook). Browser
   * redirects never call this directly with authority — the caller must have
   * performed the provider query server-side. Amount mismatch fails closed.
   */
  async function confirmBindingAuthorized(input: {
    provider_code: string;
    authorization_id: string;
    provider_amount_minor?: number | null;
    provider_reference?: string | null;
  }): Promise<PaymentAuthorizationBinding | null> {
    // Errors are thrown AFTER the transaction commits so a fail-closed write
    // (e.g. the durable provider_amount_mismatch failure) is never rolled
    // back by its own error signal.
    const outcome = await deps.withTx(async (c): Promise<
      | { kind: "ok"; binding: PaymentAuthorizationBinding | null }
      | { kind: "error"; code: string; message: string }
    > => {
      const found = await c.query(
        `SELECT ${BINDING_COLUMNS}
         FROM siton.payment_authorization_bindings
         WHERE provider_code=$1 AND authorization_id=$2
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.provider_code, input.authorization_id]
      );
      if (!found.rowCount) return { kind: "ok", binding: null };
      const binding = toBinding(found.rows[0]);
      if (binding.status === "authorized" || binding.status === "consumed") return { kind: "ok", binding };
      if (binding.status !== "pending_provider_confirmation") {
        return {
          kind: "error",
          code: "payment_binding_not_confirmable",
          message: `binding ${binding.binding_id} is ${binding.status}`
        };
      }
      if (
        input.provider_amount_minor !== undefined &&
        input.provider_amount_minor !== null &&
        Number(input.provider_amount_minor) !== binding.amount_minor
      ) {
        await c.query(
          `UPDATE siton.payment_authorization_bindings
           SET status='failed', status_reason='provider_amount_mismatch'
           WHERE binding_id=$1`,
          [binding.binding_id]
        );
        return {
          kind: "error",
          code: "payment_binding_amount_mismatch",
          message: `provider reported ${input.provider_amount_minor}, binding requires ${binding.amount_minor}`
        };
      }
      const updated = await c.query(
        `UPDATE siton.payment_authorization_bindings
         SET status='authorized',
             status_reason='provider_status_confirmed',
             provider_reference=COALESCE(NULLIF($2,''), provider_reference)
         WHERE binding_id=$1 AND status='pending_provider_confirmation'
         RETURNING ${BINDING_COLUMNS}`,
        [binding.binding_id, String(input.provider_reference || "")]
      );
      return { kind: "ok", binding: updated.rowCount ? toBinding(updated.rows[0]) : binding };
    });
    if (outcome.kind === "error") throw new PaymentBindingError(outcome.code, outcome.message);
    return outcome.binding;
  }

  /**
   * Consume a binding for Join — MUST run on the Join transaction client so
   * consumption commits or rolls back atomically with the participant's
   * AuthHeld transition. Every mismatch fails closed with a typed error.
   */
  async function consumeBindingForJoinTx(c: any, input: {
    deal_id: string;
    buyer_id: string;
    authorization_id: string;
    participant_id: string;
    expected_provider_code: string;
    expected_provider_mode: string;
    expected_provider_environment: string;
    expected_qty: number;
    expected_amount_minor: number;
    expected_currency: string;
  }): Promise<PaymentAuthorizationBinding> {
    // Prefer the newest CONSUMABLE binding: a buyer legitimately re-purchasing
    // with the same payment method produces multiple bindings under one
    // authorization handle; already-consumed rows must not shadow a fresh
    // authorized one. When none is authorized, the newest row drives the
    // precise fail-closed error.
    const found = await c.query(
      `SELECT ${BINDING_COLUMNS}
       FROM siton.payment_authorization_bindings
       WHERE authorization_id=$1
         AND deal_id=$2
         AND buyer_id=$3
       ORDER BY (status='authorized') DESC, created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [input.authorization_id, input.deal_id, input.buyer_id]
    );
    if (!found.rowCount) {
      // Distinguish "wrong deal/buyer" from "never existed" only in the error
      // detail; both fail closed identically.
      throw new PaymentBindingError(
        "payment_authorization_not_found",
        "no server-side authorization binding matches this deal, buyer and authorization reference",
        402
      );
    }
    const binding = toBinding(found.rows[0]);
    if (binding.status === "consumed") {
      throw new PaymentBindingError(
        "payment_authorization_already_consumed",
        "this authorization was already used for a join"
      );
    }
    if (binding.status === "pending_provider_confirmation") {
      throw new PaymentBindingError(
        "payment_authorization_not_confirmed",
        "the provider has not authoritatively confirmed this authorization yet",
        402
      );
    }
    if (binding.status !== "authorized") {
      throw new PaymentBindingError(
        "payment_authorization_not_consumable",
        `authorization binding is ${binding.status}`,
        402
      );
    }
    if (binding.expires_at && new Date(binding.expires_at).getTime() <= Date.now()) {
      // Enforced at consume time on every attempt. (No status write here: the
      // surrounding Join transaction is about to roll back, so a persisted
      // update would be lost anyway.)
      throw new PaymentBindingError("payment_authorization_expired", "authorization expired before join", 402);
    }
    if (binding.provider_code !== input.expected_provider_code) {
      throw new PaymentBindingError(
        "payment_authorization_provider_mismatch",
        `binding provider ${binding.provider_code} does not match runtime provider ${input.expected_provider_code}`
      );
    }
    if (
      binding.provider_mode !== input.expected_provider_mode ||
      binding.provider_environment !== input.expected_provider_environment
    ) {
      throw new PaymentBindingError(
        "payment_authorization_environment_mismatch",
        "binding was created under a different provider mode/environment"
      );
    }
    if (binding.qty !== Number(input.expected_qty)) {
      throw new PaymentBindingError(
        "payment_authorization_quantity_mismatch",
        `authorization covers qty ${binding.qty}, join requested ${input.expected_qty}`
      );
    }
    if (binding.amount_minor !== Number(input.expected_amount_minor)) {
      throw new PaymentBindingError(
        "payment_authorization_amount_mismatch",
        `authorization covers ${binding.amount_minor} minor units, authoritative amount is ${input.expected_amount_minor}`
      );
    }
    if (binding.currency !== input.expected_currency) {
      throw new PaymentBindingError("payment_authorization_currency_mismatch");
    }
    const consumed = await c.query(
      `UPDATE siton.payment_authorization_bindings
       SET status='consumed',
           status_reason='join_consumed',
           consumed_by_participant_id=$2,
           consumed_at=now()
       WHERE binding_id=$1 AND status='authorized' AND consumed_at IS NULL
       RETURNING ${BINDING_COLUMNS}`,
      [binding.binding_id, input.participant_id]
    );
    if (consumed.rowCount !== 1) {
      throw new PaymentBindingError(
        "payment_authorization_already_consumed",
        "this authorization was concurrently consumed"
      );
    }
    return toBinding(consumed.rows[0]);
  }

  /**
   * Correlate a provider callback to the server-owned binding it belongs to.
   * Lookup only — never mutates; callers must still obtain authoritative
   * provider proof before any status change.
   */
  async function getBindingByCorrelation(correlationId: string): Promise<PaymentAuthorizationBinding | null> {
    if (!String(correlationId || "").trim()) return null;
    return deps.withTx(async (c) => {
      const r = await c.query(
        `SELECT ${BINDING_COLUMNS}
         FROM siton.payment_authorization_bindings
         WHERE correlation_id=$1`,
        [correlationId]
      );
      return r.rowCount ? toBinding(r.rows[0]) : null;
    });
  }

  async function getConsumedBindingForParticipant(participantId: string): Promise<PaymentAuthorizationBinding | null> {
    return deps.withTx(async (c) => {
      const r = await c.query(
        `SELECT ${BINDING_COLUMNS}
         FROM siton.payment_authorization_bindings
         WHERE consumed_by_participant_id=$1`,
        [participantId]
      );
      return r.rowCount ? toBinding(r.rows[0]) : null;
    });
  }

  /**
   * Refresh the durable provider reference after a provider call returned a
   * newer opaque reference (e.g. a sealed reference now carrying transaction
   * credentials). The binding is the indexed operational lookup source; audit
   * JSON stays evidence only.
   */
  async function updateProviderReferenceForParticipant(participantId: string, providerReference: string) {
    if (!String(providerReference || "").trim()) return;
    await deps.withTx(async (c) => {
      await c.query(
        `UPDATE siton.payment_authorization_bindings
         SET provider_reference=$2
         WHERE consumed_by_participant_id=$1`,
        [participantId, providerReference]
      );
    });
  }

  async function markBindingReleasedForParticipant(participantId: string, reason: string) {
    await deps.withTx(async (c) => {
      await c.query(
        `UPDATE siton.payment_authorization_bindings
         SET status_reason=$2
         WHERE consumed_by_participant_id=$1`,
        [participantId, String(reason || "released").slice(0, 200)]
      );
    });
  }

  return {
    ensureStorage,
    createBinding,
    confirmBindingAuthorized,
    consumeBindingForJoinTx,
    getBindingByCorrelation,
    getConsumedBindingForParticipant,
    updateProviderReferenceForParticipant,
    markBindingReleasedForParticipant
  };
}
