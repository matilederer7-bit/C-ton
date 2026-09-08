#!/usr/bin/env node
// SPRINT 4 — owner UX cleanup, browser proof (headless Edge CDP) against a
// local demo-preview runtime that serves the built React bundle.
//
// Usage: DATABASE_URL=<runtime db> node scripts/sprint4_ux_cleanup_browser_proof.cjs
//        [BASE_URL=http://127.0.0.1:3217] [SHOTS=<dir>]
// The runtime must run with RATE_LIMIT_MAX=10000 RATE_LIMIT_READ_MAX=5000
// RATE_LIMIT_SENSITIVE_MAX=500 (three simulated devices from one IP), without
// ADMIN_API_KEY (local demo admin), and the bundle must be built (cd web && npm run build).
//
// Proves, at 390 / 430 (phones) and 1280 (desktop):
//   A1 pickup: Google Maps + Waze on the public deal (exact pin → same
//      coordinates in both; address only → address search in both, never an
//      "exact" claim) and on the buyer tracking card
//   A2 overflow: documentElement.scrollWidth <= viewport on landing, deal,
//      join sheet, tracking, support, legal ×3, seller dashboard / deal /
//      pickup / draft editor, admin overview / growth / buyers / deals
//   A3 tracking has the share loop only — no generations / branch / chain
//   A4 legal: footer link → native #/legal/* page inside the product shell;
//      direct /legal/privacy redirects into it; nav chips switch documents
//   A5 scroll: deal deep → support → Back restores (±40px); Forward restores
//      support's own position; same with a legal page
//   A6 admin buyer search: "ש" → every displayed name contains ש; letters
//      never match a hidden e-mail; digits search the phone; match reasons
//   A7 admin heading + nav read "ויראליות"
//   A8 growth: default 7 days; 30 / 90 / custom / all time drive the label +
//      windowed block; lifetime block labelled
//   A9 quantities: typed numeric input (no +/− buttons, numeric keyboard),
//      digits only, zero refused, max refused; seller min/max typed too
//   0 console errors, 0 failed essential requests, no text under 10px.
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { Client } = require("pg");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3217").replace(/\/+$/, "");
const SHOTS = process.env.SHOTS || join(tmpdir(), "siton-sprint4-shots");
mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/microsoft-edge", "/usr/bin/google-chrome"].find(existsSync);
if (!EDGE) { console.error("Edge not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0; const results = [];
async function run(name, fn) {
  try { const d = await fn(); passed++; results.push({ name, ok: true, detail: d ?? null }); console.log(`PASS ${name}${d ? ` — ${typeof d === "string" ? d : JSON.stringify(d).slice(0, 220)}` : ""}`); }
  catch (e) { failed++; results.push({ name, ok: false, error: String(e.message || e) }); console.error(`FAIL ${name}: ${String(e.message || e).slice(0, 900)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const tag = randomBytes(3).toString("hex");

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const h = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

// ── CDP (same harness as scripts/pickup_fulfillment_browser_proof.cjs) ──────
async function openBrowser(extraArgs = []) {
  const profileDir = join(tmpdir(), `siton-sprint4-proof-${Date.now()}`);
  const port = 38_000 + Math.floor(Math.random() * 1000);
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, ...extraArgs, "about:blank"], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 80; i++) { try { const res = await fetch(`http://127.0.0.1:${port}/json/list`); const pages = await res.json(); const page = pages.find((p) => p.type === "page"); if (page?.webSocketDebuggerUrl) return { browser, wsUrl: page.webSocketDebuggerUrl }; } catch {} await wait(250); }
  browser.kill("SIGKILL"); throw new Error("CDP not available");
}
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener("message", (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } else if (msg.method) { for (const l of listeners) l(msg); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ready = new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", () => reject(new Error("ws error"))); });
  return {
    ready, send, on: (fn) => listeners.push(fn), close: () => ws.close(),
    async navigate(url) { await send("Page.enable"); await send("Page.navigate", { url: "about:blank" }); await wait(120); await send("Page.navigate", { url }); },
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "evaluate failed"); return res.result?.value; },
    async viewport(width, height, mobile = true) { await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }); },
    async shot(file) { const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64")); }
  };
}
async function waitFor(cdp, expr, timeoutMs = 30_000, label = "condition") { const deadline = Date.now() + timeoutMs; let last = null; while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(200); } throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`); }
const NO_OVERFLOW = `document.documentElement.scrollWidth <= window.innerWidth + 2 && document.body.scrollWidth <= window.innerWidth + 2`;
const OFFENDERS = `(() => { const out = []; for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.right > window.innerWidth + 2 || r.left < -2 && r.width > 0 && getComputedStyle(el).position !== 'fixed') out.push(el.tagName + "." + String(el.className).slice(0, 50) + " w=" + Math.round(r.width) + " l=" + Math.round(r.left) + " r=" + Math.round(r.right)); } return out.slice(0, 10).join(" | "); })()`;
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`;
const exists = (sel) => `Boolean(document.querySelector(${JSON.stringify(sel)}))`;
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText || "")`;
const attr = (sel, name) => `(document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) || "")`;
const setValue = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const blur = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); el.blur(); el.dispatchEvent(new FocusEvent('blur', { bubbles: true })); el.dispatchEvent(new Event('focusout', { bubbles: true })); return true; })()`;
const LEGIBLE = `(() => { let tiny = 0; for (const el of document.querySelectorAll('body *')) { const cs = getComputedStyle(el); if (el.innerText && el.innerText.trim() && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.fontSize) < 10 && el.children.length === 0) tiny++; } return tiny; })()`;

