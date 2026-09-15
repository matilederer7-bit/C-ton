// Shared migration analysis helpers for the preflight, the doctor and the
// repair helper. Static functions never touch a database; the database
// functions are READ-ONLY unless their name says otherwise.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { checksum, checksumCrlfVariant, classifyChecksum, canonicalBody } = require("../run_migrations.cjs");

// Ordering anomalies that are known and deliberate. Anything else is a
// finding. Keep this list short and justified.
const KNOWN_ORDERING_ANOMALIES = Object.freeze([
  { id: "014", reason: "014_demo_preview_bootstrap.sql deliberately runs first: it bootstraps the demo/preview schema the phase-1 alignment migrations (007-013) then adjust. It does not raise the ordering high-water mark.", excluded_from_order: true },
  { id: "014a", reason: "suffix scheme: 014a_product_account_prerequisites.sql follows 013 and shares the 014 prefix with the bootstrap file." },
  { id: "015a", reason: "two files share the 015 prefix (notifications, seller ownership); ids 015a/015b keep the ledger unique." },
  { id: "015b", reason: "see 015a." },
  { id: "065", reason: "ids 062-064 were reserved by parallel branches and never landed; 065 was the next free id on master. The financial rails later took 067/068 AFTER 066 (see manifest comment), so the sequence 061 -> 065 -> 066 -> 067 -> 068 is a documented gap, not a reordering." }
]);
// Retired TypeScript stubs that live in src/migrations but are not migrations.
const RETIRED_NON_MANIFEST_FILES = Object.freeze(["001_uuid_schema.ts", "002_drop_siton_schema.ts"]);

function loadManifest(root = process.cwd()) {
  const manifestPath = path.join(root, "scripts", "migration_manifest.cjs");
  delete require.cache[require.resolve(manifestPath)];
  const manifest = require(manifestPath);
  return { migrations: manifest.MIGRATIONS, dir: path.join(root, "src", "migrations") };
}

function numericPrefix(filename) {
  const match = /^(\d+)/.exec(filename);
  return match ? Number(match[1]) : null;
}

/**
 * Static manifest / file-system analysis. Returns { findings: [{severity, code, message}], files: [...] }.
 */
