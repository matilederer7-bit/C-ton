// P0.7 — DB-exercised proof (real app, fresh migrated DB, demo-preview seller context):
//  * public deal payload carries NO seller e-mail; pickup location is projected
//    by the ONE shared rule (location_text / has_location / map_url)
//  * pickup readiness: publish is refused while a pickup-type option lacks a
//    usable location; a published deal can never drop it; legacy deals stay
//    readable and the seller Action Center flags them
//  * buyer preview (seller payload) == public payload for pickup location
//  * internal inquiry: validation, honeypot, seller resolved from the DEAL,
//    stored internally, exactly ONE notification event per new thread, retry /
//    follow-up never re-notify, pointer e-mail semantics (deep link, no
//    conversation body), HTML never stored, seller isolation, seller reply
//    stored in the product, tokenized customer read, rate limiting
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { renderNotification } = await import("../src/notification_templates.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const sellerA = `seller-p07a-${randomUUID().slice(0, 8)}`;
const sellerB = `seller-p07b-${randomUUID().slice(0, 8)}`;
const SELLER_A_EMAIL = `${sellerA}@siton.test`;
const SELLER_B_EMAIL = `${sellerB}@siton.test`;
const HA = { "x-seller-id": sellerA, "content-type": "application/json" };
const HB = { "x-seller-id": sellerB, "content-type": "application/json" };
const PICKUP_ADDRESS = "רח׳ הרצל 12, תל אביב — חנות הקפה";

type Option = { option_type: string; label: string; cost: number; sort_order: number; latitude?: number; longitude?: number };

async function createDeal(headers: Record<string, string>, title: string, options: Option[]) {
  const res = await app.inject({
    method: "POST", url: "/deals", headers: { ...headers, "idempotency-key": `p07-${randomUUID().slice(0, 12)}` },
    payload: {
      title, description_short: "בדיקת P0.7", description: "תיאור מלא", price_per_unit: 49, min_units: 5, max_units: 40,
      deadline: new Date(Date.now() + 2 * 864e5 + 7 * 3600e3).toISOString(), deal_type: "physical_product",
      delivery_options: options
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  return String(body.deal?.deal_id || body.deal_id);
}

async function publish(headers: Record<string, string>, dealId: string) {
  return app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { ...headers, "idempotency-key": `p07p-${randomUUID().slice(0, 12)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
}

async function inquire(dealId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/deals/${dealId}/inquiries`, headers: { "content-type": "application/json" }, payload });
}

async function notificationCount(threadId: string) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM siton.notification_events WHERE event_type='seller_customer_inquiry' AND idempotency_key LIKE $1`,
    [`%:${threadId}:%`]
  );
  return Number(r.rows[0].n);
}

let dealA = "";
let dealB = "";
let dealDeliveryOnly = "";
let legacyDeal = "";

await run("setup: sellers A/B publish-ready; A owns a pickup(address+coords)+delivery deal, B owns a pickup deal", async () => {
  for (const [headers, email] of [[HA, SELLER_A_EMAIL], [HB, SELLER_B_EMAIL]] as const) {
    const bp = await app.inject({
      method: "PUT", url: "/api/seller/business-profile", headers,
      payload: { business_name: "עסק בדיקה P0.7", business_id_number: "515000007", contact_name: "בודק", contact_phone: "0501234567", contact_email: email }
    });
    assert.equal(bp.statusCode, 200, bp.body);
  }
  dealA = await createDeal(HA, "עסקת איסוף עצמי — מוכר א", [
    { option_type: "pickup", label: PICKUP_ADDRESS, cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 },
    { option_type: "delivery", label: "משלוח שליח", cost: 25, sort_order: 1 }
  ]);
  dealB = await createDeal(HB, "עסקת מוכר ב", [{ option_type: "pickup", label: "איסוף מרח׳ ביאליק 3, רמת גן", cost: 0, sort_order: 0 }]);
  dealDeliveryOnly = await createDeal(HA, "משלוח בלבד", [{ option_type: "delivery", label: "משלוח עד הבית", cost: 30, sort_order: 0 }]);
  for (const [headers, id] of [[HA, dealA], [HB, dealB], [HA, dealDeliveryOnly]] as const) {
    const res = await publish(headers, id);
    assert.equal(res.statusCode, 200, res.body);
  }
});

await run("1+11: public payload has NO seller e-mail; pickup address is public via the shared projection", async () => {
  const res = await app.inject({ method: "GET", url: `/api/deals/${dealA}/public` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.ok(!("support_email" in body.seller), "seller.support_email must not exist");
  assert.ok(!("support_phone" in body.seller), "seller.support_phone must not exist (contact stays in the product)");
  assert.ok(!res.body.includes("0501234567"), "seller phone digits leaked into the public JSON");
  assert.equal(body.seller.contact_channel, "siton_inquiry");
  assert.ok(!res.body.includes(SELLER_A_EMAIL), "seller e-mail string leaked into the public JSON");
  assert.ok(!/support_email/.test(res.body), "support_email key leaked");
  const pickup = body.deal.delivery_options.find((o: any) => o.option_type === "pickup");
  assert.ok(pickup, "pickup option present");
  assert.equal(pickup.location_text, PICKUP_ADDRESS);
  assert.equal(pickup.has_location, true);
  assert.match(String(pickup.map_url), /32\.0668,34\.7647/);
  const delivery = body.deal.delivery_options.find((o: any) => o.option_type === "delivery");
  assert.equal(delivery.location_text, null);
  assert.equal(delivery.has_location, false);
});

await run("12: pickup disabled → the public payload carries no pickup option at all", async () => {
  const res = await app.inject({ method: "GET", url: `/api/deals/${dealDeliveryOnly}/public` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.deal.delivery_options.filter((o: any) => ["pickup", "distribution_point"].includes(o.option_type)).length, 0);
  assert.ok(body.deal.delivery_options.every((o: any) => o.location_text === null && o.has_location === false));
});

await run("13: publish readiness refuses pickup without a usable location; fixing the location unblocks publish", async () => {
  const draft = await createDeal(HA, "טיוטה עם איסוף עצמי בלי כתובת", [{ option_type: "pickup", label: "איסוף עצמי", cost: 0, sort_order: 0 }]);
  const blocked = await publish(HA, draft);
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal((blocked.json() as any).code, "pickup_location_required");
  const state = await pool.query(`SELECT state, published_at FROM siton.deals WHERE deal_id=$1`, [draft]);
  assert.equal(state.rows[0].state, "Draft");
  assert.equal(state.rows[0].published_at, null);
  const fixed = await app.inject({
    method: "PUT", url: `/api/seller/deals/${draft}/delivery`, headers: HA,
    payload: { delivery_options: [{ option_type: "pickup", label: "רח׳ אלנבי 5, תל אביב", cost: 0, sort_order: 0 }] }
  });
  assert.equal(fixed.statusCode, 200, fixed.body);
  const ok = await publish(HA, draft);
  assert.equal(ok.statusCode, 200, ok.body);
  // coordinates alone are also a usable location (no address text invented)
  const coordsOnly = await createDeal(HA, "איסוף לפי מיקום במפה", [{ option_type: "pickup", label: "איסוף עצמי", cost: 0, sort_order: 0, latitude: 31.7683, longitude: 35.2137 }]);
  const okCoords = await publish(HA, coordsOnly);
  assert.equal(okCoords.statusCode, 200, okCoords.body);
  const pub = await app.inject({ method: "GET", url: `/api/deals/${coordsOnly}/public` });
  const opt = (pub.json() as any).deal.delivery_options[0];
  assert.equal(opt.location_text, null, "no address text is invented from coordinates");
  assert.equal(opt.has_location, true);
  assert.match(String(opt.map_url), /31\.7683,35\.2137/);
});

await run("13b: a PUBLISHED deal cannot drop its pickup location through the delivery editor", async () => {
  const res = await app.inject({
    method: "PUT", url: `/api/seller/deals/${dealA}/delivery`, headers: HA,
    payload: { delivery_options: [{ option_type: "pickup", label: "איסוף עצמי", cost: 0, sort_order: 0 }] }
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as any).code, "pickup_location_required");
});

await run("14: legacy published deal without a pickup location stays readable (neutral fallback) and the Action Center flags it", async () => {
  legacyDeal = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, seller_id, published_at, deal_type)
     VALUES ($1,'עסקה ישנה ללא כתובת איסוף',10,5,50,5,$2,'PendingTarget',$3,now(),'physical_product')`,
    [legacyDeal, new Date(Date.now() + 3 * 864e5).toISOString(), sellerA]
  );
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order) VALUES ($1,'pickup','איסוף עצמי',0,0)`,
    [legacyDeal]
  );
  const res = await app.inject({ method: "GET", url: `/api/deals/${legacyDeal}/public` });
  assert.equal(res.statusCode, 200, res.body);
  const opt = (res.json() as any).deal.delivery_options[0];
  assert.equal(opt.option_type, "pickup");
  assert.equal(opt.location_text, null);
  assert.equal(opt.has_location, false);
  assert.equal(opt.map_url, null);
  const analytics = await app.inject({ method: "GET", url: "/api/seller/analytics", headers: HA });
  assert.equal(analytics.statusCode, 200, analytics.body);
  const item = ((analytics.json() as any).action_center as any[]).find((i) => i.type === "pickup_location_missing" && i.deal_id === legacyDeal);
  assert.ok(item, "action center must flag the legacy deal");
  assert.equal(item.action, "open_deal");
  // the healthy deal is NOT flagged
  assert.ok(!((analytics.json() as any).action_center as any[]).some((i) => i.type === "pickup_location_missing" && i.deal_id === dealA));
});

await run("15: buyer preview (seller payload) projects the SAME pickup location as the public payload", async () => {
  const pub = (await app.inject({ method: "GET", url: `/api/deals/${dealA}/public` })).json() as any;
  const sellerView = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}`, headers: HA });
  assert.equal(sellerView.statusCode, 200, sellerView.body);
  const mine = (sellerView.json() as any).delivery_options.find((o: any) => o.option_type === "pickup");
  const theirs = pub.deal.delivery_options.find((o: any) => o.option_type === "pickup");
  assert.deepEqual(
    { location_text: mine.location_text, has_location: mine.has_location, map_url: mine.map_url },
    { location_text: theirs.location_text, has_location: theirs.has_location, map_url: theirs.map_url }
  );
});

