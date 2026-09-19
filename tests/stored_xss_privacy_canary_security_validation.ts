import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ensureSellerReady, createDeal, publishDeal, joinDeal, sellerHeaders
} from "./helpers/physical_fulfillment_fixture.js";

// RED TEAM §7 (second-order / stored XSS) and §8 (privacy canaries).
//
// §7 — the repository had NO test anywhere asserting that anything is HTML
// escaped: `&lt;`, `&amp;` and `&quot;` appear in zero test files. Mutation
// testing confirmed the gap is real in the direction that matters for the
// server-rendered surfaces: only one suite noticed `escapeHtml` being gutted.
// The seller-controlled deal title and description are rendered by the
// crawler-facing share page /d/:dealId, which is exactly the "write it in one
// place, open it somewhere else" shape a stored-XSS attack needs.
//
// §8 — buyer PII (phone, e-mail, address, delivery notes) is written by the
// join flow and must never appear on an anonymous surface. Seeded here as
// unique canaries so a leak is unambiguous rather than a guess.

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.PORT = "3623";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const get = async (url: string, headers: any = {}) => {
  const r = await app.inject({ method: "GET", url, headers });
  return { status: r.statusCode, body: r.body, json: () => r.json() as any };
};

// ── canaries ────────────────────────────────────────────────────────────────
const XSS_SCRIPT = "<script>XSS_CANARY_SEVEN</script>";
const XSS_ATTR = '"><img src=x onerror=XSS_CANARY_ATTR>';
const PHONE_CANARY = "0509987654";
const EMAIL_CANARY = "canary-buyer-7@example.invalid";
const ADDRESS_CANARY = "ADDRESS_CANARY_7 רחוב הבדיקה 42";
const CITY_CANARY = "CITY_CANARY_7";
const NOTES_CANARY = "PRIVATE_NOTE_CANARY_7 להשאיר אצל השכן";
const BUYER_NAME = "ישראל";

const seller = `xss-canary-${randomUUID()}`;

await app.ready();
await ensureSellerReady(app, seller, "חנות בדיקת הזרקה");

const deal = await createDeal(app, seller, {
  title: `דיל ${XSS_SCRIPT}`,
  minUnits: 1,
  maxUnits: 10,
  extra: { description_short: `תיאור ${XSS_ATTR}` }
});
await publishDeal(app, seller, deal);
const buyer = await joinDeal(app, deal, {
  phone: PHONE_CANARY,
  name: BUYER_NAME,
  qty: 1,
  optionType: "delivery",
  email: EMAIL_CANARY,
  address: ADDRESS_CANARY,
  city: CITY_CANARY,
  notes: NOTES_CANARY
});

// ── §7 stored XSS on the server-rendered share page ─────────────────────────

await run("VACUITY GUARD: the payload really reached storage and the share page really renders the title", async () => {
  const stored = await pool.query(`SELECT title, description_short FROM siton.deals WHERE deal_id=$1`, [deal]);
  assert.equal(stored.rowCount, 1, "deal missing");
  assert.ok(
    String(stored.rows[0].title).includes(XSS_SCRIPT),
    `the payload was rewritten before storage, so this suite would prove nothing: ${stored.rows[0].title}`
  );
  const share = await get(`/d/${deal}`);
  assert.equal(share.status, 200, share.body);
  assert.ok(share.body.includes("XSS_CANARY_SEVEN"), "the share page does not render the title at all");
});

await run("§7 the stored script payload is ESCAPED, never injected, on the share page", async () => {
  const share = await get(`/d/${deal}`);
  assert.ok(
    !share.body.includes(XSS_SCRIPT),
    "the raw <script> payload was written into the share page HTML"
  );
  assert.ok(
    share.body.includes("&lt;script&gt;XSS_CANARY_SEVEN&lt;/script&gt;"),
    "the payload is present but not in its escaped form — escaping is not being applied"
  );
  // An executable <script> block whose body carries the canary must not exist.
  assert.ok(
    !/<script[^>]*>[^<]*XSS_CANARY_SEVEN/.test(share.body),
    "the canary ended up inside an executable <script> block"
  );
});

