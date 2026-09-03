import assert from "node:assert/strict";
import type { GrowConfig, GrowTransportRequest } from "../src/grow_payment_adapter.js";

// R9C — Grow ambiguity policy (Codex H1 + C2 at the adapter boundary).
//
// Verified against the adapter source, not assumed:
//   * settleSuspendedTransaction / refundTransaction transmit NO Siton operation
//     key (no idempotency-key header, no cField1) → repeat idempotency UNPROVEN
//   * a non-2xx or transport failure AFTER the settle/refund request left the
//     process is UNKNOWN (dispatched: true) — never a retryable temporary_fail
//   * failures BEFORE dispatch (read-only lookup, missing transaction
//     credentials) are declared pre-dispatch (dispatched: false)
//   * the canonical Grow provider fails closed: same_identity_repeat_safe=false,
//     negative_status_authoritative=false
// No network, no real Grow call, no money.

process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "grow";
process.env.PAYMENT_PROVIDER_MODE = "grow";
process.env.PAYMENT_ENVIRONMENT = "sandbox";
process.env.PAYMENT_PROVIDER_BASE_URL = "https://sandbox.meshulam.co.il/api/light/server/1.0";
process.env.GROW_USER_ID = "grow-sandbox-user";
process.env.GROW_PAGE_CODE = "grow-sandbox-page";
process.env.GROW_REFERENCE_ENCRYPTION_KEY = "grow-sandbox-reference-encryption-key-48-characters!";
process.env.GROW_SUCCESS_URL = "https://siton-staging.example.invalid/pay/success";
process.env.GROW_CANCEL_URL = "https://siton-staging.example.invalid/pay/cancel";
process.env.GROW_NOTIFY_URL = "https://siton-staging.example.invalid/webhooks/payments/grow";

// Import AFTER the environment is set: runtime configuration is captured at
// module load (static imports would be hoisted above the assignments).
const { buildGrowPaymentAdapter, sealGrowReference } = await import("../src/grow_payment_adapter.js");

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
const confirmedReference = sealGrowReference({ process_id: "p-1", process_token: "ptoken-1", transaction_id: "tx-1", transaction_token: "tx-token-1" }, key);
const processOnlyReference = sealGrowReference({ process_id: "p-2", process_token: "ptoken-2" }, key);

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => { passed += 1; console.log(`PASS ${name}`); }, (error) => { console.error(`FAIL ${name}`); throw error; });
}

function adapterWith(handler: (request: GrowTransportRequest) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }) {
  const requests: GrowTransportRequest[] = [];
  const adapter = buildGrowPaymentAdapter({ config, transport: async (request) => { requests.push(request); return handler(request); } });
  return { adapter, requests };
}

await check("settle answered HTTP 503 / 429 / 500 AFTER dispatch → UNKNOWN (dispatched), exactly one request per call, never temporary_fail", async () => {
  for (const status of [503, 429, 500, 502, 504, 408]) {
    const { adapter, requests } = adapterWith(() => ({ status, body: { status: 0, err: `after_dispatch_${status}` } }));
    const result = await adapter.capture(confirmedReference, 12345);
    assert.equal(result.result_class, "unknown", `HTTP ${status} after a settle request is not proof of non-execution`);
    assert.equal(result.dispatched, true);
    assert.equal(result.retryable, false);
    assert.equal(result.error_code, `grow_settle_http_${status}_ambiguous`);
    assert.equal(requests.length, 1, "the adapter itself never repeats the settle");
    assert.equal(requests[0]!.url.endsWith("/settleSuspendedTransaction"), true);
  }
});

await check("settle transport loss AFTER dispatch → UNKNOWN (dispatched)", async () => {
  const { adapter, requests } = adapterWith(() => { throw new Error("socket hang up"); });
  const result = await adapter.capture(confirmedReference, 12345);
  assert.equal(result.result_class, "unknown");
  assert.equal(result.dispatched, true);
  assert.equal(result.error_code, "grow_capture_transport_unknown");
  assert.equal(requests.length, 1);
});

