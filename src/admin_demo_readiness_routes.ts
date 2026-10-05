// ADMIN DEMO READINESS — the read-only Demo Readiness Command Center: a
// structured verdict on whether the environment is ready for presentation
// (deploy freshness, database/schema, outbox queues, demo data, provider
// configuration summaries, product-contract constants).
//
// Lean Refactor: the route below was moved verbatim out of
// src/frontend_runtime.ts, together with its registration-time timestamp
// (_demoReadinessStartedAt). Nothing about it changed: same method and path,
// same admin read guard (requireAdminRead) as the first statement, same
// read-only queries in one deps.withTx, same verdict rules, same provider,
// freshness and environment fields, same response shape. The runtime hands
// this module exactly what the handler used before (dependency injection):
// its deploy-freshness reader, the payment and payout providers, the
// demo-preview flag, the invoice and notification summaries and the public
// Mall flag reader are the runtime's own, injected — not copied. Provider
// summaries are only read (getPaymentProviderSummary /
// getPayoutProviderSummary); no provider is activated. The register function
// is called at the original point, so the timestamp is taken at the same
// moment of startup as before.
import type { FastifyInstance } from "fastify";
import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";
import { getPayoutProviderSummary, type PayoutProvider } from "./payout_provider.js";
import { SITON_PLATFORM_FEE_RATE } from "./platform_fee_money.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type AdminDemoReadinessRouteDeps = {
  withTx: WithTx;
  /** The runtime's admin READ guard. Owns the denial response. */
  requireAdminRead: (req: any, reply: any) => Promise<boolean>;
  /** The runtime's deploy-freshness reader (expected vs running commit). */
  deployFreshness: () => { expected_commit_sha: string | null; runtime_commit_sha: string; is_stale: boolean; evidence: string };
  /** The runtime's payment provider (summarised, never called). */
  paymentProvider: PaymentProvider;
  /** The runtime's payout provider (summarised, never called). */
  payoutProvider: PayoutProvider;
  /** The runtime's demo-preview flag. */
  isDemoPreview: boolean;
  /** The runtime's invoice provider summary, when configured. */
  invoiceSummary?: { provider: string; mode: string; configured?: boolean; external_issuance?: boolean } | undefined;
  /** The runtime's notification service summary. */
  notificationSummary: { provider: string; mode: string; external_delivery: boolean };
  /** The runtime's public Mall launch-flag reader (read per request). */
  isPublicMallEnabled: () => boolean;
};

