// Controls for the flake classifier, the classified runner and the process
// cleanup guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT } = require("./support/fixture_repo.cjs");
const { classifyFailure } = require("../../scripts/lib/flake_classifier.cjs");
const guardLib = require("../../scripts/lib/process_cleanup_guard.cjs");

test("classifier: environment signals vs real failures", () => {
  assert.equal(classifyFailure("Error: spawnSync docker EPERM").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("docker: command not found").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("Error: listen EADDRINUSE: address already in use 127.0.0.1:3000").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("error: connect ECONNREFUSED 127.0.0.1:5432").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("FATAL: too many clients already").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("ERROR: database \"siton_test_1\" is being accessed by other users").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("Error: EBUSY: resource busy or locked, unlink 'x'").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("Error: spawnSync npx.cmd ENOENT").kind, "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("AssertionError [ERR_ASSERTION]: expected 200 to equal 500").kind, "REAL_FAILURE");
  assert.equal(classifyFailure("TEST_FAIL file=x.ts reason=exit 1").kind, "REAL_FAILURE");
  // An assertion next to an environment signal stays real.
  assert.equal(classifyFailure("AssertionError: boom\nError: listen EADDRINUSE").kind, "REAL_FAILURE");
  assert.equal(classifyFailure("").kind, "REAL_FAILURE");
});

test("classified runner preserves the exit code, classifies, and reruns only with the explicit flag", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siton-classified-"));
  try {
    const envFail = path.join(tmp, "envfail.cjs");
    fs.writeFileSync(envFail, "const fs=require('fs');const marker=process.argv[2];if(fs.existsSync(marker)){console.log('second run ok');process.exit(0);}fs.writeFileSync(marker,'1');console.log('Error: listen EADDRINUSE 127.0.0.1:3000');process.exit(1);");
    const realFail = path.join(tmp, "realfail.cjs");
    fs.writeFileSync(realFail, "console.log('AssertionError: expected 1 to equal 2');process.exit(3);");
    const runner = path.join(REPO_ROOT, "scripts", "qa_run_classified.cjs");

    const real = spawnSync(process.execPath, [runner, process.execPath, realFail], { cwd: tmp, encoding: "utf8" });
    assert.equal(real.status, 3);
    assert.match(real.stdout, /FAILURE_CLASS=REAL_FAILURE/);

    const marker = path.join(tmp, "marker");
    const noRerun = spawnSync(process.execPath, [runner, process.execPath, envFail, marker], { cwd: tmp, encoding: "utf8" });
    assert.equal(noRerun.status, 1, "no rerun without the flag");
    assert.match(noRerun.stdout, /FAILURE_CLASS=ENVIRONMENT_FAILURE signals=port-in-use/);
    assert.doesNotMatch(noRerun.stdout, /CORRECTIVE_RERUN/);
    fs.rmSync(marker, { force: true });

    const withRerun = spawnSync(process.execPath, [runner, "--rerun-once-on-environment-failure", process.execPath, envFail, marker], { cwd: tmp, encoding: "utf8" });
    assert.equal(withRerun.status, 0);
    assert.match(withRerun.stdout, /CORRECTIVE_RERUN requested by operator flag/);
    assert.match(withRerun.stdout, /second run ok/);
    const artifactDir = path.join(tmp, ".release-artifacts");
    const newest = fs.readdirSync(artifactDir).map((name) => path.join(artifactDir, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const artifact = JSON.parse(fs.readFileSync(newest, "utf8"));
    assert.equal(artifact.records.length, 2);
    assert.equal(artifact.records[1].kind, "CORRECTIVE_RERUN");

    // A real failure is never rerun even with the flag.
    const realWithFlag = spawnSync(process.execPath, [runner, "--rerun-once-on-environment-failure", process.execPath, realFail], { cwd: tmp, encoding: "utf8" });
    assert.equal(realWithFlag.status, 3);
    assert.doesNotMatch(realWithFlag.stdout, /CORRECTIVE_RERUN/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("process guard tracks and kills only its own children and reports occupied ports", async () => {
  const guard = guardLib.createProcessGuard({ label: "test" });
  const sleeper = guard.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const unrelated = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(guard.alive().length, 1);
    assert.equal(guard.alive()[0].pid, sleeper.pid);
    const server = require("node:net").createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const diagnostics = await guard.diagnostics({ ports: [port] });
    assert.deepEqual(diagnostics.occupied_ports, [port]);
    server.close();
    const killed = guard.killOwned();
    assert.equal(killed.length, 1);
    assert.equal(killed[0].pid, sleeper.pid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(guardLib.pidAlive(unrelated.pid), true, "unrelated process must survive");
    assert.equal(guard.alive().length, 0);
  } finally {
    try { unrelated.kill(); } catch { /* ignore */ }
    try { sleeper.kill(); } catch { /* ignore */ }
  }
});

test("qa diagnose CLI is read-only and exits 0", () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "qa_process_guard.cjs"), "--diagnose"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /QA_DIAGNOSE/);
  const dry = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "qa_process_guard.cjs"), "--cleanup-stale-dbs"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60000 });
  if (process.env.DATABASE_URL) {
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /mode=DRY_RUN/);
    assert.match(dry.stdout, /add --yes to drop/);
  }
});
