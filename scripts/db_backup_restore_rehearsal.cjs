#!/usr/bin/env node
// Database backup / restore rehearsal (npm run db:backup-restore-rehearsal).
//
// Proves, on disposable LOCAL databases only, that the canonical Siton schema
// and representative synthetic data can:
//   1. initialise           (empty database)
//   2. receive migrations   (full ledgered manifest through run_migrations)
//   3. receive fixtures     (synthetic seller / buyer / deal / participant /
//                            fee-ledger / tracking-token records - no real PII)
//   4. be dumped            (pg_dump custom format AND plain SQL for scanning)
//   5. be dropped/recreated (a brand-new database)
//   6. be restored          (pg_restore)
//   7. pass integrity checks(table counts, FK/index/trigger/function counts,
//                            migration ledger + checksums, representative rows,
//                            the migration runner reports nothing to apply,
//                            the dump carries no secret shapes)
//
// pg_dump / pg_restore are located through PG_BIN, PATH, or the default
// Windows PostgreSQL install directories. When unavailable the rehearsal
// reports SKIPPED_ENVIRONMENT, never PASS.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
require("dotenv").config({ quiet: true });
const tools = require("./lib/migration_tools.cjs");
const isolation = require("./lib/test_db_isolation.cjs");
const { runMigrations } = require("./run_migrations.cjs");
const { ReleaseReport, runStep, SkippedEnvironmentError, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();

function findPgTool(name) {
  const exe = process.platform === "win32" ? name + ".exe" : name;
  const candidates = [];
  if (process.env.PG_BIN) candidates.push(path.join(process.env.PG_BIN, exe));
  if (process.platform === "win32") {
    for (const version of [18, 17, 16, 15]) candidates.push(path.join("C:/Program Files/PostgreSQL", String(version), "bin", exe));
  }
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  const probe = spawnSync(exe, ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return exe;
  return null;
}

function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(path.basename(cmd) + " failed (" + result.status + "): " + String(result.stderr || result.stdout).slice(0, 600));
  return result.stdout;
}

// A failed step aborts the chain: a restore cannot be verified when the dump
// failed, and reporting downstream steps as FAIL would hide the real cause.
async function step(report, id, fn) {
  const record = await runStep(report, id, fn);
  if (record.status === "FAIL") throw Object.assign(new Error("aborted after: " + id), { aborted: true });
  return record;
}

async function silently(fn) { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } }

const FIXTURE_SQL = `
INSERT INTO siton.seller_accounts (seller_id, display_name, login_email, verification_status, settlement_status, business_name, support_email)
VALUES ('dr-seller', '[DR] מוכר בדיקה', 'dr-seller@siton.test', 'approved', 'active', '[DR] Test Business', 'support@siton.test')
ON CONFLICT (seller_id) DO NOTHING;
INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
VALUES ('11111111-1111-1111-1111-111111111111', '[DR] עסקת שחזור', 25, 10, 40, 9, now() + interval '2 days', 'dr-seller', 'PendingTarget', now());
INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
VALUES ('11111111-1111-1111-1111-111111111111', 'delivery', '[DR] משלוח', 20, 0);
INSERT INTO siton.participants (participant_id, deal_id, buyer_id, buyer_name, qty, buyer_state, money_state)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', '+972500000001', 'דנה', 2, 'JoinedAuthorized', 'ChargedSuccess'),
       ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '+972500000002', 'יוסי', 1, 'JoinedAuthorized', 'AuthHeld');
INSERT INTO siton.platform_fee_money_events (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, source_money_state, payout_readiness_status, gross_amount, vat_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'dr-seller', 'charge_captured', 'charge', 'mockpay', 'ChargedSuccess', 'ready_for_settlement', 50, 0, 50, 0.08, 0.18, 4.00, 0.72, 4.72, 4.00, 45.28);
`;

const KEY_TABLES = ["seller_accounts", "deals", "deal_delivery_options", "participants", "platform_fee_money_events", "audit_log", "migration_ledger", "outbox_events", "outbox_dlq", "worker_heartbeats", "payment_attempts", "webhook_events", "operational_cases", "notification_events"];

