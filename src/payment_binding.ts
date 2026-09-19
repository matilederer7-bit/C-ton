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
  provider_payment_url: string | null;
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
  /** provider-declared validity of the CURRENT authorization (technical instrument property, never a deal bound) */
  expires_at: string | null;
  // LONG_HORIZON_DEALS (migration 071) — renewal metadata of the current instrument
  payment_method_ref: string | null;
  authorization_established_at: string;
  renewal_count: number;
  renewed_at: string | null;
  replaced_authorization_id: string | null;
};

export class PaymentBindingError extends Error {
  constructor(readonly code: string, message?: string, readonly statusCode = 409) {
    super(message || code);
    this.name = "PaymentBindingError";
  }
}

const BINDING_COLUMNS = `
  binding_id, provider_code, provider_mode, provider_environment,
  authorization_id, provider_reference, provider_payment_url, deal_id, buyer_id,
  qty, amount_minor, currency, delivery_option_id, delivery_cost,
  status, status_reason, correlation_id,
  consumed_by_participant_id, consumed_at, expires_at,
  payment_method_ref, authorization_established_at, renewal_count, renewed_at, replaced_authorization_id`;

function toBinding(row: any): PaymentAuthorizationBinding {
  return {
    ...row,
    qty: Number(row.qty),
    amount_minor: Number(row.amount_minor),
    delivery_cost: Number(row.delivery_cost || 0),
    renewal_count: Number(row.renewal_count || 0)
  } as PaymentAuthorizationBinding;
}

