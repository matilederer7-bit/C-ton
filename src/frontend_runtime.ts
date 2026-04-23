import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash, createHmac, randomInt, timingSafeEqual } from "crypto";
import { buildOperationalReadinessSummary } from "./operational_readiness.js";
import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";
import { buildPayoutProvider, getPayoutProviderSummary, type PayoutProvider } from "./payout_provider.js";
import {
  ADMIN_API_KEY,
  PAYMENT_WEBHOOK_SECRET,
  PAYMENT_WEBHOOK_SECRET_IS_DEFAULT,
  PAYMENT_WEBHOOK_SECRET_IS_SAFE,
  SELLER_AUTH_CONFIGURED,
  SELLER_AUTH_MODE,
  SELLER_SESSION_SECRET
} from "./runtime_config.js";
import {
  DEFAULT_AFFILIATE_CODE,
  DEFAULT_AFFILIATE_NAME,
  DEFAULT_SELLER_ID,
  ensureRemainingProductSurfaceTables,
  isChargedMoneyState,
  summarizeMoney
} from "./product_surface_support.js";
import { buildWebhookIngestion } from "./webhook_ingestion.js";
import { buildPaymentReconciliation } from "./payment_reconciliation.js";
import { ensurePayoutRailTables } from "./payout_rail.js";
import {
  SELLER_SESSION_COOKIE,
  createSellerSessionToken,
  hashSellerAccessSecret,
  hashSellerSessionToken,
  SELLER_SESSION_TTL_SECONDS,
  normalizeSellerDisplayName,
  normalizeSellerId,
  normalizeSellerLoginEmail,
  parseCookies,
  serializeExpiredSellerSessionCookie,
  serializeSellerSessionCookie,
  verifySellerAccessSecret
} from "./seller_auth.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

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
  | "AuthHeld"
  | "AuthLocked"
  | "ChargeAttempt"
  | "ChargedSuccess"
  | "ChargeFailedRecovery"
  | "RecoveredCharge"
  | "AuthReleased"
  | "Refunded";

type OtpSession = {
  sessionId: string;
  phone: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  verified: boolean;
  attemptCount: number;
};

type DealListRow = {
  deal_id: string;
  seller_id?: string;
  title: string;
  state: DealState;
  price_per_unit: number;
  min_units: number;
  max_units: number;
  threshold_units: number;
  deadline: string;
  published_at: string | null;
  completion_window_until: string | null;
  created_at: string;
  platform_fee_rate: number;
  joined_units: number;
  participants_count: number;
};

const otpSessions = new Map<string, OtpSession>();
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;

// Purge expired OTP sessions every 5 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of otpSessions) {
    if (now > session.expiresAt) otpSessions.delete(id);
  }
}, 5 * 60_000).unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const frontendDirCandidates = [
  join(__dirname, "..", "frontend"),
  join(process.cwd(), "frontend"),
  join(process.cwd(), ".demo_dist", "frontend")
];
const frontendDir =
  frontendDirCandidates.find((candidate) => existsSync(join(candidate, "index.html"))) ||
  join(process.cwd(), "frontend");

async function ensureSellerAccount(c: any, sellerId: string, displayName?: string | null) {
  const normalizedSellerId = normalizeSellerId(sellerId);
  const normalizedDisplayName = normalizeSellerDisplayName(displayName, normalizedSellerId);
  const result = await c.query(
    `INSERT INTO siton.seller_accounts (
       seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked, admin_note
     )
     VALUES ($1, $2, 'approved', 'active', 'bank_transfer', '***1234', 'Minimum seller identity context')
     ON CONFLICT (seller_id) DO UPDATE
     SET display_name = CASE
           WHEN siton.seller_accounts.display_name IS NULL OR btrim(siton.seller_accounts.display_name) = '' THEN EXCLUDED.display_name
           WHEN $3 THEN EXCLUDED.display_name
           ELSE siton.seller_accounts.display_name
         END,
         updated_at = now()
     RETURNING seller_id, display_name, login_email, auth_enabled, verification_status, settlement_status, payout_method, payout_details_masked, admin_note, created_at, updated_at, last_login_at`,
    [normalizedSellerId, normalizedDisplayName, Boolean(displayName && String(displayName).trim())]
  );
  return result.rows[0] as any;
}

function requestClientIp(req: any) {
  return String(req.ip || req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "").trim().slice(0, 120);
}

function requestUserAgent(req: any) {
  return String(req.headers?.["user-agent"] || "").trim().slice(0, 240);
}

function mapSellerProfile(profile: any, contextSource: string) {
  return {
    seller_id: String(profile.seller_id),
    display_name: String(profile.display_name || profile.seller_id),
    login_email: profile.login_email ? String(profile.login_email) : null,
    auth_enabled: Boolean(profile.auth_enabled),
    verification_status: String(profile.verification_status || "approved"),
    settlement_status: String(profile.settlement_status || "active"),
    payout_method: String(profile.payout_method || "bank_transfer"),
    payout_details_masked: String(profile.payout_details_masked || ""),
    admin_note: String(profile.admin_note || ""),
    created_at: String(profile.created_at || ""),
    updated_at: String(profile.updated_at || ""),
    last_login_at: profile.last_login_at ? String(profile.last_login_at) : null,
    is_default_context: String(profile.seller_id) === DEFAULT_SELLER_ID,
    context_source: contextSource
  };
}

async function findSellerLoginAccount(c: any, identifier: string) {
  const normalizedIdentifier = String(identifier || "").trim();
  if (!normalizedIdentifier) return null;
  const sellerId = normalizeSellerId(normalizedIdentifier);
  const loginEmail = normalizeSellerLoginEmail(normalizedIdentifier);
  const result = await c.query(
    `SELECT seller_id, display_name, login_email, auth_secret_hash, auth_enabled,
            verification_status, settlement_status, payout_method, payout_details_masked,
            admin_note, created_at, updated_at, last_login_at
     FROM siton.seller_accounts
     WHERE seller_id = $1
        OR ($2 <> '' AND lower(login_email) = $2)
     LIMIT 1`,
    [sellerId, loginEmail]
  );
  return result.rowCount ? (result.rows[0] as any) : null;
}

async function issueSellerSession(c: any, req: any, sellerProfile: any) {
  const token = createSellerSessionToken();
  const tokenHash = hashSellerSessionToken(token, SELLER_SESSION_SECRET);
  const expiresAt = new Date(Date.now() + SELLER_SESSION_TTL_SECONDS * 1000).toISOString();
  const ip = requestClientIp(req);
  const userAgent = requestUserAgent(req);
  const session = await c.query(
    `INSERT INTO siton.seller_sessions (
       seller_id, token_hash, expires_at, last_seen_at, created_ip, created_user_agent
     )
     VALUES ($1, $2, $3, now(), $4, $5)
     RETURNING session_id, expires_at, last_seen_at`,
    [String(sellerProfile.seller_id), tokenHash, expiresAt, ip, userAgent]
  );
  await c.query(
    `UPDATE siton.seller_accounts
     SET last_login_at = now(),
         last_login_ip = $2,
         last_login_user_agent = $3,
         updated_at = now()
     WHERE seller_id = $1`,
    [String(sellerProfile.seller_id), ip, userAgent]
  );
  return {
    token,
    session_id: String(session.rows[0].session_id),
    expires_at: String(session.rows[0].expires_at),
    last_seen_at: String(session.rows[0].last_seen_at)
  };
}

async function readSellerSessionContext(req: any, c: any) {
  if (!SELLER_AUTH_CONFIGURED || !SELLER_SESSION_SECRET) return null;
  const cookies = parseCookies(req.headers?.cookie);
  const rawToken = String(cookies[SELLER_SESSION_COOKIE] || "").trim();
  const tokenHash = hashSellerSessionToken(rawToken, SELLER_SESSION_SECRET);
  if (!tokenHash) return null;

  const result = await c.query(
    `SELECT s.session_id,
            s.expires_at,
            s.last_seen_at,
            a.seller_id,
            a.display_name,
            a.login_email,
            a.auth_enabled,
            a.verification_status,
            a.settlement_status,
            a.payout_method,
            a.payout_details_masked,
            a.admin_note,
            a.created_at,
            a.updated_at,
            a.last_login_at
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

  const row = result.rows[0] as any;
  const lastSeenAt = row.last_seen_at ? new Date(String(row.last_seen_at)).getTime() : 0;
  if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt > 60_000) {
    await c.query(
      `UPDATE siton.seller_sessions
       SET last_seen_at = now()
       WHERE session_id = $1`,
      [String(row.session_id)]
    );
    row.last_seen_at = new Date().toISOString();
  }

  return {
    ...mapSellerProfile(row, "server_session"),
    session_id: String(row.session_id),
    expires_at: String(row.expires_at),
    last_seen_at: String(row.last_seen_at)
  };
}

async function revokeSellerSession(c: any, req: any, reason: string) {
  if (!SELLER_SESSION_SECRET) return;
  const cookies = parseCookies(req.headers?.cookie);
  const rawToken = String(cookies[SELLER_SESSION_COOKIE] || "").trim();
  const tokenHash = hashSellerSessionToken(rawToken, SELLER_SESSION_SECRET);
  if (!tokenHash) return;
  await c.query(
    `UPDATE siton.seller_sessions
     SET revoked_at = now(),
         revoked_reason = $2
     WHERE token_hash = $1
       AND revoked_at IS NULL`,
    [tokenHash, String(reason || "logout").slice(0, 120)]
  );
}

async function resolveSellerContext(req: any, c: any, options?: { autoCreate?: boolean }) {
  const headerSellerId = req.headers?.["x-seller-id"];
  const headerSellerDisplayName = req.headers?.["x-seller-display-name"];
  const querySellerId = req.query?.seller_id;
  const querySellerDisplayName = req.query?.seller_display_name;
  const requestedSellerId = normalizeSellerId(headerSellerId || querySellerId || DEFAULT_SELLER_ID);
  const requestedDisplayName = normalizeSellerDisplayName(
    headerSellerDisplayName || querySellerDisplayName,
    requestedSellerId
  );

  const existing = await c.query(
    `SELECT seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked, admin_note, created_at, updated_at
     FROM siton.seller_accounts
     WHERE seller_id = $1
     LIMIT 1`,
    [requestedSellerId]
  );

  const profile =
    existing.rowCount || options?.autoCreate
      ? existing.rowCount
        ? existing.rows[0]
        : await ensureSellerAccount(c, requestedSellerId, requestedDisplayName)
      : await ensureSellerAccount(c, DEFAULT_SELLER_ID, requestedDisplayName);

  return {
    seller_id: String(profile.seller_id),
    display_name: String(profile.display_name || profile.seller_id),
    verification_status: String(profile.verification_status || "approved"),
    settlement_status: String(profile.settlement_status || "active"),
    payout_method: String(profile.payout_method || "bank_transfer"),
    payout_details_masked: String(profile.payout_details_masked || ""),
    admin_note: String(profile.admin_note || ""),
    created_at: String(profile.created_at || ""),
    updated_at: String(profile.updated_at || ""),
    is_default_context: String(profile.seller_id) === DEFAULT_SELLER_ID,
    context_source:
      requestedSellerId === DEFAULT_SELLER_ID && !(headerSellerId || querySellerId)
        ? "default_fallback"
        : existing.rowCount || options?.autoCreate
          ? "explicit"
          : "default_fallback"
  };
}

function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function otpSessionId(phone: string) {
  return createHash("sha256")
    .update(`${phone}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 24);
}

function generateOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function requireUuid(value: string, fieldName: string) {
  if (!isUuid(value)) {
    const err: any = new Error(`${fieldName} must be a valid uuid`);
    err.statusCode = 400;
    throw err;
  }
}

