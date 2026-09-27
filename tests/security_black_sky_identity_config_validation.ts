// Black-Sky hardening — identity, OTP proof and configuration boundaries.
//
// B2  owner-email admin claim: e-mail is necessary, never sufficient; pinned
//     SITON_OWNER_AUTH_USER_ID; anonymous / explicitly-unverified tokens are
//     refused; a hosted runtime without a pin refuses the claim; the claim
//     never re-activates a Suspended/Disabled admin row.
// B6  join OTP proof: a challenge id alone is not a proof; a supplied id must
//     match the signed token; the proof binds to the first deal it is used for.
// E10 production guard requires a distinct OTP_TOKEN_SECRET.
// E2  production/hosted guard refuses SUPABASE_MANAGEMENT_API_TOKEN.
// Grow keyring rotation variables are format-validated at boot.
// E5  storage-broker scope: canonical key shape inside an allowed namespace,
//     no bucket-root listing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.OTP_TEST_BYPASS_CODE = "424242";
delete process.env.NODE_ENV;
delete process.env.APP_ENV;
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;
delete process.env.SITON_OWNER_AUTH_USER_ID;
process.env.SITON_OWNER_EMAIL = "black-sky-owner@example.invalid";

const { assertProductionRuntimeGuards } = await import("../src/production_guards.js");
const { decideOwnerClaim, claimOwnerAdminBinding, resolveAdminIdentity } = await import("../src/admin_identity.js");
const { buildOtpProvider, ensureOtpRailTables, requestOtpChallenge, verifyOtpChallenge, ensureJoinOtpVerified, OtpValidationError } = await import("../src/otp_rail.js");
const { parseAllowedNamespaces, scopedKey, scopedListPrefix } = await import("../supabase/functions/storage-broker/scope.js");
const { base64DecodedLength } = await import("../src/seller_upload_quota.js");

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 5 });
let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) { previous[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

function production(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APP_DEPLOYMENT_MODE: "production", RUNTIME_ROLE: "web", PAYMENT_PROVIDER: "stripe", PAYMENT_PROVIDER_MODE: "stripe",
    PAYMENT_ENVIRONMENT: "production", PAYMENT_PROVIDER_API_KEY: "sk_live_contract_fixture", PAYMENT_PROVIDER_PUBLIC_KEY: "pk_live_contract_fixture",
    STORAGE_ADAPTER: "object", OBJECT_STORAGE_REGION: "us-east-1", OBJECT_STORAGE_BUCKET: "siton-production-private",
    OBJECT_STORAGE_ACCESS_KEY_ID: "production-access-key", OBJECT_STORAGE_SECRET_ACCESS_KEY: "production-secret-key",
    DATABASE_URL: "postgresql://placeholder.invalid/siton", CANONICAL_POSTGRES_RUNTIME: "1",
    ADMIN_API_KEY: "8f3c1d2e9a7b4c6d8e0f1a2b3c4d5e6f", SELLER_SESSION_SECRET: "0123456789abcdef0123456789abcdef0123",
    OTP_HASH_SALT: "9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f", OTP_TOKEN_SECRET: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    PAYMENT_WEBHOOK_SECRET: "whsec_contract_fixture", DISABLE_OUTBOX_WORKER: "1",
    SITON_VAT_MODE: "explicit", SITON_VAT_RATE_PRODUCT: "0.18", SITON_VAT_RATE_DELIVERY: "0.18",
    ...overrides
  };
}

// ── configuration guard ─────────────────────────────────────────────────────
await run("E10: production refuses a missing, shared, short or public-default OTP_TOKEN_SECRET", () => {
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", production()));
  const noToken = production(); delete noToken.OTP_TOKEN_SECRET;
  assert.throws(() => assertProductionRuntimeGuards("web", noToken), /OTP_TOKEN_SECRET is required/);
  assert.throws(() => assertProductionRuntimeGuards("web", production({ OTP_TOKEN_SECRET: "0123456789abcdef0123456789abcdef0123" })), /distinct from SELLER_SESSION_SECRET/);
  assert.throws(() => assertProductionRuntimeGuards("web", production({ OTP_TOKEN_SECRET: "9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f" })), /distinct from OTP_HASH_SALT/);
  assert.throws(() => assertProductionRuntimeGuards("web", production({ OTP_TOKEN_SECRET: "siton-otp-token-secret-default" })), /OTP_TOKEN_SECRET must be a non-placeholder/);
  assert.throws(() => assertProductionRuntimeGuards("web", production({ OTP_TOKEN_SECRET: "short-secret" })), /OTP_TOKEN_SECRET must be a non-placeholder/);
  assert.throws(() => assertProductionRuntimeGuards("worker", production({ RUNTIME_ROLE: "worker", DISABLE_OUTBOX_WORKER: "0", OTP_TOKEN_SECRET: "" })), /OTP_TOKEN_SECRET is required/);
});

await run("E2: hosted/production web and worker refuse SUPABASE_MANAGEMENT_API_TOKEN; local/demo is unaffected", () => {
  assert.throws(() => assertProductionRuntimeGuards("web", production({ SUPABASE_MANAGEMENT_API_TOKEN: "sbp_contract_fixture" })), /SUPABASE_MANAGEMENT_API_TOKEN must not be present/);
  assert.throws(() => assertProductionRuntimeGuards("worker", production({ RUNTIME_ROLE: "worker", DISABLE_OUTBOX_WORKER: "0", SUPABASE_MANAGEMENT_API_TOKEN: "sbp_contract_fixture" })), /SUPABASE_MANAGEMENT_API_TOKEN/);
  const hostedStaging = { APP_DEPLOYMENT_MODE: "staging", RENDER: "true", RUNTIME_ROLE: "web", CANONICAL_POSTGRES_RUNTIME: "1" };
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", hostedStaging));
  assert.throws(() => assertProductionRuntimeGuards("web", { ...hostedStaging, SUPABASE_MANAGEMENT_API_TOKEN: "sbp_contract_fixture" }), /SUPABASE_MANAGEMENT_API_TOKEN/);
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", { APP_DEPLOYMENT_MODE: "demo-preview", SUPABASE_MANAGEMENT_API_TOKEN: "local-owner-tooling" }));
});

await run("B2: production with SITON_OWNER_EMAIL requires a UUID SITON_OWNER_AUTH_USER_ID", () => {
  assert.throws(() => assertProductionRuntimeGuards("web", production({ SITON_OWNER_EMAIL: "owner@example.invalid" })), /SITON_OWNER_AUTH_USER_ID .* is required/);
  assert.throws(() => assertProductionRuntimeGuards("web", production({ SITON_OWNER_EMAIL: "owner@example.invalid", SITON_OWNER_AUTH_USER_ID: "not-a-uuid" })), /must be the owner's Supabase auth user UUID/);
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", production({ SITON_OWNER_EMAIL: "owner@example.invalid", SITON_OWNER_AUTH_USER_ID: randomUUID() })));
});

await run("Grow: key-id and previous-key rotation settings are format-validated at boot", () => {
  const grow = (o: Record<string, string> = {}) => production({
    PAYMENT_PROVIDER: "grow", PAYMENT_PROVIDER_MODE: "grow", PAYMENT_ENVIRONMENT: "live",
    PAYMENT_PROVIDER_BASE_URL: "https://secure.meshulam.co.il/api/light/server/1.0",
    GROW_USER_ID: "grow-live-contract-user", GROW_PAGE_CODE: "grow-live-contract-page",
    GROW_REFERENCE_ENCRYPTION_KEY: "grow-live-reference-key-32-characters-minimum",
    GROW_SUCCESS_URL: "https://siton.example.invalid/pay/success", GROW_CANCEL_URL: "https://siton.example.invalid/pay/cancel",
    GROW_NOTIFY_URL: "https://siton.example.invalid/webhooks/payments/grow", ...o
  });
  const prev = "previous-grow-reference-key-at-least-32-chars";
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", grow()));
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_KEY_ID: "k2026", GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: `k2025:${prev},${prev}-legacy` })));
  assert.throws(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_KEY_ID: "bad kid!" })), /GROW_REFERENCE_ENCRYPTION_KEY_ID must be/);
  assert.throws(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_KEY_ID: "x".repeat(33) })), /GROW_REFERENCE_ENCRYPTION_KEY_ID must be/);
  assert.throws(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: "k2025:too-short" })), /entries must be at least 32 characters/);
  assert.throws(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: `${prev},,${prev}x` })), /must not contain empty entries/);
  assert.throws(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: "changeme-previous-key-32-characters-long" })), /placeholder/);
  assert.throws(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: `k1:${prev},k1:${prev}-other` })), /kid "k1" names two different keys/);
  assert.throws(() => assertProductionRuntimeGuards("web", grow({ GROW_REFERENCE_ENCRYPTION_KEY_ID: "k1", GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: `k1:${prev}` })), /kid "k1" names two different keys/);
});

// ── B2 owner claim policy ───────────────────────────────────────────────────
const OWNER = String(process.env.SITON_OWNER_EMAIL);
await run("B2: owner-claim decision — e-mail necessary never sufficient; pin, anonymous, unverified, hosted", () => {
  const sub = randomUUID();
  assert.deepEqual(decideOwnerClaim({ sub, email: "someone@example.invalid" }), { eligible: false, reason: "email_mismatch" });
  assert.deepEqual(decideOwnerClaim({ sub, email: OWNER, token: { is_anonymous: true } }), { eligible: false, reason: "anonymous_token" });
  assert.deepEqual(decideOwnerClaim({ sub, email: OWNER, token: { email_verified: false } }), { eligible: false, reason: "email_not_verified" });
  assert.deepEqual(decideOwnerClaim({ sub, email: OWNER }), { eligible: true }, "local dev keeps the e-mail claim");
  withEnv({ RENDER: "true" }, () => assert.deepEqual(decideOwnerClaim({ sub, email: OWNER }), { eligible: false, reason: "owner_identity_not_pinned" }));
  withEnv({ NODE_ENV: "production" }, () => assert.deepEqual(decideOwnerClaim({ sub, email: OWNER }), { eligible: false, reason: "owner_identity_not_pinned" }));
  const pinned = randomUUID();
  withEnv({ SITON_OWNER_AUTH_USER_ID: pinned, RENDER: "true" }, () => {
    assert.deepEqual(decideOwnerClaim({ sub, email: OWNER }), { eligible: false, reason: "auth_user_id_mismatch" });
    assert.deepEqual(decideOwnerClaim({ sub: pinned.toUpperCase(), email: OWNER }), { eligible: true });
    assert.deepEqual(decideOwnerClaim({ sub: pinned, email: OWNER, token: { email_verified: false } }), { eligible: false, reason: "email_not_verified" });
  });
});

await run("B2: a Suspended owner admin row is never re-activated by the claim; foreign bindings stay immutable", async () => {
  const email = `suspended-owner-${randomUUID().slice(0, 8)}@example.invalid`;
  await pool.query(`INSERT INTO siton.admin_users (email, display_name, role, status) VALUES ($1,'Suspended Owner','SuperAdmin','Suspended')`, [email]);
  const sub = randomUUID();
  await claimOwnerAdminBinding(pool as any, sub, email);
  const row = (await pool.query(`SELECT status, auth_user_id FROM siton.admin_users WHERE email=$1`, [email])).rows[0];
  assert.equal(row.status, "Suspended", "claim must not flip an existing admin to Active");
  assert.equal(String(row.auth_user_id), sub, "unbound row may be bound to the verified subject");
  await claimOwnerAdminBinding(pool as any, randomUUID(), email);
  assert.equal(String((await pool.query(`SELECT auth_user_id FROM siton.admin_users WHERE email=$1`, [email])).rows[0].auth_user_id), sub);
});

await run("B2: resolveAdminIdentity on a hosted runtime without a pin never auto-provisions the owner", async () => {
  // A verifier stub standing in for a cryptographically valid token whose
  // e-mail claim matches SITON_OWNER_EMAIL (the attack: an unverified e-mail).
  const sub = randomUUID();
  const verifier = { issuer: "x", audience: "authenticated", async verify() { return { sub, email: OWNER, role: "authenticated", aud: "authenticated", iss: "x", exp: 0, iat: 0 } as any; } };
  const { resolveSupabaseCapabilities } = await import("../src/actor_resolver.js");
  const req = { headers: { authorization: `Bearer ${randomUUID()}.${randomUUID()}.${randomUUID()}` } };
  const caps = await resolveSupabaseCapabilities(req, pool as any, verifier as any);
  assert.ok(caps && !caps.admin);
  const eligible = withEnv({ RENDER: "true" }, () => decideOwnerClaim(caps!));
  assert.equal(eligible.eligible, false);
  // resolveAdminIdentity itself: no SUPABASE_URL configured here, so the path
  // is inert and must return no identity without a key.
  assert.equal(await withEnv({ ADMIN_API_KEY: "black-sky-admin-key-000000000" }, () => resolveAdminIdentity(req, pool as any)), null);
  const rows = await pool.query(`SELECT 1 FROM siton.admin_users WHERE auth_user_id=$1`, [sub]);
  assert.equal(rows.rowCount, 0, "no owner binding was created");
});

// ── B6 OTP join proof ───────────────────────────────────────────────────────
async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
}
await ensureOtpRailTables(withTx);
const provider = buildOtpProvider();
const phone = () => `05${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const isNotVerified = (err: unknown) => err instanceof OtpValidationError && err.code === "otp_not_verified";

await run("B6: a VERIFIED challenge id alone is not a join proof (the id is public to the requester)", async () => {
  const destination = phone();
  const challenge = await requestOtpChallenge(pool, provider, { channel: "sms", destination, purpose: "buyer_join" });
  await verifyOtpChallenge(pool, { challenge_id: challenge.challenge_id, code: "424242" });
  await assert.rejects(() => ensureJoinOtpVerified(pool, { otp_challenge_id: challenge.challenge_id, deal_id: randomUUID(), channel: "sms", destination }), isNotVerified);
});

await run("B6: a supplied challenge id must match the signed token", async () => {
  const a = await requestOtpChallenge(pool, provider, { channel: "sms", destination: phone(), purpose: "buyer_join" });
  const b = await requestOtpChallenge(pool, provider, { channel: "sms", destination: phone(), purpose: "buyer_join" });
  const verified = await verifyOtpChallenge(pool, { challenge_id: a.challenge_id, code: "424242" });
  await assert.rejects(() => ensureJoinOtpVerified(pool, { otp_token: verified.otp_token, otp_challenge_id: b.challenge_id, deal_id: randomUUID() }), isNotVerified);
  const ok = await ensureJoinOtpVerified(pool, { otp_token: verified.otp_token, otp_challenge_id: a.challenge_id, deal_id: randomUUID() });
  assert.equal(ok.challenge_id, a.challenge_id);
});

await run("B6: the proof binds to the first deal it is used for; replay on another deal is refused, same deal stays idempotent", async () => {
  const destination = phone();
  const challenge = await requestOtpChallenge(pool, provider, { channel: "sms", destination, purpose: "buyer_join" });
  const verified = await verifyOtpChallenge(pool, { challenge_id: challenge.challenge_id, code: "424242" });
  const dealA = randomUUID();
  await ensureJoinOtpVerified(pool, { otp_token: verified.otp_token, deal_id: dealA, channel: "sms", destination });
  await ensureJoinOtpVerified(pool, { otp_token: verified.otp_token, deal_id: dealA, channel: "sms", destination });
  await assert.rejects(() => ensureJoinOtpVerified(pool, { otp_token: verified.otp_token, deal_id: randomUUID(), channel: "sms", destination }), isNotVerified);
  // concurrent first use on two deals: exactly one wins
  const c2 = await requestOtpChallenge(pool, provider, { channel: "sms", destination: phone(), purpose: "buyer_join" });
  const v2 = await verifyOtpChallenge(pool, { challenge_id: c2.challenge_id, code: "424242" });
  const results = await Promise.allSettled([randomUUID(), randomUUID()].map((deal) => ensureJoinOtpVerified(pool, { otp_token: v2.otp_token, deal_id: deal })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

await run("B6: a token for another destination is refused (identity binding kept)", async () => {
  const challenge = await requestOtpChallenge(pool, provider, { channel: "sms", destination: phone(), purpose: "buyer_join" });
  const verified = await verifyOtpChallenge(pool, { challenge_id: challenge.challenge_id, code: "424242" });
  await assert.rejects(() => ensureJoinOtpVerified(pool, { otp_token: verified.otp_token, deal_id: randomUUID(), channel: "sms", destination: phone() }), isNotVerified);
});

// ── E5 storage broker scope ─────────────────────────────────────────────────
await run("E5: broker addresses only canonical keys inside an allowed namespace; never the bucket root", () => {
  const ns = parseAllowedNamespaces(undefined);
  assert.deepEqual(ns, ["staging"]);
  assert.deepEqual(parseAllowedNamespaces("staging, production"), ["staging", "production"]);
  assert.deepEqual(parseAllowedNamespaces("../x,/"), [], "a garbled configured list fails closed");
  const good = `staging/deals/${randomUUID()}/images/${randomUUID()}.webp`;
  assert.equal(scopedKey(good, ns), good);
  for (const bad of [
    `production/deals/${randomUUID()}/images/${randomUUID()}.webp`,
    `staging/other/${randomUUID()}/images/x.webp`,
    `staging/deals/${randomUUID()}/images/../x.webp`,
    `staging/deals/${randomUUID()}/images/x.exe`,
    `staging/deals/a/b/images/x.webp`,
    "staging/x.webp",
    "/staging/deals/a/images/x.webp",
    "staging\\deals\\a\\images\\x.webp\u0000"
  ]) assert.equal(scopedKey(bad, ns), null, bad);
  assert.equal(scopedKey(good, []), null, "empty allow-list refuses everything");
  assert.equal(scopedListPrefix("", ns), null, "bucket root listing refused");
  assert.equal(scopedListPrefix(undefined, ns), null);
  assert.equal(scopedListPrefix("production", ns), null);
  assert.equal(scopedListPrefix("staging", ns), "staging");
  assert.equal(scopedListPrefix("staging/deals", ns), "staging/deals");
  assert.equal(scopedListPrefix("staging/deals/abc-1/images/", ns), "staging/deals/abc-1/images");
  assert.equal(scopedListPrefix("staging/secrets", ns), null);
  assert.equal(scopedListPrefix("staging/deals/../..", ns), null);
});

await run("B8 helper: base64 decoded length matches Buffer decoding", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 1024, 4097]) {
    const b64 = Buffer.alloc(n, 7).toString("base64");
    assert.equal(base64DecodedLength(b64), n);
  }
});

await pool.end();
console.log(`BLACK_SKY_IDENTITY_CONFIG_PASS ${passed}`);
process.exit(0);
