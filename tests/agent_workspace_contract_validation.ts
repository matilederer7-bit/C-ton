import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/agent_workspace.cjs", "plan"], {
  encoding: "utf8",
  env: process.env
});

assert.equal(result.status, 0, result.stderr || "agent workspace plan must exit 0");
const output = String(result.stdout || "");
assert.match(output, /AGENT_WORKTREE_PLAN version=1/);
assert.match(output, /AGENT_WORKTREE_TARGET agent=codex\b/);
assert.match(output, /AGENT_WORKTREE_TARGET agent=claude\b/);
assert.match(output, /task_prefix=agent\/codex\//);
assert.match(output, /task_prefix=agent\/claude\//);
assert.match(output, /overwrite_existing_path=false/);
assert.match(output, /discard_uncommitted=false/);
assert.match(output, /force_push=false/);
assert.match(output, /remote_branch_collision=false/);
assert.match(output, /unicode_task_names=true/);

const hebrewSlug = spawnSync(
  process.execPath,
  ["scripts/agent_workspace.cjs", "slug", "תיקון", "תמונות", "מוכר"],
  { encoding: "utf8", env: process.env }
);
assert.equal(hebrewSlug.status, 0, hebrewSlug.stderr || "Hebrew task name normalization must exit 0");
assert.equal(String(hebrewSlug.stdout || "").trim(), "AGENT_TASK_SLUG תיקון-תמונות-מוכר");

const source = readFileSync("scripts/agent_workspace.cjs", "utf8");
assert.match(source, /worktree.*add/s);
assert.match(source, /status.*--porcelain/s);
assert.match(source, /origin\/master/);
assert.match(source, /ls-remote.*--heads/s);
assert.match(source, /refusing to overwrite existing non-worktree path/);
assert.match(source, /refusing to switch .* workspace because it has uncommitted changes/);
assert.match(source, /task branch already exists locally or on origin/);
assert.doesNotMatch(source, /reset\s+--hard/);
assert.doesNotMatch(source, /push[^\n]*--force/);

console.log("AGENT_WORKSPACE_CONTRACT_PASS agents=2 isolated_paths=pass clean_guard=pass remote_collision_guard=pass unicode_task_names=pass destructive_reset=absent");
