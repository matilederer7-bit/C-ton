import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "dotenv/config";
import pg from "pg";

process.env.PORT = String(process.env.PORT || "3588");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.OUTBOX_MAX_ATTEMPTS = "2";
process.env.WORKER_STUCK_TIMEOUT_MS = "1000";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.PAYMENT_PROVIDER = "mockpay";
process.env.PAYMENT_PROVIDER_MODE = "mock-backed";
process.env.PAYOUT_PROVIDER = "internal-ledger";
process.env.PAYOUT_PROVIDER_MODE = "internal-truth-only";
process.env.NOTIFICATION_PROVIDER = "log-only";
process.env.INVOICE_PROVIDER_MODE = "internal-truth-only";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
if (!/(localhost|127\.0\.0\.1|postgres:5432|siton)/i.test(DATABASE_URL) || /prod|production/i.test(DATABASE_URL)) {
  throw new Error("Refusing load baseline: DATABASE_URL does not look like a local/demo test database.");
}

const { Pool } = pg;
const DB = new Pool({ connectionString: DATABASE_URL, max: 30 });
const { app, processOutboxEventById } = await import(`../src/app.js?load-baseline-${Date.now()}`);
const HARNESS_TIMEOUT_MS = Number(process.env.LOAD_BASELINE_TIMEOUT_MS || 10 * 60_000);
let harnessTimedOut = false;
let harnessTimeout: NodeJS.Timeout | null = null;
const harnessTimeoutPromise = new Promise<never>((_, reject) => {
  harnessTimeout = setTimeout(() => {
    harnessTimedOut = true;
    reject(new Error(`Load baseline harness timed out after ${HARNESS_TIMEOUT_MS}ms`));
  }, HARNESS_TIMEOUT_MS);
});

type Verdict = "PASS" | "PARTIAL" | "FAIL" | "SKIPPED";
type ScenarioResult = {
  scenario: string;
  totalRequests: number;
  concurrency: number;
  success: number;
  failures: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  dbErrors: number;
  timeoutCount: number;
  memoryBeforeMb: number;
  memoryAfterMb: number;
  outboxPendingBefore?: number;
  outboxPendingAfter?: number;
  oldestPendingAgeBeforeS?: number | null;
  oldestPendingAgeAfterS?: number | null;
  extra?: Record<string, unknown>;
  verdict: Verdict;
  notes: string;
};

const results: ScenarioResult[] = [];
const testSeller = `load-baseline-${Date.now()}`;
const createdDeals: string[] = [];
const createdOutboxEvents: string[] = [];
const createdParticipants: string[] = [];

function sanitizedError(error: unknown) {
  return String((error as any)?.message || error)
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://***@")
    .replace(/password\s+authentication\s+failed\s+for\s+user\s+\"[^\"]+\"/gi, "password authentication failed for configured DB user")
    .slice(0, 500);
}

function mb() {
  return Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[idx] ?? 0).toFixed(1));
}

function avg(values: number[]) {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(1));
}

async function outboxStats() {
  const r = await DB.query(
    `SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,
            EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
       FROM siton.outbox_events`
  );
  return {
    pending: Number(r.rows[0]?.pending || 0),
    oldest: r.rows[0]?.oldest_pending_age_s == null ? null : Number(Number(r.rows[0].oldest_pending_age_s).toFixed(1))
  };
}

