type Db = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
};

export const REQUIRED_TABLES = [
  "deals", "participants", "audit_log", "idempotency_log", "outbox_events", "outbox_dlq",
  "payment_attempts", "webhook_events", "seller_accounts", "seller_sessions",
  "affiliate_accounts", "affiliate_attributions", "support_tickets", "deal_delivery_options",
  "deal_images", "deal_chat_messages", "notification_events", "notification_attempts",
  "legal_acceptances", "otp_challenges", "otp_delivery_attempts", "invoice_documents",
  "invoice_document_attempts", "invoice_reconciliation_cases", "platform_fee_money_events",
  "seller_settlements", "seller_payout_batches", "seller_payout_batch_items",
  "seller_payout_attempts", "seller_payout_reconciliation_cases", "admin_actions",
  "admin_users", "admin_sessions", "admin_mfa_factors", "admin_mfa_challenges",
  "participant_tracking_tokens", "admin_control_flags", "admin_control_flag_events",
  "storage_orphan_reports", "operational_cases", "operational_case_events",
  "deal_voucher_terms", "deal_ticket_terms", "fulfillment_units", "migration_ledger"
] as const;

export const REQUIRED_MIGRATION_IDS = [
  "014", "007", "008", "009", "010", "011", "012", "013", "014a", "015a", "015b",
  "016", "017", "018", "019", "020", "021", "022", "023", "024", "025", "026",
  "027", "028", "029", "030", "031", "032", "033", "034", "035", "036", "037", "038", "039"
] as const;

export async function assertDatabaseSchema(db: Db): Promise<void> {
  const ledger = await db.query(
    `SELECT migration_id, status FROM siton.migration_ledger ORDER BY position`
  ).catch(() => null);
  if (!ledger) throw new Error("database schema is not migrated: siton.migration_ledger is missing");
  const failed = ledger.rows.find((row: any) => row.status !== "succeeded");
  if (failed) throw new Error(`database migrations are incomplete at ${failed.migration_id}`);
  const applied = new Set(ledger.rows.map((row: any) => String(row.migration_id)));
  const missingMigrations = REQUIRED_MIGRATION_IDS.filter((id) => !applied.has(id));
  if (missingMigrations.length) throw new Error(`database migrations are incomplete: missing ${missingMigrations.join(", ")}`);

  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='siton' AND table_type='BASE TABLE'`
  );
  const present = new Set(tables.rows.map((row: any) => String(row.table_name)));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`database schema drift: missing tables ${missing.join(", ")}; run migrations`);
  }

  const requiredTriggers = [
    "trg_deals_before_update_enforce",
    "trg_participants_before_update_enforce",
    "trg_audit_log_before_insert_enforce",
    "trg_audit_log_append_only_update",
    "trg_audit_log_append_only_delete",
    "trg_deals_outbox_enforce"
  ];
  const triggers = await db.query(
    `SELECT tgname FROM pg_trigger t
     JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='siton' AND NOT t.tgisinternal`
  );
  const triggerSet = new Set(triggers.rows.map((row: any) => String(row.tgname)));
  const missingTriggers = requiredTriggers.filter((name) => !triggerSet.has(name));
  if (missingTriggers.length) {
    throw new Error(`database schema drift: missing triggers ${missingTriggers.join(", ")}`);
  }

  const constraints = await db.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE connamespace='siton'::regnamespace`
  );
  const webhookStatus = constraints.rows.find((row: any) => row.conname === "webhook_events_status_check");
  if (!webhookStatus || !String(webhookStatus.definition).includes("processing")) {
    throw new Error("database schema drift: webhook_events_status_check is missing processing");
  }
}

export async function assertRequiredTables(db: Db, tables: readonly string[]): Promise<void> {
  const result = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='siton' AND table_name = ANY($1::text[])`,
    [tables]
  );
  const present = new Set(result.rows.map((row: any) => String(row.table_name)));
  const missing = tables.filter((table) => !present.has(table));
  if (missing.length) throw new Error(`database migrations are incomplete: missing ${missing.join(", ")}`);
}
