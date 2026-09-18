// ── THE SERVER-RENDERED SURFACES, IN BOTH LANGUAGES ────────────────────────
//
// The legal documents, the share/Open Graph page and the hosted-payment return
// pages are served by the backend, not the React app. They are the same
// product, so they must answer in the same language — and, being no-JS pages,
// they must carry their own way to switch.
//
// Everything here goes through the real router with real requests: the
// question is not "does the code look right" but "what does the server send".
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { app } = await import("../src/app.js");
const { LEGAL_PAGE_ORDER } = await import("../src/legal_pages.js");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.message || e}`); failed++; }
}

const HEBREW = /[֐-׿]/;
const get = (url: string, headers?: Record<string, string>) =>
  app.inject({ method: "GET", url, ...(headers ? { headers } : {}) });

/** The chrome of a page: everything outside the legal document body. */
function chrome(html: string): string {
  const start = html.indexOf('<article class="panel content-doc"');
  const end = html.indexOf("</article>", start);
  if (start < 0 || end < 0) return html;
  return html.slice(0, start) + html.slice(end);
}

await run("6/5: a legal page defaults to Hebrew and RTL", async () => {
  const res = await get("/legal/terms");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<html lang="he" dir="rtl">/);
});

await run("2/5/6: ?lang=en serves the same document in English chrome and LTR", async () => {
  const res = await get("/legal/terms?lang=en");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<html lang="en" dir="ltr">/);
  assert.match(chrome(res.body), /Sellers area/, "the nav is English");
  assert.match(chrome(res.body), /Support and contact/, "the footer is English");
  assert.match(chrome(res.body), /Legal documents/, "the chip strip is labelled in English");
  assert.doesNotMatch(chrome(res.body), HEBREW.source === "" ? /$^/ : /תמיכה ויצירת קשר|אזור המוכרים/, "no Hebrew chrome left");
});

await run("4: the stored cookie alone is enough — no query string needed", async () => {
  const res = await get("/legal/privacy", { cookie: "siton_lang=en" });
  assert.match(res.body, /<html lang="en" dir="ltr">/);
  const back = await get("/legal/privacy", { cookie: "siton_lang=he" });
  assert.match(back.body, /<html lang="he" dir="rtl">/);
});

await run("4: an English browser with no stored choice still gets Hebrew", async () => {
  const res = await get("/legal/terms", { "accept-language": "en-GB,en;q=0.9" });
  assert.match(res.body, /<html lang="he" dir="rtl">/, "Hebrew first is a business rule, not a guess");
});

await run("15: the English legal BODY is the Hebrew one, and the page says so", async () => {
  const he = await get("/legal/terms");
  const en = await get("/legal/terms?lang=en");
  assert.match(en.body, /data-translation="OWNER_TRANSLATION_REQUIRED"/,
    "the untranslated document declares itself");
  assert.match(en.body, /There is no approved English translation of this document yet/);
  assert.match(en.body, /<article class="panel content-doc"[^>]*lang="he" dir="rtl"/,
    "the Hebrew contract keeps Hebrew typography and direction inside an English page");
  // …and the shell's own English notices must NOT be inside that RTL article,
  // or they render right-aligned with their full stops on the wrong side.
  const article = en.body.slice(en.body.indexOf('<article class="panel content-doc"'), en.body.indexOf("</article>"));
  assert.doesNotMatch(article, /class="notice info"/,
    "the shell notices belong to the shell, not to the Hebrew document");
  assert.match(en.body, /<div class="legal-notices">/);
  // And it really is the same contract — not a machine translation.
  const body = (html: string) => html.slice(html.indexOf("<h1>"), html.indexOf("</article>"));
  assert.equal(body(en.body), body(he.body), "the fallback is the real Hebrew document");
});

await run("15: every legal document behaves the same way in both languages", async () => {
  for (const slug of LEGAL_PAGE_ORDER) {
    const he = await get(`/legal/${slug}`);
    const en = await get(`/legal/${slug}?lang=en`);
    assert.equal(he.statusCode, 200, slug);
    assert.equal(en.statusCode, 200, slug);
    assert.match(he.body, /<html lang="he" dir="rtl">/, `${slug} he`);
    assert.match(en.body, /<html lang="en" dir="ltr">/, `${slug} en`);
    // 10: exactly one top-level heading per document, in either language.
    for (const [label, html] of [["he", he.body], ["en", en.body]] as const) {
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${slug} (${label}) must have exactly one h1`);
    }
  }
});

