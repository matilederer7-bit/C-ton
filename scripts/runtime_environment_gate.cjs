#!/usr/bin/env node
// Runtime environment gate (npm run gate:runtime-env).
//
// Validates an environment configuration against the machine-readable
// contract in config/runtime-environment-policy.json WITHOUT calling any
// provider, database or network.
//
// Sources (pick one):
//   --target <name>          policy target: development | demo-preview | test | staging | production
//                            (default: detected from APP_DEPLOYMENT_MODE / NODE_ENV)
//   --env-file <path>        evaluate a dotenv-style file instead of process.env
//   --render-service <name>  evaluate the static env block of a service in render.yaml
//                            (external secrets are marked, not verified)
//   --role web|worker        restrict role-specific rules (default: RUNTIME_ROLE or both)
//   --json <path>            write the full result as JSON
//   --all-targets            evaluate the checked-in reference configs for every target
//                            (docker-compose, docker-compose.ci, render.yaml, .env.demo.example)
//
// Exit code: 1 when any FAIL rule is violated, 0 otherwise (WARNINGs print).
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib/runtime_environment_policy.cjs");
const { ReleaseReport, STATUS } = require("./lib/release_report.cjs");

const root = process.cwd();

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; index += 1; } else args[key] = true;
    } else args._.push(item);
  }
  return args;
}

function composeEnv(file, serviceName) {
  // Minimal YAML reader for the compose files in this repository: an
  // `environment:` map with `KEY: value` lines, plus the `<<: *anchor` merge
  // of the shared block. Good enough for reference-config evaluation.
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const anchors = {};
  const services = {};
  let current = null;
  let inEnv = false;
  let anchorName = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    const service = line.match(/^  (\w[\w-]*):\s*$/);
    if (service) { current = service[1]; services[current] = services[current] || {}; inEnv = false; continue; }
    if (/^\s{4}environment:\s*(&(\S+))?\s*$/.test(line)) { inEnv = true; anchorName = (line.match(/&(\S+)/) || [])[1] || null; if (anchorName) anchors[anchorName] = services[current]; continue; }
    if (/^\s{4}\S/.test(line)) { inEnv = false; anchorName = null; }
    if (inEnv) {
      const merge = line.match(/^\s{6}<<:\s*\*(\S+)/);
      if (merge && anchors[merge[1]]) { Object.assign(services[current], anchors[merge[1]]); continue; }
      const pair = line.match(/^\s{6}([A-Z0-9_]+):\s*(.*)$/);
      if (pair) {
        let val = pair[2].trim();
        if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        services[current][pair[1]] = val;
      }
    }
  }
  return services[serviceName] || null;
}

function evaluateOne(report, label, env, options) {
  const policy = lib.loadPolicy(root);
  const realMoney = lib.loadRealMoneyPolicy(root);
  const result = lib.evaluate(policy, env, { ...options, realMoneyPolicy: realMoney });
  const failed = result.failures.map((item) => item.message + " [" + item.reason + "]");
  const warned = result.warnings.map((item) => item.message + " [" + item.reason + "]");
  const externals = result.results.filter((item) => item.external).map((item) => item.var);
  const summary = "target=" + result.target + (result.role ? " role=" + result.role : "") + " rules=" + result.results.length + " fail=" + failed.length + " warn=" + warned.length + (externals.length ? " external_secrets=" + externals.length : "");
  const detail = [...failed.map((m) => "FAIL " + m), ...warned.map((m) => "WARNING " + m), ...(externals.length ? ["EXTERNAL (verified in hosting console, not here): " + externals.join(", ")] : [])].join("\n");
  if (failed.length) report.fail(label, summary, { detail, evidence: result });
  else if (warned.length) report.warn(label, summary, { detail, evidence: result });
  else report.pass(label, summary, { detail: detail || undefined, evidence: result });
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = new ReleaseReport("runtime environment gate");

  if (args["all-targets"]) {
    // Reference configurations checked into the repository. Each must satisfy
    // its own target; the production target is evaluated against a
    // deliberately minimal env to prove the gate refuses an unconfigured
    // production and against the render blueprint shape for staging.
    evaluateOne(report, "docker-compose.yml app (demo-preview, web)", composeEnv("docker-compose.yml", "app") || {}, { role: "web" });
    evaluateOne(report, "docker-compose.yml worker (demo-preview, worker)", composeEnv("docker-compose.yml", "worker") || {}, { role: "worker" });
    evaluateOne(report, "docker-compose.ci.yml web (test, web)", composeEnv("docker-compose.ci.yml", "web") || {}, { target: "test", role: "web" });
    const renderWeb = lib.renderBlueprintEnv(root, "siton-staging-web");
    const renderWorker = lib.renderBlueprintEnv(root, "siton-staging-worker");
    evaluateOne(report, "render.yaml siton-staging-web (staging, web)", renderWeb || {}, { target: "staging", role: "web" });
    evaluateOne(report, "render.yaml siton-staging-worker (staging, worker)", renderWorker || {}, { target: "staging", role: "worker" });
    if (fs.existsSync(path.join(root, ".env.demo.example"))) {
      evaluateOne(report, ".env.demo.example (demo-preview)", lib.parseEnvFile(path.join(root, ".env.demo.example")), { target: "demo-preview" });
    }
    // Negative control: an empty production env must fail (many rules).
    const emptyProd = lib.evaluate(lib.loadPolicy(root), { APP_DEPLOYMENT_MODE: "production" }, { target: "production", role: "web", realMoneyPolicy: lib.loadRealMoneyPolicy(root) });
    if (emptyProd.failures.length >= 10) report.pass("production negative control", "an unconfigured production env fails " + emptyProd.failures.length + " rules (gate is not vacuous)");
    else report.fail("production negative control", "an unconfigured production env only failed " + emptyProd.failures.length + " rules");
  } else {
    let env = process.env;
    let label = "process.env";
    if (args["env-file"]) { env = lib.parseEnvFile(path.resolve(root, args["env-file"])); label = args["env-file"]; }
    if (args["render-service"]) { env = lib.renderBlueprintEnv(root, args["render-service"]); label = "render.yaml " + args["render-service"]; if (!env) { console.error("render service not found: " + args["render-service"]); process.exit(2); } }
    evaluateOne(report, label, env, { target: args.target || undefined, role: args.role || undefined });
  }

  const realMoney = lib.loadRealMoneyPolicy(root);
  console.log("REAL_MONEY: " + (realMoney.real_money_allowed === true ? "ALLOWED" : "BLOCKED"));
  const staticRuntimeGaps = lib.loadPolicy(root).runtime_gaps || [];
  for (const gap of staticRuntimeGaps) console.log("RUNTIME_GAP " + gap.status + " " + gap.id + " (" + gap.where + ")");

  report.printSummary({ detailLines: 200 });
  if (args.json) { fs.mkdirSync(path.dirname(path.resolve(root, args.json)), { recursive: true }); fs.writeFileSync(path.resolve(root, args.json), JSON.stringify(report.toJSON(), null, 2)); }
  console.log(report.count(STATUS.FAIL) ? "RUNTIME_ENVIRONMENT_GATE_FAIL" : "RUNTIME_ENVIRONMENT_GATE_PASS");
  process.exit(report.exitCode());
}

if (require.main === module) main();

module.exports = { composeEnv, evaluateOne, parseArgs };
