export type InfrastructureStatus = "GREEN" | "AMBER" | "RED";
export type InfrastructureIssueKind = "capacity" | "operational_incident";
export type MetricAvailability = "available" | "unavailable";

export const INFRASTRUCTURE_METRIC_KEYS = [
  "database_cpu_percent",
  "database_memory_percent",
  "database_connections",
  "database_max_connections",
  "database_connection_percent",
  "database_disk_percent",
  "database_size_bytes",
  "database_io_pressure_percent",
  "database_query_latency_ms",
  "database_slow_queries",
  "connection_pool_percent",
  "api_p95_latency_ms",
  "api_error_rate",
  "queue_depth",
  "oldest_queued_job_seconds",
  "worker_heartbeat_age_seconds",
  "worker_lag_seconds",
  "dlq_size",
  "webhook_failure_rate",
  "payment_provider_latency_ms",
  "payment_error_rate",
  "completion_window_stuck",
  "reconcile_jobs_stuck"
] as const;

export type InfrastructureMetricKey = (typeof INFRASTRUCTURE_METRIC_KEYS)[number];

export type InfrastructureMetric = {
  availability: MetricAvailability;
  value: number | null;
  unit: "percent" | "count" | "bytes" | "milliseconds" | "seconds" | "ratio";
  source: string;
  reason?: string;
};

export type InfrastructureRawSample = {
  collected_at: string;
  collection_latency_ms: number;
  metrics: Record<InfrastructureMetricKey, InfrastructureMetric>;
};

export type ThresholdRule = {
  warning: number;
  critical: number;
  window_minutes: number;
  minimum_ratio: number;
};

export type InfrastructureThresholds = Record<
  "database_cpu_percent" |
  "database_memory_percent" |
  "database_connection_percent" |
  "database_disk_percent" |
  "database_io_pressure_percent" |
  "database_query_latency_ms" |
  "api_p95_latency_ms" |
  "api_error_rate" |
  "queue_depth" |
  "oldest_queued_job_seconds" |
  "webhook_failure_rate" |
  "payment_error_rate",
  ThresholdRule
> & {
  dlq_critical_count: number;
  worker_heartbeat_critical_seconds: number;
  completion_window_stuck_critical_count: number;
  reconcile_jobs_stuck_critical_count: number;
  metrics_unavailable_window_minutes: number;
  stale_after_seconds: number;
};

const finiteEnv = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

function rule(prefix: string, warning: number, critical: number, windowMinutes: number): ThresholdRule {
  return {
    warning: finiteEnv(`INFRA_${prefix}_WARNING`, warning),
    critical: finiteEnv(`INFRA_${prefix}_CRITICAL`, critical),
    window_minutes: finiteEnv(`INFRA_${prefix}_WINDOW_MINUTES`, windowMinutes),
    minimum_ratio: finiteEnv("INFRA_THRESHOLD_MINIMUM_RATIO", 0.8)
  };
}

export function loadInfrastructureThresholds(): InfrastructureThresholds {
  return {
    database_cpu_percent: rule("DB_CPU_PERCENT", 75, 90, 10),
    database_memory_percent: rule("DB_MEMORY_PERCENT", 80, 92, 10),
    database_connection_percent: rule("DB_CONNECTION_PERCENT", 70, 85, 10),
    database_disk_percent: rule("DB_DISK_PERCENT", 80, 90, 15),
    database_io_pressure_percent: rule("DB_IO_PRESSURE_PERCENT", 15, 35, 10),
    database_query_latency_ms: rule("DB_QUERY_LATENCY_MS", 250, 750, 5),
    api_p95_latency_ms: rule("API_P95_LATENCY_MS", 500, 1200, 5),
    api_error_rate: rule("API_ERROR_RATE", 0.03, 0.1, 5),
    queue_depth: rule("QUEUE_DEPTH", 100, 500, 5),
    oldest_queued_job_seconds: rule("OLDEST_JOB_SECONDS", 120, 600, 5),
    webhook_failure_rate: rule("WEBHOOK_FAILURE_RATE", 0.05, 0.15, 15),
    payment_error_rate: rule("PAYMENT_ERROR_RATE", 0.05, 0.15, 15),
    dlq_critical_count: finiteEnv("INFRA_DLQ_CRITICAL_COUNT", 1),
    worker_heartbeat_critical_seconds: finiteEnv("INFRA_WORKER_HEARTBEAT_CRITICAL_SECONDS", 45),
    completion_window_stuck_critical_count: finiteEnv("INFRA_COMPLETION_STUCK_CRITICAL_COUNT", 1),
    reconcile_jobs_stuck_critical_count: finiteEnv("INFRA_RECONCILE_STUCK_CRITICAL_COUNT", 1),
    metrics_unavailable_window_minutes: finiteEnv("INFRA_METRICS_UNAVAILABLE_WINDOW_MINUTES", 15),
    stale_after_seconds: finiteEnv("INFRA_STALE_AFTER_SECONDS", 120)
  };
}

