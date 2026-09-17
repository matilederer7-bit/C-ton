// LONG_HORIZON_DEALS — pure helpers that separate the two concepts the
// payment path must never conflate:
//
//   A. the buyer's financial COMMITMENT to the deal — durable, governed by the
//      Siton state machine (AuthHeld → AuthLocked → ChargeAttempt → …);
//   B. the CURRENT provider authorization instrument — technical, with a
//      provider-defined validity, replaceable at the charging boundary.
//
// Nothing here mutates state or talks to a provider; the worker rails call
// these to decide whether the instrument may still be used, and the
// provider adapters mark declines that are about the instrument rather than
// the buyer (docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md).

export type AuthorizationUsability =
  /** the provider declared a validity and it has not passed */
  | "usable"
  /** the provider declared a validity and it has passed (or the provider reported the instrument unusable) */
  | "expired"
  /** no declared validity: the provider decides at capture time */
  | "undeclared";

export type AuthorizationInstrument = {
  authorization_id?: string | null;
  provider_reference?: string | null;
  expires_at?: string | Date | null;
};

/** Safety margin: an authorization that expires within this window is renewed BEFORE the capture is dispatched (env-tunable, default 0 = renew only once past validity). */
export function authorizationRenewalMarginMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AUTHORIZATION_RENEWAL_MARGIN_MS || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function assessAuthorizationUsability(
  instrument: AuthorizationInstrument | null | undefined,
  nowMs = Date.now(),
  marginMs = authorizationRenewalMarginMs()
): { usability: AuthorizationUsability; expires_at_ms: number | null } {
  if (!instrument || instrument.expires_at === null || instrument.expires_at === undefined || instrument.expires_at === "") {
    return { usability: "undeclared", expires_at_ms: null };
  }
  const at = instrument.expires_at instanceof Date ? instrument.expires_at.getTime() : new Date(String(instrument.expires_at)).getTime();
  if (!Number.isFinite(at)) return { usability: "undeclared", expires_at_ms: null };
  return { usability: at - marginMs <= nowMs ? "expired" : "usable", expires_at_ms: at };
}

/**
 * A provider-declared permanent failure that is about the INSTRUMENT (expired /
 * voided hold), not about the buyer's ability to pay. The obligation was not
 * charged and never can be on that authorization.
 */
export function isAuthorizationUnusableResult(result: { result_class: string; authorization_unusable?: boolean } | null | undefined): boolean {
  return Boolean(result && result.result_class === "permanent_fail" && result.authorization_unusable === true);
}

/** Durable identity of ONE re-authorization request (minted before I/O, like every money identity). */
export function reauthorizationIdentity(eventId: string, logicalAttempt: number, participantId: string) {
  return `reauth:${eventId}:n${logicalAttempt}:${participantId}`;
}
