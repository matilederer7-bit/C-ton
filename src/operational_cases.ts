import { assertRequiredTables } from "./schema_contract.js";
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
  await withTx(async c=>assertRequiredTables(c,["operational_cases","operational_case_events","support_case_messages"]));
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
      ORDER BY d.created_at DESC
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
