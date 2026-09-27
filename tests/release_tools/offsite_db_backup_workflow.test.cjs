// Static controls for .github/workflows/offsite-db-backup.yml. The workflow
// only ever runs on GitHub with owner-provisioned secrets, so its safety
// properties are proven here from the YAML text: least privilege, a daily
// schedule, a green skip path when secrets are absent, secrets passed through
// env only (never interpolated into shell), verification with
// pg_restore --list BEFORE encryption, public-key-only encryption.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "offsite-db-backup.yml");
const text = fs.readFileSync(WORKFLOW, "utf8");
const lines = text.split(/\r?\n/);

// Minimal YAML reading sufficient for GitHub workflow block scalars: every
// `run: |` block is the following lines indented deeper than the `run:` key.
function runBlocks() {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    if (match[2] && !/^[|>][-+]?\s*$/.test(match[2])) { blocks.push({ line: i + 1, body: match[2] }); continue; }
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (lines[j].trim() === "") { body.push(""); continue; }
      const lead = lines[j].match(/^(\s*)/)[1].length;
      if (lead <= indent) break;
      body.push(lines[j]);
    }
    blocks.push({ line: i + 1, body: body.join("\n") });
    i = j - 1;
  }
  return blocks;
}

function steps() {
  const out = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s{6}- name:\s*(.+)$/);
    if (m) { current = { name: m[1], lines: [] }; out.push(current); continue; }
    if (current) current.lines.push(line);
  }
  return out;
}

test("workflow exists, is scheduled daily and dispatchable", () => {
  assert.match(text, /^on:\s*$/m);
  assert.match(text, /^\s{2}schedule:\s*$/m, "schedule trigger present");
  const cron = text.match(/-\s*cron:\s*"([^"]+)"/);
  assert.ok(cron, "cron expression present");
  const fields = cron[1].trim().split(/\s+/);
  assert.equal(fields.length, 5);
  assert.deepEqual(fields.slice(2), ["*", "*", "*"], "daily: day-of-month, month and day-of-week are wildcards");
  assert.match(fields[0], /^\d+$/);
  assert.match(fields[1], /^\d+$/);
  assert.match(text, /^\s{2}workflow_dispatch:\s*$/m);
  assert.doesNotMatch(text, /pull_request_target|^\s{2}pull_request:/m, "never triggered by pull requests");
});

test("permissions: contents read only, nothing writable", () => {
  const block = text.match(/^permissions:\s*\n((?:\s{2}.+\n)+)/m);
  assert.ok(block, "top-level permissions block present");
  const entries = block[1].trim().split(/\n/).map((l) => l.trim());
  assert.deepEqual(entries, ["contents: read"]);
  assert.doesNotMatch(text, /:\s*write\b/, "no write permission anywhere");
  assert.doesNotMatch(text, /permissions:\s*write-all|permissions:\s*read-all/);
  const jobPerms = text.match(/^\s{4}permissions:/m);
  assert.equal(jobPerms, null, "no job-level permission override");
});

test("skip path: missing secrets print OFFSITE_BACKUP_SKIPPED and exit 0; every real step is gated", () => {
  const all = steps();
  const gate = all.find((s) => /Gate on provisioned secrets/.test(s.name));
  assert.ok(gate, "gate step present");
  const gateText = gate.lines.join("\n");
  assert.match(gateText, /id:\s*gate/);
  assert.match(gateText, /echo "OFFSITE_BACKUP_SKIPPED missing \$\{missing\[\*\]\}"/);
  const skipIndex = gateText.indexOf("OFFSITE_BACKUP_SKIPPED");
  assert.match(gateText.slice(skipIndex, skipIndex + 200), /ready=false[\s\S]*exit 0/, "the skip path exits 0");
  for (const name of ["OFFSITE_BACKUP_DATABASE_URL", "OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY", "OFFSITE_BACKUP_S3_BUCKET", "OFFSITE_BACKUP_S3_ACCESS_KEY_ID", "OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY"]) {
    assert.match(gateText, new RegExp("for name in [^\\n]*\\b" + name + "\\b"), name + " is checked by the gate");
  }
  const later = all.slice(all.indexOf(gate) + 1);
  assert.ok(later.length >= 5);
  for (const step of later) {
    if (/Remove local backup files/.test(step.name)) {
      assert.match(step.lines.join("\n"), /if:\s*always\(\)/);
      continue;
    }
    assert.match(step.lines.join("\n"), /if:\s*steps\.gate\.outputs\.ready == 'true'/, step.name + " must be gated on the secrets check");
  }
});

