#!/usr/bin/env node
// Architecture truth gate — asserts the runtime Siton actually has:
//
//   Render web service `siton-staging-web`  +  Render background worker
//   `siton-staging-worker`  +  Supabase PostgreSQL (schema `siton`).
//
// Binding source: docs/CURRENT_ARCHITECTURE_2026-09-30.md. Base44 is history,
// never a runtime; this gate rejects any blueprint, doc or inventory boundary
// that names it again.
//
// The gate is static (no network, no database) and fails closed: every
// assertion throws `ARCHITECTURE_GATE_FAIL <reason>`. It is a module so that
// tests/release_tools/architecture_truth_gate.test.cjs can run it against a
// mutated copy of the repository; `node scripts/architecture_truth_gate.cjs`
// runs it against the working directory.
//
// What it keeps from the R2/R3/R4 rebases (unchanged assertions):
//   R2 — internal Postgres inventory boundary, NOLOGIN runtime profiles,
//        operation-specific RLS, browser schema access fail-closed, SET-only
//        admin membership, trigger-helper execution surface, functions
//        revoked from PUBLIC/anon/authenticated on clean replay.
//   R3 — root render.yaml is the only Render artifact, /readiness health check,
//        external DATABASE_URL, no embedded credential, canonical Postgres
//        runtime flag, siton_web_login provisioning (NOINHERIT, SET-only,
//        audited default role, no password literal, no worker role).
//   R4 — exactly one Background Worker, started as the built Node entrypoint
//        (never npm as PID 1), RUNTIME_ROLE=worker.
// What it adds: exactly one web + one worker with their canonical names, same
// branch / trigger / image on both, single instance each, role separation (web
// disables the outbox worker, worker runs it), secrets never inline in the
// blueprint, the mock provider and PAYMENT_ENVIRONMENT=demo pinned in the
// blueprint, the internal-ledger payout provider pinned and no real payout
// mode / endpoint / key through the blueprint (a fail-closed parser rejects
// every shape it does not know: another indentation, flow style, a second
// top-level block, a second envVars block, the legacy env: alias, an env
// source other than value / sync / generateValue, a duplicated key), the worker LOGIN
// provisioning, the Dockerfile/package entrypoint parity, the migration
// manifest ⇄ schema contract parity, the architecture SoT naming the real
// runtime and not Base44, and a scan of every code tree for a Base44 SDK call
// or the Base44 token (the one live check the retired Base44 integrity gate
// performed).
const fs = require("node:fs");
const path = require("node:path");

const CANONICAL_WEB = "siton-staging-web";
const CANONICAL_WORKER = "siton-staging-worker";
const WORKER_ENTRYPOINT = "node .demo_dist/src/worker.js";
const WEB_ENTRYPOINT = "node .demo_dist/src/app.js";
const SECRET_KEY = /(SECRET|_KEY$|TOKEN|DSN|SALT|PASSWORD|DATABASE_URL)/;

