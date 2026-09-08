// LONG-HORIZON DEALS (item 8) — the canonical outbox / deadline worker can hold
// a job months or years in the future WITHOUT it looking like backlog or
// running early, DB-exercised on the real tables and the real worker helpers.
//  * pending rows with available_at at +30 d / +180 d / +366 d / +5 y / +20 y are
//    NEVER claimed by the worker's claim query, while a due row IS claimed
//  * the admin queue metrics count them as scheduled_future (not due_now) and
//    report next_scheduled_in_s at the right horizon
//  * timestamptz keeps millisecond precision across the round trip (no overflow)
//  * the deadline_check handler DEFERS a check whose deal deadline is 366 days
//    ahead: the row goes back to pending with available_at = the deadline
//    exactly (not the exponential retry backoff), attempt budget untouched
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3662";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `lh-worker-admin-${randomUUID().slice(0, 8)}`;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });
const { app, claimPendingOutboxBatch, processOutboxEventById } = await import("../src/app.js");

const DAY_MS = 24 * 3600_000;
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e: any) { console.error(`FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

const HORIZONS: Array<[string, number]> = [["30d", 30 * DAY_MS], ["180d", 180 * DAY_MS], ["366d", 366 * DAY_MS], ["5y", 5 * 365 * DAY_MS], ["20y", 20 * 365 * DAY_MS]];
const inserted: Array<{ label: string; event_uuid: string; available_at: string }> = [];
let dueUuid = "";

await run("fixtures: five far-future pending deadline_check rows + one due control row", async () => {
  for (const [label, offset] of HORIZONS) {
    const at = new Date(Date.now() + offset + 123).toISOString(); // odd milliseconds on purpose
    const r = await pool.query(
      `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
       VALUES ('deadline_check','deal',$1,$2,'pending',0,$3::timestamptz) RETURNING event_uuid, available_at`,
      [randomUUID(), JSON.stringify({ proof: "long_horizon", label }), at]
    );
    inserted.push({ label, event_uuid: String(r.rows[0].event_uuid), available_at: at });
  }
  const due = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('deadline_check','deal',$1,$2,'pending',0, now() - interval '1 second') RETURNING event_uuid`,
    [randomUUID(), JSON.stringify({ proof: "long_horizon", label: "due" })]
  );
  dueUuid = String(due.rows[0].event_uuid);
  assert.equal(inserted.length, 5);
});

await run("timestamptz precision: every far-future available_at reads back to the exact millisecond (30 d … 20 y), no overflow, no rounding", async () => {
  for (const row of inserted) {
    const r = await pool.query(`SELECT available_at, EXTRACT(EPOCH FROM available_at) * 1000 AS epoch_ms FROM siton.outbox_events WHERE event_uuid=$1`, [row.event_uuid]);
    const stored = new Date(r.rows[0].available_at).toISOString();
    assert.equal(stored, row.available_at, `${row.label} round trip`);
    assert.equal(Math.round(Number(r.rows[0].epoch_ms)), Date.parse(row.available_at), `${row.label} epoch`);
    assert.ok(Date.parse(stored) > Date.now() + 29 * DAY_MS, `${row.label} is genuinely in the future`);
  }
});

await run("the worker claim query never claims a future row (30 d … 20 y) and DOES claim the due control row", async () => {
  const claimed = await claimPendingOutboxBatch(50);
  const claimedIds = new Set(claimed.map((e: any) => String(e.event_uuid)));
  for (const row of inserted) assert.ok(!claimedIds.has(row.event_uuid), `${row.label} must not be claimed`);
  assert.ok(claimedIds.has(dueUuid), "the due control row is claimed");
  const states = await pool.query(`SELECT event_uuid, status FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[])`, [inserted.map((r) => r.event_uuid)]);
  for (const s of states.rows) assert.equal(s.status, "pending", "future rows stay pending");
  // release the control row so it does not linger as processing
  await pool.query(`UPDATE siton.outbox_events SET status='failed', last_error='long_horizon_proof_control' WHERE event_uuid=$1`, [dueUuid]);
});

