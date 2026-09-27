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

/**
 * Black-Sky A-F3 — a row claimed as 'processing' whose processor died (crash,
 * deploy, OOM) after the claim and before markEvent would otherwise answer
 * every later redelivery "duplicate, in flight" for ever: the provider's replay
 * is swallowed and the money truth it carries is never applied. A claim older
 * than this bound is STALE and may be re-claimed by exactly one redelivery (or
 * returned to 'pending' by the maintenance sweep). Processing is idempotent
 * per event id downstream (transition idempotency keys), so a reclaim of a
 * merely slow processor cannot apply an effect twice. Final statuses
 * (processed / ignored) are never reclaimed.
 */
export const DEFAULT_WEBHOOK_PROCESSING_STALE_MS = 5 * 60_000;
const MIN_WEBHOOK_PROCESSING_STALE_MS = 60_000;

function resolveStaleMs(explicit?: number) {
  const raw = explicit ?? Number(process.env.WEBHOOK_PROCESSING_STALE_MS || DEFAULT_WEBHOOK_PROCESSING_STALE_MS);
  const value = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_WEBHOOK_PROCESSING_STALE_MS;
  return Math.max(MIN_WEBHOOK_PROCESSING_STALE_MS, value);
}

// The claim instant lives in the stored envelope (payload_jsonb.claimed_at):
// no schema change; rows claimed before this field existed fall back to
// received_at (their first claim).
const CLAIM_STALE_SQL = `COALESCE(
  CASE WHEN (payload_jsonb->>'claimed_at') ~ '^[0-9]{4}-' THEN (payload_jsonb->>'claimed_at')::timestamptz END,
  received_at
) <= clock_timestamp() - ($3::text || ' milliseconds')::interval`;

export function buildWebhookIngestion(deps: { withTx: WithTx; staleProcessingMs?: number }) {
  let readyPromise: Promise<void> | null = null;
  const staleMs = () => resolveStaleMs(deps.staleProcessingMs);

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
        // Two deliveries of the same (provider, event_id) can pass the SELECT
        // above at the same time. The primary key makes the second INSERT lose;
        // that is the ordinary duplicate answer, not a server fault, so the
        // loser re-reads the winner's row instead of surfacing a 23505 as 5xx.
        const inserted = await c.query(
          `INSERT INTO siton.webhook_events(provider, event_id, payload_jsonb, deal_id, participant_id, status)
           VALUES ($1,$2,$3::jsonb || jsonb_build_object('claimed_at', clock_timestamp()),$4,$5,'processing')
           ON CONFLICT (provider, event_id) DO NOTHING
           RETURNING provider, event_id, status, received_at, processed_at`,
          [input.provider, input.event_id, JSON.stringify(input.payload ?? {}), input.deal_id ?? null, input.participant_id ?? null]
        );

        if (inserted.rowCount) {
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

        const raced = await c.query(
          `SELECT provider, event_id, status, received_at, processed_at
           FROM siton.webhook_events
           WHERE provider=$1 AND event_id=$2`,
          [input.provider, input.event_id]
        );
        existing.rows = raced.rows;
        existing.rowCount = raced.rowCount;
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
      if (!result.duplicate || result.status === "processed" || result.status === "ignored") {
        return result;
      }

      return deps.withTx(async (c) => {
        // pending / failed: re-claimable as before. processing: re-claimable
        // ONLY when the claim is stale (A-F3); the compare-and-swap on the
        // stamp lets exactly one concurrent redelivery win.
        const updated = await c.query(
          `UPDATE siton.webhook_events
           SET status='processing',
               processed_at=NULL,
               payload_jsonb=$4::jsonb || jsonb_build_object('claimed_at', clock_timestamp()),
               deal_id=COALESCE($5, deal_id),
               participant_id=COALESCE($6, participant_id)
           WHERE provider=$1
             AND event_id=$2
             AND (status IN ('pending','failed') OR (status='processing' AND ${CLAIM_STALE_SQL}))
           RETURNING provider, event_id, status, received_at, processed_at`,
          [input.provider, input.event_id, String(staleMs()), JSON.stringify(input.payload ?? {}), input.deal_id ?? null, input.participant_id ?? null]
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

  /**
   * A-F3 maintenance sweep: stale 'processing' rows go back to 'pending' so
   * the next delivery (or an operator replay) processes them. Bounded per run,
   * idempotent, never touches a final status.
   */
  async function reclaimStaleProcessing(limit = 100): Promise<number> {
    await ensureStorage();
    return deps.withTx(async (c) => {
      const r = await c.query(
        `UPDATE siton.webhook_events
         SET status='pending',
             payload_jsonb=payload_jsonb || jsonb_build_object('reclaimed_at', clock_timestamp(), 'reclaim_reason', 'stale_processing_claim')
         WHERE (provider, event_id) IN (
           SELECT provider, event_id FROM siton.webhook_events
           WHERE status='processing' AND ${CLAIM_STALE_SQL.replace("$3", "$2")}
           ORDER BY received_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )`,
        [Math.max(1, Math.floor(limit)), String(staleMs())]
      );
      return Number(r.rowCount || 0);
    });
  }

  return {
    ensureStorage,
    claimEvent,
    markEvent,
    reclaimStaleProcessing
  };
}
