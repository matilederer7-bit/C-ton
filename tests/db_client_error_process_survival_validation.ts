// CHECKED-OUT POSTGRES CLIENT ERROR → PROCESS SURVIVAL
//
// pg-pool listens for a client's 'error' event only while that client is IDLE
// in the pool: it removes the listener on checkout and re-adds it on release.
// A backend connection termination (failover, restart, pg_terminate_backend,
// idle-in-transaction timeout) that lands while the client is CHECKED OUT —
// before BEGIN, after BEGIN, between two statements, before COMMIT, mid-statement,
// or while it holds a row lock — makes the pg Client emit 'error' with no
// listener, which Node turns into an uncaught exception that terminates the
// whole Web or Worker process.
//
// Invariant proven here: a database connection failure may (must) fail the
// request/transaction, but it must never terminate the application process, and
// it must never be reported as a success — nothing written inside the broken
// transaction may survive, no lock may stay orphaned, and the pool must keep
// serving fresh connections afterwards.
//
// Two layers of proof:
//   1. in-process: every boundary is driven deterministically (fault barriers
//      and in-transaction termination), an uncaughtException recorder counts
//      what WOULD have killed the process, and the db module's own guard
//      observations show the client 'error' events really happened (anti-vacuity).
//   2. real process: a forked child with NO uncaughtException handler runs the
//      idle-in-transaction and mid-statement terminations and must exit 0.
//
// NON-FINANCIAL. Disposable database. No provider, no money.

import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.PORT = "3129";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";

const dbModule: any = await import("../src/db.js");
const { pool: appPool, withTransaction, withClient } = dbModule;
// Tolerant lookup so this proof also COMPILES against a build without the guard
// (where it must fail on the uncaught-exception recorder, not on a missing export).
const dbClientErrorObservations: () => unknown[] =
  typeof dbModule.dbClientErrorObservations === "function" ? dbModule.dbClientErrorObservations : () => [];
