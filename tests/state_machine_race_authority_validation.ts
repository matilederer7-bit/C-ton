// STATE-MACHINE RACES — deterministic concurrency against the deal lifecycle.
//
// Phase 4 proved a REPEATED operation lands once. This asks the harder question:
// when two DIFFERENT operations race for the same object, does the object end in
// a state the state machine actually allows?
//
// The declared machine (src/app.ts DEAL_TRANSITIONS):
//
//   Draft            -> PendingTarget, Cancelled
//   PendingTarget    -> TargetReached, Failed, ClosedForJoining
//   TargetReached    -> ClosedForJoining
//   ClosedForJoining -> ReadyForCharging, PendingTarget, TargetReached
//   Completed | Failed | Cancelled -> (terminal)
//
// Every race below is judged against that table, not against a hand-written
// expectation: whatever state survives must be reachable from the state the deal
// was in, and a terminal state must never reopen. That way the test stays correct
// if the product legitimately changes which operation wins - it only fails if the
// outcome is IMPOSSIBLE.
//
// Races run through Promise.all against one app instance, so they interleave
// inside a single process and contend on the same pool. A sequential version of
// any of these would pass while the race still existed.
//
// NON-FINANCIAL ONLY: no join, no authorization, no capture, no payout, no
// provider. Nothing here can move money or touch the R9C operation lifecycle.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3127";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-race";
process.env.ADMIN_API_KEY = "race-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-race";

const { app, DEAL_TRANSITIONS } = await import("../src/app.js");
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

const TERMINAL = new Set(["Completed", "Failed", "Cancelled"]);

/** Every state reachable from `from` in zero or more declared transitions. */
function reachableFrom(from: string): Set<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of (DEAL_TRANSITIONS as Record<string, string[]>)[queue.shift()!] || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

const SELLER = `seller-race-${randomUUID().slice(0, 8)}`;
const SELLER_EMAIL = `${SELLER}@siton.test`;
const SELLER_CODE = "RaceProbePass123!";

const { cookie: adminCookie } = await establishNamedAdminSession(app, pool);
assert.equal(
  (await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${SELLER}/provision`,
    headers: { cookie: adminCookie },
    payload: { display_name: SELLER, login_email: SELLER_EMAIL, access_code: SELLER_CODE, auth_enabled: true }
  } as any)).statusCode,
  200,
  "seller provisioning failed"
);
await pool.query(
  `UPDATE siton.seller_accounts
   SET business_name = COALESCE(NULLIF(business_name, ''), 'Race Probe Ltd'),
       support_email = COALESCE(NULLIF(support_email, ''), $2)
   WHERE seller_id = $1`,
  [SELLER, SELLER_EMAIL]
);

const login = await app.inject({
  method: "POST",
  url: "/api/seller/session/login",
  payload: { identifier: SELLER_EMAIL, access_code: SELLER_CODE }
} as any);
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";

function headers() {
  return { cookie, "content-type": "application/json", "x-request-id": randomUUID() };
}

const PUBLISH_TERMS = {
  seller_terms_accepted: true,
  seller_critical_terms_accepted: true,
  seller_threshold_90_accepted: true
};

async function freshDraft() {
  const title = `Race ${randomUUID().slice(0, 8)}`;
  const created = await app.inject({
    method: "POST",
    url: "/deals",
    headers: headers(),
    payload: {
      title,
      description: "race probe deal",
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
  assert.match(dealId, /^[0-9a-f-]{36}$/, `no deal_id: ${created.body.slice(0, 200)}`);
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
     VALUES ($1,'pickup','רחוב המרוץ 1, חיפה',0,0) ON CONFLICT DO NOTHING`,
    [dealId]
  );
  return dealId;
}

async function stateOf(dealId: string) {
  const result = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(result.rowCount, 1, "the deal row disappeared");
  return String(result.rows[0].state);
}

const publish = (dealId: string) =>
  app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers: headers(), payload: PUBLISH_TERMS } as any);
const cancel = (dealId: string) =>
  app.inject({ method: "POST", url: `/deals/${dealId}/cancel`, headers: headers(), payload: { reason: "race probe" } } as any);
const editDraft = (dealId: string, title: string) =>
  app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: headers(), payload: { title } } as any);

await run("VACUITY GUARD: the lifecycle actually moves for this fixture", async () => {
  const dealId = await freshDraft();
  assert.equal(await stateOf(dealId), "Draft", "a new deal is not Draft");
  const published = await publish(dealId);
  assert.ok(published.statusCode >= 200 && published.statusCode < 300, `publish failed: ${published.body}`);
  const after = await stateOf(dealId);
  assert.notEqual(after, "Draft", "publish left the deal in Draft - the races below would prove nothing");
  assert.ok(
    ((DEAL_TRANSITIONS as Record<string, string[]>).Draft ?? []).includes(after),
    `publish moved Draft -> ${after}, which the state machine does not allow`
  );
});