export function registerAdminDemoReadinessRoutes(app: FastifyInstance, deps: AdminDemoReadinessRouteDeps) {
  const {
    requireAdminRead,
    deployFreshness,
    payoutProvider,
    isPublicMallEnabled
  } = deps;

  // ── Demo Readiness Command Center ───────────────────────────────────────
  // Read-only. Returns a structured verdict on whether the demo environment is
  // genuinely ready for presentation and future real-money integration.
  // Never mutates state, never triggers providers.
  const _demoReadinessStartedAt = new Date().toISOString();
  app.get("/api/admin/demo-readiness", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;

    const freshness = deployFreshness();
    const runtimeCommit = freshness.runtime_commit_sha;
    const expectedCommit = freshness.expected_commit_sha || "";

    const blockers: string[] = [];
    const warnings: string[] = [];

    // Deploy freshness
    let isStale = false;
    let deployFreshnessEvidence = "";
    if (expectedCommit) {
      isStale = runtimeCommit !== "unknown" && runtimeCommit !== expectedCommit;
      if (isStale) {
        blockers.push("runtime commit does not match expected commit");
        deployFreshnessEvidence = "runtime=" + runtimeCommit + " expected=" + expectedCommit;
      } else if (runtimeCommit === "unknown") {
        warnings.push("runtime commit SHA is unknown");
        deployFreshnessEvidence = freshness.evidence;
      } else {
        deployFreshnessEvidence = "commit " + runtimeCommit + " matches expected";
      }
    } else {
      warnings.push("expected commit is not configured");
      deployFreshnessEvidence = freshness.evidence;
      if (runtimeCommit === "unknown") warnings.push("runtime commit SHA is unknown");
    }

    // DB + outbox + demo-data (read-only)
    const CRITICAL_TABLES = [
      "deals", "participants", "outbox_events", "outbox_dlq",
      "idempotency_log", "payment_attempts", "webhook_events",
      "seller_accounts", "audit_log", "notification_events"
    ];
    const OPTIONAL_TABLES = ["invoice_documents", "seller_payout_batches", "operational_cases"];

    let dbOk = false;
    let schemaReady = false;
    let migrationsVisible = false;
    let requiredTablesPresent = false;
    const missingTables: string[] = [];
    let outboxPending = 0, outboxProcessing = 0, outboxFailed = 0, dlqCount = 0;
    let oldestPendingAgeSeconds: number | null = null;
    let hasDemoSeller = false, hasPublicDeal = false, hasJoinableDeal = false;
    let hasCompletedDeal = false, hasFailedDeal = false;

    try {
      await deps.withTx(async (c: any) => {
        const schemaRes = await c.query(
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'siton'"
        );
        schemaReady = schemaRes.rows.length > 0;

        if (schemaReady) {
          const tableRes = await c.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'siton'"
          );
          const existingTables = new Set(tableRes.rows.map((r: any) => String(r.table_name)));
          migrationsVisible = existingTables.has("deals");

          for (const t of CRITICAL_TABLES) {
            if (!existingTables.has(t)) missingTables.push(t);
          }
          requiredTablesPresent = missingTables.length === 0;
          if (!requiredTablesPresent) {
            blockers.push("critical tables missing: " + missingTables.join(", "));
          }
          for (const t of OPTIONAL_TABLES) {
            if (!existingTables.has(t)) warnings.push("optional table missing: " + t);
          }

          const [outboxRow, dlqRow, demoRow] = await Promise.all([
            c.query(
              "SELECT " +
              "COUNT(*) FILTER (WHERE status='pending')    AS pending, " +
              "COUNT(*) FILTER (WHERE status='processing') AS processing, " +
              "COUNT(*) FILTER (WHERE status='failed')     AS failed, " +
              "EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s " +
              "FROM siton.outbox_events"
            ),
            c.query("SELECT COUNT(*) AS dlq_count FROM siton.outbox_dlq"),
            c.query(
              "SELECT " +
              "(SELECT COUNT(*) FROM siton.seller_accounts)::int AS seller_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state <> 'Draft')::int AS public_deal_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state IN ('PendingTarget','TargetReached'))::int AS joinable_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state = 'Completed')::int AS completed_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state IN ('Failed','Cancelled'))::int AS failed_count"
            )
          ]);

          const o = outboxRow.rows[0];
          outboxPending    = Number(o.pending    ?? 0);
          outboxProcessing = Number(o.processing ?? 0);
          outboxFailed     = Number(o.failed     ?? 0);
          dlqCount         = Number(dlqRow.rows[0].dlq_count ?? 0);
          oldestPendingAgeSeconds = o.oldest_pending_age_s != null
            ? Number(Number(o.oldest_pending_age_s).toFixed(1)) : null;

          const dm = demoRow.rows[0];
          hasDemoSeller    = Number(dm.seller_count)      > 0;
          hasPublicDeal    = Number(dm.public_deal_count) > 0;
          hasJoinableDeal  = Number(dm.joinable_count)    > 0;
          hasCompletedDeal = Number(dm.completed_count)   > 0;
          hasFailedDeal    = Number(dm.failed_count)      > 0;
        }
        dbOk = schemaReady && requiredTablesPresent;
      });
    } catch (err: any) {
      blockers.push("database check failed: " + (err?.message ?? String(err)));
    }

    if (!dbOk && !blockers.some((b) => b.startsWith("database check failed") || b.startsWith("critical tables"))) {
      blockers.push("database is not ready");
    }
    if (dbOk) {
      if (outboxFailed > 0)
        warnings.push("outbox has " + outboxFailed + " failed event(s)");
      if (dlqCount > 0)
        blockers.push("outbox DLQ has " + dlqCount + " unresolved event(s)");
      if (oldestPendingAgeSeconds != null && oldestPendingAgeSeconds > 3600)
        warnings.push("oldest pending outbox event is " + Math.round(oldestPendingAgeSeconds / 60) + "m old");
    }

    if (!hasDemoSeller)    warnings.push("no demo seller account found");
    if (!hasPublicDeal)    warnings.push("no public (non-draft) deal found");
    if (!hasJoinableDeal)  warnings.push("no joinable deal in PendingTarget or TargetReached");
    if (!hasCompletedDeal) warnings.push("no completed deal found (demo end-state missing)");
    if (!hasFailedDeal)    warnings.push("no failed/cancelled deal found (failure-state demo missing)");

    // Providers — read config only, never activate
    const paymentSummary = getPaymentProviderSummary(deps.paymentProvider);
    const payoutSummary  = getPayoutProviderSummary(payoutProvider);

    // Product contract — static constants
    const feeRateOk = SITON_PLATFORM_FEE_RATE === 0.08;
    if (!feeRateOk) blockers.push("platform fee rate is " + SITON_PLATFORM_FEE_RATE + ", expected 0.08");

    const verdict: "ready" | "warning" | "blocked" =
      blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready";

    return {
      ok: verdict !== "blocked",
      verdict,
      environment: {
        node_env:           process.env.NODE_ENV || "development",
        app_env:            process.env.APP_ENV || process.env.APP_DEPLOYMENT_MODE || "demo-preview",
        demo_preview:       deps.isDemoPreview,
        commit_sha:         runtimeCommit,
        build_time:         null,
        runtime_started_at: _demoReadinessStartedAt
      },
      deploy_freshness: {
        expected_commit_sha: freshness.expected_commit_sha,
        runtime_commit_sha:  freshness.runtime_commit_sha,
        is_stale:            freshness.is_stale,
        evidence:            deployFreshnessEvidence
      },
      database: {
        ok:                      dbOk,
        schema_ready:            schemaReady,
        migrations_visible:      migrationsVisible,
        required_tables_present: requiredTablesPresent,
        missing_tables:          missingTables
      },
      providers: {
        payment: {
          provider:   paymentSummary.provider,
          mode:       paymentSummary.mode,
          configured: paymentSummary.configured,
          is_mock:    paymentSummary.mock_backed
        },
        invoice: {
          provider:          deps.invoiceSummary?.provider ?? "internal-invoice-ledger",
          mode:              deps.invoiceSummary?.mode ?? "internal",
          configured:        deps.invoiceSummary?.configured ?? false,
          external_issuance: deps.invoiceSummary?.external_issuance ?? false
        },
        payout: {
          provider:          payoutSummary.provider,
          mode:              payoutSummary.mode,
          configured:        payoutSummary.configured,
          external_transfer: payoutSummary.external_transfer_executed
        },
        notifications: {
          provider:          deps.notificationSummary?.provider ?? "log-only",
          mode:              deps.notificationSummary?.mode ?? "log-only",
          external_delivery: deps.notificationSummary?.external_delivery ?? false
        }
      },
      queues: {
        outbox_pending:             outboxPending,
        outbox_processing:          outboxProcessing,
        outbox_failed:              outboxFailed,
        dlq_count:                  dlqCount,
        oldest_pending_age_seconds: oldestPendingAgeSeconds
      },
      demo_data: {
        has_demo_seller:    hasDemoSeller,
        has_public_deal:    hasPublicDeal,
        has_joinable_deal:  hasJoinableDeal,
        has_completed_deal: hasCompletedDeal,
        has_failed_deal:    hasFailedDeal
      },
      product_contract: {
        direct_links_first_class:       true,
        public_mall_discovery:          isPublicMallEnabled(), // PR E: reports the launch flag, not a constant
        mall_owns_state_or_money:       false,
        distributor_attribution_only:  true,
        platform_fee_8_percent:        feeRateOk,
        platform_fee_rate:             SITON_PLATFORM_FEE_RATE,
        buyer_repeat_purchase_allowed: true
      },
      blockers,
      warnings,
      checked_at: new Date().toISOString()
    };
  });
}
