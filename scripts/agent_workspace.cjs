#!/usr/bin/env node

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"]
  }).trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by signal ${result.signal}`);
  if (typeof result.status !== "number") throw new Error(`${command} did not return an exit status`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed with exit ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function ensureGitAvailable() {
  try { git(["--version"]); } catch { throw new Error("git is required and was not found on PATH"); }
}

function canonicalRepoRoot() {
  ensureGitAvailable();
  const currentRoot = git(["rev-parse", "--show-toplevel"]);
  const commonDir = git(["rev-parse", "--git-common-dir"], { cwd: currentRoot });
  const absoluteCommonDir = path.resolve(currentRoot, commonDir);
  if (path.basename(absoluteCommonDir) === ".git") return path.dirname(absoluteCommonDir);
  return currentRoot;
}

function repoName(repoRoot) { return path.basename(repoRoot); }
function workspacePath(repoRoot, agent) { return path.join(path.dirname(repoRoot), `${repoName(repoRoot)}-${agent}`); }
function standbyBranch(agent) { return `workspace/${agent}`; }
function taskBranch(agent, slug) { return `agent/${agent}/${slug}`; }

function normalizeSlug(value) {
  const slug = String(value || "").normalize("NFKC").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".").slice(0, 80).replace(/[.-]+$/g, "");
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
      current = { path: line.slice(9), branch: null, head: null };
      entries.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) current.branch = line.slice(18);
    else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
  }
  return entries;
}

function ensureAgent(agent) {
  if (!["codex", "claude"].includes(agent)) throw new Error("agent must be codex or claude");
}

function fetchMaster(repoRoot) { git(["fetch", "origin", "master", "--prune"], { cwd: repoRoot, stdio: "inherit" }); }
function branchExists(repoRoot, branch) {
  try { git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot }); return true; }
  catch { return false; }
}
function remoteBranchSha(repoRoot, branch) {
  try {
    const text = git(["ls-remote", "--heads", "origin", branch], { cwd: repoRoot });
    return text ? text.split(/\s+/)[0] : null;
  } catch (error) {
    throw new Error(`unable to verify remote branch state for ${branch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function workspaceEntry(repoRoot, agent) {
  const target = workspacePath(repoRoot, agent);
  return parseWorktrees(repoRoot).find((entry) => path.resolve(entry.path) === path.resolve(target)) || null;
}
function workspaceDirty(target) { return Boolean(git(["status", "--porcelain"], { cwd: target })); }

function ensureWorkspace(repoRoot, agent) {
  const target = workspacePath(repoRoot, agent);
  const existing = workspaceEntry(repoRoot, agent);
  if (existing) { console.log(`AGENT_WORKTREE_PRESENT agent=${agent} path=${target} branch=${existing.branch || "detached"}`); return; }
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing non-worktree path: ${target}`);
  const branch = standbyBranch(agent);
  if (branchExists(repoRoot, branch)) git(["worktree", "add", target, branch], { cwd: repoRoot, stdio: "inherit" });
  else git(["worktree", "add", "-b", branch, target, "origin/master"], { cwd: repoRoot, stdio: "inherit" });
  console.log(`AGENT_WORKTREE_CREATED agent=${agent} path=${target} branch=${branch}`);
}

function doctor(repoRoot = canonicalRepoRoot()) {
  const entries = parseWorktrees(repoRoot);
  const expected = ["codex", "claude"].map((agent) => ({ agent, path: workspacePath(repoRoot, agent) }));
  const missing = expected.filter(({ path: target }) => !entries.some((entry) => path.resolve(entry.path) === path.resolve(target)));
  if (missing.length) throw new Error(`doctor missing worktrees: ${missing.map((item) => item.agent).join(",")}`);
  const branches = entries.map((entry) => entry.branch).filter(Boolean);
  const duplicates = [...new Set(branches.filter((branch, index) => branches.indexOf(branch) !== index))];
  if (duplicates.length) throw new Error(`doctor branch collision: ${duplicates.join(",")}`);
  const dirty = expected.filter(({ path: target }) => workspaceDirty(target));
  for (const item of expected) {
    const entry = entries.find((candidate) => path.resolve(candidate.path) === path.resolve(item.path));
    console.log(`AGENT_DOCTOR_WORKSPACE agent=${item.agent} path=${item.path} branch=${entry?.branch || "detached"} dirty=${workspaceDirty(item.path)}`);
  }
  if (dirty.length) throw new Error(`doctor dirty worktrees require decision: ${dirty.map((item) => item.agent).join(",")}`);
  console.log("AGENT_DOCTOR_RESULT DONE worktrees=2 isolation=pass dirty=0 branch_collision=0");
}

function setup() {
  const repoRoot = canonicalRepoRoot();
  fetchMaster(repoRoot);
  ensureWorkspace(repoRoot, "codex");
  ensureWorkspace(repoRoot, "claude");
  doctor(repoRoot);
  console.log("AGENT_WORKTREE_SETUP_PASS agents=2 doctor=pass one_time_setup=true");
}

function status(repoRoot = canonicalRepoRoot()) {
  const entries = parseWorktrees(repoRoot);
  for (const item of entries) {
    let dirty = "unknown";
    try { dirty = String(workspaceDirty(item.path)); } catch {}
    console.log(`AGENT_WORKTREE path=${item.path} branch=${item.branch || "detached"} head=${item.head || "unknown"} dirty=${dirty}`);
  }
}

function openStatusExcerpt(target) {
  const statusPath = path.join(target, "PROJECT_STATUS.md");
  if (!fs.existsSync(statusPath)) return "PROJECT_STATUS.md unavailable";
  const text = fs.readFileSync(statusPath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(0, 24).join("\n");
}

function writeTaskPacket(target, packet) {
  const dir = path.join(target, ".agent-runtime");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "TASK_PACKET.md");
  const body = `# SITON TASK PACKET\n\nTASK\n${packet.task}\n\nSCOPE\n${packet.scope}\n\nDO NOT TOUCH\n${packet.doNotTouch}\n\nMODE\n${packet.mode}\n\nBASE SHA\n${packet.baseSha}\n\nBRANCH\n${packet.branch}\n\nSTANDING CONTEXT\nRead AGENTS.md and only the current PROJECT_STATUS.md section needed for this task. Do not read archives or scan the whole repository unless evidence requires it.\n\nCURRENT STATUS EXCERPT\n${packet.statusExcerpt}\n\nFINISH CONTRACT\nRun the relevant tests. Use node scripts/agent.cjs finish ${packet.agent} with completion metadata. The finish command verifies, updates PROJECT_STATUS.md, commits, pushes and opens or updates the PR. Do not auto-merge.\n`;
  fs.writeFileSync(file, body, "utf8");
  return file;
}

function parseStartArgs(args) {
  const taskParts = [];
  let scope = "Minimal files necessary for the task; discover with targeted search only.";
  let doNotTouch = "Grow, real-money activation, unrelated product areas, other agent worktree.";
  let mode = "builder";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--scope") { scope = args[++i] || scope; continue; }
    if (arg === "--do-not-touch") { doNotTouch = args[++i] || doNotTouch; continue; }
    if (arg === "--mode") { mode = args[++i] || mode; continue; }
    taskParts.push(arg);
  }
  return { task: taskParts.join(" ").trim(), scope, doNotTouch, mode };
}

