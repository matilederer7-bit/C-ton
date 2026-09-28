// ── HOME "HOW IT WORKS" INFOGRAPHIC, IN A REAL BROWSER ──────────────────────
//
// Owner task 2026-09-28: the home page explains the service with an
// infographic instead of a wall of text — two tracks (buyers / sellers), four
// numbered steps each on one connector line, a summary line each — built as a
// real UI component whose words AND icons the admin edits in the content
// editor (icons are picked from a whitelist by key, never typed as markup).
//
// Proven here end to end against the real server, the real database and the
// real React bundle:
//   * the public landing (desktop + mobile): the section sits right after the
//     hero, in RTL, with the exact default words in the right order, numbers
//     1–4, one icon per step, the two summary lines with DIFFERENT icons, the
//     connector line, no seller sign-up button inside it, no old "steps"
//     section, no horizontal overflow, no browser errors;
//   * the admin editor: the block is fixed (no remove / hide), a word is
//     changed, an icon is picked from the list (the preview follows), the page
//     is published — and the public landing shows both changes, also after a
//     reload.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { chromiumPath, launchPage, type BrowserPage } from "./helpers/browser_cdp.js";
import { HOW_IT_WORKS_HE } from "../web/src/content/howItWorks.he.js";
import { issueAdminSession } from "../src/admin_identity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DESKTOP = { width: 1366, height: 800 };
const MOBILE = { width: 390, height: 844 };
const PORT = 3397;
const BASE = `http://127.0.0.1:${PORT}/preview/`;
const NEW_WORD = "בוחרים כמות ומשלוח מהיר";
const NEW_ICON = "truck";

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function startServer(port: number) {
  const server = spawn(process.execPath, [compiledAppPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DISABLE_OUTBOX_WORKER: "1", APP_DEPLOYMENT_MODE: "demo-preview", RATE_LIMIT_MAX: "5000", RATE_LIMIT_SENSITIVE_MAX: "500" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return server; } catch { /* booting */ }
    await wait(500);
  }
  server.kill("SIGTERM");
  throw new Error("server did not become healthy");
}

// the external font stylesheet is not reachable from every sandbox; that is not an app error
const appErrors = (page: BrowserPage) =>
  page.errors().filter((e) => !/favicon/.test(e.text) && !(e.kind === "request" && /^Stylesheet /.test(e.text)));

async function waitFor<T>(page: BrowserPage, expression: string, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await page.evaluate<T>(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await wait(100);
  }
}

// what the infographic shows, read straight from the DOM
const SNAPSHOT = `(() => {
  const s = document.querySelector('[data-testid="landing-block-how"]');
  if (!s) return null;
  const track = (a) => ({
    title: s.querySelector('[data-testid="hiw-track-title-' + a + '"]').textContent.trim(),
    steps: [...s.querySelectorAll('[data-testid^="hiw-step-' + a + '-"]')].map(li => ({
      n: li.getAttribute('data-step'), num: li.querySelector('.hiw-num').textContent.trim(), text: li.querySelector('.hiw-text').textContent.trim(),
      icon: li.getAttribute('data-icon'), svgIcon: li.querySelector('svg').getAttribute('data-icon'), left: Math.round(li.getBoundingClientRect().left), top: Math.round(li.getBoundingClientRect().top)
    })),
    summary: { text: s.querySelector('[data-testid="hiw-summary-' + a + '"] span:last-child').textContent.trim(), icon: s.querySelector('[data-testid="hiw-summary-' + a + '"]').getAttribute('data-icon') },
    line: (() => { const cs = getComputedStyle(s.querySelector('[data-testid="hiw-steps-' + a + '"]'), '::before'); return { position: cs.position, height: cs.height }; })()
  });
  const r = s.getBoundingClientRect();
  const hero = document.querySelector('[data-testid="landing-block-hero"]');
  return {
    dir: getComputedStyle(s).direction, title: s.querySelector('h2').textContent.trim(),
    afterHero: !!hero && s.previousElementSibling === hero, width: Math.round(r.width), visible: r.height > 0,
    buttons: s.querySelectorAll('button, a').length, svgs: s.querySelectorAll('svg').length,
    oldSteps: document.querySelectorAll('[data-block-type="steps"]').length,
    oldColumns: document.querySelectorAll('[data-block-type="columns"], [data-testid="landing-block-audiences"]').length,
    nextBlock: s.nextElementSibling ? s.nextElementSibling.getAttribute('data-testid') : null,
    blocks: [...document.querySelectorAll('[data-testid^="landing-block-"]')].map(e => e.getAttribute('data-testid').replace('landing-block-', '')),
    sellerButtonsOutside: [...document.querySelectorAll('button')].filter(b => !s.contains(b) && /פתיחת חשבון מוכר/.test(b.textContent)).length,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    buyers: track('buyers'), sellers: track('sellers')
  };
})()`;

