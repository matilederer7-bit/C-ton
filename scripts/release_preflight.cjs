#!/usr/bin/env node
// Release preflight (npm run release:preflight).
//
// ONE canonical command that orchestrates the existing gates without
// duplicating their logic. Every gate in config/release-preflight-gates.json
// is run as a child process, its log captured to
// .release-artifacts/preflight/<id>.log, and its verdict derived from the
// exit code and output markers:
//   PASS | FAIL | WARNING | SKIPPED_ENVIRONMENT
// plus ONE governance item, real-money-activation, whose verdict is BLOCKED
// under config/real-money-release-policy.json and is reported APART from
// technical readiness (TECHNICAL_READINESS vs REAL_MONEY_ACTIVATION). Gates in
// the catalogue that the profile / --only / --skip leave out are
// NOT_APPLICABLE and listed, never counted as proven.
// Exit code is non-zero only on FAIL. SKIPPED_ENVIRONMENT is never PASS.
//
//   --profile static|standard|full   (default standard)
//   --only id,id                     run a subset
//   --skip id,id                     skip gates
//   --continue                       keep going after a FAIL (default: yes)
//   --stop-on-fail                   stop at the first FAIL
//
// The summary always prints REAL_MONEY: BLOCKED/ALLOWED from the release
// governance file, independent of any test result.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runSync } = require("./lib/run_command.cjs");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");
const { classifyFailure, formatClassification } = require("./lib/flake_classifier.cjs");
const { describeGit } = require("./lib/git_info.cjs");
const policyLib = require("./lib/runtime_environment_policy.cjs");
const isolation = require("./lib/test_db_isolation.cjs");

const root = process.cwd();
require("dotenv").config({ quiet: true });

function parseArgs(argv) {
  const args = { profile: "standard", only: null, skip: new Set(), stopOnFail: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--profile") args.profile = argv[++index];
    else if (item === "--only") args.only = new Set(String(argv[++index]).split(",").map((s) => s.trim()).filter(Boolean));
    else if (item === "--skip") for (const id of String(argv[++index]).split(",")) args.skip.add(id.trim());
    else if (item === "--stop-on-fail") args.stopOnFail = true;
  }
  return args;
}

function environmentCapabilities() {
  const caps = { db: false, pgtools: false, docker: false, network: true };
  try { if (process.env.DATABASE_URL) { isolation.assertLocalBase(process.env.DATABASE_URL); caps.db = true; } } catch { caps.db = false; }
  const pgDump = spawnSync(process.platform === "win32" ? "where" : "which", ["pg_dump"], { encoding: "utf8" });
  caps.pgtools = pgDump.status === 0 || (process.platform === "win32" && [18, 17, 16, 15].some((v) => fs.existsSync("C:/Program Files/PostgreSQL/" + v + "/bin/pg_dump.exe"))) || Boolean(process.env.PG_BIN);
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  caps.docker = docker.status === 0 && Boolean(String(docker.stdout || "").trim());
  return caps;
}

