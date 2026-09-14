// BLACK-BOX HARNESS for the R9C production candidate.
//
// Boots the REAL application (handlers, worker code, migrations already
// applied by the test runner to a disposable database) against the black-box
// provider stub, seeds rows directly, drives outbox jobs through the real
// `processOutboxEventById`, and exposes ONLY externally durable facts:
// provider requests / effects (from the stub) and committed database state.
//
// There is no observer, no oracle and no reconstructed chronology: every
// scenario controls its own schedule (scripted answers, held responses, row
// locks, fault barriers) and asserts what it can see afterwards.

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";
import { startProviderStub, type ProviderStub } from "./provider_stub.js";

export type BlackBoxOptions = {
  tag: string;
  port: number;
  clientTimeoutMs?: number;
  /** provider settlement horizon the rails apply to status-inferred failures (default 1500 ms) */
  settlementHorizonMs?: number;
  workerLeaseMs?: number;
  outboxMaxAttempts?: number;
  /** the stub replays a repeated idempotency key instead of moving money twice (the provider-ready contract) */
  nativeIdempotency?: boolean;
  env?: Record<string, string>;
};

export type ParticipantSpec = {
  buyer_state: string;
  money_state: string;
  qty?: number;
  delivery_cost?: number;
  authorization?: string;
  binding?: boolean;
  priorAttempts?: Array<{
    attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund" | "release";
    result_class: "unknown" | "success" | "permanent_fail";
    correlation_id?: string;
    dispatch_state?: "recorded" | "responded";
    failure_evidence?: "dispatch_response" | "status_inference" | "provider_event" | "operator" | null;
    settlement_horizon_at?: Date | null;
    negative_finality_authoritative?: boolean | null;
    dispatched_at?: Date | null;
  }>;
};
export type DealSpec = { state: string; price_per_unit?: number; threshold_units?: number; min_units?: number; max_units?: number; completionWindowUntil?: Date | null; deadline?: Date; title?: string; participants: ParticipantSpec[] };
export type SeededParticipant = { participant_id: string; buyer_id: string; authorization: string; qty: number; delivery_cost: number; amount_minor: number };
export type SeededDeal = { deal_id: string; participants: SeededParticipant[]; price_per_unit: number };
export type DrainResult = { event_uuid: string; event_type: string; status: string; error?: string | null };
export type DrainStats = { rounds: number; processed: number; advanced: number; waited: number; results: DrainResult[]; remaining_pending: number; remaining_processing: number };

const WEBHOOK_SECRET = "blackbox-webhook-secret";
const minor = (ils: number) => Math.round(ils * 100);
export const grossMinor = (args: { qty: number; price_per_unit: number; delivery_cost: number }) => minor(args.qty * args.price_per_unit) + minor(args.delivery_cost);

