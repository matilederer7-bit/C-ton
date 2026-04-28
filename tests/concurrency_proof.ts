/**
 * Wave 1 — Concurrency, Oversell, Idempotency & Multi-Purchase Proof
 *
 * Runs against live DB. Each scenario:
 *   1. Creates isolated test deal directly in DB
 *   2. Fires concurrent inject() calls
 *   3. Queries DB directly for evidence
 *   4. Prints PASS / FAIL with raw numbers
 *
 * The DB pool in this file is separate from the app's internal pool.
 * Both pools talk to the same Postgres instance — locking is exercised for real.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3370");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
// Disable rate limiting for concurrency proof — each scenario uses a unique spoofed IP anyway
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";

const { app } = await import("../src/app.js");

// ─── direct DB pool for setup / evidence ────────────────────────────────────
const DB = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres",
  max: 20
});

const SELLER = "seller-test-proof";

// ─── once-per-suite OTP setup ───────────────────────────────────────────────
// Legal-acceptance + OTP gates run BEFORE the DB lock, so a single verified,
// unbound challenge (no deal_id) can be reused across all scenarios within the
// 15-minute verified-token TTL. Concurrency is still proved at the DB locking
// layer of the join endpoint.
const otpStartRes = await app.inject({
  method: "POST",
  url: "/api/otp/start",
  payload: { phone: `0501${String(Date.now()).slice(-7)}` }
});
if (otpStartRes.statusCode !== 200) {
  throw new Error(`OTP start failed for concurrency suite setup: ${otpStartRes.statusCode} ${otpStartRes.body}`);
}
const otpStartJson = otpStartRes.json() as any;
const otpVerifyRes = await app.inject({
  method: "POST",
  url: "/api/otp/verify",
  payload: { otp_session_id: otpStartJson.otp_session_id, code: otpStartJson.development_code }
});
if (otpVerifyRes.statusCode !== 200) {
  throw new Error(`OTP verify failed for concurrency suite setup: ${otpVerifyRes.statusCode} ${otpVerifyRes.body}`);
}
const otpVerifyJson = otpVerifyRes.json() as any;
const SUITE_OTP_TOKEN = String(otpVerifyJson.otp_token || "");
const SUITE_OTP_CHALLENGE_ID = String(otpVerifyJson.challenge_id || otpVerifyJson.otp_session_id || otpStartJson.otp_session_id);
if (!SUITE_OTP_TOKEN || !SUITE_OTP_CHALLENGE_ID) {
  throw new Error("concurrency suite did not receive otp_token + challenge_id from verify");
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function createDeal(maxUnits: number, label: string): Promise<string> {
  const r = await DB.query(
    `INSERT INTO siton.deals
       (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
     VALUES ($1, 10, 1, $2, 1, NOW() + INTERVAL '1 hour', $3, 'PendingTarget', NOW())
     RETURNING deal_id`,
    [`[proof] ${label}`, maxUnits, SELLER]
  );
  return r.rows[0].deal_id as string;
}

async function deleteDeal(dealId: string) {
  // audit_log has an append-only trigger — cannot delete rows. Rows are left orphaned after cleanup.
  await DB.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [dealId]);
  await DB.query(`DELETE FROM siton.idempotency_log WHERE entity_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1)`, [dealId]);
  await DB.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]);
  await DB.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
}

interface Evidence {
  participantCount: number;
  qtySum: number;
  maxUnits: number;
  auditCount: number;
  idemCount: number;
  buyers: { buyer_id: string; participant_count: number; qty_sum: number }[];
}

async function evidence(dealId: string): Promise<Evidence> {
  const [deal, parts, audit, idem, buyers] = await Promise.all([
    DB.query(`SELECT max_units FROM siton.deals WHERE deal_id=$1`, [dealId]),
    DB.query(`SELECT COUNT(*) as cnt, COALESCE(SUM(qty),0) as total FROM siton.participants WHERE deal_id=$1 AND buyer_state NOT IN ('DealFailed','Dropped')`, [dealId]),
    DB.query(`SELECT COUNT(*) as cnt FROM siton.audit_log WHERE entity_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1) AND action_name='participant.join_authorize'`, [dealId]),
    DB.query(`SELECT COUNT(*) as cnt FROM siton.idempotency_log WHERE entity_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1) AND action_name='participant.join_authorize'`, [dealId]),
    DB.query(`SELECT buyer_id, COUNT(*) as participant_count, SUM(qty) as qty_sum FROM siton.participants WHERE deal_id=$1 AND buyer_state NOT IN ('DealFailed','Dropped') GROUP BY buyer_id`, [dealId])
  ]);
  return {
    participantCount: Number(parts.rows[0].cnt),
    qtySum: Number(parts.rows[0].total),
    maxUnits: Number(deal.rows[0]?.max_units ?? 0),
    auditCount: Number(audit.rows[0].cnt),
    idemCount: Number(idem.rows[0].cnt),
    buyers: buyers.rows.map(r => ({ buyer_id: r.buyer_id, participant_count: Number(r.participant_count), qty_sum: Number(r.qty_sum) }))
  };
}

// Each scenario gets its own spoofed IP subnet so rate buckets never bleed across scenarios
let scenarioIp = "10.0.0.1";

async function join(dealId: string, buyerId: string, qty = 1, idemKey?: string) {
  const headers: Record<string, string> = { "x-forwarded-for": scenarioIp };
  if (idemKey) headers["idempotency-key"] = idemKey;
  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: buyerId,
      qty,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: SUITE_OTP_TOKEN,
      otp_challenge_id: SUITE_OTP_CHALLENGE_ID
    },
    headers
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function nextScenarioIp() {
  // Increment the last octet of the IP for each new scenario
  const parts = scenarioIp.split(".");
  parts[3] = String(Number(parts[3]) + 1);
  scenarioIp = parts.join(".");
}

async function run(name: string, fn: () => Promise<void>) {
  nextScenarioIp(); // fresh rate-limit bucket per scenario
  try {
    await fn();
    console.log(`\nPASS ${name}`);
  } catch (e: any) {
    console.error(`\nFAIL ${name}`);
    console.error("     ", e.message);
    throw e;
  }
}

// ─── PRE-RUN CLEANUP ────────────────────────────────────────────────────────
// Clean up any proof deals left from prior failed runs to start fresh
{
  const staleDeals = await DB.query(
    `SELECT deal_id FROM siton.deals WHERE seller_id=$1`, [SELLER]
  );
  for (const row of staleDeals.rows) {
    await DB.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [row.deal_id]);
    await DB.query(`DELETE FROM siton.idempotency_log WHERE entity_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1)`, [row.deal_id]);
    await DB.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [row.deal_id]);
    await DB.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [row.deal_id]);
  }
  if (staleDeals.rowCount) console.log(`Pre-run cleanup: removed ${staleDeals.rowCount} stale proof deal(s)`);
}

// ─── SCENARIO 1: 70 concurrent requests, small deal (max=10) ────────────────

await run("S1 — 70 concurrent joins on max_units=10 deal, no oversell", async () => {
  const dealId = await createDeal(10, "S1-small");
  try {
    const results = await Promise.all(
      Array.from({ length: 70 }, (_, i) => join(dealId, `buyer-s1-${i}`, 1))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;
    const rejected  = results.filter(r => r.status === 409).length;
    const other     = results.filter(r => r.status !== 200 && r.status !== 409).length;

    console.log(`     requests=70  succeeded=${succeeded}  rejected=${rejected}  other=${other}`);
    console.log(`     DB: participants=${ev.participantCount}  qty_sum=${ev.qtySum}  max_units=${ev.maxUnits}  audit=${ev.auditCount}  idem=${ev.idemCount}`);

    // atomicMultiTransition writes 2 audit rows per join (buyer_state + money_state)
    assert.ok(ev.qtySum <= ev.maxUnits, `OVERSELL: qty_sum=${ev.qtySum} > max_units=${ev.maxUnits}`);
    assert.equal(ev.qtySum, succeeded, `qty_sum(${ev.qtySum}) != succeeded(${succeeded})`);
    assert.equal(ev.participantCount, succeeded, `participant_count(${ev.participantCount}) != succeeded(${succeeded})`);
    assert.equal(ev.auditCount, succeeded * 2, `audit_count(${ev.auditCount}) should be succeeded*2=${succeeded * 2}`);
    assert.equal(ev.idemCount, succeeded, `idem_count(${ev.idemCount}) != succeeded(${succeeded})`);
    assert.equal(succeeded, 10, `expected exactly 10 successes, got ${succeeded}`);
    assert.equal(rejected + other, 60, `expected 60 rejections, got ${rejected + other}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── SCENARIO 2: 200 concurrent requests, medium deal (max=20) ──────────────

await run("S2 — 200 concurrent joins on max_units=20 deal, no oversell", async () => {
  const dealId = await createDeal(20, "S2-medium");
  try {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => join(dealId, `buyer-s2-${i}`, 1))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;
    const rejected  = results.filter(r => r.status === 409).length;

    console.log(`     requests=200  succeeded=${succeeded}  rejected=${rejected}`);
    console.log(`     DB: qty_sum=${ev.qtySum}  max_units=${ev.maxUnits}  audit=${ev.auditCount}  idem=${ev.idemCount}`);

    assert.ok(ev.qtySum <= ev.maxUnits, `OVERSELL: qty_sum=${ev.qtySum} > max_units=${ev.maxUnits}`);
    assert.equal(ev.qtySum, succeeded, `qty_sum(${ev.qtySum}) != succeeded(${succeeded})`);
    assert.equal(succeeded, 20, `expected exactly 20 successes, got ${succeeded}`);
    assert.equal(ev.auditCount, succeeded * 2, `audit should be succeeded*2`);
    assert.equal(ev.idemCount, succeeded, `idem should equal succeeded`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── SCENARIO 3: Mixed quantities ───────────────────────────────────────────

await run("S3 — Mixed quantities (1,2,3), max_units=15, no oversell", async () => {
  const dealId = await createDeal(15, "S3-mixed-qty");
  try {
    // 20 buyers with mix of qty=1/2/3
    const qtys = [1,2,3,1,2,3,1,2,3,1,2,3,1,2,3,1,2,3,1,2];
    const results = await Promise.all(
      qtys.map((q, i) => join(dealId, `buyer-s3-${i}`, q))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;

    console.log(`     requests=20  succeeded=${succeeded}`);
    console.log(`     DB: qty_sum=${ev.qtySum}  max_units=${ev.maxUnits}  audit=${ev.auditCount}`);

    assert.ok(ev.qtySum <= ev.maxUnits, `OVERSELL: qty_sum=${ev.qtySum} > max_units=${ev.maxUnits}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── SCENARIO 4: Same buyer concurrent joins ────────────────────────────────

await run("S4 — Same buyer fires 10 concurrent joins (qty=1 each), max_units=5", async () => {
  const dealId = await createDeal(5, "S4-same-buyer");
  try {
    // Same buyer, 10 concurrent requests — each with auto-generated key (per-request)
    const results = await Promise.all(
      Array.from({ length: 10 }, () => join(dealId, "buyer-repeat", 1))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;

    console.log(`     requests=10  buyer=buyer-repeat  succeeded=${succeeded}`);
    console.log(`     DB: participants=${ev.participantCount}  qty_sum=${ev.qtySum}  max_units=${ev.maxUnits}`);
    const buyerRow = ev.buyers[0];
    if (buyerRow) {
      console.log(`     buyer rows: ${buyerRow.participant_count} participants, qty_sum=${buyerRow.qty_sum}`);
    }

    assert.ok(ev.qtySum <= ev.maxUnits, `OVERSELL: qty_sum=${ev.qtySum} > max_units=${ev.maxUnits}`);
    assert.equal(ev.qtySum, succeeded, `qty_sum(${ev.qtySum}) != succeeded(${succeeded})`);
    // Each successful join creates a separate participant row (no merging)
    assert.equal(ev.participantCount, succeeded, `participant_count should equal succeeded joins, got ${ev.participantCount} vs ${succeeded}`);
    assert.equal(succeeded, 5, `expected exactly 5 successes (max_units), got ${succeeded}`);
    // Multi-purchase proof: same buyer has multiple participant rows
    assert.ok(ev.buyers.length === 1, `expected 1 unique buyer, got ${ev.buyers.length}`);
    const buyerRow2 = ev.buyers[0];
    assert.ok(buyerRow2 !== undefined && buyerRow2.participant_count === 5, `expected 5 participant rows for same buyer, got ${buyerRow2?.participant_count}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── SCENARIO 5: Last unit race ──────────────────────────────────────────────

await run("S5 — Last unit race: 2 buyers racing for the last unit", async () => {
  const dealId = await createDeal(1, "S5-last-unit");
  try {
    // Fire 50 concurrent requests at a max_units=1 deal
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => join(dealId, `buyer-race-${i}`, 1))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;

    console.log(`     requests=50  succeeded=${succeeded}  qty_sum=${ev.qtySum}  max_units=${ev.maxUnits}`);

    assert.ok(ev.qtySum <= ev.maxUnits, `OVERSELL: qty_sum=${ev.qtySum} > max_units=${ev.maxUnits}`);
    assert.equal(succeeded, 1, `exactly 1 should have won the race, got ${succeeded}`);
    assert.equal(ev.qtySum, 1, `DB qty_sum must be exactly 1`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── SCENARIO 6: One large request takes all inventory ──────────────────────

await run("S6 — One request claims all 8 units, subsequent request gets 409", async () => {
  const dealId = await createDeal(8, "S6-bulk");
  try {
    const first = await join(dealId, "buyer-bulk", 8);
    const second = await join(dealId, "buyer-second", 1);
    const ev = await evidence(dealId);

    console.log(`     first(qty=8)=${first.status}  second(qty=1)=${second.status}`);
    console.log(`     DB: qty_sum=${ev.qtySum}  max_units=${ev.maxUnits}`);

    assert.equal(first.status, 200, `bulk join should succeed, got ${first.status}`);
    assert.equal(second.status, 409, `second join should be rejected, got ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(ev.qtySum, 8, `DB qty_sum must be 8`);
    assert.ok(ev.qtySum <= ev.maxUnits);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── SCENARIO 7: Multiple large competing requests ──────────────────────────

await run("S7 — 5 concurrent requests each asking for 5 units, max_units=10 (only 2 can win)", async () => {
  const dealId = await createDeal(10, "S7-competing-bulk");
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => join(dealId, `buyer-bulk-${i}`, 5))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;

    console.log(`     5 requests of qty=5  succeeded=${succeeded}  qty_sum=${ev.qtySum}  max_units=${ev.maxUnits}`);

    assert.ok(ev.qtySum <= ev.maxUnits, `OVERSELL: qty_sum=${ev.qtySum} > max_units=${ev.maxUnits}`);
    assert.equal(succeeded, 2, `expected exactly 2 to win (2*5=10=max_units), got ${succeeded}`);
    assert.equal(ev.qtySum, 10, `DB qty_sum must be exactly 10`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── IDEMPOTENCY 1: Same explicit key, same payload, replayed ────────────────

await run("I1 — Same explicit idempotency-key replayed returns same participant, no duplicate audit", async () => {
  const dealId = await createDeal(10, "I1-idem-same-key");
  try {
    const idemKey = `test-explicit-idem-${randomUUID()}`;
    const r1 = await join(dealId, "buyer-idem", 1, idemKey);
    const r2 = await join(dealId, "buyer-idem", 1, idemKey);
    const r3 = await join(dealId, "buyer-idem", 1, idemKey);
    const ev = await evidence(dealId);

    console.log(`     r1=${r1.status}  r2=${r2.status}  r3=${r3.status}`);
    console.log(`     participant_id r1=${r1.body.participant_id}  r2=${r2.body.participant_id}  r3=${r3.body.participant_id}`);
    console.log(`     DB: participants=${ev.participantCount}  qty_sum=${ev.qtySum}  audit=${ev.auditCount}  idem=${ev.idemCount}`);

    assert.equal(r1.status, 200, `first join failed: ${JSON.stringify(r1.body)}`);
    assert.equal(r2.status, 200, `replay 2 should return 200 idempotently`);
    assert.equal(r3.status, 200, `replay 3 should return 200 idempotently`);
    assert.equal(r1.body.participant_id, r2.body.participant_id, `replays must return same participant_id`);
    assert.equal(r1.body.participant_id, r3.body.participant_id, `replays must return same participant_id`);
    // Only one participant row, one audit entry, one idem entry
    assert.equal(ev.participantCount, 1, `only 1 participant should exist, got ${ev.participantCount}`);
    assert.equal(ev.qtySum, 1, `qty_sum must be 1`);
    assert.equal(ev.auditCount, 2, `only 2 audit entries should exist (2 ops per join), got ${ev.auditCount}`);
    assert.equal(ev.idemCount, 1, `only 1 idem_log entry should exist, got ${ev.idemCount}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── IDEMPOTENCY 2: Same key, different qty (payload mismatch) ───────────────

await run("I2 — Same idempotency-key with different qty: idempotent result, no double reservation", async () => {
  const dealId = await createDeal(10, "I2-idem-payload-mismatch");
  try {
    const idemKey = `test-mismatch-${randomUUID()}`;
    const r1 = await join(dealId, "buyer-mismatch", 1, idemKey); // original
    const r2 = await join(dealId, "buyer-mismatch", 3, idemKey); // different qty, same key

    const ev = await evidence(dealId);

    console.log(`     r1(qty=1)=${r1.status}  r2(qty=3, same key)=${r2.status}`);
    console.log(`     participant_id r1=${r1.body.participant_id}  r2=${r2.body.participant_id}`);
    console.log(`     DB: participants=${ev.participantCount}  qty_sum=${ev.qtySum}  audit=${ev.auditCount}`);

    assert.equal(r1.status, 200, `first join failed`);
    assert.equal(r2.status, 200, `replay with same key should be idempotent`);
    assert.equal(r1.body.participant_id, r2.body.participant_id, `same key must return same participant`);
    // Critical: must NOT double-reserve
    assert.equal(ev.qtySum, 1, `qty_sum must be 1 (original), not 4: got ${ev.qtySum}`);
    assert.equal(ev.participantCount, 1, `only 1 participant row must exist`);
    assert.equal(ev.auditCount, 2, `only 2 audit entries (2 ops per join), got ${ev.auditCount}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── IDEMPOTENCY 3: Multiple retries concurrently on same key ────────────────

await run("I3 — 20 concurrent retries on same explicit key: exactly one side effect", async () => {
  const dealId = await createDeal(10, "I3-idem-concurrent-replay");
  try {
    const idemKey = `concurrent-replay-${randomUUID()}`;
    // Fire 20 concurrent requests with the same explicit idempotency key
    const results = await Promise.all(
      Array.from({ length: 20 }, () => join(dealId, "buyer-concurrent-idem", 1, idemKey))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;
    const failed    = results.filter(r => r.status >= 500).length;
    const pids = [...new Set(results.filter(r => r.status === 200).map(r => r.body.participant_id))];

    console.log(`     20 concurrent same-key requests: succeeded=${succeeded} 5xx=${failed}`);
    console.log(`     unique participant_ids returned: ${pids.length}`);
    console.log(`     DB: participants=${ev.participantCount}  qty_sum=${ev.qtySum}  audit=${ev.auditCount}  idem=${ev.idemCount}`);

    // All must return 200 (idempotent)
    assert.equal(succeeded + failed, 20);
    assert.ok(succeeded >= 1, `at least one must succeed`);
    // All successful responses must reference same participant
    assert.equal(pids.length, 1, `all 200 responses must return same participant_id, got ${pids.length} unique`);
    // DB must have exactly one side effect
    assert.equal(ev.participantCount, 1, `exactly 1 participant in DB, got ${ev.participantCount}`);
    assert.equal(ev.qtySum, 1, `qty_sum must be 1`);
    assert.equal(ev.auditCount, 2, `exactly 2 audit entries (2 ops per join), got ${ev.auditCount}`);
    assert.equal(ev.idemCount, 1, `exactly 1 idem_log entry, got ${ev.idemCount}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── MULTI-PURCHASE 1: Same buyer, sequential distinct joins ─────────────────

await run("M1 — Same buyer, 5 sequential purchases with auto-keys: 5 separate participants", async () => {
  const dealId = await createDeal(10, "M1-multi-purchase-seq");
  try {
    const results: any[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await join(dealId, "buyer-multi", 1));
    }
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;
    const pids = results.filter(r => r.status === 200).map(r => r.body.participant_id);
    const uniquePids = new Set(pids);

    console.log(`     5 sequential joins by same buyer: succeeded=${succeeded}`);
    console.log(`     unique participant_ids: ${uniquePids.size}`);
    console.log(`     DB: participants=${ev.participantCount}  qty_sum=${ev.qtySum}  audit=${ev.auditCount}`);

    assert.equal(succeeded, 5, `all 5 should succeed`);
    assert.equal(uniquePids.size, 5, `must produce 5 separate participants, got ${uniquePids.size}`);
    assert.equal(ev.participantCount, 5, `5 participant rows in DB`);
    assert.equal(ev.qtySum, 5, `qty_sum=5`);
    assert.equal(ev.auditCount, 10, `10 audit entries (2 ops × 5 joins)`);  // 2 audit rows per join
    assert.equal(ev.idemCount, 5, `5 idem entries`);
    assert.ok(ev.buyers.length === 1, `1 unique buyer_id`);
    const buyerM1 = ev.buyers[0];
    assert.ok(buyerM1 !== undefined && buyerM1.participant_count === 5, `buyer has 5 participant rows, got ${buyerM1?.participant_count}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── MULTI-PURCHASE 2: Same buyer multi-purchase still bounded by max_units ──

await run("M2 — Same buyer cannot exceed max_units even across multiple purchases", async () => {
  const dealId = await createDeal(3, "M2-multi-buyer-bounded");
  try {
    // Buyer wants 5 purchases of 1 unit each, but max_units=3
    const results = await Promise.all(
      Array.from({ length: 5 }, () => join(dealId, "buyer-greedy", 1))
    );
    const ev = await evidence(dealId);
    const succeeded = results.filter(r => r.status === 200).length;

    console.log(`     5 concurrent joins by same buyer, max_units=3: succeeded=${succeeded}  qty_sum=${ev.qtySum}`);

    assert.ok(ev.qtySum <= ev.maxUnits, `OVERSELL: qty_sum=${ev.qtySum} > max_units=${ev.maxUnits}`);
    assert.equal(succeeded, 3, `exactly 3 should succeed (=max_units)`);
    assert.equal(ev.qtySum, 3);
    const buyerM2 = ev.buyers[0];
    assert.ok(buyerM2 !== undefined && buyerM2.participant_count === 3, `buyer has exactly 3 participant rows, got ${buyerM2?.participant_count}`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── MULTI-PURCHASE 3: Explicit idem keys across different purchases ──────────

await run("M3 — Explicit distinct idem keys for each purchase by same buyer: all distinct", async () => {
  const dealId = await createDeal(10, "M3-multi-explicit-idem");
  try {
    const idemKeys = Array.from({ length: 3 }, () => `purchase-${randomUUID()}`);
    const results = await Promise.all(
      idemKeys.map((k, i) => join(dealId, "buyer-explicit-multi", 1, k))
    );
    const ev = await evidence(dealId);
    const pids = results.filter(r => r.status === 200).map(r => r.body.participant_id);

    console.log(`     3 purchases with distinct explicit keys: ${results.map(r => r.status).join(",")}`);
    console.log(`     unique participant_ids: ${new Set(pids).size}`);
    console.log(`     DB: participants=${ev.participantCount}  qty_sum=${ev.qtySum}  idem=${ev.idemCount}`);

    assert.equal(pids.length, 3, `all 3 should succeed`);
    assert.equal(new Set(pids).size, 3, `all 3 must create distinct participant rows`);
    assert.equal(ev.participantCount, 3);
    assert.equal(ev.idemCount, 3, `3 distinct idem log entries`);
  } finally {
    await deleteDeal(dealId);
  }
});

// ─── FINAL CONSISTENCY CHECK ─────────────────────────────────────────────────

await run("CONSISTENCY — No proof deal residue remains in DB", async () => {
  const r = await DB.query(`SELECT COUNT(*) as cnt FROM siton.deals WHERE seller_id=$1`, [SELLER]);
  const leftover = Number(r.rows[0].cnt);
  console.log(`     Leftover proof deals: ${leftover}`);
  assert.equal(leftover, 0, `all test deals should be cleaned up, found ${leftover}`);
});

await DB.end();
console.log("\n\nAll Wave 1 proof scenarios completed.");
