#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
require("dotenv").config({ quiet: true });

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const STEPS = [
  { id: "release-static", command: [npmCommand, "run", "release:preflight:static"], timeoutMs: 30 * 60_000, purpose: "static production gates" },
  { id: "migrations-isolated", command: [npmCommand, "run", "test:migrations-isolated"], timeoutMs: 15 * 60_000, needsLocalDb: true, purpose: "isolated migration proof" },
  { id: "route-authorization", command: [npmCommand, "run", "ci:route-authorization"], timeoutMs: 20 * 60_000, needsLocalDb: true, purpose: "route authorization gate" },
  { id: "repository-tests", command: [npmCommand, "test"], timeoutMs: 90 * 60_000, needsLocalDb: true, purpose: "complete grouped repository tests" }
];

function printPlan() {
  console.log("SITON_VERIFY_PLAN version=2");
  for (const step of STEPS) console.log(`VERIFY_STEP id=${step.id} needs_local_db=${Boolean(step.needsLocalDb)} command=${step.command.join(" ")}`);
  console.log("VERIFY_BOUNDARY docker=false external_provider_calls=false real_money=false production_mutation=false");
}

function localDatabaseReady() {
  if (!process.env.DATABASE_URL) return { ok: false, reason: "DATABASE_URL is not set" };
  try {
    require("./lib/test_db_isolation.cjs").assertLocalBase(process.env.DATABASE_URL);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function runStep(step) {
  const startedAt = Date.now();
  console.log(`\nSITON_VERIFY_STEP_START id=${step.id}`);
  const result = spawnSync(step.command[0], step.command.slice(1), { stdio: "inherit", env: process.env, timeout: step.timeoutMs });
  const durationMs = Date.now() - startedAt;
  if (result.error) {
    console.error(`SITON_VERIFY_STEP_FAIL id=${step.id} duration_ms=${durationMs} reason=${result.error.message}`);
    return { id: step.id, status: "FAIL", durationMs, reason: result.error.message };
  }
  if (result.signal) {
    const reason = `signal ${result.signal}`;
    console.error(`SITON_VERIFY_STEP_FAIL id=${step.id} duration_ms=${durationMs} reason=${reason}`);
    return { id: step.id, status: "FAIL", durationMs, reason };
  }
  if (typeof result.status !== "number") {
    const reason = "missing exit status";
    console.error(`SITON_VERIFY_STEP_FAIL id=${step.id} duration_ms=${durationMs} reason=${reason}`);
    return { id: step.id, status: "FAIL", durationMs, reason };
  }
  if (result.status === 0) {
    console.log(`SITON_VERIFY_STEP_PASS id=${step.id} duration_ms=${durationMs}`);
    return { id: step.id, status: "PASS", durationMs };
  }
  const reason = `exit ${result.status}`;
  console.error(`SITON_VERIFY_STEP_FAIL id=${step.id} duration_ms=${durationMs} reason=${reason}`);
  return { id: step.id, status: "FAIL", durationMs, reason };
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--plan")) return printPlan();
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    console.error(`SITON_VERIFY_RESULT BLOCKED reason=Node_22_or_newer_required current=${process.versions.node}`);
    process.exit(2);
  }
  console.log(`SITON_VERIFY_START version=2 node=${process.versions.node}`);
  console.log("SITON_VERIFY_BOUNDARY no_Docker_no_external_provider_calls_no_real_money_no_production_mutation");
  const results = [];
  let dbReadiness = null;
  for (const step of STEPS) {
    if (step.needsLocalDb) {
      if (!dbReadiness) dbReadiness = localDatabaseReady();
      if (!dbReadiness.ok) {
        console.error(`SITON_VERIFY_RESULT BLOCKED reason=local_PostgreSQL_required detail=${JSON.stringify(dbReadiness.reason)}`);
        console.error("Use only a disposable local PostgreSQL DATABASE_URL. Hosted staging/production databases are refused.");
        process.exit(2);
      }
    }
    results.push(runStep(step));
  }
  const failures = results.filter((result) => result.status === "FAIL");
  console.log(`\nSITON_VERIFY_SUMMARY steps=${results.length} passed=${results.length - failures.length} failed=${failures.length}`);
  if (failures.length) {
    for (const failure of failures) console.error(`SITON_VERIFY_FAILED_STEP id=${failure.id} reason=${failure.reason}`);
    console.error("SITON_VERIFY_RESULT FAIL");
    process.exit(1);
  }
  console.log("SITON_VERIFY_RESULT PASS");
}

main();
