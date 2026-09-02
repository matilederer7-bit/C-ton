#!/usr/bin/env node
// P0.6A — "📍 השתמש במיקום שלי" real-browser proof (headless Edge/Chrome via CDP).
//
// Drives the REAL seller create-wizard (step 3, pickup row) in a real Chromium
// and proves the bounded explicit-click geolocation flow end to end:
//   S1  granted + success            → captured on attempt 1 (normal accuracy), 1 call
//   S2  TIMEOUT → high-accuracy ok    → captured, exactly 2 calls, 2nd has enableHighAccuracy
//   S3  site denied (Permissions API) → honest unblock guidance, ZERO calls, recheck never loops
//   S4  OS denied (site granted, provider PERMISSION_DENIED) → device guidance, 1 call, no retry
//   S5  unavailable twice             → 2 calls, manual fallback auto-opens and completes the setup
//   S6  geolocation API missing       → unsupported, manual fallback available
//   S7  Permissions API missing       → request still runs and succeeds
//   S8  no stubs: CDP-emulated real navigator.geolocation (granted) → captured
//   S9  no stubs: CDP real permission denied → site-denied guidance
//
// Scenarios S1–S7 script navigator.geolocation / navigator.permissions through
// Page.addScriptToEvaluateOnNewDocument (the component under test is the real
// bundle; only the browser's provider is replaced). Nothing here touches money.
//
// Usage: node scripts/p06a_geolocation_browser_proof.cjs --base-url=http://127.0.0.1:3210 [--shots=dir]
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const zlib = require("node:zlib");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = (args["base-url"] || "").replace(/\/+$/, "");
const SHOTS = args.shots || "";
if (!BASE) { console.error("--base-url required"); process.exit(1); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/microsoft-edge", "/usr/bin/google-chrome"].find(existsSync);
if (!EDGE) { console.error("Edge/Chrome not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function run(name, fn) { try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; } }

// ── tiny valid PNG (8x8 orange) for the wizard's required image ─────────────
function makePng() {
  const w = 8, h = 8;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 0xec; raw[o + 1] = 0x66; raw[o + 2] = 0x08; } }
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-p06a-proof-${Date.now()}`);
  const port = 37_000 + Math.floor(Math.random() * 1000);
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
    async screenshot(file) { if (!SHOTS) return; const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64")); console.log(`SHOT ${join(SHOTS, file)}`); }
  };
}
async function waitFor(cdp, expr, timeoutMs = 20_000, label = "condition") { const deadline = Date.now() + timeoutMs; let last = null; while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(200); } throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`); }

