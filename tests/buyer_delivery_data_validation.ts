/**
 * Validates buyer delivery data collection at join time.
 * Asserts shipping requires address, pickup does not, delivery_notes has max 200,
 * and data is persisted without state change.
 */
import assert from "node:assert/strict";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

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

const SELLER_ID = "seller-del-test";

async function ensureSellerProfile() {
  await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "x-seller-id": SELLER_ID },
    payload: { seller_id: SELLER_ID, business_name: "Delivery Test Seller", support_phone: "050-000-0001" }
  });
}

async function createDeal(suffix: string) {
  const r = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { "x-request-id": `del-test-${suffix}`, "idempotency-key": `del-test-${suffix}` },
    payload: {
      seller_id: SELLER_ID,
      title: `Delivery Test ${suffix}`,
      price_per_unit: 50,
      min_units: 10,
      max_units: 50,
      deadline: new Date(Date.now() + 3 * 3600_000).toISOString(),
      delivery_options: [
        { option_type: "pickup", label: "Self Pickup — Herzl 12, Tel Aviv", cost: 0, sort_order: 0 },
        { option_type: "delivery", label: "Courier", cost: 10, sort_order: 1 }
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

async function otpVerify(phone: string) {
  const s = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone } });
  assert.equal(s.statusCode, 200);
  const sj = s.json() as any;
  const v = await app.inject({ method: "POST", url: "/api/otp/verify", payload: { otp_session_id: sj.otp_session_id, code: sj.development_code } });
  assert.equal(v.statusCode, 200);
  const vj = v.json() as any;
  return { buyer_id: vj.buyer_id, otp_token: vj.otp_token, otp_challenge_id: vj.challenge_id || vj.otp_session_id };
}

async function getDeliveryOption(dealId: string, type: string) {
  const r = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  const body = r.json() as any;
  return body.deal.delivery_options.find((o: any) => o.option_type === type);
}

await ensureSellerProfile();
const dealId = await createDeal(`${Date.now()}`);
const pickupOption = await getDeliveryOption(dealId, "pickup");
const courierOption = await getDeliveryOption(dealId, "delivery");

await run("shipping requires delivery_address", async () => {
  const otp = await otpVerify(`0501${String(Date.now()).slice(-7)}`);
  const r = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: otp.buyer_id,
      qty: 1,
      delivery_option_id: courierOption.option_id,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.otp_challenge_id
      // no delivery_address
    }
  });
  assert.equal(r.statusCode, 400);
  const body = r.json() as any;
  assert.ok(body.code === "delivery_address_required" || String(body.message || "").includes("delivery_address"), `expected delivery_address_required, got: ${JSON.stringify(body)}`);
});

await run("pickup does not require delivery_address", async () => {
  const otp = await otpVerify(`0502${String(Date.now()).slice(-7)}`);
  const r = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: { "idempotency-key": `pickup-test-${Date.now()}` },
    payload: {
      buyer_id: otp.buyer_id,
      qty: 1,
      delivery_option_id: pickupOption.option_id,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.otp_challenge_id
      // no delivery_address ג€” should be fine for pickup
    }
  });
  assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
});

await run("shipping with full address saves data", async () => {
  const otp = await otpVerify(`0503${String(Date.now()).slice(-7)}`);
  const r = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: { "idempotency-key": `shipping-full-${Date.now()}` },
    payload: {
      buyer_id: otp.buyer_id,
      qty: 1,
      delivery_option_id: courierOption.option_id,
      buyer_name: "ישראל ישראלי",
      delivery_address: "רחוב הרצל 5",
      delivery_city: "תל אביב",
      delivery_notes: "קומה 3 דלת שמאל",
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.otp_challenge_id
    }
  });
  assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
  const body = r.json() as any;
  assert.ok(body.participant_id, "should return participant_id");
  assert.equal(body.delivery_method_label, "Courier");
});

await run("delivery_notes over 200 chars is rejected", async () => {
  const otp = await otpVerify(`0504${String(Date.now()).slice(-7)}`);
  const longNote = "א".repeat(201);
  const r = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: { "idempotency-key": `note-too-long-${Date.now()}` },
    payload: {
      buyer_id: otp.buyer_id,
      qty: 1,
      delivery_option_id: courierOption.option_id,
      delivery_address: "רחוב הרצל 5",
      delivery_city: "תל אביב",
      delivery_notes: longNote,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.otp_challenge_id
    }
  });
  assert.equal(r.statusCode, 400);
  const body = r.json() as any;
  assert.ok(body.code === "delivery_notes_too_long" || String(body.message || "").includes("200"), `expected delivery_notes_too_long, got: ${JSON.stringify(body)}`);
});

await run("join does not change deal state", async () => {
  const r = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  const body = r.json() as any;
  assert.ok(["PendingTarget", "TargetReached"].includes(body.deal.state), `deal state should not be Completed after join, got: ${body.deal.state}`);
});

console.log("\nAll buyer_delivery_data_validation checks completed.");
await app.close().catch(() => undefined);

