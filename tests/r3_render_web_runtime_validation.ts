import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { rewriteCanonicalApiAlias } from "../src/api_route_aliases.js";

// --- /api namespace aliases map onto the same lifecycle implementation ---
assert.equal(rewriteCanonicalApiAlias("/api/deals"), "/deals");
assert.equal(rewriteCanonicalApiAlias("/api/deals?x=1"), "/deals?x=1");
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/join"), "/deals/abc/join");
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/publish"), "/deals/abc/publish");
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/close_joining"), "/deals/abc/close_joining");
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/prepare_charging"), "/deals/abc/prepare_charging");
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/charging/start"), "/deals/abc/charging/start");
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/cancel"), "/deals/abc/cancel");
// Real /api routes of their own are never rewritten.
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/public"), "/api/deals/abc/public");
assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/chat"), "/api/deals/abc/chat");
assert.equal(rewriteCanonicalApiAlias("/api/deal-images/abc"), "/api/deal-images/abc");
assert.equal(rewriteCanonicalApiAlias("/api/otp/request"), "/api/otp/request");
assert.equal(rewriteCanonicalApiAlias("/deals/abc/join"), "/deals/abc/join");
assert.equal(rewriteCanonicalApiAlias("/health"), "/health");

// --- R3 blueprint and provisioning stay secret-free and canonical ---
const blueprint = await readFile("render.yaml", "utf8");
assert.match(blueprint, /healthCheckPath:\s*\/readiness/);
assert.match(blueprint, /-\s*key:\s*DATABASE_URL\s*\n\s*sync:\s*false/);
assert.match(blueprint, /CANONICAL_POSTGRES_RUNTIME/);
assert.match(blueprint, /region:\s*frankfurt/);
assert.doesNotMatch(blueprint, /postgres(?:ql)?:\/\/\S*@/);
assert.doesNotMatch(blueprint, /base44/i);
// R4: the canonical blueprint now declares exactly one continuous Background
// Worker (started via npm run start:worker:prod, RUNTIME_ROLE=worker), still
// secret-free. Both the Web and Worker DATABASE_URL stay external (sync: false).
assert.equal((blueprint.match(/type:\s*worker/gi) || []).length, 1, "blueprint must declare exactly one Background Worker");
assert.match(blueprint, /dockerCommand:\s*npm run start:worker:prod/);
assert.match(blueprint, /value:\s*worker\b/);

const dockerfile = await readFile("Dockerfile", "utf8");
assert.match(dockerfile, /^FROM node:22/m);
assert.match(dockerfile, /start:web:prod/);

