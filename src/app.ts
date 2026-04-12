import Fastify from "fastify";
import pg from "pg"; const { Pool } = pg; type PoolClient = any;
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { buildOutboxWorkerHelpers } from "./outbox_worker_helpers.js";
import { buildPaymentAttemptHelpers } from "./payment_attempt_helpers.js";
dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || "0.0.0.0");
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";

const COMPLETION_WINDOW_MINUTES = Number(process.env.COMPLETION_WINDOW_MINUTES || 15);
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 1000);
const OUTBOX_MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 4);

const MOCK_SEED = process.env.MOCK_SEED ? Number(process.env.MOCK_SEED) : null;
const DEBUG_SURFACES_HEADER = "x-debug-access-key";

const pool = new Pool({ connectionString: DATABASE_URL });

function debugSurfaceAccessKey() {
  return String(process.env.DEBUG_SURFACES_ACCESS_KEY || "").trim();
}

function debugSurfacesActive() {
  return process.env.DEBUG_SURFACES_ENABLED === "1" && Boolean(debugSurfaceAccessKey());
}

function debugSurfaceAuthorized(req: any) {
  if (!debugSurfacesActive()) return false;
  const presented = String(req.headers?.[DEBUG_SURFACES_HEADER] || "").trim();
  return Boolean(presented) && presented === debugSurfaceAccessKey();
}

type DealState =
  | "Draft"
  | "PendingTarget"
  | "TargetReached"
  | "ClosedForJoining"
  | "ReadyForCharging"
  | "Charging"
  | "CompletionWindow"
  | "Completed"
  | "Failed"
  | "Cancelled";

type BuyerState =
  | "NotJoined"
  | "JoinedAuthorized"
  | "LockedIn"
  | "ChargingAttempt"
  | "ChargedSuccess"
  | "ChargeFailedCompletion"
  | "Recovered"
  | "Dropped"
  | "DealCompleted"
  | "DealFailed";

type MoneyState =
  | "NoFinancial"
  | "AuthHeld"
  | "AuthLocked"
  | "ChargeAttempt"
  | "ChargedSuccess"
  | "ChargeFailedRecovery"
  | "RecoveredCharge"
  | "AuthReleased"
  | "Refunded";

export const DEAL_TRANSITIONS: Record<string, string[]> = {
  Draft: ["PendingTarget", "Cancelled"],
  PendingTarget: ["TargetReached", "Failed", "Cancelled"],
  TargetReached: ["ClosedForJoining", "Cancelled"],
  ClosedForJoining: ["ReadyForCharging", "Cancelled"],
  ReadyForCharging: ["Charging", "Cancelled"],
  Charging: ["CompletionWindow", "Failed", "Cancelled"],
  CompletionWindow: ["Completed", "Failed"],
  Completed: [],
  Failed: [],
  Cancelled: []
};

export const BUYER_TRANSITIONS: Record<string, string[]> = {
  NotJoined: ["JoinedAuthorized", "DealFailed"],
  JoinedAuthorized: ["LockedIn", "DealFailed"],
  LockedIn: ["ChargingAttempt", "DealFailed"],
  ChargingAttempt: ["ChargedSuccess", "ChargeFailedCompletion", "DealFailed"],
  ChargeFailedCompletion: ["Recovered", "Dropped", "DealFailed"],
  ChargedSuccess: ["DealCompleted", "DealFailed"],
  Recovered: ["DealCompleted", "DealFailed"],
  Dropped: ["DealFailed"],
  DealCompleted: [],
  DealFailed: []
};

export const MONEY_TRANSITIONS: Record<string, string[]> = {
  NoFinancial: ["AuthHeld"],
  AuthHeld: ["AuthLocked", "AuthReleased"],
  AuthLocked: ["ChargeAttempt", "AuthReleased"],
  ChargeAttempt: ["ChargedSuccess", "ChargeFailedRecovery"],
  ChargeFailedRecovery: ["RecoveredCharge", "AuthReleased"],
  ChargedSuccess: ["Refunded"],
  RecoveredCharge: ["Refunded"],
  AuthReleased: [],
  Refunded: []
};

export function assertValidTransition(
  stateType: "deal_state" | "buyer_state" | "money_state",
  from: string,
  to: string
) {
  const matrix =
    stateType === "deal_state"
      ? DEAL_TRANSITIONS
      : stateType === "buyer_state"
        ? BUYER_TRANSITIONS
        : MONEY_TRANSITIONS;

  const allowed = matrix[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`Illegal ${stateType} transition ${from} to ${to}`);
  }
}

function nowPlusMinutes(mins: number) {
  return new Date(Date.now() + mins * 60_000);
}

function requireUuid(value: string, fieldName: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    const err: any = new Error(`${fieldName} must be a valid UUID`);
    err.statusCode = 400;
    throw err;
  }
}

class DeferredEventError extends Error {
  retryAt: Date;

  constructor(message: string, retryAt: Date) {
    super(message);
    this.name = "DeferredEventError";
    this.retryAt = retryAt;
  }
}

async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

type AtomicEntityType = "deal" | "participant";
type AtomicStateType = "deal_state" | "buyer_state" | "money_state";

type OutboxInsert =
  | null
  | {
      event_type: "charge_deal" | "recovery_deal" | "finalize_deal" | "refund_issue" | "deadline_check" | "cancel_refund";
      aggregate_type: "deal" | "participant";
      aggregate_id: string;
      payload: any;
      available_at?: Date;
    };

