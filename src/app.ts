import { assertRequiredTables } from "./schema_contract.js";
import { pickupOptionsMissingLocation } from "./pickup_location.js";
import Fastify from "fastify";
import { pool } from "./db.js";
import {
  assertCanonicalRuntimeReady,
  canonicalPostgresRuntimeEnabled
} from "./runtime_database_boundary.js";
import {
  buildInventoryRepository,
  canonicalInventoryKey,
  inventorySha256,
  InventoryRepositoryError
} from "./inventory_repository.js";
type PoolClient = any;
import { createHash, randomUUID } from "crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { buildOutboxWorkerHelpers, OutboxLeaseLostError } from "./outbox_worker_helpers.js";
import { buildPaymentAttemptHelpers } from "./payment_attempt_helpers.js";
import { buildPaymentProvider, getPaymentProviderSummary } from "./payment_provider.js";
import { buildPaymentAuthorizationBindings, PaymentBindingError } from "./payment_binding.js";
import { computeCustomerChargeVat } from "./vat_authority.js";
import { buildNotificationService, getNotificationServiceSummary } from "./notification_service.js";
import {
  enqueueNotification,
  ensureNotificationRailTables,
  flushPendingNotifications,
  reclaimStrandedNotifications
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
  reclaimStuckInvoiceDocuments
} from "./invoice_dispatch.js";
import { registerFrontendExperience } from "./frontend_runtime.js";
import { applicationRequestTelemetry } from "./infrastructure_metrics.js";
import { assertProductionRuntimeGuards } from "./production_guards.js";
import { rewriteCanonicalApiAlias } from "./api_route_aliases.js";
import { ensureJoinOtpVerified, ensureOtpRailTables, OtpValidationError } from "./otp_rail.js";
import { isBuyerVerificationRequired } from "./buyer_verification_policy.js";
import { buildSupabaseVerifier, AuthTokenError } from "./supabase_auth.js";
import { resolveSupabaseCapabilities, bearerToken } from "./actor_resolver.js";
import { hitTestFault } from "./fault_injection.js";
import {
  recordViralJoinAttribution,
  recomputeDealViralMetrics,
  recomputeAggregateViralMetrics,
  personalShareUrl
} from "./viral_graph.js";
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
  resolveDealImageUrl,
  getDealImageStorageAdapter,
  readDealImage,
  saveDealImage
} from "./product_image_storage.js";
import type { StorageProviderCode } from "./storage_adapter.js";
import { buildPayoutProvider } from "./payout_provider.js";
import { buildPayoutRail, ensurePayoutRailTables } from "./payout_rail.js";
import {
  SELLER_SESSION_COOKIE,
  hasSellerSessionCookie,
  hashSellerSessionToken,
  normalizeSellerDisplayName,
  normalizeSellerId,
  parseCookies,
  safeSellerReturnTo,
  sellerAuthFailurePayload,
  type SellerAuthFailureReason
} from "./seller_auth.js";
import { ensureAdminControlPlaneTables, safeHeaderId } from "./admin_control_plane.js";
import { ensureAdminIdentityTables } from "./admin_identity.js";
import { ensureParticipantTrackingTables, issueParticipantTrackingToken } from "./participant_tracking_security.js";
import { ensureAdminInterventionTables, isFlagActive } from "./admin_intervention.js";
import { mallStatusForState } from "./mall_read_model.js";
dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || "0.0.0.0");
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

// P0.2 — deal content + media bounds. The short description is the concise
// sales line (cards/OG/top of the deal page); the long description is the full
// story rendered lower on the page.
const DEAL_IMAGE_LIMIT = 12;
const DESCRIPTION_SHORT_MAX = 200;
const DESCRIPTION_LONG_MAX = 4000;

// Per spec: Siton's platform commission is a fixed 8% — not per-deal configurable.
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

function hashJoinRequestPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function deterministicUuid(input: string): string {
  const bytes = Buffer.from(createHash("sha256").update(input).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeJoinAcquisition(body: Record<string, unknown>): {
  requestedSource: "direct" | "mall";
  mallSessionId: string | null;
} {
  const rawSource = String(body.source || "").trim();
  if (rawSource && rawSource !== "direct" && rawSource !== "mall") {
    const err: any = new Error("source must be direct or mall");
    err.statusCode = 400;
    err.code = "acquisition_source_invalid";
    throw err;
  }
  if (rawSource !== "mall") return { requestedSource: "direct", mallSessionId: null };

  const mallSessionId = String(body.mall_session_id || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,100}$/.test(mallSessionId)) {
    const err: any = new Error("mall_session_id must be an opaque 8-100 character token");
    err.statusCode = 400;
    err.code = "mall_session_id_invalid";
    throw err;
  }
  return { requestedSource: "mall", mallSessionId };
}

async function ensureLegalAcceptanceTables(withTxFn: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>) {
  await withTxFn(async c=>assertRequiredTables(c,["legal_acceptances"]));
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
  throwSellerAuthFailure("forbidden", null, "/app/seller", 403, {
    message: sellerStatusMessage(status),
    reasonCode: sellerStatusErrorCode(status)
  });
}

function sellerReturnTo(req: any, fallback = "/app/seller") {
  return safeSellerReturnTo(req?.headers?.["x-siton-return-to"], fallback);
}

function throwSellerAuthFailure(
  reason: SellerAuthFailureReason,
  req: any,
  fallback: string,
  statusCode: number,
  options?: { message?: string; reasonCode?: string }
): never {
  const failure = sellerAuthFailurePayload(reason, {
    returnTo: sellerReturnTo(req, fallback),
    ...(options?.message ? { message: options.message } : {}),
    ...(options?.reasonCode ? { reasonCode: options.reasonCode } : {})
  });
  const err: any = new Error(failure.message);
  err.statusCode = statusCode;
  err.code = failure.code;
  err.productCode = failure.product_code;
  err.publicError = failure.error;
  err.reasonCode = failure.reason_code;
  err.sellerAuth = failure.seller_auth;
  throw err;
}

// Lazily built Supabase access-token verifier. Null (inert) unless SUPABASE_URL
// is configured, so non-Supabase deployments and the test suite are unaffected.
let _supabaseVerifier: ReturnType<typeof buildSupabaseVerifier> | undefined;
function supabaseVerifier() {
  if (_supabaseVerifier === undefined) _supabaseVerifier = buildSupabaseVerifier();
  return _supabaseVerifier;
}

// R5B/R6 — a canonical seller may authenticate through Supabase Auth. The
// verified sub is bound to a seller account by auth_user_id (server-side).
// R6 capability policy: this route requires the SELLER capability explicitly —
// a token whose principal also holds other capabilities is fine, but a token
// with no seller binding cannot act as a seller. Ownership is still enforced
// downstream against deals.seller_id, so seller A cannot touch B.
async function supabaseSellerContext(req: any, c: any) {
  const verifier = supabaseVerifier();
  if (!verifier || !bearerToken(req)) return null;
  const caps = await resolveSupabaseCapabilities(req, c, verifier); // throws on invalid/duplicated binding
  if (!caps) return null;
  const actor = { seller: caps.seller };
  if (!actor.seller) {
    throwSellerAuthFailure("forbidden", req, "/app/seller", 403, {
      message: "this identity is not a seller",
      reasonCode: "not_a_seller_actor"
    });
    return null;
  }
  if (!actor.seller.auth_enabled) {
    throwSellerAuthFailure("forbidden", req, "/app/seller", 403, {
      message: "seller account is not enabled",
      reasonCode: "seller_auth_disabled"
    });
  }
  return {
    seller_id: actor.seller.seller_id,
    display_name: actor.seller.display_name,
    seller_status: actor.seller.seller_status || "Active",
    context_source: "supabase_session"
  };
}

async function requireSellerAuthority(req: any, c: any) {
  if (IS_DEMO_PREVIEW) {
    return sellerAuthorityFromDemoRequest(req);
  }
  // Prefer a Supabase Auth identity when a bearer token is present.
  const supabaseSeller = await supabaseSellerContext(req, c);
  if (supabaseSeller) return supabaseSeller;
  if (!SELLER_SESSION_SECRET) {
    throwSellerAuthFailure("unavailable", req, "/app/seller", 503);
  }
  const session = await sellerSessionContext(req, c);
  if (!session) {
    throwSellerAuthFailure(
      hasSellerSessionCookie(req.headers?.cookie) ? "expired" : "required",
      req,
      req.routerPath === "/deals" || req.routeOptions?.url === "/deals" ? "/app/seller/new" : "/app/seller",
      401
    );
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
// P0.3 — a MANUAL close is a reversible pause: it is legal from both open
// states, and a manually-closed deal may reopen (route-guarded: manual reason,
// deadline not passed, capacity not full, charging not started).
export const DEAL_TRANSITIONS: Record<string, string[]> = {
  Draft: ["PendingTarget", "Cancelled"],
  PendingTarget: ["TargetReached", "Failed", "ClosedForJoining"],
  TargetReached: ["ClosedForJoining"],
  ClosedForJoining: ["ReadyForCharging", "PendingTarget", "TargetReached"],
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
    // A rejected transition is a CONFLICT, not an internal fault. It is the
    // ordinary outcome of two lifecycle calls racing (publish vs cancel) or of a
    // caller acting on a deal that has already moved on - both expected, neither
    // a server error. Left unmapped it surfaced as 500 "internal_error", which
    // buries real faults in routine conflicts and, worse, tells a retrying
    // client to try again when the answer will never change.
    //
    // The message is deliberately unchanged: it is the contract the state-machine
    // suites match on, and it names both states, which is what an operator needs.
    const err: any = new Error(`Illegal ${stateType} transition ${from} to ${to}`);
    err.statusCode = 409;
    err.code = "ILLEGAL_STATE_TRANSITION";
    err.state_type = stateType;
    err.from_state = from;
    err.to_state = to;
    throw err;
  }
}

/**
 * A lost compare-and-swap on a lifecycle row. Same class as an illegal
 * transition: an expected conflict, never a server fault, so it must not be
 * reported as one.
 */
function stateConflict(entity: "deal" | "participant", entityId: string, expected: string) {
  const err: any = new Error(`State mismatch ${entity} ${entityId} expected ${expected}`);
  err.statusCode = 409;
  err.code = "STATE_CONFLICT";
  err.entity_type = entity;
  err.expected_state = expected;
  return err;
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

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>, requestBoundary = false): Promise<T> {
  const c = await pool.connect();
  let committed = false;
  try {
    await hitTestFault("db.before_begin");
    await c.query("BEGIN");
    await hitTestFault("db.after_begin");
    const r = await fn(c);
    await hitTestFault("db.before_commit");
    if (requestBoundary) await hitTestFault("web.request.before_commit");
    await c.query("COMMIT");
    committed = true;
    if (requestBoundary) await hitTestFault("web.request.after_commit");
    await hitTestFault("db.after_commit");
    return r;
  } catch (e) {
    if (!committed) await c.query("ROLLBACK").catch(() => undefined);
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
  claimOutboxEventById,
  reclaimStuckProcessing,
  markOutboxSent,
  markOutboxFailed,
  heartbeatOutboxLease,
  workerId: outboxWorkerId
} = buildOutboxWorkerHelpers({
  withTx,
  outboxPollMs: OUTBOX_POLL_MS,
  outboxMaxAttempts: OUTBOX_MAX_ATTEMPTS,
  workerId: process.env.WORKER_ID || `siton-worker-${process.pid}-${randomUUID()}`,
  leaseMs: Number(process.env.WORKER_LEASE_MS || 60_000),
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
const paymentBindings = buildPaymentAuthorizationBindings({ withTx });

// Server-authoritative Join binding enforcement:
// - Any non-mock provider mode is ALWAYS strict — Join only reaches AuthHeld
//   by consuming a verified server-side authorization binding.
// - The synthetic mock-backed provider keeps the legacy demo Join contract
//   unless PAYMENT_BINDING_ENFORCEMENT=strict is set, but even in legacy mode
//   a binding that EXISTS for the supplied authorization is verified and
//   consumed — mismatches always fail closed.
function paymentBindingEnforcementStrict(): boolean {
  if (String(process.env.PAYMENT_BINDING_ENFORCEMENT || "").trim().toLowerCase() === "strict") return true;
  return paymentProvider.mode !== "mock-backed";
}
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
        // The compare-and-swap did its job: somebody else moved this deal first.
        // That is a CONFLICT and the normal outcome of two lifecycle calls racing
        // - not an internal fault. Reported as 500 it told a retrying client to
        // try again (the answer will never change) and buried genuine faults in
        // routine contention. Message unchanged: it names the entity and the
        // state the caller was working from, which is what an operator needs.
        if (upd.rowCount !== 1) throw stateConflict("deal", op.entityId, op.fromState);
      } else {
        const col = op.stateType === "buyer_state" ? "buyer_state" : "money_state";
        const upd = await c.query(
          `UPDATE siton.participants
           SET ${col}=$1
           WHERE participant_id=$2 AND ${col}=$3`,
          [op.toState, op.entityId, op.fromState]
        );
        if (upd.rowCount !== 1) throw stateConflict("participant", op.entityId, op.fromState);
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
      `WITH completed AS (
         UPDATE siton.outbox_events
         SET status='sent', sent=true, sent_at=now(),
             last_error='obsolete_after_terminal_deal', updated_at=now()
         WHERE aggregate_id=$1
           AND event_type='deadline_check'
           AND status='pending'
         RETURNING event_uuid, attempt_count, lease_generation
       )
       INSERT INTO siton.operational_recovery_audit (
         subject_type, subject_id, action, worker_id, lease_generation, attempt_count,
         from_status, to_status, idempotency_key, reason_code, metadata
       )
       SELECT 'outbox_event', event_uuid::text, 'completion', $2, lease_generation,
              attempt_count, 'pending', 'sent',
              'outbox:' || event_uuid::text || ':' || lease_generation::text || ':completion:obsolete-deadline',
              'obsolete_after_terminal_deal', '{}'::jsonb
       FROM completed`,
      [dealId, outboxWorkerId]
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
         COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id', '') AS authorization_id,
         COALESCE(NULLIF(pab.provider_reference, ''), cap.payload->>'provider_reference', auth.payload->>'authorization_id', '') AS capture_reference
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       LEFT JOIN siton.payment_authorization_bindings pab
         ON pab.consumed_by_participant_id = p.participant_id
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

    if (result.result_class === "unknown" || result.result_class === "success") {
      // The refund may have been issued (transport loss, or a success without
      // a declared event). Never re-fire the refund blindly — reconcile.
      await finalizeAttemptResult({
        participant_id: p.participant_id,
        deal_id: dealId,
        attempt_type: attemptType,
        correlation_id: correlation,
        result_class: "unknown"
      });
      await schedulePaymentReconcile({
        participant_id: p.participant_id,
        deal_id: dealId,
        attempt_type: attemptType,
        correlation_id: correlation,
        operation: "refund",
        provider_reference: result.provider_reference || p.capture_reference || p.authorization_id || null,
        reason: result.result_class === "success" ? "success_without_reconciliation_event" : "provider_outcome_unknown"
      });
      continue;
    }

    throw new PermanentFailError(`permanent_fail refund participant ${p.participant_id}`);
  }
}

// ---------------------------------------------------------------------------
// R9A — Worker-owned payment reconciliation + release rail.
//
// UNKNOWN is not a terminal business outcome. Whenever a money operation ends
// without a provider-declared canonical result, the request/worker thread
// records the durable UNKNOWN attempt and hands resolution to these outbox
// jobs, which query the provider's authoritative status seam, apply exactly
// one canonical event, back off within outbox bounds, and fall back to a
// visible operational case + DLQ when the provider stays ambiguous.
// ---------------------------------------------------------------------------

type PaymentReconcilePayload = {
  participant_id: string;
  deal_id: string;
  attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund" | "release";
  correlation_id: string;
  operation: "capture" | "refund" | "release";
  provider_reference: string | null;
  reason: string;
};

async function schedulePaymentReconcile(args: PaymentReconcilePayload) {
  await withTx(async (c) => {
    await c.query(
      `INSERT INTO siton.outbox_events (
         event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at
       ) VALUES ('payment_reconcile','participant',$1,$2,'pending',0, now())
       ON CONFLICT DO NOTHING`,
      [args.participant_id, JSON.stringify(args)]
    );
  });
}

async function schedulePaymentRelease(args: { participant_id: string; deal_id: string; reason: string }) {
  await withTx(async (c) => {
    await c.query(
      `INSERT INTO siton.outbox_events (
         event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at
       ) VALUES ('payment_release','participant',$1,$2,'pending',0, now())
       ON CONFLICT DO NOTHING`,
      [args.participant_id, JSON.stringify(args)]
    );
  });
}

/**
 * Schedule provider-neutral release of every still-held authorization on a
 * failed/cancelled deal. Idempotent; transitions happen only in the Worker
 * release handler with authoritative provider proof.
 */
async function scheduleAuthorizationReleasesForDeal(dealId: string, reason: string) {
  const held = await withTx(async (c) => {
    const r = await c.query(
      `SELECT participant_id
       FROM siton.participants
       WHERE deal_id=$1
         AND money_state IN ('AuthHeld','AuthLocked','ChargeFailedRecovery')`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string }>;
  });
  for (const row of held) {
    await schedulePaymentRelease({ participant_id: row.participant_id, deal_id: dealId, reason }).catch(() => undefined);
  }
}

async function openPaymentOperationalCase(args: {
  autoKey: string;
  subject: string;
  description: string;
  correlationId?: string | null;
  requestId?: string | null;
}) {
  await withTx(async (c) => {
    await c.query(
      `INSERT INTO siton.operational_cases
         (case_type, status, priority, source, subject, description, opened_by, auto_key, correlation_id, request_id)
       VALUES ('PaymentMismatch','Open','High','System',$1,$2,'worker',$3,$4,$5)
       ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')
       DO UPDATE SET updated_at=now()`,
      [
        args.subject.slice(0, 200),
        args.description.slice(0, 2000),
        args.autoKey.slice(0, 200),
        args.correlationId || null,
        args.requestId || null
      ]
    );
  }).catch(() => undefined);
}

async function loadReconcileParticipant(participantId: string, dealId: string) {
  return withTx(async (c) => {
    const r = await c.query(
      `SELECT
         p.participant_id,
         p.buyer_id,
         p.buyer_state,
         p.money_state,
         p.qty,
         p.delivery_cost,
         d.price_per_unit,
         d.state AS deal_state,
         d.completion_window_until,
         (d.completion_window_until IS NOT NULL AND now() < d.completion_window_until) AS within_window,
         COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id', '') AS binding_reference,
         pab.amount_minor AS binding_amount_minor,
         pab.currency AS binding_currency
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       LEFT JOIN siton.payment_authorization_bindings pab
         ON pab.consumed_by_participant_id = p.participant_id
       LEFT JOIN LATERAL (
         SELECT payload
         FROM siton.audit_log
         WHERE entity_type = 'participant'
           AND entity_id = p.participant_id
           AND action_name = 'participant.join_authorize'
         ORDER BY created_at DESC
         LIMIT 1
       ) auth ON true
       WHERE p.participant_id=$1 AND p.deal_id=$2`,
      [participantId, dealId]
    );
    return r.rows[0] || null;
  });
}

async function handlePaymentReconcileEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
    max_attempts?: number;
  },
  eventId: string
) {
  const payload = (event.payload || {}) as PaymentReconcilePayload;
  const participantId = String(payload.participant_id || event.aggregate_id);
  const dealId = String(payload.deal_id || "");
  const operation = (payload.operation === "refund" || payload.operation === "release") ? payload.operation : "capture";
  const attemptType = payload.attempt_type || (operation === "refund" ? "refund" : operation === "release" ? "release" : "charge_start");
  const correlationId = String(payload.correlation_id || "");
  if (!dealId) throw new PermanentFailError(`payment_reconcile missing deal_id for participant ${participantId}`);

  const target = await loadReconcileParticipant(participantId, dealId);
  if (!target) throw new PermanentFailError(`payment_reconcile participant not found ${participantId}`);

  // Already resolved elsewhere (webhook truth, an earlier reconcile run, or a
  // parallel canonical path): nothing to do — exactly-once is preserved by the
  // canonical event dedupe, terminal-state protection and idempotent
  // transitions, not by this job.
  const waiting =
    operation === "capture"
      ? (target.buyer_state === "ChargingAttempt" && target.money_state === "ChargeAttempt") ||
        (target.buyer_state === "ChargeFailedCompletion" && target.money_state === "ChargeFailedRecovery" && attemptType === "recovery")
      : operation === "refund"
        ? ["ChargedSuccess", "RecoveredCharge"].includes(String(target.money_state))
        : ["AuthHeld", "AuthLocked", "ChargeFailedRecovery"].includes(String(target.money_state));
  if (!waiting) return;

  const providerReference = String(payload.provider_reference || target.binding_reference || "").trim();
  if (!paymentProvider.status) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-unsupported:${participantId}:${attemptType}`,
      subject: `Payment reconcile unsupported for participant ${participantId}`,
      description: `Provider ${paymentProvider.providerCode} exposes no status capability; UNKNOWN ${attemptType} attempt ${correlationId} requires manual provider verification. No state was guessed.`,
      correlationId
    });
    throw new PermanentFailError(`payment_reconcile_status_unsupported participant ${participantId}`);
  }
  if (!providerReference) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-no-reference:${participantId}:${attemptType}`,
      subject: `Payment reconcile missing provider reference for participant ${participantId}`,
      description: `UNKNOWN ${attemptType} attempt ${correlationId} has no durable provider reference; manual provider-side verification is required. No state was guessed.`,
      correlationId
    });
    throw new PermanentFailError(`payment_reconcile_missing_reference participant ${participantId}`);
  }

  const statusOperation = operation === "refund" ? "refund" : operation === "release" ? "release" : "capture";
  const status = await paymentProvider.status({
    provider_reference: providerReference,
    operation: statusOperation,
    correlation_id: correlationId || `reconcile:${eventId}`
  });

  // Amount safety: an authoritative amount that contradicts the binding is a
  // mismatch — fail closed into a visible case, never mutate state.
  const expectedAmountMinor = target.binding_amount_minor !== null && target.binding_amount_minor !== undefined
    ? Number(target.binding_amount_minor)
    : paymentMinorAmount({
        qty: Number(target.qty || 0),
        pricePerUnit: Number(target.price_per_unit || 0),
        deliveryCost: Number(target.delivery_cost || 0)
      });
  if (
    status.amount_minor !== null &&
    Number.isInteger(status.amount_minor) &&
    operation !== "release" &&
    Number(status.amount_minor) !== expectedAmountMinor
  ) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-amount-mismatch:${participantId}:${attemptType}`,
      subject: `Provider amount mismatch for participant ${participantId}`,
      description: `Provider reports ${status.amount_minor} minor units for ${attemptType} ${correlationId}; authoritative amount is ${expectedAmountMinor}. State was NOT mutated; manual reconciliation required.`,
      correlationId
    });
    throw new PermanentFailError(`payment_reconcile_amount_mismatch participant ${participantId}`);
  }

  const ingestResolution = async (eventType: "charge_captured" | "charge_failed" | "recovery_captured" | "recovery_failed" | "refund_issued") => {
    await ingestAndProcessPaymentEvent({
      provider: paymentProvider.providerCode,
      event_id: `reconcile:${correlationId || participantId}:${eventType}`,
      event_type: eventType,
      correlation_id: correlationId || null,
      participant_id: participantId,
      deal_id: dealId,
      provider_reference: status.provider_reference || providerReference,
      payload: {
        source: "payment_reconcile_worker",
        provider_reference: status.provider_reference || providerReference,
        provider_state: status.state,
        provider_final: status.final
      }
    });
    if (status.provider_reference) {
      await paymentBindings
        .updateProviderReferenceForParticipant(participantId, status.provider_reference)
        .catch(() => undefined);
    }
  };

  if (operation === "capture") {
    const isRecovery = attemptType === "recovery";
    if (status.state === "captured") {
      await ingestResolution(isRecovery ? "recovery_captured" : "charge_captured");
      return;
    }
    if (status.state === "failed" || (status.state === "authorized" && status.final)) {
      // Provider says the money was NOT captured (declined, or the hold is
      // still merely authorized and final): the attempt failed without money
      // movement.
      await ingestResolution(isRecovery ? "recovery_failed" : "charge_failed");
      if (!isRecovery) {
        // A charge failure resolved late must still get its recovery chance
        // while the completion window is open.
        await withTx(async (c) => {
          const deal = await c.query(
            `SELECT state, (completion_window_until IS NOT NULL AND now() < completion_window_until) AS within
             FROM siton.deals WHERE deal_id=$1`,
            [dealId]
          );
          if (deal.rows[0]?.state === "CompletionWindow" && deal.rows[0]?.within) {
            await c.query(
              `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
               VALUES ('recovery_deal','deal',$1,$2,'pending',0, now())
               ON CONFLICT DO NOTHING`,
              [dealId, JSON.stringify({ deal_id: dealId })]
            );
          }
        }).catch(() => undefined);
      }
      return;
    }
  } else if (operation === "refund") {
    if (status.state === "refunded") {
      await ingestResolution("refund_issued");
      return;
    }
    if ((status.state === "captured") && status.final) {
      // The refund never executed. Re-arm the deal-scoped refund job; the
      // UNKNOWN attempt is finalized as permanent_fail for this correlation.
      await finalizeAttemptResult({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: attemptType as any,
        correlation_id: correlationId,
        result_class: "permanent_fail"
      });
      await withTx(async (c) => {
        await c.query(
          `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
           VALUES ('refund_issue','deal',$1,$2,'pending',0, now())
           ON CONFLICT DO NOTHING`,
          [dealId, JSON.stringify({ deal_id: dealId, reason: "reconcile_refund_not_executed" })]
        );
      });
      return;
    }
  } else {
    // release
    if (status.state === "released") {
      await applyAuthorizationRelease(participantId, dealId, `reconcile:${eventId}`, correlationId);
      await finalizeAttemptResult({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: "release",
        correlation_id: correlationId,
        result_class: "success"
      });
      return;
    }
    if (status.state === "authorized" && status.final) {
      // The release never executed; re-arm the release job.
      await finalizeAttemptResult({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: "release",
        correlation_id: correlationId,
        result_class: "permanent_fail"
      });
      await schedulePaymentRelease({ participant_id: participantId, deal_id: dealId, reason: "reconcile_release_not_executed" });
      return;
    }
    if (status.state === "captured") {
      await openPaymentOperationalCase({
        autoKey: `payment-reconcile-release-captured:${participantId}`,
        subject: `Hold intended for release was captured (participant ${participantId})`,
        description: `Provider reports captured for a hold Siton tried to release (correlation ${correlationId}). Manual reconciliation required; no state was guessed.`,
        correlationId
      });
      throw new PermanentFailError(`payment_reconcile_release_captured participant ${participantId}`);
    }
  }

  // Still ambiguous (pending/unknown or an incompatible non-final state).
  // Bounded outbox retry with backoff; final exhaustion opens a manual-review
  // case and lands in the DLQ for operational visibility.
  const maxAttempts = Number(event.max_attempts || OUTBOX_MAX_ATTEMPTS);
  if (event.attempt_count + 1 >= maxAttempts) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-unresolved:${participantId}:${attemptType}`,
      subject: `UNKNOWN payment outcome unresolved for participant ${participantId}`,
      description: `Reconciliation exhausted ${maxAttempts} status lookups for ${attemptType} ${correlationId} (last provider state: ${status.state}${status.error_code ? `, error ${status.error_code}` : ""}). Manual provider verification required; no state was guessed.`,
      correlationId
    });
  }
  throw new Error(`payment_reconcile_unresolved participant ${participantId} state=${status.state}`);
}

/**
 * Apply the canonical AuthHeld/AuthLocked → AuthReleased transition with the
 * durable release proof already established by the caller.
 */
async function applyAuthorizationRelease(participantId: string, dealId: string, requestId: string, correlationId?: string | null) {
  const row = await withTx(async (c) => {
    const r = await c.query(
      `SELECT money_state FROM siton.participants WHERE participant_id=$1 AND deal_id=$2`,
      [participantId, dealId]
    );
    return r.rows[0] || null;
  });
  if (!row || !["AuthHeld", "AuthLocked", "ChargeFailedRecovery"].includes(String(row.money_state))) return false;
  await atomicTransition({
    entityType: "participant",
    entityId: participantId,
    dealId,
    stateType: "money_state",
    fromState: String(row.money_state),
    toState: "AuthReleased",
    actionName: "authorization.release",
    requestId,
    idempotencyKey: `auth-release:${dealId}:${participantId}`,
    outbox: null,
    payload: { correlation_id: correlationId || null }
  });
  await paymentBindings.markBindingReleasedForParticipant(participantId, "authorization_released").catch(() => undefined);
  return true;
}

