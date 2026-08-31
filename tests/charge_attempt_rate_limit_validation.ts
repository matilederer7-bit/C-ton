import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

// Adversarial proof of the literal Siton money invariant (migration 050):
// at most THREE applicable charge/recovery provider attempts per participant
// per deal within any rolling 30-minute window, enforced at the database
// boundary so neither runtime role nor concurrent workers can bypass it.

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

async function applyMigration(file: string) {
  const sql = (await readFile(`src/migrations/${file}`, "utf8")).replace(/^﻿/, "");
  await pool.query(sql);
}

// Schema + the single-insert-site idempotency index + the rate-limit trigger.
await applyMigration("014_demo_preview_bootstrap.sql");
await applyMigration("009_db_enforcement_phase2c.sql");
await applyMigration("012_payment_attempts_idempotency.sql");
await applyMigration("013_payment_attempts_not_null.sql");
await applyMigration("050_charge_attempt_rate_limit.sql");

const RATE_LIMIT_SQLSTATE = "SN429";

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
    failed += 1;
  }
}

async function seedFixture(prefix: string) {
  const seller = `${prefix}-seller`;
  await pool.query(
    `INSERT INTO siton.seller_accounts(seller_id, display_name, auth_enabled) VALUES ($1,$2,false)
     ON CONFLICT (seller_id) DO NOTHING`,
    [seller, `${prefix} seller`]
  );
  const deal = await pool.query(
    `INSERT INTO siton.deals(seller_id,title,price_per_unit,state,min_units,max_units,threshold_units,deadline)
     VALUES ($1,$2,10,'Charging',2,5,2, now()+interval '1 day') RETURNING deal_id`,
    [seller, `${prefix} deal`]
  );
  return { seller, dealId: deal.rows[0].deal_id as string };
}

async function addParticipant(dealId: string, buyerId: string) {
  const r = await pool.query(
    `INSERT INTO siton.participants(deal_id,buyer_id,qty,buyer_state,money_state)
     VALUES ($1,$2,1,'ChargingAttempt','ChargeAttempt') RETURNING participant_id`,
    [dealId, buyerId]
  );
  return r.rows[0].participant_id as string;
}

async function insertAttempt(
  client: pg.Pool | pg.PoolClient,
  participantId: string,
  dealId: string,
  attemptType: "charge_start" | "recovery",
  correlationId: string
) {
  await client.query(
    `INSERT INTO siton.payment_attempts(participant_id,deal_id,attempt_type,result_class,correlation_id)
     VALUES ($1,$2,$3,'unknown',$4)
     ON CONFLICT (participant_id,deal_id,attempt_type,correlation_id) DO NOTHING`,
    [participantId, dealId, attemptType, correlationId]
  );
}

function isRateLimited(error: any): boolean {
  return String(error?.code) === RATE_LIMIT_SQLSTATE || /charge_attempt_rate_limited/.test(String(error?.message || ""));
}

const fixtures: string[] = [];

await runTest("attempts 1,2,3 permitted then 4th rejected in-window", async () => {
  const { dealId, seller } = await seedFixture("rl-a");
  fixtures.push(seller);
  const p = await addParticipant(dealId, "buyerA");
  await insertAttempt(pool, p, dealId, "charge_start", "a-c1");
  await insertAttempt(pool, p, dealId, "charge_start", "a-c2");
  await insertAttempt(pool, p, dealId, "recovery", "a-c3"); // charge+recovery counted together
  let rejected = false;
  try {
    await insertAttempt(pool, p, dealId, "recovery", "a-c4");
  } catch (e) {
    rejected = isRateLimited(e);
  }
  assert.equal(rejected, true, "4th attempt must be rejected with the rate-limit error");
  const n = await pool.query(
    `SELECT count(*)::int AS n FROM siton.payment_attempts WHERE participant_id=$1 AND deal_id=$2`,
    [p, dealId]
  );
  assert.equal(n.rows[0].n, 3, "exactly 3 attempt rows persisted");
});

await runTest("idempotent replay of an existing attempt is not counted", async () => {
  const { dealId, seller } = await seedFixture("rl-b");
  fixtures.push(seller);
  const p = await addParticipant(dealId, "buyerB");
  await insertAttempt(pool, p, dealId, "charge_start", "b-c1");
  await insertAttempt(pool, p, dealId, "charge_start", "b-c2");
  await insertAttempt(pool, p, dealId, "charge_start", "b-c3");
  // Replays of already-recorded provider attempts (same correlation) — a
  // same-claim reprocess — must be admitted and must not consume allowance.
  for (let i = 0; i < 5; i += 1) {
    await insertAttempt(pool, p, dealId, "charge_start", "b-c1");
    await insertAttempt(pool, p, dealId, "charge_start", "b-c3");
  }
  // A genuinely new (4th) provider attempt is still blocked.
  let rejected = false;
  try {
    await insertAttempt(pool, p, dealId, "charge_start", "b-c4-new");
  } catch (e) {
    rejected = isRateLimited(e);
  }
  assert.equal(rejected, true, "a new 4th attempt is still blocked after replays");
});

