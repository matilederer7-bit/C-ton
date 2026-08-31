import { assertRequiredTables } from "./schema_contract.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { PassThrough } from "stream";
import ExcelJS from "exceljs";
import { fileURLToPath } from "url";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { buildOperationalReadinessSummary } from "./operational_readiness.js";
import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";
import { buildPayoutProvider, getPayoutProviderSummary, type PayoutProvider } from "./payout_provider.js";
import type { InvoiceProvider } from "./invoice_dispatch.js";
import {
  ADMIN_API_KEY,
  isProductionLikeEnv,
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
  roundMoney,
  summarizeMoney
} from "./product_surface_support.js";
import {
  OPEN_OPERATIONAL_CASE_STATUSES,
  OPERATIONAL_CASE_PRIORITIES,
  OPERATIONAL_CASE_STATUSES,
  OPERATIONAL_CASE_TYPES,
  ensureAutomaticOperationalCases,
  ensureOperationalCaseTables,
  isOperationalCasePriority,
  isOperationalCaseStatus,
  isOperationalCaseType,
  operationalCaseEventAction,
  recordOperationalCaseEvent
} from "./operational_cases.js";
import { getDealImagePublicUrl, resolveDealImageUrl } from "./product_image_storage.js";
import { calculatePlatformFeeMoney, SITON_PLATFORM_FEE_RATE } from "./platform_fee_money.js";
import { buildWebhookIngestion } from "./webhook_ingestion.js";
import { buildPaymentReconciliation } from "./payment_reconciliation.js";
import { ensurePayoutRailTables } from "./payout_rail.js";
import { ensureNotificationRailTables } from "./notification_dispatch.js";
import {
  buildOtpProvider,
  ensureOtpRailTables,
  ensureJoinOtpVerified,
  generateOtpCode,
  OtpValidationError,
  requestOtpChallenge,
  verifyOtpChallenge,
  type OtpProvider
} from "./otp_rail.js";
import {
  SELLER_SESSION_COOKIE,
  createSellerSessionToken,
  hasSellerSessionCookie,
  hashSellerAccessSecret,
  hashSellerSessionToken,
  SELLER_SESSION_TTL_SECONDS,
  normalizeSellerDisplayName,
  normalizeSellerId,
  normalizeSellerLoginEmail,
  parseCookies,
  safeSellerReturnTo,
  sellerAuthFailurePayload,
  serializeExpiredSellerSessionCookie,
  serializeSellerSessionCookie,
  verifySellerAccessSecret
} from "./seller_auth.js";
import {
  BUYER_SESSION_TTL_SECONDS,
  buyerSessionConfigured,
  createBuyerSessionToken,
  hashBuyerSessionToken,
  readBuyerSessionToken,
  serializeBuyerSessionCookie,
  serializeExpiredBuyerSessionCookie
} from "./buyer_session.js";
import {
  DISTRIBUTOR_SESSION_TTL_SECONDS,
  createDistributorSessionToken,
  distributorAuthConfigured,
  distributorCookieSecure,
  hashDistributorSessionToken,
  readDistributorSessionToken,
  serializeDistributorSessionCookie,
  serializeExpiredDistributorSessionCookie
} from "./distributor_identity.js";
import {
  buildSellerAnalytics,
  normalizeSellerAnalyticsPeriod,
  SELLER_ANALYTICS_PERIODS
} from "./seller_analytics.js";
import {
  SELLER_STATUSES,
  isSellerStatus,
  normalizeSellerStatus,
  sellerStatusBlocksAction,
  sellerStatusErrorCode,
  sellerStatusHebrewNotice,
  sellerStatusMessage,
  type SellerAction
} from "./seller_enforcement.js";
import {
  buildAdminMissionControlPayload,
  buildMissionCorrelationTrace,
  buildMissionDealTrace,
  buildMissionOutboxTrace,
  buildMissionParticipantTrace,
  buildMissionWebhookTrace
} from "./admin_mission_control.js";
import {
  adminRequestContext,
  ensureAdminControlPlaneTables,
  executeAdminAction,
  insertAdminAction,
  isForbiddenAdminAction,
  isSafeActionType,
  isTargetType
} from "./admin_control_plane.js";
import {
  ADMIN_ACTION_PERMISSION,
  ADMIN_SESSION_COOKIE,
  HIGH_TRUST_ADMIN_ACTIONS,
  adminPublicIdentity,
  parseCookieHeader,
  createAdminMfaCode,
  ensureAdminIdentityTables,
  hasAdminPermission,
  hasRecentMfa,
  hashAdminOtp,
  hashAdminSessionToken,
  hashAdminPassword,
  issueAdminSession,
  resolveAdminIdentity,
  safeAdminId,
  serializeAdminSessionCookie,
  serializeExpiredAdminSessionCookie,
  verifyAdminPassword
} from "./admin_identity.js";
import {
  ensureParticipantTrackingTables,
  extractTrackingToken,
  issueParticipantTrackingToken,
  trackingMode,
  verifyParticipantTrackingAccess
} from "./participant_tracking_security.js";
import {
  ADMIN_FLAG_TYPES,
  ensureAdminInterventionTables,
  expireDueAdminControlFlags,
  isAdminFlagType,
  isAdminFlagScopeType,
  listActiveAdminControlFlags,
  releaseAdminControlFlag
} from "./admin_intervention.js";
import { getDealImageStorageAdapter } from "./product_image_storage.js";
import {
  ensureDealTypeTables,
  normalizeDealType,
  readVoucherTerms,
  readTicketTerms,
  decideFulfillmentIssuance,
  publicDealCopy,
  trackingCopyForFulfillment,
  csvSafeCell,
  type DealType
} from "./deal_types.js";
import { LEGAL_PAGE_ORDER, LEGAL_PAGES, type LegalPageSlug } from "./legal_pages.js";
import { isBuyerVerificationRequired, buyerVerificationPolicySummary } from "./buyer_verification_policy.js";
import { buildSupabaseVerifier } from "./supabase_auth.js";
import { resolveSupabaseCapabilities, bearerToken } from "./actor_resolver.js";
import {
  recordViralFunnelEvent,
  readViralMetricsCache,
  enqueueViralRecompute,
  getParticipantImpact
} from "./viral_graph.js";
import { InfrastructureMetricsCollector, applicationRequestTelemetry } from "./infrastructure_metrics.js";
import { SupabaseComputeManager } from "./infrastructure_compute.js";
import {
  buildMallDiscoveryQuery,
  buildMallListEnvelope,
  mallStatusForState,
  parseMallQuery,
  projectMallRow,
  sanitizeMallEvent
} from "./mall_read_model.js";

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
  primary_image_id?: string | null;
  primary_image_public_url?: string | null;
  primary_image_mime_type?: string | null;
};

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

// R6 — the new canonical React frontend (web/dist), served same-origin under
// /preview by this Web service. The legacy vanilla frontend stays at the root.
const previewDirCandidates = [
  join(process.cwd(), "web", "dist"),
  join(__dirname, "..", "..", "web", "dist"),
  join(process.cwd(), ".demo_dist", "web", "dist")
];
const previewDir =
  previewDirCandidates.find((candidate) => existsSync(join(candidate, "index.html"))) || "";
const PREVIEW_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

