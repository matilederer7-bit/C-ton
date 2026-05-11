import Fastify from "fastify";
import pg from "pg"; const { Pool } = pg; type PoolClient = any;
import { createHash, randomUUID } from "crypto";
import dotenv from "dotenv";
import { buildOutboxWorkerHelpers } from "./outbox_worker_helpers.js";
import { buildPaymentAttemptHelpers } from "./payment_attempt_helpers.js";
import { buildPaymentProvider, getPaymentProviderSummary } from "./payment_provider.js";
import { buildNotificationService, getNotificationServiceSummary } from "./notification_service.js";
import {
  enqueueNotification,
  ensureNotificationRailTables,
  flushPendingNotifications,
  type SmsProvider
} from "./notification_dispatch.js";
import {
  enqueueInvoiceDocument,
  enqueuePendingInvoiceDocumentOutboxEvents,
  ensureInvoiceRailTables,
  processInvoiceDocumentById,
  reconcileInvoiceDocumentById,
  buildInvoiceProvider,
  getInvoiceProviderSummary,
  isEligibleForChargeReceipt,
  isEligibleForRefundReceipt,
  reclaimStuckInvoiceDocuments,
  type InvoiceProvider
} from "./invoice_dispatch.js";
import { registerFrontendExperience } from "./frontend_runtime.js";
import { ensureJoinOtpVerified, ensureOtpRailTables, OtpValidationError } from "./otp_rail.js";
import { buildWebhookIngestion } from "./webhook_ingestion.js";
import { buildPaymentReconciliation } from "./payment_reconciliation.js";
import {
  buildPlatformFeeMoney,
  calculatePlatformFeeMoney,
  ensurePlatformFeeMoneyTables
} from "./platform_fee_money.js";
import {
  sellerStatusBlocksAction,
  sellerStatusErrorCode,
  sellerStatusMessage,
  type SellerAction
} from "./seller_enforcement.js";
import {
  PAYMENT_DISCLOSURE_VERSION,
  REFUND_POLICY_VERSION,
  SELLER_TERMS_VERSION,
  TERMS_VERSION,
  type LegalAcceptanceType
} from "./legal_policy_versions.js";
import { ensureRemainingProductSurfaceTables } from "./product_surface_support.js";
import {
  ensureDealTypeTables,
  normalizeDealType,
  upsertVoucherTerms,
  upsertTicketTerms,
  issueFulfillmentUnitsForParticipant,
  decideFulfillmentIssuance,
  type DealType
} from "./deal_types.js";
import {
  deleteDealImageFile,
  getDealImagePublicUrl,
  readDealImage,
  saveDealImage
} from "./product_image_storage.js";
import { buildPayoutProvider } from "./payout_provider.js";
import { buildPayoutRail, ensurePayoutRailTables } from "./payout_rail.js";
import {
  SELLER_SESSION_COOKIE,
  hashSellerSessionToken,
  normalizeSellerDisplayName,
  normalizeSellerId,
  parseCookies
} from "./seller_auth.js";
import { ensureAdminControlPlaneTables, safeHeaderId } from "./admin_control_plane.js";
import { ensureAdminIdentityTables } from "./admin_identity.js";
import { ensureParticipantTrackingTables, issueParticipantTrackingToken } from "./participant_tracking_security.js";
import { ensureAdminInterventionTables, isFlagActive } from "./admin_intervention.js";
dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || "0.0.0.0");
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";

// Per spec (C6): completion window is 24 hours (1440 minutes) — the time buyers have
// to update a failed payment method after Charging → CompletionWindow.
const COMPLETION_WINDOW_MINUTES = Number(process.env.COMPLETION_WINDOW_MINUTES || 1440);
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 1000);
const OUTBOX_MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 4);

// Per spec: deal deadline must be at least 2 hours and at most 7 days in the future.
const DEADLINE_MIN_MS = 2 * 60 * 60 * 1000;
const DEADLINE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// Default deadline when caller does not provide one (sits comfortably inside the 2h–7d window).
const DEADLINE_DEFAULT_MS = 24 * 60 * 60 * 1000;

// Per spec: Siton's platform commission is a fixed 8% — not per-deal configurable.
const DISABLE_OUTBOX_WORKER =
  process.env.DISABLE_OUTBOX_WORKER === "1" ||
  process.env.NODE_ENV === "test" ||
  process.env.npm_lifecycle_event === "test";

const MOCK_SEED = process.env.MOCK_SEED ? Number(process.env.MOCK_SEED) : null;
const DEBUG_SURFACES_HEADER = "x-debug-access-key";
const APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
const IS_DEMO_PREVIEW = APP_DEPLOYMENT_MODE === "demo-preview";

function isAccepted(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === "1";
}

function hashOptional(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex");
}

async function ensureLegalAcceptanceTables(withTxFn: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>) {
  await withTxFn(async (c) => {
    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.legal_acceptances (
        acceptance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('buyer','seller')),
        actor_ref TEXT NOT NULL,
        deal_id UUID NULL,
        participant_id UUID NULL,
        acceptance_type TEXT NOT NULL CHECK (acceptance_type IN (
          'buyer_join_terms',
          'buyer_payment_disclosure',
          'seller_publish_terms'
        )),
        policy_version TEXT NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ip_hash TEXT NULL,
        user_agent_hash TEXT NULL,
        metadata_jsonb JSONB NOT NULL DEFAULT '{}',
        CONSTRAINT ux_legal_acceptances_scope UNIQUE (
          actor_type,
          actor_ref,
          deal_id,
          participant_id,
          acceptance_type,
          policy_version
        )
      )`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_legal_acceptances_deal ON siton.legal_acceptances (deal_id, accepted_at)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_legal_acceptances_actor ON siton.legal_acceptances (actor_type, actor_ref, accepted_at)`);
  });
}

async function recordLegalAcceptance(args: {
  c: PoolClient;
  req: any;
  actorType: "buyer" | "seller";
  actorRef: string;
  dealId?: string | null;
  participantId?: string | null;
  acceptanceType: LegalAcceptanceType;
  policyVersion: string;
  metadata?: Record<string, unknown>;
}) {
  await args.c.query(
    `INSERT INTO siton.legal_acceptances
       (actor_type, actor_ref, deal_id, participant_id, acceptance_type, policy_version,
        ip_hash, user_agent_hash, metadata_jsonb)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (actor_type, actor_ref, deal_id, participant_id, acceptance_type, policy_version)
     DO NOTHING`,
    [
      args.actorType,
      args.actorRef,
      args.dealId || null,
      args.participantId || null,
      args.acceptanceType,
      args.policyVersion,
      null,
      hashOptional(args.req?.headers?.["user-agent"]),
      JSON.stringify(args.metadata || {})
    ]
  );
}
const SELLER_SESSION_SECRET = String(process.env.SELLER_SESSION_SECRET || "").trim();

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

async function sellerSessionContext(req: any, c: any) {
  if (IS_DEMO_PREVIEW || !SELLER_SESSION_SECRET) return null;
  const cookies = parseCookies(req.headers?.cookie);
  const rawToken = String(cookies[SELLER_SESSION_COOKIE] || "").trim();
  const tokenHash = hashSellerSessionToken(rawToken, SELLER_SESSION_SECRET);
  if (!tokenHash) return null;
  const result = await c.query(
    `SELECT s.session_id,
            s.expires_at,
            a.seller_id,
            a.display_name,
            a.auth_enabled,
            COALESCE(a.seller_status, 'Active') AS seller_status
     FROM siton.seller_sessions s
     JOIN siton.seller_accounts a ON a.seller_id = s.seller_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND a.auth_enabled = true
     LIMIT 1`,
    [tokenHash]
  );
  if (!result.rowCount) return null;
  return result.rows[0];
}

function sellerAuthorityFromDemoRequest(req: any) {
  const sellerId = normalizeSellerId(req.body?.seller_id || req.headers?.["x-seller-id"]);
  return {
    seller_id: sellerId,
    display_name: normalizeSellerDisplayName(req.body?.seller_display_name || req.headers?.["x-seller-display-name"], sellerId),
    seller_status: "Active",
    context_source: "demo_context"
  };
}

async function ensureSellerActionAllowed(c: any, sellerId: string, action: SellerAction) {
  const result = await c.query(
    `SELECT COALESCE(seller_status, 'Active') AS seller_status
     FROM siton.seller_accounts
     WHERE seller_id=$1
     LIMIT 1`,
    [sellerId]
  );
  const status = result.rowCount ? String(result.rows[0].seller_status || "Active") : "Active";
  if (!sellerStatusBlocksAction(status, action)) return status;
  const err: any = new Error(sellerStatusMessage(status));
  err.statusCode = 403;
  err.code = sellerStatusErrorCode(status);
  throw err;
}

async function requireSellerAuthority(req: any, c: any) {
  if (IS_DEMO_PREVIEW) {
    return sellerAuthorityFromDemoRequest(req);
  }
  if (!SELLER_SESSION_SECRET) {
    const err: any = new Error("seller auth is not configured for this non-demo runtime");
    err.statusCode = 503;
    err.code = "seller_auth_unavailable";
    throw err;
  }
  const session = await sellerSessionContext(req, c);
  if (!session) {
    const err: any = new Error("seller session is required for this non-demo runtime");
    err.statusCode = 401;
    err.code = "seller_auth_required";
    throw err;
  }
  return {
    seller_id: session.seller_id,
    display_name: session.display_name,
    seller_status: session.seller_status || "Active",
    context_source: "server_session"
  };
}