// ── DB fixtures (trigger-legal forced transitions, same as the tracking suites)
async function forced(db, fn) {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await db.query(`SELECT set_config('app.in_atomic', 'true', true)`);
    await db.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await db.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    await fn();
    await db.query("COMMIT");
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}
async function forceDealCompleted(db, dealId) {
  const path = [
    { to: "TargetReached", action: "deal.target_reached" }, { to: "ClosedForJoining", action: "deal.close_joining" },
    { to: "ReadyForCharging", action: "deal.prepare_charging" }, { to: "Charging", action: "charging.start" },
    { to: "CompletionWindow", action: "charging.to_completion_window" }, { to: "Completed", action: "charging.finalize_completed" }
  ];
  await forced(db, async () => {
    for (const step of path) { await db.query(`SELECT set_config('siton.action_name', $1, true)`, [step.action]); await db.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, step.to]); }
  });
}
async function forceParticipantSettled(db, participantId) {
  await forced(db, async () => {
    await db.query(`SELECT set_config('siton.action_name', 'test.sprint4_proof_fixture', true)`);
    for (const b of ["LockedIn", "ChargingAttempt", "ChargedSuccess", "DealCompleted"]) await db.query(`UPDATE siton.participants SET buyer_state=$2 WHERE participant_id=$1`, [participantId, b]);
    for (const m of ["AuthLocked", "ChargeAttempt", "ChargedSuccess"]) await db.query(`UPDATE siton.participants SET money_state=$2 WHERE participant_id=$1`, [participantId, m]);
  });
}

