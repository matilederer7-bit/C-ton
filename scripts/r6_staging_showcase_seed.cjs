#!/usr/bin/env node
// R6 staging showcase seeder + hosted proof driver.
//
// Drives the REAL hosted staging API end-to-end (no direct DB writes): a
// synthetic seller creates and publishes a varied catalog with generated
// imagery, synthetic buyers join through the public Join API — including
// multi-generation personal-share-link chains — and one small deal is walked
// through close→prepare→charge so the continuous Worker produces genuine
// charged money (mockpay). Everything it creates is clearly marked synthetic.
//
// Usage:
//   node scripts/r6_staging_showcase_seed.cjs --base-url=https://siton-staging-web.onrender.com \
//     --seller-email=... --seller-password=...
//
// The seller credential must already exist as a Supabase auth user bound to a
// seller account (see docs/R6_STAGING_SHOWCASE.md).

const zlib = require("node:zlib");
const crypto = require("node:crypto");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"];
}));
const BASE = (args["base-url"] || process.env.SITON_BASE_URL || "").replace(/\/+$/, "");
const SELLER_EMAIL = args["seller-email"] || process.env.SEED_SELLER_EMAIL || "";
const SELLER_PASSWORD = args["seller-password"] || process.env.SEED_SELLER_PASSWORD || "";
if (!BASE || !SELLER_EMAIL || !SELLER_PASSWORD) {
  console.error("required: --base-url, --seller-email, --seller-password");
  process.exit(1);
}

// ── tiny PNG writer (truecolor, no deps) ───────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32b(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32b(body));
  return Buffer.concat([len, body, crc]);
}
// Layered gradient + soft discs — commercial-looking abstract product art.
function makePng(width, height, palette, seed) {
  const rnd = (() => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff); })();
  const discs = Array.from({ length: 5 }, () => ({
    x: rnd() * width, y: rnd() * height, r: (0.15 + rnd() * 0.3) * width,
    c: palette[1 + Math.floor(rnd() * (palette.length - 1))], a: 0.25 + rnd() * 0.3
  }));
  const [c0, c1] = [palette[0], palette[palette.length - 1]];
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let r = c0[0] + (c1[0] - c0[0]) * t;
      let g = c0[1] + (c1[1] - c0[1]) * t;
      let b = c0[2] + (c1[2] - c0[2]) * t;
      for (const d of discs) {
        const dist = Math.hypot(x - d.x, y - d.y);
        if (dist < d.r) {
          const f = d.a * (1 - dist / d.r);
          r = r + (d.c[0] - r) * f;
          g = g + (d.c[1] - g) * f;
          b = b + (d.c[2] - b) * f;
        }
      }
      const o = y * (1 + width * 3) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ── http helpers ───────────────────────────────────────────────────────────
