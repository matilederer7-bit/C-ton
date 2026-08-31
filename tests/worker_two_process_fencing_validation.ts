import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import pg from "pg";

/**
 * R4D — two REAL Worker processes against one database.
 *
 * Proves under real process concurrency: competing claims with one owner per
 * job, bounded heartbeat renewal while a handler is slow, forced lease expiry
 * of a hard-killed owner, reclaim by the survivor, SIGTERM during active
 * ownership, restart, database connection interruption with recovery, and no
 * duplicate final side effect (exactly one completion audit per event).
 *
 * Synthetic jobs only: deadline_check events against a Draft deal are a pure
 * no-op success in the business layer. The deterministic "slow handler"
 * window is created by holding ACCESS EXCLUSIVE on siton.deals in a test
 * transaction: the handler's first read blocks while its lease keeps
 * heartbeating, exactly like a long-running job.
 */

const { Client, Pool } = pg;
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: adminUrl, max: 3 });

// The outbox enforces one pending event per (event_type, aggregate), so each
// synthetic deadline_check job gets its own Draft deal (a pure no-op lane).
async function createSyntheticDeals(count: number, tag: string): Promise<string[]> {
  const created = await admin.query(
    `INSERT INTO siton.deals
       (seller_id, title, state, price_per_unit, min_units, max_units,
        threshold_units, deadline, created_at, updated_at)
     SELECT 'seller-default', 'r4-two-process-proof:' || $2 || ':' || n, 'Draft',
            10.00, 1, 10, 3, now() + interval '7 day', now(), now()
     FROM generate_series(1, $1::int) AS n
     RETURNING deal_id`,
    [count, tag]
  );
  return created.rows.map((row) => String(row.deal_id));
}

const workerEnv = {
  ...process.env,
  NODE_ENV: "test",
  DISABLE_OUTBOX_WORKER: "1",
  LOG_LEVEL: "warn",
  OUTBOX_POLL_MS: "150",
  WORKER_CONCURRENCY: "3",
  WORKER_LEASE_MS: "4000",
  WORKER_STUCK_TIMEOUT_MS: "4000",
  WORKER_RECLAIM_EVERY_POLLS: "2",
  WORKER_HEARTBEAT_MS: "1500",
  WORKER_SHUTDOWN_TIMEOUT_MS: "2000"
};

type WorkerHandle = { child: ChildProcess; id: string; output: string[] };
const workers: WorkerHandle[] = [];

