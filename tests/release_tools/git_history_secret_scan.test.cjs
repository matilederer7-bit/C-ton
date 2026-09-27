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

test("touchedFilesFromLog yields every (commit, file) pair a commit put content into", () => {
  const log = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "",
    "x.txt",
    "dir/y.txt",
    "",
    "commit 89abcdef0123456789abcdef0123456789abcdef",
    "",
    "x.txt",
    ""
  ].join("\n");
  const rows = [...scan.touchedFilesFromLog(log)];
  assert.deepEqual(rows.map((r) => [r.commit.slice(0, 8), r.file]), [["01234567", "x.txt"], ["01234567", "dir/y.txt"], ["89abcdef", "x.txt"]]);
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

test("a Grow credential committed and later deleted is found (grow-credential detector is part of the history scan)", () => {
  const dir = tempRepo();
  const file = path.join(dir, "config.js");
  fs.writeFileSync(file, "const cfg = { GROW_REFERENCE_ENCRYPTION_KEY: 'k9mZ2qL8vX4wR7tB1nP5sD3fH6jA0cE' };\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "leak");
  fs.writeFileSync(file, "const cfg = { GROW_REFERENCE_ENCRYPTION_KEY: process.env.GROW_REFERENCE_ENCRYPTION_KEY };\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix");
  const result = scan.run({ root: dir, allowList: [] });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].detector, "grow-credential");
  assert.equal(result.findings[0].line, 1);
});

test("context-dependent detectors see adjacent added lines together (Twilio SID + token on two lines)", () => {
  const dir = tempRepo();
  const file = path.join(dir, ".env.local.js");
  fs.writeFileSync(file, "TWILIO_ACCOUNT_SID=AC" + "0123456789abcdef0123456789abcdef" + "\nTWILIO_AUTH_TOKEN=" + "fedcba9876543210fedcba9876543210" + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "leak");
  fs.writeFileSync(file, "TWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix");
  const result = scan.run({ root: dir, allowList: [] });
  const twilio = result.findings.find((f) => f.detector === "twilio-auth-token");
  assert.ok(twilio, `expected the Twilio token to be found across two added lines: ${JSON.stringify(result.findings)}`);
  assert.equal(twilio.line, 2);
});

test("a credential assembled over SEVERAL commits is found: SID in one commit, token in the next, both deleted later", () => {
  const dir = tempRepo();
  const file = path.join(dir, ".env.local.js");
  fs.writeFileSync(file, "TWILIO_ACCOUNT_SID=AC" + "0123456789abcdef0123456789abcdef" + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "sid only");
  fs.writeFileSync(file, "TWILIO_ACCOUNT_SID=AC" + "0123456789abcdef0123456789abcdef" + "\nTWILIO_AUTH_TOKEN=" + "fedcba9876543210fedcba9876543210" + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "token added in a later commit");
  fs.writeFileSync(file, "TWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix");
  const result = scan.run({ root: dir, allowList: [] });
  assert.equal(result.commits, 3);
  const twilio = result.findings.find((f) => f.detector === "twilio-auth-token");
  assert.ok(twilio, `expected the Twilio token to be found from the file snapshot: ${JSON.stringify(result.findings)}`);
  assert.equal(twilio.line, 2);
  // Reported at the commit that completed the credential, not the fix.
  assert.equal(twilio.commit, git(dir, "rev-parse", "HEAD~1").trim());
});

test("a secret is reported at its FIRST appearance even when later commits keep carrying it", () => {
  const dir = tempRepo();
  const file = path.join(dir, "config.js");
  fs.writeFileSync(file, "const key = 'AKIA" + "ABCDEFGHIJKLMNOP';\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "leak");
  const first = git(dir, "rev-parse", "HEAD").trim();
  fs.writeFileSync(file, "const key = 'AKIA" + "ABCDEFGHIJKLMNOP';\nconst other = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "still there");
  const result = scan.run({ root: dir, allowList: [] });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].commit, first);
});

test("a Luhn-valid card number committed and later deleted is found (real-card-pan detector is part of the history scan)", () => {
  const dir = tempRepo();
  const file = path.join(dir, "notes.md");
  fs.writeFileSync(file, "customer card: 4539" + " 1488 0343 6467\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "leak");
  fs.writeFileSync(file, "customer card: redacted\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix");
  const result = scan.run({ root: dir, allowList: [] });
  const pan = result.findings.find((f) => f.detector === "real-card-pan");
  assert.ok(pan, `expected the PAN to be found in history: ${JSON.stringify(result.findings)}`);
  assert.equal(pan.line, 1);
  assert.doesNotMatch(pan.match, /6467/, "the PAN is reported as a fingerprint, never the full number");
  assert.match(pan.match, /…\[16 chars, sha256:[0-9a-f]{12}\]$/);
});

test("deleted PANs of every card length (13, 14, 17, 18, 19 digits) are found in history", () => {
  const dir = tempRepo();
  const file = path.join(dir, "cards.txt");
  const pans = ["4105987511758", "55733818719908", "43714041014380902", "532999082567378271", "4868965756214235778"];
  fs.writeFileSync(file, pans.map((p, i) => `card${i}: ${p}`).join("\n") + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "leak");
  fs.writeFileSync(file, "redacted\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix");
  const result = scan.run({ root: dir, allowList: [] });
  const found = result.findings.filter((f) => f.detector === "real-card-pan").map((f) => f.line).sort();
  assert.deepEqual(found, [1, 2, 3, 4, 5], JSON.stringify(result.findings));
});

test("findings never carry the credential itself — only a masked fingerprint", () => {
  const dir = tempRepo();
  const file = path.join(dir, "config.js");
  const key = "AKIA" + "ABCDEFGHIJKLMNOP";
  fs.writeFileSync(file, `const key = '${key}';\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "leak");
  const result = scan.run({ root: dir, allowList: [] });
  assert.equal(result.findings.length, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(key), "the raw credential must not appear anywhere in the scan result");
  assert.match(result.findings[0].match, /^AKIA…\[20 chars, sha256:[0-9a-f]{12}\]$/);
});

test("a credential that first appears in a merge's conflict resolution (and is deleted later) is found", () => {
  const dir = tempRepo();
  const file = path.join(dir, "config.js");
  fs.writeFileSync(file, "const key = 'base';\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const trunk = git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();
  git(dir, "checkout", "-q", "-b", "side");
  fs.writeFileSync(file, "const key = 'side';\n");
  git(dir, "commit", "-q", "-am", "side");
  git(dir, "checkout", "-q", trunk);
  fs.writeFileSync(file, "const key = 'trunk';\n");
  git(dir, "commit", "-q", "-am", "trunk");
  spawnSync("git", ["merge", "side"], { cwd: dir }); // conflicts
  fs.writeFileSync(file, "const key = 'AKIA" + "ABCDEFGHIJKLMNOP';\n"); // resolution introduces the secret
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "merge with resolution");
  const merge = git(dir, "rev-parse", "HEAD").trim();
  fs.writeFileSync(file, "const key = process.env.KEY;\n");
  git(dir, "commit", "-q", "-am", "fix");
  const result = scan.run({ root: dir, allowList: [] });
  const aws = result.findings.find((f) => f.detector === "aws-access-key");
  assert.ok(aws, `expected the merge-resolution secret to be found: ${JSON.stringify(result.findings)}`);
  assert.equal(aws.commit, merge);
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
