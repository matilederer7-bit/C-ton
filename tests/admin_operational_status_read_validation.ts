import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAdminOperationalStatusRoutes } from "../src/admin_operational_status_routes.js";

let queryCount = 0;
let invoiceEnsureCount = 0;

const client = {
  async query(sql: string, params?: unknown[]) {
    queryCount += 1;
    const normalized = String(sql).trim();
    assert.match(normalized, /^SELECT\b/i, "operational status routes must stay read-only");

    if (normalized.includes("stuck_candidates") && normalized.includes("FROM siton.outbox_events")) {
      assert.deepEqual(params, ["90000"]);
      return { rows: [{
        pending_count: "5",
        scheduled_future_count: "3",
        due_now_count: "2",
        processing_count: "1",
        sent_count: "11",
        failed_count: "1",
        next_scheduled_in_s: "12.34",
        oldest_due_age_s: "25.67",
        oldest_processing_age_s: "31.25",
        stuck_candidates: "1"
      }] };
    }
    if (normalized.includes("FROM siton.outbox_dlq")) {
      return { rows: [{ dlq_count: "2" }] };
    }
    if (normalized.includes("FROM siton.worker_heartbeats")) {
      return { rows: [
        { worker_id: "ready-1", status: "ready", fresh: true, started_at: "s1", heartbeat_at: "h1" },
        { worker_id: "stale-1", status: "ready", fresh: false, started_at: "s2", heartbeat_at: "h2" }
      ] };
    }
    if (normalized.includes("FROM siton.payment_authorization_bindings")) {
      return { rows: [{ past_validity: "4", renewed: "7" }] };
    }

    if (normalized.includes("COUNT(DISTINCT idempotency_key)") && normalized.includes("FROM siton.notification_events")) {
      return { rows: [{
        pending_count: "2",
        processing_count: "1",
        sent_count: "8",
        failed_count: "1",
        skipped_count: "3",
        retryable_count: "1",
        unique_event_keys: "14",
        oldest_pending_age_s: "75.55",
        oldest_failed_age_s: "90.11"
      }] };
    }
    if (normalized.includes("FROM siton.notification_events") && normalized.includes("GROUP BY channel")) {
      return { rows: [{ channel: "email", pending: "1", sent: "5", failed: "1" }] };
    }
    if (normalized.includes("FROM siton.notification_events ne")) {
      return { rows: [{
        notification_id: "n1",
        event_type: "buyer_joined_authorized",
        recipient_type: "buyer",
        channel: "email",
        status: "sent",
        deal_id: "d1",
        deal_title: "Deal",
        participant_id: "p1",
        seller_id: null,
        scheduled_for: null,
        sent_at: "sent",
        created_at: "created",
        last_error: null,
        attempts: "2",
        last_provider: null,
        last_provider_mode: null
      }] };
    }

    if (normalized.includes("COUNT(DISTINCT document_key)") && normalized.includes("FROM siton.invoice_documents")) {
      return { rows: [{
        pending_count: "1",
        processing_count: "2",
        issued_count: "9",
        failed_count: "1",
        skipped_count: "0",
        retryable_count: "1",
        unique_document_keys: "13",
        oldest_pending_age_s: "44.44",
        oldest_failed_age_s: "55.55"
      }] };
    }
    if (normalized.includes("FROM siton.invoice_documents") && normalized.includes("GROUP BY document_type")) {
      return { rows: [{ document_type: "charge_receipt", pending: "1", issued: "9", failed: "1" }] };
    }
    if (normalized.includes("FROM siton.invoice_document_attempts")) {
      return { rows: [{ result_class: "temporary_fail", count: "2" }] };
    }
    if (normalized.includes("FROM siton.invoice_webhook_events")) {
      return { rows: [{ pending: "1", queued: "2", ignored: "3", failed: "1", total: "10" }] };
    }
    if (normalized.includes("FROM siton.invoice_webhook_security_events")) {
      return { rows: [{ signature_failures: "2", latest_signature_failure_at: "latest" }] };
    }
    if (normalized.includes("event_type='invoice_document_reconcile'")) {
      return { rows: [{ pending_reconcile: "4" }] };
    }

    throw new Error("unexpected query: " + normalized);
  }
};

