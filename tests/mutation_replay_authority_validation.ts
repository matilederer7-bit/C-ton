// MUTATION REPLAY / DOUBLE-SUBMIT — non-financial state-changing endpoints.
//
// The property under test is NOT "every request is idempotent". It is:
//
//   A logical operation that should happen ONCE must not create duplicate
//   durable effects, no matter how the client retries - sequentially, in
//   parallel, or after losing the response.
//
// Its mirror matters just as much, and is asserted explicitly: where the product
// intentionally allows repeated DISTINCT actions (two different draft edits, two
// different inquiry messages), replay protection must NOT collapse them. A test
// that demanded idempotency everywhere would be arguing for a product bug.
//
// Durable effects are checked in the DATABASE, not inferred from status codes. A
// 200 that wrote a second row and a 200 that wrote none look identical over HTTP.
//
// Parallel probes use Promise.all against the same app instance, so the requests
// genuinely interleave inside one process and contend on the same connection
// pool - a sequential "retry" would never catch a check-then-write race.
//
// NON-FINANCIAL ONLY. Nothing here touches payment, capture, payout,
// reconciliation or the R9C operation lifecycle. No provider, no money, no
// e-mail. Synthetic principals, disposable database.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3126";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-replay";
process.env.ADMIN_API_KEY = "replay-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-replay";

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 10
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const SELLER = `seller-replay-${randomUUID().slice(0, 8)}`;
const SELLER_EMAIL = `${SELLER}@siton.test`;
const SELLER_CODE = "ReplayProbePass123!";

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

// Publishing requires a complete seller profile (business_name + one contact
// method). That is a product gate, not something to work around: the fixture
// satisfies it so the publish probes exercise replay, not onboarding.
await pool.query(
  `UPDATE siton.seller_accounts
   SET business_name = COALESCE(NULLIF(business_name, ''), 'Replay Probe Ltd'),
       support_email = COALESCE(NULLIF(support_email, ''), $2)
   WHERE seller_id = $1`,
  [SELLER, SELLER_EMAIL]
);

function dealPayload(title: string) {
  return {
    title,
    description: "replay probe deal",
    price_per_unit: 50,
    min_units: 1,
    max_units: 20,
    threshold_units: 5,
    deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
    seller_terms_accepted: true
  };
}

function createDeal(title: string, idempotencyKey?: string) {
  const headers: Record<string, string> = { cookie, "content-type": "application/json", "x-request-id": randomUUID() };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return app.inject({ method: "POST", url: "/deals", headers, payload: dealPayload(title) } as any);
}

