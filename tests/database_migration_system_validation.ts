import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { assertDatabaseSchema } from "../src/schema_contract.js";

const require = createRequire(import.meta.url);
const { runMigrations } = require(path.join(process.cwd(), "scripts", "run_migrations.cjs"));
const { MIGRATIONS } = require(path.join(process.cwd(), "scripts", "migration_manifest.cjs"));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString });

async function run(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}

await run("clean canonical install has a complete successful ledger", async () => {
  const rows = await pool.query(`SELECT migration_id, filename, checksum_sha256, started_at, completed_at, status FROM siton.migration_ledger ORDER BY position`);
  assert.equal(rows.rowCount, MIGRATIONS.length);
  assert.ok(rows.rows.every((row) => row.status === "succeeded" && row.checksum_sha256.length === 64 && row.started_at && row.completed_at));
  await assertDatabaseSchema(pool);
});

await run("existing demo schema upgrades through the full ledger without data loss", async () => {
  const dealId = "d0000000-0000-4000-8000-000000000002";
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, price_per_unit, min_units, max_units,
        threshold_units, deadline, published_at, created_at, updated_at)
     VALUES ($1, 'seller-default', 'migration-upgrade-sentinel', 'PendingTarget',
             17.25, 1, 12, 3, now() + interval '1 day', now(), now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId]
  );
  const before = await pool.query(`SELECT title, price_per_unit::text, max_units FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(before.rowCount, 1);

  // A historical demo database can already contain the idempotent schema but
  // predate the canonical ledger. Rebuilding only the ledger exercises that
  // supported adoption/upgrade route without rewriting historical SQL.
  await pool.query(`TRUNCATE siton.migration_ledger`);
  await runMigrations(connectionString);
  const after = await pool.query(`SELECT title, price_per_unit::text, max_units FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.deepEqual(after.rows, before.rows);
  const ledger = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.migration_ledger WHERE status='succeeded'`);
  assert.equal(ledger.rows[0].count, MIGRATIONS.length);
  await assertDatabaseSchema(pool);
});

await run("canonical schema contains functions triggers constraints indexes and foreign keys", async () => {
  const objects = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='siton') AS functions,
      (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='siton' AND NOT t.tgisinternal) AS triggers,
      (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='siton'::regnamespace) AS constraints,
      (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='siton') AS indexes,
      (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='siton'::regnamespace AND contype='f') AS foreign_keys
  `);
  const row = objects.rows[0];
  for (const key of ["functions", "triggers", "constraints", "indexes", "foreign_keys"]) {
    assert.ok(Number(row[key]) > 0, `expected canonical ${key}`);
  }
  await assertDatabaseSchema(pool);
});

await run("checksum mismatch is rejected before any migration continues", async () => {
  const id = MIGRATIONS[0].id;
  const original = await pool.query(`SELECT checksum_sha256 FROM siton.migration_ledger WHERE migration_id=$1`, [id]);
  await pool.query(`UPDATE siton.migration_ledger SET checksum_sha256=$2 WHERE migration_id=$1`, [id, "0".repeat(64)]);
  await assert.rejects(runMigrations(connectionString), /checksum mismatch/);
  await pool.query(`UPDATE siton.migration_ledger SET checksum_sha256=$2 WHERE migration_id=$1`, [id, original.rows[0].checksum_sha256]);
});

await run("failed migration rolls back its DDL and records failure", async () => {
  const dir = path.join(process.cwd(), ".tmp_test_dist", "failed-migration");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "failure.sql"), "BEGIN; CREATE TABLE siton.must_rollback(id int); SELECT missing_column FROM siton.deals; COMMIT;", "utf8");
  await assert.rejects(runMigrations(connectionString, { migrationsDir: dir, migrations: [{ id: "failure_probe", filename: "failure.sql", position: MIGRATIONS.length + 1 }] }), /migration failed/);
  const table = await pool.query(`SELECT to_regclass('siton.must_rollback') AS name`);
  assert.equal(table.rows[0].name, null);
  const ledger = await pool.query(`SELECT status, error_message FROM siton.migration_ledger WHERE migration_id='failure_probe'`);
  assert.equal(ledger.rows[0].status, "failed");
  assert.ok(ledger.rows[0].error_message);
  await pool.query(`DELETE FROM siton.migration_ledger WHERE migration_id='failure_probe'`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await run("startup validation refuses schema drift", async () => {
  await pool.query(`ALTER TABLE siton.webhook_events DROP CONSTRAINT webhook_events_status_check`);
  await assert.rejects(assertDatabaseSchema(pool), /schema drift/);
  await pool.query(`ALTER TABLE siton.webhook_events ADD CONSTRAINT webhook_events_status_check CHECK (status IN ('pending','processing','processed','ignored','failed'))`);
  await assertDatabaseSchema(pool);
});

await run("startup validation distinguishes missing schema from denied or failed access", async () => {
  // SQLSTATE routing: only undefined_table / invalid_schema_name may be
  // reported as an unmigrated schema. Everything else must surface its code
  // so a wrong DATABASE_URL identity is not misdiagnosed as missing schema.
  const failingDb = (code: string) => ({
    query: () => Promise.reject(Object.assign(new Error("probe"), { code }))
  });
  await assert.rejects(assertDatabaseSchema(failingDb("42P01")), /migration_ledger is missing/);
  await assert.rejects(assertDatabaseSchema(failingDb("3F000")), /migration_ledger is missing/);
  await assert.rejects(assertDatabaseSchema(failingDb("42501")), /lacks privilege on siton\.migration_ledger \(code 42501\)/);
  await assert.rejects(assertDatabaseSchema(failingDb("42501")), (error: Error) => !/is missing/.test(error.message));
  await assert.rejects(assertDatabaseSchema(failingDb("ECONNREFUSED")), /schema check failed before migration inspection \(code ECONNREFUSED\)/);
  await assert.rejects(
    assertDatabaseSchema({ query: () => Promise.reject(new Error("no code")) }),
    /schema check failed before migration inspection \(code unknown\)/
  );

  // Real-database proof: an unprivileged role hitting the live ledger raises
  // a genuine 42501 and must be reported as denied access, never as missing.
  await pool.query(`
    DO $probe_role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='siton_schema_probe') THEN
        CREATE ROLE siton_schema_probe NOLOGIN;
      END IF;
    END
    $probe_role$;
  `);
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE siton_schema_probe`);
    await assert.rejects(assertDatabaseSchema(client), /code 42501/);
    await assert.rejects(assertDatabaseSchema(client), (error: Error) => !/is missing/.test(error.message));
  } finally {
    await client.query(`RESET ROLE`);
    client.release();
  }
  await assertDatabaseSchema(pool);
});

await pool.end();
