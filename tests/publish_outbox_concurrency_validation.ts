// PUBLISH / OUTBOX CONCURRENCY — deterministic proof that concurrent publishes
// of one deal converge when the one-pending-per-aggregate-event index wins.
//
// The failure this suite pins (GitHub CI run 34039959768, security group):
//
//   five PARALLEL publishes of one deal produce one publication:
//   a parallel publish faulted: 500 {"ok":false,"error":"internal_error"}
//   duplicate key value violates unique constraint
//   "ux_outbox_one_pending_per_aggregate_event"  (SQLSTATE 23505)
//
// Why a plain Promise.all is not enough: whether five injected requests really
// overlap inside their atomic transactions depends on machine speed. The race
// showed on the Linux runner and hid on a Windows laptop. This suite removes
// timing from the question. One publish is parked INSIDE its atomic transaction
// — audit row written, pending deadline_check inserted, deal row locked, nothing
// committed — by the block fault at atomic.after_durable_writes_before_commit.
// Competitors are then launched and the suite waits until PostgreSQL itself
// reports them blocked on a lock (pg_stat_activity.wait_event_type = 'Lock').
// Only then is the winner released. The contention point is reached by
// construction on every run and every platform, with no sleep.
//
// Every scenario asserts durable effects in the DATABASE, not from status codes:
// one publication, one published_at, one deal.publish audit row, exactly one
// logical deadline_check outbox event, no torn or duplicated rows.
//
// NON-FINANCIAL. Publish, cancel-of-a-draft, draft edit and the deadline_check
// worker path only. No provider, no money, no e-mail. Disposable database.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3127";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-publish-race";
process.env.ADMIN_API_KEY = "publish-race-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-publish-race";

const { app, processOutboxEventById } = await import("../src/app.js");
const { pool: appPool } = await import("../src/db.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 20
});

// The app pool bounds how many competitors can be inside the database at once:
// one connection is held by the parked winner, the rest can block on it. Any
// further competitor waits in-process for a pool slot and is invisible to
// pg_stat_activity — so the deterministic wait targets min(N-1, pool-1).
const APP_POOL_MAX = Number((appPool as any).options?.max || 10);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.stack || (error as any)?.message || error}`); }
  finally { resetTestFaults(); }
}

// ── fixture: an authenticated seller whose profile satisfies the publish gate ─

const SELLER = `seller-race-${randomUUID().slice(0, 8)}`;
const SELLER_EMAIL = `${SELLER}@siton.test`;
const SELLER_CODE = "PublishRacePass123!";

const { cookie: adminCookie } = await establishNamedAdminSession(app, pool);
const provision = await app.inject({
  method: "POST",
  url: `/api/admin/seller-auth/${SELLER}/provision`,
  headers: { cookie: adminCookie },
  payload: { display_name: SELLER, login_email: SELLER_EMAIL, access_code: SELLER_CODE, auth_enabled: true }
} as any);
assert.equal(provision.statusCode, 200, provision.body);

const login = await app.inject({
  method: "POST",
  url: "/api/seller/session/login",
  payload: { identifier: SELLER_EMAIL, access_code: SELLER_CODE }
} as any);
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";

await pool.query(
  `UPDATE siton.seller_accounts
   SET business_name = COALESCE(NULLIF(business_name, ''), 'Publish Race Ltd'),
       support_email = COALESCE(NULLIF(support_email, ''), $2)
   WHERE seller_id = $1`,
  [SELLER, SELLER_EMAIL]
);

type Resp = { statusCode: number; body: string; json: () => any };

function first<T>(items: T[], label: string): T {
  const item = items[0];
  assert.ok(item !== undefined, `${label}: expected at least one item`);
  return item as T;
}

async function freshDeal(label: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: {
      title: `Publish race ${label} ${randomUUID().slice(0, 8)}`,
      description: "publish race probe deal",
      price_per_unit: 50,
      min_units: 1,
      max_units: 20,
      threshold_units: 5,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      seller_terms_accepted: true
    }
  } as any);
  assert.ok(created.statusCode >= 200 && created.statusCode < 300, `create failed: ${created.body}`);
  const body = created.json() as any;
  const dealId = String(body.deal_id ?? body.deal?.deal_id ?? "");
  assert.match(dealId, /^[0-9a-f-]{36}$/, `no deal_id in create response: ${created.body.slice(0, 300)}`);
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
     VALUES ($1,'pickup','רחוב הבדיקה 1, תל אביב',0,0) ON CONFLICT DO NOTHING`,
    [dealId]
  );
  return dealId;
}

