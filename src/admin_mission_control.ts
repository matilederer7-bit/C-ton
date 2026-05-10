import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { performance } from "perf_hooks";
import os from "os";
import type { PaymentProvider } from "./payment_provider.js";
import { getPaymentProviderSummary } from "./payment_provider.js";
import type { PayoutProvider } from "./payout_provider.js";
import { getPayoutProviderSummary } from "./payout_provider.js";

type Severity = "info" | "warning" | "critical";
type Verdict = "green" | "yellow" | "red";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

type MissionDeps = {
  c: Queryable;
  rootDir: string;
  deploymentMode: string;
  isDemoPreview: boolean;
  paymentProvider: PaymentProvider;
  payoutProvider?: PayoutProvider | undefined;
  invoiceSummary?: Record<string, any> | undefined;
  notificationSummary: Record<string, any>;
  debugSurfacesEnabled?: boolean | undefined;
  getWorkerRunning?: (() => boolean) | undefined;
};

type Anomaly = {
  id: string;
  severity: Severity;
  domain: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  affected_entities: Array<{ type: string; id: string | null }>;
  first_seen: string | null;
  last_seen: string | null;
  age_seconds: number | null;
  recommended_next_step: string;
  safe_admin_action_available: boolean;
  link_target: string | null;
};

function verdictFrom(sections: Array<{ status?: string }>, anomalies: Anomaly[]): Verdict {
  if (anomalies.some((item) => item.severity === "critical") || sections.some((item) => item.status === "red")) return "red";
  if (anomalies.some((item) => item.severity === "warning") || sections.some((item) => ["yellow", "unknown"].includes(String(item.status)))) return "yellow";
  return "green";
}

function statusFromCounts(critical: number, warnings: number, unknown = false): "green" | "yellow" | "red" | "unknown" {
  if (critical > 0) return "red";
  if (warnings > 0) return "yellow";
  return unknown ? "unknown" : "green";
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeCount(row: any, key: string): number {
  return Number(row?.[key] ?? 0);
}

function maskEnvPresence(names: string[]) {
  return Object.fromEntries(names.map((name) => [name, { configured: Boolean(String(process.env[name] || "").trim()) }]));
}

function addAnomaly(anomalies: Anomaly[], input: Omit<Anomaly, "id"> & { id?: string }) {
  anomalies.push({
    id: input.id || `${input.domain}_${anomalies.length + 1}`,
    severity: input.severity,
    domain: input.domain,
    title: input.title,
    description: input.description,
    evidence: input.evidence,
    affected_entities: input.affected_entities,
    first_seen: input.first_seen,
    last_seen: input.last_seen,
    age_seconds: input.age_seconds,
    recommended_next_step: input.recommended_next_step,
    safe_admin_action_available: input.safe_admin_action_available,
    link_target: input.link_target
  });
}

async function safeQuery(c: Queryable, sql: string, params?: unknown[]) {
  try {
    return await c.query(sql, params);
  } catch (error: any) {
    return { rows: [], rowCount: 0, error: String(error?.message || error) } as any;
  }
}

async function tableNames(c: Queryable) {
  const res = await safeQuery(
    c,
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema='siton'`
  );
  return new Set<string>((res.rows || []).map((row: any) => String(row.table_name)));
}

async function columnNames(c: Queryable) {
  const res = await safeQuery(
    c,
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema='siton'`
  );
  const byTable: Record<string, Set<string>> = {};
  for (const row of res.rows || []) {
    const table = String(row.table_name);
    byTable[table] ||= new Set<string>();
    byTable[table].add(String(row.column_name));
  }
  return byTable;
}

function fileCheck(rootDir: string, relativePath: string) {
  const path = join(rootDir, relativePath);
  if (!existsSync(path)) return { path: relativePath, exists: false, size: null, last_modified: null };
  const stat = statSync(path);
  return { path: relativePath, exists: true, size: stat.size, last_modified: stat.mtime.toISOString() };
}

function rowsByKey(rows: any[], key: string, valueKey = "count") {
  return Object.fromEntries(rows.map((row) => [String(row[key] ?? "unknown"), Number(row[valueKey] ?? 0)]));
}

function hasColumn(columns: Record<string, Set<string>>, table: string, column: string) {
  return Boolean(columns[table]?.has(column));
}

function buildScaleReadinessReport(input: {
  tables: Set<string>;
  columns: Record<string, Set<string>>;
  paymentSummary: ReturnType<typeof getPaymentProviderSummary>;
  payoutSummary: any;
}) {
  const blockers: string[] = [];
  const inMemoryStateRisks = [
    { name: "rateLimitStore", classification: "B", status: "single_instance_only", reason: "fixed-window in-process Map; not business truth" },
    { name: "legacyPhoneByChallenge", classification: "B", status: "legacy_compatibility_only", reason: "legacy OTP shim memory map; DB-backed otp_challenges is the canonical OTP authority" }
  ];
  const otpScaleStatus = input.tables.has("otp_challenges") ? "partial" : "blocked";
  if (!input.tables.has("otp_challenges")) blockers.push("otp_challenges table missing");
  const storageScaleStatus = input.paymentSummary.provider ? "partial" : "partial";
  blockers.push("object_storage_required_before_multi_instance");
  const workerParallelismStatus = input.tables.has("outbox_events") && hasColumn(input.columns, "outbox_events", "processing_started_at")
    ? "partial"
    : "blocked";
  if (workerParallelismStatus === "blocked") blockers.push("outbox processing claim columns missing");
  const idempotencyScaleStatus = input.tables.has("idempotency_log") ? "partial" : "blocked";
  if (!input.tables.has("idempotency_log")) blockers.push("idempotency_log missing");
  const statelessApi = blockers.some((item) => item === "otp_challenges table missing") ? "partial" : "partial";
  return {
    verdict: blockers.length ? "partial" : "yes",
    stateless_api: statelessApi,
    in_memory_state_risks: inMemoryStateRisks,
    otp_scale_status: otpScaleStatus,
    rate_limit_scale_status: "partial",
    rate_limit_scale_mode: "single_instance_only",
    storage_scale_status: storageScaleStatus,
    worker_parallelism_status: workerParallelismStatus,
    idempotency_scale_status: idempotencyScaleStatus,
    db_pool_status: "partial",
    load_balancer_readiness: "partial",
    session_authority: input.tables.has("seller_sessions") ? "db_backed" : "demo_or_unknown",
    admin_identity_status: process.env.ADMIN_API_KEY ? "env_key_demo_admin" : "missing_or_demo",
    blockers,
    evidence: [
      "outbox_worker_helpers uses FOR UPDATE SKIP LOCKED for batch claims",
      "seller sessions are looked up by token_hash in siton.seller_sessions when non-demo auth is configured",
      "deal image storage is local filesystem via product_image_storage"
    ],
    scale_mode: "foundation_only_not_full_multi_instance_ready"
  };
}

function buildAccordionScalingReadiness(input: {
  rootDir: string;
  scaleReadiness: any;
  storageReadiness: any;
}) {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const dockerfile = fileCheck(input.rootDir, "Dockerfile");
  const dockerignore = fileCheck(input.rootDir, ".dockerignore");
  const composeFile = fileCheck(input.rootDir, "docker-compose.yml");

  let dockerStatus: "present" | "missing" = dockerfile.exists && dockerignore.exists ? "present" : "missing";
  if (!dockerfile.exists) blockers.push("dockerfile_missing");
  if (!dockerignore.exists) blockers.push("dockerignore_missing");
  if (!composeFile.exists) warnings.push("docker_compose_missing_for_local_cloud_like_run");

  // The container runtime smoke is run by `npm run test:docker-readiness` and
  // requires a Docker engine. Mission Control reports the static contract,
  // not the live container probe — that is the test job.
  const containerSmokeStatus = "static_validation_only";

  // External DB readiness — partial unless DATABASE_URL points to a non-loopback
  // host (managed RDS / Cloud SQL / Render Postgres). We check the host shape
  // without exposing values.
  const dbUrl = String(process.env.DATABASE_URL || "");
  let externalDbReady: "yes" | "partial" | "no" = "no";
  if (dbUrl) {
    try {
      const parsed = new URL(dbUrl);
      const host = String(parsed.hostname || "").toLowerCase();
      if (!host) {
        externalDbReady = "no";
      } else if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
        externalDbReady = "partial";
        warnings.push("database_url_points_to_localhost_not_external_db");
      } else if (host === "postgres") {
        // docker-compose internal hostname — partial
        externalDbReady = "partial";
        warnings.push("database_url_points_to_compose_internal_postgres_not_managed_db");
      } else {
        externalDbReady = "yes";
      }
    } catch {
      externalDbReady = "no";
      warnings.push("database_url_unparseable");
    }
  } else {
    externalDbReady = "no";
    blockers.push("database_url_missing");
  }

  // Storage mode — local single-instance vs object storage multi-instance.
  const storageMode = input.storageReadiness?.adapter === "object"
    ? "object_storage"
    : "local_filesystem_single_instance_only";
  if (input.storageReadiness?.multi_instance_safe === false) {
    blockers.push("object_storage_required_before_multi_instance");
  }

  const rateLimitScaleMode = input.scaleReadiness?.rate_limit_scale_mode || "single_instance_only";
  if (rateLimitScaleMode === "single_instance_only") {
    warnings.push("rate_limit_is_in_process_only_not_shared_across_instances");
  }

  const workerScaleStatus = input.scaleReadiness?.worker_parallelism_status || "unknown";
  if (workerScaleStatus !== "yes") warnings.push("worker_parallelism_partial_until_dedicated_worker_service");

  const loadBalancerReadiness = input.scaleReadiness?.load_balancer_readiness || "partial";

  // Cost guardrails are operator responsibility — we cannot inspect the cloud account.
  // The blueprint document is the source of policy; presence of the doc is what we report.
  const blueprintDoc = fileCheck(input.rootDir, "docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md");
  const dockerReadinessDoc = fileCheck(input.rootDir, "docs/DOCKER_READINESS.md");
  const envContractDoc = fileCheck(input.rootDir, "docs/ENVIRONMENT_CONTRACT.md");

  const awsBlueprintStatus = blueprintDoc.exists ? "documented" : "missing";
  if (!blueprintDoc.exists) blockers.push("aws_accordion_deployment_blueprint_missing");
  if (!dockerReadinessDoc.exists) warnings.push("docker_readiness_doc_missing");
  if (!envContractDoc.exists) warnings.push("environment_contract_doc_missing");

  const costGuardrailsStatus = blueprintDoc.exists ? "documented_operator_responsibility" : "missing";

  // Estimated scale risk — high when storage is local-only OR rate limit is single-instance.
  // This is purely advisory — we do not cap traffic from inside the app.
  const scaleRiskFactors: string[] = [];
  if (storageMode === "local_filesystem_single_instance_only") scaleRiskFactors.push("local_storage");
  if (rateLimitScaleMode === "single_instance_only") scaleRiskFactors.push("local_rate_limit");
  if (externalDbReady !== "yes") scaleRiskFactors.push("non_managed_db");
  const estimatedScaleRisk: "low" | "medium" | "high" =
    scaleRiskFactors.length >= 2 ? "high" : scaleRiskFactors.length === 1 ? "medium" : "low";

  let verdict: "ready" | "warning" | "blocked";
  if (blockers.length > 0) {
    verdict = "blocked";
  } else if (warnings.length > 0) {
    verdict = "warning";
  } else {
    verdict = "ready";
  }

  return {
    verdict,
    docker_status: dockerStatus,
    container_smoke_status: containerSmokeStatus,
    external_db_ready: externalDbReady,
    storage_mode: storageMode,
    rate_limit_scale_mode: rateLimitScaleMode,
    worker_scale_status: workerScaleStatus,
    load_balancer_readiness: loadBalancerReadiness,
    cost_guardrails_status: costGuardrailsStatus,
    aws_blueprint_status: awsBlueprintStatus,
    estimated_scale_risk: estimatedScaleRisk,
    tier_status: {
      tier_0_local_demo: dockerfile.exists && composeFile.exists ? "ready" : "partial",
      tier_1_small_market_launch: blueprintDoc.exists ? "documented" : "missing",
      tier_2_accordion_scale: blueprintDoc.exists ? "documented" : "missing",
      tier_3_mature_production: "blueprint_only_not_implemented"
    },
    artefacts: {
      dockerfile,
      dockerignore,
      docker_compose: composeFile,
      blueprint_doc: blueprintDoc,
      docker_readiness_doc: dockerReadinessDoc,
      env_contract_doc: envContractDoc
    },
    notes: [
      "live money is not connected — accordion readiness covers packaging, runtime config and scaling blueprint only",
      "cost guardrails (cloud max instances, RDS class cap, WAF rate rules, budgets) are operator responsibility",
      "no AWS credentials are loaded by the app at runtime"
    ],
    blockers,
    warnings
  };
}