async function requireSellerAuthorityWithoutBody(req: any, c: any) {
  if (IS_DEMO_PREVIEW) {
    const sellerId = normalizeSellerId(req.headers?.["x-seller-id"]);
    return {
      seller_id: sellerId,
      display_name: normalizeSellerDisplayName(req.headers?.["x-seller-display-name"], sellerId),
      seller_status: "Active",
      context_source: "demo_context"
    };
  }
  return requireSellerAuthority(req, c);
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

// Must stay in lockstep with siton.is_valid_deal_transition in migrations 008/014.
// Cancellation is only permitted from Draft; past publish the deal moves through the
// forward-only lifecycle and can only terminate via Failed or Completed.
export const DEAL_TRANSITIONS: Record<string, string[]> = {
  Draft: ["PendingTarget", "Cancelled"],
  PendingTarget: ["TargetReached", "Failed"],
  TargetReached: ["ClosedForJoining"],
  ClosedForJoining: ["ReadyForCharging"],
  ReadyForCharging: ["Charging"],
  Charging: ["CompletionWindow"],
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
      event_type:
        | "charge_deal"
        | "recovery_deal"
        | "finalize_deal"
        | "refund_issue"
        | "deadline_check"
        | "cancel_refund"
        | "seller_payout_prepare"
        | "seller_payout_dispatch"
        | "seller_payout_reconcile"
        | "invoice_document_issue"
        | "invoice_document_reconcile";
      aggregate_type: "deal" | "participant" | "seller_payout_batch" | "invoice_document";
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

const webhookIngestion = buildWebhookIngestion({ withTx });
const paymentReconciliation = buildPaymentReconciliation({ withTx });
const paymentProvider = buildPaymentProvider();
const payoutProvider = buildPayoutProvider();
const payoutRail = buildPayoutRail({
  withTx,
  payoutProvider,
  PermanentFailErrorCtor: PermanentFailError
});

async function atomicMultiTransition(args: {
  actionName: string;
  requestId: string;
  correlationId?: string;
  idempotency: { entityType: AtomicEntityType; entityId: string; idempotencyKey: string };
  buildOpsInTx?: (c: PoolClient) => Promise<TransitionOp[]>;
  ops?: TransitionOp[];
  outbox: OutboxInsert;
  response?: any;
  insideTx?: (c: PoolClient) => Promise<void>;
}): Promise<{ response: any; replay: boolean }> {
  await ensureAdminControlPlaneTables(withTx);
  await ensureAdminIdentityTables(withTx);
  await ensureParticipantTrackingTables(withTx);
  await ensureAdminInterventionTables(withTx);
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

    const correlationId = args.correlationId || args.requestId;
    for (const op of ops) {
      await c.query(
        `INSERT INTO siton.audit_log
         (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          op.entityType,
          op.entityId,
          op.dealId,
          op.stateType,
          op.fromState,
          op.toState,
          args.actionName,
          args.requestId,
          correlationId,
          args.idempotency.idempotencyKey,
          JSON.stringify(op.payload ?? {})
        ]
      );
    }

    await c.query(`SELECT set_config('siton.audit_written', '1', true)`);

    if (args.outbox) {
      await c.query(
        `INSERT INTO siton.outbox_events
         (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, correlation_id, request_id)
         VALUES ($1,$2,$3,$4,'pending',0,COALESCE($5, now()),$6,$7)`,
        [
          args.outbox.event_type,
          args.outbox.aggregate_type,
          args.outbox.aggregate_id,
          JSON.stringify(args.outbox.payload ?? {}),
          args.outbox.available_at ? args.outbox.available_at.toISOString() : null,
          correlationId,
          args.requestId
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
       (entity_type, entity_id, action_name, idempotency_key, response_code, response_jsonb, correlation_id, request_id)
       VALUES ($1,$2,$3,$4,'OK',$5,$6,$7)`,
      [args.idempotency.entityType, args.idempotency.entityId, args.actionName, args.idempotency.idempotencyKey, JSON.stringify(response), correlationId, args.requestId]
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

function paymentMinorAmount(args: { qty: number; pricePerUnit: number; deliveryCost: number }) {
  const total = Number(args.qty || 0) * Number(args.pricePerUnit || 0) + Number(args.deliveryCost || 0);
  return Math.max(0, Math.round(total * 100));
}

function parsePositiveIntegerQuantity(value: unknown, defaultValue?: number) {
  const raw = value ?? defaultValue;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    const err: any = new Error("qty must be a positive integer");
    err.statusCode = 400;
    err.code = "invalid_qty";
    throw err;
  }
  return raw;
}

function attemptResultClassFromWebhookEvent(eventType: string): PaymentResultClass | null {
  if (eventType === "charge_captured" || eventType === "recovery_captured" || eventType === "refund_issued") {
    return "success";
  }
  if (eventType === "charge_failed" || eventType === "recovery_failed") {
    return "permanent_fail";
  }
  return null;
}

async function finalizeAttemptFromWebhookIfNeeded(args: {
  eventType: string;
  target: {
    participant_id: string;
    deal_id: string;
    attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund";
    correlation_id: string | null;
  };
}) {
  const resultClass = attemptResultClassFromWebhookEvent(args.eventType);
  if (!resultClass || !args.target.correlation_id) return;
  await finalizeAttemptResult({
    participant_id: args.target.participant_id,
    deal_id: args.target.deal_id,
    attempt_type: args.target.attempt_type,
    correlation_id: args.target.correlation_id,
    result_class: resultClass
  });
}

async function applyPaymentWebhookClassification(args: {
  event: {
    provider: string;
    event_id: string;
    event_type: string;
    correlation_id: string | null;
    participant_id: string | null;
    deal_id: string | null;
    provider_reference: string | null;
    payload: Record<string, unknown>;
  };
  target: {
    participant_id: string;
    deal_id: string;
    attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund";
    correlation_id: string | null;
    buyer_state: string;
    money_state: string;
  } | null;
  classification: {
    status: "processed" | "ignored" | "failed";
    reason: string;
  };
}) {
  if (args.classification.status !== "processed" || !args.target) return;

  const requestId = `webhook:${args.event.event_id}`;
  const eventPayload = {
    provider: args.event.provider,
    event_id: args.event.event_id,
    provider_reference: args.event.provider_reference,
    correlation_id: args.event.correlation_id,
    reason: args.classification.reason
  };

  if (args.event.event_type === "charge_captured") {
    await atomicMultiTransition({
      actionName: "charging.capture_success",
      requestId,
      idempotency: {
        entityType: "participant",
        entityId: args.target.participant_id,
        idempotencyKey: `capture-success:${args.event.provider}:${args.event.event_id}:${args.target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "money_state",
          fromState: "ChargeAttempt",
          toState: "ChargedSuccess",
          payload: eventPayload
        },
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargingAttempt",
          toState: "ChargedSuccess",
          payload: eventPayload
        }
      ],
      outbox: null
    });
    await platformFeeMoney.recordProviderFinancialEvent({
      participant_id: args.target.participant_id,
      deal_id: args.target.deal_id,
      event_type: "charge_captured",
      provider_code: args.event.provider,
      provider_event_id: args.event.event_id,
      provider_reference: args.event.provider_reference ?? null,
      correlation_id: args.event.correlation_id ?? args.target.correlation_id ?? null,
      source_money_state: "ChargedSuccess"
    });
    await finalizeAttemptFromWebhookIfNeeded({ eventType: args.event.event_type, target: args.target });
    // Notify buyer: charge succeeded
    await enqueueNotificationForParticipant("charge_succeeded", args.target.participant_id, args.target.deal_id).catch(() => undefined);
    return;
  }

  if (args.event.event_type === "charge_failed") {
    await atomicMultiTransition({
      actionName: "charging.capture_failed",
      requestId,
      idempotency: {
        entityType: "participant",
        entityId: args.target.participant_id,
        idempotencyKey: `capture-fail:${args.event.provider}:${args.event.event_id}:${args.target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "money_state",
          fromState: "ChargeAttempt",
          toState: "ChargeFailedRecovery",
          payload: eventPayload
        },
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargingAttempt",
          toState: "ChargeFailedCompletion",
          payload: eventPayload
        }
      ],
      outbox: null
    });
    await finalizeAttemptFromWebhookIfNeeded({ eventType: args.event.event_type, target: args.target });
    // Notify buyer: charge failed, recovery upcoming
    await enqueueNotificationForParticipant("charge_failed_recovery", args.target.participant_id, args.target.deal_id).catch(() => undefined);
    return;
  }

  if (args.event.event_type === "recovery_captured") {
    await atomicMultiTransition({
      actionName: "charging.recovery_success",
      requestId,
      idempotency: {
        entityType: "participant",
        entityId: args.target.participant_id,
        idempotencyKey: `recovery-success:${args.event.provider}:${args.event.event_id}:${args.target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "money_state",
          fromState: "ChargeFailedRecovery",
          toState: "RecoveredCharge",
          payload: eventPayload
        },
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargeFailedCompletion",
          toState: "Recovered",
          payload: eventPayload
        }
      ],
      outbox: null
    });
    await platformFeeMoney.recordProviderFinancialEvent({
      participant_id: args.target.participant_id,
      deal_id: args.target.deal_id,
      event_type: "recovery_captured",
      provider_code: args.event.provider,
      provider_event_id: args.event.event_id,
      provider_reference: args.event.provider_reference ?? null,
      correlation_id: args.event.correlation_id ?? args.target.correlation_id ?? null,
      source_money_state: "RecoveredCharge"
    });
    await finalizeAttemptFromWebhookIfNeeded({ eventType: args.event.event_type, target: args.target });
    return;
  }

  if (args.event.event_type === "recovery_failed") {
    await atomicMultiTransition({
      actionName: "charging.recovery_failed",
      requestId,
      idempotency: {
        entityType: "participant",
        entityId: args.target.participant_id,
        idempotencyKey: `recovery-fail:${args.event.provider}:${args.event.event_id}:${args.target.participant_id}`
      },
      ops: [
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "money_state",
          fromState: "ChargeFailedRecovery",
          toState: "AuthReleased",
          payload: eventPayload
        },
        {
          entityType: "participant",
          entityId: args.target.participant_id,
          dealId: args.target.deal_id,
          stateType: "buyer_state",
          fromState: "ChargeFailedCompletion",
          toState: "Dropped",
          payload: eventPayload
        }
      ],
      outbox: null
    });
    await finalizeAttemptFromWebhookIfNeeded({ eventType: args.event.event_type, target: args.target });
    return;
  }

  if (args.event.event_type === "refund_issued") {
    // money_state transition: ChargedSuccess or RecoveredCharge → Refunded
    // buyer_state is not transitioned here — refund does not change buyer participation state
    await atomicTransition({
      entityType: "participant",
      entityId: args.target.participant_id,
      dealId: args.target.deal_id,
      stateType: "money_state",
      fromState: args.target.money_state as MoneyState,
      toState: "Refunded",
      actionName: "refund.issue",
      requestId,
      idempotencyKey: `refund-issued:${args.event.provider}:${args.event.event_id}:${args.target.participant_id}`,
      outbox: null,
      payload: eventPayload
    });
    await platformFeeMoney.recordProviderFinancialEvent({
      participant_id: args.target.participant_id,
      deal_id: args.target.deal_id,
      event_type: "refund_issued",
      provider_code: args.event.provider,
      provider_event_id: args.event.event_id,
      provider_reference: args.event.provider_reference ?? null,
      correlation_id: args.event.correlation_id ?? args.target.correlation_id ?? null,
      source_money_state: args.target.money_state
    });
    await finalizeAttemptFromWebhookIfNeeded({ eventType: args.event.event_type, target: args.target });
    // Notify buyer: refund issued
    await enqueueNotificationForParticipant("refund_issued", args.target.participant_id, args.target.deal_id).catch(() => undefined);
    // Issue refund receipt document
    await enqueueRefundReceiptForParticipant(args.target.participant_id, args.target.deal_id).catch(() => undefined);
  }
}

async function ingestAndProcessPaymentEvent(args: {
  provider: string;
  event_id: string;
  event_type: string;
  correlation_id?: string | null;
  participant_id?: string | null;
  deal_id?: string | null;
  provider_reference?: string | null;
  payload: Record<string, unknown>;
}) {
  const ingested = await webhookIngestion.claimEvent({
    provider: args.provider,
    event_id: args.event_id,
    event_type: args.event_type,
    payload: {
      event_type: args.event_type,
      correlation_id: args.correlation_id ?? null,
      provider_reference: args.provider_reference ?? null,
      deal_id: args.deal_id ?? null,
      participant_id: args.participant_id ?? null,
      payload: args.payload ?? {}
    },
    deal_id: args.deal_id ?? null,
    participant_id: args.participant_id ?? null
  });

  if (ingested.duplicate && !ingested.should_process) {
    return {
      duplicate: true,
      status: ingested.status,
      reason: "duplicate_event"
    };
  }

  try {
    const target = await paymentReconciliation.resolveTarget({
      event_id: args.event_id,
      event_type: args.event_type,
      correlation_id: args.correlation_id ?? null,
      participant_id: args.participant_id ?? null,
      deal_id: args.deal_id ?? null,
      provider_reference: args.provider_reference ?? null,
      payload: args.payload
    });
    const classification = paymentReconciliation.classifyEvent(args.event_type, target);

    if (classification.status === "processed") {
      await applyPaymentWebhookClassification({
        event: {
          provider: args.provider,
          event_id: args.event_id,
          event_type: args.event_type,
          correlation_id: args.correlation_id ?? null,
          participant_id: args.participant_id ?? null,
          deal_id: args.deal_id ?? null,
          provider_reference: args.provider_reference ?? null,
          payload: args.payload
        },
        target,
        classification
      });
    }

    await webhookIngestion.markEvent(args.provider, args.event_id, classification.status, classification.reason);
    return {
      duplicate: Boolean(ingested.duplicate),
      status: classification.status,
      reason: classification.reason
    };
  } catch (error) {
    const failureReason = String(error instanceof Error ? error.message : error || "webhook_processing_failed").slice(0, 240);
    await webhookIngestion.markEvent(args.provider, args.event_id, "failed", failureReason);
    throw error;
  }
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

// Issue fulfillment_units for every eligible participant of a Completed deal.
// Called once per deal completion. Idempotent on (deal_id, participant_id, unit_index)
// via the UNIQUE constraint on siton.fulfillment_units. Voucher/ticket plaintext
// codes are minted here but never persisted — only SHA-256 hash + last4.
async function issueFulfillmentForCompletedDeal(dealId: string): Promise<void> {
  await ensureDealTypeTables(withTx);
  const { dealType, eligible } = await withTx(async (c) => {
    const dealRow = await c.query(
      `SELECT deal_type, state FROM siton.deals WHERE deal_id=$1`,
      [dealId]
    );
    if (!dealRow.rowCount) {
      return { dealType: "physical_product" as DealType, eligible: [] as Array<{ participant_id: string; qty: number }> };
    }
    const deal = dealRow.rows[0] as { deal_type: string; state: string };
    if (deal.state !== "Completed") {
      return { dealType: deal.deal_type as DealType, eligible: [] };
    }
    const r = await c.query(
      `SELECT p.participant_id, p.qty
         FROM siton.participants p
        WHERE p.deal_id = $1
          AND p.buyer_state = 'DealCompleted'
          AND p.money_state IN ('ChargedSuccess','RecoveredCharge')`,
      [dealId]
    );
    return {
      dealType: (deal.deal_type as DealType) || "physical_product",
      eligible: r.rows as Array<{ participant_id: string; qty: number }>
    };
  });
  for (const participant of eligible) {
    await withTx(async (c) =>
      issueFulfillmentUnitsForParticipant(c, {
        dealId,
        participantId: participant.participant_id,
        qty: Math.max(1, Number(participant.qty || 1)),
        dealType
      })
    ).catch((error) => {
      console.error("[fulfillment] participant issuance failed", participant.participant_id, error);
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

  const needRefundWithTrace = await withTx(async (c) => {
    const r = await c.query(
      `SELECT
         p.participant_id,
         p.buyer_id,
         p.qty,
         p.delivery_cost,
         p.money_state,
         d.price_per_unit,
         COALESCE(auth.payload->>'authorization_id', '') AS authorization_id,
         COALESCE(cap.payload->>'provider_reference', auth.payload->>'authorization_id', '') AS capture_reference
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       LEFT JOIN LATERAL (
         SELECT payload
         FROM siton.audit_log
         WHERE entity_type = 'participant'
           AND entity_id = p.participant_id
           AND action_name = 'participant.join_authorize'
         ORDER BY created_at DESC
         LIMIT 1
       ) auth ON true
       LEFT JOIN LATERAL (
         SELECT payload
         FROM siton.audit_log
         WHERE entity_type = 'participant'
           AND entity_id = p.participant_id
           AND action_name IN ('charging.capture_success','charging.recovery_success','charging.charge_success','payment.capture_success')
         ORDER BY created_at DESC
         LIMIT 1
       ) cap ON true
       WHERE p.deal_id=$1
         AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
       ORDER BY p.created_at ASC`,
      [dealId]
    );
    return r.rows as Array<{
      participant_id: string;
      buyer_id: string;
      qty: number;
      delivery_cost: number;
      money_state: MoneyState;
      price_per_unit: number;
      authorization_id: string;
      capture_reference: string;
    }>;
  });

  for (const p of needRefundWithTrace) {
    const correlation = `${event.event_type}:refund:${eventId}:${p.participant_id}`;
    const attemptType = event.event_type === "cancel_refund" ? "cancel_refund" : "refund";
    await recordAttemptBeforeIo({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: attemptType,
      correlation_id: correlation
    });

    const refundInput: Parameters<typeof paymentProvider.refund>[0] = {
      amount_minor: paymentMinorAmount({
        qty: Number(p.qty || 0),
        pricePerUnit: Number(p.price_per_unit || 0),
        deliveryCost: Number(p.delivery_cost || 0)
      }),
      currency: "ILS",
      participant_id: p.participant_id,
      deal_id: dealId,
      buyer_id: p.buyer_id,
      correlation_id: correlation,
      request_id: `worker:${eventId}`
    };
    if (p.authorization_id) refundInput.authorization_id = p.authorization_id;
    if (p.capture_reference) refundInput.capture_reference = p.capture_reference;
    const result = await paymentProvider.refund(refundInput);

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: attemptType,
      correlation_id: correlation,
      result_class: result.result_class
    });

    if (result.result_class === "temporary_fail") {
      throw new Error(`temporary_fail refund participant ${p.participant_id}`);
    }

    // Route through webhook reconciliation truth when the provider emits a refund event
    if (result.reconciliation_event_type === "refund_issued") {
      await ingestAndProcessPaymentEvent({
        provider: result.provider,
        event_id: `${eventId}:${p.participant_id}:refund_issued`,
        event_type: "refund_issued",
        correlation_id: result.correlation_id || correlation,
        participant_id: p.participant_id,
        deal_id: dealId,
        provider_reference: result.provider_reference || p.capture_reference || p.authorization_id || null,
        payload: {
          source: "refund_worker",
          provider_reference: result.provider_reference || null,
          authorization_id: p.authorization_id || null,
          capture_reference: p.capture_reference || null
        }
      });
      continue;
    }

    if (result.result_class === "success") {
      throw new Error(`refund_missing_reconciliation_event_type participant ${p.participant_id}`);
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
      `SELECT
         p.participant_id,
         p.buyer_id,
         p.qty,
         p.delivery_cost,
         p.buyer_state,
         p.money_state,
         d.price_per_unit,
         COALESCE(auth.payload->>'authorization_id', '') AS authorization_id,
         COALESCE(auth.payload->>'authorization_provider', '') AS authorization_provider,
         COALESCE(auth.payload->>'authorization_correlation_id', '') AS authorization_correlation_id
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       LEFT JOIN LATERAL (
         SELECT payload
         FROM siton.audit_log
         WHERE entity_type = 'participant'
           AND entity_id = p.participant_id
           AND action_name = 'participant.join_authorize'
         ORDER BY created_at DESC
         LIMIT 1
       ) auth ON true
       WHERE p.deal_id=$1
       ORDER BY p.created_at ASC`,
      [dealId]
    );
    return r.rows as Array<{
      participant_id: string;
      buyer_id: string;
      qty: number;
      delivery_cost: number;
      buyer_state: BuyerState;
      money_state: MoneyState;
      price_per_unit: number;
      authorization_id: string;
      authorization_provider: string;
      authorization_correlation_id: string;
    }>;
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

    const captureInput: Parameters<typeof paymentProvider.capture>[0] = {
      amount_minor: paymentMinorAmount({
        qty: Number(p.qty || 0),
        pricePerUnit: Number(p.price_per_unit || 0),
        deliveryCost: Number(p.delivery_cost || 0)
      }),
      currency: "ILS",
      participant_id: p.participant_id,
      deal_id: dealId,
      buyer_id: p.buyer_id,
      correlation_id: correlation,
      request_id: `worker:${eventId}`
    };
    if (p.authorization_id) captureInput.authorization_id = p.authorization_id;
    const result = await paymentProvider.capture(captureInput);

    if (result.result_class === "temporary_fail") {
      await finalizeAttemptResult({
        participant_id: p.participant_id,
        deal_id: dealId,
        attempt_type: "charge_start",
        correlation_id: correlation,
        result_class: "temporary_fail"
      });
      throw new Error(`temporary_fail capture participant ${p.participant_id}`);
    }

    if (result.reconciliation_event_type) {
      await finalizeAttemptResult({
        participant_id: p.participant_id,
        deal_id: dealId,
        attempt_type: "charge_start",
        correlation_id: correlation,
        result_class: result.result_class
      });
      await ingestAndProcessPaymentEvent({
        provider: result.provider,
        event_id: `${eventId}:${p.participant_id}:${result.reconciliation_event_type}`,
        event_type: result.reconciliation_event_type,
        correlation_id: result.correlation_id || correlation,
        participant_id: p.participant_id,
        deal_id: dealId,
        provider_reference: result.provider_reference || p.authorization_id || null,
        payload: {
          source: "capture_worker",
          provider_reference: result.provider_reference || p.authorization_id || null,
          authorization_id: p.authorization_id || null
        }
      });
      continue;
    }

    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      result_class: "unknown"
    });
    throw new Error(`capture_missing_reconciliation_event_type participant ${p.participant_id}`);
  }

  const windowUntil = await withTx(async (c) => {
    const r = await c.query(`SELECT completion_window_until FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) throw new Error("deal not found");
    return r.rows[0].completion_window_until ? new Date(r.rows[0].completion_window_until) : nowPlusMinutes(COMPLETION_WINDOW_MINUTES);
  });
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
      outbox: null,
      payload: { completion_window_until: windowUntil.toISOString() },
      insideTx: async (c) => {
        const actualWindow = await setCompletionWindowOnce(c, dealId);
        await c.query(
          `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
           VALUES ('finalize_deal','deal',$1,$2,'pending',0,$3)
           ON CONFLICT DO NOTHING`,
          [dealId, JSON.stringify({ deal_id: dealId }), actualWindow.toISOString()]
        );
        const recoveryCount = await c.query(
          `SELECT COUNT(*) AS cnt
           FROM siton.participants
           WHERE deal_id=$1
             AND buyer_state='ChargeFailedCompletion'
             AND money_state='ChargeFailedRecovery'`,
          [dealId]
        );
        if (Number(recoveryCount.rows[0]?.cnt || 0) > 0) {
          await c.query(
            `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
             VALUES ('recovery_deal','deal',$1,$2,'pending',0, now())
             ON CONFLICT DO NOTHING`,
            [dealId, JSON.stringify({ deal_id: dealId })]
          );
        }
        await c.query(`SELECT set_config('siton.outbox_written', '1', true)`);
      }
    });

    app.log.info({ dealId, eventId, transitionResult }, "charge_deal after completion transition");
  } catch (e) {
    app.log.error({ dealId, eventId, err: String(e instanceof Error ? e.message : e) }, "charge_deal completion transition failed");
    throw e;
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

  if (!withinWindow) {
    return;
  }

  const participants = await withTx(async (c) => {
    const r = await c.query(
      `SELECT
         p.participant_id,
         p.buyer_id,
         p.qty,
         p.delivery_cost,
         d.price_per_unit,
         COALESCE(auth.payload->>'authorization_id', '') AS authorization_id,
         COALESCE(auth.payload->>'authorization_correlation_id', '') AS authorization_correlation_id
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       LEFT JOIN LATERAL (
         SELECT payload
         FROM siton.audit_log
         WHERE entity_type = 'participant'
           AND entity_id = p.participant_id
           AND action_name = 'participant.join_authorize'
         ORDER BY created_at DESC
         LIMIT 1
       ) auth ON true
       WHERE p.deal_id=$1
         AND p.buyer_state='ChargeFailedCompletion'
         AND p.money_state='ChargeFailedRecovery'
       ORDER BY p.created_at ASC`,
      [dealId]
    );
    return r.rows as Array<{
      participant_id: string;
      buyer_id: string;
      qty: number;
      delivery_cost: number;
      price_per_unit: number;
      authorization_id: string;
      authorization_correlation_id: string;
    }>;
  });

  for (const p of participants) {
    const correlation = `recovery:${eventId}:${p.participant_id}`;
    await recordAttemptBeforeIo({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation
    });

    const recoverInput: Parameters<typeof paymentProvider.recover>[0] = {
      amount_minor: paymentMinorAmount({
        qty: Number(p.qty || 0),
        pricePerUnit: Number(p.price_per_unit || 0),
        deliveryCost: Number(p.delivery_cost || 0)
      }),
      currency: "ILS",
      participant_id: p.participant_id,
      deal_id: dealId,
      buyer_id: p.buyer_id,
      correlation_id: correlation,
      request_id: `worker:${eventId}`,
      within_window: withinWindow
    };
    if (p.authorization_id) recoverInput.authorization_id = p.authorization_id;
    const result = await paymentProvider.recover(recoverInput, withinWindow);

    if (result.result_class === "temporary_fail") {
      await finalizeAttemptResult({
        participant_id: p.participant_id,
        deal_id: dealId,
        attempt_type: "recovery",
        correlation_id: correlation,
        result_class: "temporary_fail"
      });
      throw new Error(`temporary_fail recovery participant ${p.participant_id}`);
    }

    // Route through the webhook reconciliation truth path when the provider emits an event type
    if (result.reconciliation_event_type) {
      await finalizeAttemptResult({
        participant_id: p.participant_id,
        deal_id: dealId,
        attempt_type: "recovery",
        correlation_id: correlation,
        result_class: result.result_class
      });
      await ingestAndProcessPaymentEvent({
        provider: result.provider,
        event_id: `${eventId}:${p.participant_id}:${result.reconciliation_event_type}`,
        event_type: result.reconciliation_event_type,
        correlation_id: result.correlation_id || correlation,
        participant_id: p.participant_id,
        deal_id: dealId,
        provider_reference: result.provider_reference || p.authorization_id || null,
        payload: {
          source: "recovery_worker",
          provider_reference: result.provider_reference || p.authorization_id || null,
          authorization_id: p.authorization_id || null
        }
      });
      continue;
    }

    // Fallback: permanent_fail with no reconciliation event — apply state directly
    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      result_class: "unknown"
    });
    throw new Error(`recovery_missing_reconciliation_event_type participant ${p.participant_id}`);
  }

  return;
}

