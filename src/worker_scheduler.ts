import type { OutboxEventRow } from "./outbox_worker_helpers.js";

export type WorkerLane = "money" | "reconcile" | "invoice" | "default";

// Concurrency lanes. payment_reconcile/payment_release run in the money lane:
// they can apply canonical money transitions and must serialize with charge
// processing.
export const MONEY_LANE_EVENT_TYPES: readonly string[] = [
  "charge_deal",
  "recovery_deal",
  "refund_issue",
  "cancel_refund",
  "payment_reconcile",
  "payment_release"
];
export const RECONCILE_LANE_EVENT_TYPES: readonly string[] = ["seller_payout_reconcile", "invoice_document_reconcile"];
export const INVOICE_LANE_EVENT_TYPES: readonly string[] = ["invoice_document_issue"];
// Seller payout preparation/dispatch share the default CONCURRENCY lane, but
// they move money, so they share the money RETRY policy (long, jittered
// budget that survives a provider blip).
export const PAYOUT_EVENT_TYPES: readonly string[] = ["seller_payout_prepare", "seller_payout_dispatch"];

export function workerLane(eventType: string): WorkerLane {
  if (MONEY_LANE_EVENT_TYPES.includes(eventType)) return "money";
  if (RECONCILE_LANE_EVENT_TYPES.includes(eventType)) return "reconcile";
  if (INVOICE_LANE_EVENT_TYPES.includes(eventType)) return "invoice";
  return "default";
}

/**
 * Retry-policy class of an outbox event type. Identical to the concurrency
 * lane except that payout preparation/dispatch retry like money events.
 * Unknown event types (e.g. a type introduced by a newer deploy) are "default".
 */
export function outboxRetryClass(eventType: string): WorkerLane {
  if (PAYOUT_EVENT_TYPES.includes(eventType)) return "money";
  return workerLane(eventType);
}

export async function runScheduledWorkerBatch<T>(args: {
  jobs: OutboxEventRow[];
  limits: Record<WorkerLane, number>;
  process: (job: OutboxEventRow) => Promise<T>;
}) {
  const runLane = async (lane: WorkerLane) => {
    const results: T[] = [];
    const queue = args.jobs.filter((job) => workerLane(job.event_type) === lane);
    let next = 0;
    const runner = async () => {
      while (next < queue.length) {
        const job = queue[next++];
        if (job) results.push(await args.process(job));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, args.limits[lane]) }, runner));
    return results;
  };
  const lanes = await Promise.all((["money", "reconcile", "invoice", "default"] as const).map(runLane));
  return lanes.flat();
}

// ---------------------------------------------------------------------------
// Worker resilience primitives (pure, clock-injectable; wired by worker.ts).
// ---------------------------------------------------------------------------

/**
 * Delay before the next worker cycle. A healthy cycle waits exactly pollMs; a
 * run of consecutive failed cycles backs off exponentially (pollMs*2^(n-1))
 * up to capMs so a database/provider outage does not spin at the poll rate.
 */
export function workerCycleDelayMs(args: { pollMs: number; consecutiveFailures: number; capMs?: number }) {
  const poll = Math.max(1, Math.floor(Number(args.pollMs) || 1));
  const cap = Math.max(poll, Math.floor(Number(args.capMs ?? 60_000) || 60_000));
  const failures = Math.max(0, Math.floor(Number(args.consecutiveFailures) || 0));
  if (failures === 0) return poll;
  return Math.min(cap, poll * (2 ** Math.min(30, failures - 1)));
}

/** Allows one emission per key per window. */
export class KeyedRateLimiter {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  tryAcquire(key: string): boolean {
    const current = this.now();
    const last = this.lastAt.get(key);
    if (last !== undefined && current - last < this.windowMs) return false;
    this.lastAt.set(key, current);
    return true;
  }
}

export type WorkerQueueMetrics = {
  queue_depth: number;
  jobs_processing: number;
  stale_leases: number;
  dlq_count: number;
  oldest_pending_age_ms: number | null;
  quarantined?: number;
};

export type WorkerAlertKey =
  | "dlq_increased"
  | "oldest_pending_stale"
  | "stale_leases"
  | "consecutive_cycle_failures"
  | "event_deadline_exceeded";

export type WorkerAlert = { key: WorkerAlertKey; message: string; details: Record<string, unknown> };

export type WorkerAlertThresholds = {
  oldestPendingMs: number;
  consecutiveCycleFailures: number;
};

/**
 * Stateful evaluator for pushed worker alerts. It remembers the last DLQ count
 * so it alerts on an INCREASE (a baseline is taken on the first observation),
 * and rate-limits every alert key to one emission per window.
 */
export class WorkerAlertEmitter {
  private lastDlqCount: number | null = null;
  private readonly limiter: KeyedRateLimiter;