// Base44 SDK shapes (entity CRUD, function invoke, client construction) must
// not come back anywhere in the code trees; the bare token must not come back
// in the runtime, shell, scripts, web app or workflows (tests keep negative
// guards that name it, so they are scanned for the SDK shapes only).
const LEGACY_SDK_PATTERNS = [
  /@base44\//,
  /createClientFromRequest/,
  /createClient\(\s*\{\s*appId/,
  /\.entities\.[A-Za-z_]+\.(?:list|filter|get|create|update|delete|bulkCreate|bulkUpdate)\(/,
  /\.entities\s*\[\s*["'][A-Za-z_]+["']\s*\]/,
  /\bbase44\.(?:functions|entities|auth|integrations)\b/
];
// `supabase.functions.invoke(...)` is the canonical stack's own Edge Function
// call and is deliberately NOT matched.
const LEGACY_SDK_TREES = ["src", "frontend", "scripts", "tests", "web", ".github"];
const LEGACY_TOKEN_TREES = ["src", "frontend", "scripts", "web", ".github"];
const LEGACY_TOKEN_ROOT_FILES = ["package.json", "Dockerfile", "docker-compose.yml", "docker-compose.release-lab.yml", ".dockerignore"];
const CODE_FILE = /\.(?:cjs|mjs|js|jsx|ts|tsx|mts|cts|json|jsonc|ya?ml|html|sh|ps1|toml)$/;
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", ".tmp_test_dist", ".demo_dist", ".mobile_dist", "dist", "build", "coverage"]);
const SELF_RELATIVE = "scripts/architecture_truth_gate.cjs";

function walkCode(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SCAN_SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkCode(full);
    return CODE_FILE.test(entry.name) ? [full] : [];
  });
}

// Files the gate reads, relative to the repository root. Exported so the gate
// test can copy exactly this surface into a scratch repository.
const GATE_INPUT_FILES = [
  "render.yaml",
  "Dockerfile",
  "package.json",
  "src/app.ts",
  "src/worker.ts",
  "src/db.ts",
  "src/production_guards.ts",
  "src/schema_contract.ts",
  "src/inventory_repository.ts",
  "src/runtime_database_boundary.ts",
  "src/api_route_aliases.ts",
  "scripts/migration_manifest.cjs",
  "scripts/r3_hosted_proof.cjs",
  "supabase/staging/006_canonical_postgres_runtime_boundary.sql",
  "supabase/staging/007_runtime_role_admin_set_proof.sql",
  "supabase/staging/008_runtime_trigger_helper_execute.sql",
  "supabase/staging/009_runtime_function_public_fail_closed.sql",
  "supabase/staging/010_r3_web_login_provisioning.sql",
  "supabase/staging/011_r4_worker_login_provisioning.sql",
  "docs/CURRENT_ARCHITECTURE_2026-09-30.md",
  "docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md",
  "docs/DEPLOYMENT_RUNBOOK.md",
  "docs/R2_RUNTIME_PERMISSION_AUDIT.md",
  "docs/ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md",
  "docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md"
];
// plus every file the migration manifest names (src/migrations/*.sql).

function fail(message) {
  throw new Error(`ARCHITECTURE_GATE_FAIL ${message}`);
}
function assert(condition, message) {
  if (!condition) fail(message);
}

// Fail-closed reader for the blueprint's `services:` list. It accepts exactly
// the shape render.yaml uses (two-space list items, four-space service keys,
// `- key:` env entries with value / sync / generateValue) and REJECTS anything
// else: a service written with another indentation or in flow style, a second
// top-level block (`databases:`), an env entry in flow style or with a
// `fromDatabase` / `fromService` source, a duplicated env key. Full-line
// comments and blank lines are ignored, so a comment explaining a rule never
// trips it; a trailing ` # comment` on a value is stripped, as are matching
// single or double quotes.
function parseBlueprintServices(text) {
  const services = [];
  let service = null;
  let env = null;
  let inServices = false;
  const lines = text.split(/\r?\n/);
  const unquote = (raw) => {
    let v = String(raw).replace(/\s+#.*$/, "").trim();
    const m = /^(["'])(.*)\1$/.exec(v);
    return m ? m[2] : v;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    const where = `render.yaml:${index + 1}`;
    let m;
    if (/^services:\s*$/.test(line)) {
      assert(!inServices, `${where}: duplicate services: block`);
      inServices = true;
      continue;
    }
    if (/^\S/.test(line)) fail(`${where}: the blueprint may declare only the services: block (found ${line.trim()})`);
    assert(inServices, `${where}: content before the services: block`);
    if ((m = /^  - type:\s*(\S+)\s*$/.exec(line))) {
      // The env list and bookkeeping live under names no YAML key can
      // collide with (`\w+` never matches a `$`).
      service = { type: unquote(m[1]), $env: [], $envKeys: new Set(), $sawEnvVars: false };
      services.push(service);
      env = null;
      continue;
    }
    assert(service, `${where}: a service must start with \`  - type:\` (found ${line.trim()})`);
    if ((m = /^    (\w+):\s*(.*?)\s*$/.exec(line))) {
      if (m[1] === "envVars") {
        assert(!service.$sawEnvVars, `${where}: duplicate envVars block on ${service.type} ${service.name || ""}`);
        assert(m[2] === "", `${where}: envVars must be a plain block (found envVars: ${m[2]})`);
        service.$sawEnvVars = true;
        env = service.$env;
        continue;
      }
      assert(!Object.prototype.hasOwnProperty.call(service, m[1]), `${where}: duplicate service key ${m[1]}`);
      assert(m[1] !== "env", `${where}: the legacy env: alias is not accepted; declare runtime: docker`);
      env = null;
      assert(m[2] !== "", `${where}: service key ${m[1]} without an inline value is not a blueprint shape this gate accepts`);
      service[m[1]] = unquote(m[2]);
      continue;
    }
    if (env && (m = /^      - key:\s*(\S+)\s*$/.exec(line))) {
      const key = unquote(m[1]);
      assert(!service.$envKeys.has(key), `${where}: duplicate env key ${key} on ${service.type} ${service.name || ""}`);
      service.$envKeys.add(key);
      env.push({ key });
      continue;
    }
    if (env && env.length && (m = /^        (\w+):\s*(.*?)\s*$/.exec(line))) {
      assert(["value", "sync", "generateValue"].includes(m[1]), `${where}: env source ${m[1]} is not accepted (only value, sync: false or generateValue: true)`);
      assert(!(m[1] in env[env.length - 1]), `${where}: duplicate ${m[1]} on env key ${env[env.length - 1].key}`);
      env[env.length - 1][m[1]] = unquote(m[2]);
      continue;
    }
    fail(`${where}: unrecognised blueprint line (${line.trim()}); the gate accepts only the canonical two-space list shape`);
  }
  assert(inServices, "render.yaml declares no services: block");
  return services;
}

function envOf(service, key) {
  return service.$env.find((entry) => entry.key === key) || null;
}

function runArchitectureGate(root = process.cwd()) {
  const at = (relative) => path.join(root, relative);
  const exists = (relative) => fs.existsSync(at(relative));
  const read = (relative) => fs.readFileSync(at(relative), "utf8");

  // ── Repository root: the blueprint is the only Render artifact ──────────
  assert(!exists("Procfile"), "root Procfile must remain quarantined");
  const forbiddenRoot = fs.readdirSync(root).filter((name) => /^render(?:\.|$)/i.test(name) && name !== "render.yaml");
  assert(forbiddenRoot.length === 0, `Render artifacts left at repository root: ${forbiddenRoot.join(",")}`);

  // ── R3/R4 + current truth: render.yaml declares exactly web + worker ────
  assert(exists("render.yaml"), "R3 canonical Render blueprint missing");
  const renderBlueprint = read("render.yaml");
  assert(/healthCheckPath:\s*\/readiness/.test(renderBlueprint), "Render blueprint must health-check /readiness");
  assert(/-\s*key:\s*DATABASE_URL\s*\n\s*sync:\s*false/.test(renderBlueprint), "DATABASE_URL must be an external Render secret (sync: false)");
  assert(!/postgres(?:ql)?:\/\/\S*@/.test(renderBlueprint), "Render blueprint must not embed a database credential");
  assert(/CANONICAL_POSTGRES_RUNTIME/.test(renderBlueprint), "Render blueprint must enable the canonical Postgres runtime");
  assert(!/base44/i.test(renderBlueprint), "Render blueprint must not reference Base44");
  const workerDeclarations = (renderBlueprint.match(/type:\s*worker/gi) || []).length;
  assert(workerDeclarations === 1, `the staging blueprint must declare exactly one Background Worker (found ${workerDeclarations})`);
  assert(/dockerCommand:\s*node \.demo_dist\/src\/worker\.js/.test(renderBlueprint), `the Background Worker must start \`${WORKER_ENTRYPOINT}\` directly`);
  const renderDirectives = renderBlueprint.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
  assert(!/npm\s+run\s+start:(?:web|worker):prod/.test(renderDirectives), "the hosted blueprint must never start a runtime through npm: npm as PID 1 swallows the platform stop signal and the Node drain handler never runs");
  assert(/value:\s*worker\b/.test(renderBlueprint), "the Background Worker must declare RUNTIME_ROLE=worker");

  const typeDirectives = (renderDirectives.match(/^\s*-?\s*type\s*:/gm) || []).length;
  assert(typeDirectives === 2, `the blueprint must declare exactly two services, web + worker (found ${typeDirectives} type: directives)`);
  const services = parseBlueprintServices(renderBlueprint);
  assert(services.length === 2, `the blueprint must declare exactly two services, web + worker (found ${services.length})`);
  const webServices = services.filter((s) => s.type === "web");
  const workerServices = services.filter((s) => s.type === "worker");
  assert(webServices.length === 1, `the blueprint must declare exactly one web service (found ${webServices.length})`);
  assert(workerServices.length === 1, `the blueprint must declare exactly one worker service (found ${workerServices.length})`);
  const web = webServices[0];
  const worker = workerServices[0];
  assert(web.name === CANONICAL_WEB, `the web service must be named ${CANONICAL_WEB} (found ${web.name})`);
  assert(worker.name === CANONICAL_WORKER, `the worker service must be named ${CANONICAL_WORKER} (found ${worker.name})`);
  for (const service of services) {
    const label = `${service.type} ${service.name}`;
    assert(service.runtime === "docker", `${label} must run the Docker image (runtime: docker)`);
    assert(service.dockerfilePath === "./Dockerfile", `${label} must build from the root Dockerfile`);
    assert(service.branch === "master", `${label} must deploy branch master (found ${service.branch})`);
    assert(service.autoDeployTrigger === "checksPass", `${label} must deploy only after the GitHub checks pass (autoDeployTrigger: checksPass, found ${service.autoDeployTrigger})`);
    assert(service.region === "frankfurt", `${label} must stay in region frankfurt next to the Supabase eu-central-1 database (found ${service.region})`);
    for (const scalingKey of ["numInstances", "scaling", "autoscaling"]) assert(!(scalingKey in service), `${label} must stay a single instance (no ${scalingKey}): the worker's lease model and the free web plan assume one process each`);
    const canonicalRuntime = envOf(service, "CANONICAL_POSTGRES_RUNTIME");
    assert(canonicalRuntime && canonicalRuntime.value === "1", `${label} must set CANONICAL_POSTGRES_RUNTIME=1`);
    const deploymentMode = envOf(service, "APP_DEPLOYMENT_MODE");
    assert(deploymentMode && /^(staging|production)$/.test(deploymentMode.value || ""), `${label} must declare a hosted APP_DEPLOYMENT_MODE (staging|production), never demo`);
    const databaseUrl = envOf(service, "DATABASE_URL");
    assert(databaseUrl && databaseUrl.sync === "false" && databaseUrl.value === undefined, `${label} DATABASE_URL must be an external secret (sync: false, no inline value)`);
    for (const entry of service.$env) {
      if (!SECRET_KEY.test(entry.key)) continue;
      assert(entry.value === undefined && (entry.sync === "false" || entry.generateValue === "true"), `${label} must never carry ${entry.key} inline: secrets are sync: false or generateValue: true`);
    }
    const paymentEnvironment = envOf(service, "PAYMENT_ENVIRONMENT");
    assert(paymentEnvironment && paymentEnvironment.value === "demo", `${label} must keep PAYMENT_ENVIRONMENT=demo in the checked-in blueprint (found ${paymentEnvironment && paymentEnvironment.value}); real-money activation is a separate governed change, never a blueprint edit`);
    const paymentProvider = envOf(service, "PAYMENT_PROVIDER");
    assert(paymentProvider && paymentProvider.value === "mockpay", `${label} must keep the mock payment provider in the checked-in blueprint`);
    const payoutProvider = envOf(service, "PAYOUT_PROVIDER");
    assert(payoutProvider && payoutProvider.value === "internal-ledger", `${label} must keep PAYOUT_PROVIDER=internal-ledger in the checked-in blueprint`);
    const payoutMode = envOf(service, "PAYOUT_PROVIDER_MODE");
    assert(!payoutMode || payoutMode.value === "internal-truth-only", `${label} must not switch payouts to a real provider through the blueprint (PAYOUT_PROVIDER_MODE); activation is a separate governed change`);
    for (const payoutKey of ["PAYOUT_PROVIDER_BASE_URL", "PAYOUT_PROVIDER_API_KEY"]) assert(!envOf(service, payoutKey), `${label} must not carry ${payoutKey}: the checked-in blueprint never addresses a real payout provider`);
  }
  // Role separation: the web service answers HTTP and never runs the outbox
  // worker; the worker runs it and nothing else.
  assert(web.healthCheckPath === "/readiness", "the web service health check must be /readiness");
  assert(web.dockerCommand === undefined || web.dockerCommand === WEB_ENTRYPOINT, `the web service must start the image CMD (${WEB_ENTRYPOINT}), found ${web.dockerCommand}`);
  const webRole = envOf(web, "RUNTIME_ROLE");
  assert(webRole && webRole.value === "web", "the web service must declare RUNTIME_ROLE=web");
  const webOutbox = envOf(web, "DISABLE_OUTBOX_WORKER");
  assert(webOutbox && webOutbox.value === "1", "the web service must set DISABLE_OUTBOX_WORKER=1 (only the Background Worker drains the outbox)");
  assert(worker.dockerCommand === WORKER_ENTRYPOINT, `the worker service must start exactly \`${WORKER_ENTRYPOINT}\``);
  const workerRole = envOf(worker, "RUNTIME_ROLE");
  assert(workerRole && workerRole.value === "worker", "the worker service must declare RUNTIME_ROLE=worker");
  assert(!envOf(worker, "DISABLE_OUTBOX_WORKER"), "the worker service must not disable the outbox worker");
  assert(worker.healthCheckPath === undefined, "a background worker has no HTTP health check");

  // ── Image and package entrypoints agree with the blueprint ──────────────
  const dockerfile = read("Dockerfile");
  assert(/^FROM node:/m.test(dockerfile), "the image must build from an official node base");
  assert(/^CMD \["node", "\.demo_dist\/src\/app\.js"\]\s*$/m.test(dockerfile), `the image CMD must be the Node web entrypoint (${WEB_ENTRYPOINT})`);
  assert(!/^CMD \["npm"/m.test(dockerfile), "npm must not be PID 1 in the image (it swallows the stop signal)");
  const packageJson = JSON.parse(read("package.json"));
  assert(packageJson.scripts["start:web:prod"] === WEB_ENTRYPOINT, "package.json start:web:prod must name the same web entry file as the image CMD");
  assert(packageJson.scripts["start:worker:prod"] === WORKER_ENTRYPOINT, "package.json start:worker:prod must name the same worker entry file as the blueprint");

  // ── Runtime role separation inside src/ ─────────────────────────────────
  const appSource = read("src/app.ts");
  const workerSource = read("src/worker.ts");
  const guardsSource = read("src/production_guards.ts");
  const dbSource = read("src/db.ts");
  assert(appSource.includes('app.get("/readiness"'), "Fastify readiness route missing");
  assert(appSource.includes("buildInventoryRepository(c)"), "Fastify Join does not use the internal inventory repository");
  assert(workerSource.includes('createRuntimePool("worker", 2)'), "Worker database boundary is not explicit");
  assert(/assertProductionRuntimeGuards/.test(workerSource), "the worker must run the production runtime guards at boot");
  assert(/RUNTIME_ROLE is required in production/.test(guardsSource), "production guards must require RUNTIME_ROLE");
  assert(/cannot start the \$\{role\} process/.test(guardsSource), "production guards must refuse a process whose RUNTIME_ROLE names the other role");
  assert(/production web requires DISABLE_OUTBOX_WORKER=1/.test(guardsSource), "production guards must keep the outbox worker off the web process");
  assert(/RUNTIME_ROLE/.test(dbSource) && /"worker"/.test(dbSource), "the database layer must pick its runtime profile from RUNTIME_ROLE");

  // ── Supabase PostgreSQL: migration manifest ⇄ schema contract ───────────
  assert(exists("src/schema_contract.ts"), "schema contract missing");
  const schemaContract = read("src/schema_contract.ts");
  assert(/export const REQUIRED_TABLES\s*=/.test(schemaContract), "schema contract must export REQUIRED_TABLES");
  const requiredIdsBlock = /export const REQUIRED_MIGRATION_IDS\s*=\s*\[([\s\S]*?)\]/.exec(schemaContract);
  assert(requiredIdsBlock, "schema contract must export REQUIRED_MIGRATION_IDS");
  const requiredIds = [...requiredIdsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert(requiredIds.length > 0, "REQUIRED_MIGRATION_IDS is empty");
  assert(exists("scripts/migration_manifest.cjs"), "migration manifest missing");
  const manifestEntries = [...read("scripts/migration_manifest.cjs").matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => ({ id: m[1], filename: m[2] }));
  assert(manifestEntries.length > 0, "migration manifest declares no migrations");
  const manifestIds = new Set(manifestEntries.map((entry) => entry.id));
  for (const id of requiredIds) assert(manifestIds.has(id), `REQUIRED_MIGRATION_IDS names ${id}, which the migration manifest does not declare`);
  for (const entry of manifestEntries) assert(exists(`src/migrations/${entry.filename}`), `migration manifest names a missing file: ${entry.filename}`);
  const newest = manifestEntries[manifestEntries.length - 1].id;
  assert(requiredIds.includes(newest), `the newest migration (${newest}) must be in REQUIRED_MIGRATION_IDS so /readiness fails closed without it`);

  // ── R2 / R3 / R4 artifacts and assertions (unchanged) ───────────────────
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
  for (const filePath of r2Files) assert(exists(filePath), `R2 artifact missing: ${filePath}`);
  const r3Files = [
    "render.yaml",
    "src/api_route_aliases.ts",
    "supabase/staging/010_r3_web_login_provisioning.sql",
    "scripts/r3_hosted_proof.cjs",
    "docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md"
  ];
  for (const filePath of r3Files) assert(exists(filePath), `R3 artifact missing: ${filePath}`);

  const loginProvisioningSql = read("supabase/staging/010_r3_web_login_provisioning.sql");
  assert(/CREATE ROLE siton_web_login LOGIN NOINHERIT/.test(loginProvisioningSql), "R3 login principal is not a plain NOINHERIT LOGIN role");
  assert(/GRANT siton_web_runtime TO siton_web_login WITH SET TRUE, INHERIT FALSE/.test(loginProvisioningSql), "R3 login membership is not SET-only");
  assert(/ALTER ROLE siton_web_login SET role = 'siton_web_runtime'/.test(loginProvisioningSql), "R3 login sessions do not default to the audited Web profile");
  assert(!/password\s+'/i.test(loginProvisioningSql), "R3 login provisioning must never contain a password literal");
  assert(!/siton_worker_login/.test(loginProvisioningSql), "Worker LOGIN provisioning belongs to R4");

  assert(exists("supabase/staging/011_r4_worker_login_provisioning.sql"), "R4 worker login provisioning missing");
  const workerProvisioningSql = read("supabase/staging/011_r4_worker_login_provisioning.sql");
  assert(/CREATE ROLE siton_worker_login LOGIN NOINHERIT/.test(workerProvisioningSql), "R4 worker login principal is not a plain NOINHERIT LOGIN role");
  assert(/GRANT siton_worker_runtime TO siton_worker_login WITH SET TRUE, INHERIT FALSE/.test(workerProvisioningSql), "R4 worker login membership is not SET-only");
  assert(/ALTER ROLE siton_worker_login SET role = 'siton_worker_runtime'/.test(workerProvisioningSql), "R4 worker login sessions do not default to the audited Worker profile");
  assert(!/password\s+'/i.test(workerProvisioningSql), "R4 worker login provisioning must never contain a password literal");

  const inventoryRepository = read("src/inventory_repository.ts");
  const boundarySql = read("supabase/staging/006_canonical_postgres_runtime_boundary.sql");
  const adminSetSql = read("supabase/staging/007_runtime_role_admin_set_proof.sql");
  const triggerHelperSql = read("supabase/staging/008_runtime_trigger_helper_execute.sql");
  const functionFailClosedSql = read("supabase/staging/009_runtime_function_public_fail_closed.sql");
  assert(inventoryRepository.includes("public.siton_inventory_rpc"), "inventory repository is not canonical RPC-backed");
  assert(!/base44|https?:\/\/|\bfetch\s*\(|\baxios\s*\(/i.test(inventoryRepository), "inventory repository contains an external bridge");
  assert(/CREATE ROLE siton_web_runtime NOLOGIN NOINHERIT/.test(boundarySql), "Web access profile is not NOLOGIN");
  assert(/CREATE ROLE siton_worker_runtime NOLOGIN NOINHERIT/.test(boundarySql), "Worker access profile is not NOLOGIN");
  assert(!/FOR ALL TO siton_(?:web|worker)_runtime/.test(boundarySql), "runtime RLS policies must be operation-specific");
  assert(/REVOKE ALL ON SCHEMA siton, siton_inventory FROM anon, authenticated/.test(boundarySql), "browser schema access is not fail-closed");
  assert(/WITH SET TRUE, INHERIT FALSE/.test(adminSetSql), "administrative SET ROLE proof is not non-inheriting");
  assert(/siton\.is_valid_action_name\(text\)/.test(triggerHelperSql), "trigger helper execution surface missing");
  assert(!/GRANT EXECUTE ON ALL FUNCTIONS/.test(triggerHelperSql), "trigger helper execution surface is not operation-specific");
  assert(/REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton\s+FROM PUBLIC, anon, authenticated/.test(functionFailClosedSql), "siton functions are not fail-closed on clean replay");

  // ── Architecture source of truth names the real runtime, not Base44 ─────
  for (const documentPath of ["docs/CURRENT_ARCHITECTURE_2026-09-30.md", "docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md", "docs/DEPLOYMENT_RUNBOOK.md"]) {
    assert(exists(documentPath), `architecture source-of-truth document missing: ${documentPath}`);
  }
  const architectureDoc = read("docs/CURRENT_ARCHITECTURE_2026-09-30.md");
  assert(/Render web \+ Render worker \+ Supabase PostgreSQL/.test(architectureDoc), "the architecture SoT must state the runtime as Render web + Render worker + Supabase PostgreSQL");
  assert(/Base44\*{0,2} is historical/.test(architectureDoc), "the architecture SoT must state that Base44 is historical");
  assert(!/production_runtime\s*[:=]\s*"?base44/i.test(architectureDoc), "the architecture SoT must never certify Base44 as the production runtime");

  // ── No Base44 SDK call or token anywhere in the code trees ───────────────
  const relativeOf = (file) => path.relative(root, file).replace(/\\/g, "/");
  for (const tree of LEGACY_SDK_TREES) {
    for (const file of walkCode(at(tree))) {
      if (relativeOf(file) === SELF_RELATIVE) continue;
      const source = fs.readFileSync(file, "utf8");
      const hit = LEGACY_SDK_PATTERNS.find((pattern) => pattern.test(source));
      assert(!hit, `Base44 SDK usage in ${relativeOf(file)} (${hit}): Base44 is historical, never a runtime`);
    }
  }
  const tokenFiles = [...LEGACY_TOKEN_TREES.flatMap((tree) => walkCode(at(tree))), ...LEGACY_TOKEN_ROOT_FILES.map(at).filter((file) => fs.existsSync(file))];
  for (const file of tokenFiles) {
    if (relativeOf(file) === SELF_RELATIVE) continue;
    assert(!/base44/i.test(fs.readFileSync(file, "utf8")), `Base44 reference in ${relativeOf(file)}: Base44 is historical, never a runtime`);
  }

  return {
    banner: `ARCHITECTURE_GATE_PASS runtime=render_web+render_worker+supabase_postgres web=${web.name} worker=${worker.name} deploy=checksPass target_inventory=canonical_postgres migrations=${manifestEntries.length}`
  };
}

module.exports = { runArchitectureGate, parseBlueprintServices, GATE_INPUT_FILES, CANONICAL_WEB, CANONICAL_WORKER };

if (require.main === module) {
  try {
    console.log(runArchitectureGate(process.cwd()).banner);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}
