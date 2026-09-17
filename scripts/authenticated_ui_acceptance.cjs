#!/usr/bin/env node
// Authenticated UI acceptance harness — hosted staging, REAL browser.
//
// Shelf closeout 2026-09-17: ported from claude/authenticated-ui-acceptance-harness
// onto the block-based Site CMS (PR #34: draft → preview → publish, revision
// conflicts) and a Linux/CI-capable browser lookup. The seller flow is unchanged.
//
// Drives the deployed React app (headless Edge/Chrome over CDP) through the
// authenticated seller and admin/CMS surfaces exactly the way a person would:
// the credentials are TYPED into the real auth panels and go only to the
// canonical Supabase password grant. Nothing is minted, forged or injected —
// no users are created, no Supabase state is touched, no token is invented.
//
// Credentials come ONLY from environment variables (never from files in Git):
//   SITON_ACCEPTANCE_SELLER_EMAIL / SITON_ACCEPTANCE_SELLER_PASSWORD
//   SITON_ACCEPTANCE_ADMIN_EMAIL  / SITON_ACCEPTANCE_ADMIN_PASSWORD
// Optional:
//   SITON_ACCEPTANCE_BASE_URL       (default https://siton-staging-web.onrender.com)
//   SITON_ACCEPTANCE_FOREIGN_DEAL_ID (a deal owned by ANOTHER seller; otherwise
//                                    discovered from the public catalog)
//   SITON_ACCEPTANCE_BROWSER        (explicit msedge.exe / chrome.exe path)
//   SITON_ACCEPTANCE_DRYFIT_ADMIN_COOKIE (local dry-fit only; minted by
//                                    scripts/authenticated_ui_dryfit_seed.ts)
//
// Every step that needs a credential the environment does not provide is
// reported as SKIP … CREDENTIALS_MISSING(surface) — never as PASS — and the
// run's verdict becomes CREDENTIALS_MISSING (exit 3). Credential-free checks
// (login shells render, unauthenticated admin API is denied, …) still run and
// still report real PASS/FAIL.
//
// Usage:
//   node scripts/authenticated_ui_acceptance.cjs [--flow=seller|admin|all]
//        [--viewport=desktop|mobile] [--base-url=…] [--out=dir]
//   node scripts/authenticated_ui_acceptance.cjs --credentials-check   (no browser, no network)
//   node scripts/authenticated_ui_acceptance.cjs --plan                (no browser, no network)
//   node scripts/authenticated_ui_acceptance.cjs --local-dryfit --base-url=http://127.0.0.1:PORT
//        Harness self-validation ONLY: drives every post-login step against a
//        LOCAL demo-preview server (loopback host, Supabase NOT configured) with
//        the same non-secret local demo session the repo's other local proofs
//        seed. Login steps are not dry-fittable and are reported as DRYFIT, the
//        verdict is DRYFIT_PASS/DRYFIT_FAIL — never an acceptance PASS.
//
// Exit codes: 0 = every executed step passed and nothing was skipped;
//             3 = CREDENTIALS_MISSING (no failures, authenticated flows unproven);
//             1 = at least one FAIL (or an unexpected harness error).
"use strict";

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

// ── credential boundary ─────────────────────────────────────────────────────
const CREDENTIAL_ENV = {
  seller: ["SITON_ACCEPTANCE_SELLER_EMAIL", "SITON_ACCEPTANCE_SELLER_PASSWORD"],
  admin: ["SITON_ACCEPTANCE_ADMIN_EMAIL", "SITON_ACCEPTANCE_ADMIN_PASSWORD"]
};

function credentialState(env = process.env) {
  const out = { surfaces: {}, missing: [] };
  for (const [surface, names] of Object.entries(CREDENTIAL_ENV)) {
    const missing = names.filter((n) => !String(env[n] || "").trim());
    out.surfaces[surface] = { present: missing.length === 0, missing };
    out.missing.push(...missing);
  }
  return out;
}

function readCredentials(env = process.env) {
  const state = credentialState(env);
  const creds = {};
  for (const surface of Object.keys(CREDENTIAL_ENV)) {
    if (!state.surfaces[surface].present) continue;
    const [emailVar, passwordVar] = CREDENTIAL_ENV[surface];
    creds[surface] = { email: String(env[emailVar]).trim(), password: String(env[passwordVar]) };
  }
  return { state, creds };
}

