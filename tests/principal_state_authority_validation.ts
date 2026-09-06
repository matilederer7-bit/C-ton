// PRINCIPAL STATE AUTHORITY — capability tiers, session lifecycle, account state.
//
// Phase 0 proved anonymous callers are refused. Phase 2 proved one authenticated
// principal cannot reach another's objects. This is the third question: does a
// principal's own AUTHORITY match its current state?
//
// A credential is not a capability. A session that was valid is not a session
// that is valid. An account that could act is not an account that may still act.
//
// The headline invariant is enumerated from the LIVE Fastify router rather than
// listed by hand, so a new admin mutation is covered the moment it is registered:
//
//   A ReadOnlyAdmin holds a REAL, fully authenticated, MFA-verified session and
//   must still never mutate anything. Every non-GET route under /api/admin/ is
//   probed with that session; not one may answer 2xx.
//
// Role permissions (src/admin_identity.ts):
//   SuperAdmin     every permission
//   OpsAdmin       mission_control.read, admin_actions.{read,create,approve,execute}, ...
//   SupportAdmin   mission_control.read, admin_actions.{read,create}, support.manage, security.read
//   ReadOnlyAdmin  mission_control.read, admin_actions.read, security.read      <- no writes at all
//
// Vacuity guards throughout: each underprivileged probe is paired with proof that
// the SAME route is reachable by a principal that does hold the capability, or
// that the underprivileged principal is genuinely authenticated. Otherwise a
// broken fixture would make every assertion pass while proving nothing.
//
// No money, no external provider, no e-mail. Synthetic principals only.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import nodePath from "node:path";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3125";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-principal-state";
process.env.ADMIN_API_KEY = "principal-state-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-principal-state";

const policy = createRequire(import.meta.url)(nodePath.join(process.cwd(), "scripts", "protected_route_policy.cjs"));

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

function concreteUrl(routePath: string) {
  return routePath.replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => randomUUID());
}

const allRoutes = enumerateRoutes(app.printRoutes({ commonPrefix: false }));
const ADMIN_KEY = process.env.ADMIN_API_KEY!;

// Non-GET routes under /api/admin/, minus the reviewed anonymous-by-design
// entries (logout is idempotent teardown and answers 2xx for anyone by design).
const adminMutationRoutes = allRoutes
  .filter((route) => route.path.startsWith("/api/admin/"))
  .filter((route) => policy.classifyRoute(route.path) === "protected")
  .map((route) => ({
    path: route.path,
    methods: route.methods.filter((method) => !["GET", "HEAD", "OPTIONS"].includes(method))
  }))
  .filter((route) => route.methods.length > 0);

function adminInjection(method: string, routePath: string, headers: Record<string, string>) {
  return {
    method,
    url: concreteUrl(routePath),
    headers: { ...headers, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: {}
  };
}

// ── Capability tier: a read-only admin can never write ───────────────────────

const readOnly = await establishNamedAdminSession(app, pool, {
  role: "ReadOnlyAdmin",
  email: `zzz-readonly-${randomUUID().slice(0, 8)}@siton.local`
});

await run("VACUITY GUARD: the ReadOnlyAdmin session is real and its reads work", async () => {
  const me = await app.inject({ method: "GET", url: "/api/admin/auth/me", headers: { cookie: readOnly.cookie } } as any);
  assert.equal(me.statusCode, 200, `read-only admin is not authenticated at all: ${me.body}`);
  const identity = me.json() as any;
  const role = String(identity?.admin?.role ?? identity?.role ?? "");
  assert.equal(role, "ReadOnlyAdmin", `expected a ReadOnlyAdmin identity, got ${role || JSON.stringify(identity).slice(0, 200)}`);

  // A permission it DOES hold must work, or every 403 below proves nothing.
  const allowed = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: readOnly.cookie } } as any);
  assert.equal(allowed.statusCode, 200, `read-only admin cannot exercise admin_actions.read: ${allowed.body}`);
});

// SELF-SERVICE EXCEPTION, reviewed rather than whitelisted.
//
// Enrolling YOUR OWN second factor is an account action, not a platform mutation,
// and every authenticated admin must be able to do it regardless of role - a
// ReadOnlyAdmin who cannot set up MFA cannot secure their own login. The
// dangerous neighbour, /api/admin/auth/mfa/disable, correctly requires
// admin_users.manage; that split is the right one.
//
// The exception is only safe while the route cannot be aimed at somebody else,
// so it is not simply excluded below: the next test PROVES the route ignores any
// caller-supplied target identity.
const SELF_SERVICE_OWN_IDENTITY = new Set(["/api/admin/auth/mfa/setup"]);

