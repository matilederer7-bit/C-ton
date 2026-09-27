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
//   8. prove content + money truth survived:
//        - per-table content hash (md5 over every row, stable ordering) for
//          every table in siton / siton_inventory: source == restored
//        - the READ-ONLY money invariants (scripts/lib/money_invariants.cjs)
//          PASS on the consistent fixture and return IDENTICAL results on the
//          source and the restored database
//        - append-only triggers FIRE on the restored database (UPDATE/DELETE
//          on siton.audit_log inside a rolled-back transaction must raise)
//        - which grants --no-privileges dropped (ACL diff source -> restored),
//          then re-provision from supabase/staging grant files when the
//          runtime roles exist in this cluster and require the ACL to match
//          the source again (else the exact runbook step is reported)
//        - NEGATIVE CONTROL: a deliberately corrupted dataset in a throw-away
//          clone makes the checker FAIL on exactly the expected invariants
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
const moneyInvariants = require("./lib/money_invariants.cjs");

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

// The fixture is financially CONSISTENT: every row the money invariants read
// (scripts/lib/money_invariants.cjs) agrees with every other one, so the
// checker must report zero FAIL on the source and on the restored copy.
//   deal     Completed, with the full audited Draft -> ... -> Completed chain
//   דנה      qty 2, DealCompleted / ChargedSuccess: successful charge_start
//            attempt, one 'charge' fee row (gross 50, VAT 0, fee 4.00 + 0.72
//            VAT = 4.72, seller net 45.28), audited buyer + money chains, and a
//            settlement -> payout batch -> batch item that match the ledger
//   יוסי     qty 1, Dropped / AuthReleased: capture declined by the exact
//            dispatch response, hold released, no fee row, audited chains
// Rows are INSERTed in their final states (INSERT is not transition-guarded)
// together with the audit rows the runtime would have written.
const DR_DEAL = "11111111-1111-1111-1111-111111111111";
const DR_DANA = "22222222-2222-2222-2222-222222222222";
const DR_YOSSI = "33333333-3333-3333-3333-333333333333";

function auditValues(rows) {
  return rows.map(([entity, entityId, stateType, from, to, action, minutesAgo], index) =>
    "('" + entity + "','" + entityId + "','" + DR_DEAL + "','" + stateType + "','" + from + "','" + to + "','" + action + "','dr-fixture:" + index + "','dr-fixture:" + index + "','dr-fixture:" + entityId + ":" + stateType + ":" + to + "','{\"fixture\":\"dr\"}'::jsonb, now() - interval '" + minutesAgo + " minutes')").join(",\n");
}