function publish(dealId: string, opts: { key?: string; requestId?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = {
    cookie,
    "content-type": "application/json",
    "x-request-id": opts.requestId || randomUUID()
  };
  if (opts.key) headers["idempotency-key"] = opts.key;
  return app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers,
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  } as any) as unknown as Promise<Resp>;
}

function cancel(dealId: string, key?: string): Promise<Resp> {
  const headers: Record<string, string> = { cookie, "content-type": "application/json", "x-request-id": randomUUID() };
  if (key) headers["idempotency-key"] = key;
  return app.inject({ method: "POST", url: `/deals/${dealId}/cancel`, headers, payload: {} } as any) as unknown as Promise<Resp>;
}

function editDraft(dealId: string, title: string): Promise<Resp> {
  return app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/draft`,
    headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { title }
  } as any) as unknown as Promise<Resp>;
}

// ── database truth ───────────────────────────────────────────────────────────

type OutboxRow = { event_uuid: string; event_type: string; status: string; available_at: string };

async function facts(dealId: string) {
  const deal = await pool.query(`SELECT state, published_at, title FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const audits = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.audit_log
     WHERE entity_type='deal' AND entity_id=$1 AND action_name='deal.publish'`,
    [dealId]
  );
  const outbox = await pool.query(
    `SELECT event_uuid, event_type, status, available_at FROM siton.outbox_events
     WHERE aggregate_type='deal' AND aggregate_id=$1 ORDER BY created_at`,
    [dealId]
  );
  const rows = outbox.rows as OutboxRow[];
  return {
    state: String(deal.rows[0]?.state ?? ""),
    title: String(deal.rows[0]?.title ?? ""),
    publishedAt: deal.rows[0]?.published_at ? new Date(deal.rows[0].published_at).toISOString() : null,
    publishAudits: audits.rows[0].n as number,
    outbox: rows,
    deadlineChecks: rows.filter((row) => row.event_type === "deadline_check"),
    pendingDeadlineChecks: rows.filter((row) => row.event_type === "deadline_check" && (row.status === "pending" || row.status === "processing")),
    cancelRefunds: rows.filter((row) => row.event_type === "cancel_refund")
  };
}

function assertPublishedExactlyOnce(f: Awaited<ReturnType<typeof facts>>, label: string) {
  assert.equal(f.state, "PendingTarget", `${label}: deal state`);
  assert.ok(f.publishedAt, `${label}: published_at was never set`);
  assert.equal(f.publishAudits, 1, `${label}: deal.publish audit rows`);
  assert.equal(f.deadlineChecks.length, 1, `${label}: deadline_check outbox rows (${JSON.stringify(f.outbox)})`);
  assert.equal(f.pendingDeadlineChecks.length, 1, `${label}: pending deadline_check rows`);
  assert.equal(f.cancelRefunds.length, 0, `${label}: cancel_refund rows on a published deal`);
}

function faultsOf(responses: Resp[]) {
  return responses.filter((response) => response.statusCode >= 500);
}
function okCount(responses: Resp[]) {
  return responses.filter((response) => response.statusCode >= 200 && response.statusCode < 300).length;
}
function conflictCount(responses: Resp[]) {
  return responses.filter((response) => response.statusCode === 409).length;
}
function assertNoFault(responses: Resp[], label: string) {
  const faults = faultsOf(responses);
  assert.equal(
    faults.length,
    0,
    `${label}: ${faults.length} request(s) faulted from a benign race: ${faults.map((f) => `${f.statusCode} ${f.body}`).join(" | ")}`
  );
}
function assertReplayOf(response: Resp, label: string) {
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${label}: expected the winner's answer, got ${response.statusCode} ${response.body}`);
  const json = response.json();
  assert.equal(json?.response?.ok, true, `${label}: replay body is not the canonical publish answer: ${response.body}`);
}
function assertStateConflict(response: Resp, label: string) {
  assert.equal(response.statusCode, 409, `${label}: expected 409 STATE_CONFLICT, got ${response.statusCode} ${response.body}`);
  assert.equal(response.json()?.code, "STATE_CONFLICT", `${label}: conflict code: ${response.body}`);
}

