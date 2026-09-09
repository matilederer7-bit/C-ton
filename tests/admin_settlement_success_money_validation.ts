// INDEPENDENT REVIEW of codex/closed-pilot-war-game (P-1, admin settlement).
//
// Proves, against the real runtime on a fresh database, that operator- and
// seller-facing settlement money derives ONLY from authoritative successful
// money states, and that the 8% Siton fee shown on those surfaces obeys the
// canonical rule (base = collected charge incl. delivery, EXCLUDING the
// authoritative buyer VAT) in BOTH VAT authority modes.
//
//   A1  Completed deal, mixed states → admin overview gross equals the
//       success-only SQL sum (ChargedSuccess + RecoveredCharge); released,
//       refunded and unrecovered orders never leak (FAILS on master d4c7877:
//       joined units were counted as revenue; PASSES with the Codex fix).
//   A2  a Failed deal with a captured (not yet refunded) order is not a
//       completed settlement.
//   A3  joined_units on the deal list keep their inventory meaning (unchanged).
//   A4  synthetic_zero VAT: overview fee = 8% of gross + fee VAT.
//   A5  explicit 18% VAT: overview fee base must be gross MINUS buyer VAT
//       (FAILS on master AND on the Codex branch: summarizeMoney discards the
//       VAT it is given; PASSES with the review-branch helper fix).
//   A6  the seller's own deal money summary obeys the same rule.
//   A7  no distributor / affiliate commission anywhere in these surfaces;
//       fee rate constant is exactly 0.08.
//
// Money states are moved along the canonical transition matrices with the
// shared trigger-legal fixture (synthetic fixture transitions, no provider
// call, no real money) — this is a READ-MODEL test, not a payment proof.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ADMIN_API_KEY = "settlement-review-admin-key";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "20000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "20000";
process.env.RATE_LIMIT_READ_MAX = process.env.RATE_LIMIT_READ_MAX || "20000";
process.env.PORT = process.env.PORT || "3631";
delete process.env.SITON_VAT_MODE;

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const fixture = await import("./helpers/physical_fulfillment_fixture.js");
const { calculatePlatformFeeMoney, SITON_PLATFORM_FEE_RATE } = await import("../src/platform_fee_money.js");
const { SITON_PLATFORM_FEE_VAT_RATE } = await import("../src/runtime_config.js");

const ADMIN = { "x-admin-key": "settlement-review-admin-key" };
const RUN = randomUUID().slice(0, 8);
const seller = `seller-settle-${RUN}`;
let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.message || e}`); failed++; }
}
const round = (n: number) => Math.round(n * 100) / 100;

async function seedSeller(id: string) {
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
     VALUES ($1,$1,$1,$2,'approved','active') ON CONFLICT (seller_id) DO NOTHING`,
    [id, `${id}@siton.test`]
  );
  await fixture.ensureSellerReady(app, id, `Review seller ${id}`);
}

let phoneSeq = 200;
async function joinAs(dealId: string, qty: number, optionType: "pickup" | "delivery") {
  phoneSeq += 1;
  return fixture.joinDeal(app, dealId, {
    phone: `05022${String(phoneSeq).padStart(5, "0")}`,
    name: `Buyer ${phoneSeq}`,
    qty,
    optionType,
    email: `buyer${phoneSeq}@buyer.siton.test`,
    ...(optionType === "delivery" ? { address: `Street ${phoneSeq}`, city: "Tel Aviv", notes: "door" } : {})
  });
}

async function overview() {
  const r = await app.inject({ method: "GET", url: "/api/admin/overview", headers: ADMIN });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as any;
}