type TransitionOp = {
  entityType: AtomicEntityType;
  entityId: string;
  dealId: string | null;
  stateType: AtomicStateType;
  fromState: string;
  toState: string;
  payload?: any;
};

class PermanentFailError extends Error {
  readonly kind = "permanent_fail";
  constructor(message: string) {
    super(message);
  }
}

const {
  claimOutboxBatch,
  markOutboxSent,
  markOutboxFailed
} = buildOutboxWorkerHelpers({
  withTx,
  outboxPollMs: OUTBOX_POLL_MS,
  outboxMaxAttempts: OUTBOX_MAX_ATTEMPTS,
  PermanentFailErrorCtor: PermanentFailError,
  DeferredEventErrorCtor: DeferredEventError
});

const {
  recordAttemptBeforeIo,
  finalizeAttemptResult
} = buildPaymentAttemptHelpers({
  withTx
});

async function atomicMultiTransition(args: {
  actionName: string;
  requestId: string;
  idempotency: { entityType: AtomicEntityType; entityId: string; idempotencyKey: string };
  buildOpsInTx?: (c: PoolClient) => Promise<TransitionOp[]>;
  ops?: TransitionOp[];
  outbox: OutboxInsert;
  response?: any;
  insideTx?: (c: PoolClient) => Promise<void>;
}): Promise<{ response: any; replay: boolean }> {
  const response = args.response ?? { ok: true };

  return withTx(async (c) => {
    const idem = await c.query(
      `SELECT response_jsonb
       FROM siton.idempotency_log
       WHERE entity_type=$1 AND entity_id=$2 AND action_name=$3 AND idempotency_key=$4`,
      [args.idempotency.entityType, args.idempotency.entityId, args.actionName, args.idempotency.idempotencyKey]
    );

    if (idem.rowCount && idem.rows[0]?.response_jsonb) {
      return { response: idem.rows[0].response_jsonb, replay: true };
    }

    const ops = args.ops ? args.ops : args.buildOpsInTx ? await args.buildOpsInTx(c) : [];
    if (ops.length === 0 && !args.insideTx && !args.outbox) {
      await c.query(
        `INSERT INTO siton.idempotency_log
         (entity_type, entity_id, action_name, idempotency_key, response_code, response_jsonb)
         VALUES ($1,$2,$3,$4,'OK',$5)`,
        [args.idempotency.entityType, args.idempotency.entityId, args.actionName, args.idempotency.idempotencyKey, JSON.stringify(response)]
      );
      return { response, replay: false };
    }

    for (const op of ops) {
      assertValidTransition(op.stateType, op.fromState, op.toState);
    }

    await c.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await c.query(`SELECT set_config('siton.action_name', $1, true)`, [args.actionName]);
    await c.query(`SELECT set_config('siton.audit_written', '0', true)`);
    await c.query(`SELECT set_config('siton.outbox_written', '0', true)`);

    for (const op of ops) {
      await c.query(
        `INSERT INTO siton.audit_log
         (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          op.entityType,
          op.entityId,
          op.dealId,
          op.stateType,
          op.fromState,
          op.toState,
          args.actionName,
          args.requestId,
          args.idempotency.idempotencyKey,
          JSON.stringify(op.payload ?? {})
        ]
      );
    }

    await c.query(`SELECT set_config('siton.audit_written', '1', true)`);

    if (args.outbox) {
      await c.query(
        `INSERT INTO siton.outbox_events
         (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
         VALUES ($1,$2,$3,$4,'pending',0,COALESCE($5, now()))`,
        [
          args.outbox.event_type,
          args.outbox.aggregate_type,
          args.outbox.aggregate_id,
          JSON.stringify(args.outbox.payload ?? {}),
          args.outbox.available_at ? args.outbox.available_at.toISOString() : null
        ]
      );
      await c.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    }

    if (args.insideTx) {
      await args.insideTx(c);
    }

    for (const op of ops) {
      if (op.entityType === "deal") {
        const upd = await c.query(
          `UPDATE siton.deals
           SET state=$1
           WHERE deal_id=$2 AND state=$3`,
          [op.toState, op.entityId, op.fromState]
        );
        if (upd.rowCount !== 1) throw new Error(`State mismatch deal ${op.entityId} expected ${op.fromState}`);
      } else {
        const col = op.stateType === "buyer_state" ? "buyer_state" : "money_state";
        const upd = await c.query(
          `UPDATE siton.participants
           SET ${col}=$1
           WHERE participant_id=$2 AND ${col}=$3`,
          [op.toState, op.entityId, op.fromState]
        );
        if (upd.rowCount !== 1) throw new Error(`State mismatch participant ${op.entityId} expected ${op.fromState}`);
      }
    }

    await c.query(
      `INSERT INTO siton.idempotency_log
       (entity_type, entity_id, action_name, idempotency_key, response_code, response_jsonb)
       VALUES ($1,$2,$3,$4,'OK',$5)`,
      [args.idempotency.entityType, args.idempotency.entityId, args.actionName, args.idempotency.idempotencyKey, JSON.stringify(response)]
    );

    await c.query(`SELECT set_config('siton.in_atomic', 'false', true)`);
    return { response, replay: false };
  });
}

async function atomicTransition(args: {
  entityType: AtomicEntityType;
  entityId: string;
  dealId: string | null;
  stateType: AtomicStateType;
  fromState: string;
  toState: string;
  actionName: string;
  requestId: string;
  idempotencyKey: string;
  outbox: OutboxInsert;
  payload?: any;
  response?: any;
  insideTx?: (c: PoolClient) => Promise<void>;
}) {
  return atomicMultiTransition({
    actionName: args.actionName,
    requestId: args.requestId,
    idempotency: { entityType: args.entityType, entityId: args.entityId, idempotencyKey: args.idempotencyKey },
    ops: [
      {
        entityType: args.entityType,
        entityId: args.entityId,
        dealId: args.dealId,
        stateType: args.stateType,
        fromState: args.fromState,
        toState: args.toState,
        payload: args.payload
      }
    ],
    outbox: args.outbox,
    response: args.response,
    ...(args.insideTx ? { insideTx: args.insideTx } : {})
  });
}

type PaymentResultClass = "success" | "permanent_fail" | "temporary_fail";

function hashToUint32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcgNext(x: number) {
  return (Math.imul(1664525, x) + 1013904223) >>> 0;
}

function rand01Deterministic(key: string) {
  if (MOCK_SEED === null) return Math.random();
  let x = (MOCK_SEED ^ hashToUint32(key)) >>> 0;
  x = lcgNext(x);
  return (x >>> 0) / 0x100000000;
}

async function paymentCaptureMock(key: string): Promise<PaymentResultClass> {
  const r = rand01Deterministic(key);
  if (r < 0.75) return "success";
  if (r < 0.9) return "temporary_fail";
  return "permanent_fail";
}

async function paymentRecoveryMock(key: string, withinWindow: boolean): Promise<PaymentResultClass> {
  if (!withinWindow) return "permanent_fail";
  const r = rand01Deterministic(key);
  if (r < 0.5) return "success";
  if (r < 0.8) return "temporary_fail";
  return "permanent_fail";
}

async function refundMock(key: string): Promise<PaymentResultClass> {
  const r = rand01Deterministic(key);
  if (r < 0.8) return "success";
  if (r < 0.95) return "temporary_fail";
  return "permanent_fail";
}

async function sumJoinedUnits(c: PoolClient, dealId: string): Promise<number> {
  // Exclude participants whose authorization was released — they no longer hold inventory
  const r = await c.query(
    `SELECT COALESCE(SUM(qty),0) AS total
     FROM siton.participants
     WHERE deal_id=$1
       AND buyer_state NOT IN ('DealFailed','Dropped')`,
    [dealId]
  );
  return Number(r.rows[0].total || 0);
}

async function sumCapturedUnits(c: PoolClient, dealId: string): Promise<number> {
  const r = await c.query(
    `SELECT COALESCE(SUM(qty),0) AS total
     FROM siton.participants
     WHERE deal_id=$1
       AND money_state IN ('ChargedSuccess','RecoveredCharge')`,
    [dealId]
  );
  return Number(r.rows[0].total || 0);
}

async function setCompletionWindowOnce(c: PoolClient, dealId: string): Promise<Date> {
  const r = await c.query(`SELECT completion_window_until FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
  if (!r.rowCount) throw new Error("deal not found");
  if (r.rows[0].completion_window_until) return new Date(r.rows[0].completion_window_until);
  const until = nowPlusMinutes(COMPLETION_WINDOW_MINUTES);
  await c.query(`UPDATE siton.deals SET completion_window_until=$1 WHERE deal_id=$2`, [
    until.toISOString(),
    dealId
  ]);
  return until;
}

async function failAllParticipantsForDeal(dealId: string, requestId: string) {
  const participants = await withTx(async (c) => {
    const r = await c.query(
      `SELECT participant_id, buyer_state
       FROM siton.participants
       WHERE deal_id=$1`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string; buyer_state: BuyerState }>;
  });

  for (const p of participants) {
    if (p.buyer_state === "DealFailed" || p.buyer_state === "DealCompleted") continue;
    if (!BUYER_TRANSITIONS[p.buyer_state]?.includes("DealFailed")) continue;

    await atomicTransition({
      entityType: "participant",
      entityId: p.participant_id,
      dealId,
      stateType: "buyer_state",
      fromState: p.buyer_state,
      toState: "DealFailed",
      actionName: "deal.fail_participant",
      requestId,
      idempotencyKey: `p-dealfailed:${dealId}:${p.participant_id}`,
      outbox: null
    });
  }
}

async function cleanupObsoleteDealOutboxEvents(dealId: string) {
  await withTx(async (c) => {
    await c.query(`SELECT set_config('siton.is_worker','true',true)`);
    await c.query(
      `DELETE FROM siton.outbox_events
       WHERE aggregate_id=$1
         AND event_type IN ('deadline_check')`,
      [dealId]
    );
  });
}

async function handleRefundEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
  },
  eventId: string
) {
  const dealId = event.aggregate_id;

  const needRefund = await withTx(async (c) => {
    const r = await c.query(
      `SELECT participant_id, money_state
       FROM siton.participants
       WHERE deal_id=$1
         AND money_state IN ('ChargedSuccess','RecoveredCharge')
       ORDER BY created_at ASC`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string; money_state: MoneyState }>;
  });

  for (const p of needRefund) {
    const correlation = `${event.event_type}:refund:${eventId}:${p.participant_id}`;
    await recordAttemptBeforeIo({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: event.event_type === "cancel_refund" ? "cancel_refund" : "refund",
      correlation_id: correlation
    });

    const result = await refundMock(correlation);

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: event.event_type === "cancel_refund" ? "cancel_refund" : "refund",
      correlation_id: correlation,
      result_class: result
    });

    if (result === "temporary_fail") {
      throw new Error(`temporary_fail refund participant ${p.participant_id}`);
    }

    if (result === "success") {
      await atomicTransition({
        entityType: "participant",
        entityId: p.participant_id,
        dealId,
        stateType: "money_state",
        fromState: p.money_state,
        toState: "Refunded",
        actionName: "refund.issue",
        requestId: `worker:${eventId}`,
        idempotencyKey: `refund:${dealId}:${p.participant_id}`,
        outbox: null,
        payload: { result }
      });
    } else {
      throw new PermanentFailError(`permanent_fail refund participant ${p.participant_id}`);
    }
  }
}

async function handleChargeDealEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
  },
  eventId: string,
  app: ReturnType<typeof Fastify>
) {
  const dealId = event.aggregate_id;

  const participants = await withTx(async (c) => {
    const r = await c.query(
      `SELECT participant_id, buyer_state, money_state
       FROM siton.participants
       WHERE deal_id=$1
       ORDER BY created_at ASC`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string; buyer_state: BuyerState; money_state: MoneyState }>;
  });

  for (const p of participants) {
    if (p.buyer_state !== "ChargingAttempt" || p.money_state !== "ChargeAttempt") continue;

    const correlation = `capture:${eventId}:${p.participant_id}`;
    await recordAttemptBeforeIo({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation
    });

    const result = await paymentCaptureMock(correlation);

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      result_class: result
    });

    if (result === "temporary_fail") {
      throw new Error(`temporary_fail capture participant ${p.participant_id}`);
    }

    if (result === "success") {
      await atomicMultiTransition({
        actionName: "charging.capture_success",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `capture-success:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeAttempt", toState: "ChargedSuccess", payload: { result } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargingAttempt", toState: "ChargedSuccess", payload: { result } }
        ],
        outbox: null
      });
    } else {
      await atomicMultiTransition({
        actionName: "charging.capture_failed",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `capture-fail:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeAttempt", toState: "ChargeFailedRecovery", payload: { result } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargingAttempt", toState: "ChargeFailedCompletion", payload: { result } }
        ],
        outbox: null
      });
    }
  }

  const windowUntil = await withTx(async (c) => setCompletionWindowOnce(c, dealId));
  app.log.info({ dealId, eventId, windowUntil: windowUntil.toISOString() }, "charge_deal before completion transition");

  let transitionResult;
  try {
    transitionResult = await atomicTransition({
      entityType: "deal",
      entityId: dealId,
      dealId,
      stateType: "deal_state",
      fromState: "Charging",
      toState: "CompletionWindow",
      actionName: "charging.to_completion_window",
      requestId: `worker:${eventId}`,
      idempotencyKey: `deal-to-window:${eventId}:${dealId}`,
      outbox: {
        event_type: "finalize_deal",
        aggregate_type: "deal",
        aggregate_id: dealId,
        payload: { deal_id: dealId },
        available_at: windowUntil
      },
      payload: { completion_window_until: windowUntil.toISOString() }
    });

    app.log.info({ dealId, eventId, transitionResult }, "charge_deal after completion transition");
  } catch (e) {
    app.log.error({ dealId, eventId, err: String(e instanceof Error ? e.message : e) }, "charge_deal completion transition failed");
    throw e;
  }

  const needRecovery = await withTx(async (c) => {
    const r = await c.query(
      `SELECT COUNT(*) AS cnt
       FROM siton.participants
       WHERE deal_id=$1
         AND buyer_state='ChargeFailedCompletion'
         AND money_state='ChargeFailedRecovery'`,
      [dealId]
    );
    return Number(r.rows[0].cnt || 0) > 0;
  });

  if (needRecovery) {
    await withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      await c.query(
        `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
         VALUES ('recovery_deal','deal',$1,$2,'pending',0, now())`,
        [dealId, JSON.stringify({ deal_id: dealId })]
      );
    });
  }

  await cleanupObsoleteDealOutboxEvents(dealId);
  return;
}