await run("5: guest inquiry validation + honeypot", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: "", email: "buyer@siton.test", message: "שאלה על העסקה" }, "inquiry_name_required"],
    [{ name: "קונה", email: "not-an-email", message: "שאלה על העסקה" }, "inquiry_email_invalid"],
    [{ name: "קונה", email: "buyer@siton.test", message: "א" }, "inquiry_message_too_short"],
    [{ name: "קונה", email: "buyer@siton.test", message: "x".repeat(2001) }, "inquiry_message_too_long"]
  ];
  for (const [payload, code] of cases) {
    const res = await inquire(dealA, payload);
    assert.equal(res.statusCode, 400, `${code}: ${res.body}`);
    assert.equal((res.json() as any).code, code);
  }
  const before = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_inquiry_threads WHERE deal_id=$1`, [dealA]);
  const honeypot = await inquire(dealA, { name: "בוט", email: "bot@siton.test", message: "spam spam spam", website: "http://spam" });
  assert.equal(honeypot.statusCode, 201);
  assert.equal((honeypot.json() as any).received, true);
  const after = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_inquiry_threads WHERE deal_id=$1`, [dealA]);
  assert.equal(after.rows[0].n, before.rows[0].n, "honeypot must not create a thread");
  const unpublished = await createDeal(HA, "טיוטה", [{ option_type: "delivery", label: "משלוח", cost: 0, sort_order: 0 }]);
  const draftRes = await inquire(unpublished, { name: "קונה", email: "buyer@siton.test", message: "שאלה" });
  assert.equal(draftRes.statusCode, 404);
  assert.equal((draftRes.json() as any).code, "inquiry_deal_unavailable");
});

