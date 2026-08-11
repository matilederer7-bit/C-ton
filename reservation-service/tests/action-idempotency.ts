import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import pg from "pg";
import { runIdempotentDealAction } from "../src/action-idempotency.js";
import { closeInventory } from "../src/close.js";
import { ReservationError, ReservationStore } from "../src/store.js";
const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: DATABASE_URL, max: 40 });
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
await pool.query(schema);

async function cleanup(dealId: string) {
  await pool.query(`DELETE FROM siton_inventory.inventory_action_idempotency WHERE deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton_inventory.inventory_deals WHERE deal_id=$1`, [dealId]);
}
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertAllSemanticallyEqual(rows: Record<string, unknown>[]) {
  assert.ok(rows.length > 0);
  for (const row of rows.slice(1)) assert.deepStrictEqual(row, rows[0]);
}

await run("20 concurrent sync calls with one key execute exactly once and return identical canonical response", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  let executions = 0;
  try {
    const invoke = () => runIdempotentDealAction({
      pool,
      operation: "sync",
      dealId,
      idempotencyKey: "publish-action-key",
      requestPayload: { deal_id: dealId, max_units: 25, status: "open" },
      execute: async () => {
        executions += 1;
        await sleep(120);
        return store.syncDeal({ deal_id: dealId, max_units: 25, status: "open" });
      }
    });
    const responses = await Promise.all(Array.from({ length: 20 }, invoke));
    assert.equal(executions, 1);
    assertAllSemanticallyEqual(responses);
    assert.equal(responses[0].replay, false);
    const records = await pool.query(`SELECT COUNT(*)::int AS count,status FROM siton_inventory.inventory_action_idempotency WHERE operation='sync' AND deal_id=$1 AND idempotency_key=$2 GROUP BY status`, [dealId, "publish-action-key"]);
    assert.equal(Number(records.rows[0]?.count || 0), 1);
    assert.equal(String(records.rows[0]?.status || ""), "completed");
  } finally { await cleanup(dealId); }
});

await run("20 concurrent close calls with one key execute exactly once", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  let executions = 0;
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 5, status: "open" });
    const invoke = () => runIdempotentDealAction({
      pool,
      operation: "close",
      dealId,
      idempotencyKey: "close-action-key",
      requestPayload: { deal_id: dealId, max_units: 5 },
      execute: async () => {
        executions += 1;
        await sleep(120);
        return closeInventory(pool, dealId, 5);
      }
    });
    const responses = await Promise.all(Array.from({ length: 20 }, invoke));
    assert.equal(executions, 1);
    assertAllSemanticallyEqual(responses);
    assert.equal(responses[0].status, "closed");
  } finally { await cleanup(dealId); }
});

await run("same action key with different payload is rejected", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await runIdempotentDealAction({ pool, operation:"sync", dealId, idempotencyKey:"same-key", requestPayload:{deal_id:dealId,max_units:5,status:"open"}, execute:()=>store.syncDeal({deal_id:dealId,max_units:5,status:"open"}) });
    await assert.rejects(
      () => runIdempotentDealAction({ pool, operation:"sync", dealId, idempotencyKey:"same-key", requestPayload:{deal_id:dealId,max_units:6,status:"open"}, execute:()=>store.syncDeal({deal_id:dealId,max_units:6,status:"open"}) }),
      (error: unknown) => error instanceof ReservationError && error.code === "idempotency_payload_mismatch"
    );
  } finally { await cleanup(dealId); }
});

await pool.end();
console.log("ACTION_IDEMPOTENCY_GATE_PASS");