async function handleRecoveryDealEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
  },
  eventId: string
) {
  const dealId = event.aggregate_id;

  const deal = await withTx(async (c) => {
    const r = await c.query(`SELECT state, completion_window_until FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) throw new Error("deal not found");
    return r.rows[0] as { state: DealState; completion_window_until: string | null };
  });

  if (deal.state !== "CompletionWindow" || !deal.completion_window_until) return;

  const withinWindow = await withTx(async (c) => {
    const r = await c.query(`SELECT (now() < completion_window_until) AS within FROM siton.deals WHERE deal_id=$1`, [dealId]);
    return Boolean(r.rows[0]?.within);
  });

  const participants = await withTx(async (c) => {
    const r = await c.query(
      `SELECT participant_id
       FROM siton.participants
       WHERE deal_id=$1
         AND buyer_state='ChargeFailedCompletion'
         AND money_state='ChargeFailedRecovery'
       ORDER BY created_at ASC`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string }>;
  });

  for (const p of participants) {
    const correlation = `recovery:${eventId}:${p.participant_id}`;
    await recordAttemptBeforeIo({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation
    });

    const result = await paymentRecoveryMock(correlation, withinWindow);

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      result_class: result
    });

    if (result === "temporary_fail") {
      throw new Error(`temporary_fail recovery participant ${p.participant_id}`);
    }

    if (result === "success") {
      await atomicMultiTransition({
        actionName: "charging.recovery_success",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `recovery-success:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeFailedRecovery", toState: "RecoveredCharge", payload: { result } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargeFailedCompletion", toState: "Recovered", payload: { result } }
        ],
        outbox: null
      });
    } else {
      await atomicMultiTransition({
        actionName: "charging.recovery_failed",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `recovery-fail:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeFailedRecovery", toState: "AuthReleased", payload: { result } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargeFailedCompletion", toState: "Dropped", payload: { result } }
        ],
        outbox: null
      });
    }
  }

  return;
}

async function handleFinalizeDealEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
  },
  eventId: string
) {
  const dealId = event.aggregate_id;

  const dealRow = await withTx(async (c) => {
    const r = await c.query(
      `SELECT state, threshold_units, completion_window_until, (now() >= completion_window_until) AS can_finalize
       FROM siton.deals
       WHERE deal_id=$1`,
      [dealId]
    );
    if (!r.rowCount) throw new Error("deal not found");
    return r.rows[0] as { state: DealState; threshold_units: number; completion_window_until: string | null; can_finalize: boolean };
  });

  if (dealRow.state !== "CompletionWindow") return;
  if (!dealRow.completion_window_until) return;
  if (!dealRow.can_finalize) {
    throw new DeferredEventError("finalize_not_ready_yet", new Date(dealRow.completion_window_until));
  }

  const decision = await withTx(async (c) => {
    const captured = await sumCapturedUnits(c, dealId);
    return { captured, threshold: Number(dealRow.threshold_units) };
  });

  if (decision.captured >= decision.threshold) {
    await atomicTransition({
      entityType: "deal",
      entityId: dealId,
      dealId,
      stateType: "deal_state",
      fromState: "CompletionWindow",
      toState: "Completed",
      actionName: "charging.finalize_completed",
      requestId: `worker:${eventId}`,
      idempotencyKey: `deal-finalize-ok:${dealId}`,
      outbox: null,
      payload: { decision }
    });

    const participants = await withTx(async (c) => {
      const r = await c.query(
        `SELECT participant_id, buyer_state
         FROM siton.participants
         WHERE deal_id=$1`,
        [dealId]
      );
      return r.rows as Array<{ participant_id: string; buyer_state: BuyerState }>;
    });

    for (const p of participants) {
      if (p.buyer_state === "ChargedSuccess" || p.buyer_state === "Recovered") {
        await atomicTransition({
          entityType: "participant",
          entityId: p.participant_id,
          dealId,
          stateType: "buyer_state",
          fromState: p.buyer_state,
          toState: "DealCompleted",
          actionName: "deal.complete_participant",
          requestId: `worker:${eventId}`,
          idempotencyKey: `p-dealcompleted:${dealId}:${p.participant_id}`,
          outbox: null
        });
      } else if (p.buyer_state === "Dropped") {
        await atomicTransition({
          entityType: "participant",
          entityId: p.participant_id,
          dealId,
          stateType: "buyer_state",
          fromState: "Dropped",
          toState: "DealFailed",
          actionName: "deal.fail_participant_after_completed",
          requestId: `worker:${eventId}`,
          idempotencyKey: `p-dropped-to-failed:${dealId}:${p.participant_id}`,
          outbox: null
        });
      }
    }

    await cleanupObsoleteDealOutboxEvents(dealId);
    return;
  }

  await atomicTransition({
    entityType: "deal",
    entityId: dealId,
    dealId,
    stateType: "deal_state",
    fromState: "CompletionWindow",
    toState: "Failed",
    actionName: "charging.finalize_failed",
    requestId: `worker:${eventId}`,
    idempotencyKey: `deal-finalize-fail:${dealId}`,
    outbox: { event_type: "refund_issue", aggregate_type: "deal", aggregate_id: dealId, payload: { deal_id: dealId } },
    payload: { decision }
  });

  await failAllParticipantsForDeal(dealId, `worker:${eventId}`);
  return;
}

async function workerProcessEvent(event: {
  event_uuid: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  attempt_count: number;
}) {
  const eventId = event.event_uuid;

  if (event.event_type === "deadline_check") {
    const dealId = event.aggregate_id;

    const deal = await withTx(async (c) => {
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      const r = await c.query(
        `SELECT state, deadline, threshold_units
         FROM siton.deals
         WHERE deal_id=$1`,
        [dealId]
      );
      if (!r.rowCount) throw new Error("deal not found");
      return r.rows[0] as { state: DealState; deadline: string; threshold_units: number };
    });

    if (deal.state !== "PendingTarget") return;

    const total = await withTx(async (c) => sumJoinedUnits(c, dealId));
    if (total >= Number(deal.threshold_units)) return;

    await atomicTransition({
      entityType: "deal",
      entityId: dealId,
      dealId,
      stateType: "deal_state",
      fromState: "PendingTarget",
      toState: "Failed",
      actionName: "deal.deadline_check",
      requestId: `worker:${eventId}`,
      idempotencyKey: `deadline:${dealId}`,
      outbox: null,
      payload: { total, threshold: Number(deal.threshold_units) }
    });

    await failAllParticipantsForDeal(dealId, `worker:${eventId}`);
    await cleanupObsoleteDealOutboxEvents(dealId);
    return;
  }

  if (event.event_type === "charge_deal") {
    await handleChargeDealEvent(event, eventId, app);
    return;
  }

  if (event.event_type === "recovery_deal") {
    await handleRecoveryDealEvent(event, eventId);
    return;
  }

  if (event.event_type === "finalize_deal") {
    await handleFinalizeDealEvent(event, eventId);
    return;
  }

  if (event.event_type === "refund_issue" || event.event_type === "cancel_refund") {
    await handleRefundEvent(event, eventId);
    return;
  }
}
const WORKER_EVENT_TIMEOUT_MS = 30_000;

async function workerLoop(app: ReturnType<typeof Fastify>) {
  while (true) {
    try {
      const batch = await claimOutboxBatch(10);
      if (batch.length === 0) {
        await new Promise((r) => setTimeout(r, OUTBOX_POLL_MS));
        continue;
      }

      for (const ev of batch) {
        try {
          await Promise.race([
            (async () => {
              await workerProcessEvent(ev);
              await markOutboxSent(ev.event_uuid);
            })(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`worker event ${ev.event_uuid} timed out after ${WORKER_EVENT_TIMEOUT_MS}ms`)),
                WORKER_EVENT_TIMEOUT_MS
              )
            )
          ]);
        } catch (e) {
          app.log.error({ err: e, event_uuid: ev.event_uuid }, "workerLoop: event processing failed");
          await markOutboxFailed(ev.event_uuid, Number(ev.attempt_count || 0), e).catch((markErr) => {
            app.log.error({ err: markErr }, "workerLoop: failed to mark event as failed");
          });
        }
      }
    } catch (e) {
      app.log.error({ err: e }, "workerLoop: batch-level error, retrying in 5s");
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (!workerRunning) return;
  }
}

const app = Fastify({ logger: true });
export { app };

// ---------------------------------------------------------------------------
// In-memory rate limiter
// Configurable via RATE_LIMIT_MAX (requests per window) and
// RATE_LIMIT_WINDOW_MS (window duration in ms). Off when RATE_LIMIT_MAX=0.
// Uses a fixed-window counter keyed by IP address.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 200);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);

type RateLimitEntry = { count: number; resetAt: number };
const rateLimitStore = new Map<string, RateLimitEntry>();

// Purge expired entries every 5 minutes to prevent unbounded memory growth
const rateLimitPurge = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) rateLimitStore.delete(key);
  }
}, 5 * 60_000);
rateLimitPurge.unref();

if (RATE_LIMIT_MAX > 0) {
  app.addHook("onRequest", async (req, reply) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const existing = rateLimitStore.get(ip);

    if (!existing || existing.resetAt <= now) {
      rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      existing.count += 1;
      if (existing.count > RATE_LIMIT_MAX) {
        const retryAfterSecs = Math.ceil((existing.resetAt - now) / 1000);
        void reply
          .code(429)
          .header("Retry-After", String(retryAfterSecs))
          .send({ ok: false, error: "rate_limit_exceeded", retry_after: retryAfterSecs });
      }
    }
  });
}

app.setErrorHandler((error: any, _req, reply) => {
  const statusCode = Number(error.statusCode || error.status || 0);
  const code = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  if (code >= 500) {
    app.log.error({ err: error }, "unhandled route error");
  }
  return reply.code(code).send({ ok: false, error: error.message || "internal_error" });
});

app.get("/health", async () => ({ ok: true }));

app.post("/deals", async (req: any) => {
  const body = req.body || {};
  const title = String(body.title || "").trim();
  if (!title) {
    const err: any = new Error("title is required");
    err.statusCode = 400;
    throw err;
  }
  if (title.length > 200) {
    const err: any = new Error("title must be 200 characters or fewer");
    err.statusCode = 400;
    throw err;
  }
  const priceRaw = Number(body.price_per_unit);
  if (!Number.isFinite(priceRaw) || priceRaw <= 0) {
    const err: any = new Error("price_per_unit must be a positive number");
    err.statusCode = 400;
    throw err;
  }
  const requestedMinUnitsRaw = body.min_units ?? body.threshold_units ?? 10;
  const minUnits = Math.max(1, Number(requestedMinUnitsRaw || 10));
  const requestedMaxUnitsRaw = body.max_units ?? Math.max(minUnits, 20);
  const maxUnits = Math.max(minUnits, Number(requestedMaxUnitsRaw || 20));
  const draftThreshold = Math.ceil(0.9 * minUnits);

  const r = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO siton.deals
       (title, price_per_unit, min_units, max_units, threshold_units, deadline, commission_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING deal_id, state`,
      [
        title,
        priceRaw,
        minUnits,
        maxUnits,
        draftThreshold,
        body.deadline ? new Date(body.deadline).toISOString() : nowPlusMinutes(60).toISOString(),
        Number(body.commission_rate || 0)
      ]
    );
    return ins.rows[0];
  });
  return r;
});

