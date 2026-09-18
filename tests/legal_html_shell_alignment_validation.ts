// OVERNIGHT HARDENING — the server-rendered legal documents (/legal/:slug,
// linked from the join consent line and shared externally) must read as the
// same site as the canonical React product: the same topbar (brand emblem,
// wordmark, tagline, primary nav), the same legal chip strip, the same
// `.panel.content-doc` document typography, the same footer links and — when
// the React build is present — the very same stylesheet. Legal CONTENT is not
// asserted here beyond "the page title is present": it stays the CMS
// projection of src/legal_pages.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { app } = await import("../src/app.js");

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error: any) { failed += 1; console.error(`FAIL ${name}: ${error?.message || error}`); }
}

const SLUGS = ["terms", "privacy", "refunds", "payments", "sellers", "affiliates", "demo"];
const REQUIRED_SHELL = [
  /<header class="topbar">/,
  /class="brand-mark-img"/,
  /class="brand-word-img"/,
  /class="brand-sub">קונים ביחד · משלמים פחות</,
  /<nav class="nav-links" aria-label="ניווט ראשי">/,
  /href="\/preview\/#\/seller">אזור המוכרים</,
  /<nav class="legal-nav" aria-label="מסמכים משפטיים">/,
  /<article class="panel content-doc" data-section="legal_/,
  /<main class="container">/,
  /<footer class="footer">/,
  /href="\/preview\/#\/support">תמיכה ויצירת קשר</,
  /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/,
  /<meta name="theme-color" content="#17181b">/
];

