// Controls for the runtime environment policy, the environment gate and the
// no-real-money proof.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createFixtureRepo, REPO_ROOT } = require("./support/fixture_repo.cjs");
const lib = require("../../scripts/lib/runtime_environment_policy.cjs");

const policy = lib.loadPolicy(REPO_ROOT);
const realMoney = lib.loadRealMoneyPolicy(REPO_ROOT);
const matrix = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "startup-config-matrix.json"), "utf8"));

test("policy file is well-formed: every rule has var/must/severity/reason and uses a known operator", () => {
  const operators = new Set(["present", "absent", "equal", "not_equal", "one_of", "not_one_of", "matches", "not_matches", "not_placeholder", "min_length", "absent_or_equal", "https_url"]);
  for (const [name, environment] of Object.entries(policy.environments)) {
    assert.ok(environment.description, name + " needs a description");
    for (const rule of environment.rules) {
      assert.ok(rule.var && rule.must && rule.severity && rule.reason, name + " rule incomplete: " + JSON.stringify(rule));
      assert.ok(operators.has(rule.must), name + " unknown operator " + rule.must);
      assert.ok(["FAIL", "WARNING"].includes(rule.severity));
      if (rule.roles) assert.ok(rule.roles.every((role) => ["web", "worker"].includes(role)));
    }
  }
  assert.deepEqual(Object.keys(policy.environments).sort(), ["demo-preview", "development", "production", "staging", "test"]);
});

test("target detection follows APP_DEPLOYMENT_MODE / NODE_ENV", () => {
  assert.equal(lib.detectTarget(policy, { APP_DEPLOYMENT_MODE: "production" }), "production");
  assert.equal(lib.detectTarget(policy, { APP_DEPLOYMENT_MODE: "commercial-live" }), "production");
  assert.equal(lib.detectTarget(policy, { APP_DEPLOYMENT_MODE: "staging" }), "staging");
  assert.equal(lib.detectTarget(policy, { NODE_ENV: "test" }), "test");
  assert.equal(lib.detectTarget(policy, { APP_DEPLOYMENT_MODE: "demo-preview" }), "demo-preview");
  assert.equal(lib.detectTarget(policy, {}), "development");
});

test("every operator has a positive and a negative case", () => {
  const ctx = { placeholderPattern: policy.placeholder_pattern };
  const cases = [
    [{ var: "A", must: "present" }, { A: "x" }, null], [{ var: "A", must: "present" }, {}, /must be present/],
    [{ var: "A", must: "absent" }, {}, null], [{ var: "A", must: "absent" }, { A: "x" }, /must be absent/],
    [{ var: "A", must: "equal", value: "x" }, { A: "X" }, null], [{ var: "A", must: "equal", value: "x" }, { A: "y" }, /must equal/],
    [{ var: "A", must: "not_equal", value: "x" }, { A: "y" }, null], [{ var: "A", must: "not_equal", value: "x" }, { A: "x" }, /must not equal/],
    [{ var: "A", must: "one_of", value: ["a", "b"] }, { A: "b" }, null], [{ var: "A", must: "one_of", value: ["a", "b"] }, { A: "c" }, /must be one of/],
    [{ var: "A", must: "not_one_of", value: ["a"] }, { A: "b" }, null], [{ var: "A", must: "not_one_of", value: ["a"] }, { A: "a" }, /must not be/],
    [{ var: "A", must: "matches", value: "^ab" }, { A: "abc" }, null], [{ var: "A", must: "matches", value: "^ab" }, { A: "xabc" }, /must match/],
    [{ var: "A", must: "not_matches", value: "^ab" }, { A: "xabc" }, null], [{ var: "A", must: "not_matches", value: "^ab" }, { A: "abc" }, /must not match/],
    [{ var: "A", must: "not_placeholder" }, { A: "8f3c1d2e9a7b" }, null], [{ var: "A", must: "not_placeholder" }, { A: "changeme" }, /placeholder/], [{ var: "A", must: "not_placeholder" }, {}, /present/],
    [{ var: "A", must: "min_length", value: 4 }, { A: "abcd" }, null], [{ var: "A", must: "min_length", value: 4 }, { A: "abc" }, /at least 4/],
    [{ var: "A", must: "absent_or_equal", value: "0" }, {}, null], [{ var: "A", must: "absent_or_equal", value: "0" }, { A: "1" }, /absent or/],
    [{ var: "A", must: "https_url" }, { A: "https://x.invalid" }, null], [{ var: "A", must: "https_url" }, { A: "http://x.invalid" }, /https/]
  ];
  for (const [rule, env, expected] of cases) {
    const message = lib.evaluateRule(rule, env, ctx);
    if (expected === null) assert.equal(message, null, JSON.stringify(rule) + " " + JSON.stringify(env));
    else assert.match(String(message), expected, JSON.stringify(rule) + " " + JSON.stringify(env));
  }
  assert.throws(() => lib.evaluateRule({ var: "A", must: "bogus" }, {}, ctx), /unknown policy operator/);
});

test("secret-looking values are never echoed into a failure message", () => {
  const result = lib.evaluate(policy, { APP_DEPLOYMENT_MODE: "production", DATABASE_URL: "postgresql://postgres:supersecretpassword@localhost:5432/x" }, { target: "production", role: "web", realMoneyPolicy: realMoney });
  const text = JSON.stringify(result.failures);
  assert.doesNotMatch(text, /supersecretpassword/);
});

