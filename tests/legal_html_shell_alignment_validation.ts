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
