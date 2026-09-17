import assert from "node:assert/strict";
import { buildSyntheticPaymentProvider } from "../src/synthetic_payment_provider.js";

const lab = buildSyntheticPaymentProvider({ authorize: ["success", "decline", "unknown", "expired"], capture: ["success", "decline", "unknown", "temporary_fail"], recover: ["success", "decline"], refund: ["success"], release: ["success"] });

const authInput = { payer_name: "Synthetic Buyer", payment_method_id: "synthetic-method", amount_minor: 11800, currency: "ILS", correlation_id: "auth-success" };
const authorized = await lab.provider.authorize(authInput);
assert.equal(authorized.ok, true);
if (!authorized.ok) throw new Error("authorization fixture failed");
const replay = await lab.provider.authorize(authInput);
assert.deepEqual(replay, authorized);
await assert.rejects(() => lab.provider.authorize({ ...authInput, amount_minor: 11900 }), /idempotency_conflict/);
const declined = await lab.provider.authorize({ ...authInput, correlation_id: "auth-decline" });
assert.equal(declined.ok, false);
const unknown = await lab.provider.authorize({ ...authInput, correlation_id: "auth-unknown" });
assert.equal(unknown.ok, false);
if (unknown.ok) throw new Error("unknown fixture failed");
assert.equal(unknown.retryable, true);
const expired = await lab.provider.authorize({ ...authInput, correlation_id: "auth-expired" });
assert.equal(expired.ok, false);

const captured = await lab.provider.capture({ authorization_id: authorized.authorization_id, amount_minor: 11800, currency: "ILS", correlation_id: "cap-success" });
assert.equal(captured.result_class, "success");
const duplicateCapture = await lab.provider.capture({ authorization_id: authorized.authorization_id, amount_minor: 11800, currency: "ILS", correlation_id: "cap-success" });
assert.deepEqual(duplicateCapture, captured);
const chargeDecline = await lab.provider.capture({ authorization_id: "auth-decline-2", amount_minor: 11800, currency: "ILS", correlation_id: "cap-decline" });
assert.equal(chargeDecline.result_class, "permanent_fail");
const chargeUnknown = await lab.provider.capture({ authorization_id: "auth-unknown-2", amount_minor: 11800, currency: "ILS", correlation_id: "cap-unknown" });
assert.equal(chargeUnknown.result_class, "temporary_fail");

const recovered = await lab.provider.recover({ authorization_id: authorized.authorization_id, amount_minor: 11800, currency: "ILS", correlation_id: "recover-success" }, true);
assert.equal(recovered.reconciliation_event_type, "recovery_captured");
const recoveryOutsideWindow = await lab.provider.recover({ authorization_id: authorized.authorization_id, amount_minor: 11800, currency: "ILS", correlation_id: "recover-late" }, false);
assert.equal(recoveryOutsideWindow.result_class, "permanent_fail");
const refunded = await lab.provider.refund({ authorization_id: authorized.authorization_id, capture_reference: String(captured.provider_reference), amount_minor: 11800, currency: "ILS", correlation_id: "refund-success" });
assert.equal(refunded.reconciliation_event_type, "refund_issued");
const duplicateRefund = await lab.provider.refund({ authorization_id: authorized.authorization_id, capture_reference: String(captured.provider_reference), amount_minor: 11800, currency: "ILS", correlation_id: "refund-success" });
assert.deepEqual(duplicateRefund, refunded);
const released = await lab.provider.release?.({ authorization_id: authorized.authorization_id, amount_minor: 11800, currency: "ILS", correlation_id: "release-success" });
assert.equal(released?.result_class, "success");

lab.duplicateLastEvent();
const outOfOrder = lab.deliverOutOfOrder();
assert.ok(outOfOrder.length > 1);
assert.ok(outOfOrder[0]!.sequence >= outOfOrder.at(-1)!.sequence);
assert.equal(lab.snapshot().idempotency_entries >= 8, true);

console.log("PASS deterministic synthetic provider covers authorization, capture, UNKNOWN, release, expiry, recovery and refund");
console.log("PASS synthetic replays are idempotent and payload conflicts fail closed");
console.log("PASS duplicate and out-of-order provider callback fixtures are deterministic with zero network transport");

// LONG_HORIZON_DEALS — the lab models the authorization INSTRUMENT lifecycle:
// declared validity, a lapsed hold that is declined as unusable (never as a
// buyer decline), and stored-instrument re-authorization that is idempotent on
// the worker's durable identity.
{
  const { paymentProviderCapabilities } = await import("../src/payment_provider.js");
  const horizon = buildSyntheticPaymentProvider({ reauthorize: ["success", "decline"] }, { authorization_ttl_ms: 7 * 24 * 3600_000 });
  assert.equal(paymentProviderCapabilities(horizon.provider).stored_instrument_reauthorization, true);
  assert.equal(paymentProviderCapabilities(lab.provider).stored_instrument_reauthorization, true);
  const held = await horizon.provider.authorize({ ...authInput, correlation_id: "lh-auth" });
  assert.equal(held.ok, true);
  if (!held.ok) throw new Error("fixture");
  assert.ok(held.expires_at && new Date(held.expires_at).getTime() > Date.now() + 6 * 24 * 3600_000, "declared validity is carried on the result");
  horizon.expireAuthorization(held.authorization_id);
  const lapsed = await horizon.provider.capture({ authorization_id: held.authorization_id, amount_minor: 11800, currency: "ILS", correlation_id: "lh-cap-1" });
  assert.equal(lapsed.result_class, "permanent_fail");
  assert.equal(lapsed.authorization_unusable, true, "a lapsed hold is an INSTRUMENT failure, not a buyer decline");
  assert.equal(lapsed.failure_code, "authorization_expired");
  const status = await horizon.provider.status!({ provider_reference: held.authorization_id, operation: "capture", correlation_id: "lh-status" });
  assert.equal(status.state, "failed"); assert.equal(status.error_code, "authorization_expired");
  const renewInput = { payment_method_ref: "synthetic-method", amount_minor: 11800, currency: "ILS", correlation_id: "reauth:lh:n1", replaced_authorization_id: held.authorization_id };
  const renewed = await horizon.provider.reauthorize!(renewInput);
  assert.equal(renewed.ok, true);
  if (!renewed.ok) throw new Error("fixture");
  assert.notEqual(renewed.authorization_id, held.authorization_id, "a renewal is a NEW authorization reference");
  assert.deepEqual(await horizon.provider.reauthorize!(renewInput), renewed, "the same identity replays the same renewal");
  const captureRenewed = await horizon.provider.capture({ authorization_id: renewed.authorization_id, amount_minor: 11800, currency: "ILS", correlation_id: "lh-cap-2" });
  assert.equal(captureRenewed.result_class, "success");
  const renewalDeclined = await horizon.provider.reauthorize!({ ...renewInput, correlation_id: "reauth:lh:n2" });
  assert.equal(renewalDeclined.ok, false);
  if (!renewalDeclined.ok) assert.equal(renewalDeclined.dispatched, true);
  const missingInstrument = await horizon.provider.reauthorize!({ ...renewInput, payment_method_ref: "", correlation_id: "reauth:lh:n3" });
  assert.equal(missingInstrument.ok, false);
  if (!missingInstrument.ok) assert.equal(missingInstrument.dispatched, false, "adapter validation is a proven pre-dispatch failure");
  console.log("PASS synthetic provider models authorization validity, unusable lapsed holds and idempotent stored-instrument re-authorization");
}