function assertDefaultContent(snap: any, viewport: { width: number }) {
  assert.equal(snap.dir, "rtl");
  assert.equal(snap.title, HOW_IT_WORKS_HE.title);
  assert.equal(snap.afterHero, true, "the infographic is not right after the hero");
  assert.equal(snap.visible, true);
  assert.equal(snap.oldSteps, 0, "the former text steps section is still on the page");
  assert.equal(snap.oldColumns, 0, "the former buyers/sellers columns block must be gone (the infographic replaces it, no duplicate explanation)");
  assert.deepEqual(snap.blocks, ["hero", "how", "trust", "faq", "contact"], "the home flow: hero → infographic → trust → FAQ → contact");
  assert.equal(snap.nextBlock, "landing-block-trust", "the infographic takes the columns block's place, before the trust section");
  assert.equal(snap.buttons, 0, "no button or link belongs inside the infographic (the seller sign-up button lives elsewhere)");
  assert.ok(snap.sellerButtonsOutside >= 1, "the seller sign-up button must still exist elsewhere on the page");
  assert.equal(snap.svgs, 10, "8 step icons + 2 summary icons");
  assert.equal(snap.overflow, false, `horizontal overflow @${viewport.width}`);
  for (const audience of ["buyers", "sellers"] as const) {
    const expected = HOW_IT_WORKS_HE[audience];
    const t = snap[audience];
    assert.equal(t.title, expected.title);
    assert.deepEqual(t.steps.map((s: any) => s.n), ["1", "2", "3", "4"]);
    assert.deepEqual(t.steps.map((s: any) => s.num), ["1", "2", "3", "4"], "the numbers 1–4 are shown");
    assert.deepEqual(t.steps.map((s: any) => s.text), expected.steps.map((s) => s.text), `${audience} steps, in order`);
    assert.deepEqual(t.steps.map((s: any) => s.icon), expected.steps.map((s) => s.icon));
    assert.deepEqual(t.steps.map((s: any) => s.svgIcon), expected.steps.map((s) => s.icon), "each step draws the glyph of its key");
    assert.equal(t.summary.text, expected.summary.text);
    assert.equal(t.summary.icon, expected.summary.icon);
    // RTL: step 1 is the right-most, the four steps sit on one row, joined by the connector line
    const lefts = t.steps.map((s: any) => s.left);
    for (let i = 1; i < lefts.length; i += 1) assert.ok(lefts[i] < lefts[i - 1], `${audience}: steps must run right-to-left: ${lefts.join(",")}`);
    assert.ok(Math.max(...t.steps.map((s: any) => s.top)) - Math.min(...t.steps.map((s: any) => s.top)) <= 2, `${audience}: the four steps are not on one row`);
    assert.equal(t.line.position, "absolute"); assert.equal(t.line.height, "3px");
  }
  assert.notEqual(snap.buyers.summary.icon, snap.sellers.summary.icon, "the two summary icons must differ");
  assert.ok(snap.buyers.steps.some((s: any) => s.text === "בוחרים כמות ומשלוח"));
  assert.ok(snap.sellers.steps.some((s: any) => s.text === "מגדירים כמות ותאריך"));
  assert.ok(!snap.sellers.steps.some((s: any) => /יעד ומועד/.test(s.text)));
}

