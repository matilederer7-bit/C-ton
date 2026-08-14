import { createHash } from "node:crypto";

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
  request_id?: string | null;
  lease_generation: number;
  last_heartbeat_at?: string | Date | null;
  last_error?: string | null;
};

export class OutboxLeaseLostError extends Error {
  readonly code = "outbox_lease_lost";

  constructor(eventId: string) {
    super(`outbox lease lost for ${eventId}`);
    this.name = "OutboxLeaseLostError";
  }
}

class OutboxAuditConflictError extends Error {
  readonly code = "outbox_audit_conflict";

  constructor(idempotencyKey: string) {
    super(`outbox operational audit conflict for ${idempotencyKey}`);
    this.name = "OutboxAuditConflictError";
  }
}

export function calculateOutboxRetryDelayMs(args: {
  attemptCount: number;
  baseMs: number;
  temporary: boolean;
  capMs?: number;
}) {
  const attempt = Math.max(1, Math.floor(Number(args.attemptCount || 1)));
  const base = Math.max(1, Math.floor(Number(args.baseMs || 1)));
  const cap = Math.max(base, Math.floor(Number(args.capMs || 15 * 60_000)));
  const exponential = Math.min(cap, base * (2 ** Math.min(20, attempt - 1)));
  return Math.min(cap, args.temporary ? Math.ceil(exponential * 1.5) : exponential);
}

function safeErrorCode(error: any) {
  const explicit = error?.code || error?.kind;
  const named = error?.name && error.name !== "Error" ? error.name : null;
  return String(explicit || named || "worker_failure")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 100) || "worker_failure";
}

function errorMessage(error: any) {
  return String(error?.message || error || "unknown error").slice(0, 500);
}

