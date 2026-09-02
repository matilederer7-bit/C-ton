// ── P0.6A — explicit-click pickup geolocation strategy ──────────────────────
// Pure, deterministic and dependency-injected so the exact browser flow can be
// proven without a browser (tests/frontend_foundation_geolocation_strategy_validation.ts).
//
// Contract (product rule: location is optional, address text always suffices):
//   * runs ONLY when called from the seller's explicit click — never on load,
//     never watchPosition, never background polling
//   * bounded: at most TWO getCurrentPosition attempts per click, never a loop
//       attempt 1: normal accuracy (network/Wi-Fi provider — the reliable path
//                  on laptops and desktops without GPS), short timeout
//       attempt 2: high accuracy, ONLY after TIMEOUT / POSITION_UNAVAILABLE /
//                  watchdog on attempt 1
//   * PERMISSION_DENIED never retries
//   * distinguishes SITE-level denial (this origin blocked in the browser) from
//     OS-level denial (site granted, but the platform location service or the
//     browser's own OS permission refused — Chrome/Edge report that as
//     PERMISSION_DENIED too, which the previous "unblock the site" guidance
//     could never resolve)
//   * the first callback per attempt wins; late callbacks are traced and
//     ignored; a watchdog guarantees the UI never stays "pending" forever
//   * no DOM types are referenced so the module compiles under both the Vite
//     (bundler/DOM) and the root nodenext (node-only) TypeScript projects.

export type GeoPermissionState = "prompt" | "granted" | "denied" | "unknown";

export interface GeoPositionLike {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
}
export interface GeoErrorLike {
  code?: number;
  message?: string;
}
export interface GeoRequestOptions {
  enableHighAccuracy: boolean;
  timeout: number;
  maximumAge: number;
}
export type GetCurrentPositionLike = (
  onOk: (position: GeoPositionLike) => void,
  onErr: (error: GeoErrorLike) => void,
  options: GeoRequestOptions
) => void;

