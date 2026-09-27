// Black-Sky F-M4 — the Supabase JWKS source never blocks a request on a refresh
// while a usable key set exists, runs one fetch at a time, fails fast during an
// outage, rate-limits forced (unknown-kid) refreshes, and rejects only when no
// usable key set exists. Also compares against the previous source (remoteJwks)
// to record the failing-before behaviour: it awaited the refresh fetch.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, randomUUID } from "node:crypto";
import { AuthTokenError, remoteJwks, verifySupabaseAccessToken } from "../src/supabase_auth.js";
import { cachedRemoteJwks } from "../src/jwks_cache.js";

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...(publicKey.export({ format: "jwk" }) as any), kid: "k1", alg: "ES256", use: "sig" };
const ISSUER = "https://example.supabase.co/auth/v1";
const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function token(kid = "k1") {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }))}.${b64url(JSON.stringify({ iss: ISSUER, aud: "authenticated", sub: randomUUID(), role: "authenticated", exp: now + 600, iat: now }))}`;
  const sig = cryptoSign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" } as any);
  return `${input}.${b64url(sig)}`;
}

type Mode = "ok" | "fail" | "hang";
function fakeFetch() {
  let mode: Mode = "ok";
  let calls = 0;
  const impl = (async (_url: any, init?: any) => {
    calls += 1;
    if (mode === "fail") return new Response("down", { status: 503 });
    if (mode === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      });
    }
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, set: (m: Mode) => { mode = m; }, calls: () => calls };
}

await run("a valid token verifies through the cached source; repeated verifications fetch once", async () => {
  const f = fakeFetch();
  const jwks = cachedRemoteJwks("https://example/jwks", { fetchImpl: f.impl });
  for (let i = 0; i < 5; i++) {
    const out = await verifySupabaseAccessToken(token(), { issuer: ISSUER, audience: "authenticated", jwks });
    assert.equal(out.role, "authenticated");
  }
  assert.equal(f.calls(), 1);
});

await run("stale-while-revalidate: past the TTL during an outage, requests are answered from the stale set without waiting", async () => {
  let clock = 1_000_000;
  const f = fakeFetch();
  const jwks = cachedRemoteJwks("https://example/jwks", { fetchImpl: f.impl, ttlMs: 1_000, timeoutMs: 400, now: () => clock });
  await jwks.get();
  clock += 5_000; // stale
  f.set("hang");
  const started = Date.now();
  const verifications = await Promise.all(Array.from({ length: 20 }, () =>
    verifySupabaseAccessToken(token(), { issuer: ISSUER, audience: "authenticated", jwks })));
  const elapsed = Date.now() - started;
  assert.equal(verifications.length, 20);
  assert.ok(elapsed < 200, `20 verifications waited ${elapsed} ms on a hanging refresh`);
  assert.equal(f.calls(), 2, "one background refresh for 20 stale requests (single-flight)");
  await new Promise((r) => setTimeout(r, 500)); // let the hung refresh time out quietly
});

await run("cold start during an outage fails closed, and fast after the first failure (backoff)", async () => {
  let clock = 5_000_000;
  const f = fakeFetch();
  f.set("fail");
  const jwks = cachedRemoteJwks("https://example/jwks", { fetchImpl: f.impl, failureBackoffMs: 5_000, now: () => clock });
  await assert.rejects(() => jwks.get(), (e: any) => e instanceof AuthTokenError);
  for (let i = 0; i < 10; i++) {
    await assert.rejects(() => jwks.get(), (e: any) => e instanceof AuthTokenError && e.reason === "jwks_unavailable");
  }
  assert.equal(f.calls(), 1, "no fetch per request inside the failure backoff");
  await assert.rejects(() => verifySupabaseAccessToken(token(), { issuer: ISSUER, audience: "authenticated", jwks }), AuthTokenError);
  clock += 5_000;
  f.set("ok");
  assert.equal((await jwks.get()).length, 1, "after the backoff the source recovers");
});

await run("forced refreshes (unknown kid) are rate-limited; an unknown kid is still rejected", async () => {
  let clock = 9_000_000;
  const f = fakeFetch();
  const jwks = cachedRemoteJwks("https://example/jwks", { fetchImpl: f.impl, minForcedRefreshMs: 30_000, now: () => clock });
  await jwks.get();
  clock += 31_000;
  for (let i = 0; i < 25; i++) {
    await assert.rejects(
      () => verifySupabaseAccessToken(token(`random-${i}`), { issuer: ISSUER, audience: "authenticated", jwks }),
      (e: any) => e instanceof AuthTokenError && e.reason === "unknown_kid"
    );
  }
  assert.equal(f.calls(), 2, "25 unknown-kid tokens caused one forced refresh");
});

await run("a key set older than maxStale is unusable (fail closed)", async () => {
  let clock = 20_000_000;
  const f = fakeFetch();
  const jwks = cachedRemoteJwks("https://example/jwks", { fetchImpl: f.impl, maxStaleMs: 60_000, failureBackoffMs: 0, now: () => clock });
  await jwks.get();
  f.set("fail");
  clock += 30_000;
  assert.equal((await jwks.get()).length, 1, "within maxStale the stale set is served");
  await new Promise((r) => setImmediate(r));
  clock += 31_000;
  await assert.rejects(() => jwks.get(), AuthTokenError);
});

await run("failing-before evidence: the previous remoteJwks awaited the refresh on the request path", async () => {
  const f = fakeFetch();
  const original = globalThis.fetch;
  globalThis.fetch = f.impl;
  try {
    const legacy = remoteJwks("https://example/jwks", 1);
    await legacy.get();
    await new Promise((r) => setTimeout(r, 5));
    f.set("fail");
    const slowFetch = (async () => { await new Promise((r) => setTimeout(r, 250)); return new Response("down", { status: 503 }); }) as typeof fetch;
    globalThis.fetch = slowFetch;
    const started = Date.now();
    await legacy.get();
    const legacyWait = Date.now() - started;
    assert.ok(legacyWait >= 200, `legacy source waited ${legacyWait} ms (expected to block on the refresh)`);
  } finally {
    globalThis.fetch = original;
  }
});

if (failed) process.exit(1);
console.log("PASS supabase JWKS stale-while-revalidate cache");
