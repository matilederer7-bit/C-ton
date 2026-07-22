import { assertRequiredTables } from "./schema_contract.js";
type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type WebhookEventStatus = "pending" | "processing" | "processed" | "ignored" | "failed";

export type WebhookIngestInput = {
  provider: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  deal_id?: string | null;
  participant_id?: string | null;
};

export function buildWebhookIngestion(deps: { withTx: WithTx }) {
  let readyPromise: Promise<void> | null = null;

  async function ensureStorage() {
  await deps.withTx(async c=>assertRequiredTables(c,["webhook_events"]));
}

  async function claimEvent(input: WebhookIngestInput) {
    await ensureStorage();
    return deps.withTx(async (c) => {
      const existing = await c.query(
        `SELECT provider, event_id, status, received_at, processed_at
         FROM siton.webhook_events
         WHERE provider=$1 AND event_id=$2`,
        [input.provider, input.event_id]
      );

      if (!existing.rowCount) {
        const inserted = await c.query(
          `INSERT INTO siton.webhook_events(provider, event_id, payload_jsonb, deal_id, participant_id, status)
           VALUES ($1,$2,$3,$4,$5,'processing')
           RETURNING provider, event_id, status, received_at, processed_at`,
          [input.provider, input.event_id, JSON.stringify(input.payload ?? {}), input.deal_id ?? null, input.participant_id ?? null]
        );

        return {
          accepted: true,
          duplicate: false,
          should_process: true,
          provider: input.provider,
          event_id: input.event_id,
          status: inserted.rows[0].status as WebhookEventStatus,
          received_at: inserted.rows[0].received_at,
          processed_at: inserted.rows[0].processed_at
        };
      }

      const existingRow = existing.rows[0];
      const currentStatus = existingRow.status as WebhookEventStatus;

      return {
        accepted: true,
        duplicate: true,
        should_process: false,
        provider: input.provider,
        event_id: input.event_id,
        status: currentStatus,
        received_at: existingRow.received_at,
        processed_at: existingRow.processed_at
      };
    }).then(async (result) => {
      if (!result.duplicate || result.status === "processing" || result.status === "processed" || result.status === "ignored") {
        return result;
      }

      return deps.withTx(async (c) => {
        const updated = await c.query(
          `UPDATE siton.webhook_events
           SET status='processing',
               processed_at=NULL,
               payload_jsonb=$3,
               deal_id=COALESCE($4, deal_id),
               participant_id=COALESCE($5, participant_id)
           WHERE provider=$1
             AND event_id=$2
             AND status IN ('pending','failed')
           RETURNING provider, event_id, status, received_at, processed_at`,
          [input.provider, input.event_id, JSON.stringify(input.payload ?? {}), input.deal_id ?? null, input.participant_id ?? null]
        );

        if (!updated.rowCount) return result;

        return {
          ...result,
          should_process: true,
          status: updated.rows[0].status as WebhookEventStatus,
          received_at: updated.rows[0].received_at,
          processed_at: updated.rows[0].processed_at
        };
      });
    });
  }

  async function markEvent(provider: string, eventId: string, status: WebhookEventStatus, reason?: string | null) {
    await ensureStorage();
    return deps.withTx(async (c) => {
      const processedAt =
        status === "processed" || status === "ignored" || status === "failed"
          ? new Date().toISOString()
          : null;

      const result = await c.query(
        `UPDATE siton.webhook_events
         SET status=$3,
             payload_jsonb=CASE
               WHEN $5::text IS NULL OR btrim($5::text) = '' THEN payload_jsonb
               ELSE payload_jsonb || jsonb_build_object('classification_reason', $5::text)
             END,
             processed_at=CASE WHEN $4::timestamptz IS NULL THEN processed_at ELSE $4::timestamptz END
         WHERE provider=$1 AND event_id=$2
         RETURNING provider, event_id, status, received_at, processed_at`,
        [provider, eventId, status, processedAt, reason ?? null]
      );

      return result.rows[0] || null;
    });
  }

  return {
    ensureStorage,
    claimEvent,
    markEvent
  };
}
