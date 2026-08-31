import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

// --- R4A: the Worker login provisioning stays secret-free and symmetric ---
const workerLoginSql = await readFile("supabase/staging/011_r4_worker_login_provisioning.sql", "utf8");
assert.doesNotMatch(workerLoginSql, /password\s+'/i);
assert.match(workerLoginSql, /CREATE ROLE siton_worker_login LOGIN NOINHERIT/);
assert.match(workerLoginSql, /ALTER ROLE siton_worker_login SET role = 'siton_worker_runtime'/);
assert.match(workerLoginSql, /GRANT siton_worker_runtime TO siton_worker_login WITH SET TRUE, INHERIT FALSE, ADMIN FALSE/);
// Cross-profile guards exist in both directions.
assert.match(workerLoginSql, /siton_worker_login must not hold the Web profile/);
assert.match(workerLoginSql, /siton_web_login must not hold the Worker profile/);

// --- live replay: R2 boundary + R3 Web login + R4 Worker login ---
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
await adminPool.query(workerLoginSql);
// Replay must be idempotent.
await adminPool.query(workerLoginSql);

// Role flags: plain non-inheriting LOGIN principal, zero admin authority.
const loginRole = await adminPool.query(`
  SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_roles WHERE rolname = 'siton_worker_login'
`);
assert.equal(loginRole.rowCount, 1);
assert.equal(loginRole.rows[0].rolcanlogin, true);
assert.equal(loginRole.rows[0].rolinherit, false);
assert.equal(loginRole.rows[0].rolsuper, false);
assert.equal(loginRole.rows[0].rolcreatedb, false);
assert.equal(loginRole.rows[0].rolcreaterole, false);
assert.equal(loginRole.rows[0].rolreplication, false);
assert.equal(loginRole.rows[0].rolbypassrls, false);

// Membership: exactly one grant, SET-only, to the audited Worker profile.
const membership = await adminPool.query(`
  SELECT target_role.rolname AS granted, membership.set_option, membership.inherit_option, membership.admin_option
  FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  JOIN pg_roles target_role ON target_role.oid = membership.roleid
  WHERE member_role.rolname = 'siton_worker_login'
`);
assert.equal(membership.rowCount, 1);
assert.equal(membership.rows[0].granted, "siton_worker_runtime");
assert.equal(membership.rows[0].set_option, true);
assert.equal(membership.rows[0].inherit_option, false);
assert.equal(membership.rows[0].admin_option, false);

// Session default adopts the Worker profile server-side.
const sessionDefault = await adminPool.query(`
  SELECT setting.setconfig
  FROM pg_db_role_setting setting
  JOIN pg_roles login_role ON login_role.oid = setting.setrole
  WHERE login_role.rolname = 'siton_worker_login' AND setting.setdatabase = 0
`);
assert.equal(sessionDefault.rowCount, 1);
assert.ok(sessionDefault.rows[0].setconfig.includes("role=siton_worker_runtime"));

// Zero direct object authority for the login principal.
const directGrants = await adminPool.query(`
  SELECT count(*)::int AS n
  FROM information_schema.role_table_grants
  WHERE grantee = 'siton_worker_login' AND table_schema IN ('siton', 'siton_inventory')
`);
assert.equal(directGrants.rows[0].n, 0);

// Cross-profile separation is provable from the catalog in both directions,
// and the R2 profiles remain NOLOGIN.
const separation = await adminPool.query(`
  SELECT
    pg_has_role('siton_worker_login', 'siton_worker_runtime', 'SET') AS worker_can_set_worker,
    pg_has_role('siton_worker_login', 'siton_worker_runtime', 'USAGE') AS worker_inherits_worker,
    pg_has_role('siton_worker_login', 'siton_web_runtime', 'SET') AS worker_can_set_web,
    pg_has_role('siton_web_login', 'siton_worker_runtime', 'SET') AS web_can_set_worker,
    (SELECT rolcanlogin FROM pg_roles WHERE rolname='siton_web_runtime') AS web_profile_login,
    (SELECT rolcanlogin FROM pg_roles WHERE rolname='siton_worker_runtime') AS worker_profile_login
`);
assert.equal(separation.rows[0].worker_can_set_worker, true);
assert.equal(separation.rows[0].worker_inherits_worker, false);
assert.equal(separation.rows[0].worker_can_set_web, false);
assert.equal(separation.rows[0].web_can_set_worker, false);
assert.equal(separation.rows[0].web_profile_login, false);
assert.equal(separation.rows[0].worker_profile_login, false);

// --- Worker readiness boots under the adopted Worker profile ---
const runtimeUrl = new URL(adminUrl);
runtimeUrl.searchParams.set("options", "-c role=siton_worker_runtime");
process.env.DATABASE_URL = runtimeUrl.toString();
process.env.CANONICAL_POSTGRES_RUNTIME = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const runtime = await import("../src/app.js");
await runtime.assertWorkerDatabaseReady();

// The Worker profile can operate the queue claim path (empty queue: no rows).
const claimed = await runtime.claimPendingOutboxBatch(1);
assert.deepEqual(claimed, []);

// Web readiness must refuse this Worker identity.
await assert.rejects(
  (async () => {
    const { assertCanonicalRuntimeReady } = await import("../src/runtime_database_boundary.js");
    const probePool = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    try {
      await assertCanonicalRuntimeReady(probePool, "web");
    } finally {
      await probePool.end();
    }
  })(),
  /canonical runtime role mismatch: expected siton_web_runtime/
);

await runtime.closeWorkerDatabase();
await (runtime as any).app.close();
await adminPool.end();
console.log("PASS R4 Worker login provisioning, separation and worker-profile readiness");
