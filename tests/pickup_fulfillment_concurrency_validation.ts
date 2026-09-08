// LAUNCH SPRINT 3 — exactly-once physical handoff under contention.
//
// Two seller devices (and then 5, 10, 25) confirm the SAME order at the same
// instant. Contention is reached by construction, not by sleeps: the first
// handoff is parked inside its transaction at the db.before_commit block
// fault while it holds the participant row lock; the competitors are
// launched and the suite waits until PostgreSQL itself reports them blocked
// on that lock; then the barrier is released. Assertions are made against the
// database: exactly one audit event, every unit Redeemed exactly once with ONE
// redeemed_at, no money/deal state change, no 5xx, every losing request
// answering the canonical "already handed over" truth (200, idempotent).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "10000";
process.env.RATE_LIMIT_READ_MAX = process.env.RATE_LIMIT_READ_MAX || "5000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "1000";

const { app } = await import("../src/app.js");
const { pool: appPool } = await import("../src/db.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const { createDeal, ensureSellerReady, forceDealState, forceParticipantTo, joinDeal, participantStates, publishDeal, sellerHeaders, tracking } =
  await import("./helpers/physical_fulfillment_fixture.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });
const APP_POOL_MAX = Number((appPool as any).options?.max || 10);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
  finally { resetTestFaults(); }
}

const tag = randomUUID().slice(0, 6);
const SELLER = `bookstore-cc-${tag}`;
const H = sellerHeaders(SELLER);
await ensureSellerReady(app, SELLER, "חנות הספרים (מקבילות)");

async function lockWaiters() {
  const result = await pool.query(
    `SELECT pid, left(query, 160) AS query, wait_event_type, wait_event
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND application_name LIKE 'siton-%'
       AND wait_event_type = 'Lock'`
  );
  return result.rows as Array<{ pid: number; query: string; wait_event_type: string; wait_event: string }>;
}
async function waitForLockWaiters(min: number, label: string, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<typeof lockWaiters>> = [];
  while (Date.now() - startedAt < timeoutMs) {
    last = await lockWaiters();
    if (last.length >= min) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label}: expected >= ${min} backend(s) blocked on a lock, saw ${last.length} after ${timeoutMs}ms`);
}
function timeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

async function settledOrder(qty: number) {
  const dealId = await createDeal(app, SELLER, { title: `ספר מקבילות ${randomUUID().slice(0, 4)}`, price: 60, minUnits: 1, maxUnits: 40 });
  await publishDeal(app, SELLER, dealId);
  const buyer = await joinDeal(app, dealId, { name: "ישראל ישראלי", phone: `052${String(Date.now()).slice(-7)}`, qty, optionType: "pickup" });
  await forceParticipantTo(pool, buyer.participant_id, "ChargedSuccess");
  await forceDealState(pool, dealId, "Completed");
  const t = await tracking(app, buyer.participant_id, buyer.tracking_access_token);
  assert.equal(t.statusCode, 200, t.body);
  const code = String((t.json() as any).tracking.pickup.order_code);
  assert.match(code, /^CT-\d{4}-\d{4}$/);
  return { dealId, ...buyer, code };
}

async function facts(participantId: string, sellerId: string) {
  const units = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='Redeemed')::int AS redeemed,
            count(DISTINCT redeemed_at)::int AS distinct_redeemed_at,
            count(*) FILTER (WHERE metadata_jsonb ? 'handoff')::int AS with_handoff_record
       FROM siton.fulfillment_units WHERE participant_id=$1`,
    [participantId]
  );
  const events = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_security_events WHERE seller_id=$1 AND event_type='fulfillment.handoff' AND payload->>'participant_id' = $2`, [sellerId, participantId]);
  const idem = await pool.query(`SELECT count(*)::int AS n FROM siton.idempotency_log WHERE entity_type='participant' AND entity_id=$1 AND action_name='fulfillment.handoff'`, [participantId]);
  const states = await participantStates(pool, participantId);
  const attempts = await pool.query(`SELECT count(*)::int AS n FROM siton.payment_attempts`);
  return { units: units.rows[0], events: Number(events.rows[0].n), idem: Number(idem.rows[0].n), states, attempts: Number(attempts.rows[0].n) };
}

function handoffRequest(participantId: string, key: string, source = "scan") {
  return app.inject({
    method: "POST",
    url: "/api/seller/fulfillment/handoff",
    headers: { ...H, "idempotency-key": key, "x-request-id": `cc-${key}` },
    payload: { participant_id: participantId, source }
  });
}

async function contendedHandoff(n: number, label: string) {
  const order = await settledOrder(3);
  const before = await facts(order.participant_id, SELLER);
  assert.equal(before.units.total, 3); assert.equal(before.units.redeemed, 0); assert.equal(before.events, 0);
  // The handoff route runs ONE withTx (ensureDealTypeTables is memoised after
  // the first call of the process), so the first hit of db.before_commit is
  // the held handoff, parked with the participant row locked.
  const barrier = armTestFault("db.before_commit", { kind: "block" });
  assert.ok(barrier, "block fault did not return a barrier");
  let released = false;
  const release = () => { if (!released) { released = true; barrier!.release(); } };
  try {
    const held = handoffRequest(order.participant_id, `${label}-held-${tag}`);
    const entered = await Promise.race([
      barrier!.entered.then(() => "entered" as const),
      held.then((response) => response),
      timeout<never>(20_000, `${label}: held handoff never reached the commit point`)
    ]);
    assert.equal(entered, "entered", `${label}: held handoff answered ${JSON.stringify(entered).slice(0, 200)} before COMMIT`);
    // Nothing is visible to a third connection while the held transaction is open.
    const invisible = await facts(order.participant_id, SELLER);
    assert.equal(invisible.units.redeemed, 0, `${label}: units leaked before COMMIT`);
    assert.equal(invisible.events, 0, `${label}: audit event leaked before COMMIT`);
    const competitors = Array.from({ length: n - 1 }, (_, i) => handoffRequest(order.participant_id, `${label}-c${i}-${tag}`, i % 2 ? "manual" : "scan"));
    const expectedWaiters = Math.min(n - 1, APP_POOL_MAX - 1);
    const waiters = await waitForLockWaiters(expectedWaiters, label);
    assert.ok(waiters.every((w) => /participants|fulfillment_units|idempotency_log/.test(w.query)), `${label}: waiters blocked on unexpected statements ${JSON.stringify(waiters.map((w) => w.query))}`);
    release();
    const responses = await Promise.all([held, ...competitors]);
    const statuses = responses.map((r) => r.statusCode);
    assert.ok(statuses.every((s) => s === 200), `${label}: statuses ${JSON.stringify(statuses)}`);
    const bodies = responses.map((r) => r.json() as any);
    const winners = bodies.filter((b) => b.idempotent === false);
    const losers = bodies.filter((b) => b.idempotent === true);
    assert.equal(winners.length, 1, `${label}: ${winners.length} winners`);
    assert.equal(losers.length, n - 1, `${label}: ${losers.length} losers`);
    assert.ok(losers.every((b) => b.already_fulfilled === true && b.units_marked === 0 && b.message === "כבר סומן כנמסר"), `${label}: a loser did not answer the canonical already-handed-over truth`);
    assert.equal(winners[0].units_marked, 3);
    const fulfilledAt = new Set(bodies.map((b) => String(b.fulfilled_at)));
    assert.equal(fulfilledAt.size, 1, `${label}: fulfilled_at must be ONE authoritative instant, saw ${[...fulfilledAt].join(", ")}`);
    const after = await facts(order.participant_id, SELLER);
    assert.equal(after.units.redeemed, 3, `${label}: every unit Redeemed`);
    assert.equal(after.units.distinct_redeemed_at, 1, `${label}: one redeemed_at`);
    assert.equal(after.units.with_handoff_record, 3);
    assert.equal(after.events, 1, `${label}: exactly ONE audit event, saw ${after.events}`);
    assert.equal(after.idem, 1, `${label}: exactly ONE idempotency row (only the winner stores a response), saw ${after.idem}`);
    assert.equal(after.states.money_state, "ChargedSuccess");
    assert.equal(after.states.buyer_state, "DealCompleted");
    assert.equal(after.attempts, before.attempts, "no payment attempt created");
    // A replay of every key answers 200 and changes nothing further.
    const replays = await Promise.all([`${label}-held-${tag}`, ...Array.from({ length: n - 1 }, (_, i) => `${label}-c${i}-${tag}`)].map((key) => handoffRequest(order.participant_id, key)));
    assert.ok(replays.every((r) => r.statusCode === 200 && (r.json() as any).idempotent === true));
    const final = await facts(order.participant_id, SELLER);
    assert.equal(final.events, 1); assert.equal(final.units.distinct_redeemed_at, 1);
    return { n, waiters: waiters.length };
  } finally {
    release();
  }
}

for (const n of [2, 5, 10, 25]) {
  await run(`${n} simultaneous confirms of one order → ONE canonical handoff (held at COMMIT, ${n - 1} competitors blocked on the row lock, released together)`, async () => {
    const result = await contendedHandoff(n, `n${n}`);
    console.log(`    contention observed: ${result.waiters} backend(s) blocked before release`);
  });
}

await run("free-running burst (no barrier): 12 confirms fired together → one winner, eleven canonical 'already handed over' answers, one audit event", async () => {
  const order = await settledOrder(2);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => handoffRequest(order.participant_id, `burst-${i}-${tag}`)));
  assert.ok(responses.every((r) => r.statusCode === 200), JSON.stringify(responses.map((r) => r.statusCode)));
  const winners = responses.filter((r) => (r.json() as any).idempotent === false);
  assert.equal(winners.length, 1);
  const after = await facts(order.participant_id, SELLER);
  assert.equal(after.events, 1); assert.equal(after.units.redeemed, 2); assert.equal(after.units.distinct_redeemed_at, 1);
  assert.equal(after.states.money_state, "ChargedSuccess");
});

await run("a handoff parked at COMMIT does not answer before the row is durable: the reply arrives only after release and a separate connection then reads the fulfilled state at once", async () => {
  const order = await settledOrder(1);
  const barrier = armTestFault("db.before_commit", { kind: "block" });
  const orderOf: string[] = [];
  const settled = handoffRequest(order.participant_id, `durable-${tag}`).then((r) => { orderOf.push("response"); return r; });
  await barrier!.entered;
  assert.equal((await facts(order.participant_id, SELLER)).units.redeemed, 0);
  orderOf.push("release");
  barrier!.release();
  const r = await settled;
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(orderOf, ["release", "response"]);
  assert.equal((await facts(order.participant_id, SELLER)).units.redeemed, 1);
});

await pool.end();
await app.close();
console.log(`\nPICKUP_HANDOFF_CONCURRENCY passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