// ── cli ─────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = String(args["base-url"] || process.env.SITON_ACCEPTANCE_BASE_URL || "https://siton-staging-web.onrender.com").replace(/\/+$/, "");
const FLOW = String(args.flow || "all");
const VIEWPORT = String(args.viewport || "desktop");
const DRYFIT = Boolean(args["local-dryfit"]);
const RUN_ID = `acc-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const OUT = resolve(String(args.out || join(".tmp_acceptance_ui", RUN_ID)));
const MARK = (surface) => `[${RUN_ID}:${surface}]`;
const DESKTOP = { width: 1440, height: 900, mobile: false };
const MOBILE = { width: 390, height: 844, mobile: true };

if (!["seller", "admin", "all"].includes(FLOW)) { console.error(`--flow must be seller|admin|all (got ${FLOW})`); process.exit(1); }
if (!["desktop", "mobile"].includes(VIEWPORT)) { console.error(`--viewport must be desktop|mobile (got ${VIEWPORT})`); process.exit(1); }

const { state: CRED_STATE, creds: CREDS } = readCredentials();
const presence = () => Object.entries(CRED_STATE.surfaces).map(([s, v]) => `${s}=${v.present ? "present" : "missing"}`).join(" ");

if (args["credentials-check"]) {
  console.log(`CREDENTIALS ${presence()}`);
  console.log(`MISSING_CREDENTIALS=${CRED_STATE.missing.length ? CRED_STATE.missing.join(",") : "none"}`);
  if (CRED_STATE.missing.length) {
    console.log("AUTH_UI_ACCEPTANCE verdict=CREDENTIALS_MISSING passed=0 failed=0 skipped=0 not_supported=0 mode=credentials-check");
    process.exit(3);
  }
  console.log("CREDENTIALS_PRESENT (presence only — validity is proven by the browser run, not here)");
  process.exit(0);
}

// ── step plan (data first, so the boundary can be inspected without a browser)
const PLAN = {
  seller: [
    { id: "S0", name: "unauthenticated seller boundary (auth panel shown, seller API 401, no overflow at both widths)", needs: [], allow: [401] },
    { id: "S1", name: "seller login through the real auth panel", needs: ["seller"], allow: [], login: true },
    { id: "S2", name: "seller dashboard loads (seller surface API 200)", needs: ["seller"], allow: [] },
    { id: "S3", name: "open seller profile (public + business profile forms render)", needs: ["seller"], allow: [] },
    { id: "S4", name: "edit allowed field (public profile 'about')", needs: ["seller"], allow: [] },
    { id: "S5", name: "save public profile", needs: ["seller"], allow: [] },
    { id: "S6", name: "reload and verify persistence, then restore the original value", needs: ["seller"], allow: [] },
    { id: "S7", name: "another seller's protected deal cannot be accessed (API + UI)", needs: ["seller"], allow: [401, 403, 404] },
    { id: "S8", name: "seller surfaces at the other viewport width (no horizontal overflow)", needs: ["seller"], allow: [] },
    { id: "S9", name: "seller flow console/network hygiene", needs: [], allow: [], hygiene: true }
  ],
  admin: [
    { id: "A0", name: "unauthenticated admin denial (step-up gate shown, admin API 401)", needs: [], allow: [401] },
    { id: "A1", name: "non-admin (seller identity) denied at the admin step-up", needs: ["seller"], login: true, allow: [401, 403], allowUrl: [/\/auth\/v1\/token/] },
    { id: "A2", name: "admin login through the real step-up panel", needs: ["admin"], allow: [], login: true },
    { id: "A3", name: "CMS (site content editor) loads", needs: ["admin"], allow: [] },
    { id: "A4", name: "edit content (footer block text)", needs: ["admin"], allow: [] },
    { id: "A5", name: "save draft (public unchanged) then publish", needs: ["admin"], allow: [] },
    { id: "A6", name: "reload and verify persistence (CMS editor + public site-content)", needs: ["admin"], allow: [] },
    { id: "A7", name: "revision conflict: stale revision is refused (409) and the concurrent write wins", needs: ["admin"], allow: [409] },
    { id: "A8", name: "restore/revert previously published content", needs: ["admin"], notSupported: "master has no restore/revert route or UI: the server keeps previous_value_jsonb and the editor can only discard an unpublished draft; nothing to drive" },
    { id: "A9", name: "CMS at the other viewport width (no horizontal overflow)", needs: ["admin"], allow: [] },
    { id: "A10", name: "admin flow console/network hygiene", needs: [], allow: [], hygiene: true }
  ]
};

function disposition(step) {
  if (step.notSupported) return "NOT_SUPPORTED";
  if (DRYFIT) return step.login ? "DRYFIT" : "RUN";
  const missing = step.needs.filter((s) => !CRED_STATE.surfaces[s].present);
  return missing.length ? `SKIP:CREDENTIALS_MISSING(${missing.join(",")})` : "RUN";
}

if (args.plan) {
  console.log(`CREDENTIALS ${presence()}`);
  for (const flow of Object.keys(PLAN)) {
    if (FLOW !== "all" && FLOW !== flow) continue;
    for (const step of PLAN[flow]) console.log(`PLAN ${flow} ${step.id} needs=${step.needs.join(",") || "none"} disposition=${disposition(step)} :: ${step.name}`);
  }
  console.log(`MISSING_CREDENTIALS=${CRED_STATE.missing.length ? CRED_STATE.missing.join(",") : "none"}`);
  process.exit(CRED_STATE.missing.length ? 3 : 0);
}

// ── browser plumbing (headless Edge/Chrome over CDP, no third-party driver) ─
const BROWSER = [process.env.SITON_ACCEPTANCE_BROWSER, process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/pw-browsers/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean).find(existsSync);
// a root-owned CI/container session cannot use the Chromium sandbox; nothing else changes
const BROWSER_FLAGS = typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openBrowser(tag) {
  if (!BROWSER) throw new Error("no Edge/Chrome executable found (set SITON_ACCEPTANCE_BROWSER)");
  const profileDir = join(tmpdir(), `siton-auth-acceptance-${tag}-${Date.now()}`);
  const port = 36_000 + Math.floor(Math.random() * 1000);
  const proc = spawn(BROWSER, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", ...BROWSER_FLAGS, `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await res.json();
      const page = pages.find((p) => p.type === "page");
      if (page?.webSocketDebuggerUrl) return { proc, profileDir, wsUrl: page.webSocketDebuggerUrl };
    } catch { /* retry */ }
    await wait(250);
  }
  proc.kill("SIGKILL");
  throw new Error("CDP endpoint not available");
}

