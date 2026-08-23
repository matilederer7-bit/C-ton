import assert from "node:assert/strict";
import { buildGrowPaymentAdapter, openGrowReference, redactGrowLog, type GrowConfig, type GrowTransportRequest } from "../src/grow_payment_adapter.js";

const requests: GrowTransportRequest[] = [];
const key = "test-only-grow-reference-key-32-bytes-minimum";
const config: GrowConfig = {
  base_url: "https://sandbox.meshulam.co.il/api/light/server/1.0",
  user_id: "sandbox-user",
  page_code: "sandbox-page",
  api_key: "sandbox-api-key",
  reference_encryption_key: key,
  success_url: "https://example.invalid/pay/success",
  cancel_url: "https://example.invalid/pay/cancel",
  notify_url: "https://example.invalid/api/payments/grow/callback",
  timeout_ms: 1000,
  paths: { create: "/createPaymentProcess", process_info: "/getPaymentProcessInfo", settle: "/settleSuspendedTransaction", refund: "/refundTransaction", transaction_info: "/getTransactionInfo", approve: "/approveTransaction" }
};

let reply: any = { status: 1, err: "", data: { processId: "12345", processToken: "process-secret", url: "https://sandbox.meshulam.co.il/far?l=test" } };
const adapter = buildGrowPaymentAdapter({ config, transport: async (request) => { requests.push(request); return { status: 200, body: reply }; } });

const started = await adapter.startSuspendedAuthorization({ amount_minor: 12345, payer_name: "Israel Israeli", payer_phone: "0500000000", payer_email: "buyer@example.invalid", description: "Siton deal", correlation_id: "corr-grow-1" });
assert.equal(started.result_class, "success");
assert.equal(started.authorization_state, "pending_provider_confirmation");
assert.equal(requests.length, 1);
assert.equal(requests[0]?.url, `${config.base_url}/createPaymentProcess`);
assert.equal(requests[0]?.body.get("chargeType"), "2");
assert.equal(requests[0]?.body.get("sum"), "123.45");
assert.equal(requests[0]?.body.get("cField1"), "corr-grow-1");
assert.ok(!String(started.provider_reference).includes("process-secret"));
assert.deepEqual(openGrowReference(String(started.provider_reference), key), { process_id: "12345", process_token: "process-secret" });

reply = { status: 1, err: "", data: { status: "עסקה מושהית", statusCode: "11", sum: "123.45", processId: "12345", processToken: "process-secret", transactionId: "tx-1", transactionToken: "tx-secret" } };
const status = await adapter.status(String(started.provider_reference));
assert.equal(status.state, "authorized");
assert.equal(status.final, true);
assert.equal(status.amount_minor, 12345);

reply = { status: 1, err: "", data: { transactionId: "tx-1", transactionToken: "tx-secret" } };
const captured = await adapter.capture(String(status.provider_reference), 12345);
assert.equal(captured.result_class, "success");
assert.equal(requests.at(-1)?.body.get("sum"), "123.45");

const refunded = await adapter.refund(String(captured.provider_reference), 2345);
assert.equal(refunded.result_class, "success");
assert.equal(requests.at(-1)?.body.get("refundSum"), "23.45");

const unknownAdapter = buildGrowPaymentAdapter({ config, transport: async () => { throw new Error("timeout"); } });
const unknown = await unknownAdapter.startSuspendedAuthorization({ amount_minor: 100, payer_name: "Test Buyer", payer_phone: "0500000000", description: "Deal", correlation_id: "corr-timeout" });
assert.equal(unknown.result_class, "unknown");
assert.equal(unknown.retryable, true);

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

const callback = adapter.normalizeCallback({ processId: "12345", processToken: "process-secret", transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "11" });
assert.equal(callback.valid, true);
assert.equal(callback.requires_authoritative_lookup, true);
assert.equal(callback.trusted_money_state, null);
const duplicateCallback = adapter.normalizeCallback({ processId: "12345", processToken: "process-secret", transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "11" });
assert.equal(duplicateCallback.event_id, callback.event_id);
const outOfOrderCallback = adapter.normalizeCallback({ processId: "12345", processToken: "process-secret", transactionId: "tx-1", transactionToken: "tx-secret", statusCode: "2" });
assert.notEqual(outOfOrderCallback.event_id, callback.event_id);
assert.equal(adapter.normalizeCallback({ statusCode: "2" }).valid, false);

const redacted = redactGrowLog({ userId: "secret-user", pageCode: "secret-page", processToken: "secret-token", nested: { apiKey: "secret-key", safe: "kept" } }) as any;
assert.equal(redacted.userId, "[REDACTED]");
assert.equal(redacted.nested.apiKey, "[REDACTED]");
assert.equal(redacted.nested.safe, "kept");

const productionRequests: GrowTransportRequest[] = [];
const productionConfig = { ...config, base_url: "https://secure.meshulam.co.il/api/light/server/1.0" };
const productionAdapter = buildGrowPaymentAdapter({ config: productionConfig, transport: async (request) => {
  productionRequests.push(request);
  return { status: 200, body: { status: 1, data: { processId: "prod-process", processToken: "prod-token", url: "https://secure.meshulam.co.il/payment" } } };
} });
await productionAdapter.startSuspendedAuthorization({ ...startInput, correlation_id: "corr-prod-contract" });
assert.equal(productionRequests[0]?.url.startsWith(productionConfig.base_url), true);
assert.equal(requests.every((request) => request.url.startsWith(config.base_url)), true);

console.log("PASS Grow J4/J5 adapter uses server-side form transport and pending authorization semantics");
console.log("PASS Grow provider references are AES-GCM sealed before leaving the server boundary");
console.log("PASS Grow timeout remains UNKNOWN and configuration fails closed");
console.log("PASS Grow contract covers malformed/4xx/5xx/reset, callback replay/order, lookup, redaction and environment separation without network");
