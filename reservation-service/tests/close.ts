import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { closeInventory } from "../src/close.js";
import { ReservationError, ReservationStore } from "../src/store.js";
const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
const AUTH_EVIDENCE_HASH = "a".repeat(64);

async function cleanup(_dealId: string) {
  await pool.query(`TRUNCATE
    siton_inventory.deal_state_audit,
    siton_inventory.inventory_reservations,
    siton_inventory.inventory_action_idempotency,
    siton_inventory.inventory_deals
    CASCADE`);
}

{
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 2 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "close-race", request_hash: "close-race-hash" });

    await assert.rejects(
      () => closeInventory(pool, dealId, 2),
      (error: unknown) => error instanceof ReservationError && error.code === "inventory_holds_in_flight"
    );
    let status = await store.inventory(dealId);
    assert.equal(status.status, "open");
    assert.equal(status.reserved_units, 1);
    assert.equal(status.committed_units, 0);

    await store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    const closed = await closeInventory(pool, dealId, 2);
    assert.equal(closed.status, "closed");
    assert.equal(closed.reserved_units, 1);
    assert.equal(closed.committed_units, 1);

    await assert.rejects(
      () => store.hold({ deal_id: dealId, qty: 1, idempotency_key: "after-close", request_hash: "after-close-hash" }),
      (error: unknown) => error instanceof ReservationError && error.code === "inventory_deal_closed"
    );
    status = await store.inventory(dealId);
    assert.equal(status.status, "closed");
    assert.equal(status.committed_units, 1);
  } finally {
    await cleanup(dealId);
  }
}

{
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 5);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "expire-close", request_hash: "expire-close-hash" });
    await pool.query(`UPDATE siton_inventory.inventory_reservations SET expires_at=now()-interval '1 second' WHERE reservation_id=$1`, [held.reservation_id]);
    const closed = await closeInventory(pool, dealId, 1);
    assert.equal(closed.status, "closed");
    assert.equal(closed.reserved_units, 0);
    assert.equal(closed.committed_units, 0);
  } finally {
    await cleanup(dealId);
  }
}

await pool.end();
console.log("PASS reservation-service close gate suite");
