#!/usr/bin/env node
// Single owner command (npm run release:owner-check).
//
// Runs the release preflight (standard profile unless --profile is given, or
// --reuse to read the latest report for this SHA), generates the manifest and
// the checklist, and prints ONE concise answer:
//
//   SITON RELEASE READINESS
//   Repository: CLEAN | DIRTY
//   Build / Tests / Migrations / Security / Docker / Staging / Real money
//   Open launch decisions: N
//   READY FOR CODE DEPLOY: YES/NO
//   READY FOR REAL MONEY: NO
//
// Detail is never hidden: the full reports are named at the end.
const fs = require("node:fs");
const path = require("node:path");
const { runSync } = require("./lib/run_command.cjs");
const { describeGit } = require("./lib/git_info.cjs");
const policyLib = require("./lib/runtime_environment_policy.cjs");
const { artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const reuse = args.includes("--reuse");

function readJson(rel) { const file = path.join(artifactsDir(root), path.basename(rel)); if (!fs.existsSync(file)) return null; try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function rollup(items, ids) {
  const picked = items.filter((item) => ids.includes(item.id));
  if (!picked.length) return "NOT CHECKED";
  if (picked.some((item) => item.status === "FAIL")) return "FAIL";
  if (picked.every((item) => item.status === "SKIPPED_ENVIRONMENT")) return "SKIPPED (unavailable here)";
  if (picked.some((item) => item.status === "WARNING")) return "PASS (with warnings)";
  if (picked.some((item) => item.status === "SKIPPED_ENVIRONMENT")) return "PASS (partly unavailable here)";
  return "PASS";
}

function main() {
  const git = describeGit(root);
  const profile = option("--profile", "standard");
  let preflight = readJson(".release-artifacts/release-preflight.json");
  if (!reuse || !preflight || !preflight.meta || preflight.meta.sha !== git.sha) {
    console.log("Running release preflight (" + profile + ")... this takes several minutes.\n");
    const run = runSync("node", [path.join(root, "scripts", "release_preflight.cjs"), "--profile", profile], { cwd: root, stdio: "inherit", timeout: 3 * 60 * 60 * 1000 });
    if (run.error) console.log("preflight runner error: " + run.error.message);
    preflight = readJson(".release-artifacts/release-preflight.json");
  }
  runSync("node", [path.join(root, "scripts", "release_manifest.cjs")], { cwd: root, stdio: "ignore" });
  const checklist = runSync("node", [path.join(root, "scripts", "release_checklist.cjs")], { cwd: root, encoding: "utf8" });
  const checklistJson = readJson(".release-artifacts/release-checklist.json");
  const realMoney = policyLib.loadRealMoneyPolicy(root);
  const items = (preflight && preflight.items) || [];
  const build = rollup(items, ["typescript", "build-demo", "reproducible-build", "mobile-pwa-gate"]);
  const tests = rollup(items, ["release-tools-tests", "route-authorization-behavioural", "payment-tests", "security-tests", "lint-backend-enforcement", "architecture-gate", "base44-canonical-integrity"]);
  const migrations = rollup(items, ["migration-preflight", "migration-preflight-static", "runtime-ddl-scan", "backup-restore-rehearsal"]);
  const security = rollup(items, ["payment-compliance-scan", "legal-compliance", "secret-pii-scan", "logging-hygiene", "route-inventory", "http-security-smoke", "runtime-environment-policy", "startup-config-matrix", "no-real-money-proof", "health-contract"]);
  const docker = rollup(items, ["docker-readiness-static", "release-local-lab"]);
  // Technical readiness never includes the governance ACTIVATION item; real
  // money is answered from the policy file, never from a green test run.
  const technicalItems = items.filter((item) => !(item.evidence && item.evidence.category === "ACTIVATION"));
  const failures = technicalItems.filter((item) => item.status === "FAIL");
  const readiness = (preflight && preflight.meta && preflight.meta.readiness) || null;
  const technical = readiness ? readiness.technical : preflight ? preflight.overall : "NOT RUN";
  const openDecisions = checklistJson ? checklistJson.totals.open : "?";
  const readyForCodeDeploy = preflight && failures.length === 0 && !git.dirty;
  const lines = [
    "",
    "SITON RELEASE READINESS",
    "",
    "Commit:              " + git.short_sha + " (" + git.branch + ")",
    "Repository:          " + (git.dirty ? "DIRTY (" + git.dirty_entry_count + " uncommitted entries)" : "CLEAN"),
    "Build:               " + build,
    "Tests:               " + tests,
    "Migrations:          " + migrations,
    "Security:            " + security,
    "Docker:              " + docker,
    "Staging deployment:  NOT CHECKED (hosted; see docs/DEPLOYMENT_RUNBOOK.md)",
    "Technical readiness: " + technical + (preflight ? " (" + technicalItems.length + " gates, " + failures.length + " failing, " + technicalItems.filter((item) => item.status === "SKIPPED_ENVIRONMENT").length + " not provable here)" : ""),
    "Real money:          " + (realMoney.real_money_allowed ? "ALLOWED" : "BLOCKED") + " (" + (realMoney.blocking_reasons || []).filter((r) => !r.cleared).length + " blocking reasons: " + (realMoney.blocking_reasons || []).filter((r) => !r.cleared).map((r) => r.id).join(", ") + ")",
    "Open launch decisions: " + openDecisions,
    "",
    "READY FOR CODE DEPLOY: " + (readyForCodeDeploy ? "YES (preflight " + technical + ", profile " + preflight.meta.profile + ")" : "NO" + (!preflight ? " (no preflight report)" : failures.length ? " (" + failures.length + " failing gates: " + failures.map((f) => f.id).join(", ") + ")" : git.dirty ? " (working tree is dirty; commit or stash first)" : "")),
    "READY FOR REAL MONEY:  " + (realMoney.real_money_allowed ? "YES (governance ALLOWED - verify evidence)" : "NO (BLOCKED by governance; a green technical preflight does not change this)"),
    "",
    "Reports: " + path.relative(root, artifactsDir(root)).split(path.sep).join("/") + "/release-preflight.md, release-manifest.md, release-checklist.md; per-gate logs in the preflight/ subfolder",
    ""
  ];
  console.log(lines.join("\n"));
  console.log("RELEASE_OWNER_CHECK code_deploy=" + (readyForCodeDeploy ? "YES" : "NO") + " real_money=" + (realMoney.real_money_allowed ? "ALLOWED" : "NO") + " technical=" + technical + " preflight=" + (preflight ? preflight.overall : "NONE") + " checklist_exit=" + checklist.status);
  process.exit(readyForCodeDeploy || (preflight && failures.length === 0) ? 0 : 1);
}

main();
