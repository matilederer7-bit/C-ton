import pg from "pg";
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
  runWorkerMaintenance
} from "./app.js";
import { runScheduledWorkerBatch } from "./worker_scheduler.js";
import { assertProductionRuntimeGuards } from "./production_guards.js";

const { Pool } = pg;
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
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

const controlPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
let accepting = true;
let activeCycle: Promise<void> | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

async function writeHeartbeat(status: "starting" | "ready" | "draining" | "stopped") {
  await controlPool.query(
    `INSERT INTO siton.worker_heartbeats(worker_id, started_at, heartbeat_at, status, metadata)
     VALUES ($1,now(),now(),$2,$3::jsonb)
     ON CONFLICT (worker_id) DO UPDATE
       SET heartbeat_at=now(), status=EXCLUDED.status, metadata=EXCLUDED.metadata`,
    [WORKER_ID, status, JSON.stringify({ pid: process.pid, concurrency: CONCURRENCY })]
  );
}

async function queueMetrics() {
  const result = await controlPool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='pending')::int AS queue_depth,
       COUNT(*) FILTER (WHERE status='processing')::int AS jobs_processing,
       COUNT(*) FILTER (WHERE status='processing' AND lease_expires_at <= now())::int AS stale_leases,
       (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count
     FROM siton.outbox_events`
  );
  return result.rows[0];
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
  const retries = failed;
  await runWorkerMaintenance();
  const metrics = await queueMetrics();
  logger.info({
    worker_id: WORKER_ID,
    jobs_completed: completed,
    jobs_failed: failed,
    retry_count: retries,
    job_latency_ms: Date.now() - started,
    ...metrics
  }, "worker_cycle");
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
    writeHeartbeat(accepting ? "ready" : "draining").catch((error) => logger.error({ err: error }, "worker_heartbeat_failed"));
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
  await writeHeartbeat("ready");
  logger.info({ worker_id: WORKER_ID, concurrency: CONCURRENCY }, "worker_ready");

  let pollCount = 0;
  while (accepting) {
    activeCycle = processCycle(pollCount++);
    try {
      await activeCycle;
    } catch (error) {
      logger.error({ err: error, worker_id: WORKER_ID }, "worker_cycle_failed");
    } finally {
      activeCycle = null;
    }
    if (accepting) await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
}

export async function stopWorker(signal: string) {
  if (!accepting) return;
  accepting = false;
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
  logger.info({ worker_id: WORKER_ID }, "worker_stopped");
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPath === import.meta.url) {
  process.once("SIGTERM", () => stopWorker("SIGTERM").then(() => process.exit(0)).catch(() => process.exit(1)));
  process.once("SIGINT", () => stopWorker("SIGINT").then(() => process.exit(0)).catch(() => process.exit(1)));
  startWorker().catch(async (error) => {
    logger.fatal({ err: error, worker_id: WORKER_ID }, "worker_start_failed");
    await stopWorker("startup_failure").catch(() => undefined);
    process.exitCode = 1;
  });
}