const { withTx } = await import("../src/app.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

// This test owns termination. A 100ms pool idle timer can otherwise remove
// the selected backend between pg_stat_activity and pg_terminate_backend.
// Disable that competing timer, not the connection-error guard. pool.end()
// below still closes every surviving connection explicitly.
(appPool as any).options.idleTimeoutMillis = 0;
const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
await killer.connect();

const uncaught: string[] = [];
process.on("uncaughtException", (error: any) => { uncaught.push(String(error?.code || error?.message || error)); });

const acquired: any[] = [];
appPool.on("acquire", (client: any) => { acquired.push(client); });

let passed = 0;
let failed = 0;
// expectGuard: every in-process scenario must make THIS process's guard observe a
// client 'error' (anti-vacuity); the real-process scenario proves that in the
// child (its stderr must carry [db.client.error]) and opts out here.
async function run(name: string, fn: () => Promise<void>, opts: { expectGuard?: boolean } = {}) {
  const uncaughtBefore = uncaught.length;
  const guardBefore = dbClientErrorObservations().length;
  try {
    await fn();
    await settle();
    assert.equal(uncaught.length, uncaughtBefore, `${name}: uncaught exception(s) escaped: ${uncaught.slice(uncaughtBefore).join(", ")}`);
    if (opts.expectGuard !== false) {
      assert.ok(dbClientErrorObservations().length > guardBefore, `${name}: VACUOUS — no client 'error' event was observed, the termination never reached a checked-out client`);
    }
    assert.ok(await poolServes(), `${name}: pool no longer serves fresh connections`);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${(error as any)?.stack || (error as any)?.message || error}`);
  } finally {
    resetTestFaults();
  }
}

function settle(ms = 400) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function terminate(pid: number) {
  const result = await killer.query('SELECT pg_terminate_backend($1) AS terminated', [pid]);
  assert.equal(result.rows[0]?.terminated, true, 'selected backend must still be alive for termination');
}
async function poolServes() {
  const r = await appPool.query(`SELECT 1 AS ok`);
  return r.rows[0]?.ok === 1;
}
function lastAcquiredPid() {
  const client = acquired[acquired.length - 1];
  assert.ok(client, "no client was acquired from the app pool");
  return Number(client.processID);
}
function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
}

await killer.query(`CREATE TABLE IF NOT EXISTS public.zz_client_error_probe (id text PRIMARY KEY, note text)`);
await killer.query(`INSERT INTO public.zz_client_error_probe (id, note) VALUES ('locked-row', 'baseline') ON CONFLICT DO NOTHING`);

async function probeRowCount(id: string) {
  return Number((await killer.query(`SELECT COUNT(*)::int AS n FROM public.zz_client_error_probe WHERE id=$1`, [id])).rows[0].n);
}

// Drives withTx to a fault barrier, terminates the backend of the client that
// withTx checked out, releases the barrier and returns withTx's outcome.
async function terminateAtBarrier(point: "db.before_begin" | "db.after_begin" | "db.before_commit", body: (c: any) => Promise<void>) {
  const barrier = armTestFault(point, { kind: "block" });
  assert.ok(barrier, "barrier");
  const outcome = withTx(body).then(() => ({ ok: true as const }), (error: any) => ({ ok: false as const, code: String(error?.code || error?.message || error) }));
  await Promise.race([barrier!.entered, timeout(10_000, `${point} never reached`)]);
  await terminate(lastAcquiredPid());
  await settle(250);
  barrier!.release();
  return outcome;
}

await run("before BEGIN: termination of the just-checked-out client fails the transaction, not the process", async () => {
  const outcome = await terminateAtBarrier("db.before_begin", async (c) => { await c.query(`SELECT 1`); });
  assert.equal(outcome.ok, false, "withTx must reject when its connection died before BEGIN");
});

await run("after BEGIN: termination before the first statement fails the transaction, not the process", async () => {
  const id = `after-begin-${randomUUID()}`;
  const outcome = await terminateAtBarrier("db.after_begin", async (c) => {
    await c.query(`INSERT INTO public.zz_client_error_probe (id, note) VALUES ($1, 'must not persist')`, [id]);
  });
  assert.equal(outcome.ok, false, "withTx must reject");
  assert.equal(await probeRowCount(id), 0, "a write on a dead transaction leaked into the database");
});

await run("between statements: termination while idle in transaction fails the transaction, rolls back its writes, not the process", async () => {
  const id = `between-${randomUUID()}`;
  let rejected: any = null;
  try {
    await withTx(async (c) => {
      await c.query(`INSERT INTO public.zz_client_error_probe (id, note) VALUES ($1, 'must not persist')`, [id]);
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await terminate(pid);
      await settle(250);
      await c.query(`SELECT 2`);
    });
  } catch (error) { rejected = error; }
  assert.ok(rejected, "withTx must reject after its backend was terminated between statements");
  assert.equal(await probeRowCount(id), 0, "a write on a terminated transaction leaked into the database");
});

await run("before COMMIT: termination after every statement and before COMMIT fails the transaction, nothing persists, not the process", async () => {
  const id = `before-commit-${randomUUID()}`;
  const outcome = await terminateAtBarrier("db.before_commit", async (c) => {
    await c.query(`INSERT INTO public.zz_client_error_probe (id, note) VALUES ($1, 'must not persist')`, [id]);
  });
  assert.equal(outcome.ok, false, "withTx must not report success when COMMIT could not be sent");
  assert.equal(await probeRowCount(id), 0, "COMMIT was reported failed but the row persisted");
});

await run("mid-statement: termination during an active statement fails that statement with 57P01, not the process", async () => {
  let code: string | null = null;
  try {
    await withTx(async (c) => {
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      const sleeping = c.query(`SELECT pg_sleep(5)`);
      void sleeping.catch(() => undefined); // attach rejection handling before the killer races it
      await settle(200);
      await terminate(pid);
      await sleeping;
    });
  } catch (error: any) { code = String(error?.code || error?.message); }
  assert.equal(code, "57P01", `the active statement must see admin_shutdown, got ${code}`);
});

await run("locked transaction: termination while holding a row lock fails the transaction and releases the lock immediately", async () => {
  let rejected: any = null;
  try {
    await withTx(async (c) => {
      await c.query(`SELECT id FROM public.zz_client_error_probe WHERE id='locked-row' FOR UPDATE`);
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await terminate(pid);
      await settle(250);
      await c.query(`UPDATE public.zz_client_error_probe SET note='must not persist' WHERE id='locked-row'`);
    });
  } catch (error) { rejected = error; }
  assert.ok(rejected, "withTx must reject");
  const relock = await Promise.race([
    killer.query(`SELECT id, note FROM public.zz_client_error_probe WHERE id='locked-row' FOR UPDATE NOWAIT`),
    timeout(5_000, "row lock stayed orphaned after the backend termination")
  ]);
  assert.equal(relock.rows[0].note, "baseline", "an update on a terminated transaction persisted");
});

await run("after ROLLBACK: termination of the client once it is back in the pool is absorbed by the pool, not the process", async () => {
  let pid = 0;
  await withTx(async (c) => {
    pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    throw Object.assign(new Error("deliberate_rollback"), { code: "deliberate_rollback" });
  }).catch(() => undefined);
  await terminate(pid);
  await settle(300);
});

await run("db.withTransaction and db.withClient: the same guard covers the db module's own helpers", async () => {
  let rejectedTx: any = null;
  try {
    await withTransaction(async (c: any) => {
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await terminate(pid);
      await settle(250);
      await c.query(`SELECT 4`);
    });
  } catch (error) { rejectedTx = error; }
  assert.ok(rejectedTx, "withTransaction must reject");
  let rejectedClient: any = null;
  try {
    await withClient(async (c: any) => {
      const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await terminate(pid);
      await settle(250);
      await c.query(`SELECT 5`);
    });
  } catch (error) { rejectedClient = error; }
  assert.ok(rejectedClient, "withClient must reject");
});

await run("pool hygiene: after every termination the pool holds no dead clients and still serves concurrent work", async () => {
  const before = dbClientErrorObservations().length;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => appPool.query(`SELECT $1::int AS i`, [i])));
  assert.deepEqual(results.map((r: any) => r.rows[0].i), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(appPool.totalCount <= Number((appPool as any).options?.max || 10), `pool leaked clients: total=${appPool.totalCount}`);
  assert.equal(appPool.waitingCount, 0, "requests left waiting for a pool slot");
  // This scenario itself must not need the guard; make the vacuity check explicit
  // by terminating one idle pooled backend here (absorbed by pg-pool's idle listener).
  const idlePid = Number((await killer.query(
    `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'siton-%' AND state='idle' AND pid <> pg_backend_pid() LIMIT 1`
  )).rows[0]?.pid || 0);
  assert.ok(idlePid > 0, "no idle pooled backend to terminate");
  await terminate(idlePid);
  await settle(300);
  assert.ok(dbClientErrorObservations().length > before, "guard did not observe the idle termination");
});

// ── real process: no uncaughtException handler at all ────────────────────────

await run("REAL PROCESS: a child with no uncaughtException handler survives idle-in-transaction and mid-statement terminations and exits 0", async () => {
  const harness = new URL("./support/pg_client_error_child_harness.js", import.meta.url);
  const child = fork(harness, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_ENV: "test", DISABLE_OUTBOX_WORKER: "1", PORT: "3130" }
  });
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  let done: any = null;
  child.on("message", (message: any) => { if (message?.type === "done") done = message; });
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    timeout(90_000, "child did not exit")
  ]);
  assert.equal(exit.code, 0, `child process died (code=${exit.code} signal=${exit.signal}). stderr:\n${stderr.slice(-2000)}\nstdout:\n${stdout.slice(-800)}`);
  assert.ok(done, `child exited 0 but never reported done. stderr:\n${stderr.slice(-1500)}`);
  assert.equal(done.results.length, 4, JSON.stringify(done.results));
  for (const result of done.results) {
    assert.equal(result.rejected, true, `${result.scenario}: the transaction must fail, not succeed silently`);
    assert.equal(result.poolUsable, true, `${result.scenario}: pool must keep serving`);
  }
  console.log(`  child results: ${JSON.stringify(done.results)}`);
  // The child's own vacuity guard: its scenarios really emitted client errors
  // (the db guard logs them to stderr as [db.client.error]).
  assert.ok(/\[db\.client\.error\]/.test(stderr), `child never logged a checked-out client error — the termination did not reach a checked-out client. stderr:\n${stderr.slice(-1500)}`);
}, { expectGuard: false });


await run("during ROLLBACK: backend termination preserves the original error and rolls back writes", async () => {
  const id = 'rollback-' + randomUUID();
  const originalError = new Error('synthetic-original-transaction-failure');
  let observed: unknown;
  try {
    await withTransaction(async (c: any) => {
      await c.query("INSERT INTO public.zz_client_error_probe (id,note) VALUES ($1,'must roll back')", [id]);
      const originalQuery = c.query.bind(c);
      c.query = async (...args: any[]) => {
        if (String(args[0]).trim() === 'ROLLBACK') {
          await terminate(Number(c.processID));
          await settle(250);
        }
        return originalQuery(...args);
      };
      throw originalError;
    });
  } catch (error) { observed = error; }
  assert.equal(observed, originalError, 'rollback connection failure replaced or swallowed original error');
  assert.equal(await probeRowCount(id), 0, 'failed transaction persisted');
});

await killer.query(`DROP TABLE IF EXISTS public.zz_client_error_probe`).catch(() => undefined);
console.log(`\nSUMMARY db_client_error_process_survival passed=${passed} failed=${failed} uncaught=${uncaught.length} guard_observations=${dbClientErrorObservations().length}`);
await killer.end();
await appPool.end().catch(() => undefined);
process.exit(failed ? 1 : 0);
