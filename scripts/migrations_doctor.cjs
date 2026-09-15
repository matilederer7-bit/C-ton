#!/usr/bin/env node
// Migration ledger doctor (npm run migrations:doctor). READ-ONLY.
//
// Compares the migration ledger of the database at DATABASE_URL (or
// --database <url>) with the repository manifest and reports:
//   database migration count / repository migration count
//   missing (in repository, not applied) / extra (applied, unknown to repository)
//   checksum classification per row: match, line_ending_only_mismatch,
//   real_content_mismatch, filename_mismatch, position_mismatch
//   dirty rows (running/failed), duplicate ids, ordering anomalies
//
// Never writes. A hosted database (non-local host) is refused unless
// --allow-hosted is passed; even then the doctor only SELECTs. Repair lives
// in scripts/migrations_repair.cjs and is never automatic.
const fs = require("node:fs");
const path = require("node:path");
const tools = require("./lib/migration_tools.cjs");
const isolation = require("./lib/test_db_isolation.cjs");

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };

function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return "?"; } }

async function main() {
  const databaseUrl = option("--database") || process.env.DATABASE_URL;
  const analysis = tools.analyzeManifest(root);
  const out = {
    generated_at: new Date().toISOString(),
    repository: { count: analysis.files.length, high_water: analysis.high_water, findings: analysis.findings },
    database: null,
    verdict: null
  };

  if (!databaseUrl) {
    out.verdict = "NO_DATABASE";
    print(out, analysis, null);
    return finish(out, 2);
  }
  const host = hostOf(databaseUrl);
  const local = isolation.LOCAL_HOSTS.has(host);
  if (!local && !flag("--allow-hosted")) {
    out.verdict = "REFUSED_HOSTED";
    console.error("migrations:doctor refuses host '" + host + "' without --allow-hosted (read-only even then)");
    return finish(out, 2);
  }
  let ledger;
  try {
    ledger = await tools.readLedger(databaseUrl);
  } catch (error) {
    out.verdict = "UNREACHABLE";
    out.database = { host, error: error.message };
    print(out, analysis, null);
    return finish(out, 2);
  }
  const compared = tools.compareLedger(ledger, analysis);
  const positions = new Map();
  const duplicatePositions = [];
  for (const row of ledger || []) {
    if (positions.has(row.position)) duplicatePositions.push(row.position);
    positions.set(row.position, row.migration_id);
  }
  const orderingAnomalies = [];
  let previous = 0;
  for (const row of ledger || []) {
    if (Number(row.position) !== previous + 1) orderingAnomalies.push("position " + row.position + " follows " + previous);
    previous = Number(row.position);
  }
  out.database = {
    host,
    ledger_present: ledger !== null,
    count: compared.database_count,
    repository_count: compared.repository_count,
    missing: compared.missing,
    extra: compared.rows.filter((row) => row.classification === "extra_in_database"),
    checksum_counts: compared.counts,
    line_ending_only_mismatch: compared.rows.filter((row) => row.classification === "line_ending_only_mismatch").map((row) => row.migration_id),
    real_content_mismatch: compared.rows.filter((row) => row.classification === "real_content_mismatch"),
    filename_or_position_mismatch: compared.rows.filter((row) => row.classification === "filename_mismatch" || row.classification === "position_mismatch"),
    dirty: compared.dirty,
    duplicate_positions: duplicatePositions,
    ordering_anomalies: orderingAnomalies,
    rows: compared.rows
  };
  const blocking = out.database.real_content_mismatch.length + out.database.filename_or_position_mismatch.length + out.database.dirty.length + out.database.extra.length + duplicatePositions.length + orderingAnomalies.length + analysis.findings.filter((f) => f.severity === "FAIL").length;
  if (ledger === null) out.verdict = "EMPTY_DATABASE";
  else if (blocking) out.verdict = "BLOCKED";
  else if (out.database.missing.length) out.verdict = "BEHIND";
  else if (out.database.line_ending_only_mismatch.length) out.verdict = "HEALTHY_WITH_EOL_VARIANTS";
  else out.verdict = "HEALTHY";
  print(out, analysis, compared);
  return finish(out, out.verdict === "BLOCKED" ? 1 : 0);
}

function print(out, analysis, compared) {
  console.log("MIGRATIONS_DOCTOR verdict=" + out.verdict);
  console.log("repository: " + out.repository.count + " migrations, high-water " + out.repository.high_water + ", static findings " + out.repository.findings.length);
  for (const finding of out.repository.findings) console.log("  " + finding.severity + " " + finding.code + " " + finding.message);
  if (!out.database) return;
  if (out.database.error) { console.log("database: unreachable (" + out.database.error + ")"); return; }
  console.log("database: host=" + out.database.host + " ledger_present=" + out.database.ledger_present + " count=" + out.database.count + " repository_count=" + out.database.repository_count);
  console.log("  checksum classification: " + JSON.stringify(out.database.checksum_counts));
  console.log("  missing (not yet applied): " + (out.database.missing.length ? out.database.missing.map((m) => m.migration_id).join(", ") : "none"));
  console.log("  extra (applied, unknown to repository): " + (out.database.extra.length ? out.database.extra.map((m) => m.migration_id).join(", ") : "none"));
  console.log("  line-ending-only mismatch: " + (out.database.line_ending_only_mismatch.length ? out.database.line_ending_only_mismatch.join(", ") + " (accepted by the runner; repair with migrations:repair --fix-eol-checksums)" : "none"));
  console.log("  real content mismatch: " + (out.database.real_content_mismatch.length ? out.database.real_content_mismatch.map((m) => m.migration_id).join(", ") + " (BLOCKING: a migration file changed after it was applied)" : "none"));
  console.log("  filename/position mismatch: " + (out.database.filename_or_position_mismatch.length ? out.database.filename_or_position_mismatch.map((m) => m.migration_id).join(", ") : "none"));
  console.log("  dirty rows: " + (out.database.dirty.length ? out.database.dirty.map((m) => m.migration_id + ":" + m.status).join(", ") : "none"));
  console.log("  duplicate positions: " + (out.database.duplicate_positions.length ? out.database.duplicate_positions.join(", ") : "none"));
  console.log("  ordering anomalies: " + (out.database.ordering_anomalies.length ? out.database.ordering_anomalies.join("; ") : "none"));
}

function finish(out, code) {
  const dir = require("./lib/release_report.cjs").artifactsDir(root);
  fs.writeFileSync(path.join(dir, "migrations-doctor.json"), JSON.stringify(out, null, 2) + "\n");
  process.exit(code);
}

main().catch((error) => { console.error("MIGRATIONS_DOCTOR_ERROR", error.message); process.exit(2); });
