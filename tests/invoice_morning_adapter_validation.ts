import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Fastify from "fastify";
import pg from "pg";

import {
  buildInvoiceProvider,
  ensureInvoiceRailTables,
  reconcileInvoiceDocumentById
} from "../src/invoice_dispatch.js";
import { registerFrontendExperience } from "../src/frontend_runtime.js";

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, statusCode: number, payload: Record<string, unknown>) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function runTest(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}

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

const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }> = [];
const server = createServer(async (req, res) => {
  const body = await readJson(req);
  requests.push({ method: req.method || "", url: req.url || "", headers: req.headers, body });
  if (req.method === "POST" && req.url === "/documents") {
    if (body.document_key === "permfail") return send(res, 400, { error: "invalid_document", message: "bad document" });
    if (body.document_key === "tempfail") return send(res, 429, { error: "rate_limited", message: "retry later" });
    return send(res, 200, {
      id: `morning-doc-${body.document_id}`,
      status: "issued",
      amount: body.amount,
      correlation_id: body.correlation_id
    });
  }
  if (req.method === "GET" && String(req.url || "").startsWith("/documents/")) {
    const id = decodeURIComponent(String(req.url).split("/").pop() || "");
    return send(res, 200, { id, status: "issued", amount: 118 });
  }
  if (req.method === "POST" && String(req.url || "").endsWith("/cancel")) {
    const id = decodeURIComponent(String(req.url).split("/").slice(-2, -1)[0] || "");
    return send(res, 200, { id, status: "voided" });
  }
  return send(res, 404, { error: "not_found" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const env = {
  ...process.env,
  APP_DEPLOYMENT_MODE: "test",
  INVOICE_PROVIDER: "morning",
  INVOICE_PROVIDER_MODE: "real",
  INVOICE_PROVIDER_BASE_URL: baseUrl,
  INVOICE_PROVIDER_BEARER_TOKEN: "invoice-token",
  INVOICE_WEBHOOK_SECRET: "invoice-webhook-secret",
  INVOICE_PROVIDER_TIMEOUT_MS: "2500",
  PAYMENT_PROVIDER: "mockpay",
  PAYMENT_PROVIDER_MODE: "mock-backed"
};

await ensureInvoiceRailTables(withTx);

await runTest("Morning invoice adapter issues, looks up, cancels, reconciles, and maps errors", async () => {
  const provider = buildInvoiceProvider(env);
  assert.equal(provider.providerCode, "morning");
  assert.equal(provider.mode, "real");
  assert.equal(provider.configured, true);

  const documentId = randomUUID();
  const created = await provider.createDocument!({
    documentId,
    documentKey: `charge_receipt:${documentId}`,
    idempotencyKey: `invoice-idem:${documentId}`,
    providerCode: "morning",
    documentType: "charge_receipt",
    dealId: randomUUID(),
    participantId: randomUUID(),
    dealTitle: "Morning Adapter Validation",
    qty: 1,
    grossAmount: 118,
    sitonFeeAmount: 11.14,
    sellerNetAmount: 106.86,
    moneyStateAtIssue: "ChargedSuccess",
    platformFeeBaseAmount: 9.44,
    platformFeeVatAmount: 1.7,
    platformFeeTotalAmount: 11.14,
    correlationId: `invoice-correlation:${documentId}`
  });
  assert.equal(created.result_class, "success");
  assert.equal(created.document_status, "issued");
  assert.equal(created.external_document_issued, true);
  assert.match(String(created.provider_document_id), /^morning-doc-/);
  assert.equal(requests.at(-1)?.headers["idempotency-key"], `invoice-idem:${documentId}`);
  assert.equal(requests.at(-1)?.headers["x-correlation-id"], `invoice-correlation:${documentId}`);
  assert.equal(requests.at(-1)?.body.platform_fee_total_amount, 11.14);

  const status = await provider.getDocumentStatus!({
    documentId,
    documentKey: `charge_receipt:${documentId}`,
    providerDocumentId: created.provider_document_id ?? null,
    correlationId: `status:${documentId}`
  });
  assert.equal(status.result_class, "success");
  assert.equal(status.document_status, "issued");

  const cancel = await provider.cancelDocument!({
    documentId,
    documentKey: `charge_receipt:${documentId}`,
    providerDocumentId: created.provider_document_id ?? null,
    correlationId: `cancel:${documentId}`,
    reason: "validation"
  });
  assert.equal(cancel.result_class, "success");
  assert.equal(cancel.document_status, "voided");

  const reconcile = await provider.reconcileDocument!({
    documentId,
    documentKey: `charge_receipt:${documentId}`,
    providerDocumentId: created.provider_document_id ?? null,
    correlationId: `reconcile:${documentId}`,
    expectedAmount: 118,
    observedAmount: 118,
    expectedStatus: "issued",
    observedStatus: "issued"
  });
  assert.equal(reconcile.reconciliation_outcome, "matched");

  const permanent = await provider.createDocument!({
    documentId: randomUUID(),
    documentKey: "permfail",
    idempotencyKey: "permfail",
    providerCode: "morning",
    documentType: "charge_receipt",
    dealId: randomUUID(),
    participantId: randomUUID(),
    dealTitle: "Permanent",
    qty: 1,
    grossAmount: 1,
    sitonFeeAmount: 0,
    sellerNetAmount: 1,
    moneyStateAtIssue: "ChargedSuccess",
    correlationId: "permfail"
  });
  assert.equal(permanent.result_class, "permanent_fail");
  assert.equal(permanent.retryable, false);

  const temporary = await provider.createDocument!({
    documentId: randomUUID(),
    documentKey: "tempfail",
    idempotencyKey: "tempfail",
    providerCode: "morning",
    documentType: "charge_receipt",
    dealId: randomUUID(),
    participantId: randomUUID(),
    dealTitle: "Temporary",
    qty: 1,
    grossAmount: 1,
    sitonFeeAmount: 0,
    sellerNetAmount: 1,
    moneyStateAtIssue: "ChargedSuccess",
    correlationId: "tempfail"
  });
  assert.equal(temporary.result_class, "temporary_fail");
  assert.equal(temporary.retryable, true);
});

await runTest("Invoice webhook verifies raw body, dedupes, persists, and enqueues reconcile only", async () => {
  const provider = buildInvoiceProvider(env);
  const app = Fastify({ logger: false });
  registerFrontendExperience(app, {
    withTx,
    paymentProvider: {
      providerCode: "mockpay",
      mode: "mock-backed",
      webhookProvider: "mockpay",
      configured: true
    } as any,
    invoiceProvider: provider,
    invoiceSummary: {
      provider: provider.providerCode,
      mode: provider.mode,
      provider_mode: provider.mode,
      configured: Boolean(provider.configured),
      external_issuance: true
    },
    deploymentMode: "test",
    isDemoPreview: false,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false }
  });

  const documentId = randomUUID();
  const documentKey = `charge_receipt:${documentId}`;
  const providerDocumentId = `morning-doc-${documentId}`;
  try {
    await pool.query(
      `INSERT INTO siton.invoice_documents
         (document_id, document_key, idempotency_key, document_type, document_status, status,
          deal_id, participant_id, deal_title, qty, money_state_at_issue,
          gross_amount, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount,
          siton_fee_amount, seller_net_amount, taxable_amount, document_amount,
          provider_code, provider_document_id, correlation_id, external_document_issued,
          created_at, updated_at)
       VALUES ($1,$2,$2,'charge_receipt','issued','issued',
               $3,$4,'Webhook Validation',1,'ChargedSuccess',
               118,9.44,1.70,11.14,
               11.14,106.86,118,118,
               'morning',$5,$6,true,
               now(),now())`,
      [documentId, documentKey, randomUUID(), randomUUID(), providerDocumentId, `existing:${documentId}`]
    );

    const body = JSON.stringify({
      event_id: `evt_invoice_${documentId}`,
      provider_document_id: providerDocumentId,
      document_key: documentKey,
      document_status: "issued",
      correlation_id: `webhook:${documentId}`
    });
    const signature = createHmac("sha256", "invoice-webhook-secret").update(body).digest("hex");
    const first = await app.inject({
      method: "POST",
      url: "/webhooks/invoices",
      headers: {
        "content-type": "application/json",
        "x-invoice-signature": signature
      },
      payload: body
    });
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).status, "queued");

    const duplicate = await app.inject({
      method: "POST",
      url: "/webhooks/invoices",
      headers: {
        "content-type": "application/json",
        "x-invoice-signature": signature
      },
      payload: body
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(JSON.parse(duplicate.body).duplicate, true);

    const invalid = await app.inject({
      method: "POST",
      url: "/webhooks/invoices",
      headers: {
        "content-type": "application/json",
        "x-invoice-signature": "bad"
      },
      payload: body
    });
    assert.equal(invalid.statusCode, 401);

    const stored = await pool.query(
      `SELECT status, document_id FROM siton.invoice_webhook_events WHERE provider='morning' AND event_id=$1`,
      [`evt_invoice_${documentId}`]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].status, "queued");
    assert.equal(String(stored.rows[0].document_id), documentId);

    const outbox = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM siton.outbox_events
       WHERE event_type='invoice_document_reconcile'
         AND aggregate_type='invoice_document'
         AND aggregate_id=$1`,
      [documentId]
    );
    assert.equal(Number(outbox.rows[0].cnt), 1);

    const security = await pool.query(
      `SELECT COUNT(*) AS cnt FROM siton.invoice_webhook_security_events WHERE provider='morning' AND event_id=$1`,
      [`evt_invoice_${documentId}`]
    );
    assert.equal(Number(security.rows[0].cnt), 1);

    const reconcile = await reconcileInvoiceDocumentById({
      pool,
      invoiceProvider: provider,
      documentId,
      eventId: `invoice-webhook-reconcile:${documentId}`
    });
    assert.equal(reconcile.status, "reconciled");
  } finally {
    await app.close();
    await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1 OR payload->>'document_key'=$2`, [documentId, documentKey]);
    await pool.query(`DELETE FROM siton.outbox_dlq WHERE aggregate_id=$1 OR payload->>'document_key'=$2`, [documentId, documentKey]);
    await pool.query(`DELETE FROM siton.invoice_webhook_security_events WHERE event_id LIKE $1`, [`evt_invoice_${documentId}%`]);
    await pool.query(`DELETE FROM siton.invoice_webhook_events WHERE event_id LIKE $1`, [`evt_invoice_${documentId}%`]);
    await pool.query(`DELETE FROM siton.invoice_reconciliation_cases WHERE document_id=$1`, [documentId]);
    await pool.query(`DELETE FROM siton.invoice_document_attempts WHERE document_id=$1`, [documentId]);
    await pool.query(`DELETE FROM siton.invoice_documents WHERE document_id=$1`, [documentId]);
  }
});

await pool.end();
await new Promise<void>((resolve) => server.close(() => resolve()));