function runGate(gate, logDir) {
  const started = Date.now();
  const [command, ...args] = gate.command;
  const result = runSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: gate.timeout_ms || 300000,
    env: { ...process.env, DOTENV_CONFIG_QUIET: "true", CI: process.env.CI || "" }
  });
  const output = String(result.stdout || "") + (result.stderr ? "\n--- stderr ---\n" + String(result.stderr) : "");
  fs.writeFileSync(path.join(logDir, gate.id + ".log"), output);
  const duration_ms = Date.now() - started;
  const timedOut = result.error && /ETIMEDOUT/.test(String(result.error.message || result.error.code));
  const status = result.status === null ? (result.error ? 1 : 0) : result.status;
  const has = (markers) => (markers || []).some((marker) => new RegExp(marker).test(output));
  let verdict;
  let summary;
  if (timedOut) { verdict = "FAIL"; summary = "timed out after " + Math.round((gate.timeout_ms || 300000) / 1000) + "s"; }
  else if (status !== 0) {
    const classification = classifyFailure(output + (result.error ? "\n" + result.error.message : ""));
    verdict = classification.kind === "ENVIRONMENT_FAILURE" ? "SKIPPED_ENVIRONMENT" : "FAIL";
    summary = "exit " + status + " (" + formatClassification(classification) + ")";
    if (verdict === "SKIPPED_ENVIRONMENT") summary = "could not run here: " + classification.signals.map((s) => s.id).join(",") + " (" + classification.signals.map((s) => s.hint).join("; ") + ")";
  } else if (has(gate.skip_markers) || /overall=SKIPPED_ENVIRONMENT/.test(output)) { verdict = "SKIPPED_ENVIRONMENT"; summary = "reported SKIPPED_ENVIRONMENT (could not be proven on this machine)"; }
  else if (has(gate.warn_markers) || /overall=WARNING/.test(output)) { verdict = "WARNING"; summary = "passed with warnings"; }
  else { verdict = "PASS"; summary = "ok"; }
  const tail = output.trim().split(/\r?\n/).filter((line) => /_PASS|_FAIL|SUMMARY|WARNING|SKIPPED|overall=|REAL_MONEY|MIGRATION_PREFLIGHT|BLOCKED|ALLOWED/.test(line)).slice(-6).join("\n");
  return { verdict, summary, duration_ms, detail: (verdict === "PASS" ? "" : tail || output.trim().split(/\r?\n/).slice(-15).join("\n")), log: path.join(path.relative(root, logDir), gate.id + ".log") };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, "config", "release-preflight-gates.json"), "utf8"));
  if (!catalogue.profiles[args.profile]) { console.error("unknown profile " + args.profile + "; known: " + Object.keys(catalogue.profiles).join(", ")); process.exit(2); }
  const caps = environmentCapabilities();
  const git = describeGit(root);
  const realMoney = policyLib.loadRealMoneyPolicy(root);
  // overall / counts / exit code are TECHNICAL readiness: the governance
  // ACTIVATION item is listed and reported separately (never hidden, never
  // mixed in).
  const report = new ReleaseReport("release preflight", { meta: { profile: args.profile, sha: git.sha, branch: git.branch, dirty: git.dirty, node: process.versions.node, capabilities: caps }, overallFilter: (item) => !(item.evidence && item.evidence.category === "ACTIVATION") });
  const logDir = path.join(artifactsDir(root), "preflight");
  fs.mkdirSync(logDir, { recursive: true });
  console.log("RELEASE_PREFLIGHT profile=" + args.profile + " sha=" + git.short_sha + " branch=" + git.branch + " dirty=" + git.dirty + " db=" + caps.db + " pgtools=" + caps.pgtools + " docker=" + caps.docker);
  console.log("");

  const selected = catalogue.gates.filter((gate) => gate.profiles.includes(args.profile) && (!args.only || args.only.has(gate.id)) && !args.skip.has(gate.id));
  // Gates in the catalogue that this run deliberately does not execute are
  // NOT_APPLICABLE (profile, --only, --skip). They are listed, never counted
  // as proven and never hidden.
  const notApplicable = catalogue.gates.filter((gate) => !selected.includes(gate)).map((gate) => ({
    id: gate.id,
    category: gate.category,
    reason: args.skip.has(gate.id) ? "--skip" : args.only && !args.only.has(gate.id) ? "not in --only" : "not in profile " + args.profile
  }));
  report.meta.not_applicable = notApplicable;
  const byCategory = {};
  for (const gate of selected) {
    const needs = gate.needs || "none";
    if ((needs === "db" && !caps.db) || (needs === "pgtools" && (!caps.db || !caps.pgtools)) || (needs === "docker" && !caps.docker)) {
      report.skip(gate.id, "needs " + needs + " (not available on this machine)", { evidence: { category: gate.category, blocked_by: "environment:" + needs } });
      byCategory[gate.category] = byCategory[gate.category] || [];
      byCategory[gate.category].push({ id: gate.id, status: "SKIPPED_ENVIRONMENT" });
      continue;
    }
    process.stdout.write("... " + gate.id.padEnd(34));
    const result = runGate(gate, logDir);
    process.stdout.write("\r");
    const record = report.add({ id: gate.id, status: result.verdict, summary: result.summary + (gate.note ? " - " + gate.note : ""), duration_ms: result.duration_ms, detail: result.detail || undefined, evidence: { category: gate.category, log: result.log } });
    byCategory[gate.category] = byCategory[gate.category] || [];
    byCategory[gate.category].push({ id: gate.id, status: record.status });
    if (record.status === "FAIL" && args.stopOnFail) { console.log("stopping at first FAIL (--stop-on-fail)"); break; }
  }

  // Real-money activation is a GOVERNANCE verdict, recorded as its own item
  // in its own category so it is never mixed into technical readiness: a
  // BLOCKED activation does not make the build look broken, and a green build
  // never makes real money look allowed.
  const unclearedReasons = (realMoney.blocking_reasons || []).filter((reason) => reason.cleared !== true);
  const activation = realMoney.real_money_allowed === true
    ? report.warn("real-money-activation", "ALLOWED by governance (decided " + realMoney.decided_on + " by " + realMoney.decided_by + ") - verify the evidence on every cleared reason", { evidence: { category: "ACTIVATION", policy: "config/real-money-release-policy.json" } })
    : report.block("real-money-activation", "BLOCKED by config/real-money-release-policy.json (" + unclearedReasons.length + " uncleared reasons: " + unclearedReasons.map((reason) => reason.id).join(", ") + ")", { detail: unclearedReasons.map((reason) => reason.id + ": " + reason.summary).join("\n"), evidence: { category: "ACTIVATION", policy: "config/real-money-release-policy.json", blocked_by: "governance" } });
  byCategory.ACTIVATION = [{ id: activation.id, status: activation.status }];

  const technicalItems = report.items.filter((item) => !(item.evidence && item.evidence.category === "ACTIVATION"));
  const technical = report.overall(technicalItems);
  const technicalCounts = report.counts(technicalItems);
  report.meta.readiness = {
    technical: technical,
    technical_counts: technicalCounts,
    real_money_activation: activation.status,
    real_money_blocking_reasons: unclearedReasons.map((reason) => reason.id)
  };

  console.log("");
  console.log("CATEGORY SUMMARY");
  for (const [category, items] of Object.entries(byCategory)) {
    const worst = items.some((i) => i.status === "FAIL") ? "FAIL" : items.some((i) => i.status === "BLOCKED") ? "BLOCKED" : items.some((i) => i.status === "WARNING") ? "WARNING" : items.some((i) => i.status === "SKIPPED_ENVIRONMENT") ? (items.every((i) => i.status === "SKIPPED_ENVIRONMENT") ? "SKIPPED_ENVIRONMENT" : "PASS_WITH_SKIPS") : "PASS";
    console.log("  " + category.padEnd(12) + worst.padEnd(18) + items.map((i) => i.id + ":" + i.status[0]).join(" "));
  }

  // Four buckets, deliberately separated. WARNING is a PASS that needs a
  // human decision; SKIPPED_ENVIRONMENT is BLOCKED by the machine (not by
  // the code); governance BLOCKED is listed apart from environment BLOCKED.
  const ids = (status, items = report.items) => items.filter((item) => item.status === status).map((item) => item.id);
  console.log("");
  console.log("VERDICT BUCKETS");
  console.log("  PASS            " + String(ids("PASS").length + ids("WARNING").length).padStart(3) + "  " + ids("PASS").join(" ") + (ids("WARNING").length ? "  [with warnings: " + ids("WARNING").join(" ") + "]" : ""));
  console.log("  FAIL            " + String(ids("FAIL").length).padStart(3) + "  " + ids("FAIL").join(" "));
  console.log("  BLOCKED         " + String(ids("BLOCKED").length + ids("SKIPPED_ENVIRONMENT").length).padStart(3) + "  governance: " + (ids("BLOCKED").join(" ") || "-") + "; environment: " + (ids("SKIPPED_ENVIRONMENT").join(" ") || "-"));
  console.log("  NOT_APPLICABLE  " + String(notApplicable.length).padStart(3) + "  " + (notApplicable.map((item) => item.id + "(" + item.reason + ")").join(" ") || "-"));
  console.log("");
  console.log("TECHNICAL_READINESS: " + technical + " (pass=" + technicalCounts.PASS + " fail=" + technicalCounts.FAIL + " warning=" + technicalCounts.WARNING + " skipped_environment=" + technicalCounts.SKIPPED_ENVIRONMENT + ")");
  console.log("REAL_MONEY_ACTIVATION: " + activation.status);
  console.log("REAL_MONEY: " + (realMoney.real_money_allowed === true ? "ALLOWED" : "BLOCKED"));
  for (const reason of unclearedReasons) console.log("  - " + reason.id);
  report.printSummary({ detailLines: 8 });
  const written = report.writeArtifacts(artifactsDir(root), "release-preflight");
  console.log("");
  console.log("RELEASE_PREFLIGHT_RESULT technical=" + technical + " real_money_activation=" + activation.status + " overall=" + technical + " report=" + path.relative(root, written.mdPath).split(path.sep).join("/") + " logs=" + path.relative(root, logDir).split(path.sep).join("/") + "/");
  console.log(report.exitCode() ? "RELEASE_PREFLIGHT_FAIL" : "RELEASE_PREFLIGHT_PASS");
  process.exit(report.exitCode());
}

main();