function startTask(agent, rawArgs) {
  ensureAgent(agent);
  const parsed = parseStartArgs(rawArgs);
  if (!parsed.task) throw new Error("task is required");
  const slug = normalizeSlug(parsed.task);
  const repoRoot = canonicalRepoRoot();
  const target = workspacePath(repoRoot, agent);
  if (!workspaceEntry(repoRoot, agent)) throw new Error(`agent worktree missing for ${agent}; run node scripts/agent.cjs setup first`);
  if (workspaceDirty(target)) throw new Error(`refusing to switch ${agent} workspace because it has uncommitted changes`);
  fetchMaster(repoRoot);
  const branch = taskBranch(agent, slug);
  if (branchExists(repoRoot, branch) || remoteBranchSha(repoRoot, branch)) throw new Error(`task branch already exists locally or on origin: ${branch}`);
  git(["switch", "-C", standbyBranch(agent), "origin/master"], { cwd: target, stdio: "inherit" });
  git(["switch", "-c", branch, "origin/master"], { cwd: target, stdio: "inherit" });
  const baseSha = git(["rev-parse", "HEAD"], { cwd: target });
  const packetPath = writeTaskPacket(target, {
    ...parsed, agent, branch, baseSha, statusExcerpt: openStatusExcerpt(target)
  });
  console.log(`AGENT_TASK_READY agent=${agent} branch=${branch} path=${target} base_sha=${baseSha}`);
  console.log(`TASK_PACKET=${packetPath}`);
  console.log(`TASK=${parsed.task}`);
  console.log(`SCOPE=${parsed.scope}`);
  console.log(`DO_NOT_TOUCH=${parsed.doNotTouch}`);
  console.log(`MODE=${parsed.mode}`);
}

function parseFinishArgs(args) {
  const out = { message: "", completed: "", tested: "", open: "", percentage: "", next: "" };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const map = { "--message": "message", "--completed": "completed", "--tested": "tested", "--open": "open", "--percentage": "percentage", "--next": "next" };
    if (map[key]) out[map[key]] = args[++i] || "";
  }
  return out;
}

function requireFinishMetadata(meta) {
  const missing = ["completed", "tested", "open", "percentage", "next"].filter((key) => !meta[key]);
  if (missing.length) throw new Error(`finish metadata missing: ${missing.join(", ")}`);
}