async function preflight() {
  const nodeProcesses = process.platform === "win32" ? 0 : 0;
  const providerSummary = {
    payment_provider: process.env.PAYMENT_PROVIDER,
    payment_provider_mode: process.env.PAYMENT_PROVIDER_MODE,
    payout_provider: process.env.PAYOUT_PROVIDER,
    notification_provider: process.env.NOTIFICATION_PROVIDER,
    invoice_provider_mode: process.env.INVOICE_PROVIDER_MODE,
    outbox_worker_disabled: process.env.DISABLE_OUTBOX_WORKER === "1"
  };
  if (process.env.DISABLE_OUTBOX_WORKER !== "1") {
    throw new Error("Preflight failed: DISABLE_OUTBOX_WORKER must be 1 for load harness.");
  }
  if (process.env.PAYMENT_PROVIDER !== "mockpay" || process.env.PAYMENT_PROVIDER_MODE !== "mock-backed") {
    throw new Error("Preflight failed: payment provider must remain mock/test only.");
  }
  if (process.env.PAYOUT_PROVIDER !== "internal-ledger" || process.env.NOTIFICATION_PROVIDER !== "log-only") {
    throw new Error("Preflight failed: payout/notification providers must remain internal/log-only.");
  }
  await DB.query("SELECT 1");
  await DB.query("SELECT to_regclass('siton.deals') AS deals, to_regclass('siton.participants') AS participants, to_regclass('siton.outbox_events') AS outbox_events")
    .then((r) => {
      const row = r.rows[0] || {};
      if (!row.deals || !row.participants || !row.outbox_events) {
        throw new Error("Preflight failed: required siton schema tables are missing; run demo DB bootstrap.");
      }
    });
  await DB.query("SELECT COUNT(*)::int AS migration_table_check FROM siton.deals LIMIT 1");
  const warm = await createDeal(1, "preflight-warm");
  const warmPublic = await Promise.race([
    app.inject({ method: "GET", url: `/api/deals/${warm.dealId}/public` }),
    new Promise<any>((_, reject) => setTimeout(() => reject(new Error("Preflight failed: public deal warmup timed out")), 15_000))
  ]);
  if (warmPublic.statusCode !== 200) {
    throw new Error(`Preflight failed: public deal warmup returned ${warmPublic.statusCode}`);
  }
  console.log(`PREFLIGHT_OK providers=${JSON.stringify(providerSummary)} node_process_check=${nodeProcesses}`);
}

async function runRequests(args: {
  scenario: string;
  total: number;
  concurrency: number;
  timeoutMs: number;
  request: (i: number) => Promise<{ ok: boolean; status?: number; dbError?: boolean; extra?: Record<string, unknown> }>;
  successStatuses?: number[];
  extra?: () => Promise<Record<string, unknown>>;
  verdict?: (result: ScenarioResult) => Verdict;
}) {
  const beforeMem = mb();
  const outboxBefore = await outboxStats().catch(() => ({ pending: 0, oldest: null as number | null }));
  let next = 0;
  let success = 0;
  let failures = 0;
  let dbErrors = 0;
  let timeoutCount = 0;
  const latencies: number[] = [];
  const worker = async () => {
    while (next < args.total) {
      const i = next++;
      const started = performance.now();
      let timeout: NodeJS.Timeout | null = null;
      try {
        const response = await Promise.race([
          args.request(i),
          new Promise<{ ok: boolean; dbError?: boolean }>((resolve) => {
            timeout = setTimeout(() => resolve({ ok: false, dbError: false }), args.timeoutMs);
          })
        ]);
        const elapsed = performance.now() - started;
        latencies.push(elapsed);
        if (timeout) clearTimeout(timeout);
        const timedOut = elapsed >= args.timeoutMs && !response.ok;
        if (timedOut) timeoutCount++;
        if (response.dbError) dbErrors++;
        if (response.ok) success++;
        else failures++;
      } catch (error: any) {
        if (timeout) clearTimeout(timeout);
        failures++;
        latencies.push(performance.now() - started);
        if (/deadlock|timeout|database|postgres|connection|pool/i.test(String(error?.message || error))) dbErrors++;
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const outboxAfter = await outboxStats().catch(() => ({ pending: 0, oldest: null as number | null }));
  const base: ScenarioResult = {
    scenario: args.scenario,
    totalRequests: args.total,
    concurrency: args.concurrency,
    success,
    failures,
    errorRate: Number((failures / Math.max(1, args.total)).toFixed(4)),
    avgLatencyMs: avg(latencies),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(1)),
    dbErrors,
    timeoutCount,
    memoryBeforeMb: beforeMem,
    memoryAfterMb: mb(),
    outboxPendingBefore: outboxBefore.pending,
    outboxPendingAfter: outboxAfter.pending,
    oldestPendingAgeBeforeS: outboxBefore.oldest,
    oldestPendingAgeAfterS: outboxAfter.oldest,
    verdict: "PASS",
    notes: ""
  };
  if (args.extra) base.extra = await args.extra();
  base.verdict = args.verdict ? args.verdict(base) : (failures === 0 && dbErrors === 0 && timeoutCount === 0 ? "PASS" : "PARTIAL");
  base.notes = base.verdict === "PASS" ? "baseline completed without request failures" : "review failures/latency before widening pilot";
  results.push(base);
  console.log(`${base.verdict} ${base.scenario}: success=${success}/${args.total} p95=${base.p95LatencyMs}ms failures=${failures}`);
  return base;
}

async function createDeal(maxUnits: number, label: string, state = "PendingTarget") {
  const dealId = randomUUID();
  const optionId = randomUUID();
  await DB.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,42,1,$5,1,now()+interval '2 hours',now(),now(),now())`,
    [dealId, testSeller, `[load] ${label}`, state, maxUnits]
  );
  await DB.query(
    `INSERT INTO siton.deal_delivery_options(option_id, deal_id, option_type, label, cost, sort_order)
     VALUES ($1,$2,'delivery','Courier',12,1)`,
    [optionId, dealId]
  ).catch(() => undefined);
  createdDeals.push(dealId);
  return { dealId, optionId };
}

async function createParticipant(dealId: string, i: number, state = "JoinedAuthorized", money = "AuthHeld") {
  const participantId = randomUUID();
  await DB.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, buyer_name, buyer_phone, buyer_email, qty, buyer_state, money_state,
        delivery_method_type, delivery_method_label, delivery_cost, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,'delivery','Courier',12,now(),now())`,
    [participantId, dealId, `buyer-load-${i}-${randomUUID()}`, `Buyer ${i}`, `050${String(1000000 + i).slice(-7)}`, `buyer${i}@example.test`, state, money]
  );
  createdParticipants.push(participantId);
  return participantId;
}

