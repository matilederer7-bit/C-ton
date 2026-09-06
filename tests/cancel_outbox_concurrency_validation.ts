// CANCEL / OUTBOX CONCURRENCY — deterministic proof for the deal.cancel sibling
// of the publish outbox race (the concurrent publish fix left cancel untouched).
//
// Observation this suite pins (independent review of 75baa21..60ebf6d, LOW /
// NEEDS_FOLLOWUP): deal.cancel writes its audit row and a pending cancel_refund
// outbox row BEFORE the deal-row compare-and-swap, so a cancel that loses a race
// (or a sequential re-cancel under a NEW idempotency key while the first
// cancel_refund is still pending/processing) is decided by the
// one-pending-per-aggregate-event unique index (23505 → HTTP 500) instead of
// by the CAS (409 STATE_CONFLICT).
//
// The financial question this suite answers independently, in the DATABASE:
// can any interleaving produce a second cancel_refund intent, a payment attempt
// or a platform-fee event? Every scenario asserts: exactly one deal.cancel
// audit row, exactly one logical cancel_refund event (same event_uuid across
// follow-ups), zero payment_attempts, zero platform-fee money events, zero
// participants touched, deal state Cancelled, and no torn rows from a loser.
//
// Contention is reached by construction (no sleeps): one cancel is parked
// inside its atomic transaction by the block fault at
// atomic.after_durable_writes_before_commit, competitors are launched, and the
// suite waits until PostgreSQL itself reports them blocked on a lock.
//
// NON-FINANCIAL BY CONSTRUCTION: cancel is only legal from Draft, a Draft deal
// has no participants, so the cancel_refund worker finds nothing to refund.
// No provider, no money, no e-mail. Disposable database.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3128";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-cancel-race";
process.env.ADMIN_API_KEY = "cancel-race-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-cancel-race";

const { app, processOutboxEventById } = await import("../src/app.js");
const { pool: appPool } = await import("../src/db.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 20
});

const APP_POOL_MAX = Number((appPool as any).options?.max || 10);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.stack || (error as any)?.message || error}`); }
  finally { resetTestFaults(); }
}

// ── fixture ──────────────────────────────────────────────────────────────────

const SELLER = `seller-cancel-${randomUUID().slice(0, 8)}`;
const SELLER_EMAIL = `${SELLER}@siton.test`;
const SELLER_CODE = "CancelRacePass123!";

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
   SET business_name = COALESCE(NULLIF(business_name, ''), 'Cancel Race Ltd'),
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
      title: `Cancel race ${label} ${randomUUID().slice(0, 8)}`,
      description: "cancel race probe deal",
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

function cancel(dealId: string, opts: { key?: string; requestId?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { cookie, "content-type": "application/json", "x-request-id": opts.requestId || randomUUID() };
  if (opts.key) headers["idempotency-key"] = opts.key;
  return app.inject({ method: "POST", url: `/deals/${dealId}/cancel`, headers, payload: {} } as any) as unknown as Promise<Resp>;
}

function publish(dealId: string, opts: { key?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { cookie, "content-type": "application/json", "x-request-id": randomUUID() };
  if (opts.key) headers["idempotency-key"] = opts.key;
  return app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers,
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  } as any) as unknown as Promise<Resp>;
}

function editDraft(dealId: string, title: string): Promise<Resp> {
  return app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/draft`,
    headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { title }
  } as any) as unknown as Promise<Resp>;
}

// ── database truth (independent of status codes) ─────────────────────────────

type OutboxRow = { event_uuid: string; event_type: string; status: string; attempt_count: number };

