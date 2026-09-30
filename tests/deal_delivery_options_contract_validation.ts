// Delivery methods are chosen by TYPE — the server contract (owner bug 2026-09-28).
//
// The create-deal wizard counted a delivery method only when its free-text
// label was filled, and the server matched it: POST /deals silently DROPPED a
// label-less option while PATCH/PUT REJECTED it with 400. A seller who chose
// "משלוח" + "איסוף עצמי" without typing descriptions lost both. The three
// server paths now agree: an option with a known type is kept, and an empty
// label becomes the generic name of its type (never counted as an address).
import assert from "node:assert/strict";
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 2 });
const { app } = await import("../src/app.js");
const { deliveryOptionLabel, hasUsablePickupLocation } = await import("../src/pickup_location.js");

async function run(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`PASS ${name}`);
}

let n = 0;
async function createDeal(delivery_options: unknown) {
  n += 1;
  const key = `delivery-contract-${Date.now()}-${n}`;
  const res = await app.inject({
    method: "POST", url: "/deals",
    headers: { "x-request-id": key, "idempotency-key": key },
    payload: {
      title: `Delivery contract ${n}`, description: "Delivery options chosen by type.",
      price_per_unit: 40, min_units: 2, max_units: 10,
      deadline: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      delivery_options
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  return String((res.json() as any).deal_id);
}
async function stored(dealId: string) {
  const r = await pool.query(`SELECT option_type, label, cost, latitude FROM siton.deal_delivery_options WHERE deal_id=$1 ORDER BY sort_order`, [dealId]);
  return r.rows.map((row) => ({ ...row, cost: Number(row.cost), latitude: row.latitude == null ? null : Number(row.latitude) }));
}

try {
  await run("the shared label rule: typed text wins, an empty label keeps the generic type name", () => {
    assert.equal(deliveryOptionLabel("delivery", ""), "משלוח");
    assert.equal(deliveryOptionLabel("pickup", "   "), "איסוף עצמי");
    assert.equal(deliveryOptionLabel("distribution_point", null), "נקודת חלוקה");
    assert.equal(deliveryOptionLabel("pickup", "הרצל 12"), "הרצל 12");
    assert.equal(deliveryOptionLabel("delivery", "", { delivery: "Delivery" }), "Delivery");
    // the generic name is NEVER an address: a label-less pickup still needs a location
    assert.equal(hasUsablePickupLocation({ option_type: "pickup", label: deliveryOptionLabel("pickup", "") }), false);
    assert.equal(hasUsablePickupLocation({ option_type: "pickup", label: deliveryOptionLabel("pickup", ""), latitude: 32.06, longitude: 34.76 }), true);
  });

  await run("POST /deals keeps TWO methods chosen by type without labels (was: both silently dropped)", async () => {
    const dealId = await createDeal([
      { option_type: "delivery", label: "", cost: 25, sort_order: 0 },
      { option_type: "pickup", label: "", cost: 0, sort_order: 1, latitude: 32.0668, longitude: 34.7647 }
    ]);
    const rows = await stored(dealId);
    assert.deepEqual(rows.map((r) => [r.option_type, r.label]), [["delivery", "משלוח"], ["pickup", "איסוף עצמי"]]);
    assert.equal(rows[0]!.cost, 25);
    assert.equal(rows[1]!.latitude, 32.0668);
  });

  await run("POST /deals keeps one and three methods; typed labels are preserved", async () => {
    assert.equal((await stored(await createDeal([{ option_type: "delivery", cost: 0 }]))).length, 1);
    const three = await stored(await createDeal([
      { option_type: "delivery", label: "שליח עד הבית", cost: 30 },
      { option_type: "pickup", label: "הרצל 12, תל אביב" },
      { option_type: "distribution_point", label: "", latitude: 31.7683, longitude: 35.2137 }
    ]));
    assert.deepEqual(three.map((r) => r.label), ["שליח עד הבית", "הרצל 12, תל אביב", "נקודת חלוקה"]);
  });

  await run("an entry with neither a known type nor text is still not a method", async () => {
    const rows = await stored(await createDeal([{}, { option_type: "teleport" }, { option_type: "delivery", cost: 10 }]));
    assert.deepEqual(rows.map((r) => r.option_type), ["delivery"], JSON.stringify(rows));
  });

  await run("PUT /api/seller/deals/:id/delivery accepts label-less methods (was: 400) and stores both", async () => {
    const dealId = await createDeal([{ option_type: "delivery", label: "ישן", cost: 5 }]);
    const res = await app.inject({
      method: "PUT", url: `/api/seller/deals/${dealId}/delivery`,
      payload: { delivery_options: [
        { option_type: "delivery", label: "", cost: 20, sort_order: 0 },
        { option_type: "distribution_point", label: "", cost: 0, sort_order: 1, latitude: 32.1, longitude: 34.8 }
      ] }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual((await stored(dealId)).map((r) => [r.option_type, r.label]), [["delivery", "משלוח"], ["distribution_point", "נקודת חלוקה"]]);
  });

  await run("PATCH /api/seller/deals/:id/draft accepts label-less methods (was: 400)", async () => {
    const dealId = await createDeal([{ option_type: "delivery", label: "ישן", cost: 5 }]);
    const res = await app.inject({
      method: "PATCH", url: `/api/seller/deals/${dealId}/draft`,
      payload: { delivery_options: [{ option_type: "delivery", label: "", cost: 15 }, { option_type: "pickup", label: "בן יהודה 5" }] }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual((await stored(dealId)).map((r) => r.label), ["משלוח", "בן יהודה 5"]);
  });

  await run("a delivery method still validates its cost", async () => {
    const res = await app.inject({
      method: "PUT", url: `/api/seller/deals/${await createDeal([{ option_type: "delivery", cost: 5 }])}/delivery`,
      payload: { delivery_options: [{ option_type: "delivery", label: "", cost: -3 }] }
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  await run("a label-less self-pickup without a location still cannot be published", async () => {
    const dealId = await createDeal([{ option_type: "pickup", label: "" }]);
    const res = await app.inject({
      method: "POST", url: `/deals/${dealId}/publish`,
      headers: { "x-request-id": `publish-${dealId}` },
      payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as any).code, "pickup_location_required");
  });

  console.log("DEAL_DELIVERY_OPTIONS_CONTRACT_PASS");
} finally {
  await app.close();
  await pool.end();
}