await run("publish racing cancel leaves exactly one reachable state, never both outcomes", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dealId = await freshDraft();
    const [publishResponse, cancelResponse] = await Promise.all([publish(dealId), cancel(dealId)]);
    for (const response of [publishResponse, cancelResponse]) {
      assert.ok(response.statusCode < 500, `a racing lifecycle call faulted: ${response.statusCode} ${response.body}`);
    }
    const final = await stateOf(dealId);
    assert.ok(
      reachableFrom("Draft").has(final),
      `publish|cancel race produced ${final}, unreachable from Draft`
    );
    // Both cannot have won: a Cancelled deal must not carry a publication.
    const row = await pool.query(`SELECT state, published_at FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (String(row.rows[0].state) === "Cancelled") {
      assert.equal(row.rows[0].published_at, null, "a Cancelled deal kept a published_at - both operations won");
    }
  }
});

await run("publish racing a draft edit never leaves a torn row", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dealId = await freshDraft();
    const [publishResponse, editResponse] = await Promise.all([publish(dealId), editDraft(dealId, "Edited during publish")]);
    for (const response of [publishResponse, editResponse]) {
      assert.ok(response.statusCode < 500, `a racing call faulted: ${response.statusCode} ${response.body}`);
    }
    const row = await pool.query(
      `SELECT state, title, published_at FROM siton.deals WHERE deal_id=$1`,
      [dealId]
    );
    assert.equal(row.rowCount, 1, "the race duplicated the deal row");
    const state = String(row.rows[0].state);
    assert.ok(reachableFrom("Draft").has(state), `publish|edit race produced ${state}, unreachable from Draft`);
    // Whichever won, the row must be internally consistent: published => has a
    // publication timestamp; still Draft => none.
    if (state === "Draft") {
      assert.equal(row.rows[0].published_at, null, "a Draft deal carries published_at");
    } else {
      assert.notEqual(row.rows[0].published_at, null, `state ${state} carries no published_at`);
    }
  }
});

await run("a terminal deal cannot be reopened, republished or edited", async () => {
  const dealId = await freshDraft();
  const cancelled = await cancel(dealId);
  assert.ok(cancelled.statusCode >= 200 && cancelled.statusCode < 300, `cancel failed: ${cancelled.body}`);
  const terminal = await stateOf(dealId);
  assert.ok(TERMINAL.has(terminal), `cancel did not reach a terminal state, got ${terminal}`);

  const attempts = await Promise.all([
    publish(dealId),
    cancel(dealId),
    editDraft(dealId, "Edited after terminal")
  ]);
  for (const response of attempts) {
    assert.ok(response.statusCode < 500, `a post-terminal call faulted: ${response.statusCode} ${response.body}`);
  }
  assert.equal(await stateOf(dealId), terminal, "a terminal deal changed state after further calls");

  const row = await pool.query(`SELECT title FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.notEqual(row.rows[0].title, "Edited after terminal", "a terminal deal accepted a draft edit");
});

await run("concurrent delivery updates leave one coherent option set, never duplicates", async () => {
  const dealId = await freshDraft();
  const bodies = [
    { delivery_options: [{ option_type: "pickup", label: "רחוב אלף 1, חיפה", cost: 0 }] },
    { delivery_options: [{ option_type: "pickup", label: "רחוב בית 2, חיפה", cost: 0 }] },
    { delivery_options: [
      { option_type: "pickup", label: "רחוב גימל 3, חיפה", cost: 0 },
      { option_type: "delivery", label: "משלוח", cost: 20 }
    ] }
  ];
  const responses = await Promise.all(bodies.map((payload) =>
    app.inject({ method: "PUT", url: `/api/seller/deals/${dealId}/delivery`, headers: headers(), payload } as any)
  ));
  for (const response of responses) {
    assert.ok(response.statusCode < 500, `a racing delivery update faulted: ${response.statusCode} ${response.body}`);
  }

  const options = await pool.query(
    `SELECT option_type, label FROM siton.deal_delivery_options WHERE deal_id=$1`,
    [dealId]
  );
  // The winner must be ONE of the submitted sets, not a union of several.
  const labels = options.rows.map((row: any) => String(row.label)).sort();
  const acceptable = bodies
    .map((body) => body.delivery_options.map((option) => option.label).sort())
    .concat([["רחוב המרוץ 1, חיפה"]]);
  assert.ok(
    acceptable.some((candidate) => candidate.length === labels.length && candidate.every((label, index) => label === labels[index])),
    `concurrent delivery updates merged into an unsubmitted set: ${JSON.stringify(labels)}`
  );
  assert.equal(new Set(labels).size, labels.length, "concurrent delivery updates duplicated an option");
});

await run("approve racing reject on one admin action yields a single decision", async () => {
  const { cookie: superCookie } = await establishNamedAdminSession(app, pool, { role: "SuperAdmin" });
  const action = await pool.query(
    `INSERT INTO siton.admin_actions (action_type, status, requested_by_admin_id, target_type, target_id, reason, correlation_id, idempotency_key)
     VALUES ('freeze_payouts','Requested','race-probe','seller',$1,'race probe fixture',$2,$3)
     RETURNING admin_action_id`,
    [SELLER, randomUUID(), `race-${randomUUID()}`]
  );
  const actionId = String(action.rows[0].admin_action_id);

  const [approveResponse, rejectResponse] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/api/admin/actions/${actionId}/approve`,
      headers: { cookie: superCookie, "content-type": "application/json", "x-request-id": randomUUID() },
      payload: { reason: "race probe approve" }
    } as any),
    app.inject({
      method: "POST",
      url: `/api/admin/actions/${actionId}/reject`,
      headers: { cookie: superCookie, "content-type": "application/json", "x-request-id": randomUUID() },
      payload: { reason: "race probe reject" }
    } as any)
  ]);
  for (const response of [approveResponse, rejectResponse]) {
    assert.ok(response.statusCode < 500, `a racing admin decision faulted: ${response.statusCode} ${response.body}`);
  }

  const row = await pool.query(`SELECT status FROM siton.admin_actions WHERE admin_action_id=$1`, [actionId]);
  assert.equal(row.rowCount, 1, "the race duplicated the admin action row");
  const status = String(row.rows[0].status);
  assert.ok(
    ["Approved", "Rejected", "Requested", "AwaitingSecondApproval"].includes(status),
    `approve|reject race produced an impossible status: ${status}`
  );
  assert.notEqual(status, "", "the admin action lost its status");
});

console.log(`SUMMARY passed=${passed} failed=${failed} seller=${SELLER}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
