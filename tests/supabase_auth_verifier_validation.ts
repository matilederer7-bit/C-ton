import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, randomUUID } from "node:crypto";
import {
  verifySupabaseAccessToken,
  staticJwks,
  AuthTokenError,
  type Jwk
} from "../src/supabase_auth.js";

// Mints ES256 tokens with a local P-256 keypair and verifies the Fastify
// verifier accepts a valid token and fails closed on every tamper/claim
// violation. This exercises the exact code path used against the real Supabase
// ES256 JWKS in production.

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...(publicKey.export({ format: "jwk" }) as any), kid: "test-key-1", alg: "ES256", use: "sig" } as Jwk;
const jwks = staticJwks([jwk]);

const ISS = "https://project.supabase.co/auth/v1";
const AUD = "authenticated";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mint(payload: Record<string, unknown>, opts?: { kid?: string | null; alg?: string }) {
  const header: Record<string, unknown> = { alg: opts?.alg ?? "ES256", typ: "JWT" };
  if (opts?.kid !== null) header.kid = opts?.kid ?? "test-key-1";
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" } as any);
  return `${signingInput}.${b64url(sig)}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISS, aud: AUD, sub: randomUUID(), role: "authenticated", iat: now, exp: now + 3600, session_id: randomUUID(), ...overrides };
}

const opts = { issuer: ISS, audience: AUD, jwks };
let passed = 0;
let failed = 0;
async function ok(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.message || e}`); failed++; }
}
async function rejects(name: string, token: string, reason?: string) {
  await ok(name, async () => {
    await assert.rejects(
      () => verifySupabaseAccessToken(token, opts),
      (err: any) => {
        assert.ok(err instanceof AuthTokenError, `expected AuthTokenError, got ${err?.name}`);
        if (reason) assert.equal(err.reason, reason, `reason ${err.reason} != ${reason}`);
        return true;
      }
    );
  });
}

await ok("valid token accepted with correct claims", async () => {
  const sub = randomUUID();
  const v = await verifySupabaseAccessToken(mint(validClaims({ sub })), opts);
  assert.equal(v.sub, sub);
  assert.equal(v.role, "authenticated");
  assert.equal(v.iss, ISS);
});

await rejects("tampered payload rejected", (() => {
  const t = mint(validClaims());
  const parts = t.split(".");
  const forged = { ...JSON.parse(Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()), role: "service_role" };
  return `${parts[0]}.${b64url(JSON.stringify(forged))}.${parts[2]}`;
})(), "bad_signature");

await rejects("expired token rejected", mint(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 })), "expired");
await rejects("wrong issuer rejected", mint(validClaims({ iss: "https://evil.supabase.co/auth/v1" })), "issuer");
await rejects("wrong audience rejected", mint(validClaims({ aud: "some-other-aud" })), "audience");
await rejects("anon role rejected", mint(validClaims({ role: "anon" })), "not_authenticated_role");
await rejects("service_role rejected", mint(validClaims({ role: "service_role" })), "not_authenticated_role");
await rejects("non-uuid subject rejected", mint(validClaims({ sub: "not-a-uuid" })), "subject");
await rejects("alg none rejected", `${b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: "test-key-1" }))}.${b64url(JSON.stringify(validClaims()))}.`, "alg_not_allowed");
await rejects("HS256 (symmetric) rejected — no shared secret path", (() => {
  // Forge an HS256 header but reuse an ES256 signature; alg is not allowed.
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "test-key-1" }));
  return `${header}.${b64url(JSON.stringify(validClaims()))}.${b64url("x")}`;
})(), "alg_not_allowed");
await rejects("unknown kid rejected", mint(validClaims(), { kid: "no-such-key" }), "unknown_kid");
await rejects("missing token rejected", "", "missing");
await rejects("garbage token rejected", "not.a.jwt.at.all", "not_a_jwt");

// A token signed by a DIFFERENT key must not verify against our JWKS.
await ok("token signed by a foreign key is rejected", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "test-key-1" }));
  const payload = b64url(JSON.stringify(validClaims()));
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), { key: other.privateKey, dsaEncoding: "ieee-p1363" } as any);
  await assert.rejects(() => verifySupabaseAccessToken(`${header}.${payload}.${b64url(sig)}`, opts), (e: any) => e instanceof AuthTokenError && e.reason === "bad_signature");
});

console.log(`\nSUPABASE_AUTH_VERIFIER ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
