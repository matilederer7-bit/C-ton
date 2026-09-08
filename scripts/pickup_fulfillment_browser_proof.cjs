#!/usr/bin/env node
// LAUNCH SPRINT 3 — physical pickup handoff, browser proof (headless Edge CDP)
// against a local demo-preview runtime that serves the built React bundle.
//
// Usage: DATABASE_URL=<runtime db> node scripts/pickup_fulfillment_browser_proof.cjs
//        [BASE_URL=http://127.0.0.1:3215] [SHOTS=<dir>]
// The runtime must run with RATE_LIMIT_MAX=10000 RATE_LIMIT_READ_MAX=5000
// RATE_LIMIT_SENSITIVE_MAX=500 (three simulated devices from one IP) and the
// React bundle must be built (cd web && npm run build).
//
// Proves at 390 / 430 (buyer) and 390 / 430 / 1280 (seller): the pickup card
// with code + QR + full-screen mode; the seller scanner (camera granted via
// the fake device, camera denied via an injected NotAllowedError, typed code,
// phone/name search, QR deep link = what a phone camera does with our QR);
// GREEN → explicit confirmation naming qty/product/buyer → נמסר; a repeat
// resolve = AMBER "כבר נמסר"; RED for an unpaid buyer; invalid code; the deal
// fulfillment list moving pending → fulfilled; 0 console errors, 0 failed
// essential requests, no horizontal overflow, no unreadable text.
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { Client } = require("pg");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3215").replace(/\/+$/, "");
const SHOTS = process.env.SHOTS || join(tmpdir(), "siton-pickup-shots");
mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/microsoft-edge", "/usr/bin/google-chrome"].find(existsSync);
if (!EDGE) { console.error("Edge not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0; const results = [];
async function run(name, fn) {
  try { const d = await fn(); passed++; results.push({ name, ok: true, detail: d ?? null }); console.log(`PASS ${name}${d ? ` — ${typeof d === "string" ? d : JSON.stringify(d).slice(0, 220)}` : ""}`); }
  catch (e) { failed++; results.push({ name, ok: false, error: String(e.message || e) }); console.error(`FAIL ${name}: ${String(e.message || e).slice(0, 700)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const tag = randomBytes(3).toString("hex");

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const h = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

// ── CDP (same harness as scripts/buyer_polish_browser_proof.cjs) ──────────
async function openBrowser(extraArgs = []) {
  const profileDir = join(tmpdir(), `siton-pickup-proof-${Date.now()}`);
  const port = 37_000 + Math.floor(Math.random() * 1000);
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
const NO_OVERFLOW = `document.documentElement.scrollWidth <= window.innerWidth + 2`;
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`;
const exists = (sel) => `Boolean(document.querySelector(${JSON.stringify(sel)}))`;
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText || "")`;
const attr = (sel, name) => `(document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) || "")`;
const setValue = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const visibleInViewport = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= window.innerWidth + 1; })()`;
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
    await db.query(`SELECT set_config('siton.action_name', 'test.pickup_proof_fixture', true)`);
    for (const b of ["LockedIn", "ChargingAttempt", "ChargedSuccess", "DealCompleted"]) await db.query(`UPDATE siton.participants SET buyer_state=$2 WHERE participant_id=$1`, [participantId, b]);
    for (const m of ["AuthLocked", "ChargeAttempt", "ChargedSuccess"]) await db.query(`UPDATE siton.participants SET money_state=$2 WHERE participant_id=$1`, [participantId, m]);
  });
}

