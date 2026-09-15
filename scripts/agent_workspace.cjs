#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"]
  }).trim();
}

function root() {
  return git(["rev-parse", "--show-toplevel"]);
}

function repoName(repoRoot) {
  return path.basename(repoRoot);
}

function workspacePath(repoRoot, agent) {
  return path.join(path.dirname(repoRoot), `${repoName(repoRoot)}-${agent}`);
}

function standbyBranch(agent) {
  return `workspace/${agent}`;
}

function taskBranch(agent, slug) {
  return `agent/${agent}/${slug}`;
}

function normalizeSlug(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error("task slug is required and must contain letters or digits");
  return slug;
}

function parseWorktrees(repoRoot) {
  const text = git(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, head: null };
      entries.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    }
  }
  return entries;
}

function ensureGitAvailable() {
  try {
    git(["--version"]);
  } catch {
    throw new Error("git is required and was not found on PATH");
  }
}

function ensureAgent(agent) {
  if (!["codex", "claude"].includes(agent)) throw new Error("agent must be codex or claude");
}

function fetchMaster(repoRoot) {
  git(["fetch", "origin", "master", "--prune"], { cwd: repoRoot, stdio: "inherit" });
}

function branchExists(repoRoot, branch) {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function remoteBranchExists(repoRoot, branch) {
  try {
    git(["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function ensureWorkspace(repoRoot, agent) {
  const target = workspacePath(repoRoot, agent);
  const existing = parseWorktrees(repoRoot).find((item) => path.resolve(item.path) === path.resolve(target));
  if (existing) {
    console.log(`AGENT_WORKTREE_PRESENT agent=${agent} path=${target} branch=${existing.branch || "detached"}`);
    return;
  }
  if (fs.existsSync(target)) {
    throw new Error(`refusing to overwrite existing non-worktree path: ${target}`);
  }

  const branch = standbyBranch(agent);
  if (branchExists(repoRoot, branch)) {
    git(["worktree", "add", target, branch], { cwd: repoRoot, stdio: "inherit" });
  } else {
    git(["worktree", "add", "-b", branch, target, "origin/master"], { cwd: repoRoot, stdio: "inherit" });
  }
  console.log(`AGENT_WORKTREE_CREATED agent=${agent} path=${target} branch=${branch}`);
}

function setup() {
  ensureGitAvailable();
  const repoRoot = root();
  fetchMaster(repoRoot);
  ensureWorkspace(repoRoot, "codex");
  ensureWorkspace(repoRoot, "claude");
  status(repoRoot);
  console.log("AGENT_WORKTREE_SETUP_PASS agents=2 isolation=separate_paths separate_branches");
}

function status(repoRoot = root()) {
  ensureGitAvailable();
  const entries = parseWorktrees(repoRoot);
  for (const item of entries) {
    console.log(`AGENT_WORKTREE path=${item.path} branch=${item.branch || "detached"} head=${item.head || "unknown"}`);
  }
  for (const agent of ["codex", "claude"]) {
    const expected = workspacePath(repoRoot, agent);
    const item = entries.find((entry) => path.resolve(entry.path) === path.resolve(expected));
    console.log(`AGENT_WORKSPACE_STATUS agent=${agent} present=${Boolean(item)} path=${expected} branch=${item?.branch || "missing"}`);
  }
}

function startTask(agent, rawSlug) {
  ensureGitAvailable();
  ensureAgent(agent);
  const slug = normalizeSlug(rawSlug);
  const repoRoot = root();
  const target = workspacePath(repoRoot, agent);
  const worktree = parseWorktrees(repoRoot).find((entry) => path.resolve(entry.path) === path.resolve(target));
  if (!worktree) throw new Error(`agent worktree missing for ${agent}; run node scripts/agent_workspace.cjs setup first`);

  const dirty = git(["status", "--porcelain"], { cwd: target });
  if (dirty) throw new Error(`refusing to switch ${agent} workspace because it has uncommitted changes`);

  fetchMaster(repoRoot);
  const branch = taskBranch(agent, slug);
  if (branchExists(repoRoot, branch) || remoteBranchExists(repoRoot, branch)) {
    throw new Error(`task branch already exists locally or on origin: ${branch}`);
  }
  git(["switch", "-c", branch, "origin/master"], { cwd: target, stdio: "inherit" });
  console.log(`AGENT_TASK_READY agent=${agent} branch=${branch} path=${target} base=origin/master`);
}

function printPlan() {
  const repoRoot = root();
  console.log("AGENT_WORKTREE_PLAN version=1");
  for (const agent of ["codex", "claude"]) {
    console.log(`AGENT_WORKTREE_TARGET agent=${agent} path=${workspacePath(repoRoot, agent)} standby_branch=${standbyBranch(agent)} task_prefix=agent/${agent}/`);
  }
  console.log("AGENT_WORKTREE_BOUNDARY overwrite_existing_path=false discard_uncommitted=false force_push=false remote_branch_collision=false");
}

function main() {
  const [command = "status", agent, slug] = process.argv.slice(2);
  if (command === "setup") return setup();
  if (command === "status") return status();
  if (command === "start") return startTask(agent, slug);
  if (command === "--plan" || command === "plan") return printPlan();
  throw new Error("usage: agent_workspace.cjs setup | status | start <codex|claude> <task-slug> | plan");
}

try {
  main();
} catch (error) {
  console.error(`AGENT_WORKSPACE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
