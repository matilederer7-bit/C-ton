// P0.7 — canonical countdown arithmetic for the public deal page. Pure and
// dependency-free so it is provable without a browser:
//   • four units (days / hours / minutes / seconds), label ABOVE, number BELOW
//   • numbers are NEVER zero-padded: 1 not 01, 0 not 00, 9 not 09
//   • a crossed deadline settles at all-zero (never negative); the page then
//     shows the canonical closed presentation driven by the server deal state
// Time itself comes from the drift-free clock in livecountdown.tsx (canonical
// deadline + server-time offset); this module only derives the parts.

export type CountdownUnitKey = "days" | "hours" | "minutes" | "seconds";

export const COUNTDOWN_UNITS: ReadonlyArray<{ key: CountdownUnitKey; label: string }> = [
  { key: "days", label: "ימים" },
  { key: "hours", label: "שעות" },
  { key: "minutes", label: "דקות" },
  { key: "seconds", label: "שניות" }
];

export type CountdownParts = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  remaining_ms: number;
  reached: boolean; // deadline crossed — everything is 0
  urgent: boolean; // under one hour (visual emphasis only)
};

export const COUNTDOWN_URGENT_MS = 3600_000;
export const COUNTDOWN_TICK_MS = 250; // absolute recompute cadence (never an accumulating interval)

export function countdownParts(remainingMs: number): CountdownParts {
  const ms = Number.isFinite(remainingMs) ? Math.max(0, Math.floor(remainingMs)) : 0;
  const totalSec = Math.floor(ms / 1000);
  return {
    days: Math.floor(totalSec / 86400),
    hours: Math.floor((totalSec % 86400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    seconds: totalSec % 60,
    remaining_ms: ms,
    reached: ms <= 0,
    urgent: ms > 0 && ms <= COUNTDOWN_URGENT_MS
  };
}

/** Plain ASCII digits, no padding — "1", "0", "9", "23". */
export function formatCountdownNumber(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return String(n);
}

export function countdownAccessibleLabel(parts: CountdownParts): string {
  if (parts.reached) return "ההצטרפות הסתיימה";
  return `נותרו ${parts.days} ימים, ${parts.hours} שעות, ${parts.minutes} דקות ו-${parts.seconds} שניות`;
}

export function sameCountdownParts(a: CountdownParts | null, b: CountdownParts): boolean {
  return Boolean(a)
    && a!.days === b.days && a!.hours === b.hours && a!.minutes === b.minutes && a!.seconds === b.seconds
    && a!.reached === b.reached && a!.urgent === b.urgent;
}