test("secrets reach the shell through env only: no ${{ }} expression inside any run: script", () => {
  const blocks = runBlocks();
  assert.ok(blocks.length >= 7, "expected every step to be a run step, got " + blocks.length);
  for (const block of blocks) {
    assert.doesNotMatch(block.body, /\$\{\{\s*secrets\./, "secrets interpolated into run: at line " + block.line);
    assert.doesNotMatch(block.body, /\$\{\{/, "no expression interpolation inside run: at line " + block.line);
  }
  const secretLines = lines.filter((line) => /secrets\./.test(line) && !/^\s*#/.test(line));
  assert.ok(secretLines.length > 0);
  for (const line of secretLines) {
    assert.match(line, /^\s+[A-Z][A-Z0-9_]*:\s*\$\{\{\s*secrets\.[A-Z0-9_]+(\s*\|\|\s*'[^']*')?\s*\}\}\s*$/, "secret used outside an env mapping: " + line.trim());
  }
});

test("no secret is echoed, traced or uploaded as an artifact", () => {
  const secretEnv = ["OFFSITE_BACKUP_DATABASE_URL", "OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY", "OFFSITE_BACKUP_S3_ACCESS_KEY_ID"];
  for (const block of runBlocks()) {
    assert.doesNotMatch(block.body, /set\s+-[a-z]*x|set -o xtrace/, "xtrace would print secrets (line " + block.line + ")");
    for (const line of block.body.split("\n")) {
      if (!/\b(echo|printf|cat)\b/.test(line)) continue;
      for (const name of secretEnv) assert.ok(!line.includes("$" + name) && !line.includes("${" + name), "prints " + name + ": " + line.trim());
    }
  }
  assert.doesNotMatch(text, /upload-artifact/, "backups and TOCs must never become workflow artifacts");
});

test("dump -> pg_restore --list verification BEFORE encryption; sha256 of both recorded; restore-verify by download", () => {
  const body = runBlocks().map((b) => b.body).join("\n");
  assert.match(body, /pg_dump --format=custom/);
  assert.match(body, /--dbname="\$OFFSITE_BACKUP_DATABASE_URL"/);
  assert.match(text, /default_transaction_read_only=on/, "dump session forced read-only");
  const list = body.indexOf("pg_restore --list");
  const encrypt = body.indexOf("age --encrypt");
  assert.ok(list > 0, "pg_restore --list verification present");
  assert.ok(encrypt > list, "verification happens before encryption");
  assert.match(body, /TABLE DATA siton \$\{table\} /, "TOC is checked for the money tables");
  assert.match(body, /platform_fee_money_events/);
  assert.match(body, /sha256sum siton\.dump\b/);
  assert.match(body, /sha256sum siton\.dump\.age/);
  assert.match(body, /aws s3 cp [\s\S]*downloaded\.dump\.age/);
  assert.match(body, /OFFSITE_BACKUP_VERIFY_FAIL downloaded object sha256/);
  assert.match(body, /shred -u siton\.dump/, "plaintext removed after encryption");
});

test("public-key encryption only: the runner never holds or uses a decryption identity", () => {
  const body = runBlocks().map((b) => b.body).join("\n");
  assert.match(body, /age --encrypt --recipient "\$OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY"/);
  assert.doesNotMatch(body, /age\s+(--decrypt|-d\b)|--identity|\s-i\s+\S+\.txt|age-keygen/, "no decryption on the runner");
  assert.doesNotMatch(text, /secrets\.[A-Z0-9_]*(PRIVATE|IDENTITY|SECRET_KEY\b)/, "no private key secret is referenced");
  assert.match(body, /age1\*\)/, "the recipient must look like an age public key");
});

test("actions are pinned by full SHA or the workflow uses none", () => {
  const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line));
  for (const line of uses) {
    const ref = line.split("@")[1] || "";
    assert.ok(/^[0-9a-f]{40}\b/.test(ref) || /#/.test(line), "unpinned action without justification: " + line.trim());
  }
});
