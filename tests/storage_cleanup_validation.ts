import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const root = await mkdtemp(join(tmpdir(), "siton-storage-cleanup-"));
process.env.STORAGE_ADAPTER = "local";
process.env.DEAL_IMAGE_UPLOAD_DIR = root;
process.env.DISABLE_OUTBOX_WORKER = "1";
const { getDealImageStorageAdapter } = await import("../src/product_image_storage.js");
const { processStorageCleanupBatch, closeWorkerDatabase } = await import("../src/app.js");
const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const key = "test/deals/00000000-0000-0000-0000-000000000001/images/cleanup.png";
  await getDealImageStorageAdapter().put(key, Buffer.from("cleanup"), { contentType: "image/png" });
  await db.query(
    `INSERT INTO siton.storage_cleanup_tasks(storage_provider, storage_key, reason) VALUES ('local',$1,'validation')`,
    [key]
  );
  const result = await processStorageCleanupBatch(1);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.status, "completed");
  assert.equal(await getDealImageStorageAdapter().exists(key), false);
  const row = await db.query(`SELECT status, attempt_count, last_error_code FROM siton.storage_cleanup_tasks WHERE storage_key=$1`, [key]);
  assert.equal(row.rows[0].status, "completed");
  assert.equal(Number(row.rows[0].attempt_count), 1);
  assert.equal(row.rows[0].last_error_code, null);

  const mismatchKey = `${key}.mismatch`;
  await db.query(
    `INSERT INTO siton.storage_cleanup_tasks(storage_provider, storage_key, reason) VALUES ('s3',$1,'validation')`,
    [mismatchKey]
  );
  const retry = await processStorageCleanupBatch(1);
  assert.equal(retry[0]!.status, "pending");
  const retryRow = await db.query(`SELECT status, attempt_count, last_error_code FROM siton.storage_cleanup_tasks WHERE storage_key=$1`, [mismatchKey]);
  assert.equal(retryRow.rows[0].status, "pending");
  assert.equal(Number(retryRow.rows[0].attempt_count), 1);
  assert.equal(retryRow.rows[0].last_error_code, "storage_cleanup_provider_mismatch");
  console.log("PASS storage cleanup deletes idempotently and persists bounded retry state");
} finally {
  await db.query(`DELETE FROM siton.storage_cleanup_tasks WHERE reason='validation'`).catch(() => undefined);
  await db.end();
  await closeWorkerDatabase();
  await rm(root, { recursive: true, force: true });
}
