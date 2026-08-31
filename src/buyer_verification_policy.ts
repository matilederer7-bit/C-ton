// Single server-side buyer verification policy boundary.
//
// OTP is a PARKED, server-controlled capability — it is implemented and testable
// but OFF by default for the MVP buyer journey to minimize adoption/conversion
// friction. This module is the ONE place that decides whether a given buyer
// operation requires verification, so handlers never scatter env checks.
//
// Turning verification OFF does NOT weaken safety. When OFF:
//   * no OTP SMS/challenge is required and the buyer proceeds with minimal friction;
//   * the submitted phone/email is stored as an EXPLICITLY UNVERIFIED contact;
//   * the server still owns/derives the operational participation identity
//     (server-issued unguessable tracking credential), so a caller cannot hijack
//     another buyer by supplying a buyer_id/contact;
//   * rate limits and idempotency remain intact.
// When ON: a missing/failed verification fails closed with no fallback to the
// unverified path, and the proof must be bound to the submitted identity.

export type BuyerVerificationOperation = "join" | "payment" | "recovery";
export type BuyerVerificationMode = "off" | "required";

const ENV_KEY: Record<BuyerVerificationOperation, string> = {
  join: "BUYER_VERIFY_JOIN",
  payment: "BUYER_VERIFY_PAYMENT",
  recovery: "BUYER_VERIFY_RECOVERY"
};

// MVP defaults: Join OFF, Payment OFF, Recovery verification-capable (required).
const DEFAULT_MODE: Record<BuyerVerificationOperation, BuyerVerificationMode> = {
  join: "off",
  payment: "off",
  recovery: "required"
};

function parseMode(raw: string): BuyerVerificationMode | null {
  const v = raw.trim().toLowerCase();
  if (["required", "on", "1", "true", "enforced"].includes(v)) return "required";
  if (["off", "0", "false", "disabled"].includes(v)) return "off";
  return null;
}

export function buyerVerificationMode(
  operation: BuyerVerificationOperation,
  env: NodeJS.ProcessEnv = process.env
): BuyerVerificationMode {
  const override = parseMode(String(env[ENV_KEY[operation]] || ""));
  return override ?? DEFAULT_MODE[operation];
}

export function isBuyerVerificationRequired(
  operation: BuyerVerificationOperation,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return buyerVerificationMode(operation, env) === "required";
}

// A stable snapshot of the policy for readiness/telemetry surfaces (never logs
// any secret). Useful for hosted proof assertions.
export function buyerVerificationPolicySummary(env: NodeJS.ProcessEnv = process.env) {
  return {
    join: buyerVerificationMode("join", env),
    payment: buyerVerificationMode("payment", env),
    recovery: buyerVerificationMode("recovery", env),
    otp_capability: "implemented_parked"
  } as const;
}