let threadId = "";
let accessToken = "";
const BUYER_EMAIL = "buyer-p07@siton.test";

await run("3+6+7+9+10: inquiry resolves the seller from the DEAL, is stored internally (no HTML), and produces exactly ONE pointer notification with a deep link", async () => {
  const res = await inquire(dealA, {
    name: "רות הקונה", email: BUYER_EMAIL, seller_id: sellerB,
    message: "היי, <script>alert(1)</script> האם אפשר לאסוף גם בערב?\n\n\n\nתודה"
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as any;
  assert.equal(body.created, true);
  assert.equal(body.sent_via, "siton");
  assert.ok(body.thread_id && body.access_token, "thread id + access token");
  threadId = String(body.thread_id);
  accessToken = String(body.access_token);
  assert.equal(body.notification.result, "queued");
  assert.equal(body.notification.channel, "email");

  const thread = await pool.query(`SELECT seller_id, deal_id, status, seller_unread_count, message_count, customer_email FROM siton.seller_inquiry_threads WHERE thread_id=$1`, [threadId]);
  assert.equal(thread.rows[0].seller_id, sellerA, "browser-supplied seller_id must be ignored");
  assert.equal(thread.rows[0].deal_id, dealA);
  assert.equal(thread.rows[0].status, "Open");
  assert.equal(thread.rows[0].seller_unread_count, 1);
  assert.equal(thread.rows[0].message_count, 1);
  const msg = await pool.query(`SELECT sender_type, body FROM siton.seller_inquiry_messages WHERE thread_id=$1`, [threadId]);
  assert.equal(msg.rowCount, 1);
  assert.equal(msg.rows[0].sender_type, "Customer");
  assert.ok(!/[<>]/.test(msg.rows[0].body), "angle brackets must never be stored");
  assert.ok(msg.rows[0].body.includes("האם אפשר לאסוף גם בערב?"));
  assert.ok(!/\n{3,}/.test(msg.rows[0].body), "blank-line runs are bounded");

  assert.equal(await notificationCount(threadId), 1, "exactly one notification event");
  const ev = await pool.query(
    `SELECT event_type, channel, recipient_type, recipient_ref, template_key, payload_jsonb, status FROM siton.notification_events WHERE idempotency_key LIKE $1`,
    [`%:${threadId}:%`]
  );
  const e = ev.rows[0];
  assert.equal(e.event_type, "seller_customer_inquiry");
  assert.equal(e.channel, "email");
  assert.equal(e.recipient_type, "seller");
  assert.equal(e.recipient_ref, SELLER_A_EMAIL, "recipient resolved from the seller's OWN account");
  assert.equal(e.template_key, "seller_customer_inquiry_he");
  assert.equal(e.status, "pending");
  assert.match(String(e.payload_jsonb.inquiry_url), new RegExp(`/preview/#/seller/inquiries/${threadId}$`));
  assert.ok(!JSON.stringify(e.payload_jsonb).includes("לאסוף גם בערב"), "the e-mail payload must not carry the conversation");
  const rendered = renderNotification("seller_customer_inquiry", "email", e.payload_jsonb);
  assert.ok(rendered, "template renders for e-mail");
  assert.match(String(rendered!.subject), /פנייה חדשה מלקוח/);
  assert.ok(rendered!.body.includes(String(e.payload_jsonb.inquiry_url)), "body carries the deep link");
  assert.ok(rendered!.body.includes("C-ton"), "body points back into the product");
  assert.ok(!rendered!.body.includes(BUYER_EMAIL) && !rendered!.body.includes(SELLER_A_EMAIL));
});

await run("8: a retried submission and follow-ups never e-mail the seller again", async () => {
  const retry = await inquire(dealA, { name: "רות הקונה", email: BUYER_EMAIL, message: "היי, <script>alert(1)</script> האם אפשר לאסוף גם בערב?\n\n\n\nתודה" });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((retry.json() as any).duplicate, true);
  assert.equal((retry.json() as any).thread_id, threadId);
  assert.equal(await notificationCount(threadId), 1);
  const followUp = await app.inject({
    method: "POST", url: `/api/inquiries/${threadId}/messages`, headers: { "content-type": "application/json" },
    payload: { access_token: accessToken, message: "ועוד שאלה: יש חניה?" }
  });
  assert.equal(followUp.statusCode, 201, followUp.body);
  assert.equal((followUp.json() as any).created, false);
  assert.equal((followUp.json() as any).notification.result, "not_needed");
  assert.equal(await notificationCount(threadId), 1, "follow-up on an unread thread must not re-notify");
  const badToken = await app.inject({
    method: "POST", url: `/api/inquiries/${threadId}/messages`, headers: { "content-type": "application/json" },
    payload: { access_token: "forged", message: "ניסיון חטיפה" }
  });
  assert.equal(badToken.statusCode, 404);
  const rows = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_inquiry_messages WHERE thread_id=$1`, [threadId]);
  assert.equal(rows.rows[0].n, 2);
});

await run("4: seller A sees the inquiry in the command center; seller B cannot read or answer it", async () => {
  const listA = await app.inject({ method: "GET", url: "/api/seller/inquiries", headers: HA });
  assert.equal(listA.statusCode, 200, listA.body);
  const a = listA.json() as any;
  const row = a.threads.find((t: any) => t.thread_id === threadId);
  assert.ok(row, "thread listed for its seller");
  assert.equal(row.deal_id, dealA);
  assert.equal(row.customer_name, "רות הקונה");
  assert.ok(row.seller_unread_count >= 2);
  assert.ok(a.summary.unread_threads >= 1);
  assert.ok(!listA.body.includes(BUYER_EMAIL), "list never exposes the raw customer e-mail");

  const listB = await app.inject({ method: "GET", url: "/api/seller/inquiries?scope=all", headers: HB });
  assert.equal(listB.statusCode, 200);
  assert.ok(!(listB.json() as any).threads.some((t: any) => t.thread_id === threadId), "seller B must not see seller A's thread");
  const readB = await app.inject({ method: "GET", url: `/api/seller/inquiries/${threadId}`, headers: HB });
  assert.equal(readB.statusCode, 404);
  const replyB = await app.inject({ method: "POST", url: `/api/seller/inquiries/${threadId}/reply`, headers: HB, payload: { message: "ניסיון של מוכר זר" } });
  assert.equal(replyB.statusCode, 404);
  const still = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_inquiry_messages WHERE thread_id=$1 AND sender_type='Seller'`, [threadId]);
  assert.equal(still.rows[0].n, 0);

  const readA = await app.inject({ method: "GET", url: `/api/seller/inquiries/${threadId}`, headers: HA });
  assert.equal(readA.statusCode, 200, readA.body);
  const detail = readA.json() as any;
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.thread.customer_email_masked, "b***@siton.test");
  assert.ok(!readA.body.includes(BUYER_EMAIL));
  const unread = await pool.query(`SELECT seller_unread_count FROM siton.seller_inquiry_threads WHERE thread_id=$1`, [threadId]);
  assert.equal(unread.rows[0].seller_unread_count, 0, "opening the thread marks it read");
});