try {
  await run("every legal document is served inside the C-ton shell", async () => {
    for (const slug of SLUGS) {
      const res = await app.inject({ method: "GET", url: `/legal/${slug}` });
      assert.equal(res.statusCode, 200, `${slug}: ${res.statusCode}`);
      assert.match(String(res.headers["content-type"]), /text\/html/);
      for (const pattern of REQUIRED_SHELL) assert.match(res.body, pattern, `${slug} is missing ${pattern}`);
      assert.match(res.body, /<html lang="he" dir="rtl">/, `${slug} is RTL Hebrew`);
      assert.match(res.body, /<h1>[^<]+<\/h1>/, `${slug} has a document title`);
      // ...and exactly one. The body's own "# " headings must render as h2,
      // the way the in-app ContentPage renderer maps every level: /legal/refunds
      // and /legal/payments were minting a second and third h1 from CMS copy.
      assert.equal((res.body.match(/<h1[\s>]/g) || []).length, 1,
        `${slug} must have exactly one top-level heading`);
    }
  });

  await run("the legal chip strip lists the same four documents as the in-app strip and marks the current one", async () => {
    const inApp = readFileSync("web/src/receiptContent.tsx", "utf8");
    const inAppKeys = [...inApp.matchAll(/\["legal_(\w+)", "/g)].map((m) => m[1]);
    assert.deepEqual(inAppKeys, ["terms", "privacy", "refunds", "payments"], "in-app LEGAL_NAV");
    const res = await app.inject({ method: "GET", url: "/legal/refunds" });
    const chips = [...res.body.matchAll(/<a class="chip( active)?" href="\/legal\/(\w+)"/g)].map((m) => [m[2], Boolean(m[1])] as const);
    assert.deepEqual(chips.map(([slug]) => slug), inAppKeys, "server chip strip == in-app chip strip");
    assert.deepEqual(chips.filter(([, active]) => active).map(([slug]) => slug), ["refunds"], "current document is marked active");
  });

  await run("markdown lists render as lists (never as dash-joined paragraphs) and content is escaped", async () => {
    const res = await app.inject({ method: "GET", url: "/legal/terms" });
    assert.ok(!/<p>- /.test(res.body), "no paragraph starting with a raw list dash");
    assert.ok(!/<script>/i.test(res.body.replace(/<\/?script[^>]*>/gi, (m) => (m.includes("preview") ? "" : m))), "no inline script in the document");
  });

  // ── CI FAILURE 2026-09-17 (backend-gates, mobile browser smoke) ──────────
  // /legal/terms measured window.innerWidth 548 at a 390px viewport: the
  // wordmark <img> carried no width/height, so until the (external) stylesheet
  // applied it laid out at its intrinsic 540px, overflowed the phone viewport
  // and made the browser zoom the whole page out. Every image in the
  // server-rendered shell must therefore declare its rendered size, and that
  // size must fit the narrowest supported viewport.
  await run("every image in the legal shell declares a rendered size that fits a phone", async () => {
    const res = await app.inject({ method: "GET", url: "/legal/terms" });
    const images = [...res.body.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(images.length >= 2, `expected the shell images, saw ${images.length}`);
    for (const img of images) {
      const width = img.match(/\bwidth="(\d+)"/)?.[1];
      const height = img.match(/\bheight="(\d+)"/)?.[1];
      assert.ok(width && height, `image without an intrinsic size: ${img}`);
      assert.ok(Number(width) <= 390, `${img} lays out wider than a 390px phone viewport before CSS applies`);
    }
    // and the build-absent path (fallback <style>) caps images too — asserted at
    // the source, because with web/dist present the page links the real sheet.
    const runtimeSource = readFileSync(join(process.cwd(), "src", "frontend_runtime.ts"), "utf8");
    assert.match(runtimeSource, /const fallbackCss = "<style>img\{max-width:100%\}/,
      "the fallback stylesheet must also cap image width, for the build-absent path");
  });

  // The React product answers the same rule from its own component.
  await run("the React topbar wordmark declares the same rendered size", async () => {
    const brand = readFileSync(join(process.cwd(), "web", "src", "brand.tsx"), "utf8");
    assert.match(brand, /className="brand-word-img"[\s\S]*?width=\{85\}[\s\S]*?height=\{22\}/,
      "BrandWordmark must carry width/height attributes");
  });

  // HOSTED FINDING (night closeout): the footer must not link a document page
  // that has a heading and nothing under it. The React footer already drops it
  // (web/src/siteContent.ts#contentPageHasBody); the server-rendered legal
  // footer reads the same rule instead of hard-coding the link.
  await run("the legal footer drops the About link while the About page has no body", async () => {
    const res = await app.inject({ method: "GET", url: "/legal/terms" });
    const runtime = readFileSync(join(process.cwd(), "src", "frontend_runtime.ts"), "utf8");
    assert.match(runtime, /const aboutLink = aboutHasBody \?/,
      "the About link must be conditional, never hard-coded");
    assert.match(runtime, /renderLegalHtmlPage\(slug, \{ title: value\.title!, body: value\.body! \}, contentPageHasBody\(content\["about"\]\)\)/,
      "and the condition must be the live CMS content, read per request");
    // and the served page agrees with the RULE as the content stands right now —
    // this deliberately does not freeze About as empty: the day the owner writes
    // the copy, the link simply returns and this assertion still holds.
    const site = await app.inject({ method: "GET", url: "/api/site-content" });
    const about = JSON.parse(site.body)?.content?.about;
    const block = Array.isArray(about?.blocks) ? about.blocks[0] : null;
    const body = String((block ? block?.fields?.body : about?.body) || "").replace(/^# [^\n]+\r?\n/, "").trim();
    assert.equal(res.body.includes('href="/preview/#/content/about"'), body.length > 0,
      `the footer must link the About page exactly when it has a body (body length ${body.length})`);
  });

  await run("with the React build present the legal page uses the very same stylesheet as the product", async () => {
    const index = join(process.cwd(), "web", "dist", "index.html");
    if (!existsSync(index)) {
      const res = await app.inject({ method: "GET", url: "/legal/terms" });
      assert.match(res.body, /<style>/, "fallback stylesheet present when the React build is absent");
      console.log("  (web/dist absent — fallback stylesheet path verified)");
      return;
    }
    const href = readFileSync(index, "utf8").match(/href="(\/preview\/assets\/[^"<>]+\.css)"/)?.[1];
    assert.ok(href, "React build stylesheet href");
    const res = await app.inject({ method: "GET", url: "/legal/terms" });
    assert.ok(res.body.includes(`<link rel="stylesheet" href="${href}">`), "same hashed stylesheet as /preview/");
    const css = readFileSync(join(process.cwd(), "web", "dist", href.replace(/^\/preview\//, "")), "utf8");
    for (const cls of [".content-doc", ".legal-nav", ".topbar", ".brand-mark-img", ".brand-word-img", ".chip.active", ".footer"]) {
      assert.ok(css.includes(cls), `stylesheet defines ${cls}`);
    }
  });
} finally {
  await app.close().catch(() => undefined);
}

if (failed) {
  console.error(`FAILED ${failed} legal shell alignment checks`);
  process.exit(1);
}
console.log("All legal shell alignment checks passed.");
