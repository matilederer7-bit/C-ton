// ADMIN OPERATIONAL STATUS — read-only queue / notification / invoice health routes.
//
// Lean Refactor: the three GET routes below moved verbatim out of
// src/frontend_runtime.ts. Their guards, SQL, thresholds, provider summaries,
// response shapes and route order are unchanged. The runtime injects the same
// closures and summary values the handlers used before.
import type { FastifyInstance } from "fastify";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;
type SchemaCheck = () => Promise<unknown>;

export type AdminOperationalStatusRouteDeps = {
  withTx: WithTx;
  requireAdminRead: (req: any, reply: any) => Promise<boolean>;
  workerStuckTimeoutMs: number | undefined;
  notificationSummary: {
    provider: string;
    mode: string;
    external_delivery: boolean;
  };
  ensureInvoiceWebhookTables: SchemaCheck;
  invoiceSummary: {
    provider: string;
    mode: string;
    provider_mode?: string;
    configured?: boolean;
    api_base_url_configured?: boolean;
    api_key_configured?: boolean;
    bearer_token_configured?: boolean;
    webhook_secret_configured?: boolean;
    create_document_path?: string;
    get_document_status_path?: string;
    cancel_document_path?: string;
    timeout_ms?: number;
    external_issuance: boolean;
    external_document_issued?: boolean;
    supported_methods?: string[];
  } | undefined;
};

