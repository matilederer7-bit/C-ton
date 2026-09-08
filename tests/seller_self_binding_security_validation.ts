// LAUNCH POLISH (P1) — SELF-SERVICE SELLER BINDING: security + behaviour proof.
//
// A verified Supabase identity without a seller capability is bound to a
// PENDING seller account on its first capability discovery. This suite drives
// the REAL verification path (ES256 tokens signed here, JWKS served over HTTP
// by this file — no test seam inside the verifier) against the hosted-like
// runtime shape (APP_DEPLOYMENT_MODE=staging → bearer identities only;
// APP_ENV=production → the publish approval gate is active exactly as on
// Render). Every negative control asserts the DATABASE afterwards: no row, no
// rebinding, no credential, no privilege.
//
// Proves:
//   anonymous / invalid / expired / rogue-key / anon-role / anonymous-sign-in
//   tokens cannot bootstrap a seller · first login binds ONE pending row ·
//   second login is idempotent · two concurrent first logins produce one row ·
//   an already-bound account is left alone · e-mail collision never claims the
//   existing account · seller-id collision never overwrites a foreign
//   auth_user_id · the seller stays pending · a pending seller can draft but
//   cannot publish · a seller cannot approve itself or another seller · a
//   seller token holds no admin authority · admin approval opens publishing ·
//   seller A cannot cancel seller B's deal · the hourly cap throttles · the
//   binding is audited and creates no credential.

import { strict as assert } from "node:assert";
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";

const { Pool } = pg;

