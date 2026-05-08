import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  buildInvoiceProvider,
  enqueueInvoiceDocument,
  ensureInvoiceRailTables,
  processInvoiceDocumentById,
  reconcileInvoiceDocumentById
} from "../src/invoice_dispatch.js";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.INVOICE_PROVIDER = "internal-invoice-ledger";
process.env.INVOICE_PROVIDER_MODE = "internal-truth-only";

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

async function cleanupDocument(documentId: string, documentKey: string) {
  await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1 OR payload->>'document_key'=$2`, [documentId, documentKey]);
  await pool.query(`DELETE FROM siton.outbox_dlq WHERE aggregate_id=$1 OR payload->>'document_key'=$2`, [documentId, documentKey]);
  await pool.query(`DELETE FROM siton.invoice_reconciliation_cases WHERE document_id=$1`, [documentId]);
  await pool.query(`DELETE FROM siton.invoice_document_attempts WHERE document_id=$1`, [documentId]);
  await pool.query(`DELETE FROM siton.invoice_documents WHERE document_id=$1 OR document_key=$2`, [documentId, documentKey]);
}

await ensureInvoiceRailTables(withTx);

await runTest("invoice rail enqueues, issues, and reconciles without external document issuance", async () => {
  const documentKey = `charge_receipt:${randomUUID()}`;
  let documentId = "";
  try {
    const queued = await enqueueInvoiceDocument({
      documentKey,
      documentType: "charge_receipt",
      dealId: randomUUID(),
      participantId: randomUUID(),
      dealTitle: "Invoice Rail Validation",
      qty: 1,
      grossAmount: 118,
      sitonFeeAmount: 11.14,
      sellerNetAmount: 106.86,
      moneyStateAtIssue: "ChargedSuccess",
      providerCode: "internal-invoice-ledger",
      platformFeeBaseAmount: 9.44,
      platformFeeVatAmount: 1.70,
      platformFeeTotalAmount: 11.14,
      correlationId: `invoice-validation:${documentKey}`
    }, pool);
    assert.equal(queued, "queued");

    const duplicate = await enqueueInvoiceDocument({
      documentKey,
      documentType: "charge_receipt",
      dealId: randomUUID(),
      participantId: randomUUID(),
      dealTitle: "Invoice Rail Validation Duplicate",
      qty: 1,
      grossAmount: 118,
      sitonFeeAmount: 11.14,
      sellerNetAmount: 106.86,
      moneyStateAtIssue: "ChargedSuccess",
      providerCode: "internal-invoice-ledger"
    }, pool);
    assert.equal(duplicate, "duplicate");

    const doc = await pool.query(
      `SELECT document_id, document_key, status, document_status, platform_fee_base_amount,
              platform_fee_vat_amount, platform_fee_total_amount, external_document_issued
       FROM siton.invoice_documents
       WHERE document_key=$1`,
      [documentKey]
    );
    assert.equal(doc.rowCount, 1);
    documentId = String(doc.rows[0].document_id);
    assert.equal(Number(doc.rows[0].platform_fee_base_amount), 9.44);
    assert.equal(Number(doc.rows[0].platform_fee_vat_amount), 1.70);
    assert.equal(Number(doc.rows[0].platform_fee_total_amount), 11.14);
    assert.equal(doc.rows[0].external_document_issued, false);

    const outbox = await pool.query(
      `SELECT event_uuid
       FROM siton.outbox_events
       WHERE event_type='invoice_document_issue'
         AND aggregate_type='invoice_document'
         AND aggregate_id=$1`,
      [documentId]
    );
    assert.equal(outbox.rowCount, 1);

    const issue = await processInvoiceDocumentById({
      pool,
      invoiceProvider: buildInvoiceProvider(),
      documentId,
      eventId: String(outbox.rows[0].event_uuid)
    });
    assert.equal(issue.status, "issued");

    const reconcile = await reconcileInvoiceDocumentById({
      pool,
      invoiceProvider: buildInvoiceProvider(),
      documentId,
      eventId: `invoice-validation-reconcile:${documentId}`
    });
    assert.equal(reconcile.status, "reconciled");

    const finalDoc = await pool.query(
      `SELECT status, document_status, provider_document_id, external_document_issued
       FROM siton.invoice_documents
       WHERE document_id=$1`,
      [documentId]
    );
    assert.equal(finalDoc.rows[0].status, "reconciled");
    assert.equal(finalDoc.rows[0].document_status, "reconciled");
    assert.ok(String(finalDoc.rows[0].provider_document_id || "").startsWith("internal-invoice:"));
    assert.equal(finalDoc.rows[0].external_document_issued, false);

    const attempts = await pool.query(
      `SELECT attempt_type, result_class, document_status
       FROM siton.invoice_document_attempts
       WHERE document_id=$1
       ORDER BY created_at ASC`,
      [documentId]
    );
    assert.deepEqual(
      attempts.rows.map((row) => `${row.attempt_type}:${row.result_class}:${row.document_status}`),
      [
        "prepare:success:pending",
        "create_document:success:issued",
        "reconcile_document:success:reconciled"
      ]
    );
  } finally {
    if (documentId) {
      await cleanupDocument(documentId, documentKey);
    } else {
      await pool.query(`DELETE FROM siton.invoice_documents WHERE document_key=$1`, [documentKey]);
    }
  }
});

await pool.end();
