import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "test";
process.env.DISABLE_OUTBOX_WORKER = "1";
const { app, closeWorkerDatabase, processStorageCleanupBatch } = await import("../src/app.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const key = `fault-cleanup/${randomUUID()}.png`;
const inserted = await pool.query(
  `INSERT INTO siton.storage_cleanup_tasks(storage_provider, storage_key, reason)
   VALUES ('local',$1,'fault_lease_validation') RETURNING task_id`,
  [key]
);
const taskId = inserted.rows[0].task_id;
try {
  armTestFault("cleanup.after_claim", { kind: "throw", code: "worker_crashed_after_cleanup_claim" });
  await assert.rejects(() => processStorageCleanupBatch(1, 60_000), (error: any) => error.code === "worker_crashed_after_cleanup_claim");
  const stranded = await pool.query(`SELECT status, attempt_count FROM siton.storage_cleanup_tasks WHERE task_id=$1`, [taskId]);
  assert.equal(stranded.rows[0].status, "processing");
  assert.equal(Number(stranded.rows[0].attempt_count), 1);

  resetTestFaults();
  const recovered = await processStorageCleanupBatch(1, 0);
  assert.equal(recovered.length, 1);
  const final = await pool.query(`SELECT status, attempt_count FROM siton.storage_cleanup_tasks WHERE task_id=$1`, [taskId]);
  assert.equal(final.rows[0].status, "completed");
  assert.equal(Number(final.rows[0].attempt_count), 2);
} finally {
  resetTestFaults();
  await pool.query(`DELETE FROM siton.storage_cleanup_tasks WHERE task_id=$1`, [taskId]);
  await pool.end();
  await app.close();
  await closeWorkerDatabase();
}
console.log("PASS cleanup crash after claim is reclaimed by lease and stale claim generation cannot own the ack");