export function registerAdminOperationalStatusRoutes(app: FastifyInstance, deps: AdminOperationalStatusRouteDeps) {
  const { requireAdminRead, ensureInvoiceWebhookTables } = deps;

  // ── Outbox operational status ─────────────────────────────────────────────
  // Returns per-bucket counts, oldest event ages, stuck candidate count, and
  // workerRunning flag. Safe for dashboards and post-restart health checks.
  app.get("/api/admin/outbox-status", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const stuckTimeoutMs = deps.workerStuckTimeoutMs ?? 60_000;
    return deps.withTx(async (c) => {
      const [outbox, dlq, workers, maintenance] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)                                              FILTER (WHERE status='pending')    AS pending_count,
             COUNT(*)                                              FILTER (WHERE status='pending' AND available_at >  now()) AS scheduled_future_count,
             COUNT(*)                                              FILTER (WHERE status='pending' AND available_at <= now()) AS due_now_count,
             COUNT(*)                                              FILTER (WHERE status='processing') AS processing_count,
             COUNT(*)                                              FILTER (WHERE status='sent')       AS sent_count,
             COUNT(*)                                              FILTER (WHERE status='failed')     AS failed_count,
             EXTRACT(EPOCH FROM (MIN(available_at) FILTER (WHERE status='pending' AND available_at > now()) - now())) AS next_scheduled_in_s,
             EXTRACT(EPOCH FROM (now() - MIN(available_at)       FILTER (WHERE status='pending' AND available_at <= now()))) AS oldest_due_age_s,
             EXTRACT(EPOCH FROM (now() - MIN(processing_started_at)
                                                                  FILTER (WHERE status='processing'))) AS oldest_processing_age_s,
             COUNT(*)
               FILTER (WHERE status='processing'
                         AND (lease_expires_at <= now()
                              OR (lease_expires_at IS NULL AND (processing_started_at IS NULL
                                   OR processing_started_at < now() - ($1::text || ' milliseconds')::interval))))
                                                                                                     AS stuck_candidates
           FROM siton.outbox_events`,
          [String(stuckTimeoutMs)]
        ),
        c.query(`SELECT COUNT(*) AS dlq_count FROM siton.outbox_dlq`),
        c.query(
          `SELECT worker_id,status,started_at,heartbeat_at,
                  (heartbeat_at > now() - interval '30 seconds') AS fresh
             FROM siton.worker_heartbeats
            ORDER BY heartbeat_at DESC`
        ),
        // LONG_HORIZON_DEALS — payment-maintenance signal (migration 072)
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE b.expires_at IS NOT NULL AND b.expires_at <= now()
                              AND p.money_state IN ('AuthHeld','AuthLocked','ChargeAttempt','ChargeFailedRecovery')) AS past_validity,
             COUNT(*) FILTER (WHERE b.renewal_count > 0) AS renewed
           FROM siton.payment_authorization_bindings b
           JOIN siton.participants p ON p.participant_id = b.consumed_by_participant_id
           WHERE b.status='consumed'`
        )
      ]);
      const o = outbox.rows[0];
      return {
        ok: true,
        outbox: {
          pending:           Number(o.pending_count   ?? 0),
          // A pending job whose available_at is in the future is SCHEDULED work
          // (e.g. a deadline_check waiting for the deal deadline), not a
          // backlog. Only jobs due now count as an actionable queue.
          scheduled_future:  Number(o.scheduled_future_count ?? 0),
          due_now:           Number(o.due_now_count ?? 0),
          processing:        Number(o.processing_count ?? 0),
          sent:              Number(o.sent_count       ?? 0),
          failed:            Number(o.failed_count     ?? 0),
          dlq:               Number(dlq.rows[0].dlq_count ?? 0),
          next_scheduled_in_s:     o.next_scheduled_in_s     != null ? Number(Number(o.next_scheduled_in_s).toFixed(1))     : null,
          oldest_due_age_s:        o.oldest_due_age_s        != null ? Number(Number(o.oldest_due_age_s).toFixed(1))        : null,
          oldest_pending_age_s:    o.oldest_due_age_s        != null ? Number(Number(o.oldest_due_age_s).toFixed(1))        : null,
          oldest_processing_age_s: o.oldest_processing_age_s != null ? Number(Number(o.oldest_processing_age_s).toFixed(1)) : null,
          stuck_candidates:  Number(o.stuck_candidates ?? 0),
          stuck_timeout_ms:  stuckTimeoutMs
        },
        worker: {
          running: workers.rows.some((row: any) => row.fresh && row.status === "ready"),
          active_count: workers.rows.filter((row: any) => row.fresh && row.status === "ready").length,
          instances: workers.rows
        },
        // LONG_HORIZON_DEALS — a payment-MAINTENANCE signal, not a product state
        // and not an alert: committed participants whose CURRENT authorization
        // is past its declared validity are renewal candidates at the charging
        // boundary. Deal lifetime is independent of authorization lifetime.
        payment_maintenance: {
          authorizations_past_declared_validity: Number((maintenance.rows[0] as any)?.past_validity ?? 0),
          authorizations_renewed: Number((maintenance.rows[0] as any)?.renewed ?? 0),
          deal_lifetime_bounded_by_authorization: false
        }
      };
    });
  });

  // ── Notifications operational status ──────────────────────────────────────
  // Returns per-status counts, oldest ages, unique idempotency-key count, channel breakdown.
  // Safe for dashboards and post-restart health checks.
  const notificationStatusHandler = async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    return deps.withTx(async (c) => {
      const [totals, channels, recentEvents] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)                                                  FILTER (WHERE status='pending')    AS pending_count,
             COUNT(*)                                                  FILTER (WHERE status='processing') AS processing_count,
             COUNT(*)                                                  FILTER (WHERE status='sent')       AS sent_count,
             COUNT(*)                                                  FILTER (WHERE status='failed')     AS failed_count,
             COUNT(*)                                                  FILTER (WHERE status='skipped')    AS skipped_count,
             COUNT(*)                                                  FILTER (WHERE status='pending' AND last_error IS NOT NULL) AS retryable_count,
             COUNT(DISTINCT idempotency_key)                                                             AS unique_event_keys,
             EXTRACT(EPOCH FROM (now() - MIN(COALESCE(scheduled_for, created_at)) FILTER (WHERE status='pending'))) AS oldest_pending_age_s,
             EXTRACT(EPOCH FROM (now() - MIN(updated_at)              FILTER (WHERE status='failed')))   AS oldest_failed_age_s
           FROM siton.notification_events`
        ),
        c.query(
          `SELECT channel,
                  COUNT(*)                          FILTER (WHERE status='pending') AS pending,
                  COUNT(*)                          FILTER (WHERE status='sent')    AS sent,
                  COUNT(*)                          FILTER (WHERE status='failed')  AS failed
           FROM siton.notification_events
           GROUP BY channel
           ORDER BY channel`
        ),
        c.query(
          `SELECT ne.notification_id, ne.event_type, ne.recipient_type, ne.channel,
                  ne.status, ne.deal_id, d.title AS deal_title, ne.participant_id, ne.seller_id,
                  ne.scheduled_for, ne.sent_at, ne.created_at, ne.last_error,
                  (SELECT COUNT(*)::int FROM siton.notification_attempts na WHERE na.notification_id = ne.notification_id) AS attempts,
                  (SELECT na.provider FROM siton.notification_attempts na WHERE na.notification_id = ne.notification_id ORDER BY na.created_at DESC LIMIT 1) AS last_provider,
                  (SELECT na.provider_mode FROM siton.notification_attempts na WHERE na.notification_id = ne.notification_id ORDER BY na.created_at DESC LIMIT 1) AS last_provider_mode
           FROM siton.notification_events ne
           LEFT JOIN siton.deals d ON d.deal_id = ne.deal_id
           ORDER BY ne.created_at DESC
           LIMIT 50`
        )
      ]);
      const t = totals.rows[0];
      return {
        ok: true,
        notifications: {
          pending:           Number(t.pending_count    ?? 0),
          processing:        Number(t.processing_count ?? 0),
          sent:              Number(t.sent_count        ?? 0),
          failed:            Number(t.failed_count      ?? 0),
          skipped:           Number(t.skipped_count     ?? 0),
          retryable:         Number(t.retryable_count   ?? 0),
          unique_event_keys: Number(t.unique_event_keys ?? 0),
          oldest_pending_age_s: t.oldest_pending_age_s != null ? Number(Number(t.oldest_pending_age_s).toFixed(1)) : null,
          oldest_failed_age_s:  t.oldest_failed_age_s  != null ? Number(Number(t.oldest_failed_age_s).toFixed(1))  : null,
          provider: {
            code: deps.notificationSummary.external_delivery ? deps.notificationSummary.provider : "log-only",
            mode: deps.notificationSummary.external_delivery ? deps.notificationSummary.mode : "log-only",
            external_delivery: deps.notificationSummary.external_delivery
          }
        },
        by_channel: channels.rows.map((r: any) => ({
          channel: String(r.channel),
          pending: Number(r.pending ?? 0),
          sent:    Number(r.sent    ?? 0),
          failed:  Number(r.failed  ?? 0)
        })),
        recent_events: recentEvents.rows.map((r: any) => ({
          notification_id: String(r.notification_id),
          event_type: String(r.event_type),
          recipient_type: String(r.recipient_type),
          channel: String(r.channel),
          status: String(r.status),
          deal_id: r.deal_id,
          deal_title: r.deal_title,
          participant_id: r.participant_id,
          seller_id: r.seller_id,
          scheduled_for: r.scheduled_for,
          sent_at: r.sent_at,
          created_at: r.created_at,
          last_error: r.last_error,
          attempts: Number(r.attempts ?? 0),
          adapter: r.last_provider || (deps.notificationSummary.external_delivery ? deps.notificationSummary.provider : "log-only"),
          adapter_mode: r.last_provider_mode || (deps.notificationSummary.external_delivery ? deps.notificationSummary.mode : "log-only")
        }))
      };
    });
  };
  app.get("/api/admin/notifications-status", notificationStatusHandler);

  // ── Invoice documents operational status ─────────────────────────────────
  // Returns per-status counts, oldest ages, unique document_key count, type breakdown.
  // Mirrors notifications-status structure. Safe for dashboards and post-restart checks.
  app.get("/api/admin/invoice-status", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureInvoiceWebhookTables();
    return deps.withTx(async (c) => {
      const [totals, byType, attempts, webhooks, webhookSecurity, reconcileBacklog] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)                                                   FILTER (WHERE status='pending')    AS pending_count,
             COUNT(*)                                                   FILTER (WHERE status='processing') AS processing_count,
             COUNT(*)                                                   FILTER (WHERE status='issued')     AS issued_count,
             COUNT(*)                                                   FILTER (WHERE status='failed')     AS failed_count,
             COUNT(*)                                                   FILTER (WHERE status='skipped')    AS skipped_count,
             COUNT(*)                                                   FILTER (WHERE status='pending' AND attempt_count > 0) AS retryable_count,
             COUNT(DISTINCT document_key)                                                                  AS unique_document_keys,
             EXTRACT(EPOCH FROM (now() - MIN(available_at)             FILTER (WHERE status='pending')))  AS oldest_pending_age_s,
             EXTRACT(EPOCH FROM (now() - MIN(updated_at)               FILTER (WHERE status='failed')))   AS oldest_failed_age_s
           FROM siton.invoice_documents`
        ),
        c.query(
          `SELECT document_type,
                  COUNT(*)          FILTER (WHERE status='pending')  AS pending,
                  COUNT(*)          FILTER (WHERE status='issued')   AS issued,
                  COUNT(*)          FILTER (WHERE status='failed')   AS failed
           FROM siton.invoice_documents
           GROUP BY document_type
           ORDER BY document_type`
        ),
        c.query(
          `SELECT result_class,
                  COUNT(*) AS count
           FROM siton.invoice_document_attempts
           GROUP BY result_class
           ORDER BY result_class`
        ),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE status='pending') AS pending,
                  COUNT(*) FILTER (WHERE status='queued') AS queued,
                  COUNT(*) FILTER (WHERE status='ignored') AS ignored,
                  COUNT(*) FILTER (WHERE status='failed') AS failed,
                  COUNT(*) AS total
           FROM siton.invoice_webhook_events`
        ),
        c.query(
          `SELECT COUNT(*) AS signature_failures,
                  MAX(created_at) AS latest_signature_failure_at
           FROM siton.invoice_webhook_security_events`
        ),
        c.query(
          `SELECT COUNT(*) AS pending_reconcile
           FROM siton.outbox_events
           WHERE event_type='invoice_document_reconcile'
             AND aggregate_type='invoice_document'
             AND status IN ('pending','processing')`
        )
      ]);
      const t = totals.rows[0];
      const webhook = webhooks.rows[0] || {};
      const webhookSec = webhookSecurity.rows[0] || {};
      return {
        ok: true,
        invoice_documents: {
          pending:              Number(t.pending_count    ?? 0),
          processing:           Number(t.processing_count ?? 0),
          issued:               Number(t.issued_count     ?? 0),
          failed:               Number(t.failed_count     ?? 0),
          skipped:              Number(t.skipped_count    ?? 0),
          retryable:            Number(t.retryable_count  ?? 0),
          unique_document_keys: Number(t.unique_document_keys ?? 0),
          oldest_pending_age_s: t.oldest_pending_age_s != null ? Number(Number(t.oldest_pending_age_s).toFixed(1)) : null,
          oldest_failed_age_s:  t.oldest_failed_age_s  != null ? Number(Number(t.oldest_failed_age_s).toFixed(1))  : null,
          provider: deps.invoiceSummary
            ? {
                code: deps.invoiceSummary.provider,
                mode: deps.invoiceSummary.mode,
                provider_mode: deps.invoiceSummary.provider_mode,
                configured: deps.invoiceSummary.configured,
                api_base_url_configured: deps.invoiceSummary.api_base_url_configured,
                api_key_configured: deps.invoiceSummary.api_key_configured,
                bearer_token_configured: deps.invoiceSummary.bearer_token_configured,
                webhook_secret_configured: deps.invoiceSummary.webhook_secret_configured,
                create_document_path: deps.invoiceSummary.create_document_path,
                get_document_status_path: deps.invoiceSummary.get_document_status_path,
                cancel_document_path: deps.invoiceSummary.cancel_document_path,
                timeout_ms: deps.invoiceSummary.timeout_ms,
                external_issuance: deps.invoiceSummary.external_issuance,
                external_document_issued: deps.invoiceSummary.external_document_issued,
                supported_methods: deps.invoiceSummary.supported_methods
              }
            : null
        },
        provider_failures_by_class: attempts.rows.map((r: any) => ({
          result_class: String(r.result_class),
          count: Number(r.count ?? 0)
        })),
        webhook_ingestion: {
          pending: Number(webhook.pending ?? 0),
          queued: Number(webhook.queued ?? 0),
          ignored: Number(webhook.ignored ?? 0),
          failed: Number(webhook.failed ?? 0),
          duplicate_rate: Number(webhook.total ?? 0) > 0
            ? Number((Number(webhook.ignored ?? 0) / Number(webhook.total)).toFixed(4))
            : 0
        },
        webhook_security: {
          signature_failures: Number(webhookSec.signature_failures ?? 0),
          latest_signature_failure_at: webhookSec.latest_signature_failure_at ?? null
        },
        reconcile_backlog: {
          pending_reconcile: Number(reconcileBacklog.rows[0]?.pending_reconcile ?? 0)
        },
        by_type: byType.rows.map((r: any) => ({
          document_type: String(r.document_type),
          pending: Number(r.pending ?? 0),
          issued:  Number(r.issued  ?? 0),
          failed:  Number(r.failed  ?? 0)
        }))
      };
    });
  });


}
