// SPRINT 4 (A6) — admin buyer search is intent-sensitive and literal, DB-exercised.
//  * a Hebrew-letter query returns ONLY buyers whose DISPLAYED name contains it
//    (the owner's "ש" reproduction: a buyer with two participation names must
//    surface the matching name, never the other one)
//  * digits search the phone (and the phone-shaped buyer id), e-mail needs "@",
//    letters never match a hidden e-mail / id
//  * whitespace / case / niqqud / final-letter tolerant
//  * every hit says why it matched; the response names the intent
//  * admin-only
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3651";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `search-test-admin-${randomUUID().slice(0, 8)}`;
delete process.env.BUYER_VERIFY_JOIN;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });
const { app } = await import("../src/app.js");

const SELLER_ID = `search-seller-${randomUUID().slice(0, 8)}`;
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };
const tag = randomUUID().slice(0, 6);
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.stack || e}`); failed++; }
}

await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
   VALUES ($1,$1,'Search Ltd','search@siton.local','approved','active') ON CONFLICT (seller_id) DO NOTHING`,
  [SELLER_ID]
);

async function createDeal(): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/deals",
    headers: { "x-seller-id": SELLER_ID, "idempotency-key": `search-create-${randomUUID()}` },
    payload: {
      seller_id: SELLER_ID, title: `עסקת חיפוש ${tag}`, description: "buyer search proof",
      price_per_unit: 40, min_units: 2, max_units: 100,
      deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0 }]
    }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const publish = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { "x-seller-id": SELLER_ID },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(publish.statusCode, 200, publish.body);
  return dealId;
}

async function join(dealId: string, buyerId: string, buyerName: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: { "idempotency-key": `search-join-${randomUUID()}` },
    payload: { buyer_id: buyerId, buyer_name: buyerName, qty: 1, buyer_terms_accepted: true, payment_disclosure_accepted: true, ...extra }
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}