async function handlePaymentReleaseEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
    max_attempts?: number;
  },
  eventId: string
) {
  const payload = (event.payload || {}) as { participant_id?: string; deal_id?: string; reason?: string };
  const participantId = String(payload.participant_id || event.aggregate_id);
  const dealId = String(payload.deal_id || "");
  if (!dealId) throw new PermanentFailError(`payment_release missing deal_id for participant ${participantId}`);

  const target = await loadReconcileParticipant(participantId, dealId);
  if (!target) throw new PermanentFailError(`payment_release participant not found ${participantId}`);
  if (!["AuthHeld", "AuthLocked", "ChargeFailedRecovery"].includes(String(target.money_state))) return; // already resolved

  const providerReference = String(target.binding_reference || "").trim();
  const correlation = `release:${eventId}:a${event.attempt_count}:${participantId}`;
  await recordAttemptBeforeIo({
    participant_id: participantId,
    deal_id: dealId,
    attempt_type: "release",
    correlation_id: correlation
  });

  if (!paymentProvider.release) {
    await finalizeAttemptResult({
      participant_id: participantId,
      deal_id: dealId,
      attempt_type: "release",
      correlation_id: correlation,
      result_class: "unknown"
    });
    await openPaymentOperationalCase({
      autoKey: `payment-release-unsupported:${participantId}`,
      subject: `Release unsupported by provider for participant ${participantId}`,
      description: `Provider ${paymentProvider.providerCode} exposes no release capability. The held authorization for deal ${dealId} requires the provider-approved cancel/expiry process. AuthReleased was NOT set without proof.`,
      correlationId: correlation
    });
    throw new PermanentFailError(`payment_release_unsupported participant ${participantId}`);
  }

  const releaseInput: Parameters<NonNullable<typeof paymentProvider.release>>[0] = {
    authorization_id: providerReference,
    correlation_id: correlation,
    participant_id: participantId,
    deal_id: dealId,
    buyer_id: String(target.buyer_id || ""),
    amount_minor: paymentMinorAmount({
      qty: Number(target.qty || 0),
      pricePerUnit: Number(target.price_per_unit || 0),
      deliveryCost: Number(target.delivery_cost || 0)
    }),
    currency: "ILS",
    request_id: `worker:${eventId}`
  };
  const result = await paymentProvider.release(releaseInput);

  if (result.result_class === "success") {
    await finalizeAttemptResult({
      participant_id: participantId,
      deal_id: dealId,
      attempt_type: "release",
      correlation_id: correlation,
      result_class: "success"
    });
    await applyAuthorizationRelease(participantId, dealId, `worker:${eventId}`, correlation);
    return;
  }

  if (result.result_class === "temporary_fail") {
    await finalizeAttemptResult({
      participant_id: participantId,
      deal_id: dealId,
      attempt_type: "release",
      correlation_id: correlation,
      result_class: "temporary_fail"
    });
    throw new Error(`temporary_fail release participant ${participantId}`);
  }

  if (result.result_class === "unknown") {
    await finalizeAttemptResult({
      participant_id: participantId,
      deal_id: dealId,
      attempt_type: "release",
      correlation_id: correlation,
      result_class: "unknown"
    });
    await schedulePaymentReconcile({
      participant_id: participantId,
      deal_id: dealId,
      attempt_type: "release",
      correlation_id: correlation,
      operation: "release",
      provider_reference: result.provider_reference || providerReference || null,
      reason: "release_outcome_unknown"
    });
    return;
  }

  await finalizeAttemptResult({
    participant_id: participantId,
    deal_id: dealId,
    attempt_type: "release",
    correlation_id: correlation,
    result_class: "permanent_fail"
  });
  await openPaymentOperationalCase({
    autoKey: `payment-release-failed:${participantId}`,
    subject: `Provider refused authorization release for participant ${participantId}`,
    description: `Release attempt ${correlation} permanently failed at provider ${paymentProvider.providerCode}. The hold remains represented as held; manual provider-side action required.`,
    correlationId: correlation
  });
  throw new PermanentFailError(`permanent_fail release participant ${participantId}`);
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
         COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id', '') AS authorization_id,
         COALESCE(pab.provider_code, auth.payload->>'authorization_provider', '') AS authorization_provider,
         COALESCE(pab.correlation_id, auth.payload->>'authorization_correlation_id', '') AS authorization_correlation_id
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       -- Canonical indexed provider-reference source (R9A); audit JSON stays
       -- as evidence-only fallback for pre-binding participants.
       LEFT JOIN siton.payment_authorization_bindings pab
         ON pab.consumed_by_participant_id = p.participant_id
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

    // The outbox attempt_count is encoded so each real provider retry is a
    // distinct attempt for the 30-minute charge cap (migration 050), while a
    // same-claim reprocess keeps the same correlation and stays idempotent.
    const correlation = `capture:${eventId}:a${event.attempt_count}:${p.participant_id}`;
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

    if (result.reconciliation_event_type && result.result_class !== "unknown") {
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
      if (result.result_class === "success" && result.provider_reference) {
        await paymentBindings
          .updateProviderReferenceForParticipant(p.participant_id, result.provider_reference)
          .catch(() => undefined);
      }
      continue;
    }

    // No provider-declared canonical outcome (transport UNKNOWN, or a success
    // without an event type). The provider may have moved money: NEVER retry
    // blindly — record UNKNOWN durably and hand recovery to the Worker-owned
    // reconciliation rail, which resolves it via authoritative status lookup.
    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      result_class: "unknown"
    });
    await schedulePaymentReconcile({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      operation: "capture",
      provider_reference: result.provider_reference || p.authorization_id || null,
      reason: result.result_class === "success" ? "success_without_reconciliation_event" : "provider_outcome_unknown"
    });
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
         COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id', '') AS authorization_id,
         COALESCE(pab.correlation_id, auth.payload->>'authorization_correlation_id', '') AS authorization_correlation_id
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       LEFT JOIN siton.payment_authorization_bindings pab
         ON pab.consumed_by_participant_id = p.participant_id
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
    // attempt_count-scoped so each real provider retry is a distinct attempt
    // for the 30-minute charge cap (migration 050); same-claim reprocess stays
    // idempotent under the same correlation.
    const correlation = `recovery:${eventId}:a${event.attempt_count}:${p.participant_id}`;
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
    if (result.reconciliation_event_type && result.result_class !== "unknown") {
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
      if (result.result_class === "success" && result.provider_reference) {
        await paymentBindings
          .updateProviderReferenceForParticipant(p.participant_id, result.provider_reference)
          .catch(() => undefined);
      }
      continue;
    }

    // No provider-declared canonical outcome — durable UNKNOWN, then the
    // reconciliation rail. Never a blind retry after possible money movement.
    await finalizeAttemptResult({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      result_class: "unknown"
    });
    await schedulePaymentReconcile({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      operation: "capture",
      provider_reference: result.provider_reference || p.authorization_id || null,
      reason: result.result_class === "success" ? "success_without_reconciliation_event" : "provider_outcome_unknown"
    });
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
  // Siton fee base = actual collected gross amount (price x qty + delivery),
  // excluding the authoritative VAT portion (explicit VAT authority; 0 only
  // under declared synthetic_zero configuration).
  const productGross = Number(r.qty) * Number(r.price_per_unit);
  const deliveryGross = Number(r.delivery_cost || 0);
  const grossAmount = productGross + deliveryGross;
  const vat = computeCustomerChargeVat({ productGrossAmount: productGross, deliveryGrossAmount: deliveryGross });
  const money = calculatePlatformFeeMoney({ grossAmount, vatAmount: vat.vat_amount });
  await enqueueInvoiceDocument({
    documentKey: `charge_receipt:${participantId}`,
    documentType: "charge_receipt",
    dealId,
    participantId,
    dealTitle: String(r.title || ""),
    qty: Number(r.qty),
    moneyStateAtIssue: String(r.money_state),
    grossAmount: money.gross_amount,
    platformFeeBaseAmount: money.platform_fee_base_amount,
    platformFeeVatAmount: money.platform_fee_vat_amount,
    platformFeeTotalAmount: money.platform_fee_total_amount,
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
  // Refund receipt mirrors charge receipt: fee base = price x qty + delivery,
  // excluding the authoritative VAT portion.
  const productGross = Number(r.qty) * Number(r.price_per_unit);
  const deliveryGross = Number(r.delivery_cost || 0);
  const grossAmount = productGross + deliveryGross;
  const vat = computeCustomerChargeVat({ productGrossAmount: productGross, deliveryGrossAmount: deliveryGross });
  const money = calculatePlatformFeeMoney({ grossAmount, vatAmount: vat.vat_amount });
  await enqueueInvoiceDocument({
    documentKey: `refund_receipt:${participantId}`,
    documentType: "refund_receipt",
    dealId,
    participantId,
    dealTitle: String(r.title || ""),
    qty: Number(r.qty),
    moneyStateAtIssue: "Refunded",
    grossAmount: money.gross_amount,
    platformFeeBaseAmount: money.platform_fee_base_amount,
    platformFeeVatAmount: money.platform_fee_vat_amount,
    platformFeeTotalAmount: money.platform_fee_total_amount,
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
    // Unrecovered participants on a completed deal still hold an uncaptured
    // authorization — release it (Worker-owned, provider-proofed).
    await scheduleAuthorizationReleasesForDeal(dealId, "deal_completed_unrecovered");

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
  // Release every still-held (uncaptured) authorization; captured participants
  // are refunded by the refund_issue job enqueued with the Failed transition.
  await scheduleAuthorizationReleasesForDeal(dealId, "deal_finalize_failed");

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
  max_attempts?: number;
}) {
  const eventId = event.event_uuid;
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new PermanentFailError(`invalid payload for ${event.event_type}`);
  }
  try {
    requireUuid(event.aggregate_id, "aggregate_id");
  } catch {
    throw new PermanentFailError(`invalid aggregate_id for ${event.event_type}`);
  }

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

    // A deadline check may only fail a deal AFTER its deadline has passed. If the
    // deadline is still in the future (e.g. this check was enqueued at publish
    // time and processed immediately by the continuous worker), defer it until
    // the deadline instead of failing a freshly published, still-joinable deal.
    const deadlineMs = new Date(String(deal.deadline || "")).getTime();
    if (Number.isFinite(deadlineMs) && Date.now() < deadlineMs) {
      throw new DeferredEventError("deadline_not_reached", new Date(deadlineMs));
    }

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
    // Release every still-held authorization for the failed deal (Worker-owned;
    // AuthReleased only with authoritative provider proof).
    await scheduleAuthorizationReleasesForDeal(dealId, "deal_deadline_failed");
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

  if (event.event_type === "payment_reconcile") {
    await handlePaymentReconcileEvent(event, eventId);
    return;
  }

  if (event.event_type === "payment_release") {
    await handlePaymentReleaseEvent(event, eventId);
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

  if (event.event_type === "viral_recompute") {
    // Growth analytics only: recompute the deal's viral tree metrics and roll
    // them up into the seller + platform caches. Never touches deal, buyer,
    // money, or notification state.
    const dealId = event.aggregate_id;
    const sellerId = await withTx(async (c) => {
      const metrics = await recomputeDealViralMetrics(c, dealId);
      return String((metrics as any)?.seller_id || "") || null;
    });
    await withTx(async (c) => {
      await recomputeAggregateViralMetrics(c, sellerId);
    });
    return;
  }

  throw new PermanentFailError(`unsupported outbox event type: ${event.event_type}`);
}

export async function processNextPendingOutboxEvent(limit = 1) {
  const batch = await claimOutboxBatch(limit);
  if (batch.length === 0) return null;
  const event = batch[0];
  if (!event) return null;
  return processClaimedOutboxEvent(event);
}

export async function claimPendingOutboxBatch(limit: number) {
  return claimOutboxBatch(limit);
}

export async function processClaimedOutboxEvent(event: Awaited<ReturnType<typeof claimOutboxBatch>>[number]) {
  await hitTestFault("worker.after_claim");
  let ownershipLost = false;
  let heartbeatInFlight = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatInFlight = heartbeatInFlight.then(async () => {
      const renewed = await heartbeatOutboxLease(event.event_uuid, event.lease_generation).catch(() => false);
      if (!renewed) ownershipLost = true;
    });
  }, Math.max(1_000, Math.floor(Number(process.env.WORKER_LEASE_MS || 60_000) / 3)));
  heartbeat.unref();
  try {
    await workerProcessEvent(event);
    await heartbeatInFlight;
    if (ownershipLost) throw new OutboxLeaseLostError(event.event_uuid);
    await hitTestFault("worker.before_ack");
    await markOutboxSent(event.event_uuid, event.lease_generation);
    return {
      event_uuid: event.event_uuid,
      event_type: event.event_type,
      status: "sent" as const
    };
  } catch (error) {
    if (ownershipLost || error instanceof OutboxLeaseLostError) {
      return {
        event_uuid: event.event_uuid,
        event_type: event.event_type,
        status: "lease_lost" as const,
        error: "outbox_lease_lost"
      };
    }
    try {
      await markOutboxFailed(event.event_uuid, event.lease_generation, error);
    } catch (failureError) {
      if (failureError instanceof OutboxLeaseLostError) {
        return {
          event_uuid: event.event_uuid,
          event_type: event.event_type,
          status: "lease_lost" as const,
          error: "outbox_lease_lost"
        };
      }
      throw failureError;
    }
    return {
      event_uuid: event.event_uuid,
      event_type: event.event_type,
      status: "failed" as const,
      error: String(error instanceof Error ? error.message : error)
    };
  } finally {
    clearInterval(heartbeat);
    await heartbeatInFlight.catch(() => undefined);
  }
}

export async function processOutboxEventById(eventId: string) {
  const claimed = await claimOutboxEventById(eventId);
  if (!claimed) return null;
  return processClaimedOutboxEvent(claimed);
}
const WORKER_EVENT_TIMEOUT_MS = 30_000;
// Events stuck in 'processing' longer than this are recycled back to 'pending'.
// Set to 2× WORKER_EVENT_TIMEOUT_MS so a legitimately-slow event can finish
// before the reclaim window opens.
const WORKER_STUCK_TIMEOUT_MS = Number(process.env.WORKER_STUCK_TIMEOUT_MS || 60_000);
export async function reclaimWorkerJobs(timeoutMs = WORKER_STUCK_TIMEOUT_MS) {
  const outbox = await reclaimStuckProcessing(timeoutMs);
  const invoices = await reclaimStuckInvoiceDocuments(pool, timeoutMs, app.log);
  return { outbox, invoices };
}

