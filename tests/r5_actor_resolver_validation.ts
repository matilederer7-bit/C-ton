import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveSupabaseActor } from "../src/actor_resolver.js";
import { AuthTokenError } from "../src/supabase_auth.js";

// Actor resolution: a verified sub binds to at most ONE canonical actor, freshly
// from Postgres. Ambiguous / cross-role / absent bindings fail closed. A missing
// or non-JWT bearer yields no actor (null), never an escalation.

function fakeVerifier(sub: string) {
  return {
    issuer: "https://p.supabase.co/auth/v1",
    audience: "authenticated",
    async verify() {
      return { sub, role: "authenticated", aud: "authenticated", iss: "https://p.supabase.co/auth/v1", exp: 0, iat: 0 } as any;
    }
  };
}

// A db stub whose responses are keyed by which table is queried.
function fakeDb(rows: { seller?: any[]; admin?: any[]; distributor?: any[] }) {
  return {
    async query(sql: string) {
      if (/seller_accounts/.test(sql)) return { rows: rows.seller || [], rowCount: (rows.seller || []).length };
      if (/admin_users/.test(sql)) return { rows: rows.admin || [], rowCount: (rows.admin || []).length };
      if (/affiliate_accounts/.test(sql)) return { rows: rows.distributor || [], rowCount: (rows.distributor || []).length };
      return { rows: [], rowCount: 0 };
    }
  };
}
const bearer = (token = `${randomUUID()}.${randomUUID()}.${randomUUID()}`) => ({ headers: { authorization: `Bearer ${token}` } });

let passed = 0, failed = 0;
async function ok(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.message || e}`); failed++; }
}

await ok("no verifier configured → null (inert)", async () => {
  assert.equal(await resolveSupabaseActor(bearer(), fakeDb({}) as any, null), null);
});

await ok("no bearer token → null", async () => {
  assert.equal(await resolveSupabaseActor({ headers: {} }, fakeDb({}) as any, fakeVerifier(randomUUID()) as any), null);
});

await ok("opaque (non-JWT) bearer is left alone → null", async () => {
  const req = { headers: { authorization: "Bearer opaque-tracking-token-abc123" } };
  assert.equal(await resolveSupabaseActor(req, fakeDb({}) as any, fakeVerifier(randomUUID()) as any), null);
});

await ok("seller binding resolves to a seller actor", async () => {
  const sub = randomUUID();
  const actor = await resolveSupabaseActor(bearer(), fakeDb({ seller: [{ seller_id: "seller-x", display_name: "X", auth_enabled: true, seller_status: "Active" }] }) as any, fakeVerifier(sub) as any);
  assert.equal(actor?.type, "seller");
  assert.equal(actor?.seller?.seller_id, "seller-x");
});

await ok("admin binding resolves to an admin actor", async () => {
  const actor = await resolveSupabaseActor(bearer(), fakeDb({ admin: [{ admin_user_id: randomUUID(), email: "a@x", role: "OpsAdmin", status: "Active" }] }) as any, fakeVerifier(randomUUID()) as any);
  assert.equal(actor?.type, "admin");
  assert.equal(actor?.admin?.role, "OpsAdmin");
});

await ok("distributor binding resolves to a distributor actor", async () => {
  const actor = await resolveSupabaseActor(bearer(), fakeDb({ distributor: [{ affiliate_id: randomUUID(), auth_enabled: true, verification_status: "verified" }] }) as any, fakeVerifier(randomUUID()) as any);
  assert.equal(actor?.type, "distributor");
});

await ok("no binding fails closed", async () => {
  await assert.rejects(
    () => resolveSupabaseActor(bearer(), fakeDb({}) as any, fakeVerifier(randomUUID()) as any),
    (e: any) => e instanceof AuthTokenError && e.reason === "no_actor_binding"
  );
});

await ok("cross-role binding (seller + admin) fails closed — never picks the most privileged", async () => {
  await assert.rejects(
    () => resolveSupabaseActor(bearer(), fakeDb({
      seller: [{ seller_id: "s", display_name: "s", auth_enabled: true, seller_status: "Active" }],
      admin: [{ admin_user_id: randomUUID(), email: "a@x", role: "SuperAdmin", status: "Active" }]
    }) as any, fakeVerifier(randomUUID()) as any),
    (e: any) => e instanceof AuthTokenError && e.reason === "cross_role_binding"
  );
});

await ok("duplicate binding within one table fails closed", async () => {
  await assert.rejects(
    () => resolveSupabaseActor(bearer(), fakeDb({
      seller: [
        { seller_id: "s1", display_name: "s1", auth_enabled: true, seller_status: "Active" },
        { seller_id: "s2", display_name: "s2", auth_enabled: true, seller_status: "Active" }
      ]
    }) as any, fakeVerifier(randomUUID()) as any),
    (e: any) => e instanceof AuthTokenError && e.reason === "ambiguous_binding"
  );
});

console.log(`\nR5_ACTOR_RESOLVER ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
