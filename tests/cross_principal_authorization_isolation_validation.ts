// CROSS-PRINCIPAL ISOLATION (IDOR / BOLA) — object-level authorization.
//
// Phase 0 proved that an ANONYMOUS caller is refused. That says nothing about the
// bug class that actually costs tenants their data: an AUTHENTICATED principal
// reaching another principal's objects by knowing a UUID. Authentication is not
// authorization, and a route that checks "is there a seller session?" without
// checking "does this seller own this deal?" passes every Phase 0 test.
//
// Runs in internal-runtime with REAL DB-backed sessions, not the demo-preview
// x-seller-id convenience header: demo-preview auto-creates a workspace for any
// caller, so an isolation proof written against it proves nothing.
//
// The route set is enumerated from the LIVE Fastify router, so a seller route
// added tomorrow is probed without editing this file.
//
// Two invariants, and the second is the one people forget:
//
//   1. A principal must never receive 2xx for another principal's object.
//   2. A foreign object and a NONEXISTENT object must answer IDENTICALLY.
//      "403 forbidden" for a real id and "404 not found" for a fake one tells an
//      attacker which ids exist - the same oracle class fixed in Phase 0, one
//      authentication level up.
//
// Vacuity guard: the suite first proves seller A CAN reach its own deal. Without
// that, a broken session fixture would make every probe 401 and the isolation
// assertions would pass while proving nothing.
//
// No money, no external provider, no e-mail. Synthetic principals only.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3124";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-cross-principal";
process.env.ADMIN_API_KEY = "cross-principal-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-cross-principal";
process.env.DISTRIBUTOR_SESSION_SECRET = "distributor-session-secret-cross-principal";

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

/** Rebuild full paths from Fastify's route tree (see the Phase 0 gate). */
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
    routes.push({
      path: full.startsWith("/") ? full : `/${full}`,
      methods: withMethods[2]!.split(",").map((value) => value.trim()).filter(Boolean)
    });
  }
  return routes;
}

const SELLER_A = `seller-iso-a-${randomUUID().slice(0, 8)}`;
const SELLER_B = `seller-iso-b-${randomUUID().slice(0, 8)}`;

async function provisionSeller(sellerId: string, email: string, accessCode: string) {
  const { cookie } = await establishNamedAdminSession(app, pool);
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie },
    payload: {
      display_name: sellerId,
      login_email: email,
      access_code: accessCode,
      auth_enabled: true
    }
  });
  assert.equal(response.statusCode, 200, `provision ${sellerId} failed: ${response.body}`);
}

async function loginSeller(email: string, accessCode: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: email, access_code: accessCode }
  });
  assert.equal(login.statusCode, 200, `seller login failed: ${login.body}`);
  const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";
  assert.ok(cookie.includes("siton_seller_session="), "seller session cookie missing");
  return cookie;
}

async function seedDeal(sellerId: string, title: string) {
  const result = await pool.query(
    `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Draft')
     RETURNING deal_id`,
    [title, 50, 1, 20, 5, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), sellerId]
  );
  return String(result.rows[0].deal_id);
}

const ACCESS_CODE_A = "IsolationAlphaPass123!";
const ACCESS_CODE_B = "IsolationBetaPass123!";
const EMAIL_A = `${SELLER_A}@siton.test`;
const EMAIL_B = `${SELLER_B}@siton.test`;

await provisionSeller(SELLER_A, EMAIL_A, ACCESS_CODE_A);
await provisionSeller(SELLER_B, EMAIL_B, ACCESS_CODE_B);
const cookieA = await loginSeller(EMAIL_A, ACCESS_CODE_A);
const cookieB = await loginSeller(EMAIL_B, ACCESS_CODE_B);
const dealA = await seedDeal(SELLER_A, `Isolation A ${Date.now()}`);
const dealB = await seedDeal(SELLER_B, `Isolation B ${Date.now()}`);

async function seedInquiryThread(dealId: string, sellerId: string) {
  const result = await pool.query(
    `INSERT INTO siton.seller_inquiry_threads
       (deal_id, seller_id, customer_name, customer_email, customer_ref, customer_access_token_hash, last_message_preview)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING thread_id`,
    [dealId, sellerId, "Isolation Customer", `customer-${randomUUID().slice(0, 8)}@siton.test`,
      randomUUID(), randomUUID().replace(/-/g, ""), "isolation probe"]
  );
  return String(result.rows[0].thread_id);
}

const threadA = await seedInquiryThread(dealA, SELLER_A);
const threadB = await seedInquiryThread(dealB, SELLER_B);

const sellerRoutes = enumerateRoutes(app.printRoutes({ commonPrefix: false }))
  .filter((route) => route.path.startsWith("/api/seller/"));

/** Substitute a concrete id for the deal parameter, random values elsewhere. */
function urlWithDealId(routePath: string, dealId: string) {
  return routePath
    .replace(/:dealId(\|:[A-Za-z0-9_]+)*/g, dealId)
    .replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => randomUUID());
}

