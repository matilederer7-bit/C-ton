const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const GROUPS = ["unit", "integration", "db", "api", "workers", "payments", "security", "concurrency", "failure", "e2e"];

function isolatedTestEnv(overrides = {}) {
  const env = { ...process.env, ...overrides, NODE_ENV: "test", DISABLE_OUTBOX_WORKER: "1" };
  delete env.RENDER;
  delete env.RENDER_EXTERNAL_URL;
  delete env.APP_ENV;
  return env;
}

function classify(name) {
  if (/concurrency|load_capacity|scale_readiness/.test(name)) return "concurrency";
  if (/payment|refund|invoice|payout|money_tax|platform_fee|provider_|webhook/.test(name)) return "payments";
  if (/worker|outbox|notification|operational_hardening/.test(name)) return "workers";
  if (/security|auth|otp|legal|debug_surface|rate_limiter|server_side_money_authority/.test(name)) return "security";
  if (/adversarial|preprod_torture|failure|fault/.test(name)) return "failure";
  if (/e2e|full_|ultimate|mvp_|demo_|docker_|aws_|frontend_browser|production_launch/.test(name)) return "e2e";
  if (/state_engine|atomicity|database|db_|charging_completion|participant_delivery_snapshot/.test(name)) return "db";
  if (/frontend_foundation|cache_policy|json_boundary|spec_drift|read_surfaces|product_surfaces|deal_types_validation/.test(name)) return "unit";
  if (/backend_sanity|real_integrations|join_flow|remaining_product|master_product|deal_images|deal_chat|deal_duplicate|buyer_recovery|tracking|delivery|seller_|admin_|mission_control|support_operations/.test(name)) return "api";
  return "integration";
}

function databaseUrl(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function main() {
  const suiteStartedAt = Date.now();
  const requested = process.argv[2] || "all";
  if (requested !== "all" && !GROUPS.includes(requested)) throw new Error(`Unknown test group: ${requested}`);
  const files = readdirSync(path.join(process.cwd(), "tests"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => ({ name, group: classify(name.replace(/\.ts$/, "")) }));
  const selected = (requested === "all" ? files : files.filter((item) => item.group === requested))
    .sort((left, right) => GROUPS.indexOf(left.group) - GROUPS.indexOf(right.group) || left.name.localeCompare(right.name));
  console.log(`TEST_INVENTORY total=${files.length} selected=${selected.length} group=${requested}`);
  for (const group of GROUPS) console.log(`TEST_GROUP ${group} count=${files.filter((item) => item.group === group).length}`);

  if (requested === "all") {
    const failedGroups = [];
    for (const group of GROUPS) {
      const groupStartedAt = Date.now();
      console.log(`\nTEST_ALL_GROUP_START group=${group}`);
      const result = spawnSync(process.execPath, [__filename, group], {
        stdio: "inherit",
        env: process.env,
        timeout: 30 * 60_000
      });
      if (result.status === 0) {
        console.log(`TEST_ALL_GROUP_PASS group=${group} duration_ms=${Date.now() - groupStartedAt}`);
      } else {
        const reason = result.error ? result.error.message : `exit ${result.status}`;
        failedGroups.push({ group, reason });
        console.error(`TEST_ALL_GROUP_FAIL group=${group} duration_ms=${Date.now() - groupStartedAt} reason=${reason}`);
      }
    }
    console.log(`\nTEST_SUMMARY group=all files=${files.length} groups_passed=${GROUPS.length - failedGroups.length} groups_failed=${failedGroups.length} duration_ms=${Date.now() - suiteStartedAt}`);
    for (const failure of failedGroups) console.error(`FAILED_GROUP ${failure.group}: ${failure.reason}`);
    process.exit(failedGroups.length ? 1 : 0);
  }

  const compile = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.test.json"], { stdio: "inherit", env: process.env });
  if (compile.status !== 0) throw compile.error || new Error(`TypeScript compilation failed: ${compile.status}`);

  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is required for isolated database tests");
  const admin = new Client({ connectionString: databaseUrl(baseUrl, "postgres"), connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await admin.connect();
  const suffix = `${process.pid}_${Date.now()}`;
  const templateName = `siton_test_template_${suffix}`;
  const quoteIdentifier = (value) => `"${String(value).replace(/"/g, "\\")}"`;
  const dropDatabase = async (name) => admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
  const failures = [];

  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(templateName)}`);
    const templateUrl = databaseUrl(baseUrl, templateName);
    const bootstrap = spawnSync(process.execPath, ["scripts/run_migrations.cjs"], {
      stdio: "inherit",
      env: isolatedTestEnv({ DATABASE_URL: templateUrl })
    });
    if (bootstrap.status !== 0) throw bootstrap.error || new Error(`Test DB migration failed: ${bootstrap.status}`);
    const prerequisites = spawnSync(process.execPath, ["scripts/seed_test_prerequisites.cjs"], {
      stdio: "inherit",
      env: isolatedTestEnv({ DATABASE_URL: templateUrl })
    });
    if (prerequisites.status !== 0) throw prerequisites.error || new Error(`Test prerequisite seed failed: ${prerequisites.status}`);

    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      const testDb = `siton_test_${suffix}_${index}`;
      const compiled = path.join(".tmp_test_dist", "tests", item.name.replace(/\.ts$/, ".js"));
      console.log(`\nTEST_START group=${item.group} file=${item.name}`);
      const testStartedAt = Date.now();
      try {
        await admin.query(`CREATE DATABASE ${quoteIdentifier(testDb)} TEMPLATE ${quoteIdentifier(templateName)}`);
        const testTimeoutMs = item.name === "frontend_browser_smoke_validation.ts"
          ? 900000
          : item.name === "web_sigterm_fault_process_validation.ts"
            ? 600000
            : 180000;
        const result = spawnSync(process.execPath, [compiled], {
          stdio: "inherit",
          env: isolatedTestEnv({ DATABASE_URL: databaseUrl(baseUrl, testDb) }),
          timeout: testTimeoutMs
        });
        if (result.status === 0) console.log(`TEST_PASS file=${item.name} duration_ms=${Date.now() - testStartedAt}`);
        else {
          const reason = result.error ? result.error.message : `exit ${result.status}`;
          failures.push({ file: item.name, reason });
          console.error(`TEST_FAIL file=${item.name} duration_ms=${Date.now() - testStartedAt} reason=${reason}`);
        }
      } finally {
        await dropDatabase(testDb);
      }
    }
  } finally {
    await dropDatabase(templateName).catch(() => undefined);
    await admin.end();
  }

  console.log(`\nTEST_SUMMARY group=${requested} passed=${selected.length - failures.length} failed=${failures.length} duration_ms=${Date.now() - suiteStartedAt}`);
  for (const failure of failures) console.error(`FAILED ${failure.file}: ${failure.reason}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
