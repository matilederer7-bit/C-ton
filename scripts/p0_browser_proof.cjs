#!/usr/bin/env node
// P0 PRODUCT EXPERIENCE RESCUE — browser proof (headless Edge CDP).
//
// Proves, in a real browser at real phone widths (320/360/375/390/430) plus
// desktop:
//  * root renders the seller-first C-ton landing (Mall hidden, real logo asset)
//  * unknown routes fall back to the landing, never the Mall
//  * no horizontal overflow / no zoom-out needed on any tested surface
//  * the deal page reads in the phone decision order (identity→image→price→
//    progress→CTA)
//  * the Join flow OPENS, FILLS, and SUBMITS successfully from 320/360/390
//    (full-height sheet, sticky CTA reachable)
//  * exactly ONE copy-link control per share context
//  * /d/:dealId serves crawler-readable OG meta (fetched crawler-style)
//  * seller login + admin login shells render on mobile and desktop
//
// Usage: node scripts/p0_browser_proof.cjs --base-url=http://127.0.0.1:3210 [--shots=dir] [--deal=<uuid>] [--skip-join]
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = (args["base-url"] || "").replace(/\/+$/, "");
const SHOTS = args.shots || "";
const DEAL = args.deal || "d0000000-0000-0000-0000-000000000001";
const SKIP_JOIN = Boolean(args["skip-join"]);
const REQUIRE_IMAGES = Boolean(args["require-images"]); // hosted: the deal MUST render real CDN imagery
const JOIN_WIDTHS = (args["join-widths"] || "320,360,390").split(",").map(Number).filter(Boolean);
if (!BASE) { console.error("--base-url required"); process.exit(1); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/microsoft-edge", "/usr/bin/google-chrome"].find(existsSync);
if (!EDGE) { console.error("Edge/Chrome not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function run(name, fn) { try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; } }

async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-p0-proof-${Date.now()}`);
  const port = 36_000 + Math.floor(Math.random() * 1000);
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
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "evaluate failed"); return res.result?.value; },
    async viewport(width, height, mobile = false) { await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }); },
    async screenshot(file) { if (!SHOTS) return; const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64")); console.log(`SHOT ${join(SHOTS, file)}`); }
  };
}
async function waitFor(cdp, expr, timeoutMs = 30_000, label = "condition") { const deadline = Date.now() + timeoutMs; let last = null; while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(300); } throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`); }

const NO_OVERFLOW = `document.documentElement.scrollWidth <= window.innerWidth + 2`;
const MOBILE_WIDTHS = [320, 360, 375, 390, 430];

// React 18 controlled inputs ignore .value writes unless we go through the
// native setter and dispatch an input event.
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;
const clickCheckbox = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  if (!el.checked) el.click();
  return el.checked;
})()`;

async function main() {
  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl); await cdp.ready;
  try {
    // ── crawler-style OG proof (raw HTTP, no JS) ─────────────────────────
    await run("share route /d/:dealId serves crawler-readable OG meta", async () => {
      const res = await fetch(`${BASE}/d/${DEAL}?ref=P0TEST`, { headers: { "user-agent": "facebookexternalhit/1.1" }, redirect: "manual" });
      const html = await res.text();
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      for (const tag of ["og:title", "og:description", "og:url", "og:image", "twitter:card"]) {
        if (!html.includes(tag)) throw new Error(`missing ${tag}`);
      }
      const img = html.match(/property="og:image" content="([^"]+)"/)?.[1] || "";
      if (!/^https?:\/\//.test(img)) throw new Error(`og:image not absolute: ${img}`);
      console.log(`  og:image = ${img}`);
      if (!html.includes(`#/deal/${DEAL}`)) throw new Error("human redirect target missing");
      if (REQUIRE_IMAGES) {
        if (/\/brand\/c-ton-logo/.test(img)) throw new Error("og:image is the brand fallback, not the actual deal image");
        const head = await fetch(img, { method: "GET" });
        const type = head.headers.get("content-type") || "";
        if (!head.ok || !type.startsWith("image/")) throw new Error(`og:image fetch ${head.status} type=${type}`);
        console.log(`  og:image fetch: ${head.status} ${type}`);
      }
    });

    // ── root = seller-first landing, Mall hidden ─────────────────────────
    await cdp.viewport(1440, 900);
    await cdp.navigate(`${BASE}/preview/#/`);
    await run("root renders the C-ton landing with the real logo asset", async () => {
      const snap = await waitFor(cdp, `(() => {
        const landing = document.querySelector('.landing');
        if (!landing) return null;
        const logo = document.querySelector('.landing-logo');
        const mark = document.querySelector('.brand-mark-img');
        if (!logo || !logo.complete || logo.naturalWidth === 0) return null;
        if (!mark || !mark.complete || mark.naturalWidth === 0) return null;
        return {
          logoSrc: logo.currentSrc || logo.src,
          markSrc: mark.currentSrc || mark.src,
          bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
        };
      })()`, 30000, "landing with loaded logo + mark");
      if (!/\/brand\/c-ton-logo/.test(snap.logoSrc)) throw new Error(`hero logo is not the canonical asset: ${snap.logoSrc}`);
      if (!/\/brand\/c-ton-mark/.test(snap.markSrc)) throw new Error(`topbar mark is not the canonical asset: ${snap.markSrc}`);
      if (snap.bg !== "#17181b") throw new Error(`ground is not C-ton graphite: ${snap.bg}`);
    });
    await run("Mall is hidden: no mall copy, no mall nav, no deal grid on root", async () => {
      const snap = await cdp.evaluate(`(() => ({
        text: document.body.innerText,
        mallGrid: Boolean(document.querySelector('.grid .card')),
        navLinks: [...document.querySelectorAll('.nav-link')].map(a => a.textContent.trim())
      }))()`);
      if (snap.text.includes("המול") || snap.text.includes("קניון")) throw new Error("mall wording visible");
      if (snap.mallGrid) throw new Error("mall deal grid rendered on root");
      if (snap.navLinks.some((t) => /המול|קניון/.test(t))) throw new Error(`mall nav item present: ${snap.navLinks}`);
    });
    await run("brand name shows C-ton exactly (no Siton wording anywhere)", async () => {
      const snap = await cdp.evaluate(`(() => ({
        word: (document.querySelector('.brand-word') || {}).textContent || "",
        hasSiton: document.body.innerText.includes("סיטון")
      }))()`);
      if (snap.word.replace(/\s/g, "") !== "C-ton") throw new Error(`brand word = ${JSON.stringify(snap.word)}`);
      if (snap.hasSiton) throw new Error("legacy 'סיטון' wording still visible");
    });
    await run("unknown route falls back to the landing, not the Mall", async () => {
      await cdp.navigate(`${BASE}/preview/#/definitely-not-a-route`);
      const snap = await waitFor(cdp, `(() => document.querySelector('.landing') ? { landing: true, mall: Boolean(document.querySelector('.grid .card')) } : null)()`, 15000, "landing fallback");
      if (snap.mall) throw new Error("mall rendered for unknown route");
    });
    await cdp.screenshot("landing-desktop.png");

    // ── overflow sweep on landing at every phone width ───────────────────
    for (const w of MOBILE_WIDTHS) {
      await run(`landing ${w}px: RTL, no horizontal overflow`, async () => {
        await cdp.viewport(w, 780, true);
        await cdp.navigate(`${BASE}/preview/#/`);
        const snap = await waitFor(cdp, `(() => document.querySelector('.landing') ? { dir: document.documentElement.dir, ok: ${NO_OVERFLOW} } : null)()`, 15000, "landing");
        if (snap.dir !== "rtl") throw new Error(`dir=${snap.dir}`);
        if (!snap.ok) throw new Error("horizontal overflow");
      });
      if (w === 360) await cdp.screenshot("landing-360.png");
    }

    // ── deal page: phone decision order + overflow sweep ─────────────────
    for (const w of [...MOBILE_WIDTHS, 1440]) {
      await run(`deal ${w}px: loads, ordered hierarchy, no overflow`, async () => {
        await cdp.viewport(w, w === 1440 ? 900 : 800, w !== 1440);
        await cdp.navigate(`${BASE}/preview/#/deal/${DEAL}`);
        const snap = await waitFor(cdp, `(() => {
          const title = document.querySelector('.deal-title');
          const media = document.querySelector('.deal-area-media');
          const price = document.querySelector('.deal-price-hero');
          const meter = document.querySelector('.gm-track');
          const cta = document.querySelector('[data-testid=join-open]');
          if (!title || !media || !price || !meter) return null;
          const top = (el) => el ? el.getBoundingClientRect().top + window.scrollY : -1;
          return {
            ok: ${NO_OVERFLOW},
            order: [top(title), top(media), top(price), top(meter)],
            hasCta: Boolean(cta),
            zoom: window.visualViewport ? window.visualViewport.scale : 1
          };
        })()`, 30000, "deal page");
        if (!snap.ok) throw new Error("horizontal overflow");
        if (snap.zoom !== 1) throw new Error(`viewport scale ${snap.zoom}`);
        if (w < 861) {
          const [t, m, p, g] = snap.order;
          if (!(t < m && m < p && p <= g)) throw new Error(`mobile order broken: title=${t} media=${m} price=${p} meter=${g}`);
        }
        if (!snap.hasCta) throw new Error("join CTA missing");
      });
      if (w === 360 || w === 1440) await cdp.screenshot(`deal-${w}.png`);
    }

    if (REQUIRE_IMAGES) {
      await run("deal gallery renders REAL images (HTTP success, naturalWidth>0)", async () => {
        const snap = await waitFor(cdp, `(() => {
          const imgs = [...document.querySelectorAll('.deal-gallery img')];
          if (!imgs.length) return null;
          const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0);
          if (!loaded.length) return null;
          const fallback = document.querySelectorAll('.deal-gallery .img-fallback').length;
          return { total: imgs.length, loaded: loaded.length, fallback, src: (loaded[0].currentSrc || loaded[0].src) };
        })()`, 30000, "gallery images");
        if (snap.fallback > 0) throw new Error("gallery shows the error fallback");
        console.log(`  gallery: ${snap.loaded}/${snap.total} loaded; first = ${snap.src.slice(0, 90)}`);
      });
    }

    await run("deal share context has exactly ONE copy-link control", async () => {
      const snap = await cdp.evaluate(`(() => {
        const copies = [...document.querySelectorAll('[data-testid=share-copy]')];
        const legacy = document.querySelectorAll('.share-link-box').length;
        return { copies: copies.length, legacy, text: [...document.querySelectorAll('.share-actions')].length };
      })()`);
      if (snap.copies !== 1) throw new Error(`${snap.copies} copy controls on deal page`);
      if (snap.legacy !== 0) throw new Error("legacy share-link-box still rendered");
    });

    // ── the Join flow: COMPLETE submission from 320/360/390 ──────────────
    if (!SKIP_JOIN) {
      for (const w of JOIN_WIDTHS) {
        await run(`join ${w}px: full sheet opens, form fills, submits, success`, async () => {
          await cdp.viewport(w, 740, true);
          // cache-busting query forces a REAL navigation between widths (a
          // same-hash navigate would keep prior React state and modals alive)
          await cdp.navigate(`${BASE}/preview/?p0=${w}#/deal/${DEAL}`);
          await waitFor(cdp, `Boolean(document.querySelector('[data-testid=join-open]'))`, 30000, "join CTA");
          await cdp.evaluate(`document.querySelector('[data-testid=join-open]').click()`);
          const sheet = await waitFor(cdp, `(() => {
            const modal = document.querySelector('.modal');
            if (!modal) return null;
            const r = modal.getBoundingClientRect();
            const submit = document.querySelector('[data-testid=join-submit]');
            const sr = submit ? submit.getBoundingClientRect() : null;
            return {
              w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight,
              submitVisible: Boolean(sr && sr.bottom <= window.innerHeight + 1 && sr.top >= 0),
              ok: ${NO_OVERFLOW}
            };
          })()`, 15000, "join sheet");
          if (!sheet.ok) throw new Error("overflow with sheet open");
          if (sheet.w < sheet.vw - 2) throw new Error(`sheet width ${sheet.w} < viewport ${sheet.vw}`);
          if (sheet.h < sheet.vh * 0.9) throw new Error(`sheet height ${sheet.h} not full-height (vh=${sheet.vh})`);
          if (!sheet.submitVisible) throw new Error("sticky submit CTA not visible inside viewport");
          if (w === 360) await cdp.screenshot("join-sheet-360.png");
          const phone = `05${String(Date.now()).slice(-8)}`;
          if (!await cdp.evaluate(setInput("[data-testid=join-name]", `בדיקת P0 ${w}`))) throw new Error("name input missing");
          if (!await cdp.evaluate(setInput("[data-testid=join-phone]", phone))) throw new Error("phone input missing");
          // delivery-type deals require an address — fill it when the field exists
          await cdp.evaluate(setInput('input[autocomplete="street-address"]', "הרצל 1"));
          const cityDone = await cdp.evaluate(`(() => {
            const fields = [...document.querySelectorAll('.modal .field')];
            const city = fields.find(f => (f.querySelector('label') || {}).textContent === "עיר");
            const input = city ? city.querySelector('input') : null;
            if (!input) return true;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(input, "תל אביב");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          })()`);
          if (!cityDone) throw new Error("city fill failed");
          if (!await cdp.evaluate(clickCheckbox("[data-testid=join-disclosure]"))) throw new Error("disclosure checkbox unreachable");
          if (!await cdp.evaluate(clickCheckbox("[data-testid=join-terms]"))) throw new Error("terms checkbox unreachable");
          await cdp.evaluate(`document.querySelector('[data-testid=join-submit]').click()`);
          await waitFor(cdp, `Boolean(document.querySelector('[data-testid=join-success]'))`, 30000, "join success");
          const successCopy = await cdp.evaluate(`document.querySelectorAll('.modal [data-testid=share-copy]').length`);
          if (successCopy !== 1) throw new Error(`${successCopy} copy controls in success share context`);
          if (w === 360) await cdp.screenshot("join-success-360.png");
        });
      }
    }

    // ── seller + admin shells ────────────────────────────────────────────
    await run("seller login renders on mobile with C-ton branding", async () => {
      await cdp.viewport(360, 740, true);
      await cdp.navigate(`${BASE}/preview/#/seller`);
      const snap = await waitFor(cdp, `(() => {
        const pw = document.querySelector('input[type=password]');
        const mark = document.querySelector('.panel .brand-mark-img');
        if (!pw) return null;
        if (!mark || !mark.complete || mark.naturalWidth === 0) return null;
        return { ok: ${NO_OVERFLOW} };
      })()`, 20000, "seller login with loaded brand mark");
      if (!snap.ok) throw new Error("overflow");
    });
    await cdp.screenshot("seller-login-360.png");
    await run("seller signup entry (?signup=1) opens in signup mode", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller?signup=1`);
      await waitFor(cdp, `document.body.innerText.includes("יצירת חשבון")`, 15000, "signup mode");
    });
    await run("admin login shell renders (desktop)", async () => {
      await cdp.viewport(1440, 900);
      await cdp.navigate(`${BASE}/preview/#/admin`);
      const snap = await waitFor(cdp, `(() => {
        const pw = document.querySelector('input[type=password]');
        if (!pw) return null;
        return { text: document.body.innerText.slice(0, 400), ok: ${NO_OVERFLOW} };
      })()`, 20000, "admin login");
      if (!snap.text.includes("C-ton")) throw new Error("admin login not branded C-ton");
      if (!snap.ok) throw new Error("overflow");
    });
    await cdp.screenshot("admin-login-desktop.png");
  } finally {
    cdp.close();
    browser.kill("SIGKILL");
  }
  console.log(`\nP0 BROWSER PROOF: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
