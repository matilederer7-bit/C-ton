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
  return String(body).replace(/^﻿/, "").replace(/\r\n/g, "\n");
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

// Session-level advisory lock held for the whole run: 0x5349544F4E ("SITON").
// A second runner (another deploy, a manual `npm run db:migrate`) polls for
// it and fails with a clear message after a bounded wait instead of racing
// the first one on CREATE TABLE / ledger inserts. Session-level advisory
// locks need a session-mode connection (direct or session pooler), which is
// what migrations already require.
const MIGRATION_ADVISORY_LOCK_KEY = "357712547662";
const DEFAULT_ADVISORY_LOCK_WAIT_MS = 60000;
const ADVISORY_LOCK_POLL_MS = 250;
// Per-migration timeouts, set at SESSION level (SET, not SET LOCAL: a file may
// carry its own BEGIN/COMMIT). lock_timeout keeps an ACCESS EXCLUSIVE request
// queued behind a long transaction from stalling all traffic queued behind it.
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10 * 60 * 1000;

function nonNegativeInt(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid ${name}: ${value} (expected a non-negative integer of milliseconds)`);
  return parsed;
}

function resolveRunnerSettings(options = {}, env = process.env) {
  return {
    lockTimeoutMs: nonNegativeInt(options.lockTimeoutMs ?? env.MIGRATION_LOCK_TIMEOUT_MS, DEFAULT_LOCK_TIMEOUT_MS, "MIGRATION_LOCK_TIMEOUT_MS"),
    statementTimeoutMs: nonNegativeInt(options.statementTimeoutMs ?? env.MIGRATION_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS, "MIGRATION_STATEMENT_TIMEOUT_MS"),
    advisoryLockWaitMs: nonNegativeInt(options.advisoryLockWaitMs ?? env.MIGRATION_ADVISORY_LOCK_WAIT_MS, DEFAULT_ADVISORY_LOCK_WAIT_MS, "MIGRATION_ADVISORY_LOCK_WAIT_MS")
  };
}

// Strip dollar-quoted bodies and comments so `END;` / `COMMIT;` inside a
// PL/pgSQL function or DO block is not mistaken for top-level control.
function topLevelSql(body) {
  return canonicalBody(body)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, "");
}
/** True when the file manages its own transaction (top-level BEGIN/COMMIT/...). */
function hasExplicitTransactionControl(body) {
  return /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b(\s+(WORK|TRANSACTION))?\s*;/im.test(topLevelSql(body));
}
/** Statements PostgreSQL refuses inside a transaction block. */
function requiresNoTransactionBlock(body) {
  return /\b(CONCURRENTLY|VACUUM|ALTER\s+SYSTEM|CREATE\s+DATABASE|DROP\s+DATABASE|CREATE\s+TABLESPACE)\b/i.test(topLevelSql(body));
}

// Test-only fault injection: SITON_MIGRATION_FAULT=after_sql:<id> terminates
// the runner's own backend right after the file's SQL and before the ledger
// records success, simulating a crash / lost connection. Honoured ONLY when
// NODE_ENV=test.
function faultFor(id, env = process.env) {
  if (env.NODE_ENV !== "test") return false;
  return String(env.SITON_MIGRATION_FAULT || "") === `after_sql:${id}`;
}
const CRASH_SQL = "SELECT pg_terminate_backend(pg_backend_pid());";

async function acquireRunnerLock(client, waitMs) {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const result = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [MIGRATION_ADVISORY_LOCK_KEY]);
    if (result.rows[0].locked) return;
    if (Date.now() >= deadline) {
      throw new Error(`another migration run holds the runner lock (pg advisory lock ${MIGRATION_ADVISORY_LOCK_KEY}); gave up after waiting ${waitMs}ms. Let it finish, or inspect pg_locks WHERE locktype='advisory'`);
    }
    if (!announced) {
      console.log(`MIGRATION_LOCK_WAIT another migration run is in progress; waiting up to ${waitMs}ms`);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(ADVISORY_LOCK_POLL_MS, deadline - Date.now()))));
  }
}

async function applySessionTimeouts(client, settings) {
  await client.query(`SET lock_timeout = ${Number(settings.lockTimeoutMs)}`);
  await client.query(`SET statement_timeout = ${Number(settings.statementTimeoutMs)}`);
}

async function runMigrations(connectionString = process.env.DATABASE_URL, options = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const settings = resolveRunnerSettings(options);
  const client = new Client({ connectionString });
  // A backend that dies mid-run (crash, admin termination, the test fault
  // hook) must surface as a rejected query, not as an unhandled 'error' event.
  client.on("error", () => undefined);
  await client.connect();
  let locked = false;
  try {
    await acquireRunnerLock(client, settings.advisoryLockWaitMs);
    locked = true;
    await applySessionTimeouts(client, settings);
    await ensureLedger(client);
    const dirty = await client.query(
      `SELECT migration_id, status FROM siton.migration_ledger WHERE status <> 'succeeded' ORDER BY position LIMIT 1`
    );
    if (dirty.rowCount) {
      const { migration_id: dirtyId, status } = dirty.rows[0];
      // We hold the runner lock, so no live runner owns a 'running' row: a
      // previous run stopped between applying a self-transacting file and
      // recording it, and the file may well be applied.
      const hint = status === "running"
        ? `; a previous run stopped before recording the result (the file may already be applied). Run npm run migrations:doctor, then npm run migrations:repair -- --clear-running ${dirtyId} (see scripts/migrations_repair.cjs)`
        : "";
      throw new Error(`migration ledger is dirty at ${dirtyId} (${status})${hint}`);
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

      // Re-assert the session timeouts: an earlier file may have changed them.
      await applySessionTimeouts(client, settings);
      const crash = faultFor(migration.id);
      const atomic = !hasExplicitTransactionControl(sql) && !requiresNoTransactionBlock(sql);
      const lit = (value) => client.escapeLiteral(String(value));
      try {
        if (atomic) {
          // One simple-query string: the file's DDL and its ledger row commit
          // together or not at all. A crash anywhere before COMMIT leaves no
          // ledger row and no effects, so the next run simply retries.
          await client.query([
            "BEGIN;",
            sql,
            ";",
            crash ? CRASH_SQL : "",
            `INSERT INTO siton.migration_ledger (migration_id, position, filename, checksum_sha256, started_at, completed_at, status)
             VALUES (${lit(migration.id)}, ${Number(migration.position)}, ${lit(migration.filename)}, ${lit(digest)}, now(), clock_timestamp(), 'succeeded');`,
            "COMMIT;"
          ].join("\n"));
        } else {
          // The file controls its own transaction (or must run outside one):
          // record 'running' first. If the process dies after the file commits
          // but before the UPDATE, the row stays 'running'; the next run
          // refuses with a clear message and `migrations:repair
          // --clear-running` resolves it after verifying the objects.
          await client.query(
            `INSERT INTO siton.migration_ledger
               (migration_id, position, filename, checksum_sha256, started_at, status)
             VALUES ($1,$2,$3,$4,now(),'running')`,
            [migration.id, migration.position, migration.filename, digest]
          );
          await client.query(sql);
          if (crash) await client.query(CRASH_SQL);
          await client.query(
            `UPDATE siton.migration_ledger
             SET status='succeeded', completed_at=now(), error_message=NULL
             WHERE migration_id=$1`,
            [migration.id]
          );
        }
        console.log(`MIGRATION_OK ${migration.id} ${migration.filename}`);
        newlyApplied += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        let ledgerNote = "";
        try {
          await client.query(
            `INSERT INTO siton.migration_ledger
               (migration_id, position, filename, checksum_sha256, started_at, completed_at, status, error_message)
             VALUES ($1,$2,$3,$4,now(),now(),'failed',$5)
             ON CONFLICT (migration_id) DO UPDATE
               SET status='failed', completed_at=now(), error_message=EXCLUDED.error_message`,
            [migration.id, migration.position, migration.filename, digest, String(error?.message || error).slice(0, 2000)]
          );
        } catch (ledgerError) {
          // Connection gone: an atomic file left nothing behind; a
          // self-transacting file left a 'running' row for the repair tool.
          ledgerNote = ` (ledger not updated: ${ledgerError?.message || ledgerError})`;
        }
        throw new Error(`migration failed: ${migration.id} ${migration.filename}: ${error?.message || error}${ledgerNote}`);
      }
    }
    return { applied: migrations.length, newly_applied: newlyApplied, eol_variants: eolVariants };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
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

module.exports = {
  runMigrations, checksum, checksumCrlfVariant, classifyChecksum, canonicalBody, ensureLedger,
  MIGRATION_ADVISORY_LOCK_KEY, DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS, DEFAULT_ADVISORY_LOCK_WAIT_MS,
  resolveRunnerSettings, hasExplicitTransactionControl, requiresNoTransactionBlock, topLevelSql
};
