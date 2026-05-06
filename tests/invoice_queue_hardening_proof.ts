/**
 * Invoice Queue Hardening Proof
 *
 * Five targeted tests for the invoice_documents reclaim mechanism and
 * provider mode visibility:
 *
 *   H1 — old processing document is reclaimed to pending
 *   H2 — recent processing document is NOT reclaimed (young enough to still be live)
 *   H3 — reclaim does not produce duplicate issuance (reclaimed row issues exactly once)
 *   H4 — provider mode is returned correctly in /api/admin/invoice-status
 *   H5 — /api/admin/notifications-status includes provider mode
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3398");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
import { reclaimStuckInvoiceDocuments, flushPendingDocuments, type InvoiceProvider, type InvoiceDocumentInput } from "../src/invoice_dispatch.js";

const DB_URL = process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function cleanupKey(documentKey: string) {
  await pool.query(`DELETE FROM siton.invoice_documents WHERE document_key=$1`, [documentKey]);
}

async function getRow(documentKey: string) {
  const r = await pool.query(
    `SELECT status, attempt_count, max_attempts, last_error, issued_at, updated_at
     FROM siton.invoice_documents WHERE document_key=$1`,
    [documentKey]
  );
  return r.rows[0] ?? null;
}

async function insertProcessingDoc(documentKey: string, updatedAtOffset: string) {
  // Insert a document directly in processing status with controllable updated_at
  await pool.query(
    `INSERT INTO siton.invoice_documents
       (document_key, document_type, deal_id, participant_id, deal_title, qty,
        money_state_at_issue, gross_amount, siton_fee_amount, seller_net_amount,
        status, attempt_count, max_attempts, provider_code,
        available_at, created_at, updated_at)
     VALUES ($1, 'charge_receipt', $2, $3, 'Test', 1, 'ChargedSuccess',
             100.00, 10.00, 90.00, 'processing', 1, 3, 'log-only',
             now(), now(), now() - $4::interval)
     ON CONFLICT (document_key) DO NOTHING`,
    [documentKey, randomUUID(), randomUUID(), updatedAtOffset]
  );
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e: any) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    throw e;
  }
}

// ─── H1: old processing → reclaimed to pending ───────────────────────────────

await run("H1 — processing document older than timeout is reclaimed to pending", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    // Insert as processing with updated_at = 2 minutes ago (timeout = 60s)
    await insertProcessingDoc(key, "2 minutes");

    const before = await getRow(key);
    assert.equal(before?.status, "processing", "pre-condition: should be processing");

    const reclaimed = await reclaimStuckInvoiceDocuments(pool, 60_000);
    assert.ok(reclaimed >= 1, `should have reclaimed at least 1, got ${reclaimed}`);

    const after = await getRow(key);
    assert.equal(after?.status, "pending", `should be pending after reclaim, got ${after?.status}`);
    assert.ok(after?.last_error?.includes("reclaim") || after?.last_error != null,
      "last_error should be set after reclaim");

    console.log(`     reclaimed=${reclaimed} status=${after?.status} last_error=${after?.last_error}`);
  } finally {
    await cleanupKey(key);
  }
});

// ─── H2: recent processing is NOT reclaimed ───────────────────────────────────

await run("H2 — processing document younger than timeout is NOT reclaimed", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    // Insert as processing with updated_at = 5 seconds ago (timeout = 60s → safe)
    await insertProcessingDoc(key, "5 seconds");

    const reclaimed = await reclaimStuckInvoiceDocuments(pool, 60_000);

    const after = await getRow(key);
    assert.equal(after?.status, "processing", `should still be processing, got ${after?.status}`);

    console.log(`     reclaimed=${reclaimed} status=${after?.status} (young row untouched)`);
  } finally {
    await cleanupKey(key);
  }
});

// ─── H3: reclaim then flush → exactly one issuance, no duplicate ─────────────

await run("H3 — reclaimed document issues exactly once, no duplicate issuance", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    // Insert as processing-stuck (simulates crash mid-flush)
    await insertProcessingDoc(key, "2 minutes");

    // Reclaim resets to pending
    const reclaimed = await reclaimStuckInvoiceDocuments(pool, 60_000);
    assert.ok(reclaimed >= 1);

    // Verify it's pending now
    const afterReclaim = await getRow(key);
    assert.equal(afterReclaim?.status, "pending");

    // Log-only provider succeeds
    const logOnly: InvoiceProvider = {
      providerCode: "log-only",
      mode: "log-only" as const,
      async issueDocument(_: InvoiceDocumentInput) {
        return { documentId: `log-doc-h3-${Date.now()}` };
      }
    };
    await flushPendingDocuments(pool, logOnly);

    // Exactly one row, status=issued
    const count = await pool.query(
      `SELECT COUNT(*) AS cnt FROM siton.invoice_documents WHERE document_key=$1`, [key]
    );
    const after = await getRow(key);

    console.log(`     rows=${count.rows[0].cnt} status=${after?.status} document_id=${after?.issued_at != null ? "set" : "null"}`);

    assert.equal(Number(count.rows[0].cnt), 1, "exactly 1 row after reclaim+flush");
    assert.equal(after?.status, "issued", `should be issued, got ${after?.status}`);
    assert.notEqual(after?.issued_at, null, "issued_at must be set");
  } finally {
    await cleanupKey(key);
  }
});

// ─── H4: invoice-status includes provider mode ───────────────────────────────

await run("H4 — /api/admin/invoice-status includes provider mode", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/invoice-status" });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);

  // provider block must be present
  assert.ok(body.invoice_documents.provider !== undefined, "provider field must be present");
  const p = body.invoice_documents.provider;
  assert.ok(typeof p.code === "string",            "provider.code must be a string");
  assert.ok(typeof p.mode === "string",            "provider.mode must be a string");
  assert.ok(typeof p.external_issuance === "boolean", "provider.external_issuance must be a boolean");

  // In demo/dev with no Twilio-equivalent set, mode must be "log-only"
  assert.equal(p.mode, "log-only", `expected log-only mode, got ${p.mode}`);
  assert.equal(p.external_issuance, false, "log-only should have external_issuance=false");

  console.log(`     provider=${JSON.stringify(p)}`);
});

// ─── H5: notifications-status includes provider mode ─────────────────────────

await run("H5 — /api/admin/notifications-status includes provider mode", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/notifications-status" });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);

  // provider block must be present
  assert.ok(body.notifications.provider !== undefined, "provider field must be present in notifications");
  const p = body.notifications.provider;
  assert.ok(typeof p.code === "string",            "provider.code must be a string");
  assert.ok(typeof p.mode === "string",            "provider.mode must be a string");
  assert.ok(typeof p.external_delivery === "boolean", "provider.external_delivery must be a boolean");

  // Without Twilio credentials, mode must be "log-only"
  assert.equal(p.mode, "log-only", `expected log-only mode, got ${p.mode}`);
  assert.equal(p.external_delivery, false, "log-only should have external_delivery=false");

  console.log(`     provider=${JSON.stringify(p)}`);
});

await app.close().catch(() => undefined);
await pool.end();
console.log("\nAll invoice queue hardening proof tests completed.");
