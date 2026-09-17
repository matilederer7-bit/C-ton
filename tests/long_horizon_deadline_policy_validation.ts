// LONG_HORIZON_DEALS — deal duration must not depend on authorization lifetime.
//
// Proves at the domain/API boundary that a 30-, 60-, 90-day (and longer) deal
// is accepted exactly like a short one, that the only remaining bounds are the
// 2-hour product minimum and the technical sanity ceiling, that the server
// policy and the seller picker's mirror carry the SAME numbers, and that no
// payment-derived bound exists anywhere in the policy.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3142";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const {
  classifyDeadline, describeDeadlinePolicy,
  DEADLINE_MIN_MS, DEADLINE_TECHNICAL_MAX_MS, DEADLINE_TECHNICAL_MAX_YEARS, LONG_HORIZON_WARNING_MS
} = await import("../src/deadline_policy.js");
const { app } = await import("../src/app.js");
await app.ready();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
const DAY = 24 * 60 * 60_000;
async function createDeal(deadlineMs: number, title: string) {
  return app.inject({
    method: "POST", url: "/deals",
    headers: { "x-seller-id": "seller-long-horizon" },
    payload: { title, price_per_unit: 10, min_units: 5, max_units: 10, deadline: new Date(deadlineMs).toISOString() }
  });
}

