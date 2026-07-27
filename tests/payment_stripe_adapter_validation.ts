import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";

async function startStripeStub() {
  const calls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; form: URLSearchParams }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const call = { method: String(req.method || ""), url: String(req.url || ""), headers: req.headers, form };
      calls.push(call);
      res.setHeader("content-type", "application/json");
      if (call.url === "/v1/payment_intents") {
        assert.equal(call.method, "POST");
        assert.equal(call.headers.authorization, "Bearer sk_test_adapter");
        assert.equal(form.get("payment_method"), "pm_siton_adapter_1");
        assert.equal(form.get("capture_method"), "manual");
        assert.equal(form.get("confirm"), "true");
        assert.equal(form.get("amount"), "11800");
        res.end(JSON.stringify({
          id: "pi_siton_adapter_1",
          status: "requires_capture",
          metadata: { correlation_id: form.get("metadata[correlation_id]") }
        }));
        return;
      }
      if (call.url === "/v1/payment_intents/pi_siton_adapter_1/capture") {
        assert.equal(form.get("amount_to_capture"), "11800");
        res.end(JSON.stringify({
          id: "pi_siton_adapter_1",
          status: "succeeded",
          metadata: { correlation_id: form.get("metadata[correlation_id]") }
        }));
        return;
      }
      if (call.url === "/v1/refunds") {
        assert.equal(form.get("payment_intent"), "pi_siton_adapter_1");
        res.end(JSON.stringify({
          id: "re_siton_adapter_1",
          status: "succeeded",
          amount: 11800,
          currency: "ils",
          created: 1700000000,
          metadata: { correlation_id: form.get("metadata[correlation_id]") }
        }));
        return;
      }
      if (call.url === "/v1/payment_intents/pi_siton_adapter_1/cancel") {
        assert.equal(call.headers["idempotency-key"], "release-corr");
        assert.equal(form.get("cancellation_reason"), "abandoned");
        res.end(JSON.stringify({ id: "pi_siton_adapter_1", status: "canceled" }));
        return;
      }
      if (call.method === "GET" && call.url === "/v1/payment_intents/pi_siton_adapter_1") {
        res.end(JSON.stringify({ id: "pi_siton_adapter_1", status: "requires_capture", amount: 11800, currency: "ils", created: 1700000000, metadata: { correlation_id: "auth-corr" } }));
        return;
      }
      if (call.method === "GET" && call.url === "/v1/refunds/re_siton_adapter_1") {
        res.end(JSON.stringify({ id: "re_siton_adapter_1", status: "succeeded", amount: 11800, currency: "ils", created: 1700000000, metadata: { correlation_id: "refund-corr" } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `unexpected ${call.url}` } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stripe stub did not start");
  return {
    calls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

async function runTest(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}

await runTest("Stripe adapter requires hosted tokenization, authorizes manual capture, captures, refunds, verifies webhook and normalizes event", async () => {
  const stripe = await startStripeStub();
  try {
    Object.assign(process.env, {
      PAYMENT_PROVIDER: "stripe",
      PAYMENT_PROVIDER_MODE: "stripe",
      PAYMENT_PROVIDER_BASE_URL: stripe.baseUrl,
      PAYMENT_PROVIDER_API_KEY: "sk_test_adapter",
      PAYMENT_WEBHOOK_PROVIDER: "stripe",
      PAYMENT_WEBHOOK_SECRET: "whsec_adapter",
      STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION: "1",
      PAYMENT_PROVIDER_TIMEOUT_MS: "2500"
    });

    const { buildPaymentProvider, getPaymentProviderSummary } = await import(`../src/payment_provider.js?stripe-adapter-${Date.now()}`);
    const provider = buildPaymentProvider();
    const summary = getPaymentProviderSummary(provider);
    assert.equal(provider.providerCode, "stripe");
    assert.equal(summary.tokenization_transport_live, true);
    assert.equal(summary.authorization_transport_live, true);

    const tokenized = await provider.tokenize!({
      payer_name: "Siton Buyer",
      buyer_id: "buyer-stripe",
      deal_id: "deal-stripe",
      correlation_id: "tok-corr"
    });
    assert.equal(tokenized.ok, false);
    assert.equal(tokenized.ok ? "" : tokenized.error, "hosted_payment_required");

    const authorized = await provider.authorize({
      payer_name: "Siton Buyer",
      payment_method_id: "pm_siton_adapter_1",
      amount_minor: 11800,
      currency: "ILS",
      buyer_id: "buyer-stripe",
      deal_id: "deal-stripe",
      correlation_id: "auth-corr"
    });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.ok ? authorized.authorization_id : "", "pi_siton_adapter_1");

    const captured = await provider.capture({
      authorization_id: "pi_siton_adapter_1",
      amount_minor: 11800,
      currency: "ILS",
      participant_id: "participant-stripe",
      deal_id: "deal-stripe",
      buyer_id: "buyer-stripe",
      correlation_id: "capture-corr"
    });
    assert.equal(captured.result_class, "success");
    assert.equal(captured.reconciliation_event_type, "charge_captured");

    const refunded = await provider.refund({
      authorization_id: "pi_siton_adapter_1",
      amount_minor: 11800,
      currency: "ILS",
      participant_id: "participant-stripe",
      deal_id: "deal-stripe",
      buyer_id: "buyer-stripe",
      correlation_id: "refund-corr"
    });
    assert.equal(refunded.result_class, "success");
    assert.equal(refunded.reconciliation_event_type, "refund_issued");

    const authorizationStatus = await provider.status({ provider_reference: "pi_siton_adapter_1", operation: "authorization", correlation_id: "status-auth-corr" });
    assert.deepEqual({ state: authorizationStatus.state, amount: authorizationStatus.amount_minor, currency: authorizationStatus.currency, final: authorizationStatus.final }, { state: "authorized", amount: 11800, currency: "ILS", final: true });

    const refundStatus = await provider.status({ provider_reference: "re_siton_adapter_1", operation: "refund", correlation_id: "status-refund-corr" });
    assert.equal(refundStatus.state, "refunded");
    assert.equal(refundStatus.final, true);

    const released = await provider.release({ authorization_id: "pi_siton_adapter_1", amount_minor: 11800, currency: "ILS", correlation_id: "release-corr" });
    assert.equal(released.result_class, "success");
    assert.equal(released.retryable, false);

    const webhookBody = JSON.stringify({
      id: "evt_siton_adapter_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_siton_adapter_1",
          status: "succeeded",
          metadata: {
            correlation_id: "capture-corr",
            participant_id: "participant-stripe",
            deal_id: "deal-stripe"
          }
        }
      }
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "whsec_adapter").update(`${timestamp}.${webhookBody}`).digest("hex");
    assert.equal(provider.verifyWebhook!({
      rawBody: webhookBody,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      secret: "whsec_adapter"
    }), true);
    const normalized = provider.parseWebhookEvent!(JSON.parse(webhookBody));
    assert.equal(normalized?.event_type, "charge_captured");
    const releaseEvent = provider.parseWebhookEvent?.({ id: "evt_release", type: "payment_intent.canceled", data: { object: { id: "pi_siton_adapter_1", status: "canceled", metadata: { correlation_id: "release-corr" } } } });
    assert.equal(releaseEvent?.event_type, "payment_released");
    const refundFailureEvent = provider.parseWebhookEvent?.({ id: "evt_refund_failed", type: "refund.failed", data: { object: { id: "re_siton_adapter_1", status: "failed", metadata: { correlation_id: "refund-corr" } } } });
    assert.equal(refundFailureEvent?.event_type, "refund_failed");
    assert.notEqual(refundFailureEvent?.event_type, "charge_failed");
    assert.equal(normalized?.provider_reference, "pi_siton_adapter_1");
    assert.equal(normalized?.participant_id, "participant-stripe");
  } finally {
    await stripe.close();
  }
});