export function availableMetric(value: number | null | undefined, unit: InfrastructureMetric["unit"], source: string): InfrastructureMetric {
  return Number.isFinite(Number(value))
    ? { availability: "available", value: Number(value), unit, source }
    : unavailableMetric(unit, source, "source_returned_no_numeric_value");
}

export function unavailableMetric(unit: InfrastructureMetric["unit"], source: string, reason: string): InfrastructureMetric {
  return { availability: "unavailable", value: null, unit, source, reason };
}

export function emptyInfrastructureMetrics(): Record<InfrastructureMetricKey, InfrastructureMetric> {
  return Object.fromEntries(INFRASTRUCTURE_METRIC_KEYS.map((key) => [key, unavailableMetric(
    key.includes("percent") ? "percent" : key.includes("latency") ? "milliseconds" : key.includes("seconds") || key.includes("lag") ? "seconds" : key.includes("rate") ? "ratio" : key.includes("bytes") ? "bytes" : "count",
    "not_configured",
    "metric_source_not_configured"
  )])) as Record<InfrastructureMetricKey, InfrastructureMetric>;
}

export class InfrastructureHistoryStore {
  private samples: InfrastructureRawSample[] = [];
  constructor(private readonly retentionMs = 24 * 60 * 60_000) {}

  add(sample: InfrastructureRawSample) {
    const timestamp = Date.parse(sample.collected_at);
    this.samples.push(sample);
    const cutoff = timestamp - this.retentionMs;
    this.samples = this.samples.filter((item) => Date.parse(item.collected_at) >= cutoff).slice(-2_000);
  }

  all() {
    return [...this.samples];
  }

  reset() {
    this.samples = [];
  }
}

type Issue = {
  code: string;
  kind: InfrastructureIssueKind;
  severity: Exclude<InfrastructureStatus, "GREEN">;
  title_he: string;
  meaning_he: string;
  action_he: string;
  evidence: Record<string, number | string | null>;
};

const CAPACITY_LABELS: Partial<Record<InfrastructureMetricKey, [string, string]>> = {
  database_cpu_percent: ["עומס המעבד של מסד הנתונים גבוה לאורך זמן", "בדוק שאילתות איטיות; אם לא נמצא צוואר בקבוק אפליקטיבי, שקול הגדלת Compute."],
  database_memory_percent: ["השימוש בזיכרון של מסד הנתונים גבוה לאורך זמן", "בדוק שאילתות ו-cache; אם הלחץ נמשך, שקול הגדלת Compute."],
  database_connection_percent: ["מספר החיבורים מתקרב לקיבולת", "בדוק pooling וחיבורים שאינם נסגרים לפני הגדלת Compute."],
  database_disk_percent: ["נפח הדיסק מתקרב למגבלה", "בדוק גידול נתונים ומדיניות שמירה; הרחב דיסק רק לאחר אימות."],
  database_io_pressure_percent: ["לחץ הדיסק מתמשך", "בדוק שאילתות ו־I/O לפני שינוי Compute או דיסק."],
  database_query_latency_ms: ["זמן תגובת מסד הנתונים גבוה", "בדוק Slow Queries ואינדקסים לפני הגדלת Compute."]
};

