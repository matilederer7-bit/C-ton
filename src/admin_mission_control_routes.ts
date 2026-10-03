// ADMIN MISSION CONTROL — read-only operational routes.
//
// Lean Refactor round 2: the seven GET routes below were moved verbatim out of
// src/frontend_runtime.ts. Nothing about them changed: same paths, same
// requireAdminRead guard, same validation, same schema checks, same SQL, same
// builders in src/admin_mission_control.ts, same response shapes and the same
// read-only action policy. The runtime hands this module exactly the closures
// it used before (dependency injection); no helper was copied.
import type { FastifyInstance } from "fastify";
import { join } from "path";
import {
  buildAdminMissionControlPayload,
  buildMissionCorrelationTrace,
  buildMissionDealTrace,
  buildMissionOutboxTrace,
  buildMissionParticipantTrace,
  buildMissionWebhookTrace
} from "./admin_mission_control.js";
import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";
import { getPayoutProviderSummary, type PayoutProvider } from "./payout_provider.js";
import { DEFAULT_SELLER_ID } from "./product_surface_support.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;
type SchemaCheck = () => Promise<void>;

export type AdminMissionControlRouteDeps = {
  withTx: WithTx;
  /** The runtime's admin READ guard (named admin identity or the ops key). Owns the denial response. */
  requireAdminRead: (req: any, reply: any) => Promise<boolean>;
  /** The runtime's uuid validator: throws a 400 error for a malformed id. */
  requireUuid: (value: string, fieldName: string) => void;
  ensureProductSurfaces: SchemaCheck;
  ensurePayoutTables: SchemaCheck;
  ensureNotificationTables: SchemaCheck;
  ensureLegalAcceptanceTables: SchemaCheck;
  ensureInvoiceWebhookTables: SchemaCheck;
  ensurePaymentOpsTables: SchemaCheck;
  ensureAdminControlPlane: SchemaCheck;
  /** The served legacy frontend directory; the Mission Control builder probes `join(frontendDir, "..")`. */
  frontendDir: string;
  payoutProvider: PayoutProvider;
  paymentProvider: PaymentProvider;
  deploymentMode: string;
  isDemoPreview: boolean;
  invoiceSummary?: Record<string, any> | undefined;
  notificationSummary: {
    provider: string;
    mode: string;
    external_delivery: boolean;
  };
  debugSurfacesEnabled?: boolean | undefined;
  getWorkerRunning?: (() => boolean) | undefined;
};