export interface GeoDeps {
  isSecureContext: boolean;
  /** null = navigator.geolocation missing (API unsupported). */
  getCurrentPosition: GetCurrentPositionLike | null;
  /** null = Permissions API missing; the flow proceeds straight to the request. */
  queryPermission: (() => Promise<GeoPermissionState>) | null;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

export const GEO_PERMISSION_DENIED = 1;
export const GEO_POSITION_UNAVAILABLE = 2;
export const GEO_TIMEOUT = 3;

export interface GeoAttemptPlan {
  n: 1 | 2;
  enableHighAccuracy: boolean;
  timeout: number;
  maximumAge: number;
}

// Attempt 1 first WITHOUT high accuracy: on Windows/macOS laptops the
// high-accuracy path goes through the OS location service and fails or stalls
// when it is off, while the network provider still resolves. Attempt 2 then
// asks for high accuracy (GPS on phones) with a bounded timeout.
export const GEO_ATTEMPT_PLAN: readonly GeoAttemptPlan[] = [
  { n: 1, enableHighAccuracy: false, timeout: 8_000, maximumAge: 30_000 },
  { n: 2, enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
];
export const GEO_MAX_ATTEMPTS = GEO_ATTEMPT_PLAN.length;

// Browsers do not start the `timeout` clock while their permission prompt is
// open, so the watchdog leaves room for the seller to answer the prompt when
// permission is not yet granted; once granted the watchdog is tight.
export const GEO_WATCHDOG_GRACE_MS = 5_000;
export const GEO_PROMPT_GRACE_MS = 60_000;

export type GeoAttemptResult = "success" | "error" | "watchdog";

export interface GeoAttemptRecord {
  n: 1 | 2;
  high_accuracy: boolean;
  timeout_ms: number;
  result: GeoAttemptResult;
  code: number | null;
  message: string;
  elapsed_ms: number;
}

export type GeoOutcomeKind =
  | "success"
  | "insecure_context"
  | "unsupported"
  | "site_denied"
  | "os_denied"
  | "unavailable"
  | "timeout";

export interface GeoOutcome {
  kind: GeoOutcomeKind;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  permission: GeoPermissionState;
  attempts: GeoAttemptRecord[];
  secure: boolean;
  supported: boolean;
}

export interface GeoHooks {
  onAttempt?: (attempt: 1 | 2, highAccuracy: boolean) => void;
  trace?: (event: Record<string, unknown>) => void;
}

export function normalizePermissionState(value: unknown): GeoPermissionState {
  const s = String(value || "").toLowerCase();
  if (s === "granted" || s === "denied" || s === "prompt") return s;
  return "unknown";
}

function validCoordinate(lat: unknown, lng: unknown): boolean {
  const la = Number(lat);
  const ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180;
}

interface AttemptRun {
  record: GeoAttemptRecord;
  position: GeoPositionLike | null;
}

function runAttempt(
  deps: GeoDeps,
  plan: GeoAttemptPlan,
  permission: GeoPermissionState,
  trace: (event: Record<string, unknown>) => void
): Promise<AttemptRun> {
  return new Promise<AttemptRun>((resolve) => {
    const started = deps.now();
    let settled = false;
    let handle: unknown = null;
    const finish = (result: GeoAttemptResult, position: GeoPositionLike | null, code: number | null, message: string) => {
      if (settled) {
        trace({ step: "late_callback_ignored", attempt: plan.n, result, code });
        return;
      }
      settled = true;
      if (handle !== null) deps.clearTimer(handle);
      const record: GeoAttemptRecord = {
        n: plan.n,
        high_accuracy: plan.enableHighAccuracy,
        timeout_ms: plan.timeout,
        result,
        code,
        message: message.slice(0, 200),
        elapsed_ms: Math.max(0, deps.now() - started)
      };
      trace({ step: "attempt_done", ...record });
      resolve({ record, position });
    };
    const grace = permission === "granted" ? GEO_WATCHDOG_GRACE_MS : GEO_PROMPT_GRACE_MS;
    handle = deps.setTimer(() => finish("watchdog", null, null, "no callback from the browser before the watchdog"), plan.timeout + grace);
    trace({ step: "attempt_start", attempt: plan.n, high_accuracy: plan.enableHighAccuracy, timeout_ms: plan.timeout });
    try {
      const request = deps.getCurrentPosition;
      if (!request) {
        finish("error", null, GEO_POSITION_UNAVAILABLE, "geolocation API missing");
        return;
      }
      request(
        (position) => {
          if (!position || !position.coords || !validCoordinate(position.coords.latitude, position.coords.longitude)) {
            finish("error", null, GEO_POSITION_UNAVAILABLE, "browser returned invalid coordinates");
            return;
          }
          finish("success", position, null, "");
        },
        (error) => {
          const code = Number(error?.code);
          finish("error", null, Number.isFinite(code) ? code : null, String(error?.message || ""));
        },
        { enableHighAccuracy: plan.enableHighAccuracy, timeout: plan.timeout, maximumAge: plan.maximumAge }
      );
    } catch (error) {
      finish("error", null, GEO_POSITION_UNAVAILABLE, String((error as any)?.message || error || "getCurrentPosition threw"));
    }
  });
}

async function readPermission(deps: GeoDeps): Promise<GeoPermissionState> {
  if (!deps.queryPermission) return "unknown";
  try {
    return normalizePermissionState(await deps.queryPermission());
  } catch {
    return "unknown";
  }
}

/**
 * The single entry point behind "📍 השתמש במיקום שלי". Resolves exactly once
 * with a fully described outcome; never throws.
 */
export async function requestPickupLocation(deps: GeoDeps, hooks: GeoHooks = {}): Promise<GeoOutcome> {
  const trace = hooks.trace || (() => undefined);
  const base = {
    latitude: null,
    longitude: null,
    accuracy: null,
    attempts: [] as GeoAttemptRecord[],
    secure: Boolean(deps.isSecureContext),
    supported: Boolean(deps.getCurrentPosition)
  };
  if (!deps.isSecureContext) {
    trace({ step: "blocked", reason: "insecure_context" });
    return { ...base, kind: "insecure_context", permission: "unknown" };
  }
  if (!deps.getCurrentPosition) {
    trace({ step: "blocked", reason: "unsupported" });
    return { ...base, kind: "unsupported", permission: "unknown" };
  }

  let permission = await readPermission(deps);
  trace({ step: "permission", permission });
  if (permission === "denied") {
    // The browser will not prompt again; calling the API would only burn a
    // PERMISSION_DENIED. Show the honest unblock guidance instead.
    return { ...base, kind: "site_denied", permission };
  }

  const attempts: GeoAttemptRecord[] = [];
  for (const plan of GEO_ATTEMPT_PLAN) {
    if (hooks.onAttempt) hooks.onAttempt(plan.n, plan.enableHighAccuracy);
    const run = await runAttempt(deps, plan, permission, trace);
    attempts.push(run.record);

    if (run.record.result === "success" && run.position) {
      const accuracy = Number(run.position.coords.accuracy);
      return {
        ...base,
        kind: "success",
        latitude: Number(run.position.coords.latitude),
        longitude: Number(run.position.coords.longitude),
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        permission,
        attempts
      };
    }

    if (run.record.code === GEO_PERMISSION_DENIED) {
      // Never retry a denial. Re-read the permission to tell the two denials
      // apart: site still "granted" ⇒ the OS/platform refused (os_denied);
      // anything else ⇒ this origin is blocked in the browser (site_denied).
      const after = await readPermission(deps);
      permission = after === "unknown" ? permission : after;
      trace({ step: "denied", permission_after: after });
      return { ...base, kind: permission === "granted" ? "os_denied" : "site_denied", permission, attempts };
    }
    // TIMEOUT / POSITION_UNAVAILABLE / watchdog / unknown code → next plan (if any)
  }

  const last = attempts[attempts.length - 1];
  const timedOut = Boolean(last && (last.result === "watchdog" || last.code === GEO_TIMEOUT));
  return { ...base, kind: timedOut ? "timeout" : "unavailable", permission, attempts };
}

// ── browser adapters (kept here so the page code stays declarative) ────────

export function browserGeoDeps(): GeoDeps {
  const g: any = globalThis as any;
  const nav = g.navigator;
  const geo = nav && nav.geolocation;
  const perms = nav && nav.permissions;
  return {
    isSecureContext: Boolean(g.isSecureContext),
    getCurrentPosition: geo && typeof geo.getCurrentPosition === "function"
      ? (ok, err, opts) => geo.getCurrentPosition(ok, err, opts)
      : null,
    queryPermission: perms && typeof perms.query === "function"
      ? async () => {
        const status = await perms.query({ name: "geolocation" });
        return normalizePermissionState(status && status.state);
      }
      : null,
    setTimer: (fn, ms) => g.setTimeout(fn, ms),
    clearTimer: (handle) => g.clearTimeout(handle),
    now: () => Date.now()
  };
}

const GEO_TRACE_LIMIT = 50;

/** Owner-diagnosable trace: window.__sitonGeoTrace (last 50 events) + console. */
export function recordGeoTrace(event: Record<string, unknown>): void {
  const g: any = globalThis as any;
  try {
    const list: unknown[] = Array.isArray(g.__sitonGeoTrace) ? g.__sitonGeoTrace : (g.__sitonGeoTrace = []);
    list.push({ at: new Date().toISOString(), ...event });
    if (list.length > GEO_TRACE_LIMIT) list.splice(0, list.length - GEO_TRACE_LIMIT);
  } catch { /* noop */ }
  try {
    if (g.console && typeof g.console.info === "function") g.console.info("[geo]", JSON.stringify(event));
  } catch { /* noop */ }
}

/** One compact LTR line the owner can copy into a bug report. */
export function geoDiagnosticLine(outcome: GeoOutcome): string {
  const attempts = outcome.attempts.map((a) => `${a.n}:${a.high_accuracy ? "hi" : "lo"}/${a.result}${a.code != null ? `#${a.code}` : ""}/${a.elapsed_ms}ms`).join(" ");
  const lastMessage = [...outcome.attempts].reverse().find((a) => a.message)?.message || "";
  return [
    `kind=${outcome.kind}`,
    `permission=${outcome.permission}`,
    `https=${outcome.secure ? "yes" : "no"}`,
    `api=${outcome.supported ? "yes" : "no"}`,
    `attempts=${outcome.attempts.length}${attempts ? ` [${attempts}]` : ""}`,
    lastMessage ? `msg="${lastMessage.slice(0, 80)}"` : ""
  ].filter(Boolean).join(" · ");
}

export interface GeoOutcomeCopy {
  title: string;
  note: string;
  steps: string[];
  /** true ⇒ a denial: show "בדיקה מחדש"; false ⇒ transient: show "ניסיון נוסף". */
  denial: boolean;
  retryable: boolean;
}

export const GEO_OUTCOME_COPY: Record<Exclude<GeoOutcomeKind, "success">, GeoOutcomeCopy> = {
  site_denied: {
    title: "הגישה למיקום חסומה לאתר הזה בדפדפן.",
    note: "אתר אינו יכול לעקוף חסימה כזו בעצמו.",
    steps: [
      "לחצו על סמל המנעול / ההרשאות ליד כתובת האתר",
      "מיקום ← אפשר",
      "לחצו \"בדיקה מחדש\""
    ],
    denial: true,
    retryable: true
  },
  os_denied: {
    title: "הדפדפן אישר, אבל המכשיר חוסם גישה למיקום.",
    note: "אתר אינו יכול לשנות הגדרות מכשיר — זה נפתר רק בהגדרות המערכת.",
    steps: [
      "Windows: הגדרות ← פרטיות ואבטחה ← מיקום ← הפעילו \"שירותי מיקום\" ואפשרו לדפדפן (או ל\"אפליקציות שולחן עבודה\") גישה למיקום",
      "macOS: הגדרות המערכת ← פרטיות ואבטחה ← שירותי מיקום ← סמנו את הדפדפן",
      "טלפון: הפעילו מיקום במכשיר ואשרו לדפדפן גישה למיקום",
      "לחצו \"בדיקה מחדש\""
    ],
    denial: true,
    retryable: true
  },
  unavailable: {
    title: "לא הצלחנו לקבוע מיקום (ניסינו במצב רגיל ובמצב מדויק).",
    note: "",
    steps: [
      "ייתכן ששירותי המיקום במכשיר כבויים (Windows: הגדרות ← פרטיות ואבטחה ← מיקום)",
      "למחשב ללא Wi‑Fi או GPS לפעמים אין מקור מיקום בכלל",
      "אפשר לנסות שוב, או להזין קואורדינטות ידנית — הכתובת בשדה התיאור מספיקה תמיד"
    ],
    denial: false,
    retryable: true
  },
  timeout: {
    title: "המיקום לא התקבל בזמן (שני ניסיונות).",
    note: "",
    steps: [
      "בדקו שהמכשיר מחובר ל‑Wi‑Fi או שה‑GPS פעיל",
      "נסו שוב, או הזינו קואורדינטות ידנית — הכתובת בשדה התיאור מספיקה תמיד"
    ],
    denial: false,
    retryable: true
  },
  unsupported: {
    title: "הדפדפן לא תומך באיתור מיקום.",
    note: "",
    steps: ["הזינו כתובת בשדה התיאור, או קואורדינטות ידנית"],
    denial: false,
    retryable: false
  },
  insecure_context: {
    title: "איתור מיקום זמין רק בחיבור מאובטח (https).",
    note: "",
    steps: ["פתחו את האתר בכתובת https", "או הזינו כתובת / קואורדינטות ידנית"],
    denial: false,
    retryable: false
  }
};

/** data-testid per failure kind (stable hooks for browser proofs). */
export const GEO_OUTCOME_TEST_ID: Record<Exclude<GeoOutcomeKind, "success">, string> = {
  site_denied: "geo-denied",
  os_denied: "geo-os-denied",
  unavailable: "geo-unavailable",
  timeout: "geo-timeout",
  unsupported: "geo-unsupported",
  insecure_context: "geo-insecure"
};

export function parseManualCoordinates(latRaw: string, lngRaw: string): { ok: true; latitude: number; longitude: number } | { ok: false; error: string } {
  const lat = Number(String(latRaw).trim());
  const lng = Number(String(lngRaw).trim());
  if (!String(latRaw).trim() || !String(lngRaw).trim() || !validCoordinate(lat, lng)) {
    return { ok: false, error: "קואורדינטות לא תקינות (קו רוחב עד 90, קו אורך עד 180)" };
  }
  return { ok: true, latitude: lat, longitude: lng };
}
