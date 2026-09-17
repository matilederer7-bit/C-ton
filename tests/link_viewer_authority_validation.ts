// External LINK VIEWER credential — authority boundary outside demo-preview.
//
// The seller distribution hub can hand ONE link's dashboard to an external
// person. That credential is a scoped, read-only analytics identity. This
// proof runs the runtime in internal-runtime mode (no demo workspace
// fallbacks) and shows that a valid viewer session:
//   * reads its own aggregated dashboard,
//   * is refused on EVERY /api/seller, /api/admin, /api/affiliate and
//     /api/distributor route (never a 2xx),
//   * cannot read another link by changing the link id,
//   * loses everything the moment the seller revokes it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3654";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-link-viewer";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-link-viewer";
process.env.ADMIN_API_KEY = "link-viewer-admin-key";
process.env.LINK_VIEWER_SESSION_SECRET = "link-viewer-session-secret-proof";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });
const { app } = await import("../src/app.js");
const { hashSellerAccessSecret } = await import("../src/seller_auth.js");
const { LINK_VIEWER_SESSION_COOKIE } = await import("../src/distribution_hub.js");
await app.ready();

let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.stack || error}`); }
}

// Fixture: one seller, one published deal, two seller distribution links,
// one external viewer granted link A1 only. Built directly in SQL — this
// proof is about the credential boundary, not the seller flow.
const SELLER = `lv-seller-${randomUUID().slice(0, 8)}`;
await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
   VALUES ($1,$1,'Viewer Ltd','viewer@siton.local','approved','active') ON CONFLICT (seller_id) DO NOTHING`,
  [SELLER]
);
const dealId = randomUUID();
await pool.query(
  `INSERT INTO siton.deals (deal_id, seller_id, title, description, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at)
   VALUES ($1,$2,'Viewer boundary deal','proof',30,2,50,2, now() + interval '2 day','PendingTarget', now())`,
  [dealId, SELLER]
);
const linkA1 = randomUUID();
const linkA2 = randomUUID();
await pool.query(
  `INSERT INTO siton.affiliate_links (link_id, affiliate_id, deal_id, internal_name, source_code, origin_type, channel)
   VALUES ($1, NULL, $3, 'Link A1 (granted)', $4, 'seller', 'whatsapp'),
          ($2, NULL, $3, 'Link A2 (not granted)', $5, 'seller', 'facebook')`,
  [linkA1, linkA2, dealId, `s${randomUUID().replace(/-/g, "").slice(0, 14)}`, `s${randomUUID().replace(/-/g, "").slice(0, 14)}`]
);
await pool.query(
  `INSERT INTO siton.affiliate_link_events (link_id, event_type, client_event_id, visitor_id)
   VALUES ($1,'entry','entry-a1-000001','v_a1_1'),($1,'entry','entry-a1-000002','v_a1_2'),($2,'entry','entry-a2-000001','v_a2_1')`,
  [linkA1, linkA2]
);
const username = `lv-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const password = "proof-password-123";
const viewer = await pool.query(
  `INSERT INTO siton.distribution_link_viewers (username, secret_hash, created_by_seller_id) VALUES ($1,$2,$3) RETURNING viewer_id`,
  [username, hashSellerAccessSecret(password), SELLER]
);
const viewerId = String(viewer.rows[0].viewer_id);
await pool.query(`INSERT INTO siton.distribution_link_viewer_grants (viewer_id, link_id) VALUES ($1,$2)`, [viewerId, linkA1]);

function cookieOf(res: any): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join("; ") : String(raw || "");
  const match = header.match(new RegExp(`${LINK_VIEWER_SESSION_COOKIE}=([^;]*)`));
  return match ? `${LINK_VIEWER_SESSION_COOKIE}=${match[1]}` : "";
}

let cookie = "";
await run("a valid viewer login issues a session and the dashboard shows ONLY the granted link's aggregates", async () => {
  const login = await app.inject({ method: "POST", url: "/api/link-viewer/session/login", payload: { username, password } });
  assert.equal(login.statusCode, 200, login.body);
  cookie = cookieOf(login);
  assert.ok(cookie);
  const dash = await app.inject({ method: "GET", url: "/api/link-viewer/dashboard", headers: { cookie } });
  assert.equal(dash.statusCode, 200, dash.body);
  const body = dash.json() as any;
  assert.equal(body.link.link_id, linkA1);
  assert.equal(body.link.link_name, "Link A1 (granted)");
  assert.equal(body.totals.entries, 2);
  assert.equal(body.totals.unique_visitors, 2);
  assert.ok(!dash.body.includes("Link A2"), "no other link in the payload");
  assert.ok(!dash.body.includes(SELLER), "no seller id in the payload");
  assert.ok(!dash.body.includes(dealId), "no internal deal id in the payload");
});

await run("changing the link id never crosses the grant (A1 credential → A2 = 403, guessed = 403, malformed = 403)", async () => {
  for (const other of [linkA2, randomUUID(), "not-a-uuid", "%27%20OR%20%271%27%3D%271"]) {
    const res = await app.inject({ method: "GET", url: `/api/link-viewer/dashboard?link=${other}`, headers: { cookie } });
    assert.equal(res.statusCode, 403, `${other} -> ${res.statusCode} ${res.body}`);
    assert.ok(!res.body.includes("Link A2"), "refusal leaks nothing");
  }
});

/** Rebuild full paths from Fastify's route tree (see the coverage proofs). */
function enumerateRoutes(printed: string): Array<{ path: string; methods: string[] }> {
  const routes: Array<{ path: string; methods: string[] }> = [];
  const branch: string[] = [];
  for (const raw of printed.split("\n")) {
    if (!raw.trim()) continue;
    const cleaned = raw.replace(/[│├└─]/g, " ");
    const depth = Math.floor((cleaned.length - cleaned.trimStart().length) / 4);
    const text = cleaned.trim();
    const withMethods = text.match(/^(.*?)\s*\(([A-Z, ]+)\)\s*$/);
    const segment = withMethods ? withMethods[1]! : text;
    branch[depth] = segment;
    branch.length = depth + 1;
    if (!withMethods) continue;
    const full = branch.join("");
    routes.push({ path: full.startsWith("/") ? full : `/${full}`, methods: withMethods[2]!.split(",").map((v) => v.trim()).filter(Boolean) });
  }
  return routes;
}

await run("the viewer session is refused on EVERY seller, admin, affiliate and distributor route (never a 2xx)", async () => {
  const routes = enumerateRoutes(app.printRoutes({ commonPrefix: false }))
    .filter((r) => ["/api/seller/", "/api/admin/", "/api/affiliate/", "/api/distributor/"].some((p) => r.path.startsWith(p)))
    // Anonymous-by-design entry points (session state probes, logins, logouts,
    // the public visit recorder) answer everyone; they carry no data.
    .filter((r) => !/\/session(\/login|\/logout)?$|\/auth\/(login|logout|mfa\/verify)$|\/links\/visit$/.test(r.path));
  assert.ok(routes.length >= 60, `expected the protected surfaces to be enumerated, found ${routes.length}`);
  const leaks: string[] = [];
  for (const route of routes) {
    for (const method of route.methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const url = route.path.replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => randomUUID());
      const injection: any = { method, url, headers: { cookie, "x-request-id": randomUUID() } };
      if (method !== "GET") { injection.payload = {}; }
      const res = await app.inject(injection);
      if (res.statusCode >= 200 && res.statusCode < 300) leaks.push(`${method} ${route.path} -> ${res.statusCode}`);
      if (res.body.includes("Link A1 (granted)") || res.body.includes("Link A2")) leaks.push(`${method} ${route.path} leaked link data`);
    }
  }
  assert.deepEqual(leaks, [], `viewer credential reached protected surfaces:\n${leaks.join("\n")}`);
});

await run("the viewer session is not a buyer/participant credential either", async () => {
  const res = await app.inject({ method: "GET", url: `/api/participants/${randomUUID()}/tracking`, headers: { cookie } });
  assert.ok(res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404, `tracking -> ${res.statusCode}`);
});

await run("revocation by the seller kills the live session and blocks new logins", async () => {
  await pool.query(`UPDATE siton.distribution_link_viewer_grants SET revoked_at=now() WHERE viewer_id=$1`, [viewerId]);
  await pool.query(`UPDATE siton.distribution_link_viewers SET enabled=false, revoked_at=now() WHERE viewer_id=$1`, [viewerId]);
  const dash = await app.inject({ method: "GET", url: "/api/link-viewer/dashboard", headers: { cookie } });
  assert.equal(dash.statusCode, 401, dash.body);
  const login = await app.inject({ method: "POST", url: "/api/link-viewer/session/login", payload: { username, password } });
  assert.ok(login.statusCode === 401 || login.statusCode === 403, `login after revoke -> ${login.statusCode}`);
});

await app.close().catch(() => undefined);
await pool.end();
console.log(`\nlink viewer authority validation: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