function cdpSession(wsUrl, diag) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  const inflight = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { resolve: ok, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : ok(msg.result); return; }
    if (!msg.method) return;
    const p = msg.params || {};
    switch (msg.method) {
      case "Network.requestWillBeSent": inflight.set(p.requestId, { url: p.request?.url || "", method: p.request?.method || "" }); break;
      case "Network.responseReceived": {
        const req = inflight.get(p.requestId) || { url: p.response?.url || "", method: "" };
        const status = Number(p.response?.status || 0);
        if (status >= 400) diag.push({ kind: "http", step: diag.step, status, method: req.method, url: req.url });
        diag.requests.push({ step: diag.step, status, method: req.method, url: req.url });
        break;
      }
      case "Network.loadingFailed": {
        const req = inflight.get(p.requestId) || { url: "", method: "" };
        if (!p.canceled) diag.push({ kind: "network-failed", step: diag.step, error: p.errorText, method: req.method, url: req.url });
        break;
      }
      case "Runtime.consoleAPICalled":
        if (p.type === "error" || p.type === "assert" || p.type === "warning") diag.push({ kind: `console.${p.type}`, step: diag.step, text: (p.args || []).map((a) => a.value !== undefined ? String(a.value) : a.description || a.type).join(" ").slice(0, 400) });
        break;
      case "Runtime.exceptionThrown":
        diag.push({ kind: "exception", step: diag.step, text: String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").slice(0, 400) });
        break;
      case "Log.entryAdded":
        if (p.entry?.level === "error" && p.entry?.source !== "network") diag.push({ kind: "log.error", step: diag.step, text: String(p.entry.text || "").slice(0, 400), url: p.entry.url || "" });
        break;
      default: break;
    }
  });
  const send = (method, params = {}) => new Promise((ok, reject) => { const id = ++seq; pending.set(id, { resolve: ok, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ready = new Promise((ok, reject) => { ws.addEventListener("open", ok); ws.addEventListener("error", () => reject(new Error("ws error"))); });
  return {
    ready, send, close: () => ws.close(),
    async enableCapture() { await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable"); },
    async navigate(url) { await send("Page.navigate", { url }); await wait(400); },
    async reload() { await send("Page.reload", { ignoreCache: true }); await wait(600); },
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluate failed"); return res.result?.value; },
    async viewport(v) { await send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.mobile ? 2 : 1, mobile: v.mobile }); },
    // Type like a person: focus + select-all, then CDP insertText replaces the
    // selection and fires the real input events React listens to. The value
    // travels only into the page; it is never logged.
    async type(selectorExpr, value) {
      const focused = await this.evaluate(`(() => { const el = ${selectorExpr}; if (!el) return false; el.focus(); if (typeof el.select === 'function') el.select(); return document.activeElement === el; })()`);
      if (!focused) throw new Error(`cannot focus ${selectorExpr}`);
      await send("Input.insertText", { text: value });
      await wait(60);
    },
    async click(selectorExpr) {
      const ok = await this.evaluate(`(() => { const el = ${selectorExpr}; if (!el) return false; el.click(); return true; })()`);
      if (!ok) throw new Error(`cannot click ${selectorExpr}`);
      await wait(150);
    },
    async screenshot(file) { try { const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(OUT, file), Buffer.from(res.data, "base64")); } catch { /* best effort */ } }
  };
}

async function waitFor(cdp, expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs; let last = null;
  while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(300); }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`);
}
const noOverflowExpr = "document.documentElement.scrollWidth <= window.innerWidth + 2";
const bodyTextHas = (s) => `((document.body && document.body.innerText) || '').includes(${JSON.stringify(s)})`;
// in-page fetch with the REAL session the app stored after the typed login
const sessionFetch = (path, init = {}) => `(async () => {
  let token = '';
  try { token = JSON.parse(localStorage.getItem('siton_session_v1') || 'null')?.access_token || ''; } catch {}
  const headers = Object.assign({}, ${JSON.stringify(init.headers || {})}, token ? { authorization: 'Bearer ' + token } : {});
  const res = await fetch(${JSON.stringify(path)}, Object.assign({}, ${JSON.stringify({ method: init.method || "GET", body: init.body })}, { headers }));
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body, hadToken: Boolean(token) };
})()`;
// Site CMS editor contract (web/src/pages/contentAdmin.tsx)
const FOOTER_FIELD = "document.querySelector('[data-testid=cms-field-footer-text]')";
const CMS_MESSAGE = "(() => { const p = document.querySelector('[data-testid=cms-message]'); return p && p.innerText.trim() ? p.innerText.trim() : null; })()";
const CMS_DRAFT_SAVED = "הטיוטה נשמרה. האתר הציבורי לא השתנה עדיין.";
const CMS_PUBLISHED = "התוכן פורסם ומוצג באתר.";
const anonFetch = (path) => `(async () => { const res = await fetch(${JSON.stringify(path)}); let body = null; try { body = await res.json(); } catch {} return { status: res.status, body }; })()`;

// ── reporting ───────────────────────────────────────────────────────────────
const report = { run_id: RUN_ID, base_url: BASE, flow: FLOW, viewport: VIEWPORT, credentials: Object.fromEntries(Object.entries(CRED_STATE.surfaces).map(([k, v]) => [k, v.present])), steps: [], diagnostics: [] };
const counts = { passed: 0, failed: 0, skipped: 0, not_supported: 0, blocked: 0, dryfit: 0 };

// Loopback-only harness self-validation. The seeded marker is the SAME
// non-secret local demo session the repo's other local browser proofs seed
// against a demo-preview server (which authenticates nothing); it is refused
// for any non-loopback host or any server with Supabase configured.
async function assertDryfitTarget() {
  const host = new URL(BASE).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error(`DRYFIT_REFUSED non-loopback host ${host}`);
  const cfg = await fetch(`${BASE}/api/preview/auth-config`).then((r) => r.json()).catch((e) => { throw new Error(`DRYFIT_REFUSED auth-config unreachable: ${e.message}`); });
  if (cfg?.configured !== false) throw new Error("DRYFIT_REFUSED target has Supabase auth configured — dry-fit is for local demo-preview servers only");
}
async function seedLocalDemoSession(cdp, admin) {
  // CMS writes are guarded by the admin cookie session even locally; the
  // dry-fit seed script mints a throwaway local one (see
  // scripts/authenticated_ui_dryfit_seed.ts). Only honoured in dry-fit mode.
  const cookie = admin ? String(process.env.SITON_ACCEPTANCE_DRYFIT_ADMIN_COOKIE || "") : "";
  if (cookie) await cdp.send("Network.setCookie", { name: "siton_admin_session", value: cookie, url: `${BASE}/`, path: "/", httpOnly: true, sameSite: "Lax" });
  await cdp.navigate(`${BASE}/preview/#/`);
  await waitFor(cdp, "Boolean(document.querySelector('.app'))", 30_000, "app shell");
  await cdp.evaluate(`(() => { localStorage.setItem('siton_session_v1', JSON.stringify({ access_token: 'local-dryfit-demo-session', refresh_token: '', expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: ${admin ? "true" : "false"} } })); ${admin ? "sessionStorage.setItem('siton_admin_unlock_v1', JSON.stringify({ until: Date.now() + 30*60000 }));" : ""} localStorage.removeItem('siton_guest_mode_v1'); return true; })()`);
  await cdp.navigate(`${BASE}/preview/#/${admin ? "admin" : "seller"}`);
  await cdp.reload();
}
function record(step, status, detail) {
  report.steps.push({ id: step.id, flow: step.flow, name: step.name, status, detail: detail || "" });
  const line = `${status} ${step.id} ${step.name}${detail ? `: ${detail}` : ""}`;
  if (status === "FAIL") console.error(line); else console.log(line);
}