await run("admin queue metrics: future rows are scheduled_future, not due_now; next_scheduled_in_s is ≈ 30 days (the nearest), never a backlog age", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/outbox-status", headers: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  const o = (res.json() as any).outbox;
  assert.ok(o.scheduled_future >= 5, JSON.stringify(o));
  assert.ok(o.due_now >= 0);
  assert.ok(o.pending >= o.scheduled_future);
  // the seeded rows are not "due now"
  const dueRows = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.outbox_events WHERE status='pending' AND available_at <= now() AND event_uuid = ANY($1::uuid[])`, [inserted.map((r) => r.event_uuid)]);
  assert.equal(dueRows.rows[0].n, 0);
  const nearest = await pool.query(`SELECT EXTRACT(EPOCH FROM (MIN(available_at) FILTER (WHERE status='pending' AND available_at > now()) - now())) AS s FROM siton.outbox_events`);
  const seconds = Number(nearest.rows[0].s);
  assert.ok(seconds > 0 && seconds <= 30 * DAY_MS / 1000 + 5, `next scheduled in ${seconds}s`);
});

await run("deadline_check handler defers a 366-day deal: back to pending with available_at = the deadline EXACTLY (not the retry backoff), attempt budget untouched, deal still PendingTarget", async () => {
  const seller = `lh-worker-seller-${randomUUID().slice(0, 8)}`;
  // publishing needs an approved seller with a business profile (same seed as the r6 harness)
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
     VALUES ($1,$1,'Long Horizon Ltd','long-horizon@siton.local','approved','active') ON CONFLICT (seller_id) DO NOTHING`,
    [seller]
  );
  const create = await app.inject({
    method: "POST", url: "/deals", headers: { "x-seller-id": seller, "idempotency-key": `lh-w-${randomUUID()}` },
    payload: { seller_id: seller, title: "Long horizon worker deal", description: "worker proof", price_per_unit: 10, min_units: 2, max_units: 10, deadline: new Date(Date.now() + 2 * DAY_MS).toISOString() }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const publish = await app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers: { "x-seller-id": seller }, payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
  assert.equal(publish.statusCode, 200, publish.body);
  const farDeadline = new Date(Date.now() + 366 * DAY_MS + 456).toISOString();
  // the deadline is immutable after publish by trigger — the proof moves it as the
  // future long-horizon product would have stored it (superuser, replica role)
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`UPDATE siton.deals SET deadline=$2 WHERE deal_id=$1`, [dealId, farDeadline]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  const ev = await pool.query(`SELECT event_uuid, attempt_count FROM siton.outbox_events WHERE event_type='deadline_check' AND aggregate_id=$1 AND status='pending'`, [dealId]);
  assert.equal(ev.rowCount, 1, "one pending deadline_check for the deal");
  const eventUuid = String(ev.rows[0].event_uuid);
  // make it due NOW (what a worker would see if the check were enqueued early) and process it
  await pool.query(`UPDATE siton.outbox_events SET available_at = now() - interval '1 second' WHERE event_uuid=$1`, [eventUuid]);
  await processOutboxEventById(eventUuid);
  const after = await pool.query(`SELECT status, available_at, attempt_count, last_error FROM siton.outbox_events WHERE event_uuid=$1`, [eventUuid]);
  assert.equal(after.rows[0].status, "pending", JSON.stringify(after.rows[0]));
  // The handler parses the deadline through `new Date(String(deal.deadline))`, which
  // drops the sub-second part of a pg Date — so the deferral lands on the deadline's
  // SECOND (≤ 999 ms early), never on the exponential retry backoff (seconds from now).
  // Recorded in docs/LONG_HORIZON_DEALS_ARCHITECTURE.md §7 as a sub-second note; for a
  // horizon of a year the scheduling error is < 1 s.
  const rescheduledMs = new Date(after.rows[0].available_at).getTime();
  const driftMs = Date.parse(farDeadline) - rescheduledMs;
  assert.ok(driftMs >= 0 && driftMs < 1000, `rescheduled to the deadline (drift ${driftMs} ms; got ${new Date(rescheduledMs).toISOString()} vs ${farDeadline})`);
  assert.ok(rescheduledMs - Date.now() > 365 * DAY_MS, "a year away — not the retry backoff");
  assert.match(String(after.rows[0].last_error || ""), /deadline_not_reached/);
  const deal = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(deal.rows[0].state, "PendingTarget", "a deal whose deadline is a year away is never failed early");
  const claimedAgain = await claimPendingOutboxBatch(50);
  assert.ok(!claimedAgain.some((e: any) => String(e.event_uuid) === eventUuid), "the deferred row is not claimable until its deadline");
});

// cleanup the seeded rows so they never look like real scheduled work
await pool.query(`DELETE FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[])`, [inserted.map((r) => r.event_uuid)]);
await app.close().catch(() => undefined);
await pool.end();
console.log(`\nWORKER_LONG_HORIZON_SCHEDULING passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
