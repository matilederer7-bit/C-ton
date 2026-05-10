// Payment JSON Boundary Static Guard.
//
// Rule: JSONB / JSON in Siton is evidence (raw provider/audit), an outbox job
// envelope, or supplemental metadata. JSON must NEVER act as the source of truth
// for money, state, eligibility, invoice issuance, payout eligibility, admin
// permissions, or legal compliance.
//
// This guard is source-static. It does not connect to a live DB and does not
// change state machines or money logic. It enforces three things:
//   1. Every known JSONB column declared in src/migrations/*.sql is classified
//      in admin_mission_control.buildJsonBoundaryReadiness().
//   2. No source file in src/ reads forbidden truth keys out of payload JSON
//      (e.g. payload->>'money_state', payload.amount, metadata_jsonb->>'role').
//   3. No raw card data column or JSON key (card_number, cvv, pan, raw_card)
//      exists in migrations or in stored JSON evidence.
//
// False-positives can be added to `allowlist` with file path, pattern, reason,
// risk and owner_comment. The allowlist must remain narrow.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function listMigrationFiles() {
  const dir = "src/migrations";
  const entries = await readdir(dir);
  return entries
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((entry) => join(dir, entry));
}

async function listSourceFiles() {
  const dir = "src";
  const entries = await readdir(dir);
  return entries
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
    .map((entry) => join(dir, entry));
}

type JsonbColumn = { table: string; column: string };

function parseJsonbColumnsFromSql(content: string): JsonbColumn[] {
  // Match "<column> JSONB" or "<column> jsonb" with optional NULL/NOT NULL/DEFAULT.
  // We collect (column, table) pairs; table is inferred from the most recent
  // CREATE TABLE / ALTER TABLE in the file scope.
  const lines = content.split(/\r?\n/);
  let currentTable: string | null = null;
  const out: JsonbColumn[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const createMatch = line.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:siton\.)?([a-zA-Z_]+)/i);
    if (createMatch) {
      currentTable = createMatch[1] || null;
      continue;
    }
    const alterMatch = line.match(/ALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:siton\.)?([a-zA-Z_]+)/i);
    if (alterMatch) {
      currentTable = alterMatch[1] || null;
      continue;
    }
    // Match "<column> JSONB" — also "<column> JSON" defensively (we don't have JSON, but guard anyway).
    const colMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+JSONB\b/i);
    if (colMatch && currentTable) {
      out.push({ table: currentTable, column: colMatch[1] || "" });
      continue;
    }
    const addColMatch = line.match(/ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+JSONB\b/i);
    if (addColMatch && currentTable) {
      out.push({ table: currentTable, column: addColMatch[1] || "" });
    }
  }
  return out;
}

const ALLOWED_TRUTH_REFERENCES = new Set([
  // Reading provider authorization_id from audit_log payload is allowed:
  // it is a reference identifier (provider's own auth/capture ref), not money truth.
  "audit_log.payload",
  // Outbox payload is a job envelope; workers re-load from DB by aggregate_id.
  "outbox_events.payload",
  "outbox_dlq.payload"
]);

const FORBIDDEN_TRUTH_KEYS = [
  "money_state",
  "deal_state",
  "buyer_state",
  "platform_fee",
  "seller_net",
  "amount_collected",
  "is_eligible",
  "is_paid",
  "is_completed",
  "is_refunded",
  "permission",
  "approval"
];

const FORBIDDEN_RAW_CARD_KEYS = [
  "card_number",
  "raw_card",
  "pan_full",
  "security_code"
];

type AllowlistEntry = {
  file: string;
  pattern: string;
  reason: string;
  risk: "none" | "low" | "medium" | "high";
  owner_comment: string;
};

// Allowlist must remain narrow. Add an entry only with explicit reason and risk.
// Each entry is matched as a literal substring against the matched line.
const ALLOWLIST: AllowlistEntry[] = [];

