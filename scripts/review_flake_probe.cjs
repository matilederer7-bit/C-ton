#!/usr/bin/env node
/**
 * INDEPENDENT REVIEW — flake probe.
 *
 * Runs ONE test file N times, each against its own fresh database cloned from a
 * single migrated template, compiling only once. Built to answer "is this a
 * defect or a flake?" with a real sample instead of one lucky or unlucky run:
 * recompiling and re-migrating per run (what run_test_group does) makes ten
 * samples cost twenty minutes, which is why flake questions usually get
 * hand-waved instead of measured.
 *
 * On failure it captures the tail of the run so the timeout state is visible
 * rather than inferred.
 *
 * Usage:  node scripts/review_flake_probe.cjs <test-file.ts> [runs] [--keep-logs]
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
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
  const runs = Number(process.argv[3] || 10);
  const keepLogs = process.argv.includes("--keep-logs");
  if (!testFile) throw new Error("usage: node scripts/review_flake_probe.cjs <test-file.ts> [runs]");
  if (!fs.existsSync(path.join(process.cwd(), "tests", testFile))) throw new Error(`tests/${testFile} not found`);

  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required");
  const host = new URL(base).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error(`refusing non-local host ${host}`);

  console.log(`FLAKE_PROBE file=${testFile} runs=${runs}`);
  const compile = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.test.json"], {
    stdio: "inherit",
    env: process.env
  });
  if (compile.status !== 0) throw new Error(`TypeScript compilation failed: ${compile.status}`);

  const admin = new Client({ connectionString: databaseUrl(base, "postgres"), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  const suffix = `${process.pid}_${Date.now()}`;
  const templateName = `siton_test_template_probe_${suffix}`;
  const quote = (v) => `"${String(v).replace(/"/g, "\\")}"`;
  const compiled = path.join(".tmp_test_dist", "tests", testFile.replace(/\.ts$/, ".js"));
  const outDir = path.join(process.cwd(), ".review-artifacts", "flake-probe");
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  try {
    await admin.query(`CREATE DATABASE ${quote(templateName)}`);
    const templateUrl = databaseUrl(base, templateName);
    const migrate = spawnSync(process.execPath, ["scripts/run_migrations.cjs"], {
      stdio: "ignore",
      env: isolatedTestEnv({ DATABASE_URL: templateUrl })
    });
    if (migrate.status !== 0) throw new Error("template migration failed");
    if (fs.existsSync(path.join(process.cwd(), "scripts", "seed_test_prerequisites.cjs"))) {
      const seed = spawnSync(process.execPath, ["scripts/seed_test_prerequisites.cjs"], {
        stdio: "ignore",
        env: isolatedTestEnv({ DATABASE_URL: templateUrl })
      });
      if (seed.status !== 0) throw new Error("template prerequisite seed failed");
    }
    console.log(`template ready: ${templateName}`);

    for (let i = 1; i <= runs; i += 1) {
      const dbName = `siton_test_probe_${suffix}_${i}`;
      await admin.query(`CREATE DATABASE ${quote(dbName)} TEMPLATE ${quote(templateName)}`);
      const started = Date.now();
      const run = spawnSync(process.execPath, [compiled], {
        env: isolatedTestEnv({ DATABASE_URL: databaseUrl(base, dbName) }),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300000
      });
      const duration = Date.now() - started;
      const out = `${run.stdout || ""}\n${run.stderr || ""}`;
      const ok = run.status === 0;
      const failureLine = (out.match(/^Error: .*$/m) || out.match(/timeout waiting for: .*$/m) || [""])[0].trim();
      results.push({ run: i, ok, exit: run.status, duration_ms: duration, failure: ok ? null : failureLine.slice(0, 160) });
      console.log(`  run ${String(i).padStart(2)}  ${ok ? "PASS" : "FAIL"}  ${String(duration).padStart(6)}ms${ok ? "" : `  ${failureLine.slice(0, 120)}`}`);
      if (!ok || keepLogs) fs.writeFileSync(path.join(outDir, `${testFile.replace(/\.ts$/, "")}-run${i}-${ok ? "pass" : "fail"}.log`), out);
      await admin.query(`DROP DATABASE IF EXISTS ${quote(dbName)} WITH (FORCE)`).catch(() => undefined);
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(templateName)} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }

  const passed = results.filter((r) => r.ok).length;
  const durations = results.map((r) => r.duration_ms).sort((a, b) => a - b);
  fs.writeFileSync(
    path.join(outDir, `${testFile.replace(/\.ts$/, "")}-summary.json`),
    JSON.stringify({ generated_at: new Date().toISOString(), file: testFile, runs, passed, failed: runs - passed, results }, null, 2)
  );
  console.log(`\nFLAKE_PROBE_RESULT file=${testFile} passed=${passed}/${runs} failed=${runs - passed} median_ms=${durations[Math.floor(durations.length / 2)]} min_ms=${durations[0]} max_ms=${durations[durations.length - 1]}`);
  for (const row of results.filter((r) => !r.ok)) console.log(`  FAILED run ${row.run}: ${row.failure}`);
  process.exit(passed === runs ? 0 : 1);
}

main().catch((error) => {
  console.error(`FLAKE_PROBE_ERROR ${error?.message || error}`);
  process.exit(1);
});