const FIXTURE_AUDIT = [
  ["deal", DR_DEAL, "deal_state", "Draft", "PendingTarget", "deal.publish", 70],
  ["deal", DR_DEAL, "deal_state", "PendingTarget", "TargetReached", "deal.target_reached", 60],
  ["deal", DR_DEAL, "deal_state", "TargetReached", "ClosedForJoining", "deal.close_joining", 50],
  ["deal", DR_DEAL, "deal_state", "ClosedForJoining", "ReadyForCharging", "deal.prepare_charging", 45],
  ["deal", DR_DEAL, "deal_state", "ReadyForCharging", "Charging", "charging.start", 40],
  ["deal", DR_DEAL, "deal_state", "Charging", "CompletionWindow", "charging.to_completion_window", 30],
  ["deal", DR_DEAL, "deal_state", "CompletionWindow", "Completed", "charging.finalize_completed", 20],
  ["participant", DR_DANA, "buyer_state", "NotJoined", "JoinedAuthorized", "participant.join_authorize", 65],
  ["participant", DR_DANA, "buyer_state", "JoinedAuthorized", "LockedIn", "deal.close_joining", 50],
  ["participant", DR_DANA, "buyer_state", "LockedIn", "ChargingAttempt", "charging.start", 40],
  ["participant", DR_DANA, "buyer_state", "ChargingAttempt", "ChargedSuccess", "charging.capture_success", 35],
  ["participant", DR_DANA, "buyer_state", "ChargedSuccess", "DealCompleted", "charging.finalize_completed", 20],
  ["participant", DR_DANA, "money_state", "NoFinancial", "AuthHeld", "participant.join_authorize", 65],
  ["participant", DR_DANA, "money_state", "AuthHeld", "AuthLocked", "deal.close_joining", 50],
  ["participant", DR_DANA, "money_state", "AuthLocked", "ChargeAttempt", "charging.start", 40],
  ["participant", DR_DANA, "money_state", "ChargeAttempt", "ChargedSuccess", "charging.capture_success", 35],
  ["participant", DR_YOSSI, "buyer_state", "NotJoined", "JoinedAuthorized", "participant.join_authorize", 64],
  ["participant", DR_YOSSI, "buyer_state", "JoinedAuthorized", "LockedIn", "deal.close_joining", 50],
  ["participant", DR_YOSSI, "buyer_state", "LockedIn", "ChargingAttempt", "charging.start", 40],
  ["participant", DR_YOSSI, "buyer_state", "ChargingAttempt", "ChargeFailedCompletion", "charging.capture_failed", 35],
  ["participant", DR_YOSSI, "buyer_state", "ChargeFailedCompletion", "Dropped", "charging.recovery_failed", 25],
  ["participant", DR_YOSSI, "money_state", "NoFinancial", "AuthHeld", "participant.join_authorize", 64],
  ["participant", DR_YOSSI, "money_state", "AuthHeld", "AuthLocked", "deal.close_joining", 50],
  ["participant", DR_YOSSI, "money_state", "AuthLocked", "ChargeAttempt", "charging.start", 40],
  ["participant", DR_YOSSI, "money_state", "ChargeAttempt", "ChargeFailedRecovery", "charging.capture_failed", 35],
  ["participant", DR_YOSSI, "money_state", "ChargeFailedRecovery", "AuthReleased", "authorization.release", 25]
];