  constructor(private readonly args: {
    thresholds: WorkerAlertThresholds;
    windowMs: number;
    sink: (alert: WorkerAlert) => void;
    now?: () => number;
  }) {
    this.limiter = new KeyedRateLimiter(args.windowMs, args.now || Date.now);
  }

  /** Emits the alert unless its key already fired within the window. */
  emit(alert: WorkerAlert): boolean {
    if (!this.limiter.tryAcquire(alert.key)) return false;
    try {
      this.args.sink(alert);
    } catch {
      // Alerting must never break the worker loop.
    }
    return true;
  }

  /** Evaluates one cycle's queue metrics; returns the alerts actually emitted. */
  observeMetrics(metrics: WorkerQueueMetrics): WorkerAlert[] {
    const candidates: WorkerAlert[] = [];
    const dlq = Number(metrics.dlq_count || 0);
    if (this.lastDlqCount !== null && dlq > this.lastDlqCount) {
      candidates.push({
        key: "dlq_increased",
        message: `outbox DLQ grew from ${this.lastDlqCount} to ${dlq}`,
        details: { previous_dlq_count: this.lastDlqCount, dlq_count: dlq, delta: dlq - this.lastDlqCount }
      });
    }
    this.lastDlqCount = dlq;
    const oldest = metrics.oldest_pending_age_ms === null || metrics.oldest_pending_age_ms === undefined
      ? null
      : Number(metrics.oldest_pending_age_ms);
    if (oldest !== null && Number.isFinite(oldest) && oldest > this.args.thresholds.oldestPendingMs) {
      candidates.push({
        key: "oldest_pending_stale",
        message: `oldest due outbox job has waited ${Math.round(oldest / 1000)}s`,
        details: { oldest_pending_age_ms: Math.round(oldest), threshold_ms: this.args.thresholds.oldestPendingMs, queue_depth: metrics.queue_depth }
      });
    }
    if (Number(metrics.stale_leases || 0) > 0) {
      candidates.push({
        key: "stale_leases",
        message: `${metrics.stale_leases} outbox job(s) hold an expired lease`,
        details: { stale_leases: metrics.stale_leases, jobs_processing: metrics.jobs_processing }
      });
    }
    return candidates.filter((alert) => this.emit(alert));
  }

  observeCycleFailures(consecutiveFailures: number, errorCode?: string): WorkerAlert[] {
    if (consecutiveFailures < this.args.thresholds.consecutiveCycleFailures) return [];
    const alert: WorkerAlert = {
      key: "consecutive_cycle_failures",
      message: `worker cycle failed ${consecutiveFailures} times in a row`,
      details: { consecutive_cycle_failures: consecutiveFailures, threshold: this.args.thresholds.consecutiveCycleFailures, error_code: errorCode || null }
    };
    return this.emit(alert) ? [alert] : [];
  }
}

export type WatchdogVerdict =
  | { ok: true }
  | { ok: false; reason: "cycle_stalled" | "heartbeat_failing"; details: Record<string, unknown> };

/**
 * Progress watchdog. Liveness (a heartbeat row) is not progress: a worker
 * whose loop is wedged keeps heartbeating. The watchdog fails when no cycle
 * has COMPLETED for stallMs, or when the heartbeat write itself has failed
 * maxHeartbeatFailures times in a row. The caller exits the process so the
 * platform supervisor restarts it.
 */
export class WorkerWatchdog {
  private lastCycleCompletedAt: number;
  private consecutiveHeartbeatFailures = 0;

  constructor(private readonly args: { stallMs: number; maxHeartbeatFailures: number; now?: () => number }) {
    this.lastCycleCompletedAt = this.now();
  }

  private now() {
    return (this.args.now || Date.now)();
  }

  cycleCompleted() {
    this.lastCycleCompletedAt = this.now();
  }

  heartbeatSucceeded() {
    this.consecutiveHeartbeatFailures = 0;
  }

  heartbeatFailed() {
    this.consecutiveHeartbeatFailures += 1;
  }

  lastCycleCompletedAtIso() {
    return new Date(this.lastCycleCompletedAt).toISOString();
  }

  check(): WatchdogVerdict {
    const sinceCycle = this.now() - this.lastCycleCompletedAt;
    if (sinceCycle > this.args.stallMs) {
      return {
        ok: false,
        reason: "cycle_stalled",
        details: { ms_since_last_cycle_completed: sinceCycle, stall_ms: this.args.stallMs, last_cycle_completed_at: this.lastCycleCompletedAtIso() }
      };
    }
    if (this.consecutiveHeartbeatFailures >= this.args.maxHeartbeatFailures) {
      return {
        ok: false,
        reason: "heartbeat_failing",
        details: { consecutive_heartbeat_failures: this.consecutiveHeartbeatFailures, max: this.args.maxHeartbeatFailures }
      };
    }
    return { ok: true };
  }
}
