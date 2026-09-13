#!/usr/bin/env node
// Startup configuration failure matrix (npm run gate:startup-matrix).
//
// For every unsafe / missing environment combination in
// config/startup-config-matrix.json:
//   1. run the REAL boot guard (src/production_guards.ts) through the tsx probe
//      and require the expected accept/reject with a clear diagnostic (never an
//      opaque stack trace);
//   2. run the release policy gate (config/runtime-environment-policy.json) and
//      require the expected verdict.
// Cases the runtime does not refuse yet are marked runtime_gap in the matrix
// and reported as WARNING (documented gap), never as PASS-by-omission.
//
// No database, no provider, no network.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const policyLib = require("./lib/runtime_environment_policy.cjs");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();
const matrix = JSON.parse(fs.readFileSync(path.join(root, "config", "startup-config-matrix.json"), "utf8"));
const policy = policyLib.loadPolicy(root);
const realMoney = policyLib.loadRealMoneyPolicy(root);

function runtimeGuard(role, env) {
  const probe = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/probes/production_guards_probe.ts")], {
    cwd: root,
    input: JSON.stringify({ role, env }),
    encoding: "utf8",
    env: { ...process.env, DOTENV_CONFIG_QUIET: "true" },
    timeout: 60000
  });
  if (probe.status !== 0) return { ok: null, error: "probe crashed: " + String(probe.stderr || probe.stdout).slice(0, 400) };
  const lastLine = String(probe.stdout || "").trim().split(/\r?\n/).pop();
  try { return JSON.parse(lastLine); } catch { return { ok: null, error: "probe output not JSON: " + lastLine }; }
}

function baseFor(caseItem) {
  if (caseItem.base === "staging") return matrix.base_staging_web;
  if (caseItem.base === "test") return matrix.base_test_web;
  return matrix.base_production_web;
}

function targetFor(caseItem) {
  if (caseItem.policy_target) return caseItem.policy_target;
  if (caseItem.base === "staging") return "staging";
  if (caseItem.base === "test") return "test";
  return "production";
}

function main() {
  const report = new ReleaseReport("startup config failure matrix");
  // Baseline control: the fully configured production/staging/test envs must be
  // ACCEPTED by the runtime guard and the policy, or every case below is vacuous.
  // The production baseline is a fully LIVE configuration: the runtime guard
  // must accept it, and the release policy must fail it on exactly the rules
  // governed by the real-money release policy (REAL_MONEY_BLOCKED) and nothing
  // else. That proves two things at once: the matrix is not vacuous, and the
  // only thing between this configuration and production is the owner's
  // real-money decision.
  for (const [label, env, role, target] of [
    ["baseline production web", matrix.base_production_web, "web", "production"],
    ["baseline staging web", matrix.base_staging_web, "web", "staging"],
    ["baseline test web", matrix.base_test_web, "web", "test"]
  ]) {
    const runtime = runtimeGuard(role, env);
    const evaluated = policyLib.evaluate(policy, env, { target, role, realMoneyPolicy: realMoney });
    const governed = evaluated.failures.filter((f) => f.governed_by === "real-money-release-policy");
    const ungoverned = evaluated.failures.filter((f) => f.governed_by !== "real-money-release-policy");
    const ok = runtime.ok === true && ungoverned.length === 0 && (target !== "production" || (governed.length === 1 && realMoney.real_money_allowed !== true));
    const summary = ok
      ? "accepted by runtime guard; release policy fails only on " + (governed.length ? governed.map((f) => f.var + " (REAL_MONEY_BLOCKED)").join(", ") : "nothing") + " (matrix is not vacuous)"
      : "baseline rejected: runtime=" + JSON.stringify(runtime) + " policy=" + evaluated.failures.map((f) => f.message).join("; ");
    (ok ? report.pass : report.fail).call(report, label, summary);
  }

  for (const item of matrix.cases) {
    const env = { ...baseFor(item), ...item.override };
    for (const [key, val] of Object.entries(env)) if (val === "") delete env[key];
    const runtime = runtimeGuard(item.role, env);
    const evaluated = policyLib.evaluate(policy, env, { target: targetFor(item), role: item.role, realMoneyPolicy: realMoney });
    const problems = [];
    const notes = [];

    // Runtime guard expectation.
    if (item.runtime_expect === "reject") {
      if (runtime.ok !== false) problems.push("runtime guard ACCEPTED an unsafe configuration (expected rejection)");
      else {
        if (item.runtime_message && !String(runtime.error).includes(item.runtime_message)) problems.push("runtime diagnostic does not name the cause; got: " + runtime.error);
        if (/\n\s+at /.test(String(runtime.error))) problems.push("runtime diagnostic is a stack trace, not a message");
        notes.push("runtime: " + runtime.error);
      }
    } else if (item.runtime_expect === "accept") {
      if (runtime.ok !== true) problems.push("runtime guard rejected a configuration the matrix expects it to accept: " + runtime.error);
      else notes.push(item.runtime_gap ? "runtime: ACCEPTS (documented runtime gap; release gate is the only defence)" : "runtime: accepts (" + (item.runtime_note || "by design") + ")");
    }

    // Policy expectation.
    const policyFailed = evaluated.failures.length > 0;
    if (item.policy_expect === "fail") {
      if (!policyFailed) problems.push("release policy did not fail the unsafe configuration");
      else if (item.policy_message && !evaluated.failures.some((f) => String(f.message).includes(item.policy_message) || String(f.reason).includes(item.policy_message))) problems.push("release policy failed for a different reason than expected; got: " + evaluated.failures.map((f) => f.message).join(" | "));
      else notes.push("policy: " + evaluated.failures.map((f) => f.message).join(" | "));
    } else if (item.policy_expect === "pass") {
      if (policyFailed) problems.push("release policy failed unexpectedly: " + evaluated.failures.map((f) => f.message).join(" | "));
    } else {
      notes.push("policy: " + (policyFailed ? "fail" : "pass") + (item.policy_note ? " (" + item.policy_note + ")" : ""));
    }

    if (problems.length) report.fail(item.id, item.title, { detail: problems.concat(notes).join("\n") });
    else if (item.runtime_gap) report.warn(item.id, item.title + " - RUNTIME_GAP (release gate only)", { detail: notes.join("\n") });
    else report.pass(item.id, item.title, { detail: notes.join("\n") });
  }

  report.printSummary();
  report.writeArtifacts(artifactsDir(root), "startup-config-matrix");
  console.log(report.exitCode() ? "STARTUP_CONFIG_MATRIX_FAIL" : "STARTUP_CONFIG_MATRIX_PASS cases=" + matrix.cases.length + " runtime_gaps=" + matrix.cases.filter((c) => c.runtime_gap).length);
  process.exit(report.exitCode());
}

main();