const hasFeeEvents = Boolean(
  (await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='siton' AND table_name='platform_fee_money_events'`)).rowCount
);

async function facts(dealId: string) {
  const deal = await pool.query(`SELECT state, published_at, title FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const audits = await pool.query(
    `SELECT action_name, COUNT(*)::int AS n FROM siton.audit_log
     WHERE entity_type='deal' AND entity_id=$1 GROUP BY action_name`,
    [dealId]
  );
  const auditByAction = new Map<string, number>(audits.rows.map((row: any) => [String(row.action_name), Number(row.n)]));
  const moneyAudits = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.audit_log WHERE deal_id=$1 AND state_type IN ('money_state','buyer_state')`,
    [dealId]
  );
  const outbox = await pool.query(
    `SELECT event_uuid, event_type, status, attempt_count FROM siton.outbox_events
     WHERE aggregate_type='deal' AND aggregate_id=$1 ORDER BY created_at`,
    [dealId]
  );
  const attempts = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.payment_attempts WHERE deal_id=$1`, [dealId]);
  const participants = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId]);
  const fee = hasFeeEvents
    ? await pool.query(`SELECT COUNT(*)::int AS n FROM siton.platform_fee_money_events WHERE deal_id=$1`, [dealId])
    : { rows: [{ n: 0 }] };
  const rows = outbox.rows as OutboxRow[];
  return {
    state: String(deal.rows[0]?.state ?? ""),
    title: String(deal.rows[0]?.title ?? ""),
    publishedAt: deal.rows[0]?.published_at ? new Date(deal.rows[0].published_at).toISOString() : null,
    cancelAudits: auditByAction.get("deal.cancel") || 0,
    publishAudits: auditByAction.get("deal.publish") || 0,
    moneyOrBuyerAudits: moneyAudits.rows[0].n as number,
    outbox: rows,
    cancelRefunds: rows.filter((row) => row.event_type === "cancel_refund"),
    liveCancelRefunds: rows.filter((row) => row.event_type === "cancel_refund" && (row.status === "pending" || row.status === "processing")),
    deadlineChecks: rows.filter((row) => row.event_type === "deadline_check"),
    paymentAttempts: attempts.rows[0].n as number,
    participants: participants.rows[0].n as number,
    feeEvents: Number(fee.rows[0].n)
  };
}

function assertNoFinancialIntent(f: Awaited<ReturnType<typeof facts>>, label: string) {
  assert.equal(f.participants, 0, `${label}: a Draft deal must have no participants`);
  assert.equal(f.paymentAttempts, 0, `${label}: payment_attempts for a cancelled draft`);
  assert.equal(f.feeEvents, 0, `${label}: platform-fee money events for a cancelled draft`);
  assert.equal(f.moneyOrBuyerAudits, 0, `${label}: money/buyer state audit rows for a cancelled draft`);
}

function assertCancelledExactlyOnce(f: Awaited<ReturnType<typeof facts>>, label: string) {
  assert.equal(f.state, "Cancelled", `${label}: deal state`);
  assert.equal(f.cancelAudits, 1, `${label}: deal.cancel audit rows`);
  assert.equal(f.cancelRefunds.length, 1, `${label}: cancel_refund outbox rows (${JSON.stringify(f.outbox)})`);
  assert.equal(f.deadlineChecks.length, 0, `${label}: deadline_check rows on a cancelled draft`);
  assert.equal(f.publishAudits, 0, `${label}: deal.publish audit rows on a cancelled draft`);
  assertNoFinancialIntent(f, label);
}

