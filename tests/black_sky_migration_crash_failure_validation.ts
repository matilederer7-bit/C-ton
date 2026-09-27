// BLACK-SKY COMBINATION 5 — the migration runner crashes mid-file while a
// second runner starts and the readiness probe keeps asking.
//
// DISPOSABLE database only: a clone (CREATE DATABASE ... TEMPLATE) of this
// test's own per-test database, created through scripts/lib/test_db_isolation
// (local hosts only) and dropped at the end. The fixture repository is a temp
// directory holding the REAL migration files + manifest plus one probe file,
// so readiness is judged against the real REQUIRED_MIGRATION_IDS.
//
//   M5 COMBINES (3): runner 1 dies right after a self-transacting file commits
//       (SITON_MIGRATION_FAULT=after_sql:901, the runner's own NODE_ENV=test
//       hook: pg_terminate_backend of its own backend) + a SECOND runner starts
//       while runner 1 holds the runner lock + the web AND worker readiness
//       probes run during the in-flight run and against the dirty ledger.
//      EXPECTED (fail closed): runner 2 is refused (runner lock); readiness
//       fails closed while 901 is 'running' (in flight and after the crash);
//       any later runner refuses the dirty ledger; migrations:doctor names the
//       stale row with verdict=applied; migrations:repair refuses without the
//       explicit flags and repairs with them; afterwards a runner applies
//       nothing, readiness passes and the doctor reports HEALTHY.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { assertCanonicalRuntimeReady } from "../src/runtime_database_boundary.js";
import { REPO_ROOT, requireRepoScript, sleep } from "./support/black_sky_chaos.js";

const isolation = requireRepoScript("scripts/lib/test_db_isolation.cjs");
const runner = requireRepoScript("scripts/run_migrations.cjs");
const manifest = requireRepoScript("scripts/migration_manifest.cjs");

