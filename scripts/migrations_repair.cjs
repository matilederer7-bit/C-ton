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
const tools = require("./lib/migration_tools.cjs");
const isolation = require("./lib/test_db_isolation.cjs");

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

  console.error("no action given: --fix-eol-checksums | --clear-failed <id>   (add --yes to apply, --allow-hosted for a non-local host)");
  process.exit(2);
}

main().catch((error) => { console.error("MIGRATIONS_REPAIR_ERROR", error.message); process.exit(2); });
