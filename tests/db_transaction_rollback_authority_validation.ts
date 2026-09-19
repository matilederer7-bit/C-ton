import { strict as assert } from "node:assert";
import pg from "pg";

const { Pool } = pg;

// MUTATION-TESTING FINDING (red-team §14) — TEST BLIND SPOT, now closed.
//
// `withTx` in src/app.ts ends a failed transaction with
//   if (!committed) await c.query("ROLLBACK").catch(() => undefined);
// and then releases the client back to the pool in `finally`.
//
// Deleting that ROLLBACK line kept the ENTIRE relevant suite green — 12/12
// files including db_transaction_fault_validation, cross_schema_atomicity_
// validation, state_engine_atomicity_validation, fault_adapter_validation,
// http_response_loss_fault_validation, adversarial_hardening/resilience and
// preprod_torture. Atomicity is a named safety boundary in AGENTS.md, and
// nothing proved it.
//
// The reason every existing test missed it: they look for the partial row from
// a DIFFERENT connection, and an uncommitted row is invisible there anyway, so
// the assertion passes either way. The damage only becomes visible on the
// pooled connection itself: the failed request's writes stay inside a still-open
// transaction, the client goes back to the pool, and the NEXT request that
// borrows it runs inside that transaction and COMMITs the orphaned writes.
// Proven with the real pooling shape: without the ROLLBACK a row written by a
// request that threw was committed by an unrelated later request; with it, only
// the later request's own row survived.
//
// This test asserts the invariant DETERMINISTICALLY, without depending on which
// connection the pool happens to hand out next: after a failed transaction, no
// runtime connection may be parked in PostgreSQL state 'idle in transaction'.

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "internal-runtime";

const adminUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const observer = new Pool({ connectionString: adminUrl, max: 2, application_name: "siton-rollback-observer" });

const { withTx } = await import("../src/app.js");

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

/** Connections the runtime pool is holding open inside a transaction. */
async function idleInTransactionCount(): Promise<number> {
  const res = await observer.query(
    `SELECT COUNT(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name LIKE 'siton-%-runtime'
        AND state IN ('idle in transaction', 'idle in transaction (aborted)')`
  );
  return Number(res.rows[0]?.n || 0);
}

await run("a failed transaction leaves no runtime connection idle-in-transaction", async () => {
  await withTx(async (c: any) => {
    await c.query(`CREATE TABLE IF NOT EXISTS siton.rollback_authority_probe (v text)`);
    await c.query(`DELETE FROM siton.rollback_authority_probe`);
  });

  const before = await idleInTransactionCount();
  assert.equal(before, 0, `precondition: runtime pool must start with no open transaction, saw ${before}`);

  // A request whose handler throws after a write — every 500 path is this shape.
  await assert.rejects(
    withTx(async (c: any) => {
      await c.query(`INSERT INTO siton.rollback_authority_probe (v) VALUES ('partial_write_from_failed_request')`);
      throw new Error("handler failed after writing");
    })
  );

  // The client is released in `finally`; give the server a moment to report it.
  let parked = await idleInTransactionCount();
  for (let i = 0; i < 40 && parked !== 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    parked = await idleInTransactionCount();
  }
  assert.equal(
    parked,
    0,
    "a failed transaction returned its connection to the pool still inside a transaction: " +
      "the next request to borrow it runs in that transaction and can COMMIT the failed request's partial writes"
  );
});

await run("the failed request's partial write is not durable", async () => {
  // A later, unrelated request that commits must not carry the failed request's
  // row with it.
  await withTx(async (c: any) => {
    await c.query(`INSERT INTO siton.rollback_authority_probe (v) VALUES ('later_request')`);
  });

  const rows = await observer.query(
    `SELECT v FROM siton.rollback_authority_probe ORDER BY v`
  );
  const values = rows.rows.map((r: any) => String(r.v));
  assert.deepEqual(
    values,
    ["later_request"],
    `the failed request's partial write must never become durable, saw ${JSON.stringify(values)}`
  );
});

await withTx(async (c: any) => c.query(`DROP TABLE IF EXISTS siton.rollback_authority_probe`));
await observer.end();
console.log("db_transaction_rollback_authority_validation: all checks passed");