test("the live production baseline is accepted except for the real-money governed rule, and flipping the policy to ALLOWED lifts exactly that rule", () => {
  const env = matrix.base_production_web;
  const blocked = lib.evaluate(policy, env, { target: "production", role: "web", realMoneyPolicy: realMoney });
  assert.deepEqual(blocked.failures.map((f) => f.var), ["PAYMENT_ENVIRONMENT"]);
  assert.equal(blocked.failures[0].governed_by, "real-money-release-policy");
  const allowed = lib.evaluate(policy, env, { target: "production", role: "web", realMoneyPolicy: { real_money_allowed: true } });
  assert.deepEqual(allowed.failures, []);
});

test("external secrets declared in render.yaml count as present but are marked, and an absent-rule still fails on them", () => {
  const env = lib.renderBlueprintEnv(REPO_ROOT, "siton-staging-web");
  assert.ok(env && env.DATABASE_URL.startsWith("__EXTERNAL_SECRET__"));
  const result = lib.evaluate(policy, { ...env, SUPABASE_SERVICE_ROLE_KEY: "__EXTERNAL_SECRET__SUPABASE_SERVICE_ROLE_KEY" }, { target: "staging", role: "web", realMoneyPolicy: realMoney });
  assert.ok(result.failures.some((f) => f.var === "SUPABASE_SERVICE_ROLE_KEY"), "service-role key declared on a runtime must fail even as an external secret");
  assert.ok(result.results.some((r) => r.var === "DATABASE_URL" && r.external === true));
});

test("runtime environment gate CLI: process.env target detection, env-file evaluation and exit codes", () => {
  const gate = path.join(REPO_ROOT, "scripts", "runtime_environment_gate.cjs");
  const good = spawnSync(process.execPath, [gate, "--target", "test"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DISABLE_OUTBOX_WORKER: "1", DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/siton_ci", RENDER: "" } });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /RUNTIME_ENVIRONMENT_GATE_PASS/);
  assert.match(good.stdout, /REAL_MONEY: BLOCKED/);
  const tmp = path.join(require("node:os").tmpdir(), "siton-env-gate-" + process.pid + ".env");
  fs.writeFileSync(tmp, "APP_DEPLOYMENT_MODE=production\nPAYMENT_ENVIRONMENT=live\nDEBUG_SURFACES_ENABLED=1\n");
  try {
    const bad = spawnSync(process.execPath, [gate, "--env-file", tmp, "--role", "web"], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /RUNTIME_ENVIRONMENT_GATE_FAIL/);
    assert.match(bad.stdout, /REAL_MONEY_BLOCKED/);
    assert.match(bad.stdout, /DEBUG_SURFACES_ENABLED must be absent/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("startup config matrix runs green with the documented runtime gaps as warnings", () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "startup_config_matrix.cjs")], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, DOTENV_CONFIG_QUIET: "true" }, timeout: 300000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /STARTUP_CONFIG_MATRIX_PASS cases=\d+ runtime_gaps=\d+/);
  assert.match(result.stdout, /\[PASS\] baseline production web: accepted by runtime guard; release policy fails only on PAYMENT_ENVIRONMENT \(REAL_MONEY_BLOCKED\)/);
});

const NO_MONEY_FIXTURE = [
  "config", "render.yaml", "docker-compose.yml", "docker-compose.ci.yml", "Dockerfile", ".env.demo.example", ".github/workflows", "package.json",
  "scripts/lib", "scripts/probes/production_guards_probe.ts", "scripts/runtime_environment_gate.cjs", "scripts/proof_no_real_money.cjs", "src/production_guards.ts"
];

test("no-real-money proof passes on the repository and fails when a target config or the governance file turns live", () => {
  const clean = createFixtureRepo(NO_MONEY_FIXTURE);
  try {
    const ok = clean.run("scripts/proof_no_real_money.cjs");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /REAL_MONEY: BLOCKED/);
    assert.match(ok.stdout, /F13_PROVIDER_CONTRACT_UNRESOLVED/);
  } finally { clean.cleanup(); }

  const liveRender = createFixtureRepo(NO_MONEY_FIXTURE);
  try {
    liveRender.mutate("render.yaml", "      - key: PAYMENT_ENVIRONMENT\n        value: demo", "      - key: PAYMENT_ENVIRONMENT\n        value: live");
    const result = liveRender.run("scripts/proof_no_real_money.cjs");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /target render\.yaml: PAYMENT_ENVIRONMENT=live/);
  } finally { liveRender.cleanup(); }

  const allowedWithoutEvidence = createFixtureRepo(NO_MONEY_FIXTURE);
  try {
    const governance = JSON.parse(allowedWithoutEvidence.read("config/real-money-release-policy.json"));
    governance.real_money_allowed = true;
    governance.status = "ALLOWED";
    allowedWithoutEvidence.write("config/real-money-release-policy.json", JSON.stringify(governance, null, 2));
    const result = allowedWithoutEvidence.run("scripts/proof_no_real_money.cjs");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /policy says ALLOWED but \d+ reasons uncleared/);
  } finally { allowedWithoutEvidence.cleanup(); }

  const workflowLive = createFixtureRepo(NO_MONEY_FIXTURE);
  try {
    workflowLive.mutate(".github/workflows/backend-quality-gates.yml", "PAYMENT_PROVIDER_MODE: mock-backed", "PAYMENT_PROVIDER_MODE: mock-backed\n      PAYMENT_ENVIRONMENT: live");
    const result = workflowLive.run("scripts/proof_no_real_money.cjs");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /sets PAYMENT_ENVIRONMENT=live/);
  } finally { workflowLive.cleanup(); }
});