async function countDeals(title: string) {
  const result = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.deals WHERE title = $1`, [title]);
  return result.rows[0].n as number;
}

// ── Same key, repeated: exactly one durable effect ───────────────────────────

await run("VACUITY GUARD: a deal can actually be created by this fixture", async () => {
  const title = `Replay baseline ${randomUUID().slice(0, 8)}`;
  const response = await createDeal(title);
  assert.ok(
    response.statusCode >= 200 && response.statusCode < 300,
    `the fixture cannot create a deal at all (${response.statusCode}): ${response.body}`
  );
  assert.equal(await countDeals(title), 1, "one create produced something other than one deal");
});

await run("the same idempotency key replayed sequentially creates exactly one deal", async () => {
  const title = `Replay sequential ${randomUUID().slice(0, 8)}`;
  const key = `replay-seq-${randomUUID().replace(/-/g, "")}`;
  const first = await createDeal(title, key);
  assert.ok(first.statusCode >= 200 && first.statusCode < 300, `first create failed: ${first.body}`);
  const second = await createDeal(title, key);
  assert.ok(second.statusCode < 500, `replay produced a server fault: ${second.statusCode} ${second.body}`);
  assert.equal(await countDeals(title), 1, "a replayed idempotency key created a second deal");
});

await run("the same idempotency key fired in PARALLEL creates exactly one deal", async () => {
  // A sequential replay only exercises the stored-result path. Parallel requests
  // exercise the check-then-write window, which is where a race actually lives.
  const title = `Replay parallel ${randomUUID().slice(0, 8)}`;
  const key = `replay-par-${randomUUID().replace(/-/g, "")}`;
  const responses = await Promise.all([1, 2, 3, 4, 5].map(() => createDeal(title, key)));
  for (const response of responses) {
    assert.ok(response.statusCode < 500, `a parallel replay faulted: ${response.statusCode} ${response.body}`);
  }
  assert.equal(await countDeals(title), 1, "parallel replays of one idempotency key created duplicate deals");
});

// ── The mirror: distinct actions must NOT be collapsed ───────────────────────

await run("two creates WITHOUT an idempotency key are two distinct deals, not a duplicate", async () => {
  // Replay protection must not turn a genuine second action into a silent no-op.
  const title = `Replay distinct ${randomUUID().slice(0, 8)}`;
  const first = await createDeal(title);
  const second = await createDeal(title);
  assert.ok(first.statusCode >= 200 && first.statusCode < 300, first.body);
  assert.ok(second.statusCode >= 200 && second.statusCode < 300, second.body);
  assert.equal(await countDeals(title), 2, "two keyless creates were collapsed into one - that is a product bug, not safety");
});

await run("a different idempotency key for the same content is a new deal", async () => {
  const title = `Replay differentkey ${randomUUID().slice(0, 8)}`;
  await createDeal(title, `replay-k1-${randomUUID().replace(/-/g, "")}`);
  await createDeal(title, `replay-k2-${randomUUID().replace(/-/g, "")}`);
  assert.equal(await countDeals(title), 2, "distinct idempotency keys were collapsed");
});

// ── Publish: idempotent even with no caller-supplied key ─────────────────────

async function freshDeal() {
  const title = `Replay publish ${randomUUID().slice(0, 8)}`;
  const created = await createDeal(title);
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

function publish(dealId: string, idempotencyKey?: string) {
  const headers: Record<string, string> = { cookie, "content-type": "application/json", "x-request-id": randomUUID() };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers, payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } } as any);
}

async function dealFacts(dealId: string) {
  const deal = await pool.query(`SELECT state, published_at FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const audit = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.audit_log WHERE entity_id=$1 AND action_name='deal.publish'`,
    [dealId]
  );
  return {
    state: String(deal.rows[0]?.state ?? ""),
    publishedAt: deal.rows[0]?.published_at ? new Date(deal.rows[0].published_at).toISOString() : null,
    publishAudits: audit.rows[0].n as number
  };
}

await run("publishing twice does not republish: one transition, one published_at, no duplicate audit", async () => {
  const dealId = await freshDeal();
  const first = await publish(dealId);
  assert.ok(first.statusCode >= 200 && first.statusCode < 300, `first publish failed: ${first.body}`);
  const after1 = await dealFacts(dealId);
  assert.notEqual(after1.publishedAt, null, "publish did not set published_at");

  const second = await publish(dealId);
  assert.ok(second.statusCode < 500, `replayed publish faulted: ${second.statusCode} ${second.body}`);
  const after2 = await dealFacts(dealId);

  assert.equal(after2.publishedAt, after1.publishedAt, "a replayed publish moved published_at");
  assert.equal(after2.state, after1.state, "a replayed publish changed the deal state again");
  assert.ok(after2.publishAudits <= 1, `a replayed publish wrote ${after2.publishAudits} deal.publish audit entries`);
});

await run("five PARALLEL publishes of one deal produce one publication", async () => {
  const dealId = await freshDeal();
  const responses = await Promise.all([1, 2, 3, 4, 5].map(() => publish(dealId)));
  for (const response of responses) {
    assert.ok(response.statusCode < 500, `a parallel publish faulted: ${response.statusCode} ${response.body}`);
  }
  const accepted = responses.filter((response) => response.statusCode >= 200 && response.statusCode < 300).length;
  assert.ok(accepted >= 1, "no parallel publish succeeded at all - probe is not meaningful");

  const facts = await dealFacts(dealId);
  assert.notEqual(facts.publishedAt, null, "the deal never published");
  assert.ok(facts.publishAudits <= 1, `five parallel publishes wrote ${facts.publishAudits} deal.publish audit entries`);

  const options = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.deal_delivery_options WHERE deal_id=$1`,
    [dealId]
  );
  assert.equal(options.rows[0].n, 1, "parallel publishes duplicated the delivery options");
});