// ── a real ES256 key set the runtime fetches over HTTP ─────────────────────
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rogue = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = `polish-${randomUUID().slice(0, 8)}`;
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "ES256", use: "sig" };
let jwksHits = 0;
const jwksServer = createServer((req, res) => {
  if (String(req.url || "").startsWith("/auth/v1/.well-known/jwks.json")) {
    jwksHits += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", () => resolve()));
const SUPABASE_URL = `http://127.0.0.1:${(jwksServer.address() as any).port}`;

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_JWT_AUD = "authenticated";
process.env.APP_DEPLOYMENT_MODE = "staging";
process.env.APP_ENV = "production";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.ADMIN_API_KEY = `polish-admin-${randomUUID()}`;
process.env.SITON_OWNER_EMAIL = "owner-polish@example.com";
process.env.SELLER_SELF_SIGNUP_HOURLY_CAP = "4";

const { app } = await import("../src/app.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 6
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message || e}`); failed++; }
}

// ── token minting (what GoTrue would issue) ────────────────────────────────
const b64u = (value: Buffer | string) => Buffer.from(value).toString("base64url");
function mint(claims: Record<string, unknown>, opts: { key?: any; kid?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: opts.kid ?? KID };
  const payload = {
    iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated", role: "authenticated",
    iat: now, exp: now + 3600, session_id: randomUUID(), ...claims
  };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = createSign("SHA256").update(input).sign({ key: opts.key ?? privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(signature)}`;
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const caps = (token: string) => app.inject({ method: "GET", url: "/api/auth/capabilities", headers: bearer(token) });
const expectedSellerId = (email: string, sub: string) => {
  const local = String(email.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "seller";
  return `s-${local}-${createHash("sha256").update(sub).digest("hex").slice(0, 8)}`;
};
// self-signup bindings are counted from the append-only audit rail: the
// approval decision rewrites seller_accounts.admin_note, so that column is
// not a stable marker (the runtime's hourly cap counts the same rail)
const selfSignupRows = async () =>
  Number((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.seller_security_events WHERE event_type='seller.self_signup.bound'`)).rows[0].n);
const rowsForSub = async (sub: string) =>
  (await pool.query(`SELECT * FROM siton.seller_accounts WHERE auth_user_id=$1`, [sub])).rows;

const tag = randomUUID().slice(0, 6);
const A = { sub: randomUUID(), email: `Pilot.Seller.A+${tag}@Example.com` };
const B = { sub: randomUUID(), email: `pilot-seller-b-${tag}@example.com` }; // manually bound (approved) — the "other seller"
const C = { sub: randomUUID(), email: `pilot-seller-c-${tag}@example.com` }; // concurrent first login
const ADMIN = { sub: randomUUID(), email: `pilot-admin-${tag}@example.com` };
const tokenA = mint({ sub: A.sub, email: A.email });
const tokenB = mint({ sub: B.sub, email: B.email });
const tokenC = mint({ sub: C.sub, email: C.email });
const tokenAdmin = mint({ sub: ADMIN.sub, email: ADMIN.email });
const sellerIdA = expectedSellerId(A.email.toLowerCase(), A.sub);
const deadline = () => new Date(Date.now() + 3 * 864e5).toISOString();
const draftPayload = () => ({
  title: `מארז דבש פיילוט ${tag}`, description_short: "דבש פרחי בר", price_per_unit: 45, min_units: 5, max_units: 20,
  deadline: deadline(), deal_type: "physical_product",
  delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }]
});
const createDraft = (token: string) => app.inject({
  method: "POST", url: "/deals", headers: { ...bearer(token), "idempotency-key": `polish-${randomUUID().slice(0, 12)}` }, payload: draftPayload()
});

// seed: B (manual, approved) and the admin identity — the fixtures the pilot already has
await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, login_email, support_email, verification_status, settlement_status, auth_enabled, auth_user_id, admin_note)
   VALUES ($1, 'Seller B', 'עסק ב', $2, $2, 'approved', 'active', true, $3, 'pilot_manual_onboarding_test')`,
  [`pilot-b-${tag}`, B.email, B.sub]
);
await pool.query(
  `INSERT INTO siton.admin_users (email, display_name, role, status, auth_user_id, provisioned_via, provisioned_at)
   VALUES ($1, 'Pilot Owner', 'SuperAdmin', 'Active', $2, 'test_seed', now())`,
  [ADMIN.email, ADMIN.sub]
);

const baselineRows = await selfSignupRows();

await run("anonymous caller cannot create a seller binding (no bearer → 401, no row)", async () => {
  const res = await caps("");
  assert.equal(res.statusCode, 401, res.body);
  const spoof = await app.inject({ method: "GET", url: "/api/auth/capabilities", headers: { "x-seller-id": "seller-alpha", "x-admin-key": String(process.env.ADMIN_API_KEY) } });
  assert.equal(spoof.statusCode, 401, spoof.body);
  const ctx = await app.inject({ method: "GET", url: "/api/seller/context", headers: { "x-seller-id": "seller-alpha" } });
  assert.ok([401, 503].includes(ctx.statusCode), `x-seller-id spoof answered ${ctx.statusCode}`);
  assert.equal((ctx.json() as any).ok, false);
  const draft = await app.inject({ method: "POST", url: "/deals", headers: { "x-seller-id": "seller-alpha", "idempotency-key": `spoof-${tag}` }, payload: draftPayload() });
  assert.ok([401, 503].includes(draft.statusCode), `x-seller-id draft answered ${draft.statusCode}`);
  assert.equal(await selfSignupRows(), baselineRows);
});

await run("invalid tokens cannot bootstrap a seller: rogue key, expired, anon role, wrong issuer, bad subject, unknown kid", async () => {
  const bad: [string, string][] = [
    ["rogue key", mint({ sub: randomUUID(), email: `rogue-${tag}@example.com` }, { key: rogue.privateKey })],
    ["expired", mint({ sub: randomUUID(), email: `expired-${tag}@example.com`, exp: Math.floor(Date.now() / 1000) - 120 })],
    ["anon role", mint({ sub: randomUUID(), email: `anon-${tag}@example.com`, role: "anon" })],
    ["service role", mint({ sub: randomUUID(), email: `svc-${tag}@example.com`, role: "service_role" })],
    ["wrong issuer", mint({ sub: randomUUID(), email: `iss-${tag}@example.com`, iss: "https://evil.example/auth/v1" })],
    ["bad subject", mint({ sub: "not-a-uuid", email: `sub-${tag}@example.com` })],
    ["unknown kid", mint({ sub: randomUUID(), email: `kid-${tag}@example.com` }, { kid: "nope" })],
    ["not a jwt", "abc.def"]
  ];
  for (const [label, token] of bad) {
    const res = await caps(token);
    assert.equal(res.statusCode, 401, `${label}: ${res.statusCode} ${res.body}`);
  }
  assert.equal(await selfSignupRows(), baselineRows);
});

await run("a Supabase ANONYMOUS sign-in (role=authenticated, is_anonymous=true) is refused a seller binding", async () => {
  const sub = randomUUID();
  const res = await caps(mint({ sub, is_anonymous: true }));
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.seller, null);
  assert.equal(body.seller_binding, "anonymous_identity");
  const withEmail = await caps(mint({ sub, is_anonymous: true, email: `anon-mail-${tag}@example.com` }));
  assert.equal((withEmail.json() as any).seller_binding, "anonymous_identity");
  assert.equal((await rowsForSub(sub)).length, 0);
  const noEmail = await caps(mint({ sub: randomUUID() }));
  assert.equal(noEmail.statusCode, 200, noEmail.body);
  assert.equal((noEmail.json() as any).seller_binding, "email_required");
  assert.equal(await selfSignupRows(), baselineRows);
});

await run("first login: ONE pending seller row bound to the verified sub, audited, without any credential", async () => {
  const res = await caps(tokenA);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.seller_binding, "bound");
  assert.equal(body.seller?.seller_id, sellerIdA, JSON.stringify(body));
  assert.equal(body.seller?.verification_status, "pending");
  assert.equal(body.admin, null, "a seller binding never carries admin authority");
  const rows = await rowsForSub(A.sub);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.seller_id, sellerIdA);
  assert.equal(row.verification_status, "pending");
  assert.equal(row.settlement_status, "active");
  assert.equal(row.auth_enabled, true);
  assert.equal(row.login_email, A.email.toLowerCase());
  assert.equal(row.admin_note, "self_signup");
  assert.equal(row.auth_secret_hash, null, "self-signup must never create a login secret");
  const events = await pool.query(`SELECT * FROM siton.seller_security_events WHERE seller_id=$1 AND event_type='seller.self_signup.bound'`, [sellerIdA]);
  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].to_status, "pending");
  assert.equal(events.rows[0].actor_ref, `supabase:${A.sub}`);
  assert.equal(await selfSignupRows(), baselineRows + 1);
  assert.ok(jwksHits >= 1, "the token was verified against the served JWKS");
});