async function otp(phone) {
  const s = await call("/api/otp/start", { method: "POST", body: { phone } });
  assert(s.status === 200, `otp start ${s.status} ${s.text.slice(0, 120)}`);
  const v = await call("/api/otp/verify", { method: "POST", body: { otp_session_id: s.json.otp_session_id, code: s.json.development_code } });
  assert(v.status === 200, `otp verify ${v.status} ${v.text.slice(0, 120)}`);
  return { buyer_id: v.json.buyer_id, otp_token: v.json.otp_token, otp_challenge_id: v.json.challenge_id || v.json.otp_session_id };
}
async function joinBuyer(dealId, { phone, name, qty, optionType, address, city }) {
  // demo-preview: buyer verification is off (same as scripts/buyer_polish_browser_proof.cjs); the OTP
  // rail is exercised by the API suites. The phone IS the buyer id here.
  const pub = await call(`/api/deals/${dealId}/public`);
  const opt = (pub.json.deal.delivery_options || []).find((x) => x.option_type === optionType);
  assert(opt, `no ${optionType} option`);
  const r = await call(`/api/deals/${dealId}/join`, { method: "POST", headers: { "idempotency-key": `pp-join-${randomUUID()}` }, body: {
    buyer_id: phone, buyer_name: name, qty, delivery_option_id: opt.option_id, buyer_terms_accepted: true, payment_disclosure_accepted: true,
    payment_method: "credit_card", ...(address ? { delivery_address: address, delivery_city: city } : {})
  } });
  assert(r.status === 200, `join ${name} ${r.status} ${r.text.slice(0, 200)}`);
  return { participant_id: r.json.participant_id, token: r.json.tracking_access_token };
}