const loginSql = await readFile("supabase/staging/010_r3_web_login_provisioning.sql", "utf8");
assert.doesNotMatch(loginSql, /password\s+'/i);
assert.match(loginSql, /CREATE ROLE siton_web_login LOGIN NOINHERIT/);
assert.match(loginSql, /ALTER ROLE siton_web_login SET role = 'siton_web_runtime'/);

// --- live replay: R2 boundary plus R3 login provisioning ---
const { Pool } = pg;
const adminUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const adminPool = new Pool({ connectionString: adminUrl, max: 3 });

await adminPool.query(`
  DO $roles$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END
  $roles$;
`);
await adminPool.query(await readFile("supabase/staging/001_siton_inventory_v1.sql", "utf8"));
await adminPool.query(await readFile("supabase/staging/006_canonical_postgres_runtime_boundary.sql", "utf8"));
await adminPool.query(await readFile("supabase/staging/007_runtime_role_admin_set_proof.sql", "utf8"));
await adminPool.query(await readFile("supabase/staging/008_runtime_trigger_helper_execute.sql", "utf8"));
await adminPool.query(await readFile("supabase/staging/009_runtime_function_public_fail_closed.sql", "utf8"));
await adminPool.query(await readFile("supabase/staging/010_r3_web_login_provisioning.sql", "utf8"));
// Replay must be idempotent.
await adminPool.query(await readFile("supabase/staging/010_r3_web_login_provisioning.sql", "utf8"));

const loginRole = await adminPool.query(`
  SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_roles WHERE rolname = 'siton_web_login'
`);
assert.equal(loginRole.rowCount, 1);
assert.equal(loginRole.rows[0].rolcanlogin, true);
assert.equal(loginRole.rows[0].rolinherit, false);
assert.equal(loginRole.rows[0].rolsuper, false);
assert.equal(loginRole.rows[0].rolcreatedb, false);
assert.equal(loginRole.rows[0].rolcreaterole, false);
assert.equal(loginRole.rows[0].rolreplication, false);
assert.equal(loginRole.rows[0].rolbypassrls, false);

const membership = await adminPool.query(`
  SELECT target_role.rolname AS granted, membership.set_option, membership.inherit_option, membership.admin_option
  FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  JOIN pg_roles target_role ON target_role.oid = membership.roleid
  WHERE member_role.rolname = 'siton_web_login'
`);
assert.equal(membership.rowCount, 1);
assert.equal(membership.rows[0].granted, "siton_web_runtime");
assert.equal(membership.rows[0].set_option, true);
assert.equal(membership.rows[0].inherit_option, false);
assert.equal(membership.rows[0].admin_option, false);

const sessionDefault = await adminPool.query(`
  SELECT setting.setconfig
  FROM pg_db_role_setting setting
  JOIN pg_roles login_role ON login_role.oid = setting.setrole
  WHERE login_role.rolname = 'siton_web_login' AND setting.setdatabase = 0
`);
assert.equal(sessionDefault.rowCount, 1);
assert.ok(sessionDefault.rows[0].setconfig.includes("role=siton_web_runtime"));

const directGrants = await adminPool.query(`
  SELECT count(*)::int AS n
  FROM information_schema.role_table_grants
  WHERE grantee = 'siton_web_login' AND table_schema IN ('siton', 'siton_inventory')
`);
assert.equal(directGrants.rows[0].n, 0);

// --- Fastify boot in canonical mode: readiness identity plus alias parity ---
const runtimeUrl = new URL(adminUrl);
runtimeUrl.searchParams.set("options", "-c role=siton_web_runtime");
process.env.DATABASE_URL = runtimeUrl.toString();
process.env.CANONICAL_POSTGRES_RUNTIME = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const runtime = await import("../src/app.js");
const app = runtime.app;

const readiness = await app.inject({ method: "GET", url: "/readiness" });
assert.equal(readiness.statusCode, 200, readiness.body);
assert.equal(readiness.json().runtime_role, "siton_web_runtime");

const bareJoin = await app.inject({
  method: "POST",
  url: "/deals/not-a-uuid/join",
  payload: {}
});
const aliasJoin = await app.inject({
  method: "POST",
  url: "/api/deals/not-a-uuid/join",
  payload: {}
});
assert.equal(aliasJoin.statusCode, bareJoin.statusCode, aliasJoin.body);
assert.ok(bareJoin.statusCode >= 400 && bareJoin.statusCode < 500);

const bareCreate = await app.inject({ method: "POST", url: "/deals", payload: {} });
const aliasCreate = await app.inject({ method: "POST", url: "/api/deals", payload: {} });
assert.equal(aliasCreate.statusCode, bareCreate.statusCode, aliasCreate.body);

// Pre-existing /api routes keep their own handlers.
const publicDeal = await app.inject({
  method: "GET",
  url: "/api/deals/00000000-0000-4000-8000-000000000000/public"
});
assert.ok([200, 404].includes(publicDeal.statusCode), publicDeal.body);

// A server-side connection kill (failover, administrator command) must not
// crash the process: idle pool clients emit 'error' events that db.ts absorbs,
// and the next readiness check gets a fresh connection.
await adminPool.query(`
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE application_name = 'siton-web-runtime' AND pid <> pg_backend_pid()
`);
await new Promise((resolve) => setTimeout(resolve, 250));
const recovered = await app.inject({ method: "GET", url: "/readiness" });
assert.equal(recovered.statusCode, 200, recovered.body);

await runtime.closeWorkerDatabase();
await app.close();
await adminPool.end();
console.log("PASS R3 Render Web runtime provisioning, blueprint and /api alias boundary");
