import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";

export type SellerAuthCredential = {
  seller_id: string;
  display_name: string;
  access_code: string;
  login_email?: string;
};

export const SELLER_SESSION_COOKIE = "siton_seller_session";
export const SELLER_SESSION_TTL_SECONDS = 60 * 60 * 12;
export const SELLER_SESSION_LAST_SEEN_THROTTLE_MS = 60_000;
export const SELLER_AUTH_SECRET_MIN_LENGTH = 8;

export const SELLER_AUTH_PRODUCT_CODES = {
  required: "SELLER_AUTH_REQUIRED",
  expired: "SELLER_SESSION_EXPIRED",
  forbidden: "SELLER_FORBIDDEN",
  unavailable: "SELLER_AUTH_UNAVAILABLE"
} as const;

export type SellerAuthFailureReason = keyof typeof SELLER_AUTH_PRODUCT_CODES;

const SELLER_RETURN_PATH = /^\/app\/seller(?:\/new|\/deals\/[0-9a-f-]{36}(?:\/edit)?)?\/?$/i;

/**
 * Authentication continuations are product navigation hints, never authority.
 * Keep them same-origin and inside the seller surface so an API caller cannot
 * turn a login response into an open redirect.
 */
export function safeSellerReturnTo(value: unknown, fallback = "/app/seller") {
  const safeFallback = SELLER_RETURN_PATH.test(String(fallback || "")) ? String(fallback) : "/app/seller";
  const raw = String(value || "").trim();
  if (!raw || raw.includes("\\") || raw.startsWith("//") || /[\u0000-\u001f\u007f]/.test(raw)) return safeFallback;
  try {
    const parsed = new URL(raw, "https://siton.invalid");
    if (parsed.origin !== "https://siton.invalid" || !SELLER_RETURN_PATH.test(parsed.pathname)) return safeFallback;
    const query = parsed.search.length <= 300 ? parsed.search : "";
    const hash = parsed.hash === "#seller-profile-section" ? parsed.hash : "";
    return `${parsed.pathname}${query}${hash}`;
  } catch {
    return safeFallback;
  }
}

export function hasSellerSessionCookie(cookieHeader: unknown) {
  return Boolean(String(parseCookies(cookieHeader)[SELLER_SESSION_COOKIE] || "").trim());
}

export function sellerAuthFailurePayload(
  reason: SellerAuthFailureReason,
  options?: { returnTo?: unknown; message?: string; reasonCode?: string }
) {
  const legacyError = {
    required: "seller_auth_required",
    expired: "seller_session_expired",
    forbidden: "seller_forbidden",
    unavailable: "seller_auth_unavailable"
  }[reason];
  const message = options?.message || {
    required: "seller session is required for this non-demo runtime",
    expired: "seller session has expired or is no longer valid",
    forbidden: "seller account is not allowed to perform this action",
    unavailable: "seller auth is not configured for this non-demo runtime"
  }[reason];
  return {
    ok: false as const,
    error: legacyError,
    code: reason === "forbidden" && options?.reasonCode?.startsWith("SELLER_")
      ? options.reasonCode
      : SELLER_AUTH_PRODUCT_CODES[reason],
    product_code: SELLER_AUTH_PRODUCT_CODES[reason],
    ...(options?.reasonCode ? { reason_code: options.reasonCode } : {}),
    message,
    seller_auth: {
      authenticated: false,
      reason,
      reauthentication_required: reason === "expired",
      return_to: safeSellerReturnTo(options?.returnTo),
      onboarding: {
        required: false,
        next_path: "/app/seller#seller-profile-section"
      }
    }
  };
}

export function normalizeSellerId(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "seller-default";
}

export function normalizeSellerDisplayName(value: unknown, fallbackId: string) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return normalized || fallbackId;
}

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeSellerLoginEmail(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase().slice(0, 200);
  if (!normalized) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return "";
  return normalized;
}

export function parseSellerAuthCredentials(raw: string | undefined | null): SellerAuthCredential[] {
  const value = String(raw || "").trim();
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => {
          const sellerId = normalizeSellerId((row as any)?.seller_id);
          const accessCode = String((row as any)?.access_code || "").trim();
          const displayName = normalizeSellerDisplayName((row as any)?.display_name, sellerId);
          const loginEmail = normalizeSellerLoginEmail((row as any)?.login_email);
          if (!sellerId || !accessCode) return null;
          return { seller_id: sellerId, display_name: displayName, access_code: accessCode, login_email: loginEmail || undefined };
        })
        .filter(Boolean) as SellerAuthCredential[];
    }
  } catch {}

  return value
    .split(/[;\n]+/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const [rawSellerId, rawDisplayName, rawAccessCode] = row.split("|");
      const sellerId = normalizeSellerId(rawSellerId);
      const accessCode = String(rawAccessCode || "").trim();
      const displayName = normalizeSellerDisplayName(rawDisplayName, sellerId);
      const loginEmail = normalizeSellerLoginEmail((row.split("|")[3] || "").trim());
      if (!sellerId || !accessCode) return null;
      return { seller_id: sellerId, display_name: displayName, access_code: accessCode, login_email: loginEmail || undefined };
    })
    .filter(Boolean) as SellerAuthCredential[];
}

export function parseCookies(headerValue: unknown) {
  const raw = String(headerValue || "");
  const cookies: Record<string, string> = {};
  for (const chunk of raw.split(";")) {
    const [rawName, ...rawValueParts] = chunk.split("=");
    const name = String(rawName || "").trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(rawValueParts.join("=").trim());
  }
  return cookies;
}

export function createSellerSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSellerSessionToken(token: unknown, secret: string) {
  const raw = String(token || "").trim();
  if (!raw || !secret) return null;
  return sha256Hex(`${secret}:${raw}`);
}

export function hashSellerAccessSecret(secret: unknown) {
  const raw = String(secret || "");
  if (raw.trim().length < SELLER_AUTH_SECRET_MIN_LENGTH) {
    const err: any = new Error(`seller access secret must be at least ${SELLER_AUTH_SECRET_MIN_LENGTH} characters`);
    err.statusCode = 400;
    throw err;
  }
  const salt = encodeBase64Url(randomBytes(16).toString("hex"));
  const derived = scryptSync(raw, salt, 32);
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export function verifySellerAccessSecret(secret: unknown, storedHash: unknown) {
  const rawSecret = String(secret || "");
  const rawHash = String(storedHash || "").trim();
  if (!rawSecret || !rawHash) return false;
  const [scheme, salt, encodedDigest] = rawHash.split("$");
  if (scheme !== "scrypt" || !salt || !encodedDigest) return false;

  try {
    const expectedDigest = Buffer.from(encodedDigest, "base64url");
    const providedDigest = scryptSync(rawSecret, salt, expectedDigest.length);
    if (expectedDigest.length !== providedDigest.length || !expectedDigest.length) return false;
    return timingSafeEqual(expectedDigest, providedDigest);
  } catch {
    return false;
  }
}

export function serializeSellerSessionCookie(
  token: string,
  maxAgeSeconds = SELLER_SESSION_TTL_SECONDS,
  options?: { secure?: boolean }
) {
  return `${SELLER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${options?.secure ? "; Secure" : ""}`;
}

export function serializeExpiredSellerSessionCookie(options?: { secure?: boolean }) {
  return `${SELLER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options?.secure ? "; Secure" : ""}`;
}