async function main() {
  const report = new ReleaseReport("db backup/restore rehearsal");
  const baseUrl = process.env.DATABASE_URL;
  const pgDump = findPgTool("pg_dump");
  const pgRestore = findPgTool("pg_restore");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "siton-dr-"));
  const created = [];
  let source = null;
  let restored = null;
  let ledgerSource = null;
  let countsSource = null;
  let objectsSource = null;
  const dumpCustom = path.join(workDir, "siton.dump");
  const dumpPlain = path.join(workDir, "siton.sql");

  try {
    if (!baseUrl) throw new SkippedEnvironmentError("DATABASE_URL not set");
    isolation.assertLocalBase(baseUrl);
    if (!pgDump || !pgRestore) throw new SkippedEnvironmentError("pg_dump/pg_restore not found (set PG_BIN)");
    report.pass("tooling", "pg_dump=" + pgDump + " pg_restore=" + pgRestore);

    await step(report, "1-2 initialise + migrate", async () => {
      source = await isolation.createIsolatedDatabase({ baseUrl, purpose: "drsource" });
      created.push(source);
      const result = await silently(() => runMigrations(source.url));
      ledgerSource = await tools.readLedger(source.url);
      return { status: "PASS", summary: "applied " + result.newly_applied + " migrations into " + source.name };
    });

    await step(report, "3 synthetic fixtures", async () => {
      await tools.withClient(source.url, (client) => client.query(FIXTURE_SQL));
      countsSource = await tableCounts(source.url);
      objectsSource = await objectCounts(source.url);
      const absentTables = KEY_TABLES.filter((table) => countsSource[table] === null);
      if (absentTables.length) throw new Error("key tables missing from the migrated schema (stale KEY_TABLES or dropped table): " + absentTables.join(", "));
      if (countsSource.deals < 1 || countsSource.participants < 2 || countsSource.platform_fee_money_events < 1) throw new Error("fixtures not present: " + JSON.stringify(countsSource));
      return { status: "PASS", summary: "seeded seller/deal/delivery/participants/fee-ledger: " + JSON.stringify(countsSource) };
    });

    await step(report, "4 dump (custom + plain)", async () => {
      run(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--file=" + dumpCustom, source.url]);
      run(pgDump, ["--format=plain", "--no-owner", "--no-privileges", "--file=" + dumpPlain, source.url]);
      const size = fs.statSync(dumpCustom).size;
      const plain = fs.readFileSync(dumpPlain, "utf8");
      const secretShapes = [
        [/postgres(ql)?:\/\/[^\s:]+:[^\s@]+@/i, "connection string with credential"],
        [/\bsk_(live|test)_[A-Za-z0-9]{8,}/, "Stripe-shaped key"],
        [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
        [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
        [/\bwhsec_[A-Za-z0-9]{16,}/, "webhook secret"]
      ];
      const leaks = secretShapes.filter(([re]) => re.test(plain)).map(([, label]) => label);
      if (leaks.length) throw new Error("dump carries secret shapes: " + leaks.join(", "));
      const plaintextSecretColumns = await tools.withClient(source.url, async (client) => (await client.query(`
        SELECT table_name || '.' || column_name AS col FROM information_schema.columns
        WHERE table_schema='siton' AND (column_name ILIKE '%password%' OR column_name ILIKE '%secret%')
          AND column_name NOT ILIKE '%hash%' AND column_name NOT ILIKE '%encrypted%'
          AND data_type NOT IN ('timestamp with time zone','timestamp without time zone','date','boolean')`)).rows.map((row) => row.col));
      if (plaintextSecretColumns.length) throw new Error("plaintext credential columns would be dumped: " + plaintextSecretColumns.join(", "));
      return { status: "PASS", summary: "custom dump " + size + " bytes; plain dump scanned: no credential/JWT/key shapes; no plaintext secret columns in schema" };
    });

    await step(report, "5-6 drop/recreate + restore", async () => {
      restored = await isolation.createIsolatedDatabase({ baseUrl, purpose: "drrestore" });
      created.push(restored);
      run(pgRestore, ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname=" + restored.url, dumpCustom]);
      return { status: "PASS", summary: "restored into brand-new database " + restored.name };
    });

    await step(report, "7a table counts", async () => {
      const countsRestored = await tableCounts(restored.url);
      const diffs = Object.keys(countsSource).filter((table) => countsSource[table] !== countsRestored[table]);
      if (diffs.length) throw new Error("count differences: " + diffs.map((t) => t + " " + countsSource[t] + "->" + countsRestored[t]).join(", "));
      return { status: "PASS", summary: KEY_TABLES.length + " key tables identical: " + JSON.stringify(countsRestored) };
    });

    await step(report, "7b schema objects (FK / index / trigger / function / constraint)", async () => {
      const objectsRestored = await objectCounts(restored.url);
      const diffs = Object.keys(objectsSource).filter((key) => objectsSource[key] !== objectsRestored[key]);
      if (diffs.length) throw new Error("object differences: " + diffs.map((k) => k + " " + objectsSource[k] + "->" + objectsRestored[k]).join(", "));
      const snapshotSource = await tools.schemaSnapshot(source.url);
      const snapshotRestored = await tools.schemaSnapshot(restored.url);
      const drift = tools.diffSnapshots(snapshotSource, snapshotRestored);
      const driftCount = Object.values(drift).reduce((sum, item) => sum + item.only_left.length + item.only_right.length, 0);
      if (driftCount) return { status: "FAIL", summary: "schema fingerprint drift after restore: " + driftCount, detail: JSON.stringify(drift, null, 2).slice(0, 4000) };
      return { status: "PASS", summary: JSON.stringify(objectsRestored) + "; fingerprint identical" };
    });

    await step(report, "7c migration ledger + checksums + runner no-op", async () => {
      const ledgerRestored = await tools.readLedger(restored.url);
      const same = ledgerRestored.length === ledgerSource.length && ledgerRestored.every((row, index) => row.migration_id === ledgerSource[index].migration_id && row.checksum_sha256 === ledgerSource[index].checksum_sha256 && row.status === "succeeded");
      if (!same) throw new Error("ledger differs after restore");
      const rerun = await silently(() => runMigrations(restored.url));
      if (rerun.newly_applied !== 0) throw new Error("runner applied " + rerun.newly_applied + " migrations on the restored database");
      const compared = tools.compareLedger(ledgerRestored, tools.analyzeManifest(root));
      if (compared.counts.match !== ledgerRestored.length) throw new Error("doctor classification after restore: " + JSON.stringify(compared.counts));
      return { status: "PASS", summary: ledgerRestored.length + " ledger rows identical, all checksums match the repository, runner has nothing to apply" };
    });

    await step(report, "7d representative records + invariants", async () => {
      const rows = await tools.withClient(restored.url, async (client) => ({
        deal: (await client.query("SELECT title, seller_id, state FROM siton.deals WHERE deal_id='11111111-1111-1111-1111-111111111111'")).rows[0],
        seller: (await client.query("SELECT display_name, verification_status FROM siton.seller_accounts WHERE seller_id='dr-seller'")).rows[0],
        participants: (await client.query("SELECT buyer_name, money_state FROM siton.participants WHERE deal_id='11111111-1111-1111-1111-111111111111' ORDER BY buyer_name")).rows,
        fee: (await client.query("SELECT platform_fee_rate, seller_net_amount FROM siton.platform_fee_money_events LIMIT 1")).rows[0],
        charged: (await client.query("SELECT COALESCE(SUM(qty) FILTER (WHERE money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS units FROM siton.participants")).rows[0],
        commission_columns: (await client.query("SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='siton' AND (column_name ILIKE '%commission%' OR column_name ILIKE '%payout_rate%')")).rows[0],
        fk_valid: (await client.query("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE connamespace='siton'::regnamespace AND contype='f' AND NOT convalidated")).rows[0]
      }));
      const problems = [];
      if (!rows.deal || !String(rows.deal.title).includes("עסקת שחזור")) problems.push("deal title (Hebrew) lost");
      if (!rows.seller || rows.seller.verification_status !== "approved") problems.push("seller record lost");
      if (rows.participants.length !== 2) problems.push("participants lost");
      if (!rows.fee || Number(rows.fee.platform_fee_rate) !== 0.08 || Number(rows.fee.seller_net_amount) !== 45.28) problems.push("fee ledger row wrong: " + JSON.stringify(rows.fee));
      if (Number(rows.charged.units) !== 2) problems.push("charged-only truth wrong");
      if (Number(rows.commission_columns.n) !== 0) problems.push("commission columns present");
      if (Number(rows.fk_valid.n) !== 0) problems.push(rows.fk_valid.n + " foreign keys not validated");
      if (problems.length) throw new Error(problems.join("; "));
      return { status: "PASS", summary: "deal/seller/participants/fee/audit survived; Hebrew intact; 8% rate; charged units 2; 0 commission columns; all FKs validated" };
    });
  } catch (error) {
    if (error && error.skippedEnvironment) report.skip("rehearsal", error.message);
    else if (!(error && error.aborted)) report.fail("rehearsal", String(error.message || error));
  } finally {
    for (const db of created) await db.drop().catch(() => undefined);
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  report.printSummary();
  report.writeArtifacts(artifactsDir(root), "db-backup-restore-rehearsal");
  const overall = report.overall();
  console.log(overall === "FAIL" ? "DB_BACKUP_RESTORE_REHEARSAL_FAIL" : overall === "SKIPPED_ENVIRONMENT" ? "DB_BACKUP_RESTORE_REHEARSAL_SKIPPED_ENVIRONMENT" : "DB_BACKUP_RESTORE_REHEARSAL_PASS");
  process.exit(report.exitCode());
}

async function tableCounts(url) {
  return tools.withClient(url, async (client) => {
    const out = {};
    for (const table of KEY_TABLES) {
      const exists = (await client.query("SELECT to_regclass($1) AS t", ["siton." + table])).rows[0].t;
      out[table] = exists ? Number((await client.query("SELECT COUNT(*)::int AS n FROM siton." + table)).rows[0].n) : null;
    }
    return out;
  });
}

async function objectCounts(url) {
  return tools.withClient(url, async (client) => (await client.query(`SELECT
    (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='siton' AND c.relkind IN ('r','p')) AS tables,
    (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema='siton') AS columns,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='siton'::regnamespace AND contype='f') AS foreign_keys,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='siton'::regnamespace) AS constraints,
    (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='siton') AS indexes,
    (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='siton' AND NOT t.tgisinternal) AS triggers,
    (SELECT COUNT(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='siton') AS functions`)).rows[0]);
}

main();