const FIXTURE_SQL = `
INSERT INTO siton.seller_accounts (seller_id, display_name, login_email, verification_status, settlement_status, business_name, support_email)
VALUES ('dr-seller', '[DR] מוכר בדיקה', 'dr-seller@siton.test', 'approved', 'active', '[DR] Test Business', 'support@siton.test')
ON CONFLICT (seller_id) DO NOTHING;
INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at, completion_window_until)
VALUES ('${DR_DEAL}', '[DR] עסקת שחזור', 25, 10, 40, 9, now() + interval '2 days', 'dr-seller', 'Completed', now() - interval '70 minutes', now() - interval '20 minutes');
INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
VALUES ('${DR_DEAL}', 'delivery', '[DR] משלוח', 20, 0);
INSERT INTO siton.participants (participant_id, deal_id, buyer_id, buyer_name, qty, buyer_state, money_state)
VALUES ('${DR_DANA}', '${DR_DEAL}', '+972500000001', 'דנה', 2, 'DealCompleted', 'ChargedSuccess'),
       ('${DR_YOSSI}', '${DR_DEAL}', '+972500000002', 'יוסי', 1, 'Dropped', 'AuthReleased');
INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload, created_at)
VALUES ${auditValues(FIXTURE_AUDIT)};
INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, dispatched_at, resolved_at, provider_reference, created_at)
VALUES ('${DR_DANA}', '${DR_DEAL}', 'charge_start', 'success', 'dr-capture-dana', 'responded', now() - interval '36 minutes', now() - interval '35 minutes', 'dr-mock-capture-1', now() - interval '36 minutes');
INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, dispatched_at, resolved_at, failure_evidence, created_at)
VALUES ('${DR_YOSSI}', '${DR_DEAL}', 'charge_start', 'permanent_fail', 'dr-capture-yossi', 'responded', now() - interval '36 minutes', now() - interval '35 minutes', 'dispatch_response', now() - interval '36 minutes');
INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, dispatched_at, resolved_at, created_at)
VALUES ('${DR_YOSSI}', '${DR_DEAL}', 'release', 'success', 'dr-release-yossi', 'responded', now() - interval '26 minutes', now() - interval '25 minutes', now() - interval '26 minutes');
INSERT INTO siton.platform_fee_money_events (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, source_money_state, payout_readiness_status, gross_amount, vat_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount, created_at)
VALUES ('${DR_DANA}', '${DR_DEAL}', 'dr-seller', 'charge_captured', 'charge', 'mockpay', 'ChargedSuccess', 'ready_for_settlement', 50, 0, 50, 0.08, 0.18, 4.00, 0.72, 4.72, 4.72, 45.28, now() - interval '35 minutes');
INSERT INTO siton.seller_payout_batches (payout_batch_id, seller_id, trigger_deal_id, payout_status, provider_code, correlation_id, idempotency_key, settlement_count, item_count, gross_collected, platform_fee_total, refunds_total, reserve_amount, seller_net_payable, payout_amount, created_at)
VALUES ('44444444-4444-4444-4444-444444444444', 'dr-seller', '${DR_DEAL}', 'batched', 'mockpayout', 'dr-payout', 'seller-payout-batch:${DR_DEAL}', 1, 1, 50, 4.72, 0, 0, 45.28, 45.28, now() - interval '10 minutes');
INSERT INTO siton.seller_settlements (seller_settlement_id, seller_id, deal_id, payout_batch_id, payout_status, gross_collected, platform_fee_total, refunds_total, reserve_amount, seller_net_payable, payout_amount, source_money_event_count, final_truth_basis, idempotency_key, last_calculated_at)
VALUES ('55555555-5555-5555-5555-555555555555', 'dr-seller', '${DR_DEAL}', '44444444-4444-4444-4444-444444444444', 'batched', 50, 4.72, 0, 0, 45.28, 45.28, 1, 'deal_completed_money_truth', 'seller-settlement:${DR_DEAL}', now() - interval '10 minutes');
INSERT INTO siton.seller_payout_batch_items (payout_batch_id, seller_settlement_id, participant_id, deal_id, seller_id, payout_status, correlation_id, idempotency_key, gross_collected, platform_fee_total, refunds_total, reserve_amount, seller_net_payable, payout_amount, source_money_event_count, buyer_state_at_batch, money_state_at_batch, created_at)
VALUES ('44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555', '${DR_DANA}', '${DR_DEAL}', 'dr-seller', 'batched', 'dr-payout', 'seller-payout-item:${DR_DANA}', 50, 4.72, 0, 0, 45.28, 45.28, 1, 'DealCompleted', 'ChargedSuccess', now() - interval '10 minutes');
`;