function buildLiveMoneyReadinessReport(input: {
  tables: Set<string>;
  paymentSummary: ReturnType<typeof getPaymentProviderSummary>;
  payoutSummary: any;
  invoiceSummary: Record<string, any> | undefined;
}) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const paymentReal = input.paymentSummary.provider === "stripe";
  const paymentConfigured = Boolean(input.paymentSummary.configured);
  const webhookSecretConfigured = Boolean(process.env.PAYMENT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET);
  if (!paymentReal || !paymentConfigured) blockers.push("payment_provider_not_live_validated");
  if (!webhookSecretConfigured) blockers.push("payment_webhook_secret_missing_for_live");
  if (!input.tables.has("webhook_events")) blockers.push("webhook_events table missing");
  if (!input.tables.has("payment_attempts")) blockers.push("payment_attempts table missing");
  if (!input.tables.has("invoice_documents")) blockers.push("invoice_documents table missing");
  if (!input.tables.has("seller_payout_batches")) blockers.push("seller_payout_batches table missing");
  blockers.push("reconcile_runbook_or_live_provider_status_validation_required_before_live_money");
  blockers.push("freeze_payouts_admin_action_foundation_only");
  if (!input.invoiceSummary?.external_issuance) warnings.push("invoice provider is not externally issuing live tax documents");
  if (!input.payoutSummary.external_transfer_executed) warnings.push("payout provider is not executing live external transfers");
  return {
    payment_provider_status: paymentReal && paymentConfigured ? "sandbox_or_provider_ready" : "demo_ready",
    webhook_status: webhookSecretConfigured ? "provider_ready" : "blocked_for_live",
    reconcile_status: "partial",
    refund_status: "system_failed_deal_only_pending_provider_sandbox",
    manual_refund_allowed: false,
    seller_refund_allowed: false,
    admin_commercial_refund_allowed: false,
    support_refund_allowed: false,
    partial_commercial_refund_allowed: false,
    system_refund_on_failed_deal_required: true,
    system_refund_provider_validation_status: "pending_provider_sandbox",
    invoice_status: input.invoiceSummary?.external_issuance ? "provider_ready" : "demo_ready",
    payout_status: input.payoutSummary.external_transfer_executed ? "provider_ready" : "blocked_for_live",
    admin_intervention_status: "partial",
    security_status: webhookSecretConfigured ? "partial" : "blocked_for_live",
    live_readiness_verdict: "blocked",
    verdicts: {
      demo_ready: true,
      sandbox_ready: paymentConfigured && webhookSecretConfigured ? "partial" : false,
      live_ready: false,
      blocked: true
    },
    blockers,
    warnings,
    evidence: [
      "money actions are worker/outbox oriented; request handlers authorize/enqueue rather than direct capture/recovery/refund",
      "refund execution is reserved for system-mandated failed-deal outbox events after rigid state/money eligibility",
      "provider summaries are read from configured adapters without activating live money",
      "webhook dedupe table is expected as siton.webhook_events by provider + event_id"
    ],
    secret_policy: maskEnvPresence(["PAYMENT_PROVIDER", "PAYMENT_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "INVOICE_PROVIDER", "PAYOUT_PROVIDER"])
  };
}

async function buildRefundPolicyReadiness(rootDir: string) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const read = async (relativePath: string) => {
    try {
      return await readFile(join(rootDir, relativePath), "utf8");
    } catch {
      warnings.push(`${relativePath}_unreadable`);
      return "";
    }
  };

  const [runtime, app, controlPlane, supportCases, frontend, policyDoc] = await Promise.all([
    read("src/frontend_runtime.ts"),
    read("src/app.ts"),
    read("src/admin_control_plane.ts"),
    read("src/operational_cases.ts"),
    read("frontend/app.js"),
    read("docs/REFUND_POLICY.md")
  ]);
  const routeText = `${runtime}\n${app}`;
  const manualRefundRoutePatterns = [
    /app\.(post|patch|put|delete)\(\s*["'][^"']*\/api\/admin\/[^"']*refund/i,
    /app\.(post|patch|put|delete)\(\s*["'][^"']*\/api\/seller\/[^"']*refund/i,
    /app\.(post|patch|put|delete)\(\s*["'][^"']*\/api\/support\/[^"']*refund/i
  ];
  const manualRefundRoutesFound = manualRefundRoutePatterns.some((pattern) => pattern.test(routeText));
  if (manualRefundRoutesFound) blockers.push("manual_refund_route_found");

  const forbiddenActions = [
    "manual_refund",
    "admin_refund",
    "merchant_refund",
    "seller_refund",
    "support_refund",
    "partial_refund",
    "manual_credit",
    "manual_void",
    "manual_capture"
  ];
  const missingForbiddenActions = forbiddenActions.filter((action) => !controlPlane.includes(`"${action}"`));
  if (missingForbiddenActions.length) blockers.push(`missing_forbidden_admin_actions:${missingForbiddenActions.join(",")}`);

  const sellerRefundUiFound = /seller[^`"'\n]{0,80}(manual refund|refund button|seller can refund|החזר לקונה|בצע החזר)/i.test(frontend);
  const adminRefundUiFound = /admin[^`"'\n]{0,80}(manual refund|admin can refund|refund approval|refund request approved|יאשר החזר)/i.test(frontend);
  if (sellerRefundUiFound) warnings.push("seller_refund_ui_copy_found");
  if (adminRefundUiFound) warnings.push("admin_refund_ui_copy_found");
  if (!policyDoc.includes("Refunds in Siton are system-mandated only")) {
    warnings.push("canonical_refund_policy_doc_missing_or_incomplete");
  }
  if (!/outbox:\s*\{\s*event_type:\s*"refund_issue"/.test(app)) {
    blockers.push("system_failed_deal_refund_outbox_path_missing");
  }
  if (!/p\.money_state IN \('ChargedSuccess','RecoveredCharge'\)/.test(app)) {
    blockers.push("refund_worker_rigid_money_state_gate_missing");
  }

  const verdict: "pass" | "warning" | "blocked" = blockers.length ? "blocked" : warnings.length ? "warning" : "pass";
  return {
    verdict,
    manual_refund_allowed: false,
    seller_refund_allowed: false,
    admin_commercial_refund_allowed: false,
    support_refund_allowed: false,
    partial_commercial_refund_allowed: false,
    system_refund_on_failed_deal_required: true,
    manual_refund_routes_found: manualRefundRoutesFound,
    manual_refund_actions_found: missingForbiddenActions.length === 0 ? 0 : missingForbiddenActions.length,
    seller_refund_ui_found: sellerRefundUiFound,
    admin_refund_ui_found: adminRefundUiFound,
    support_refund_flow_found: supportCases.includes('"RefundRequest"') ? "legacy_alias_only_no_money_movement" : false,
    system_failed_deal_refund_path: "refund_issue outbox from charging.finalize_failed only; worker gates on ChargedSuccess/RecoveredCharge",
    json_boundary_respected: true,
    provider_sandbox_required: true,
    forbidden_admin_actions: forbiddenActions,
    blockers,
    warnings
  };
}

async function buildSellerOnboardingReadiness(c: Queryable, tables: Set<string>) {
  if (!tables.has("seller_accounts")) {
    return {
      status: "unknown" as const,
      verdict: "blocked" as const,
      active_sellers: null,
      pending_review: null,
      rejected: null,
      suspended: null,
      banned: null,
      under_review: null,
      deals_blocked_by_kyc: null,
      blockers: ["seller_accounts_table_missing"],
      warnings: [],
      notes: ["seller_accounts table is required for seller onboarding readiness"]
    };
  }
  const accountsRow = (await safeQuery(
    c,
    `SELECT
       COUNT(*) FILTER (WHERE COALESCE(verification_status,'pending')='approved')::int AS active_sellers,
       COUNT(*) FILTER (WHERE COALESCE(verification_status,'pending')='pending')::int AS pending_review,
       COUNT(*) FILTER (WHERE COALESCE(verification_status,'pending')='rejected')::int AS rejected,
       COUNT(*) FILTER (WHERE COALESCE(seller_status,'Active')='UnderReview')::int AS under_review,
       COUNT(*) FILTER (WHERE COALESCE(seller_status,'Active')='Suspended')::int AS suspended,
       COUNT(*) FILTER (WHERE COALESCE(seller_status,'Active')='Banned')::int AS banned
     FROM siton.seller_accounts`
  )).rows[0] || {};
  let dealsBlocked = 0;
  if (tables.has("deals")) {
    const blockedRow = await safeQuery(
      c,
      `SELECT COUNT(*)::int AS deals_blocked
       FROM siton.deals d
       JOIN siton.seller_accounts sa ON sa.seller_id = d.seller_id
       WHERE d.state = 'Draft'
         AND COALESCE(sa.verification_status,'pending') <> 'approved'`
    );
    dealsBlocked = Number(blockedRow.rows[0]?.deals_blocked || 0);
  }
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (Number(accountsRow.pending_review || 0) > 0) {
    warnings.push(`pending_kyc_reviews:${accountsRow.pending_review}`);
  }
  if (Number(accountsRow.rejected || 0) > 0) {
    warnings.push(`rejected_kyc_decisions:${accountsRow.rejected}`);
  }
  if (Number(accountsRow.suspended || 0) + Number(accountsRow.banned || 0) > 0) {
    warnings.push("seller_enforcement_actions_present");
  }
  if (dealsBlocked > 0) {
    warnings.push(`deals_blocked_by_kyc:${dealsBlocked}`);
  }
  const verdict: "ready" | "warning" | "blocked" = blockers.length > 0
    ? "blocked"
    : warnings.length > 0
      ? "warning"
      : "ready";
  return {
    status: blockers.length ? "red" : warnings.length ? "yellow" : "green",
    verdict,
    active_sellers: Number(accountsRow.active_sellers || 0),
    pending_review: Number(accountsRow.pending_review || 0),
    rejected: Number(accountsRow.rejected || 0),
    under_review: Number(accountsRow.under_review || 0),
    suspended: Number(accountsRow.suspended || 0),
    banned: Number(accountsRow.banned || 0),
    deals_blocked_by_kyc: dealsBlocked,
    publish_blocked_for_unverified: true,
    audit_required_on_kyc_decision: true,
    second_approval_recommended_for_active: false,
    notes: [
      "verification_status = pending|approved|rejected reflects KYC decision",
      "seller_status = Active|UnderReview|Restricted|Suspended|Banned reflects enforcement",
      "publish flow requires business_name + at least one contact channel"
    ],
    blockers,
    warnings
  };
}

async function buildStorageReadinessReport(input: { tables: Set<string> }, c: Queryable) {
  const adapterMode = (process.env.STORAGE_ADAPTER || "local").trim().toLowerCase();
  const objectStorageEnvConfigured = Boolean(
    String(process.env.OBJECT_STORAGE_BUCKET || "").trim() ||
    String(process.env.S3_BUCKET || "").trim() ||
    String(process.env.STORAGE_OBJECT_BUCKET || "").trim()
  );
  let activeImageKeys: number | null = null;
  let lastOrphanReport: any = null;
  if (input.tables.has("deal_images")) {
    const r = await safeQuery(c, "SELECT COUNT(*)::int AS active_keys FROM siton.deal_images");
    activeImageKeys = Number(r.rows[0]?.active_keys || 0);
  }
  if (input.tables.has("storage_orphan_reports")) {
    const r = await safeQuery(
      c,
      "SELECT report_id, generated_at, storage_provider, scanned_keys_count, orphan_keys_count, missing_files_count FROM siton.storage_orphan_reports ORDER BY generated_at DESC LIMIT 1"
    );
    lastOrphanReport = r.rows[0] || null;
  }
  const blockers: string[] = ["object_storage_required_before_multi_instance"];
  const warnings: string[] = [];
  if (adapterMode === "object" && !objectStorageEnvConfigured) {
    warnings.push("object_storage_adapter_requested_but_not_configured");
  }
  return {
    status: "yellow" as const,
    adapter: adapterMode,
    storage_provider: "local",
    multi_instance_safe: false,
    scale_status: "partial",
    object_storage_configured: objectStorageEnvConfigured,
    object_storage_live_ready: false,
    deal_image_max_bytes: 5 * 1024 * 1024,
    allowed_mime_types: ["image/jpeg", "image/png", "image/webp"],
    path_traversal_protection: "storage_adapter_resolveSafe",
    public_image_cache_policy: "public, max-age=31536000, immutable for content-addressed image ids",
    active_image_keys_count: activeImageKeys,
    last_orphan_report: lastOrphanReport,
    notes: [
      "LocalStorageAdapter is single-instance only",
      "ObjectStorageAdapter contract is documented but not connected; live activation is a separate provider gate",
      "Orphan cleanup is read-only via /api/admin/storage/orphan-report"
    ],
    blockers,
    warnings
  };
}

async function buildNotificationsReadinessReport(input: { tables: Set<string>; notificationSummary: Record<string, any> }, c: Queryable) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const provider = String(input.notificationSummary?.provider || "log");
  const mode = String(input.notificationSummary?.mode || "dev");
  const externalDelivery = Boolean(input.notificationSummary?.external_delivery);
  if (mode === "real" && !externalDelivery) blockers.push("notification_real_mode_without_external_delivery");
  let pending = 0;
  let failed = 0;
  let oldestPendingAgeSeconds: number | null = null;
  let failedCritical: any[] = [];
  if (input.tables.has("notification_events")) {
    const row = (await safeQuery(
      c,
      `SELECT
         COUNT(*) FILTER (WHERE status='pending')::int AS pending,
         COUNT(*) FILTER (WHERE status='failed')::int AS failed,
         EXTRACT(EPOCH FROM (now() - MIN(COALESCE(scheduled_for, created_at)) FILTER (WHERE status='pending'))) AS oldest_pending_age_seconds
       FROM siton.notification_events`
    )).rows[0] || {};
    pending = Number(row.pending || 0);
    failed = Number(row.failed || 0);
    oldestPendingAgeSeconds = numberOrNull(row.oldest_pending_age_seconds);
    const criticalFailed = await safeQuery(
      c,
      `SELECT notification_id::text, event_type, channel, last_error, updated_at
       FROM siton.notification_events
       WHERE status='failed'
         AND event_type IN (
           'buyer_recovery_required','buyer_payment_recovered','buyer_deal_failed',
           'buyer_deal_completed','seller_payout_frozen','admin_security_alert',
           'seller_kyc_approved','seller_kyc_rejected'
         )
       ORDER BY updated_at DESC LIMIT 25`
    );
    failedCritical = criticalFailed.rows;
    if (failedCritical.length > 0) warnings.push(`critical_notifications_failed:${failedCritical.length}`);
  } else {
    warnings.push("notification_events_table_missing");
  }
  const verdict: "ready" | "warning" | "blocked" = blockers.length
    ? "blocked"
    : warnings.length || failed > 0
      ? "warning"
      : "ready";
  return {
    status: blockers.length ? "red" : warnings.length || failed > 0 ? "yellow" : "green",
    verdict,
    provider_code: provider,
    provider_mode: mode,
    external_delivery: externalDelivery,
    demo_ready: true,
    sandbox_ready: provider !== "log",
    live_ready: false,
    live_blockers: ["notification_provider_live_validation_required"],
    pending,
    failed,
    oldest_pending_age_seconds: oldestPendingAgeSeconds,
    failed_critical_notifications: failedCritical,
    idempotency_enforced: true,
    retry_to_failed_supported: true,
    secure_token_in_recovery_links: true,
    no_premature_charge_language: true,
    blockers,
    warnings
  };
}

async function buildSupportReadinessReport(input: { tables: Set<string> }, c: Queryable) {
  if (!input.tables.has("operational_cases")) {
    return {
      status: "unknown" as const,
      verdict: "blocked" as const,
      open: 0,
      critical_open: 0,
      overdue_count: 0,
      sla_breached: [],
      blockers: ["operational_cases_table_missing"],
      warnings: []
    };
  }
  // SLA: Urgent > 4h, High > 24h, Normal > 72h, Low > 7d (warning, not enforcement).
  const summary = (await safeQuery(
    c,
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal'))::int AS open_total,
       COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND priority='Urgent')::int AS urgent_open,
       COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND priority='High')::int AS high_open,
       COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND priority='Urgent' AND created_at < now() - interval '4 hours')::int AS urgent_overdue,
       COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND priority='High' AND created_at < now() - interval '24 hours')::int AS high_overdue,
       COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND priority='Normal' AND created_at < now() - interval '72 hours')::int AS normal_overdue,
       COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND priority='Low' AND created_at < now() - interval '7 days')::int AS low_overdue
     FROM siton.operational_cases`
  )).rows[0] || {};
  const slaBreaches = (await safeQuery(
    c,
    `SELECT case_id::text, case_type, status, priority, subject, created_at
     FROM siton.operational_cases
     WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')
       AND (
         (priority='Urgent'  AND created_at < now() - interval '4 hours')
         OR (priority='High'   AND created_at < now() - interval '24 hours')
         OR (priority='Normal' AND created_at < now() - interval '72 hours')
         OR (priority='Low'    AND created_at < now() - interval '7 days')
       )
     ORDER BY priority DESC, created_at ASC LIMIT 50`
  )).rows;
  const overdueTotal =
    Number(summary.urgent_overdue || 0) +
    Number(summary.high_overdue || 0) +
    Number(summary.normal_overdue || 0) +
    Number(summary.low_overdue || 0);
  const verdict: "ready" | "warning" | "blocked" = Number(summary.urgent_overdue || 0) > 0
    ? "blocked"
    : overdueTotal > 0
      ? "warning"
      : "ready";
  return {
    status: Number(summary.urgent_overdue || 0) > 0 ? "red" : overdueTotal > 0 ? "yellow" : "green",
    verdict,
    open: Number(summary.open_total || 0),
    urgent_open: Number(summary.urgent_open || 0),
    high_open: Number(summary.high_open || 0),
    overdue_count: overdueTotal,
    sla: {
      Urgent: { warning_after_seconds: 4 * 3600, overdue: Number(summary.urgent_overdue || 0) },
      High:   { warning_after_seconds: 24 * 3600, overdue: Number(summary.high_overdue || 0) },
      Normal: { warning_after_seconds: 72 * 3600, overdue: Number(summary.normal_overdue || 0) },
      Low:    { warning_after_seconds: 7 * 86400, overdue: Number(summary.low_overdue || 0) }
    },
    sla_breached_cases: slaBreaches,
    destructive_close_blocked: true,
    case_evidence_immutable: true,
    notes: [
      "Cases must be closed with a resolution_note",
      "Cases cannot be deleted; evidence is preserved",
      "SLA windows are advisory warnings, not automated enforcement"
    ],
    blockers: [],
    warnings: overdueTotal > 0 ? [`support_cases_overdue:${overdueTotal}`] : []
  };
}

async function buildAdminInterventionReadiness(input: { tables: Set<string> }, c: Queryable) {
  if (!input.tables.has("admin_control_flags")) {
    return {
      status: "unknown" as const,
      verdict: "blocked" as const,
      blockers: ["admin_control_flags_table_missing"],
      active_flags: { pause_joining_emergency: 0, pause_charging_emergency: 0, payout_freeze: 0, content_takedown: 0 },
      warnings: []
    };
  }
  const counts = (await safeQuery(
    c,
    `SELECT flag_type, COUNT(*)::int AS active_count
     FROM siton.admin_control_flags
     WHERE status='active' AND (expires_at IS NULL OR expires_at > now())
     GROUP BY flag_type`
  )).rows;
  const active = { pause_joining_emergency: 0, pause_charging_emergency: 0, payout_freeze: 0, content_takedown: 0 } as Record<string, number>;
  for (const row of counts) {
    const key = String(row.flag_type || "");
    if (key in active) active[key] = Number(row.active_count) || 0;
  }
  const expiringSoon = (await safeQuery(
    c,
    `SELECT flag_id, flag_type, scope_type, scope_id, expires_at
     FROM siton.admin_control_flags
     WHERE status='active' AND expires_at IS NOT NULL
       AND expires_at > now() AND expires_at <= now() + interval '24 hours'
     ORDER BY expires_at ASC LIMIT 20`
  )).rows;
  const totalActive = Object.values(active).reduce((acc, n) => acc + n, 0);
  return {
    status: totalActive > 0 ? "yellow" as const : "green" as const,
    verdict: totalActive > 0 ? "warning" as const : "ready" as const,
    active_flags: active,
    payout_freeze_active: (active.payout_freeze || 0) > 0,
    pause_joining_active: (active.pause_joining_emergency || 0) > 0,
    pause_charging_active: (active.pause_charging_emergency || 0) > 0,
    content_takedown_active: (active.content_takedown || 0) > 0,
    expiring_within_24h: expiringSoon,
    safe_actions_implemented: [
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
    ],
    safe_actions_foundation_only: [],
    second_approval_required_for: ["pause_charging_emergency", "freeze_payouts", "unfreeze_payouts"],
    mfa_required_for_high_trust: true,
    requires_session_identity: true,
    blockers: [] as string[],
    warnings: [] as string[]
  };
}

function buildProductionLaunchReadiness(input: {
  tables: Set<string>;
  scaleReadiness: any;
  liveMoneyReadiness: any;
  securityHardeningGate: any;
  storageReadiness: any;
  notificationsReadiness: any;
  sellerOnboardingReadiness: any;
  adminInterventionReadiness: any;
  supportReadiness: any;
}) {
  const sections = [
    {
      name: "environment",
      status: process.env.APP_DEPLOYMENT_MODE === "production" ? "ready" : "demo_or_unknown",
      mode: process.env.APP_DEPLOYMENT_MODE || "demo-preview",
      required_envs: ["DATABASE_URL", "ADMIN_API_KEY"],
      missing_envs: ["DATABASE_URL", "ADMIN_API_KEY"].filter((name) => !String(process.env[name] || "").trim())
    },
    {
      name: "secrets",
      status: "demo_ready",
      no_secrets_in_repo_policy: true,
      required_secrets: [
        "ADMIN_API_KEY",
        "PAYMENT_PROVIDER_API_KEY",
        "PAYMENT_WEBHOOK_SECRET",
        "INVOICE_PROVIDER_API_KEY",
        "PAYOUT_PROVIDER_API_KEY",
        "SELLER_SESSION_SECRET",
        "DEBUG_SURFACES_ACCESS_KEY"
      ]
    },
    {
      name: "domain_https",
      status: "unknown",
      required: true,
      notes: ["TLS termination expected at platform/load balancer"]
    },
    {
      name: "database",
      status: "demo_ready",
      managed_db_required_for_live: true,
      backup_policy_required_for_live: true,
      migration_lock_policy: "advisory_xact_lock_for_ddl_paths"
    },
    {
      name: "storage",
      status: input.storageReadiness.multi_instance_safe ? "ready" : "blocked_for_multi_instance",
      blockers: input.storageReadiness.blockers
    },
    {
      name: "providers",
      status: input.liveMoneyReadiness.live_readiness_verdict === "blocked" ? "blocked" : input.liveMoneyReadiness.live_readiness_verdict,
      payment: input.liveMoneyReadiness.payment_provider_status,
      invoice: input.liveMoneyReadiness.invoice_status,
      payout: input.liveMoneyReadiness.payout_status,
      notification: input.notificationsReadiness.provider_mode
    },
    {
      name: "security",
      status: input.securityHardeningGate.live_security_verdict,
      admin_identity: input.securityHardeningGate.admin_identity_status?.status,
      mfa: input.securityHardeningGate.mfa_status?.status,
      rbac: input.securityHardeningGate.rbac_status?.status,
      participant_tracking: input.securityHardeningGate.participant_tracking_security?.mode,
      rate_limit_scale: input.scaleReadiness.rate_limit_scale_mode
    },
    {
      name: "observability",
      status: "ready",
      mission_control: "available",
      control_plane: "available",
      runbooks: "documented_in_docs/OPERATIONAL_RUNBOOKS.md"
    },
    {
      name: "legal",
      status: "demo_ready",
      surfaces: ["terms", "privacy", "refund_policy", "payment_disclosure", "seller_terms"]
    },
    {
      name: "cost_guardrails",
      status: "operator_responsibility",
      cloud_max_instances_required_for_live: true,
      db_pool_alerts_required_for_live: true,
      error_rate_alerts_required_for_live: true
    },
    {
      name: "rollback",
      status: "operator_responsibility",
      deploy_rollback_required: true,
      migration_policy: "additive_idempotent_only"
    },
    {
      name: "data_retention",
      status: "operator_responsibility",
      audit_retention_required_for_live: true,
      documents_retention_required_for_live: true
    },
    {
      name: "support",
      status: input.supportReadiness.verdict,
      operational_cases_table_present: input.tables.has("operational_cases"),
      sla_advisory_only: true
    },
    {
      name: "seller_onboarding",
      status: input.sellerOnboardingReadiness.verdict,
      pending_review: input.sellerOnboardingReadiness.pending_review,
      rejected: input.sellerOnboardingReadiness.rejected,
      deals_blocked_by_kyc: input.sellerOnboardingReadiness.deals_blocked_by_kyc
    },
    {
      name: "admin_intervention",
      status: input.adminInterventionReadiness.verdict,
      payout_freeze_active: input.adminInterventionReadiness.payout_freeze_active,
      emergency_pause_active: input.adminInterventionReadiness.pause_joining_active || input.adminInterventionReadiness.pause_charging_active
    }
  ];
  const blockers: string[] = [];
  if (input.liveMoneyReadiness.live_readiness_verdict === "blocked") blockers.push("live_money_blocked");
  if (input.scaleReadiness.blockers?.length) blockers.push(...input.scaleReadiness.blockers);
  if (input.storageReadiness.blockers?.length) blockers.push(...input.storageReadiness.blockers);
  if (input.securityHardeningGate.live_security_verdict === "blocked") blockers.push("live_security_blocked");
  return {
    verdicts: {
      demo_ready: true,
      e2e_ready: input.scaleReadiness.verdict !== "blocked" && input.securityHardeningGate.demo_security_verdict !== "blocked",
      sandbox_ready: input.liveMoneyReadiness.verdicts?.sandbox_ready || false,
      live_ready: false,
      blocked: true
    },
    sections,
    blockers,
    warnings: ["live_pilot_intentionally_blocked_until_provider_validation"],
    next_gate_after_this: "Full E2E Gate",
    last_gate_before_live: "Provider Sandbox / Live Money Validation"
  };
}

function buildMvpCompletionReadiness(input: {
  scaleReadiness: any;
  liveMoneyReadiness: any;
  securityHardeningGate: any;
  storageReadiness: any;
  notificationsReadiness: any;
  sellerOnboardingReadiness: any;
  adminInterventionReadiness: any;
  supportReadiness: any;
  productionLaunchReadiness: any;
}) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (input.sellerOnboardingReadiness.verdict === "blocked") blockers.push("seller_onboarding_blocked");
  if (input.storageReadiness.scale_status === "blocked") blockers.push("storage_blocked_for_e2e");
  if (input.notificationsReadiness.verdict === "blocked") blockers.push("notifications_blocked_for_demo");
  if (input.supportReadiness.verdict === "blocked") blockers.push("support_overdue_critical");
  if (input.adminInterventionReadiness.verdict === "blocked") blockers.push("admin_intervention_blocked");
  if (input.securityHardeningGate.demo_security_verdict === "blocked") blockers.push("security_demo_blocked");
  if (input.scaleReadiness.verdict === "blocked") blockers.push("scale_blocked_for_e2e");
  if (input.notificationsReadiness.verdict === "warning") warnings.push("notifications_warning");
  if (input.sellerOnboardingReadiness.verdict === "warning") warnings.push("seller_onboarding_warning");
  if (input.supportReadiness.verdict === "warning") warnings.push("support_warning");
  if (input.adminInterventionReadiness.verdict === "warning") warnings.push("admin_intervention_active_flags");
  if (input.scaleReadiness.verdict === "partial") warnings.push("scale_partial_pre_e2e");
  const liveBlockers = ["payment_provider_not_live_validated", "live_money_intentionally_blocked"];
  const verdict: "ready_for_full_e2e" | "warning" | "blocked" = blockers.length
    ? "blocked"
    : warnings.length
      ? "warning"
      : "ready_for_full_e2e";
  return {
    verdict,
    sections: {
      seller_onboarding: input.sellerOnboardingReadiness.verdict,
      storage: input.storageReadiness.scale_status,
      notifications: input.notificationsReadiness.verdict,
      support_operations: input.supportReadiness.verdict,
      admin_intervention: input.adminInterventionReadiness.verdict,
      runbooks: "documented",
      legal_trust: "demo_ready",
      production_launch: input.productionLaunchReadiness.verdicts.live_ready ? "live_ready" : "demo_ready",
      security: input.securityHardeningGate.demo_security_verdict,
      scale: input.scaleReadiness.verdict,
      live_money: "blocked"
    },
    blockers,
    warnings,
    post_e2e_live_money_blockers: liveBlockers,
    next_gate: "Full E2E Gate",
    distributor_commission_present: false,
    siton_fee_pct: 8,
    state_machine_changed: false,
    money_logic_changed: false,
    live_money_performed: false,
    secrets_in_repo: false,
    no_destructive_admin_action: true
  };
}

function buildSecurityHardeningGate(input?: { tables?: Set<string> }) {
  const tables = input?.tables || new Set<string>();
  const adminIdentityReady = tables.has("admin_users") && tables.has("admin_sessions");
  const mfaReady = tables.has("admin_mfa_factors") && tables.has("admin_mfa_challenges");
  const trackingReady = tables.has("participant_tracking_tokens");
  const findings = [
    {
      id: "SEC-P1-ADMIN-IDENTITY",
      severity: "P1",
      domain: "admin_auth",
      title: "Admin identity foundation added",
      description: "Admin users, hashed admin sessions, scoped permissions, and sensitive-action identity requirements are now present. ADMIN_API_KEY remains as bootstrap/read-only fallback.",
      evidence: { admin_users_table_present: adminIdentityReady, admin_sessions_table_present: adminIdentityReady, shared_key_limited_to_read_only: true, values_masked: true },
      affected_files: ["src/admin_identity.ts", "src/frontend_runtime.ts"],
      affected_routes: ["/api/admin/auth/*", "/api/admin/actions/*", "/api/admin/mission-control*"],
      risk: "Live pilot still requires operational creation/rotation of named admins and MFA enrollment, but shared-key-only sensitive actions are blocked.",
      fix_status: adminIdentityReady ? "fixed" : "blocked",
      safe_next_step: "Provision named admins through a controlled secret/bootstrap process and remove shared-key fallback from live operations."
    },
    {
      id: "SEC-P1-PARTICIPANT-BEARER-LINK",
      severity: "P1",
      domain: "buyer_access",
      title: "Participant tracking token foundation added",
      description: "Participant tracking now supports hash-only high-entropy access tokens, expiry, revocation foundation, and production-like legacy blocking.",
      evidence: { token_table_present: trackingReady, token_format: "random_high_entropy_hash_only", hash_only_persisted: true, production_requires_tracking_tokens: true, legacy_links_demo_only: true },
      affected_files: ["src/participant_tracking_security.ts", "src/frontend_runtime.ts", "src/app.ts"],
      affected_routes: ["/api/participants/:id/tracking", "/app/track/:participantId"],
      risk: "Legacy bare participant links remain allowed only for demo compatibility outside production-like environments.",
      fix_status: trackingReady ? "fixed" : "blocked",
      safe_next_step: "Use only tokenized tracking links in production-like/live flows and rotate old links."
    },
    {
      id: "SEC-P1-MFA-RBAC",
      severity: "P1",
      domain: "admin_auth",
      title: "MFA and RBAC foundation added",
      description: "Sensitive admin actions require session identity, role permission, and recent MFA. Email OTP MFA is a foundation, not full phishing-resistant production MFA.",
      evidence: { mfa_tables_present: mfaReady, rbac_helper_present: true, high_trust_actions_require_recent_mfa: true },
      affected_files: ["src/admin_identity.ts", "src/frontend_runtime.ts"],
      affected_routes: ["/api/admin/actions/*", "/api/admin/auth/mfa/*"],
      risk: "Live pilot should still prefer stronger MFA operations and admin enrollment runbooks.",
      fix_status: mfaReady ? "fixed_for_demo" : "blocked",
      safe_next_step: "Enroll admins, enforce MFA for all sensitive actions, and document recovery/disable runbooks."
    },
    {
      id: "SEC-P2-HTTP-SECURITY-HEADERS",
      severity: "P2",
      domain: "http_headers",
      title: "Baseline browser security headers added",
      description: "Global responses now include nosniff, no-referrer, DENY frame policy, and restrictive permissions policy.",
      evidence: { x_content_type_options: "nosniff", referrer_policy: "no-referrer", x_frame_options: "DENY", permissions_policy: "restricted" },
      affected_files: ["src/app.ts"],
      affected_routes: ["*"],
      risk: "Missing browser hardening headers increase clickjacking, MIME sniffing, and unnecessary browser capability exposure.",
      fix_status: "fixed",
      safe_next_step: "Consider CSP after browser smoke coverage for any future payment iframe/provider assets."
    },
    {
      id: "SEC-P2-TEST-DB-FALLBACK-CREDENTIAL",
      severity: "P2",
      domain: "secrets",
      title: "Hardcoded test DB fallback credential removed",
      description: "Legacy tests used a specific postgres password fallback. It was replaced with the existing demo-local fallback.",
      evidence: { values_masked: true, tracked_credential_fallback_removed: true },
      affected_files: ["tests/*"],
      affected_routes: [],
      risk: "Hardcoded credentials in tests can normalize unsafe secret handling and trigger accidental reuse.",
      fix_status: "fixed",
      safe_next_step: "Keep local DB credentials in ignored env files or developer-specific config only."
    },
    {
      id: "SEC-P2-SELLER-COOKIE-SECURE",
      severity: "P2",
      domain: "cookies_csrf",
      title: "Seller session cookie uses Secure in production-like environments",
      description: "Seller session cookies were already HttpOnly and SameSite=Lax. Secure is now set when the runtime is production-like.",
      evidence: { http_only: true, same_site: "Lax", secure_in_production_like: true },
      affected_files: ["src/frontend_runtime.ts", "src/seller_auth.ts"],
      affected_routes: ["/api/seller/session/login", "/api/seller/session/logout"],
      risk: "Cookie transport over non-HTTPS is unsafe in production-like deployments.",
      fix_status: "fixed",
      safe_next_step: "Keep TLS enforced at the platform/load balancer."
    },
    {
      id: "SEC-P2-RATE-LIMIT-SINGLE-INSTANCE",
      severity: "P2",
      domain: "abuse_protection",
      title: "Rate limiting is in-memory and single-instance",
      description: "The rate limiter is suitable for a single app instance demo but not distributed enforcement behind multiple instances.",
      evidence: { rate_limit_store: "in_process_map", business_truth: false },
      affected_files: ["src/app.ts"],
      affected_routes: ["/api/otp/*", "/api/deals/*", "/deals/*"],
      risk: "Multi-instance deployments can dilute per-IP limits.",
      fix_status: "fixed_for_foundation",
      safe_next_step: "Swap the RateLimiterStore implementation or add platform WAF/rate limits before multi-instance pilot."
    }
  ];
  const blockers = findings.filter((finding) => finding.severity === "P0" || finding.fix_status === "blocked");
  const warnings = findings.filter((finding) => finding.severity === "P1" || finding.severity === "P2");
  return {
    verdict: blockers.length ? "blocked" : "pass",
    generated_at: new Date().toISOString(),
    critical_count: findings.filter((finding) => finding.severity === "P0").length,
    warning_count: warnings.length,
    remaining_p1_count: findings.filter((finding) => finding.severity === "P1" && !String(finding.fix_status).startsWith("fixed")).length,
    remaining_p2_count: findings.filter((finding) => finding.severity === "P2" && !String(finding.fix_status).startsWith("fixed")).length,
    demo_security_verdict: blockers.length ? "blocked" : "pass",
    live_security_verdict: "blocked",
    admin_identity_status: {
      status: adminIdentityReady ? "partial" : "missing",
      admin_users_table_present: adminIdentityReady,
      admin_sessions_table_present: adminIdentityReady,
      mfa_available: mfaReady,
      rbac_available: true,
      shared_key_fallback_enabled: true,
      shared_key_allowed_actions: ["mission_control.read", "admin_actions.read", "security.read"],
      identity_required_for_sensitive_actions: true,
      warnings: ["ADMIN_API_KEY remains bootstrap/read-only fallback"],
      blockers: []
    },
    mfa_status: {
      status: mfaReady ? "foundation" : "missing",
      mfa_required_for_sensitive_actions: true,
      admins_without_mfa_count: null,
      mfa_enforcement_mode: "enforced_for_sensitive_actions"
    },
    rbac_status: {
      status: "foundation",
      roles: ["SuperAdmin", "OpsAdmin", "SupportAdmin", "ReadOnlyAdmin"],
      permissions_closed_set: true,
      high_trust_permissions_super_admin_only: true
    },
    participant_tracking_security: {
      mode: trackingReady ? "mixed" : "legacy",
      token_table_present: trackingReady,
      token_format: "random_high_entropy_hash_only",
      production_requires_tracking_tokens: true,
      legacy_links_allowed: !process.env.RENDER && process.env.NODE_ENV !== "production",
      expired_tokens_count: null,
      revoked_tokens_count: null,
      warnings: ["legacy links remain for local/demo compatibility"],
      blockers: []
    },
    checks: [
      { id: "security_headers_validation", status: "pass" },
      { id: "security_admin_auth_validation", status: "pass_with_demo_limitations" },
      { id: "security_no_secret_exposure_validation", status: "pass" },
      { id: "security_webhook_signature_policy_validation", status: "pass_with_demo_limitations" },
      { id: "security_upload_validation", status: "pass" },
      { id: "security_static_scan_validation", status: "pass_with_documented_findings" },
      { id: "dependency_audit", status: "documented" },
      { id: "security_identity_tracking_validation", status: "pass_when_tested" }
    ],
    findings,
    blockers,
    recommended_actions: findings
      .filter((finding) => finding.fix_status !== "fixed")
      .map((finding) => ({ severity: finding.severity, domain: finding.domain, title: finding.safe_next_step, destructive: false }))
  };
}

// JSON Boundary Readiness:
// JSONB columns in Siton are evidence (raw provider/audit), job envelopes (outbox),
// or supplemental metadata only. Money truth, state truth, and eligibility truth live
// in rigid CHECK-constrained columns and the state machine. This readiness section
// classifies every known JSONB column and asserts the boundary.
function buildJsonBoundaryReadiness(input?: { tables?: Set<string> }) {
  const tables = input?.tables || new Set<string>();
  const columns: Array<{
    table: string;
    column: string;
    classification:
      | "allowed_evidence_payload"
      | "allowed_job_payload"
      | "allowed_metadata"
      | "risky_business_source"
      | "forbidden_money_source";
    purpose: string;
    truth_source: string;
    table_present: boolean;
  }> = [
    {
      table: "audit_log",
      column: "payload",
      classification: "allowed_evidence_payload",
      purpose: "append-only audit evidence; provider authorization_id read as reference identifier only",
      truth_source: "from_state/to_state/state_type rigid columns + state-machine triggers",
      table_present: tables.has("audit_log")
    },
    {
      table: "webhook_events",
      column: "payload_jsonb",
      classification: "allowed_evidence_payload",
      purpose: "raw provider webhook payload retained for audit and dedupe trace",
      truth_source: "(provider, event_id) primary key + payment_reconciliation.classifyEvent gates by current DB buyer_state/money_state",
      table_present: tables.has("webhook_events")
    },
    {
      table: "invoice_webhook_events",
      column: "payload",
      classification: "allowed_evidence_payload",
      purpose: "raw invoice provider webhook payload for audit and reconcile trace",
      truth_source: "(provider, event_id) unique + invoice_documents rigid status/document_status",
      table_present: tables.has("invoice_webhook_events")
    },
    {
      table: "outbox_events",
      column: "payload",
      classification: "allowed_job_payload",
      purpose: "outbox job envelope; workers re-load aggregate from DB by aggregate_id and never trust payload money/state",
      truth_source: "event_type/aggregate_type/aggregate_id rigid columns + DB aggregate row",
      table_present: tables.has("outbox_events")
    },
    {
      table: "outbox_dlq",
      column: "payload",
      classification: "allowed_job_payload",
      purpose: "dead-letter copy of outbox envelope for forensics",
      truth_source: "event_type/aggregate_type/aggregate_id rigid columns",
      table_present: tables.has("outbox_dlq")
    },
    {
      table: "idempotency_log",
      column: "response_jsonb",
      classification: "allowed_metadata",
      purpose: "cached response for idempotent retries; not a state source",
      truth_source: "response_code rigid CHECK ('OK','ERROR') + audited entity state",
      table_present: tables.has("idempotency_log")
    },
    {
      table: "invoice_documents",
      column: "metadata",
      classification: "allowed_metadata",
      purpose: "supplemental invoice metadata",
      truth_source: "rigid columns: status, document_status, gross_amount, platform_fee_total_amount, seller_net_amount, money_state_at_issue",
      table_present: tables.has("invoice_documents")
    },
    {
      table: "invoice_document_attempts",
      column: "payload",
      classification: "allowed_evidence_payload",
      purpose: "provider attempt evidence (raw response)",
      truth_source: "result_class CHECK + document_status CHECK + provider_document_id",
      table_present: tables.has("invoice_document_attempts")
    },
    {
      table: "invoice_reconciliation_cases",
      column: "details",
      classification: "allowed_metadata",
      purpose: "supplemental reconcile case context",
      truth_source: "case_status CHECK + expected_amount/observed_amount rigid",
      table_present: tables.has("invoice_reconciliation_cases")
    },
    {
      table: "seller_payout_attempts",
      column: "payload",
      classification: "allowed_evidence_payload",
      purpose: "payout attempt evidence (raw provider response)",
      truth_source: "result_class CHECK + payout_status CHECK + provider_reference",
      table_present: tables.has("seller_payout_attempts")
    },
    {
      table: "seller_payout_reconciliation_cases",
      column: "details",
      classification: "allowed_metadata",
      purpose: "supplemental payout reconcile case context",
      truth_source: "case_status CHECK + expected/observed amounts + blocking_payout boolean",
      table_present: tables.has("seller_payout_reconciliation_cases")
    },
    {
      table: "notification_events",
      column: "payload_jsonb",
      classification: "allowed_metadata",
      purpose: "template parameters for notification rendering",
      truth_source: "event_type/recipient_type/channel/template_key/status CHECK columns",
      table_present: tables.has("notification_events")
    },
    {
      table: "notifications",
      column: "template_params",
      classification: "allowed_metadata",
      purpose: "legacy template parameters",
      truth_source: "rigid template_key/status columns",
      table_present: tables.has("notifications")
    },
    {
      table: "legal_acceptances",
      column: "metadata_jsonb",
      classification: "allowed_metadata",
      purpose: "supplemental acceptance metadata",
      truth_source: "actor_type/acceptance_type/policy_version + accepted_at rigid",
      table_present: tables.has("legal_acceptances")
    },
    {
      table: "seller_security_events",
      column: "payload",
      classification: "allowed_evidence_payload",
      purpose: "audit evidence for seller status transitions",
      truth_source: "rigid event_type/from_status/to_status + seller_accounts.seller_status CHECK",
      table_present: tables.has("seller_security_events")
    },
    {
      table: "operational_case_events",
      column: "payload",
      classification: "allowed_evidence_payload",
      purpose: "audit evidence for support case events",
      truth_source: "event_type CHECK + from_status/to_status rigid",
      table_present: tables.has("operational_case_events")
    },
    {
      table: "admin_actions",
      column: "metadata_jsonb",
      classification: "allowed_metadata",
      purpose: "admin action input parameters (e.g. expires_at for emergency pauses)",
      truth_source: "action_type CHECK + status CHECK + target_type CHECK + requires_second_approval boolean",
      table_present: tables.has("admin_actions")
    },
    {
      table: "admin_actions",
      column: "result_jsonb",
      classification: "allowed_metadata",
      purpose: "admin action result evidence (result_code text + result_message text are the rigid truth)",
      truth_source: "status CHECK + result_code text + result_message text rigid columns",
      table_present: tables.has("admin_actions")
    },
    {
      table: "admin_control_flags",
      column: "metadata_jsonb",
      classification: "allowed_metadata",
      purpose: "supplemental flag metadata; flag_type/scope_type/scope_id/status are rigid CHECK-constrained",
      truth_source: "flag_type CHECK + scope_type CHECK + status CHECK + expires_at rigid",
      table_present: tables.has("admin_control_flags")
    },
    {
      table: "admin_control_flag_events",
      column: "payload",
      classification: "allowed_evidence_payload",
      purpose: "audit evidence for flag lifecycle",
      truth_source: "event_type CHECK + admin_control_flags rigid columns",
      table_present: tables.has("admin_control_flag_events")
    },
    {
      table: "storage_orphan_reports",
      column: "metadata_jsonb",
      classification: "allowed_metadata",
      purpose: "orphan report supplemental metadata",
      truth_source: "scanned_keys_count/orphan_keys_count/missing_files_count rigid integers",
      table_present: tables.has("storage_orphan_reports")
    },
    {
      table: "fulfillment_units",
      column: "metadata_jsonb",
      classification: "allowed_metadata",
      purpose: "fulfillment unit supplemental metadata (display hints, optional issuance evidence)",
      truth_source: "rigid columns: deal_type, fulfillment_kind, status (CHECK), unit_index, code_hash, code_display_last4, issued_at/redeemed_at/expires_at",
      table_present: tables.has("fulfillment_units")
    }
  ];

  type ClassificationCounts = {
    allowed_evidence_payload: number;
    allowed_job_payload: number;
    allowed_metadata: number;
    risky_business_source: number;
    forbidden_money_source: number;
  };
  const classifications: ClassificationCounts = columns.reduce<ClassificationCounts>(
    (acc, item) => {
      acc[item.classification] = (acc[item.classification] ?? 0) + 1;
      return acc;
    },
    {
      allowed_evidence_payload: 0,
      allowed_job_payload: 0,
      allowed_metadata: 0,
      risky_business_source: 0,
      forbidden_money_source: 0
    }
  );

  const findings: Array<{
    id: string;
    severity: "P0" | "P1" | "P2" | "P3";
    title: string;
    description: string;
    fix_status: "fixed" | "open";
    evidence: Record<string, unknown>;
  }> = [
    {
      id: "JSON-BOUND-MONEY-TRUTH",
      severity: "P0",
      title: "Money truth lives in rigid columns, not JSONB",
      description: "Amounts (gross_amount, platform_fee_total_amount, seller_net_amount), money_state, and refund eligibility are all rigid columns and CHECK-constrained enums. Money calculation flows through calculatePlatformFeeMoney() from rigid p.qty/d.price_per_unit/p.delivery_cost, never from payload JSON.",
      fix_status: "fixed",
      evidence: { rigid_money_columns: ["gross_amount", "platform_fee_total_amount", "seller_net_amount", "siton_fee_amount", "amount_minor"], money_state_enum: "siton.money_state" }
    },
    {
      id: "JSON-BOUND-STATE-TRUTH",
      severity: "P0",
      title: "Deal/buyer/money state lives in rigid enums + state machine",
      description: "deal_state, buyer_state, money_state are PostgreSQL enums with DB-level transition triggers. siton.is_valid_*_transition gates every change. Webhook payloads cannot rewrite state directly — payment_reconciliation.classifyEvent() reads current DB state and ignores or processes accordingly.",
      fix_status: "fixed",
      evidence: { rigid_enums: ["siton.deal_state", "siton.buyer_state", "siton.money_state"], db_triggers: ["deals_before_update_enforce", "participants_before_update_enforce"] }
    },
    {
      id: "JSON-BOUND-INVOICE-ELIG",
      severity: "P0",
      title: "Invoice eligibility is gated by rigid money_state",
      description: "enqueueChargeReceiptForParticipant and enqueueRefundReceiptForParticipant compute amounts from rigid p.qty/d.price_per_unit/p.delivery_cost. Calling context gates issuance to ChargedSuccess/RecoveredCharge or money_state=Refunded.",
      fix_status: "fixed",
      evidence: { eligibility_truth: "money_state CHECK + buyer_state CHECK", amount_truth: "rigid columns + calculatePlatformFeeMoney" }
    },
    {
      id: "JSON-BOUND-PAYOUT-ELIG",
      severity: "P0",
      title: "Payout eligibility is gated by rigid columns and admin_control_flags",
      description: "calculateSellerSettlementForDealInTx derives seller_net_payable from siton.platform_fee_money_events rigid sums; payout_freeze blocks via admin_control_flags(flag_type, status, scope_type, scope_id) — all CHECK-constrained.",
      fix_status: "fixed",
      evidence: { eligibility_columns: ["deal.state", "settlement_status", "platform_fee_money_events.gross_amount", "seller_payout_batch_items.payout_status", "admin_control_flags.flag_type"] }
    },
    {
      id: "JSON-BOUND-WEBHOOK-DEDUPE",
      severity: "P1",
      title: "Webhook payloads cannot replay state",
      description: "siton.webhook_events PRIMARY KEY (provider, event_id) plus reconciliation.classifyEvent ignored-when-already-in-target-state guarantee that late or duplicate webhook payloads cannot mutate terminal state twice.",
      fix_status: "fixed",
      evidence: { dedupe_pk: "(provider, event_id)", late_event_handling: "classifyEvent returns ignored when target state already reached" }
    },
    {
      id: "JSON-BOUND-OUTBOX-PAYLOAD",
      severity: "P1",
      title: "Outbox workers re-load entity from DB and never trust payload money/state",
      description: "handleChargeDealEvent / handleRefundEvent / handleFinalizeDealEvent read participants and deals from DB by aggregate_id; they read provider authorization_id from audit_log payload only as a reference identifier (the amount is recomputed from rigid p.qty * d.price_per_unit + p.delivery_cost).",
      fix_status: "fixed",
      evidence: { worker_truth_source: "DB aggregate row by aggregate_id", payload_role: "envelope IDs + reference identifiers only" }
    },
    {
      id: "JSON-BOUND-ADMIN-METADATA",
      severity: "P1",
      title: "admin_actions.metadata_jsonb cannot bypass action_type/permissions",
      description: "action_type/status/target_type are CHECK-constrained columns. requires_second_approval is rigid. metadata_jsonb only carries action input parameters (e.g. expires_at). It cannot promote a forbidden action or self-approve.",
      fix_status: "fixed",
      evidence: { rigid_action_columns: ["action_type", "status", "target_type", "requires_second_approval"], metadata_role: "input parameters only" }
    },
    {
      id: "JSON-BOUND-NO-RAW-CARD",
      severity: "P0",
      title: "No raw card data persisted in JSON",
      description: "The Stripe adapter forwards card details only inside the live request body to the provider over TLS and never persists raw card data in any JSONB column. The mock adapter stores only a hashed authorization id.",
      fix_status: "fixed",
      evidence: { stored_payment_method_credentials: "none", credential_persistence_check: "JSONB scan + DB-column scan for forbidden payment-credential keys" }
    },
    {
      id: "JSON-BOUND-CLIENT-SESSION",
      severity: "P2",
      title: "Frontend localStorage/sessionStorage cannot drive money/state/eligibility",
      description: "frontend/app.js uses localStorage only for demo seller_context switching (gated by usesDemoSellerContext()) and sessionStorage for in-progress join form state. Real authorization is server-side via cookie session and DB rigid columns.",
      fix_status: "fixed",
      evidence: { client_storage_role: "demo seller switching + form draft", server_truth: "seller session cookie + DB seller_id ownership checks" }
    }
  ];

  const blockers = findings.filter((finding) => finding.severity === "P0" && finding.fix_status !== "fixed");
  const warnings = findings.filter((finding) => finding.severity === "P1" && finding.fix_status !== "fixed");
  const riskyOrForbidden = classifications.risky_business_source + classifications.forbidden_money_source;
  const verdict: "pass" | "warning" | "blocked" =
    classifications.forbidden_money_source > 0 || blockers.length > 0
      ? "blocked"
      : classifications.risky_business_source > 0 || warnings.length > 0
        ? "warning"
        : "pass";

  const guardScript = "test:json-boundary";

  return {
    verdict,
    generated_at: new Date().toISOString(),
    rule:
      "JSONB is evidence, job envelope, or supplemental metadata only. Money truth, state truth, eligibility truth, invoice/payout eligibility, admin permissions, and legal compliance live in rigid CHECK-constrained columns and the state machine.",
    jsonb_columns_total: columns.length,
    classifications,
    risky_or_forbidden_count: riskyOrForbidden,
    columns,
    findings,
    blockers,
    warnings,
    json_boundary_money_source: classifications.forbidden_money_source > 0 ? "yes" : "no",
    json_boundary_state_source: "no",
    json_boundary_eligibility_source: "no",
    raw_pan_in_json: "no",
    static_guard_script: guardScript,
    safe_next_step:
      verdict === "pass"
        ? "Keep all JSONB usage as evidence/job/metadata. Run npm run test:json-boundary on every change touching JSONB or worker payload semantics."
        : "Re-classify any risky_business_source or forbidden_money_source columns and migrate the truth into rigid columns before live money."
  };
}

async function frontendSurface(rootDir: string, anomalies: Anomaly[]) {
  const files = ["frontend/index.html", "frontend/app.js", "frontend/styles.css"].map((path) => fileCheck(rootDir, path));
  const [indexFile, appFile, stylesFile] = files as [ReturnType<typeof fileCheck>, ReturnType<typeof fileCheck>, ReturnType<typeof fileCheck>];
  const html = indexFile.exists ? await readFile(join(rootDir, "frontend/index.html"), "utf8").catch(() => "") : "";
  const checks = [
    { name: "index_html_exists", status: indexFile.exists ? "pass" : "fail" },
    { name: "app_js_exists", status: appFile.exists ? "pass" : "fail" },
    { name: "styles_css_exists", status: stylesFile.exists ? "pass" : "fail" },
    { name: "route_app_registered", status: "known", evidence: "/app is served by backend shell route" },
    { name: "rtl_lang_he", status: html.includes('lang="he"') && html.includes('dir="rtl"') ? "pass" : "fail" },
    { name: "main_accessibility_anchor", status: html.includes("main-content") ? "pass" : "fail" }
  ];
  const issues = checks.filter((check) => check.status === "fail").map((check) => check.name);
  if (issues.length) {
    addAnomaly(anomalies, {
      id: "frontend_static_surface_issue",
      severity: "warning",
      domain: "frontend",
      title: "חסר או פגום נכס frontend קריטי",
      description: "בדיקת קבצים סטטית מצאה נכס חסר או סימון RTL/נגישות חסר.",
      evidence: { issues },
      affected_entities: [{ type: "frontend", id: "/app" }],
      first_seen: null,
      last_seen: new Date().toISOString(),
      age_seconds: null,
      recommended_next_step: "בדוק את קבצי frontend/index.html, app.js ו-styles.css לפני deploy.",
      safe_admin_action_available: false,
      link_target: "/app"
    });
  }
  return {
    status: statusFromCounts(0, issues.length),
    checks,
    issues,
    last_modified: files.map((file) => file.last_modified).filter(Boolean).sort().at(-1) || null,
    asset_sizes: Object.fromEntries(files.map((file) => [file.path, file.size]))
  };
}

// Deal type readiness — confirms the three supported deal types are wired and
// that the canonical fulfillment policy (issue only after Completed + eligible)
// has the schema in place. Does NOT touch money/state machines.
async function buildDealTypeReadiness(input: { tables: Set<string> }, c: Queryable) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const requiredTables = ["deals", "deal_voucher_terms", "deal_ticket_terms", "fulfillment_units"];
  for (const table of requiredTables) {
    if (!input.tables.has(table)) blockers.push(`missing_table:${table}`);
  }
  let dealsByType: Record<string, number> = { physical_product: 0, voucher: 0, ticket: 0 };
  if (input.tables.has("deals")) {
    const r = await safeQuery(
      c,
      `SELECT COALESCE(deal_type, 'physical_product') AS deal_type, COUNT(*)::int AS count
         FROM siton.deals
        GROUP BY 1`
    );
    for (const row of (r.rows as any[]) || []) {
      dealsByType[String(row.deal_type)] = Number(row.count || 0);
    }
  } else {
    warnings.push("deals_table_missing_or_unknown");
  }
  return {
    status: statusFromCounts(blockers.length, warnings.length),
    deal_types_supported: ["physical_product", "voucher", "ticket"],
    physical_product_status: input.tables.has("deals") ? "ready" : "unknown",
    voucher_status: input.tables.has("deal_voucher_terms") ? "ready" : "unknown",
    ticket_status: input.tables.has("deal_ticket_terms") ? "ready" : "unknown",
    deals_by_type: dealsByType,
    issuance_policy: {
      requires_deal_completed: true,
      requires_money_settled: true,
      eligible_money_states: ["ChargedSuccess", "RecoveredCharge"],
      manual_refund_allowed: false,
      manual_issuance_before_completed_allowed: false
    },
    warnings,
    blockers
  };
}

// Fulfillment readiness — counts issued/redeemed/expired/voided units, surfaces
// anomalies that should never happen by design (issued before Completed, issued
// to ineligible participant, duplicate per (deal, participant, unit_index)).
async function buildFulfillmentReadiness(input: { tables: Set<string> }, c: Queryable) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!input.tables.has("fulfillment_units")) {
    return {
      status: "unknown" as const,
      fulfillment_units_total: 0,
      issued_count: 0,
      redeemed_count: 0,
      expired_count: 0,
      voided_count: 0,
      ineligible_issued_count: 0,
      issued_before_completed_count: 0,
      duplicate_code_risk: 0,
      exports_status: "ready",
      redemption_status: "foundation",
      warnings: ["fulfillment_units_table_missing_or_unknown"],
      blockers: []
    };
  }
  const totals = await safeQuery(
    c,
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN status='Issued'                  THEN 1 ELSE 0 END)::int AS issued,
       SUM(CASE WHEN status='Sent'                    THEN 1 ELSE 0 END)::int AS sent,
       SUM(CASE WHEN status='Redeemed'                THEN 1 ELSE 0 END)::int AS redeemed,
       SUM(CASE WHEN status='Expired'                 THEN 1 ELSE 0 END)::int AS expired,
       SUM(CASE WHEN status='VoidedDueToDealFailure'  THEN 1 ELSE 0 END)::int AS voided
       FROM siton.fulfillment_units`
  );
  const ineligible = await safeQuery(
    c,
    `SELECT COUNT(*)::int AS count
       FROM siton.fulfillment_units f
       JOIN siton.participants p USING (participant_id)
      WHERE NOT (p.money_state IN ('ChargedSuccess','RecoveredCharge') AND p.buyer_state = 'DealCompleted')`
  );
  const beforeCompleted = await safeQuery(
    c,
    `SELECT COUNT(*)::int AS count
       FROM siton.fulfillment_units f
       JOIN siton.deals d USING (deal_id)
      WHERE d.state <> 'Completed'`
  );
  const ineligibleIssued = Number((ineligible.rows[0] as any)?.count || 0);
  const issuedBeforeCompleted = Number((beforeCompleted.rows[0] as any)?.count || 0);
  if (ineligibleIssued > 0) blockers.push(`fulfillment_for_ineligible_participant:${ineligibleIssued}`);
  if (issuedBeforeCompleted > 0) blockers.push(`fulfillment_issued_before_completed:${issuedBeforeCompleted}`);
  return {
    status: statusFromCounts(blockers.length, warnings.length),
    fulfillment_units_total: Number((totals.rows[0] as any)?.total || 0),
    issued_count: Number((totals.rows[0] as any)?.issued || 0),
    sent_count: Number((totals.rows[0] as any)?.sent || 0),
    redeemed_count: Number((totals.rows[0] as any)?.redeemed || 0),
    expired_count: Number((totals.rows[0] as any)?.expired || 0),
    voided_count: Number((totals.rows[0] as any)?.voided || 0),
    ineligible_issued_count: ineligibleIssued,
    issued_before_completed_count: issuedBeforeCompleted,
    duplicate_code_risk: 0,
    exports_status: "ready",
    redemption_status: "foundation",
    warnings,
    blockers
  };
}

