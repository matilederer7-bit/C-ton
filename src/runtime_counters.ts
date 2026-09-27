// In-process monotonic counters for security and reliability signals
// (Black-Sky F-M6, F-L2).
//
// Counters are per process (single_instance_only, like the request limiter):
// they reset on restart and each web / worker instance has its own. They are
// signals for the operator surface and alerting, not business truth; the
// durable truth stays in the audit / security-event tables.
//
// Names are a closed set so a caller-controlled string can never create an
// unbounded number of keys.

export const RUNTIME_COUNTER_NAMES = [
  // HTTP responses by class (every route, including limiter refusals).
  "http_401_total",
  "http_403_total",
  "http_429_total",
  // Admin authentication.
  "admin_login_failed_total",
  "admin_login_locked_total",
  "admin_mfa_failed_total",
  // Payment webhooks refused before ingestion (any security reason), and the
  // signature-verification subset of them.
  "webhook_rejected_total",
  "webhook_signature_failed_total",
  "invoice_webhook_signature_failed_total",
  // Outbox worker errors that used to be swallowed silently (F-L2).
  "outbox_reclaim_row_failed_total",
  "outbox_reclaim_lease_lost_total",
  "outbox_quarantine_failed_total"
] as const;

export type RuntimeCounterName = (typeof RUNTIME_COUNTER_NAMES)[number];

const values = new Map<RuntimeCounterName, number>(RUNTIME_COUNTER_NAMES.map((name) => [name, 0]));
const startedAt = new Date().toISOString();

export function incrementRuntimeCounter(name: RuntimeCounterName, by = 1) {
  if (!values.has(name)) return;
  values.set(name, (values.get(name) || 0) + (Number.isFinite(by) && by > 0 ? Math.floor(by) : 1));
}

export function runtimeCounterValue(name: RuntimeCounterName) {
  return values.get(name) || 0;
}

export function runtimeCountersSnapshot() {
  return {
    scope: "process" as const,
    since: startedAt,
    counters: Object.fromEntries(RUNTIME_COUNTER_NAMES.map((name) => [name, values.get(name) || 0])) as Record<RuntimeCounterName, number>
  };
}

/** Maps a final HTTP status to its counter (401 / 403 / 429 only). */
export function countHttpStatus(statusCode: number) {
  if (statusCode === 401) incrementRuntimeCounter("http_401_total");
  else if (statusCode === 403) incrementRuntimeCounter("http_403_total");
  else if (statusCode === 429) incrementRuntimeCounter("http_429_total");
}
