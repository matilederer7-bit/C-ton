// PRODUCT COPY CMS — deterministic proof that the deal, tracking, seller and
// support surfaces are editable through the SAME template CMS as the site
// pages, without becoming editable in ways that could break the product:
//   * the three product pages expose their contracts to the admin editor
//   * an admin edits a sentence, saves a draft (public site unchanged) and
//     publishes (public site changes); a stale revision is refused
//   * the how-it-works steps behave as an ordered list: add / edit / delete /
//     reorder survive publish and keep their order on the public projection
//   * non-admins (anonymous, seller, buyer-style bearer) cannot read or write
//   * over-long fields, empty required fields, raw HTML / script payloads,
//     control bytes and foreign assets are refused with a stable error code
//   * the blocks are LOCKED: they cannot be removed, hidden, reordered away or
//     added to, so no content edit can delete a sentence the flow depends on
//   * missing / partial / hostile CMS data always resolves to the canonical
//     Hebrew copy — the public pages can never render blank
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateContent, CONTENT_SECTIONS } from "../src/site_content.js";
import { normalizePage, contractFor, PAGE_CONTRACTS } from "../web/src/content/cmsTemplates.js";
import { resolveDealCopy, resolveTrackCopy, resolveSellerCopy, resolveSupportCopy } from "../web/src/productCopy.js";
import {
  DEAL_EXPLAINER_KEY, WHY_GROUP_PRICE_KEY, AFTER_TAP_LINE_KEY, SHARE_LOOP_TITLE_KEY, HOW_IT_WORKS_KEYS
} from "../web/src/buyerCopy.js";
// The buyer copy lives in the dictionary now; the canonical default is the
// HEBREW resolution of each key, which is what this suite asserts against.
import { translateIn } from "../web/src/i18n/translate.js";
const he = (key: string) => translateIn("he", key);
import { SELLER_AREA_HE } from "../web/src/content/seller.he.js";
import { ensureSellerReady, sellerHeaders } from "./helpers/physical_fulfillment_fixture.js";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.PORT = "3599";
// admin READ routes fall open locally without a key; pin one so anonymous denial is deterministic
process.env.ADMIN_API_KEY = "product-copy-test-admin-key";
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { issueAdminSession } = await import("../src/admin_identity.js");
let passed = 0;
async function run(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); passed++; }
const request = async (method: any, url: string, headers: any = {}, payload?: any) => {
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body, json: () => r.json() as any };
};
const publicContent = () => request("GET", "/api/site-content").then(r => r.json().content);
const PRODUCT_PAGES = ["deal_page", "seller_area", "support_page"] as const;
const seller = `copy-seller-${randomUUID()}`;

/** A complete, valid page payload for a key, with one field replaced. */
function pageWith(key: string, blockId: string, field: string, value: string) {
  const page = normalizePage(undefined, contractFor(key));
  return { blocks: page.blocks.map(b => b.id === blockId ? { ...b, fields: { ...b.fields, [field]: value } } : b) };
}