await run("6b: seller reply is stored in the product; the customer reads it with the thread token; a re-opened thread notifies once more (never twice)", async () => {
  const reply = await app.inject({ method: "POST", url: `/api/seller/inquiries/${threadId}/reply`, headers: HA, payload: { message: "כן, איסוף אפשרי עד 20:00. <b>יש חניה</b>" } });
  assert.equal(reply.statusCode, 201, reply.body);
  assert.equal((reply.json() as any).status, "Answered");
  assert.equal((reply.json() as any).stored_in, "siton");
  const customer = await app.inject({ method: "GET", url: `/api/inquiries/${threadId}?t=${encodeURIComponent(accessToken)}` });
  assert.equal(customer.statusCode, 200, customer.body);
  const view = customer.json() as any;
  assert.equal(view.thread.status, "Answered");
  const sellerMsg = view.messages.find((m: any) => m.sender_type === "Seller");
  assert.ok(sellerMsg, "seller reply visible to the customer");
  assert.ok(!/[<>]/.test(sellerMsg.body));
  assert.ok(!customer.body.includes(SELLER_A_EMAIL) && !/support_email|login_email/.test(customer.body), "customer view never exposes the seller e-mail");
  const wrong = await app.inject({ method: "GET", url: `/api/inquiries/${threadId}?t=nope` });
  assert.equal(wrong.statusCode, 404);

  const reopen = await app.inject({
    method: "POST", url: `/api/inquiries/${threadId}/messages`, headers: { "content-type": "application/json" },
    payload: { access_token: accessToken, message: "תודה! ומה לגבי שבת?" }
  });
  assert.equal(reopen.statusCode, 201, reopen.body);
  assert.equal((reopen.json() as any).notification.result, "queued");
  assert.equal(await notificationCount(threadId), 2, "a customer re-opening an answered thread notifies once");
  const reopenRetry = await app.inject({
    method: "POST", url: `/api/inquiries/${threadId}/messages`, headers: { "content-type": "application/json" },
    payload: { access_token: accessToken, message: "תודה! ומה לגבי שבת?" }
  });
  assert.equal(reopenRetry.statusCode, 200);
  assert.equal((reopenRetry.json() as any).duplicate, true);
  assert.equal(await notificationCount(threadId), 2);
  const status = await pool.query(`SELECT status, seller_unread_count FROM siton.seller_inquiry_threads WHERE thread_id=$1`, [threadId]);
  assert.equal(status.rows[0].status, "Open");
  assert.equal(status.rows[0].seller_unread_count, 1);
});

