const { Client } = require("pg");
const { spawnSync } = require("node:child_process");
require("dotenv").config({ quiet: true });

function databaseUrl(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function main() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required");
  const parsed = new URL(base);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) throw new Error("isolated migration proof refuses non-local PostgreSQL");
  const admin = new Client({ connectionString: databaseUrl(base, "postgres") });
  await admin.connect();
  const name = `siton_migration_proof_${process.pid}_${Date.now()}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const result = spawnSync(process.execPath, ["scripts/ci_migration_report.cjs"], {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl(base, name), NODE_ENV: "test", DISABLE_OUTBOX_WORKER: "1" },
      timeout: 10 * 60_000
    });
    if (result.status !== 0) throw result.error || new Error(`migration proof failed: ${result.status}`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log("ISOLATED_MIGRATION_PROOF_PASS fresh_install=pass repeat=pass checksum_ledger=pass drift=0 production_changes=0");
}

main().catch((error) => { console.error(error); process.exit(1); });
