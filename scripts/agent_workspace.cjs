#!/usr/bin/env node

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function git(args, cwd = process.cwd(), inherit = false) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] })?.trim?.() || "";
}

function run(command, args, cwd = process.cwd(), allowFailure = false) {
  const r = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`${command} terminated by signal ${r.signal}`);
  if (typeof r.status !== "number") throw new Error(`${command} returned no exit status`);
  if (r.status !== 0 && !allowFailure) throw new Error(`${command} failed with exit ${r.status}`);
  return r;
}

function root() {
  git(["--version"]);
  const current = git(["rev-parse", "--show-toplevel"]);
  const common = path.resolve(current, git(["rev-parse", "--git-common-dir"], current));
  return path.basename(common) === ".git" ? path.dirname(common) : current;
}
function workspace(repo, agent) { return path.join(path.dirname(repo), `${path.basename(repo)}-${agent}`); }
function standby(agent) { return `workspace/${agent}`; }
function ensureAgent(agent) { if (!["codex", "claude"].includes(agent)) throw new Error("agent must be codex or claude"); }
function dirty(cwd) { return Boolean(git(["status", "--porcelain"], cwd)); }
function fetchMaster(repo) { git(["fetch", "origin", "master", "--prune"], repo, true); }

function worktrees(repo) {
  const out = [];
  let item = null;
  for (const line of git(["worktree", "list", "--porcelain"], repo).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { item = { path: line.slice(9), branch: null, head: null }; out.push(item); }
    else if (item && line.startsWith("branch refs/heads/")) item.branch = line.slice(18);
    else if (item && line.startsWith("HEAD ")) item.head = line.slice(5);
  }
  return out;
}
function entry(repo, agent) {
  const target = path.resolve(workspace(repo, agent));
  return worktrees(repo).find((w) => path.resolve(w.path) === target) || null;
}
function localBranch(repo, name) {
  try { git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], repo); return true; } catch { return false; }
}
function remoteSha(repo, name) {
  try {
    const value = git(["ls-remote", "--heads", "origin", name], repo);
    return value ? value.split(/\s+/)[0] : null;
  } catch (error) {
    throw new Error(`unable to verify remote branch state for ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function slug(value) {
  const s = String(value || "").normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/[.-]+$/g, "");
  if (!s || s.endsWith(".lock")) throw new Error("invalid task name");
  return s;
}
function uniqueTaskBranch(repo, agent, task) {
  const base = `agent/${agent}/${slug(task)}`;
  for (let attempt = 1; attempt <= 99; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-r${attempt}`;
    if (!localBranch(repo, candidate) && !remoteSha(repo, candidate)) return candidate;
  }
  throw new Error(`unable to allocate task branch after 99 attempts: ${base}`);
}

function ensureWorkspace(repo, agent) {
  const target = workspace(repo, agent);
  if (entry(repo, agent)) return console.log(`AGENT_WORKTREE_PRESENT agent=${agent} path=${target}`);
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing path: ${target}`);
  const branch = standby(agent);
  if (localBranch(repo, branch)) git(["worktree", "add", target, branch], repo, true);
  else git(["worktree", "add", "-b", branch, target, "origin/master"], repo, true);
  console.log(`AGENT_WORKTREE_CREATED agent=${agent} path=${target}`);
}

function doctor(repo = root()) {
  const seen = worktrees(repo);
  for (const agent of ["codex", "claude"]) {
    const target = workspace(repo, agent);
    const found = seen.find((w) => path.resolve(w.path) === path.resolve(target));
    if (!found) throw new Error(`doctor missing worktree: ${agent}`);
    if (dirty(target)) throw new Error(`doctor dirty worktree requires decision: ${agent}`);
    console.log(`AGENT_DOCTOR_WORKSPACE agent=${agent} branch=${found.branch || "detached"} dirty=false path=${target}`);
  }
  const branches = seen.map((w) => w.branch).filter(Boolean);
  const collision = branches.find((b, i) => branches.indexOf(b) !== i);
  if (collision) throw new Error(`doctor branch collision: ${collision}`);
  console.log("AGENT_DOCTOR_RESULT DONE worktrees=2 isolation=pass dirty=0 branch_collision=0");
}

function setup() {
  const repo = root();
  fetchMaster(repo);
  ensureWorkspace(repo, "codex");
  ensureWorkspace(repo, "claude");
  doctor(repo);
  console.log("AGENT_WORKTREE_SETUP_PASS agents=2 doctor=pass");
}
function status() {
  const repo = root();
  for (const w of worktrees(repo)) console.log(`AGENT_WORKTREE path=${w.path} branch=${w.branch || "detached"} head=${w.head || "unknown"} dirty=${dirty(w.path)}`);
}

function parseStart(args) {
  const task = [], out = { scope: "Minimal files necessary; targeted discovery only.", doNotTouch: "Grow, real money, unrelated product areas, other agent worktree.", mode: "builder" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scope") out.scope = args[++i] || out.scope;
    else if (args[i] === "--do-not-touch") out.doNotTouch = args[++i] || out.doNotTouch;
    else if (args[i] === "--mode") out.mode = args[++i] || out.mode;
    else task.push(args[i]);
  }
  out.task = task.join(" ").trim();
  if (!out.task) throw new Error("task is required");
  return out;
}
function statusExcerpt(target, agent) {
  const file = path.join(target, "PROJECT_STATUS.md");
  if (!fs.existsSync(file)) return "PROJECT_STATUS.md unavailable";
  const current = fs.readFileSync(file, "utf8");
  const startMarker = `<!-- AGENT_STATUS:${agent}:START -->`;
  const endMarker = `<!-- AGENT_STATUS:${agent}:END -->`;
  const startIndex = current.indexOf(startMarker);
  const endIndex = current.indexOf(endMarker);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`PROJECT_STATUS.md missing isolated ${agent} status slot`);
  }
  return current.slice(startIndex, endIndex + endMarker.length).trim();
}
function taskPacketPath(target) {
  const gitPath = git(["rev-parse", "--git-path", "SITON_TASK_PACKET.md"], target);
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(target, gitPath);
}
function taskBranchLifecycle(target, branch) {
  const r = spawnSync("gh", ["pr", "view", branch, "--json", "state,mergedAt,url"], {
    cwd: target, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  if (r.error) throw new Error(`unable to resolve PR state for ${branch}: ${r.error.message}`);
  if (r.signal) throw new Error(`gh pr view terminated by signal ${r.signal}`);
  if (typeof r.status !== "number" || r.status !== 0) {
    const detail = String(r.stderr || r.stdout || "unknown gh failure").trim();
    throw new Error(`unable to resolve PR state for active task branch ${branch}: ${detail}`);
  }
  let payload;
  try { payload = JSON.parse(r.stdout || "{}"); }
  catch { throw new Error(`unable to parse PR state for active task branch ${branch}`); }
  if (payload.mergedAt) return { state: "MERGED", url: payload.url || "" };
  return { state: String(payload.state || "UNKNOWN").toUpperCase(), url: payload.url || "" };
}
function releaseResolvedTaskIfNeeded(repo, agent, target) {
  const current = git(["branch", "--show-current"], target);
  if (!current || current === standby(agent)) return;
  if (!current.startsWith(`agent/${agent}/`)) throw new Error(`refusing to replace unexpected ${agent} branch: ${current || "detached"}`);
  if (dirty(target)) throw new Error(`active ${agent} task branch is dirty: ${current}`);
  const lifecycle = taskBranchLifecycle(target, current);
  if (lifecycle.state === "OPEN") {
    throw new Error(`active ${agent} task PR is still open: ${current}${lifecycle.url ? ` ${lifecycle.url}` : ""}; keep using this worktree for CI fixes`);
  }
  if (!["MERGED", "CLOSED"].includes(lifecycle.state)) {
    throw new Error(`active ${agent} task branch has unresolved PR state ${lifecycle.state}: ${current}`);
  }
  git(["switch", "-C", standby(agent), "origin/master"], target, true);
  console.log(`AGENT_PREVIOUS_TASK_RELEASED agent=${agent} branch=${current} pr_state=${lifecycle.state} path=${target}`);
}
function start(agent, args) {
  ensureAgent(agent);
  const p = parseStart(args), repo = root(), target = workspace(repo, agent);
  if (!entry(repo, agent)) throw new Error(`missing ${agent} worktree; run node scripts/agent.cjs setup`);
  if (dirty(target)) throw new Error(`refusing to switch dirty ${agent} worktree`);
  fetchMaster(repo);
  releaseResolvedTaskIfNeeded(repo, agent, target);
  const branch = uniqueTaskBranch(repo, agent, p.task);
  git(["switch", "-C", standby(agent), "origin/master"], target, true);
  git(["switch", "-c", branch, "origin/master"], target, true);
  const base = git(["rev-parse", "HEAD"], target);
  git(["push", "-u", "origin", branch], target, true);
  if (remoteSha(repo, branch) !== base) throw new Error("start preflight remote SHA verification failed");
  console.log(`AGENT_START_PUSH_PASS agent=${agent} branch=${branch} base_sha=${base}`);
  const packet = taskPacketPath(target);
  fs.writeFileSync(packet, `# SITON TASK PACKET\n\nTASK\n${p.task}\n\nSCOPE\n${p.scope}\n\nDO NOT TOUCH\n${p.doNotTouch}\n\nMODE\n${p.mode}\n\nBASE SHA\n${base}\n\nBRANCH\n${branch}\n\nSTANDING CONTEXT\nRead AGENTS.md and only the current PROJECT_STATUS.md section needed for this task. Do not read archives or scan the entire repository without evidence.\n\nCURRENT AGENT STATUS\n${statusExcerpt(target, agent)}\n\nFINISH\nAfter relevant tests, run node scripts/agent.cjs finish ${agent} with --completed --tested --open --percentage --next. Finish verifies, updates only this agent's isolated PROJECT_STATUS slot, commits, pushes and opens or updates the PR. Never auto-merge. The worktree remains on this task branch while the PR is open so CI fixes can continue without rebuilding context. A later start automatically releases a clean prior task only after its PR is merged or closed.\n`, "utf8");
  console.log(`AGENT_TASK_READY agent=${agent} branch=${branch} base_sha=${base} path=${target}`);
  console.log(`TASK_PACKET=${packet}`);
  console.log(`TASK=${p.task}`);
  console.log(`SCOPE=${p.scope}`);
  console.log(`DO_NOT_TOUCH=${p.doNotTouch}`);
  console.log(`MODE=${p.mode}`);
}

function finishMeta(args) {
  const out = { message: "", completed: "", tested: "", open: "", percentage: "", next: "" };
  const map = { "--message": "message", "--completed": "completed", "--tested": "tested", "--open": "open", "--percentage": "percentage", "--next": "next" };
  for (let i = 0; i < args.length; i++) if (map[args[i]]) out[map[args[i]]] = args[++i] || "";
  const missing = ["completed", "tested", "open", "percentage", "next"].filter((k) => !out[k]);
  if (missing.length) throw new Error(`finish metadata missing: ${missing.join(",")}`);
  return out;
}
function updateAgentStatus(target, agent, branch, m) {
  const file = path.join(target, "PROJECT_STATUS.md");
  if (!fs.existsSync(file)) throw new Error("PROJECT_STATUS.md unavailable");
  const current = fs.readFileSync(file, "utf8");
  const startMarker = `<!-- AGENT_STATUS:${agent}:START -->`;
  const endMarker = `<!-- AGENT_STATUS:${agent}:END -->`;
  const startIndex = current.indexOf(startMarker);
  const endIndex = current.indexOf(endMarker);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`PROJECT_STATUS.md missing isolated ${agent} status slot`);
  }
  const label = agent === "claude" ? "Claude Code" : "Codex";
  const block = `${startMarker}\n### ${label} latest milestone\n\n- UPDATED: ${new Date().toISOString()}\n- BRANCH: ${branch}\n- COMPLETED: ${m.completed}\n- TESTED: ${m.tested}\n- OPEN: ${m.open}\n- PERCENTAGE: ${m.percentage}\n- NEXT STEP: ${m.next}\n${endMarker}`;
  const before = current.slice(0, startIndex);
  const after = current.slice(endIndex + endMarker.length);
  fs.writeFileSync(file, `${before}${block}${after}`, "utf8");
}
function finish(agent, args) {
  ensureAgent(agent);
  const m = finishMeta(args), repo = root(), target = workspace(repo, agent);
  if (!entry(repo, agent)) throw new Error(`missing ${agent} worktree`);
  const branch = git(["branch", "--show-current"], target);
  if (!branch.startsWith(`agent/${agent}/`)) throw new Error(`refusing finish outside ${agent} task branch: ${branch || "detached"}`);
  if (!dirty(target)) throw new Error("finish found no changes");

  const verifier = path.join(target, "scripts", "siton_verify.cjs");
  const verify = run(process.execPath, [verifier], target, true);
  if (verify.status !== 0) throw new Error(`verification failed with exit ${verify.status}; no commit or push performed`);
  git(["diff", "--check"], target);
  updateAgentStatus(target, agent, branch, m);
  git(["diff", "--check"], target);
  git(["add", "-A"], target);
  if (!git(["diff", "--cached", "--name-only"], target)) throw new Error("nothing staged");
  git(["commit", "-m", m.message || `agent(${agent}): ${branch.split("/").slice(2).join("/")}`], target, true);
  git(["push", "-u", "origin", branch], target, true);

  const gh = run("gh", ["--version"], target, true);
  if (gh.status !== 0) throw new Error("push succeeded but GitHub CLI gh is unavailable for PR creation");
  let pr = run("gh", ["pr", "view", branch, "--json", "number,url", "--jq", '"PR #" + (.number|tostring) + " " + .url'], target, true);
  if (pr.status !== 0) {
    pr = run("gh", ["pr", "create", "--base", "master", "--head", branch, "--fill"], target, true);
    if (pr.status !== 0) throw new Error("push succeeded but PR creation failed");
  }
  const local = git(["rev-parse", "HEAD"], target);
  if (remoteSha(repo, branch) !== local) throw new Error("remote SHA verification failed");
  console.log(`AGENT_FINISH_PASS agent=${agent} active_branch=${branch} pushed_sha=${local} retained_for_pr=true`);
  console.log(`PR=${String(pr.stdout || "").trim()}`);
  console.log(`OWNER_SUMMARY completed=${m.completed} tested=${m.tested} open=${m.open} percentage=${m.percentage} next=${m.next}`);
  console.log("AUTO_MERGE=false");
}