/**
 * Fetch buyer_id + deal title for a participant and enqueue a notification.
 * Non-fatal — intended for use inside webhook/worker handlers.
 */
async function enqueueNotificationForParticipant(
  notificationEventType: "join_authorized" | "charge_succeeded" | "charge_failed_recovery" | "deal_completed" | "deal_failed" | "refund_issued" | "deal_cancelled",
  participantId: string,
  dealId: string
): Promise<void> {
  const row = await pool.query(
    `SELECT p.buyer_id, d.title
     FROM siton.participants p
     JOIN siton.deals d ON d.deal_id = p.deal_id
     WHERE p.participant_id=$1`,
    [participantId]
  );
  if (!row.rowCount) return; // participant not found — skip silently
  const { buyer_id, title } = row.rows[0] as { buyer_id: string; title: string };
  await enqueueNotification({
    eventKey: `${notificationEventType}:${participantId}:sms`,
    notificationEventType,
    channel: "sms",
    recipient: buyer_id,
    templateParams: { deal_id: dealId, deal_title: String(title || ""), participant_id: participantId },
    providerCode: notificationService.providerCode
  }, pool);
}

/** Enqueue notifications for a list of participants on a deal. Non-fatal — logs errors. */
async function enqueueParticipantNotifications(
  notificationEventType: "join_authorized" | "charge_succeeded" | "charge_failed_recovery" | "deal_completed" | "deal_failed" | "refund_issued" | "deal_cancelled",
  participants: Array<{ participant_id: string; buyer_id: string }>,
  dealId: string,
  dealTitle: string,
  logger: Pick<typeof console, "error">
): Promise<void> {
  for (const p of participants) {
    try {
      await enqueueNotification({
        eventKey: `${notificationEventType}:${p.participant_id}:sms`,
        notificationEventType,
        channel: "sms",
        recipient: p.buyer_id,
        templateParams: { deal_id: dealId, deal_title: dealTitle, participant_id: p.participant_id },
        providerCode: notificationService.providerCode
      }, pool);
    } catch (e) {
      logger.error(`[notifications] enqueue failed`, { notificationEventType, participant_id: p.participant_id, err: String(e) });
    }
  }
}