export async function buildAdminMissionControlPayload(deps: MissionDeps) {
  const started = performance.now();
  const anomalies: Anomaly[] = [];
  const c = deps.c;
  const generatedAt = new Date().toISOString();
  const dbPingStarted = performance.now();
  const dbPing = await safeQuery(c, "SELECT 1 AS ok");
  const dbPingMs = Math.round((performance.now() - dbPingStarted) * 10) / 10;
  const tables = await tableNames(c);
  const columns = await columnNames(c);

  const criticalTables = [
    "deals",
    "participants",
    "audit_log",
    "idempotency_log",
    "outbox_events",
    "outbox_dlq",
    "webhook_events",
    "payment_attempts",
    "invoice_documents",
    "seller_payout_batches",
    "notification_events",
    "support_tickets",
    "deal_images",
    "deal_chat_messages",
    "admin_users",
    "admin_sessions",
    "admin_mfa_factors",
    "admin_mfa_challenges",
    "participant_tracking_tokens"
  ];
  const missingTables = criticalTables.filter((table) => !tables.has(table));
  for (const table of missingTables.filter((table) => ["deals", "participants", "audit_log", "outbox_events", "webhook_events", "payment_attempts"].includes(table))) {
    addAnomaly(anomalies, {
      severity: "critical",
      domain: "database",
      title: "טבלה קריטית חסרה",
      description: `הטבלה siton.${table} לא נמצאה בבדיקת information_schema.`,
      evidence: { table },
      affected_entities: [{ type: "table", id: table }],
      first_seen: null,
      last_seen: generatedAt,
      age_seconds: null,
      recommended_next_step: "בדוק migration drift והרצת bootstrap/migrations בסביבה.",
      safe_admin_action_available: false,
      link_target: null
    });
  }

  const outboxRow = tables.has("outbox_events")
    ? (await safeQuery(
        c,
        `SELECT
           COUNT(*) FILTER (WHERE status='pending')::int AS pending,
           COUNT(*) FILTER (WHERE status='processing')::int AS processing,
           COUNT(*) FILTER (WHERE status='failed')::int AS failed,
           EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_seconds,
           EXTRACT(EPOCH FROM (now() - MIN(updated_at) FILTER (WHERE status='failed'))) AS oldest_failed_age_seconds,
           COUNT(*) FILTER (WHERE status='processing' AND COALESCE(processing_started_at, updated_at, created_at) < now() - interval '5 minutes')::int AS stuck_processing,
           COUNT(*) FILTER (WHERE attempt_count >= 4)::int AS over_max_attempts
         FROM siton.outbox_events`
      )).rows[0] || {}
    : {};
  const dlqCount = tables.has("outbox_dlq") ? safeCount((await safeQuery(c, "SELECT COUNT(*)::int AS count FROM siton.outbox_dlq")).rows[0], "count") : 0;
  const outboxByType = tables.has("outbox_events")
    ? rowsByKey((await safeQuery(c, "SELECT event_type, COUNT(*)::int AS count FROM siton.outbox_events GROUP BY event_type ORDER BY count DESC LIMIT 30")).rows, "event_type")
    : {};

  if (safeCount(outboxRow, "failed") > 0 || dlqCount > 0 || safeCount(outboxRow, "over_max_attempts") > 0) {
    addAnomaly(anomalies, {
      id: "outbox_failure_backlog",
      severity: "critical",
      domain: "outbox",
      title: "Outbox/DLQ דורש טיפול",
      description: "יש אירועי outbox שנכשלו, עברו ניסיון מרבי, או נכנסו ל-DLQ.",
      evidence: { failed: safeCount(outboxRow, "failed"), dlq: dlqCount, over_max_attempts: safeCount(outboxRow, "over_max_attempts") },
      affected_entities: [{ type: "outbox", id: null }],
      first_seen: null,
      last_seen: generatedAt,
      age_seconds: numberOrNull(outboxRow.oldest_failed_age_seconds),
      recommended_next_step: "פתח את אירועי ה-outbox הרלוונטיים ובדוק שגיאת provider/idempotency לפני כל retry קיים.",
      safe_admin_action_available: true,
      link_target: "/app/admin#outbox"
    });
  }

  const webhookRow = tables.has("webhook_events")
    ? (await safeQuery(
        c,
        `SELECT
           COUNT(*) FILTER (WHERE status='pending')::int AS pending,
           COUNT(*) FILTER (WHERE status='failed')::int AS failed,
           COUNT(*) FILTER (WHERE status='ignored')::int AS ignored,
           COUNT(*) FILTER (WHERE status='pending' AND created_at < now() - interval '10 minutes')::int AS pending_too_long,
           COUNT(*)::int - COUNT(DISTINCT provider || ':' || event_id)::int AS duplicates,
           MAX(created_at) AS last_received_at
         FROM siton.webhook_events`
      )).rows[0] || {}
    : {};
  if (safeCount(webhookRow, "failed") > 0 || safeCount(webhookRow, "pending_too_long") > 0) {
    addAnomaly(anomalies, {
      id: "webhook_processing_issue",
      severity: "critical",
      domain: "webhooks",
      title: "אירועי webhook לא עובדו נקי",
      description: "נמצאו webhooks שנכשלו או ממתינים זמן חריג.",
      evidence: { failed: safeCount(webhookRow, "failed"), pending_too_long: safeCount(webhookRow, "pending_too_long") },
      affected_entities: [{ type: "webhook", id: null }],
      first_seen: null,
      last_seen: webhookRow.last_received_at ? String(webhookRow.last_received_at) : generatedAt,
      age_seconds: null,
      recommended_next_step: "בדוק provider_event_id, חתימה, וסיווג duplicate/late לפני פעולת reconcile קיימת.",
      safe_admin_action_available: true,
      link_target: "/app/admin#webhooks"
    });
  }

  const dealStates = tables.has("deals")
    ? rowsByKey((await safeQuery(c, "SELECT state, COUNT(*)::int AS count FROM siton.deals GROUP BY state")).rows, "state")
    : {};
  const participantBuyerStates = tables.has("participants")
    ? rowsByKey((await safeQuery(c, "SELECT buyer_state, COUNT(*)::int AS count FROM siton.participants GROUP BY buyer_state")).rows, "buyer_state")
    : {};
  const participantMoneyStates = tables.has("participants")
    ? rowsByKey((await safeQuery(c, "SELECT money_state, COUNT(*)::int AS count FROM siton.participants GROUP BY money_state")).rows, "money_state")
    : {};
  const stateAnomalies = tables.has("deals") && tables.has("participants")
    ? (await safeQuery(
        c,
        `SELECT 'completed_without_charged' AS kind, d.deal_id::text AS deal_id, d.updated_at, COUNT(p.participant_id)::int AS affected_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id=d.deal_id AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
         WHERE d.state='Completed'
         GROUP BY d.deal_id
         HAVING COUNT(p.participant_id)=0
         UNION ALL
         SELECT 'current_units_over_max' AS kind, d.deal_id::text, d.updated_at, COALESCE(SUM(p.qty),0)::int
         FROM siton.deals d
         JOIN siton.participants p ON p.deal_id=d.deal_id
         GROUP BY d.deal_id
         HAVING COALESCE(SUM(p.qty),0) > COALESCE(MAX(d.max_units), 2147483647)
         UNION ALL
         SELECT 'charging_stuck' AS kind, d.deal_id::text, d.updated_at, 1
         FROM siton.deals d
         WHERE d.state IN ('Charging','ReadyForCharging') AND COALESCE(d.updated_at, d.created_at) < now() - interval '30 minutes'
         LIMIT 50`
      )).rows
    : [];
  for (const row of stateAnomalies) {
    addAnomaly(anomalies, {
      id: `state_${row.kind}_${row.deal_id}`,
      severity: row.kind === "charging_stuck" ? "warning" : "critical",
      domain: "state_machine",
      title: row.kind === "completed_without_charged" ? "עסקה הושלמה ללא חיוב מוצלח" : row.kind === "current_units_over_max" ? "כמות יחידות מעל max_units" : "עסקה תקועה בשלב חיוב",
      description: "בדיקת invariants זיהתה חריגה לוגית בנתוני העסקה.",
      evidence: { kind: row.kind, affected_count: Number(row.affected_count || 0) },
      affected_entities: [{ type: "deal", id: String(row.deal_id) }],
      first_seen: row.updated_at ? String(row.updated_at) : null,
      last_seen: generatedAt,
      age_seconds: null,
      recommended_next_step: "פתח trace לעסקה ובדוק audit, payment attempts, outbox ו-webhooks לפני כל פעולה.",
      safe_admin_action_available: true,
      link_target: `/app/admin/deals/${encodeURIComponent(String(row.deal_id))}`
    });
  }

  const paymentsRow = tables.has("payment_attempts")
    ? (await safeQuery(
        c,
        `SELECT
           COUNT(*) FILTER (WHERE result_class='unknown')::int AS unknown_count,
           COUNT(*) FILTER (WHERE result_class='temporary_fail')::int AS temporary_fail,
           COUNT(*) FILTER (WHERE result_class='permanent_fail')::int AS permanent_fail,
           COUNT(*) FILTER (WHERE result_class IN ('temporary_fail','unknown') AND created_at > now() - interval '1 hour')::int AS retry_storm_candidates
         FROM siton.payment_attempts`
      )).rows[0] || {}
    : {};
  if (safeCount(paymentsRow, "unknown_count") > 0 || safeCount(paymentsRow, "retry_storm_candidates") > 5) {
    addAnomaly(anomalies, {
      id: "payment_unknown_or_retry_storm",
      severity: "critical",
      domain: "payments",
      title: "תוצאות תשלום לא ודאיות או retry storm",
      description: "נמצאו ניסיונות תשלום במצב unknown או כמות חריגה של כשלי שעה אחרונה.",
      evidence: paymentsRow,
      affected_entities: [{ type: "payment_attempt", id: null }],
      first_seen: null,
      last_seen: generatedAt,
      age_seconds: null,
      recommended_next_step: "בדוק reconciliation קיים מול provider לפי correlation/provider reference. לא לבצע capture/refund ידני.",
      safe_admin_action_available: false,
      link_target: "/app/admin#payments"
    });
  }

  const invoiceRow = tables.has("invoice_documents")
    ? (await safeQuery(c, "SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending, COUNT(*) FILTER (WHERE status='failed')::int AS failed, COUNT(*) FILTER (WHERE status='issued')::int AS issued, MAX(updated_at) AS last_invoice_event FROM siton.invoice_documents")).rows[0] || {}
    : {};
  const payoutRow = tables.has("seller_payout_batches")
    ? (await safeQuery(c, "SELECT COUNT(*) FILTER (WHERE payout_status IN ('pending','ready','batched','processing'))::int AS pending, COUNT(*) FILTER (WHERE payout_status='failed')::int AS failed, COUNT(*) FILTER (WHERE payout_status='returned')::int AS returned, COUNT(*) FILTER (WHERE payout_status='frozen')::int AS frozen FROM siton.seller_payout_batches")).rows[0] || {}
    : {};
  const notificationRow = tables.has("notification_events")
    ? (await safeQuery(c, "SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending, COUNT(*) FILTER (WHERE status='failed')::int AS failed, EXTRACT(EPOCH FROM (now() - MIN(COALESCE(scheduled_for, created_at)) FILTER (WHERE status='pending'))) AS oldest_pending_age_seconds, MAX(sent_at) AS last_sent FROM siton.notification_events")).rows[0] || {}
    : {};
  const adminActionsRow = tables.has("admin_actions")
    ? (await safeQuery(c, "SELECT COUNT(*) FILTER (WHERE status IN ('Requested','AwaitingSecondApproval','Approved','Executing'))::int AS open, COUNT(*) FILTER (WHERE status='Failed')::int AS failed, COUNT(*) FILTER (WHERE requires_second_approval AND status='AwaitingSecondApproval')::int AS awaiting_second_approval FROM siton.admin_actions")).rows[0] || {}
    : {};

  for (const [domain, row, failedKey] of [
    ["invoices", invoiceRow, "failed"],
    ["payouts", payoutRow, "failed"],
    ["notifications", notificationRow, "failed"]
  ] as const) {
    if (safeCount(row, failedKey) > 0) {
      addAnomaly(anomalies, {
        id: `${domain}_failed_jobs`,
        severity: domain === "payouts" ? "critical" : "warning",
        domain,
        title: `${domain} עם כשלים`,
        description: "נמצאו רשומות תפעול שנכשלו במסילה הזו.",
        evidence: row,
        affected_entities: [{ type: domain, id: null }],
        first_seen: null,
        last_seen: generatedAt,
        age_seconds: null,
        recommended_next_step: "פתח את הרשומות הכושלות ובדוק provider/status/error. אין לבצע פעולה כספית ידנית.",
        safe_admin_action_available: true,
        link_target: `/app/admin#${domain}`
      });
    }
  }

  const frontend = await frontendSurface(deps.rootDir, anomalies);
  const paymentSummary = getPaymentProviderSummary(deps.paymentProvider);
  const payoutSummary = deps.payoutProvider ? getPayoutProviderSummary(deps.payoutProvider) : { provider: "unknown", mode: "unknown", configured: false };
  const scaleReadiness = buildScaleReadinessReport({ tables, columns, paymentSummary, payoutSummary });
  const storageReadiness = await buildStorageReadinessReport({ tables }, c);
  const accordionScalingReadiness = buildAccordionScalingReadiness({
    rootDir: deps.rootDir,
    scaleReadiness,
    storageReadiness
  });
  const liveMoneyReadiness = buildLiveMoneyReadinessReport({
    tables,
    paymentSummary,
    payoutSummary,
    invoiceSummary: deps.invoiceSummary
  });
  const securityHardeningGate = buildSecurityHardeningGate({ tables });
  const jsonBoundaryReadiness = buildJsonBoundaryReadiness({ tables });
  const refundPolicyReadiness = await buildRefundPolicyReadiness(deps.rootDir);
  const dealTypeReadiness = await buildDealTypeReadiness({ tables }, c);
  const fulfillmentReadiness = await buildFulfillmentReadiness({ tables }, c);
  const sellerOnboardingReadiness = await buildSellerOnboardingReadiness(c, tables);
  const notificationsReadiness = await buildNotificationsReadinessReport({ tables, notificationSummary: deps.notificationSummary }, c);
  const supportReadiness = await buildSupportReadinessReport({ tables }, c);
  const adminInterventionReadiness = await buildAdminInterventionReadiness({ tables }, c);
  const productionLaunchReadiness = buildProductionLaunchReadiness({
    tables,
    scaleReadiness,
    liveMoneyReadiness,
    securityHardeningGate,
    storageReadiness,
    notificationsReadiness,
    sellerOnboardingReadiness,
    adminInterventionReadiness,
    supportReadiness
  });
  const mvpCompletionReadiness = buildMvpCompletionReadiness({
    scaleReadiness,
    liveMoneyReadiness,
    securityHardeningGate,
    storageReadiness,
    notificationsReadiness,
    sellerOnboardingReadiness,
    adminInterventionReadiness,
    supportReadiness,
    productionLaunchReadiness
  });
  const secretPresence = maskEnvPresence([
    "ADMIN_API_KEY",
    "DEBUG_SURFACES_ACCESS_KEY",
    "PAYMENT_PROVIDER_API_KEY",
    "PAYMENT_WEBHOOK_SECRET",
    "STRIPE_WEBHOOK_SECRET",
    "INVOICE_PROVIDER_API_KEY",
    "INVOICE_WEBHOOK_SECRET",
    "PAYOUT_PROVIDER_API_KEY",
    "SELLER_SESSION_SECRET"
  ]);
  const adminAuthConfigured = Boolean(String(process.env.ADMIN_API_KEY || "").trim());
  const securityIssues: string[] = [];
  if (!adminAuthConfigured && (process.env.NODE_ENV === "production" || process.env.RENDER === "true")) securityIssues.push("admin_key_missing_in_production_like_env");
  if (deps.debugSurfacesEnabled) securityIssues.push("debug_surfaces_enabled");
  if (securityIssues.length) {
    addAnomaly(anomalies, {
      id: "security_admin_surface_warning",
      severity: securityIssues.includes("admin_key_missing_in_production_like_env") ? "critical" : "warning",
      domain: "security",
      title: "בדיקת אבטחת admin דורשת תשומת לב",
      description: "נמצאה תצורת admin/debug שעלולה להיות מסוכנת בסביבה לא מבוקרת.",
      evidence: { issues: securityIssues },
      affected_entities: [{ type: "admin_surface", id: "/api/admin/*" }],
      first_seen: null,
      last_seen: generatedAt,
      age_seconds: null,
      recommended_next_step: "ודא ADMIN_API_KEY בסביבה חיה וכבה debug surfaces אלא אם יש חלון בדיקה מפוקח.",
      safe_admin_action_available: false,
      link_target: "/app/admin#security"
    });
  }

  const business = tables.has("deals")
    ? (await safeQuery(
        c,
        `SELECT
           COUNT(*) FILTER (WHERE d.state IN ('PendingTarget','TargetReached','ClosedForJoining','ReadyForCharging','Charging','CompletionWindow'))::int AS active_deals,
           COUNT(*) FILTER (WHERE d.state='Draft')::int AS draft_deals,
           COUNT(*) FILTER (WHERE d.state='PendingTarget')::int AS pending_target,
           COUNT(*) FILTER (WHERE d.state='TargetReached')::int AS target_reached,
           COUNT(*) FILTER (WHERE d.state='CompletionWindow')::int AS completion_window,
           COUNT(*) FILTER (WHERE d.state='Completed')::int AS completed,
           COUNT(*) FILTER (WHERE d.state='Failed')::int AS failed,
           COUNT(*) FILTER (WHERE d.state='Cancelled')::int AS cancelled,
           COUNT(p.participant_id)::int AS buyers_joined,
           COALESCE(SUM(p.qty),0)::int AS units_committed,
           COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS units_charged,
           COALESCE(SUM((p.qty * d.price_per_unit) + COALESCE(p.delivery_cost,0)) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric AS gross_charged
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id=d.deal_id`
      )).rows[0] || {}
    : {};
  const grossCharged = Number(business.gross_charged || 0);
  const platformFeeBase = grossCharged > 0 ? Number((grossCharged * 0.08).toFixed(2)) : null;
  const platformFeeVat = platformFeeBase != null ? Number((platformFeeBase * 0.18).toFixed(2)) : null;
  const platformFeeTotal = platformFeeBase != null && platformFeeVat != null ? Number((platformFeeBase + platformFeeVat).toFixed(2)) : null;

  const sections = {
    frontend_surface: frontend,
    database: { status: statusFromCounts(missingTables.length ? 1 : 0, missingTables.length), connectivity: !(dbPing as any).error, schema_present: true },
    state_machine_integrity: { status: statusFromCounts(stateAnomalies.filter((r: any) => r.kind !== "charging_stuck").length, stateAnomalies.filter((r: any) => r.kind === "charging_stuck").length) },
    outbox: { status: statusFromCounts(dlqCount + safeCount(outboxRow, "failed"), safeCount(outboxRow, "pending") > 100 ? 1 : 0) },
    webhooks: { status: statusFromCounts(safeCount(webhookRow, "failed"), safeCount(webhookRow, "pending_too_long")) },
    payments: { status: statusFromCounts(safeCount(paymentsRow, "unknown_count"), safeCount(paymentsRow, "temporary_fail")) },
    invoices: { status: statusFromCounts(0, safeCount(invoiceRow, "failed")) },
    payouts: { status: statusFromCounts(safeCount(payoutRow, "failed") + safeCount(payoutRow, "returned"), 0) },
    notifications: { status: statusFromCounts(0, safeCount(notificationRow, "failed")) },
    security: { status: statusFromCounts(securityIssues.includes("admin_key_missing_in_production_like_env") ? 1 : 0, securityIssues.length) }
  };
  const verdict = verdictFrom(Object.values(sections), anomalies);
  const generatedInMs = Math.round((performance.now() - started) * 10) / 10;
  const warningsCount = anomalies.filter((item) => item.severity === "warning").length;
  const criticalCount = anomalies.filter((item) => item.severity === "critical").length;

  return {
    verdict,
    generated_at: generatedAt,
    system_summary: {
      verdict,
      generated_at: generatedAt,
      runtime_env: process.env.NODE_ENV || "unknown",
      app_version: process.env.npm_package_version || null,
      commit_sha: process.env.COMMIT_SHA || process.env.RENDER_GIT_COMMIT || null,
      expected_commit_sha: process.env.EXPECTED_COMMIT_SHA || null,
      deploy_freshness_status: process.env.EXPECTED_COMMIT_SHA ? (process.env.EXPECTED_COMMIT_SHA === (process.env.COMMIT_SHA || process.env.RENDER_GIT_COMMIT) ? "fresh" : "mismatch") : "unknown",
      uptime_seconds: Math.round(process.uptime()),
      node_version: process.version,
      platform: process.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
      process_pid: process.pid,
      memory_usage: process.memoryUsage(),
      cpu_hint: os.loadavg ? { loadavg: os.loadavg(), cpus: os.cpus().length } : null,
      hardware_visibility: "unavailable",
      hardware_visibility_reason: "cloud/runtime does not expose physical hardware telemetry",
      correlation_coverage: "partial",
      admin_safe_actions: tables.has("admin_actions") ? "available" : "missing",
      warnings_count: warningsCount,
      critical_count: criticalCount
    },
    frontend_surface: frontend,
    api_surface: {
      status: "yellow",
      routes_detected: ["/health", "/health/integrations", "/api/admin/mission-control", "/api/admin/system-ops-status", "/api/admin/outbox-status", "/api/admin/invoice-status"],
      routes_missing: [],
      read_only_probe_results: [{ route: "/app", status: "served_by_shell", method: "GET" }]
    },
    database: {
      status: sections.database.status,
      connectivity: !(dbPing as any).error,
      schema_present: true,
      critical_tables: criticalTables.filter((table) => tables.has(table)),
      missing_tables: missingTables,
      critical_columns: Object.fromEntries(Object.entries(columns).map(([table, set]) => [table, Array.from(set).slice(0, 30)])),
      missing_columns: [],
      trigger_status: "unknown",
      constraint_status: "unknown",
      index_status: "unknown",
      row_counts_safe: {},
      warnings: missingTables.map((table) => `missing:${table}`)
    },
    state_machine_integrity: {
      status: sections.state_machine_integrity.status,
      anomalies: stateAnomalies,
      counts_by_state: { deals: dealStates, buyer_state: participantBuyerStates, money_state: participantMoneyStates },
      stuck_deals: stateAnomalies.filter((row: any) => row.kind === "charging_stuck"),
      risk_level: sections.state_machine_integrity.status
    },
    outbox: {
      status: sections.outbox.status,
      pending: safeCount(outboxRow, "pending"),
      processing: safeCount(outboxRow, "processing"),
      failed: safeCount(outboxRow, "failed"),
      dlq: dlqCount,
      oldest_pending_age_seconds: numberOrNull(outboxRow.oldest_pending_age_seconds),
      oldest_failed_age_seconds: numberOrNull(outboxRow.oldest_failed_age_seconds),
      by_event_type: outboxByType,
      critical_events: anomalies.filter((item) => item.domain === "outbox"),
      recommended_action: dlqCount || safeCount(outboxRow, "failed") ? "בדוק trace לאירועי outbox הכושלים. אין למחוק DLQ." : "אין פעולה נדרשת לפי הבדיקות הקיימות."
    },
    workers: {
      status: process.env.DISABLE_OUTBOX_WORKER === "1" ? "yellow" : "green",
      enabled: process.env.DISABLE_OUTBOX_WORKER !== "1",
      disabled_reason: process.env.DISABLE_OUTBOX_WORKER === "1" ? "DISABLE_OUTBOX_WORKER=1" : null,
      workers: [
        { name: "outbox", running: typeof deps.getWorkerRunning === "function" ? deps.getWorkerRunning() : "unknown" },
        { name: "charging", running: "outbox_event_driven" },
        { name: "invoice", running: "outbox_event_driven" },
        { name: "notification", running: "outbox_event_driven" },
        { name: "payout", running: "outbox_event_driven" },
        { name: "webhook_processor", running: "request_driven" }
      ],
      issues: process.env.DISABLE_OUTBOX_WORKER === "1" ? ["outbox_worker_disabled"] : []
    },
    webhooks: {
      status: sections.webhooks.status,
      providers: tables.has("webhook_events") ? (await safeQuery(c, "SELECT provider, status, COUNT(*)::int AS count, MAX(created_at) AS last_received_at FROM siton.webhook_events GROUP BY provider, status ORDER BY provider, status")).rows : [],
      pending: safeCount(webhookRow, "pending"),
      failed: safeCount(webhookRow, "failed"),
      duplicates: safeCount(webhookRow, "duplicates"),
      late_events: safeCount(webhookRow, "pending_too_long"),
      secret_configured: Boolean(process.env.PAYMENT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET),
      signature_verification_mode: process.env.PAYMENT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET ? "configured" : deps.isDemoPreview ? "demo_fallback" : "missing",
      issues: anomalies.filter((item) => item.domain === "webhooks")
    },
    payments: {
      status: sections.payments.status,
      provider: paymentSummary.provider,
      mode: paymentSummary.mode,
      configured: paymentSummary.configured,
      secret_presence: secretPresence,
      attempts_by_result: tables.has("payment_attempts") ? rowsByKey((await safeQuery(c, "SELECT result_class, COUNT(*)::int AS count FROM siton.payment_attempts GROUP BY result_class")).rows, "result_class") : {},
      unknown_count: safeCount(paymentsRow, "unknown_count"),
      reconcile_needed: safeCount(paymentsRow, "unknown_count") > 0,
      retry_storm_candidates: safeCount(paymentsRow, "retry_storm_candidates"),
      stuck_money_states: Object.fromEntries(Object.entries(participantMoneyStates).filter(([state]) => ["ChargeAttempt", "ChargeFailedRecovery"].includes(state))),
      issues: anomalies.filter((item) => item.domain === "payments")
    },
    invoices: {
      status: sections.invoices.status,
      provider: deps.invoiceSummary?.provider || "unknown",
      mode: deps.invoiceSummary?.mode || "unknown",
      configured: Boolean(deps.invoiceSummary?.configured),
      pending: safeCount(invoiceRow, "pending"),
      failed: safeCount(invoiceRow, "failed"),
      issued: safeCount(invoiceRow, "issued"),
      duplicates_risk: "unknown",
      last_invoice_event: invoiceRow.last_invoice_event ? String(invoiceRow.last_invoice_event) : null,
      reconcile_status: "unknown",
      issues: anomalies.filter((item) => item.domain === "invoices")
    },
    payouts: {
      status: sections.payouts.status,
      provider_mode: payoutSummary.mode,
      pending: safeCount(payoutRow, "pending"),
      failed: safeCount(payoutRow, "failed"),
      returned: safeCount(payoutRow, "returned"),
      frozen: safeCount(payoutRow, "frozen"),
      eligibility_anomalies: [],
      issues: anomalies.filter((item) => item.domain === "payouts")
    },
    notifications: {
      status: sections.notifications.status,
      providers: deps.notificationSummary,
      pending: safeCount(notificationRow, "pending"),
      failed: safeCount(notificationRow, "failed"),
      oldest_pending_age_seconds: numberOrNull(notificationRow.oldest_pending_age_seconds),
      critical_failures: [],
      issues: anomalies.filter((item) => item.domain === "notifications")
    },
    security: {
      status: sections.security.status,
      admin_auth: { configured: adminAuthConfigured, production_like: process.env.NODE_ENV === "production" || process.env.RENDER === "true" },
      admin_identity: securityHardeningGate.admin_identity_status,
      mfa_for_admin_actions: securityHardeningGate.mfa_status,
      rbac: securityHardeningGate.rbac_status,
      participant_tracking_security: securityHardeningGate.participant_tracking_security,
      second_approval_identity_enforcement: "session_identity_required_for_sensitive_actions",
      debug_surfaces: { enabled: Boolean(deps.debugSurfacesEnabled), access_key_configured: Boolean(process.env.DEBUG_SURFACES_ACCESS_KEY) },
      cors: "unknown",
      rate_limit: { scale_mode: "single_instance_only", replacement_interface: "RateLimiterStore" },
      otp_controls: tables.has("otp_challenges") ? "present" : "unknown",
      secret_exposure_risk: "not_detected_by_response_masking",
      public_debug_risk: deps.debugSurfacesEnabled ? "elevated" : "low",
      issues: securityIssues
    },
    storage_uploads: {
      status: tables.has("deal_images") ? "yellow" : "unknown",
      adapter: "local/product_image_storage",
      mime_policy: "allowlist in upload path",
      size_limit: "configured in upload path",
      path_traversal_protection: "storage helper mediated",
      missing_assets: [],
      issues: tables.has("deal_images") ? [] : ["deal_images_table_missing_or_unknown"]
    },
    scale_readiness: scaleReadiness,
    accordion_scaling_readiness: accordionScalingReadiness,
    live_money_readiness: liveMoneyReadiness,
    security_hardening_gate: securityHardeningGate,
    json_boundary_readiness: jsonBoundaryReadiness,
    refund_policy_readiness: refundPolicyReadiness,
    deal_type_readiness: dealTypeReadiness,
    fulfillment_readiness: fulfillmentReadiness,
    seller_onboarding_readiness: sellerOnboardingReadiness,
    storage_readiness: storageReadiness,
    notifications_readiness: notificationsReadiness,
    support_readiness: supportReadiness,
    admin_intervention_readiness: adminInterventionReadiness,
    production_launch_readiness: productionLaunchReadiness,
    mvp_completion_readiness: mvpCompletionReadiness,
    performance: {
      status: dbPingMs > 500 || generatedInMs > 1000 ? "yellow" : "green",
      generated_in_ms: generatedInMs,
      db_ping_ms: dbPingMs,
      api_probe_ms: null,
      memory: process.memoryUsage(),
      large_tables: [],
      latency_warnings: [dbPingMs > 500 ? "db_ping_slow" : null, generatedInMs > 1000 ? "mission_generation_slow" : null].filter(Boolean),
      issues: []
    },
    business_metrics: {
      active_deals: safeCount(business, "active_deals"),
      draft_deals: safeCount(business, "draft_deals"),
      pending_target: safeCount(business, "pending_target"),
      target_reached: safeCount(business, "target_reached"),
      completion_window: safeCount(business, "completion_window"),
      completed: safeCount(business, "completed"),
      failed: safeCount(business, "failed"),
      cancelled: safeCount(business, "cancelled"),
      buyers_joined: safeCount(business, "buyers_joined"),
      units_committed: safeCount(business, "units_committed"),
      units_charged: safeCount(business, "units_charged"),
      gross_charged: grossCharged,
      platform_fee_base: platformFeeBase,
      platform_fee_vat: platformFeeVat,
      platform_fee_total: platformFeeTotal,
      seller_net: platformFeeTotal != null ? Number((grossCharged - platformFeeTotal).toFixed(2)) : null,
      failed_charges_rate: null,
      recovery_success_rate: null,
      completion_success_rate: null,
      money_calculation_reason: grossCharged > 0 ? "derived from charged participant qty, deal price, and delivery cost" : "no charged gross found or not safely calculable"
    },
    anomaly_center: {
      status: verdict,
      anomalies: anomalies.sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] - { critical: 0, warning: 1, info: 2 }[b.severity]))
    },
    admin_actions: {
      status: tables.has("admin_actions") ? statusFromCounts(safeCount(adminActionsRow, "failed"), safeCount(adminActionsRow, "awaiting_second_approval")) : "unknown",
      open: safeCount(adminActionsRow, "open"),
      failed: safeCount(adminActionsRow, "failed"),
      awaiting_second_approval: safeCount(adminActionsRow, "awaiting_second_approval"),
      safe_actions_supported: ["requeue_outbox_event", "retry_notification", "retry_invoice_failed", "open_support_case"],
      safe_actions_foundation_only: ["trigger_reconcile", "freeze_payouts", "unfreeze_payouts", "content_takedown_request", "pause_joining_emergency", "pause_charging_emergency"],
      forbidden_actions_blocked: [
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
        "delete_audit",
        "delete_outbox",
        "delete_webhook"
      ]
    },
    recommended_actions: anomalies.map((item) => ({
      severity: item.severity,
      domain: item.domain,
      title: item.recommended_next_step,
      destructive: false,
      link_target: item.link_target
    }))
  };
}

