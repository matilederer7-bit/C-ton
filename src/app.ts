import Fastify from "fastify";
import { createHash } from "crypto";
import { pathToFileURL } from "url";
import { buildOutboxWorkerHelpers } from "./outbox_worker_helpers.js";
import { buildPaymentAttemptHelpers } from "./payment_attempt_helpers.js";
import { buildPaymentProvider, getPaymentProviderSummary, type PaymentResultClass } from "./payment_provider.js";
import { buildWebhookIngestion } from "./webhook_ingestion.js";
import { buildNotificationService, getNotificationServiceSummary } from "./notification_service.js";
import { buildPaymentReconciliation } from "./payment_reconciliation.js";
import { registerFrontendExperience } from "./frontend_runtime.js";
import { pool } from "./db.js";
import {
  COMPLETION_WINDOW_MINUTES,
  DEBUG_JOIN_LOGGING,
  HOST,
  LOG_LEVEL,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_POLL_MS,
  PAYMENT_WEBHOOK_PROVIDER,
  PAYMENT_WEBHOOK_SECRET,
  PORT
} from "./runtime_config.js";

type PoolClient = any;

function stableStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((x) => stableStringify(x)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function payloadHash(value: any): string {
  return createHash("sha256").update(stableStringify(value ?? {})).digest("hex");
}

function joinDebug(message: string, payload: Record<string, unknown>) {
  if (!DEBUG_JOIN_LOGGING) return;
  console.log(message, payload);
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
  reclaimStuckProcessing,
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
  requestPayload?: any;
}): Promise<{ response: any; replay: boolean }> {
  const response = args.response ?? { ok: true };

  return withTx(async (c) => {
    const requestHash = payloadHash(args.requestPayload ?? {});
    const idem = await c.query(
      `SELECT response_jsonb, request_hash
       FROM siton.idempotency_log
       WHERE entity_type=$1 AND entity_id=$2 AND action_name=$3 AND idempotency_key=$4`,
      [args.idempotency.entityType, args.idempotency.entityId, args.actionName, args.idempotency.idempotencyKey]
    );

    if (idem.rowCount) {
      const existingHash = idem.rows[0]?.request_hash ?? null;
      if (existingHash && existingHash !== requestHash) {
        const err: any = new Error("Key exists with different content");
        err.statusCode = 400;
        throw err;
      }
      if (idem.rows[0]?.response_jsonb) {
        return { response: idem.rows[0].response_jsonb, replay: true };
      }
    }

    const ops = args.ops ? args.ops : args.buildOpsInTx ? await args.buildOpsInTx(c) : [];
    if (ops.length === 0 && !args.insideTx && !args.outbox) {
      await c.query(
        `INSERT INTO siton.idempotency_log
         (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb)
         VALUES ($1,$2,$3,$4,$5,'OK',$6)`,
        [
          args.idempotency.entityType,
          args.idempotency.entityId,
          args.actionName,
          args.idempotency.idempotencyKey,
          requestHash,
          JSON.stringify(response)
        ]
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
       (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb)
       VALUES ($1,$2,$3,$4,$5,'OK',$6)`,
      [
        args.idempotency.entityType,
        args.idempotency.entityId,
        args.actionName,
        args.idempotency.idempotencyKey,
        requestHash,
        JSON.stringify(response)
      ]
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

async function sumJoinedUnits(c: PoolClient, dealId: string): Promise<number> {
  const r = await c.query(
    `SELECT COALESCE(SUM(qty),0) AS total
     FROM siton.participants
     WHERE deal_id=$1`,
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
      `SELECT participant_id, buyer_state, money_state
       FROM siton.participants
       WHERE deal_id=$1`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string; buyer_state: BuyerState; money_state: MoneyState }>;
  });

  for (const p of participants) {
    if (p.buyer_state === "DealFailed" || p.buyer_state === "DealCompleted") continue;
    if (!BUYER_TRANSITIONS[p.buyer_state]?.includes("DealFailed")) continue;

    const ops: TransitionOp[] = [
      {
        entityType: "participant",
        entityId: p.participant_id,
        dealId,
        stateType: "buyer_state",
        fromState: p.buyer_state,
        toState: "DealFailed"
      }
    ];

    if (p.money_state === "AuthHeld" || p.money_state === "AuthLocked") {
      ops.push({
        entityType: "participant",
        entityId: p.participant_id,
        dealId,
        stateType: "money_state",
        fromState: p.money_state,
        toState: "AuthReleased"
      });
    }

    await atomicMultiTransition({
      actionName: "deal.fail_participant",
      requestId,
      idempotency: {
        entityType: "participant",
        entityId: p.participant_id,
        idempotencyKey: `p-dealfailed:${dealId}:${p.participant_id}`
      },
      ops,
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

    const result = await paymentProvider.refund(correlation);

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: event.event_type === "cancel_refund" ? "cancel_refund" : "refund",
      correlation_id: correlation,
      result_class: result.result_class
    });

    if (result.result_class === "temporary_fail") {
      throw new Error(`temporary_fail refund participant ${p.participant_id}`);
    }

    if (result.result_class === "success") {
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
        payload: { result: result.result_class, provider: result.provider }
      });
      await notificationService.notify("deal_failed", {
        deal_id: dealId,
        participant_id: p.participant_id,
        detail: { refund_result: result.result_class, provider: result.provider }
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

  const dealState = await withTx(async (c) => {
    const r = await c.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) throw new Error("deal not found");
    return r.rows[0].state as DealState;
  });

  // Ignore late duplicate charge events once the deal has already moved on.
  if (dealState !== "Charging") return;

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

    const result = await paymentProvider.capture(correlation);

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      result_class: result.result_class
    });

    if (result.result_class === "temporary_fail") {
      throw new Error(`temporary_fail capture participant ${p.participant_id}`);
    }

    if (result.result_class === "success") {
      await atomicMultiTransition({
        actionName: "charging.capture_success",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `capture-success:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeAttempt", toState: "ChargedSuccess", payload: { result: result.result_class, provider: result.provider } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargingAttempt", toState: "ChargedSuccess", payload: { result: result.result_class, provider: result.provider } }
        ],
        outbox: null
      });
      await notificationService.notify("payment_capture_succeeded", {
        deal_id: dealId,
        participant_id: p.participant_id,
        detail: { provider: result.provider }
      });
    } else {
      await atomicMultiTransition({
        actionName: "charging.capture_failed",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `capture-fail:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeAttempt", toState: "ChargeFailedRecovery", payload: { result: result.result_class, provider: result.provider } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargingAttempt", toState: "ChargeFailedCompletion", payload: { result: result.result_class, provider: result.provider } }
        ],
        outbox: null
      });
      await notificationService.notify("payment_capture_failed", {
        deal_id: dealId,
        participant_id: p.participant_id,
        detail: { provider: result.provider, failure_class: result.result_class }
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

    const result = await paymentProvider.recover(correlation, withinWindow);

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      result_class: result.result_class
    });

    if (result.result_class === "temporary_fail") {
      throw new Error(`temporary_fail recovery participant ${p.participant_id}`);
    }

    if (result.result_class === "success") {
      await atomicMultiTransition({
        actionName: "charging.recovery_success",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `recovery-success:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeFailedRecovery", toState: "RecoveredCharge", payload: { result: result.result_class, provider: result.provider } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargeFailedCompletion", toState: "Recovered", payload: { result: result.result_class, provider: result.provider } }
        ],
        outbox: null
      });
      await notificationService.notify("payment_recovery_succeeded", {
        deal_id: dealId,
        participant_id: p.participant_id,
        detail: { provider: result.provider }
      });
    } else {
      await atomicMultiTransition({
        actionName: "charging.recovery_failed",
        requestId: `worker:${eventId}`,
        idempotency: { entityType: "participant", entityId: p.participant_id, idempotencyKey: `recovery-fail:${eventId}:${p.participant_id}` },
        ops: [
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "money_state", fromState: "ChargeFailedRecovery", toState: "AuthReleased", payload: { result: result.result_class, provider: result.provider } },
          { entityType: "participant", entityId: p.participant_id, dealId, stateType: "buyer_state", fromState: "ChargeFailedCompletion", toState: "Dropped", payload: { result: result.result_class, provider: result.provider } }
        ],
        outbox: null
      });
      await notificationService.notify("payment_recovery_failed", {
        deal_id: dealId,
        participant_id: p.participant_id,
        detail: { provider: result.provider, failure_class: result.result_class }
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
      `SELECT state, min_units, threshold_units, completion_window_until, (now() >= completion_window_until) AS can_finalize
       FROM siton.deals
       WHERE deal_id=$1`,
      [dealId]
    );
    if (!r.rowCount) throw new Error("deal not found");
    return r.rows[0] as { state: DealState; min_units: number; threshold_units: number; completion_window_until: string | null; can_finalize: boolean };
  });

  if (dealRow.state !== "CompletionWindow") return;
  if (!dealRow.completion_window_until) return;
  if (!dealRow.can_finalize) {
    throw new DeferredEventError("finalize_not_ready_yet", new Date(dealRow.completion_window_until));
  }

  const decision = await withTx(async (c) => {
    const captured = await sumCapturedUnits(c, dealId);
    const captureThreshold = Math.ceil(0.9 * Number(dealRow.min_units));
    return { captured, threshold: captureThreshold };
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

    await notificationService.notify("deal_completed", {
      deal_id: dealId,
      detail: { captured_units: decision.captured, threshold: decision.threshold }
    });
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
  await notificationService.notify("deal_failed", {
    deal_id: dealId,
    detail: { captured_units: decision.captured, threshold: decision.threshold }
  });
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
    await notificationService.notify("deal_failed", {
      deal_id: dealId,
      detail: { total_joined_units: total, threshold: Number(deal.threshold_units), reason: "deadline_check" }
    });
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
async function workerLoop(app: ReturnType<typeof Fastify>) {
  while (true) {
    await reclaimStuckProcessing(30_000);
    const batch = await claimOutboxBatch(10);
    if (batch.length === 0) {
      await new Promise((r) => setTimeout(r, OUTBOX_POLL_MS));
      continue;
    }

    for (const ev of batch) {
      try {
        await workerProcessEvent(ev);
        await markOutboxSent(ev.event_uuid);
      } catch (e) {
        app.log.error(e);
        await markOutboxFailed(ev.event_uuid, Number(ev.attempt_count || 0), e);
      }
    }
  }
}

export const app = Fastify({ logger: { level: LOG_LEVEL } });
const paymentProvider = buildPaymentProvider();
const notificationService = buildNotificationService();
const { ensureStorage: ensureWebhookStorage, ingestEvent, markEvent } = buildWebhookIngestion({ withTx });
const { resolveTarget: resolveWebhookTarget, classifyEvent: classifyWebhookEvent } = buildPaymentReconciliation({ withTx });

async function reconcilePaymentWebhookEvent(args: {
  eventId: string;
  eventType: string;
  correlationId?: string | null;
  participantId?: string | null;
  dealId?: string | null;
  providerReference?: string | null;
  payload: Record<string, unknown>;
}) {
  const target = await resolveWebhookTarget({
    event_id: args.eventId,
    event_type: args.eventType,
    correlation_id: args.correlationId ?? null,
    participant_id: args.participantId ?? null,
    deal_id: args.dealId ?? null,
    provider_reference: args.providerReference ?? null,
    payload: args.payload
  });

  const resolution = classifyWebhookEvent(args.eventType, target);
  if (args.eventType === "payment_authorized" || args.eventType === "payment_failed") {
    return {
      status: "processed" as const,
      reason: "authorization_event_recorded",
      participant_id: target?.participant_id ?? null,
      deal_id: target?.deal_id ?? args.dealId ?? null
    };
  }

  if (resolution.status !== "processed") {
    return {
      status: resolution.status,
      reason: resolution.reason,
      participant_id: target?.participant_id ?? null,
      deal_id: target?.deal_id ?? args.dealId ?? null
    };
  }

  if (!target) {
    return {
      status: "failed" as const,
      reason: "missing_correlation_target",
      participant_id: null,
      deal_id: args.dealId ?? null
    };
  }

  const correlationId = args.correlationId ?? target.correlation_id ?? `${args.eventType}:${target.participant_id}`;

  if (args.eventType === "charge_captured") {
    await finalizeAttemptResult({
      participant_id: target.participant_id,
      deal_id: target.deal_id,
      attempt_type: "charge_start",
      correlation_id: correlationId,
      result_class: "success"
    });

    await atomicMultiTransition({
      actionName: "webhook.charge_captured",
      requestId: `webhook:${args.eventId}`,
      idempotency: {
        entityType: "participant",
        entityId: target.participant_id,
        idempotencyKey: `webhook-charge-captured:${args.eventId}:${target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "money_state",
          fromState: "ChargeAttempt",
          toState: "ChargedSuccess",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        },
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargingAttempt",
          toState: "ChargedSuccess",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        }
      ],
      outbox: null
    });

    await notificationService.notify("payment_capture_succeeded", {
      deal_id: target.deal_id,
      participant_id: target.participant_id,
      detail: { source: "webhook", provider_reference: args.providerReference ?? null }
    });

    return { status: "processed" as const, reason: resolution.reason, participant_id: target.participant_id, deal_id: target.deal_id };
  }

  if (args.eventType === "charge_failed") {
    await finalizeAttemptResult({
      participant_id: target.participant_id,
      deal_id: target.deal_id,
      attempt_type: "charge_start",
      correlation_id: correlationId,
      result_class: "permanent_fail"
    });

    await atomicMultiTransition({
      actionName: "webhook.charge_failed",
      requestId: `webhook:${args.eventId}`,
      idempotency: {
        entityType: "participant",
        entityId: target.participant_id,
        idempotencyKey: `webhook-charge-failed:${args.eventId}:${target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "money_state",
          fromState: "ChargeAttempt",
          toState: "ChargeFailedRecovery",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        },
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargingAttempt",
          toState: "ChargeFailedCompletion",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        }
      ],
      outbox: null
    });

    await notificationService.notify("payment_capture_failed", {
      deal_id: target.deal_id,
      participant_id: target.participant_id,
      detail: { source: "webhook", provider_reference: args.providerReference ?? null }
    });

    return { status: "processed" as const, reason: resolution.reason, participant_id: target.participant_id, deal_id: target.deal_id };
  }

  if (args.eventType === "recovery_captured") {
    await finalizeAttemptResult({
      participant_id: target.participant_id,
      deal_id: target.deal_id,
      attempt_type: "recovery",
      correlation_id: correlationId,
      result_class: "success"
    });

    await atomicMultiTransition({
      actionName: "webhook.recovery_captured",
      requestId: `webhook:${args.eventId}`,
      idempotency: {
        entityType: "participant",
        entityId: target.participant_id,
        idempotencyKey: `webhook-recovery-captured:${args.eventId}:${target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "money_state",
          fromState: "ChargeFailedRecovery",
          toState: "RecoveredCharge",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        },
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargeFailedCompletion",
          toState: "Recovered",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        }
      ],
      outbox: null
    });

    await notificationService.notify("payment_recovery_succeeded", {
      deal_id: target.deal_id,
      participant_id: target.participant_id,
      detail: { source: "webhook", provider_reference: args.providerReference ?? null }
    });

    return { status: "processed" as const, reason: resolution.reason, participant_id: target.participant_id, deal_id: target.deal_id };
  }

  if (args.eventType === "recovery_failed") {
    await finalizeAttemptResult({
      participant_id: target.participant_id,
      deal_id: target.deal_id,
      attempt_type: "recovery",
      correlation_id: correlationId,
      result_class: "permanent_fail"
    });

    await atomicMultiTransition({
      actionName: "webhook.recovery_failed",
      requestId: `webhook:${args.eventId}`,
      idempotency: {
        entityType: "participant",
        entityId: target.participant_id,
        idempotencyKey: `webhook-recovery-failed:${args.eventId}:${target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "money_state",
          fromState: "ChargeFailedRecovery",
          toState: "AuthReleased",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        },
        {
          entityType: "participant",
          entityId: target.participant_id,
          dealId: target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargeFailedCompletion",
          toState: "Dropped",
          payload: { provider_reference: args.providerReference ?? null, source: "webhook" }
        }
      ],
      outbox: null
    });

    await notificationService.notify("payment_recovery_failed", {
      deal_id: target.deal_id,
      participant_id: target.participant_id,
      detail: { source: "webhook", provider_reference: args.providerReference ?? null }
    });

    return { status: "processed" as const, reason: resolution.reason, participant_id: target.participant_id, deal_id: target.deal_id };
  }

  return {
    status: "ignored" as const,
    reason: "unsupported_event_type",
    participant_id: target.participant_id,
    deal_id: target.deal_id
  };
}

app.setErrorHandler((error: any, req, reply) => {
  const msg = error instanceof Error ? error.message : String(error || "");
  const statusCode =
    Number(error?.statusCode) ||
    Number(error?.status) ||
    0;

  if (
    msg.includes("State mismatch deal") ||
    msg.includes("State mismatch participant") ||
    msg.includes("Illegal deal_state transition") ||
    msg.includes("Illegal buyer_state transition") ||
    msg.includes("Illegal money_state transition")
  ) {
    return reply.code(409).send({
      ok: false,
      error: "invalid_state_transition",
      message: msg
    });
  }

  if (msg.includes("deal not found")) {
    return reply.code(404).send({
      ok: false,
      error: "deal_not_found",
      message: msg
    });
  }

  if (
    msg.includes("buyer_id required") ||
    msg.includes("Key exists with different content")
  ) {
    return reply.code(400).send({
      ok: false,
      error: "bad_request",
      message: msg
    });
  }

  if (statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({
      ok: false,
      error: "bad_request",
      message: msg || "bad request"
    });
  }

  reply.code(500).send({
    ok: false,
    error: "internal_error",
    message: msg || "internal error"
  });
});

registerFrontendExperience(app, { withTx, paymentProvider });

app.get("/health", async () => ({ ok: true }));

app.get("/health/integrations", async () => {
  await ensureWebhookStorage();
  return {
    ok: true,
    integrations: {
      payment: getPaymentProviderSummary(paymentProvider),
      notifications: getNotificationServiceSummary(notificationService),
      webhook_ingestion: {
        provider: PAYMENT_WEBHOOK_PROVIDER,
        secret_configured: Boolean(PAYMENT_WEBHOOK_SECRET),
        duplicate_policy: "provider+event_id idempotent accept",
        supported_events: [
          "payment_authorized",
          "payment_failed",
          "charge_captured",
          "charge_failed",
          "recovery_captured",
          "recovery_failed"
        ]
      }
    }
  };
});

app.post("/webhooks/payments/mock", async (req: any, reply: any) => {
  const secret = String(req.headers["x-webhook-secret"] || "");
  if (secret !== PAYMENT_WEBHOOK_SECRET) {
    return reply.code(401).send({
      ok: false,
      error: "webhook_unauthorized",
      message: "invalid webhook secret"
    });
  }

  const body = req.body || {};
  const eventId = String(body.event_id || "").trim();
  const eventType = String(body.event_type || "").trim();

  await ensureWebhookStorage();

  if (!eventId || !eventType) {
    return reply.code(400).send({
      ok: false,
      error: "webhook_event_invalid",
      message: "event_id and event_type are required"
    });
  }

  const accepted = await ingestEvent({
    provider: PAYMENT_WEBHOOK_PROVIDER,
    event_id: eventId,
    event_type: eventType,
    payload: typeof body.payload === "object" && body.payload ? body.payload : {},
    deal_id: body.deal_id ? String(body.deal_id) : null,
    participant_id: body.participant_id ? String(body.participant_id) : null
  });

  if (accepted.duplicate) {
    return reply.code(200).send({
      ok: true,
      duplicate: true,
      provider: accepted.provider,
      event_id: accepted.event_id,
      status: accepted.status
    });
  }

  const supportedEventTypes = new Set([
    "payment_authorized",
    "payment_failed",
    "charge_captured",
    "charge_failed",
    "recovery_captured",
    "recovery_failed"
  ]);

  if (!supportedEventTypes.has(eventType)) {
    const stored = await markEvent(PAYMENT_WEBHOOK_PROVIDER, eventId, "ignored");
    return reply.code(202).send({
      ok: true,
      duplicate: false,
      provider: PAYMENT_WEBHOOK_PROVIDER,
      event_id: eventId,
      status: stored?.status ?? "ignored"
    });
  }

  const reconciliation = await reconcilePaymentWebhookEvent({
    eventId,
    eventType,
    correlationId: body.correlation_id ? String(body.correlation_id) : typeof body.payload?.correlation_id === "string" ? body.payload.correlation_id : null,
    participantId: body.participant_id ? String(body.participant_id) : typeof body.payload?.participant_id === "string" ? body.payload.participant_id : null,
    dealId: body.deal_id ? String(body.deal_id) : typeof body.payload?.deal_id === "string" ? body.payload.deal_id : null,
    providerReference: body.provider_reference ? String(body.provider_reference) : typeof body.payload?.provider_reference === "string" ? body.payload.provider_reference : null,
    payload: typeof body.payload === "object" && body.payload ? body.payload : {}
  });

  const finalStatus =
    reconciliation.status === "processed"
      ? "processed"
      : reconciliation.status === "ignored"
        ? "ignored"
        : "failed";

  const stored = await markEvent(PAYMENT_WEBHOOK_PROVIDER, eventId, finalStatus);

  return reply.code(202).send({
    ok: true,
    duplicate: false,
    provider: PAYMENT_WEBHOOK_PROVIDER,
    event_id: eventId,
    status: stored?.status ?? finalStatus,
    reconciliation
  });
});

app.post("/deals", async (req: any) => {
  const body = req.body || {};
  const requestedMinUnitsRaw = body.min_units ?? body.threshold_units ?? 10;
  const minUnits = Math.max(1, Number(requestedMinUnitsRaw || 10));
  const requestedMaxUnitsRaw = body.max_units ?? Math.max(minUnits, 20);
  const maxUnits = Math.max(minUnits, Number(requestedMaxUnitsRaw || 20));
  const draftThreshold = Math.ceil(0.9 * minUnits);

  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${Date.now()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `create:${Date.now()}`;

  const createPayload = {
    title: String(body.title || ""),
    price_per_unit: Number(body.price_per_unit || 10),
    min_units: minUnits,
    max_units: maxUnits,
    threshold_units: draftThreshold,
    deadline: body.deadline ? new Date(body.deadline).toISOString() : nowPlusMinutes(60).toISOString(),
    commission_rate: Number(body.commission_rate || 0)
  };
  const createHashValue = payloadHash(createPayload);

  const response = await withTx(async (c) => {
    const idemExisting = await c.query(
      `SELECT response_jsonb, request_hash
       FROM siton.idempotency_log
       WHERE entity_type='deal'
         AND action_name='deal.create'
         AND idempotency_key=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [idem]
    );

    if (idemExisting.rowCount) {
      const existingHash = idemExisting.rows[0]?.request_hash ?? null;
      if (existingHash && existingHash !== createHashValue) {
        const err: any = new Error("Key exists with different content");
        err.statusCode = 400;
        throw err;
      }
      if (idemExisting.rows[0]?.response_jsonb) {
        return { ...idemExisting.rows[0].response_jsonb, replay: true };
      }
    }

    const ins = await c.query(
      `INSERT INTO siton.deals
       (title, price_per_unit, min_units, max_units, threshold_units, deadline, commission_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING deal_id, state`,
      [
        createPayload.title,
        createPayload.price_per_unit,
        createPayload.min_units,
        createPayload.max_units,
        createPayload.threshold_units,
        createPayload.deadline,
        createPayload.commission_rate
      ]
    );

    const created = ins.rows[0];

    await c.query(
      `INSERT INTO siton.idempotency_log
       (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb)
       VALUES ('deal',$1,'deal.create',$2,$3,'OK',$4)`,
      [created.deal_id, idem, createHashValue, JSON.stringify(created)]
    );

    await c.query(
      `INSERT INTO siton.audit_log
       (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
       VALUES ('deal',$1,$1,'deal_state',NULL,'Draft','deal.create',$2,$3,$4)`,
      [created.deal_id, requestId, idem, JSON.stringify({ title: String(body.title || ""), threshold_units: draftThreshold })]
    );

    return { ...created, replay: false };
  });

  return response;
});

app.post("/deals/:id/publish", async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${Date.now()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `publish:${dealId}`;

  const dealForSchedule = await withTx(async (c) => {
    const r = await c.query(
      `SELECT deadline
       FROM siton.deals
       WHERE deal_id=$1`,
      [dealId]
    );
    if (!r.rowCount) throw new Error("deal not found");
    return r.rows[0] as { deadline: string };
  });

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
      payload: { deal_id: dealId },
      available_at: new Date(dealForSchedule.deadline)
    },
    insideTx: async (c) => {
      const r = await c.query(
        `SELECT min_units
         FROM siton.deals
         WHERE deal_id=$1
         FOR UPDATE`,
        [dealId]
      );
      if (!r.rowCount) throw new Error("deal not found");
      const minUnits = Number(r.rows[0].min_units);
      const threshold = Math.ceil(0.9 * minUnits);

      await c.query(
        `UPDATE siton.deals
         SET threshold_units=$1, published_at=now()
         WHERE deal_id=$2`,
        [threshold, dealId]
      );
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
  const qty = Number(body.qty || 1);

  if (!buyer_id) throw new Error("buyer_id required");
  if (!Number.isInteger(qty) || qty <= 0) {
    const err: any = new Error("qty must be a positive integer");
    err.statusCode = 400;
    throw err;
  }

  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${Date.now()}`;
  const idem = req.headers["idempotency-key"]
    ? String(req.headers["idempotency-key"])
    : `join:${dealId}:${buyer_id}:${requestId}`;

  const joinPayload = { deal_id: dealId, buyer_id, qty };
  joinDebug("[JOIN] start", { dealId, buyer_id, qty, requestId, idem });
  const joinResponse: any = { ok: true, participant_id: null };

  const joinResult = await atomicMultiTransition({
    actionName: "participant.join_authorize",
    requestId,
    requestPayload: joinPayload,
    idempotency: { entityType: "deal", entityId: dealId, idempotencyKey: idem },
    buildOpsInTx: async (c) => {
      const d = await c.query(
        `SELECT state, max_units
         FROM siton.deals
         WHERE deal_id=$1
         FOR UPDATE`,
        [dealId]
      );

      if (!d.rowCount) throw new Error("deal not found");

      const state = d.rows[0].state as DealState;
      const maxUnits = Number(d.rows[0].max_units);
      joinDebug("[JOIN] locked deal", { dealId, state, maxUnits, idem });

      if (state !== "PendingTarget" && state !== "TargetReached") {
        const err: any = new Error(`join not allowed in deal state ${state}`);
        err.statusCode = 409;
        throw err;
      }

      const total = await sumJoinedUnits(c, dealId);
      joinDebug("[JOIN] capacity", { dealId, total, qty, maxUnits, idem });
      if (total + qty > maxUnits) {
        const err: any = new Error(`max_units exceeded: requested ${qty}, available ${Math.max(0, maxUnits - total)}, max ${maxUnits}`);
        err.statusCode = 409;
        throw err;
      }

      const ins = await c.query(
        `INSERT INTO siton.participants(deal_id, buyer_id, qty, buyer_state, money_state)
         VALUES ($1,$2,$3,'NotJoined','NoFinancial')
         RETURNING participant_id`,
        [dealId, buyer_id, qty]
      );

      const participantId = String(ins.rows[0].participant_id);
      joinResponse.participant_id = participantId;
      joinDebug("[JOIN] inserted participant", { dealId, participantId, buyer_id, qty, idem });

      return [
        {
          entityType: "participant",
          entityId: participantId,
          dealId,
          stateType: "buyer_state",
          fromState: "NotJoined",
          toState: "JoinedAuthorized",
          payload: joinPayload
        },
        {
          entityType: "participant",
          entityId: participantId,
          dealId,
          stateType: "money_state",
          fromState: "NoFinancial",
          toState: "AuthHeld",
          payload: joinPayload
        }
      ];
    },
    outbox: null,
    response: joinResponse
  });

  if (joinResult.replay) {
    joinDebug("[JOIN] replay response", { dealId, idem, response: joinResult.response });
    return { ...joinResult.response, replay: true };
  }

  const targetAttempt = await withTx(async (c) => {
    const d = await c.query(
      `SELECT state, threshold_units
       FROM siton.deals
       WHERE deal_id=$1`,
      [dealId]
    );
    if (!d.rowCount) throw new Error("deal not found");
    const state = d.rows[0].state as DealState;
    const threshold = Number(d.rows[0].threshold_units);
    const total = await sumJoinedUnits(c, dealId);
    return { state, threshold, total };
  });

  if (targetAttempt.state === "PendingTarget" && targetAttempt.total >= targetAttempt.threshold) {
    await tryTargetReached(dealId, requestId);
  }

  joinDebug("[JOIN] success response", { dealId, idem, response: joinResult.response });
  return joinResult.response;
});

app.post("/deals/:id/close_joining", async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${Date.now()}`;
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
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${Date.now()}`;
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

      if (state !== "ClosedForJoining") {
        throw new Error(`prepare_charging requires ClosedForJoining, got ${state}`);
      }

      const ops: TransitionOp[] = [
        { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", fromState: "ClosedForJoining", toState: "ReadyForCharging" }
      ];

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
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${Date.now()}`;
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

      if (state !== "ReadyForCharging") {
        throw new Error(`charging.start requires ReadyForCharging, got ${state}`);
      }

      const ops: TransitionOp[] = [
        { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", fromState: "ReadyForCharging", toState: "Charging" }
      ];

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
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${Date.now()}`;
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

export async function startServer() {
  workerLoop(app).catch((e) => app.log.error(e));
  await app.listen({ port: PORT, host: HOST });
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  startServer().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