export async function bootBlackBox(options: BlackBoxOptions) {
  const clientTimeoutMs = options.clientTimeoutMs ?? 4000;
  const provider = await startProviderStub({ clientTimeoutMs, nativeIdempotency: options.nativeIdempotency ?? false });

  process.env.NODE_ENV = "test";
  process.env.PORT = String(options.port);
  process.env.APP_DEPLOYMENT_MODE = "demo-preview";
  process.env.SELLER_SESSION_SECRET = `seller-session-secret-blackbox-${options.tag}`;
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || `admin-session-secret-blackbox-${options.tag}`;
  process.env.PAYMENT_PROVIDER = "payrail-http";
  process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
  process.env.RECOVERY_PREFLIGHT_CONFIRM_MS = process.env.RECOVERY_PREFLIGHT_CONFIRM_MS || "60";
  process.env.PAYMENT_SETTLEMENT_HORIZON_MS = String(options.settlementHorizonMs ?? 1500);
  process.env.PAYMENT_PROVIDER_API_KEY = `blackbox-provider-key-${options.tag}`;
  process.env.PAYMENT_PROVIDER_BASE_URL = provider.base;
  process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
  process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
  process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
  process.env.PAYMENT_PROVIDER_REFUND_PATH = "/refund";
  process.env.PAYMENT_PROVIDER_RELEASE_PATH = "/release";
  process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
  process.env.PAYMENT_PROVIDER_TIMEOUT_MS = String(clientTimeoutMs);
  process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
  process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.OUTBOX_POLL_MS = "60000";
  process.env.DISABLE_OUTBOX_WORKER = "1";
  process.env.WORKER_LEASE_MS = String(options.workerLeaseMs ?? 30_000);
  process.env.OUTBOX_MAX_ATTEMPTS = String(options.outboxMaxAttempts ?? 4);
  process.env.RATE_LIMIT_MAX = "1000000";
  process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
  for (const [k, v] of Object.entries(options.env || {})) process.env[k] = v;

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  assert.match(String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""), /^siton_test_/, "black-box scenarios run only in a disposable isolated test database");

  const appModule: any = await import(`../../src/app.js?blackbox-${options.tag}-${Date.now()}`);
  const { app, reclaimWorkerJobs, closeWorkerDatabase } = appModule;
  const processOutboxEventById = (eventId: string): Promise<any> => appModule.processOutboxEventById(eventId);
  const faults: any = await import("../../src/fault_injection.js");
  const dbModule: any = await import("../../src/db.js");
  await app.ready();

  // ── seeding (rows only; the join happened "earlier" with a live provider authorization) ──
  async function seedDeal(spec: DealSpec): Promise<SeededDeal> {
    const dealId = randomUUID();
    const price = spec.price_per_unit ?? 42;
    await pool.query(
      `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
       VALUES ($1,'seller-blackbox',$2,$3,$4,$5,$6,$7,$8,now(),$9)`,
      [dealId, spec.state, spec.title || `Black box ${options.tag} ${dealId.slice(0, 8)}`, price, spec.min_units ?? 1, spec.max_units ?? 500, spec.threshold_units ?? 1,
        (spec.deadline || new Date(Date.now() + 30 * 60_000)).toISOString(), spec.completionWindowUntil ? spec.completionWindowUntil.toISOString() : null]
    );
    const participants: SeededParticipant[] = [];
    for (const p of spec.participants) {
      const participantId = randomUUID();
      const buyerId = `buyer-bb-${participantId.slice(0, 8)}`;
      const authorization = p.authorization || `auth-${randomUUID().slice(0, 12)}`;
      const qty = p.qty ?? 1;
      const delivery = p.delivery_cost ?? 0;
      const amountMinor = grossMinor({ qty, price_per_unit: price, delivery_cost: delivery });
      await pool.query(
        `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [participantId, dealId, buyerId, qty, p.buyer_state, p.money_state, delivery]
      );
      await pool.query(
        `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
         VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
        [participantId, dealId, `bb-seed-${options.tag}`, `bb-seed:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: authorization, authorization_provider: "payrail-http" })]
      );
      if (p.binding !== false && amountMinor > 0) {
        await pool.query(
          `INSERT INTO siton.payment_authorization_bindings
             (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id, consumed_by_participant_id, consumed_at)
           VALUES ('payrail-http','provider-ready','test',$1,$1,$2,$3,$4,$5,'ILS',$6,'consumed',$7,$8,now())`,
          [authorization, dealId, buyerId, qty, amountMinor, delivery, `bb-auth:${authorization}`, participantId]
        );
      }
      for (const prior of p.priorAttempts || []) {
        await pool.query(
          `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, failure_evidence, settlement_horizon_at, negative_finality_authoritative, dispatched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [participantId, dealId, prior.attempt_type, prior.result_class, prior.correlation_id || `${prior.attempt_type}:bb-prior:n1:${participantId}`, prior.dispatch_state || "responded",
            prior.failure_evidence === undefined ? (prior.result_class === "permanent_fail" ? "dispatch_response" : null) : prior.failure_evidence,
            prior.settlement_horizon_at === undefined ? new Date(Date.now() - 1000).toISOString() : (prior.settlement_horizon_at ? prior.settlement_horizon_at.toISOString() : null),
            prior.negative_finality_authoritative === undefined ? true : prior.negative_finality_authoritative,
            prior.dispatched_at === undefined ? new Date(Date.now() - 60_000).toISOString() : (prior.dispatched_at ? prior.dispatched_at.toISOString() : null)]
        );
      }
      participants.push({ participant_id: participantId, buyer_id: buyerId, authorization, qty, delivery_cost: delivery, amount_minor: amountMinor });
    }
    return { deal_id: dealId, participants, price_per_unit: price };
  }

  // ── outbox ────────────────────────────────────────────────────────────────
  async function enqueue(eventType: string, aggregateType: "deal" | "participant", aggregateId: string, payload: Record<string, unknown>, opts: { availableAt?: Date } = {}) {
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',0,$6,clock_timestamp(),clock_timestamp())`,
      [eventId, eventType, aggregateType, aggregateId, JSON.stringify(payload), (opts.availableAt || new Date()).toISOString()]
    );
    return eventId;
  }
  const enqueueCharge = (dealId: string) => enqueue("charge_deal", "deal", dealId, { deal_id: dealId });
  const enqueueRecovery = (dealId: string) => enqueue("recovery_deal", "deal", dealId, { deal_id: dealId });
  const enqueueRefund = (dealId: string, reason = "blackbox") => enqueue("refund_issue", "deal", dealId, { deal_id: dealId, reason });
  const enqueueRelease = (participantId: string, dealId: string, reason = "blackbox") => enqueue("payment_release", "participant", participantId, { participant_id: participantId, deal_id: dealId, reason });
  const enqueueFinalize = (dealId: string) => enqueue("finalize_deal", "deal", dealId, { deal_id: dealId });

  async function retryNow(eventId: string) { await pool.query(`UPDATE siton.outbox_events SET available_at=clock_timestamp() WHERE event_uuid=$1 AND status='pending'`, [eventId]); }
  async function outboxRow(eventId: string) {
    const live = (await pool.query(`SELECT event_uuid, event_type, status, attempt_count, last_error, lease_generation, worker_id, (available_at > clock_timestamp()) AS deferred FROM siton.outbox_events WHERE event_uuid=$1`, [eventId])).rows[0];
    if (live) return live as { event_uuid: string; event_type: string; status: string; attempt_count: number; last_error: string | null; lease_generation: number; worker_id: string | null; deferred: boolean };
    return (await pool.query(`SELECT event_uuid, event_type, 'dlq'::text AS status, attempt_count, last_error, lease_generation, worker_id, false AS deferred FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId])).rows[0] as { event_uuid: string; event_type: string; status: string; attempt_count: number; last_error: string | null; lease_generation: number; worker_id: string | null; deferred: boolean } | undefined;
  }
  async function participantIdsOf(dealIds: string[]) {
    return (await pool.query(`SELECT participant_id FROM siton.participants WHERE deal_id = ANY($1::uuid[])`, [dealIds])).rows.map((r: any) => String(r.participant_id));
  }
  async function scopedEvents(dealIds: string[], participantIds: string[], where: string, types?: string[]) {
    const params: unknown[] = [dealIds, participantIds.length ? participantIds : ["00000000-0000-4000-8000-000000000000"]];
    let typeClause = "";
    if (types && types.length) { params.push(types); typeClause = ` AND event_type = ANY($3::text[])`; }
    return (await pool.query(
      `SELECT event_uuid, event_type, status, attempt_count, available_at FROM siton.outbox_events
       WHERE ((aggregate_type='deal' AND aggregate_id = ANY($1::uuid[])) OR (aggregate_type='participant' AND aggregate_id = ANY($2::uuid[])))
         AND ${where}${typeClause}
       ORDER BY created_at ASC, event_uuid ASC`, params)).rows as Array<{ event_uuid: string; event_type: string; status: string; attempt_count: number; available_at: string }>;
  }
  async function liveEvents(dealIds: string[], types?: string[]) {
    return scopedEvents(dealIds, await participantIdsOf(dealIds), `status IN ('pending','processing')`, types);
  }

  /**
   * What a worker does over time, made deterministic: reclaim dead leases, run
   * the maintenance sweepers, process every due job in scope one at a time,
   * honour short deferrals by waiting for them and compress long backoffs.
   */
  async function drain(opts: { dealIds: string[]; maxRounds?: number; advanceDeferred?: boolean; waitDeferredUpToMs?: number; types?: string[]; skip?: (event: { event_uuid: string; event_type: string }) => boolean; sweepers?: boolean }): Promise<DrainStats> {
    const stats: DrainStats = { rounds: 0, processed: 0, advanced: 0, waited: 0, results: [], remaining_pending: 0, remaining_processing: 0 };
    const maxRounds = opts.maxRounds ?? 40;
    const participantIds = await participantIdsOf(opts.dealIds);
    while (stats.rounds < maxRounds) {
      stats.rounds += 1;
      await reclaimWorkerJobs(0).catch(() => undefined);
      if (opts.sweepers !== false) {
        await appModule.reconcileOrphanedUnknownIdentities(50, 0).catch(() => 0);
        if (!(opts.skip && opts.skip({ event_uuid: "", event_type: "finalize_deal" }))) await appModule.rescheduleStalledFinalizations().catch(() => 0);
      }
      const due = (await scopedEvents(opts.dealIds, participantIds, `status='pending' AND available_at <= clock_timestamp()`, opts.types)).filter((e) => !(opts.skip && opts.skip(e)));
      if (due.length === 0) {
        const deferred = (await scopedEvents(opts.dealIds, participantIds, `status='pending' AND available_at > clock_timestamp()`, opts.types)).filter((e) => !(opts.skip && opts.skip(e)));
        const processing = await scopedEvents(opts.dealIds, participantIds, `status='processing'`, opts.types);
        if (deferred.length && opts.advanceDeferred !== false) {
          const soonestMs = Math.min(...deferred.map((e) => new Date(e.available_at).getTime())) - Date.now();
          const waitCap = opts.waitDeferredUpToMs ?? 3_000;
          if (soonestMs > 0 && soonestMs <= waitCap) { await sleep(soonestMs + 10); stats.waited += 1; continue; }
          await sleep(75);
          await pool.query(`UPDATE siton.outbox_events SET available_at=clock_timestamp() WHERE event_uuid = ANY($1::uuid[])`, [deferred.map((e) => e.event_uuid)]);
          stats.advanced += deferred.length;
          continue;
        }
        if (processing.length) {
          await pool.query(`UPDATE siton.outbox_events SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE event_uuid = ANY($1::uuid[]) AND status='processing'`, [processing.map((e) => e.event_uuid)]);
          continue;
        }
        break;
      }
      for (const event of due) {
        const processed = await processOutboxEventById(event.event_uuid);
        const result: DrainResult = processed
          ? { event_uuid: event.event_uuid, event_type: event.event_type, status: String(processed.status), error: (processed as any).error ?? null }
          : { event_uuid: event.event_uuid, event_type: event.event_type, status: "not_claimed", error: JSON.stringify(await outboxRow(event.event_uuid)) };
        stats.processed += 1;
        stats.results.push(result);
      }
    }
    const notSkipped = (e: { event_uuid: string; event_type: string }) => !(opts.skip && opts.skip(e));
    stats.remaining_pending = (await scopedEvents(opts.dealIds, participantIds, `status='pending'`, opts.types)).filter(notSkipped).length;
    stats.remaining_processing = (await scopedEvents(opts.dealIds, participantIds, `status='processing'`, opts.types)).filter(notSkipped).length;
    return stats;
  }

  // ── committed facts ────────────────────────────────────────────────────────
  async function participant(participantId: string) {
    return (await pool.query(`SELECT buyer_state, money_state, qty, delivery_cost FROM siton.participants WHERE participant_id=$1`, [participantId])).rows[0] as { buyer_state: string; money_state: string; qty: number; delivery_cost: string };
  }
  async function deal(dealId: string) {
    return (await pool.query(`SELECT state, completion_window_until FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0] as { state: string; completion_window_until: string | null };
  }
  async function attempts(participantId: string, attemptType?: string) {
    return (await pool.query(
      `SELECT attempt_type, correlation_id, result_class, dispatch_state, owner_event_uuid, owner_lease_generation, provider_reference, outcome_note,
              siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight,
              failure_evidence, settlement_horizon_at::text AS settlement_horizon_at, dispatched_at::text AS dispatched_at, negative_finality_authoritative
       FROM siton.payment_attempts WHERE participant_id=$1 AND ($2::text IS NULL OR attempt_type=$2) ORDER BY created_at ASC, correlation_id ASC`,
      [participantId, attemptType ?? null]
    )).rows as Array<{ attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; owner_event_uuid: string | null; owner_lease_generation: number | null; provider_reference: string | null; outcome_note: string | null; in_flight: boolean; failure_evidence: string | null; settlement_horizon_at: string | null; dispatched_at: string | null; negative_finality_authoritative: boolean | null }>;
  }
  async function ledger(participantId: string) {
    return (await pool.query(`SELECT logical_entry_type, platform_fee_amount, gross_amount, seller_net_amount FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at`, [participantId])).rows as Array<{ logical_entry_type: string; platform_fee_amount: string; gross_amount: string; seller_net_amount: string }>;
  }
  async function cases(needle: string) {
    return (await pool.query(`SELECT auto_key, subject, status FROM siton.operational_cases WHERE auto_key LIKE '%' || $1 || '%' ORDER BY created_at`, [needle])).rows as Array<{ auto_key: string; subject: string; status: string }>;
  }
  async function moneyAudits(participantId: string) {
    return (await pool.query(`SELECT state_type, from_state, to_state, action_name FROM siton.audit_log WHERE entity_type='participant' AND entity_id=$1 AND state_type IN ('money_state','buyer_state') ORDER BY created_at ASC, audit_id ASC`, [participantId])).rows as Array<{ state_type: string; from_state: string; to_state: string; action_name: string }>;
  }
  async function webhookEvent(eventId: string) {
    return (await pool.query(`SELECT status FROM siton.webhook_events WHERE event_id=$1`, [eventId])).rows[0] as { status: string } | undefined;
  }
  async function dlqRows(aggregateId: string, eventType?: string) {
    return (await pool.query(`SELECT event_uuid, event_type, last_error FROM siton.outbox_dlq WHERE aggregate_id=$1 AND ($2::text IS NULL OR event_type=$2) ORDER BY created_at`, [aggregateId, eventType ?? null])).rows as Array<{ event_uuid: string; event_type: string; last_error: string | null }>;
  }
  /** the whole observable state of one participant's money, for the record */
  async function snapshot(p: SeededParticipant, dealId: string) {
    const row = await participant(p.participant_id);
    const d = await deal(dealId);
    return {
      deal_state: d.state, buyer_state: row.buyer_state, money_state: row.money_state,
      attempts: (await attempts(p.participant_id)).map((a) => `${a.attempt_type}:${a.correlation_id.slice(0, 40)}:${a.result_class}/${a.dispatch_state}${a.dispatched_at ? "" : "/never-dispatched"}`),
      provider_effects: provider.effectsOf(p.authorization),
      provider_money_requests: provider.moneyRequestsOf(p.authorization).map((r) => `${r.op}:${r.key.slice(0, 40)}:${r.behavior}:${r.answered}`),
      cases: (await cases(p.participant_id)).map((c) => `${c.auto_key.split(":")[0]}:${c.status}`),
      ledger: (await ledger(p.participant_id)).map((l) => l.logical_entry_type)
    };
  }

  // ── provider callbacks (signed like a real provider would) ────────────────
  async function postWebhook(args: { event_type: string; event_id?: string; provider_reference: string | null; correlation_id?: string | null; participant_id?: string | null; deal_id?: string | null; payload?: Record<string, unknown> }) {
    const body = {
      provider: "payrail-http",
      event_id: args.event_id || `bb-evt-${randomUUID()}`,
      event_type: args.event_type,
      correlation_id: args.correlation_id ?? null,
      participant_id: args.participant_id ?? null,
      deal_id: args.deal_id ?? null,
      provider_reference: args.provider_reference,
      payload: { source: "blackbox-webhook", provider_reference: args.provider_reference, ...(args.payload || {}) }
    };
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      headers: { "content-type": "application/json", "x-webhook-signature": signature, "x-webhook-timestamp": timestamp, "x-request-id": `bb-webhook-${randomUUID()}` },
      payload: raw
    } as any);
    return { statusCode: response.statusCode as number, body: String(response.body), event_id: body.event_id };
  }

  async function close() {
    faults.resetTestFaults?.();
    await app.close().catch(() => undefined);
    await closeWorkerDatabase?.().catch(() => undefined);
    await dbModule.pool?.end?.().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await provider.close();
  }

  return {
    app, pool, provider: provider as ProviderStub, processOutboxEventById, reclaimWorkerJobs,
    reconcileOrphanedUnknownIdentities: appModule.reconcileOrphanedUnknownIdentities as (limit?: number, quietMs?: number) => Promise<number>,
    rescheduleStalledFinalizations: appModule.rescheduleStalledFinalizations as (limit?: number) => Promise<number>,
    armTestFault: faults.armTestFault as (point: string, action: any, count?: number) => any,
    resetTestFaults: faults.resetTestFaults as () => void,
    seedDeal, enqueue, enqueueCharge, enqueueRecovery, enqueueRefund, enqueueRelease, enqueueFinalize, retryNow, outboxRow, liveEvents, drain,
    participant, deal, attempts, ledger, cases, moneyAudits, webhookEvent, dlqRows, snapshot, postWebhook, close
  };
}
export type BlackBox = Awaited<ReturnType<typeof bootBlackBox>>;

export function makeRunner(suite: string) {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  async function run(name: string, fn: () => Promise<void>) {
    const startedAt = Date.now();
    try { await fn(); passed += 1; console.log(`PASS ${name} (${Date.now() - startedAt}ms)`); }
    catch (error) { failed += 1; failures.push(name); console.error(`FAIL ${name}: ${(error as any)?.stack || (error as any)?.message || error}`); }
  }
  function summary() {
    console.log(`\nSUMMARY ${suite} passed=${passed} failed=${failed}${failures.length ? ` failed_names=${JSON.stringify(failures)}` : ""}`);
    return failed;
  }
  return { run, summary };
}
export function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
export async function until(predicate: () => Promise<boolean> | boolean, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await sleep(10); }
  throw new Error(`Timed out: ${label}`);
}
export function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
