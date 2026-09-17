// LONG_HORIZON_DEALS — worker scheduling over long horizons.
//
// A deal that runs for months is ONE dormant deadline_check row: the real
// claim helper never claims it before its deadline, the admin outbox-status
// reports it as scheduled work (not backlog), and the deadline_check handler
// defers a not-yet-due deal back to its exact deadline instead of failing it.
// No renewal loop keeps the deal alive: the authorization is renewed only at
// the charging boundary (see payment_authorization_renewal_lifecycle).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3143";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";

const { app, claimPendingOutboxBatch, processOutboxEventById } = await import("../src/app.js");
await app.ready();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
const DAY = 24 * 60 * 60_000;

async function seedPublished(days: number) {
  const dealId = randomUUID();
  const deadline = new Date(Date.now() + days * DAY);
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-lh-worker','PendingTarget',$2,42,10,50,9,$3, now())`,
    [dealId, `LH worker ${days}d`, deadline.toISOString()]
  );
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,'deadline_check','deal',$2,$3,'pending',0,$4, now(), now())`,
    [eventId, dealId, JSON.stringify({ deal_id: dealId }), deadline.toISOString()]
  );
  return { dealId, eventId, deadline };
}

try {
  await pool.query(`DELETE FROM siton.outbox_events WHERE status='pending' AND available_at <= now()`); // isolate the claim assertion

  await run("deadline_check rows at +30 / +60 / +90 / +366 days are never claimed by the real claim helper while due work is", async () => {
    const seeds = await Promise.all([30, 60, 90, 366].map(seedPublished));
    const dueId = randomUUID();
    const dueDeal = (await seedPublished(1)).dealId;
    await pool.query(
      `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
       VALUES ($1,'viral_recompute','deal',$2,$3,'pending',0, now() - interval '1 second', now(), now())`,
      [dueId, dueDeal, JSON.stringify({ deal_id: dueDeal })]
    );
    const claimed = await claimPendingOutboxBatch(10);
    const claimedIds = new Set(claimed.map((row: any) => String(row.event_uuid)));
    for (const seed of seeds) assert.equal(claimedIds.has(seed.eventId), false, `+${Math.round((seed.deadline.getTime() - Date.now()) / DAY)}d row must stay dormant`);
    assert.equal(claimedIds.has(dueId), true, "due work is still claimed");
    for (const seed of seeds) {
      const row = await pool.query(`SELECT status, attempt_count FROM siton.outbox_events WHERE event_uuid=$1`, [seed.eventId]);
      assert.equal(row.rows[0].status, "pending"); assert.equal(Number(row.rows[0].attempt_count), 0);
    }
    await pool.query(`UPDATE siton.outbox_events SET status='sent', sent=true WHERE event_uuid=$1`, [dueId]).catch(() => undefined);
  });

  await run("admin outbox-status counts long-horizon rows as scheduled_future, not due_now; the payment-maintenance signal is present and non-alarming", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/outbox-status" });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.ok(body.outbox.scheduled_future >= 4, `scheduled_future=${body.outbox.scheduled_future}`);
    assert.ok(Number.isFinite(body.outbox.next_scheduled_in_s));
    assert.equal(body.payment_maintenance.deal_lifetime_bounded_by_authorization, false);
    assert.equal(typeof body.payment_maintenance.authorizations_past_declared_validity, "number");
  });

  await run("deadline_check on a 60-day deal that is not due defers to the exact deadline and leaves the deal PendingTarget", async () => {
    const seed = await seedPublished(60);
    await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [seed.eventId]); // force an early claim
    const result = await processOutboxEventById(seed.eventId);
    assert.equal(result?.status, "failed", `deferred: ${JSON.stringify(result)}`);
    const row = await pool.query(`SELECT status, available_at, last_error FROM siton.outbox_events WHERE event_uuid=$1`, [seed.eventId]);
    assert.equal(row.rows[0].status, "pending");
    assert.match(String(row.rows[0].last_error || ""), /deadline_not_reached/);
    assert.ok(Math.abs(new Date(row.rows[0].available_at).getTime() - seed.deadline.getTime()) < 1_000, "deferred to the deadline itself (second precision)");
    const deal = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [seed.dealId]);
    assert.equal(deal.rows[0].state, "PendingTarget", "a long-running deal is never failed early");
  });

  await run("timestamptz keeps a 20-year deadline exact across the round trip", async () => {
    const far = new Date(Date.now() + 20 * 365 * DAY);
    far.setMilliseconds(123);
    const r = await pool.query(`SELECT $1::timestamptz AS at`, [far.toISOString()]);
    assert.equal(new Date(r.rows[0].at).getTime(), far.getTime());
  });

  console.log(`SUMMARY passed=${passed} failed=0`);
} finally {
  await app.close().catch(() => undefined);
  await pool.end();
}
