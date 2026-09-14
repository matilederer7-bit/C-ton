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
  assert.equal(report.items.length, 4);
  assert.ok(report.items.every((item) => ["PASS", "WARNING", "SKIPPED_ENVIRONMENT"].includes(item.status)), JSON.stringify(report.items));
  assert.ok(fs.existsSync(path.join(ARTIFACTS, "preflight", "typescript.log")));
  assert.match(fs.readFileSync(path.join(ARTIFACTS, "release-preflight.md"), "utf8"), /# release preflight/);
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
    const failing = fixture.run("scripts/release_preflight.cjs", ["--profile", "static"]);
    assert.equal(failing.status, 1, failing.stdout + failing.stderr);
    assert.match(failing.stdout, /\[PASS\] ok/);
    assert.match(failing.stdout, /\[WARNING\] warn/);
    assert.match(failing.stdout, /\[SKIPPED_ENVIRONMENT\] env: could not run here: spawn-eperm/);
    assert.match(failing.stdout, /\[FAIL\] bad: exit 1 \(FAILURE_CLASS=REAL_FAILURE/);
    assert.match(failing.stdout, /RELEASE_PREFLIGHT_FAIL/);
    const withoutBad = fixture.run("scripts/release_preflight.cjs", ["--profile", "static", "--skip", "bad"]);
    assert.equal(withoutBad.status, 0, withoutBad.stdout + withoutBad.stderr);
    assert.match(withoutBad.stdout, /RELEASE_PREFLIGHT_PASS/);
    assert.match(withoutBad.stdout, /skipped_environment=2/);
    const stopEarly = fixture.run("scripts/release_preflight.cjs", ["--profile", "static", "--stop-on-fail", "--only", "bad,ok"]);
    assert.equal(stopEarly.status, 1);
    assert.match(stopEarly.stdout, /stopping at first FAIL/);
    const unknownProfile = fixture.run("scripts/release_preflight.cjs", ["--profile", "nope"]);
    assert.equal(unknownProfile.status, 2);
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
  assert.match(checklist.stdout, /RELEASE_CHECKLIST proven=\d+ warning=\d+ fail=\d+ skipped=\d+ open=\d+/);

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