// NEGATIVE CONTROL: a deliberately inconsistent dataset, loaded only into a
// throw-away clone of the restored database. The checker must FAIL exactly on
// these invariants — proving each one can see its corruption — and on nothing
// else (a clean fixture next to the corruption must not start failing).
const NEG_DEAL_COMPLETED = "66666666-6666-6666-6666-666666666666";
const NEG_DEAL_CHARGING = "77777777-7777-7777-7777-777777777777";
const NEG_P_UNLEDGERED = "88888888-8888-8888-8888-888888888888";
const NEG_P_BAD_FEE = "99999999-9999-9999-9999-999999999999";
const NEGATIVE_CONTROL_SQL = `
INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
VALUES ('${NEG_DEAL_COMPLETED}', '[DR-NEG] over capacity, no audit', 25, 1, 3, 1, now() + interval '2 days', 'dr-seller', 'Completed', now()),
       ('${NEG_DEAL_CHARGING}', '[DR-NEG] charging without work', 25, 1, 10, 1, now() + interval '2 days', 'dr-seller', 'Charging', now());
INSERT INTO siton.participants (participant_id, deal_id, buyer_id, buyer_name, qty, buyer_state, money_state)
VALUES ('${NEG_P_UNLEDGERED}', '${NEG_DEAL_COMPLETED}', '+972500000091', 'neg-a', 2, 'DealCompleted', 'ChargedSuccess'),
       ('${NEG_P_BAD_FEE}', '${NEG_DEAL_COMPLETED}', '+972500000092', 'neg-b', 2, 'DealCompleted', 'ChargedSuccess');
INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, resolved_at)
VALUES ('${NEG_P_BAD_FEE}', '${NEG_DEAL_COMPLETED}', 'charge_start', 'success', 'neg-capture-b', 'responded', now());
INSERT INTO siton.platform_fee_money_events (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, source_money_state, payout_readiness_status, gross_amount, vat_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount)
VALUES ('${NEG_P_BAD_FEE}', '${NEG_DEAL_COMPLETED}', 'dr-seller', 'charge_captured', 'charge', 'mockpay', 'ChargedSuccess', 'ready_for_settlement', 50, 0, 50, 0.08, 0.18, 4.00, 0.72, 9.99, 9.99, 30.00);
`;
const NEGATIVE_CONTROL_EXPECTED_FAILURES = [
  "fee.total_equals_base_plus_vat",               // 9.99 <> 4.00 + 0.72
  "fee.seller_net_equals_gross_minus_fee_total",  // 30.00 <> 50 - 9.99
  "participant.charged_state_has_charge_fee_row", // neg-a ChargedSuccess, no ledger row
  "participant.charged_state_has_successful_capture", // neg-a has no capture attempt
  "deal.joined_units_within_max_units",           // 2 + 2 held units > max_units 3
  "deal.charging_has_live_work",                  // Charging, no job / DLQ / reconcile / case
  "audit.deal_state_has_latest_transition",       // both deals, no audit
  "audit.participant_buyer_state_has_latest_transition",
  "audit.participant_money_state_has_latest_transition"
].sort();