const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;
const click = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
const exists = (selector) => `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
const text = (selector) => `(document.querySelector(${JSON.stringify(selector)})?.textContent || "")`;

// The provider stub. Reads its scenario from localStorage so ONE registered
// script serves every scenario; the page under test is the real bundle.
const STUB = `(() => {
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem("__p06a_geo_scenario") || "null"); } catch {}
  if (!cfg || !cfg.stub) return;
  const calls = [];
  window.__p06aCalls = calls;
  const outcomes = Array.isArray(cfg.outcomes) ? cfg.outcomes.slice() : [];
  if (cfg.removeApi) {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
  } else {
    const fake = {
      getCurrentPosition(ok, err, opts) {
        calls.push({ enableHighAccuracy: Boolean(opts && opts.enableHighAccuracy), timeout: opts && opts.timeout, maximumAge: opts && opts.maximumAge });
        const next = outcomes.shift();
        if (!next || next.hang) return;
        setTimeout(() => {
          if (next.ok) ok({ coords: { latitude: next.ok.lat, longitude: next.ok.lng, accuracy: next.ok.acc || 20 } });
          else err({ code: next.err.code, message: next.err.message || "" });
        }, 40);
      },
      watchPosition() { throw new Error("watchPosition must never be used"); },
      clearWatch() {}
    };
    Object.defineProperty(navigator, "geolocation", { value: fake, configurable: true });
  }
  if (cfg.permission === null) {
    Object.defineProperty(navigator, "permissions", { value: undefined, configurable: true });
  } else {
    const perms = { query: async (d) => (d && d.name === "geolocation" ? { state: cfg.permission } : { state: "prompt" }) };
    Object.defineProperty(navigator, "permissions", { value: perms, configurable: true });
  }
})();`;

async function main() {
  const png = makePng();
  const pngPath = join(tmpdir(), `p06a-${Date.now()}.png`);
  writeFileSync(pngPath, png);
  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl); await cdp.ready;
  let nav = 0;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
    // seed a client session so the seller area renders (demo-preview server ignores the token)
    await cdp.navigate(`${BASE}/preview/#/`);
    await waitFor(cdp, `document.readyState === "complete"`, 20_000, "shell");
    await cdp.evaluate(`localStorage.setItem("siton_session_v1", JSON.stringify({ access_token: "p06a-proof", refresh_token: "p06a-proof", expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: false } })); localStorage.removeItem("siton_guest_mode_v1"); true`);

    async function openPickupStep(scenario) {
      await cdp.evaluate(`localStorage.setItem("__p06a_geo_scenario", ${JSON.stringify(JSON.stringify(scenario))}); true`);
      nav += 1;
      await cdp.navigate(`${BASE}/preview/?p06a=${nav}#/seller/new`);
      await waitFor(cdp, exists('[data-testid="deal-title"]'), 20_000, "wizard step 1");
      await cdp.evaluate(setInput('[data-testid="deal-title"]', "בדיקת מיקום P0.6A"));
      await cdp.evaluate(setInput('[data-testid="deal-short"]', "הוכחת איתור מיקום"));
      await cdp.evaluate(setInput('[data-testid="deal-price"]', "10"));
      const doc = await cdp.send("DOM.getDocument", { depth: 1 });
      const input = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
      if (!input.nodeId) throw new Error("file input not found");
      await cdp.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [pngPath] });
      await waitFor(cdp, `document.querySelectorAll('.img-manager .img-card').length >= 1 || (document.querySelector('.img-manager .notice.err')?.textContent || "")`, 20_000, "image accepted");
      if (await cdp.evaluate(exists(".img-manager .notice.err"))) throw new Error(`image rejected: ${await cdp.evaluate(text(".img-manager .notice.err"))}`);
      await cdp.evaluate(click('[data-testid="wizard-next"]'));
      await waitFor(cdp, exists('[data-testid="deal-max"]'), 10_000, "wizard step 2");
      await cdp.evaluate(click('[data-testid="wizard-next"]'));
      await waitFor(cdp, exists('[data-testid="use-my-location"]'), 10_000, "pickup row with use-my-location");
    }
    const calls = () => cdp.evaluate(`JSON.stringify(window.__p06aCalls || [])`).then((s) => JSON.parse(s));
    const clickLocate = () => cdp.evaluate(click('[data-testid="use-my-location"]'));

    // ── S1 granted + success on attempt 1 ────────────────────────────────
    await run("S1 granted + success → captured on attempt 1 with normal accuracy (exactly 1 provider call)", async () => {
      await openPickupStep({ stub: true, permission: "granted", outcomes: [{ ok: { lat: 32.0668, lng: 34.7647 } }] });
      await clickLocate();
      const captured = await waitFor(cdp, text('[data-testid="geo-captured"]'), 10_000, "geo-captured");
      if (!captured.includes("32.0668") || !captured.includes("34.7647")) throw new Error(`captured text: ${captured}`);
      const c = await calls();
      if (c.length !== 1) throw new Error(`calls=${c.length}`);
      if (c[0].enableHighAccuracy !== false) throw new Error("attempt 1 must be normal accuracy");
      await cdp.screenshot("s1-captured.png");
    });

    // ── S2 TIMEOUT then high-accuracy success ────────────────────────────
    await run("S2 TIMEOUT on attempt 1 → one high-accuracy fallback → captured (exactly 2 calls)", async () => {
      await openPickupStep({ stub: true, permission: "granted", outcomes: [{ err: { code: 3, message: "Timeout expired" } }, { ok: { lat: 31.7683, lng: 35.2137 } }] });
      await clickLocate();
      const captured = await waitFor(cdp, text('[data-testid="geo-captured"]'), 10_000, "geo-captured");
      if (!captured.includes("31.7683")) throw new Error(`captured text: ${captured}`);
      const c = await calls();
      if (c.length !== 2) throw new Error(`calls=${c.length}`);
      if (c[0].enableHighAccuracy !== false || c[1].enableHighAccuracy !== true) throw new Error(`accuracy order wrong: ${JSON.stringify(c)}`);
    });

    // ── S3 site denied ───────────────────────────────────────────────────
    await run("S3 site denied (Permissions API) → unblock guidance, ZERO provider calls, recheck does not loop", async () => {
      await openPickupStep({ stub: true, permission: "denied", outcomes: [{ ok: { lat: 1, lng: 1 } }] });
      await clickLocate();
      await waitFor(cdp, exists('[data-testid="geo-denied"]'), 10_000, "geo-denied");
      const body = await cdp.evaluate(text('[data-testid="geo-denied"]'));
      if (!body.includes("חסומה לאתר הזה בדפדפן")) throw new Error(`copy: ${body.slice(0, 120)}`);
      if ((await calls()).length !== 0) throw new Error("provider must not be called when the site is denied");
      if (!(await cdp.evaluate(exists('[data-testid="geo-manual"]')))) throw new Error("manual fallback did not auto-open");
      if (!(await cdp.evaluate(exists('[data-testid="geo-recheck"]')))) throw new Error("recheck missing");
      const diag = await cdp.evaluate(text('[data-testid="geo-diag"]'));
      if (!/kind=site_denied/.test(diag)) throw new Error(`diag: ${diag}`);
      await cdp.evaluate(click('[data-testid="geo-recheck"]'));
      await wait(600);
      if ((await calls()).length !== 0) throw new Error("recheck must not call the provider while still denied");
      if (!(await cdp.evaluate(exists('[data-testid="geo-denied"]')))) throw new Error("denied state lost after recheck");
      await cdp.screenshot("s3-site-denied.png");
    });

    // ── S4 OS denied ─────────────────────────────────────────────────────
    await run("S4 OS denied (site granted, provider PERMISSION_DENIED) → device guidance, 1 call, NO retry", async () => {
      await openPickupStep({ stub: true, permission: "granted", outcomes: [{ err: { code: 1, message: "User denied Geolocation" } }, { ok: { lat: 1, lng: 1 } }] });
      await clickLocate();
      await waitFor(cdp, exists('[data-testid="geo-os-denied"]'), 10_000, "geo-os-denied");
      const body = await cdp.evaluate(text('[data-testid="geo-os-denied"]'));
      if (!body.includes("Windows") || !body.includes("המכשיר חוסם")) throw new Error(`copy: ${body.slice(0, 160)}`);
      const c = await calls();
      if (c.length !== 1) throw new Error(`calls=${c.length} (a denial must never be retried)`);
      const diag = await cdp.evaluate(text('[data-testid="geo-diag"]'));
      if (!/kind=os_denied/.test(diag) || !/permission=granted/.test(diag)) throw new Error(`diag: ${diag}`);
      await cdp.screenshot("s4-os-denied.png");
    });

    // ── S5 unavailable twice → manual completes the setup ────────────────
    await run("S5 unavailable twice → exactly 2 calls, manual fallback auto-opens and completes the pickup setup", async () => {
      await openPickupStep({ stub: true, permission: "granted", outcomes: [{ err: { code: 2, message: "Position unavailable" } }, { err: { code: 2, message: "Position unavailable" } }, { ok: { lat: 1, lng: 1 } }] });
      await clickLocate();
      await waitFor(cdp, exists('[data-testid="geo-unavailable"]'), 15_000, "geo-unavailable");
      const c = await calls();
      if (c.length !== 2) throw new Error(`calls=${c.length}`);
      if (!(await cdp.evaluate(exists('[data-testid="geo-retry"]')))) throw new Error("retry control missing");
      if (!(await cdp.evaluate(exists('[data-testid="geo-manual-lat"]')))) throw new Error("manual inputs not shown");
      await cdp.evaluate(setInput('[data-testid="geo-manual-lat"]', "32.08"));
      await cdp.evaluate(setInput('[data-testid="geo-manual-lng"]', "34.78"));
      await cdp.evaluate(click('[data-testid="geo-manual-apply"]'));
      const captured = await waitFor(cdp, text('[data-testid="geo-captured"]'), 5_000, "manual captured");
      if (!captured.includes("32.0800") || !captured.includes("34.7800")) throw new Error(`captured: ${captured}`);
      if ((await calls()).length !== 2) throw new Error("manual apply must not call the provider");
      await cdp.screenshot("s5-manual.png");
    });

    // ── S6 API missing ───────────────────────────────────────────────────
    await run("S6 geolocation API missing → unsupported message, manual fallback available", async () => {
      await openPickupStep({ stub: true, removeApi: true, permission: "granted", outcomes: [] });
      await clickLocate();
      await waitFor(cdp, exists('[data-testid="geo-unsupported"]'), 10_000, "geo-unsupported");
      if (!(await cdp.evaluate(exists('[data-testid="geo-manual-apply"]')))) throw new Error("manual fallback missing");
    });

    // ── S7 Permissions API missing ───────────────────────────────────────
    await run("S7 Permissions API missing → request still runs and succeeds", async () => {
      await openPickupStep({ stub: true, permission: null, outcomes: [{ ok: { lat: 29.5577, lng: 34.9519 } }] });
      await clickLocate();
      const captured = await waitFor(cdp, text('[data-testid="geo-captured"]'), 10_000, "geo-captured");
      if (!captured.includes("29.5577")) throw new Error(`captured: ${captured}`);
      if ((await calls()).length !== 1) throw new Error("expected exactly one call");
    });

    // ── S8 REAL navigator.geolocation, CDP-emulated position ─────────────
    await run("S8 real navigator.geolocation (CDP granted + emulated position) → captured", async () => {
      const origin = new URL(BASE).origin;
      await cdp.send("Browser.grantPermissions", { origin, permissions: ["geolocation"] });
      await cdp.send("Emulation.setGeolocationOverride", { latitude: 32.0853, longitude: 34.7818, accuracy: 30 });
      await openPickupStep({ stub: false });
      await clickLocate();
      const captured = await waitFor(cdp, text('[data-testid="geo-captured"]'), 15_000, "geo-captured");
      if (!captured.includes("32.0853") || !captured.includes("34.7818")) throw new Error(`captured: ${captured}`);
      const trace = await cdp.evaluate(`JSON.stringify(window.__sitonGeoTrace || [])`);
      if (!/attempt_done/.test(trace) || !/"result":"success"/.test(trace)) throw new Error(`trace: ${trace.slice(0, 200)}`);
      await cdp.screenshot("s8-real-granted.png");
    });

    // ── S9 REAL permission denied via CDP ────────────────────────────────
    await run("S9 real permission denied (CDP Browser.setPermission) → site-denied guidance, no crash", async () => {
      const origin = new URL(BASE).origin;
      await cdp.send("Emulation.clearGeolocationOverride");
      await cdp.send("Browser.setPermission", { origin, permission: { name: "geolocation" }, setting: "denied" });
      await openPickupStep({ stub: false });
      await clickLocate();
      await waitFor(cdp, exists('[data-testid="geo-denied"]'), 15_000, "geo-denied");
      const diag = await cdp.evaluate(text('[data-testid="geo-diag"]'));
      if (!/kind=site_denied/.test(diag)) throw new Error(`diag: ${diag}`);
      await cdp.screenshot("s9-real-denied.png");
    });
  } finally {
    cdp.close();
    browser.kill("SIGKILL");
  }
  console.log(`\nP06A_GEOLOCATION_BROWSER_PROOF passed=${passed} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
