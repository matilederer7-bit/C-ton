#!/usr/bin/env node
// LAUNCH MODE — closed-web-pilot readiness proof (API level, synthetic-only).
//
// Drives the REAL seller → buyer → inquiry → ops journey against a running
// Siton runtime (local or hosted) and prints PASS/FAIL per step. Money stays
// synthetic: the join step only exercises the app-internal mock authorization
// that every environment below "live" uses. No real provider, no real e-mail.
//
// Seller authentication, one of:
//   --seller-id=<id> --seller-code=<access code>   server-session login (cookie)
//   --email=<supabase email> --password=<pw>       GoTrue password grant (Bearer)
// Optional:
//   --admin-key=<ADMIN_API_KEY>   runs the owner/ops read probes (x-admin-key)
//   --out=<file.json>             machine-readable summary
//   --keep                        do not pause/reopen the deal at the end
//
// Usage: node scripts/pilot_readiness_proof.cjs --base-url=http://127.0.0.1:3210 --seller-id=.. --seller-code=..
const { randomUUID, randomBytes } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { writeFileSync } = require("node:fs");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = String(args["base-url"] || "").replace(/\/+$/, "");
if (!BASE) { console.error("--base-url is required"); process.exit(1); }
const ADMIN_KEY = String(args["admin-key"] || "");
const KEEP = Boolean(args.keep);
const OUT = String(args.out || "");

