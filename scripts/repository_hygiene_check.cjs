#!/usr/bin/env node
// Repository hygiene (npm run check:repo-hygiene).
//   whitespace   git diff --check on the working tree and on the branch range
//                (origin/master...HEAD when available, else HEAD~1)
//   tracked junk no tracked file under .worktrees/, .tmp*, .ci-artifacts,
//                .release-artifacts, node_modules, *.log, review-*.log, dumps
//   env files    no tracked .env / .env.* except *.example
//   line endings tracked migration files are LF in the index; .gitattributes
//                pins them
//   dirty tree   reported (WARNING) so a release manifest can record it; a
//                release must be cut from a clean tree
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");
const policy = require("./lib/repo_scan_policy.cjs");

const root = process.cwd();
function git(args) { return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }

function main() {
  const report = new ReleaseReport("repository hygiene");
  const tracked = git(["ls-files", "-z"]).stdout.split("\0").filter(Boolean);

  // Generated / temporary / review artefacts must never be tracked. Binary
  // assets (canonical .docx specs, gradle wrapper jar, icons) are legitimate.
  const junkDir = new RegExp("(^|/)(" + [...policy.EXCLUDED_DIR_NAMES].filter((name) => ![".claude", ".vscode", ".idea", ".cursor", "archive", "backups", "tmp", "temp", "logs", "uploads", "build", "dist", "Pods", ".gradle", "DerivedData", ".cache", ".nyc_output", ".sixth"].includes(name)).map((name) => name.replace(/\./g, "\\.")).join("|") + ")(?:/|$)");
  const junkPrefix = /(^|\/)(\.tmp|\.worktree|\.review|\.scratch)[^/]*\//;
  const junkFile = /(\.log|\.dump|\.bak|\.tmp|\.orig|\.rej|\.swp)$|(^|\/)review-[^/]*\.(log|txt|json)$/i;
  const junk = tracked.filter((file) => junkDir.test(file) || junkPrefix.test(file) || junkFile.test(file));
  (junk.length ? report.fail : report.pass).call(report, "tracked artefacts", junk.length ? junk.length + " tracked generated/temporary/review artefacts" : tracked.length + " tracked files; none under .worktrees/.tmp*/build output/log/dump patterns", { detail: junk.slice(0, 40).join("\n") || undefined });

  const envFiles = tracked.filter((file) => /(^|\/)\.env(\..+)?$/.test(file) && !/\.(example|sample|template)$/.test(file));
  (envFiles.length ? report.fail : report.pass).call(report, "env files", envFiles.length ? "tracked env files: " + envFiles.join(", ") : "no tracked .env files (examples only)");

  const tree = git(["diff", "--check"]);
  const cached = git(["diff", "--check", "--cached"]);
  const base = git(["merge-base", "HEAD", "origin/master"]).status === 0 ? "origin/master" : "HEAD~1";
  const range = git(["diff", "--check", base + "...HEAD"]);
  const rangeAlt = range.status === 0 && !range.stdout ? range : git(["diff", "--check", base, "HEAD"]);
  const problems = [tree, cached, rangeAlt].filter((r) => r.status !== 0).map((r) => r.stdout.trim()).filter(Boolean);
  (problems.length ? report.fail : report.pass).call(report, "whitespace", problems.length ? "git diff --check reported problems" : "no trailing whitespace / conflict markers in working tree, index or " + base + "..HEAD", { detail: problems.join("\n").slice(0, 3000) || undefined });

  const eol = git(["ls-files", "--eol", "--", "src/migrations/*.sql"]).stdout.split(/\r?\n/).filter(Boolean);
  const crlfIndex = eol.filter((line) => /^i\/crlf/.test(line));
  const attributes = fs.existsSync(path.join(root, ".gitattributes")) ? fs.readFileSync(path.join(root, ".gitattributes"), "utf8") : "";
  const pinned = /src\/migrations\/\*\.sql\s+text\s+eol=lf/.test(attributes);
  (crlfIndex.length || !pinned ? report.warn : report.pass).call(report, "migration line endings", (crlfIndex.length ? crlfIndex.length + " migration files are CRLF in the git index; " : "all " + eol.length + " migration files are LF in the index; ") + (pinned ? ".gitattributes pins eol=lf" : ".gitattributes does not pin eol=lf"));

  const status = git(["status", "--porcelain", "--untracked-files=all"]).stdout.split(/\r?\n/).filter(Boolean);
  (status.length ? report.warn : report.pass).call(report, "working tree", status.length ? status.length + " uncommitted/untracked entries (a release manifest will record dirty=true)" : "clean", { detail: status.slice(0, 30).join("\n") || undefined });

  const nested = tracked.filter((file) => /^\.worktrees(?:\/|$)/.test(file) || /(^|\/)node_modules(?:\/|$)/.test(file));
  (nested.length ? report.fail : report.pass).call(report, "nested checkouts", nested.length ? nested.length + " tracked entries under .worktrees or node_modules" : "no tracked entries under .worktrees or node_modules");

  report.printSummary({ detailLines: 40 });
  report.writeArtifacts(artifactsDir(root), "repository-hygiene");
  console.log(report.exitCode() ? "REPOSITORY_HYGIENE_FAIL" : "REPOSITORY_HYGIENE_PASS");
  process.exit(report.exitCode());
}

main();
