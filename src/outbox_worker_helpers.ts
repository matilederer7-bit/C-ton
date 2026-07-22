type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type OutboxEventRow = {
  event_uuid: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  attempt_count: number;
  max_attempts: number;
  processing_started_at?: string | Date | null;
  claimed_at?: string | Date | null;
  lease_expires_at?: string | Date | null;
  worker_id?: string | null;
  correlation_id?: string | null;
};

export function buildOutboxWorkerHelpers(deps: {
  withTx: WithTx;
  outboxPollMs: number;
  outboxMaxAttempts: number;
  PermanentFailErrorCtor: new (...args: any[]) => Error;
  DeferredEventErrorCtor: new (...args: any[]) => Error;
  workerId?: string;
  leaseMs?: number;
}) {
  const workerId = String(deps.workerId || `worker-${process.pid}`);
  const leaseMs = Math.max(5_000, Number(deps.leaseMs || 60_000));
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
        SET status='processing',
            processing_started_at=now(),
            claimed_at=now(),
            lease_expires_at=now() + ($2::text || ' milliseconds')::interval,
            worker_id=$3,
            last_attempt_at=now(),
            attempt_count=attempt_count+1,
            updated_at=now()
        WHERE event_uuid IN (
          SELECT event_uuid
          FROM siton.outbox_events
          WHERE status='pending'
            AND available_at <= now()
            AND attempt_count < max_attempts
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        RETURNING event_uuid, event_type, aggregate_type, aggregate_id, payload, attempt_count, max_attempts,
                  processing_started_at, claimed_at, lease_expires_at, worker_id, correlation_id
        `,
        [limit, String(leaseMs), workerId]
      );
      return r.rows as OutboxEventRow[];
    });
  }

  async function claimOutboxEventById(eventId: string): Promise<OutboxEventRow | null> {
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const result = await c.query(
        `UPDATE siton.outbox_events
            SET status='processing', processing_started_at=now(), claimed_at=now(),
                lease_expires_at=now() + ($2::text || ' milliseconds')::interval,
                worker_id=$3, last_attempt_at=now(), attempt_count=attempt_count+1, updated_at=now()
          WHERE event_uuid=$1 AND status='pending' AND available_at <= now() AND attempt_count < max_attempts
          RETURNING event_uuid, event_type, aggregate_type, aggregate_id, payload, attempt_count, max_attempts,
                    processing_started_at, claimed_at, lease_expires_at, worker_id, correlation_id`,
        [eventId, String(leaseMs), workerId]
      );
      return (result.rows[0] as OutboxEventRow | undefined) || null;
    });
  }

  async function reclaimStuckProcessing(timeoutMs: number): Promise<number> {
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const r = await c.query(
        `
        UPDATE siton.outbox_events
        SET status='pending',
            sent=false,
            last_error=COALESCE(last_error, 'worker_reclaim_after_restart'),
            processing_started_at=null,
            claimed_at=null,
            lease_expires_at=null,
            worker_id=null,
            available_at=now(),
            updated_at=now()
        WHERE status='processing'
          AND (
            lease_expires_at IS NULL AND processing_started_at IS NULL
            OR lease_expires_at IS NOT NULL AND lease_expires_at <= now()
            OR lease_expires_at IS NULL AND processing_started_at < now() - ($1::text || ' milliseconds')::interval
          )
        `,
        [String(timeoutMs)]
      );
      return Number(r.rowCount || 0);
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
             processing_started_at=null,
             claimed_at=null,
             lease_expires_at=null,
             worker_id=null,
             updated_at=now()
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$2 AND lease_expires_at > now()`,
        [eventId, workerId]
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
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$3`,
        [eventId, msg, workerId]
      );
      await c.query(
        `INSERT INTO siton.outbox_dlq (
           event_uuid, event_type, aggregate_type, aggregate_id, payload,
           status, attempt_count, available_at, sent, sent_at,
           last_error, created_at, updated_at
         )
         SELECT
           event_uuid, event_type, aggregate_type, aggregate_id, payload,
           status, attempt_count, available_at, sent, sent_at,
           last_error, created_at, updated_at
         FROM siton.outbox_events
         WHERE event_uuid=$1 AND worker_id=$2`,
        [eventId, workerId]
      );
      await c.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1 AND worker_id=$2`, [eventId, workerId]);
    });
  }

  async function markOutboxFailed(eventId: string, attemptCount: number, err: any, eventMaxAttempts = deps.outboxMaxAttempts): Promise<void> {
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
               processing_started_at=null,
               claimed_at=null,
               lease_expires_at=null,
               worker_id=null,
               updated_at=now()
           WHERE event_uuid=$1 AND status='processing' AND worker_id=$4`,
          [eventId, msg, retryAt.toISOString(), workerId]
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
      await c.query(
        `UPDATE siton.outbox_events SET last_error=$2, updated_at=now()
          WHERE event_uuid=$1 AND status='processing' AND worker_id=$3`,
        [eventId, msg, workerId]
      );

      if (attemptCount >= eventMaxAttempts) {
        await c.query(
          `INSERT INTO siton.outbox_dlq (
             event_uuid, event_type, aggregate_type, aggregate_id, payload,
             status, attempt_count, available_at, sent, sent_at,
             last_error, created_at, updated_at
           )
           SELECT
             event_uuid, event_type, aggregate_type, aggregate_id, payload,
             status, attempt_count, available_at, sent, sent_at,
             last_error, created_at, updated_at
           FROM siton.outbox_events
           WHERE event_uuid=$1 AND worker_id=$2`,
          [eventId, workerId]
        );
        await c.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1 AND worker_id=$2`, [eventId, workerId]);
        return;
      }

      await c.query(
        `UPDATE siton.outbox_events
         SET status='pending',
             sent=false,
             last_error=$2,
             available_at=$3,
             processing_started_at=null,
             claimed_at=null,
             lease_expires_at=null,
             worker_id=null,
             updated_at=now()
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$4`,
        [eventId, msg, nextAt.toISOString(), workerId]
      );
    });
  }

  async function heartbeatOutboxLease(eventId: string): Promise<boolean> {
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const result = await c.query(
        `UPDATE siton.outbox_events
            SET lease_expires_at=now() + ($3::text || ' milliseconds')::interval,
                updated_at=now()
          WHERE event_uuid=$1 AND status='processing' AND worker_id=$2 AND lease_expires_at > now()`,
        [eventId, workerId, String(leaseMs)]
      );
      return Number(result.rowCount || 0) === 1;
    });
  }

  return {
    claimOutboxBatch,
    claimOutboxEventById,
    reclaimStuckProcessing,
    markOutboxSent,
    markOutboxFailed,
    heartbeatOutboxLease,
    workerId,
    leaseMs
  };
}
