// ADMIN OPS OVERVIEW — read-only admin console routes.
//
// Lean Refactor: the three GET routes below (payment-ops-status, overview,
// launch-console) were moved verbatim out of src/frontend_runtime.ts. Nothing
// about them changed: same paths, same requireAdminRead guard, same schema
// checks, same SQL, same projections and the same response shapes. They only
// read: payment-ops-status reports payment attempts, webhook reconciliation and
// the platform-fee ledger, and overview reports settlement figures through the
// existing money helpers; neither moves money nor changes fee or ledger logic.
// The runtime hands this module exactly the closures it used before (dependency
// injection); no helper was copied. They are registered at their original
// point, right before the Mission Control routes.
import type { FastifyInstance } from "fastify";
import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";
import { computeCustomerChargeVat } from "./vat_authority.js";
import { SITON_PLATFORM_FEE_RATE } from "./platform_fee_money.js";
import { DEFAULT_SELLER_ID, summarizeMoney } from "./product_surface_support.js";
import type { DealListRow } from "./frontend_runtime.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;
type SchemaCheck = () => Promise<unknown>;

export type AdminOpsOverviewRouteDeps = {
  withTx: WithTx;
  /** The runtime's admin READ guard (named admin identity or the ops key). Owns the denial response. */
  requireAdminRead: (req: any, reply: any) => Promise<boolean>;
  ensurePaymentOpsTables: SchemaCheck;
  ensureProductSurfaces: SchemaCheck;
  ensureNotificationTables: SchemaCheck;
  ensureLegalAcceptanceTables: SchemaCheck;
  /** The runtime's deal-list projection (shared with the buyer and seller deal lists). */
  mapDealListRow: (row: DealListRow) => unknown;
  paymentProvider: PaymentProvider;
  notificationSummary: {
    provider: string;
    mode: string;
    external_delivery: boolean;
  };
};

