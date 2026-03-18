type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type PaymentResultClass = "success" | "permanent_fail" | "temporary_fail";

export type AttemptType =
  | "charge_start"
  | "recovery"
  | "refund"
  | "deadline_check"
  | "cancel_refund";

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

  return {
    recordAttemptBeforeIo,
    finalizeAttemptResult
  };
}