await run("second login: idempotent — same seller, no second row, no second audit event", async () => {
  const res = await caps(tokenA);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.seller_binding, "existing");
  assert.equal(body.seller?.seller_id, sellerIdA);
  const fresh = await caps(mint({ sub: A.sub, email: A.email })); // a new session for the same identity
  assert.equal((fresh.json() as any).seller?.seller_id, sellerIdA);
  assert.equal((await rowsForSub(A.sub)).length, 1);
  const events = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.seller_security_events WHERE seller_id=$1`, [sellerIdA]);
  assert.equal(Number(events.rows[0].n), 1);
  assert.equal(await selfSignupRows(), baselineRows + 1);
});

await run("two concurrent first logins for the same identity produce exactly one row and the same seller", async () => {
  const before = await selfSignupRows();
  const [r1, r2] = await Promise.all([caps(tokenC), caps(tokenC)]);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r2.statusCode, 200, r2.body);
  const b1 = r1.json() as any;
  const b2 = r2.json() as any;
  const expected = expectedSellerId(C.email, C.sub);
  assert.equal(b1.seller?.seller_id, expected, JSON.stringify(b1));
  assert.equal(b2.seller?.seller_id, expected, JSON.stringify(b2));
  const outcomes = [b1.seller_binding, b2.seller_binding].sort();
  assert.ok(outcomes.filter((o) => o === "bound").length === 1, `exactly one winner: ${outcomes}`);
  assert.ok(outcomes.every((o) => ["bound", "already_bound", "existing"].includes(o)), `outcomes ${outcomes}`);
  assert.equal((await rowsForSub(C.sub)).length, 1);
  const events = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.seller_security_events WHERE seller_id=$1`, [expected]);
  assert.equal(Number(events.rows[0].n), 1);
  assert.equal(await selfSignupRows(), before + 1);
});

await run("already-bound account (manual pilot bind) is resolved, never duplicated, never touched", async () => {
  const beforeRow = (await rowsForSub(B.sub))[0];
  const res = await caps(tokenB);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.seller_binding, "existing");
  assert.equal(body.seller?.seller_id, `pilot-b-${tag}`);
  assert.equal(body.seller?.verification_status, "approved");
  const rows = await rowsForSub(B.sub);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].updated_at), String(beforeRow.updated_at), "row untouched");
  assert.equal(await selfSignupRows(), baselineRows + 2);
});