try {
  await app.ready();
  await ensureSellerReady(app, seller, "מוכר לבדיקת תוכן");
  const admin = (await pool.query(
    `INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled) VALUES($1,'Copy Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id`,
    [`copy-${randomUUID()}@example.invalid`]
  )).rows[0];
  const headers = { cookie: `siton_admin_session=${(await issueAdminSession(pool as any, admin.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true)).token}` };

  await run("the product surfaces are registered CMS pages with locked, non-extensible contracts", async () => {
    for (const key of PRODUCT_PAGES) {
      const contract = PAGE_CONTRACTS[key];
      assert.ok(contract, `${key} is missing from the template library`);
      assert.ok(Object.hasOwn(CONTENT_SECTIONS, key), `${key} is not served by the backend`);
      assert.deepEqual(contract!.addable, [], `${key} must not accept added blocks`);
      assert.equal(contract!.locked.length, contract!.maxBlocks, `${key} must be fully locked`);
      // every locked block exists in the defaults, in order
      assert.deepEqual(normalizePage(undefined, contract!).blocks.map(b => b.id), contract!.locked.map(l => l.id));
    }
    const r = await request("GET", "/api/admin/site-content", headers);
    assert.equal(r.status, 200, r.body);
    for (const key of PRODUCT_PAGES) {
      const section = r.json().sections[key];
      assert.ok(section, `${key} is not exposed to the admin editor`);
      assert.ok(section.label && section.description, `${key} must describe itself to the admin`);
      assert.equal(section.revision, 0);
      assert.equal(section.draft, null);
      assert.ok(section.published.blocks.length > 0);
    }
  });

  await run("the canonical copy is the default: an untouched CMS serves exactly the shipped Hebrew sentences", async () => {
    const content = await publicContent();
    const deal = resolveDealCopy(content), track = resolveTrackCopy(content);
    assert.equal(deal.explainer, he(DEAL_EXPLAINER_KEY));
    assert.equal(deal.whyGroupPrice, he(WHY_GROUP_PRICE_KEY));
    assert.equal(deal.afterTap, he(AFTER_TAP_LINE_KEY));
    assert.equal(deal.shareTitle, he(SHARE_LOOP_TITLE_KEY));
    assert.deepEqual(deal.howSteps.map((step) => step.title), HOW_IT_WORKS_KEYS.map((step) => he(step.title)));
    assert.ok(track.holdNote.includes("לא בוצע חיוב"), "the tracking hold note must stay truthful by default");
    assert.deepEqual(resolveSellerCopy(content), { ...SELLER_AREA_HE });
    assert.equal(resolveSupportCopy(content).title, "תמיכה ויצירת קשר");
  });

  await run("hostile, partial and missing payloads always resolve to the canonical copy — a page can never render blank", async () => {
    for (const hostile of [null, undefined, {}, { deal_page: null }, { deal_page: { blocks: [] } }, { deal_page: { blocks: "nope" } },
      { deal_page: { blocks: [{ id: "deal", type: "deal_copy", enabled: true, fields: { explainer: "" } }] } },
      { seller_area: { blocks: [{ id: "seller", type: "seller_copy", enabled: true, fields: { empty_title: "   " } }] } },
      { support_page: 42 }]) {
      const deal = resolveDealCopy(hostile as any);
      assert.equal(deal.explainer, he(DEAL_EXPLAINER_KEY));
      assert.ok(deal.howSteps.length >= 1 && deal.howSteps.every(s => s.title));
      assert.equal(resolveSellerCopy(hostile as any).empty_title, SELLER_AREA_HE.empty_title);
      assert.ok(resolveSupportCopy(hostile as any).title);
      assert.ok(resolveTrackCopy(hostile as any).returnTitle);
    }
  });

  await run("a named admin edits a deal sentence: the draft stays private, publish reaches the public site", async () => {
    const edited = "קנייה קבוצתית בבדיקה: המחיר תקף רק אם מספיק אנשים מצטרפים.";
    const draft = await request("PUT", "/api/admin/site-content/deal_page/draft", headers, { value: pageWith("deal_page", "deal", "explainer", edited), revision: 0 });
    assert.equal(draft.status, 200, draft.body);
    // public site unchanged while the change is only a draft
    assert.equal(resolveDealCopy(await publicContent()).explainer, he(DEAL_EXPLAINER_KEY));
    const published = await request("POST", "/api/admin/site-content/deal_page/publish", headers, { revision: draft.json().sections.deal_page.revision });
    assert.equal(published.status, 200, published.body);
    const content = await publicContent();
    assert.equal(resolveDealCopy(content).explainer, edited);
    // untouched fields of the same page keep the canonical text
    assert.equal(resolveDealCopy(content).whyGroupPrice, he(WHY_GROUP_PRICE_KEY));
    assert.equal(resolveTrackCopy(content).returnTitle, "לחזור לכאן ולשאול את המוכר");
  });

  await run("a stale revision is refused (409) and the published sentence is not overwritten", async () => {
    const current = (await request("GET", "/api/admin/site-content", headers)).json().sections.deal_page.revision;
    assert.ok(current > 0);
    const stale = await request("PUT", "/api/admin/site-content/deal_page/draft", headers, { value: pageWith("deal_page", "deal", "explainer", "דריסה"), revision: current - 1 });
    assert.equal(stale.status, 409, stale.body);
    assert.notEqual(resolveDealCopy(await publicContent()).explainer, "דריסה");
  });

  await run("how-it-works steps are an ordered list: add, edit, delete and reorder survive publish in the admin's order", async () => {
    const revision = () => request("GET", "/api/admin/site-content", headers).then(r => r.json().sections.deal_page.revision);
    const stepsPage = (items: { title: string; body: string }[]) => {
      const page = normalizePage(undefined, contractFor("deal_page"));
      return { blocks: page.blocks.map(b => b.id === "how" ? { ...b, items } : b) };
    };
    const three = [{ title: "שלב א", body: "ראשון" }, { title: "שלב ב", body: "שני" }, { title: "שלב ג", body: "שלישי" }];
    let r = await request("PUT", "/api/admin/site-content/deal_page/draft", headers, { value: stepsPage(three), revision: await revision() });
    assert.equal(r.status, 200, r.body);
    r = await request("POST", "/api/admin/site-content/deal_page/publish", headers, { revision: r.json().sections.deal_page.revision });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(resolveDealCopy(await publicContent()).howSteps.map(s => s.title), ["שלב א", "שלב ב", "שלב ג"]);
    // delete the middle one and swap the remaining two
    const reordered = [{ title: "שלב ג", body: "שלישי" }, { title: "שלב א", body: "ראשון" }];
    r = await request("PUT", "/api/admin/site-content/deal_page/draft", headers, { value: stepsPage(reordered), revision: await revision() });
    assert.equal(r.status, 200, r.body);
    r = await request("POST", "/api/admin/site-content/deal_page/publish", headers, { revision: r.json().sections.deal_page.revision });
    assert.equal(r.status, 200, r.body);
    const steps = resolveDealCopy(await publicContent()).howSteps;
    assert.deepEqual(steps.map(s => s.title), ["שלב ג", "שלב א"]);
    assert.deepEqual(steps.map(s => s.n), ["1", "2"], "the numbering follows the admin's order");
  });

  await run("seller and support copy publish independently and reach their own surfaces", async () => {
    const sellerValue = pageWith("seller_area", "seller", "empty_title", "עדיין אין לך עסקאות פעילות");
    let r = await request("PUT", "/api/admin/site-content/seller_area/draft", headers, { value: sellerValue, revision: 0 });
    assert.equal(r.status, 200, r.body);
    r = await request("POST", "/api/admin/site-content/seller_area/publish", headers, { revision: r.json().sections.seller_area.revision });
    assert.equal(r.status, 200, r.body);
    const supportValue = pageWith("support_page", "support", "title", "מוקד התמיכה של C-ton");
    r = await request("PUT", "/api/admin/site-content/support_page/draft", headers, { value: supportValue, revision: 0 });
    assert.equal(r.status, 200, r.body);
    r = await request("POST", "/api/admin/site-content/support_page/publish", headers, { revision: r.json().sections.support_page.revision });
    assert.equal(r.status, 200, r.body);
    const content = await publicContent();
    assert.equal(resolveSellerCopy(content).empty_title, "עדיין אין לך עסקאות פעילות");
    assert.equal(resolveSellerCopy(content).empty_cta, SELLER_AREA_HE.empty_cta, "an untouched field keeps the canonical text");
    assert.equal(resolveSupportCopy(content).title, "מוקד התמיכה של C-ton");
  });

  await run("only a named admin may edit product copy: anonymous, seller and bearer callers are refused and change nothing", async () => {
    const before = resolveSupportCopy(await publicContent()).title;
    const payload = { value: pageWith("support_page", "support", "title", "נדרס"), revision: 99 };
    for (const [label, hdrs] of [["anonymous", {}], ["seller", sellerHeaders(seller)], ["bearer", { authorization: "Bearer not-an-admin-token" }]] as const) {
      for (const [method, url] of [["PUT", "/api/admin/site-content/support_page/draft"], ["POST", "/api/admin/site-content/support_page/publish"], ["POST", "/api/admin/site-content/support_page/discard"]] as const) {
        const r = await request(method, url, hdrs, payload);
        assert.ok([401, 403].includes(r.status), `${label} ${method} ${url} answered ${r.status}`);
      }
      assert.ok([401, 403].includes((await request("GET", "/api/admin/site-content", hdrs)).status), `${label} could read the admin CMS`);
      assert.ok([401, 403].includes((await request("GET", "/api/admin/site-content/preview", hdrs)).status), `${label} could read a draft`);
    }
    assert.equal(resolveSupportCopy(await publicContent()).title, before);
  });

  await run("malicious and malformed product copy is refused with a stable code and never reaches the site", async () => {
    const before = await publicContent();
    const cases: [string, unknown, string][] = [
      ["script tag", pageWith("deal_page", "deal", "explainer", "<script>alert(1)</script>"), "content_html_not_allowed"],
      ["img onerror", pageWith("deal_page", "deal", "explainer", "<img src=x onerror=alert(1)>"), "content_html_not_allowed"],
      ["control byte", pageWith("deal_page", "deal", "explainer", `שלום${String.fromCharCode(0)}עולם`), "content_html_not_allowed"],
      ["over-long", pageWith("deal_page", "deal", "explainer", "א".repeat(401)), "invalid_content_length"],
      ["empty required", pageWith("deal_page", "deal", "explainer", ""), "required_field_missing"],
      ["seller required", pageWith("seller_area", "seller", "empty_title", ""), "required_field_missing"],
      ["support required", pageWith("support_page", "support", "title", ""), "required_field_missing"]
    ];
    for (const [label, value, expected] of cases) {
      const key = (value as any).blocks.some((b: any) => b.id === "seller") ? "seller_area" : (value as any).blocks.some((b: any) => b.id === "support") ? "support_page" : "deal_page";
      assert.throws(() => validateContent(key, value), (err: any) => err.code === expected, `${label} should fail as ${expected}`);
      const r = await request("PUT", `/api/admin/site-content/${key}/draft`, headers, { value, revision: 0 });
      assert.equal(r.status, 400, `${label} was accepted by the API (${r.status})`);
    }
    assert.deepEqual(resolveDealCopy(await publicContent()).explainer, resolveDealCopy(before).explainer);
  });

  await run("the locked structure cannot be edited away: no removal, no hiding, no reordering, no added blocks", async () => {
    const page = normalizePage(undefined, contractFor("deal_page"));
    const attempts: [string, unknown][] = [
      ["removed block", { blocks: page.blocks.filter(b => b.id !== "track") }],
      ["disabled block", { blocks: page.blocks.map(b => b.id === "deal" ? { ...b, enabled: false } : b) }],
      ["reordered locked blocks", { blocks: [page.blocks[2], page.blocks[1], page.blocks[0]] }],
      ["added block", { blocks: [...page.blocks, { id: "extra", type: "text", enabled: true, fields: { title: "נוסף", body: "טקסט" } }] }],
      ["retyped block", { blocks: page.blocks.map(b => b.id === "deal" ? { ...b, type: "text" } : b) }]
    ];
    for (const [label, value] of attempts) {
      assert.throws(() => validateContent("deal_page", value), `${label} was accepted by the validator`);
      const r = await request("PUT", "/api/admin/site-content/deal_page/draft", headers, { value, revision: 0 });
      assert.equal(r.status, 400, `${label} was accepted by the API (${r.status})`);
    }
    // the public projection still carries every sentence the flow depends on
    const deal = resolveDealCopy(await publicContent());
    for (const value of [deal.explainer, deal.whyGroupPrice, deal.afterTap, deal.holdNotice, deal.shareTitle]) assert.ok(value.trim());
  });

  await run("a published edit survives a reload and a discard leaves the published copy untouched", async () => {
    const draft = await request("PUT", "/api/admin/site-content/support_page/draft", headers,
      { value: pageWith("support_page", "support", "intro", "טיוטה שלא תפורסם"), revision: (await request("GET", "/api/admin/site-content", headers)).json().sections.support_page.revision });
    assert.equal(draft.status, 200, draft.body);
    assert.notEqual(resolveSupportCopy(await publicContent()).intro, "טיוטה שלא תפורסם");
    const discard = await request("POST", "/api/admin/site-content/support_page/discard", headers, { revision: draft.json().sections.support_page.revision });
    assert.equal(discard.status, 200, discard.body);
    assert.equal((await request("GET", "/api/admin/site-content", headers)).json().sections.support_page.draft, null);
    // reload from the database (not from any in-process cache): the published title persists
    const stored = (await pool.query(`SELECT value_jsonb FROM siton.site_content WHERE content_key='support_page'`)).rows[0];
    assert.equal(stored.value_jsonb.blocks.find((b: any) => b.id === "support").fields.title, "מוקד התמיכה של C-ton");
    assert.equal(resolveSupportCopy(await publicContent()).title, "מוקד התמיכה של C-ton");
  });

  console.log(`PRODUCT_COPY_CMS_PASS ${passed}`);
} finally {
  for (let i = 0; i < 100 && !app.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  await app.close(); await pool.end().catch(() => undefined);
}
