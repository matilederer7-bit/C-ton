import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

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

const roles = await adminPool.query(`
  SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls, rolinherit
  FROM pg_roles
  WHERE rolname IN ('siton_web_runtime','siton_worker_runtime')
  ORDER BY rolname
`);
assert.equal(roles.rowCount, 2);
for (const role of roles.rows) {
  assert.equal(role.rolsuper, false);
  assert.equal(role.rolcreatedb, false);
  assert.equal(role.rolcreaterole, false);
  assert.equal(role.rolcanlogin, false);
  assert.equal(role.rolreplication, false);
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolinherit, false);
}

const grants = await adminPool.query(`
  SELECT
    has_table_privilege('siton_web_runtime','siton.participants','SELECT') AS web_business_select,
    has_table_privilege('siton_web_runtime','siton.buyer_payment_methods','UPDATE') AS web_payment_method_upsert,
    has_table_privilege('siton_web_runtime','siton.deal_ticket_terms','UPDATE') AS web_ticket_terms_upsert,
    has_table_privilege('siton_web_runtime','siton.deal_voucher_terms','UPDATE') AS web_voucher_terms_upsert,
    has_table_privilege('siton_web_runtime','siton.invoice_document_attempts','UPDATE') AS web_invoice_attempt_upsert,
    has_table_privilege('siton_worker_runtime','siton.outbox_events','UPDATE') AS worker_outbox_update,
    has_table_privilege('siton_worker_runtime','siton.fulfillment_units','SELECT,INSERT') AS worker_fulfillment_issue,
    has_table_privilege('siton_worker_runtime','siton.invoice_document_attempts','UPDATE') AS worker_invoice_attempt_upsert,
    has_table_privilege('siton_worker_runtime','siton.seller_payout_attempts','UPDATE') AS worker_payout_attempt_upsert,
    has_table_privilege('siton_worker_runtime','siton.deals','INSERT') AS worker_deal_insert,
    has_table_privilege('siton_worker_runtime','siton.participants','INSERT') AS worker_participant_insert,
    has_table_privilege('siton_worker_runtime','siton.deal_images','DELETE') AS worker_image_delete,
    has_table_privilege('siton_worker_runtime','siton.notification_attempts','SELECT') AS worker_notification_attempt_read,
    has_table_privilege('siton_worker_runtime','siton.seller_sessions','SELECT') AS worker_seller_session_read,
    has_table_privilege('siton_web_runtime','siton_inventory.inventory_deals','SELECT') AS web_inventory_direct,
    has_table_privilege('siton_worker_runtime','siton_inventory.inventory_reservations','UPDATE') AS worker_inventory_direct,
    has_table_privilege('anon','siton.participants','SELECT') AS anon_business_direct,
    has_table_privilege('authenticated','siton_inventory.inventory_deals','SELECT') AS authenticated_inventory_direct,
    has_function_privilege('siton_web_runtime','public.siton_inventory_rpc(text,jsonb)','EXECUTE') AS web_rpc,
    has_function_privilege('siton_worker_runtime','public.siton_inventory_rpc(text,jsonb)','EXECUTE') AS worker_rpc,
    has_function_privilege('siton_web_runtime','siton.is_valid_action_name(text)','EXECUTE') AS web_trigger_helper,
    has_function_privilege('siton_worker_runtime','siton.require_action_name()','EXECUTE') AS worker_trigger_helper,
    has_function_privilege('siton_web_runtime','siton.audit_log_before_insert_enforce()','EXECUTE') AS web_trigger_body_direct,
    has_function_privilege('siton_worker_runtime','siton.participants_before_update_enforce()','EXECUTE') AS worker_trigger_body_direct
`);
assert.equal(grants.rows[0].web_business_select, true);
assert.equal(grants.rows[0].web_payment_method_upsert, true);
assert.equal(grants.rows[0].web_ticket_terms_upsert, true);
assert.equal(grants.rows[0].web_voucher_terms_upsert, true);
assert.equal(grants.rows[0].web_invoice_attempt_upsert, true);
assert.equal(grants.rows[0].worker_outbox_update, true);
assert.equal(grants.rows[0].worker_fulfillment_issue, true);
assert.equal(grants.rows[0].worker_invoice_attempt_upsert, true);
assert.equal(grants.rows[0].worker_payout_attempt_upsert, true);
assert.equal(grants.rows[0].worker_deal_insert, false);
assert.equal(grants.rows[0].worker_participant_insert, false);
assert.equal(grants.rows[0].worker_image_delete, false);
assert.equal(grants.rows[0].worker_notification_attempt_read, false);
assert.equal(grants.rows[0].worker_seller_session_read, false);
assert.equal(grants.rows[0].web_inventory_direct, false);
assert.equal(grants.rows[0].worker_inventory_direct, false);
assert.equal(grants.rows[0].anon_business_direct, false);
assert.equal(grants.rows[0].authenticated_inventory_direct, false);
assert.equal(grants.rows[0].web_rpc, true);
assert.equal(grants.rows[0].worker_rpc, true);
assert.equal(grants.rows[0].web_trigger_helper, true);
assert.equal(grants.rows[0].worker_trigger_helper, true);
assert.equal(grants.rows[0].web_trigger_body_direct, false);
assert.equal(grants.rows[0].worker_trigger_body_direct, false);

const runtimeUrl = new URL(adminUrl);
runtimeUrl.searchParams.set("options", "-c role=siton_web_runtime");
process.env.DATABASE_URL = runtimeUrl.toString();
process.env.CANONICAL_POSTGRES_RUNTIME = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const runtime = await import("../src/app.js");
const app = runtime.app;
const health = await app.inject({ method: "GET", url: "/health" });
assert.equal(health.statusCode, 200, health.body);
assert.deepEqual(health.json(), { ok: true });

const readiness = await app.inject({ method: "GET", url: "/readiness" });
assert.equal(readiness.statusCode, 200, readiness.body);
assert.deepEqual(readiness.json(), {
  ok: true,
  database: "connected",
  schema: "siton",
  inventory: "siton_inventory_rpc_v1",
  runtime_role: "siton_web_runtime"
});

const repositorySource = await readFile("src/inventory_repository.ts", "utf8");
assert.match(repositorySource, /public\.siton_inventory_rpc/);
assert.doesNotMatch(repositorySource, /base44|https?:\/\/|\bfetch\s*\(|\baxios\s*\(/i);
assert.doesNotMatch(repositorySource, /\b(CREATE|ALTER|DROP)\s+(TABLE|SCHEMA|FUNCTION|POLICY)\b/i);

await runtime.closeWorkerDatabase();
const unavailable = await app.inject({ method: "GET", url: "/readiness" });
assert.equal(unavailable.statusCode, 503, unavailable.body);
assert.deepEqual(unavailable.json(), { ok: false, code: "not_ready" });
assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);

await app.close();
await adminPool.end();
console.log("PASS canonical Postgres runtime boundary and Fastify health/readiness");
