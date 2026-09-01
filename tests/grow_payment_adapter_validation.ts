import assert from "node:assert/strict";
import { buildGrowPaymentAdapter, assertGrowConfig, openGrowReference, sealGrowReference, redactGrowLog, type GrowConfig, type GrowTransportRequest } from "../src/grow_payment_adapter.js";

// R9B — Grow J4/J5 adapter against the OFFICIAL Grow contract
// (developers.grow.business, verified 2026-09-01):
//   createPaymentProcess  chargeType=2 (Suspended Charge / J5)
//   getPaymentProcessInfo {pageCode,processId,processToken} → data.transactions[]
//   settleSuspendedTransaction {userId,transactionId,transactionToken,sum}
//   refundTransaction {userId,transactionId,transactionToken,refundSum[,pageCode]}
//   approveTransaction — NEVER sent for J4/J5 (official instruction)
//   callback — no documented signature; hint only, never money truth.

const requests: GrowTransportRequest[] = [];
const key = "test-only-grow-reference-key-32-bytes-minimum";
const config: GrowConfig = {
  base_url: "https://sandbox.meshulam.co.il/api/light/server/1.0",
  environment: "sandbox",
  user_id: "sandbox-user",
  page_code: "sandbox-page",
  api_key: "sandbox-api-key",
  reference_encryption_key: key,
  success_url: "https://example.invalid/pay/success",
  cancel_url: "https://example.invalid/pay/cancel",
  notify_url: "https://example.invalid/webhooks/payments/grow",
  timeout_ms: 1000,
  paths: { create: "/createPaymentProcess", process_info: "/getPaymentProcessInfo", settle: "/settleSuspendedTransaction", refund: "/refundTransaction", transaction_info: "/getTransactionInfo", approve: "/approveTransaction" }
};

let reply: any = { status: 1, err: "", data: { processId: "12345", processToken: "process-secret", url: "https://sandbox.meshulam.co.il/far?l=test" } };
const adapter = buildGrowPaymentAdapter({ config, transport: async (request) => { requests.push(request); return { status: 200, body: reply }; } });

// --- J5 create: server-only amount, chargeType=2, official auth params -------
const started = await adapter.startSuspendedAuthorization({ amount_minor: 12345, payer_name: "Israel Israeli", payer_phone: "0500000000", payer_email: "buyer@example.invalid", description: "Siton deal", correlation_id: "corr-grow-1" });
assert.equal(started.result_class, "success");
assert.equal(started.authorization_state, "pending_provider_confirmation");
assert.equal(requests.length, 1);
assert.equal(requests[0]?.url, `${config.base_url}/createPaymentProcess`);
assert.equal(requests[0]?.body.get("chargeType"), "2");
assert.equal(requests[0]?.body.get("sum"), "123.45");
assert.equal(requests[0]?.body.get("pageCode"), "sandbox-page");
assert.equal(requests[0]?.body.get("userId"), "sandbox-user");
assert.equal(requests[0]?.body.get("cField1"), "corr-grow-1");
// GROW_API_KEY is not part of the documented endpoint contract — never sent.
assert.equal(requests[0]?.body.has("apiKey"), false);
assert.ok(!String(started.provider_reference).includes("process-secret"));
assert.deepEqual(openGrowReference(String(started.provider_reference), key), { process_id: "12345", process_token: "process-secret" });

// --- status: official data.transactions[] response shape ---------------------
reply = { status: 1, err: "", data: { processId: "12345", processToken: "process-secret", transactions: [
  { transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "11", status: "עסקה מושהית", sum: "123.45" }
] } };
const status = await adapter.status(String(started.provider_reference));
assert.equal(status.state, "authorized");
assert.equal(status.final, true);
assert.equal(status.amount_minor, 12345);
assert.equal(requests.at(-1)?.url, `${config.base_url}/getPaymentProcessInfo`);
assert.equal(requests.at(-1)?.body.get("pageCode"), "sandbox-page");
assert.equal(requests.at(-1)?.body.get("processId"), "12345");
// The refreshed sealed reference now carries the TRANSACTION credentials the
// official settle contract requires.
const confirmedReference = String((status as any).provider_reference);
assert.deepEqual(openGrowReference(confirmedReference, key), { process_id: "12345", process_token: "process-secret", transaction_id: "tx-1", transaction_token: "tx-secret" });

