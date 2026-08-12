import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { ReservationError, ReservationStore } from "../src/store.js";
const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: DATABASE_URL, max: 50 });
await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
const AUTH_EVIDENCE_HASH = "a".repeat(64);
const OTHER_EVIDENCE_HASH = "b".repeat(64);

async function cleanup() {
  await pool.query(`TRUNCATE
    siton_inventory.participant_state_audit,
    siton_inventory.deal_state_audit,
    siton_inventory.inventory_reservations,
    siton_inventory.inventory_action_idempotency,
    siton_inventory.inventory_deals
    CASCADE`);
}
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await run("invalid authorization evidence commits nothing", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 2, min_units: 2 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "invalid-evidence", request_hash: "invalid-evidence-request" });
    await assert.rejects(
      () => store.commitReservation(held.reservation_id, "not-a-sha256"),
      (error: unknown) => error instanceof ReservationError && error.code === "invalid_authorization_evidence_hash"
    );
    const reservation = await pool.query(
      `SELECT status,buyer_state,money_state,authorization_evidence_hash
         FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`,
      [held.reservation_id]
    );
    const inventory = await store.inventory(dealId);
    const audits = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.participant_state_audit WHERE participant_id=$1`, [held.reservation_id]);
    assert.deepEqual(reservation.rows[0], {
      status: "held",
      buyer_state: "NotJoined",
      money_state: "NoFinancial",
      authorization_evidence_hash: null
    });
    assert.equal(inventory.committed_units, 0);
    assert.equal(Number(audits.rows[0].count), 0);
  } finally { await cleanup(); }
});

await run("Join authorization writes the paired States and two Audits atomically", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 2, min_units: 2 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "authorized", request_hash: "authorized-request" });
    const committed = await store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    assert.equal(committed.buyer_state, "JoinedAuthorized");
    assert.equal(committed.money_state, "AuthHeld");
    assert.equal(committed.authorization_evidence_hash, AUTH_EVIDENCE_HASH);
    assert.equal(committed.join_authorize_audit_count, 2);
    assert.equal(committed.committed_units, 1);

    const audits = await pool.query(
      `SELECT state_type,action_name,from_state,to_state,idempotency_key,authorization_evidence_hash
         FROM siton_inventory.participant_state_audit
        WHERE participant_id=$1 ORDER BY state_type`,
      [held.reservation_id]
    );
    assert.equal(audits.rowCount, 2);
    assert.deepEqual(audits.rows.map((row) => row.state_type), ["buyer_state", "money_state"]);
    assert.ok(audits.rows.every((row) => row.action_name === "participant.join_authorize"));
    assert.ok(audits.rows.every((row) => row.idempotency_key === "authorized"));
    assert.ok(audits.rows.every((row) => row.authorization_evidence_hash === AUTH_EVIDENCE_HASH));

    const replay = await store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    assert.equal(replay.replay, true);
    assert.equal(replay.join_authorize_audit_count, 2);
    await assert.rejects(
      () => store.commitReservation(held.reservation_id, OTHER_EVIDENCE_HASH),
      (error: unknown) => error instanceof ReservationError && error.code === "authorization_evidence_mismatch"
    );
    const unchanged = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.participant_state_audit WHERE participant_id=$1`, [held.reservation_id]);
    assert.equal(Number(unchanged.rows[0].count), 2);
  } finally { await cleanup(); }
});

await run("20 concurrent replays leave one Commit and exactly two Join Audits", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1, min_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "concurrent-authorize", request_hash: "concurrent-authorize-request" });
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH)
    ));
    assert.equal(results.filter((result) => result.replay === false).length, 1);
    assert.equal(results.filter((result) => result.replay === true).length, 19);
    const reservation = await pool.query(`SELECT status,buyer_state,money_state FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`, [held.reservation_id]);
    const audits = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.participant_state_audit WHERE participant_id=$1`, [held.reservation_id]);
    assert.equal(reservation.rows[0].status, "committed");
    assert.equal(reservation.rows[0].buyer_state, "JoinedAuthorized");
    assert.equal(reservation.rows[0].money_state, "AuthHeld");
    assert.equal(Number(audits.rows[0].count), 2);
  } finally { await cleanup(); }
});

await run("Audit failure rolls back Reservation, counter and both States", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1, min_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "audit-rollback", request_hash: "audit-rollback-request" });
    await pool.query(`
      CREATE OR REPLACE FUNCTION siton_inventory.fail_money_join_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state_type='money_state' THEN RAISE EXCEPTION 'forced money audit failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER force_money_join_audit_failure
      BEFORE INSERT ON siton_inventory.participant_state_audit
      FOR EACH ROW EXECUTE FUNCTION siton_inventory.fail_money_join_audit();
    `);
    await assert.rejects(() => store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH));
    await pool.query(`DROP TRIGGER force_money_join_audit_failure ON siton_inventory.participant_state_audit; DROP FUNCTION siton_inventory.fail_money_join_audit();`);

    const reservation = await pool.query(
      `SELECT status,buyer_state,money_state,authorization_evidence_hash
         FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`,
      [held.reservation_id]
    );
    const inventory = await store.inventory(dealId);
    const participantAudits = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.participant_state_audit WHERE participant_id=$1`, [held.reservation_id]);
    const dealAudits = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.deal_state_audit WHERE deal_id=$1`, [dealId]);
    assert.equal(reservation.rows[0].status, "held");
    assert.equal(reservation.rows[0].buyer_state, "NotJoined");
    assert.equal(reservation.rows[0].money_state, "NoFinancial");
    assert.equal(reservation.rows[0].authorization_evidence_hash, null);
    assert.equal(inventory.committed_units, 0);
    assert.equal(inventory.deal_state, "PendingTarget");
    assert.equal(Number(participantAudits.rows[0].count), 0);
    assert.equal(Number(dealAudits.rows[0].count), 0);

    const recovered = await store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    assert.equal(recovered.join_authorize_audit_count, 2);
    assert.equal(recovered.deal_state, "TargetReached");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS force_money_join_audit_failure ON siton_inventory.participant_state_audit`).catch(() => undefined);
    await pool.query(`DROP FUNCTION IF EXISTS siton_inventory.fail_money_join_audit()`).catch(() => undefined);
    await cleanup();
  }
});

await run("participant State Audit rejects update and delete", async () => {
  const dealId = randomUUID();
  const store = new ReservationStore(pool, 120);
  try {
    await store.syncDeal({ deal_id: dealId, max_units: 1, min_units: 1 });
    const held = await store.hold({ deal_id: dealId, qty: 1, idempotency_key: "append-only-join", request_hash: "append-only-join-request" });
    await store.commitReservation(held.reservation_id, AUTH_EVIDENCE_HASH);
    await assert.rejects(() => pool.query(`UPDATE siton_inventory.participant_state_audit SET to_state='NotJoined' WHERE participant_id=$1`, [held.reservation_id]));
    await assert.rejects(() => pool.query(`DELETE FROM siton_inventory.participant_state_audit WHERE participant_id=$1`, [held.reservation_id]));
    const audits = await pool.query(`SELECT COUNT(*)::int AS count FROM siton_inventory.participant_state_audit WHERE participant_id=$1`, [held.reservation_id]);
    assert.equal(Number(audits.rows[0].count), 2);
  } finally { await cleanup(); }
});

await pool.end();
console.log("JOIN_AUTHORIZE_TRANSACTION_GATE_PASS");