const OPERATIONAL_LABELS: Partial<Record<InfrastructureMetricKey, [string, string]>> = {
  api_p95_latency_ms: ["זמן תגובת ה־API גבוה", "בדוק לוגים ותלויות לפני שינוי תשתית."],
  api_error_rate: ["שיעור שגיאות ה־API גבוה", "בדוק את השגיאות האחרונות ואת התלות שנכשלה."],
  queue_depth: ["הצטברות בתור העבודה", "טפל ב־Queue ובקצב ה־Workers; הגדלת DB אינה הפעולה הראשונה."],
  oldest_queued_job_seconds: ["עבודה ממתינה זמן רב בתור", "בדוק Worker תקוע או קצב עיבוד נמוך."],
  webhook_failure_rate: ["שיעור כשלי Webhook גבוה", "בדוק חתימות, זמינות ספק ו־reconcile; אין הצדקה אוטומטית לשדרוג DB."],
  payment_error_rate: ["שיעור כשלי הסליקה גבוה", "בדוק את ספק הסליקה ואת סיווג הכשלים; אין הצדקה לשדרוג DB."]
};

function sustainedSeverity(samples: InfrastructureRawSample[], key: InfrastructureMetricKey, threshold: ThresholdRule, nowMs: number) {
  const cutoff = nowMs - threshold.window_minutes * 60_000;
  const points = samples
    .filter((sample) => Date.parse(sample.collected_at) >= cutoff)
    .map((sample) => ({ at: Date.parse(sample.collected_at), metric: sample.metrics[key] }))
    .filter((point) => point.metric.availability === "available" && point.metric.value !== null);
  if (points.length < 2) return null;
  const span = points[points.length - 1]!.at - points[0]!.at;
  if (span < threshold.window_minutes * 60_000 * 0.7) return null;
  const values = points.map((point) => Number(point.metric.value));
  const criticalRatio = values.filter((value) => value >= threshold.critical).length / values.length;
  const warningRatio = values.filter((value) => value >= threshold.warning).length / values.length;
  if (criticalRatio >= threshold.minimum_ratio) return { severity: "RED" as const, average: values.reduce((a, b) => a + b, 0) / values.length, samples: values.length };
  if (warningRatio >= threshold.minimum_ratio) return { severity: "AMBER" as const, average: values.reduce((a, b) => a + b, 0) / values.length, samples: values.length };
  return null;
}

function issueForMetric(key: InfrastructureMetricKey, severity: "AMBER" | "RED", average: number, sampleCount: number): Issue {
  const capacity = CAPACITY_LABELS[key];
  const labels = capacity || OPERATIONAL_LABELS[key] || [key, "בדוק את המדד ואת מקור הנתונים."];
  return {
    code: `${key}_${severity.toLowerCase()}`,
    kind: capacity ? "capacity" : "operational_incident",
    severity,
    title_he: labels[0],
    meaning_he: severity === "RED" ? "החריגה מתמשכת ודורשת פעולה." : "החריגה מתמשכת ומומלץ להיערך.",
    action_he: labels[1],
    evidence: { average: Math.round(average * 100) / 100, samples: sampleCount }
  };
}

function immediateIssue(current: InfrastructureRawSample, key: InfrastructureMetricKey, threshold: number, title: string, action: string, condition?: (value: number) => boolean): Issue | null {
  const metric = current.metrics[key];
  if (metric.availability !== "available" || metric.value === null) return null;
  const active = condition ? condition(metric.value) : metric.value >= threshold;
  if (!active) return null;
  return {
    code: `${key}_critical`,
    kind: "operational_incident",
    severity: "RED",
    title_he: title,
    meaning_he: "זהו אירוע תפעולי, לא הוכחה למחסור ב־Compute של מסד הנתונים.",
    action_he: action,
    evidence: { current: metric.value }
  };
}

function windowSummary(samples: InfrastructureRawSample[], minutes: number, nowMs: number) {
  const selected = samples.filter((sample) => Date.parse(sample.collected_at) >= nowMs - minutes * 60_000);
  const metrics: Record<string, { average: number | null; maximum: number | null; available_samples: number }> = {};
  for (const key of INFRASTRUCTURE_METRIC_KEYS) {
    const values = selected.map((sample) => sample.metrics[key]).filter((metric) => metric.availability === "available" && metric.value !== null).map((metric) => Number(metric.value));
    metrics[key] = {
      average: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null,
      maximum: values.length ? Math.max(...values) : null,
      available_samples: values.length
    };
  }
  return { minutes, samples: selected.length, metrics };
}