function plan() {
  const repo = root();
  console.log("AGENT_WORKTREE_PLAN version=5");
  for (const agent of ["codex", "claude"]) console.log(`AGENT_WORKTREE_TARGET agent=${agent} path=${workspace(repo, agent)} standby_branch=${standby(agent)} task_prefix=agent/${agent}/`);
  console.log("AGENT_WORKTREE_BOUNDARY overwrite=false discard_uncommitted=false force_push=false remote_lookup_fail_closed=true isolated_agents=true setup_runs_doctor=true task_packet_untracked=true isolated_status_slots=true finish_verifies_commits_pushes_pr=true task_branch_retained_until_pr_resolved=true next_start_releases_merged_or_closed=true repeated_task_branch_suffix=true task_packet_agent_status_only=true start_preflight_push=true auto_merge=false");
}

function main() {
  const [cmd = "status", ...args] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  if (cmd === "status") return status();
  if (cmd === "doctor") return doctor();
  if (cmd === "start") return start(args[0], args.slice(1));
  if (cmd === "finish") return finish(args[0], args.slice(1));
  if (cmd === "slug") return console.log(`AGENT_TASK_SLUG ${slug(args.join(" "))}`);
  if (cmd === "plan" || cmd === "--plan") return plan();
  throw new Error("usage: agent_workspace.cjs setup | status | doctor | start <codex|claude> <task> | finish <codex|claude> ... | plan");
}

try { main(); } catch (error) {
  console.error(`AGENT_WORKSPACE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