await run("abuse: per-customer hourly cap answers 429 without creating more messages", async () => {
  const email = `rate-p07-${randomUUID().slice(0, 6)}@siton.test`;
  let limited = 0;
  let accepted = 0;
  for (let i = 0; i < 7; i++) {
    const res = await inquire(dealB, { name: "מבחן קצב", email, message: `הודעה מספר ${i} עם תוכן שונה` });
    if (res.statusCode === 201) accepted++;
    else if (res.statusCode === 429) { limited++; assert.equal((res.json() as any).code, "inquiry_rate_limited"); }
    else assert.fail(`unexpected ${res.statusCode}: ${res.body}`);
  }
  assert.equal(accepted, 5, "five customer messages per hour are accepted");
  assert.equal(limited, 2, "the rest are throttled");
  const stored = await pool.query(
    `SELECT count(*)::int AS n FROM siton.seller_inquiry_messages m JOIN siton.seller_inquiry_threads t ON t.thread_id=m.thread_id WHERE t.customer_ref=$1`,
    [email]
  );
  assert.equal(stored.rows[0].n, 5);
});

await run("analytics: inquiries summary + Action Center item point the seller at unread inquiries", async () => {
  const res = await app.inject({ method: "GET", url: "/api/seller/analytics", headers: HA });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.ok(body.inquiries.unread_threads >= 1, JSON.stringify(body.inquiries));
  assert.ok(body.inquiries.open_threads >= 1);
  const item = (body.action_center as any[]).find((i) => i.type === "customer_inquiries_unread");
  assert.ok(item, "action center item present");
  assert.equal(item.action, "open_inquiries");
  const resB = await app.inject({ method: "GET", url: "/api/seller/analytics", headers: HB });
  const bodyB = resB.json() as any;
  assert.ok(bodyB.inquiries.unread_threads >= 5, "seller B counts only its own (rate-test) threads");
});

console.log(`\nP07_RESULT passed=${passed} failed=${failed}`);
await pool.end().catch(() => undefined);
await app.close().catch(() => undefined);
process.exit(failed ? 1 : 0);