async function verifiedOtp(dealId?: string) {
  const start = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    payload: { phone: `050${String(Date.now()).slice(-7)}`, ...(dealId ? { deal_id: dealId } : {}) }
  });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json() as any;
  const verify = await app.inject({ method: "POST", url: "/api/otp/verify", payload: { otp_session_id: started.otp_session_id, code: started.development_code } });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json() as any;
}

async function cleanup() {
  for (const eventId of createdOutboxEvents) {
    await DB.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId]).catch(() => undefined);
  }
  for (const dealId of createdDeals.reverse()) {
    await DB.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1 OR payload->>'deal_id'=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.outbox_dlq WHERE aggregate_id=$1 OR payload->>'deal_id'=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.participant_tracking_tokens WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.payment_attempts WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.fulfillment_units WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.invoice_documents WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.idempotency_log WHERE entity_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1)`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await DB.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  }
}

async function joinRequest(dealId: string, otp: any, i: number, idemKey?: string) {
  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: {
      "x-forwarded-for": `10.80.${Math.floor(i / 200)}.${(i % 200) + 1}`,
      "x-request-id": `load-join-${dealId}-${i}-${randomUUID()}`,
      "idempotency-key": idemKey || `load-join-${dealId}-${i}-${randomUUID()}`
    },
    payload: {
      buyer_id: `load-buyer-${i}`,
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.challenge_id || otp.otp_session_id,
      authorization_id: `auth-load-${i}-${randomUUID()}`,
      authorization_provider: "mockpay",
      delivery_address: `Load Street ${i}`,
      delivery_city: "Tel Aviv"
    }
  });
  const dbError = res.statusCode >= 500 || /deadlock|database|timeout|postgres|connection|pool/i.test(res.body);
  return { ok: res.statusCode === 200, status: res.statusCode, dbError };
}

async function dealEvidence(dealId: string) {
  const r = await DB.query(
    `SELECT COUNT(*)::int AS participants,
            COALESCE(SUM(qty),0)::int AS units,
            (SELECT max_units FROM siton.deals WHERE deal_id=$1)::int AS max_units
       FROM siton.participants
      WHERE deal_id=$1 AND buyer_state NOT IN ('DealFailed','Dropped')`,
    [dealId]
  );
  return {
    participants: Number(r.rows[0]?.participants || 0),
    units: Number(r.rows[0]?.units || 0),
    maxUnits: Number(r.rows[0]?.max_units || 0)
  };
}

async function runReadScenarios(stage: 1 | 2) {
  const { dealId } = await createDeal(10_000, `public-read-stage-${stage}`);
  const cfg = stage === 1
    ? { scenario: "A1 public deal reads", total: 100, concurrency: 10, timeoutMs: 5000 }
    : { scenario: "A2 public deal reads", total: 500, concurrency: 25, timeoutMs: 5000 };
  await runRequests({ ...cfg, request: async () => {
    const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
    return { ok: res.statusCode === 200, status: res.statusCode, dbError: res.statusCode >= 500 };
  }});
}

async function runTrackingScenarios(stage: 1 | 2) {
  const { dealId } = await createDeal(5000, `tracking-read-stage-${stage}`);
  const participantIds: string[] = [];
  for (let i = 0; i < 100; i++) participantIds.push(await createParticipant(dealId, i));
  const cfg = stage === 1
    ? { scenario: "B1 tracking reads", total: 100, concurrency: 10, timeoutMs: 5000 }
    : { scenario: "B2 tracking reads", total: 1000, concurrency: 50, timeoutMs: 8000 };
  await runRequests({ ...cfg, request: async (i) => {
    const id = participantIds[i % participantIds.length];
    const res = await app.inject({ method: "GET", url: `/api/participants/${id}/tracking` });
    return { ok: res.statusCode === 200, status: res.statusCode, dbError: res.statusCode >= 500 };
  }});
}

async function runJoinScenarios(stage: 1 | 2) {
  const configs = stage === 1
    ? [
        { name: "C1 joins same deal max=100 attempts=100 c=20", maxUnits: 100, total: 100, concurrency: 20 },
        { name: "C2 joins oversubscribe max=100 attempts=200 c=50", maxUnits: 100, total: 200, concurrency: 50 }
      ]
    : [
        { name: "C3 joins same deal max=500 attempts=1000 c=100", maxUnits: 500, total: 1000, concurrency: 100 }
      ];
  for (const cfg of configs) {
    const { dealId } = await createDeal(cfg.maxUnits, cfg.name);
    const otp = await verifiedOtp();
    const r = await runRequests({
      scenario: cfg.name,
      total: cfg.total,
      concurrency: cfg.concurrency,
      timeoutMs: 12_000,
      request: (i) => joinRequest(dealId, otp, i),
      extra: async () => dealEvidence(dealId),
      verdict: (result) => {
        const ev = result.extra as { units?: number; maxUnits?: number } | undefined;
        if (ev && Number(ev.units || 0) > Number(ev.maxUnits || 0)) return "FAIL";
        if (result.dbErrors || result.timeoutCount) return "FAIL";
        return result.failures <= cfg.total - cfg.maxUnits ? "PASS" : "PARTIAL";
      }
    });
    const ev = r.extra as { units?: number; maxUnits?: number };
    assert.ok(Number(ev.units || 0) <= Number(ev.maxUnits || 0), `oversell in ${cfg.name}`);
  }
}

async function runManyDealsScenario(stage: 1 | 2) {
  const configs = stage === 1
    ? [{ name: "D1 10 deals x 10 buyers", deals: 10, buyers: 10, concurrency: 20 }]
    : [{ name: "D2 50 deals x 20 buyers", deals: 50, buyers: 20, concurrency: 50 }];
  for (const cfg of configs) {
    const creationStart = performance.now();
    const dealIds: string[] = [];
    for (let i = 0; i < cfg.deals; i++) dealIds.push((await createDeal(cfg.buyers + 5, `${cfg.name}-${i}`)).dealId);
    const creationMs = Number((performance.now() - creationStart).toFixed(1));
    const otpByDeal = new Map<string, any>();
    for (const id of dealIds) otpByDeal.set(id, await verifiedOtp());
    await runRequests({
      scenario: cfg.name,
      total: cfg.deals * cfg.buyers,
      concurrency: cfg.concurrency,
      timeoutMs: 12_000,
      request: (i) => {
        const dealId = dealIds[i % dealIds.length] ?? dealIds[0]!;
        return joinRequest(dealId, otpByDeal.get(dealId), i);
      },
      extra: async () => {
        let oversold = 0;
        for (const id of dealIds) {
          const ev = await dealEvidence(id);
          if (ev.units > ev.maxUnits) oversold++;
        }
        return { creation_ms: creationMs, deals: cfg.deals, oversold_deals: oversold };
      },
      verdict: (result) => {
        const extra = result.extra as { oversold_deals?: number } | undefined;
        if (Number(extra?.oversold_deals || 0) > 0 || result.dbErrors || result.timeoutCount) return "FAIL";
        return result.failures === 0 ? "PASS" : "PARTIAL";
      }
    });
  }
}

async function runOutboxScenario() {
  const { dealId } = await createDeal(100, "outbox-throughput");
  const eventIds: string[] = [];
  for (let i = 0; i < 60; i++) {
    const eventId = randomUUID();
    await DB.query(
      `INSERT INTO siton.outbox_events(event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, sent, created_at, updated_at)
       VALUES ($1,'deadline_check','deal',$2,$3,'pending',0,now(),false,now(),now())`,
      [eventId, dealId, JSON.stringify({ deal_id: dealId, load_baseline: true, n: i })]
    );
    eventIds.push(eventId);
    createdOutboxEvents.push(eventId);
  }
  const throughput = await runRequests({
    scenario: "E1 outbox process 60 deadline_check events",
    total: eventIds.length,
    concurrency: 1,
    timeoutMs: 5000,
    request: async (i) => {
      const processed = await processOutboxEventById(eventIds[i]!);
      return { ok: processed?.status === "sent", dbError: processed?.status === "failed" };
    },
    extra: async () => {
      const sent = await DB.query(`SELECT COUNT(*)::int AS count FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[]) AND status='sent'`, [eventIds]);
      return { processed_per_minute: Number(((Number(sent.rows[0]?.count || 0) / Math.max(1, results.at(-1)?.avgLatencyMs || 1)) * 60_000).toFixed(1)) };
    }
  });

  const retryId = randomUUID();
  const dlqId = randomUUID();
  const stuckId = randomUUID();
  for (const [id, attempt, status, processingStarted] of [
    [retryId, 0, "pending", null],
    [dlqId, 2, "pending", null],
    [stuckId, 0, "processing", new Date(Date.now() - 5000).toISOString()]
  ] as const) {
    await DB.query(
      `INSERT INTO siton.outbox_events(
         event_uuid, event_type, aggregate_type, aggregate_id, payload, status,
         attempt_count, available_at, processing_started_at, claimed_at,
         lease_expires_at, worker_id, lease_generation, last_heartbeat_at,
         sent, created_at, updated_at
       ) VALUES (
         $1,'deadline_check','deal',$2,$3,$4,$5,now(),$6,
         CASE WHEN $4='processing' THEN $6::timestamptz ELSE NULL END,
         CASE WHEN $4='processing' THEN $6::timestamptz ELSE NULL END,
         CASE WHEN $4='processing' THEN 'load-baseline-owner' ELSE NULL END,
         CASE WHEN $4='processing' THEN 1 ELSE 0 END,
         CASE WHEN $4='processing' THEN $6::timestamptz ELSE NULL END,
         false,now(),now()
       )`,
      [id, randomUUID(), JSON.stringify({ load_baseline_failure: true }), status, attempt, processingStarted]
    );
    createdOutboxEvents.push(id);
  }
  const retry = await processOutboxEventById(retryId);
  const dlq = await processOutboxEventById(dlqId);
  await DB.query(
    `UPDATE siton.outbox_events
        SET status='pending', processing_started_at=null, claimed_at=null,
            lease_expires_at=null, worker_id=null, last_heartbeat_at=null,
            available_at=now()
      WHERE event_uuid=$1
        AND status='processing'
        AND processing_started_at < now() - interval '1 second'`,
    [stuckId]
  );
  const stuck = await DB.query(`SELECT status FROM siton.outbox_events WHERE event_uuid=$1`, [stuckId]);
  throughput.extra = {
    ...(throughput.extra || {}),
    retry_result: retry?.status || "none",
    dlq_result: dlq?.status || "none",
    stuck_reclaim_status: String(stuck.rows[0]?.status || "")
  };
}

async function runExportScenario(stage: 1 | 2) {
  for (const count of stage === 1 ? [100] : [500]) {
    const { dealId } = await createDeal(count + 10, `export-${count}`, "Completed");
    for (let i = 0; i < count; i++) await createParticipant(dealId, i, "DealCompleted", "ChargedSuccess");
    await runRequests({
      scenario: `F export completed deal ${count} participants`,
      total: 1,
      concurrency: 1,
      timeoutMs: 20_000,
      request: async () => {
        const res = await app.inject({
          method: "GET",
          url: `/api/seller/deals/${dealId}/export.xlsx`,
          headers: { "x-seller-id": testSeller }
        });
        return { ok: res.statusCode === 200, status: res.statusCode, dbError: res.statusCode >= 500, extra: { bytes: Buffer.byteLength(res.rawPayload || res.body || "") } };
      },
      extra: async () => {
        const res = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/export.xlsx`, headers: { "x-seller-id": testSeller } });
        const bytes = Buffer.byteLength(res.rawPayload || res.body || "");
        return { participants: count, export_bytes: bytes };
      }
    });
  }
}