function deriveDealAvailability(state: DealState, remainingUnits: number) {
  if (remainingUnits <= 0) {
    return {
      canJoin: false,
      reasonCode: "stock_exhausted",
      badge: "מלאי אזל",
      message: "הכמות המבוקשת בעסקה כבר נתפסה. אפשר לעקוב, אבל כרגע אי אפשר להצטרף."
    };
  }

  if (state === "PendingTarget") {
    return {
      canJoin: true,
      reasonCode: "open",
      badge: "פתוח להצטרפות",
      message: "אפשר להצטרף עכשיו. כרגע תתבצע רק תפיסת מסגרת, לא חיוב."
    };
  }

  if (state === "TargetReached") {
    return {
      canJoin: true,
      reasonCode: "target_reached_still_open",
      badge: "היעד הושג",
      message: "היעד כבר הושג, אבל ההצטרפות עדיין פתוחה עד סגירת החלון."
    };
  }

  if (state === "Draft") {
    return {
      canJoin: false,
      reasonCode: "draft",
      badge: "טיוטה",
      message: "העסקה עדיין לא פורסמה ולכן אינה זמינה להצטרפות."
    };
  }

  if (state === "Cancelled") {
    return {
      canJoin: false,
      reasonCode: "cancelled",
      badge: "בוטלה",
      message: "העסקה בוטלה ואין אפשרות להצטרף אליה."
    };
  }

  if (state === "Failed") {
    return {
      canJoin: false,
      reasonCode: "failed",
      badge: "נכשלה",
      message: "העסקה נכשלה ואין אפשרות להצטרף אליה."
    };
  }

  if (state === "Completed") {
    return {
      canJoin: false,
      reasonCode: "completed",
      badge: "הושלמה",
      message: "העסקה כבר הושלמה בהצלחה ולכן סגורה להצטרפות חדשה."
    };
  }

  if (state === "CompletionWindow") {
    return {
      canJoin: false,
      reasonCode: "completion_window",
      badge: "חלון השלמה",
      message: "העסקה נמצאת בחלון השלמה. לא ניתן להצטרף כרגע, אבל אפשר לעקוב אחרי הסטטוס."
    };
  }

  return {
    canJoin: false,
    reasonCode: "closed",
    badge: "סגורה להצטרפות",
    message: "העסקה כבר עברה לשלב שבו לא ניתן להצטרף."
  };
}

function deriveTrackingCopy(dealState: DealState, buyerState: BuyerState, moneyState: MoneyState) {
  if (dealState === "Completed" && (buyerState === "DealCompleted" || buyerState === "Recovered")) {
    return {
      headline: "העסקה הושלמה",
      subline: "העסקה נסגרה בהצלחה והחיוב בוצע בפועל.",
      tone: "success"
    };
  }

  if (dealState === "Failed" || buyerState === "DealFailed") {
    return {
      headline: "העסקה לא הושלמה",
      subline:
        moneyState === "Refunded"
          ? "העסקה נכשלה והחיוב בוטל או הוחזר."
          : "העסקה נכשלה. המערכת שחררה או תסיים לשחרר את תפיסת המסגרת לפי הסטטוס.",
      tone: "danger"
    };
  }

  if (dealState === "CompletionWindow") {
    return {
      headline: "העסקה בחלון השלמה",
      subline: "תפיסת המסגרת קיימת. החיוב בפועל ייקבע לפי תוצאות חלון ההשלמה.",
      tone: "warning"
    };
  }

  if (moneyState === "AuthHeld" || moneyState === "AuthLocked") {
    return {
      headline: "התפיסה נקלטה",
      subline: "תפיסת המסגרת הושלמה. החיוב בפועל יתבצע רק אם העסקה תיסגר בהצלחה.",
      tone: "info"
    };
  }

  if (moneyState === "ChargedSuccess" || moneyState === "RecoveredCharge") {
    return {
      headline: "החיוב בוצע",
      subline: "העסקה התקדמה לשלב שבו בוצע חיוב בפועל.",
      tone: "success"
    };
  }

  return {
    headline: "ההצטרפות נקלטה",
    subline: "העסקה עדיין בתהליך. אפשר להישאר במסך המעקב ולקבל את הסטטוס המעודכן.",
    tone: "info"
  };
}

function mapDealListRow(row: DealListRow) {
  const joinedUnits = Number(row.joined_units || 0);
  const participantsCount = Number(row.participants_count || 0);
  const maxUnits = Number(row.max_units || 0);
  const thresholdUnits = Number(row.threshold_units || 0);
  const remainingUnits = Math.max(0, maxUnits - joinedUnits);
  return {
    deal_id: row.deal_id,
    seller_id: row.seller_id ?? DEFAULT_SELLER_ID,
    title: row.title,
    state: row.state,
    price_per_unit: Number(row.price_per_unit),
    min_units: Number(row.min_units),
    max_units: maxUnits,
    threshold_units: thresholdUnits,
    deadline: row.deadline,
    published_at: row.published_at,
    completion_window_until: row.completion_window_until,
    created_at: row.created_at,
    platform_fee_rate: Number(row.platform_fee_rate || 0.08),
    metrics: {
      joined_units: joinedUnits,
      remaining_units: remainingUnits,
      participants_count: participantsCount,
      progress_to_target_pct: Number(Math.min(100, Math.round((joinedUnits / Math.max(1, thresholdUnits)) * 100))),
      progress_to_capacity_pct: Number(Math.min(100, Math.round((joinedUnits / Math.max(1, maxUnits)) * 100)))
    },
    availability: deriveDealAvailability(row.state, remainingUnits)
  };
}

function receiptEligible(dealState: DealState, moneyState: string) {
  return dealState === "Completed" && isChargedMoneyState(moneyState);
}

function deliveryEligible(dealState: DealState, moneyState: string) {
  return dealState === "Completed" && isChargedMoneyState(moneyState);
}

function deriveBuyerDocumentVisibility(args: {
  dealState: DealState;
  buyerState: BuyerState;
  moneyState: MoneyState;
  invoiceDocument?: {
    document_id?: string | null;
    status?: string | null;
    provider_document_id?: string | null;
    issued_at?: string | null;
  } | null;
}) {
  const { dealState, buyerState, moneyState, invoiceDocument } = args;
  const normalizedStatus = String(invoiceDocument?.status || "").trim().toLowerCase();
  if (normalizedStatus === "issued" && invoiceDocument?.document_id) {
    return {
      state: "issued",
      eligible: true,
      document_id: invoiceDocument.document_id,
      provider_document_id: invoiceDocument.provider_document_id ?? null,
      issued_at: invoiceDocument.issued_at ?? null
    };
  }

  if (normalizedStatus === "pending" || normalizedStatus === "processing") {
    return {
      state: "pending_issue",
      eligible: true,
      document_id: null,
      provider_document_id: invoiceDocument?.provider_document_id ?? null,
      issued_at: null
    };
  }

  if (normalizedStatus === "failed") {
    return {
      state: "issue_failed",
      eligible: true,
      document_id: null,
      provider_document_id: invoiceDocument?.provider_document_id ?? null,
      issued_at: null
    };
  }

  if (receiptEligible(dealState, moneyState)) {
    return {
      state: "pending_issue",
      eligible: true,
      document_id: null,
      provider_document_id: null,
      issued_at: null
    };
  }

  if (
    dealState === "Failed" ||
    dealState === "Cancelled" ||
    moneyState === "AuthReleased" ||
    buyerState === "Dropped"
  ) {
    return {
      state: "not_expected",
      eligible: false,
      document_id: null,
      provider_document_id: null,
      issued_at: null
    };
  }

  return {
    state: "not_available_yet",
    eligible: false,
    document_id: null,
    provider_document_id: null,
    issued_at: null
  };
}

async function sendFrontendFile(reply: FastifyReply, filename: string, contentType: string) {
  const content = await readFile(join(frontendDir, filename), "utf8");
  return reply.type(contentType).send(content);
}