// Once transaction credentials exist, status uses getTransactionInfo (flat data).
reply = { status: 1, err: "", data: { transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "2", status: "שולם", sum: "123.45" } };
const captureStatus = await adapter.status(confirmedReference);
assert.equal(captureStatus.state, "captured");
assert.equal(requests.at(-1)?.url, `${config.base_url}/getTransactionInfo`);
assert.equal(requests.at(-1)?.body.get("transactionId"), "tx-1");

// --- J4 capture: settle identified by TRANSACTION credentials ---------------
reply = { status: 1, err: "", data: { transactionId: "tx-1", transactionToken: "tx-secret" } };
const captured = await adapter.capture(confirmedReference, 12345);
assert.equal(captured.result_class, "success");
const settleRequest = requests.at(-1);
assert.equal(settleRequest?.url, `${config.base_url}/settleSuspendedTransaction`);
assert.equal(settleRequest?.body.get("userId"), "sandbox-user");
assert.equal(settleRequest?.body.get("transactionId"), "tx-1");
assert.equal(settleRequest?.body.get("transactionToken"), "tx-secret");
assert.equal(settleRequest?.body.get("sum"), "123.45");
assert.equal(settleRequest?.body.has("processId"), false);
assert.equal(settleRequest?.body.has("processToken"), false);
assert.equal(settleRequest?.body.has("apiKey"), false);

// Capture with a process-only reference resolves transaction credentials via a
// READ-ONLY process-info lookup first, then settles.
{
  const sequence: GrowTransportRequest[] = [];
  const resolving = buildGrowPaymentAdapter({ config, transport: async (request) => {
    sequence.push(request);
    if (request.url.endsWith("/getPaymentProcessInfo")) {
      return { status: 200, body: { status: 1, data: { transactions: [{ transactionId: "tx-9", transactionToken: "tx-9-secret", statusCode: "11", status: "suspended", sum: "50.00" }] } } };
    }
    return { status: 200, body: { status: 1, data: {} } };
  } });
  const processOnly = sealGrowReference({ process_id: "777", process_token: "p-secret" }, key);
  const resolved = await resolving.capture(processOnly, 5000);
  assert.equal(resolved.result_class, "success");
  assert.equal(sequence.length, 2);
  assert.equal(sequence[0]?.url.endsWith("/getPaymentProcessInfo"), true);
  assert.equal(sequence[1]?.url.endsWith("/settleSuspendedTransaction"), true);
  assert.equal(sequence[1]?.body.get("transactionId"), "tx-9");
  // Unresolvable transaction credentials: bounded safe retry, no money call.
  const unresolvable = buildGrowPaymentAdapter({ config, transport: async (request) => {
    assert.equal(request.url.endsWith("/settleSuspendedTransaction"), false, "must not settle without transaction credentials");
    return { status: 200, body: { status: 1, data: { transactions: [] } } };
  } });
  const missing = await unresolvable.capture(processOnly, 5000);
  assert.equal(missing.result_class, "temporary_fail");
  assert.equal(missing.error_code, "grow_capture_transaction_reference_missing");
}

// --- refund: official refundTransaction contract -----------------------------
reply = { status: 1, err: "", data: {} };
const refunded = await adapter.refund(String(captured.provider_reference), 2345);
assert.equal(refunded.result_class, "success");
const refundRequest = requests.at(-1);
assert.equal(refundRequest?.url, `${config.base_url}/refundTransaction`);
assert.equal(refundRequest?.body.get("refundSum"), "23.45");
assert.equal(refundRequest?.body.get("userId"), "sandbox-user");
assert.equal(refundRequest?.body.get("transactionId"), "tx-1");
assert.equal(refundRequest?.body.has("apiKey"), false);
// Refund without transaction credentials fails closed (no guessed identifiers).
const refundNoTx = await adapter.refund(sealGrowReference({ process_id: "1", process_token: "p" }, key), 100);
assert.equal(refundNoTx.result_class, "permanent_fail");
assert.equal(refundNoTx.error_code, "grow_refund_transaction_reference_missing");