function evidenceHash(value: unknown) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function requireLeaseGeneration(value: unknown) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("lease_generation must be a positive integer");
  }
  return generation;
}

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
  const configuredLeaseMs = Number(deps.leaseMs || 60_000);
  const leaseMs = Number.isFinite(configuredLeaseMs) ? Math.max(5_000, Math.floor(configuredLeaseMs)) : 60_000;
  const configuredMaxAttempts = Number(deps.outboxMaxAttempts);
  const workerMaxAttempts = Number.isSafeInteger(configuredMaxAttempts) && configuredMaxAttempts >= 1
    ? configuredMaxAttempts
    : 4;

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

  function effectiveMaxAttempts(eventMaxAttempts: unknown) {
    const candidate = Number(eventMaxAttempts);
    const eventMaximum = Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : workerMaxAttempts;
    return Math.min(eventMaximum, workerMaxAttempts);
  }

  async function appendLifecycleAudit(c: any, args: {
    eventUuid: string;
    action: "claim" | "reclaim" | "heartbeat" | "completion" | "retry" | "failure" | "dlq";
    leaseGeneration: number;
    attemptCount: number;
    fromStatus: string;
    toStatus: string;
    reasonCode: string;
    actorWorkerId?: string | null;
    keySuffix?: string;
    metadata?: Record<string, unknown>;
  }) {
    const idempotencyKey = [
      "outbox",
      args.eventUuid,
      String(args.leaseGeneration),
      args.action,
      args.keySuffix || "once"
    ].join(":");
    const actorWorkerId = args.actorWorkerId ?? workerId;
    const metadataJson = JSON.stringify(args.metadata || {});
    const inserted = await c.query(
      `INSERT INTO siton.operational_recovery_audit (
         subject_type, subject_id, action, worker_id, lease_generation,
         attempt_count, from_status, to_status, idempotency_key, reason_code, metadata
       ) VALUES ('outbox_event',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING audit_id`,
      [
        args.eventUuid,
        args.action,
        actorWorkerId,
        args.leaseGeneration,
        args.attemptCount,
        args.fromStatus,
        args.toStatus,
        idempotencyKey,
        args.reasonCode,
        metadataJson
      ]
    );
    if (Number(inserted.rowCount || 0) === 1) return;
    const exact = await c.query(
      `SELECT 1
       FROM siton.operational_recovery_audit
       WHERE idempotency_key=$8
         AND subject_type='outbox_event'
         AND subject_id=$1
         AND action=$2
         AND worker_id IS NOT DISTINCT FROM $3
         AND lease_generation IS NOT DISTINCT FROM $4
         AND attempt_count IS NOT DISTINCT FROM $5
         AND from_status IS NOT DISTINCT FROM $6
         AND to_status IS NOT DISTINCT FROM $7
         AND reason_code=$9
         AND metadata=$10::jsonb`,
      [
        args.eventUuid,
        args.action,
        actorWorkerId,
        args.leaseGeneration,
        args.attemptCount,
        args.fromStatus,
        args.toStatus,
        idempotencyKey,
        args.reasonCode,
        metadataJson
      ]
    );
    if (Number(exact.rowCount || 0) !== 1) throw new OutboxAuditConflictError(idempotencyKey);
  }

  async function insertDlqFromLockedEvent(
    c: any,
    event: OutboxEventRow,
    reasonCode: string,
    fromStatus = "processing",
    requireCurrentLease = false
  ) {
    const message = String(event.last_error || reasonCode).slice(0, 500);
    const inserted = await c.query(
      `INSERT INTO siton.outbox_dlq (
         event_uuid, event_type, aggregate_type, aggregate_id, payload,
         status, attempt_count, max_attempts, available_at, sent, sent_at,
         processing_started_at, last_error, created_at, updated_at,
         claimed_at, lease_expires_at, worker_id, last_attempt_at, correlation_id, request_id,
         lease_generation, last_heartbeat_at
       )
       SELECT
         event_uuid, event_type, aggregate_type, aggregate_id, payload,
         'failed', attempt_count, max_attempts, available_at, false, sent_at,
         processing_started_at, $2, created_at, clock_timestamp(),
         claimed_at, lease_expires_at, worker_id, last_attempt_at, correlation_id, request_id,
         lease_generation, last_heartbeat_at
       FROM siton.outbox_events
       WHERE event_uuid=$1 AND lease_generation=$3
         AND ($4::boolean = false OR (
           status='processing' AND worker_id=$5 AND lease_expires_at > clock_timestamp()
         ))`,
      [event.event_uuid, message, event.lease_generation, requireCurrentLease, workerId]
    );
    if (Number(inserted.rowCount || 0) !== 1) throw new OutboxLeaseLostError(event.event_uuid);
    await appendLifecycleAudit(c, {
      eventUuid: event.event_uuid,
      action: "dlq",
      leaseGeneration: event.lease_generation,
      attemptCount: Number(event.attempt_count || 0),
      fromStatus,
      toStatus: "failed",
      reasonCode
    });
    const removed = await c.query(
      `DELETE FROM siton.outbox_events WHERE event_uuid=$1 AND lease_generation=$2`,
      [event.event_uuid, event.lease_generation]
    );
    if (Number(removed.rowCount || 0) !== 1) throw new OutboxLeaseLostError(event.event_uuid);
  }

  async function auditClaims(c: any, rows: OutboxEventRow[]) {
    for (const row of rows) {
      await appendLifecycleAudit(c, {
        eventUuid: row.event_uuid,
        action: "claim",
        leaseGeneration: Number(row.lease_generation),
        attemptCount: Number(row.attempt_count),
        fromStatus: "pending",
        toStatus: "processing",
        reasonCode: "worker_claim"
      });
    }
  }

  function isRowPoisonError(error: any) {
    return ["23503", "23505", "23514", "outbox_audit_conflict"].includes(String(error?.code || ""));
  }

  async function quarantinePendingEvent(c: any, event: OutboxEventRow, reasonCode: string) {
    await appendLifecycleAudit(c, {
      eventUuid: event.event_uuid,
      action: "failure",
      leaseGeneration: Number(event.lease_generation || 0),
      attemptCount: Number(event.attempt_count || 0),
      fromStatus: "pending",
      toStatus: "failed",
      reasonCode,
      keySuffix: `quarantine:${reasonCode}`
    });
    const quarantined = await c.query(
      `UPDATE siton.outbox_events
       SET status='failed', sent=false, sent_at=null, last_error=$2,
           processing_started_at=null, claimed_at=null, lease_expires_at=null,
           worker_id=null, last_heartbeat_at=null, updated_at=clock_timestamp()
       WHERE event_uuid=$1 AND status='pending' AND lease_generation=$3`,
      [event.event_uuid, reasonCode, Number(event.lease_generation || 0)]
    );
    if (Number(quarantined.rowCount || 0) !== 1) throw new OutboxLeaseLostError(event.event_uuid);
  }

  const returningColumns = `event_uuid, event_type, aggregate_type, aggregate_id, payload,
    attempt_count, max_attempts, processing_started_at, claimed_at, lease_expires_at,
    worker_id, correlation_id, request_id, lease_generation, last_heartbeat_at, last_error`;

  async function sweepExhaustedPending(c: any, eventId: string | null, limit: number) {
    const selected = await c.query(
      `SELECT ${returningColumns}
       FROM siton.outbox_events
       WHERE status='pending'
         AND available_at <= clock_timestamp()
         AND attempt_count >= LEAST(max_attempts,$1)
         AND ($2::uuid IS NULL OR event_uuid=$2)
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $3`,
      [workerMaxAttempts, eventId, eventId ? 1 : Math.min(500, Math.max(20, Math.floor(limit) * 10))]
    );
    let changed = 0;
    for (const [index, event] of (selected.rows as OutboxEventRow[]).entries()) {
      const savepoint = `outbox_sweep_${index}`;
      await c.query(`SAVEPOINT ${savepoint}`);
      try {
        await appendLifecycleAudit(c, {
          eventUuid: event.event_uuid,
          action: "failure",
          leaseGeneration: Number(event.lease_generation || 0),
          attemptCount: Number(event.attempt_count || 0),
          fromStatus: "pending",
          toStatus: "pending",
          reasonCode: "pending_max_attempts_exhausted",
          keySuffix: "pending-max-attempts"
        });
        await insertDlqFromLockedEvent(c, event, "pending_max_attempts_exhausted", "pending");
        await c.query(`RELEASE SAVEPOINT ${savepoint}`);
        changed += 1;
      } catch (error) {
        await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await c.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (!isRowPoisonError(error)) throw error;
        const quarantineSavepoint = `${savepoint}_quarantine`;
        await c.query(`SAVEPOINT ${quarantineSavepoint}`);
        try {
          await quarantinePendingEvent(c, event, "pending_dlq_archive_conflict");
          await c.query(`RELEASE SAVEPOINT ${quarantineSavepoint}`);
          changed += 1;
        } catch {
          await c.query(`ROLLBACK TO SAVEPOINT ${quarantineSavepoint}`);
          await c.query(`RELEASE SAVEPOINT ${quarantineSavepoint}`);
        }
      }
    }
    return changed;
  }

  async function claimOutboxBatch(limit: number): Promise<OutboxEventRow[]> {
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      await sweepExhaustedPending(c, null, limit);
      const batchLimit = Math.max(1, Math.floor(limit));
      const claimed: OutboxEventRow[] = [];
      const attemptedEventIds: string[] = [];
      while (claimed.length < batchLimit && attemptedEventIds.length < 500) {
        const selected = await c.query(
          `SELECT ${returningColumns}
           FROM siton.outbox_events
           WHERE status='pending'
             AND available_at <= clock_timestamp()
             AND attempt_count < LEAST(max_attempts,$1)
             AND event_uuid <> ALL($2::uuid[])
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
          [workerMaxAttempts, attemptedEventIds]
        );
        const candidate = selected.rows[0] as OutboxEventRow | undefined;
        if (!candidate) break;
        attemptedEventIds.push(candidate.event_uuid);
        const index = attemptedEventIds.length - 1;
        const savepoint = `outbox_claim_${index}`;
        await c.query(`SAVEPOINT ${savepoint}`);
        try {
          const updated = await c.query(
            `UPDATE siton.outbox_events
             SET status='processing', processing_started_at=clock_timestamp(), claimed_at=clock_timestamp(),
                 lease_expires_at=clock_timestamp() + ($2::text || ' milliseconds')::interval,
                 worker_id=$3, last_attempt_at=clock_timestamp(), last_heartbeat_at=clock_timestamp(),
                 attempt_count=attempt_count+1, lease_generation=lease_generation+1, updated_at=clock_timestamp()
             WHERE event_uuid=$1 AND status='pending' AND available_at <= clock_timestamp()
               AND attempt_count < LEAST(max_attempts,$4)
             RETURNING ${returningColumns}`,
            [candidate.event_uuid, String(leaseMs), workerId, workerMaxAttempts]
          );
          const row = updated.rows[0] as OutboxEventRow | undefined;
          if (!row) throw new OutboxLeaseLostError(candidate.event_uuid);
          await auditClaims(c, [row]);
          await c.query(`RELEASE SAVEPOINT ${savepoint}`);
          claimed.push(row);
        } catch (error) {
          await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await c.query(`RELEASE SAVEPOINT ${savepoint}`);
          if (!isRowPoisonError(error)) {
            if (error instanceof OutboxLeaseLostError) continue;
            throw error;
          }
          const quarantineSavepoint = `${savepoint}_quarantine`;
          await c.query(`SAVEPOINT ${quarantineSavepoint}`);
          try {
            await quarantinePendingEvent(c, candidate, "claim_audit_conflict");
            await c.query(`RELEASE SAVEPOINT ${quarantineSavepoint}`);
          } catch {
            await c.query(`ROLLBACK TO SAVEPOINT ${quarantineSavepoint}`);
            await c.query(`RELEASE SAVEPOINT ${quarantineSavepoint}`);
          }
        }
      }
      return claimed;
    });
  }

  async function claimOutboxEventById(eventId: string): Promise<OutboxEventRow | null> {
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      await sweepExhaustedPending(c, eventId, 1);
      const result = await c.query(
        `UPDATE siton.outbox_events
         SET status='processing', processing_started_at=clock_timestamp(), claimed_at=clock_timestamp(),
             lease_expires_at=clock_timestamp() + ($2::text || ' milliseconds')::interval,
             worker_id=$3, last_attempt_at=clock_timestamp(), last_heartbeat_at=clock_timestamp(),
             attempt_count=attempt_count+1, lease_generation=lease_generation+1, updated_at=clock_timestamp()
         WHERE event_uuid=$1 AND status='pending' AND available_at <= clock_timestamp()
           AND attempt_count < LEAST(max_attempts,$4)
         RETURNING ${returningColumns}`,
        [eventId, String(leaseMs), workerId, workerMaxAttempts]
      );
      const row = result.rows[0] as OutboxEventRow | undefined;
      if (row) await auditClaims(c, [row]);
      return row || null;
    });
  }

  async function reclaimStuckProcessing(_timeoutMs: number): Promise<number> {
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const selected = await c.query(
        `SELECT ${returningColumns}
         FROM siton.outbox_events
         WHERE status='processing'
           AND lease_generation >= 1
           AND worker_id IS NOT NULL
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= clock_timestamp()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 500`,
        []
      );
      const rows = selected.rows as OutboxEventRow[];
      let changed = 0;
      for (const [index, event] of rows.entries()) {
        const savepoint = `outbox_reclaim_${index}`;
        await c.query(`SAVEPOINT ${savepoint}`);
        try {
          const generation = Number(event.lease_generation || 0);
          await appendLifecycleAudit(c, {
            eventUuid: event.event_uuid,
            action: "reclaim",
            leaseGeneration: generation,
            attemptCount: Number(event.attempt_count || 0),
            fromStatus: "processing",
            toStatus: Number(event.attempt_count || 0) >= effectiveMaxAttempts(event.max_attempts) ? "processing" : "pending",
            reasonCode: "expired_worker_lease",
            metadata: {
              previous_worker_id_hash: evidenceHash(event.worker_id),
              previous_lease_expires_at: event.lease_expires_at || null,
              previous_last_heartbeat_at: event.last_heartbeat_at || null
            }
          });
          if (Number(event.attempt_count || 0) >= effectiveMaxAttempts(event.max_attempts)) {
            await appendLifecycleAudit(c, {
              eventUuid: event.event_uuid,
              action: "failure",
              leaseGeneration: generation,
              attemptCount: Number(event.attempt_count || 0),
              fromStatus: "processing",
              toStatus: "processing",
              reasonCode: "expired_lease_max_attempts"
            });
            await insertDlqFromLockedEvent(c, event, "expired_lease_max_attempts");
          } else {
            const updated = await c.query(
              `UPDATE siton.outbox_events
               SET status='pending', sent=false,
                   last_error=COALESCE(last_error, 'worker_reclaim_after_restart'),
                   processing_started_at=null, claimed_at=null, lease_expires_at=null,
                   worker_id=null, last_heartbeat_at=null, available_at=clock_timestamp(), updated_at=clock_timestamp()
               WHERE event_uuid=$1 AND status='processing' AND lease_generation=$2`,
              [event.event_uuid, generation]
            );
            if (Number(updated.rowCount || 0) !== 1) throw new OutboxLeaseLostError(event.event_uuid);
          }
          await c.query(`RELEASE SAVEPOINT ${savepoint}`);
          changed += 1;
        } catch {
          await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await c.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
      }
      return changed;
    });
  }

  async function markOutboxSent(eventId: string, leaseGeneration: number): Promise<void> {
    const generation = requireLeaseGeneration(leaseGeneration);
    await deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const locked = await c.query(
        `SELECT attempt_count
         FROM siton.outbox_events
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$2 AND lease_generation=$3
         FOR UPDATE`,
        [eventId, workerId, generation]
      );
      if (Number(locked.rowCount || 0) !== 1) throw new OutboxLeaseLostError(eventId);
      const result = await c.query(
        `UPDATE siton.outbox_events
         SET status='sent', sent=true, sent_at=clock_timestamp(), last_error=null,
             processing_started_at=null, claimed_at=null, lease_expires_at=null,
             worker_id=null, last_heartbeat_at=null, updated_at=clock_timestamp()
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$2
           AND lease_generation=$3 AND lease_expires_at > clock_timestamp()
         RETURNING attempt_count`,
        [eventId, workerId, generation]
      );
      if (Number(result.rowCount || 0) !== 1) throw new OutboxLeaseLostError(eventId);
      await appendLifecycleAudit(c, {
        eventUuid: eventId,
        action: "completion",
        leaseGeneration: generation,
        attemptCount: Number(result.rows[0]?.attempt_count || 0),
        fromStatus: "processing",
        toStatus: "sent",
        reasonCode: "worker_completed"
      });
    });
  }

  async function markOutboxFailed(eventId: string, leaseGeneration: number, err: any): Promise<void> {
    const generation = requireLeaseGeneration(leaseGeneration);
    const msg = errorMessage(err);
    const reasonCode = isPermanentFail(err)
      ? "permanent_failure"
      : isDeferredEventError(err)
        ? "deferred_failure"
        : isTemporaryError(err)
          ? "temporary_failure"
          : safeErrorCode(err);
    await deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const locked = await c.query(
        `SELECT ${returningColumns}
         FROM siton.outbox_events
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$2
           AND lease_generation=$3
         FOR UPDATE`,
        [eventId, workerId, generation]
      );
      const event = locked.rows[0] as OutboxEventRow | undefined;
      if (!event) throw new OutboxLeaseLostError(eventId);
      const lease = await c.query(
        `SELECT lease_expires_at > clock_timestamp() AS valid
         FROM siton.outbox_events WHERE event_uuid=$1`,
        [eventId]
      );
      if (lease.rows[0]?.valid !== true) throw new OutboxLeaseLostError(eventId);
      event.last_error = msg;
      await appendLifecycleAudit(c, {
        eventUuid: eventId,
        action: "failure",
        leaseGeneration: generation,
        attemptCount: Number(event.attempt_count || 0),
        fromStatus: "processing",
        toStatus: "processing",
        reasonCode,
        metadata: { error_message_hash: evidenceHash(msg) }
      });

      const attemptCount = Math.max(0, Number(event.attempt_count || 0));
      const maxAttempts = effectiveMaxAttempts(event.max_attempts);
      if (isPermanentFail(err) || attemptCount >= maxAttempts) {
        await insertDlqFromLockedEvent(
          c,
          event,
          isPermanentFail(err) ? "permanent_failure" : "max_attempts_exhausted",
          "processing",
          true
        );
        return;
      }

      if (isDeferredEventError(err)) {
        const retryAt = (err as any).retryAt instanceof Date ? (err as any).retryAt : new Date((err as any).retryAt);
        if (!Number.isFinite(retryAt.getTime())) throw new Error("deferred retry time is invalid");
        const result = await c.query(
          `UPDATE siton.outbox_events
           SET status='pending', sent=false, last_error=$4, available_at=$5,
               processing_started_at=null, claimed_at=null, lease_expires_at=null,
               worker_id=null, last_heartbeat_at=null, updated_at=clock_timestamp()
           WHERE event_uuid=$1 AND status='processing' AND worker_id=$2
             AND lease_generation=$3 AND lease_expires_at > clock_timestamp()
             AND $5::timestamptz > clock_timestamp()`,
          [eventId, workerId, generation, msg, retryAt.toISOString()]
        );
        if (Number(result.rowCount || 0) !== 1) throw new OutboxLeaseLostError(eventId);
        await appendLifecycleAudit(c, {
          eventUuid: eventId,
          action: "retry",
          leaseGeneration: generation,
          attemptCount,
          fromStatus: "processing",
          toStatus: "pending",
          reasonCode: "deferred_retry"
        });
        return;
      }

      const nextDelay = calculateOutboxRetryDelayMs({
        attemptCount,
        baseMs: deps.outboxPollMs,
        temporary: isTemporaryError(err)
      });
      const result = await c.query(
        `UPDATE siton.outbox_events
         SET status='pending', sent=false, last_error=$4,
             available_at=clock_timestamp() + ($5::text || ' milliseconds')::interval,
             processing_started_at=null, claimed_at=null, lease_expires_at=null,
             worker_id=null, last_heartbeat_at=null, updated_at=clock_timestamp()
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$2
           AND lease_generation=$3 AND lease_expires_at > clock_timestamp()`,
        [eventId, workerId, generation, msg, String(nextDelay)]
      );
      if (Number(result.rowCount || 0) !== 1) throw new OutboxLeaseLostError(eventId);
      await appendLifecycleAudit(c, {
        eventUuid: eventId,
        action: "retry",
        leaseGeneration: generation,
        attemptCount,
        fromStatus: "processing",
        toStatus: "pending",
        reasonCode: isTemporaryError(err) ? "temporary_retry" : "worker_retry",
        metadata: { retry_delay_ms: nextDelay }
      });
    });
  }

  async function heartbeatOutboxLease(eventId: string, leaseGeneration: number): Promise<boolean> {
    const generation = requireLeaseGeneration(leaseGeneration);
    return deps.withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const locked = await c.query(
        `SELECT attempt_count
         FROM siton.outbox_events
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$2 AND lease_generation=$3
         FOR UPDATE`,
        [eventId, workerId, generation]
      );
      if (Number(locked.rowCount || 0) !== 1) return false;
      const result = await c.query(
        `UPDATE siton.outbox_events
         SET lease_expires_at=clock_timestamp() + ($4::text || ' milliseconds')::interval,
             last_heartbeat_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE event_uuid=$1 AND status='processing' AND worker_id=$2
           AND lease_generation=$3 AND lease_expires_at > clock_timestamp()
         RETURNING attempt_count, lease_expires_at::text AS lease_expires_at_text,
                   txid_current()::text AS heartbeat_txid`,
        [eventId, workerId, generation, String(leaseMs)]
      );
      if (Number(result.rowCount || 0) !== 1) return false;
      const heartbeatKey = `${String(result.rows[0].lease_expires_at_text)}:${String(result.rows[0].heartbeat_txid)}`;
      await appendLifecycleAudit(c, {
        eventUuid: eventId,
        action: "heartbeat",
        leaseGeneration: generation,
        attemptCount: Number(result.rows[0].attempt_count || 0),
        fromStatus: "processing",
        toStatus: "processing",
        reasonCode: "lease_extended",
        keySuffix: heartbeatKey
      });
      return true;
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
