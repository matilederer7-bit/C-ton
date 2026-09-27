// Black-Sky A-F1 / A-F5 — the deadline and the 90% threshold are money gates.
//
// A-F1: a seller could pause (close_joining) a deal still BELOW its threshold.
// The deadline_check job then returned early on the non-PendingTarget state
// BEFORE deferring, so it was consumed: the paused deal never failed, every
// buyer hold stayed live, and prepare_charging (which checked only the state)
// moved it straight to charging — buyers charged on a deal that never reached
// its minimum. Canon: charge only a deal that closed at/above threshold
// (docs/SYNTHETIC_MONEY_PROOF.md case A, docs/REFUND_POLICY.md).
//
// A-F5: join never compared the deadline — a join landing after the deadline
// but before the deadline_check ran was accepted.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.MOCK_SEED = "1";

const { app, processOutboxEventById } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const sellerId = `seller-bs-deadline-${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}

function headers(key: string, withSeller = true) {
  return {
    "x-request-id": `bs-dl-${key}-${RUN_ID}`,
    "idempotency-key": `bs-dl-${key}-${RUN_ID}`,
    "content-type": "application/json",
    ...(withSeller ? { "x-seller-id": sellerId } : {})
  };
}

async function createAndPublish(key: string) {
  const create = await app.inject({
    method: "POST", url: "/deals", headers: headers(`create-${key}`),
    payload: {
      title: `Black-Sky deadline ${key}`, description_short: "deadline gate", price_per_unit: 10,
      min_units: 2, max_units: 5, deadline: new Date(Date.now() + 3 * 864e5).toISOString(),
      deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "pickup", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }]
    }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const pub = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: headers(`publish-${key}`),
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(pub.statusCode, 200, pub.body);
  return String(dealId);
}

function phoneFor(key: string) {
  let h = 2166136261 >>> 0;
  for (const ch of `${key}-${RUN_ID}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return `0508${String(h >>> 0).padStart(7, "0").slice(-7)}`;
}

async function join(dealId: string, key: string, qty: number) {
  const start = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone: phoneFor(key) } });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json() as any;
  const verify = await app.inject({
    method: "POST", url: "/api/otp/verify",
    payload: { otp_session_id: started.otp_session_id, code: started.development_code }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const otp = verify.json() as any;
  const auth = await app.inject({
    method: "POST", url: "/api/payments/authorize-mock",
    payload: { payer_name: `Buyer ${key}`, payment_method_id: `pm_bs_${key}` }
  });
  assert.equal(auth.statusCode, 200, auth.body);
  const authorization = auth.json() as any;
  return app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: headers(`join-${key}`, false),
    payload: {
      buyer_id: otp.buyer_id, qty, buyer_name: `Buyer ${key}`, buyer_email: `${key}-${RUN_ID}@example.test`,
      buyer_terms_accepted: true, payment_disclosure_accepted: true,
      otp_token: otp.otp_token, otp_challenge_id: otp.challenge_id || otp.otp_session_id,
      authorization_id: authorization.authorization_id || `auth-${key}`,
      authorization_provider: authorization.provider || "mockpay"
    }
  });
}

// The deadline is immutable after publish; age it on ONE connection with the
// triggers bypassed, mirroring the deadline actually arriving.
async function ageDeadline(dealId: string) {
  const c = await pool.connect();
  try {
    await c.query(`SET session_replication_role = replica`);
    await c.query(`UPDATE siton.deals SET deadline = now() - interval '1 minute' WHERE deal_id=$1`, [dealId]);
  } finally {
    await c.query(`SET session_replication_role = origin`).catch(() => {});
    c.release();
  }
}

async function pendingDeadlineEvent(dealId: string) {
  const r = await pool.query(
    `SELECT event_uuid FROM siton.outbox_events
      WHERE aggregate_type='deal' AND aggregate_id=$1 AND event_type='deadline_check' AND status='pending'
      ORDER BY created_at DESC LIMIT 1`,
    [dealId]
  );
  return r.rowCount ? String(r.rows[0].event_uuid) : null;
}

async function dealState(dealId: string) {
  const r = await pool.query(`SELECT state, threshold_units FROM siton.deals WHERE deal_id=$1`, [dealId]);
  return { state: String(r.rows[0].state), threshold: Number(r.rows[0].threshold_units) };
}

const profile = await app.inject({
  method: "PUT", url: "/api/seller/business-profile", headers: headers("profile"),
  payload: {
    business_name: "Black-Sky deadline seller", business_id_number: "515000000", contact_name: "tester",
    contact_phone: "0501234567", bank_account_holder: "tester", bank_name: "leumi", bank_branch: "800",
    bank_account_number: "12345678"
  }
});
assert.equal(profile.statusCode, 200, profile.body);

const belowDeal = await createAndPublish("below");
const atDeal = await createAndPublish("at");

await run("fixture: a 1-unit join leaves the deal BELOW its threshold, then the seller pauses it", async () => {
  const j = await join(belowDeal, "below-1", 1);
  assert.equal(j.statusCode, 200, j.body);
  const before = await dealState(belowDeal);
  assert.equal(before.state, "PendingTarget");
  assert.ok(before.threshold > 1, `vacuity: threshold must exceed the joined unit, got ${before.threshold}`);
  const close = await app.inject({ method: "POST", url: `/deals/${belowDeal}/close_joining`, headers: headers("close-below"), payload: {} });
  assert.equal(close.statusCode, 200, close.body);
  assert.equal((await dealState(belowDeal)).state, "ClosedForJoining");
});