// ── deterministic contention harness ─────────────────────────────────────────

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

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
}

// Parks `held` inside its atomic transaction (every durable write done, nothing
// committed), launches the competitors, waits until PostgreSQL reports
// `expectedWaiters` of them blocked, releases the held request and returns
// every response plus what the blocked backends were executing.
async function raceAgainstHeld<T extends Resp>(opts: {
  label: string;
  dealId: string;
  held: () => Promise<T>;
  competitors: Array<() => Promise<Resp>>;
  expectedWaiters: number;
}) {
  const barrier = armTestFault("atomic.after_durable_writes_before_commit", { kind: "block" });
  assert.ok(barrier, "block fault did not return a barrier");
  let released = false;
  const release = () => { if (!released) { released = true; barrier!.release(); } };
  try {
    const heldPromise = opts.held();
    const entered = await Promise.race([
      barrier!.entered.then(() => "entered" as const),
      heldPromise.then((response) => response),
      timeout(20_000, `${opts.label}: held request never reached the atomic commit point`)
    ]);
    if (entered !== "entered") {
      const response = entered as Resp;
      throw new Error(`${opts.label}: held request finished (${response.statusCode} ${response.body}) without entering the atomic commit window`);
    }
    // READ COMMITTED truth from a third connection: nothing the parked winner
    // wrote is visible yet — the competitors really do start from "Draft".
    const invisible = await facts(opts.dealId);
    const competitorPromises = opts.competitors.map((fn) => fn());
    const waiters = await waitForLockWaiters(opts.expectedWaiters, opts.label);
    release();
    const settled = await Promise.all([heldPromise, ...competitorPromises]);
    const heldResponse = settled[0] as T;
    const competitorResponses = settled.slice(1) as Resp[];
    return { heldResponse, competitorResponses, waiters, invisible };
  } finally {
    release();
    resetTestFaults();
  }
}

function describeWaiters(waiters: Awaited<ReturnType<typeof lockWaiters>>) {
  const statements = new Map<string, number>();
  for (const waiter of waiters) {
    const key = waiter.query.replace(/\s+/g, " ").trim().slice(0, 72);
    statements.set(key, (statements.get(key) || 0) + 1);
  }
  return [...statements.entries()].map(([statement, n]) => `${n}× "${statement}"`).join("; ");
}

// ── S0: vacuity guard ────────────────────────────────────────────────────────

await run("VACUITY GUARD: this fixture can publish a deal at all", async () => {
  const dealId = await freshDeal("vacuity");
  const response = await publish(dealId);
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `publish failed: ${response.statusCode} ${response.body}`);
  assertPublishedExactlyOnce(await facts(dealId), "sequential publish");
});

// ── S1/S2: the CI failure, reproduced by construction ────────────────────────

await run("DETERMINISTIC RACE: a publish that loses to an in-flight publish (same request identity) converges to the winner's answer, never 500", async () => {
  const dealId = await freshDeal("race-same-key");
  const { heldResponse, competitorResponses, waiters, invisible } = await raceAgainstHeld({
    label: "race-same-key",
    dealId,
    held: () => publish(dealId),
    competitors: [() => publish(dealId)],
    expectedWaiters: 1
  });
  console.log(`  race-same-key: competitor blocked in ${describeWaiters(waiters)}`);
  assert.equal(invisible.state, "Draft", "winner's uncommitted transition leaked to a third connection");
  assert.equal(invisible.deadlineChecks.length, 0, "winner's uncommitted outbox row leaked to a third connection");
  assert.ok(waiters.length >= 1, "competitor never contended inside the database - the race was not reached");

  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `winner failed: ${heldResponse.statusCode} ${heldResponse.body}`);
  assertNoFault(competitorResponses, "race-same-key");
  assertReplayOf(first(competitorResponses, "competitor"), "race-same-key competitor");
  assertPublishedExactlyOnce(await facts(dealId), "race-same-key");
});

