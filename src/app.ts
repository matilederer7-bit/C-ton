import { assertRequiredTables } from "./schema_contract.js";
import { readMoneyAmount, MONEY_EPSILON } from "./money_input.js";
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
import {
  buildPaymentAttemptHelpers,
  PaymentOperationInFlightError,
  type AttemptType as PaymentAttemptType,
  type DispatchState as PaymentDispatchState
} from "./payment_attempt_helpers.js";
import { buildPaymentProvider, getPaymentProviderSummary, providerAmbiguityPolicy, type PaymentExecutionResult, type PaymentStatusResult } from "./payment_provider.js";
import { buildPaymentAuthorizationBindings, PaymentBindingError } from "./payment_binding.js";
import { assessAuthorizationUsability, isAuthorizationUnusableResult, reauthorizationIdentity } from "./authorization_lifecycle.js";
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
  type DealType,
  readVoucherTerms,
  readTicketTerms
} from "./deal_types.js";
import {
  buildProductSnapshot,
  ensureProductCatalogTables,
  normalizeDeliveryEstimate,
  normalizeFulfillmentDefaults,
  normalizeProductType,
  validateProductAttributes
} from "./product_catalog.js";
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
import { classifyDeadline, DEADLINE_DEFAULT_MS as DEADLINE_POLICY_DEFAULT_MS } from "./deadline_policy.js";
dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || "0.0.0.0");
// Per spec (C6): completion window is 24 hours (1440 minutes) — the time buyers have
// to update a failed payment method after Charging → CompletionWindow.
const COMPLETION_WINDOW_MINUTES = Number(process.env.COMPLETION_WINDOW_MINUTES || 1440);
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 1000);
const OUTBOX_MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 4);

// Deal deadline bounds come from ONE policy module (src/deadline_policy.ts):
// a 2-hour product minimum and a technical sanity ceiling. There is no
// payment-derived maximum — deal lifetime is independent of provider
// authorization lifetime (LONG_HORIZON_DEALS, docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md).
const DEADLINE_DEFAULT_MS = DEADLINE_POLICY_DEFAULT_MS;

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
  // Residual C (final financial integration): a hold released while a charge
  // was pending — the capture is never dispatched and the money truth is the
  // provider-proofed release (migration 064 admits the same transition).
  ChargeAttempt: ["ChargedSuccess", "ChargeFailedRecovery", "AuthReleased"],
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
  assertLeaseForProviderIo,
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
  finalizeAttemptResult,
  settleAttemptInTx,
  beginProviderAttempt,
  armProviderDispatch,
  settleProviderDispatch,
  anyOperationInFlight,
  loadAttemptLifecycle,
  listAttemptLifecycle,
  extendSettlementHorizon,
  captureSettlementFenceUntil,
  lockParticipantDealInTx,
  // R9C ROUND 5 — never-dispatched identity retirement
  retireNeverDispatched
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

// Row lock on the canonical entity row of a serialized transition. FOR UPDATE,
// the same lock the transition's own compare-and-swap takes at the end, so the
// contention is on ONE object and cannot deadlock against itself.
async function lockTransitionEntityRow(c: PoolClient, entityType: AtomicEntityType, entityId: string) {
  if (entityType === "deal") {
    await c.query(`SELECT deal_id FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [entityId]);
    return;
  }
  await c.query(`SELECT participant_id FROM siton.participants WHERE participant_id=$1 FOR UPDATE`, [entityId]);
}

async function readTransitionEntityState(c: PoolClient, op: TransitionOp): Promise<string | null> {
  if (op.entityType === "deal") {
    const r = await c.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [op.entityId]);
    return r.rowCount ? String(r.rows[0].state) : null;
  }
  const col = op.stateType === "buyer_state" ? "buyer_state" : "money_state";
  const r = await c.query(`SELECT ${col} AS state FROM siton.participants WHERE participant_id=$1`, [op.entityId]);
  return r.rowCount ? String(r.rows[0].state) : null;
}

function transitionEntityNotFound(entity: AtomicEntityType, entityId: string) {
  return Object.assign(new Error(`${entity} not found`), { statusCode: 404, code: `${entity}_not_found`, entity_type: entity, entity_id: entityId });
}

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
  // Opt-in: serialize this transition on the canonical row of the idempotency
  // entity BEFORE the idempotency lookup, and re-read every op's state under
  // that lock BEFORE the first durable write. Without it, two callers that both
  // pass the (non-locking) idempotency lookup both write audit + outbox rows
  // and the one-pending-per-aggregate-event unique index decides the race by
  // raising 23505 in the loser — one statement BEFORE the compare-and-swap
  // that was designed to answer 409. With it, the loser waits on the row, then
  // observes the winner's committed idempotency row (same key → replay) or its
  // committed state (different key → STATE_CONFLICT) and writes nothing.
  // The unique index stays as the backstop: a 23505 under this lock means the
  // outbox really is inconsistent and must still surface as a fault.
  // Consumers: deal.publish, deal.cancel. Payment-lifecycle transitions do not opt in
  // (their lock order is reviewed separately and is out of this change's scope).
  serializeOnEntity?: boolean;
}): Promise<{ response: any; replay: boolean }> {
  await ensureAdminControlPlaneTables(withTx);
  await ensureAdminIdentityTables(withTx);
  await ensureParticipantTrackingTables(withTx);
  await ensureAdminInterventionTables(withTx);
  const response = args.response ?? { ok: true };

  return withTx(async (c) => {
    if (args.serializeOnEntity) {
      await lockTransitionEntityRow(c, args.idempotency.entityType, args.idempotency.entityId);
    }
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

    if (args.serializeOnEntity) {
      // Re-read under the lock: a transition that already lost cannot reach the
      // outbox insert, so the unique index never has to decide a benign race.
      // Same answer as the compare-and-swap below (STATE_CONFLICT), taken before
      // any row is written instead of after.
      for (const op of ops) {
        const current = await readTransitionEntityState(c, op);
        if (current === null) throw transitionEntityNotFound(op.entityType, op.entityId);
        if (current !== op.fromState) throw stateConflict(op.entityType, op.entityId, op.fromState);
      }
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
    await hitTestFault("atomic.after_durable_writes_before_commit");
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
  serializeOnEntity?: boolean;
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
    ...(args.insideTx ? { insideTx: args.insideTx } : {}),
    ...(args.serializeOnEntity ? { serializeOnEntity: true } : {})
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

/**
 * R9C — a provider-declared MONEY effect that the canonical state guards
 * refuse (the participant already advanced to a contradicting state) must
 * never vanish silently: money at the provider is economically real. The
 * attempt is recorded as executed (which blocks recovery/refund/release via the
 * migration-063 rules) and a FINANCIAL_OUTCOME_UNRESOLVED case is opened. No
 * canonical state is guessed.
 */
/**
 * F-12 — the DISTINCT capture-side operation identities that are executed for
 * this obligation, counting the effect being reported right now.
 *
 * The invariant is about how many capture-side operations moved money, so it is
 * decided by durable operation IDENTITY, never by the current money_state and
 * never by "is the reported identity the one already recorded".
 *
 * The reported effect is itself a capture-side execution, so it joins the set.
 * That is what makes the answer STABLE across deliveries, and it is the whole
 * reason a redelivery can still repair a missing escalation:
 *
 *   first delivery      committed {recovery}            + reported charge_start = 2
 *   after it committed  committed {charge_start,recovery} + reported charge_start = 2
 *   ordinary duplicate  committed {charge_start}        + reported charge_start = 1
 *
 * The earlier predicate asked instead whether EVERY executed identity differed
 * from the reported one. That is a replay test, not a dual-capture test: once
 * the reported identity's own success had committed, its matching row made the
 * predicate false and the condition became permanently undetectable — the first
 * delivery destroyed the evidence that a later delivery needed. Counting
 * distinct identities has no such blind spot.
 *
 * Still conservative at the low end: a participant with no capture-side
 * identity at all (a seeded fixture, a pre-rails row) yields one and stays
 * silent, exactly as before.
 */
/**
 * The three — and only three — outcomes of the F-12 identity read.
 *
 * `unreadable` is a VALUE so that an evidence-read failure cannot be spelled
 * the same way as "one identity". The previous shape returned a plain array and
 * swallowed the query error with `.catch(() => [])`, which made a database
 * failure indistinguishable from "no other capture succeeded": the read error
 * silently became "not a dual capture", the delivery was acknowledged 200, no
 * escalation existed, and because the event was then marked `ignored` rather
 * than `failed` the same event id was deduplicated and could never repair it.
 * On a financial-critical path UNKNOWN must never become FALSE.
 */
type CaptureSideIdentityEvidence =
  | { outcome: "confirmed_single"; identities: string[]; reportedExactDecline: boolean }
  | { outcome: "confirmed_dual"; identities: string[]; reportedExactDecline: boolean }
  | { outcome: "unreadable"; cause: unknown };

/**
 * Raised when the durable capture-side identity evidence cannot be read, so
 * whether two distinct money effects exist is UNKNOWN. Retryable by
 * construction: the caller marks the provider event `failed` and rethrows, and
 * webhookIngestion.claimEvent re-processes an event left in `failed`, so the
 * SAME event id gets another processing opportunity.
 */
class PaymentDualCaptureEvidenceUnavailableError extends Error {
  constructor(participantId: string, cause: unknown) {
    super(
      `payment_dual_capture_evidence_unavailable participant ${participantId}: ` +
      `cannot determine whether two distinct successful capture-side operations exist (${String((cause as Error)?.message || cause)})`
    );
    this.name = "PaymentDualCaptureEvidenceUnavailableError";
  }
}

async function readCaptureSideIdentityEvidence(args: {
  target: { participant_id: string; deal_id: string; attempt_type: string; correlation_id: string | null };
  event: { event_type: string; correlation_id?: string | null };
}): Promise<CaptureSideIdentityEvidence> {
  let rows: Awaited<ReturnType<typeof listAttemptLifecycle>>;
  try {
    await hitTestFault("payment.before_dual_capture_identity_read");
    rows = await listAttemptLifecycle(args.target.participant_id, args.target.deal_id);
  } catch (cause) {
    // NOT an empty set. The evidence is unknown, and unknown is its own answer.
    return { outcome: "unreadable", cause };
  }
  const identities = new Set<string>();
  for (const row of rows) {
    if ((row.attempt_type === "charge_start" || row.attempt_type === "recovery") && row.result_class === "success") {
      identities.add(`${row.attempt_type}:${row.correlation_id}`);
    }
  }
  const reportedFamily =
    args.event.event_type === "charge_captured" ? "charge_start"
      : args.event.event_type === "recovery_captured" ? "recovery"
        : null;
  const reported = String(args.event.correlation_id || args.target.correlation_id || "").trim();
  if (reportedFamily && reported) identities.add(`${reportedFamily}:${reported}`);
  // Did the provider already answer THIS exact request with a decline? That is
  // the strongest negative evidence the system can hold (migration 068 refuses
  // to downgrade it), so a later claim to the contrary is a contradiction to
  // escalate, never a success to write.
  const reportedRow = reported
    ? rows.find((row) => row.correlation_id === reported && row.attempt_type === args.target.attempt_type)
    : undefined;
  const reportedExactDecline = Boolean(
    reportedRow
      && reportedRow.result_class === "permanent_fail"
      && (reportedRow.failure_evidence === "dispatch_response" || reportedRow.failure_evidence === "operator")
  );
  const sorted = [...identities].sort();
  return sorted.length >= 2
    ? { outcome: "confirmed_dual", identities: sorted, reportedExactDecline }
    : { outcome: "confirmed_single", identities: sorted, reportedExactDecline };
}

async function recordLateMoneyEffectException(args: {
  event: { provider: string; event_id: string; event_type: string; correlation_id?: string | null; provider_reference?: string | null };
  target: { participant_id: string; deal_id: string; attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund"; correlation_id: string | null; buyer_state: string; money_state: string };
  reason: string;
}) {
  const moneyState = String(args.target.money_state);
  const captureEffect = args.event.event_type === "charge_captured" || args.event.event_type === "recovery_captured";
  const capturedMoneyStates = ["ChargedSuccess", "RecoveredCharge", "Refunded"];
  // F-12 — a SECOND capture for one obligation (the classic shape: a recovery
  // succeeded and the original capture then settled late) leaves the money
  // state at a captured value, so a state test alone reads it as a replay and
  // drops economically real money. Decided by durable identity instead, and
  // evaluated on EVERY capture effect so a redelivery still sees it.
  const evidence: CaptureSideIdentityEvidence = captureEffect
    ? await readCaptureSideIdentityEvidence({ target: args.target, event: args.event })
    : { outcome: "confirmed_single", identities: [], reportedExactDecline: false };
  // FAIL CLOSED. There is no path from "the evidence could not be read" to
  // "therefore it is not a dual capture". This throws BEFORE any write, so
  // financial truth is never mutated to make a retry possible, and the delivery
  // is left retryable instead of acknowledged.
  if (evidence.outcome === "unreadable") {
    throw new PaymentDualCaptureEvidenceUnavailableError(args.target.participant_id, evidence.cause);
  }
  const captureIdentities = evidence.identities;
  const dualCapture = evidence.outcome === "confirmed_dual";
  const contradiction =
    (captureEffect && !capturedMoneyStates.includes(moneyState)) ||
    dualCapture ||
    (args.event.event_type === "refund_issued" && moneyState !== "Refunded");
  if (!contradiction) return;
  // F-5b (financial torture lab) — the event names the operation it reports; it
  // may settle an identity of THAT family only (a refund_issued carrying a
  // capture correlation must never mark the capture identity as executed).
  const lateEffectFamilyMatches =
    (args.event.event_type === "charge_captured" && args.target.attempt_type === "charge_start") ||
    (args.event.event_type === "recovery_captured" && args.target.attempt_type === "recovery") ||
    (args.event.event_type === "refund_issued" && (args.target.attempt_type === "refund" || args.target.attempt_type === "cancel_refund"));
  const correlation = lateEffectFamilyMatches ? (args.event.correlation_id || args.target.correlation_id || null) : null;
  // The identity CONVERGES to provider truth even when the provider had
  // declined this exact request, and that convergence is load-bearing rather
  // than cosmetic: a recovery the provider declined whose effect turns out real
  // must become success, because that is what blocks the pending release of
  // money that actually moved (migration 067 refuses a release behind an
  // executed capture). FR-3 in payment_review_findings_reconstruction is the
  // candidate's contract for exactly that, and it is right. A late claim of a
  // real money effect is therefore always recorded, and always escalated.
  const settleReportedIdentity = Boolean(correlation);
  // F-12 durable escalation. The escalation key of a dual capture is derived
  // from the obligation and the DISTINCT executed capture-side identities, so
  // it is the same key on the first delivery and on every redelivery, and it is
  // independent of which event type reported it. Two different pairs of
  // operations would be two different cases; the same pair is always one.
  const escalationKey = dualCapture
    ? `dual-capture:${createHash("sha256").update(captureIdentities.join("|")).digest("hex").slice(0, 16)}`
    : args.event.event_type;
  const escalation: PaymentOperationalCaseInput = {
    autoKey: `payment-late-money-effect:${args.target.participant_id}:${escalationKey}`,
    subject: `FINANCIAL_OUTCOME_UNRESOLVED: provider reports ${args.event.event_type} but canonical money state is ${moneyState} (participant ${args.target.participant_id})`,
    description: `Provider ${args.event.provider} event ${args.event.event_id} declares ${args.event.event_type} (reference ${args.event.provider_reference || "n/a"}, correlation ${correlation || "n/a"}) while the participant is ${args.target.buyer_state}/${moneyState}; the canonical guard classified it as "${args.reason}".${dualCapture ? ` DUAL CAPTURE: ${captureIdentities.length} distinct capture-side operations of this participant are executed (${captureIdentities.join(", ")}), so that many captures exist at the provider for ONE obligation and canonical state can account for only one — a refund of the surplus must be decided by an operator.` : ""} ${evidence.reportedExactDecline ? ` NOTE: the provider had already answered this exact request with a decline, so it is now contradicting itself. The identity is converged to the reported money truth (which blocks any further automatic money operation for this participant) and an operator must establish what actually moved.` : ""} The provider effect is economically real and was NOT applied to canonical state. Automatic recovery/refund/release for this participant is blocked until an operator reconciles the money side. No state was guessed.`,
    correlationId: correlation
  };

  // ONE transaction for the money evidence AND the operator escalation.
  //
  // Before this, the evidence was committed first and the case was a suppressed
  // best-effort write afterwards. If the case INSERT failed, the caller was
  // told nothing, the webhook was acknowledged, and the committed evidence then
  // made the condition undetectable on redelivery: a known double capture with
  // no operator case and no way back. Now either both exist or neither does,
  // and a failure reaches the caller, which marks the provider event 'failed'
  // and rethrows. The delivery is never acknowledged as safely handled without
  // a durable escalation, and because webhookIngestion.claimEvent re-processes
  // an event left in 'failed', the SAME event id repairs it on retry — as does
  // any fresh delivery id, because the detection above is identity-based.
  //
  // Rolling the evidence back loses nothing: the observation itself stays
  // durable in siton.webhook_events with its payload, awaiting the retry that
  // commits both halves together. Provider truth is never altered to avoid an
  // escalation.
  await withTx(async (c) => {
    if (settleReportedIdentity && correlation) {
      await settleAttemptInTx(c, {
        participant_id: args.target.participant_id,
        deal_id: args.target.deal_id,
        attempt_type: args.target.attempt_type,
        correlation_id: correlation,
        result_class: "success",
        provider_reference: args.event.provider_reference ?? null,
        note: `late_money_effect:${args.event.event_type}:${args.reason}`
      });
    }
    await hitTestFault("payment.before_escalation_case");
    await openPaymentOperationalCaseInTx(c, escalation);
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
  const target = args.target; // narrowed once; closures below cannot re-narrow args.target
  await ensurePlatformFeeMoneyTables(withTx);

  // R9C — the operation's durable outcome commits in the SAME transaction as
  // the canonical state (and ledger). A negative outcome cannot be written
  // while the exact operation is dispatching under a live worker lease: the
  // transition aborts (PaymentOperationInFlightError / DB guard SN409) and the
  // caller defers. Success is provider truth and always settles.
  // Provenance of a negative verdict (migration 064): a failure that arrives
  // through a status read (reconcile, prior-attempt resolution, pre-flight) is an
  // INFERENCE and stays inside the settlement horizon fence; a failure the
  // provider pushed as an event is provider_event. A failure the provider gave
  // in its answer to the exact request was already settled by the dispatching
  // owner as dispatch_response (monotonic: never downgraded here).
  const eventSource = String((args.event.payload as Record<string, unknown> | undefined)?.source || "");
  const inferredSources = ["payment_reconcile_worker", "prior_attempt_resolution", "recovery_preflight", "finalize_preflight"];
  const failureEvidence = inferredSources.includes(eventSource) ? "status_inference" : "provider_event";
  const settleTargetAttemptInTx = async (c: PoolClient, resultClass: "success" | "permanent_fail") => {
    if (!target.correlation_id) return;
    await settleAttemptInTx(c, {
      participant_id: target.participant_id,
      deal_id: target.deal_id,
      attempt_type: target.attempt_type,
      correlation_id: target.correlation_id,
      result_class: resultClass,
      provider_reference: args.event.provider_reference ?? null,
      failure_evidence: resultClass === "permanent_fail" ? failureEvidence : null,
      note: `${args.event.event_type}:${args.classification.reason}`
    });
  };

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
      outbox: null,
      // R9C — fee-ledger truth is written INSIDE the state transaction: the
      // money state and its platform-fee ledger entry commit together or not
      // at all (a failure here rolls back both; the worker retry converges).
      insideTx: async (c) => {
        await settleTargetAttemptInTx(c, "success");
        await hitTestFault("payment.after_state_before_ledger");
        await platformFeeMoney.recordProviderFinancialEventInTx(c, {
          participant_id: target.participant_id,
          deal_id: target.deal_id,
          event_type: "charge_captured",
          provider_code: args.event.provider,
          provider_event_id: args.event.event_id,
          provider_reference: args.event.provider_reference ?? null,
          correlation_id: args.event.correlation_id ?? target.correlation_id ?? null,
          source_money_state: "ChargedSuccess"
        });
      }
    });
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
      outbox: null,
      insideTx: async (c) => {
        await settleTargetAttemptInTx(c, "permanent_fail");
      }
    });
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
      outbox: null,
      // R9C — fee-ledger truth is written INSIDE the state transaction: the
      // money state and its platform-fee ledger entry commit together or not
      // at all (a failure here rolls back both; the worker retry converges).
      insideTx: async (c) => {
        await settleTargetAttemptInTx(c, "success");
        await hitTestFault("payment.after_state_before_ledger");
        await platformFeeMoney.recordProviderFinancialEventInTx(c, {
          participant_id: target.participant_id,
          deal_id: target.deal_id,
          event_type: "recovery_captured",
          provider_code: args.event.provider,
          provider_event_id: args.event.event_id,
          provider_reference: args.event.provider_reference ?? null,
          correlation_id: args.event.correlation_id ?? target.correlation_id ?? null,
          source_money_state: "RecoveredCharge"
        });
      }
    });
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
      // F-6 (independent financial review, owner decision): a failed recovery
      // ends the buyer's participation (Dropped) but says NOTHING about the
      // hold. AuthReleased is money truth and requires authoritative release
      // proof; the money state therefore stays ChargeFailedRecovery and the
      // provider-proofed release rail (payment_release) establishes the release
      // — or leaves a visible operator case when the provider refuses it.
      ops: [
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
      outbox: null,
      insideTx: async (c) => {
        await settleTargetAttemptInTx(c, "permanent_fail");
      }
    });
    await schedulePaymentRelease({ participant_id: args.target.participant_id, deal_id: args.target.deal_id, reason: "recovery_failed" }).catch(() => undefined);
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
      payload: eventPayload,
      // R9C — refund adjustment ledger truth commits with the Refunded state.
      insideTx: async (c) => {
        await settleTargetAttemptInTx(c, "success");
        await hitTestFault("payment.after_state_before_ledger");
        await platformFeeMoney.recordProviderFinancialEventInTx(c, {
          participant_id: target.participant_id,
          deal_id: target.deal_id,
          event_type: "refund_issued",
          provider_code: args.event.provider,
          provider_event_id: args.event.event_id,
          provider_reference: args.event.provider_reference ?? null,
          correlation_id: args.event.correlation_id ?? target.correlation_id ?? null,
          source_money_state: target.money_state
        });
      }
    });
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

    if (classification.status === "ignored" && target) {
      // R9C — a stale local state guard must never silently discard an
      // economically real provider effect.
      await recordLateMoneyEffectException({
        event: { provider: args.provider, event_id: args.event_id, event_type: args.event_type, correlation_id: args.correlation_id ?? null, provider_reference: args.provider_reference ?? null },
        target,
        reason: classification.reason
      });
    }

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
    lease_generation?: number | null;
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
    const attemptType = event.event_type === "cancel_refund" ? "cancel_refund" : "refund";
    const amountMinor = paymentMinorAmount({
      qty: Number(p.qty || 0),
      pricePerUnit: Number(p.price_per_unit || 0),
      deliveryCost: Number(p.delivery_cost || 0)
    });
    // R9C — durable identity + reconcile-before-new-operation (see charge rail).
    const attempt = await beginProviderAttempt({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: attemptType,
      identity: (logicalAttempt) => `${event.event_type}:refund:${eventId}:n${logicalAttempt}:${p.participant_id}`,
      // R9C ROUND 5 — the mint is admitted only in the states the arm requires
      admitted: { money_states: ["ChargedSuccess", "RecoveredCharge"] }
    });
    if (attempt.kind === "state_changed") continue; // the participant left the refundable state before an identity existed: nothing minted, nothing sent
    if (attempt.kind === "blocked") {
      await handleBlockedMoneyOperation({ participant_id: p.participant_id, deal_id: dealId, attempt_type: attemptType, reason: attempt.reason, blocking: attempt.blocking, provider_reference: p.capture_reference || p.authorization_id || null, event_id: eventId });
      continue;
    }
    if (attempt.kind === "in_flight") continue; // another live worker owns this exact operation
    if (attempt.kind === "fenced") continue; // unreachable for a refund (the 064 fence applies to recovery/release); never mint on it
    if (attempt.kind === "unresolved") {
      const resolution = await resolvePriorProviderAttempt({
        operation: "refund",
        attempt_type: attemptType,
        participant_id: p.participant_id,
        deal_id: dealId,
        correlation_id: attempt.correlation_id,
        dispatch_state: attempt.dispatch_state,
        provider_reference: p.capture_reference || p.authorization_id || null,
        expected_amount_minor: amountMinor,
        expected_currency: "ILS",
        event_id: eventId
      });
      if (resolution !== "reuse") continue;
    }
    const correlation = attempt.correlation_id;

    const refundInput: Parameters<typeof paymentProvider.refund>[0] = {
      amount_minor: amountMinor,
      currency: "ILS",
      participant_id: p.participant_id,
      deal_id: dealId,
      buyer_id: p.buyer_id,
      correlation_id: correlation,
      request_id: `worker:${eventId}`
    };
    if (p.authorization_id) refundInput.authorization_id = p.authorization_id;
    if (p.capture_reference) refundInput.capture_reference = p.capture_reference;
    await hitTestFault("payment.before_provider_io");
    // R9C — arm: lease fence + state check + lifecycle CAS in ONE transaction,
    // the LAST step before external money I/O.
    const armed = await armMoneyOperation({
      event,
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: attemptType,
      correlation_id: correlation,
      expected_money_states: ["ChargedSuccess", "RecoveredCharge"],
      provider_reference: p.capture_reference || p.authorization_id || null
    });
    if (!armed) continue;
    const owner = { event_uuid: event.event_uuid, lease_generation: event.lease_generation };
    const result = await paymentProvider.refund(refundInput);
    await hitTestFault("payment.after_provider_io");
    const outcome = classifyMoneyOutcome(result);
    const settle = (settled: MoneyRailOutcome, note?: string) => settleOwnedMoneyOperation({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: attemptType,
      correlation_id: correlation,
      owner,
      outcome: settled,
      provider_reference: result.provider_reference || p.capture_reference || p.authorization_id || null,
      ...(note ? { note } : {})
    });

    if (outcome === "pre_dispatch_failure") {
      await settle("pre_dispatch_failure", `pre_dispatch_failure:${result.provider}`);
      throw new Error(`temporary_fail refund participant ${p.participant_id} (pre-dispatch, identity ${correlation} retained)`);
    }

    // Route through webhook reconciliation truth when the provider emits a refund event
    if (outcome === "success" && result.reconciliation_event_type === "refund_issued") {
      await settle("success");
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

    if (outcome === "unknown" || outcome === "success") {
      // The refund may have been issued (5xx/429/timeout/transport loss after
      // dispatch, or a success without a declared event). Never re-fire the
      // refund blindly and never mint a new identity — reconcile the SAME one.
      await settle("unknown", outcome === "success" ? "success_without_reconciliation_event" : `provider_outcome_unknown:${result.result_class}`);
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

    await settle("permanent_fail");
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
  attempt_type: "charge_start" | "recovery" | "refund" | "cancel_refund" | "release" | "reauthorize";
  correlation_id: string;
  /** "authorization" = LONG_HORIZON_DEALS re-authorization identity (attempt_type reauthorize) */
  operation: "capture" | "refund" | "release" | "authorization";
  provider_reference: string | null;
  reason: string;
};

async function schedulePaymentReconcile(args: PaymentReconcilePayload): Promise<"scheduled" | "already_pending" | "queued_behind"> {
  return withTx(async (c) => {
    const inserted = await c.query(
      `INSERT INTO siton.outbox_events (
         event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at
       ) VALUES ('payment_reconcile','participant',$1,$2,'pending',0, now())
       ON CONFLICT DO NOTHING`,
      [args.participant_id, JSON.stringify(args)]
    );
    if (Number(inserted.rowCount || 0) === 1) return "scheduled" as const;
    // F-4 (financial torture lab) — the one-pending-per-aggregate-event index
    // admits ONE live reconcile per participant. A live reconcile for the SAME
    // identity is fine (idempotent). One for a DIFFERENT identity would have
    // silently swallowed this request: the identity stayed UNKNOWN with no
    // reconcile and no case. The maintenance sweeper
    // (reconcileOrphanedUnknownIdentities) picks such identities up once the
    // live reconcile is done; until then the hold is visible as a case.
    const live = await c.query(
      `SELECT payload->>'correlation_id' AS correlation_id FROM siton.outbox_events
       WHERE event_type='payment_reconcile' AND aggregate_type='participant' AND aggregate_id=$1
         AND status IN ('pending','processing') LIMIT 1`,
      [args.participant_id]
    );
    const liveCorrelation = String(live.rows[0]?.correlation_id || "");
    if (!liveCorrelation || liveCorrelation === args.correlation_id) return "already_pending" as const;
    return "queued_behind" as const;
  }).then(async (outcome) => {
    if (outcome === "queued_behind") {
      await openPaymentOperationalCase({
        autoKey: `payment-reconcile-queued-behind:${args.participant_id}:${args.correlation_id}`,
        subject: `Reconcile for ${args.attempt_type} ${args.correlation_id} is queued behind another reconcile (participant ${args.participant_id})`,
        description: `A payment_reconcile for participant ${args.participant_id} is already live for a different identity, so the reconcile of ${args.attempt_type} ${args.correlation_id} (${args.reason}) could not be queued yet. The identity stays UNKNOWN (no money operation may repeat it); the worker maintenance sweeper schedules its reconcile as soon as the live one completes. No state was guessed.`,
        correlationId: args.correlation_id
      });
    }
    return outcome;
  });
}

/**
 * F-4 (financial torture lab) — worker maintenance sweeper. Every UNKNOWN money
 * identity that is not in flight, has no live reconcile and has been quiet for a
 * few seconds gets its own payment_reconcile (one per participant at a time,
 * the outbox index serialises the rest). Closes the gap in which a reconcile
 * request collided with another pending reconcile of the same participant, and
 * more generally guarantees that no UNKNOWN identity stays unattended.
 */
/**
 * F-2b (financial torture lab) — a finalize_deal that deferred on unresolved
 * captures may exhaust its bounded attempts (DLQ) before those identities
 * resolve; without a live finalize the deal would stay CompletionWindow for
 * ever. Worker maintenance re-queues one finalize for every deal whose window
 * has elapsed and that has no live finalize (idempotent through the
 * one-pending-per-aggregate index). The finalize itself keeps deferring while
 * identities are unresolved, so this never finalizes on ambiguous money.
 */
export async function rescheduleStalledFinalizations(limit = 100): Promise<number> {
  return withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
       SELECT 'finalize_deal', 'deal', d.deal_id, jsonb_build_object('deal_id', d.deal_id, 'reason', 'maintenance_stalled_finalize'), 'pending', 0, clock_timestamp()
       FROM siton.deals d
       WHERE d.state = 'CompletionWindow'
         AND d.completion_window_until IS NOT NULL
         AND d.completion_window_until <= clock_timestamp() - interval '1 second'
         AND NOT EXISTS (
           SELECT 1 FROM siton.outbox_events o
           WHERE o.event_type='finalize_deal' AND o.aggregate_type='deal' AND o.aggregate_id=d.deal_id AND o.status IN ('pending','processing')
         )
       ORDER BY d.completion_window_until ASC
       LIMIT $1
       ON CONFLICT DO NOTHING`,
      [Math.max(1, Math.floor(limit))]
    );
    return Number(r.rowCount || 0);
  });
}

