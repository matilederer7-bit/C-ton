// Child harness for the checked-out client error survival proof. It runs the
// two most common shapes of a backend termination against a CHECKED-OUT pooled
// client — idle in transaction between two statements, and mid-statement — with
// NO process-level uncaughtException handler. If the pool leaves the checked-out
// client without an 'error' listener, Node terminates this process and the
// parent observes a non-zero exit instead of the "done" message.
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { pool, withTransaction } = await import("../../src/db.js");
const { withTx } = await import("../../src/app.js");

const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
await killer.connect();

type Result = { scenario: string; rejected: boolean; code: string | null; poolUsable: boolean };
const results: Result[] = [];

async function terminate(pid: number) {
  await killer.query(`SELECT pg_terminate_backend($1)`, [pid]);
}

async function probePool() {
  try {
    const r = await pool.query(`SELECT 1 AS ok`);
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

function summarize(scenario: string, error: unknown, poolUsable: boolean): Result {
  const err = error as any;
  return { scenario, rejected: Boolean(error), code: error ? String(err?.code || err?.message || "error") : null, poolUsable };
}

// 1. withTx: terminated while idle in transaction between two statements.
{
  let error: unknown = null;
  try {
    await withTx(async (c) => {
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await terminate(pid);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await c.query(`SELECT 2`);
    });
  } catch (e) { error = e; }
  results.push(summarize("withTx.idle_in_transaction", error, await probePool()));
}

// 2. withTx: terminated during an active statement.
{
  let error: unknown = null;
  try {
    await withTx(async (c) => {
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      const sleeping = c.query(`SELECT pg_sleep(5)`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await terminate(pid);
      await sleeping;
    });
  } catch (e) { error = e; }
  results.push(summarize("withTx.active_statement", error, await probePool()));
}

// 3. db.withTransaction: terminated between statements.
{
  let error: unknown = null;
  try {
    await withTransaction(async (c: any) => {
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await terminate(pid);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await c.query(`SELECT 3`);
    });
  } catch (e) { error = e; }
  results.push(summarize("withTransaction.idle_in_transaction", error, await probePool()));
}

// Let any late socket events (ECONNRESET / 'end') fire before we report.
await new Promise((resolve) => setTimeout(resolve, 400));

if (process.send) process.send({ type: "done", results, pid: process.pid });
await killer.end();
await pool.end();
process.exit(0);