async function http(path, init = {}, token = "") {
  const headers = { "content-type": "application/json", ...(init.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomUUID();

async function supabaseToken() {
  const cfg = await http("/api/preview/auth-config");
  const res = await fetch(`${cfg.supabase_url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.supabase_anon_key },
    body: JSON.stringify({ email: SELLER_EMAIL, password: SELLER_PASSWORD })
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(`seller sign-in failed: ${JSON.stringify(body).slice(0, 200)}`);
  return body.access_token;
}

// ── catalog (clearly synthetic staging data) ──────────────────────────────
const PALETTES = {
  olive: [[87, 108, 60], [166, 187, 100], [222, 231, 176]],
  honey: [[178, 106, 20], [235, 172, 60], [250, 227, 160]],
  sea: [[16, 84, 116], [42, 158, 180], [176, 226, 232]],
  berry: [[110, 26, 74], [196, 64, 128], [244, 190, 216]],
  coffee: [[62, 40, 24], [140, 94, 60], [218, 190, 160]],
  citrus: [[190, 84, 12], [240, 150, 40], [252, 220, 130]],
  tech: [[30, 40, 70], [80, 110, 200], [190, 210, 250]],
  spa: [[40, 90, 80], [120, 180, 160], [220, 240, 230]]
};

const CATALOG = [
  {
    key: "olives", palette: "olive", seed: 11,
    title: "מארז זיתי סוריה מסורתיים 3 ק״ג — ישר מהבציר",
    description: "זיתים ירוקים במלח גס, כבישה ביתית של משפחת חורי מהגליל. מארז 3 ק״ג בדלי אטום. [דמו סינתטי]",
    price: 89, min: 12, max: 60,
    delivery: [
      { option_type: "pickup", label: "איסוף עצמי — שוק רמלה, דוכן 14", cost: 0 },
      { option_type: "delivery", label: "משלוח עד הבית (מרכז)", cost: 20 }
    ]
  },
  {
    key: "oil", palette: "citrus", seed: 22,
    title: "שמן זית כתית מעולה 5 ליטר — קציר 2026",
    description: "כתישה קרה, חמיצות 0.3%. פח 5 ליטר ממשק בוטיק ברמת הגולן. מחיר קבוצתי מטורף. [דמו סינתטי]",
    price: 165, min: 20, max: 100,
    delivery: [
      { option_type: "pickup", label: "איסוף מהמשק — מרום גולן", cost: 0 },
      { option_type: "distribution_point", label: "נקודת חלוקה — תל אביב, שוק הכרמל", cost: 10 },
      { option_type: "delivery", label: "משלוח עד הבית", cost: 25 }
    ]
  },
  {
    key: "coffee", palette: "coffee", seed: 33,
    title: "פולי קפה ספיישלטי 1 ק״ג — קלייה טרייה",
    description: "בלנד אתיופיה-קולומביה, נקלה 48 שעות לפני החלוקה. טחינה לפי בקשה. [דמו סינתטי]",
    price: 95, min: 15, max: 80,
    delivery: [
      { option_type: "pickup", label: "איסוף מבית הקלייה — חיפה", cost: 0 },
      { option_type: "delivery", label: "משלוח קירור", cost: 18 }
    ]
  },
  {
    key: "honey", palette: "honey", seed: 44,
    title: "דבש אביב טהור 1.5 ק״ג ממכוורת בוטיק",
    description: "דבש פרחי בר לא מחומם ולא מסונן. צנצנת זכוכית 1.5 ק״ג. כמות מוגבלת מהרדייה האחרונה. [דמו סינתטי]",
    price: 78, min: 10, max: 40,
    delivery: [{ option_type: "pickup", label: "איסוף מהמכוורת — זכרון יעקב", cost: 0 }]
  },
  {
    key: "cheese", palette: "spa", seed: 55,
    title: "מגש גבינות בוטיק 2 ק״ג — מחלבת העמק",
    description: "שמונה סוגי גבינות עיזים וכבשים, נחתך ביום החלוקה. כשר. [דמו סינתטי]",
    price: 149, min: 8, max: 30,
    delivery: [
      { option_type: "distribution_point", label: "נקודת חלוקה — כפר יהושע", cost: 0 },
      { option_type: "delivery", label: "משלוח קירור (עמקים)", cost: 22 }
    ]
  },
  {
    key: "tech", palette: "tech", seed: 66,
    title: "אוזניות אלחוטיות ANC — יבוא קבוצתי רשמי",
    description: "דגם 2026 עם ביטול רעשים אקטיבי, אחריות יבואן שנה. המחיר יורד רק כשכולם נכנסים. [דמו סינתטי]",
    price: 219, min: 25, max: 120,
    delivery: [{ option_type: "delivery", label: "משלוח שליח עד הבית", cost: 0 }]
  },
  {
    key: "completedDemo", palette: "berry", seed: 77,
    title: "מארז תותים אורגניים 2 ק״ג — חלוקה מחר",
    description: "תותי שדה אורגניים, נקטפים בבוקר החלוקה. עסקה מהירה של 24 שעות. [דמו סינתטי — הושלמה]",
    price: 55, min: 3, max: 25, chargeFlow: true,
    delivery: [{ option_type: "pickup", label: "איסוף מהחווה — גן שמואל", cost: 0 }]
  },
  {
    key: "draftDemo", palette: "sea", seed: 88, draft: true,
    title: "סדנת גלישה קבוצתית — טיוטה לדוגמה",
    description: "טיוטה שממתינה להשלמת פרטים. [דמו סינתטי — טיוטה]",
    price: 180, min: 6, max: 20,
    delivery: [{ option_type: "pickup", label: "חוף הצוק", cost: 0 }]
  }
];

// Synthetic buyers (fake staging identities, clearly marked).
const BUYERS = [
  ["0521000001", "נועה לוי"], ["0521000002", "אבי מזרחי"], ["0521000003", "שרה כהן"],
  ["0521000004", "דוד פרץ"], ["0521000005", "רות אזולאי"], ["0521000006", "יוסי ביטון"],
  ["0521000007", "מיכל שדה"], ["0521000008", "עומר גל"], ["0521000009", "תמר ניר"],
  ["0521000010", "אלון ברק"], ["0521000011", "הילה אדרי"], ["0521000012", "נדב שוורץ"]
];

async function join(dealId, buyer, opts = {}) {
  const [phone, name] = buyer;
  const payload = {
    buyer_id: phone,
    buyer_name: name,
    qty: opts.qty || 1,
    buyer_terms_accepted: true,
    payment_disclosure_accepted: true,
    delivery_option_id: opts.deliveryOptionId,
    delivery_address: opts.address,
    delivery_city: opts.city,
    affiliate_ref: opts.ref,
    viral_last_touch_code: opts.ref,
    viral_last_touch_at: opts.ref ? new Date().toISOString() : undefined,
    viral_first_touch_code: opts.firstTouch || opts.ref,
    viral_first_touch_at: opts.ref ? new Date().toISOString() : undefined,
    viral_visitor_id: `seed_v_${phone}`,
    viral_session_id: `seed_s_${phone}_${Date.now()}`
  };
  const res = await http(`/api/deals/${dealId}/join`, {
    method: "POST",
    headers: { "idempotency-key": `r6-seed-${dealId}-${phone}-${rid()}` },
    body: JSON.stringify(payload)
  });
  return res;
}

async function funnel(dealId, type, ref, extra = {}) {
  await http("/api/viral/events", {
    method: "POST",
    body: JSON.stringify({
      event_type: type, deal_id: dealId, ref_code: ref || null,
      client_event_id: `seed_${type}_${rid().slice(0, 18)}`,
      visitor_id: `seed_v_${rid().slice(0, 8)}`, session_id: `seed_s_${rid().slice(0, 8)}`,
      ...extra
    })
  }).catch(() => undefined);
}

async function visit(dealId, code) {
  if (!code) return;
  await http("/api/affiliate/links/visit", {
    method: "POST",
    body: JSON.stringify({ deal_id: dealId, source_code: code, click_id: `seed_ck_${rid().slice(0, 10)}`, entry_id: `seed_en_${rid().slice(0, 10)}` })
  }).catch(() => undefined);
}

async function main() {
  console.log(`SEED start base=${BASE}`);
  const token = await supabaseToken();
  console.log("SEED seller signed in");
  const ctx = await http("/api/seller/context", {}, token);
  console.log(`SEED seller context: ${ctx?.seller_context?.seller_id || ctx?.seller_profile?.seller_id || "ok"}`);

  const results = [];
  for (const item of CATALOG) {
    const deadlineHours = item.chargeFlow ? 3 : 24 + Math.floor(Math.random() * 96);
    const created = await http("/api/deals", {
      method: "POST",
      headers: { "idempotency-key": `r6-seed-create-${item.key}-${rid()}` },
      body: JSON.stringify({
        title: item.title,
        description: item.description,
        price_per_unit: item.price,
        min_units: item.min,
        max_units: item.max,
        deadline: new Date(Date.now() + deadlineHours * 3600_000).toISOString(),
        deal_type: "physical_product",
        delivery_options: item.delivery
      })
    }, token);
    const dealId = created?.deal?.deal_id || created?.deal_id;
    if (!dealId) throw new Error(`no deal id for ${item.key}`);
    console.log(`SEED created ${item.key} ${dealId}`);

    // imagery: primary + one secondary generated PNG
    for (let i = 0; i < 2; i++) {
      const png = makePng(800, 500, PALETTES[item.palette], item.seed + i * 7);
      await http(`/api/seller/deals/${dealId}/images`, {
        method: "POST",
        headers: { "idempotency-key": `r6-seed-img-${item.key}-${i}` },
        body: JSON.stringify({
          mime_type: "image/png",
          image_base64: png.toString("base64"),
          original_filename: `${item.key}-${i}.png`,
          is_primary: i === 0,
          sort_order: i
        })
      }, token).catch((e) => console.log(`SEED image skip ${item.key}: ${e.message.slice(0, 120)}`));
    }

    if (item.draft) { results.push({ item, dealId, state: "Draft" }); continue; }

    await http(`/api/deals/${dealId}/publish`, {
      method: "POST",
      body: JSON.stringify({ seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true })
    }, token);
    console.log(`SEED published ${item.key}`);
    results.push({ item, dealId, state: "published" });
  }

  // ── joins with real viral chains ────────────────────────────────────────
  for (const r of results) {
    if (r.item.draft) continue;
    const dealPublic = await http(`/api/deals/${r.dealId}/public`);
    const deliveryOptions = dealPublic?.deal?.delivery_options || [];
    const pickOption = () => deliveryOptions.length ? deliveryOptions[Math.floor(Math.random() * deliveryOptions.length)] : null;
    const isChargeFlow = Boolean(r.item.chargeFlow);
    const buyerCount = isChargeFlow ? 3 : 4 + Math.floor(Math.random() * 4);
    const buyers = BUYERS.slice(0, buyerCount);

    await funnel(r.dealId, "deal_view", null);
    let parentRef = null;
    let firstRef = null;
    const codes = [];
    for (let i = 0; i < buyers.length; i++) {
      const opt = pickOption();
      const needsAddress = opt?.option_type === "delivery";
      const useRef = i > 0 && (i % 3 !== 0) ? parentRef : null; // generations + some direct joins
      if (useRef) { await visit(r.dealId, useRef); await funnel(r.dealId, "deal_view", useRef); }
      const res = await join(r.dealId, buyers[i], {
        qty: 1 + Math.floor(Math.random() * (isChargeFlow ? 2 : 3)),
        deliveryOptionId: opt?.option_id,
        address: needsAddress ? "רחוב הדקל 7" : undefined,
        city: needsAddress ? "תל אביב" : undefined,
        ref: useRef,
        firstTouch: firstRef || useRef
      });
      const code = res?.viral?.personal_share_code || null;
      if (code) {
        codes.push(code);
        await funnel(r.dealId, "share_button_click", code, { share_channel: ["whatsapp", "telegram", "copy"][i % 3] });
        // chain: next buyers join through the newest sharer (deeper generations)
        parentRef = code;
        if (!firstRef) firstRef = code;
      }
      console.log(`SEED join ${r.item.key} buyer=${buyers[i][1]} gen=${res?.viral?.generation}`);
      await sleep(150);
    }
    r.codes = codes;
  }

  // ── walk the charge-flow deal to Completed through the real Worker ─────
  const chargeDeal = results.find((r) => r.item.chargeFlow);
  if (chargeDeal) {
    const dealId = chargeDeal.dealId;
    console.log(`SEED charge-flow: closing ${dealId}`);
    await http(`/api/deals/${dealId}/close_joining`, { method: "POST", body: "{}" }, token);
    await http(`/api/deals/${dealId}/prepare_charging`, { method: "POST", body: "{}" }, token);
    await http(`/api/deals/${dealId}/charging/start`, { method: "POST", body: "{}" }, token);
    console.log("SEED charge-flow: charging started; waiting for the Worker…");
    let state = "";
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const pub = await http(`/api/deals/${dealId}/public`).catch(() => null);
      state = String(pub?.deal?.state || "");
      if (["Completed", "Failed"].includes(state)) break;
      if (i % 6 === 0) console.log(`SEED charge-flow state=${state}`);
    }
    console.log(`SEED charge-flow final state=${state}`);
  }

  console.log("\nSEED_DONE");
  for (const r of results) {
    console.log(`  ${r.item.key}: ${BASE}/preview/#/deal/${r.dealId}${r.codes?.length ? ` (personal codes: ${r.codes.slice(0, 2).join(", ")}…)` : ""}`);
  }
}

main().catch((e) => { console.error("SEED_FAILED", e.message); process.exit(1); });
