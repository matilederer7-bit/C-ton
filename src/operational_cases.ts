type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export const OPERATIONAL_CASE_TYPES = [
  "RefundRequest",
  "DeliveryIssue",
  "SellerRisk",
  "BuyerComplaint",
  "PaymentMismatch",
  "InvoiceIssue",
  "ContentReport",
  "SystemException",
  "Other"
] as const;

export const OPERATIONAL_CASE_STATUSES = [
  "Open",
  "NeedsSeller",
  "NeedsAdmin",
  "WaitingExternal",
  "Resolved",
  "Closed"
] as const;

export const OPERATIONAL_CASE_PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const;
export const OPERATIONAL_CASE_SOURCES = ["Admin", "Buyer", "Seller", "System"] as const;
export const OPEN_OPERATIONAL_CASE_STATUSES = ["Open", "NeedsSeller", "NeedsAdmin", "WaitingExternal"] as const;

export type OperationalCaseType = typeof OPERATIONAL_CASE_TYPES[number];
export type OperationalCaseStatus = typeof OPERATIONAL_CASE_STATUSES[number];
export type OperationalCasePriority = typeof OPERATIONAL_CASE_PRIORITIES[number];
export type OperationalCaseSource = typeof OPERATIONAL_CASE_SOURCES[number];

export function isOperationalCaseType(value: unknown): value is OperationalCaseType {
  return OPERATIONAL_CASE_TYPES.includes(String(value || "") as OperationalCaseType);
}

export function isOperationalCaseStatus(value: unknown): value is OperationalCaseStatus {
  return OPERATIONAL_CASE_STATUSES.includes(String(value || "") as OperationalCaseStatus);
}

export function isOperationalCasePriority(value: unknown): value is OperationalCasePriority {
  return OPERATIONAL_CASE_PRIORITIES.includes(String(value || "") as OperationalCasePriority);
}

export function isOperationalCaseSource(value: unknown): value is OperationalCaseSource {
  return OPERATIONAL_CASE_SOURCES.includes(String(value || "") as OperationalCaseSource);
}

export function operationalCaseEventAction(action: string) {
  return `case.${action}`;
}

export async function ensureOperationalCaseTables(withTx: WithTx) {
  await withTx(async (c) => {
    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.operational_cases (
        case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_type TEXT NOT NULL CHECK (case_type IN (
          'RefundRequest',
          'DeliveryIssue',
          'SellerRisk',
          'BuyerComplaint',
          'PaymentMismatch',
          'InvoiceIssue',
          'ContentReport',
          'SystemException',
          'Other'
        )),
        status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN (
          'Open',
          'NeedsSeller',
          'NeedsAdmin',
          'WaitingExternal',
          'Resolved',
          'Closed'
        )),
        priority TEXT NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low','Normal','High','Urgent')),
        source TEXT NOT NULL DEFAULT 'Admin' CHECK (source IN ('Admin','Buyer','Seller','System')),
        deal_id UUID NULL,
        seller_id TEXT NULL,
        participant_id UUID NULL,
        buyer_ref TEXT NULL,
        opened_by TEXT NULL,
        assigned_to TEXT NULL,
        subject TEXT NOT NULL,
        description TEXT NULL,
        resolution_note TEXT NULL,
        auto_key TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ NULL,
        CONSTRAINT operational_cases_close_note_check
          CHECK (status NOT IN ('Resolved','Closed') OR NULLIF(btrim(COALESCE(resolution_note,'')), '') IS NOT NULL)
      )
    `);

    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS seller_id TEXT NULL`);
    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS buyer_ref TEXT NULL`);
    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS opened_by TEXT NULL`);
    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS assigned_to TEXT NULL`);
    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS description TEXT NULL`);
    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS resolution_note TEXT NULL`);
    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS auto_key TEXT NULL`);
    await c.query(`ALTER TABLE siton.operational_cases ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NULL`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.operational_case_events (
        event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id UUID NOT NULL REFERENCES siton.operational_cases(case_id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'case.create',
          'case.update_status',
          'case.assign',
          'case.close',
          'case.escalate',
          'case.refund_request_marked'
        )),
        actor_ref TEXT NOT NULL DEFAULT 'admin',
        reason TEXT NOT NULL DEFAULT '',
        from_status TEXT NULL,
        to_status TEXT NULL,
        from_priority TEXT NULL,
        to_priority TEXT NULL,
        request_id TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_cases_status_priority_created
      ON siton.operational_cases (status, priority, created_at)
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_cases_type_status
      ON siton.operational_cases (case_type, status)
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_cases_deal
      ON siton.operational_cases (deal_id)
      WHERE deal_id IS NOT NULL
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_cases_seller
      ON siton.operational_cases (seller_id)
      WHERE seller_id IS NOT NULL
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_cases_participant
      ON siton.operational_cases (participant_id)
      WHERE participant_id IS NOT NULL
    `);
    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_operational_cases_open_auto_key
      ON siton.operational_cases (auto_key)
      WHERE auto_key IS NOT NULL AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_case_events_case_created
      ON siton.operational_case_events (case_id, created_at DESC)
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_case_events_type_created
      ON siton.operational_case_events (event_type, created_at DESC)
    `);
  });
}

