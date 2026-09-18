// RED TEAM — RUNTIME ROLE ROUTE PRIVILEGES (Phase 2 §2.4)
//
// Production runs the Web process as siton_web_runtime: a NOLOGIN, NOINHERIT,
// non-superuser role that holds exactly the grants the canonical boundary gives
// it. Every other test in this repository connects as the owning superuser,
// because all 112 DB-touching suites read the same DATABASE_URL for both the
// application pool AND their own fixtures, and CI supplies the owner there.
//
// Measured, not assumed: running the whole suite twice against two identical
// databases — once as the owner, once as siton_web_runtime — 38 of 257 suites
// flip to "permission denied", every one of them inside the test's own fixture
// or cleanup code (deleteByKey, cleanupParticipant, cleanupKey), never inside a
// route. The product was fine; the harness was running with privileges the
// product never has. A route that needed a grant it did not hold would
// therefore be green in CI and 500 in production, and nothing here would say
// so. The canonical boundary suite asserts privileges on 20 named tables by
// hand, while src/*.ts touches 81.
//
// This gate closes that hole empirically instead of by static guesswork: it
// drives the REAL Fastify app over the REAL route table on a connection whose
// current_user is siton_web_runtime, and fails on any 42501. It needs no
// hand-maintained table list, so a route that starts touching a new table is
// covered the day it is written.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
const ADMIN_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const adminPool = new Pool({ connectionString: ADMIN_URL, max: 3 });

const PROBE_ROLE = "siton_web_privilege_probe";
const PROBE_PASSWORD = "siton_web_privilege_probe";

// The canonical boundary is defined by these files; 004/015 and the verify
// scripts touch Supabase's storage schema, which a plain PostgreSQL 16 does not
// have. Applying a file is best-effort for exactly that reason — what matters
// is the state afterwards, which is asserted below.
const BOUNDARY_FILES = [
  "001_siton_inventory_v1.sql", "006_canonical_postgres_runtime_boundary.sql",
  "007_runtime_role_admin_set_proof.sql", "008_runtime_trigger_helper_execute.sql",
  "009_runtime_function_public_fail_closed.sql", "010_r3_web_login_provisioning.sql",
  "011_r4_worker_login_provisioning.sql", "012_web_notification_enqueue.sql",
  "013_r6_viral_graph_grants.sql", "014_r6_worker_webhook_ingest.sql",
  "016_r8_admin_notification_attempts_read.sql", "017_r8_admin_payout_rail_read.sql",
  "018_p0_2_bindings_and_deal_delete.sql", "019_p0_3_chat_reactions_business_profiles.sql",
  "020_p0_4_field_change_audit.sql", "021_p0_5_support_messages.sql",
  "022_p0_7_seller_inquiries.sql", "023_receipt_content_grants.sql",
  "024_r9c_payment_lifecycle_grants.sql", "025_product_catalog_grants.sql",
  "026_distribution_link_viewer_grants.sql"
];

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error: any) { failed += 1; console.error(`FAIL ${name}: ${error?.message || error}`); }
}

function isPrivilegeError(body: string): boolean {
  return /permission denied|insufficient privilege|must be owner of|\b42501\b/i.test(body);
}

// Reading the response body is not enough, and proving that was worth the
// detour: driving this same sweep with a deliberately powerless role, only 1 of
// 142 routes leaked the words "permission denied" — every other one sanitised
// the failure into `{"ok":false,"error":"internal_error"}`, which is correct
// behaviour for a production error handler and useless for a gate that reads
// bodies. So the denial is captured where it actually happens: PostgreSQL
// raises SQLSTATE 42501, Fastify's onError hook sees the original error, and
// nothing downstream can hide it.
const privilegeErrors: string[] = [];
function recordPrivilegeError(where: string, error: any) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  if (code === "42501" || /permission denied|insufficient privilege|must be owner of/i.test(message)) {
    privilegeErrors.push(`${where}: ${message.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}
function takePrivilegeErrors(): string[] {
  const taken = privilegeErrors.slice();
  privilegeErrors.length = 0;
  return taken;
}

// ── Build the production-shaped connection ──────────────────────────────────
await adminPool.query(`
  DO $roles$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END
  $roles$;
`);
const applyFailures: string[] = [];
for (const file of BOUNDARY_FILES) {
  try {
    await adminPool.query(await readFile(`supabase/staging/${file}`, "utf8"));
  } catch (error: any) {
    applyFailures.push(`${file}: ${String(error?.message || error).split("\n")[0]}`);
  }
}

const database = new URL(ADMIN_URL).pathname.replace(/^\//, "");
await adminPool.query(`
  DO $probe$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PROBE_ROLE}') THEN
      CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}';
    END IF;
  END
  $probe$;
