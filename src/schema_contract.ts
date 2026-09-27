type Db = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
};

async function queryRequiredTables(db: Db, tables: readonly string[]) {
  if (process.env.CANONICAL_POSTGRES_RUNTIME === "1") {
    return db.query(
      `SELECT table_name
       FROM unnest($1::text[]) AS required(table_name)
       WHERE to_regclass(format('siton.%I', table_name)) IS NOT NULL`,
      [tables]
    );
  }
  return db.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema='siton' AND table_name=ANY($1::text[])`,
    [tables]
  );
}

export const REQUIRED_TABLES = [
  "deals", "participants", "audit_log", "idempotency_log", "outbox_events", "outbox_dlq",
  "payment_attempts", "webhook_events", "seller_accounts", "seller_sessions",
  "affiliate_accounts", "affiliate_attributions", "affiliate_links", "affiliate_link_events", "support_tickets", "deal_delivery_options",
  "deal_images", "deal_chat_messages", "notification_events", "notification_attempts",
  "legal_acceptances", "otp_challenges", "otp_delivery_attempts", "invoice_documents",
  "invoice_document_attempts", "invoice_reconciliation_cases", "platform_fee_money_events",
  "seller_settlements", "seller_payout_batches", "seller_payout_batch_items",
  "seller_payout_attempts", "seller_payout_reconciliation_cases", "admin_actions",
  "admin_users", "admin_sessions", "admin_mfa_factors", "admin_mfa_challenges",
  "participant_tracking_tokens", "admin_control_flags", "admin_control_flag_events",
  "storage_orphan_reports", "operational_cases", "operational_case_events",
  "deal_voucher_terms", "deal_ticket_terms", "fulfillment_units", "migration_ledger", "worker_heartbeats",
  "storage_cleanup_tasks", "operational_recovery_audit", "buyer_sessions", "buyer_resume_contexts",
  "discovery_events", "viral_attributions", "viral_events", "viral_metrics_cache", "content_assets", "site_content",
  "distribution_link_viewers", "distribution_link_viewer_grants", "distribution_link_viewer_sessions",
  "distribution_link_viewer_login_attempts", "products", "product_images",
  "outbox_enqueue_evidence", "fixture_purge_audit"
] as const;

// EVERY migration in scripts/migration_manifest.cjs. Readiness fails closed
// when any of them is missing from the ledger, so a deployment can never
// precede the schema it relies on (Codex on PR #97: 075 adds the admin login
// lockout columns, 076 the per-row audit/outbox enforcement — a runtime that
// reported ready on a 074 database would answer admin logins with
// undefined_column and keep the vulnerable pre-076 trigger bodies).
// tests/release_tools/schema_contract_manifest.test.cjs pins this list to the
// manifest, so adding a migration without extending it fails the release tools.
export const REQUIRED_MIGRATION_IDS = [
  "014", "007", "008", "009", "010", "011", "012", "013", "014a", "015a", "015b", "016",
  "017", "018", "019", "020", "021", "022", "023", "024", "025", "026", "027", "028",
  "029", "030", "031", "032", "033", "034", "035", "036", "037", "038", "039", "040",
  "041", "042", "043", "044", "045", "046", "047", "048", "049", "050", "051", "052",
  "053", "054", "055", "056", "057", "058", "059", "060", "061", "065", "066", "067",
  "068", "069", "070", "071", "072", "073", "074", "075", "076", "077",
  "078"
] as const;

// Money / audit history the runtime roles must never DELETE or TRUNCATE, as
// [table, also check DELETE]. siton.deals: the web runtime's DELETE serves the
// draft-delete route (guarded by migration 078), so only TRUNCATE is refused.
const RUNTIME_PROTECTED_TABLES: ReadonlyArray<readonly [string, boolean]> = [
  ["deals", false],
  ["participants", true], ["payment_attempts", true], ["platform_fee_money_events", true],
  ["seller_settlements", true], ["seller_payout_batches", true], ["seller_payout_batch_items", true],
  ["seller_payout_attempts", true], ["seller_payout_reconciliation_cases", true],
  ["invoice_documents", true], ["invoice_document_attempts", true], ["audit_log", true],
  ["webhook_events", true], ["payment_authorization_bindings", true], ["fulfillment_units", true],
  ["deal_field_change_audit", true], ["operational_recovery_audit", true], ["fixture_purge_audit", true]
];

export async function assertDatabaseSchema(db: Db): Promise<void> {
  let ledger: { rows: any[] };
  try {
    ledger = await db.query(
      `SELECT migration_id, status FROM siton.migration_ledger ORDER BY position`
    );
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "";
    if (code === "42P01" || code === "3F000") {
      throw new Error("database schema is not migrated: siton.migration_ledger is missing");
    }
    if (code === "42501") {
      throw new Error(
        "database schema check failed: connected identity lacks privilege on siton.migration_ledger (code 42501)"
      );
    }
    throw new Error(`database schema check failed before migration inspection (code ${code || "unknown"})`);
  }
  const failed = ledger.rows.find((row: any) => row.status !== "succeeded");
  if (failed) throw new Error(`database migrations are incomplete at ${failed.migration_id}`);
  const applied = new Set(ledger.rows.map((row: any) => String(row.migration_id)));
  const missingMigrations = REQUIRED_MIGRATION_IDS.filter((id) => !applied.has(id));
  if (missingMigrations.length) throw new Error(`database migrations are incomplete: missing ${missingMigrations.join(", ")}`);

  const tables = await queryRequiredTables(db, REQUIRED_TABLES);
  const present = new Set(tables.rows.map((row: any) => String(row.table_name)));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`database schema drift: missing tables ${missing.join(", ")}; run migrations`);
  }

  // Enforcement triggers must exist AND be enabled: a trigger switched off with
  // a DISABLE TRIGGER table command (tgenabled 'D', or 'R' = replica-only)
  // keeps its name in pg_trigger while enforcing nothing, so a name-only check
  // would report a disarmed database as ready. Fail closed on both.
  const requiredTriggers = [
    "trg_deals_before_update_enforce",
    "trg_participants_before_update_enforce",
    "trg_audit_log_before_insert_enforce",
    "trg_audit_log_append_only_update",
    "trg_audit_log_append_only_delete",
    "trg_operational_recovery_audit_append_only_update",
    "trg_operational_recovery_audit_append_only_delete",
    "trg_outbox_fencing_cutover_update",
    "trg_outbox_fencing_cutover_delete",
    "trg_deals_outbox_enforce",
    "trg_payment_attempts_charge_rate_limit",
    // migration 076 (red-team C-1): outbox insertion evidence
    "trg_outbox_events_record_enqueue",
    "trg_outbox_enqueue_evidence_no_update",
    // migrations 067/068: payment operation lifecycle
    "trg_payment_attempts_lifecycle_guard",
    "trg_payment_attempts_eligibility",
    "trg_payment_attempts_settlement_fence",
    "trg_payment_attempts_settlement_horizon",
    // migration 077: payout rail forward-only status / monotonic amounts
    "trg_seller_settlements_status_forward_only",
    "trg_seller_payout_batches_status_forward_only",
    "trg_seller_payout_batch_items_status_forward_only",
    "trg_seller_settlements_monotonic_amounts",
    // migration 078: delete guard, frozen fields, issued documents, identities
    "trg_deals_before_delete_guard",
    "trg_participants_before_delete_fixture_purge",
    "trg_deals_seller_frozen_after_publish",
    "trg_participants_delivery_frozen_after_charge",
    "trg_invoice_documents_issued_immutable",
    "trg_invoice_documents_issued_no_delete",
    "trg_payment_attempts_identity_immutable",
    "trg_webhook_events_identity_immutable",
    "trg_fixture_purge_audit_append_only"
  ];
  const triggers = await db.query(
    `SELECT t.tgname, t.tgenabled::text AS tgenabled FROM pg_trigger t
     JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='siton' AND NOT t.tgisinternal`
  );
  const triggerSet = new Set(triggers.rows.map((row: any) => String(row.tgname)));
  const missingTriggers = requiredTriggers.filter((name) => !triggerSet.has(name));
  if (missingTriggers.length) {
    throw new Error(`database schema drift: missing triggers ${missingTriggers.join(", ")}`);
  }
  const requiredTriggerSet = new Set<string>(requiredTriggers);
  const disabledTriggers = triggers.rows
    .filter((row: any) => requiredTriggerSet.has(String(row.tgname)) && !["O", "A"].includes(String(row.tgenabled)))
    .map((row: any) => `${row.tgname}(${row.tgenabled})`);
  if (disabledTriggers.length) {
    throw new Error(`database schema drift: enforcement triggers disabled: ${disabledTriggers.join(", ")}`);
  }

  // Migration 075 (admin login lockout) columns and the 076 per-row helpers
  // must be live, not merely recorded: 076 replaces trigger BODIES without
  // renaming the triggers, so the trigger-name check above cannot tell the
  // hardened bodies from the pre-076 ones.
  // pg_attribute, not information_schema.columns: the latter hides columns
  // the connected role has no privilege on, and the worker role must still be
  // able to verify the schema it depends on.
  const lockoutColumns = await db.query(
    `SELECT a.attname FROM pg_attribute a
     JOIN pg_class c ON c.oid=a.attrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='siton' AND c.relname='admin_users' AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname IN ('failed_login_count','failed_login_window_started_at','login_locked_until')`
  );
  if (lockoutColumns.rows.length !== 3) {
    throw new Error("database schema drift: admin_users login lockout columns (migration 075) are missing");
  }
  const perRowHelpers = await db.query(
    `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='siton' AND p.proname IN ('audit_row_written_in_tx','outbox_row_written_in_tx','row_xmin_is_current_tx')`
  );
  const helperSignatures = new Set(perRowHelpers.rows.map((row: any) => `${row.proname}(${String(row.args).replace(/\s+/g, " ")})`));
  for (const required of [
    "audit_row_written_in_tx(p_entity_type text, p_entity_id uuid, p_state_type text, p_from_state text, p_to_state text, p_action_name text)",
    "outbox_row_written_in_tx(p_aggregate_type text, p_aggregate_id uuid, p_event_type text)",
    "row_xmin_is_current_tx(p_xmin xid)"
  ]) {
    if (!helperSignatures.has(required)) {
      throw new Error(`database schema drift: per-row enforcement helper ${required} (migration 076) is missing`);
    }
  }

  // Migration 078 (Black-Sky D2/D3) must be live, not merely recorded: the
  // test-action gate lives in a replaced function body and the delete
  // protection in the FK delete actions.
  const actionGate = await db.query(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='siton' AND p.proname='is_valid_action_name'`
  );
  if (actionGate.rows.length !== 1 || !String(actionGate.rows[0].prosrc).includes("siton.allow_test_actions")) {
    throw new Error("database schema drift: is_valid_action_name does not gate test actions (migration 078)");
  }
  const restrictFks = await db.query(
    `SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
     WHERE connamespace='siton'::regnamespace AND contype='f'
       AND conname IN ('participants_deal_id_fkey','payment_attempts_participant_id_fkey','platform_fee_money_events_deal_id_fkey')`
  );
  if (restrictFks.rows.length !== 3 || restrictFks.rows.some((row: any) => row.confdeltype !== "r")) {
    throw new Error("database schema drift: money foreign keys are not ON DELETE RESTRICT (migration 078)");
  }

  // Runtime boundary, checked only where the runtime roles exist (staging /
  // production; a plain local database has none): neither runtime role may
  // DELETE or TRUNCATE money/audit history.
  const runtimePrivileges = await db.query(
    `SELECT r.rolname, t.tbl, t.check_delete,
            has_table_privilege(r.rolname, format('siton.%I', t.tbl), 'DELETE') AS can_delete,
            has_table_privilege(r.rolname, format('siton.%I', t.tbl), 'TRUNCATE') AS can_truncate
     FROM pg_roles r
     CROSS JOIN unnest($1::text[], $2::boolean[]) AS t(tbl, check_delete)
     WHERE r.rolname IN ('siton_web_runtime','siton_worker_runtime')
       AND to_regclass(format('siton.%I', t.tbl)) IS NOT NULL`,
    [RUNTIME_PROTECTED_TABLES.map(([table]) => table), RUNTIME_PROTECTED_TABLES.map(([, checkDelete]) => checkDelete)]
  );
  const privilegeViolations: string[] = [];
  for (const row of runtimePrivileges.rows) {
    if (row.check_delete && row.can_delete) privilegeViolations.push(`${row.rolname} holds DELETE on siton.${row.tbl}`);
    if (row.can_truncate) privilegeViolations.push(`${row.rolname} holds TRUNCATE on siton.${row.tbl}`);
  }
  if (privilegeViolations.length) {
    throw new Error(`database runtime boundary drift: ${privilegeViolations.join("; ")}`);
  }

  const constraints = await db.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE connamespace='siton'::regnamespace`
  );
  const webhookStatus = constraints.rows.find((row: any) => row.conname === "webhook_events_status_check");
  if (!webhookStatus || !String(webhookStatus.definition).includes("processing")) {
    throw new Error("database schema drift: webhook_events_status_check is missing processing");
  }
  const fencedOutbox = constraints.rows.find((row: any) => row.conname === "outbox_processing_requires_fenced_lease");
  if (!fencedOutbox || !String(fencedOutbox.definition).includes("lease_generation >= 1")) {
    throw new Error("database schema drift: outbox processing fencing constraint is missing");
  }
}

export async function assertRequiredTables(db: Db, tables: readonly string[]): Promise<void> {
  const result = await queryRequiredTables(db, tables);
  const present = new Set(result.rows.map((row: any) => String(row.table_name)));
  const missing = tables.filter((table) => !present.has(table));
  if (missing.length) throw new Error(`database migrations are incomplete: missing ${missing.join(", ")}`);
}
