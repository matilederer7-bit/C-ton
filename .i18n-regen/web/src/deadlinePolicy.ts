// Seller-side mirror of src/deadline_policy.ts (the server is authoritative;
// tests/long_horizon_deadline_policy_validation.ts pins both to the same
// numbers so the picker can never disagree with the API).
//
// There is NO payment-derived maximum any more: a deal may run for weeks or
// months; the provider authorization is renewed by the worker when it expires.
export const DEADLINE_MIN_MS = 2 * 60 * 60 * 1000;
export const DEADLINE_TECHNICAL_MAX_YEARS = 20;
export const DEADLINE_TECHNICAL_MAX_MS = DEADLINE_TECHNICAL_MAX_YEARS * 365 * 24 * 60 * 60 * 1000;
export const LONG_HORIZON_WARNING_MS = 365 * 24 * 60 * 60 * 1000;

export function classifyDeadlineMs(deadlineMs: number, nowMs = Date.now()) {
  if (!Number.isFinite(deadlineMs)) return { ok: false as const, code: "deadline_invalid" as const, long_horizon: false };
  const diff = deadlineMs - nowMs;
  if (diff < DEADLINE_MIN_MS) return { ok: false as const, code: "deadline_below_minimum" as const, long_horizon: false };
  if (diff > DEADLINE_TECHNICAL_MAX_MS) return { ok: false as const, code: "deadline_above_maximum" as const, long_horizon: false };
  return { ok: true as const, code: null, long_horizon: diff > LONG_HORIZON_WARNING_MS };
}