let spawnSequence = 0;
function spawnWorker(): WorkerHandle {
  const workerId = `r4proof-${process.pid}-${spawnSequence++}`;
  const child = spawn(process.execPath, [path.join(".tmp_test_dist", "src", "worker.js")], {
    env: { ...workerEnv, WORKER_ID: workerId },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const handle: WorkerHandle = { child, id: workerId, output: [] };
  child.stdout?.on("data", (chunk) => handle.output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => handle.output.push(String(chunk)));
  workers.push(handle);
  return handle;
}

async function poll(name: string, timeoutMs: number, fn: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for: ${name}`);
}

async function waitReady(handle: WorkerHandle) {
  await poll(`${handle.id} ready heartbeat`, 30_000, async () => {
    const r = await admin.query(
      `SELECT 1 FROM siton.worker_heartbeats WHERE worker_id=$1 AND status='ready'`,
      [handle.id]
    );
    return Number(r.rowCount || 0) === 1;
  });
}

async function insertEventsForDeals(dealIds: string[], tag: string) {
  const ids: string[] = [];
  for (const [index, dealId] of dealIds.entries()) {
    const inserted = await admin.query(
      `INSERT INTO siton.outbox_events
         (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, correlation_id)
       VALUES ('deadline_check','deal',$1,$2,'pending',0,now(),$3)
       RETURNING event_uuid`,
      [dealId, JSON.stringify({ deal_id: dealId, synthetic: tag }), `r4proof:${tag}:${index}`]
    );
    ids.push(String(inserted.rows[0].event_uuid));
  }
  return ids;
}

async function insertEvents(count: number, tag: string) {
  return insertEventsForDeals(await createSyntheticDeals(count, tag), tag);
}

async function sentCount(ids: string[]) {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM siton.outbox_events
     WHERE event_uuid = ANY($1::uuid[]) AND status='sent' AND sent=true`,
    [ids]
  );
  return Number(r.rows[0].n);
}

async function assertExactlyOnce(ids: string[]) {
  const duplicates = await admin.query(
    `SELECT subject_id, count(*)::int AS completions
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND action='completion' AND subject_id = ANY($1::text[])
     GROUP BY subject_id
     HAVING count(*) <> 1`,
    [ids]
  );
  assert.equal(duplicates.rowCount, 0, `duplicate/missing completions: ${JSON.stringify(duplicates.rows)}`);
  const completed = await admin.query(
    `SELECT count(DISTINCT subject_id)::int AS n
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND action='completion' AND subject_id = ANY($1::text[])`,
    [ids]
  );
  assert.equal(Number(completed.rows[0].n), ids.length, "every event must complete exactly once");
}

function run(name: string) {
  console.log(`PASS ${name}`);
}

// --- P0: two real worker processes come up and heartbeat ---
const workerA = spawnWorker();
const workerB = spawnWorker();
await waitReady(workerA);
await waitReady(workerB);
run("two real Worker processes start, connect and heartbeat ready");

// --- P1: competing claims across 30 synthetic jobs, exactly-once completion ---
const p1 = await insertEvents(30, "p1");
await poll("p1 all sent", 45_000, async () => (await sentCount(p1)) === 30);
await assertExactlyOnce(p1);
const p1Claims = await admin.query(
  `SELECT DISTINCT worker_id FROM siton.operational_recovery_audit
   WHERE subject_type='outbox_event' AND action='claim' AND subject_id = ANY($1::text[])`,
  [p1]
);
console.log(`INFO p1 claim distribution: ${p1Claims.rows.map((row) => row.worker_id).join(", ")}`);
run("30 competing jobs complete exactly once across two live workers");

// --- P2: both workers blocked mid-handler; hard-kill one; survivor reclaims ---
const p2Deals = await createSyntheticDeals(6, "p2");
const locker = new Client({ connectionString: adminUrl });
await locker.connect();
await locker.query("BEGIN");
await locker.query("LOCK TABLE siton.deals IN ACCESS EXCLUSIVE MODE");
const p2 = await insertEventsForDeals(p2Deals, "p2");
await poll("p2 all six claimed and blocked", 20_000, async () => {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM siton.outbox_events
     WHERE event_uuid = ANY($1::uuid[]) AND status='processing'`,
    [p2]
  );
  return Number(r.rows[0].n) === 6;
});
const split = await admin.query(
  `SELECT worker_id, count(*)::int AS n FROM siton.outbox_events
   WHERE event_uuid = ANY($1::uuid[]) AND status='processing' GROUP BY worker_id ORDER BY worker_id`,
  [p2]
);
assert.equal(split.rowCount, 2, `expected both workers to hold blocked claims: ${JSON.stringify(split.rows)}`);
run("both live workers hold blocked active ownership (3 + 3)");

workerB.child.kill("SIGKILL");
// Hold the lock past one full lease so the dead owner's leases expire while
// the survivor's blocked leases keep renewing through heartbeats.
await new Promise((resolve) => setTimeout(resolve, 5_500));
const leaseState = await admin.query(
  `SELECT
     count(*) FILTER (WHERE worker_id=$2 AND lease_expires_at >  now())::int AS survivor_valid,
     count(*) FILTER (WHERE worker_id=$3 AND lease_expires_at <= now())::int AS dead_expired
   FROM siton.outbox_events
   WHERE event_uuid = ANY($1::uuid[]) AND status='processing'`,
  [p2, workerA.id, workerB.id]
);
assert.equal(Number(leaseState.rows[0].survivor_valid), 3, "survivor leases must stay heartbeat-renewed while blocked");
assert.equal(Number(leaseState.rows[0].dead_expired), 3, "dead owner leases must expire without heartbeats");
run("heartbeat renewal keeps the blocked survivor owned; the killed owner expires");

await locker.query("ROLLBACK");
await poll("p2 all sent after reclaim", 45_000, async () => (await sentCount(p2)) === 6);
await assertExactlyOnce(p2);
const reclaims = await admin.query(
  `SELECT count(*)::int AS n FROM siton.operational_recovery_audit
   WHERE subject_type='outbox_event' AND action='reclaim' AND subject_id = ANY($1::text[])`,
  [p2]
);
assert.ok(Number(reclaims.rows[0].n) >= 3, "the dead owner's jobs must be reclaimed");
assert.equal(workerA.child.exitCode, null, "survivor must still be alive");
run("hard-killed owner is fenced out; survivor reclaims and completes exactly once");

// --- P3: SIGTERM during active ownership; restart completes the work ---
const p3Deals = await createSyntheticDeals(3, "p3");
await locker.query("BEGIN");
await locker.query("LOCK TABLE siton.deals IN ACCESS EXCLUSIVE MODE");
const p3 = await insertEventsForDeals(p3Deals, "p3");
await poll("p3 all claimed by survivor", 20_000, async () => {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM siton.outbox_events
     WHERE event_uuid = ANY($1::uuid[]) AND status='processing' AND worker_id=$2`,
    [p3, workerA.id]
  );
  return Number(r.rows[0].n) === 3;
});
workerA.child.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 1_500));
await locker.query("ROLLBACK");
await locker.end();