function faultsOf(responses: Resp[]) { return responses.filter((response) => response.statusCode >= 500); }
function okCount(responses: Resp[]) { return responses.filter((response) => response.statusCode >= 200 && response.statusCode < 300).length; }
function conflictCount(responses: Resp[]) { return responses.filter((response) => response.statusCode === 409).length; }
function assertNoFault(responses: Resp[], label: string) {
  const faults = faultsOf(responses);
  assert.equal(faults.length, 0, `${label}: ${faults.length} request(s) faulted from a benign race: ${faults.map((f) => `${f.statusCode} ${f.body}`).join(" | ")}`);
}
function assertReplayOf(response: Resp, label: string) {
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${label}: expected the winner's answer, got ${response.statusCode} ${response.body}`);
  assert.equal(response.json()?.response?.ok, true, `${label}: replay body is not the canonical cancel answer: ${response.body}`);
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

async function raceAgainstHeld<T extends Resp>(opts: {
  label: string;
  dealId: string;
  held: () => Promise<T>;
  competitors: Array<() => Promise<Resp>>;
  expectedWaiters: number;
  beforeRelease?: () => Promise<void>;
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
    const invisible = await facts(opts.dealId);
    const competitorPromises = opts.competitors.map((fn) => fn());
    const waiters = opts.expectedWaiters > 0 ? await waitForLockWaiters(opts.expectedWaiters, opts.label) : [];
    if (opts.beforeRelease) await opts.beforeRelease();
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

await run("VACUITY GUARD: this fixture can cancel a draft at all, and the cancel carries no financial intent", async () => {
  const dealId = await freshDeal("vacuity");
  const response = await cancel(dealId);
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `cancel failed: ${response.statusCode} ${response.body}`);
  const f = await facts(dealId);
  assertCancelledExactlyOnce(f, "sequential cancel");
  assert.equal(f.liveCancelRefunds.length, 1, "the cancel_refund must be pending for the worker");
});

// ── S1/S2: the sibling race, reproduced by construction ──────────────────────

await run("DETERMINISTIC RACE: a cancel that loses to an in-flight cancel (same idempotency key) converges to the winner's answer, never 500", async () => {
  const dealId = await freshDeal("race-same-key");
  const { heldResponse, competitorResponses, waiters, invisible } = await raceAgainstHeld({
    label: "race-same-key",
    dealId,
    held: () => cancel(dealId),
    competitors: [() => cancel(dealId)],
    expectedWaiters: 1
  });
  console.log(`  race-same-key: competitor blocked in ${describeWaiters(waiters)}`);
  assert.equal(invisible.state, "Draft", "winner's uncommitted transition leaked to a third connection");
  assert.equal(invisible.cancelRefunds.length, 0, "winner's uncommitted outbox row leaked to a third connection");
  assert.ok(waiters.length >= 1, "competitor never contended inside the database - the race was not reached");
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `winner failed: ${heldResponse.statusCode} ${heldResponse.body}`);
  assertNoFault(competitorResponses, "race-same-key");
  assertReplayOf(first(competitorResponses, "competitor"), "race-same-key competitor");
  assertCancelledExactlyOnce(await facts(dealId), "race-same-key");
});

await run("DETERMINISTIC RACE: a cancel that loses under a DIFFERENT idempotency key is refused as a state conflict, not a 500", async () => {
  const dealId = await freshDeal("race-distinct-key");
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "race-distinct-key",
    dealId,
    held: () => cancel(dealId, { key: `cancel-a-${randomUUID()}` }),
    competitors: [() => cancel(dealId, { key: `cancel-b-${randomUUID()}` })],
    expectedWaiters: 1
  });
  console.log(`  race-distinct-key: competitor blocked in ${describeWaiters(waiters)}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `winner failed: ${heldResponse.statusCode} ${heldResponse.body}`);
  assertNoFault(competitorResponses, "race-distinct-key");
  assertStateConflict(first(competitorResponses, "competitor"), "race-distinct-key competitor");
  assertCancelledExactlyOnce(await facts(dealId), "race-distinct-key");
});

// ── S3: deterministic matrix 2 / 5 / 10 / 25 ─────────────────────────────────

for (const n of [2, 5, 10, 25]) {
  const expectedWaiters = Math.min(n - 1, APP_POOL_MAX - 1);

  await run(`PARALLEL_${n} deterministic, same key: ${n} cancels → ${n} identical answers, one cancellation, one cancel_refund`, async () => {
    const dealId = await freshDeal(`matrix-same-${n}`);
    const requestId = randomUUID();
    const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
      label: `matrix-same-${n}`,
      dealId,
      held: () => cancel(dealId, { requestId }),
      competitors: Array.from({ length: n - 1 }, () => () => cancel(dealId, { requestId })),
      expectedWaiters
    });
    console.log(`  matrix-same-${n}: ${waiters.length} blocked (expected >= ${expectedWaiters}); ${describeWaiters(waiters)}`);
    const all = [heldResponse, ...competitorResponses];
    assertNoFault(all, `matrix-same-${n}`);
    assert.equal(okCount(all), n, `matrix-same-${n}: every same-key cancel must receive the winner's answer (ok=${okCount(all)}, 409=${conflictCount(all)})`);
    assertCancelledExactlyOnce(await facts(dealId), `matrix-same-${n}`);
    assertReplayOf(await cancel(dealId), `matrix-same-${n} follow-up replay`);
    assertStateConflict(await cancel(dealId, { key: `late-${randomUUID()}` }), `matrix-same-${n} follow-up new key`);
    assertCancelledExactlyOnce(await facts(dealId), `matrix-same-${n} after follow-ups`);
  });

  await run(`PARALLEL_${n} deterministic, distinct keys: exactly one 2xx, ${n - 1} state conflicts, zero 500`, async () => {
    const dealId = await freshDeal(`matrix-distinct-${n}`);
    const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
      label: `matrix-distinct-${n}`,
      dealId,
      held: () => cancel(dealId, { key: `k-${randomUUID()}` }),
      competitors: Array.from({ length: n - 1 }, () => () => cancel(dealId, { key: `k-${randomUUID()}` })),
      expectedWaiters
    });
    console.log(`  matrix-distinct-${n}: ${waiters.length} blocked (expected >= ${expectedWaiters}); ${describeWaiters(waiters)}`);
    const all = [heldResponse, ...competitorResponses];
    assertNoFault(all, `matrix-distinct-${n}`);
    assert.equal(okCount(all), 1, `matrix-distinct-${n}: exactly one cancel may win (ok=${okCount(all)})`);
    assert.equal(conflictCount(all), n - 1, `matrix-distinct-${n}: every loser must be a 409 state conflict`);
    assertCancelledExactlyOnce(await facts(dealId), `matrix-distinct-${n}`);
  });
}