await run("a ReadOnlyAdmin session never mutates platform state", async () => {
  // Floor, not a target: it guards against a collapsed enumeration making every
  // assertion below vacuously true. The surface is 19 route/method pairs today.
  assert.ok(adminMutationRoutes.length >= 15, `expected the admin mutation surface, found ${adminMutationRoutes.length}`);
  const accepted: string[] = [];
  const faults: string[] = [];
  const observed: Record<string, number> = {};
  // A permission check that runs AFTER a lookup answers 404-for-missing and
  // 403-for-present, which is the same existence oracle Phase 0 closed, one
  // authentication level up. Recorded per route so it can be judged, not buried
  // in a status histogram.
  const notForbidden: string[] = [];
  for (const route of adminMutationRoutes) {
    if (SELF_SERVICE_OWN_IDENTITY.has(route.path)) continue;
    for (const method of route.methods) {
      const response = await app.inject(adminInjection(method, route.path, { cookie: readOnly.cookie }) as any);
      const status = response.statusCode;
      observed[String(status)] = (observed[String(status)] || 0) + 1;
      if (status >= 200 && status < 300) accepted.push(`${method} ${route.path} -> ${status}`);
      // A 5xx from an underprivileged caller means the request reached logic that
      // then fell over, which is both an authorization and a robustness defect.
      if (status >= 500) faults.push(`${method} ${route.path} -> ${status}`);
      if (status !== 403) notForbidden.push(`${method} ${route.path} -> ${status}`);
    }
  }
  console.log(`  read-only admin write probes: ${JSON.stringify(observed)}`);
  if (notForbidden.length) console.log(`  not-403 outcomes: ${notForbidden.join(" | ")}`);
  assert.deepEqual(accepted, [], "a ReadOnlyAdmin mutated the platform");
  assert.deepEqual(faults, [], "a ReadOnlyAdmin write probe produced a server fault");
});

await run("the self-service MFA route cannot be aimed at another admin", async () => {
  // This is what makes the exception above safe. If a caller-supplied identity
  // could steer the enrolment, a ReadOnlyAdmin would be able to attach a second
  // factor to a SuperAdmin account - an escalation, not an account action.
  const victim = await establishNamedAdminSession(app, pool, {
    role: "SuperAdmin",
    email: `zzz-mfa-victim-${randomUUID().slice(0, 8)}@siton.local`
  });
  const victimId = (await pool.query(
    `SELECT admin_user_id FROM siton.admin_users WHERE email=$1`,
    [victim.email]
  )).rows[0].admin_user_id;
  const attackerId = (await pool.query(
    `SELECT admin_user_id FROM siton.admin_users WHERE email=$1`,
    [readOnly.email]
  )).rows[0].admin_user_id;

  const before = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.admin_mfa_challenges WHERE admin_user_id=$1 AND purpose='mfa_setup'`,
    [victimId]
  );

  for (const body of [
    { admin_user_id: victimId },
    { email: victim.email },
    { admin_user_id: victimId, email: victim.email, role: "SuperAdmin" }
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/auth/mfa/setup",
      headers: { cookie: readOnly.cookie, "content-type": "application/json", "x-request-id": randomUUID() },
      payload: body
    } as any);
    assert.ok(response.statusCode < 500, `mfa/setup faulted on a steered body: ${response.statusCode}`);
  }

  const after = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.admin_mfa_challenges WHERE admin_user_id=$1 AND purpose='mfa_setup'`,
    [victimId]
  );
  assert.equal(
    after.rows[0].n,
    before.rows[0].n,
    "a ReadOnlyAdmin enrolled a second factor against another admin's account"
  );

  const own = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.admin_mfa_challenges WHERE admin_user_id=$1 AND purpose='mfa_setup'`,
    [attackerId]
  );
  assert.ok(own.rows[0].n > 0, "the enrolment did not land on the caller's own account either - probe is not meaningful");
});

await run("the execute route's post-lookup permission check discloses nothing new", async () => {
  // POST /api/admin/actions/:adminActionId/execute authenticates, THEN loads the
  // row, THEN enforces the action-type-specific permission - the permission
  // cannot be known before the type is read. So an authenticated caller without
  // that permission still sees 404-for-missing versus a guard answer for a real
  // id: an existence oracle, UNLESS everyone who can get past the authentication
  // gate can already enumerate admin actions anyway.
  //
  // That premise is load-bearing, so it is proven rather than assumed: every role
  // holds admin_actions.read. If a future role does not, this fails and the
  // execute route's ordering has to be revisited.
  const roles = ["SuperAdmin", "OpsAdmin", "SupportAdmin", "ReadOnlyAdmin"];
  for (const role of roles) {
    const session = await establishNamedAdminSession(app, pool, {
      role,
      email: `zzz-enum-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@siton.local`
    });
    const list = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: session.cookie } } as any);
    assert.equal(
      list.statusCode,
      200,
      `${role} cannot list admin actions, so the execute route's 404 leaks existence to it (${list.statusCode})`
    );
  }

  // And the bootstrap key, which holds no session, is stopped BEFORE the lookup.
  const bootstrap = await app.inject({
    method: "POST",
    url: `/api/admin/actions/${randomUUID()}/execute`,
    headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
    payload: {}
  } as any);
  assert.ok(
    [401, 403].includes(bootstrap.statusCode),
    `the bootstrap key reached the execute lookup and got ${bootstrap.statusCode}`
  );
});