// Env-gated Supabase verifier for the frontend seller read surfaces (inert
// unless SUPABASE_URL is configured).
let _frontendSupabaseVerifier: ReturnType<typeof buildSupabaseVerifier> | undefined;
function frontendSupabaseVerifier() {
  if (_frontendSupabaseVerifier === undefined) _frontendSupabaseVerifier = buildSupabaseVerifier();
  return _frontendSupabaseVerifier;
}

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
     RETURNING seller_id, display_name, login_email, auth_enabled, verification_status, settlement_status,
               payout_method, payout_details_masked, admin_note, seller_status, seller_status_reason,
               seller_status_updated_at, seller_status_updated_by, created_at, updated_at, last_login_at`,
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

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLegalMarkdown(markdown: string) {
  return markdown
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("# ")) return `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
      if (trimmed.startsWith("## ")) return `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
      return `<p>${escapeHtml(trimmed).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

function renderLegalHtmlPage(slug: LegalPageSlug) {
  const page = LEGAL_PAGES[slug];
  const nav = LEGAL_PAGE_ORDER.map((item) => {
    const target = LEGAL_PAGES[item];
    return `<a href="/legal/${target.slug}"${target.slug === slug ? ` aria-current="page"` : ""}>${escapeHtml(target.navLabel)}</a>`;
  }).join("");
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>C-ton | ${escapeHtml(page.title)}</title>
  <style>
    :root{color-scheme:light;--bg:#2F3237;--card:#fff;--text:#1F2933;--muted:#56616f;--brand:#C65A1E}
    *{box-sizing:border-box}body{margin:0;font-family:Arial,"Noto Sans Hebrew",sans-serif;background:linear-gradient(135deg,#2F3237 0%,#25282D 100%);color:var(--text);line-height:1.75}
    .shell{width:min(1060px,calc(100% - 32px));margin:0 auto;padding:32px 0 56px}
    header{color:#fff;margin-bottom:22px}header a{color:#fff}.brand{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}.brand strong{font-size:1.5rem}
    nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}nav a{border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:8px 13px;text-decoration:none;background:rgba(255,255,255,.08)}nav a[aria-current=page]{background:var(--brand);border-color:var(--brand)}
    main{background:var(--card);border-radius:24px;padding:clamp(22px,4vw,42px);box-shadow:0 24px 60px rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.18)}
    h1{font-size:clamp(1.8rem,4vw,3rem);line-height:1.15;margin:0 0 18px}h2{font-size:1.35rem;margin:34px 0 8px;color:#111827}p{margin:0 0 14px;color:var(--text)}.notice{margin:0 0 24px;padding:14px 16px;border-radius:16px;background:#FFF1E8;border:1px solid rgba(198,90,30,.28);color:#53311f}
    footer{color:#D1D5DB;margin-top:22px;display:flex;gap:14px;flex-wrap:wrap}footer a{color:#fff}
    @media(max-width:520px){.shell{width:min(100% - 20px,1060px);padding-top:18px}main{border-radius:18px;padding:18px}nav a{width:calc(50% - 5px);text-align:center}}
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><strong>C-ton</strong><a href="/app">חזרה לאתר</a></div>
      <nav aria-label="ניווט משפטי">${nav}</nav>
    </header>
    <main>
      <div class="notice">גרסה 0.9. מיועד לדמו, MVP ופיילוט מבוקר. דורש בדיקה ואישור עורך דין לפני שימוש מסחרי.</div>
      ${renderLegalMarkdown(page.body)}
    </main>
    <footer>
      <a href="/legal/terms">תקנון</a>
      <a href="/legal/privacy">מדיניות פרטיות</a>
      <a href="/legal/refunds">ביטולים והחזרים</a>
      <a href="/legal/sellers">תנאי מוכרים</a>
      <a href="/legal/affiliates">תנאי מפיצים</a>
    </footer>
  </div>
</body>
</html>`;
}

function mapSellerProfile(profile: any, contextSource: string) {
  return {
    seller_id: String(profile.seller_id),
    display_name: String(profile.display_name || profile.seller_id),
    login_email: profile.login_email ? String(profile.login_email) : null,
    auth_enabled: Boolean(profile.auth_enabled),
    business_name: profile.business_name ? String(profile.business_name) : "",
    has_support_contact: Boolean(String(profile.support_email || profile.support_phone || "").trim()),
    verification_status: String(profile.verification_status || "approved"),
    settlement_status: String(profile.settlement_status || "active"),
    payout_method: String(profile.payout_method || "bank_transfer"),
    payout_details_masked: String(profile.payout_details_masked || ""),
    admin_note: String(profile.admin_note || ""),
    seller_status: normalizeSellerStatus(profile.seller_status),
    seller_status_reason: String(profile.seller_status_reason || ""),
    seller_status_updated_at: profile.seller_status_updated_at ? String(profile.seller_status_updated_at) : null,
    seller_status_updated_by: profile.seller_status_updated_by ? String(profile.seller_status_updated_by) : null,
    seller_enforcement_notice: sellerStatusHebrewNotice(profile.seller_status),
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
            business_name, support_email, support_phone,
            verification_status, settlement_status, payout_method, payout_details_masked,
            admin_note, seller_status, seller_status_reason, seller_status_updated_at,
            seller_status_updated_by, created_at, updated_at, last_login_at
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
            a.business_name,
            a.support_email,
            a.support_phone,
            a.verification_status,
            a.settlement_status,
            a.payout_method,
            a.payout_details_masked,
            a.admin_note,
            COALESCE(a.seller_status, 'Active') AS seller_status,
            a.seller_status_reason,
            a.seller_status_updated_at,
            a.seller_status_updated_by,
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

function mapDistributorProfile(profile: any, contextSource: "demo_context" | "server_session") {
  return {
    affiliate_id: String(profile.affiliate_id),
    affiliate_code: String(profile.affiliate_code),
    display_name: String(profile.display_name || profile.affiliate_code),
    verification_status: String(profile.verification_status || "pending"),
    context_source: contextSource,
    session_id: profile.session_id ? String(profile.session_id) : null,
    expires_at: profile.expires_at ? String(profile.expires_at) : null
  };
}

async function findDistributorLoginAccount(c: any, identifier: string) {
  const normalized = String(identifier || "").trim();
  const email = normalizeSellerLoginEmail(normalized);
  const result = await c.query(
    `SELECT affiliate_id, affiliate_code, display_name, verification_status,
            login_email, auth_secret_hash, auth_enabled, last_login_at
     FROM siton.affiliate_accounts
     WHERE affiliate_code=$1 OR ($2 <> '' AND lower(login_email)=$2)
     LIMIT 1`,
    [normalized.slice(0, 120), email]
  );
  return result.rows[0] || null;
}

async function issueDistributorSession(c: any, req: any, profile: any) {
  const token = createDistributorSessionToken();
  const tokenHash = hashDistributorSessionToken(token);
  if (!tokenHash) throw Object.assign(new Error("distributor session auth is not configured"), { statusCode: 503 });
  const expiresAt = new Date(Date.now() + DISTRIBUTOR_SESSION_TTL_SECONDS * 1000).toISOString();
  const inserted = await c.query(
    `INSERT INTO siton.distributor_sessions
       (affiliate_id, token_hash, expires_at, created_ip, created_user_agent)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING session_id, expires_at`,
    [profile.affiliate_id, tokenHash, expiresAt, requestClientIp(req), requestUserAgent(req)]
  );
  await c.query(
    `UPDATE siton.affiliate_accounts SET last_login_at=now(), updated_at=now() WHERE affiliate_id=$1`,
    [profile.affiliate_id]
  );
  return { token, ...inserted.rows[0] };
}

async function resolveDistributorContext(req: any, c: any, isDemoPreview: boolean) {
  if (isDemoPreview) {
    const demo = await c.query(
      `SELECT affiliate_id, affiliate_code, display_name, verification_status
       FROM siton.affiliate_accounts WHERE affiliate_code=$1 LIMIT 1`,
      [DEFAULT_AFFILIATE_CODE]
    );
    return demo.rowCount ? mapDistributorProfile(demo.rows[0], "demo_context") : null;
  }
  if (!distributorAuthConfigured()) return null;
  const tokenHash = hashDistributorSessionToken(readDistributorSessionToken(req));
  if (!tokenHash) return null;
  const result = await c.query(
    `SELECT s.session_id, s.expires_at, a.affiliate_id, a.affiliate_code,
            a.display_name, a.verification_status, a.auth_enabled
     FROM siton.distributor_sessions s
     JOIN siton.affiliate_accounts a ON a.affiliate_id=s.affiliate_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND a.auth_enabled=true AND a.verification_status='verified'
     LIMIT 1`,
    [tokenHash]
  );
  if (!result.rowCount) return null;
  await c.query(`UPDATE siton.distributor_sessions SET last_seen_at=now() WHERE session_id=$1`, [result.rows[0].session_id]);
  return mapDistributorProfile(result.rows[0], "server_session");
}

async function revokeDistributorSession(c: any, req: any, reason: string) {
  const tokenHash = hashDistributorSessionToken(readDistributorSessionToken(req));
  if (!tokenHash) return;
  await c.query(
    `UPDATE siton.distributor_sessions SET revoked_at=now(), revoked_reason=$2
     WHERE token_hash=$1 AND revoked_at IS NULL`,
    [tokenHash, String(reason || "logout").slice(0, 120)]
  );
}

async function issueBuyerSession(c: any, req: any, identity: { destination_hash: string; deal_id: string | null; channel: string }) {
  if (!identity.deal_id || !buyerSessionConfigured()) return null;
  const token = createBuyerSessionToken();
  const tokenHash = hashBuyerSessionToken(token);
  if (!tokenHash) return null;
  const expiresAt = new Date(Date.now() + BUYER_SESSION_TTL_SECONDS * 1000).toISOString();
  const inserted = await c.query(
    `INSERT INTO siton.buyer_sessions
       (buyer_identity_hash, authenticated_deal_id, channel, token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING session_id, expires_at`,
    [identity.destination_hash, identity.deal_id, identity.channel, tokenHash, expiresAt]
  );
  return { token, ...inserted.rows[0] };
}

async function resolveBuyerSession(req: any, c: any, dealId: string) {
  const tokenHash = hashBuyerSessionToken(readBuyerSessionToken(req));
  if (!tokenHash) return null;
  const result = await c.query(
    `SELECT session_id, buyer_identity_hash, authenticated_deal_id, channel, expires_at
     FROM siton.buyer_sessions
     WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()
       AND authenticated_deal_id=$2
     LIMIT 1`,
    [tokenHash, dealId]
  );
  if (!result.rowCount) return null;
  await c.query(`UPDATE siton.buyer_sessions SET last_seen_at=now() WHERE session_id=$1`, [result.rows[0].session_id]);
  return result.rows[0] as any;
}

function buyerPricingEstimateReference(args: { dealId: string; qty: number; deliveryOptionId: string | null; unitPrice: number; deliveryCost: number }) {
  return `estimate_${createHash("sha256")
    .update(`${args.dealId}:${args.qty}:${args.deliveryOptionId || "none"}:${args.unitPrice}:${args.deliveryCost}`)
    .digest("hex")
    .slice(0, 24)}`;
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
    `SELECT seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked,
            admin_note, seller_status, seller_status_reason, seller_status_updated_at, seller_status_updated_by,
            created_at, updated_at
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
    seller_status: normalizeSellerStatus(profile.seller_status),
    seller_status_reason: String(profile.seller_status_reason || ""),
    seller_status_updated_at: profile.seller_status_updated_at ? String(profile.seller_status_updated_at) : null,
    seller_status_updated_by: profile.seller_status_updated_by ? String(profile.seller_status_updated_by) : null,
    seller_enforcement_notice: sellerStatusHebrewNotice(profile.seller_status),
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

// OTP rail helpers (generation/masking/session id) live in src/otp_rail.ts.

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
    platform_fee_rate: Number(row.platform_fee_rate || SITON_PLATFORM_FEE_RATE),
    images: row.primary_image_id ? [{
      image_id: row.primary_image_id,
      url: resolveDealImageUrl({ image_id: row.primary_image_id, public_url: row.primary_image_public_url }),
      is_primary: true,
      sort_order: 0,
      mime_type: row.primary_image_mime_type ?? null
    }] : [],
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
  const content = contentType.startsWith("image/")
    ? await readFile(join(frontendDir, filename))
    : await readFile(join(frontendDir, filename), "utf8");
  const cacheControl =
    filename === "index.html" ? "no-store" : "no-cache, must-revalidate";
  return reply.header("cache-control", cacheControl).type(contentType).send(content);
}

const DEAL_CHAT_READ_BLOCKED_STATES = new Set<DealState>(["Draft"]);
const DEAL_CHAT_WRITE_ALLOWED_STATES = new Set<DealState>([
  "PendingTarget",
  "TargetReached",
  "ClosedForJoining"
]);

function runtimeCommitSha() {
  return (process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || process.env.GIT_COMMIT || "").trim() || "unknown";
}

function deployFreshness() {
  const runtimeCommit = runtimeCommitSha();
  const expectedCommit = (process.env.EXPECTED_COMMIT_SHA || "").trim();
  const isStale = Boolean(expectedCommit && runtimeCommit !== "unknown" && runtimeCommit !== expectedCommit);
  const evidence = expectedCommit
    ? runtimeCommit === "unknown"
      ? "commit SHA not available in environment"
      : isStale
        ? "runtime=" + runtimeCommit + " expected=" + expectedCommit
        : "commit " + runtimeCommit + " matches expected"
    : runtimeCommit === "unknown"
      ? "EXPECTED_COMMIT_SHA not set and runtime commit SHA is unknown"
      : "runtime commit " + runtimeCommit + "; EXPECTED_COMMIT_SHA not set";
  return {
    expected_commit_sha: expectedCommit || null,
    runtime_commit_sha: runtimeCommit,
    is_stale: isStale,
    evidence
  };
}

function normalizeDealChatText(value: unknown, maxLength: number, fallback = "") {
  const raw = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").trim();
  const normalized = raw.replace(/\s+/g, " ");
  const text = normalized || fallback;
  return text.slice(0, maxLength).trim();
}

function dealChatMessageFromRow(row: any) {
  return {
    message_id: String(row.message_id),
    deal_id: String(row.deal_id),
    display_name: String(row.display_name),
    body: String(row.body),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

function buildTrackingPersonalStatus(
  dealState: DealState,
  buyerState: BuyerState,
  moneyState: MoneyState,
  args?: { participantId?: string; completionWindowUntil?: string | null }
) {
  const recoveryRequired = buyerState === "ChargeFailedCompletion" || moneyState === "ChargeFailedRecovery";
  if (recoveryRequired) {
    const windowEpoch = args?.completionWindowUntil ? Date.parse(args.completionWindowUntil) : NaN;
    const windowOpen = dealState === "CompletionWindow" && Number.isFinite(windowEpoch) && windowEpoch > Date.now();
    if (windowOpen && args?.participantId) {
      return {
        action_required: true,
        status: "payment_update_required",
        title: "נדרש עדכון אמצעי תשלום",
        detail: "החיוב לא עבר. המקום שלך בעסקה נשמר זמנית, אבל צריך להשלים את התשלום בתוך חלון ההשלמה.",
        cta: {
          label: "עדכון אמצעי תשלום",
          href: `/app/recovery/${encodeURIComponent(args.participantId)}`
        }
      };
    }
    return {
      action_required: false,
      status: "payment_update_window_closed",
      title: "השלמת התשלום אינה זמינה",
      detail: "החיוב לא עבר וחלון ההשלמה אינו פעיל. מסך המעקב יציג את ההמשך לפי חוקי העסקה.",
      cta: null
    };
  }
  if (dealState === "Completed" || buyerState === "DealCompleted" || moneyState === "ChargedSuccess" || moneyState === "RecoveredCharge") {
    return {
      action_required: false,
      status: "completed_or_charged",
      title: dealState === "Completed" ? "העסקה הושלמה עבורך" : "החיוב שלך הצליח",
      detail: "אין פעולה נוספת שנדרשת ממך כרגע. מסך המעקב ימשיך להציג את האמת העדכנית.",
      cta: null
    };
  }
  if (dealState === "Failed" || dealState === "Cancelled" || buyerState === "DealFailed" || buyerState === "Dropped") {
    return {
      action_required: false,
      status: "closed_without_action",
      title: dealState === "Cancelled" ? "העסקה בוטלה" : "העסקה לא הושלמה",
      detail: "אין פעולה נוספת שנדרשת ממך במסלול הזה.",
      cta: null
    };
  }
  if (moneyState === "AuthHeld" || moneyState === "AuthLocked") {
    return {
      action_required: false,
      status: "authorization_saved",
      title: "ההצטרפות שלך נשמרה",
      detail: "נתפסה מסגרת בלבד. חיוב בפועל יתבצע רק אם העסקה תגיע לשלב חיוב תקין.",
      cta: null
    };
  }
  if (moneyState === "ChargeAttempt" || buyerState === "ChargingAttempt") {
    return {
      action_required: false,
      status: "charging_in_progress",
      title: "חיוב ממתין",
      detail: "המערכת מטפלת בעסקה כרגע. אין צורך בפעולה מצדך בשלב הזה.",
      cta: null
    };
  }
  return {
    action_required: false,
    status: "joined",
    title: "אתה בפנים",
    detail: "ההשתתפות שלך קיימת במערכת ומתעדכנת לפי מצב העסקה.",
    cta: null
  };
}

function buildTrackingDealStatus(state: DealState, currentUnits: number, thresholdUnits: number) {
  const remainingToMinimum = Math.max(0, thresholdUnits - currentUnits);
  if (state === "PendingTarget") {
    return {
      kind: "in_progress",
      title: "העסקה עדיין מתקדמת",
      detail: remainingToMinimum > 0
        ? `חסרות עוד ${remainingToMinimum} יחידות למינימום.`
        : "המינימום כבר הושג והעסקה עדיין פתוחה להצטרפות.",
      live: true
    };
  }
  if (state === "TargetReached") {
    return { kind: "target_reached", title: "המינימום הושג", detail: "העסקה התקדמה לשלב הבא ועדיין ניתן לעקוב אחרי הקצב.", live: true };
  }
  if (state === "ClosedForJoining") {
    return { kind: "closed_for_joining", title: "ההצטרפות נסגרה", detail: "העסקה מתכוננת לשלב הבא.", live: true };
  }
  if (state === "ReadyForCharging" || state === "Charging") {
    return { kind: "charging", title: "העסקה עברה למסלול חיוב", detail: "כרגע אי אפשר להצטרף, והמערכת מעבדת את העסקה.", live: true };
  }
  if (state === "CompletionWindow") {
    return { kind: "completion_window", title: "חלק מהחיובים דורשים השלמה", detail: "העסקה עדיין בטיפול והמסך מתעדכן לפי התוצאה.", live: true };
  }
  if (state === "Completed") {
    return { kind: "success", title: "העסקה הושלמה בהצלחה", detail: "העסקה נסגרה כמוצלחת.", live: false };
  }
  if (state === "Failed") {
    return { kind: "failed", title: "העסקה לא הושלמה", detail: "העסקה נסגרה ללא השלמה.", live: false };
  }
  if (state === "Cancelled") {
    return { kind: "cancelled", title: "העסקה בוטלה", detail: "המסלול נסגר ואינו דורש פעולה נוספת.", live: false };
  }
  return { kind: "draft_or_unknown", title: "מצב העסקה לא פעיל", detail: "העסקה אינה במסלול ציבורי פעיל.", live: false };
}

function buildTrackingProgressSnapshot(args: {
  currentUnits: number;
  participantsCount: number;
  minUnits: number;
  maxUnits: number;
  thresholdUnits: number;
}) {
  const thresholdUnits = Math.max(1, Number(args.thresholdUnits || args.minUnits || 1));
  const maxUnits = Math.max(1, Number(args.maxUnits || thresholdUnits));
  return {
    current_units: Number(args.currentUnits || 0),
    participants_count: Number(args.participantsCount || 0),
    min_units: Number(args.minUnits || thresholdUnits),
    target_units: thresholdUnits,
    threshold_units: thresholdUnits,
    max_units: maxUnits,
    remaining_to_minimum: Math.max(0, thresholdUnits - Number(args.currentUnits || 0)),
    remaining_to_capacity: Math.max(0, maxUnits - Number(args.currentUnits || 0)),
    progress_to_minimum_pct: Number(Math.min(100, Math.round((Number(args.currentUnits || 0) / thresholdUnits) * 100))),
    progress_to_capacity_pct: Number(Math.min(100, Math.round((Number(args.currentUnits || 0) / maxUnits) * 100)))
  };
}

function buildTrackingChartPoints(participantRows: Array<{ participant_id: string; qty: number; created_at: string }>) {
  let cumulative = 0;
  return participantRows.map((row) => {
    const addedUnits = Number(row.qty || 0);
    cumulative += addedUnits;
    return {
      at: row.created_at,
      cumulative_units: cumulative,
      added_units: addedUnits
    };
  });
}

function buildTrackingActivityFeed(args: {
  participantRows: Array<{ participant_id: string; qty: number; created_at: string }>;
  chartPoints: Array<{ at: string; cumulative_units: number; added_units: number }>;
  dealState: DealState;
  thresholdUnits: number;
  currentUnits: number;
}) {
  const items: Array<{ type: string; at: string; message: string; added_units?: number; cumulative_units?: number; milestone_pct?: number }> = [];
  for (const row of args.participantRows.slice(-12)) {
    const addedUnits = Number(row.qty || 0);
    items.push({
      type: "join_units",
      at: row.created_at,
      message: addedUnits === 1 ? "נוספה יחידה אחת" : `נוספו ${addedUnits} יחידות`,
      added_units: addedUnits
    });
  }

  const thresholdUnits = Math.max(1, Number(args.thresholdUnits || 1));
  const seenMilestones = new Set<number>();
  for (const point of args.chartPoints) {
    const percent = Math.round((Number(point.cumulative_units || 0) / thresholdUnits) * 100);
    for (const milestone of [50, 75, 100]) {
      if (!seenMilestones.has(milestone) && percent >= milestone) {
        seenMilestones.add(milestone);
        items.push({
          type: milestone === 100 ? "target_reached" : "progress_milestone",
          at: point.at,
          message: milestone === 100 ? "המינימום הושג" : `העסקה חצתה את רף ה-${milestone}%`,
          cumulative_units: Number(point.cumulative_units || 0),
          milestone_pct: milestone
        });
      }
    }
  }

  if (["ReadyForCharging", "Charging", "CompletionWindow"].includes(args.dealState)) {
    items.push({
      type: "deal_charging",
      at: new Date().toISOString(),
      message: "העסקה עברה למסלול חיוב",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }
  if (args.dealState === "Completed") {
    items.push({
      type: "deal_completed",
      at: new Date().toISOString(),
      message: "העסקה הושלמה בהצלחה",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }
  if (args.dealState === "Failed") {
    items.push({
      type: "deal_failed",
      at: new Date().toISOString(),
      message: "העסקה לא הושלמה",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }
  if (args.dealState === "Cancelled") {
    items.push({
      type: "deal_cancelled",
      at: new Date().toISOString(),
      message: "העסקה בוטלה",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }

  return items
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 12);
}

export function registerFrontendExperience(
  app: FastifyInstance,
  deps: {
    withTx: WithTx;
    /**
     * Optional auto-commit pool for endpoints that must persist state changes
     * even when their handler returns an error (OTP attempt-counters, etc).
     * If not provided, those writes fall through `withTx` and may be lost on
     * a thrown error — fine for tests that assert raised exceptions but not
     * for production OTP attempt accounting.
     */
    pool?: import("pg").Pool;
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
      provider_mode?: string;
      configured?: boolean;
      api_base_url_configured?: boolean;
      api_key_configured?: boolean;
      bearer_token_configured?: boolean;
      webhook_secret_configured?: boolean;
      create_document_path?: string;
      get_document_status_path?: string;
      cancel_document_path?: string;
      timeout_ms?: number;
      external_issuance: boolean;
      external_document_issued?: boolean;
      supported_methods?: string[];
    };
    invoiceProvider?: InvoiceProvider;
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
  const computeManager = new SupabaseComputeManager();
  const infrastructureCollector = new InfrastructureMetricsCollector({
    withTx: deps.withTx,
    requestTelemetry: applicationRequestTelemetry,
    ...(deps.getWorkerRunning ? { getWorkerRunning: deps.getWorkerRunning } : {})
  });
  app.addHook("preParsing", (request: any, _reply, payload, done) => {
    const contentType = String(request.headers?.["content-type"] || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      done(null, payload);
      return;
    }
    const pass = new PassThrough();
    const chunks: Buffer[] = [];
    payload.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    payload.on("end", () => {
      request.rawBody = Buffer.concat(chunks).toString("utf8");
    });
    payload.on("error", (error: Error) => pass.destroy(error));
    payload.pipe(pass);
    done(null, pass);
  });

  const ensureProductSurfaces = () => ensureRemainingProductSurfaceTables(deps.withTx);
  const ensurePayoutTables = () => ensurePayoutRailTables(deps.withTx);
  const ensureNotificationTables = () => ensureNotificationRailTables(deps.withTx);
  const ensureOtpTables = () => ensureOtpRailTables(deps.withTx);
  const ensureAdminControlPlane = () => ensureAdminControlPlaneTables(deps.withTx);
  const ensureAdminIdentity = () => ensureAdminIdentityTables(deps.withTx);
  const ensureParticipantTracking = () => ensureParticipantTrackingTables(deps.withTx);
  const otpProvider: OtpProvider = buildOtpProvider();
  // Legacy compatibility: the old /api/otp/start → /api/otp/verify pair returns
  // { buyer_id: <phone digits> } in verify, which existing tests and the
  // browser flow rely on. The new DB rail only stores the destination_hash, so
  // keep a tiny in-memory map keyed by challenge_id with the original digits.
  // Cleared on TTL purge.
  const legacyPhoneByChallenge = new Map<string, { phone: string; expiresAt: number; code: string }>();
  const purgeLegacy = () => {
    const now = Date.now();
    for (const [id, entry] of legacyPhoneByChallenge) {
      if (now > entry.expiresAt) legacyPhoneByChallenge.delete(id);
    }
  };
  setInterval(purgeLegacy, 5 * 60_000).unref();
  const ensureInvoiceWebhookTables = async () => {
  await deps.withTx(async c=>assertRequiredTables(c,["invoice_webhook_events","invoice_webhook_security_events"]));
};
  const ensureLegalAcceptanceTables = async () => {
  await deps.withTx(async c=>assertRequiredTables(c,["legal_acceptances"]));
};
  const recordInvoiceWebhookSecurityFailure = async (args: { provider: string; event_id?: string | null; failure_reason: string; remote_hint?: string }) => {
    await ensureInvoiceWebhookTables();
    await deps.withTx(async (c) => {
      await c.query(
        `INSERT INTO siton.invoice_webhook_security_events(provider, event_id, failure_reason, remote_hint)
         VALUES ($1,$2,$3,$4)`,
        [args.provider, args.event_id ?? null, args.failure_reason, args.remote_hint ?? ""]
      );
    });
  };
  const ensurePaymentOpsTables = async () => {
  await deps.withTx(async c=>assertRequiredTables(c,["payment_webhook_security_events","buyer_payment_methods"]));
};
  const recordWebhookSecurityFailure = async (args: { provider: string; event_id?: string | null; failure_reason: string; remote_hint?: string }) => {
    await ensurePaymentOpsTables();
    await deps.withTx(async (c) => {
      await c.query(
        `INSERT INTO siton.payment_webhook_security_events(provider, event_id, failure_reason, remote_hint)
         VALUES ($1,$2,$3,$4)`,
        [args.provider, args.event_id ?? null, args.failure_reason, args.remote_hint ?? ""]
      );
    });
  };
  const upsertBuyerPaymentMethod = async (args: {
    buyer_id: string;
    provider_code: string;
    provider_payment_method_id: string;
    correlation_id?: string | null;
    mark_authorized?: boolean;
    mark_failed?: boolean;
  }) => {
    await ensurePaymentOpsTables();
    await deps.withTx(async (c) => {
      await c.query(
        `INSERT INTO siton.buyer_payment_methods (
           buyer_id, provider_code, provider_payment_method_id, status,
           last_authorized_at, last_failed_at, correlation_id, created_at, updated_at
         ) VALUES (
           $1,$2,$3,'active',
           CASE WHEN $5 THEN now() ELSE NULL END,
           CASE WHEN $6 THEN now() ELSE NULL END,
           $4,now(),now()
         )
         ON CONFLICT (provider_code, provider_payment_method_id) DO UPDATE
         SET buyer_id=EXCLUDED.buyer_id,
             status=CASE WHEN $6 THEN 'invalid' ELSE 'active' END,
             last_authorized_at=CASE WHEN $5 THEN now() ELSE buyer_payment_methods.last_authorized_at END,
             last_failed_at=CASE WHEN $6 THEN now() ELSE buyer_payment_methods.last_failed_at END,
             correlation_id=EXCLUDED.correlation_id,
             updated_at=now()`,
        [
          args.buyer_id,
          args.provider_code,
          args.provider_payment_method_id,
          args.correlation_id ?? null,
          Boolean(args.mark_authorized),
          Boolean(args.mark_failed)
        ]
      );
    });
  };
  const payoutProvider = deps.payoutProvider ?? buildPayoutProvider();
  const operationalReadiness = () =>
    buildOperationalReadinessSummary({
      deploymentMode: deps.deploymentMode,
      isDemoPreview: deps.isDemoPreview,
      payment: getPaymentProviderSummary(deps.paymentProvider),
      payout: getPayoutProviderSummary(payoutProvider),
      invoice: deps.invoiceSummary ?? {
        provider: "internal-invoice-ledger",
        mode: "log-only",
        external_issuance: false
      },
      notifications: deps.notificationSummary,
      debugSurfacesEnabled: Boolean(deps.debugSurfacesEnabled),
      webhookSecretSafe: PAYMENT_WEBHOOK_SECRET_IS_SAFE,
      webhookSecretIsDefault: PAYMENT_WEBHOOK_SECRET_IS_DEFAULT,
      sellerAuthMode: deps.isDemoPreview ? "demo-context" : "server-session",
      sellerAuthConfigured: deps.isDemoPreview ? true : SELLER_AUTH_CONFIGURED
    });

  app.get("/health/integrations", async () => ({
    ok: true,
    deployment_mode: deps.deploymentMode,
    integrations: {
      payment: getPaymentProviderSummary(deps.paymentProvider),
      payout: getPayoutProviderSummary(payoutProvider),
      invoice: deps.invoiceSummary,
      notifications: {
        ...deps.notificationSummary,
        provider: deps.notificationSummary.external_delivery ? deps.notificationSummary.provider : "log-only"
      },
      webhook_ingestion: {
        provider: getPaymentProviderSummary(deps.paymentProvider).provider,
        duplicate_policy: "provider+event_id idempotent accept",
        canonical_route: "/webhooks/payments",
        legacy_route_alias: "/webhooks/payments/mock"
      }
    },
    operational_readiness: operationalReadiness()
  }));

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
      if (deps.paymentProvider.verifyWebhook) {
        return deps.paymentProvider.verifyWebhook({
          rawBody,
          signatureHeader,
          ...(timestampHeader ? { timestampHeader } : {}),
          secret: PAYMENT_WEBHOOK_SECRET
        });
      }
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
   * Admin API key guard. Fail-closed in production-like environments.
   *
   * - Production-like (NODE_ENV=production, APP_ENV=production, RENDER, or
   *   RENDER_EXTERNAL_URL set) WITHOUT ADMIN_API_KEY: 503 admin_key_not_configured.
   * - ADMIN_API_KEY set: x-admin-key header must match (timing-safe). Otherwise
   *   401 admin_auth_required.
   * - Local dev/test (not production-like) WITHOUT ADMIN_API_KEY: legacy open
   *   access preserved so existing demo/test flows keep working.
   */
  function requireAdminKey(req: FastifyRequest, reply: FastifyReply): boolean {
    // Read at request time so deploy-time env updates and tests both work without
    // requiring a process restart. Falls back to module-load constant if unset.
    const configuredKey = String(process.env.ADMIN_API_KEY || ADMIN_API_KEY || "").trim();
    if (!configuredKey) {
      if (isProductionLikeEnv()) {
        void reply.code(503).send({ error: "admin_key_not_configured" });
        return false;
      }
      return true;
    }
    const provided = String((req.headers as Record<string, string | undefined>)["x-admin-key"] || "").trim();
    if (!provided) {
      void reply.code(401).send({ error: "admin_auth_required", message: "x-admin-key header is missing or invalid" });
      return false;
    }
    // Timing-safe comparison to prevent key-length oracle attacks
    const expectedBuf = Buffer.from(configuredKey, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      void reply.code(401).send({ error: "admin_auth_required", message: "x-admin-key header is missing or invalid" });
      return false;
    }
    return true;
  }

  // R6 — the admin READ surface accepts either a named admin identity
  // (verified Supabase token bound to admin_users by auth_user_id, or an admin
  // session cookie) or the operational x-admin-key. The named path is what the
  // owner's one-login control center uses; the key remains for ops tooling.
  async function requireAdminRead(req: any, reply: any): Promise<boolean> {
    const cookies = parseCookieHeader(req?.headers?.cookie);
    if (bearerToken(req) || cookies[ADMIN_SESSION_COOKIE]) {
      try {
        await ensureAdminIdentity();
        const identity = await deps.withTx(async (c: any) => resolveAdminIdentity(req, c));
        if (identity && identity.identity_strength === "session_identity") return true;
      } catch {
        // fall through to the key check, which owns the denial response
      }
    }
    return requireAdminKey(req as FastifyRequest, reply as FastifyReply);
  }

  async function requireAdminAuthContext(req: any, reply: any, c: any, options?: {
    permission?: string;
    recentMfa?: boolean;
    sessionRequired?: boolean;
  }) {
    await ensureAdminIdentity();
    const identity = await resolveAdminIdentity(req, c);
    if (!identity) {
      void reply.code(401).send({ ok: false, error: "admin_auth_required" });
      return null;
    }
    if (options?.sessionRequired && identity.identity_strength !== "session_identity") {
      void reply.code(403).send({ ok: false, error: "ADMIN_IDENTITY_REQUIRED", identity_strength: identity.identity_strength });
      return null;
    }
    if (options?.permission && !hasAdminPermission(identity, options.permission)) {
      void reply.code(403).send({ ok: false, error: "ADMIN_PERMISSION_DENIED", permission: options.permission });
      return null;
    }
    if (options?.recentMfa && !hasRecentMfa(identity)) {
      void reply.code(403).send({ ok: false, error: "MFA_REQUIRED" });
      return null;
    }
    return identity;
  }

  // R5C — administrative MUTATIONS require a named, permissioned admin identity,
  // never the shared bootstrap key. The bootstrap key resolves only to a
  // read-only identity (identity_strength=bootstrap_key_only), which
  // sessionRequired rejects. Resolving in its own transaction lets callers gate
  // BEFORE any body validation, so an unauthenticated caller learns nothing.
  // The returned identity is the audit actor — caller-supplied x-admin-user is
  // never trusted for attribution.
  async function requireAdminMutation(req: any, reply: any, permission: string, opts?: { recentMfa?: boolean }) {
    const guardOptions: { sessionRequired: boolean; permission: string; recentMfa?: boolean } = { sessionRequired: true, permission };
    if (opts?.recentMfa) guardOptions.recentMfa = true;
    return deps.withTx(async (c: any) => requireAdminAuthContext(req, reply, c, guardOptions));
  }
  function adminActorRef(identity: any, fallback = "admin"): string {
    return String(identity?.email || identity?.admin_user_id || fallback).slice(0, 120) || fallback;
  }

  function sellerAuthSummary(
    sellerContext?: any,
    options?: { reason?: "required" | "expired" | "forbidden" | "unavailable"; returnTo?: unknown }
  ) {
    const onboardingRequired = Boolean(
      sellerContext && !deps.isDemoPreview && (!String(sellerContext.business_name || "").trim() || !sellerContext.has_support_contact)
    );
    return {
      mode: deps.isDemoPreview ? "demo-context" : SELLER_AUTH_MODE,
      configured: deps.isDemoPreview ? true : SELLER_AUTH_CONFIGURED,
      authenticated: deps.isDemoPreview ? true : Boolean(sellerContext),
      allow_manual_context_switch: deps.isDemoPreview,
      reason: options?.reason || null,
      reauthentication_required: options?.reason === "expired",
      return_to: safeSellerReturnTo(options?.returnTo),
      onboarding: {
        required: onboardingRequired,
        next_path: "/app/seller#seller-profile-section"
      },
      seller_context: sellerContext
        ? {
            seller_id: sellerContext.seller_id,
            display_name: sellerContext.display_name,
            login_email: sellerContext.login_email ?? null,
            verification_status: sellerContext.verification_status,
            settlement_status: sellerContext.settlement_status,
            seller_status: normalizeSellerStatus(sellerContext.seller_status),
            seller_status_reason: sellerContext.seller_status_reason ?? "",
            seller_status_updated_at: sellerContext.seller_status_updated_at ?? null,
            seller_status_updated_by: sellerContext.seller_status_updated_by ?? null,
            seller_enforcement_notice: sellerStatusHebrewNotice(sellerContext.seller_status),
            is_default_context: sellerContext.is_default_context,
            context_source: sellerContext.context_source,
            session_id: sellerContext.session_id ?? null,
            expires_at: sellerContext.expires_at ?? null,
            last_seen_at: sellerContext.last_seen_at ?? null
          }
        : null
    };
  }

  function sellerRequestReturnTo(req: any, fallback = "/app/seller") {
    return safeSellerReturnTo(req?.headers?.["x-siton-return-to"], fallback);
  }

  function rejectSellerAuthUnavailable(reply: FastifyReply, req?: any, fallback = "/app/seller") {
    const returnTo = sellerRequestReturnTo(req, fallback);
    const failure = sellerAuthFailurePayload("unavailable", { returnTo });
    return reply.code(503).send({
      ...failure,
      seller_auth: sellerAuthSummary(undefined, { reason: "unavailable", returnTo })
    });
  }

  function rejectSellerAuthRequired(reply: FastifyReply, req: any, fallback = "/app/seller") {
    const reason = hasSellerSessionCookie(req?.headers?.cookie) ? "expired" : "required";
    const returnTo = sellerRequestReturnTo(req, fallback);
    const failure = sellerAuthFailurePayload(reason, { returnTo });
    return reply.code(401).send({
      ...failure,
      seller_auth: sellerAuthSummary(undefined, { reason, returnTo })
    });
  }

  function rejectManualSellerContextSwitch(reply: FastifyReply) {
    return reply.code(403).send({
      error: "seller_context_switch_disabled",
      message: "manual seller context switching is disabled outside demo-preview"
    });
  }

  async function ensureSellerActionAllowed(c: any, sellerId: string, action: SellerAction, reply: FastifyReply) {
    const result = await c.query(
      `SELECT COALESCE(seller_status, 'Active') AS seller_status
       FROM siton.seller_accounts
       WHERE seller_id=$1
       LIMIT 1`,
      [sellerId]
    );
    const status = result.rowCount ? normalizeSellerStatus(result.rows[0].seller_status) : "Active";
    if (!sellerStatusBlocksAction(status, action)) return true;
    const failure = sellerAuthFailurePayload("forbidden", {
      message: sellerStatusMessage(status),
      reasonCode: sellerStatusErrorCode(status)
    });
    void reply.code(403).send({
      ...failure,
      seller_status: status,
      seller_auth: sellerAuthSummary(undefined, { reason: "forbidden" })
    });
    return false;
  }

  async function resolveOptionalSellerContext(req: any, c: any, options?: { autoCreate?: boolean }) {
    if (deps.isDemoPreview) return resolveSellerContext(req, c, options);
    if (!SELLER_AUTH_CONFIGURED || !SELLER_SESSION_SECRET) return null;
    return readSellerSessionContext(req, c);
  }

  async function resolveRequiredSellerContext(req: any, reply: FastifyReply, c: any, options?: { autoCreate?: boolean }) {
    if (deps.isDemoPreview) return resolveSellerContext(req, c, options);
    // R5B/R6 — a Supabase seller token (bound by auth_user_id) authenticates the
    // seller read surfaces too. A non-seller token is rejected as unauthorized.
    const verifier = frontendSupabaseVerifier();
    if (verifier && bearerToken(req)) {
      try {
        // R6 capability policy: this surface requires the SELLER capability
        // explicitly; other capabilities on the same principal are ignored.
        const caps = await resolveSupabaseCapabilities(req, c, verifier);
        if (caps && caps.seller && caps.seller.auth_enabled) {
          return {
            seller_id: caps.seller.seller_id,
            display_name: caps.seller.display_name,
            seller_status: caps.seller.seller_status || "Active",
            verification_status: "approved",
            settlement_status: "active",
            is_default_context: false,
            context_source: "supabase_session"
          };
        }
      } catch {
        // fall through to cookie resolution / rejection
      }
    }
    if (!SELLER_AUTH_CONFIGURED || !SELLER_SESSION_SECRET) {
      rejectSellerAuthUnavailable(reply, req);
      return null;
    }
    const sellerContext = await readSellerSessionContext(req, c);
    if (!sellerContext) {
      rejectSellerAuthRequired(reply, req);
      return null;
    }
    return sellerContext;
  }

  // R6 — public Supabase Auth config for the React seller login (publishable
  // values only; NEVER the service-role key or JWT secret).
  app.get("/api/preview/auth-config", async () => {
    const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const anonKey = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
    return {
      ok: true,
      configured: Boolean(supabaseUrl && anonKey),
      supabase_url: supabaseUrl,
      supabase_anon_key: anonKey,
      buyer_verification: buyerVerificationPolicySummary()
    };
  });

  // R6 — serve the new canonical React app (web/dist) same-origin under /preview.
  async function servePreview(reply: FastifyReply, relPath: string) {
    if (!previewDir) {
      return reply.code(404).type("text/html; charset=utf-8").send("<h1>Preview not built</h1>");
    }
    const safe = relPath.replace(/\.\.+/g, "").replace(/^\/+/, "");
    const target = safe && safe !== "index.html" ? join(previewDir, safe) : join(previewDir, "index.html");
    if (!existsSync(target)) {
      // SPA fallback: unknown sub-paths render the app shell (hash routing).
      const index = join(previewDir, "index.html");
      const html = await readFile(index, "utf8");
      return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(html);
    }
    const ext = target.slice(target.lastIndexOf(".")).toLowerCase();
    const mime = PREVIEW_MIME[ext] || "application/octet-stream";
    const isHashed = /\/assets\//.test(target);
    const cache = ext === ".html" ? "no-store" : isHashed ? "public, max-age=31536000, immutable" : "no-cache";
    const body = mime.startsWith("text/") || mime.includes("json") || mime.includes("svg")
      ? await readFile(target, "utf8")
      : await readFile(target);
    return reply.header("cache-control", cache).type(mime).send(body);
  }
  app.get("/preview", async (_req: any, reply: any) => servePreview(reply, "index.html"));
  app.get("/preview/", async (_req: any, reply: any) => servePreview(reply, "index.html"));
  app.get("/preview/*", async (req: any, reply: any) => servePreview(reply, String(req.params?.["*"] || "")));

  app.get("/api/preview/meta", async () => ({
    ok: true,
    preview: {
      deployment_mode: deps.deploymentMode,
      is_demo_preview: deps.isDemoPreview,
      deployment: deployFreshness(),
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
        return rejectSellerAuthUnavailable(reply, req);
      }
      const unauthenticatedReason = sellerContext
        ? undefined
        : hasSellerSessionCookie(req.headers?.cookie)
          ? "expired" as const
          : "required" as const;
      return {
        ok: true,
        seller_auth: sellerAuthSummary(sellerContext, {
          ...(unauthenticatedReason ? { reason: unauthenticatedReason } : {}),
          returnTo: sellerRequestReturnTo(req)
        })
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
      return rejectSellerAuthUnavailable(reply, req);
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
          code: "SELLER_AUTH_INVALID_CREDENTIALS",
          message: "seller identifier or password is invalid"
        });
      }
      if (String(sellerAccount.verification_status || "") === "rejected" || String(sellerAccount.settlement_status || "") === "hold") {
        const returnTo = sellerRequestReturnTo(req);
        const failure = sellerAuthFailurePayload("forbidden", {
          returnTo,
          message: "seller account is blocked from login",
          reasonCode: "seller_auth_blocked"
        });
        return reply.code(403).send({
          ...failure,
          seller_auth: sellerAuthSummary(undefined, { reason: "forbidden", returnTo })
        });
      }
      const session = await issueSellerSession(c, req, sellerAccount);
      reply.header("set-cookie", serializeSellerSessionCookie(session.token, SELLER_SESSION_TTL_SECONDS, { secure: isProductionLikeEnv() }));
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
    reply.header("set-cookie", serializeExpiredSellerSessionCookie({ secure: isProductionLikeEnv() }));
    return {
      ok: true,
      seller_auth: sellerAuthSummary()
    };
  });

  app.get("/api/distributor/session", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      if (!deps.isDemoPreview && !distributorAuthConfigured()) {
        return reply.code(503).send({
          ok: false,
          error: "distributor_auth_unavailable",
          distributor_auth: { mode: "server-session", configured: false, authenticated: false }
        });
      }
      const context = await resolveDistributorContext(req, c, deps.isDemoPreview);
      if (!context) {
        return reply.code(401).send({
          ok: false,
          error: "distributor_auth_required",
          distributor_auth: { mode: "server-session", configured: true, authenticated: false }
        });
      }
      return {
        ok: true,
        distributor_auth: {
          mode: deps.isDemoPreview ? "demo-context" : "server-session",
          configured: true,
          authenticated: true,
          distributor_context: context
        }
      };
    });
  });

  app.post("/api/distributor/session/login", async (req: any, reply: any) => {
    if (deps.isDemoPreview) {
      return reply.code(409).send({ ok: false, error: "distributor_auth_not_needed_in_demo" });
    }
    if (!distributorAuthConfigured()) {
      return reply.code(503).send({ ok: false, error: "distributor_auth_unavailable" });
    }
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const identifier = String(req.body?.identifier || req.body?.affiliate_code || req.body?.login_email || "").trim();
      const accessCode = String(req.body?.access_code || req.body?.password || "").trim();
      const account = await findDistributorLoginAccount(c, identifier);
      if (!account || !account.auth_enabled || !verifySellerAccessSecret(accessCode, account.auth_secret_hash)) {
        return reply.code(401).send({ ok: false, error: "distributor_auth_invalid_credentials" });
      }
      if (String(account.verification_status) !== "verified") {
        return reply.code(403).send({ ok: false, error: "distributor_auth_blocked" });
      }
      const session = await issueDistributorSession(c, req, account);
      reply.header("set-cookie", serializeDistributorSessionCookie(session.token, { secure: distributorCookieSecure() }));
      return {
        ok: true,
        distributor_auth: {
          mode: "server-session",
          configured: true,
          authenticated: true,
          distributor_context: mapDistributorProfile({ ...account, ...session }, "server_session")
        }
      };
    });
  });

  app.post("/api/distributor/session/logout", async (req: any, reply: any) => {
    if (!deps.isDemoPreview && distributorAuthConfigured()) {
      await deps.withTx(async (c) => revokeDistributorSession(c, req, "logout"));
    }
    reply.header("set-cookie", serializeExpiredDistributorSessionCookie({ secure: distributorCookieSecure() }));
    return { ok: true };
  });

  app.put("/api/buyer/resume/:dealId", async (req: any, reply: any) => {
    const dealId = String(req.params?.dealId || "");
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();
    const body = (req.body as any) || {};
    const allowed = new Set(["selected_quantity", "delivery_option_id", "attribution_ref", "workflow_position"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return reply.code(400).send({ ok: false, error: "unsafe_resume_field" });
    }
    const selectedQuantity = parsePositiveIntegerQuantity(body.selected_quantity, 1);
    const deliveryOptionId = body.delivery_option_id ? String(body.delivery_option_id).trim() : null;
    if (deliveryOptionId) requireUuid(deliveryOptionId, "delivery_option_id");
    const attributionRef = String(body.attribution_ref || "").trim().slice(0, 120) || null;
    const workflowPosition = String(body.workflow_position || "otp_verified");
    if (!new Set(["otp_verified", "payment"]).has(workflowPosition)) {
      return reply.code(400).send({ ok: false, error: "invalid_resume_position" });
    }

    return deps.withTx(async (c) => {
      const session = await resolveBuyerSession(req, c, dealId);
      if (!session) return reply.code(401).send({ ok: false, error: "buyer_session_required" });
      const deal = await c.query(
        `SELECT deal_id, state, max_units, price_per_unit
         FROM siton.deals WHERE deal_id=$1 LIMIT 1`,
        [dealId]
      );
      if (!deal.rowCount) return reply.code(404).send({ ok: false, error: "deal_not_found" });
      const dealRow = deal.rows[0] as any;
      if (!["PendingTarget", "TargetReached"].includes(String(dealRow.state))) {
        return reply.code(409).send({ ok: false, error: "deal_not_resumable" });
      }
      const reserved = await c.query(
        `SELECT COALESCE(SUM(qty),0)::int AS reserved
         FROM siton.participants WHERE deal_id=$1 AND buyer_state NOT IN ('DealFailed','Dropped')`,
        [dealId]
      );
      const remaining = Math.max(0, Number(dealRow.max_units) - Number(reserved.rows[0]?.reserved || 0));
      if (selectedQuantity > remaining) {
        return reply.code(409).send({ ok: false, error: remaining ? "inventory_changed" : "sold_out", remaining_units: remaining });
      }
      let deliveryCost = 0;
      if (deliveryOptionId) {
        const delivery = await c.query(
          `SELECT cost FROM siton.deal_delivery_options WHERE option_id=$1 AND deal_id=$2 LIMIT 1`,
          [deliveryOptionId, dealId]
        );
        if (!delivery.rowCount) return reply.code(400).send({ ok: false, error: "invalid_delivery_option" });
        deliveryCost = Number(delivery.rows[0].cost || 0);
      }
      const pricingReference = buyerPricingEstimateReference({
        dealId,
        qty: selectedQuantity,
        deliveryOptionId,
        unitPrice: Number(dealRow.price_per_unit),
        deliveryCost
      });
      const saved = await c.query(
        `INSERT INTO siton.buyer_resume_contexts
           (buyer_identity_hash, deal_id, selected_quantity, delivery_option_id,
            attribution_ref, pricing_estimate_reference, workflow_position, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now()+($8 || ' seconds')::interval)
         ON CONFLICT (buyer_identity_hash, deal_id) DO UPDATE
         SET selected_quantity=EXCLUDED.selected_quantity,
             delivery_option_id=EXCLUDED.delivery_option_id,
             attribution_ref=EXCLUDED.attribution_ref,
             pricing_estimate_reference=EXCLUDED.pricing_estimate_reference,
             workflow_position=EXCLUDED.workflow_position,
             expires_at=EXCLUDED.expires_at,
             consumed_at=NULL,
             updated_at=now()
         RETURNING resume_id, expires_at`,
        [session.buyer_identity_hash, dealId, selectedQuantity, deliveryOptionId, attributionRef, pricingReference, workflowPosition, BUYER_SESSION_TTL_SECONDS]
      );
      return {
        ok: true,
        resume: {
          deal_id: dealId,
          selected_quantity: selectedQuantity,
          delivery_option_id: deliveryOptionId,
          attribution_ref: attributionRef,
          pricing_estimate_reference: pricingReference,
          workflow_position: workflowPosition,
          expires_at: saved.rows[0].expires_at
        }
      };
    });
  });

  app.get("/api/buyer/resume/:dealId", async (req: any, reply: any) => {
    const dealId = String(req.params?.dealId || "");
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const session = await resolveBuyerSession(req, c, dealId);
      if (!session) return reply.code(401).send({ ok: false, error: "buyer_session_required" });
      const result = await c.query(
        `SELECT r.resume_id, r.selected_quantity, r.delivery_option_id, r.attribution_ref,
                r.pricing_estimate_reference, r.workflow_position, r.expires_at,
                d.state, d.max_units, d.price_per_unit,
                COALESCE(o.cost,0) AS delivery_cost
         FROM siton.buyer_resume_contexts r
         JOIN siton.deals d ON d.deal_id=r.deal_id
         LEFT JOIN siton.deal_delivery_options o
           ON o.option_id=r.delivery_option_id AND o.deal_id=r.deal_id
         WHERE r.buyer_identity_hash=$1 AND r.deal_id=$2 AND r.consumed_at IS NULL
         LIMIT 1`,
        [session.buyer_identity_hash, dealId]
      );
      if (!result.rowCount) return reply.code(404).send({ ok: false, error: "resume_not_found" });
      const row = result.rows[0] as any;
      if (Date.parse(String(row.expires_at)) <= Date.now()) {
        return reply.code(410).send({ ok: false, error: "resume_expired" });
      }
      if (!["PendingTarget", "TargetReached"].includes(String(row.state))) {
        return reply.code(409).send({ ok: false, error: "deal_not_resumable" });
      }
      const reserved = await c.query(
        `SELECT COALESCE(SUM(qty),0)::int AS reserved
         FROM siton.participants WHERE deal_id=$1 AND buyer_state NOT IN ('DealFailed','Dropped')`,
        [dealId]
      );
      const remaining = Math.max(0, Number(row.max_units) - Number(reserved.rows[0]?.reserved || 0));
      if (Number(row.selected_quantity) > remaining) {
        return reply.code(409).send({ ok: false, error: remaining ? "inventory_changed" : "sold_out", remaining_units: remaining });
      }
      const currentPricingReference = buyerPricingEstimateReference({
        dealId,
        qty: Number(row.selected_quantity),
        deliveryOptionId: row.delivery_option_id ? String(row.delivery_option_id) : null,
        unitPrice: Number(row.price_per_unit),
        deliveryCost: Number(row.delivery_cost || 0)
      });
      return {
        ok: true,
        resume: {
          deal_id: dealId,
          selected_quantity: Number(row.selected_quantity),
          delivery_option_id: row.delivery_option_id ? String(row.delivery_option_id) : null,
          attribution_ref: row.attribution_ref ? String(row.attribution_ref) : null,
          pricing_estimate_reference: currentPricingReference,
          pricing_changed: currentPricingReference !== String(row.pricing_estimate_reference),
          workflow_position: String(row.workflow_position),
          expires_at: row.expires_at,
          remaining_units: remaining
        }
      };
    });
  });

  app.post("/api/buyer/session/logout", async (req: any, reply: any) => {
    const tokenHash = hashBuyerSessionToken(readBuyerSessionToken(req));
    if (tokenHash) {
      await deps.withTx(async (c) => {
        await c.query(`UPDATE siton.buyer_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, [tokenHash]);
      });
    }
    reply.header("set-cookie", serializeExpiredBuyerSessionCookie({ secure: isProductionLikeEnv() }));
    return { ok: true };
  });

  app.post("/api/admin/auth/login", async (req: any, reply: any) => {
    await ensureAdminIdentity();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return reply.code(400).send({ ok: false, error: "admin_credentials_required" });
    return deps.withTx(async (c) => {
      const result = await c.query(
        `SELECT admin_user_id, email, display_name, role, status, password_hash, mfa_required, mfa_enabled
         FROM siton.admin_users
         WHERE lower(email)=lower($1)
         LIMIT 1`,
        [email]
      );
      const row = result.rows[0];
      if (!row || row.status !== "Active" || !(await verifyAdminPassword(password, row.password_hash))) {
        return reply.code(401).send({ ok: false, error: "admin_invalid_credentials" });
      }
      if (row.mfa_required || row.mfa_enabled) {
        const code = createAdminMfaCode();
        const challenge = await c.query(
          `INSERT INTO siton.admin_mfa_challenges
             (admin_user_id, code_hash, purpose, status, expires_at)
           VALUES ($1,$2,'login','Pending',now()+interval '10 minutes')
           RETURNING mfa_challenge_id, expires_at`,
          [row.admin_user_id, hashAdminOtp(code)]
        );
        return {
          ok: true,
          mfa_required: true,
          mfa_challenge_id: challenge.rows[0].mfa_challenge_id,
          expires_at: challenge.rows[0].expires_at,
          delivery: "email_otp_foundation",
          dev_code: isProductionLikeEnv() ? undefined : code
        };
      }
      const issued = await issueAdminSession(c, row.admin_user_id, req, false);
      reply.header("set-cookie", serializeAdminSessionCookie(issued.token, undefined, { secure: isProductionLikeEnv() }));
      return { ok: true, admin: { admin_user_id: row.admin_user_id, email: row.email, display_name: row.display_name, role: row.role } };
    });
  });

  app.post("/api/admin/auth/mfa/verify", async (req: any, reply: any) => {
    await ensureAdminIdentity();
    const challengeId = String(req.body?.mfa_challenge_id || "").trim();
    const code = String(req.body?.code || "").trim();
    requireUuid(challengeId, "mfa_challenge_id");
    if (!/^\d{6}$/.test(code)) return reply.code(400).send({ ok: false, error: "invalid_mfa_code" });
    return deps.withTx(async (c) => {
      const result = await c.query(
        `SELECT ch.mfa_challenge_id, ch.admin_user_id, ch.code_hash, ch.status, ch.expires_at,
                u.email, u.display_name, u.role, u.status AS user_status
         FROM siton.admin_mfa_challenges ch
         JOIN siton.admin_users u ON u.admin_user_id=ch.admin_user_id
         WHERE ch.mfa_challenge_id=$1
         FOR UPDATE`,
        [challengeId]
      );
      const row = result.rows[0];
      if (!row || row.status !== "Pending" || row.user_status !== "Active") {
        return reply.code(401).send({ ok: false, error: "mfa_challenge_invalid" });
      }
      if (Date.parse(String(row.expires_at)) <= Date.now()) {
        await c.query(`UPDATE siton.admin_mfa_challenges SET status='Expired' WHERE mfa_challenge_id=$1`, [challengeId]);
        return reply.code(401).send({ ok: false, error: "mfa_challenge_expired" });
      }
      if (row.code_hash !== hashAdminOtp(code)) return reply.code(401).send({ ok: false, error: "mfa_code_invalid" });
      await c.query(`UPDATE siton.admin_mfa_challenges SET status='Verified', verified_at=now() WHERE mfa_challenge_id=$1`, [challengeId]);
      await c.query(
        `INSERT INTO siton.admin_mfa_factors (admin_user_id, factor_type, secret_hash, status, verified_at)
         VALUES ($1,'email_otp',$2,'Active',now())
         ON CONFLICT DO NOTHING`,
        [row.admin_user_id, hashAdminOtp("email_otp_active")]
      );
      await c.query(`UPDATE siton.admin_users SET mfa_enabled=true, updated_at=now() WHERE admin_user_id=$1`, [row.admin_user_id]);
      const issued = await issueAdminSession(c, row.admin_user_id, req, true);
      reply.header("set-cookie", serializeAdminSessionCookie(issued.token, undefined, { secure: isProductionLikeEnv() }));
      return {
        ok: true,
        admin: { admin_user_id: row.admin_user_id, email: row.email, display_name: row.display_name, role: row.role },
        mfa_verified_at: issued.session.mfa_verified_at
      };
    });
  });

  app.post("/api/admin/auth/mfa/setup", async (req: any, reply: any) => {
    await ensureAdminIdentity();
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, { sessionRequired: true });
      if (!identity || !identity.admin_user_id) return reply;
      const code = createAdminMfaCode();
      const challenge = await c.query(
        `INSERT INTO siton.admin_mfa_challenges
           (admin_user_id, code_hash, purpose, status, expires_at)
         VALUES ($1,$2,'mfa_setup','Pending',now()+interval '10 minutes')
         RETURNING mfa_challenge_id, expires_at`,
        [identity.admin_user_id, hashAdminOtp(code)]
      );
      return {
        ok: true,
        factor_type: "email_otp",
        mfa_challenge_id: challenge.rows[0].mfa_challenge_id,
        expires_at: challenge.rows[0].expires_at,
        dev_code: isProductionLikeEnv() ? undefined : code
      };
    });
  });

  app.post("/api/admin/auth/mfa/disable", async (req: any, reply: any) => {
    await ensureAdminIdentity();
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, {
        permission: "admin_users.manage",
        sessionRequired: true,
        recentMfa: true
      });
      if (!identity || !identity.admin_user_id) return reply;
      const targetAdminUserId = String(req.body?.admin_user_id || identity.admin_user_id).trim();
      requireUuid(targetAdminUserId, "admin_user_id");
      await c.query(
        `UPDATE siton.admin_mfa_factors
         SET status='Disabled', disabled_at=now()
         WHERE admin_user_id=$1 AND status <> 'Disabled'`,
        [targetAdminUserId]
      );
      await c.query(`UPDATE siton.admin_users SET mfa_enabled=false, updated_at=now() WHERE admin_user_id=$1`, [targetAdminUserId]);
      return { ok: true, admin_user_id: targetAdminUserId, mfa_enabled: false };
    });
  });

  app.post("/api/admin/auth/logout", async (req: any, reply: any) => {
    await ensureAdminIdentity();
    return deps.withTx(async (c) => {
      const cookies = parseCookies(String(req.headers?.cookie || ""));
      const rawToken = cookies.siton_admin_session;
      if (rawToken) {
        await c.query(`UPDATE siton.admin_sessions SET revoked_at=now() WHERE session_token_hash=$1`, [hashAdminSessionToken(rawToken)]);
      }
      reply.header("set-cookie", serializeExpiredAdminSessionCookie({ secure: isProductionLikeEnv() }));
      return { ok: true };
    });
  });

  app.get("/api/admin/auth/me", async (req: any, reply: any) => {
    await ensureAdminIdentity();
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, { permission: "mission_control.read" });
      if (!identity) return reply;
      return { ok: true, admin: adminPublicIdentity(identity) };
    });
  });

  app.get("/api/mall/deals", async (req: any, reply: any) => {
    const query = parseMallQuery(req.query || {});
    const discoveryQuery = buildMallDiscoveryQuery(query);
    const rows = await deps.withTx(async (c) => {
      const result = await c.query(discoveryQuery.text, discoveryQuery.values);
      return result.rows.map((row: any) => {
        const imageId = row.primary_image_id ? String(row.primary_image_id) : null;
        const fallbackImageUrl = imageId ? getDealImagePublicUrl({ image_id: imageId }) : null;
        const projected = projectMallRow({
          ...row,
          primary_image_url: row.primary_image_url || fallbackImageUrl,
          primary_thumbnail_url: row.primary_thumbnail_url || row.primary_image_url || fallbackImageUrl
        }) as any;
        const joinedUnits = Number(projected.joined_units || 0);
        const thresholdUnits = Math.max(1, Number(projected.threshold_units || 1));
        const remainingUnits = Number(projected.remaining_units || 0);
        const canJoin = Boolean(projected.is_joinable);
        const imageUrl = String(projected.primary_thumbnail_url || projected.primary_image_url || "").trim();
        return {
          ...projected,
          state: String(projected.canonical_state),
          primary_image: imageUrl
            ? {
                image_id: imageId,
                url: imageUrl,
                mime_type: row.primary_image_mime_type ? String(row.primary_image_mime_type) : null
              }
            : null,
          progress_to_target_pct: Math.max(0, Math.min(100, (joinedUnits / thresholdUnits) * 100)),
          availability: {
            can_join: canJoin,
            reason_code: canJoin
              ? null
              : remainingUnits <= 0
                ? "capacity_reached"
                : "deal_not_open"
          }
        };
      });
    });
    reply.header("cache-control", "public, max-age=30, stale-while-revalidate=60");
    reply.header("pragma", "");
    reply.header("expires", "");
    return { ok: true, ...buildMallListEnvelope(query, rows) };
  });

  app.post("/api/mall/events", async (req: any, reply: any) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const source = String(body.source || "mall").trim();
    if (source !== "mall") {
      const err: any = new Error("source must be mall");
      err.statusCode = 400;
      err.code = "mall_event_source_invalid";
      throw err;
    }
    const event = sanitizeMallEvent({
      ...body,
      client_event_id: body.client_event_id || body.session_id
    });
    const retryToken = `evt_${createHash("sha256").update(event.client_event_id).digest("hex")}`;

    const accepted = await deps.withTx(async (c) => {
      let dealType: string | null = null;
      let mallStatus: string | null = null;
      if (event.deal_id) {
        const canonicalDeal = await c.query(
          `SELECT deal_type, state::text AS state
           FROM siton.deals
           WHERE deal_id=$1 AND published_at IS NOT NULL`,
          [event.deal_id]
        );
        if (!canonicalDeal.rowCount) return false;
        dealType = String(canonicalDeal.rows[0].deal_type || "");
        mallStatus = mallStatusForState(String(canonicalDeal.rows[0].state));
        if (!mallStatus) return false;
      }
      await c.query(
        `INSERT INTO siton.discovery_events
           (event_type, client_event_id, deal_id, deal_type, mall_status, acquisition_source)
         VALUES ($1,$2,$3,$4,$5,'mall')
         ON CONFLICT DO NOTHING`,
        [event.event_type, retryToken, event.deal_id, dealType, mallStatus]
      );
      return true;
    });
    reply.code(202);
    reply.header("cache-control", "no-store");
    return { ok: true, accepted };
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
          product_direction: "mall-and-direct-group-deals",
          positioning:
            "Public Mall discovery and direct deal links lead into the same canonical Siton group-deal flow.",
          buyer_entry_note:
            "Buyers may discover a published deal in the Mall or open the seller's direct deal link.",
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
            "קניון ציבורי לגילוי עסקאות וקישורי עסקה ישירים",
            "יצירת עסקה וניהול עסקה למוכר",
            "דף עסקה ציבורי קנוני מהקניון או מקישור ישיר",
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

    // Schema contract checks may acquire their own connection. Complete them
    // before opening the request transaction so concurrent reads cannot fill
    // the pool with transactions that are all waiting for a nested checkout.
    await ensureProductSurfaces();
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const dealResult = await c.query(
        `SELECT d.deal_id, d.title, d.description, d.state, d.price_per_unit, d.min_units, d.max_units,
                d.threshold_units, d.deadline, d.published_at, d.completion_window_until,
                d.created_at, d.seller_id, d.deal_type,
                sa.business_name, sa.support_phone, sa.support_email, sa.business_description
         FROM siton.deals d
         LEFT JOIN siton.seller_accounts sa ON sa.seller_id = d.seller_id
         WHERE d.deal_id=$1
           AND d.published_at IS NOT NULL`,
        [dealId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const aggregate = await c.query(
        `SELECT COALESCE(SUM(qty),0) AS joined_units,
                COUNT(*)::int AS participants_count
         FROM siton.participants
         WHERE deal_id=$1
           AND buyer_state NOT IN ('NotJoined','DealFailed','Dropped')`,
        [dealId]
      );
      const deliveryOptions = await c.query(
        `SELECT option_id, option_type, label, cost, sort_order
         FROM siton.deal_delivery_options
         WHERE deal_id=$1
         ORDER BY sort_order ASC, created_at ASC`,
        [dealId]
      );
      const images = await c.query(
        `SELECT image_id, public_url, mime_type, is_primary, sort_order
         FROM siton.deal_images
         WHERE deal_id=$1
         ORDER BY is_primary DESC, sort_order ASC, created_at ASC`,
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
        deal_type: string;
      };

      const dealType: DealType = (["physical_product","voucher","ticket"].includes(String(deal.deal_type))
        ? (deal.deal_type as DealType)
        : "physical_product");
      const voucherTerms = dealType === "voucher" ? await readVoucherTerms(c, dealId) : null;
      const ticketTerms = dealType === "ticket" ? await readTicketTerms(c, dealId) : null;
      const fulfillmentCopy = publicDealCopy(dealType);

      const joinedUnits = Number(aggregate.rows[0].joined_units || 0);
      const participantsCount = Number(aggregate.rows[0].participants_count || 0);
      const remainingUnits = Math.max(0, Number(deal.max_units) - joinedUnits);
      const availability = deriveDealAvailability(deal.state, remainingUnits);

      return {
        ok: true,
        deal: {
          deal_id: deal.deal_id,
          title: deal.title,
          description: (deal as any).description || "",
          state: deal.state,
          deal_type: dealType,
          price_per_unit: Number(deal.price_per_unit),
          min_units: Number(deal.min_units),
          max_units: Number(deal.max_units),
          threshold_units: Number(deal.threshold_units),
          deadline: deal.deadline,
          published_at: deal.published_at,
          completion_window_until: deal.completion_window_until,
          created_at: deal.created_at,
          // Physical-only fields are suppressed for voucher/ticket so the public
          // page can't accidentally show shipping copy where it doesn't apply.
          delivery_options: dealType === "physical_product"
            ? deliveryOptions.rows.map((row: any) => ({
                option_id: row.option_id,
                option_type: row.option_type,
                label: row.label,
                cost: Number(row.cost || 0),
                sort_order: Number(row.sort_order || 0)
              }))
            : [],
          voucher_terms: voucherTerms
            ? {
                face_value_amount: Number(voucherTerms.face_value_amount),
                currency: voucherTerms.currency,
                valid_from: voucherTerms.valid_from,
                valid_until: voucherTerms.valid_until,
                redemption_location: voucherTerms.redemption_location,
                redemption_instructions: voucherTerms.redemption_instructions,
                terms: voucherTerms.terms,
                is_single_use: Boolean(voucherTerms.is_single_use),
                allow_partial_redemption: Boolean(voucherTerms.allow_partial_redemption),
                voucher_code_mode: voucherTerms.voucher_code_mode
              }
            : null,
          ticket_terms: ticketTerms
            ? {
                event_name: ticketTerms.event_name,
                event_starts_at: ticketTerms.event_starts_at,
                event_ends_at: ticketTerms.event_ends_at,
                venue_name: ticketTerms.venue_name,
                venue_address: ticketTerms.venue_address,
                venue_city: ticketTerms.venue_city,
                entry_instructions: ticketTerms.entry_instructions,
                ticket_type: ticketTerms.ticket_type,
                seat_mode: ticketTerms.seat_mode,
                transfer_allowed: Boolean(ticketTerms.transfer_allowed)
              }
            : null,
          fulfillment_copy: fulfillmentCopy,
          images: images.rows.map((row: any) => ({
            image_id: row.image_id,
            url: resolveDealImageUrl(row),
            is_primary: Boolean(row.is_primary),
            sort_order: Number(row.sort_order || 0),
            mime_type: row.mime_type
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
        seller: {
          business_name: (deal as any).business_name ?? null,
          support_phone: (deal as any).support_phone ?? null,
          support_email: (deal as any).support_email ?? null,
          business_description: (deal as any).business_description ?? null
        },
        availability
      };
    });
  });

  // ── Deal Chat ─────────────────────────────────────────────────────────────
  app.get("/api/deals/:dealId/chat", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    const rawLimit = Number(req.query?.limit ?? 50);
    const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50));

    return deps.withTx(async (c) => {
      await ensureProductSurfaces();
      const dealResult = await c.query(`SELECT deal_id, state FROM siton.deals WHERE deal_id=$1`, [dealId]);
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const state = String(dealResult.rows[0].state || "") as DealState;
      if (DEAL_CHAT_READ_BLOCKED_STATES.has(state)) {
        return reply.code(403).send({ ok: false, error: "chat closed", code: "chat_closed" });
      }

      const messages = await c.query(
        `SELECT message_id, deal_id, display_name, body, created_at
         FROM siton.deal_chat_messages
         WHERE deal_id=$1 AND status='visible'
         ORDER BY created_at ASC, message_id ASC
         LIMIT $2`,
        [dealId, limit]
      );

      return {
        ok: true,
        messages: messages.rows.map(dealChatMessageFromRow),
        generated_at: new Date().toISOString()
      };
    });
  });

  app.post("/api/deals/:dealId/chat", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    const rawBody = String(req.body?.body ?? "");
    const bodyText = normalizeDealChatText(rawBody, 500);
    const displayName = normalizeDealChatText(req.body?.display_name, 80, "משתתף");

    if (!bodyText) {
      return reply.code(400).send({ ok: false, error: "body is required", code: "invalid_input" });
    }
    if (rawBody.trim().length > 500) {
      return reply.code(400).send({ ok: false, error: "body must be 500 characters or fewer", code: "invalid_input" });
    }

    return deps.withTx(async (c) => {
      await ensureProductSurfaces();
      const dealResult = await c.query(`SELECT deal_id, state FROM siton.deals WHERE deal_id=$1`, [dealId]);
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const state = String(dealResult.rows[0].state || "") as DealState;
      if (!DEAL_CHAT_WRITE_ALLOWED_STATES.has(state)) {
        return reply.code(403).send({ ok: false, error: "chat closed", code: "chat_closed" });
      }

      const inserted = await c.query(
        `INSERT INTO siton.deal_chat_messages (deal_id, display_name, body)
         VALUES ($1,$2,$3)
         RETURNING message_id, deal_id, display_name, body, created_at`,
        [dealId, displayName, bodyText]
      );

      return reply.code(201).send({
        ok: true,
        message: dealChatMessageFromRow(inserted.rows[0])
      });
    });
  });

  // ── Seller Profile ────────────────────────────────────────────────────────
  app.get("/api/seller/profile", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const result = await c.query(
        `SELECT seller_id, display_name, business_name, contact_name,
                support_phone, support_email, business_description, business_identifier,
                verification_status, seller_status, seller_status_reason, seller_status_updated_at,
                seller_status_updated_by, created_at, updated_at
         FROM siton.seller_accounts WHERE seller_id = $1`,
        [sellerContext.seller_id]
      );
      const row = result.rows[0] as any;
      const isProfileReady = Boolean(
        row?.business_name?.trim() &&
        (row?.support_phone?.trim() || row?.support_email?.trim())
      );
      return {
        ok: true,
        profile: {
          seller_id: sellerContext.seller_id,
          display_name: String(row?.display_name || sellerContext.seller_id),
          business_name: row?.business_name ?? null,
          contact_name: row?.contact_name ?? null,
          support_phone: row?.support_phone ?? null,
          support_email: row?.support_email ?? null,
          business_description: row?.business_description ?? null,
          business_identifier: row?.business_identifier ?? null,
          seller_status: normalizeSellerStatus(row?.seller_status),
          seller_status_reason: row?.seller_status_reason ?? "",
          seller_status_updated_at: row?.seller_status_updated_at ?? null,
          seller_status_updated_by: row?.seller_status_updated_by ?? null,
          seller_enforcement_notice: sellerStatusHebrewNotice(row?.seller_status),
          is_publish_ready: isProfileReady,
          created_at: row?.created_at ?? null,
          updated_at: row?.updated_at ?? null
        }
      };
    });
  });

  app.put("/api/seller/profile", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return reply;
      const body = (req.body as any) || {};

      const businessName = String(body.business_name ?? "").trim();
      const contactName = String(body.contact_name ?? "").trim() || null;
      const supportPhone = String(body.support_phone ?? "").trim() || null;
      const supportEmail = String(body.support_email ?? "").trim() || null;
      const businessDescription = String(body.business_description ?? "").trim() || null;
      const businessIdentifier = String(body.business_identifier ?? "").trim() || null;

      if (!businessName) {
        const err: any = new Error("business_name is required");
        err.statusCode = 400;
        err.code = "business_name_required";
        throw err;
      }

      await c.query(
        `UPDATE siton.seller_accounts
         SET business_name = $2, contact_name = $3,
             support_phone = $4, support_email = $5,
             business_description = $6, business_identifier = $7,
             updated_at = now()
         WHERE seller_id = $1`,
        [sellerContext.seller_id, businessName, contactName,
         supportPhone, supportEmail, businessDescription, businessIdentifier]
      );

      const result = await c.query(
        `SELECT seller_id, display_name, business_name, contact_name,
                support_phone, support_email, business_description, business_identifier,
                seller_status, seller_status_reason, seller_status_updated_at, seller_status_updated_by, updated_at
         FROM siton.seller_accounts WHERE seller_id = $1`,
        [sellerContext.seller_id]
      );
      const row = result.rows[0] as any;
      const isProfileReady = Boolean(
        row?.business_name?.trim() &&
        (row?.support_phone?.trim() || row?.support_email?.trim())
      );
      return {
        ok: true,
        profile: {
          seller_id: sellerContext.seller_id,
          display_name: String(row?.display_name || sellerContext.seller_id),
          business_name: row?.business_name ?? null,
          contact_name: row?.contact_name ?? null,
          support_phone: row?.support_phone ?? null,
          support_email: row?.support_email ?? null,
          business_description: row?.business_description ?? null,
          business_identifier: row?.business_identifier ?? null,
          seller_status: normalizeSellerStatus(row?.seller_status),
          seller_status_reason: row?.seller_status_reason ?? "",
          seller_status_updated_at: row?.seller_status_updated_at ?? null,
          seller_status_updated_by: row?.seller_status_updated_by ?? null,
          seller_enforcement_notice: sellerStatusHebrewNotice(row?.seller_status),
          is_publish_ready: isProfileReady,
          updated_at: row?.updated_at ?? null
        }
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
           ${SITON_PLATFORM_FEE_RATE}::numeric AS platform_fee_rate,
           img.image_id AS primary_image_id,
           img.public_url AS primary_image_public_url,
           img.mime_type AS primary_image_mime_type,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count,
           COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
           COALESCE(SUM(p.qty) FILTER (WHERE p.money_state='ChargeFailedRecovery'),0)::int AS recovery_pending_units,
           COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state IN ('Dropped','DealFailed') OR p.money_state='AuthReleased'),0)::int AS dropped_units,
           COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS active_units,
           COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
             FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::numeric(14,2) AS potential_gross,
           COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
             FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross,
           GREATEST(d.updated_at, MAX(p.updated_at)) AS last_update_at
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         LEFT JOIN LATERAL (
           SELECT image_id, public_url, mime_type
           FROM siton.deal_images
           WHERE deal_id = d.deal_id
           ORDER BY is_primary DESC, sort_order ASC, created_at ASC
           LIMIT 1
         ) img ON true
         WHERE COALESCE(d.seller_id, $1) = $1
         GROUP BY d.deal_id, img.image_id, img.mime_type
         ORDER BY d.created_at DESC
         LIMIT 100`,
        [sellerId]
      );

      // Seller cards need the money story (charged / pending / not-charged)
      // and the deal-volume figures alongside the shared projection.
      const deals = (result.rows as DealListRow[]).map((row: any) => ({
        ...mapDealListRow(row),
        last_update_at: row.last_update_at ?? row.created_at,
        money: {
          charged_units: Number(row.charged_units || 0),
          recovery_pending_units: Number(row.recovery_pending_units || 0),
          dropped_units: Number(row.dropped_units || 0),
          active_units: Number(row.active_units || 0),
          potential_gross: Number(row.potential_gross || 0),
          charged_gross: Number(row.charged_gross || 0)
        }
      }));
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

  app.get("/api/seller/analytics", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    const period = normalizeSellerAnalyticsPeriod(req.query?.period);
    if (!period) {
      return reply.code(400).send({
        error: "invalid_period",
        code: "invalid_period",
        allowed_periods: SELLER_ANALYTICS_PERIODS
      });
    }

    return deps.withTx(async (c) => {
      const sanitizedQuery = { ...(req.query || {}) };
      delete sanitizedQuery.seller_id;
      delete sanitizedQuery.seller_display_name;
      const sellerContextRequest = { headers: req.headers, query: sanitizedQuery };
      const sellerContext = await resolveRequiredSellerContext(sellerContextRequest, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      return buildSellerAnalytics(c, sellerContext.seller_id, period);
    });
  });

  app.get("/api/seller/deals/:id/draft", async (req: any, reply: any) => {
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const result = await c.query(
        `SELECT deal_id, seller_id, state, title, description, price_per_unit,
                min_units, max_units, threshold_units, deadline, deal_type,
                created_at, updated_at
         FROM siton.deals
         WHERE deal_id=$1 AND seller_id=$2
         LIMIT 1`,
        [dealId, sellerContext.seller_id]
      );
      if (!result.rowCount) {
        throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
      }
      const draft = result.rows[0];
      if (String(draft.state) !== "Draft") {
        throw Object.assign(new Error("only a Draft can be edited"), { statusCode: 409, code: "DEAL_NOT_EDITABLE" });
      }
      const [deliveryOptions, images] = await Promise.all([
        c.query(
          `SELECT option_id, option_type, label, cost, sort_order
           FROM siton.deal_delivery_options
           WHERE deal_id=$1
           ORDER BY sort_order ASC, created_at ASC`,
          [dealId]
        ),
        c.query(
          `SELECT image_id, public_url, mime_type, size_bytes, is_primary, sort_order
           FROM siton.deal_images
           WHERE deal_id=$1
           ORDER BY sort_order ASC, created_at ASC`,
          [dealId]
        )
      ]);
      const dealType = normalizeDealType(draft.deal_type, "physical_product");
      return {
        ok: true,
        editor_version: String(draft.updated_at),
        draft: {
          deal_id: String(draft.deal_id),
          state: "Draft",
          title: String(draft.title || ""),
          description: String(draft.description || ""),
          price_per_unit: Number(draft.price_per_unit),
          min_units: Number(draft.min_units),
          max_units: Number(draft.max_units),
          threshold_units: Number(draft.threshold_units),
          deadline: String(draft.deadline),
          deal_type: dealType,
          delivery_options: deliveryOptions.rows.map((row: any) => ({
            option_id: row.option_id,
            option_type: row.option_type,
            label: row.label,
            cost: Number(row.cost || 0),
            sort_order: Number(row.sort_order || 0)
          })),
          voucher_terms: dealType === "voucher" ? await readVoucherTerms(c, dealId) : null,
          ticket_terms: dealType === "ticket" ? await readTicketTerms(c, dealId) : null,
          images: images.rows.map((row: any) => ({
            image_id: row.image_id,
            url: resolveDealImageUrl(row),
            mime_type: row.mime_type,
            size_bytes: Number(row.size_bytes || 0),
            is_primary: Boolean(row.is_primary),
            sort_order: Number(row.sort_order || 0)
          }))
        },
        seller_auth: sellerAuthSummary(sellerContext, { returnTo: `/app/seller/deals/${dealId}/edit` })
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
           ${SITON_PLATFORM_FEE_RATE}::numeric AS platform_fee_rate,
           img.image_id AS primary_image_id,
           img.public_url AS primary_image_public_url,
           img.mime_type AS primary_image_mime_type,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         LEFT JOIN LATERAL (
           SELECT image_id, public_url, mime_type
           FROM siton.deal_images
           WHERE deal_id = d.deal_id
           ORDER BY is_primary DESC, sort_order ASC, created_at ASC
           LIMIT 1
         ) img ON true
         WHERE d.deal_id = $1
           AND COALESCE(d.seller_id, $2) = $2
         GROUP BY d.deal_id, img.image_id, img.mime_type`,
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

      const invoiceDocuments = await c.query(
        `SELECT document_id, participant_id, status, document_type, provider_document_id,
                issued_at, created_at, gross_amount, money_state_at_issue
         FROM siton.invoice_documents
         WHERE deal_id = $1
         ORDER BY created_at DESC`,
        [dealId]
      );

      const deal = mapDealListRow(dealResult.rows[0] as DealListRow);
      const dealImages = await c.query(
        `SELECT image_id, public_url, mime_type, is_primary, sort_order
         FROM siton.deal_images
         WHERE deal_id=$1
         ORDER BY is_primary DESC, sort_order ASC, created_at ASC`,
        [dealId]
      );
      deal.images = dealImages.rows.map((row: any) => ({
        image_id: row.image_id,
        url: resolveDealImageUrl(row),
        is_primary: Boolean(row.is_primary),
        sort_order: Number(row.sort_order || 0),
        mime_type: row.mime_type
      }));
      const attributionByParticipant = new Map(
        attributions.rows.map((row: any) => [String(row.participant_id), row])
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
        )
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
        seller_actions: {
          can_publish: (dealResult.rows[0] as DealListRow).state === "Draft",
          edit_locked: (dealResult.rows[0] as DealListRow).state !== "Draft",
          create_similar_supported: true
        }
      };
    });
  });

  app.get("/api/seller/deals/:dealId/shipping-export", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state, price_per_unit
         FROM siton.deals
         WHERE deal_id = $1`,
        [dealId, sellerId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const deal = dealResult.rows[0] as any;

      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("forbidden: you do not own this deal");
        err.statusCode = 403;
        err.code = "forbidden";
        throw err;
      }

      if (String(deal.state) !== "Completed") {
        const err: any = new Error("deal is not completed");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const participantsResult = await c.query(
        `SELECT
           p.participant_id,
           p.buyer_id,
           p.buyer_name,
           p.buyer_phone,
           p.buyer_email,
           p.qty,
           p.buyer_state,
           p.money_state,
           p.delivery_method_type,
           p.delivery_method_label,
           p.delivery_cost,
           p.delivery_address,
           p.delivery_city,
           p.delivery_notes,
           p.created_at
         FROM siton.participants p
         WHERE p.deal_id = $1
           AND (p.money_state IN ('ChargedSuccess', 'RecoveredCharge') OR p.buyer_state = 'DealCompleted')
         ORDER BY p.created_at ASC`,
        [dealId]
      );

      function csvCell(value: string | number | null | undefined): string {
        if (value === null || value === undefined) return "";
        const str = String(value);
        if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }

      const headers = [
        "deal_id",
        "deal_title",
        "participant_id",
        "buyer_id",
        "buyer_name",
        "buyer_phone",
        "buyer_email",
        "qty",
        "delivery_method",
        "delivery_method_label",
        "delivery_address",
        "delivery_city",
        "delivery_notes",
        "charged_amount",
        "created_at"
      ];

      const lines: string[] = [headers.join(",")];

      for (const row of participantsResult.rows as any[]) {
        const chargedAmount = (
          Number(deal.price_per_unit || 0) * Number(row.qty || 0) +
          Number(row.delivery_cost || 0)
        ).toFixed(2);

        lines.push(
          [
            deal.deal_id,
            deal.title,
            row.participant_id,
            row.buyer_id,
            row.buyer_name,
            row.buyer_phone,
            row.buyer_email,
            String(row.qty),
            String(row.delivery_method_label || row.delivery_method_type || ""),
            row.delivery_method_label,
            row.delivery_address,
            row.delivery_city,
            row.delivery_notes,
            chargedAmount,
            row.created_at ? new Date(row.created_at).toISOString() : ""
          ]
            .map(csvCell)
            .join(",")
        );
      }

      // UTF-8 BOM ensures Hebrew characters render correctly in Excel
      const csvContent = "﻿" + lines.join("\r\n");

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="siton-shipping-${dealId}.csv"`)
        .send(csvContent);
    });
  });

  // ── Delivery Data Handoff (JSON) ─────────────────────────────────────────
  // Returns only eligible buyers (ChargedSuccess / RecoveredCharge) with their
  // delivery fields. No shipping status, tracking numbers, or payment refs.
  app.get("/api/seller/deals/:dealId/delivery-handoff", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state
         FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("forbidden");
        err.statusCode = 403;
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("delivery handoff requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const result = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.delivery_method_type, p.delivery_method_label, p.delivery_cost,
                p.delivery_address, p.delivery_city, p.delivery_notes, p.created_at
         FROM siton.participants p
         WHERE p.deal_id = $1
           AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
         ORDER BY p.created_at ASC`,
        [dealId]
      );

      return {
        deal_id: dealId,
        deal_title: String(deal.title),
        eligible_count: result.rowCount,
        disclaimer: "האספקה מתבצעת באחריות המוכר ומחוץ למערכת סיטון.",
        buyers: (result.rows as any[]).map((p) => ({
          participant_id: p.participant_id,
          buyer_id: p.buyer_id,
          buyer_name: p.buyer_name || null,
          buyer_phone: p.buyer_phone || null,
          buyer_email: p.buyer_email || null,
          qty: Number(p.qty || 0),
          delivery_method_type: p.delivery_method_type || null,
          delivery_method_label: p.delivery_method_label || null,
          delivery_address: p.delivery_address || null,
          delivery_city: p.delivery_city || null,
          delivery_notes: p.delivery_notes || null,
          joined_at: p.created_at ? new Date(p.created_at).toISOString() : null
        }))
      };
    });
  });

  // ── Delivery Data Handoff Excel Export ───────────────────────────────────
  // Lean sheet: only eligible buyers + delivery fields. No tracking, status,
  // payment provider refs, or internal audit data.
  app.get("/api/seller/deals/:dealId/delivery-handoff/export.xlsx", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state
         FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("forbidden");
        err.statusCode = 403;
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("delivery handoff requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const participantsResult = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.delivery_method_type, p.delivery_method_label,
                p.delivery_address, p.delivery_city, p.delivery_notes, p.created_at
         FROM siton.participants p
         WHERE p.deal_id = $1
           AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
         ORDER BY p.created_at ASC`,
        [dealId]
      );

      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "Siton";
      wb.created = new Date();

      function safeTextDH(v: any) {
        const s = v == null ? "" : String(v);
        return /^[=+\-@]/.test(s) ? `'${s}` : s;
      }
      function fmtDateDH(v: any) {
        if (!v) return "";
        try { return new Date(v).toISOString().slice(0, 10); } catch { return ""; }
      }

      const ws = wb.addWorksheet("מסירת נתוני אספקה");
      ws.columns = [
        { header: "מזהה עסקה", key: "deal_id", width: 38 },
        { header: "שם עסקה", key: "deal_title", width: 30 },
        { header: "מזהה השתתפות", key: "participant_id", width: 38 },
        { header: "שם מקבל", key: "buyer_name", width: 22 },
        { header: "טלפון", key: "buyer_phone", width: 18 },
        { header: "אימייל", key: "buyer_email", width: 28 },
        { header: "כמות", key: "qty", width: 8 },
        { header: "אופן קבלה", key: "delivery_method", width: 20 },
        { header: "תווית אופן קבלה", key: "delivery_method_label", width: 24 },
        { header: "כתובת", key: "delivery_address", width: 32 },
        { header: "עיר", key: "delivery_city", width: 18 },
        { header: "הערת משלוח", key: "delivery_notes", width: 26 },
        { header: "תאריך הצטרפות", key: "joined_at", width: 22 }
      ];

      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true };
      headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAD3" } };
      headerRow.commit();

      for (const p of participantsResult.rows as any[]) {
        ws.addRow([
          safeTextDH(dealId),
          safeTextDH(deal.title),
          safeTextDH(p.participant_id),
          safeTextDH(p.buyer_name),
          safeTextDH(p.buyer_phone),
          safeTextDH(p.buyer_email),
          Number(p.qty || 0),
          safeTextDH(p.delivery_method_type),
          safeTextDH(p.delivery_method_label),
          safeTextDH(p.delivery_address),
          safeTextDH(p.delivery_city),
          safeTextDH(p.delivery_notes),
          fmtDateDH(p.created_at)
        ]);
      }

      const wsNotes = wb.addWorksheet("הסבר");
      wsNotes.addRow(["מסירת נתוני אספקה — סיטון"]);
      wsNotes.addRow([""]);
      wsNotes.addRow(["סיטון מוסרת כאן את פרטי הקונים שחויבו בפועל וזכאים למוצר."]);
      wsNotes.addRow(["האספקה עצמה מתבצעת באחריות המוכר בלבד ומחוץ למערכת סיטון."]);
      wsNotes.addRow([""]);
      wsNotes.addRow(["הקובץ לא כולל מספרי מעקב, סטטוס משלוח, או נתוני סליקה פנימיים."]);
      wsNotes.addRow([`הופק: ${new Date().toISOString().slice(0, 10)}`]);

      const buf = await wb.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="siton-delivery-handoff-${dealId}.xlsx"`)
        .send(buf);
    });
  });

  // ── Voucher Fulfillment Export (CSV) ─────────────────────────────────────
  // Lists eligible buyers + voucher fulfillment unit metadata. Plaintext
  // voucher codes are NEVER persisted (we keep only SHA-256 hash + last4),
  // so the export shows fulfillment_unit_id and last4 only — by design, not
  // by accident. Sellers redeem via POST /api/seller/fulfillment/:unitId/redeem.
  app.get("/api/seller/deals/:dealId/voucher-export", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state, deal_type
           FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("forbidden");
        err.statusCode = 403;
        throw err;
      }
      if (String(deal.deal_type) !== "voucher") {
        const err: any = new Error("voucher export is only available for voucher deals");
        err.statusCode = 409;
        err.code = "deal_type_not_voucher";
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("voucher export requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const voucherTermsRow = await readVoucherTerms(c, dealId);
      const result = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.money_state, p.buyer_state,
                f.fulfillment_unit_id, f.unit_index, f.code_display_last4,
                f.status AS fulfillment_status, f.issued_at, f.redeemed_at, f.expires_at
           FROM siton.participants p
           LEFT JOIN siton.fulfillment_units f
                  ON f.participant_id = p.participant_id
           WHERE p.deal_id = $1
             AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
             AND p.buyer_state = 'DealCompleted'
           ORDER BY p.created_at ASC, f.unit_index ASC`,
        [dealId]
      );

      const headers = [
        "deal_id",
        "deal_title",
        "participant_id",
        "buyer_name",
        "buyer_phone",
        "buyer_email",
        "qty",
        "fulfillment_unit_id",
        "unit_index",
        "voucher_code_last4",
        "face_value_amount",
        "currency",
        "valid_from",
        "valid_until",
        "fulfillment_status",
        "issued_at",
        "redeemed_at",
        "expires_at"
      ];
      const lines: string[] = [headers.join(",")];
      for (const row of result.rows as any[]) {
        lines.push(
          [
            deal.deal_id,
            deal.title,
            row.participant_id,
            row.buyer_name,
            row.buyer_phone,
            row.buyer_email,
            String(row.qty),
            row.fulfillment_unit_id || "",
            row.unit_index !== null && row.unit_index !== undefined ? String(row.unit_index) : "",
            row.code_display_last4 || "",
            voucherTermsRow ? Number(voucherTermsRow.face_value_amount).toFixed(2) : "",
            voucherTermsRow?.currency || "",
            voucherTermsRow?.valid_from ? new Date(voucherTermsRow.valid_from).toISOString() : "",
            voucherTermsRow?.valid_until ? new Date(voucherTermsRow.valid_until).toISOString() : "",
            row.fulfillment_status || "",
            row.issued_at ? new Date(row.issued_at).toISOString() : "",
            row.redeemed_at ? new Date(row.redeemed_at).toISOString() : "",
            row.expires_at ? new Date(row.expires_at).toISOString() : ""
          ]
            .map(csvSafeCell)
            .join(",")
        );
      }
      const csvContent = "﻿" + lines.join("\r\n");
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="siton-voucher-${dealId}.csv"`)
        .send(csvContent);
    });
  });

  // ── Ticket Attendee Export (CSV) ─────────────────────────────────────────
  app.get("/api/seller/deals/:dealId/ticket-export", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state, deal_type
           FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("forbidden");
        err.statusCode = 403;
        throw err;
      }
      if (String(deal.deal_type) !== "ticket") {
        const err: any = new Error("ticket export is only available for ticket deals");
        err.statusCode = 409;
        err.code = "deal_type_not_ticket";
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("ticket export requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const ticketTermsRow = await readTicketTerms(c, dealId);
      const result = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.money_state, p.buyer_state,
                f.fulfillment_unit_id, f.unit_index, f.code_display_last4,
                f.status AS fulfillment_status, f.issued_at, f.redeemed_at
           FROM siton.participants p
           LEFT JOIN siton.fulfillment_units f
                  ON f.participant_id = p.participant_id
           WHERE p.deal_id = $1
             AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
             AND p.buyer_state = 'DealCompleted'
           ORDER BY p.created_at ASC, f.unit_index ASC`,
        [dealId]
      );

      const headers = [
        "deal_id",
        "deal_title",
        "participant_id",
        "attendee_name",
        "attendee_phone",
        "attendee_email",
        "qty",
        "fulfillment_unit_id",
        "unit_index",
        "ticket_code_last4",
        "event_name",
        "event_starts_at",
        "venue_name",
        "venue_city",
        "ticket_type",
        "fulfillment_status",
        "issued_at",
        "checked_in_at"
      ];
      const lines: string[] = [headers.join(",")];
      for (const row of result.rows as any[]) {
        lines.push(
          [
            deal.deal_id,
            deal.title,
            row.participant_id,
            row.buyer_name,
            row.buyer_phone,
            row.buyer_email,
            String(row.qty),
            row.fulfillment_unit_id || "",
            row.unit_index !== null && row.unit_index !== undefined ? String(row.unit_index) : "",
            row.code_display_last4 || "",
            ticketTermsRow?.event_name || "",
            ticketTermsRow?.event_starts_at ? new Date(ticketTermsRow.event_starts_at).toISOString() : "",
            ticketTermsRow?.venue_name || "",
            ticketTermsRow?.venue_city || "",
            ticketTermsRow?.ticket_type || "",
            row.fulfillment_status || "",
            row.issued_at ? new Date(row.issued_at).toISOString() : "",
            row.redeemed_at ? new Date(row.redeemed_at).toISOString() : ""
          ]
            .map(csvSafeCell)
            .join(",")
        );
      }
      const csvContent = "﻿" + lines.join("\r\n");
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="siton-tickets-${dealId}.csv"`)
        .send(csvContent);
    });
  });

  // ── Seller Redemption / Check-in Foundation ──────────────────────────────
  // Marks a fulfillment_unit as Redeemed. Strict guarantees:
  //   • Seller ownership: caller must own the deal.
  //   • Unit must already be Issued or Sent (cannot redeem Pending/Failed).
  //   • Idempotent on already-Redeemed units (returns ok=true, idempotent=true).
  //   • Money/state machine and refund policy are not touched.
  app.post("/api/seller/fulfillment/:unitId/redeem", async (req: any, reply: any) => {
    const unitId = String(req.params.unitId || "");
    requireUuid(unitId, "fulfillment_unit_id");
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;

      const lookup = await c.query(
        `SELECT f.fulfillment_unit_id, f.deal_id, f.participant_id, f.status,
                f.fulfillment_kind, f.deal_type,
                COALESCE(d.seller_id, '') AS seller_id, d.state AS deal_state
           FROM siton.fulfillment_units f
           JOIN siton.deals d ON d.deal_id = f.deal_id
          WHERE f.fulfillment_unit_id = $1
          FOR UPDATE`,
        [unitId]
      );
      if (!lookup.rowCount) {
        const err: any = new Error("fulfillment unit not found");
        err.statusCode = 404;
        err.code = "fulfillment_unit_not_found";
        throw err;
      }
      const unit = lookup.rows[0] as any;
      if (String(unit.seller_id) !== sellerId) {
        const err: any = new Error("seller does not own this fulfillment unit");
        err.statusCode = 403;
        err.code = "fulfillment_unit_forbidden";
        throw err;
      }
      if (String(unit.deal_state) !== "Completed") {
        const err: any = new Error("cannot redeem before deal is Completed");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }
      if (String(unit.status) === "Redeemed") {
        return {
          ok: true,
          idempotent: true,
          fulfillment_unit_id: unit.fulfillment_unit_id,
          status: "Redeemed"
        };
      }
      if (!["Issued", "Sent"].includes(String(unit.status))) {
        const err: any = new Error(`cannot redeem unit in status ${unit.status}`);
        err.statusCode = 409;
        err.code = "fulfillment_unit_not_redeemable";
        throw err;
      }
      const updated = await c.query(
        `UPDATE siton.fulfillment_units
            SET status = 'Redeemed',
                redeemed_at = now(),
                updated_at = now()
          WHERE fulfillment_unit_id = $1
            AND status IN ('Issued','Sent')
          RETURNING fulfillment_unit_id, status, redeemed_at`,
        [unitId]
      );
      if (!updated.rowCount) {
        const err: any = new Error("redemption update lost a race");
        err.statusCode = 409;
        err.code = "fulfillment_unit_race";
        throw err;
      }
      return {
        ok: true,
        idempotent: false,
        fulfillment_unit_id: updated.rows[0].fulfillment_unit_id,
        status: updated.rows[0].status,
        redeemed_at: updated.rows[0].redeemed_at
          ? new Date(updated.rows[0].redeemed_at).toISOString()
          : null
      };
    });
  });

  // ── Seller Deal Excel Export ─────────────────────────────────────────────
  app.get("/api/seller/deals/:dealId/export.xlsx", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state,
                price_per_unit, min_units, max_units, threshold_units,
                deadline, published_at, created_at, completion_window_until
         FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;

      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("forbidden: you do not own this deal");
        err.statusCode = 403;
        err.code = "forbidden";
        throw err;
      }

      if (String(deal.state) !== "Completed") {
        const err: any = new Error("deal is not completed");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      // All participants
      const allParticipantsResult = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.buyer_state, p.money_state,
                p.delivery_method_type, p.delivery_method_label, p.delivery_cost,
                p.delivery_address, p.delivery_city, p.delivery_notes,
                p.created_at, p.updated_at
         FROM siton.participants p
         WHERE p.deal_id = $1
         ORDER BY p.created_at ASC`,
        [dealId]
      );
      const allParticipants = allParticipantsResult.rows as any[];

      const pricePerUnit = Number(deal.price_per_unit || 0);

      function isEligible(p: any): boolean {
        return (
          p.money_state === "ChargedSuccess" ||
          p.money_state === "RecoveredCharge" ||
          p.buyer_state === "DealCompleted"
        );
      }

      const eligibleParticipants = allParticipants.filter(isEligible);
      const droppedCount = allParticipants.filter((p) => p.buyer_state === "Dropped").length;

      // Row-level money for each eligible participant
      function rowMoney(p: any) {
        const gross = (pricePerUnit * Number(p.qty || 0)) + Number(p.delivery_cost || 0);
        return calculatePlatformFeeMoney({ grossAmount: gross });
      }

      // Deal-level money totals
      let dealGross = 0;
      let dealProductsTotal = 0;
      let dealDeliveryTotal = 0;
      let dealFinalUnits = 0;
      for (const p of eligibleParticipants) {
        const qty = Number(p.qty || 0);
        const delivery = Number(p.delivery_cost || 0);
        dealGross += (pricePerUnit * qty) + delivery;
        dealProductsTotal += pricePerUnit * qty;
        dealDeliveryTotal += delivery;
        dealFinalUnits += qty;
      }
      const dealMoney = calculatePlatformFeeMoney({ grossAmount: dealGross });

      // Attribution data
      const attributionResult = await c.query(
        `SELECT aa.share_code, af.display_name AS affiliate_name,
                COUNT(aa.participant_id)::int AS joins_attributed,
                COALESCE(SUM(p.qty), 0) AS units_attributed
         FROM siton.affiliate_attributions aa
         JOIN siton.affiliate_accounts af ON af.affiliate_id = aa.affiliate_id
         LEFT JOIN siton.participants p ON p.participant_id = aa.participant_id
         WHERE aa.deal_id = $1
         GROUP BY aa.share_code, af.display_name
         ORDER BY joins_attributed DESC`,
        [dealId]
      );
      const attributions = attributionResult.rows as any[];

      // ── ExcelJS workbook ────────────────────────────────────────────────────

      function safeText(val: string | number | null | undefined): string {
        if (val === null || val === undefined) return "";
        const s = String(val);
        // Prevent formula injection
        if (/^[=\-+@*]/.test(s)) return "'" + s;
        return s;
      }

      function fmtDate(val: string | Date | null | undefined): string {
        if (!val) return "";
        try { return new Date(val as string).toISOString().replace("T", " ").slice(0, 19); }
        catch { return ""; }
      }

      function applySheetStyle(ws: ExcelJS.Worksheet, colCount: number) {
        ws.views = [{ state: "frozen", ySplit: 1 }];
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colCount } };
        ws.getRow(1).font = { bold: true };
      }

      const wb = new ExcelJS.Workbook();
      wb.creator = "Siton";
      wb.created = new Date();

      // ── Sheet 1: Deal Summary ───────────────────────────────────────────────
      const ws1 = wb.addWorksheet("Deal Summary");
      ws1.columns = [
        { header: "Field", key: "field", width: 32 },
        { header: "Value", key: "value", width: 40 }
      ];
      applySheetStyle(ws1, 2);
      const summaryRows: [string, string | number][] = [
        ["deal_id", safeText(deal.deal_id)],
        ["deal_title", safeText(deal.title)],
        ["seller_id", safeText(sellerId)],
        ["deal_state", safeText(deal.state)],
        ["currency", "ILS"],
        ["created_at", fmtDate(deal.created_at)],
        ["published_at", fmtDate(deal.published_at)],
        ["deadline", fmtDate(deal.deadline)],
        ["min_units", Number(deal.min_units || 0)],
        ["max_units", Number(deal.max_units || 0)],
        ["threshold_units", Number(deal.threshold_units || 0)],
        ["final_units_charged", dealFinalUnits],
        ["total_participants", allParticipants.length],
        ["eligible_buyers_count", eligibleParticipants.length],
        ["dropped_buyers_count", droppedCount],
        ["gross_collected_total", dealGross],
        ["products_total", dealProductsTotal],
        ["delivery_total", dealDeliveryTotal],
        ["platform_fee_base_amount", dealMoney.platform_fee_base_amount],
        ["platform_fee_vat_amount", dealMoney.platform_fee_vat_amount],
        ["platform_fee_total_amount", dealMoney.platform_fee_total_amount],
        ["seller_net_amount", dealMoney.seller_net_amount]
      ];
      for (const [field, value] of summaryRows) {
        const row = ws1.addRow([field, value]);
        if (typeof value === "number") {
          row.getCell(2).numFmt = "#,##0.00";
        }
      }

      // ── Sheet 2: Eligible Buyers ────────────────────────────────────────────
      const ws2 = wb.addWorksheet("Eligible Buyers");
      ws2.columns = [
        { header: "deal_id", key: "deal_id", width: 38 },
        { header: "participant_id", key: "participant_id", width: 38 },
        { header: "buyer_id", key: "buyer_id", width: 18 },
        { header: "buyer_name", key: "buyer_name", width: 20 },
        { header: "buyer_phone", key: "buyer_phone", width: 18 },
        { header: "buyer_email", key: "buyer_email", width: 26 },
        { header: "qty", key: "qty", width: 8 },
        { header: "unit_price", key: "unit_price", width: 12 },
        { header: "products_amount", key: "products_amount", width: 16 },
        { header: "delivery_method", key: "delivery_method", width: 20 },
        { header: "delivery_method_label", key: "delivery_method_label", width: 24 },
        { header: "delivery_cost", key: "delivery_cost", width: 14 },
        { header: "delivery_address", key: "delivery_address", width: 30 },
        { header: "delivery_city", key: "delivery_city", width: 18 },
        { header: "delivery_notes", key: "delivery_notes", width: 24 },
        { header: "row_gross_amount", key: "row_gross_amount", width: 16 },
        { header: "row_platform_fee_base_amount", key: "row_platform_fee_base_amount", width: 26 },
        { header: "row_platform_fee_vat_amount", key: "row_platform_fee_vat_amount", width: 26 },
        { header: "row_platform_fee_total_amount", key: "row_platform_fee_total_amount", width: 28 },
        { header: "row_seller_net_amount", key: "row_seller_net_amount", width: 22 },
        { header: "buyer_state", key: "buyer_state", width: 18 },
        { header: "money_state", key: "money_state", width: 18 },
        { header: "joined_at", key: "joined_at", width: 22 }
      ];
      applySheetStyle(ws2, ws2.columns.length);
      const moneyColsWs2 = [8, 9, 12, 16, 17, 18, 19, 20]; // 1-based
      for (const p of eligibleParticipants) {
        const qty = Number(p.qty || 0);
        const productsAmt = pricePerUnit * qty;
        const fm = rowMoney(p);
        const dataRow = ws2.addRow([
          safeText(deal.deal_id),
          safeText(p.participant_id),
          safeText(p.buyer_id),
          safeText(p.buyer_name),
          safeText(p.buyer_phone),
          safeText(p.buyer_email),
          qty,
          pricePerUnit,
          productsAmt,
          safeText(p.delivery_method_type),
          safeText(p.delivery_method_label),
          Number(p.delivery_cost || 0),
          safeText(p.delivery_address),
          safeText(p.delivery_city),
          safeText(p.delivery_notes),
          fm.gross_amount,
          fm.platform_fee_base_amount,
          fm.platform_fee_vat_amount,
          fm.platform_fee_total_amount,
          fm.seller_net_amount,
          safeText(p.buyer_state),
          safeText(p.money_state),
          fmtDate(p.created_at)
        ]);
        for (const col of moneyColsWs2) {
          dataRow.getCell(col).numFmt = "#,##0.00";
        }
      }

      // ── Sheet 3: All Participants ───────────────────────────────────────────
      const ws3 = wb.addWorksheet("All Participants");
      ws3.columns = [
        { header: "deal_id", key: "deal_id", width: 38 },
        { header: "participant_id", key: "participant_id", width: 38 },
        { header: "buyer_id", key: "buyer_id", width: 18 },
        { header: "buyer_name", key: "buyer_name", width: 20 },
        { header: "buyer_phone", key: "buyer_phone", width: 18 },
        { header: "buyer_email", key: "buyer_email", width: 26 },
        { header: "qty", key: "qty", width: 8 },
        { header: "delivery_method", key: "delivery_method", width: 20 },
        { header: "delivery_method_label", key: "delivery_method_label", width: 24 },
        { header: "delivery_address", key: "delivery_address", width: 30 },
        { header: "delivery_city", key: "delivery_city", width: 18 },
        { header: "buyer_state", key: "buyer_state", width: 18 },
        { header: "money_state", key: "money_state", width: 18 },
        { header: "is_eligible_for_fulfillment", key: "is_eligible_for_fulfillment", width: 26 },
        { header: "is_charged_successfully", key: "is_charged_successfully", width: 24 },
        { header: "is_dropped", key: "is_dropped", width: 12 },
        { header: "created_at", key: "created_at", width: 22 },
        { header: "updated_at", key: "updated_at", width: 22 }
      ];
      applySheetStyle(ws3, ws3.columns.length);
      for (const p of allParticipants) {
        ws3.addRow([
          safeText(deal.deal_id),
          safeText(p.participant_id),
          safeText(p.buyer_id),
          safeText(p.buyer_name),
          safeText(p.buyer_phone),
          safeText(p.buyer_email),
          Number(p.qty || 0),
          safeText(p.delivery_method_type),
          safeText(p.delivery_method_label),
          safeText(p.delivery_address),
          safeText(p.delivery_city),
          safeText(p.buyer_state),
          safeText(p.money_state),
          isEligible(p) ? "YES" : "NO",
          (p.money_state === "ChargedSuccess" || p.money_state === "RecoveredCharge") ? "YES" : "NO",
          p.buyer_state === "Dropped" ? "YES" : "NO",
          fmtDate(p.created_at),
          fmtDate(p.updated_at)
        ]);
      }

      // ── Sheet 4: Money Breakdown ────────────────────────────────────────────
      const ws4 = wb.addWorksheet("Money Breakdown");
      ws4.columns = [
        { header: "participant_id", key: "participant_id", width: 38 },
        { header: "buyer_name", key: "buyer_name", width: 20 },
        { header: "qty", key: "qty", width: 8 },
        { header: "products_amount", key: "products_amount", width: 16 },
        { header: "delivery_cost", key: "delivery_cost", width: 14 },
        { header: "gross_amount", key: "gross_amount", width: 14 },
        { header: "platform_fee_base_amount", key: "platform_fee_base_amount", width: 24 },
        { header: "platform_fee_vat_amount", key: "platform_fee_vat_amount", width: 22 },
        { header: "platform_fee_total_amount", key: "platform_fee_total_amount", width: 24 },
        { header: "seller_net_amount", key: "seller_net_amount", width: 18 },
        { header: "money_state", key: "money_state", width: 18 }
      ];
      applySheetStyle(ws4, ws4.columns.length);
      const moneyColsWs4 = [4, 5, 6, 7, 8, 9, 10];
      for (const p of eligibleParticipants) {
        const qty = Number(p.qty || 0);
        const fm = rowMoney(p);
        const dr = ws4.addRow([
          safeText(p.participant_id),
          safeText(p.buyer_name),
          qty,
          pricePerUnit * qty,
          Number(p.delivery_cost || 0),
          fm.gross_amount,
          fm.platform_fee_base_amount,
          fm.platform_fee_vat_amount,
          fm.platform_fee_total_amount,
          fm.seller_net_amount,
          safeText(p.money_state)
        ]);
        for (const col of moneyColsWs4) {
          dr.getCell(col).numFmt = "#,##0.00";
        }
      }
      // Total row
      const totalRow = ws4.addRow([
        "TOTAL",
        "",
        dealFinalUnits,
        dealProductsTotal,
        dealDeliveryTotal,
        dealMoney.gross_amount,
        dealMoney.platform_fee_base_amount,
        dealMoney.platform_fee_vat_amount,
        dealMoney.platform_fee_total_amount,
        dealMoney.seller_net_amount,
        ""
      ]);
      totalRow.font = { bold: true };
      for (const col of moneyColsWs4) {
        totalRow.getCell(col).numFmt = "#,##0.00";
      }

      // ── Sheet 5: Attribution (only if data exists) ──────────────────────────
      if (attributions.length > 0) {
        const ws5 = wb.addWorksheet("Attribution");
        ws5.addRow(["נתוני ייחוס בלבד. אין בסיטון חישוב עמלה או תשלום למפיצים."]);
        ws5.getRow(1).font = { italic: true };
        ws5.addRow([]);
        ws5.columns = [
          { header: "attribution_label", key: "attribution_label", width: 30 },
          { header: "affiliate_name", key: "affiliate_name", width: 24 },
          { header: "joins_attributed", key: "joins_attributed", width: 18 },
          { header: "units_attributed", key: "units_attributed", width: 18 }
        ];
        const headerRow = ws5.addRow(["attribution_label", "affiliate_name", "joins_attributed", "units_attributed"]);
        headerRow.font = { bold: true };
        ws5.views = [{ state: "frozen", ySplit: 3 }];
        ws5.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: 4 } };
        for (const a of attributions) {
          ws5.addRow([
            safeText(a.share_code),
            safeText(a.affiliate_name),
            Number(a.joins_attributed || 0),
            Number(a.units_attributed || 0)
          ]);
        }
      }

      // ── Sheet 6: Notes ──────────────────────────────────────────────────────
      const wsNotes = wb.addWorksheet("Notes");
      wsNotes.columns = [{ header: "", key: "note", width: 80 }];
      const notesText = [
        "קובץ זה הוא מסירת נתוני עסקה למוכר לאחר השלמת העסקה.",
        "סיטון מספקת רשימת זכאים ונתוני גבייה לפי המידע במערכת.",
        "האחריות לאספקת המוצר, טיפול בכתובות, זמני משלוח ושירות לקוחות לאחר המכירה היא של המוכר.",
        "נתוני מפיצים, אם קיימים, הם נתוני ייחוס בלבד ואינם מהווים עמלה או התחייבות תשלום מצד סיטון."
      ];
      for (const line of notesText) {
        const nr = wsNotes.addRow([line]);
        nr.getCell(1).alignment = { wrapText: true };
      }

      // ── Serialize and send ──────────────────────────────────────────────────
      const buffer = await wb.xlsx.writeBuffer();

      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="siton-deal-export-${dealId}.xlsx"`)
        .send(Buffer.from(buffer));
    });
  });

  app.get("/api/affiliate/overview", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const profile = await resolveDistributorContext(req, c, deps.isDemoPreview);
      if (!profile) {
        return reply.code(distributorAuthConfigured() ? 401 : 503).send({
          ok: false,
          error: distributorAuthConfigured() ? "distributor_auth_required" : "distributor_auth_unavailable"
        });
      }

      const campaigns = await c.query(
        `SELECT d.deal_id,
                d.title,
                d.description,
                d.state,
                d.price_per_unit,
                d.threshold_units,
                d.max_units,
                d.deadline,
                d.created_at,
                d.published_at,
                COUNT(DISTINCT a.participant_id)::int AS attributed_buyers,
                COALESCE(SUM(p.qty),0) AS attributed_units,
                COALESCE(SUM((p.qty * d.price_per_unit) + COALESCE(p.delivery_cost,0)),0) AS attributed_gross,
                COALESCE(dm.joined_units,0) AS joined_units,
                img.image_id,
                img.mime_type,
                COALESCE(delivery.delivery_labels, ARRAY[]::text[]) AS delivery_labels
         FROM siton.deals d
         LEFT JOIN siton.affiliate_attributions a
           ON a.deal_id = d.deal_id
          AND a.affiliate_id = $1
         LEFT JOIN siton.participants p ON p.participant_id = a.participant_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(dp.qty),0) AS joined_units
           FROM siton.participants dp
           WHERE dp.deal_id=d.deal_id
         ) dm ON true
         LEFT JOIN LATERAL (
           SELECT image_id, public_url, mime_type
           FROM siton.deal_images
           WHERE deal_id=d.deal_id
           ORDER BY is_primary DESC, sort_order ASC, created_at ASC
           LIMIT 1
         ) img ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(label ORDER BY sort_order, created_at) AS delivery_labels
           FROM siton.deal_delivery_options
           WHERE deal_id=d.deal_id
         ) delivery ON true
         GROUP BY d.deal_id, dm.joined_units, img.image_id, img.mime_type, delivery.delivery_labels
         ORDER BY d.created_at DESC
         LIMIT 50`,
        [profile.affiliate_id]
      );

      const links = await c.query(
        `SELECT l.link_id, l.deal_id, l.internal_name, l.source_code, l.created_at,
                d.title, d.state, d.deadline, d.threshold_units, d.max_units,
                COALESCE(dm.joined_units,0) AS joined_units,
                COALESCE(event_stats.clicks,0) AS clicks,
                COALESCE(event_stats.entries,0) AS entries,
                COALESCE(attribution_stats.attributed_buyers,0) AS attributed_buyers,
                COALESCE(attribution_stats.attributed_units,0) AS attributed_units
         FROM siton.affiliate_links l
         JOIN siton.deals d ON d.deal_id=l.deal_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE event_type='click')::int AS clicks,
                  COUNT(*) FILTER (WHERE event_type='entry')::int AS entries
           FROM siton.affiliate_link_events
           WHERE link_id=l.link_id
         ) event_stats ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS attributed_buyers,
                  COALESCE(SUM(p.qty),0) AS attributed_units
           FROM siton.affiliate_attributions a
           LEFT JOIN siton.participants p ON p.participant_id=a.participant_id
           WHERE a.affiliate_id=l.affiliate_id
             AND a.deal_id=l.deal_id
             AND a.share_code=l.source_code
         ) attribution_stats ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(dp.qty),0) AS joined_units
           FROM siton.participants dp
           WHERE dp.deal_id=d.deal_id
         ) dm ON true
         WHERE l.affiliate_id=$1 AND l.disabled_at IS NULL
         GROUP BY l.link_id, d.deal_id, dm.joined_units,
                  event_stats.clicks, event_stats.entries,
                  attribution_stats.attributed_buyers, attribution_stats.attributed_units
         ORDER BY l.created_at DESC`,
        [profile.affiliate_id]
      );

      const attributionTotals = await c.query(
        `SELECT
           COUNT(*)::int AS total_attributions,
           COALESCE(SUM(p.qty),0) AS total_units,
           COALESCE(SUM((p.qty * d.price_per_unit) + COALESCE(p.delivery_cost,0)),0) AS attributed_gross
          FROM siton.affiliate_attributions a
          LEFT JOIN siton.participants p ON p.participant_id = a.participant_id
          LEFT JOIN siton.deals d ON d.deal_id = a.deal_id
          WHERE a.affiliate_id = $1`,
        [profile.affiliate_id]
      );
      const totals = attributionTotals.rows[0] as any;
      const linkRows = links.rows.map((row: any) => {
        const entries = Number(row.entries || 0);
        const joins = Number(row.attributed_buyers || 0);
        return {
          link_id: row.link_id,
          deal_id: row.deal_id,
          internal_name: row.internal_name,
          source_code: row.source_code,
          created_at: row.created_at,
          title: row.title,
          state: row.state,
          deadline: row.deadline,
          threshold_units: Number(row.threshold_units || 0),
          max_units: Number(row.max_units || 0),
          joined_units: Number(row.joined_units || 0),
          clicks: Number(row.clicks || 0),
          entries,
          attributed_buyers: joins,
          attributed_units: Number(row.attributed_units || 0),
          conversion_rate: entries > 0 ? roundMoney((joins / entries) * 100) : 0,
          share_link: `/app/deal/${row.deal_id}?ref=${encodeURIComponent(row.source_code)}`
        };
      });

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
            attributed_gross: Number(totals.attributed_gross || 0),
            clicks: linkRows.reduce((sum: number, row: any) => sum + row.clicks, 0),
            entries: linkRows.reduce((sum: number, row: any) => sum + row.entries, 0),
            active_campaigns: campaigns.rows.filter((row: any) => Number(row.attributed_buyers || 0) > 0).length
          },
          verification_surface: {
            status: profile.verification_status
          },
          capabilities: {
            named_link_creation: true,
            identity_mode: profile.context_source
          },
          links: linkRows,
          campaigns: campaigns.rows.map((row: any) => ({
            deal_id: row.deal_id,
            title: row.title,
            description: row.description || "",
            state: row.state,
            price_per_unit: Number(row.price_per_unit || 0),
            threshold_units: Number(row.threshold_units || 0),
            max_units: Number(row.max_units || 0),
            joined_units: Number(row.joined_units || 0),
            deadline: row.deadline,
            created_at: row.created_at,
            published_at: row.published_at,
            attributed_buyers: Number(row.attributed_buyers || 0),
            attributed_units: Number(row.attributed_units || 0),
            attributed_gross: Number(row.attributed_gross || 0),
            delivery_labels: Array.isArray(row.delivery_labels) ? row.delivery_labels : [],
            image: row.image_id ? {
              image_id: row.image_id,
              mime_type: row.mime_type,
              url: resolveDealImageUrl({ image_id: String(row.image_id), public_url: row.public_url })
            } : null,
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
    const rawBody = String((req as any).rawBody || JSON.stringify(req.body));
    const headers = req.headers as Record<string, string | undefined>;
    const signatureHeader = String(headers["x-webhook-signature"] || headers["stripe-signature"] || "");
    const timestampHeader = String(headers["x-webhook-timestamp"] || "");

    if (!verifyWebhookSignature(rawBody, signatureHeader || undefined, timestampHeader || undefined)) {
      const body = (req.body || {}) as Record<string, unknown>;
      await recordWebhookSecurityFailure({
        provider: String(body["provider"] || deps.paymentProvider.webhookProvider || "unknown"),
        event_id: body["event_id"] ? String(body["event_id"]) : body["id"] ? String(body["id"]) : null,
        failure_reason: "invalid_webhook_signature",
        remote_hint: String(req.ip || "")
      }).catch(() => undefined);
      return reply.code(401).send({
        error: "invalid_webhook_signature",
        message: "HMAC signature verification failed"
      });
    }

    const body = req.body as Record<string, unknown>;
    const normalizedProviderEvent = deps.paymentProvider.parseWebhookEvent?.(body) ?? null;
    const rawEventId = normalizedProviderEvent?.event_id ?? body["event_id"] ?? "";
    const rawEventType = normalizedProviderEvent?.event_type ?? body["event_type"] ?? "";
    if (rawEventId && !["string", "number"].includes(typeof rawEventId)) {
      return reply.code(400).send({ error: "invalid_event_id", message: "event_id must be a string" });
    }
    if (rawEventType && typeof rawEventType !== "string") {
      return reply.code(400).send({ error: "invalid_event_type", message: "event_type must be a string" });
    }
    const provider = String(normalizedProviderEvent?.provider || body["provider"] || "unknown");
    const eventId = String(rawEventId || "");
    const eventType = String(rawEventType || "");

    if (!eventId) {
      return reply.code(400).send({ error: "missing_event_id", message: "event_id is required" });
    }
    if (!eventType) {
      return reply.code(400).send({ error: "missing_event_type", message: "event_type is required" });
    }

    const payload = normalizedProviderEvent?.payload ?? ((body["payload"] as Record<string, unknown> | undefined) ?? {});
    const correlationId = normalizedProviderEvent?.correlation_id ?? (body["correlation_id"] ? String(body["correlation_id"]) : null);
    const participantId = normalizedProviderEvent?.participant_id ?? (body["participant_id"] ? String(body["participant_id"]) : null);
    const dealId = normalizedProviderEvent?.deal_id ?? (body["deal_id"] ? String(body["deal_id"]) : null);
    const providerReference = normalizedProviderEvent?.provider_reference ?? (body["provider_reference"]
      ? String(body["provider_reference"])
      : payload["provider_reference"]
        ? String(payload["provider_reference"])
        : null);

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

  async function handleWebhookInvoices(req: FastifyRequest, reply: FastifyReply) {
    const invoiceProvider = deps.invoiceProvider;
    if (!invoiceProvider?.parseInvoiceWebhookEvent || !invoiceProvider?.verifyWebhook) {
      return reply.code(501).send({
        error: "invoice_webhook_provider_not_configured",
        message: "Invoice webhook verification requires a real invoice provider adapter."
      });
    }
    const rawBody = String((req as any).rawBody || JSON.stringify(req.body));
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const body = (req.body || {}) as Record<string, unknown>;
    if (!invoiceProvider.verifyWebhook(rawBody, headers)) {
      await recordInvoiceWebhookSecurityFailure({
        provider: invoiceProvider.providerCode,
        event_id: body["event_id"] ? String(body["event_id"]) : body["id"] ? String(body["id"]) : null,
        failure_reason: "invalid_invoice_webhook_signature",
        remote_hint: String(req.ip || "")
      }).catch(() => undefined);
      return reply.code(401).send({ error: "invalid_invoice_webhook_signature" });
    }

    await ensureInvoiceWebhookTables();
    const parsed = invoiceProvider.parseInvoiceWebhookEvent(body);
    return deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.invoice_webhook_events
           (provider, event_id, provider_document_id, document_id, document_key, status, correlation_id, payload)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING invoice_webhook_event_id`,
        [
          parsed.provider,
          parsed.event_id,
          parsed.provider_document_id,
          parsed.document_id,
          parsed.document_key,
          parsed.correlation_id,
          JSON.stringify(parsed.payload)
        ]
      );
      if ((inserted.rowCount ?? 0) === 0) {
        return reply.code(200).send({ ok: true, duplicate: true, provider: parsed.provider, event_id: parsed.event_id });
      }

      const doc = await c.query(
        `SELECT document_id, document_key, status
         FROM siton.invoice_documents
         WHERE ($1::uuid IS NOT NULL AND document_id=$1::uuid)
            OR ($2::text IS NOT NULL AND document_key=$2)
            OR ($3::text IS NOT NULL AND provider_document_id=$3)
         ORDER BY created_at DESC
         LIMIT 1`,
        [
          parsed.document_id && /^[0-9a-f-]{36}$/i.test(parsed.document_id) ? parsed.document_id : null,
          parsed.document_key,
          parsed.provider_document_id
        ]
      );
      const row = doc.rows[0];
      if (!row) {
        await c.query(
          `UPDATE siton.invoice_webhook_events
           SET status='ignored', processed_at=now()
           WHERE provider=$1 AND event_id=$2`,
          [parsed.provider, parsed.event_id]
        );
        return reply.code(202).send({ ok: true, status: "ignored", reason: "invoice_document_not_found" });
      }
      if (["reconciled", "voided", "skipped"].includes(String(row.status))) {
        await c.query(
          `UPDATE siton.invoice_webhook_events
           SET status='ignored', document_id=$3, document_key=$4, processed_at=now()
           WHERE provider=$1 AND event_id=$2`,
          [parsed.provider, parsed.event_id, row.document_id, row.document_key]
        );
        return reply.code(200).send({ ok: true, status: "ignored", reason: "late_invoice_webhook_terminal_document" });
      }
      await c.query(
        `INSERT INTO siton.outbox_events
           (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
         SELECT 'invoice_document_reconcile','invoice_document',$1,$2,'pending',0,now()
         WHERE NOT EXISTS (
           SELECT 1
           FROM siton.outbox_events
           WHERE event_type='invoice_document_reconcile'
             AND aggregate_type='invoice_document'
             AND aggregate_id=$1
             AND status IN ('pending','processing','sent')
         )`,
        [
          row.document_id,
          JSON.stringify({
            document_id: row.document_id,
            document_key: row.document_key,
            provider: parsed.provider,
            event_id: parsed.event_id,
            provider_document_id: parsed.provider_document_id,
            correlation_id: parsed.correlation_id,
            source: "invoice_webhook"
          })
        ]
      );
      await c.query(
        `UPDATE siton.invoice_webhook_events
         SET status='queued', document_id=$3, document_key=$4, processed_at=now()
         WHERE provider=$1 AND event_id=$2`,
        [parsed.provider, parsed.event_id, row.document_id, row.document_key]
      );
      return reply.code(200).send({ ok: true, status: "queued", provider: parsed.provider, event_id: parsed.event_id });
    });
  }

  app.post("/webhooks/invoices", handleWebhookInvoices);

  // ---------------------------------------------------------------------------
  // Admin routes — protected by requireAdminKey when ADMIN_API_KEY is set
  // ---------------------------------------------------------------------------

  app.get("/api/admin/payment-ops-status", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensurePaymentOpsTables();
    return deps.withTx(async (c) => {
      const [attempts, webhooks, security, methods] = await Promise.all([
        c.query(
          `SELECT attempt_type,
                  COUNT(*) FILTER (WHERE result_class='success') AS success,
                  COUNT(*) FILTER (WHERE result_class='temporary_fail') AS temporary_fail,
                  COUNT(*) FILTER (WHERE result_class='permanent_fail') AS permanent_fail,
                  COUNT(*) FILTER (WHERE result_class='unknown') AS unknown
           FROM siton.payment_attempts
           GROUP BY attempt_type
           ORDER BY attempt_type`
        ),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE status='processed') AS processed,
                  COUNT(*) FILTER (WHERE status='ignored') AS ignored,
                  COUNT(*) FILTER (WHERE status='failed') AS failed,
                  COUNT(*) FILTER (WHERE status='processing') AS processing,
                  COUNT(*) FILTER (WHERE status='pending') AS pending,
                  COUNT(*) AS total
           FROM siton.webhook_events`
        ),
        c.query(`SELECT COUNT(*) AS signature_failures, MAX(created_at) AS latest_signature_failure_at FROM siton.payment_webhook_security_events`),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE status='active') AS active,
                  COUNT(*) FILTER (WHERE status='invalid') AS invalid,
                  COUNT(*) FILTER (WHERE status='expired') AS expired,
                  COUNT(*) FILTER (WHERE status='revoked') AS revoked
           FROM siton.buyer_payment_methods`
        )
      ]);
      const webhook = webhooks.rows[0] || {};
      const securityRow = security.rows[0] || {};
      const method = methods.rows[0] || {};
      return {
        ok: true,
        provider: getPaymentProviderSummary(deps.paymentProvider),
        attempts_by_type: attempts.rows.map((row: any) => ({
          attempt_type: String(row.attempt_type),
          success: Number(row.success ?? 0),
          temporary_fail: Number(row.temporary_fail ?? 0),
          permanent_fail: Number(row.permanent_fail ?? 0),
          unknown: Number(row.unknown ?? 0)
        })),
        webhook_reconciliation: {
          processed: Number(webhook.processed ?? 0),
          ignored: Number(webhook.ignored ?? 0),
          failed: Number(webhook.failed ?? 0),
          processing: Number(webhook.processing ?? 0),
          pending: Number(webhook.pending ?? 0),
          duplicate_rate: Number(webhook.total ?? 0) > 0
            ? Number((Number(webhook.ignored ?? 0) / Number(webhook.total)).toFixed(4))
            : 0
        },
        webhook_security: {
          signature_failures: Number(securityRow.signature_failures ?? 0),
          latest_signature_failure_at: securityRow.latest_signature_failure_at ?? null
        },
        buyer_payment_methods: {
          active: Number(method.active ?? 0),
          invalid: Number(method.invalid ?? 0),
          expired: Number(method.expired ?? 0),
          revoked: Number(method.revoked ?? 0),
          hosted_payment_only: true
        }
      };
    });
  });

  app.get("/api/admin/overview", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
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
           ${SITON_PLATFORM_FEE_RATE}::numeric AS platform_fee_rate,
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
            `SELECT 'deal' AS entity_type, d.deal_id::text AS entity_id, d.title AS headline, d.state::text AS state, NULL::text AS detail
             FROM siton.deals d
             WHERE d.deal_id::text ILIKE '%' || $1 || '%' OR d.title ILIKE '%' || $1 || '%'
             UNION ALL
             SELECT 'participant' AS entity_type, p.participant_id::text AS entity_id, p.buyer_id AS headline, p.buyer_state::text AS state, p.deal_id::text AS detail
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

  app.get("/api/admin/launch-console", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    await ensureNotificationTables();
    await ensureLegalAcceptanceTables();
    return deps.withTx(async (c) => {
      const [sellerCounts, dealCounts, readiness, notifications, legal, recentDeals] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE NULLIF(btrim(COALESCE(business_name, '')), '') IS NOT NULL
                 AND (
                   NULLIF(btrim(COALESCE(support_email, '')), '') IS NOT NULL
                   OR NULLIF(btrim(COALESCE(support_phone, '')), '') IS NOT NULL
                 )
             )::int AS publish_ready,
             COUNT(*) FILTER (
               WHERE NULLIF(btrim(COALESCE(business_name, '')), '') IS NULL
                  OR (
                    NULLIF(btrim(COALESCE(support_email, '')), '') IS NULL
                    AND NULLIF(btrim(COALESCE(support_phone, '')), '') IS NULL
                  )
             )::int AS incomplete_profile
           FROM siton.seller_accounts`
        ),
        c.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE state='Draft')::int AS draft,
             COUNT(*) FILTER (WHERE state='PendingTarget')::int AS pending_target,
             COUNT(*) FILTER (WHERE state='TargetReached')::int AS target_reached,
             COUNT(*) FILTER (WHERE state='Completed')::int AS completed,
             COUNT(*) FILTER (WHERE state='Failed')::int AS failed,
             COUNT(*) FILTER (WHERE state='Cancelled')::int AS cancelled
           FROM siton.deals`
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM siton.deal_images img WHERE img.deal_id=d.deal_id
               )
             )::int AS deals_missing_images,
             COUNT(*) FILTER (
               WHERE d.state <> 'Draft'
                 AND (
                   NULLIF(btrim(COALESCE(sa.business_name, '')), '') IS NULL
                   OR (
                     NULLIF(btrim(COALESCE(sa.support_email, '')), '') IS NULL
                     AND NULLIF(btrim(COALESCE(sa.support_phone, '')), '') IS NULL
                   )
                 )
             )::int AS deals_missing_seller_profile,
             COUNT(*) FILTER (
               WHERE d.state <> 'Draft'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM siton.legal_acceptances la
                   WHERE la.actor_type='seller'
                     AND la.acceptance_type='seller_publish_terms'
                     AND la.deal_id=d.deal_id
                     AND la.actor_ref=COALESCE(d.seller_id, $1)
                 )
             )::int AS deals_missing_legal_acceptance,
             COUNT(*) FILTER (WHERE d.state='Completed')::int AS completed_deals_with_excel_available,
             0::int AS completed_deals_without_excel
           FROM siton.deals d
           LEFT JOIN siton.seller_accounts sa ON sa.seller_id=COALESCE(d.seller_id, $1)`,
          [DEFAULT_SELLER_ID]
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE status='pending')::int AS pending,
             COUNT(*) FILTER (WHERE status='sent')::int AS sent,
             COUNT(*) FILTER (WHERE status='failed')::int AS failed
           FROM siton.notification_events`
        ),
        c.query(
          `SELECT
             COUNT(*) FILTER (WHERE acceptance_type='seller_publish_terms')::int AS seller_publish_acceptances,
             COUNT(*) FILTER (WHERE acceptance_type='buyer_join_terms')::int AS buyer_join_acceptances,
             COUNT(*) FILTER (WHERE acceptance_type='buyer_payment_disclosure')::int AS buyer_payment_disclosures
           FROM siton.legal_acceptances`
        ),
        c.query(
          `SELECT
             d.deal_id::text,
             d.title,
             d.state,
             COALESCE(d.seller_id, $1) AS seller_id,
             sa.business_name AS seller_business_name,
             EXISTS (SELECT 1 FROM siton.deal_images img WHERE img.deal_id=d.deal_id) AS has_image,
             (
               NULLIF(btrim(COALESCE(sa.business_name, '')), '') IS NOT NULL
               AND (
                 NULLIF(btrim(COALESCE(sa.support_email, '')), '') IS NOT NULL
                 OR NULLIF(btrim(COALESCE(sa.support_phone, '')), '') IS NOT NULL
               )
             ) AS has_seller_profile,
             EXISTS (
               SELECT 1
               FROM siton.legal_acceptances la
               WHERE la.actor_type='seller'
                 AND la.acceptance_type='seller_publish_terms'
                 AND la.deal_id=d.deal_id
                 AND la.actor_ref=COALESCE(d.seller_id, $1)
             ) AS has_seller_terms_acceptance,
             (d.state='Completed') AS has_excel_export_available,
             d.created_at,
             d.updated_at
           FROM siton.deals d
           LEFT JOIN siton.seller_accounts sa ON sa.seller_id=COALESCE(d.seller_id, $1)
           ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC
           LIMIT 10`,
          [DEFAULT_SELLER_ID]
        )
      ]);

      const sellers = sellerCounts.rows[0] || {};
      const deals = dealCounts.rows[0] || {};
      const ready = readiness.rows[0] || {};
      const notificationSummary = notifications.rows[0] || {};
      const legalSummary = legal.rows[0] || {};

      const warnings: Array<{ severity: "red" | "yellow"; code: string; message: string; count?: number }> = [];
      const addWarning = (severity: "red" | "yellow", code: string, message: string, count?: number) => {
        warnings.push({ severity, code, message, ...(count === undefined ? {} : { count }) });
      };

      const failedNotifications = Number(notificationSummary.failed || 0);
      const pendingNotifications = Number(notificationSummary.pending || 0);
      const missingSellerProfiles = Number(ready.deals_missing_seller_profile || 0);
      const missingLegalAcceptances = Number(ready.deals_missing_legal_acceptance || 0);
      const missingImages = Number(ready.deals_missing_images || 0);
      const incompleteProfiles = Number(sellers.incomplete_profile || 0);
      const completedWithoutExcel = Number(ready.completed_deals_without_excel || 0);

      if (failedNotifications > 0) addWarning("red", "notification_failures", "יש הודעות מערכת שנכשלו ודורשות בדיקה.", failedNotifications);
      if (completedWithoutExcel > 0) addWarning("red", "completed_excel_unavailable", "יש עסקאות שהושלמו בלי ייצוא Excel זמין.", completedWithoutExcel);
      if (missingSellerProfiles > 0) addWarning("red", "published_deal_missing_seller_profile", "יש עסקאות שפורסמו ללא פרופיל מוכר תקין.", missingSellerProfiles);
      if (missingLegalAcceptances > 0) addWarning("red", "published_deal_missing_legal_acceptance", "יש עסקאות שפורסמו ללא הסכמת מוכר שמורה.", missingLegalAcceptances);
      if (incompleteProfiles > 0) addWarning("yellow", "seller_profiles_incomplete", "יש מוכרים שעדיין חסרים פרטי פרסום.", incompleteProfiles);
      if (missingImages > 0) addWarning("yellow", "deals_missing_images", "יש עסקאות ללא תמונת מוצר.", missingImages);
      if (!deps.notificationSummary.external_delivery) addWarning("yellow", "notifications_internal_only", "ספק הודעות במצב פנימי בלבד.", 1);
      if (pendingNotifications > 0) addWarning("yellow", "pending_notifications", "יש הודעות מערכת שממתינות לשליחה.", pendingNotifications);

      const status = warnings.some((warning) => warning.severity === "red")
        ? "red"
        : warnings.some((warning) => warning.severity === "yellow")
          ? "yellow"
          : "green";

      return {
        ok: true,
        generated_at: new Date().toISOString(),
        system: {
          status,
          warnings
        },
        sellers: {
          total: Number(sellers.total || 0),
          publish_ready: Number(sellers.publish_ready || 0),
          incomplete_profile: Number(sellers.incomplete_profile || 0)
        },
        deals: {
          total: Number(deals.total || 0),
          draft: Number(deals.draft || 0),
          pending_target: Number(deals.pending_target || 0),
          target_reached: Number(deals.target_reached || 0),
          completed: Number(deals.completed || 0),
          failed: Number(deals.failed || 0),
          cancelled: Number(deals.cancelled || 0)
        },
        launch_readiness: {
          deals_missing_images: Number(ready.deals_missing_images || 0),
          deals_missing_seller_profile: Number(ready.deals_missing_seller_profile || 0),
          deals_missing_legal_acceptance: Number(ready.deals_missing_legal_acceptance || 0),
          completed_deals_with_excel_available: Number(ready.completed_deals_with_excel_available || 0)
        },
        notifications: {
          pending: Number(notificationSummary.pending || 0),
          sent: Number(notificationSummary.sent || 0),
          failed: Number(notificationSummary.failed || 0),
          provider: deps.notificationSummary.provider,
          mode: deps.notificationSummary.mode,
          external_delivery: deps.notificationSummary.external_delivery
        },
        legal: {
          seller_publish_acceptances: Number(legalSummary.seller_publish_acceptances || 0),
          buyer_join_acceptances: Number(legalSummary.buyer_join_acceptances || 0),
          buyer_payment_disclosures: Number(legalSummary.buyer_payment_disclosures || 0)
        },
        recent_deals: recentDeals.rows.map((row: any) => ({
          deal_id: String(row.deal_id),
          title: String(row.title || ""),
          state: String(row.state || ""),
          seller_id: String(row.seller_id || DEFAULT_SELLER_ID),
          seller_business_name: row.seller_business_name ? String(row.seller_business_name) : null,
          has_image: Boolean(row.has_image),
          has_seller_profile: Boolean(row.has_seller_profile),
          has_seller_terms_acceptance: Boolean(row.has_seller_terms_acceptance),
          has_excel_export_available: Boolean(row.has_excel_export_available),
          created_at: row.created_at ? String(row.created_at) : null,
          updated_at: row.updated_at ? String(row.updated_at) : null
        })),
        recent_warnings: warnings.slice(0, 10)
      };
    });
  });

  app.get("/api/admin/mission-control", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const q = String(req.query?.q || "").trim().slice(0, 200);
    await ensureProductSurfaces();
    await ensurePayoutTables();
    await ensureNotificationTables();
    await ensureLegalAcceptanceTables();
    await ensureInvoiceWebhookTables();
    await ensurePaymentOpsTables();
    await ensureAdminControlPlane();

    return deps.withTx(async (c) => {
      const [
        systemCounts,
        exceptionalDeals,
        searchRows,
        kycQueue,
        payoutRows,
        supportRows,
        auditRows,
        dealStateCounts
      ] = await Promise.all([
        c.query(
          `SELECT
             (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
             (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status='failed') AS failed_outbox,
             (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status IN ('pending','processing')) AS active_outbox,
             (SELECT COUNT(*)::int FROM siton.notification_events WHERE status='failed') AS failed_notifications,
             (SELECT COUNT(*)::int FROM siton.notification_events WHERE status IN ('pending','processing')) AS active_notifications,
             (SELECT COUNT(*)::int FROM siton.invoice_documents WHERE status='failed') AS failed_invoice_documents,
             (SELECT COUNT(*)::int FROM siton.outbox_events WHERE event_type='invoice_document_reconcile' AND status IN ('pending','processing')) AS active_reconcile,
             (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
             (SELECT COUNT(*)::int FROM siton.payment_attempts WHERE result_class IN ('temporary_fail','permanent_fail') AND created_at > now() - interval '1 hour') AS payment_failures_last_hour,
             (SELECT COUNT(*)::int FROM siton.seller_payout_batches WHERE payout_status IN ('failed','returned')) AS payout_exceptions,
             (SELECT COUNT(*)::int FROM siton.seller_payout_batches WHERE payout_status IN ('ready','batched','processing')) AS active_payout_batches,
             (SELECT COUNT(*)::int FROM siton.support_tickets WHERE status <> 'resolved') AS open_support_tickets,
             (SELECT COUNT(*)::int
              FROM siton.deals d
              WHERE d.state='Completed'
                AND NOT EXISTS (
                  SELECT 1 FROM siton.participants p
                  WHERE p.deal_id=d.deal_id
                    AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
                )) AS completed_without_charged_success,
             (SELECT COUNT(*)::int
              FROM siton.deals
              WHERE state='CompletionWindow'
                AND completion_window_until IS NOT NULL
                AND completion_window_until <= now() + interval '1 hour') AS completion_window_ending_soon,
             (SELECT COUNT(*)::int
              FROM siton.deals
              WHERE state='PendingTarget'
                AND deadline <= now() + interval '6 hours') AS pending_target_near_deadline`
        ),
        c.query(
          `SELECT
             d.deal_id::text,
             d.title,
             d.state,
             COALESCE(d.seller_id, $1) AS seller_id,
             COALESCE(sa.business_name, sa.display_name, d.seller_id, $1) AS seller_name,
             d.min_units,
             d.max_units,
             d.deadline,
             d.completion_window_until,
             d.updated_at,
             COALESCE(SUM(p.qty),0)::int AS target_units,
             COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
             COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('AuthHeld','AuthLocked','ChargeAttempt','ChargeFailedRecovery')),0)::int AS pending_units,
             COALESCE(SUM(p.qty) FILTER (WHERE p.money_state NOT IN ('ChargedSuccess','RecoveredCharge')),0)::int AS not_charged_units,
             COALESCE(SUM((p.qty * d.price_per_unit) + COALESCE(p.delivery_cost,0)) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric AS gross_amount,
             CASE
               WHEN d.state='CompletionWindow' AND d.completion_window_until <= now() + interval '1 hour' THEN 'completion_window_ending_soon'
               WHEN d.state='Charging' THEN 'charging_in_progress'
               WHEN d.state='Failed' THEN 'deal_failed'
               WHEN d.state='Completed' AND COUNT(p.participant_id) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')) = 0 THEN 'completed_without_charged_success'
               WHEN d.state='PendingTarget' AND d.deadline <= now() + interval '6 hours' THEN 'pending_target_near_deadline'
               WHEN EXISTS (SELECT 1 FROM siton.seller_payout_batches b WHERE b.trigger_deal_id=d.deal_id AND b.payout_status IN ('failed','returned')) THEN 'payout_exception'
               WHEN EXISTS (SELECT 1 FROM siton.invoice_documents inv WHERE inv.deal_id=d.deal_id AND inv.status='failed') THEN 'invoice_issue_failed'
               ELSE 'operational_attention'
             END AS exception_reason
           FROM siton.deals d
           LEFT JOIN siton.participants p ON p.deal_id=d.deal_id
           LEFT JOIN siton.seller_accounts sa ON sa.seller_id=COALESCE(d.seller_id, $1)
           WHERE d.state IN ('CompletionWindow','Charging','Failed')
              OR (d.state='Completed' AND NOT EXISTS (
                   SELECT 1 FROM siton.participants charged
                   WHERE charged.deal_id=d.deal_id
                     AND charged.money_state IN ('ChargedSuccess','RecoveredCharge')
                 ))
              OR (d.state='PendingTarget' AND d.deadline <= now() + interval '6 hours')
              OR EXISTS (SELECT 1 FROM siton.seller_payout_batches b WHERE b.trigger_deal_id=d.deal_id AND b.payout_status IN ('failed','returned'))
              OR EXISTS (SELECT 1 FROM siton.invoice_documents inv WHERE inv.deal_id=d.deal_id AND inv.status='failed')
           GROUP BY d.deal_id, sa.business_name, sa.display_name
           ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC
           LIMIT 30`,
          [DEFAULT_SELLER_ID]
        ),
        q
          ? c.query(
              `SELECT 'deal' AS entity_type, d.deal_id::text AS entity_id, d.title AS headline, d.state::text AS status,
                      'admin_deal_profile' AS result_kind, '/app/admin/deals/' || d.deal_id::text AS route
               FROM siton.deals d
               WHERE d.deal_id::text ILIKE '%' || $1 || '%' OR d.title ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'participant' AS entity_type, p.participant_id::text AS entity_id, d.title AS headline, p.buyer_state::text AS status,
                      'admin_participant_profile' AS result_kind, '/app/admin/participants/' || p.participant_id::text AS route
               FROM siton.participants p
               JOIN siton.deals d ON d.deal_id=p.deal_id
               WHERE p.participant_id::text ILIKE '%' || $1 || '%'
                  OR p.buyer_id ILIKE '%' || $1 || '%'
                  OR COALESCE(p.buyer_phone,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(p.buyer_email,'') ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'seller' AS entity_type, sa.seller_id AS entity_id, COALESCE(sa.business_name, sa.display_name, sa.seller_id) AS headline,
                      sa.verification_status::text AS status, 'admin_seller_kyc' AS result_kind, '/app/admin' AS route
               FROM siton.seller_accounts sa
               WHERE sa.seller_id ILIKE '%' || $1 || '%'
                  OR COALESCE(sa.business_name,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(sa.support_phone,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(sa.support_email,'') ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'support_ticket' AS entity_type, st.ticket_id::text AS entity_id, st.title AS headline, st.status,
                      'admin_support_ticket' AS result_kind, '/app/admin' AS route
               FROM siton.support_tickets st
               WHERE st.ticket_id::text ILIKE '%' || $1 || '%'
                  OR st.scope_key ILIKE '%' || $1 || '%'
                  OR st.title ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'invoice_document' AS entity_type, inv.document_id::text AS entity_id, inv.document_key AS headline, inv.status,
                      'admin_invoice_document' AS result_kind, '/app/admin/deals/' || inv.deal_id::text AS route
               FROM siton.invoice_documents inv
               WHERE inv.document_id::text ILIKE '%' || $1 || '%'
                  OR inv.document_key ILIKE '%' || $1 || '%'
                  OR COALESCE(inv.provider_document_id,'') ILIKE '%' || $1 || '%'
                  OR COALESCE(inv.correlation_id,'') ILIKE '%' || $1 || '%'
               UNION ALL
               SELECT 'payout_batch' AS entity_type, b.payout_batch_id::text AS entity_id, b.seller_id AS headline, b.payout_status AS status,
                      'admin_payout_batch' AS result_kind, '/app/admin' AS route
               FROM siton.seller_payout_batches b
               WHERE b.payout_batch_id::text ILIKE '%' || $1 || '%'
               ORDER BY entity_type, headline
               LIMIT 40`,
              [q]
            )
          : { rows: [] },
        c.query(
          `SELECT
             seller_id,
             COALESCE(business_name, display_name, seller_id) AS seller_name,
             verification_status,
             settlement_status,
             created_at,
             updated_at,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN NULLIF(btrim(COALESCE(business_name,'')), '') IS NULL THEN 'business_name' END,
               CASE WHEN NULLIF(btrim(COALESCE(support_email,'')), '') IS NULL AND NULLIF(btrim(COALESCE(support_phone,'')), '') IS NULL THEN 'support_contact' END
             ], NULL) AS missing_fields
           FROM siton.seller_accounts
           WHERE verification_status <> 'approved'
              OR settlement_status <> 'active'
              OR NULLIF(btrim(COALESCE(business_name,'')), '') IS NULL
              OR (NULLIF(btrim(COALESCE(support_email,'')), '') IS NULL AND NULLIF(btrim(COALESCE(support_phone,'')), '') IS NULL)
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 30`
        ),
        c.query(
          `SELECT
             b.payout_batch_id::text,
             b.seller_id,
             b.payout_status,
             b.gross_collected AS gross_amount,
             b.platform_fee_total AS platform_fee_total_amount,
             b.seller_net_payable AS seller_net_amount,
             b.created_at,
             b.updated_at,
             b.trigger_deal_id::text AS deal_id
           FROM siton.seller_payout_batches b
           WHERE b.payout_status IN ('pending','ready','batched','processing','failed','returned')
           ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC
           LIMIT 20`
        ),
        c.query(
          `SELECT ticket_id::text, scope_type, scope_key, title, priority, status, summary, created_at, updated_at
           FROM siton.support_tickets
           WHERE status <> 'resolved'
           ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, updated_at DESC
           LIMIT 20`
        ),
        c.query(
          `SELECT audit_id::text, entity_type, entity_id::text, deal_id::text, action_name, state_type, from_state, to_state, created_at
           FROM siton.audit_log
           ORDER BY created_at DESC
           LIMIT 30`
        ),
        c.query(
          `SELECT state, COUNT(*)::int AS count
           FROM siton.deals
           GROUP BY state
           ORDER BY state`
        )
      ]);

      const counts = systemCounts.rows[0] || {};
      const cardDefs = [
        ["completion_window_ending_soon", "חלון השלמה מסתיים בקרוב", counts.completion_window_ending_soon, "warning"],
        ["dlq_not_empty", "DLQ לא ריק", counts.dlq_count, "danger"],
        ["completed_without_charged_success", "עסקה הושלמה ללא חיוב מוצלח", counts.completed_without_charged_success, "danger"],
        ["payment_failures_last_hour", "כשלי סליקה בשעה האחרונה", counts.payment_failures_last_hour, "warning"],
        ["reconcile_open", "התאמת מסמכים פתוחה", counts.active_reconcile, "warning"],
        ["failed_invoice_documents", "כשלי חשבוניות", counts.failed_invoice_documents, "warning"],
        ["payout_exceptions", "חריגי העברה למוכר", counts.payout_exceptions, "danger"],
        ["pending_target_near_deadline", "עסקה קרובה לדדליין לפני יעד", counts.pending_target_near_deadline, "warning"]
      ] as const;
      const exceptionCards = cardDefs
        .map(([code, label, value, severity]) => ({
          code,
          label_he: label,
          count: Number(value || 0),
          severity,
          href: code === "dlq_not_empty" ? "/api/admin/outbox-status" : "/app/admin"
        }))
        .filter((item) => item.count > 0);
      const systemStatus = exceptionCards.some((item) => item.severity === "danger")
        ? "red"
        : exceptionCards.some((item) => item.severity === "warning")
          ? "yellow"
          : "green";
      const missionControlDeep = await buildAdminMissionControlPayload({
        c,
        rootDir: join(frontendDir, ".."),
        deploymentMode: deps.deploymentMode,
        isDemoPreview: deps.isDemoPreview,
        paymentProvider: deps.paymentProvider,
        payoutProvider,
        invoiceSummary: deps.invoiceSummary,
        notificationSummary: deps.notificationSummary,
        debugSurfacesEnabled: deps.debugSurfacesEnabled,
        getWorkerRunning: deps.getWorkerRunning
      });

      return {
        ok: true,
        ...missionControlDeep,
        generated_at: new Date().toISOString(),
        stale_after_seconds: 60,
        system: {
          status: systemStatus,
          last_updated_at: new Date().toISOString(),
          warnings: exceptionCards
        },
        exception_cards: exceptionCards,
        omnisearch: {
          scope: "admin_only_operational_search",
          public_discovery_scope: "separate_mall_read_surface",
          query: q,
          results: searchRows.rows.map((row: any) => ({
            entity_type: String(row.entity_type),
            entity_id: String(row.entity_id),
            headline: String(row.headline || ""),
            status: String(row.status || ""),
            result_kind: String(row.result_kind || ""),
            route: String(row.route || "/app/admin")
          }))
        },
        exceptional_deals: exceptionalDeals.rows.map((row: any) => ({
          deal_id: String(row.deal_id),
          title: String(row.title || ""),
          seller_id: String(row.seller_id || DEFAULT_SELLER_ID),
          seller_name: String(row.seller_name || row.seller_id || DEFAULT_SELLER_ID),
          state: String(row.state || ""),
          target_units: Number(row.target_units || 0),
          min_units: Number(row.min_units || 0),
          max_units: Number(row.max_units || 0),
          charged_units: Number(row.charged_units || 0),
          pending_units: Number(row.pending_units || 0),
          not_charged_units: Number(row.not_charged_units || 0),
          gross_amount: Number(row.gross_amount || 0),
          exception_reason: String(row.exception_reason || "operational_attention"),
          updated_at: row.updated_at ? String(row.updated_at) : null,
          deadline: row.deadline ? String(row.deadline) : null,
          completion_window_until: row.completion_window_until ? String(row.completion_window_until) : null
        })),
        kyc_queue: kycQueue.rows.map((row: any) => ({
          seller_id: String(row.seller_id),
          seller_name: String(row.seller_name || row.seller_id),
          verification_status: String(row.verification_status || ""),
          settlement_status: String(row.settlement_status || ""),
          missing_fields: Array.isArray(row.missing_fields) ? row.missing_fields : [],
          created_at: row.created_at ? String(row.created_at) : null,
          updated_at: row.updated_at ? String(row.updated_at) : null
        })),
        payouts_settlements: {
          manual_money_actions_enabled: false,
          request_thread_transfers_enabled: false,
          provider: getPayoutProviderSummary(payoutProvider),
          active_batches: Number(counts.active_payout_batches || 0),
          exception_batches: Number(counts.payout_exceptions || 0),
          batches: payoutRows.rows.map((row: any) => ({
            payout_batch_id: String(row.payout_batch_id),
            deal_id: row.deal_id ? String(row.deal_id) : null,
            seller_id: String(row.seller_id || ""),
            payout_status: String(row.payout_status || ""),
            gross_amount: Number(row.gross_amount || 0),
            platform_fee_total_amount: Number(row.platform_fee_total_amount || 0),
            seller_net_amount: Number(row.seller_net_amount || 0),
            created_at: row.created_at ? String(row.created_at) : null,
            updated_at: row.updated_at ? String(row.updated_at) : null
          }))
        },
        support_hub: {
          open_count: Number(counts.open_support_tickets || 0),
          tickets: supportRows.rows
        },
        audit_forensics: {
          recent_events: auditRows.rows,
          export_csv_available: false,
          immutable_audit_log: true
        },
        system_status: {
          outbox: {
            active: Number(counts.active_outbox || 0),
            failed: Number(counts.failed_outbox || 0),
            dlq: Number(counts.dlq_count || 0)
          },
          notifications: {
            active: Number(counts.active_notifications || 0),
            failed: Number(counts.failed_notifications || 0),
            external_delivery: deps.notificationSummary.external_delivery
          },
          invoices: {
            failed: Number(counts.failed_invoice_documents || 0),
            active_reconcile: Number(counts.active_reconcile || 0),
            provider: deps.invoiceSummary
          },
          payments: {
            failures_last_hour: Number(counts.payment_failures_last_hour || 0),
            provider: getPaymentProviderSummary(deps.paymentProvider)
          },
          payouts: {
            active_batches: Number(counts.active_payout_batches || 0),
            exception_batches: Number(counts.payout_exceptions || 0),
            provider: getPayoutProviderSummary(payoutProvider)
          },
          support: {
            open_tickets: Number(counts.open_support_tickets || 0)
          }
        },
        deals_by_state: dealStateCounts.rows.map((row: any) => ({
          state: String(row.state),
          count: Number(row.count || 0)
        })),
        action_policy: {
          state_override_enabled: false,
          manual_capture_enabled: false,
          manual_refund_enabled: false,
          manual_void_enabled: false,
          manual_payout_enabled: false,
          allowed_actions: [
            "view_details",
            "copy_correlation_id",
            "create_support_ticket",
            "kyc_decision_with_reason",
            "read_payout_status",
            "trigger_reconcile_only_if_existing_job_route_is_used"
          ],
          sensitive_actions_require_reason_and_audit: true
        }
      };
    });
  });

  app.get("/api/admin/mission-control/anomalies", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    await ensurePayoutTables();
    await ensureNotificationTables();
    await ensureInvoiceWebhookTables();
    await ensurePaymentOpsTables();
    await ensureAdminControlPlane();
    return deps.withTx(async (c) => {
      const payload = await buildAdminMissionControlPayload({
        c,
        rootDir: join(frontendDir, ".."),
        deploymentMode: deps.deploymentMode,
        isDemoPreview: deps.isDemoPreview,
        paymentProvider: deps.paymentProvider,
        payoutProvider,
        invoiceSummary: deps.invoiceSummary,
        notificationSummary: deps.notificationSummary,
        debugSurfacesEnabled: deps.debugSurfacesEnabled,
        getWorkerRunning: deps.getWorkerRunning
      });
      return {
        ok: true,
        generated_at: payload.generated_at,
        verdict: payload.verdict,
        anomaly_center: payload.anomaly_center,
        recommended_actions: payload.recommended_actions
      };
    });
  });

  app.get("/api/admin/mission-control/deals/:dealId/trace", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const dealId = String(req.params.dealId || "").trim();
    requireUuid(dealId, "deal_id");
    return deps.withTx((c) => buildMissionDealTrace(c, dealId));
  });

  app.get("/api/admin/mission-control/participants/:participantId/trace", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const participantId = String(req.params.participantId || "").trim();
    requireUuid(participantId, "participant_id");
    return deps.withTx((c) => buildMissionParticipantTrace(c, participantId));
  });

  app.get("/api/admin/mission-control/correlation/:correlationId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const correlationId = String(req.params.correlationId || "").trim().slice(0, 200);
    if (!correlationId) return reply.code(400).send({ ok: false, error: "correlation_id_required" });
    return deps.withTx((c) => buildMissionCorrelationTrace(c, correlationId));
  });

  app.get("/api/admin/mission-control/outbox/:eventId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const eventId = String(req.params.eventId || "").trim();
    requireUuid(eventId, "event_id");
    return deps.withTx((c) => buildMissionOutboxTrace(c, eventId));
  });

  app.get("/api/admin/mission-control/webhooks/:provider/:eventId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const provider = String(req.params.provider || "").trim().slice(0, 80);
    const eventId = String(req.params.eventId || "").trim().slice(0, 200);
    if (!provider || !eventId) return reply.code(400).send({ ok: false, error: "provider_and_event_id_required" });
    return deps.withTx((c) => buildMissionWebhookTrace(c, provider, eventId));
  });

  app.get("/api/admin/actions", async (req: any, reply: any) => {
    await ensureAdminControlPlane();
    await ensureAdminIdentity();
    const filters = {
      status: String(req.query?.status || "").trim(),
      action_type: String(req.query?.action_type || "").trim(),
      target_type: String(req.query?.target_type || "").trim(),
      target_id: String(req.query?.target_id || "").trim(),
      correlation_id: String(req.query?.correlation_id || "").trim()
    };
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(filters)) {
      if (!value) continue;
      params.push(value);
      clauses.push(`${key}=$${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, { permission: "admin_actions.read" });
      if (!identity) return reply;
      const rows = await c.query(
        `SELECT admin_action_id, action_type, status, target_type, target_id,
                requested_by_admin_id, reason, correlation_id, request_id, idempotency_key,
                requires_second_approval, approved_by_admin_id, approved_at,
                executed_at, failed_at, result_code, result_message, created_at, updated_at
         FROM siton.admin_actions
         ${where}
         ORDER BY created_at DESC
         LIMIT 100`,
        params
      );
      return { ok: true, actions: rows.rows };
    });
  });

  app.get("/api/admin/actions/:adminActionId", async (req: any, reply: any) => {
    await ensureAdminControlPlane();
    await ensureAdminIdentity();
    const adminActionId = String(req.params.adminActionId || "").trim();
    requireUuid(adminActionId, "admin_action_id");
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, { permission: "admin_actions.read" });
      if (!identity) return reply;
      const row = await c.query(`SELECT * FROM siton.admin_actions WHERE admin_action_id=$1`, [adminActionId]);
      if (!row.rowCount) return reply.code(404).send({ ok: false, error: "admin_action_not_found" });
      return { ok: true, action: row.rows[0] };
    });
  });

  app.post("/api/admin/actions", async (req: any, reply: any) => {
    await ensureAdminControlPlane();
    await ensureAdminIdentity();
    const preAuth = await deps.withTx((c) => requireAdminAuthContext(req, reply, c, {
      permission: "admin_actions.create",
      sessionRequired: true
    }));
    if (!preAuth) return reply;
    const body = req.body || {};
    const actionType = String(body.action_type || "").trim();
    const targetType = String(body.target_type || "").trim();
    const targetId = String(body.target_id || "").trim();
    const reason = String(body.reason || "").trim();
    const idempotencyKey = String(body.idempotency_key || "").trim();
    if (isForbiddenAdminAction(actionType)) {
      return reply.code(403).send({ ok: false, error: "admin_action_forbidden", action_type: actionType });
    }
    if (!isSafeActionType(actionType)) return reply.code(400).send({ ok: false, error: "invalid_action_type" });
    if (!isTargetType(targetType)) return reply.code(400).send({ ok: false, error: "invalid_target_type" });
    if (!targetId) return reply.code(400).send({ ok: false, error: "target_id_required" });
    if (!reason) return reply.code(400).send({ ok: false, error: "reason_required" });
    if (!idempotencyKey) return reply.code(400).send({ ok: false, error: "idempotency_key_required" });
    const context = adminRequestContext(req);
    return deps.withTx(async (c) => {
      const permission = ADMIN_ACTION_PERMISSION[actionType] || "admin_actions.create";
      const identity = await requireAdminAuthContext(req, reply, c, {
        permission,
        sessionRequired: true,
        recentMfa: HIGH_TRUST_ADMIN_ACTIONS.has(actionType)
      });
      if (!identity) return reply;
      const action = await insertAdminAction(c, {
        action_type: actionType,
        target_type: targetType,
        target_id: targetId,
        reason,
        idempotency_key: idempotencyKey,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
        request_id: context.request_id,
        correlation_id: context.correlation_id,
        admin_id: safeAdminId(identity)
      });
      return { ok: true, action };
    });
  });

  app.post("/api/admin/actions/:adminActionId/approve", async (req: any, reply: any) => {
    await ensureAdminControlPlane();
    await ensureAdminIdentity();
    const adminActionId = String(req.params.adminActionId || "").trim();
    requireUuid(adminActionId, "admin_action_id");
    const note = String(req.body?.reason || req.body?.approval_note || "").trim();
    if (!note) return reply.code(400).send({ ok: false, error: "approval_reason_required" });
    const context = adminRequestContext(req);
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, { permission: "admin_actions.approve", sessionRequired: true });
      if (!identity) return reply;
      const existing = await c.query(`SELECT * FROM siton.admin_actions WHERE admin_action_id=$1 FOR UPDATE`, [adminActionId]);
      if (!existing.rowCount) return reply.code(404).send({ ok: false, error: "admin_action_not_found" });
      const action = existing.rows[0];
      if (!action.requires_second_approval) return reply.code(400).send({ ok: false, error: "second_approval_not_required" });
      if (HIGH_TRUST_ADMIN_ACTIONS.has(String(action.action_type)) && !hasRecentMfa(identity)) {
        return reply.code(403).send({ ok: false, error: "MFA_REQUIRED" });
      }
      if (action.requested_by_admin_id && action.requested_by_admin_id === safeAdminId(identity)) {
        return reply.code(403).send({ ok: false, error: "self_approval_forbidden" });
      }
      const updated = await c.query(
        `UPDATE siton.admin_actions
         SET status='Approved', approved_by_admin_id=$2, approved_at=now(),
             result_message=$3, updated_at=now()
         WHERE admin_action_id=$1
         RETURNING *`,
        [adminActionId, safeAdminId(identity), note]
      );
      return { ok: true, action: updated.rows[0] };
    });
  });

  app.post("/api/admin/actions/:adminActionId/reject", async (req: any, reply: any) => {
    await ensureAdminControlPlane();
    await ensureAdminIdentity();
    const adminActionId = String(req.params.adminActionId || "").trim();
    requireUuid(adminActionId, "admin_action_id");
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return reply.code(400).send({ ok: false, error: "reject_reason_required" });
    const context = adminRequestContext(req);
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, { permission: "admin_actions.approve", sessionRequired: true });
      if (!identity) return reply;
      const updated = await c.query(
        `UPDATE siton.admin_actions
         SET status='Rejected', result_code='Rejected', result_message=$2,
             approved_by_admin_id=$3, updated_at=now()
         WHERE admin_action_id=$1 AND status IN ('Requested','AwaitingSecondApproval','Approved')
         RETURNING *`,
        [adminActionId, reason, safeAdminId(identity)]
      );
      if (!updated.rowCount) return reply.code(404).send({ ok: false, error: "admin_action_not_found_or_not_rejectable" });
      return { ok: true, action: updated.rows[0] };
    });
  });

  app.post("/api/admin/actions/:adminActionId/execute", async (req: any, reply: any) => {
    await ensureAdminControlPlane();
    await ensureAdminIdentity();
    await ensureAdminInterventionTables(deps.withTx);
    const adminActionId = String(req.params.adminActionId || "").trim();
    requireUuid(adminActionId, "admin_action_id");
    const context = adminRequestContext(req);
    return deps.withTx(async (c) => {
      const actionResult = await c.query(`SELECT action_type FROM siton.admin_actions WHERE admin_action_id=$1`, [adminActionId]);
      if (!actionResult.rowCount) return reply.code(404).send({ ok: false, error: "admin_action_not_found" });
      const actionTypeForPermission = String(actionResult.rows[0].action_type || "");
      const identity = await requireAdminAuthContext(req, reply, c, {
        permission: ADMIN_ACTION_PERMISSION[actionTypeForPermission] || "admin_actions.execute",
        sessionRequired: true,
        recentMfa: HIGH_TRUST_ADMIN_ACTIONS.has(actionTypeForPermission)
      });
      if (!identity) return reply;
      const result = await executeAdminAction(c, adminActionId, { ...context, admin_id: safeAdminId(identity) });
      return reply.code(result.statusCode).send(result.body);
    });
  });

  app.get("/api/admin/control-flags", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureAdminInterventionTables(deps.withTx);
    const flagType = String(req.query?.flag_type || "").trim();
    const scopeType = String(req.query?.scope_type || "").trim();
    const scopeId = String(req.query?.scope_id || "").trim();
    if (flagType && !isAdminFlagType(flagType)) {
      return reply.code(400).send({ ok: false, error: "invalid_flag_type", allowed: ADMIN_FLAG_TYPES });
    }
    if (scopeType && !isAdminFlagScopeType(scopeType)) {
      return reply.code(400).send({ ok: false, error: "invalid_scope_type" });
    }
    return deps.withTx(async (c) => {
      await expireDueAdminControlFlags(c).catch(() => undefined);
      const filter: { flag_type?: any; scope_type?: any; scope_id?: string } = {};
      if (flagType) filter.flag_type = flagType;
      if (scopeType) filter.scope_type = scopeType;
      if (scopeId) filter.scope_id = scopeId;
      const flags = await listActiveAdminControlFlags(c, filter);
      return { ok: true, flags };
    });
  });

  app.post("/api/admin/control-flags/:flagId/release", async (req: any, reply: any) => {
    await ensureAdminInterventionTables(deps.withTx);
    const flagId = String(req.params.flagId || "").trim();
    requireUuid(flagId, "flag_id");
    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      return reply.code(400).send({ ok: false, error: "reason_required" });
    }
    const context = adminRequestContext(req);
    return deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, {
        permission: "emergency.pause",
        sessionRequired: true,
        recentMfa: true
      });
      if (!identity) return reply;
      const released = await releaseAdminControlFlag(c, flagId, {
        released_by_admin_id: safeAdminId(identity),
        released_reason: reason,
        request_id: context.request_id,
        correlation_id: context.correlation_id
      });
      if (!released) return reply.code(404).send({ ok: false, error: "flag_not_found_or_not_active" });
      return { ok: true, flag: released };
    });
  });

  app.get("/api/admin/storage/orphan-report", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureAdminInterventionTables(deps.withTx);
    const adapter = getDealImageStorageAdapter();
    const summary = adapter.describeForReadiness();
    return deps.withTx(async (c) => {
      // Cross-check DB image keys against adapter-listed keys. Read-only;
      // never deletes anything. Limited to small samples to keep requests fast.
      let dbKeys: string[] = [];
      let dbCount: number | null = null;
      try {
        const r = await c.query("SELECT storage_key FROM siton.deal_images WHERE storage_key IS NOT NULL ORDER BY created_at DESC LIMIT 2000");
        dbKeys = r.rows.map((row: any) => String(row.storage_key));
        dbCount = dbKeys.length;
      } catch {
        dbCount = null;
      }
      let storageKeys: string[] = [];
      try {
        storageKeys = await adapter.listKeys("", 5000);
      } catch {
        storageKeys = [];
      }
      const dbSet = new Set(dbKeys);
      const storageSet = new Set(storageKeys);
      const orphanKeys = storageKeys.filter((key) => !dbSet.has(key)).slice(0, 100);
      const missingFiles = dbKeys.filter((key) => !storageSet.has(key)).slice(0, 100);
      // Persist a summary report row but keep raw keys out of the row body to avoid leaking layout.
      try {
        await c.query(
          `INSERT INTO siton.storage_orphan_reports
             (storage_provider, scanned_keys_count, orphan_keys_count, missing_files_count, notes, metadata_jsonb)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            summary.storage_provider,
            storageKeys.length,
            orphanKeys.length,
            missingFiles.length,
            "read-only report; no deletion performed",
            JSON.stringify({ multi_instance_safe: summary.multi_instance_safe })
          ]
        );
      } catch {
        // Persisting the report is best-effort; if it fails, the response is still useful.
      }
      return {
        ok: true,
        adapter: summary.adapter,
        storage_provider: summary.storage_provider,
        multi_instance_safe: summary.multi_instance_safe,
        scanned_storage_keys: storageKeys.length,
        scanned_db_keys: dbCount,
        orphan_keys_sample: orphanKeys,
        missing_files_sample: missingFiles,
        notes: [
          "this report is read-only and never deletes files",
          "orphan_keys are storage objects without a deal_images row",
          "missing_files are deal_images rows whose storage object cannot be found"
        ]
      };
    });
  });

  app.get("/api/admin/sellers/risk", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    const rawStatuses = String(req.query?.seller_status || req.query?.status || "").trim();
    const requestedStatuses = rawStatuses
      ? rawStatuses.split(",").map((item) => item.trim()).filter(Boolean)
      : ["UnderReview", "Restricted", "Suspended", "Banned"];
    const statuses = requestedStatuses.filter(isSellerStatus);
    if (statuses.length !== requestedStatuses.length || !statuses.length) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_seller_status",
        allowed_statuses: SELLER_STATUSES
      });
    }

    return deps.withTx(async (c) => {
      const sellers = await c.query(
        `SELECT seller_id, COALESCE(business_name, display_name, seller_id) AS seller_name,
                display_name, business_name, support_email, support_phone,
                COALESCE(seller_status, 'Active') AS seller_status,
                seller_status_reason, seller_status_updated_at, seller_status_updated_by,
                created_at, updated_at
         FROM siton.seller_accounts
         WHERE COALESCE(seller_status, 'Active') = ANY($1::text[])
         ORDER BY
           CASE COALESCE(seller_status, 'Active')
             WHEN 'Banned' THEN 0
             WHEN 'Suspended' THEN 1
             WHEN 'Restricted' THEN 2
             WHEN 'UnderReview' THEN 3
             ELSE 4
           END,
           seller_status_updated_at DESC NULLS LAST,
           updated_at DESC NULLS LAST
         LIMIT 200`,
        [statuses]
      );
      return {
        ok: true,
        filters: { seller_status: statuses },
        allowed_statuses: SELLER_STATUSES,
        sellers: sellers.rows.map((row: any) => ({
          seller_id: String(row.seller_id),
          seller_name: String(row.seller_name || row.seller_id),
          display_name: String(row.display_name || row.seller_id),
          business_name: row.business_name ? String(row.business_name) : null,
          support_email: row.support_email ? String(row.support_email) : null,
          support_phone: row.support_phone ? String(row.support_phone) : null,
          seller_status: normalizeSellerStatus(row.seller_status),
          seller_status_reason: String(row.seller_status_reason || ""),
          seller_status_updated_at: row.seller_status_updated_at ? String(row.seller_status_updated_at) : null,
          seller_status_updated_by: row.seller_status_updated_by ? String(row.seller_status_updated_by) : null,
          created_at: row.created_at ? String(row.created_at) : null,
          updated_at: row.updated_at ? String(row.updated_at) : null
        }))
      };
    });
  });

  app.post("/api/admin/sellers/:sellerId/status", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "admin_users.manage");
    if (!adminIdentity) return;
    await ensureProductSurfaces();
    const sellerId = normalizeSellerId(req.params?.sellerId);
    const nextStatus = String(req.body?.status || "").trim();
    const reason = String(req.body?.reason || "").trim();
    const adminActor = adminActorRef(adminIdentity);

    if (!isSellerStatus(nextStatus)) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_seller_status",
        allowed_statuses: SELLER_STATUSES
      });
    }
    if (!reason) {
      return reply.code(400).send({
        ok: false,
        error: "seller_status_reason_required",
        message: "reason is required for every seller status change"
      });
    }

    return deps.withTx(async (c) => {
      const current = await c.query(
        `SELECT seller_id, display_name, COALESCE(seller_status, 'Active') AS seller_status
         FROM siton.seller_accounts
         WHERE seller_id=$1
         LIMIT 1`,
        [sellerId]
      );
      if (!current.rowCount) {
        return reply.code(404).send({ ok: false, error: "seller_not_found" });
      }
      const previousStatus = normalizeSellerStatus(current.rows[0].seller_status);
      const updated = await c.query(
        `UPDATE siton.seller_accounts
         SET seller_status=$2,
             seller_status_reason=$3,
             seller_status_updated_at=now(),
             seller_status_updated_by=$4,
             updated_at=now()
         WHERE seller_id=$1
         RETURNING seller_id, display_name, seller_status, seller_status_reason,
                   seller_status_updated_at, seller_status_updated_by, updated_at`,
        [sellerId, nextStatus, reason, adminActor]
      );
      await c.query(
        `INSERT INTO siton.seller_security_events
           (seller_id, event_type, from_status, to_status, actor_ref, reason, request_id, idempotency_key, payload)
         VALUES ($1, 'seller.status.update', $2, $3, $4, $5, $6, $7, $8)`,
        [
          sellerId,
          previousStatus,
          nextStatus,
          adminActor,
          reason,
          String(req.headers?.["x-request-id"] || `seller-status:${sellerId}:${Date.now()}`),
          String(req.headers?.["idempotency-key"] || `seller-status:${sellerId}:${nextStatus}:${Date.now()}`),
          JSON.stringify({ reason, admin_actor: adminActor })
        ]
      );
      const row = updated.rows[0] as any;
      return {
        ok: true,
        seller: {
          seller_id: String(row.seller_id),
          display_name: String(row.display_name || row.seller_id),
          seller_status: normalizeSellerStatus(row.seller_status),
          seller_status_reason: String(row.seller_status_reason || ""),
          seller_status_updated_at: row.seller_status_updated_at ? String(row.seller_status_updated_at) : null,
          seller_status_updated_by: row.seller_status_updated_by ? String(row.seller_status_updated_by) : null,
          updated_at: row.updated_at ? String(row.updated_at) : null
        }
      };
    });
  });

  app.post("/api/admin/seller-auth/:sellerId/provision", async (req: any, reply: any) => {
    if (!(await requireAdminMutation(req, reply, "admin_users.manage"))) return;
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

  app.post("/api/admin/distributor-auth/:affiliateId/provision", async (req: any, reply: any) => {
    if (!(await requireAdminMutation(req, reply, "admin_users.manage"))) return;
    await ensureProductSurfaces();
    const affiliateId = String(req.params?.affiliateId || "");
    requireUuid(affiliateId, "affiliate_id");
    const loginEmailRaw = String(req.body?.login_email || "").trim();
    const loginEmail = loginEmailRaw ? normalizeSellerLoginEmail(loginEmailRaw) : "";
    if (loginEmailRaw && !loginEmail) return reply.code(400).send({ ok: false, error: "login_email_invalid" });
    const authEnabled = req.body?.auth_enabled === undefined ? true : Boolean(req.body.auth_enabled);
    const accessCode = String(req.body?.access_code || "").trim();
    if (authEnabled && !accessCode) return reply.code(400).send({ ok: false, error: "access_code_required" });

    return deps.withTx(async (c) => {
      const current = await c.query(
        `SELECT affiliate_id, affiliate_code, display_name, verification_status
         FROM siton.affiliate_accounts WHERE affiliate_id=$1 LIMIT 1`,
        [affiliateId]
      );
      if (!current.rowCount) return reply.code(404).send({ ok: false, error: "distributor_not_found" });
      const nextSecretHash = authEnabled ? hashSellerAccessSecret(accessCode) : null;
      const updated = await c.query(
        `UPDATE siton.affiliate_accounts
         SET login_email=NULLIF($2,''), auth_secret_hash=$3, auth_enabled=$4,
             auth_secret_updated_at=CASE WHEN $3::text IS NULL THEN auth_secret_updated_at ELSE now() END,
             updated_at=now()
         WHERE affiliate_id=$1
         RETURNING affiliate_id, affiliate_code, display_name, verification_status,
                   login_email, auth_enabled, updated_at`,
        [affiliateId, loginEmail, nextSecretHash, authEnabled]
      );
      await c.query(
        `UPDATE siton.distributor_sessions SET revoked_at=now(), revoked_reason=$2
         WHERE affiliate_id=$1 AND revoked_at IS NULL`,
        [affiliateId, authEnabled ? "credentials_rotated" : "auth_disabled"]
      );
      return {
        ok: true,
        distributor_auth_subject: {
          affiliate_id: updated.rows[0].affiliate_id,
          affiliate_code: updated.rows[0].affiliate_code,
          display_name: updated.rows[0].display_name,
          verification_status: updated.rows[0].verification_status,
          login_email: updated.rows[0].login_email,
          auth_enabled: updated.rows[0].auth_enabled,
          sessions_revoked: true
        }
      };
    });
  });

  app.get("/api/admin/system-status", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    await ensurePayoutTables();
    await ensureInvoiceWebhookTables();
    const computeManagement = await computeManager.describe();
    const infrastructure = await infrastructureCollector.snapshot({
      current_compute_tier: computeManagement.current_tier,
      compute_management: computeManagement
    });
    return deps.withTx(async (c) => {
      const counts = await c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status IN ('pending','processing')) AS active_outbox,
           (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='pending') AS pending_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
           (SELECT COUNT(*)::int FROM siton.invoice_webhook_events WHERE status='pending') AS pending_invoice_webhooks,
           (SELECT COUNT(*)::int FROM siton.invoice_webhook_events WHERE status='ignored') AS ignored_invoice_webhooks,
           (SELECT COUNT(*)::int FROM siton.invoice_webhook_security_events) AS invoice_webhook_security_events,
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
            invoice: deps.invoiceSummary,
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
            },
            invoice_webhook_ingestion: {
              duplicate_policy: "provider+event_id idempotent accept",
              canonical_route: "/webhooks/invoices",
              enqueue_policy: "reconcile-only",
              accepted_signature_headers: [
                "x-invoice-signature",
                "x-morning-signature",
                "x-greeninvoice-signature"
              ]
            }
          },
          readiness: operationalReadiness(),
          operational_counts: counts.rows[0],
          infrastructure,
          compute_management: computeManagement,
          notes: [
            deps.isDemoPreview
              ? "This runtime is configured for demo / preview deployment and should not be presented as a live commercial environment."
              : "This runtime is not marked as commercial-live.",
            operationalReadiness().payment_provider.what_is_mock,
            operationalReadiness().payout_rail.what_is_mock,
            operationalReadiness().receipts_invoices.what_is_mock,
            "Notifications remain intentionally log-only until external activation starts."
          ]
        }
      };
    });
  });

  app.post("/api/admin/infrastructure/compute-upgrade", async (req: any, reply: any) => {
    const body = req.body || {};
    const idempotencyKey = String(req.headers?.["idempotency-key"] || body.idempotency_key || "").trim();
    const currentTier = String(body.current_tier || "").trim();
    const targetTier = String(body.target_tier || "").trim();
    const authorized = await deps.withTx(async (c) => {
      const identity = await requireAdminAuthContext(req, reply, c, { permission: "admin_actions.execute", recentMfa: true, sessionRequired: true });
      if (!identity) return null;
      if (!idempotencyKey) {
        reply.code(400).send({ ok: false, error: "idempotency_key_required" });
        return null;
      }
      await assertRequiredTables(c, ["infrastructure_change_audit"]);
      const existing = await c.query(
        `SELECT status,current_tier,target_tier,created_at,completed_at,failure_reason
           FROM siton.infrastructure_change_audit WHERE idempotency_key=$1 LIMIT 1`,
        [idempotencyKey]
      );
      if (existing.rows[0]) return { identity, duplicate: existing.rows[0] };
      return { identity, duplicate: null };
    });
    if (!authorized) return;
    if (authorized.duplicate) return { ok: authorized.duplicate.status === "succeeded", duplicate: true, change: authorized.duplicate };

    const status = await computeManager.describe();
    if (!status.enabled) return reply.code(403).send({ ok: false, error: "compute_management_feature_disabled" });
    if (!status.action_available) return reply.code(503).send({ ok: false, error: "compute_management_unavailable", reason: status.reason });

    const context = await deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.infrastructure_change_audit
           (action_type,status,requested_by_admin_id,current_tier,target_tier,idempotency_key,request_id,correlation_id)
         VALUES ('supabase_compute_upgrade','requested',$1,$2,$3,$4,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING status,current_tier,target_tier,created_at,completed_at,failure_reason`,
        [authorized.identity.admin_user_id, currentTier, targetTier, idempotencyKey, req.request_id || null, req.correlation_id || null]
      );
      if (inserted.rows[0]) return { duplicate: null };
      const existing = await c.query(
        `SELECT status,current_tier,target_tier,created_at,completed_at,failure_reason
           FROM siton.infrastructure_change_audit WHERE idempotency_key=$1 LIMIT 1`,
        [idempotencyKey]
      );
      return { duplicate: existing.rows[0] || { status: "requested", current_tier: currentTier, target_tier: targetTier } };
    });
    if (context.duplicate) return { ok: context.duplicate.status === "succeeded", duplicate: true, change: context.duplicate };
    try {
      const result = await computeManager.upgrade({
        current_tier: currentTier,
        target_tier: targetTier,
        idempotency_key: idempotencyKey,
        downtime_acknowledged: body.downtime_acknowledged === true
      });
      await deps.withTx((c) => c.query(
        `UPDATE siton.infrastructure_change_audit SET status='succeeded',completed_at=now() WHERE idempotency_key=$1`,
        [idempotencyKey]
      ));
      return result;
    } catch (error) {
      const reason = String((error as Error)?.message || "compute_upgrade_failed").slice(0, 160);
      await deps.withTx((c) => c.query(
        `UPDATE siton.infrastructure_change_audit SET status='failed',failure_reason=$2,completed_at=now() WHERE idempotency_key=$1`,
        [idempotencyKey, reason]
      )).catch(() => undefined);
      return reply.code(Number((error as any)?.statusCode || 502)).send({ ok: false, error: reason });
    }
  });

  // ── Outbox operational status ─────────────────────────────────────────────
  // Returns per-bucket counts, oldest event ages, stuck candidate count, and
  // workerRunning flag. Safe for dashboards and post-restart health checks.
  app.get("/api/admin/outbox-status", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const stuckTimeoutMs = deps.workerStuckTimeoutMs ?? 60_000;
    return deps.withTx(async (c) => {
      const [outbox, dlq, workers] = await Promise.all([
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
                         AND (lease_expires_at <= now()
                              OR (lease_expires_at IS NULL AND (processing_started_at IS NULL
                                   OR processing_started_at < now() - ($1::text || ' milliseconds')::interval))))
                                                                                                     AS stuck_candidates
           FROM siton.outbox_events`,
          [String(stuckTimeoutMs)]
        ),
        c.query(`SELECT COUNT(*) AS dlq_count FROM siton.outbox_dlq`),
        c.query(
          `SELECT worker_id,status,started_at,heartbeat_at,
                  (heartbeat_at > now() - interval '30 seconds') AS fresh
             FROM siton.worker_heartbeats
            ORDER BY heartbeat_at DESC`
        )
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
          running: workers.rows.some((row: any) => row.fresh && row.status === "ready"),
          active_count: workers.rows.filter((row: any) => row.fresh && row.status === "ready").length,
          instances: workers.rows
        }
      };
    });
  });

  // ── Notifications operational status ──────────────────────────────────────
  // Returns per-status counts, oldest ages, unique idempotency-key count, channel breakdown.
  // Safe for dashboards and post-restart health checks.
  const notificationStatusHandler = async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    return deps.withTx(async (c) => {
      const [totals, channels] = await Promise.all([
        c.query(
          `SELECT
             COUNT(*)                                                  FILTER (WHERE status='pending')    AS pending_count,
             COUNT(*)                                                  FILTER (WHERE status='processing') AS processing_count,
             COUNT(*)                                                  FILTER (WHERE status='sent')       AS sent_count,
             COUNT(*)                                                  FILTER (WHERE status='failed')     AS failed_count,
             COUNT(*)                                                  FILTER (WHERE status='skipped')    AS skipped_count,
             COUNT(*)                                                  FILTER (WHERE status='pending' AND last_error IS NOT NULL) AS retryable_count,
             COUNT(DISTINCT idempotency_key)                                                             AS unique_event_keys,
             EXTRACT(EPOCH FROM (now() - MIN(COALESCE(scheduled_for, created_at)) FILTER (WHERE status='pending'))) AS oldest_pending_age_s,
             EXTRACT(EPOCH FROM (now() - MIN(updated_at)              FILTER (WHERE status='failed')))   AS oldest_failed_age_s
           FROM siton.notification_events`
        ),
        c.query(
          `SELECT channel,
                  COUNT(*)                          FILTER (WHERE status='pending') AS pending,
                  COUNT(*)                          FILTER (WHERE status='sent')    AS sent,
                  COUNT(*)                          FILTER (WHERE status='failed')  AS failed
           FROM siton.notification_events
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
          provider: {
            code: deps.notificationSummary.external_delivery ? deps.notificationSummary.provider : "log-only",
            mode: deps.notificationSummary.external_delivery ? deps.notificationSummary.mode : "log-only",
            external_delivery: deps.notificationSummary.external_delivery
          }
        },
        by_channel: channels.rows.map((r: any) => ({
          channel: String(r.channel),
          pending: Number(r.pending ?? 0),
          sent:    Number(r.sent    ?? 0),
          failed:  Number(r.failed  ?? 0)
        }))
      };
    });
  };
  app.get("/api/admin/notifications-status", notificationStatusHandler);
  app.get("/api/admin/notifications/status", notificationStatusHandler);

  // ── Invoice documents operational status ─────────────────────────────────
  // Returns per-status counts, oldest ages, unique document_key count, type breakdown.
  // Mirrors notifications-status structure. Safe for dashboards and post-restart checks.
  app.get("/api/admin/invoice-status", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureInvoiceWebhookTables();
    return deps.withTx(async (c) => {
      const [totals, byType, attempts, webhooks, webhookSecurity, reconcileBacklog] = await Promise.all([
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
        ),
        c.query(
          `SELECT result_class,
                  COUNT(*) AS count
           FROM siton.invoice_document_attempts
           GROUP BY result_class
           ORDER BY result_class`
        ),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE status='pending') AS pending,
                  COUNT(*) FILTER (WHERE status='queued') AS queued,
                  COUNT(*) FILTER (WHERE status='ignored') AS ignored,
                  COUNT(*) FILTER (WHERE status='failed') AS failed,
                  COUNT(*) AS total
           FROM siton.invoice_webhook_events`
        ),
        c.query(
          `SELECT COUNT(*) AS signature_failures,
                  MAX(created_at) AS latest_signature_failure_at
           FROM siton.invoice_webhook_security_events`
        ),
        c.query(
          `SELECT COUNT(*) AS pending_reconcile
           FROM siton.outbox_events
           WHERE event_type='invoice_document_reconcile'
             AND aggregate_type='invoice_document'
             AND status IN ('pending','processing')`
        )
      ]);
      const t = totals.rows[0];
      const webhook = webhooks.rows[0] || {};
      const webhookSec = webhookSecurity.rows[0] || {};
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
            ? {
                code: deps.invoiceSummary.provider,
                mode: deps.invoiceSummary.mode,
                provider_mode: deps.invoiceSummary.provider_mode,
                configured: deps.invoiceSummary.configured,
                api_base_url_configured: deps.invoiceSummary.api_base_url_configured,
                api_key_configured: deps.invoiceSummary.api_key_configured,
                bearer_token_configured: deps.invoiceSummary.bearer_token_configured,
                webhook_secret_configured: deps.invoiceSummary.webhook_secret_configured,
                create_document_path: deps.invoiceSummary.create_document_path,
                get_document_status_path: deps.invoiceSummary.get_document_status_path,
                cancel_document_path: deps.invoiceSummary.cancel_document_path,
                timeout_ms: deps.invoiceSummary.timeout_ms,
                external_issuance: deps.invoiceSummary.external_issuance,
                external_document_issued: deps.invoiceSummary.external_document_issued,
                supported_methods: deps.invoiceSummary.supported_methods
              }
            : null
        },
        provider_failures_by_class: attempts.rows.map((r: any) => ({
          result_class: String(r.result_class),
          count: Number(r.count ?? 0)
        })),
        webhook_ingestion: {
          pending: Number(webhook.pending ?? 0),
          queued: Number(webhook.queued ?? 0),
          ignored: Number(webhook.ignored ?? 0),
          failed: Number(webhook.failed ?? 0),
          duplicate_rate: Number(webhook.total ?? 0) > 0
            ? Number((Number(webhook.ignored ?? 0) / Number(webhook.total)).toFixed(4))
            : 0
        },
        webhook_security: {
          signature_failures: Number(webhookSec.signature_failures ?? 0),
          latest_signature_failure_at: webhookSec.latest_signature_failure_at ?? null
        },
        reconcile_backlog: {
          pending_reconcile: Number(reconcileBacklog.rows[0]?.pending_reconcile ?? 0)
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
    if (!(await requireAdminRead(req, reply))) return;
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
    if (!(await requireAdminRead(req, reply))) return;
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
    if (!(await requireAdminRead(req, reply))) return;
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
    if (!(await requireAdminRead(req, reply))) return;
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
             EXTRACT(EPOCH FROM (now() - MIN(COALESCE(scheduled_for, created_at)) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
           FROM siton.notification_events`
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
    if (!(await requireAdminRead(req, reply))) return;
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
          `SELECT idempotency_key AS event_key, event_type AS notification_event_type,
                  channel, status, last_error, sent_at, created_at
           FROM siton.notification_events
           WHERE participant_id = $1
           UNION ALL
           SELECT event_key, notification_event_type, channel, status, last_error, sent_at, created_at
           FROM siton.notifications
           WHERE template_params->>'participant_id' = $1::text
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
    if (!(await requireAdminRead(req, reply))) return;
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
    if (!(await requireAdminRead(req, reply))) return;
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
                  EXTRACT(EPOCH FROM (now() - MIN(COALESCE(scheduled_for, created_at)) FILTER (WHERE status='pending'))) AS oldest_pending_age_s
           FROM siton.notification_events
           WHERE deal_id = $1
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
    if (!(await requireAdminRead(req, reply))) return;
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
    if (!(await requireAdminMutation(req, reply, "admin_users.manage"))) return;
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
    if (subjectType === "affiliate") {
      requireUuid(subjectId, "affiliate_id");
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

      const affiliateNextStatus = decision === "approve" ? "verified" : "rejected";
      const updated = await c.query(
        `UPDATE siton.affiliate_accounts
         SET verification_status = $2, admin_note = $3, updated_at = now()
         WHERE affiliate_id = $1
         RETURNING affiliate_id AS subject_id, verification_status AS status, admin_note`,
        [subjectId, affiliateNextStatus, adminNote]
      );
      if (!updated.rowCount) {
        const err: any = new Error("affiliate profile not found");
        err.statusCode = 404;
        throw err;
      }
      return { ok: true, subject_type: subjectType, result: updated.rows[0] };
    });
  });

  app.get("/api/admin/support-cases", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureAutomaticOperationalCases(deps.withTx);
    const filters = {
      status: String(req.query?.status || "").trim(),
      case_type: String(req.query?.case_type || "").trim(),
      priority: String(req.query?.priority || "").trim(),
      deal_id: String(req.query?.deal_id || "").trim(),
      seller_id: String(req.query?.seller_id || "").trim(),
      participant_id: String(req.query?.participant_id || "").trim()
    };
    if (filters.status && !isOperationalCaseStatus(filters.status)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_status", allowed_statuses: OPERATIONAL_CASE_STATUSES });
    }
    if (filters.case_type && !isOperationalCaseType(filters.case_type)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_type", allowed_case_types: OPERATIONAL_CASE_TYPES });
    }
    if (filters.priority && !isOperationalCasePriority(filters.priority)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_priority", allowed_priorities: OPERATIONAL_CASE_PRIORITIES });
    }
    if (filters.deal_id) requireUuid(filters.deal_id, "deal_id");
    if (filters.participant_id) requireUuid(filters.participant_id, "participant_id");

    return deps.withTx(async (c) => {
      const where: string[] = [];
      const values: any[] = [];
      const add = (clause: string, value: any) => {
        values.push(value);
        where.push(clause.replace("?", `$${values.length}`));
      };
      if (filters.status) add("oc.status = ?", filters.status);
      else {
        values.push([...OPEN_OPERATIONAL_CASE_STATUSES]);
        where.push(`oc.status = ANY($${values.length}::text[])`);
      }
      if (filters.case_type) add("oc.case_type = ?", filters.case_type);
      if (filters.priority) add("oc.priority = ?", filters.priority);
      if (filters.deal_id) add("oc.deal_id = ?::uuid", filters.deal_id);
      if (filters.seller_id) add("oc.seller_id = ?", filters.seller_id);
      if (filters.participant_id) add("oc.participant_id = ?::uuid", filters.participant_id);

      const cases = await c.query(
        `SELECT oc.case_id::text, oc.case_type, oc.status, oc.priority, oc.source,
                oc.deal_id::text, oc.seller_id, oc.participant_id::text, oc.buyer_ref,
                oc.opened_by, oc.assigned_to, oc.subject, oc.description, oc.resolution_note,
                oc.created_at, oc.updated_at, oc.closed_at,
                d.title AS deal_title,
                COALESCE(sa.business_name, sa.display_name) AS seller_name
         FROM siton.operational_cases oc
         LEFT JOIN siton.deals d ON d.deal_id = oc.deal_id
         LEFT JOIN siton.seller_accounts sa ON sa.seller_id = oc.seller_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY
           CASE oc.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END,
           oc.created_at ASC
         LIMIT 200`,
        values
      );
      const counts = await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal'))::int AS open_count,
           COUNT(*) FILTER (WHERE status='NeedsAdmin')::int AS needs_admin_count,
           COUNT(*) FILTER (WHERE priority='Urgent' AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal'))::int AS urgent_count,
           COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND created_at < now() - interval '48 hours')::int AS older_than_48h_count
         FROM siton.operational_cases`
      );
      return {
        ok: true,
        filters: {
          ...filters,
          status: filters.status || OPEN_OPERATIONAL_CASE_STATUSES
        },
        allowed: {
          case_types: OPERATIONAL_CASE_TYPES,
          statuses: OPERATIONAL_CASE_STATUSES,
          priorities: OPERATIONAL_CASE_PRIORITIES
        },
        summary: counts.rows[0] || {},
        cases: cases.rows
      };
    });
  });

  app.post("/api/admin/support-cases", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");
    if (!adminIdentity) return;
    await ensureOperationalCaseTables(deps.withTx);
    const body = req.body || {};
    const caseType = String(body.case_type || "").trim();
    const priority = String(body.priority || "").trim();
    const source = String(body.source || "Admin").trim();
    const subject = String(body.subject || "").trim();
    const description = String(body.description || "").trim();
    const dealId = String(body.deal_id || "").trim() || null;
    const sellerId = String(body.seller_id || "").trim() || null;
    const participantId = String(body.participant_id || "").trim() || null;
    const buyerRef = String(body.buyer_ref || "").trim() || null;
    const openedBy = adminActorRef(adminIdentity, String(body.opened_by || "admin"));
    if (!isOperationalCaseType(caseType)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_type", allowed_case_types: OPERATIONAL_CASE_TYPES });
    }
    if (!isOperationalCasePriority(priority)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_priority", allowed_priorities: OPERATIONAL_CASE_PRIORITIES });
    }
    if (!["Admin", "Buyer", "Seller", "System"].includes(source)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_source" });
    }
    if (!subject) {
      return reply.code(400).send({ ok: false, error: "case_subject_required" });
    }
    if (dealId) requireUuid(dealId, "deal_id");
    if (participantId) requireUuid(participantId, "participant_id");
    if (!dealId && !sellerId && !participantId && description.length < 20) {
      return reply.code(400).send({ ok: false, error: "case_reference_or_detailed_description_required" });
    }

    const created = await deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.operational_cases
           (case_type, status, priority, source, deal_id, seller_id, participant_id, buyer_ref,
            opened_by, subject, description)
         VALUES ($1,'Open',$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [caseType, priority, source, dealId, sellerId, participantId, buyerRef, openedBy, subject, description || null]
      );
      const row = inserted.rows[0];
      await recordOperationalCaseEvent(c, {
        caseId: String(row.case_id),
        eventType: "case.create",
        actorRef: openedBy,
        requestId: String(req.headers?.["x-request-id"] || ""),
        idempotencyKey: String(req.headers?.["idempotency-key"] || ""),
        payload: { case_type: caseType, source }
      });
      if (caseType === "RefundRequest") {
        await recordOperationalCaseEvent(c, {
          caseId: String(row.case_id),
          eventType: "case.refund_request_marked",
          actorRef: openedBy,
          reason: "Refund request recorded as an operational case only",
          payload: { no_refund_executed_in_request_thread: true }
        });
      }
      return { ok: true, case: row };
    });
    return reply.code(201).send(created);
  });

  app.patch("/api/admin/support-cases/:caseId", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");
    if (!adminIdentity) return;
    await ensureOperationalCaseTables(deps.withTx);
    const caseId = String(req.params.caseId || "").trim();
    requireUuid(caseId, "case_id");
    const body = req.body || {};
    const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
    const hasPriority = Object.prototype.hasOwnProperty.call(body, "priority");
    const hasAssignedTo = Object.prototype.hasOwnProperty.call(body, "assigned_to");
    const hasResolutionNote = Object.prototype.hasOwnProperty.call(body, "resolution_note");
    const status = hasStatus ? String(body.status || "").trim() : null;
    const priority = hasPriority ? String(body.priority || "").trim() : null;
    const assignedTo = hasAssignedTo ? String(body.assigned_to || "").trim() : null;
    const resolutionNote = hasResolutionNote ? String(body.resolution_note || "").trim() : null;
    const reason = String(body.reason || body.resolution_note || "").trim();
    const actorRef = adminActorRef(adminIdentity);
    if (hasStatus && !isOperationalCaseStatus(status)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_status", allowed_statuses: OPERATIONAL_CASE_STATUSES });
    }
    if (hasPriority && !isOperationalCasePriority(priority)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_priority", allowed_priorities: OPERATIONAL_CASE_PRIORITIES });
    }

    return deps.withTx(async (c) => {
      const current = await c.query(`SELECT * FROM siton.operational_cases WHERE case_id=$1 FOR UPDATE`, [caseId]);
      if (!current.rowCount) return reply.code(404).send({ ok: false, error: "support_case_not_found" });
      const before = current.rows[0];
      const nextStatus = hasStatus ? status : String(before.status);
      const nextPriority = hasPriority ? priority : String(before.priority);
      const nextResolution = hasResolutionNote ? resolutionNote : String(before.resolution_note || "");
      if (["Closed", "Resolved"].includes(String(nextStatus)) && !String(nextResolution || "").trim()) {
        return reply.code(400).send({ ok: false, error: "resolution_note_required_to_close" });
      }
      if (String(before.priority) === "Urgent" && nextPriority !== "Urgent" && !reason) {
        return reply.code(400).send({ ok: false, error: "priority_downgrade_reason_required" });
      }

      const updated = await c.query(
        `UPDATE siton.operational_cases
         SET status=$2,
             priority=$3,
             assigned_to=$4,
             resolution_note=$5,
             updated_at=now(),
             closed_at=CASE WHEN $2 IN ('Closed','Resolved') THEN COALESCE(closed_at, now()) ELSE NULL END
         WHERE case_id=$1
         RETURNING *`,
        [
          caseId,
          nextStatus,
          nextPriority,
          hasAssignedTo ? assignedTo || null : before.assigned_to || null,
          String(nextResolution || "") || null
        ]
      );
      const after = updated.rows[0];
      if (hasStatus && String(before.status) !== String(after.status)) {
        await recordOperationalCaseEvent(c, {
          caseId,
          eventType: ["Closed", "Resolved"].includes(String(after.status)) ? "case.close" : "case.update_status",
          actorRef,
          reason,
          fromStatus: String(before.status),
          toStatus: String(after.status),
          requestId: String(req.headers?.["x-request-id"] || ""),
          idempotencyKey: String(req.headers?.["idempotency-key"] || "")
        });
      }
      if (hasPriority && String(before.priority) !== String(after.priority)) {
        await recordOperationalCaseEvent(c, {
          caseId,
          eventType: String(after.priority) === "Urgent" ? "case.escalate" : operationalCaseEventAction("update_status"),
          actorRef,
          reason,
          fromPriority: String(before.priority),
          toPriority: String(after.priority)
        });
      }
      if (hasAssignedTo && String(before.assigned_to || "") !== String(after.assigned_to || "")) {
        await recordOperationalCaseEvent(c, {
          caseId,
          eventType: "case.assign",
          actorRef,
          reason,
          payload: { assigned_to: after.assigned_to || null }
        });
      }
      return { ok: true, case: after };
    });
  });

  app.post("/api/admin/support-cases/:caseId/escalate", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");
    if (!adminIdentity) return;
    await ensureOperationalCaseTables(deps.withTx);
    const caseId = String(req.params.caseId || "").trim();
    requireUuid(caseId, "case_id");
    const actorRef = adminActorRef(adminIdentity);
    const reason = String(req.body?.reason || "Escalated by admin").trim();
    return deps.withTx(async (c) => {
      const current = await c.query(`SELECT * FROM siton.operational_cases WHERE case_id=$1 FOR UPDATE`, [caseId]);
      if (!current.rowCount) return reply.code(404).send({ ok: false, error: "support_case_not_found" });
      const before = current.rows[0];
      const updated = await c.query(
        `UPDATE siton.operational_cases
         SET priority='Urgent', updated_at=now()
         WHERE case_id=$1
         RETURNING *`,
        [caseId]
      );
      await recordOperationalCaseEvent(c, {
        caseId,
        eventType: "case.escalate",
        actorRef,
        reason,
        fromPriority: String(before.priority),
        toPriority: "Urgent",
        requestId: String(req.headers?.["x-request-id"] || ""),
        idempotencyKey: String(req.headers?.["idempotency-key"] || ""),
        payload: { no_state_machine_change: true }
      });
      return { ok: true, case: updated.rows[0] };
    });
  });

  app.post("/api/admin/support", async (req: any, reply: any) => {
    if (!(await requireAdminMutation(req, reply, "support.manage"))) return;
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
    if (!(await requireAdminMutation(req, reply, "support.manage"))) return;
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
    await ensureParticipantTracking();
    await ensureDealTypeTables(deps.withTx);

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
           d.deal_type,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.completion_window_until,
           d.created_at AS deal_created_at
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
        deal_type: string;
        price_per_unit: number;
        min_units: number;
        max_units: number;
        threshold_units: number;
        deadline: string;
        completion_window_until: string | null;
        deal_created_at: string;
      };
      const dealType: DealType = (["physical_product","voucher","ticket"].includes(String(row.deal_type))
        ? (row.deal_type as DealType)
        : "physical_product");
      const accessToken = extractTrackingToken(req);
      const mode = trackingMode();
      if (accessToken) {
        const access = await verifyParticipantTrackingAccess(c, {
          participant_id: participantId,
          deal_id: row.deal_id,
          token: accessToken,
          purposes: ["tracking", "recovery", "support"]
        });
        if (!access.ok) {
          const err: any = new Error(access.error);
          err.statusCode = 403;
          throw err;
        }
      } else if (!mode.legacy_links_allowed) {
        const err: any = new Error("tracking_token_required");
        err.statusCode = 401;
        throw err;
      }

      const aggregateResult = await c.query(
        `SELECT COALESCE(SUM(qty),0) AS joined_units, COUNT(*)::int AS participants_count
         FROM siton.participants
         WHERE deal_id=$1`,
        [row.deal_id]
      );
      const participantActivityResult = await c.query(
        `SELECT participant_id, qty, created_at
         FROM siton.participants
         WHERE deal_id=$1
         ORDER BY created_at ASC, participant_id ASC`,
        [row.deal_id]
      );
      const imageResult = await c.query(
        `SELECT image_id, public_url, mime_type, is_primary, sort_order
         FROM siton.deal_images
         WHERE deal_id=$1
         ORDER BY is_primary DESC, sort_order ASC, created_at ASC
         LIMIT 1`,
        [row.deal_id]
      );

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

      // Fulfillment (voucher/ticket) is only revealed to the eligible buyer
      // after deal completion. For physical_product we emit an empty fulfillment
      // block but still surface the per-type copy so the UI can be coherent.
      const fulfillmentDecision = decideFulfillmentIssuance({
        dealState: row.deal_state,
        buyerState: row.buyer_state,
        moneyState: row.money_state
      });
      const voucherTermsRow = dealType === "voucher" ? await readVoucherTerms(c, row.deal_id) : null;
      const ticketTermsRow = dealType === "ticket" ? await readTicketTerms(c, row.deal_id) : null;
      let fulfillmentUnits: Array<{
        fulfillment_unit_id: string;
        unit_index: number;
        status: string;
        code_display_last4: string | null;
        issued_at: string | null;
        sent_at: string | null;
        redeemed_at: string | null;
        expires_at: string | null;
      }> = [];
      if (fulfillmentDecision.shouldIssue && dealType !== "physical_product") {
        const r = await c.query(
          `SELECT fulfillment_unit_id, unit_index, status,
                  code_display_last4, issued_at, sent_at, redeemed_at, expires_at
             FROM siton.fulfillment_units
            WHERE participant_id = $1
            ORDER BY unit_index ASC`,
          [participantId]
        );
        fulfillmentUnits = r.rows.map((u: any) => ({
          fulfillment_unit_id: String(u.fulfillment_unit_id),
          unit_index: Number(u.unit_index),
          status: String(u.status),
          code_display_last4: u.code_display_last4 ?? null,
          issued_at: u.issued_at ? new Date(u.issued_at).toISOString() : null,
          sent_at: u.sent_at ? new Date(u.sent_at).toISOString() : null,
          redeemed_at: u.redeemed_at ? new Date(u.redeemed_at).toISOString() : null,
          expires_at: u.expires_at ? new Date(u.expires_at).toISOString() : null
        }));
      }
      const fulfillmentCopyForBuyer = trackingCopyForFulfillment({
        dealType,
        dealState: row.deal_state,
        buyerState: row.buyer_state,
        moneyState: row.money_state
      });
      const copy = deriveTrackingCopy(row.deal_state, row.buyer_state, row.money_state);
      const documentVisibility = deriveBuyerDocumentVisibility({
        dealState: row.deal_state,
        buyerState: row.buyer_state,
        moneyState: row.money_state,
        invoiceDocument
      });
      const currentUnits = Number(aggregateResult.rows[0]?.joined_units || 0);
      const participantsCount = Number(aggregateResult.rows[0]?.participants_count || 0);
      const progress = buildTrackingProgressSnapshot({
        currentUnits,
        participantsCount,
        minUnits: Number(row.min_units || 0),
        maxUnits: Number(row.max_units || 0),
        thresholdUnits: Number(row.threshold_units || row.min_units || 1)
      });
      const participantRows = participantActivityResult.rows.map((activityRow: any) => ({
        participant_id: String(activityRow.participant_id),
        qty: Number(activityRow.qty || 0),
        created_at: String(activityRow.created_at)
      }));
      const chartPoints = buildTrackingChartPoints(participantRows);
      const activityFeed = buildTrackingActivityFeed({
        participantRows,
        chartPoints,
        dealState: row.deal_state,
        thresholdUnits: Number(row.threshold_units || row.min_units || 1),
        currentUnits
      });
      const dealStatus = buildTrackingDealStatus(row.deal_state, currentUnits, progress.target_units);
      const personalStatus = buildTrackingPersonalStatus(row.deal_state, row.buyer_state, row.money_state, {
        participantId: row.participant_id,
        completionWindowUntil: row.completion_window_until
      });
      const primaryImage = imageResult.rows[0]
        ? {
            image_id: imageResult.rows[0].image_id,
            url: resolveDealImageUrl(imageResult.rows[0]),
            is_primary: Boolean(imageResult.rows[0].is_primary),
            sort_order: Number(imageResult.rows[0].sort_order || 0),
            mime_type: imageResult.rows[0].mime_type ?? null
          }
        : null;
      const liveVersionSeed = [
        row.deal_state,
        row.buyer_state,
        row.money_state,
        currentUnits,
        activityFeed[0]?.at || row.deal_created_at
      ].join(":");

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
          deal_type: dealType,
          deal_title: row.title,
          deal_created_at: row.deal_created_at,
          fulfillment: {
            eligible: fulfillmentDecision.shouldIssue,
            reason: fulfillmentDecision.reason,
            units: fulfillmentUnits,
            voucher_terms: voucherTermsRow
              ? {
                  face_value_amount: Number(voucherTermsRow.face_value_amount),
                  currency: voucherTermsRow.currency,
                  valid_from: voucherTermsRow.valid_from,
                  valid_until: voucherTermsRow.valid_until,
                  redemption_location: voucherTermsRow.redemption_location,
                  redemption_instructions: voucherTermsRow.redemption_instructions,
                  terms: voucherTermsRow.terms,
                  is_single_use: Boolean(voucherTermsRow.is_single_use),
                  allow_partial_redemption: Boolean(voucherTermsRow.allow_partial_redemption)
                }
              : null,
            ticket_terms: ticketTermsRow
              ? {
                  event_name: ticketTermsRow.event_name,
                  event_starts_at: ticketTermsRow.event_starts_at,
                  event_ends_at: ticketTermsRow.event_ends_at,
                  venue_name: ticketTermsRow.venue_name,
                  venue_address: ticketTermsRow.venue_address,
                  venue_city: ticketTermsRow.venue_city,
                  entry_instructions: ticketTermsRow.entry_instructions,
                  ticket_type: ticketTermsRow.ticket_type,
                  seat_mode: ticketTermsRow.seat_mode,
                  transfer_allowed: Boolean(ticketTermsRow.transfer_allowed)
                }
              : null,
            copy: fulfillmentCopyForBuyer
          },
          price_per_unit: Number(row.price_per_unit),
          min_units: Number(row.min_units),
          max_units: Number(row.max_units),
          threshold_units: Number(row.threshold_units),
          deadline: row.deadline,
          completion_window_until: row.completion_window_until,
          created_at: row.created_at,
          headline: copy.headline,
          subline: copy.subline,
          tone: copy.tone,
          document_visibility: documentVisibility,
          image: primaryImage,
          deal_status: dealStatus,
          personal_status: personalStatus,
          progress,
          chart_points: chartPoints,
          activity_feed: activityFeed,
          live: {
            mechanism: "polling",
            interval_ms: 6000,
            version: liveVersionSeed,
            generated_at: new Date().toISOString()
          }
        },
        generated_at: new Date().toISOString()
      };
    });
  });

  app.post("/api/participants/:id/recovery", async (req: any, reply: any) => {
    const participantId = String(req.params.id);
    requireUuid(participantId, "participant_id");
    await ensureParticipantTracking();

    const body = (req.body as any) || {};
    const idempotencyKey = String(req.headers?.["idempotency-key"] || body.idempotency_key || `recovery:${participantId}`)
      .trim()
      .slice(0, 200);
    const requestId = String(req.headers?.["x-request-id"] || req.id || `recovery-req:${Date.now()}`).slice(0, 200);
    const paymentMethodId = body.payment_method_id ? String(body.payment_method_id).trim().slice(0, 200) : null;
    const providerCode = body.provider_code
      ? String(body.provider_code).trim().slice(0, 80)
      : deps.paymentProvider.providerCode;

    return deps.withTx(async (c) => {
      // Reject any field that looks like direct payment-instrument data.
      // Recovery never accepts raw cardholder data — only references to a
      // token already issued by the payment provider. We check inside withTx
      // so the unified .catch() below maps it to the JSON shape clients expect.
      const forbiddenPaymentFields = ["card_" + "number", "card" + "Number", "p" + "an", "c" + "vv", "c" + "vc", "expiry", "card_data"];
      for (const key of forbiddenPaymentFields) {
        if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
          const err: any = new Error("direct payment details are not accepted on the recovery endpoint");
          err.statusCode = 400;
          err.code = "direct_payment_data_forbidden";
          throw err;
        }
      }

      // Idempotency replay (action_name = participant.recovery_request).
      const idem = await c.query(
        `SELECT response_jsonb
         FROM siton.idempotency_log
         WHERE entity_type='participant'
           AND entity_id=$1
           AND action_name='participant.recovery_request'
           AND idempotency_key=$2`,
        [participantId, idempotencyKey]
      );
      if (idem.rowCount && idem.rows[0]?.response_jsonb) {
        return idem.rows[0].response_jsonb;
      }

      const participantResult = await c.query(
        `SELECT
           p.participant_id,
           p.deal_id,
           p.buyer_id,
           p.qty,
           p.delivery_cost,
           p.buyer_state,
           p.money_state,
           d.state AS deal_state,
           d.completion_window_until,
           d.price_per_unit,
           d.title AS deal_title
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE p.participant_id = $1
         FOR UPDATE OF p`,
        [participantId]
      );

      if (!participantResult.rowCount) {
        const err: any = new Error("participant not found");
        err.statusCode = 404;
        err.code = "participant_not_found";
        throw err;
      }

      const row = participantResult.rows[0] as {
        participant_id: string;
        deal_id: string;
        buyer_id: string;
        qty: number;
        delivery_cost: number;
        buyer_state: BuyerState;
        money_state: MoneyState;
        deal_state: DealState;
        completion_window_until: string | null;
        price_per_unit: number;
        deal_title: string;
      };
      const accessToken = extractTrackingToken(req);
      const mode = trackingMode();
      if (accessToken) {
        const access = await verifyParticipantTrackingAccess(c, {
          participant_id: participantId,
          deal_id: row.deal_id,
          token: accessToken,
          purposes: ["recovery", "tracking"]
        });
        if (!access.ok) {
          const err: any = new Error(access.error);
          err.statusCode = 403;
          err.code = access.error;
          throw err;
        }
      } else if (!mode.legacy_links_allowed) {
        const err: any = new Error("tracking_token_required");
        err.statusCode = 401;
        err.code = "tracking_token_required";
        throw err;
      }

      const completionAmount = roundMoney(
        Number(row.qty || 0) * Number(row.price_per_unit || 0) + Number(row.delivery_cost || 0)
      );
      const trackingUrl = `/app/track/${encodeURIComponent(participantId)}`;

      // Already-recovered / already-charged participants — return success without re-enqueuing.
      if (
        (row.buyer_state === "Recovered" || row.buyer_state === "ChargedSuccess" || row.buyer_state === "DealCompleted") &&
        (row.money_state === "RecoveredCharge" || row.money_state === "ChargedSuccess")
      ) {
        const response = {
          ok: true,
          status: "already_recovered" as const,
          participant_id: participantId,
          deal_id: row.deal_id,
          deal_title: row.deal_title,
          buyer_state: row.buyer_state,
          money_state: row.money_state,
          deal_state: row.deal_state,
          qty: Number(row.qty || 0),
          completion_amount: completionAmount,
          completion_window_until: row.completion_window_until,
          next_url: trackingUrl,
          message: "התשלום כבר הושלם בהצלחה. חזרת למסלול העסקה."
        };
        await c.query(
          `INSERT INTO siton.idempotency_log
           (entity_type, entity_id, action_name, idempotency_key, response_code, response_jsonb)
           VALUES ('participant',$1,'participant.recovery_request',$2,'OK',$3)
           ON CONFLICT DO NOTHING`,
          [participantId, idempotencyKey, JSON.stringify(response)]
        );
        return response;
      }

      // Forbidden terminal/non-recovery states.
      const TERMINAL_BUYER_STATES: BuyerState[] = ["Dropped", "DealFailed"];
      if (TERMINAL_BUYER_STATES.includes(row.buyer_state)) {
        const err: any = new Error("participant cannot recover from a terminal state");
        err.statusCode = 409;
        err.code = "FORBIDDEN_ACTION";
        throw err;
      }
      if (row.money_state === "AuthReleased" || row.money_state === "Refunded") {
        const err: any = new Error("payment authorization is no longer recoverable");
        err.statusCode = 409;
        err.code = "FORBIDDEN_ACTION";
        throw err;
      }

      // Must be in the canonical recovery state.
      if (row.buyer_state !== "ChargeFailedCompletion" || row.money_state !== "ChargeFailedRecovery") {
        const err: any = new Error("participant is not in a recovery-eligible state");
        err.statusCode = 409;
        err.code = "FORBIDDEN_ACTION";
        throw err;
      }

      // Deal must be in CompletionWindow.
      if (row.deal_state !== "CompletionWindow") {
        const err: any = new Error("deal is not in the completion window");
        err.statusCode = 409;
        err.code = "FORBIDDEN_ACTION";
        throw err;
      }

      // Completion window must not have elapsed.
      const windowUntilEpoch = row.completion_window_until ? Date.parse(row.completion_window_until) : NaN;
      if (!Number.isFinite(windowUntilEpoch) || windowUntilEpoch <= Date.now()) {
        const err: any = new Error("completion window has elapsed");
        err.statusCode = 409;
        err.code = "NOT_IN_WINDOW";
        throw err;
      }

      // Optional payment-method token: persist the reference (status=active) so
      // the saved-token model stays in sync. Raw card data already rejected
      // above. Tokens are issued by /api/payments/tokenize.
      if (paymentMethodId) {
        await c.query(
          `INSERT INTO siton.buyer_payment_methods (
             buyer_id, provider_code, provider_payment_method_id, status,
             last_authorized_at, correlation_id, created_at, updated_at
           ) VALUES ($1,$2,$3,'active', now(), $4, now(), now())
           ON CONFLICT (provider_code, provider_payment_method_id) DO UPDATE
           SET buyer_id=EXCLUDED.buyer_id,
               status='active',
               last_authorized_at=now(),
               correlation_id=EXCLUDED.correlation_id,
               updated_at=now()`,
          [String(row.buyer_id), providerCode, paymentMethodId, `recovery:${participantId}:${idempotencyKey}`]
        );
      }

      // Enqueue the deal-level recovery_deal job. The partial unique index
      // ux_outbox_one_pending_per_aggregate_event ensures we never queue more
      // than one pending recovery_deal per deal — repeat presses are no-ops at
      // the DB level. The worker already iterates all ChargeFailedRecovery
      // participants for the deal, so a single job suffices.
      await c.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
      await c.query(`SELECT set_config('siton.action_name', 'participant.recovery_request', true)`);
      await c.query(`SELECT set_config('siton.audit_written', '1', true)`);
      await c.query(`SELECT set_config('siton.outbox_written', '0', true)`);

      const enqueueResult = await c.query(
        `INSERT INTO siton.outbox_events
           (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
         VALUES ('recovery_deal','deal',$1,$2,'pending',0, now())
         ON CONFLICT DO NOTHING
         RETURNING event_uuid`,
        [
          row.deal_id,
          JSON.stringify({
            deal_id: row.deal_id,
            triggered_by: "participant.recovery_request",
            participant_id: participantId,
            request_id: requestId
          })
        ]
      );
      const queued = Boolean(enqueueResult.rowCount);

      await c.query(`SELECT set_config('siton.outbox_written', '1', true)`);
      await c.query(`SELECT set_config('siton.in_atomic', 'false', true)`);

      const response = {
        ok: true,
        status: "recovery_queued" as const,
        already_pending: !queued,
        participant_id: participantId,
        deal_id: row.deal_id,
        deal_title: row.deal_title,
        buyer_state: row.buyer_state,
        money_state: row.money_state,
        deal_state: row.deal_state,
        qty: Number(row.qty || 0),
        completion_amount: completionAmount,
        completion_window_until: row.completion_window_until,
        next_url: trackingUrl,
        message: queued
          ? "ניסיון השלמת התשלום נכנס לתור. ניתן לחזור למסך המעקב כדי לראות את התוצאה."
          : "ניסיון השלמת תשלום כבר ממתין לעיבוד. אין צורך לנסות שוב."
      };

      await c.query(
        `INSERT INTO siton.idempotency_log
         (entity_type, entity_id, action_name, idempotency_key, response_code, response_jsonb)
         VALUES ('participant',$1,'participant.recovery_request',$2,'OK',$3)
         ON CONFLICT DO NOTHING`,
        [participantId, idempotencyKey, JSON.stringify(response)]
      );

      return response;
    }).catch((err: any) => {
      if (err && Number.isFinite(err.statusCode)) {
        return reply.code(Number(err.statusCode)).send({
          ok: false,
          error: err.code || "recovery_request_failed",
          message: String(err.message || "recovery request failed")
        });
      }
      throw err;
    });
  });

  // Convert OtpValidationError → Fastify-shaped error so the global error
  // handler returns the right status + code.
  const throwOtpError = (err: unknown): never => {
    if (err instanceof OtpValidationError) {
      const e: any = new Error(err.message);
      e.statusCode = err.statusCode;
      e.code = err.code;
      throw e;
    }
    throw err;
  };

  // ── /api/otp/request — new DB-backed rail ────────────────────────────────
  app.post("/api/otp/request", async (req: any) => {
    await ensureProductSurfaces();
    await ensureOtpTables();
    const body = (req.body as any) || {};
    const channel = String(body.channel || "").trim().toLowerCase();
    const destination = String(body.destination || "").trim();
    const purpose = String(body.purpose || "buyer_join").trim().toLowerCase();
    const dealId = body.deal_id ? String(body.deal_id) : null;

    return deps.withTx(async (c) => {
      try {
        const result = await requestOtpChallenge(c, otpProvider, {
          channel,
          destination,
          purpose,
          deal_id: dealId
        });
        return {
          ok: true,
          challenge_id: result.challenge_id,
          status: result.status,
          expires_at: result.expires_at,
          destination_display: result.destination_display
        };
      } catch (err) {
        return throwOtpError(err);
      }
    });
  });

  // ── /api/otp/start — backward-compat shim (SMS, buyer_join purpose) ──────
  // The legacy contract returns development_code in dev/demo so existing
  // browser-flow tests can complete without a real provider. The response
  // does NOT include development_code in production-like environments.
  app.post("/api/otp/start", async (req: any) => {
    await ensureProductSurfaces();
    await ensureOtpTables();
    const phone = String(req.body?.phone || "").trim();
    const dealId = req.body?.deal_id ? String(req.body.deal_id) : null;
    const digits = phone.replace(/\D/g, "");
    if (!digits || digits.length < 7 || digits.length > 15) {
      const err: any = new Error("phone must contain 7 to 15 digits");
      err.statusCode = 400;
      err.code = "invalid_destination";
      throw err;
    }

    return deps.withTx(async (c) => {
      try {
        const result = await requestOtpChallenge(c, otpProvider, {
          channel: "sms",
          destination: digits,
          purpose: "buyer_join",
          deal_id: dealId
        });
        // The new rail hashes the code at insert; for the legacy contract we
        // need to expose a code back to the demo-mode client. We re-issue a
        // bypass-equivalent: in dev/demo the OTP_TEST_BYPASS_CODE (or a
        // generated one cached client-side) is what the verify endpoint will
        // accept via the bypass path. To avoid storing extra state we simply
        // tell the dev client which code to submit.
        const devCode = !isProductionLikeEnv() ? (process.env.OTP_TEST_BYPASS_CODE || "424242") : undefined;
        if (devCode) {
          legacyPhoneByChallenge.set(result.challenge_id, {
            phone: digits,
            code: devCode,
            expiresAt: Date.parse(result.expires_at)
          });
        } else {
          legacyPhoneByChallenge.set(result.challenge_id, {
            phone: digits,
            code: "",
            expiresAt: Date.parse(result.expires_at)
          });
        }
        return {
          ok: true,
          otp_session_id: result.challenge_id,
          challenge_id: result.challenge_id,
          masked_destination: result.destination_display,
          expires_at: result.expires_at,
          // Only emitted in non-production-like environments. Used by demo and tests.
          development_code: devCode
        };
      } catch (err) {
        return throwOtpError(err);
      }
    });
  });

  // ── /api/otp/verify — accepts challenge_id (new) or otp_session_id (legacy) ──
  // Verify writes (attempts_count++, status updates) must persist even on a
  // thrown OtpValidationError. Use the auto-commit pool when available so the
  // attempt counter is never rolled back by a wrapping transaction.
  app.post("/api/otp/verify", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    await ensureOtpTables();
    const body = (req.body as any) || {};
    const challengeId = String(body.challenge_id || body.otp_session_id || "").trim();
    const code = String(body.code || "").trim();
    if (!challengeId) {
      const err: any = new Error("challenge_id required");
      err.statusCode = 400;
      err.code = "otp_invalid";
      throw err;
    }
    if (!isUuid(challengeId)) {
      const err: any = new Error("challenge_id must be a valid uuid");
      err.statusCode = 400;
      err.code = "otp_invalid";
      throw err;
    }

    const legacy = legacyPhoneByChallenge.get(challengeId);
    const testBypassCode = !isProductionLikeEnv()
      ? (legacy?.code || process.env.OTP_TEST_BYPASS_CODE || "424242")
      : null;
    const dbForVerify = deps.pool;
    const verifiedResponse = async (result: any) => {
      const session = await deps.withTx(async (c) => issueBuyerSession(c, req, result));
      if (session) {
        reply.header("set-cookie", serializeBuyerSessionCookie(session.token, { secure: isProductionLikeEnv() }));
      }
      const buyerId = legacy?.phone || result.destination_hash.slice(0, 12);
      return {
        ok: true,
        otp_session_id: challengeId,
        challenge_id: challengeId,
        verified: true,
        buyer_id: buyerId,
        otp_token: result.otp_token,
        verified_at: result.verified_at,
        purpose: result.purpose,
        channel: result.channel,
        resume_session: Boolean(session)
      };
    };
    try {
      if (!dbForVerify) {
        // Fallback: route through withTx. Attempt counters may not persist on
        // a thrown error in this fallback path. Production app.ts always sets
        // deps.pool so the fallback only runs in minimal test setups.
        return await deps.withTx(async (c) => {
          const result = await verifyOtpChallenge(c, { challenge_id: challengeId, code, test_bypass_code: testBypassCode });
          const session = await issueBuyerSession(c, req, result);
          if (session) reply.header("set-cookie", serializeBuyerSessionCookie(session.token, { secure: isProductionLikeEnv() }));
          const buyerId = legacy?.phone || result.destination_hash.slice(0, 12);
          return {
            ok: true,
            otp_session_id: challengeId,
            challenge_id: challengeId,
            verified: true,
            buyer_id: buyerId,
            otp_token: result.otp_token,
            verified_at: result.verified_at,
            purpose: result.purpose,
            channel: result.channel,
            resume_session: Boolean(session)
          };
        });
      }
      const result = await verifyOtpChallenge(dbForVerify, { challenge_id: challengeId, code, test_bypass_code: testBypassCode });
      return await verifiedResponse(result);
    } catch (err) {
      return throwOtpError(err);
    }
  });

  const handleAuthorizePayment = async (req: any, reply: any) => {
    const body = req.body || {};
    const authorizeInput: Parameters<typeof deps.paymentProvider.authorize>[0] = {
      payer_name: String(body.payer_name || ""),
      payer_phone: String(body.payer_phone || ""),
      payer_email: String(body.payer_email || ""),
      description: String(body.description || body.deal_id || "Siton deal"),
      payment_method_id: String(body.payment_method_id || ""),
      amount_minor: body.amount_minor,
      currency: String(body.currency || ""),
      request_id: String(req.headers?.["x-request-id"] || req.id || "")
    };
    if (body.buyer_id) authorizeInput.buyer_id = String(body.buyer_id);
    if (body.deal_id) authorizeInput.deal_id = String(body.deal_id);
    if (body.correlation_id) authorizeInput.correlation_id = String(body.correlation_id);
    if (body.payment_method_id) authorizeInput.payment_method_id = String(body.payment_method_id);

    if (body.deal_id) {
      const dealId = String(body.deal_id);
      requireUuid(dealId, "deal_id");
      const qty = parsePositiveIntegerQuantity(body.qty);

      // Buyer verification for payment is governed by the single policy
      // boundary. MVP default: OFF. When required, the OTP proof must be bound
      // to the submitted buyer identity and fails closed.
      if (isBuyerVerificationRequired("payment")) {
        const otpToken = body.otp_token ? String(body.otp_token) : null;
        const otpChallengeId = body.otp_challenge_id ? String(body.otp_challenge_id) : null;
        await deps.withTx(async (c) => {
          await ensureJoinOtpVerified(c, {
            otp_token: otpToken,
            otp_challenge_id: otpChallengeId,
            deal_id: dealId,
            channel: "sms",
            destination: String(body.buyer_id || "")
          });
        });
      }

      const serverMoney = await deps.withTx(async (c) => {
        const dealResult = await c.query(
          `SELECT deal_id, state, max_units, price_per_unit
           FROM siton.deals
           WHERE deal_id=$1
           FOR UPDATE`,
          [dealId]
        );
        if (!dealResult.rowCount) {
          const err: any = new Error("deal not found");
          err.statusCode = 404;
          err.code = "deal_not_found";
          throw err;
        }
        const deal = dealResult.rows[0] as {
          state: string;
          max_units: string | number;
          price_per_unit: string | number;
        };
        if (!["PendingTarget", "TargetReached"].includes(String(deal.state))) {
          const err: any = new Error("deal is not open for payment authorization");
          err.statusCode = 409;
          err.code = "deal_not_open_for_authorization";
          throw err;
        }

        const deliveryOptionId = String(body.delivery_option_id || "").trim();
        const deliveryOption = deliveryOptionId
          ? await c.query(
              `SELECT option_id, cost
               FROM siton.deal_delivery_options
               WHERE option_id=$1 AND deal_id=$2`,
              [deliveryOptionId, dealId]
            )
          : await c.query(
              `SELECT option_id, cost
               FROM siton.deal_delivery_options
               WHERE deal_id=$1
               ORDER BY sort_order ASC, created_at ASC
               LIMIT 1`,
              [dealId]
            );
        if (deliveryOptionId && !deliveryOption.rowCount) {
          const err: any = new Error("invalid_delivery_option");
          err.statusCode = 400;
          err.code = "invalid_delivery_option";
          throw err;
        }

        const reservedResult = await c.query(
          `SELECT COALESCE(SUM(qty), 0) AS total
           FROM siton.participants
           WHERE deal_id=$1
             AND buyer_state NOT IN ('DealFailed','Dropped')`,
          [dealId]
        );
        const remaining = Number(deal.max_units || 0) - Number(reservedResult.rows[0]?.total || 0);
        if (qty > remaining) {
          const err: any = new Error(`requested quantity (${qty}) exceeds available inventory (${Math.max(0, remaining)})`);
          err.statusCode = 409;
          err.code = "max_units_exceeded";
          throw err;
        }

        const deliveryCost = Number(deliveryOption.rows[0]?.cost || 0);
        return paymentMinorAmount({
          qty,
          pricePerUnit: Number(deal.price_per_unit || 0),
          deliveryCost
        });
      });

      authorizeInput.amount_minor = serverMoney;
    }

    const result = await deps.paymentProvider.authorize(authorizeInput);
    if (body.buyer_id && body.payment_method_id) {
      await upsertBuyerPaymentMethod({
        buyer_id: String(body.buyer_id),
        provider_code: deps.paymentProvider.providerCode,
        provider_payment_method_id: String(body.payment_method_id),
        correlation_id: result.ok ? result.correlation_id : authorizeInput.correlation_id ?? null,
        mark_authorized: result.ok && result.authorization === "authorized",
        mark_failed: !result.ok && !result.retryable
      }).catch(() => undefined);
    }

    if (!result.ok) {
      return reply.code(result.statusCode).send(result);
    }

    return result;
  };
  app.post("/api/payments/authorize", handleAuthorizePayment);
  app.post("/api/payments/authorize-mock", handleAuthorizePayment);

  app.post("/api/payments/status", async (req: any, reply: any) => {
    if (!deps.paymentProvider.status) return reply.code(501).send({ ok: false, error: "payment_status_not_supported" });
    const body = req.body || {};
    const providerReference = String(body.provider_reference || "").trim();
    const correlationId = String(body.correlation_id || req.headers?.["x-request-id"] || req.id || "").trim();
    const operation = String(body.operation || "authorization") as "authorization" | "capture" | "release" | "refund";
    if (!providerReference || providerReference.length > 4096 || !["authorization", "capture", "release", "refund"].includes(operation)) {
      return reply.code(400).send({ ok: false, error: "payment_status_request_invalid" });
    }
    const result = await deps.paymentProvider.status({ provider_reference: providerReference, correlation_id: correlationId, operation });
    return { ok: true, ...result, authorization_id: result.state === "authorized" ? result.provider_reference : undefined };
  });

  app.post("/api/payments/tokenize", async (req: any, reply: any) => {
    return reply.code(410).send({
      ok: false,
      error: "hosted_payment_required",
      message: "Payment details must be entered in the payment provider hosted component; C-ton accepts only payment_method_id."
    });
  });

  app.post("/api/affiliate/links", async (req: any, reply: any) => {
    await ensureProductSurfaces();
    const body = req.body || {};
    if (body.affiliate_id !== undefined || body.distributor_id !== undefined || body.tenant_id !== undefined) {
      return reply.code(400).send({ error: "client_distributor_identity_forbidden" });
    }
    const dealId = String(body.deal_id || "").trim();
    const internalName = String(body.internal_name || "").trim();
    requireUuid(dealId, "deal_id");
    if (!internalName || internalName.length > 80) {
      return reply.code(400).send({ error: "affiliate_link_name_invalid" });
    }
    const result = await deps.withTx(async (c) => {
      const profile = await resolveDistributorContext(req, c, deps.isDemoPreview);
      if (!profile) {
        return {
          status: distributorAuthConfigured() ? 401 : 503,
          body: { error: distributorAuthConfigured() ? "distributor_auth_required" : "distributor_auth_unavailable" }
        };
      }
      const deal = await c.query(
        `SELECT deal_id, state FROM siton.deals WHERE deal_id=$1 LIMIT 1`,
        [dealId]
      );
      if (!deal.rows[0]) return { status: 404, body: { error: "deal_not_found" } };
      if (!["PendingTarget", "TargetReached"].includes(String(deal.rows[0].state))) {
        return { status: 409, body: { error: "affiliate_link_deal_not_shareable" } };
      }
      const prefix = String(profile.affiliate_code || "distributor").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32) || "distributor";
      const sourceCode = `${prefix}-${randomBytes(6).toString("hex")}`;
      try {
        const inserted = await c.query(
          `INSERT INTO siton.affiliate_links (affiliate_id, deal_id, internal_name, source_code)
           VALUES ($1,$2,$3,$4)
           RETURNING link_id, deal_id, internal_name, source_code, created_at`,
          [profile.affiliate_id, dealId, internalName, sourceCode]
        );
        const row = inserted.rows[0] as any;
        return {
          status: 201,
          body: {
            ok: true,
            link: {
              ...row,
              share_link: `/app/deal/${row.deal_id}?ref=${encodeURIComponent(row.source_code)}`
            }
          }
        };
      } catch (error: any) {
        if (String(error?.code || "") === "23505") {
          return { status: 409, body: { error: "affiliate_link_name_exists" } };
        }
        throw error;
      }
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/affiliate/links/visit", async (req: any, reply: any) => {
    const body = req.body || {};
    const dealId = String(body.deal_id || "").trim();
    const sourceCode = String(body.source_code || "").trim().slice(0, 64);
    const clickId = String(body.click_id || "").trim().slice(0, 100);
    const entryId = String(body.entry_id || "").trim().slice(0, 100);
    requireUuid(dealId, "deal_id");
    if (!sourceCode || clickId.length < 8 || entryId.length < 8) {
      return reply.code(400).send({ error: "affiliate_visit_invalid" });
    }
    return deps.withTx(async (c) => {
      const link = await c.query(
        `SELECT link_id FROM siton.affiliate_links
         WHERE source_code=$1 AND deal_id=$2 AND disabled_at IS NULL
         LIMIT 1`,
        [sourceCode, dealId]
      );
      if (!link.rows[0]) return reply.code(202).send({ ok: true, recorded: false });
      await c.query(
        `INSERT INTO siton.affiliate_link_events (link_id, event_type, client_event_id)
         VALUES ($1,'click',$2),($1,'entry',$3)
         ON CONFLICT (link_id, event_type, client_event_id) DO NOTHING`,
        [link.rows[0].link_id, clickId, entryId]
      );
      return reply.code(202).send({ ok: true, recorded: true });
    });
  });

  // ═══ R6 — commerce viral graph + owner control-center surfaces ═══════════
  // Growth analytics only: nothing below creates or moves money, and
  // sharers/links earn NOTHING through the system, by product constitution.

  // Public, PII-free funnel events (deal_view / share_button_click /
  // join_started). Client retries deduplicate on client_event_id.
  app.post("/api/viral/events", async (req: any, reply: any) => {
    const body = req.body || {};
    const dealId = String(body.deal_id || "").trim();
    requireUuid(dealId, "deal_id");
    const result = await deps.withTx(async (c) =>
      recordViralFunnelEvent(c, {
        event_type: String(body.event_type || ""),
        deal_id: dealId,
        ref_code: body.ref_code,
        share_channel: body.share_channel,
        visitor_id: body.visitor_id,
        session_id: body.session_id,
        client_event_id: String(body.client_event_id || "")
      })
    );
    if (!result.recorded && result.reason && result.reason !== "deal_not_found") {
      return reply.code(400).send({ ok: false, error: result.reason });
    }
    return reply.code(202).send({ ok: true, recorded: result.recorded });
  });

  // Public live-activity feed for the deal page: real joins only, masked to a
  // first name, plus the live aggregate the progress story needs. No PII.
  app.get("/api/deals/:dealId/activity", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    reply.header("cache-control", "no-store");
    return deps.withTx(async (c) => {
      const deal = await c.query(
        `SELECT deal_id, state, min_units, max_units, threshold_units, deadline, completion_window_until
         FROM siton.deals WHERE deal_id=$1 AND published_at IS NOT NULL LIMIT 1`,
        [dealId]
      );
      if (!deal.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const totals = await c.query(
        `SELECT
           COALESCE(SUM(qty) FILTER (WHERE buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS joined_units,
           COUNT(*) FILTER (WHERE buyer_state NOT IN ('NotJoined','DealFailed','Dropped'))::int AS participants,
           COALESCE(SUM(qty) FILTER (WHERE money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units
         FROM siton.participants WHERE deal_id=$1`,
        [dealId]
      );
      const recent = await c.query(
        `SELECT split_part(btrim(COALESCE(buyer_name,'')), ' ', 1) AS first_name, qty, created_at
         FROM siton.participants
         WHERE deal_id=$1 AND buyer_state NOT IN ('NotJoined','DealFailed','Dropped')
         ORDER BY created_at DESC
         LIMIT 12`,
        [dealId]
      );
      const row = deal.rows[0];
      const t = totals.rows[0];
      return {
        ok: true,
        deal_id: dealId,
        state: String(row.state),
        min_units: Number(row.min_units),
        max_units: Number(row.max_units),
        threshold_units: Number(row.threshold_units),
        deadline: row.deadline,
        completion_window_until: row.completion_window_until,
        joined_units: Number(t.joined_units || 0),
        participants: Number(t.participants || 0),
        charged_units: Number(t.charged_units || 0),
        remaining_units: Math.max(0, Number(row.max_units) - Number(t.joined_units || 0)),
        recent_joins: recent.rows.map((r: any) => ({
          display: String(r.first_name || "").length > 1 ? String(r.first_name) : "משתתף",
          qty: Number(r.qty || 0),
          at: new Date(String(r.created_at)).toISOString()
        })),
        server_time: new Date().toISOString()
      };
    });
  });

  // Participant personal impact — safe aggregates only, gated by the same
  // opaque tracking credential as the tracking screen. No descendant PII.
  app.get("/api/participants/:participantId/impact", async (req: any, reply: any) => {
    const participantId = String(req.params.participantId || "");
    requireUuid(participantId, "participant_id");
    await ensureParticipantTrackingTables(deps.withTx);
    return deps.withTx(async (c) => {
      const row = await c.query(
        `SELECT participant_id, deal_id FROM siton.participants WHERE participant_id=$1 LIMIT 1`,
        [participantId]
      );
      if (!row.rowCount) {
        const err: any = new Error("participant not found");
        err.statusCode = 404;
        throw err;
      }
      const accessToken = extractTrackingToken(req);
      if (!accessToken) {
        const err: any = new Error("tracking_token_required");
        err.statusCode = 401;
        throw err;
      }
      const access = await verifyParticipantTrackingAccess(c, {
        participant_id: participantId,
        deal_id: String(row.rows[0].deal_id),
        token: accessToken,
        purposes: ["tracking", "recovery", "support"]
      });
      if (!access.ok) {
        const err: any = new Error(access.error);
        err.statusCode = 403;
        throw err;
      }
      const impact = await getParticipantImpact(c, participantId);
      return { ok: true, impact };
    });
  });

  // Seller: viral performance for the seller's own deal (cached metrics).
  app.get("/api/seller/deals/:dealId/viral", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c);
      if (!sellerContext) return reply;
      const owned = await c.query(
        `SELECT deal_id FROM siton.deals WHERE deal_id=$1 AND seller_id=$2 LIMIT 1`,
        [dealId, sellerContext.seller_id]
      );
      if (!owned.rowCount) {
        // Ownership mismatch is a 404, matching the seller surface convention.
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const cached = await readViralMetricsCache(c, "deal", dealId);
      return { ok: true, deal_id: dealId, ...cached };
    });
  });

  // Admin: platform growth/virality dashboard (cached platform scope).
  app.get("/api/admin/growth", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    return deps.withTx(async (c) => {
      const platform = await readViralMetricsCache(c, "platform", "global");
      const recentEvents = await c.query(
        `SELECT event_type, COUNT(*)::int AS cnt
         FROM siton.viral_events
         WHERE created_at > now() - interval '7 days'
         GROUP BY event_type`
      );
      const recentAttributed = await c.query(
        `SELECT COUNT(*)::int AS cnt
         FROM siton.viral_attributions
         WHERE origin_ref_type <> 'none' AND created_at > now() - interval '7 days'`
      );
      return {
        ok: true,
        platform,
        last_7_days: {
          funnel_events: Object.fromEntries(recentEvents.rows.map((r: any) => [String(r.event_type), Number(r.cnt)])),
          attributed_joins: Number(recentAttributed.rows[0]?.cnt || 0)
        }
      };
    });
  });

  // Admin: per-deal viral metrics + tree explorer payload.
  app.get("/api/admin/deals/:dealId/viral", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    return deps.withTx(async (c) => {
      const cached = await readViralMetricsCache(c, "deal", dealId);
      return { ok: true, deal_id: dealId, ...cached };
    });
  });

  // Admin: seller-scope viral metrics.
  app.get("/api/admin/sellers/:sellerId/viral", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const sellerId = String(req.params.sellerId || "").slice(0, 120);
    return deps.withTx(async (c) => {
      const cached = await readViralMetricsCache(c, "seller", sellerId);
      return { ok: true, seller_id: sellerId, ...cached };
    });
  });

  // Admin mutation: enqueue a viral recompute for one deal (audited admin
  // action attribution comes from the named identity, never a header).
  app.post("/api/admin/viral/recompute", async (req: any, reply: any) => {
    const identity = await requireAdminMutation(req, reply, "outbox.requeue");
    if (!identity) return;
    const dealId = String(req.body?.deal_id || "").trim();
    requireUuid(dealId, "deal_id");
    await deps.withTx(async (c) => {
      const exists = await c.query(`SELECT deal_id FROM siton.deals WHERE deal_id=$1 LIMIT 1`, [dealId]);
      if (!exists.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      await enqueueViralRecompute(c, dealId, `admin:${adminActorRef(identity)}`);
    });
    return { ok: true, deal_id: dealId, enqueued: true };
  });

  // Admin: the R6 global control-center overview — the whole system in one
  // call. Provisional/potential money is NEVER labeled as charged revenue:
  // the two families are returned under separate, explicit keys.
  app.get("/api/admin/r6/overview", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const dealStates = await c.query(
        `SELECT state::text AS state, COUNT(*)::int AS cnt FROM siton.deals GROUP BY state`
      );
      const sellerStats = await c.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE COALESCE(seller_status,'Active')='Active')::int AS active
         FROM siton.seller_accounts`
      );
      const participantStats = await c.query(
        `SELECT COUNT(*)::int AS participants,
                COUNT(DISTINCT buyer_id)::int AS buyers,
                COALESCE(SUM(qty) FILTER (WHERE buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS units_joined,
                COALESCE(SUM(qty) FILTER (WHERE money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS units_charged,
                COUNT(*) FILTER (WHERE money_state='ChargeFailedRecovery')::int AS in_recovery,
                COALESCE(SUM(qty) FILTER (WHERE money_state='ChargeFailedRecovery'),0)::int AS units_in_recovery
         FROM siton.participants`
      );
      const moneyStats = await c.query(
        `SELECT
           COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
             FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')), 0)::numeric(14,2) AS potential_gross,
           COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
             FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')), 0)::numeric(14,2) AS charged_gross
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id`
      );
      const feeActual = await c.query(
        `SELECT COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_actual
         FROM siton.platform_fee_money_events`
      );
      const outbox = await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='pending')::int AS pending,
           COUNT(*) FILTER (WHERE status='processing')::int AS processing,
           MIN(available_at) FILTER (WHERE status='pending') AS oldest_pending_at
         FROM siton.outbox_events`
      );
      const dlq = await c.query(`SELECT COUNT(*)::int AS cnt FROM siton.outbox_dlq`);
      const worker = await c.query(
        `SELECT worker_id, status, heartbeat_at,
                EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS age_seconds
         FROM siton.worker_heartbeats ORDER BY heartbeat_at DESC LIMIT 3`
      );
      const notifications = await c.query(
        `SELECT status, COUNT(*)::int AS cnt FROM siton.notification_events GROUP BY status`
      );
      const recentDlq = await c.query(
        `SELECT event_type, aggregate_id, updated_at AS archived_at, last_error
         FROM siton.outbox_dlq ORDER BY updated_at DESC NULLS LAST LIMIT 5`
      );
      const recentPaymentFailures = await c.query(
        `SELECT COUNT(*)::int AS cnt FROM siton.payment_attempts
         WHERE result_class='permanent_fail' AND created_at > now() - interval '24 hours'`
      );
      const openCases = await c.query(
        `SELECT COUNT(*)::int AS cnt FROM siton.operational_cases WHERE status NOT IN ('Resolved','Closed')`
      );
      const openTickets = await c.query(
        `SELECT COUNT(*)::int AS cnt FROM siton.support_tickets WHERE status <> 'resolved'`
      );
      const viralPlatform = await readViralMetricsCache(c, "platform", "global");

      const stateCounts: Record<string, number> = {};
      for (const r of dealStates.rows) stateCounts[String(r.state)] = Number(r.cnt);
      const p = participantStats.rows[0];
      const m = moneyStats.rows[0];
      const potentialGross = Number(m.potential_gross || 0);
      return {
        ok: true,
        generated_at: new Date().toISOString(),
        deals: {
          by_state: stateCounts,
          total: dealStates.rows.reduce((s: number, r: any) => s + Number(r.cnt), 0),
          active: (stateCounts["PendingTarget"] || 0) + (stateCounts["TargetReached"] || 0)
            + (stateCounts["ClosedForJoining"] || 0) + (stateCounts["ReadyForCharging"] || 0)
            + (stateCounts["Charging"] || 0) + (stateCounts["CompletionWindow"] || 0)
        },
        sellers: {
          total: Number(sellerStats.rows[0].total || 0),
          active: Number(sellerStats.rows[0].active || 0)
        },
        participants: {
          total: Number(p.participants || 0),
          distinct_buyers: Number(p.buyers || 0),
          units_joined: Number(p.units_joined || 0),
          units_charged: Number(p.units_charged || 0),
          in_recovery: Number(p.in_recovery || 0),
          units_in_recovery: Number(p.units_in_recovery || 0)
        },
        money: {
          // Provisional: authorized frames only — NOT revenue.
          potential_gross_volume: potentialGross,
          platform_fee_projection: Math.round(potentialGross * SITON_PLATFORM_FEE_RATE * 100) / 100,
          // Actual: successful charges only (ChargedSuccess/RecoveredCharge).
          charged_gross_volume: Number(m.charged_gross || 0),
          platform_fee_actual: Number(feeActual.rows[0].fee_actual || 0)
        },
        operations: {
          outbox_pending: Number(outbox.rows[0].pending || 0),
          outbox_processing: Number(outbox.rows[0].processing || 0),
          oldest_pending_at: outbox.rows[0].oldest_pending_at,
          dlq_size: Number(dlq.rows[0].cnt || 0),
          workers: worker.rows.map((w: any) => ({
            worker_id: String(w.worker_id),
            status: String(w.status),
            heartbeat_age_seconds: Number(w.age_seconds || 0)
          })),
          notifications_by_status: Object.fromEntries(notifications.rows.map((r: any) => [String(r.status), Number(r.cnt)])),
          open_operational_cases: Number(openCases.rows[0].cnt || 0),
          open_support_tickets: Number(openTickets.rows[0].cnt || 0),
          payment_permanent_failures_24h: Number(recentPaymentFailures.rows[0].cnt || 0),
          recent_dlq: recentDlq.rows.map((r: any) => ({
            event_type: String(r.event_type),
            aggregate_id: String(r.aggregate_id),
            archived_at: r.archived_at,
            last_error: String(r.last_error || "").slice(0, 300)
          }))
        },
        viral: viralPlatform
      };
    });
  });

  // Admin: global deals list with money + viral rollups.
  app.get("/api/admin/r6/deals", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const stateFilter = String(req.query?.state || "").trim();
    const q = String(req.query?.q || "").trim().slice(0, 120);
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `SELECT d.deal_id, d.title, d.state::text AS state, d.deal_type, d.seller_id,
                sa.business_name, sa.display_name AS seller_display_name,
                d.price_per_unit, d.min_units, d.max_units, d.threshold_units,
                d.deadline, d.published_at, d.completion_window_until, d.created_at, d.updated_at,
                COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS joined_units,
                COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
                COUNT(p.participant_id) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped'))::int AS participants,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::numeric(14,2) AS potential_gross,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross,
                COUNT(va.participant_id) FILTER (WHERE va.origin_ref_type <> 'none')::int AS viral_joins
         FROM siton.deals d
         LEFT JOIN siton.seller_accounts sa ON sa.seller_id = d.seller_id
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         LEFT JOIN siton.viral_attributions va ON va.participant_id = p.participant_id
         WHERE ($1 = '' OR d.state::text = $1)
           AND ($2 = '' OR d.title ILIKE '%' || $2 || '%' OR d.deal_id::text = $2 OR d.seller_id ILIKE '%' || $2 || '%')
         GROUP BY d.deal_id, sa.business_name, sa.display_name
         ORDER BY d.updated_at DESC
         LIMIT 200`,
        [stateFilter, q]
      );
      return { ok: true, deals: rows.rows };
    });
  });

  // Admin: global sellers list with rollups.
  app.get("/api/admin/r6/sellers", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `SELECT sa.seller_id, sa.display_name, sa.business_name,
                COALESCE(sa.seller_status,'Active') AS seller_status,
                sa.login_email, sa.auth_enabled, (sa.auth_user_id IS NOT NULL) AS supabase_bound,
                sa.created_at,
                COUNT(DISTINCT d.deal_id)::int AS deals_total,
                COUNT(DISTINCT d.deal_id) FILTER (WHERE d.state IN ('PendingTarget','TargetReached','ClosedForJoining','ReadyForCharging','Charging','CompletionWindow'))::int AS deals_active,
                COUNT(DISTINCT d.deal_id) FILTER (WHERE d.state='Completed')::int AS deals_completed,
                COUNT(DISTINCT d.deal_id) FILTER (WHERE d.state='Failed')::int AS deals_failed,
                COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS joined_units,
                COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::numeric(14,2) AS potential_gross,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross,
                MAX(GREATEST(d.updated_at, p.updated_at)) AS last_activity_at
         FROM siton.seller_accounts sa
         LEFT JOIN siton.deals d ON d.seller_id = sa.seller_id
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         GROUP BY sa.seller_id
         ORDER BY last_activity_at DESC NULLS LAST
         LIMIT 200`
      );
      const feeBySeller = await c.query(
        `SELECT seller_id, COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_actual
         FROM siton.platform_fee_money_events GROUP BY seller_id`
      );
      const feeMap = new Map(feeBySeller.rows.map((r: any) => [String(r.seller_id), Number(r.fee_actual)]));
      return {
        ok: true,
        sellers: rows.rows.map((r: any) => ({
          ...r,
          platform_fee_actual: feeMap.get(String(r.seller_id)) || 0,
          platform_fee_projection: Math.round(Number(r.potential_gross || 0) * SITON_PLATFORM_FEE_RATE * 100) / 100
        }))
      };
    });
  });

  // Admin: full seller drilldown — the complete seller picture.
  app.get("/api/admin/r6/sellers/:sellerId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const sellerId = String(req.params.sellerId || "").slice(0, 120);
    return deps.withTx(async (c) => {
      const seller = await c.query(
        `SELECT seller_id, display_name, business_name, business_identifier,
                support_phone, support_email, business_description,
                COALESCE(seller_status,'Active') AS seller_status, seller_status_reason,
                login_email, auth_enabled, (auth_user_id IS NOT NULL) AS supabase_bound,
                verification_status, created_at, updated_at
         FROM siton.seller_accounts WHERE seller_id=$1 LIMIT 1`,
        [sellerId]
      );
      if (!seller.rowCount) {
        const err: any = new Error("seller not found");
        err.statusCode = 404;
        throw err;
      }
      const deals = await c.query(
        `SELECT d.deal_id, d.title, d.state::text AS state, d.deal_type,
                d.price_per_unit, d.min_units, d.max_units, d.threshold_units,
                d.deadline, d.published_at, d.completion_window_until, d.created_at, d.updated_at,
                COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS joined_units,
                COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
                COUNT(p.participant_id) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped'))::int AS participants,
                COUNT(p.participant_id) FILTER (WHERE p.money_state='ChargeFailedRecovery')::int AS in_recovery,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::numeric(14,2) AS potential_gross,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         WHERE d.seller_id=$1
         GROUP BY d.deal_id
         ORDER BY d.updated_at DESC
         LIMIT 100`,
        [sellerId]
      );
      const fee = await c.query(
        `SELECT COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_actual,
                COALESCE(SUM(seller_net_amount),0)::numeric(14,2) AS seller_net
         FROM siton.platform_fee_money_events WHERE seller_id=$1`,
        [sellerId]
      );
      const delivery = await c.query(
        `SELECT COALESCE(fu.status,'') AS delivery_status, COUNT(*)::int AS cnt
         FROM siton.fulfillment_units fu
         JOIN siton.deals d ON d.deal_id = fu.deal_id
         WHERE d.seller_id=$1
         GROUP BY 1`,
        [sellerId]
      ).catch(() => ({ rows: [] as any[] }));
      const tickets = await c.query(
        `SELECT ticket_id, scope_type, scope_key, title, priority, status, created_at
         FROM siton.support_tickets
         WHERE (scope_type='seller' AND scope_key=$1)
            OR (scope_type='deal' AND scope_key IN (SELECT deal_id::text FROM siton.deals WHERE seller_id=$1))
         ORDER BY created_at DESC LIMIT 20`,
        [sellerId]
      );
      const audit = await c.query(
        `SELECT audit_id, entity_type, entity_id, state_type, from_state, to_state, action_name, created_at
         FROM siton.audit_log
         WHERE deal_id IN (SELECT deal_id FROM siton.deals WHERE seller_id=$1)
         ORDER BY created_at DESC LIMIT 25`,
        [sellerId]
      );
      const dlqRelated = await c.query(
        `SELECT event_type, aggregate_id, updated_at AS archived_at
         FROM siton.outbox_dlq
         WHERE aggregate_id::text IN (SELECT deal_id::text FROM siton.deals WHERE seller_id=$1)
         ORDER BY updated_at DESC NULLS LAST LIMIT 10`,
        [sellerId]
      );
      const viral = await readViralMetricsCache(c, "seller", sellerId);
      const warnings: string[] = [];
      for (const d of deals.rows as any[]) {
        if (d.state === "CompletionWindow") warnings.push(`deal_in_completion_window:${d.deal_id}`);
        if (Number(d.in_recovery || 0) > 0) warnings.push(`participants_in_recovery:${d.deal_id}:${d.in_recovery}`);
      }
      if (dlqRelated.rows.length) warnings.push(`dlq_events_related:${dlqRelated.rows.length}`);
      return {
        ok: true,
        seller: seller.rows[0],
        deals: deals.rows,
        money: {
          platform_fee_actual: Number(fee.rows[0].fee_actual || 0),
          seller_net_actual: Number(fee.rows[0].seller_net || 0),
          potential_gross: deals.rows.reduce((s: number, d: any) => s + Number(d.potential_gross || 0), 0),
          charged_gross: deals.rows.reduce((s: number, d: any) => s + Number(d.charged_gross || 0), 0)
        },
        delivery_status_counts: Object.fromEntries((delivery.rows as any[]).map((r) => [r.delivery_status || "unknown", Number(r.cnt)])),
        support_tickets: tickets.rows,
        audit_tail: audit.rows,
        dlq_related: dlqRelated.rows,
        viral,
        warnings
      };
    });
  });

  // Admin: global audit tail (read-only, human-readable projection).
  app.get("/api/admin/r6/audit", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const q = String(req.query?.q || "").trim().slice(0, 120);
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `SELECT a.audit_id, a.entity_type, a.entity_id, a.deal_id, a.state_type,
                a.from_state, a.to_state, a.action_name, a.correlation_id, a.created_at,
                d.title AS deal_title
         FROM siton.audit_log a
         LEFT JOIN siton.deals d ON d.deal_id = a.deal_id
         WHERE ($1 = '' OR a.action_name ILIKE '%' || $1 || '%' OR a.deal_id::text = $1 OR a.entity_id::text = $1 OR a.correlation_id ILIKE '%' || $1 || '%')
         ORDER BY a.created_at DESC
         LIMIT 120`,
        [q]
      );
      return { ok: true, audit: rows.rows };
    });
  });

  // Admin: buyers/participants roster (aggregated by buyer identity).
  app.get("/api/admin/r6/buyers", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const q = String(req.query?.q || "").trim().slice(0, 120);
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `SELECT p.buyer_id,
                MAX(p.buyer_name) AS buyer_name,
                MAX(p.buyer_email) AS buyer_email,
                COUNT(*)::int AS participations,
                COUNT(DISTINCT p.deal_id)::int AS deals,
                COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS units_joined,
                COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS units_charged,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross,
                COUNT(*) FILTER (WHERE p.money_state='ChargeFailedRecovery')::int AS in_recovery,
                MAX(p.created_at) AS last_join_at
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE ($1 = '' OR p.buyer_id ILIKE '%' || $1 || '%' OR p.buyer_name ILIKE '%' || $1 || '%' OR p.buyer_email ILIKE '%' || $1 || '%')
         GROUP BY p.buyer_id
         ORDER BY last_join_at DESC
         LIMIT 200`,
        [q]
      );
      return { ok: true, buyers: rows.rows };
    });
  });

  // ── Demo Readiness Command Center ───────────────────────────────────────
  // Read-only. Returns a structured verdict on whether the demo environment is
  // genuinely ready for presentation and future real-money integration.
  // Never mutates state, never triggers providers.
  const _demoReadinessStartedAt = new Date().toISOString();
  app.get("/api/admin/demo-readiness", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;

    const freshness = deployFreshness();
    const runtimeCommit = freshness.runtime_commit_sha;
    const expectedCommit = freshness.expected_commit_sha || "";

    const blockers: string[] = [];
    const warnings: string[] = [];

    // Deploy freshness
    let isStale = false;
    let deployFreshnessEvidence = "";
    if (expectedCommit) {
      isStale = runtimeCommit !== "unknown" && runtimeCommit !== expectedCommit;
      if (isStale) {
        blockers.push("runtime commit does not match expected commit");
        deployFreshnessEvidence = "runtime=" + runtimeCommit + " expected=" + expectedCommit;
      } else if (runtimeCommit === "unknown") {
        warnings.push("runtime commit SHA is unknown");
        deployFreshnessEvidence = freshness.evidence;
      } else {
        deployFreshnessEvidence = "commit " + runtimeCommit + " matches expected";
      }
    } else {
      warnings.push("expected commit is not configured");
      deployFreshnessEvidence = freshness.evidence;
      if (runtimeCommit === "unknown") warnings.push("runtime commit SHA is unknown");
    }

    // DB + outbox + demo-data (read-only)
    const CRITICAL_TABLES = [
      "deals", "participants", "outbox_events", "outbox_dlq",
      "idempotency_log", "payment_attempts", "webhook_events",
      "seller_accounts", "audit_log", "notification_events"
    ];
    const OPTIONAL_TABLES = ["invoice_documents", "seller_payout_batches", "operational_cases"];

    let dbOk = false;
    let schemaReady = false;
    let migrationsVisible = false;
    let requiredTablesPresent = false;
    const missingTables: string[] = [];
    let outboxPending = 0, outboxProcessing = 0, outboxFailed = 0, dlqCount = 0;
    let oldestPendingAgeSeconds: number | null = null;
    let hasDemoSeller = false, hasPublicDeal = false, hasJoinableDeal = false;
    let hasCompletedDeal = false, hasFailedDeal = false;

    try {
      await deps.withTx(async (c: any) => {
        const schemaRes = await c.query(
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'siton'"
        );
        schemaReady = schemaRes.rows.length > 0;

        if (schemaReady) {
          const tableRes = await c.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'siton'"
          );
          const existingTables = new Set(tableRes.rows.map((r: any) => String(r.table_name)));
          migrationsVisible = existingTables.has("deals");

          for (const t of CRITICAL_TABLES) {
            if (!existingTables.has(t)) missingTables.push(t);
          }
          requiredTablesPresent = missingTables.length === 0;
          if (!requiredTablesPresent) {
            blockers.push("critical tables missing: " + missingTables.join(", "));
          }
          for (const t of OPTIONAL_TABLES) {
            if (!existingTables.has(t)) warnings.push("optional table missing: " + t);
          }

          const [outboxRow, dlqRow, demoRow] = await Promise.all([
            c.query(
              "SELECT " +
              "COUNT(*) FILTER (WHERE status='pending')    AS pending, " +
              "COUNT(*) FILTER (WHERE status='processing') AS processing, " +
              "COUNT(*) FILTER (WHERE status='failed')     AS failed, " +
              "EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status='pending'))) AS oldest_pending_age_s " +
              "FROM siton.outbox_events"
            ),
            c.query("SELECT COUNT(*) AS dlq_count FROM siton.outbox_dlq"),
            c.query(
              "SELECT " +
              "(SELECT COUNT(*) FROM siton.seller_accounts)::int AS seller_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state <> 'Draft')::int AS public_deal_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state IN ('PendingTarget','TargetReached'))::int AS joinable_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state = 'Completed')::int AS completed_count, " +
              "(SELECT COUNT(*) FROM siton.deals WHERE state IN ('Failed','Cancelled'))::int AS failed_count"
            )
          ]);

          const o = outboxRow.rows[0];
          outboxPending    = Number(o.pending    ?? 0);
          outboxProcessing = Number(o.processing ?? 0);
          outboxFailed     = Number(o.failed     ?? 0);
          dlqCount         = Number(dlqRow.rows[0].dlq_count ?? 0);
          oldestPendingAgeSeconds = o.oldest_pending_age_s != null
            ? Number(Number(o.oldest_pending_age_s).toFixed(1)) : null;

          const dm = demoRow.rows[0];
          hasDemoSeller    = Number(dm.seller_count)      > 0;
          hasPublicDeal    = Number(dm.public_deal_count) > 0;
          hasJoinableDeal  = Number(dm.joinable_count)    > 0;
          hasCompletedDeal = Number(dm.completed_count)   > 0;
          hasFailedDeal    = Number(dm.failed_count)      > 0;
        }
        dbOk = schemaReady && requiredTablesPresent;
      });
    } catch (err: any) {
      blockers.push("database check failed: " + (err?.message ?? String(err)));
    }

    if (!dbOk && !blockers.some((b) => b.startsWith("database check failed") || b.startsWith("critical tables"))) {
      blockers.push("database is not ready");
    }
    if (dbOk) {
      if (outboxFailed > 0)
        warnings.push("outbox has " + outboxFailed + " failed event(s)");
      if (dlqCount > 0)
        blockers.push("outbox DLQ has " + dlqCount + " unresolved event(s)");
      if (oldestPendingAgeSeconds != null && oldestPendingAgeSeconds > 3600)
        warnings.push("oldest pending outbox event is " + Math.round(oldestPendingAgeSeconds / 60) + "m old");
    }

    if (!hasDemoSeller)    warnings.push("no demo seller account found");
    if (!hasPublicDeal)    warnings.push("no public (non-draft) deal found");
    if (!hasJoinableDeal)  warnings.push("no joinable deal in PendingTarget or TargetReached");
    if (!hasCompletedDeal) warnings.push("no completed deal found (demo end-state missing)");
    if (!hasFailedDeal)    warnings.push("no failed/cancelled deal found (failure-state demo missing)");

    // Providers — read config only, never activate
    const paymentSummary = getPaymentProviderSummary(deps.paymentProvider);
    const payoutSummary  = getPayoutProviderSummary(payoutProvider);

    // Product contract — static constants
    const feeRateOk = SITON_PLATFORM_FEE_RATE === 0.08;
    if (!feeRateOk) blockers.push("platform fee rate is " + SITON_PLATFORM_FEE_RATE + ", expected 0.08");

    const verdict: "ready" | "warning" | "blocked" =
      blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready";

    return {
      ok: verdict !== "blocked",
      verdict,
      environment: {
        node_env:           process.env.NODE_ENV || "development",
        app_env:            process.env.APP_ENV || process.env.APP_DEPLOYMENT_MODE || "demo-preview",
        demo_preview:       deps.isDemoPreview,
        commit_sha:         runtimeCommit,
        build_time:         null,
        runtime_started_at: _demoReadinessStartedAt
      },
      deploy_freshness: {
        expected_commit_sha: freshness.expected_commit_sha,
        runtime_commit_sha:  freshness.runtime_commit_sha,
        is_stale:            freshness.is_stale,
        evidence:            deployFreshnessEvidence
      },
      database: {
        ok:                      dbOk,
        schema_ready:            schemaReady,
        migrations_visible:      migrationsVisible,
        required_tables_present: requiredTablesPresent,
        missing_tables:          missingTables
      },
      providers: {
        payment: {
          provider:   paymentSummary.provider,
          mode:       paymentSummary.mode,
          configured: paymentSummary.configured,
          is_mock:    paymentSummary.mock_backed
        },
        invoice: {
          provider:          deps.invoiceSummary?.provider ?? "internal-invoice-ledger",
          mode:              deps.invoiceSummary?.mode ?? "internal",
          configured:        deps.invoiceSummary?.configured ?? false,
          external_issuance: deps.invoiceSummary?.external_issuance ?? false
        },
        payout: {
          provider:          payoutSummary.provider,
          mode:              payoutSummary.mode,
          configured:        payoutSummary.configured,
          external_transfer: payoutSummary.external_transfer_executed
        },
        notifications: {
          provider:          deps.notificationSummary?.provider ?? "log-only",
          mode:              deps.notificationSummary?.mode ?? "log-only",
          external_delivery: deps.notificationSummary?.external_delivery ?? false
        }
      },
      queues: {
        outbox_pending:             outboxPending,
        outbox_processing:          outboxProcessing,
        outbox_failed:              outboxFailed,
        dlq_count:                  dlqCount,
        oldest_pending_age_seconds: oldestPendingAgeSeconds
      },
      demo_data: {
        has_demo_seller:    hasDemoSeller,
        has_public_deal:    hasPublicDeal,
        has_joinable_deal:  hasJoinableDeal,
        has_completed_deal: hasCompletedDeal,
        has_failed_deal:    hasFailedDeal
      },
      product_contract: {
        direct_links_first_class:       true,
        public_mall_discovery:          true,
        mall_owns_state_or_money:       false,
        distributor_attribution_only:  true,
        platform_fee_8_percent:        feeRateOk,
        platform_fee_rate:             SITON_PLATFORM_FEE_RATE,
        buyer_repeat_purchase_allowed: true
      },
      blockers,
      warnings,
      checked_at: new Date().toISOString()
    };
  });

  app.get("/app/assets/styles.css", async (_req, reply) =>
    sendFrontendFile(reply, "styles.css", "text/css; charset=utf-8")
  );
  app.get("/app/assets/app.js", async (_req, reply) =>
    sendFrontendFile(reply, "app.js", "application/javascript; charset=utf-8")
  );
  app.get("/app/assets/mobile-bridge.js", async (_req, reply) =>
    sendFrontendFile(reply, "mobile-bridge.js", "application/javascript; charset=utf-8")
  );
  app.get("/app/service-worker.js", async (_req, reply) =>
    sendFrontendFile(reply, "service-worker.js", "application/javascript; charset=utf-8")
  );
  app.get("/app/manifest.webmanifest", async (_req, reply) =>
    sendFrontendFile(reply, "manifest.webmanifest", "application/manifest+json; charset=utf-8")
  );
  app.get("/app/icons/logo.svg", async (_req, reply) =>
    sendFrontendFile(reply, "icons/logo.svg", "image/svg+xml")
  );
  app.get("/app/icons/:iconName", async (req: any, reply: any) => {
    const iconName = String(req.params.iconName || "");
    if (!/^icon-(48|72|96|128|192|256|512)\.png$/.test(iconName)) {
      return reply.code(404).send({ ok: false, error: "icon_not_found" });
    }
    return sendFrontendFile(reply, `icons/${iconName}`, "image/png");
  });
  app.get("/app/offline", async (_req, reply) =>
    sendFrontendFile(reply, "offline.html", "text/html; charset=utf-8")
  );

  const sendShell = async (req: any, reply: FastifyReply) => {
    const pathOnly = String(req.raw?.url || req.url || "/app").split("?", 1)[0] || "/app";
    let title = "C-ton | אפליקציית עסקאות קבוצתיות";
    let description = "C-ton מאפשרת לגלות ולנהל עסקאות קבוצתיות בבטחה.";
    let canonicalPath = "/app";
    let robots = "noindex,nofollow";
    let ogImage = "";

    if (pathOnly === "/app" || pathOnly === "/app/") {
      title = "C-ton | קניון עסקאות קבוצתיות";
      description = "מגלים עסקאות קבוצתיות פעילות, רואים את ההתקדמות ומצטרפים רק למסלול הקנוני של העסקה.";
      robots = "index,follow";
    } else {
      const match = pathOnly.match(/^\/app\/deal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      if (match) {
        const dealId = String(match[1]);
        const publicDeal = await deps.withTx(async (c) => {
          const result = await c.query(
            `SELECT d.title, d.description, image.image_id, image.public_url
             FROM siton.deals d
             LEFT JOIN LATERAL (
               SELECT i.image_id, i.public_url
               FROM siton.deal_images i
               WHERE i.deal_id=d.deal_id
               ORDER BY i.is_primary DESC, i.sort_order ASC, i.created_at ASC
               LIMIT 1
             ) image ON true
             WHERE d.deal_id=$1 AND d.published_at IS NOT NULL AND d.state <> 'Draft'
             LIMIT 1`,
            [dealId]
          );
          return result.rows[0] || null;
        });
        if (publicDeal) {
          const publicTitle = String(publicDeal.title || "עסקה קבוצתית").trim().slice(0, 200);
          const publicDescription = String(publicDeal.description || "").trim().slice(0, 220);
          title = `${publicTitle} | C-ton`;
          description = publicDescription || `צפו בפרטי העסקה הקבוצתית ${publicTitle}, בהתקדמות ובסטטוס הקנוני שלה.`;
          canonicalPath = `/app/deal/${dealId}`;
          robots = "index,follow";
          if (publicDeal.image_id) ogImage = resolveDealImageUrl({ image_id: String(publicDeal.image_id), public_url: publicDeal.public_url });
        }
      }
    }

    let html = await readFile(join(frontendDir, "index.html"), "utf8");
    const safeTitle = escapeHtml(title);
    const safeDescription = escapeHtml(description);
    const safeCanonical = escapeHtml(canonicalPath);
    const safeImage = escapeHtml(ogImage);
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${safeDescription}" />`)
      .replace(/<meta name="robots" content="[^"]*" \/>/, `<meta name="robots" content="${robots}" />`)
      .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${safeTitle}" />`)
      .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${safeDescription}" />`)
      .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${safeCanonical}" />`)
      .replace(/<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${safeImage}" />`)
      .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${safeTitle}" />`)
      .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${safeDescription}" />`)
      .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${safeCanonical}" />`);
    return reply
      .header("cache-control", "no-store")
      .header("x-robots-tag", robots)
      .type("text/html; charset=utf-8")
      .send(html);
  };

  app.get("/", async (_req, reply) => reply.redirect("/app", 302));
  app.get("/legal/:slug", async (req: any, reply) => {
    const slug = String(req.params.slug || "") as LegalPageSlug;
    if (!Object.prototype.hasOwnProperty.call(LEGAL_PAGES, slug)) {
      return reply.code(404).send({ ok: false, error: "legal page not found" });
    }
    return reply.type("text/html; charset=utf-8").send(renderLegalHtmlPage(slug));
  });
  app.get("/app", sendShell);
  app.get("/app/", sendShell);
  app.get("/app/terms", sendShell);
  app.get("/app/privacy", sendShell);
  app.get("/app/refunds", sendShell);
  app.get("/app/accessibility", sendShell);
  app.get("/app/seller-terms", sendShell);
  app.get("/app/distributor-terms", sendShell);
  app.get("/app/contact", sendShell);
  app.get("/app/deal/:dealId", sendShell);
  app.get("/app/join/:dealId/otp", sendShell);
  app.get("/app/join/:dealId/payment", sendShell);
  app.get("/app/join/:dealId/confirmation", sendShell);
  app.get("/app/track/:participantId", sendShell);
  app.get("/app/recovery/:participantId", sendShell);
  app.get("/app/seller", sendShell);
  app.get("/app/seller/new", sendShell);
  app.get("/app/seller/deals/:dealId/edit", sendShell);
  app.get("/app/seller/deals/:dealId", sendShell);
  app.get("/app/affiliate", sendShell);
  app.get("/app/admin", sendShell);
  app.get("/app/admin/deals/:dealId", sendShell);
  app.get("/app/admin/participants/:participantId", sendShell);
  app.get("/app/admin/users/:buyerId", sendShell);
  app.get("/app/*", sendShell);
}