const workerC = spawnWorker();
await waitReady(workerC);
await poll("p3 all sent after restart", 60_000, async () => (await sentCount(p3)) === 3);
await assertExactlyOnce(p3);
await poll("SIGTERMed worker exits", 45_000, async () => workerA.child.exitCode !== null || workerA.child.signalCode !== null);
assert.ok(
  workerA.child.exitCode === 0 || workerA.child.signalCode === "SIGTERM" || workerA.child.exitCode === 1,
  `unexpected SIGTERM exit: code=${workerA.child.exitCode} signal=${workerA.child.signalCode}`
);
run("SIGTERM during active ownership never duplicates completion; restart finishes the queue");

// --- P3b: poison inputs — unknown type rejected at the boundary, malformed payload DLQ-archived ---
const poisonDeals = await createSyntheticDeals(2, "poison");
// Unknown job types cannot even enter the queue: the event_type CHECK
// constraint fails closed at insert. workerProcessEvent's PermanentFailError
// for unsupported types remains defense-in-depth behind this boundary.
await assert.rejects(
  admin.query(
    `INSERT INTO siton.outbox_events
       (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('r4_unknown_synthetic','deal',$1,'{}','pending',0,now())`,
    [poisonDeals[0]]
  ),
  (error: any) => error?.constraint === "outbox_events_event_type_check"
);
const malformedPayload = await admin.query(
  `INSERT INTO siton.outbox_events
     (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
   VALUES ('deadline_check','deal',$1,'[]','pending',0,now())
   RETURNING event_uuid`,
  [poisonDeals[1]]
);
const poison = [String(malformedPayload.rows[0].event_uuid)];
await poll("malformed-payload event archived to DLQ", 30_000, async () => {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM siton.outbox_dlq WHERE event_uuid = ANY($1::uuid[])`,
    [poison]
  );
  return Number(r.rows[0].n) === 1;
});
const poisonGone = await admin.query(
  `SELECT count(*)::int AS n FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[])`,
  [poison]
);
assert.equal(Number(poisonGone.rows[0].n), 0, "poison event must leave the active queue");
assert.equal(workerC.child.exitCode, null, "worker must not crash-loop on poison input");
run("unknown type rejected at the DB boundary; malformed payload DLQ-archived without crash");

// --- P4: database connection interruption; the worker survives and recovers ---
await admin.query(
  `SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
     AND application_name LIKE 'siton-%'`
);
await new Promise((resolve) => setTimeout(resolve, 500));
assert.equal(workerC.child.exitCode, null, "worker must survive server-side connection kill");
const p4 = await insertEvents(5, "p4");
await poll("p4 all sent after reconnect", 45_000, async () => (await sentCount(p4)) === 5);
await assertExactlyOnce(p4);
run("server-side connection kill degrades and recovers; no job lost, none duplicated");

// --- Final: shutdown, global invariants, zero residue in queue mechanics ---
workerC.child.kill("SIGTERM");
await poll("last worker exits", 45_000, async () => workerC.child.exitCode !== null || workerC.child.signalCode !== null);

const allIds = [...p1, ...p2, ...p3, ...p4];
await assertExactlyOnce(allIds);
const finalState = await admin.query(
  `SELECT
     (SELECT count(*)::int FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[]) AND status <> 'sent') AS unsent,
     (SELECT count(*)::int FROM siton.outbox_dlq WHERE event_uuid = ANY($1::uuid[])) AS dlq,
     (SELECT count(*)::int FROM siton.outbox_events WHERE status='processing') AS processing_residue`,
  [allIds]
);
assert.equal(Number(finalState.rows[0].unsent), 0);
assert.equal(Number(finalState.rows[0].dlq), 0);
assert.equal(Number(finalState.rows[0].processing_residue), 0);

// Observability safety: worker output never leaks the database secret.
const password = (() => { try { return new URL(adminUrl).password; } catch { return ""; } })();
if (password) {
  for (const handle of workers) {
    assert.ok(!handle.output.join("").includes(password), `${handle.id} leaked credential material to logs`);
  }
}
run("44 synthetic jobs, zero DLQ, zero residue, zero credential leakage");

for (const handle of workers) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
}
// Synthetic rows live only in this disposable per-test database, which the
// harness drops after the run; outbox/audit rows are intentionally not
// deleted here because the append-only triggers correctly forbid it.
await admin.end();
console.log("PASS R4 two-process worker fencing, reclaim, SIGTERM, restart and reconnect proof");
