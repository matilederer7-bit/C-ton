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
