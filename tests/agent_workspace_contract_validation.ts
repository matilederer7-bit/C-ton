import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const plan = spawnSync(process.execPath, ["scripts/agent_workspace.cjs", "plan"], {
  encoding: "utf8",
  env: process.env
});

assert.equal(plan.status, 0, plan.stderr || "agent workspace plan must exit 0");
const output = String(plan.stdout || "");
assert.match(output, /AGENT_WORKTREE_PLAN version=2/);
assert.match(output, /AGENT_WORKTREE_TARGET agent=codex\b/);
assert.match(output, /AGENT_WORKTREE_TARGET agent=claude\b/);
assert.match(output, /task_prefix=agent\/codex\//);
assert.match(output, /task_prefix=agent\/claude\//);
assert.match(output, /overwrite_existing_path=false/);
assert.match(output, /discard_uncommitted=false/);
assert.match(output, /force_push=false/);
assert.match(output, /remote_branch_collision=false/);
assert.match(output, /remote_lookup_fail_closed=true/);
assert.match(output, /unicode_task_names=true/);
assert.match(output, /canonical_root_from_any_worktree=true/);
assert.match(output, /finish_requires_pushed_head=true/);

const hebrewSlug = spawnSync(
  process.execPath,
  ["scripts/agent_workspace.cjs", "slug", "תיקון", "תמונות", "מוכר"],
  { encoding: "utf8", env: process.env }
);
assert.equal(hebrewSlug.status, 0, hebrewSlug.stderr || "Hebrew task name normalization must exit 0");
assert.equal(String(hebrewSlug.stdout || "").trim(), "AGENT_TASK_SLUG תיקון-תמונות-מוכר");

const cliHelp = spawnSync(process.execPath, ["scripts/agent.cjs", "help"], {
  encoding: "utf8",
  env: process.env
});
assert.equal(cliHelp.status, 0, cliHelp.stderr || "agent CLI help must exit 0");
assert.match(String(cliHelp.stdout || ""), /start <codex\|claude> <task>/);
assert.match(String(cliHelp.stdout || ""), /review <codex\|claude> <PR\|commit\|branch>/);
assert.match(String(cliHelp.stdout || ""), /finish <codex\|claude>/);
assert.match(String(cliHelp.stdout || ""), /doctor/);

const review = spawnSync(
  process.execPath,
  ["scripts/agent.cjs", "review", "claude", "PR #17"],
  { encoding: "utf8", env: process.env }
);
assert.equal(review.status, 0, review.stderr || "review shortcut must exit 0");
assert.match(String(review.stdout || ""), /^DONE/m);
assert.match(String(review.stdout || ""), /AGENT=claude/);
assert.match(String(review.stdout || ""), /REVIEW: PR #17/);
assert.match(String(review.stdout || ""), /read actual diff/);

const handoff = spawnSync(
  process.execPath,
  ["scripts/agent.cjs", "handoff", "PR #17"],
  { encoding: "utf8", env: process.env }
);
assert.equal(handoff.status, 0, handoff.stderr || "handoff shortcut must exit 0");
assert.match(String(handoff.stdout || ""), /^DONE/m);
assert.match(String(handoff.stdout || ""), /HANDOFF=PR #17/);
assert.match(String(handoff.stdout || ""), /SOURCE_OF_TRUTH=PR\/commit diff and checks/);

const source = readFileSync("scripts/agent_workspace.cjs", "utf8");
assert.match(source, /worktree.*add/s);
assert.match(source, /status.*--porcelain/s);
assert.match(source, /origin\/master/);
assert.match(source, /ls-remote.*--heads/s);
assert.match(source, /unable to verify remote branch state/);
assert.match(source, /--git-common-dir/);
assert.match(source, /refusing to overwrite existing non-worktree path/);
assert.match(source, /refusing to switch .* workspace because it has uncommitted changes/);
assert.match(source, /task branch already exists locally or on origin/);
assert.match(source, /branch is not pushed to origin/);
assert.match(source, /local branch is not fully pushed/);
assert.match(source, /AGENT_DOCTOR_RESULT DECISION_NEEDED/);
assert.doesNotMatch(source, /reset\s+--hard/);
assert.doesNotMatch(source, /push[^\n]*--force/);

const cliSource = readFileSync("scripts/agent.cjs", "utf8");
assert.match(cliSource, /setup/);
assert.match(cliSource, /status/);
assert.match(cliSource, /doctor/);
assert.match(cliSource, /start/);
assert.match(cliSource, /review/);
assert.match(cliSource, /handoff/);
assert.match(cliSource, /finish/);
assert.match(cliSource, /result\.signal/);
assert.match(cliSource, /workspace helper terminated by signal/);
assert.match(cliSource, /workspace helper did not return an exit status/);

console.log("AGENT_WORKSPACE_CONTRACT_PASS agents=2 isolated_paths=pass clean_guard=pass remote_collision_guard=pass remote_lookup_fail_closed=pass unicode_task_names=pass canonical_root=pass single_command=pass reviewer_handoff=pass finish_pushed_head_guard=pass abnormal_helper_exit_guard=pass destructive_reset=absent");