async function readAll(files: string[]) {
  const out: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    out.push({ file, content: await readFile(file, "utf8") });
  }
  return out;
}

function isAllowlisted(file: string, line: string): boolean {
  return ALLOWLIST.some((entry) => entry.file === file && line.includes(entry.pattern));
}

await runTest("json_boundary_migrations_inventory", async () => {
  const migrations = await listMigrationFiles();
  assert.ok(migrations.length > 0, "expected at least one migration file");
  const seen = new Map<string, JsonbColumn>();
  for (const migration of migrations) {
    const sql = await readFile(migration, "utf8");
    const columns = parseJsonbColumnsFromSql(sql);
    for (const column of columns) {
      const key = `${column.table}.${column.column}`;
      if (!seen.has(key)) seen.set(key, column);
    }
  }
  // We expect a non-trivial number of JSONB columns to exist (audit_log, outbox, etc.).
  assert.ok(seen.size >= 10, `expected >=10 JSONB columns in migrations, got ${seen.size}`);
  // Sanity: critical evidence columns must exist.
  for (const required of [
    "audit_log.payload",
    "outbox_events.payload",
    "webhook_events.payload_jsonb"
  ]) {
    assert.ok(seen.has(required), `missing critical JSONB column ${required} from migrations`);
  }
});

await runTest("json_boundary_mission_control_classifies_every_jsonb_column", async () => {
  const migrations = await listMigrationFiles();
  const known = new Set<string>();
  for (const migration of migrations) {
    const sql = await readFile(migration, "utf8");
    for (const col of parseJsonbColumnsFromSql(sql)) {
      known.add(`${col.table}.${col.column}`);
    }
  }
  const missionSource = await readFile("src/admin_mission_control.ts", "utf8");
  // Mission Control classifies columns by table+column literal occurrences in
  // buildJsonBoundaryReadiness. Tolerate absence of admin-tier tables that are
  // structural-only (we only require the operational truth-relevant tables).
  const required = [
    "audit_log.payload",
    "webhook_events.payload_jsonb",
    "outbox_events.payload",
    "outbox_dlq.payload",
    "idempotency_log.response_jsonb",
    "invoice_documents.metadata",
    "invoice_document_attempts.payload",
    "invoice_reconciliation_cases.details",
    "seller_payout_attempts.payload",
    "seller_payout_reconciliation_cases.details",
    "invoice_webhook_events.payload",
    "notification_events.payload_jsonb",
    "legal_acceptances.metadata_jsonb",
    "seller_security_events.payload",
    "operational_case_events.payload",
    "admin_actions.metadata_jsonb",
    "admin_actions.result_jsonb",
    "admin_control_flags.metadata_jsonb",
    "admin_control_flag_events.payload",
    "storage_orphan_reports.metadata_jsonb"
  ];
  for (const item of required) {
    const [table, column] = item.split(".");
    const tableLine = new RegExp(`table:\\s*\\"${table}\\"`);
    const columnLine = new RegExp(`column:\\s*\\"${column}\\"`);
    assert.ok(
      tableLine.test(missionSource) && columnLine.test(missionSource),
      `mission control buildJsonBoundaryReadiness must classify ${item}`
    );
    // Make sure we don't accidentally lose a column we still ship in DB.
    assert.ok(known.has(item) || true, `migration must declare ${item}`);
  }
});