await run("e-mail collision: an unbound existing account with the same e-mail is NEVER claimed, no new row", async () => {
  const legacyId = `legacy-${tag}`;
  const legacyEmail = `legacy-${tag}@example.com`;
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, login_email, verification_status, admin_note)
     VALUES ($1, 'Legacy Seller', $2, 'approved', 'legacy_code_login')`,
    [legacyId, legacyEmail]
  );
  const impostorSub = randomUUID();
  const res = await caps(mint({ sub: impostorSub, email: legacyEmail.toUpperCase() }));
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.seller, null, "no capability may be granted through an e-mail match");
  assert.equal(body.seller_binding, "email_in_use");
  const legacy = await pool.query(`SELECT auth_user_id, verification_status FROM siton.seller_accounts WHERE seller_id=$1`, [legacyId]);
  assert.equal(legacy.rows[0].auth_user_id, null, "legacy row not rebound");
  assert.equal((await rowsForSub(impostorSub)).length, 0);
  // and a second identity presenting seller A's e-mail cannot steal A's account
  const thief = await caps(mint({ sub: randomUUID(), email: A.email }));
  assert.equal((thief.json() as any).seller_binding, "email_in_use");
  assert.equal(String((await rowsForSub(A.sub))[0].auth_user_id), A.sub);
  assert.equal(await selfSignupRows(), baselineRows + 2);
});

await run("seller-id collision: a row already holding the deterministic id keeps its foreign auth_user_id", async () => {
  const sub = randomUUID();
  const email = `collide-${tag}@example.com`;
  const foreignSub = randomUUID();
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, login_email, verification_status, auth_enabled, auth_user_id, admin_note)
     VALUES ($1, 'Occupant', $2, 'approved', true, $3, 'occupant')`,
    [expectedSellerId(email, sub), `occupant-${tag}@example.com`, foreignSub]
  );
  const res = await caps(mint({ sub, email }));
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.seller, null);
  assert.equal(body.seller_binding, "seller_id_in_use");
  const occupant = await pool.query(`SELECT auth_user_id FROM siton.seller_accounts WHERE seller_id=$1`, [expectedSellerId(email, sub)]);
  assert.equal(String(occupant.rows[0].auth_user_id), foreignSub, "existing auth_user_id never overwritten");
  assert.equal((await rowsForSub(sub)).length, 0);
});

await run("the seller stays PENDING and every seller surface says so (no hard-coded 'approved')", async () => {
  const ctx = await app.inject({ method: "GET", url: "/api/seller/context", headers: bearer(tokenA) });
  assert.equal(ctx.statusCode, 200, ctx.body);
  const sc = (ctx.json() as any).seller_context;
  assert.equal(sc.seller_id, sellerIdA);
  assert.equal(sc.verification_status, "pending");
  assert.equal(sc.context_source, "supabase_session");
  assert.equal(sc.workspace_url, "/preview/#/seller");
  const deals = await app.inject({ method: "GET", url: "/api/seller/deals", headers: bearer(tokenA) });
  assert.equal(deals.statusCode, 200, deals.body);
  const surface = (deals.json() as any).seller_surface;
  assert.equal(surface.seller_profile.verification_status, "pending");
  assert.equal(surface.seller_auth.seller_context.verification_status, "pending");
  assert.equal(surface.seller_auth.onboarding.next_path, "/preview/#/seller/profile");
  const row = (await rowsForSub(A.sub))[0];
  assert.equal(row.verification_status, "pending");
});