export async function reconcileOrphanedUnknownIdentities(limit = 50, quietMs = 3_000): Promise<number> {
  const orphans = await withTx(async (c) => {
    const r = await c.query(
      `SELECT pa.participant_id, pa.deal_id, pa.attempt_type, pa.correlation_id,
              COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id', '') AS provider_reference,
              pa.provider_reference AS attempt_reference
       FROM siton.payment_attempts pa
       JOIN siton.participants p ON p.participant_id = pa.participant_id
       LEFT JOIN siton.payment_authorization_bindings pab ON pab.consumed_by_participant_id = p.participant_id
       LEFT JOIN LATERAL (
         SELECT payload FROM siton.audit_log
         WHERE entity_type='participant' AND entity_id=p.participant_id AND action_name='participant.join_authorize'
         ORDER BY created_at DESC LIMIT 1
       ) auth ON true
       WHERE pa.attempt_type IN ('charge_start','recovery','refund','cancel_refund','release','reauthorize')
         AND pa.result_class='unknown'
         AND NOT siton.payment_operation_in_flight(pa.owner_event_uuid, pa.owner_lease_generation)
         -- F-8: a NOT_DISPATCHED identity whose job is gone (participant left the
         -- state, job acked or archived) is resolved through status as well — a
         -- later, longer quiet period keeps a merely deferred job undisturbed.
         AND pa.updated_at <= clock_timestamp() - (CASE WHEN pa.dispatch_state = 'recorded' THEN GREATEST($2::bigint * 5, 10000) ELSE $2::bigint END::text || ' milliseconds')::interval
         AND NOT EXISTS (
           SELECT 1 FROM siton.outbox_events o
           WHERE o.event_type='payment_reconcile' AND o.aggregate_type='participant' AND o.aggregate_id=pa.participant_id
             AND o.status IN ('pending','processing')
         )
       ORDER BY pa.updated_at ASC
       LIMIT $1`,
      [Math.max(1, Math.floor(limit)), String(Math.max(0, Math.floor(quietMs)))]
    );
    return r.rows as Array<{ participant_id: string; deal_id: string; attempt_type: PaymentReconcilePayload["attempt_type"]; correlation_id: string; provider_reference: string; attempt_reference: string | null }>;
  });
  let scheduled = 0;
  const seen = new Set<string>();
  for (const row of orphans) {
    if (seen.has(row.participant_id)) continue; // one live reconcile per participant
    seen.add(row.participant_id);
    const operation: PaymentReconcilePayload["operation"] = row.attempt_type === "refund" || row.attempt_type === "cancel_refund" ? "refund" : row.attempt_type === "release" ? "release" : row.attempt_type === "reauthorize" ? "authorization" : "capture";
    const outcome = await schedulePaymentReconcile({
      participant_id: row.participant_id,
      deal_id: row.deal_id,
      attempt_type: row.attempt_type,
      correlation_id: row.correlation_id,
      operation,
      // a renewal identity is reconciled through the NEW authorization it may have created, never the binding's current one
      provider_reference: (row.attempt_type === "reauthorize" ? row.attempt_reference : row.provider_reference) || null,
      reason: "maintenance_orphaned_unknown_identity"
    }).catch(() => "already_pending" as const);
    if (outcome === "scheduled") scheduled += 1;
  }
  return scheduled;
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
      // R9C ROUND 4 (F-16) — ChargeAttempt too: a participant the deal decision
      // failed before any capture was attempted (never armed, or armed and
      // declined pre-dispatch) still holds its authorization. The release
      // identity is refused by beginProviderAttempt while any capture-side
      // identity is unresolved or executed, and applyAuthorizationRelease
      // re-checks that belt before ChargeAttempt -> AuthReleased.
      `SELECT participant_id
       FROM siton.participants
       WHERE deal_id=$1
         AND money_state IN ('AuthHeld','AuthLocked','ChargeFailedRecovery','ChargeAttempt')`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string }>;
  });
  for (const row of held) {
    await schedulePaymentRelease({ participant_id: row.participant_id, deal_id: dealId, reason }).catch(() => undefined);
  }
}

type PaymentOperationalCaseInput = {
  autoKey: string;
  subject: string;
  description: string;
  correlationId?: string | null;
  requestId?: string | null;
};

/**
 * The case write itself, on a caller-supplied transaction, with NO error
 * suppression. Idempotent through the partial unique index
 * ux_operational_cases_open_auto_key (migration 034): concurrent writers of the
 * same autoKey produce exactly one open case, the loser taking DO UPDATE.
 */
async function openPaymentOperationalCaseInTx(c: PoolClient, args: PaymentOperationalCaseInput) {
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
}

/**
 * Best-effort case opener, unchanged for its 30-odd observability call sites: a
 * case is a report ABOUT a decision that was already made and persisted, so a
 * failure here must not turn a correct refusal into an error.
 *
 * The F-12 late-money-effect path deliberately does NOT use this. There the
 * case is not a report about a decision, it IS the decision — the only place a
 * known double capture is recorded — so it is written inside the same
 * transaction as the money evidence and its failure propagates.
 */