await run("a SupportAdmin cannot approve, reject or execute an admin action", async () => {
  const support = await establishNamedAdminSession(app, pool, {
    role: "SupportAdmin",
    email: `zzz-support-${randomUUID().slice(0, 8)}@siton.local`
  });
  // SupportAdmin holds admin_actions.read and .create but NOT .approve/.execute.
  const readable = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: support.cookie } } as any);
  assert.equal(readable.statusCode, 200, `support admin cannot read actions: ${readable.body}`);

  const actionId = randomUUID();
  for (const url of [
    `/api/admin/actions/${actionId}/approve`,
    `/api/admin/actions/${actionId}/reject`,
    `/api/admin/actions/${actionId}/execute`
  ]) {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { cookie: support.cookie, "content-type": "application/json", "x-request-id": randomUUID() },
      payload: { reason: "support admin should not be able to do this" }
    } as any);
    assert.ok(
      response.statusCode < 200 || response.statusCode >= 300,
      `SupportAdmin was allowed ${url} (${response.statusCode})`
    );
    assert.ok(response.statusCode < 500, `${url} answered ${response.statusCode} for a SupportAdmin`);
  }
});

await run("the shared bootstrap key is read-only authority and can never mutate", async () => {
  // R5C: the shared key resolves to identity_strength=bootstrap_key_only, which
  // sessionRequired rejects. It is a break-glass READ credential, not an actor.
  const read = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { "x-admin-key": ADMIN_KEY } } as any);
  assert.ok([200, 403].includes(read.statusCode), `unexpected bootstrap-key read answer ${read.statusCode}: ${read.body}`);

  const accepted: string[] = [];
  for (const route of adminMutationRoutes) {
    for (const method of route.methods) {
      const response = await app.inject(adminInjection(method, route.path, { "x-admin-key": ADMIN_KEY }) as any);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        accepted.push(`${method} ${route.path} -> ${response.statusCode}`);
      }
    }
  }
  assert.deepEqual(accepted, [], "the shared bootstrap key mutated the platform");
});

// ── Session lifecycle ────────────────────────────────────────────────────────

await run("a revoked admin session stops working immediately", async () => {
  const doomed = await establishNamedAdminSession(app, pool, {
    role: "SuperAdmin",
    email: `zzz-revoked-${randomUUID().slice(0, 8)}@siton.local`
  });
  const before = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: doomed.cookie } } as any);
  assert.equal(before.statusCode, 200, `fixture session never worked: ${before.body}`);

  await pool.query(
    `UPDATE siton.admin_sessions SET revoked_at = now()
     WHERE admin_user_id = (SELECT admin_user_id FROM siton.admin_users WHERE email = $1)`,
    [doomed.email]
  );

  const after = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: doomed.cookie } } as any);
  assert.ok([401, 403].includes(after.statusCode), `a revoked admin session still works (${after.statusCode})`);
});

await run("an expired admin session stops working immediately", async () => {
  const stale = await establishNamedAdminSession(app, pool, {
    role: "SuperAdmin",
    email: `zzz-expired-${randomUUID().slice(0, 8)}@siton.local`
  });
  const before = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: stale.cookie } } as any);
  assert.equal(before.statusCode, 200, `fixture session never worked: ${before.body}`);

  await pool.query(
    `UPDATE siton.admin_sessions SET expires_at = now() - interval '1 hour'
     WHERE admin_user_id = (SELECT admin_user_id FROM siton.admin_users WHERE email = $1)`,
    [stale.email]
  );

  const after = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: stale.cookie } } as any);
  assert.ok([401, 403].includes(after.statusCode), `an expired admin session still works (${after.statusCode})`);
});

