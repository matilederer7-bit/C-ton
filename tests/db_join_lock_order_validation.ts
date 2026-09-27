// Red-team C-2 lock-order proof (Codex on PR #97, round 5).
//
// The join inserts its participant (a foreign-key KEY SHARE on the deal row)
// BEFORE taking the deal row FOR NO KEY UPDATE. Review asked whether a third
// transaction queued on FOR UPDATE (atomic transitions, seller close, receipt
// paths) could then deadlock the join: the waiter holds the heavyweight
// tuple lock while it sleeps on the join's key share, and the join's own
// lock request would queue behind it. It does not: PostgreSQL lets a
// transaction that ALREADY holds a lock on the tuple upgrade it without
// joining the tuple-lock queue (it waits directly on the conflicting
// transaction ids, as pg_stat_activity shows: wait_event=transactionid,
// never tuple), so the join finishes and the FOR UPDATE waiter proceeds
// afterwards. This file pins that three-party scenario — a second join
// holding the row, a FOR UPDATE waiter, and the pre-lock join — so a future
// engine or lock-mode change that reintroduces a deadlock fails loudly.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 6 });

async function runTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function seedDeal() {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-c2','PendingTarget','C-2 lock-order fixture',10,2,50,2,now()+interval '1 day',now())`,
    [dealId]
  );
  return dealId;
}

function insertParticipant(c: pg.PoolClient, dealId: string) {
  return c.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state)
     VALUES ($1,$2,$3,1,'NotJoined','NoFinancial')`,
    [randomUUID(), dealId, `buyer-${randomUUID().slice(0, 8)}`]
  );
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitEvents(c: pg.PoolClient, pids: number[]) {
  const r = await c.query(
    `SELECT pid, wait_event_type, wait_event FROM pg_stat_activity WHERE pid = ANY($1::int[])`,
    [pids]
  );
  return Object.fromEntries(r.rows.map((row: any) => [row.pid, `${row.wait_event_type || ""}:${row.wait_event || ""}`]));
}

async function backendPid(c: pg.PoolClient) {
  return Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
}

await runTest("pre-lock FK insert + FOR UPDATE waiter + a second join holding the row: no deadlock, everyone finishes in lock order", async () => {
  const dealId = await seedDeal();
  const joinB = await pool.connect();      // inside its critical section
  const lifecycleC = await pool.connect(); // e.g. an atomic transition / seller close
  const joinA = await pool.connect();      // the join under test: FK insert first, deal lock later
  const monitor = await pool.connect();
  const order: string[] = [];
  try {
    const [pidA, pidC] = [await backendPid(joinA), await backendPid(lifecycleC)];
    await joinB.query("BEGIN");
    await joinB.query(`SELECT state FROM siton.deals WHERE deal_id=$1 FOR NO KEY UPDATE`, [dealId]);
    await insertParticipant(joinB, dealId);

    await joinA.query("BEGIN");
    await insertParticipant(joinA, dealId); // KEY SHARE on the deal row, before the lock (shipped order)

    await lifecycleC.query("BEGIN");
    const cLock = settle(lifecycleC.query(`SELECT deal_id FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId])).then((r) => { order.push("C"); return r; });
    await sleep(200); // C holds the tuple lock and sleeps on B and A

    const aLock = settle(joinA.query(`SELECT state FROM siton.deals WHERE deal_id=$1 FOR NO KEY UPDATE`, [dealId])).then((r) => { order.push("A"); return r; });
    await sleep(300);
    const waits = await waitEvents(monitor, [pidA, pidC]);
    assert.equal(waits[pidC], "Lock:transactionid", `C sleeps on the lockers' transaction ids: ${JSON.stringify(waits)}`);
    assert.equal(waits[pidA], "Lock:transactionid", `A (already a locker of the row) waits on B's transaction id, NOT on the tuple lock C holds: ${JSON.stringify(waits)}`);

    await joinB.query("COMMIT"); // B leaves its critical section
    const a = await Promise.race([aLock, sleep(5000).then(() => ({ ok: false, error: new Error("join A did not get the deal lock within 5s") }))]) as any;
    assert.ok(a.ok, `join A must acquire the deal lock after B commits: ${String(a.error?.code || a.error?.message)}`);
    await joinA.query("COMMIT"); // A finishes its join; only now can C proceed

    const c = await Promise.race([cLock, sleep(5000).then(() => ({ ok: false, error: new Error("FOR UPDATE waiter did not proceed within 5s") }))]) as any;
    assert.ok(c.ok, `the FOR UPDATE waiter must proceed once both joins committed: ${String(c.error?.code || c.error?.message)}`);
    await lifecycleC.query("ROLLBACK");

    assert.deepEqual(order, ["A", "C"], "the join that already held a lock on the row is served before the FOR UPDATE waiter");
    const count = await pool.query(`SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId]);
    assert.equal(count.rows[0].n, 2, "both joins committed their participants");
  } finally {
    for (const c of [joinA, joinB, lifecycleC, monitor]) { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  }
});

await runTest("two pre-lock joins racing for the deal lock serialise on FOR NO KEY UPDATE (no KEY SHARE conflict)", async () => {
  const dealId = await seedDeal();
  const joinA = await pool.connect();
  const joinB = await pool.connect();
  try {
    await joinA.query("BEGIN");
    await joinB.query("BEGIN");
    await insertParticipant(joinA, dealId);
    await insertParticipant(joinB, dealId); // multixact of two KEY SHAREs
    await joinA.query(`SELECT state FROM siton.deals WHERE deal_id=$1 FOR NO KEY UPDATE`, [dealId]); // compatible with B's key share: immediate
    const bLock = settle(joinB.query(`SELECT state FROM siton.deals WHERE deal_id=$1 FOR NO KEY UPDATE`, [dealId]));
    await sleep(200);
    await joinA.query("COMMIT");
    const b = await Promise.race([bLock, sleep(5000).then(() => ({ ok: false, error: new Error("join B did not get the deal lock within 5s") }))]) as any;
    assert.ok(b.ok, `the second join proceeds after the first commits: ${String(b.error?.code || b.error?.message)}`);
    await joinB.query("COMMIT");
    const count = await pool.query(`SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId]);
    assert.equal(count.rows[0].n, 2);
  } finally {
    for (const c of [joinA, joinB]) { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  }
});

await pool.end();
console.log("PASS db join lock order (C-2)");