// ── S4: free-running seeded rounds ───────────────────────────────────────────

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
  await run(`PARALLEL_${n} free-running, 3 seeded rounds (same key / distinct keys / mixed): zero 500, one cancellation each`, async () => {
    for (let round = 0; round < 3; round += 1) {
      const dealId = await freshDeal(`free-${n}-r${round}`);
      const mode = round === 0 ? "same" : round === 1 ? "distinct" : "mixed";
      const launches = Array.from({ length: n }, (_, index) => () => {
        if (mode === "same") return cancel(dealId);
        if (mode === "distinct") return cancel(dealId, { key: `free-${randomUUID()}` });
        return index % 2 === 0 ? cancel(dealId) : cancel(dealId, { key: `free-${randomUUID()}` });
      });
      const responses = await Promise.all(seededShuffle(launches, 0xca9ce1 + n * 31 + round).map((fn) => fn()));
      assertNoFault(responses, `free-${n} round ${round} (${mode})`);
      assert.ok(okCount(responses) >= 1, `free-${n} round ${round}: nobody cancelled`);
      if (mode === "same") assert.equal(okCount(responses), n, `free-${n} round ${round}: same-key cancels must all converge (ok=${okCount(responses)})`);
      if (mode === "distinct") assert.equal(okCount(responses), 1, `free-${n} round ${round}: distinct keys must yield one winner (ok=${okCount(responses)})`);
      assert.equal(okCount(responses) + conflictCount(responses), n, `free-${n} round ${round}: every answer must be 2xx or 409`);
      assertCancelledExactlyOnce(await facts(dealId), `free-${n} round ${round} (${mode})`);
    }
  });
}

// ── S5: response lost → retry (same key replays, new key conflicts) ──────────

await run("cancel after the previous response was lost: same key replays, new key is a state conflict, the cancel_refund row is the same one", async () => {
  const dealId = await freshDeal("lost-response");
  const initial = await cancel(dealId, { key: `lost-${dealId}` });
  assert.ok(initial.statusCode >= 200 && initial.statusCode < 300, initial.body);
  const before = await facts(dealId);
  assertCancelledExactlyOnce(before, "lost-response first");
  // The client never saw `initial`; it retries with the same key, then a
  // confused client retries with a fresh key. Neither may fault or duplicate.
  assertReplayOf(await cancel(dealId, { key: `lost-${dealId}` }), "lost-response same key");
  assertStateConflict(await cancel(dealId, { key: `lost-again-${randomUUID()}` }), "lost-response new key");
  assertStateConflict(await cancel(dealId, { key: `lost-again-${randomUUID()}` }), "lost-response second new key");
  const after = await facts(dealId);
  assertCancelledExactlyOnce(after, "lost-response end");
  assert.equal(first(after.cancelRefunds, "after").event_uuid, first(before.cancelRefunds, "before").event_uuid, "the cancel_refund row was replaced");
});

// ── S6: cancel vs draft edit ─────────────────────────────────────────────────

