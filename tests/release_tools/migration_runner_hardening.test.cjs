// Controls for the migration runner hardening: runner advisory lock,
// per-migration lock_timeout / statement_timeout, atomic ledger recording for
// files without their own transaction control, and recovery of a stale
// 'running' row through migrations:repair --clear-running. Uses disposable
// local databases only; DB controls are skipped (not passed) without a local
// DATABASE_URL.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });
const { REPO_ROOT } = require("./support/fixture_repo.cjs");
const tools = require("../../scripts/lib/migration_tools.cjs");
const isolation = require("../../scripts/lib/test_db_isolation.cjs");
const runner = require("../../scripts/run_migrations.cjs");
const { runMigrations } = runner;

const baseUrl = process.env.DATABASE_URL;
let dbAvailable = false;
try { if (baseUrl) { isolation.assertLocalBase(baseUrl); dbAvailable = true; } } catch { dbAvailable = false; }
const skip = !dbAvailable && "no local DATABASE_URL (SKIPPED_ENVIRONMENT)";

async function quiet(fn) { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } }
async function sql(url, text, params) { return tools.withClient(url, (client) => client.query(text, params)); }
async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) { previous[key] = process.env[key]; process.env[key] = value; }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

/** A throw-away repository root with its own manifest and migration files. */
function fixtureRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siton-mig-hardening-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "src", "migrations"), { recursive: true });
  for (const [filename, body] of files) fs.writeFileSync(path.join(root, "src", "migrations", filename), body);
  fs.writeFileSync(path.join(root, "scripts", "migration_manifest.cjs"), [
    "const path = require('node:path');",
    "const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'migrations');",
    "const MIGRATIONS = " + JSON.stringify(files.map(([filename], index) => ({ id: filename.split("_")[0], filename, position: index + 1 }))) + ";",
    "module.exports = { MIGRATIONS_DIR, MIGRATIONS };"
  ].join("\n"));
  const { migrations, dir } = tools.loadManifest(root);
  return { root, migrations, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function repairIn(root, url, extra) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "migrations_repair.cjs"), "--database", url, ...extra], { cwd: root, encoding: "utf8", env: { ...process.env, SITON_RELEASE_ARTIFACTS_DIR: path.join(root, ".release-artifacts") } });
}
function doctorIn(root, url) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "migrations_doctor.cjs"), "--database", url], { cwd: root, encoding: "utf8", env: { ...process.env, SITON_RELEASE_ARTIFACTS_DIR: path.join(root, ".release-artifacts") } });
}

test("runner settings: defaults 5s lock / 10min statement / 60s runner lock wait; env and options override; junk refused", () => {
  assert.deepEqual(runner.resolveRunnerSettings({}, {}), { lockTimeoutMs: 5000, statementTimeoutMs: 600000, advisoryLockWaitMs: 60000 });
  assert.deepEqual(runner.resolveRunnerSettings({}, { MIGRATION_LOCK_TIMEOUT_MS: "750", MIGRATION_STATEMENT_TIMEOUT_MS: "1000" }), { lockTimeoutMs: 750, statementTimeoutMs: 1000, advisoryLockWaitMs: 60000 });
  assert.equal(runner.resolveRunnerSettings({ lockTimeoutMs: 1 }, { MIGRATION_LOCK_TIMEOUT_MS: "750" }).lockTimeoutMs, 1);
  assert.throws(() => runner.resolveRunnerSettings({}, { MIGRATION_LOCK_TIMEOUT_MS: "5s" }), /MIGRATION_LOCK_TIMEOUT_MS/);
});

test("transaction-control detection ignores PL/pgSQL bodies and comments", () => {
  assert.equal(runner.hasExplicitTransactionControl("BEGIN;\nCREATE TABLE t (id INT);\nCOMMIT;\n"), true);
  assert.equal(runner.hasExplicitTransactionControl("CREATE TABLE t (id INT);\n"), false);
  assert.equal(runner.hasExplicitTransactionControl("CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  NULL;\nEND;\n$$ LANGUAGE plpgsql;\nDO $body$ BEGIN PERFORM 1; END; $body$;\n-- COMMIT;\n"), false);
  assert.equal(runner.requiresNoTransactionBlock("CREATE INDEX CONCURRENTLY i ON t (id);"), true);
  // Every repository file classified the same way as the static analysis.
  const analysis = tools.analyzeManifest(REPO_ROOT);
  for (const file of analysis.files) {
    const body = fs.readFileSync(path.join(REPO_ROOT, "src", "migrations", file.filename), "utf8");
    assert.equal(runner.hasExplicitTransactionControl(body), file.explicit_transaction, file.filename);
  }
});