await run("DETERMINISTIC RACE: a publish that loses under a DIFFERENT idempotency key is refused as a state conflict, not a 500", async () => {
  const dealId = await freshDeal("race-distinct-key");
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "race-distinct-key",
    dealId,
    held: () => publish(dealId, { key: `publish-a-${randomUUID()}` }),
    competitors: [() => publish(dealId, { key: `publish-b-${randomUUID()}` })],
    expectedWaiters: 1
  });
  console.log(`  race-distinct-key: competitor blocked in ${describeWaiters(waiters)}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `winner failed: ${heldResponse.statusCode} ${heldResponse.body}`);
  assertNoFault(competitorResponses, "race-distinct-key");
  assertStateConflict(first(competitorResponses, "competitor"), "race-distinct-key competitor");
  const f = await facts(dealId);
  assertPublishedExactlyOnce(f, "race-distinct-key");
  // Atomicity of the LOSER: its audit row and outbox row were rolled back with
  // it — the counts above are exactly one each, not one plus a torn remainder.
});

// ── S3: deterministic matrix 2 / 5 / 10 / 25 ─────────────────────────────────

for (const n of [2, 5, 10, 25]) {
  const expectedWaiters = Math.min(n - 1, APP_POOL_MAX - 1);

  await run(`PARALLEL_${n} deterministic, same request identity: ${n} publishes → ${n} identical answers, one publication`, async () => {
    const dealId = await freshDeal(`matrix-same-${n}`);
    const requestId = randomUUID();
    const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
      label: `matrix-same-${n}`,
      dealId,
      held: () => publish(dealId, { requestId }),
      competitors: Array.from({ length: n - 1 }, () => () => publish(dealId, { requestId })),
      expectedWaiters
    });
    console.log(`  matrix-same-${n}: ${waiters.length} blocked (expected >= ${expectedWaiters}); ${describeWaiters(waiters)}`);
    const all = [heldResponse, ...competitorResponses];
    assertNoFault(all, `matrix-same-${n}`);
    assert.equal(okCount(all), n, `matrix-same-${n}: every same-identity publish must receive the winner's answer (ok=${okCount(all)}, 409=${conflictCount(all)})`);
    assertPublishedExactlyOnce(await facts(dealId), `matrix-same-${n}`);

    // Publish immediately after the concurrent winner: replay on the same key,
    // conflict on a new one — and still exactly one publication.
    assertReplayOf(await publish(dealId), `matrix-same-${n} follow-up replay`);
    assertStateConflict(await publish(dealId, { key: `late-${randomUUID()}` }), `matrix-same-${n} follow-up new key`);
    assertPublishedExactlyOnce(await facts(dealId), `matrix-same-${n} after follow-ups`);
  });

  await run(`PARALLEL_${n} deterministic, distinct request ids: exactly one 2xx, ${n - 1} state conflicts, zero 500`, async () => {
    const dealId = await freshDeal(`matrix-distinct-${n}`);
    const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
      label: `matrix-distinct-${n}`,
      dealId,
      held: () => publish(dealId, { key: `k-${randomUUID()}` }),
      competitors: Array.from({ length: n - 1 }, () => () => publish(dealId, { key: `k-${randomUUID()}` })),
      expectedWaiters
    });
    console.log(`  matrix-distinct-${n}: ${waiters.length} blocked (expected >= ${expectedWaiters}); ${describeWaiters(waiters)}`);
    const all = [heldResponse, ...competitorResponses];
    assertNoFault(all, `matrix-distinct-${n}`);
    assert.equal(okCount(all), 1, `matrix-distinct-${n}: exactly one publish may win (ok=${okCount(all)})`);
    assert.equal(conflictCount(all), n - 1, `matrix-distinct-${n}: every loser must be a 409 state conflict`);
    for (const response of competitorResponses) assertStateConflict(response, `matrix-distinct-${n} loser`);
    assertPublishedExactlyOnce(await facts(dealId), `matrix-distinct-${n}`);
  });
}

