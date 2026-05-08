import assert from "node:assert/strict";
import Fastify from "fastify";
import pg from "pg";

import { buildInvoiceProvider, getInvoiceProviderSummary } from "../src/invoice_dispatch.js";
import { registerFrontendExperience } from "../src/frontend_runtime.js";

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

await runTest("Morning adapter fails fast when critical real-mode env is missing", async () => {
  assert.throws(
    () =>
      buildInvoiceProvider({
        APP_DEPLOYMENT_MODE: "production",
        INVOICE_PROVIDER: "morning",
        INVOICE_PROVIDER_MODE: "real",
        INVOICE_PROVIDER_BASE_URL: "https://api.greeninvoice.co.il/api/v1",
        INVOICE_PROVIDER_BEARER_TOKEN: "token"
      } as NodeJS.ProcessEnv),
    /INVOICE_WEBHOOK_SECRET/
  );
});

await runTest("Invoice admin observability surfaces Morning activation and webhook metrics", async () => {
  const previousEnv = {
    APP_DEPLOYMENT_MODE: process.env.APP_DEPLOYMENT_MODE,
    INVOICE_PROVIDER: process.env.INVOICE_PROVIDER,
    INVOICE_PROVIDER_MODE: process.env.INVOICE_PROVIDER_MODE,
    INVOICE_PROVIDER_BASE_URL: process.env.INVOICE_PROVIDER_BASE_URL,
    INVOICE_PROVIDER_BEARER_TOKEN: process.env.INVOICE_PROVIDER_BEARER_TOKEN,
    INVOICE_WEBHOOK_SECRET: process.env.INVOICE_WEBHOOK_SECRET
  };
  const env = {
    ...process.env,
    APP_DEPLOYMENT_MODE: "production",
    INVOICE_PROVIDER: "morning",
    INVOICE_PROVIDER_MODE: "real",
    INVOICE_PROVIDER_BASE_URL: "https://api.greeninvoice.co.il/api/v1",
    INVOICE_PROVIDER_BEARER_TOKEN: "token",
    INVOICE_WEBHOOK_SECRET: "whsec_invoice"
  };
  Object.assign(process.env, env);
  const invoiceProvider = buildInvoiceProvider(env);
  const app = Fastify({ logger: false });
  registerFrontendExperience(app, {
    withTx,
    paymentProvider: {
      providerCode: "mockpay",
      mode: "mock-backed",
      webhookProvider: "mockpay",
      configured: true
    } as any,
    invoiceProvider,
    invoiceSummary: getInvoiceProviderSummary(invoiceProvider),
    deploymentMode: "production",
    isDemoPreview: false,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false }
  });

  const eventId = "evt_invoice_obs";
  try {
    await withTx(async (c) => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.invoice_webhook_events (
          invoice_webhook_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider TEXT NOT NULL,
          event_id TEXT NOT NULL,
          provider_document_id TEXT NULL,
          document_id UUID NULL,
          document_key TEXT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          correlation_id TEXT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at TIMESTAMPTZ NULL,
          UNIQUE (provider, event_id)
        )`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.invoice_webhook_security_events (
          security_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider TEXT NOT NULL,
          event_id TEXT NULL,
          failure_reason TEXT NOT NULL,
          remote_hint TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await c.query(
        `INSERT INTO siton.invoice_webhook_events(provider, event_id, status, payload)
         VALUES ('morning',$1,'ignored','{}'::jsonb)
         ON CONFLICT (provider, event_id) DO NOTHING`,
        [eventId]
      );
      await c.query(
        `INSERT INTO siton.invoice_webhook_security_events(provider, event_id, failure_reason)
         VALUES ('morning',$1,'invalid_invoice_webhook_signature')`,
        [eventId]
      );
    });

    const res = await app.inject({ method: "GET", url: "/api/admin/invoice-status" });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.invoice_documents.provider.code, "morning");
    assert.equal(body.invoice_documents.provider.mode, "real");
    assert.equal(body.invoice_documents.provider.api_base_url_configured, true);
    assert.equal(body.invoice_documents.provider.bearer_token_configured, true);
    assert.equal(body.invoice_documents.provider.webhook_secret_configured, true);
    assert.equal(typeof body.webhook_ingestion.ignored, "number");
    assert.equal(typeof body.webhook_ingestion.duplicate_rate, "number");
    assert.equal(typeof body.webhook_security.signature_failures, "number");

    const system = await app.inject({ method: "GET", url: "/api/admin/system-status" });
    assert.equal(system.statusCode, 200, system.body);
    const systemBody = JSON.parse(system.body);
    assert.equal(systemBody.system_status.integrations.invoice.provider, "morning");
    assert.equal(systemBody.system_status.integrations.invoice_webhook_ingestion.canonical_route, "/webhooks/invoices");
  } finally {
    await app.close();
    await pool.query(`DELETE FROM siton.invoice_webhook_security_events WHERE event_id=$1`, [eventId]);
    await pool.query(`DELETE FROM siton.invoice_webhook_events WHERE event_id=$1`, [eventId]);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

await pool.end();