// --- approveTransaction is NEVER called for J4/J5 ----------------------------
assert.equal(requests.some((request) => request.url.includes("approveTransaction")), false, "official rule: do not send approveTransaction for J4/J5");

// --- release honesty: observation only, no invented void endpoint ------------
{
  const seen: string[] = [];
  const releaseAdapter = (body: any) => buildGrowPaymentAdapter({ config, transport: async (request) => { seen.push(request.url); return { status: 200, body }; } });
  const active = await releaseAdapter({ status: 1, data: { transactions: [{ transactionId: "tx-1", transactionToken: "s", statusCode: "11", status: "suspended" }] } }).observeRelease(confirmedReference);
  assert.equal(active.result_class, "permanent_fail");
  assert.equal(active.released, false);
  assert.equal(active.error_code, "grow_release_pending_automatic_expiry");
  const failedTx = await releaseAdapter({ status: 1, data: { transactionId: "tx-1", transactionToken: "s", statusCode: "6", status: "failed" } }).observeRelease(confirmedReference);
  assert.equal(failedTx.result_class, "success");
  assert.equal(failedTx.released, true);
  const capturedTx = await releaseAdapter({ status: 1, data: { transactionId: "tx-1", transactionToken: "s", statusCode: "2", status: "שולם" } }).observeRelease(confirmedReference);
  assert.equal(capturedTx.result_class, "permanent_fail");
  assert.equal(capturedTx.error_code, "grow_release_hold_already_captured");
  const ambiguous = await buildGrowPaymentAdapter({ config, transport: async () => { throw new Error("timeout"); } }).observeRelease(confirmedReference);
  assert.equal(ambiguous.result_class, "unknown");
  assert.equal(ambiguous.released, false);
  // Only status-lookup endpoints were touched — never a fabricated void path.
  assert.equal(seen.every((url) => url.includes("Info")), true);
}

// --- UNKNOWN transport + configuration fail-closed ---------------------------
const unknownAdapter = buildGrowPaymentAdapter({ config, transport: async () => { throw new Error("timeout"); } });
const unknown = await unknownAdapter.startSuspendedAuthorization({ amount_minor: 100, payer_name: "Test Buyer", payer_phone: "0500000000", description: "Deal", correlation_id: "corr-timeout" });
assert.equal(unknown.result_class, "unknown");
assert.equal(unknown.retryable, true);
const capturedUnknown = await unknownAdapter.capture(confirmedReference, 12345);
assert.equal(capturedUnknown.result_class, "unknown");

const invalid = buildGrowPaymentAdapter({ config: { ...config, reference_encryption_key: "short" }, transport: async () => { throw new Error("must not run"); } });
assert.equal(invalid.configured, false);
await assert.rejects(() => invalid.startSuspendedAuthorization({ amount_minor: 100, payer_name: "Test Buyer", payer_phone: "0500000000", description: "Deal", correlation_id: "corr-invalid" }), /32_characters/);

const startInput = { amount_minor: 100, payer_name: "Test Buyer", payer_phone: "0500000000", description: "Deal", correlation_id: "corr-contract" };
const http4xx = buildGrowPaymentAdapter({ config, transport: async () => ({ status: 422, body: { status: 0, err: { message: "invalid request" } } }) });
assert.equal((await http4xx.startSuspendedAuthorization(startInput)).result_class, "permanent_fail");
const http5xx = buildGrowPaymentAdapter({ config, transport: async () => ({ status: 503, body: { status: 0, err: "busy" } }) });
assert.equal((await http5xx.startSuspendedAuthorization(startInput)).result_class, "temporary_fail");
const malformed = buildGrowPaymentAdapter({ config, transport: async () => ({ status: 200, body: { status: 1, data: { processId: "missing-token" } } }) });
assert.equal((await malformed.startSuspendedAuthorization(startInput)).result_class, "unknown");
const reset = buildGrowPaymentAdapter({ config, transport: async () => { throw new Error("ECONNRESET"); } });
assert.equal((await reset.status(String(started.provider_reference))).state, "unknown");
assert.equal((await adapter.status("not-a-sealed-reference")).error_code, "grow_reference_invalid");

