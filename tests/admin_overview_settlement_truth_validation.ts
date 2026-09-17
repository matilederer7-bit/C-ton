// Admin overview — settlement money is SUCCESSFUL money only.
//
// Regression for the closed-pilot war game finding (2026-09-09, ported from
// codex/closed-pilot-war-game): /api/admin/overview summed every joined unit
// of a Completed deal into the seller settlement figure, so released, dropped
// and failed-charge orders inflated "gross_amount" and the platform fee shown
// to the operator. The read model now filters on money_state
// ChargedSuccess / RecoveredCharge — the same rule the seller listing, the
// exports and the fee ledger already use.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3463");
process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `overview-test-admin-${randomUUID().slice(0, 8)}`;

const { app } = await import("../src/app.js");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const tag = randomUUID().slice(0, 6);
const sellerId = `overview-seller-${tag}`;
await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
   VALUES ($1,$1,$1,$2,'approved','active') ON CONFLICT (seller_id) DO NOTHING`,
  [sellerId, `${sellerId}@example.test`]
);

async function completedDeal(price: number) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units, price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,'Completed',2,2,50,$4, now()+interval '7 days', now(), now(), now())`,
    [dealId, sellerId, `Overview truth ${tag}`, price]
  );
  return dealId;
}
async function participant(dealId: string, buyerState: string, moneyState: string, qty: number, deliveryCost: number) {
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, buyer_name, buyer_phone, delivery_cost, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'קונה','0500000000',$7,now(),now())`,
    [randomUUID(), dealId, `+97250${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 9)}`, qty, buyerState, moneyState, deliveryCost]
  );
}

await run("admin overview settlement excludes released, dropped and failed-charge orders", async () => {
  const before = await app.inject({ method: "GET", url: "/api/admin/overview", headers: ADMIN });
  assert.equal(before.statusCode, 200, before.body);
  const baseline = Number(before.json().admin_surface.settlements.seller_workspace.gross_amount);

  const dealId = await completedDeal(100);
  // canonical (buyer_state, money_state) pairs — see tests/helpers PARTICIPANT_PATHS
  await participant(dealId, "ChargedSuccess", "ChargedSuccess", 2, 20);              // 220 counts
  await participant(dealId, "Recovered", "RecoveredCharge", 1, 0);                    // 100 counts
  await participant(dealId, "Dropped", "AuthReleased", 3, 20);                        // released: not revenue
  await participant(dealId, "ChargeFailedCompletion", "ChargeFailedRecovery", 2, 20); // still recovering: not revenue
  await participant(dealId, "DealFailed", "AuthReleased", 1, 0);                      // failed: not revenue

  const after = await app.inject({ method: "GET", url: "/api/admin/overview", headers: ADMIN });
  assert.equal(after.statusCode, 200, after.body);
  const workspace = after.json().admin_surface.settlements.seller_workspace;
  const delta = Number(workspace.gross_amount) - baseline;
  assert.equal(delta, 320, `only ChargedSuccess/RecoveredCharge money is settlement (saw +${delta}; the unfixed model reported +${100 * 9 + 60})`);

  const truth = await pool.query(
    `SELECT COALESCE(SUM(d.price_per_unit * p.qty + p.delivery_cost), 0)::numeric AS gross
       FROM siton.deals d JOIN siton.participants p USING (deal_id)
      WHERE d.state='Completed' AND p.money_state IN ('ChargedSuccess','RecoveredCharge')`
  );
  assert.equal(Number(workspace.gross_amount), Number(truth.rows[0].gross), "the overview matches the database money truth exactly");
});

await run("a Completed deal with only unpaid orders contributes zero settlement", async () => {
  const before = await app.inject({ method: "GET", url: "/api/admin/overview", headers: ADMIN });
  const baseline = Number(before.json().admin_surface.settlements.seller_workspace.gross_amount);
  const dealId = await completedDeal(250);
  await participant(dealId, "Dropped", "AuthReleased", 4, 30);
  const after = await app.inject({ method: "GET", url: "/api/admin/overview", headers: ADMIN });
  assert.equal(Number(after.json().admin_surface.settlements.seller_workspace.gross_amount), baseline);
  assert.equal(Number(after.json().admin_surface.settlements.seller_workspace.completed_deals) >= 2, true, "the deal still counts as completed — money and inventory are separate facts");
});

await pool.end();
await app.close();
console.log("ADMIN_OVERVIEW_SETTLEMENT_TRUTH_PASS");