export async function recordOperationalCaseEvent(c: any, args: {
  caseId: string;
  eventType: string;
  actorRef?: string | null;
  reason?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  fromPriority?: string | null;
  toPriority?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
  payload?: Record<string, unknown>;
}) {
  await c.query(
    `INSERT INTO siton.operational_case_events
       (case_id, event_type, actor_ref, reason, from_status, to_status,
        from_priority, to_priority, request_id, idempotency_key, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      args.caseId,
      args.eventType,
      args.actorRef || "admin",
      args.reason || "",
      args.fromStatus || null,
      args.toStatus || null,
      args.fromPriority || null,
      args.toPriority || null,
      args.requestId || "",
      args.idempotencyKey || "",
      JSON.stringify(args.payload || {})
    ]
  );
}

export async function ensureAutomaticOperationalCases(withTx: WithTx) {
  await ensureOperationalCaseTables(withTx);
  await withTx(async (c) => {
    const completedWithoutCharges = await c.query(`
      SELECT d.deal_id, COALESCE(d.seller_id, '') AS seller_id, d.title
      FROM siton.deals d
      WHERE d.state='Completed'
        AND NOT EXISTS (
          SELECT 1
          FROM siton.participants p
          WHERE p.deal_id=d.deal_id
            AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
        )
      LIMIT 50
    `);
    for (const row of completedWithoutCharges.rows) {
      const autoKey = `completed_without_charged_success:${row.deal_id}`;
      const inserted = await c.query(
        `INSERT INTO siton.operational_cases
           (case_type, status, priority, source, deal_id, seller_id, subject, description, auto_key)
         VALUES ('PaymentMismatch','Open','High','System',$1,NULLIF($2,''),$3,$4,$5)
         ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')
         DO NOTHING
         RETURNING case_id`,
        [
          row.deal_id,
          row.seller_id || "",
          "Completed deal without a charged participant",
          `Deal ${row.title || row.deal_id} is Completed but has zero ChargedSuccess/RecoveredCharge participants.`,
          autoKey
        ]
      );
      if (inserted.rowCount) {
        await recordOperationalCaseEvent(c, {
          caseId: String(inserted.rows[0].case_id),
          eventType: "case.create",
          actorRef: "system",
          payload: { auto_key: autoKey, source_exception: "completed_without_charged_success" }
        });
      }
    }

    const invoiceFailures = await c.query(`
      SELECT DISTINCT deal_id, participant_id, last_error
      FROM siton.invoice_documents
      WHERE status='failed'
      LIMIT 50
    `).catch(() => ({ rows: [] }));
    for (const row of invoiceFailures.rows) {
      const dealId = row.deal_id ? String(row.deal_id) : null;
      const participantId = row.participant_id ? String(row.participant_id) : null;
      const autoKey = `invoice_issue:${dealId || "none"}:${participantId || "none"}`;
      const inserted = await c.query(
        `INSERT INTO siton.operational_cases
           (case_type, status, priority, source, deal_id, participant_id, subject, description, auto_key)
         VALUES ('InvoiceIssue','Open','Normal','System',$1,$2,$3,$4,$5)
         ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')
         DO NOTHING
         RETURNING case_id`,
        [
          dealId,
          participantId,
          "Invoice issuance failure",
          `Invoice document failed and needs operational review. ${row.last_error || ""}`.trim(),
          autoKey
        ]
      );
      if (inserted.rowCount) {
        await recordOperationalCaseEvent(c, {
          caseId: String(inserted.rows[0].case_id),
          eventType: "case.create",
          actorRef: "system",
          payload: { auto_key: autoKey, source_exception: "invoice_issue" }
        });
      }
    }
  });
}
