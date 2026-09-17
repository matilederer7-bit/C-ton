// LONG_HORIZON_DEALS — staging-parity smoke for the merged master build.
//
// Proves, through the REAL HTTP surface (no direct SQL shortcuts), that the
// 30/60/90-day seller journey works end to end and that the former 7-day cap
// is gone from both the backend validator and the shipped frontend bundle,
// while an ordinary short deal still behaves exactly as before.
//
// Money safety: this suite creates Drafts and publishes them. It never joins a
// participant, never dispatches a charge, never touches Grow and never sends a
// real notification — the deals it publishes have no participants, so no money
// or messaging rail is ever entered.
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "../src/app.js";
import { DEADLINE_MIN_MS, DEADLINE_TECHNICAL_MAX_MS } from "../src/deadline_policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let passed = 0;
let failed = 0;

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    failed += 1;
  }
}

async function createDraft(title: string, deadlineIso: string) {
  return app.inject({
    method: "POST",
    url: "/deals",
    payload: {
      title,
      description: "בדיקת סמוק לטווח ארוך",
      price_per_unit: 25,
      min_units: 4,
      max_units: 40,
      deadline: deadlineIso,
      delivery_options: [
        { option_type: "pickup", label: "איסוף עצמי — הרצל 12, תל אביב", cost: 0, sort_order: 0 }
      ]
    }
  });
}

