import { t } from "./i18n";
// SPRINT 4 (A8) — the admin virality time range, as the UI expresses it.
//
// Presets are day counts; the custom range is entered as ISRAEL-LOCAL calendar
// days (what the operator thinks in) and sent to the server as UTC instants:
// `from` = the start of the first day, `to` = the start of the day AFTER the
// last day (exclusive), both computed through the DST-aware Israel converter.
// Pure module (no DOM) so the boundary math is unit-testable.

export type GrowthRange =
  | { kind: "days"; days: number }
  | { kind: "custom"; from: string; to: string }
  | { kind: "all" };

export const GROWTH_RANGE_PRESETS: { days: number; label: string }[] = [
  { days: 7, label: "growth_range.growth_range_presets.label" },
  { days: 30, label: "growth_range.growth_range_presets.label_2" },
  { days: 90, label: "growth_range.growth_range_presets.label_3" }
];

export const DEFAULT_GROWTH_RANGE: GrowthRange = { kind: "days", days: 7 };

function nextDay(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return d.toISOString().slice(0, 10);
}

export type IsraelToUtc = (dateStr: string, timeStr: string) => string | null;

/** Validate a custom range the way the operator typed it (both days required, from <= to). */
export function validateCustomRange(from: string, to: string): string | null {
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok(from) || !ok(to)) return t("growth_range.9ee28bab");
  if (from > to) return t("growth_range.e10e6fd8");
  return null;
}

/** Query-string parameters for GET /api/admin/growth. */
export function growthRangeParams(range: GrowthRange, israelToUtc: IsraelToUtc): Record<string, string> {
  if (range.kind === "all") return { range: "all" };
  if (range.kind === "custom") {
    const from = israelToUtc(range.from, "00:00");
    const to = israelToUtc(nextDay(range.to), "00:00");
    if (!from || !to) return { days: String(DEFAULT_GROWTH_RANGE.kind === "days" ? DEFAULT_GROWTH_RANGE.days : 7) };
    return { from, to };
  }
  return { days: String(range.days) };
}

/** Human label shown next to the numbers (Israel time). */
export function growthRangeLabel(range: GrowthRange): string {
  if (range.kind === "all") return t("growth_range.b45e8f7c");
  if (range.kind === "custom") return t("growth_range.d9ca25c3", { from: range.from, to: range.to });
  return t("growth_range.55ed876e", { days: range.days });
}