// --- sandbox/live separation is bidirectional and fail-closed ----------------
assert.throws(() => assertGrowConfig({ ...config, environment: "sandbox", base_url: "https://secure.meshulam.co.il/api/light/server/1.0" }), /grow_sandbox_environment_requires_sandbox_meshulam_base_url/);
assert.throws(() => assertGrowConfig({ ...config, environment: "live", base_url: "https://sandbox.meshulam.co.il/api/light/server/1.0" }), /grow_live_environment_cannot_use_sandbox_base_url/);
assertGrowConfig({ ...config, environment: "live", base_url: "https://secure.meshulam.co.il/api/light/server/1.0" });

// --- callback: hint only, correlated, replay-stable --------------------------
const callback = adapter.normalizeCallback({ processId: "12345", processToken: "process-secret", transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "11", sum: "123.45", cField1: "corr-grow-1" });
assert.equal(callback.valid, true);
assert.equal(callback.requires_authoritative_lookup, true);
assert.equal(callback.trusted_money_state, null);
assert.equal((callback as any).correlation_id, "corr-grow-1");
assert.equal((callback as any).reported_amount_minor, 12345);
const duplicateCallback = adapter.normalizeCallback({ processId: "12345", processToken: "process-secret", transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "11" });
assert.equal(duplicateCallback.event_id, callback.event_id);
const outOfOrderCallback = adapter.normalizeCallback({ processId: "12345", processToken: "process-secret", transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "2" });
assert.notEqual(outOfOrderCallback.event_id, callback.event_id);
assert.equal(adapter.normalizeCallback({ statusCode: "2" }).valid, false);

// --- redaction ----------------------------------------------------------------
const redacted = redactGrowLog({ userId: "secret-user", pageCode: "secret-page", processToken: "secret-token", payerPhone: "0500000000", nested: { apiKey: "secret-key", cardSuffix: "1121", safe: "kept" } }) as any;
assert.equal(redacted.userId, "[REDACTED]");
assert.equal(redacted.payerPhone, "[REDACTED]");
assert.equal(redacted.nested.apiKey, "[REDACTED]");
assert.equal(redacted.nested.cardSuffix, "[REDACTED]");
assert.equal(redacted.nested.safe, "kept");

// --- configuration summary reports capabilities honestly ---------------------
const summary = adapter.configurationSummary();
assert.equal(summary.sandbox, true);
assert.equal(summary.approve_transaction_policy, "never_sent_for_j4j5");
assert.equal(summary.release_strategy, "automatic_expiry_observed_via_status_reconciliation");
assert.equal(summary.native_void_endpoint, false);
assert.equal(summary.callback_native_authentication, "none_documented");
assert.equal(summary.settle_identifier, "transactionId+transactionToken");
assert.equal(summary.api_key_transmitted, false);

// --- environment separation at transport level -------------------------------
const productionRequests: GrowTransportRequest[] = [];
const productionConfig = { ...config, environment: "live", base_url: "https://secure.meshulam.co.il/api/light/server/1.0" };
const productionAdapter = buildGrowPaymentAdapter({ config: productionConfig, transport: async (request) => {
  productionRequests.push(request);
  return { status: 200, body: { status: 1, data: { processId: "prod-process", processToken: "prod-token", url: "https://secure.meshulam.co.il/payment" } } };
} });
await productionAdapter.startSuspendedAuthorization({ ...startInput, correlation_id: "corr-prod-contract" });
assert.equal(productionRequests[0]?.url.startsWith(productionConfig.base_url), true);
assert.equal(requests.every((request) => request.url.startsWith(config.base_url)), true);

console.log("PASS Grow J5 create uses the official chargeType=2 contract with server-only amounts and no apiKey");
console.log("PASS Grow status parses data.transactions[] and refreshes sealed references with transaction credentials");
console.log("PASS Grow J4 settle uses transactionId/transactionToken/userId/sum and resolves credentials read-only first");
console.log("PASS Grow refund/approve/release follow the official contract honestly (approve never sent, no invented void)");
console.log("PASS Grow callback stays a structurally-validated hint (correlated, replay-stable, never money truth)");
console.log("PASS Grow sandbox/live separation, sealed references, redaction and UNKNOWN transport are fail-closed");