async function openPaymentOperationalCase(args: PaymentOperationalCaseInput) {
  await withTx(async (c) => {
    await openPaymentOperationalCaseInTx(c, args);
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
    lease_generation?: number | null;
  },
  eventId: string
) {
  const payload = (event.payload || {}) as PaymentReconcilePayload;
  const participantId = String(payload.participant_id || event.aggregate_id);
  const dealId = String(payload.deal_id || "");
  const operation = (payload.operation === "refund" || payload.operation === "release" || payload.operation === "authorization") ? payload.operation : "capture";
  const attemptType = payload.attempt_type || (operation === "refund" ? "refund" : operation === "release" ? "release" : operation === "authorization" ? "reauthorize" : "charge_start");
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
        : operation === "authorization"
          // LONG_HORIZON_DEALS — a renewal matters while the participant still
          // waits for a capture-side operation on its CURRENT authorization
          ? (target.buyer_state === "ChargingAttempt" && target.money_state === "ChargeAttempt")
            || (target.buyer_state === "ChargeFailedCompletion" && target.money_state === "ChargeFailedRecovery")
          : ["AuthHeld", "AuthLocked", "ChargeFailedRecovery"].includes(String(target.money_state));
  // R9C — a participant whose canonical state already moved on may still carry
  // an UNRESOLVED identity for this exact operation (e.g. charge_failed was
  // declared by another path while the capture was unresolved). The ROW must
  // converge regardless: a positive status proof settles it as success (which
  // blocks recovery/release and surfaces a late-money-effect case); an
  // authoritative not-executed settles permanent_fail and unblocks recovery.
  const unresolvedRow = correlationId
    ? await loadAttemptLifecycle({ participant_id: participantId, deal_id: dealId, attempt_type: attemptType as PaymentAttemptType, correlation_id: correlationId })
    : null;
  const rowUnresolved = Boolean(unresolvedRow && unresolvedRow.result_class === "unknown");
  if (!waiting && !rowUnresolved) return;
  // R9C ROUND 5 — a NEVER-DISPATCHED identity (recorded, never armed) has no
  // provider truth to reconcile: the provider never saw it, so a status read
  // says nothing about IT and must never become a failure verdict on its row
  // (that produced a permanent_fail/status_inference row with no dispatch
  // instant, which the 068 fence then held for ever — Codex round 4).
  //   * a LIVE rail job for this operation owns the identity: the rail reuses
  //     it (reuse_not_dispatched) or retires it (state_changed) — nothing here;
  //   * the rail's phase is still open but its job is gone (DLQ / acked): the
  //     identity stays as the truthful marker of the owed operation and an
  //     operator case names the job to requeue — no automatic money decision;
  //   * the phase is over or the participant moved on: retire the identity in
  //     place (ABANDONED_BEFORE_DISPATCH) so the terminal decision / release
  //     rail is not blocked by it, and queue the release when a hold is left on
  //     a decided participant.
  if (unresolvedRow && unresolvedRow.result_class === "unknown" && unresolvedRow.dispatch_state === "recorded") {
    const railJob = operation === "refund"
      ? { event_type: attemptType === "cancel_refund" ? "cancel_refund" : "refund_issue", aggregate_type: "deal", aggregate_id: dealId }
      : operation === "release"
        ? { event_type: "payment_release", aggregate_type: "participant", aggregate_id: participantId }
        : attemptType === "recovery" || (operation === "authorization" && String(target.money_state) === "ChargeFailedRecovery")
          ? { event_type: "recovery_deal", aggregate_type: "deal", aggregate_id: dealId }
          : { event_type: "charge_deal", aggregate_type: "deal", aggregate_id: dealId };
    const live = await withTx(async (c) => Number((await c.query(
      `SELECT count(*) AS n FROM siton.outbox_events
       WHERE event_type=$1 AND aggregate_type=$2 AND aggregate_id=$3 AND status IN ('pending','processing')`,
      [railJob.event_type, railJob.aggregate_type, railJob.aggregate_id]
    )).rows[0]?.n || 0));
    if (live > 0) return; // the rail owns the identity (reuse or retire under the lock)
    const phaseOpen = operation === "capture" || operation === "authorization"
      ? (railJob.event_type === "recovery_deal" ? (String(target.deal_state) === "CompletionWindow" && Boolean(target.within_window)) : String(target.deal_state) === "Charging")
      : waiting;
    if (waiting && phaseOpen) {
      if (operation === "release") {
        await schedulePaymentRelease({ participant_id: participantId, deal_id: dealId, reason: "reconcile_never_dispatched_release_identity" });
        return;
      }
      await openPaymentOperationalCase({
        autoKey: `payment-never-dispatched-no-live-job:${participantId}:${attemptType}`,
        subject: `Owed ${attemptType} of participant ${participantId} has no live worker job`,
        description: `Identity ${correlationId} (${attemptType}) was minted but never left the process, the participant still waits for it (${String(target.buyer_state)}/${String(target.money_state)}, deal ${String(target.deal_state)}) and no ${railJob.event_type} job is pending or processing for ${railJob.aggregate_type} ${railJob.aggregate_id}. No provider status was read and no verdict was recorded (nothing was sent). Requeue the ${railJob.event_type} job (outbox.requeue) to dispatch the same identity, or resolve the participant manually.`,
        correlationId
      });
      return;
    }
    const retired = await retireNeverDispatched({ participant_id: participantId, deal_id: dealId, attempt_types: [attemptType as PaymentAttemptType], reason: `reconcile:${waiting ? "phase_over" : "participant_not_waiting"}:${String(target.buyer_state)}/${String(target.money_state)}/${String(target.deal_state)}` });
    if (retired.length && operation === "capture"
      && ["AuthHeld", "AuthLocked", "ChargeFailedRecovery", "ChargeAttempt"].includes(String(target.money_state))
      && ["DealFailed", "Dropped"].includes(String(target.buyer_state))) {
      await schedulePaymentRelease({ participant_id: participantId, deal_id: dealId, reason: "reconcile_never_dispatched_capture_retired" });
    }
    return;
  }
  // Exact-operation identity (independent financial review, FR-4): a status
  // answer is per authorization and cannot say WHICH identity of an operation
  // family it describes. A job that carries an identity already resolved
  // (terminal) must not draw a conclusion — nor settle that identity again —
  // while another identity of the same family is still UNKNOWN: the evidence
  // belongs to the unresolved one, whose own reconcile owns the verdict.
  if (unresolvedRow && unresolvedRow.result_class !== "unknown") {
    const family: PaymentAttemptType[] = operation === "capture" ? ["charge_start", "recovery"] : operation === "refund" ? ["refund", "cancel_refund"] : operation === "authorization" ? ["reauthorize"] : ["release"];
    const siblings = await listAttemptLifecycle(participantId, dealId);
    const otherUnresolved = siblings.find((row) => family.includes(row.attempt_type) && row.correlation_id !== correlationId && row.result_class === "unknown");
    if (otherUnresolved) return; // FR-4: the unresolved sibling identity owns this verdict
  }

  // R9C C1 — the exact operation may be IN FLIGHT right now: a worker holding
  // a live outbox lease armed its dispatch and the request may be at the
  // provider. A status read taken now can be true when read and stale the
  // moment it lands, so nothing may be concluded from it. Defer (bounded
  // outbox retry) until the owner settled the row or its lease died.
  // The guard is participant-wide: a reconcile job carrying a stale, legacy
  // or foreign correlation must not conclude anything either while any money
  // operation of this participant is in flight.
  const inFlight = await anyOperationInFlight(participantId, dealId);
  if (inFlight) {
    throw new DeferredEventError(
      `payment_reconcile_operation_in_flight participant ${participantId} ${inFlight.attempt_type} ${inFlight.correlation_id} (reconciling ${attemptType} ${correlationId || "no-correlation"})`,
      new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS)
    );
  }
  const policy = providerAmbiguityPolicy(paymentProvider);
  const deferIfInFlight = (error: unknown): never => {
    if (error instanceof PaymentOperationInFlightError || String((error as any)?.code || "") === "SN409") {
      throw new DeferredEventError(
        `payment_reconcile_operation_in_flight participant ${participantId} ${attemptType} ${correlationId}: ${String((error as Error)?.message || error)}`,
        new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS)
      );
    }
    throw error;
  };
  const failClosedUnresolved = async (observed: string) => {
    await openPaymentOperationalCase({
      autoKey: `payment-outcome-unresolved:${participantId}:${attemptType}:${correlationId || "no-correlation"}`,
      subject: `FINANCIAL_OUTCOME_UNRESOLVED ${attemptType} for participant ${participantId}`,
      description: `Provider ${paymentProvider.providerCode} reports "${observed}" after an ambiguous ${attemptType} (${correlationId || "no correlation"}); its contract cannot prove that this exact operation did not execute (${policy.basis}). No failure was declared, no recovery/refund/release was re-armed and no money call was repeated. Manual provider-side verification required; the participant's canonical state is NOT financial truth until resolved.`,
      correlationId
    });
    throw new PermanentFailError(`payment_reconcile_negative_status_unproven participant ${participantId}`);
  };

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

  const statusOperation = operation === "refund" ? "refund" : operation === "release" ? "release" : operation === "authorization" ? "authorization" : "capture";
  // LONG_HORIZON_DEALS — a renewal identity is proven ONLY through the
  // authorization it created (the reference its dispatching owner recorded, or
  // the one the provider answered with). The binding's CURRENT reference is a
  // DIFFERENT instrument: a status read about it can never settle the renewal.
  let statusReference = providerReference;
  if (operation === "authorization") {
    if (!unresolvedRow || unresolvedRow.result_class !== "unknown") return; // nothing to prove
    statusReference = String(unresolvedRow.provider_reference || payload.provider_reference || "").trim();
    if (!statusReference || statusReference === String(target.binding_reference || "").trim()) {
      if (policy.same_identity_repeat_safe) return; // the rail re-sends the SAME identity on its next run (provider replay); nothing to conclude here
      await openPaymentOperationalCase({
        autoKey: `payment-reauthorization-unresolved:${participantId}`,
        subject: `FINANCIAL_OUTCOME_UNRESOLVED: re-authorization ${correlationId} cannot be verified for participant ${participantId}`,
        description: `Re-authorization ${correlationId} of participant ${participantId} is unresolved and carries no provider reference of its own, and provider ${paymentProvider.providerCode} does not prove same-identity idempotency (${policy.basis}). No renewal was repeated, no capture was dispatched and no state was guessed; manual provider-side verification required.`,
        correlationId
      });
      throw new PermanentFailError(`payment_reconcile_reauthorization_unverifiable participant ${participantId}`);
    }
  }
  const status = await paymentProvider.status({
    provider_reference: statusReference,
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
  // Currency is part of the exact-operation identity (independent financial
  // review): an answer in another currency is evidence about some other
  // operation — visible case, no verdict, no state mutation.
  const expectedCurrency = String(target.binding_currency || "ILS").trim().toUpperCase();
  if (status.currency && operation !== "release" && String(status.currency).toUpperCase() !== expectedCurrency) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-currency-mismatch:${participantId}:${attemptType}`,
      subject: `Provider currency mismatch for participant ${participantId}`,
      description: `Provider reports ${status.amount_minor ?? "n/a"} ${status.currency} for ${attemptType} ${correlationId}; the authoritative obligation is ${expectedAmountMinor} ${expectedCurrency}. State was NOT mutated; manual reconciliation required.`,
      correlationId
    });
    throw new PermanentFailError(`payment_reconcile_currency_mismatch participant ${participantId}`);
  }
  // Residual A — a status answer naming ANOTHER reference (as judged by the
  // adapter, which knows the provider's reference discipline) is evidence about
  // some other operation: visible case, no verdict, no state mutation.
  if (status.reference_matches_query === false) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-reference-mismatch:${participantId}:${attemptType}`,
      subject: `Provider reference mismatch for participant ${participantId}`,
      description: `Provider answered the status query for ${providerReference} (${attemptType} ${correlationId}) with reference ${status.provider_reference || "n/a"} (state ${status.state}). The answer cannot be tied to this exact operation; state was NOT mutated and no money operation was started. Manual reconciliation required.`,
      correlationId
    });
    throw new PermanentFailError(`payment_reconcile_reference_mismatch participant ${participantId}`);
  }

  const ingestResolution = async (eventType: "charge_captured" | "charge_failed" | "recovery_captured" | "recovery_failed" | "refund_issued") => {
    let ingested: Awaited<ReturnType<typeof ingestAndProcessPaymentEvent>>;
    try {
      ingested = await ingestAndProcessPaymentEvent({
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
    } catch (error) {
      return deferIfInFlight(error);
    }
    // Exact-operation identity (independent financial review, O-1): a status
    // READ never rewrites the participant's durable provider reference. Only the
    // provider's answer to a money request this rail sent may do that; a status
    // echo naming another reference is evidence that cannot be tied to this
    // operation and must not become its identity.
    // The identity's durable outcome converges even when the canonical state
    // had already been reached by another path (ignored as already_*): success
    // for an executed effect, permanent_fail for a declared/authoritative
    // non-execution. Monotonic and in-flight guarded.
    if (correlationId) {
      const resultClass = eventType === "charge_failed" || eventType === "recovery_failed" ? "permanent_fail" : "success";
      await finalizeAttemptResult({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: attemptType as PaymentAttemptType,
        correlation_id: correlationId,
        result_class: resultClass,
        provider_reference: status.provider_reference || providerReference,
        // provenance (064): a failure declared here rests on a status read
        failure_evidence: resultClass === "permanent_fail" ? "status_inference" : null,
        note: `reconcile:${eventType}:${ingested.reason}`
      }).catch(deferIfInFlight);
    }
    return ingested.status === "processed";
  };

  if (operation === "capture") {
    const isRecovery = attemptType === "recovery";
    if (status.state === "captured") {
      await ingestResolution(isRecovery ? "recovery_captured" : "charge_captured");
      return;
    }
    if (status.state === "failed" || (status.state === "authorized" && status.final)) {
      if (!policy.negative_status_authoritative) {
        // R9C H1 / independent financial review — for this provider (Grow) a
        // status of "authorized" OR "failed" is the state of the TRANSACTION,
        // not the outcome of the exact settle Siton dispatched: the settle may
        // have executed and the lookup may still say failed. Fail closed: no
        // failure verdict, no recovery, no second settle — an operator case.
        await failClosedUnresolved(`${status.state}/${status.final ? "final" : "open"}`);
      }
      // Provider says the money was NOT captured (declined, or the hold is
      // still merely authorized and final) and no request for this exact
      // operation is in flight. The attempt row is settled INSIDE the state
      // transaction (CAS): if a worker armed this identity meanwhile, the
      // transition aborts and this job is deferred instead.
      const applied = await ingestResolution(isRecovery ? "recovery_failed" : "charge_failed");
      // A charge failure resolved late (or a capture identity that resolved as
      // not-executed for a participant already marked failed) must still get
      // its recovery chance while the completion window is open.
      if (!isRecovery && (applied || String(target.money_state) === "ChargeFailedRecovery")) {
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
  } else if (operation === "authorization") {
    // LONG_HORIZON_DEALS — an UNKNOWN re-authorization: did the provider
    // establish the new authorization? "authorized" is positive proof — the
    // renewal is applied to the binding atomically with the identity settle
    // and the waiting rail is woken; a final "failed" (authoritative provider)
    // settles the identity as not executed — the rail then lets the provider
    // decide on the ORIGINAL authorization at capture. No participant or deal
    // state moves here in either case; ambiguity stays ambiguous (bounded
    // retry, then a case), exactly like every other money identity.
    if (status.state === "authorized" && correlationId) {
      const renewedReference = status.provider_reference || statusReference;
      await withTx(async (c) => {
        await lockParticipantDealInTx(c, participantId, dealId);
        await settleAttemptInTx(c, {
          participant_id: participantId,
          deal_id: dealId,
          attempt_type: "reauthorize",
          correlation_id: correlationId,
          result_class: "success",
          provider_reference: renewedReference,
          note: `reconcile:authorization_confirmed:${status.final ? "final" : "open"}`
        });
        await paymentBindings.applyAuthorizationRenewalInTx(c, {
          participant_id: participantId,
          new_authorization_id: renewedReference,
          new_provider_reference: renewedReference,
          expires_at: null,
          correlation_id: correlationId
        });
      }).catch(deferIfInFlight);
      // wake the rail that waits on this renewal (idempotent: one pending job per deal/event type)
      if (waiting) {
        const railEvent = String(target.money_state) === "ChargeFailedRecovery" ? "recovery_deal" : "charge_deal";
        await withTx(async (c) => {
          await c.query(
            `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
             VALUES ($1,'deal',$2,$3,'pending',0, now())
             ON CONFLICT DO NOTHING`,
            [railEvent, dealId, JSON.stringify({ deal_id: dealId, reason: "reauthorization_confirmed" })]
          );
        }).catch(() => undefined);
      }
      return;
    }
    if (status.state === "failed" && status.final && correlationId) {
      if (!policy.negative_status_authoritative) await failClosedUnresolved(`${status.state}/final (re-authorization not visible)`);
      await finalizeAttemptResult({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: "reauthorize",
        correlation_id: correlationId,
        result_class: "permanent_fail",
        failure_evidence: "status_inference",
        note: "reconcile_reauthorization_not_executed"
      }).catch(deferIfInFlight);
      return;
    }
  } else if (operation === "refund") {
    if (status.state === "refunded") {
      await ingestResolution("refund_issued");
      return;
    }
    if ((status.state === "captured") && status.final) {
      if (!policy.negative_status_authoritative) await failClosedUnresolved(`${status.state}/final (refund not visible)`);
      // The refund never executed (authoritative negative status, not in
      // flight). Settle this identity as permanent_fail, then re-arm the
      // deal-scoped refund job (a NEW identity is legal only now).
      await finalizeAttemptResult({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: attemptType as any,
        correlation_id: correlationId,
        result_class: "permanent_fail",
        note: "reconcile_refund_not_executed"
      }).catch(deferIfInFlight);
      // Re-arm the deal-scoped refund job only while this participant is still
      // waiting for its refund (never re-fire a deal refund from a stale identity).
      if (waiting) {
        await withTx(async (c) => {
          await c.query(
            `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
             VALUES ('refund_issue','deal',$1,$2,'pending',0, now())
             ON CONFLICT DO NOTHING`,
            [dealId, JSON.stringify({ deal_id: dealId, reason: "reconcile_refund_not_executed" })]
          );
        });
      }
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
      if (!policy.negative_status_authoritative) await failClosedUnresolved(`${status.state}/final (release not visible)`);
      // The release never executed (authoritative negative status, not in
      // flight); settle this identity and re-arm the release job.
      await finalizeAttemptResult({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: "release",
        correlation_id: correlationId,
        result_class: "permanent_fail",
        note: "reconcile_release_not_executed"
      }).catch(deferIfInFlight);
      if (waiting) await schedulePaymentRelease({ participant_id: participantId, deal_id: dealId, reason: "reconcile_release_not_executed" });
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

  // A "pending" capture-side answer is positive evidence that the settlement is
  // still in progress: push the durable settlement horizon out (064) so no
  // recovery / release / terminal decision acts on this obligation meanwhile.
  if (operation === "capture" && status.state === "pending" && correlationId && policy.settlement_horizon_ms > 0) {
    await extendSettlementHorizon({ participant_id: participantId, deal_id: dealId, attempt_type: attemptType as PaymentAttemptType, correlation_id: correlationId, horizon_ms: policy.settlement_horizon_ms }).catch(() => undefined);
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
  if (!row) return false;
  const moneyState = String(row.money_state);
  if (moneyState === "ChargeAttempt") {
    // Residual C — a hold released while a charge was pending: the money truth
    // is AuthReleased ONLY if no capture-side operation of this participant is
    // unresolved or executed (the release fence keeps captures from starting
    // while a release is live; this is the belt).
    const captureSide = (await listAttemptLifecycle(participantId, dealId)).filter((r) => r.attempt_type === "charge_start" || r.attempt_type === "recovery");
    if (captureSide.some((r) => r.result_class === "unknown" || r.result_class === "success")) return false;
  } else if (!["AuthHeld", "AuthLocked", "ChargeFailedRecovery"].includes(moneyState)) return false;
  await atomicTransition({
    entityType: "participant",
    entityId: participantId,
    dealId,
    stateType: "money_state",
    fromState: moneyState,
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

// ---------------------------------------------------------------------------
// R9C — provider-operation identity discipline (every money rail).
//
// Before any provider call a rail asks beginProviderAttempt() for ONE durable
// identity. If an earlier attempt for the same participant/type is UNRESOLVED
// (recorded before I/O and never finalized — worker crash, stall, lease
// reclaim — or finalized as success but never persisted into state), the rail
// must NOT mint a fresh idempotency key: it resolves the prior identity through
// the provider's authoritative status seam first. Provider says executed →
// apply the canonical event (no new money call). Provider says the request
// never executed (final) → the SAME identity is reused, so a stale request that
// lands later is deduplicated provider-side. Ambiguous → Worker-owned reconcile
// rail (bounded retries, DLQ + operational case), no money call now.
//
// The worker also re-validates its outbox lease immediately before provider
// I/O (assertOutboxLeaseForProviderIo): a stale worker that resumes after its
// job was reclaimed is fenced BEFORE it can touch the provider.
// ---------------------------------------------------------------------------

type PriorAttemptResolution = "applied" | "reuse" | "deferred" | "blocked";

const PROVIDER_IO_LEASE_MARGIN_MS = Number(process.env.PAYMENT_PROVIDER_TIMEOUT_MS || 8_000) + 5_000;

async function assertOutboxLeaseForProviderIo(event: { event_uuid: string; lease_generation?: number | null }) {
  const generation = Number(event.lease_generation);
  if (!Number.isInteger(generation) || generation < 1) return; // not running under a worker lease (direct invocation)
  const owned = await assertLeaseForProviderIo(event.event_uuid, generation, PROVIDER_IO_LEASE_MARGIN_MS);
  if (!owned) throw new OutboxLeaseLostError(event.event_uuid);
}

type MoneyRailOutcome = "success" | "permanent_fail" | "unknown" | "pre_dispatch_failure";

/**
 * R9C C2 — the ONLY place a provider result becomes a lifecycle outcome. A
 * temporary failure counts as "nothing happened" solely when the adapter
 * PROVES it was pre-dispatch (dispatched === false); every other non-success
 * without a provider-declared outcome — 5xx, 429, 408, gateway errors,
 * connection reset, timeout, malformed/truncated body — is UNKNOWN.
 */
function classifyMoneyOutcome(result: PaymentExecutionResult): MoneyRailOutcome {
  if (result.result_class === "success") return "success";
  if (result.result_class === "permanent_fail") return "permanent_fail";
  if (result.result_class === "temporary_fail" && result.dispatched === false) return "pre_dispatch_failure";
  return "unknown";
}

/**
 * R9C — arm ONE identity for provider I/O. Lease fence (renewing a short
 * lease first), participant-state check and the lifecycle CAS happen in one
 * transaction: on success the row is `dispatching` under this job's lease and
 * every reconciler treats the operation as IN_FLIGHT. A lost lease throws
 * (`lease_lost`, no ACK); any other refusal means "no I/O for this
 * participant now".
 */
async function armMoneyOperation(args: {
  event: { event_uuid: string; lease_generation?: number | null };
  participant_id: string;
  deal_id: string;
  attempt_type: PaymentAttemptType;
  correlation_id: string;
  expected_money_states: string[];
  expected_buyer_states?: string[];
  provider_reference?: string | null;
}): Promise<boolean> {
  await assertOutboxLeaseForProviderIo(args.event);
  const armed = await armProviderDispatch({
    participant_id: args.participant_id,
    deal_id: args.deal_id,
    attempt_type: args.attempt_type,
    correlation_id: args.correlation_id,
    event_uuid: args.event.event_uuid,
    lease_generation: args.event.lease_generation,
    worker_id: outboxWorkerId,
    // The margin/renewal semantics live in assertOutboxLeaseForProviderIo
    // (called just above, renews a short lease); arming requires the renewed
    // lease to be LIVE and owned by this worker at the moment of the CAS.
    min_lease_remaining_ms: 0,
    expected_money_states: args.expected_money_states,
    ...(args.expected_buyer_states ? { expected_buyer_states: args.expected_buyer_states } : {}),
    provider_reference: args.provider_reference ?? null,
    // Independent financial review — a capture-side dispatch opens the
    // provider-specific SETTLEMENT HORIZON on the identity (migration 064).
    settlement_horizon_ms: args.attempt_type === "charge_start" || args.attempt_type === "recovery"
      ? providerAmbiguityPolicy(paymentProvider).settlement_horizon_ms
      : null,
    // Residual A — the provider contract's negative-finality authority is
    // recorded on the identity at dispatch; a NEGATIVE status read can only ever
    // lift the settlement fence for a row dispatched under an authoritative
    // contract (Grow: never; legacy rows: never).
    negative_finality_authoritative: args.attempt_type === "charge_start" || args.attempt_type === "recovery"
      ? providerAmbiguityPolicy(paymentProvider).negative_status_authoritative
      : null
  });
  if (armed === "armed") return true;
  if (armed === "lease_lost") throw new OutboxLeaseLostError(args.event.event_uuid);
  return false;
}

/**
 * SR-1 — the dispatching owner's settlement. A worker whose lease died while
 * its identity was re-armed by a live successor may write nothing but SUCCESS
 * (provider truth) onto that identity: its `unknown`/failure would flip the
 * successor's IN_FLIGHT row to responded and blind the C1 in-flight guard
 * (reconcile → false charge_failed → recovery = a SECOND money effect).
 * A refused settlement means this job is stale: it aborts exactly like a lost
 * outbox lease — no ACK, no reconcile scheduling, no further writes.
 */
async function settleOwnedMoneyOperation(args: Parameters<typeof settleProviderDispatch>[0]): Promise<void> {
  const settled = await settleProviderDispatch(args);
  if (settled === "settled") return;
  if (settled === "foreign_owner") throw new OutboxLeaseLostError(args.owner.event_uuid);
  throw new Error(`payment_attempt_identity_missing ${args.attempt_type} ${args.correlation_id}`);
}

/**
 * R9C — a rail may not start while another money operation of the same
 * participant is unresolved (or, for recovery/release, already moved money).
 * Nothing is sent to the provider; the unresolved operation is handed to the
 * reconcile rail and the hold is made visible as FINANCIAL_OUTCOME_UNRESOLVED.
 */
async function handleBlockedMoneyOperation(args: {
  participant_id: string;
  deal_id: string;
  attempt_type: PaymentAttemptType;
  reason: string;
  blocking: { attempt_type: PaymentAttemptType; correlation_id: string; result_class: string };
  provider_reference: string | null;
  event_id: string;
}) {
  const blockingOperation: PaymentReconcilePayload["operation"] =
    args.blocking.attempt_type === "refund" || args.blocking.attempt_type === "cancel_refund"
      ? "refund"
      : args.blocking.attempt_type === "release"
        ? "release"
        : args.blocking.attempt_type === "reauthorize"
          ? "authorization"
          : "capture";
  if (args.blocking.result_class === "unknown") {
    const blockingReference = blockingOperation === "authorization"
      ? (await loadAttemptLifecycle({ participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: "reauthorize", correlation_id: args.blocking.correlation_id }))?.provider_reference ?? null
      : args.provider_reference;
    await schedulePaymentReconcile({
      participant_id: args.participant_id,
      deal_id: args.deal_id,
      attempt_type: args.blocking.attempt_type as PaymentReconcilePayload["attempt_type"],
      correlation_id: args.blocking.correlation_id,
      operation: blockingOperation,
      provider_reference: blockingReference,
      reason: `blocks_${args.attempt_type}`
    });
  }
  await openPaymentOperationalCase({
    autoKey: `payment-operation-blocked:${args.participant_id}:${args.attempt_type}`,
    subject: `FINANCIAL_OUTCOME_UNRESOLVED: ${args.attempt_type} blocked for participant ${args.participant_id}`,
    description: `${args.reason}: prior ${args.blocking.attempt_type} ${args.blocking.correlation_id} is ${args.blocking.result_class}. No ${args.attempt_type} provider operation was started (worker event ${args.event_id}); the participant's canonical state is not financial truth until that operation is resolved${args.blocking.result_class === "unknown" ? " (payment_reconcile scheduled)" : " — money was already captured for this participant; operator reconciliation required"}.`,
    correlationId: args.blocking.correlation_id
  });
}

async function resolvePriorProviderAttempt(args: {
  operation: "capture" | "refund" | "release";
  attempt_type: PaymentAttemptType;
  participant_id: string;
  deal_id: string;
  correlation_id: string;
  dispatch_state?: PaymentDispatchState;
  provider_reference: string | null;
  expected_amount_minor: number | null;
  expected_currency?: string | null;
  event_id: string;
}): Promise<PriorAttemptResolution> {
  // NOT_DISPATCHED: the identity was minted but no request ever left the
  // process — sending it now is the FIRST send, no status lookup needed.
  if (args.dispatch_state === "recorded") return "reuse";
  const policy = providerAmbiguityPolicy(paymentProvider);
  // Re-sending the SAME identity after a negative status observation is safe
  // when the provider proves non-execution (negative status authoritative) OR
  // deduplicates the identity itself; otherwise the operation stays a manual
  // case — never a second money request.
  const reuseAfterNegative = async (observed: string): Promise<PriorAttemptResolution> => {
    if (policy.negative_status_authoritative || policy.same_identity_repeat_safe) return "reuse";
    await openPaymentOperationalCase({
      autoKey: `payment-outcome-unresolved:${args.participant_id}:${args.attempt_type}:${args.correlation_id}`,
      subject: `FINANCIAL_OUTCOME_UNRESOLVED ${args.attempt_type} for participant ${args.participant_id}`,
      description: `Prior ${args.attempt_type} ${args.correlation_id} is unresolved and provider ${paymentProvider.providerCode} reports "${observed}"; its contract proves neither non-execution nor same-identity idempotency (${policy.basis}). No provider operation was repeated; manual verification required.`,
      correlationId: args.correlation_id
    });
    return "blocked";
  };
  const reference = String(args.provider_reference || "").trim();
  const finalizePrior = (result_class: "success" | "permanent_fail") => finalizeAttemptResult({
    participant_id: args.participant_id,
    deal_id: args.deal_id,
    attempt_type: args.attempt_type,
    correlation_id: args.correlation_id,
    result_class,
    failure_evidence: result_class === "permanent_fail" ? "status_inference" : null,
    note: "prior_attempt_resolution"
  });
  if (!paymentProvider.status || !reference) {
    await openPaymentOperationalCase({
      autoKey: `payment-prior-attempt-unverifiable:${args.participant_id}:${args.attempt_type}`,
      subject: `Unresolved ${args.attempt_type} attempt cannot be verified for participant ${args.participant_id}`,
      description: `A prior ${args.attempt_type} attempt (${args.correlation_id}) is unresolved and ${paymentProvider.status ? "has no durable provider reference" : `provider ${paymentProvider.providerCode} exposes no status capability`}. No new provider operation was started; manual provider-side verification is required.`,
      correlationId: args.correlation_id
    });
    return "blocked";
  }
  const status = await paymentProvider.status({
    provider_reference: reference,
    operation: args.operation,
    correlation_id: args.correlation_id
  });
  if (
    status.amount_minor !== null &&
    Number.isInteger(status.amount_minor) &&
    args.operation !== "release" &&
    args.expected_amount_minor !== null &&
    Number(status.amount_minor) !== args.expected_amount_minor
  ) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-amount-mismatch:${args.participant_id}:${args.attempt_type}`,
      subject: `Provider amount mismatch for participant ${args.participant_id}`,
      description: `Provider reports ${status.amount_minor} minor units for ${args.attempt_type} ${args.correlation_id}; authoritative amount is ${args.expected_amount_minor}. State was NOT mutated and no new provider operation was started.`,
      correlationId: args.correlation_id
    });
    return "blocked";
  }
  const expectedCurrency = String(args.expected_currency || "").trim().toUpperCase();
  if (expectedCurrency && status.currency && args.operation !== "release" && String(status.currency).toUpperCase() !== expectedCurrency) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-currency-mismatch:${args.participant_id}:${args.attempt_type}`,
      subject: `Provider currency mismatch for participant ${args.participant_id}`,
      description: `Provider reports ${status.amount_minor ?? "n/a"} ${status.currency} for ${args.attempt_type} ${args.correlation_id}; the authoritative obligation is ${args.expected_amount_minor ?? "n/a"} ${expectedCurrency}. State was NOT mutated and no new provider operation was started.`,
      correlationId: args.correlation_id
    });
    return "blocked";
  }
  if (status.reference_matches_query === false) {
    await openPaymentOperationalCase({
      autoKey: `payment-reconcile-reference-mismatch:${args.participant_id}:${args.attempt_type}`,
      subject: `Provider reference mismatch for participant ${args.participant_id}`,
      description: `Provider answered the status query for ${reference} (${args.attempt_type} ${args.correlation_id}) with reference ${status.provider_reference || "n/a"} (state ${status.state}). The answer cannot be tied to this exact operation; no new provider operation was started.`,
      correlationId: args.correlation_id
    });
    return "blocked";
  }
  const providerReference = status.provider_reference || reference;
  const ingest = async (eventType: "charge_captured" | "charge_failed" | "recovery_captured" | "recovery_failed" | "refund_issued") => {
    await ingestAndProcessPaymentEvent({
      provider: paymentProvider.providerCode,
      event_id: `reconcile:${args.correlation_id}:${eventType}`,
      event_type: eventType,
      correlation_id: args.correlation_id,
      participant_id: args.participant_id,
      deal_id: args.deal_id,
      provider_reference: providerReference,
      payload: {
        source: "prior_attempt_resolution",
        worker_event_id: args.event_id,
        provider_reference: providerReference,
        provider_state: status.state,
        provider_final: status.final
      }
    });
    // O-1 (independent financial review): a status READ never rewrites the
    // durable provider reference — see handlePaymentReconcileEvent.
  };

  if (args.operation === "capture") {
    const isRecovery = args.attempt_type === "recovery";
    if (status.state === "captured") {
      await ingest(isRecovery ? "recovery_captured" : "charge_captured");
      await finalizePrior("success");
      return "applied";
    }
    if (status.state === "failed") {
      // A "failed" transaction status proves non-execution of the EXACT
      // request only for providers whose status is per operation; for the
      // others (Grow) it is not a verdict — the case is opened, nothing moves.
      if (!policy.negative_status_authoritative) return reuseAfterNegative(`failed/${status.final ? "final" : "open"}`);
      await ingest(isRecovery ? "recovery_failed" : "charge_failed");
      await finalizePrior("permanent_fail");
      return "applied";
    }
    if (status.state === "authorized" && status.final) return reuseAfterNegative("authorized/final");
  } else if (args.operation === "refund") {
    if (status.state === "refunded") {
      await ingest("refund_issued");
      await finalizePrior("success");
      return "applied";
    }
    if (status.state === "captured" && status.final) return reuseAfterNegative("captured/final (refund not visible)");
  } else {
    if (status.state === "released") {
      await applyAuthorizationRelease(args.participant_id, args.deal_id, `worker:${args.event_id}`, args.correlation_id);
      await finalizePrior("success");
      return "applied";
    }
    if (status.state === "authorized" && status.final) return reuseAfterNegative("authorized/final (release not visible)");
    if (status.state === "captured") {
      await openPaymentOperationalCase({
        autoKey: `payment-reconcile-release-captured:${args.participant_id}`,
        subject: `Hold intended for release was captured (participant ${args.participant_id})`,
        description: `Provider reports captured for a hold Siton tried to release (correlation ${args.correlation_id}). Manual reconciliation required; no state was guessed.`,
        correlationId: args.correlation_id
      });
      return "blocked";
    }
  }

  await schedulePaymentReconcile({
    participant_id: args.participant_id,
    deal_id: args.deal_id,
    attempt_type: args.attempt_type as PaymentReconcilePayload["attempt_type"],
    correlation_id: args.correlation_id,
    operation: args.operation,
    provider_reference: reference,
    reason: "prior_attempt_unresolved_before_new_operation"
  });
  return "deferred";
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
    lease_generation?: number | null;
  },
  eventId: string
) {
  const payload = (event.payload || {}) as { participant_id?: string; deal_id?: string; reason?: string };
  const participantId = String(payload.participant_id || event.aggregate_id);
  const dealId = String(payload.deal_id || "");
  if (!dealId) throw new PermanentFailError(`payment_release missing deal_id for participant ${participantId}`);

  const target = await loadReconcileParticipant(participantId, dealId);
  if (!target) throw new PermanentFailError(`payment_release participant not found ${participantId}`);
  // R9C ROUND 4 (F-16) — ChargeAttempt admitted (Residual C release of a hold whose capture never ran)
  if (!["AuthHeld", "AuthLocked", "ChargeFailedRecovery", "ChargeAttempt"].includes(String(target.money_state))) return; // already resolved

  const providerReference = String(target.binding_reference || "").trim();
  // R9C — durable identity + reconcile-before-new-operation (see charge rail).
  const attempt = await beginProviderAttempt({
    participant_id: participantId,
    deal_id: dealId,
    attempt_type: "release",
    identity: (logicalAttempt) => `release:${eventId}:n${logicalAttempt}:${participantId}`,
    // R9C ROUND 5 — the mint is admitted only in the states the arm requires;
    // a never-dispatched capture identity of this hold is retired here (it
    // cannot have moved money) instead of blocking the release for ever.
    admitted: { money_states: ["AuthHeld", "AuthLocked", "ChargeFailedRecovery", "ChargeAttempt"] }
  });
  if (attempt.kind === "state_changed") return; // already resolved elsewhere between the read and the mint
  if (attempt.kind === "blocked") {
    await handleBlockedMoneyOperation({ participant_id: participantId, deal_id: dealId, attempt_type: "release", reason: attempt.reason, blocking: attempt.blocking, provider_reference: providerReference || null, event_id: eventId });
    return;
  }
  if (attempt.kind === "in_flight") return; // another live worker owns this exact operation
  if (attempt.kind === "fenced") {
    if (attempt.permanent || !attempt.until) {
      // Residual A / B — the capture-side failure cannot be resolved by waiting
      // (negative finality unproven for the provider, or a legacy row): the hold
      // is neither released nor captured automatically — operator case.
      await openPaymentOperationalCase({
        autoKey: `payment-release-negative-finality-unproven:${participantId}`,
        subject: `FINANCIAL_OUTCOME_UNRESOLVED: release held — negative finality unproven for participant ${participantId}`,
        description: `${attempt.reason}: a capture-side operation of participant ${participantId} was recorded as failed from status evidence and provider ${paymentProvider.providerCode} does not prove non-execution of the exact operation from a negative status (or the row predates the settlement-horizon policy). The authorization is not released (a release of captured money is irreversible); verify at the provider and record failure_evidence='operator' on the identity (worker event ${eventId}).`,
        correlationId: null
      });
      throw new PermanentFailError(`payment_release_negative_finality_unproven participant ${participantId}`);
    }
    // Independent financial review — SETTLEMENT HORIZON (migration 064): a
    // capture-side failure inferred from status may still settle; releasing the
    // hold now would be release-then-capture. Defer to the horizon, visibly.
    await openPaymentOperationalCase({
      autoKey: `payment-release-settlement-horizon:${participantId}`,
      subject: `Release held until the provider settlement horizon for participant ${participantId}`,
      description: `${attempt.reason}: provider ${paymentProvider.providerCode} may still settle a capture-side operation of participant ${participantId} until ${attempt.until.toISOString()}. The authorization is not released before that instant (worker event ${eventId}); the release job is deferred to the horizon.`,
      correlationId: null
    });
    throw new DeferredEventError(`payment_release_fenced participant ${participantId} until ${attempt.until.toISOString()}`, attempt.until);
  }
  if (attempt.kind === "unresolved") {
    const resolution = await resolvePriorProviderAttempt({
      operation: "release",
      attempt_type: "release",
      participant_id: participantId,
      deal_id: dealId,
      correlation_id: attempt.correlation_id,
      dispatch_state: attempt.dispatch_state,
      provider_reference: providerReference || null,
      expected_amount_minor: null,
      event_id: eventId
    });
    if (resolution !== "reuse") return;
  }
  const correlation = attempt.correlation_id;

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
  await hitTestFault("payment.before_provider_io");
  // R9C — arm: lease fence + state check + lifecycle CAS, then the LAST step
  // before external money I/O.
  const armed = await armMoneyOperation({
    event,
    participant_id: participantId,
    deal_id: dealId,
    attempt_type: "release",
    correlation_id: correlation,
    expected_money_states: ["AuthHeld", "AuthLocked", "ChargeFailedRecovery", "ChargeAttempt"],
    provider_reference: providerReference || null
  });
  if (!armed) return;
  const owner = { event_uuid: event.event_uuid, lease_generation: event.lease_generation };
  const result = await paymentProvider.release(releaseInput);
  await hitTestFault("payment.after_provider_io");
  const outcome = classifyMoneyOutcome(result);
  const settle = (settled: MoneyRailOutcome, note?: string) => settleOwnedMoneyOperation({
    participant_id: participantId,
    deal_id: dealId,
    attempt_type: "release",
    correlation_id: correlation,
    owner,
    outcome: settled,
    provider_reference: result.provider_reference || providerReference || null,
    ...(note ? { note } : {})
  });

  if (outcome === "success") {
    await settle("success");
    await applyAuthorizationRelease(participantId, dealId, `worker:${eventId}`, correlation);
    return;
  }

  if (outcome === "pre_dispatch_failure") {
    // Nothing reached the provider: disarm, keep the SAME identity for the retry.
    await settle("pre_dispatch_failure", `pre_dispatch_failure:${result.provider}`);
    throw new Error(`temporary_fail release participant ${participantId} (pre-dispatch, identity ${correlation} retained)`);
  }

  if (outcome === "unknown") {
    // R9C C2 — 5xx/429/timeout/transport loss AFTER dispatch: the release may
    // have happened. Durable UNKNOWN on the SAME identity, reconcile decides.
    await settle("unknown", `provider_outcome_unknown:${result.result_class}`);
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

  await settle("permanent_fail");
  await openPaymentOperationalCase({
    autoKey: `payment-release-failed:${participantId}`,
    subject: `Provider refused authorization release for participant ${participantId}`,
    description: `Release attempt ${correlation} permanently failed at provider ${paymentProvider.providerCode}. The hold remains represented as held; manual provider-side action required.`,
    correlationId: correlation
  });
  throw new PermanentFailError(`permanent_fail release participant ${participantId}`);
}

// ---------------------------------------------------------------------------
// LONG_HORIZON_DEALS — the payment boundary between the buyer's COMMITMENT and
// the CURRENT provider authorization instrument.
//
// A deal may live far longer than a card authorization. Before a capture-side
// operation is dispatched the rail asks: can the participant's current
// authorization still legally be used?
//   * no binding / no declared validity   → the provider decides at capture
//   * declared validity still open        → proceed on the current authorization
//   * declared validity passed (or the provider declared the instrument
//     unusable in its answer to a capture) → RE-ESTABLISH the authorization from
//     the stored payment-method reference through the provider abstraction,
//     then proceed on the renewed authorization
//   * provider lacks the capability / no stored instrument / renewal declined
//     → proceed on the original authorization: the provider is the authority,
//       and a decline then follows the existing recovery rules (a definitive
//       inability to obtain the payment result, not "the deal aged")
// Renewal is a money-side operation in every respect: ONE durable identity
// (attempt_type 'reauthorize') minted before I/O, armed under the worker lease,
// settled by its owner, idempotent on retry, reconciled when ambiguous, and
// blocking every capture/recovery/release of the same obligation while
// unresolved (071). The participant's visible state never moves because an
// authorization expired.
// ---------------------------------------------------------------------------
type AuthorizationGate =
  | { kind: "proceed"; authorization_id: string | null; renewed: boolean }
  | { kind: "defer"; until: Date }
  | { kind: "skip" };

async function renewalEligibilityForParticipant(participantId: string, dealId: string) {
  const source = await paymentBindings.resolveRenewalSourceForParticipant(participantId, paymentProvider.providerCode);
  if (!source.binding) return { eligible: false as const, reason: "no_binding", source };
  if (!paymentProvider.reauthorize) return { eligible: false as const, reason: "provider_capability_missing", source };
  if (!source.payment_method_ref) return { eligible: false as const, reason: "no_stored_instrument", source };
  // a renewal the provider already DECLINED for the current instrument is not
  // repeated in a loop: the capture proceeds and the provider decides
  const rows = await listAttemptLifecycle(participantId, dealId);
  const lastRenewal = [...rows].reverse().find((row) => row.attempt_type === "reauthorize");
  if (lastRenewal && lastRenewal.result_class === "permanent_fail"
    && Date.parse(lastRenewal.created_at) >= Date.parse(String(source.binding.authorization_established_at))) {
    return { eligible: false as const, reason: "renewal_declined_for_current_instrument", source };
  }
  return { eligible: true as const, reason: "eligible", source };
}

async function ensureUsableAuthorizationForCapture(args: {
  event: { event_uuid: string; lease_generation?: number | null };
  event_id: string;
  participant_id: string;
  deal_id: string;
  buyer_id: string;
  amount_minor: number;
  rail: "charge_start" | "recovery";
  fallback_authorization_id: string | null;
}): Promise<AuthorizationGate> {
  const admitted = args.rail === "charge_start"
    ? { money_states: ["ChargeAttempt"], buyer_states: ["ChargingAttempt"] }
    : { money_states: ["ChargeFailedRecovery"], buyer_states: ["ChargeFailedCompletion"] };
  const eligibility = await renewalEligibilityForParticipant(args.participant_id, args.deal_id);
  const binding = eligibility.source.binding;
  const current = String(binding?.provider_reference || args.fallback_authorization_id || "").trim() || null;
  if (!binding) return { kind: "proceed", authorization_id: current, renewed: false };
  const usability = assessAuthorizationUsability(binding);
  if (usability.usability !== "expired") return { kind: "proceed", authorization_id: current, renewed: false };
  if (!eligibility.eligible) {
    app.log.info({ participant_id: args.participant_id, deal_id: args.deal_id, reason: eligibility.reason, expires_at: binding.expires_at }, "authorization past declared validity: no renewal path, provider decides at capture");
    return { kind: "proceed", authorization_id: current, renewed: false };
  }
  const paymentMethodRef = eligibility.source.payment_method_ref!;
  const policy = providerAmbiguityPolicy(paymentProvider);

  const attempt = await beginProviderAttempt({
    participant_id: args.participant_id,
    deal_id: args.deal_id,
    attempt_type: "reauthorize",
    identity: (logicalAttempt) => reauthorizationIdentity(args.event_id, logicalAttempt, args.participant_id),
    admitted
  });
  if (attempt.kind === "state_changed") return { kind: "skip" };
  if (attempt.kind === "fenced") return { kind: "skip" }; // unreachable for a renewal (the 068 fence reads capture-side rows only)
  if (attempt.kind === "blocked") {
    await handleBlockedMoneyOperation({ participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: "reauthorize", reason: attempt.reason, blocking: attempt.blocking, provider_reference: current, event_id: args.event_id });
    return attempt.blocking.result_class === "unknown" ? { kind: "defer", until: new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS) } : { kind: "skip" };
  }
  if (attempt.kind === "in_flight") {
    // another live worker is renewing this very authorization: wait for its truth
    return { kind: "defer", until: new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS) };
  }
  let correlation = attempt.correlation_id;
  if (attempt.kind === "unresolved") {
    // The identity may have reached the provider (crash / stall after dispatch).
    // A reference the provider already answered with is resolved through the
    // status seam; otherwise the SAME identity is re-sent only when the provider
    // deduplicates it (same_identity_repeat_safe) — never a fresh identity.
    const row = await loadAttemptLifecycle({ participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: "reauthorize", correlation_id: attempt.correlation_id });
    const knownReference = String(row?.provider_reference || "").trim();
    if (knownReference && paymentProvider.status) {
      const status = await paymentProvider.status({ provider_reference: knownReference, operation: "authorization", correlation_id: attempt.correlation_id });
      if (status.state === "authorized" && status.reference_matches_query !== false) {
        await withTx(async (c) => {
          await lockParticipantDealInTx(c, args.participant_id, args.deal_id);
          await settleAttemptInTx(c, { participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: "reauthorize", correlation_id: attempt.correlation_id, result_class: "success", provider_reference: status.provider_reference || knownReference, note: "prior_reauthorization_confirmed_by_status" });
          await paymentBindings.applyAuthorizationRenewalInTx(c, { participant_id: args.participant_id, new_authorization_id: status.provider_reference || knownReference, new_provider_reference: status.provider_reference || knownReference, expires_at: null, correlation_id: attempt.correlation_id });
        });
        return { kind: "proceed", authorization_id: status.provider_reference || knownReference, renewed: true };
      }
      if (status.state === "failed" && status.final && policy.negative_status_authoritative) {
        await finalizeAttemptResult({ participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: "reauthorize", correlation_id: attempt.correlation_id, result_class: "permanent_fail", failure_evidence: "status_inference", note: "prior_reauthorization_not_executed" });
        return { kind: "proceed", authorization_id: current, renewed: false };
      }
      await schedulePaymentReconcile({ participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: "reauthorize", correlation_id: attempt.correlation_id, operation: "authorization", provider_reference: knownReference, reason: "prior_reauthorization_unresolved" });
      return { kind: "defer", until: new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS) };
    }
    if (!policy.same_identity_repeat_safe) {
      await openPaymentOperationalCase({
        autoKey: `payment-reauthorization-unresolved:${args.participant_id}`,
        subject: `FINANCIAL_OUTCOME_UNRESOLVED: re-authorization ${attempt.correlation_id} is unresolved for participant ${args.participant_id}`,
        description: `A re-authorization of participant ${args.participant_id} (deal ${args.deal_id}) may have reached provider ${paymentProvider.providerCode} without a recorded answer, and the provider contract does not prove same-identity idempotency (${policy.basis}). No renewal was repeated and no capture was dispatched (worker event ${args.event_id}); manual provider-side verification required.`,
        correlationId: attempt.correlation_id
      });
      return { kind: "skip" };
    }
    correlation = attempt.correlation_id; // provider dedupes: re-send the SAME identity
  }

  await hitTestFault("payment.before_provider_io");
  const armed = await armMoneyOperation({
    event: args.event,
    participant_id: args.participant_id,
    deal_id: args.deal_id,
    attempt_type: "reauthorize",
    correlation_id: correlation,
    expected_money_states: admitted.money_states,
    expected_buyer_states: admitted.buyer_states,
    provider_reference: null
  });
  if (!armed) return { kind: "skip" };
  const owner = { event_uuid: args.event.event_uuid, lease_generation: args.event.lease_generation };
  const result = await paymentProvider.reauthorize!({
    payment_method_ref: paymentMethodRef,
    amount_minor: args.amount_minor,
    currency: "ILS",
    buyer_id: args.buyer_id,
    deal_id: args.deal_id,
    participant_id: args.participant_id,
    replaced_authorization_id: binding.authorization_id,
    correlation_id: correlation,
    request_id: `worker:${args.event_id}`
  });
  await hitTestFault("payment.after_provider_io");
  const settle = (outcome: MoneyRailOutcome, note?: string, inside?: (c: PoolClient) => Promise<void>) => settleOwnedMoneyOperation({
    participant_id: args.participant_id,
    deal_id: args.deal_id,
    attempt_type: "reauthorize",
    correlation_id: correlation,
    owner,
    outcome,
    provider_reference: result.ok ? result.provider_reference : null,
    ...(note ? { note } : {}),
    ...(inside ? { inside } : {})
  });

  if (result.ok && result.authorization === "authorized") {
    // The renewed instrument becomes current ATOMICALLY with the identity's success.
    await settle("success", "authorization_renewed", async (c) => {
      await paymentBindings.applyAuthorizationRenewalInTx(c, {
        participant_id: args.participant_id,
        new_authorization_id: result.authorization_id,
        new_provider_reference: result.provider_reference || result.authorization_id,
        expires_at: result.expires_at ?? null,
        correlation_id: correlation
      });
    });
    app.log.info({ participant_id: args.participant_id, deal_id: args.deal_id, correlation }, "authorization renewed at the charging boundary");
    return { kind: "proceed", authorization_id: result.provider_reference || result.authorization_id, renewed: true };
  }
  if (result.ok) {
    // pending provider confirmation: the reconcile rail proves it through status
    await settle("unknown", "reauthorization_pending_provider_confirmation");
    await schedulePaymentReconcile({ participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: "reauthorize", correlation_id: correlation, operation: "authorization", provider_reference: result.provider_reference || result.authorization_id, reason: "reauthorization_pending" });
    return { kind: "defer", until: new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS) };
  }
  if (result.dispatched === false) {
    // proven pre-dispatch (configuration / validation): nothing reached the
    // provider — disarm, keep the identity, let the provider decide on the
    // original authorization; visible as a case because it is a system issue
    await settle("pre_dispatch_failure", `pre_dispatch_failure:${result.error}`);
    await openPaymentOperationalCase({
      autoKey: `payment-reauthorization-unavailable:${args.participant_id}`,
      subject: `Re-authorization unavailable for participant ${args.participant_id}: ${result.error}`,
      description: `The stored-instrument re-authorization of participant ${args.participant_id} (deal ${args.deal_id}) could not be sent to provider ${paymentProvider.providerCode} (${result.error}: ${result.message}). The capture proceeds on the original authorization and the provider decides; a decline follows the normal recovery rules (worker event ${args.event_id}).`,
      correlationId: correlation
    });
    return { kind: "proceed", authorization_id: current, renewed: false };
  }
  if (result.retryable) {
    // post-dispatch ambiguity (5xx / timeout / transport loss): the provider may
    // have created the authorization. Durable UNKNOWN on the SAME identity; the
    // next run re-sends it (the provider deduplicates) or resolves it by status.
    await settle("unknown", `reauthorization_outcome_unknown:${result.error}`);
    return { kind: "defer", until: new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS) };
  }
  // provider-declared decline of the renewal: definitive for this instrument —
  // the capture proceeds on the original authorization and the provider decides
  await settle("permanent_fail", `reauthorization_declined:${result.error}`);
  app.log.warn({ participant_id: args.participant_id, deal_id: args.deal_id, error: result.error, correlation }, "authorization renewal declined; capture proceeds on the original authorization");
  return { kind: "proceed", authorization_id: current, renewed: false };
}

async function handleChargeDealEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
    lease_generation?: number | null;
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

  // Residual C — a capture blocked behind an UNRESOLVED release of its hold is
  // not skipped for good: the job retries (bounded) once the release truth exists.
  // LONG_HORIZON_DEALS — the same deferral carries a participant whose
  // authorization renewal is unresolved (in flight elsewhere / pending at the
  // provider): the deal stays Charging until the renewal resolves; no visible
  // state moves on an ambiguous instrument.
  const chargeHold: { until: Date | null } = { until: null };
  const holdUntil = (at: Date) => { if (!chargeHold.until || at.getTime() < chargeHold.until.getTime()) chargeHold.until = at; };

  // ONE capture attempt for a participant on the authorization the gate handed
  // over (the original, or the renewed one). Byte-for-byte the R9C capture rail;
  // the only addition is the instrument-unusable branch.
  const captureParticipantOnce = async (
    p: (typeof participants)[number],
    amountMinor: number,
    ctx: { allow_renewal_retry: boolean }
  ): Promise<"done" | "renew_and_retry"> => {
    // R9C — ONE durable provider-operation identity per logical attempt,
    // minted from the attempts table (never from the outbox attempt_count).
    // An unresolved prior attempt is reconciled through the provider status
    // seam BEFORE any fresh money call; a provider-declared failure is the
    // only thing that mints a new identity (still a distinct attempt for the
    // 30-minute cap, migration 050).
    const attempt = await beginProviderAttempt({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      identity: (logicalAttempt) => `capture:${eventId}:n${logicalAttempt}:${p.participant_id}`,
      // R9C ROUND 5 — the participant snapshot above is NOT what the mint
      // trusts: the state is re-read under the participant/deal lock (the lock
      // the finalizer's F-15 guard takes) and an identity is minted only while
      // the participant is still ChargingAttempt/ChargeAttempt. A finalizer
      // that failed the participant meanwhile leaves NO orphan identity behind.
      admitted: { money_states: ["ChargeAttempt"], buyer_states: ["ChargingAttempt"] }
    });
    if (attempt.kind === "state_changed") return "done" as const; // decided elsewhere (finalize) between the read and the mint: nothing minted, nothing sent
    if (attempt.kind === "blocked") {
      if (attempt.reason === "capture_blocked_by_released_authorization") {
        // Residual C — the hold was RELEASED at the provider (release identity
        // success) while this charge was pending: a capture of a released hold
        // is a contradictory economic operation and is never dispatched. The
        // money truth is the provider-proofed release; the deal decides later.
        await applyAuthorizationRelease(p.participant_id, dealId, `worker:${eventId}`, attempt.blocking.correlation_id);
        await openPaymentOperationalCase({
          autoKey: `payment-capture-refused-released-hold:${p.participant_id}`,
          subject: `Capture refused: the authorization of participant ${p.participant_id} was released while the charge was pending`,
          description: `Release ${attempt.blocking.correlation_id} executed at provider ${paymentProvider.providerCode} before the capture of participant ${p.participant_id} could be dispatched (worker event ${eventId}). No capture was sent; the participant's money state is AuthReleased and the deal will decide without this participant.`,
          correlationId: attempt.blocking.correlation_id
        });
        return "done" as const;
      }
      await handleBlockedMoneyOperation({ participant_id: p.participant_id, deal_id: dealId, attempt_type: "charge_start", reason: attempt.reason, blocking: attempt.blocking, provider_reference: p.authorization_id || null, event_id: eventId });
      if (attempt.reason === "capture_blocked_by_unresolved_release") holdUntil(new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS));
      return "done" as const;
    }
    if (attempt.kind === "in_flight") return "done" as const; // another live worker owns this exact operation
    if (attempt.kind === "fenced") return "done" as const; // unreachable for a capture (the 064 fence applies to recovery/release); never mint on it
    if (attempt.kind === "unresolved") {
      const resolution = await resolvePriorProviderAttempt({
        operation: "capture",
        attempt_type: "charge_start",
        participant_id: p.participant_id,
        deal_id: dealId,
        correlation_id: attempt.correlation_id,
        dispatch_state: attempt.dispatch_state,
        provider_reference: p.authorization_id || null,
        expected_amount_minor: amountMinor,
        expected_currency: "ILS",
        event_id: eventId
      });
      if (resolution !== "reuse") return "done" as const;
    }
    const correlation = attempt.correlation_id;

    const captureInput: Parameters<typeof paymentProvider.capture>[0] = {
      amount_minor: amountMinor,
      currency: "ILS",
      participant_id: p.participant_id,
      deal_id: dealId,
      buyer_id: p.buyer_id,
      correlation_id: correlation,
      request_id: `worker:${eventId}`
    };
    if (p.authorization_id) captureInput.authorization_id = p.authorization_id;
    await hitTestFault("payment.before_provider_io");
    // R9C — arm: lease fence + state check + lifecycle CAS in ONE transaction,
    // the LAST step before external money I/O. From here until this worker
    // settles the row, every reconciler sees the operation as IN_FLIGHT.
    const armed = await armMoneyOperation({
      event,
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      expected_money_states: ["ChargeAttempt"],
      expected_buyer_states: ["ChargingAttempt"],
      provider_reference: p.authorization_id || null
    });
    if (!armed) return "done" as const;
    const owner = { event_uuid: event.event_uuid, lease_generation: event.lease_generation };
    const result = await paymentProvider.capture(captureInput);
    await hitTestFault("payment.after_provider_io");
    const outcome = classifyMoneyOutcome(result);
    const settle = (settled: MoneyRailOutcome, note?: string, inside?: (c: PoolClient) => Promise<void>) => settleOwnedMoneyOperation({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      owner,
      outcome: settled,
      provider_reference: result.provider_reference || p.authorization_id || null,
      ...(note ? { note } : {}),
      ...(inside ? { inside } : {})
    });

    if (outcome === "pre_dispatch_failure") {
      // Proven pre-dispatch (configuration/validation): nothing reached the
      // provider. Disarm; the outbox retries the SAME identity — no new
      // identity, no rolling-cap consumption.
      await settle("pre_dispatch_failure", `pre_dispatch_failure:${result.provider}`);
      throw new Error(`temporary_fail capture participant ${p.participant_id} (pre-dispatch, identity ${correlation} retained)`);
    }

    // LONG_HORIZON_DEALS — the provider declared the INSTRUMENT unusable
    // (expired / voided hold): the obligation was not charged and never can be
    // on this authorization. That is not a charge failure of the buyer: the
    // identity settles as the provider's exact decline, the binding records the
    // instrument as no longer valid (so a crash-retry renews first), and the
    // rail renews + captures again ONCE with a fresh identity. Only when no
    // renewal path exists does the decline follow the recovery rules.
    if (outcome === "permanent_fail" && isAuthorizationUnusableResult(result) && ctx.allow_renewal_retry) {
      const eligibility = await renewalEligibilityForParticipant(p.participant_id, dealId);
      if (eligibility.eligible) {
        await settle("permanent_fail", `authorization_unusable:${result.failure_code || "provider_declared"}`, async (c) => {
          await paymentBindings.markAuthorizationUnusableInTx(c, p.participant_id, String(result.failure_code || "provider_declared"));
        });
        app.log.info({ participant_id: p.participant_id, deal_id: dealId, correlation, failure_code: result.failure_code || null }, "capture declined: authorization instrument unusable; renewing before a fresh capture");
        return "renew_and_retry" as const;
      }
    }

    if (result.reconciliation_event_type && (outcome === "success" || outcome === "permanent_fail")) {
      await settle(outcome);
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
      if (outcome === "success" && result.provider_reference) {
        await paymentBindings
          .updateProviderReferenceForParticipant(p.participant_id, result.provider_reference)
          .catch(() => undefined);
      }
      return "done" as const;
    }

    // No provider-declared canonical outcome: transport loss, timeout, 5xx,
    // 429, 408, malformed body, or a success without an event type. The
    // provider may have moved money: NEVER retry blindly and NEVER mint a new
    // identity — record UNKNOWN durably on the SAME identity and hand it to
    // the Worker-owned reconciliation rail (authoritative status lookup).
    await settle("unknown", result.result_class === "success" ? "success_without_reconciliation_event" : `provider_outcome_unknown:${result.result_class}`);
    await schedulePaymentReconcile({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "charge_start",
      correlation_id: correlation,
      operation: "capture",
      provider_reference: result.provider_reference || p.authorization_id || null,
      reason: result.result_class === "success" ? "success_without_reconciliation_event" : "provider_outcome_unknown"
    });
    return "done" as const;
  };

  for (const p of participants) {
    if (p.buyer_state !== "ChargingAttempt" || p.money_state !== "ChargeAttempt") continue;

    const amountMinor = paymentMinorAmount({
      qty: Number(p.qty || 0),
      pricePerUnit: Number(p.price_per_unit || 0),
      deliveryCost: Number(p.delivery_cost || 0)
    });
    // LONG_HORIZON_DEALS — at most ONE reactive renewal per participant per
    // job run: a capture the provider declines because the instrument is no
    // longer usable is followed by a renewal and one fresh capture identity.
    let renewalBudget = 1;
    while (true) {
      const gate = await ensureUsableAuthorizationForCapture({
        event, event_id: eventId, participant_id: p.participant_id, deal_id: dealId, buyer_id: p.buyer_id,
        amount_minor: amountMinor, rail: "charge_start", fallback_authorization_id: p.authorization_id || null
      });
      if (gate.kind === "defer") { holdUntil(gate.until); break; }
      if (gate.kind === "skip") break;
      const outcome = await captureParticipantOnce({ ...p, authorization_id: gate.authorization_id || "" }, amountMinor, { allow_renewal_retry: renewalBudget > 0 });
      if (outcome === "renew_and_retry" && renewalBudget > 0) { renewalBudget -= 1; continue; }
      break;
    }
  }

  if (chargeHold.until) {
    // Residual C — at least one capture waits for the truth of a release of its
    // hold; the deal does not open its completion window on a charge that has
    // not been decided. Bounded outbox retry; the release reconcile is live.
    throw new DeferredEventError(`charge_held_behind_unresolved_release deal ${dealId}`, chargeHold.until);
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

// ---------------------------------------------------------------------------
// F-1 (financial torture lab) — recovery pre-flight.
//
// Recovery is a SECOND capture of the same obligation. The identity discipline
// already refuses it while the original capture is UNKNOWN or SUCCESS, but a
// capture that was declared failed ONCE (a final negative status, a declared
// decline) can still turn out executed: provider status APIs flap, settle late,
// or answer from a stale replica. Immediately before arming a recovery the
// original authorization is therefore re-read through the status seam:
//   captured            -> the money already moved: record it as a late money
//                          effect (operational case, identity converges to
//                          success), NO recovery
//   pending             -> a settlement is in progress: defer the recovery job
//                          (bounded outbox retry), extend the durable settlement
//                          horizon (064), NO recovery now
//   two reads disagree  -> flapping provider: hold + case
//   unknown / transport -> unverifiable: proceed ONLY when the provider itself
//   failure                declared this exact request failed (dispatch_response
//                          evidence); otherwise hold + case (review remediation)
//   authorized / failed -> (twice, consistently) not executed: proceed
// A provider without a status capability cannot be verified and keeps the
// pre-existing behaviour (documented residual). The SETTLEMENT HORIZON fence
// (captureSettlementFenceUntil, migration 064) runs BEFORE this pre-flight: a
// status-inferred failure is never acted on while the provider may still settle.
// ---------------------------------------------------------------------------
async function verifyOriginalCaptureBeforeRecovery(args: {
  participant_id: string;
  deal_id: string;
  authorization_id: string | null;
  event_id: string;
  /** authoritative amount of the obligation; a "captured" answer for another amount is not this operation */
  expected_amount_minor?: number | null;
  /** authoritative currency of the obligation; a "captured" answer in another currency is not this operation */
  expected_currency?: string | null;
  /** who is asking (recovery rail / terminal finalize decision) — recorded on the ingested event */
  context?: "recovery" | "finalize";
}): Promise<"proceed" | "captured" | "ambiguous"> {
  const rows = await listAttemptLifecycle(args.participant_id, args.deal_id);
  // LONG_HORIZON_DEALS — the authorization a capture was dispatched against is
  // the one recorded on its identity; after a renewal the binding's CURRENT
  // reference is a different instrument and says nothing about that capture.
  const dispatchedReference = [...rows].reverse().find((row) => (row.attempt_type === "charge_start" || row.attempt_type === "recovery") && row.provider_reference)?.provider_reference || null;
  const reference = String(dispatchedReference || args.authorization_id || "").trim();
  if (!paymentProvider.status || !reference) return "proceed";
  // A recovery identity that is UNKNOWN or executed is owned by the identity
  // discipline and resolvePriorProviderAttempt: a "captured" status may then be
  // THAT recovery, not a late original capture. The pre-flight steps aside.
  if (rows.some((row) => row.attempt_type === "recovery" && (row.result_class === "unknown" || row.result_class === "success"))) return "proceed";
  // The operation a late "captured" would belong to: the NEWEST capture-side
  // identity (a status-inferred failed recovery n1 that settles late is a
  // recovery effect, never the original capture — F-5 family discipline).
  const target = [...rows].reverse().find((row) => row.attempt_type === "charge_start" || row.attempt_type === "recovery") || null;
  // Exact-request evidence: the provider answered the capture request itself
  // with a decline. Only that lets money move on an UNVERIFIABLE status.
  // (Residual A: an operator who verified the operation at the provider and
  // recorded failure_evidence='operator' is exact evidence as well.)
  const exactDecline = Boolean(target && target.result_class === "permanent_fail" && (target.failure_evidence === "dispatch_response" || target.failure_evidence === "operator"));
  const source = args.context === "finalize" ? "finalize_preflight" : "recovery_preflight";
  const policy = providerAmbiguityPolicy(paymentProvider);
  // F-9: ONE status read is defeated by a flapping provider (failed <-> captured
  // on consecutive reads): the reconcile rail may have seen "failed" and this
  // pre-flight "failed" again while the capture had in fact executed. Read twice,
  // a confirmation interval apart, and take the most conservative verdict: any
  // "captured" -> captured, any "pending" or two reads that disagree -> hold.
  // Only two consistent, VERIFIED negative answers let money move.
  const confirmMs = Math.max(0, Number(process.env.RECOVERY_PREFLIGHT_CONFIRM_MS || 1000) || 0);
  const reads: PaymentStatusResult[] = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0 && confirmMs > 0) await new Promise((resolve) => setTimeout(resolve, confirmMs));
    try {
      reads.push(await paymentProvider.status({ provider_reference: reference, operation: "capture", correlation_id: `${source}:${args.event_id}:${args.participant_id}:${i + 1}` }));
    } catch {
      return "ambiguous";
    }
  }
  const capturedRead = reads.find((r) => r.state === "captured");
  const status: PaymentStatusResult = capturedRead ?? reads[0]!;
  // Exact-operation identity for EVERY read (residual A): an answer that names
  // another reference or another currency is evidence about some other
  // operation — it can neither prove a capture nor authorise a recovery.
  const expectedCurrencyAll = String(args.expected_currency || "").trim().toUpperCase();
  const foreignRead = reads.find((r) => r.reference_matches_query === false || (expectedCurrencyAll && r.currency && String(r.currency).toUpperCase() !== expectedCurrencyAll));
  if (foreignRead) {
    await openPaymentOperationalCase({
      autoKey: `payment-recovery-preflight-mismatch:${args.participant_id}`,
      subject: `FINANCIAL_OUTCOME_UNRESOLVED: provider status cannot be tied to the obligation of participant ${args.participant_id}`,
      description: `Provider ${paymentProvider.providerCode} answered a status query for authorization ${reference} with reference ${foreignRead.provider_reference || "n/a"} / currency ${foreignRead.currency || "n/a"} (state ${foreignRead.state}); the obligation is ${reference} / ${expectedCurrencyAll || "n/a"}. The answer is not evidence about this exact operation: no recovery was sent, no verdict was drawn, manual provider-side verification required.`,
      correlationId: target?.correlation_id ?? null
    });
    return "ambiguous";
  }
  if (capturedRead) {
    // Exact-operation identity: a "captured" that names another amount or
    // another currency is evidence about SOME operation, not this one. Hold
    // with a visible case; never a verdict in either direction.
    const amountMismatch = args.expected_amount_minor !== null && args.expected_amount_minor !== undefined
      && capturedRead.amount_minor !== null && Number.isInteger(capturedRead.amount_minor)
      && Number(capturedRead.amount_minor) !== Number(args.expected_amount_minor);
    const expectedCurrency = String(args.expected_currency || "").trim().toUpperCase();
    const currencyMismatch = Boolean(expectedCurrency && capturedRead.currency && String(capturedRead.currency).toUpperCase() !== expectedCurrency);
    if (amountMismatch || currencyMismatch) {
      await openPaymentOperationalCase({
        autoKey: `payment-recovery-preflight-mismatch:${args.participant_id}`,
        subject: `FINANCIAL_OUTCOME_UNRESOLVED: provider "captured" does not match the obligation of participant ${args.participant_id}`,
        description: `Provider ${paymentProvider.providerCode} reports authorization ${reference} as CAPTURED with ${capturedRead.amount_minor ?? "n/a"} ${capturedRead.currency || "n/a"}; the obligation is ${args.expected_amount_minor ?? "n/a"} ${expectedCurrency || "n/a"}. The answer cannot be tied to this exact operation: no recovery was sent, no verdict was drawn, manual provider-side verification required.`,
        correlationId: target?.correlation_id ?? null
      });
      return "ambiguous";
    }
    const lateEventType = target?.attempt_type === "recovery" ? "recovery_captured" : "charge_captured";
    await ingestAndProcessPaymentEvent({
      provider: paymentProvider.providerCode,
      event_id: `${source}:${args.participant_id}:${lateEventType}${target ? `:${target.correlation_id}` : ""}`,
      event_type: lateEventType,
      correlation_id: target?.correlation_id ?? null,
      participant_id: args.participant_id,
      deal_id: args.deal_id,
      provider_reference: status.provider_reference || reference,
      payload: { source, worker_event_id: args.event_id, provider_state: status.state, provider_final: status.final }
    }).catch(() => undefined);
    await openPaymentOperationalCase({
      autoKey: `payment-recovery-preflight-captured:${args.participant_id}`,
      subject: `FINANCIAL_OUTCOME_UNRESOLVED: original capture already executed for participant ${args.participant_id}`,
      description: `Immediately before a ${args.context === "finalize" ? "terminal deal decision" : "recovery capture"}, provider ${paymentProvider.providerCode} reported the authorization ${reference} as CAPTURED although the ${target?.attempt_type === "recovery" ? "recovery" : "capture"} had been recorded as failed. No recovery was sent. The participant's canonical state is not financial truth until an operator reconciles the money side.`,
      correlationId: target?.correlation_id ?? null
    });
    return "captured";
  }
  // "pending" is positive evidence that a settlement is still in progress:
  // hold, and push the durable settlement horizon of the target identity out
  // (migration 064) so nothing else acts on this obligation meanwhile.
  if (reads.some((r) => r.state === "pending")) {
    if (target && policy.settlement_horizon_ms > 0) {
      await extendSettlementHorizon({ participant_id: args.participant_id, deal_id: args.deal_id, attempt_type: target.attempt_type, correlation_id: target.correlation_id, horizon_ms: policy.settlement_horizon_ms }).catch(() => undefined);
    }
    return "ambiguous";
  }
  if (new Set(reads.map((r) => `${r.state}:${r.final ? "final" : "open"}`)).size > 1) {
    await openPaymentOperationalCase({
      autoKey: `payment-recovery-preflight-flapping:${args.participant_id}`,
      subject: `FINANCIAL_OUTCOME_UNRESOLVED: provider status is flapping for participant ${args.participant_id}`,
      description: `Two consecutive status reads for authorization ${reference} disagreed (${reads.map((r) => `${r.state}/${r.final ? "final" : "open"}`).join(" then ")}). No recovery capture is sent while the provider contradicts itself; the recovery job is held and an operator must establish the money truth.`,
      correlationId: target?.correlation_id ?? null
    });
    return "ambiguous";
  }
  // "unknown" (a provider that cannot look the reference up, a transport or
  // parsing failure mapped by the adapter) proves nothing. Money may move on an
  // unverifiable status ONLY when the provider itself declared this exact
  // request failed (dispatch_response evidence). A status-inferred or legacy
  // failure with no verifiable status stays held — UNKNOWN / HOLD / CASE.
  if (reads.every((r) => r.state === "unknown")) {
    if (exactDecline) return "proceed";
    await openPaymentOperationalCase({
      autoKey: `payment-recovery-preflight-unverifiable:${args.participant_id}`,
      subject: `FINANCIAL_OUTCOME_UNRESOLVED: original capture cannot be verified for participant ${args.participant_id}`,
      description: `Provider ${paymentProvider.providerCode} could not report the state of authorization ${reference} (${reads.map((r) => r.error_code || "unknown").join(", ")}) and the recorded failure of ${target ? `${target.attempt_type} ${target.correlation_id}` : "the capture"} is not the provider's answer to that exact request (${target?.failure_evidence || "no evidence recorded"}). No recovery capture is sent on an unverifiable status; the job is held and an operator must establish the money truth.`,
      correlationId: target?.correlation_id ?? null
    });
    return "ambiguous";
  }
  // Residual A — two consistent NEGATIVE reads let money move only when the
  // provider contract classifies a negative status as authoritative for the
  // exact operation, or when the provider itself declared the request failed.
  // Waiting (a horizon that elapsed) is not proof.
  if (!exactDecline && !policy.negative_status_authoritative) {
    await openPaymentOperationalCase({
      autoKey: `payment-recovery-negative-finality-unproven:${args.participant_id}`,
      subject: `FINANCIAL_OUTCOME_UNRESOLVED: recovery held — negative finality unproven for participant ${args.participant_id}`,
      description: `Provider ${paymentProvider.providerCode} reports authorization ${reference} as ${reads.map((r) => `${r.state}/${r.final ? "final" : "open"}`).join(" then ")}, but its contract does not prove that the exact ${target?.attempt_type || "capture"} ${target?.correlation_id || ""} did not execute (${policy.basis}). No recovery capture is sent; verify at the provider and record failure_evidence='operator' on the identity.`,
      correlationId: target?.correlation_id ?? null
    });
    return "ambiguous";
  }
  return "proceed";
}

