// FINANCIAL TORTURE LAB — scenario runtime.
//
// Boots the real application against the programmable provider simulator,
// seeds synthetic deals/participants directly in the disposable database,
// drives the outbox deterministically (no background worker, no sleeps for
// ordering), delivers signed synthetic webhooks, and hands the oracle a raw
// view of provider truth + database truth. Everything here is synthetic:
// disposable database, in-process provider, no e-mail, no SMS, no invoices.

import { strict as assert } from "node:assert";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { startProviderSimulator, type SimulatorOptions } from "./provider_simulator.js";
import { auditFinancialTruth, assertOracleClean, describeOracle, oracleGrossMinor, type OracleReport, type OracleVatPolicy } from "./oracle.js";

export type LabParticipantSpec = {
  buyer_state: string;
  money_state: string;
  qty?: number;
  delivery_cost?: number;
  authorization?: string;
  binding?: boolean;
  /** No binding and a join audit WITHOUT an authorization id: the adapter proves dispatched:false (pre-dispatch failure). */
  withoutAuthorization?: boolean;
  priorAttempts?: Array<{ attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund" | "release"; result_class: "unknown" | "success" | "permanent_fail"; correlation_id?: string; dispatch_state?: "recorded" | "responded" }>;
};

export type LabDealSpec = {
  state: string;
  price_per_unit?: number;
  threshold_units?: number;
  min_units?: number;
  max_units?: number;
  completionWindowUntil?: Date | null;
  deadline?: Date;
  title?: string;
  participants: LabParticipantSpec[];
};

export type SeededParticipant = { participant_id: string; buyer_id: string; authorization: string; qty: number; delivery_cost: number; amount_minor: number };
export type SeededDeal = { deal_id: string; participants: SeededParticipant[]; price_per_unit: number };

export type DrainResult = { event_uuid: string; event_type: string; status: string; error?: string | null };
export type DrainStats = { rounds: number; processed: number; advanced: number; reclaimed: number; results: DrainResult[]; remaining_pending: number; remaining_processing: number };

export type LabOptions = {
  tag: string;
  port: number;
  simulator?: SimulatorOptions;
  clientTimeoutMs?: number;
  env?: Record<string, string>;
  outboxMaxAttempts?: number;
  workerLeaseMs?: number;
};

const WEBHOOK_SECRET = "lab-webhook-secret-7f3c9a2e5b1d4c6f8a0e2b4d6f8a1c3e9d7b5f1a";

export function labVatPolicy(): OracleVatPolicy {
  const mode = String(process.env.SITON_VAT_MODE || "synthetic_zero").toLowerCase();
  const rate = (name: string) => { const raw = process.env[name]; if (raw === undefined || raw === "") return null; const value = Number(raw); return Number.isFinite(value) ? value : null; };
  const product = mode === "explicit" ? (rate("SITON_VAT_RATE_PRODUCT") ?? rate("SITON_VAT_RATE") ?? 0) : 0;
  const delivery = mode === "explicit" ? (rate("SITON_VAT_RATE_DELIVERY") ?? product) : 0;
  return { product_rate: product, delivery_rate: delivery, platform_fee_vat_rate: rate("SITON_PLATFORM_FEE_VAT_RATE") ?? 0.18 };
}

export async function bootLab(options: LabOptions) {
  const clientTimeoutMs = options.clientTimeoutMs ?? 250;
  const sim = startProviderSimulator({ clientTimeoutMs, ...(options.simulator || {}) });
  const baseUrl = await sim.ready;

  process.env.NODE_ENV = "test";
  process.env.PORT = String(options.port);
  process.env.APP_DEPLOYMENT_MODE = "demo-preview";
  process.env.SELLER_SESSION_SECRET = `seller-session-secret-lab-${options.tag}`;
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || `admin-session-secret-lab-${options.tag}`;
  process.env.PAYMENT_PROVIDER = "payrail-http";
  process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
  process.env.PAYMENT_PROVIDER_API_KEY = `lab-provider-key-${options.tag}`;
  process.env.PAYMENT_PROVIDER_BASE_URL = baseUrl;
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
  for (const [key, value] of Object.entries(options.env || {})) process.env[key] = value;

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  assert.match(String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""), /^siton_test_/, "the financial lab may run only in a disposable isolated test database");

  const appModule: any = await import(`../../src/app.js?lab-${options.tag}-${Date.now()}`);
  const { app, processOutboxEventById, reclaimWorkerJobs, closeWorkerDatabase } = appModule;
  const faults: any = await import("../../src/fault_injection.js");
  const dbModule: any = await import("../../src/db.js");
  await app.ready();
  const vat = labVatPolicy();

  // ── seeding ───────────────────────────────────────────────────────────────
  async function seedDeal(spec: LabDealSpec): Promise<SeededDeal> {
    const dealId = randomUUID();
    const price = spec.price_per_unit ?? 42;
    const threshold = spec.threshold_units ?? 1;
    await pool.query(
      `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
       VALUES ($1,'seller-lab',$2,$3,$4,$5,$6,$7,$8,now(),$9)`,
      [dealId, spec.state, spec.title || `Lab ${options.tag} ${dealId.slice(0, 8)}`, price, spec.min_units ?? 1, spec.max_units ?? 500, threshold,
        (spec.deadline || new Date(Date.now() + 30 * 60_000)).toISOString(), spec.completionWindowUntil ? spec.completionWindowUntil.toISOString() : null]
    );
    const participants: SeededParticipant[] = [];
    for (const p of spec.participants) {
      const participantId = randomUUID();
      const buyerId = `buyer-lab-${participantId.slice(0, 8)}`;
      const authorization = p.authorization || `auth-${randomUUID().slice(0, 12)}`;
      const qty = p.qty ?? 1;
      const delivery = p.delivery_cost ?? 0;
      const amountMinor = oracleGrossMinor({ qty, price_per_unit: price, delivery_cost: delivery });
      await pool.query(
        `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [participantId, dealId, buyerId, qty, p.buyer_state, p.money_state, delivery]
      );
      await pool.query(
        `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
         VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
        [participantId, dealId, `lab-seed-${options.tag}`, `lab-seed:${participantId}`, JSON.stringify(p.withoutAuthorization ? { authorization: "provider_authorized", authorization_provider: "payrail-http" } : { authorization: "provider_authorized", authorization_id: authorization, authorization_provider: "payrail-http" })]
      );
      if (p.binding !== false && !p.withoutAuthorization && amountMinor > 0) {
        await pool.query(
          `INSERT INTO siton.payment_authorization_bindings
             (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id, consumed_by_participant_id, consumed_at)
           VALUES ('payrail-http','provider-ready','test',$1,$1,$2,$3,$4,$5,'ILS',$6,'consumed',$7,$8,now())`,
          [authorization, dealId, buyerId, qty, amountMinor, delivery, `lab-auth:${authorization}`, participantId]
        );
      }
      for (const prior of p.priorAttempts || []) {
        await pool.query(
          `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [participantId, dealId, prior.attempt_type, prior.result_class, prior.correlation_id || `${prior.attempt_type}:lab-prior:n1:${participantId}`, prior.dispatch_state || (prior.result_class === "unknown" ? "responded" : "responded")]
        );
      }
      participants.push({ participant_id: participantId, buyer_id: buyerId, authorization, qty, delivery_cost: delivery, amount_minor: amountMinor });
      seededAuthorizations[participantId] = authorization;
      if (["ChargedSuccess", "RecoveredCharge", "Refunded", "AuthReleased"].includes(p.money_state)) seededFromScenario.add(participantId);
    }
    return { deal_id: dealId, participants, price_per_unit: price };
  }

  /** Operator repair: attach a consumed authorization binding to a participant seeded without one. */
  async function attachAuthorization(seeded: SeededDeal, participant: SeededParticipant) {
    await pool.query(
      `INSERT INTO siton.payment_authorization_bindings
         (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id, consumed_by_participant_id, consumed_at)
       VALUES ('payrail-http','provider-ready','test',$1,$1,$2,$3,$4,$5,'ILS',$6,'consumed',$7,$8,now())`,
      [participant.authorization, seeded.deal_id, participant.buyer_id, participant.qty, participant.amount_minor, participant.delivery_cost, `lab-auth:${participant.authorization}:${randomUUID().slice(0, 8)}`, participant.participant_id]
    );
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
  const enqueueRefund = (dealId: string, reason = "lab") => enqueue("refund_issue", "deal", dealId, { deal_id: dealId, reason });
  const enqueueRelease = (participantId: string, dealId: string, reason = "lab") => enqueue("payment_release", "participant", participantId, { participant_id: participantId, deal_id: dealId, reason });
  const enqueueFinalize = (dealId: string) => enqueue("finalize_deal", "deal", dealId, { deal_id: dealId });
  const enqueueReconcile = (args: { participant_id: string; deal_id: string; attempt_type: string; correlation_id: string; operation: "capture" | "refund" | "release"; provider_reference: string | null; reason?: string }) =>
    enqueue("payment_reconcile", "participant", args.participant_id, { ...args, reason: args.reason || "lab" });

  async function retryNow(eventId: string) { await pool.query(`UPDATE siton.outbox_events SET available_at=clock_timestamp() WHERE event_uuid=$1 AND status='pending'`, [eventId]); }
  /** The live row, or the DLQ copy (status "dlq") once the worker archived it. */
  async function outboxRow(eventId: string) {
    const live = (await pool.query(`SELECT event_uuid, event_type, status, attempt_count, last_error, lease_generation, worker_id, (available_at > clock_timestamp()) AS deferred FROM siton.outbox_events WHERE event_uuid=$1`, [eventId])).rows[0] as { event_uuid: string; event_type: string; status: string; attempt_count: number; last_error: string | null; lease_generation: number; worker_id: string | null; deferred: boolean } | undefined;
    if (live) return live;
    const dlq = (await pool.query(`SELECT event_uuid, event_type, 'dlq'::text AS status, attempt_count, last_error, lease_generation, worker_id, false AS deferred FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId])).rows[0] as { event_uuid: string; event_type: string; status: string; attempt_count: number; last_error: string | null; lease_generation: number; worker_id: string | null; deferred: boolean } | undefined;
    return dlq;
  }
  async function dlqRows(aggregateId: string, eventType?: string) {
    return (await pool.query(`SELECT event_uuid, event_type, last_error FROM siton.outbox_dlq WHERE aggregate_id=$1 AND ($2::text IS NULL OR event_type=$2) ORDER BY created_at`, [aggregateId, eventType ?? null])).rows as Array<{ event_uuid: string; event_type: string; last_error: string | null }>;
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
    const participantIds = await participantIdsOf(dealIds);
    return scopedEvents(dealIds, participantIds, `status IN ('pending','processing')`, types);
  }

  /**
   * Drive every claimable event in scope to completion, deterministically:
   * reclaim dead leases, process due events one at a time, pull deferred
   * money events forward (bounded), stop when nothing in scope is live.
   */
  async function drain(opts: { dealIds: string[]; maxRounds?: number; advanceDeferred?: boolean; advanceDelayMs?: number; types?: string[]; skip?: (event: { event_uuid: string; event_type: string }) => boolean; onResult?: (result: DrainResult) => void }): Promise<DrainStats> {
    const stats: DrainStats = { rounds: 0, processed: 0, advanced: 0, reclaimed: 0, results: [], remaining_pending: 0, remaining_processing: 0 };
    const maxRounds = opts.maxRounds ?? 40;
    const participantIds = await participantIdsOf(opts.dealIds);
    while (stats.rounds < maxRounds) {
      stats.rounds += 1;
      stats.reclaimed += Number((await reclaimWorkerJobs(0))?.outbox ?? (await Promise.resolve(0))) || 0;
      // worker maintenance parity: orphaned UNKNOWN identities get their reconcile (F-4)
      if (typeof appModule.reconcileOrphanedUnknownIdentities === "function") await appModule.reconcileOrphanedUnknownIdentities(50, 0).catch(() => 0);
      if (typeof appModule.rescheduleStalledFinalizations === "function" && !(opts.skip && opts.skip({ event_uuid: "", event_type: "finalize_deal" }))) await appModule.rescheduleStalledFinalizations().catch(() => 0);
      const due = (await scopedEvents(opts.dealIds, participantIds, `status='pending' AND available_at <= clock_timestamp()`, opts.types)).filter((e) => !(opts.skip && opts.skip(e)));
      if (due.length === 0) {
        const deferred = await scopedEvents(opts.dealIds, participantIds, `status='pending' AND available_at > clock_timestamp()`, opts.types);
        const processing = await scopedEvents(opts.dealIds, participantIds, `status='processing'`, opts.types);
        if (deferred.length && opts.advanceDeferred !== false) {
          // Backoff is compressed, not skipped: a short pause keeps asynchronous
          // provider settlements (DELAYED_EFFECT / LATE_SUCCESS) realistic.
          await new Promise((resolve) => setTimeout(resolve, opts.advanceDelayMs ?? 75));
          await pool.query(`UPDATE siton.outbox_events SET available_at=clock_timestamp() WHERE event_uuid = ANY($1::uuid[])`, [deferred.map((e) => e.event_uuid)]);
          stats.advanced += deferred.length;
          continue;
        }
        if (processing.length) {
          // a lease is held by nobody in this process (parked or dead); expire it and reclaim
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
        opts.onResult?.(result);
      }
    }
    const notSkipped = (e: { event_uuid: string; event_type: string }) => !(opts.skip && opts.skip(e));
    stats.remaining_pending = (await scopedEvents(opts.dealIds, participantIds, `status='pending'`, opts.types)).filter(notSkipped).length;
    stats.remaining_processing = (await scopedEvents(opts.dealIds, participantIds, `status='processing'`, opts.types)).filter(notSkipped).length;
    return stats;
  }

  // ── database views ────────────────────────────────────────────────────────
  async function participant(participantId: string) {
    return (await pool.query(`SELECT buyer_state, money_state, qty, delivery_cost FROM siton.participants WHERE participant_id=$1`, [participantId])).rows[0] as { buyer_state: string; money_state: string; qty: number; delivery_cost: string };
  }
  async function deal(dealId: string) {
    return (await pool.query(`SELECT state, completion_window_until FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0] as { state: string; completion_window_until: string | null };
  }
  async function attempts(participantId: string, attemptType?: string) {
    return (await pool.query(
      `SELECT attempt_type, correlation_id, result_class, dispatch_state, owner_event_uuid, owner_lease_generation, provider_reference, outcome_note,
              siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight
       FROM siton.payment_attempts WHERE participant_id=$1 AND ($2::text IS NULL OR attempt_type=$2) ORDER BY created_at ASC, correlation_id ASC`,
      [participantId, attemptType ?? null]
    )).rows as Array<{ attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; owner_event_uuid: string | null; owner_lease_generation: number | null; provider_reference: string | null; outcome_note: string | null; in_flight: boolean }>;
  }
  async function ledger(participantId: string) {
    return (await pool.query(`SELECT logical_entry_type, platform_fee_amount, gross_amount, seller_net_amount FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at`, [participantId])).rows as Array<{ logical_entry_type: string; platform_fee_amount: string; gross_amount: string; seller_net_amount: string }>;
  }
  async function cases(participantId: string) {
    return (await pool.query(`SELECT auto_key, subject, status FROM siton.operational_cases WHERE auto_key LIKE '%' || $1 || '%' ORDER BY created_at`, [participantId])).rows as Array<{ auto_key: string; subject: string; status: string }>;
  }
  async function moneyAudits(participantId: string) {
    return (await pool.query(`SELECT state_type, from_state, to_state, action_name FROM siton.audit_log WHERE entity_type='participant' AND entity_id=$1 AND state_type IN ('money_state','buyer_state') ORDER BY created_at ASC, audit_id ASC`, [participantId])).rows as Array<{ state_type: string; from_state: string; to_state: string; action_name: string }>;
  }

  // ── synthetic provider callbacks (signed like a real provider would) ─────
  async function postWebhook(args: { event_type: string; event_id?: string; provider_reference: string | null; correlation_id?: string | null; participant_id?: string | null; deal_id?: string | null; payload?: Record<string, unknown>; timestampSkewSeconds?: number; badSignature?: boolean }) {
    const body = {
      provider: "payrail-http",
      event_id: args.event_id || `lab-evt-${randomUUID()}`,
      event_type: args.event_type,
      correlation_id: args.correlation_id ?? null,
      participant_id: args.participant_id ?? null,
      deal_id: args.deal_id ?? null,
      provider_reference: args.provider_reference,
      payload: { source: "lab-webhook", provider_reference: args.provider_reference, ...(args.payload || {}) }
    };
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000) + (args.timestampSkewSeconds || 0));
    const signature = createHmac("sha256", args.badSignature ? "wrong-secret" : WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      headers: { "content-type": "application/json", "x-webhook-signature": signature, "x-webhook-timestamp": timestamp, "x-request-id": `lab-webhook-${randomUUID()}` },
      payload: raw
    } as any);
    return { statusCode: response.statusCode as number, body: String(response.body), event_id: body.event_id };
  }

  // ── oracle ────────────────────────────────────────────────────────────────
  // Every seeded participant's authorization is remembered here so the oracle
  // maps provider effects by what the lab GAVE the participant, not by whatever
  // reference the application later stored for it.
  const seededAuthorizations: Record<string, string> = {};
  const seededFromScenario = new Set<string>(); // participants whose captured state was SEEDED (no capture ran in-scenario)
  async function oracle(label: string, dealIds: string[], opts: { allowUnresolved?: boolean; expectLateEffects?: string[]; allowedCodes?: string[]; print?: boolean; seededStates?: boolean } = {}): Promise<OracleReport> {
    const report = await auditFinancialTruth(pool, {
      label, dealIds, provider: () => sim.snapshot(), vat, participantAuthorizations: seededAuthorizations, seededStates: opts.seededStates ?? true,
      ...(opts.allowUnresolved !== undefined ? { allowUnresolved: opts.allowUnresolved } : {}),
      ...(opts.expectLateEffects ? { expectLateEffects: opts.expectLateEffects } : {})
    });
    if (opts.print !== false) console.log(`  oracle ${describeOracle(report)}`);
    assertOracleClean(report, opts.allowedCodes || []);
    return report;
  }

  async function close() {
    faults.resetTestFaults?.();
    await app.close().catch(() => undefined);
    await closeWorkerDatabase?.().catch(() => undefined);
    await dbModule.pool?.end?.().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await sim.close();
  }

  return {
    app, pool, sim, vat, faults, processOutboxEventById, reclaimWorkerJobs,
    armTestFault: faults.armTestFault as (point: string, action: any, count?: number) => any,
    resetTestFaults: faults.resetTestFaults as () => void,
    seedDeal, attachAuthorization, enqueue, enqueueCharge, enqueueRecovery, enqueueRefund, enqueueRelease, enqueueFinalize, enqueueReconcile,
    retryNow, outboxRow, dlqRows, liveEvents, drain, participant, deal, attempts, ledger, cases, moneyAudits, postWebhook, oracle, close,
    WEBHOOK_SECRET
  };
}

export type Lab = Awaited<ReturnType<typeof bootLab>>;

// ── small test-runner shared by the lab suites ──────────────────────────────
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
  return { run, summary, get passed() { return passed; }, get failed() { return failed; } };
}

export function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
}

export function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }
