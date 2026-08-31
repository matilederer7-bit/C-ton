import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R6 — one canonical owner identity, explicit route authority.
// Proves: the owner-email claim provisions exactly one active SuperAdmin
// binding (idempotent, never rebinding a foreign auth_user_id); a
// multi-capability principal resolves both capabilities without silent
// selection; admin READ surfaces accept a named identity or the ops key and
// deny everything else; admin MUTATIONS never accept the bootstrap key.

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3642";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `r6-test-admin-key-${randomUUID()}`;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });
const { app } = await import("../src/app.js");
const { claimOwnerAdminBinding } = await import("../src/admin_identity.js");
const { resolveSupabaseCapabilities } = await import("../src/actor_resolver.js");

const OWNER_EMAIL = "owner-test@example.com";
const ADMIN_KEY = String(process.env.ADMIN_API_KEY);
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.stack || e}`); failed++; }
}

await run("owner claim provisions ONE active SuperAdmin binding, idempotently", async () => {
  const sub = randomUUID();
  await claimOwnerAdminBinding(pool as any, sub, OWNER_EMAIL);
  await claimOwnerAdminBinding(pool as any, sub, OWNER_EMAIL); // replay
  const rows = await pool.query(`SELECT * FROM siton.admin_users WHERE email=$1`, [OWNER_EMAIL]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].role, "SuperAdmin");
  assert.equal(rows.rows[0].status, "Active");
  assert.equal(String(rows.rows[0].auth_user_id), sub);
  assert.equal(rows.rows[0].provisioned_via, "owner_email_claim");
});

await run("owner claim never rebinds an email already bound to another auth user", async () => {
  const original = await pool.query(`SELECT auth_user_id FROM siton.admin_users WHERE email=$1`, [OWNER_EMAIL]);
  const foreignSub = randomUUID();
  await claimOwnerAdminBinding(pool as any, foreignSub, OWNER_EMAIL);
  const after = await pool.query(`SELECT auth_user_id FROM siton.admin_users WHERE email=$1`, [OWNER_EMAIL]);
  assert.equal(String(after.rows[0].auth_user_id), String(original.rows[0].auth_user_id), "existing binding is immutable via claim");
});

await run("multi-capability principal (admin + seller) resolves BOTH capabilities — route decides, resolver never picks", async () => {
  const sub = randomUUID();
  const sellerId = `owner-seller-${sub.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, auth_enabled, auth_user_id) VALUES ($1,$1,true,$2)`,
    [sellerId, sub]
  );
  await pool.query(
    `INSERT INTO siton.admin_users (email, role, status, auth_user_id) VALUES ($1,'SuperAdmin','Active',$2)`,
    [`multi-${sub.slice(0, 8)}@example.com`, sub]
  );
  const fakeVerifier = { async verify() { return { sub, email: "multi@example.com", aud: "authenticated", iss: "x", exp: 0, iat: 0 } as any; } };
  const req = { headers: { authorization: `Bearer ${randomUUID()}.${randomUUID()}.${randomUUID()}` } };
  const caps = await resolveSupabaseCapabilities(req, pool as any, fakeVerifier as any);
  assert.ok(caps?.admin, "admin capability present");
  assert.ok(caps?.seller, "seller capability present");
  assert.equal(caps?.seller?.seller_id, sellerId);
});

await run("admin READ surface denies anonymous, accepts the ops key", async () => {
  const anon = await app.inject({ method: "GET", url: "/api/admin/r6/overview" });
  assert.equal(anon.statusCode, 401, anon.body);
  const keyed = await app.inject({ method: "GET", url: "/api/admin/r6/overview", headers: { "x-admin-key": ADMIN_KEY } });
  assert.equal(keyed.statusCode, 200, keyed.body);
  const body = keyed.json() as any;
  assert.ok(body.deals && body.money && body.operations, "overview aggregates present");
  assert.ok("potential_gross_volume" in body.money && "charged_gross_volume" in body.money,
    "provisional and charged money are separate explicit fields");
});

await run("admin READ surface rejects a wrong key", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/r6/overview", headers: { "x-admin-key": "wrong-key" } });
  assert.equal(res.statusCode, 401);
});

await run("admin MUTATION (viral recompute) refuses the shared ops key — a named admin identity is required", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/admin/viral/recompute",
    headers: { "x-admin-key": ADMIN_KEY },
    payload: { deal_id: randomUUID() }
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((res.json() as any).error, "ADMIN_IDENTITY_REQUIRED");
});

await app.close().catch(() => undefined);
await pool.end();
console.log(`\nR6_OWNER_ADMIN_AUTHORITY ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
