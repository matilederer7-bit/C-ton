import { assertRequiredTables } from "./schema_contract.js";
import { randomUUID } from "crypto";
import { createAdminControlFlag, releaseAdminControlFlag, isAdminFlagScopeType, type AdminFlagScopeType } from "./admin_intervention.js";

export const ADMIN_SAFE_ACTION_TYPES = [
  "trigger_reconcile",
  "requeue_outbox_event",
  "retry_notification",
  "retry_invoice_failed",
  "freeze_payouts",
  "unfreeze_payouts",
  "open_support_case",
  "content_takedown_request",
  "pause_joining_emergency",
  "pause_charging_emergency"
] as const;

export const ADMIN_ACTION_STATUSES = [
  "Requested",
  "AwaitingSecondApproval",
  "Approved",
  "Rejected",
  "Executing",
  "Completed",
  "Failed",
  "Cancelled"
] as const;

export const ADMIN_ACTION_TARGET_TYPES = [
  "deal",
  "participant",
  "payment",
  "invoice",
  "payout",
  "webhook",
  "outbox",
  "seller",
  "support_case",
  "content",
  "system"
] as const;

const FORBIDDEN_ACTIONS = new Set([
  "manual_capture",
  "manual_refund",
  "admin_refund",
  "merchant_refund",
  "seller_refund",
  "support_refund",
  "partial_refund",
  "manual_credit",
  "manual_void",
  "manual_state_edit",
  "manual_money_state_edit",
  "manual_buyer_state_edit",
  "manual_db_patch",
  "delete_webhook",
  "delete_outbox",
  "delete_audit",
  "clear_dlq_without_repair",
  "mark_payment_success_manual",
  "mark_deal_completed_manual",
  "edit_amount",
  "edit_platform_fee",
  "edit_seller_net",
  "edit_product_eligibility"
]);

const parsedAdminOutboxMaxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS || 4);
const ADMIN_OUTBOX_MAX_ATTEMPTS = Number.isSafeInteger(parsedAdminOutboxMaxAttempts) && parsedAdminOutboxMaxAttempts >= 1
  ? parsedAdminOutboxMaxAttempts
  : 4;

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

let ensurePromise: Promise<void> | null = null;

export function safeHeaderId(raw: unknown, prefix: string) {
  const text = String(raw || "").trim();
  if (/^[A-Za-z0-9._:-]{8,160}$/.test(text)) return text;
  return `${prefix}:${randomUUID()}`;
}

export function adminRequestContext(req: any) {
  return {
    request_id: String(req.request_id || req.requestId || req.headers?.["x-request-id"] || "").trim(),
    correlation_id: String(req.correlation_id || req.correlationId || req.headers?.["x-correlation-id"] || "").trim(),
    admin_id: String(req.headers?.["x-admin-user"] || "admin").trim().slice(0, 120) || "admin"
  };
}

export function isForbiddenAdminAction(actionType: string) {
  return FORBIDDEN_ACTIONS.has(actionType);
}

export function isSafeActionType(actionType: string): actionType is typeof ADMIN_SAFE_ACTION_TYPES[number] {
  return (ADMIN_SAFE_ACTION_TYPES as readonly string[]).includes(actionType);
}

export function isTargetType(targetType: string): targetType is typeof ADMIN_ACTION_TARGET_TYPES[number] {
  return (ADMIN_ACTION_TARGET_TYPES as readonly string[]).includes(targetType);
}

export function actionRequiresSecondApproval(actionType: string, targetType: string) {
  return (
    actionType === "pause_charging_emergency" ||
    actionType === "unfreeze_payouts" ||
    (actionType === "freeze_payouts" && ["payout", "seller", "deal"].includes(targetType))
  );
}

