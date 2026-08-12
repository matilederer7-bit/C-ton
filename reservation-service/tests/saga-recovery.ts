import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import pg from "pg";
import { closeInventory } from "../src/close.js";
import { ReservationError, ReservationStore } from "../src/store.js";
const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: DATABASE_URL, max: 30 });
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
await pool.query(schema);
const AUTH_EVIDENCE_HASH = "a".repeat(64);

async function cleanup(_dealId: string) {
  await pool.query(`TRUNCATE
    siton_inventory.deal_state_audit,
    siton_inventory.inventory_reservations,
    siton_inventory.inventory_action_idempotency,
    siton_inventory.inventory_deals
    CASCADE`);
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("crash after Hold is safely compensated by Release", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 2 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "crash-after-hold", request_hash: "h1" });
    const beforeRecovery = await store.inventory(dealId);
    assert.equal(beforeRecovery.reserved_units, 1);
    assert.equal(beforeRecovery.committed_units, 0);

    const released = await store.releaseReservation(held.reservation_id);
    assert.equal(released.status, "released");
    const afterRecovery = await store.inventory(dealId);
    assert.equal(afterRecovery.reserved_units, 0);
    assert.equal(afterRecovery.committed_units, 0);
    assert.equal(afterRecovery.available_units, 2);
  } finally {
    await cleanup(dealId);
  }
});

await run("crash after Commit survives process-style replay without double count", async () => {
  const dealId = randomUUID();
  try {
    const firstStore = new ReservationStore(pool, 120);
    await firstStore.syncDeal({ deal_id: dealId, max_units: 3 });
    const held = await firstStore.hold({ deal_id: dealId, qty: 2, idempotency_key: "crash-after-commit", request_hash: "h2" });
    const committed = await firstStore.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    assert.equal(committed.committed_units, 2);

    const restartedStore = new ReservationStore(pool, 120);
    const replay = await restartedStore.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    assert.equal(replay.replay, true);
    assert.equal(replay.committed_units, 2);
    const inventory = await restartedStore.inventory(dealId);
    assert.equal(inventory.reserved_units, 2);
    assert.equal(inventory.committed_units, 2);
  } finally {
    await cleanup(dealId);
  }
});

await run("Close is blocked while a Join Hold is unresolved", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "close-block", request_hash: "h3" });
    await assert.rejects(
      () => closeInventory(pool, dealId, 1),
      (error: unknown) => error instanceof ReservationError && error.code === "inventory_holds_in_flight"
    );
    await store.releaseReservation(held.reservation_id);
    const closed = await closeInventory(pool, dealId, 1);
    assert.equal(closed.status, "closed");
  } finally {
    await cleanup(dealId);
  }
});

await run("Close after committed Join preserves committed capacity and rejects new Hold", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 2 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "close-after-commit", request_hash: "h4" });
    await store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    const closed = await closeInventory(pool, dealId, 2);
    assert.equal(closed.status, "closed");
    assert.equal(closed.committed_units, 1);
    assert.equal(closed.reserved_units, 1);
    await assert.rejects(
      () => store.hold({ deal_id: dealId, qty: 1, idempotency_key: "late-hold", request_hash: "h5" }),
      (error: unknown) => error instanceof ReservationError && error.code === "inventory_deal_closed"
    );
  } finally {
    await cleanup(dealId);
  }
});

await run("temporary Holds never count toward the 90 percent product threshold", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 10 });
    const holds = [];
    for (let i = 0; i < 9; i += 1) {
      holds.push(await store.hold({ deal_id: dealId, qty: 1, idempotency_key: `threshold-${i}`, request_hash: `threshold-hash-${i}` }));
    }
    const heldInventory = await store.inventory(dealId);
    assert.equal(heldInventory.reserved_units, 9);
    assert.equal(heldInventory.committed_units, 0);

    for (const hold of holds) await store.commitReservation(hold.reservation_id, AUTH_EVIDENCE_HASH);
    const committedInventory = await store.inventory(dealId);
    assert.equal(committedInventory.reserved_units, 9);
    assert.equal(committedInventory.committed_units, 9);
  } finally {
    await cleanup(dealId);
  }
});

await pool.end();
console.log("PASS reservation-service saga recovery suite");
