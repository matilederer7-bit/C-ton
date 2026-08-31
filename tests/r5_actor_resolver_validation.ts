import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveSupabaseCapabilities } from "../src/actor_resolver.js";
import { AuthTokenError } from "../src/supabase_auth.js";

// R6 capability resolution: a verified sub resolves to its FULL capability set,
// freshly from Postgres. One principal may hold several capabilities (owner =
// admin + seller), but authority stays explicit: each route reads only the
// capability it requires — the resolver never picks one on the caller's
// behalf. A capability duplicated within one table still fails closed. A
// missing or non-JWT bearer yields no capabilities (null), never an escalation.

function fakeVerifier(sub: string, email = "user@example.com") {
  return {
    issuer: "https://p.supabase.co/auth/v1",
    audience: "authenticated",
    async verify() {
      return { sub, email, role: "authenticated", aud: "authenticated", iss: "https://p.supabase.co/auth/v1", exp: 0, iat: 0 } as any;
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
  assert.equal(await resolveSupabaseCapabilities(bearer(), fakeDb({}) as any, null), null);
});

await ok("no bearer token → null", async () => {
  assert.equal(await resolveSupabaseCapabilities({ headers: {} }, fakeDb({}) as any, fakeVerifier(randomUUID()) as any), null);
});

await ok("opaque (non-JWT) bearer is left alone → null", async () => {
  const req = { headers: { authorization: "Bearer opaque-tracking-token-abc123" } };
  assert.equal(await resolveSupabaseCapabilities(req, fakeDb({}) as any, fakeVerifier(randomUUID()) as any), null);
});

await ok("seller binding resolves the seller capability only", async () => {
  const sub = randomUUID();
  const caps = await resolveSupabaseCapabilities(bearer(), fakeDb({ seller: [{ seller_id: "seller-x", display_name: "X", auth_enabled: true, seller_status: "Active" }] }) as any, fakeVerifier(sub) as any);
  assert.equal(caps?.seller?.seller_id, "seller-x");
  assert.equal(caps?.admin, null);
  assert.equal(caps?.distributor, null);
  assert.equal(caps?.sub, sub);
});

await ok("admin binding resolves the admin capability only", async () => {
  const caps = await resolveSupabaseCapabilities(bearer(), fakeDb({ admin: [{ admin_user_id: randomUUID(), email: "a@x", role: "OpsAdmin", status: "Active" }] }) as any, fakeVerifier(randomUUID()) as any);
  assert.equal(caps?.admin?.role, "OpsAdmin");
  assert.equal(caps?.seller, null);
});

await ok("distributor binding resolves the distributor capability only", async () => {
  const caps = await resolveSupabaseCapabilities(bearer(), fakeDb({ distributor: [{ affiliate_id: randomUUID(), auth_enabled: true, verification_status: "verified" }] }) as any, fakeVerifier(randomUUID()) as any);
  assert.ok(caps?.distributor);
  assert.equal(caps?.admin, null);
});

await ok("zero bindings → empty capability set (route requirement denies, resolver stays precise)", async () => {
  const caps = await resolveSupabaseCapabilities(bearer(), fakeDb({}) as any, fakeVerifier(randomUUID()) as any);
  assert.ok(caps);
  assert.equal(caps?.seller, null);
  assert.equal(caps?.admin, null);
  assert.equal(caps?.distributor, null);
});

await ok("multi-capability principal (owner: admin + seller) resolves BOTH — neither silently selected", async () => {
  const caps = await resolveSupabaseCapabilities(bearer(), fakeDb({
    seller: [{ seller_id: "s", display_name: "s", auth_enabled: true, seller_status: "Active" }],
    admin: [{ admin_user_id: randomUUID(), email: "owner@x", role: "SuperAdmin", status: "Active" }]
  }) as any, fakeVerifier(randomUUID()) as any);
  assert.equal(caps?.seller?.seller_id, "s");
  assert.equal(caps?.admin?.role, "SuperAdmin");
});

await ok("verified email claim is exposed lowercased for the owner-claim gate", async () => {
  const caps = await resolveSupabaseCapabilities(bearer(), fakeDb({}) as any, fakeVerifier(randomUUID(), "Owner@Example.COM") as any);
  assert.equal(caps?.email, "owner@example.com");
});

await ok("duplicate binding within one table fails closed", async () => {
  await assert.rejects(
    () => resolveSupabaseCapabilities(bearer(), fakeDb({
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
