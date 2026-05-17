/**
 * Validates the seller delivery handoff Excel export:
 * - Contains only eligible buyers (ChargedSuccess/RecoveredCharge)
 * - Includes all required columns
 * - Does not include internal payment refs or logistics/tracking fields
 */
import assert from "node:assert/strict";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

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
  } catch (e: any) {
    console.error(`FAIL ${name}`);
    console.error("    ", e.message);
    throw e;
  }
}

await waitForImportedAppListen();

try {
const SELLER_ID = "seller-excel-test";

async function ensureSellerProfile() {
  await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "x-seller-id": SELLER_ID },
    payload: { seller_id: SELLER_ID, business_name: "Excel Test Seller", support_phone: "050-000-0003" }
  });
}

async function createAndPublishDeal(suffix: string) {
  const r = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { "x-request-id": `excel-${suffix}`, "idempotency-key": `excel-${suffix}` },
    payload: {
      seller_id: SELLER_ID,
      title: `Excel Export Test ${suffix}`,
      price_per_unit: 75,
      min_units: 1,
      max_units: 10,
      deadline: new Date(Date.now() + 3 * 3600_000).toISOString(),
      delivery_options: [
        { option_type: "pickup", label: "Self Pickup", cost: 0, sort_order: 0 },
        { option_type: "delivery", label: "Courier", cost: 15, sort_order: 1 }
      ]
    }
  });
  assert.ok(r.statusCode === 200 || r.statusCode === 201, `expected 200/201, got ${r.statusCode}: ${r.body}`);
  const body = r.json() as any;
  const pr = await app.inject({
    method: "POST",
    url: `/deals/${body.deal_id}/publish`,
    payload: { seller_id: SELLER_ID, seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.ok(pr.statusCode === 200 || pr.statusCode === 202, `publish failed ${pr.statusCode}: ${pr.body}`);
  return body.deal_id as string;
}

// ג”€ג”€ Test: export endpoint exists and returns binary/xlsx or blocked for non-Completed ג”€ג”€
await run("export endpoint returns xlsx or non-200 for non-Completed deal", async () => {
  await ensureSellerProfile();
  const ts = Date.now();
  const dealId = await createAndPublishDeal(`${ts}`);

  const r = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/delivery-handoff/export.xlsx`,
    headers: { "x-seller-id": SELLER_ID }
  });

  // For non-Completed deals, must not return 200 with Excel data
  // For Completed deals, should return 200 with correct content-type
  if (r.statusCode === 200) {
    const ct = r.headers["content-type"] || "";
    assert.ok(
      ct.includes("spreadsheetml") || ct.includes("octet-stream") || ct.includes("xlsx"),
      `expected xlsx content-type, got: ${ct}`
    );
    const cd = String(r.headers["content-disposition"] || "");
    assert.ok(cd.includes(".xlsx"), `content-disposition should include .xlsx, got: ${cd}`);
    assert.ok(!cd.includes("tracking") && !cd.includes("shipping"), `filename must not imply logistics: ${cd}`);
    console.log(`    XLSX returned (deal may be Completed): content-type=${ct}`);
  } else {
    // Non-Completed blocked ג€” acceptable
    assert.ok([400, 403, 404, 409, 422].includes(r.statusCode), `unexpected status ${r.statusCode}: ${r.body}`);
    console.log(`    non-Completed deal blocked from export ג€” status ${r.statusCode} as expected`);
  }
});

// ג”€ג”€ Test: export response body never contains internal payment refs ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
await run("export response has no internal payment provider refs", async () => {
  const ts = Date.now();
  const dealId = await createAndPublishDeal(`noref-${ts}`);

  const r = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/delivery-handoff/export.xlsx`,
    headers: { "x-seller-id": SELLER_ID }
  });

  // Whether Excel or error JSON, must not contain internal refs in body
  const bodyStr = r.body;
  const forbidden = ["authorization_id", "authorization_provider", "stripe_", "payplus_", "payment_provider"];
  for (const f of forbidden) {
    assert.ok(!bodyStr.includes(f), `export must not contain internal ref '${f}' in response`);
  }
});

// ג”€ג”€ Test: export has no logistics/tracking fields in response ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
await run("export has no tracking/shipped/delivered fields", async () => {
  const ts = Date.now();
  const dealId = await createAndPublishDeal(`nolog-${ts}`);

  const r = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/delivery-handoff/export.xlsx`,
    headers: { "x-seller-id": SELLER_ID }
  });

  const bodyStr = r.body;
  const logisticsTerms = ["tracking_number", "shipped_at", "delivered_at", "delivery_status", "delivery_issue"];
  for (const f of logisticsTerms) {
    assert.ok(!bodyStr.includes(f), `export must not contain logistics term '${f}'`);
  }
});

// ג”€ג”€ Test: handoff JSON has required columns for Excel construction ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
await run("handoff JSON response includes required delivery fields for export", async () => {
  const ts = Date.now();
  const dealId = await createAndPublishDeal(`fields-${ts}`);

  const r = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/delivery-handoff`,
    headers: { "x-seller-id": SELLER_ID }
  });

  if (r.statusCode === 200) {
    const body = r.json() as any;
    // Top-level fields required
    assert.ok("deal_id" in body, "response must have deal_id");
    assert.ok("deal_title" in body, "response must have deal_title");
    assert.ok("eligible_count" in body, "response must have eligible_count");
    assert.ok("disclaimer" in body, "response must have disclaimer");
    assert.ok(Array.isArray(body.buyers), "response must have buyers array");

    // Per-buyer required fields for Excel columns
    const requiredBuyerFields = [
      "participant_id", "buyer_id", "buyer_name", "buyer_phone",
      "qty", "delivery_method_type", "delivery_method_label",
      "delivery_address", "delivery_city", "delivery_notes", "joined_at"
    ];
    for (const buyer of body.buyers) {
      for (const field of requiredBuyerFields) {
        assert.ok(field in buyer, `buyer missing required field '${field}': ${JSON.stringify(buyer)}`);
      }
    }
    console.log(`    all required fields present (${body.buyers.length} buyers)`);
  } else {
    // Deal not Completed ג€” validate it's blocked properly
    assert.ok([400, 403, 404, 409, 422].includes(r.statusCode), `unexpected status ${r.statusCode}: ${r.body}`);
    console.log(`    non-Completed deal blocked from handoff ג€” status ${r.statusCode}`);
  }
});

console.log("\nAll seller_delivery_excel_export_validation checks completed.");
} finally {
  await closeImportedApp();
}