async function successOnlySql(dealIds: string[]) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(d.price_per_unit * p.qty), 0)::numeric AS product,
            COALESCE(SUM(p.delivery_cost), 0)::numeric AS delivery
     FROM siton.deals d JOIN siton.participants p USING (deal_id)
     WHERE d.deal_id = ANY($1::uuid[]) AND d.state = 'Completed'
       AND p.money_state IN ('ChargedSuccess','RecoveredCharge')`,
    [dealIds]
  );
  return { product: Number(r.rows[0].product), delivery: Number(r.rows[0].delivery) };
}

// ── topology ─────────────────────────────────────────────────────────────────
// Deal A (price 60, pickup 0 / delivery 20), six orders:
//   p0 qty1 pickup   → ChargedSuccess        counted   60
//   p1 qty2 delivery → RecoveredCharge       counted  140
//   p2 qty1 pickup   → AuthReleased/Dropped  excluded  60
//   p3 qty1 delivery → Refunded              excluded  80
//   p4 qty3 pickup   → ChargeFailedRecovery  excluded 180 (unrecovered)
//   p5 qty1 delivery → ChargedSuccess        counted   80
// Success money = 280 (product 240 + delivery 40); joined money = 600.
// Deal B (price 60): one qty2 delivery order captured, deal Failed → not a
// completed settlement (refund pending); joined money 140.
let dealA = "";
let dealB = "";
const EXPECTED_PRODUCT = 240;
const EXPECTED_DELIVERY = 40;
const EXPECTED_GROSS = 280;
const JOINED_GROSS_A = 600;

await run("setup: seller, deal A (mixed money states, Completed), deal B (captured order, Failed)", async () => {
  await seedSeller(seller);
  dealA = await fixture.createDeal(app, seller, { title: `Settlement review A ${RUN}`, price: 60, minUnits: 3, maxUnits: 40 });
  await fixture.publishDeal(app, seller, dealA);
  const plan: Array<[number, "pickup" | "delivery", keyof typeof fixture.PARTICIPANT_PATHS]> = [
    [1, "pickup", "ChargedSuccess"],
    [2, "delivery", "RecoveredCharge"],
    [1, "pickup", "AuthReleased"],
    [1, "delivery", "Refunded"],
    [3, "pickup", "ChargeFailedRecovery"],
    [1, "delivery", "ChargedSuccess"]
  ];
  for (const [qty, option, target] of plan) {
    const joined = await joinAs(dealA, qty, option);
    await fixture.forceParticipantTo(pool, joined.participant_id, target);
  }
  await fixture.forceDealState(pool, dealA, "Completed");

  dealB = await fixture.createDeal(app, seller, { title: `Settlement review B ${RUN}`, price: 60, minUnits: 3, maxUnits: 40 });
  await fixture.publishDeal(app, seller, dealB);
  const captured = await joinAs(dealB, 2, "delivery");
  await fixture.forceParticipantTo(pool, captured.participant_id, "ChargedSuccess");
  await fixture.forceDealState(pool, dealB, "Failed");

  const truth = await successOnlySql([dealA, dealB]);
  assert.equal(truth.product, EXPECTED_PRODUCT);
  assert.equal(truth.delivery, EXPECTED_DELIVERY);
  const states = await pool.query(`SELECT money_state, count(*)::int AS n FROM siton.participants WHERE deal_id=$1 GROUP BY money_state ORDER BY money_state`, [dealA]);
  const actualStates = states.rows.map((r: any) => `${r.money_state}=${r.n}`).sort();
  assert.deepEqual(actualStates, ["AuthReleased=1", "ChargeFailedRecovery=1", "ChargedSuccess=2", "RecoveredCharge=1", "Refunded=1"], `fixture states: ${actualStates.join(",")}`);
});

await run("A1 admin overview settlement gross == success-only money (released / refunded / unrecovered orders never leak)", async () => {
  const o = await overview();
  const s = o.admin_surface.settlements.seller_workspace;
  assert.equal(s.completed_deals, 1, "only deal A is Completed");
  assert.equal(Number(s.gross_amount), EXPECTED_GROSS, `gross_amount ${s.gross_amount} must equal success-only ${EXPECTED_GROSS} (joined money would be ${JOINED_GROSS_A})`);
  assert.notEqual(Number(s.gross_amount), JOINED_GROSS_A);
});

await run("A2 a Failed deal with a captured (refund-pending) order is not a completed settlement", async () => {
  const o = await overview();
  const s = o.admin_surface.settlements.seller_workspace;
  assert.equal(s.completed_deals, 1);
  assert.equal(Number(s.gross_amount), EXPECTED_GROSS, "deal B's 140 must not be counted");
  const listed = (o.admin_surface.deals as any[]).find((d) => d.deal_id === dealB);
  assert.ok(listed && listed.state === "Failed");
});

await run("A3 joined_units keep their inventory meaning on the deal list (9 units joined on deal A, 2 on deal B)", async () => {
  const o = await overview();
  const a = (o.admin_surface.deals as any[]).find((d) => d.deal_id === dealA);
  const b = (o.admin_surface.deals as any[]).find((d) => d.deal_id === dealB);
  assert.ok(a, `deal A must be listed: ${JSON.stringify((o.admin_surface.deals as any[]).map((d) => d.deal_id))}`);
  assert.equal(Number(a.metrics.joined_units), 9, `inventory counts every participant row: ${JSON.stringify(a.metrics)}`);
  assert.equal(Number(b.metrics.joined_units), 2);
});

await run("A4 synthetic_zero VAT: overview fee = 8% of the success gross (+ 18% VAT on the fee), never on joined money", async () => {
  delete process.env.SITON_VAT_MODE;
  const o = await overview();
  const fee = Number(o.admin_surface.settlements.seller_workspace.platform_fee_amount);
  const expected = calculatePlatformFeeMoney({ grossAmount: EXPECTED_GROSS, vatAmount: 0 });
  assert.equal(expected.platform_fee_base_amount, round(EXPECTED_GROSS * 0.08));
  assert.equal(fee, expected.platform_fee_total_amount, `fee ${fee} must be 8% base ${expected.platform_fee_base_amount} + fee VAT ${expected.platform_fee_vat_amount}`);
  assert.notEqual(fee, calculatePlatformFeeMoney({ grossAmount: JOINED_GROSS_A }).platform_fee_total_amount);
});

const EXPLICIT = { SITON_VAT_MODE: "explicit", SITON_VAT_RATE_PRODUCT: "0.18", SITON_VAT_RATE_DELIVERY: "0.18" };
function withExplicitVat<T>(fn: () => Promise<T>): Promise<T> {
  Object.assign(process.env, EXPLICIT);
  return fn().finally(() => { for (const key of Object.keys(EXPLICIT)) delete process.env[key]; });
}
// Independent VAT arithmetic: gross is VAT-inclusive, VAT portion = gross − gross/1.18 per component.
const buyerVat = round((EXPECTED_PRODUCT - EXPECTED_PRODUCT / 1.18) + (EXPECTED_DELIVERY - EXPECTED_DELIVERY / 1.18));

await run("A5 explicit 18% VAT: the overview fee base is the success gross MINUS authoritative buyer VAT (canonical 8% rule)", async () => {
  const o = await withExplicitVat(overview);
  const fee = Number(o.admin_surface.settlements.seller_workspace.platform_fee_amount);
  const canonical = calculatePlatformFeeMoney({ grossAmount: EXPECTED_GROSS, vatAmount: buyerVat });
  assert.equal(canonical.fee_base_amount, round(EXPECTED_GROSS - buyerVat));
  const expectedBase = round(round(EXPECTED_GROSS - buyerVat) * SITON_PLATFORM_FEE_RATE);
  const expectedTotal = round(expectedBase + round(expectedBase * SITON_PLATFORM_FEE_VAT_RATE));
  assert.equal(canonical.platform_fee_total_amount, expectedTotal);
  assert.equal(fee, expectedTotal, `overview fee ${fee} must be 8% of (${EXPECTED_GROSS} − VAT ${buyerVat}) + fee VAT = ${expectedTotal}; 8% of the VAT-inclusive gross would be ${calculatePlatformFeeMoney({ grossAmount: EXPECTED_GROSS }).platform_fee_total_amount}`);
});

await run("A6 the seller's own deal money summary follows the same rule in both VAT modes", async () => {
  const read = async () => {
    const r = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}`, headers: fixture.sellerHeaders(seller) });
    assert.equal(r.statusCode, 200, r.body);
    return (r.json() as any).receipts_surface.summary;
  };
  const zero = await read();
  assert.equal(Number(zero.gross_amount), EXPECTED_GROSS, "seller summary counts success money only");
  assert.equal(Number(zero.siton_fee_amount), calculatePlatformFeeMoney({ grossAmount: EXPECTED_GROSS }).platform_fee_total_amount);
  const explicit = await withExplicitVat(read);
  const canonical = calculatePlatformFeeMoney({ grossAmount: EXPECTED_GROSS, vatAmount: buyerVat });
  assert.equal(Number(explicit.siton_fee_amount), canonical.platform_fee_total_amount, `seller fee ${explicit.siton_fee_amount} must exclude buyer VAT`);
});

