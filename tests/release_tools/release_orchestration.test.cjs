// Controls for the release preflight orchestrator, the manifest, the
// checklist and the owner check: positive path, negative path, clean exit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, createFixtureRepo } = require("./support/fixture_repo.cjs");

// Every run in this file writes to a private artifacts dir so a nested
// preflight never clobbers the real .release-artifacts of an outer run.
const ARTIFACTS = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "siton-orchestration-artifacts-"));
test.after(() => fs.rmSync(ARTIFACTS, { recursive: true, force: true }));
function run(script, args = [], options = {}) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", script), ...args], { cwd: options.cwd || REPO_ROOT, encoding: "utf8", timeout: options.timeout || 600000, env: { ...process.env, DOTENV_CONFIG_QUIET: "true", SITON_RELEASE_ARTIFACTS_DIR: ARTIFACTS, ...(options.env || {}) } });
}

test("preflight: a subset of static gates passes, writes reports and per-gate logs, prints REAL_MONEY: BLOCKED", () => {
  const result = run("release_preflight.cjs", ["--profile", "static", "--only", "typescript,runtime-ddl-scan,no-real-money-proof,docker-readiness-static"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RELEASE_PREFLIGHT_PASS/);
  assert.match(result.stdout, /REAL_MONEY: BLOCKED/);
  assert.match(result.stdout, /F13_PROVIDER_CONTRACT_UNRESOLVED/);
  const report = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, "release-preflight.json"), "utf8"));
  // Four technical gates + ONE governance item (real-money-activation), which
  // is BLOCKED and kept apart from technical readiness.
  const technical = report.items.filter((item) => !(item.evidence && item.evidence.category === "ACTIVATION"));
  const activation = report.items.filter((item) => item.evidence && item.evidence.category === "ACTIVATION");
  assert.equal(technical.length, 4);
  assert.ok(technical.every((item) => ["PASS", "WARNING", "SKIPPED_ENVIRONMENT"].includes(item.status)), JSON.stringify(technical));
  assert.equal(activation.length, 1);
  assert.equal(activation[0].id, "real-money-activation");
  assert.equal(activation[0].status, "BLOCKED");
  assert.notEqual(report.overall, "BLOCKED", "technical overall must not be poisoned by the governance item");
  assert.equal(report.meta.readiness.real_money_activation, "BLOCKED");
  assert.ok(report.meta.readiness.real_money_blocking_reasons.includes("F13_PROVIDER_CONTRACT_UNRESOLVED"));
  assert.match(result.stdout, /TECHNICAL_READINESS: (PASS|WARNING|SKIPPED_ENVIRONMENT)/);
  assert.match(result.stdout, /REAL_MONEY_ACTIVATION: BLOCKED/);
  assert.match(result.stdout, /VERDICT BUCKETS/);
  assert.match(result.stdout, /NOT_APPLICABLE\s+\d+\s+.*not in --only/);
  assert.match(result.stdout, /RELEASE_PREFLIGHT_RESULT technical=(PASS|WARNING|SKIPPED_ENVIRONMENT) real_money_activation=BLOCKED/);
  // Every gate the run did not execute is listed as NOT_APPLICABLE, never silently dropped.
  assert.ok(report.meta.not_applicable.length > 0);
  assert.ok(report.meta.not_applicable.every((item) => !technical.some((t) => t.id === item.id)));
  assert.ok(fs.existsSync(path.join(ARTIFACTS, "preflight", "typescript.log")));
  assert.match(fs.readFileSync(path.join(ARTIFACTS, "release-preflight.md"), "utf8"), /# release preflight/);
  assert.match(fs.readFileSync(path.join(ARTIFACTS, "release-preflight.md"), "utf8"), /real-money-activation \| BLOCKED/);
});

test("preflight: a governance file that says ALLOWED without evidence cannot make activation look green", () => {
  const fixture = createFixtureRepo(["scripts/lib", "config/release-preflight-gates.json", "config/real-money-release-policy.json", "config/runtime-environment-policy.json", "scripts/release_preflight.cjs", "package.json"]);
  try {
    fixture.write("scripts/ok_gate.cjs", "console.log('OK_PASS'); process.exit(0);");
    fixture.write("config/release-preflight-gates.json", JSON.stringify({ version: 1, profiles: { static: "x" }, gates: [{ id: "ok", category: "CODE", command: ["node", "scripts/ok_gate.cjs"], needs: "none", profiles: ["static"] }] }));
    spawnSync("git", ["init", "-q"], { cwd: fixture.root });
    const blocked = fixture.run("scripts/release_preflight.cjs", ["--profile", "static"]);
    assert.equal(blocked.status, 0, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /\[BLOCKED\] real-money-activation: BLOCKED by config\/real-money-release-policy\.json/);
    assert.match(blocked.stdout, /RELEASE_PREFLIGHT_RESULT technical=PASS real_money_activation=BLOCKED overall=PASS/);
    const governance = JSON.parse(fixture.read("config/real-money-release-policy.json"));
    governance.real_money_allowed = true;
    governance.status = "ALLOWED";
    fixture.write("config/real-money-release-policy.json", JSON.stringify(governance, null, 2));
    const allowed = fixture.run("scripts/release_preflight.cjs", ["--profile", "static"]);
    assert.match(allowed.stdout, /\[WARNING\] real-money-activation: ALLOWED by governance/);
    assert.doesNotMatch(allowed.stdout, /real_money_activation=PASS/);
  } finally {
    fixture.cleanup();
  }
});