let draftA = "";
await run("pending seller CAN create and edit a draft", async () => {
  const res = await createDraft(tokenA);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  draftA = String(body.deal?.deal_id || body.deal_id);
  assert.ok(draftA);
  const edit = await app.inject({ method: "PATCH", url: `/api/seller/deals/${draftA}/draft`, headers: bearer(tokenA), payload: { list_price_per_unit: 65 } });
  assert.equal(edit.statusCode, 200, edit.body);
  const view = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}`, headers: bearer(tokenA) });
  assert.equal(view.statusCode, 200, view.body);
  assert.equal((view.json() as any).deal.state, "Draft");
  assert.equal((view.json() as any).seller_actions.can_cancel, true);
});

const publish = (token: string, dealId: string) => app.inject({
  method: "POST", url: `/deals/${dealId}/publish`, headers: { ...bearer(token), "idempotency-key": `polish-pub-${randomUUID().slice(0, 8)}` },
  payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
});

await run("pending seller CANNOT publish (seller_kyc_not_approved) — the draft is kept", async () => {
  const bp = await app.inject({
    method: "PUT", url: "/api/seller/business-profile", headers: bearer(tokenA),
    payload: { business_name: `עסק א ${tag}`, business_id_number: "515000002", contact_name: "בודק", contact_phone: "0501234567" }
  });
  assert.equal(bp.statusCode, 200, bp.body);
  const res = await publish(tokenA, draftA);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as any).code, "seller_kyc_not_approved");
  const state = await pool.query(`SELECT state, published_at FROM siton.deals WHERE deal_id=$1`, [draftA]);
  assert.equal(state.rows[0].state, "Draft");
  assert.equal(state.rows[0].published_at, null);
});

const decide = (token: string, sellerId: string, decision = "approve") => app.inject({
  method: "POST", url: `/api/admin/kyc/seller/${encodeURIComponent(sellerId)}/decision`, headers: bearer(token), payload: { decision, admin_note: "test" }
});

await run("seller cannot self-approve, cannot approve another seller, holds no admin authority", async () => {
  const self = await decide(tokenA, sellerIdA);
  assert.ok([401, 403].includes(self.statusCode), `self-approve answered ${self.statusCode}: ${self.body}`);
  const other = await decide(tokenA, expectedSellerId(C.email, C.sub));
  assert.ok([401, 403].includes(other.statusCode), `approve-other answered ${other.statusCode}`);
  const key = await app.inject({ method: "POST", url: `/api/admin/kyc/seller/${sellerIdA}/decision`, headers: { "x-admin-key": String(process.env.ADMIN_API_KEY) }, payload: { decision: "approve" } });
  assert.ok([401, 403].includes(key.statusCode), `bootstrap key must not approve: ${key.statusCode}`);
  const read = await app.inject({ method: "GET", url: "/api/admin/r6/sellers", headers: bearer(tokenA) });
  assert.ok([401, 403].includes(read.statusCode), `seller token read admin list: ${read.statusCode}`);
  const metrics = await app.inject({ method: "GET", url: "/api/admin/pilot-metrics", headers: bearer(tokenA) });
  assert.ok([401, 403].includes(metrics.statusCode), `seller token read metrics: ${metrics.statusCode}`);
  for (const id of [sellerIdA, expectedSellerId(C.email, C.sub)]) {
    const row = await pool.query(`SELECT verification_status FROM siton.seller_accounts WHERE seller_id=$1`, [id]);
    assert.equal(row.rows[0].verification_status, "pending", `${id} must still be pending`);
  }
});

await run("owner sees the pending seller in the admin list; approval then allows publish", async () => {
  const before = await app.inject({ method: "GET", url: "/api/admin/r6/sellers", headers: bearer(tokenAdmin) });
  assert.equal(before.statusCode, 200, before.body);
  const pendingRow = ((before.json() as any).sellers || []).find((s: any) => s.seller_id === sellerIdA);
  assert.ok(pendingRow, "pending seller missing from the admin list");
  assert.equal(pendingRow.verification_status, "pending");
  assert.equal(pendingRow.supabase_bound, true);
  const detail = await app.inject({ method: "GET", url: `/api/admin/r6/sellers/${sellerIdA}`, headers: bearer(tokenAdmin) });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal((detail.json() as any).seller.self_signup, true, "provenance comes from the audit rail");
  assert.equal((detail.json() as any).seller.contact_name, "בודק", "identity block reads the business profile the seller typed");
  assert.equal((detail.json() as any).seller.support_phone, "0501234567");
  const ok = await decide(tokenAdmin, sellerIdA, "approve");
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((ok.json() as any).result.status, "approved");
  const after = await app.inject({ method: "GET", url: "/api/admin/r6/sellers", headers: bearer(tokenAdmin) });
  assert.equal(((after.json() as any).sellers || []).find((s: any) => s.seller_id === sellerIdA).verification_status, "approved");
  const capsAfter = await caps(tokenA);
  assert.equal((capsAfter.json() as any).seller.verification_status, "approved");
  const pub = await publish(tokenA, draftA);
  assert.equal(pub.statusCode, 200, pub.body);
  const state = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [draftA]);
  assert.equal(state.rows[0].state, "PendingTarget");
  const view = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}`, headers: bearer(tokenA) });
  assert.equal((view.json() as any).seller_actions.can_cancel, false, "a live deal is not cancellable by the state machine");
});