async function enqueueSellerNotification(
  eventType: "seller_deal_published" | "seller_deal_completed" | "seller_deal_failed" | "seller_excel_ready",
  dealId: string,
  dealTitle: string,
  logger: Pick<Console, "error"> = console
): Promise<void> {
  try {
    const sellerRow = await pool.query(
      `SELECT d.seller_id, d.title, COALESCE(sa.support_email, '') AS support_email
       FROM siton.deals d
       LEFT JOIN siton.seller_accounts sa ON sa.seller_id = d.seller_id
       WHERE d.deal_id=$1`,
      [dealId]
    );
    if (!sellerRow.rowCount) return;
    const seller = sellerRow.rows[0] as { seller_id: string | null; title: string | null; support_email: string | null };
    const sellerId = normalizeSellerId(seller.seller_id);
    if (!sellerId) return;
    const recipientRef = String(seller.support_email || sellerId);
    const title = dealTitle || String(seller.title || "");
    await enqueueNotification({
      event_type: eventType,
      recipient_type: "seller",
      recipient_ref: recipientRef,
      deal_id: dealId,
      seller_id: sellerId,
      channel: "internal",
      payload_jsonb: { deal_id: dealId, deal_title: title },
      idempotency_key: `${eventType}:seller:${sellerId}:${dealId}:internal`
    }, pool);
  } catch (e) {
    logger.error("[notifications] seller enqueue failed", { eventType, dealId, err: String(e) });
  }
}

/**
 * Enqueue a charge_receipt document for a participant who has reached DealCompleted.
 * Eligibility: buyer_state must be DealCompleted (enforced by calling context).
 * Non-fatal — errors are caught at call site.
 */
async function enqueueChargeReceiptForParticipant(participantId: string, dealId: string): Promise<void> {
  const row = await pool.query(
    `SELECT p.qty, p.money_state, p.delivery_cost,
            d.title, d.price_per_unit
     FROM siton.participants p
     JOIN siton.deals d ON d.deal_id = p.deal_id
     WHERE p.participant_id = $1`,
    [participantId]
  );
  if (!row.rowCount) return;
  const r = row.rows[0] as {
    qty: string; money_state: string; delivery_cost: string;
    title: string; price_per_unit: string;
  };
  // Siton fee base = actual collected amount (price × qty + delivery). No VAT.
  const grossAmount = Number(r.qty) * Number(r.price_per_unit) + Number(r.delivery_cost || 0);
  const money = calculatePlatformFeeMoney({ grossAmount, vatAmount: 0 });
  await enqueueInvoiceDocument({
    documentKey: `charge_receipt:${participantId}`,
    documentType: "charge_receipt",
    dealId,
    participantId,
    dealTitle: String(r.title || ""),
    qty: Number(r.qty),
    moneyStateAtIssue: String(r.money_state),
    grossAmount: money.gross_amount,
    sitonFeeAmount: money.platform_fee_amount,
    sellerNetAmount: money.seller_net_amount,
    providerCode: invoiceProvider.providerCode
  }, pool);
}

/**
 * Enqueue a refund_receipt document for a participant whose money_state has become Refunded.
 * Eligibility: money_state must be Refunded (enforced by calling context).
 * Non-fatal — errors are caught at call site.
 */