await run("a disabled admin account loses authority even while holding a live session", async () => {
  const disabled = await establishNamedAdminSession(app, pool, {
    role: "SuperAdmin",
    email: `zzz-disabled-${randomUUID().slice(0, 8)}@siton.local`
  });
  const before = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: disabled.cookie } } as any);
  assert.equal(before.statusCode, 200, `fixture session never worked: ${before.body}`);

  await pool.query(`UPDATE siton.admin_users SET status = 'Disabled' WHERE email = $1`, [disabled.email]);

  const after = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: disabled.cookie } } as any);
  assert.ok(
    [401, 403].includes(after.statusCode),
    `a disabled admin account still holds authority through its old session (${after.statusCode})`
  );
});

await run("forged and malformed session material is refused, never fatal", async () => {
  const forged = [
    "siton_admin_session=",
    "siton_admin_session=not-a-token",
    `siton_admin_session=${"a".repeat(512)}`,
    "siton_admin_session=../../etc/passwd",
    "siton_admin_session=%00%00%00",
    'siton_admin_session={"admin_user_id":"1","role":"SuperAdmin"}',
    "siton_seller_session=not-a-token",
    `siton_seller_session=${randomUUID()}`
  ];
  for (const cookie of forged) {
    const admin = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie } } as any);
    assert.ok([401, 403].includes(admin.statusCode), `forged cookie ${cookie.slice(0, 40)} got ${admin.statusCode} on admin`);

    const seller = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie } } as any);
    assert.ok([401, 403].includes(seller.statusCode), `forged cookie ${cookie.slice(0, 40)} got ${seller.statusCode} on seller`);
  }
});

// ── Seller account state ─────────────────────────────────────────────────────

const SELLER_STATE = `seller-state-${randomUUID().slice(0, 8)}`;
const SELLER_STATE_EMAIL = `${SELLER_STATE}@siton.test`;
const SELLER_STATE_CODE = "PrincipalStatePass123!";

await run("a suspended seller keeps its session but loses the authority to operate", async () => {
  const { cookie: adminCookie } = await establishNamedAdminSession(app, pool);
  const provision = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${SELLER_STATE}/provision`,
    headers: { cookie: adminCookie },
    payload: {
      display_name: SELLER_STATE,
      login_email: SELLER_STATE_EMAIL,
      access_code: SELLER_STATE_CODE,
      auth_enabled: true
    }
  } as any);
  assert.equal(provision.statusCode, 200, provision.body);

  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: SELLER_STATE_EMAIL, access_code: SELLER_STATE_CODE }
  } as any);
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";

  const deal = await pool.query(
    `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
     VALUES ($1,50,1,20,5,$2,$3,'Draft') RETURNING deal_id`,
    [`Suspension probe ${Date.now()}`, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), SELLER_STATE]
  );
  const dealId = String(deal.rows[0].deal_id);

  // Active: the seller can operate. Without this the suspension probe proves nothing.
  const activeEdit = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/draft`,
    headers: { cookie, "content-type": "application/json" },
    payload: { title: "Edited while active" }
  } as any);
  assert.equal(activeEdit.statusCode, 200, `an Active seller cannot edit its own draft: ${activeEdit.body}`);

  // Provisioning already created the account row; suspend that row rather than
  // inserting a second one, so the probe exercises the real account.
  const suspended = await pool.query(
    `UPDATE siton.seller_accounts
     SET seller_status='Suspended', seller_status_reason='principal state probe'
     WHERE seller_id=$1`,
    [SELLER_STATE]
  );
  assert.equal(suspended.rowCount, 1, "the provisioned seller account row was not found to suspend");

  const suspendedEdit = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/draft`,
    headers: { cookie, "content-type": "application/json" },
    payload: { title: "Edited while suspended" }
  } as any);
  assert.equal(suspendedEdit.statusCode, 403, `a suspended seller still edits (${suspendedEdit.statusCode}): ${suspendedEdit.body}`);
  assert.match(suspendedEdit.body, /SELLER_SUSPENDED/, "the refusal does not carry the suspension reason code");

  // The refusal must be durable, not cosmetic.
  const row = await pool.query(`SELECT title FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(row.rows[0].title, "Edited while active", "a suspended seller's edit was persisted anyway");
});

await run("seller logout revokes the session for every subsequent request", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: SELLER_STATE_EMAIL, access_code: SELLER_STATE_CODE }
  } as any);
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";

  const before = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie } } as any);
  assert.equal(before.statusCode, 200, `fixture seller session never worked: ${before.body}`);

  const logout = await app.inject({ method: "POST", url: "/api/seller/session/logout", headers: { cookie } } as any);
  assert.ok(logout.statusCode >= 200 && logout.statusCode < 300, `logout failed: ${logout.body}`);

  const after = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie } } as any);
  assert.ok([401, 403].includes(after.statusCode), `a logged-out seller session still works (${after.statusCode})`);
});

console.log(`SUMMARY passed=${passed} failed=${failed} admin_mutation_routes=${adminMutationRoutes.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
