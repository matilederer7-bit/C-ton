// Error monitoring (Sentry) for the web service, the outbox worker and
// browser reports relayed through the web service.
//
// Dependency-free on purpose. The official SDK auto-instruments pg, http and
// Fastify, records console breadcrumbs and attaches request data; each of
// those is a channel through which a phone number, an OTP, a cookie or a
// money payload could reach a third party. This client instead builds every
// event from an ALLOWLIST: exception type, a scrubbed message, parsed stack
// frames and a fixed set of correlation tags whose values must pass a strict
// character policy. Request bodies, headers, cookies, query strings, user
// identity and IP addresses are never read, so they cannot be sent.
//
// Disabled (every call is a no-op) unless SENTRY_DSN is set. The DSN lives
// only in the hosting environment, never in the repository.
//
// Proof: tests/error_monitoring_security_validation.ts.
import { randomUUID } from "node:crypto";

export type MonitoringService = "web" | "worker" | "browser";
export type MonitoringLevel = "fatal" | "error" | "warning";

export type MonitoringContext = {
  service?: MonitoringService;
  level?: MonitoringLevel;
  mechanism?: string;
  handled?: boolean;
  tags?: Record<string, unknown>;
};

export type MonitoringEnvelope = { url: string; headers: Record<string, string>; body: string };
export type MonitoringTransport = (envelope: MonitoringEnvelope) => Promise<void>;

type Dsn = { envelopeUrl: string; publicKey: string };

type MonitoringState = {
  dsn: Dsn;
  environment: string;
  release: string;
  service: MonitoringService;
  transport: MonitoringTransport;
  maxEventsPerWindow: number;
  maxBrowserEventsPerWindow: number;
  windowMs: number;
};

const CLIENT_NAME = "siton-error-monitoring/1.0";
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_FRAMES = 50;
const DEDUPE_WINDOW_MS = 60_000;

// Correlation tags that may leave the process. Anything else is dropped.
const ALLOWED_TAGS = new Set([
  "service",
  "route",
  "method",
  "status_code",
  "request_id",
  "worker_id",
  "error_code",
  "client_source",
  "client_route",
  "client_release",
  "self_test"
]);
const TAG_VALUE = /^[A-Za-z0-9_.:/\-]{1,200}$/;

let state: MonitoringState | null = null;
// Server and browser events have separate budgets. The browser relay is
// anonymous and its per-IP limit keys on a client-controllable address
// (trustProxy), so a flood of fake browser reports must not be able to
// exhaust the budget that real server errors depend on.
let windowStartedAt = 0;
const sentInWindow = { server: 0, browser: 0 };
const recentFingerprints = new Map<string, number>();
const pending = new Set<Promise<void>>();

export function parseDsn(raw: unknown): Dsn | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
    if (url.protocol !== "https:" || !url.username || !/^\d+$/.test(projectId)) return null;
    return { envelopeUrl: `https://${url.host}/api/${projectId}/envelope/`, publicKey: decodeURIComponent(url.username) };
  } catch {
    return null;
  }
}

const defaultTransport: MonitoringTransport = async (envelope) => {
  await fetch(envelope.url, {
    method: "POST",
    headers: envelope.headers,
    body: envelope.body,
    signal: AbortSignal.timeout(5_000)
  });
};

/**
 * Configure monitoring. Returns true when events will be sent. A missing or
 * malformed DSN leaves monitoring disabled; startup never fails because of it.
 */
export function initErrorMonitoring(options: {
  service: MonitoringService;
  dsn?: string;
  environment?: string;
  release?: string;
  transport?: MonitoringTransport;
  maxEventsPerWindow?: number;
  maxBrowserEventsPerWindow?: number;
  windowMs?: number;
}): boolean {
  const dsn = parseDsn(options.dsn ?? process.env.SENTRY_DSN);
  if (!dsn) {
    state = null;
    return false;
  }
  state = {
    dsn,
    environment: cleanTagValue(options.environment ?? process.env.SENTRY_ENVIRONMENT) || "unspecified",
    release: cleanTagValue(options.release ?? (process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA)) || "unknown",
    service: options.service,
    transport: options.transport ?? defaultTransport,
    maxEventsPerWindow: Math.max(1, options.maxEventsPerWindow ?? 30),
    maxBrowserEventsPerWindow: Math.max(1, options.maxBrowserEventsPerWindow ?? 10),
    windowMs: Math.max(1_000, options.windowMs ?? 60_000)
  };
  windowStartedAt = 0;
  sentInWindow.server = 0;
  sentInWindow.browser = 0;
  recentFingerprints.clear();
  return true;
}

