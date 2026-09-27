// Readiness probe with a short-TTL cache, single-flight execution, a bounded
// check timeout and a transient-error grace period (Black-Sky F-H4).
//
// Why this exists. `/readiness` is the Render health-check path. Before this
// module every probe ran the full canonical check (migration ledger, schema
// drift, runtime role, inventory RPC) on the shared pool, uncached, and any
// single failed check - including a one-off connection reset during a
// database failover - answered 503. Render restarts a service whose health
// check fails, so a database blip became a web restart storm (F-H4), and every
// probe cost several catalog queries on the pool the buyers use (C11).
//
// Semantics:
//   * a verdict is cached for `ttlMs` (default 5 s): concurrent and repeated
//     probes inside the window share ONE database check;
//   * the check itself is bounded by `timeoutMs`; a timed-out check is a
//     transient failure, never a hang of the probe;
//   * a TRANSIENT failure (connection refused/reset, connect timeout, server
//     shutting down, too many connections, probe timeout) inside `graceMs`
//     (default 60 s) of the last successful check answers 200 with
//     `database: "degraded"` - the process is alive and was proven correct
//     moments ago; restarting it would not fix the database. Past the grace
//     period the probe answers 503: a long outage is a real not-ready;
//   * every OTHER failure is fatal and answers 503 immediately: a schema
//     contract violation, a wrong runtime role, a missing inventory RPC or a
//     closed pool is never masked by a previous success. Fail closed by
//     default; only well-known connection errors are transient.
//
// The 503 body is exactly `{ ok: false, code: "not_ready" }` (the contract the
// existing readiness tests pin); cache metadata travels in headers.

export type ReadinessFailureKind = "transient" | "fatal";

export type ReadinessVerdict =
  | { ok: true; body: Record<string, unknown>; status: 200; degraded: boolean; checked_at: number }
  | { ok: false; body: { ok: false; code: "not_ready" }; status: 503; kind: ReadinessFailureKind; reason: string; checked_at: number };

export type ReadinessProbeOptions = {
  check: () => Promise<Record<string, unknown>>;
  ttlMs?: number;
  timeoutMs?: number;
  graceMs?: number;
  now?: () => number;
  onEvent?: (event: { kind: "transient" | "fatal" | "degraded" | "recovered"; reason: string }) => void;
};

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // PostgreSQL: operator intervention / cannot connect now / connection exceptions / insufficient resources.
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "53200",
  "53100",
  "53000",
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  // Our own bounded-check timeout.
  "readiness_check_timeout"
]);

const TRANSIENT_MESSAGE_RE = /timeout exceeded when trying to connect|connection terminated|terminating connection|server closed the connection|the database system is (?:starting|shutting) (?:up|down)|too many clients|readiness_check_timeout|socket hang up|connect ETIMEDOUT/i;

export const READINESS_CHECK_TIMEOUT_ERROR = "readiness_check_timeout";

/** Transient = a well-known connection-level failure; everything else fails closed. */
export function classifyReadinessError(error: unknown): ReadinessFailureKind {
  const code = String((error as any)?.code || "").trim();
  if (code && TRANSIENT_ERROR_CODES.has(code)) return "transient";
  const message = String((error as any)?.message || error || "");
  if (TRANSIENT_MESSAGE_RE.test(message)) return "transient";
  return "fatal";
}

export function resolveReadinessProbeConfig(env: NodeJS.ProcessEnv = process.env) {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    ttlMs: read("READINESS_CACHE_TTL_MS", 5_000, 0, 60_000),
    timeoutMs: read("READINESS_CHECK_TIMEOUT_MS", 3_000, 100, 30_000),
    graceMs: read("READINESS_TRANSIENT_GRACE_MS", 60_000, 0, 10 * 60_000)
  };
}

export function createReadinessProbe(options: ReadinessProbeOptions) {
  const defaults = resolveReadinessProbeConfig();
  const ttlMs = options.ttlMs ?? defaults.ttlMs;
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
  const graceMs = options.graceMs ?? defaults.graceMs;
  const now = options.now ?? (() => Date.now());

  let cached: ReadinessVerdict | null = null;
  let lastSuccessAt: number | null = null;
  let lastSuccessBody: Record<string, unknown> | null = null;
  let inflight: Promise<ReadinessVerdict> | null = null;
  let checks = 0;
  let consecutiveTransientFailures = 0;

  async function runCheckWithTimeout(): Promise<Record<string, unknown>> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(READINESS_CHECK_TIMEOUT_ERROR), { code: READINESS_CHECK_TIMEOUT_ERROR })), timeoutMs);
    });
    try {
      return await Promise.race([options.check(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function evaluate(): Promise<ReadinessVerdict> {
    checks += 1;
    try {
      const body = await runCheckWithTimeout();
      const checkedAt = now();
      if (consecutiveTransientFailures > 0) options.onEvent?.({ kind: "recovered", reason: `after_${consecutiveTransientFailures}_transient_failures` });
      consecutiveTransientFailures = 0;
      lastSuccessAt = checkedAt;
      lastSuccessBody = { ...body };
      return { ok: true, body: { ...body }, status: 200, degraded: false, checked_at: checkedAt };
    } catch (error) {
      const checkedAt = now();
      const kind = classifyReadinessError(error);
      const reason = String((error as any)?.code || (error as any)?.message || "readiness_check_failed").slice(0, 160);
      if (kind === "transient") {
        consecutiveTransientFailures += 1;
        const withinGrace = lastSuccessAt !== null && lastSuccessBody !== null && checkedAt - lastSuccessAt <= graceMs;
        if (withinGrace) {
          options.onEvent?.({ kind: "degraded", reason });
          return {
            ok: true,
            status: 200,
            degraded: true,
            checked_at: checkedAt,
            body: {
              ...lastSuccessBody,
              database: "degraded",
              degraded: true,
              degraded_reason: reason,
              last_verified_at: new Date(lastSuccessAt as number).toISOString(),
              grace_remaining_ms: Math.max(0, graceMs - (checkedAt - (lastSuccessAt as number)))
            }
          };
        }
        options.onEvent?.({ kind: "transient", reason });
      } else {
        options.onEvent?.({ kind: "fatal", reason });
      }
      return { ok: false, status: 503, kind, reason, body: { ok: false, code: "not_ready" }, checked_at: checkedAt };
    }
  }

  return {
    /** Returns the cached verdict inside the TTL, otherwise runs ONE shared check. */
    async probe(): Promise<ReadinessVerdict & { cached: boolean; age_ms: number }> {
      const at = now();
      if (cached && ttlMs > 0 && at - cached.checked_at < ttlMs) {
        return { ...cached, cached: true, age_ms: at - cached.checked_at };
      }
      if (!inflight) {
        inflight = evaluate().then((verdict) => {
          cached = verdict;
          return verdict;
        }).finally(() => { inflight = null; });
      }
      const verdict = await inflight;
      return { ...verdict, cached: false, age_ms: 0 };
    },
    /** Forgets every verdict and the last success (the pool was closed / replaced). */
    reset() {
      cached = null;
      lastSuccessAt = null;
      lastSuccessBody = null;
      consecutiveTransientFailures = 0;
    },
    state() {
      return {
        checks,
        cached_status: cached ? cached.status : null,
        cached_at: cached ? cached.checked_at : null,
        last_success_at: lastSuccessAt,
        consecutive_transient_failures: consecutiveTransientFailures,
        ttl_ms: ttlMs,
        timeout_ms: timeoutMs,
        grace_ms: graceMs
      };
    }
  };
}

export type ReadinessProbe = ReturnType<typeof createReadinessProbe>;
