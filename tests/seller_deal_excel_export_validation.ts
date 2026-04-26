import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ExcelJS from "exceljs";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3422");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function insertCompletedDeal(sellerId: string, title = "עסקה בדיקה Excel") {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,'Completed',2,2,20,100.00,
             now()+interval '7 days', now(), now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId, sellerId, title]
  );
  return dealId;
}

async function insertParticipant(opts: {
  dealId: string;
  buyerState: string;
  moneyState: string;
  buyerId?: string;
  buyerName?: string;
  buyerPhone?: string;
  buyerEmail?: string;
  deliveryAddress?: string;
  deliveryCity?: string;
  deliveryNotes?: string;
  qty?: number;
  deliveryCost?: number;
}) {
  const pid = randomUUID();
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state,
        buyer_name, buyer_phone, buyer_email,
        delivery_address, delivery_city, delivery_notes, delivery_cost,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())
     ON CONFLICT (participant_id) DO NOTHING`,
    [
      pid, opts.dealId,
      opts.buyerId ?? "+972500000001",
      opts.qty ?? 2,
      opts.buyerState, opts.moneyState,
      opts.buyerName ?? null,
      opts.buyerPhone ?? null,
      opts.buyerEmail ?? null,
      opts.deliveryAddress ?? null,
      opts.deliveryCity ?? null,
      opts.deliveryNotes ?? null,
      opts.deliveryCost ?? 0
    ]
  );
  return pid;
}

async function getWorkbook(body: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as any);
  return wb;
}

function sheetToRows(ws: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  ws.eachRow((row) => {
    rows.push((row.values as any[]).slice(1).map((v: any) => String(v ?? "")));
  });
  return rows;
}

// ── Test 1: 200, xlsx content-type, valid workbook ────────────────────────────
await run("T1 seller can export completed deal xlsx — 200, content-type, valid workbook", async () => {
  const sellerId = `seller-xl-${randomUUID().slice(0, 8)}`;
  const dealId = await insertCompletedDeal(sellerId);
  await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "ChargedSuccess", qty: 2 });

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": sellerId }
  });

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.ok(
    String(res.headers["content-type"]).includes("spreadsheetml"),
    `expected xlsx content-type, got: ${res.headers["content-type"]}`
  );
  assert.ok(
    String(res.headers["content-disposition"]).includes(`siton-deal-export-${dealId}.xlsx`),
    "content-disposition should name the file with deal id"
  );

  // Must be a valid xlsx, not JSON or text
  const wb = await getWorkbook(res.rawPayload);
  assert.ok(wb.worksheets.length >= 4, `expected at least 4 sheets, got ${wb.worksheets.length}`);

  const sheetNames = wb.worksheets.map((ws) => ws.name);
  assert.ok(sheetNames.includes("Deal Summary"), "missing Deal Summary sheet");
  assert.ok(sheetNames.includes("Eligible Buyers"), "missing Eligible Buyers sheet");
  assert.ok(sheetNames.includes("All Participants"), "missing All Participants sheet");
  assert.ok(sheetNames.includes("Money Breakdown"), "missing Money Breakdown sheet");
  assert.ok(sheetNames.includes("Notes"), "missing Notes sheet");
});

// ── Test 2: unauthorized seller gets 403 ──────────────────────────────────────
await run("T2 unauthorized seller gets 403", async () => {
  const ownerSellerId = `seller-owner-${randomUUID().slice(0, 8)}`;
  const otherSellerId = `seller-other-${randomUUID().slice(0, 8)}`;
  const dealId = await insertCompletedDeal(ownerSellerId);

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": otherSellerId }
  });

  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
});

// ── Test 3: non-completed deal gets 409 deal_not_completed ────────────────────
await run("T3 non-completed deal gets 409 deal_not_completed", async () => {
  const sellerId = `seller-nc-${randomUUID().slice(0, 8)}`;
  const dealId = randomUUID();
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
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": sellerId }
  });

  assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode}: ${res.body}`);
  const body = res.json();
  assert.equal(body.code, "deal_not_completed", `expected deal_not_completed, got: ${JSON.stringify(body)}`);
});

