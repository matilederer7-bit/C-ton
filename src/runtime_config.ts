import dotenv from "dotenv";

dotenv.config();

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/siton";
export const DB_SCHEMA = process.env.DB_SCHEMA || "siton";
export const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

export const PORT = readNumberEnv("PORT", 3000);
export const HOST = process.env.HOST || "0.0.0.0";
// Per canonical amendment 2026-09-16 §2: the Completion Window is exactly 24
// hours (1440 minutes) and is NOT environment-configurable product policy. In
// any production-like runtime the value is hard-locked and the
// COMPLETION_WINDOW_MINUTES override is ignored; a shortened window is honored
// only in non-production test/dev runtimes (the blackbox/e2e harness sets it).
export const CANONICAL_COMPLETION_WINDOW_MINUTES = 1440;
export function resolveCompletionWindowMinutes(env: NodeJS.ProcessEnv = process.env): number {
  // The window is exactly 24h and is not environment-configurable product
  // policy. The COMPLETION_WINDOW_MINUTES override is honored ONLY in the
  // automated test harness (NODE_ENV==='test'), where the blackbox/e2e suites
  // shorten it; every other runtime — production, staging, or any local/manual
  // deployment — is hard-locked to 1440, so a non-Render deploy cannot alter
  // the buyer recovery window.
  if (String(env.NODE_ENV || "") !== "test" || isProductionLikeEnv(env)) return CANONICAL_COMPLETION_WINDOW_MINUTES;
  const raw = env.COMPLETION_WINDOW_MINUTES;
  if (raw === undefined || raw === "") return CANONICAL_COMPLETION_WINDOW_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : CANONICAL_COMPLETION_WINDOW_MINUTES;
}
export const COMPLETION_WINDOW_MINUTES = resolveCompletionWindowMinutes();
export const OUTBOX_POLL_MS = readNumberEnv("OUTBOX_POLL_MS", 1000);
export const OUTBOX_MAX_ATTEMPTS = readNumberEnv("OUTBOX_MAX_ATTEMPTS", 4);

export const MOCK_SEED = process.env.MOCK_SEED ? Number(process.env.MOCK_SEED) : null;

export const DEBUG_SQL_LOGGING = process.env.DEBUG_SQL_LOGGING === "1";
export const DEBUG_SURFACES_ENABLED = process.env.DEBUG_SURFACES_ENABLED === "1";
export const DEBUG_SURFACES_ACCESS_KEY = process.env.DEBUG_SURFACES_ACCESS_KEY || "";
export const DEBUG_SURFACES_ACTIVE = DEBUG_SURFACES_ENABLED && Boolean(DEBUG_SURFACES_ACCESS_KEY.trim());
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
export const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || "mockpay";
export const PAYMENT_PROVIDER_MODE = process.env.PAYMENT_PROVIDER_MODE || "mock-backed";
export const PAYMENT_ENVIRONMENT = process.env.PAYMENT_ENVIRONMENT || "demo";
export const PAYMENT_PROVIDER_BASE_URL = process.env.PAYMENT_PROVIDER_BASE_URL || "";
export const PAYMENT_PROVIDER_API_KEY = process.env.PAYMENT_PROVIDER_API_KEY || "";
export const PAYMENT_PROVIDER_PUBLIC_KEY = process.env.PAYMENT_PROVIDER_PUBLIC_KEY || "";
export const PAYMENT_PROVIDER_AUTH_PATH = process.env.PAYMENT_PROVIDER_AUTH_PATH || "/authorize";
export const PAYMENT_PROVIDER_CAPTURE_PATH = process.env.PAYMENT_PROVIDER_CAPTURE_PATH || "/capture";
export const PAYMENT_PROVIDER_RECOVERY_PATH = process.env.PAYMENT_PROVIDER_RECOVERY_PATH || "/recover";
export const PAYMENT_PROVIDER_REFUND_PATH = process.env.PAYMENT_PROVIDER_REFUND_PATH || "/refund";
export const PAYMENT_PROVIDER_RELEASE_PATH = process.env.PAYMENT_PROVIDER_RELEASE_PATH || "/release";
export const PAYMENT_PROVIDER_STATUS_PATH = process.env.PAYMENT_PROVIDER_STATUS_PATH || "/status";
// LONG_HORIZON_DEALS — merchant-initiated re-authorization from a stored
// payment-method reference (provider-ready HTTP contract). The worker uses it
// at the charging boundary when the join-time authorization is no longer
// usable. An EMPTY value disables the capability for this deployment (the
// worker then lets the provider decide on the original authorization).
export const PAYMENT_PROVIDER_REAUTHORIZE_PATH = process.env.PAYMENT_PROVIDER_REAUTHORIZE_PATH === undefined
  ? "/reauthorize"
  : String(process.env.PAYMENT_PROVIDER_REAUTHORIZE_PATH || "").trim();