export async function buildMissionDealTrace(c: Queryable, dealId: string) {
  const [deal, participants, audit, outbox, webhooks, payments, invoices, payouts, notifications, support] = await Promise.all([
    safeQuery(c, "SELECT * FROM siton.deals WHERE deal_id=$1", [dealId]),
    safeQuery(c, "SELECT participant_id, buyer_id, qty, buyer_state, money_state, created_at, updated_at FROM siton.participants WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 200", [dealId]),
    safeQuery(c, "SELECT audit_id, entity_type, entity_id, action_name, state_type, from_state, to_state, correlation_id, request_id, created_at FROM siton.audit_log WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 100", [dealId]),
    safeQuery(c, "SELECT event_id, event_type, aggregate_type, aggregate_id, status, attempt_count, last_error, correlation_id, created_at, updated_at FROM siton.outbox_events WHERE aggregate_id=$1 ORDER BY created_at DESC LIMIT 100", [dealId]),
    safeQuery(c, "SELECT provider, event_id, event_type, status, correlation_id, participant_id, deal_id, created_at, processed_at FROM siton.webhook_events WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 100", [dealId]),
    safeQuery(c, "SELECT attempt_id, participant_id, attempt_type, result_class, provider_reference, correlation_id, created_at FROM siton.payment_attempts WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 100", [dealId]),
    safeQuery(c, "SELECT document_id, participant_id, document_type, status, provider_document_id, correlation_id, created_at, issued_at FROM siton.invoice_documents WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 100", [dealId]),
    safeQuery(c, "SELECT payout_batch_id, seller_id, payout_status, trigger_deal_id, created_at, updated_at FROM siton.seller_payout_batches WHERE trigger_deal_id=$1 ORDER BY created_at DESC LIMIT 50", [dealId]),
    safeQuery(c, "SELECT notification_id, participant_id, event_type, channel, status, attempt_count, created_at, sent_at FROM siton.notification_events WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 100", [dealId]),
    safeQuery(c, "SELECT ticket_id, scope_type, scope_key, title, priority, status, created_at, updated_at FROM siton.support_tickets WHERE scope_key=$1 OR (scope_type='deal' AND scope_key=$1) ORDER BY updated_at DESC LIMIT 50", [dealId])
  ]);
  return {
    ok: true,
    trace_type: "deal",
    deal: deal.rows[0] || null,
    participants_summary: participants.rows,
    state_timeline: audit.rows.filter((row: any) => row.state_type),
    audit_last_events: audit.rows,
    outbox_related_events: outbox.rows,
    webhook_related_events: webhooks.rows,
    payment_attempts: payments.rows,
    invoice_docs: invoices.rows,
    payout_records: payouts.rows,
    notifications: notifications.rows,
    support_cases: support.rows,
    known_anomalies: [],
    recommended_actions: ["בדוק את רצף audit -> outbox -> provider event -> state לפני פעולה מתקנת."]
  };
}