export function registerAdminOpsOverviewRoutes(app: FastifyInstance, deps: AdminOpsOverviewRouteDeps) {
  const {
    requireAdminRead,
    ensurePaymentOpsTables,
    ensureProductSurfaces,
    ensureNotificationTables,
    ensureLegalAcceptanceTables,
    mapDealListRow
  } = deps;

  app.get("/api/admin/payment-ops-status", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensurePaymentOpsTables();
    return deps.withTx(async (c) => {
      const [attempts, webhooks, security, methods, recentAttempts, ledger, recentLedger] = await Promise.all([
        c.query(
          `SELECT attempt_type,
                  COUNT(*) FILTER (WHERE result_class='success') AS success,
                  COUNT(*) FILTER (WHERE result_class='temporary_fail') AS temporary_fail,
                  COUNT(*) FILTER (WHERE result_class='permanent_fail') AS permanent_fail,
                  COUNT(*) FILTER (WHERE result_class='unknown') AS unknown
           FROM siton.payment_attempts
           GROUP BY attempt_type
           ORDER BY attempt_type`
        ),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE status='processed') AS processed,
                  COUNT(*) FILTER (WHERE status='ignored') AS ignored,
                  COUNT(*) FILTER (WHERE status='failed') AS failed,
                  COUNT(*) FILTER (WHERE status='processing') AS processing,
                  COUNT(*) FILTER (WHERE status='pending') AS pending,
                  COUNT(*) AS total
           FROM siton.webhook_events`
        ),
        c.query(`SELECT COUNT(*) AS signature_failures, MAX(created_at) AS latest_signature_failure_at FROM siton.payment_webhook_security_events`),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE status='active') AS active,
                  COUNT(*) FILTER (WHERE status='invalid') AS invalid,
                  COUNT(*) FILTER (WHERE status='expired') AS expired,
                  COUNT(*) FILTER (WHERE status='revoked') AS revoked
           FROM siton.buyer_payment_methods`
        ),
        c.query(
          `SELECT pa.attempt_id, pa.attempt_type, pa.result_class, pa.correlation_id,
                  pa.created_at, pa.deal_id, d.title AS deal_title,
                  pa.participant_id, p.buyer_name
           FROM siton.payment_attempts pa
           LEFT JOIN siton.deals d ON d.deal_id = pa.deal_id
           LEFT JOIN siton.participants p ON p.participant_id = pa.participant_id
           ORDER BY pa.created_at DESC
           LIMIT 40`
        ),
        c.query(
          `SELECT
             COALESCE(SUM(gross_amount) FILTER (WHERE logical_entry_type='charge'),0)::numeric(14,2) AS gross_charged,
             COALESCE(SUM(platform_fee_base_amount),0)::numeric(14,2) AS fee_base,
             COALESCE(SUM(platform_fee_vat_amount),0)::numeric(14,2) AS fee_vat,
             COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_total,
             COUNT(*)::int AS entries,
             COUNT(*) FILTER (WHERE event_type='refund_issued')::int AS refund_entries
           FROM siton.platform_fee_money_events`
        ),
        c.query(
          `SELECT fe.event_type, fe.logical_entry_type, fe.correlation_id, fe.created_at,
                  fe.gross_amount, fe.platform_fee_total_amount, fe.deal_id, d.title AS deal_title
           FROM siton.platform_fee_money_events fe
           LEFT JOIN siton.deals d ON d.deal_id = fe.deal_id
           ORDER BY fe.created_at DESC
           LIMIT 25`
        )
      ]);
      const webhook = webhooks.rows[0] || {};
      const securityRow = security.rows[0] || {};
      const method = methods.rows[0] || {};
      const ledgerRow = ledger.rows[0] || {};
      return {
        ok: true,
        provider: getPaymentProviderSummary(deps.paymentProvider),
        attempts_by_type: attempts.rows.map((row: any) => ({
          attempt_type: String(row.attempt_type),
          success: Number(row.success ?? 0),
          temporary_fail: Number(row.temporary_fail ?? 0),
          permanent_fail: Number(row.permanent_fail ?? 0),
          unknown: Number(row.unknown ?? 0)
        })),
        webhook_reconciliation: {
          processed: Number(webhook.processed ?? 0),
          ignored: Number(webhook.ignored ?? 0),
          failed: Number(webhook.failed ?? 0),
          processing: Number(webhook.processing ?? 0),
          pending: Number(webhook.pending ?? 0),
          duplicate_rate: Number(webhook.total ?? 0) > 0
            ? Number((Number(webhook.ignored ?? 0) / Number(webhook.total)).toFixed(4))
            : 0
        },
        webhook_security: {
          signature_failures: Number(securityRow.signature_failures ?? 0),
          latest_signature_failure_at: securityRow.latest_signature_failure_at ?? null
        },
        buyer_payment_methods: {
          active: Number(method.active ?? 0),
          invalid: Number(method.invalid ?? 0),
          expired: Number(method.expired ?? 0),
          revoked: Number(method.revoked ?? 0),
          hosted_payment_only: true
        },
        fee_ledger: {
          gross_charged: Number(ledgerRow.gross_charged ?? 0),
          fee_base: Number(ledgerRow.fee_base ?? 0),
          fee_vat: Number(ledgerRow.fee_vat ?? 0),
          fee_total: Number(ledgerRow.fee_total ?? 0),
          entries: Number(ledgerRow.entries ?? 0),
          refund_entries: Number(ledgerRow.refund_entries ?? 0),
          note: "Siton fee = 8% of the authoritative charge base (incl. delivery, excl. VAT), from successful charges only"
        },
        recent_attempts: recentAttempts.rows.map((row: any) => ({
          attempt_id: String(row.attempt_id),
          attempt_type: String(row.attempt_type),
          result_class: String(row.result_class),
          correlation_id: String(row.correlation_id || ""),
          created_at: row.created_at,
          deal_id: row.deal_id,
          deal_title: row.deal_title,
          buyer_name: row.buyer_name
        })),
        recent_ledger: recentLedger.rows.map((row: any) => ({
          event_type: String(row.event_type),
          logical_entry_type: String(row.logical_entry_type),
          correlation_id: String(row.correlation_id || ""),
          created_at: row.created_at,
          gross_amount: Number(row.gross_amount ?? 0),
          platform_fee_total_amount: Number(row.platform_fee_total_amount ?? 0),
          deal_id: row.deal_id,
          deal_title: row.deal_title
        }))
      };
    });
  });

  app.get("/api/admin/overview", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const q = String(req.query?.q || "").trim().slice(0, 200);
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const deals = await c.query(
        `SELECT
           d.deal_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.list_price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           ${SITON_PLATFORM_FEE_RATE}::numeric AS platform_fee_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COALESCE(SUM(p.delivery_cost),0) AS joined_delivery_cost,
           -- Closed-pilot war game (2026-09-09): settlement money is SUCCESSFUL
           -- money only. Joined inventory (released / dropped / failed charges)
           -- is not revenue and must never reach the seller settlement figure.
           COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS settled_units,
           COALESCE(SUM(p.delivery_cost) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS settled_delivery_cost,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         GROUP BY d.deal_id
         ORDER BY d.created_at DESC
         LIMIT 100`
      );

      const search = q
        ? await c.query(
            `SELECT 'deal' AS entity_type, d.deal_id::text AS entity_id, d.title AS headline, d.state::text AS state, NULL::text AS detail
             FROM siton.deals d
             WHERE d.deal_id::text ILIKE '%' || $1 || '%' OR d.title ILIKE '%' || $1 || '%'
             UNION ALL
             SELECT 'participant' AS entity_type, p.participant_id::text AS entity_id, p.buyer_id AS headline, p.buyer_state::text AS state, p.deal_id::text AS detail
             FROM siton.participants p
             WHERE p.participant_id::text ILIKE '%' || $1 || '%' OR p.buyer_id ILIKE '%' || $1 || '%' OR p.deal_id::text ILIKE '%' || $1 || '%'
             ORDER BY entity_type, headline
             LIMIT 30`,
            [q]
          )
        : { rows: [] };

      const kycQueue = await c.query(
        `SELECT 'seller' AS subject_type,
                seller_id AS subject_id,
                display_name,
                verification_status AS status,
                settlement_status AS detail,
                updated_at
         FROM siton.seller_accounts
         ORDER BY updated_at DESC`
      );

      const support = await c.query(
        `SELECT ticket_id, scope_type, scope_key, title, priority, status, summary, created_at, updated_at
         FROM siton.support_tickets
         ORDER BY updated_at DESC
         LIMIT 30`
      );

      const forensics = await c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='ignored') AS ignored_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='pending') AS pending_webhooks,
           (SELECT COUNT(*)::int FROM siton.audit_log WHERE created_at > now() - interval '24 hours') AS recent_audit_events`
      );

      const rows = deals.rows as DealListRow[];
      const completedDeals = rows.filter((row) => row.state === "Completed");
      // Fee base = actual collected amount (price × qty + delivery), excluding
      // the authoritative VAT portion (explicit VAT authority; synthetic_zero
      // keeps staging at 0 by declared policy).
      // Settlement totals include successful money only; joined inventory is not revenue.
      const sellerSettlementProductGross = completedDeals.reduce(
        (sum, row) => sum + Number(row.price_per_unit || 0) * Number((row as any).settled_units || 0),
        0
      );
      const sellerSettlementDeliveryGross = completedDeals.reduce(
        (sum, row) => sum + Number((row as any).settled_delivery_cost || 0),
        0
      );
      const sellerSettlementGross = sellerSettlementProductGross + sellerSettlementDeliveryGross;
      const sellerSettlementVat = computeCustomerChargeVat({
        productGrossAmount: sellerSettlementProductGross,
        deliveryGrossAmount: sellerSettlementDeliveryGross
      });
      return {
        ok: true,
        q,
        admin_surface: {
          totals: {
            deals: rows.length,
            live: rows.filter((row) => ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"].includes(row.state)).length,
            exceptional: rows.filter((row) => ["Failed", "Cancelled", "Charging", "CompletionWindow"].includes(row.state)).length,
            draft: rows.filter((row) => row.state === "Draft").length
          },
          deals: rows.map(mapDealListRow).slice(0, 20),
          exceptional_deals: rows.filter((row) => ["Failed", "Cancelled", "Charging", "CompletionWindow"].includes(row.state)).map(mapDealListRow).slice(0, 12),
          search_results: search.rows,
          kyc_queue: kycQueue.rows,
          settlements: {
            seller_workspace: {
              completed_deals: completedDeals.length,
              gross_amount: sellerSettlementGross,
              platform_fee_amount: summarizeMoney({
                grossAmount: sellerSettlementGross,
                vatAmount: sellerSettlementVat.vat_amount
              }).siton_fee_amount
            }
          },
          support_tickets: support.rows,
          forensics: forensics.rows[0]
        }
      };
    });
  });

  app.get("/api/admin/launch-console", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    await ensureNotificationTables();
    await ensureLegalAcceptanceTables();
    return deps.withTx(async (c) => {
      const [sellerCounts, dealCounts, readiness, notifications, legal, recentDeals] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE NULLIF(btrim(COALESCE(business_name, '')), '') IS NOT NULL
                 AND (
                   NULLIF(btrim(COALESCE(support_email, '')), '') IS NOT NULL
                   OR NULLIF(btrim(COALESCE(support_phone, '')), '') IS NOT NULL
                 )
             )::int AS publish_ready,
             COUNT(*) FILTER (
               WHERE NULLIF(btrim(COALESCE(business_name, '')), '') IS NULL
                  OR (
                    NULLIF(btrim(COALESCE(support_email, '')), '') IS NULL
                    AND NULLIF(btrim(COALESCE(support_phone, '')), '') IS NULL
                  )
             )::int AS incomplete_profile
           FROM siton.seller_accounts`
        ),
        c.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE state='Draft')::int AS draft,
             COUNT(*) FILTER (WHERE state='PendingTarget')::int AS pending_target,
             COUNT(*) FILTER (WHERE state='TargetReached')::int AS target_reached,
             COUNT(*) FILTER (WHERE state='Completed')::int AS completed,
             COUNT(*) FILTER (WHERE state='Failed')::int AS failed,
             COUNT(*) FILTER (WHERE state='Cancelled')::int AS cancelled
           FROM siton.deals`
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM siton.deal_images img WHERE img.deal_id=d.deal_id
               )
             )::int AS deals_missing_images,
             COUNT(*) FILTER (
               WHERE d.state <> 'Draft'
                 AND (
                   NULLIF(btrim(COALESCE(sa.business_name, '')), '') IS NULL
                   OR (
                     NULLIF(btrim(COALESCE(sa.support_email, '')), '') IS NULL
                     AND NULLIF(btrim(COALESCE(sa.support_phone, '')), '') IS NULL
                   )
                 )
             )::int AS deals_missing_seller_profile,
             COUNT(*) FILTER (
               WHERE d.state <> 'Draft'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM siton.legal_acceptances la
                   WHERE la.actor_type='seller'
                     AND la.acceptance_type='seller_publish_terms'
                     AND la.deal_id=d.deal_id
                     AND la.actor_ref=COALESCE(d.seller_id, $1)
                 )
             )::int AS deals_missing_legal_acceptance,
             COUNT(*) FILTER (WHERE d.state='Completed')::int AS completed_deals_with_excel_available,
             0::int AS completed_deals_without_excel
           FROM siton.deals d
           LEFT JOIN siton.seller_accounts sa ON sa.seller_id=COALESCE(d.seller_id, $1)`,
          [DEFAULT_SELLER_ID]
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE status='pending')::int AS pending,
             COUNT(*) FILTER (WHERE status='sent')::int AS sent,
             COUNT(*) FILTER (WHERE status='failed')::int AS failed
           FROM siton.notification_events`
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE acceptance_type='seller_publish_terms')::int AS seller_publish_acceptances,
             COUNT(*) FILTER (WHERE acceptance_type='buyer_join_terms')::int AS buyer_join_acceptances,
             COUNT(*) FILTER (WHERE acceptance_type='buyer_payment_disclosure')::int AS buyer_payment_disclosures
           FROM siton.legal_acceptances`
        ),
        c.query(
          `SELECT
             d.deal_id::text,
             d.title,
             d.state,
             COALESCE(d.seller_id, $1) AS seller_id,
             sa.business_name AS seller_business_name,
             EXISTS (SELECT 1 FROM siton.deal_images img WHERE img.deal_id=d.deal_id) AS has_image,
             (
               NULLIF(btrim(COALESCE(sa.business_name, '')), '') IS NOT NULL
               AND (
                 NULLIF(btrim(COALESCE(sa.support_email, '')), '') IS NOT NULL
                 OR NULLIF(btrim(COALESCE(sa.support_phone, '')), '') IS NOT NULL
               )
             ) AS has_seller_profile,
             EXISTS (
               SELECT 1
               FROM siton.legal_acceptances la
               WHERE la.actor_type='seller'
                 AND la.acceptance_type='seller_publish_terms'
                 AND la.deal_id=d.deal_id
                 AND la.actor_ref=COALESCE(d.seller_id, $1)
             ) AS has_seller_terms_acceptance,
             (d.state='Completed') AS has_excel_export_available,
             d.created_at,
             d.updated_at
           FROM siton.deals d
           LEFT JOIN siton.seller_accounts sa ON sa.seller_id=COALESCE(d.seller_id, $1)
           ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC
           LIMIT 10`,
          [DEFAULT_SELLER_ID]
        )
      ]);

      const sellers = sellerCounts.rows[0] || {};
      const deals = dealCounts.rows[0] || {};
      const ready = readiness.rows[0] || {};
      const notificationSummary = notifications.rows[0] || {};
      const legalSummary = legal.rows[0] || {};

      const warnings: Array<{ severity: "red" | "yellow"; code: string; message: string; count?: number }> = [];
      const addWarning = (severity: "red" | "yellow", code: string, message: string, count?: number) => {
        warnings.push({ severity, code, message, ...(count === undefined ? {} : { count }) });
      };

      const failedNotifications = Number(notificationSummary.failed || 0);
      const pendingNotifications = Number(notificationSummary.pending || 0);
      const missingSellerProfiles = Number(ready.deals_missing_seller_profile || 0);
      const missingLegalAcceptances = Number(ready.deals_missing_legal_acceptance || 0);
      const missingImages = Number(ready.deals_missing_images || 0);
      const incompleteProfiles = Number(sellers.incomplete_profile || 0);
      const completedWithoutExcel = Number(ready.completed_deals_without_excel || 0);

      if (failedNotifications > 0) addWarning("red", "notification_failures", "יש הודעות מערכת שנכשלו ודורשות בדיקה.", failedNotifications);
      if (completedWithoutExcel > 0) addWarning("red", "completed_excel_unavailable", "יש עסקאות שהושלמו בלי ייצוא Excel זמין.", completedWithoutExcel);
      if (missingSellerProfiles > 0) addWarning("red", "published_deal_missing_seller_profile", "יש עסקאות שפורסמו ללא פרופיל מוכר תקין.", missingSellerProfiles);
      if (missingLegalAcceptances > 0) addWarning("red", "published_deal_missing_legal_acceptance", "יש עסקאות שפורסמו ללא הסכמת מוכר שמורה.", missingLegalAcceptances);
      if (incompleteProfiles > 0) addWarning("yellow", "seller_profiles_incomplete", "יש מוכרים שעדיין חסרים פרטי פרסום.", incompleteProfiles);
      if (missingImages > 0) addWarning("yellow", "deals_missing_images", "יש עסקאות ללא תמונת מוצר.", missingImages);
      if (!deps.notificationSummary.external_delivery) addWarning("yellow", "notifications_internal_only", "ספק הודעות במצב פנימי בלבד.", 1);
      if (pendingNotifications > 0) addWarning("yellow", "pending_notifications", "יש הודעות מערכת שממתינות לשליחה.", pendingNotifications);

      const status = warnings.some((warning) => warning.severity === "red")
        ? "red"
        : warnings.some((warning) => warning.severity === "yellow")
          ? "yellow"
          : "green";

      return {
        ok: true,
        generated_at: new Date().toISOString(),
        system: {
          status,
          warnings
        },
        sellers: {
          total: Number(sellers.total || 0),
          publish_ready: Number(sellers.publish_ready || 0),
          incomplete_profile: Number(sellers.incomplete_profile || 0)
        },
        deals: {
          total: Number(deals.total || 0),
          draft: Number(deals.draft || 0),
          pending_target: Number(deals.pending_target || 0),
          target_reached: Number(deals.target_reached || 0),
          completed: Number(deals.completed || 0),
          failed: Number(deals.failed || 0),
          cancelled: Number(deals.cancelled || 0)
        },
        launch_readiness: {
          deals_missing_images: Number(ready.deals_missing_images || 0),
          deals_missing_seller_profile: Number(ready.deals_missing_seller_profile || 0),
          deals_missing_legal_acceptance: Number(ready.deals_missing_legal_acceptance || 0),
          completed_deals_with_excel_available: Number(ready.completed_deals_with_excel_available || 0)
        },
        notifications: {
          pending: Number(notificationSummary.pending || 0),
          sent: Number(notificationSummary.sent || 0),
          failed: Number(notificationSummary.failed || 0),
          provider: deps.notificationSummary.provider,
          mode: deps.notificationSummary.mode,
          external_delivery: deps.notificationSummary.external_delivery
        },
        legal: {
          seller_publish_acceptances: Number(legalSummary.seller_publish_acceptances || 0),
          buyer_join_acceptances: Number(legalSummary.buyer_join_acceptances || 0),
          buyer_payment_disclosures: Number(legalSummary.buyer_payment_disclosures || 0)
        },
        recent_deals: recentDeals.rows.map((row: any) => ({
          deal_id: String(row.deal_id),
          title: String(row.title || ""),
          state: String(row.state || ""),
          seller_id: String(row.seller_id || DEFAULT_SELLER_ID),
          seller_business_name: row.seller_business_name ? String(row.seller_business_name) : null,
          has_image: Boolean(row.has_image),
          has_seller_profile: Boolean(row.has_seller_profile),
          has_seller_terms_acceptance: Boolean(row.has_seller_terms_acceptance),
          has_excel_export_available: Boolean(row.has_excel_export_available),
          created_at: row.created_at ? String(row.created_at) : null,
          updated_at: row.updated_at ? String(row.updated_at) : null
        })),
        recent_warnings: warnings.slice(0, 10)
      };
    });
  });
}