// ── S4: free-running seeded rounds (complements the deterministic matrix) ───

function seededShuffle<T>(items: T[], seed: number) {
  const out = items.slice();
  let x = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

for (const n of [2, 5, 10, 25]) {
  await run(`PARALLEL_${n} free-running, 3 seeded rounds (same key / distinct keys / mixed): zero 500, one publication each`, async () => {
    for (let round = 0; round < 3; round += 1) {
      const dealId = await freshDeal(`free-${n}-r${round}`);
      const mode = round === 0 ? "same" : round === 1 ? "distinct" : "mixed";
      const launches = Array.from({ length: n }, (_, index) => () => {
        if (mode === "same") return publish(dealId);
        if (mode === "distinct") return publish(dealId, { key: `free-${randomUUID()}` });
        return index % 2 === 0 ? publish(dealId) : publish(dealId, { key: `free-${randomUUID()}` });
      });
      const responses = await Promise.all(seededShuffle(launches, 0x5eed + n * 31 + round).map((fn) => fn()));
      assertNoFault(responses, `free-${n} round ${round} (${mode})`);
      assert.ok(okCount(responses) >= 1, `free-${n} round ${round}: nobody published`);
      if (mode === "same") assert.equal(okCount(responses), n, `free-${n} round ${round}: same-key publishes must all converge (ok=${okCount(responses)})`);
      if (mode === "distinct") assert.equal(okCount(responses), 1, `free-${n} round ${round}: distinct keys must yield one winner (ok=${okCount(responses)})`);
      assert.equal(okCount(responses) + conflictCount(responses), n, `free-${n} round ${round}: every answer must be 2xx or 409`);
      assertPublishedExactlyOnce(await facts(dealId), `free-${n} round ${round} (${mode})`);
    }
  });
}

// ── S5: publish after already published ──────────────────────────────────────

await run("publish after already published: same key replays, new key conflicts, nothing durable moves", async () => {
  const dealId = await freshDeal("after-published");
  const initial = await publish(dealId);
  assert.ok(initial.statusCode >= 200 && initial.statusCode < 300, initial.body);
  const before = await facts(dealId);
  assertPublishedExactlyOnce(before, "after-published first");

  assertReplayOf(await publish(dealId), "after-published same key");
  assertStateConflict(await publish(dealId, { key: `again-${randomUUID()}` }), "after-published new key");

  const after = await facts(dealId);
  assertPublishedExactlyOnce(after, "after-published end");
  assert.equal(after.publishedAt, before.publishedAt, "published_at moved on a repeat publish");
  assert.equal(first(after.deadlineChecks, "after deadline_check").event_uuid, first(before.deadlineChecks, "before deadline_check").event_uuid, "the deadline_check row was replaced");
});

// ── S6: publish vs draft edit ────────────────────────────────────────────────

await run("publish vs draft edit: the edit either lands before publication or is refused - never a 500, never an edit on a published deal", async () => {
  const dealId = await freshDeal("vs-edit");
  const editedTitle = `edited during publish ${randomUUID().slice(0, 8)}`;
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "vs-edit",
    dealId,
    held: () => publish(dealId),
    competitors: [() => editDraft(dealId, editedTitle)],
    expectedWaiters: 1
  });
  console.log(`  vs-edit: edit blocked in ${describeWaiters(waiters)}; edit answered ${first(competitorResponses, "competitor").statusCode}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `publish failed: ${heldResponse.body}`);
  assertNoFault(competitorResponses, "vs-edit");
  const f = await facts(dealId);
  assertPublishedExactlyOnce(f, "vs-edit");
  // The publish committed first (it held the row). A draft edit that observes
  // the published row must be refused; one that answers 2xx must not have
  // written into a deal that is no longer a Draft.
  assert.notEqual(f.title, editedTitle, `a draft edit landed on a PUBLISHED deal (edit answered ${first(competitorResponses, "competitor").statusCode} ${first(competitorResponses, "competitor").body})`);
  assert.equal(first(competitorResponses, "competitor").statusCode, 409, `edit racing a committed publish must be refused as not-editable: ${first(competitorResponses, "competitor").statusCode} ${first(competitorResponses, "competitor").body}`);
});

// ── S7: publish vs cancel, both orders ───────────────────────────────────────

await run("publish vs cancel (publish holds the row): cancel is a state conflict; one deadline_check, zero cancel_refund", async () => {
  const dealId = await freshDeal("vs-cancel-a");
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "vs-cancel-a",
    dealId,
    held: () => publish(dealId),
    competitors: [() => cancel(dealId)],
    expectedWaiters: 1
  });
  console.log(`  vs-cancel-a: cancel blocked in ${describeWaiters(waiters)}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `publish failed: ${heldResponse.body}`);
  assertNoFault(competitorResponses, "vs-cancel-a");
  assertStateConflict(first(competitorResponses, "competitor"), "vs-cancel-a cancel");
  assertPublishedExactlyOnce(await facts(dealId), "vs-cancel-a");
});

