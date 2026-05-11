import { strict as assert } from "node:assert";
import http from "node:http";
import Fastify from "fastify";

function fakeWithTx() {
  return async <T>(_fn: (c: any) => Promise<T>): Promise<T> => {
    throw new Error("withTx should not be reached in payment authorization validation");
  };
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function startProviderStub(
  handler: (args: {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: any;
  }) => { statusCode?: number; body?: Record<string, unknown> | string }
) {
  const calls: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: any;
  }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      const call = {
        method: String(req.method || ""),
        url: String(req.url || ""),
        headers: req.headers,
        body
      };
      calls.push(call);
      const response = handler(call);
      const statusCode = Number(response.statusCode || 200);
      const payload = typeof response.body === "string" ? response.body : JSON.stringify(response.body || {});
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json");
      res.end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("provider stub did not expose a TCP port");
  }

  return {
    server,
    calls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

async function buildRuntimeApp(tag: string, env: Record<string, string>) {
  for (const key of [
    "APP_DEPLOYMENT_MODE",
    "PAYMENT_PROVIDER",
    "PAYMENT_PROVIDER_MODE",
    "PAYMENT_PROVIDER_BASE_URL",
    "PAYMENT_PROVIDER_AUTH_PATH",
    "PAYMENT_PROVIDER_API_KEY",
    "PAYMENT_PROVIDER_PUBLIC_KEY",
    "PAYMENT_PROVIDER_TIMEOUT_MS",
    "PAYMENT_WEBHOOK_PROVIDER",
    "PAYMENT_WEBHOOK_SECRET"
  ]) {
    if (env[key] === undefined) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);

  const { registerFrontendExperience } = await import(`../src/frontend_runtime.js?payment-runtime-${tag}-${Date.now()}`);
  const { buildPaymentProvider, getPaymentProviderSummary } = await import(
    `../src/payment_provider.js?payment-provider-${tag}-${Date.now()}`
  );

  const paymentProvider = buildPaymentProvider();
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx: fakeWithTx(),
    paymentProvider,
    deploymentMode: env.APP_DEPLOYMENT_MODE || "internal-runtime",
    isDemoPreview: (env.APP_DEPLOYMENT_MODE || "internal-runtime") === "demo-preview",
    notificationSummary: {
      provider: "log-only",
      mode: "log-only",
      external_delivery: false
    },
    debugSurfacesEnabled: false
  });

  return {
    app,
    paymentProvider,
    summary: getPaymentProviderSummary(paymentProvider)
  };
}

await run("non-demo authorization hits the real provider transport and legacy alias stays on the same hardened path", async () => {
  const provider = await startProviderStub(({ method, url, headers, body }) => {
    assert.equal(method, "POST");
    assert.equal(url, "/authorize");
    assert.equal(headers.authorization, "Bearer live-provider-key");
    assert.ok(headers["idempotency-key"]);
    assert.equal(body.capture, false);
    if (body.payment_method.card.holder_name === "Live Buyer") {
      assert.equal(body.amount_minor, 14100);
      assert.equal(body.currency, "ILS");
      assert.equal(body.buyer_id, "buyer-live-1");
      return {
        statusCode: 200,
        body: {
          authorization_id: "prov_auth_live_123",
          provider_reference: "prov_auth_live_123",
          correlation_id: body.reference,
          hold_message: "Live provider accepted authorization hold."
        }
      };
    }
    return {
      statusCode: 402,
      body: {
        error: "card_declined",
        message: `provider declined ${body.reference}`
      }
    };
  });

  const { app, summary } = await buildRuntimeApp("real-success", {
    APP_DEPLOYMENT_MODE: "internal-runtime",
    PAYMENT_PROVIDER: "payrail-http",
    PAYMENT_PROVIDER_MODE: "provider-ready",
    PAYMENT_PROVIDER_BASE_URL: provider.baseUrl,
    PAYMENT_PROVIDER_AUTH_PATH: "/authorize",
    PAYMENT_PROVIDER_API_KEY: "live-provider-key",
    PAYMENT_PROVIDER_TIMEOUT_MS: "2500",
    PAYMENT_WEBHOOK_PROVIDER: "payrail-http",
    PAYMENT_WEBHOOK_SECRET: "live-webhook-secret"
  });

  try {
    assert.equal(summary.authorization_transport_live, true);

    const successResponse = await app.inject({
      method: "POST",
      url: "/api/payments/authorize",
      headers: {
        "x-request-id": "payment-real-success"
      },
      payload: {
        holder_name: "Live Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123",
        amount_minor: 14100,
        currency: "ILS",
        buyer_id: "buyer-live-1"
      }
    });

    assert.equal(successResponse.statusCode, 200);
    const successPayload = successResponse.json() as any;
    assert.equal(successPayload.ok, true);
    assert.equal(successPayload.mock, false);
    assert.equal(successPayload.provider, "payrail-http");
    assert.equal(successPayload.authorization_id, "prov_auth_live_123");
    assert.equal(successPayload.provider_reference, "prov_auth_live_123");
    assert.match(String(successPayload.correlation_id || ""), /^payauth_/);
    const aliasResponse = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Declined Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123",
        amount_minor: 4200,
        currency: "ILS",
        buyer_id: "buyer-live-2"
      }
    });

    assert.equal(aliasResponse.statusCode, 402);
    const aliasPayload = aliasResponse.json() as any;
    assert.equal(aliasPayload.ok, false);
    assert.equal(aliasPayload.error, "card_declined");
    assert.equal(aliasPayload.mock, false);
    assert.equal(provider.calls.length, 2);
  } finally {
    await app.close();
    await provider.close();
  }
});

process.exit(0);
