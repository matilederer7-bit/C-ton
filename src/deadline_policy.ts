// Deal deadline policy — ONE source of truth for the server; web/src/deadlinePolicy.ts
// mirrors the same constants for the seller picker (a test pins both together).
//
// LONG_HORIZON_DEALS decision (2026-09-16): a deal's lifetime is a PRODUCT
// quantity and is NOT bounded by the lifetime of a payment-provider card
// authorization. The former 7-day maximum existed only because the join-time
// hold was assumed to have to survive, unchanged, until capture (Grow J5 ≈ 7
// days). That coupling is gone: the buyer's financial commitment is durable
// according to Siton's state machine, while the provider authorization is a
// replaceable technical instrument that the worker re-establishes at the
// charging boundary when the original one is no longer usable
// (docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md).
//
// What remains:
//   * a 2-hour minimum — a product rule (buyers need time to join), unchanged;
//   * a technical sanity ceiling — protects against typo'd dates (year 20261),
//     not a business or payment limit; no environment flag can raise it;
//   * an advisory long-horizon threshold (> 1 year) for seller-facing copy: cards
//     may expire or be replaced and some buyers may need to update their payment
//     method before completion. Advisory only — it never blocks.

export const DEADLINE_MIN_MS = 2 * 60 * 60 * 1000;
export const DEADLINE_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const DEADLINE_TECHNICAL_MAX_YEARS = 20;
export const DEADLINE_TECHNICAL_MAX_MS = DEADLINE_TECHNICAL_MAX_YEARS * 365 * 24 * 60 * 60 * 1000;
export const LONG_HORIZON_WARNING_MS = 365 * 24 * 60 * 60 * 1000;

export type DeadlineClassification =
  | { ok: true; long_horizon: boolean; diff_ms: number }
  | { ok: false; code: "deadline_invalid" | "deadline_below_minimum" | "deadline_above_maximum"; message: string; diff_ms: number | null };

export const DEADLINE_MESSAGES = {
  deadline_invalid: "deadline must be a valid ISO date",
  deadline_below_minimum: "deadline must be at least 2 hours in the future",
  deadline_above_maximum: `deadline exceeds the technical maximum of ${DEADLINE_TECHNICAL_MAX_YEARS} years from now`
} as const;

/**
 * Classify a proposed deadline instant against the policy. Pure; the caller
 * decides how to surface the result (HTTP 400 with the code, UI message, …).
 */
export function classifyDeadline(deadlineMs: number, nowMs = Date.now()): DeadlineClassification {
  if (!Number.isFinite(deadlineMs)) {
    return { ok: false, code: "deadline_invalid", message: DEADLINE_MESSAGES.deadline_invalid, diff_ms: null };
  }
  const diff = deadlineMs - nowMs;
  if (diff < DEADLINE_MIN_MS) {
    return { ok: false, code: "deadline_below_minimum", message: DEADLINE_MESSAGES.deadline_below_minimum, diff_ms: diff };
  }
  if (diff > DEADLINE_TECHNICAL_MAX_MS) {
    return { ok: false, code: "deadline_above_maximum", message: DEADLINE_MESSAGES.deadline_above_maximum, diff_ms: diff };
  }
  return { ok: true, long_horizon: diff > LONG_HORIZON_WARNING_MS, diff_ms: diff };
}

/** Summary for observability / documentation surfaces. Never contains a payment-derived bound. */
export function describeDeadlinePolicy() {
  return {
    min_ms: DEADLINE_MIN_MS,
    default_ms: DEADLINE_DEFAULT_MS,
    technical_max_ms: DEADLINE_TECHNICAL_MAX_MS,
    long_horizon_warning_ms: LONG_HORIZON_WARNING_MS,
    payment_authorization_bounded: false,
    basis: "deal lifetime is independent of provider authorization lifetime; expired authorizations are re-established by the worker at the charging boundary"
  };
}