export function isErrorMonitoringEnabled(): boolean {
  return state !== null;
}

/** Non-secret summary for startup logs. Never includes the DSN. */
export function errorMonitoringSummary() {
  return state
    ? { enabled: true, environment: state.environment, release: state.release, service: state.service }
    : { enabled: false };
}

// ── Scrubbing ───────────────────────────────────────────────────────────────

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const SCRUB_RULES: Array<[RegExp, string]> = [
  // JSON Web Tokens (Supabase access tokens, session tokens).
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted:jwt]"],
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  // key=value / key: value where the key names a credential.
  [/\b([A-Za-z_-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|cvv|cvc|otp)[A-Za-z_-]*)(\s*[:=]\s*)(["']?)[^\s"'&,;)]+/gi, "$1$2$3[redacted]"],
  // Query strings anywhere in the text (tracking/OTP tokens travel in them).
  [/\?[^\s"'#]*=[^\s"'#]*/g, "?[redacted-query]"],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted:email]"],
  // IPv4 addresses.
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[redacted:ip]"],
  // Phone numbers, card numbers, bank accounts, national ids: any run of nine
  // or more digits, optionally separated by spaces or dashes, with or without
  // a leading +.
  [/\+?\b\d(?:[\s-]?\d){8,}\b/g, "[redacted:number]"],
  // Long opaque credentials (API keys, hashes used as secrets).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "[redacted:token]"]
];

/**
 * Remove personal data and credentials from free text. UUIDs (deal,
 * participant and request ids) are kept: they are opaque and are the
 * correlation keys an investigator needs.
 */
export function scrubText(input: unknown, maxLength = MAX_MESSAGE_LENGTH): string {
  let text = String(input ?? "");
  if (text.length > maxLength * 4) text = text.slice(0, maxLength * 4);
  const uuids: string[] = [];
  text = text.replace(UUID, (match) => `\u0000${uuids.push(match) - 1}\u0000`);
  for (const [pattern, replacement] of SCRUB_RULES) text = text.replace(pattern, replacement);
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index) => uuids[Number(index)] ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// At least one hex letter, so a digits-only phone or card number never
// passes as a SHA.
const GIT_SHA = /^(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/i;

function cleanTagValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  // A commit SHA is the release identifier, not a credential.
  if (GIT_SHA.test(text)) return text;
  if (!TAG_VALUE.test(text)) return "";
  // A value that scrubbing would change carries something it must not.
  return scrubText(text, 200) === text ? text : "";
}

export function sanitizeTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags) return out;
  for (const [key, value] of Object.entries(tags)) {
    if (!ALLOWED_TAGS.has(key)) continue;
    const clean = cleanTagValue(value);
    if (clean) out[key] = clean;
  }
  return out;
}

/**
 * Collapse a client-side route to its shape. Segments that could be an id or
 * a token (digits, long, or unusual characters) become `:param`, so a
 * tracking link such as `#/track/<token>` is reported as `/track/:param`.
 */
export function normalizeClientRoute(raw: unknown): string {
  const text = String(raw ?? "").replace(/^#/, "").split(/[?#]/)[0] || "/";
  const segments = text.split("/").slice(0, 8).map((segment) => {
    if (!segment) return segment;
    return /^[a-z][a-z-]{0,23}$/.test(segment) ? segment : ":param";
  });
  const joined = segments.join("/");
  return (joined.startsWith("/") ? joined : `/${joined}`).slice(0, 200);
}

// ── Stack parsing ───────────────────────────────────────────────────────────

type Frame = { filename: string; function: string; lineno?: number | undefined; colno?: number | undefined; in_app: boolean };

function cleanFilename(raw: string): string {
  let file = raw.trim();
  file = file.replace(/^file:\/\//, "");
  file = file.replace(/^https?:\/\/[^/]+/, "");
  file = file.replace(/[?#].*$/, "");
  const appRoot = process.cwd();
  if (appRoot && appRoot !== "/" && file.startsWith(appRoot + "/")) file = file.slice(appRoot.length + 1);
  // Relayed browser stacks are caller-controlled text: a path segment can
  // carry an email or a token just like the message can.
  return scrubText(file, 300);
}

function frameFromParts(fn: string, location: string): Frame | null {
  const match = location.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const filename = cleanFilename(match ? match[1] ?? "" : location);
  if (!filename) return null;
  const functionName = fn.replace(/^async\s+/, "").trim().slice(0, 200) || "<anonymous>";
  return {
    filename,
    function: /^[\w$.<>\[\] /-]+$/.test(functionName) ? functionName : "<anonymous>",
    lineno: match ? Number(match[2]) : undefined,
    colno: match && match[3] ? Number(match[3]) : undefined,
    in_app: !filename.includes("node_modules") && !filename.startsWith("node:") && !filename.startsWith("internal/")
  };
}

/** Parse V8 (`at fn (file:1:2)`) and Firefox/Safari (`fn@file:1:2`) stacks. */
export function parseStack(stack: unknown): Frame[] {
  const frames: Frame[] = [];
  for (const line of String(stack ?? "").split("\n").slice(0, 200)) {
    const v8 = line.match(/^\s*at (?:(.+?) \((.+)\)|(.+))$/);
    const gecko = v8 ? null : line.match(/^\s*([^@\s]*)@(.+)$/);
    let frame: Frame | null = null;
    if (v8) frame = v8[2] ? frameFromParts(v8[1] ?? "", v8[2]) : frameFromParts("", v8[3] ?? "");
    else if (gecko) frame = frameFromParts(gecko[1] ?? "", gecko[2] ?? "");
    if (frame) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  // Sentry expects the oldest frame first.
  return frames.reverse();
}

// ── Event construction and sending ──────────────────────────────────────────

function errorParts(error: unknown): { type: string; message: string; stack: string; code: string } {
  if (error instanceof Error) {
    const anyError = error as any;
    return {
      type: error.name || "Error",
      message: error.message,
      stack: String(error.stack || ""),
      code: String(anyError.productCode || anyError.code || "")
    };
  }
  if (error && typeof error === "object") {
    const anyError = error as any;
    return {
      type: String(anyError.type || anyError.name || "NonErrorRejection"),
      message: String(anyError.message ?? "non-error value"),
      stack: String(anyError.stack || ""),
      code: String(anyError.code || "")
    };
  }
  return { type: "NonErrorRejection", message: String(error), stack: "", code: "" };
}

/** Build the exact JSON event that would be sent. Exported for tests. */
export function buildEvent(error: unknown, context: MonitoringContext = {}) {
  const parts = errorParts(error);
  const service = context.service ?? state?.service ?? "web";
  const tags = sanitizeTags({ ...context.tags, service, error_code: parts.code || undefined });
  const frames = parseStack(parts.stack);
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: service === "browser" ? "javascript" : "node",
    level: context.level ?? "error",
    environment: state?.environment ?? "unspecified",
    release: state?.release ?? "unknown",
    tags,
    contexts: service === "browser" ? {} : { runtime: { name: "node", version: process.version } },
    exception: {
      values: [
        {
          type: scrubText(parts.type, 120).replace(/[^\w.$-]/g, "") || "Error",
          value: scrubText(parts.message),
          ...(frames.length ? { stacktrace: { frames } } : {}),
          mechanism: { type: context.mechanism ?? "generic", handled: context.handled ?? true }
        }
      ]
    }
  };
}

function withinBudget(fingerprint: string, browser: boolean): boolean {
  if (!state) return false;
  const now = Date.now();
  if (now - windowStartedAt >= state.windowMs) {
    windowStartedAt = now;
    sentInWindow.server = 0;
    sentInWindow.browser = 0;
  }
  for (const [key, seenAt] of recentFingerprints) if (now - seenAt >= DEDUPE_WINDOW_MS) recentFingerprints.delete(key);
  if (recentFingerprints.has(fingerprint)) return false;
  const bucket = browser ? "browser" : "server";
  if (sentInWindow[bucket] >= (browser ? state.maxBrowserEventsPerWindow : state.maxEventsPerWindow)) return false;
  sentInWindow[bucket] += 1;
  recentFingerprints.set(fingerprint, now);
  return true;
}

/**
 * Report an error. Never throws and never blocks the caller: the send runs in
 * the background and is tracked for flushMonitoring(). Returns the event id
 * when an event was queued.
 */
export function captureException(error: unknown, context: MonitoringContext = {}): string | null {
  const current = state;
  if (!current) return null;
  try {
    const event = buildEvent(error, context);
    const top = event.exception.values[0];
    const topFrame = top?.stacktrace?.frames.at(-1);
    const fingerprint = [event.tags.service, top?.type, top?.value, topFrame?.filename, topFrame?.lineno].join("|");
    if (!withinBudget(fingerprint, event.tags.service === "browser")) return null;
    const body = [
      JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event)
    ].join("\n") + "\n";
    const envelope: MonitoringEnvelope = {
      url: current.dsn.envelopeUrl,
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=${CLIENT_NAME}, sentry_key=${current.dsn.publicKey}`
      },
      body
    };
    const sending = current.transport(envelope).catch(() => undefined);
    pending.add(sending);
    void sending.finally(() => pending.delete(sending));
    return event.event_id;
  } catch {
    return null;
  }
}

/** Wait (bounded) for queued events to be delivered. */
export async function flushMonitoring(timeoutMs = 2_000): Promise<void> {
  if (!pending.size) return;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs).unref())
  ]);
}

let processCaptureInstalled = false;

/**
 * Report uncaught exceptions and unhandled promise rejections, then exit with
 * code 1 exactly as Node would without a handler. Installed only while
 * monitoring is enabled, so a process without a DSN keeps Node's defaults.
 */
export function installProcessErrorCapture(logFatal: (error: unknown, kind: string) => void): boolean {
  if (!state || processCaptureInstalled) return false;
  processCaptureInstalled = true;
  let exiting = false;
  const handle = (kind: "uncaughtException" | "unhandledRejection") => (error: unknown) => {
    if (exiting) {
      process.exit(1);
      return;
    }
    exiting = true;
    try { logFatal(error, kind); } catch { /* logging must not prevent the exit */ }
    captureException(error, {
      level: "fatal",
      handled: false,
      mechanism: kind === "uncaughtException" ? "onuncaughtexception" : "onunhandledrejection"
    });
    void flushMonitoring(2_000).finally(() => process.exit(1));
  };
  process.on("uncaughtException", handle("uncaughtException"));
  process.on("unhandledRejection", handle("unhandledRejection"));
  return true;
}

export type BrowserErrorReport = { source: "web" | "legacy"; message: string; type?: string; stack?: string; route?: string; release?: string };

/** Relay a validated browser report. The route is reduced to its shape. */
export function captureBrowserReport(report: BrowserErrorReport, requestId: unknown): string | null {
  return captureException(
    { name: report.type || "BrowserError", message: report.message, stack: report.stack || "" },
    {
      service: "browser",
      mechanism: "browser_global_handler",
      handled: false,
      tags: {
        client_source: report.source,
        client_route: normalizeClientRoute(report.route),
        client_release: report.release,
        request_id: requestId
      }
    }
  );
}

export class MonitoringSelfTestError extends Error {
  constructor(service: MonitoringService) {
    super(`Siton error-monitoring self-test from ${service} (synthetic; no user, database or money effect)`);
    this.name = "MonitoringSelfTestError";
  }
}

/**
 * Controlled test event, sent only when SENTRY_SELF_TEST=1. It is created and
 * reported here and never thrown, so no request, job or transaction sees it.
 */
export function captureSelfTestIfRequested(service: MonitoringService): string | null {
  if (process.env.SENTRY_SELF_TEST !== "1") return null;
  return captureException(new MonitoringSelfTestError(service), {
    service,
    level: "warning",
    mechanism: "self_test",
    tags: { self_test: "true" }
  });
}

/** Test seam: forget configuration and counters. */
export function resetErrorMonitoringForTests() {
  state = null;
  windowStartedAt = 0;
  sentInWindow.server = 0;
  sentInWindow.browser = 0;
  recentFingerprints.clear();
  pending.clear();
}