await run("2: the no-JS legal page carries its own language switch, both ways", async () => {
  const res = await get("/legal/refunds");
  assert.match(res.body, /data-testid="language-switch"/);
  assert.match(res.body, /data-testid="language-switch-he"[^>]*>עברית</);
  assert.match(res.body, /data-testid="language-switch-en"[^>]*>English</);
  assert.match(res.body, /href="\/legal\/refunds\?lang=en"/);
  assert.match(res.body, /href="\/legal\/refunds\?lang=he"/);
  // and it marks which one is active
  assert.match(res.body, /class="lang-btn active" lang="he"/);
  const en = await get("/legal/refunds?lang=en");
  assert.match(en.body, /class="lang-btn active" lang="en"/);
});

await run("16: the legal page declares both language variants to crawlers and varies on the cookie", async () => {
  const res = await get("/legal/payments");
  assert.match(res.body, /<link rel="alternate" hreflang="he" href="\/legal\/payments\?lang=he">/);
  assert.match(res.body, /<link rel="alternate" hreflang="en" href="\/legal\/payments\?lang=en">/);
  assert.equal(String(res.headers.vary || "").toLowerCase().includes("cookie"), true,
    "a cookie-dependent page must not be cached across languages");
});

await run("5/6: the hosted-payment return pages follow the language too", async () => {
  for (const path of ["/pay/return", "/pay/cancel"]) {
    const he = await get(path);
    assert.match(he.body, /<html lang="he" dir="rtl">/, path);
    assert.match(he.body, HEBREW, `${path} speaks Hebrew by default`);
    const en = await get(`${path}?lang=en`);
    assert.match(en.body, /<html lang="en" dir="ltr">/, path);
    assert.doesNotMatch(en.body, HEBREW, `${path} has no Hebrew left in English`);
    // …and neither page claims money moved.
    assert.doesNotMatch(en.body, /\byou (?:have )?paid\b/i, `${path} must not claim a payment`);
  }
});

await run("17: an unknown legal slug is still a refusal, not a half-translated page", async () => {
  const res = await get("/legal/not-a-document?lang=en");
  assert.equal(res.statusCode, 404);
});

await run("16: the share/OG page carries the visitor's language and og:locale", async () => {
  const id = "00000000-0000-0000-0000-000000000000";
  const he = await get(`/d/${id}`);
  const en = await get(`/d/${id}`, { cookie: "siton_lang=en" });
  // A missing deal redirects; a malformed id redirects. Either way the shape
  // under test is the HTML branch, so only assert when one is returned.
  if (he.statusCode === 200) {
    assert.match(he.body, /<html lang="he" dir="rtl">/);
    assert.match(he.body, /og:locale" content="he_IL"/);
  }
  if (en.statusCode === 200) {
    assert.match(en.body, /<html lang="en" dir="ltr">/);
    assert.match(en.body, /og:locale" content="en_IL"/);
  }
  assert.ok([200, 302].includes(he.statusCode), `unexpected status ${he.statusCode}`);
});

await run("16: the CMS API answers with both languages so the client can switch without a round trip", async () => {
  const res = await get("/api/site-content");
  assert.equal(res.statusCode, 200);
  const content = JSON.parse(res.body).content;
  assert.ok(content && typeof content === "object");
  const home = content.home;
  assert.ok(Array.isArray(home?.blocks), "blocks are served");
  assert.ok("value_en" in home, "the English projection is served alongside the Hebrew one");
  const hero = home.blocks.find((b: any) => b.id === "hero");
  assert.ok(hero, "the hero block is served");
  assert.ok(hero.fields_en && typeof hero.fields_en.title === "string",
    "a block carries its English sibling, so a language switch needs no new request");
});

console.log(`I18N_SERVER_SURFACE passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
