#!/usr/bin/env node
/**
 * INDEPENDENT REVIEW — A/B driver.
 *
 * Compiles the tree and runs ONE test file against a freshly migrated,
 * disposable database, using the same isolation contract as
 * scripts/run_test_group.cjs. It exists so that the same reviewer-authored
 * counterexample can be executed on BOTH sides of an A/B:
 *
 *   BEFORE  a detached checkout of canonical master (no R9C payment rails)
 *   AFTER   the review branch (master + the R9C integration candidate)
 *
 * The counterexample asserts the SAFE behaviour, so it must FAIL on the
 * BEFORE tree and PASS on the AFTER tree. Nothing here is specific to either
 * tree: it only needs `tests/<file>` and this repository's migration runner.
 *
 * Usage:  node scripts/review_ab_driver.cjs <test-file.ts> [--keep]
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

function databaseUrl(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function isolatedTestEnv(overrides = {}) {
  const env = { ...process.env, ...overrides, NODE_ENV: "test", DISABLE_OUTBOX_WORKER: "1" };
  delete env.RENDER;
  delete env.RENDER_EXTERNAL_URL;
  delete env.APP_ENV;
  return env;
}

async function main() {
  const testFile = process.argv[2];
  const keep = process.argv.includes("--keep");
  if (!testFile) throw new Error("usage: node scripts/review_ab_driver.cjs <test-file.ts>");
  if (!fs.existsSync(path.join(process.cwd(), "tests", testFile))) {
    throw new Error(`tests/${testFile} does not exist in ${process.cwd()}`);
  }

  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required");
  const host = new URL(base).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`refusing to run against non-local host ${host}`);
  }

  console.log(`AB_DRIVER tree=${process.cwd()} test=${testFile}`);
  const compile = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.test.json"], {
    stdio: "inherit",
    env: process.env
  });
  if (compile.status !== 0) throw new Error(`TypeScript compilation failed: ${compile.status}`);

  const admin = new Client({ connectionString: databaseUrl(base, "postgres"), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  const dbName = `siton_test_ab_${process.pid}_${Date.now()}`;
  const quote = (value) => `"${String(value).replace(/"/g, "\\")}"`;
  let status = 1;
  try {
    await admin.query(`CREATE DATABASE ${quote(dbName)}`);
    const testUrl = databaseUrl(base, dbName);
    const migrate = spawnSync(process.execPath, ["scripts/run_migrations.cjs"], {
      stdio: "inherit",
      env: isolatedTestEnv({ DATABASE_URL: testUrl })
    });
    if (migrate.status !== 0) throw new Error(`migrations failed: ${migrate.status}`);
    if (fs.existsSync(path.join(process.cwd(), "scripts", "seed_test_prerequisites.cjs"))) {
      const seed = spawnSync(process.execPath, ["scripts/seed_test_prerequisites.cjs"], {
        stdio: "inherit",
        env: isolatedTestEnv({ DATABASE_URL: testUrl })
      });
      if (seed.status !== 0) throw new Error(`prerequisite seed failed: ${seed.status}`);
    }

    const compiled = path.join(".tmp_test_dist", "tests", testFile.replace(/\.ts$/, ".js"));
    const run = spawnSync(process.execPath, [compiled], {
      stdio: "inherit",
      env: isolatedTestEnv({ DATABASE_URL: testUrl }),
      timeout: 300000
    });
    status = run.status === null ? 124 : run.status;
    console.log(`\nAB_RESULT tree=${path.basename(process.cwd())} test=${testFile} exit=${status} ${status === 0 ? "PASS" : "FAIL"}`);
  } finally {
    if (!keep) await admin.query(`DROP DATABASE IF EXISTS ${quote(dbName)} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
  process.exit(status);
}

main().catch((error) => {
  console.error(`AB_DRIVER_ERROR ${error?.message || error}`);
  process.exit(1);
});