export function evaluateInfrastructureHealth(
  history: InfrastructureRawSample[],
  thresholds = loadInfrastructureThresholds(),
  options: { now?: Date; current_compute_tier?: string | null } = {}
) {
  if (!history.length) throw new Error("infrastructure_history_empty");
  const current = history[history.length - 1]!;
  const now = options.now ?? new Date(current.collected_at);
  const nowMs = now.getTime();
  const issues: Issue[] = [];
  const sustainedKeys = Object.keys(thresholds).filter((key) => typeof (thresholds as any)[key] === "object") as InfrastructureMetricKey[];
  for (const key of sustainedKeys) {
    const result = sustainedSeverity(history, key, (thresholds as any)[key], nowMs);
    if (result) issues.push(issueForMetric(key, result.severity, result.average, result.samples));
  }

  const queueDepth = current.metrics.queue_depth.value || 0;
  const immediate = [
    immediateIssue(current, "dlq_size", thresholds.dlq_critical_count, "ה־DLQ אינו ריק", "בדוק את האירועים הכושלים. אין למחוק DLQ ואין לבצע replay עיוור."),
    immediateIssue(current, "worker_heartbeat_age_seconds", thresholds.worker_heartbeat_critical_seconds, "Worker איבד heartbeat", "בדוק את תהליך ה־Worker ואת ה־Queue לפני כל שינוי במסד הנתונים.", (value) => value >= thresholds.worker_heartbeat_critical_seconds && queueDepth > 0),
    immediateIssue(current, "completion_window_stuck", thresholds.completion_window_stuck_critical_count, "עסקאות תקועות בחלון ההשלמה", "בדוק את Jobs הקנוניים וה־reconcile; אין לשנות State ידנית."),
    immediateIssue(current, "reconcile_jobs_stuck", thresholds.reconcile_jobs_stuck_critical_count, "משימות reconcile תקועות", "בדוק Worker ו־provider status לפני retry אידמפוטנטי.")
  ].filter(Boolean) as Issue[];
  issues.push(...immediate);

  const coreAvailabilityKeys: InfrastructureMetricKey[] = ["database_cpu_percent", "database_memory_percent", "database_connections", "database_disk_percent"];
  const unavailableCutoff = nowMs - thresholds.metrics_unavailable_window_minutes * 60_000;
  const availabilityHistory = history.filter((sample) => Date.parse(sample.collected_at) >= unavailableCutoff);
  if (availabilityHistory.length >= 2 && Date.parse(availabilityHistory[availabilityHistory.length - 1]!.collected_at) - Date.parse(availabilityHistory[0]!.collected_at) >= thresholds.metrics_unavailable_window_minutes * 60_000 * 0.7) {
    const unavailable = coreAvailabilityKeys.filter((key) => availabilityHistory.every((sample) => sample.metrics[key].availability === "unavailable"));
    if (unavailable.length) issues.push({
      code: "infrastructure_metrics_unavailable",
      kind: "operational_incident",
      severity: "AMBER",
      title_he: "נתוני תשתית אינם זמינים לאורך זמן",
      meaning_he: "המערכת ממשיכה לפעול, אך לא ניתן להעריך את כל מדדי הקיבולת.",
      action_he: "בדוק את תצורת Metrics API ואת הרשאת המפתח הייעודי.",
      evidence: { unavailable_metrics: unavailable.join(",") }
    });
  }

  const status: InfrastructureStatus = issues.some((issue) => issue.severity === "RED") ? "RED" : issues.some((issue) => issue.severity === "AMBER") ? "AMBER" : "GREEN";
  const capacity = issues.filter((issue) => issue.kind === "capacity");
  const incident = issues.find((issue) => issue.kind === "operational_incident" && issue.severity === "RED")
    || issues.find((issue) => issue.kind === "operational_incident" && (issue.code !== "infrastructure_metrics_unavailable" || !capacity.length));
  const slowQueries = Number(current.metrics.database_slow_queries.value || 0);
  const upgradeSignals = capacity.filter((issue) => /database_(cpu|memory|connection|disk|io)/.test(issue.code));
  const nextTier: Record<string, string> = { nano: "micro", micro: "small", small: "medium", medium: "large", ci_nano: "ci_micro", ci_micro: "ci_small", ci_small: "ci_medium", ci_medium: "ci_large" };
  const currentTier = String(options.current_compute_tier || "").toLowerCase();
  let recommendation = {
    code: "no_action",
    problem_he: "לא זוהתה חריגה מתמשכת",
    meaning_he: "המערכת פועלת בטווח תקין לפי הנתונים הזמינים.",
    action_he: "אין צורך בפעולה.",
    urgency: "none" as "none" | "monitor" | "soon" | "immediate",
    recommend_compute_upgrade: false,
    current_compute_tier: options.current_compute_tier || null,
    recommended_compute_tier: null as string | null,
    estimated_cost: null as number | null,
    cost_note_he: "בדוק עלות ב-Supabase"
  };
  if (incident) {
    recommendation = { ...recommendation, code: incident.code, problem_he: incident.title_he, meaning_he: incident.meaning_he, action_he: incident.action_he, urgency: incident.severity === "RED" ? "immediate" : "soon" };
  } else if (slowQueries > 0 && capacity.some((issue) => issue.code.startsWith("database_query_latency"))) {
    recommendation = { ...recommendation, code: "optimize_slow_queries", problem_he: "מסד הנתונים איטי ונמצאו שאילתות איטיות", meaning_he: "שדרוג Compute עלול להסתיר צוואר בקבוק אפליקטיבי.", action_he: "בדוק Slow Queries ואינדקסים לפני שדרוג Compute.", urgency: status === "RED" ? "immediate" : "soon" };
  } else if (upgradeSignals.length >= 2) {
    recommendation = { ...recommendation, code: "consider_compute_upgrade", problem_he: "מספר סימני קיבולת של מסד הנתונים גבוהים לאורך זמן", meaning_he: "הנתונים מצביעים על saturation ולא על תקלה יחידה בתור או בספק חיצוני.", action_he: "לאחר בדיקת Slow Queries ו־pooling, מומלץ לשקול הגדלת Compute.", urgency: status === "RED" ? "immediate" : "soon", recommend_compute_upgrade: true, recommended_compute_tier: nextTier[currentTier] || null };
  } else if (capacity.length) {
    recommendation = { ...recommendation, code: "monitor_or_optimize", problem_he: capacity[0]!.title_he, meaning_he: "קיים סימן קיבולת מתמשך, אך אין עדיין מספיק ראיות להמלצת שדרוג.", action_he: capacity[0]!.action_he, urgency: "monitor" };
  }

  const evaluatedAgeSeconds = Math.max(0, (nowMs - Date.parse(current.collected_at)) / 1000);
  return {
    status,
    status_he: status === "GREEN" ? "תקין" : status === "AMBER" ? "מתקרבים למגבלה" : "נדרשת פעולה",
    evaluated_at: now.toISOString(),
    collected_at: current.collected_at,
    stale: evaluatedAgeSeconds > thresholds.stale_after_seconds,
    stale_after_seconds: thresholds.stale_after_seconds,
    summary_he: status === "GREEN" ? "אין צורך בפעולה" : status === "AMBER" ? "מומלץ לעקוב ולהיערך בהתאם להמלצה." : "נדרשת פעולה בהתאם להמלצה המוצגת.",
    issue_kind: incident ? "operational_incident" : capacity.length ? "capacity" : null,
    metrics: current.metrics,
    attention: issues,
    recommendation,
    history: {
      now: windowSummary(history, 1, nowMs),
      fifteen_minutes: windowSummary(history, 15, nowMs),
      one_hour: windowSummary(history, 60, nowMs),
      twenty_four_hours: windowSummary(history, 24 * 60, nowMs)
    }
  };
}

export function buildInfrastructureAlerts(previousStatus: InfrastructureStatus | null, evaluation: ReturnType<typeof evaluateInfrastructureHealth>) {
  const alerts = evaluation.attention
    .filter((item) => item.severity === "RED"
      || item.code === "infrastructure_metrics_unavailable"
      || (item.kind === "capacity" && item.severity === "AMBER"))
    .map((item) => ({ code: item.code, severity: item.severity, title_he: item.title_he, created_at: evaluation.evaluated_at }));
  if (evaluation.status === "RED" && previousStatus !== "RED") alerts.unshift({ code: "infrastructure_entered_red", severity: "RED" as const, title_he: "מצב התשתית עבר לנדרשת פעולה", created_at: evaluation.evaluated_at });
  return alerts;
}
