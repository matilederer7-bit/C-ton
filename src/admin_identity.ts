import { assertRequiredTables } from "./schema_contract.js";
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from "crypto";
import { promisify } from "util";
import { ADMIN_API_KEY, isProductionLikeEnv } from "./runtime_config.js";
import { buildSupabaseVerifier } from "./supabase_auth.js";
import { resolveSupabaseCapabilities, bearerToken } from "./actor_resolver.js";

const scrypt = promisify(scryptCb);

// Env-gated Supabase verifier (inert unless SUPABASE_URL is configured).
let _adminSupabaseVerifier: ReturnType<typeof buildSupabaseVerifier> | undefined;
function adminSupabaseVerifier() {
  if (_adminSupabaseVerifier === undefined) _adminSupabaseVerifier = buildSupabaseVerifier();
  return _adminSupabaseVerifier;
}

export const ADMIN_SESSION_COOKIE = "siton_admin_session";
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const ADMIN_MFA_RECENT_WINDOW_MS = 15 * 60 * 1000;

export const ADMIN_ROLES = ["SuperAdmin", "OpsAdmin", "SupportAdmin", "ReadOnlyAdmin"] as const;
export type AdminRole = typeof ADMIN_ROLES[number];

export const ADMIN_PERMISSIONS = [
  "mission_control.read",
  "admin_actions.read",
  "admin_actions.create",
  "admin_actions.approve",
  "admin_actions.execute",
  "admin_users.manage",
  "support.manage",
  "security.read",
  "payout.freeze",
  "emergency.pause",
  "invoice.retry",
  "notification.retry",
  "outbox.requeue"
] as const;
export type AdminPermission = typeof ADMIN_PERMISSIONS[number];

