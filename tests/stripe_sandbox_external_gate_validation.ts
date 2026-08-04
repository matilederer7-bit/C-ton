import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runAuthorizationOnlyProof } from "../external-tests/stripe_sandbox_authorization_only.js";

const workflow = await readFile(".github/workflows/stripe-sandbox-proof.yml", "utf8");
const entry = await readFile("external-tests/stripe_sandbox_authorization_release.ts", "utf8");
const harness = await readFile("external-tests/stripe_sandbox_authorization_only.ts", "utf8");
const runner = await readFile("scripts/run_stripe_sandbox_external.cjs", "utf8");
const artifactScan = await readFile("scripts/scan_stripe_sandbox_report.cjs", "utf8");
assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(workflow, /pull_request:|\n\s*push:/);
assert.match(workflow, /proof_scope:/);
assert.match(workflow, /options: \["authorization-only"\]/);
assert.match(workflow, /CONFIRMED.*inputs\.confirm_test_mode_only/);
assert.match(workflow, /PROOF_SCOPE.*inputs\.proof_scope/);
assert.match(workflow, /environment:\s*stripe-sandbox/);
assert.match(workflow, /Stripe Sandbox external verification not executed/);
assert.doesNotMatch(workflow, /set\s+-x|printenv|env\s*\|/);
assert.doesNotMatch(entry, /\.release\s*\(|\.cancel\s*\(|\.capture\s*\(|\.refund\s*\(|finally\s*\{/);
assert.doesNotMatch(harness, /\.release\s*\(|\.cancel\s*\(|\.capture\s*\(|\.refund\s*\(|finally\s*\{/);
assert.match(harness, /provider\.authorize\(authorizationInput\)/);
assert.match(harness, /provider\.status\(/);
assert.match(harness, /pm_card_visa_chargeDeclined/);
assert.match(entry, /aes-256-gcm/);
assert.doesNotMatch(entry, /console\.(log|error)\([^\n]*(serverKey|publicKey|webhookSecret)/);
assert.match(runner, /proofScope !== "authorization-only"/);
assert.match(artifactScan, /protected_provider_reference/);

let releaseCalls = 0, captureCalls = 0, refundCalls = 0;
let authorizationCalls = 0, statusCalls = 0;
const authorizationId = "provider-reference-fixture";
const provider = {
  async authorize(input: any) {
    authorizationCalls += 1;
    if (input.payment_method_id === "pm_card_visa_chargeDeclined") return { ok: false as const, error: "declined", statusCode: 402, retryable: false };
    if (input.amount_minor !== 1000) return { ok: false as const, error: "idempotency_mismatch", statusCode: 409, retryable: false };
    return { ok: true as const, authorization_id: authorizationId, provider_reference: authorizationId };
  },
  async status() { statusCalls += 1; return { state: "authorized", amount_minor: 1000, currency: "ILS", provider_reference: authorizationId }; },
  async release() { releaseCalls += 1; }, async capture() { captureCalls += 1; }, async refund() { refundCalls += 1; }
};
const report = await runAuthorizationOnlyProof({ provider, protectProviderReference: () => "v1.a.b.c", runId: "fixture", now: () => new Date("2026-08-03T00:00:00.000Z") });
assert.equal(authorizationCalls, 4);
assert.equal(statusCalls, 1);
assert.equal(releaseCalls, 0);
assert.equal(captureCalls, 0);
assert.equal(refundCalls, 0);
assert.equal(report.release_executed, false);
assert.equal(report.capture_executed, false);
assert.equal(report.refund_executed, false);
console.log("PASS authorization-only Stripe proof has zero release, capture, and refund calls");