let passed = 0, failed = 0;
const results = [];
const facts = {};
async function step(name, fn) {
  try { const detail = await fn(); passed++; results.push({ name, ok: true, detail: detail ?? null }); console.log(`PASS ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 160)}` : ""}`); }
  catch (e) { failed++; results.push({ name, ok: false, error: String(e.message || e) }); console.error(`FAIL ${name}: ${String(e.message || e).slice(0, 400)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── auth ──────────────────────────────────────────────────────────────────
let sellerCookie = "";
let sellerBearer = "";
function sellerHeaders(extra = {}) {
  const h = { ...extra };
  if (sellerBearer) h.authorization = `Bearer ${sellerBearer}`;
  if (sellerCookie) h.cookie = `siton_seller_session=${sellerCookie}`;
  return h;
}
async function call(path, { method = "GET", body, headers = {}, auth = "none" } = {}) {
  const h = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  if (auth === "seller") Object.assign(h, sellerHeaders());
  if (auth === "admin") h["x-admin-key"] = ADMIN_KEY;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

// ── tiny PNG (solid colour) so the image rail is exercised for real ───────
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function makePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = (rgb[2] + x + y) & 0xff; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const OPEN_STATES = ["PendingTarget", "TargetReached"];
const tag = randomBytes(3).toString("hex");

(async () => {
  console.log(`PILOT_READINESS_PROOF base=${BASE} tag=${tag}`);

  await step("runtime: /health + /readiness answer", async () => {
    const h = await call("/health"); assert(h.status === 200, `health ${h.status}`);
    const r = await call("/readiness"); assert(r.status === 200, `readiness ${r.status}: ${r.text.slice(0, 120)}`);
    const m = await call("/api/preview/meta"); assert(m.status === 200 && m.json?.ok, "meta");
    facts.runtime_commit = m.json?.preview?.deployment?.runtime_commit_sha || null;
    facts.payment_is_real = m.json?.preview?.guardrails?.payment_is_real;
    assert(facts.payment_is_real === false, "payment_is_real must be false for this proof");
    return { runtime_commit: facts.runtime_commit, public_mall_enabled: m.json?.public_mall_enabled };
  });

  await step("seller: login", async () => {
    if (args.email && args.password) {
      const cfg = await call("/api/preview/auth-config"); assert(cfg.json?.configured, "auth-config not configured");
      const res = await fetch(`${cfg.json.supabase_url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: cfg.json.supabase_anon_key, "content-type": "application/json" }, body: JSON.stringify({ email: args.email, password: args.password }) });
      const body = await res.json(); assert(res.ok && body.access_token, `supabase login ${res.status}`);
      sellerBearer = body.access_token;
      const caps = await call("/api/auth/capabilities", { headers: { authorization: `Bearer ${sellerBearer}` } });
      assert(caps.status === 200 && caps.json?.seller, `capabilities: ${caps.text.slice(0, 160)}`);
      return `bearer seller=${caps.json.seller.seller_id}`;
    }
    assert(args["seller-id"] && args["seller-code"], "provide --seller-id/--seller-code or --email/--password");
    const r = await call("/api/seller/session/login", { method: "POST", body: { identifier: args["seller-id"], access_code: args["seller-code"] } });
    assert(r.status === 200 && r.json?.ok, `login ${r.status}: ${r.text.slice(0, 160)}`);
    const sc = r.headers.get("set-cookie") || ""; const m = sc.match(/siton_seller_session=([^;]+)/); assert(m, "no session cookie");
    sellerCookie = m[1];
    return `cookie seller=${r.json.seller_auth?.seller_context?.seller_id}`;
  });

  await step("seller: context readable (bootstrap state)", async () => {
    const r = await call("/api/seller/context", { auth: "seller" }); assert(r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    facts.seller_id = r.json.seller_context.seller_id;
    return { seller_id: facts.seller_id, verification: r.json.seller_context.verification_status, business_name: r.json.seller_context.business_name || null };
  });

  await step("seller: bootstrap profile (business name + support contact)", async () => {
    const r = await call("/api/seller/profile", { method: "PUT", auth: "seller", body: { business_name: `עסק פיילוט ${tag}`, contact_name: "בודק פיילוט", support_email: `pilot-${tag}@siton.test`, business_description: "עסק לבדיקת מוכנות פיילוט (סינתטי)" } });
    assert(r.status === 200 && r.json?.ok, `${r.status} ${r.text.slice(0, 160)}`);
    return { profile_ready: Boolean(r.json.profile?.business_name && r.json.profile?.support_email) };
  });

  let dealId = "";
  const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  await step("seller: create deal (Draft) — physical, pickup with real location + delivery", async () => {
    const r = await call("/api/deals", { method: "POST", auth: "seller", headers: { "idempotency-key": `pilot-create-${randomUUID()}` }, body: {
      deal_type: "physical_product",
      title: `[פיילוט ${tag}] מארז דבש בוטיק 1 ק״ג`,
      description_short: "דבש פרחי בר מכוורת משפחתית — מחיר קבוצתי",
      description: "מארז דבש 1 ק״ג ישירות מהמכוורת. איסוף עצמי מהרצל 12 תל אביב או משלוח. (עסקת בדיקה סינתטית)",
      price_per_unit: 49, list_price_per_unit: 65, min_units: 5, max_units: 20, deadline,
      delivery_options: [
        { option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, latitude: 32.0853, longitude: 34.7818 },
        { option_type: "delivery", label: "משלוח עד הבית", cost: 15 }
      ]
    } });
    assert(r.status === 201 || r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    dealId = String(r.json.deal_id || r.json.deal?.deal_id || ""); assert(dealId, "no deal_id in response");
    facts.deal_id = dealId;
    return { deal_id: dealId, state: r.json.state || r.json.deal?.state };
  });

  await step("seller: edit draft (title/short description/price)", async () => {
    const r = await call(`/api/seller/deals/${dealId}/draft`, { method: "PATCH", auth: "seller", body: { title: `[פיילוט ${tag}] מארז דבש בוטיק 1 ק״ג — קציר 2026`, description_short: "דבש פרחי בר — מחיר קבוצתי לזמן מוגבל", price_per_unit: 45 } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const g = await call(`/api/seller/deals/${dealId}`, { auth: "seller" }); assert(g.status === 200, `read-back ${g.status}`);
    const d = g.json.deal || g.json;
    assert(Number(d.price_per_unit) === 45, `price not updated: ${d.price_per_unit}`);
    assert(String(d.title || "").includes("קציר 2026"), "title not updated");
    return "edited + read back";
  });

  await step("seller: upload image (base64 rail, idempotent)", async () => {
    const png = makePng(96, 96, [230, 120, 20]);
    const body = { mime_type: "image/png", image_base64: png.toString("base64"), original_filename: `pilot-${tag}.png`, is_primary: true };
    const r = await call(`/api/seller/deals/${dealId}/images`, { method: "POST", auth: "seller", headers: { "idempotency-key": `pilot-img-${dealId}-1` }, body });
    assert(r.status === 201 || r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const again = await call(`/api/seller/deals/${dealId}/images`, { method: "POST", auth: "seller", headers: { "idempotency-key": `pilot-img-${dealId}-1` }, body });
    assert([200, 201, 409].includes(again.status), `replay ${again.status}`);
    const g = await call(`/api/seller/deals/${dealId}`, { auth: "seller" });
    const imgs = (g.json.deal || g.json).images || [];
    assert(imgs.length >= 1, `images after upload: ${imgs.length}`);
    return { images: imgs.length, replay_status: again.status };
  });

  await step("seller: buyer preview of the Draft (no seller e-mail, pickup location projected)", async () => {
    const r = await call(`/api/seller/deals/${dealId}/preview`, { auth: "seller" }); assert(r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    const d = r.json.deal || r.json;
    assert(!EMAIL_RE.test(JSON.stringify(d.seller || {})), "seller e-mail leaked into preview payload");
    const pickup = (d.delivery_options || []).find((o) => o.option_type === "pickup");
    assert(pickup && pickup.has_location, "pickup option lacks location projection");
    assert((d.images || []).length >= 1, "preview has no image");
    return { has_location: pickup.has_location, map_url: Boolean(pickup.map_url) };
  });

  await step("seller: publish refused without the three acknowledgements", async () => {
    const r = await call(`/api/deals/${dealId}/publish`, { method: "POST", auth: "seller", body: {} });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    return r.json?.code || r.json?.error;
  });

  await step("seller: publish → open for joining", async () => {
    const r = await call(`/api/deals/${dealId}/publish`, { method: "POST", auth: "seller", body: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 240)}`);
    const g = await call(`/api/deals/${dealId}/public`); assert(g.status === 200, `public ${g.status}`);
    const d = g.json.deal || g.json;
    assert(OPEN_STATES.includes(d.state), `state after publish: ${d.state}`);
    facts.threshold_units = Number(d.threshold_units);
    return { state: d.state, threshold: d.threshold_units, min: d.min_units, max: d.max_units };
  });

  let publicDeal = null;
  await step("buyer: public deal page payload — price/threshold/deadline/pickup visible, no seller e-mail", async () => {
    const g = await call(`/api/deals/${dealId}/public`); assert(g.status === 200, `${g.status}`);
    publicDeal = g.json.deal || g.json;
    assert(Number(publicDeal.price_per_unit) > 0, "price missing");
    assert(Number(publicDeal.threshold_units) > 0 && Number(publicDeal.max_units) > 0, "threshold/max missing");
    assert(publicDeal.deadline, "deadline missing");
    const pickup = (publicDeal.delivery_options || []).find((o) => o.option_type === "pickup");
    assert(pickup && pickup.has_location && pickup.location_text, "pickup location not visible on public payload");
    assert(!EMAIL_RE.test(JSON.stringify(publicDeal.seller || {})), "seller e-mail leaked on public payload");
    // Regular price (launch branch): runtimes before migration 065 ignore the field — reported, not failed.
    facts.has_list_price = publicDeal.list_price_per_unit !== undefined;
    if (facts.has_list_price && publicDeal.list_price_per_unit !== null) assert(Number(publicDeal.list_price_per_unit) === 65, `list price mismatch: ${publicDeal.list_price_per_unit}`);
    return { price: publicDeal.price_per_unit, list_price: facts.has_list_price ? publicDeal.list_price_per_unit : "NOT_SUPPORTED_ON_THIS_RUNTIME", contact_channel: publicDeal.seller?.contact_channel || null };
  });

  await step("buyer: share route /d/:id renders OG meta and forwards humans", async () => {
    const r = await call(`/d/${dealId}`);
    assert(r.status === 200, `${r.status}`);
    assert(/og:title/.test(r.text) && /og:image/.test(r.text), "OG meta missing");
    return "og:title + og:image present";
  });

  await step("analytics: deal_view + join_started funnel events accepted", async () => {
    const visitor = `v_${tag}_${randomBytes(4).toString("hex")}`; const session = `s_${tag}_${randomBytes(4).toString("hex")}`;
    for (const event_type of ["deal_view", "join_started"]) {
      const r = await call("/api/viral/events", { method: "POST", body: { event_type, deal_id: dealId, ref_code: null, share_channel: null, visitor_id: visitor, session_id: session, client_event_id: `ev_${randomBytes(8).toString("hex")}` } });
      assert(r.status < 300, `${event_type}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    return "2 events";
  });

  await step("buyer: join refused without payment disclosure (join_failed path — NOT persisted today)", async () => {
    const r = await call(`/api/deals/${dealId}/join`, { method: "POST", headers: { "idempotency-key": `pilot-join-neg-${randomUUID()}` }, body: { buyer_id: `05${tag.slice(0, 2)}0000001`, buyer_name: "בודק", qty: 1, delivery_option_id: publicDeal.delivery_options[0].option_id, buyer_terms_accepted: true, payment_disclosure_accepted: false } });
    assert(r.status === 400, `expected 400 got ${r.status}: ${r.text.slice(0, 120)}`);
    return r.json?.code || r.json?.error || r.json?.message;
  });

  const joins = [];
  await step(`buyer: ${facts.threshold_units || 5} synthetic joins reach the threshold (mock authorization, real money 0)`, async () => {
    const n = Math.max(1, facts.threshold_units || 5);
    const pickup = (publicDeal.delivery_options || []).find((o) => o.option_type === "pickup") || publicDeal.delivery_options[0];
    for (let i = 0; i < n; i++) {
      const phone = `05${String(300000000 + parseInt(tag, 16) % 100000 + i).slice(0, 8)}`;
      const r = await call(`/api/deals/${dealId}/join`, { method: "POST", headers: { "idempotency-key": `pilot-join-${dealId}-${i}` }, body: { buyer_id: phone, buyer_name: `קונה פיילוט ${i + 1}`, buyer_email: `buyer-${tag}-${i}@siton.test`, qty: 1, delivery_option_id: pickup.option_id, payment_method: i % 2 ? "bit" : "credit_card", buyer_terms_accepted: true, payment_disclosure_accepted: true, source: "direct" } });
      assert(r.status === 201 || r.status === 200, `join ${i}: ${r.status} ${r.text.slice(0, 200)}`);
      assert(r.json.participant_id && r.json.tracking_access_token, `join ${i}: missing participant/tracking token`);
      joins.push({ participant_id: r.json.participant_id, token: r.json.tracking_access_token, share_url: r.json.viral?.personal_share_url || null });
    }
    const g = await call(`/api/deals/${dealId}/public`); const d = g.json.deal || g.json;
    facts.state_after_joins = d.state;
    assert(d.state === "TargetReached", `expected TargetReached after ${n} joins, got ${d.state}`);
    return { joins: joins.length, state: d.state, personal_share_links: joins.filter((j) => j.share_url).length };
  });

  await step("buyer: personal tracking page reads (token-bound)", async () => {
    const j = joins[0]; assert(j, "no join to track");
    const r = await call(`/api/participants/${j.participant_id}/tracking`, { headers: { authorization: `Bearer ${j.token}` } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    const anon = await call(`/api/participants/${j.participant_id}/tracking`);
    assert(anon.status === 401 || anon.status === 403 || anon.status === 404, `anonymous tracking should be refused, got ${anon.status}`);
    return { buyer_state: r.json.participant?.buyer_state || r.json.buyer_state || null, anonymous_refused: anon.status };
  });

  await step("seller: active deal shows participants/progress + seller actions", async () => {
    const r = await call(`/api/seller/deals/${dealId}`, { auth: "seller" }); assert(r.status === 200, `${r.status}`);
    const d = r.json.deal || r.json;
    const participants = d.participants || r.json.participants || [];
    const joined = Number(d.joined_units ?? d.progress?.joined_units ?? participants.length);
    assert(joined >= joins.length || participants.length >= joins.length, `seller view joined=${joined} participants=${participants.length}`);
    assert(r.json.seller_actions || d.seller_actions, "seller_actions missing");
    return { state: d.state, joined, participants: participants.length };
  });

  await step("seller: analytics/command center returns a funnel (views, join starts, joins)", async () => {
    const r = await call(`/api/seller/analytics?period=all&deal_id=${dealId}`, { auth: "seller" }); assert(r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    const a = r.json.analytics || r.json;
    const f = a.funnel || {};
    assert(f.views !== undefined && f.join_starts !== undefined && f.joins !== undefined, `funnel keys: ${Object.keys(f)}`);
    return { views: f.views, join_starts: f.join_starts, joins: f.joins, inquiries_block: Boolean(a.inquiries) };
  });

  let thread = null;
  await step("buyer: send inquiry to seller (internal rail) → thread + token", async () => {
    const r = await call(`/api/deals/${dealId}/inquiries`, { method: "POST", body: { name: "קונה שואל", email: `asker-${tag}@siton.test`, message: `שאלה סינתטית ${tag}: האם אפשר לאסוף בערב?` } });
    assert(r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    assert(r.json.thread_id && r.json.access_token, "thread/token missing");
    thread = { id: r.json.thread_id, token: r.json.access_token };
    return { thread_id: thread.id };
  });

  await step("buyer: return to existing inquiry (token) + follow-up message", async () => {
    const g = await call(`/api/inquiries/${thread.id}?t=${encodeURIComponent(thread.token)}`); assert(g.status === 200, `${g.status} ${g.text.slice(0, 120)}`);
    const bad = await call(`/api/inquiries/${thread.id}?t=wrong-token`); assert(bad.status === 404, `wrong token should 404, got ${bad.status}`);
    const f = await call(`/api/inquiries/${thread.id}/messages`, { method: "POST", body: { access_token: thread.token, message: `המשך ${tag}: תודה, אחכה לתשובה.` } });
    assert(f.status === 201, `follow-up ${f.status} ${f.text.slice(0, 120)}`);
    return "thread readable, wrong token refused, follow-up stored";
  });

  await step("seller: inquiry appears in the seller inbox and reply reaches the buyer", async () => {
    const list = await call(`/api/seller/inquiries?scope=open`, { auth: "seller" }); assert(list.status === 200, `${list.status}`);
    assert(list.text.includes(thread.id), "thread not in seller open inbox");
    const rep = await call(`/api/seller/inquiries/${thread.id}/reply`, { method: "POST", auth: "seller", body: { message: `תשובת המוכר ${tag}: כן, איסוף עד 20:00.` } });
    assert(rep.status === 201 && rep.json.status === "Answered", `reply ${rep.status} ${rep.text.slice(0, 120)}`);
    const g = await call(`/api/inquiries/${thread.id}?t=${encodeURIComponent(thread.token)}`);
    assert(g.text.includes("תשובת המוכר"), "buyer does not see the seller reply");
    return "seller reply visible to buyer";
  });

  await step("seller: pause joining (close_joining) → join refused → reopen", async () => {
    const p = await call(`/api/deals/${dealId}/close_joining`, { method: "POST", auth: "seller", body: {} });
    assert(p.status === 200, `pause ${p.status} ${p.text.slice(0, 160)}`);
    const g = await call(`/api/deals/${dealId}/public`); const d = g.json.deal || g.json;
    assert(d.state === "ClosedForJoining", `state after pause: ${d.state}`);
    const j = await call(`/api/deals/${dealId}/join`, { method: "POST", headers: { "idempotency-key": `pilot-join-paused-${randomUUID()}` }, body: { buyer_id: "0559999999", buyer_name: "מאחר", qty: 1, delivery_option_id: publicDeal.delivery_options[0].option_id, buyer_terms_accepted: true, payment_disclosure_accepted: true } });
    assert(j.status >= 400 && j.status < 500, `join while paused should be refused, got ${j.status}`);
    if (KEEP) return { paused: true, join_refused: j.status, reopened: false };
    const r = await call(`/api/deals/${dealId}/reopen_joining`, { method: "POST", auth: "seller", body: {} });
    assert(r.status === 200, `reopen ${r.status} ${r.text.slice(0, 160)}`);
    const g2 = await call(`/api/deals/${dealId}/public`); const d2 = g2.json.deal || g2.json;
    assert(OPEN_STATES.includes(d2.state), `state after reopen: ${d2.state}`);
    return { paused: true, join_refused: j.status, reopened_state: d2.state };
  });

  await step("seller: cross-seller isolation — foreign seller cannot read/mutate this deal", async () => {
    const r = await call(`/api/seller/deals/${dealId}`);
    assert(r.status === 401 || r.status === 403, `anonymous seller read should be refused, got ${r.status}`);
    const pub = await call(`/api/deals/${dealId}/publish`, { method: "POST", body: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
    assert(pub.status === 401 || pub.status === 403, `anonymous publish should be refused, got ${pub.status}`);
    return "anonymous refused on seller read + publish";
  });

  if (ADMIN_KEY) {
    await step("ops: owner can see active deals, participants, failures, inquiries, cases, health", async () => {
      const ov = await call("/api/admin/r6/overview", { auth: "admin" }); assert(ov.status === 200, `overview ${ov.status} ${ov.text.slice(0, 120)}`);
      const deals = await call("/api/admin/r6/deals?state=TargetReached", { auth: "admin" }); assert(deals.status === 200, `deals ${deals.status}`);
      assert(deals.text.includes(dealId), "pilot deal not in admin deals list");
      const sys = await call("/api/admin/system-status", { auth: "admin" }); assert(sys.status === 200, `system-status ${sys.status}`);
      const cases = await call("/api/admin/support-cases", { auth: "admin" }); assert(cases.status === 200, `support-cases ${cases.status}`);
      const growth = await call("/api/admin/growth", { auth: "admin" }); assert(growth.status === 200, `growth ${growth.status}`);
      const outbox = await call("/api/admin/outbox-status", { auth: "admin" }); assert(outbox.status === 200, `outbox ${outbox.status}`);
      return { deals_by_state: ov.json?.deals?.by_state || ov.json?.deals || null, participants_total: ov.json?.participants?.total ?? null, dlq: ov.json?.ops?.dlq_size ?? null };
    });
    await step("ops: pilot metrics endpoint (funnel + seller repeat) — if deployed", async () => {
      const r = await call("/api/admin/pilot-metrics", { auth: "admin" });
      if (r.status === 404) return "NOT DEPLOYED on this runtime (pre-launch-branch)";
      assert(r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
      assert(r.json?.sellers && r.json?.deals && r.json?.buyers, `keys: ${Object.keys(r.json || {})}`);
      return { sellers: r.json.sellers, deals: r.json.deals, buyers: r.json.buyers };
    });
  }

  console.log(`\nPILOT_READINESS_SUMMARY passed=${passed} failed=${failed} deal=${dealId}`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ base: BASE, tag, passed, failed, facts, results }, null, 2));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
