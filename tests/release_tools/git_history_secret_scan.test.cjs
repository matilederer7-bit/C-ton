const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const scan = require("../../scripts/git_history_secret_scan.cjs");

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-scan-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@siton.local");
  git(dir, "config", "user.name", "history scan test");
  return dir;
}

test("addedLinesFromLog yields only added lines with their new-file line numbers", () => {
  const log = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "diff --git a/x.txt b/x.txt",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-gone",
    "+added one",
    "+added two",
    ""
  ].join("\n");
  const rows = [...scan.addedLinesFromLog(log)];
  assert.deepEqual(rows.map((r) => [r.file, r.line, r.text]), [["x.txt", 2, "added one"], ["x.txt", 3, "added two"]]);
});

test("a secret committed and later deleted is still found in history, reported once at first appearance", () => {
  const dir = tempRepo();
  const file = path.join(dir, "config.js");
  fs.writeFileSync(file, "const key = 'AKIA" + "ABCDEFGHIJKLMNOP';\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "leak");
  fs.writeFileSync(file, "const key = process.env.KEY;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix");
  const result = scan.run({ root: dir, allowList: [] });
  assert.equal(result.commits, 2);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].detector, "aws-access-key");
  assert.equal(result.findings[0].file, "config.js");
  assert.equal(result.findings[0].line, 1);
  // The working tree is clean, yet history is not.
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /AKIA/);
});

test("allow-listed synthetic values are ignored", () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "fixture.js"), "const key = 'AKIA" + "ABCDEFGHIJKLMNOP';\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  const result = scan.run({ root: dir, allowList: [{ file: "fixture.js", detector: "aws-access-key", match: "AKIA" + "ABCDEFGHIJKLMNOP", reason: "synthetic" }] });
  assert.equal(result.findings.length, 0);
});

test("the real repository history carries no secret", () => {
  const result = scan.run({ root: path.resolve(__dirname, "..", "..") });
  assert.ok(result.commits > 0);
  assert.deepEqual(result.findings, []);
});