await run("A7 no distributor / affiliate commission on any settlement surface; fee rate is exactly 0.08", async () => {
  assert.equal(SITON_PLATFORM_FEE_RATE, 0.08);
  const o = await overview();
  const text = JSON.stringify(o.admin_surface.settlements);
  for (const forbidden of ["commission", "distributor_fee", "affiliate_fee", "referral_fee", "reward_amount"]) {
    assert.ok(!text.toLowerCase().includes(forbidden), `settlement surface must not carry ${forbidden}`);
  }
  const sellerDeal = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}`, headers: fixture.sellerHeaders(seller) });
  const surface = JSON.stringify((sellerDeal.json() as any).receipts_surface.summary).toLowerCase();
  assert.ok(!surface.includes("commission") && !surface.includes("affiliate_fee"));
  const analytics = await app.inject({ method: "GET", url: "/api/seller/analytics?period=all", headers: fixture.sellerHeaders(seller) });
  if (analytics.statusCode === 200) {
    const body = analytics.body.toLowerCase();
    assert.ok(!body.includes("commission") && !body.includes("affiliate_fee") && !body.includes("distributor_fee"));
  }
});

console.log(`SUMMARY passed=${passed} failed=${failed} real_money=0`);
await pool.end();
await new Promise((r) => setTimeout(r, 300));
process.exit(failed ? 1 : 0);
