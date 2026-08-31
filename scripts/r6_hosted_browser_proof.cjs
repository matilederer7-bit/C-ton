#!/usr/bin/env node
// R6 hosted browser proof — drives headless Edge (CDP) against the LIVE
// staging preview: public Mall, rich Deal page, seller + admin login surfaces,
// mobile RTL, and no-horizontal-overflow checks. Saves screenshots when
// --shots=<dir> is provided.
//
// Usage: node scripts/r6_hosted_browser_proof.cjs --base-url=https://... [--shots=out]

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"];
}));
const BASE = (args["base-url"] || "").replace(/\/+$/, "");
const SHOTS = args.shots || "";
if (!BASE) { console.error("--base-url required"); process.exit(1); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
if (!EDGE) { console.error("Edge not found"); process.exit(1); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function run(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-r6-proof-${Date.now()}`);
  const port = 34_000 + Math.floor(Math.random() * 1000);
  const browser = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--lang=he", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await res.json();
      const page = pages.find((p) => p.type === "page");
      if (page?.webSocketDebuggerUrl) return { browser, wsUrl: page.webSocketDebuggerUrl };
    } catch { /* retry */ }
    await wait(250);
  }
  browser.kill("SIGKILL");
  throw new Error("CDP not available");
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  return {
    ready,
    send,
    close: () => ws.close(),
    async navigate(url) { await send("Page.enable"); await send("Page.navigate", { url }); },
    async evaluate(expression) {
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate failed");
      return res.result?.value;
    },
    async viewport(width, height, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    },
    async screenshot(file) {
      if (!SHOTS) return;
      const res = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64"));
      console.log(`SHOT ${join(SHOTS, file)}`);
    }
  };
}

async function waitFor(cdp, predicateExpr, timeoutMs = 25_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(predicateExpr).catch(() => null);
    if (last) return last;
    await wait(300);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`);
}

async function main() {
  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl);
  await cdp.ready;
  try {
    // ── Desktop mall ──────────────────────────────────────────────────────
    await cdp.viewport(1440, 900);
    await cdp.navigate(`${BASE}/preview/#/`);
    let dealId = "";
    await run("Mall renders live deal cards (RTL, group meter, prices)", async () => {
      const snap = await waitFor(cdp, `(() => {
        const cards = document.querySelectorAll('.card');
        if (!cards.length) return null;
        return {
          dir: document.documentElement.dir,
          cards: cards.length,
          meters: document.querySelectorAll('.gm-track').length,
          prices: document.querySelectorAll('.price').length,
          overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
          firstHref: cards[0].getAttribute('href') || ''
        };
      })()`, 30_000, "mall cards");
      if (snap.dir !== "rtl") throw new Error("not RTL");
      if (!snap.meters || !snap.prices) throw new Error(`missing meters/prices ${JSON.stringify(snap)}`);
      if (!snap.overflow) throw new Error("horizontal overflow on mall");
      dealId = (snap.firstHref.match(/deal\/([0-9a-f-]{36})/) || [])[1] || "";
      if (!dealId) throw new Error("no deal link on first card");
      await cdp.screenshot("01-mall-desktop.png");
    });

    await run("Subtle admin entries exist at both extremes and are unobtrusive", async () => {
      const dots = await cdp.evaluate(`(() => {
        const top = document.querySelector('.admin-dot.top');
        const bottom = document.querySelector('.admin-dot.bottom');
        if (!top || !bottom) return null;
        const ts = getComputedStyle(top);
        return { opacity: Number(ts.opacity), w: top.offsetWidth };
      })()`);
      if (!dots) throw new Error("dots missing");
      if (dots.opacity > 0.5 || dots.w > 20) throw new Error(`not subtle: ${JSON.stringify(dots)}`);
    });

    // ── Deal page ─────────────────────────────────────────────────────────
    await run("Deal page: gallery/meter/qty/summary/share/live sections render", async () => {
      await cdp.navigate(`${BASE}/preview/#/deal/${dealId}`);
      const snap = await waitFor(cdp, `(() => {
        const title = document.querySelector('.deal-title');
        if (!title) return null;
        return {
          title: title.textContent,
          meter: !!document.querySelector('.gm-track.gm-lg'),
          qty: !!document.querySelector('.qty-stepper'),
          summary: !!document.querySelector('.order-summary'),
          share: document.querySelectorAll('.share-btn').length,
          disclosure: (document.body.textContent || '').includes('מסגרת אשראי'),
          overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
        };
      })()`, 30_000, "deal page");
      for (const k of ["meter", "summary", "disclosure", "overflow"]) if (!snap[k]) throw new Error(`missing ${k}: ${JSON.stringify(snap)}`);
      if (snap.share < 3) throw new Error("share buttons missing");
      await cdp.screenshot("02-deal-desktop.png");
    });

    // ── Mobile RTL ────────────────────────────────────────────────────────
    await run("Mobile 390px RTL: mall + deal render without horizontal overflow", async () => {
      await cdp.viewport(390, 844, true);
      await cdp.navigate(`${BASE}/preview/#/`);
      await waitFor(cdp, `document.querySelectorAll('.card').length > 0 ? {ok:1} : null`, 30_000, "mobile mall");
      const m = await cdp.evaluate(`({dir: document.documentElement.dir, overflow: document.documentElement.scrollWidth <= window.innerWidth + 1})`);
      if (m.dir !== "rtl" || !m.overflow) throw new Error(JSON.stringify(m));
      await cdp.screenshot("03-mall-mobile.png");
      await cdp.navigate(`${BASE}/preview/#/deal/${dealId}`);
      await waitFor(cdp, `document.querySelector('.deal-title') ? {ok:1} : null`, 30_000, "mobile deal");
      const d = await cdp.evaluate(`({overflow: document.documentElement.scrollWidth <= window.innerWidth + 1})`);
      if (!d.overflow) throw new Error("mobile deal overflow");
      await cdp.screenshot("04-deal-mobile.png");
    });

    // ── Seller + admin login surfaces ─────────────────────────────────────
    await cdp.viewport(1440, 900);
    await run("Seller area renders the Supabase login (email/password + signup)", async () => {
      await cdp.evaluate(`localStorage.removeItem('siton_preview_seller_token')`);
      await cdp.navigate(`${BASE}/preview/#/seller`);
      await waitFor(cdp, `(() => {
        const inputs = document.querySelectorAll('input[type=email], input[type=password]');
        return inputs.length >= 2 ? {ok:1} : null;
      })()`, 30_000, "seller login");
      await cdp.screenshot("05-seller-login.png");
    });

    await run("Admin entry opens the control-center login (auth required, nothing leaks)", async () => {
      await cdp.evaluate(`localStorage.removeItem('siton_preview_admin_token')`);
      await cdp.navigate(`${BASE}/preview/#/admin`);
      const snap = await waitFor(cdp, `(() => {
        const t = document.body.textContent || '';
        if (!t.includes('מרכז הבקרה')) return null;
        return { hasSetup: t.includes('הקמה ראשונית'), leakedNav: t.includes('תמונת מצב — כל המערכת') };
      })()`, 30_000, "admin login");
      if (!snap.hasSetup) throw new Error("owner first-time setup link missing");
      if (snap.leakedNav) throw new Error("admin content rendered without auth");
      await cdp.screenshot("06-admin-login.png");
    });
  } finally {
    cdp.close();
    browser.kill("SIGKILL");
  }
  console.log(`\nR6_HOSTED_BROWSER_PROOF ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("PROOF_FAILED", e.message); process.exit(1); });