export const PAYMENT_PROVIDER_TIMEOUT_MS = readNumberEnv("PAYMENT_PROVIDER_TIMEOUT_MS", 8000);
export const PAYMENT_PROVIDER_CURRENCY = process.env.PAYMENT_PROVIDER_CURRENCY || "ILS";
// Independent financial review — provider-specific SETTLEMENT HORIZON for the
// provider-ready HTTP rail: how long after a capture-side request was
// dispatched the provider may still settle it. Until that instant a failure
// that was only INFERRED from status reads fences automatic recovery, release
// and the terminal deal decision (migration 068). The default is deliberately
// conservative (24 h): an owner sets the real value per provider contract; it
// is never guessed from a provider's expiry behaviour.
export const PAYMENT_SETTLEMENT_HORIZON_MS = readNumberEnv("PAYMENT_SETTLEMENT_HORIZON_MS", 24 * 60 * 60 * 1000);
// Final financial integration (residual A) — whether a NEGATIVE status read of
// the provider-ready HTTP rail proves non-execution of the exact operation.
// "false" forces the rail into the fail-closed policy (no automatic recovery
// from status evidence, ever); anything else keeps the adapter's declared
// contract value. Never guessed for Grow (Grow is fail-closed by construction).
export const PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE = String(process.env.PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE || "").trim().toLowerCase() !== "false";
export const GROW_USER_ID = process.env.GROW_USER_ID || "";
export const GROW_PAGE_CODE = process.env.GROW_PAGE_CODE || "";
export const GROW_API_KEY = process.env.GROW_API_KEY || "";
export const GROW_REFERENCE_ENCRYPTION_KEY = process.env.GROW_REFERENCE_ENCRYPTION_KEY || "";
export const GROW_SUCCESS_URL = process.env.GROW_SUCCESS_URL || "";
export const GROW_CANCEL_URL = process.env.GROW_CANCEL_URL || "";
export const GROW_NOTIFY_URL = process.env.GROW_NOTIFY_URL || "";
export const GROW_CREATE_PATH = process.env.GROW_CREATE_PATH || "/createPaymentProcess";
export const GROW_PROCESS_INFO_PATH = process.env.GROW_PROCESS_INFO_PATH || "/getPaymentProcessInfo";
export const GROW_SETTLE_PATH = process.env.GROW_SETTLE_PATH || "/settleSuspendedTransaction";
export const GROW_REFUND_PATH = process.env.GROW_REFUND_PATH || "/refundTransaction";
export const GROW_TRANSACTION_INFO_PATH = process.env.GROW_TRANSACTION_INFO_PATH || "/getTransactionInfo";
export const GROW_APPROVE_PATH = process.env.GROW_APPROVE_PATH || "/approveTransaction";
export const PAYMENT_WEBHOOK_PROVIDER = process.env.PAYMENT_WEBHOOK_PROVIDER || PAYMENT_PROVIDER;
export const STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION =
  process.env.STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION === "1";