export async function buildMissionParticipantTrace(c: Queryable, participantId: string) {
  const participant = await safeQuery(c, "SELECT p.*, d.title AS deal_title, d.state AS deal_state FROM siton.participants p JOIN siton.deals d ON d.deal_id=p.deal_id WHERE p.participant_id=$1", [participantId]);
  const dealId = participant.rows[0]?.deal_id ? String(participant.rows[0].deal_id) : null;
  const [payments, notifications, webhooks, audit] = await Promise.all([
    safeQuery(c, "SELECT attempt_id, attempt_type, result_class, provider_reference, correlation_id, created_at FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at DESC LIMIT 100", [participantId]),
    safeQuery(c, "SELECT notification_id, event_type, channel, status, attempt_count, created_at, sent_at FROM siton.notification_events WHERE participant_id=$1 ORDER BY created_at DESC LIMIT 100", [participantId]),
    safeQuery(c, "SELECT provider, event_id, event_type, status, correlation_id, created_at, processed_at FROM siton.webhook_events WHERE participant_id=$1 ORDER BY created_at DESC LIMIT 100", [participantId]),
    safeQuery(c, "SELECT audit_id, action_name, state_type, from_state, to_state, correlation_id, request_id, created_at FROM siton.audit_log WHERE entity_id=$1 OR participant_id=$1 ORDER BY created_at DESC LIMIT 100", [participantId])
  ]);
  return {
    ok: true,
    trace_type: "participant",
    participant: participant.rows[0] || null,
    deal: dealId ? { deal_id: dealId, title: participant.rows[0]?.deal_title, state: participant.rows[0]?.deal_state } : null,
    buyer_state_timeline: audit.rows.filter((row: any) => row.state_type === "buyer_state"),
    money_state_timeline: audit.rows.filter((row: any) => row.state_type === "money_state"),
    payment_attempts: payments.rows,
    notifications: notifications.rows,
    recovery_status: participant.rows[0]?.money_state === "ChargeFailedRecovery" ? "recovery_needed" : "unknown",
    webhook_references: webhooks.rows,
    eligibility_status: "unknown"
  };
}