async function publishDeal(dealId: string, tag: string) {
  return app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: { "x-request-id": `lh-smoke-${tag}`, "idempotency-key": `lh-smoke-${tag}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
}

/** Deadlines are stored at second precision; compare at that resolution. */
function atSecond(value: unknown) {
  const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) throw new Error(`unparseable deadline value: ${JSON.stringify(value)}`);
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** Buyer-facing public read — the real API surface for a published deal. */
async function readPublicDeal(dealId: string) {
  const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(res.statusCode, 200, `public re-read failed: ${res.body}`);
  const body = res.json() as any;
  // the public projection nests the deal under `deal`
  return (body && body.deal) ? body.deal : body;
}

/** Persistence read for a Draft (no public surface exists before publish). */
async function readStoredDeal(dealId: string) {
  const { withTx } = await import("../src/app.js");
  return withTx(async (c: any) => {
    const r = await c.query(`SELECT deal_id, state::text AS state, deadline FROM siton.deals WHERE deal_id=$1`, [dealId]);
    assert.equal(r.rowCount, 1, "the deal was persisted");
    return r.rows[0];
  });
}

async function main() {
  // ---- 30 / 60 / 90-day horizons through the real seller journey -----------
  for (const days of [30, 60, 90]) {
    await run(`SMOKE ${days}d: Draft create -> publish -> deadline persisted -> API re-read exact`, async () => {
      const deadline = new Date(Date.now() + days * DAY_MS).toISOString();
      const tag = `${days}d-${Date.now()}`;

      // 1) Draft creation is accepted for a long horizon
      const created = await createDraft(`סמוק ${days} יום`, deadline);
      assert.ok([200, 201].includes(created.statusCode), `create failed: ${created.body}`);
      const dealId = String((created.json() as any).deal_id);
      assert.ok(dealId, "deal_id returned");

      // 2) The Draft persists with exactly the requested deadline
      const draft = await readStoredDeal(dealId);
      assert.equal(String(draft.state), "Draft", "a new deal starts as Draft");
      assert.equal(
        atSecond(draft.deadline),
        atSecond(deadline),
        "the stored Draft deadline is exactly the requested instant"
      );

      // 3) Publish
      const published = await publishDeal(dealId, tag);
      assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);

      // 4) Read back through the real public API: horizon survived, state advanced
      const after = await readPublicDeal(dealId);
      assert.equal(
        atSecond(after.deadline),
        atSecond(deadline),
        "the deadline is unchanged after publish and re-read"
      );
      assert.notEqual(String(after.state), "Draft", "the deal left Draft on publish");
      const horizonMs = new Date(String(after.deadline)).getTime() - Date.now();
      assert.ok(horizonMs > 7 * DAY_MS, `a ${days}-day horizon survives (got ${Math.round(horizonMs / DAY_MS)}d)`);
      console.log(`SMOKE_EVIDENCE days=${days} deal_id=${dealId} state=${after.state} deadline=${new Date(String(after.deadline)).toISOString()}`);
    });
  }

  // ---- the public discovery surface shows the long-horizon deals -----------
  await run("SMOKE listing: the Mall lists the long-horizon deals and carries no 7-day copy", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mall/deals" });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!/עד 7 ימים קדימה/.test(res.body), "no 7-day restriction copy in the listing payload");
    const rows = res.json() as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows.deals || rows.items || []);
    const longOnes = list.filter((d: any) => d?.deadline && new Date(String(d.deadline)).getTime() - Date.now() > 7 * DAY_MS);
    assert.ok(longOnes.length >= 3, `the 30/60/90-day deals are discoverable (found ${longOnes.length} of ${list.length})`);
    console.log(`SMOKE_LISTING total=${list.length} long_horizon=${longOnes.length}`);
  });

  // ---- the ordinary short deal is untouched --------------------------------
  await run("SMOKE regression: an ordinary short (24h) deal still creates and publishes", async () => {
    const deadline = new Date(Date.now() + DAY_MS).toISOString();
    const created = await createDraft("סמוק עסקה קצרה", deadline);
    assert.ok([200, 201].includes(created.statusCode), `short create failed: ${created.body}`);
    const dealId = String((created.json() as any).deal_id);
    const published = await publishDeal(dealId, `short-${Date.now()}`);
    assert.equal(published.statusCode, 200, `short publish failed: ${published.body}`);
    const after = await readPublicDeal(dealId);
    assert.equal(
      atSecond(after.deadline),
      atSecond(deadline),
      "the short deal's deadline is exact too"
    );
  });

  // ---- the boundaries that must still reject -------------------------------
  await run("SMOKE boundary: under 2 hours is still rejected", async () => {
    const res = await createDraft("סמוק שעה", new Date(Date.now() + 60 * 60_000).toISOString());
    assert.equal(res.statusCode, 400, `a 1-hour deadline must be rejected: ${res.body}`);
    assert.equal(String((res.json() as any).code || ""), "deadline_below_minimum");
  });

  await run("SMOKE boundary: beyond the technical ceiling is still rejected", async () => {
    const res = await createDraft("סמוק 21 שנה", new Date(Date.now() + 21 * 365 * DAY_MS).toISOString());
    assert.equal(res.statusCode, 400, `21 years must be rejected: ${res.body}`);
    assert.equal(String((res.json() as any).code || ""), "deadline_above_maximum");
  });

  // ---- no 7-day block anywhere in the backend policy ----------------------
  await run("SMOKE backend: the deadline policy carries no 7-day bound", async () => {
    assert.equal(DEADLINE_MIN_MS, 2 * 60 * 60 * 1000, "2-hour minimum retained");
    assert.ok(DEADLINE_TECHNICAL_MAX_MS > 7 * DAY_MS * 100, "the ceiling is a sanity ceiling, not a 7-day cap");
  });

  // ---- no 7-day block in the SHIPPED frontend bundle -----------------------
  await run("SMOKE frontend: the built bundle contains no 7-day deadline restriction", async () => {
    const roots = [join(process.cwd(), ".demo_dist"), join(process.cwd(), "frontend")];
    const banned = [/עד 7 ימים קדימה/, /בין שעתיים ל-7 ימים/, /דדליין עד 7 ימים/, /עד 7 ימים קדימה\./];
    let scanned = 0;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|css|html)$/.test(entry.name)) continue;
        const body = readFileSync(full, "utf8");
        scanned += 1;
        for (const pattern of banned) {
          assert.ok(!pattern.test(body), `7-day restriction copy found in ${full}`);
        }
      }
    };
    for (const root of roots) walk(root);
    assert.ok(scanned > 0, "at least one built asset was scanned");
    console.log(`SMOKE_FRONTEND_ASSETS_SCANNED=${scanned}`);
  });

  // ---- money / Grow / messaging stayed at zero throughout ------------------
  await run("SMOKE safety: the smoke executed no money, no reauthorization and no Grow activity", async () => {
    const { withTx } = await import("../src/app.js");
    const counts = await withTx(async (c: any) => {
      const r = await c.query(`
        SELECT
          (SELECT count(*)::int FROM siton.payment_attempts) AS attempts,
          (SELECT count(*)::int FROM siton.payment_attempts WHERE attempt_type='reauthorize') AS reauth,
          (SELECT count(*)::int FROM siton.payment_authorization_bindings) AS bindings,
          (SELECT count(*)::int FROM siton.platform_fee_money_events) AS fee_events
      `);
      return r.rows[0];
    });
    assert.equal(Number(counts.attempts), 0, "no payment attempt was created by the smoke");
    assert.equal(Number(counts.reauth), 0, "no reauthorization was created by the smoke");
    assert.equal(Number(counts.bindings), 0, "no authorization binding was created by the smoke");
    assert.equal(Number(counts.fee_events), 0, "no platform fee money event was created by the smoke");
    console.log("SMOKE_SAFETY real_money=0 reauthorize=0 bindings=0 fee_events=0");
  });

  console.log(`SUMMARY passed=${passed} failed=${failed}`);
  if (failed) process.exit(1);
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
