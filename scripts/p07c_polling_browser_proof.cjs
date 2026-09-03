#!/usr/bin/env node
// P0.7C — real-browser measurement of public Deal page polling (headless Edge via CDP).
//
//   S1  one tab for 60s: counts every /api/deals/* request, none may be 429; cadence must be bounded
//   S2  two tabs from the same IP for 60s: zero 429 responses across both
//   S3  hidden tab for 30s: (near) zero requests while hidden
//   S4  tab returns visible: a refresh request within 3s, then bounded cadence resumes
//   S5  Draft buyer preview (optional --draft + seller credentials): zero activity/chat polling
//
// Usage: node scripts/p07c_polling_browser_proof.cjs --base-url=https://host --deal=<uuid> [--draft=<uuid> --seller-id=.. --seller-password=..] [--window=60000]
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = (args["base-url"] || "").replace(/\/+$/, "");
const DEAL = String(args.deal || "").trim();
const WINDOW = Number(args.window || 60_000);
if (!BASE || !DEAL) { console.error("--base-url and --deal are required"); process.exit(1); }
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/microsoft-edge", "/usr/bin/google-chrome"].find(existsSync);
if (!EDGE) { console.error("Edge/Chrome not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const findings = {};
async function run(name, fn) { try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; } }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-p07c-${Date.now()}`);
  const port = 39_000 + Math.floor(Math.random() * 1000);
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", "--window-size=1280,900", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 80; i++) { try { const res = await fetch(`http://127.0.0.1:${port}/json/version`); const v = await res.json(); if (v.webSocketDebuggerUrl) return { browser, port, browserWs: v.webSocketDebuggerUrl }; } catch { /* retry */ } await wait(250); }
  browser.kill("SIGKILL"); throw new Error("CDP not available");
}
function session(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener("message", (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } else if (msg.method) { for (const l of listeners) l(msg); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ready = new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", () => reject(new Error("ws error"))); });
  return {
    ready, send, on: (fn) => listeners.push(fn), close: () => ws.close(),
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate failed"); return res.result?.value; }
  };
}
async function newTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const page = await res.json();
  const s = session(page.webSocketDebuggerUrl); await s.ready;
  await s.send("Page.enable"); await s.send("Network.enable");
  const requests = []; // { url, at, status }
  const byId = new Map();
  s.on((msg) => {
    if (msg.method === "Network.requestWillBeSent") { const r = msg.params.request; if (/\/api\//.test(r.url)) { const rec = { url: r.url.replace(BASE, ""), method: r.method, at: Date.now(), status: null }; byId.set(msg.params.requestId, rec); requests.push(rec); } }
    if (msg.method === "Network.responseReceived") { const rec = byId.get(msg.params.requestId); if (rec) rec.status = msg.params.response.status; }
  });
  return { s, requests, id: page.id };
}
const isDealRead = (r) => r.method === "GET" && /^\/api\/deals\//.test(r.url);
const summarize = (reqs, since = 0) => {
  const win = reqs.filter((r) => r.at >= since);
  const reads = win.filter(isDealRead);
  const s429 = win.filter((r) => r.status === 429);
  const byPath = {};
  for (const r of reads) { const key = r.url.replace(/[0-9a-f-]{36}/g, ":id").replace(/\?.*$/, ""); byPath[key] = (byPath[key] || 0) + 1; }
  return { total_api: win.length, deal_reads: reads.length, by_path: byPath, status_429: s429.length, sample_429: s429.slice(0, 3).map((r) => r.url) };
};

async function main() {
  const { browser, port } = await openBrowser();
  try {
    await run(`S1 one tab, ${WINDOW / 1000}s: bounded deal-read cadence, zero 429`, async () => {
      const tab = await newTab(port);
      await tab.s.send("Page.navigate", { url: `${BASE}/preview/?p07c=1#/deal/${DEAL}` });
      const t0 = Date.now();
      await wait(WINDOW);
      const sum = summarize(tab.requests, t0);
      findings.one_tab = sum;
      assert(sum.status_429 === 0, `429s seen: ${JSON.stringify(sum.sample_429)}`);
      const perMinute = sum.deal_reads * (60_000 / WINDOW);
      assert(perMinute <= 10, `deal reads per minute too high: ${perMinute}`);
      assert((sum.by_path["/api/deals/:id/activity"] || 0) >= 2, "activity polling alive");
      findings.one_tab_reads_per_minute = Math.round(perMinute * 10) / 10;
      await tab.s.send("Page.navigate", { url: "about:blank" });
      tab.s.close();
    });

    await run(`S2 two tabs from one IP, ${WINDOW / 1000}s: zero 429 across both tabs`, async () => {
      const a = await newTab(port), b = await newTab(port);
      await a.s.send("Page.navigate", { url: `${BASE}/preview/?p07c=2a#/deal/${DEAL}` });
      await b.s.send("Page.navigate", { url: `${BASE}/preview/?p07c=2b#/deal/${DEAL}` });
      const t0 = Date.now();
      await wait(WINDOW);
      const sa = summarize(a.requests, t0), sb = summarize(b.requests, t0);
      findings.two_tabs = { a: sa, b: sb };
      assert(sa.status_429 === 0 && sb.status_429 === 0, `429s: a=${sa.status_429} b=${sb.status_429}`);
      assert(sa.deal_reads + sb.deal_reads <= 20 * (WINDOW / 60_000) + 4, `combined reads ${sa.deal_reads + sb.deal_reads}`);
      await a.s.send("Page.navigate", { url: "about:blank" }); await b.s.send("Page.navigate", { url: "about:blank" });
      a.s.close(); b.s.close();
    });

    await run("S3+S4 hidden tab polls nothing; returning visible refreshes within 3s and resumes bounded cadence", async () => {
      const tab = await newTab(port);
      await tab.s.send("Page.navigate", { url: `${BASE}/preview/?p07c=3#/deal/${DEAL}` });
      await wait(15_000);
      // hide: emulate the Page Visibility API state the scheduler listens to
      await tab.s.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
      await tab.s.evaluate(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); return document.visibilityState; })()`);
      const tHidden = Date.now();
      await wait(30_000);
      const hidden = summarize(tab.requests, tHidden + 500);
      findings.hidden_30s = hidden;
      assert(hidden.deal_reads <= 1, `reads while hidden: ${hidden.deal_reads} ${JSON.stringify(hidden.by_path)}`);
      const tVisible = Date.now();
      await tab.s.evaluate(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); return document.visibilityState; })()`);
      await wait(3_000);
      const back = summarize(tab.requests, tVisible);
      assert(back.deal_reads >= 1, "no refresh after returning visible");
      await wait(27_000);
      const resumed = summarize(tab.requests, tVisible);
      findings.after_visible_30s = resumed;
      assert(resumed.status_429 === 0, "429 after resume");
      assert(resumed.deal_reads <= 6, `resume cadence too dense: ${resumed.deal_reads}`);
      await tab.s.send("Page.navigate", { url: "about:blank" });
      tab.s.close();
    });

    if (args.draft && args["seller-id"] && args["seller-password"]) {
      await run("S5 Draft buyer preview: zero activity/chat polling for 30s", async () => {
        const login = await fetch(`${BASE}/api/seller/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: args["seller-id"], password: args["seller-password"] }) });
        assert(login.status === 200, `seller login ${login.status}`);
        const m = (login.headers.get("set-cookie") || "").match(/siton_seller_session=([^;]+)/);
        assert(m, "no seller cookie");
        const tab = await newTab(port);
        await tab.s.send("Network.setCookie", { name: "siton_seller_session", value: m[1], domain: new URL(BASE).hostname, path: "/", secure: BASE.startsWith("https"), httpOnly: true });
        await tab.s.send("Page.navigate", { url: `${BASE}/preview/?p07c=5#/` });
        await wait(3_000);
        await tab.s.evaluate(`localStorage.setItem("siton_session_v1", JSON.stringify({ access_token: "p07c", refresh_token: "p07c", expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: false } })); localStorage.removeItem("siton_guest_mode_v1"); true`);
        await tab.s.send("Page.navigate", { url: `${BASE}/preview/?p07c=6#/seller/deal/${args.draft}/preview` });
        const t0 = Date.now();
        await wait(30_000);
        const sum = summarize(tab.requests, t0);
        findings.draft_preview_30s = sum;
        assert(sum.deal_reads === 0, `preview polled deal reads: ${JSON.stringify(sum.by_path)}`);
        assert(tab.requests.some((r) => /\/api\/seller\/deals\/.*\/preview/.test(r.url)), "preview payload fetched");
        tab.s.close();
      });
    } else {
      console.log("SKIP S5 Draft buyer preview (pass --draft + seller credentials)");
    }
  } finally {
    browser.kill("SIGKILL");
  }
  console.log(`\nP07C_BROWSER_PROOF passed=${passed} failed=${failed} findings=${JSON.stringify(findings)}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
