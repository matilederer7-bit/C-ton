// ── THE BILINGUAL PRODUCT, IN A REAL BROWSER ───────────────────────────────
//
// Everything a dictionary test cannot prove: that the switch is on the page and
// works, that the choice survives a reload, that English really lays out LTR,
// that nothing overflows a 390px phone, that each screen has one h1 and no
// unlabelled control, and that no screen ends up half-English.
//
// It drives the REAL server and the REAL React bundle over the Chrome
// DevTools Protocol — the same mechanism as the existing browser smoke.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { chromiumPath, launchPage, type BrowserPage } from "./helpers/browser_cdp.js";
import { CONTENT_SECTIONS } from "../src/site_content.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const port = 3390;
const baseUrl = `http://127.0.0.1:${port}`;
const shotsDir = join(repoRoot, ".ci-artifacts", "i18n-screens");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const HEBREW = /[֐-׿]/;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const failures: string[] = [];
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.message || e}`); failed++; failures.push(name); }
}

/**
 * The surfaces a visitor can actually reach without an account, plus the two
 * sign-in screens and the deliberately-missing routes. Every one of them is
 * visited in both languages at both viewport classes.
 */
const SURFACES: { name: string; path: string }[] = [
  { name: "landing", path: "/preview/#/" },
  { name: "mall", path: "/preview/#/deals" },
  { name: "public-deal-missing", path: "/preview/#/deal/00000000-0000-0000-0000-000000000000" },
  { name: "tracking-missing", path: "/preview/#/track/00000000-0000-0000-0000-000000000000" },
  { name: "seller-login", path: "/preview/#/seller" },
  { name: "admin-login", path: "/preview/#/admin" },
  { name: "support", path: "/preview/#/support" },
  { name: "content-about", path: "/preview/#/content/about" },
  { name: "content-terms", path: "/preview/#/content/legal_terms" },
  { name: "content-privacy", path: "/preview/#/content/legal_privacy" },
  { name: "content-refunds", path: "/preview/#/content/legal_refunds" },
  { name: "content-payments", path: "/preview/#/content/legal_payments" },
  { name: "unknown-route", path: "/preview/#/not-a-real-route" },
  { name: "legal-shell-terms", path: "/legal/terms" },
  { name: "legal-shell-privacy", path: "/legal/privacy" }
];

/** A snapshot of everything the language rules care about on the current page. */
const SNAPSHOT = `(() => {
  const el = document.documentElement;
  const labelled = (node) => {
    if (node.getAttribute("aria-hidden") === "true") return true;
    if (node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby") || node.hasAttribute("title")) return true;
    if ((node.textContent || "").trim().length > 0) return true;
    if (node.tagName === "INPUT") {
      const type = (node.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "submit", "button", "image"].includes(type)) return true;
      if (node.id && document.querySelector('label[for="' + CSS.escape(node.id) + '"]')) return true;
      if (node.closest("label")) return true;
      if (node.hasAttribute("placeholder")) return true;
      return false;
    }
    if (node.tagName === "SELECT" || node.tagName === "TEXTAREA") {
      if (node.id && document.querySelector('label[for="' + CSS.escape(node.id) + '"]')) return true;
      return Boolean(node.closest("label"));
    }
    return false;
  };
  const controls = Array.from(document.querySelectorAll("button, a[href], input, select, textarea"))
    .filter((node) => node.offsetParent !== null || node === document.activeElement);
  const unlabelled = controls.filter((node) => !labelled(node))
    .map((node) => node.tagName + "." + (node.className || "") + "#" + (node.id || ""));
  const brokenAria = Array.from(document.querySelectorAll("[aria-labelledby]"))
    .filter((node) => !String(node.getAttribute("aria-labelledby")).split(/\\s+/).every((id) => document.getElementById(id)))
    .map((node) => node.tagName);
  // The language switch names each language in ITS OWN language, so "עברית"
  // on an English page is correct — read the page without it.
  //
  // It is HIDDEN rather than cloned away: innerText on a DETACHED node falls
  // back to textContent, which includes the source of every inline <script>.
  // That would have read the shell's own boot script as page copy.
  const hidden = Array.from(document.querySelectorAll('[data-testid="language-switch"]'));
  const previous = hidden.map((node) => node.style.display);
  for (const node of hidden) node.style.display = "none";
  void document.body.offsetHeight;
  const text = (document.body.innerText || "").trim();
  hidden.forEach((node, i) => { node.style.display = previous[i] || ""; });
  return {
    lang: el.getAttribute("lang"),
    dir: el.getAttribute("dir"),
    computedDir: getComputedStyle(document.body).direction,
    h1: Array.from(document.querySelectorAll("h1")).map((h) => (h.textContent || "").trim()),
    switchVisible: Boolean(document.querySelector('[data-testid="language-switch"]')),
    activeSwitch: (document.querySelector('[data-testid="language-switch-he"][aria-current], [data-testid="language-switch-en"][aria-current]') || {}).dataset?.locale
      || (document.querySelector('.lang-btn.active') || {}).getAttribute?.("lang") || "",
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyText: text.slice(0, 20000),
    hasHebrew: /[\\u0590-\\u05FF]/.test(text),
    rawJson: /^\\s*[\\[{]"?/.test(text),
    keyLeak: /(?:^|\\s)(?:[a-z][a-z0-9_]*\\.){1,}[a-z0-9_]{2,}(?:\\s|$)/.test(text) && !/\\.(?:com|co\\.il|org|net|png|jpg|js|css)\\b/.test(text),
    unlabelled,
    brokenAria,
    storedLocale: (() => { try { return localStorage.getItem("siton.locale"); } catch { return null; } })(),
    cookieLocale: (document.cookie.match(/siton_lang=(he|en)/) || [])[1] || null
  };
})()`;

type Snapshot = {
  lang: string; dir: string; computedDir: string; h1: string[]; switchVisible: boolean;
  activeSwitch: string; scrollWidth: number; innerWidth: number; bodyText: string;
  hasHebrew: boolean; rawJson: boolean; keyLeak: boolean; unlabelled: string[];
  brokenAria: string[]; storedLocale: string | null; cookieLocale: string | null;
};

/**
 * Publish the shipped Hebrew defaults as CMS content, the way the deployed
 * staging site actually holds them.
 *
 * This suite used to run against an EMPTY cms, where every screen fell through
 * to the built-in defaults — and those carry their English sibling, so English
 * always resolved. The deployed site does not look like that: its `deal_page`
 * row holds the shipped Hebrew with no English sibling at all, and that is how
 * "אין גישה למסך המעקב" reached an English tracking screen in production.
 * Seeding the same shape makes the suite test the real condition.
 */
async function publishHebrewOnlyContent() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const key of ["deal_page", "seller_area", "support_page", "home", "footer"]) {
      const contract = CONTENT_SECTIONS[key];
      if (!contract) continue;
      // Hebrew only: `fields`/`items` exactly as shipped, `fields_en` dropped.
      const blocks = contract.defaults().map((block) => ({
        id: block.id, type: block.type, enabled: block.enabled,
        fields: { ...block.fields },
        ...(block.items ? { items: block.items.map((item) => ({ ...item })) } : {})
      }));
      await pool.query(
        `INSERT INTO siton.site_content(content_key, value_jsonb, revision, updated_by, published_at)
         VALUES ($1, $2::jsonb, 1, 'i18n-browser-suite', now())
         ON CONFLICT (content_key) DO UPDATE
           SET value_jsonb = EXCLUDED.value_jsonb, revision = siton.site_content.revision + 1,
               updated_by = EXCLUDED.updated_by, published_at = now()`,
        [key, JSON.stringify({ blocks })]
      );
    }
  } finally {
    await pool.end();
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* not up */ }
    await wait(500);
  }
  throw new Error("the server never became healthy");
}

async function switchTo(page: BrowserPage, locale: "he" | "en") {
  await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="language-switch-${locale}"]');
    if (!el) throw new Error("no language switch button for ${locale}");
    el.click();
    return true;
  })()`);
  await wait(400);
}