await run("rejection closes publishing again (draft kept), and a rejected seller is told so on the seller surface", async () => {
  const otherId = expectedSellerId(C.email, C.sub);
  const rej = await decide(tokenAdmin, otherId, "reject");
  assert.equal(rej.statusCode, 200, rej.body);
  const draft = await createDraft(tokenC);
  assert.equal(draft.statusCode, 200, draft.body);
  const bp = await app.inject({ method: "PUT", url: "/api/seller/business-profile", headers: bearer(tokenC),
    payload: { business_name: `עסק ג ${tag}`, business_id_number: "515000003", contact_name: "ג", contact_phone: "0501234568" } });
  assert.equal(bp.statusCode, 200, bp.body);
  const dealC = String((draft.json() as any).deal?.deal_id || (draft.json() as any).deal_id);
  const pub = await publish(tokenC, dealC);
  assert.equal(pub.statusCode, 409, pub.body);
  assert.equal((pub.json() as any).code, "seller_kyc_not_approved");
  const ctx = await app.inject({ method: "GET", url: "/api/seller/context", headers: bearer(tokenC) });
  assert.equal((ctx.json() as any).seller_context.verification_status, "rejected");
});

await run("seller A cannot cancel seller B's deal (ownership isolation); B's draft untouched", async () => {
  const draftB = await createDraft(tokenB);
  assert.equal(draftB.statusCode, 200, draftB.body);
  const dealB = String((draftB.json() as any).deal?.deal_id || (draftB.json() as any).deal_id);
  const cancel = await app.inject({ method: "POST", url: `/api/deals/${dealB}/cancel`, headers: { ...bearer(tokenA), "idempotency-key": `polish-cancel-${tag}` }, payload: {} });
  assert.equal(cancel.statusCode, 404, cancel.body);
  const state = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealB]);
  assert.equal(state.rows[0].state, "Draft");
  const audit = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.audit_log WHERE deal_id=$1 AND action_name='deal.cancel'`, [dealB]);
  assert.equal(Number(audit.rows[0].n), 0);
  const own = await app.inject({ method: "POST", url: `/api/deals/${dealB}/cancel`, headers: { ...bearer(tokenB), "idempotency-key": `polish-cancel-own-${tag}` }, payload: {} });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal((await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealB])).rows[0].state, "Cancelled");
});

await run("abuse control: the platform-wide hourly self-signup cap throttles the next identity without a row", async () => {
  // cap=4; A and C already used two slots
  const d = await caps(mint({ sub: randomUUID(), email: `pilot-d-${tag}@example.com` }));
  assert.equal((d.json() as any).seller_binding, "bound", d.body);
  const e = await caps(mint({ sub: randomUUID(), email: `pilot-e-${tag}@example.com` }));
  assert.equal((e.json() as any).seller_binding, "bound", e.body);
  const fSub = randomUUID();
  const f = await caps(mint({ sub: fSub, email: `pilot-f-${tag}@example.com` }));
  assert.equal(f.statusCode, 200, f.body);
  assert.equal((f.json() as any).seller_binding, "throttled");
  assert.equal((f.json() as any).seller, null);
  assert.equal((await rowsForSub(fSub)).length, 0);
  assert.equal(await selfSignupRows(), baselineRows + 4);
  // the throttled identity keeps no capability and cannot act as a seller
  const draft = await createDraft(mint({ sub: fSub, email: `pilot-f-${tag}@example.com` }));
  assert.ok([401, 403].includes(draft.statusCode), `throttled identity drafted: ${draft.statusCode}`);
});

await run("the owner e-mail claim path is unchanged (owner gets admin + approved seller, binding=owner)", async () => {
  const ownerSub = randomUUID();
  const res = await caps(mint({ sub: ownerSub, email: String(process.env.SITON_OWNER_EMAIL) }));
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.seller_binding, "owner");
  assert.equal(body.seller?.seller_id, "c-ton-owner");
  assert.equal(body.seller?.verification_status, "approved");
  assert.equal(body.admin?.role, "SuperAdmin");
});

await pool.end();
await app.close();
jwksServer.close();
console.log(`\nSELLER_SELF_BINDING passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
