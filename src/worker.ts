import pino from "pino";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  assertWorkerDatabaseReady,
  claimPendingOutboxBatch,
  closeWorkerDatabase,
  getWorkerIdentity,
  processClaimedOutboxEvent,
  reclaimWorkerJobs,
  runWorkerMaintenance,
  workerAbandonedJobsInFlight
} from "./app.js";
import {
  KeyedRateLimiter,
  WorkerAlertEmitter,
  WorkerWatchdog,
  runScheduledWorkerBatch,
  workerCycleDelayMs,
  type WorkerAlert,
  type WorkerQueueMetrics
} from "./worker_scheduler.js";
import { assertProductionRuntimeGuards } from "./production_guards.js";
import { createRuntimePool } from "./db.js";
import {
  captureException,
  captureSelfTestIfRequested,
  errorMonitoringSummary,
  flushMonitoring,
  initErrorMonitoring,
  installProcessErrorCapture
} from "./error_monitoring.js";
import { errorLogSerializer } from "./log_redaction.js";
import { resolveWorkerResilienceConfig } from "./runtime_config.js";

export const logger = pino({ level: process.env.LOG_LEVEL || "info", serializers: { err: errorLogSerializer } });
const WORKER_ID = getWorkerIdentity();
const POLL_MS = Math.max(50, Number(process.env.OUTBOX_POLL_MS || 1_000));
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.WORKER_CONCURRENCY || 4)));
const MONEY_CONCURRENCY = Math.max(1, Math.min(CONCURRENCY, Number(process.env.WORKER_MONEY_CONCURRENCY || 1)));
const RECONCILE_CONCURRENCY = Math.max(1, Math.min(CONCURRENCY, Number(process.env.WORKER_RECONCILE_CONCURRENCY || 1)));
const INVOICE_CONCURRENCY = Math.max(1, Math.min(CONCURRENCY, Number(process.env.WORKER_INVOICE_CONCURRENCY || 2)));
const RECLAIM_EVERY = Math.max(1, Number(process.env.WORKER_RECLAIM_EVERY_POLLS || 10));
const STUCK_TIMEOUT_MS = Math.max(5_000, Number(process.env.WORKER_STUCK_TIMEOUT_MS || 60_000));
const HEARTBEAT_MS = Math.max(1_000, Number(process.env.WORKER_HEARTBEAT_MS || 10_000));
const SHUTDOWN_TIMEOUT_MS = Math.max(1_000, Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || 30_000));
const RESILIENCE = resolveWorkerResilienceConfig(POLL_MS);
// The two-process fencing proof deliberately blocks deadline_check handlers
// with a table lock. Worker maintenance also reads that table, which can stall
// a worker before it reaches the claim path the proof is trying to exercise.
// Keep this escape hatch test-only so production behavior can never disable
// maintenance through configuration.
const TEST_DISABLE_MAINTENANCE =
  process.env.NODE_ENV === "test" && process.env.SITON_TEST_DISABLE_WORKER_MAINTENANCE === "1";

const controlPool = createRuntimePool("worker", 2);
let accepting = true;
let activeCycle: Promise<void> | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let consecutiveCycleFailures = 0;
let cyclesCompleted = 0;

const watchdog = new WorkerWatchdog({
  stallMs: RESILIENCE.watchdogStallMs,
  maxHeartbeatFailures: RESILIENCE.watchdogMaxHeartbeatFailures
});

class WorkerAlertError extends Error {
  constructor(key: string) {
    // Stable message = stable monitoring fingerprint per alert key.
    super(`worker_alert:${key}`);
    this.name = "WorkerAlert";
  }
}

// Pushed alerting: a stable log event ("worker_alert") for log-based alert
// rules plus an error-monitoring event, each key at most once per window.
const alerts = new WorkerAlertEmitter({
  thresholds: {
    oldestPendingMs: RESILIENCE.alertOldestPendingMs,
    consecutiveCycleFailures: RESILIENCE.alertConsecutiveCycleFailures
  },
  windowMs: RESILIENCE.alertWindowMs,
  sink: (alert: WorkerAlert) => {
    logger.error({ event: "worker_alert", alert_key: alert.key, alert_message: alert.message, worker_id: WORKER_ID, ...alert.details }, "worker_alert");
    captureException(new WorkerAlertError(alert.key), {
      level: "error",
      mechanism: "worker_alert",
      tags: { worker_id: WORKER_ID, alert_key: alert.key }
    });
  }
});

// Error-monitoring budget for repeated failures (cycle/heartbeat): at most one
// captured event per error code per alert window; every failure is still logged.
const captureLimiter = new KeyedRateLimiter(RESILIENCE.alertWindowMs);