export const PAYMENT_AUTH_DECLINE_SUFFIX = process.env.PAYMENT_AUTH_DECLINE_SUFFIX || "0000";
export const PAYOUT_PROVIDER = process.env.PAYOUT_PROVIDER || "internal-ledger";
export const PAYOUT_PROVIDER_MODE = process.env.PAYOUT_PROVIDER_MODE || "internal-truth-only";
export const PAYOUT_PROVIDER_BASE_URL = process.env.PAYOUT_PROVIDER_BASE_URL || "";
export const PAYOUT_PROVIDER_API_KEY = process.env.PAYOUT_PROVIDER_API_KEY || "";
export const PAYOUT_PROVIDER_DISPATCH_PATH = process.env.PAYOUT_PROVIDER_DISPATCH_PATH || "/payouts/dispatch";
export const PAYOUT_PROVIDER_RECONCILE_PATH = process.env.PAYOUT_PROVIDER_RECONCILE_PATH || "/payouts/reconcile";
export const PAYOUT_PROVIDER_TIMEOUT_MS = readNumberEnv("PAYOUT_PROVIDER_TIMEOUT_MS", 8000);
export const SITON_PLATFORM_FEE_VAT_RATE = readNumberEnv("SITON_PLATFORM_FEE_VAT_RATE", 0.18);
export const NOTIFICATION_PROVIDER = process.env.NOTIFICATION_PROVIDER || "log-only";
export const NOTIFICATION_MAX_ATTEMPTS = readNumberEnv("NOTIFICATION_MAX_ATTEMPTS", 3);
export const APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
export const IS_DEMO_PREVIEW = APP_DEPLOYMENT_MODE === "demo-preview";
export const SELLER_AUTH_MODE = IS_DEMO_PREVIEW ? "demo-context" : "server-session";
export const SELLER_SESSION_SECRET = String(process.env.SELLER_SESSION_SECRET || "").trim();
export const SELLER_AUTH_CONFIGURED = IS_DEMO_PREVIEW
  ? true
  : Boolean(SELLER_SESSION_SECRET);
export const DEMO_PAYMENT_WEBHOOK_SECRET = "mock-webhook-secret";
const RAW_PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "";
export const PAYMENT_WEBHOOK_SECRET =
  RAW_PAYMENT_WEBHOOK_SECRET || (IS_DEMO_PREVIEW ? DEMO_PAYMENT_WEBHOOK_SECRET : "");
export const PAYMENT_WEBHOOK_SECRET_IS_DEFAULT =
  !RAW_PAYMENT_WEBHOOK_SECRET || RAW_PAYMENT_WEBHOOK_SECRET === DEMO_PAYMENT_WEBHOOK_SECRET;
export const PAYMENT_WEBHOOK_SECRET_IS_SAFE = IS_DEMO_PREVIEW
  ? true
  : Boolean(RAW_PAYMENT_WEBHOOK_SECRET) && RAW_PAYMENT_WEBHOOK_SECRET !== DEMO_PAYMENT_WEBHOOK_SECRET;

// Admin API key — if set, all /api/admin/* routes require x-admin-key header to match.
// In production-like environments the key is REQUIRED — admin routes fail-closed
// without it. In local dev/test (no NODE_ENV=production, no RENDER) an empty key
// keeps the legacy open-access behaviour to avoid breaking existing tests.
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

export function isProductionLikeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === "production" ||
    env.APP_ENV === "production" ||
    env.RENDER === "true" ||
    Boolean(env.RENDER_EXTERNAL_URL)
  );
}

// Red-team hardening (A2): how many reverse-proxy hops sit in front of the
// app. Fastify's boolean `trustProxy: true` trusted the LEFT-most (caller
// supplied) X-Forwarded-For value, so anyone rotating that header defeated every
// IP-keyed limiter (global / sensitive / read buckets) and the admin login
// throttle. A hop COUNT trusts exactly that many proxies from the socket peer
// inwards: the client address is the one the outermost trusted proxy appended,
// and a value the caller prepends is ignored. Render terminates TLS in ONE proxy
// layer, so the default is 1; a deployment behind an additional CDN/WAF sets
// TRUST_PROXY_HOPS to its real depth, and 0 means "no proxy, use the socket".
export const DEFAULT_TRUST_PROXY_HOPS = 1;
export const MAX_TRUST_PROXY_HOPS = 8;
export function parseTrustProxyHops(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const hops = Number(text);
  return hops >= 0 && hops <= MAX_TRUST_PROXY_HOPS ? hops : null;
}
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_TRUST_PROXY_HOPS;
  const hops = parseTrustProxyHops(raw);
  return hops === null ? DEFAULT_TRUST_PROXY_HOPS : hops;
}

