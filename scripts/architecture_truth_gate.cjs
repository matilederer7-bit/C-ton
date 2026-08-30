const fs = require("node:fs");
const path = require("node:path");

function assert(condition, message) {
  if (!condition) throw new Error(`ARCHITECTURE_GATE_FAIL ${message}`);
}

assert(fs.existsSync("base44/config.jsonc"), "base44/config.jsonc missing");
assert(fs.existsSync("base44/runtime-manifest.json"), "canonical runtime manifest missing");
assert(fs.existsSync("base44/functions/siton-worker-tick/function.jsonc"), "Base44 scheduled worker missing");
assert(!fs.existsSync("Procfile"), "root Procfile must remain quarantined");
assert(fs.existsSync("legacy/render/render.legacy.yaml"), "legacy Render evidence missing");

// R3: the root render.yaml is the canonical staging blueprint (Web only).
// It must stay secret-free, health-check /readiness and target the canonical
// Postgres runtime. Legacy Render artifacts remain quarantined under legacy/.
assert(fs.existsSync("render.yaml"), "R3 canonical Render blueprint missing");
const renderBlueprint = fs.readFileSync("render.yaml", "utf8");
assert(/healthCheckPath:\s*\/readiness/.test(renderBlueprint), "Render blueprint must health-check /readiness");
assert(/-\s*key:\s*DATABASE_URL\s*\n\s*sync:\s*false/.test(renderBlueprint), "DATABASE_URL must be an external Render secret (sync: false)");
assert(!/postgres(?:ql)?:\/\/\S*@/.test(renderBlueprint), "Render blueprint must not embed a database credential");
assert(/CANONICAL_POSTGRES_RUNTIME/.test(renderBlueprint), "Render blueprint must enable the canonical Postgres runtime");
assert(!/base44/i.test(renderBlueprint), "Render blueprint must not reference Base44");
assert(!/type:\s*worker/i.test(renderBlueprint), "continuous Worker deployment is R4, not part of the R3 blueprint");
const requiredClosureDocs = [
  "docs/CANONICAL_ARCHITECTURE_V1.md",
  "docs/FINAL_ZERO_DEVELOPMENT_CLOSURE.md",
  "docs/SYNTHETIC_MONEY_PROOF.md",
  "docs/GROW_PAYMENTS_INTEGRATION_READINESS.md",
  "docs/MOBILE_APP_RELEASE_READINESS.md",
  "docs/EXTERNAL_ACTIVATION_CHECKLIST.md",
];
for (const documentPath of requiredClosureDocs) {
  assert(fs.existsSync(documentPath), `closure document missing: ${documentPath}`);
}
const runtime = JSON.parse(fs.readFileSync("base44/runtime-manifest.json", "utf8"));
assert(runtime.production_runtime === "base44", "production runtime is not Base44");
assert(runtime.scheduled_worker === "siton-worker-tick", "scheduled worker ownership unclear");
const automation = fs.readFileSync("base44/functions/siton-worker-tick/function.jsonc", "utf8");
assert(automation.includes('"cron_expression": "*/5 * * * *"'), "worker automation is not scheduled at the supported five-minute interval");
const forbiddenRoot = fs
  .readdirSync(".")
  .filter((name) => /^render(?:\.|$)/i.test(name) && name !== "render.yaml");
assert(forbiddenRoot.length === 0, `Render artifacts left at repository root: ${forbiddenRoot.join(",")}`);
const r2Files = [
  "src/inventory_repository.ts",
  "src/runtime_database_boundary.ts",
  "supabase/staging/006_canonical_postgres_runtime_boundary.sql",
  "supabase/staging/007_runtime_role_admin_set_proof.sql",
  "supabase/staging/008_runtime_trigger_helper_execute.sql",
  "supabase/staging/009_runtime_function_public_fail_closed.sql",
  "docs/R2_RUNTIME_PERMISSION_AUDIT.md",
  "docs/ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md"
];
for (const filePath of r2Files) assert(fs.existsSync(filePath), `R2 artifact missing: ${filePath}`);

