// Disaster-recovery drill: proves the canonical Siton PostgreSQL schema + data
// can be backed up and restored into a clean environment with invariants
// intact. Uses disposable local databases; never touches staging/production.
//
// Steps:
//   1. Create a fresh source DB and migrate the FULL canonical schema.
//   2. Seed representative canonical records (deal, participants, viral edge,
//      payment attempt, platform-fee ledger).
//   3. pg_dump (schema + data) → a backup file. Secrets do NOT live in the
//      siton schema (they are env-only), so the dump carries no credentials.
//   4. Restore into a CLEAN database.
//   5. Verify: schema object parity, migration-ledger checksum alignment,
//      representative records survive, and constitutional invariants hold
//      (zero commission columns, 8% fee rate, charged-only money truth).
//
// Usage: node scripts/dr_backup_restore_drill.cjs
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { Client } = require("pg");

const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
const BASE = process.env.DR_BASE_URL || "postgresql://postgres:postgres@localhost:5432";
const SUFFIX = `${process.pid}_${Date.now()}`;
const SOURCE = `siton_dr_source_${SUFFIX}`;
const RESTORE = `siton_dr_restore_${SUFFIX}`;
const DUMP = path.join(process.env.TEMP || "/tmp", `siton_dr_${SUFFIX}.dump`);