function injection(method: string, url: string, cookie: string) {
  const headers: Record<string, string> = { cookie, "x-request-id": randomUUID() };
  const payload: Record<string, unknown> = { method, url, headers };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    payload.payload = {};
  }
  return payload;
}

// ── Vacuity guard ────────────────────────────────────────────────────────────
// If the session fixture were broken every probe below would be 401 and the
// isolation assertions would pass while proving nothing.

await run("VACUITY GUARD: seller A really is authenticated and can reach its own deal", async () => {
  const list = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: cookieA } } as any);
  assert.equal(list.statusCode, 200, `seller A cannot list its own deals: ${list.body}`);
  assert.ok(list.body.includes(dealA), "seller A's own deal is missing from its own list - fixture is not real");

  const own = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}/draft`, headers: { cookie: cookieA } } as any);
  assert.equal(own.statusCode, 200, `seller A cannot read its own draft: ${own.body}`);

  // ...and the two principals are genuinely different accounts.
  const listB = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: cookieB } } as any);
  assert.equal(listB.statusCode, 200, listB.body);
  assert.ok(!listB.body.includes(dealA), "seller B's own deal list leaked seller A's deal");
});

// ── Invariant 1: no 2xx on a foreign object ──────────────────────────────────

await run("no seller route serves seller A a deal owned by seller B", async () => {
  const dealRoutes = sellerRoutes.filter((route) => /:dealId/.test(route.path));
  assert.ok(dealRoutes.length >= 15, `expected the parametric seller surface, found ${dealRoutes.length}`);

  const leaks: string[] = [];
  for (const route of dealRoutes) {
    for (const method of route.methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const response = await app.inject(injection(method, urlWithDealId(route.path, dealB), cookieA) as any);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        leaks.push(`${method} ${route.path} -> ${response.statusCode}`);
      }
    }
  }
  assert.deepEqual(leaks, [], "seller A reached seller B's deal");
});

// ── Invariant 2: a foreign object is indistinguishable from a missing one ────

await run("a foreign deal and a nonexistent deal answer identically (no existence oracle)", async () => {
  const dealRoutes = sellerRoutes.filter((route) => /:dealId/.test(route.path));
  const divergent: string[] = [];
  for (const route of dealRoutes) {
    for (const method of route.methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const foreign = await app.inject(injection(method, urlWithDealId(route.path, dealB), cookieA) as any);
      const missing = await app.inject(injection(method, urlWithDealId(route.path, randomUUID()), cookieA) as any);
      if (foreign.statusCode !== missing.statusCode) {
        divergent.push(`${method} ${route.path} -> foreign ${foreign.statusCode} vs missing ${missing.statusCode}`);
      }
    }
  }
  assert.deepEqual(divergent, [], "seller routes distinguish a foreign deal from a missing one");
});

// ── Writes must not cross either ─────────────────────────────────────────────

await run("seller A cannot mutate seller B's deal (draft, delivery, publish, delete)", async () => {
  const before = await pool.query(`SELECT title, state, updated_at FROM siton.deals WHERE deal_id=$1`, [dealB]);
  assert.equal(before.rowCount, 1, "seller B's deal vanished before the write probes");

  const attempts: Array<[string, string, Record<string, unknown>]> = [
    ["PATCH", `/api/seller/deals/${dealB}/draft`, { title: "HIJACKED BY SELLER A" }],
    ["PUT", `/api/seller/deals/${dealB}/delivery`, { delivery_options: [{ option_type: "pickup", label: "hijack", price: 0 }] }],
    ["POST", `/api/seller/deals/${dealB}/duplicate`, {}],
    ["DELETE", `/api/seller/deals/${dealB}`, {}]
  ];
  const accepted: string[] = [];
  for (const [method, url, body] of attempts) {
    const response = await app.inject({
      method,
      url,
      headers: { cookie: cookieA, "content-type": "application/json", "x-request-id": randomUUID() },
      payload: body
    } as any);
    if (response.statusCode >= 200 && response.statusCode < 300) accepted.push(`${method} ${url} -> ${response.statusCode}`);
  }
  assert.deepEqual(accepted, [], "seller A's write against seller B's deal was accepted");

  const after = await pool.query(`SELECT title, state, updated_at FROM siton.deals WHERE deal_id=$1`, [dealB]);
  assert.equal(after.rowCount, 1, "seller B's deal was deleted by seller A");
  assert.equal(after.rows[0].title, before.rows[0].title, "seller B's title was changed by seller A");
  assert.equal(String(after.rows[0].state), String(before.rows[0].state), "seller B's state was changed by seller A");

  // A duplicate that silently succeeded would create a NEW deal owned by A from
  // B's content - a copy is a read, and a read is what must not happen.
  const copies = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.deals WHERE seller_id=$1 AND title LIKE $2`,
    [SELLER_A, `%${String(before.rows[0].title)}%`]
  );
  assert.equal(copies.rows[0].n, 0, "seller A duplicated seller B's deal into its own account");
});

