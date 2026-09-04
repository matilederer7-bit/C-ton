type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type PaymentResultClass = "success" | "permanent_fail" | "temporary_fail" | "unknown";

export type AttemptType =
  | "charge_start"
  | "recovery"
  | "refund"
  | "deadline_check"
  | "cancel_refund"
  | "release";

/**
 * R9C — durable dispatch lifecycle of ONE logical money operation
 * (migration 063). Together with result_class it distinguishes:
 *
 *   NOT_DISPATCHED     result_class unknown + dispatch_state recorded
 *   IN_FLIGHT          result_class unknown + dispatch_state dispatching + owner lease live
 *   UNKNOWN            result_class unknown + (dispatch_state responded, or dispatching with a dead owner lease)
 *   SUCCEEDED          result_class success
 *   DEFINITELY_FAILED  result_class permanent_fail
 */
export type DispatchState = "recorded" | "dispatching" | "responded";

export const MONEY_ATTEMPT_TYPES: ReadonlyArray<AttemptType> = ["charge_start", "recovery", "refund", "cancel_refund", "release"];

export type PaymentAttemptLifecycleRow = {
  attempt_type: AttemptType;
  correlation_id: string;
  result_class: PaymentResultClass;
  dispatch_state: DispatchState;
  owner_event_uuid: string | null;
  owner_lease_generation: number | null;
  in_flight: boolean;
  provider_reference: string | null;
  outcome_note: string | null;
  created_at: string;
};

export type BeginProviderAttemptResult =
  /** brand-new identity, recorded before any I/O */
  | { kind: "fresh"; correlation_id: string; logical_attempt: number }
  /** identity minted earlier but never armed for I/O — nothing reached the provider, the SAME identity is used */
  | { kind: "reuse_not_dispatched"; correlation_id: string; logical_attempt: number }
  /** identity may have reached the provider (or succeeded without local persistence): resolve through authoritative status FIRST */
  | { kind: "unresolved"; correlation_id: string; result_class: "unknown" | "success"; dispatch_state: DispatchState; logical_attempt: number }
  /** another worker holding a live lease is executing this very operation right now — no I/O, no state guess */
  | { kind: "in_flight"; correlation_id: string; owner_event_uuid: string | null; owner_lease_generation: number | null }
  /** a DIFFERENT money operation of this participant is unresolved (or already moved money): this rail may not start */
  | { kind: "blocked"; reason: string; blocking: { attempt_type: AttemptType; correlation_id: string; result_class: PaymentResultClass } };

export type ArmProviderDispatchResult = "armed" | "lease_lost" | "participant_state_changed" | "in_flight_elsewhere" | "resolved_elsewhere";

/**
 * SR-1 — outcome of an owner-fenced settlement.
 *   settled        the outcome is durable (or the identity is already terminal)
 *   foreign_owner  a live successor owns this dispatch; the caller is stale and
 *                  must abort as if it had lost its outbox lease
 *   missing        the identity row is gone (never expected)
 */
export type SettleDispatchResult = "settled" | "foreign_owner" | "missing";

export type ProviderDispatchOutcome = "success" | "permanent_fail" | "unknown" | "pre_dispatch_failure";

export class PaymentOperationInFlightError extends Error {
  readonly code = "payment_operation_in_flight";
  constructor(message: string) {
    super(message);
    this.name = "PaymentOperationInFlightError";
  }
}

const TERMINAL = ["success", "permanent_fail"];

function ownerSetting(owner: { event_uuid: string; lease_generation: number } | null | undefined) {
  if (!owner || !owner.event_uuid || !Number.isInteger(Number(owner.lease_generation))) return null;
  return `${owner.event_uuid}:${Number(owner.lease_generation)}`;
}

