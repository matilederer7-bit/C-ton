// Controls for the migration doctor, the repair helper, the checksum
// normalisation and the isolated-database helper. Uses disposable local
// databases only; skipped (not passed) when no local DATABASE_URL is
// reachable.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
require("dotenv").config({ quiet: true });
const { REPO_ROOT } = require("./support/fixture_repo.cjs");
const tools = require("../../scripts/lib/migration_tools.cjs");
const isolation = require("../../scripts/lib/test_db_isolation.cjs");
const { runMigrations, checksum, checksumCrlfVariant, classifyChecksum } = require("../../scripts/run_migrations.cjs");

const baseUrl = process.env.DATABASE_URL;
let dbAvailable = false;
try { if (baseUrl) { isolation.assertLocalBase(baseUrl); dbAvailable = true; } } catch { dbAvailable = false; }

function doctor(url, extra = []) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "migrations_doctor.cjs"), "--database", url, ...extra], { cwd: REPO_ROOT, encoding: "utf8" });
}
function repair(url, extra = []) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "migrations_repair.cjs"), "--database", url, ...extra], { cwd: REPO_ROOT, encoding: "utf8" });
}
async function quiet(fn) { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } }

test("checksum normalises CRLF and BOM; the CRLF variant is recognised as line-ending-only", () => {
  const lf = "CREATE TABLE t (id INT);\nSELECT 1;\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(checksum(lf), checksum(crlf));
  assert.equal(checksum("﻿" + lf), checksum(lf));
  assert.notEqual(checksum(lf), checksumCrlfVariant(lf));
  assert.equal(classifyChecksum(checksum(lf), crlf), "match");
  assert.equal(classifyChecksum(checksumCrlfVariant(lf), lf), "eol-variant");
  assert.equal(classifyChecksum("0".repeat(64), lf), "mismatch");
});

test("static manifest analysis is clean on the repository and detects duplicate ids, gaps and orphans", () => {
  const analysis = tools.analyzeManifest(REPO_ROOT);
  assert.deepEqual(analysis.findings.filter((f) => f.severity === "FAIL"), []);
  assert.equal(analysis.files.length, analysis.migrations.length);
  assert.ok(analysis.high_water);
  // Synthetic manifests through compareLedger-style checks.
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siton-manifest-"));
  try {
    fs.mkdirSync(path.join(tmp, "scripts"));
    fs.mkdirSync(path.join(tmp, "src", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "migrations", "001_a.sql"), "SELECT 1;\n");
    fs.writeFileSync(path.join(tmp, "src", "migrations", "002_b.sql"), "SELECT 2;\n");
    fs.writeFileSync(path.join(tmp, "src", "migrations", "003_orphan.sql"), "SELECT 3;\n");
    fs.writeFileSync(path.join(tmp, "src", "migrations", "004_empty.sql"), "-- nothing\n");
    fs.writeFileSync(path.join(tmp, "scripts", "migration_manifest.cjs"), [
      "const path = require('node:path');",
      "const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'migrations');",
      "const MIGRATIONS = [['001','001_a.sql'],['001','002_b.sql'],['004','004_empty.sql'],['005','missing.sql']].map(([id, filename], position) => ({ id, filename, position: position + 1 }));",
      "module.exports = { MIGRATIONS_DIR, MIGRATIONS };"
    ].join("\n"));
    const synthetic = tools.analyzeManifest(tmp);
    const codes = synthetic.findings.map((f) => f.code).sort();
    for (const expected of ["DUPLICATE_ID", "ORPHAN_FILE", "EMPTY_MIGRATION", "MISSING_FILE"]) assert.ok(codes.includes(expected), expected + " in " + codes.join(","));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isolated database names carry purpose, agent, pid and timestamp; hosted hosts are refused", () => {
  const name = isolation.buildName("preflight");
  const parsed = isolation.parseIsolatedName(name);
  assert.ok(parsed, name);
  assert.equal(parsed.purpose, "preflight");
  assert.equal(parsed.pid, process.pid);
  assert.equal(isolation.parseIsolatedName("siton_test_template_123"), null);
  assert.throws(() => isolation.assertLocalBase("postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"), /refuse non-local/);
  assert.doesNotThrow(() => isolation.assertLocalBase("postgresql://u:p@127.0.0.1:5432/postgres"));
});

test("doctor refuses a hosted host without --allow-hosted and reports NO_DATABASE without a url", () => {
  const hosted = doctor("postgresql://u:p@db.example-project.supabase.co:5432/postgres");
  assert.equal(hosted.status, 2);
  assert.match(hosted.stderr, /refuses host/);
  const none = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "migrations_doctor.cjs")], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  assert.equal(none.status, 2);
  assert.match(none.stdout, /verdict=NO_DATABASE/);
});