try {
  await run("policy: 30 / 60 / 90 / 180 / 365 / 730-day deadlines classify as accepted; only > 1 year carries the advisory long-horizon flag", async () => {
    const now = Date.now();
    for (const days of [30, 60, 90, 180, 365]) {
      const c = classifyDeadline(now + days * DAY, now);
      assert.equal(c.ok, true, `${days} days`);
      assert.equal(c.ok && c.long_horizon, false, `${days} days is not flagged`);
    }
    const twoYears = classifyDeadline(now + 730 * DAY, now);
    assert.equal(twoYears.ok, true);
    assert.equal(twoYears.ok && twoYears.long_horizon, true, "> 1 year: advisory only, still accepted");
    assert.equal(classifyDeadline(now + LONG_HORIZON_WARNING_MS, now).ok && (classifyDeadline(now + LONG_HORIZON_WARNING_MS, now) as any).long_horizon, false, "exactly 365 days is not flagged (strictly greater)");
  });

  await run("policy: the only bounds are the 2-hour product minimum and the technical sanity ceiling; no payment-derived bound", async () => {
    const now = Date.now();
    assert.equal(classifyDeadline(now + DEADLINE_MIN_MS - 1, now).ok, false);
    assert.equal((classifyDeadline(now + DEADLINE_MIN_MS - 1, now) as any).code, "deadline_below_minimum");
    assert.equal(classifyDeadline(now + DEADLINE_MIN_MS, now).ok, true);
    assert.equal(classifyDeadline(now + DEADLINE_TECHNICAL_MAX_MS, now).ok, true);
    assert.equal((classifyDeadline(now + DEADLINE_TECHNICAL_MAX_MS + 1, now) as any).code, "deadline_above_maximum");
    assert.equal((classifyDeadline(Number.NaN, now) as any).code, "deadline_invalid");
    assert.equal(DEADLINE_TECHNICAL_MAX_YEARS, 20);
    assert.ok(DEADLINE_TECHNICAL_MAX_MS > 7 * DAY * 1000, "the ceiling is a sanity bound, orders of magnitude above the former 7-day cap");
    const described = describeDeadlinePolicy();
    assert.equal(described.payment_authorization_bounded, false);
    assert.ok(!("max_ms" in described), "no business maximum exists in the policy");
    // no environment flag can raise the ceiling: it is a module constant
    assert.equal(typeof DEADLINE_TECHNICAL_MAX_MS, "number");
  });

  await run("policy: the seller picker mirror (web/src/deadlinePolicy.ts) carries the same numbers as the server policy", async () => {
    const source = await readFile("web/src/deadlinePolicy.ts", "utf8");
    const num = (name: string) => {
      const m = source.match(new RegExp(`export const ${name} = ([^;]+);`));
      assert.ok(m, `${name} declared in the web mirror`);
      return Function(`"use strict"; const DEADLINE_TECHNICAL_MAX_YEARS = 20; return (${m![1]});`)();
    };
    assert.equal(num("DEADLINE_MIN_MS"), DEADLINE_MIN_MS);
    assert.equal(num("DEADLINE_TECHNICAL_MAX_YEARS"), DEADLINE_TECHNICAL_MAX_YEARS);
    assert.equal(num("DEADLINE_TECHNICAL_MAX_MS"), DEADLINE_TECHNICAL_MAX_MS);
    assert.equal(num("LONG_HORIZON_WARNING_MS"), LONG_HORIZON_WARNING_MS);
    assert.ok(!/7 \* 24 \* 3600_000|7 \* 864e5/.test(source), "no 7-day literal survives in the web mirror");
    const seller = await readFile("web/src/pages/seller.tsx", "utf8");
    assert.ok(!/7 \* 24 \* 3600_000|7 \* 864e5|ל-7 ימים/.test(seller), "no 7-day deadline cap survives in the seller page");
    const legacy = await readFile("frontend/app.js", "utf8");
    assert.ok(!/> 7 \* 24 \* 60 \* 60 \* 1000/.test(legacy), "no 7-day deadline cap survives in the legacy frontend");
    const he = await readFile("web/src/he.ts", "utf8");
    assert.ok(!/עד 7 ימים קדימה/.test(he), "no 7-day copy survives in the Hebrew error map");
  });

  await run("API: 30-, 60- and 90-day deals are created; 21 years is rejected by the technical ceiling; 1 hour by the product minimum", async () => {
    const now = Date.now();
    for (const days of [30, 60, 90]) {
      const res = await createDeal(now + days * DAY, `Long-horizon ${days}d`);
      assert.ok([200, 201].includes(res.statusCode), `${days}d: ${res.body}`);
      const body = res.json() as any;
      assert.ok(body.deal_id, `${days}d created`);
      const stored = await pool.query(`SELECT deadline FROM siton.deals WHERE deal_id=$1`, [body.deal_id]);
      assert.ok(Math.abs(new Date(stored.rows[0].deadline).getTime() - (now + days * DAY)) < 5_000, `${days}d deadline stored exactly`);
    }
    const tooFar = await createDeal(now + 21 * 365 * DAY, "Beyond the ceiling");
    assert.equal(tooFar.statusCode, 400);
    assert.equal((tooFar.json() as any).code, "deadline_above_maximum");
    const tooSoon = await createDeal(now + 60 * 60_000, "Too soon");
    assert.equal(tooSoon.statusCode, 400);
    assert.equal((tooSoon.json() as any).code, "deadline_below_minimum");
  });

  await run("API: a Draft may be edited to a 90-day deadline (edit path shares the policy)", async () => {
    const now = Date.now();
    const created = await createDeal(now + 3 * DAY, "Edit to long horizon");
    const dealId = (created.json() as any).deal_id as string;
    const edited = await app.inject({
      method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: { "x-seller-id": "seller-long-horizon" },
      payload: { deadline: new Date(now + 90 * DAY).toISOString() }
    });
    assert.ok([200, 201].includes(edited.statusCode), edited.body);
    const tooFar = await app.inject({
      method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: { "x-seller-id": "seller-long-horizon" },
      payload: { deadline: new Date(now + 21 * 365 * DAY).toISOString() }
    });
    assert.equal(tooFar.statusCode, 400);
    assert.equal((tooFar.json() as any).code, "deadline_above_maximum");
    const stored = await pool.query(`SELECT deadline FROM siton.deals WHERE deal_id=$1`, [dealId]);
    assert.ok(Math.abs(new Date(stored.rows[0].deadline).getTime() - (now + 90 * DAY)) < 5_000);
  });

  console.log(`SUMMARY passed=${passed} failed=0`);
} finally {
  await app.close().catch(() => undefined);
  await pool.end();
}