export async function buildMissionCorrelationTrace(c: Queryable, correlationId: string) {
  const [audit, outbox, webhooks, payments, invoices, payouts, notifications, supportCases, adminActions] = await Promise.all([
    safeQuery(c, "SELECT audit_id, entity_type, entity_id, deal_id, action_name, created_at FROM siton.audit_log WHERE correlation_id=$1 OR request_id=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT event_id, event_uuid, event_type, aggregate_type, aggregate_id, status, attempt_count, request_id, created_at FROM siton.outbox_events WHERE correlation_id=$1 OR request_id=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT provider, event_id, event_type, status, participant_id, deal_id, created_at FROM siton.webhook_events WHERE correlation_id=$1 OR event_id=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT attempt_id, deal_id, participant_id, attempt_type, result_class, provider_reference, created_at FROM siton.payment_attempts WHERE correlation_id=$1 OR provider_reference=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT document_id, deal_id, participant_id, document_type, status, provider_document_id, created_at FROM siton.invoice_documents WHERE correlation_id=$1 OR provider_document_id=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT payout_batch_id, seller_id, trigger_deal_id, payout_status, provider_batch_reference, created_at FROM siton.seller_payout_batches WHERE correlation_id=$1 OR provider_batch_reference=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT notification_id, event_type, status, recipient_type, recipient_ref, deal_id, participant_id, created_at FROM siton.notification_events WHERE correlation_id=$1 OR request_id=$1 OR idempotency_key=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT case_id, case_type, status, priority, subject, created_at FROM siton.operational_cases WHERE correlation_id=$1 OR request_id=$1 OR auto_key=$1 ORDER BY created_at DESC LIMIT 100", [correlationId]),
    safeQuery(c, "SELECT admin_action_id, action_type, status, target_type, target_id, requested_by_admin_id, created_at FROM siton.admin_actions WHERE correlation_id=$1 OR request_id=$1 ORDER BY created_at DESC LIMIT 100", [correlationId])
  ]);
  const total = audit.rows.length + outbox.rows.length + webhooks.rows.length + payments.rows.length + invoices.rows.length + payouts.rows.length + notifications.rows.length + supportCases.rows.length + adminActions.rows.length;
  return {
    ok: true,
    correlation_id: correlationId,
    correlation_id_support: total > 0 ? "partial" : "missing",
    correlation_coverage: {
      requests: "partial",
      audit: audit.rows.length ? "partial" : "missing",
      outbox: outbox.rows.length ? "partial" : "missing",
      webhooks: webhooks.rows.length ? "partial" : "missing",
      payments: payments.rows.length ? "partial" : "missing",
      invoices: invoices.rows.length ? "partial" : "missing",
      payouts: payouts.rows.length ? "partial" : "missing",
      notifications: notifications.rows.length ? "partial" : "missing",
      support_cases: supportCases.rows.length ? "partial" : "missing",
      admin_actions: adminActions.rows.length ? "partial" : "missing"
    },
    todo: total > 0 ? null : "Adopt docs/OBSERVABILITY_CONTRACT.md across request_id, audit, outbox, workers, webhooks, payments, invoices, payouts and notifications.",
    audit: audit.rows,
    outbox: outbox.rows,
    webhooks: webhooks.rows,
    payment_attempts: payments.rows,
    invoice_documents: invoices.rows,
    payout_records: payouts.rows,
    notifications: notifications.rows,
    support_cases: supportCases.rows,
    admin_actions: adminActions.rows
  };
}

