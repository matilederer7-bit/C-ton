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

function ensureGitAvailable() {
  try {
    git(["--version"]);
  } catch {
    throw new Error("git is required and was not found on PATH");
  }
}

function canonicalRepoRoot() {
  ensureGitAvailable();
  const currentRoot = git(["rev-parse", "--show-toplevel"]);
  const commonDir = git(["rev-parse", "--git-common-dir"], { cwd: currentRoot });
  const absoluteCommonDir = path.resolve(currentRoot, commonDir);
  if (path.basename(absoluteCommonDir) === ".git") return path.dirname(absoluteCommonDir);
  return currentRoot;
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
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 80)
    .replace(/[.-]+$/g, "");
  if (!slug) throw new Error("task name is required and must contain letters or digits");
  if (slug.endsWith(".lock")) throw new Error("task name must not end with .lock");
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

function remoteBranchSha(repoRoot, branch) {
  try {
    const text = git(["ls-remote", "--heads", "origin", branch], { cwd: repoRoot });
    return text ? text.split(/\s+/)[0] : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to verify remote branch state for ${branch}: ${detail}`);
  }
}

function remoteBranchExists(repoRoot, branch) {
  return Boolean(remoteBranchSha(repoRoot, branch));
}

function workspaceEntry(repoRoot, agent) {
  const target = workspacePath(repoRoot, agent);
  return parseWorktrees(repoRoot).find((entry) => path.resolve(entry.path) === path.resolve(target)) || null;
}

function workspaceDirty(target) {
  return Boolean(git(["status", "--porcelain"], { cwd: target }));
}

function ensureWorkspace(repoRoot, agent) {
  const target = workspacePath(repoRoot, agent);
  const existing = workspaceEntry(repoRoot, agent);
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
  const repoRoot = canonicalRepoRoot();
  fetchMaster(repoRoot);
  ensureWorkspace(repoRoot, "codex");
  ensureWorkspace(repoRoot, "claude");
  status(repoRoot);
  console.log("AGENT_WORKTREE_SETUP_PASS agents=2 isolation=separate_paths separate_branches");
}

function status(repoRoot = canonicalRepoRoot()) {
  const entries = parseWorktrees(repoRoot);
  for (const item of entries) {
    let dirty = "unknown";
    try {
      dirty = String(workspaceDirty(item.path));
    } catch {}
    console.log(`AGENT_WORKTREE path=${item.path} branch=${item.branch || "detached"} head=${item.head || "unknown"} dirty=${dirty}`);
  }
  for (const agent of ["codex", "claude"]) {
    const expected = workspacePath(repoRoot, agent);
    const item = entries.find((entry) => path.resolve(entry.path) === path.resolve(expected));
    console.log(`AGENT_WORKSPACE_STATUS agent=${agent} present=${Boolean(item)} path=${expected} branch=${item?.branch || "missing"}`);
  }
}

function startTask(agent, rawName) {
  ensureAgent(agent);
  const slug = normalizeSlug(rawName);
  const repoRoot = canonicalRepoRoot();
  const target = workspacePath(repoRoot, agent);
  const worktree = workspaceEntry(repoRoot, agent);
  if (!worktree) throw new Error(`agent worktree missing for ${agent}; run node scripts/agent.cjs setup first`);

  if (workspaceDirty(target)) throw new Error(`refusing to switch ${agent} workspace because it has uncommitted changes`);

  fetchMaster(repoRoot);
  const branch = taskBranch(agent, slug);
  if (branchExists(repoRoot, branch) || remoteBranchExists(repoRoot, branch)) {
    throw new Error(`task branch already exists locally or on origin: ${branch}`);
  }
  git(["switch", "-c", branch, "origin/master"], { cwd: target, stdio: "inherit" });
  console.log(`AGENT_TASK_READY agent=${agent} branch=${branch} path=${target} base=origin/master`);
}

function finish(agent) {
  ensureAgent(agent);
  const repoRoot = canonicalRepoRoot();
  const target = workspacePath(repoRoot, agent);
  const worktree = workspaceEntry(repoRoot, agent);
  if (!worktree) throw new Error(`agent worktree missing for ${agent}`);
  if (workspaceDirty(target)) throw new Error(`DECISION_NEEDED ${agent} workspace has uncommitted changes; commit or intentionally resolve them before finish`);

  const branch = git(["branch", "--show-current"], { cwd: target });
  if (!branch) throw new Error(`DECISION_NEEDED ${agent} workspace is detached`);
  if (branch === "master") throw new Error(`refusing to finish from master in ${agent} workspace`);
  if (branch === standbyBranch(agent)) {
    console.log(`AGENT_FINISH_PASS agent=${agent} branch=${branch} already_standby=true`);
    return;
  }

  const localSha = git(["rev-parse", "HEAD"], { cwd: target });
  const remoteSha = remoteBranchSha(repoRoot, branch);
  if (!remoteSha) throw new Error(`DECISION_NEEDED branch is not pushed to origin: ${branch}`);
  if (remoteSha !== localSha) throw new Error(`DECISION_NEEDED local branch is not fully pushed: ${branch}`);

  git(["switch", standbyBranch(agent)], { cwd: target, stdio: "inherit" });
  console.log(`AGENT_FINISH_PASS agent=${agent} completed_branch=${branch} pushed_sha=${localSha} standby=${standbyBranch(agent)}`);
}

function doctor() {
  const repoRoot = canonicalRepoRoot();
  const entries = parseWorktrees(repoRoot);
  const expected = ["codex", "claude"].map((agent) => ({ agent, path: workspacePath(repoRoot, agent) }));
  const missing = expected.filter(({ path: target }) => !entries.some((entry) => path.resolve(entry.path) === path.resolve(target)));
  if (missing.length) {
    console.log(`AGENT_DOCTOR_RESULT FAILED missing=${missing.map((item) => item.agent).join(",")} action="node scripts/agent.cjs setup"`);
    process.exitCode = 1;
    return;
  }

  const branches = entries.map((entry) => entry.branch).filter(Boolean);
  const duplicates = [...new Set(branches.filter((branch, index) => branches.indexOf(branch) !== index))];
  if (duplicates.length) {
    console.log(`AGENT_DOCTOR_RESULT FAILED branch_collision=${duplicates.join(",")}`);
    process.exitCode = 1;
    return;
  }

  const dirty = expected.filter(({ path: target }) => workspaceDirty(target));
  for (const item of expected) {
    const entry = entries.find((candidate) => path.resolve(candidate.path) === path.resolve(item.path));
    console.log(`AGENT_DOCTOR_WORKSPACE agent=${item.agent} path=${item.path} branch=${entry?.branch || "detached"} dirty=${workspaceDirty(item.path)}`);
  }
  if (dirty.length) {
    console.log(`AGENT_DOCTOR_RESULT DECISION_NEEDED dirty=${dirty.map((item) => item.agent).join(",")}`);
    process.exitCode = 2;
    return;
  }
  console.log("AGENT_DOCTOR_RESULT DONE worktrees=2 isolation=pass dirty=0 branch_collision=0");
}

function printPlan() {
  const repoRoot = canonicalRepoRoot();
  console.log("AGENT_WORKTREE_PLAN version=2");
  for (const agent of ["codex", "claude"]) {
    console.log(`AGENT_WORKTREE_TARGET agent=${agent} path=${workspacePath(repoRoot, agent)} standby_branch=${standbyBranch(agent)} task_prefix=agent/${agent}/`);
  }
  console.log("AGENT_WORKTREE_BOUNDARY overwrite_existing_path=false discard_uncommitted=false force_push=false remote_branch_collision=false remote_lookup_fail_closed=true unicode_task_names=true canonical_root_from_any_worktree=true finish_requires_pushed_head=true");
}

function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  if (command === "setup") return setup();
  if (command === "status") return status();
  if (command === "start") return startTask(args[0], args.slice(1).join(" "));
  if (command === "finish") return finish(args[0]);
  if (command === "doctor") return doctor();
  if (command === "slug") {
    console.log(`AGENT_TASK_SLUG ${normalizeSlug(args.join(" "))}`);
    return;
  }
  if (command === "--plan" || command === "plan") return printPlan();
  throw new Error("usage: agent_workspace.cjs setup | status | start <codex|claude> <task name> | finish <codex|claude> | doctor | slug <task name> | plan");
}

try {
  main();
} catch (error) {
  console.error(`AGENT_WORKSPACE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