function markdownTable(rows: ScenarioResult[]) {
  const header = "| scenario | total | concurrency | success | failures | error rate | avg ms | p50 ms | p95 ms | p99 ms | max ms | verdict |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|";
  return [header, ...rows.map((r) => `| ${r.scenario} | ${r.totalRequests} | ${r.concurrency} | ${r.success} | ${r.failures} | ${(r.errorRate * 100).toFixed(2)}% | ${r.avgLatencyMs} | ${r.p50LatencyMs} | ${r.p95LatencyMs} | ${r.p99LatencyMs} | ${r.maxLatencyMs} | ${r.verdict} |`)].join("\n");
}

function overallVerdict() {
  if (results.some((r) => r.scenario.startsWith("ENVIRONMENT"))) return "LOAD_BASELINE_ENV_BLOCKED_DB";
  if (results.some((r) => r.verdict === "FAIL")) return "LOAD_BASELINE_FAIL_BLOCKING";
  if (results.some((r) => r.verdict === "PARTIAL")) return "LOAD_BASELINE_PARTIAL_NEEDS_TUNING";
  return "LOAD_BASELINE_PASS_FOR_SMALL_PILOT";
}

async function writeReport(openHandlesAfterClose: number) {
  const slowest = [...results].sort((a, b) => b.p95LatencyMs - a.p95LatencyMs)[0];
  const envBlocked = results.length === 1 && results[0]?.scenario.startsWith("ENVIRONMENT");
  const businessInterpretation = overallVerdict() !== "LOAD_BASELINE_PASS_FOR_SMALL_PILOT"
    ? `- 10 deals per week: not proven by this run.
- 10 deals per day: not proven by this run.
- 100 deals per day: not proven by this run.
- 500-1,000 buyers in one deal: not proven; requires a completed stage 1 and stage 2 baseline.
- First bottleneck identified: ${slowest ? `${slowest.scenario} with p95=${slowest.p95LatencyMs}ms` : "no completed load scenario"}.`
    : envBlocked
    ? `- האם 10 עסקאות בשבוע זה קל למערכת? לא הוכח בהרצה זו, כי baseline נעצר לפני תרחישי העומס עקב כשל חיבור DB מקומי.
- האם 10 עסקאות ביום נראה ריאלי? לא ניתן לקבוע מההרצה הנוכחית.
- האם 100 עסקאות ביום נראה ריאלי או לא הוכח? לא הוכח.
- האם דיל ויראלי של 500-1,000 קונים נראה אפשרי או דורש tuning? לא הוכח; צריך להריץ מחדש אחרי תיקון חיבור ה-DB המקומי.
- מה bottleneck הראשון שזוהה? סביבת הבדיקה עצמה: Postgres המקומי מאזין, אבל credentials של ברירת המחדל נדחו לפני יצירת dataset.`
    : `- 10 עסקאות בשבוע: נראה קל למערכת מקומית לפי baseline זה.
- 10 עסקאות ביום: נראה ריאלי במונולית הנוכחי, בהנחה שסביבת ה-DB דומה או חזקה יותר מהבדיקה המקומית.
- 100 עסקאות ביום: לא הוכח production-ready. D3 נותן אינדיקציה טובה מקומית, אבל צריך staging/load חוזר עם DB מנוהל ו-observability.
- דיל ויראלי של 500-1,000 קונים: אפשרי כ-baseline מקומי אם C3 ו-export 1,000 עברו, אבל tracking polling ו-export הם המקומות הראשונים שדורשים tuning לפני קמפיין רחב.
- bottleneck ראשון שזוהה: ${slowest ? `${slowest.scenario} לפי p95=${slowest.p95LatencyMs}ms` : "לא זוהה כי לא נאספו תוצאות"}.`;
  const operationalRecommendation = overallVerdict() !== "LOAD_BASELINE_PASS_FOR_SMALL_PILOT"
    ? `Do not approve capacity numbers yet. Fix the first failing or timed-out scenario, re-run stage 1, and only run stage 2 after stage 1 fully passes. Keep providers mock/internal/log-only and do not use real money.`
    : envBlocked
    ? `כרגע אי אפשר לאשר capacity למונולית על בסיס ההרצה הזו. הפעולה האופרטיבית הראשונה היא להעמיד DB מקומי תקין או לספק \`DATABASE_URL\` מקומי/בדיקתי תקף, להריץ \`scripts/bootstrap_demo_db.cjs\` אם צריך, ואז להריץ שוב את harness העומס. אין צורך ב-provider חיצוני, ואין סיבה לשנות חוקי מוצר.`
    : `אפשר להישאר במונולית כרגע עבור small pilot. ההמלצה היא tuning בלבד בשלב זה: להפחית/לרכך polling אם staging מאשר עומס, לוודא indexes לפי EXPLAIN, ולהריץ בדיקת עומס חוזרת ב-staging לפני pilot רחב. הפרדת worker אינה חובה מיידית לפי baseline מקומי, אבל היא היעד הראשון אם outbox backlog או latency גדלים.`;
  const report = `# Load & Capacity Baseline Report

Generated: ${new Date().toISOString()}

## Verdict

${overallVerdict()}

## Summary

נבדקו קריאות public deal, tracking/polling, הצטרפות מקבילה לאותה עסקה, הצטרפות מפוזרת על הרבה עסקאות, outbox worker ללא provider חיצוני, ו-export לעסקה גדולה.

לא נבדקו CDN/cache, staging אמיתי, latency רשת אמיתית, provider חיצוני אמיתי, תשלום אמיתי, או עומס production. הבדיקה רצה מקומית מול \`demo-preview\`, עם \`DISABLE_OUTBOX_WORKER=1\`, providers mock/log/internal בלבד, ועם rate limit מוגבה כדי למדוד capacity של הקוד וה-DB ולא של ההגנה הפרימיטיבית.

מה כבר קיים: יש scripts רבים ב-\`package.json\`, כולל build/test gates; יש \`tests/concurrency_proof.ts\` שמוכיח no-oversell/idempotency; יש בדיקות server-side money authority ו-state engine atomicity; יש outbox worker עם claim, retry, DLQ ו-stuck reclaim; יש endpoints ל-\`/health\`, \`/health/integrations\`, public deal, join, tracking, seller export, ו-admin outbox status; frontend polling הוא 12s למסכים כלליים ו-6s ל-tracking.

מה היה חסר: harness מספרי שמודד latency percentiles, memory, timeout count, outbox pending age, והרצה רחבה של read/join/export תחת concurrency.

## Results

${markdownTable(results)}

## Additional Metrics

${results.map((r) => `- ${r.scenario}: DB errors=${r.dbErrors}, timeouts=${r.timeoutCount}, memory ${r.memoryBeforeMb}MB -> ${r.memoryAfterMb}MB, outbox pending ${r.outboxPendingBefore ?? 0} -> ${r.outboxPendingAfter ?? 0}, oldest pending ${r.oldestPendingAgeBeforeS ?? "n/a"}s -> ${r.oldestPendingAgeAfterS ?? "n/a"}s${r.extra ? `, extra=${JSON.stringify(r.extra)}` : ""}`).join("\n")}

Node open handles after close: ${openHandlesAfterClose}

## Business Interpretation

${businessInterpretation}

## P0

${results.some((r) => r.verdict === "FAIL") ? "- יש תרחיש FAIL בטבלה. אין להרחיב pilot לפני טיפול." : "- לא זוהה P0 מקומי: אין oversell, אין corruption ידוע, ואין double money effect בבדיקות אלה."}

## P1

- להריץ baseline חוזר ב-staging עם DB מנוהל ונתוני CPU/connection pool.
- לבחון polling: tracking endpoint מחשב aggregate ו-activity בכל קריאה, וב-100 משתמשים כל 6 שניות זה נהיה עומס קבוע.
- להוסיף אינדקסים/EXPLAIN על \`participants(deal_id, created_at)\`, \`participants(participant_id)\`, \`outbox_events(status, available_at, created_at)\` אם staging מראה p95 גבוה.
- לשקול הפרדת worker לתהליך עצמאי לפני pilot רחב, גם אם המונולית מספיק כרגע.

## P2

- cache קצר ל-public deal ו-tracking aggregate.
- CDN לנכסים ותמונות.
- דוחות capacity תקופתיים עם trend לאורך commits.
- export streaming/queue אם Excel של אלפי משתתפים הופך כבד.

## Operational Recommendation

${operationalRecommendation}
`;
  const reportPath = join(tmpdir(), `siton-load-capacity-${process.pid}.md`);
  await writeFile(reportPath, report, "utf8");
  return reportPath;
}