// ── Inquiry threads carry buyer personal data; isolation matters more here ───

await run("seller A cannot read or answer seller B's customer inquiry thread", async () => {
  // Own thread first: without this the probes below could pass on a broken route.
  const own = await app.inject({
    method: "GET",
    url: `/api/seller/inquiries/${threadA}`,
    headers: { cookie: cookieA, "x-request-id": randomUUID() }
  } as any);
  assert.equal(own.statusCode, 200, `seller A cannot read its own thread: ${own.body}`);
  assert.ok(!own.body.includes(SELLER_B), "seller A's own thread mentions seller B");

  const foreignRead = await app.inject({
    method: "GET",
    url: `/api/seller/inquiries/${threadB}`,
    headers: { cookie: cookieA, "x-request-id": randomUUID() }
  } as any);
  const missingRead = await app.inject({
    method: "GET",
    url: `/api/seller/inquiries/${randomUUID()}`,
    headers: { cookie: cookieA, "x-request-id": randomUUID() }
  } as any);
  assert.ok(foreignRead.statusCode < 200 || foreignRead.statusCode >= 300, "seller A read seller B's thread");
  assert.equal(foreignRead.statusCode, missingRead.statusCode, "a foreign thread is distinguishable from a missing one");

  const foreignReply = await app.inject({
    method: "POST",
    url: `/api/seller/inquiries/${threadB}/reply`,
    headers: { cookie: cookieA, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { message: "injected by another seller" }
  } as any);
  const missingReply = await app.inject({
    method: "POST",
    url: `/api/seller/inquiries/${randomUUID()}/reply`,
    headers: { cookie: cookieA, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { message: "injected by another seller" }
  } as any);
  assert.ok(foreignReply.statusCode < 200 || foreignReply.statusCode >= 300, "seller A replied into seller B's thread");
  assert.equal(foreignReply.statusCode, missingReply.statusCode, "a foreign thread is distinguishable from a missing one on reply");

  // Durable check: the refusal must also not have written anything.
  const messages = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.seller_inquiry_messages WHERE thread_id=$1`,
    [threadB]
  );
  assert.equal(messages.rows[0].n, 0, "a refused cross-tenant reply still wrote a message");

  const listA = await app.inject({
    method: "GET",
    url: "/api/seller/inquiries",
    headers: { cookie: cookieA, "x-request-id": randomUUID() }
  } as any);
  assert.equal(listA.statusCode, 200, listA.body);
  assert.ok(!listA.body.includes(threadB), "seller A's inquiry list leaked seller B's thread");
});

// ── Session authority cannot be forged or swapped ────────────────────────────

await run("a caller-supplied seller identity never overrides the session", async () => {
  // Session says A, header says B. The header must be ignored, never merged.
  const spoofed = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealB}/draft`,
    headers: { cookie: cookieA, "x-seller-id": SELLER_B, "x-request-id": randomUUID() }
  } as any);
  assert.ok(
    spoofed.statusCode < 200 || spoofed.statusCode >= 300,
    `x-seller-id upgraded seller A into seller B (${spoofed.statusCode})`
  );

  // And the same header alone, with no session at all, is not authority.
  const headerOnly = await app.inject({
    method: "GET",
    url: "/api/seller/deals",
    headers: { "x-seller-id": SELLER_A, "x-request-id": randomUUID() }
  } as any);
  assert.ok([401, 403].includes(headerOnly.statusCode), `header-only caller got ${headerOnly.statusCode}`);
});

await run("a seller session is not admin authority and not distributor authority", async () => {
  // Role confusion: holding one valid credential must not open another surface.
  // These admin routes are REAL and registered - probing a path that does not
  // exist would pass on the 404 and prove nothing.
  const registered = new Set(
    enumerateRoutes(app.printRoutes({ commonPrefix: false })).map((route) => route.path)
  );
  const adminProbes = ["/api/admin/overview", "/api/admin/actions", "/api/admin/mission-control", "/api/admin/auth/me"];
  for (const probePath of adminProbes) {
    assert.ok(registered.has(probePath), `${probePath} is not registered - this probe would prove nothing`);
    const adminProbe = await app.inject({
      method: "GET",
      url: probePath,
      headers: { cookie: cookieA, "x-request-id": randomUUID() }
    } as any);
    assert.ok(
      [401, 403].includes(adminProbe.statusCode),
      `a seller session reached ${probePath} (${adminProbe.statusCode})`
    );
  }

  const distributorProbe = await app.inject({
    method: "GET",
    url: "/api/affiliate/overview",
    headers: { cookie: cookieA, "x-request-id": randomUUID() }
  } as any);
  assert.ok(
    distributorProbe.statusCode < 200 || distributorProbe.statusCode >= 300,
    `a seller session reached the distributor surface (${distributorProbe.statusCode})`
  );
});

console.log(`SUMMARY passed=${passed} failed=${failed} seller_a=${SELLER_A} seller_b=${SELLER_B}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
