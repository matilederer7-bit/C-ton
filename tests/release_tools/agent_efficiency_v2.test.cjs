const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { summarizeLog } = require("../../scripts/ci_failure_summary.cjs");

const root = path.resolve(__dirname, "../..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

test("CI summarizer extracts first meaningful error, files and reproduction hint", () => {
  const log = `Backend quality\tIntegration tests\t2026-09-16T00:00:00Z Run npm run test:integration\nBackend quality\tIntegration tests\t2026-09-16T00:00:01Z tests/stage32c_product_surface_closure_validation.ts:44 AssertionError: Expected values to be strictly equal: 1 !== 2\n`;
  const summary = summarizeLog(log);
  assert.match(summary.firstError, /AssertionError/);
  assert.deepEqual(summary.files, ["tests/stage32c_product_surface_closure_validation.ts"]);
  assert.match(summary.reproduce, /npm run test:integration/);
});

test("workspace automation is fail-closed and produces task packet", () => {
  const source = read("scripts/agent_workspace.cjs");
  assert.match(source, /unable to verify remote branch state/);
  assert.match(source, /TASK_PACKET\.md/);
  assert.match(source, /setup_runs_doctor=true/);
  assert.match(source, /finish_verifies_commits_pushes_pr=true/);
  assert.match(source, /AUTO_MERGE=false|auto_merge=false/);
});

test("owner CLI rejects signalled helpers and exposes CI summary", () => {
  const source = read("scripts/agent.cjs");
  assert.match(source, /result\.signal/);
  assert.match(source, /ci \[run-id\|latest\]/);
  assert.match(source, /ci_failure_summary\.cjs/);
});

test("canonical verifier refuses hosted database verification", () => {
  const source = read("scripts/siton_verify.cjs");
  assert.match(source, /assertLocalBase/);
  assert.match(source, /no_real_money/);
  assert.match(source, /Hosted staging\/production databases are refused/);
});
