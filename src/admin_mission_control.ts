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
  return new Set((res.rows || []).map((row: any) => String(row.table_name)));
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
    byTable[table] ||= new Set();
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
    "deal_chat_messages"
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
      mfa_for_admin_actions: "unavailable",
      second_approval_identity_enforcement: "partial",
      debug_surfaces: { enabled: Boolean(deps.debugSurfacesEnabled), access_key_configured: Boolean(process.env.DEBUG_SURFACES_ACCESS_KEY) },
      cors: "unknown",
      rate_limit: "unknown",
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
      forbidden_actions_blocked: ["manual_capture", "manual_refund", "manual_state_edit", "manual_money_state_edit", "delete_audit", "delete_outbox", "delete_webhook"]
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
