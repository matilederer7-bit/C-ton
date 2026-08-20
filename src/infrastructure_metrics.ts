import {
  InfrastructureHistoryStore,
  availableMetric,
  buildInfrastructureAlerts,
  emptyInfrastructureMetrics,
  evaluateInfrastructureHealth,
  loadInfrastructureThresholds,
  unavailableMetric,
  type InfrastructureRawSample,
  type InfrastructureStatus
} from "./infrastructure_health.js";

type RequestPoint = { at: number; duration_ms: number; failed: boolean };

export class ApplicationRequestTelemetry {
  private points: RequestPoint[] = [];
  start(req: any) {
    req.infrastructureTelemetryStartedAt = performance.now();
  }
  finish(req: any, statusCode: number) {
    const started = Number(req.infrastructureTelemetryStartedAt);
    if (!Number.isFinite(started)) return;
    this.points.push({ at: Date.now(), duration_ms: Math.max(0, performance.now() - started), failed: statusCode >= 500 });
    this.points = this.points.filter((point) => point.at >= Date.now() - 24 * 60 * 60_000).slice(-20_000);
  }
  summarize(windowMs = 5 * 60_000) {
    const selected = this.points.filter((point) => point.at >= Date.now() - windowMs);
    const sorted = selected.map((point) => point.duration_ms).sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
    return { count: selected.length, p95_latency_ms: p95, error_rate: selected.length ? selected.filter((point) => point.failed).length / selected.length : null };
  }
}

export const applicationRequestTelemetry = new ApplicationRequestTelemetry();

type PrometheusPoint = { name: string; labels: Record<string, string>; value: number };

function parsePrometheus(text: string): PrometheusPoint[] {
  const points: PrometheusPoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$/);
    if (!match) continue;
    const labels: Record<string, string> = {};
    for (const label of String(match[2] || "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g)) labels[label[1]!] = label[2]!.replace(/\\"/g, '"');
    const value = Number(match[3]);
    if (Number.isFinite(value)) points.push({ name: match[1]!, labels, value });
  }
  return points;
}

const sumMetric = (points: PrometheusPoint[], name: string, predicate: (point: PrometheusPoint) => boolean = () => true) => {
  const selected = points.filter((point) => point.name === name && predicate(point));
  return selected.length ? selected.reduce((sum, point) => sum + point.value, 0) : null;
};

type PrometheusSnapshot = { at: number; cpu: Map<string, { idle: number; iowait: number; total: number }> };

function prometheusValues(points: PrometheusPoint[], previous: PrometheusSnapshot | null, now: number) {
  const cpu = new Map<string, { idle: number; iowait: number; total: number }>();
  for (const point of points.filter((item) => item.name === "node_cpu_seconds_total" && (!item.labels.service_type || item.labels.service_type === "db"))) {
    const key = point.labels.cpu || "all";
    const current = cpu.get(key) || { idle: 0, iowait: 0, total: 0 };
    current.total += point.value;
    if (point.labels.mode === "idle") current.idle += point.value;
    if (point.labels.mode === "iowait") current.iowait += point.value;
    cpu.set(key, current);
  }
  let cpuPercent: number | null = null;
  let ioPressurePercent: number | null = null;
  if (previous && now > previous.at && cpu.size) {
    let deltaTotal = 0;
    let deltaIdle = 0;
    let deltaIowait = 0;
    for (const [key, current] of cpu) {
      const prior = previous.cpu.get(key);
      if (!prior) continue;
      deltaTotal += Math.max(0, current.total - prior.total);
      deltaIdle += Math.max(0, current.idle - prior.idle);
      deltaIowait += Math.max(0, current.iowait - prior.iowait);
    }
    if (deltaTotal > 0) {
      cpuPercent = Math.max(0, Math.min(100, (1 - deltaIdle / deltaTotal) * 100));
      ioPressurePercent = Math.max(0, Math.min(100, (deltaIowait / deltaTotal) * 100));
    }
  }
  const totalMemory = sumMetric(points, "node_memory_MemTotal_bytes", (point) => !point.labels.service_type || point.labels.service_type === "db");
  const availableMemory = sumMetric(points, "node_memory_MemAvailable_bytes", (point) => !point.labels.service_type || point.labels.service_type === "db");
  const memoryPercent = totalMemory && availableMemory !== null ? Math.max(0, Math.min(100, (1 - availableMemory / totalMemory) * 100)) : null;
  const fsSize = sumMetric(points, "node_filesystem_size_bytes", (point) => !point.labels.service_type || point.labels.service_type === "db");
  const fsAvail = sumMetric(points, "node_filesystem_avail_bytes", (point) => !point.labels.service_type || point.labels.service_type === "db");
  const diskPercent = fsSize && fsAvail !== null ? Math.max(0, Math.min(100, (1 - fsAvail / fsSize) * 100)) : null;
  const poolUsed = sumMetric(points, "pgbouncer_used_clients");
  const poolMax = sumMetric(points, "pgbouncer_max_client_conn");
  return { cpuPercent, ioPressurePercent, memoryPercent, diskPercent, poolPercent: poolUsed !== null && poolMax ? poolUsed / poolMax * 100 : null, next: { at: now, cpu } };
}