await run("cancel vs draft edit: the edit is refused or lands before the cancel - never a 500, never an edit on a Cancelled deal", async () => {
  const dealId = await freshDeal("vs-edit");
  const editedTitle = `edited during cancel ${randomUUID().slice(0, 8)}`;
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "vs-edit",
    dealId,
    held: () => cancel(dealId),
    competitors: [() => editDraft(dealId, editedTitle)],
    expectedWaiters: 1
  });
  const edit = first(competitorResponses, "competitor");
  console.log(`  vs-edit: edit blocked in ${describeWaiters(waiters)}; edit answered ${edit.statusCode}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `cancel failed: ${heldResponse.body}`);
  assertNoFault(competitorResponses, "vs-edit");
  const f = await facts(dealId);
  assertCancelledExactlyOnce(f, "vs-edit");
  assert.notEqual(f.title, editedTitle, `a draft edit landed on a CANCELLED deal (edit answered ${edit.statusCode} ${edit.body})`);
  assert.ok(edit.statusCode >= 400 && edit.statusCode < 500, `edit racing a committed cancel must be refused with a 4xx: ${edit.statusCode} ${edit.body}`);
});

// ── S7: cancel vs publish, both orders ───────────────────────────────────────

await run("cancel vs publish (cancel holds the row): publish is a state conflict; one cancel_refund, zero deadline_check, nothing torn", async () => {
  const dealId = await freshDeal("vs-publish-a");
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "vs-publish-a",
    dealId,
    held: () => cancel(dealId),
    competitors: [() => publish(dealId)],
    expectedWaiters: 1
  });
  console.log(`  vs-publish-a: publish blocked in ${describeWaiters(waiters)}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `cancel failed: ${heldResponse.body}`);
  assertNoFault(competitorResponses, "vs-publish-a");
  assertStateConflict(first(competitorResponses, "competitor"), "vs-publish-a publish");
  const f = await facts(dealId);
  assertCancelledExactlyOnce(f, "vs-publish-a");
  assert.equal(f.publishedAt, null, "a losing publish left published_at behind");
});

await run("publish vs cancel (publish holds the row): cancel is a state conflict; zero cancel_refund, the deal stays published", async () => {
  const dealId = await freshDeal("vs-publish-b");
  const { heldResponse, competitorResponses, waiters } = await raceAgainstHeld({
    label: "vs-publish-b",
    dealId,
    held: () => publish(dealId),
    competitors: [() => cancel(dealId)],
    expectedWaiters: 1
  });
  console.log(`  vs-publish-b: cancel blocked in ${describeWaiters(waiters)}`);
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `publish failed: ${heldResponse.body}`);
  assertNoFault(competitorResponses, "vs-publish-b");
  assertStateConflict(first(competitorResponses, "competitor"), "vs-publish-b cancel");
  const f = await facts(dealId);
  assert.equal(f.state, "PendingTarget", "deal state after publish won");
  assert.equal(f.cancelAudits, 0, "a losing cancel left an audit row behind");
  assert.equal(f.cancelRefunds.length, 0, "a losing cancel left a cancel_refund behind");
  assert.equal(f.deadlineChecks.length, 1, "deadline_check rows");
  // A published deal can never be cancelled by this route (Draft → Cancelled only):
  // even a sequential cancel is a 409 with no financial intent left behind.
  assertStateConflict(await cancel(dealId, { key: `post-publish-${randomUUID()}` }), "vs-publish-b sequential cancel");
  const g = await facts(dealId);
  assert.equal(g.cancelRefunds.length, 0, "a refused cancel left a cancel_refund behind");
  assert.equal(g.cancelAudits, 0, "a refused cancel left an audit row behind");
});

// ── S8: cancel vs worker pickup ──────────────────────────────────────────────

await run("cancel vs worker pickup: while the worker holds the cancel_refund in 'processing', a re-cancel under a new key is a 409 and the same key replays; the worker finds nothing to refund", async () => {
  const dealId = await freshDeal("vs-worker");
  const initial = await cancel(dealId);
  assert.ok(initial.statusCode >= 200 && initial.statusCode < 300, initial.body);
  const before = await facts(dealId);
  assertCancelledExactlyOnce(before, "vs-worker before");
  const event = first(before.cancelRefunds, "cancel_refund");

  const barrier = armTestFault("worker.after_claim", { kind: "block" });
  assert.ok(barrier, "worker block fault did not return a barrier");
  let released = false;
  const release = () => { if (!released) { released = true; barrier!.release(); } };
  try {
    const workerPromise = processOutboxEventById(event.event_uuid);
    await Promise.race([barrier!.entered, timeout(20_000, "worker never reached after_claim")]);
    const claimed = await facts(dealId);
    assert.equal(first(claimed.cancelRefunds, "claimed").status, "processing", "worker claim must move the event to processing");

    // The dangerous window: the unique index still covers the 'processing' row.
    const [sameKey, newKey, newKey2] = await Promise.all([
      cancel(dealId),
      cancel(dealId, { key: `during-worker-${randomUUID()}` }),
      cancel(dealId, { key: `during-worker-${randomUUID()}` })
    ]);
    assertNoFault([sameKey!, newKey!, newKey2!], "vs-worker during processing");
    assertReplayOf(sameKey!, "vs-worker same key during processing");
    assertStateConflict(newKey!, "vs-worker new key during processing");
    assertStateConflict(newKey2!, "vs-worker second new key during processing");

    release();
    const processed = await workerPromise;
    assert.ok(processed, "worker did not claim the pending cancel_refund");
    assert.equal(processed!.status, "sent", `cancel_refund for a draft must complete, got ${JSON.stringify(processed)}`);
  } finally {
    release();
    resetTestFaults();
  }

  const after = await facts(dealId);
  assertCancelledExactlyOnce(after, "vs-worker after");
  assert.equal(first(after.cancelRefunds, "after").event_uuid, event.event_uuid, "the worker replaced the cancel_refund row");
  assert.equal(first(after.cancelRefunds, "after").status, "sent", "cancel_refund must be sent");
  assert.equal(after.liveCancelRefunds.length, 0, "no live cancel_refund may remain");
  // After the event is 'sent' the partial unique index no longer covers it: a
  // late re-cancel must STILL be a 409 and must NOT enqueue a second cancel_refund.
  assertStateConflict(await cancel(dealId, { key: `after-worker-${randomUUID()}` }), "vs-worker new key after sent");
  assertReplayOf(await cancel(dealId), "vs-worker same key after sent");
  const late = await facts(dealId);
  assertCancelledExactlyOnce(late, "vs-worker late");
});