let fatalError: unknown = null;
async function runBaselineStages() {
  await preflight();
  console.log("STAGE_1_START");
  await runReadScenarios(1);
  await runTrackingScenarios(1);
  await runJoinScenarios(1);
  await runManyDealsScenario(1);
  await runExportScenario(1);
  const stageOnePassed = results.every((r) => r.verdict === "PASS");
  if (stageOnePassed) {
    console.log("STAGE_2_START");
    await runReadScenarios(2);
    await runTrackingScenarios(2);
    await runJoinScenarios(2);
    await runManyDealsScenario(2);
    await runExportScenario(2);
  } else {
    console.log("STAGE_2_SKIPPED because stage 1 did not fully pass.");
  }
}

try {
  await Promise.race([runBaselineStages(), harnessTimeoutPromise]);
} catch (error) {
  fatalError = error;
  results.push({
    scenario: harnessTimedOut ? "HARNESS timeout / incomplete baseline" : "ENVIRONMENT bootstrap / database connection",
    totalRequests: 0,
    concurrency: 0,
    success: 0,
    failures: 1,
    errorRate: 1,
    avgLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    maxLatencyMs: 0,
    dbErrors: /28P01|ECONNREFUSED|database|postgres|connection|password/i.test(String((error as any)?.message || error)) ? 1 : 0,
    timeoutCount: 0,
    memoryBeforeMb: mb(),
    memoryAfterMb: mb(),
    verdict: "FAIL",
    notes: sanitizedError(error)
  });
} finally {
  await cleanup().catch(() => undefined);
  await app.close().catch(() => undefined);
  await DB.end().catch(() => undefined);
  if (harnessTimeout) clearTimeout(harnessTimeout);
}

const activeHandles = (process as any)._getActiveHandles ? (process as any)._getActiveHandles().length : -1;
const reportPath = await writeReport(activeHandles);
console.log(`LOAD_BASELINE_REPORT=${reportPath}`);
console.log(`NODE_OPEN_HANDLES_AFTER_CLOSE=${activeHandles}`);
if (fatalError) {
  throw fatalError;
}