`);
await adminPool.query(`ALTER ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}'`);
await adminPool.query(`GRANT siton_web_runtime TO ${PROBE_ROLE}`);
// The login role INHERITS nothing (siton_web_runtime is NOINHERIT); the session
// becomes the runtime role the same way production does it.
await adminPool.query(`ALTER ROLE ${PROBE_ROLE} IN DATABASE ${database} SET role = 'siton_web_runtime'`);
await adminPool.query(`GRANT CONNECT ON DATABASE ${database} TO ${PROBE_ROLE}`);

const probeUrl = new URL(ADMIN_URL);
probeUrl.username = PROBE_ROLE;
probeUrl.password = PROBE_PASSWORD;

// The app reads DATABASE_URL at import time, so it must be set BEFORE the
// dynamic import below. Nothing else in this file uses it.
process.env.DATABASE_URL = probeUrl.toString();
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

app.addHook("onError", async (req: any, _reply: any, error: any) => {
  recordPrivilegeError(`${req.method} ${req.url}`, error);
});

try {
  await run("the application pool really runs as the non-superuser runtime role", async () => {
    if (applyFailures.length) console.log(`  (boundary files skipped: ${applyFailures.join(" | ")})`);
    const who = await pool.query(
      "SELECT current_user, session_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser");
    assert.equal(who.rows[0].current_user, "siton_web_runtime",
      `the probe must run as siton_web_runtime, not ${who.rows[0].current_user} — otherwise this whole gate proves nothing`);
    assert.equal(who.rows[0].session_user, PROBE_ROLE);
    assert.equal(who.rows[0].superuser, false, "the runtime role must never be a superuser");
  });

  // The one column the canonical boundary makes write-only for the Web runtime.
  await run("the seller bank account number stays unreadable by the Web runtime", async () => {
    const r = await adminPool.query(
      `SELECT has_column_privilege('siton_web_runtime','siton.seller_business_profiles','bank_account_number','SELECT') AS readable,
              has_column_privilege('siton_web_runtime','siton.seller_business_profiles','bank_account_last4','SELECT') AS last4`);
    assert.equal(r.rows[0].readable, false, "bank_account_number must not be SELECTable by the Web runtime");
    assert.equal(r.rows[0].last4, true, "...while the masked last4 the seller UI shows remains readable");
  });

  // ── The sweep ─────────────────────────────────────────────────────────────
  // Every GET route the app actually registers, driven on the runtime
  // connection. Routes that answer 401/403/404 still exercise whatever SQL runs
  // before the guard; a missing grant surfaces as 42501 either way.
  await run("no registered GET route hits a missing grant as siton_web_runtime", async () => {
    await app.ready();
    const lines = app.printRoutes({ commonPrefix: false }).split("\n");
    const stack: { depth: number; seg: string }[] = [];
    const routes: { path: string; methods: string[] }[] = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const depth = (raw.match(/^[\s│]*/) as RegExpMatchArray)[0].length;
      const m = raw.match(/(?:[├└]──\s|^)([^\s(]*)\s*(?:\(([^)]*)\))?\s*$/);
      if (!m) continue;
      while (stack.length && (stack[stack.length - 1] as any).depth >= depth) stack.pop();
      stack.push({ depth, seg: m[1] ?? "" });
      if (m[2]) routes.push({ path: stack.map((s) => s.seg).join(""), methods: m[2].split(",").map((s) => s.trim()) });
    }
    assert.ok(routes.length > 100, `expected the real route table, saw ${routes.length} routes`);

    const placeholder = "00000000-0000-4000-8000-000000000000";
    const denied: string[] = [];
    let swept = 0;
    for (const route of routes) {
      if (!route.methods.includes("GET")) continue;
      const url = "/" + route.path
        .replace(/:[a-zA-Z0-9_]+(\|:[a-zA-Z0-9_]+)*/g, placeholder)
        .replace(/\*/g, "index.html")
        .replace(/^\/+/, "");
      if (url.startsWith("/preview")) continue;
      swept += 1;
      const res = await app.inject({ method: "GET", url, headers: { "x-request-id": `privilege-sweep-${swept}` } });
      if (isPrivilegeError(String(res.body || ""))) denied.push(`GET ${url} -> ${res.statusCode}: ${String(res.body).replace(/\s+/g, " ").slice(0, 200)}`);
      for (const hooked of takePrivilegeErrors()) denied.push(hooked);
    }
    console.log(`  (swept ${swept} GET routes as siton_web_runtime)`);
    assert.deepEqual(denied, [],
      `these routes need a grant the Web runtime does not hold — green in CI as the owner, 500 in production:\n  ${denied.join("\n  ")}`);
  });

  await run("the seller deal lifecycle runs end to end as siton_web_runtime", async () => {
    // The densest write path in the product: create, publish, chat, delete.
    // Seeded through the ADMIN pool, exercised through the runtime pool.
    const unique = `privilege-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const denied: string[] = [];
    const call = async (method: any, url: string, payload?: unknown) => {
      const res = await app.inject({
        method, url,
        headers: { "x-request-id": `${unique}-${url}`, "idempotency-key": `${unique}-${url}`.slice(0, 160).replace(/[^A-Za-z0-9:_-]/g, "-") },
        ...(payload ? { payload } : {})
      });
      if (isPrivilegeError(String(res.body || ""))) denied.push(`${method} ${url} -> ${res.statusCode}: ${String(res.body).replace(/\s+/g, " ").slice(0, 200)}`);
      for (const hooked of takePrivilegeErrors()) denied.push(hooked);
      return res;
    };

    const created = await call("POST", "/deals", {
      title: `Privilege probe ${unique}`,
      price_per_unit: 40, min_units: 2, max_units: 10,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Pickup — Herzl 12, Tel Aviv", cost: 0 }]
    });
    assert.equal(created.statusCode, 200, `deal create as the runtime role: ${created.body.slice(0, 200)}`);
    const dealId = (created.json() as any).deal_id;

    // Publish needs a complete seller profile; seed it as the owner so the
    // route itself is what gets exercised, not the fixture.
    const sellerId = (await adminPool.query("SELECT seller_id FROM siton.deals WHERE deal_id=$1", [dealId])).rows[0].seller_id;
    await adminPool.query(
      `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_phone, support_email)
       VALUES ($1,'Privilege Probe','Privilege Probe','0501234567','privilege-probe@example.invalid')
       ON CONFLICT (seller_id) DO UPDATE SET business_name=EXCLUDED.business_name,
         support_phone=EXCLUDED.support_phone, support_email=EXCLUDED.support_email`, [sellerId]);

    await call("POST", `/deals/${dealId}/publish`, {
      seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true });
    await call("GET", `/deals/${dealId}`);
    await call("GET", `/api/deals/${dealId}/public`);
    await call("GET", `/api/deals/${dealId}/chat`);
    await call("POST", `/api/deals/${dealId}/chat`, { body: "privilege probe" });
    await call("GET", `/api/deals/${dealId}/activity`);
    await call("GET", `/api/deals/${dealId}/receipt-info`);
    await call("DELETE", `/deals/${dealId}`);

    assert.deepEqual(denied, [],
      `the seller lifecycle needs grants the Web runtime does not hold:\n  ${denied.join("\n  ")}`);
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  await adminPool.end().catch(() => undefined);
}

if (failed) {
  console.error(`FAILED ${failed} runtime role privilege checks`);
  process.exit(1);
}
console.log("All runtime role privilege checks passed.");
