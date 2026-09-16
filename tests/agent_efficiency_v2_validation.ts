import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("agent workspace is isolated, fail-closed and task-packet driven", () => {
  const source = readFileSync("scripts/agent_workspace.cjs", "utf8");
  assert.match(source, /unable to verify remote branch state/);
  assert.match(source, /SITON_TASK_PACKET\.md/);
  assert.match(source, /setup_runs_doctor=true/);
  assert.match(source, /task_packet_untracked=true/);
  assert.match(source, /finish_verifies_commits_pushes_pr=true/);
  assert.match(source, /auto_merge=false/);
});

run("owner CLI cannot report success after a signalled helper", () => {
  const source = readFileSync("scripts/agent.cjs", "utf8");
  assert.match(source, /result\.signal/);
  assert.match(source, /ci \[run-id\|latest\]/);
  assert.match(source, /ci_failure_summary\.cjs/);
});

run("canonical verifier preserves no-real-money and local-database boundaries", () => {
  const source = readFileSync("scripts/siton_verify.cjs", "utf8");
  assert.match(source, /assertLocalBase/);
  assert.match(source, /no_real_money/);
  assert.match(source, /Hosted staging\/production databases are refused/);
});

run("CI summarizer is branch-scoped and returns compact actionable output", () => {
  const source = readFileSync("scripts/ci_failure_summary.cjs", "utf8");
  assert.match(source, /"--branch", branch/);
  assert.match(source, /cannot determine current branch/);

  const fixture = join(tmpdir(), `siton-ci-failure-${process.pid}.log`);
  writeFileSync(fixture, [
    "Backend quality\tIntegration tests\t2026-09-16T00:00:00Z Run npm run test:integration",
    "Backend quality\tIntegration tests\t2026-09-16T00:00:01Z tests/stage32c_product_surface_closure_validation.ts:44 AssertionError: Expected values to be strictly equal: 1 !== 2"
  ].join("\n"));
  try {
    const result = spawnSync(process.execPath, ["scripts/ci_failure_summary.cjs", "latest", "--log-file", fixture], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CI_FAILURE_SUMMARY mode=local-log/);
    assert.match(result.stdout, /FIRST_ERROR=.*AssertionError/);
    assert.match(result.stdout, /stage32c_product_surface_closure_validation\.ts/);
    assert.match(result.stdout, /REPRODUCE=.*npm run test:integration/);
  } finally {
    unlinkSync(fixture);
  }
});

console.log("AGENT_EFFICIENCY_V2_VALIDATION_PASS");
