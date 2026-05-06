import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3420");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function waitForImportedAppListen() {
  const deadline = Date.now() + 5_000;
  while (!(app as any).server?.listening && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function closeImportedApp() {
  await waitForImportedAppListen();
  await app.close().catch(() => undefined);
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function insertCompletedDeal(dealId: string, sellerId: string, title = "עסקה בדיקה") {
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,'Completed',1,1,10,50.00,
             now()+interval '7 days', now(), now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId, sellerId, title]
  );
}

async function insertParticipant(
  participantId: string,
  dealId: string,
  buyerState: string,
  moneyState: string,
  buyerId = "+972500000001"
) {
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, created_at, updated_at)
     VALUES ($1,$2,$3,2,$4,$5,now(),now())
     ON CONFLICT (participant_id) DO NOTHING`,
    [participantId, dealId, buyerId, buyerState, moneyState]
  );
}

await waitForImportedAppListen();

try {
// Test 1: export returns only eligible buyers
await run("shipping export includes only eligible buyers (ChargedSuccess, RecoveredCharge, DealCompleted)", async () => {
  const dealId = randomUUID();
  const sellerId = `seller-export-test-${randomUUID().slice(0, 8)}`;
  await insertCompletedDeal(dealId, sellerId, "עסקה ייצוא");

  const p1 = randomUUID(); // eligible: ChargedSuccess
  const p2 = randomUUID(); // eligible: RecoveredCharge
  const p3 = randomUUID(); // eligible: DealCompleted buyer_state
  const p4 = randomUUID(); // ineligible: DealFailed
  const p5 = randomUUID(); // ineligible: Dropped

  await insertParticipant(p1, dealId, "DealCompleted", "ChargedSuccess", "+972501111111");
  await insertParticipant(p2, dealId, "DealCompleted", "RecoveredCharge", "+972502222222");
  await insertParticipant(p3, dealId, "DealCompleted", "ChargedSuccess", "+972503333333");
  await insertParticipant(p4, dealId, "DealFailed", "AuthReleased", "+972504444444");
  await insertParticipant(p5, dealId, "Dropped", "AuthReleased", "+972505555555");

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/shipping-export`,
    headers: { "x-seller-id": sellerId }
  });

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.ok(
    String(res.headers["content-type"]).includes("text/csv"),
    `expected text/csv, got ${res.headers["content-type"]}`
  );
  assert.ok(
    String(res.headers["content-disposition"]).includes(`siton-shipping-${dealId}.csv`),
    "content-disposition should include deal id"
  );

  const csv = res.body;
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter((l) => l.trim());
  // header + 3 eligible rows
  assert.equal(lines.length, 4, `expected 4 lines (header + 3 eligible), got ${lines.length}:\n${csv}`);

  assert.ok(lines[0]?.startsWith("deal_id,"), "first line should be header");
  const participantIds = lines.slice(1).map((l) => l.split(",")[2] ?? "");
  assert.ok(participantIds.includes(p1), "p1 (ChargedSuccess) should be in export");
  assert.ok(participantIds.includes(p2), "p2 (RecoveredCharge) should be in export");
  assert.ok(participantIds.includes(p3), "p3 (DealCompleted+ChargedSuccess) should be in export");
  assert.ok(!participantIds.includes(p4), "p4 (DealFailed) must not be in export");
  assert.ok(!participantIds.includes(p5), "p5 (Dropped) must not be in export");
});

// Test 2: ownership enforcement — wrong seller gets 403
await run("shipping export returns 403 when seller does not own the deal", async () => {
  const dealId = randomUUID();
  const ownerSellerId = `seller-owner-${randomUUID().slice(0, 8)}`;
  const otherSellerId = `seller-other-${randomUUID().slice(0, 8)}`;
  await insertCompletedDeal(dealId, ownerSellerId, "עסקה בעלות");

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/shipping-export`,
    headers: { "x-seller-id": otherSellerId }
  });

  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
});

// Test 3: deal not completed returns 409
await run("shipping export returns 409 with deal_not_completed for non-completed deal", async () => {
  const dealId = randomUUID();
  const sellerId = `seller-notcomplete-${randomUUID().slice(0, 8)}`;

  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,'עסקה בתהליך','Charging',1,1,10,50.00,
             now()+interval '7 days', now(), now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId, sellerId]
  );

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/shipping-export`,
    headers: { "x-seller-id": sellerId }
  });

  assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode}: ${res.body}`);
  const body = res.json();
  assert.equal(body.code, "deal_not_completed", `expected deal_not_completed code, got ${JSON.stringify(body)}`);
});

// Test 4: empty eligible buyers → CSV with headers only, no crash
await run("shipping export returns headers-only CSV when no eligible buyers exist", async () => {
  const dealId = randomUUID();
  const sellerId = `seller-empty-${randomUUID().slice(0, 8)}`;
  await insertCompletedDeal(dealId, sellerId, "עסקה ריקה");

  await insertParticipant(randomUUID(), dealId, "DealFailed", "AuthReleased", "+972509999999");

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/shipping-export`,
    headers: { "x-seller-id": sellerId }
  });

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  const csv = res.body.replace(/^﻿/, "");
  const lines = csv.split("\r\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, "should return only the header line when no eligible buyers");
  assert.ok(lines[0]?.startsWith("deal_id,"), "header must be present");
});

console.log("All seller shipping export tests passed.");
} finally {
  await closeImportedApp();
  await pool.end().catch(() => undefined);
}
