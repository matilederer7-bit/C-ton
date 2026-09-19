import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ensureSellerReady, createDeal, publishDeal, joinDeal,
  forceDealState, forceParticipantTo, sellerHeaders
} from "./helpers/physical_fulfillment_fixture.js";

// MUTATION-TESTING FINDING (red-team §10/§14) — WEAK-CONCURRENCY BLIND SPOT.
//
// `redeemReceipt` (src/receipt_trust.ts) takes the canonical row locks before
// it decides anything:
//     loadReceiptOrder(c, participantId, /* lock */ true)   -> deal FOR UPDATE,
//                                                             participant FOR UPDATE
//     receiptForOrder(...)                                  -> units FOR UPDATE
// and only then checks `receipt.status === "redeemed"` and returns the
// idempotent answer.
//
// receipt_content_integration_validation already asserts EXACTLY the right
// things — one non-idempotent response and one 'fulfillment.redeem' audit row —
// but it fires its three attempts with Promise.all over app.inject on one
// process and one pool, which serialises: removing BOTH `FOR UPDATE` locks kept
// that suite green, and kept pickup_fulfillment_concurrency green too. The
// assertions were right; the interleaving never happened, so nothing actually
// held the locks in place.
//
// Without the locks the race is real: two redeems both read the receipt as
// not-yet-redeemed, the second one's UPDATE matches zero rows (the row lock on
// the UPDATE itself still serialises the write), but it then writes a SECOND
// audit row and answers `idempotent: false` — so two operators are both told
// they performed the handoff, and the security rail shows the goods handed over
// twice.
//
// This test creates the interleaving for real, using the repository's own fault
// barrier: redeem #1 is parked at db.before_commit while it holds the locks,
// redeem #2 runs against that held state, and only then is #1 released.

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.PORT = "3611";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const seller = `redeem-race-${randomUUID()}`;
const request = async (method: any, url: string, headers: any = {}, payload?: any) => {
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body, json: () => r.json() as any };
};

await app.ready();
await ensureSellerReady(app, seller, "חנות מירוץ מימוש");
const deal = await createDeal(app, seller, { title: "עסקת מירוץ מימוש", minUnits: 1, maxUnits: 10 });
assert.equal((await request("PUT", `/api/seller/deals/${deal}/receipt`, sellerHeaders(seller), { method: "code" })).status, 200);
await publishDeal(app, seller, deal);
const buyer = await joinDeal(app, deal, { phone: "0508811001", name: "ישראל מירוץ", qty: 1, optionType: "pickup" });
await forceDealState(pool, deal, "Completed");
await forceParticipantTo(pool, buyer.participant_id, "ChargedSuccess");

const auth = { authorization: `Bearer ${buyer.tracking_access_token}` };

await run("VACUITY GUARD: the buyer really holds a valid, unredeemed receipt", async () => {
  const r = await request("GET", `/api/participants/${buyer.participant_id}/entitlement`, auth);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json().entitlement?.status, "valid", `expected a valid receipt, got ${r.body}`);
});

await run("two REALLY interleaved redemptions redeem once: one non-idempotent answer, one audit row", async () => {
  const redeemUrl = `/api/seller/receipts/${buyer.participant_id}/redeem`;

  // Park the first redemption inside its transaction, holding the row locks.
  const barrier = armTestFault("db.before_commit", { kind: "block" }, 1);
  assert.ok(barrier, "could not arm the db.before_commit barrier");

  const first = request("POST", redeemUrl, sellerHeaders(seller), {});
  await barrier!.entered; // #1 now holds deal+participant+units locked, uncommitted

  // #2 runs against that held state. With the locks in place it blocks until
  // release and then sees 'redeemed'; without them it reads stale state and
  // believes it performed the redemption itself.
  const second = request("POST", redeemUrl, sellerHeaders(seller), {});
  await new Promise((resolve) => setTimeout(resolve, 250));

  barrier!.release();
  const [r1, r2] = await Promise.all([first, second]);

  assert.equal(r1.status, 200, `first redeem failed: ${r1.body}`);
  assert.equal(r2.status, 200, `second redeem failed: ${r2.body}`);

  const nonIdempotent = [r1, r2].filter((r) => r.json().idempotent === false).length;
  assert.equal(
    nonIdempotent,
    1,
    `exactly one caller may be told it performed the redemption, got ${nonIdempotent} ` +
      `(r1=${r1.body} r2=${r2.body})`
  );

  const audits = await pool.query(
    `SELECT count(*)::int AS n FROM siton.seller_security_events
      WHERE seller_id=$1 AND event_type='fulfillment.redeem'`,
    [seller]
  );
  assert.equal(
    Number(audits.rows[0].n),
    1,
    `the security rail must record the handoff exactly once, got ${audits.rows[0].n}`
  );

  const units = await pool.query(
    `SELECT count(*)::int AS n FROM siton.fulfillment_units
      WHERE participant_id=$1 AND status='Redeemed'`,
    [buyer.participant_id]
  );
  assert.equal(Number(units.rows[0].n), 1, "the unit must be redeemed exactly once");
});

resetTestFaults();
await pool.end();
await app.close();
console.log(`SUMMARY receipt_redeem_concurrency passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