async function enqueueRefundReceiptForParticipant(participantId: string, dealId: string): Promise<void> {
  const row = await pool.query(
    `SELECT p.qty, p.delivery_cost,
            d.title, d.price_per_unit
     FROM siton.participants p
     JOIN siton.deals d ON d.deal_id = p.deal_id
     WHERE p.participant_id = $1`,
    [participantId]
  );
  if (!row.rowCount) return;
  const r = row.rows[0] as {
    qty: string; delivery_cost: string; title: string;
    price_per_unit: string;
  };
  // Refund receipt mirrors charge receipt: fee base = price × qty + delivery.
  const grossAmount = Number(r.qty) * Number(r.price_per_unit) + Number(r.delivery_cost || 0);
  const money = calculatePlatformFeeMoney({ grossAmount, vatAmount: 0 });
  await enqueueInvoiceDocument({
    documentKey: `refund_receipt:${participantId}`,
    documentType: "refund_receipt",
    dealId,
    participantId,
    dealTitle: String(r.title || ""),
    qty: Number(r.qty),
    moneyStateAtIssue: "Refunded",
    grossAmount: money.gross_amount,
    sitonFeeAmount: money.platform_fee_amount,
    sellerNetAmount: money.seller_net_amount,
    providerCode: invoiceProvider.providerCode
  }, pool);
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
      } else if (BUYER_TRANSITIONS[p.buyer_state]?.includes("DealFailed")) {
        await atomicTransition({
          entityType: "participant",
          entityId: p.participant_id,
          dealId,
          stateType: "buyer_state",
          fromState: p.buyer_state,
          toState: "DealFailed",
          actionName: "deal.fail_participant_after_completed",
          requestId: `worker:${eventId}`,
          idempotencyKey: `p-fail-after-completed:${dealId}:${p.participant_id}:${p.buyer_state}`,
          outbox: null
        });
      }
    }

    await cleanupObsoleteDealOutboxEvents(dealId);

    // Notify participants: deal_completed for DealCompleted, deal_failed for DealFailed
    const dealTitleRow = await pool.query(`SELECT title FROM siton.deals WHERE deal_id=$1`, [dealId]);
    const dealTitle = String(dealTitleRow.rows[0]?.title || "");
    const allParticipants = await withTx(async (c) => {
      const r = await c.query(
        `SELECT participant_id, buyer_id, buyer_state FROM siton.participants WHERE deal_id=$1`,
        [dealId]
      );
      return r.rows as Array<{ participant_id: string; buyer_id: string; buyer_state: string }>;
    });
    const completedParticipants = allParticipants.filter(p => p.buyer_state === "DealCompleted");
    const failedParticipants = allParticipants.filter(p => p.buyer_state === "DealFailed");
    await enqueueParticipantNotifications("deal_completed", completedParticipants, dealId, dealTitle, console);
    await enqueueParticipantNotifications("deal_failed", failedParticipants, dealId, dealTitle, console);
    await enqueueSellerNotification("seller_deal_completed", dealId, dealTitle, console);
    await enqueueSellerNotification("seller_excel_ready", dealId, dealTitle, console);
    // Issue charge receipts for every DealCompleted participant (money settled, deal succeeded)
    for (const p of completedParticipants) {
      await enqueueChargeReceiptForParticipant(p.participant_id, dealId).catch(() => undefined);
    }
    // Issue fulfillment units (vouchers / tickets / physical placeholders).
    // Strict rule: this only runs after deal_state=Completed and only for
    // participants whose money_state ∈ {ChargedSuccess,RecoveredCharge}.
    // Idempotent — safe under retry. Failure here does not roll back the deal.
    await issueFulfillmentForCompletedDeal(dealId).catch((error) => {
      console.error("[fulfillment] issuance failed for deal", dealId, error);
    });
    await payoutRail.enqueuePrepareForDeal(dealId).catch(() => undefined);
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

  // Notify all participants: deal failed — refund will be issued
  const dealTitleRowFail = await pool.query(`SELECT title FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const dealTitleFail = String(dealTitleRowFail.rows[0]?.title || "");
  const failedParts = await withTx(async (c) => {
    const r = await c.query(`SELECT participant_id, buyer_id FROM siton.participants WHERE deal_id=$1`, [dealId]);
    return r.rows as Array<{ participant_id: string; buyer_id: string }>;
  });
  await enqueueParticipantNotifications("deal_failed", failedParts, dealId, dealTitleFail, console);
  await enqueueSellerNotification("seller_deal_failed", dealId, dealTitleFail, console);
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

    // Notify all participants: deadline passed, deal failed
    const deadlineTitleRow = await pool.query(`SELECT title FROM siton.deals WHERE deal_id=$1`, [dealId]);
    const deadlineTitle = String(deadlineTitleRow.rows[0]?.title || "");
    const deadlineParts = await withTx(async (c) => {
      const r = await c.query(`SELECT participant_id, buyer_id FROM siton.participants WHERE deal_id=$1`, [dealId]);
      return r.rows as Array<{ participant_id: string; buyer_id: string }>;
    });
    await enqueueParticipantNotifications("deal_failed", deadlineParts, dealId, deadlineTitle, console);
    await enqueueSellerNotification("seller_deal_failed", dealId, deadlineTitle, console);
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

  if (event.event_type === "seller_payout_prepare") {
    await payoutRail.prepareBatchForDeal({
      deal_id: event.aggregate_id,
      request_id: `worker:${eventId}`,
      correlation_id: `seller-payout-prepare:${event.aggregate_id}:${eventId}`
    });
    return;
  }

  if (event.event_type === "seller_payout_dispatch") {
    await payoutRail.dispatchBatch({
      payout_batch_id: event.aggregate_id,
      event_id: eventId
    });
    return;
  }

  if (event.event_type === "seller_payout_reconcile") {
    await payoutRail.reconcileBatch({
      payout_batch_id: event.aggregate_id,
      event_id: eventId
    });
    return;
  }

  if (event.event_type === "invoice_document_issue") {
    await processInvoiceDocumentById({
      pool,
      invoiceProvider,
      documentId: event.aggregate_id,
      eventId
    });
    return;
  }

  if (event.event_type === "invoice_document_reconcile") {
    await reconcileInvoiceDocumentById({
      pool,
      invoiceProvider,
      documentId: event.aggregate_id,
      eventId
    });
    return;
  }
}

export async function processNextPendingOutboxEvent(limit = 1) {
  const batch = await claimOutboxBatch(limit);
  if (batch.length === 0) return null;
  const event = batch[0];
  if (!event) return null;
  try {
    await workerProcessEvent(event);
    await markOutboxSent(event.event_uuid);
    return {
      event_uuid: event.event_uuid,
      event_type: event.event_type,
      status: "sent" as const
    };
  } catch (error) {
    await markOutboxFailed(event.event_uuid, Number(event.attempt_count || 0), error);
    return {
      event_uuid: event.event_uuid,
      event_type: event.event_type,
      status: "failed" as const,
      error: String(error instanceof Error ? error.message : error)
    };
  }
}

export async function processOutboxEventById(eventId: string) {
  const claimed = await withTx(async (c) => {
    await c.query(`SELECT set_config('siton.is_worker','true',true)`);
    const result = await c.query(
      `UPDATE siton.outbox_events
       SET status='processing',
           processing_started_at=now(),
           updated_at=now()
       WHERE event_uuid = $1
         AND status='pending'
       RETURNING event_uuid, event_type, aggregate_type, aggregate_id, payload, attempt_count, processing_started_at`,
      [eventId]
    );
    return result.rows[0] as
      | {
          event_uuid: string;
          event_type: string;
          aggregate_type: string;
          aggregate_id: string;
          payload: any;
          attempt_count: number;
          processing_started_at?: string | Date | null;
        }
      | undefined;
  });

  if (!claimed) return null;

  try {
    await workerProcessEvent(claimed);
    await markOutboxSent(claimed.event_uuid);
    return {
      event_uuid: claimed.event_uuid,
      event_type: claimed.event_type,
      status: "sent" as const
    };
  } catch (error) {
    await markOutboxFailed(claimed.event_uuid, Number(claimed.attempt_count || 0), error);
    return {
      event_uuid: claimed.event_uuid,
      event_type: claimed.event_type,
      status: "failed" as const,
      error: String(error instanceof Error ? error.message : error)
    };
  }
}
const WORKER_EVENT_TIMEOUT_MS = 30_000;
// Events stuck in 'processing' longer than this are recycled back to 'pending'.
// Set to 2× WORKER_EVENT_TIMEOUT_MS so a legitimately-slow event can finish
// before the reclaim window opens.
const WORKER_STUCK_TIMEOUT_MS = Number(process.env.WORKER_STUCK_TIMEOUT_MS || 60_000);
// Run the stuck-event reclaim every N poll cycles to amortise its cost.
const RECLAIM_EVERY_N_POLLS = 10;

async function workerLoop(app: ReturnType<typeof Fastify>, smsProvider: SmsProvider, invoiceDocProvider: InvoiceProvider) {
  let pollCount = 0;
  while (true) {
    try {
      // Periodically reclaim events/documents that got stuck in 'processing' (e.g. after a crash).
      if (pollCount % RECLAIM_EVERY_N_POLLS === 0) {
        const reclaimed = await reclaimStuckProcessing(WORKER_STUCK_TIMEOUT_MS).catch((e: unknown) => {
          app.log.error({ err: e }, "workerLoop: reclaimStuckProcessing failed");
          return 0;
        });
        if (reclaimed > 0) {
          app.log.warn({ reclaimed }, "workerLoop: reclaimed stuck processing events");
        }
        await reclaimStuckInvoiceDocuments(pool, WORKER_STUCK_TIMEOUT_MS, app.log).catch((e: unknown) => {
          app.log.error({ err: e }, "workerLoop: reclaimStuckInvoiceDocuments failed");
        });
      }
      pollCount++;

      const batch = await claimOutboxBatch(10);
      if (batch.length === 0) {
        // No outbox events — flush pending notifications then sleep
        await flushPendingNotifications(pool, smsProvider, app.log).catch((e: unknown) => {
          app.log.error({ err: e }, "workerLoop: notification flush failed");
        });
        await enqueuePendingInvoiceDocumentOutboxEvents(pool).catch((e: unknown) => {
          app.log.error({ err: e }, "workerLoop: invoice document outbox scheduling failed");
        });
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

      // After processing the outbox batch, flush pending notifications and invoice documents
      await flushPendingNotifications(pool, smsProvider, app.log).catch((e: unknown) => {
        app.log.error({ err: e }, "workerLoop: notification flush failed (post-batch)");
      });
      await enqueuePendingInvoiceDocumentOutboxEvents(pool).catch((e: unknown) => {
        app.log.error({ err: e }, "workerLoop: invoice document outbox scheduling failed (post-batch)");
      });
    } catch (e) {
      app.log.error({ err: e }, "workerLoop: batch-level error, retrying in 5s");
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (!workerRunning) return;
  }
}

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 8 * 1024 * 1024 });

function applySecurityHeaders(reply: any) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()");
}

function isImmutableDealImageRoute(req: any) {
  return req.method === "GET" && /^\/api\/deal-images\/[^/?#]+(?:[?#].*)?$/.test(String(req.url || ""));
}

function isDynamicNoStoreRoute(url: string) {
  const path = url.split("?")[0] || "/";
  return (
    path.startsWith("/api/") ||
    path.startsWith("/webhooks/") ||
    path === "/health" ||
    path === "/health/integrations" ||
    path.startsWith("/deals") ||
    path.startsWith("/participants") ||
    path.startsWith("/admin") ||
    path.startsWith("/seller") ||
    path.startsWith("/buyer") ||
    path.startsWith("/tracking") ||
    path.startsWith("/payments") ||
    path.startsWith("/invoices") ||
    path.startsWith("/payouts") ||
    path.startsWith("/notifications")
  );
}

app.addHook("onRequest", (req: any, reply: any, done) => {
  const requestId = safeHeaderId(req.headers?.["x-request-id"], "req");
  const correlationId = safeHeaderId(req.headers?.["x-correlation-id"], "corr");
  req.request_id = requestId;
  req.requestId = requestId;
  req.correlation_id = correlationId;
  req.correlationId = correlationId;
  req.headers["x-request-id"] = requestId;
  req.headers["x-correlation-id"] = correlationId;
  reply.header("x-request-id", requestId);
  reply.header("x-correlation-id", correlationId);
  applySecurityHeaders(reply);
  if (!isImmutableDealImageRoute(req) && isDynamicNoStoreRoute(String(req.url || ""))) {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
    reply.header("expires", "0");
  }
  done();
});
export { app, issueFulfillmentForCompletedDeal };

// ---------------------------------------------------------------------------
// Rate limiter
// Configurable via RATE_LIMIT_MAX (requests per window) and
// RATE_LIMIT_WINDOW_MS (window duration in ms). Off when RATE_LIMIT_MAX=0.
// Uses a fixed-window counter keyed by client IP.
//
// Behind Render (or any proxy with trustProxy:true), req.ip already resolves
// the first untrusted IP from X-Forwarded-For via Fastify's built-in handling.
// Sensitive endpoints (OTP, join-deal) use a tighter per-path sub-limit.
// Default store is memory with explicit single-instance scale mode. The narrow
// interface is the replacement point for Redis/DB/platform-backed enforcement.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 200);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
// Stricter limit for sensitive mutation endpoints (OTP, joining a deal)
const RATE_LIMIT_SENSITIVE_MAX = Number(process.env.RATE_LIMIT_SENSITIVE_MAX ?? 20);
export const RATE_LIMIT_SCALE_MODE = process.env.RATE_LIMIT_SCALE_MODE || "single_instance_only";

// Paths that get the tighter per-IP limit (prefix match without trailing slash)
const SENSITIVE_PATHS = ["/api/otp", "/api/deals/join", "/api/deals"];

type RateLimitEntry = { count: number; resetAt: number };
interface RateLimiterStore {
  hit(key: string, now: number, windowMs: number): RateLimitEntry;
  purge(now: number): void;
  readonly scale_mode: string;
}

class MemoryRateLimiterStore implements RateLimiterStore {
  readonly scale_mode = "single_instance_only";
  private readonly buckets = new Map<string, RateLimitEntry>();

  hit(key: string, now: number, windowMs: number) {
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      const next = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, next);
      return next;
    }
    current.count += 1;
    return current;
  }

  purge(now: number) {
    for (const [key, entry] of this.buckets) {
      if (entry.resetAt <= now) this.buckets.delete(key);
    }
  }
}

const rateLimitStore: RateLimiterStore = new MemoryRateLimiterStore();

// Purge expired entries every 5 minutes to prevent unbounded memory growth
const rateLimitPurge = setInterval(() => {
  rateLimitStore.purge(Date.now());
}, 5 * 60_000);
rateLimitPurge.unref();

function isSensitivePath(url: string): boolean {
  return SENSITIVE_PATHS.some((p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"));
}

if (RATE_LIMIT_MAX > 0) {
  app.addHook("onRequest", async (req, reply) => {
    // req.ip is the correct client IP when trustProxy:true is set —
    // Fastify reads X-Forwarded-For and returns the first untrusted address.
    const ip = req.ip || "unknown";
    const url = req.url || "";
    const now = Date.now();

    // Global limit bucket
    const globalKey = `g:${ip}`;
    const globalEntry = rateLimitStore.hit(globalKey, now, RATE_LIMIT_WINDOW_MS);
    if (globalEntry.count > RATE_LIMIT_MAX) {
      const retryAfterSecs = Math.ceil((globalEntry.resetAt - now) / 1000);
      void reply
        .code(429)
        .header("Retry-After", String(retryAfterSecs))
        .send({ ok: false, error: "rate_limit_exceeded", retry_after: retryAfterSecs });
      return;
    }

    // Sensitive-endpoint stricter bucket
    if (RATE_LIMIT_SENSITIVE_MAX > 0 && isSensitivePath(url)) {
      const sensitiveKey = `s:${ip}`;
      const sensitiveEntry = rateLimitStore.hit(sensitiveKey, now, RATE_LIMIT_WINDOW_MS);
      if (sensitiveEntry.count > RATE_LIMIT_SENSITIVE_MAX) {
        const retryAfterSecs = Math.ceil((sensitiveEntry.resetAt - now) / 1000);
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
  const httpStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  if (httpStatus >= 500) {
    app.log.error({ err: error }, "unhandled route error");
  }
  const payload: { ok: false; error: string; code?: string } = {
    ok: false,
    error: error.message || "internal_error"
  };
  if (error.code) payload.code = String(error.code);
  return reply.code(httpStatus).send(payload);
});

app.get("/health", async () => ({ ok: true }));

function parseImageUploadBody(body: any) {
  const dataUrl = String(body?.image_data_url || body?.data_url || "").trim();
  const explicitBase64 = String(body?.image_base64 || body?.base64 || "").trim();
  const explicitMimeType = String(body?.mime_type || "").trim().toLowerCase();
  if (dataUrl) {
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!match) {
      const err: any = new Error("invalid image data");
      err.statusCode = 400;
      err.code = "invalid_image_type";
      throw err;
    }
    return {
      mimeType: String(match[1] || ""),
      base64Data: String(match[2] || "").replace(/\s/g, "")
    };
  }
  return {
    mimeType: explicitMimeType,
    base64Data: explicitBase64.replace(/\s/g, "")
  };
}

app.get("/api/deal-images/:imageId", async (req: any, reply: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  const imageId = String(req.params.imageId || "");
  requireUuid(imageId, "image_id");
  const row = await withTx(async (c) => {
    const result = await c.query(
      `SELECT storage_key, mime_type FROM siton.deal_images WHERE image_id=$1`,
      [imageId]
    );
    if (!result.rowCount) {
      const err: any = new Error("image not found");
      err.statusCode = 404;
      throw err;
    }
    return result.rows[0];
  });
  const file = await readDealImage(String(row.storage_key));
  return reply
    .header("content-type", String(row.mime_type))
    .header("cache-control", "public, max-age=31536000, immutable")
    .send(file);
});

app.post("/deals", async (req: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  await ensureDealTypeTables(withTx);
  const body = req.body || {};
  const dealType: DealType = normalizeDealType(body.deal_type, "physical_product");
  if (body.deal_type !== undefined && body.deal_type !== null && !["physical_product","voucher","ticket"].includes(String(body.deal_type))) {
    const err: any = new Error("deal_type must be one of physical_product, voucher, ticket");
    err.statusCode = 400;
    err.code = "deal_type_invalid";
    throw err;
  }
  const voucherTermsInput = body.voucher_terms && typeof body.voucher_terms === "object" ? body.voucher_terms : null;
  const ticketTermsInput = body.ticket_terms && typeof body.ticket_terms === "object" ? body.ticket_terms : null;
  if (dealType === "voucher" && !voucherTermsInput) {
    const err: any = new Error("voucher_terms is required for voucher deals");
    err.statusCode = 400;
    err.code = "voucher_terms_required";
    throw err;
  }
  if (dealType === "ticket" && !ticketTermsInput) {
    const err: any = new Error("ticket_terms is required for ticket deals");
    err.statusCode = 400;
    err.code = "ticket_terms_required";
    throw err;
  }
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
  const deliveryOptions = Array.isArray(body.delivery_options)
    ? body.delivery_options
        .map((option: any, index: number) => ({
          option_type: ["delivery", "pickup", "distribution_point"].includes(String(option?.option_type || ""))
            ? String(option.option_type)
            : "pickup",
          label: String(option?.label || "").trim().slice(0, 160),
          cost: Math.max(0, Number(option?.cost || 0)),
          sort_order: Number.isFinite(Number(option?.sort_order)) ? Number(option.sort_order) : index
        }))
        .filter((option: any) => option.label)
        .slice(0, 5)
    : [];

  const now = Date.now();
  let deadlineMs: number;
  if (body.deadline === undefined || body.deadline === null || body.deadline === "") {
    deadlineMs = now + DEADLINE_DEFAULT_MS;
  } else {
    deadlineMs = new Date(body.deadline).getTime();
    if (!Number.isFinite(deadlineMs)) {
      const err: any = new Error("deadline must be a valid ISO date");
      err.statusCode = 400;
      throw err;
    }
  }
  const deadlineDiffMs = deadlineMs - now;
  if (deadlineDiffMs < DEADLINE_MIN_MS) {
    const err: any = new Error("deadline must be at least 2 hours in the future");
    err.statusCode = 400;
    err.code = "deadline_below_minimum";
    throw err;
  }
  if (deadlineDiffMs > DEADLINE_MAX_MS) {
    const err: any = new Error("deadline must be within 7 days from now");
    err.statusCode = 400;
    err.code = "deadline_above_maximum";
    throw err;
  }
  const deadlineIso = new Date(deadlineMs).toISOString();

  const r = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "create_draft");
    const ins = await c.query(
      `INSERT INTO siton.deals
       (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, deal_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING deal_id, state, deal_type`,
      [
        title,
        priceRaw,
        minUnits,
        maxUnits,
        draftThreshold,
        deadlineIso,
        sellerAuthority.seller_id,
        dealType
      ]
    );
    const deal = ins.rows[0];
    if (dealType === "physical_product") {
      for (const option of deliveryOptions) {
        await c.query(
          `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [deal.deal_id, option.option_type, option.label, option.cost, option.sort_order]
        );
      }
    }
    if (dealType === "voucher" && voucherTermsInput) {
      await upsertVoucherTerms(c, String(deal.deal_id), voucherTermsInput);
    }
    if (dealType === "ticket" && ticketTermsInput) {
      await upsertTicketTerms(c, String(deal.deal_id), ticketTermsInput);
    }
    return deal;
  });
  return r;
});

app.post("/api/seller/deals/:dealId/duplicate", async (req: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  const sourceDealId = String(req.params.dealId || "");
  requireUuid(sourceDealId, "deal_id");

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "create_draft");
    const source = await c.query(
      `SELECT deal_id, seller_id, title, price_per_unit, min_units, max_units
       FROM siton.deals
       WHERE deal_id=$1`,
      [sourceDealId]
    );
    if (!source.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    const sourceDeal = source.rows[0];
    if (normalizeSellerId(sourceDeal.seller_id) !== sellerAuthority.seller_id) {
      const err: any = new Error("seller is not authorized for this deal");
      err.statusCode = 403;
      err.code = "seller_deal_forbidden";
      throw err;
    }

    const minUnits = Math.max(1, Number(sourceDeal.min_units || 1));
    const maxUnits = Math.max(minUnits, Number(sourceDeal.max_units || minUnits));
    const thresholdUnits = Math.ceil(0.9 * minUnits);
    const draftDeadline = new Date(Date.now() + DEADLINE_DEFAULT_MS).toISOString();
    const inserted = await c.query(
      `INSERT INTO siton.deals
         (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Draft')
       RETURNING deal_id, state`,
      [
        String(sourceDeal.title || ""),
        Number(sourceDeal.price_per_unit || 0),
        minUnits,
        maxUnits,
        thresholdUnits,
        draftDeadline,
        sellerAuthority.seller_id
      ]
    );
    const newDeal = inserted.rows[0];

    await c.query(
      `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
       SELECT $2, option_type, label, cost, sort_order
       FROM siton.deal_delivery_options
       WHERE deal_id=$1
       ORDER BY sort_order ASC, created_at ASC`,
      [sourceDealId, newDeal.deal_id]
    );

    await c.query(
      `INSERT INTO siton.deal_images
         (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type,
          size_bytes, width, height, sort_order, is_primary)
       SELECT $2, storage_provider, storage_key, public_url, original_filename, mime_type,
              size_bytes, width, height, sort_order, is_primary
       FROM siton.deal_images
       WHERE deal_id=$1
       ORDER BY sort_order ASC, created_at ASC`,
      [sourceDealId, newDeal.deal_id]
    );

    return {
      source_deal_id: sourceDealId,
      new_deal_id: String(newDeal.deal_id),
      state: String(newDeal.state)
    };
  });
});