function analyzeManifest(root = process.cwd()) {
  const { migrations, dir } = loadManifest(root);
  const findings = [];
  const ids = new Map();
  const filenames = new Map();
  const files = [];

  migrations.forEach((migration, index) => {
    if (ids.has(migration.id)) findings.push({ severity: "FAIL", code: "DUPLICATE_ID", message: "duplicate migration id " + migration.id + " (" + ids.get(migration.id) + " and " + migration.filename + ")" });
    ids.set(migration.id, migration.filename);
    if (filenames.has(migration.filename)) findings.push({ severity: "FAIL", code: "DUPLICATE_FILENAME", message: "duplicate migration filename " + migration.filename });
    filenames.set(migration.filename, migration.id);
    if (migration.position !== index + 1) findings.push({ severity: "FAIL", code: "POSITION_GAP", message: migration.id + " has position " + migration.position + ", expected " + (index + 1) });
    const filePath = path.join(dir, migration.filename);
    if (!fs.existsSync(filePath)) {
      findings.push({ severity: "FAIL", code: "MISSING_FILE", message: "manifest entry " + migration.id + " has no file " + migration.filename });
      return;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const info = {
      id: migration.id,
      position: migration.position,
      filename: migration.filename,
      bytes: Buffer.byteLength(raw, "utf8"),
      has_crlf: raw.includes("\r\n"),
      has_bom: raw.charCodeAt(0) === 0xfeff,
      has_lone_cr: /\r(?!\n)/.test(raw),
      checksum_lf: checksum(raw),
      checksum_crlf: checksumCrlfVariant(raw),
      explicit_transaction: /^\s*BEGIN\s*;/im.test(canonicalBody(raw)),
      commit_count: (canonicalBody(raw).replace(/--[^\n]*/g, "").match(/^\s*COMMIT\s*;/gim) || []).length,
      empty: canonicalBody(raw).replace(/--[^\n]*/g, "").trim().length === 0
    };
    if (info.has_lone_cr) findings.push({ severity: "FAIL", code: "LONE_CR", message: migration.filename + " contains a bare carriage return (not CRLF); normalisation cannot make it canonical" });
    if (info.empty) findings.push({ severity: "FAIL", code: "EMPTY_MIGRATION", message: migration.filename + " is empty" });
    // One explicit BEGIN/COMMIT (or none: the runner's single multi-statement
    // query is an implicit transaction) is atomic. More than one COMMIT means a
    // failure after the first COMMIT leaves the earlier part applied while the
    // ledger row is marked failed.
    if (info.commit_count > 1) findings.push({ severity: "WARNING", code: "MULTIPLE_TRANSACTIONS", message: migration.filename + " commits " + info.commit_count + " times; a failure after the first COMMIT leaves partial effects behind a failed ledger row" });
    files.push(info);
  });

  // Ordering: numeric prefix must be non-decreasing along positions unless the
  // anomaly is known and justified.
  let previous = -1;
  for (const migration of migrations) {
    const prefix = numericPrefix(migration.filename);
    if (prefix === null) { findings.push({ severity: "FAIL", code: "UNNUMBERED", message: migration.filename + " has no numeric prefix" }); continue; }
    const known = KNOWN_ORDERING_ANOMALIES.find((item) => item.id === migration.id);
    if (prefix < previous) {
      if (known) findings.push({ severity: "INFO", code: "KNOWN_ORDERING_ANOMALY", message: migration.filename + " runs after a higher-numbered file: " + known.reason });
      else findings.push({ severity: "FAIL", code: "OUT_OF_ORDER", message: migration.filename + " (prefix " + prefix + ") is positioned after prefix " + previous + " and is not a documented anomaly" });
    }
    if (!(known && known.excluded_from_order)) previous = Math.max(previous, prefix);
  }
  // Same numeric prefix used by two files must carry distinct ids (015a/015b).
  const byPrefix = new Map();
  for (const migration of migrations) {
    const prefix = String(numericPrefix(migration.filename));
    byPrefix.set(prefix, (byPrefix.get(prefix) || []).concat(migration.id));
  }
  for (const [prefix, list] of byPrefix) {
    if (list.length > 1 && !list.every((id) => KNOWN_ORDERING_ANOMALIES.some((item) => item.id === id))) findings.push({ severity: "FAIL", code: "PREFIX_COLLISION", message: "numeric prefix " + prefix + " is shared by " + list.join(", ") + " without a documented suffix scheme" });
  }

  // Files on disk that the manifest does not know.
  for (const name of fs.readdirSync(dir)) {
    if (RETIRED_NON_MANIFEST_FILES.includes(name)) continue;
    if (!/\.sql$/i.test(name)) { findings.push({ severity: "FAIL", code: "UNEXPECTED_FILE", message: "src/migrations/" + name + " is neither a manifest .sql migration nor a retired stub" }); continue; }
    if (!filenames.has(name)) findings.push({ severity: "FAIL", code: "ORPHAN_FILE", message: "src/migrations/" + name + " exists but is not in the manifest (it will never run; if intentional, delete it)" });
  }

  return { migrations, findings, files, high_water: migrations[migrations.length - 1] ? migrations[migrations.length - 1].id : null };
}

/** Manifest + file bodies of another git ref, materialised into a temp dir. */
function materializeRef(root, ref, targetDir) {
  const show = (relPath) => {
    const result = spawnSync("git", ["show", ref + ":" + relPath], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) return null;
    return result.stdout;
  };
  const manifestSource = show("scripts/migration_manifest.cjs");
  if (manifestSource === null) throw new Error("cannot read scripts/migration_manifest.cjs at " + ref);
  fs.mkdirSync(path.join(targetDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "src", "migrations"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "scripts", "migration_manifest.cjs"), manifestSource);
  // The manifest resolves MIGRATIONS_DIR from process.cwd(); load it with a
  // temporary cwd swap.
  const previousCwd = process.cwd();
  let migrations;
  try {
    process.chdir(targetDir);
    const manifestPath = path.join(targetDir, "scripts", "migration_manifest.cjs");
    delete require.cache[require.resolve(manifestPath)];
    migrations = require(manifestPath).MIGRATIONS;
  } finally {
    process.chdir(previousCwd);
  }
  for (const migration of migrations) {
    const body = show("src/migrations/" + migration.filename);
    if (body === null) throw new Error("cannot read " + migration.filename + " at " + ref);
    fs.writeFileSync(path.join(targetDir, "src", "migrations", migration.filename), body);
  }
  return { migrations, dir: path.join(targetDir, "src", "migrations") };
}

async function withClient(connectionString, fn) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10000, query_timeout: 60000 });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** READ-ONLY ledger snapshot. Returns [] when the ledger table is absent. */
async function readLedger(connectionString) {
  return withClient(connectionString, async (client) => {
    const exists = await client.query("SELECT to_regclass('siton.migration_ledger') AS t");
    if (!exists.rows[0].t) return null;
    const rows = await client.query("SELECT migration_id, position, filename, checksum_sha256, status, started_at, completed_at, error_message FROM siton.migration_ledger ORDER BY position");
    return rows.rows;
  });
}