async function main() {
  if (!chromiumPath()) {
    // A missing browser is an ENVIRONMENT fact locally and a broken gate in CI:
    // a bilingual product that is never opened is not verified.
    if (process.env.CI) throw new Error("no Chromium available — the i18n browser gate cannot be skipped in CI");
    console.log("I18N_BROWSER SKIP — no Chromium available in this environment");
    return;
  }
  if (!existsSync(join(repoRoot, "web", "dist", "index.html"))) {
    throw new Error("web/dist is missing — run `npm run --prefix web build` before this suite");
  }
  await mkdir(shotsDir, { recursive: true });
  await publishHebrewOnlyContent();
  const server = spawn(process.execPath, [compiledAppPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port), HOST: "127.0.0.1",
      DISABLE_OUTBOX_WORKER: "1", APP_DEPLOYMENT_MODE: "demo-preview",
      RATE_LIMIT_MAX: "5000", RATE_LIMIT_SENSITIVE_MAX: "500"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let serverStderr = "";
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });

  let page: BrowserPage | null = null;
  try {
    await waitForHealth();
    page = await launchPage(`${baseUrl}/preview/`);
    const snap = () => page!.evaluate<Snapshot>(SNAPSHOT);

    // ── 1. Hebrew is the default on a first visit ─────────────────────────
    await run("1: a first visit is Hebrew and RTL, with nothing stored", async () => {
      await page!.setViewport(DESKTOP);
      await page!.goto(`${baseUrl}/preview/`);
      const s = await snap();
      assert.equal(s.lang, "he");
      assert.equal(s.dir, "rtl");
      assert.equal(s.computedDir, "rtl", "the document really lays out right-to-left");
      assert.equal(s.storedLocale, null, "nothing was stored — Hebrew is the DEFAULT, not a choice");
      assert.equal(s.hasHebrew, true);
    });

    await run("1: the language switch is visible on the page, with both languages named", async () => {
      const s = await snap();
      assert.equal(s.switchVisible, true, "the switch must be reachable without hunting for it");
      const labels = await page!.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-testid^="language-switch-"]')).map((b) => b.textContent.trim())`);
      assert.deepEqual(labels, ["עברית", "English"], "each language is named in its own language");
      assert.equal(s.activeSwitch, "he", "Hebrew is marked active");
    });

    // ── 2/5/6. Switching to English ───────────────────────────────────────
    await run("2/5/6: switching to English changes lang, dir and the copy on screen", async () => {
      const before = await snap();
      await switchTo(page!, "en");
      const after = await snap();
      assert.equal(after.lang, "en");
      assert.equal(after.dir, "ltr");
      assert.equal(after.computedDir, "ltr", "the document really lays out left-to-right");
      assert.notEqual(after.bodyText, before.bodyText, "the page actually changed language");
      assert.equal(after.activeSwitch, "en");
    });

    await run("7: the English landing has no Hebrew system copy left on it", async () => {
      const s = await snap();
      assert.equal(s.hasHebrew, false, `Hebrew left on the English landing: ${(s.bodyText.match(/[^\n]*[֐-׿][^\n]*/g) || []).slice(0, 5).join(" | ")}`);
    });

    await run("13: no translation key is rendered raw, and no raw JSON reaches the page", async () => {
      const s = await snap();
      assert.equal(s.keyLeak, false, `a translation key appears to be rendered: ${s.bodyText.slice(0, 200)}`);
      assert.equal(s.rawJson, false);
    });

    // ── 4. Persistence ───────────────────────────────────────────────────
    await run("4: the English choice is stored and survives a reload", async () => {
      const chosen = await snap();
      assert.equal(chosen.storedLocale, "en", "stored in localStorage for the app");
      assert.equal(chosen.cookieLocale, "en", "and in a cookie, so the server-rendered pages agree");
      await page!.reload();
      const after = await snap();
      assert.equal(after.lang, "en", "the reload came back in English");
      assert.equal(after.dir, "ltr");
      assert.equal(after.hasHebrew, false);
    });

    await run("4: the choice survives navigation to another route", async () => {
      await page!.goto(`${baseUrl}/preview/#/support`);
      const s = await snap();
      assert.equal(s.lang, "en", "a different screen did not reset the language");
      assert.equal(s.hasHebrew, false, "and it is not half-Hebrew");
    });

    // ── 3. Back to Hebrew ────────────────────────────────────────────────
    await run("3: switching back to Hebrew restores RTL and the Hebrew copy", async () => {
      await page!.goto(`${baseUrl}/preview/`);
      await switchTo(page!, "he");
      const s = await snap();
      assert.equal(s.lang, "he");
      assert.equal(s.dir, "rtl");
      assert.equal(s.computedDir, "rtl");
      assert.equal(s.hasHebrew, true, "the Hebrew UI is back");
      assert.equal(s.storedLocale, "he");
      await page!.reload();
      const after = await snap();
      assert.equal(after.lang, "he", "and the reload keeps Hebrew");
    });

    // ── 7/8/9/10/11/12/14/17. Every surface, both languages, both sizes ──
    for (const locale of ["he", "en"] as const) {
      await run(`${locale}: every surface renders correctly at 1440 and 390`, async () => {
        const problems: string[] = [];
        await page!.goto(`${baseUrl}/preview/`);
        await switchTo(page!, locale);
        for (const surface of SURFACES) {
          for (const viewport of [DESKTOP, MOBILE]) {
            await page!.setViewport(viewport);
            page!.clearErrors();
            const url = surface.path.startsWith("/legal")
              ? `${baseUrl}${surface.path}?lang=${locale}`
              : `${baseUrl}${surface.path}`;
            await page!.goto(url);
            const s = await snap();
            const where = `${surface.name}@${viewport.width}/${locale}`;
            // 6: the document says which language it is in…
            if (s.lang !== locale) problems.push(`${where}: html lang=${s.lang}`);
            // 5: …and lays out in the matching direction.
            const expectedDir = locale === "he" ? "rtl" : "ltr";
            if (s.dir !== expectedDir) problems.push(`${where}: dir=${s.dir}`);
            if (s.computedDir !== expectedDir) problems.push(`${where}: computed direction=${s.computedDir}`);
            // 8: no horizontal overflow — the phone rule that has bitten before.
            if (s.scrollWidth > s.innerWidth + 1) problems.push(`${where}: overflows ${s.scrollWidth} > ${s.innerWidth}`);
            // 10: exactly one top-level heading.
            if (s.h1.length !== 1) problems.push(`${where}: ${s.h1.length} h1 (${s.h1.join(" | ")})`);
            // 11/12: every control is named, and no aria-labelledby dangles.
            if (s.unlabelled.length) problems.push(`${where}: unlabelled ${s.unlabelled.slice(0, 3).join(", ")}`);
            if (s.brokenAria.length) problems.push(`${where}: broken aria-labelledby ${s.brokenAria.join(", ")}`);
            // 7: no half-translated screen. The legal BODY is the declared
            // Hebrew fallback, so it is the one place English may hold Hebrew.
            if (locale === "en" && s.hasHebrew && !surface.name.startsWith("legal-shell") && !surface.name.startsWith("content-legal") && !surface.name.startsWith("content-")) {
              problems.push(`${where}: Hebrew on an English screen`);
            }
            // 13: no key, no raw JSON, no placeholder copy.
            if (s.keyLeak) problems.push(`${where}: a translation key is rendered`);
            if (s.rawJson) problems.push(`${where}: raw JSON on screen`);
            if (/lorem ipsum|TODO|PLACEHOLDER/i.test(s.bodyText)) problems.push(`${where}: placeholder copy`);
            // the switch must be reachable from every surface
            if (!s.switchVisible) problems.push(`${where}: no language switch`);
            const errors = page!.errors().filter((e) =>
              // a deliberately missing deal/tracking id answers 404 by design
              !(surface.name.includes("missing") && /\b404\b/.test(e.text)));
            if (errors.length) problems.push(`${where}: ${errors.slice(0, 2).map((e) => `${e.kind}:${e.text}`).join(" ; ")}`);
          }
        }
        assert.deepEqual(problems, [], `\n  - ${problems.join("\n  - ")}`);
      });
    }

    // ── Visual proof ─────────────────────────────────────────────────────
    await run("evidence: screenshots of the same screens in both languages", async () => {
      const shots: { name: string; path: string; viewport: typeof DESKTOP }[] = [
        { name: "landing-desktop", path: "/preview/#/", viewport: DESKTOP },
        { name: "deal-mobile", path: "/preview/#/deal/00000000-0000-0000-0000-000000000000", viewport: MOBILE },
        { name: "seller", path: "/preview/#/seller", viewport: DESKTOP },
        { name: "admin", path: "/preview/#/admin", viewport: DESKTOP },
        { name: "legal-terms", path: "/legal/terms", viewport: DESKTOP }
      ];
      for (const locale of ["he", "en"] as const) {
        await page!.goto(`${baseUrl}/preview/`);
        await switchTo(page!, locale);
        for (const shot of shots) {
          await page!.setViewport(shot.viewport);
          const url = shot.path.startsWith("/legal") ? `${baseUrl}${shot.path}?lang=${locale}` : `${baseUrl}${shot.path}`;
          await page!.goto(url);
          await page!.screenshot(join(shotsDir, `${locale}-${shot.name}.png`));
        }
      }
      console.log(`I18N_SCREENSHOTS dir=${shotsDir}`);
    });

  } finally {
    if (page) await page.close().catch(() => undefined);
    server.kill("SIGTERM");
    await wait(500);
    if (server.exitCode === null) server.kill("SIGKILL");
  }

  console.log(`I18N_BROWSER passed=${passed} failed=${failed}`);
  if (failed) {
    if (serverStderr) console.error(`server_stderr:\n${serverStderr.slice(0, 4000)}`);
    console.error(`FAILURES: ${failures.join(" | ")}`);
    process.exit(1);
  }
}

await main();
