import { strict as assert } from "node:assert";
import Fastify from "fastify";

function fakeWithTx() {
  return async <T>(_fn: (c: any) => Promise<T>): Promise<T> => {
    throw new Error("withTx should not be reached in payment authorization env validation");
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

await run("provider-ready without required env fails closed instead of silently using mock authorization", async () => {
  process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
  process.env.PAYMENT_PROVIDER = "payrail-http";
  process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
  process.env.PAYMENT_PROVIDER_BASE_URL = "";
  process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
  process.env.PAYMENT_PROVIDER_API_KEY = "";
  process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
  process.env.PAYMENT_WEBHOOK_SECRET = "live-webhook-secret";

  const { registerFrontendExperience } = await import(`../src/frontend_runtime.js?payment-env-guard-${Date.now()}`);
  const { buildPaymentProvider, getPaymentProviderSummary } = await import(
    `../src/payment_provider.js?payment-env-guard-${Date.now()}`
  );

  const paymentProvider = buildPaymentProvider();
  const summary = getPaymentProviderSummary(paymentProvider);
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx: fakeWithTx(),
    paymentProvider,
    deploymentMode: "internal-runtime",
    isDemoPreview: false,
    notificationSummary: {
      provider: "log-only",
      mode: "log-only",
      external_delivery: false
    },
    debugSurfacesEnabled: false
  });

  try {
    assert.equal(summary.authorization_transport_live, false);

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/authorize",
      payload: {
        holder_name: "Config Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123",
        amount_minor: 9900,
        currency: "ILS",
        buyer_id: "buyer-live-3"
      }
    });

    assert.equal(response.statusCode, 503);
    const payload = response.json() as any;
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "payment_provider_not_configured");
    assert.equal(payload.mock, false);
  } finally {
    await app.close();
  }
});

process.exit(0);
