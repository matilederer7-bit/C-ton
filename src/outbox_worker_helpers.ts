type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type OutboxEventRow = {
  event_uuid: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  attempt_count: number;
};

export function buildOutboxWorkerHelpers(deps: {
  withTx: WithTx;
  outboxPollMs: number;
  outboxMaxAttempts: number;
  PermanentFailErrorCtor: new (...args: any[]) => Error;
  DeferredEventErrorCtor: new (...args: any[]) => Error;
}) {
  function isTemporaryError(err: any) {
    const msg = String(err?.message || err || "");
    return msg.includes("temporary_fail") || msg.includes("finalize_not_ready_yet");
  }

  function isPermanentFail(err: any) {
    return err instanceof deps.PermanentFailErrorCtor;
  }

  function isDeferredEventError(err: any) {
    return err instanceof deps.DeferredEventErrorCtor;
  }

  async function claimOutboxBatch(limit: number): Promise<OutboxEventRow[]> {
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const r = await c.query(
        `
        UPDATE siton.outbox_events
        SET status='processing', updated_at=now()
        WHERE event_uuid IN (
          SELECT event_uuid
          FROM siton.outbox_events
          WHERE status='pending'
            AND available_at <= now()
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        RETURNING event_uuid, event_type, aggregate_type, aggregate_id, payload, attempt_count
        `,
        [limit]
      );
      return r.rows as OutboxEventRow[];
    });
  }

  async function markOutboxSent(eventId: string): Promise<void> {
    await deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      await c.query(
        `UPDATE siton.outbox_events
         SET status='sent',
             sent=true,
             sent_at=now(),
             last_error=null,
             updated_at=now()
         WHERE event_uuid=$1`,
        [eventId]
      );
    });
  }

  async function moveOutboxToDlqNow(eventId: string, err: any): Promise<void> {
    const msg = String(err?.message || err || "unknown error").slice(0, 500);
    await deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      await c.query(
        `UPDATE siton.outbox_events
         SET last_error=$2, updated_at=now()
         WHERE event_uuid=$1`,
        [eventId, msg]
      );
      await c.query(
        `INSERT INTO siton.outbox_dlq (
           event_uuid, event_type, aggregate_type, aggregate_id, payload,
           status, attempt_count, available_at, locked_at, sent, sent_at,
           last_error, created_at, updated_at
         )
         SELECT
           event_uuid, event_type, aggregate_type, aggregate_id, payload,
           status, attempt_count, available_at, locked_at, sent, sent_at,
           last_error, created_at, updated_at
         FROM siton.outbox_events
         WHERE event_uuid=$1`,
        [eventId]
      );
      await c.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
    });
  }

  async function markOutboxFailed(eventId: string, attemptCount: number, err: any): Promise<void> {
    if (isPermanentFail(err)) {
      await moveOutboxToDlqNow(eventId, err);
      return;
    }

    const msg = String(err?.message || err || "unknown error").slice(0, 500);

    if (isDeferredEventError(err)) {
      const retryAt = (err as any).retryAt instanceof Date ? (err as any).retryAt : new Date((err as any).retryAt);

      await deps.withTx(async (c) => {
        await c.query(`SELECT set_config('siton.is_worker','true',true)`);
        await c.query(
          `UPDATE siton.outbox_events
           SET status='pending',
               sent=false,
               last_error=$2,
               available_at=$3,
               updated_at=now()
           WHERE event_uuid=$1`,
          [eventId, msg, retryAt.toISOString()]
        );
      });

      return;
    }

    const temp = isTemporaryError(err);
    const base = deps.outboxPollMs;
    const nextDelay = temp ? Math.floor(base * 1.5 * (1 + attemptCount)) : base * (1 + attemptCount);
    const nextAt = new Date(Date.now() + nextDelay);

    await deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);

      if (attemptCount >= deps.outboxMaxAttempts) {
        await c.query(
          `INSERT INTO siton.outbox_dlq (
             event_uuid, event_type, aggregate_type, aggregate_id, payload,
             status, attempt_count, available_at, locked_at, sent, sent_at,
             last_error, created_at, updated_at
           )
           SELECT
             event_uuid, event_type, aggregate_type, aggregate_id, payload,
             status, attempt_count, available_at, locked_at, sent, sent_at,
             last_error, created_at, updated_at
           FROM siton.outbox_events
           WHERE event_uuid=$1`,
          [eventId]
        );
        await c.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
        return;
      }

      await c.query(
        `UPDATE siton.outbox_events
         SET status='pending',
             sent=false,
             attempt_count=attempt_count+1,
             last_error=$2,
             available_at=$3,
             updated_at=now()
         WHERE event_uuid=$1`,
        [eventId, msg, nextAt.toISOString()]
      );
    });
  }

  return {
    claimOutboxBatch,
    markOutboxSent,
    markOutboxFailed
  };
}
