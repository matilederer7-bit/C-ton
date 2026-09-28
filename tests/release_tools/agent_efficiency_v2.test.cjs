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

test("workspace v5 allocates repeat-task branches instead of colliding", () => {
  const source = read("scripts/agent_workspace.cjs");
  assert.match(source, /function uniqueTaskBranch\(/);
  assert.match(source, /attempt <= 99/);
  assert.match(source, /`\$\{base\}-r\$\{attempt\}`/);
  assert.match(source, /const branch = uniqueTaskBranch\(repo, agent, p\.task\)/);
  assert.match(source, /repeated_task_branch_suffix=true/);
});

test("workspace v5 task packets include only the active agent status slot", () => {
  const source = read("scripts/agent_workspace.cjs");
  assert.match(source, /function statusExcerpt\(target, agent\)/);
  assert.match(source, /CURRENT AGENT STATUS/);
  assert.match(source, /statusExcerpt\(target, agent\)/);
  assert.match(source, /task_packet_agent_status_only=true/);
  assert.doesNotMatch(source, /slice\(0, 24\)/);
});

test("workspace v5 proves GitHub push access at task start", () => {
  const source = read("scripts/agent_workspace.cjs");
  assert.match(source, /AGENT_START_PUSH_PASS/);
  assert.match(source, /start preflight remote SHA verification failed/);
  assert.match(source, /start_preflight_push=true/);
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

test("CI runs every test group exactly once per pipeline; the whole-pipeline repetition is the nightly run", () => {
  const workflow = read(".github/workflows/ci.yml");
  const { TEST_LANES } = require("../../scripts/ci_change_classifier.cjs");
  const { GROUPS } = require("../../scripts/run_test_group.cjs");
  // Lanes run `npm run test:<group>` for the groups the classifier's lane table lists.
  assert.match(workflow, /npm run "test:\$group"/);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.classify\.outputs\.groups\) \}\}/);
  const listed = TEST_LANES.flatMap((lane) => lane.groups.split(" "));
  assert.deepEqual([...new Set(listed)].sort(), [...GROUPS].sort());
  // No second, identical run of the ten groups inside the same pipeline.
  assert.doesNotMatch(workflow, /test:all/);
  assert.match(workflow, /schedule:\n\s+(#.*\n\s+)*- cron: "23 1 \* \* \*"/);
  // One verdict job gates everything.
  assert.match(workflow, /ci-verdict:\n\s+name: ci-verdict\n\s+needs: \[classify, static-gates, tests, focused-tests, web-runtime-core, web-runtime-resilience, docker-smoke, docker-release-lab, preflight-database\]\n\s+if: always\(\)/);
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