const r3Files = [
  "render.yaml",
  "src/api_route_aliases.ts",
  "supabase/staging/010_r3_web_login_provisioning.sql",
  "scripts/r3_hosted_proof.cjs",
  "docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md"
];
for (const filePath of r3Files) assert(fs.existsSync(filePath), `R3 artifact missing: ${filePath}`);

const loginProvisioningSql = fs.readFileSync("supabase/staging/010_r3_web_login_provisioning.sql", "utf8");
assert(/CREATE ROLE siton_web_login LOGIN NOINHERIT/.test(loginProvisioningSql), "R3 login principal is not a plain NOINHERIT LOGIN role");
assert(/GRANT siton_web_runtime TO siton_web_login WITH SET TRUE, INHERIT FALSE/.test(loginProvisioningSql), "R3 login membership is not SET-only");
assert(/ALTER ROLE siton_web_login SET role = 'siton_web_runtime'/.test(loginProvisioningSql), "R3 login sessions do not default to the audited Web profile");
assert(!/password\s+'/i.test(loginProvisioningSql), "R3 login provisioning must never contain a password literal");
assert(!/siton_worker_login/.test(loginProvisioningSql), "Worker LOGIN provisioning belongs to R4");

const inventoryRepository = fs.readFileSync("src/inventory_repository.ts", "utf8");
const appSource = fs.readFileSync("src/app.ts", "utf8");
const workerSource = fs.readFileSync("src/worker.ts", "utf8");
const boundarySql = fs.readFileSync("supabase/staging/006_canonical_postgres_runtime_boundary.sql", "utf8");
const adminSetSql = fs.readFileSync("supabase/staging/007_runtime_role_admin_set_proof.sql", "utf8");
const triggerHelperSql = fs.readFileSync("supabase/staging/008_runtime_trigger_helper_execute.sql", "utf8");
const functionFailClosedSql = fs.readFileSync("supabase/staging/009_runtime_function_public_fail_closed.sql", "utf8");
assert(inventoryRepository.includes("public.siton_inventory_rpc"), "inventory repository is not canonical RPC-backed");
assert(!/base44|https?:\/\/|\bfetch\s*\(|\baxios\s*\(/i.test(inventoryRepository), "inventory repository contains an external bridge");
assert(appSource.includes("buildInventoryRepository(c)"), "Fastify Join does not use the internal inventory repository");
assert(appSource.includes('app.get("/readiness"'), "Fastify readiness route missing");
assert(workerSource.includes('createRuntimePool("worker", 2)'), "Worker database boundary is not explicit");
assert(/CREATE ROLE siton_web_runtime NOLOGIN NOINHERIT/.test(boundarySql), "Web access profile is not NOLOGIN");
assert(/CREATE ROLE siton_worker_runtime NOLOGIN NOINHERIT/.test(boundarySql), "Worker access profile is not NOLOGIN");
assert(!/FOR ALL TO siton_(?:web|worker)_runtime/.test(boundarySql), "runtime RLS policies must be operation-specific");
assert(/REVOKE ALL ON SCHEMA siton, siton_inventory FROM anon, authenticated/.test(boundarySql), "browser schema access is not fail-closed");
assert(/WITH SET TRUE, INHERIT FALSE/.test(adminSetSql), "administrative SET ROLE proof is not non-inheriting");
assert(/siton\.is_valid_action_name\(text\)/.test(triggerHelperSql), "trigger helper execution surface missing");
assert(!/GRANT EXECUTE ON ALL FUNCTIONS/.test(triggerHelperSql), "trigger helper execution surface is not operation-specific");
assert(/REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton\s+FROM PUBLIC, anon, authenticated/.test(functionFailClosedSql), "siton functions are not fail-closed on clean replay");

console.log("ARCHITECTURE_GATE_PASS production=base44 worker=siton-worker-tick render=r3_staging_web target_inventory=canonical_postgres");
