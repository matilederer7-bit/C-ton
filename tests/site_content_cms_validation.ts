// SITE CMS — deterministic proof of the template-driven content editor contract.
// Runs against the real Fastify router on an isolated migrated database:
//   * legacy flat rows stay readable and migrate to blocks deterministically
//   * admin loads page templates; edits text; replaces an image; adds / deletes /
//     reorders FAQ items; reorders and disables blocks
//   * draft changes never alter the public site; preview shows the draft; publish
//     changes the public output; a stale revision is refused (no silent overwrite)
//   * malformed structure, raw HTML / script payloads, executable links and
//     foreign assets are rejected; a stored draft that turned invalid never publishes
//   * seller / buyer / anonymous callers cannot read drafts or mutate content
//   * missing CMS data uses the canonical fallback; incomplete optional content
//     still renders a complete public page
//   * hero video upload (bounded MP4/WebM, admin only) and byte-range playback
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateContent, CONTENT_SECTIONS } from "../src/site_content.js";
import { normalizePage, validatePage, projectLegacy, contractFor, PAGE_CONTRACTS, CmsValidationError } from "../web/src/content/cmsTemplates.js";
import { resolveHeroMedium } from "../web/src/heroMedium.js";
import { resolveFaqItems } from "../web/src/faqContent.js";
import { LANDING_HE } from "../web/src/content/landing.he.js";
import { sliceRange } from "../src/content_media.js";
import { ensureSellerReady, sellerHeaders } from "./helpers/physical_fulfillment_fixture.js";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.PORT = "3598";
// admin READ routes fall open locally without a key; pin one so anonymous denial is deterministic
process.env.ADMIN_API_KEY = "cms-test-admin-key";
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { issueAdminSession } = await import("../src/admin_identity.js");
let passed = 0;
async function run(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); passed++; }
const request = async (method: any, url: string, headers: any = {}, payload?: any) => {
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body, headers: r.headers, raw: r.rawPayload, json: () => r.json() as any };
};
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhS8AAAAASUVORK5CYII=";
// a minimal ISO-BMFF header ("ftyp" box) followed by padding — signature-valid, tiny
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2mp41"), Buffer.alloc(64, 7)]).toString("base64");
const NUL = String.fromCharCode(0);
const home = () => request("GET", "/api/site-content").then(r => r.json().content.home);
const faqOf = (page: any) => page.blocks.find((b: any) => b.id === "faq");
const seller = `cms-seller-${randomUUID()}`;
try {
  await app.ready();
  await run("pure schema: defaults, legacy conversion, strict rejection and lenient normalization agree", async () => {
    const contract = PAGE_CONTRACTS.home!;
    const defaults = normalizePage(undefined, contract);
    assert.equal(defaults.blocks[0]!.id, "hero"); assert.equal(defaults.blocks[0]!.fields.title, LANDING_HE.hero.title);
    assert.equal(faqOf(defaults).items.length, LANDING_HE.faq.items.length);
    const legacy = normalizePage({ title: "כותרת ישנה", sub: "משנה", intro: "פתיחה", image: "", login_cta: "כניסה", signup_cta: "הרשמה" }, contract);
    assert.equal(legacy.blocks[0]!.fields.title, "כותרת ישנה"); assert.equal(legacy.blocks[0]!.fields.primary_cta_label, "כניסה");
    assert.deepEqual(projectLegacy(legacy, contract), { title: "כותרת ישנה", sub: "משנה", intro: "פתיחה", image: "", login_cta: "כניסה", signup_cta: "הרשמה" });
    const strictLegacy = validatePage({ title: "כותרת", sub: "x", intro: "y", image: "", login_cta: "a", signup_cta: "b" }, contract);
    assert.equal(strictLegacy.blocks.length, defaults.blocks.length);
    // lenient normalization: garbage never blanks the page, unsafe strings are dropped, locked hero restored first
    const junk = normalizePage({ blocks: [{ id: "faq", type: "faq", enabled: true, fields: { title: "<b>x</b>" }, items: [{ q: "שאלה", a: "" }, { q: "ש", a: "ת" }, 5] }, { id: "hero", type: "text", fields: {} }, { id: "evil", type: "legal", fields: {} }, "nope"] }, contract);
    assert.equal(junk.blocks[0]!.id, "hero"); assert.equal(junk.blocks[0]!.type, "hero");
    assert.equal(faqOf(junk).fields.title, ""); assert.deepEqual(faqOf(junk).items, [{ q: "ש", a: "ת" }]);
    assert.ok(!junk.blocks.some((b: any) => b.id === "evil"));
    assert.deepEqual(resolveFaqItems({ items: [] }, LANDING_HE.faq.items).length, LANDING_HE.faq.items.length);
    const codes = (raw: unknown) => { try { validatePage(raw, contract); return "ok"; } catch (e) { return (e as CmsValidationError).code; } };
    assert.equal(codes({ blocks: "x" }), "invalid_content_field");
    assert.equal(codes({ blocks: [] }), "locked_block_missing");
    assert.equal(codes({ blocks: [{ ...defaults.blocks[1] }, defaults.blocks[0]] }), "locked_block_missing");
    assert.equal(codes({ blocks: [{ ...defaults.blocks[0], enabled: false }] }), "locked_block_disabled");
    assert.equal(codes({ blocks: [{ ...defaults.blocks[0], fields: { ...defaults.blocks[0]!.fields, title: "<script>alert(1)</script>" } }] }), "content_html_not_allowed");
    assert.equal(codes({ blocks: [{ ...defaults.blocks[0], fields: { ...defaults.blocks[0]!.fields, primary_cta_link: "javascript:alert(1)" } }] }), "invalid_content_link");
    assert.equal(codes({ blocks: [{ ...defaults.blocks[0], fields: { ...defaults.blocks[0]!.fields, primary_cta_link: "https://x.invalid/<script>" } }] }), "content_html_not_allowed");
    for (const bad of ["//evil.invalid/x", "http://insecure.invalid", "data:text/html,x", "/path with space", "https://x.invalid/a\"b"]) assert.equal(codes({ blocks: [{ ...defaults.blocks[0], fields: { ...defaults.blocks[0]!.fields, primary_cta_link: bad } }] }), "invalid_content_link", bad);
    for (const good of ["#/seller?signup=1", "/legal/terms", "https://example.invalid/a?b=1#c", ""]) assert.equal(codes({ blocks: [{ ...defaults.blocks[0], fields: { ...defaults.blocks[0]!.fields, primary_cta_link: good } }] }), "ok", good);
    assert.equal(codes({ blocks: [{ ...defaults.blocks[0], fields: { ...defaults.blocks[0]!.fields, image: "https://evil.invalid/x.png" } }] }), "invalid_content_image");
    assert.equal(codes({ blocks: [{ ...defaults.blocks[0], fields: { ...defaults.blocks[0]!.fields, hacked: "x" } }] }), "invalid_content_field");
    assert.equal(codes({ blocks: [defaults.blocks[0], { id: "legal_1", type: "legal", enabled: true, fields: { title: "x", body: "y" } }] }), "template_not_allowed");
    assert.equal(codes({ blocks: [defaults.blocks[0], { id: "faq_9", type: "faq", enabled: true, fields: { title: "" }, items: [] }] }), "too_few_items");
    assert.equal(codes({ blocks: [defaults.blocks[0], { id: "Bad Id", type: "text", enabled: true, fields: {} }] }), "invalid_block_id");
    assert.equal(codes({ blocks: [defaults.blocks[0], { id: "t", type: "text", enabled: true, fields: { title: "x".repeat(161), body: "" } }] }), "invalid_content_length");
    assert.equal(codes({ blocks: defaults.blocks.map(b => ({ ...b, enabled: b.id === "hero" })) }), "ok");
    assert.throws(() => validateContent("__proto__", {}), /invalid_content/);
    assert.throws(() => validateContent("home", { blocks: [] }), /locked_block_missing/);
    assert.equal(validatePage({ title: "מסמך", body: "תוכן" }, CONTENT_SECTIONS.legal_terms!).blocks[0]!.type, "legal");
    assert.equal(contractFor("legal_terms").locked[0]!.type, "legal");
  });
  await run("pure hero rule: CMS choice decides the single medium; env video only as a chosen-video fallback", async () => {
    const base = { fallbackImageUrl: "/brand.jpg", videoEnabled: true, videoUrl: "https://cdn.invalid/env.mp4", videoPoster: "p" };
    assert.deepEqual(resolveHeroMedium({ ...base, mediaKind: "image", imageUrl: "/api/content-assets/x" }), { kind: "image", url: "/api/content-assets/x", fromCms: true });
    assert.deepEqual(resolveHeroMedium({ ...base, mediaKind: "video", cmsVideoUrl: "/api/content-assets/v", cmsVideoPoster: "/api/content-assets/p" }), { kind: "video", url: "/api/content-assets/v", poster: "/api/content-assets/p" });
    assert.deepEqual(resolveHeroMedium({ ...base, mediaKind: "video" }), { kind: "video", url: "https://cdn.invalid/env.mp4", poster: "p" });
    assert.deepEqual(resolveHeroMedium({ ...base, mediaKind: "video", videoEnabled: false }), { kind: "image", url: "/brand.jpg", fromCms: false });
    assert.deepEqual(resolveHeroMedium({ ...base, mediaKind: "video", cmsVideoUrl: "/api/content-assets/v", prefersReducedMotion: true }), { kind: "image", url: "/brand.jpg", fromCms: false });
    assert.deepEqual(resolveHeroMedium({ ...base }), { kind: "video", url: "https://cdn.invalid/env.mp4", poster: "p" });
    assert.deepEqual(sliceRange("bytes=0-3", 10), { start: 0, end: 3 }); assert.deepEqual(sliceRange("bytes=8-", 10), { start: 8, end: 9 });
    assert.deepEqual(sliceRange("bytes=-2", 10), { start: 8, end: 9 }); assert.equal(sliceRange("bytes=20-", 10), "invalid"); assert.equal(sliceRange(undefined, 10), null);
  });
  await run("missing CMS data: public API serves the canonical fallback pages with legacy flat fields", async () => {
    const r = await request("GET", "/api/site-content"); assert.equal(r.status, 200, r.body);
    const c = r.json().content;
    assert.equal(c.home.title, LANDING_HE.hero.title); assert.equal(c.home.blocks[0].type, "hero");
    assert.equal(faqOf(c.home).items.length, LANDING_HE.faq.items.length);
    assert.equal(c.footer.blocks[0].items.length, 5);
    assert.equal(c.legal_terms.blocks[0].type, "legal"); assert.ok(c.legal_terms.title.length > 0);
    assert.equal(c.about.blocks[0].type, "about");
  });
  await run("existing legacy flat rows remain readable and migrate deterministically to blocks", async () => {
    await pool.query(`INSERT INTO siton.site_content(content_key,value_jsonb,updated_by) VALUES('home',$1::jsonb,'legacy-test'),('footer',$2::jsonb,'legacy-test'),('legal_privacy',$3::jsonb,'legacy-test')`,
      [JSON.stringify({ title: "כותרת מהגרסה הישנה", sub: "משנה ישנה", intro: "פתיחה ישנה", image: "", login_cta: "כניסה", signup_cta: "הרשמה" }), JSON.stringify({ text: "פוטר ישן" }), JSON.stringify({ title: "פרטיות ישנה", body: ["# פרטיות ישנה", "", "גוף ישן"].join("\n") })]);
    const c = (await request("GET", "/api/site-content")).json().content;
    assert.equal(c.home.title, "כותרת מהגרסה הישנה"); assert.equal(c.home.blocks[0].fields.title, "כותרת מהגרסה הישנה"); assert.equal(c.home.blocks[0].fields.primary_cta_label, "כניסה");
    assert.equal(faqOf(c.home).items.length, LANDING_HE.faq.items.length, "legacy home keeps the canonical FAQ");
    assert.equal(c.footer.text, "פוטר ישן"); assert.equal(c.footer.blocks[0].items.length, 5);
    assert.equal(c.legal_privacy.title, "פרטיות ישנה");
    assert.ok((await request("GET", "/legal/privacy")).body.includes("גוף ישן"));
  });
  // ── authorization ──────────────────────────────────────────────────────────
  await ensureSellerReady(app, seller, "מוכר לבדיקת CMS");
  const admin = (await pool.query(`INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled) VALUES($1,'CMS Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id`, [`cms-${randomUUID()}@example.invalid`])).rows[0];
  const other = (await pool.query(`INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled) VALUES($1,'Second Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id`, [`cms2-${randomUUID()}@example.invalid`])).rows[0];
  const headers = { cookie: `siton_admin_session=${(await issueAdminSession(pool as any, admin.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true)).token}` };
  const otherHeaders = { cookie: `siton_admin_session=${(await issueAdminSession(pool as any, other.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true)).token}` };
  await run("anonymous, seller and buyer-style callers cannot read drafts, mutate content or upload admin assets", async () => {
    for (const h of [{}, sellerHeaders(seller), { authorization: "Bearer not-a-token" }]) {
      for (const [method, url] of [["PUT", "/api/admin/site-content/home"], ["PUT", "/api/admin/site-content/home/draft"], ["POST", "/api/admin/site-content/home/publish"], ["POST", "/api/admin/site-content/home/discard"], ["POST", "/api/admin/content-assets"], ["GET", "/api/admin/site-content/preview"], ["GET", "/api/admin/site-content"]] as const) {
        const r = await request(method, url, h, method === "GET" ? undefined : { value: { blocks: [] }, revision: 0 });
        assert.ok([401, 403].includes(r.status), `${method} ${url} answered ${r.status} for ${JSON.stringify(h)}`);
      }
    }
    assert.equal((await request("POST", "/api/seller/content-assets", sellerHeaders(seller), { filename: "a.mp4", mime_type: "video/mp4", base64_data: MP4 })).status, 400, "sellers stay image-only");
  });
  // ── admin editing workflow ────────────────────────────────────────────────
  let section: any;
  const reload = async () => { const r = await request("GET", "/api/admin/site-content", headers); assert.equal(r.status, 200, r.body); section = r.json().sections.home; return r.json().sections; };
  await run("admin loads page templates: every page exposes its contract, published blocks, draft state and revision", async () => {
    const sections = await reload();
    for (const key of ["home", "about", "footer", "legal_terms", "legal_privacy", "legal_refunds", "legal_payments"]) {
      assert.ok(sections[key], `${key} missing`); assert.ok(Array.isArray(sections[key].published.blocks)); assert.ok(sections[key].contract.locked.length >= 1);
      assert.equal(typeof sections[key].revision, "number");
    }
    assert.deepEqual(sections.home.contract.addable, PAGE_CONTRACTS.home!.addable);
    assert.equal(section.draft, null); assert.equal(section.revision, 1, "legacy row keeps its revision");
    assert.equal(section.published.blocks[0].fields.title, "כותרת מהגרסה הישנה");
  });
  const draftOf = (mutator: (page: any) => void) => { const page = JSON.parse(JSON.stringify(section.draft || section.published)); mutator(page); return page; };
  await run("admin edits text, saves a DRAFT: public site unchanged, preview shows the draft, revision advances", async () => {
    const before = await home();
    const draft = draftOf(p => { p.blocks[0].fields.title = "כותרת טיוטה"; });
    const r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draft, revision: section.revision }); assert.equal(r.status, 200, r.body);
    assert.equal(r.json().sections.home.draft.blocks[0].fields.title, "כותרת טיוטה"); assert.equal(r.json().sections.home.revision, section.revision + 1);
    assert.deepEqual(await home(), before, "public output must not change on draft save");
    const preview = await request("GET", "/api/admin/site-content/preview", headers); assert.equal(preview.status, 200, preview.body);
    assert.equal(preview.json().content.home.title, "כותרת טיוטה"); assert.equal(preview.json().content.footer.text, "פוטר ישן", "preview falls back to published where no draft exists");
    assert.equal(preview.headers["cache-control"], "no-store");
    await reload();
  });
  await run("revision conflict: a stale revision is refused (409) and nothing is overwritten", async () => {
    const draft = draftOf(p => { p.blocks[0].fields.title = "כותרת של מנהל שני"; });
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", otherHeaders, { value: draft, revision: section.revision - 1 })).status, 409);
    assert.equal((await request("POST", "/api/admin/site-content/home/publish", otherHeaders, { revision: section.revision - 1 })).status, 409);
    assert.equal((await request("POST", "/api/admin/site-content/home/discard", otherHeaders, { revision: section.revision - 1 })).status, 409);
    assert.equal((await reload()).home.draft.blocks[0].fields.title, "כותרת טיוטה");
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draft, revision: "1" })).status, 400);
  });
  await run("admin adds, edits, deletes and reorders FAQ questions in the draft", async () => {
    const draft = draftOf(p => { const faq = faqOf(p); faq.items.push({ q: "שאלה חדשה?", a: "תשובה חדשה." }); });
    let r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draft, revision: section.revision }); assert.equal(r.status, 200, r.body); await reload();
    assert.equal(faqOf(section.draft).items.at(-1).q, "שאלה חדשה?");
    const edited = draftOf(p => { const faq = faqOf(p); faq.items.at(-1).a = "תשובה ערוכה."; faq.items.splice(0, 1); const [first] = faq.items.splice(faq.items.length - 1, 1); faq.items.unshift(first); });
    r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: edited, revision: section.revision }); assert.equal(r.status, 200, r.body); await reload();
    const items = faqOf(section.draft).items;
    assert.equal(items[0].q, "שאלה חדשה?"); assert.equal(items[0].a, "תשובה ערוכה."); assert.equal(items.length, LANDING_HE.faq.items.length);
    assert.ok(!items.some((i: any) => i.q === LANDING_HE.faq.items[0]!.q), "deleted question is gone");
    assert.equal(faqOf(await home()).items[0].q, LANDING_HE.faq.items[0]!.q, "public FAQ untouched until publish");
  });
  await run("admin reorders and disables blocks; the hero cannot move, be removed or hidden", async () => {
    const draft = draftOf(p => { const i = p.blocks.findIndex((b: any) => b.id === "faq"); const [faq] = p.blocks.splice(i, 1); p.blocks.splice(1, 0, faq); p.blocks.find((b: any) => b.id === "trust").enabled = false; });
    const r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draft, revision: section.revision }); assert.equal(r.status, 200, r.body); await reload();
    assert.equal(section.draft.blocks[1].id, "faq"); assert.equal(section.draft.blocks.find((b: any) => b.id === "trust").enabled, false);
    const heroMoved = draftOf(p => { const [hero] = p.blocks.splice(0, 1); p.blocks.push(hero); });
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", headers, { value: heroMoved, revision: section.revision })).status, 400);
    const heroGone = draftOf(p => { p.blocks.splice(0, 1); });
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", headers, { value: heroGone, revision: section.revision })).status, 400);
    const heroHidden = draftOf(p => { p.blocks[0].enabled = false; });
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", headers, { value: heroHidden, revision: section.revision })).status, 400);
  });
  await run("malformed structured content, raw HTML/script payloads, executable links and foreign assets are rejected", async () => {
    const bad = [
      { value: "x" }, { value: [] }, { value: { blocks: {} } }, { value: { blocks: [{}] } }, { value: { blocks: [section.published.blocks[0], { id: "x", type: "faq", enabled: true, fields: {}, items: [{ q: "a" }] }] } },
      { value: draftOf(p => { p.blocks[0].fields.title = "<script>alert(1)</script>"; }) },
      { value: draftOf(p => { p.blocks[0].fields.subtitle = "<img src=x onerror=alert(1)>"; }) },
      { value: draftOf(p => { faqOf(p).items[0].a = "תשובה </p><script>x</script>"; }) },
      { value: draftOf(p => { p.blocks[0].fields.primary_cta_link = "javascript:alert(1)"; }) },
      { value: draftOf(p => { p.blocks[0].fields.primary_cta_link = "data:text/html,hi"; }) },
      { value: draftOf(p => { p.blocks[0].fields.image = "/api/content-assets/../../etc"; }) },
      { value: draftOf(p => { p.blocks[0].fields.image = `/api/content-assets/${randomUUID()}`; }) },
      { value: draftOf(p => { p.blocks[0].fields.title = `x${NUL}y`; }) },
      { value: draftOf(p => { p.blocks.push({ id: "steps_1", type: "steps", enabled: true, fields: { title: "" }, items: Array.from({ length: 9 }, () => ({ title: "t", body: "" })) }); }) },
      { value: draftOf(p => { p.blocks.push({ id: "legal_x", type: "legal", enabled: true, fields: { title: "x", body: "y" } }); }) },
      { value: draftOf(p => { p.blocks.push({ id: "text_1", type: "text", enabled: true, fields: { title: "", body: "", style: "color:red" } }); }) }
    ];
    for (const payload of bad) {
      for (const path of ["/api/admin/site-content/home/draft", "/api/admin/site-content/home"]) {
        const r = await request("PUT", path, headers, { ...payload, revision: section.revision });
        assert.equal(r.status, 400, `${path} accepted ${JSON.stringify(payload).slice(0, 120)} → ${r.status} ${r.body}`);
      }
    }
    assert.equal((await reload()).home.revision, section.revision, "rejected payloads never advance the revision");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM siton.site_content WHERE value_jsonb::text LIKE '%<script%' OR draft_jsonb::text LIKE '%<script%'`)).rows[0].n, 0);
  });
  let imageUrl = "";
  await run("admin replaces the hero image with an admin upload; a seller upload is refused as a CMS image", async () => {
    const asset = await request("POST", "/api/admin/content-assets", headers, { filename: "pixel.png", mime_type: "image/png", base64_data: PIXEL }); assert.equal(asset.status, 200, asset.body);
    imageUrl = asset.json().url; assert.match(imageUrl, /^\/api\/content-assets\/[0-9a-f-]{36}$/);
    const sellerAsset = await request("POST", "/api/seller/content-assets", sellerHeaders(seller), { filename: "pixel.png", mime_type: "image/png", base64_data: PIXEL }); assert.equal(sellerAsset.status, 200, sellerAsset.body);
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draftOf(p => { p.blocks[0].fields.image = sellerAsset.json().url; }), revision: section.revision })).status, 400);
    const r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draftOf(p => { p.blocks[0].fields.image = imageUrl; }), revision: section.revision }); assert.equal(r.status, 200, r.body); await reload();
    assert.equal(section.draft.blocks[0].fields.image, imageUrl); assert.equal((await home()).image, "", "public hero image unchanged before publish");
  });
  await run("publish moves the draft to the public site; disabled section disappears publicly (API and page); previous value is kept", async () => {
    const r = await request("POST", "/api/admin/site-content/home/publish", headers, { revision: section.revision }); assert.equal(r.status, 200, r.body);
    const pub = await home();
    assert.equal(pub.title, "כותרת טיוטה"); assert.equal(pub.image, imageUrl); assert.equal(pub.blocks[1].id, "faq"); assert.equal(faqOf(pub).items[0].q, "שאלה חדשה?");
    assert.ok(!pub.blocks.some((b: any) => b.id === "trust"), "a hidden block's content never leaves the server");
    await reload(); assert.equal(section.draft, null); assert.ok(section.published_at);
    const row = (await pool.query(`SELECT previous_value_jsonb, updated_by FROM siton.site_content WHERE content_key='home'`)).rows[0];
    assert.equal(row.previous_value_jsonb.title, "כותרת מהגרסה הישנה"); assert.equal(row.updated_by, admin.admin_user_id);
    assert.equal((await request("POST", "/api/admin/site-content/home/publish", headers, { revision: section.revision })).status, 409, "nothing to publish");
  });
  await run("discard drops the draft and the public page stays published", async () => {
    let r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draftOf(p => { p.blocks[0].fields.title = "טיוטה שתבוטל"; }), revision: section.revision }); assert.equal(r.status, 200, r.body); await reload();
    r = await request("POST", "/api/admin/site-content/home/discard", headers, { revision: section.revision }); assert.equal(r.status, 200, r.body); await reload();
    assert.equal(section.draft, null); assert.equal((await home()).title, "כותרת טיוטה");
  });
  await run("a stored draft that became invalid can never reach the public page", async () => {
    await pool.query(`UPDATE siton.site_content SET draft_jsonb='{"blocks":[]}'::jsonb WHERE content_key='home'`);
    await reload();
    assert.equal((await request("POST", "/api/admin/site-content/home/publish", headers, { revision: section.revision })).status, 409);
    assert.equal((await home()).title, "כותרת טיוטה");
    assert.equal((await request("GET", "/api/admin/site-content/preview", headers)).json().content.home.blocks[0].type, "hero", "preview normalizes the broken draft");
    await pool.query(`UPDATE siton.site_content SET draft_jsonb=NULL WHERE content_key='home'`);
  });
  await run("incomplete optional content keeps the public page renderable; the legacy direct PUT still publishes", async () => {
    const sections = await reload();
    const about = sections.about;
    assert.equal((await request("PUT", "/api/admin/site-content/about", headers, { value: { blocks: [{ id: "about", type: "about", enabled: true, fields: { title: "אודות", body: "", image: "" } }] }, revision: about.revision })).status, 200);
    assert.equal((await request("GET", "/api/site-content")).json().content.about.body, "");
    const footer = sections.footer;
    const r = await request("PUT", "/api/admin/site-content/footer", headers, { value: { blocks: [{ id: "footer", type: "footer", enabled: true, fields: { text: "" }, items: [] }] }, revision: footer.revision }); assert.equal(r.status, 200, r.body);
    assert.deepEqual((await request("GET", "/api/site-content")).json().content.footer.blocks[0].items, []);
    const legal = sections.legal_terms;
    assert.equal((await request("PUT", "/api/admin/site-content/legal_terms", headers, { value: { title: "תקנון מעודכן", body: ["# תקנון מעודכן", "", "## סעיף", "", "גוף חדש"].join("\n") }, revision: legal.revision })).status, 200, "legacy flat legal payload still accepted");
    assert.ok((await request("GET", "/legal/terms")).body.includes("גוף חדש"));
    assert.equal((await request("PUT", "/api/admin/site-content/legal_terms", headers, { value: { blocks: [{ id: "document", type: "legal", enabled: true, fields: { title: "x", body: "<iframe src=x>" } }] }, revision: legal.revision + 1 })).status, 400);
  });
  await run("hero video: bounded admin MP4 upload, MIME/signature checks, byte-range playback and single-medium publish", async () => {
    assert.equal((await request("POST", "/api/admin/content-assets", headers, { filename: "x.mp4", mime_type: "video/mp4", base64_data: PIXEL })).status, 400, "png bytes are not an mp4");
    assert.equal((await request("POST", "/api/admin/content-assets", headers, { filename: "x.mov", mime_type: "video/quicktime", base64_data: MP4 })).status, 400);
    const video = await request("POST", "/api/admin/content-assets", headers, { filename: "hero.mp4", mime_type: "video/mp4", base64_data: MP4 }); assert.equal(video.status, 200, video.body);
    assert.equal(video.json().mime_type, "video/mp4");
    const full = await request("GET", video.json().url); assert.equal(full.status, 200); assert.equal(full.headers["content-type"], "video/mp4"); assert.equal(full.headers["accept-ranges"], "bytes");
    const part = await request("GET", video.json().url, { range: "bytes=4-7" }); assert.equal(part.status, 206); assert.equal(part.raw.toString("ascii"), "ftyp"); assert.match(String(part.headers["content-range"]), /^bytes 4-7\/\d+$/);
    assert.equal((await request("GET", video.json().url, { range: "bytes=99999-" })).status, 416);
    await reload();
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draftOf(p => { p.blocks[0].fields.media_kind = "video"; p.blocks[0].fields.video = imageUrl; }), revision: section.revision })).status, 400, "an image asset is not a video");
    assert.equal((await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draftOf(p => { p.blocks[0].fields.video_poster = video.json().url; }), revision: section.revision })).status, 400, "a video asset is not a poster image");
    let r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draftOf(p => { p.blocks[0].fields.media_kind = "video"; p.blocks[0].fields.video = video.json().url; }), revision: section.revision }); assert.equal(r.status, 200, r.body); await reload();
    r = await request("POST", "/api/admin/site-content/home/publish", headers, { revision: section.revision }); assert.equal(r.status, 200, r.body);
    const pub = await home(); assert.equal(pub.blocks[0].fields.media_kind, "video"); assert.equal(pub.blocks[0].fields.video, video.json().url);
    assert.equal(resolveHeroMedium({ fallbackImageUrl: "/b", mediaKind: "video", cmsVideoUrl: pub.blocks[0].fields.video, imageUrl: pub.blocks[0].fields.image }).kind, "video");
  });
  console.log(`SITE_CONTENT_CMS_PASS ${passed}`);
} finally {
  for (let i = 0; i < 100 && !app.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  await app.close(); await pool.end().catch(() => undefined);
}
