import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { ReservationStore } from "../src/store.js";
const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: DATABASE_URL, max: 50 });
await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));

async function cleanup() {
  await pool.query(`TRUNCATE siton_inventory.deal_state_audit, siton_inventory.inventory_reservations, siton_inventory.inventory_action_idempotency, siton_inventory.inventory_deals CASCADE`);
}
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await run("Holds do not count toward TargetReached", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 5, min_units: 3 });
    for (let i = 0; i < 3; i += 1) {
      await store.hold({ deal_id: dealId, qty: 1, idempotency_key: `held-${i}`, request_hash: `held-hash-${i}` });
    }
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.reserved_units, 3);
    assert.equal(inventory.committed_units, 0);
    assert.equal(inventory.deal_state, "PendingTarget");
    const audit = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.deal_state_audit WHERE deal_id=$1`, [dealId]);
    assert.equal(Number(audit.rows[0].count), 0);
  } finally { await cleanup(); }
});

await run("full minimum creates one canonical TargetReached audit", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 5, min_units: 3 });
    const first = await store.hold({ deal_id: dealId, qty: 2, idempotency_key: "below-min", request_hash: "below-min-hash" });
    const below = await store.commitReservation(first.reservation_id);
    assert.equal(below.committed_units, 2);
    assert.equal(below.deal_state, "PendingTarget");
    assert.equal(below.target_transitioned, false);

    const second = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "reaches-min", request_hash: "reaches-min-hash" });
    const reached = await store.commitReservation(second.reservation_id);
    assert.equal(reached.committed_units, 3);
    assert.equal(reached.deal_state, "TargetReached");
    assert.equal(reached.target_transitioned, true);
    assert.ok(reached.target_audit_id);

    const replay = await store.commitReservation(second.reservation_id);
    assert.equal(replay.replay, true);
    const audit = await pool.query(
      `SELECT action_name,from_state,to_state,idempotency_key,committed_units,min_units
         FROM siton_inventory.deal_state_audit WHERE deal_id=$1`,
      [dealId]
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].action_name, "deal.target_reached");
    assert.equal(audit.rows[0].from_state, "PendingTarget");
    assert.equal(audit.rows[0].to_state, "TargetReached");
    assert.equal(audit.rows[0].idempotency_key, `target-reached:${dealId}`);
    assert.equal(Number(audit.rows[0].committed_units), 3);
    assert.equal(Number(audit.rows[0].min_units), 3);
  } finally { await cleanup(); }
});

await run("20 concurrent commits create exactly one TargetReached audit", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 20, min_units: 10 });
    const holds = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      store.hold({ deal_id: dealId, qty: 1, idempotency_key: `race-${i}`, request_hash: `race-hash-${i}` })
    ));
    const commits = await Promise.all(holds.map((hold) => store.commitReservation(hold.reservation_id)));
    assert.equal(commits.filter((row) => row.target_transitioned).length, 1);
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.committed_units, 20);
    assert.equal(inventory.deal_state, "TargetReached");
    const audit = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.deal_state_audit WHERE deal_id=$1`, [dealId]);
    assert.equal(Number(audit.rows[0].count), 1);
  } finally { await cleanup(); }
});

await run("Audit insert failure rolls reservation, counter, and state back together", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1, min_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "rollback", request_hash: "rollback-hash" });
    await pool.query(`
      CREATE OR REPLACE FUNCTION siton_inventory.fail_target_audit_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced target audit failure'; END;
      $$;
      CREATE TRIGGER force_target_audit_failure
      BEFORE INSERT ON siton_inventory.deal_state_audit
      FOR EACH ROW EXECUTE FUNCTION siton_inventory.fail_target_audit_insert();
    `);
    await assert.rejects(() => store.commitReservation(held.reservation_id));
    await pool.query(`DROP TRIGGER force_target_audit_failure ON siton_inventory.deal_state_audit; DROP FUNCTION siton_inventory.fail_target_audit_insert();`);

    const reservation = await pool.query(`SELECT status FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`, [held.reservation_id]);
    const inventory = await store.inventory(dealId);
    const audit = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.deal_state_audit WHERE deal_id=$1`, [dealId]);
    assert.equal(reservation.rows[0].status, "held");
    assert.equal(inventory.committed_units, 0);
    assert.equal(inventory.deal_state, "PendingTarget");
    assert.equal(Number(audit.rows[0].count), 0);
    const recovered = await store.commitReservation(held.reservation_id);
    assert.equal(recovered.deal_state, "TargetReached");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS force_target_audit_failure ON siton_inventory.deal_state_audit`).catch(() => undefined);
    await pool.query(`DROP FUNCTION IF EXISTS siton_inventory.fail_target_audit_insert()`).catch(() => undefined);
    await cleanup();
  }
});

await run("deal state audit rejects update and delete", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1, min_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "append-only", request_hash: "append-only-hash" });
    await store.commitReservation(held.reservation_id);
    await assert.rejects(() => pool.query(`UPDATE siton_inventory.deal_state_audit SET committed_units=2 WHERE deal_id=$1`, [dealId]));
    await assert.rejects(() => pool.query(`DELETE FROM siton_inventory.deal_state_audit WHERE deal_id=$1`, [dealId]));
    const audit = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.deal_state_audit WHERE deal_id=$1`, [dealId]);
    assert.equal(Number(audit.rows[0].count), 1);
  } finally { await cleanup(); }
});

await pool.end();
console.log("TARGET_REACHED_TRANSACTION_GATE_PASS");
