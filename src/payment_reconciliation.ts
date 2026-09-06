type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type ReconciliationStatus = "processed" | "ignored" | "failed";

export type ReconciliationTarget = {
  participant_id: string;
  deal_id: string;
  attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund";
  correlation_id: string | null;
  buyer_state: string;
  money_state: string;
};

export type ProviderWebhookEvent = {
  event_id: string;
  event_type: string;
  correlation_id?: string | null;
  participant_id?: string | null;
  deal_id?: string | null;
  provider_reference?: string | null;
  payload: Record<string, unknown>;
};

export function buildPaymentReconciliation(deps: { withTx: WithTx }) {
  async function resolveTarget(event: ProviderWebhookEvent): Promise<ReconciliationTarget | null> {
    if (event.correlation_id) {
      const fromAttempt = await deps.withTx(async (c) => {
        const attempt = await c.query(
          `SELECT pa.participant_id, pa.deal_id, pa.attempt_type, pa.correlation_id,
                  p.buyer_state, p.money_state
           FROM siton.payment_attempts pa
           JOIN siton.participants p ON p.participant_id = pa.participant_id
           WHERE pa.correlation_id=$1
           ORDER BY pa.created_at DESC
           LIMIT 1`,
          [event.correlation_id]
        );

        return attempt.rows[0] || null;
      });

      // F-5b — a correlation that resolves to an identity of ANOTHER operation
      // family than the event reports is not this event's target (fall through
      // to participant-level resolution; the event type decides the family).
      const correlationFamilyMatches = (eventType: string, attemptType: string) => {
        if (eventType === "charge_captured" || eventType === "charge_failed") return attemptType === "charge_start";
        if (eventType === "recovery_captured" || eventType === "recovery_failed") return attemptType === "recovery";
        if (eventType === "refund_issued") return attemptType === "refund" || attemptType === "cancel_refund";
        return true;
      };
      if (fromAttempt && correlationFamilyMatches(String(event.event_type || ""), String(fromAttempt.attempt_type))) {
        return fromAttempt as ReconciliationTarget;
      }
    }

    if (!event.participant_id) return null;

    return deps.withTx(async (c) => {
      const participant = await c.query(
        `SELECT participant_id, deal_id, buyer_state, money_state
         FROM siton.participants
         WHERE participant_id=$1`,
        [event.participant_id]
      );

      if (!participant.rowCount) return null;

      const row = participant.rows[0];
      // F-5 (financial torture lab) — the event type names the operation it
      // reports; inferring the operation from the participant's CURRENT state
      // attached a late charge_captured of a ChargeFailedRecovery participant to
      // its freshly minted recovery identity. State inference stays only as the
      // fallback for events that do not name a money operation.
      const attemptTypeFromEventType = (eventType: string): ReconciliationTarget["attempt_type"] | null => {
        if (eventType === "charge_captured" || eventType === "charge_failed") return "charge_start";
        if (eventType === "recovery_captured" || eventType === "recovery_failed") return "recovery";
        if (eventType === "refund_issued") return "refund";
        return null;
      };
      const inferredAttemptType = attemptTypeFromEventType(String(event.event_type || "")) ?? (
        String(row.money_state) === "ChargedSuccess" || String(row.money_state) === "RecoveredCharge" || String(row.money_state) === "Refunded"
          ? "refund"
          :
        String(row.buyer_state) === "ChargeFailedCompletion" || String(row.money_state) === "ChargeFailedRecovery"
          ? "recovery"
          : "charge_start");
      const latestAttempt = await c.query(
        `SELECT correlation_id, attempt_type
         FROM siton.payment_attempts
         WHERE participant_id=$1
           AND deal_id=$2
           AND attempt_type = ANY($3::text[])
         ORDER BY created_at DESC
         LIMIT 1`,
        [row.participant_id, row.deal_id, inferredAttemptType === "refund" ? ["refund", "cancel_refund"] : [inferredAttemptType]]
      );
      return {
        participant_id: row.participant_id,
        deal_id: row.deal_id,
        attempt_type: (latestAttempt.rows[0]?.attempt_type as ReconciliationTarget["attempt_type"] | undefined) ?? inferredAttemptType,
        correlation_id: event.correlation_id ?? latestAttempt.rows[0]?.correlation_id ?? null,
        buyer_state: row.buyer_state,
        money_state: row.money_state
      } satisfies ReconciliationTarget;
    });
  }

  function classifyEvent(eventType: string, target: ReconciliationTarget | null) {
    if (eventType === "payment_authorized" || eventType === "payment_failed") {
      return { status: "processed" as const, reason: "authorization_event_recorded" };
    }

    if (!target) {
      return {
        status: "failed" as const,
        reason: "missing_correlation_target"
      };
    }

    if (eventType === "charge_captured") {
      if (target.buyer_state === "ChargedSuccess" && target.money_state === "ChargedSuccess") {
        return { status: "ignored" as const, reason: "already_captured" };
      }
      if (target.buyer_state !== "ChargingAttempt" || target.money_state !== "ChargeAttempt") {
        return { status: "ignored" as const, reason: "not_waiting_for_charge_capture" };
      }
      return { status: "processed" as const, reason: "capture_success" };
    }

    if (eventType === "charge_failed") {
      if (target.buyer_state === "ChargeFailedCompletion" && target.money_state === "ChargeFailedRecovery") {
        return { status: "ignored" as const, reason: "already_marked_charge_failed" };
      }
      if (target.buyer_state !== "ChargingAttempt" || target.money_state !== "ChargeAttempt") {
        return { status: "ignored" as const, reason: "not_waiting_for_charge_failure" };
      }
      return { status: "processed" as const, reason: "capture_failed" };
    }

    if (eventType === "recovery_captured") {
      if (target.buyer_state === "Recovered" && target.money_state === "RecoveredCharge") {
        return { status: "ignored" as const, reason: "already_recovered" };
      }
      if (target.buyer_state !== "ChargeFailedCompletion" || target.money_state !== "ChargeFailedRecovery") {
        return { status: "ignored" as const, reason: "not_waiting_for_recovery_success" };
      }
      return { status: "processed" as const, reason: "recovery_success" };
    }

    if (eventType === "recovery_failed") {
      if (target.buyer_state === "Dropped" && target.money_state === "AuthReleased") {
        return { status: "ignored" as const, reason: "already_recovery_failed" };
      }
      if (target.buyer_state !== "ChargeFailedCompletion" || target.money_state !== "ChargeFailedRecovery") {
        return { status: "ignored" as const, reason: "not_waiting_for_recovery_failure" };
      }
      return { status: "processed" as const, reason: "recovery_failed" };
    }

    if (eventType === "refund_issued") {
      if (target.money_state === "Refunded") {
        return { status: "ignored" as const, reason: "already_refunded" };
      }
      if (!["ChargedSuccess", "RecoveredCharge"].includes(target.money_state)) {
        return { status: "ignored" as const, reason: "not_waiting_for_refund" };
      }
      return { status: "processed" as const, reason: "refund_issued" };
    }

    return { status: "ignored" as const, reason: "unsupported_event_type" };
  }

  return {
    resolveTarget,
    classifyEvent
  };
}
