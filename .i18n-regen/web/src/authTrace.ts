// ── Auth observability (P0.4-1) ─────────────────────────────────────────────
// A staging-safe diagnostic trail for the login flow so the next owner report
// needs zero guessing. STRICTLY no secrets: no passwords, no refresh tokens,
// no JWT contents — only phase names, coarse details, timestamps and a
// per-attempt correlation id. Stored in sessionStorage (dies with the tab)
// and mirrored to the console; readable via window.__sitonAuthTrace().

const TRACE_KEY = "siton_auth_trace_v1";
const MAX_ENTRIES = 120;

export type AuthPhase =
  | "AUTH_PASSWORD_REQUEST"
  | "AUTH_PASSWORD_SUCCESS"
  | "AUTH_PASSWORD_FAILURE"
  | "AUTH_SESSION_STORED"
  | "AUTH_GUEST_MODE_CLEARED"
  | "AUTH_VERIFY_SURFACE"
  | "AUTH_CAPABILITIES_REQUEST"
  | "AUTH_CAPABILITIES_SUCCESS"
  | "AUTH_CAPABILITIES_RETRY"
  | "AUTH_CAPABILITIES_UNAUTHORIZED"
  | "AUTH_CAPABILITIES_UNAVAILABLE"
  | "AUTH_SURFACE_GRANTED"
  | "AUTH_NAVIGATION_COMPLETE"
  | "AUTH_FLOW_ERROR";

interface TraceEntry { t: string; cid: string; phase: AuthPhase; detail?: string }

let currentCid = "";

function readTrail(): TraceEntry[] {
  try { return JSON.parse(sessionStorage.getItem(TRACE_KEY) || "[]"); } catch { return []; }
}

function writeTrail(entries: TraceEntry[]): void {
  try { sessionStorage.setItem(TRACE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))); } catch { /* noop */ }
}

// One correlation id per explicit login attempt.
export function beginAuthAttempt(): string {
  const bytes = new Uint8Array(6);
  try { crypto.getRandomValues(bytes); } catch { /* noop */ }
  currentCid = `a_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return currentCid;
}

export function traceAuth(phase: AuthPhase, detail?: string): void {
  const entry: TraceEntry = { t: new Date().toISOString(), cid: currentCid || "boot", phase, ...(detail ? { detail: detail.slice(0, 120) } : {}) };
  const trail = readTrail();
  trail.push(entry);
  writeTrail(trail);
  try { console.info(`[auth] ${entry.cid} ${phase}${detail ? ` — ${entry.detail}` : ""}`); } catch { /* noop */ }
}

declare global { interface Window { __sitonAuthTrace?: () => TraceEntry[] } }
try { window.__sitonAuthTrace = () => readTrail(); } catch { /* noop */ }