(async () => {
  console.log(`PICKUP_FULFILLMENT_PROOF base=${BASE} tag=${tag}`);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // ── fixtures through the product API (default demo seller = the React seller)
  const profile = await call("/api/seller/business-profile", { method: "PUT", body: { business_name: `חנות הספרים ${tag}`, business_id_number: "515000003", contact_name: "בודק", contact_phone: "0501234567" } });
  assert(profile.status === 200, `profile ${profile.status} ${profile.text.slice(0, 200)}`);
  const deadline = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
  const created = await call("/api/deals", { method: "POST", headers: { "idempotency-key": `pp-${randomUUID()}` }, body: {
    deal_type: "physical_product", title: `ספר X`, description_short: "ספר בכריכה קשה — מחיר קבוצתי", description: "ספר X, מהדורה מיוחדת. איסוף עצמי מחנות הספרים או משלוח.",
    price_per_unit: 60, list_price_per_unit: 90, min_units: 3, max_units: 40, deadline,
    delivery_options: [{ option_type: "pickup", label: "חנות הספרים — הרצל 12, תל אביב", cost: 0, latitude: 32.0668, longitude: 34.7647 }, { option_type: "delivery", label: "שליח עד הבית", cost: 20 }]
  } });
  assert([200, 201].includes(created.status), `create ${created.status} ${created.text.slice(0, 200)}`);
  const dealId = String(created.json.deal_id || created.json.deal?.deal_id);
  const pub = await call(`/api/deals/${dealId}/publish`, { method: "POST", headers: { "idempotency-key": `pp-pub-${randomUUID()}` }, body: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
  assert(pub.status === 200, `publish ${pub.status} ${pub.text.slice(0, 200)}`);
  const stamp = String(Date.now()).slice(-7);
  const israel = await joinBuyer(dealId, { phone: `052${stamp}`, name: "ישראל ישראלי", qty: 3, optionType: "pickup" });
  const noa = await joinBuyer(dealId, { phone: `053${stamp}`, name: "נועה כהן", qty: 2, optionType: "delivery", address: "דיזנגוף 100", city: "תל אביב" });
  const unpaidPhone = `054${stamp}`;
  const unpaid = await joinBuyer(dealId, { phone: unpaidPhone, name: "דני לא-שילם", qty: 1, optionType: "pickup" });
  await forceParticipantSettled(db, israel.participant_id);
  await forceParticipantSettled(db, noa.participant_id);
  await forceDealCompleted(db, dealId);
  // the buyer's tracking payload is the source of the code + QR payload
  const tr = await call(`/api/participants/${israel.participant_id}/tracking?t=${encodeURIComponent(israel.token)}`);
  assert(tr.status === 200 && tr.json.tracking.pickup.state === "ready", `tracking ${tr.status} ${tr.text.slice(0, 200)}`);
  const orderCode = String(tr.json.tracking.pickup.order_code);
  const qrPayload = String(tr.json.tracking.pickup.qr_payload);
  assert(/^CT-\d{4}-\d{4}$/.test(orderCode), orderCode);
  console.log(`fixture deal=${dealId} code=${orderCode} unpaid=${unpaid.participant_id}`);

  const { browser, wsUrl } = await openBrowser(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  const cdp = cdpSession(wsUrl); await cdp.ready;
  const consoleErrors = []; const failedRequests = []; let expectedFailures = [];
  await cdp.send("Runtime.enable"); await cdp.send("Log.enable"); await cdp.send("Network.enable");
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(`exception: ${msg.params.exceptionDetails?.text || ""} ${msg.params.exceptionDetails?.exception?.description || ""}`.slice(0, 240));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(`console.error: ${(msg.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 240)}`);
    if (msg.method === "Log.entryAdded" && msg.params.entry?.level === "error") {
      const url = String(msg.params.entry?.url || ""); const t = String(msg.params.entry?.text || "");
      if (/favicon/.test(url)) return;
      // the deliberate refusals (404 unknown code, 409 not ready) are product answers, not findings
      if (msg.params.entry?.source === "network" && (expectedFailures.some((re) => re.test(url + " " + t)) || /\/api\/seller\/fulfillment\/(resolve|handoff)/.test(url))) return;
      consoleErrors.push(`log: ${t.slice(0, 200)} ${url.slice(0, 120)}`);
    }
    if (msg.method === "Network.responseReceived") { const { url, status } = msg.params.response; if (status >= 500 && /\/(api|preview)\//.test(url)) failedRequests.push(`${status} ${url}`); }
    if (msg.method === "Network.loadingFailed") { if (!msg.params.canceled && expectedFailures.length === 0 && !/net::ERR_ABORTED/.test(msg.params.errorText || "")) failedRequests.push(`loadingFailed ${msg.params.errorText}`); }
  });
  const pageChecks = [];
  async function check(label, extra = {}) {
    const ok = await cdp.evaluate(NO_OVERFLOW); const w = await cdp.evaluate("window.innerWidth"); const tiny = await cdp.evaluate(LEGIBLE);
    pageChecks.push({ label, overflow_ok: ok, width: w, tiny_text: tiny, errors: consoleErrors.length });
    if (!ok) {
      const offenders = await cdp.evaluate(`(() => { const out = []; for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.right > window.innerWidth + 2 || r.width > window.innerWidth + 2) out.push(el.tagName + "." + String(el.className).slice(0, 50) + " w=" + Math.round(r.width) + " right=" + Math.round(r.right)); } return out.slice(0, 8).join(" | "); })()`);
      assert(false, `${label}: horizontal overflow at ${w}px (scrollWidth ${await cdp.evaluate("document.documentElement.scrollWidth")}) offenders: ${offenders}`);
    }
    assert(tiny === 0, `${label}: ${tiny} unreadable (<10px) text nodes`);
    return { width: w, ...extra };
  }
  const shotName = (w, name) => `${String(w).padStart(4, "0")}_${name}.png`;
  const unlockSeller = () => cdp.evaluate(`localStorage.setItem('siton_session_v1', JSON.stringify({ access_token: 'pickup-proof-token', refresh_token: '', expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: true } })); localStorage.removeItem('siton_guest_mode_v1'); true`);
  let pickupSeconds = null;

  try {
    // the device-metrics override only sticks once a real document exists in the target: warm up on the landing first
    await cdp.navigate(`${BASE}/preview/#/`);
    await waitFor(cdp, `document.readyState === "complete"`, 20000, "warm-up");
    // ═══ BUYER — 390 / 430 ══════════════════════════════════════════════
    for (const [w, h] of [[390, 844], [430, 932]]) {
      await cdp.viewport(w, h, true);
      await run(`buyer @${w}: tracking shows the pickup card — 'מוכן לאיסוף', ספר X, 3 יחידות, location, CT code, QR with the locator only, instructions`, async () => {
        await cdp.navigate(`${BASE}/preview/#/track/${israel.participant_id}?t=${encodeURIComponent(israel.token)}`);
        await waitFor(cdp, exists('[data-testid="track-pickup"][data-state="ready"]'), 30000, "pickup card");
        const code = await cdp.evaluate(text('[data-testid="pickup-code"]'));
        assert(code.trim() === orderCode, `code shown ${code} vs ${orderCode}`);
        const qr = await cdp.evaluate(attr('[data-testid="pickup-qr"]', "data-qr-value"));
        assert(qr === qrPayload, `QR value ${qr}`);
        assert(qr.includes(`code=${encodeURIComponent(orderCode)}`) && !qr.includes("ישראל") && !qr.includes(israel.participant_id) && !qr.includes(israel.token), "QR carries the locator only");
        assert(await cdp.evaluate(exists('[data-testid="pickup-qr"] svg')), "QR rendered as SVG");
        const card = await cdp.evaluate(text('[data-testid="track-pickup"]'));
        for (const needle of ["מוכן לאיסוף", "ספר X", "3 יחידות", "הרצל 12", "הציגו את הקוד למוכר", "ישראל ישראלי"]) assert(card.includes(needle), `card missing "${needle}"`);
        await cdp.evaluate(`document.querySelector('[data-testid="track-pickup"]').scrollIntoView({ block: "start" }); true`);
        await wait(150);
        assert(await cdp.evaluate(visibleInViewport('[data-testid="pickup-fullscreen-open"]')), "CTA reachable");
        await cdp.shot(shotName(w, "01_buyer_pickup_card"));
        return check(`buyer pickup @${w}`, { code: orderCode });
      });
      await run(`buyer @${w}: 'הצגת קוד לאיסוף' opens the full-screen counter mode (large QR + code + qty + location), Escape/close returns`, async () => {
        assert(await cdp.evaluate(click('[data-testid="pickup-fullscreen-open"]')), "click fullscreen");
        await waitFor(cdp, exists('[data-testid="pickup-fullscreen"]'), 5000, "fullscreen");
        const code = await cdp.evaluate(text('[data-testid="pickup-fullscreen-code"]'));
        assert(code.trim() === orderCode, `fullscreen code ${code}`);
        const body = await cdp.evaluate(text('[data-testid="pickup-fullscreen"]'));
        assert(body.includes("3 יחידות") && body.includes("הרצל 12") && body.includes("ספר X"), "fullscreen facts");
        const qrBox = await cdp.evaluate(`(() => { const r = document.querySelector('[data-testid="pickup-fullscreen"] [data-testid="pickup-qr"]').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; })()`);
        assert(qrBox.w >= 240 && qrBox.h >= 240, `QR large enough: ${JSON.stringify(qrBox)}`);
        const bg = await cdp.evaluate(`getComputedStyle(document.querySelector('[data-testid="pickup-fullscreen"]')).backgroundColor`);
        assert(/255, 255, 255/.test(bg), `high-contrast white ground (${bg})`);
        await cdp.shot(shotName(w, "02_buyer_pickup_fullscreen"));
        const r = await check(`buyer fullscreen @${w}`, { qr: qrBox });
        assert(await cdp.evaluate(click('[data-testid="pickup-fullscreen-close"]')), "close");
        await wait(200);
        assert(!(await cdp.evaluate(exists('[data-testid="pickup-fullscreen"]'))), "fullscreen closed");
        return r;
      });
    }
    await run("buyer @390: an unpaid buyer on the completed deal sees 'ההזמנה עדיין לא מוכנה למסירה' with no code and no QR", async () => {
      await cdp.viewport(390, 844, true);
      await cdp.navigate(`${BASE}/preview/#/track/${unpaid.participant_id}?t=${encodeURIComponent(unpaid.token)}`);
      await waitFor(cdp, exists('[data-testid="track-pickup"]'), 30000, "pickup card (unpaid)");
      const state = await cdp.evaluate(attr('[data-testid="track-pickup"]', "data-state"));
      assert(state === "payment_pending", `state ${state}`);
      const card = await cdp.evaluate(text('[data-testid="track-pickup"]'));
      assert(card.includes("ההזמנה עדיין לא מוכנה למסירה"), card.slice(0, 200));
      assert(!(await cdp.evaluate(exists('[data-testid="pickup-code"]'))) && !(await cdp.evaluate(exists('[data-testid="pickup-qr"]'))), "no credential before payment");
      await cdp.shot(shotName(390, "03_buyer_not_ready"));
      return check("buyer not-ready @390");
    });

    // ═══ SELLER — 390 / 430 / 1280 ═══════════════════════════════════════
    await cdp.navigate(`${BASE}/preview/#/`);
    await waitFor(cdp, `document.readyState === "complete"`, 20000, "landing");
    await unlockSeller();
    for (const [w, h, mobile] of [[390, 844, true], [430, 932, true], [1280, 900, false]]) {
      await cdp.viewport(w, h, mobile);
      await run(`seller @${w}: the dashboard exposes 'סריקת איסוף' and the completed deal card offers 'הזמנות למסירה'`, async () => {
        await cdp.navigate(`${BASE}/preview/#/seller`);
        await waitFor(cdp, exists('[data-testid="dash-pickup-scan"]'), 30000, "dashboard scan button");
        await waitFor(cdp, exists('[data-testid="card-fulfillment-open"]'), 30000, "completed card fulfillment button");
        await cdp.shot(shotName(w, "10_seller_dashboard"));
        return check(`seller dashboard @${w}`);
      });
      await run(`seller @${w}: scanner page — camera GRANTED reaches 'scanning' on the fake device; typed-code and search tabs are always present`, async () => {
        await cdp.navigate(`${BASE}/preview/#/seller/pickup`);
        await waitFor(cdp, exists('[data-testid="seller-pickup-page"]'), 30000, "pickup page");
        assert(await cdp.evaluate(exists('[data-testid="pickup-tab-type"]')) && await cdp.evaluate(exists('[data-testid="pickup-tab-search"]')), "fallback tabs");
        assert(await cdp.evaluate(click('[data-testid="pickup-camera-start"]')), "start camera");
        const outcome = await waitFor(cdp, `(() => { const o = document.querySelector('[data-outcome]')?.getAttribute('data-outcome'); return o && o !== 'starting' && o !== 'idle' ? o : null; })()`, 15000, "camera outcome");
        assert(outcome === "scanning", `granted camera outcome ${outcome}`);
        assert(await cdp.evaluate(exists('[data-testid="pickup-scan-scanning"]')), "scanning copy visible");
        await cdp.shot(shotName(w, "11_seller_scanner_scanning"));
        const r = await check(`seller scanner @${w}`, { outcome });
        assert(await cdp.evaluate(click('[data-testid="pickup-camera-stop"]')), "stop camera");
        return r;
      });
      await run(`seller @${w}: camera DENIED (NotAllowedError) → named outcome with the typed-code fallback, never a trap`, async () => {
        await cdp.navigate(`${BASE}/preview/#/seller/pickup`);
        await waitFor(cdp, exists('[data-testid="pickup-camera-start"]'), 30000, "pickup page");
        await cdp.evaluate(`navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); true`);
        assert(await cdp.evaluate(click('[data-testid="pickup-camera-start"]')), "start camera");
        await waitFor(cdp, exists('[data-testid="pickup-scan-permission-denied"]'), 10000, "denied outcome");
        const copy = await cdp.evaluate(text('[data-testid="pickup-scan-permission-denied"]'));
        assert(copy.includes("להקליד את הקוד"), copy);
        assert(await cdp.evaluate(visibleInViewport('[data-testid="pickup-switch-type"]')), "typed fallback reachable");
        await cdp.shot(shotName(w, "12_seller_camera_denied"));
        return check(`camera denied @${w}`);
      });
      await run(`seller @${w}: typed code — an invalid code answers 'הקוד אינו תקין' (RED shape, no PII); the real code answers GREEN`, async () => {
        await cdp.navigate(`${BASE}/preview/#/seller/pickup`);
        await waitFor(cdp, exists('[data-testid="pickup-tab-type"]'), 30000, "pickup page");
        assert(await cdp.evaluate(click('[data-testid="pickup-tab-type"]')), "type tab");
        await waitFor(cdp, exists('[data-testid="pickup-code-input"]'), 5000, "code input");
        assert(await cdp.evaluate(setValue('[data-testid="pickup-code-input"]', "0000-0000")), "type bad code");
        assert(await cdp.evaluate(click('[data-testid="pickup-code-submit"]')), "submit");
        await waitFor(cdp, exists('[data-testid="handoff-result"][data-verdict="not_found"]'), 15000, "not found card");
        const bad = await cdp.evaluate(text('[data-testid="handoff-verdict"]'));
        assert(bad.includes("הקוד אינו תקין"), bad);
        assert(!(await cdp.evaluate(text('[data-testid="handoff-result"]'))).includes("ישראל"), "no PII on the refusal");
        await cdp.shot(shotName(w, "13_seller_invalid_code"));
        assert(await cdp.evaluate(setValue('[data-testid="pickup-code-input"]', orderCode.replace(/\D/g, ""))), "type real code");
        assert(await cdp.evaluate(click('[data-testid="pickup-code-submit"]')), "submit");
        const verdict = await waitFor(cdp, `document.querySelector('[data-testid="handoff-result"]')?.getAttribute('data-verdict') === 'ready' || document.querySelector('[data-testid="handoff-result"]')?.getAttribute('data-verdict') === 'already_fulfilled' ? document.querySelector('[data-testid="handoff-result"]').getAttribute('data-verdict') : null`, 15000, "resolved card");
        assert(["ready", "already_fulfilled"].includes(verdict), verdict);
        await cdp.shot(shotName(w, "14_seller_typed_resolved"));
        return check(`typed code @${w}`, { verdict });
      });
    }

    // ═══ The counter moment at 390: QR deep link → GREEN → confirm → נמסר → repeat = AMBER
    await cdp.viewport(390, 844, true);
    await run("seller @390: scanning the buyer's QR (deep link a phone camera opens) → GREEN 'מוכן למסירה' with buyer, product, qty 3, 'שולם ✓', method, code; CTA names the quantity", async () => {
      const t0 = Date.now();
      await cdp.navigate(`${BASE}/preview/#/seller/pickup?code=${encodeURIComponent(orderCode)}`);
      await waitFor(cdp, exists('[data-testid="handoff-result"][data-verdict="ready"]'), 30000, "green card");
      const card = await cdp.evaluate(text('[data-testid="handoff-result"]'));
      for (const needle of ["מוכן למסירה", "ישראל ישראלי", "ספר X", "3 יחידות", "שולם", "איסוף עצמי", orderCode]) assert(card.includes(needle), `green card missing "${needle}"`);
      const cta = await cdp.evaluate(text('[data-testid="handoff-confirm-open"]'));
      assert(cta.includes("אישור מסירה") && cta.includes("3"), `CTA ${cta}`);
      assert(await cdp.evaluate(visibleInViewport('[data-testid="handoff-confirm-open"]')), "CTA reachable");
      const state = await cdp.evaluate(attr('[data-testid="handoff-result"]', "data-state"));
      assert(state === "ready", state);
      await cdp.shot(shotName(390, "20_seller_green"));
      pickupSeconds = { resolved_ms: Date.now() - t0 };
      return check("green card @390", pickupSeconds);
    });
    await run("seller @390: explicit confirmation names qty/product/buyer ('אתם מוסרים עכשיו 3 יחידות של ספר X לישראל ישראלי.'), warns all 3 units, offers חזרה; confirm → 'נמסר'", async () => {
      const t0 = Date.now();
      assert(await cdp.evaluate(click('[data-testid="handoff-confirm-open"]')), "open confirm");
      await waitFor(cdp, exists('[data-testid="handoff-confirm-line"]'), 5000, "confirm sheet");
      const line = await cdp.evaluate(text('[data-testid="handoff-confirm-line"]'));
      assert(line.replace(/\s+/g, " ").includes("אתם מוסרים עכשיו 3 יחידות של ספר X לישראל ישראלי"), line);
      const sheet = await cdp.evaluate(text('.modal'));
      assert(sheet.includes("אישור המסירה מסמן את כל 3 היחידות כנמסרו"), "qty>1 warning");
      assert(await cdp.evaluate(visibleInViewport('[data-testid="handoff-confirm"]')) && await cdp.evaluate(visibleInViewport('[data-testid="handoff-confirm-back"]')), "both actions reachable, not clipped");
      await cdp.shot(shotName(390, "21_seller_confirm_sheet"));
      const r = await check("confirm sheet @390");
      assert(await cdp.evaluate(click('[data-testid="handoff-confirm"]')), "confirm");
      await waitFor(cdp, exists('[data-testid="handoff-done"][data-state="done"]'), 15000, "done state");
      const done = await cdp.evaluate(text('[data-testid="handoff-done"]'));
      assert(done.includes("נמסר") && done.includes("3 יחידות") && done.includes("ספר X"), done.slice(0, 200));
      pickupSeconds = { ...pickupSeconds, confirm_ms: Date.now() - t0, total_s: Math.round(((pickupSeconds?.resolved_ms || 0) + (Date.now() - t0)) / 100) / 10 };
      await cdp.shot(shotName(390, "22_seller_done"));
      const units = await db.query(`SELECT count(*) FILTER (WHERE status='Redeemed')::int AS r, count(*)::int AS n FROM siton.fulfillment_units WHERE participant_id=$1`, [israel.participant_id]);
      assert(units.rows[0].r === 3 && units.rows[0].n === 3, `db units ${JSON.stringify(units.rows[0])}`);
      const money = await db.query(`SELECT money_state, buyer_state FROM siton.participants WHERE participant_id=$1`, [israel.participant_id]);
      assert(money.rows[0].money_state === "ChargedSuccess" && money.rows[0].buyer_state === "DealCompleted", "money untouched");
      return { ...r, ...pickupSeconds };
    });
    await run("seller @390: a repeat scan of the same QR answers AMBER 'כבר נמסר' with the time — no active fulfil button", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller/pickup?code=${encodeURIComponent(orderCode)}`);
      await waitFor(cdp, exists('[data-testid="handoff-result"][data-verdict="already_fulfilled"]'), 30000, "amber card");
      const card = await cdp.evaluate(text('[data-testid="handoff-result"]'));
      assert(card.includes("כבר נמסר") && card.includes("נמסר ב-") && card.includes(orderCode), card.slice(0, 200));
      assert(!(await cdp.evaluate(exists('[data-testid="handoff-confirm-open"]'))), "no fulfil button on amber");
      await cdp.shot(shotName(390, "23_seller_amber"));
      return check("amber @390");
    });
    await run("seller @390: buyer tracking now says 'ההזמנה נמסרה' with the recorded time", async () => {
      await cdp.navigate(`${BASE}/preview/#/track/${israel.participant_id}?t=${encodeURIComponent(israel.token)}`);
      await waitFor(cdp, exists('[data-testid="track-pickup"][data-state="fulfilled"]'), 30000, "fulfilled card");
      const card = await cdp.evaluate(text('[data-testid="track-pickup"]'));
      assert(card.includes("ההזמנה נמסרה") && card.includes("נמסר:") && card.includes(orderCode), card.slice(0, 200));
      assert(!(await cdp.evaluate(exists('[data-testid="pickup-fullscreen-open"]'))), "no active credential after handoff");
      await cdp.shot(shotName(390, "24_buyer_fulfilled"));
      return check("buyer fulfilled @390");
    });
    await run("seller @390: phone search finds the UNPAID buyer → RED 'אין למסור את ההזמנה' + 'התשלום לא הושלם'; name search finds ישראל (amber)", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller/pickup`);
      await waitFor(cdp, exists('[data-testid="pickup-tab-search"]'), 30000, "pickup page");
      assert(await cdp.evaluate(click('[data-testid="pickup-tab-search"]')), "search tab");
      await waitFor(cdp, exists('[data-testid="pickup-search-input"]'), 5000, "search input");
      assert(await cdp.evaluate(setValue('[data-testid="pickup-search-input"]', unpaidPhone.slice(-7))), "type phone");
      assert(await cdp.evaluate(click('[data-testid="pickup-search-submit"]')), "search");
      await waitFor(cdp, exists('[data-testid="pickup-search-hit"]'), 15000, "search hit");
      assert(await cdp.evaluate(click('[data-testid="pickup-search-hit"]')), "open hit");
      await waitFor(cdp, exists('[data-testid="handoff-result"][data-state="blocked"]'), 10000, "red card");
      const card = await cdp.evaluate(text('[data-testid="handoff-result"]'));
      assert(card.includes("אין למסור את ההזמנה") && card.includes("התשלום לא הושלם"), card.slice(0, 200));
      assert(!(await cdp.evaluate(exists('[data-testid="handoff-confirm-open"]'))), "no fulfil button on red");
      await cdp.shot(shotName(390, "25_seller_red_unpaid"));
      const r = await check("red @390");
      assert(await cdp.evaluate(click('[data-testid="handoff-reset"]')), "reset");
      assert(await cdp.evaluate(click('[data-testid="pickup-tab-search"]')), "search tab");
      assert(await cdp.evaluate(setValue('[data-testid="pickup-search-input"]', "ישראל")), "type name");
      assert(await cdp.evaluate(click('[data-testid="pickup-search-submit"]')), "search");
      await waitFor(cdp, exists('[data-testid="pickup-search-hit"]'), 15000, "name hit");
      const hit = await cdp.evaluate(text('[data-testid="pickup-search-hit"]'));
      assert(hit.includes("ישראל ישראלי") && hit.includes("כבר נמסר"), hit);
      return r;
    });
    await run("seller @390: the deal's 'הזמנות למסירה' list — ממתינות shows the delivery order, נמסרו shows ישראל; confirming the delivery row moves it pending → fulfilled", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller/deal/${dealId}/fulfillment`);
      await waitFor(cdp, exists('[data-testid="fulfillment-list"], [data-testid="fulfillment-empty"]'), 30000, "list");
      const awaiting = Number(await cdp.evaluate(text('[data-testid="fulfillment-awaiting"]')));
      const fulfilled = Number(await cdp.evaluate(text('[data-testid="fulfillment-fulfilled"]')));
      assert(awaiting === 1 && fulfilled === 1, `counts awaiting=${awaiting} fulfilled=${fulfilled}`);
      const pending = await cdp.evaluate(text('[data-testid="fulfillment-list"]'));
      assert(pending.includes("נועה כהן") && pending.includes("משלוח") && pending.includes("2 יח׳"), pending.slice(0, 200));
      await cdp.shot(shotName(390, "30_fulfillment_pending"));
      const r = await check("fulfillment list @390");
      assert(await cdp.evaluate(click('[data-testid="fulfillment-row-confirm"]')), "row confirm");
      await waitFor(cdp, exists('[data-testid="handoff-confirm-open"]'), 10000, "card");
      assert(await cdp.evaluate(click('[data-testid="handoff-confirm-open"]')), "open confirm");
      await waitFor(cdp, exists('[data-testid="handoff-confirm"]'), 5000, "confirm");
      const line = await cdp.evaluate(text('[data-testid="handoff-confirm-line"]'));
      assert(line.includes("2 יחידות") && line.includes("נועה כהן"), line);
      assert(await cdp.evaluate(click('[data-testid="handoff-confirm"]')), "confirm");
      await waitFor(cdp, exists('[data-testid="handoff-done"][data-state="done"]'), 15000, "done");
      assert(await cdp.evaluate(click('[data-testid="fulfillment-filter-fulfilled"]')), "fulfilled filter");
      await waitFor(cdp, `Number(document.querySelector('[data-testid="fulfillment-fulfilled"]')?.innerText) === 2`, 15000, "fulfilled count 2");
      await waitFor(cdp, `(document.querySelector('[data-testid="fulfillment-list"]')?.innerText || '').includes('נועה כהן')`, 15000, "delivery row under fulfilled");
      const done = await cdp.evaluate(text('[data-testid="fulfillment-list"]'));
      assert(done.includes("ישראל ישראלי") && done.includes("נועה כהן"), done.slice(0, 200));
      await cdp.shot(shotName(390, "31_fulfillment_fulfilled"));
      assert(await cdp.evaluate(click('[data-testid="fulfillment-filter-pending"]')), "pending filter");
      await waitFor(cdp, exists('[data-testid="fulfillment-empty"]'), 15000, "pending empty");
      return { ...r, awaiting_before: awaiting, fulfilled_after: 2 };
    });
    await run("seller @1280: the fulfillment list and the scanner stay usable on desktop (no overflow, camera path degrades to typed code)", async () => {
      await cdp.viewport(1280, 900, false);
      await cdp.navigate(`${BASE}/preview/#/seller/deal/${dealId}/fulfillment`);
      await waitFor(cdp, exists('[data-testid="fulfillment-list"], [data-testid="fulfillment-empty"]'), 30000, "list");
      await cdp.shot(shotName(1280, "32_fulfillment_desktop"));
      return check("fulfillment @1280");
    });
    await run("0 console errors + 0 failed essential requests across the whole proof", async () => {
      assert(consoleErrors.length === 0, `console errors:\n${consoleErrors.join("\n")}`);
      assert(failedRequests.length === 0, `failed requests:\n${failedRequests.join("\n")}`);
      return { pages: pageChecks.length };
    });
  } finally {
    cdp.close(); browser.kill("SIGKILL"); await db.end();
  }
  writeFileSync(join(SHOTS, "results.json"), JSON.stringify({ base: BASE, tag, dealId, orderCode, passed, failed, results, pageChecks, consoleErrors, failedRequests, pickupSeconds }, null, 2));
  console.log(`\nPICKUP_FULFILLMENT_PROOF passed=${passed} failed=${failed} pickup_seconds=${pickupSeconds?.total_s ?? "n/a"} shots=${SHOTS}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