async function search(q: string) {
  const res = await app.inject({ method: "GET", url: `/api/admin/r6/buyers?q=${encodeURIComponent(q)}`, headers: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}
// every fixture id carries the run tag digits so parallel/previous rows never collide
const digits = String(Date.now()).slice(-6);
const SARA = `0501${digits}`, DAVID = `0522${digits}`, MOSHE = `0533${digits}`, DOUBLE = `0544${digits}`, MICHAEL = `0555${digits}`;
const mine = (rows: any[]) => rows.filter((r) => [SARA, DAVID, MOSHE, DOUBLE, MICHAEL].includes(String(r.buyer_id)));

const dealA = await createDeal();
const dealB = await createDeal();
let saraParticipant = "";
await run("fixtures: five buyers with Hebrew / Latin names, e-mails, and one buyer who joined twice under two different names", async () => {
  saraParticipant = (await join(dealA, SARA, "שרה לוי", { buyer_email: "sara@example.com" })).participant_id;
  await join(dealA, DAVID, "דוד כהן", { buyer_email: "shani@example.com" });
  await join(dealA, MOSHE, "Moshe Levi", { buyer_email: "moshe@example.com" });
  await join(dealA, DOUBLE, "שרה אברהם");
  await join(dealB, DOUBLE, "תמר אברהם");
  await join(dealB, MICHAEL, "מִיכָאֵל כץ");
  const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.participants WHERE buyer_id = ANY($1::text[])`, [[SARA, DAVID, MOSHE, DOUBLE, MICHAEL]]);
  assert.equal(rows.rows[0].n, 6);
});

await run("the owner's reproduction: query 'ש' returns ONLY buyers whose displayed name contains ש — the double-name buyer surfaces as 'שרה אברהם', never 'תמר אברהם'", async () => {
  const body = await search("ש");
  assert.equal(body.search.intent, "name");
  assert.equal(body.search.label_he, "חיפוש לפי שם");
  for (const row of body.buyers) {
    assert.ok(String(row.buyer_name || "").includes("ש"), `displayed name without ש: ${JSON.stringify(row.buyer_name)} (${row.buyer_id})`);
    assert.equal(row.match?.field, "name");
    assert.equal(row.match?.label_he, "התאמה בשם");
  }
  const rows = mine(body.buyers);
  const ids = rows.map((r) => String(r.buyer_id)).sort();
  assert.deepEqual(ids, [SARA, DOUBLE].sort(), `expected only Sara + the double-name buyer, got ${JSON.stringify(rows.map((r) => [r.buyer_id, r.buyer_name]))}`);
  const dbl = rows.find((r) => String(r.buyer_id) === DOUBLE)!;
  assert.equal(dbl.buyer_name, "שרה אברהם", "the participation name that MATCHED is the one displayed");
  assert.equal(dbl.participations, 2);
  // the old query's failure mode: MAX(buyer_name) would have shown 'תמר אברהם' for this buyer
  const mx = await pool.query(`SELECT MAX(buyer_name) AS m FROM siton.participants WHERE buyer_id=$1`, [DOUBLE]);
  assert.equal(mx.rows[0].m, "תמר אברהם", "fixture really reproduces the aggregate mismatch");
});

await run("letters never match a hidden e-mail or id: 'shani' (an e-mail local part) finds no buyer; 'דוד' finds David by name", async () => {
  const none = await search("shani");
  assert.equal(none.search.intent, "name");
  assert.equal(mine(none.buyers).length, 0, JSON.stringify(mine(none.buyers).map((r) => r.buyer_name)));
  const david = await search("דוד");
  assert.deepEqual(mine(david.buyers).map((r) => r.buyer_id), [DAVID]);
});

await run("digits search the phone: '0522' finds David only; formatted '052-2' too; a lone digit is a phone prefix (not a name); no name-only hit leaks", async () => {
  const a = await search(`0522${digits.slice(0, 3)}`);
  assert.equal(a.search.intent, "phone");
  assert.deepEqual(mine(a.buyers).map((r) => r.buyer_id), [DAVID]);
  assert.equal(a.buyers[0].match.label_he, "התאמה בטלפון");
  const b = await search(`052-2${digits.slice(0, 3)}`);
  assert.deepEqual(mine(b.buyers).map((r) => r.buyer_id), [DAVID]);
  const c = await search("0");
  assert.equal(c.search.intent, "phone");
  for (const row of c.buyers) assert.match(String(row.buyer_phone || row.buyer_id), /0/);
});

await run("e-mail needs '@': 'sara@' finds Sara by e-mail (and says so); 'moshe@example' finds Moshe", async () => {
  const a = await search("sara@");
  assert.equal(a.search.intent, "email");
  assert.deepEqual(mine(a.buyers).map((r) => r.buyer_id), [SARA]);
  assert.equal(a.buyers.find((r: any) => r.buyer_id === SARA).match.label_he, "התאמה במייל");
  const b = await search("MOSHE@Example");
  assert.deepEqual(mine(b.buyers).map((r) => r.buyer_id), [MOSHE]);
});

await run("tolerant name matching: extra whitespace, Latin case, niqqud and final letters", async () => {
  assert.deepEqual(mine((await search("  שרה   לוי ")).buyers).map((r) => r.buyer_id), [SARA]);
  assert.deepEqual(mine((await search("MOSHE levi")).buyers).map((r) => r.buyer_id), [MOSHE]);
  assert.deepEqual(mine((await search("מיכאל")).buyers).map((r) => r.buyer_id), [MICHAEL], "niqqud in the stored name is ignored");
  assert.deepEqual(mine((await search("כצ")).buyers).map((r) => r.buyer_id), [MICHAEL], "final ץ folds to צ");
  assert.deepEqual(mine((await search("כץ")).buyers).map((r) => r.buyer_id), [MICHAEL]);
});

await run("technical ids only when the input really is one: Sara's participant UUID finds Sara; a CT order code answers cleanly with no rows; LIKE metacharacters are literal", async () => {
  const byId = await search(saraParticipant);
  assert.equal(byId.search.intent, "id");
  assert.deepEqual(mine(byId.buyers).map((r) => r.buyer_id), [SARA]);
  assert.equal(byId.buyers[0].match.label_he, "התאמה במזהה");
  const code = await search("CT-1234-5678");
  assert.equal(code.search.intent, "order_code");
  assert.equal(code.buyers.length, 0);
  const pct = await search("%");
  assert.equal(pct.search.intent, "name");
  assert.equal(mine(pct.buyers).length, 0, "'%' is a literal character, not a wildcard");
  const under = await search("_");
  assert.equal(mine(under.buyers).length, 0);
});

await run("an empty query lists everyone (no match reason); the roster is admin-only", async () => {
  const all = await search("");
  assert.equal(all.search.intent, "empty");
  assert.equal(mine(all.buyers).length, 5);
  for (const row of all.buyers) assert.equal(row.match, null);
  const anon = await app.inject({ method: "GET", url: "/api/admin/r6/buyers?q=ש" });
  assert.ok([401, 403].includes(anon.statusCode), `anonymous got ${anon.statusCode}`);
});

await app.close().catch(() => undefined);
await pool.end();
console.log(`\nADMIN_BUYER_SEARCH_INTENT passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