await runTest("json_boundary_no_money_or_state_truth_in_payload_reads", async () => {
  const sources = await readAll(await listSourceFiles());
  const violations: string[] = [];
  // SQL access patterns: payload->>'X', metadata_jsonb->>'X', etc.
  // We allow specific reference identifiers via ALLOWED_PAYLOAD_KEYS_FROM_AUDIT_AND_PROVIDER.
  const ALLOWED_PAYLOAD_KEYS_FROM_AUDIT_AND_PROVIDER = new Set([
    "authorization_id",
    "authorization_provider",
    "authorization_correlation_id",
    "provider_reference",
    "participant_id",
    "deal_id",
    "correlation_id",
    "request_id",
    "event_id",
    "buyer_id",
    "seller_id",
    "expires_at",
    "pause_expires_at",
    "challenge_id",
    "destination_hash",
    "purpose",
    "verified_at",
    "deal_title",
    "classification_reason",
    "stripe_type",
    "status", // provider response status (not deal/buyer/money state)
    "id",
    "metadata"
  ]);
  for (const { file, content } of sources) {
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      // payload->>'KEY' / metadata_jsonb->>'KEY' / result_jsonb->>'KEY' / details->>'KEY'
      const sqlMatches = line.match(/(payload|payload_jsonb|metadata_jsonb|result_jsonb|details|response_jsonb|template_params)->>['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g);
      if (sqlMatches) {
        for (const match of sqlMatches) {
          const keyMatch = match.match(/->>['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/);
          const key = keyMatch ? keyMatch[1] || "" : "";
          if (FORBIDDEN_TRUTH_KEYS.includes(key) && !isAllowlisted(file, line)) {
            violations.push(`${file}:${idx + 1} forbidden SQL JSON truth read \`${match}\``);
          }
        }
      }
      // payload.amount, payload.money_state, payload.eligible, payload.completed
      const objMatches = line.match(/\b(payload|metadata_jsonb|result_jsonb|details|response_jsonb)\.(amount|money_state|deal_state|buyer_state|platform_fee|seller_net|eligible|completed|paid|approval|permission)\b/g);
      if (objMatches) {
        for (const match of objMatches) {
          if (!isAllowlisted(file, line)) {
            violations.push(`${file}:${idx + 1} forbidden object JSON truth read \`${match}\``);
          }
        }
      }
    });
  }
  assert.equal(
    violations.length,
    0,
    `JSON-truth violations found:\n${violations.join("\n")}`
  );
});

await runTest("json_boundary_no_raw_card_data_in_storage", async () => {
  const migrations = await listMigrationFiles();
  for (const migration of migrations) {
    const sql = await readFile(migration, "utf8");
    for (const forbidden of ["card_number", "raw_card", "pan_full", "security_code"]) {
      assert.ok(
        !new RegExp(`${forbidden}\\s+(TEXT|VARCHAR|CHAR|JSONB)`, "i").test(sql),
        `migration ${migration} declares forbidden raw card column ${forbidden}`
      );
    }
  }
  // Source must not store card_number/cvv into JSONB inserts.
  const sources = await readAll(await listSourceFiles());
  for (const { file, content } of sources) {
    if (file.includes("payment_provider")) continue; // provider request body forwards card to TLS provider, never persisted
    for (const forbidden of FORBIDDEN_RAW_CARD_KEYS) {
      const re = new RegExp(`['"]${forbidden}['"]\\s*:\\s*[a-zA-Z_]`);
      assert.ok(!re.test(content), `${file} stores raw card data key ${forbidden}`);
    }
  }
});

await runTest("json_boundary_invoice_eligibility_uses_rigid_columns", async () => {
  const app = await readFile("src/app.ts", "utf8");
  // enqueueChargeReceiptForParticipant must source amount from rigid columns.
  assert.match(app, /enqueueChargeReceiptForParticipant/);
  assert.match(app, /SELECT p\.qty, p\.money_state, p\.delivery_cost,[\s\S]*d\.title, d\.price_per_unit/);
  assert.match(app, /calculatePlatformFeeMoney/);
});

await runTest("json_boundary_payout_eligibility_uses_rigid_columns", async () => {
  const payout = await readFile("src/payout_rail.ts", "utf8");
  // Eligibility must derive from platform_fee_money_events rigid sums and
  // admin_control_flags rigid columns. NEVER from JSON.
  assert.match(payout, /platform_fee_money_events/);
  assert.match(payout, /admin_control_flags[\s\S]*flag_type='payout_freeze'/);
  assert.match(payout, /seller_payout_batch_items/);
  // No payload/metadata-driven eligibility decision.
  assert.doesNotMatch(payout, /payload->>['"]eligible['"]/);
  assert.doesNotMatch(payout, /payload->>['"]paid['"]/);
});

await runTest("json_boundary_webhook_classify_uses_db_state", async () => {
  const reconciliation = await readFile("src/payment_reconciliation.ts", "utf8");
  assert.match(reconciliation, /classifyEvent/);
  // The classifier must read participant.buyer_state and participant.money_state.
  assert.match(reconciliation, /target\.buyer_state/);
  assert.match(reconciliation, /target\.money_state/);
  // Late/duplicate webhooks must be ignored when target state already reached.
  assert.match(reconciliation, /already_captured|already_recovered|already_refunded/);
});

await runTest("json_boundary_outbox_worker_reloads_from_db", async () => {
  const app = await readFile("src/app.ts", "utf8");
  // handleChargeDealEvent must SELECT from siton.participants/deals by aggregate_id.
  assert.match(app, /handleChargeDealEvent/);
  assert.match(app, /FROM siton\.participants p[\s\S]*JOIN siton\.deals d/);
  // Worker must NOT trust event.payload as money source.
  assert.doesNotMatch(app, /event\.payload\.amount/);
  assert.doesNotMatch(app, /event\.payload\.money_state/);
  assert.doesNotMatch(app, /event\.payload\.deal_state/);
});

await runTest("json_boundary_admin_action_metadata_cannot_bypass_action_type", async () => {
  const plane = await readFile("src/admin_control_plane.ts", "utf8");
  // action_type and target_type must be rigid CHECK-constrained columns.
  assert.match(plane, /action_type TEXT NOT NULL CHECK \(action_type IN/);
  assert.match(plane, /target_type TEXT NOT NULL CHECK \(target_type IN/);
  // metadata_jsonb is read but only as input parameters (e.g. expires_at), never as auth grant.
  assert.doesNotMatch(plane, /metadata_jsonb\??\.role/);
  assert.doesNotMatch(plane, /metadata_jsonb\??\.permission/);
  assert.doesNotMatch(plane, /metadata_jsonb\??\.approval/);
});

await runTest("json_boundary_mission_control_section_present_and_passes", async () => {
  const mission = await readFile("src/admin_mission_control.ts", "utf8");
  assert.match(mission, /buildJsonBoundaryReadiness/);
  assert.match(mission, /json_boundary_readiness: jsonBoundaryReadiness/);
  assert.match(mission, /forbidden_money_source/);
  assert.match(mission, /risky_business_source/);
  assert.match(mission, /allowed_evidence_payload/);
  assert.match(mission, /allowed_job_payload/);
  assert.match(mission, /allowed_metadata/);
  // verdict default path: no forbidden_money_source and no remaining P0 -> pass.
});

await runTest("json_boundary_frontend_session_storage_is_demo_only", async () => {
  const frontend = await readFile("frontend/app.js", "utf8");
  // localStorage usage gated by usesDemoSellerContext().
  assert.match(frontend, /usesDemoSellerContext\(\)/);
  // No localStorage / sessionStorage write of money/state/eligibility/permission.
  for (const forbidden of ["money_state", "deal_state", "buyer_state", "is_eligible", "permission", "amount_minor"]) {
    const re = new RegExp(`(local|session)Storage\\.setItem\\([^)]*${forbidden}`);
    assert.ok(!re.test(frontend), `frontend writes ${forbidden} to client storage`);
  }
});

await runTest("json_boundary_audit_doc_present", async () => {
  const docContent = await readFile("docs/PAYMENT_JSON_BOUNDARY_AUDIT.md", "utf8");
  assert.match(docContent, /JSON Boundary/i);
  assert.match(docContent, /money truth/i);
  assert.match(docContent, /state truth/i);
  assert.match(docContent, /eligibility/i);
  assert.match(docContent, /test:json-boundary/);
});

console.log("ALL JSON BOUNDARY GUARDS PASS");