function storageCleanupErrorCode(error: unknown) {
  const value = error as { code?: unknown; name?: unknown } | null;
  return String(value?.code || value?.name || "storage_cleanup_failed").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

async function enqueueStorageCleanupTask(storageProvider: StorageProviderCode, storageKey: string, reason: string) {
  await pool.query(
    `INSERT INTO siton.storage_cleanup_tasks(storage_provider, storage_key, reason)
     VALUES ($1,$2,$3)
     ON CONFLICT (storage_provider, storage_key) WHERE status IN ('pending','processing')
     DO UPDATE SET reason=EXCLUDED.reason, updated_at=now()`,
    [storageProvider, storageKey, reason]
  );
}

export async function processStorageCleanupBatch(limit = 10, leaseMs = 60_000) {
  const processed: Array<{ task_id: string; status: "completed" | "pending" | "failed" }> = [];
  for (let index = 0; index < Math.max(1, Math.min(50, limit)); index++) {
    const claimed = await pool.query(
      `WITH candidate AS (
         SELECT task_id FROM siton.storage_cleanup_tasks
         WHERE (status='pending' AND available_at <= now())
            OR (status='processing' AND processing_started_at <= now() - ($1 * interval '1 millisecond'))
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE siton.storage_cleanup_tasks t
       SET status='processing', attempt_count=t.attempt_count+1, processing_started_at=now(), updated_at=now()
       FROM candidate WHERE t.task_id=candidate.task_id
       RETURNING t.task_id, t.storage_provider, t.storage_key, t.attempt_count, t.max_attempts`,
      [Math.max(0, leaseMs)]
    );
    if (!claimed.rowCount) break;
    const task = claimed.rows[0];
    await hitTestFault("cleanup.after_claim");
    try {
      const storage = getDealImageStorageAdapter();
      if (storage.providerCode !== task.storage_provider) {
        // Ephemeral-instance local files are unreachable once the runtime has
        // moved to a durable provider: there is nothing left to clean.
        if (String(task.storage_provider) === "local") {
          await pool.query(
            `UPDATE siton.storage_cleanup_tasks SET status='completed', completed_at=now(), last_error_code='local_provider_retired', updated_at=now()
             WHERE task_id=$1 AND status='processing' AND attempt_count=$2`,
            [task.task_id, task.attempt_count]
          );
          processed.push({ task_id: String(task.task_id), status: "completed" });
          continue;
        }
        throw Object.assign(new Error("storage_cleanup_provider_mismatch"), { code: "storage_cleanup_provider_mismatch" });
      }
      await storage.delete(String(task.storage_key));
      await hitTestFault("cleanup.before_ack");
      await pool.query(
        `UPDATE siton.storage_cleanup_tasks SET status='completed', completed_at=now(), last_error_code=NULL, updated_at=now()
         WHERE task_id=$1 AND status='processing' AND attempt_count=$2`,
        [task.task_id, task.attempt_count]
      );
      processed.push({ task_id: String(task.task_id), status: "completed" });
    } catch (error) {
      const terminal = Number(task.attempt_count) >= Number(task.max_attempts);
      await pool.query(
        `UPDATE siton.storage_cleanup_tasks
         SET status=$2, available_at=CASE WHEN $2='pending' THEN now() + (LEAST(300, power(2, attempt_count))::text || ' seconds')::interval ELSE available_at END,
             last_error_code=$3, updated_at=now()
         WHERE task_id=$1 AND status='processing' AND attempt_count=$4`,
        [task.task_id, terminal ? "failed" : "pending", storageCleanupErrorCode(error), task.attempt_count]
      );
      processed.push({ task_id: String(task.task_id), status: terminal ? "failed" : "pending" });
    }
  }
  return processed;
}
export async function runWorkerMaintenance() {
  // Crash recovery for the notification rail: stranded 'processing' rows are
  // reclaimed with a bounded attempt budget before the next flush.
  await reclaimStrandedNotifications(pool, Number(process.env.NOTIFICATION_STUCK_TIMEOUT_MS || 5 * 60_000)).catch(() => 0);
  await flushPendingNotifications(pool, notificationService, app.log);
  await enqueuePendingInvoiceDocumentOutboxEvents(pool);
  await processStorageCleanupBatch();
}

export async function assertWorkerDatabaseReady() {
  await assertCanonicalRuntimeReady(pool, "worker");
}

export function getWorkerIdentity() {
  return outboxWorkerId;
}

export async function closeWorkerDatabase() {
  await pool.end();
}
// Run the stuck-event reclaim every N poll cycles to amortise its cost.
const RECLAIM_EVERY_N_POLLS = 10;


// Query-string parameters that carry a CREDENTIAL rather than a filter. Fastify
// logs the full request URL, so anything here would otherwise be written to the
// application log on every request - and a log line outlives the request, is
// copied to aggregators, and is read by far more people.
//
// This is not hypothetical: the buyer's inquiry-thread access token travels as
// `?t=<token>` (src/frontend_runtime.ts, GET /api/inquiries/:threadId). That
// token grants read access to a private conversation, so leaving it in the log
// is a credential leak into a lower-security store.
//
// Masking here is the narrow fix for the LOGGING problem and changes no API.
// Moving the token out of the query string entirely is the deeper fix; it is a
// product/API change (existing buyer links carry `?t=`) and is recorded as an
// open item rather than done silently here.
const SENSITIVE_QUERY_KEYS = new Set([
  "t", "token", "access_token", "auth", "authorization",
  "key", "api_key", "admin_key", "secret", "password", "code", "signature", "sig"
]);

function redactUrlForLogs(rawUrl: string) {
  const url = String(rawUrl || "");
  const split = url.indexOf("?");
  if (split === -1) return url;
  const path = url.slice(0, split);
  const params = url.slice(split + 1).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) return pair;
    const key = pair.slice(0, eq);
    return SENSITIVE_QUERY_KEYS.has(decodeURIComponent(key).toLowerCase())
      ? `${key}=[redacted]`
      : pair;
  });
  return `${path}?${params.join("&")}`;
}

const app = Fastify({
  logger: {
    serializers: {
      // Mirrors Fastify's default request serializer, with the URL sanitized.
      req(request: any) {
        return {
          method: request.method,
          url: redactUrlForLogs(request.url),
          host: request.host ?? request.headers?.host,
          remoteAddress: request.ip ?? request.socket?.remoteAddress,
          remotePort: request.socket?.remotePort
        };
      }
    }
  },
  // The application already treats `x-request-id` as the canonical correlation
  // id: it normalises it onto the request and writes it into audit rows. Fastify
  // was minting a separate reqId for the log line, so a log entry and the audit
  // row for the same request carried different ids and could not be joined -
  // exactly the correlation you need during an incident. Same id everywhere now.
  // Pino JSON-encodes the value, so a caller cannot inject a forged log line.
  requestIdHeader: "x-request-id",
  trustProxy: true,
  bodyLimit: 8 * 1024 * 1024,
  rewriteUrl(req) {
    return rewriteCanonicalApiAlias(String(req.url || "/"));
  }
});

function applySecurityHeaders(reply: any) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  // P0.6-2 ROOT CAUSE: geolocation=() DISABLED the API for the page itself,
  // so "השתמש במיקום שלי" always failed instantly with PERMISSION_DENIED and
  // no browser prompt. geolocation=(self) lets OUR page ask the user (the
  // browser prompt/deny still fully applies); every other capability stays off.
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(self), payment=(), usb=(), serial=()");
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

// A NUL byte cannot exist in a PostgreSQL text value, so any query parameter
// carrying one is guaranteed to fail somewhere downstream - and it failed as a
// 500, not a 400: `GET /api/admin/support-cases?seller_id=%00` reached the
// driver and faulted. A caller-chosen value must never produce a server error,
// and the fix belongs here rather than in one handler because every route that
// forwards a query parameter into a query has the same exposure.
//
// Rejecting is right, not stripping: a NUL is never meaningful input, and
// silently rewriting it would change what the caller asked for. Control-character
// scrubbing already happens for stored text (seller_inquiries, pickup_location,
// frontend_runtime); this closes the query-string entry point.
app.addHook("onRequest", (req: any, reply: any, done) => {
  const query = req.query;
  if (query && typeof query === "object") {
    for (const value of Object.values(query as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (typeof entry === "string" && entry.indexOf("\u0000") !== -1) {
          void reply.code(400).send({ ok: false, error: "invalid_query_parameter", code: "NUL_BYTE_IN_QUERY" });
          return;
        }
      }
    }
  }
  done();
});

