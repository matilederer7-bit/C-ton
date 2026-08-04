import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

type AuthorizationInput = { payment_method_id: string; amount_minor: number; currency: string; buyer_id: string; deal_id: string; correlation_id: string; request_id: string };
type AuthorizationResult = { ok: true; authorization_id: string; provider_reference: string } | { ok: false; error: string; statusCode?: number; retryable?: boolean };
type StatusResult = { state: string; amount_minor?: number; currency?: string; provider_reference?: string };
export type AuthorizationOnlyProvider = {
  authorize(input: AuthorizationInput): Promise<AuthorizationResult>;
  status(input: { provider_reference: string; operation: "authorization"; correlation_id: string }): Promise<StatusResult>;
};
export type AuthorizationOnlyReport = {
  external_verification: "executed"; proof_scope: "authorization-only"; stripe_mode: "test";
  authorization: "authorized_pending_capture"; authorization_state: "authorized";
  capture_executed: false; refund_executed: false; release_executed: false;
  idempotent_replay: "pass"; payload_mismatch: "blocked"; decline: "normalized";
  amount_minor: number; currency: string; created_at: string; sandbox_run_id: string;
  idempotency_reference_sha256_prefix: string; protected_provider_reference: string;
};
const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

export async function runAuthorizationOnlyProof(input: {
  provider: AuthorizationOnlyProvider; protectProviderReference: (providerReference: string) => string;
  now?: () => Date; runId?: string;
}): Promise<AuthorizationOnlyReport> {
  const runId = input.runId || randomUUID().replace(/-/g, "");
  const authorizationKey = `siton_sb_auth_${runId}`;
  const amountMinor = 1000;
  const currency = "ILS";
  const authorizationInput: AuthorizationInput = {
    payment_method_id: "pm_card_visa", amount_minor: amountMinor, currency,
    buyer_id: `sandbox_buyer_${runId}`, deal_id: `sandbox_deal_${runId}`,
    correlation_id: authorizationKey, request_id: authorizationKey
  };
  const authorized = await input.provider.authorize(authorizationInput);
  assert.equal(authorized.ok, true, "Stripe Test Mode authorization must succeed");
  if (!authorized.ok) throw new Error("Stripe Test Mode authorization failed");
  const authorizationId = authorized.authorization_id;
  const status = await input.provider.status({ provider_reference: authorizationId, operation: "authorization", correlation_id: `${authorizationKey}_status` });
  assert.equal(status.state, "authorized");
  assert.equal(status.amount_minor, amountMinor);
  assert.equal(status.currency, currency);
  if (status.provider_reference) assert.equal(status.provider_reference, authorizationId);
  const replay = await input.provider.authorize(authorizationInput);
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error("Stripe Test Mode authorization replay failed");
  assert.equal(replay.provider_reference, authorizationId, "same Stripe idempotency key must return the same PaymentIntent");
  const mismatch = await input.provider.authorize({ ...authorizationInput, amount_minor: amountMinor + 100 });
  assert.equal(mismatch.ok, false, "changed payload with the same idempotency key must be rejected");
  const declineKey = `siton_sb_decline_${runId}`;
  const declined = await input.provider.authorize({ ...authorizationInput, payment_method_id: "pm_card_visa_chargeDeclined", correlation_id: declineKey, request_id: declineKey });
  assert.equal(declined.ok, false, "official Stripe decline PaymentMethod must be declined");
  if (!declined.ok) { assert.notEqual(declined.statusCode, 500); assert.equal(declined.retryable, false); }
  return {
    external_verification: "executed", proof_scope: "authorization-only", stripe_mode: "test",
    authorization: "authorized_pending_capture", authorization_state: "authorized",
    capture_executed: false, refund_executed: false, release_executed: false,
    idempotent_replay: "pass", payload_mismatch: "blocked", decline: "normalized",
    amount_minor: amountMinor, currency, created_at: (input.now || (() => new Date()))().toISOString(),
    sandbox_run_id: shortHash(runId), idempotency_reference_sha256_prefix: shortHash(authorizationKey),
    protected_provider_reference: input.protectProviderReference(authorizationId)
  };
}