await run("§7 the attribute-breaking payload cannot escape its meta attribute", async () => {
  const share = await get(`/d/${deal}`);
  // Breaking out needs a RAW quote+bracket sequence; escaped text cannot.
  assert.ok(!share.body.includes('"><img'), "the payload broke out of its HTML attribute");
  // The handler must never sit on a real element. Note the deliberately narrow
  // shape: `onerror=` also appears as INERT TEXT inside the escaped attribute
  // value (`&quot;&gt;&lt;img src=x onerror=…&gt;`), which is correct output —
  // asserting on the bare substring would fail on properly escaped content.
  assert.ok(!/<img[^>]*onerror/i.test(share.body), "an onerror handler reached a real <img> element");
  assert.ok(
    share.body.includes("&lt;img src=x onerror=XSS_CANARY_ATTR&gt;"),
    "the attribute payload is present but not in its escaped form — escaping is not being applied"
  );
});

await run("§7 the payload is not injected into the legal shell or the CMS pages", async () => {
  for (const url of ["/legal/terms", "/legal/privacy"]) {
    const page = await get(url);
    if (page.status !== 200) continue;
    assert.ok(!page.body.includes(XSS_SCRIPT), `${url} carries the raw script payload`);
    assert.ok(!/onerror\s*=/.test(page.body), `${url} carries an onerror handler`);
  }
});

// ── §8 privacy canaries on anonymous surfaces ───────────────────────────────

const PII = [
  ["phone", PHONE_CANARY],
  ["email", EMAIL_CANARY],
  ["address", ADDRESS_CANARY],
  ["city", CITY_CANARY],
  ["delivery note", NOTES_CANARY]
] as const;

await run("VACUITY GUARD: the buyer PII really was stored", async () => {
  const stored = await pool.query(
    `SELECT buyer_phone, buyer_email, delivery_address, delivery_city, delivery_notes
       FROM siton.participants WHERE participant_id=$1`,
    [buyer.participant_id]
  );
  assert.equal(stored.rowCount, 1, "participant missing");
  const row = stored.rows[0];
  assert.equal(String(row.buyer_phone), PHONE_CANARY, "phone canary not stored");
  assert.equal(String(row.delivery_notes || ""), NOTES_CANARY, "note canary not stored");
});

for (const path of ["public", "activity"]) {
  await run(`§8 no buyer PII on the anonymous /api/deals/:id/${path} surface`, async () => {
    const r = await get(`/api/deals/${deal}/${path}`);
    assert.ok(r.status < 500, `${path} answered ${r.status}`);
    for (const [label, canary] of PII) {
      assert.ok(!r.body.includes(canary), `${path} leaked the buyer ${label}`);
    }
  });
}

await run("§8 no buyer PII on the anonymous public-names surface", async () => {
  const r = await get(`/api/deals/${deal}/public-names`);
  assert.ok(r.status < 500, `public-names answered ${r.status}`);
  for (const [label, canary] of PII) {
    assert.ok(!r.body.includes(canary), `public-names leaked the buyer ${label}`);
  }
});

await run("§8 no buyer PII on the crawler-facing share page", async () => {
  const share = await get(`/d/${deal}`);
  for (const [label, canary] of PII) {
    assert.ok(!share.body.includes(canary), `the share page leaked the buyer ${label}`);
  }
});

await run("§8 no buyer PII on the anonymous mall listing", async () => {
  const r = await get(`/api/mall/deals`);
  if (r.status === 200) {
    for (const [label, canary] of PII) {
      assert.ok(!r.body.includes(canary), `the mall listing leaked the buyer ${label}`);
    }
  }
});

await pool.end();
await app.close();
console.log(`SUMMARY stored_xss_privacy_canary passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
