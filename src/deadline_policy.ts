// LONG-HORIZON DEALS — the ONE deadline policy (owner item 8, Track B).
//
// Today the product limits a deal deadline to 2 hours … 7 days. The 7-day
// ceiling is NOT a calendar preference: it is the documented lifetime of the
// payment authorization taken at join time (Grow J5 "Suspended Charge":
// "J5 transactions have a timeframe of up to 7 days", auto-released after
// ~10 days without a J4 settle — docs/R9B_GROW_SANDBOX_ACTIVATION.md). A deal
// whose deadline is later than the hold would charge nobody: every hold would
// have expired before the deal decides.
//
// This module makes that truth explicit and shared (server validation and the
// React picker both derive their bounds from it) instead of duplicating "7"
// in three places, and it carries the long-horizon vocabulary the future
// model needs (the 365-day warning, an explicit horizon reason) WITHOUT
// changing runtime behaviour: the maximum stays the proven authorization hold
// until a provider capability that survives months (a stored instrument with
// merchant-initiated future charges) is PROVEN and integrated
// (docs/LONG_HORIZON_DEALS_ARCHITECTURE.md). There is deliberately NO
// environment flag that could raise the ceiling: flipping such a flag would
// create year-long deals whose AuthHeld money would silently expire.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Operational minimum: a deal needs a real joining window. */
export const DEADLINE_MIN_MS = 2 * HOUR_MS;

/** Default when a caller sends no deadline (inside every policy). */
export const DEADLINE_DEFAULT_MS = 24 * HOUR_MS;

/**
 * The PROVEN lifetime of the join-time authorization (Grow J5 documented
 * window; the synthetic/mock provider has no proof of anything longer and is
 * held to the same bound). This is the current runtime ceiling.
 */
export const PROVEN_AUTHORIZATION_HOLD_MS = 7 * DAY_MS;

/** Beyond this the seller must be warned that stored payment methods may not survive. */
export const LONG_HORIZON_WARNING_MS = 365 * DAY_MS;

/**
 * Technical representability / product-safety ceiling for a long-horizon
 * model (timestamptz reaches 294276 AD; 20 years is the sanity bound the
 * outbox scheduling proof exercises). Not a product limit.
 */
export const LONG_HORIZON_TECHNICAL_MAX_MS = 20 * 365 * DAY_MS;

export type DeadlineHorizonReason =
  | "proven_authorization_hold"       // today: the join-time hold lifetime bounds the deadline
  | "stored_payment_authority"        // future: a proven stored-instrument / MIT capability
  | "technical_representability";     // the absolute sanity ceiling

export interface DeadlinePolicy {
  min_ms: number;
  max_ms: number;
  reason: DeadlineHorizonReason;
  /** true only once a provider capability that survives the horizon is proven */
  long_horizon_capable: boolean;
}

export interface ProviderDeadlineCapabilities {
  /** how long the join-time authorization is proven to stay capturable */
  authorization_hold_ms: number;
  /** a PROVEN ability to charge a stored instrument months later (MIT / token) */
  stored_payment_authority_proven: boolean;
}

/** What the repository can prove about the current providers (Grow J5, synthetic). */
export const CURRENT_PROVIDER_DEADLINE_CAPABILITIES: ProviderDeadlineCapabilities = {
  authorization_hold_ms: PROVEN_AUTHORIZATION_HOLD_MS,
  stored_payment_authority_proven: false
};

export function resolveDeadlinePolicy(capabilities: ProviderDeadlineCapabilities = CURRENT_PROVIDER_DEADLINE_CAPABILITIES): DeadlinePolicy {
  if (capabilities.stored_payment_authority_proven) {
    return { min_ms: DEADLINE_MIN_MS, max_ms: LONG_HORIZON_TECHNICAL_MAX_MS, reason: "stored_payment_authority", long_horizon_capable: true };
  }
  const hold = Number(capabilities.authorization_hold_ms);
  const maxMs = Number.isFinite(hold) && hold > DEADLINE_MIN_MS ? Math.min(hold, LONG_HORIZON_TECHNICAL_MAX_MS) : PROVEN_AUTHORIZATION_HOLD_MS;
  return { min_ms: DEADLINE_MIN_MS, max_ms: maxMs, reason: "proven_authorization_hold", long_horizon_capable: false };
}

/** The policy the runtime enforces today (server + React). */
export const RUNTIME_DEADLINE_POLICY: DeadlinePolicy = resolveDeadlinePolicy();

export type DeadlineVerdictCode = "ok" | "invalid" | "below_minimum" | "above_maximum";

export interface DeadlineVerdict {
  ok: boolean;
  code: DeadlineVerdictCode;
  /** whole days between now and the deadline (floor), 0 when invalid */
  days: number;
  /** the deadline exceeds LONG_HORIZON_WARNING_MS — show the card-expiry warning */
  long_horizon_warning: boolean;
  message_he: string;
}

export const LONG_HORIZON_WARNING_HE =
  "העסקה מוגדרת לטווח ארוך. לאורך זמן כרטיסי אשראי עלולים לפוג, להתחלף או להיחסם, " +
  "ולכן חלק מהמשתתפים עשויים להידרש לעדכן אמצעי תשלום לפני השלמת העסקה.";

export function describeDeadlineMax(policy: DeadlinePolicy): string {
  const days = Math.round(policy.max_ms / DAY_MS);
  if (days >= 365) return `${Math.round(days / 365)} שנים`;
  return `${days} ימים`;
}

export function classifyDeadline(deadlineMs: number, nowMs: number, policy: DeadlinePolicy = RUNTIME_DEADLINE_POLICY): DeadlineVerdict {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) {
    return { ok: false, code: "invalid", days: 0, long_horizon_warning: false, message_he: "יש לבחור תאריך ושעה תקינים" };
  }
  const diff = deadlineMs - nowMs;
  const days = Math.max(0, Math.floor(diff / DAY_MS));
  const warning = diff > LONG_HORIZON_WARNING_MS;
  if (diff < policy.min_ms) {
    return { ok: false, code: "below_minimum", days, long_horizon_warning: false, message_he: "מועד הסיום חייב להיות לפחות שעתיים מעכשיו" };
  }
  if (diff > policy.max_ms) {
    return { ok: false, code: "above_maximum", days, long_horizon_warning: warning, message_he: `מועד הסיום יכול להיות עד ${describeDeadlineMax(policy)} קדימה` };
  }
  return { ok: true, code: "ok", days, long_horizon_warning: warning, message_he: "" };
}