// React controlled inputs: set through the prototype setter so React sees the change
const setInput = (selector: string, value: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return el.value === ${JSON.stringify(value)};
})()`;

async function main() {
  if (!chromiumPath()) {
    if (process.env.CI) throw new Error("no Chromium available — the how-it-works browser gate cannot be skipped in CI");
    console.log("HOW_IT_WORKS_BROWSER SKIP — no Chromium available");
    return;
  }
  if (!existsSync(join(repoRoot, "web", "dist", "index.html"))) throw new Error("web/dist is missing — run `npm run --prefix web build` first");

  const servers: ChildProcess[] = [];
  let page: BrowserPage | null = null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    servers.push(await startServer(PORT));
    page = await launchPage(`${BASE}#/`);

    // ── 1. the public landing, nothing ever saved through the editor ────────
    assert.equal((await pool.query(`SELECT 1 FROM siton.site_content WHERE content_key='home'`)).rowCount, 0, "precondition: no stored home page");
    for (const viewport of [DESKTOP, MOBILE]) {
      await run(`@${viewport.width}: the infographic renders the canonical content after the hero, RTL, numbered, iconed, no overflow`, async () => {
        await page!.setViewport(viewport);
        page!.clearErrors();
        await page!.goto(`${BASE}?v=${viewport.width}#/`, { waitMs: 400 });
        const snap = await waitFor<any>(page!, `(() => { const s = ${SNAPSHOT}; return s && s.visible ? s : null; })()`, 15_000, "the infographic");
        assertDefaultContent(snap, viewport);
        assert.deepEqual(appErrors(page!), [], "browser errors on the landing");
      });
    }

    // ── 2. the admin edits a word and picks an icon; publish; the site shows both ──
    const admin = (await pool.query(`INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled) VALUES($1,'HIW Browser Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id`, [`hiw-browser-${randomUUID()}@example.invalid`])).rows[0];
    const session = await issueAdminSession(pool as any, admin.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true);
    await run("the content editor shows the fixed infographic block with its words and icon pickers", async () => {
      await page!.setViewport(DESKTOP);
      page!.clearErrors();
      await page!.goto(`${BASE}#/`, { waitMs: 300 });
      // the same local demo-preview session recipe scripts/authenticated_ui_acceptance.cjs uses for its dry-fit:
      // the admin cookie carries the server authority; the client marker only lets the admin shell render
      await page!.evaluate(`(() => {
        document.cookie = 'siton_admin_session=${session.token}; path=/; SameSite=Lax';
        localStorage.setItem('siton_session_v1', JSON.stringify({ access_token: 'local-dryfit-demo-session', refresh_token: '', expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: true } }));
        sessionStorage.setItem('siton_admin_unlock_v1', JSON.stringify({ until: Date.now() + 30*60000 }));
        localStorage.removeItem('siton_guest_mode_v1');
        return true;
      })()`);
      await page!.goto(`${BASE}#/admin/content`, { waitMs: 600 });
      await waitFor(page!, `Boolean(document.querySelector('[data-testid="cms-block-how"]') && document.querySelector('[data-testid="cms-field-how-buyer_step_2"]'))`, 30_000, "the how-it-works block in the editor");
      const editor = await page!.evaluate<any>(`(() => {
        const b = document.querySelector('[data-testid="cms-block-how"]');
        const sel = document.querySelector('[data-testid="cms-field-how-buyer_icon_2"]');
        return { type: b.getAttribute('data-block-type'), position: b.getAttribute('data-position'), fixed: b.querySelectorAll('.cms-chip').length > 0,
          remove: !!document.querySelector('[data-testid="cms-block-remove-how"]'), hide: !!document.querySelector('[data-testid="cms-block-enabled-how"]'),
          word: document.querySelector('[data-testid="cms-field-how-buyer_step_2"]').value, icon: sel.value, options: [...sel.options].map(o => o.value),
          preview: document.querySelector('[data-testid="cms-field-how-buyer_icon_2-icon"]').getAttribute('data-icon'),
          textInputs: b.querySelectorAll('input[type="text"]').length, iconSelects: b.querySelectorAll('select').length };
      })()`);
      assert.equal(editor.type, "how_it_works"); assert.equal(editor.position, "1");
      assert.equal(editor.fixed, true, "the block is marked fixed"); assert.equal(editor.remove, false, "a fixed block has no remove button"); assert.equal(editor.hide, false, "a fixed block cannot be hidden");
      assert.equal(editor.word, "בוחרים כמות ומשלוח"); assert.equal(editor.icon, "cart"); assert.equal(editor.preview, "cart");
      assert.ok(editor.options.includes(NEW_ICON) && !editor.options.includes("evil"), "the icon list is the whitelist");
      assert.equal(editor.textInputs, 13, "title + 2 track titles + 8 steps + 2 summaries");
      assert.equal(editor.iconSelects, 10, "8 step icons + 2 summary icons");
    });
    await run("changing a word and picking an icon, then publishing, updates the public landing (also after a reload)", async () => {
      assert.equal(await page!.evaluate<boolean>(setInput('[data-testid="cms-field-how-buyer_step_2"]', NEW_WORD)), true, "could not type the new word");
      assert.equal(await page!.evaluate<boolean>(setInput('[data-testid="cms-field-how-buyer_icon_2"]', NEW_ICON)), true, "could not pick the icon");
      await wait(150);
      const picked = await page!.evaluate<any>(`({ preview: document.querySelector('[data-testid="cms-field-how-buyer_icon_2-icon"]').getAttribute('data-icon'), glyph: document.querySelector('[data-testid="cms-field-how-buyer_icon_2-icon"] svg').getAttribute('data-icon'), dirty: document.querySelector('[data-testid="cms-status"]').getAttribute('data-dirty') })`);
      assert.deepEqual(picked, { preview: NEW_ICON, glyph: NEW_ICON, dirty: "1" }, "the icon preview did not follow the choice");
      await page!.evaluate(`document.querySelector('[data-testid="cms-publish"]').click()`);
      await waitFor(page!, `(() => { const s = document.querySelector('[data-testid="cms-status"]'); const m = document.querySelector('[data-testid="cms-message"]'); return s && s.getAttribute('data-dirty') === '0' && s.getAttribute('data-has-draft') === '0' && m && m.classList.contains('ok'); })()`, 30_000, "publish to finish");
      assert.deepEqual(appErrors(page!), [], "browser errors in the editor");
      // the database now holds the published words and the icon KEY (never markup)
      const stored = (await pool.query(`SELECT value_jsonb FROM siton.site_content WHERE content_key='home'`)).rows[0]!.value_jsonb;
      const how = stored.blocks.find((b: any) => b.id === "how");
      assert.equal(how.fields.buyer_step_2, NEW_WORD); assert.equal(how.fields.buyer_icon_2, NEW_ICON);

      for (const viewport of [DESKTOP, MOBILE]) {
        await page!.setViewport(viewport);
        page!.clearErrors();
        await page!.goto(`${BASE}?after=${viewport.width}#/`, { waitMs: 400 });
        const snap = await waitFor<any>(page!, `(() => { const s = ${SNAPSHOT}; return s && s.buyers.steps[1] && s.buyers.steps[1].text === ${JSON.stringify(NEW_WORD)} ? s : null; })()`, 15_000, `the published word on the landing @${viewport.width}`);
        assert.equal(snap.buyers.steps[1].icon, NEW_ICON); assert.equal(snap.buyers.steps[1].svgIcon, NEW_ICON, "the new glyph is drawn");
        assert.deepEqual(snap.buyers.steps.map((s: any) => s.text), [HOW_IT_WORKS_HE.buyers.steps[0]!.text, NEW_WORD, HOW_IT_WORKS_HE.buyers.steps[2]!.text, HOW_IT_WORKS_HE.buyers.steps[3]!.text]);
        assert.deepEqual(snap.sellers.steps.map((s: any) => s.text), HOW_IT_WORKS_HE.sellers.steps.map((s) => s.text), "untouched words stay");
        assert.equal(snap.overflow, false);
        await page!.reload({ waitMs: 400 });
        const again = await waitFor<any>(page!, `(() => { const s = ${SNAPSHOT}; return s && s.buyers.steps[1] && s.buyers.steps[1].text === ${JSON.stringify(NEW_WORD)} ? s : null; })()`, 15_000, "the published word after a reload");
        assert.equal(again.buyers.steps[1].icon, NEW_ICON);
        assert.deepEqual(appErrors(page!), []);
      }
    });
    // ── 3. icons are structural: the English content view edits the same icon, and publishing from it works ──
    await run("in the English content view the icon picker shows the canonical choice; picking there publishes (Codex P2 on #121)", async () => {
      await page!.setViewport(DESKTOP);
      page!.clearErrors();
      await page!.goto(`${BASE}#/admin/content`, { waitMs: 600 });
      await waitFor(page!, `Boolean(document.querySelector('[data-testid="cms-field-how-buyer_icon_2"]'))`, 30_000, "the editor again");
      await page!.evaluate(`document.querySelector('[data-testid="cms-content-locale-en"]').click()`); await wait(200);
      const en = await page!.evaluate<any>(`({ locale: document.querySelector('[data-testid="cms-content-locale"]').getAttribute('data-locale'), icon: document.querySelector('[data-testid="cms-field-how-buyer_icon_2"]').value, preview: document.querySelector('[data-testid="cms-field-how-buyer_icon_2-icon"]').getAttribute('data-icon'), fallbackNote: !!document.querySelector('[data-testid="cms-field-how-buyer_icon_2-fallback"]') })`);
      assert.deepEqual(en, { locale: "en", icon: NEW_ICON, preview: NEW_ICON, fallbackNote: false }, "the English view must show the canonical icon, not a blank");
      assert.equal(await page!.evaluate<boolean>(setInput('[data-testid="cms-field-how-sellers_summary_icon"]', "bell")), true);
      await wait(150);
      await page!.evaluate(`document.querySelector('[data-testid="cms-publish"]').click()`);
      await waitFor(page!, `(() => { const s = document.querySelector('[data-testid="cms-status"]'); const m = document.querySelector('[data-testid="cms-message"]'); return s && s.getAttribute('data-dirty') === '0' && s.getAttribute('data-has-draft') === '0' && m && m.classList.contains('ok'); })()`, 30_000, "publish from the English view to finish");
      const stored = (await pool.query(`SELECT value_jsonb FROM siton.site_content WHERE content_key='home'`)).rows[0]!.value_jsonb;
      const how = stored.blocks.find((b: any) => b.id === "how");
      assert.equal(how.fields.sellers_summary_icon, "bell", "the icon picked in the English view is stored in the canonical fields");
      assert.equal(how.fields_en?.sellers_summary_icon, undefined, "no icon is ever stored on the English side");
      await page!.goto(`${BASE}?en-edit=1#/`, { waitMs: 400 });
      const snap = await waitFor<any>(page!, `(() => { const s = ${SNAPSHOT}; return s && s.sellers.summary.icon === "bell" ? s : null; })()`, 15_000, "the new seller summary icon on the landing");
      assert.equal(snap.buyers.steps[1].icon, NEW_ICON);
      assert.deepEqual(appErrors(page!), []);
    });
    // ── 4. a draft saved before the infographic publishes from the editor as shown (Codex P2 on #121) ──
    await run("a draft stored under the old home contract publishes from the editor without an edit, exactly as shown", async () => {
      const current = (await pool.query(`SELECT value_jsonb FROM siton.site_content WHERE content_key='home'`)).rows[0]!.value_jsonb;
      const legacy = JSON.parse(JSON.stringify(current));
      legacy.blocks = legacy.blocks.map((b: any) => b.id === "how"
        ? { id: "how", type: "steps", enabled: true, fields: { title: "איך זה עובד" }, items: [{ title: "שלב ישן", body: "גוף ישן" }] }
        : b);
      legacy.blocks.splice(2, 0, { id: "audiences", type: "columns", enabled: true, fields: { title: "" }, items: [{ title: "לקונים", body: "טקסט ישן", cta_label: "", cta_link: "" }] });
      await pool.query(`UPDATE siton.site_content SET draft_jsonb=$1::jsonb, draft_updated_at=now() WHERE content_key='home'`, [JSON.stringify(legacy)]);
      await page!.setViewport(DESKTOP);
      page!.clearErrors();
      await page!.goto(`${BASE}?legacy-draft=1#/admin/content`, { waitMs: 600 });
      await waitFor(page!, `(() => { const s = document.querySelector('[data-testid="cms-status"]'); return s && s.getAttribute('data-has-draft') === '1' && document.querySelector('[data-testid="cms-block-how"]') && document.querySelector('[data-testid="cms-block-how"]').getAttribute('data-block-type') === 'how_it_works'; })()`, 30_000, "the editor showing the migrated draft");
      assert.equal(await page!.evaluate<boolean>(`!document.querySelector('[data-testid="cms-block-audiences"]')`), true, "the retired block is not shown in the editor");
      assert.equal(await page!.evaluate<string>(`document.querySelector('[data-testid="cms-status"]').getAttribute('data-dirty')`), "0", "the editor is not dirty — this is the case Codex described");
      await page!.evaluate(`document.querySelector('[data-testid="cms-publish"]').click()`);
      await waitFor(page!, `(() => { const s = document.querySelector('[data-testid="cms-status"]'); const m = document.querySelector('[data-testid="cms-message"]'); return s && s.getAttribute('data-has-draft') === '0' && m && (m.classList.contains('ok') || m.classList.contains('err')) ? true : null; })()`, 30_000, "publish of the migrated draft to finish");
      const message = await page!.evaluate<any>(`({ ok: document.querySelector('[data-testid="cms-message"]').classList.contains('ok'), text: document.querySelector('[data-testid="cms-message"]').textContent })`);
      assert.equal(message.ok, true, `publishing the migrated draft failed: ${message.text}`);
      const stored = (await pool.query(`SELECT value_jsonb, draft_jsonb FROM siton.site_content WHERE content_key='home'`)).rows[0]!;
      assert.equal(stored.draft_jsonb, null);
      // the stored page keeps its hidden blocks too; it must equal the page before the old draft, without `audiences`
      assert.deepEqual(stored.value_jsonb.blocks.map((b: any) => b.id), current.blocks.map((b: any) => b.id));
      assert.ok(!stored.value_jsonb.blocks.some((b: any) => b.id === "audiences"), "the retired block was published");
      assert.equal(stored.value_jsonb.blocks[1].type, "how_it_works");
      assert.deepEqual(appErrors(page!), []);
    });
    console.log("HOW_IT_WORKS_BROWSER_PASS");
  } finally {
    await page?.close().catch(() => undefined);
    for (const s of servers) s.kill("SIGTERM");
    await pool.end().catch(() => undefined);
  }
}

await main();
