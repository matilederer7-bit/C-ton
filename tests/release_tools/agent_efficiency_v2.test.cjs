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

test("workspace v3 isolates status writes and keeps open PR context", () => {
  const source = read("scripts/agent_workspace.cjs");
  const status = read("PROJECT_STATUS.md");
  assert.match(source, /AGENT_STATUS:\$\{agent\}:START/);
  assert.match(source, /isolated_status_slots=true/);
  assert.match(source, /task_branch_retained_until_pr_resolved=true/);
  assert.match(source, /next_start_releases_merged_or_closed=true/);
  assert.match(source, /active .* task PR is still open/);
  assert.match(source, /retained_for_pr=true/);
  assert.match(status, /AGENT_STATUS:claude:START/);
  assert.match(status, /AGENT_STATUS:claude:END/);
  assert.match(status, /AGENT_STATUS:codex:START/);
  assert.match(status, /AGENT_STATUS:codex:END/);
});

test("Claude Code has a compact repository entry point into canonical agent rules", () => {
  const claude = read("CLAUDE.md");
  assert.match(claude, /AGENTS\.md/);
  assert.match(claude, /AI_WORKFLOW\.md/);
  assert.match(claude, /PROJECT_STATUS\.md/);
  assert.match(claude, /Do not ask the owner to repeat rules already defined in those files/);
  assert.match(claude, /Do not burn time or credits on authentication loops/);
  assert.match(claude, /Push checkpoint rule/);
  assert.match(claude, /verify the remote SHA/);
});

test("agent rules make early preflight and checkpoint pushes binding", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /### Push checkpoint rule/);
  assert.match(agents, /push the branch before substantial implementation/);
  assert.match(agents, /verify the remote SHA/);
  assert.match(agents, /never exist only inside a session container/);
});

test("pull request backend CI runs every test group once, not twice", () => {
  const workflow = read(".github/workflows/backend-quality-gates.yml");
  for (const script of ["test:unit", "test:integration", "test:db", "test:api", "test:workers", "test:payments", "test:security", "test:concurrency", "test:failure", "test:e2e"]) {
    assert.match(workflow, new RegExp(`npm run ${script.replace(":", "\\:")}`));
  }
  assert.match(workflow, /- name: Complete repository suite\n\s+if: github\.event_name == 'push'\n\s+run: npm run test:all/);
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