const pgTool = (name) => {
  const exe = path.join(PG_BIN, process.platform === "win32" ? `${name}.exe` : name);
  return fs.existsSync(exe) ? exe : name;
};
const urlFor = (db) => `${BASE}/${db}`;

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed (${r.status}): ${String(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}

async function withAdmin(fn) {
  const c = new Client({ connectionString: urlFor("postgres"), connectionTimeoutMillis: 10_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function query(db, sql) {
  const c = new Client({ connectionString: urlFor(db), connectionTimeoutMillis: 10_000 });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

(async () => {
  const quote = (n) => `"${n.replace(/"/g, "")}"`;
  try {
    // 1) fresh source DB + full canonical migration
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${quote(SOURCE)} WITH (FORCE)`));
    await withAdmin((c) => c.query(`CREATE DATABASE ${quote(SOURCE)}`));
    const mig = spawnSync(process.execPath, ["scripts/run_migrations.cjs"], { stdio: "pipe", encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(SOURCE) } });
    if (mig.status !== 0) throw new Error(`migration failed: ${String(mig.stderr || mig.stdout).slice(0, 400)}`);
    const ledgerSrc = await query(SOURCE, "SELECT migration_id, checksum_sha256 FROM siton.migration_ledger ORDER BY position");
    check("source migrated (full canonical schema)", ledgerSrc.length >= 48, `${ledgerSrc.length} migrations`);

    // 2) seed representative canonical records
    await query(SOURCE, `
      INSERT INTO siton.seller_accounts (seller_id, display_name, seller_status) VALUES ('dr-seller','[DR] מוכר בדיקה','Active');
      INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
        VALUES ('11111111-1111-1111-1111-111111111111','[DR] עסקת שחזור', 25, 10, 40, 9, now()+interval '2 days', 'dr-seller', 'PendingTarget', now());
      INSERT INTO siton.participants (participant_id, deal_id, buyer_id, buyer_name, qty, buyer_state, money_state)
        VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','+972500000001','דנה', 2, 'JoinedAuthorized', 'ChargedSuccess');
      INSERT INTO siton.platform_fee_money_events (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, source_money_state, payout_readiness_status, gross_amount, vat_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount)
        VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','dr-seller','charge_captured','charge','mockpay','ChargedSuccess','ready_for_settlement', 50, 0, 50, 0.08, 0.18, 4.00, 0.72, 4.72, 4.00, 45.28);
    `);
    const seeded = await query(SOURCE, "SELECT (SELECT COUNT(*) FROM siton.deals) AS deals, (SELECT COUNT(*) FROM siton.participants) AS parts, (SELECT COUNT(*) FROM siton.platform_fee_money_events) AS fees");
    check("representative records seeded", Number(seeded[0].deals) >= 1 && Number(seeded[0].parts) >= 1 && Number(seeded[0].fees) >= 1);

    // 3) backup — pg_dump (custom format, schema + data)
    run(pgTool("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", `--file=${DUMP}`, urlFor(SOURCE)]);
    const dumpSize = fs.statSync(DUMP).size;
    check("backup produced", dumpSize > 0, `${dumpSize} bytes`);
    // Secrets live in env, not the siton schema. Any credential column stores a
    // HASH or ENCRYPTED form only (never plaintext) — verify no plaintext
    // credential data column exists (timestamps like *_updated_at excluded).
    const plaintextSecrets = await query(SOURCE, `
      SELECT table_name || '.' || column_name AS col
      FROM information_schema.columns
      WHERE table_schema='siton'
        AND (column_name ILIKE '%password%' OR column_name ILIKE '%secret%')
        AND column_name NOT ILIKE '%hash%'
        AND column_name NOT ILIKE '%encrypted%'
        AND data_type NOT IN ('timestamp with time zone','timestamp without time zone','date')`);
    check("backup carries no plaintext credential columns (only hashes/encrypted)", plaintextSecrets.length === 0, plaintextSecrets.map((r) => r.col).join(", ") || "none");

    // 4) restore into a clean DB
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${quote(RESTORE)} WITH (FORCE)`));
    await withAdmin((c) => c.query(`CREATE DATABASE ${quote(RESTORE)}`));
    run(pgTool("pg_restore"), ["--no-owner", "--no-privileges", `--dbname=${urlFor(RESTORE)}`, DUMP]);
    check("restore into clean environment completed", true);

    // 5) verify parity + invariants
    const objSrc = await query(SOURCE, "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='siton') AS tables, (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='siton') AS cols");
    const objRes = await query(RESTORE, "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='siton') AS tables, (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='siton') AS cols");
    check("schema object parity", Number(objSrc[0].tables) === Number(objRes[0].tables) && Number(objSrc[0].cols) === Number(objRes[0].cols), `tables ${objRes[0].tables}, cols ${objRes[0].cols}`);

    const ledgerRes = await query(RESTORE, "SELECT migration_id, checksum_sha256 FROM siton.migration_ledger ORDER BY position");
    const ledgerAligned = ledgerRes.length === ledgerSrc.length && ledgerRes.every((r, i) => r.migration_id === ledgerSrc[i].migration_id && r.checksum_sha256 === ledgerSrc[i].checksum_sha256);
    check("migration ledger + checksums align after restore", ledgerAligned, `${ledgerRes.length} rows`);

    const recRes = await query(RESTORE, "SELECT (SELECT title FROM siton.deals WHERE deal_id='11111111-1111-1111-1111-111111111111') AS deal_title, (SELECT COUNT(*) FROM siton.participants) AS parts, (SELECT platform_fee_total_amount FROM siton.platform_fee_money_events LIMIT 1) AS fee");
    check("representative records survive restore", String(recRes[0].deal_title || "").includes("עסקת שחזור") && Number(recRes[0].parts) >= 1);

    // constitutional invariants on the RESTORED DB
    const commissionCols = await query(RESTORE, `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='siton' AND (column_name ILIKE '%commission%' OR column_name ILIKE '%payout_rate%')`);
    check("invariant: zero commission columns", Number(commissionCols[0].n) === 0);
    const feeRate = await query(RESTORE, "SELECT DISTINCT platform_fee_rate FROM siton.platform_fee_money_events");
    check("invariant: 8% platform fee rate", feeRate.length === 1 && Number(feeRate[0].platform_fee_rate) === 0.08, `rate=${feeRate.map((r) => r.platform_fee_rate).join(",")}`);
    const chargedTruth = await query(RESTORE, `SELECT COALESCE(SUM(qty) FILTER (WHERE money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged FROM siton.participants`);
    check("invariant: charged-only money truth readable", Number(chargedTruth[0].charged) === 2, `charged units=${chargedTruth[0].charged}`);

    const failed = checks.filter((c) => !c.ok).length;
    console.log(failed ? `\nDR_DRILL_RESULT: ${failed} FAILURES` : "\nDR_DRILL_PASS all backup/restore checks passed");
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error("DR_DRILL_ERROR", String(error && error.message || error));
    process.exitCode = 1;
  } finally {
    // cleanup disposable resources
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${quote(SOURCE)} WITH (FORCE)`)).catch(() => {});
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${quote(RESTORE)} WITH (FORCE)`)).catch(() => {});
    try { fs.unlinkSync(DUMP); } catch { /* ignore */ }
  }
})();