app.post("/deals/:id/publish", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `publish:${dealId}`;

  return atomicTransition({
    entityType: "deal",
    entityId: dealId,
    dealId,
    stateType: "deal_state",
    fromState: "Draft",
    toState: "PendingTarget",
    actionName: "deal.publish",
    requestId,
    idempotencyKey: idem,
    outbox: {
      event_type: "deadline_check",
      aggregate_type: "deal",
      aggregate_id: dealId,
      payload: { deal_id: dealId }
    },
    insideTx: async (c) => {
      const r = await c.query(`SELECT min_units, deadline FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
      if (!r.rowCount) throw new Error("deal not found");
      const minUnits = Number(r.rows[0].min_units);
      const threshold = Math.ceil(0.9 * minUnits);

      await c.query(`UPDATE siton.deals SET threshold_units=$1, published_at=now() WHERE deal_id=$2`, [
        threshold,
        dealId
      ]);
    }
  });
});

async function tryTargetReached(dealId: string, requestId: string) {
  try {
    await atomicTransition({
      entityType: "deal",
      entityId: dealId,
      dealId,
      stateType: "deal_state",
      fromState: "PendingTarget",
      toState: "TargetReached",
      actionName: "deal.target_reached",
      requestId,
      idempotencyKey: `target-reached:${dealId}`,
      outbox: null,
      payload: {}
    });
  } catch (e: any) {
    const msg = String(e?.message || e || "");
    if (msg.includes("State mismatch deal")) return;
    throw e;
  }
}

app.post("/deals/:id/join", async (req: any, reply: any) => {
  const dealId = String(req.params.id);
  const body = req.body || {};
  const buyer_id = String(body.buyer_id || "");
  const qtyRaw = Number(body.qty ?? 1);

  if (!buyer_id) {
    const err: any = new Error("buyer_id required");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(qtyRaw) || qtyRaw < 1) {
    const err: any = new Error("qty must be a positive integer");
    err.statusCode = 400;
    throw err;
  }
  const qty = qtyRaw;

  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `join:${dealId}:${buyer_id}`;

  const participant = await withTx(async (c) => {
    // Lock the deal row to prevent concurrent over-booking
    const dealRow = await c.query(
      `SELECT deal_id, state, max_units FROM siton.deals WHERE deal_id=$1 FOR UPDATE`,
      [dealId]
    );
    if (!dealRow.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    const dealState = String(dealRow.rows[0].state) as DealState;
    const maxUnits = Number(dealRow.rows[0].max_units);

    if (!["PendingTarget", "TargetReached"].includes(dealState)) {
      const err: any = new Error("deal is not open for joining");
      err.statusCode = 409;
      throw err;
    }

    // How many units are held by other buyers (excluding this buyer's existing reservation,
    // and excluding released participants who no longer hold inventory)
    const otherUnitsRow = await c.query(
      `SELECT COALESCE(SUM(qty), 0) AS total
       FROM siton.participants
       WHERE deal_id=$1 AND buyer_id != $2
         AND buyer_state NOT IN ('DealFailed','Dropped')`,
      [dealId, buyer_id]
    );
    const occupiedByOthers = Number(otherUnitsRow.rows[0].total);
    const availableForThisBuyer = maxUnits - occupiedByOthers;

    if (qty > availableForThisBuyer) {
      const err: any = new Error(
        `requested quantity (${qty}) exceeds available inventory (${Math.max(0, availableForThisBuyer)})`
      );
      err.statusCode = 409;
      throw err;
    }

    const ins = await c.query(
      `INSERT INTO siton.participants(deal_id, buyer_id, qty, buyer_state, money_state)
       VALUES ($1,$2,$3,'NotJoined','NoFinancial')
       ON CONFLICT (deal_id, buyer_id) DO UPDATE SET qty=EXCLUDED.qty
       RETURNING participant_id, buyer_state, money_state`,
      [dealId, buyer_id, qty]
    );
    return ins.rows[0] as { participant_id: string; buyer_state: BuyerState; money_state: MoneyState };
  });

  if (participant.buyer_state === "NotJoined") {
    await atomicMultiTransition({
      actionName: "participant.join_authorize",
      requestId,
      idempotency: { entityType: "participant", entityId: participant.participant_id, idempotencyKey: idem },
      ops: [
        { entityType: "participant", entityId: participant.participant_id, dealId, stateType: "buyer_state", fromState: "NotJoined", toState: "JoinedAuthorized", payload: { authorization: "mock_success" } },
        { entityType: "participant", entityId: participant.participant_id, dealId, stateType: "money_state", fromState: "NoFinancial", toState: "AuthHeld", payload: { authorization: "mock_success" } }
      ],
      outbox: null
    });
  }

  const targetAttempt = await withTx(async (c) => {
    const d = await c.query(`SELECT state, threshold_units FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!d.rowCount) throw new Error("deal not found");
    const state = d.rows[0].state as DealState;
    const threshold = Number(d.rows[0].threshold_units);
    const total = await sumJoinedUnits(c, dealId);
    return { state, threshold, total };
  });

  if (targetAttempt.state === "PendingTarget" && targetAttempt.total >= targetAttempt.threshold) {
    await tryTargetReached(dealId, requestId);
  }

  return { ok: true, participant_id: participant.participant_id };
});

