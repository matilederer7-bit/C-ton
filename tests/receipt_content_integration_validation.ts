import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { successStats, safePublicName, validateReceiptConfig } from "../src/receipt_trust.js";
import { validateContent } from "../src/site_content.js";
import { ensureSellerReady, createDeal, publishDeal, joinDeal, forceDealState, forceParticipantTo, sellerHeaders } from "./helpers/physical_fulfillment_fixture.js";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.PORT = "3597";
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { issueAdminSession } = await import("../src/admin_identity.js");
let passed = 0;
async function run(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); passed++; }
const seller = `receipt-${randomUUID()}`, other = `receipt-other-${randomUUID()}`;
const request = async (method: any, url: string, headers: any = {}, payload?: any) => {
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body, json: () => r.json() as any };
};
const auth = (buyer: any) => ({ authorization: `Bearer ${buyer.tracking_access_token}` });
const entitlement = (buyer: any) => request("GET", `/api/participants/${buyer.participant_id}/entitlement`, auth(buyer));
try {
  await app.ready();
  await ensureSellerReady(app, seller, "חנות לבדיקה"); await ensureSellerReady(app, other, "מוכר אחר");
  const deal = await createDeal(app, seller, { title: "עסקת מימוש", minUnits: 1, maxUnits: 40 });
  await run("five closed methods; HTTPS only and bounded instructions", async () => {
    for (const method of ["qr", "code", "name_phone", "digital_link", "instructions"]) {
      assert.equal(validateReceiptConfig({ method, instructions: "מימוש בחנות", url: "https://example.invalid/{code}" }).method, method);
    }
    for (const url of ["javascript:alert(1)", "http://example.invalid", "https://user:pass@example.invalid"]) assert.throws(() => validateReceiptConfig({ method: "digital_link", url }));
    assert.throws(() => validateReceiptConfig({ method: "instructions", instructions: "x".repeat(1001) }));
  });
  await run("seller config is owner scoped and drafts stay private", async () => {
    assert.equal((await request("PUT", `/api/seller/deals/${deal}/receipt`, sellerHeaders(other), { method: "qr" })).status, 404);
    assert.equal((await request("PUT", `/api/seller/deals/${deal}/receipt`, sellerHeaders(seller), { method: "qr", instructions: "הציגו למוכר" })).status, 200);
    assert.equal((await request("GET", `/api/deals/${deal}/receipt-info`)).status, 404);
  });
  await publishDeal(app, seller, deal);
  const buyers: Awaited<ReturnType<typeof joinDeal>>[] = [];
  for (let i = 0; i < 6; i++) buyers.push(await joinDeal(app, deal, { phone: `050880000${i}`, name: `ישראל פרטי${i}`, qty: 1, optionType: "pickup" }));
  const buyer = buyers[0]!;
  await run("no entitlement or artifact before eligibility; anonymous by default", async () => {
    const r = await entitlement(buyer); assert.equal(r.status, 200, r.body); assert.equal(r.json().entitlement, null); assert.equal(r.json().public_name_opt_in, false);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM siton.fulfillment_units WHERE participant_id=$1`, [buyer.participant_id])).rows[0].n, 0);
    assert.deepEqual((await request("GET", `/api/deals/${deal}/public-names`)).json().names, []);
    assert.equal((await request("PUT", `/api/seller/deals/${deal}/receipt`, sellerHeaders(seller), { method: "code" })).status, 409);
  });
  await forceDealState(pool, deal, "Completed");
  await forceParticipantTo(pool, buyer.participant_id, "ChargedSuccess");
  await forceParticipantTo(pool, buyers[1]!.participant_id, "RecoveredCharge");
  await forceParticipantTo(pool, buyers[2]!.participant_id, "AuthReleased");
  await forceParticipantTo(pool, buyers[3]!.participant_id, "Refunded");
  await forceParticipantTo(pool, buyers[4]!.participant_id, "ChargeFailedRecovery");
  let receipt: any;
  await run("eligible/recovered buyers get stable unique artifacts; failed/dropped/refunded buyers do not", async () => {
    const r = await entitlement(buyer); assert.equal(r.status, 200, r.body); receipt = r.json().entitlement;
    assert.equal(receipt.status, "valid"); assert.match(receipt.code, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/);
    assert.equal((await entitlement(buyer)).json().entitlement.code, receipt.code);
    assert.notEqual((await entitlement(buyers[1]!)).json().entitlement.code, receipt.code);
    for (const b of buyers.slice(2)) assert.equal((await entitlement(b)).json().entitlement, null);
  });
  await run("buyer tokens are bound to participant; unknown and anonymous are denied", async () => {
    assert.equal((await request("GET", `/api/participants/${buyer.participant_id}/entitlement`)).status, 401);
    assert.equal((await request("GET", `/api/participants/${buyer.participant_id}/entitlement`, auth(buyers[1]))).status, 403);
  });
  await run("seller resolves code and redeems once, concurrent attempts share the result, foreign seller refused", async () => {
    const lookup = await request("GET", `/api/seller/receipts?q=${receipt.code}`, sellerHeaders(seller)); assert.equal(lookup.status, 200, lookup.body); assert.equal(lookup.json().orders.length, 1);
    assert.equal((await request("POST", `/api/seller/receipts/${buyer.participant_id}/redeem`, sellerHeaders(other), {})).status, 404);
    const rs = await Promise.all([0, 1, 2].map(() => request("POST", `/api/seller/receipts/${buyer.participant_id}/redeem`, sellerHeaders(seller), {})));
    for (const r of rs) assert.equal(r.status, 200, r.body);
    assert.equal(rs.filter(r => !r.json().idempotent).length, 1);
    assert.equal((await entitlement(buyer)).json().entitlement.status, "redeemed");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM siton.seller_security_events WHERE seller_id=$1 AND event_type='fulfillment.redeem'`, [seller])).rows[0].n, 1);
    assert.equal((await request("POST", `/api/seller/receipts/${buyers[3]!.participant_id}/redeem`, sellerHeaders(seller), {})).status, 409);
  });
  await run("old unit redemption refuses refunded buyers too", async () => {
    const ref = buyers[3]!;
    const id = randomUUID();
    await pool.query(`INSERT INTO siton.fulfillment_units(fulfillment_unit_id,deal_id,participant_id,deal_type,fulfillment_kind,unit_index,status) VALUES($1,$2,$3,'physical_product','physical_delivery',1,'Issued')`, [id, deal, ref.participant_id]);
    assert.equal((await request("POST", `/api/seller/fulfillment/${id}/redeem`, sellerHeaders(seller), {})).status, 409);
  });
  await run("public names require explicit opt-in, disclose first names only and support withdrawal", async () => {
    assert.equal((await request("PUT", `/api/participants/${buyer.participant_id}/public-name`, auth(buyer), { opt_in: true })).status, 200);
    const r = await request("GET", `/api/deals/${deal}/public-names`); assert.deepEqual(r.json().names, ["ישראל"]); assert.ok(!r.body.includes("050880000")); assert.ok(!r.body.includes(buyer.participant_id));
    assert.equal(safePublicName("me@example.com"), "משתתף");
    await request("PUT", `/api/participants/${buyer.participant_id}/public-name`, auth(buyer), { opt_in: false });
    assert.deepEqual((await request("GET", `/api/deals/${deal}/public-names`)).json().names, []);
  });
  await run("public seller profile uses deterministic stats, excludes drafts and private buyer data", async () => {
    await createDeal(app, seller, { title: "טיוטה פרטית" });
    const updated = await request("PUT", "/api/seller/public-profile", sellerHeaders(seller), { name: "חנות ישראל", about: "אודות העסק" }); assert.equal(updated.status, 200, updated.body);
    const id = updated.json().profile.id;
    const r = await request("GET", `/api/public-sellers/${id}`); assert.equal(r.status, 200, r.body);
    assert.equal(r.json().seller.stats.published, 1); assert.equal(r.json().seller.stats.success_rate, 100); assert.equal(r.json().seller.deals.length, 1);
    for (const privateValue of [seller, "050880000", "טיוטה פרטית", buyer.participant_id]) assert.ok(!r.body.includes(privateValue));
    assert.deepEqual(successStats([{ state: "Draft", published_at: null }, { state: "Completed", published_at: "x" }, { state: "Failed", published_at: "x" }, { state: "Cancelled", published_at: "x" }]), { published: 3, finalized: 3, completed: 1, success_rate: 33 });
  });
  await run("digital link is hidden publicly and available only to the eligible buyer", async () => {
    const id = await createDeal(app, seller, { title: "תוכן דיגיטלי", minUnits: 1 });
    await request("PUT", `/api/seller/deals/${id}/receipt`, sellerHeaders(seller), { method: "digital_link", url: "https://example.invalid/private-only/{code}" });
    await publishDeal(app, seller, id);
    const b = await joinDeal(app, id, { phone: "0508800007", name: "דיגיטל ישראל", qty: 1, optionType: "pickup" });
    assert.ok(!(await request("GET", `/api/deals/${id}/receipt-info`)).body.includes("private-only"));
    assert.ok(!(await request("GET", `/api/deals/${id}/public`)).body.includes("private-only"));
    await forceDealState(pool, id, "Completed"); await forceParticipantTo(pool, b.participant_id, "ChargedSuccess");
    assert.match((await entitlement(b)).json().entitlement.url, /^https:\/\/example.invalid\/private-only\/[A-F0-9-]+$/);
    assert.equal((await request("GET", `/api/participants/${b.participant_id}/entitlement`, auth(buyer))).status, 403);
  });
  await run("code, name/phone and instructions methods persist and remain usable after a reload", async () => {
    for (const [index, method] of ["code", "name_phone", "instructions"].entries()) {
      const id = await createDeal(app, seller, { title: `מימוש ${method}`, minUnits: 1 });
      const cfg = { method, instructions: "הציגו את הרכישה בחנות" };
      assert.equal((await request("PUT", `/api/seller/deals/${id}/receipt`, sellerHeaders(seller), cfg)).status, 200);
      await publishDeal(app, seller, id);
      const b = await joinDeal(app, id, { phone: `050881000${index}`, name: `מימוש שיטה${index}`, qty: 2, optionType: "pickup" });
      await forceDealState(pool, id, "Completed"); await forceParticipantTo(pool, b.participant_id, "ChargedSuccess");
      const e = (await entitlement(b)).json().entitlement;
      assert.equal(e.method, method); assert.equal(e.quantity, 2); assert.equal(e.remaining_quantity, 2); assert.equal(e.instructions, cfg.instructions);
      assert.equal(!!e.code, method === "code"); assert.equal(e.url, null);
      const results = await request("GET", `/api/seller/receipts?q=${encodeURIComponent(`050881000${index}`)}`, sellerHeaders(seller));
      assert.equal(results.json().orders[0].participant_id, b.participant_id);
    }
  });
  await run("CMS rejects unauthenticated writes; named admin edits persist, revision protects against lost changes and HTML is rejected", async () => {
    assert.ok([401, 403].includes((await request("PUT", "/api/admin/site-content/home", {}, {})).status));
    const admin = (await pool.query(`INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled) VALUES($1,'Content Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id`, [`receipt-${randomUUID()}@example.invalid`])).rows[0];
    const session = await issueAdminSession(pool as any, admin.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true);
    const headers = { cookie: `siton_admin_session=${session.token}` };
    const read = await request("GET", "/api/admin/site-content", headers); assert.equal(read.status, 200, read.body);
    const home = read.json().sections.home;
    const value = { ...home.value, title: "כותרת חדשה לבדיקה" };
    const saved = await request("PUT", "/api/admin/site-content/home", headers, { value, revision: 0 }); assert.equal(saved.status, 200, saved.body);
    assert.equal((await request("GET", "/api/site-content")).json().content.home.title, value.title);
    assert.equal((await request("PUT", "/api/admin/site-content/home", headers, { value, revision: 0 })).status, 409);
    assert.equal((await request("PUT", "/api/admin/site-content/home", headers, { value: { ...value, title: "<script>alert(1)</script>" }, revision: 1 })).status, 400);
    assert.throws(() => validateContent("home", { ...value, title: "x".repeat(121) }));
    assert.throws(() => validateContent("__proto__", {}));
    const legal = read.json().sections.legal_terms;
    const body = "תנאים מעודכנים לבדיקה";
    assert.equal((await request("PUT", "/api/admin/site-content/legal_terms", headers, { value: { ...legal.value, body }, revision: 0 })).status, 200);
    assert.ok((await request("GET", "/legal/terms")).body.includes(body));
    const revision = (await pool.query(`SELECT previous_value_jsonb,updated_by FROM siton.site_content WHERE content_key='legal_terms'`)).rows[0];
    assert.equal(revision.previous_value_jsonb.body, legal.value.body); assert.equal(revision.updated_by, admin.admin_user_id);
    const asset = await request("POST", "/api/admin/content-assets", headers, { filename: "pixel.png", mime_type: "image/png", base64_data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhS8AAAAASUVORK5CYII=" });
    assert.equal(asset.status, 200, asset.body);
    const stored = (await pool.query(`SELECT storage_key FROM siton.content_assets WHERE asset_id=$1`, [asset.json().asset_id])).rows[0]; assert.ok(stored.storage_key);
    assert.equal((await request("GET", asset.json().url)).status, 200);
  });
  await run("chat title length enforced and title/body persist separately", async () => {
    const id = await createDeal(app, seller, { title: "שיחה" }); await publishDeal(app, seller, id);
    assert.equal((await request("POST", `/api/deals/${id}/chat`, {}, { title: "x".repeat(81), body: "תוכן" })).status, 400);
    const r = await request("POST", `/api/deals/${id}/chat`, {}, { title: "שאלה", body: "תוכן השאלה", display_name: "ישראל" }); assert.equal(r.status, 201, r.body);
    assert.equal(r.json().message.title, "שאלה");
    assert.equal((await request("GET", `/api/deals/${id}/chat`)).json().messages[0].title, "שאלה");
  });
  console.log(`RECEIPT_CONTENT_PASS ${passed}`);
} finally {
  for (let i=0; i<100 && !app.server.listening; i++) await new Promise(r => setTimeout(r, 20));
  await app.close(); await pool.end().catch(() => undefined);
}