app.post("/api/seller/deals/:dealId/images", async (req: any, reply: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  const dealId = String(req.params.dealId || "");
  requireUuid(dealId, "deal_id");
  const body = req.body || {};
  const parsed = parseImageUploadBody(body);
  const originalFilename = String(body.original_filename || body.filename || "").trim() || null;

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    const dealResult = await c.query(
      `SELECT seller_id, state FROM siton.deals WHERE deal_id=$1`,
      [dealId]
    );
    if (!dealResult.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    const deal = dealResult.rows[0];
    if (normalizeSellerId(deal.seller_id) !== sellerAuthority.seller_id) {
      const err: any = new Error("seller is not authorized for this deal");
      err.statusCode = 403;
      throw err;
    }
    if (String(deal.state) !== "Draft") {
      const err: any = new Error("deal already published");
      err.statusCode = 409;
      err.code = "deal_already_published";
      throw err;
    }

    const saved = await saveDealImage({
      dealId,
      originalFilename,
      mimeType: parsed.mimeType,
      base64Data: parsed.base64Data
    });

    let inserted;
    try {
      await c.query(`UPDATE siton.deal_images SET is_primary=false WHERE deal_id=$1`, [dealId]);
      inserted = await c.query(
        `INSERT INTO siton.deal_images
           (deal_id, storage_provider, storage_key, original_filename, mime_type, size_bytes, sort_order, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,0,true)
         RETURNING image_id, deal_id, mime_type, size_bytes, is_primary, sort_order`,
        [
          dealId,
          saved.storage_provider,
          saved.storage_key,
          saved.original_filename,
          saved.mime_type,
          saved.size_bytes
        ]
      );
    } catch (error) {
      await deleteDealImageFile(saved.storage_key).catch(() => undefined);
      throw error;
    }
    const image = inserted.rows[0];
    return reply.code(201).send({
      ok: true,
      image: {
        image_id: image.image_id,
        deal_id: image.deal_id,
        public_url: getDealImagePublicUrl(image),
        image_url: getDealImagePublicUrl(image),
        mime_type: image.mime_type,
        size_bytes: Number(image.size_bytes),
        is_primary: Boolean(image.is_primary),
        sort_order: Number(image.sort_order || 0)
      }
    });
  });
});

