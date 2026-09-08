#!/usr/bin/env node
// LAUNCH POLISH SPRINT 1 — browser proof @390 (headless Edge CDP) against a local demo-preview runtime.
// Usage: DATABASE_URL=<local runtime db> node scripts/launch_polish_browser_proof.cjs  [BASE_URL=http://127.0.0.1:3210] [SHOTS=<dir>]
// Seeds a deal + a pending self-signup seller, then checks landing, seller dashboard, seller deal (Draft + live),
// wizard, public deal, admin queue/overview/detail: 0 console errors, no horizontal overflow, journey strip,
// cancel refusal with the pause alternative, pending queue, boot loader and the slow-load hint. Local only.
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { Client } = require("pg");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3210").replace(/\/+$/, "");
const SHOTS = process.env.SHOTS || join(require("node:os").tmpdir(), "siton-launch-polish-shots");
mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
if (!EDGE) { console.error("Edge not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0; const results = [];
async function run(name, fn) { try { const d = await fn(); passed++; results.push({ name, ok: true, detail: d ?? null }); console.log(`PASS ${name}${d ? ` — ${typeof d === "string" ? d : JSON.stringify(d).slice(0, 200)}` : ""}`); } catch (e) { failed++; results.push({ name, ok: false, error: String(e.message || e) }); console.error(`FAIL ${name}: ${String(e.message || e).slice(0, 500)}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const tag = randomBytes(3).toString("hex");

// ── tiny PNG so the image rail is exercised for real ──────────────────────
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function makePng(w, h, rgb) { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = (rgb[2] + x + y) & 0xff; } } const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const h = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

// ── CDP ───────────────────────────────────────────────────────────────────
async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-polish-proof-${Date.now()}`);
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
    async navigate(url) { await send("Page.enable"); await send("Page.navigate", { url }); },
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "evaluate failed"); return res.result?.value; },
    async viewport(width, height, mobile = true) { await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }); },
    async shot(file) { const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64")); console.log(`SHOT ${join(SHOTS, file)}`); }
  };
}
async function waitFor(cdp, expr, timeoutMs = 30_000, label = "condition") { const deadline = Date.now() + timeoutMs; let last = null; while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(250); } throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`); }
const NO_OVERFLOW = `document.documentElement.scrollWidth <= window.innerWidth + 2`;
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`;
const exists = (sel) => `Boolean(document.querySelector(${JSON.stringify(sel)}))`;
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText || "")`;

(async () => {
  console.log(`POLISH_UI_PROOF base=${BASE} tag=${tag}`);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // ── seed through the product API (default demo seller) ───────────────────
  let dealId = "";
  await run("seed: profile + draft + image + regular price (default demo seller)", async () => {
    // idempotent re-runs: previous runs' deals move to an archive seller so the
    // default seller is a "never published" seller again for the dashboard check
    await db.query(`INSERT INTO siton.seller_accounts (seller_id, display_name, verification_status) VALUES ('polish-archive', 'archive', 'approved') ON CONFLICT (seller_id) DO NOTHING`);
    await db.query(`UPDATE siton.deals SET seller_id='polish-archive' WHERE seller_id='seller-default'`);
    const p = await call("/api/seller/profile", { method: "PUT", body: { business_name: `מכוורת הגליל ${tag}`, contact_name: "בודק", support_email: `polish-${tag}@siton.test`, business_description: "דבש מכוורת משפחתית" } });
    assert(p.status === 200, `profile ${p.status} ${p.text.slice(0, 120)}`);
    const deadline = new Date(Date.now() + 2 * 24 * 3600 * 1000 + 7 * 3600 * 1000).toISOString();
    const r = await call("/api/deals", { method: "POST", headers: { "idempotency-key": `polish-${randomUUID()}` }, body: {
      deal_type: "physical_product", title: `מארז דבש בוטיק 1 ק״ג — קציר 2026`,
      description_short: "דבש פרחי בר מכוורת משפחתית — מחיר קבוצתי לזמן מוגבל",
      description: "מארז דבש 1 ק״ג ישירות מהמכוורת. איסוף עצמי מהרצל 12 תל אביב או משלוח עד הבית.",
      price_per_unit: 45, list_price_per_unit: 65, min_units: 8, max_units: 30, deadline,
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, latitude: 32.0853, longitude: 34.7818 }, { option_type: "delivery", label: "משלוח עד הבית", cost: 15 }]
    } });
    assert([200, 201].includes(r.status), `create ${r.status} ${r.text.slice(0, 200)}`);
    dealId = String(r.json.deal_id || r.json.deal?.deal_id); assert(dealId, "no deal id");
    const png = makePng(320, 240, [236, 102, 8]);
    const img = await call(`/api/seller/deals/${dealId}/images`, { method: "POST", headers: { "idempotency-key": `polish-img-${dealId}` }, body: { mime_type: "image/png", image_base64: png.toString("base64"), original_filename: `polish-${tag}.png`, is_primary: true } });
    assert([200, 201].includes(img.status), `image ${img.status} ${img.text.slice(0, 200)}`);
    // the demo seller is shown as PENDING to exercise the pending surfaces (reverted at the end)
    await db.query(`UPDATE siton.seller_accounts SET verification_status='pending' WHERE seller_id='seller-default'`);
    // a self-registered seller waiting in the queue (as the runtime creates it)
    await db.query(`INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, login_email, support_email, verification_status, settlement_status, auth_enabled, auth_user_id, admin_note)
                    VALUES ($1, 'dana.cohen', '', $2, $2, 'pending', 'active', true, $3, 'self_signup') ON CONFLICT (seller_id) DO NOTHING`, [`s-dana-cohen-${tag}`, `dana.cohen+${tag}@example.com`, randomUUID()]);
    await db.query(`INSERT INTO siton.seller_security_events (seller_id, event_type, to_status, actor_ref, reason) VALUES ($1, 'seller.self_signup.bound', 'pending', 'supabase:test', 'self_signup')`, [`s-dana-cohen-${tag}`]);
    await db.query(`INSERT INTO siton.seller_business_profiles (seller_id, business_name, contact_name, contact_phone, contact_email) VALUES ($1, 'קפה דנה', 'דנה כהן', '0521234567', $2) ON CONFLICT (seller_id) DO NOTHING`, [`s-dana-cohen-${tag}`, `dana.cohen+${tag}@example.com`]);
    return { deal_id: dealId };
  });

  await run("P8: the served /preview shell carries the pre-hydration boot loader (no dark unexplained screen)", async () => {
    const r = await call("/preview/");
    assert(r.status === 200, `preview ${r.status}`);
    assert(r.text.includes('data-testid="boot-loader"') && r.text.includes("C-ton נטען"), "boot loader missing from the shell");
    assert(!/href="\/app/.test(r.text), "legacy link in shell");
  });

  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl); await cdp.ready;
  const consoleErrors = [];
  await cdp.send("Runtime.enable"); await cdp.send("Log.enable");
  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(`exception: ${msg.params.exceptionDetails?.text || ""} ${msg.params.exceptionDetails?.exception?.description || ""}`.slice(0, 200));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(`console.error: ${(msg.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 200)}`);
    if (msg.method === "Log.entryAdded" && msg.params.entry?.level === "error" && !/favicon/.test(msg.params.entry?.url || "") && !(msg.params.entry?.source === "network" && /\/cancel/.test(msg.params.entry?.url || "") && /409/.test(msg.params.entry?.text || ""))) consoleErrors.push(`log: ${msg.params.entry.text.slice(0, 200)}`);
  });
  const pageChecks = [];
  async function check(label, extra = {}) {
    const ok = await cdp.evaluate(NO_OVERFLOW);
    const w = await cdp.evaluate("window.innerWidth");
    pageChecks.push({ label, overflow_ok: ok, width: w, errors: consoleErrors.length });
    assert(ok, `${label}: horizontal overflow at ${w}px`);
    return { width: w, ...extra };
  }

  try {
    await cdp.viewport(390, 844, true);
    await cdp.navigate(`${BASE}/preview/#/`);
    await waitFor(cdp, exists(".landing"), 30000, "landing");
    await cdp.evaluate(`localStorage.setItem('siton_session_v1', JSON.stringify({ access_token: 'polish-proof-token', refresh_token: '', expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: true } })); sessionStorage.setItem('siton_admin_unlock_v1', JSON.stringify({ until: Date.now() + 30*60000 })); localStorage.removeItem('siton_guest_mode_v1'); true`);

    await run("landing @390: renders, no overflow", async () => {
      await cdp.navigate(`${BASE}/preview/#/`);
      await waitFor(cdp, exists(".landing-hero"), 20000, "landing hero");
      await wait(600);
      await cdp.shot("01_landing_390.png");
      return check("landing");
    });

    await run("seller dashboard @390: pending banner says 'cannot publish yet', journey strip (stage 1) shown to a never-published seller", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller`);
      await waitFor(cdp, exists('[data-testid="seller-journey"]'), 30000, "journey strip");
      await waitFor(cdp, exists('[data-testid="seller-pending-approval"]'), 20000, "pending banner");
      const snap = await cdp.evaluate(`(() => ({
        stage: document.querySelector('[data-testid="seller-journey"]').getAttribute('data-stage'),
        steps: document.querySelectorAll('[data-testid="seller-journey"] .journey-step').length,
        now: (document.querySelector('[data-testid="seller-journey"] .journey-step.now .j-t') || {}).innerText,
        banner: document.querySelector('[data-testid="seller-pending-approval"]').innerText,
        demo: document.querySelector('[data-testid="seller-journey"]').innerText.includes('ללא חיובים אמיתיים'),
        h: document.querySelector('[data-testid="seller-journey"]').getBoundingClientRect().height
      }))()`);
      assert(snap.steps === 5, `steps ${snap.steps}`);
      assert(snap.stage === "0" && /יצירת עסקה/.test(snap.now), `stage ${snap.stage} now=${snap.now}`);
      assert(/לא ניתן לפרסם/.test(snap.banner), "pending banner must say publishing is not possible yet");
      assert(snap.demo, "demo disclosure missing from the journey strip");
      assert(snap.h < 260, `journey strip too tall on a phone: ${snap.h}px`);
      await wait(500);
      await cdp.shot("02_seller_dashboard_390.png");
      return check("dashboard", { journey_height: Math.round(snap.h) });
    });

    await run("seller deal (Draft) @390: journey stage 2, cancel entry visible but not prominent, confirmation distinguishes cancel from pause", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller/deal/${dealId}`);
      await waitFor(cdp, exists('[data-testid="deal-cancel-open"]'), 30000, "cancel entry");
      const snap = await cdp.evaluate(`(() => {
        const btn = document.querySelector('[data-testid="deal-cancel-open"]');
        const pub = document.querySelector('[data-testid="publish-open"]');
        const bs = getComputedStyle(btn), ps = getComputedStyle(pub);
        return { stage: document.querySelector('[data-testid="seller-journey"]').getAttribute('data-stage'), cancelFont: parseFloat(bs.fontSize), publishFont: parseFloat(ps.fontSize), cancelBg: bs.backgroundColor, cancelTop: btn.getBoundingClientRect().top, publishTop: pub.getBoundingClientRect().top };
      })()`);
      assert(snap.stage === "1", `draft with image must be stage 1 (preview), got ${snap.stage}`);
      assert(snap.cancelFont < snap.publishFont, "cancel must be visually smaller than publish");
      assert(snap.publishTop < snap.cancelTop, "publish CTA must come before the cancel entry");
      await wait(400);
      await cdp.shot("03_seller_deal_draft_390.png");
      await cdp.evaluate(click('[data-testid="deal-cancel-open"]'));
      await waitFor(cdp, exists('[data-testid="cancel-vs-pause"]'), 10000, "cancel confirmation");
      const dlg = await cdp.evaluate(text('.modal'));
      assert(/לצמיתות/.test(dlg) && /השהיה/.test(dlg) && /ביטול/.test(dlg), "confirmation must name both cancel and pause");
      assert(!/החזר|זיכוי/.test(dlg), "no invented financial consequence");
      await cdp.shot("04_seller_cancel_confirm_390.png");
      await check("cancel confirmation");
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.innerText.trim() === 'חזרה'); b && b.click(); return true; })()`);
      await wait(300);
      assert(!(await cdp.evaluate(exists('[data-testid="cancel-vs-pause"]'))), "dialog should close on חזרה");
      return { cancelFont: snap.cancelFont, publishFont: snap.publishFont };
    });

    await run("seller wizard @390: first step renders, no overflow", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller/new`);
      await waitFor(cdp, exists(".wizard-steps"), 20000, "wizard");
      await wait(400);
      await cdp.shot("05_seller_wizard_390.png");
      return check("wizard");
    });

    await run("publish through the API (demo runtime has no approval gate) so the live surfaces can be checked", async () => {
      const r = await call(`/api/deals/${dealId}/publish`, { method: "POST", headers: { "idempotency-key": `polish-pub-${randomUUID()}` }, body: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
      assert(r.status === 200, `publish ${r.status} ${r.text.slice(0, 200)}`);
      const pub = await call(`/api/deals/${dealId}/public`);
      assert(pub.json?.deal?.state === "PendingTarget", `state ${pub.json?.deal?.state}`);
      // one synthetic join so the meter and ticker carry real numbers
      const opt = pub.json.deal.delivery_options[0];
      const j = await call(`/api/deals/${dealId}/join`, { method: "POST", headers: { "idempotency-key": `polish-join-${randomUUID()}` }, body: { buyer_id: "0501112233", buyer_name: "נועה", qty: 2, delivery_option_id: opt.option_id, buyer_terms_accepted: true, payment_disclosure_accepted: true, payment_method: "credit_card" } });
      assert([200, 201].includes(j.status), `join ${j.status} ${j.text.slice(0, 160)}`);
      return "published + 1 join";
    });

    await run("public deal @390: 10-second clarity — what/price/saving/needed/deadline/CTA in the first two screens, no overflow", async () => {
      await cdp.navigate(`${BASE}/preview/#/deal/${dealId}`);
      await waitFor(cdp, exists('[data-testid="join-open"]'), 30000, "join CTA");
      await waitFor(cdp, exists('[data-testid="live-countdown"]'), 10000, "countdown");
      await wait(800);
      const snap = await cdp.evaluate(`(() => {
        const q = (s) => document.querySelector(s);
        const top = (el) => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
        return {
          title: top(q('.deal-title')), price: top(q('.deal-price-hero')), priceLabel: (q('.deal-price-hero') || {}).innerText,
          saving: top(q('[data-testid="deal-saving"]')), meter: top(q('.gm')), countdown: top(q('[data-testid="deal-countdown"]')),
          qty: top(q('[data-testid="join-qty"]')), delivery: top(q('[data-testid="delivery-options"]')), cta: top(q('[data-testid="join-open"]')),
          ctaText: q('[data-testid="join-open"]').innerText, demo: Boolean(q('.staging-flag')), inquiry: top(q('[data-testid="inquiry-open"]')),
          meterText: (q('.gm-meta') || {}).innerText, vh: window.innerHeight, needed: (q('[data-testid="deal-needed"]') || {}).innerText || null
        };
      })()`);
      assert(snap.title < snap.price && snap.price < snap.meter && snap.meter < snap.countdown && snap.countdown < snap.cta, `decision order broken: ${JSON.stringify(snap)}`);
      assert(snap.saving && snap.saving < snap.meter, "saving badge under the price");
      assert(/עוד \d+ ליעד/.test(snap.ctaText), `CTA must say how many are still needed: ${snap.ctaText}`);
      assert(snap.demo, "demo disclosure pill missing");
      assert(snap.cta <= snap.vh * 2.2, `CTA below two phone screens (${snap.cta}px)`);
      await cdp.shot("06_deal_390_top.png");
      await cdp.evaluate(`window.scrollTo(0, ${Math.max(0, snap.cta - 520)})`);
      await wait(300);
      await cdp.shot("07_deal_390_cta.png");
      return check("deal", { order: [snap.title, snap.price, snap.saving, snap.meter, snap.countdown, snap.qty, snap.delivery, snap.cta], cta: snap.ctaText, price: snap.priceLabel, needed: snap.needed });
    });

    await run("P8 @390: a slow backend answer shows the branded loader and, after 6 s, the honest slow-load hint (never fake success)", async () => {
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/api/deals/${dealId}/public*`, requestStage: "Request" }] });
      const held = [];
      cdp.on((msg) => { if (msg.method === "Fetch.requestPaused") held.push(msg.params.requestId); });
      await cdp.navigate("about:blank"); await wait(300);
      await cdp.navigate(`${BASE}/preview/#/deal/${dealId}`);
      await waitFor(cdp, exists('[data-testid="brand-loader"]'), 15000, "brand loader");
      await waitFor(cdp, `document.querySelector('[data-testid="brand-loader"]')?.getAttribute('data-slow') === '1'`, 12000, "slow hint");
      const hint = await cdp.evaluate(text('[data-testid="brand-loader-slow"]'));
      assert(/מתעורר|חצי דקה/.test(hint), `hint text: ${hint}`);
      assert(!(await cdp.evaluate(exists('[data-testid="join-open"]'))), "no success rendered while the request is still pending");
      await cdp.shot("08_deal_slow_loading_390.png");
      for (const id of held.splice(0)) { await cdp.send("Fetch.continueRequest", { requestId: id }).catch(() => {}); }
      await cdp.send("Fetch.disable");
      await waitFor(cdp, exists('[data-testid="join-open"]'), 20000, "deal after release");
      return "loader → slow hint → real content";
    });

    await run("seller deal (LIVE) @390: cancel is offered, the server refuses it, the refusal is explained with the pause alternative — state unchanged", async () => {
      await cdp.navigate(`${BASE}/preview/#/seller/deal/${dealId}`);
      await waitFor(cdp, exists('[data-testid="deal-cancel-open"]'), 30000, "cancel entry on live deal");
      const stage = await cdp.evaluate(`document.querySelector('[data-testid="seller-journey"]').getAttribute('data-stage')`);
      assert(stage === "3", `live deal must be at stage 3 (collecting), got ${stage}`);
      await cdp.shot("09_seller_deal_live_390.png");
      await check("seller deal live");
      await cdp.evaluate(click('[data-testid="deal-cancel-open"]'));
      await waitFor(cdp, exists('[data-testid="deal-cancel-confirm"]'), 10000, "confirm button");
      await cdp.evaluate(click('[data-testid="deal-cancel-confirm"]'));
      await waitFor(cdp, exists('[data-testid="cancel-refused"]'), 15000, "refusal notice");
      const refusal = await cdp.evaluate(text('[data-testid="cancel-refused"]'));
      assert(/נדחה על ידי השרת/.test(refusal) && /להשהות/.test(refusal), `refusal copy: ${refusal}`);
      assert(await cdp.evaluate(exists('[data-testid="cancel-refused-pause"]')), "pause alternative button");
      await cdp.shot("10_seller_cancel_refused_390.png");
      const pub = await call(`/api/deals/${dealId}/public`);
      assert(pub.json.deal.state === "PendingTarget", `state after refused cancel: ${pub.json.deal.state}`);
      await cdp.evaluate(click('[data-testid="cancel-refused-pause"]'));
      await waitFor(cdp, exists('[data-testid="pause-joining-confirm"]'), 10000, "pause confirmation opens from the refusal");
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.innerText.trim() === 'ביטול'); b && b.click(); return true; })()`);
      return { refusal: refusal.slice(0, 80) };
    });

    await run("admin sellers @390: pending queue lists the self-registered seller with who/when and one-tap approve", async () => {
      await cdp.navigate(`${BASE}/preview/#/admin/sellers`);
      await waitFor(cdp, exists('[data-testid="pending-sellers-queue"]'), 30000, "pending queue");
      const snap = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="pending-seller-row"]')];
        const dana = rows.find(r => /dana/.test(r.getAttribute('data-seller-id')));
        return { rows: rows.length, dana: dana ? dana.innerText : null, approve: Boolean(dana && dana.querySelector('[data-testid="pending-approve"]')), top: document.querySelector('[data-testid="pending-sellers-queue"]').getBoundingClientRect().top };
      })()`);
      assert(snap.rows >= 2, `pending rows ${snap.rows}`);
      assert(snap.dana && /קפה דנה|dana/.test(snap.dana) && /נרשם/.test(snap.dana), `queue row: ${snap.dana}`);
      assert(snap.approve, "approve button on the row");
      assert(snap.top < 400, `queue must be at the top of the screen (${snap.top}px)`);
      await cdp.shot("11_admin_sellers_queue_390.png");
      return check("admin sellers", { rows: snap.rows });
    });

    await run("admin overview @390: pending alert above every other number; pilot metrics show open-now + unanswered inquiries", async () => {
      await cdp.navigate(`${BASE}/preview/#/admin`);
      await waitFor(cdp, exists('[data-testid="pending-sellers-alert"]'), 30000, "pending alert");
      await waitFor(cdp, exists('[data-testid="pilot-metrics"]'), 30000, "pilot metrics");
      const snap = await cdp.evaluate(`(() => ({
        alert: document.querySelector('[data-testid="pending-sellers-alert"]').innerText,
        alertTop: document.querySelector('[data-testid="pending-sellers-alert"]').getBoundingClientRect().top,
        firstTileTop: document.querySelector('.stat-row').getBoundingClientRect().top,
        metrics: document.querySelector('[data-testid="pilot-metrics"]').innerText
      }))()`);
      assert(/ממתינים לאישור/.test(snap.alert) && snap.alertTop < snap.firstTileTop, "alert must precede the first tile");
      assert(/פתוחות להצטרפות עכשיו/.test(snap.metrics) && /ממתינות למענה/.test(snap.metrics), "new pilot tiles");
      await cdp.shot("12_admin_overview_390.png");
      return check("admin overview");
    });

    await run("admin seller detail @390: identity block + explicit 'may publish' verdict + approve", async () => {
      await cdp.navigate(`${BASE}/preview/#/admin/seller/${encodeURIComponent(`s-dana-cohen-${tag}`)}`);
      await waitFor(cdp, exists('[data-testid="seller-identity"]'), 30000, "identity block");
      const snap = await cdp.evaluate(`(() => ({
        identity: document.querySelector('[data-testid="seller-identity"]').innerText,
        verdict: document.querySelector('[data-testid="seller-can-publish"]').innerText,
        approve: Boolean(document.querySelector('[data-testid="seller-approve"]'))
      }))()`);
      assert(/דנה כהן/.test(snap.identity) && /נרשם עצמאית/.test(snap.identity), `identity: ${snap.identity.slice(0, 160)}`);
      assert(/לא יכול לפרסם/.test(snap.verdict), `verdict: ${snap.verdict}`);
      assert(snap.approve, "approve button");
      await cdp.shot("13_admin_seller_detail_390.png");
      return check("admin seller detail");
    });

    await run("0 console errors across every surface", async () => {
      assert(consoleErrors.length === 0, `console errors:\n${consoleErrors.join("\n")}`);
      return { pages: pageChecks.length };
    });
  } finally {
    cdp.close(); browser.kill("SIGKILL");
    await db.query(`UPDATE siton.seller_accounts SET verification_status='approved' WHERE seller_id='seller-default'`).catch(() => {});
    await db.end();
  }
  writeFileSync(join(SHOTS, "results.json"), JSON.stringify({ base: BASE, tag, passed, failed, results, pageChecks, consoleErrors }, null, 2));
  console.log(`\nPOLISH_UI_PROOF passed=${passed} failed=${failed} shots=${SHOTS}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