export function mapAdminTargetToFlagScope(targetType: string, flagType: string): AdminFlagScopeType | null {
  // Each flag type allows a closed set of scopes. Fail closed so a typo cannot
  // create a flag with an unintended blast radius.
  if (flagType === "pause_joining_emergency") {
    if (targetType === "deal") return "deal";
    if (targetType === "seller") return "seller";
    if (targetType === "system") return "global";
    return null;
  }
  if (flagType === "pause_charging_emergency") {
    if (targetType === "deal") return "deal";
    if (targetType === "seller") return "seller";
    if (targetType === "system") return "global";
    return null;
  }
  if (flagType === "payout_freeze") {
    if (targetType === "payout") return "payout";
    if (targetType === "seller") return "seller";
    if (targetType === "deal") return "deal";
    if (targetType === "system") return "global";
    return null;
  }
  if (flagType === "content_takedown") {
    if (targetType === "deal") return "deal";
    if (targetType === "content") return "content";
    if (targetType === "seller") return "seller";
    return null;
  }
  if (isAdminFlagScopeType(targetType)) return targetType;
  return null;
}

export async function ensureAdminControlPlaneTables(withTx: <T>(fn: (c: any) => Promise<T>) => Promise<T>) {
  await withTx(async c=>assertRequiredTables(c,["admin_actions"]));
}

export async function insertAdminAction(c: Queryable, input: {
  action_type: string;
  target_type: string;
  target_id: string;
  reason: string;
  idempotency_key: string;
  metadata?: Record<string, unknown>;
  request_id: string;
  correlation_id: string;
  admin_id: string;
}) {
  const requires = actionRequiresSecondApproval(input.action_type, input.target_type);
  const status = requires ? "AwaitingSecondApproval" : "Requested";
  const result = await c.query(
    `INSERT INTO siton.admin_actions
       (action_type, status, target_type, target_id, requested_by_admin_id, reason,
        correlation_id, request_id, idempotency_key, requires_second_approval, metadata_jsonb)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (action_type, target_type, target_id, idempotency_key)
     DO UPDATE SET updated_at=siton.admin_actions.updated_at
     RETURNING *`,
    [
      input.action_type,
      status,
      input.target_type,
      input.target_id,
      input.admin_id,
      input.reason,
      input.correlation_id,
      input.request_id,
      input.idempotency_key,
      requires,
      JSON.stringify(input.metadata || {})
    ]
  );
  return result.rows[0];
}

