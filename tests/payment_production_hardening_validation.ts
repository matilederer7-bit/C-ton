import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 2
});

const withTx = async <T>(fn: (c: any) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

async function runTest(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}

await runTest("production Stripe config fails fast and blocks server-side raw card tokenization", async () => {
  Object.assign(process.env, {
    APP_DEPLOYMENT_MODE: "production",
    PAYMENT_PROVIDER: "stripe",
    PAYMENT_PROVIDER_MODE: "stripe",
    PAYMENT_PROVIDER_API_KEY: "sk_live_required",
    PAYMENT_PROVIDER_PUBLIC_KEY: "pk_live_required",
    PAYMENT_WEBHOOK_SECRET: "whsec_required",
    STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION: "0"
  });
  const { buildPaymentProvider } = await import(`../src/payment_provider.js?prod-hardening-${Date.now()}`);
  const provider = buildPaymentProvider();
  const result = await provider.authorize({
    holder_name: "No Raw PAN",
    card_number: "4242424242424242",
    expiry: "12/30",
    cvv: "123",
    amount_minor: 1000,
    currency: "ILS"
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, "payment_method_required");
});

await runTest("raw-body Stripe webhook verifies, dedupes, persists, and records signature failures", async () => {
  Object.assign(process.env, {
    APP_DEPLOYMENT_MODE: "production",
    PAYMENT_PROVIDER: "stripe",
    PAYMENT_PROVIDER_MODE: "stripe",
    PAYMENT_PROVIDER_API_KEY: "sk_live_required",
    PAYMENT_PROVIDER_PUBLIC_KEY: "pk_live_required",
    PAYMENT_WEBHOOK_PROVIDER: "stripe",
    PAYMENT_WEBHOOK_SECRET: "whsec_required",
    STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION: "0"
  });

  const [{ registerFrontendExperience }, { buildPaymentProvider }] = await Promise.all([
    import(`../src/frontend_runtime.js?raw-body-${Date.now()}`),
    import(`../src/payment_provider.js?raw-body-provider-${Date.now()}`)
  ]);
  const paymentProvider = buildPaymentProvider();
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx,
    paymentProvider,
    deploymentMode: "production",
    isDemoPreview: false,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false },
    debugSurfacesEnabled: false,
    applyPaymentWebhookClassification: async () => undefined
  });

  const body = JSON.stringify({
    id: `evt_raw_${Date.now()}`,
    type: "payment_intent.amount_capturable_updated",
    data: {
      object: {
        id: "pi_raw_body",
        status: "requires_capture",
        metadata: {
          correlation_id: "raw-body-correlation"
        }
      }
    }
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "whsec_required").update(`${timestamp}.${body}`).digest("hex");

  try {
    const ok = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`
      },
      payload: body
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const okJson = ok.json() as any;
    assert.equal(okJson.ok, true);
    assert.equal(okJson.status, "processed");

    const duplicate = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`
      },
      payload: body
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal((duplicate.json() as any).duplicate, true);

    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=bad`
      },
      payload: body
    });
    assert.equal(bad.statusCode, 401);

    const persisted = await pool.query(
      `SELECT status, payload_jsonb
       FROM siton.webhook_events
       WHERE provider='stripe'
         AND event_id=$1`,
      [(okJson.event_id)]
    );
    assert.equal(persisted.rowCount, 1);
    assert.equal(persisted.rows[0].status, "processed");

    const failures = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM siton.payment_webhook_security_events
       WHERE failure_reason='invalid_webhook_signature'
         AND event_id=$1`,
      [okJson.event_id]
    );
    assert.ok(Number(failures.rows[0].cnt) >= 1);
  } finally {
    await pool.query(`DELETE FROM siton.payment_webhook_security_events WHERE event_id LIKE 'evt_raw_%'`);
    await pool.query(`DELETE FROM siton.webhook_events WHERE provider='stripe' AND event_id LIKE 'evt_raw_%'`);
    await app.close();
  }
});

await pool.end();