// Supabase staging grant files, in order: the runtime-role boundary that
// pg_dump --no-privileges / pg_restore --no-privileges deliberately does not
// carry. 004 / 015 and the verify_* scripts need Supabase's storage schema and
// are not part of the grant boundary on plain PostgreSQL.
const STAGING_GRANT_FILES = [
  "001_siton_inventory_v1.sql", "006_canonical_postgres_runtime_boundary.sql",
  "007_runtime_role_admin_set_proof.sql", "008_runtime_trigger_helper_execute.sql",
  "009_runtime_function_public_fail_closed.sql", "010_r3_web_login_provisioning.sql",
  "011_r4_worker_login_provisioning.sql", "012_web_notification_enqueue.sql",
  "013_r6_viral_graph_grants.sql", "014_r6_worker_webhook_ingest.sql",
  "016_r8_admin_notification_attempts_read.sql", "017_r8_admin_payout_rail_read.sql",
  "018_p0_2_bindings_and_deal_delete.sql", "019_p0_3_chat_reactions_business_profiles.sql",
  "020_p0_4_field_change_audit.sql", "021_p0_5_support_messages.sql",
  "022_p0_7_seller_inquiries.sql", "023_receipt_content_grants.sql",
  "024_r9c_payment_lifecycle_grants.sql", "025_product_catalog_grants.sql",
  "026_distribution_link_viewer_grants.sql"
];
const RUNTIME_ROLES = ["siton_web_runtime", "siton_worker_runtime"];
const GRANT_RUNBOOK_STEP = "after pg_restore --no-privileges, as the database owner apply supabase/staging/{" + STAGING_GRANT_FILES.map((f) => f.slice(0, 3)).join(",") + "}*.sql in order (psql -v ON_ERROR_STOP=1 -f <file>), then run supabase/staging/verify_r1_foundation.sql (read-only) — docs/DATABASE_INCIDENT_RUNBOOK.md section 7";

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
  let invariantsSource = null;
  let hashesSource = null;
  let runtimeRolesPresent = false;
  let aclSource = [];
  let aclRestored = [];
  let grantLoss = { lost: [], gained: [] };
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

    await step(report, "3b runtime-role grants on source", async () => {
      runtimeRolesPresent = await rolesExist(source.url, RUNTIME_ROLES);
      if (!runtimeRolesPresent) {
        aclSource = await aclSnapshot(source.url);
        return { status: "PASS", summary: "runtime roles " + RUNTIME_ROLES.join("/") + " absent in this cluster: source keeps migration-only ACLs (" + aclSource.length + " ACL entries)" };
      }
      const failures = await applyStagingGrants(source.url);
      aclSource = await aclSnapshot(source.url);
      const runtimeEntries = aclSource.filter((entry) => /^siton_/.test(entry.split("|")[2])).length;
      return { status: "PASS", summary: "applied " + (STAGING_GRANT_FILES.length - failures.length) + "/" + STAGING_GRANT_FILES.length + " staging grant files; " + runtimeEntries + " runtime-role ACL entries on source", detail: failures.length ? failures.join("\n") : undefined };
    });

    await step(report, "3c money invariants on source (fixture is consistent)", async () => {
      invariantsSource = await moneyInvariantReport(source.url);
      const failing = moneyInvariants.failingNames(invariantsSource);
      if (failing.length) return { status: "FAIL", summary: "fixture is not financially consistent: " + failing.join(", "), detail: invariantsSource.results.map(moneyInvariants.formatResult).join("\n") };
      return { status: "PASS", summary: invariantCounts(invariantsSource) };
    });

    await step(report, "3d source content hashes", async () => {
      // Re-read counts and object totals: 3b may have added the staging
      // boundary objects (siton_inventory, participants.inventory_reservation_id).
      countsSource = await tableCounts(source.url);
      objectsSource = await objectCounts(source.url);
      hashesSource = await contentHashes(source.url);
      return { status: "PASS", summary: Object.keys(hashesSource).length + " tables hashed (md5 of every row, stable order)" };
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

    await step(report, "7a2 per-table content hashes", async () => {
      const hashesRestored = await contentHashes(restored.url);
      const tables = [...new Set([...Object.keys(hashesSource), ...Object.keys(hashesRestored)])].sort();
      const diffs = tables.filter((table) => hashesSource[table] !== hashesRestored[table]);
      if (diffs.length) return { status: "FAIL", summary: diffs.length + " table(s) differ in content after restore: " + diffs.slice(0, 10).join(", "), detail: diffs.map((t) => t + " source=" + hashesSource[t] + " restored=" + hashesRestored[t]).join("\n") };
      const nonEmpty = tables.filter((table) => !hashesSource[table].startsWith("rows=0 ")).length;
      return { status: "PASS", summary: tables.length + " tables byte-identical by content hash (" + nonEmpty + " non-empty)" };
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

    await step(report, "7e money invariants: restored == source", async () => {
      const invariantsRestored = await moneyInvariantReport(restored.url);
      const left = JSON.stringify(moneyInvariants.comparable(invariantsSource));
      const right = JSON.stringify(moneyInvariants.comparable(invariantsRestored));
      if (left !== right) {
        const before = new Map(moneyInvariants.comparable(invariantsSource).map((r) => [r.name, JSON.stringify(r)]));
        const changed = moneyInvariants.comparable(invariantsRestored).filter((r) => before.get(r.name) !== JSON.stringify(r)).map((r) => r.name);
        return { status: "FAIL", summary: "money invariant results differ after restore: " + changed.join(", "), detail: invariantsRestored.results.map(moneyInvariants.formatResult).join("\n") };
      }
      const failing = moneyInvariants.failingNames(invariantsRestored);
      if (failing.length) return { status: "FAIL", summary: "restored database violates: " + failing.join(", ") };
      return { status: "PASS", summary: "identical on source and restored (" + invariantsRestored.results.length + " invariants: " + invariantCounts(invariantsRestored) + ")" };
    });

    await step(report, "7f append-only triggers fire after restore", async () => {
      const outcomes = await tools.withClient(restored.url, async (client) => {
        const target = (await client.query("SELECT audit_id FROM siton.audit_log ORDER BY created_at, audit_id LIMIT 1")).rows[0];
        if (!target) throw new Error("no audit_log row to probe (fixture lost?)");
        const probe = async (sql) => {
          await client.query("BEGIN");
          try {
            await client.query(sql, [target.audit_id]);
            return "NOT_REJECTED";
          } catch (error) {
            return String(error.message || error);
          } finally {
            await client.query("ROLLBACK");
          }
        };
        return {
          update: await probe("UPDATE siton.audit_log SET action_name = action_name WHERE audit_id = $1"),
          delete: await probe("DELETE FROM siton.audit_log WHERE audit_id = $1"),
          still_there: Number((await client.query("SELECT count(*)::int AS n FROM siton.audit_log WHERE audit_id = $1", [target.audit_id])).rows[0].n)
        };
      });
      const bad = ["update", "delete"].filter((op) => !/append-only/i.test(outcomes[op]));
      if (bad.length || outcomes.still_there !== 1) return { status: "FAIL", summary: "append-only enforcement missing after restore for: " + (bad.join(", ") || "row vanished"), detail: JSON.stringify(outcomes) };
      return { status: "PASS", summary: "UPDATE and DELETE on siton.audit_log rejected on the restored database (\"" + outcomes.update.slice(0, 60) + "\"); row intact" };
    });

    await step(report, "7g grants dropped by --no-privileges", async () => {
      aclRestored = await aclSnapshot(restored.url);
      const lost = setDiff(aclSource, aclRestored);
      const gained = setDiff(aclRestored, aclSource);
      grantLoss = { lost, gained };
      const byGrantee = (entries) => Object.entries(entries.reduce((acc, entry) => { const g = entry.split("|")[2]; acc[g] = (acc[g] || 0) + 1; return acc; }, {})).map(([g, n]) => g + "=" + n).join(" ") || "none";
      return {
        status: "PASS",
        summary: "lost " + lost.length + " ACL entries (" + byGrantee(lost) + "); default-ACL entries that reappeared " + gained.length + " (" + byGrantee(gained) + ")",
        detail: ["LOST (in source, absent after restore):", ...lost.slice(0, 40), lost.length > 40 ? "... " + (lost.length - 40) + " more" : "", "REAPPEARED (defaults the source had revoked):", ...gained.slice(0, 40)].filter(Boolean).join("\n")
      };
    });

    await step(report, "7h runtime-role grant re-provision", async () => {
      if (!runtimeRolesPresent) {
        return { status: "NOT_APPLICABLE", summary: "SKIPPED: runtime roles " + RUNTIME_ROLES.join("/") + " do not exist in this cluster, so re-provisioning cannot be proven here. Runbook step: " + GRANT_RUNBOOK_STEP };
      }
      const failures = await applyStagingGrants(restored.url);
      const after = await aclSnapshot(restored.url);
      const stillLost = setDiff(aclSource, after);
      const extra = setDiff(after, aclSource);
      if (stillLost.length || extra.length) {
        return { status: "FAIL", summary: "after re-applying staging grant files the ACL still differs from the source: " + stillLost.length + " missing, " + extra.length + " extra", detail: ["MISSING:", ...stillLost.slice(0, 40), "EXTRA:", ...extra.slice(0, 40), "APPLY FAILURES:", ...failures].join("\n") };
      }
      return { status: "PASS", summary: "re-applied " + (STAGING_GRANT_FILES.length - failures.length) + "/" + STAGING_GRANT_FILES.length + " staging grant files; all " + grantLoss.lost.length + " lost ACL entries restored, " + grantLoss.gained.length + " reappeared defaults revoked again; ACL identical to source", detail: failures.length ? failures.join("\n") : undefined };
    });

    await step(report, "8 negative control: corruption makes the checker FAIL", async () => {
      const clone = await isolation.createIsolatedDatabase({ baseUrl, purpose: "drnegative", template: restored.name });
      created.push(clone);
      await tools.withClient(clone.url, (client) => client.query(NEGATIVE_CONTROL_SQL));
      const corrupted = await moneyInvariantReport(clone.url);
      const failing = moneyInvariants.failingNames(corrupted).sort();
      const missing = NEGATIVE_CONTROL_EXPECTED_FAILURES.filter((name) => !failing.includes(name));
      const unexpected = failing.filter((name) => !NEGATIVE_CONTROL_EXPECTED_FAILURES.includes(name));
      const detail = corrupted.results.filter((r) => r.status !== "PASS").map(moneyInvariants.formatResult).join("\n");
      if (corrupted.overall !== "FAIL" || missing.length || unexpected.length) {
        return { status: "FAIL", summary: "checker did not fail exactly as expected; missed=" + (missing.join(",") || "-") + " unexpected=" + (unexpected.join(",") || "-"), detail };
      }
      return { status: "PASS", summary: "checker FAILED on exactly the " + failing.length + " corrupted invariants: " + failing.join(", "), detail };
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

async function moneyInvariantReport(url) {
  return tools.withClient(url, (client) => moneyInvariants.runInvariants(client));
}

function invariantCounts(invariantReport) {
  const c = invariantReport.counts;
  return "pass=" + c.PASS + " fail=" + c.FAIL + " error=" + c.ERROR + " skipped=" + c.SKIPPED + " info=" + c.INFO;
}

// md5 over every row's text form, ordered by that text under the C collation,
// so the hash is independent of physical row order and of the database's
// locale. Covers every table of the application schemas.
async function contentHashes(url) {
  return tools.withClient(url, async (client) => {
    const tables = (await client.query(`SELECT n.nspname AS s, c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('siton','siton_inventory') AND c.relkind IN ('r','p') ORDER BY 1, 2`)).rows;
    const out = {};
    for (const { s, t } of tables) {
      const ident = quoteIdent(s) + "." + quoteIdent(t);
      const row = (await client.query(`SELECT count(*)::bigint AS n, md5(COALESCE(string_agg(x.r, E'\\n' ORDER BY x.r COLLATE "C"), '')) AS h FROM (SELECT t::text AS r FROM ${ident} t) x`)).rows[0];
      out[s + "." + t] = "rows=" + row.n + " md5=" + row.h;
    }
    return out;
  });
}

function quoteIdent(value) {
  return "\"" + String(value).replace(/"/g, "\"\"") + "\"";
}

async function rolesExist(url, roles) {
  return tools.withClient(url, async (client) => Number((await client.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)", [roles])).rows[0].n) === roles.length);
}

// Applies the staging grant files best-effort (a file that needs Supabase-only
// objects may fail on plain PostgreSQL); the resulting ACL is what is asserted.
async function applyStagingGrants(url) {
  const failures = [];
  await tools.withClient(url, async (client) => {
    for (const file of STAGING_GRANT_FILES) {
      try {
        await client.query(fs.readFileSync(path.join(root, "supabase", "staging", file), "utf8"));
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        failures.push(file + ": " + String(error.message || error).split("\n")[0]);
      }
    }
  });
  return failures;
}

// Every effective privilege on the application schemas and their objects, with
// NULL ACLs expanded to the built-in defaults (so a revoked PUBLIC EXECUTE that
// silently comes back after --no-privileges is visible). Entry format:
//   kind|object|grantee|privilege|grantable
async function aclSnapshot(url) {
  return tools.withClient(url, async (client) => (await client.query(`
    WITH objs AS (
      SELECT 'schema' AS kind, n.nspname::text AS obj, (aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner)))).*
        FROM pg_namespace n WHERE n.nspname IN ('siton','siton_inventory')
      UNION ALL
      SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'relation' END, n.nspname || '.' || c.relname,
             (aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)))).*
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('siton','siton_inventory') AND c.relkind IN ('r','p','v','m','S','f')
      UNION ALL
      SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, (aclexplode(a.attacl)).*
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('siton','siton_inventory') AND a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'function', p.oid::regprocedure::text, (aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner)))).*
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('siton','siton_inventory') OR (n.nspname = 'public' AND p.proname LIKE 'siton%')
    )
    SELECT kind || '|' || obj || '|' || CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END || '|' || privilege_type || '|' || is_grantable AS entry
    FROM objs ORDER BY 1`)).rows.map((row) => row.entry));
}

function setDiff(left, right) {
  const other = new Set(right);
  return left.filter((entry) => !other.has(entry));
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