export type AdminIdentity = {
  admin_user_id: string | null;
  email: string | null;
  display_name: string | null;
  role: AdminRole | "BootstrapReadOnly";
  identity_strength: "session_identity" | "bootstrap_key_only";
  permissions: string[];
  mfa_verified_at: string | null;
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

let ensurePromise: Promise<void> | null = null;

const ROLE_PERMISSIONS: Record<AdminRole | "BootstrapReadOnly", readonly AdminPermission[]> = {
  SuperAdmin: ADMIN_PERMISSIONS,
  OpsAdmin: [
    "mission_control.read",
    "admin_actions.read",
    "admin_actions.create",
    "admin_actions.approve",
    "admin_actions.execute",
    "support.manage",
    "security.read",
    "outbox.requeue",
    "notification.retry",
    "invoice.retry"
  ],
  SupportAdmin: ["mission_control.read", "admin_actions.read", "admin_actions.create", "support.manage", "security.read"],
  ReadOnlyAdmin: ["mission_control.read", "admin_actions.read", "security.read"],
  BootstrapReadOnly: ["mission_control.read", "admin_actions.read", "security.read"]
};

export const ADMIN_ACTION_PERMISSION: Record<string, AdminPermission> = {
  trigger_reconcile: "admin_actions.execute",
  requeue_outbox_event: "outbox.requeue",
  retry_notification: "notification.retry",
  retry_invoice_failed: "invoice.retry",
  freeze_payouts: "payout.freeze",
  unfreeze_payouts: "payout.freeze",
  open_support_case: "support.manage",
  content_takedown_request: "support.manage",
  pause_joining_emergency: "emergency.pause",
  pause_charging_emergency: "emergency.pause"
};

export const HIGH_TRUST_ADMIN_ACTIONS = new Set([
  "freeze_payouts",
  "unfreeze_payouts",
  "pause_joining_emergency",
  "pause_charging_emergency",
  "content_takedown_request"
]);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseCookieHeader(raw: unknown) {
  const out: Record<string, string> = {};
  for (const part of String(raw || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function createAdminSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashAdminSessionToken(token: string) {
  return sha256(`admin-session:${token}`);
}

export function serializeAdminSessionCookie(token: string, maxAgeSeconds = ADMIN_SESSION_TTL_SECONDS, options?: { secure?: boolean }) {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`
  ];
  if (options?.secure) parts.push("Secure");
  return parts.join("; ");
}

export function serializeExpiredAdminSessionCookie(options?: { secure?: boolean }) {
  const parts = [`${ADMIN_SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (options?.secure) parts.push("Secure");
  return parts.join("; ");
}

export async function hashAdminPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyAdminPassword(password: string, storedHash: string | null | undefined) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1] || "";
  const digest = parts[2] || "";
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(digest, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function hashAdminOtp(code: string) {
  return sha256(`admin-mfa:${String(code || "").trim()}`);
}

export function isAdminRole(role: string): role is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

export function hasAdminPermission(identity: AdminIdentity, permission: string) {
  return identity.permissions.includes(permission);
}

export function hasRecentMfa(identity: AdminIdentity, now = Date.now()) {
  if (!identity.mfa_verified_at) return false;
  const ts = Date.parse(identity.mfa_verified_at);
  return Number.isFinite(ts) && now - ts <= ADMIN_MFA_RECENT_WINDOW_MS;
}

export async function ensureAdminIdentityTables(withTx: <T>(fn: (c: any) => Promise<T>) => Promise<T>) {
  await withTx(async c=>assertRequiredTables(c,["admin_users","admin_sessions","admin_mfa_factors","admin_mfa_challenges"]));
}

export async function issueAdminSession(c: Queryable, adminUserId: string, req: any, mfaVerified = false) {
  const token = createAdminSessionToken();
  const sessionHash = hashAdminSessionToken(token);
  const ipHash = req?.ip ? sha256(String(req.ip).slice(0, 200)) : null;
  const ua = String(req?.headers?.["user-agent"] || "").trim();
  const uaHash = ua ? sha256(ua.slice(0, 500)) : null;
  const row = await c.query(
    `INSERT INTO siton.admin_sessions
       (admin_user_id, session_token_hash, expires_at, mfa_verified_at, ip_hash, user_agent_hash)
     VALUES ($1,$2,now()+($3 || ' seconds')::interval,$4,$5,$6)
     RETURNING admin_session_id, expires_at, mfa_verified_at`,
    [adminUserId, sessionHash, String(ADMIN_SESSION_TTL_SECONDS), mfaVerified ? new Date().toISOString() : null, ipHash, uaHash]
  );
  return { token, session: row.rows[0] };
}

// The single canonical Siton owner identity. When set (SITON_OWNER_EMAIL), a
// VERIFIED Supabase token whose email claim matches is auto-provisioned an
// active SuperAdmin binding on first contact with the admin surface. Supabase
// only issues access tokens after the email is confirmed, so possession of a
// verified token with this email proves inbox ownership. The password itself
// never transits this codebase: the owner sets it in the Supabase signup flow.
export function configuredOwnerEmail(): string {
  return String(process.env.SITON_OWNER_EMAIL || "").trim().toLowerCase();
}

export async function claimOwnerAdminBinding(c: Queryable, sub: string, email: string): Promise<void> {
  // Idempotent: binds by unique email; never overwrites a foreign binding.
  await c.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, auth_user_id, mfa_required, provisioned_via, provisioned_at)
     VALUES ($1, 'Siton Owner', 'SuperAdmin', 'Active', $2, false, 'owner_email_claim', now())
     ON CONFLICT (email) DO UPDATE
       SET auth_user_id = EXCLUDED.auth_user_id,
           status = 'Active',
           provisioned_via = 'owner_email_claim',
           provisioned_at = now(),
           updated_at = now()
       WHERE siton.admin_users.auth_user_id IS NULL`,
    [email, sub]
  );
}

export async function resolveAdminIdentity(req: any, c: Queryable): Promise<AdminIdentity | null> {
  // R5C/R6 — a named admin may authenticate through Supabase Auth. The verified
  // sub is bound to an active admin_users row by auth_user_id; role/permissions
  // come from canonical Postgres, never from JWT claims. This is a named
  // session_identity — the shared bootstrap key never yields one.
  // R6 capability policy: this surface requires the ADMIN capability
  // explicitly. A principal that also holds seller/distributor capabilities is
  // never "downgraded" or guessed about — only its admin binding counts here.
  const verifier = adminSupabaseVerifier();
  if (verifier && bearerToken(req)) {
    try {
      let caps = await resolveSupabaseCapabilities(req, c as any, verifier);
      if (caps && !caps.admin) {
        const ownerEmail = configuredOwnerEmail();
        if (ownerEmail && caps.email === ownerEmail) {
          await claimOwnerAdminBinding(c, caps.sub, caps.email);
          caps = await resolveSupabaseCapabilities(req, c as any, verifier);
        }
      }
      const admin = caps?.admin || null;
      if (caps && admin && admin.status === "Active" && isAdminRole(String(admin.role))) {
        return {
          admin_user_id: admin.admin_user_id,
          email: admin.email,
          display_name: admin.email,
          role: admin.role as AdminRole,
          identity_strength: "session_identity",
          permissions: [...ROLE_PERMISSIONS[admin.role as AdminRole]],
          mfa_verified_at: caps.token.aal === "aal2" ? new Date(caps.token.iat * 1000).toISOString() : null
        };
      }
      // A token without an active admin binding is not an admin identity here.
    } catch {
      // Invalid/ambiguous Supabase token presented to an admin context → not an
      // admin identity. Fall through to cookie/key resolution (which denies).
    }
  }
  const cookies = parseCookieHeader(req?.headers?.cookie);
  const rawToken = cookies[ADMIN_SESSION_COOKIE];
  if (rawToken) {
    const tokenHash = hashAdminSessionToken(rawToken);
    const result = await c.query(
      `SELECT s.admin_session_id, s.mfa_verified_at, u.admin_user_id, u.email, u.display_name, u.role, u.status
       FROM siton.admin_sessions s
       JOIN siton.admin_users u ON u.admin_user_id=s.admin_user_id
       WHERE s.session_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()
       LIMIT 1`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (row && row.status === "Active" && isAdminRole(String(row.role))) {
      await c.query(`UPDATE siton.admin_sessions SET last_seen_at=now() WHERE admin_session_id=$1`, [row.admin_session_id]);
      return {
        admin_user_id: String(row.admin_user_id),
        email: String(row.email),
        display_name: row.display_name ? String(row.display_name) : null,
        role: row.role,
        identity_strength: "session_identity",
        permissions: [...ROLE_PERMISSIONS[row.role as AdminRole]],
        mfa_verified_at: row.mfa_verified_at ? new Date(row.mfa_verified_at).toISOString() : null
      };
    }
  }
  const configuredKey = String(process.env.ADMIN_API_KEY || ADMIN_API_KEY || "").trim();
  if (!configuredKey && isProductionLikeEnv()) return null;
  if (configuredKey) {
    const provided = String(req?.headers?.["x-admin-key"] || "").trim();
    const expectedBuf = Buffer.from(configuredKey, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    if (!provided || expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) return null;
  }
  if (!configuredKey && !isProductionLikeEnv()) {
    return {
      admin_user_id: null,
      email: null,
      display_name: "Local bootstrap admin",
      role: "BootstrapReadOnly",
      identity_strength: "bootstrap_key_only",
      permissions: [...ROLE_PERMISSIONS.BootstrapReadOnly],
      mfa_verified_at: null
    };
  }
  return {
    admin_user_id: null,
    email: null,
    display_name: String(req?.headers?.["x-admin-user"] || "Bootstrap admin").slice(0, 120),
    role: "BootstrapReadOnly",
    identity_strength: "bootstrap_key_only",
    permissions: [...ROLE_PERMISSIONS.BootstrapReadOnly],
    mfa_verified_at: null
  };
}

export function adminPublicIdentity(identity: AdminIdentity) {
  return {
    admin_user_id: identity.admin_user_id,
    email: identity.email,
    display_name: identity.display_name,
    role: identity.role,
    identity_strength: identity.identity_strength,
    permissions: identity.permissions,
    mfa_verified_at: identity.mfa_verified_at
  };
}

export function createAdminMfaCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function safeAdminId(identity: AdminIdentity) {
  return identity.admin_user_id || `bootstrap:${identity.display_name || "admin"}`;
}
