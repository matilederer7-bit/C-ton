#!/usr/bin/env node
// LAUNCH POLISH SPRINT 2 — buyer browser proof @390 / @430 / @1280 (headless Edge CDP) against a local demo-preview runtime.
// Usage: DATABASE_URL=<local runtime db> node scripts/buyer_polish_browser_proof.cjs
//        [BASE_URL=http://127.0.0.1:3215] [MALL_BASE_URL=http://127.0.0.1:3216 (a runtime with PUBLIC_MALL_ENABLED=1)] [SHOTS=<dir>]
// The proof drives three "devices" from ONE IP in a couple of minutes, which trips the product's per-IP budgets
// (global RATE_LIMIT_MAX + read RATE_LIMIT_READ_MAX, default 120/min) — start the proof runtimes with
// RATE_LIMIT_MAX=10000 RATE_LIMIT_READ_MAX=5000 RATE_LIMIT_SENSITIVE_MAX=500. The limiter itself is a feature.
// Seeds: an open deal (regular price, pickup + delivery, image, one join), a sold-out deal, a paused deal, a failed deal,
// a completed deal and an expired-while-open deal. Checks, per width: landing, public deal (ten-second facts, sticky CTA on
// phones only), join sheet (required markers, field errors, refusal guidance, success), success moment (facts, tracking,
// share loop, feedback), tracking (next steps, copy link, ask seller, feedback), inquiry round trip (buyer → seller reply →
// buyer follow-up), seller login entry, mall (when MALL_BASE_URL is given), every failure state, invalid links,
// network failure. 0 console errors, 0 failed essential requests, no horizontal overflow, no hidden CTA. Local only.
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { Client } = require("pg");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3215").replace(/\/+$/, "");
const MALL_BASE = (process.env.MALL_BASE_URL || "").replace(/\/+$/, "");
const SHOTS = process.env.SHOTS || join(tmpdir(), "siton-buyer-polish-shots");
mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
if (!EDGE) { console.error("Edge not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0; const results = [];
async function run(name, fn) { try { const d = await fn(); passed++; results.push({ name, ok: true, detail: d ?? null }); console.log(`PASS ${name}${d ? ` — ${typeof d === "string" ? d : JSON.stringify(d).slice(0, 220)}` : ""}`); } catch (e) { failed++; results.push({ name, ok: false, error: String(e.message || e) }); console.error(`FAIL ${name}: ${String(e.message || e).slice(0, 600)}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const tag = randomBytes(3).toString("hex");

function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function makePng(w, h, rgb) { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = (rgb[2] + x + y) & 0xff; } } const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }

async function call(path, { method = "GET", body, headers = {}, base = BASE } = {}) {
  const h = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

// ── CDP ───────────────────────────────────────────────────────────────────
async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-buyer-proof-${Date.now()}`);
  const port = 37_000 + Math.floor(Math.random() * 1000);
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"], { stdio: "ignore", windowsHide: true });
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
    // every navigation goes through about:blank: a same-document hash change keeps React state (open sheets survive)
    async navigate(url) { await send("Page.enable"); await send("Page.navigate", { url: "about:blank" }); await wait(120); await send("Page.navigate", { url }); },
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "evaluate failed"); return res.result?.value; },
    async viewport(width, height, mobile = true) { await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }); },
    async shot(file) { const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64")); }
  };
}
async function waitFor(cdp, expr, timeoutMs = 30_000, label = "condition") { const deadline = Date.now() + timeoutMs; let last = null; while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(250); } throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`); }
const NO_OVERFLOW = `document.documentElement.scrollWidth <= window.innerWidth + 2`;
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`;
const exists = (sel) => `Boolean(document.querySelector(${JSON.stringify(sel)}))`;
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText || "")`;
const setValue = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
// legibility: nothing rendered smaller than 10px (the P0.7 countdown unit
// labels are 10.9px on narrow phones by design), nothing clipped horizontally
const LEGIBLE = `(() => { let tiny = 0; for (const el of document.querySelectorAll('body *')) { const cs = getComputedStyle(el); if (el.innerText && el.innerText.trim() && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.fontSize) < 10 && el.children.length === 0) tiny++; } return tiny; })()`;

// Forcing a published deal into a terminal state the way the product's own
// jobs do it: a valid transition chain, inside ONE transaction that carries the
// audit/outbox flags the deal trigger demands (see tests/buyer_tracking_command_center_validation.ts).
async function forceDealState(db, dealId, target) {
  const paths = {
    Completed: [
      { to: "TargetReached", action: "deal.target_reached" }, { to: "ClosedForJoining", action: "deal.close_joining" },
      { to: "ReadyForCharging", action: "deal.prepare_charging" }, { to: "Charging", action: "charging.start" },
      { to: "CompletionWindow", action: "charging.to_completion_window" }, { to: "Completed", action: "charging.finalize_completed" }
    ],
    Failed: [{ to: "Failed", action: "deal.deadline_check" }]
  };
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await db.query(`SELECT set_config('app.in_atomic', 'true', true)`);
    await db.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await db.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    for (const step of paths[target]) {
      await db.query(`SELECT set_config('siton.action_name', $1, true)`, [step.action]);
      await db.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, step.to]);
    }
    await db.query("COMMIT");
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}

(async () => {
  console.log(`BUYER_POLISH_PROOF base=${BASE} mall=${MALL_BASE || "(skipped)"} tag=${tag}`);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // ── seed through the product API (default demo seller) ───────────────────
  const deals = {};
  async function seedDeal(key, body, { joins = [], image = true } = {}) {
    const deadline = new Date(Date.now() + 2 * 24 * 3600 * 1000 + 7 * 3600 * 1000).toISOString();
    const r = await call("/api/deals", { method: "POST", headers: { "idempotency-key": `bp-${randomUUID()}` }, body: {
      deal_type: "physical_product", title: `מארז דבש בוטיק 1 ק״ג — ${key} ${tag}`,
      description_short: "דבש פרחי בר מכוורת משפחתית — מחיר קבוצתי לזמן מוגבל",
      description: "מארז דבש 1 ק״ג ישירות מהמכוורת. איסוף עצמי מהרצל 12 תל אביב או משלוח עד הבית.",
      price_per_unit: 45, list_price_per_unit: 65, min_units: 8, max_units: 30, deadline,
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, latitude: 32.0853, longitude: 34.7818 }, { option_type: "delivery", label: "משלוח עד הבית", cost: 15 }],
      ...body
    } });
    assert([200, 201].includes(r.status), `create ${key} ${r.status} ${r.text.slice(0, 200)}`);
    const id = String(r.json.deal_id || r.json.deal?.deal_id);
    if (image) {
      const img = await call(`/api/seller/deals/${id}/images`, { method: "POST", headers: { "idempotency-key": `bp-img-${id}` }, body: { mime_type: "image/png", image_base64: makePng(320, 240, [236, 102, 8]).toString("base64"), original_filename: `bp-${key}.png`, is_primary: true } });
      assert([200, 201].includes(img.status), `image ${key} ${img.status}`);
    }
    const pub = await call(`/api/deals/${id}/publish`, { method: "POST", headers: { "idempotency-key": `bp-pub-${randomUUID()}` }, body: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
    assert(pub.status === 200, `publish ${key} ${pub.status} ${pub.text.slice(0, 200)}`);
    const opt = (await call(`/api/deals/${id}/public`)).json.deal.delivery_options[0];
    for (const j of joins) {
      const jr = await call(`/api/deals/${id}/join`, { method: "POST", headers: { "idempotency-key": `bp-join-${randomUUID()}` }, body: { buyer_id: j.phone, buyer_name: j.name, qty: j.qty, delivery_option_id: opt.option_id, buyer_terms_accepted: true, payment_disclosure_accepted: true, payment_method: "credit_card" } });
      assert([200, 201].includes(jr.status), `join ${key} ${jr.status} ${jr.text.slice(0, 160)}`);
    }
    deals[key] = id;
    return id;
  }

  await run("seed: profile + 6 deals in 6 states (open / sold out / paused / failed / completed / expired-open)", async () => {
    const p = await call("/api/seller/profile", { method: "PUT", body: { business_name: `מכוורת הגליל ${tag}`, contact_name: "בודק", support_email: `bp-${tag}@siton.test`, business_description: "דבש מכוורת משפחתית" } });
    assert(p.status === 200, `profile ${p.status}`);
    await seedDeal("open", {}, { joins: [{ phone: "0501112233", name: "נועה", qty: 2 }] });
    await seedDeal("soldout", { min_units: 1, max_units: 2 }, { joins: [{ phone: "0502223344", name: "יובל", qty: 2 }], image: false });
    await seedDeal("paused", {}, { image: false });
    const pause = await call(`/api/deals/${deals.paused}/close_joining`, { method: "POST", headers: { "idempotency-key": `bp-pause-${randomUUID()}` }, body: {} });
    assert(pause.status === 200, `pause ${pause.status} ${pause.text.slice(0, 160)}`);
    await seedDeal("failed", {}, { image: false });
    await forceDealState(db, deals.failed, "Failed");
    await seedDeal("completed", {}, { image: false });
    await forceDealState(db, deals.completed, "Completed");
    // "expired while still open" = the deadline sweep has not run yet (worker lag).
    // The deadline is immutable after publish by trigger, and the sweep is the
    // worker's job, so the proof moves the DATA (not a state) with triggers off
    // for this one statement — the state machine is not touched.
    // one deal per width for the inquiry round trip (the product caps customer messages per deal per hour — a feature)
    for (const w of [390, 430, 1280]) await seedDeal(`inq${w}`, {}, { image: false });
    await seedDeal("expired", {}, { image: false });
    await db.query("BEGIN");
    await db.query(`SET LOCAL session_replication_role = replica`);
    await db.query(`UPDATE siton.deals SET deadline = now() - interval '2 minutes' WHERE deal_id=$1`, [deals.expired]);
    await db.query("COMMIT");
    return deals;
  });

  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl); await cdp.ready;
  const consoleErrors = [];
  const failedRequests = [];
  let expectedFailures = [];
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
    if (msg.method === "Network.responseReceived") {
      const { url, status } = msg.params.response;
      if (status >= 500 && /\/(api|preview)\//.test(url)) failedRequests.push(`${status} ${url}`);
    }
    if (msg.method === "Network.loadingFailed") {
      // a deliberate failure window (Fetch.failRequest for the network-failure state) is never a finding
      if (!msg.params.canceled && expectedFailures.length === 0 && !/net::ERR_ABORTED/.test(msg.params.errorText || "")) failedRequests.push(`loadingFailed ${msg.params.errorText}`);
    }
  });
  const pageChecks = [];
  async function check(label, extra = {}) {
    const ok = await cdp.evaluate(NO_OVERFLOW);
    const w = await cdp.evaluate("window.innerWidth");
    const tiny = await cdp.evaluate(LEGIBLE);
    pageChecks.push({ label, overflow_ok: ok, width: w, tiny_text: tiny, errors: consoleErrors.length });
    assert(ok, `${label}: horizontal overflow at ${w}px`);
    assert(tiny === 0, `${label}: ${tiny} unreadable (<11px) text nodes`);
    return { width: w, ...extra };
  }
  const shotName = (w, name) => `${String(w).padStart(4, "0")}_${name}.png`;

  try {
    const WIDTHS = [[390, 844, true], [430, 932, true], [1280, 900, false]];
    for (const [w, h, mobile] of WIDTHS) {
      await cdp.viewport(w, h, mobile);
      const phone = w < 861;

      await run(`landing @${w}: one-sentence explanation, buyer entry, seller CTA, pilot disclosure, no overflow`, async () => {
        await cdp.navigate(`${BASE}/preview/#/`);
        await waitFor(cdp, exists('[data-testid="landing-buyer-entry"]'), 20000, "landing");
        await wait(500);
        const snap = await cdp.evaluate(`(() => ({
          sub: document.querySelector('.landing-sub').innerText, entry: document.querySelector('[data-testid="landing-buyer-entry"]').innerText,
          pilot: document.querySelector('[data-testid="landing-pilot-note"]').innerText,
          sellerCta: [...document.querySelectorAll('.landing-actions .btn')].map(b => b.innerText).join('|'),
          steps: document.querySelectorAll('.landing-step').length, legacy: /\\/app\\b/.test(document.body.innerHTML)
        }))()`);
        assert(/קנייה קבוצתית/.test(snap.sub) && /לא הגיעה — אף אחד לא משלם/.test(snap.sub), `hero sentence: ${snap.sub}`);
        assert(/קונים\?/.test(snap.entry) && /בלי חשבון/.test(snap.entry), `buyer entry: ${snap.entry}`);
        assert(/פיילוט סגור/.test(snap.pilot) && /לא מתבצעים חיובים אמיתיים/.test(snap.pilot), `pilot note: ${snap.pilot}`);
        assert(/התחברות מוכר/.test(snap.sellerCta) && /פתיחת חשבון מוכר/.test(snap.sellerCta), `seller CTAs: ${snap.sellerCta}`);
        assert(snap.steps === 3 && !snap.legacy, "how-it-works + no legacy reference");
        await cdp.shot(shotName(w, "01_landing"));
        return check(`landing@${w}`);
      });

      await run(`public deal @${w}: ten-second facts — what / why / regular vs group price / saving / needed / deadline (+ Israel time) / what-if / CTA; approved seller; ask-seller entry`, async () => {
        // the expected numbers come from the API (earlier widths already joined this deal)
        const live = (await call(`/api/deals/${deals.open}/activity`)).json;
        const expectJoined = Number(live.joined_units), expectToTarget = Math.max(0, 8 - expectJoined);
        // a fresh buyer: nothing remembered, nothing answered yet
        await cdp.navigate(`${BASE}/preview/#/`); await waitFor(cdp, exists('.landing'), 20000, "landing");
        await cdp.evaluate(`localStorage.removeItem('siton_buyer_identity_v1'); localStorage.removeItem('siton_feedback_v1'); localStorage.removeItem('siton_inquiries_v1'); true`);
        await cdp.navigate(`${BASE}/preview/#/deal/${deals.open}`);
        await waitFor(cdp, exists('[data-testid="join-open"]'), 30000, "join CTA");
        await waitFor(cdp, exists('[data-testid="live-countdown"]'), 10000, "countdown");
        await wait(900);
        const snap = await cdp.evaluate(`(() => {
          const q = (s) => document.querySelector(s);
          const top = (el) => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
          const t = (s) => (q(s) || {}).innerText || "";
          return {
            explainer: t('[data-testid="deal-explainer"]'), why: t('[data-testid="deal-why"]'), price: t('[data-testid="deal-price"]'), saving: t('[data-testid="deal-saving"]'),
            needed: t('[data-testid="deal-needed"]'), toTarget: q('[data-testid="deal-needed"]').getAttribute('data-units-to-target'),
            deadlineAbs: t('[data-testid="deal-deadline-abs"]'), cta: t('[data-testid="join-open"]'), how: t('[data-testid="how-it-works"]'),
            approved: t('[data-testid="seller-approved"]'), askTop: Boolean(q('[data-testid="inquiry-open-top"]')), askCta: Boolean(q('[data-testid="inquiry-open-cta"]')),
            afterTap: t('[data-testid="after-tap"]'), pilot: t('[data-testid="pilot-line"]'), demo: Boolean(q('.staging-flag')),
            order: [top(q('.deal-title')), top(q('[data-testid="deal-explainer"]')), top(q('[data-testid="deal-price"]')), top(q('[data-testid="deal-saving"]')), top(q('[data-testid="deal-needed"]')), top(q('.gm')), top(q('[data-testid="deal-countdown"]')), top(q('[data-testid="join-open"]'))],
            ctaTop: top(q('[data-testid="join-open"]')), vh: window.innerHeight, sticky: q('[data-testid="sticky-cta"]')?.getAttribute('data-show') || null,
            stickyText: t('[data-testid="join-open-sticky"]'), stickyRect: q('[data-testid="sticky-cta"]') ? JSON.stringify(q('[data-testid="sticky-cta"]').getBoundingClientRect()) : null
          };
        })()`);
        assert(/קנייה קבוצתית/.test(snap.explainer) && /אף אחד לא משלם/.test(snap.explainer), "WHAT + WHAT-IF at the top");
        assert(/קונים ביחד/.test(snap.why), "WHY the price is lower");
        assert(/מחיר קבוצתי ליחידה/.test(snap.price) && /45/.test(snap.price), `group price: ${snap.price}`);
        assert(/מחיר רגיל/.test(snap.saving) && /65/.test(snap.saving) && /חיסכון 31%/.test(snap.saving) && /חוסכים/.test(snap.saving) && /20/.test(snap.saving), `saving row: ${snap.saving}`);
        assert(/8/.test(snap.needed) && new RegExp(`\\b${expectJoined}\\b`).test(snap.needed) && snap.toTarget === String(expectToTarget) && /עוד חסרות/.test(snap.needed), `needed facts: ${snap.needed} (expected joined=${expectJoined}, to target=${expectToTarget})`);
        assert(/שעון ישראל/.test(snap.deadlineAbs), `absolute deadline: ${snap.deadlineAbs}`);
        assert(new RegExp(`הצטרפו עכשיו — עוד ${expectToTarget} ליעד`).test(snap.cta), `CTA: ${snap.cta}`);
        assert(/לא הגיעו ליעד\?/.test(snap.how) && /אף אחד לא משלם/.test(snap.how), "how-it-works strip");
        assert(/מוכר מאושר/.test(snap.approved), "approved-seller badge (backend fact)");
        assert(snap.askTop && snap.askCta, "ask-the-seller entries (top + next to CTA)");
        assert(/מסגרת בלבד — לא חיוב/.test(snap.afterTap) && /פיילוט/.test(snap.pilot) && snap.demo, "after-tap + pilot + demo disclosure");
        for (let i = 1; i < snap.order.length; i++) assert(snap.order[i] !== null && snap.order[i] >= snap.order[i - 1], `decision order broken at ${i}: ${JSON.stringify(snap.order)}`);
        if (phone) {
          assert(snap.sticky === "1" && new RegExp(`הצטרפו — עוד ${expectToTarget} ליעד`).test(snap.stickyText), `sticky CTA must be visible while the real CTA is off-screen (show=${snap.sticky}, text=${snap.stickyText})`);
          const r = JSON.parse(snap.stickyRect); assert(r.bottom <= snap.vh + 1 && r.width <= w + 1, `sticky bar inside the viewport: ${snap.stickyRect}`);
        } else {
          assert(snap.sticky !== "1" || JSON.parse(snap.stickyRect || "{}").height === 0, "no sticky bar on desktop");
        }
        await cdp.shot(shotName(w, "02_deal_top"));
        // scrolling to the real CTA hides the sticky bar (no double CTA)
        await cdp.evaluate(`document.querySelector('[data-testid="join-open"]').scrollIntoView({ block: 'center' })`);
        await wait(500);
        const stickyAfter = await cdp.evaluate(`document.querySelector('[data-testid="sticky-cta"]')?.getAttribute('data-show')`);
        if (phone) assert(stickyAfter === "0", `sticky bar must hide when the real CTA is on screen (got ${stickyAfter})`);
        await cdp.shot(shotName(w, "03_deal_cta"));
        return check(`deal@${w}`, { cta: snap.cta, ctaTop: snap.ctaTop, sticky: snap.sticky });
      });

      await run(`join sheet @${w}: what-happens line, required markers, empty submit → per-field Hebrew errors + summary, sticky footer CTA reachable`, async () => {
        await cdp.evaluate(click('[data-testid="join-open"]'));
        await waitFor(cdp, exists('[data-testid="join-submit"]'), 10000, "join sheet");
        await wait(300);
        const before = await cdp.evaluate(`(() => ({
          whatNext: document.querySelector('[data-testid="join-what-next"]').innerText, req: document.querySelectorAll('.modal .req').length,
          pilot: document.querySelector('[data-testid="pay-pilot-note"]').innerText, foot: document.querySelector('[data-testid="join-foot-line"]').innerText,
          submitVisible: (() => { const r = document.querySelector('[data-testid="join-submit"]').getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top >= 0; })(),
          terms: Boolean(document.querySelector('[data-testid="join-terms"]')), disclosure: Boolean(document.querySelector('[data-testid="join-disclosure"]'))
        }))()`);
        assert(/מה קורה באישור\?/.test(before.whatNext) && /לא חיוב/.test(before.whatNext) && /מסך מעקב אישי/.test(before.whatNext), `what-next: ${before.whatNext}`);
        assert(before.req >= 5, `required markers ${before.req}`);
        assert(/לא מתבצע חיוב אמיתי/.test(before.pilot) && /מסגרת בלבד/.test(before.foot), "pilot + no-charge lines in the sheet");
        assert(before.submitVisible && before.terms && before.disclosure, "CTA reachable, legal acceptance present");
        await cdp.shot(shotName(w, "04_join_top"));
        await cdp.evaluate(click('[data-testid="join-submit"]'));
        await wait(400);
        const errs = await cdp.evaluate(`(() => ({
          fields: [...document.querySelectorAll('[data-testid^="join-error-"]')].map(e => e.getAttribute('data-testid').replace('join-error-', '') + ':' + e.innerText),
          summary: (document.querySelector('[data-testid="join-refusal"]') || {}).innerText || "", kind: document.querySelector('[data-testid="join-refusal"]')?.getAttribute('data-kind'),
          firstInvalidTop: document.querySelector('.field.invalid')?.getBoundingClientRect().top
        }))()`);
        assert(errs.fields.length >= 4 && errs.fields.some((f) => /^name:יש להזין שם מלא/.test(f)) && errs.fields.some((f) => /^phone:יש להזין טלפון נייד/.test(f)) && errs.fields.some((f) => /^disclosure:/.test(f)) && errs.fields.some((f) => /^terms:/.test(f)), `field errors: ${JSON.stringify(errs.fields)}`);
        assert(errs.kind === "fields" && /שדות מסומנים/.test(errs.summary), `summary: ${errs.summary}`);
        const buyerCopy = errs.summary + " " + errs.fields.map((f) => f.slice(f.indexOf(":") + 1)).join(" ");
        assert(!/[a-z_]{6,}/.test(buyerCopy), `technical code in buyer copy: ${buyerCopy}`);
        await cdp.shot(shotName(w, "05_join_errors"));
        // a bad phone gets a specific sentence
        await cdp.evaluate(setValue('[data-testid="join-name"]', "דנה לוי"));
        await cdp.evaluate(setValue('[data-testid="join-phone"]', "12"));
        await cdp.evaluate(click('[data-testid="join-submit"]'));
        await wait(300);
        const phoneErr = await cdp.evaluate(text('[data-testid="join-error-phone"]'));
        assert(/מספר טלפון תקין/.test(phoneErr), `phone error: ${phoneErr}`);
        return { fields: errs.fields.length };
      });

      await run(`join → success @${w}: joined facts, no-charge + pilot line, progress incl. this join, tracking link FIRST + copy, honest notification line, share loop (messaging lead, one copy), feedback question`, async () => {
        if (!(await cdp.evaluate(exists('[data-testid="join-submit"]')))) {
          await cdp.evaluate(click('[data-testid="join-open"]'));
          await waitFor(cdp, exists('[data-testid="join-submit"]'), 10000, "join sheet");
        }
        await cdp.evaluate(setValue('[data-testid="join-name"]', "דנה לוי"));
        await cdp.evaluate(setValue('[data-testid="join-phone"]', "052-123-4567"));
        await cdp.evaluate(`(() => { for (const id of ['join-disclosure', 'join-terms']) { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el.checked) el.click(); } return true; })()`);
        await wait(200);
        await cdp.evaluate(click('[data-testid="join-submit"]'));
        await waitFor(cdp, exists('[data-testid="join-success"]'), 15000, "success");
        await waitFor(cdp, `document.querySelector('[data-testid="join-success-progress"]')?.getAttribute('data-to-target') !== null`, 10000, "progress");
        await wait(1200);
        const snap = await cdp.evaluate(`(() => {
          const s = document.querySelector('[data-testid="join-success"]'); const t = (sel) => (s.querySelector(sel) || {}).innerText || "";
          const top = (sel) => s.querySelector(sel) ? s.querySelector(sel).getBoundingClientRect().top : null;
          return {
            facts: t('[data-testid="join-success-facts"]'), progress: t('[data-testid="join-success-progress"]'), toTarget: s.querySelector('[data-testid="join-success-progress"]').getAttribute('data-to-target'),
            trackHref: s.querySelector('[data-testid="join-success-track-link"]').getAttribute('href'), copyTrack: Boolean(s.querySelector('[data-testid="join-success-copy-track"]')),
            notif: t('[data-testid="join-success-notif"]'), share: t('[data-testid="join-success-share"]'),
            whatsapp: s.querySelector('[data-testid="share-whatsapp"]')?.getAttribute('href') || "", copies: s.querySelectorAll('[data-testid="share-copy"]').length,
            feedback: t('[data-testid="feedback-prompt"]'), chips: s.querySelectorAll('[data-testid^="feedback-chip-"]').length,
            orderOk: top('[data-testid="join-success-track-link"]') < top('[data-testid="share-whatsapp"]') && top('[data-testid="share-whatsapp"]') < top('[data-testid="feedback-prompt"]')
          };
        })()`);
        assert(/1 יחידה/.test(snap.facts) && /45/.test(snap.facts) && /לא בוצע חיוב/.test(snap.facts) && /פיילוט/.test(snap.facts), `facts: ${snap.facts}`);
        assert(/חסרות עוד/.test(snap.progress) && /שעון ישראל/.test(snap.progress) && Number(snap.toTarget) >= 0, `progress: ${snap.progress}`);
        assert(/^#\/track\/[0-9a-f-]{36}\?t=/.test(snap.trackHref) && snap.copyTrack, `tracking link: ${snap.trackHref}`);
        assert(/לא נשלחים מסרונים או מיילים/.test(snap.notif), `honest notification line: ${snap.notif}`);
        assert(/עזרו לעסקה להצליח — שתפו עם עוד אנשים/.test(snap.share), "share loop title");
        assert(/^https:\/\/wa\.me\/\?text=/.test(snap.whatsapp) && decodeURIComponent(snap.whatsapp).includes("/d/" + deals.open + "?ref=") && decodeURIComponent(snap.whatsapp).includes("רק אם מספיק אנשים מצטרפים"), `messaging share: ${decodeURIComponent(snap.whatsapp).slice(0, 200)}`);
        assert(snap.copies === 1, `exactly one copy control (got ${snap.copies})`);
        assert(/היה משהו שלא היה ברור\?/.test(snap.feedback) && snap.chips === 6, `feedback prompt: chips=${snap.chips}`);
        assert(snap.orderOk, "tracking → share → feedback order");
        await cdp.shot(shotName(w, "06_success"));
        // answer the feedback question (category + text) — stored PII-free, thanks shown, never asked again for this deal
        await cdp.evaluate(click('[data-testid="feedback-chip-price"]'));
        await waitFor(cdp, exists('[data-testid="feedback-text"]'), 5000, "feedback text");
        await cdp.evaluate(setValue('[data-testid="feedback-text"]', `לא היה ברור אם המשלוח כלול ${w}`));
        await cdp.evaluate(click('[data-testid="feedback-send"]'));
        await waitFor(cdp, exists('[data-testid="feedback-thanks"]'), 10000, "feedback thanks");
        await cdp.shot(shotName(w, "07_success_feedback"));
        const stored = await db.query(`SELECT status, priority, opened_by, buyer_ref, participant_id, description FROM siton.operational_cases WHERE opened_by='buyer_feedback' AND deal_id=$1 ORDER BY created_at DESC LIMIT 1`, [deals.open]);
        assert(stored.rowCount === 1 && stored.rows[0].status === "Closed" && stored.rows[0].priority === "Low" && stored.rows[0].buyer_ref === null && stored.rows[0].participant_id === null, `stored feedback: ${JSON.stringify(stored.rows[0])}`);
        assert(new RegExp(`קטגוריה: price\\nמסך: join_success\\nטקסט: לא היה ברור אם המשלוח כלול ${w}`).test(stored.rows[0].description), `description: ${stored.rows[0].description}`);
        assert(!/דנה לוי|0521234567/.test(stored.rows[0].description), "no PII in feedback");
        await check(`success@${w}`);
        const trackHref = snap.trackHref;
        deals[`track_${w}`] = trackHref;
        return { trackHref: trackHref.slice(0, 48) };
      });

      await run(`tracking @${w}: I joined / how many / progress / what still has to happen / deadline / copy link / back to deal / ask seller / share loop / feedback (once per deal)`, async () => {
        await cdp.navigate(`${BASE}/preview/${deals[`track_${w}`]}`);
        await waitFor(cdp, exists('[data-testid="track-next"]'), 30000, "tracking");
        await waitFor(cdp, exists('[data-testid="track-share"] [data-testid="share-whatsapp"]'), 15000, "share loop");
        await wait(800);
        const snap = await cdp.evaluate(`(() => {
          const t = (sel) => (document.querySelector(sel) || {}).innerText || "";
          return {
            status: t('[data-testid="track-status"]'), next: t('[data-testid="track-next"]'), qty: t('.kv'), notif: t('[data-testid="track-notif-line"]'),
            copy: Boolean(document.querySelector('[data-testid="track-copy-link"]')), dealLink: document.querySelector('[data-testid="track-deal-link"]').getAttribute('href'),
            ask: document.querySelector('[data-testid="track-ask-seller"]').getAttribute('href'), askText: t('[data-testid="track-return"]'),
            share: t('[data-testid="track-share"]'), feedback: t('[data-testid="track-feedback"]'), promptAgain: Boolean(document.querySelector('[data-testid="track-feedback"] [data-testid="feedback-prompt"]'))
          };
        })()`);
        assert(/התפיסה נקלטה|ההצטרפות נקלטה/.test(snap.status), `status: ${snap.status.slice(0, 80)}`);
        assert(/מה עוד צריך לקרות\?/.test(snap.next) && /חסרות עוד \d+ יחידות/.test(snap.next) && /מועד הסיום/.test(snap.next) && /שעון ישראל/.test(snap.next) && /המסגרת משתחררת ואף אחד לא משלם/.test(snap.next), `next steps: ${snap.next}`);
        assert(/לא נשלחים מסרונים או מיילים/.test(snap.notif) && snap.copy, "honest notification line + copy link");
        assert(snap.dealLink === `#/deal/${deals.open}` && snap.ask === `#/deal/${deals.open}?inquiry=1`, `links: ${snap.dealLink} ${snap.ask}`);
        assert(/פרטי הקשר של המוכר ושלכם לא נחשפים/.test(snap.askText), "privacy line next to ask-seller");
        assert(/עזרו לעסקה להצליח/.test(snap.share), "share loop on tracking");
        assert(/תודה/.test(snap.feedback) && !snap.promptAgain, "feedback already given for this deal → thanks, not asked again");
        await cdp.shot(shotName(w, "08_track"));
        return check(`track@${w}`);
      });

      await run(`inquiry round trip @${w}: tracking → ask seller opens the sheet on the deal page → send → success (privacy) → thread under 'הפניות שלי' → seller replies (API) → buyer sees the reply → follow-up`, async () => {
        const inqDeal = deals[`inq${w}`];
        await cdp.evaluate(`localStorage.removeItem('siton_inquiries_v1'); true`);
        await cdp.navigate(`${BASE}/preview/#/deal/${inqDeal}?inquiry=1`);
        await waitFor(cdp, exists('[data-testid="inquiry-submit"]'), 30000, "inquiry sheet auto-opened");
        const intro = await cdp.evaluate(text('#inquiry-form'));
        assert(/בלי לחשוף פרטי קשר/.test(intro), `privacy intro: ${intro.slice(0, 120)}`);
        await cdp.evaluate(setValue('[data-testid="inquiry-name"]', "דנה לוי"));
        // one buyer identity per width: the product caps inquiry messages per customer per hour (P0.7), which is a feature
        await cdp.evaluate(setValue('[data-testid="inquiry-email"]', `dana+${tag}w${w}@example.com`));
        await cdp.evaluate(setValue('[data-testid="inquiry-message"]', `האם הדבש כשר? ${w}`));
        await cdp.shot(shotName(w, "09_inquiry"));
        await cdp.evaluate(click('[data-testid="inquiry-submit"]'));
        await waitFor(cdp, exists('[data-testid="inquiry-success"]'), 15000, "inquiry success");
        const succ = await cdp.evaluate(text('[data-testid="inquiry-success"]'));
        assert(/פרטי הקשר של המוכר אינם נחשפים/.test(succ), `inquiry success copy: ${succ.slice(0, 160)}`);
        await cdp.evaluate(click('[data-testid="inquiry-done"]'));
        await waitFor(cdp, exists('[data-testid="my-inquiry"]'), 20000, "my inquiries");
        const threadId = await cdp.evaluate(`JSON.parse(localStorage.getItem('siton_inquiries_v1'))[${JSON.stringify(inqDeal)}][0].thread_id`);
        const reply = await call(`/api/seller/inquiries/${threadId}/reply`, { method: "POST", body: { message: `כן, בהשגחה. ${w}` } });
        assert([200, 201].includes(reply.status), `seller reply ${reply.status} ${reply.text.slice(0, 160)}`);
        await cdp.navigate(`${BASE}/preview/#/deal/${inqDeal}`);
        await waitFor(cdp, exists('[data-testid="my-inquiry-msg-seller"]'), 30000, "seller reply visible to the buyer");
        const thread = await cdp.evaluate(text('[data-testid="my-inquiry"]'));
        assert(/המוכר השיב/.test(thread) && /בהשגחה/.test(thread) && !/@example\.com/.test(thread), `thread: ${thread.slice(0, 200)}`);
        await cdp.evaluate(setValue('[data-testid="inquiry-followup"]', `תודה! ${w}`));
        await waitFor(cdp, `!document.querySelector('.inq-followup button').disabled`, 5000, "follow-up button enabled");
        await cdp.evaluate(click('.inq-followup button'));
        try {
          await waitFor(cdp, `document.querySelectorAll('[data-testid="my-inquiry-msg-customer"]').length >= 2`, 15000, "follow-up shown");
        } catch (e) {
          const notice = await cdp.evaluate(`(document.querySelector('[data-testid="my-inquiries"] .notice') || {}).innerText || ''`);
          throw new Error(`${e.message}; notice=${notice}`);
        }
        await cdp.shot(shotName(w, "10_inquiry_thread"));
        await check(`inquiry@${w}`);
        return { thread: threadId.slice(0, 8) };
      });

      await run(`seller login entry @${w}: renders the login panel, no overflow, no hidden CTA`, async () => {
        await cdp.navigate(`${BASE}/preview/#/seller`);
        await waitFor(cdp, `Boolean(document.querySelector('input[type="email"], input[inputmode="email"], .auth-panel, form'))`, 20000, "seller login");
        await wait(500);
        const snap = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /התחבר|כניסה/.test(x.innerText)); return { btn: b ? b.innerText : null, visible: b ? b.getBoundingClientRect().width > 0 : false }; })()`);
        assert(snap.btn && snap.visible, `login button: ${JSON.stringify(snap)}`);
        await cdp.shot(shotName(w, "11_seller_login"));
        return check(`seller-login@${w}`);
      });

      if (MALL_BASE) {
        await run(`mall @${w}: open deals listed with price / regular price / needed / countdown, buyer entry from the landing route`, async () => {
          await cdp.navigate(`${MALL_BASE}/preview/#/deals`);
          await waitFor(cdp, exists('.card'), 30000, "mall cards");
          await wait(500);
          const snap = await cdp.evaluate(`(() => ({ cards: document.querySelectorAll('.card').length, was: document.querySelectorAll('.card .price-was').length, needed: [...document.querySelectorAll('.card')].some(c => /ליעד/.test(c.innerText)), hero: (document.querySelector('.hero') || {}).innerText || "" }))()`);
          assert(snap.cards >= 1 && snap.was >= 1 && snap.needed, `mall: ${JSON.stringify(snap)}`);
          assert(/מסגרת/.test(snap.hero) && /ליעד/.test(snap.hero), "mall hero explains the rule");
          await cdp.shot(shotName(w, "12_mall"));
          return check(`mall@${w}`, { cards: snap.cards });
        });
      }
    }

    // ── failure / empty states @390 ────────────────────────────────────────
    await cdp.viewport(390, 844, true);
    const stories = [
      ["soldout", "sold_out", /המלאי אזל/, true],
      ["paused", "paused", /ההצטרפות מושהית זמנית/, true],
      ["failed", "failed", /העסקה לא יצאה לפועל/, true],
      ["completed", "completed", /העסקה הושלמה בהצלחה/, true],
      ["expired", "awaiting_decision", /מועד ההצטרפות הסתיים — ממתינים להכרעה/, true]
    ];
    for (const [key, story, re, ask] of stories) {
      await run(`failure state @390 — ${key}: what happened / can I do anything / what next (${story})`, async () => {
        await cdp.navigate(`${BASE}/preview/#/deal/${deals[key]}`);
        await waitFor(cdp, `document.querySelector('[data-testid="closed-story"]')?.getAttribute('data-story') === ${JSON.stringify(story)}`, 30000, `closed story ${story}`);
        await wait(300);
        const snap = await cdp.evaluate(`(() => ({ text: document.querySelector('[data-testid="closed-story"]').innerText, ask: Boolean(document.querySelector('[data-testid="closed-ask-seller"]')), join: Boolean(document.querySelector('[data-testid="join-open"]')), sticky: document.querySelector('[data-testid="sticky-cta"]')?.getAttribute('data-show') || 'none', pill: document.querySelector('.status').innerText }))()`);
        assert(re.test(snap.text), `${key}: ${snap.text.slice(0, 160)}`);
        assert(/לא בוצע חיוב|משתחררות|אין אפשרות להצטרף|אי אפשר להצטרף|יחויבו|חויבו|לשאול את המוכר/.test(snap.text), `${key} must say what it means for money / what to do: ${snap.text}`);
        assert(!snap.join && snap.sticky !== "1", `${key}: no join CTA on a closed deal`);
        assert(snap.ask === ask, `${key}: ask-seller entry`);
        assert(!/[a-z_]{8,}/.test(snap.text), `${key}: technical code in the primary UI: ${snap.text}`);
        await cdp.shot(`0390_13_state_${key}.png`);
        return check(`state-${key}@390`, { pill: snap.pill });
      });
    }

    await run("join refused @390 — the seller pauses while the sheet is open: the buyer sees a Hebrew sentence + 'refresh status', typed data is kept, no technical code", async () => {
      await cdp.navigate(`${BASE}/preview/#/deal/${deals.open}`);
      await waitFor(cdp, exists('[data-testid="join-open"]'), 30000, "join CTA");
      await cdp.evaluate(click('[data-testid="join-open"]'));
      await waitFor(cdp, exists('[data-testid="join-submit"]'), 10000, "join sheet");
      const remembered = await cdp.evaluate(`document.querySelector('[data-testid="join-name"]').value`);
      assert(remembered === "דנה לוי", `identity remembered on this device (got ${remembered})`);
      await cdp.evaluate(`(() => { document.querySelector('[data-testid="join-disclosure"]').click(); document.querySelector('[data-testid="join-terms"]').click(); return true; })()`);
      const pause = await call(`/api/deals/${deals.open}/close_joining`, { method: "POST", headers: { "idempotency-key": `bp-pause2-${randomUUID()}` }, body: {} });
      assert(pause.status === 200, `pause ${pause.status}`);
      expectedFailures = [/\/join/];
      await cdp.evaluate(click('[data-testid="join-submit"]'));
      await waitFor(cdp, `document.querySelector('[data-testid="join-refusal"]')?.getAttribute('data-kind') === 'state'`, 15000, "state refusal");
      const snap = await cdp.evaluate(`(() => ({ text: document.querySelector('[data-testid="join-refusal"]').innerText, refresh: Boolean(document.querySelector('[data-testid="join-refusal-refresh"]')), name: document.querySelector('[data-testid="join-name"]').value, phone: document.querySelector('[data-testid="join-phone"]').value }))()`);
      assert(/נסגרה בינתיים|מושהית/.test(snap.text) && /רעננו/.test(snap.text) && snap.refresh, `refusal: ${snap.text}`);
      assert(snap.name === "דנה לוי" && snap.phone.length >= 9, "typed data kept after refusal");
      assert(!/409|deal_not_open|STATE_CONFLICT|not open for joining/.test(snap.text), `technical code leaked: ${snap.text}`);
      await cdp.shot("0390_14_join_refused.png");
      await cdp.evaluate(click('[data-testid="join-refusal-refresh"]'));
      await waitFor(cdp, `document.querySelector('[data-testid="closed-story"]')?.getAttribute('data-story') === 'paused'`, 15000, "page shows the paused story after refresh");
      expectedFailures = [];
      const reopen = await call(`/api/deals/${deals.open}/reopen_joining`, { method: "POST", headers: { "idempotency-key": `bp-reopen-${randomUUID()}` }, body: {} });
      assert(reopen.status === 200, `reopen ${reopen.status}`);
      const ev = await db.query(`SELECT detail FROM siton.viral_events WHERE deal_id=$1 AND event_type='join_failed' ORDER BY created_at DESC LIMIT 1`, [deals.open]);
      assert(ev.rowCount === 1 && /409|not_open|deal is not open/.test(String(ev.rows[0].detail)), `join_failed funnel event recorded PII-free: ${JSON.stringify(ev.rows)}`);
      return { refusal: snap.text.slice(0, 80) };
    });

    await run("invalid tracking link @390: says the link is invalid/incomplete, offers support — no technical code", async () => {
      expectedFailures = [/\/tracking/, /\/impact/];
      await cdp.navigate(`${BASE}/preview/#/track/${randomUUID()}?t=bogus-token`);
      await waitFor(cdp, exists('[data-testid="track-support"]'), 30000, "track error");
      const snap = await cdp.evaluate(`document.body.innerText`);
      assert(/אין גישה למסך המעקב/.test(snap) && /הקישור/.test(snap) && !/tracking_token|403|401|404/.test(snap), `track error copy: ${snap.slice(0, 200)}`);
      expectedFailures = [];
      await cdp.shot("0390_15_track_invalid.png");
      return check("track-invalid@390");
    });

    await run("invalid inquiry token @390: a stale stored token is forgotten and explained, never a silent hole", async () => {
      expectedFailures = [/\/api\/inquiries\//];
      await cdp.evaluate(`localStorage.setItem('siton_inquiries_v1', JSON.stringify({ [${JSON.stringify(deals.open)}]: [{ thread_id: ${JSON.stringify(randomUUID())}, token: 'stale-token', created_at: new Date().toISOString() }] })); true`);
      await cdp.navigate(`${BASE}/preview/#/deal/${deals.open}`);
      await waitFor(cdp, exists('[data-testid="my-inquiries-stale"]'), 30000, "stale notice");
      const left = await cdp.evaluate(`(JSON.parse(localStorage.getItem('siton_inquiries_v1') || '{}')[${JSON.stringify(deals.open)}] || []).length`);
      assert(left === 0, `stale token purged (left ${left})`);
      expectedFailures = [];
      return check("inquiry-stale@390");
    });

    await run("network failure @390: the deal page says 'communication problem', offers retry, the link itself is not blamed", async () => {
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/api/deals/${deals.open}/public*`, requestStage: "Request" }] });
      const failer = (msg) => { if (msg.method === "Fetch.requestPaused") cdp.send("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: "ConnectionFailed" }).catch(() => {}); };
      cdp.on(failer);
      expectedFailures = [/\/public/];
      await cdp.navigate(`${BASE}/preview/#/deal/${deals.open}`);
      await waitFor(cdp, exists('[data-testid="deal-retry"]'), 20000, "network empty state");
      const snap = await cdp.evaluate(`document.body.innerText`);
      assert(/בעיית תקשורת/.test(snap) && /הקישור עצמו תקין/.test(snap) && /נסו שוב/.test(snap), `network copy: ${snap.slice(0, 200)}`);
      await cdp.shot("0390_16_deal_network.png");
      await cdp.send("Fetch.disable");
      expectedFailures = [];
      return check("deal-network@390");
    });

    await run("0 console errors + 0 failed essential requests across every surface", async () => {
      assert(consoleErrors.length === 0, `console errors:\n${consoleErrors.join("\n")}`);
      assert(failedRequests.length === 0, `failed requests:\n${failedRequests.join("\n")}`);
      return { pages: pageChecks.length };
    });
  } finally {
    cdp.close(); browser.kill("SIGKILL");
    await db.end();
  }
  writeFileSync(join(SHOTS, "results.json"), JSON.stringify({ base: BASE, mall: MALL_BASE, tag, deals, passed, failed, results, pageChecks, consoleErrors, failedRequests }, null, 2));
  console.log(`\nBUYER_POLISH_PROOF passed=${passed} failed=${failed} shots=${SHOTS}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
