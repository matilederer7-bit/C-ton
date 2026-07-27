import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "test";
process.env.DISABLE_OUTBOX_WORKER = "1";
const { app, closeWorkerDatabase, withTx } = await import("../src/app.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const observer = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const rolledBackKey = `tx-fault/${randomUUID()}`;
const committedKey = `tx-fault/${randomUUID()}`;
try {
  armTestFault("db.before_commit", { kind: "throw", code: "before_commit_disconnect" });
  await assert.rejects(() => withTx((c) => c.query(`INSERT INTO siton.storage_cleanup_tasks(storage_provider,storage_key,reason) VALUES ('local',$1,'tx_fault')`, [rolledBackKey])), (error: any) => error.code === "before_commit_disconnect");
  assert.equal(Number((await observer.query(`SELECT count(*) FROM siton.storage_cleanup_tasks WHERE storage_key=$1`, [rolledBackKey])).rows[0].count), 0);

  armTestFault("db.after_commit", { kind: "throw", code: "response_lost_after_commit" });
  await assert.rejects(() => withTx((c) => c.query(`INSERT INTO siton.storage_cleanup_tasks(storage_provider,storage_key,reason) VALUES ('local',$1,'tx_fault')`, [committedKey])), (error: any) => error.code === "response_lost_after_commit");
  assert.equal(Number((await observer.query(`SELECT count(*) FROM siton.storage_cleanup_tasks WHERE storage_key=$1`, [committedKey])).rows[0].count), 1, "post-commit fault must not issue a misleading rollback");
} finally {
  resetTestFaults();
  await observer.query(`DELETE FROM siton.storage_cleanup_tasks WHERE storage_key=ANY($1::text[])`, [[rolledBackKey, committedKey]]);
  await observer.end();
  await app.close();
  await closeWorkerDatabase();
}
console.log("PASS transaction faults distinguish rollback-before-commit from durable uncertain outcome after commit");