await run("A-F1: prepare_charging refuses a paused deal below threshold (409 threshold_not_reached), nothing locks in", async () => {
  const prep = await app.inject({ method: "POST", url: `/deals/${belowDeal}/prepare_charging`, headers: headers("prepare-below"), payload: {} });
  assert.equal(prep.statusCode, 409, prep.body);
  assert.match(prep.body, /threshold/);
  assert.equal((await dealState(belowDeal)).state, "ClosedForJoining");
  const parts = await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE deal_id=$1`, [belowDeal]);
  assert.equal(parts.rowCount, 1);
  assert.equal(parts.rows[0].buyer_state, "JoinedAuthorized");
  assert.equal(parts.rows[0].money_state, "AuthHeld");
});

await run("A-F1: a deadline_check that runs while the deal is paused BEFORE its deadline defers and survives", async () => {
  const ev = await pendingDeadlineEvent(belowDeal);
  assert.ok(ev, "a pending deadline_check exists after publish");
  await pool.query(`UPDATE siton.outbox_events SET available_at = now() WHERE event_uuid=$1`, [ev]);
  await processOutboxEventById(ev!);
  assert.equal(await pendingDeadlineEvent(belowDeal), ev, "the paused deal's deadline job must not be consumed");
  assert.equal((await dealState(belowDeal)).state, "ClosedForJoining");
});

await run("A-F1: at the deadline the paused below-threshold deal FAILS and its buyer fails with it", async () => {
  await ageDeadline(belowDeal);
  const ev = await pendingDeadlineEvent(belowDeal);
  assert.ok(ev);
  await pool.query(`UPDATE siton.outbox_events SET available_at = now() WHERE event_uuid=$1`, [ev]);
  await processOutboxEventById(ev!);
  assert.equal((await dealState(belowDeal)).state, "Failed");
  const parts = await pool.query(`SELECT buyer_state FROM siton.participants WHERE deal_id=$1`, [belowDeal]);
  assert.equal(parts.rows[0].buyer_state, "DealFailed");
  const audit = await pool.query(
    `SELECT count(*)::int AS n FROM siton.audit_log
      WHERE entity_type='deal' AND entity_id=$1 AND from_state='ClosedForJoining' AND to_state='Failed'`,
    [belowDeal]
  );
  assert.equal(audit.rows[0].n, 1, "the failure is audited as ClosedForJoining -> Failed");
  const prep = await app.inject({ method: "POST", url: `/deals/${belowDeal}/prepare_charging`, headers: headers("prepare-below-2"), payload: {} });
  assert.equal(prep.statusCode, 409, "a failed deal can never be prepared for charging");
});

await run("A-F5: a join after the deadline is refused (409 deal_deadline_passed) and holds no inventory", async () => {
  const first = await join(atDeal, "at-1", 2);
  assert.equal(first.statusCode, 200, first.body);
  const { state, threshold } = await dealState(atDeal);
  assert.equal(state, "TargetReached", "vacuity: the positive-control deal is at threshold and still open");
  assert.ok(threshold <= 2);
  await ageDeadline(atDeal);
  const late = await join(atDeal, "at-late", 1);
  assert.equal(late.statusCode, 409, late.body);
  assert.match(late.body, /deadline/);
  const parts = await pool.query(`SELECT count(*)::int AS n, COALESCE(sum(qty),0)::int AS units FROM siton.participants WHERE deal_id=$1`, [atDeal]);
  assert.equal(parts.rows[0].n, 1, "the late join must not create a participant");
  assert.equal(parts.rows[0].units, 2);
});

await run("positive control: a paused deal AT threshold still prepares for charging", async () => {
  const close = await app.inject({ method: "POST", url: `/deals/${atDeal}/close_joining`, headers: headers("close-at"), payload: {} });
  assert.equal(close.statusCode, 200, close.body);
  const prep = await app.inject({ method: "POST", url: `/deals/${atDeal}/prepare_charging`, headers: headers("prepare-at"), payload: {} });
  assert.equal(prep.statusCode, 200, prep.body);
  assert.equal((await dealState(atDeal)).state, "ReadyForCharging");
});

await run("DB authority: the transition function admits ClosedForJoining -> Failed and still refuses Charging -> Failed", async () => {
  const r = await pool.query(
    `SELECT siton.is_valid_deal_transition('ClosedForJoining','Failed') AS paused_fail,
            siton.is_valid_deal_transition('Charging','Failed') AS charging_fail,
            siton.is_valid_deal_transition('ReadyForCharging','Failed') AS ready_fail`
  );
  assert.equal(r.rows[0].paused_fail, true);
  assert.equal(r.rows[0].charging_fail, false);
  assert.equal(r.rows[0].ready_fail, false);
});

await pool.end().catch(() => undefined);
console.log(`\nBLACK_SKY_DEADLINE_THRESHOLD ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
