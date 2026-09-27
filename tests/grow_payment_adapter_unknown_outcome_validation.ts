import assert from "node:assert/strict";
import { buildGrowPaymentAdapter, sealGrowReference, type GrowConfig, type GrowTransportRequest } from "../src/grow_payment_adapter.js";

// FINANCIAL FAIL-CLOSED REGRESSION — malformed 2xx replies and
// auth/routing HTTP errors are UNKNOWN, never an invented failure.
//
// Binding rule: the financial layer prefers uncertainty + manual recovery over
// invented financial truth. A provider reply that cannot be read (non-JSON
// body, JSON without a parseable `status` field) or an auth/routing answer
// (HTTP 401/403/404/407) proves NOTHING about the money: the settle/refund may
// have executed, the transaction may be alive.
//
// BEFORE this fix (verified with a probe against the previous adapter,
// base commit d186153): a malformed 2xx yielded `permanent_fail` for
// capture/refund (dispatched:true → a fabricated charge_failed verdict) and
// `state:"failed", final:true` for status(), because growSucceeded() only
// checked status==="1"; HTTP 401/403/404/407 on the lookup yielded
// `state:"failed", final:true` because classifyHttp() mapped them to
// permanent_fail (settle/refund already mapped every non-2xx to unknown; the
// configuration-fault tag is new). Explicit provider declines (valid JSON, status 0) are still
// declared failures — asserted at the end so the fix cannot over-correct.
//
// No network, no real Grow call, no money: in-process stub transport only.

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
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

function adapterWith(reply: { status: number; body: unknown }) {
  const requests: GrowTransportRequest[] = [];
  const adapter = buildGrowPaymentAdapter({ config, transport: async (request) => { requests.push(request); return reply; } });
  return { adapter, requests };
}

// What the default fetch transport produces for each malformed-but-2xx body,
// plus shapes a stub/proxy may hand back directly.
const MALFORMED_2XX: Array<[string, unknown]> = [
  ["non-JSON HTML body (fetch transport wraps it as raw_body)", { raw_body: "<html>502 Bad Gateway</html>" }],
  ["empty body (fetch transport yields {})", {}],
  ["JSON null", null],
  ["JSON string", "ok"],
  ["JSON array", [{ status: 1 }]],
  ["JSON object without status", { err: "", data: { transactionId: "tx-1" } }],
  ["status field of an unrecognized value", { status: "maybe", data: {} }],
  ["status field boolean", { status: true, data: {} }],
  ["status field nested object", { status: { code: 1 }, data: {} }]
];
const CONFIG_FAULT_HTTP = [401, 403, 404, 407];

await check("capture (J4 settle) with a malformed 2xx body → UNKNOWN (dispatched, non-retryable), never permanent_fail", async () => {
  for (const [label, body] of MALFORMED_2XX) {
    const { adapter, requests } = adapterWith({ status: 200, body });
    const result = await adapter.capture(confirmedReference, 12345);
    assert.equal(result.result_class, "unknown", label);
    assert.equal(result.dispatched, true, label);
    assert.equal(result.retryable, false, label);
    assert.equal(result.error_code, "grow_settle_response_malformed", label);
    assert.equal(requests.length, 1, "exactly one settle request, never repeated by the adapter");
  }
});

await check("refund with a malformed 2xx body → UNKNOWN (dispatched, non-retryable), never permanent_fail", async () => {
  for (const [label, body] of MALFORMED_2XX) {
    const { adapter } = adapterWith({ status: 200, body });
    const result = await adapter.refund(confirmedReference, 2345);
    assert.equal(result.result_class, "unknown", label);
    assert.equal(result.dispatched, true, label);
    assert.equal(result.retryable, false, label);
    assert.equal(result.error_code, "grow_refund_response_malformed", label);
  }
});

await check("status() with a malformed 2xx lookup body → state unknown, final:false (was failed/final)", async () => {
  for (const [label, body] of MALFORMED_2XX) {
    const { adapter } = adapterWith({ status: 200, body });
    const result = await adapter.status(confirmedReference);
    assert.equal(result.state, "unknown", label);
    assert.equal(result.final, false, label);
    assert.equal(result.result_class, "unknown", label);
    assert.equal(result.error_code, "grow_status_response_malformed", label);
  }
});

await check("HTTP 401/403/404/407 on settle and refund → UNKNOWN tagged as configuration fault", async () => {
  for (const status of CONFIG_FAULT_HTTP) {
    const settle = await adapterWith({ status, body: { status: 0, err: "denied" } }).adapter.capture(confirmedReference, 12345);
    assert.equal(settle.result_class, "unknown", `settle HTTP ${status}`);
    assert.equal(settle.dispatched, true);
    assert.equal(settle.retryable, false);
    assert.equal((settle as any).configuration_fault, true, `settle HTTP ${status}`);
    const refund = await adapterWith({ status, body: { raw_body: "Forbidden" } }).adapter.refund(confirmedReference, 2345);
    assert.equal(refund.result_class, "unknown", `refund HTTP ${status}`);
    assert.equal(refund.dispatched, true);
    assert.equal((refund as any).configuration_fault, true, `refund HTTP ${status}`);
  }
});