function errorCode(error: unknown) {
  const value = error as { code?: unknown; name?: unknown } | null;
  return String(value?.code || value?.name || "error").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

async function writeHeartbeat(status: "starting" | "ready" | "draining" | "stopped") {
  await controlPool.query(
    `INSERT INTO siton.worker_heartbeats(worker_id, started_at, heartbeat_at, status, metadata)
     VALUES ($1,now(),now(),$2,$3::jsonb)
     ON CONFLICT (worker_id) DO UPDATE
       SET heartbeat_at=now(), status=EXCLUDED.status, metadata=EXCLUDED.metadata`,
    [WORKER_ID, status, JSON.stringify({
      pid: process.pid,
      concurrency: CONCURRENCY,
      // Progress, not just liveness: when did a cycle last COMPLETE.
      last_cycle_completed_at: watchdog.lastCycleCompletedAtIso(),
      cycles_completed: cyclesCompleted,
      consecutive_cycle_failures: consecutiveCycleFailures,
      abandoned_jobs_in_flight: workerAbandonedJobsInFlight()
    })]
  );
}

/**
 * Queue health for the cycle log and alerting. Only live (non-sent) rows are
 * scanned: the predicate on status is served by idx_outbox_pending
 * (status, available_at, created_at), so the cost tracks the live queue, not
 * the ever-growing history of sent events.
 */
async function queueMetrics(): Promise<WorkerQueueMetrics> {
  const result = await controlPool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='pending')::int AS queue_depth,
       COUNT(*) FILTER (WHERE status='processing')::int AS jobs_processing,
       COUNT(*) FILTER (WHERE status='processing' AND lease_expires_at <= now())::int AS stale_leases,
       COUNT(*) FILTER (WHERE status='failed')::int AS quarantined,
       (EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending' AND available_at <= now()))) * 1000)::float8
         AS oldest_pending_age_ms,
       (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count
     FROM siton.outbox_events
     WHERE status IN ('pending','processing','failed')`
  );
  const row = result.rows[0] || {};
  return {
    queue_depth: Number(row.queue_depth || 0),
    jobs_processing: Number(row.jobs_processing || 0),
    stale_leases: Number(row.stale_leases || 0),
    quarantined: Number(row.quarantined || 0),
    oldest_pending_age_ms: row.oldest_pending_age_ms === null || row.oldest_pending_age_ms === undefined ? null : Math.max(0, Math.round(Number(row.oldest_pending_age_ms))),
    dlq_count: Number(row.dlq_count || 0)
  };
}

async function processCycle(pollCount: number) {
  const started = Date.now();
  if (pollCount % RECLAIM_EVERY === 0) {
    const reclaimed = await reclaimWorkerJobs(STUCK_TIMEOUT_MS);
    if (reclaimed.outbox || reclaimed.invoices) logger.warn({ worker_id: WORKER_ID, reclaimed }, "worker_reclaimed_stale_work");
  }

  const jobs = await claimPendingOutboxBatch(CONCURRENCY);
  const results = await runScheduledWorkerBatch({
    jobs,
    limits: {
      money: MONEY_CONCURRENCY,
      reconcile: RECONCILE_CONCURRENCY,
      invoice: INVOICE_CONCURRENCY,
      default: CONCURRENCY
    },
    process: processClaimedOutboxEvent
  });
  const completed = results.filter((item) => item?.status === "sent").length;
  const failed = results.filter((item) => item?.status === "failed").length;
  const leaseLost = results.filter((item) => item?.status === "lease_lost").length;
  const deadlineExceeded = results.filter((item) => item?.status === "deadline_exceeded");
  const retries = failed;
  if (deadlineExceeded.length) {
    alerts.emit({
      key: "event_deadline_exceeded",
      message: `${deadlineExceeded.length} outbox job(s) exceeded the per-job deadline and were abandoned to lease expiry`,
      details: {
        jobs: deadlineExceeded.map((item) => ({ event_uuid: item.event_uuid, event_type: item.event_type })),
        abandoned_jobs_in_flight: workerAbandonedJobsInFlight()
      }
    });
  }
  if (!TEST_DISABLE_MAINTENANCE) await runWorkerMaintenance();
  const metrics = await queueMetrics();
  logger.info({
    worker_id: WORKER_ID,
    jobs_completed: completed,
    jobs_failed: failed,
    jobs_lease_lost: leaseLost,
    jobs_deadline_exceeded: deadlineExceeded.length,
    abandoned_jobs_in_flight: workerAbandonedJobsInFlight(),
    retry_count: retries,
    job_latency_ms: Date.now() - started,
    ...metrics
  }, "worker_cycle");
  alerts.observeMetrics(metrics);
}

async function watchdogFatal(reason: string, details: Record<string, unknown>) {
  logger.fatal({ worker_id: WORKER_ID, reason, ...details }, "worker_watchdog_fatal");
  captureException(new WorkerAlertError(`watchdog_${reason}`), {
    level: "fatal",
    mechanism: "worker_watchdog",
    handled: false,
    tags: { worker_id: WORKER_ID, reason }
  });
  await flushMonitoring(2_000).catch(() => undefined);
  // Exit non-zero so the platform supervisor (Render) restarts the worker.
  // In-flight jobs are NOT acked: their leases expire and are reclaimed.
  process.exit(1);
}

function startWatchdog() {
  watchdogTimer = setInterval(() => {
    if (!accepting) return;
    const verdict = watchdog.check();
    if (verdict.ok) return;
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
    void watchdogFatal(verdict.reason, verdict.details);
  }, RESILIENCE.watchdogIntervalMs);
  watchdogTimer.unref();
}

export async function startWorker() {
  assertProductionRuntimeGuards("worker");
  let readyError: unknown = null;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await assertWorkerDatabaseReady();
      readyError = null;
      break;
    } catch (error) {
      readyError = error;
      logger.warn({ attempt, err: error }, "worker_waiting_for_migrated_database");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(10_000, attempt * 1_000)));
    }
  }
  if (readyError) throw readyError;
  await writeHeartbeat("starting");
  heartbeatTimer = setInterval(() => {
    writeHeartbeat(accepting ? "ready" : "draining").then(() => {
      watchdog.heartbeatSucceeded();
    }, (error) => {
      watchdog.heartbeatFailed();
      logger.error({ err: error, worker_id: WORKER_ID }, "worker_heartbeat_failed");
      if (captureLimiter.tryAcquire(`heartbeat:${errorCode(error)}`)) {
        captureException(error, { mechanism: "worker_heartbeat", tags: { worker_id: WORKER_ID } });
      }
    });
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
  await writeHeartbeat("ready");
  watchdog.cycleCompleted();
  startWatchdog();
  logger.info({
    worker_id: WORKER_ID,
    concurrency: CONCURRENCY,
    event_timeout_ms: RESILIENCE.eventTimeoutMs,
    watchdog_stall_ms: RESILIENCE.watchdogStallMs,
    watchdog_max_heartbeat_failures: RESILIENCE.watchdogMaxHeartbeatFailures
  }, "worker_ready");
  captureSelfTestIfRequested("worker");

  let pollCount = 0;
  while (accepting) {
    activeCycle = processCycle(pollCount++);
    try {
      await activeCycle;
      consecutiveCycleFailures = 0;
      cyclesCompleted += 1;
      watchdog.cycleCompleted();
    } catch (error) {
      consecutiveCycleFailures += 1;
      const code = errorCode(error);
      logger.error({
        err: error,
        worker_id: WORKER_ID,
        consecutive_cycle_failures: consecutiveCycleFailures,
        next_cycle_delay_ms: workerCycleDelayMs({ pollMs: POLL_MS, consecutiveFailures: consecutiveCycleFailures, capMs: RESILIENCE.cycleBackoffCapMs })
      }, "worker_cycle_failed");
      if (captureLimiter.tryAcquire(`cycle:${code}`)) {
        captureException(error, { mechanism: "worker_cycle", tags: { worker_id: WORKER_ID, consecutive_cycle_failures: consecutiveCycleFailures } });
      }
      alerts.observeCycleFailures(consecutiveCycleFailures, code);
    } finally {
      activeCycle = null;
    }
    if (accepting) {
      const delay = workerCycleDelayMs({ pollMs: POLL_MS, consecutiveFailures: consecutiveCycleFailures, capMs: RESILIENCE.cycleBackoffCapMs });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
}

export async function stopWorker(signal: string) {
  if (!accepting) return;
  accepting = false;
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  logger.info({ signal, worker_id: WORKER_ID }, "worker_draining");
  await writeHeartbeat("draining").catch(() => undefined);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (activeCycle) {
    await Promise.race([
      activeCycle.catch(() => undefined),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS))
    ]);
  }
  await writeHeartbeat("stopped").catch(() => undefined);
  await controlPool.end();
  await closeWorkerDatabase();
  await flushMonitoring(2_000);
  logger.info({ worker_id: WORKER_ID }, "worker_stopped");
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPath === import.meta.url) {
  initErrorMonitoring({ service: "worker" });
  installProcessErrorCapture((error, kind) => logger.fatal({ err: error, kind, worker_id: WORKER_ID }, "process_fatal_error"));
  logger.info(errorMonitoringSummary(), "error_monitoring");
  process.once("SIGTERM", () => stopWorker("SIGTERM").then(() => process.exit(0)).catch(() => process.exit(1)));
  process.once("SIGINT", () => stopWorker("SIGINT").then(() => process.exit(0)).catch(() => process.exit(1)));
  startWorker().catch(async (error) => {
    logger.fatal({ err: error, worker_id: WORKER_ID }, "worker_start_failed");
    captureException(error, { level: "fatal", mechanism: "startup", handled: false, tags: { worker_id: WORKER_ID } });
    await stopWorker("startup_failure").catch(() => undefined);
    await flushMonitoring(2_000);
    process.exitCode = 1;
  });
}
