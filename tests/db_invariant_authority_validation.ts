// DATABASE AUTHORITY — which invariants survive when the application is bypassed.
//
// Two different questions, and they need different instruments:
//
//   1. Is the invariant backed by the SCHEMA? Probed with direct SQL. If the
//      database accepts the violation, the rule lives only in TypeScript and a
//      new code path that forgets it has no backstop. This half is a regression
//      gate: drop a CHECK and it fails.
//
//   2. Where the rule CANNOT be a constraint - "the sum of joined quantities
//      must not exceed this deal's max_units" is not expressible as a column
//      check - does the concurrency control actually hold? Probed with real
//      concurrent requests, because that is the only thing that distinguishes a
//      correct lock from a comment claiming there is one.
//
// The capacity race is the reason this file exists. It is the classic
// oversell bug: read the remaining capacity, decide there is room, write. Two
// requests interleaved between the read and the write both decide there is room.
//
// NO MONEY: joins here are synthetic buyers with pre-verified OTP challenges
// against a fake payment provider. Nothing authorizes, captures, settles or pays
// out, and the R9C operation lifecycle is not touched.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3131";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";

const { app } = await import("../src/app.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 12
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

/** Attempt a write that a correct schema must refuse. */
async function rejectedByDatabase(sql: string, params: unknown[] = []) {
  try {
    await pool.query(sql, params as any[]);
    return null;
  } catch (error: any) {
    return String(error?.code || error?.message || "rejected");
  }
}

async function seedDeal(overrides: { maxUnits?: number; minUnits?: number; state?: string } = {}) {
  const sellerId = `seller-dbinv-${randomUUID().slice(0, 8)}`;
  const minUnits = overrides.minUnits ?? 1;
  const maxUnits = overrides.maxUnits ?? 20;
  const result = await pool.query(
    `INSERT INTO siton.deals
       (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
     VALUES ($1,100,$2,$3,$4,now()+interval '7 days',$5,$6,now())
     RETURNING deal_id`,
    [`DB invariant ${randomUUID().slice(0, 8)}`, minUnits, maxUnits, Math.ceil(0.9 * minUnits), sellerId, overrides.state ?? "PendingTarget"]
  );
  const dealId = String(result.rows[0].deal_id);
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
     VALUES ($1,'pickup','רחוב הבדיקה 1, תל אביב',0,0) ON CONFLICT DO NOTHING`,
    [dealId]
  );
  return { dealId, sellerId };
}

/** A consumed OTP proof, so the join endpoint accepts without a real OTP flow. */
async function verifiedOtpChallenge(dealId: string) {
  const challengeId = randomUUID();
  await pool.query(
    `INSERT INTO siton.otp_challenges
       (challenge_id, channel, destination_hash, destination_display, purpose,
        code_hash, status, expires_at, verified_at, consumed_at, max_attempts, attempts_count,
        resend_count, idempotency_key, deal_id, created_at, updated_at)
     VALUES ($1,'sms','test-hash','test-display','buyer_join',
             'test-code-hash','consumed',now()+interval '1 hour',now(),now(),3,1,
             0,$2,$3,now(),now())`,
    [challengeId, `test:buyer_join:${challengeId}`, dealId]
  );
  await pool.query(
    `INSERT INTO siton.otp_proofs(challenge_id, token_hash, issued_at, expires_at)
     VALUES ($1,$2,now(),now()+interval '15 minutes')`,
    [challengeId, `test-proof-${challengeId}`]
  );
  return challengeId;
}

// ── Half 1: schema-backed invariants ─────────────────────────────────────────

await run("quantity bounds are enforced by the DATABASE, not only by TypeScript", async () => {
  const { dealId } = await seedDeal();
  for (const [label, qty] of [["zero", 0], ["negative", -5], ["absurd", 100000]] as const) {
    const rejection = await rejectedByDatabase(
      `INSERT INTO siton.participants (deal_id, buyer_id, qty, buyer_state, money_state)
       VALUES ($1,$2,$3,'JoinedAuthorized','AuthorizedHold')`,
      [dealId, `+97250${Math.floor(Math.random() * 10000000)}`, qty]
    );
    assert.ok(rejection, `the database accepted a ${label} quantity (${qty}) - the rule lives only in application code`);
  }
});

await run("deal unit bounds are enforced by the DATABASE", async () => {
  const cases: Array<[string, string, unknown[]]> = [
    [
      "min_units below one",
      `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id)
       VALUES ($1,100,0,10,1,now()+interval '1 day',$2)`,
      [`bad min ${randomUUID().slice(0, 6)}`, "seller-bad"]
    ],
    [
      "max_units below min_units",
      `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id)
       VALUES ($1,100,10,3,9,now()+interval '1 day',$2)`,
      [`bad max ${randomUUID().slice(0, 6)}`, "seller-bad"]
    ],
    [
      "threshold at zero",
      `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id)
       VALUES ($1,100,10,20,0,now()+interval '1 day',$2)`,
      [`bad threshold ${randomUUID().slice(0, 6)}`, "seller-bad"]
    ]
  ];
  for (const [label, sql, params] of cases) {
    assert.ok(await rejectedByDatabase(sql, params), `the database accepted ${label}`);
  }
});

await run("a participant cannot reference a deal that does not exist", async () => {
  const rejection = await rejectedByDatabase(
    `INSERT INTO siton.participants (deal_id, buyer_id, qty, buyer_state, money_state)
     VALUES ($1,$2,1,'JoinedAuthorized','AuthorizedHold')`,
    [randomUUID(), "+972500000001"]
  );
  assert.ok(rejection, "a participant was attached to a nonexistent deal - the foreign key is missing");
});

await run("an image cannot reference a deal that does not exist, and dies with its deal", async () => {
  const orphan = await rejectedByDatabase(
    `INSERT INTO siton.deal_images (deal_id, storage_key, mime_type, size_bytes)
     VALUES ($1,$2,'image/png',100)`,
    [randomUUID(), `orphan-${randomUUID()}`]
  );
  assert.ok(orphan, "an image was attached to a nonexistent deal");

  // Cascade: deleting a deal must not leave imagery addressable.
  const { dealId } = await seedDeal();
  await pool.query(
    `INSERT INTO siton.deal_images (deal_id, storage_key, mime_type, size_bytes)
     VALUES ($1,$2,'image/png',100)`,
    [dealId, `cascade-${randomUUID()}`]
  );
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const left = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.deal_images WHERE deal_id=$1`, [dealId]);
  assert.equal(left.rows[0].n, 0, "images outlived their deleted deal");
});