export async function executeAdminAction(c: Queryable, actionId: string, context: { admin_id: string; request_id: string; correlation_id: string }) {
  const locked = await c.query(`SELECT * FROM siton.admin_actions WHERE admin_action_id=$1 FOR UPDATE`, [actionId]);
  if (!locked.rowCount) return { statusCode: 404, body: { ok: false, error: "admin_action_not_found" } };
  const action = locked.rows[0];
  if (action.status === "Completed") return { statusCode: 200, body: { ok: true, replay: true, action } };
  if (action.status === "Failed") return { statusCode: 409, body: { ok: false, error: "admin_action_failed_requires_new_action", action } };
  if (action.requires_second_approval && action.status !== "Approved") {
    return { statusCode: 403, body: { ok: false, error: "second_approval_required", action } };
  }

  await c.query(`UPDATE siton.admin_actions SET status='Executing', updated_at=now() WHERE admin_action_id=$1`, [actionId]);
  let resultCode = "NotImplemented";
  let resultMessage = "הפעולה תועדה אך אין worker/מסילה בטוחה לביצוע אוטומטי בשלב זה.";
  let completed = false;

  if (action.action_type === "requeue_outbox_event") {
    const upd = await c.query(
      `WITH eligible AS (
         SELECT event_uuid, status AS from_status, attempt_count, lease_generation
         FROM siton.outbox_events
         WHERE event_uuid::text=$1
           AND status IN ('pending','failed')
           AND sent=false AND sent_at IS NULL
           AND attempt_count < LEAST(max_attempts,$6)
         FOR UPDATE
       ), requeued AS (
         UPDATE siton.outbox_events o
         SET status='pending', sent=false, sent_at=NULL, available_at=clock_timestamp(), processing_started_at=NULL,
             claimed_at=NULL, lease_expires_at=NULL, worker_id=NULL, last_heartbeat_at=NULL,
             lease_generation=o.lease_generation+1,
             correlation_id=COALESCE(o.correlation_id,$2), request_id=COALESCE(o.request_id,$3),
             updated_at=clock_timestamp()
         FROM eligible e
         WHERE o.event_uuid=e.event_uuid
         RETURNING o.event_uuid, e.from_status, o.attempt_count, o.lease_generation
       ), audited AS (
         INSERT INTO siton.operational_recovery_audit (
           subject_type, subject_id, action, worker_id, lease_generation, attempt_count,
           from_status, to_status, idempotency_key, reason_code, metadata
         )
         SELECT 'outbox_event', event_uuid::text, 'retry', $4, lease_generation, attempt_count,
                from_status, 'pending', $5, 'admin_requeue', '{}'::jsonb
         FROM requeued
         RETURNING subject_id
       )
       SELECT event_uuid FROM requeued
       WHERE event_uuid::text IN (SELECT subject_id FROM audited)`,
      [
        action.target_id,
        action.correlation_id || context.correlation_id,
        context.request_id,
        "admin:" + context.admin_id,
        "admin-action:" + actionId + ":outbox-retry",
        ADMIN_OUTBOX_MAX_ATTEMPTS
      ]
    );
    completed = (upd.rowCount ?? 0) > 0;
    resultCode = completed ? "Requeued" : "NoEligibleOutboxEvent";
    resultMessage = completed ? "אירוע outbox הוחזר ל-pending ללא מחיקה וללא איפוס היסטוריה." : "לא נמצא אירוע outbox מתאים או שהאירוע כבר הסתיים.";
  } else if (action.action_type === "retry_notification") {
    const upd = await c.query(
      `UPDATE siton.notification_events
       SET status='pending', scheduled_for=now(), last_error=NULL,
           correlation_id=COALESCE(correlation_id,$2), request_id=COALESCE(request_id,$3), updated_at=now()
       WHERE notification_id::text=$1 AND status='failed'
       RETURNING notification_id`,
      [action.target_id, action.correlation_id || context.correlation_id, context.request_id]
    );
    completed = (upd.rowCount ?? 0) > 0;
    resultCode = completed ? "NotificationRetryQueued" : "NoFailedNotification";
    resultMessage = completed ? "Notification failed הוחזר לתור retry." : "לא נמצאה הודעה failed מתאימה או שהיא כבר נשלחה.";
  } else if (action.action_type === "retry_invoice_failed") {
    const upd = await c.query(
      `UPDATE siton.invoice_documents
       SET status='pending', document_status='pending', available_at=now(),
           correlation_id=COALESCE(correlation_id,$2), updated_at=now()
       WHERE document_id::text=$1 AND status='failed' AND provider_document_id IS NULL
       RETURNING document_id`,
      [action.target_id, action.correlation_id || context.correlation_id]
    );
    completed = (upd.rowCount ?? 0) > 0;
    resultCode = completed ? "InvoiceRetryQueued" : "NoSafeFailedInvoice";
    resultMessage = completed ? "מסמך failed ללא provider ref הוחזר ל-pending." : "לא נמצא מסמך failed בטוח ל-retry, או שכבר קיים provider ref.";
  } else if (action.action_type === "freeze_payouts") {
    const scopeType = mapAdminTargetToFlagScope(action.target_type, "payout_freeze");
    if (!scopeType) {
      resultCode = "InvalidFreezeScope";
      resultMessage = "scope לא נתמך לחסימת payout. נדרש payout/seller/deal/global.";
    } else {
      const flag = await createAdminControlFlag(c, {
        flag_type: "payout_freeze",
        scope_type: scopeType,
        scope_id: action.target_id,
        reason: action.reason,
        admin_action_id: action.admin_action_id,
        request_id: context.request_id,
        correlation_id: action.correlation_id || context.correlation_id,
        requested_by_admin_id: action.requested_by_admin_id,
        approved_by_admin_id: action.approved_by_admin_id,
        metadata: { admin_action_id: action.admin_action_id }
      }).catch((err: any) => { resultCode = "FreezeRejected"; resultMessage = String(err?.code || err?.message || "freeze_failed"); return null; });
      if (flag) {
        completed = true;
        resultCode = "PayoutFreezeRecorded";
        resultMessage = `הקפאת payout פעילה ב-scope ${scopeType}:${action.target_id}. לא בוצעה תנועת כסף.`;
      }
    }
  } else if (action.action_type === "unfreeze_payouts") {
    const scopeType = mapAdminTargetToFlagScope(action.target_type, "payout_freeze");
    if (!scopeType) {
      resultCode = "InvalidFreezeScope";
      resultMessage = "scope לא נתמך לשחרור payout. נדרש payout/seller/deal/global.";
    } else {
      const result = await c.query(
        `SELECT flag_id FROM siton.admin_control_flags
         WHERE flag_type='payout_freeze' AND status='active'
           AND scope_type=$1 AND scope_id=$2
         ORDER BY created_at DESC LIMIT 1`,
        [scopeType, action.target_id]
      );
      if (!result.rowCount) {
        resultCode = "NoActivePayoutFreeze";
        resultMessage = "לא נמצא flag פעיל של הקפאת payout עבור scope זה.";
      } else {
        const released = await releaseAdminControlFlag(c, String(result.rows[0].flag_id), {
          released_by_admin_id: action.approved_by_admin_id || action.requested_by_admin_id || "admin",
          released_reason: action.reason,
          request_id: context.request_id,
          correlation_id: action.correlation_id || context.correlation_id
        });
        completed = Boolean(released);
        resultCode = completed ? "PayoutFreezeReleased" : "PayoutFreezeReleaseFailed";
        resultMessage = completed
          ? `הקפאת payout שוחררה ב-scope ${scopeType}:${action.target_id}. לא בוצעה תנועת כסף.`
          : "שחרור flag הקפאה נכשל.";
      }
    }
  } else if (action.action_type === "pause_joining_emergency" || action.action_type === "pause_charging_emergency") {
    const flagType = action.action_type as "pause_joining_emergency" | "pause_charging_emergency";
    const scopeType = mapAdminTargetToFlagScope(action.target_type, flagType);
    const expiresAtRaw = action.metadata_jsonb?.expires_at || action.metadata_jsonb?.pause_expires_at || null;
    if (!scopeType) {
      resultCode = "InvalidPauseScope";
      resultMessage = "scope לא נתמך להשהיה. נדרש deal/seller/global.";
    } else if (!expiresAtRaw) {
      resultCode = "PauseExpiresAtRequired";
      resultMessage = "השהיית חירום חייבת expires_at ב-metadata. אין להשאיר השהיה ללא תאריך תפוגה.";
    } else {
      const flag = await createAdminControlFlag(c, {
        flag_type: flagType,
        scope_type: scopeType,
        scope_id: action.target_id,
        reason: action.reason,
        expires_at: new Date(expiresAtRaw),
        admin_action_id: action.admin_action_id,
        request_id: context.request_id,
        correlation_id: action.correlation_id || context.correlation_id,
        requested_by_admin_id: action.requested_by_admin_id,
        approved_by_admin_id: action.approved_by_admin_id,
        metadata: { admin_action_id: action.admin_action_id, source_action: action.action_type }
      }).catch((err: any) => { resultCode = "PauseRejected"; resultMessage = String(err?.code || err?.message || "pause_failed"); return null; });
      if (flag) {
        completed = true;
        resultCode = flagType === "pause_joining_emergency" ? "PauseJoiningRecorded" : "PauseChargingRecorded";
        resultMessage = flagType === "pause_joining_emergency"
          ? `השהיית הצטרפויות פעילה ב-scope ${scopeType}:${action.target_id}. קונים קיימים אינם מושפעים.`
          : `השהיית charging פעילה ב-scope ${scopeType}:${action.target_id}. workers בודקים את ה-flag לפני ביצוע.`;
      }
    }
  } else if (action.action_type === "content_takedown_request") {
    const scopeType = mapAdminTargetToFlagScope(action.target_type, "content_takedown");
    if (!scopeType) {
      resultCode = "InvalidContentScope";
      resultMessage = "scope לא נתמך להסתרת תוכן.";
    } else {
      const flag = await createAdminControlFlag(c, {
        flag_type: "content_takedown",
        scope_type: scopeType,
        scope_id: action.target_id,
        reason: action.reason,
        admin_action_id: action.admin_action_id,
        request_id: context.request_id,
        correlation_id: action.correlation_id || context.correlation_id,
        requested_by_admin_id: action.requested_by_admin_id,
        approved_by_admin_id: action.approved_by_admin_id,
        metadata: { admin_action_id: action.admin_action_id }
      }).catch((err: any) => { resultCode = "ContentTakedownRejected"; resultMessage = String(err?.code || err?.message || "content_takedown_failed"); return null; });
      if (flag) {
        completed = true;
        resultCode = "ContentTakedownRecorded";
        resultMessage = `התוכן ${scopeType}:${action.target_id} סומן להסתרה. לא בוצעה מחיקה פיזית. CDN purge בנפרד אם קיים contract.`;
      }
    }
  } else if (action.action_type === "trigger_reconcile") {
    // No live provider call. Internal dry-run only: open a reconcile support case
    // and surface unknown payment attempts. The caller is responsible for any
    // provider-side reconcile; we never call a live provider here.
    const unknownCount = await c.query(
      `SELECT COUNT(*)::int AS unknowns
       FROM siton.payment_attempts
       WHERE result_class='unknown' AND created_at > now() - interval '7 days'`
    ).catch(() => ({ rows: [{ unknowns: null }] }));
    const autoKey = `admin-action:trigger_reconcile:${action.target_type}:${action.target_id}`;
    const inserted = await c.query(
      `INSERT INTO siton.operational_cases
         (case_type, status, priority, source, subject, description, opened_by, auto_key, correlation_id, request_id)
       VALUES ('PaymentMismatch','Open','High','Admin',$1,$2,$3,$4,$5,$6)
       ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')
       DO UPDATE SET updated_at=siton.operational_cases.updated_at
       RETURNING case_id`,
      [
        `Reconcile dry-run requested for ${action.target_type}:${action.target_id}`,
        `Internal reconcile dry-run. Unknown payment attempts in last 7d: ${unknownCount.rows[0]?.unknowns ?? "unknown"}. No live provider call performed.`,
        context.admin_id,
        autoKey,
        action.correlation_id || context.correlation_id,
        context.request_id
      ]
    ).catch(() => ({ rowCount: 0, rows: [{ case_id: null }] }));
    completed = Boolean(inserted.rows[0]?.case_id);
    resultCode = completed ? "ReconcileDryRunOpened" : "ReconcileDryRunFailed";
    resultMessage = completed
      ? `תיק תמיכה לדריסת reconcile נפתח/קיים: ${inserted.rows[0]?.case_id}. לא בוצעה קריאה לספק חי.`
      : "פתיחת תיק reconcile נכשלה. לא בוצעה קריאה לספק חי.";
  } else if (action.action_type === "open_support_case") {
    const autoKey = `admin-action:${action.action_type}:${action.target_type}:${action.target_id}`;
    const inserted = await c.query(
      `INSERT INTO siton.operational_cases
         (case_type, status, priority, source, subject, description, opened_by, auto_key, correlation_id, request_id)
       VALUES ('SystemException','Open','Normal','Admin',$1,$2,$3,$4,$5,$6)
       ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')
       DO UPDATE SET updated_at=siton.operational_cases.updated_at
       RETURNING case_id`,
      [
        `Admin action follow-up: ${action.target_type}:${action.target_id}`,
        action.reason,
        context.admin_id,
        autoKey,
        action.correlation_id || context.correlation_id,
        context.request_id
      ]
    );
    completed = Boolean(inserted.rows[0]?.case_id);
    resultCode = "SupportCaseOpen";
    resultMessage = `תיק תמיכה קיים או נפתח: ${inserted.rows[0]?.case_id || "unknown"}`;
  }

  const nextStatus = completed ? "Completed" : "Failed";
  const updated = await c.query(
    `UPDATE siton.admin_actions
     SET status=$2,
         executed_at=CASE WHEN $2='Completed' THEN now() ELSE executed_at END,
         failed_at=CASE WHEN $2='Failed' THEN now() ELSE failed_at END,
         result_code=$3,
         result_message=$4,
         result_jsonb=$5,
         updated_at=now()
     WHERE admin_action_id=$1
     RETURNING *`,
    [actionId, nextStatus, resultCode, resultMessage, JSON.stringify({ completed, executor: context.admin_id })]
  );
  return { statusCode: completed ? 200 : 501, body: { ok: completed, action: updated.rows[0] } };
}
