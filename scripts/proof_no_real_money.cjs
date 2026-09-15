#!/usr/bin/env node
// "No real money" release proof (npm run proof:no-real-money) and the
// real-money release gate (npm run gate:real-money).
//
// Asserts that THIS release cannot accidentally enable real payment activity.
// It inspects repository configuration, checked-in deployment targets, CI
// workflows and the runtime guard seam. It never calls Grow, never reads a
// hosted environment, and is a DEPLOYMENT SAFETY proof, not a financial
// correctness proof.
//
// It fails when:
//   - config/real-money-release-policy.json says ALLOWED but a blocking reason
//     is still uncleared or lacks evidence;
//   - any checked-in target config (render.yaml, compose files, Dockerfile,
//     .env examples, workflows) selects PAYMENT_ENVIRONMENT=live, a live Grow
//     host, or live provider credentials;
//   - a CI workflow or npm script requires live credentials for local smoke;
//   - the runtime guard seam stops refusing live outside production or mock
//     inside production (proven by executing src/production_guards.ts);
//   - the release policy no longer carries the fail-closed production rule.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const policyLib = require("./lib/runtime_environment_policy.cjs");
const scanPolicy = require("./lib/repo_scan_policy.cjs");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();
const LIVE_HOST = /secure\.meshulam\.co\.il|api\.meshulam\.co\.il/i;

function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }
function exists(rel) { return fs.existsSync(path.join(root, rel)); }

function runtimeGuard(role, env) {
  const probe = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/probes/production_guards_probe.ts")], {
    cwd: root, input: JSON.stringify({ role, env }), encoding: "utf8", env: { ...process.env, DOTENV_CONFIG_QUIET: "true" }, timeout: 60000
  });
  const lastLine = String(probe.stdout || "").trim().split(/\r?\n/).pop();
  try { return JSON.parse(lastLine); } catch { return { ok: null, error: "probe failed: " + String(probe.stderr || "").slice(0, 300) }; }
}