const baseUrl = String(process.env.DATABASE_URL || "");
isolation.assertLocalBase(baseUrl);
const templateName = decodeURIComponent(new URL(baseUrl).pathname.replace(/^\//, ""));
assert.match(templateName, /^siton_test_/, "runs only from a disposable per-test database");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.stack || error}`); }
}

const PROBE_ID = "901";
const PROBE_FILE = "901_black_sky_probe.sql";
function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siton-black-sky-mig-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.cpSync(path.join(REPO_ROOT, "src", "migrations"), path.join(root, "src", "migrations"), { recursive: true });
  // self-transacting (own BEGIN/COMMIT) -> the runner records 'running' first;
  // the sleep keeps runner 1 inside the file while runner 2 and the probe race it
  fs.writeFileSync(path.join(root, "src", "migrations", PROBE_FILE),
    "BEGIN;\nCREATE TABLE siton.zz_black_sky_probe (id INT PRIMARY KEY);\nCREATE INDEX zz_black_sky_probe_idx ON siton.zz_black_sky_probe (id);\nSELECT pg_sleep(1.5);\nCOMMIT;\n");
  const entries = [...manifest.MIGRATIONS.map((m: any) => ({ id: m.id, filename: m.filename, position: m.position })), { id: PROBE_ID, filename: PROBE_FILE, position: manifest.MIGRATIONS.length + 1 }];
  fs.writeFileSync(path.join(root, "scripts", "migration_manifest.cjs"), [
    "const path = require('node:path');",
    "const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'migrations');",
    `const MIGRATIONS = ${JSON.stringify(entries)};`,
    "module.exports = { MIGRATIONS_DIR, MIGRATIONS };"
  ].join("\n"));
  return { root, migrations: entries, dir: path.join(root, "src", "migrations") };
}

function tool(root: string, script: string, url: string, extra: string[] = []) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", script), "--database", url, ...extra], {
    cwd: root, encoding: "utf8", env: { ...process.env, SITON_RELEASE_ARTIFACTS_DIR: path.join(root, ".release-artifacts") }
  });
}

async function readiness(url: string, kind: "web" | "worker") {
  const probe = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await assertCanonicalRuntimeReady(probe as any, kind, { ...process.env, CANONICAL_POSTGRES_RUNTIME: "" });
    return { ready: true as const, reason: "" };
  } catch (error) {
    return { ready: false as const, reason: String((error as any)?.message || error) };
  } finally {
    await probe.end();
  }
}

async function ledgerRow(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(`SELECT status FROM siton.migration_ledger WHERE migration_id=$1`, [PROBE_ID])).rows[0] as { status: string } | undefined; }
  finally { await c.end(); }
}

async function quiet<T>(fn: () => Promise<T>) { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } }

await run("M5 runner crash mid-file + concurrent second runner + readiness during the dirty ledger → fail closed, runner 2 refused, repair restores", async () => {
  const fixture = fixtureRoot();
  const db = await isolation.createIsolatedDatabase({ baseUrl, template: templateName, purpose: "bsmigcrash" });
  const previous = { NODE_ENV: process.env.NODE_ENV, SITON_MIGRATION_FAULT: process.env.SITON_MIGRATION_FAULT };
  try {
    const before = await readiness(db.url, "web");
    assert.equal(before.ready, true, `vacuity: the clone is ready before the incident (${before.reason})`);

    process.env.NODE_ENV = "test";
    process.env.SITON_MIGRATION_FAULT = `after_sql:${PROBE_ID}`;
    const runner1 = quiet(() => runner.runMigrations(db.url, { migrations: fixture.migrations, migrationsDir: fixture.dir }))
      .then(() => ({ ok: true as const, message: "" }), (error: any) => ({ ok: false as const, message: String(error?.message || error) }));
    // runner 1 is inside 901 (ledger row 'running', runner lock held)
    let midRun = await ledgerRow(db.url);
    for (let i = 0; i < 40 && midRun?.status !== "running"; i += 1) { await sleep(50); midRun = await ledgerRow(db.url); }
    assert.equal(midRun?.status, "running", "runner 1 is mid-file");
    const [runner2, webDuring, workerDuring] = await Promise.all([
      quiet(() => runner.runMigrations(db.url, { migrations: fixture.migrations, migrationsDir: fixture.dir, advisoryLockWaitMs: 300 }))
        .then(() => ({ ok: true as const, message: "" }), (error: any) => ({ ok: false as const, message: String(error?.message || error) })),
      readiness(db.url, "web"),
      readiness(db.url, "worker")
    ]);
    // runner 1's quiet() still owns console.log here: write the evidence directly
    process.stdout.write(`  M5 during run: runner2=${JSON.stringify(runner2)} web=${JSON.stringify(webDuring)} worker=${JSON.stringify(workerDuring)}\n`);
    assert.equal(runner2.ok, false, "the second runner is refused");
    assert.match(runner2.message, /another migration run holds the runner lock/);
    assert.equal(webDuring.ready, false, "web readiness fails closed while a migration is in flight");
    assert.match(webDuring.reason, /incomplete at 901/);
    assert.equal(workerDuring.ready, false, "worker readiness fails closed too");

    const r1 = await runner1;
    console.log(`  M5 runner1: ${JSON.stringify(r1)}`);
    assert.equal(r1.ok, false, "runner 1 died mid-file");
    assert.match(r1.message, /migration failed: 901/);
    process.env.SITON_MIGRATION_FAULT = "";
    assert.equal((await ledgerRow(db.url))?.status, "running", "a stale 'running' row is left behind");

    const webAfter = await readiness(db.url, "web");
    assert.equal(webAfter.ready, false, "readiness fails closed on the dirty ledger");
    assert.match(webAfter.reason, /incomplete at 901/);
    const runner3 = await quiet(() => runner.runMigrations(db.url, { migrations: fixture.migrations, migrationsDir: fixture.dir })).then(() => "applied", (error: any) => String(error?.message || error));
    assert.match(runner3, /ledger is dirty at 901 \(running\)/, "no runner proceeds past a dirty ledger");

    const doctor = tool(fixture.root, "migrations_doctor.cjs", db.url);
    assert.match(doctor.stdout, /dirty rows: 901:running/, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /stale running 901: fingerprint verdict=applied present=2\/2/);

    let repair = tool(fixture.root, "migrations_repair.cjs", db.url, ["--clear-running", PROBE_ID, "--mark-succeeded", "--yes"]);
    assert.equal(repair.status, 2, "repair refuses without the explicit verification flag");
    repair = tool(fixture.root, "migrations_repair.cjs", db.url, ["--clear-running", PROBE_ID, "--mark-failed", "--i-verified-no-partial-effects", "--yes"]);
    assert.equal(repair.status, 2, "repair refuses the choice the fingerprint contradicts");
    repair = tool(fixture.root, "migrations_repair.cjs", db.url, ["--clear-running", PROBE_ID, "--mark-succeeded", "--i-verified-applied", "--yes"]);
    assert.equal(repair.status, 0, repair.stdout + repair.stderr);
    assert.match(repair.stdout, /MIGRATIONS_REPAIR_APPLIED rows=1/);

    const runner4 = await quiet(() => runner.runMigrations(db.url, { migrations: fixture.migrations, migrationsDir: fixture.dir }) as Promise<{ newly_applied: number }>);
    assert.equal(runner4.newly_applied, 0, "nothing is re-run after the repair");
    const webRestored = await readiness(db.url, "web");
    const workerRestored = await readiness(db.url, "worker");
    assert.equal(webRestored.ready, true, webRestored.reason);
    assert.equal(workerRestored.ready, true, workerRestored.reason);
    const healthy = tool(fixture.root, "migrations_doctor.cjs", db.url);
    assert.match(healthy.stdout, /verdict=HEALTHY\b/, healthy.stdout + healthy.stderr);
  } finally {
    process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.SITON_MIGRATION_FAULT === undefined) delete process.env.SITON_MIGRATION_FAULT;
    else process.env.SITON_MIGRATION_FAULT = previous.SITON_MIGRATION_FAULT;
    await db.drop().catch(() => undefined);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

console.log(`\nSUMMARY black_sky_migration_crash passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
