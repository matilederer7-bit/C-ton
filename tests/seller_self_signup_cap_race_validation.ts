// BLACK-SKY D12 — the platform-wide self-signup hourly cap must hold under a
// burst of CONCURRENT first logins.
//
// The cap is a count-then-insert inside the capabilities transaction. Under
// READ COMMITTED every concurrent first login counted the same committed rows,
// all saw "below cap" and all inserted, so a burst of N identities bound N
// sellers regardless of the cap. The binding now takes a transaction-scoped
// advisory lock before counting, so the count and the insert are serialized.
//
// This test FAILS on the pre-fix code (more than `cap` bindings commit).
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = `race-${randomUUID().slice(0, 8)}`;
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "ES256", use: "sig" };
const jwksServer = createServer((req, res) => {
  if (String(req.url || "").startsWith("/auth/v1/.well-known/jwks.json")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", () => resolve()));
const SUPABASE_URL = `http://127.0.0.1:${(jwksServer.address() as any).port}`;

const CAP_HEADROOM = 3;
const selfSignupRows = async () =>
  Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.seller_security_events
     WHERE event_type='seller.self_signup.bound' AND created_at > now() - interval '1 hour'`
  )).rows[0].n);
const baseline = await selfSignupRows();

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_JWT_AUD = "authenticated";
process.env.APP_DEPLOYMENT_MODE = "staging";
process.env.APP_ENV = "production";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.ADMIN_API_KEY = `race-admin-${randomUUID()}`;
process.env.SITON_OWNER_EMAIL = "owner-race@example.com";
process.env.SELLER_SELF_SIGNUP_HOURLY_CAP = String(baseline + CAP_HEADROOM);

const { app } = await import("../src/app.js");
await app.ready();

const b64u = (value: Buffer | string) => Buffer.from(value).toString("base64url");
function mint(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: KID };
  const payload = { iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600, session_id: randomUUID(), ...claims };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = createSign("SHA256").update(input).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(signature)}`;
}

let exitCode = 0;
try {
  const tag = randomUUID().slice(0, 6);
  const identities = Array.from({ length: 12 }, (_, i) => ({ sub: randomUUID(), email: `race-${i}-${tag}@example.com` }));
  const responses = await Promise.all(identities.map((id) => app.inject({
    method: "GET", url: "/api/auth/capabilities", headers: { authorization: `Bearer ${mint(id)}` }
  })));
  const outcomes = responses.map((r) => {
    assert.equal(r.statusCode, 200, r.body);
    return String((r.json() as any).seller_binding);
  });
  const bound = outcomes.filter((o) => o === "bound").length;
  const throttled = outcomes.filter((o) => o === "throttled").length;
  const after = await selfSignupRows();
  const rows = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.seller_accounts WHERE auth_user_id = ANY($1::uuid[])`, [identities.map((i) => i.sub)])).rows[0].n);
  assert.equal(bound, CAP_HEADROOM, `exactly the cap headroom binds under a concurrent burst (outcomes: ${outcomes.join(",")})`);
  assert.equal(throttled, identities.length - CAP_HEADROOM);
  assert.equal(after - baseline, CAP_HEADROOM, "the audit rail never exceeds the cap");
  assert.equal(rows, CAP_HEADROOM, "no seller row beyond the cap");
  console.log("PASS the self-signup hourly cap holds under a concurrent burst of first logins");
} catch (error: any) {
  console.error(`FAIL self-signup cap race: ${error?.stack || error}`);
  exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
  await app.close().catch(() => undefined);
  jwksServer.close();
}
process.exit(exitCode);
