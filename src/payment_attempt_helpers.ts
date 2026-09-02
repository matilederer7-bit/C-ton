type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type PaymentResultClass = "success" | "permanent_fail" | "temporary_fail" | "unknown";

export type AttemptType =
  | "charge_start"
  | "recovery"
  | "refund"
  | "deadline_check"
  | "cancel_refund"
  | "release";

export function buildPaymentAttemptHelpers(deps: {
  withTx: WithTx;
}) {
  async function recordAttemptBeforeIo(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    correlation_id: string;
  }): Promise<void> {
    await deps.withTx(async (c) => {
      await c.query(
        `INSERT INTO siton.payment_attempts(participant_id, deal_id, attempt_type, result_class, correlation_id)
         VALUES ($1,$2,$3,'unknown',$4)
         ON CONFLICT (participant_id, deal_id, attempt_type, correlation_id) DO NOTHING`,
        [args.participant_id, args.deal_id, args.attempt_type, args.correlation_id]
      );
    });
  }

  async function finalizeAttemptResult(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    correlation_id: string;
    result_class: PaymentResultClass;
  }): Promise<void> {
    await deps.withTx(async (c) => {
      await c.query(
        `UPDATE siton.payment_attempts
         SET result_class=$1
         WHERE participant_id=$2 AND deal_id=$3 AND attempt_type=$4 AND correlation_id=$5`,
        [args.result_class, args.participant_id, args.deal_id, args.attempt_type, args.correlation_id]
      );
    });
  }

  /**
   * R9C — mint or recover the ONE durable provider-operation identity for a
   * (participant, deal, attempt_type). Serialized per participant/deal with the
   * same advisory lock the migration-050 cap trigger takes (re-entrant here).
   *
   * - A prior attempt that is UNRESOLVED (result_class 'unknown' = recorded
   *   before I/O and never finalized, or 'success' never persisted into state)
   *   is returned as-is: the caller must reconcile it through the provider's
   *   authoritative status seam and may only REUSE that identity — never mint a
   *   new idempotency key — until the provider has declared the outcome.
   * - Otherwise a fresh identity is minted from the logical attempt number
   *   (prior rows + 1) — independent of outbox attempt_count / lease
   *   generation, so crash, retry, reclaim and restart cannot rotate it.
   */
  async function beginProviderAttempt(args: {
    participant_id: string;
    deal_id: string;
    attempt_type: AttemptType;
    identity: (logicalAttempt: number) => string;
  }): Promise<
    | { kind: "fresh"; correlation_id: string; logical_attempt: number }
    | { kind: "unresolved"; correlation_id: string; result_class: "unknown" | "success"; logical_attempt: number }
  > {
    return deps.withTx(async (c) => {
      await c.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
        [args.participant_id, args.deal_id]
      );
      const prior = await c.query(
        `SELECT correlation_id, result_class
         FROM siton.payment_attempts
         WHERE participant_id=$1 AND deal_id=$2 AND attempt_type=$3
         ORDER BY created_at ASC, correlation_id ASC`,
        [args.participant_id, args.deal_id, args.attempt_type]
      );
      const rows = prior.rows as Array<{ correlation_id: string; result_class: string }>;
      const unresolved = [...rows].reverse().find((row) => row.result_class === "unknown" || row.result_class === "success");
      if (unresolved) {
        return {
          kind: "unresolved" as const,
          correlation_id: String(unresolved.correlation_id),
          result_class: unresolved.result_class === "success" ? "success" as const : "unknown" as const,
          logical_attempt: rows.length
        };
      }
      const logicalAttempt = rows.length + 1;
      const correlation = args.identity(logicalAttempt);
      await c.query(
        `INSERT INTO siton.payment_attempts(participant_id, deal_id, attempt_type, result_class, correlation_id)
         VALUES ($1,$2,$3,'unknown',$4)
         ON CONFLICT (participant_id, deal_id, attempt_type, correlation_id) DO NOTHING`,
        [args.participant_id, args.deal_id, args.attempt_type, correlation]
      );
      return { kind: "fresh" as const, correlation_id: correlation, logical_attempt: logicalAttempt };
    });
  }

  return {
    recordAttemptBeforeIo,
    finalizeAttemptResult,
    beginProviderAttempt
  };
}