app.addHook("onRequest", (req: any, reply: any, done) => {
  applicationRequestTelemetry.start(req);
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
app.addHook("onResponse", (req: any, reply: any, done) => {
  applicationRequestTelemetry.finish(req, Number(reply.statusCode || 200));
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
// P0.7C — READ-ONLY public reads under the same prefixes (deal public JSON,
// activity feed, chat list) get their OWN per-IP budget so normal page
// polling can never exhaust the mutation budget above. Still bounded.
// Never stricter than the mutation budget: deployments/tests that lift
// RATE_LIMIT_SENSITIVE_MAX for bulk traffic lift the read budget with it.
const RATE_LIMIT_READ_MAX_CONFIGURED = Number(process.env.RATE_LIMIT_READ_MAX ?? 120);
const RATE_LIMIT_READ_MAX = RATE_LIMIT_READ_MAX_CONFIGURED <= 0 ? 0 : Math.max(RATE_LIMIT_READ_MAX_CONFIGURED, RATE_LIMIT_SENSITIVE_MAX);
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const RATE_LIMIT_SCALE_MODE = process.env.RATE_LIMIT_SCALE_MODE || "single_instance_only";

// Paths that get the tighter per-IP limit (prefix match without trailing slash)
const SENSITIVE_PATHS = ["/api/otp", "/api/deals/join", "/api/deals", "/api/support"];

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

// The sensitive bucket is for MUTATIONS (OTP, join, create, inquiry, support);
// a read-only method on the same prefix is public read polling.
export function rateLimitBucketFor(method: string, url: string): "sensitive" | "read" | "none" {
  if (!isSensitivePath(url)) return "none";
  return READ_ONLY_METHODS.has(String(method || "").toUpperCase()) ? "read" : "sensitive";
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

    // Sensitive-endpoint stricter bucket (mutations only) — read-only requests
    // on the same prefixes use their own bounded read budget (P0.7C).
    const bucket = rateLimitBucketFor(String(req.method || "GET"), url);
    if (bucket === "sensitive" && RATE_LIMIT_SENSITIVE_MAX > 0) {
      const sensitiveKey = `s:${ip}`;
      const sensitiveEntry = rateLimitStore.hit(sensitiveKey, now, RATE_LIMIT_WINDOW_MS);
      if (sensitiveEntry.count > RATE_LIMIT_SENSITIVE_MAX) {
        const retryAfterSecs = Math.ceil((sensitiveEntry.resetAt - now) / 1000);
        void reply
          .code(429)
          .header("Retry-After", String(retryAfterSecs))
          .send({ ok: false, error: "rate_limit_exceeded", retry_after: retryAfterSecs });
      }
    } else if (bucket === "read" && RATE_LIMIT_READ_MAX > 0) {
      const readKey = `r:${ip}`;
      const readEntry = rateLimitStore.hit(readKey, now, RATE_LIMIT_WINDOW_MS);
      if (readEntry.count > RATE_LIMIT_READ_MAX) {
        const retryAfterSecs = Math.ceil((readEntry.resetAt - now) / 1000);
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
  const hasSafeProductEnvelope = Boolean(error.publicError || error.productCode);
  const exposeDetails = httpStatus < 500 || hasSafeProductEnvelope;
  const payload: {
    ok: false;
    error: string;
    message?: string;
    code?: string;
    product_code?: string;
    reason_code?: string;
    seller_auth?: Record<string, unknown>;
  } = {
    ok: false,
    error: exposeDetails ? (error.publicError || error.message || "request_failed") : "internal_error"
  };
  if (exposeDetails && error.publicError && error.message) payload.message = String(error.message);
  if (exposeDetails && error.code) payload.code = String(error.code);
  if (exposeDetails && error.productCode) payload.product_code = String(error.productCode);
  if (exposeDetails && error.reasonCode) payload.reason_code = String(error.reasonCode);
  if (exposeDetails && error.sellerAuth && typeof error.sellerAuth === "object") payload.seller_auth = error.sellerAuth;
  return reply.code(httpStatus).send(payload);
});

app.get("/health", async () => ({ ok: true }));

app.get("/readiness", async (_req: any, reply: any) => {
  try {
    return await assertCanonicalRuntimeReady(pool, "web");
  } catch {
    return reply.code(503).send({ ok: false, code: "not_ready" });
  }
});

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
      `SELECT i.storage_key, i.mime_type, i.public_url, d.state, d.published_at, d.seller_id
       FROM siton.deal_images i
       JOIN siton.deals d ON d.deal_id=i.deal_id
       WHERE i.image_id=$1`,
      [imageId]
    );
    if (!result.rowCount) {
      const err: any = new Error("image not found");
      err.statusCode = 404;
      throw err;
    }
    const image = result.rows[0];
    if (!image.published_at) {
      // This route is PUBLIC by contract - it serves anonymous buyers for
      // published deals - so an unpublished image has to be refused here, and
      // the refusal must not answer "does this image exist?".
      //
      // The foreign-seller branch below already answered 404 like a missing
      // image. An ANONYMOUS caller did not: requireSellerAuthorityWithoutBody
      // threw 401, so 401 meant "this image is real but private" while 404 meant
      // "no such image" - an existence oracle over Draft imagery, which is never
      // public. Every caller who is not the owner now gets the same 404.
      const notFound = () => Object.assign(new Error("image not found"), { statusCode: 404 });
      let sellerAuthority: { seller_id: string } | null = null;
      try {
        sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
      } catch {
        throw notFound();
      }
      if (!sellerAuthority || normalizeSellerId(image.seller_id) !== sellerAuthority.seller_id) {
        throw notFound();
      }
    }
    return image;
  });
  // Published imagery with a durable public URL is served straight from the
  // storage CDN; the proxy remains authoritative for Draft (private) images
  // and for legacy records without a public URL.
  const externalPublicUrl = String(row.public_url || "").trim();
  if (row.published_at && /^https:\/\//.test(externalPublicUrl)) {
    return reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .redirect(externalPublicUrl, 302);
  }
  const file = await readDealImage(String(row.storage_key));
  return reply
    .header("content-type", String(row.mime_type))
    .header("cache-control", row.published_at ? "public, max-age=31536000, immutable" : "private, no-store")
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
  const title = readCreateDealTitle(body);
  if (!title) {
    const err: any = new Error("title is required");
    err.statusCode = 400;
    err.code = "title_required";
    throw err;
  }
  if (title.length > 200) {
    const err: any = new Error("title must be 200 characters or fewer");
    err.statusCode = 400;
    throw err;
  }
  const description = String(body.description || "").trim();
  if (description.length > DESCRIPTION_LONG_MAX) {
    const err: any = new Error(`description must be ${DESCRIPTION_LONG_MAX} characters or fewer`);
    err.statusCode = 400;
    err.code = "description_too_long";
    throw err;
  }
  const descriptionShort = String(body.description_short || "").trim();
  if (descriptionShort.length > DESCRIPTION_SHORT_MAX) {
    const err: any = new Error(`description_short must be ${DESCRIPTION_SHORT_MAX} characters or fewer`);
    err.statusCode = 400;
    err.code = "description_short_too_long";
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
          sort_order: Number.isFinite(Number(option?.sort_order)) ? Number(option.sort_order) : index,
          ...normalizeDeliveryCoordinates(option)
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

  const createIdempotencyKey = String(req.headers?.["idempotency-key"] || "").trim();
  if (createIdempotencyKey && !/^[A-Za-z0-9:_-]{8,160}$/.test(createIdempotencyKey)) {
    throw Object.assign(new Error("idempotency key is invalid"), { statusCode: 400, code: "IDEMPOTENCY_KEY_INVALID" });
  }
  const createRequestHash = createHash("sha256")
    .update(canonicalJson({
      title,
      description,
      description_short: descriptionShort,
      price_per_unit: priceRaw,
      min_units: minUnits,
      max_units: maxUnits,
      threshold_units: draftThreshold,
      deadline: body.deadline === undefined || body.deadline === null || body.deadline === "" ? null : deadlineIso,
      deal_type: dealType,
      delivery_options: dealType === "physical_product" ? deliveryOptions : [],
      voucher_terms: dealType === "voucher" ? voucherTermsInput : null,
      ticket_terms: dealType === "ticket" ? ticketTermsInput : null
    }))
    .digest("hex");

  const r = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "create_draft");
    const stableDealId = createIdempotencyKey
      ? deterministicUuid(`seller_deal_create:${sellerAuthority.seller_id}:${createIdempotencyKey}`)
      : randomUUID();
    if (createIdempotencyKey) {
      await c.query("SET LOCAL lock_timeout = '20s'");
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`seller_deal_create:${sellerAuthority.seller_id}:${createIdempotencyKey}`]
      );
      const prior = await c.query(
        `SELECT request_hash, response_jsonb
         FROM siton.idempotency_log
         WHERE entity_type='deal' AND entity_id=$1
           AND action_name='seller_deal_create' AND idempotency_key=$2`,
        [stableDealId, createIdempotencyKey]
      );
      if (prior.rowCount) {
        if (String(prior.rows[0].request_hash || "") !== createRequestHash) {
          throw Object.assign(new Error("idempotency key was already used with a different Draft payload"), {
            statusCode: 409,
            code: "IDEMPOTENCY_PAYLOAD_MISMATCH"
          });
        }
        return prior.rows[0].response_jsonb;
      }
    }
    const ins = await c.query(
      `INSERT INTO siton.deals
       (deal_id, title, description, description_short, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, deal_type)
       VALUES ($1,$2,$3,$11,$4,$5,$6,$7,$8,$9,$10)
       RETURNING deal_id, state, deal_type`,
      [
        stableDealId,
        title,
        description || null,
        priceRaw,
        minUnits,
        maxUnits,
        draftThreshold,
        deadlineIso,
        sellerAuthority.seller_id,
        dealType,
        descriptionShort || null
      ]
    );
    const deal = ins.rows[0];
    if (dealType === "physical_product") {
      for (const option of deliveryOptions) {
        await c.query(
          `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order, latitude, longitude)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [deal.deal_id, option.option_type, option.label, option.cost, option.sort_order, option.latitude, option.longitude]
        );
      }
    }
    if (dealType === "voucher" && voucherTermsInput) {
      await upsertVoucherTerms(c, String(deal.deal_id), voucherTermsInput);
    }
    if (dealType === "ticket" && ticketTermsInput) {
      await upsertTicketTerms(c, String(deal.deal_id), ticketTermsInput);
    }
    if (createIdempotencyKey) {
      await c.query(
        `INSERT INTO siton.idempotency_log
           (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb)
         VALUES ('deal',$1,'seller_deal_create',$2,$3,'OK',$4)`,
        [deal.deal_id, createIdempotencyKey, createRequestHash, JSON.stringify(deal)]
      );
    }
    return deal;
  }, true);
  return r;
});

app.patch("/api/seller/deals/:dealId/draft", async (req: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  await ensureDealTypeTables(withTx);
  const dealId = String(req.params.dealId || "");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const titleFields = ["title", "sellerTitle", "dealTitle", "productName", "name", "deal_name"];
  const hasTitle = titleFields.some(hasOwn);
  const hasEditableField = hasTitle || ["description", "description_short", "price_per_unit", "min_units", "max_units", "deadline", "delivery_options", "voucher_terms", "ticket_terms"].some(hasOwn);

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    // Authorization precedes every observation: an anonymous caller must not be
    // able to tell a malformed request from a well-formed one on this surface.
    requireUuid(dealId, "deal_id");
    if (!hasEditableField) {
      throw Object.assign(new Error("Draft patch contains no editable fields"), { statusCode: 400, code: "DRAFT_PATCH_EMPTY" });
    }
    const currentResult = await c.query(
      `SELECT deal_id, seller_id, state, title, description, description_short, price_per_unit,
              min_units, max_units, threshold_units, deadline, deal_type, updated_at
       FROM siton.deals
       WHERE deal_id=$1
       FOR UPDATE`,
      [dealId]
    );
    if (!currentResult.rowCount || normalizeSellerId(currentResult.rows[0].seller_id) !== sellerAuthority.seller_id) {
      throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
    }
    const current = currentResult.rows[0];
    if (String(current.state) !== "Draft") {
      throw Object.assign(new Error("only a Draft can be edited"), { statusCode: 409, code: "DEAL_NOT_EDITABLE" });
    }
    const expectedUpdatedAt = String(body.expected_updated_at || "").trim();
    if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== new Date(String(current.updated_at)).getTime()) {
      throw Object.assign(new Error("Draft changed since it was loaded"), { statusCode: 409, code: "DRAFT_EDITOR_STALE" });
    }
    if (hasOwn("deal_type") && normalizeDealType(body.deal_type, String(current.deal_type) as DealType) !== String(current.deal_type)) {
      throw Object.assign(new Error("deal_type cannot be changed by the generic Draft editor"), { statusCode: 409, code: "DEAL_TYPE_EDIT_REQUIRES_TERMS" });
    }
    if (hasOwn("voucher_terms") && String(current.deal_type) !== "voucher") {
      throw Object.assign(new Error("voucher_terms can only update a voucher Draft"), { statusCode: 409, code: "DEAL_TYPE_TERMS_MISMATCH" });
    }
    if (hasOwn("ticket_terms") && String(current.deal_type) !== "ticket") {
      throw Object.assign(new Error("ticket_terms can only update a ticket Draft"), { statusCode: 409, code: "DEAL_TYPE_TERMS_MISMATCH" });
    }
    if (hasOwn("voucher_terms") && (!body.voucher_terms || typeof body.voucher_terms !== "object" || Array.isArray(body.voucher_terms))) {
      throw Object.assign(new Error("voucher_terms must be an object"), { statusCode: 400, code: "voucher_terms_invalid" });
    }
    if (hasOwn("ticket_terms") && (!body.ticket_terms || typeof body.ticket_terms !== "object" || Array.isArray(body.ticket_terms))) {
      throw Object.assign(new Error("ticket_terms must be an object"), { statusCode: 400, code: "ticket_terms_invalid" });
    }

    const title = hasTitle ? readCreateDealTitle(body) : String(current.title || "").trim();
    if (!title) throw Object.assign(new Error("title is required"), { statusCode: 400, code: "title_required" });
    if (title.length > 200) throw Object.assign(new Error("title must be 200 characters or fewer"), { statusCode: 400, code: "title_too_long" });
    const description = hasOwn("description") ? String(body.description || "").trim() : String(current.description || "");
    if (description.length > DESCRIPTION_LONG_MAX) throw Object.assign(new Error(`description must be ${DESCRIPTION_LONG_MAX} characters or fewer`), { statusCode: 400, code: "description_too_long" });
    const descriptionShort = hasOwn("description_short") ? String(body.description_short || "").trim() : String(current.description_short || "");
    if (descriptionShort.length > DESCRIPTION_SHORT_MAX) throw Object.assign(new Error(`description_short must be ${DESCRIPTION_SHORT_MAX} characters or fewer`), { statusCode: 400, code: "description_short_too_long" });
    const price = hasOwn("price_per_unit") ? Number(body.price_per_unit) : Number(current.price_per_unit);
    if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error("price_per_unit must be a positive number"), { statusCode: 400, code: "price_invalid" });
    const minUnits = hasOwn("min_units") ? Number(body.min_units) : Number(current.min_units);
    const maxUnits = hasOwn("max_units") ? Number(body.max_units) : Number(current.max_units);
    if (!Number.isInteger(minUnits) || minUnits < 1) throw Object.assign(new Error("min_units must be a positive integer"), { statusCode: 400, code: "min_units_invalid" });
    if (!Number.isInteger(maxUnits) || maxUnits < minUnits) throw Object.assign(new Error("max_units must be an integer at least min_units"), { statusCode: 400, code: "max_units_invalid" });
    let deadline = new Date(current.deadline).toISOString();
    if (hasOwn("deadline")) {
      const deadlineMs = new Date(body.deadline).getTime();
      if (!Number.isFinite(deadlineMs)) throw Object.assign(new Error("deadline must be a valid ISO date"), { statusCode: 400, code: "deadline_invalid" });
      const deadlineDiffMs = deadlineMs - Date.now();
      if (deadlineDiffMs < DEADLINE_MIN_MS) throw Object.assign(new Error("deadline must be at least 2 hours in the future"), { statusCode: 400, code: "deadline_below_minimum" });
      if (deadlineDiffMs > DEADLINE_MAX_MS) throw Object.assign(new Error("deadline must be within 7 days from now"), { statusCode: 400, code: "deadline_above_maximum" });
      deadline = new Date(deadlineMs).toISOString();
    }

    const updated = await c.query(
      `UPDATE siton.deals
       SET title=$2, description=$3, description_short=$9, price_per_unit=$4, min_units=$5, max_units=$6,
           threshold_units=$7, deadline=$8, updated_at=now()
       WHERE deal_id=$1
       RETURNING deal_id, state, title, description, description_short, price_per_unit, min_units,
                 max_units, threshold_units, deadline, deal_type, updated_at`,
      [dealId, title, description || null, price, minUnits, maxUnits, Math.ceil(0.9 * minUnits), deadline, descriptionShort || null]
    );

    if (hasOwn("delivery_options")) {
      if (!Array.isArray(body.delivery_options) || body.delivery_options.length > 5) {
        throw Object.assign(new Error("delivery_options must contain at most 5 options"), { statusCode: 400, code: "delivery_options_invalid" });
      }
      const options = body.delivery_options.map((option: any, index: number) => ({
        option_type: ["delivery", "pickup", "distribution_point"].includes(String(option?.option_type || "")) ? String(option.option_type) : "pickup",
        label: String(option?.label || "").trim().slice(0, 160),
        cost: Number(option?.cost || 0),
        sort_order: Number.isInteger(Number(option?.sort_order)) ? Number(option.sort_order) : index,
        ...normalizeDeliveryCoordinates(option)
      }));
      if (options.some((option: any) => !option.label || !Number.isFinite(option.cost) || option.cost < 0)) {
        throw Object.assign(new Error("delivery_options contain invalid values"), { statusCode: 400, code: "delivery_options_invalid" });
      }
      await c.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]);
      if (String(current.deal_type) === "physical_product") {
        for (const option of options) {
          await c.query(
            `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order, latitude, longitude)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [dealId, option.option_type, option.label, option.cost, option.sort_order, option.latitude, option.longitude]
          );
        }
      }
    }
    if (hasOwn("voucher_terms")) await upsertVoucherTerms(c, dealId, body.voucher_terms);
    if (hasOwn("ticket_terms")) await upsertTicketTerms(c, dealId, body.ticket_terms);
    return { ok: true, reused_draft: true, draft: updated.rows[0] };
  });
});

// P0.4-4 — delivery/pickup editing OUTSIDE the Draft editor.
// A fundamental deal field must stay visible AND safely editable:
//   * Draft: always editable (same semantics as the Draft PATCH)
//   * published (PendingTarget/TargetReached/ClosedForJoining): editable ONLY
//     while ZERO reliance exists — no participant row was EVER created (even
//     dropped buyers relied on the option list) and no payment authorization
//     binding references the deal
//   * any later state: locked
// The change is transactional (deal row FOR UPDATE) and recorded in the
// append-only siton.deal_field_change_audit rail (migration 059) — the
// state-transition audit_log rightly refuses non-transition rows.
app.put("/api/seller/deals/:dealId/delivery", async (req: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  const dealId = String(req.params.dealId || "");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    // Authorization precedes every observation (see the draft patch route).
    requireUuid(dealId, "deal_id");
    if (!Array.isArray(body.delivery_options) || body.delivery_options.length === 0 || body.delivery_options.length > 5) {
      throw Object.assign(new Error("delivery_options must contain 1-5 options"), { statusCode: 400, code: "delivery_options_invalid" });
    }
    const r = await c.query(
      `SELECT seller_id, state, deal_type FROM siton.deals WHERE deal_id=$1 FOR UPDATE`,
      [dealId]
    );
    if (!r.rowCount || normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id) {
      throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
    }
    const state = String(r.rows[0].state);
    if (String(r.rows[0].deal_type) !== "physical_product") {
      throw Object.assign(new Error("delivery options apply to physical products only"), { statusCode: 409, code: "delivery_not_applicable" });
    }
    if (state !== "Draft") {
      if (!["PendingTarget", "TargetReached", "ClosedForJoining"].includes(state)) {
        throw Object.assign(new Error("delivery is locked in this deal state"), { statusCode: 409, code: "delivery_locked_state" });
      }
      const reliance = await c.query(
        `SELECT (SELECT count(*)::int FROM siton.participants WHERE deal_id=$1) AS participants,
                (SELECT count(*)::int FROM siton.payment_authorization_bindings WHERE deal_id=$1) AS bindings`,
        [dealId]
      );
      if (Number(reliance.rows[0].participants) > 0 || Number(reliance.rows[0].bindings) > 0) {
        throw Object.assign(new Error("delivery cannot change after buyers relied on it"), { statusCode: 409, code: "delivery_locked_after_reliance" });
      }
    }

    const options = body.delivery_options.map((option: any, index: number) => ({
      option_type: ["delivery", "pickup", "distribution_point"].includes(String(option?.option_type || "")) ? String(option.option_type) : "pickup",
      label: String(option?.label || "").trim().slice(0, 160),
      cost: Number(option?.cost || 0),
      sort_order: Number.isInteger(Number(option?.sort_order)) ? Number(option.sort_order) : index,
      ...normalizeDeliveryCoordinates(option)
    }));
    if (options.some((option: any) => !option.label || !Number.isFinite(option.cost) || option.cost < 0)) {
      throw Object.assign(new Error("delivery_options contain invalid values"), { statusCode: 400, code: "delivery_options_invalid" });
    }
    // P0.7 — a PUBLISHED deal can never end up advertising self-pickup without a
    // location (a Draft may stay incomplete; publish enforces the same rule).
    if (state !== "Draft" && pickupOptionsMissingLocation(options).length) {
      throw Object.assign(new Error("self-pickup options require a usable pickup location"), { statusCode: 409, code: "pickup_location_required" });
    }

    const before = await c.query(
      `SELECT option_type, label, cost, sort_order, latitude, longitude
       FROM siton.deal_delivery_options WHERE deal_id=$1 ORDER BY sort_order ASC`,
      [dealId]
    );
    await c.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]);
    const inserted: any[] = [];
    for (const option of options) {
      const row = await c.query(
        `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order, latitude, longitude)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING option_id, option_type, label, cost, sort_order, latitude, longitude`,
        [dealId, option.option_type, option.label, option.cost, option.sort_order, option.latitude, option.longitude]
      );
      inserted.push(row.rows[0]);
    }
    await c.query(
      `INSERT INTO siton.deal_field_change_audit
         (deal_id, seller_id, field_scope, deal_state, old_value, new_value, request_id)
       VALUES ($1,$2,'delivery_options',$3,$4,$5,$6)`,
      [dealId, sellerAuthority.seller_id, state, JSON.stringify(before.rows), JSON.stringify(options), requestId]
    );
    await c.query(`UPDATE siton.deals SET updated_at=now() WHERE deal_id=$1`, [dealId]);
    return {
      ok: true,
      state,
      delivery_options: inserted.map((row: any) => ({
        option_id: row.option_id,
        option_type: row.option_type,
        label: row.label,
        cost: Number(row.cost || 0),
        sort_order: Number(row.sort_order || 0),
        latitude: row.latitude === null ? null : Number(row.latitude),
        longitude: row.longitude === null ? null : Number(row.longitude)
      }))
    };
  });
});

// P0.3 — pickup coordinates: seller-chosen via explicit browser geolocation.
// Only finite in-range values persist; anything else stays NULL.
function normalizeDeliveryCoordinates(option: any): { latitude: number | null; longitude: number | null } {
  const lat = Number(option?.latitude);
  const lng = Number(option?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lng * 1e6) / 1e6 };
  }
  return { latitude: null, longitude: null };
}

function readCreateDealTitle(body: Record<string, any>) {
  for (const field of ["title", "sellerTitle", "dealTitle", "productName", "name", "deal_name"]) {
    const value = String(body?.[field] || "").trim();
    if (value) return value;
  }
  return "";
}

