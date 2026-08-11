import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import pg from "pg";
import { ReservationError, ReservationStore } from "../src/store.js";
const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: DATABASE_URL, max: 60 });
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
await pool.query(schema);

async function cleanup(dealId: string) {
  await pool.query(`DELETE FROM siton_inventory.inventory_deals WHERE deal_id=$1`, [dealId]);
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

await run("200 concurrent holds cannot oversell max_units=20", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 20 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) => store.hold({
        deal_id: dealId,
        qty: 1,
        idempotency_key: `buyer-${i}`,
        request_hash: `hash-${i}`
      }))
    );
    const success = attempts.filter((result) => result.status === "fulfilled");
    const failures = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(success.length, 20);
    assert.equal(failures.length, 180);
    for (const failure of failures) {
      assert.ok(failure.reason instanceof ReservationError);
      assert.equal(failure.reason.code, "inventory_exhausted");
    }
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.reserved_units, 20);
    assert.equal(inventory.committed_units, 0);
    assert.equal(inventory.available_units, 0);
    const rows = await pool.query(`SELECT COALESCE(SUM(qty),0)::int AS total FROM siton_inventory.inventory_reservations WHERE deal_id=$1 AND status IN ('held','committed')`, [dealId]);
    assert.equal(Number(rows.rows[0].total), 20);
  } finally {
    await cleanup(dealId);
  }
});

await run("50 concurrent replays of one idempotency key reserve exactly once", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 5 });
    const attempts = await Promise.all(
      Array.from({ length: 50 }, () => store.hold({
        deal_id: dealId,
        qty: 1,
        idempotency_key: "same-key",
        request_hash: "same-hash"
      }))
    );
    assert.equal(new Set(attempts.map((result) => result.reservation_id)).size, 1);
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.reserved_units, 1);
    assert.equal(inventory.committed_units, 0);
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.inventory_reservations WHERE deal_id=$1`, [dealId]);
    assert.equal(Number(count.rows[0].count), 1);
  } finally {
    await cleanup(dealId);
  }
});

await run("same idempotency key with a different request hash is rejected", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 5 });
    await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "payload-key", request_hash: "payload-a" });
    await assert.rejects(
      () => store.hold({ deal_id: dealId, qty: 1, idempotency_key: "payload-key", request_hash: "payload-b" }),
      (error: unknown) => error instanceof ReservationError && error.code === "idempotency_payload_mismatch"
    );
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.reserved_units, 1);
  } finally {
    await cleanup(dealId);
  }
});

await run("mixed concurrent quantities never exceed max_units=15", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 15 });
    const quantities = Array.from({ length: 60 }, (_, index) => [1, 2, 3][index % 3]!);
    await Promise.allSettled(quantities.map((qty, i) => store.hold({
      deal_id: dealId,
      qty,
      idempotency_key: `mixed-${i}`,
      request_hash: `mixed-hash-${i}`
    })));
    const inventory = await store.inventory(dealId);
    assert.ok(inventory.reserved_units <= 15);
    assert.equal(inventory.committed_units, 0);
    assert.ok(inventory.available_units >= 0);
    const row = await pool.query(`SELECT reserved_units,committed_units,max_units FROM siton_inventory.inventory_deals WHERE deal_id=$1`, [dealId]);
    assert.ok(Number(row.rows[0].reserved_units) <= Number(row.rows[0].max_units));
    assert.ok(Number(row.rows[0].committed_units) <= Number(row.rows[0].reserved_units));
  } finally {
    await cleanup(dealId);
  }
});

await run("commit increments committed_units exactly once and replay does not double count", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 5 });
    const held = await store.hold({ deal_id: dealId, qty: 2, idempotency_key: "commit-once", request_hash: "commit-once-hash" });
    const first = await store.commitReservation(held.reservation_id);
    const second = await store.commitReservation(held.reservation_id);
    assert.equal(first.committed_units, 2);
    assert.equal(second.committed_units, 2);
    assert.equal(second.replay, true);
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.reserved_units, 2);
    assert.equal(inventory.committed_units, 2);
  } finally {
    await cleanup(dealId);
  }
});

await run("commit and release racing on one hold resolve to exactly one terminal action", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "terminal-race", request_hash: "terminal-race-hash" });
    const results = await Promise.allSettled([
      store.commitReservation(held.reservation_id),
      store.releaseReservation(held.reservation_id)
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const row = await pool.query(`SELECT status,qty FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`, [held.reservation_id]);
    const status = String(row.rows[0].status);
    assert.ok(status === "committed" || status === "released");
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.reserved_units, status === "committed" ? 1 : 0);
    assert.equal(inventory.committed_units, status === "committed" ? 1 : 0);
    assert.ok(inventory.committed_units <= inventory.reserved_units);
    assert.ok(inventory.reserved_units <= inventory.max_units);
  } finally {
    await cleanup(dealId);
  }
});

await run("closed inventory rejects new holds", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 3 });
    await store.syncDeal({ deal_id: dealId, max_units: 3, status: "closed" });
    await assert.rejects(
      () => store.hold({ deal_id: dealId, qty: 1, idempotency_key: "closed", request_hash: "closed-hash" }),
      (error: unknown) => error instanceof ReservationError && error.code === "inventory_deal_closed"
    );
    const inventory = await store.inventory(dealId);
    assert.equal(inventory.reserved_units, 0);
    assert.equal(inventory.committed_units, 0);
    assert.equal(inventory.status, "closed");
  } finally {
    await cleanup(dealId);
  }
});

await run("expired hold is reclaimed and same idempotent request can renew safely", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 5);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 2 });
    const held = await store.hold({ deal_id: dealId, qty: 2, idempotency_key: "expires", request_hash: "expires-hash" });
    await pool.query(`UPDATE siton_inventory.inventory_reservations SET expires_at=now()-interval '1 second' WHERE reservation_id=$1`, [held.reservation_id]);
    const afterExpiry = await store.inventory(dealId);
    assert.equal(afterExpiry.reserved_units, 0);
    assert.equal(afterExpiry.committed_units, 0);
    assert.equal(afterExpiry.available_units, 2);

    const renewed = await store.hold({ deal_id: dealId, qty: 2, idempotency_key: "expires", request_hash: "expires-hash" });
    assert.equal(renewed.reservation_id, held.reservation_id);
    assert.equal(renewed.renewed, true);
    assert.equal(renewed.reserved_units, 2);
    assert.equal(renewed.committed_units, 0);
    const row = await pool.query(`SELECT status,hold_generation FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`, [held.reservation_id]);
    assert.equal(row.rows[0].status, "held");
    assert.equal(Number(row.rows[0].hold_generation), 2);
  } finally {
    await cleanup(dealId);
  }
});

await pool.end();
console.log("PASS reservation-service concurrency suite");