await run("cancel vs publish (cancel holds the row): publish is a state conflict; one cancel_refund, zero deadline_check", async () => {
  const dealId = await freshDeal("vs-cancel-b");
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "vs-cancel-b",
    dealId,
    held: () => cancel(dealId),
    competitors: [() => publish(dealId)],
    expectedWaiters: 1
  });
  console.log(`  vs-cancel-b: publish blocked in ${describeWaiters(waiters)}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `cancel failed: ${heldResponse.body}`);
  assertNoFault(competitorResponses, "vs-cancel-b");
  assertStateConflict(first(competitorResponses, "competitor"), "vs-cancel-b publish");
  const f = await facts(dealId);
  assert.equal(f.state, "Cancelled", "deal state after cancel won");
  assert.equal(f.publishedAt, null, "a losing publish left published_at behind");
  assert.equal(f.publishAudits, 0, "a losing publish left an audit row behind");
  assert.equal(f.deadlineChecks.length, 0, "a losing publish left a deadline_check behind");
  assert.equal(f.cancelRefunds.length, 1, "cancel_refund outbox rows");
});

// ── S8: the worker side of the same invariant ────────────────────────────────

await run("worker: deadline_check claimed before the deadline is deferred (still exactly one), publish retries stay converged", async () => {
  const dealId = await freshDeal("worker-defer");
  const responses = await Promise.all([1, 2, 3, 4, 5].map(() => publish(dealId)));
  assertNoFault(responses, "worker-defer publish burst");
  const before = await facts(dealId);
  assertPublishedExactlyOnce(before, "worker-defer");
  const event = first(before.deadlineChecks, "before deadline_check");

  // Make the event claimable now (its available_at is the deadline).
  await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1 AND status='pending'`, [event.event_uuid]);
  const processed = await processOutboxEventById(event.event_uuid);
  assert.ok(processed, "worker did not claim the pending deadline_check");
  assert.equal(processed!.status, "failed", `deadline not reached must defer, got ${JSON.stringify(processed)}`);
  assert.match(String((processed as any).error || ""), /deadline_not_reached/, "deferral reason");

  const after = await facts(dealId);
  assertPublishedExactlyOnce(after, "worker-defer after deferral");
  assert.equal(first(after.deadlineChecks, "after deadline_check").event_uuid, event.event_uuid, "deferral replaced the event instead of re-scheduling it");
  assert.equal(first(after.deadlineChecks, "after deadline_check").status, "pending", "deferred event must be pending again");
  assert.ok(new Date(first(after.deadlineChecks, "after deadline_check").available_at).getTime() > Date.now(), "deferred event must be re-scheduled at the deadline");

  assertReplayOf(await publish(dealId), "worker-defer replay after deferral");
  assertStateConflict(await publish(dealId, { key: `post-defer-${randomUUID()}` }), "worker-defer new key after deferral");
  assertPublishedExactlyOnce(await facts(dealId), "worker-defer end");
});

