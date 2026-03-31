type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type WebhookEventStatus = "pending" | "processed" | "ignored" | "failed";

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
    if (!readyPromise) {
      readyPromise = deps.withTx(async (c) => {
        await c.query(
          `CREATE TABLE IF NOT EXISTS siton.webhook_events (
             provider TEXT NOT NULL,
             event_id TEXT NOT NULL,
             payload_jsonb JSONB NOT NULL,
             received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             processed_at TIMESTAMPTZ NULL,
             status TEXT NOT NULL DEFAULT 'pending',
             deal_id UUID NULL REFERENCES siton.deals(deal_id) ON DELETE RESTRICT,
             participant_id UUID NULL REFERENCES siton.participants(participant_id) ON DELETE RESTRICT,
             CONSTRAINT webhook_events_pk PRIMARY KEY (provider, event_id),
             CONSTRAINT webhook_events_status_check CHECK (status IN ('pending','processed','ignored','failed'))
           )`
        );
        await c.query(
          `CREATE INDEX IF NOT EXISTS idx_webhook_status_received
           ON siton.webhook_events (status, received_at)`
        );
        await c.query(
          `CREATE INDEX IF NOT EXISTS idx_webhook_provider_received
           ON siton.webhook_events (provider, received_at)`
        );
        await c.query(
          `CREATE INDEX IF NOT EXISTS idx_webhook_deal_received
           ON siton.webhook_events (deal_id, received_at)`
        );
      });
    }

    await readyPromise;
  }

  async function ingestEvent(input: WebhookIngestInput) {
    await ensureStorage();
    return deps.withTx(async (c) => {
      const existing = await c.query(
        `SELECT provider, event_id, status, received_at, processed_at
         FROM siton.webhook_events
         WHERE provider=$1 AND event_id=$2`,
        [input.provider, input.event_id]
      );

      if (existing.rowCount) {
        return {
          accepted: true,
          duplicate: true,
          provider: input.provider,
          event_id: input.event_id,
          status: existing.rows[0].status as WebhookEventStatus,
          received_at: existing.rows[0].received_at,
          processed_at: existing.rows[0].processed_at
        };
      }

      const inserted = await c.query(
        `INSERT INTO siton.webhook_events(provider, event_id, payload_jsonb, deal_id, participant_id, status)
         VALUES ($1,$2,$3,$4,$5,'pending')
         RETURNING provider, event_id, status, received_at, processed_at`,
        [
          input.provider,
          input.event_id,
          JSON.stringify({ event_type: input.event_type, payload: input.payload ?? {} }),
          input.deal_id ?? null,
          input.participant_id ?? null
        ]
      );

      return {
        accepted: true,
        duplicate: false,
        provider: input.provider,
        event_id: input.event_id,
        status: inserted.rows[0].status as WebhookEventStatus,
        received_at: inserted.rows[0].received_at,
        processed_at: inserted.rows[0].processed_at
      };
    });
  }

  async function markEvent(provider: string, eventId: string, status: WebhookEventStatus) {
    await ensureStorage();
    return deps.withTx(async (c) => {
      const processedAt =
        status === "processed" || status === "ignored" || status === "failed"
          ? new Date().toISOString()
          : null;

      const result = await c.query(
        `UPDATE siton.webhook_events
         SET status=$3,
             processed_at=CASE WHEN $4::timestamptz IS NULL THEN processed_at ELSE $4::timestamptz END
         WHERE provider=$1 AND event_id=$2
         RETURNING provider, event_id, status, received_at, processed_at`,
        [provider, eventId, status, processedAt]
      );

      return result.rows[0] || null;
    });
  }

  return {
    ensureStorage,
    ingestEvent,
    markEvent
  };
}
