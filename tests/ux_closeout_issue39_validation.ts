// ── UX CLOSEOUT (GitHub Issue #39) — five hosted-reality gaps, closed ───────
//
// Hosted verification on 2026-09-17 found five things wrong with the product as
// a person actually meets it. This file is the repeatable proof that each one
// is closed and stays closed:
//
//   1. terminal deals no longer consume the primary seller dashboard;
//   2. the active product UI carries no decorative emoji;
//   3. one entitlement may be redeemed through SEVERAL methods, redeemed once;
//   4. "תצוגה מקדימה" is an action, not a mandatory journey stage;
//   5. a deal-scoped support inquiry binds deal → seller SERVER-SIDE, reaches
//      that seller, and never leaks to an unrelated one.
//
// Items 1, 2 and 4 are assertions about the shipped React sources, because that
// IS where the defect lived (a card grid, an emoji, a journey array). Items 3
// and 5 are driven through the real HTTP API against a real database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RECEIPT_METHODS, receiptConfig, receiptMethodsLabel, validateReceiptConfig
} from "../src/receipt_trust.js";
import {
  DEAL_SCOPED_SUPPORT_CATEGORIES, extractDealReference, isDealScopedSupportCategory, supportCategoryRequiresDeal
} from "../src/support_deal_context.js";
import {
  ensureSellerReady, createDeal, publishDeal, joinDeal, forceDealState, forceParticipantTo, sellerHeaders
} from "./helpers/physical_fulfillment_fixture.js";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.PORT = "3611";
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`PASS ${name}`);
  passed += 1;
}
const request = async (method: any, url: string, headers: any = {}, payload?: any) => {
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body, json: () => r.json() as any };
};

const sellerPage = await readFile("web/src/pages/seller.tsx", "utf8");
const componentsSource = await readFile("web/src/components.tsx", "utf8");