export function registerFrontendExperience(
  app: FastifyInstance,
  deps: {
    withTx: WithTx;
    paymentProvider: PaymentProvider;
    payoutProvider?: PayoutProvider;
    payoutRail?: {
      payoutStatusSummary: () => Promise<any>;
      getBatchProfile: (payoutBatchId: string) => Promise<any>;
      summarizeSellerReadiness: (sellerId: string) => Promise<any>;
      getDealPayoutSummary: (dealId: string) => Promise<any>;
    };
    deploymentMode: string;
    isDemoPreview: boolean;
    notificationSummary: {
      provider: string;
      mode: string;
      external_delivery: boolean;
    };
    invoiceSummary?: {
      provider: string;
      mode: string;
      external_issuance: boolean;
    };
    debugSurfacesEnabled?: boolean;
    /** Returns current workerRunning flag so the outbox-status endpoint can surface it. */
    getWorkerRunning?: () => boolean;
    /** WORKER_STUCK_TIMEOUT_MS used by reclaimStuckProcessing — exposed so the status endpoint can show stuck_candidates correctly. */
    workerStuckTimeoutMs?: number;
    applyPaymentWebhookClassification?: (args: {
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
      target: any;
      classification: {
        status: "processed" | "ignored" | "failed";
        reason: string;
      };
    }) => Promise<void>;
  }
) {
  const ensureProductSurfaces = () => ensureRemainingProductSurfaceTables(deps.withTx);
  const ensurePayoutTables = () => ensurePayoutRailTables(deps.withTx);
  const payoutProvider = deps.payoutProvider ?? buildPayoutProvider();
  const operationalReadiness = () =>
    buildOperationalReadinessSummary({
      deploymentMode: deps.deploymentMode,
      isDemoPreview: deps.isDemoPreview,
      payment: getPaymentProviderSummary(deps.paymentProvider),
      payout: getPayoutProviderSummary(payoutProvider),
      notifications: deps.notificationSummary,
      debugSurfacesEnabled: Boolean(deps.debugSurfacesEnabled),
      webhookSecretSafe: PAYMENT_WEBHOOK_SECRET_IS_SAFE,
      webhookSecretIsDefault: PAYMENT_WEBHOOK_SECRET_IS_DEFAULT,
      sellerAuthMode: deps.isDemoPreview ? "demo-context" : "server-session",
      sellerAuthConfigured: deps.isDemoPreview ? true : SELLER_AUTH_CONFIGURED
    });

  // Webhook ingestion + reconciliation helpers (used by /webhooks/payments)
  const webhookIngestion = buildWebhookIngestion({ withTx: deps.withTx });
  const paymentReconciliation = buildPaymentReconciliation({ withTx: deps.withTx });

  /**
   * Verify HMAC-SHA256 webhook signature.
   * Only enforced when PAYMENT_WEBHOOK_SECRET is a real (non-demo) secret.
   * Compares using timingSafeEqual to prevent timing attacks.
   * Also validates x-webhook-timestamp header (Unix seconds) against a 5-minute
   * replay window to prevent replay attacks.
   */
  const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  function verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined
  ): boolean {
    if (!PAYMENT_WEBHOOK_SECRET_IS_SAFE || !PAYMENT_WEBHOOK_SECRET) {
      // Demo/dev mode — skip verification
      return true;
    }
    if (!signatureHeader) return false;

    // Replay protection: reject requests older than 5 minutes or with future timestamps
    if (timestampHeader) {
      const ts = Number(timestampHeader);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > WEBHOOK_REPLAY_WINDOW_MS) {
        return false;
      }
    }

    try {
      // Include timestamp in the signed payload when present (prevents replay without timestamp)
      const signingInput = timestampHeader ? `${timestampHeader}.${rawBody}` : rawBody;
      const expected = createHmac("sha256", PAYMENT_WEBHOOK_SECRET).update(signingInput).digest("hex");
      const expectedBuf = Buffer.from(expected, "hex");
      const providedBuf = Buffer.from(signatureHeader.replace(/^sha256=/, ""), "hex");
      if (expectedBuf.length !== providedBuf.length) return false;
      return timingSafeEqual(expectedBuf, providedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Admin API key guard.
   * If ADMIN_API_KEY env var is set, all /api/admin/* routes require the
   * x-admin-key header to match. Empty key = open access (demo/dev).
   */
  function requireAdminKey(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!ADMIN_API_KEY) return true; // No key configured — open access
    const provided = String((req.headers as Record<string, string | undefined>)["x-admin-key"] || "").trim();
    if (!provided) {
      void reply.code(401).send({ error: "admin_auth_required", message: "x-admin-key header is missing or invalid" });
      return false;
    }
    // Timing-safe comparison to prevent key-length oracle attacks
    const expectedBuf = Buffer.from(ADMIN_API_KEY, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      void reply.code(401).send({ error: "admin_auth_required", message: "x-admin-key header is missing or invalid" });
      return false;
    }
    return true;
  }

  function sellerAuthSummary(sellerContext?: any) {
    return {
      mode: deps.isDemoPreview ? "demo-context" : SELLER_AUTH_MODE,
      configured: deps.isDemoPreview ? true : SELLER_AUTH_CONFIGURED,
      authenticated: deps.isDemoPreview ? true : Boolean(sellerContext),
      allow_manual_context_switch: deps.isDemoPreview,
      seller_context: sellerContext
        ? {
            seller_id: sellerContext.seller_id,
            display_name: sellerContext.display_name,
            login_email: sellerContext.login_email ?? null,
            verification_status: sellerContext.verification_status,
            settlement_status: sellerContext.settlement_status,
            is_default_context: sellerContext.is_default_context,
            context_source: sellerContext.context_source,
            session_id: sellerContext.session_id ?? null,
            expires_at: sellerContext.expires_at ?? null,
            last_seen_at: sellerContext.last_seen_at ?? null
          }
        : null
    };
  }

  function rejectSellerAuthUnavailable(reply: FastifyReply) {
    return reply.code(503).send({
      error: "seller_auth_unavailable",
      message: "seller auth is not configured for this non-demo runtime"
    });
  }

  function rejectSellerAuthRequired(reply: FastifyReply) {
    return reply.code(401).send({
      error: "seller_auth_required",
      message: "seller session is required for this non-demo runtime"
    });
  }

  function rejectManualSellerContextSwitch(reply: FastifyReply) {
    return reply.code(403).send({
      error: "seller_context_switch_disabled",
      message: "manual seller context switching is disabled outside demo-preview"
    });
  }

  async function resolveOptionalSellerContext(req: any, c: any, options?: { autoCreate?: boolean }) {
    if (deps.isDemoPreview) return resolveSellerContext(req, c, options);
    if (!SELLER_AUTH_CONFIGURED || !SELLER_SESSION_SECRET) return null;
    return readSellerSessionContext(req, c);
  }

  async function resolveRequiredSellerContext(req: any, reply: FastifyReply, c: any, options?: { autoCreate?: boolean }) {
    if (deps.isDemoPreview) return resolveSellerContext(req, c, options);
    if (!SELLER_AUTH_CONFIGURED || !SELLER_SESSION_SECRET) {
      rejectSellerAuthUnavailable(reply);
      return null;
    }
    const sellerContext = await readSellerSessionContext(req, c);
    if (!sellerContext) {
      rejectSellerAuthRequired(reply);
      return null;
    }
    return sellerContext;
  }

  app.get("/api/preview/meta", async () => ({
    ok: true,
    preview: {
      deployment_mode: deps.deploymentMode,
      is_demo_preview: deps.isDemoPreview,
      public_label: deps.isDemoPreview ? "Demo / Preview" : "Configured runtime",
      guardrails: {
        payment_is_real: false,
        invoice_is_real: false,
        shipping_is_real: false,
        payout_is_real: false,
        kyc_is_real: false,
        notifications_are_real: deps.notificationSummary.external_delivery
      },
      notes: [
        deps.isDemoPreview
          ? "This environment is intended for live showcase and preview only."
          : "This runtime is configured, but the external rails still need separate production activation work.",
        operationalReadiness().payment_provider.what_is_mock,
        deps.notificationSummary.external_delivery
          ? "Notification delivery is externally active."
          : "Notifications remain log-only in this environment."
      ],
      seller_auth: sellerAuthSummary(),
      operational_readiness: operationalReadiness()
    }
  }));

  app.get("/api/seller/session", async (req: any, reply: any) => {
    return deps.withTx(async (c) => {
      await ensureProductSurfaces();
      const sellerContext = await resolveOptionalSellerContext(req, c, { autoCreate: true });
      if (!deps.isDemoPreview && !SELLER_AUTH_CONFIGURED) {
        return reply.code(503).send({
          ok: false,
          seller_auth: sellerAuthSummary(),
          error: "seller_auth_unavailable",
          message: "seller auth is not configured for this non-demo runtime"
        });
      }
      return {
        ok: true,
        seller_auth: sellerAuthSummary(sellerContext)
      };
    });
  });

  app.post("/api/seller/session/login", async (req: any, reply: any) => {
    if (deps.isDemoPreview) {
      return reply.code(409).send({
        ok: false,
        error: "seller_auth_not_needed_in_demo",
        message: "demo-preview uses explicit seller context switching instead of seller login"
      });
    }
    if (!SELLER_AUTH_CONFIGURED || !SELLER_SESSION_SECRET) {
      return rejectSellerAuthUnavailable(reply);
    }

    return deps.withTx(async (c) => {
      await ensureProductSurfaces();
      const identifier = String(req.body?.identifier || req.body?.seller_id || req.body?.login_email || "").trim();
      const accessCode = String(req.body?.access_code || req.body?.password || "").trim();
      const sellerAccount = await findSellerLoginAccount(c, identifier);
      if (!sellerAccount || !sellerAccount.auth_enabled || !verifySellerAccessSecret(accessCode, sellerAccount.auth_secret_hash)) {
        return reply.code(401).send({
          ok: false,
          error: "seller_auth_invalid_credentials",
          message: "seller identifier or password is invalid"
        });
      }
      if (String(sellerAccount.verification_status || "") === "rejected" || String(sellerAccount.settlement_status || "") === "hold") {
        return reply.code(403).send({
          ok: false,
          error: "seller_auth_blocked",
          message: "seller account is blocked from login"
        });
      }
      const session = await issueSellerSession(c, req, sellerAccount);
      reply.header("set-cookie", serializeSellerSessionCookie(session.token, SELLER_SESSION_TTL_SECONDS));
      const sellerContext = {
        ...mapSellerProfile(sellerAccount, "server_session"),
        session_id: session.session_id,
        expires_at: session.expires_at,
        last_seen_at: session.last_seen_at
      };
      return {
        ok: true,
        seller_auth: sellerAuthSummary(sellerContext)
      };
    });
  });

  app.post("/api/seller/session/logout", async (req: any, reply: any) => {
    if (!deps.isDemoPreview && SELLER_AUTH_CONFIGURED) {
      await deps.withTx(async (c) => {
        await ensureProductSurfaces();
        await revokeSellerSession(c, req, "logout");
      });
    }
    reply.header("set-cookie", serializeExpiredSellerSessionCookie());
    return {
      ok: true,
      seller_auth: sellerAuthSummary()
    };
  });

  app.get("/api/site/home", async (req: any) => {
    return deps.withTx(async (c) => {
      await ensureProductSurfaces();
      const sellerContext = await resolveOptionalSellerContext(req, c, { autoCreate: true });
      const totals = await c.query(
        `SELECT
           COUNT(*)::int AS total_deals,
           COUNT(*) FILTER (WHERE state IN ('PendingTarget','TargetReached','ClosedForJoining','ReadyForCharging','Charging','CompletionWindow'))::int AS live_deals,
           COUNT(*) FILTER (WHERE state = 'Completed')::int AS completed_deals,
           COUNT(*) FILTER (WHERE state IN ('Failed','Cancelled'))::int AS failed_or_cancelled
         FROM siton.deals`
      );

      const row = totals.rows[0] as any;
      return {
        ok: true,
        site: {
          brand: "Siton",
          product_direction: "link-first-group-deals",
          positioning:
            "Commercial main site for opening a deal, publishing a personal deal page, and sharing a direct buyer link.",
          buyer_entry_note:
            "Buyers should enter through a direct deal link that the seller shares directly with them.",
          seller_entry: {
            create_deal_url: "/app/seller/new",
            manage_deals_url: "/app/seller"
          },
          seller_context: sellerContext
            ? {
                seller_id: sellerContext.seller_id,
                display_name: sellerContext.display_name,
                verification_status: sellerContext.verification_status,
                settlement_status: sellerContext.settlement_status,
                is_default_context: sellerContext.is_default_context,
                context_source: sellerContext.context_source
              }
            : null,
          seller_auth: sellerAuthSummary(sellerContext),
          core_surfaces: [
            "אתר מותג ודף פתיחה למוכרים",
            "יצירת עסקה וניהול עסקה למוכר",
            "דף עסקה ציבורי מבוסס לינק",
            "מסלול הצטרפות קונה עם אימות והרשאה",
            "מסך מעקב לקונה",
            "ניהול בסיסי לעסקאות מוכר"
          ],
          proof_points: {
            total_deals: Number(row.total_deals || 0),
            live_deals: Number(row.live_deals || 0),
            completed_deals: Number(row.completed_deals || 0),
            failed_or_cancelled: Number(row.failed_or_cancelled || 0)
          }
        }
      };
    });
  });

  app.get("/api/seller/context", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply as any, c, { autoCreate: true });
      if (!sellerContext) return reply;
      return {
        ok: true,
        seller_context: {
          ...sellerContext,
          workspace_url: "/app/seller",
          create_deal_url: "/app/seller/new"
        }
      };
    });
  });

  app.post("/api/seller/context", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    if (!deps.isDemoPreview) {
      return rejectManualSellerContextSwitch(reply);
    }
    return deps.withTx(async (c) => {
      const sellerId = normalizeSellerId(req.body?.seller_id || req.headers?.["x-seller-id"] || DEFAULT_SELLER_ID);
      const displayName = normalizeSellerDisplayName(
        req.body?.display_name || req.headers?.["x-seller-display-name"],
        sellerId
      );
      const profile = await ensureSellerAccount(c, sellerId, displayName);
      return {
        ok: true,
        seller_context: {
          seller_id: String(profile.seller_id),
          display_name: String(profile.display_name || profile.seller_id),
          verification_status: String(profile.verification_status || "approved"),
          settlement_status: String(profile.settlement_status || "active"),
          is_default_context: String(profile.seller_id) === DEFAULT_SELLER_ID,
          context_source: "explicit",
          workspace_url: "/app/seller",
          create_deal_url: "/app/seller/new"
        },
        seller_auth: sellerAuthSummary({
          seller_id: String(profile.seller_id),
          display_name: String(profile.display_name || profile.seller_id),
          verification_status: String(profile.verification_status || "approved"),
          settlement_status: String(profile.settlement_status || "active"),
          is_default_context: String(profile.seller_id) === DEFAULT_SELLER_ID,
          context_source: "explicit"
        })
      };
    });
  });

  app.get("/api/deals/:id/public", async (req: any) => {
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");

    return deps.withTx(async (c) => {
      await ensureProductSurfaces();
      const dealResult = await c.query(
        `SELECT deal_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until, created_at
         FROM siton.deals
         WHERE deal_id=$1`,
        [dealId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const aggregate = await c.query(
        `SELECT COALESCE(SUM(qty),0) AS joined_units, COUNT(*)::int AS participants_count
         FROM siton.participants
         WHERE deal_id=$1`,
        [dealId]
      );
      const deliveryOptions = await c.query(
        `SELECT option_id, option_type, label, cost, sort_order
         FROM siton.deal_delivery_options
         WHERE deal_id=$1
         ORDER BY sort_order ASC, created_at ASC`,
        [dealId]
      );

      const deal = dealResult.rows[0] as {
        deal_id: string;
        title: string;
        state: DealState;
        price_per_unit: number;
        min_units: number;
        max_units: number;
        threshold_units: number;
        deadline: string;
        published_at: string | null;
        completion_window_until: string | null;
        created_at: string;
      };

      const joinedUnits = Number(aggregate.rows[0].joined_units || 0);
      const participantsCount = Number(aggregate.rows[0].participants_count || 0);
      const remainingUnits = Math.max(0, Number(deal.max_units) - joinedUnits);
      const availability = deriveDealAvailability(deal.state, remainingUnits);

      return {
        ok: true,
        deal: {
          deal_id: deal.deal_id,
          title: deal.title,
          state: deal.state,
          price_per_unit: Number(deal.price_per_unit),
          min_units: Number(deal.min_units),
          max_units: Number(deal.max_units),
          threshold_units: Number(deal.threshold_units),
          deadline: deal.deadline,
          published_at: deal.published_at,
          completion_window_until: deal.completion_window_until,
          created_at: deal.created_at,
          delivery_options: deliveryOptions.rows.map((row: any) => ({
            option_id: row.option_id,
            option_type: row.option_type,
            label: row.label,
            cost: Number(row.cost || 0),
            sort_order: Number(row.sort_order || 0)
          }))
        },
        metrics: {
          joined_units: joinedUnits,
          remaining_units: remainingUnits,
          participants_count: participantsCount,
          progress_to_target_pct: Number(
            Math.min(100, Math.round((joinedUnits / Math.max(1, Number(deal.threshold_units))) * 100))
          ),
          progress_to_capacity_pct: Number(
            Math.min(100, Math.round((joinedUnits / Math.max(1, Number(deal.max_units))) * 100))
          )
        },
        availability
      };
    });
  });

  app.get("/api/seller/deals", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;
      const result = await c.query(
        `SELECT
           d.deal_id,
           COALESCE(d.seller_id, $1) AS seller_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           0.08::numeric AS platform_fee_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         WHERE COALESCE(d.seller_id, $1) = $1
         GROUP BY d.deal_id
         ORDER BY d.created_at DESC
         LIMIT 100`,
        [sellerId]
      );

      const deals = (result.rows as DealListRow[]).map(mapDealListRow);
      return {
        ok: true,
        seller_surface: {
          seller_profile: sellerContext,
          seller_auth: sellerAuthSummary(sellerContext),
          deals,
          totals: {
            total_deals: deals.length,
            live_deals: deals.filter((deal) => ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"].includes(deal.state)).length,
            completed_deals: deals.filter((deal) => deal.state === "Completed").length,
            failed_or_cancelled: deals.filter((deal) => ["Failed", "Cancelled"].includes(deal.state)).length
          }
        }
      };
    });
  });

  app.get("/api/seller/deals/:id", async (req: any, reply: any) => {
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;
      const dealResult = await c.query(
        `SELECT
           d.deal_id,
           COALESCE(d.seller_id, $2) AS seller_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           0.08::numeric AS platform_fee_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         WHERE d.deal_id = $1
           AND COALESCE(d.seller_id, $2) = $2
         GROUP BY d.deal_id`,
        [dealId, sellerId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const participants = await c.query(
        `SELECT participant_id, buyer_id, qty, buyer_state, money_state, created_at,
                delivery_method_type, delivery_method_label, delivery_cost
         FROM siton.participants
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [dealId]
      );
      const deliveryOptions = await c.query(
        `SELECT option_id, option_type, label, cost, sort_order
         FROM siton.deal_delivery_options
         WHERE deal_id = $1
         ORDER BY sort_order ASC, created_at ASC`,
        [dealId]
      );

      const attempts = await c.query(
        `SELECT attempt_type, correlation_id, result_class, created_at
         FROM siton.payment_attempts
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [dealId]
      );

      const attributions = await c.query(
        `SELECT aa.participant_id,
                aa.share_code,
                af.display_name AS affiliate_name,
                af.verification_status
         FROM siton.affiliate_attributions aa
         JOIN siton.affiliate_accounts af ON af.affiliate_id = aa.affiliate_id
         WHERE aa.deal_id = $1`,
        [dealId]
      );

      const deliveries = await c.query(
        `SELECT participant_id, status, tracking_number, issue_note, updated_at
         FROM siton.delivery_records
         WHERE deal_id = $1
         ORDER BY updated_at DESC`,
        [dealId]
      );

      const invoiceDocuments = await c.query(
        `SELECT document_id, participant_id, status, document_type, provider_document_id,
                issued_at, created_at, gross_amount, money_state_at_issue
         FROM siton.invoice_documents
         WHERE deal_id = $1
         ORDER BY created_at DESC`,
        [dealId]
      );

      const deal = mapDealListRow(dealResult.rows[0] as DealListRow);
      const attributionByParticipant = new Map(
        attributions.rows.map((row: any) => [String(row.participant_id), row])
      );
      const deliveryByParticipant = new Map(
        deliveries.rows.map((row: any) => [String(row.participant_id), row])
      );
      const invoiceByParticipant = new Map<string, any>();
      for (const row of invoiceDocuments.rows) {
        const key = String(row.participant_id || "");
        if (!key || invoiceByParticipant.has(key)) continue;
        invoiceByParticipant.set(key, row);
      }

      const fulfilledParticipants = participants.rows
        .filter((row: any) => receiptEligible(deal.state, String(row.money_state)))
        .map((row: any) => {
          const attribution = attributionByParticipant.get(String(row.participant_id)) as any;
          const invoiceDocument = invoiceByParticipant.get(String(row.participant_id)) as any;
          // Fee base = actual collected amount (price × qty + delivery).
          const grossAmount = Number(row.qty) * Number(deal.price_per_unit) + Number(row.delivery_cost || 0);
          return {
            participant_id: row.participant_id,
            buyer_id: row.buyer_id,
            qty: Number(row.qty),
            money_state: row.money_state,
            buyer_state: row.buyer_state,
            gross_amount: grossAmount,
            delivery_cost: Number(row.delivery_cost || 0),
            document_id: invoiceDocument?.document_id ?? null,
            document_status: invoiceDocument?.status ?? "not_issued",
            issued_at: invoiceDocument?.issued_at ?? null,
            provider_document_id: invoiceDocument?.provider_document_id ?? null,
            share_code: attribution?.share_code ?? null,
            affiliate_name: attribution?.affiliate_name ?? null
          };
        });

      const financialSummary = summarizeMoney({
        grossAmount: fulfilledParticipants.reduce(
          (sum: number, row: any) => sum + Number(row.gross_amount || 0),
          0
        ),
        commissionRate: 0.08
      });

      const deliveryRows = participants.rows
        .filter((row: any) => deliveryEligible(deal.state, String(row.money_state)))
        .map((row: any) => {
          const delivery = deliveryByParticipant.get(String(row.participant_id)) as any;
          return {
            participant_id: row.participant_id,
            buyer_id: row.buyer_id,
            qty: Number(row.qty),
            money_state: row.money_state,
            status: delivery?.status ?? "ready_to_fulfill",
            tracking_number: delivery?.tracking_number ?? null,
            issue_note: delivery?.issue_note ?? "",
            updated_at: delivery?.updated_at ?? null
          };
        });

      return {
        ok: true,
        deal,
        seller_profile: {
          ...sellerContext,
          direct_link: `/app/deal/${dealId}`
        },
        seller_auth: sellerAuthSummary(sellerContext),
        delivery_options: deliveryOptions.rows.map((row: any) => ({
          option_id: row.option_id,
          option_type: row.option_type,
          label: row.label,
          cost: Number(row.cost || 0),
          sort_order: Number(row.sort_order || 0)
        })),
        participants: participants.rows,
        payment_attempts: attempts.rows,
        receipts_surface: {
          status:
            deal.state === "Completed"
              ? "ready"
              : ["Failed", "Cancelled"].includes(deal.state)
                ? "not_issued"
                : "waiting_for_completion",
          eligible_money_states: ["ChargedSuccess", "RecoveredCharge"],
            note:
              deal.state === "Completed"
              ? "Receipt visibility relies on actual invoice_documents rows. If no document row exists yet, the surface must say that no document was issued yet."
              : "Receipts stay blocked until the deal reaches Completed. Failed or cancelled deals do not issue seller receipts.",
            summary: {
              ...financialSummary,
              receipt_document_count: invoiceDocuments.rows.filter((row: any) => String(row.status) === "issued").length
            },
            documents: fulfilledParticipants
          },
        delivery_surface: {
          status: deal.state === "Completed" ? "ready" : "blocked_until_completed",
          note:
            deal.state === "Completed"
              ? "Only successfully charged or recovered buyers appear in delivery operations. Demo mode records fulfillment intent and tracking semantics, but does not claim live carrier execution."
              : "Delivery operations become active only after a deal completes successfully.",
          rows: deliveryRows
        },
        seller_actions: {
          can_publish: (dealResult.rows[0] as DealListRow).state === "Draft",
          edit_locked: (dealResult.rows[0] as DealListRow).state !== "Draft",
          create_similar_supported: true,
          can_manage_delivery: deal.state === "Completed"
        }
      };
    });
  });

  app.post("/api/seller/deals/:id/delivery/:participantId", async (req: any, reply: any) => {
    const dealId = String(req.params.id);
    const participantId = String(req.params.participantId);
    requireUuid(dealId, "deal_id");
    requireUuid(participantId, "participant_id");
    await ensureProductSurfaces();

    const status = String(req.body?.status || "").trim();
    const trackingNumber = String(req.body?.tracking_number || "").trim();
    const issueNote = String(req.body?.issue_note || "").trim();
    const allowedStatuses = new Set(["ready_to_fulfill", "shipped", "delivered", "issue"]);
    if (!allowedStatuses.has(status)) {
      const err: any = new Error("delivery status is invalid");
      err.statusCode = 400;
      throw err;
    }
    if ((status === "shipped" || status === "delivered") && !trackingNumber) {
      const err: any = new Error("tracking number is required for shipped or delivered status");
      err.statusCode = 400;
      throw err;
    }
    if (status === "issue" && !issueNote) {
      const err: any = new Error("issue note is required when delivery status is issue");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const participant = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.qty, p.money_state, d.state AS deal_state, COALESCE(d.seller_id, $3) AS seller_id
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE p.participant_id = $1 AND p.deal_id = $2`,
        [participantId, dealId, sellerContext.seller_id]
      );

      if (!participant.rowCount) {
        const err: any = new Error("participant not found");
        err.statusCode = 404;
        throw err;
      }

      const row = participant.rows[0] as any;
      if (String(row.seller_id) !== sellerContext.seller_id) {
        const err: any = new Error("seller context does not match the requested deal");
        err.statusCode = 404;
        throw err;
      }
      if (!deliveryEligible(String(row.deal_state) as DealState, String(row.money_state))) {
        const err: any = new Error("delivery update requires completed deal with charged buyer");
        err.statusCode = 409;
        throw err;
      }

      const upserted = await c.query(
        `INSERT INTO siton.delivery_records (
           deal_id, participant_id, status, tracking_number, issue_note
         )
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (participant_id) DO UPDATE
         SET status = EXCLUDED.status,
             tracking_number = EXCLUDED.tracking_number,
             issue_note = EXCLUDED.issue_note,
             updated_at = now()
         RETURNING participant_id, status, tracking_number, issue_note, updated_at`,
        [dealId, participantId, status, trackingNumber || null, issueNote]
      );

      return {
        ok: true,
        delivery: upserted.rows[0]
      };
    });
  });

  app.get("/api/affiliate/overview", async () => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const affiliate = await c.query(
        `SELECT affiliate_id, affiliate_code, display_name, verification_status, admin_note
         FROM siton.affiliate_accounts
         WHERE affiliate_code = $1
         LIMIT 1`,
        [DEFAULT_AFFILIATE_CODE]
      );
      const profile = affiliate.rows[0] as any;

      const campaigns = await c.query(
        `SELECT d.deal_id,
                d.title,
                d.state,
                d.created_at,
                d.published_at,
                COUNT(a.participant_id)::int AS attributed_buyers,
                COALESCE(SUM(p.qty),0) AS attributed_units
         FROM siton.deals d
         LEFT JOIN siton.affiliate_attributions a
           ON a.deal_id = d.deal_id
          AND a.affiliate_id = $1
         LEFT JOIN siton.participants p ON p.participant_id = a.participant_id
         GROUP BY d.deal_id
         ORDER BY d.created_at DESC
         LIMIT 50`,
        [profile.affiliate_id]
      );

      const attributionTotals = await c.query(
        `SELECT
           COUNT(*)::int AS total_attributions,
           COALESCE(SUM(p.qty),0) AS total_units
         FROM siton.affiliate_attributions a
         LEFT JOIN siton.participants p ON p.participant_id = a.participant_id
         WHERE a.affiliate_id = $1`,
        [profile.affiliate_id]
      );
      const totals = attributionTotals.rows[0] as any;

      return {
        ok: true,
        affiliate_surface: {
          attribution_status: totals.total_attributions > 0 ? "active" : "ready_for_attribution",
          display_name: String(profile.display_name || DEFAULT_AFFILIATE_NAME),
          verification_status: profile.verification_status,
          note: "Distributor surfaces are attribution-only. Payment, payout, settlement, and internal compensation flows are not part of the live product model.",
          totals: {
            total_attributions: Number(totals.total_attributions || 0),
            total_units: Number(totals.total_units || 0),
            active_campaigns: campaigns.rows.filter((row: any) => Number(row.attributed_buyers || 0) > 0).length
          },
          verification_surface: {
            status: profile.verification_status,
            admin_note: profile.admin_note || ""
          },
          campaigns: campaigns.rows.map((row: any) => ({
            deal_id: row.deal_id,
            title: row.title,
            state: row.state,
            created_at: row.created_at,
            published_at: row.published_at,
            attributed_buyers: Number(row.attributed_buyers || 0),
            attributed_units: Number(row.attributed_units || 0),
            share_link: `/app/deal/${row.deal_id}?ref=${encodeURIComponent(profile.affiliate_code)}`
          }))
        }
      };
    });
  });

  // ---------------------------------------------------------------------------
  // Webhook ingestion endpoint
  // Receives payment provider callbacks, verifies HMAC, deduplicates, classifies.
  // In mock-backed mode the mock provider never sends real webhooks — this route
  // exists so the system is wired correctly when a live provider is connected.
  // ---------------------------------------------------------------------------
  async function handleWebhookPayments(req: FastifyRequest, reply: FastifyReply) {
    const rawBody = JSON.stringify(req.body); // Fastify has already parsed JSON
    const headers = req.headers as Record<string, string | undefined>;
    const signatureHeader = String(headers["x-webhook-signature"] || "");
    const timestampHeader = String(headers["x-webhook-timestamp"] || "");

    if (!verifyWebhookSignature(rawBody, signatureHeader || undefined, timestampHeader || undefined)) {
      return reply.code(401).send({
        error: "invalid_webhook_signature",
        message: "HMAC signature verification failed"
      });
    }

    const body = req.body as Record<string, unknown>;
    const provider = String(body["provider"] || "unknown");
    const eventId = String(body["event_id"] || "");
    const eventType = String(body["event_type"] || "");

    if (!eventId) {
      return reply.code(400).send({ error: "missing_event_id", message: "event_id is required" });
    }
    if (!eventType) {
      return reply.code(400).send({ error: "missing_event_type", message: "event_type is required" });
    }

    const payload = (body["payload"] as Record<string, unknown> | undefined) ?? {};
    const correlationId = body["correlation_id"] ? String(body["correlation_id"]) : null;
    const participantId = body["participant_id"] ? String(body["participant_id"]) : null;
    const dealId = body["deal_id"] ? String(body["deal_id"]) : null;
    const providerReference = body["provider_reference"]
      ? String(body["provider_reference"])
      : payload["provider_reference"]
        ? String(payload["provider_reference"])
        : null;

    // Ingest (idempotent — duplicate provider+event_id returns existing status)
    const ingested = await webhookIngestion.claimEvent({
      provider,
      event_id: eventId,
      event_type: eventType,
      payload: {
        event_type: eventType,
        correlation_id: correlationId,
        provider_reference: providerReference,
        deal_id: dealId,
        participant_id: participantId,
        payload
      },
      deal_id: dealId,
      participant_id: participantId
    });

    if (ingested.duplicate && !ingested.should_process) {
      return reply.code(200).send({
        ok: true,
        duplicate: true,
        event_id: eventId,
        status: ingested.status
      });
    }

    try {
      const target = await paymentReconciliation.resolveTarget({
        event_id: eventId,
        event_type: eventType,
        correlation_id: correlationId,
        participant_id: participantId,
        deal_id: dealId,
        provider_reference: providerReference,
        payload
      });

      const classification = paymentReconciliation.classifyEvent(eventType, target);

      if (classification.status === "processed" && deps.applyPaymentWebhookClassification) {
        await deps.applyPaymentWebhookClassification({
          event: {
            provider,
            event_id: eventId,
            event_type: eventType,
            correlation_id: correlationId,
            participant_id: participantId,
            deal_id: dealId,
            provider_reference: providerReference,
            payload
          },
          target,
          classification
        });
      }

      await webhookIngestion.markEvent(provider, eventId, classification.status, classification.reason);

      return reply.code(200).send({
        ok: true,
        duplicate: Boolean(ingested.duplicate),
        event_id: eventId,
        status: classification.status,
        reason: classification.reason
      });
    } catch (error) {
      const failureReason = String((error as Error)?.message || error || "webhook_processing_failed").slice(0, 240);
      await webhookIngestion.markEvent(provider, eventId, "failed", failureReason);
      throw error;
    }
  }

  app.post("/webhooks/payments", handleWebhookPayments);
  // Legacy alias kept for backward compatibility with mock provider config
  app.post("/webhooks/payments/mock", handleWebhookPayments);

  // ---------------------------------------------------------------------------
  // Admin routes — protected by requireAdminKey when ADMIN_API_KEY is set
  // ---------------------------------------------------------------------------

  app.get("/api/admin/overview", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    const q = String(req.query?.q || "").trim().slice(0, 200);
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const deals = await c.query(
        `SELECT
           d.deal_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           0.08::numeric AS platform_fee_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COALESCE(SUM(p.delivery_cost),0) AS joined_delivery_cost,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         GROUP BY d.deal_id
         ORDER BY d.created_at DESC
         LIMIT 100`
      );

      const search = q
        ? await c.query(
            `SELECT 'deal' AS entity_type, d.deal_id::text AS entity_id, d.title AS headline, d.state AS state, NULL::text AS detail
             FROM siton.deals d
             WHERE d.deal_id::text ILIKE '%' || $1 || '%' OR d.title ILIKE '%' || $1 || '%'
             UNION ALL
             SELECT 'participant' AS entity_type, p.participant_id::text AS entity_id, p.buyer_id AS headline, p.buyer_state AS state, p.deal_id::text AS detail
             FROM siton.participants p
             WHERE p.participant_id::text ILIKE '%' || $1 || '%' OR p.buyer_id ILIKE '%' || $1 || '%' OR p.deal_id::text ILIKE '%' || $1 || '%'
             ORDER BY entity_type, headline
             LIMIT 30`,
            [q]
          )
        : { rows: [] };

      const kycQueue = await c.query(
        `SELECT 'seller' AS subject_type,
                seller_id AS subject_id,
                display_name,
                verification_status AS status,
                settlement_status AS detail,
                updated_at
         FROM siton.seller_accounts
         ORDER BY updated_at DESC`
      );

      const support = await c.query(
        `SELECT ticket_id, scope_type, scope_key, title, priority, status, summary, created_at, updated_at
         FROM siton.support_tickets
         ORDER BY updated_at DESC
         LIMIT 30`
      );

      const forensics = await c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='ignored') AS ignored_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='pending') AS pending_webhooks,
           (SELECT COUNT(*)::int FROM siton.audit_log WHERE created_at > now() - interval '24 hours') AS recent_audit_events`
      );

      const rows = deals.rows as DealListRow[];
      const completedDeals = rows.filter((row) => row.state === "Completed");
      // Fee base = actual collected amount (price × qty + delivery).
      const sellerSettlementGross = completedDeals.reduce(
        (sum, row) =>
          sum
          + Number(row.price_per_unit || 0) * Number(row.joined_units || 0)
          + Number((row as any).joined_delivery_cost || 0),
        0
      );
      return {
        ok: true,
        q,
        admin_surface: {
          totals: {
            deals: rows.length,
            live: rows.filter((row) => ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"].includes(row.state)).length,
            exceptional: rows.filter((row) => ["Failed", "Cancelled", "Charging", "CompletionWindow"].includes(row.state)).length,
            draft: rows.filter((row) => row.state === "Draft").length
          },
          deals: rows.map(mapDealListRow).slice(0, 20),
          exceptional_deals: rows.filter((row) => ["Failed", "Cancelled", "Charging", "CompletionWindow"].includes(row.state)).map(mapDealListRow).slice(0, 12),
          search_results: search.rows,
          kyc_queue: kycQueue.rows,
          settlements: {
            seller_workspace: {
              completed_deals: completedDeals.length,
              gross_amount: sellerSettlementGross,
              platform_fee_amount: summarizeMoney({
                grossAmount: sellerSettlementGross,
                vatAmount: 0
              }).siton_fee_amount
            }
          },
          support_tickets: support.rows,
          forensics: forensics.rows[0]
        }
      };
    });
  });

  app.post("/api/admin/seller-auth/:sellerId/provision", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensureProductSurfaces();
    const sellerId = normalizeSellerId(req.params?.sellerId);
    const displayName = normalizeSellerDisplayName(req.body?.display_name, sellerId);
    const loginEmail = String(req.body?.login_email || "").trim();
    const normalizedLoginEmail = loginEmail ? normalizeSellerLoginEmail(loginEmail) : "";
    if (loginEmail && !normalizedLoginEmail) {
      const err: any = new Error("login_email is invalid");
      err.statusCode = 400;
      throw err;
    }
    const enableAuth = req.body?.auth_enabled === undefined ? true : Boolean(req.body?.auth_enabled);
    const accessCode = String(req.body?.access_code || "").trim();
    if (enableAuth && !accessCode) {
      const err: any = new Error("access_code is required when enabling seller auth");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const profile = await ensureSellerAccount(c, sellerId, displayName);
      const nextSecretHash = enableAuth ? hashSellerAccessSecret(accessCode) : null;
      const updated = await c.query(
        `UPDATE siton.seller_accounts
         SET login_email = NULLIF($2, ''),
             auth_secret_hash = $3::text,
             auth_enabled = $4,
             auth_secret_updated_at = CASE WHEN $3::text IS NULL THEN auth_secret_updated_at ELSE now() END,
             updated_at = now()
         WHERE seller_id = $1
         RETURNING seller_id, display_name, login_email, auth_enabled, verification_status, settlement_status,
                   payout_method, payout_details_masked, admin_note, created_at, updated_at, last_login_at`,
        [String(profile.seller_id), normalizedLoginEmail, nextSecretHash, enableAuth]
      );
      await c.query(
        `UPDATE siton.seller_sessions
         SET revoked_at = now(),
             revoked_reason = $2
         WHERE seller_id = $1
           AND revoked_at IS NULL`,
        [String(profile.seller_id), enableAuth ? "credentials_rotated" : "auth_disabled"]
      );
      return {
        ok: true,
        seller_auth_subject: {
          ...mapSellerProfile(updated.rows[0], "admin_provisioned"),
          sessions_revoked: true
        }
      };
    });
  });

  app.get("/api/admin/system-status", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensureProductSurfaces();
    await ensurePayoutTables();
    return deps.withTx(async (c) => {
      const counts = await c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status IN ('pending','processing')) AS active_outbox,
           (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='pending') AS pending_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
           (SELECT COUNT(*)::int FROM siton.support_tickets WHERE status <> 'resolved') AS open_support_tickets,
           (SELECT COUNT(*)::int FROM siton.seller_payout_batches WHERE payout_status IN ('ready','batched','processing')) AS active_payout_batches,
           (SELECT COUNT(*)::int FROM siton.seller_payout_batches WHERE payout_status='failed') AS failed_payout_batches`
      );

      return {
        ok: true,
        system_status: {
          app_health: {
            ok: true
          },
          deployment: {
            mode: deps.deploymentMode,
            is_demo_preview: deps.isDemoPreview
          },
          integrations: {
            payment: getPaymentProviderSummary(deps.paymentProvider),
            payout: getPayoutProviderSummary(payoutProvider),
            notifications: deps.notificationSummary,
            webhook_ingestion: {
              duplicate_policy: "provider+event_id idempotent accept",
              canonical_route: "/webhooks/payments",
              legacy_route_alias: "/webhooks/payments/mock",
              supported_events: [
                "payment_authorized",
                "payment_failed",
                "charge_captured",
                "charge_failed",
                "recovery_captured",
                "recovery_failed",
                "refund_issued"
              ]
            }
          },
          readiness: operationalReadiness(),
          operational_counts: counts.rows[0],
          notes: [
            deps.isDemoPreview
              ? "This runtime is configured for demo / preview deployment and should not be presented as a live commercial environment."
              : "This runtime is not marked as commercial-live.",
            operationalReadiness().payment_provider.what_is_mock,
            operationalReadiness().payout_rail.what_is_mock,
            "Notifications remain intentionally log-only until external activation starts."
          ]
        }
      };
    });
  });

  // ── Outbox operational status ─────────────────────────────────────────────
  // Returns per-bucket counts, oldest event ages, stuck candidate count, and
  // workerRunning flag. Safe for dashboards and post-restart health checks.
  app.get("/api/admin/outbox-status", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    const stuckTimeoutMs = deps.workerStuckTimeoutMs ?? 60_000;
    return deps.withTx(async (c) => {
      const [outbox, dlq] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)                                              FILTER (WHERE status='pending')    AS pending_count,
             COUNT(*)                                              FILTER (WHERE status='processing') AS processing_count,
             COUNT(*)                                              FILTER (WHERE status='sent')       AS sent_count,
             COUNT(*)                                              FILTER (WHERE status='failed')     AS failed_count,
             EXTRACT(EPOCH FROM (now() - MIN(available_at)       FILTER (WHERE status='pending')))    AS oldest_pending_age_s,
             EXTRACT(EPOCH FROM (now() - MIN(processing_started_at)
                                                                  FILTER (WHERE status='processing'))) AS oldest_processing_age_s,
             COUNT(*)
               FILTER (WHERE status='processing'
                         AND (processing_started_at IS NULL
                              OR processing_started_at < now() - ($1::text || ' milliseconds')::interval))
                                                                                                     AS stuck_candidates
           FROM siton.outbox_events`,
          [String(stuckTimeoutMs)]
        ),
        c.query(`SELECT COUNT(*) AS dlq_count FROM siton.outbox_dlq`)
      ]);
      const o = outbox.rows[0];
      return {
        ok: true,
        outbox: {
          pending:           Number(o.pending_count   ?? 0),
          processing:        Number(o.processing_count ?? 0),
          sent:              Number(o.sent_count       ?? 0),
          failed:            Number(o.failed_count     ?? 0),
          dlq:               Number(dlq.rows[0].dlq_count ?? 0),
          oldest_pending_age_s:    o.oldest_pending_age_s    != null ? Number(Number(o.oldest_pending_age_s).toFixed(1))    : null,
          oldest_processing_age_s: o.oldest_processing_age_s != null ? Number(Number(o.oldest_processing_age_s).toFixed(1)) : null,
          stuck_candidates:  Number(o.stuck_candidates ?? 0),
          stuck_timeout_ms:  stuckTimeoutMs
        },
        worker: {
          running: typeof deps.getWorkerRunning === "function" ? deps.getWorkerRunning() : null,
          note: typeof deps.getWorkerRunning !== "function"
            ? "workerRunning status not wired — set getWorkerRunning dep"
            : undefined
        }
      };
    });
  });

  // ── Notifications operational status ──────────────────────────────────────
  // Returns per-status counts, oldest ages, unique event_key count, channel breakdown.
  // Safe for dashboards and post-restart health checks.
  app.get("/api/admin/notifications-status", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    return deps.withTx(async (c) => {
      const [totals, channels] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)                                                  FILTER (WHERE status='pending')    AS pending_count,
             COUNT(*)                                                  FILTER (WHERE status='processing') AS processing_count,
             COUNT(*)                                                  FILTER (WHERE status='sent')       AS sent_count,
             COUNT(*)                                                  FILTER (WHERE status='failed')     AS failed_count,
             COUNT(*)                                                  FILTER (WHERE status='skipped')    AS skipped_count,
             COUNT(*)                                                  FILTER (WHERE status='pending' AND attempt_count > 0) AS retryable_count,
             COUNT(DISTINCT event_key)                                                                   AS unique_event_keys,
             EXTRACT(EPOCH FROM (now() - MIN(available_at)            FILTER (WHERE status='pending')))  AS oldest_pending_age_s,
             EXTRACT(EPOCH FROM (now() - MIN(updated_at)              FILTER (WHERE status='failed')))   AS oldest_failed_age_s
           FROM siton.notifications`
        ),
        c.query(
          `SELECT channel,
                  COUNT(*)                          FILTER (WHERE status='pending') AS pending,
                  COUNT(*)                          FILTER (WHERE status='sent')    AS sent,
                  COUNT(*)                          FILTER (WHERE status='failed')  AS failed
           FROM siton.notifications
           GROUP BY channel
           ORDER BY channel`
        )
      ]);
      const t = totals.rows[0];
      return {
        ok: true,
        notifications: {
          pending:           Number(t.pending_count    ?? 0),
          processing:        Number(t.processing_count ?? 0),
          sent:              Number(t.sent_count        ?? 0),
          failed:            Number(t.failed_count      ?? 0),
          skipped:           Number(t.skipped_count     ?? 0),
          retryable:         Number(t.retryable_count   ?? 0),
          unique_event_keys: Number(t.unique_event_keys ?? 0),
          oldest_pending_age_s: t.oldest_pending_age_s != null ? Number(Number(t.oldest_pending_age_s).toFixed(1)) : null,
          oldest_failed_age_s:  t.oldest_failed_age_s  != null ? Number(Number(t.oldest_failed_age_s).toFixed(1))  : null,
          provider: { code: deps.notificationSummary.provider, mode: deps.notificationSummary.mode, external_delivery: deps.notificationSummary.external_delivery }
        },
        by_channel: channels.rows.map((r: any) => ({
          channel: String(r.channel),
          pending: Number(r.pending ?? 0),
          sent:    Number(r.sent    ?? 0),
          failed:  Number(r.failed  ?? 0)
        }))
      };
    });
  });

  // ── Invoice documents operational status ─────────────────────────────────
  // Returns per-status counts, oldest ages, unique document_key count, type breakdown.
  // Mirrors notifications-status structure. Safe for dashboards and post-restart checks.
  app.get("/api/admin/invoice-status", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    return deps.withTx(async (c) => {
      const [totals, byType] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)                                                   FILTER (WHERE status='pending')    AS pending_count,
             COUNT(*)                                                   FILTER (WHERE status='processing') AS processing_count,
             COUNT(*)                                                   FILTER (WHERE status='issued')     AS issued_count,
             COUNT(*)                                                   FILTER (WHERE status='failed')     AS failed_count,
             COUNT(*)                                                   FILTER (WHERE status='skipped')    AS skipped_count,
             COUNT(*)                                                   FILTER (WHERE status='pending' AND attempt_count > 0) AS retryable_count,
             COUNT(DISTINCT document_key)                                                                  AS unique_document_keys,
             EXTRACT(EPOCH FROM (now() - MIN(available_at)             FILTER (WHERE status='pending')))  AS oldest_pending_age_s,
             EXTRACT(EPOCH FROM (now() - MIN(updated_at)               FILTER (WHERE status='failed')))   AS oldest_failed_age_s
           FROM siton.invoice_documents`
        ),
        c.query(
          `SELECT document_type,
                  COUNT(*)          FILTER (WHERE status='pending')  AS pending,
                  COUNT(*)          FILTER (WHERE status='issued')   AS issued,
                  COUNT(*)          FILTER (WHERE status='failed')   AS failed
           FROM siton.invoice_documents
           GROUP BY document_type
           ORDER BY document_type`
        )
      ]);
      const t = totals.rows[0];
      return {
        ok: true,
        invoice_documents: {
          pending:              Number(t.pending_count    ?? 0),
          processing:           Number(t.processing_count ?? 0),
          issued:               Number(t.issued_count     ?? 0),
          failed:               Number(t.failed_count     ?? 0),
          skipped:              Number(t.skipped_count    ?? 0),
          retryable:            Number(t.retryable_count  ?? 0),
          unique_document_keys: Number(t.unique_document_keys ?? 0),
          oldest_pending_age_s: t.oldest_pending_age_s != null ? Number(Number(t.oldest_pending_age_s).toFixed(1)) : null,
          oldest_failed_age_s:  t.oldest_failed_age_s  != null ? Number(Number(t.oldest_failed_age_s).toFixed(1))  : null,
          provider: deps.invoiceSummary
            ? { code: deps.invoiceSummary.provider, mode: deps.invoiceSummary.mode, external_issuance: deps.invoiceSummary.external_issuance }
            : null
        },
        by_type: byType.rows.map((r: any) => ({
          document_type: String(r.document_type),
          pending: Number(r.pending ?? 0),
          issued:  Number(r.issued  ?? 0),
          failed:  Number(r.failed  ?? 0)
        }))
      };
    });
  });

  // ── Unified system ops status ─────────────────────────────────────────────
  // Single endpoint aggregating outbox + notifications + invoice pending/failed
  // counts and oldest ages. One read-only call gives full operational picture.
  app.get("/api/admin/payout-status", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensurePayoutTables();
    if (!deps.payoutRail) {
      return {
        ok: true,
        payout_batches: null,
        provider: getPayoutProviderSummary(payoutProvider),
        note: "payout rail dependency not wired"
      };
    }

    return {
      ok: true,
      payout_batches: await deps.payoutRail.payoutStatusSummary(),
      provider: getPayoutProviderSummary(payoutProvider)
    };
  });

  app.get("/api/admin/payouts/batches/:id", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensurePayoutTables();
    const payoutBatchId = String(req.params.id || "").trim();
    requireUuid(payoutBatchId, "payout_batch_id");
    if (!deps.payoutRail) {
      const err: any = new Error("payout rail dependency not wired");
      err.statusCode = 503;
      throw err;
    }
    const profile = await deps.payoutRail.getBatchProfile(payoutBatchId);
    if (!profile) {
      const err: any = new Error("payout batch not found");
      err.statusCode = 404;
      throw err;
    }
    return {
      ok: true,
      payout_batch: profile
    };
  });

  app.get("/api/admin/sellers/:id/payout-readiness", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensurePayoutTables();
    const sellerId = String(req.params.id || "").trim();
    if (!sellerId) {
      const err: any = new Error("seller_id is required");
      err.statusCode = 400;
      throw err;
    }
    if (!deps.payoutRail) {
      const err: any = new Error("payout rail dependency not wired");
      err.statusCode = 503;
      throw err;
    }
    const readiness = await deps.payoutRail.summarizeSellerReadiness(sellerId);
    if (!readiness) {
      const err: any = new Error("seller not found");
      err.statusCode = 404;
      throw err;
    }
    return {
      ok: true,
      payout_readiness: readiness
    };
  });

  app.get("/api/admin/system-ops-status", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensurePayoutTables();
    return deps.withTx(async (c) => {
      const [outboxRow, dlqRow, notifRow, invoiceRow, payoutRow] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE status='pending')    AS pending,
             COUNT(*) FILTER (WHERE status='processing') AS processing,
             COUNT(*) FILTER (WHERE status='failed')     AS failed,
             EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s,
             COUNT(*) FILTER (WHERE status='processing'
                              AND (processing_started_at IS NULL
                                   OR processing_started_at < now() - '60 seconds'::interval)) AS stuck_candidates
           FROM siton.outbox_events`
        ),
        c.query(`SELECT COUNT(*) AS dlq FROM siton.outbox_dlq`),
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE status='pending') AS pending,
             COUNT(*) FILTER (WHERE status='failed')  AS failed,
             EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
           FROM siton.notifications`
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE status='pending') AS pending,
             COUNT(*) FILTER (WHERE status='failed')  AS failed,
             EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
           FROM siton.invoice_documents`
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE payout_status='pending') AS pending,
             COUNT(*) FILTER (WHERE payout_status='ready') AS ready,
             COUNT(*) FILTER (WHERE payout_status='batched') AS batched,
             COUNT(*) FILTER (WHERE payout_status='processing') AS processing,
             COUNT(*) FILTER (WHERE payout_status='paid') AS paid,
             COUNT(*) FILTER (WHERE payout_status='failed') AS failed,
             COUNT(*) FILTER (WHERE payout_status='returned') AS returned,
             COUNT(*) FILTER (WHERE payout_status='reconciled') AS reconciled
           FROM siton.seller_payout_batches`
        )
      ]);
      const o = outboxRow.rows[0];
      const n = notifRow.rows[0];
      const inv = invoiceRow.rows[0];
      const payout = payoutRow.rows[0];
      const workerRunning = typeof deps.getWorkerRunning === "function" ? deps.getWorkerRunning() : null;
      return {
        ok: true,
        worker_running: workerRunning,
        outbox: {
          pending:    Number(o.pending    ?? 0),
          processing: Number(o.processing ?? 0),
          failed:     Number(o.failed     ?? 0),
          dlq:        Number(dlqRow.rows[0].dlq ?? 0),
          oldest_pending_age_s: o.oldest_pending_age_s != null ? Number(Number(o.oldest_pending_age_s).toFixed(1)) : null,
          stuck_candidates: Number(o.stuck_candidates ?? 0)
        },
        notifications: {
          pending: Number(n.pending ?? 0),
          failed:  Number(n.failed  ?? 0),
          oldest_pending_age_s: n.oldest_pending_age_s != null ? Number(Number(n.oldest_pending_age_s).toFixed(1)) : null
        },
        invoice_documents: {
          pending: Number(inv.pending ?? 0),
          failed:  Number(inv.failed  ?? 0),
          oldest_pending_age_s: inv.oldest_pending_age_s != null ? Number(Number(inv.oldest_pending_age_s).toFixed(1)) : null
        },
        payout_batches: {
          pending: Number(payout.pending ?? 0),
          ready: Number(payout.ready ?? 0),
          batched: Number(payout.batched ?? 0),
          processing: Number(payout.processing ?? 0),
          paid: Number(payout.paid ?? 0),
          failed: Number(payout.failed ?? 0),
          returned: Number(payout.returned ?? 0),
          reconciled: Number(payout.reconciled ?? 0)
        }
      };
    });
  });

  // ── Participant ops read surface ──────────────────────────────────────────
  // Cross-system read-only view for a single participant:
  //   - participant state (buyer_state, money_state) and deal reference
  //   - notifications sent or pending for this participant
  //   - invoice documents issued or pending for this participant
  //   - recent outbox events for this participant's deal
  // Use this to diagnose why a participant did not receive a document or notification.
  app.get("/api/admin/participants/:id/ops", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    const participantId = String(req.params.id || "").trim();
    requireUuid(participantId, "participant_id");
    return deps.withTx(async (c) => {
      const [participantRow, notifications, invoiceDocs, outboxEvents] = await Promise.all([
        c.query(
          `SELECT p.participant_id, p.deal_id, p.buyer_id, p.qty,
                  p.buyer_state, p.money_state, p.created_at,
                  d.title AS deal_title, d.state AS deal_state
           FROM siton.participants p
           JOIN siton.deals d ON d.deal_id = p.deal_id
           WHERE p.participant_id = $1`,
          [participantId]
        ),
        c.query(
          `SELECT event_key, notification_event_type, channel, status,
                  attempt_count, last_error, sent_at, provider_message_id, created_at
           FROM siton.notifications
           WHERE template_params->>'participant_id' = $1
           ORDER BY created_at DESC
           LIMIT 20`,
          [participantId]
        ),
        c.query(
          `SELECT document_key, document_type, status, attempt_count,
                  provider_document_id, last_error, issued_at,
                  gross_amount, money_state_at_issue, created_at
           FROM siton.invoice_documents
           WHERE participant_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [participantId]
        ),
        c.query(
          `SELECT oe.event_type, oe.aggregate_type, oe.aggregate_id,
                  oe.status, oe.attempt_count, oe.last_error, oe.created_at
           FROM siton.outbox_events oe
           JOIN siton.participants p ON p.deal_id = oe.aggregate_id
           WHERE p.participant_id = $1
           ORDER BY oe.created_at DESC
           LIMIT 20`,
          [participantId]
        )
      ]);

      if (!participantRow.rowCount) {
        const err: any = new Error("participant not found");
        err.statusCode = 404;
        throw err;
      }

      const p = participantRow.rows[0];
      return {
        ok: true,
        participant: {
          participant_id: p.participant_id,
          deal_id: p.deal_id,
          buyer_id: p.buyer_id,
          qty: p.qty,
          buyer_state: p.buyer_state,
          money_state: p.money_state,
          deal_title: p.deal_title,
          deal_state: p.deal_state,
          created_at: p.created_at
        },
        notifications: notifications.rows,
        invoice_documents: invoiceDocs.rows,
        outbox_events_for_deal: outboxEvents.rows
      };
    });
  });

  app.get("/api/admin/deals/:id/profile", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();
    await ensurePayoutTables();

    return deps.withTx(async (c) => {
      const deal = await c.query(
        `SELECT *
         FROM siton.deals
         WHERE deal_id = $1`,
        [dealId]
      );
      if (!deal.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const participants = await c.query(
        `SELECT participant_id, buyer_id, qty, buyer_state, money_state, created_at
         FROM siton.participants
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [dealId]
      );
      const outbox = await c.query(
        `SELECT event_type, status, available_at, created_at
         FROM siton.outbox_events
         WHERE aggregate_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [dealId]
      );
      const attempts = await c.query(
        `SELECT attempt_type, correlation_id, result_class, created_at
         FROM siton.payment_attempts
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [dealId]
      );
      const audit = await c.query(
        `SELECT entity_type, state_type, from_state, to_state, action_name, created_at
         FROM siton.audit_log
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [dealId]
      );
      const deliveries = await c.query(
        `SELECT participant_id, status, tracking_number, issue_note, updated_at
         FROM siton.delivery_records
         WHERE deal_id = $1
         ORDER BY updated_at DESC`,
        [dealId]
      );
      const attributions = await c.query(
        `SELECT aa.participant_id, aa.share_code, af.display_name
         FROM siton.affiliate_attributions aa
         JOIN siton.affiliate_accounts af ON af.affiliate_id = aa.affiliate_id
         WHERE aa.deal_id = $1
         ORDER BY aa.created_at DESC`,
        [dealId]
      );
      const tickets = await c.query(
        `SELECT ticket_id, scope_type, scope_key, title, priority, status, summary, updated_at
         FROM siton.support_tickets
         WHERE (scope_type='deal' AND scope_key=$1) OR (scope_type='system')
         ORDER BY updated_at DESC
         LIMIT 20`,
        [dealId]
      );
      const payoutSummary = deps.payoutRail
        ? await deps.payoutRail.getDealPayoutSummary(dealId)
        : { batches: [], items: [] };

      return {
        ok: true,
        profile: {
          deal: deal.rows[0],
          participants: participants.rows,
          outbox: outbox.rows,
          payment_attempts: attempts.rows,
          audit: audit.rows,
          delivery: deliveries.rows,
          payout_batches: payoutSummary.batches,
          payout_items: payoutSummary.items,
          affiliate_attributions: attributions.rows,
          support_tickets: tickets.rows
        }
      };
    });
  });

  // ── Per-deal cross-system ops summary ────────────────────────────────────
  // Read-only. Aggregates participant states, notifications, invoice_documents,
  // and outbox events for a single deal. Use this to get a full operational
  // picture of one deal without running multiple queries manually.
  app.get("/api/admin/deals/:id/ops-summary", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    const dealId = String(req.params.id || "").trim();
    requireUuid(dealId, "deal_id");
    await ensurePayoutTables();
    return deps.withTx(async (c) => {
      const dealRow = await c.query(
        `SELECT deal_id, state, title FROM siton.deals WHERE deal_id=$1`,
        [dealId]
      );
      if (!dealRow.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const [participantsResult, notifResult, invoiceResult, outboxResult, payoutResult] = await Promise.all([
        c.query(
          `SELECT buyer_state, COUNT(*) AS cnt
           FROM siton.participants
           WHERE deal_id=$1
           GROUP BY buyer_state`,
          [dealId]
        ),
        c.query(
          `SELECT channel,
                  COUNT(*) FILTER (WHERE status='pending')    AS pending,
                  COUNT(*) FILTER (WHERE status='processing') AS processing,
                  COUNT(*) FILTER (WHERE status='sent')       AS sent,
                  COUNT(*) FILTER (WHERE status='failed')     AS failed,
                  EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
           FROM siton.notifications
           WHERE template_params->>'deal_id' = $1
           GROUP BY channel
           ORDER BY channel`,
          [dealId]
        ),
        c.query(
          `SELECT document_type,
                  COUNT(*) FILTER (WHERE status='pending')    AS pending,
                  COUNT(*) FILTER (WHERE status='processing') AS processing,
                  COUNT(*) FILTER (WHERE status='issued')     AS issued,
                  COUNT(*) FILTER (WHERE status='failed')     AS failed,
                  EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
           FROM siton.invoice_documents
           WHERE deal_id=$1
           GROUP BY document_type
           ORDER BY document_type`,
          [dealId]
        ),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE status='pending')    AS pending,
                  COUNT(*) FILTER (WHERE status='processing') AS processing,
                  COUNT(*) FILTER (WHERE status='sent')       AS sent,
                  COUNT(*) FILTER (WHERE status='failed')     AS failed,
                  EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
           FROM siton.outbox_events
           WHERE aggregate_id = $1
              OR aggregate_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1)`,
          [dealId]
        ),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE payout_status='pending') AS pending,
                  COUNT(*) FILTER (WHERE payout_status='ready') AS ready,
                  COUNT(*) FILTER (WHERE payout_status='batched') AS batched,
                  COUNT(*) FILTER (WHERE payout_status='processing') AS processing,
                  COUNT(*) FILTER (WHERE payout_status='paid') AS paid,
                  COUNT(*) FILTER (WHERE payout_status='failed') AS failed,
                  COUNT(*) FILTER (WHERE payout_status='returned') AS returned,
                  COUNT(*) FILTER (WHERE payout_status='reconciled') AS reconciled,
                  COALESCE(SUM(payout_amount), 0) AS payout_amount
           FROM siton.seller_payout_batches
           WHERE trigger_deal_id=$1`,
          [dealId]
        )
      ]);

      const deal = dealRow.rows[0];

      // Participants by buyer_state
      const byState: Record<string, number> = {};
      let totalParticipants = 0;
      for (const r of participantsResult.rows) {
        byState[String(r.buyer_state)] = Number(r.cnt);
        totalParticipants += Number(r.cnt);
      }

      // Notifications totals + by_channel
      let nPending = 0, nSent = 0, nFailed = 0, nProcessing = 0;
      for (const r of notifResult.rows) {
        nPending     += Number(r.pending     ?? 0);
        nSent        += Number(r.sent        ?? 0);
        nFailed      += Number(r.failed      ?? 0);
        nProcessing  += Number(r.processing  ?? 0);
      }

      // Invoice documents totals + by_type
      let iPending = 0, iIssued = 0, iFailed = 0, iProcessing = 0;
      for (const r of invoiceResult.rows) {
        iPending    += Number(r.pending    ?? 0);
        iIssued     += Number(r.issued     ?? 0);
        iFailed     += Number(r.failed     ?? 0);
        iProcessing += Number(r.processing ?? 0);
      }

      const ob = outboxResult.rows[0];
      const payout = payoutResult.rows[0];

      return {
        ok: true,
        deal: {
          deal_id: String(deal.deal_id),
          state:   String(deal.state),
          title:   String(deal.title || "")
        },
        participants: {
          total:    totalParticipants,
          by_state: byState
        },
        notifications: {
          pending:    nPending,
          processing: nProcessing,
          sent:       nSent,
          failed:     nFailed,
          by_channel: notifResult.rows.map((r: any) => ({
            channel:  String(r.channel),
            pending:  Number(r.pending    ?? 0),
            sent:     Number(r.sent       ?? 0),
            failed:   Number(r.failed     ?? 0),
            oldest_pending_age_s: r.oldest_pending_age_s != null
              ? Number(Number(r.oldest_pending_age_s).toFixed(1)) : null
          }))
        },
        invoice_documents: {
          pending:    iPending,
          processing: iProcessing,
          issued:     iIssued,
          failed:     iFailed,
          by_type: invoiceResult.rows.map((r: any) => ({
            document_type: String(r.document_type),
            pending:  Number(r.pending ?? 0),
            issued:   Number(r.issued  ?? 0),
            failed:   Number(r.failed  ?? 0),
            oldest_pending_age_s: r.oldest_pending_age_s != null
              ? Number(Number(r.oldest_pending_age_s).toFixed(1)) : null
          }))
        },
        outbox: {
          pending:    Number(ob.pending    ?? 0),
          processing: Number(ob.processing ?? 0),
          sent:       Number(ob.sent       ?? 0),
          failed:     Number(ob.failed     ?? 0),
          oldest_pending_age_s: ob.oldest_pending_age_s != null
            ? Number(Number(ob.oldest_pending_age_s).toFixed(1)) : null
        },
        payout_batches: {
          pending: Number(payout.pending ?? 0),
          ready: Number(payout.ready ?? 0),
          batched: Number(payout.batched ?? 0),
          processing: Number(payout.processing ?? 0),
          paid: Number(payout.paid ?? 0),
          failed: Number(payout.failed ?? 0),
          returned: Number(payout.returned ?? 0),
          reconciled: Number(payout.reconciled ?? 0),
          payout_amount: Number(payout.payout_amount ?? 0)
        }
      };
    });
  });

  app.get("/api/admin/users/:buyerId/profile", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    const buyerId = String(req.params.buyerId || "").trim();
    if (!buyerId) {
      const err: any = new Error("buyer_id required");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const participants = await c.query(
        `SELECT p.participant_id, p.deal_id, p.qty, p.buyer_state, p.money_state, p.created_at, d.title, d.state AS deal_state
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE p.buyer_id = $1
         ORDER BY p.created_at DESC
         LIMIT 100`,
        [buyerId]
      );

      return {
        ok: true,
        profile: {
          buyer_id: buyerId,
          joins: participants.rows,
          totals: {
            total_joins: participants.rowCount,
            active_joins: participants.rows.filter((row: any) => !["DealCompleted", "DealFailed", "Dropped"].includes(row.buyer_state)).length
          }
        }
      };
    });
  });

  app.post("/api/admin/kyc/:subjectType/:subjectId/decision", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    const subjectType = String(req.params.subjectType || "").trim();
    const subjectId = String(req.params.subjectId || "").trim();
    const decision = String(req.body?.decision || "").trim();
    const adminNote = String(req.body?.admin_note || "").trim();
    if (!["seller", "affiliate"].includes(subjectType)) {
      const err: any = new Error("subject_type is invalid");
      err.statusCode = 400;
      throw err;
    }
    if (!["approve", "reject"].includes(decision)) {
      const err: any = new Error("decision is invalid");
      err.statusCode = 400;
      throw err;
    }

    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const nextStatus = decision === "approve" ? "approved" : "rejected";
      if (subjectType === "seller") {
        const updated = await c.query(
          `UPDATE siton.seller_accounts
           SET verification_status = $2, admin_note = $3, updated_at = now()
           WHERE seller_id = $1
           RETURNING seller_id AS subject_id, verification_status AS status, admin_note`,
          [subjectId, nextStatus, adminNote]
        );
        if (!updated.rowCount) {
          const err: any = new Error("seller profile not found");
          err.statusCode = 404;
          throw err;
        }
        return { ok: true, subject_type: subjectType, result: updated.rows[0] };
      }

      const updated = await c.query(
        `UPDATE siton.affiliate_accounts
         SET verification_status = $2, admin_note = $3, updated_at = now()
         WHERE affiliate_id = $1
         RETURNING affiliate_id AS subject_id, verification_status AS status, admin_note`,
        [subjectId, nextStatus, adminNote]
      );
      if (!updated.rowCount) {
        const err: any = new Error("affiliate profile not found");
        err.statusCode = 404;
        throw err;
      }
      return { ok: true, subject_type: subjectType, result: updated.rows[0] };
    });
  });

  app.post("/api/admin/support", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensureProductSurfaces();
    const scopeType = String(req.body?.scope_type || "").trim();
    const scopeKey = String(req.body?.scope_key || "").trim();
    const title = String(req.body?.title || "").trim();
    const priority = String(req.body?.priority || "normal").trim();
    const summary = String(req.body?.summary || "").trim();
    if (!scopeType || !scopeKey || !title) {
      const err: any = new Error("scope_type, scope_key, and title are required");
      err.statusCode = 400;
      throw err;
    }
    if (!["deal", "participant", "affiliate", "seller", "system"].includes(scopeType)) {
      const err: any = new Error("support scope_type is invalid");
      err.statusCode = 400;
      throw err;
    }
    if (!["normal", "high"].includes(priority)) {
      const err: any = new Error("support priority is invalid");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.support_tickets (scope_type, scope_key, title, priority, summary)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING ticket_id, scope_type, scope_key, title, priority, status, summary, created_at`,
        [scopeType, scopeKey, title, priority, summary]
      );
      return { ok: true, ticket: inserted.rows[0] };
    });
  });

  app.post("/api/admin/support/:ticketId", async (req: any, reply: any) => {
    if (!requireAdminKey(req as FastifyRequest, reply as FastifyReply)) return;
    await ensureProductSurfaces();
    const ticketId = String(req.params.ticketId || "");
    requireUuid(ticketId, "ticket_id");
    const status = String(req.body?.status || "").trim();
    const summary = String(req.body?.summary || "").trim();
    if (!["open", "investigating", "resolved"].includes(status)) {
      const err: any = new Error("support status is invalid");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const updated = await c.query(
        `UPDATE siton.support_tickets
         SET status = $2,
             summary = CASE WHEN $3 = '' THEN summary ELSE $3 END,
             updated_at = now()
         WHERE ticket_id = $1
         RETURNING ticket_id, status, summary, updated_at`,
        [ticketId, status, summary]
      );
      if (!updated.rowCount) {
        const err: any = new Error("support ticket not found");
        err.statusCode = 404;
        throw err;
      }
      return { ok: true, ticket: updated.rows[0] };
    });
  });

  app.get("/api/participants/:id/tracking", async (req: any) => {
    const participantId = String(req.params.id);
    requireUuid(participantId, "participant_id");

    return deps.withTx(async (c) => {
      const participantResult = await c.query(
        `SELECT
           p.participant_id,
           p.deal_id,
           p.buyer_id,
           p.qty,
           p.buyer_state,
           p.money_state,
           p.delivery_method_type,
           p.delivery_method_label,
           p.delivery_cost,
           p.created_at,
           d.title,
           d.state AS deal_state,
           d.price_per_unit,
           d.deadline,
           d.completion_window_until
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE p.participant_id=$1`,
        [participantId]
      );

      if (!participantResult.rowCount) {
        const err: any = new Error("participant not found");
        err.statusCode = 404;
        throw err;
      }

      const row = participantResult.rows[0] as {
        participant_id: string;
        deal_id: string;
        buyer_id: string;
        qty: number;
        buyer_state: BuyerState;
        money_state: MoneyState;
        delivery_method_type: string | null;
        delivery_method_label: string | null;
        delivery_cost: number;
        created_at: string;
        title: string;
        deal_state: DealState;
        price_per_unit: number;
        deadline: string;
        completion_window_until: string | null;
      };

      const invoiceDocumentResult = await c.query(
        `SELECT document_id, status, provider_document_id, issued_at, created_at
         FROM siton.invoice_documents
         WHERE participant_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [participantId]
      );

      const invoiceDocument = (invoiceDocumentResult.rows[0] ?? null) as {
        document_id?: string | null;
        status?: string | null;
        provider_document_id?: string | null;
        issued_at?: string | null;
      } | null;

      const copy = deriveTrackingCopy(row.deal_state, row.buyer_state, row.money_state);
      const documentVisibility = deriveBuyerDocumentVisibility({
        dealState: row.deal_state,
        buyerState: row.buyer_state,
        moneyState: row.money_state,
        invoiceDocument
      });

      return {
        ok: true,
        tracking: {
          participant_id: row.participant_id,
          deal_id: row.deal_id,
          buyer_id: row.buyer_id,
          qty: Number(row.qty),
          delivery_method_type: row.delivery_method_type,
          delivery_method_label: row.delivery_method_label,
          delivery_cost: Number(row.delivery_cost || 0),
          estimated_total: Number(row.qty) * Number(row.price_per_unit) + Number(row.delivery_cost || 0),
          buyer_state: row.buyer_state,
          money_state: row.money_state,
          deal_state: row.deal_state,
          deal_title: row.title,
          price_per_unit: Number(row.price_per_unit),
          deadline: row.deadline,
          completion_window_until: row.completion_window_until,
          created_at: row.created_at,
          headline: copy.headline,
          subline: copy.subline,
          tone: copy.tone,
          document_visibility: documentVisibility
        }
      };
    });
  });

  app.post("/api/otp/start", async (req: any) => {
    const phone = String(req.body?.phone || "").trim();
    const digits = phone.replace(/\D/g, "");
    if (!digits) {
      const err: any = new Error("phone required");
      err.statusCode = 400;
      throw err;
    }
    if (digits.length < 7 || digits.length > 15) {
      const err: any = new Error("phone must contain 7 to 15 digits");
      err.statusCode = 400;
      throw err;
    }

    const sessionId = otpSessionId(digits);
    const session: OtpSession = {
      sessionId,
      phone: digits,
      code: generateOtpCode(),
      createdAt: Date.now(),
      expiresAt: Date.now() + OTP_TTL_MS,
      verified: false,
      attemptCount: 0
    };
    otpSessions.set(sessionId, session);

    return {
      ok: true,
      otp_session_id: sessionId,
      masked_destination: maskPhone(phone),
      expires_at: new Date(session.expiresAt).toISOString(),
      development_code: deps.isDemoPreview ? session.code : undefined
    };
  });

  app.post("/api/otp/verify", async (req: any) => {
    const sessionId = String(req.body?.otp_session_id || "");
    const code = String(req.body?.code || "");
    if (!sessionId) {
      const err: any = new Error("otp_session_id required");
      err.statusCode = 400;
      throw err;
    }
    const session = otpSessions.get(sessionId);

    if (!session) {
      const err: any = new Error("otp session not found");
      err.statusCode = 404;
      throw err;
    }

    if (Date.now() > session.expiresAt) {
      otpSessions.delete(sessionId);
      const err: any = new Error("otp expired");
      err.statusCode = 400;
      throw err;
    }

    if (session.attemptCount >= OTP_MAX_ATTEMPTS) {
      otpSessions.delete(sessionId);
      const err: any = new Error("too many otp attempts, please request a new code");
      err.statusCode = 429;
      throw err;
    }

    if (code !== session.code) {
      session.attemptCount += 1;
      otpSessions.set(sessionId, session);
      const err: any = new Error("invalid otp");
      err.statusCode = 400;
      throw err;
    }

    session.verified = true;
    otpSessions.set(sessionId, session);

    return {
      ok: true,
      otp_session_id: sessionId,
      verified: true,
      buyer_id: session.phone
    };
  });

  const handleAuthorizePayment = async (req: any, reply: any) => {
    const authorizeInput: Parameters<typeof deps.paymentProvider.authorize>[0] = {
      holder_name: String(req.body?.holder_name || ""),
      card_number: String(req.body?.card_number || ""),
      expiry: String(req.body?.expiry || ""),
      cvv: String(req.body?.cvv || ""),
      amount_minor: req.body?.amount_minor,
      currency: String(req.body?.currency || ""),
      request_id: String(req.headers?.["x-request-id"] || req.id || "")
    };
    if (req.body?.buyer_id) authorizeInput.buyer_id = String(req.body.buyer_id);
    if (req.body?.deal_id) authorizeInput.deal_id = String(req.body.deal_id);
    if (req.body?.correlation_id) authorizeInput.correlation_id = String(req.body.correlation_id);
    const result = await deps.paymentProvider.authorize(authorizeInput);

    if (!result.ok) {
      return reply.code(result.statusCode).send(result);
    }

    return result;
  };
  app.post("/api/payments/authorize", handleAuthorizePayment);
  app.post("/api/payments/authorize-mock", handleAuthorizePayment);

  app.get("/app/assets/styles.css", async (_req, reply) =>
    sendFrontendFile(reply, "styles.css", "text/css; charset=utf-8")
  );
  app.get("/app/assets/app.js", async (_req, reply) =>
    sendFrontendFile(reply, "app.js", "application/javascript; charset=utf-8")
  );

  const sendShell = async (_req: any, reply: FastifyReply) =>
    sendFrontendFile(reply, "index.html", "text/html; charset=utf-8");

  app.get("/app", sendShell);
  app.get("/app/", sendShell);
  app.get("/app/terms", sendShell);
  app.get("/app/privacy", sendShell);
  app.get("/app/refunds", sendShell);
  app.get("/app/contact", sendShell);
  app.get("/app/deal/:dealId", sendShell);
  app.get("/app/join/:dealId/otp", sendShell);
  app.get("/app/join/:dealId/payment", sendShell);
  app.get("/app/join/:dealId/confirmation", sendShell);
  app.get("/app/track/:participantId", sendShell);
  app.get("/app/seller", sendShell);
  app.get("/app/seller/new", sendShell);
  app.get("/app/seller/deals/:dealId", sendShell);
  app.get("/app/affiliate", sendShell);
  app.get("/app/admin", sendShell);
  app.get("/app/admin/deals/:dealId", sendShell);
  app.get("/app/admin/participants/:participantId", sendShell);
  app.get("/app/admin/users/:buyerId", sendShell);
  app.get("/app/*", sendShell);
}