// ── Test 4: only eligible buyers in Eligible Buyers sheet ────────────────────
await run("T4 only eligible buyers appear in Eligible Buyers sheet", async () => {
  const sellerId = `seller-elig-${randomUUID().slice(0, 8)}`;
  const dealId = await insertCompletedDeal(sellerId);

  const p1 = await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "ChargedSuccess", buyerId: "+972501111111" });
  const p2 = await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "RecoveredCharge", buyerId: "+972502222222" });
  const p3 = await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "ChargedSuccess", buyerId: "+972503333333" });
  const p4 = await insertParticipant({ dealId, buyerState: "DealFailed", moneyState: "AuthReleased", buyerId: "+972504444444" });
  const p5 = await insertParticipant({ dealId, buyerState: "Dropped", moneyState: "AuthReleased", buyerId: "+972505555555" });

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": sellerId }
  });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}`);

  const wb = await getWorkbook(res.rawPayload);
  const ws = wb.getWorksheet("Eligible Buyers")!;
  const rows = sheetToRows(ws);
  // row[0] = header, rest = data
  const dataRows = rows.slice(1);
  const participantIds = dataRows.map((r) => r[1] ?? ""); // participant_id is col 2 (index 1)

  assert.ok(participantIds.includes(p1), "p1 (ChargedSuccess) must be in Eligible Buyers");
  assert.ok(participantIds.includes(p2), "p2 (RecoveredCharge) must be in Eligible Buyers");
  assert.ok(participantIds.includes(p3), "p3 (ChargedSuccess) must be in Eligible Buyers");
  assert.ok(!participantIds.includes(p4), "p4 (DealFailed) must NOT be in Eligible Buyers");
  assert.ok(!participantIds.includes(p5), "p5 (Dropped) must NOT be in Eligible Buyers");
});

// ── Test 5: All Participants includes all ─────────────────────────────────────
await run("T5 All Participants sheet includes both eligible and ineligible", async () => {
  const sellerId = `seller-all-${randomUUID().slice(0, 8)}`;
  const dealId = await insertCompletedDeal(sellerId);

  const eligible = await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "ChargedSuccess", buyerId: "+972506000001" });
  const ineligible = await insertParticipant({ dealId, buyerState: "Dropped", moneyState: "AuthReleased", buyerId: "+972506000002" });

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": sellerId }
  });
  const wb = await getWorkbook(res.rawPayload);
  const ws = wb.getWorksheet("All Participants")!;
  const rows = sheetToRows(ws);
  const participantIds = rows.slice(1).map((r) => r[1] ?? "");

  assert.ok(participantIds.includes(eligible), "eligible participant must appear in All Participants");
  assert.ok(participantIds.includes(ineligible), "ineligible participant must appear in All Participants");
});

// ── Test 6: money totals are consistent ───────────────────────────────────────
await run("T6 Money Breakdown totals match Deal Summary figures", async () => {
  const sellerId = `seller-money-${randomUUID().slice(0, 8)}`;
  const dealId = await insertCompletedDeal(sellerId, "עסקה כסף בדיקה");

  // Insert 2 eligible participants with known quantities and delivery costs
  await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "ChargedSuccess", buyerId: "+972507000001", qty: 3, deliveryCost: 20 });
  await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "ChargedSuccess", buyerId: "+972507000002", qty: 1, deliveryCost: 15 });

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": sellerId }
  });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}`);

  const wb = await getWorkbook(res.rawPayload);

  // Read Deal Summary key-value rows
  const ws1 = wb.getWorksheet("Deal Summary")!;
  const summaryMap = new Map<string, number>();
  ws1.eachRow((row) => {
    const key = String((row.values as any[])[1] ?? "").trim();
    const val = Number((row.values as any[])[2] ?? 0);
    if (key) summaryMap.set(key, val);
  });

  // Read Money Breakdown TOTAL row (last row, first cell = "TOTAL")
  const ws4 = wb.getWorksheet("Money Breakdown")!;
  const mb: number[] = [];
  ws4.eachRow((row) => {
    const first = String((row.values as any[])[1] ?? "");
    if (first === "TOTAL") {
      // cols: participant_id, buyer_name, qty, products_amount, delivery_cost,
      //       gross_amount(6), fee_base(7), fee_vat(8), fee_total(9), seller_net(10)
      const vals = (row.values as any[]).slice(1);
      mb.push(...vals.map(Number));
    }
  });

  assert.ok(mb.length > 0, "TOTAL row not found in Money Breakdown");

  const summaryGross = summaryMap.get("gross_collected_total") ?? -1;
  const summaryFeeTotal = summaryMap.get("platform_fee_total_amount") ?? -1;
  const summarySellerNet = summaryMap.get("seller_net_amount") ?? -1;

  // TOTAL row indices (0-based after slice): 0=label, 1=buyer_name, 2=qty, 3=products, 4=delivery,
  // 5=gross, 6=fee_base, 7=fee_vat, 8=fee_total, 9=seller_net
  const mbGross = mb[5] ?? -999;
  const mbFeeTotal = mb[8] ?? -999;
  const mbSellerNet = mb[9] ?? -999;

  assert.ok(Math.abs(summaryGross - mbGross) < 0.01, `gross mismatch: summary=${summaryGross}, breakdown=${mbGross}`);
  assert.ok(Math.abs(summaryFeeTotal - mbFeeTotal) < 0.01, `fee_total mismatch: summary=${summaryFeeTotal}, breakdown=${mbFeeTotal}`);
  assert.ok(Math.abs(summarySellerNet - mbSellerNet) < 0.01, `seller_net mismatch: summary=${summarySellerNet}, breakdown=${mbSellerNet}`);
});

