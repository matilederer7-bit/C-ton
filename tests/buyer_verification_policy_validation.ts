import assert from "node:assert/strict";
import {
  buyerVerificationMode,
  isBuyerVerificationRequired,
  buyerVerificationPolicySummary
} from "../src/buyer_verification_policy.js";

// The single server-side buyer verification policy boundary. MVP defaults:
// Join OFF, Payment OFF, Recovery required. Env overrides both directions.

let passed = 0, failed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.message || e}`); failed++; }
}

ok("MVP default: join OFF", () => assert.equal(buyerVerificationMode("join", {}), "off"));
ok("MVP default: payment OFF", () => assert.equal(buyerVerificationMode("payment", {}), "off"));
ok("MVP default: recovery REQUIRED", () => assert.equal(buyerVerificationMode("recovery", {}), "required"));

ok("join can be switched ON by env", () => assert.equal(buyerVerificationMode("join", { BUYER_VERIFY_JOIN: "required" }), "required"));
ok("payment ON via '1'", () => assert.equal(buyerVerificationMode("payment", { BUYER_VERIFY_PAYMENT: "1" }), "required"));
ok("recovery can be switched OFF by env", () => assert.equal(buyerVerificationMode("recovery", { BUYER_VERIFY_RECOVERY: "off" }), "off"));

ok("isBuyerVerificationRequired reflects mode", () => {
  assert.equal(isBuyerVerificationRequired("join", {}), false);
  assert.equal(isBuyerVerificationRequired("recovery", {}), true);
  assert.equal(isBuyerVerificationRequired("join", { BUYER_VERIFY_JOIN: "on" }), true);
});

ok("unrecognized override falls back to the default", () => {
  assert.equal(buyerVerificationMode("join", { BUYER_VERIFY_JOIN: "maybe" }), "off");
  assert.equal(buyerVerificationMode("recovery", { BUYER_VERIFY_RECOVERY: "banana" }), "required");
});

ok("summary reports all three ops and the parked OTP capability", () => {
  const s = buyerVerificationPolicySummary({});
  assert.equal(s.join, "off");
  assert.equal(s.payment, "off");
  assert.equal(s.recovery, "required");
  assert.equal(s.otp_capability, "implemented_parked");
});

console.log(`\nBUYER_VERIFICATION_POLICY ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
