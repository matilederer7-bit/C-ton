const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { runMigrations } = require("./run_migrations.cjs");
const { MIGRATIONS } = require("./migration_manifest.cjs");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  await runMigrations(connectionString);
  await runMigrations(connectionString);
  const client = new Client({ connectionString });
  await client.connect();
  const ledger = await client.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='succeeded')::int AS succeeded FROM siton.migration_ledger");
  const objects = await client.query(`SELECT
    (SELECT COUNT(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='siton') AS functions,
    (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='siton' AND NOT t.tgisinternal) AS triggers,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='siton'::regnamespace) AS constraints,
    (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='siton') AS indexes,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='siton'::regnamespace AND contype='f') AS foreign_keys`);
  await client.end();
  const report = { expected_migrations: MIGRATIONS.length, ...ledger.rows[0], ...objects.rows[0], rerun: "pass" };
  if (report.total !== MIGRATIONS.length || report.succeeded !== MIGRATIONS.length) throw new Error("migration ledger is incomplete");
  for (const key of ["functions", "triggers", "constraints", "indexes", "foreign_keys"]) if (Number(report[key]) < 1) throw new Error(`missing ${key}`);
  fs.mkdirSync(path.join(process.cwd(), ".ci-artifacts"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), ".ci-artifacts", "migration-report.json"), JSON.stringify(report, null, 2));
  console.log("CI_MIGRATION_REPORT_PASS", JSON.stringify(report));
}
main().catch((error) => { console.error(error); process.exit(1); });
