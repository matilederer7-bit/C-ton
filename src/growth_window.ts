// SPRINT 4 (A8) — the time window behind the admin virality dashboard.
//
// Default = last 7 days. Presets 7 / 30 / 90 days, a custom [from, to) range
// (the UI enters Israel-local days, the server only ever sees UTC instants),
// or "all time". The window drives the ACTUAL queries (growth_metrics.ts),
// not just a label. Validation rejects malformed / inverted / absurd ranges
// but imposes no tiny product cap — the only caps are technical sanity
// (a 2020 floor, a 2-day future tolerance, a 20-year span).

export type GrowthWindowKind = "days" | "custom" | "all";

export interface GrowthWindow {
  kind: GrowthWindowKind;
  /** preset length, for kind === "days" */
  days: number | null;
  /** inclusive lower bound (UTC ISO), null = beginning of time */
  from: string | null;
  /** exclusive upper bound (UTC ISO) */
  to: string;
  label_he: string;
}

export type GrowthWindowResolution =
  | { ok: true; window: GrowthWindow }
  | { ok: false; error: string; message_he: string };

export const GROWTH_DEFAULT_DAYS = 7;
export const GROWTH_PRESET_DAYS = [7, 30, 90] as const;
/** technical ceiling for a preset (10 years) — not a product cap */
export const GROWTH_MAX_PRESET_DAYS = 3650;
export const GROWTH_RANGE_FLOOR_ISO = "2020-01-01T00:00:00.000Z";
export const GROWTH_RANGE_FUTURE_TOLERANCE_MS = 2 * 24 * 3600_000;
export const GROWTH_RANGE_MAX_SPAN_MS = 20 * 365 * 24 * 3600_000;

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function resolveGrowthWindow(query: Record<string, unknown> | null | undefined, now: Date = new Date()): GrowthWindowResolution {
  const q = query || {};
  const nowMs = now.getTime();
  const toIso = new Date(nowMs).toISOString();
  const range = typeof q.range === "string" ? q.range.trim().toLowerCase() : "";
  if (range === "all") {
    return { ok: true, window: { kind: "all", days: null, from: null, to: toIso, label_he: "כל הזמן" } };
  }
  const hasCustom = q.from !== undefined || q.to !== undefined;
  if (hasCustom) {
    const fromMs = parseInstant(q.from);
    const toMs = q.to === undefined || q.to === "" ? nowMs : parseInstant(q.to);
    if (fromMs === null || toMs === null) {
      return { ok: false, error: "growth_range_invalid", message_he: "טווח התאריכים אינו תקין — יש להזין תאריך התחלה ותאריך סיום" };
    }
    if (fromMs > toMs) {
      return { ok: false, error: "growth_range_inverted", message_he: "תאריך ההתחלה חייב להיות לפני תאריך הסיום" };
    }
    if (fromMs < Date.parse(GROWTH_RANGE_FLOOR_ISO)) {
      return { ok: false, error: "growth_range_too_early", message_he: "טווח התאריכים מוקדם מדי — אין נתונים לפני 2020" };
    }
    if (toMs > nowMs + GROWTH_RANGE_FUTURE_TOLERANCE_MS) {
      return { ok: false, error: "growth_range_future", message_he: "תאריך הסיום נמצא בעתיד" };
    }
    if (toMs - fromMs > GROWTH_RANGE_MAX_SPAN_MS) {
      return { ok: false, error: "growth_range_too_long", message_he: "טווח התאריכים ארוך מדי" };
    }
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    return {
      ok: true,
      window: { kind: "custom", days: null, from, to, label_he: `טווח מותאם: ${isoDay(fromMs)} עד ${isoDay(Math.max(fromMs, toMs - 1))}` }
    };
  }
  const daysRaw = Number(q.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(GROWTH_MAX_PRESET_DAYS, Math.floor(daysRaw)) : GROWTH_DEFAULT_DAYS;
  const from = new Date(nowMs - days * 24 * 3600_000).toISOString();
  return { ok: true, window: { kind: "days", days, from, to: toIso, label_he: `${days} הימים האחרונים` } };
}