test("preflight: a failing gate yields FAIL and exit 1; an environment failure yields SKIPPED_ENVIRONMENT and exit 0", () => {
  const fixture = createFixtureRepo(["scripts/lib", "config/release-preflight-gates.json", "config/real-money-release-policy.json", "config/runtime-environment-policy.json", "scripts/release_preflight.cjs", "package.json"]);
  try {
    fixture.write("scripts/fail_gate.cjs", "console.log('SOMETHING_FAIL'); console.log('AssertionError: expected 1 to equal 2'); process.exit(1);");
    fixture.write("scripts/env_gate.cjs", "console.log('Error: spawnSync docker EPERM'); process.exit(1);");
    fixture.write("scripts/ok_gate.cjs", "console.log('OK_PASS'); process.exit(0);");
    fixture.write("scripts/warn_gate.cjs", "console.log('X_SUMMARY overall=WARNING pass=1 fail=0 warning=1'); process.exit(0);");
    const catalogue = { version: 1, profiles: { static: "x" }, gates: [
      { id: "ok", category: "CODE", command: ["node", "scripts/ok_gate.cjs"], needs: "none", profiles: ["static"] },
      { id: "warn", category: "CODE", command: ["node", "scripts/warn_gate.cjs"], needs: "none", profiles: ["static"] },
      { id: "env", category: "INFRA", command: ["node", "scripts/env_gate.cjs"], needs: "none", profiles: ["static"] },
      { id: "needs-docker", category: "INFRA", command: ["node", "scripts/ok_gate.cjs"], needs: "docker", profiles: ["static"] },
      { id: "bad", category: "TESTS", command: ["node", "scripts/fail_gate.cjs"], needs: "none", profiles: ["static"] }
    ] };
    fixture.write("config/release-preflight-gates.json", JSON.stringify(catalogue));
    spawnSync("git", ["init", "-q"], { cwd: fixture.root });
    // The "needs docker -> SKIPPED_ENVIRONMENT" path must be exercised on
    // every machine. A GitHub runner HAS a Docker engine (the first CI run
    // failed exactly here: needs-docker ran and passed, skipped_environment=1),
    // so the capability is forced absent through the control seam instead of
    // assuming the developer laptop's environment.
    const noDocker = { SITON_PREFLIGHT_ASSUME_UNAVAILABLE: "docker" };
    const failing = fixture.run("scripts/release_preflight.cjs", ["--profile", "static"], noDocker);
    assert.equal(failing.status, 1, failing.stdout + failing.stderr);
    assert.match(failing.stdout, /docker=false/);
    assert.match(failing.stdout, /\[PASS\] ok/);
    assert.match(failing.stdout, /\[WARNING\] warn/);
    assert.match(failing.stdout, /\[SKIPPED_ENVIRONMENT\] env: could not run here: spawn-eperm/);
    assert.match(failing.stdout, /\[SKIPPED_ENVIRONMENT\] needs-docker: needs docker/);
    assert.match(failing.stdout, /\[FAIL\] bad: exit 1 \(FAILURE_CLASS=REAL_FAILURE/);
    assert.match(failing.stdout, /RELEASE_PREFLIGHT_FAIL/);
    const withoutBad = fixture.run("scripts/release_preflight.cjs", ["--profile", "static", "--skip", "bad"], noDocker);
    assert.equal(withoutBad.status, 0, withoutBad.stdout + withoutBad.stderr);
    assert.match(withoutBad.stdout, /RELEASE_PREFLIGHT_PASS/);
    assert.match(withoutBad.stdout, /skipped_environment=2/);
    // The seam can only REMOVE a capability: asking for a docker that is not
    // there changes nothing, and a present engine is honoured otherwise.
    const dockerReal = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status === 0;
    const natural = fixture.run("scripts/release_preflight.cjs", ["--profile", "static", "--skip", "bad"]);
    assert.match(natural.stdout, dockerReal ? /\[PASS\] needs-docker/ : /\[SKIPPED_ENVIRONMENT\] needs-docker/);
    const stopEarly = fixture.run("scripts/release_preflight.cjs", ["--profile", "static", "--stop-on-fail", "--only", "bad,ok"]);
    assert.equal(stopEarly.status, 1);
    assert.match(stopEarly.stdout, /stopping at first FAIL/);
    const unknownProfile = fixture.run("scripts/release_preflight.cjs", ["--profile", "nope"]);
    assert.equal(unknownProfile.status, 2);
  } finally {
    fixture.cleanup();
  }
});

// Adversarial gate outcomes through the REAL preflight. The first CI run
// mislabelled a nested test's fixture output ("spawnSync docker EPERM") as
// signals=spawn-eperm on a REAL assertion failure; these controls pin the
// structural rule: the harness's own spawn result decides first, text
// second, and a test-failure marker always dominates textual signals.
test("preflight classifies spawn refusal, missing executable, timeout, exit 1 and nested-noise assertion failures distinctly", () => {
  const fixture = createFixtureRepo(["scripts/lib", "config/release-preflight-gates.json", "config/real-money-release-policy.json", "config/runtime-environment-policy.json", "scripts/release_preflight.cjs", "package.json"]);
  try {
    fixture.write("scripts/exit1_gate.cjs", "console.log('nothing diagnostic here'); process.exit(1);");
    fixture.write("scripts/nested_noise_gate.cjs", [
      "console.log('[SKIPPED_ENVIRONMENT] env: could not run here: spawn-eperm (fixture output of a nested run)');",
      "console.log('Error: spawnSync docker EPERM');",
      "console.log('\\u2139 tests 3');",
      "console.log('\\u2139 pass 2');",
      "console.log('\\u2139 fail 1');",
      "process.exit(1);"
    ].join("\n"));
    fixture.write("scripts/genuine_env_gate.cjs", "console.log('error: connect ECONNREFUSED 127.0.0.1:5432'); process.exit(1);");
    fixture.write("scripts/hang_gate.cjs", "setTimeout(() => {}, 20000);");
    fixture.write("scripts/not-a-program.txt", "plain data, not a program\n");
    // A POSIX-only genuine spawn refusal: an unreadable/non-executable file
    // gives EACCES when spawned directly. Windows reports EFTYPE for a data
    // file (a missing/not-a-program condition), so that gate is POSIX-only.
    const posix = process.platform !== "win32";
    const gates = [
      { id: "exit1", category: "TESTS", command: ["node", "scripts/exit1_gate.cjs"], needs: "none", profiles: ["static"] },
      { id: "nested-noise", category: "TESTS", command: ["node", "scripts/nested_noise_gate.cjs"], needs: "none", profiles: ["static"] },
      { id: "genuine-env", category: "INFRA", command: ["node", "scripts/genuine_env_gate.cjs"], needs: "none", profiles: ["static"] },
      { id: "hang", category: "INFRA", command: ["node", "scripts/hang_gate.cjs"], needs: "none", profiles: ["static"], timeout_ms: 1500 },
      { id: "missing-exe", category: "INFRA", command: ["definitely-missing-executable-siton-xyz", "--version"], needs: "none", profiles: ["static"] },
      { id: "not-a-program", category: "INFRA", command: [path.join(fixture.root, "scripts", "not-a-program.txt")], needs: "none", profiles: ["static"] }
    ];
    fixture.write("config/release-preflight-gates.json", JSON.stringify({ version: 1, profiles: { static: "x" }, gates }));
    spawnSync("git", ["init", "-q"], { cwd: fixture.root });
    const result = fixture.run("scripts/release_preflight.cjs", ["--profile", "static"], { SITON_RELEASE_ARTIFACTS_DIR: path.join(fixture.root, ".release-artifacts") });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    // child exit 1 with no signal -> REAL failure
    assert.match(result.stdout, /\[FAIL\] exit1: exit 1 \(FAILURE_CLASS=REAL_FAILURE\)/);
    // nested test output that PRINTS an EPERM signal but reports a failed test -> REAL, signals ignored (not "signals=")
    assert.match(result.stdout, /\[FAIL\] nested-noise: exit 1 \(FAILURE_CLASS=REAL_FAILURE ignored_signals=spawn-eperm assertion_seen=true\)/);
    assert.doesNotMatch(result.stdout, /nested-noise: exit 1 \(FAILURE_CLASS=REAL_FAILURE signals=/);
    // a documented environment signal with no test-failure marker -> SKIPPED_ENVIRONMENT
    assert.match(result.stdout, /\[SKIPPED_ENVIRONMENT\] genuine-env: could not run here: postgres-unreachable/);
    // a hang -> FAIL as TIMEOUT, never environmental
    assert.match(result.stdout, /\[FAIL\] hang: timed out after 2s \(FAILURE_CLASS=TIMEOUT signals=spawn-timeout/);
    // a catalogue command whose program does not exist -> FAIL (repository/catalogue defect), never skipped
    assert.match(result.stdout, /\[FAIL\] missing-exe: executable not found for `definitely-missing-executable-siton-xyz --version` \(FAILURE_CLASS=EXECUTABLE_MISSING signals=executable-not-found error_code=ENOENT\)/);
    if (posix) {
      // spawning a data file: Linux says EACCES (refused) -> SKIPPED_ENVIRONMENT with the spawn named
      assert.match(result.stdout, /\[(SKIPPED_ENVIRONMENT|FAIL)\] not-a-program: /);
      const line = result.stdout.split(/\r?\n/).find((l) => /\] not-a-program: /.test(l));
      assert.ok(/SPAWN_REFUSED|spawn-eperm|EXECUTABLE_MISSING/.test(line), line);
    } else {
      assert.match(result.stdout, /\[FAIL\] not-a-program: executable not found for `[^`]*not-a-program\.txt` \(FAILURE_CLASS=EXECUTABLE_MISSING signals=executable-not-found error_code=EFTYPE\)/);
    }
    // The verdict buckets keep the two kinds apart: environment BLOCKED lists only the genuine one.
    assert.match(result.stdout, /BLOCKED\s+\d+\s+governance: real-money-activation; environment: genuine-env(?: not-a-program)?\s*$/m);
    const report = JSON.parse(fixture.read(".release-artifacts/release-preflight.json"));
    const byId = Object.fromEntries(report.items.map((item) => [item.id, item.status]));
    assert.equal(byId.exit1, "FAIL");
    assert.equal(byId["nested-noise"], "FAIL");
    assert.equal(byId["genuine-env"], "SKIPPED_ENVIRONMENT");
    assert.equal(byId.hang, "FAIL");
    assert.equal(byId["missing-exe"], "FAIL");
  } finally {
    fixture.cleanup();
  }
});

test("manifest and checklist generate for this checkout and mark a stale preflight honestly", () => {
  const manifest = run("release_manifest.cjs", ["--target", "test-target", "--image", "example/siton:test"]);
  assert.equal(manifest.status, 0, manifest.stdout + manifest.stderr);
  assert.match(manifest.stdout, /RELEASE_MANIFEST sha=/);
  const json = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, "release-manifest.json"), "utf8"));
  assert.equal(json.environment_target, "test-target");
  assert.equal(json.build.docker_image, "example/siton:test");
  assert.equal(json.real_money.allowed, false);
  assert.ok(json.migrations.count >= 59);
  assert.ok(json.migrations.checksums.every((row) => /^[0-9a-f]{64}$/.test(row.sha256_lf)));
  assert.match(fs.readFileSync(path.join(ARTIFACTS, "release-manifest.md"), "utf8"), /Real money \| BLOCKED/);

  const checklist = run("release_checklist.cjs");
  assert.equal(checklist.status, 0, checklist.stdout + checklist.stderr);
  assert.match(checklist.stdout, /## PAYMENTS/);
  assert.match(checklist.stdout, /\[ \] OPEN    \(owner \+ reviewer\) F-13/);
  assert.match(checklist.stdout, /\[ \] BLOCKED real-money-activation: BLOCKED by config\/real-money-release-policy\.json/);
  assert.match(checklist.stdout, /RELEASE_CHECKLIST proven=\d+ warning=\d+ fail=\d+ blocked=[1-9]\d* skipped=\d+ open=\d+/);

  // Stale detection: rewrite the preflight report's sha and regenerate.
  const reportPath = path.join(ARTIFACTS, "release-preflight.json");
  const original = fs.readFileSync(reportPath, "utf8");
  try {
    const tampered = JSON.parse(original);
    tampered.meta.sha = "0000000000000000000000000000000000000000";
    fs.writeFileSync(reportPath, JSON.stringify(tampered));
    const stale = run("release_manifest.cjs");
    assert.match(stale.stdout, /preflight=\w+\(STALE\)/);
    const staleChecklist = run("release_checklist.cjs");
    assert.match(staleChecklist.stdout, /release:preflight has not run for this SHA/);
  } finally {
    fs.writeFileSync(reportPath, original);
  }
});

test("owner check with --reuse prints the concise block and never says YES for real money", () => {
  run("release_preflight.cjs", ["--profile", "static", "--only", "typescript,no-real-money-proof"]);
  const owner = run("release_owner_check.cjs", ["--reuse"]);
  assert.match(owner.stdout, /SITON RELEASE READINESS/);
  assert.match(owner.stdout, /Real money:\s+BLOCKED/);
  assert.match(owner.stdout, /READY FOR REAL MONEY:\s+NO/);
  assert.match(owner.stdout, /READY FOR CODE DEPLOY: (YES|NO)/);
  assert.match(owner.stdout, /RELEASE_OWNER_CHECK code_deploy=(YES|NO) real_money=NO/);
});