async function handleRecoveryDealEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
    lease_generation?: number | null;
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

  // The job is deferred to the EARLIEST instant at which any held participant
  // may be re-examined (a settlement horizon, or a short retry for an
  // ambiguous pre-flight); the others proceed now.
  const deferral: { until: Date | null } = { until: null };
  const deferTo = (at: Date) => { if (!deferral.until || at.getTime() < deferral.until.getTime()) deferral.until = at; };

  // ONE recovery attempt for a participant on the authorization the gate handed
  // over. Byte-for-byte the R9C recovery rail from the identity mint onwards;
  // the only addition is the instrument-unusable branch.
  const recoverParticipantOnce = async (
    p: (typeof participants)[number],
    amountMinor: number,
    ctx: { allow_renewal_retry: boolean }
  ): Promise<"done" | "renew_and_retry"> => {
    // R9C — durable identity + reconcile-before-new-operation (see charge rail).
    const attempt = await beginProviderAttempt({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      identity: (logicalAttempt) => `recovery:${eventId}:n${logicalAttempt}:${p.participant_id}`,
      // R9C ROUND 5 — state re-read under the lock before minting (F-8 closed
      // generally: no NOT_DISPATCHED recovery identity can be left behind)
      admitted: { money_states: ["ChargeFailedRecovery"], buyer_states: ["ChargeFailedCompletion"] }
    });
    if (attempt.kind === "state_changed") return "done" as const; // the participant left the recoverable state before an identity existed
    if (attempt.kind === "blocked") {
      if (attempt.reason === "capture_blocked_by_released_authorization") {
        // Residual C — the hold was released while the participant waited for
        // recovery: no recovery capture of a released hold; money truth is the
        // provider-proofed release, the business outcome follows at finalize.
        await applyAuthorizationRelease(p.participant_id, dealId, `worker:${eventId}`, attempt.blocking.correlation_id);
        await openPaymentOperationalCase({
          autoKey: `payment-capture-refused-released-hold:${p.participant_id}`,
          subject: `Recovery refused: the authorization of participant ${p.participant_id} was released while recovery was pending`,
          description: `Release ${attempt.blocking.correlation_id} executed at provider ${paymentProvider.providerCode} before a recovery capture of participant ${p.participant_id} could be dispatched (worker event ${eventId}). No recovery was sent; the participant's money state is AuthReleased.`,
          correlationId: attempt.blocking.correlation_id
        });
        return "done" as const;
      }
      // R9C C1 — recovery is a SECOND capture of the same obligation: never
      // while the original capture is unresolved or already executed.
      await handleBlockedMoneyOperation({ participant_id: p.participant_id, deal_id: dealId, attempt_type: "recovery", reason: attempt.reason, blocking: attempt.blocking, provider_reference: p.authorization_id || null, event_id: eventId });
      // Residual C — an UNRESOLVED release: retry once its truth exists (bounded).
      if (attempt.reason === "capture_blocked_by_unresolved_release") deferTo(new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS));
      return "done" as const;
    }
    if (attempt.kind === "in_flight") return "done" as const; // another live worker owns this exact operation
    if (attempt.kind === "fenced") {
      // DB-side view of the settlement fence (belt to the check above).
      if (attempt.until) deferTo(attempt.until);
      return "done" as const;
    }
    if (attempt.kind === "unresolved") {
      const resolution = await resolvePriorProviderAttempt({
        operation: "capture",
        attempt_type: "recovery",
        participant_id: p.participant_id,
        deal_id: dealId,
        correlation_id: attempt.correlation_id,
        dispatch_state: attempt.dispatch_state,
        provider_reference: p.authorization_id || null,
        expected_amount_minor: amountMinor,
        expected_currency: "ILS",
        event_id: eventId
      });
      if (resolution !== "reuse") return "done" as const;
    }
    const correlation = attempt.correlation_id;

    const recoverInput: Parameters<typeof paymentProvider.recover>[0] = {
      amount_minor: amountMinor,
      currency: "ILS",
      participant_id: p.participant_id,
      deal_id: dealId,
      buyer_id: p.buyer_id,
      correlation_id: correlation,
      request_id: `worker:${eventId}`,
      within_window: withinWindow
    };
    if (p.authorization_id) recoverInput.authorization_id = p.authorization_id;
    await hitTestFault("payment.before_provider_io");
    // R9C — arm: lease fence + state check + lifecycle CAS in ONE transaction,
    // the LAST step before external money I/O.
    const armed = await armMoneyOperation({
      event,
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      expected_money_states: ["ChargeFailedRecovery"],
      expected_buyer_states: ["ChargeFailedCompletion"],
      provider_reference: p.authorization_id || null
    });
    if (!armed) return "done" as const;
    const owner = { event_uuid: event.event_uuid, lease_generation: event.lease_generation };
    const result = await paymentProvider.recover(recoverInput, withinWindow);
    await hitTestFault("payment.after_provider_io");
    const outcome = classifyMoneyOutcome(result);
    const settle = (settled: MoneyRailOutcome, note?: string, inside?: (c: PoolClient) => Promise<void>) => settleOwnedMoneyOperation({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      owner,
      outcome: settled,
      provider_reference: result.provider_reference || p.authorization_id || null,
      ...(note ? { note } : {}),
      ...(inside ? { inside } : {})
    });

    if (outcome === "pre_dispatch_failure") {
      await settle("pre_dispatch_failure", `pre_dispatch_failure:${result.provider}`);
      throw new Error(`temporary_fail recovery participant ${p.participant_id} (pre-dispatch, identity ${correlation} retained)`);
    }

    // LONG_HORIZON_DEALS — instrument unusable (see the charge rail): renew and
    // recover again once on a fresh identity instead of dropping the buyer.
    if (outcome === "permanent_fail" && isAuthorizationUnusableResult(result) && ctx.allow_renewal_retry) {
      const eligibility = await renewalEligibilityForParticipant(p.participant_id, dealId);
      if (eligibility.eligible) {
        await settle("permanent_fail", `authorization_unusable:${result.failure_code || "provider_declared"}`, async (c) => {
          await paymentBindings.markAuthorizationUnusableInTx(c, p.participant_id, String(result.failure_code || "provider_declared"));
        });
        app.log.info({ participant_id: p.participant_id, deal_id: dealId, correlation, failure_code: result.failure_code || null }, "recovery declined: authorization instrument unusable; renewing before a fresh recovery");
        return "renew_and_retry" as const;
      }
    }

    // Route through the webhook reconciliation truth path when the provider emits an event type
    if (result.reconciliation_event_type && (outcome === "success" || outcome === "permanent_fail")) {
      await settle(outcome);
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
      if (outcome === "success" && result.provider_reference) {
        await paymentBindings
          .updateProviderReferenceForParticipant(p.participant_id, result.provider_reference)
          .catch(() => undefined);
      }
      return "done" as const;
    }

    // No provider-declared canonical outcome — durable UNKNOWN on the SAME
    // identity, then the reconciliation rail. Never a blind retry, never a
    // fresh identity after possible money movement.
    await settle("unknown", result.result_class === "success" ? "success_without_reconciliation_event" : `provider_outcome_unknown:${result.result_class}`);
    await schedulePaymentReconcile({
      participant_id: p.participant_id,
      deal_id: dealId,
      attempt_type: "recovery",
      correlation_id: correlation,
      operation: "capture",
      provider_reference: result.provider_reference || p.authorization_id || null,
      reason: result.result_class === "success" ? "success_without_reconciliation_event" : "provider_outcome_unknown"
    });
    return "done" as const;
  };

  for (const p of participants) {
    const amountMinor = paymentMinorAmount({
      qty: Number(p.qty || 0),
      pricePerUnit: Number(p.price_per_unit || 0),
      deliveryCost: Number(p.delivery_cost || 0)
    });
    // Independent financial review — SETTLEMENT HORIZON (migration 064): a
    // capture-side failure that was only INFERRED from status reads may still
    // settle at the provider until its horizon. No automatic recovery (a second
    // capture of the same obligation) before that instant, whatever the status
    // seam says now — the review reproduced a double capture on a provider that
    // answered a consistent "failed/final" while the capture was still settling.
    const fence = await captureSettlementFenceUntil(p.participant_id, dealId);
    if (fence && fence.permanent) {
      // Residual A / B — the failure was inferred and the provider's negative
      // finality is not authoritative (Grow, a deployment that declares it
      // unproven, a legacy row without horizon/authority): horizon expiry by
      // itself is NOT proof. No recovery, no identity rotation — an operator
      // resolves it (failure_evidence = 'operator' after provider-side checks).
      await openPaymentOperationalCase({
        autoKey: `payment-recovery-negative-finality-unproven:${p.participant_id}`,
        subject: `FINANCIAL_OUTCOME_UNRESOLVED: recovery held — negative finality unproven for participant ${p.participant_id}`,
        description: `A capture-side operation of participant ${p.participant_id} was recorded as failed from status evidence, and provider ${paymentProvider.providerCode} does not prove non-execution of the exact operation from a negative status (or the row predates the settlement-horizon policy). Waiting does not create proof: no recovery capture is sent and no new money identity is minted (worker event ${eventId}). Verify the original capture at the provider and record failure_evidence='operator' on the identity to release the hold.`,
        correlationId: null
      });
      continue;
    }
    if (fence && fence.until) {
      await openPaymentOperationalCase({
        autoKey: `payment-recovery-settlement-horizon:${p.participant_id}`,
        subject: `Recovery held until the provider settlement horizon for participant ${p.participant_id}`,
        description: `A capture-side operation of participant ${p.participant_id} was recorded as failed from provider status reads, not from the provider's answer to the request itself; provider ${paymentProvider.providerCode} may still settle it until ${fence.until.toISOString()}. No recovery capture is sent before that instant (worker event ${eventId}); the job is deferred to the horizon and the original capture is re-verified there.`,
        correlationId: null
      });
      deferTo(fence.until);
      continue;
    }
    // F-1 — last look at the original capture BEFORE a recovery identity is
    // minted (F-8: minting first left a NOT_DISPATCHED recovery identity behind
    // whenever the pre-flight deferred and the participant later left the
    // recoverable state).
    const preflight = await verifyOriginalCaptureBeforeRecovery({ participant_id: p.participant_id, deal_id: dealId, authorization_id: p.authorization_id || null, event_id: eventId, expected_amount_minor: amountMinor, expected_currency: "ILS", context: "recovery" });
    if (preflight === "captured") continue;
    if (preflight === "ambiguous") { deferTo(new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS)); continue; }

    // LONG_HORIZON_DEALS — renew an expired authorization from the stored
    // instrument before the recovery capture; one reactive renewal per run.
    let renewalBudget = 1;
    while (true) {
      const gate = await ensureUsableAuthorizationForCapture({
        event, event_id: eventId, participant_id: p.participant_id, deal_id: dealId, buyer_id: p.buyer_id,
        amount_minor: amountMinor, rail: "recovery", fallback_authorization_id: p.authorization_id || null
      });
      if (gate.kind === "defer") { deferTo(gate.until); break; }
      if (gate.kind === "skip") break;
      const outcome = await recoverParticipantOnce({ ...p, authorization_id: gate.authorization_id || "" }, amountMinor, { allow_renewal_retry: renewalBudget > 0 });
      if (outcome === "renew_and_retry" && renewalBudget > 0) { renewalBudget -= 1; continue; }
      break;
    }
  }

  if (deferral.until) {
    // At least one participant is held (settlement horizon not reached, or the
    // original capture could not be verified): keep the recovery job alive and
    // wake it at the earliest instant something can change, instead of guessing.
    throw new DeferredEventError(`recovery_held deal ${dealId} until ${deferral.until.toISOString()}`, deferral.until);
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

/**
 * R-11 (independent financial review) — every participant whose money is
 * canonically captured on a Completed deal must be DealCompleted (receipt +
 * fulfillment) even when finalize is retried on a deal that is already
 * Completed.
 *
 * R9C ROUND 4 (F-14 / F-15) — everything a Completed deal owes its
 * participants, in ONE idempotent routine used by the fresh finalize and by
 * every retry of it: paid participants → DealCompleted, unpaid ones →
 * DealFailed (guarded against an armed capture, F-15), held authorizations
 * released, notifications, receipts, fulfillment and payout enqueued. Each
 * step is idempotent (idempotency keys, ON CONFLICT, one-pending indexes), so
 * a finalize that aborted mid-loop — its participant CAS raced a capture that
 * landed between the read and the write — converges on retry without leaving
 * the siblings after the conflict non-terminal on a Completed deal with their
 * holds never released (the R-11 retry path used to complete PAID participants
 * only).
 */
async function applyCompletedDealOutcome(dealId: string, eventId: string) {
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
        outbox: null,
        // R9C ROUND 4 (F-15) — a participant is failed ONLY if no capture-side
        // identity of theirs is minted, armed or executed. The capture rail
        // mints and arms an identity under the participant/deal advisory lock
        // and its arm requires buyer_state ChargingAttempt; taking the SAME
        // lock here, before the check and the CAS, serializes the two: either
        // the rail committed first (its row is visible here → abort, the job
        // retries, the F-2 gate then defers on the identity) or this
        // DealFailed commits first (the arm reads it and refuses). A plain
        // read without the lock is NOT enough — an arm landing between the
        // read and the CAS still slipped through, which left a charged buyer
        // marked failed with no refund path.
        insideTx: async (c) => {
          await lockParticipantDealInTx(c, p.participant_id, dealId);
          // R9C ROUND 5 — the round-4 contract is kept: a MINTED identity still
          // defers (its rail, alive between mint and arm, may dispatch it and the
          // buyer is then completed on truth — RC-5b). What no longer defers is
          // an identity already RETIRED as ABANDONED_BEFORE_DISPATCH
          // (temporary_fail + recorded + no dispatch instant): it was retired by
          // the reconcile rail because no live job owned it once the charging
          // phase was over, or by a superseding rail, and it can never be armed
          // (the arm CAS requires result_class = 'unknown').
          const armed = await c.query(
            `SELECT correlation_id, result_class, dispatch_state FROM siton.payment_attempts
             WHERE participant_id=$1 AND deal_id=$2 AND attempt_type IN ('charge_start','recovery')
               AND result_class <> 'permanent_fail'
               AND NOT (result_class = 'temporary_fail' AND dispatch_state = 'recorded' AND dispatched_at IS NULL)
             LIMIT 1`,
            [p.participant_id, dealId]
          );
          if (armed.rowCount) {
            // deferred, not failed: a deferral burns no outbox attempt (the
            // identity resolves through its own rail / the reconcile sweeper,
            // then this retry completes or fails the participant on truth)
            throw new DeferredEventError(
              `finalize_participant_capture_in_flight participant ${p.participant_id} identity ${armed.rows[0].correlation_id} is ${armed.rows[0].result_class}`,
              new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS)
            );
          }
        }
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
}