test("object fingerprint lists created tables, indexes, functions, triggers, columns and constraints", () => {
  const objects = tools.migrationObjectFingerprint([
    "BEGIN;",
    "CREATE TABLE IF NOT EXISTS siton.a (id INT);",
    "CREATE UNIQUE INDEX a_idx ON siton.a (id);",
    "CREATE OR REPLACE FUNCTION siton.f() RETURNS trigger AS $$ BEGIN CREATE TABLE siton.not_me (x int); RETURN NEW; END; $$ LANGUAGE plpgsql;",
    "CREATE TRIGGER a_trg BEFORE INSERT ON siton.a FOR EACH ROW EXECUTE FUNCTION siton.f();",
    "ALTER TABLE siton.a ADD COLUMN IF NOT EXISTS b TEXT, ADD CONSTRAINT a_b_check CHECK (b <> '');",
    "COMMIT;"
  ].join("\n")).map(tools.describeObject);
  assert.deepEqual(objects, ["relation siton.a", "relation siton.a_idx", "function siton.f", "trigger a_trg on siton.a", "column siton.a.b", "constraint a_b_check on siton.a"]);
});

test("two concurrent runners on one fresh database: both finish, full ledger, no duplicate", { skip }, async () => {
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: "migconc" });
  try {
    const [first, second] = await quiet(() => Promise.all([runMigrations(db.url), runMigrations(db.url)]));
    const total = tools.analyzeManifest(REPO_ROOT).migrations.length;
    assert.equal(first.newly_applied + second.newly_applied, total);
    assert.ok(first.newly_applied === 0 || second.newly_applied === 0, "exactly one runner applied the migrations");
    const ledger = await tools.readLedger(db.url);
    assert.equal(ledger.length, total);
    assert.ok(ledger.every((row) => row.status === "succeeded"));
    // Runner lock released afterwards (pg_locks is cluster-wide: scope to this
    // database, other suites may be migrating their own databases).
    const held = await sql(db.url, "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
    assert.equal(held.rows[0].n, 0);
  } finally {
    await db.drop();
  }
});

test("a runner that cannot get the runner lock gives up after the bounded wait with a clear message", { skip }, async () => {
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: "miglockwait" });
  const holder = new Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [runner.MIGRATION_ADVISORY_LOCK_KEY]);
    const started = Date.now();
    await assert.rejects(quiet(() => runMigrations(db.url, { advisoryLockWaitMs: 600 })), /another migration run holds the runner lock/);
    assert.ok(Date.now() - started < 5000);
    assert.equal(await tools.readLedger(db.url), null, "nothing ran without the lock");
  } finally {
    await holder.end();
    await db.drop();
  }
});