/** READ-ONLY schema fingerprint for drift comparison (siton schema only). */
async function schemaSnapshot(connectionString) {
  return withClient(connectionString, async (client) => {
    const columns = await client.query(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns WHERE table_schema='siton' ORDER BY table_name, ordinal_position`);
    const constraints = await client.query(`SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace='siton'::regnamespace ORDER BY 1, 2`);
    const indexes = await client.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='siton' ORDER BY 1, 2");
    const functions = await client.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(pg_get_functiondef(p.oid)) AS body_md5
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='siton' ORDER BY 1, 2`);
    const triggers = await client.query(`SELECT c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='siton' AND NOT t.tgisinternal ORDER BY 1, 2`);
    const normalise = (rows) => rows.map((row) => JSON.stringify(row));
    return {
      columns: normalise(columns.rows),
      // Constraint identity is (table, type, definition). Names are dropped:
      // PostgreSQL 18 materialises NOT NULL as catalog constraints with
      // generated names that pg_dump/pg_restore legitimately rename, and CHECK
      // constraint names carry no semantics for drift purposes.
      // The deparser also re-parenthesises AND-chains after a dump/restore
      // round trip (((a AND b) AND c) vs (a AND b AND c)), so parentheses and
      // whitespace are dropped from the definition fingerprint.
      constraints: normalise(constraints.rows.map((row) => ({ table_name: row.table_name, contype: row.contype, definition: String(row.definition).replace(/[()\s]/g, "") }))),
      indexes: normalise(indexes.rows),
      functions: normalise(functions.rows),
      triggers: normalise(triggers.rows)
    };
  });
}

function diffSnapshots(left, right) {
  const out = {};
  for (const key of Object.keys(left)) {
    const l = new Set(left[key]);
    const r = new Set(right[key]);
    out[key] = { only_left: [...l].filter((item) => !r.has(item)), only_right: [...r].filter((item) => !l.has(item)) };
  }
  return out;
}

/** Compare a ledger with the repository manifest (pure). */
function compareLedger(ledgerRows, analysis) {
  const byId = new Map(analysis.files.map((file) => [file.id, file]));
  const seen = new Set();
  const rows = [];
  for (const row of ledgerRows || []) {
    seen.add(row.migration_id);
    const file = byId.get(row.migration_id);
    let classification;
    if (!file) classification = "extra_in_database";
    else if (row.filename !== file.filename) classification = "filename_mismatch";
    else if (Number(row.position) !== file.position) classification = "position_mismatch";
    else if (row.checksum_sha256 === file.checksum_lf) classification = "match";
    else if (row.checksum_sha256 === file.checksum_crlf) classification = "line_ending_only_mismatch";
    else classification = "real_content_mismatch";
    rows.push({ migration_id: row.migration_id, position: Number(row.position), filename: row.filename, status: row.status, classification, stored_checksum: row.checksum_sha256, repository_checksum_lf: file ? file.checksum_lf : null });
  }
  const missing = analysis.files.filter((file) => !seen.has(file.id)).map((file) => ({ migration_id: file.id, filename: file.filename, position: file.position }));
  const dirty = rows.filter((row) => row.status !== "succeeded");
  const counts = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] || 0) + 1;
  return { rows, missing, dirty, counts, database_count: rows.length, repository_count: analysis.files.length };
}

module.exports = { KNOWN_ORDERING_ANOMALIES, RETIRED_NON_MANIFEST_FILES, loadManifest, analyzeManifest, materializeRef, readLedger, schemaSnapshot, diffSnapshots, compareLedger, withClient, checksum, checksumCrlfVariant, classifyChecksum, canonicalBody };