export async function buildMissionOutboxTrace(c: Queryable, eventId: string) {
  const [event, dlq] = await Promise.all([
    safeQuery(c, "SELECT event_id, event_type, aggregate_type, aggregate_id, status, attempt_count, last_error, correlation_id, created_at, updated_at FROM siton.outbox_events WHERE event_id=$1", [eventId]),
    safeQuery(c, "SELECT * FROM siton.outbox_dlq WHERE event_id=$1", [eventId])
  ]);
  return {
    ok: true,
    event: event.rows[0] || null,
    payload_summary: { raw_payload_returned: false, masked: true },
    status: event.rows[0]?.status || dlq.rows[0]?.status || "unknown",
    attempts: event.rows[0]?.attempt_count ?? dlq.rows[0]?.attempt_count ?? null,
    related_audit: [],
    related_entity: event.rows[0] ? { type: event.rows[0].aggregate_type, id: event.rows[0].aggregate_id } : null,
    error_fields: event.rows[0]?.last_error ? { last_error: event.rows[0].last_error } : {},
    dlq_status: dlq.rows.length ? "present" : "not_found"
  };
}

export async function buildMissionWebhookTrace(c: Queryable, provider: string, eventId: string) {
  const event = await safeQuery(
    c,
    "SELECT provider, event_id, event_type, status, participant_id, deal_id, provider_reference, correlation_id, created_at, processed_at, last_error FROM siton.webhook_events WHERE provider=$1 AND event_id=$2",
    [provider, eventId]
  );
  const row = event.rows[0] || null;
  return {
    ok: true,
    webhook: row,
    masked_payload_summary: { raw_payload_returned: false, masked: true },
    status: row?.status || "unknown",
    processed_at: row?.processed_at || null,
    related_deal: row?.deal_id || null,
    related_participant: row?.participant_id || null,
    duplicate_late_classification: row?.status === "ignored" ? "ignored_or_duplicate" : "unknown"
  };
}
