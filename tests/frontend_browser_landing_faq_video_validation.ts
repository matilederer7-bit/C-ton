// ── LANDING: FAQ BRICK + INTRO VIDEO, IN A REAL BROWSER ──────────────────────
//
// Owner round 2026-09-28:
//   * the whole FAQ is ONE collapsed brick ("שאלות נפוצות"): a click opens it,
//     a second click closes it; a real <button> with aria-expanded /
//     aria-controls; the exact new question and answer are inside;
//   * a video area sits UNDER the logo and BEFORE the title: muted, looping,
//     playsInline, autoplaying, no controls, a poster, its 16:9 space reserved
//     so the page never jumps; with no video configured there is no slot at all.
//
// The video is a real webm recorded in the browser (canvas + MediaRecorder) and
// fed through the existing runtime fallback (LANDING_HERO_VIDEO_*) as a data:
// URL — nothing is invented in the repository.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { chromiumPath, launchPage, type BrowserPage } from "./helpers/browser_cdp.js";
import { CONTENT_SECTIONS } from "../src/site_content.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DESKTOP = { width: 1366, height: 800 };
const MOBILE = { width: 390, height: 844 };
const NEW_Q = "מה קורה אם לא מגיעים ליעד?";
const NEW_A = "שום דבר — וזה בדיוק העניין. עד סגירת העסקה נתפסת מסגרת אשראי בלבד, ולא מתבצע חיוב. אם העסקה לא מגיעה ליעד עד מועד הסיום, המסגרת של כל המצטרפים משתחררת אוטומטית ואף אחד לא משלם.";

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function startServer(port: number, extraEnv: Record<string, string>) {
  const server = spawn(process.execPath, [compiledAppPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DISABLE_OUTBOX_WORKER: "1", APP_DEPLOYMENT_MODE: "demo-preview", RATE_LIMIT_MAX: "5000", RATE_LIMIT_SENSITIVE_MAX: "500", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"]
  });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return server; } catch { /* booting */ }
    await wait(500);
  }
  server.kill("SIGTERM");
  throw new Error("server did not become healthy");
}

const appErrors = (page: BrowserPage) =>
  page.errors().filter((e) => !/favicon/.test(e.text) && !(e.kind === "request" && /^Stylesheet /.test(e.text)));