export function buildPaymentAuthorizationBindings(deps: { withTx: WithTx }) {
  async function ensureStorage() {
    await deps.withTx(async (c) => assertRequiredTables(c, ["payment_authorization_bindings"]));
  }

  /**
   * Reserve one external authorization CREATE intent before provider I/O.
   *
   * Grow's hosted J4/J5 create contract exposes no provider idempotency key, so
   * correlation_id is the durable Siton identity. The reservation prevents two
   * Web instances (double click / network retry / concurrent replay) from both
   * dispatching createPaymentProcess. A replay with the same identity returns
   * the existing row; the caller must never perform provider I/O again.
   */
  async function reserveAuthorizationCreation(input: {
    provider_code: string;
    provider_mode: string;
    provider_environment: string;
    correlation_id: string;
    deal_id: string;
    buyer_id: string;
    qty: number;
    amount_minor: number;
    currency: string;
    delivery_option_id?: string | null;
    delivery_cost?: number;
  }): Promise<{ created: boolean; binding: PaymentAuthorizationBinding }> {
    return deps.withTx(async (c) => {
      const placeholder = `siton_create_pending:${input.correlation_id}`;
      const inserted = await c.query(
        `INSERT INTO siton.payment_authorization_bindings (
           provider_code, provider_mode, provider_environment,
           authorization_id, provider_reference, provider_payment_url,
           deal_id, buyer_id, qty, amount_minor, currency,
           delivery_option_id, delivery_cost, status, status_reason, correlation_id
         )
         VALUES ($1,$2,$3,$4,$4,NULL,$5,$6,$7,$8,$9,$10,$11,
                 'pending_provider_confirmation','provider_create_reserved',$12)
         ON CONFLICT (correlation_id) DO NOTHING
         RETURNING ${BINDING_COLUMNS}`,
        [
          input.provider_code,
          input.provider_mode,
          input.provider_environment,
          placeholder,
          input.deal_id,
          input.buyer_id,
          input.qty,
          input.amount_minor,
          input.currency,
          input.delivery_option_id ?? null,
          Number(input.delivery_cost || 0),
          input.correlation_id
        ]
      );
      if (inserted.rowCount) return { created: true, binding: toBinding(inserted.rows[0]) };

      const existing = await c.query(
        `SELECT ${BINDING_COLUMNS}
         FROM siton.payment_authorization_bindings
         WHERE correlation_id=$1
         FOR UPDATE`,
        [input.correlation_id]
      );
      if (!existing.rowCount) {
        throw new PaymentBindingError(
          "payment_authorization_intent_missing",
          "authorization intent disappeared after correlation conflict",
          409
        );
      }
      const binding = toBinding(existing.rows[0]);
      const sameIntent =
        binding.provider_code === input.provider_code &&
        binding.provider_mode === input.provider_mode &&
        binding.provider_environment === input.provider_environment &&
        binding.deal_id === input.deal_id &&
        binding.buyer_id === input.buyer_id &&
        binding.qty === Number(input.qty) &&
        binding.amount_minor === Number(input.amount_minor) &&
        binding.currency === input.currency &&
        (binding.delivery_option_id || null) === (input.delivery_option_id || null) &&
        Number(binding.delivery_cost || 0) === Number(input.delivery_cost || 0);
      if (!sameIntent) {
        throw new PaymentBindingError(
          "payment_authorization_idempotency_payload_mismatch",
          "the idempotency key was already used for a different authorization intent",
          409
        );
      }
      return { created: false, binding };
    });
  }

  /**
   * Finalize the pre-dispatch reservation after a successful provider CREATE.
   * The hosted payment URL is customer-facing provider output and is persisted
   * only so an exact HTTP replay can return the first response without another
   * provider side effect.
   */
  async function completeAuthorizationCreation(input: {
    correlation_id: string;
    authorization_id: string;
    provider_reference: string;
    provider_payment_url: string;
    status: "pending_provider_confirmation" | "authorized";
    expires_at?: Date | string | null;
    payment_method_ref?: string | null;
  }): Promise<PaymentAuthorizationBinding> {
    return deps.withTx(async (c) => {
      const updated = await c.query(
        `UPDATE siton.payment_authorization_bindings
         SET authorization_id=$2,
             provider_reference=$3,
             provider_payment_url=$4,
             status=$5,
             status_reason='provider_create_succeeded',
             expires_at=$6,
             payment_method_ref=NULLIF($7,'')
         WHERE correlation_id=$1
           AND status='pending_provider_confirmation'
           AND status_reason IN ('provider_create_reserved','provider_create_outcome_unknown')
         RETURNING ${BINDING_COLUMNS}`,
        [
          input.correlation_id,
          input.authorization_id,
          input.provider_reference,
          input.provider_payment_url,
          input.status,
          input.expires_at ? new Date(input.expires_at).toISOString() : null,
          String(input.payment_method_ref || "").trim().slice(0, 200)
        ]
      );
      if (updated.rowCount) return toBinding(updated.rows[0]);

      const existing = await c.query(
        `SELECT ${BINDING_COLUMNS}
         FROM siton.payment_authorization_bindings
         WHERE correlation_id=$1`,
        [input.correlation_id]
      );
      if (!existing.rowCount) {
        throw new PaymentBindingError(
          "payment_authorization_intent_missing",
          "authorization reservation was not found during provider completion",
          409
        );
      }
      const binding = toBinding(existing.rows[0]);
      if (
        binding.authorization_id === input.authorization_id &&
        binding.provider_reference === input.provider_reference &&
        binding.provider_payment_url === input.provider_payment_url
      ) return binding;
      throw new PaymentBindingError(
        "payment_authorization_intent_not_completable",
        `authorization intent is ${binding.status} / ${binding.status_reason || "unknown"}`,
        409
      );
    });
  }

  /**
   * Record the provider CREATE outcome without losing the reservation.
   * UNKNOWN stays pending and permanently blocks blind automatic replay.
   * An explicit provider rejection becomes failed; a fresh buyer intent must
   * use a fresh idempotency key.
   */
  async function markAuthorizationCreationOutcome(
    correlationId: string,
    outcome: "unknown" | "failed",
    reason: string
  ): Promise<PaymentAuthorizationBinding | null> {
    return deps.withTx(async (c) => {
      const r = await c.query(
        `UPDATE siton.payment_authorization_bindings
         SET status=CASE WHEN $2='failed' THEN 'failed' ELSE status END,
             status_reason=CASE WHEN $2='failed'
               THEN 'provider_create_rejected:' || left($3,160)
               ELSE 'provider_create_outcome_unknown:' || left($3,160)
             END
         WHERE correlation_id=$1
           AND status='pending_provider_confirmation'
         RETURNING ${BINDING_COLUMNS}`,
        [correlationId, outcome, String(reason || "provider_create_outcome").slice(0, 160)]
      );
      return r.rowCount ? toBinding(r.rows[0]) : null;
    });
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
    /** provider-side stored payment-method reference (opaque; never card data) — lets the worker renew the authorization later */
    payment_method_ref?: string | null;
  }): Promise<PaymentAuthorizationBinding> {
    return deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.payment_authorization_bindings (
           provider_code, provider_mode, provider_environment,
           authorization_id, provider_reference, deal_id, buyer_id,
           qty, amount_minor, currency, delivery_option_id, delivery_cost,
           status, correlation_id, expires_at, payment_method_ref
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
          input.expires_at ? new Date(input.expires_at).toISOString() : null,
          String(input.payment_method_ref || "").trim().slice(0, 200) || null
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
      // PRE-commitment only: an authorization that lapsed before the buyer ever
      // joined cannot back a new commitment — the buyer re-authorizes and joins
      // again. This is NOT the long-horizon rule: once a participant is
      // committed, expiry of its authorization is a payment-maintenance event
      // handled by the worker (renewal at the charging boundary), never a
      // reason to drop the participant (migration 071).
      // (No status write here: the surrounding Join transaction is about to
      // roll back, so a persisted update would be lost anyway.)
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

  // -------------------------------------------------------------------------
  // LONG_HORIZON_DEALS — renewal of the CURRENT authorization instrument.
  // -------------------------------------------------------------------------

  /**
   * Where a renewal can draw its stored instrument from: the binding's own
   * payment_method_ref (recorded at authorize time), else the buyer's newest
   * active stored method for the same provider (e.g. one supplied through the
   * recovery route). Null when nothing tokenized is known — the worker then
   * lets the provider decide on the original authorization.
   */
  async function resolveRenewalSourceForParticipant(participantId: string, providerCode: string): Promise<{
    binding: PaymentAuthorizationBinding | null;
    payment_method_ref: string | null;
    source: "binding" | "buyer_payment_methods" | null;
  }> {
    return deps.withTx(async (c) => {
      const r = await c.query(
        `SELECT ${BINDING_COLUMNS}
         FROM siton.payment_authorization_bindings
         WHERE consumed_by_participant_id=$1`,
        [participantId]
      );
      const binding = r.rowCount ? toBinding(r.rows[0]) : null;
      if (!binding) return { binding: null, payment_method_ref: null, source: null };
      if (binding.payment_method_ref) return { binding, payment_method_ref: binding.payment_method_ref, source: "binding" as const };
      const stored = await c.query(
        `SELECT provider_payment_method_id
         FROM siton.buyer_payment_methods
         WHERE buyer_id=$1 AND provider_code=$2 AND status='active'
         ORDER BY COALESCE(last_authorized_at, created_at) DESC, created_at DESC
         LIMIT 1`,
        [binding.buyer_id, providerCode]
      ).catch(() => ({ rowCount: 0, rows: [] as any[] }));
      const ref = stored.rowCount ? String(stored.rows[0].provider_payment_method_id || "").trim() : "";
      return { binding, payment_method_ref: ref || null, source: ref ? ("buyer_payment_methods" as const) : null };
    });
  }

  /**
   * Replace the participant's current authorization with a freshly established
   * one, in the caller's transaction (the same one that settles the
   * 'reauthorize' identity as success — atomic: either both commit or neither).
   * Idempotent: a replay carrying the authorization already current is a no-op.
   * The previous instrument is recorded (replaced_authorization_id) and the
   * complete chain stays in siton.payment_attempts.
   */
  async function applyAuthorizationRenewalInTx(c: any, input: {
    participant_id: string;
    new_authorization_id: string;
    new_provider_reference: string;
    expires_at?: Date | string | null;
    correlation_id: string;
  }): Promise<"renewed" | "already_current" | "missing"> {
    const found = await c.query(
      `SELECT ${BINDING_COLUMNS}
       FROM siton.payment_authorization_bindings
       WHERE consumed_by_participant_id=$1
       FOR UPDATE`,
      [input.participant_id]
    );
    if (!found.rowCount) return "missing";
    const current = toBinding(found.rows[0]);
    if (current.authorization_id === input.new_authorization_id) return "already_current";
    await c.query(
      `UPDATE siton.payment_authorization_bindings
       SET replaced_authorization_id=authorization_id,
           authorization_id=$2,
           provider_reference=$3,
           expires_at=$4,
           authorization_established_at=now(),
           renewal_count=renewal_count+1,
           renewed_at=now(),
           status_reason=$5
       WHERE binding_id=$1`,
      [
        current.binding_id,
        input.new_authorization_id,
        input.new_provider_reference || input.new_authorization_id,
        input.expires_at ? new Date(input.expires_at).toISOString() : null,
        `authorization_renewed:${String(input.correlation_id).slice(0, 160)}`
      ]
    );
    return "renewed";
  }

  /**
   * The provider declared the CURRENT authorization unusable (expired / voided)
   * in its answer to a capture-side request: record that the instrument is not
   * valid past now, so a retry after a crash renews first instead of
   * dispatching the same doomed capture again. Never touches the participant.
   */
  async function markAuthorizationUnusableInTx(c: any, participantId: string, reason: string): Promise<boolean> {
    const r = await c.query(
      `UPDATE siton.payment_authorization_bindings
       SET expires_at=LEAST(COALESCE(expires_at, now()), now()),
           status_reason=$2
       WHERE consumed_by_participant_id=$1`,
      [participantId, `authorization_unusable:${String(reason || "provider_declared").slice(0, 160)}`]
    );
    return Number(r.rowCount || 0) === 1;
  }

  /**
   * Payment-maintenance observability (never a product state): committed
   * participants whose CURRENT authorization is past its declared validity.
   * They are renewal candidates at the charging boundary; the count is a
   * maintenance signal for admins, not an alert that a deal is invalid.
   */
  async function countCommittedPastDeclaredValidity(): Promise<number> {
    return deps.withTx(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n
         FROM siton.payment_authorization_bindings b
         JOIN siton.participants p ON p.participant_id = b.consumed_by_participant_id
         WHERE b.status='consumed' AND b.expires_at IS NOT NULL AND b.expires_at <= now()
           AND p.money_state IN ('AuthHeld','AuthLocked','ChargeAttempt','ChargeFailedRecovery')`
      );
      return Number(r.rows[0]?.n || 0);
    });
  }

  return {
    ensureStorage,
    reserveAuthorizationCreation,
    completeAuthorizationCreation,
    markAuthorizationCreationOutcome,
    createBinding,
    confirmBindingAuthorized,
    consumeBindingForJoinTx,
    getBindingByCorrelation,
    getConsumedBindingForParticipant,
    updateProviderReferenceForParticipant,
    markBindingReleasedForParticipant,
    resolveRenewalSourceForParticipant,
    applyAuthorizationRenewalInTx,
    markAuthorizationUnusableInTx,
    countCommittedPastDeclaredValidity
  };
}