async function handleFinalizeDealEvent(
  event: {
    event_uuid: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: any;
    attempt_count: number;
    lease_generation?: number | null;
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

  if (dealRow.state === "Completed") {
    // R-11 (independent financial review): a finalize job retried after the deal
    // was completed (its participant transition raced a capture that became
    // canonical between the participant read and the CAS) must still leave every
    // paid participant DealCompleted — with receipt and fulfillment.
    // R9C ROUND 4 (F-14): and every UNPAID sibling DealFailed with its hold
    // released — the whole completed-deal outcome, idempotently, not only the
    // paid half (a retry after a mid-loop abort used to strand the rest).
    await applyCompletedDealOutcome(dealId, eventId);
    return;
  }
  if (dealRow.state !== "CompletionWindow") return;
  if (!dealRow.completion_window_until) return;
  if (!dealRow.can_finalize) {
    throw new DeferredEventError("finalize_not_ready_yet", new Date(dealRow.completion_window_until));
  }

  // F-2 (financial torture lab) — a completion decision is only as true as the
  // money it counts. A participant whose capture-side identity is UNKNOWN
  // (recorded / dispatching / responded without a provider-declared outcome) may
  // have been captured: counting it as "not captured" and failing the deal would
  // leave a charged buyer on a Failed deal that the refund job never sees (it
  // refunds ChargedSuccess / RecoveredCharge only). While any such identity
  // exists the finalize defers (bounded outbox retry), makes sure a reconcile
  // is live for it, and keeps the hold visible as an operational case.
  const unresolvedCaptures = await withTx(async (c) => {
    const r = await c.query(
      `SELECT pa.participant_id, pa.attempt_type, pa.correlation_id,
              COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id', '') AS provider_reference,
              EXISTS (
                SELECT 1 FROM siton.outbox_events o
                WHERE o.event_type='payment_reconcile' AND o.aggregate_type='participant' AND o.aggregate_id=pa.participant_id
                  AND o.status IN ('pending','processing')
              ) AS reconcile_live
       FROM siton.payment_attempts pa
       JOIN siton.participants p ON p.participant_id = pa.participant_id
       LEFT JOIN siton.payment_authorization_bindings pab ON pab.consumed_by_participant_id = p.participant_id
       LEFT JOIN LATERAL (
         SELECT payload FROM siton.audit_log
         WHERE entity_type='participant' AND entity_id=p.participant_id AND action_name='participant.join_authorize'
         ORDER BY created_at DESC LIMIT 1
       ) auth ON true
       WHERE pa.deal_id=$1 AND pa.attempt_type IN ('charge_start','recovery')
         AND (
           pa.result_class='unknown'
           -- R-11 (independent financial review): an identity the provider EXECUTED
           -- whose canonical state was not yet applied (crash / race between the
           -- owner's settle and the ingest transition) is unresolved for the
           -- terminal decision too: money moved, the participant still looks unpaid.
           OR (pa.result_class='success' AND p.money_state NOT IN ('ChargedSuccess','RecoveredCharge','Refunded'))
         )
       ORDER BY pa.created_at ASC`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string; attempt_type: "charge_start" | "recovery"; correlation_id: string; provider_reference: string; reconcile_live: boolean }>;
  });
  if (unresolvedCaptures.length > 0) {
    for (const row of unresolvedCaptures) {
      if (row.reconcile_live) continue;
      await schedulePaymentReconcile({
        participant_id: row.participant_id,
        deal_id: dealId,
        attempt_type: row.attempt_type,
        correlation_id: row.correlation_id,
        operation: "capture",
        provider_reference: row.provider_reference || null,
        reason: "finalize_waiting_for_unresolved_capture"
      }).catch(() => undefined);
    }
    await openPaymentOperationalCase({
      autoKey: `deal-finalize-waiting-unresolved:${dealId}`,
      subject: `Deal finalization waiting for ${unresolvedCaptures.length} unresolved capture(s) (deal ${dealId})`,
      description: `finalize_deal for deal ${dealId} was deferred because ${unresolvedCaptures.length} capture-side identit${unresolvedCaptures.length === 1 ? "y is" : "ies are"} still UNKNOWN (${unresolvedCaptures.map((row) => `${row.attempt_type} ${row.correlation_id}`).join(", ")}). The deal is neither Completed nor Failed until each identity is resolved through reconciliation; a reconcile job is live for every one of them. If this case stays open the provider must be verified manually.`,
      correlationId: unresolvedCaptures[0]?.correlation_id ?? null
    });
    throw new DeferredEventError(
      `finalize_waiting_for_unresolved_captures deal ${dealId} (${unresolvedCaptures.length})`,
      new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS)
    );
  }

  // Independent financial review — SETTLEMENT HORIZON (migration 064). A
  // capture-side failure that was only INFERRED from status reads may still
  // settle at the provider until its horizon: deciding Completed / Failed (and
  // releasing every hold) before that instant is the "terminal state hides late
  // provider money" path. Defer the decision to the LAST open horizon, visibly.
  const fencedCaptures = await withTx(async (c) => {
    const r = await c.query(
      `SELECT pa.participant_id, pa.attempt_type, pa.correlation_id, pa.settlement_horizon_at,
              (pa.settlement_horizon_at IS NULL OR NOT COALESCE(pa.negative_finality_authoritative, false)) AS permanent
       FROM siton.payment_attempts pa
       WHERE pa.deal_id=$1 AND pa.attempt_type IN ('charge_start','recovery') AND pa.result_class='permanent_fail'
         AND pa.failure_evidence IS DISTINCT FROM 'dispatch_response'
         AND pa.failure_evidence IS DISTINCT FROM 'operator'
         AND (pa.settlement_horizon_at IS NULL OR pa.settlement_horizon_at > clock_timestamp() OR NOT COALESCE(pa.negative_finality_authoritative, false))
       ORDER BY pa.settlement_horizon_at ASC NULLS LAST`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string; attempt_type: string; correlation_id: string; settlement_horizon_at: Date | string | null; permanent: boolean }>;
  });
  const permanentlyFenced = fencedCaptures.filter((row) => row.permanent);
  if (permanentlyFenced.length > 0) {
    // Residual A / B — waiting cannot resolve these (negative finality unproven
    // for the provider, or a legacy row without horizon/authority): the deal is
    // neither Completed nor Failed automatically; an operator records exact
    // evidence (failure_evidence='operator') and the maintenance rescheduler
    // brings finalize back.
    await openPaymentOperationalCase({
      autoKey: `deal-finalize-negative-finality-unproven:${dealId}`,
      subject: `Deal finalization held: capture failure(s) with unproven negative finality (deal ${dealId})`,
      description: `finalize_deal for deal ${dealId} cannot decide: ${permanentlyFenced.length} capture-side identit${permanentlyFenced.length === 1 ? "y was" : "ies were"} recorded as failed from status evidence that provider ${paymentProvider.providerCode} cannot tie to the exact operation, or predate the settlement-horizon policy (${permanentlyFenced.map((row) => `${row.attempt_type} ${row.correlation_id}`).join(", ")}). No hold is released and no participant is failed on that evidence; verify at the provider and record failure_evidence='operator' on each identity.`,
      correlationId: permanentlyFenced[0]?.correlation_id ?? null
    });
    throw new PermanentFailError(`finalize_negative_finality_unproven deal ${dealId} (${permanentlyFenced.length})`);
  }
  if (fencedCaptures.length > 0) {
    // pg hands timestamptz back as a Date; String(date) would drop the milliseconds
    // and defer the job up to 999 ms BEFORE the horizon (the outbox refuses a
    // retry time that already passed -> spurious lease loss). Keep the exact instant.
    const rawUntil: unknown = fencedCaptures[fencedCaptures.length - 1]!.settlement_horizon_at;
    const until = rawUntil instanceof Date ? rawUntil : new Date(String(rawUntil));
    await openPaymentOperationalCase({
      autoKey: `deal-finalize-waiting-settlement-horizon:${dealId}`,
      subject: `Deal finalization waiting for the provider settlement horizon (deal ${dealId})`,
      description: `finalize_deal for deal ${dealId} was deferred until ${until.toISOString()} because ${fencedCaptures.length} capture-side operation(s) recorded as failed from status reads may still settle at provider ${paymentProvider.providerCode} (${fencedCaptures.map((row) => `${row.attempt_type} ${row.correlation_id}`).join(", ")}). The deal is neither Completed nor Failed and no hold is released before the horizon; each such capture is re-verified at the provider before the decision.`,
      correlationId: fencedCaptures[0]?.correlation_id ?? null
    });
    throw new DeferredEventError(`finalize_waiting_for_settlement_horizon deal ${dealId} until ${until.toISOString()}`, until);
  }

  // Past every horizon: ONE authoritative look at each dispatched, status-inferred
  // capture-side failure BEFORE the terminal decision, so a settlement that landed
  // late becomes visible truth (identity success + operational case, no release of
  // captured money) instead of being hidden behind Completed / Failed.
  const inferredFailures = await withTx(async (c) => {
    const r = await c.query(
      `SELECT DISTINCT ON (pa.participant_id)
              pa.participant_id, p.qty, p.delivery_cost, d.price_per_unit,
              COALESCE(NULLIF(pab.provider_reference, ''), auth.payload->>'authorization_id', '') AS provider_reference
       FROM siton.payment_attempts pa
       JOIN siton.participants p ON p.participant_id = pa.participant_id
       JOIN siton.deals d ON d.deal_id = p.deal_id
       LEFT JOIN siton.payment_authorization_bindings pab ON pab.consumed_by_participant_id = p.participant_id
       LEFT JOIN LATERAL (
         SELECT payload FROM siton.audit_log
         WHERE entity_type='participant' AND entity_id=p.participant_id AND action_name='participant.join_authorize'
         ORDER BY created_at DESC LIMIT 1
       ) auth ON true
       WHERE pa.deal_id=$1 AND pa.attempt_type IN ('charge_start','recovery') AND pa.result_class='permanent_fail'
         AND pa.failure_evidence IS DISTINCT FROM 'dispatch_response' AND pa.failure_evidence IS DISTINCT FROM 'operator'
         AND pa.settlement_horizon_at IS NOT NULL
         AND p.money_state IN ('ChargeAttempt','ChargeFailedRecovery')
       ORDER BY pa.participant_id, pa.created_at DESC`,
      [dealId]
    );
    return r.rows as Array<{ participant_id: string; qty: number; delivery_cost: number; price_per_unit: number; provider_reference: string }>;
  });
  const lateLook: { until: Date | null } = { until: null };
  for (const row of inferredFailures) {
    const look = await verifyOriginalCaptureBeforeRecovery({
      participant_id: row.participant_id,
      deal_id: dealId,
      authorization_id: row.provider_reference || null,
      event_id: eventId,
      expected_amount_minor: paymentMinorAmount({ qty: Number(row.qty || 0), pricePerUnit: Number(row.price_per_unit || 0), deliveryCost: Number(row.delivery_cost || 0) }),
      expected_currency: "ILS",
      context: "finalize"
    });
    if (look === "ambiguous") lateLook.until = new Date(Date.now() + PROVIDER_IO_LEASE_MARGIN_MS);
  }
  if (lateLook.until) {
    await openPaymentOperationalCase({
      autoKey: `deal-finalize-waiting-late-capture-truth:${dealId}`,
      subject: `Deal finalization waiting for provider truth on status-inferred capture failures (deal ${dealId})`,
      description: `finalize_deal for deal ${dealId} was deferred because provider ${paymentProvider.providerCode} could not confirm, after the settlement horizon, whether a capture recorded as failed from status reads executed (pending, flapping or unverifiable status). The deal is neither Completed nor Failed until that truth is established; if this case stays open the provider must be verified manually.`,
      correlationId: null
    });
    throw new DeferredEventError(`finalize_waiting_for_late_capture_truth deal ${dealId}`, lateLook.until);
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

    await applyCompletedDealOutcome(dealId, eventId);
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
      // Product catalog (072): a storage object may be shared between a
      // Product and the Deals created from it. Delete the blob only when no
      // metadata row references it any more; the task still completes.
      const references = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM siton.deal_images WHERE storage_provider=$1 AND storage_key=$2
           UNION ALL
           SELECT 1 FROM siton.product_images WHERE storage_provider=$1 AND storage_key=$2
         ) AS still_referenced`,
        [task.storage_provider, task.storage_key]
      );
      if (!references.rows[0]?.still_referenced) await storage.delete(String(task.storage_key));
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
  // F-4 — no UNKNOWN money identity may stay without a live reconcile.
  await reconcileOrphanedUnknownIdentities().catch(() => 0);
  // F-2b — no deal past its completion window may stay without a live finalize.
  await rescheduleStalledFinalizations().catch(() => 0);
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

// Percent-decoding can throw on malformed input (`%zz`, a lone `%`, a truncated
// multi-byte sequence). This function runs inside the log serializer, on every
// request, before any routing decision - and an exception thrown there escapes
// the HTTP request handler and takes the process down. The independent review
// proved it: one anonymous `GET /health?%zz=1` killed the web process.
//
// So this function is TOTAL: it never throws, whatever bytes arrive. A key that
// will not decode is matched on its raw form; a key that decodes is matched on
// both forms, so `%74=` and `t=` are both recognised as the sensitive `t`.
function decodeQueryKeyForMatch(key: string): string {
  if (key.indexOf("%") === -1) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function isSensitiveQueryKey(rawKey: string): boolean {
  if (!rawKey) return false;
  return SENSITIVE_QUERY_KEYS.has(rawKey.toLowerCase()) || SENSITIVE_QUERY_KEYS.has(decodeQueryKeyForMatch(rawKey).toLowerCase());
}

export function redactUrlForLogs(rawUrl: unknown): string {
  try {
    const url = typeof rawUrl === "string" ? rawUrl : String(rawUrl ?? "");
    const split = url.indexOf("?");
    if (split === -1) return url;
    const path = url.slice(0, split);
    // Everything after '?' is query material. No fragment handling on purpose:
    // an HTTP client never sends one, so a '#' that arrives on the wire is just
    // bytes inside a query pair and must be scanned like any other.
    const params = url.slice(split + 1).split("&").map((pair) => {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      return isSensitiveQueryKey(key) ? `${key}=[redacted]` : pair;
    });
    return `${path}?${params.join("&")}`;
  } catch {
    // Unreachable by construction, kept so the serializer can never be the
    // reason a request fails.
    return "[unserializable-url]";
  }
}

const app = Fastify({
  logger: {
    serializers: {
      // Mirrors Fastify's default request serializer, with the URL sanitized.
      // Total by construction: a serializer that throws takes the request
      // handler - and the process - down with it.
      req(request: any) {
        try {
          return {
            method: request.method,
            url: redactUrlForLogs(request.url),
            host: request.host ?? request.headers?.host,
            remoteAddress: request.ip ?? request.socket?.remoteAddress,
            remotePort: request.socket?.remotePort
          };
        } catch {
          return { method: "?", url: "[unserializable-request]" };
        }
      }
    }
  },
  // ONE request id, normalised ONCE, at creation. The application treats
  // `x-request-id` as the canonical correlation id and writes it into audit
  // rows through safeHeaderId (bounded length, safe character policy, minted
  // fallback). Fastify's own reqIdHeader option would log the caller's RAW
  // value instead, so a hostile id (`abc`, 3000 bytes, whitespace) diverged
  // between the log line and the audit row - the independent review's
  // MEDIUM-2. Generating the id through the same normaliser makes the response
  // header, every log line, telemetry and the audit row carry the same value,
  // and keeps caller bytes that fail the policy out of the log entirely.
  genReqId(req: any) {
    return safeHeaderId(req?.headers?.["x-request-id"], "req");
  },
  trustProxy: true,
  bodyLimit: 8 * 1024 * 1024,
  rewriteUrl(req) {
    return rewriteCanonicalApiAlias(String(req.url || "/"));
  }
});

/**
 * Live route inventory, captured at registration. The authorization gate
 * (tests/protected_route_authorization_gate.ts, scripts/protected_route_policy.cjs)
 * classifies from this rather than from a path prefix alone: a route that
 * declares `config.authority` is protected wherever its path lives, which is
 * how the seller lifecycle routes at the bare `/deals` paths are covered.
 * Read-only for consumers; Fastify freezes the router at ready().
 */
export type RegisteredRoute = { method: string; url: string; config: Record<string, unknown> };
export const ROUTE_REGISTRY: RegisteredRoute[] = [];
app.addHook("onRoute", (route: any) => {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  const { url: _url, method: _method, ...config } = (route.config || {}) as Record<string, unknown>;
  for (const method of methods) {
    ROUTE_REGISTRY.push({ method: String(method).toUpperCase(), url: String(route.url), config: { ...config } });
  }
});

// Route metadata used by the authorization policy: "this route acts with the
// named principal's authority". It is a declaration the gate enforces
// behaviourally, never a guard by itself.
const SELLER_AUTHORITY_ROUTE = { config: { authority: "seller" } } as const;

function applySecurityHeaders(reply: any) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  // P0.6-2 ROOT CAUSE: geolocation=() DISABLED the API for the page itself,
  // so "השתמש במיקום שלי" always failed instantly with PERMISSION_DENIED and
  // no browser prompt. geolocation=(self) lets OUR page ask the user (the
  // browser prompt/deny still fully applies); every other capability stays off.
  // LAUNCH SPRINT 3: camera=(self) for the seller pickup scanner — requested
  // only on an explicit tap inside our own page, manual code entry always
  // available (docs/PHYSICAL_FULFILLMENT_PICKUP.md §6). Microphone/payment/
  // usb/serial stay off.
  reply.header("permissions-policy", "camera=(self), microphone=(), geolocation=(self), payment=(), usb=(), serial=()");
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
    // GAP-HTTP-1 - /readiness is the Render health-check path and a live
    // verdict about THIS instance. Cached by any intermediary it becomes a
    // stale verdict, which is exactly the answer a readiness probe must never
    // give: a failing instance keeps receiving traffic, or a recovered one
    // keeps being drained.
    path === "/readiness" ||
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
  applicationRequestTelemetry.start(req);
  // req.id was produced by genReqId through safeHeaderId; re-normalising the
  // header here would MINT a second id for a hostile value and split log from
  // audit again. One id, created once.
  const requestId = String(req.id || safeHeaderId(req.headers?.["x-request-id"], "req"));
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

// ─── Hostile-input rejection: NUL bytes ─────────────────────────────────────
//
// HOOK ORDER IS DELIBERATE (independent review LOW-2). These two hooks are
// registered AFTER the request-envelope hook (canonical request id, security
// headers, no-store, telemetry start) and AFTER the rate limiter, and BEFORE any
// handler - so a rejected hostile request still goes out with the standard safe
// envelope and still counts against the caller's budget, while nothing that
// costs a database round-trip or an authentication lookup runs for it.
//
// A NUL byte cannot exist in a PostgreSQL text value or jsonb document, so any
// caller-chosen value carrying one is guaranteed to fail downstream - and it
// failed as a 500: `GET /api/admin/support-cases?seller_id=%00` reached the
// driver (V5), and a NUL inside a JSON string on POST /deals did the same
// (LOW-3). A caller-chosen byte must never produce a server error, and the fix
// belongs at the entry point because every route that forwards input into a
// query has the same exposure.
//
// Rejecting is right, not stripping: a NUL is never meaningful input, and
// silently rewriting it would change what the caller asked for. Only NUL is
// refused globally - other control characters are legal in PostgreSQL and are
// scrubbed per field where the product wants that; refusing them everywhere
// would invent a contract the product never made.
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

/**
 * True when a parsed JSON body carries a NUL anywhere: top-level strings,
 * nested strings, array elements, and object KEYS (jsonb rejects those too).
 * Iterative (an explicit worklist, no recursion), so nesting depth cannot
 * overflow; bodyLimit already bounds the total size. The worklist is not named
 * "stack" on purpose: the error-disclosure scan forbids that token in this file.
 */
function bodyCarriesNulByte(body: unknown): boolean {
  const pending: unknown[] = [body];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.indexOf("\u0000") !== -1) return true;
      continue;
    }
    if (!value || typeof value !== "object" || Buffer.isBuffer(value)) continue;
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key.indexOf("\u0000") !== -1) return true;
      pending.push((value as Record<string, unknown>)[key]);
    }
  }
  return false;
}

app.addHook("preValidation", (req: any, reply: any, done) => {
  const body = req.body;
  if (body !== undefined && body !== null && bodyCarriesNulByte(body)) {
    void reply.code(400).send({ ok: false, error: "invalid_body", code: "NUL_BYTE_IN_BODY" });
    return;
  }
  done();
});

app.setErrorHandler((error: any, req: any, reply) => {
  const statusCode = Number(error.statusCode || error.status || 0);
  const httpStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  if (httpStatus >= 500) {
    // Through the REQUEST-scoped logger, so the line carries the canonical
    // request id and can be joined to the audit trail. The root logger has no
    // request binding and would write an orphan line.
    (req?.log ?? app.log).error({ err: error }, "unhandled route error");
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

// ── Product catalog (migration 072) ─────────────────────────────────────────
// A seller-owned reusable Product: the presentation truth (name, copy,
// category, typed attributes, imagery, fulfillment defaults) maintained once
// and frozen into every Deal created from it. Read routes live in
// frontend_runtime.ts (seller surface); the writers are here with the same
// seller authority + enforcement checks the Deal writers use.
function normalizedProductInput(body: Record<string, any>, current?: Record<string, any>) {
  const name = String(body.name ?? current?.name ?? "").trim().slice(0, 200);
  if (!name) throw Object.assign(new Error("product name is required"), { statusCode: 400, code: "product_name_required" });
  const shortDescription = String(body.short_description ?? current?.short_description ?? "").trim().slice(0, 200);
  const longDescription = String(body.long_description ?? current?.long_description ?? "").trim().slice(0, 4000);
  const productType = normalizeProductType(body.product_type ?? current?.product_type);
  return {
    name,
    short_description: shortDescription,
    long_description: longDescription,
    product_type: productType,
    category: String(body.category ?? current?.category ?? "").trim().slice(0, 160),
    type_attributes: validateProductAttributes(productType, body.type_attributes ?? current?.type_attributes),
    fulfillment_defaults: normalizeFulfillmentDefaults(body.fulfillment_defaults ?? current?.fulfillment_defaults)
  };
}

async function ownedProductSnapshot(c: any, sellerId: string, productId: string, allowArchived = false) {
  const productResult = await c.query(
    `SELECT product_id, seller_id, name, short_description, long_description, product_type,
            category, type_attributes, fulfillment_defaults, status, revision, created_at, updated_at
       FROM siton.products
      WHERE product_id=$1 AND seller_id=$2${allowArchived ? "" : " AND status='active'"}
      LIMIT 1`,
    [productId, sellerId]
  );
  if (!productResult.rowCount) {
    throw Object.assign(new Error("product not found"), { statusCode: 404, code: "product_not_found" });
  }
  const images = await c.query(
    `SELECT product_image_id, storage_provider, storage_key, public_url, original_filename,
            mime_type, size_bytes, checksum_sha256, sort_order, is_primary
       FROM siton.product_images WHERE product_id=$1
      ORDER BY is_primary DESC, sort_order ASC, created_at ASC`,
    [productId]
  );
  return { product: productResult.rows[0], images: images.rows, snapshot: buildProductSnapshot(productResult.rows[0], images.rows) };
}

app.post("/api/seller/products", SELLER_AUTHORITY_ROUTE, async (req: any, reply: any) => {
  await ensureProductCatalogTables(withTx);
  const created = await withTx(async (c) => {
    const seller = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, seller.seller_id, "create_draft");
    // Authorization precedes every observation: validation answers only a seller.
    const input = normalizedProductInput((req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>);
    const result = await c.query(
      `INSERT INTO siton.products
         (seller_id, name, short_description, long_description, product_type, category,
          type_attributes, fulfillment_defaults)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING product_id, seller_id, name, short_description, long_description, product_type,
                 category, type_attributes, fulfillment_defaults, status, revision, created_at, updated_at`,
      [seller.seller_id, input.name, input.short_description, input.long_description, input.product_type,
        input.category, JSON.stringify(input.type_attributes), JSON.stringify(input.fulfillment_defaults)]
    );
    return result.rows[0];
  });
  return reply.code(201).send({ ok: true, product: created });
});

// Editing a Product creates revision N+1. Published Deals keep their frozen
// snapshot (DB trigger); a Draft created from the Product also keeps the
// snapshot it was created with — re-creating the Draft is the explicit way
// to pick up a newer revision.
app.patch("/api/seller/products/:productId", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  await ensureProductCatalogTables(withTx);
  const productId = String(req.params.productId || "");
  return withTx(async (c) => {
    const seller = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, seller.seller_id, "operate");
    requireUuid(productId, "product_id"); // after the guard: authorization precedes observation
    const currentResult = await c.query(
      `SELECT product_id, seller_id, name, short_description, long_description, product_type,
              category, type_attributes, fulfillment_defaults, status, revision
         FROM siton.products WHERE product_id=$1 FOR UPDATE`,
      [productId]
    );
    if (!currentResult.rowCount || normalizeSellerId(currentResult.rows[0].seller_id) !== seller.seller_id) {
      throw Object.assign(new Error("product not found"), { statusCode: 404, code: "product_not_found" });
    }
    const current = currentResult.rows[0];
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;
    if (body.product_type !== undefined && normalizeProductType(body.product_type) !== String(current.product_type)) {
      throw Object.assign(new Error("product_type cannot change after creation"), { statusCode: 409, code: "product_type_locked" });
    }
    const input = normalizedProductInput(body, current);
    const status = body.status === undefined ? String(current.status) : String(body.status);
    if (!["active", "archived"].includes(status)) {
      throw Object.assign(new Error("product status is invalid"), { statusCode: 400, code: "product_status_invalid" });
    }
    const updated = await c.query(
      `UPDATE siton.products SET name=$3, short_description=$4, long_description=$5,
              product_type=$6, category=$7, type_attributes=$8, fulfillment_defaults=$9,
              status=$10, revision=revision+1, updated_at=now()
        WHERE product_id=$1 AND seller_id=$2
        RETURNING product_id, seller_id, name, short_description, long_description, product_type,
                  category, type_attributes, fulfillment_defaults, status, revision, created_at, updated_at`,
      [productId, seller.seller_id, input.name, input.short_description, input.long_description,
        input.product_type, input.category, JSON.stringify(input.type_attributes),
        JSON.stringify(input.fulfillment_defaults), status]
    );
    return { ok: true, product: updated.rows[0] };
  });
});

// Promote a seller-owned Draft's buyer-visible product fields and images into
// a reusable Product, then attach a frozen snapshot to that same Draft.
app.post("/api/seller/deals/:dealId/product", SELLER_AUTHORITY_ROUTE, async (req: any, reply: any) => {
  await ensureProductCatalogTables(withTx);
  const dealId = String(req.params.dealId || "");
  const response = await withTx(async (c) => {
    const seller = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, seller.seller_id, "operate");
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
    const dealResult = await c.query(
      `SELECT deal_id, seller_id, state, title, description, description_short, deal_type, product_id
         FROM siton.deals WHERE deal_id=$1 FOR UPDATE`,
      [dealId]
    );
    if (!dealResult.rowCount || normalizeSellerId(dealResult.rows[0].seller_id) !== seller.seller_id) {
      throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
    }
    const deal = dealResult.rows[0];
    if (String(deal.state) !== "Draft") {
      throw Object.assign(new Error("only a Draft can create a Product"), { statusCode: 409, code: "DEAL_NOT_EDITABLE" });
    }
    if (deal.product_id) {
      throw Object.assign(new Error("Draft already has a Product"), { statusCode: 409, code: "deal_product_already_attached" });
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;
    const dealType = String(deal.deal_type || "physical_product");
    // Typed attributes default to the Draft's own terms so the Product is
    // complete without the seller re-typing what the Draft already knows.
    let typeAttributes = body.type_attributes;
    if (typeAttributes === undefined) {
      if (dealType === "voucher") typeAttributes = await readVoucherTerms(c, dealId);
      else if (dealType === "ticket") typeAttributes = await readTicketTerms(c, dealId);
    }
    const input = normalizedProductInput({
      ...body,
      name: body.name ?? deal.title,
      short_description: body.short_description ?? deal.description_short,
      long_description: body.long_description ?? deal.description,
      product_type: dealType,
      type_attributes: typeAttributes
    });
    const productResult = await c.query(
      `INSERT INTO siton.products
         (seller_id, name, short_description, long_description, product_type, category,
          type_attributes, fulfillment_defaults)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING product_id, seller_id, name, short_description, long_description, product_type,
                 category, type_attributes, fulfillment_defaults, status, revision, created_at, updated_at`,
      [seller.seller_id, input.name, input.short_description, input.long_description, input.product_type,
        input.category, JSON.stringify(input.type_attributes), JSON.stringify(input.fulfillment_defaults)]
    );
    const product = productResult.rows[0];
    await c.query(
      `INSERT INTO siton.product_images
         (product_id, storage_provider, storage_key, public_url, original_filename, mime_type,
          size_bytes, checksum_sha256, sort_order, is_primary)
       SELECT $2, storage_provider, storage_key, public_url, original_filename, mime_type,
              size_bytes, checksum_sha256, sort_order, is_primary
         FROM siton.deal_images WHERE deal_id=$1
        ORDER BY sort_order ASC, created_at ASC`,
      [dealId, product.product_id]
    );
    const loaded = await ownedProductSnapshot(c, seller.seller_id, String(product.product_id));
    await c.query(
      `UPDATE siton.deals SET product_id=$2, product_snapshot_jsonb=$3, updated_at=now()
        WHERE deal_id=$1`,
      [dealId, product.product_id, JSON.stringify(loaded.snapshot)]
    );
    return { ok: true, product: loaded.product, snapshot: loaded.snapshot, deal_id: dealId };
  });
  return reply.code(201).send(response);
});

app.get("/api/seller/product-images/:productImageId", async (req: any, reply: any) => {
  await ensureProductCatalogTables(withTx);
  const productImageId = String(req.params.productImageId || "");
  const image = await withTx(async (c) => {
    const seller = await requireSellerAuthorityWithoutBody(req, c);
    requireUuid(productImageId, "product_image_id"); // after the guard
    const result = await c.query(
      `SELECT i.storage_key, i.mime_type, i.public_url
         FROM siton.product_images i
         JOIN siton.products p ON p.product_id=i.product_id
        WHERE i.product_image_id=$1 AND p.seller_id=$2`,
      [productImageId, seller.seller_id]
    );
    if (!result.rowCount) throw Object.assign(new Error("product image not found"), { statusCode: 404, code: "product_image_not_found" });
    return result.rows[0];
  });
  const externalUrl = String(image.public_url || "").trim();
  if (/^https:\/\//.test(externalUrl)) return reply.header("cache-control", "private, max-age=300").redirect(externalUrl, 302);
  const file = await readDealImage(String(image.storage_key));
  return reply.header("content-type", String(image.mime_type)).header("cache-control", "private, no-store").send(file);
});

app.post("/deals", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  await ensureRemainingProductSurfaceTables(withTx);
  await ensureDealTypeTables(withTx);
  await ensureProductCatalogTables(withTx);
  // Authorization precedes every observation (independent review LOW-4): an
  // anonymous caller must not learn which body shapes this route accepts. The
  // creating transaction below authenticates again for its own consistency;
  // this early check costs one session lookup and refuses before any
  // validation answer becomes visible.
  await withTx(async (c) => { await requireSellerAuthority(req, c); });
  const body = req.body || {};
  // Product catalog (072): a Deal created FROM a Product takes every
  // Product-owned presentation field from the server-loaded snapshot.
  const productId = String(body.product_id || "").trim();
  if (productId) requireUuid(productId, "product_id");
  const requestedDealType: DealType = normalizeDealType(body.deal_type, "physical_product");
  if (body.deal_type !== undefined && body.deal_type !== null && !["physical_product","voucher","ticket"].includes(String(body.deal_type))) {
    const err: any = new Error("deal_type must be one of physical_product, voucher, ticket");
    err.statusCode = 400;
    err.code = "deal_type_invalid";
    throw err;
  }
  const requestedVoucherTerms = body.voucher_terms && typeof body.voucher_terms === "object" ? body.voucher_terms : null;
  const requestedTicketTerms = body.ticket_terms && typeof body.ticket_terms === "object" ? body.ticket_terms : null;
  if (requestedDealType === "voucher" && !requestedVoucherTerms && !productId) {
    const err: any = new Error("voucher_terms is required for voucher deals");
    err.statusCode = 400;
    err.code = "voucher_terms_required";
    throw err;
  }
  if (requestedDealType === "ticket" && !requestedTicketTerms && !productId) {
    const err: any = new Error("ticket_terms is required for ticket deals");
    err.statusCode = 400;
    err.code = "ticket_terms_required";
    throw err;
  }
  const title = readCreateDealTitle(body);
  // A Product-backed Deal never trusts browser-owned Product copy.
  if (!productId && !title) {
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
  // Read the price AS numeric(12,2) WILL STORE IT. A raw "> 0" check passed
  // 0.001, which the column then rounded to 0.00 — the very value the next
  // line refuses — and the deal published at a price of zero.
  const priceRaw = readMoneyAmount(body.price_per_unit, {
    field: "price_per_unit",
    min: MONEY_EPSILON
  });
  // LAUNCH MODE — optional regular ("normal") price; when given it must be
  // ABOVE the group price, otherwise the shown saving would be a lie.
  const listPrice = readListPricePerUnit(body.list_price_per_unit, priceRaw);
  const requestedMinUnitsRaw = body.min_units ?? body.threshold_units ?? 10;
  const minUnits = readUnitCount(requestedMinUnitsRaw, "min_units", 10);
  const requestedMaxUnitsRaw = body.max_units ?? Math.max(minUnits, 20);
  const maxUnits = Math.max(minUnits, readUnitCount(requestedMaxUnitsRaw, "max_units", 20));
  const draftThreshold = Math.ceil(0.9 * minUnits);
  const deliveryOptions = Array.isArray(body.delivery_options)
    ? body.delivery_options
        .map((option: any, index: number) => ({
          option_type: ["delivery", "pickup", "distribution_point"].includes(String(option?.option_type || ""))
            ? String(option.option_type)
            : "pickup",
          label: String(option?.label || "").trim().slice(0, 160),
          // Math.max(0, Number("abc")) is NaN, and numeric accepts 'NaN'
          // verbatim: the deal published with a NaN delivery cost and the fee
          // engine turned the poisoned total into a zero fee.
          cost: readMoneyAmount(option?.cost ?? 0, { field: "delivery_cost", min: 0 }),
          sort_order: Number.isFinite(Number(option?.sort_order)) ? Number(option.sort_order) : index,
          ...normalizeDeliveryCoordinates(option),
          ...normalizeDeliveryEstimate(option)
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
  const deadlinePolicy = classifyDeadline(deadlineMs, now);
  if (!deadlinePolicy.ok) {
    const err: any = new Error(deadlinePolicy.message);
    err.statusCode = 400;
    err.code = deadlinePolicy.code;
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
      deal_type: requestedDealType,
      product_id: productId || null,
      delivery_options: requestedDealType === "physical_product" ? deliveryOptions : [],
      voucher_terms: requestedDealType === "voucher" ? requestedVoucherTerms : null,
      ticket_terms: requestedDealType === "ticket" ? requestedTicketTerms : null
    }))
    .digest("hex");

  const r = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "create_draft");
    let productSnapshot: ReturnType<typeof buildProductSnapshot> | null = null;
    let effectiveTitle = title;
    let effectiveDescription = description;
    let effectiveDescriptionShort = descriptionShort;
    // the Product snapshot may override the requested type (must match when both are given)
    let dealType: DealType = requestedDealType;
    let voucherTermsInput = requestedVoucherTerms;
    let ticketTermsInput = requestedTicketTerms;
    let effectiveDeliveryOptions = deliveryOptions;
    if (productId) {
      // Ownership + active status are enforced by the query (archived → 404):
      // an archived Product cannot silently start a Deal.
      const loaded = await ownedProductSnapshot(c, sellerAuthority.seller_id, productId);
      productSnapshot = loaded.snapshot;
      effectiveTitle = loaded.snapshot.name;
      effectiveDescription = loaded.snapshot.long_description;
      effectiveDescriptionShort = loaded.snapshot.short_description;
      dealType = loaded.snapshot.product_type;
      if (body.deal_type !== undefined && body.deal_type !== null && String(body.deal_type) !== dealType) {
        throw Object.assign(new Error("deal_type must match the selected Product"), { statusCode: 409, code: "product_type_mismatch" });
      }
      const attrs = loaded.snapshot.type_attributes as any;
      if (dealType === "voucher") {
        voucherTermsInput = requestedVoucherTerms ?? {
          face_value_amount: priceRaw, currency: "ILS", valid_from: attrs.valid_from,
          valid_until: attrs.valid_until, redemption_location: attrs.redemption_location,
          redemption_instructions: attrs.redemption_instructions, terms: attrs.usage_restrictions
        };
      }
      if (dealType === "ticket") ticketTermsInput = requestedTicketTerms ?? attrs;
      if (dealType === "physical_product") {
        const defaults = loaded.snapshot.fulfillment_defaults as any;
        effectiveDeliveryOptions = deliveryOptions.map((option: any) => ({
          ...option,
          estimated_min_business_days: option.estimated_min_business_days ?? defaults.estimated_min_business_days ?? null,
          estimated_max_business_days: option.estimated_max_business_days ?? defaults.estimated_max_business_days ?? null
        }));
      }
    }
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
       (deal_id, title, description, description_short, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, deal_type, list_price_per_unit,
        product_id, product_snapshot_jsonb)
       VALUES ($1,$2,$3,$11,$4,$5,$6,$7,$8,$9,$10,$12,$13,$14)
       RETURNING deal_id, state, deal_type, product_id`,
      [
        stableDealId,
        effectiveTitle,
        effectiveDescription || null,
        priceRaw,
        minUnits,
        maxUnits,
        draftThreshold,
        deadlineIso,
        sellerAuthority.seller_id,
        dealType,
        effectiveDescriptionShort || null,
        listPrice,
        productId || null,
        productSnapshot ? JSON.stringify(productSnapshot) : null
      ]
    );
    const deal = ins.rows[0];
    if (dealType === "physical_product") {
      for (const option of effectiveDeliveryOptions) {
        await c.query(
          `INSERT INTO siton.deal_delivery_options
             (deal_id, option_type, label, cost, sort_order, latitude, longitude,
              estimated_min_business_days, estimated_max_business_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [deal.deal_id, option.option_type, option.label, option.cost, option.sort_order, option.latitude, option.longitude,
            option.estimated_min_business_days, option.estimated_max_business_days]
        );
      }
    }
    if (dealType === "voucher" && voucherTermsInput) {
      await upsertVoucherTerms(c, String(deal.deal_id), voucherTermsInput);
    }
    if (dealType === "ticket" && ticketTermsInput) {
      await upsertTicketTerms(c, String(deal.deal_id), ticketTermsInput);
    }
    if (productId) {
      // Product imagery becomes the Deal's imagery (metadata copy; the storage
      // object is shared and reference-counted by the cleanup rail).
      await c.query(
        `INSERT INTO siton.deal_images
           (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type,
            size_bytes, checksum_sha256, sort_order, is_primary)
         SELECT $2, storage_provider, storage_key, public_url, original_filename, mime_type,
                size_bytes, checksum_sha256, sort_order, is_primary
           FROM siton.product_images WHERE product_id=$1
          ORDER BY sort_order ASC, created_at ASC`,
        [productId, deal.deal_id]
      );
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
  const hasEditableField = hasTitle || ["description", "description_short", "price_per_unit", "list_price_per_unit", "min_units", "max_units", "deadline", "delivery_options", "voucher_terms", "ticket_terms"].some(hasOwn);

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
      `SELECT deal_id, seller_id, state, title, description, description_short, price_per_unit, list_price_per_unit,
              min_units, max_units, threshold_units, deadline, deal_type, product_id, updated_at
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
    // Product catalog (072): presentation fields of a Product-backed Draft are
    // owned by the frozen snapshot — edit the Product (new revision) and
    // re-create the Draft instead of diverging the two.
    if (current.product_id && (hasTitle || hasOwn("description") || hasOwn("description_short") || hasOwn("deal_type"))) {
      throw Object.assign(new Error("Product-backed fields are owned by the Product snapshot"), { statusCode: 409, code: "product_snapshot_fields_locked" });
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
    const price = hasOwn("price_per_unit")
      ? readMoneyAmount(body.price_per_unit, { field: "price_per_unit", min: MONEY_EPSILON })
      : Number(current.price_per_unit);
    if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error("price_per_unit must be a positive number"), { statusCode: 400, code: "price_invalid" });
    // LAUNCH MODE — regular price is re-validated against the (possibly new) group price
    const listPrice = hasOwn("list_price_per_unit")
      ? readListPricePerUnit(body.list_price_per_unit, price)
      : readListPricePerUnit(current.list_price_per_unit, price, { tolerateInvalid: true });
    const minUnits = hasOwn("min_units") ? Number(body.min_units) : Number(current.min_units);
    const maxUnits = hasOwn("max_units") ? Number(body.max_units) : Number(current.max_units);
    if (!Number.isInteger(minUnits) || minUnits < 1) throw Object.assign(new Error("min_units must be a positive integer"), { statusCode: 400, code: "min_units_invalid" });
    if (!Number.isInteger(maxUnits) || maxUnits < minUnits) throw Object.assign(new Error("max_units must be an integer at least min_units"), { statusCode: 400, code: "max_units_invalid" });
    let deadline = new Date(current.deadline).toISOString();
    if (hasOwn("deadline")) {
      const deadlineMs = new Date(body.deadline).getTime();
      if (!Number.isFinite(deadlineMs)) throw Object.assign(new Error("deadline must be a valid ISO date"), { statusCode: 400, code: "deadline_invalid" });
      const deadlinePolicy = classifyDeadline(deadlineMs);
      if (!deadlinePolicy.ok) throw Object.assign(new Error(deadlinePolicy.message), { statusCode: 400, code: deadlinePolicy.code });
      deadline = new Date(deadlineMs).toISOString();
    }

    const updated = await c.query(
      `UPDATE siton.deals
       SET title=$2, description=$3, description_short=$9, price_per_unit=$4, list_price_per_unit=$10, min_units=$5, max_units=$6,
           threshold_units=$7, deadline=$8, updated_at=now()
       WHERE deal_id=$1
       RETURNING deal_id, state, title, description, description_short, price_per_unit, list_price_per_unit, min_units,
                 max_units, threshold_units, deadline, deal_type, updated_at`,
      [dealId, title, description || null, price, minUnits, maxUnits, Math.ceil(0.9 * minUnits), deadline, descriptionShort || null, listPrice]
    );

    if (hasOwn("delivery_options")) {
      if (!Array.isArray(body.delivery_options) || body.delivery_options.length > 5) {
        throw Object.assign(new Error("delivery_options must contain at most 5 options"), { statusCode: 400, code: "delivery_options_invalid" });
      }
      const options = body.delivery_options.map((option: any, index: number) => ({
        option_type: ["delivery", "pickup", "distribution_point"].includes(String(option?.option_type || "")) ? String(option.option_type) : "pickup",
        label: String(option?.label || "").trim().slice(0, 160),
        cost: readMoneyAmount(option?.cost ?? 0, { field: "delivery_cost", min: 0 }),
        sort_order: Number.isInteger(Number(option?.sort_order)) ? Number(option.sort_order) : index,
        ...normalizeDeliveryCoordinates(option),
        ...normalizeDeliveryEstimate(option)
      }));
      if (options.some((option: any) => !option.label || !Number.isFinite(option.cost) || option.cost < 0)) {
        throw Object.assign(new Error("delivery_options contain invalid values"), { statusCode: 400, code: "delivery_options_invalid" });
      }
      await c.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]);
      if (String(current.deal_type) === "physical_product") {
        for (const option of options) {
          await c.query(
            `INSERT INTO siton.deal_delivery_options
               (deal_id, option_type, label, cost, sort_order, latitude, longitude,
                estimated_min_business_days, estimated_max_business_days)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [dealId, option.option_type, option.label, option.cost, option.sort_order, option.latitude, option.longitude,
              option.estimated_min_business_days, option.estimated_max_business_days]
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
      ...normalizeDeliveryCoordinates(option),
      ...normalizeDeliveryEstimate(option)
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
      `SELECT option_type, label, cost, sort_order, latitude, longitude,
              estimated_min_business_days, estimated_max_business_days
       FROM siton.deal_delivery_options WHERE deal_id=$1 ORDER BY sort_order ASC`,
      [dealId]
    );
    await c.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]);
    const inserted: any[] = [];
    for (const option of options) {
      const row = await c.query(
        `INSERT INTO siton.deal_delivery_options
           (deal_id, option_type, label, cost, sort_order, latitude, longitude,
            estimated_min_business_days, estimated_max_business_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING option_id, option_type, label, cost, sort_order, latitude, longitude,
                   estimated_min_business_days, estimated_max_business_days`,
        [dealId, option.option_type, option.label, option.cost, option.sort_order, option.latitude, option.longitude,
          option.estimated_min_business_days, option.estimated_max_business_days]
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
        longitude: row.longitude === null ? null : Number(row.longitude),
        estimated_min_business_days: row.estimated_min_business_days === null ? null : Number(row.estimated_min_business_days),
        estimated_max_business_days: row.estimated_max_business_days === null ? null : Number(row.estimated_max_business_days)
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

// LAUNCH MODE — optional regular ("normal") price per unit. Absent/empty →
// null. When present it must be a finite number ABOVE the group price, so a
// displayed saving can never be fabricated. `tolerateInvalid` is used when
// re-validating a stored value against a NEW group price on a Draft edit:
// a now-invalid stored anchor is dropped (null) rather than blocking the edit.
// RED TEAM FIX (Phase 2 §2.2) — unit counts are integer columns.
// `Math.max(1, Number(raw))` happily produced 10.4 and 1e12, which PostgreSQL
// rejected with 22P02 / 22003 AFTER the transaction had started, so the seller
// got a 500 `internal_error` for what is plainly a bad request. The draft-patch
// path already validated this with Number.isInteger and answered 400; the
// create path is brought up to the same standard. The historical clamp of an
// out-of-range-but-integral value to the floor is preserved deliberately —
// only the values the column cannot hold at all are now refused.
const UNIT_COUNT_MAX = 2_147_483_647; // int4

function readUnitCount(raw: unknown, field: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === "" || Number(raw) === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw Object.assign(new Error(`${field} must be a whole number of units`), {
      statusCode: 400,
      code: `${field}_invalid`
    });
  }
  if (value > UNIT_COUNT_MAX) {
    throw Object.assign(new Error(`${field} must be at most ${UNIT_COUNT_MAX}`), {
      statusCode: 400,
      code: `${field}_invalid`
    });
  }
  return Math.max(1, value);
}

function readListPricePerUnit(raw: unknown, groupPrice: number, opts: { tolerateInvalid?: boolean } = {}): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  // Both sides are compared as numeric(12,2) will hold them: a "regular" price
  // of 50.001 against a group price of 50 rounded to 50.00 vs 50.00 and
  // advertised a saving of zero.
  let stored: number | null = null;
  try {
    stored = readMoneyAmount(raw, { field: "list_price_per_unit", min: MONEY_EPSILON });
  } catch {
    stored = null;
  }
  const storedGroupPrice = Math.round(Number(groupPrice) * 100) / 100;
  if (stored !== null && stored > storedGroupPrice) return stored;
  if (opts.tolerateInvalid) return null;
  throw Object.assign(new Error("list_price_per_unit must be a number above price_per_unit"), { statusCode: 400, code: "list_price_invalid" });
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

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "create_draft");
    requireUuid(sourceDealId, "deal_id"); // after the guard: authorization precedes observation
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

  const response = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    // Authorization precedes every observation: the id shape, the upload body
    // and the idempotency key are validated only for an authenticated seller.
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

  return withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    // Authorization precedes every observation.
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
  const removed = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
    requireUuid(imageId, "image_id");
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
    // Product catalog (072): the same storage object may back a Product image
    // or another Deal's image; the blob is deleted only when nothing else
    // references it any more.
    const shared = await c.query(
      `SELECT EXISTS (
         SELECT 1 FROM siton.deal_images WHERE storage_provider=$1 AND storage_key=$2
         UNION ALL
         SELECT 1 FROM siton.product_images WHERE storage_provider=$1 AND storage_key=$2
       ) AS still_referenced`,
      [image.storage_provider, image.storage_key]
    );
    return { storage_provider: image.storage_provider as StorageProviderCode, storage_key: String(image.storage_key), can_delete: !shared.rows[0]?.still_referenced };
  });

  let deletion: "deleted" | "scheduled" | "retained_shared" = removed.can_delete ? "deleted" : "retained_shared";
  if (!removed.can_delete) {
    await hitTestFault("http.delete.after_commit_before_response");
    return reply.send({ ok: true, deletion });
  }
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
  const result = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
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
    // Product catalog (072): blobs still referenced by a Product image or by
    // another Deal are never scheduled for cleanup.
    const images = await c.query(
      `SELECT i.storage_provider, i.storage_key FROM siton.deal_images i
        WHERE i.deal_id=$1
          AND NOT EXISTS (SELECT 1 FROM siton.product_images pi WHERE pi.storage_provider=i.storage_provider AND pi.storage_key=i.storage_key)
          AND NOT EXISTS (SELECT 1 FROM siton.deal_images di WHERE di.deal_id<>$1 AND di.storage_provider=i.storage_provider AND di.storage_key=i.storage_key)`,
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

app.post("/deals/:id/publish", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  const dealId = String(req.params.id);
  const body = req.body || {};
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const correlationId = req.headers["x-correlation-id"] ? String(req.headers["x-correlation-id"]) : requestId;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `publish:${dealId}`;

  let publishSellerId = "";
  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    publishSellerId = sellerAuthority.seller_id;
    await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "publish");
    // Authorization precedes every observation: id shape and body validation
    // answer only an authenticated, allowed seller.
    requireUuid(dealId, "deal_id");
    if (!isAccepted(body.seller_terms_accepted) || !isAccepted(body.seller_critical_terms_accepted) || !isAccepted(body.seller_threshold_90_accepted)) {
      const err: any = new Error("seller_terms_required");
      err.statusCode = 400;
      err.code = "seller_terms_required";
      throw err;
    }
    const r = await c.query(
      `SELECT d.seller_id, d.deal_type, d.product_id, d.product_snapshot_jsonb,
              (SELECT COUNT(*)::int FROM siton.deal_images i WHERE i.deal_id=d.deal_id) AS image_count,
              (SELECT COUNT(*)::int FROM siton.deal_delivery_options o WHERE o.deal_id=d.deal_id) AS delivery_count,
              (SELECT COUNT(*)::int FROM siton.deal_delivery_options o WHERE o.deal_id=d.deal_id
                AND (o.estimated_min_business_days IS NULL OR o.estimated_max_business_days IS NULL)) AS delivery_estimate_missing_count
         FROM siton.deals d WHERE d.deal_id=$1`,
      [dealId]
    );
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
    // Product catalog (072): a Product-backed Deal publishes only with a
    // complete frozen snapshot, at least one image, and (physical) delivery
    // options that each carry a fulfillment estimate. Legacy Deals (no
    // product_id) keep their existing publish rules unchanged.
    const readiness = r.rows[0] as any;
    if (readiness.product_id) {
      const blockers: string[] = [];
      if (!readiness.product_snapshot_jsonb?.content_hash) blockers.push("product_snapshot_missing");
      if (Number(readiness.image_count || 0) < 1) blockers.push("deal_image_missing");
      if (String(readiness.deal_type) === "physical_product") {
        if (Number(readiness.delivery_count || 0) < 1) blockers.push("delivery_option_missing");
        if (Number(readiness.delivery_estimate_missing_count || 0) > 0) blockers.push("delivery_estimate_missing");
      }
      if (blockers.length) {
        // The error handler exposes `reason_code` (never free-form details), so
        // the blocker list travels there for the seller UI and the tests.
        throw Object.assign(new Error("deal product readiness failed"), {
          statusCode: 409,
          code: "deal_product_readiness_failed",
          reasonCode: blockers.join(","),
          details: { blockers }
        });
      }
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
    // Concurrent publishes of one deal serialize on the deal row before the
    // idempotency lookup, so a loser replays (same key) or conflicts (new key)
    // instead of racing the deadline_check unique index into a 500.
    serializeOnEntity: true,
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
    if (bsUpd.rowCount !== 1) throw stateConflict("participant", pid, "NotJoined");
    const msUpd = await c.query(
      `UPDATE siton.participants SET money_state='AuthHeld' WHERE participant_id=$1 AND money_state='NoFinancial'`,
      [pid]
    );
    if (msUpd.rowCount !== 1) throw stateConflict("participant", pid, "NoFinancial");

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
        throw stateConflict("deal", dealId, "PendingTarget");
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

app.post("/deals/:id/close_joining", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  // LAUNCH MODE — a header-less pause must act every time: the previous default
  // (`close:<dealId>`) replayed the FIRST pause's stored response after a
  // reopen, so a seller's second pause silently did nothing. Mirror the reopen
  // route: a caller that wants replay protection sends its own key.
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `close:${dealId}:${Date.now()}`;

  const closeContext = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
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
app.post("/deals/:id/reopen_joining", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `reopen:${dealId}:${Date.now()}`;

  const ctx = await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
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

app.post("/deals/:id/prepare_charging", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `prepare:${dealId}`;

  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
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

app.post("/deals/:id/charging/start", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `start:${dealId}`;

  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
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

app.post("/deals/:id/cancel", SELLER_AUTHORITY_ROUTE, async (req: any) => {
  const dealId = String(req.params.id);
  const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : `req:${randomUUID()}`;
  const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : `cancel:${dealId}`;

  await withTx(async (c) => {
    const sellerAuthority = await requireSellerAuthority(req, c);
    requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
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
    // Same race class as deal.publish: the pending cancel_refund outbox row is
    // covered by the one-pending-per-aggregate-event index, so a cancel that loses
    // to an in-flight cancel — or a re-cancel under a NEW key while the first
    // cancel_refund is still pending/processing — used to be decided by 23505
    // (HTTP 500) instead of by the compare-and-swap (409). Lock order reviewed:
    // the deal row is taken first, exactly like publish, draft edit and delete.
    // Proof: tests/cancel_outbox_concurrency_validation.ts.
    serializeOnEntity: true,
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
  applyPaymentWebhookClassification,
  recordLateMoneyEffectException
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

