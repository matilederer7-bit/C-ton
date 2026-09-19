// RED TEAM — BUYER PUBLIC-NAME CONSENT (Phase 2 §2.6)
//
// `siton.participants.public_name_opt_in` is an explicit consent flag: the
// buyer decides whether their name may be shown publicly. Two unauthenticated
// endpoints publish buyer names for the same deal, and only one honoured it:
//
//   GET /api/deals/:id/public-names -> ["דנה"]            (gated, correct)
//   GET /api/deals/:id/activity     -> ["רותי","דנה"]     (ignored the flag)
//
// רותי had set public_name_opt_in = false and her first name was still
// broadcast on the public deal page. First-name-only is real minimisation, but
// a recorded consent choice is not a formatting preference.
//
// The join is NOT hidden by the fix — it still appears, anonymised — so the
// activity feed and its counts stay truthful. This test asserts both halves:
// the refused buyer is anonymised AND still counted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

async function publishedDealWithTwoBuyers() {
  const tag = randomUUID().slice(0, 6);
  const u = `consent-${tag}`;
  const created = await app.inject({
    method: "POST", url: "/deals",
    headers: { "x-request-id": u, "idempotency-key": u },
    payload: {
      title: `Consent ${tag}`, price_per_unit: 40, min_units: 2, max_units: 20,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Pickup — Herzl 12, Tel Aviv", cost: 0 }]
    }
  });
  assert.equal(created.statusCode, 200, created.body);
  const dealId = (created.json() as any).deal_id;
  const sellerId = (await pool.query("SELECT seller_id FROM siton.deals WHERE deal_id=$1", [dealId])).rows[0].seller_id;
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_phone, support_email)
     VALUES ($1,'Consent','Consent','0501234567','consent@example.invalid')
     ON CONFLICT (seller_id) DO UPDATE SET business_name=EXCLUDED.business_name,
       support_phone=EXCLUDED.support_phone, support_email=EXCLUDED.support_email`, [sellerId]);
  const published = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`,
    headers: { "x-request-id": `${u}p`, "idempotency-key": `${u}p` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(published.statusCode, 200, published.body);
  for (const [name, optIn] of [["דנה אופטין", true], ["רותי סירבה", false]] as const) {
    await pool.query(
      `INSERT INTO siton.participants (deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost,
         acquisition_source, buyer_name, buyer_phone, public_name_opt_in)
       VALUES ($1,$2,1,'JoinedAuthorized','AuthHeld',0,'direct',$3,'0551234567',$4)`,
      [dealId, `buyer-${tag}-${optIn ? "in" : "out"}`, name, optIn]);
  }
  return dealId;
}

try {
  await run("the public activity feed names only buyers who consented", async () => {
    const dealId = await publishedDealWithTwoBuyers();
    const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/activity` });
    assert.equal(res.statusCode, 200, res.body);
    const displays = ((res.json() as any).recent_joins || []).map((j: any) => String(j.display));
    assert.ok(displays.includes("דנה"), `the consenting buyer should still be named, saw ${JSON.stringify(displays)}`);
    assert.ok(!displays.includes("רותי"),
      `a buyer with public_name_opt_in=false must not be named on a public endpoint, saw ${JSON.stringify(displays)}`);
  });

  await run("refusing to be named hides the name, never the join", async () => {
    const dealId = await publishedDealWithTwoBuyers();
    const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/activity` });
    const body = res.json() as any;
    assert.equal(body.recent_joins.length, 2, "both joins must still appear — consent hides a name, not an event");
    assert.equal(body.participants, 2, "and the participant count stays truthful");
    assert.equal(body.joined_units, 2, "and so do the units");
    const anonymous = body.recent_joins.filter((j: any) => String(j.display) === "משתתף");
    assert.equal(anonymous.length, 1, "the refusing buyer appears as the anonymous placeholder");
    assert.equal(Number(anonymous[0].qty), 1, "with their real quantity intact");
  });

  await run("the two public name surfaces agree with each other", async () => {
    const dealId = await publishedDealWithTwoBuyers();
    const activity = await app.inject({ method: "GET", url: `/api/deals/${dealId}/activity` });
    const names = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public-names` });
    assert.equal(names.statusCode, 200, names.body);
    const named = new Set<string>(((activity.json() as any).recent_joins || [])
      .map((j: any) => String(j.display)).filter((d: string) => d !== "משתתף"));
    for (const n of ((names.json() as any).names || []) as string[]) {
      assert.ok(named.has(n), `${n} is published by /public-names but not by /activity`);
    }
    for (const n of named) {
      assert.ok(((names.json() as any).names || []).includes(n),
        `${n} is named by /activity but not by /public-names — the two public surfaces disagree about consent`);
    }
  });
} finally {
  await pool.end().catch(() => undefined);
  await app.close().catch(() => undefined);
}

if (failed) { console.error(`FAILED ${failed} buyer public-name consent checks`); process.exit(1); }
console.log("All buyer public-name consent checks passed.");