const app = Fastify({ logger: false });
registerAdminOperationalStatusRoutes(app, {
  withTx: async (fn) => fn(client),
  requireAdminRead: async (req: any, reply: any) => {
    if (req.headers["x-test-admin"] !== "1") {
      reply.code(401).send({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  },
  workerStuckTimeoutMs: 90_000,
  notificationSummary: {
    provider: "configured-provider",
    mode: "provider-ready",
    external_delivery: false
  },
  ensureInvoiceWebhookTables: async () => {
    invoiceEnsureCount += 1;
  },
  invoiceSummary: {
    provider: "internal-invoice-ledger",
    mode: "internal-truth-only",
    provider_mode: "internal-truth-only",
    configured: true,
    api_base_url_configured: false,
    api_key_configured: false,
    bearer_token_configured: false,
    webhook_secret_configured: true,
    create_document_path: "/documents",
    get_document_status_path: "/documents/:id",
    cancel_document_path: "/documents/:id/cancel",
    timeout_ms: 5000,
    external_issuance: false,
    external_document_issued: false,
    supported_methods: ["createDocument"]
  }
});

try {
  for (const url of [
    "/api/admin/outbox-status",
    "/api/admin/notifications-status",
    "/api/admin/invoice-status"
  ]) {
    const before = queryCount;
    const denied = await app.inject({ method: "GET", url });
    assert.equal(denied.statusCode, 401, url);
    assert.equal(queryCount, before, url + " must authorize before DB reads");
  }

  const headers = { "x-test-admin": "1" };

  const outboxRes = await app.inject({ method: "GET", url: "/api/admin/outbox-status", headers });
  assert.equal(outboxRes.statusCode, 200, outboxRes.body);
  const outbox = outboxRes.json() as any;
  assert.deepEqual(outbox.outbox, {
    pending: 5,
    scheduled_future: 3,
    due_now: 2,
    processing: 1,
    sent: 11,
    failed: 1,
    dlq: 2,
    next_scheduled_in_s: 12.3,
    oldest_due_age_s: 25.7,
    oldest_pending_age_s: 25.7,
    oldest_processing_age_s: 31.3,
    stuck_candidates: 1,
    stuck_timeout_ms: 90000
  });
  assert.equal(outbox.worker.running, true);
  assert.equal(outbox.worker.active_count, 1);
  assert.deepEqual(outbox.payment_maintenance, {
    authorizations_past_declared_validity: 4,
    authorizations_renewed: 7,
    deal_lifetime_bounded_by_authorization: false
  });

  const notificationRes = await app.inject({ method: "GET", url: "/api/admin/notifications-status", headers });
  assert.equal(notificationRes.statusCode, 200, notificationRes.body);
  const notifications = notificationRes.json() as any;
  assert.equal(notifications.notifications.pending, 2);
  assert.equal(notifications.notifications.unique_event_keys, 14);
  assert.equal(notifications.notifications.oldest_pending_age_s, 75.5);
  assert.deepEqual(notifications.notifications.provider, {
    code: "log-only",
    mode: "log-only",
    external_delivery: false
  });
  assert.deepEqual(notifications.by_channel, [{ channel: "email", pending: 1, sent: 5, failed: 1 }]);
  assert.equal(notifications.recent_events[0].adapter, "log-only");
  assert.equal(notifications.recent_events[0].adapter_mode, "log-only");

  const invoiceRes = await app.inject({ method: "GET", url: "/api/admin/invoice-status", headers });
  assert.equal(invoiceRes.statusCode, 200, invoiceRes.body);
  const invoice = invoiceRes.json() as any;
  assert.equal(invoiceEnsureCount, 1);
  assert.equal(invoice.invoice_documents.pending, 1);
  assert.equal(invoice.invoice_documents.unique_document_keys, 13);
  assert.equal(invoice.invoice_documents.provider.code, "internal-invoice-ledger");
  assert.deepEqual(invoice.provider_failures_by_class, [{ result_class: "temporary_fail", count: 2 }]);
  assert.deepEqual(invoice.webhook_ingestion, {
    pending: 1,
    queued: 2,
    ignored: 3,
    failed: 1,
    duplicate_rate: 0.3
  });
  assert.deepEqual(invoice.webhook_security, {
    signature_failures: 2,
    latest_signature_failure_at: "latest"
  });
  assert.deepEqual(invoice.reconcile_backlog, { pending_reconcile: 4 });
  assert.deepEqual(invoice.by_type, [{ document_type: "charge_receipt", pending: 1, issued: 9, failed: 1 }]);

  console.log("ADMIN_OPERATIONAL_STATUS_READ_PASS");
} finally {
  await app.close();
}