function main() {
  const report = new ReleaseReport("no-real-money proof");
  const realMoney = policyLib.loadRealMoneyPolicy(root);
  const runtimePolicy = policyLib.loadPolicy(root);

  // 1. Governance file.
  const uncleared = (realMoney.blocking_reasons || []).filter((reason) => reason.cleared !== true);
  if (realMoney.real_money_allowed === true) {
    const missingEvidence = (realMoney.blocking_reasons || []).filter((reason) => reason.cleared === true && !reason.evidence);
    if (uncleared.length || missingEvidence.length) report.fail("governance", "policy says ALLOWED but " + uncleared.length + " reasons uncleared and " + missingEvidence.length + " cleared without evidence");
    else report.warn("governance", "real money ALLOWED by owner decision on " + realMoney.decided_on + " (every blocking reason cleared with evidence)");
  } else {
    report.pass("governance", "REAL_MONEY_ALLOWED=false status=" + realMoney.status + " reasons=" + uncleared.length, { detail: uncleared.map((reason) => reason.id + ": " + reason.summary).join("\n") });
  }

  // 2. Release policy structure: production must carry the governed rule.
  const productionRules = runtimePolicy.environments.production.rules;
  const governed = productionRules.filter((rule) => rule.governed_by === "real-money-release-policy" && rule.var === "PAYMENT_ENVIRONMENT" && rule.must === "not_equal" && rule.value === "live" && rule.severity === "FAIL");
  if (governed.length === 1) report.pass("policy structure", "production policy carries the fail-closed PAYMENT_ENVIRONMENT!=live rule governed by the real-money policy");
  else report.fail("policy structure", "production policy lost the governed PAYMENT_ENVIRONMENT!=live rule");
  for (const target of ["development", "demo-preview", "test", "staging"]) {
    const rules = runtimePolicy.environments[target].rules;
    const refusesLive = rules.some((rule) => rule.var === "PAYMENT_ENVIRONMENT" && rule.severity === "FAIL" && ((rule.must === "not_equal" && rule.value === "live") || (rule.must === "one_of" && !rule.value.includes("live"))));
    (refusesLive ? report.pass : report.fail).call(report, "policy " + target + " refuses live", refusesLive ? "PAYMENT_ENVIRONMENT=live is a FAIL rule" : "target does not refuse PAYMENT_ENVIRONMENT=live");
  }

  // 3. Checked-in deployment targets.
  const targets = [
    ["render.yaml", ["siton-staging-web", "siton-staging-worker"].map((name) => policyLib.renderBlueprintEnv(root, name) || {})],
    ["docker-compose.yml", [require("./runtime_environment_gate.cjs").composeEnv("docker-compose.yml", "app") || {}, require("./runtime_environment_gate.cjs").composeEnv("docker-compose.yml", "worker") || {}]],
    ["docker-compose.ci.yml", [require("./runtime_environment_gate.cjs").composeEnv("docker-compose.ci.yml", "web") || {}, require("./runtime_environment_gate.cjs").composeEnv("docker-compose.ci.yml", "worker") || {}]]
  ];
  if (exists(".env.demo.example")) targets.push([".env.demo.example", [policyLib.parseEnvFile(path.join(root, ".env.demo.example"))]]);
  for (const [label, envs] of targets) {
    const problems = [];
    for (const env of envs) {
      if (String(env.PAYMENT_ENVIRONMENT || "").toLowerCase() === "live") problems.push("PAYMENT_ENVIRONMENT=live");
      if (/^sk_live_|^pk_live_/.test(String(env.PAYMENT_PROVIDER_API_KEY || "") + " " + String(env.PAYMENT_PROVIDER_PUBLIC_KEY || ""))) problems.push("live provider credential");
      if (LIVE_HOST.test(String(env.PAYMENT_PROVIDER_BASE_URL || ""))) problems.push("live Grow host");
      if (String(env.PAYMENT_PROVIDER || "").toLowerCase() === "grow" && String(env.PAYMENT_ENVIRONMENT || "").toLowerCase() !== "sandbox") problems.push("Grow provider without sandbox environment");
    }
    (problems.length ? report.fail : report.pass).call(report, "target " + label, problems.length ? problems.join(", ") : "no live money configuration (" + envs.length + " service env blocks)");
  }
  {
    const dockerfile = read("Dockerfile");
    const envLines = [...dockerfile.matchAll(/^ENV\s+([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]);
    const bad = envLines.filter(([key, val]) => (key === "PAYMENT_ENVIRONMENT" && /live/i.test(val)) || (key === "APP_DEPLOYMENT_MODE" && /^(production|prod|commercial-live)$/i.test(val)));
    (bad.length ? report.fail : report.pass).call(report, "target Dockerfile", bad.length ? bad.map((b) => b.join("=")).join(", ") : "image defaults to demo-preview and sets no live money variable");
  }

  // 4. Workflows and npm scripts never require or set live credentials.
  {
    const workflowDir = path.join(root, ".github", "workflows");
    const problems = [];
    for (const file of fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir) : []) {
      const text = fs.readFileSync(path.join(workflowDir, file), "utf8");
      if (/PAYMENT_ENVIRONMENT:\s*["']?live/i.test(text)) problems.push(file + " sets PAYMENT_ENVIRONMENT=live");
      if (/sk_live_[A-Za-z0-9]/.test(text)) problems.push(file + " carries a live-looking key");
      if (/secrets\.[A-Z_]*LIVE[A-Z_]*/.test(text)) problems.push(file + " references a LIVE secret");
      if (LIVE_HOST.test(text)) problems.push(file + " references a live Grow host");
    }
    const pkg = JSON.parse(read("package.json"));
    for (const [name, command] of Object.entries(pkg.scripts || {})) {
      if (/PAYMENT_ENVIRONMENT=live|sk_live_/i.test(command)) problems.push("npm script " + name + " sets live money");
    }
    (problems.length ? report.fail : report.pass).call(report, "workflows and npm scripts", problems.length ? problems.join("; ") : "no workflow or npm script selects live money or requires live credentials");
  }

  // 5. Runtime guard seam (executed, not grepped).
  {
    const liveOutsideProduction = runtimeGuard("web", { APP_DEPLOYMENT_MODE: "staging", PAYMENT_PROVIDER: "grow", PAYMENT_PROVIDER_MODE: "grow", PAYMENT_ENVIRONMENT: "live", PAYMENT_PROVIDER_BASE_URL: "https://secure.meshulam.co.il/x" });
    (liveOutsideProduction.ok === false && /only legal in production/.test(String(liveOutsideProduction.error)) ? report.pass : report.fail).call(report, "runtime refuses live outside production", String(liveOutsideProduction.error || "accepted"));
    const mockInProduction = runtimeGuard("web", { APP_DEPLOYMENT_MODE: "production", PAYMENT_PROVIDER: "mockpay", PAYMENT_PROVIDER_MODE: "mock-backed", RUNTIME_ROLE: "web" });
    (mockInProduction.ok === false && /mock/.test(String(mockInProduction.error)) ? report.pass : report.fail).call(report, "runtime refuses mock money in production", String(mockInProduction.error || "accepted"));
    const sandboxHostForLive = runtimeGuard("web", { APP_DEPLOYMENT_MODE: "production", RUNTIME_ROLE: "web", PAYMENT_PROVIDER: "grow", PAYMENT_PROVIDER_MODE: "grow", PAYMENT_ENVIRONMENT: "live", PAYMENT_PROVIDER_BASE_URL: "https://sandbox.meshulam.co.il/x", GROW_USER_ID: "u", GROW_PAGE_CODE: "p", GROW_REFERENCE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" });
    (sandboxHostForLive.ok === false && /sandbox\.meshulam/.test(String(sandboxHostForLive.error)) ? report.pass : report.fail).call(report, "runtime refuses live credentials against the sandbox host", String(sandboxHostForLive.error || "accepted"));
  }

  // 6. No committed live credential shapes anywhere in canonical source
  //    (configs, scripts, tests, docs). Grow API keys are opaque, so the check
  //    is for Stripe-shaped live keys and live-host URLs inside runtime config
  //    files (not docs, which may name the host when describing the contract).
  {
    // Scope: runtime configuration and source, not tests (which carry short
    // synthetic `sk_live_forbidden`-style fixtures to PROVE rejection), not
    // docs, and not the release policy/matrix files that describe the rule.
    // A real Stripe live secret is `sk_live_` + 24 or more base62 characters.
    const files = scanPolicy.walkRepository(root, {
      extensions: /\.(ts|tsx|js|cjs|mjs|json|yml|yaml|env\.example|toml)$/,
      includeFile: (rel) => !rel.startsWith("docs/") && !rel.startsWith("tests/") && !/^config\/(runtime-environment-policy|real-money-release-policy|startup-config-matrix)\.json$/.test(rel) && rel !== "scripts/proof_no_real_money.cjs"
    });
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file.abs, "utf8");
      if (/\bsk_live_[A-Za-z0-9]{24,}\b/.test(text)) hits.push(file.rel + ": sk_live_ credential shape");
      // An ASSIGNMENT of live (env file, compose, yaml, object literal), not prose.
      if (/(^|[\s"'{,])PAYMENT_ENVIRONMENT["']?\s*[:=]\s*["']?live["']?\s*($|[,\s}])/m.test(text) && !/production_guards/.test(file.rel)) hits.push(file.rel + ": assigns PAYMENT_ENVIRONMENT=live");
    }
    (hits.length ? report.fail : report.pass).call(report, "repository live-credential scan", hits.length ? hits.join("; ") : "no live credential shape and no PAYMENT_ENVIRONMENT=live assignment in runtime source or configuration (" + files.length + " files)");
  }

  console.log("");
  console.log("REAL_MONEY: " + (realMoney.real_money_allowed === true ? "ALLOWED" : "BLOCKED"));
  for (const reason of uncleared) console.log("  - " + reason.id + ": " + reason.summary);
  report.printSummary();
  report.writeArtifacts(artifactsDir(root), "no-real-money-proof");
  console.log(report.exitCode() ? "NO_REAL_MONEY_PROOF_FAIL" : "NO_REAL_MONEY_PROOF_PASS");
  process.exit(report.exitCode());
}

main();