app.post("/api/seller/deals/:dealId/duplicate", async (req: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  const sourceDealId = String(req.params.dealId || "");
  requireUuid(sourceDealId, "deal_id");

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "create_draft");
    const source = await c.query(
      `SELECT deal_id, seller_id, title, description, price_per_unit, min_units, max_units
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
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      err.code = "deal_not_found";
      throw err;
    }

    const minUnits = Math.max(1, Number(sourceDeal.min_units || 1));
    const maxUnits = Math.max(minUnits, Number(sourceDeal.max_units || minUnits));
    const thresholdUnits = Math.ceil(0.9 * minUnits);
    const draftDeadline = new Date(Date.now() + DEADLINE_DEFAULT_MS).toISOString();
    const inserted = await c.query(
      `INSERT INTO siton.deals
         (title, description, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Draft')
       RETURNING deal_id, state`,
      [
        String(sourceDeal.title || ""),
        String(sourceDeal.description || "") || null,
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
  const imageIdempotencyKey = String(req.headers?.["idempotency-key"] || "").trim();
  if (imageIdempotencyKey.length > 200) {
    throw Object.assign(new Error("idempotency key is too long"), { statusCode: 400, code: "IDEMPOTENCY_KEY_INVALID" });
  }
  const imageRequestHash = createHash("sha256")
    .update(parsed.mimeType)
    .update("\0")
    .update(parsed.base64Data)
    .update("\0")
    .update(originalFilename || "")
    .update("\0")
    .update(String(Boolean(isAccepted(body.is_primary))))
    .update("\0")
    .update(String(body.sort_order ?? ""))
    .digest("hex");

  const response = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    // Serialize image-list mutations for this deal across Web instances.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('deal-image:' || $1, 0))", [dealId]);
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
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    if (String(deal.state) !== "Draft") {
      const err: any = new Error("deal already published");
      err.statusCode = 409;
      err.code = "deal_already_published";
      throw err;
    }
    if (imageIdempotencyKey) {
      const prior = await c.query(
        `SELECT request_hash, response_jsonb
         FROM siton.idempotency_log
         WHERE entity_type='deal' AND entity_id=$1
           AND action_name='seller_deal_image_upload' AND idempotency_key=$2
         LIMIT 1`,
        [dealId, imageIdempotencyKey]
      );
      if (prior.rowCount) {
        if (String(prior.rows[0].request_hash || "") !== imageRequestHash) {
          throw Object.assign(new Error("idempotency key was already used with a different image payload"), {
            statusCode: 409,
            code: "IDEMPOTENCY_PAYLOAD_MISMATCH"
          });
        }
        const replay = prior.rows[0].response_jsonb && typeof prior.rows[0].response_jsonb === "object"
          ? prior.rows[0].response_jsonb
          : {};
        return { ...replay, idempotent_replay: true };
      }
    }
    const existingImages = await c.query(
      `SELECT image_id, is_primary FROM siton.deal_images WHERE deal_id=$1 ORDER BY sort_order ASC, created_at ASC`,
      [dealId]
    );
    if (existingImages.rowCount >= DEAL_IMAGE_LIMIT) {
      const err: any = new Error(`deal can have up to ${DEAL_IMAGE_LIMIT} images`);
      err.statusCode = 400;
      err.code = "deal_image_limit";
      throw err;
    }
    const requestedPrimary = isAccepted(body.is_primary) || existingImages.rowCount === 0 || !existingImages.rows.some((row: any) => Boolean(row.is_primary));
    const sortOrderRaw = Number(body.sort_order);
    const sortOrder = Number.isInteger(sortOrderRaw) && sortOrderRaw >= 0 ? Math.min(sortOrderRaw, DEAL_IMAGE_LIMIT - 1) : existingImages.rowCount;

    const saved = await saveDealImage({
      dealId,
      originalFilename,
      mimeType: parsed.mimeType,
      base64Data: parsed.base64Data
    });

    let responsePayload: any;
    try {
      if (requestedPrimary) {
        await c.query(`UPDATE siton.deal_images SET is_primary=false WHERE deal_id=$1`, [dealId]);
      }
      const inserted = await c.query(
        `INSERT INTO siton.deal_images
           (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type, size_bytes, checksum_sha256, sort_order, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING image_id, deal_id, mime_type, size_bytes, is_primary, sort_order`,
        [
          dealId,
          saved.storage_provider,
          saved.storage_key,
          saved.public_url,
          saved.original_filename,
          saved.mime_type,
          saved.size_bytes,
          saved.checksum_sha256,
          sortOrder,
          requestedPrimary
        ]
      );
      const image = inserted.rows[0];
      responsePayload = {
        ok: true,
        image: {
          image_id: image.image_id,
          deal_id: image.deal_id,
          public_url: saved.public_url || getDealImagePublicUrl(image),
          image_url: saved.public_url || getDealImagePublicUrl(image),
          mime_type: image.mime_type,
          size_bytes: Number(image.size_bytes),
          is_primary: Boolean(image.is_primary),
          sort_order: Number(image.sort_order || 0)
        }
      };
      if (imageIdempotencyKey) {
        await c.query(
          `INSERT INTO siton.idempotency_log
             (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb)
           VALUES ('deal',$1,'seller_deal_image_upload',$2,$3,'OK',$4)`,
          [dealId, imageIdempotencyKey, imageRequestHash, JSON.stringify(responsePayload)]
        );
      }
    } catch (error) {
      try {
        await deleteDealImageFile(saved.storage_key);
      } catch (cleanupError) {
        await enqueueStorageCleanupTask(saved.storage_provider, saved.storage_key, "deal_image_metadata_write_failed").catch((enqueueError) => {
          app.log.error({ cleanup_error_code: storageCleanupErrorCode(cleanupError), enqueue_error_code: storageCleanupErrorCode(enqueueError) }, "storage_cleanup_enqueue_failed");
        });
      }
      throw error;
    }
    return responsePayload;
  });

  // A successful write must not be visible to the client before COMMIT.
  await hitTestFault("http.upload.after_commit_before_response");
  return reply.code(201).send(response);
});

app.patch("/api/seller/deals/:dealId/images/order", async (req: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  const dealId = String(req.params.dealId || "");
  requireUuid(dealId, "deal_id");
  const body = req.body || {};
  const requestedOrder = Array.isArray(body.ordered_image_ids)
    ? body.ordered_image_ids.map((value: unknown) => String(value || "").trim())
    : null;
  const requestedPrimary = body.primary_image_id === null || body.primary_image_id === undefined
    ? null
    : String(body.primary_image_id || "").trim();
  if (requestedOrder && requestedOrder.length > DEAL_IMAGE_LIMIT) {
    throw Object.assign(new Error(`deal can have up to ${DEAL_IMAGE_LIMIT} images`), { statusCode: 400, code: "deal_image_limit" });
  }
  for (const imageId of requestedOrder || []) requireUuid(imageId, "image_id");
  if (requestedPrimary) requireUuid(requestedPrimary, "primary_image_id");
  if (requestedOrder && new Set(requestedOrder).size !== requestedOrder.length) {
    throw Object.assign(new Error("ordered_image_ids must not contain duplicates"), { statusCode: 400, code: "DEAL_IMAGE_ORDER_INVALID" });
  }

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('deal-image:' || $1, 0))", [dealId]);
    const dealResult = await c.query(`SELECT seller_id, state FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
    if (!dealResult.rowCount || normalizeSellerId(dealResult.rows[0].seller_id) !== sellerAuthority.seller_id) {
      throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
    }
    // P0.2 — reordering and choosing the primary image are PRESENTATIONAL over
    // the same locked image set, so they stay allowed after publication too
    // (adding/removing images remains Draft-only: buyers joined on what they
    // saw, and this route can neither add nor remove).
    const existing = await c.query(
      `SELECT image_id, public_url, mime_type, size_bytes, is_primary, sort_order
       FROM siton.deal_images
       WHERE deal_id=$1
       ORDER BY sort_order ASC, created_at ASC
       FOR UPDATE`,
      [dealId]
    );
    const existingIds = existing.rows.map((row: any) => String(row.image_id));
    const orderedIds = requestedOrder || existingIds;
    if (orderedIds.length !== existingIds.length || orderedIds.some((imageId: string) => !existingIds.includes(imageId))) {
      throw Object.assign(new Error("ordered_image_ids must contain every current deal image exactly once"), {
        statusCode: 409,
        code: "DEAL_IMAGE_ORDER_STALE"
      });
    }
    const currentPrimary = existing.rows.find((row: any) => Boolean(row.is_primary));
    const primaryImageId = requestedPrimary || String(currentPrimary?.image_id || orderedIds[0] || "");
    if (primaryImageId && !existingIds.includes(primaryImageId)) {
      throw Object.assign(new Error("primary_image_id must belong to this Draft"), { statusCode: 400, code: "DEAL_IMAGE_PRIMARY_INVALID" });
    }

    await c.query(`UPDATE siton.deal_images SET is_primary=false WHERE deal_id=$1`, [dealId]);
    for (const [sortOrder, imageId] of orderedIds.entries()) {
      await c.query(
        `UPDATE siton.deal_images
         SET sort_order=$3, is_primary=($2=$4)
         WHERE deal_id=$1 AND image_id=$2`,
        [dealId, imageId, sortOrder, primaryImageId || null]
      );
    }
    const updated = await c.query(
      `SELECT image_id, deal_id, public_url, mime_type, size_bytes, is_primary, sort_order
       FROM siton.deal_images
       WHERE deal_id=$1
       ORDER BY sort_order ASC, created_at ASC`,
      [dealId]
    );
    return {
      ok: true,
      images: updated.rows.map((image: any) => ({
        image_id: image.image_id,
        deal_id: image.deal_id,
        public_url: resolveDealImageUrl(image),
        image_url: resolveDealImageUrl(image),
        mime_type: image.mime_type,
        size_bytes: Number(image.size_bytes),
        is_primary: Boolean(image.is_primary),
        sort_order: Number(image.sort_order || 0)
      }))
    };
  });
});

app.delete("/api/seller/deals/:dealId/images/:imageId", async (req: any, reply: any) => {
  const dealId = String(req.params.dealId || "");
  const imageId = String(req.params.imageId || "");
  requireUuid(dealId, "deal_id");
  requireUuid(imageId, "image_id");
  const removed = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('deal-image:' || $1, 0))", [dealId]);
    const result = await c.query(
      `SELECT i.storage_provider, i.storage_key, i.is_primary, d.seller_id, d.state
       FROM siton.deal_images i JOIN siton.deals d ON d.deal_id=i.deal_id
       WHERE i.deal_id=$1 AND i.image_id=$2 FOR UPDATE`,
      [dealId, imageId]
    );
    if (!result.rowCount) throw Object.assign(new Error("deal image not found"), { statusCode: 404, code: "deal_image_not_found" });
    const image = result.rows[0];
    if (normalizeSellerId(image.seller_id) !== sellerAuthority.seller_id) throw Object.assign(new Error("deal image not found"), { statusCode: 404, code: "deal_image_not_found" });
    if (String(image.state) !== "Draft") throw Object.assign(new Error("deal already published"), { statusCode: 409, code: "deal_already_published" });
    await c.query(`DELETE FROM siton.deal_images WHERE image_id=$1`, [imageId]);
    if (image.is_primary) {
      await c.query(
        `UPDATE siton.deal_images SET is_primary=true
         WHERE image_id=(SELECT image_id FROM siton.deal_images WHERE deal_id=$1 ORDER BY sort_order, created_at LIMIT 1)`,
        [dealId]
      );
    }
    return { storage_provider: image.storage_provider as StorageProviderCode, storage_key: String(image.storage_key) };
  });

  let deletion: "deleted" | "scheduled" = "deleted";
  try {
    await deleteDealImageFile(removed.storage_key);
  } catch (error) {
    await enqueueStorageCleanupTask(removed.storage_provider, removed.storage_key, "deal_image_deleted");
    deletion = "scheduled";
  }
  await hitTestFault("http.delete.after_commit_before_response");
  return reply.send({ ok: true, deletion });
});

// P0.2 — seller deletes an UNUSED deal. Safe canonical semantics:
//   * the seller owns the deal
//   * ZERO participation and ZERO financial activity (participants, payment
//     attempts, authorization bindings, fee-ledger rows, webhook evidence)
//   * Draft always qualifies; a published deal qualifies only while completely
//     untouched
// Anything with history uses the canonical cancellation path instead.
// audit_log / legal_acceptances / operational_cases rows are deliberately
// KEPT (soft references — the compliance trail survives the deal row).
// Storage objects are removed via the canonical cleanup rail.
app.delete("/api/seller/deals/:dealId", async (req: any, reply: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  const dealId = String(req.params.dealId || "");
  requireUuid(dealId, "deal_id");
  const result = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('deal-delete:' || $1, 0))", [dealId]);
    const dealResult = await c.query(
      `SELECT deal_id, seller_id, state FROM siton.deals WHERE deal_id=$1 FOR UPDATE`,
      [dealId]
    );
    if (!dealResult.rowCount || normalizeSellerId(dealResult.rows[0].seller_id) !== sellerAuthority.seller_id) {
      throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
    }
    const state = String(dealResult.rows[0].state);
    const activity = await c.query(
      `SELECT
         (SELECT count(*) FROM siton.participants WHERE deal_id=$1) AS participants,
         (SELECT count(*) FROM siton.payment_attempts WHERE deal_id=$1) AS payment_attempts,
         (SELECT count(*) FROM siton.payment_authorization_bindings WHERE deal_id=$1) AS bindings,
         (SELECT count(*) FROM siton.platform_fee_money_events WHERE deal_id=$1) AS fee_events,
         (SELECT count(*) FROM siton.webhook_events WHERE deal_id=$1) AS webhook_events`,
      [dealId]
    );
    const a = activity.rows[0];
    const untouched = ["participants", "payment_attempts", "bindings", "fee_events", "webhook_events"]
      .every((key) => Number(a[key] || 0) === 0);
    if (!untouched) {
      throw Object.assign(new Error("deal has participation or financial history and cannot be deleted"), {
        statusCode: 409,
        code: "deal_delete_not_allowed"
      });
    }
    // Storage objects: schedule canonical cleanup for every image blob.
    const images = await c.query(
      `SELECT storage_provider, storage_key FROM siton.deal_images WHERE deal_id=$1`,
      [dealId]
    );
    for (const row of images.rows) {
      if (row.storage_key) {
        await enqueueStorageCleanupTask(String(row.storage_provider || "local") as StorageProviderCode, String(row.storage_key), "seller_deal_deleted");
      }
    }
    // Non-FK rows that must not outlive the deal (a pending deadline_check on
    // a missing deal, or a create-idempotency replay returning a dangling id).
    await c.query(`DELETE FROM siton.outbox_events WHERE aggregate_type='deal' AND aggregate_id=$1`, [dealId]);
    await c.query(`DELETE FROM siton.outbox_dlq WHERE aggregate_type='deal' AND aggregate_id::text=$1::text`, [dealId]);
    await c.query(`DELETE FROM siton.idempotency_log WHERE entity_type='deal' AND entity_id=$1`, [dealId]);
    await c.query(`DELETE FROM siton.viral_metrics_cache WHERE scope_type='deal' AND scope_id=$1`, [dealId]);
    // Tombstone BEFORE the row disappears. audit_log deliberately enforces the
    // canonical state machine (a "Deleted" pseudo-state is illegal there), so
    // the durable evidence lives as a CLOSED operational case — the one record
    // type designed to survive deletion of what it references.
    await c.query(
      `INSERT INTO siton.operational_cases
         (case_type, status, priority, source, deal_id, seller_id, opened_by, subject, description, resolution_note, closed_at)
       VALUES ('Other','Closed','Low','System',$1,$2,'seller_deal_delete',$3,$4,'seller deleted an unused deal (zero participation, zero financial activity)', now())`,
      [
        dealId,
        sellerAuthority.seller_id,
        `מחיקת עסקה ללא פעילות: ${dealId}`,
        JSON.stringify({ previous_state: state, image_count: images.rowCount, deleted_at: new Date().toISOString() })
      ]
    );
    // The deal row itself — FKs cascade the content tables (images, options,
    // terms, chat, viral rows); nothing financial exists by the guard above.
    await c.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
    return { ok: true, deleted: true, deal_id: dealId, previous_state: state };
  }, true);
  return reply.send(result);
});