export const IS_PRODUCTION_LIKE = isProductionLikeEnv();

// ---------------------------------------------------------------------------
// Outbox retry policy (per retry class) and worker resilience knobs.
// ---------------------------------------------------------------------------

export type OutboxRetryClassName = "money" | "reconcile" | "invoice" | "default";
export type OutboxRetryPolicy = {
  baseMs: number;
  capMs: number;
  maxAttempts: number;
  /** Symmetric jitter: the computed delay is scaled by a random factor in [1-ratio, 1+ratio]. */
  jitterRatio: number;
};
export type OutboxRetryPolicyConfig = {
  mode: "lane" | "legacy";
  /**
   * Lane mode raises a claimed row's max_attempts up to its class budget (the
   * column default is 4); legacy mode keeps LEAST(row.max_attempts, global).
   */
  raiseRowMaxAttempts: boolean;
  policies: Record<OutboxRetryClassName, OutboxRetryPolicy>;
};

// Production/staging budget. Money/reconcile/invoice (and payout) events must
// survive a multi-minute provider incident: 30s base, 15 min cap, 8 attempts
// (~30+60+120+240+480+900+900 s ≈ 45 min before the DLQ), +/-30% jitter so a
// burst of events failed by the same blip does not retry in lockstep. Other
// events keep a modest budget (5s base, 5 min cap, 6 attempts ≈ 2.5 min).
// The DB CHECK keeps max_attempts in 1..50.
export const OUTBOX_LANE_RETRY_DEFAULTS: Readonly<Record<OutboxRetryClassName, OutboxRetryPolicy>> = Object.freeze({
  money: { baseMs: 30_000, capMs: 15 * 60_000, maxAttempts: 8, jitterRatio: 0.3 },
  reconcile: { baseMs: 30_000, capMs: 15 * 60_000, maxAttempts: 8, jitterRatio: 0.3 },
  invoice: { baseMs: 30_000, capMs: 15 * 60_000, maxAttempts: 8, jitterRatio: 0.3 },
  default: { baseMs: 5_000, capMs: 5 * 60_000, maxAttempts: 6, jitterRatio: 0.3 }
});

function readBoundedNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number, integer = false) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const value = integer ? Math.floor(parsed) : parsed;
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve the outbox retry policy.
 *
 * - "lane" (production, staging and every non-test runtime): per-class
 *   defaults above; the legacy global OUTBOX_MAX_ATTEMPTS is ignored so a
 *   stale env var cannot silently restore the ~10 s budget.
 * - "legacy" (automated tests only: NODE_ENV=test and not production-like):
 *   the historical policy every existing suite was written against — base =
 *   OUTBOX_POLL_MS, cap 15 min, max = OUTBOX_MAX_ATTEMPTS (default 4), no
 *   jitter, deterministic.
 * OUTBOX_RETRY_POLICY=lane|legacy forces a mode. Per-class overrides
 * OUTBOX_RETRY_<CLASS>_BASE_MS / _CAP_MS / _MAX_ATTEMPTS and the global
 * OUTBOX_RETRY_JITTER_RATIO apply in both modes.
 */