await run("worker: deadline_check completes once; a publish retry after 'sent' neither faults nor re-enqueues; the index still admits a required future event", async () => {
  const dealId = await freshDeal("worker-complete");
  const responses = await Promise.all([1, 2, 3, 4, 5].map(() => publish(dealId)));
  assertNoFault(responses, "worker-complete publish burst");
  const before = await facts(dealId);
  assertPublishedExactlyOnce(before, "worker-complete");
  const event = first(before.deadlineChecks, "before deadline_check");

  // Fixture time travel: the deadline is immutable after publish by trigger, so
  // it is aged with session_replication_role (same technique as
  // deal_types_e2e_validation) — the worker then sees a genuinely expired deal.
  const ageClient = await pool.connect();
  try {
    await ageClient.query(`SET session_replication_role = replica`);
    await ageClient.query(`UPDATE siton.deals SET deadline = now() - interval '1 hour' WHERE deal_id=$1`, [dealId]);
  } finally {
    await ageClient.query(`SET session_replication_role = origin`).catch(() => undefined);
    ageClient.release();
  }
  await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1 AND status='pending'`, [event.event_uuid]);

  const processed = await processOutboxEventById(event.event_uuid);
  assert.ok(processed, "worker did not claim the deadline_check");
  assert.equal(processed!.status, "sent", `deadline_check must complete: ${JSON.stringify(processed)}`);
  const again = await processOutboxEventById(event.event_uuid);
  assert.equal(again, null, "a sent event was claimed a second time");

  const after = await facts(dealId);
  assert.equal(after.state, "Failed", "an expired deal below threshold must fail");
  assert.equal(after.publishAudits, 1, "publication audit count after processing");
  assert.equal(after.publishedAt, before.publishedAt, "published_at changed during processing");
  assert.equal(after.deadlineChecks.length, 1, "deadline_check rows after processing");
  assert.equal(first(after.deadlineChecks, "after deadline_check").status, "sent", "processed event status");
  assert.equal(after.pendingDeadlineChecks.length, 0, "no pending deadline_check may remain");

  // Publish retry after the event changed status: converged, no re-enqueue.
  assertReplayOf(await publish(dealId), "worker-complete replay after sent");
  assertStateConflict(await publish(dealId, { key: `post-sent-${randomUUID()}` }), "worker-complete new key after sent");
  const end = await facts(dealId);
  assert.equal(end.deadlineChecks.length, 1, "a publish retry re-enqueued a deadline_check after processing");
  assert.equal(end.state, "Failed", "a publish retry moved a Failed deal");

  // The partial index covers pending/processing only, so a legitimately required
  // future deadline_check for this aggregate (the reopen-joining re-enqueue) is
  // NOT forbidden by the sent row. Probed inside a rolled-back transaction.
  const probe = await pool.connect();
  try {
    await probe.query("BEGIN");
    await probe.query(
      `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
       VALUES ('deadline_check','deal',$1,'{}'::jsonb,'pending',0,now())`,
      [dealId]
    );
    const visible = await probe.query(
      `SELECT COUNT(*)::int AS n FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='deadline_check' AND status='pending'`,
      [dealId]
    );
    assert.equal(visible.rows[0].n, 1, "a fresh pending deadline_check must be insertable once the previous one is sent");
    await probe.query("ROLLBACK");
  } finally {
    await probe.query("ROLLBACK").catch(() => undefined);
    probe.release();
  }
  assert.equal((await facts(dealId)).deadlineChecks.length, 1, "the index probe left residue behind");
});

console.log(`SUMMARY passed=${passed} failed=${failed} seller=${SELLER} app_pool_max=${APP_POOL_MAX}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