await check("settle explicitly rejected by Grow (status:0) → provider-declared permanent_fail (dispatched)", async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: { status: 0, err: { id: 400, message: "settle rejected" } } }));
  const result = await adapter.capture(confirmedReference, 12345);
  assert.equal(result.result_class, "permanent_fail");
  assert.equal(result.dispatched, true);
});

await check("settle success → success (dispatched)", async () => {
  const { adapter } = adapterWith(() => ({ status: 200, body: { status: 1, err: "", data: { transactionId: "tx-1", transactionToken: "tx-token-1" } } }));
  const result = await adapter.capture(confirmedReference, 12345);
  assert.equal(result.result_class, "success");
  assert.equal(result.dispatched, true);
});

await check("failures BEFORE the settle request exists are declared pre-dispatch (dispatched: false): lookup transport loss, lookup without transaction credentials", async () => {
  const lookupDown = adapterWith((request) => { if (request.url.endsWith("/getPaymentProcessInfo")) throw new Error("lookup unreachable"); throw new Error("must not settle"); });
  const down = await lookupDown.adapter.capture(processOnlyReference, 5000);
  assert.equal(down.result_class, "temporary_fail");
  assert.equal(down.dispatched, false, "no settle request was ever built");
  assert.equal(lookupDown.requests.every((request) => !request.url.endsWith("/settleSuspendedTransaction")), true);

  const noTx = adapterWith((request) => { if (request.url.endsWith("/getPaymentProcessInfo")) return { status: 200, body: { status: 1, data: { transactions: [] } } }; throw new Error("must not settle"); });
  const missing = await noTx.adapter.capture(processOnlyReference, 5000);
  assert.equal(missing.result_class, "temporary_fail");
  assert.equal(missing.dispatched, false);
  assert.equal(missing.error_code, "grow_capture_transaction_reference_missing");
});

await check("refund answered HTTP 503 / 429 or lost AFTER dispatch → UNKNOWN (dispatched); missing transaction credentials → permanent_fail pre-dispatch", async () => {
  for (const status of [503, 429]) {
    const { adapter, requests } = adapterWith(() => ({ status, body: { status: 0, err: `after_dispatch_${status}` } }));
    const result = await adapter.refund(confirmedReference, 2345);
    assert.equal(result.result_class, "unknown");
    assert.equal(result.dispatched, true);
    assert.equal(result.error_code, `grow_refund_http_${status}_ambiguous`);
    assert.equal(requests.length, 1);
  }
  const lost = adapterWith(() => { throw new Error("reset"); });
  const lostResult = await lost.adapter.refund(confirmedReference, 2345);
  assert.equal(lostResult.result_class, "unknown");
  assert.equal(lostResult.dispatched, true);
  const noTx = adapterWith(() => { throw new Error("must not refund"); });
  const missing = await noTx.adapter.refund(processOnlyReference, 100);
  assert.equal(missing.result_class, "permanent_fail");
  assert.equal(missing.dispatched, false);
  assert.equal(noTx.requests.length, 0);
});

await check("H1 evidence: settle/refund transmit NO Siton operation identity (no idempotency-key header, no cField1) — repeat semantics UNPROVEN", async () => {
  const { adapter, requests } = adapterWith(() => ({ status: 200, body: { status: 1, err: "", data: {} } }));
  await adapter.capture(confirmedReference, 12345);
  await adapter.refund(confirmedReference, 2345);
  const settle = requests.find((request) => request.url.endsWith("/settleSuspendedTransaction"))!;
  const refund = requests.find((request) => request.url.endsWith("/refundTransaction"))!;
  assert.deepEqual([...settle.body.keys()].sort(), ["sum", "transactionId", "transactionToken", "userId"]);
  assert.deepEqual([...refund.body.keys()].sort(), ["pageCode", "refundSum", "transactionId", "transactionToken", "userId"]);
  for (const request of [settle, refund]) {
    assert.equal(Object.keys(request.headers).map((header) => header.toLowerCase()).includes("idempotency-key"), false);
    assert.equal(request.body.has("cField1"), false);
  }
  const summary = adapter.configurationSummary() as Record<string, unknown>;
  assert.equal(summary.operation_idempotency_key_transmitted, false);
  assert.equal(summary.repeat_settle_idempotent, "unproven");
  assert.equal(summary.repeat_refund_idempotent, "unproven");
  assert.equal(summary.ambiguous_settle_or_refund_policy, "unknown_then_status_lookup_then_manual_case_no_automatic_repeat");
});