// ── S9: worker failure after cancel_refund claim → retry on the SAME event ───

await run("cancel_refund worker path is replay-safe: a failed first attempt is retried on the SAME event, never a second cancel_refund", async () => {
  const dealId = await freshDeal("worker-retry");
  const initial = await cancel(dealId);
  assert.ok(initial.statusCode >= 200 && initial.statusCode < 300, initial.body);
  const event = first((await facts(dealId)).cancelRefunds, "cancel_refund");

  armTestFault("worker.before_ack", { kind: "throw", code: "worker_died_before_ack" });
  const firstRun = await processOutboxEventById(event.event_uuid);
  assert.ok(firstRun, "worker did not claim the event");
  assert.equal(firstRun!.status, "failed", `first run must fail at the injected point, got ${JSON.stringify(firstRun)}`);
  resetTestFaults();

  const mid = await facts(dealId);
  assertCancelledExactlyOnce(mid, "worker-retry mid");
  assert.equal(first(mid.cancelRefunds, "mid").event_uuid, event.event_uuid, "retry created a new cancel_refund row");

  await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1 AND status='pending'`, [event.event_uuid]);
  const secondRun = await processOutboxEventById(event.event_uuid);
  assert.ok(secondRun, "worker did not reclaim the event");
  assert.equal(secondRun!.status, "sent", `retry must complete, got ${JSON.stringify(secondRun)}`);
  const end = await facts(dealId);
  assertCancelledExactlyOnce(end, "worker-retry end");
  assert.equal(first(end.cancelRefunds, "end").status, "sent");
});

// ── S10: lock scope — cancels of DIFFERENT deals do not serialize on each other ──

await run("lock scope: a parked cancel of deal A does not block a cancel of deal B", async () => {
  const dealA = await freshDeal("scope-a");
  const dealB = await freshDeal("scope-b");
  const other: { response: Resp | null } = { response: null };
  const { heldResponse } = await raceAgainstHeld({
    label: "scope",
    dealId: dealA,
    held: () => cancel(dealA),
    competitors: [],
    expectedWaiters: 0,
    beforeRelease: async () => {
      other.response = await Promise.race([cancel(dealB), timeout(10_000, "cancel of deal B was blocked by the parked cancel of deal A")]);
    }
  });
  assert.ok(heldResponse.statusCode >= 200 && heldResponse.statusCode < 300, `cancel A failed: ${heldResponse.body}`);
  const bResponse = other.response;
  assert.ok(bResponse, "cancel B never answered");
  assert.ok(bResponse.statusCode >= 200 && bResponse.statusCode < 300, `cancel B failed: ${bResponse.statusCode} ${bResponse.body}`);
  assertCancelledExactlyOnce(await facts(dealA), "scope A");
  assertCancelledExactlyOnce(await facts(dealB), "scope B");
});

console.log(`\nSUMMARY cancel_outbox_concurrency passed=${passed} failed=${failed}`);
await pool.end();
await app.close();
await appPool.end().catch(() => undefined);
process.exit(failed ? 1 : 0);
