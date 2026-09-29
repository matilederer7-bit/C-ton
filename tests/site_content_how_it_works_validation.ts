// HOME "HOW IT WORKS" INFOGRAPHIC — deterministic proof of its content contract.
// Runs against the real Fastify router on an isolated migrated database:
//   * the infographic is a LOCKED block of the home page (id `how`, after
//     the locked owner value proposition) so it is always on the page — with the canonical owner content
//     when nothing was ever saved, and with the same content when a stored page
//     predates it (its former `steps` block is replaced, never duplicated);
//   * every word and every icon is a field: the words are the exact owner copy,
//     the icons are keys from the whitelist, and the two summary icons differ;
//   * strict validation refuses unknown icon keys, markup, an unknown field, a
//     removed or hidden block and the former steps template under the same id;
//   * lenient normalization (what the site renders) never blanks a slot: an
//     unknown icon key or an empty word falls back to the canonical default;
//   * admin edits (a word + an icon) reach the public site only on publish;
//     the English sibling ships with the defaults and is reported as missing
//     the moment the Hebrew word is changed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateContent } from "../src/site_content.js";
import { normalizePage, validatePage, missingEnglishContent, localizedPage, PAGE_CONTRACTS, TEMPLATES, CmsValidationError, type Block } from "../web/src/content/cmsTemplates.js";
import { HOW_IT_WORKS_HE } from "../web/src/content/howItWorks.he.js";
import { HOW_IT_WORKS_EN } from "../web/src/content/howItWorks.en.js";
import { HOW_IT_WORKS_BLOCK_ID, howItWorksContentOf, howItWorksField, howItWorksFieldNames, howItWorksFieldsOf, howItWorksIconFieldNames } from "../web/src/content/howItWorks.js";
import { HOW_IT_WORKS_ICON_KEYS, isHowItWorksIconKey } from "../web/src/content/howItWorksIcons.js";
import { LANDING_HE } from "../web/src/content/landing.he.js";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.PORT = "3599";
process.env.ADMIN_API_KEY = "hiw-test-admin-key";
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { issueAdminSession } = await import("../src/admin_identity.js");
let passed = 0;
async function run(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); passed++; }
const request = async (method: any, url: string, headers: any = {}, payload?: any) => {
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body, json: () => r.json() as any };
};
const contract = PAGE_CONTRACTS.home!;
const howOf = (page: { blocks: any[] }) => page.blocks.find((b: any) => b.id === HOW_IT_WORKS_BLOCK_ID);
const home = () => request("GET", "/api/site-content").then(r => r.json().content.home);
const codes = (raw: unknown) => { try { validatePage(raw, contract); return "ok"; } catch (e) { return (e as CmsValidationError).code; } };
const F = howItWorksField;
try {
  await app.ready();
  await run("the value proposition and infographic are locked in the owner-defined home order", async () => {
    assert.deepEqual(contract.locked, [{ id: "hero", type: "hero" }, { id: "value", type: "text" }, { id: HOW_IT_WORKS_BLOCK_ID, type: "how_it_works" }]);
    const page = normalizePage(undefined, contract);
    assert.equal(page.blocks[1]!.id, "value");
    assert.equal(page.blocks[1]!.fields.title, LANDING_HE.valueProposition.title);
    assert.equal(page.blocks[1]!.fields.body, LANDING_HE.valueProposition.body);
    const how = page.blocks[2]!;
    assert.equal(how.id, HOW_IT_WORKS_BLOCK_ID); assert.equal(how.type, "how_it_works"); assert.equal(how.enabled, true);
    assert.ok(!page.blocks.some(b => b.type === "steps"), "the former steps block is gone from the home defaults");
    assert.deepEqual(Object.keys(TEMPLATES.how_it_works.fields), howItWorksFieldNames(), "the template fields are the contract's, in editor order");
    const data = howItWorksContentOf(how.fields, HOW_IT_WORKS_HE);
    assert.equal(data.title, "איך זה עובד?");
    assert.equal(data.buyers.title, "לקונים");
    assert.deepEqual(data.buyers.steps.map(s => s.text), ["מוצאים עסקה", "בוחרים כמות ומשלוח", "נתפסת מסגרת בלבד", "עוקבים בזמן אמת"]);
    assert.equal(data.buyers.summary.text, "בלי חיוב עד שהעסקה נסגרת בהצלחה");
    assert.equal(data.sellers.title, "למוכרים");
    assert.deepEqual(data.sellers.steps.map(s => s.text), ["פותחים עסקה", "מגדירים כמות ותאריך", "משתפים לינק", "עוקבים ומנהלים"]);
    assert.ok(!JSON.stringify(data).includes("יעד ומועד"), "the seller step says quantity and date, not target and deadline");
    assert.equal(data.sellers.summary.text, "החיוב מתבצע רק כשהעסקה נסגרת בהצלחה");
    assert.notEqual(data.buyers.summary.icon, data.sellers.summary.icon, "the two summary icons must differ");
    for (const step of [...data.buyers.steps, ...data.sellers.steps, data.buyers.summary, data.sellers.summary]) assert.ok(isHowItWorksIconKey(step.icon), step.icon);
    assert.equal(new Set([...data.buyers.steps, ...data.sellers.steps].map(s => s.icon)).size, 8, "every step has its own icon");
    // the flat ↔ nested conversions agree
    assert.deepEqual(howItWorksFieldsOf(HOW_IT_WORKS_HE), how.fields);
    assert.deepEqual(howItWorksContentOf(howItWorksFieldsOf(HOW_IT_WORKS_HE), HOW_IT_WORKS_EN), HOW_IT_WORKS_HE);
    // the English sibling ships for every word, and icons are structural (not part of it)
    assert.ok(!missingEnglishContent(page).some(p => p.startsWith(`${HOW_IT_WORKS_BLOCK_ID}.`)), "no default word is missing its English");
    for (const name of howItWorksIconFieldNames()) assert.equal(how.fields_en![name], undefined, `${name} is not an English field`);
    const en = howItWorksContentOf(localizedPage(page, "en").blocks[2]!.fields, HOW_IT_WORKS_EN);
    assert.equal(en.title, HOW_IT_WORKS_EN.title); assert.deepEqual(en.sellers.steps.map(s => s.icon), HOW_IT_WORKS_HE.sellers.steps.map(s => s.icon));
  });
  await run("a stored page from before the infographic shows it in the same place — once — with the canonical content", async () => {
    const stored = contract.defaults().map(b => b.id === HOW_IT_WORKS_BLOCK_ID
      ? { id: "how", type: "steps", enabled: true, fields: { title: LANDING_HE.howItWorks.title }, items: LANDING_HE.howItWorks.steps.map(s => ({ title: s.title, body: s.body })) }
      : b);
    const page = normalizePage({ blocks: stored }, contract);
    assert.equal(page.blocks.filter(b => b.id === "how").length, 1);
    assert.equal(page.blocks[2]!.type, "how_it_works");
    assert.ok(!page.blocks.some(b => b.type === "steps"));
    assert.deepEqual(howItWorksContentOf(page.blocks[2]!.fields, HOW_IT_WORKS_EN), HOW_IT_WORKS_HE);
    // the former "לקונים / למוכרים" columns block is RETIRED: not in the defaults, dropped from a stored page, refused on write
    assert.ok(!contract.defaults().some(b => b.id === "audiences"), "the audiences columns block is no longer a default");
    const withAudiences = normalizePage({ blocks: [...contract.defaults(), { id: "audiences", type: "columns", enabled: true, fields: { title: "" }, items: [{ title: LANDING_HE.forBuyers.title, body: LANDING_HE.forBuyers.body, cta_label: "", cta_link: "" }] }] }, contract);
    assert.ok(!withAudiences.blocks.some(b => b.id === "audiences"), "a stored audiences block is dropped on read");
    assert.equal(codes({ blocks: [...contract.defaults(), { id: "audiences", type: "columns", enabled: true, fields: { title: "" }, items: [{ title: "x", body: "", cta_label: "", cta_link: "" }] }] }), "template_not_allowed");
    assert.equal(codes({ blocks: [...contract.defaults(), { id: "columns_1", type: "columns", enabled: true, fields: { title: "" }, items: [{ title: "x", body: "", cta_label: "", cta_link: "" }] }] }), "ok", "other columns blocks stay addable");
    // a stored page with NO how block at all gets it too
    const without = normalizePage({ blocks: contract.defaults().filter(b => b.id !== HOW_IT_WORKS_BLOCK_ID) }, contract);
    assert.equal(without.blocks[2]!.id, HOW_IT_WORKS_BLOCK_ID);
    // strict validation refuses the OLD shape under the same id and the block's absence / hiding
    assert.equal(codes({ blocks: stored }), "template_not_allowed");
    assert.equal(codes({ blocks: contract.defaults().filter(b => b.id !== HOW_IT_WORKS_BLOCK_ID) }), "locked_block_missing");
    assert.equal(codes({ blocks: contract.defaults().map(b => b.id === HOW_IT_WORKS_BLOCK_ID ? { ...b, enabled: false } : b) }), "locked_block_disabled");
  });
  await run("icons are whitelisted keys: strict validation refuses anything else, lenient normalization falls back", async () => {
    const withHow = (edit: (how: Block) => void) => { const blocks = contract.defaults(); edit(howOf({ blocks })!); return { blocks }; };
    assert.equal(codes(withHow(h => { h.fields[F.stepIcon("buyers", 2)] = "evil"; })), "invalid_content_option");
    assert.equal(codes(withHow(h => { h.fields[F.summaryIcon("sellers")] = "<svg onload=alert(1)>"; })), "content_html_not_allowed");
    assert.equal(codes(withHow(h => { h.fields[F.stepIcon("sellers", 4)] = "/api/content-assets/x.svg"; })), "invalid_content_option");
    assert.equal(codes(withHow(h => { h.fields[F.stepText("buyers", 1)] = "<b>x</b>"; })), "content_html_not_allowed");
    assert.equal(codes(withHow(h => { h.fields[F.stepText("sellers", 3)] = ""; })), "required_field_missing");
    assert.equal(codes(withHow(h => { h.fields[F.stepText("sellers", 3)] = "x".repeat(81); })), "invalid_content_length");
    assert.equal(codes(withHow(h => { h.fields.svg = "<svg/>"; })), "invalid_content_field");
    assert.equal(codes(withHow(h => { h.fields_en = { ...(h.fields_en ?? {}), [F.stepIcon("buyers", 1)]: "cart" }; })), "invalid_content_field", "an icon has no English sibling");
    for (const key of HOW_IT_WORKS_ICON_KEYS) assert.equal(codes(withHow(h => { h.fields[F.stepIcon("buyers", 3)] = key; })), "ok", key);
    // lenient: what the site renders can never be blank or unknown
    const junk = normalizePage(withHow(h => { h.fields[F.stepIcon("buyers", 2)] = "evil"; h.fields[F.stepText("buyers", 2)] = "   "; h.fields[F.summaryIcon("sellers")] = "<script>"; h.fields.title = ""; }), contract);
    const data = howItWorksContentOf(howOf(junk)!.fields, HOW_IT_WORKS_HE);
    assert.equal(data.buyers.steps[1]!.icon, HOW_IT_WORKS_HE.buyers.steps[1]!.icon);
    assert.equal(data.buyers.steps[1]!.text, "בוחרים כמות ומשלוח");
    assert.equal(data.sellers.summary.icon, HOW_IT_WORKS_HE.sellers.summary.icon);
    assert.equal(data.title, "איך זה עובד?");
    assert.deepEqual(howItWorksContentOf(null, HOW_IT_WORKS_HE), HOW_IT_WORKS_HE, "no fields at all → the canonical content");
  });
  // ── the API: nothing saved → defaults; an admin edit reaches the public site on publish ──
  const admin = (await pool.query(`INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled) VALUES($1,'HIW Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id`, [`hiw-${randomUUID()}@example.invalid`])).rows[0];
  const headers = { cookie: `siton_admin_session=${(await issueAdminSession(pool as any, admin.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true)).token}` };
  let revision = 0;
  const reload = async () => { const s = (await request("GET", "/api/admin/site-content", headers)).json().sections.home; revision = s.revision; return s; };
  await run("public API: with nothing ever saved the home page carries the infographic with the canonical content", async () => {
    assert.equal((await pool.query(`SELECT 1 FROM siton.site_content WHERE content_key='home'`)).rowCount, 0, "precondition: no stored home page");
    const pub = await home();
    assert.equal(pub.blocks[2].id, HOW_IT_WORKS_BLOCK_ID); assert.equal(pub.blocks[2].type, "how_it_works");
    assert.deepEqual(pub.blocks.map((b: any) => b.id), ["hero", "value", "how", "faq", "contact"], "the owner value block precedes the infographic and the retired trust section stays gone");
    assert.deepEqual(howItWorksContentOf(pub.blocks[2].fields, HOW_IT_WORKS_EN), HOW_IT_WORKS_HE);
    assert.equal(pub.blocks[2].fields_en[F.stepText("buyers", 2)], HOW_IT_WORKS_EN.buyers.steps[1]!.text, "the shipped English is served");
    const section = await reload();
    assert.equal(section.published.blocks[2].type, "how_it_works");
    assert.ok(!section.missing_english.some((p: string) => p.startsWith(`${HOW_IT_WORKS_BLOCK_ID}.`)));
  });
  await run("admin edits a word and an icon: the draft is private, publish changes the site, the English of the changed word is reported", async () => {
    const section = await reload();
    const draft = JSON.parse(JSON.stringify(section.published));
    const how = howOf(draft);
    how.fields[F.stepText("buyers", 2)] = "בוחרים כמות ומשלוח מהיר";
    // the owner wrote a new Hebrew word and left its English empty (the shipped
    // English of the OLD word is not a translation of the new one)
    how.fields_en[F.stepText("buyers", 2)] = "";
    how.fields[F.stepIcon("buyers", 2)] = "truck";
    how.fields[F.summaryIcon("sellers")] = "check_circle";
    let r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: draft, revision }); assert.equal(r.status, 200, r.body);
    let pub = await home();
    assert.equal(pub.blocks[2].fields[F.stepText("buyers", 2)], "בוחרים כמות ומשלוח", "public site unchanged until publish");
    assert.equal(pub.blocks[2].fields[F.stepIcon("buyers", 2)], "cart");
    const preview = (await request("GET", "/api/admin/site-content/preview", headers)).json().content.home;
    assert.equal(preview.blocks[2].fields[F.stepIcon("buyers", 2)], "truck", "preview shows the draft");
    await reload();
    r = await request("POST", "/api/admin/site-content/home/publish", headers, { revision }); assert.equal(r.status, 200, r.body);
    pub = await home();
    const data = howItWorksContentOf(pub.blocks[2].fields, HOW_IT_WORKS_HE);
    assert.equal(data.buyers.steps[1]!.text, "בוחרים כמות ומשלוח מהיר");
    assert.equal(data.buyers.steps[1]!.icon, "truck");
    assert.equal(data.sellers.summary.icon, "check_circle");
    assert.equal(data.sellers.steps[1]!.text, "מגדירים כמות ותאריך", "untouched words stay");
    assert.equal(pub.blocks[2].fields_en[F.stepText("buyers", 2)], "", "no invented English for the owner's new words");
    assert.equal(pub.blocks[2].fields_en[F.stepText("buyers", 1)], HOW_IT_WORKS_EN.buyers.steps[0]!.text);
    const after = await reload();
    assert.ok(after.missing_english.includes(`${HOW_IT_WORKS_BLOCK_ID}.${F.stepText("buyers", 2)}`));
    // the server refuses an icon that is not on the whitelist, in any disguise
    for (const bad of ["evil", "<svg/>", "https://x.invalid/i.svg", ""]) {
      const d = JSON.parse(JSON.stringify(after.published)); howOf(d).fields[F.stepIcon("sellers", 1)] = bad;
      const rr = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: d, revision }); assert.equal(rr.status, 400, `${bad}: ${rr.body}`);
    }
    // and the server-side contract is the same one (validateContent)
    assert.throws(() => validateContent("home", { blocks: contract.defaults().map(b => b.id === HOW_IT_WORKS_BLOCK_ID ? { ...b, fields: { ...b.fields, [F.stepIcon("buyers", 4)]: "nope" } } : b) }), /invalid_content_option/);
  });
  await run("a draft saved before the infographic (old `how` steps + `audiences`) is flagged unpublishable as stored; the server guard holds; re-saving the shown draft publishes it (Codex P2 on #121)", async () => {
    const before = await reload();
    const legacy = JSON.parse(JSON.stringify(before.published));
    legacy.blocks = legacy.blocks.map((b: any) => b.id === HOW_IT_WORKS_BLOCK_ID
      ? { id: "how", type: "steps", enabled: true, fields: { title: LANDING_HE.howItWorks.title }, items: LANDING_HE.howItWorks.steps.map(s => ({ title: s.title, body: s.body })) }
      : b);
    legacy.blocks.splice(2, 0, { id: "audiences", type: "columns", enabled: true, fields: { title: "" }, items: [{ title: LANDING_HE.forBuyers.title, body: LANDING_HE.forBuyers.body, cta_label: "", cta_link: "" }] });
    await pool.query(`UPDATE siton.site_content SET draft_jsonb=$1::jsonb, draft_updated_at=now() WHERE content_key='home'`, [JSON.stringify(legacy)]);
    const section = await reload();
    assert.equal(section.draft_publishable, false, "a draft stored under the old contract must be reported as not publishable as stored");
    assert.equal(section.draft.blocks[2].type, "how_it_works", "the editor still receives the normalized draft");
    assert.ok(!section.draft.blocks.some((b: any) => b.id === "audiences"));
    // the publish-time guard is NOT weakened: the stored draft itself is still refused
    const refused = await request("POST", "/api/admin/site-content/home/publish", headers, { revision });
    assert.equal(refused.status, 409); assert.equal(refused.json().error, "draft_invalid");
    // what the editor does: save the draft it shows, then publish
    let r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: section.draft, revision }); assert.equal(r.status, 200, r.body);
    assert.equal(r.json().sections.home.draft_publishable, true);
    await reload();
    r = await request("POST", "/api/admin/site-content/home/publish", headers, { revision }); assert.equal(r.status, 200, r.body);
    const pub = await home();
    assert.deepEqual(pub.blocks.map((b: any) => b.id), ["hero", "value", "how", "faq", "contact"]);
    assert.equal(pub.blocks[2].type, "how_it_works");
    // a valid stored draft reports publishable
    const d = JSON.parse(JSON.stringify((await reload()).published)); howOf(d).fields[F.stepText("sellers", 1)] = "פותחים עסקה חדשה";
    r = await request("PUT", "/api/admin/site-content/home/draft", headers, { value: d, revision }); assert.equal(r.status, 200, r.body);
    assert.equal(r.json().sections.home.draft_publishable, true);
    await request("POST", "/api/admin/site-content/home/discard", headers, { revision: r.json().sections.home.revision });
  });
  console.log(`SITE_CONTENT_HOW_IT_WORKS_PASS passed=${passed}`);
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