export function resolveOutboxRetryPolicyConfig(env: NodeJS.ProcessEnv = process.env): OutboxRetryPolicyConfig {
  const forced = String(env.OUTBOX_RETRY_POLICY || "").trim().toLowerCase();
  const testRuntime = String(env.NODE_ENV || "") === "test" && !isProductionLikeEnv(env);
  const mode: "lane" | "legacy" = forced === "lane" || forced === "legacy"
    ? forced
    : testRuntime ? "legacy" : "lane";
  const legacyBase = readBoundedNumber(env, "OUTBOX_POLL_MS", 1000, 1, 60 * 60_000);
  const legacyMax = readBoundedNumber(env, "OUTBOX_MAX_ATTEMPTS", 4, 1, 50, true);
  const jitterOverride = env.OUTBOX_RETRY_JITTER_RATIO;
  const policies = {} as Record<OutboxRetryClassName, OutboxRetryPolicy>;
  for (const name of ["money", "reconcile", "invoice", "default"] as const) {
    const fallback: OutboxRetryPolicy = mode === "lane"
      ? { ...OUTBOX_LANE_RETRY_DEFAULTS[name] }
      : { baseMs: legacyBase, capMs: 15 * 60_000, maxAttempts: legacyMax, jitterRatio: 0 };
    const prefix = `OUTBOX_RETRY_${name.toUpperCase()}`;
    const baseMs = readBoundedNumber(env, `${prefix}_BASE_MS`, fallback.baseMs, 1, 60 * 60_000, true);
    const capMs = Math.max(baseMs, readBoundedNumber(env, `${prefix}_CAP_MS`, fallback.capMs, 1, 6 * 60 * 60_000, true));
    const maxAttempts = readBoundedNumber(env, `${prefix}_MAX_ATTEMPTS`, fallback.maxAttempts, 1, 50, true);
    const jitterRatio = jitterOverride === undefined || String(jitterOverride).trim() === ""
      ? fallback.jitterRatio
      : readBoundedNumber(env, "OUTBOX_RETRY_JITTER_RATIO", fallback.jitterRatio, 0, 1);
    policies[name] = { baseMs, capMs, maxAttempts, jitterRatio };
  }
  return { mode, raiseRowMaxAttempts: mode === "lane", policies };
}

/** Delay before an event of an unknown type (rolling deploy) is retried. */
export function resolveUnknownOutboxEventDeferMs(env: NodeJS.ProcessEnv = process.env) {
  return readBoundedNumber(env, "OUTBOX_UNKNOWN_EVENT_DEFER_MS", 5 * 60_000, 1_000, 60 * 60_000, true);
}

/**
 * Per-job deadline. After it the worker stops WAITING for the handler (the
 * job is neither acked sent nor failed; its lease stops being renewed and
 * lease-expiry reclaim + generation fencing take over).
 */
export function resolveWorkerEventTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  return readBoundedNumber(env, "WORKER_EVENT_TIMEOUT_MS", 120_000, 100, 60 * 60_000, true);
}

export type WorkerResilienceConfig = {
  eventTimeoutMs: number;
  alertOldestPendingMs: number;
  alertWindowMs: number;
  alertConsecutiveCycleFailures: number;
  cycleBackoffCapMs: number;
  watchdogStallMs: number;
  watchdogMaxHeartbeatFailures: number;
  watchdogIntervalMs: number;
};

export function resolveWorkerResilienceConfig(pollMs: number, env: NodeJS.ProcessEnv = process.env): WorkerResilienceConfig {
  const eventTimeoutMs = resolveWorkerEventTimeoutMs(env);
  const poll = Math.max(1, Math.floor(Number(pollMs) || 1000));
  const defaultStall = Math.max(5 * 60_000, 10 * poll, 2 * eventTimeoutMs);
  return {
    eventTimeoutMs,
    alertOldestPendingMs: readBoundedNumber(env, "WORKER_ALERT_OLDEST_PENDING_MS", 10 * 60_000, 1_000, 24 * 60 * 60_000, true),
    alertWindowMs: readBoundedNumber(env, "WORKER_ALERT_WINDOW_MS", 5 * 60_000, 1_000, 24 * 60 * 60_000, true),
    alertConsecutiveCycleFailures: readBoundedNumber(env, "WORKER_ALERT_CYCLE_FAILURES", 3, 1, 1_000, true),
    cycleBackoffCapMs: Math.max(poll, readBoundedNumber(env, "WORKER_CYCLE_BACKOFF_CAP_MS", 60_000, 1, 60 * 60_000, true)),
    watchdogStallMs: readBoundedNumber(env, "WORKER_WATCHDOG_STALL_MS", defaultStall, 1_000, 24 * 60 * 60_000, true),
    watchdogMaxHeartbeatFailures: readBoundedNumber(env, "WORKER_WATCHDOG_MAX_HEARTBEAT_FAILURES", 5, 1, 1_000, true),
    watchdogIntervalMs: readBoundedNumber(env, "WORKER_WATCHDOG_INTERVAL_MS", 10_000, 100, 10 * 60_000, true)
  };
}