async function createDeal({ title, pickupLabel, coords, publish = true }) {
  const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const pickup = { option_type: "pickup", label: pickupLabel, cost: 0, ...(coords ? { latitude: coords[0], longitude: coords[1] } : {}) };
  const created = await call("/api/deals", { method: "POST", headers: { "idempotency-key": `s4-${randomUUID()}` }, body: {
    deal_type: "physical_product", title, description_short: "מחיר קבוצתי לספר בכריכה קשה — הצטרפות ללא תשלום עכשיו", description: ("ספר X, מהדורה מיוחדת. איסוף עצמי מהחנות או משלוח עד הבית. " + "המחיר הקבוצתי נסגר כשמגיעים ליעד. ").repeat(4).trim(),
    price_per_unit: 60, list_price_per_unit: 90, min_units: 3, max_units: 40, deadline,
    delivery_options: [pickup, { option_type: "delivery", label: "שליח עד הבית", cost: 20 }]
  } });
  assert([200, 201].includes(created.status), `create ${created.status} ${created.text.slice(0, 200)}`);
  const dealId = String(created.json.deal_id || created.json.deal?.deal_id);
  if (publish) {
    const pub = await call(`/api/deals/${dealId}/publish`, { method: "POST", headers: { "idempotency-key": `s4-pub-${randomUUID()}` }, body: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
    assert(pub.status === 200, `publish ${pub.status} ${pub.text.slice(0, 200)}`);
  }
  return dealId;
}
async function joinBuyer(dealId, { phone, name, qty, optionType, email, ref }) {
  const pub = await call(`/api/deals/${dealId}/public`);
  const opt = (pub.json.deal.delivery_options || []).find((x) => x.option_type === optionType);
  assert(opt, `no ${optionType} option`);
  const r = await call(`/api/deals/${dealId}/join`, { method: "POST", headers: { "idempotency-key": `s4-join-${randomUUID()}` }, body: {
    buyer_id: phone, buyer_name: name, qty, delivery_option_id: opt.option_id, buyer_terms_accepted: true, payment_disclosure_accepted: true,
    payment_method: "credit_card", ...(email ? { buyer_email: email } : {}), ...(ref ? { affiliate_ref: ref } : {}),
    ...(optionType === "delivery" ? { delivery_address: "דיזנגוף 100", delivery_city: "תל אביב" } : {})
  } });
  assert(r.status === 200, `join ${name} ${r.status} ${r.text.slice(0, 200)}`);
  return { participant_id: r.json.participant_id, token: r.json.tracking_access_token, share: r.json.viral?.personal_share_code || null };
}

(async () => {
  console.log(`SPRINT4_UX_CLEANUP_PROOF base=${BASE} tag=${tag}`);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // ── fixtures through the product API (default demo seller = the React seller)
  const profile = await call("/api/seller/business-profile", { method: "PUT", body: { business_name: `חנות הספרים ${tag}`, business_id_number: "515000003", contact_name: "בודק", contact_phone: "0501234567" } });
  assert(profile.status === 200, `profile ${profile.status} ${profile.text.slice(0, 200)}`);
  const EXACT = [32.0668, 34.7647];
  const ADDRESS_ONLY = "רח׳ אלנבי 40, תל אביב";
  const dealOpen = await createDeal({ title: `ספר X ${tag}`, pickupLabel: "חנות הספרים — הרצל 12, תל אביב", coords: EXACT });
  const dealAddr = await createDeal({ title: `ספר Y ${tag}`, pickupLabel: ADDRESS_ONLY, coords: null });
  const dealDone = await createDeal({ title: `ספר Z ${tag}`, pickupLabel: "חנות הספרים — הרצל 12, תל אביב", coords: EXACT });
  const dealDraft = await createDeal({ title: `טיוטה ${tag}`, pickupLabel: "הרצל 12", coords: EXACT, publish: false });
  const stamp = String(Date.now()).slice(-7);
  const sara = await joinBuyer(dealOpen, { phone: `052${stamp}`, name: "שרה לוי", qty: 2, optionType: "pickup", email: `sara-${tag}@example.com` });
  const david = await joinBuyer(dealOpen, { phone: `053${stamp}`, name: "דוד כהן", qty: 1, optionType: "delivery", email: `shani-${tag}@example.com`, ref: sara.share });
  const moshe = await joinBuyer(dealOpen, { phone: `054${stamp}`, name: "משה לוי", qty: 1, optionType: "pickup", ref: sara.share });
  const done = await joinBuyer(dealDone, { phone: `055${stamp}`, name: "ישראל ישראלי", qty: 3, optionType: "pickup" });
  await forceParticipantSettled(db, done.participant_id);
  await forceDealCompleted(db, dealDone);
  const tr = await call(`/api/participants/${done.participant_id}/tracking?t=${encodeURIComponent(done.token)}`);
  assert(tr.status === 200 && tr.json.tracking.pickup.state === "ready", `tracking ${tr.status} ${tr.text.slice(0, 200)}`);
  assert(tr.json.tracking.pickup.pickup_navigation?.exact === true, "tracking payload carries exact navigation");
  const legacyLegal = await call("/legal/privacy");
  assert(legacyLegal.status === 302 && legacyLegal.headers.get("location") === "/preview/#/legal/privacy", `legacy legal ${legacyLegal.status} ${legacyLegal.headers.get("location")}`);
  console.log(`fixtures open=${dealOpen} addr=${dealAddr} done=${dealDone} draft=${dealDraft}`);

  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl); await cdp.ready;
  const consoleErrors = []; const failedRequests = []; let expectedFailures = [];
  await cdp.send("Runtime.enable"); await cdp.send("Log.enable"); await cdp.send("Network.enable");
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(`exception: ${msg.params.exceptionDetails?.text || ""} ${msg.params.exceptionDetails?.exception?.description || ""}`.slice(0, 240));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(`console.error: ${(msg.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 240)}`);
    if (msg.method === "Log.entryAdded" && msg.params.entry?.level === "error") {
      const url = String(msg.params.entry?.url || ""); const t = String(msg.params.entry?.text || "");
      if (/favicon/.test(url)) return;
      if (msg.params.entry?.source === "network" && expectedFailures.some((re) => re.test(url + " " + t))) return;
      consoleErrors.push(`log: ${t.slice(0, 200)} ${url.slice(0, 120)}`);
    }
    if (msg.method === "Network.responseReceived") { const { url, status } = msg.params.response; if (status >= 500 && /\/(api|preview)\//.test(url)) failedRequests.push(`${status} ${url}`); }
    if (msg.method === "Network.loadingFailed") { if (!msg.params.canceled && expectedFailures.length === 0 && !/net::ERR_ABORTED/.test(msg.params.errorText || "")) failedRequests.push(`loadingFailed ${msg.params.errorText}`); }
  });
  const pageChecks = [];
  async function check(label, extra = {}) {
    const ok = await cdp.evaluate(NO_OVERFLOW); const w = await cdp.evaluate("window.innerWidth"); const tiny = await cdp.evaluate(LEGIBLE);
    const sw = await cdp.evaluate("document.documentElement.scrollWidth");
    pageChecks.push({ label, overflow_ok: ok, width: w, scroll_width: sw, tiny_text: tiny, errors: consoleErrors.length });
    if (!ok) assert(false, `${label}: horizontal overflow at ${w}px (scrollWidth ${sw}) offenders: ${await cdp.evaluate(OFFENDERS)}`);
    assert(tiny === 0, `${label}: ${tiny} unreadable (<10px) text nodes`);
    return { width: w, scroll_width: sw, ...extra };
  }
  const shotName = (w, name) => `${String(w).padStart(4, "0")}_${name}.png`;
  // Seller surface: the demo-preview seller context (fake bearer, as every prior proof).
  // Admin surface: a REAL cookie session — the local admin user created by
  // scripts/create_admin_user.cjs (ADMIN_PROOF_EMAIL / ADMIN_PROOF_PASSWORD, MFA off
  // for the local proof DB) logs in through the product's own /api/admin/auth/login,
  // so every admin read below is authorized the way the owner's session is.
  const ADMIN_EMAIL = process.env.ADMIN_PROOF_EMAIL || "sprint4-admin@siton.test";
  const ADMIN_PASSWORD = process.env.ADMIN_PROOF_PASSWORD || "Sprint4-Proof-Password-2026";
  const unlockSellerAdmin = async () => {
    await cdp.evaluate(`localStorage.setItem('siton_session_v1', JSON.stringify({ access_token: 'sprint4-proof-token', refresh_token: '', expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: true } })); sessionStorage.setItem('siton_admin_unlock_v1', JSON.stringify({ until: Date.now() + 30*60000 })); localStorage.removeItem('siton_guest_mode_v1'); true`);
    const login = await cdp.evaluate(`fetch('/api/admin/auth/login', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} }) }).then(r => r.json())`);
    assert(login && login.ok && !login.mfa_required, `admin login ${JSON.stringify(login).slice(0, 160)}`);
    const me = await cdp.evaluate(`fetch('/api/admin/auth/me', { credentials: 'include' }).then(r => r.status)`);
    assert(me === 200, `admin session cookie rejected (${me})`);
  };
  const settle = (ms = 700) => wait(ms);
  const scrollY = () => cdp.evaluate("Math.round(window.scrollY)");
  const scrollTo = (y) => cdp.evaluate(`(() => { const prev = document.documentElement.style.scrollBehavior; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, ${y}); document.documentElement.style.scrollBehavior = prev; return Math.round(window.scrollY); })()`);
  const maxScroll = () => cdp.evaluate("Math.max(0, document.documentElement.scrollHeight - window.innerHeight)");
  const overflowRoutes = (w) => [
    ["landing", `#/`, `[data-testid="landing-pilot-note"], .container`],
    ["deal", `#/deal/${dealOpen}`, `[data-testid="join-open"]`],
    ["deal-address-only", `#/deal/${dealAddr}`, `[data-testid="join-open"]`],
    ["tracking", `#/track/${sara.participant_id}?t=${encodeURIComponent(sara.token)}`, `[data-testid="track-share"]`],
    ["tracking-pickup-ready", `#/track/${done.participant_id}?t=${encodeURIComponent(done.token)}`, `[data-testid="track-pickup"][data-state="ready"]`],
    ["support", `#/support`, `form, .container`],
    ["legal-terms", `#/legal/terms`, `[data-testid="legal-page"][data-legal-slug="terms"]`],
    ["legal-privacy", `#/legal/privacy`, `[data-testid="legal-page"][data-legal-slug="privacy"]`],
    ["legal-refunds", `#/legal/refunds`, `[data-testid="legal-page"][data-legal-slug="refunds"]`],
    ["seller-dashboard", `#/seller`, `[data-testid="dash-pickup-scan"]`],
    ["seller-deal", `#/seller/deal/${dealOpen}`, `[data-testid="seller-pickup-location"], .panel`],
    ["seller-draft", `#/seller/deal/${dealDraft}`, `[data-testid="edit-deal-min"], .panel`],
    ["seller-pickup", `#/seller/pickup`, `[data-testid="seller-pickup-page"]`],
    ["admin-overview", `#/admin`, `.admin-shell`],
    ["admin-growth", `#/admin/growth`, `[data-testid="growth-range"]`],
    ["admin-buyers", `#/admin/buyers`, `[data-testid="buyer-search"]`],
    ["admin-deals", `#/admin/deals`, `.admin-shell table, .admin-shell .panel, .admin-shell`]
  ];

  try {
    // the device-metrics override only sticks once a real document exists in the target: warm up on the landing first
    await cdp.navigate(`${BASE}/preview/#/`);
    await waitFor(cdp, `document.readyState === "complete"`, 20000, "warm-up");
    await unlockSellerAdmin();

    // ═══ A2 — overflow sweep at 390 / 430 / 1280 ════════════════════════════
    for (const [w, h, mobile] of [[390, 844, true], [430, 932, true], [1280, 900, false]]) {
      await cdp.viewport(w, h, mobile);
      for (const [name, hash, readySel] of overflowRoutes(w)) {
        await run(`A2 @${w} ${name}: no horizontal overflow, no unreadable text`, async () => {
          await cdp.navigate(`${BASE}/preview/${hash}`);
          await waitFor(cdp, exists(readySel), 30000, `${name} ready`);
          await settle(400);
          if (name === "deal") {
            // the join sheet is part of the deal surface
            assert(await cdp.evaluate(click('[data-testid="join-open"]')), "open join sheet");
            await waitFor(cdp, exists('[data-testid="join-terms"]'), 10000, "join sheet");
            await settle(300);
            const sheet = await check(`join-sheet @${w}`);
            await cdp.shot(shotName(w, `02_join_sheet`));
            // close it (Escape) and check the page underneath
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            await settle(300);
            if (await cdp.evaluate(exists('[data-testid="join-terms"]'))) await cdp.evaluate(`(() => { const b = document.querySelector('.modal [aria-label="סגירה"], .modal .x, .modal button[aria-label*="סגור"]'); if (b) b.click(); return true; })()`);
            await settle(200);
            const page = await check(`${name} @${w}`);
            return { sheet: sheet.scroll_width, page: page.scroll_width };
          }
          await cdp.shot(shotName(w, `01_${name}`));
          return check(`${name} @${w}`);
        });
      }
    }

    // ═══ A1 — pickup navigation on the public deal (exact vs address-only) + tracking card
    for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
      await cdp.viewport(w, h, mobile);
      await run(`A1 @${w} exact coordinates: selecting the pickup option shows Google Maps + Waze pointing at the SAME coordinates, mode 'נקודה מדויקת', no lone 'פתח במפה'`, async () => {
        await cdp.navigate(`${BASE}/preview/#/deal/${dealOpen}`);
        await waitFor(cdp, exists('[data-testid="delivery-option"][data-option-type="pickup"]'), 30000, "options");
        assert(await cdp.evaluate(click('[data-testid="delivery-option"][data-option-type="pickup"] input')), "select pickup");
        await waitFor(cdp, exists('[data-testid="pickup-nav-google"]'), 10000, "nav actions");
        const g = await cdp.evaluate(attr('[data-testid="pickup-nav-google"]', "href"));
        const wz = await cdp.evaluate(attr('[data-testid="pickup-nav-waze"]', "href"));
        assert(g.includes("google.com/maps/dir/") && g.includes(`destination=${EXACT[0]}%2C${EXACT[1]}`), `google ${g}`);
        assert(wz.startsWith("https://waze.com/ul?ll=") && wz.includes(`ll=${EXACT[0]}%2C${EXACT[1]}`) && wz.includes("navigate=yes"), `waze ${wz}`);
        const mode = await cdp.evaluate(text('[data-testid="pickup-nav-mode"]'));
        assert(mode.includes("נקודה מדויקת"), `mode ${mode}`);
        assert(await cdp.evaluate(attr('[data-testid="pickup-nav"]', "data-nav-exact")) === "1", "exact flag");
        const body = await cdp.evaluate("document.body.innerText");
        assert(!/פתח במפה|פתיחה במפה/.test(body), "no generic single map button");
        const labels = await cdp.evaluate(`[...document.querySelectorAll('[data-testid="pickup-nav"] a')].map(a => a.innerText.trim())`);
        assert(labels.some((l) => /Google Maps/.test(l)) && labels.some((l) => /Waze/.test(l)), `labels ${JSON.stringify(labels)}`);
        for (const sel of ['[data-testid="pickup-nav-google"]', '[data-testid="pickup-nav-waze"]']) {
          const box = await cdp.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
          assert(box.h >= 32 && box.w >= 60, `${sel} tap target ${JSON.stringify(box)}`);
        }
        await cdp.shot(shotName(w, "10_pickup_nav_exact"));
        return { google: g, waze: wz, mode };
      });
      await run(`A1 @${w} address only: both apps get an ADDRESS SEARCH for the seller's text, the UI says 'ניווט לפי חיפוש כתובת' and never claims an exact pin`, async () => {
        await cdp.navigate(`${BASE}/preview/#/deal/${dealAddr}`);
        await waitFor(cdp, exists('[data-testid="delivery-option"][data-option-type="pickup"]'), 30000, "options");
        assert(await cdp.evaluate(click('[data-testid="delivery-option"][data-option-type="pickup"] input')), "select pickup");
        await waitFor(cdp, exists('[data-testid="pickup-nav-google"]'), 10000, "nav actions");
        const g = await cdp.evaluate(attr('[data-testid="pickup-nav-google"]', "href"));
        const wz = await cdp.evaluate(attr('[data-testid="pickup-nav-waze"]', "href"));
        const enc = encodeURIComponent(ADDRESS_ONLY);
        assert(g === `https://www.google.com/maps/dir/?api=1&destination=${enc}`, `google ${g}`);
        assert(wz === `https://waze.com/ul?q=${enc}&navigate=yes`, `waze ${wz}`);
        assert(!/\d+\.\d+%2C\d+\.\d+/.test(g + wz), "no fabricated coordinates");
        const mode = await cdp.evaluate(text('[data-testid="pickup-nav-mode"]'));
        assert(mode.includes("ניווט לפי חיפוש כתובת"), `mode ${mode}`);
        assert(await cdp.evaluate(attr('[data-testid="pickup-nav"]', "data-nav-exact")) === "0", "not exact");
        const loc = await cdp.evaluate(text('[data-testid="pickup-location-text"]'));
        assert(loc.includes(ADDRESS_ONLY) && !loc.includes("מסומנת במפה"), `location text ${loc}`);
        await cdp.shot(shotName(w, "11_pickup_nav_address"));
        return { google: g, waze: wz, mode };
      });
    }
    await cdp.viewport(390, 844, true);
    await run("A1 @390 tracking pickup card: Google Maps + Waze on the credential card carry the exact coordinates (server-derived)", async () => {
      await cdp.navigate(`${BASE}/preview/#/track/${done.participant_id}?t=${encodeURIComponent(done.token)}`);
      await waitFor(cdp, exists('[data-testid="track-pickup"][data-state="ready"]'), 30000, "pickup card");
      await waitFor(cdp, exists('[data-testid="track-pickup-nav-google"]'), 10000, "card nav");
      const g = await cdp.evaluate(attr('[data-testid="track-pickup-nav-google"]', "href"));
      const wz = await cdp.evaluate(attr('[data-testid="track-pickup-nav-waze"]', "href"));
      assert(g.includes(`destination=${EXACT[0]}%2C${EXACT[1]}`), `google ${g}`);
      assert(wz.includes(`ll=${EXACT[0]}%2C${EXACT[1]}`), `waze ${wz}`);
      const card = await cdp.evaluate(text('[data-testid="track-pickup"]'));
      assert(card.includes("הרצל 12") && !/פתיחה במפה/.test(card), card.slice(0, 200));
      await cdp.shot(shotName(390, "12_track_pickup_nav"));
      return check("tracking pickup nav @390", { google: g, waze: wz });
    });

    // ═══ A3 — tracking: share loop only, no tree ═══════════════════════════
    await run("A3 @390 tracking: the share loop (WhatsApp / share / copy) is there; no generations / branch / chain counters anywhere on the page", async () => {
      await cdp.navigate(`${BASE}/preview/#/track/${sara.participant_id}?t=${encodeURIComponent(sara.token)}`);
      await waitFor(cdp, exists('[data-testid="track-share"] [data-testid="share-whatsapp"]'), 30000, "share loop");
      const body = await cdp.evaluate("document.body.innerText");
      for (const forbidden of ["דורות", "בענף", "השרשרת שלך", "מצטרפים שהבאת", "דור "]) assert(!body.includes(forbidden), `tracking exposes "${forbidden}"`);
      assert(body.includes("עזרו לעסקה להצליח"), "share loop title");
      assert(await cdp.evaluate(exists('[data-testid="track-share"] [data-testid="share-copy"], [data-testid="track-share"] [data-testid="share-copy-link"], [data-testid="track-share"] button, [data-testid="track-share"] a')), "share actions");
      assert(!(await cdp.evaluate(exists('.impact-stats, .vtree-canvas, [data-testid="propagation-tree"]'))), "no tree UI");
      await cdp.shot(shotName(390, "20_tracking_share_only"));
      return check("tracking share-only @390");
    });

    // ═══ A9 — typed quantity ═══════════════════════════════════════════════
    for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
      await cdp.viewport(w, h, mobile);
      await run(`A9 @${w} join quantity is a typed numeric field: no +/− buttons, numeric keyboard, letters/decimals stripped, zero and over-stock refused with a reason, a valid number drives the order summary`, async () => {
        await cdp.navigate(`${BASE}/preview/#/deal/${dealOpen}`);
        await waitFor(cdp, exists('[data-testid="join-qty"]'), 30000, "qty input");
        const meta = await cdp.evaluate(`(() => { const el = document.querySelector('[data-testid="join-qty"]'); return { tag: el.tagName, type: el.getAttribute('type'), inputmode: el.getAttribute('inputmode'), pattern: el.getAttribute('pattern'), value: el.value }; })()`);
        assert(meta.tag === "INPUT" && meta.type === "text" && meta.inputmode === "numeric" && meta.pattern === "[0-9]*", JSON.stringify(meta));
        assert(!(await cdp.evaluate(exists('.qty-stepper'))), "no stepper");
        const plusMinus = await cdp.evaluate(`[...document.querySelectorAll('.panel button')].filter(b => ['+','−','-'].includes(b.innerText.trim())).length`);
        assert(plusMinus === 0, `${plusMinus} +/- buttons remain`);
        assert(await cdp.evaluate(setValue('[data-testid="join-qty"]', "abc")), "type letters");
        assert((await cdp.evaluate(`document.querySelector('[data-testid="join-qty"]').value`)) === "", "letters produce nothing");
        assert(await cdp.evaluate(setValue('[data-testid="join-qty"]', "2.5")), "type decimal");
        const dec = await cdp.evaluate(`document.querySelector('[data-testid="join-qty"]').value`);
        assert(dec === "25", `decimal typed → digits only (${dec})`);
        assert(await cdp.evaluate(setValue('[data-testid="join-qty"]', "0")), "type zero");
        await cdp.evaluate(blur('[data-testid="join-qty"]'));
        await waitFor(cdp, exists('[data-testid="join-qty-error"]'), 5000, "zero refused");
        const zeroMsg = await cdp.evaluate(text('[data-testid="join-qty-error"]'));
        assert(zeroMsg.includes("לפחות יחידה אחת"), zeroMsg);
        assert(await cdp.evaluate(setValue('[data-testid="join-qty"]', "5000")), "type over max");
        await waitFor(cdp, `(document.querySelector('[data-testid="join-qty-error"]')?.innerText || '').includes('ניתן להזמין עד')`, 5000, "max refused");
        assert(await cdp.evaluate(setValue('[data-testid="join-qty"]', "3")), "type 3");
        await waitFor(cdp, `!document.querySelector('[data-testid="join-qty-error"]')`, 5000, "error cleared");
        const summary = await cdp.evaluate(text('.order-summary'));
        assert(/×\s*3/.test(summary), `order summary ${summary}`);
        await cdp.shot(shotName(w, "30_qty_typed"));
        return { meta, summary: summary.replace(/\s+/g, " ").slice(0, 80) };
      });
    }
    await cdp.viewport(390, 844, true);
    await run("A9 @390 seller Draft editor: min / max units are typed numeric fields (no spinner, numeric keyboard); a decimal cannot be typed", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller/deal/${dealDraft}`);
      await waitFor(cdp, exists('[data-testid="draft-edit-open"]'), 30000, "draft page");
      assert(await cdp.evaluate(click('[data-testid="draft-edit-open"]')), "open the editor");
      await waitFor(cdp, exists('[data-testid="edit-deal-min"]'), 10000, "draft editor");
      const meta = await cdp.evaluate(`(() => { const el = document.querySelector('[data-testid="edit-deal-min"]'); return { type: el.getAttribute('type'), inputmode: el.getAttribute('inputmode'), value: el.value }; })()`);
      assert(meta.type === "text" && meta.inputmode === "numeric", JSON.stringify(meta));
      assert(await cdp.evaluate(setValue('[data-testid="edit-deal-max"]', "4.5")), "type decimal into max");
      const v = await cdp.evaluate(`document.querySelector('[data-testid="edit-deal-max"]').value`);
      assert(v === "45", `decimal → digits (${v})`);
      const spinners = await cdp.evaluate(`[...document.querySelectorAll('input[type="number"]')].filter(i => /min|max|qty|units/.test(i.id + i.dataset.testid)).length`);
      assert(spinners === 0, `${spinners} number-typed quantity inputs remain`);
      await cdp.shot(shotName(390, "31_seller_qty_typed"));
      return check("seller draft qty @390", meta);
    });

    // ═══ A4 — legal native ═════════════════════════════════════════════════
    for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
      await cdp.viewport(w, h, mobile);
      await run(`A4 @${w} footer 'תקנון' → native #/legal/terms inside the product shell (same header + footer), title from the canonical source, chips switch to privacy / refunds`, async () => {
        await cdp.navigate(`${BASE}/preview/#/support`);
        await waitFor(cdp, exists('[data-testid="footer-legal-terms"]'), 30000, "footer");
        assert(await cdp.evaluate(click('[data-testid="footer-legal-terms"]')), "click footer terms");
        await waitFor(cdp, exists('[data-testid="legal-page"][data-legal-slug="terms"]'), 20000, "terms page");
        assert((await cdp.evaluate("location.hash")) === "#/legal/terms", "hash route");
        assert(await cdp.evaluate(exists('.topbar')) && await cdp.evaluate(exists('footer.footer')), "product header + footer around the document");
        const body = await cdp.evaluate(text('[data-testid="legal-page"]'));
        assert(body.includes("תקנון שימוש ותנאי שירות C-ton") && body.includes("גרסה 0.9"), body.slice(0, 120));
        assert(await cdp.evaluate(`document.querySelectorAll('[data-testid="legal-page"] h2').length`) > 5, "sections rendered as headings");
        const font = await cdp.evaluate(`getComputedStyle(document.querySelector('[data-testid="legal-page"] p')).fontFamily`);
        const shellFont = await cdp.evaluate(`getComputedStyle(document.querySelector('.topbar')).fontFamily`);
        assert(font === shellFont, `typography differs from the shell: ${font} vs ${shellFont}`);
        await cdp.shot(shotName(w, "40_legal_terms"));
        const r = await check(`legal terms @${w}`);
        assert(await cdp.evaluate(click('[data-testid="legal-nav"] a[href="#/legal/privacy"]')), "privacy chip");
        await waitFor(cdp, exists('[data-testid="legal-page"][data-legal-slug="privacy"]'), 20000, "privacy page");
        assert((await cdp.evaluate(text('[data-testid="legal-page"]'))).includes("מדיניות פרטיות C-ton"), "privacy title");
        assert(await cdp.evaluate(click('[data-testid="legal-nav"] a[href="#/legal/refunds"]')), "refunds chip");
        await waitFor(cdp, exists('[data-testid="legal-page"][data-legal-slug="refunds"]'), 20000, "refunds page");
        assert((await cdp.evaluate(text('[data-testid="legal-page"]'))).includes("מדיניות ביטולים, החזרים ושחרור מסגרת"), "refunds title");
        return r;
      });
    }
    await run("A4 direct legacy URL /legal/privacy lands on the React document (302 → /preview/#/legal/privacy)", async () => {
      await cdp.navigate(`${BASE}/legal/privacy`);
      await waitFor(cdp, exists('[data-testid="legal-page"][data-legal-slug="privacy"]'), 30000, "privacy via redirect");
      const href = await cdp.evaluate("location.href");
      assert(href.endsWith("/preview/#/legal/privacy"), href);
      return { href };
    });
    await run("A4 an unknown document answers a product empty state, not a crash", async () => {
      expectedFailures = [/\/api\/legal\/nope/];
      await cdp.navigate(`${BASE}/preview/#/legal/nope`);
      await waitFor(cdp, exists('[data-testid="legal-error"]'), 20000, "legal empty state");
      const t = await cdp.evaluate(text('[data-testid="legal-error"]'));
      assert(t.includes("המסמך המבוקש לא נמצא"), t);
      expectedFailures = [];
      return check("legal 404 @1280");
    });

    // ═══ A5 — scroll restoration ═══════════════════════════════════════════
    for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
      await cdp.viewport(w, h, mobile);
      await run(`A5 @${w} deal deep → Support → Back restores the exact position (±40px) → Forward restores Support's own position; a NEW page starts at the top`, async () => {
        await cdp.navigate(`${BASE}/preview/#/deal/${dealOpen}`);
        await waitFor(cdp, exists('[data-testid="join-open"]'), 30000, "deal");
        await settle(800);
        const max = await maxScroll();
        assert(max > 600, `deal page too short to prove restoration (max ${max})`);
        const target = Math.min(1200, max - 40);
        const before = await scrollTo(target);
        await settle(300);
        assert(Math.abs(before - target) <= 2, `scrolled to ${before}`);
        // deliberate navigation to a NEW page → top
        assert(await cdp.evaluate(click('a[href="#/support"]')), "support link");
        await waitFor(cdp, exists('[data-testid="footer-legal-terms"]') , 20000, "support");
        await waitFor(cdp, `location.hash === "#/support"`, 5000, "support hash");
        await settle(500);
        const supportTop = await scrollY();
        assert(supportTop <= 4, `new page must start at the top (scrollY ${supportTop})`);
        const supportMax = await maxScroll();
        const supportPos = Math.min(300, supportMax);
        await scrollTo(supportPos); await settle(300);
        // Back
        await cdp.evaluate("history.back(); true");
        await waitFor(cdp, `location.hash.startsWith("#/deal/")`, 5000, "back to deal");
        await waitFor(cdp, exists('[data-testid="join-open"]'), 20000, "deal re-rendered");
        await settle(1200);
        const restored = await scrollY();
        assert(Math.abs(restored - before) <= 40, `Back restored ${restored}, expected ≈${before}`);
        // Forward
        await cdp.evaluate("history.forward(); true");
        await waitFor(cdp, `location.hash === "#/support"`, 5000, "forward to support");
        await settle(1000);
        const fwd = await scrollY();
        assert(Math.abs(fwd - supportPos) <= 40, `Forward restored ${fwd}, expected ≈${supportPos}`);
        return { deal_before: before, deal_restored: restored, support_pos: supportPos, support_forward: fwd };
      });
      await run(`A5 @${w} deal deep → legal page → Back restores (±40px)`, async () => {
        await cdp.navigate(`${BASE}/preview/#/deal/${dealOpen}`);
        await waitFor(cdp, exists('[data-testid="join-open"]'), 30000, "deal");
        await settle(800);
        const target = Math.min(900, (await maxScroll()) - 40);
        const before = await scrollTo(target); await settle(300);
        assert(await cdp.evaluate(click('[data-testid="footer-legal-terms"]')), "footer terms");
        await waitFor(cdp, exists('[data-testid="legal-page"]'), 20000, "legal");
        await settle(600);
        const legalTop = await scrollY();
        assert(legalTop <= 4, `legal starts at the top (scrollY ${legalTop}, max ${await maxScroll()})`);
        const legalPos = Math.min(700, await maxScroll());
        await scrollTo(legalPos); await settle(300);
        await cdp.evaluate("history.back(); true");
        await waitFor(cdp, `location.hash.startsWith("#/deal/")`, 5000, "back");
        await waitFor(cdp, exists('[data-testid="join-open"]'), 20000, "deal re-rendered");
        await settle(1200);
        const restored = await scrollY();
        assert(Math.abs(restored - before) <= 40, `Back restored ${restored}, expected ≈${before}`);
        await cdp.evaluate("history.forward(); true");
        await waitFor(cdp, `location.hash === "#/legal/terms"`, 5000, "forward");
        await settle(1000);
        const fwd = await scrollY();
        assert(Math.abs(fwd - legalPos) <= 40, `Forward restored ${fwd}, expected ≈${legalPos}`);
        return { deal_before: before, deal_restored: restored, legal_pos: legalPos, legal_forward: fwd };
      });
    }

    // ═══ A6 / A7 / A8 — admin ═══════════════════════════════════════════════
    for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
      await cdp.viewport(w, h, mobile);
      await run(`A6 @${w} admin buyers: 'ש' → every displayed name contains ש (intent + match reason shown); 'shani' (an e-mail) finds nobody; digits find the phone`, async () => {
        await cdp.navigate(`${BASE}/preview/#/admin/buyers`);
        await waitFor(cdp, exists('[data-testid="buyer-search"]'), 30000, "buyers screen");
        assert(await cdp.evaluate(setValue('[data-testid="buyer-search"]', "ש")), "type ש");
        await waitFor(cdp, `document.querySelector('[data-testid="buyer-search-intent"]')?.getAttribute('data-intent') === 'name' && document.querySelectorAll('[data-testid="buyer-row"]').length > 0`, 15000, "name results");
        const names = await cdp.evaluate(`[...document.querySelectorAll('[data-testid="buyer-row"]')].map(r => r.getAttribute('data-buyer-name'))`);
        assert(names.length >= 2, `expected Sara + Moshe, got ${JSON.stringify(names)}`);
        for (const n of names) assert(n.includes("ש"), `displayed name without ש: ${n}`);
        assert(!names.some((n) => n.includes("דוד")), "David (no ש) must not appear");
        const intent = await cdp.evaluate(text('[data-testid="buyer-search-intent"]'));
        assert(intent.includes("חיפוש לפי שם"), intent);
        const reasons = await cdp.evaluate(`[...document.querySelectorAll('[data-testid="buyer-row-match"]')].map(r => r.innerText.trim())`);
        assert(reasons.every((r) => r === "התאמה בשם"), JSON.stringify(reasons));
        await cdp.shot(shotName(w, "50_admin_buyers_shin"));
        const r = await check(`admin buyers @${w}`, { names });
        assert(await cdp.evaluate(setValue('[data-testid="buyer-search"]', "shani")), "type shani");
        await waitFor(cdp, `document.querySelector('[data-testid="buyer-search-intent"]')?.getAttribute('data-intent') === 'name' && document.querySelectorAll('[data-testid="buyer-row"]').length === 0 && document.body.innerText.includes('אין קונים תואמים')`, 15000, "no e-mail leak");
        assert(await cdp.evaluate(setValue('[data-testid="buyer-search"]', `053${stamp.slice(0, 4)}`)), "type digits");
        await waitFor(cdp, `document.querySelector('[data-testid="buyer-search-intent"]')?.getAttribute('data-intent') === 'phone' && [...document.querySelectorAll('[data-testid="buyer-row"]')].some(r => r.getAttribute('data-buyer-name') === 'דוד כהן')`, 15000, "phone result");
        const phoneReasons = await cdp.evaluate(`[...document.querySelectorAll('[data-testid="buyer-row-match"]')].map(r => r.innerText.trim())`);
        assert(phoneReasons.every((x) => x === "התאמה בטלפון"), JSON.stringify(phoneReasons));
        return r;
      });
      await run(`A7+A8 @${w} admin growth: heading + nav read 'ויראליות'; default 7 days drives the windowed block; 30 / 90 / custom / all-time switch the actual window; lifetime block labelled`, async () => {
        await cdp.navigate(`${BASE}/preview/#/admin/growth`);
        await waitFor(cdp, exists('[data-testid="growth-windowed"]'), 30000, "growth windowed");
        const h1 = await cdp.evaluate(text('.admin-shell h1'));
        assert(h1.trim() === "ויראליות", `heading ${h1}`);
        const body = await cdp.evaluate("document.body.innerText");
        assert(!body.includes("צמיחה וויראליות"), "old copy still visible");
        const navItem = await cdp.evaluate(`[...document.querySelectorAll('.admin-nav a, .admin-nav button')].map(a => a.innerText.trim()).find(t => t === 'ויראליות') || ''`);
        assert(navItem === "ויראליות", "nav item");
        const label = await cdp.evaluate(text('[data-testid="growth-window-label"]'));
        assert(label.includes("7 הימים האחרונים") && (await cdp.evaluate(attr('[data-testid="growth-window-label"]', "data-window-kind"))) === "days", `default ${label}`);
        const tiles7 = await cdp.evaluate(text('[data-testid="growth-windowed"]'));
        assert(/הצטרפויות משיתוף/.test(tiles7), tiles7.slice(0, 120));
        assert((await cdp.evaluate(text('[data-testid="growth-lifetime"]'))).includes("מצטבר מאז ההשקה (כל הזמן)"), "lifetime block labelled");
        await cdp.shot(shotName(w, "60_admin_growth_7d"));
        const r = await check(`admin growth @${w}`);
        for (const days of [30, 90]) {
          assert(await cdp.evaluate(click(`[data-testid="growth-range-${days}"]`)), `chip ${days}`);
          await waitFor(cdp, `(document.querySelector('[data-testid="growth-window-label"]')?.innerText || '').includes('${days} הימים האחרונים')`, 10000, `label ${days}`);
          await waitFor(cdp, exists('[data-testid="growth-windowed"]'), 15000, `windowed ${days}`);
        }
        assert(await cdp.evaluate(click('[data-testid="growth-range-custom"]')), "custom chip");
        await waitFor(cdp, exists('[data-testid="growth-custom-from"]'), 5000, "custom inputs");
        const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
        const from = iso(new Date(today.getTime() - 3 * 864e5)); const to = iso(today);
        assert(await cdp.evaluate(setValue('[data-testid="growth-custom-to"]', from)), "to");
        assert(await cdp.evaluate(setValue('[data-testid="growth-custom-from"]', to)), "from > to");
        assert(await cdp.evaluate(click('[data-testid="growth-custom-apply"]')), "apply inverted");
        await waitFor(cdp, exists('[data-testid="growth-custom-error"]'), 5000, "inverted refused");
        assert(await cdp.evaluate(setValue('[data-testid="growth-custom-from"]', from)), "from");
        assert(await cdp.evaluate(setValue('[data-testid="growth-custom-to"]', to)), "to");
        assert(await cdp.evaluate(click('[data-testid="growth-custom-apply"]')), "apply");
        await waitFor(cdp, `document.querySelector('[data-testid="growth-window-label"]')?.getAttribute('data-window-kind') === 'custom' && (document.querySelector('[data-testid="growth-window-label"]')?.innerText || '').includes('${from} עד ${to}')`, 10000, "custom label");
        await waitFor(cdp, exists('[data-testid="growth-windowed"]'), 15000, "windowed custom");
        const custom = await cdp.evaluate(text('[data-testid="growth-windowed"]'));
        assert(/הצטרפויות משיתוף/.test(custom), "custom window data");
        await cdp.shot(shotName(w, "61_admin_growth_custom"));
        assert(await cdp.evaluate(click('[data-testid="growth-range-all"]')), "all chip");
        await waitFor(cdp, `document.querySelector('[data-testid="growth-window-label"]')?.getAttribute('data-window-kind') === 'all'`, 10000, "all label");
        await waitFor(cdp, exists('[data-testid="growth-windowed"]'), 15000, "windowed all");
        return r;
      });
    }

    await run("0 console errors + 0 failed essential requests across the whole proof", async () => {
      assert(consoleErrors.length === 0, `console errors:\n${consoleErrors.join("\n")}`);
      assert(failedRequests.length === 0, `failed requests:\n${failedRequests.join("\n")}`);
      const overflowFails = pageChecks.filter((p) => !p.overflow_ok);
      return { pages: pageChecks.length, overflow_failures: overflowFails.length };
    });
  } finally {
    cdp.close(); browser.kill("SIGKILL"); await db.end();
  }
  writeFileSync(join(SHOTS, "results.json"), JSON.stringify({ base: BASE, tag, dealOpen, dealAddr, dealDone, dealDraft, passed, failed, results, pageChecks, consoleErrors, failedRequests }, null, 2));
  console.log(`\nSPRINT4_UX_CLEANUP_PROOF passed=${passed} failed=${failed} page_checks=${pageChecks.length} shots=${SHOTS}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