try {
  await app.ready();

  // ── ITEM 1 — terminal deals leave the primary list ───────────────────────
  await run("item 1: Completed/Failed/Cancelled deals are partitioned out of the primary dashboard list", () => {
    // The dashboard buckets deals three ways and the PRIMARY grid renders the
    // active bucket. A regression that put terminal deals back into the main
    // list would have to delete this partition to pass.
    assert.match(sellerPage, /activeDeals: rest\.filter\(\(d\) => !CLOSED_STATES\.includes\(String\(d\.state\)\)\)/,
      "the primary bucket must exclude terminal states");
    assert.match(sellerPage, /archivedDeals: rest\.filter\(\(d\) => CLOSED_STATES\.includes\(String\(d\.state\)\)\)/,
      "terminal deals must land in their own bucket");
    assert.match(sellerPage, /\{activeDeals\.map\(\(d\) => <SellerDealCard/,
      "the primary card grid renders the ACTIVE bucket");
    assert.doesNotMatch(sellerPage, /\{otherDeals\.map\(/, "the old undifferentiated list must be gone");
  });

  await run("item 1: the archive is collapsed by default, counted, and reachable", () => {
    assert.match(sellerPage, /<details className="sd-archive" data-testid="seller-archive">/,
      "the archive must be a <details>, i.e. collapsed until the seller opens it");
    assert.doesNotMatch(sellerPage, /<details className="sd-archive"[^>]*\sopen[\s>]/,
      "the archive must not default to open");
    assert.match(sellerPage, /data-testid="seller-archive-count">\(\{archivedDeals\.length\}\)/,
      "the archive must show how many deals it holds");
    // history stays reachable: open the deal, its fulfilment list, or duplicate
    for (const testId of ["archive-open", "archive-fulfillment-open", "archive-duplicate"]) {
      assert.ok(sellerPage.includes(`data-testid="${testId}"`), `archive row must keep the ${testId} action`);
    }
    assert.match(sellerPage, /function SellerArchiveRow\(/, "the archive renders compact rows, not full cards");
  });

  // ── ITEM 2 — no decorative glyphs in the active product UI ────────────────
  await run("item 2: the shipped React/CSS surfaces carry zero decorative pictographs", () => {
    const pictograph = /\p{Extended_Pictographic}/gu;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(tsx?|css)$/.test(entry)) continue;
        readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          const found = line.match(pictograph);
          if (found) offenders.push(`${full}:${i + 1} ${found.join("")}`);
        });
      }
    };
    walk("web/src");
    assert.deepEqual(offenders, [], `decorative glyphs are back in the product UI:\n${offenders.join("\n")}`);
  });

  await run("item 2: meaning survives the glyphs — severity, empty states and types still read", () => {
    // The Action Center said "critical" with 🚨; it now says it with a colour-keyed
    // border that was ALREADY in the stylesheet, so nothing was lost.
    const css = readFileSync("web/src/styles.css", "utf8");
    assert.match(css, /\.action-item\.critical \{ border-inline-start: 4px solid/);
    assert.match(css, /\.action-item\.warning \{ border-inline-start: 4px solid/);
    // The empty state is typography, and it no longer accepts a glyph at all.
    assert.match(componentsSource, /export function EmptyState\(props: \{ title: string;/,
      "EmptyState must no longer take an icon prop");
    assert.doesNotMatch(componentsSource, /fontSize: "2\.6rem"/, "the 2.6rem emoji slot must be gone");
    assert.match(css, /\.empty-state-title \{/, "the empty state needs its restrained typographic treatment");
    // The image placeholder says the deal type in words instead of 📦/🎁/🎟️.
    assert.ok(!/export function dealTypeIcon/.test(readFileSync("web/src/util.ts", "utf8")), "dealTypeIcon must be retired");
    assert.match(sellerPage, /className="sd-thumb-type">\{dealTypeLabel\(/);
    // Dead emoji-labelled share list removed rather than left to rot.
    assert.ok(!/export const SHARE_TARGETS/.test(readFileSync("web/src/viral.ts", "utf8")), "dead SHARE_TARGETS must be gone");
  });

  // ── ITEM 4 — preview is an action, never a mandatory stage ────────────────
  await run("item 4: the seller journey is four steps and none of them is a preview stage", () => {
    const block = sellerPage.slice(sellerPage.indexOf("const JOURNEY_STEPS"), sellerPage.indexOf("const JOURNEY_TERMINAL_STEP"));
    const titles = [...block.matchAll(/\{ t: "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(titles, ["יצירת עסקה", "פרסום", "איסוף משתתפים", "הצלחה / כישלון"]);
    assert.ok(!titles.includes("תצוגה מקדימה"), "preview must not be a journey stage");
    assert.match(sellerPage, /type JourneyStage = 0 \| 1 \| 2 \| 3;/, "the stage type must follow the four steps");
    // the CSS grid must follow the array, or the strip renders a phantom column
    const css = readFileSync("web/src/styles.css", "utf8");
    const journeyGrids = css.match(/\.journey-steps \{[^}]*repeat\((\d+),/g) || [];
    assert.equal(journeyGrids.length, 2, "desktop and mobile each declare the strip grid");
    for (const rule of journeyGrids) assert.match(rule, /repeat\(4,/, `journey grid must be four columns: ${rule}`);
  });

  await run("item 4: the preview CAPABILITY is untouched", () => {
    assert.ok(sellerPage.includes('data-testid="draft-preview-open"'), "the seller must still be able to preview a draft");
    assert.match(sellerPage, /תצוגה מקדימה כקונה/, "the preview action keeps its label");
  });

  // ── HOSTED FINDING (night closeout) — no footer link to an empty page ────
  // Browsing the deployed build found "אודות" in the footer of every page
  // leading to a document with a heading and nothing under it. The landing page
  // already hides its About section while the body is empty ("a section renders
  // ONLY when its content is present"), because the final copy is the owner's
  // to write; the standalone page and the footer did not follow that rule.
  await run("hosted finding: one emptiness test, read by both the footer and the document page", async () => {
    const siteContent = await readFile("web/src/siteContent.ts", "utf8");
    assert.match(siteContent, /export function contentPageHasBody\(/,
      "the emptiness test must live in one place");
    const app = await readFile("web/src/App.tsx", "utf8");
    assert.match(app, /\.filter\(\(l\) => \{[\s\S]*?contentPageHasBody\(content, match\[1\]!\)/,
      "the footer must drop a #/content link whose page has no body");
    const receipt = await readFile("web/src/receiptContent.tsx", "utf8");
    assert.match(receipt, /data-testid="content-doc-awaiting"/,
      "a body-less document page must say so instead of rendering a lone heading");
    assert.match(receipt, /const awaitingCopy = Boolean\(content\) && !loading && !rawBody;/,
      "the notice must wait for the content to load before deciding it is empty");
  });

  await run("hosted finding: the About page is governed by the rule, not by invented copy", async () => {
    // The fix was the emptiness RULE, never writing marketing copy on the
    // owner's behalf. This deliberately does NOT freeze the body as empty — the
    // owner may supply it at any time and the footer link simply returns. What
    // must hold is that the About page's default is still declared in the one
    // canonical place, with the marker that says whose job the copy is.
    const landing = await readFile("web/src/content/landing.he.ts", "utf8");
    assert.match(landing, /ABOUT_CONTENT_PENDING_OWNER/,
      "the marker naming the owner as the source of About copy must stay discoverable");
    assert.match(landing, /about: \{ title: "[^"]+", body: /,
      "the About default must still live in the canonical landing content");
    const templates = await readFile("web/src/content/cmsTemplates.ts", "utf8");
    assert.match(templates, /body: LANDING_HE\.about\.body/,
      "and the #/content/about page must keep reading that one source");
  });

  // ── ITEM 5 — support ↔ deal/seller, resolved server-side ──────────────────
  await run("item 5: a deal reference is extracted from any real link shape, and never guessed", () => {
    const id = "6e35c4f3-3701-5874-9f6c-13a2693f87cc";
    for (const shape of [
      id,
      id.toUpperCase(),
      `https://siton-staging-web.onrender.com/d/${id}`,
      `https://siton-staging-web.onrender.com/preview/#/deal/${id}`,
      `https://siton-staging-web.onrender.com/d/${id}?ref=abc123`,
      `  https://host/preview/#/track/x?deal=${id}  `
    ]) assert.equal(extractDealReference(shape), id, `failed to read ${shape}`);
    // nothing to resolve, or AMBIGUOUS — never a guess that could bind the
    // inquiry to the wrong seller
    for (const shape of ["", "   ", "not a link", "1234", `${id} and 0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d`, "x".repeat(2100)]) {
      assert.equal(extractDealReference(shape), null, `must refuse ${JSON.stringify(String(shape).slice(0, 40))}`);
    }
    assert.deepEqual([...DEAL_SCOPED_SUPPORT_CATEGORIES], ["deal", "payment", "report"]);
    assert.equal(isDealScopedSupportCategory("general"), false);
    assert.equal(isDealScopedSupportCategory("seller"), false);
    assert.equal(supportCategoryRequiresDeal("deal"), true);
    assert.equal(supportCategoryRequiresDeal("payment"), false);
  });

  // ── ITEM 3 + ITEM 5 against the real API ─────────────────────────────────
  const sellerId = `ux39-${randomUUID()}`;
  const rivalSellerId = `ux39-rival-${randomUUID()}`;
  await ensureSellerReady(app, sellerId, "חנות הסגירה");
  await ensureSellerReady(app, rivalSellerId, "מוכר לא קשור");
  const dealId = await createDeal(app, sellerId, { title: "עסקת סגירת UX", minUnits: 1, maxUnits: 40 });
  const rivalDealId = await createDeal(app, rivalSellerId, { title: "עסקה של מוכר אחר", minUnits: 1, maxUnits: 40 });

  await run("item 3: the config validator accepts a SET of methods and rejects a broken one", () => {
    const many = validateReceiptConfig({ methods: ["name_phone", "qr", "code"], instructions: "בקופה" });
    assert.deepEqual(many.methods, ["qr", "code", "name_phone"], "methods are stored in canonical order");
    assert.equal(many.method, "qr", "the primary stays the first canonical method");
    assert.equal(many.version, 2);
    // a v1 payload still round-trips as the one-element set
    assert.deepEqual(validateReceiptConfig({ method: "code" }).methods, ["code"]);
    // every single method remains individually valid
    for (const method of RECEIPT_METHODS) {
      assert.deepEqual(
        validateReceiptConfig({ method, instructions: "מימוש בחנות", url: "https://example.invalid/{code}" }).methods,
        [method]
      );
    }
    assert.throws(() => validateReceiptConfig({ methods: [] }), /invalid_receipt_method/);
    assert.throws(() => validateReceiptConfig({ methods: ["qr", "qr"] }), /duplicate_receipt_method/);
    assert.throws(() => validateReceiptConfig({ methods: ["qr", "telepathy"] }), /invalid_receipt_method/);
    // per-method requirements still bind when the method rides along in a set
    assert.throws(() => validateReceiptConfig({ methods: ["qr", "instructions"], instructions: "  " }), /receipt_instructions_required/);
    assert.throws(() => validateReceiptConfig({ methods: ["qr", "digital_link"], url: "http://example.invalid" }), /invalid_receipt_url/);
  });

  await run("item 3: a stored v1 document still reads as a one-method set", () => {
    assert.deepEqual(receiptConfig({ deal_type: "voucher", receipt_config: { method: "code", instructions: "", url: "" } }).methods, ["code"]);
    // no config at all keeps the historical per-type default
    assert.deepEqual(receiptConfig({ deal_type: "voucher", receipt_config: null }).methods, ["code"]);
    assert.deepEqual(receiptConfig({ deal_type: "physical_product", receipt_config: null }).methods, ["qr"]);
    // a corrupt document degrades to the default instead of serving nothing
    assert.deepEqual(receiptConfig({ deal_type: "physical_product", receipt_config: { methods: ["nonsense"] } }).methods, ["qr"]);
    assert.match(receiptMethodsLabel(["qr", "code"]), / · /);
  });

  await run("item 3: the seller saves three methods on a Draft and the buyer-facing label names them all", async () => {
    const saved = await request("PUT", `/api/seller/deals/${dealId}/receipt`, sellerHeaders(sellerId),
      { methods: ["qr", "code", "name_phone"], instructions: "הציגו בקופה" });
    assert.equal(saved.status, 200, saved.body);
    assert.deepEqual(saved.json().receipt.methods, ["qr", "code", "name_phone"]);
    // still owner-scoped: another seller cannot write this deal's config
    assert.equal((await request("PUT", `/api/seller/deals/${dealId}/receipt`, sellerHeaders(rivalSellerId), { methods: ["qr"] })).status, 404);
    const stored = (await pool.query(`SELECT receipt_config FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0].receipt_config;
    assert.equal(stored.version, 2, "the stored document is versioned");
    assert.deepEqual(stored.methods, ["qr", "code", "name_phone"]);
  });

  await publishDeal(app, sellerId, dealId);
  await publishDeal(app, rivalSellerId, rivalDealId);

  await run("item 3: the public receipt-info advertises every method for the one entitlement", async () => {
    const info = (await request("GET", `/api/deals/${dealId}/receipt-info`)).json();
    assert.deepEqual(info.methods, ["qr", "code", "name_phone"]);
    assert.equal(info.method, "qr", "the primary stays first for older readers");
    assert.equal(info.labels.length, 3);
    for (const label of info.labels) assert.ok(info.label.includes(label), "the combined label names every method");
    // config is locked once the deal is public — multi-method changed nothing here
    assert.equal((await request("PUT", `/api/seller/deals/${dealId}/receipt`, sellerHeaders(sellerId), { methods: ["qr"] })).status, 409);
  });

  const buyer = await joinDeal(app, dealId, { phone: "0508811001", name: "קונה סגירה", qty: 2, optionType: "pickup" });
  const failedBuyer = await joinDeal(app, dealId, { phone: "0508811002", name: "קונה שנכשל", qty: 1, optionType: "pickup" });
  const buyerAuth = { authorization: `Bearer ${buyer.tracking_access_token}` };

  await run("item 3: no method produces a credential before the buyer is entitled", async () => {
    const r = await request("GET", `/api/participants/${buyer.participant_id}/entitlement`, buyerAuth);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json().entitlement, null, "a multi-method deal must not pre-issue anything");
  });

  await forceDealState(pool, dealId, "Completed");
  await forceParticipantTo(pool, buyer.participant_id, "ChargedSuccess");
  await forceParticipantTo(pool, failedBuyer.participant_id, "Refunded");

  let issued: any;
  await run("item 3: several representations, ONE code, ONE set of units", async () => {
    const r = await request("GET", `/api/participants/${buyer.participant_id}/entitlement`, buyerAuth);
    issued = r.json().entitlement;
    assert.deepEqual(issued.methods, ["qr", "code", "name_phone"]);
    assert.match(issued.code, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/);
    assert.equal(issued.quantity, 2);
    // the entitlement did NOT multiply with the method count
    const units = (await pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT metadata_jsonb->>'receipt_code')::int AS codes
       FROM siton.fulfillment_units WHERE participant_id=$1`, [buyer.participant_id])).rows[0];
    assert.equal(units.n, 2, "one unit per purchased unit — not one per method");
    assert.equal(units.codes, 1, "every method shows the SAME code");
    // and it is stable across reads
    assert.equal((await request("GET", `/api/participants/${buyer.participant_id}/entitlement`, buyerAuth)).json().entitlement.code, issued.code);
  });

  await run("item 3: a refunded buyer gets no credential through any method", async () => {
    const r = await request("GET", `/api/participants/${failedBuyer.participant_id}/entitlement`,
      { authorization: `Bearer ${failedBuyer.tracking_access_token}` });
    assert.equal(r.json().entitlement, null);
  });

  await run("item 3: redemption stays idempotent and single, however many methods exist", async () => {
    const first = await request("POST", `/api/seller/receipts/${buyer.participant_id}/redeem`, sellerHeaders(sellerId), {});
    assert.equal(first.status, 200, first.body);
    assert.equal(first.json().idempotent, false);
    assert.equal(first.json().receipt.status, "redeemed");
    // presenting the QR and then reading the code aloud must not redeem twice
    const second = await request("POST", `/api/seller/receipts/${buyer.participant_id}/redeem`, sellerHeaders(sellerId), {});
    assert.equal(second.status, 200, second.body);
    assert.equal(second.json().idempotent, true);
    const redeemed = (await pool.query(
      `SELECT count(*) FILTER (WHERE status='Redeemed')::int AS n FROM siton.fulfillment_units WHERE participant_id=$1`,
      [buyer.participant_id])).rows[0];
    assert.equal(redeemed.n, 2, "both units redeemed exactly once");
    // a foreign seller still cannot redeem it
    assert.equal((await request("POST", `/api/seller/receipts/${buyer.participant_id}/redeem`, sellerHeaders(rivalSellerId), {})).status, 404);
  });

  // ── ITEM 5 through the real API ──────────────────────────────────────────
  const contact = (payload: any) => request("POST", "/api/support/contact", { "content-type": "application/json" }, payload);
  const sellerInquiries = (id: string) => request("GET", "/api/seller/inquiries?scope=all", sellerHeaders(id));

  await run("item 5: a deal-category inquiry without a resolvable deal is refused, not silently orphaned", async () => {
    const missing = await contact({ name: "דנה", email: `dana-${randomUUID()}@example.invalid`, category: "deal", message: "ההזמנה שלי לא הגיעה" });
    assert.equal(missing.status, 400, missing.body);
    assert.match(missing.body, /contact_deal_reference_required/);
    const unknown = await contact({
      name: "דנה", email: `dana-${randomUUID()}@example.invalid`, category: "deal",
      message: "ההזמנה שלי לא הגיעה", deal_ref: `https://host/d/${randomUUID()}`
    });
    assert.equal(unknown.status, 404, unknown.body);
  });

  let boundCaseId = "";
  await run("item 5: a deal link binds the case to the deal AND its seller, resolved server-side", async () => {
    const r = await contact({
      name: "דנה כהן", email: `dana-${randomUUID()}@example.invalid`, phone: "0501112222",
      category: "deal", message: "ההזמנה שלי מהעסקה הזאת לא הגיעה, מה עושים?",
      // the shape a buyer really pastes — and a seller id the server must ignore
      deal_ref: `https://siton-staging-web.onrender.com/d/${dealId}?ref=whatsapp`,
      seller_id: rivalSellerId
    });
    assert.equal(r.status, 201, r.body);
    boundCaseId = r.json().case_id;
    assert.equal(r.json().deal_id, dealId);
    assert.ok(r.json().thread_id, "the seller-visible half must exist");
    const row = (await pool.query(`SELECT deal_id, seller_id FROM siton.operational_cases WHERE case_id=$1`, [boundCaseId])).rows[0];
    assert.equal(row.deal_id, dealId);
    assert.equal(row.seller_id, sellerId, "the seller comes from the DEAL, never from the request");
    assert.notEqual(row.seller_id, rivalSellerId);
  });

  await run("item 5: the owning seller sees it in their inquiries surface; an unrelated seller never does", async () => {
    const mine = await sellerInquiries(sellerId);
    assert.equal(mine.status, 200, mine.body);
    const threads = mine.json().threads as any[];
    const bound = threads.find((t) => t.deal_id === dealId);
    assert.ok(bound, "the deal's seller must see the inquiry");
    assert.equal(bound.last_sender_type, "Customer");
    const theirs = await sellerInquiries(rivalSellerId);
    assert.equal(theirs.status, 200, theirs.body);
    assert.equal((theirs.json().threads as any[]).some((t) => t.deal_id === dealId), false,
      "an unrelated seller must never see another seller's inquiry");
  });

  await run("item 5: the seller's projection carries no buyer contact PII", async () => {
    const list = await sellerInquiries(sellerId);
    const thread = (list.json().threads as any[]).find((t) => t.deal_id === dealId);
    const detail = await request("GET", `/api/seller/inquiries/${thread.thread_id}`, sellerHeaders(sellerId));
    assert.equal(detail.status, 200, detail.body);
    const stored = (await pool.query(`SELECT customer_email FROM siton.seller_inquiry_threads WHERE thread_id=$1`, [thread.thread_id])).rows[0];
    assert.ok(stored.customer_email, "the address is stored for the platform");
    assert.ok(!detail.body.includes(stored.customer_email), "but the seller projection must not serve it");
    assert.ok(!detail.body.includes("0501112222"), "and never the phone the buyer gave support");
    // the admin case keeps the contact details — that is the whole point of the split
    const description = (await pool.query(`SELECT description FROM siton.operational_cases WHERE case_id=$1`, [boundCaseId])).rows[0].description;
    assert.ok(description.includes(stored.customer_email));
    assert.ok(description.includes("0501112222"));
    assert.ok(description.includes(dealId), "and names the deal it belongs to");
  });

  await run("item 5: a general Siton question stays admin-only even when a deal link is pasted", async () => {
    const before = (await sellerInquiries(sellerId)).json().threads.length;
    const r = await contact({
      name: "יואב", email: `yoav-${randomUUID()}@example.invalid`, category: "general",
      message: `שאלה כללית על סיטון https://host/d/${dealId}`,
      deal_ref: `https://host/d/${dealId}`
    });
    assert.equal(r.status, 201, r.body);
    assert.equal(r.json().deal_id, null, "a general question must carry no deal binding");
    assert.equal(r.json().thread_id, undefined, "and must not become a seller thread");
    const row = (await pool.query(`SELECT deal_id, seller_id FROM siton.operational_cases WHERE case_id=$1`, [r.json().case_id])).rows[0];
    assert.equal(row.deal_id, null);
    assert.equal(row.seller_id, null);
    assert.equal((await sellerInquiries(sellerId)).json().threads.length, before, "no seller may gain a thread from it");
  });

  await run("item 5: an optional-deal category works both with and without a reference", async () => {
    const withDeal = await contact({
      name: "מיכל", email: `michal-${randomUUID()}@example.invalid`, category: "payment",
      message: "חויבתי פעמיים על העסקה הזאת", deal_ref: dealId
    });
    assert.equal(withDeal.status, 201, withDeal.body);
    assert.equal(withDeal.json().deal_id, dealId);
    const withoutDeal = await contact({
      name: "מיכל", email: `michal2-${randomUUID()}@example.invalid`, category: "payment",
      message: "שאלה כללית על חיובים באתר"
    });
    assert.equal(withoutDeal.status, 201, withoutDeal.body);
    assert.equal(withoutDeal.json().deal_id, null);
  });

  // ── HOSTED FINDING (night closeout) — every page opens with an h1 ─────────
  // Opening the deployed build at 390px found the seller entry screen rendering
  // ONE heading, an h2, so a screen-reader user landed on a route with no
  // top-level heading — the same defect as the support route. The login surface
  // IS the page while it is shown (the dashboards replace it once
  // authenticated), so its title is the page h1. The LEVEL was the defect, not
  // the type scale: `.auth-title` keeps the size it rendered at as an h2, so
  // nothing about the screen looks different.
  await run("hosted finding: the shared login surface opens with an h1, at its original size", async () => {
    const auth = await readFile("web/src/auth.tsx", "utf8");
    assert.match(auth, /<h1 className="auth-title">\{props\.title\}<\/h1>/,
      "the login panel title must be the page h1");
    assert.doesNotMatch(auth, /<h2[^>]*>\{props\.title\}/, "and must not also be an h2");
    const css = await readFile("web/src/styles.css", "utf8");
    assert.match(css, /\.auth-title \{[^}]*font-size: 1\.5rem/,
      "the h1 must keep the 1.5rem size the h2 rendered at — an accessibility fix, not a redesign");
    // the admin entry screen is its OWN component, not the shared panel, and
    // kept its h2 after the shared one was fixed — both are pinned here now
    const stepUp = await readFile("web/src/adminStepUp.tsx", "utf8");
    assert.match(stepUp, /<h1 className="auth-title">כניסת מנהל<\/h1>/,
      "the admin step-up title must be the page h1");
    assert.doesNotMatch(stepUp, /<h2[^>]*>כניסת מנהל/, "and must not also be an h2");
    // and where an empty state IS the whole page, its title is that page's h1
    const components = await readFile("web/src/components.tsx", "utf8");
    assert.match(components, /const Title = props\.level === 1 \? "h1" : "h3";/,
      "EmptyState must be able to carry the page's top-level heading");
    for (const file of ["web/src/pages/deal.tsx", "web/src/pages/track.tsx"]) {
      assert.match(await readFile(file, "utf8"), /<EmptyState\n\s+level=\{1\}/,
        `${file} renders a full-page empty state, so it must pass level={1}`);
    }
    assert.match(css, /\.empty-state-title \{[^}]*font-size: 1\.17rem/,
      "the empty-state title size is pinned, so the level can change without the type scale moving");
    // the support route's own h1, found the same way earlier tonight, stays
    const support = await readFile("web/src/pages/support.tsx", "utf8");
    assert.match(support, /<h1>\{copy\.title\}<\/h1>/, "the support form keeps its h1");
    assert.match(support, /<h1>\{copy\.sent_title\}<\/h1>/, "and so does its confirmation");
  });

  await run("item 5: the honeypot and the existing contact validation are unchanged", async () => {
    const bot = await contact({ name: "bot", email: "bot@example.invalid", category: "deal", message: "spam spam spam", website: "http://spam" });
    assert.equal(bot.status, 200, bot.body);
    assert.equal(bot.json().case_id, undefined);
    assert.equal((await contact({ name: "a", email: "x@example.invalid", category: "general", message: "long enough message" })).status, 400);
    assert.equal((await contact({ name: "שם", email: "not-an-email", category: "general", message: "long enough message" })).status, 400);
    assert.equal((await contact({ name: "שם", email: "x@example.invalid", category: "nope", message: "long enough message" })).status, 400);
    assert.equal((await contact({ name: "שם", email: "x@example.invalid", category: "general", message: "short" })).status, 400);
  });

  console.log(`UX_CLOSEOUT_ISSUE39_PASS ${passed}`);
} finally {
  await app.close();
  await pool.end();
}