// Third-party web-font hosts: a LOCAL dry-fit runs against a loopback server,
// usually in a sandbox/CI container with no outbound internet, so a failed
// font stylesheet load there says nothing about the product. Acceptance runs
// (hosted staging) keep counting them — a broken font on staging is a finding.
const DRYFIT_TOLERATED_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
function hygieneViolations(diag, steps) {
  const allowByStep = new Map(steps.map((s) => [s.id, s]));
  return diag.entries.filter((e) => {
    if (DRYFIT && e.kind === "network-failed" && DRYFIT_TOLERATED_HOSTS.test(String(e.url || ""))) return false;
    if (e.kind === "http") {
      if (/\/favicon\.ico(\?|$)/.test(e.url) && e.status === 404) return false; // cosmetic first-visit 404
      const step = allowByStep.get(e.step);
      if (step && (step.allow || []).includes(e.status)) return false;
      if (step && (step.allowUrl || []).some((re) => re.test(e.url))) return false;
      return true;
    }
    return true; // exceptions, console errors/warnings, failed loads are never expected
  });
}

// ── flows ───────────────────────────────────────────────────────────────────
async function runFlow(flow) {
  const steps = PLAN[flow].map((s) => ({ ...s, flow }));
  const diag = { step: "", entries: [], requests: [], push(e) { this.entries.push(e); } };
  const primary = VIEWPORT === "mobile" ? MOBILE : DESKTOP;
  const other = VIEWPORT === "mobile" ? DESKTOP : MOBILE;
  let browser = null, cdp = null, broken = null;
  const ctx = {};
  const needsBrowser = steps.some((s) => disposition(s) === "RUN");
  if (needsBrowser) {
    browser = await openBrowser(flow);
    cdp = cdpSession(browser.wsUrl, diag); await cdp.ready; await cdp.enableCapture(); await cdp.viewport(primary);
  }
  try {
    for (const step of steps) {
      diag.step = step.id;
      const disp = disposition(step);
      if (disp === "NOT_SUPPORTED") { counts.not_supported++; record(step, "NOT_SUPPORTED", step.notSupported); continue; }
      if (disp.startsWith("SKIP")) { counts.skipped++; record(step, "SKIP", disp.slice(5)); continue; }
      if (disp === "DRYFIT") {
        counts.dryfit++;
        if (step.id === "S1" || step.id === "A2") {
          await seedLocalDemoSession(cdp, step.id === "A2");
          record(step, "DRYFIT", "local demo session seeded instead of a Supabase login — harness mechanics only, not an acceptance result");
        } else record(step, "DRYFIT", "needs a real non-admin identity; not dry-fittable");
        continue;
      }
      if (broken && !step.hygiene) { counts.blocked++; record(step, "BLOCKED", `after ${broken}`); continue; }
      try {
        if (step.hygiene) {
          const executed = report.steps.filter((s) => s.flow === flow && ["PASS", "FAIL"].includes(s.status)).map((s) => s.id);
          if (!executed.length) { counts.skipped++; record(step, "SKIP", "no executed steps in this flow"); continue; }
          const bad = hygieneViolations(diag, steps);
          if (bad.length) throw new Error(`${bad.length} unexpected: ` + bad.slice(0, 6).map((b) => `[${b.step}] ${b.kind} ${b.status || ""} ${b.method || ""} ${b.url || b.text || ""}`.replace(/\s+/g, " ").trim()).join(" | "));
          record(step, "PASS", `${diag.requests.length} requests observed across ${executed.join(",")}, 0 unexpected console/network failures`);
        } else {
          const detail = await STEP_IMPL[step.id]({ cdp, ctx, primary, other, step });
          record(step, "PASS", detail || "");
        }
        counts.passed++;
      } catch (e) {
        counts.failed++;
        record(step, "FAIL", String(e?.message || e).replace(/\s+/g, " ").slice(0, 600));
        if (cdp) await cdp.screenshot(`${flow}-${step.id}-FAIL.png`);
        if (["S1", "S2", "S3", "S5", "A2", "A3", "A5"].includes(step.id)) broken = step.id;
      }
    }
  } finally {
    diag.step = "";
    report.diagnostics.push(...diag.entries);
    if (cdp) {
      // leave nothing authenticated behind in the throwaway profile
      await cdp.evaluate("(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return true; })()").catch(() => undefined);
      cdp.close();
    }
    if (browser) { browser.proc.kill("SIGKILL"); await wait(300); try { rmSync(browser.profileDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

const STEP_IMPL = {
  // ── seller ──────────────────────────────────────────────────────────────
  async S0({ cdp, primary, other }) {
    await cdp.navigate(`${BASE}/preview/#/seller`);
    await waitFor(cdp, "Boolean(document.querySelector('input[type=email]') && document.querySelector('input[type=password]') && document.querySelector('[data-testid=auth-submit]'))", 30_000, "seller auth panel");
    const leaked = await cdp.evaluate(`${bodyTextHas("פרופיל עסקי")} || Boolean(document.querySelector('[data-testid=seller-journey]'))`);
    if (leaked) throw new Error("seller dashboard content rendered without a session");
    const api = DRYFIT ? { status: "n/a (demo-preview authenticates nothing)" } : await cdp.evaluate(anonFetch("/api/seller/deals"));
    if (!DRYFIT && api.status !== 401 && api.status !== 403) throw new Error(`unauthenticated seller deals status=${api.status}`);
    const widths = [];
    for (const v of [primary, other]) {
      await cdp.viewport(v);
      await cdp.reload();
      const ok = await waitFor(cdp, `(() => document.querySelector('[data-testid=auth-submit]') ? { over: ${noOverflowExpr}, rtl: document.documentElement.dir } : null)()`, 30_000, `auth panel at ${v.width}`);
      if (!ok.over) throw new Error(`horizontal overflow on the seller auth panel at ${v.width}`);
      if (ok.rtl !== "rtl") throw new Error(`dir=${ok.rtl} at ${v.width}`);
      await cdp.screenshot(`seller-S0-auth-${v.width}.png`);
      widths.push(v.width);
    }
    await cdp.viewport(primary);
    return `auth panel only (no dashboard content); API ${api.status} without a token; RTL + no overflow at ${widths.join("/")}px`;
  },
  async S1({ cdp, ctx }) {
    await cdp.navigate(`${BASE}/preview/#/seller`);
    await waitFor(cdp, "Boolean(document.querySelector('input[type=email]') && document.querySelector('[data-testid=auth-submit]'))", 30_000, "seller auth panel");
    await cdp.type("document.querySelector('input[type=email]')", CREDS.seller.email);
    await cdp.type("document.querySelector('input[type=password]')", CREDS.seller.password);
    await cdp.click("document.querySelector('[data-testid=auth-submit]')");
    const outcome = await waitFor(cdp, `(() => {
      const err = document.querySelector('form .notice.err');
      if (err && err.innerText.trim()) return { error: err.innerText.trim() };
      const binding = document.querySelector('[data-testid=seller-binding-notice]');
      if (binding) return { binding: binding.innerText.trim() };
      if (!document.querySelector('[data-testid=auth-submit]') && ${bodyTextHas("פרופיל עסקי")}) return { dashboard: true };
      return null;
    })()`, 45_000, "seller dashboard after login");
    if (outcome.error) throw new Error(`login refused by the app: ${outcome.error}`);
    if (outcome.binding) throw new Error(`login succeeded but no seller surface was granted: ${outcome.binding}`);
    const stored = await cdp.evaluate("(() => { try { return Boolean(JSON.parse(localStorage.getItem('siton_session_v1')||'null')?.access_token); } catch { return false; } })()");
    if (!stored) throw new Error("dashboard rendered but no canonical session stored");
    await cdp.screenshot("seller-S1-dashboard.png");
    return "typed credentials → Supabase password grant → capabilities adopted → dashboard";
  },
  async S2({ cdp, ctx }) {
    await waitFor(cdp, `(() => !document.querySelector('[data-testid=auth-submit]') && ${bodyTextHas("פרופיל עסקי")} && document.querySelector('h1') ? true : null)()`, 45_000, "seller dashboard");
    const r = await cdp.evaluate(sessionFetch("/api/seller/deals"));
    if (r.status !== 200 || !r.body?.ok) throw new Error(`/api/seller/deals status=${r.status}`);
    const deals = r.body?.seller_surface?.deals || r.body?.deals || [];
    ctx.myDealIds = new Set(deals.map((d) => String(d.deal_id)));
    const ui = await cdp.evaluate(`(() => ({ h1: (document.querySelector('h1')||{}).innerText || '', rtl: document.documentElement.dir, over: ${noOverflowExpr}, pending: Boolean(document.querySelector('[data-testid=seller-pending-approval]')) }))()`);
    if (!ui.h1) throw new Error("dashboard has no heading");
    if (ui.rtl !== "rtl") throw new Error(`dir=${ui.rtl}`);
    if (!ui.over) throw new Error("horizontal overflow on dashboard");
    return `heading="${ui.h1.slice(0, 40)}" deals=${ctx.myDealIds.size}${ui.pending ? " (pending-approval notice shown)" : ""}`;
  },
  async S3({ cdp }) {
    await cdp.navigate(`${BASE}/preview/#/seller/profile`);
    await waitFor(cdp, "Boolean(document.querySelector('section.panel form textarea') && document.querySelector('[data-testid=business-profile-save]'))", 30_000, "profile forms");
    await cdp.screenshot("seller-S3-profile.png");
    return "public profile form + business profile form rendered";
  },
  async S4({ cdp, ctx }) {
    ctx.aboutOriginal = await cdp.evaluate("document.querySelector('section.panel form textarea').value");
    const mark = MARK("seller");
    ctx.aboutEdited = (ctx.aboutOriginal + " " + mark).slice(-1000);
    await cdp.type("document.querySelector('section.panel form textarea')", ctx.aboutEdited);
    const now = await cdp.evaluate("document.querySelector('section.panel form textarea').value");
    if (now !== ctx.aboutEdited) throw new Error("textarea did not accept the edit");
    return `about: ${ctx.aboutOriginal.length} chars → appended ${mark}`;
  },
  async S5({ cdp }) {
    await cdp.click("document.querySelector('section.panel form button')");
    const status = await waitFor(cdp, "(() => { const p = document.querySelector('section.panel p[role=status]'); return p && p.innerText.trim() ? p.innerText.trim() : null; })()", 20_000, "save status");
    if (status !== "הפרופיל נשמר") throw new Error(`save status: ${status}`);
    return `status="${status}"`;
  },
  async S6({ cdp, ctx }) {
    await cdp.reload();
    const after = await waitFor(cdp, "(() => { const t = document.querySelector('section.panel form textarea'); return t ? { v: t.value } : null; })()", 30_000, "profile after reload");
    if (!after.v.includes(MARK("seller"))) throw new Error("edit did not persist across reload");
    // restore — the only durable side effect of the seller flow is undone here
    await cdp.type("document.querySelector('section.panel form textarea')", ctx.aboutOriginal);
    if (ctx.aboutOriginal === "") await cdp.evaluate("(() => { const t = document.querySelector('section.panel form textarea'); const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(t,''); t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
    await cdp.click("document.querySelector('section.panel form button')");
    await waitFor(cdp, "(() => { const p = document.querySelector('section.panel p[role=status]'); return p && p.innerText.trim() === 'הפרופיל נשמר'; })()", 20_000, "restore status");
    await cdp.reload();
    const restored = await waitFor(cdp, "(() => { const t = document.querySelector('section.panel form textarea'); return t ? { v: t.value } : null; })()", 30_000, "profile after restore");
    if (restored.v !== ctx.aboutOriginal) throw new Error("restore did not persist (staging profile left modified!)");
    return "persisted across reload; original value restored and re-verified";
  },
  async S7({ cdp, ctx }) {
    let foreign = String(process.env.SITON_ACCEPTANCE_FOREIGN_DEAL_ID || "").trim();
    let source = "env";
    if (!foreign) {
      const pub = await cdp.evaluate(anonFetch("/api/mall/deals?limit=50"));
      const candidates = (pub.body?.deals || []).map((d) => String(d.deal_id)).filter((id) => !ctx.myDealIds?.has(id));
      foreign = candidates[0] || "";
      source = `public catalog (${candidates.length} candidates)`;
    }
    if (!foreign) throw new Error("no foreign deal fixture: public catalog has only this seller's deals — set SITON_ACCEPTANCE_FOREIGN_DEAL_ID");
    const api = await cdp.evaluate(sessionFetch(`/api/seller/deals/${foreign}`));
    if (!api.hadToken) throw new Error("no session token in the page");
    if (![401, 403, 404].includes(api.status)) throw new Error(`foreign deal exposed through /api/seller/deals/:id status=${api.status}`);
    const ff = await cdp.evaluate(sessionFetch(`/api/seller/deals/${foreign}/fulfillment`));
    if (![401, 403, 404].includes(ff.status)) throw new Error(`foreign fulfillment exposed status=${ff.status}`);
    await cdp.navigate(`${BASE}/preview/#/seller/deal/${foreign}`);
    const ui = await waitFor(cdp, `(() => { if (document.querySelector('[data-testid=deal-title], [data-testid=publish-open], [data-testid=deal-cancel-open]')) return { leaked: true }; if (${bodyTextHas("לא ניתן לטעון את העסקה")}) return { refused: true }; return null; })()`, 30_000, "foreign deal UI outcome");
    if (ui.leaked) throw new Error("seller UI rendered another seller's deal controls");
    await cdp.screenshot("seller-S7-foreign-refused.png");
    return `deal ${foreign.slice(0, 8)}… (${source}): API ${api.status}/${ff.status}, UI shows the refusal state`;
  },
  async S8({ cdp, other }) {
    await cdp.viewport(other);
    await cdp.navigate(`${BASE}/preview/#/seller`);
    const dash = await waitFor(cdp, `(() => ${bodyTextHas("פרופיל עסקי")} ? { over: ${noOverflowExpr} } : null)()`, 30_000, `dashboard at ${other.width}`);
    if (!dash.over) throw new Error(`horizontal overflow on dashboard at ${other.width}`);
    await cdp.screenshot(`seller-S8-dashboard-${other.width}.png`);
    await cdp.navigate(`${BASE}/preview/#/seller/profile`);
    const prof = await waitFor(cdp, `(() => document.querySelector('[data-testid=business-profile-save]') ? { over: ${noOverflowExpr} } : null)()`, 30_000, `profile at ${other.width}`);
    if (!prof.over) throw new Error(`horizontal overflow on profile at ${other.width}`);
    await cdp.screenshot(`seller-S8-profile-${other.width}.png`);
    return `dashboard + profile render at ${other.width}px without horizontal overflow`;
  },

  // ── admin / CMS ─────────────────────────────────────────────────────────
  async A0({ cdp }) {
    await cdp.navigate(`${BASE}/preview/#/admin`);
    await waitFor(cdp, "Boolean(document.querySelector('[data-testid=admin-stepup]'))", 30_000, "admin step-up gate");
    const shell = await cdp.evaluate("Boolean(document.querySelector('.admin-shell'))");
    if (shell) throw new Error("admin shell rendered without step-up");
    const api = DRYFIT ? { status: "n/a (demo-preview authenticates nothing)" } : await cdp.evaluate(anonFetch("/api/admin/site-content"));
    if (!DRYFIT && api.status !== 401 && api.status !== 403) throw new Error(`unauthenticated admin site-content status=${api.status}`);
    const forged = await cdp.evaluate("(() => { try { sessionStorage.setItem('siton_admin_unlock_v1', JSON.stringify({ until: Date.now() + 600000 })); } catch {} return true; })()");
    await cdp.reload();
    const afterForge = await waitFor(cdp, `(() => { const s = document.querySelector('.admin-shell'); const g = document.querySelector('[data-testid=admin-stepup]'); const login = document.querySelector('[data-testid=auth-submit]'); if (s || g || login) return { shell: Boolean(s), gate: Boolean(g), login: Boolean(login) }; return null; })()`, 30_000, "admin after forged unlock marker");
    await cdp.evaluate("(() => { try { sessionStorage.clear(); } catch {} return true; })()");
    if (afterForge.shell) throw new Error("forged unlock marker exposed the admin shell without a session");
    await cdp.screenshot("admin-A0-gate.png");
    return `step-up gate shown; API ${api.status} without a token; forged unlock marker (no session) → ${afterForge.gate ? "gate" : "login panel"}, no shell`;
  },
  async A1({ cdp }) {
    await cdp.navigate(`${BASE}/preview/#/admin`);
    await waitFor(cdp, "Boolean(document.querySelector('[data-testid=stepup-email]') && document.querySelector('[data-testid=stepup-password]'))", 30_000, "step-up form");
    await cdp.type("document.querySelector('[data-testid=stepup-email]')", CREDS.seller.email);
    await cdp.type("document.querySelector('[data-testid=stepup-password]')", CREDS.seller.password);
    await cdp.click("document.querySelector('[data-testid=stepup-submit]')");
    const outcome = await waitFor(cdp, "(() => { if (document.querySelector('.admin-shell')) return { shell: true }; const e = document.querySelector('[data-testid=stepup-error]'); if (e && e.innerText.trim()) return { error: e.innerText.trim() }; return null; })()", 45_000, "step-up outcome for the seller identity");
    if (outcome.shell) throw new Error("a non-admin identity entered the admin shell");
    const api = await cdp.evaluate(sessionFetch("/api/admin/site-content"));
    if (api.hadToken && ![401, 403].includes(api.status)) throw new Error(`seller token accepted by admin site-content: status=${api.status}`);
    await cdp.evaluate("(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return true; })()");
    return `refused with "${outcome.error.slice(0, 60)}"; admin API with that identity's token → ${api.hadToken ? api.status : "no token stored"}`;
  },
  async A2({ cdp }) {
    await cdp.navigate(`${BASE}/preview/#/admin`);
    await cdp.reload();
    await waitFor(cdp, "Boolean(document.querySelector('[data-testid=stepup-email]') && document.querySelector('[data-testid=stepup-password]'))", 30_000, "step-up form");
    await cdp.type("document.querySelector('[data-testid=stepup-email]')", CREDS.admin.email);
    await cdp.type("document.querySelector('[data-testid=stepup-password]')", CREDS.admin.password);
    await cdp.click("document.querySelector('[data-testid=stepup-submit]')");
    const outcome = await waitFor(cdp, "(() => { if (document.querySelector('.admin-shell .admin-nav')) return { shell: true }; const e = document.querySelector('[data-testid=stepup-error]'); if (e && e.innerText.trim()) return { error: e.innerText.trim() }; const l = document.querySelector('[data-testid=auth-submit]'); if (l) return { login: true }; return null; })()", 45_000, "admin shell");
    if (outcome.error) throw new Error(`step-up refused: ${outcome.error}`);
    if (outcome.login) throw new Error("step-up passed but the admin surface was not granted (login panel shown)");
    await cdp.screenshot("admin-A2-shell.png");
    return "typed credentials → step-up → server-confirmed admin capability → shell";
  },
  // ── the block-based Site CMS (PR #34): draft → publish, optimistic revisions ─
  async A3({ cdp }) {
    await cdp.navigate(`${BASE}/preview/#/admin/content`);
    await waitFor(cdp, "Boolean(document.querySelector('[data-testid=cms-admin]') && document.querySelector('[data-testid=cms-page-footer]') && document.querySelector('[data-testid=cms-status]'))", 30_000, "CMS editor");
    const r = await cdp.evaluate(sessionFetch("/api/admin/site-content"));
    if (r.status !== 200 || !r.body?.sections?.footer) throw new Error(`admin site-content status=${r.status}`);
    await cdp.screenshot("admin-A3-cms.png");
    return `pages=${Object.keys(r.body.sections).length}, footer revision=${r.body.sections.footer.revision}`;
  },
  async A4({ cdp, ctx }) {
    await cdp.click("document.querySelector('[data-testid=cms-page-footer]')");
    await waitFor(cdp, `document.querySelector('[data-testid=cms-page-footer]').getAttribute('aria-selected') === 'true' && Boolean(${FOOTER_FIELD})`, 10_000, "footer page");
    ctx.footerOriginal = await cdp.evaluate(`${FOOTER_FIELD}.value`);
    const mark = MARK("admin");
    ctx.footerEdited = (ctx.footerOriginal + " " + mark).slice(-500);
    await cdp.type(FOOTER_FIELD, ctx.footerEdited);
    const now = await cdp.evaluate(`${FOOTER_FIELD}.value`);
    if (now !== ctx.footerEdited) throw new Error("footer field did not accept the edit");
    const dirty = await cdp.evaluate("document.querySelector('[data-testid=cms-status]').getAttribute('data-dirty')");
    if (dirty !== "1") throw new Error("editor did not mark the page dirty after the edit");
    return `footer.text: ${ctx.footerOriginal.length} chars → appended ${mark}`;
  },
  async A5({ cdp, ctx }) {
    await cdp.click("document.querySelector('[data-testid=cms-save-draft]')");
    const draftStatus = await waitFor(cdp, CMS_MESSAGE, 20_000, "draft save status");
    if (draftStatus !== CMS_DRAFT_SAVED) throw new Error(`draft save status: ${draftStatus}`);
    // a saved DRAFT must never reach the public site
    const pubDuring = await cdp.evaluate(anonFetch("/api/site-content"));
    if (String(pubDuring.body?.content?.footer?.text || "").includes(MARK("admin"))) throw new Error("a saved draft leaked to the public site before publish");
    await cdp.click("document.querySelector('[data-testid=cms-publish]')");
    const publishStatus = await waitFor(cdp, `(() => { const t = ${CMS_MESSAGE}; return t && t !== ${JSON.stringify(CMS_DRAFT_SAVED)} ? t : null; })()`, 20_000, "publish status");
    if (publishStatus !== CMS_PUBLISHED) throw new Error(`publish status: ${publishStatus}`);
    return `draft="${draftStatus}" (public unchanged) → publish="${publishStatus}"`;
  },
  async A6({ cdp, ctx }) {
    await cdp.reload();
    await waitFor(cdp, "Boolean(document.querySelector('[data-testid=cms-admin]') && document.querySelector('[data-testid=cms-page-footer]'))", 30_000, "CMS after reload");
    await cdp.click("document.querySelector('[data-testid=cms-page-footer]')");
    await waitFor(cdp, `(() => { const t = ${FOOTER_FIELD}; return t && t.value.includes(${JSON.stringify(MARK("admin"))}) ? { v: t.value } : null; })()`, 15_000, "persisted footer in the editor");
    const pub = await cdp.evaluate(anonFetch("/api/site-content"));
    if (!String(pub.body?.content?.footer?.text || "").includes(MARK("admin"))) throw new Error("public site-content does not show the published footer");
    return "editor and public /api/site-content both carry the published edit after reload";
  },
  async A7({ cdp, ctx }) {
    const cur = await cdp.evaluate(sessionFetch("/api/admin/site-content"));
    const footer = cur.body?.sections?.footer;
    const revision = Number(footer?.revision);
    if (!Number.isInteger(revision) || !footer?.published?.blocks) throw new Error("no footer revision / published page");
    // a "second admin" restores the original text through the direct publish
    // route with the revision the editor still holds — this is also the cleanup
    // of the harness's own edit
    const restored = JSON.parse(JSON.stringify(footer.published));
    const block = (restored.blocks || []).find((b) => b.id === "footer" && b.type === "footer");
    if (!block) throw new Error("published footer page has no footer block");
    block.fields = { ...(block.fields || {}), text: ctx.footerOriginal };
    const concurrent = await cdp.evaluate(sessionFetch("/api/admin/site-content/footer", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: restored, revision }) }));
    if (concurrent.status !== 200) throw new Error(`concurrent write status=${concurrent.status} ${JSON.stringify(concurrent.body).slice(0, 120)}`);
    // the editor still holds the pre-restore revision: its next save must be refused
    await cdp.type(FOOTER_FIELD, `${ctx.footerEdited} ${MARK("stale")}`);
    await cdp.click("document.querySelector('[data-testid=cms-save-draft]')");
    const status = await waitFor(cdp, `(() => { const t = ${CMS_MESSAGE}; return t && t !== ${JSON.stringify(CMS_PUBLISHED)} ? t : null; })()`, 20_000, "conflict status");
    if (status === CMS_DRAFT_SAVED) throw new Error("stale revision was ACCEPTED — the concurrent edit was silently overwritten");
    if (!/עודכן בידי מנהל אחר/.test(status)) throw new Error(`unexpected conflict message: ${status}`);
    const pub = await cdp.evaluate(anonFetch("/api/site-content"));
    const text = String(pub.body?.content?.footer?.text || "");
    if (text !== ctx.footerOriginal) throw new Error("footer not restored to the original after the conflict (staging content left modified!)");
    const after = await cdp.evaluate(sessionFetch("/api/admin/site-content"));
    if (after.body?.sections?.footer?.draft) throw new Error("a stale draft was persisted despite the 409");
    await cdp.screenshot("admin-A7-conflict.png");
    return `stale revision ${revision} refused with "${status.slice(0, 50)}"; original footer restored and public-verified, no draft left behind`;
  },
  async A9({ cdp, other }) {
    await cdp.viewport(other);
    await cdp.navigate(`${BASE}/preview/#/admin/content`);
    await cdp.reload();
    const cms = await waitFor(cdp, `(() => document.querySelector('[data-testid=cms-admin]') && document.querySelector('[data-testid=cms-status]') ? { over: ${noOverflowExpr} } : null)()`, 30_000, `CMS at ${other.width}`);
    if (!cms.over) throw new Error(`horizontal overflow on CMS at ${other.width}`);
    await cdp.screenshot(`admin-A9-cms-${other.width}.png`);
    return `CMS editor renders at ${other.width}px without horizontal overflow`;
  }
};

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true });
  if (DRYFIT) { await assertDryfitTarget(); console.log("DRYFIT local harness self-validation — NOT an acceptance run; login steps are not exercised"); }
  console.log(`AUTH_UI_ACCEPTANCE start run=${RUN_ID} base=${BASE} flow=${FLOW} viewport=${VIEWPORT} mode=${DRYFIT ? "local-dryfit" : "acceptance"} browser=${BROWSER ? "found" : "MISSING"} out=${OUT}`);
  console.log(`CREDENTIALS ${presence()}`);
  for (const flow of ["seller", "admin"]) {
    if (FLOW !== "all" && FLOW !== flow) continue;
    console.log(`\n── ${flow} flow ──`);
    try { await runFlow(flow); }
    catch (e) { counts.failed++; console.error(`FAIL ${flow}: harness error: ${String(e?.message || e).slice(0, 300)}`); report.steps.push({ id: `${flow}:harness`, flow, name: "harness", status: "FAIL", detail: String(e?.message || e).slice(0, 300) }); }
  }
  let verdict = counts.failed || counts.blocked ? "FAIL" : (report.steps.some((s) => s.status === "SKIP") ? "CREDENTIALS_MISSING" : "PASS");
  if (DRYFIT) verdict = verdict === "PASS" ? "DRYFIT_PASS" : "DRYFIT_FAIL";
  report.verdict = verdict; report.counts = counts;
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  for (const d of report.diagnostics) appendFileSync(join(OUT, "diagnostics.jsonl"), JSON.stringify(d) + "\n");
  console.log(`\nMISSING_CREDENTIALS=${CRED_STATE.missing.length ? CRED_STATE.missing.join(",") : "none"}`);
  console.log(`AUTH_UI_ACCEPTANCE verdict=${verdict} passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} blocked=${counts.blocked} not_supported=${counts.not_supported} dryfit=${counts.dryfit} diagnostics=${report.diagnostics.length} report=${join(OUT, "report.json")}`);
  process.exit(verdict === "PASS" || verdict === "DRYFIT_PASS" ? 0 : verdict === "CREDENTIALS_MISSING" ? 3 : 1);
}

main().catch((e) => { console.error(`AUTH_UI_ACCEPTANCE verdict=FAIL harness_error=${String(e?.message || e)}`); process.exit(1); });