app.post("/deals/:id/publish", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const body = req.body || {};
  if (!isAccepted(body.seller_terms_accepted) || !isAccepted(body.seller_critical_terms_accepted) || !isAccepted(body.seller_threshold_90_accepted)) {
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
    const isProductionLike =
      process.env.NODE_ENV === "production" ||
      process.env.APP_ENV === "production" ||
      process.env.RENDER === "true" ||
      Boolean(process.env.RENDER_EXTERNAL_URL);
    if (isProductionLike && String(prof.verification_status || "pending") !== "approved") {
      const err: any = new Error("seller KYC is not approved");
      err.statusCode = 409;
      err.code = "seller_kyc_not_approved";
      throw err;
    }

    // P0.7 — pickup readiness: a physical deal that offers self-pickup or a
    // distribution point may only go live when EACH such option carries a
    // usable location (address text or explicit coordinates). The rule is the
    // shared pickup_location module — the same one the wizard, the publish
    // checklist and the public renderer use. Legacy deals already published
    // without a location stay readable; this gate runs only at publish time.
    const dealTypeRow = await c.query(`SELECT deal_type FROM siton.deals WHERE deal_id=$1`, [dealId]);
    if (String(dealTypeRow.rows[0]?.deal_type || "physical_product") === "physical_product") {
      const pickupRows = await c.query(
        `SELECT option_type, label, latitude, longitude FROM siton.deal_delivery_options WHERE deal_id=$1 ORDER BY sort_order ASC`,
        [dealId]
      );
      const missingLocation = pickupOptionsMissingLocation(pickupRows.rows as any[]);
      if (missingLocation.length) {
        const err: any = new Error("self-pickup options require a usable pickup location before publishing");
        err.statusCode = 409;
        err.code = "pickup_location_required";
        err.details = { options_missing_location: missingLocation.map((o: any) => ({ option_type: o.option_type, label: o.label })) };
        throw err;
      }
    }
  });

  // Schedule the deadline check to run AT the deadline, not immediately. With a
  // continuous worker an available_at of now() would fail a freshly published
  // deal before anyone can join; the handler also defers early runs defensively.
  const publishDeadlineRow = await pool.query(`SELECT deadline FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const publishDeadlineAt = publishDeadlineRow.rows[0]?.deadline ? new Date(publishDeadlineRow.rows[0].deadline) : undefined;
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
      payload: { deal_id: dealId },
      ...(publishDeadlineAt ? { available_at: publishDeadlineAt } : {})
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
  } catch (error: any) {
    const message = String(error?.message || error || "");
    if (message.includes("State mismatch deal")) return;
    throw error;
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
  const acquisition = normalizeJoinAcquisition(body);
  // P0.3 — payment-method PREFERENCE (presentation/orchestration only; no
  // provider call, real money stays 0). Sensitive card data never reaches
  // this route: entry stays inside the provider's secure mechanism.
  const paymentMethodRaw = String(body.payment_method || "").trim();
  const paymentMethod = ["credit_card", "bit"].includes(paymentMethodRaw) ? paymentMethodRaw : null;
  if (paymentMethodRaw && !paymentMethod) {
    const err: any = new Error("payment_method must be credit_card or bit");
    err.statusCode = 400;
    err.code = "payment_method_invalid";
    throw err;
  }
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
  if (!isAccepted(body.payment_disclosure_accepted)) {
    const err: any = new Error("payment_disclosure_required");
    err.statusCode = 400;
    err.code = "payment_disclosure_required";
    throw err;
  }
  const qty = qtyRaw;

  const otpToken = body.otp_token ? String(body.otp_token) : null;
  const otpChallengeId = body.otp_challenge_id ? String(body.otp_challenge_id) : null;
  let verifiedBuyerIdentityHash = "";
  // Buyer verification is governed by the single server-side policy boundary.
  // MVP default: OFF for Join (minimal friction). OTP stays implemented and is
  // enforced only when the policy requires it — in which case the proof MUST be
  // bound to the submitted buyer identity (channel+destination) and any failure
  // fails closed with no fallback to the unverified path. When OFF, the
  // submitted phone/email is an UNVERIFIED contact and the server still owns the
  // participation identity via the unguessable tracking credential issued below.
  if (isBuyerVerificationRequired("join")) {
    try {
      await withTx(async (c) => {
        const verified = await ensureJoinOtpVerified(c, {
          otp_token: otpToken,
          otp_challenge_id: otpChallengeId,
          deal_id: dealId,
          channel: "sms",
          destination: buyer_id
        });
        verifiedBuyerIdentityHash = verified.destination_hash;
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
  }

  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  // Idempotency key is per-request, not per-buyer — ensures each purchase attempt has a unique key
  const correlationId = req.headers["x-correlation-id"] ? String(req.headers["x-correlation-id"]) : requestId;
  const idem = req.headers["idempotency-key"]
    ? String(req.headers["idempotency-key"])
    : `join:${dealId}:${buyer_id}:${requestId}`;

  const joinRequestHash = hashJoinRequestPayload({
    deal_id: dealId,
    buyer_id,
    qty,
    authorization_id: authorizationId || null,
    authorization_provider: authorizationProvider || null,
    authorization_correlation_id: authorizationCorrelationId || null,
    delivery_option_id: deliveryOptionId || null,
    buyer_name: buyerName,
    buyer_email: buyerEmail,
    delivery_address: deliveryAddress,
    delivery_city: deliveryCity,
    delivery_notes: deliveryNotes,
    affiliate_ref: String(body.affiliate_ref || "").trim().slice(0, 120),
    acquisition_source: acquisition.requestedSource,
    mall_session_id: acquisition.mallSessionId,
    payment_method: paymentMethod,
    payment_disclosure_accepted: true
  });
  await ensureAdminControlPlaneTables(withTx);
  await ensureAdminInterventionTables(withTx);
  await ensureParticipantTrackingTables(withTx);
  await ensureNotificationRailTables(withTx);
  const canonicalInventoryRuntime = canonicalPostgresRuntimeEnabled();
  const joinResult = await withTx(async (c) => {
    // Database-scoped ownership serializes the same logical Join across every Web instance.
    // The timeout bounds waiter lifetime; rollback or process death releases ownership automatically.
    await c.query("SET LOCAL lock_timeout = '20s'");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`participant.join_authorize:${dealId}:${buyer_id}:${idem}`]);

    const idemCheck = await c.query(
      `SELECT request_hash, response_jsonb
       FROM siton.join_idempotency_results
       WHERE deal_id=$1 AND buyer_id=$2 AND idempotency_key=$3`,
      [dealId, buyer_id, idem]
    );
    if (idemCheck.rowCount) {
      if (String(idemCheck.rows[0].request_hash || "") !== joinRequestHash) {
        const err: any = new Error("idempotency key was already used with a different Join payload");
        err.statusCode = 409;
        err.code = "idempotency_payload_mismatch";
        throw err;
      }
      return { replayed: true as const, response: idemCheck.rows[0].response_jsonb };
    }

    const joinTestFailurePoint = process.env.NODE_ENV === "test"
      ? String(req.headers["x-siton-join-failure-point"] || "")
      : "";
    if (joinTestFailurePoint === "before_participant") {
      throw new Error("join_test_failure_before_participant");
    }
    // Lock the deal row to prevent concurrent over-booking
    const dealRow = await c.query(
      `SELECT deal_id, state, max_units, threshold_units, seller_id, title, price_per_unit, deal_type, published_at
       FROM siton.deals WHERE deal_id=$1 FOR UPDATE`,
      [dealId]
    );
    if (!dealRow.rowCount) {
      const err: any = new Error("deal not found");
      err.statusCode = 404;
      throw err;
    }
    const dealState = String(dealRow.rows[0].state) as DealState;
    const maxUnits = Number(dealRow.rows[0].max_units);
    const thresholdUnits = Number(dealRow.rows[0].threshold_units);
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

    const inventory = canonicalInventoryRuntime ? buildInventoryRepository(c) : null;
    let inventoryReservationId: string | null = null;
    if (inventory) {
      const inventoryJoinKey = canonicalInventoryKey("join", {
        deal_id: dealId,
        buyer_id,
        idempotency_key: idem
      });
      await inventory.sync({
        dealId,
        maxUnits,
        minUnits: thresholdUnits,
        idempotencyKey: `runtime-sync:${dealId}`
      });
      let inventoryHold: Record<string, unknown>;
      try {
        inventoryHold = await inventory.hold({
          dealId,
          qty,
          idempotencyKey: inventoryJoinKey,
          requestHash: joinRequestHash
        });
      } catch (error) {
        if (error instanceof InventoryRepositoryError && error.code === "inventory_exhausted") {
          (error as any).code = "max_units_exceeded";
        }
        throw error;
      }
      inventoryReservationId = String(inventoryHold.reservation_id || "");
      requireUuid(inventoryReservationId, "inventory_reservation_id");
    } else {
      // Pre-R3 compatibility only. The target Render/Supabase path always uses the
      // canonical inventory RPC above when CANONICAL_POSTGRES_RUNTIME=1.
      const reservedRow = await c.query(
        `SELECT COALESCE(SUM(qty), 0) AS total
         FROM siton.participants
         WHERE deal_id=$1
           AND buyer_state NOT IN ('DealFailed','Dropped')`,
        [dealId]
      );
      const remaining = maxUnits - Number(reservedRow.rows[0].total);
      if (qty > remaining) {
        const err: any = new Error(
          `requested quantity (${qty}) exceeds available inventory (${Math.max(0, remaining)})`
        );
        err.statusCode = 409;
        err.code = "max_units_exceeded";
        throw err;
      }
    }
    // Server-authoritative authorization binding (R9A). In strict mode the
    // browser-supplied authorization_id is only a lookup handle: AuthHeld is
    // reached exclusively by consuming a server-side binding whose provider,
    // environment, deal, buyer, quantity and authoritative amount all match.
    const bindingStrict = paymentBindingEnforcementStrict();
    if (bindingStrict && !authorizationId) {
      const err: any = new Error("a server-verified payment authorization is required to join this deal");
      err.statusCode = 402;
      err.code = "payment_authorization_required";
      throw err;
    }
    const authorizationPayload: Record<string, unknown> = authorizationId
      ? {
          authorization: "provider_authorized",
          authorization_id: authorizationId,
          authorization_provider: authorizationProvider || "unknown",
          authorization_correlation_id: authorizationCorrelationId || null
        }
      : { authorization: "mock_success" };
    const authorizationEvidenceHash = inventorySha256({
      deal_id: dealId,
      buyer_id,
      authorization: authorizationPayload
    });

    // INSERT participant, then immediately apply state transitions + write audit + idem_log
    // all within the same deal-locked transaction. This prevents the race where concurrent
    // requests slip through the idempotency check during the gap between participant INSERT
    // (end of withTx) and idem_log write (end of atomicMultiTransition).
    const participantValues = [
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
      deliveryNotes,
      acquisition.requestedSource,
      paymentMethod
    ];
    const ins = inventoryReservationId
      ? await c.query(
          `INSERT INTO siton.participants(
             deal_id, buyer_id, qty, buyer_state, money_state,
             delivery_option_id, delivery_method_type, delivery_method_label, delivery_cost,
             buyer_name, buyer_phone, buyer_email,
             delivery_address, delivery_city, delivery_notes, acquisition_source,
             payment_method, inventory_reservation_id
           )
           VALUES ($1,$2,$3,'NotJoined','NoFinancial',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING participant_id`,
          [...participantValues, inventoryReservationId]
        )
      : await c.query(
          `INSERT INTO siton.participants(
             deal_id, buyer_id, qty, buyer_state, money_state,
             delivery_option_id, delivery_method_type, delivery_method_label, delivery_cost,
             buyer_name, buyer_phone, buyer_email,
             delivery_address, delivery_city, delivery_notes, acquisition_source,
             payment_method
           )
           VALUES ($1,$2,$3,'NotJoined','NoFinancial',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING participant_id`,
          participantValues
        );
    const pid = ins.rows[0].participant_id as string;
    if (
      joinTestFailurePoint === "after_participant_before_commit"
      || joinTestFailurePoint === "after_business_mutation_before_inventory_commit"
    ) {
      throw new Error("join_test_failure_after_business_mutation_before_inventory_commit");
    }

    const inventoryCommit = inventory && inventoryReservationId
      ? await inventory.commit({
          reservationId: inventoryReservationId,
          authorizationEvidenceHash
        })
      : null;
    if (joinTestFailurePoint === "after_inventory_commit_before_business_audit") {
      throw new Error("join_test_failure_after_inventory_commit_before_business_audit");
    }

    // Consume the server-side authorization binding atomically with this Join
    // transaction. Any mismatch (deal, buyer, provider, environment, quantity,
    // amount, currency, status, prior consumption, expiry) aborts the Join.
    if (authorizationId) {
      const authoritativeAmountMinor = paymentMinorAmount({
        qty,
        pricePerUnit: Number(dealRow.rows[0].price_per_unit || 0),
        deliveryCost: Number(selectedDelivery?.cost || 0)
      });
      try {
        const consumedBinding = await paymentBindings.consumeBindingForJoinTx(c, {
          deal_id: dealId,
          buyer_id,
          authorization_id: authorizationId,
          participant_id: pid,
          expected_provider_code: paymentProvider.providerCode,
          expected_provider_mode: paymentProvider.mode,
          expected_provider_environment: String(process.env.PAYMENT_ENVIRONMENT || "demo"),
          expected_qty: qty,
          expected_amount_minor: authoritativeAmountMinor,
          expected_currency: "ILS"
        });
        authorizationPayload.authorization_binding_id = consumedBinding.binding_id;
        authorizationPayload.authorization_binding_verified = true;
        authorizationPayload.authorization_correlation_id =
          authorizationPayload.authorization_correlation_id || consumedBinding.correlation_id;
      } catch (error) {
        if (error instanceof PaymentBindingError) {
          // Legacy demo tolerance: ONLY the synthetic mock-backed provider may
          // join with an authorization that has no server-side binding at all.
          // Every other binding error — and every error in strict mode —
          // fails closed.
          if (!bindingStrict && error.code === "payment_authorization_not_found") {
            authorizationPayload.authorization_binding_verified = false;
          } else {
            const err: any = new Error(error.message);
            err.statusCode = error.statusCode;
            err.code = error.code;
            throw err;
          }
        } else {
          throw error;
        }
      }
    }

    const affiliateRef = String(body.affiliate_ref || "").trim().slice(0, 120);
    let acquisitionSource: "direct" | "mall" | "distributor" = acquisition.requestedSource;
    if (affiliateRef) {
      const attribution = await c.query(
        `INSERT INTO siton.affiliate_attributions
           (affiliate_id, deal_id, participant_id, share_code)
         SELECT source.affiliate_id, $1, $2, $3
         FROM (
           SELECT affiliate_id
           FROM siton.affiliate_accounts
           WHERE affiliate_code=$3
           UNION ALL
           SELECT affiliate_id
           FROM siton.affiliate_links
           -- Distributor links only: participant personal links (R6) have no
           -- affiliate account and are attributed via viral_attributions.
           WHERE source_code=$3 AND deal_id=$1 AND disabled_at IS NULL AND affiliate_id IS NOT NULL
           LIMIT 1
         ) source
         ON CONFLICT (participant_id) DO NOTHING
         RETURNING attribution_id`,
        [dealId, pid, affiliateRef]
      );
      if (attribution.rowCount) {
        acquisitionSource = "distributor";
        await c.query(
          `UPDATE siton.participants SET acquisition_source='distributor' WHERE participant_id=$1`,
          [pid]
        );
      }
    }

    // R6 commerce viral graph: resolve the share-chain attribution and ensure
    // the joining buyer's personal share link — bounded indexed work only; the
    // heavy subtree aggregation runs asynchronously via 'viral_recompute'.
    const viralJoin = await recordViralJoinAttribution(c, {
      deal_id: dealId,
      participant_id: pid,
      buyer_id,
      qty,
      ref: affiliateRef,
      first_touch_code: body.viral_first_touch_code,
      first_touch_at: body.viral_first_touch_at,
      last_touch_code: body.viral_last_touch_code,
      last_touch_at: body.viral_last_touch_at,
      visitor_id: body.viral_visitor_id,
      session_id: body.viral_session_id
    });

    if (acquisitionSource === "mall" && acquisition.mallSessionId && dealRow.rows[0].published_at) {
      const mallStatus = mallStatusForState(String(dealRow.rows[0].state));
      if (mallStatus) {
        const mallJoinRetryToken = `evt_${createHash("sha256").update(acquisition.mallSessionId).digest("hex")}`;
        await c.query(
          `INSERT INTO siton.discovery_events
             (event_type, client_event_id, deal_id, deal_type, mall_status, acquisition_source)
           VALUES ('mall_join',$1,$2,$3,$4,'mall')
           ON CONFLICT DO NOTHING`,
          [mallJoinRetryToken, dealId, dealRow.rows[0].deal_type, mallStatus]
        );
      }
    }

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

    if (inventoryCommit?.target_transitioned === true && dealState === "PendingTarget") {
      await c.query(`SELECT set_config('siton.action_name', 'deal.target_reached', true)`);
      await c.query(`SELECT set_config('siton.audit_written', '0', true)`);
      await c.query(
        `INSERT INTO siton.audit_log
         (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
         VALUES ('deal',$1,$1,'deal_state','PendingTarget','TargetReached','deal.target_reached',$2,$3,$4,$5)`,
        [
          dealId,
          requestId,
          correlationId,
          `target-reached:${dealId}`,
          JSON.stringify({
            source_inventory_reservation_id: inventoryReservationId,
            committed_units: inventoryCommit.committed_units,
            threshold_units: thresholdUnits
          })
        ]
      );
      await c.query(`SELECT set_config('siton.audit_written', '1', true)`);
      const targetUpdate = await c.query(
        `UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1 AND state='PendingTarget'`,
        [dealId]
      );
      if (targetUpdate.rowCount !== 1) {
        throw new Error(`State mismatch deal ${dealId} expected PendingTarget`);
      }
    }

    await recordLegalAcceptance({
      c,
      req,
      actorType: "buyer",
      actorRef: buyer_id,
      dealId,
      participantId: pid,
      acceptanceType: "buyer_payment_disclosure",
      policyVersion: PAYMENT_DISCLOSURE_VERSION,
      metadata: { no_charge_before_successful_close: true }
    });

    await enqueueNotification({
      eventKey: `join_authorized:${pid}:sms`,
      notificationEventType: "join_authorized",
      channel: "sms",
      recipient: buyer_id,
      templateParams: {
        deal_id: dealId,
        deal_title: String(dealRow.rows[0].title || ""),
        participant_id: pid
      },
      providerCode: notificationService.providerCode
    }, c);

    const trackingAccess = await issueParticipantTrackingToken(c, {
      participant_id: pid,
      deal_id: dealId,
      purpose: "tracking",
      issued_via: "buyer_join",
      correlation_id: correlationId
    });
    const deliveryCost = Number(selectedDelivery?.cost || 0);
    const response = {
      ok: true,
      participant_id: pid,
      inventory_reservation_id: inventoryReservationId,
      tracking_access_token: trackingAccess.token,
      tracking_url: `/app/track/${encodeURIComponent(pid)}?t=${encodeURIComponent(trackingAccess.token)}`,
      delivery_option_id: selectedDelivery?.option_id ?? null,
      delivery_method_type: selectedDelivery?.option_type ?? null,
      delivery_method_label: selectedDelivery?.label ?? null,
      delivery_cost: deliveryCost,
      acquisition_source: acquisitionSource,
      hold_total: Number(qty) * Number(dealRow.rows[0].price_per_unit || 0) + deliveryCost,
      viral: {
        attributed: viralJoin.attributed,
        generation: viralJoin.generation,
        personal_share_code: viralJoin.personal_share_code,
        personal_share_url: viralJoin.personal_share_code
          ? personalShareUrl(dealId, viralJoin.personal_share_code)
          : null
      }
    };

    const canonicalResult = await c.query(
      `INSERT INTO siton.join_idempotency_results
         (deal_id, buyer_id, idempotency_key, request_hash, participant_id, response_jsonb)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING response_jsonb`,
      [dealId, buyer_id, idem, joinRequestHash, pid, JSON.stringify(response)]
    );
    const canonicalResponse = canonicalResult.rows[0].response_jsonb;
    await c.query(
      `INSERT INTO siton.idempotency_log
       (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb, correlation_id, request_id)
       VALUES ('participant',$1,'participant.join_authorize',$2,$3,'OK',$4,$5,$6)`,
      [pid, idem, joinRequestHash, JSON.stringify(canonicalResponse), correlationId, requestId]
    );
    if (verifiedBuyerIdentityHash) {
      await c.query(
        `UPDATE siton.buyer_resume_contexts
         SET consumed_at=now(), updated_at=now()
         WHERE buyer_identity_hash=$1 AND deal_id=$2 AND consumed_at IS NULL`,
        [verifiedBuyerIdentityHash, dealId]
      );
    }
    await c.query(`SELECT set_config('siton.in_atomic', 'false', true)`);

    return {
      replayed: false as const,
      participant: {
        participant_id: pid,
        inventory_reservation_id: inventoryReservationId,
        buyer_state: "JoinedAuthorized" as BuyerState,
        money_state: "AuthHeld" as MoneyState,
        delivery_option_id: selectedDelivery?.option_id ?? null,
        delivery_method_type: selectedDelivery?.option_type ?? null,
        delivery_method_label: selectedDelivery?.label ?? null,
        delivery_cost: deliveryCost,
        acquisition_source: acquisitionSource
      },
      response: canonicalResponse
    };
  });

  if (joinResult.replayed) return joinResult.response;
  if (!canonicalInventoryRuntime) {
    const targetAttempt = await withTx(async (c) => {
      const d = await c.query(`SELECT state, threshold_units FROM siton.deals WHERE deal_id=$1`, [dealId]);
      if (!d.rowCount) throw new Error("deal not found");
      return {
        state: d.rows[0].state as DealState,
        threshold: Number(d.rows[0].threshold_units),
        total: await sumJoinedUnits(c, dealId)
      };
    });
    if (targetAttempt.state === "PendingTarget" && targetAttempt.total >= targetAttempt.threshold) {
      await tryTargetReached(dealId, requestId);
    }
  }
  await hitTestFault("http.join.after_commit_before_response");
  return joinResult.response;
});

app.post("/deals/:id/close_joining", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `close:${dealId}`;

  const closeContext = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    const r = await c.query(`SELECT seller_id, max_units, threshold_units, state FROM siton.deals WHERE deal_id=$1`, [dealId]);
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
    return {
      maxUnits: Number(r.rows[0].max_units),
      thresholdUnits: Number(r.rows[0].threshold_units),
      state: String(r.rows[0].state)
    };
  });

  // P0.3 — a manual pause is legal from BOTH open states. Anything else is an
  // explicit product answer, never a generic 500.
  if (closeContext.state === "ClosedForJoining") {
    return { ok: true, already_closed: true, state: "ClosedForJoining" };
  }
  if (!["PendingTarget", "TargetReached"].includes(closeContext.state)) {
    throw Object.assign(new Error("deal is not open for joining"), { statusCode: 409, code: "deal_not_open_for_joining" });
  }

  const result = await atomicTransition({
    entityType: "deal",
    entityId: dealId,
    dealId,
    stateType: "deal_state",
    fromState: closeContext.state,
    toState: "ClosedForJoining",
    actionName: "deal.close_joining",
    requestId,
    idempotencyKey: `${idem}:${closeContext.state}`,
    outbox: null,
    payload: { close_reason: "manual" },
    insideTx: async (c) => {
      await c.query(
        `UPDATE siton.deals SET close_reason='manual', closed_for_joining_at=now() WHERE deal_id=$1`,
        [dealId]
      );
      if (canonicalPostgresRuntimeEnabled()) {
        const inventoryRepo = buildInventoryRepository(c);
        // the inventory row is created lazily by join's sync — a zero-join
        // deal has none yet, and sync is the canonical create/open op; a
        // fresh per-close key avoids poisoning join's `runtime-sync` key
        await inventoryRepo.sync({
          dealId,
          maxUnits: closeContext.maxUnits,
          minUnits: closeContext.thresholdUnits,
          idempotencyKey: `close-sync:${dealId}:${idem}`.slice(0, 200)
        });
        await inventoryRepo.close({
          dealId,
          maxUnits: closeContext.maxUnits,
          idempotencyKey: canonicalInventoryKey("close", {
            deal_id: dealId,
            idempotency_key: idem
          })
        });
      }
    }
  });
  return { ok: true, state: "ClosedForJoining", close_reason: "manual", result };
});

// P0.3 — reopen a MANUALLY paused deal. Guards (all must hold):
//   * state is ClosedForJoining with close_reason='manual'
//   * the deadline has not passed
//   * capacity is not full
//   * charging has not begun (guaranteed by the state itself)
// Destination follows the canonical truth: TargetReached when joined units
// already meet the threshold, else PendingTarget. A deadline_check outbox
// event is re-enqueued so the deadline authority keeps working after reopen.
app.post("/deals/:id/reopen_joining", async (req: any) => {
  const dealId = String(req.params.id);
  requireUuid(dealId, "deal_id");
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `reopen:${dealId}:${Date.now()}`;

  const ctx = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    const r = await c.query(
      `SELECT d.seller_id, d.state, d.close_reason, d.deadline, d.max_units, d.threshold_units,
              COALESCE((SELECT SUM(p.qty) FROM siton.participants p
                        WHERE p.deal_id=d.deal_id
                          AND p.buyer_state NOT IN ('Dropped','DealFailed')), 0) AS joined_units
       FROM siton.deals d WHERE d.deal_id=$1`,
      [dealId]
    );
    if (!r.rowCount || normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id) {
      throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
    }
    return r.rows[0];
  });

  if (String(ctx.state) !== "ClosedForJoining") {
    throw Object.assign(new Error("deal joining is not paused"), { statusCode: 409, code: "deal_not_paused" });
  }
  if (String(ctx.close_reason || "") !== "manual") {
    throw Object.assign(new Error("only a manually paused deal can reopen"), { statusCode: 409, code: "deal_reopen_not_allowed" });
  }
  if (new Date(ctx.deadline).getTime() <= Date.now()) {
    throw Object.assign(new Error("deadline has passed"), { statusCode: 409, code: "deal_reopen_deadline_passed" });
  }
  const joinedUnits = Number(ctx.joined_units || 0);
  if (joinedUnits >= Number(ctx.max_units)) {
    throw Object.assign(new Error("deal is at capacity"), { statusCode: 409, code: "deal_reopen_capacity_full" });
  }
  const toState = joinedUnits >= Number(ctx.threshold_units) ? "TargetReached" : "PendingTarget";

  const result = await atomicTransition({
    entityType: "deal",
    entityId: dealId,
    dealId,
    stateType: "deal_state",
    fromState: "ClosedForJoining",
    toState,
    actionName: "deal.reopen_joining",
    requestId,
    idempotencyKey: idem,
    outbox: null,
    payload: { reopened_from: "manual_close" },
    insideTx: async (c) => {
      await c.query(
        `UPDATE siton.deals SET close_reason=NULL, closed_for_joining_at=NULL WHERE deal_id=$1`,
        [dealId]
      );
      // The deadline authority must keep working after reopen. The publish-time
      // deadline_check is normally still pending (one-pending-per-aggregate-event
      // unique index) — insert only if it is somehow gone, never collide.
      await c.query(
        `INSERT INTO siton.outbox_events
           (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
         SELECT 'deadline_check','deal',$1,$2,'pending',0,$3
         WHERE NOT EXISTS (
           SELECT 1 FROM siton.outbox_events
           WHERE event_type='deadline_check' AND aggregate_type='deal'
             AND aggregate_id=$1 AND status='pending'
         )
         ON CONFLICT DO NOTHING`,
        [dealId, JSON.stringify({ deal_id: dealId }), new Date(ctx.deadline).toISOString()]
      );
      if (canonicalPostgresRuntimeEnabled()) {
        // sync is the canonical open/create op, but it REPLAYS on a used
        // idempotency key — a fresh per-reopen key is required so the closed
        // inventory actually flips back to 'open' for future Holds
        await buildInventoryRepository(c).sync({
          dealId,
          maxUnits: Number(ctx.max_units),
          minUnits: Number(ctx.threshold_units),
          idempotencyKey: `reopen-sync:${dealId}:${idem}`.slice(0, 200)
        });
      }
    }
  });
  return { ok: true, state: toState, result };
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
  getWorkerRunning: () => false,
  workerStuckTimeoutMs: WORKER_STUCK_TIMEOUT_MS,
  applyPaymentWebhookClassification
});

export async function startApplication() {
  assertProductionRuntimeGuards("web");
  await assertCanonicalRuntimeReady(pool, "web");
  await app.listen({ port: PORT, host: HOST });

  /*
    TODO Phase 2
    1 cleanup outbox old rows: delete sent after X days, move failed after X to dlq
    2 refund_issue per participant outbox for isolation
  */
}

async function gracefulShutdown(signal: string) {
  app.log.info({ signal }, "graceful shutdown initiated");
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

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPath === import.meta.url) {
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  startApplication().catch((error) => {
    app.log.error({ err: error }, "application startup failed");
    process.exitCode = 1;
  });
}