test("doctor verdicts and repair dry-run/apply on a disposable database", { skip: !dbAvailable && "no local DATABASE_URL (SKIPPED_ENVIRONMENT)" }, async () => {
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: "doctortest" });
  try {
    // Empty database
    let result = doctor(db.url);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verdict=EMPTY_DATABASE/);

    // Behind: apply half.
    const analysis = tools.analyzeManifest(REPO_ROOT);
    const half = Math.floor(analysis.migrations.length / 2);
    await quiet(() => runMigrations(db.url, { migrations: analysis.migrations.slice(0, half) }));
    result = doctor(db.url);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /verdict=BEHIND/);
    assert.match(result.stdout, new RegExp("count=" + half + " repository_count=" + analysis.migrations.length));

    // Healthy
    await quiet(() => runMigrations(db.url));
    result = doctor(db.url);
    assert.match(result.stdout, /verdict=HEALTHY\b/);

    // EOL variants: rewrite two rows with CRLF checksums, doctor reports, runner accepts, repair dry-run then apply.
    const targets = analysis.files.slice(0, 2);
    await tools.withClient(db.url, async (client) => {
      for (const file of targets) await client.query("UPDATE siton.migration_ledger SET checksum_sha256=$2 WHERE migration_id=$1", [file.id, file.checksum_crlf]);
    });
    result = doctor(db.url);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /verdict=HEALTHY_WITH_EOL_VARIANTS/);
    assert.match(result.stdout, /line-ending-only mismatch: 014, 007/);
    const run = await quiet(() => runMigrations(db.url));
    assert.equal(run.eol_variants, 2);
    assert.equal(run.newly_applied, 0);
    const dry = repair(db.url, ["--fix-eol-checksums"]);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /mode=DRY_RUN/);
    assert.match(dry.stdout, /rows=2/);
    assert.match(doctor(db.url).stdout, /verdict=HEALTHY_WITH_EOL_VARIANTS/, "dry run must not change anything");
    const applied = repair(db.url, ["--fix-eol-checksums", "--yes"]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /MIGRATIONS_REPAIR_APPLIED rows=2/);
    assert.match(doctor(db.url).stdout, /verdict=HEALTHY\b/);

    // Real content mismatch: blocked, and repair refuses to touch it.
    await tools.withClient(db.url, (client) => client.query("UPDATE siton.migration_ledger SET checksum_sha256=repeat('f', 64) WHERE migration_id=$1", [targets[0].id]));
    result = doctor(db.url);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /verdict=BLOCKED/);
    assert.match(result.stdout, /real content mismatch: 014/);
    const noop = repair(db.url, ["--fix-eol-checksums", "--yes"]);
    assert.match(noop.stdout, /rows=0/);
    assert.match(doctor(db.url).stdout, /verdict=BLOCKED/);
    await tools.withClient(db.url, (client) => client.query("UPDATE siton.migration_ledger SET checksum_sha256=$2 WHERE migration_id=$1", [targets[0].id, targets[0].checksum_lf]));

    // Failed row: blocked; clear-failed needs the verification flag and --yes.
    // The high-water migration id comes from the manifest so this control
    // never rots when a new migration lands (066 -> 068 after R9C).
    const last = analysis.files[analysis.files.length - 1].id;
    await tools.withClient(db.url, (client) => client.query("UPDATE siton.migration_ledger SET status='failed', error_message='simulated' WHERE migration_id=$1", [last]));
    assert.match(doctor(db.url).stdout, new RegExp("verdict=BLOCKED[\\s\\S]*dirty rows: " + last + ":failed"));
    const refused = repair(db.url, ["--clear-failed", last]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /i-verified-no-partial-effects/);
    const cleared = repair(db.url, ["--clear-failed", last, "--i-verified-no-partial-effects", "--yes"]);
    assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
    assert.match(doctor(db.url).stdout, /verdict=BEHIND/);
    const rerun = await quiet(() => runMigrations(db.url));
    assert.equal(rerun.newly_applied, 1);
    assert.match(doctor(db.url).stdout, /verdict=HEALTHY\b/);
  } finally {
    await db.drop();
  }
});

test("migration preflight static half passes and reports the line-ending policy", () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "migration_preflight.cjs"), "--skip-db"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[PASS\] manifest integrity/);
  assert.match(result.stdout, /line-ending policy/);
});
