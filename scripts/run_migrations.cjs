const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });
const { MIGRATIONS_DIR, MIGRATIONS } = require("./migration_manifest.cjs");

// Canonical checksum: BOM stripped, line endings normalised to LF. The git
// index stores every migration with LF; a Windows checkout (core.autocrlf)
// materialises CRLF. Without normalisation the same file hashes differently
// on Windows and Linux, and a ledger written from one platform rejects the
// other with a false "checksum mismatch". Normalising to LF keeps every
// ledger written from Linux/CI valid unchanged.
function canonicalBody(body) {
  return String(body).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}
function checksum(body) {
  return createHash("sha256").update(canonicalBody(body), "utf8").digest("hex");
}
// Legacy variant: the digest a CRLF working tree produced before
// normalisation. Accepted on READ so a ledger row written from a Windows
// checkout is recognised as the same file (never written any more).
function checksumCrlfVariant(body) {
  return createHash("sha256").update(canonicalBody(body).replace(/\n/g, "\r\n"), "utf8").digest("hex");
}
function classifyChecksum(storedDigest, body) {
  if (storedDigest === checksum(body)) return "match";
  if (storedDigest === checksumCrlfVariant(body)) return "eol-variant";
  return "mismatch";
}

async function ensureLedger(client) {
  await client.query("CREATE SCHEMA IF NOT EXISTS siton");
  await client.query(`
    CREATE TABLE IF NOT EXISTS siton.migration_ledger (
      migration_id TEXT PRIMARY KEY,
      position INT NOT NULL UNIQUE,
      filename TEXT NOT NULL UNIQUE,
      checksum_sha256 TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NULL,
      status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
      error_message TEXT NULL
    )`);
}

async function runMigrations(connectionString = process.env.DATABASE_URL, options = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await ensureLedger(client);
    const dirty = await client.query(
      `SELECT migration_id, status FROM siton.migration_ledger WHERE status <> 'succeeded' ORDER BY position LIMIT 1`
    );
    if (dirty.rowCount) {
      throw new Error(`migration ledger is dirty at ${dirty.rows[0].migration_id} (${dirty.rows[0].status})`);
    }

    const migrations = options.migrations || MIGRATIONS;
    const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;
    let eolVariants = 0;
    let newlyApplied = 0;
    for (const migration of migrations) {
      // options.resolveDir lets the preflight mix the real migrations with a
      // probe file from a temporary directory.
      const filePath = path.join(options.resolveDir ? options.resolveDir(migration.filename) : migrationsDir, migration.filename);
      if (!fs.existsSync(filePath)) throw new Error(`missing migration file: ${migration.filename}`);
      const sql = canonicalBody(fs.readFileSync(filePath, "utf8"));
      const digest = checksum(sql);
      const applied = await client.query(
        `SELECT position, filename, checksum_sha256, status
         FROM siton.migration_ledger WHERE migration_id=$1`,
        [migration.id]
      );
      if (applied.rowCount) {
        const row = applied.rows[0];
        if (row.status !== "succeeded") throw new Error(`migration ${migration.id} is not in succeeded state`);
        if (row.filename !== migration.filename || Number(row.position) !== migration.position) {
          throw new Error(`migration manifest mismatch for ${migration.id}`);
        }
        const classification = classifyChecksum(row.checksum_sha256, sql);
        if (classification === "mismatch") {
          throw new Error(`migration checksum mismatch: ${migration.id} ${migration.filename}`);
        }
        if (classification === "eol-variant") {
          // Same file, hashed from a CRLF checkout before normalisation.
          // Accepted; `npm run migrations:doctor` reports it and
          // `migrations:repair --fix-eol-checksums` can rewrite it explicitly.
          console.log(`MIGRATION_LEDGER_EOL_VARIANT ${migration.id} ${migration.filename} (line-ending-only checksum difference accepted)`);
          eolVariants += 1;
        }
        continue;
      }

      await client.query(
        `INSERT INTO siton.migration_ledger
           (migration_id, position, filename, checksum_sha256, started_at, status)
         VALUES ($1,$2,$3,$4,now(),'running')`,
        [migration.id, migration.position, migration.filename, digest]
      );
      try {
        await client.query(sql);
        await client.query(
          `UPDATE siton.migration_ledger
           SET status='succeeded', completed_at=now(), error_message=NULL
           WHERE migration_id=$1`,
          [migration.id]
        );
        console.log(`MIGRATION_OK ${migration.id} ${migration.filename}`);
        newlyApplied += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(
          `UPDATE siton.migration_ledger
           SET status='failed', completed_at=now(), error_message=$2
           WHERE migration_id=$1`,
          [migration.id, String(error?.message || error).slice(0, 2000)]
        );
        throw new Error(`migration failed: ${migration.id} ${migration.filename}: ${error?.message || error}`);
      }
    }
    return { applied: migrations.length, newly_applied: newlyApplied, eol_variants: eolVariants };
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(({ applied }) => console.log(`MIGRATIONS_COMPLETE count=${applied}`))
    .catch((error) => {
      console.error(`MIGRATIONS_FAILED ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { runMigrations, checksum, checksumCrlfVariant, classifyChecksum, canonicalBody, ensureLedger };