async function main() {
  if (!chromiumPath()) {
    if (process.env.CI) throw new Error("no Chromium available — the landing browser gate cannot be skipped in CI");
    console.log("LANDING_FAQ_VIDEO_BROWSER SKIP — no Chromium available");
    return;
  }
  if (!existsSync(join(repoRoot, "web", "dist", "index.html"))) throw new Error("web/dist is missing — run `npm run --prefix web build` first");

  const servers: ChildProcess[] = [];
  let page: BrowserPage | null = null;
  try {
    // ── 1. no video configured: no slot; the FAQ brick ─────────────────────
    const plainPort = 3396;
    servers.push(await startServer(plainPort, { LANDING_HERO_VIDEO_ENABLED: "" }));
    page = await launchPage(`http://127.0.0.1:${plainPort}/preview/`);

    for (const viewport of [DESKTOP, MOBILE]) {
      await run(`@${viewport.width}: the FAQ is one closed brick that opens and closes, with ARIA`, async () => {
        await page!.setViewport(viewport);
        await page!.goto(`http://127.0.0.1:${plainPort}/preview/?v=${viewport.width}#/`, { waitMs: 900 });
        const closed = await page!.evaluate<any>(`(() => {
          const b = document.querySelector('[data-testid="landing-faq-toggle"]');
          const panel = document.getElementById(b.getAttribute('aria-controls'));
          return { tag: b.tagName, type: b.type, text: b.textContent.trim(), expanded: b.getAttribute('aria-expanded'), panelHidden: panel.hidden,
                   panelVisible: panel.getBoundingClientRect().height > 0, focusable: b.tabIndex >= 0, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        })()`);
        assert.equal(closed.tag, "BUTTON", "the brick must be a real button (keyboard: Enter / Space)");
        assert.equal(closed.type, "button");
        assert.ok(closed.text.includes("שאלות נפוצות"), closed.text);
        assert.equal(closed.expanded, "false");
        assert.equal(closed.panelHidden, true);
        assert.equal(closed.panelVisible, false, "the questions are visible while the brick is closed");
        assert.equal(closed.focusable, true);
        assert.equal(closed.overflow, false, "horizontal overflow");

        await page!.evaluate(`document.querySelector('[data-testid="landing-faq-toggle"]').click()`); await wait(150);
        const open = await page!.evaluate<any>(`(() => {
          const b = document.querySelector('[data-testid="landing-faq-toggle"]');
          const panel = document.getElementById(b.getAttribute('aria-controls'));
          const items = [...panel.querySelectorAll('.landing-faq-item')].map(d => ({ q: d.querySelector('summary').textContent.trim(), a: d.querySelector('p').textContent.trim() }));
          return { expanded: b.getAttribute('aria-expanded'), visible: panel.getBoundingClientRect().height > 0, items };
        })()`);
        assert.equal(open.expanded, "true");
        assert.equal(open.visible, true, "the brick did not open");
        const added = open.items.find((i: any) => i.q === NEW_Q);
        assert.ok(added, `the new question is missing: ${JSON.stringify(open.items.map((i: any) => i.q))}`);
        assert.equal(added.a, NEW_A, "the answer is not the exact owner text");
        assert.equal(open.items.filter((i: any) => /לא מגיע(ה|ים) ליעד/.test(i.q)).length, 1, "the old duplicate target question is still listed");

        await page!.evaluate(`document.querySelector('[data-testid="landing-faq-toggle"]').click()`); await wait(150);
        assert.equal(await page!.evaluate(`document.querySelector('[data-testid="landing-faq-toggle"]').getAttribute('aria-expanded')`), "false", "a second click did not close the brick");
      });
    }

    await run("no video configured → no video slot, logo then title", async () => {
      const s = await page!.evaluate<any>(`({ slot: !!document.querySelector('[data-testid="landing-intro-video"]'), logo: !!document.querySelector('.landing-logo'), media: document.querySelectorAll('video').length })`);
      assert.deepEqual(s, { slot: false, logo: true, media: 0 });
      assert.deepEqual(appErrors(page!), []);
    });

    // record a real, tiny webm in the browser
    const dataUrl = await page!.evaluate<string>(`(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const g = c.getContext('2d'); const stream = c.captureStream(15);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); const parts = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      let f = 0; const t = setInterval(() => { g.fillStyle = f++ % 2 ? '#0f766e' : '#0f172a'; g.fillRect(0, 0, 320, 180); }, 60);
      rec.start(); await new Promise(r => setTimeout(r, 900)); rec.stop(); clearInterval(t);
      await new Promise(r => rec.onstop = r);
      const blob = new Blob(parts, { type: 'video/webm' });
      return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    })()`);
    assert.ok(dataUrl.startsWith("data:video/webm"), "could not record a test clip");
    await page.close(); page = null;

    // ── 2. a configured video: the slot under the logo ─────────────────────
    // The admin chooses "video" for the hero in the CMS (media_kind); with no
    // uploaded file, the runtime LANDING_HERO_VIDEO_* fallback supplies the clip.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const blocks = CONTENT_SECTIONS.home!.defaults().map((block) => ({
        id: block.id, type: block.type, enabled: block.enabled,
        fields: block.id === "hero" ? { ...block.fields, media_kind: "video" } : { ...block.fields },
        ...(block.fields_en ? { fields_en: { ...block.fields_en } } : {}),
        ...(block.items ? { items: block.items.map((item) => ({ ...item })) } : {}),
        ...(block.items_en ? { items_en: block.items_en.map((item) => ({ ...item })) } : {})
      }));
      await pool.query(
        `INSERT INTO siton.site_content(content_key, value_jsonb, revision, updated_by, published_at)
         VALUES ('home', $1::jsonb, 1, 'landing-video-suite', now())
         ON CONFLICT (content_key) DO UPDATE SET value_jsonb = EXCLUDED.value_jsonb, revision = siton.site_content.revision + 1, published_at = now()`,
        [JSON.stringify({ blocks })]
      );
    } finally { await pool.end(); }
    const videoPort = 3397;
    servers.push(await startServer(videoPort, { LANDING_HERO_VIDEO_ENABLED: "1", LANDING_HERO_VIDEO_URL: dataUrl, LANDING_HERO_VIDEO_POSTER: "" }));
    page = await launchPage(`http://127.0.0.1:${videoPort}/preview/`);
    for (const viewport of [DESKTOP, MOBILE]) {
      await run(`@${viewport.width}: the video sits under the logo and before the title, muted/looping/inline, 16:9 reserved, no jump`, async () => {
        await page!.setViewport(viewport);
        page!.clearErrors();
        await page!.goto(`http://127.0.0.1:${videoPort}/preview/?v=${viewport.width}#/`, { waitMs: 300 });
        // the FIRST layout that shows the title must already carry the reserved slot
        let first: any = null;
        for (let i = 0; i < 60 && !first; i += 1) {
          first = await page!.evaluate<any>(`(() => { const h1 = document.querySelector('h1.landing-title'); if (!h1) return null; const s = document.querySelector('[data-testid="landing-intro-video"]'); const hr = h1.getBoundingClientRect(); if (!s) return { slot: false, h1Top: hr.top }; const r = s.getBoundingClientRect(); return { slot: true, w: r.width, h: r.height, top: r.top, h1Top: hr.top }; })()`);
          if (!first) await wait(25);
        }
        assert.ok(first, "the landing never rendered its title");
        assert.equal(first.slot, true, "the title rendered before the video slot existed — the slot would push it down later");
        for (let i = 0; i < 40 && !(await page!.evaluate<boolean>(`(() => { const v = document.querySelector('[data-testid="landing-intro-video"] video'); return !!v && !v.paused && v.readyState >= 2; })()`)); i += 1) await wait(150);
        const s = await page!.evaluate<any>(`(() => {
          const slot = document.querySelector('[data-testid="landing-intro-video"]'); const v = slot.querySelector('video');
          const logo = document.querySelector('.landing-logo').getBoundingClientRect(); const r = slot.getBoundingClientRect();
          const h1 = document.querySelector('h1.landing-title').getBoundingClientRect();
          return { playing: !!v && !v.paused, muted: v && v.muted, loop: v && v.loop, inline: v && v.playsInline, autoplay: v && v.autoplay, controls: v && v.controls,
                   w: r.width, h: r.height, top: r.top, h1Top: h1.top, belowLogo: r.top >= logo.bottom - 1, aboveTitle: r.bottom <= h1.top + 1, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        })()`);
        assert.equal(s.playing, true, "the muted video did not autoplay");
        assert.deepEqual([s.muted, s.loop, s.inline, s.autoplay, s.controls], [true, true, true, true, false]);
        assert.ok(Math.abs(s.h - s.w * 9 / 16) <= 2, `not 16:9: ${s.w}x${s.h}`);
        assert.equal(s.belowLogo, true, "the video is not under the logo");
        assert.equal(s.aboveTitle, true, "the video is not before the title");
        assert.ok(Math.abs(s.h - first.h) <= 1 && Math.abs(s.h1Top - first.h1Top) <= 1, `the layout jumped when the video started: ${JSON.stringify({ first, s })}`);
        assert.equal(s.overflow, false, "horizontal overflow");
        assert.deepEqual(appErrors(page!), [], "the video caused browser errors");
      });
    }
    console.log("LANDING_FAQ_VIDEO_BROWSER_PASS");
  } finally {
    await page?.close().catch(() => undefined);
    for (const s of servers) s.kill("SIGTERM");
  }
}

await main();