app.post("/deals/:id/close_joining", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `close:${dealId}`;

  return atomicTransition({
    entityType: "deal",
    entityId: dealId,
    dealId,
    stateType: "deal_state",
    fromState: "TargetReached",
    toState: "ClosedForJoining",
    actionName: "deal.close_joining",
    requestId,
    idempotencyKey: idem,
    outbox: null,
    payload: {}
  });
});

app.post("/deals/:id/prepare_charging", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `prepare:${dealId}`;

  return atomicMultiTransition({
    actionName: "deal.prepare_charging",
    requestId,
    idempotency: { entityType: "deal", entityId: dealId, idempotencyKey: idem },
    outbox: null,
    buildOpsInTx: async (c) => {
      const deal = await c.query(`SELECT state FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
      if (!deal.rowCount) throw new Error("deal not found");
      const state = deal.rows[0].state as DealState;

      const ops: TransitionOp[] = [];
      if (state === "ClosedForJoining") {
        ops.push({ entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", fromState: "ClosedForJoining", toState: "ReadyForCharging" });
      }

      const parts = await c.query(
        `SELECT participant_id, buyer_state, money_state
         FROM siton.participants
         WHERE deal_id=$1
         FOR UPDATE`,
        [dealId]
      );

      for (const p of parts.rows as Array<{ participant_id: string; buyer_state: BuyerState; money_state: MoneyState }>) {
        if (p.buyer_state === "JoinedAuthorized") {
          ops.push({ entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "JoinedAuthorized", toState: "LockedIn" });
        }
        if (p.money_state === "AuthHeld") {
          ops.push({ entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "AuthHeld", toState: "AuthLocked" });
        }
      }

      return ops;
    }
  });
});

app.post("/deals/:id/charging/start", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `start:${dealId}`;

  return atomicMultiTransition({
    actionName: "charging.start",
    requestId,
    idempotency: { entityType: "deal", entityId: dealId, idempotencyKey: idem },
    outbox: { event_type: "charge_deal", aggregate_type: "deal", aggregate_id: dealId, payload: { deal_id: dealId } },
    buildOpsInTx: async (c) => {
      const deal = await c.query(`SELECT state FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
      if (!deal.rowCount) throw new Error("deal not found");
      const state = deal.rows[0].state as DealState;

      const ops: TransitionOp[] = [];
      if (state === "ReadyForCharging") {
        ops.push({ entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", fromState: "ReadyForCharging", toState: "Charging" });
      }

      const parts = await c.query(
        `SELECT participant_id, buyer_state, money_state
         FROM siton.participants
         WHERE deal_id=$1
         FOR UPDATE`,
        [dealId]
      );

      for (const p of parts.rows as Array<{ participant_id: string; buyer_state: BuyerState; money_state: MoneyState }>) {
        if (p.buyer_state === "LockedIn") {
          ops.push({ entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "LockedIn", toState: "ChargingAttempt" });
        }
        if (p.money_state === "AuthLocked") {
          ops.push({ entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "AuthLocked", toState: "ChargeAttempt" });
        }
      }

      return ops;
    }
  });
});

app.post("/deals/:id/cancel", async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `cancel:${dealId}`;

  return atomicTransition({
    entityType: "deal",
    entityId: dealId,
    dealId,
    stateType: "deal_state",
    fromState: "Draft",
    toState: "Cancelled",
    actionName: "deal.cancel",
    requestId,
    idempotencyKey: idem,
    outbox: { event_type: "cancel_refund", aggregate_type: "deal", aggregate_id: dealId, payload: { deal_id: dealId } }
  });
});

app.get("/debug/deals/:id", async (req: any) => {
  if (!debugSurfacesActive()) {
    const err: any = new Error("Not found");
    err.statusCode = 404;
    throw err;
  }
  if (!debugSurfaceAuthorized(req)) {
    const err: any = new Error("debug access denied");
    err.statusCode = 403;
    throw err;
  }
  const dealId = String(req.params.id);
  const data = await withTx(async (c) => {
    const deal = await c.query(`SELECT * FROM siton.deals WHERE deal_id=$1`, [dealId]);
    const parts = await c.query(
      `SELECT participant_id, buyer_id, qty, buyer_state, money_state, created_at
       FROM siton.participants
       WHERE deal_id=$1
       ORDER BY created_at ASC`,
      [dealId]
    );
    const outbox = await c.query(
      `SELECT event_uuid, event_type, status, attempt_count, available_at, last_error
       FROM siton.outbox_events
       WHERE aggregate_id=$1
       ORDER BY created_at ASC`,
      [dealId]
    );
    const dlq = await c.query(
      `SELECT event_uuid, event_type, status, attempt_count, available_at, last_error
       FROM siton.outbox_dlq
       WHERE aggregate_id=$1
       ORDER BY created_at ASC`,
      [dealId]
    );
    const attempts = await c.query(
      `SELECT attempt_id, participant_id, attempt_type, result_class, correlation_id, created_at
       FROM siton.payment_attempts
       WHERE deal_id=$1
       ORDER BY created_at ASC`,
      [dealId]
    );
    return { deal: deal.rows[0] || null, participants: parts.rows, outbox: outbox.rows, dlq: dlq.rows, payment_attempts: attempts.rows };
  });
  return data;
});

let workerRunning = false;

(async () => {
  workerRunning = true;
  workerLoop(app).catch((e) => app.log.error(e));

  await app.listen({ port: PORT, host: HOST });

  /*
    TODO Phase 2
    1 cleanup outbox old rows: delete sent after X days, move failed after X to dlq
    2 refund_issue per participant outbox for isolation
  */
})();

async function gracefulShutdown(signal: string) {
  app.log.info({ signal }, "graceful shutdown initiated");
  workerRunning = false;
  // Hard-kill after 30s if clean shutdown hangs
  const forceExit = setTimeout(() => {
    app.log.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 30_000);
  forceExit.unref();
  try {
    await app.close();
  } catch (e) {
    app.log.error({ err: e }, "error closing fastify");
  }
  try {
    await pool.end();
  } catch (e) {
    app.log.error({ err: e }, "error closing pool");
  }
  clearTimeout(forceExit);
  process.exit(0);
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));