await run("an inquiry thread cannot reference a deal that does not exist", async () => {
  const rejection = await rejectedByDatabase(
    `INSERT INTO siton.seller_inquiry_threads
       (deal_id, seller_id, customer_name, customer_email, customer_ref, customer_access_token_hash)
     VALUES ($1,'seller-x','C','c@siton.test',$2,$3)`,
    [randomUUID(), randomUUID(), randomUUID().replace(/-/g, "")]
  );
  assert.ok(rejection, "an inquiry thread was attached to a nonexistent deal");
});

// ── Half 2: the invariant a constraint cannot express ────────────────────────

await run("VACUITY GUARD: a synthetic buyer can actually join", async () => {
  const { dealId } = await seedDeal({ maxUnits: 5, minUnits: 1 });
  const challengeId = await verifiedOtpChallenge(dealId);
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: { "content-type": "application/json", "x-request-id": randomUUID() },
    payload: {
      buyer_id: "+972500000101",
      otp_challenge_id: challengeId,
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
    }
  } as any);
  assert.equal(response.statusCode, 200, `the join fixture does not work, so the race below proves nothing: ${response.body}`);
  const total = await pool.query(
    `SELECT COALESCE(SUM(qty),0)::int AS units FROM siton.participants WHERE deal_id=$1`,
    [dealId]
  );
  assert.equal(total.rows[0].units, 1, "one join did not record one unit");
});

await run("CONCURRENT joins can never oversell a deal past max_units", async () => {
  // The oversell shape: read remaining capacity, decide there is room, write.
  // Interleave two requests between the read and the write and both decide yes.
  // Only real concurrency can distinguish a correct lock from a hopeful comment.
  const MAX_UNITS = 5;
  const ATTEMPTS = 14;
  const { dealId } = await seedDeal({ maxUnits: MAX_UNITS, minUnits: 1 });

  const joins = [];
  for (let index = 0; index < ATTEMPTS; index += 1) {
    const challengeId = await verifiedOtpChallenge(dealId);
    joins.push({ challengeId, buyerId: `+9725001${String(index).padStart(5, "0")}` });
  }

  const responses = await Promise.all(joins.map(({ challengeId, buyerId }) =>
    app.inject({
      method: "POST",
      url: `/deals/${dealId}/join`,
      headers: { "content-type": "application/json", "x-request-id": randomUUID() },
      payload: {
        buyer_id: buyerId,
        otp_challenge_id: challengeId,
        qty: 1,
        buyer_terms_accepted: true,
        payment_disclosure_accepted: true
      }
    } as any)
  ));

  for (const response of responses) {
    assert.ok(response.statusCode < 500, `a concurrent join faulted: ${response.statusCode} ${response.body.slice(0, 200)}`);
  }
  const accepted = responses.filter((response) => response.statusCode === 200).length;

  const totals = await pool.query(
    `SELECT COALESCE(SUM(qty),0)::int AS units, COUNT(*)::int AS rows FROM siton.participants WHERE deal_id=$1`,
    [dealId]
  );
  const units = Number(totals.rows[0].units);
  console.log(`  capacity race: ${ATTEMPTS} concurrent joins, ${accepted} accepted, ${units}/${MAX_UNITS} units recorded`);

  assert.ok(units <= MAX_UNITS, `OVERSOLD: ${units} units recorded against max_units ${MAX_UNITS}`);
  assert.ok(units > 0, "no join survived the race at all - the probe is not meaningful");
  assert.equal(accepted, units, `${accepted} joins reported success but ${units} units were recorded`);

  // "5 of 14 succeeded" is only evidence of a working capacity guard if the other
  // nine were refused BECAUSE the deal was full. If they had failed for some
  // unrelated reason - a bad fixture, an exhausted pool, a validation slip - the
  // count would look identical while proving nothing about the lock.
  const rejected = responses.filter((response) => response.statusCode !== 200);
  assert.equal(rejected.length, ATTEMPTS - accepted, "accepted/rejected counts do not add up");
  const notCapacity = rejected
    .map((response) => `${response.statusCode}:${(response.body || "").slice(0, 120)}`)
    .filter((text) => !/max_units_exceeded|capacity|full|sold_?out/i.test(text));
  assert.deepEqual(
    [...new Set(notCapacity)],
    [],
    "some joins were refused for a reason other than capacity, so this result is not evidence about the capacity guard"
  );
});

await run("a deal's recorded units never exceed max_units after mixed concurrent quantities", async () => {
  const MAX_UNITS = 6;
  const { dealId } = await seedDeal({ maxUnits: MAX_UNITS, minUnits: 1 });
  const quantities = [3, 3, 3, 2, 2, 1, 1, 4];
  const joins = [];
  for (let index = 0; index < quantities.length; index += 1) {
    joins.push({ challengeId: await verifiedOtpChallenge(dealId), buyerId: `+9725002${String(index).padStart(5, "0")}`, qty: quantities[index]! });
  }
  const responses = await Promise.all(joins.map(({ challengeId, buyerId, qty }) =>
    app.inject({
      method: "POST",
      url: `/deals/${dealId}/join`,
      headers: { "content-type": "application/json", "x-request-id": randomUUID() },
      payload: { buyer_id: buyerId, otp_challenge_id: challengeId, qty, buyer_terms_accepted: true, payment_disclosure_accepted: true }
    } as any)
  ));
  for (const response of responses) {
    assert.ok(response.statusCode < 500, `a concurrent join faulted: ${response.statusCode} ${response.body.slice(0, 200)}`);
  }
  const totals = await pool.query(
    `SELECT COALESCE(SUM(qty),0)::int AS units FROM siton.participants WHERE deal_id=$1`,
    [dealId]
  );
  const units = Number(totals.rows[0].units);
  console.log(`  mixed-quantity race: ${units}/${MAX_UNITS} units recorded`);
  assert.ok(units <= MAX_UNITS, `OVERSOLD with mixed quantities: ${units} units against max_units ${MAX_UNITS}`);
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