export function registerAdminMissionControlRoutes(app: FastifyInstance, deps: AdminMissionControlRouteDeps) {
  const {
    requireAdminRead,
    requireUuid,
    ensureProductSurfaces,
    ensurePayoutTables,
    ensureNotificationTables,
    ensureLegalAcceptanceTables,
    ensureInvoiceWebhookTables,
    ensurePaymentOpsTables,
    ensureAdminControlPlane,
    frontendDir,
    payoutProvider
  } = deps;

  app.get("/api/admin/mission-control", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const q = String(req.query?.q || "").trim().slice(0, 200);
    await ensureProductSurfaces();
    await ensurePayoutTables();
    await ensureNotificationTables();
    await ensureLegalAcceptanceTables();
    await ensureInvoiceWebhookTables();
    await ensurePaymentOpsTables();
    await ensureAdminControlPlane();

    return deps.withTx(async (c) => {
      const [
        systemCounts,
        exceptionalDeals,
        searchRows,
        kycQueue,
        payoutRows,
        supportRows,
        auditRows,
        dealStateCounts
      ] = await Promise.all([
        c.query(
          `SELECT
             (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
             (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status='failed') AS failed_outbox,
             (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status IN ('pending','processing')) AS active_outbox,
             (SELECT COUNT(*)::int FROM siton.notification_events WHERE status='failed') AS failed_notifications,
             (SELECT COUNT(*)::int FROM siton.notification_events WHERE status IN ('pending','processing')) AS active_notifications,
             (SELECT COUNT(*)::int FROM siton.invoice_documents WHERE status='failed') AS failed_invoice_documents,
             (SELECT COUNT(*)::int FROM siton.outbox_events WHERE event_type='invoice_document_reconcile' AND status IN ('pending','processing')) AS active_reconcile,
             (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
             (SELECT COUNT(*)::int FROM siton.payment_attempts WHERE result_class IN ('temporary_fail','permanent_fail') AND created_at > now() - interval '1 hour') AS payment_failures_last_hour,
             (SELECT COUNT(*)::int FROM siton.seller_payout_batches WHERE payout_status IN ('failed','returned')) AS payout_exceptions,
             (SELECT COUNT(*)::int FROM siton.seller_payout_batches WHERE payout_status IN ('ready','batched','processing')) AS active_payout_batches,
             (SELECT COUNT(*)::int FROM siton.support_tickets WHERE status <> 'resolved') AS open_support_tickets,
             (SELECT COUNT(*)::int
              FROM siton.deals d
              WHERE d.state='Completed'
                AND NOT EXISTS (
                  SELECT 1 FROM siton.participants p
                  WHERE p.deal_id=d.deal_id
                    AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
                )) AS completed_without_charged_success,
             (SELECT COUNT(*)::int
              FROM siton.deals
              WHERE state='CompletionWindow'
                AND completion_window_until IS NOT NULL
                AND completion_window_until <= now() + interval '1 hour') AS completion_window_ending_soon,
             (SELECT COUNT(*)::int
              FROM siton.deals
              WHERE state='PendingTarget'
                AND deadline <= now() + interval '6 hours') AS pending_target_near_deadline`
        ),
        c.query(
          `SELECT
             d.deal_id::text,
             d.title,
             d.state,
             COALESCE(d.seller_id, $1) AS seller_id,
             COALESCE(sa.business_name, sa.display_name, d.seller_id, $1) AS seller_name,
             d.min_units,
             d.max_units,
             d.deadline,
             d.completion_window_until,
             d.updated_at,
             COALESCE(SUM(p.qty),0)::int AS target_units,
             COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
             COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('AuthHeld','AuthLocked','ChargeAttempt','ChargeFailedRecovery')),0)::int AS pending_units,
             COALESCE(SUM(p.qty) FILTER (WHERE p.money_state NOT IN ('ChargedSuccess','RecoveredCharge')),0)::int AS not_charged_units,
             COALESCE(SUM((p.qty * d.price_per_unit) + COALESCE(p.delivery_cost,0)) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric AS gross_amount,
             CASE
               WHEN d.state='CompletionWindow' AND d.completion_window_until <= now() + interval '1 hour' THEN 'completion_window_ending_soon'
               WHEN d.state='Charging' THEN 'charging_in_progress'
               WHEN d.state='Failed' THEN 'deal_failed'
               WHEN d.state='Completed' AND COUNT(p.participant_id) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')) = 0 THEN 'completed_without_charged_success'
               WHEN d.state='PendingTarget' AND d.deadline <= now() + interval '6 hours' THEN 'pending_target_near_deadline'
               WHEN EXISTS (SELECT 1 FROM siton.seller_payout_batches b WHERE b.trigger_deal_id=d.deal_id AND b.payout_status IN ('failed','returned')) THEN 'payout_exception'
               WHEN EXISTS (SELECT 1 FROM siton.invoice_documents inv WHERE inv.deal_id=d.deal_id AND inv.status='failed') THEN 'invoice_issue_failed'
               ELSE 'operational_attention'
             END AS exception_reason
           FROM siton.deals d
           LEFT JOIN siton.participants p ON p.deal_id=d.deal_id
           LEFT JOIN siton.seller_accounts sa ON sa.seller_id=COALESCE(d.seller_id, $1)
           WHERE d.state IN ('CompletionWindow','Charging','Failed')
              OR (d.state='Completed' AND NOT EXISTS (
                   SELECT 1 FROM siton.participants charged
                   WHERE charged.deal_id=d.deal_id
                     AND charged.money_state IN ('ChargedSuccess','RecoveredCharge')
                 ))
              OR (d.state='PendingTarget' AND d.deadline <= now() + interval '6 hours')
              OR EXISTS (SELECT 1 FROM siton.seller_payout_batches b WHERE b.trigger_deal_id=d.deal_id AND b.payout_status IN ('failed','returned'))
              OR EXISTS (SELECT 1 FROM siton.invoice_documents inv WHERE inv.deal_id=d.deal_id AND inv.status='failed')
           GROUP BY d.deal_id, sa.business_name, sa.display_name
           ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC
           LIMIT 30`,
          [DEFAULT_SELLER_ID]
        ),
        q
          ? c.query(
              `SELECT 'deal' AS entity_type, d.deal_id::text AS entity_id, d.title AS headline, d.state::text AS status,
                      'admin_deal_profile' AS result_kind, '/app/admin/deals/' || d.deal_id::text AS route
               FROM siton.deals d
               WHERE d.deal_id::text ILIKE '%' || $1 || '%' OR d.title ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'participant' AS entity_type, p.participant_id::text AS entity_id, d.title AS headline, p.buyer_state::text AS status,
                      'admin_participant_profile' AS result_kind, '/app/admin/participants/' || p.participant_id::text AS route
               FROM siton.participants p
               JOIN siton.deals d ON d.deal_id=p.deal_id
               WHERE p.participant_id::text ILIKE '%' || $1 || '%'
                  OR p.buyer_id ILIKE '%' || $1 || '%'
                  OR COALESCE(p.buyer_phone,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(p.buyer_email,'') ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'seller' AS entity_type, sa.seller_id AS entity_id, COALESCE(sa.business_name, sa.display_name, sa.seller_id) AS headline,
                      sa.verification_status::text AS status, 'admin_seller_kyc' AS result_kind, '/app/admin' AS route
               FROM siton.seller_accounts sa
               WHERE sa.seller_id ILIKE '%' || $1 || '%'
                  OR COALESCE(sa.business_name,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(sa.support_phone,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(sa.support_email,'') ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'support_ticket' AS entity_type, st.ticket_id::text AS entity_id, st.title AS headline, st.status,
                      'admin_support_ticket' AS result_kind, '/app/admin' AS route
               FROM siton.support_tickets st
               WHERE st.ticket_id::text ILIKE '%' || $1 || '%'
                  OR st.scope_key ILIKE '%' || $1 || '%'
                  OR st.title ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'invoice_document' AS entity_type, inv.document_id::text AS entity_id, inv.document_key AS headline, inv.status,
                      'admin_invoice_document' AS result_kind, '/app/admin/deals/' || inv.deal_id::text AS route
               FROM siton.invoice_documents inv
               WHERE inv.document_id::text ILIKE '%' || $1 || '%'
                  OR inv.document_key ILIKE '%' || $1 || '%'
                  OR COALESCE(inv.provider_document_id,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(inv.correlation_id,'') ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'payout_batch' AS entity_type, b.payout_batch_id::text AS entity_id, b.seller_id AS headline, b.payout_status AS status,
                      'admin_payout_batch' AS result_kind, '/app/admin' AS route
               FROM siton.seller_payout_batches b
               WHERE b.payout_batch_id::text ILIKE '%' || $1 || '%'
               ORDER BY entity_type, headline
               LIMIT 40`,
              [q]
            )
          : { rows: [] },
        c.query(
          `SELECT
             seller_id,
             COALESCE(business_name, display_name, seller_id) AS seller_name,
             verification_status,
             settlement_status,
             created_at,
             updated_at,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN NULLIF(btrim(COALESCE(business_name,'')), '') IS NULL THEN 'business_name' END,
               CASE WHEN NULLIF(btrim(COALESCE(support_email,'')), '') IS NULL AND NULLIF(btrim(COALESCE(support_phone,'')), '') IS NULL THEN 'support_contact' END
             ], NULL) AS missing_fields
           FROM siton.seller_accounts
           WHERE verification_status <> 'approved'
              OR settlement_status <> 'active'
              OR NULLIF(btrim(COALESCE(business_name,'')), '') IS NULL
              OR (NULLIF(btrim(COALESCE(support_email,'')), '') IS NULL AND NULLIF(btrim(COALESCE(support_phone,'')), '') IS NULL)
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 30`
        ),
        c.query(
          `SELECT
             b.payout_batch_id::text,
             b.seller_id,
             b.payout_status,
             b.gross_collected AS gross_amount,
             b.platform_fee_total AS platform_fee_total_amount,
             b.seller_net_payable AS seller_net_amount,
             b.created_at,
             b.updated_at,
             b.trigger_deal_id::text AS deal_id
           FROM siton.seller_payout_batches b
           WHERE b.payout_status IN ('pending','ready','batched','processing','failed','returned')
           ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC
           LIMIT 20`
        ),
        c.query(
          `SELECT ticket_id::text, scope_type, scope_key, title, priority, status, summary, created_at, updated_at
           FROM siton.support_tickets
           WHERE status <> 'resolved'
           ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, updated_at DESC
           LIMIT 20`
        ),
        c.query(
          `SELECT audit_id::text, entity_type, entity_id::text, deal_id::text, action_name, state_type, from_state, to_state, created_at
           FROM siton.audit_log
           ORDER BY created_at DESC
           LIMIT 30`
        ),
        c.query(
          `SELECT state, COUNT(*)::int AS count
           FROM siton.deals
           GROUP BY state
           ORDER BY state`
        )
      ]);

      const counts = systemCounts.rows[0] || {};
      const cardDefs = [
        ["completion_window_ending_soon", "חלון השלמה מסתיים בקרוב", counts.completion_window_ending_soon, "warning"],
        ["dlq_not_empty", "DLQ לא ריק", counts.dlq_count, "danger"],
        ["completed_without_charged_success", "עסקה הושלמה ללא חיוב מוצלח", counts.completed_without_charged_success, "danger"],
        ["payment_failures_last_hour", "כשלי סליקה בשעה האחרונה", counts.payment_failures_last_hour, "warning"],
        ["reconcile_open", "התאמת מסמכים פתוחה", counts.active_reconcile, "warning"],
        ["failed_invoice_documents", "כשלי חשבוניות", counts.failed_invoice_documents, "warning"],
        ["payout_exceptions", "חריגי העברה למוכר", counts.payout_exceptions, "danger"],
        ["pending_target_near_deadline", "עסקה קרובה לדדליין לפני יעד", counts.pending_target_near_deadline, "warning"]
      ] as const;
      const exceptionCards = cardDefs
        .map(([code, label, value, severity]) => ({
          code,
          label_he: label,
          count: Number(value || 0),
          severity,
          href: code === "dlq_not_empty" ? "/api/admin/outbox-status" : "/app/admin"
        }))
        .filter((item) => item.count > 0);
      const systemStatus = exceptionCards.some((item) => item.severity === "danger")
        ? "red"
        : exceptionCards.some((item) => item.severity === "warning")
          ? "yellow"
          : "green";
      const missionControlDeep = await buildAdminMissionControlPayload({
        c,
        rootDir: join(frontendDir, ".."),
        deploymentMode: deps.deploymentMode,
        isDemoPreview: deps.isDemoPreview,
        paymentProvider: deps.paymentProvider,
        payoutProvider,
        invoiceSummary: deps.invoiceSummary,
        notificationSummary: deps.notificationSummary,
        debugSurfacesEnabled: deps.debugSurfacesEnabled,
        getWorkerRunning: deps.getWorkerRunning
      });

      return {
        ok: true,
        ...missionControlDeep,
        generated_at: new Date().toISOString(),
        stale_after_seconds: 60,
        system: {
          status: systemStatus,
          last_updated_at: new Date().toISOString(),
          warnings: exceptionCards
        },
        exception_cards: exceptionCards,
        omnisearch: {
          scope: "admin_only_operational_search",
          public_discovery_scope: "separate_mall_read_surface",
          query: q,
          results: searchRows.rows.map((row: any) => ({
            entity_type: String(row.entity_type),
            entity_id: String(row.entity_id),
            headline: String(row.headline || ""),
            status: String(row.status || ""),
            result_kind: String(row.result_kind || ""),
            route: String(row.route || "/app/admin")
          }))
        },
        exceptional_deals: exceptionalDeals.rows.map((row: any) => ({
          deal_id: String(row.deal_id),
          title: String(row.title || ""),
          seller_id: String(row.seller_id || DEFAULT_SELLER_ID),
          seller_name: String(row.seller_name || row.seller_id || DEFAULT_SELLER_ID),
          state: String(row.state || ""),
          target_units: Number(row.target_units || 0),
          min_units: Number(row.min_units || 0),
          max_units: Number(row.max_units || 0),
          charged_units: Number(row.charged_units || 0),
          pending_units: Number(row.pending_units || 0),
          not_charged_units: Number(row.not_charged_units || 0),
          gross_amount: Number(row.gross_amount || 0),
          exception_reason: String(row.exception_reason || "operational_attention"),
          updated_at: row.updated_at ? String(row.updated_at) : null,
          deadline: row.deadline ? String(row.deadline) : null,
          completion_window_until: row.completion_window_until ? String(row.completion_window_until) : null
        })),
        kyc_queue: kycQueue.rows.map((row: any) => ({
          seller_id: String(row.seller_id),
          seller_name: String(row.seller_name || row.seller_id),
          verification_status: String(row.verification_status || ""),
          settlement_status: String(row.settlement_status || ""),
          missing_fields: Array.isArray(row.missing_fields) ? row.missing_fields : [],
          created_at: row.created_at ? String(row.created_at) : null,
          updated_at: row.updated_at ? String(row.updated_at) : null
        })),
        payouts_settlements: {
          manual_money_actions_enabled: false,
          request_thread_transfers_enabled: false,
          provider: getPayoutProviderSummary(payoutProvider),
          active_batches: Number(counts.active_payout_batches || 0),
          exception_batches: Number(counts.payout_exceptions || 0),
          batches: payoutRows.rows.map((row: any) => ({
            payout_batch_id: String(row.payout_batch_id),
            deal_id: row.deal_id ? String(row.deal_id) : null,
            seller_id: String(row.seller_id || ""),
            payout_status: String(row.payout_status || ""),
            gross_amount: Number(row.gross_amount || 0),
            platform_fee_total_amount: Number(row.platform_fee_total_amount || 0),
            seller_net_amount: Number(row.seller_net_amount || 0),
            created_at: row.created_at ? String(row.created_at) : null,
            updated_at: row.updated_at ? String(row.updated_at) : null
          }))
        },
        support_hub: {
          open_count: Number(counts.open_support_tickets || 0),
          tickets: supportRows.rows
        },
        audit_forensics: {
          recent_events: auditRows.rows,
          export_csv_available: false,
          immutable_audit_log: true
        },
        system_status: {
          outbox: {
            active: Number(counts.active_outbox || 0),
            failed: Number(counts.failed_outbox || 0),
            dlq: Number(counts.dlq_count || 0)
          },
          notifications: {
            active: Number(counts.active_notifications || 0),
            failed: Number(counts.failed_notifications || 0),
            external_delivery: deps.notificationSummary.external_delivery
          },
          invoices: {
            failed: Number(counts.failed_invoice_documents || 0),
            active_reconcile: Number(counts.active_reconcile || 0),
            provider: deps.invoiceSummary
          },
          payments: {
            failures_last_hour: Number(counts.payment_failures_last_hour || 0),
            provider: getPaymentProviderSummary(deps.paymentProvider)
          },
          payouts: {
            active_batches: Number(counts.active_payout_batches || 0),
            exception_batches: Number(counts.payout_exceptions || 0),
            provider: getPayoutProviderSummary(payoutProvider)
          },
          support: {
            open_tickets: Number(counts.open_support_tickets || 0)
          }
        },
        deals_by_state: dealStateCounts.rows.map((row: any) => ({
          state: String(row.state),
          count: Number(row.count || 0)
        })),
        action_policy: {
          state_override_enabled: false,
          manual_capture_enabled: false,
          manual_refund_enabled: false,
          manual_void_enabled: false,
          manual_payout_enabled: false,
          allowed_actions: [
            "view_details",
            "copy_correlation_id",
            "create_support_ticket",
            "kyc_decision_with_reason",
            "read_payout_status",
            "trigger_reconcile_only_if_existing_job_route_is_used"
          ],
          sensitive_actions_require_reason_and_audit: true
        }
      };
    });
  });

  app.get("/api/admin/mission-control/anomalies", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    await ensurePayoutTables();
    await ensureNotificationTables();
    await ensureInvoiceWebhookTables();
    await ensurePaymentOpsTables();
    await ensureAdminControlPlane();
    return deps.withTx(async (c) => {
      const payload = await buildAdminMissionControlPayload({
        c,
        rootDir: join(frontendDir, ".."),
        deploymentMode: deps.deploymentMode,
        isDemoPreview: deps.isDemoPreview,
        paymentProvider: deps.paymentProvider,
        payoutProvider,
        invoiceSummary: deps.invoiceSummary,
        notificationSummary: deps.notificationSummary,
        debugSurfacesEnabled: deps.debugSurfacesEnabled,
        getWorkerRunning: deps.getWorkerRunning
      });
      return {
        ok: true,
        generated_at: payload.generated_at,
        verdict: payload.verdict,
        anomaly_center: payload.anomaly_center,
        recommended_actions: payload.recommended_actions
      };
    });
  });

  app.get("/api/admin/mission-control/deals/:dealId/trace", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const dealId = String(req.params.dealId || "").trim();
    requireUuid(dealId, "deal_id");
    return deps.withTx((c) => buildMissionDealTrace(c, dealId));
  });

  app.get("/api/admin/mission-control/participants/:participantId/trace", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const participantId = String(req.params.participantId || "").trim();
    requireUuid(participantId, "participant_id");
    return deps.withTx((c) => buildMissionParticipantTrace(c, participantId));
  });

  app.get("/api/admin/mission-control/correlation/:correlationId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const correlationId = String(req.params.correlationId || "").trim().slice(0, 200);
    if (!correlationId) return reply.code(400).send({ ok: false, error: "correlation_id_required" });
    return deps.withTx((c) => buildMissionCorrelationTrace(c, correlationId));
  });

  app.get("/api/admin/mission-control/outbox/:eventId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const eventId = String(req.params.eventId || "").trim();
    requireUuid(eventId, "event_id");
    return deps.withTx((c) => buildMissionOutboxTrace(c, eventId));
  });

  app.get("/api/admin/mission-control/webhooks/:provider/:eventId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const provider = String(req.params.provider || "").trim().slice(0, 80);
    const eventId = String(req.params.eventId || "").trim().slice(0, 200);
    if (!provider || !eventId) return reply.code(400).send({ ok: false, error: "provider_and_event_id_required" });
    return deps.withTx((c) => buildMissionWebhookTrace(c, provider, eventId));
  });
}
