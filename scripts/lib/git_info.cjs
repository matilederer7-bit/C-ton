// Git identity helpers shared by the release manifest, preflight and
// owner check. Every call is read-only.
const { spawnSync } = require("node:child_process");

function git(args, cwd = process.cwd()) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) return null;
  return String(result.stdout || "").trim();
}

function gitSha(cwd) { return git(["rev-parse", "HEAD"], cwd); }
function gitShortSha(cwd) { return git(["rev-parse", "--short", "HEAD"], cwd); }
function gitBranch(cwd) {
  const branch = git(["branch", "--show-current"], cwd);
  return branch || "(detached)";
}
function gitStatusPorcelain(cwd) {
  const out = git(["status", "--porcelain", "--untracked-files=all"], cwd);
  return out === null ? null : out.split(/\r?\n/).filter(Boolean);
}
function gitDirty(cwd) {
  const lines = gitStatusPorcelain(cwd);
  if (lines === null) return { known: false, dirty: null, entries: [] };
  return { known: true, dirty: lines.length > 0, entries: lines };
}
function gitRemote(cwd) { return git(["remote", "get-url", "origin"], cwd); }
function gitCommitSubject(cwd) { return git(["log", "-1", "--pretty=%s"], cwd); }
function gitCommitDate(cwd) { return git(["log", "-1", "--pretty=%cI"], cwd); }
function gitMergeBase(ref, cwd) { return git(["merge-base", "HEAD", ref], cwd); }
function gitIsAncestor(ancestor, descendant, cwd) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
  return result.status === 0;
}

function describeGit(cwd = process.cwd()) {
  const dirty = gitDirty(cwd);
  return {
    sha: gitSha(cwd),
    short_sha: gitShortSha(cwd),
    branch: gitBranch(cwd),
    subject: gitCommitSubject(cwd),
    committed_at: gitCommitDate(cwd),
    remote: gitRemote(cwd),
    dirty: dirty.dirty,
    dirty_entries: dirty.entries.slice(0, 50),
    dirty_entry_count: dirty.entries.length
  };
}

module.exports = { git, gitSha, gitShortSha, gitBranch, gitDirty, gitStatusPorcelain, gitRemote, gitCommitSubject, gitCommitDate, gitMergeBase, gitIsAncestor, describeGit };
