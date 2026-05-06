/**
 * Validates that the delivery data handoff feature contains NO logistics management:
 * - No shipped/delivered/tracking_number/delivery_issue endpoints or responses
 * - No refund/capture/void/payout in the handoff path
 * - No delivery status update endpoints
 * - Handoff is purely data display, not shipment tracking
 */
import assert from "node:assert/strict";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

async function closeImportedApp() {
  const deadline = Date.now() + 5_000;
  while (!(app as any).server?.listening && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

// ── Test: no logistics management endpoints exist ─────────────────────────────
// Checks both the previously-existing delivery_records update endpoint AND
// other patterns that were never built. All must return 404.
try {
await run("no shipped/delivered/tracking update endpoints exist", async () => {
  const logisticsRoutes = [
    // The old delivery_records management endpoint (removed in P1 fix)
    { method: "POST", url: "/api/seller/deals/fake-deal/delivery/fake-participant" },
    // Other never-built patterns
    { method: "POST", url: "/api/seller/deals/fake-deal/participants/fake-participant/shipped" },
    { method: "POST", url: "/api/seller/deals/fake-deal/participants/fake-participant/delivered" },
    { method: "PUT", url: "/api/seller/deals/fake-deal/participants/fake-participant/tracking" },
    { method: "POST", url: "/api/seller/deals/fake-deal/delivery-status" },
    { method: "PUT", url: "/api/seller/deals/fake-deal/delivery-status" },
    { method: "POST", url: "/api/seller/deals/fake-deal/participants/fake-participant/delivery-issue" },
    { method: "PATCH", url: "/api/seller/deals/fake-deal/participants/fake-participant/delivery" }
  ];

  for (const route of logisticsRoutes) {
    const r = await app.inject({ method: route.method as any, url: route.url, payload: {} });
    // Must return 404 (route not found), not 400/401/403 which would imply route exists
    assert.equal(
      r.statusCode, 404,
      `logistics endpoint ${route.method} ${route.url} must not exist (expected 404, got ${r.statusCode})`
    );
  }
});

// ── Test: no financial action endpoints in handoff path ──────────────────────
await run("no refund/capture/void/payout endpoints in handoff path", async () => {
  const financialRoutes = [
    { method: "POST", url: "/api/seller/deals/fake-deal/delivery-refund" },
    { method: "POST", url: "/api/seller/deals/fake-deal/participants/fake-participant/refund" },
    { method: "POST", url: "/api/seller/deals/fake-deal/participants/fake-participant/capture" },
    { method: "POST", url: "/api/seller/deals/fake-deal/participants/fake-participant/void" },
    { method: "POST", url: "/api/seller/deals/fake-deal/payout" },
    { method: "POST", url: "/api/seller/deals/fake-deal/delivery-payout" }
  ];

  for (const route of financialRoutes) {
    const r = await app.inject({ method: route.method as any, url: route.url, payload: {} });
    assert.equal(
      r.statusCode, 404,
      `financial endpoint ${route.method} ${route.url} must not exist (expected 404, got ${r.statusCode})`
    );
  }
});

const NOLOG_SELLER_ID = "seller-nolog-test";

async function ensureNoLogSellerProfile() {
  await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "x-seller-id": NOLOG_SELLER_ID },
    payload: { seller_id: NOLOG_SELLER_ID, business_name: "No Logistics Test Seller", support_phone: "050-000-0004" }
  });
}

async function createAndPublishNoLogDeal(suffix: string) {
  const cr = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { "x-request-id": `nolog-${suffix}`, "idempotency-key": `nolog-${suffix}` },
    payload: {
      seller_id: NOLOG_SELLER_ID,
      title: `No Logistics Test ${suffix}`,
      price_per_unit: 50,
      min_units: 1,
      max_units: 5,
      deadline: new Date(Date.now() + 3 * 3600_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Self Pickup", cost: 0, sort_order: 0 }]
    }
  });
  assert.ok(cr.statusCode === 200 || cr.statusCode === 201, `expected 200/201, got ${cr.statusCode}: ${cr.body}`);
  const deal = cr.json() as any;
  const pr = await app.inject({
    method: "POST",
    url: `/deals/${deal.deal_id}/publish`,
    payload: { seller_id: NOLOG_SELLER_ID, seller_terms_accepted: true }
  });
  assert.ok(pr.statusCode === 200 || pr.statusCode === 202, `publish failed ${pr.statusCode}: ${pr.body}`);
  return deal.deal_id as string;
}

await ensureNoLogSellerProfile();

// ── Test: handoff endpoint response has no logistics fields ───────────────────
await run("handoff JSON response contains no logistics management fields", async () => {
  const ts = Date.now();
  const dealId = await createAndPublishNoLogDeal(`chk-${ts}`);

  const r = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/delivery-handoff`,
    headers: { "x-seller-id": NOLOG_SELLER_ID }
  });

  const bodyStr = r.body;
  const forbidden = [
    "tracking_number", "shipped_at", "delivered_at", "delivery_status",
    "delivery_issue", "shipping_carrier", "shipment_id",
    "refund_amount", "capture_id", "void_id", "payout_id"
  ];
  for (const f of forbidden) {
    assert.ok(!bodyStr.includes(f), `handoff response must not contain '${f}', found in: ${bodyStr.slice(0, 300)}`);
  }
});

// ── Test: Excel export response has no logistics fields ───────────────────────
await run("Excel export has no logistics management fields", async () => {
  const ts = Date.now();
  const dealId = await createAndPublishNoLogDeal(`xl-${ts}`);

  const r = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/delivery-handoff/export.xlsx`,
    headers: { "x-seller-id": NOLOG_SELLER_ID }
  });

  const bodyStr = r.body;
  const forbidden = [
    "tracking_number", "shipped_at", "delivered_at", "delivery_status",
    "delivery_issue", "shipping_carrier", "shipment_id",
    "refund_amount", "capture_id", "void_id", "payout_id"
  ];
  for (const f of forbidden) {
    assert.ok(!bodyStr.includes(f), `export must not contain logistics field '${f}'`);
  }
});

// ── Test: Siton does not send delivery notifications on behalf of seller ───────
await run("no delivery SMS/email notification endpoints exist", async () => {
  const notifyRoutes = [
    { method: "POST", url: "/api/seller/deals/fake-deal/notify-delivery" },
    { method: "POST", url: "/api/seller/deals/fake-deal/participants/fake-participant/notify-delivery" },
    { method: "POST", url: "/api/seller/deals/fake-deal/send-delivery-confirmation" }
  ];

  for (const route of notifyRoutes) {
    const r = await app.inject({ method: route.method as any, url: route.url, payload: {} });
    assert.equal(
      r.statusCode, 404,
      `notification endpoint ${route.method} ${route.url} must not exist (expected 404, got ${r.statusCode})`
    );
  }
});

console.log("\nAll seller_delivery_no_logistics_management_validation checks completed.");
} finally {
  await closeImportedApp();
}
