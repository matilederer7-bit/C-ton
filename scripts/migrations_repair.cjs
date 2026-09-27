#!/usr/bin/env node
// Migration ledger repair helper (npm run migrations:repair -- <action> ...).
//
// Deliberately separate from the doctor. Nothing here runs unless the
// operator names an action AND passes --yes; without --yes the helper only
// prints exactly what it would change (dry run). A hosted database is refused
// unless --allow-hosted is also passed.
//
// Actions:
//   --fix-eol-checksums   rewrite ledger rows whose checksum equals the CRLF
//                         variant of the current file to the canonical LF
//                         checksum. Content is proven identical first; a row
//                         with a real content mismatch is never touched.
//   --clear-failed <id>   set a `failed` row back to a state the runner can
//                         retry by DELETING the row. Only allowed when the
//                         migration's objects are proven absent is NOT checked
//                         here: the operator must have verified atomicity
//                         (docs/DATABASE_INCIDENT_RUNBOOK.md) and passes
//                         --i-verified-no-partial-effects.
//   --clear-running <id>  resolve a row stuck at `running`. The runner writes
//                         `running` only for files that carry their own
//                         BEGIN/COMMIT (or must run outside a transaction);
//                         a process/connection death after the file's COMMIT
//                         but before the ledger UPDATE leaves the row there and
//                         every later run refuses ("ledger is dirty ...
//                         (running)"). Files without their own transaction
//                         control are applied atomically with their ledger row
//                         and never reach this state.
//
//     How to decide (the tool runs the object fingerprint first and prints it;
//     `npm run migrations:doctor` shows the same verdict read-only):
//       1. The row's checksum must still match the repository file (else the
//          file changed after the attempt: stop, investigate).
//       2. verdict=applied  (every object the file creates exists, at least one
//          without IF NOT EXISTS / OR REPLACE): the file's transaction
//          committed. Choose --mark-succeeded --i-verified-applied: the row is
//          set to succeeded and nothing is re-run.
//       3. verdict=absent   (none of the objects exist): the transaction never
//          committed. Choose --mark-failed --i-verified-no-partial-effects: the
//          row is deleted (failed + cleared in one step) and the next runner
//          invocation applies the file again.
//       4. verdict=partial: refused. A single-transaction file cannot be half
//          applied, so something else changed the schema; follow
//          docs/DATABASE_INCIDENT_RUNBOOK.md.
//       5. verdict=undetermined (nothing fingerprintable, e.g. data-only
//          UPDATEs, or only idempotent objects that may predate the file): the
//          tool cannot prove either way. Inspect the data by hand, then add
//          --accept-undetermined to the matching choice above.
//     While applying, the tool takes the runner's advisory lock, so it refuses
//     while a migration run is actually in progress.
const fs = require("node:fs");
const path = require("node:path");
const tools = require("./lib/migration_tools.cjs");
const isolation = require("./lib/test_db_isolation.cjs");
const { MIGRATION_ADVISORY_LOCK_KEY } = require("./run_migrations.cjs");

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };

async function main() {
  const databaseUrl = option("--database") || process.env.DATABASE_URL;
  if (!databaseUrl) { console.error("DATABASE_URL or --database is required"); process.exit(2); }
  const host = (() => { try { return new URL(databaseUrl).hostname.toLowerCase(); } catch { return "?"; } })();
  if (!isolation.LOCAL_HOSTS.has(host) && !flag("--allow-hosted")) { console.error("migrations:repair refuses host '" + host + "' without --allow-hosted"); process.exit(2); }
  const confirm = flag("--yes");
  const analysis = tools.analyzeManifest(root);
  const ledger = await tools.readLedger(databaseUrl);
  if (ledger === null) { console.error("no migration ledger in database"); process.exit(2); }
  const compared = tools.compareLedger(ledger, analysis);

  if (flag("--fix-eol-checksums")) {
    const targets = compared.rows.filter((row) => row.classification === "line_ending_only_mismatch");
    console.log("MIGRATIONS_REPAIR action=fix-eol-checksums host=" + host + " rows=" + targets.length + " mode=" + (confirm ? "APPLY" : "DRY_RUN"));
    for (const row of targets) console.log("  " + row.migration_id + " " + row.filename + ": " + row.stored_checksum.slice(0, 12) + "... -> " + row.repository_checksum_lf.slice(0, 12) + "...");
    if (!targets.length) { console.log("nothing to repair"); process.exit(0); }
    if (!confirm) { console.log("dry run; re-run with --yes to apply"); process.exit(0); }
    const updated = await tools.withClient(databaseUrl, async (client) => {
      let count = 0;
      await client.query("BEGIN");
      try {
        for (const row of targets) {
          const result = await client.query("UPDATE siton.migration_ledger SET checksum_sha256=$3 WHERE migration_id=$1 AND checksum_sha256=$2", [row.migration_id, row.stored_checksum, row.repository_checksum_lf]);
          count += result.rowCount;
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      return count;
    });
    console.log("MIGRATIONS_REPAIR_APPLIED rows=" + updated);
    process.exit(0);
  }

  if (option("--clear-failed")) {
    const id = option("--clear-failed");
    const row = compared.rows.find((item) => item.migration_id === id);
    console.log("MIGRATIONS_REPAIR action=clear-failed host=" + host + " migration=" + id + " mode=" + (confirm ? "APPLY" : "DRY_RUN"));
    if (!row) { console.error("no ledger row for " + id); process.exit(2); }
    if (row.status !== "failed") { console.error("row " + id + " is '" + row.status + "', not failed; nothing to clear"); process.exit(2); }
    console.log("  would DELETE ledger row " + id + " (" + row.filename + ", status failed) so the runner retries it");
    if (!flag("--i-verified-no-partial-effects")) { console.error("refusing: pass --i-verified-no-partial-effects after checking the migration's objects are absent (see docs/DATABASE_INCIDENT_RUNBOOK.md)"); process.exit(2); }
    if (!confirm) { console.log("dry run; re-run with --yes to apply"); process.exit(0); }
    const deleted = await tools.withClient(databaseUrl, (client) => client.query("DELETE FROM siton.migration_ledger WHERE migration_id=$1 AND status='failed'", [id]));
    console.log("MIGRATIONS_REPAIR_APPLIED rows=" + deleted.rowCount);
    process.exit(0);
  }

  if (option("--clear-running")) {
    const id = option("--clear-running");
    const row = compared.rows.find((item) => item.migration_id === id);
    console.log("MIGRATIONS_REPAIR action=clear-running host=" + host + " migration=" + id + " mode=" + (confirm ? "APPLY" : "DRY_RUN"));
    if (!row) { console.error("no ledger row for " + id); process.exit(2); }
    if (row.status !== "running") { console.error("row " + id + " is '" + row.status + "', not running; nothing to clear"); process.exit(2); }
    if (row.classification !== "match" && row.classification !== "line_ending_only_mismatch") {
      console.error("refusing: ledger row " + id + " is " + row.classification + " against the repository file; the file changed after the attempt"); process.exit(2);
    }
    const file = analysis.files.find((item) => item.id === id);
    const body = fs.readFileSync(path.join(tools.loadManifest(root).dir, file.filename), "utf8");
    const verification = await tools.verifyMigrationObjects(databaseUrl, body);
    console.log("  object fingerprint: verdict=" + verification.verdict + " present=" + verification.present + "/" + verification.total);
    for (const object of verification.objects) console.log("    " + (object.present ? "present " : "ABSENT  ") + tools.describeObject(object) + (object.idempotent ? " (idempotent)" : ""));

    const markSucceeded = flag("--mark-succeeded");
    const markFailed = flag("--mark-failed");
    if (markSucceeded === markFailed) { console.error("refusing: choose exactly one of --mark-succeeded (objects verified present) or --mark-failed (objects verified absent; row is deleted so the runner re-applies)"); process.exit(2); }
    const expected = markSucceeded ? "applied" : "absent";
    const verifyFlag = markSucceeded ? "--i-verified-applied" : "--i-verified-no-partial-effects";
    if (verification.verdict === "partial") { console.error("refusing: verdict=partial (some objects exist, some do not); resolve by hand per docs/DATABASE_INCIDENT_RUNBOOK.md"); process.exit(2); }
    if (verification.verdict === "undetermined") {
      if (!flag("--accept-undetermined")) { console.error("refusing: verdict=undetermined (the fingerprint cannot prove the file's effects); inspect the database by hand and add --accept-undetermined"); process.exit(2); }
    } else if (verification.verdict !== expected) {
      console.error("refusing: " + (markSucceeded ? "--mark-succeeded" : "--mark-failed") + " needs verdict=" + expected + ", fingerprint says verdict=" + verification.verdict); process.exit(2);
    }
    if (!flag(verifyFlag)) { console.error("refusing: pass " + verifyFlag + " after reviewing the fingerprint above (see scripts/migrations_repair.cjs header)"); process.exit(2); }
    console.log("  would " + (markSucceeded ? "set ledger row " + id + " to succeeded (no re-run)" : "DELETE ledger row " + id + " so the runner re-applies " + row.filename));
    if (!confirm) { console.log("dry run; re-run with --yes to apply"); process.exit(0); }
    const changed = await tools.withClient(databaseUrl, async (client) => {
      const lock = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [MIGRATION_ADVISORY_LOCK_KEY]);
      if (!lock.rows[0].locked) throw new Error("a migration run holds the runner lock right now; the row may be live. Retry after it finishes");
      try {
        return markSucceeded
          ? await client.query("UPDATE siton.migration_ledger SET status='succeeded', completed_at=now(), error_message='marked succeeded by migrations:repair --clear-running (fingerprint verdict=" + verification.verdict + ")' WHERE migration_id=$1 AND status='running'", [id])
          : await client.query("DELETE FROM siton.migration_ledger WHERE migration_id=$1 AND status='running'", [id]);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
      }
    });
    console.log("MIGRATIONS_REPAIR_APPLIED rows=" + changed.rowCount);
    process.exit(0);
  }

  console.error("no action given: --fix-eol-checksums | --clear-failed <id> | --clear-running <id> (--mark-succeeded|--mark-failed)   (add --yes to apply, --allow-hosted for a non-local host)");
  process.exit(2);
}

main().catch((error) => { console.error("MIGRATIONS_REPAIR_ERROR", error.message); process.exit(2); });