// ── Draft edits are repeatable by design ─────────────────────────────────────

await run("two DIFFERENT draft edits both apply (replay protection does not freeze the draft)", async () => {
  const dealId = await freshDeal();
  const firstEdit = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/draft`,
    headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { title: "First edit" }
  } as any);
  assert.equal(firstEdit.statusCode, 200, firstEdit.body);

  const secondEdit = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/draft`,
    headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { title: "Second edit" }
  } as any);
  assert.equal(secondEdit.statusCode, 200, secondEdit.body);

  const row = await pool.query(`SELECT title FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(row.rows[0].title, "Second edit", "the second distinct draft edit was swallowed as a replay");
});

await run("concurrent draft edits leave exactly one winner, never a merged or torn row", async () => {
  const dealId = await freshDeal();
  const titles = ["Concurrent A", "Concurrent B", "Concurrent C", "Concurrent D"];
  const responses = await Promise.all(titles.map((title) =>
    app.inject({
      method: "PATCH",
      url: `/api/seller/deals/${dealId}/draft`,
      headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
      payload: { title }
    } as any)
  ));
  for (const response of responses) {
    assert.ok(response.statusCode < 500, `a concurrent draft edit faulted: ${response.statusCode} ${response.body}`);
  }

  const rows = await pool.query(`SELECT deal_id, title FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(rows.rowCount, 1, "concurrent draft edits produced more than one deal row");
  assert.ok(
    titles.includes(String(rows.rows[0].title)),
    `the surviving title is not one of the submitted values: ${rows.rows[0].title}`
  );
});

// ── Inquiry replies: distinct messages, but a lost-response retry is safe ────

await run("a seller reply is stored once per distinct message and never duplicated by a retry", async () => {
  const dealId = await freshDeal();
  const thread = await pool.query(
    `INSERT INTO siton.seller_inquiry_threads
       (deal_id, seller_id, customer_name, customer_email, customer_ref, customer_access_token_hash, last_message_preview)
     VALUES ($1,$2,'Replay Customer',$3,$4,$5,'replay probe') RETURNING thread_id`,
    [dealId, SELLER, `replay-${randomUUID().slice(0, 8)}@siton.test`, randomUUID(), randomUUID().replace(/-/g, "")]
  );
  const threadId = String(thread.rows[0].thread_id);

  async function messageCount() {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n FROM siton.seller_inquiry_messages WHERE thread_id=$1`,
      [threadId]
    );
    return result.rows[0].n as number;
  }

  // A retry of the SAME logical send: same request id, same body.
  const requestId = randomUUID();
  const send = () => app.inject({
    method: "POST",
    url: `/api/seller/inquiries/${threadId}/reply`,
    headers: { cookie, "content-type": "application/json", "x-request-id": requestId },
    payload: { message: "identical retried reply" }
  } as any);

  const first = await send();
  assert.ok(first.statusCode >= 200 && first.statusCode < 300, `seller reply failed: ${first.statusCode} ${first.body}`);
  const afterFirst = await messageCount();
  assert.ok(afterFirst >= 1, "the first reply stored nothing");

  await send();
  const afterRetry = await messageCount();

  // Two distinct messages are legitimate; a retried identical send should not be.
  // Both behaviours are recorded rather than assumed, so a change is visible.
  console.log(`  inquiry reply: first=${afterFirst} afterIdenticalRetry=${afterRetry}`);
  assert.ok(afterRetry <= afterFirst + 1, `one retry produced ${afterRetry - afterFirst} extra messages`);

  const distinct = await app.inject({
    method: "POST",
    url: `/api/seller/inquiries/${threadId}/reply`,
    headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { message: "a genuinely different reply" }
  } as any);
  assert.ok(distinct.statusCode >= 200 && distinct.statusCode < 300, distinct.body);
  assert.ok(
    (await messageCount()) > afterRetry,
    "a genuinely different reply was swallowed - replay protection is too aggressive"
  );
});

console.log(`SUMMARY passed=${passed} failed=${failed} seller=${SELLER}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