test("crash after the SQL of a non-transactional file leaves no ledger row and no effects; a self-transacting file leaves a stale 'running' row the repair tool resolves", { skip }, async () => {
  const fixture = fixtureRoot([
    ["901_plain.sql", "CREATE TABLE siton.zz_plain_probe (id INT PRIMARY KEY);\nINSERT INTO siton.zz_plain_probe VALUES (1);\n"],
    ["902_tx.sql", "BEGIN;\nCREATE TABLE siton.zz_tx_probe (id INT PRIMARY KEY);\nCREATE INDEX zz_tx_probe_idx ON siton.zz_tx_probe (id);\nCOMMIT;\n"]
  ]);
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: "migfault" });
  const run = (extra = {}) => quiet(() => runMigrations(db.url, { migrations: fixture.migrations, migrationsDir: fixture.dir, ...extra }));
  try {
    // (b) atomic path: crash between the file SQL and the ledger write.
    await withEnv({ NODE_ENV: "test", SITON_MIGRATION_FAULT: "after_sql:901" }, async () => {
      await assert.rejects(run(), /migration failed: 901/);
    });
    assert.deepEqual((await sql(db.url, "SELECT migration_id, status FROM siton.migration_ledger")).rows, [], "no running/failed row survives the crash");
    assert.equal((await sql(db.url, "SELECT to_regclass('siton.zz_plain_probe') AS t")).rows[0].t, null, "no partial effects");
    // The fault hook is inert outside NODE_ENV=test.
    await withEnv({ NODE_ENV: "production", SITON_MIGRATION_FAULT: "after_sql:901" }, async () => {
      assert.equal((await run({ migrations: fixture.migrations.slice(0, 1) })).newly_applied, 1);
    });
    assert.equal((await sql(db.url, "SELECT status FROM siton.migration_ledger WHERE migration_id='901'")).rows[0].status, "succeeded");

    // Self-transacting file: the crash lands after its COMMIT -> stale 'running'.
    await withEnv({ NODE_ENV: "test", SITON_MIGRATION_FAULT: "after_sql:902" }, async () => {
      await assert.rejects(run(), /migration failed: 902/);
    });
    assert.equal((await sql(db.url, "SELECT status FROM siton.migration_ledger WHERE migration_id='902'")).rows[0].status, "running");
    await assert.rejects(run(), /ledger is dirty at 902 \(running\).*--clear-running 902/);
    const doctor = doctorIn(fixture.root, db.url);
    assert.match(doctor.stdout, /dirty rows: 902:running/);
    assert.match(doctor.stdout, /stale running 902: fingerprint verdict=applied present=2\/2/);

    // (c) refused without the right flags.
    let result = repairIn(fixture.root, db.url, ["--clear-running", "902"]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /verdict=applied present=2\/2/);
    assert.match(result.stderr, /choose exactly one of --mark-succeeded/);
    result = repairIn(fixture.root, db.url, ["--clear-running", "902", "--mark-failed", "--i-verified-no-partial-effects", "--yes"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--mark-failed needs verdict=absent, fingerprint says verdict=applied/);
    result = repairIn(fixture.root, db.url, ["--clear-running", "902", "--mark-succeeded", "--yes"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--i-verified-applied/);
    result = repairIn("/", "postgresql://u:p@db.example-project.supabase.co:5432/postgres", ["--clear-running", "902", "--mark-succeeded", "--i-verified-applied", "--yes"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refuses host .* without --allow-hosted/);
    result = repairIn(fixture.root, db.url, ["--clear-running", "902", "--mark-succeeded", "--i-verified-applied"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /mode=DRY_RUN[\s\S]*dry run; re-run with --yes/);
    assert.equal((await sql(db.url, "SELECT status FROM siton.migration_ledger WHERE migration_id='902'")).rows[0].status, "running", "dry run changes nothing");
    // A live runner (holding the runner lock) blocks the repair.
    const holder = new Client({ connectionString: db.url });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [runner.MIGRATION_ADVISORY_LOCK_KEY]);
      result = repairIn(fixture.root, db.url, ["--clear-running", "902", "--mark-succeeded", "--i-verified-applied", "--yes"]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /holds the runner lock/);
    } finally { await holder.end(); }
    // With the right flags: marked succeeded, nothing re-run.
    result = repairIn(fixture.root, db.url, ["--clear-running", "902", "--mark-succeeded", "--i-verified-applied", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /MIGRATIONS_REPAIR_APPLIED rows=1/);
    assert.deepEqual(await run(), { applied: 2, newly_applied: 0, eol_variants: 0 });

    // The other branch: 'running' but the objects are absent -> mark failed & rerun.
    await sql(db.url, "DROP TABLE siton.zz_tx_probe");
    await sql(db.url, "UPDATE siton.migration_ledger SET status='running', completed_at=NULL WHERE migration_id='902'");
    result = repairIn(fixture.root, db.url, ["--clear-running", "902", "--mark-succeeded", "--i-verified-applied", "--yes"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs verdict=applied, fingerprint says verdict=absent/);
    result = repairIn(fixture.root, db.url, ["--clear-running", "902", "--mark-failed", "--i-verified-no-partial-effects", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /MIGRATIONS_REPAIR_APPLIED rows=1/);
    assert.equal((await run()).newly_applied, 1);
    assert.equal((await sql(db.url, "SELECT to_regclass('siton.zz_tx_probe') AS t")).rows[0].t, "siton.zz_tx_probe");
    assert.match(doctorIn(fixture.root, db.url).stdout, /verdict=HEALTHY\b/);
  } finally {
    await db.drop();
    fixture.cleanup();
  }
});

test("lock_timeout: a migration queued behind an ACCESS EXCLUSIVE lock fails fast instead of hanging", { skip }, async () => {
  const fixture = fixtureRoot([
    ["911_lock.sql", "ALTER TABLE siton.zz_lock_target ADD COLUMN extra INT;\n"],
    ["912_slow.sql", "SELECT pg_sleep(5);\n"]
  ]);
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: "miglocktimeout" });
  const holder = new Client({ connectionString: db.url });
  await holder.connect();
  try {
    await sql(db.url, "CREATE SCHEMA siton; CREATE TABLE siton.zz_lock_target (id INT)");
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE siton.zz_lock_target IN ACCESS EXCLUSIVE MODE");
    const started = Date.now();
    await withEnv({ MIGRATION_LOCK_TIMEOUT_MS: "400" }, async () => {
      await assert.rejects(quiet(() => runMigrations(db.url, { migrations: fixture.migrations.slice(0, 1), migrationsDir: fixture.dir })), /migration failed: 911 .*lock timeout/);
    });
    assert.ok(Date.now() - started < 4000, "failed within the lock timeout, took " + (Date.now() - started) + "ms");
    await holder.query("ROLLBACK");
    const row = (await sql(db.url, "SELECT status, error_message FROM siton.migration_ledger WHERE migration_id='911'")).rows[0];
    assert.equal(row.status, "failed");
    assert.match(row.error_message, /lock timeout/);
    // statement_timeout bounds a single long statement the same way.
    await sql(db.url, "DELETE FROM siton.migration_ledger");
    const slow = [{ ...fixture.migrations[1], position: 1 }];
    await assert.rejects(quiet(() => runMigrations(db.url, { migrations: slow, migrationsDir: fixture.dir, statementTimeoutMs: 300 })), /migration failed: 912 .*statement timeout/);
  } finally {
    await holder.end().catch(() => undefined);
    await db.drop();
    fixture.cleanup();
  }
});