await runTest("participant A does not consume participant B's allowance", async () => {
  const { dealId, seller } = await seedFixture("rl-c");
  fixtures.push(seller);
  const pA = await addParticipant(dealId, "buyerA");
  const pB = await addParticipant(dealId, "buyerB");
  await insertAttempt(pool, pA, dealId, "charge_start", "c-a1");
  await insertAttempt(pool, pA, dealId, "charge_start", "c-a2");
  await insertAttempt(pool, pA, dealId, "charge_start", "c-a3");
  // B is unaffected and can still make its own three.
  await insertAttempt(pool, pB, dealId, "charge_start", "c-b1");
  await insertAttempt(pool, pB, dealId, "charge_start", "c-b2");
  await insertAttempt(pool, pB, dealId, "charge_start", "c-b3");
  let bBlocked = false;
  try {
    await insertAttempt(pool, pB, dealId, "charge_start", "c-b4");
  } catch (e) {
    bBlocked = isRateLimited(e);
  }
  assert.equal(bBlocked, true, "B's own 4th is blocked, proving independent per-participant windows");
});

await runTest("deal A does not consume deal B's allowance for the same buyer", async () => {
  const a = await seedFixture("rl-d1");
  const b = await seedFixture("rl-d2");
  fixtures.push(a.seller, b.seller);
  const pA = await addParticipant(a.dealId, "sharedBuyer");
  const pB = await addParticipant(b.dealId, "sharedBuyer");
  await insertAttempt(pool, pA, a.dealId, "charge_start", "d-a1");
  await insertAttempt(pool, pA, a.dealId, "charge_start", "d-a2");
  await insertAttempt(pool, pA, a.dealId, "charge_start", "d-a3");
  // Same buyer identity, different deal — its own fresh allowance.
  await insertAttempt(pool, pB, b.dealId, "charge_start", "d-b1");
  const n = await pool.query(
    `SELECT count(*)::int AS n FROM siton.payment_attempts WHERE participant_id=$1 AND deal_id=$2`,
    [pB, b.dealId]
  );
  assert.equal(n.rows[0].n, 1, "deal B attempt succeeded independently");
});

await runTest("attempt after 30-minute window expiry is permitted", async () => {
  const { dealId, seller } = await seedFixture("rl-e");
  fixtures.push(seller);
  const p = await addParticipant(dealId, "buyerA");
  await insertAttempt(pool, p, dealId, "charge_start", "e-c1");
  await insertAttempt(pool, p, dealId, "charge_start", "e-c2");
  await insertAttempt(pool, p, dealId, "charge_start", "e-c3");
  // Age the three attempts past the window.
  await pool.query(
    `UPDATE siton.payment_attempts SET created_at = now() - interval '31 minutes' WHERE participant_id=$1 AND deal_id=$2`,
    [p, dealId]
  );
  let permitted = true;
  try {
    await insertAttempt(pool, p, dealId, "charge_start", "e-c4-after");
  } catch (e) {
    permitted = !isRateLimited(e);
  }
  assert.equal(permitted, true, "a fresh attempt after the window elapses is permitted");
});

await runTest("concurrent workers cannot both push past the cap", async () => {
  const { dealId, seller } = await seedFixture("rl-f");
  fixtures.push(seller);
  const p = await addParticipant(dealId, "buyerA");
  // Two attempts already recorded; the window has room for exactly one more.
  await insertAttempt(pool, p, dealId, "charge_start", "f-c1");
  await insertAttempt(pool, p, dealId, "charge_start", "f-c2");

  // Two concurrent transactions each try to record a distinct new attempt.
  // The advisory transaction lock serializes them: exactly one becomes the
  // 3rd (allowed), the other sees three and is rejected.
  async function competitor(correlation: string): Promise<"ok" | "blocked"> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await insertAttempt(client, p, dealId, "charge_start", correlation);
      // Hold the lock briefly to force a real race.
      await new Promise((r) => setTimeout(r, 50));
      await client.query("COMMIT");
      return "ok";
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (isRateLimited(e)) return "blocked";
      throw e;
    } finally {
      client.release();
    }
  }

  const [r1, r2] = await Promise.all([competitor("f-c3-x"), competitor("f-c4-y")]);
  const oks = [r1, r2].filter((r) => r === "ok").length;
  const blocked = [r1, r2].filter((r) => r === "blocked").length;
  assert.equal(oks, 1, "exactly one concurrent attempt is admitted");
  assert.equal(blocked, 1, "exactly one concurrent attempt is rejected");
  const n = await pool.query(
    `SELECT count(*)::int AS n FROM siton.payment_attempts WHERE participant_id=$1 AND deal_id=$2`,
    [p, dealId]
  );
  assert.equal(n.rows[0].n, 3, "never more than three attempts persist under concurrency");
});

await runTest("refund/deadline_check attempts are not constrained by the charge cap", async () => {
  const { dealId, seller } = await seedFixture("rl-g");
  fixtures.push(seller);
  const p = await addParticipant(dealId, "buyerA");
  // Fill the charge window.
  await insertAttempt(pool, p, dealId, "charge_start", "g-c1");
  await insertAttempt(pool, p, dealId, "charge_start", "g-c2");
  await insertAttempt(pool, p, dealId, "charge_start", "g-c3");
  // Non-charge attempt types remain unconstrained.
  let ok = true;
  try {
    await pool.query(
      `INSERT INTO siton.payment_attempts(participant_id,deal_id,attempt_type,result_class,correlation_id)
       VALUES ($1,$2,'refund','unknown','g-refund1'),($1,$2,'deadline_check','unknown','g-deadline1')`,
      [p, dealId]
    );
  } catch {
    ok = false;
  }
  assert.equal(ok, true, "refund and deadline_check are not charge attempts and are not blocked");
});

// Cleanup all synthetic fixtures.
for (const seller of fixtures) {
  await pool.query(`DELETE FROM siton.deals WHERE seller_id=$1`, [seller]);
  await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [seller]);
}
await pool.end();

console.log(`\nCHARGE_ATTEMPT_RATE_LIMIT ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