type CollectorOptions = {
  withTx: <T>(fn: (c: any) => Promise<T>) => Promise<T>;
  requestTelemetry?: ApplicationRequestTelemetry;
  fetchImpl?: typeof fetch;
  getWorkerRunning?: () => boolean;
  now?: () => Date;
};

export class InfrastructureMetricsCollector {
  readonly history = new InfrastructureHistoryStore();
  private previousPrometheus: PrometheusSnapshot | null = null;
  private lastStatus: InfrastructureStatus | null = null;
  private lastSuccessfulMetricsFetch: string | null = null;
  private lastFailedMetricsFetch: string | null = null;
  private lastFailureReason: string | null = null;
  private lastPrometheusFetchAt = 0;
  private lastPrometheusResult: any = null;
  private inFlight: Promise<any> | null = null;

  constructor(private readonly options: CollectorOptions) {}

  async snapshot(extra: { current_compute_tier?: string | null; compute_management?: Record<string, unknown> } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.buildSnapshot(extra).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async fetchSupabaseMetrics() {
    const projectRef = String(process.env.SUPABASE_PROJECT_REF || "").trim();
    const secret = String(process.env.SUPABASE_METRICS_SECRET_KEY || "").trim();
    if (!projectRef || !secret) return { configured: false, reason: !projectRef ? "SUPABASE_PROJECT_REF_missing" : "SUPABASE_METRICS_SECRET_KEY_missing", values: null as any };
    if (this.lastPrometheusResult && Date.now() - this.lastPrometheusFetchAt < 60_000) return this.lastPrometheusResult;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.SUPABASE_METRICS_TIMEOUT_MS || 5000));
    try {
      const response = await (this.options.fetchImpl || fetch)(`https://${encodeURIComponent(projectRef)}.supabase.co/customer/v1/privileged/metrics`, {
        headers: { authorization: `Basic ${Buffer.from(`siton-monitor:${secret}`).toString("base64")}` },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`supabase_metrics_http_${response.status}`);
      const points = parsePrometheus(await response.text());
      const now = Date.now();
      const values = prometheusValues(points, this.previousPrometheus, now);
      this.previousPrometheus = values.next;
      const result = { configured: true, reason: null, values };
      this.lastPrometheusFetchAt = now;
      this.lastPrometheusResult = result;
      return result;
    } catch (error) {
      const result = { configured: true, reason: String((error as Error)?.message || "supabase_metrics_fetch_failed").slice(0, 160), values: null as any };
      this.lastPrometheusFetchAt = Date.now();
      this.lastPrometheusResult = result;
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async buildSnapshot(extra: { current_compute_tier?: string | null; compute_management?: Record<string, unknown> }) {
    const started = performance.now();
    const collectedAt = (this.options.now?.() || new Date()).toISOString();
    const metrics = emptyInfrastructureMetrics();
    const externalPromise = this.fetchSupabaseMetrics();
    let databaseFailure: string | null = null;
    try {
      const dbStarted = performance.now();
      const row = await this.options.withTx(async (c) => {
        const result = await c.query(`SELECT
          (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS database_connections,
          current_setting('max_connections')::int AS database_max_connections,
          pg_database_size(current_database())::bigint AS database_size_bytes,
          (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status IN ('pending','processing')) AS queue_depth,
          EXTRACT(EPOCH FROM (now() - (SELECT MIN(available_at) FROM siton.outbox_events WHERE status='pending'))) AS oldest_queued_job_seconds,
          (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_size,
          (SELECT EXTRACT(EPOCH FROM (now() - MAX(heartbeat_at))) FROM siton.worker_heartbeats) AS worker_heartbeat_age_seconds,
          (SELECT COUNT(*)::int FROM siton.worker_heartbeats WHERE heartbeat_at > now() - interval '45 seconds' AND status='ready') AS fresh_workers,
          (SELECT COUNT(*)::int FROM siton.webhook_events WHERE received_at >= now() - interval '15 minutes') AS webhooks_total,
          (SELECT COUNT(*)::int FROM siton.webhook_events WHERE received_at >= now() - interval '15 minutes' AND status='failed') AS webhooks_failed,
          (SELECT COUNT(*)::int FROM siton.payment_attempts WHERE created_at >= now() - interval '15 minutes') AS payments_total,
          (SELECT COUNT(*)::int FROM siton.payment_attempts WHERE created_at >= now() - interval '15 minutes' AND result_class IN ('temporary_fail','permanent_fail','unknown')) AS payments_failed,
          (SELECT COUNT(*)::int FROM siton.deals WHERE state='CompletionWindow' AND completion_window_until < now()) AS completion_window_stuck,
          (SELECT COUNT(*)::int FROM siton.outbox_events WHERE event_type IN ('invoice_document_reconcile','seller_payout_reconcile') AND status IN ('pending','processing') AND created_at < now() - interval '15 minutes') AS reconcile_jobs_stuck`);
        let slowQueries: number | null = null;
        try {
          await c.query("SAVEPOINT infrastructure_slow_queries");
          const extension = await c.query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements') AS enabled`);
          if (extension.rows[0]?.enabled) {
            const slow = await c.query(`SELECT COUNT(*)::int AS count FROM pg_stat_statements WHERE calls >= 5 AND mean_exec_time >= $1`, [loadInfrastructureThresholds().database_query_latency_ms.warning]);
            slowQueries = Number(slow.rows[0]?.count || 0);
          }
          await c.query("RELEASE SAVEPOINT infrastructure_slow_queries");
        } catch {
          await c.query("ROLLBACK TO SAVEPOINT infrastructure_slow_queries").catch(() => undefined);
          await c.query("RELEASE SAVEPOINT infrastructure_slow_queries").catch(() => undefined);
          slowQueries = null;
        }
        return { ...(result.rows[0] || {}), slow_queries: slowQueries };
      });
      const dbLatency = performance.now() - dbStarted;
      const connections = Number(row.database_connections);
      const maxConnections = Number(row.database_max_connections);
      metrics.database_connections = availableMetric(connections, "count", "postgres.pg_stat_activity");
      metrics.database_max_connections = availableMetric(maxConnections, "count", "postgres.settings");
      metrics.database_connection_percent = availableMetric(maxConnections > 0 ? connections / maxConnections * 100 : null, "percent", "postgres.pg_stat_activity");
      metrics.database_size_bytes = availableMetric(Number(row.database_size_bytes), "bytes", "postgres.pg_database_size");
      metrics.database_query_latency_ms = availableMetric(dbLatency, "milliseconds", "application.db_round_trip");
      metrics.database_slow_queries = row.slow_queries == null
        ? unavailableMetric("count", "postgres.pg_stat_statements", "pg_stat_statements_unavailable_or_not_permitted")
        : availableMetric(Number(row.slow_queries), "count", "postgres.pg_stat_statements");
      metrics.queue_depth = availableMetric(Number(row.queue_depth), "count", "siton.outbox_events");
      metrics.oldest_queued_job_seconds = availableMetric(row.oldest_queued_job_seconds == null ? 0 : Number(row.oldest_queued_job_seconds), "seconds", "siton.outbox_events");
      metrics.worker_heartbeat_age_seconds = row.worker_heartbeat_age_seconds == null
        ? (this.options.getWorkerRunning?.() ? availableMetric(0, "seconds", "application.worker") : unavailableMetric("seconds", "siton.worker_heartbeats", "no_worker_heartbeat_recorded"))
        : availableMetric(Number(row.worker_heartbeat_age_seconds), "seconds", "siton.worker_heartbeats");
      metrics.worker_lag_seconds = metrics.oldest_queued_job_seconds;
      metrics.dlq_size = availableMetric(Number(row.dlq_size), "count", "siton.outbox_dlq");
      const webhooksTotal = Number(row.webhooks_total || 0);
      metrics.webhook_failure_rate = webhooksTotal
        ? availableMetric(Number(row.webhooks_failed || 0) / webhooksTotal, "ratio", "siton.webhook_events")
        : unavailableMetric("ratio", "siton.webhook_events", "no_webhook_requests_in_window");
      const paymentsTotal = Number(row.payments_total || 0);
      metrics.payment_error_rate = paymentsTotal
        ? availableMetric(Number(row.payments_failed || 0) / paymentsTotal, "ratio", "siton.payment_attempts")
        : unavailableMetric("ratio", "siton.payment_attempts", "no_payment_attempts_in_window");
      metrics.payment_provider_latency_ms = unavailableMetric("milliseconds", "payment_provider", "provider_duration_not_persisted");
      metrics.completion_window_stuck = availableMetric(Number(row.completion_window_stuck), "count", "siton.deals");
      metrics.reconcile_jobs_stuck = availableMetric(Number(row.reconcile_jobs_stuck), "count", "siton.outbox_events");
    } catch (error) {
      databaseFailure = String((error as Error)?.message || "database_metrics_failed").slice(0, 160);
    }

    const api = (this.options.requestTelemetry || applicationRequestTelemetry).summarize();
    metrics.api_p95_latency_ms = api.p95_latency_ms === null ? unavailableMetric("milliseconds", "application.request_telemetry", "no_requests_in_window") : availableMetric(api.p95_latency_ms, "milliseconds", "application.request_telemetry");
    metrics.api_error_rate = api.error_rate === null ? unavailableMetric("ratio", "application.request_telemetry", "no_requests_in_window") : availableMetric(api.error_rate, "ratio", "application.request_telemetry");

    const external = await externalPromise;
    if (external.values) {
      metrics.database_cpu_percent = external.values.cpuPercent === null ? unavailableMetric("percent", "supabase.metrics_api", "requires_two_scrapes_for_rate") : availableMetric(external.values.cpuPercent, "percent", "supabase.metrics_api");
      metrics.database_memory_percent = availableMetric(external.values.memoryPercent, "percent", "supabase.metrics_api");
      metrics.database_disk_percent = availableMetric(external.values.diskPercent, "percent", "supabase.metrics_api");
      metrics.database_io_pressure_percent = external.values.ioPressurePercent === null ? unavailableMetric("percent", "supabase.metrics_api", "requires_two_scrapes_for_rate") : availableMetric(external.values.ioPressurePercent, "percent", "supabase.metrics_api");
      metrics.connection_pool_percent = availableMetric(external.values.poolPercent, "percent", "supabase.metrics_api");
    } else {
      for (const key of ["database_cpu_percent", "database_memory_percent", "database_disk_percent", "database_io_pressure_percent", "connection_pool_percent"] as const) {
        metrics[key] = unavailableMetric("percent", "supabase.metrics_api", external.reason || "metrics_api_unavailable");
      }
    }

    const collectionLatency = Math.round((performance.now() - started) * 10) / 10;
    const sample: InfrastructureRawSample = { collected_at: collectedAt, collection_latency_ms: collectionLatency, metrics };
    this.history.add(sample);
    const externalFailure = external.configured ? external.reason : null;
    if (!databaseFailure && !externalFailure) {
      this.lastSuccessfulMetricsFetch = collectedAt;
      this.lastFailureReason = null;
    } else {
      this.lastFailedMetricsFetch = collectedAt;
      this.lastFailureReason = databaseFailure || externalFailure;
      if (!databaseFailure) this.lastSuccessfulMetricsFetch = collectedAt;
    }
    const evaluation = evaluateInfrastructureHealth(this.history.all(), loadInfrastructureThresholds(), {
      now: new Date(collectedAt),
      ...(extra.current_compute_tier !== undefined ? { current_compute_tier: extra.current_compute_tier } : {})
    });
    const alerts = buildInfrastructureAlerts(this.lastStatus, evaluation);
    this.lastStatus = evaluation.status;
    return {
      ...evaluation,
      alerts,
      capacity: { current_compute_tier: extra.current_compute_tier || null, management: extra.compute_management || {} },
      observability: {
        last_successful_metrics_fetch: this.lastSuccessfulMetricsFetch,
        last_failed_metrics_fetch: this.lastFailedMetricsFetch,
        last_failure_reason: this.lastFailureReason,
        metrics_collection_latency_ms: collectionLatency,
        recommendation_evaluated_at: evaluation.evaluated_at,
        history_storage: "bounded_in_process_ring_buffer",
        retention_hours: 24
      },
      sources: {
        supabase_metrics_api: { configured: external.configured, available: !external.reason, reason: external.reason },
        postgres_internal: { available: !databaseFailure, reason: databaseFailure },
        application_request_telemetry: { available: api.count > 0, samples: api.count }
      }
    };
  }
}
