// RED TEAM — MONEY INPUT BOUNDARIES (Phase 2 §2.2, §2.7)
//
// Every money field the seller can send is validated in JavaScript as a float
// and then stored in PostgreSQL as numeric(12,2). Nothing used to check that
// the value the validator approved is a value the column can actually hold, so
// the guard and the storage disagreed and the product took the storage's side:
//
//   price_per_unit: 0            -> 400 "must be a positive number"   (refused)
//   price_per_unit: 0.001        -> 200, stored 0.00, PUBLISHED, live (accepted)
//
// The same deal the API refuses to create is reachable through a different
// input. Three more variants of the same root cause are asserted here:
// a NaN delivery cost that publishes and silently zeroes the platform fee, a
// "regular price" that collapses onto the group price after rounding (so the
// advertised saving is 0), and an out-of-range amount that surfaced the raw
// PostgreSQL overflow as a 500 instead of a 400.
//
// These assertions FAIL on the code as it stood before src/money_input.ts.
import assert from "node:assert/strict";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { app } = await import("../src/app.js");
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error: any) { failed += 1; console.error(`FAIL ${name}: ${error?.message || error}`); }
}

function unique(tag: string) {
  return `${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function createDeal(overrides: Record<string, unknown>) {
  const u = unique("money");
  return app.inject({
    method: "POST",
    url: "/deals",
    headers: { "x-request-id": u, "idempotency-key": u },
    payload: {
      title: `Money boundary ${u}`,
      price_per_unit: 50,
      min_units: 2,
      max_units: 10,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Pickup — Herzl 12, Tel Aviv", cost: 0 }],
      ...overrides
    }
  });
}

try {
  // ── §2.2 A sub-agora price must not become a free deal ────────────────────
  await run("a price that rounds to 0.00 is refused, exactly as a literal 0 is", async () => {
    const zero = await createDeal({ price_per_unit: 0 });
    assert.equal(zero.statusCode, 400, "a literal 0 price must be refused");

    for (const price of [0.001, 0.004, 0.0049]) {
      const res = await createDeal({ price_per_unit: price });
      assert.equal(res.statusCode, 400,
        `price_per_unit=${price} rounds to 0.00 in numeric(12,2) and must be refused, got ${res.statusCode} ${res.body.slice(0, 120)}`);
      assert.match(res.body, /price/i);
    }
    // ...and the smallest representable price is still accepted: this is a
    // boundary, not a ban on cheap deals.
    const ok = await createDeal({ price_per_unit: 0.01 });
    assert.equal(ok.statusCode, 200, `0.01 must remain a legal price, got ${ok.body.slice(0, 160)}`);
    const row = await pool.query("SELECT price_per_unit FROM siton.deals WHERE deal_id=$1", [ok.json().deal_id]);
    assert.equal(Number(row.rows[0].price_per_unit), 0.01, "and it must be stored as 0.01");
  });

  // ── §2.2/§2.7 A non-numeric delivery cost must never reach the money rail ──
  await run("a non-numeric delivery cost is refused instead of being stored as NaN", async () => {
    for (const cost of ["abc", "", {}, [], "1,5", NaN]) {
      const res = await createDeal({
        delivery_options: [{ option_type: "delivery", label: "Courier to door, Tel Aviv area", cost, delivery_estimate_days: 3 }]
      });
      if (res.statusCode === 200) {
        const stored = await pool.query(
          "SELECT cost FROM siton.deal_delivery_options WHERE deal_id=$1", [res.json().deal_id]);
        for (const r of stored.rows) {
          assert.ok(Number.isFinite(Number(r.cost)),
            `delivery cost ${JSON.stringify(cost)} was stored as ${r.cost} — a non-finite amount poisons every downstream total`);
        }
      }
    }
  });

  await run("a negative delivery cost is refused, not silently clamped to zero", async () => {
    const res = await createDeal({
      delivery_options: [{ option_type: "delivery", label: "Courier to door, Tel Aviv area", cost: -1, delivery_estimate_days: 3 }]
    });
    assert.equal(res.statusCode, 400,
      `a negative delivery cost must be refused rather than rewritten to 0.00, got ${res.statusCode}`);
  });

  // The create path used to be weaker than the patch path, which already got
  // this right. They must agree.
  await run("the create path is no weaker than the patch path on delivery cost", async () => {
    const base = await createDeal({});
    assert.equal(base.statusCode, 200);
    const dealId = base.json().deal_id;
    const bad = { option_type: "delivery", label: "Courier to door, Tel Aviv area", cost: "abc", delivery_estimate_days: 3 };
    const patched = await app.inject({
      method: "PATCH", url: `/api/seller/deals/${dealId}/draft`,
      headers: { "x-request-id": unique("patch") },
      payload: { delivery_options: [bad] }
    });
    const created = await createDeal({ delivery_options: [bad] });
    assert.ok(patched.statusCode >= 400, `patch must refuse it (got ${patched.statusCode})`);
    assert.ok(created.statusCode >= 400,
      `create must refuse it too (patch says ${patched.statusCode}, create says ${created.statusCode})`);
  });

  // ── §2.2 The advertised saving must not round away to nothing ─────────────
  await run("a regular price that rounds onto the group price is refused", async () => {
    for (const listPrice of [50.001, 50.004]) {
      const res = await createDeal({ price_per_unit: 50, list_price_per_unit: listPrice });
      if (res.statusCode === 200) {
        const row = await pool.query(
          "SELECT price_per_unit, list_price_per_unit FROM siton.deals WHERE deal_id=$1", [res.json().deal_id]);
        assert.ok(Number(row.rows[0].list_price_per_unit) > Number(row.rows[0].price_per_unit),
          `list_price ${listPrice} was stored as ${row.rows[0].list_price_per_unit} against a group price of ` +
          `${row.rows[0].price_per_unit} — the advertised saving is zero or negative`);
      }
    }
  });

  // ── §2.16 An out-of-range amount is a client error, not a 500 ─────────────
  await run("an amount beyond numeric(12,2) is a 400, never a leaked database overflow", async () => {
    for (const payload of [
      { price_per_unit: 1e15 },
      { price_per_unit: 1e308 },
      { delivery_options: [{ option_type: "delivery", label: "Courier to door, Tel Aviv area", cost: 1e15, delivery_estimate_days: 3 }] },
      { price_per_unit: 50, list_price_per_unit: 1e15 }
    ]) {
      const res = await createDeal(payload);
      assert.ok(res.statusCode < 500,
        `${JSON.stringify(payload).slice(0, 80)} returned ${res.statusCode} — an oversized amount must be rejected before it reaches PostgreSQL`);
      assert.equal(res.statusCode, 400, `and it must be a validation error, got ${res.statusCode}`);
    }
  });

  // ── §2.2 Unit counts are integer columns, and the 90% target derives from
  // whatever ends up stored. A fractional min_units used to reach PostgreSQL
  // and come back as a 500, while the draft-patch path already answered 400.
  await run("a fractional or oversized unit count is a 400, never a leaked 22P02", async () => {
    for (const minUnits of [10.4, 20.6, 3.7, 1e12, "10.4"]) {
      const res = await createDeal({ min_units: minUnits, max_units: 2000 });
      assert.ok(res.statusCode < 500,
        `min_units=${minUnits} returned ${res.statusCode} — an integer column must be guarded before the insert`);
      assert.equal(res.statusCode, 400, `and it must be a validation error, got ${res.statusCode}`);
    }
    const okRes = await createDeal({ min_units: 20, max_units: 2000 });
    assert.equal(okRes.statusCode, 200, "a whole unit count must still be accepted");
  });

  await run("the stored 90% target always matches the stored min_units", async () => {
    for (const minUnits of [10, 20, 21, 100, 1]) {
      const res = await createDeal({ min_units: minUnits, max_units: 2000 });
      assert.equal(res.statusCode, 200, res.body.slice(0, 160));
      const row = await pool.query(
        "SELECT min_units, threshold_units FROM siton.deals WHERE deal_id=$1", [res.json().deal_id]);
      const storedMin = Number(row.rows[0].min_units);
      assert.equal(Number(row.rows[0].threshold_units), Math.ceil(0.9 * storedMin),
        `threshold ${row.rows[0].threshold_units} is not 90% of the stored min_units ${storedMin}`);
    }
  });

  // ── §2.7 The fee engine must fail closed, never quietly bill nothing ──────
  await run("the platform fee engine refuses a non-finite amount instead of returning zero", async () => {
    const { calculatePlatformFeeMoney } = await import("../src/platform_fee_money.js");
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => calculatePlatformFeeMoney({ grossAmount: bad, vatAmount: 0 }),
        `gross=${bad} must throw: silently returning a zero fee bills the buyer nothing and pays Siton nothing`);
      assert.throws(() => calculatePlatformFeeMoney({ grossAmount: 100, vatAmount: bad }),
        `vat=${bad} must throw for the same reason`);
    }
    // A legitimate amount is untouched: 8% of a VAT-exclusive base.
    const snapshot = calculatePlatformFeeMoney({ grossAmount: 100, vatAmount: 0 });
    assert.equal(snapshot.platform_fee_base_amount, 8);
    assert.equal(snapshot.gross_amount, 100);
  });
} finally {
  await pool.end().catch(() => undefined);
  await app.close().catch(() => undefined);
}

if (failed) {
  console.error(`FAILED ${failed} money input boundary checks`);
  process.exit(1);
}
console.log("All money input boundary checks passed.");
