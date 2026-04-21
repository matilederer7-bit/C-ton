/**
 * Invoice Document Dispatch Proof
 *
 * Eight targeted tests covering the invoice/accounting groundwork layer:
 *
 *   D1 — enqueue charge_receipt → DB row status=pending, returns "queued"
 *   D2 — duplicate document_key → returns "duplicate", still 1 DB row
 *   D3 — flush with log-only provider → status=issued, issued_at set, provider_document_id set
 *   D4 — flush with always-fail provider → transient failure, status=pending, last_error set
 *   D5 — exhausting max_attempts → status=failed, last_error contains "max_attempts_exceeded"
 *   D6 — retry-then-succeed → status=issued, exactly 1 row, no duplicate
 *   D7 — charge_receipt and refund_receipt for same participant → 2 distinct rows
 *   D8 — eligibility helpers: correct states accepted/rejected
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3396");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

// Import app to ensure DB + schema are ready
await import("../src/app.js");

import {
  enqueueInvoiceDocument,
  flushPendingDocuments,
  isEligibleForChargeReceipt,
  isEligibleForRefundReceipt,
  CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES,
  REFUND_RECEIPT_ELIGIBLE_MONEY_STATES,
  type InvoiceProvider,
  type InvoiceDocumentInput
} from "../src/invoice_dispatch.js";

const DB_URL = process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function cleanupKey(documentKey: string) {
  await pool.query(`DELETE FROM siton.invoice_documents WHERE document_key=$1`, [documentKey]);
}

async function getRow(documentKey: string) {
  const r = await pool.query(
    `SELECT status, attempt_count, max_attempts, provider_document_id, last_error, issued_at
     FROM siton.invoice_documents WHERE document_key=$1`,
    [documentKey]
  );
  return r.rows[0] ?? null;
}

function baseParams(documentKey: string, documentType: "charge_receipt" | "refund_receipt" = "charge_receipt") {
  return {
    documentKey,
    documentType,
    dealId: randomUUID(),
    participantId: randomUUID(),
    dealTitle: "Test Deal",
    qty: 2,
    grossAmount: 200.00,
    sitonFeeAmount: 20.00,
    sellerNetAmount: 180.00,
    moneyStateAtIssue: documentType === "charge_receipt" ? "ChargedSuccess" : "Refunded",
    providerCode: "log-only"
  };
}

// A provider that always fails
function buildAlwaysFailProvider(): InvoiceProvider {
  return {
    providerCode: "test-always-fail",
    mode: "real" as const,
    async issueDocument(_: InvoiceDocumentInput): Promise<{ documentId: string }> {
      throw new Error("test_provider_always_fail");
    }
  };
}

// A provider that fails N times then succeeds
function buildFailThenSucceedProvider(failCount: number) {
  let calls = 0;
  return {
    providerCode: "fail-then-succeed",
    mode: "real" as const,
    callCount: () => calls,
    async issueDocument(_: InvoiceDocumentInput): Promise<{ documentId: string }> {
      calls++;
      if (calls <= failCount) throw new Error(`deliberate_failure_${calls}`);
      return { documentId: `doc-ok-${calls}` };
    }
  };
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

// ─── D1: Enqueue → pending row ───────────────────────────────────────────────

await run("D1 — enqueue charge_receipt → status=pending, returns queued", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    const result = await enqueueInvoiceDocument(baseParams(key), pool);
    assert.equal(result, "queued", `should return "queued"`);

    const row = await getRow(key);
    assert.ok(row, "DB row should exist");
    assert.equal(row.status, "pending");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.issued_at, null);
    console.log(`     status=${row.status} attempt_count=${row.attempt_count}`);
  } finally {
    await cleanupKey(key);
  }
});

// ─── D2: Duplicate document_key → 1 row, "duplicate" returned ───────────────

await run("D2 — duplicate document_key → 1 DB row, returns duplicate", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    const r1 = await enqueueInvoiceDocument(baseParams(key), pool);
    const r2 = await enqueueInvoiceDocument(baseParams(key), pool);
    const count = await pool.query(`SELECT COUNT(*) AS cnt FROM siton.invoice_documents WHERE document_key=$1`, [key]);

    console.log(`     r1=${r1} r2=${r2} rows=${count.rows[0].cnt}`);
    assert.equal(r1, "queued");
    assert.equal(r2, "duplicate");
    assert.equal(Number(count.rows[0].cnt), 1, "exactly 1 DB row");
  } finally {
    await cleanupKey(key);
  }
});

// ─── D3: Flush with log-only → status=issued ─────────────────────────────────

await run("D3 — flush with log-only provider → status=issued, issued_at set, document_id set", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    await enqueueInvoiceDocument(baseParams(key), pool);

    // Use a real log-only provider
    const logOnlyProvider: InvoiceProvider = {
      providerCode: "log-only",
      mode: "log-only" as const,
      async issueDocument(_: InvoiceDocumentInput) {
        return { documentId: `log-doc-test-${Date.now()}` };
      }
    };

    const processed = await flushPendingDocuments(pool, logOnlyProvider);
    assert.ok(processed >= 1, `should have processed at least 1 document`);

    const row = await getRow(key);
    assert.equal(row?.status, "issued", `status should be issued, got ${row?.status}`);
    assert.notEqual(row?.issued_at, null, "issued_at should be set");
    assert.ok(row?.provider_document_id?.startsWith("log-doc-"), "provider_document_id should be set");
    console.log(`     status=${row?.status} document_id=${row?.provider_document_id}`);
  } finally {
    await cleanupKey(key);
  }
});

// ─── D4: Flush with always-fail → transient retry ────────────────────────────

await run("D4 — flush with always-fail provider → status=pending (retry), last_error set", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    await pool.query(
      `INSERT INTO siton.invoice_documents
         (document_key, document_type, deal_id, participant_id, deal_title, qty,
          money_state_at_issue, gross_amount, siton_fee_amount, seller_net_amount,
          status, attempt_count, max_attempts, provider_code,
          available_at, created_at, updated_at)
       VALUES ($1,'charge_receipt',$2,$3,'Test Deal',1,'ChargedSuccess',
               100.00,10.00,90.00,'pending',0,3,'log-only',now(),now(),now())`,
      [key, randomUUID(), randomUUID()]
    );

    await flushPendingDocuments(pool, buildAlwaysFailProvider());
    const row = await getRow(key);

    console.log(`     status=${row?.status} attempt_count=${row?.attempt_count} last_error=${row?.last_error}`);
    assert.equal(row?.status, "pending", `after 1 fail with max_attempts=3 should still be pending (retry)`);
    assert.equal(row?.attempt_count, 1);
    assert.ok(row?.last_error?.includes("test_provider_always_fail"), `last_error should be set`);
  } finally {
    await cleanupKey(key);
  }
});

// ─── D5: Exhausting max_attempts → permanent failed ──────────────────────────

await run("D5 — exhausting max_attempts → status=failed, last_error=max_attempts_exceeded", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    await pool.query(
      `INSERT INTO siton.invoice_documents
         (document_key, document_type, deal_id, participant_id, deal_title, qty,
          money_state_at_issue, gross_amount, siton_fee_amount, seller_net_amount,
          status, attempt_count, max_attempts, provider_code,
          available_at, created_at, updated_at)
       VALUES ($1,'charge_receipt',$2,$3,'Test Deal',1,'ChargedSuccess',
               100.00,10.00,90.00,'pending',0,2,'log-only',now(),now(),now())`,
      [key, randomUUID(), randomUUID()]
    );

    const failProvider = buildAlwaysFailProvider();

    // Flush 1: attempt_count → 1, status=pending
    await flushPendingDocuments(pool, failProvider);
    const after1 = await getRow(key);
    assert.equal(after1?.status, "pending", `after 1st fail should be pending, got ${after1?.status}`);
    assert.equal(after1?.attempt_count, 1);

    // Fast-forward available_at
    await pool.query(`UPDATE siton.invoice_documents SET available_at=now() WHERE document_key=$1`, [key]);

    // Flush 2: attempt_count hits max_attempts=2 → permanent failed
    await flushPendingDocuments(pool, failProvider);
    const after2 = await getRow(key);

    console.log(`     attempt1=${after1?.attempt_count} status1=${after1?.status} → attempt2=${after2?.attempt_count} status2=${after2?.status}`);
    console.log(`     last_error=${after2?.last_error}`);

    assert.equal(after2?.status, "failed", `should be permanently failed, got ${after2?.status}`);
    assert.equal(after2?.issued_at, null, "issued_at must be null");
    assert.ok(after2?.last_error?.includes("max_attempts_exceeded"), `last_error should mention max_attempts_exceeded`);
  } finally {
    await cleanupKey(key);
  }
});

// ─── D6: Retry-then-succeed → exactly 1 issued row ───────────────────────────

await run("D6 — retry-then-succeed → status=issued, exactly 1 row, no duplicate", async () => {
  const key = `charge_receipt:${randomUUID()}`;
  try {
    await enqueueInvoiceDocument(baseParams(key), pool);

    const provider = buildFailThenSucceedProvider(1);

    // Flush 1 fails
    await flushPendingDocuments(pool, provider);
    const after1 = await getRow(key);
    assert.equal(after1?.status, "pending", `should be pending after first failure`);

    // Fast-forward available_at
    await pool.query(`UPDATE siton.invoice_documents SET available_at=now() WHERE document_key=$1`, [key]);

    // Flush 2 succeeds
    await flushPendingDocuments(pool, provider);

    const count = await pool.query(`SELECT COUNT(*) AS cnt FROM siton.invoice_documents WHERE document_key=$1`, [key]);
    const row = await getRow(key);

    console.log(`     provider_calls=${provider.callCount()} rows=${count.rows[0].cnt} status=${row?.status} document_id=${row?.provider_document_id}`);
    assert.equal(Number(count.rows[0].cnt), 1, "exactly 1 row — no duplicates");
    assert.equal(row?.status, "issued", `should be issued after successful retry`);
    assert.equal(row?.attempt_count, 2, `attempt_count should be 2`);
    assert.notEqual(row?.issued_at, null, `issued_at should be set`);
    assert.ok(row?.provider_document_id?.startsWith("doc-ok-"), `document_id should be from successful issue`);
  } finally {
    await cleanupKey(key);
  }
});

// ─── D7: charge_receipt and refund_receipt → 2 distinct rows ─────────────────

await run("D7 — charge_receipt and refund_receipt for same participant → 2 distinct rows", async () => {
  const participantId = randomUUID();
  const chargeKey = `charge_receipt:${participantId}`;
  const refundKey = `refund_receipt:${participantId}`;
  try {
    const r1 = await enqueueInvoiceDocument(baseParams(chargeKey, "charge_receipt"), pool);
    const r2 = await enqueueInvoiceDocument(baseParams(refundKey, "refund_receipt"), pool);

    const chargeRow = await getRow(chargeKey);
    const refundRow = await getRow(refundKey);

    console.log(`     r1=${r1} r2=${r2} charge_status=${chargeRow?.status} refund_status=${refundRow?.status}`);
    assert.equal(r1, "queued");
    assert.equal(r2, "queued");
    assert.ok(chargeRow, "charge_receipt row should exist");
    assert.ok(refundRow, "refund_receipt row should exist");
    assert.equal(chargeRow?.status, "pending");
    assert.equal(refundRow?.status, "pending");
  } finally {
    await cleanupKey(chargeKey);
    await cleanupKey(refundKey);
  }
});

// ─── D8: Eligibility helpers ──────────────────────────────────────────────────

await run("D8 — eligibility helpers: correct states accepted and rejected", async () => {
  // charge_receipt eligibility
  assert.equal(isEligibleForChargeReceipt("DealCompleted"), true, "DealCompleted → eligible for charge_receipt");
  assert.equal(isEligibleForChargeReceipt("DealFailed"), false, "DealFailed → not eligible");
  assert.equal(isEligibleForChargeReceipt("Dropped"), false, "Dropped → not eligible");
  assert.equal(isEligibleForChargeReceipt("ChargedSuccess"), false, "ChargedSuccess (pre-completion) → not eligible");
  assert.equal(isEligibleForChargeReceipt("RecoveredCharge"), false, "RecoveredCharge (pre-completion) → not eligible");
  assert.equal(isEligibleForChargeReceipt(""), false, "empty → not eligible");

  // refund_receipt eligibility
  assert.equal(isEligibleForRefundReceipt("Refunded"), true, "Refunded → eligible for refund_receipt");
  assert.equal(isEligibleForRefundReceipt("ChargedSuccess"), false, "ChargedSuccess → not eligible for refund");
  assert.equal(isEligibleForRefundReceipt("RecoveredCharge"), false, "RecoveredCharge → not eligible for refund");
  assert.equal(isEligibleForRefundReceipt("Dropped"), false, "Dropped → not eligible for refund");
  assert.equal(isEligibleForRefundReceipt(""), false, "empty → not eligible");

  console.log(`     CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES=${JSON.stringify(CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES)}`);
  console.log(`     REFUND_RECEIPT_ELIGIBLE_MONEY_STATES=${JSON.stringify(REFUND_RECEIPT_ELIGIBLE_MONEY_STATES)}`);
});

await pool.end();
console.log("\nAll invoice dispatch proof tests completed.");