function updateProjectStatus(target, agent, branch, meta) {
  const statusPath = path.join(target, "PROJECT_STATUS.md");
  const current = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf8").replace(/\s+$/u, "") : "# PROJECT STATUS";
  const now = new Date().toISOString();
  const block = `\n\n## Agent milestone ${now}\n\n- AGENT: ${agent}\n- BRANCH: ${branch}\n- COMPLETED: ${meta.completed}\n- TESTED: ${meta.tested}\n- OPEN: ${meta.open}\n- PERCENTAGE: ${meta.percentage}\n- NEXT STEP: ${meta.next}\n`;
  fs.writeFileSync(statusPath, `${current}${block}`, "utf8");
}

function ensureGh() {
  const result = run("gh", ["--version"], { allowFailure: true });
  if (result.status !== 0) throw new Error("GitHub CLI gh is required for automatic PR finish");
}

function finish(agent, rawArgs) {
  ensureAgent(agent);
  const meta = parseFinishArgs(rawArgs);
  requireFinishMetadata(meta);
  const repoRoot = canonicalRepoRoot();
  const target = workspacePath(repoRoot, agent);
  if (!workspaceEntry(repoRoot, agent)) throw new Error(`agent worktree missing for ${agent}`);
  const branch = git(["branch", "--show-current"], { cwd: target });
  if (!branch.startsWith(`agent/${agent}/`)) throw new Error(`refusing automated finish outside agent task branch: ${branch || "detached"}`);
  if (!workspaceDirty(target)) throw new Error("finish found no changes to commit");

  console.log("AGENT_FINISH_VERIFY_START");
  const verify = run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "siton:verify"], { cwd: target, inherit: true, allowFailure: true });
  if (verify.status !== 0) throw new Error(`verification failed with exit ${verify.status}; no commit or push performed`);
  git(["diff", "--check"], { cwd: target });

  updateProjectStatus(target, agent, branch, meta);
  git(["diff", "--check"], { cwd: target });
  git(["add", "-A"], { cwd: target });
  const staged = git(["diff", "--cached", "--name-only"], { cwd: target });
  if (!staged) throw new Error("nothing staged after PROJECT_STATUS update");
  const message = meta.message || `agent(${agent}): ${branch.split("/").slice(2).join("/")}`;
  git(["commit", "-m", message], { cwd: target, stdio: "inherit" });
  git(["push", "-u", "origin", branch], { cwd: target, stdio: "inherit" });

  ensureGh();
  let pr = run("gh", ["pr", "view", branch, "--json", "number,url", "--jq", '"PR #" + (.number|tostring) + " " + .url'], { cwd: target, allowFailure: true });
  if (pr.status !== 0) {
    pr = run("gh", ["pr", "create", "--base", "master", "--head", branch, "--fill"], { cwd: target, allowFailure: true });
    if (pr.status !== 0) throw new Error(`push succeeded but PR creation failed: ${String(pr.stderr || pr.stdout || "").trim()}`);
  }
  const localSha = git(["rev-parse", "HEAD"], { cwd: target });
  const remoteSha = remoteBranchSha(repoRoot, branch);
  if (remoteSha !== localSha) throw new Error(`remote verification mismatch for ${branch}`);
  console.log(`AGENT_FINISH_PASS agent=${agent} branch=${branch} sha=${localSha}`);
  console.log(`PR=${String(pr.stdout || "").trim()}`);
  console.log(`OWNER_SUMMARY completed=${meta.completed} tested=${meta.tested} open=${meta.open} percentage=${meta.percentage} next=${meta.next}`);
  console.log("AUTO_MERGE=false");
}

function printPlan() {
  const repoRoot = canonicalRepoRoot();
  console.log("AGENT_WORKTREE_PLAN version=3");
  for (const agent of ["codex", "claude"]) console.log(`AGENT_WORKTREE_TARGET agent=${agent} path=${workspacePath(repoRoot, agent)} standby_branch=${standbyBranch(agent)} task_prefix=agent/${agent}/`);
  console.log("AGENT_WORKTREE_BOUNDARY overwrite_existing_path=false discard_uncommitted=false force_push=false remote_lookup_fail_closed=true isolated_agents=true setup_runs_doctor=true task_packet=true finish_verifies_commits_pushes_pr=true auto_merge=false");
}

function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  if (command === "setup") return setup();
  if (command === "status") return status();
  if (command === "start") return startTask(args[0], args.slice(1));
  if (command === "finish") return finish(args[0], args.slice(1));
  if (command === "doctor") return doctor();
  if (command === "slug") { console.log(`AGENT_TASK_SLUG ${normalizeSlug(args.join(" "))}`); return; }
  if (command === "--plan" || command === "plan") return printPlan();
  throw new Error("usage: agent_workspace.cjs setup | status | start <codex|claude> <task> [--scope ...] [--do-not-touch ...] [--mode ...] | finish <codex|claude> --completed ... --tested ... --open ... --percentage ... --next ... [--message ...] | doctor | plan");
}

try { main(); } catch (error) {
  console.error(`AGENT_WORKSPACE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