await check("canonical Grow provider fails closed: ambiguityPolicy both false; a 503 settle surfaces as UNKNOWN with no reconciliation event; providers without a policy default to fail-closed", async () => {
  const { buildGrowCanonicalPaymentProvider, providerAmbiguityPolicy, FAIL_CLOSED_AMBIGUITY_POLICY } = await import(`../src/payment_provider.js?grow-policy-${Date.now()}`);
  const provider = buildGrowCanonicalPaymentProvider();
  assert.deepEqual(
    { same: provider.ambiguityPolicy?.same_identity_repeat_safe, negative: provider.ambiguityPolicy?.negative_status_authoritative },
    { same: false, negative: false }
  );
  assert.equal(providerAmbiguityPolicy(provider).same_identity_repeat_safe, false);
  assert.equal(providerAmbiguityPolicy({}).same_identity_repeat_safe, false, "absent policy = fail closed");
  assert.deepEqual(providerAmbiguityPolicy({}), FAIL_CLOSED_AMBIGUITY_POLICY);
  const envKey = String(process.env.GROW_REFERENCE_ENCRYPTION_KEY);
  const reference = sealGrowReference({ process_id: "p-9", process_token: "ptoken-9", transaction_id: "tx-9", transaction_token: "tx-token-9" }, envKey);
  let settleRequests = 0;
  (globalThis as Record<string, unknown>).__SITON_GROW_TEST_TRANSPORT__ = async (request: GrowTransportRequest) => {
    if (request.url.endsWith("/settleSuspendedTransaction")) { settleRequests += 1; return { status: 503, body: { status: 0, err: "busy" } }; }
    return { status: 200, body: { status: 1, err: "", data: {} } };
  };
  try {
    const captured = await provider.capture({ authorization_id: reference, amount_minor: 1000, currency: "ILS", correlation_id: "corr-policy-1" });
    assert.equal(captured.result_class, "unknown");
    assert.equal(captured.dispatched, true);
    assert.equal(captured.reconciliation_event_type, null);
    assert.equal(captured.retryable, false);
    assert.equal(settleRequests, 1);
    const refunded = await provider.refund({ capture_reference: reference, amount_minor: 1000, currency: "ILS", correlation_id: "corr-policy-2" });
    assert.equal(refunded.result_class, "success", "refund transport ok → declared success");
    assert.equal(refunded.dispatched, true);
  } finally {
    delete (globalThis as Record<string, unknown>).__SITON_GROW_TEST_TRANSPORT__;
  }
});

await check("provider-ready and mock providers declare their (contract-backed) policies explicitly", async () => {
  const mod = await import(`../src/payment_provider.js?policy-summary-${Date.now()}`);
  const provider = mod.buildGrowCanonicalPaymentProvider();
  const summary = mod.getPaymentProviderSummary(provider) as Record<string, any>;
  assert.equal(summary.ambiguity_policy.same_identity_repeat_safe, false);
  assert.equal(summary.operation_lifecycle.post_dispatch_non_success_without_declared_outcome, "unknown");
  assert.deepEqual(summary.operation_lifecycle.durable_states, ["recorded", "dispatching", "responded"]);
});

console.log(`PAYMENT_GROW_AMBIGUITY_POLICY_VALIDATION passed=${passed}`);