export function buildPaymentAttemptHelpers(deps: {
  withTx: WithTx;
}) {
  async function lockParticipantDeal(c: any, participantId: string, dealId: string) {
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [participantId, dealId]
    );
  }

  async function loadRows(c: any, participantId: string, dealId: string): Promise<PaymentAttemptLifecycleRow[]> {
    const r = await c.query(
      `SELECT attempt_type, correlation_id, result_class, dispatch_state, owner_event_uuid, owner_lease_generation,
              siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight,
              provider_reference, outcome_note, created_at::text AS created_at
       FROM siton.payment_attempts
       WHERE participant_id=$1 AND deal_id=$2
       ORDER BY created_at ASC, correlation_id ASC`,
      [participantId, dealId]
    );
    return (r.rows as any[]).map((row) => ({
      attempt_type: String(row.attempt_type) as AttemptType,
      correlation_id: String(row.correlation_id),
      result_class: String(row.result_class) as PaymentResultClass,
      dispatch_state: String(row.dispatch_state) as DispatchState,
      owner_event_uuid: row.owner_event_uuid ? String(row.owner_event_uuid) : null,
      owner_lease_generation: row.owner_lease_generation === null || row.owner_lease_generation === undefined ? null : Number(row.owner_lease_generation),
      in_flight: Boolean(row.in_flight),
      provider_reference: row.provider_reference ? String(row.provider_reference) : null,
      outcome_note: row.outcome_note ? String(row.outcome_note) : null,
      created_at: String(row.created_at)
    }));
  }

  /**
   * R9C C1 — throws PaymentOperationInFlightError when ANY money operation of
   * the participant/deal is dispatching under a live worker lease. Callers must
   * hold the participant/deal advisory lock (lockParticipantDeal) so the check
   * and the caller's write are serialized against armProviderDispatch.
   */
  async function assertNoInFlightOperationInTx(c: any, participantId: string, dealId: string, context: string) {
    const live = await c.query(
      `SELECT attempt_type, correlation_id
       FROM siton.payment_attempts
       WHERE participant_id=$1 AND deal_id=$2 AND result_class='unknown' AND dispatch_state='dispatching'
         AND siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation)
       LIMIT 1`,
      [participantId, dealId]
    );
    const row = live.rows[0];
    if (row) {
      throw new PaymentOperationInFlightError(
        `payment_operation_in_flight ${String(row.attempt_type)} ${String(row.correlation_id)} is dispatching under a live lease (${context})`
      );
    }
  }

  async function anyOperationInFlight(participantId: string, dealId: string): Promise<PaymentAttemptLifecycleRow | null> {
    return deps.withTx(async (c) => {
      const rows = await loadRows(c, participantId, dealId);
      return rows.find((row) => row.result_class === "unknown" && row.dispatch_state === "dispatching" && row.in_flight) || null;
    });
  }

  /** Legacy write path (kept for callers that record an identity outside the rails). */
  async function recordAttemptBeforeIo(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    correlation_id: string;
  }): Promise<void> {
    await deps.withTx(async (c) => {
      await c.query(
        `INSERT INTO siton.payment_attempts(participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state)
         VALUES ($1,$2,$3,'unknown',$4,'recorded')
         ON CONFLICT (participant_id, deal_id, attempt_type, correlation_id) DO NOTHING`,
        [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id]
      );
    });
  }

  /**
   * Monotonic outcome write (any caller): terminal truth never downgrades —
   * a row already at success stays success; permanent_fail may only become
   * success (provider truth wins). Non-owner callers cannot settle a NEGATIVE
   * (or still-ambiguous) result on an operation that is in flight — the DB
   * guard of migration 063 is the backstop for the same rule.
   */
  async function settleAttemptInTx(c: any, args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    correlation_id: string;
    result_class: PaymentResultClass;
    provider_reference?: string | null;
    note?: string | null;
  }): Promise<"settled" | "already_terminal" | "missing"> {
    await lockParticipantDeal(c, args.participant_id, args.deal_id);
    const current = await c.query(
      `SELECT result_class, dispatch_state, owner_event_uuid, owner_lease_generation,
              siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight
       FROM siton.payment_attempts
       WHERE participant_id=$1 AND deal_id=$2 AND attempt_type=$3 AND correlation_id=$4
       FOR UPDATE`,
      [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id]
    );
    const row = current.rows[0];
    if (args.result_class !== "success") {
      // C1 — a negative settlement must never race a live request of THIS
      // participant: neither the exact identity nor any other money operation
      // may be dispatching under a live lease. Only the dispatching owner
      // (settleProviderDispatch) may write a negative outcome while in flight.
      await assertNoInFlightOperationInTx(c, args.participant_id, args.deal_id, `negative settle of ${args.attempt_type} ${args.correlation_id}`);
    }
    if (!row) return "missing";
    const existing = String(row.result_class);
    if (existing === "success") return "already_terminal";
    if (existing === "permanent_fail" && args.result_class !== "success") return "already_terminal";
    await c.query(
      `UPDATE siton.payment_attempts
       SET result_class=$1,
           dispatch_state=CASE WHEN $1 IN ('success','permanent_fail') THEN 'responded' ELSE dispatch_state END,
           provider_reference=COALESCE($6, provider_reference),
           outcome_note=COALESCE($7, outcome_note)
       WHERE participant_id=$2 AND deal_id=$3 AND attempt_type=$4 AND correlation_id=$5`,
      [args.result_class, args.participant_id, args.deal_id, args.attempt_type, args.correlation_id, args.provider_reference ?? null, args.note ?? null]
    );
    return "settled";
  }

  async function finalizeAttemptResult(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    correlation_id: string;
    result_class: PaymentResultClass;
    provider_reference?: string | null;
    note?: string | null;
  }): Promise<"settled" | "already_terminal" | "missing"> {
    return deps.withTx(async (c) => settleAttemptInTx(c, args));
  }

  /**
   * R9C — mint or recover the ONE durable provider-operation identity for a
   * (participant, deal, attempt_type), serialized per participant/deal with
   * the same advisory lock the migration-050 cap trigger takes.
   *
   * Never mints a new identity while a prior same-type operation is
   * unresolved (unknown) or executed-but-unpersisted (success); never lets a
   * rail start while a conflicting operation of another money type is
   * unresolved (recovery/refund/release behind an unresolved capture;
   * recovery/release behind an executed capture). The DB eligibility trigger
   * (063) is the backstop for the same rules.
   */
  async function beginProviderAttempt(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    identity: (logicalAttempt: number) => string;
  }): Promise<BeginProviderAttemptResult> {
    return deps.withTx(async (c) => {
      await lockParticipantDeal(c, args.participant_id, args.deal_id);
      const rows = await loadRows(c, args.participant_id, args.deal_id);

      const captureSide = rows.filter((row) => row.attempt_type === "charge_start" || row.attempt_type === "recovery");
      let blocking: PaymentAttemptLifecycleRow | undefined;
      let reason = "";
      if (args.attempt_type === "recovery") {
        blocking = rows.find((row) => row.attempt_type === "charge_start" && (row.result_class === "unknown" || row.result_class === "success"));
        reason = "recovery_blocked_by_unresolved_or_executed_capture";
      } else if (args.attempt_type === "refund" || args.attempt_type === "cancel_refund") {
        blocking = captureSide.find((row) => row.result_class === "unknown");
        reason = "refund_blocked_by_unresolved_capture";
      } else if (args.attempt_type === "release") {
        blocking = captureSide.find((row) => row.result_class === "unknown")
          || captureSide.find((row) => row.result_class === "success");
        reason = blocking?.result_class === "success" ? "release_blocked_by_captured_money" : "release_blocked_by_unresolved_capture";
      }
      if (blocking) {
        return {
          kind: "blocked" as const,
          reason,
          blocking: { attempt_type: blocking.attempt_type, correlation_id: blocking.correlation_id, result_class: blocking.result_class }
        };
      }

      const sameType = rows.filter((row) => row.attempt_type === args.attempt_type);
      const unresolved = [...sameType].reverse().find((row) => row.result_class === "unknown" || row.result_class === "success");
      if (unresolved) {
        if (unresolved.result_class === "unknown" && unresolved.dispatch_state === "dispatching" && unresolved.in_flight) {
          return {
            kind: "in_flight" as const,
            correlation_id: unresolved.correlation_id,
            owner_event_uuid: unresolved.owner_event_uuid,
            owner_lease_generation: unresolved.owner_lease_generation
          };
        }
        if (unresolved.result_class === "unknown" && unresolved.dispatch_state === "recorded") {
          return { kind: "reuse_not_dispatched" as const, correlation_id: unresolved.correlation_id, logical_attempt: sameType.length };
        }
        return {
          kind: "unresolved" as const,
          correlation_id: unresolved.correlation_id,
          result_class: unresolved.result_class === "success" ? "success" as const : "unknown" as const,
          dispatch_state: unresolved.dispatch_state,
          logical_attempt: sameType.length
        };
      }

      const logicalAttempt = sameType.length + 1;
      const correlation = args.identity(logicalAttempt);
      await c.query(
        `INSERT INTO siton.payment_attempts(participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state)
         VALUES ($1,$2,$3,'unknown',$4,'recorded')
         ON CONFLICT (participant_id, deal_id, attempt_type, correlation_id) DO NOTHING`,
        [args.participant_id, args.deal_id, args.attempt_type, correlation]
      );
      return { kind: "fresh" as const, correlation_id: correlation, logical_attempt: logicalAttempt };
    });
  }

  /**
   * R9C — arm provider I/O for ONE identity, atomically with the fence:
   *   * this worker still owns the outbox lease (status processing, same
   *     worker_id + lease_generation, at least minLeaseRemainingMs left)
   *   * the participant is still in a state the rail is allowed to act on
   *   * the identity is unresolved and not being dispatched by a live owner
   * On success the row is `dispatching` with THIS job as owner; reconcilers
   * see it as IN_FLIGHT until the owner settles it or the lease dies.
   * Without a worker lease no money I/O is ever armed (fail closed).
   */
  async function armProviderDispatch(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    correlation_id: string;
    event_uuid: string;
    lease_generation: number | null | undefined;
    worker_id: string;
    min_lease_remaining_ms: number;
    expected_money_states: string[];
    expected_buyer_states?: string[];
    provider_reference?: string | null;
  }): Promise<ArmProviderDispatchResult> {
    const generation = Number(args.lease_generation);
    if (!Number.isInteger(generation) || generation < 1) return "lease_lost";
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      await c.query(`SELECT set_config('siton.payment_dispatch_owner', $1, true)`, [`${args.event_uuid}:${generation}`]);
      await lockParticipantDeal(c, args.participant_id, args.deal_id);
      const lease = await c.query(
        `SELECT 1
         FROM siton.outbox_events
         WHERE event_uuid=$1 AND lease_generation=$2 AND status='processing' AND worker_id=$3
           AND lease_expires_at > clock_timestamp() + ($4::text || ' milliseconds')::interval`,
        [args.event_uuid, generation, args.worker_id, String(Math.max(0, Math.floor(args.min_lease_remaining_ms)))]
      );
      if (Number(lease.rowCount || 0) !== 1) return "lease_lost" as const;
      const participant = await c.query(
        `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1 AND deal_id=$2`,
        [args.participant_id, args.deal_id]
      );
      const state = participant.rows[0];
      if (!state) return "participant_state_changed" as const;
      if (!args.expected_money_states.includes(String(state.money_state))) return "participant_state_changed" as const;
      if (args.expected_buyer_states && !args.expected_buyer_states.includes(String(state.buyer_state))) return "participant_state_changed" as const;
      const armed = await c.query(
        `UPDATE siton.payment_attempts
         SET dispatch_state='dispatching', owner_event_uuid=$5, owner_lease_generation=$6,
             dispatched_at=clock_timestamp(), provider_reference=COALESCE($7, provider_reference), outcome_note=NULL
         WHERE participant_id=$1 AND deal_id=$2 AND attempt_type=$3 AND correlation_id=$4
           AND result_class='unknown'
           AND NOT (
             dispatch_state='dispatching'
             AND (owner_event_uuid IS DISTINCT FROM $5::uuid OR owner_lease_generation IS DISTINCT FROM $6::integer)
             AND siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation)
           )`,
        [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id, args.event_uuid, generation, args.provider_reference ?? null]
      );
      if (Number(armed.rowCount || 0) === 1) return "armed" as const;
      const current = await c.query(
        `SELECT result_class FROM siton.payment_attempts
         WHERE participant_id=$1 AND deal_id=$2 AND attempt_type=$3 AND correlation_id=$4`,
        [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id]
      );
      if (!current.rows[0] || String(current.rows[0].result_class) !== "unknown") return "resolved_elsewhere" as const;
      return "in_flight_elsewhere" as const;
    });
  }

  /**
   * R9C — the dispatching owner records what it observed:
   *   success / permanent_fail   provider-declared, terminal
   *   unknown                    the client side is over but the outcome is
   *                              ambiguous (5xx/429/408, transport loss,
   *                              timeout, malformed response): identity kept,
   *                              reconcile owns it from here
   *   pre_dispatch_failure       nothing left the process: disarm back to
   *                              'recorded' so the SAME identity is retried
   *
   * SR-1 — only the CURRENT dispatching owner may write a NON-success outcome.
   * A stale worker (its lease died, the identity was re-armed by a live
   * successor) writing `unknown`/`responded` would make
   * payment_operation_in_flight() false for a request that is still at the
   * provider and blind the C1 in-flight guard. Such a writer is told
   * "foreign_owner" and must treat it as a lost lease. SUCCESS is provider
   * truth and is always admitted (monotonic).
   */
  async function settleProviderDispatch(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    correlation_id: string;
    owner: { event_uuid: string; lease_generation: number | null | undefined };
    outcome: ProviderDispatchOutcome;
    provider_reference?: string | null;
    note?: string | null;
  }): Promise<SettleDispatchResult> {
    const setting = ownerSetting({ event_uuid: args.owner.event_uuid, lease_generation: Number(args.owner.lease_generation) });
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      if (setting) await c.query(`SELECT set_config('siton.payment_dispatch_owner', $1, true)`, [setting]);
      await lockParticipantDeal(c, args.participant_id, args.deal_id);
      if (args.outcome === "pre_dispatch_failure") {
        const disarmed = await c.query(
          `UPDATE siton.payment_attempts
           SET dispatch_state='recorded', owner_event_uuid=NULL, owner_lease_generation=NULL, dispatched_at=NULL,
               outcome_note=$5
           WHERE participant_id=$1 AND deal_id=$2 AND attempt_type=$3 AND correlation_id=$4
             AND result_class='unknown' AND dispatch_state='dispatching'
             AND owner_event_uuid IS NOT DISTINCT FROM $6::uuid
             AND owner_lease_generation IS NOT DISTINCT FROM $7::integer`,
          [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id, args.note ?? "pre_dispatch_failure", args.owner.event_uuid, Number(args.owner.lease_generation)]
        );
        if (Number(disarmed.rowCount || 0) === 1) return "settled" as const;
        return classifySettleRefusal(c, args);
      }
      const resultClass: PaymentResultClass = args.outcome === "unknown" ? "unknown" : args.outcome;
      // SR-1 — SUCCESS always lands (provider truth); anything else lands only
      // while THIS job is still the row's dispatching owner.
      const updated = await c.query(
        `UPDATE siton.payment_attempts
         SET result_class=CASE
               WHEN result_class='success' THEN 'success'
               WHEN result_class='permanent_fail' AND $5 <> 'success' THEN 'permanent_fail'
               ELSE $5 END,
             dispatch_state='responded',
             provider_reference=COALESCE($6, provider_reference),
             outcome_note=COALESCE($7, outcome_note)
         WHERE participant_id=$1 AND deal_id=$2 AND attempt_type=$3 AND correlation_id=$4
           AND (
             $5 = 'success'
             OR owner_event_uuid IS NULL
             OR (owner_event_uuid IS NOT DISTINCT FROM $8::uuid AND owner_lease_generation IS NOT DISTINCT FROM $9::integer)
           )`,
        [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id, resultClass, args.provider_reference ?? null, args.note ?? null, args.owner.event_uuid, Number(args.owner.lease_generation)]
      );
      if (Number(updated.rowCount || 0) === 1) return "settled" as const;
      return classifySettleRefusal(c, args);
    });
  }

  /**
   * SR-1 — why a settlement did not apply: the identity is gone (missing), it is
   * already resolved and needs nothing (settled), or another worker owns this
   * dispatch now and this caller is stale (foreign_owner).
   */
  async function classifySettleRefusal(
    c: any,
    args: { participant_id: string; deal_id: string; attempt_type: AttemptType; correlation_id: string; owner: { event_uuid: string; lease_generation: number | null | undefined } }
  ): Promise<SettleDispatchResult> {
    const current = await c.query(
      `SELECT result_class, dispatch_state, owner_event_uuid, owner_lease_generation
       FROM siton.payment_attempts
       WHERE participant_id=$1 AND deal_id=$2 AND attempt_type=$3 AND correlation_id=$4`,
      [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id]
    );
    const row = current.rows[0];
    if (!row) return "missing";
    if (TERMINAL.includes(String(row.result_class))) return "settled";
    const ownedByCaller = String(row.owner_event_uuid || "") === String(args.owner.event_uuid || "")
      && Number(row.owner_lease_generation) === Number(args.owner.lease_generation);
    return ownedByCaller ? "settled" : "foreign_owner";
  }

  async function loadAttemptLifecycle(args: {
    participant_id: string;
    deal_id: string;
    attempt_type?: AttemptType;
    correlation_id: string;
  }): Promise<PaymentAttemptLifecycleRow | null> {
    return deps.withTx(async (c) => {
      const rows = await loadRows(c, args.participant_id, args.deal_id);
      return rows.find((row) => row.correlation_id === args.correlation_id && (!args.attempt_type || row.attempt_type === args.attempt_type)) || null;
    });
  }

  async function listAttemptLifecycle(participantId: string, dealId: string): Promise<PaymentAttemptLifecycleRow[]> {
    return deps.withTx(async (c) => loadRows(c, participantId, dealId));
  }

  return {
    recordAttemptBeforeIo,
    finalizeAttemptResult,
    settleAttemptInTx,
    beginProviderAttempt,
    armProviderDispatch,
    settleProviderDispatch,
    loadAttemptLifecycle,
    listAttemptLifecycle,
    anyOperationInFlight,
    assertNoInFlightOperationInTx,
    isTerminal: (resultClass: string) => TERMINAL.includes(resultClass)
  };
}