app.post("/deals/:id/publish", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const body = req.body || {};
  if (!isAccepted(body.seller_terms_accepted)) {
    const err: any = new Error("seller_terms_required");
    err.statusCode = 400;
    err.code = "seller_terms_required";
    throw err;
  }
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const correlationId = req.headers["x-correlation-id"] ? String(req.headers["x-correlation-id"]) : requestId;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `publish:${dealId}`;

  let publishSellerId = "";
  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    publishSellerId = sellerAuthority.seller_id;
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "publish");
    const r = await c.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    if (normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }

    // Seller profile readiness: business_name + at least one contact method required before publish
    const profileResult = await c.query(
      `SELECT business_name, support_phone, support_email,
              COALESCE(verification_status, 'pending') AS verification_status,
              COALESCE(seller_status, 'Active') AS seller_status_value
       FROM siton.seller_accounts WHERE seller_id = $1`,
      [sellerAuthority.seller_id]
    );
    const prof = profileResult.rows[0] as any;
    if (!prof?.business_name?.trim() || (!prof?.support_phone?.trim() && !prof?.support_email?.trim())) {
      const err: any = new Error(
        "seller profile incomplete: set business_name and at least one contact method before publishing"
      );
      err.statusCode = 409;
      err.code = "seller_profile_incomplete";
      throw err;
    }
    // Production-like deployments require an explicit KYC approval before live
    // publish. The local/demo-preview flow stays permissive so existing demo
    // bootstraps and tests are not affected.
    const isProductionLike = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
    if (isProductionLike && String(prof.verification_status) !== "approved") {
      const err: any = new Error("seller is not approved for live publish");
      err.statusCode = 409;
      err.code = "seller_kyc_not_approved";
      throw err;
    }
  });

  const result = await atomicTransition({
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
  await withTx(async (c) => {
    await recordLegalAcceptance({
      c,
      req,
      actorType: "seller",
      actorRef: publishSellerId,
      dealId,
      acceptanceType: "seller_publish_terms",
      policyVersion: SELLER_TERMS_VERSION,
      metadata: { terms_version: TERMS_VERSION }
    });
  });
  await enqueueSellerNotification("seller_deal_published", dealId, "").catch(() => undefined);
  return result;
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
  requireUuid(dealId, "deal_id");
  const body = req.body || {};
  const buyer_id = String(body.buyer_id || "");
  const authorizationId = String(body.authorization_id || "").trim();
  const authorizationProvider = String(body.authorization_provider || "").trim();
  const authorizationCorrelationId = String(body.authorization_correlation_id || "").trim();
  const deliveryOptionId = String(body.delivery_option_id || "").trim();
  const buyerName = String(body.buyer_name || "").trim() || null;
  const buyerEmail = String(body.buyer_email || "").trim() || null;
  const deliveryAddress = String(body.delivery_address || "").trim() || null;
  const deliveryCity = String(body.delivery_city || "").trim() || null;
  const deliveryNotes = String(body.delivery_notes || "").trim() || null;
  if (deliveryNotes && deliveryNotes.length > 200) {
    const err: any = new Error("delivery_notes must be 200 characters or less");
    err.statusCode = 400;
    err.code = "delivery_notes_too_long";
    throw err;
  }
  let qtyRaw: number;
  try {
    qtyRaw = parsePositiveIntegerQuantity(body.qty, 1);
  } catch (err: any) {
    err.statusCode = err.statusCode || 400;
    throw err;
  }

  if (!buyer_id) {
    const err: any = new Error("buyer_id required");
    err.statusCode = 400;
    throw err;
  }
  if (!isAccepted(body.buyer_terms_accepted)) {
    const err: any = new Error("buyer_terms_required");
    err.statusCode = 400;
    err.code = "buyer_terms_required";
    throw err;
  }
  if (!isAccepted(body.payment_disclosure_accepted)) {
    const err: any = new Error("payment_disclosure_required");
    err.statusCode = 400;
    err.code = "payment_disclosure_required";
    throw err;
  }
  const qty = qtyRaw;

  const otpToken = body.otp_token ? String(body.otp_token) : null;
  const otpChallengeId = body.otp_challenge_id ? String(body.otp_challenge_id) : null;
  try {
    await withTx(async (c) => {
      await ensureJoinOtpVerified(c, {
        otp_token: otpToken,
        otp_challenge_id: otpChallengeId,
        deal_id: dealId
      });
    });
  } catch (err: any) {
    if (err instanceof OtpValidationError) {
      const e: any = new Error(err.message);
      e.statusCode = err.statusCode;
      e.code = err.code;
      throw e;
    }
    throw err;
  }

  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  // Idempotency key is per-request, not per-buyer — ensures each purchase attempt has a unique key
  const correlationId = req.headers["x-correlation-id"] ? String(req.headers["x-correlation-id"]) : requestId;
  const idem = req.headers["idempotency-key"]
    ? String(req.headers["idempotency-key"])
    : `join:${dealId}:${buyer_id}:${requestId}`;

  await ensureAdminControlPlaneTables(withTx);
  await ensureAdminInterventionTables(withTx);
  const participant = await withTx(async (c) => {
    // Lock the deal row to prevent concurrent over-booking
    const dealRow = await c.query(
      `SELECT deal_id, state, max_units, seller_id FROM siton.deals WHERE deal_id=$1 FOR UPDATE`,
      [dealId]
    );
    if (!dealRow.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    const dealState = String(dealRow.rows[0].state) as DealState;
    const maxUnits = Number(dealRow.rows[0].max_units);
    const dealSellerId = String(dealRow.rows[0].seller_id || "");

    if (!["PendingTarget", "TargetReached"].includes(dealState)) {
      const err: any = new Error("deal is not open for joining");
      err.statusCode = 409;
      throw err;
    }

    if (await isFlagActive(c, "pause_joining_emergency", "deal", dealId)
      || (dealSellerId && await isFlagActive(c, "pause_joining_emergency", "seller", dealSellerId))) {
      const err: any = new Error("joining is paused by admin emergency control");
      err.statusCode = 423;
      err.code = "joining_paused_by_admin";
      throw err;
    }

    // Pre-INSERT idempotency check: if this exact idempotency key was already committed for
    // a participant on this deal+buyer pair, return that participant directly without re-inserting.
    const idemCheck = await c.query(
      `SELECT p.participant_id, p.buyer_state, p.money_state,
              p.delivery_option_id, p.delivery_method_type, p.delivery_method_label, p.delivery_cost
       FROM siton.idempotency_log il
       JOIN siton.participants p ON p.participant_id = il.entity_id
       WHERE il.entity_type = 'participant'
         AND il.action_name = 'participant.join_authorize'
         AND il.idempotency_key = $1
         AND p.deal_id = $2
         AND p.buyer_id = $3
       LIMIT 1`,
      [idem, dealId, buyer_id]
    );
    if (idemCheck.rowCount) {
      return idemCheck.rows[0] as {
        participant_id: string;
        buyer_state: BuyerState;
        money_state: MoneyState;
        delivery_option_id?: string | null;
        delivery_method_type?: string | null;
        delivery_method_label?: string | null;
        delivery_cost?: number | string | null;
      };
    }
    const deliveryOption = deliveryOptionId
      ? await c.query(
          `SELECT option_id, option_type, label, cost
           FROM siton.deal_delivery_options
           WHERE option_id=$1 AND deal_id=$2`,
          [deliveryOptionId, dealId]
        )
      : await c.query(
          `SELECT option_id, option_type, label, cost
           FROM siton.deal_delivery_options
           WHERE deal_id=$1
           ORDER BY sort_order ASC, created_at ASC
           LIMIT 1`,
          [dealId]
        );
    const selectedDelivery = deliveryOption.rows[0] || null;

    if (deliveryOptionId && !selectedDelivery) {
      const err: any = new Error("invalid_delivery_option");
      err.statusCode = 400;
      err.code = "invalid_delivery_option";
      throw err;
    }

    if (selectedDelivery?.option_type === "delivery" && !deliveryAddress) {
      const err: any = new Error("delivery_address is required for delivery shipments");
      err.statusCode = 400;
      err.code = "delivery_address_required";
      throw err;
    }

    // Count ALL active units on this deal (all buyers) to enforce max_units ceiling
    const reservedRow = await c.query(
      `SELECT COALESCE(SUM(qty), 0) AS total
       FROM siton.participants
       WHERE deal_id=$1
         AND buyer_state NOT IN ('DealFailed','Dropped')`,
      [dealId]
    );
    const alreadyReserved = Number(reservedRow.rows[0].total);
    const remaining = maxUnits - alreadyReserved;

    if (qty > remaining) {
      const err: any = new Error(
        `requested quantity (${qty}) exceeds available inventory (${Math.max(0, remaining)})`
      );
      err.statusCode = 409;
      throw err;
    }

    // INSERT participant, then immediately apply state transitions + write audit + idem_log
    // all within the same deal-locked transaction. This prevents the race where concurrent
    // requests slip through the idempotency check during the gap between participant INSERT
    // (end of withTx) and idem_log write (end of atomicMultiTransition).
    const ins = await c.query(
      `INSERT INTO siton.participants(
         deal_id, buyer_id, qty, buyer_state, money_state,
         delivery_option_id, delivery_method_type, delivery_method_label, delivery_cost,
         buyer_name, buyer_phone, buyer_email,
         delivery_address, delivery_city, delivery_notes
       )
       VALUES ($1,$2,$3,'NotJoined','NoFinancial',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING participant_id`,
      [
        dealId,
        buyer_id,
        qty,
        selectedDelivery?.option_id ?? null,
        selectedDelivery?.option_type ?? null,
        selectedDelivery?.label ?? null,
        Number(selectedDelivery?.cost || 0),
        buyerName,
        buyer_id,  // buyer_phone = OTP phone, which is buyer_id
        buyerEmail,
        deliveryAddress,
        deliveryCity,
        deliveryNotes
      ]
    );
    const pid = ins.rows[0].participant_id as string;

    const authorizationPayload = authorizationId
      ? {
          authorization: "provider_authorized",
          authorization_id: authorizationId,
          authorization_provider: authorizationProvider || "unknown",
          authorization_correlation_id: authorizationCorrelationId || null
        }
      : { authorization: "mock_success" };

    // Set session config expected by audit/outbox trigger guards
    await c.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await c.query(`SELECT set_config('siton.action_name', 'participant.join_authorize', true)`);
    await c.query(`SELECT set_config('siton.audit_written', '0', true)`);
    await c.query(`SELECT set_config('siton.outbox_written', '0', true)`);

    const payloadJson = JSON.stringify(authorizationPayload);
    await c.query(
      `INSERT INTO siton.audit_log
       (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
       VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5,$6)`,
      [pid, dealId, requestId, correlationId, idem, payloadJson]
    );
    await c.query(
      `INSERT INTO siton.audit_log
       (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
       VALUES ('participant',$1,$2,'money_state','NoFinancial','AuthHeld','participant.join_authorize',$3,$4,$5,$6)`,
      [pid, dealId, requestId, correlationId, idem, payloadJson]
    );
    await c.query(`SELECT set_config('siton.audit_written', '1', true)`);

    const bsUpd = await c.query(
      `UPDATE siton.participants SET buyer_state='JoinedAuthorized' WHERE participant_id=$1 AND buyer_state='NotJoined'`,
      [pid]
    );
    if (bsUpd.rowCount !== 1) throw new Error(`State mismatch participant ${pid} expected NotJoined`);
    const msUpd = await c.query(
      `UPDATE siton.participants SET money_state='AuthHeld' WHERE participant_id=$1 AND money_state='NoFinancial'`,
      [pid]
    );
    if (msUpd.rowCount !== 1) throw new Error(`State mismatch participant ${pid} expected NoFinancial`);

    await c.query(
      `INSERT INTO siton.idempotency_log
       (entity_type, entity_id, action_name, idempotency_key, response_code, response_jsonb, correlation_id, request_id)
       VALUES ('participant',$1,'participant.join_authorize',$2,'OK',$3,$4,$5)`,
      [pid, idem, JSON.stringify({ ok: true }), correlationId, requestId]
    );
    await c.query(`SELECT set_config('siton.in_atomic', 'false', true)`);

    return {
      participant_id: pid,
      buyer_state: "JoinedAuthorized" as BuyerState,
      money_state: "AuthHeld" as MoneyState,
      delivery_option_id: selectedDelivery?.option_id ?? null,
      delivery_method_type: selectedDelivery?.option_type ?? null,
      delivery_method_label: selectedDelivery?.label ?? null,
      delivery_cost: Number(selectedDelivery?.cost || 0)
    };
  });

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

  await withTx(async (c) => {
    await recordLegalAcceptance({
      c,
      req,
      actorType: "buyer",
      actorRef: buyer_id,
      dealId,
      participantId: participant.participant_id,
      acceptanceType: "buyer_join_terms",
      policyVersion: TERMS_VERSION,
      metadata: { refund_policy_version: REFUND_POLICY_VERSION }
    });
    await recordLegalAcceptance({
      c,
      req,
      actorType: "buyer",
      actorRef: buyer_id,
      dealId,
      participantId: participant.participant_id,
      acceptanceType: "buyer_payment_disclosure",
      policyVersion: PAYMENT_DISCLOSURE_VERSION,
      metadata: { no_charge_before_successful_close: true }
    });
  });

  // Enqueue join_authorized notification (non-blocking — failure must not break join)
  await (async () => {
    try {
      const dealTitleRow = await pool.query(`SELECT title FROM siton.deals WHERE deal_id=$1`, [dealId]);
      const dealTitle = String(dealTitleRow.rows[0]?.title || "");
      await enqueueNotification({
        eventKey: `join_authorized:${participant.participant_id}:sms`,
        notificationEventType: "join_authorized",
        channel: "sms",
        recipient: buyer_id,
        templateParams: { deal_id: dealId, deal_title: dealTitle, participant_id: participant.participant_id },
        providerCode: notificationService.providerCode
      }, pool);
    } catch (e) {
      app.log.error({ err: e, participant_id: participant.participant_id }, "join: notification enqueue failed (non-fatal)");
    }
  })();

  const dealPriceRow = await pool.query(`SELECT price_per_unit FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const deliveryCost = Number(participant.delivery_cost || 0);
  await ensureParticipantTrackingTables(withTx);
  const trackingAccess = await withTx(async (c) => {
    return issueParticipantTrackingToken(c, {
      participant_id: participant.participant_id,
      deal_id: dealId,
      purpose: "tracking",
      issued_via: "buyer_join",
      correlation_id: correlationId
    });
  });
  const trackingUrl = `/app/track/${encodeURIComponent(participant.participant_id)}?t=${encodeURIComponent(trackingAccess.token)}`;
  return {
    ok: true,
    participant_id: participant.participant_id,
    tracking_access_token: trackingAccess.token,
    tracking_url: trackingUrl,
    delivery_option_id: participant.delivery_option_id ?? null,
    delivery_method_type: participant.delivery_method_type ?? null,
    delivery_method_label: participant.delivery_method_label ?? null,
    delivery_cost: deliveryCost,
    hold_total: Number(qty) * Number(dealPriceRow.rows[0]?.price_per_unit || 0) + deliveryCost
  };
});

app.post("/deals/:id/close_joining", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `close:${dealId}`;

  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    const r = await c.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    if (normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
  });

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

  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    const r = await c.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    if (normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
  });

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
        const err: any = new Error("deal is not closed for joining");
        err.statusCode = 409;
        throw err;
      }

      const ops: TransitionOp[] = [];
      ops.push({ entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", fromState: "ClosedForJoining", toState: "ReadyForCharging" });

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

  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    const r = await c.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    if (normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
  });

  return atomicMultiTransition({
    actionName: "charging.start",
    requestId,
    idempotency: { entityType: "deal", entityId: dealId, idempotencyKey: idem },
    outbox: { event_type: "charge_deal", aggregate_type: "deal", aggregate_id: dealId, payload: { deal_id: dealId } },
    buildOpsInTx: async (c) => {
      const deal = await c.query(`SELECT state, seller_id FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
      if (!deal.rowCount) throw new Error("deal not found");
      const state = deal.rows[0].state as DealState;
      const sellerIdForFlag = String(deal.rows[0].seller_id || "");
      if (state !== "ReadyForCharging") {
        const err: any = new Error("deal is not ready for charging");
        err.statusCode = 409;
        throw err;
      }
      if (await isFlagActive(c, "pause_charging_emergency", "deal", dealId)
        || (sellerIdForFlag && await isFlagActive(c, "pause_charging_emergency", "seller", sellerIdForFlag))) {
        const err: any = new Error("charging is paused by admin emergency control");
        err.statusCode = 423;
        err.code = "charging_paused_by_admin";
        throw err;
      }

      const ops: TransitionOp[] = [];
      ops.push({ entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", fromState: "ReadyForCharging", toState: "Charging" });

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
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `cancel:${dealId}`;

  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    const r = await c.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (!r.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    if (normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
  });

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

// Wire frontend experience routes onto the same app instance.
// This must happen before listen() so tests that import `app` see all routes.
const notificationService = buildNotificationService();
const invoiceProvider = buildInvoiceProvider();
const platformFeeMoney = buildPlatformFeeMoney({ withTx });
registerFrontendExperience(app, {
  withTx,
  pool,
  paymentProvider,
  payoutProvider,
  payoutRail,
  deploymentMode: APP_DEPLOYMENT_MODE,
  isDemoPreview: IS_DEMO_PREVIEW,
  notificationSummary: getNotificationServiceSummary(notificationService),
  invoiceSummary: getInvoiceProviderSummary(invoiceProvider),
  invoiceProvider,
  debugSurfacesEnabled: process.env.DEBUG_SURFACES_ENABLED === "1",
  getWorkerRunning: () => workerRunning,
  workerStuckTimeoutMs: WORKER_STUCK_TIMEOUT_MS,
  applyPaymentWebhookClassification
});

let workerRunning = false;

(async () => {
  await ensurePlatformFeeMoneyTables(withTx);
  await ensureRemainingProductSurfaceTables(withTx);
  await ensurePayoutRailTables(withTx);
  await ensureInvoiceRailTables(withTx);
  await ensureNotificationRailTables(withTx);
  await ensureLegalAcceptanceTables(withTx);
  await ensureOtpRailTables(withTx);
  await ensureAdminControlPlaneTables(withTx);
  await ensureAdminIdentityTables(withTx);
  await ensureParticipantTrackingTables(withTx);
  await ensureAdminInterventionTables(withTx);

  if (!DISABLE_OUTBOX_WORKER) {
    workerRunning = true;
    workerLoop(app, notificationService, invoiceProvider).catch((e) => app.log.error(e));
  }

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