await check("HTTP 401/403/404/407 on the authoritative lookup → status() unknown, final:false, configuration fault (was failed/final)", async () => {
  for (const status of CONFIG_FAULT_HTTP) {
    for (const reference of [confirmedReference, processOnlyReference]) {
      const result = await adapterWith({ status, body: { status: 0, err: "not found" } }).adapter.status(reference);
      assert.equal(result.state, "unknown", `lookup HTTP ${status}`);
      assert.equal(result.final, false, `lookup HTTP ${status}`);
      assert.equal(result.result_class, "unknown", `lookup HTTP ${status}`);
      assert.equal((result as any).configuration_fault, true);
      assert.equal(result.error_code, `grow_status_http_${status}_configuration_fault`);
    }
  }
});

await check("other non-2xx lookup answers (400/422) never become a final 'failed' money state", async () => {
  for (const status of [400, 422]) {
    const result = await adapterWith({ status, body: { status: 0, err: "bad request" } }).adapter.status(confirmedReference);
    assert.equal(result.state, "unknown", `lookup HTTP ${status}`);
    assert.equal(result.final, false, `lookup HTTP ${status}`);
  }
});

await check("capture pre-dispatch lookup that is malformed or 401/403/404/407 → no settle sent, bounded pre-dispatch retry, never charge failure", async () => {
  for (const reply of [{ status: 200, body: { raw_body: "garbage" } as unknown }, ...CONFIG_FAULT_HTTP.map((status) => ({ status, body: { status: 0, err: "x" } as unknown }))]) {
    const { adapter, requests } = adapterWith(reply);
    const result = await adapter.capture(processOnlyReference, 5000);
    assert.equal(result.result_class, "temporary_fail", JSON.stringify(reply));
    assert.equal(result.dispatched, false);
    assert.equal(requests.some((request) => request.url.endsWith("/settleSuspendedTransaction")), false, "must not settle without an authoritative lookup");
  }
});

await check("observeRelease with a malformed lookup or 401/403/404/407 → unknown, never released", async () => {
  for (const reply of [{ status: 200, body: { raw_body: "garbage" } as unknown }, ...CONFIG_FAULT_HTTP.map((status) => ({ status, body: {} as unknown }))]) {
    const result = await adapterWith(reply).adapter.observeRelease(confirmedReference);
    assert.equal(result.result_class, "unknown", JSON.stringify(reply));
    assert.equal(result.released, false);
  }
});

await check("J5 create with a malformed 2xx or 401/403/404/407 → UNKNOWN non-retryable (a process may exist); 422 stays a declared rejection", async () => {
  const input = { amount_minor: 100, payer_name: "Test Buyer", payer_phone: "0500000000", description: "Deal", correlation_id: "corr-malformed" };
  for (const [label, body] of MALFORMED_2XX) {
    const result = await adapterWith({ status: 200, body }).adapter.startSuspendedAuthorization(input);
    assert.equal(result.result_class, "unknown", label);
    assert.equal(result.retryable, false, label);
  }
  for (const status of CONFIG_FAULT_HTTP) {
    const result = await adapterWith({ status, body: { status: 0, err: "denied" } }).adapter.startSuspendedAuthorization(input);
    assert.equal(result.result_class, "unknown", `create HTTP ${status}`);
    assert.equal(result.retryable, false);
    assert.equal((result as any).configuration_fault, true);
  }
  const rejected = await adapterWith({ status: 422, body: { status: 0, err: { message: "invalid" } } }).adapter.startSuspendedAuthorization(input);
  assert.equal(rejected.result_class, "permanent_fail");
});

await check("explicit provider declines (valid JSON, status 0 / \"0\") are still declared failures — no over-correction", async () => {
  for (const status of [0, "0"]) {
    const body = { status, err: { id: 400, message: "settle rejected" }, data: "" };
    const settle = await adapterWith({ status: 200, body }).adapter.capture(confirmedReference, 12345);
    assert.equal(settle.result_class, "permanent_fail");
    assert.equal(settle.dispatched, true);
    const refund = await adapterWith({ status: 200, body }).adapter.refund(confirmedReference, 2345);
    assert.equal(refund.result_class, "permanent_fail");
    const looked = await adapterWith({ status: 200, body }).adapter.status(confirmedReference);
    assert.equal(looked.state, "failed");
    assert.equal(looked.final, true);
  }
  // A genuine success with a string status is still a success.
  const ok = await adapterWith({ status: 200, body: { status: "1", err: "", data: {} } }).adapter.capture(confirmedReference, 12345);
  assert.equal(ok.result_class, "success");
});

console.log(`GROW_PAYMENT_ADAPTER_UNKNOWN_OUTCOME_VALIDATION passed=${passed}`);
