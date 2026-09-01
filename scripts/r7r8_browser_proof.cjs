#!/usr/bin/env node
// R7/R8 hosted BROWSER proof (headless Edge CDP) against the LIVE staging
// preview. Proves that the migrated Supabase-Storage images actually RENDER in
// a real browser (Mall cards + Deal gallery, naturalWidth>0, CDN hosts), the
// gray+orange redesign is live, RTL holds with no horizontal overflow, and the
// admin control-center login screen renders (not a broken shell).
//
// Usage: node scripts/r7r8_browser_proof.cjs --base-url=https://... [--shots=dir]
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = (args["base-url"] || "").replace(/\/+$/, "");
const SHOTS = args.shots || "";
if (!BASE) { console.error("--base-url required"); process.exit(1); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
if (!EDGE) { console.error("Edge not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function run(name, fn) { try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; } }

async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-r7r8-proof-${Date.now()}`);
  const port = 35_000 + Math.floor(Math.random() * 1000);
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 80; i++) { try { const res = await fetch(`http://127.0.0.1:${port}/json/list`); const pages = await res.json(); const page = pages.find((p) => p.type === "page"); if (page?.webSocketDebuggerUrl) return { browser, wsUrl: page.webSocketDebuggerUrl }; } catch { /* retry */ } await wait(250); }
  browser.kill("SIGKILL"); throw new Error("CDP not available");
}
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  ws.addEventListener("message", (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ready = new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", () => reject(new Error("ws error"))); });
  return {
    ready, send, close: () => ws.close(),
    async navigate(url) { await send("Page.enable"); await send("Page.navigate", { url }); },
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate failed"); return res.result?.value; },
    async viewport(width, height, mobile = false) { await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }); },
    async screenshot(file) { if (!SHOTS) return; const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64")); console.log(`SHOT ${join(SHOTS, file)}`); }
  };
}
async function waitFor(cdp, expr, timeoutMs = 30_000, label = "condition") { const deadline = Date.now() + timeoutMs; let last = null; while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(300); } throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`); }

async function main() {
  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl); await cdp.ready;
  let dealHref = "";
  try {
    await cdp.viewport(1440, 900);
    await cdp.navigate(`${BASE}/preview/#/`);

    await run("Mall renders with Supabase-backed images that actually load", async () => {
      const snap = await waitFor(cdp, `(() => {
        const imgs = [...document.querySelectorAll('.card img')];
        if (!imgs.length) return null;
        const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0);
        const supa = imgs.filter(i => /supabase\\.co\\/storage\\/v1\\/object\\/public\\/deal-images/.test(i.currentSrc || i.src));
        if (!loaded.length) return null;
        const link = document.querySelector('.card a[href*="#/deal/"], a[href*="#/deal/"]');
        return { total: imgs.length, loaded: loaded.length, supabase: supa.length, href: link ? link.getAttribute('href') : '' };
      })()`, 30000, "mall images");
      dealHref = snap.href || "";
      if (snap.supabase < 1) throw new Error(`no supabase-hosted card images (loaded ${snap.loaded}/${snap.total})`);
      if (snap.loaded < 1) throw new Error("no card image rendered");
      console.log(`  mall: ${snap.loaded}/${snap.total} imgs rendered, ${snap.supabase} from Supabase CDN`);
    });

    await run("gray+orange design system is live (orange accent token applied)", async () => {
      const ok = await cdp.evaluate(`(() => {
        const root = getComputedStyle(document.documentElement);
        const brand = (root.getPropertyValue('--brand') || '').trim().toLowerCase();
        const bg = (root.getPropertyValue('--bg') || '').trim().toLowerCase();
        return { brand, bg };
      })()`);
      if (!/ec6608|#ec/.test(ok.brand)) throw new Error(`brand token not orange: ${ok.brand}`);
      console.log(`  --brand=${ok.brand} --bg=${ok.bg}`);
    });

    await run("no horizontal overflow at desktop 1440", async () => {
      const over = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
      if (!over) throw new Error("horizontal overflow at 1440");
    });
    await cdp.screenshot("mall-desktop.png");

    // Deal page gallery
    await run("Deal page gallery renders Supabase images", async () => {
      const href = dealHref || "#/deal/c74f06a4-80f7-525b-8e3c-b04515c08966";
      await cdp.navigate(`${BASE}/preview/${href.startsWith("#") ? "" : "#/"}${href.replace(/^#\//, "#/")}`);
      const snap = await waitFor(cdp, `(() => {
        const imgs = [...document.querySelectorAll('img')].filter(i => /supabase\\.co\\/storage/.test(i.currentSrc || i.src));
        const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0);
        if (!loaded.length) return null;
        return { supa: imgs.length, loaded: loaded.length };
      })()`, 30000, "deal gallery images");
      if (snap.loaded < 1) throw new Error("deal gallery image did not render");
      console.log(`  deal gallery: ${snap.loaded}/${snap.supa} Supabase imgs rendered`);
    });
    await cdp.screenshot("deal-desktop.png");

    // Mobile RTL no-overflow
    await run("mobile 390 RTL, no horizontal overflow", async () => {
      await cdp.viewport(390, 844, true);
      await cdp.navigate(`${BASE}/preview/#/`);
      const snap = await waitFor(cdp, `(() => { const c = document.querySelectorAll('.card'); if(!c.length) return null; return { dir: document.documentElement.dir, over: document.documentElement.scrollWidth <= window.innerWidth + 2 }; })()`, 30000, "mobile mall");
      if (snap.dir !== "rtl") throw new Error(`dir=${snap.dir}`);
      if (!snap.over) throw new Error("horizontal overflow at 390");
    });
    await cdp.screenshot("mall-mobile.png");

    // Admin login shell renders (not broken) — we do not authenticate here.
    await run("admin control-center login screen renders (not a broken shell)", async () => {
      await cdp.viewport(1440, 900);
      await cdp.navigate(`${BASE}/preview/#/admin`);
      const snap = await waitFor(cdp, `(() => {
        const panel = document.querySelector('.panel');
        const pw = document.querySelector('input[type=password]');
        const body = document.body.innerText || '';
        if (!panel) return null;
        return { hasPanel: !!panel, hasPassword: !!pw, mentionsAdmin: /ניהול|בקרה|מנהל/.test(body) };
      })()`, 30000, "admin login");
      if (!snap.hasPassword) throw new Error("no password field on admin login");
      if (!snap.mentionsAdmin) throw new Error("admin login text missing");
    });
    await cdp.screenshot("admin-login.png");

    console.log(`\nR7R8_BROWSER_PROOF ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
  } finally { cdp.close(); browser.kill("SIGKILL"); }
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error("PROOF_ERROR", e.message); process.exit(1); });