// ── Test 7: delivery snapshot fields appear in Eligible Buyers ────────────────
await run("T7 delivery snapshot fields appear in Eligible Buyers sheet", async () => {
  const sellerId = `seller-snap-xl-${randomUUID().slice(0, 8)}`;
  const dealId = await insertCompletedDeal(sellerId, "עסקה סנאפשוט");

  await insertParticipant({
    dealId,
    buyerState: "DealCompleted",
    moneyState: "ChargedSuccess",
    buyerId: "+972508000001",
    buyerName: "דנה לוי",
    buyerPhone: "+972508000001",
    buyerEmail: "dana@example.com",
    deliveryAddress: "רחוב דיזנגוף 50",
    deliveryCity: "תל אביב",
    deliveryNotes: "קומה 2"
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": sellerId }
  });
  const wb = await getWorkbook(res.rawPayload);
  const ws = wb.getWorksheet("Eligible Buyers")!;
  const rows = sheetToRows(ws);

  const header = rows[0] ?? [];
  assert.ok(header.includes("buyer_name"), "missing buyer_name column");
  assert.ok(header.includes("buyer_phone"), "missing buyer_phone column");
  assert.ok(header.includes("buyer_email"), "missing buyer_email column");
  assert.ok(header.includes("delivery_address"), "missing delivery_address column");
  assert.ok(header.includes("delivery_city"), "missing delivery_city column");
  assert.ok(header.includes("delivery_notes"), "missing delivery_notes column");

  const allText = rows.slice(1).flat().join("|");
  assert.ok(allText.includes("דנה לוי"), "buyer_name value missing");
  assert.ok(allText.includes("+972508000001"), "buyer_phone value missing");
  assert.ok(allText.includes("dana@example.com"), "buyer_email value missing");
  assert.ok(allText.includes("רחוב דיזנגוף 50"), "delivery_address value missing");
  assert.ok(allText.includes("תל אביב"), "delivery_city value missing");
});

// ── Test 8: no affiliate commission columns ───────────────────────────────────
await run("T8 no affiliate commission or payout columns in workbook", async () => {
  const sellerId = `seller-nocom-${randomUUID().slice(0, 8)}`;
  const dealId = await insertCompletedDeal(sellerId);
  await insertParticipant({ dealId, buyerState: "DealCompleted", moneyState: "ChargedSuccess" });

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/export.xlsx`,
    headers: { "x-seller-id": sellerId }
  });
  const wb = await getWorkbook(res.rawPayload);

  const forbidden = ["commission", "affiliate_payout", "balance", "withdrawal"];
  for (const ws of wb.worksheets) {
    const rows = sheetToRows(ws);
    const allText = rows.flat().join("|").toLowerCase();
    for (const term of forbidden) {
      assert.ok(!allText.includes(term), `forbidden term "${term}" found in sheet "${ws.name}"`);
    }
  }
});

await pool.end();
await app.close();
console.log("All seller deal Excel export tests passed.");
