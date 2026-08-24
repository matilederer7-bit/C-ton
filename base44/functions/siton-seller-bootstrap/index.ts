import { createClientFromRequest } from "npm:@base44/sdk";

const FORBIDDEN_IDENTITY_CODE = "seller_identity_forbidden";
const SELLER_AUTH_CODES = {
  required: "SELLER_AUTH_REQUIRED",
  expired: "SELLER_SESSION_EXPIRED",
  forbidden: "SELLER_FORBIDDEN",
  unavailable: "SELLER_AUTH_UNAVAILABLE"
} as const;
const CLIENT_FORBIDDEN_FIELDS = ["user_id", "base44_user_id", "seller_id", "seller_account_id"] as const;
const IDENTITY_FIELDS = [
  "id", "base44_user_id", "business_name", "seller_account_id", "verification_status",
  "onboarding_status", "created_date", "updated_date"
] as const;
const SELLER_ACCOUNT_FIELDS = ["id", "seller_id", "business_name", "display_name"] as const;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeReturnTo(req: Request) {
  const value = String(req.headers.get("x-siton-return-to") ?? "").trim();
  return /^\/app\/seller(?:\/new|\/deals\/[0-9a-f-]{20,80}(?:\/edit)?)?(?:\?[^#\r\n]{0,500})?$/i.test(value)
    ? value
    : "/app/seller/new";
}

function hasPresentedCredential(req: Request) {
  return Boolean(String(req.headers.get("authorization") ?? "").trim());
}

function authFailure(req: Request, reason: keyof typeof SELLER_AUTH_CODES, status: number, reasonCode?: string) {
  const productCode = SELLER_AUTH_CODES[reason];
  return Response.json({
    ok: false,
    error: productCode,
    code: productCode,
    product_code: productCode,
    ...(reasonCode ? { reason_code: reasonCode } : {}),
    seller_auth: {
      reason,
      reauthentication_required: reason === "expired",
      return_to: safeReturnTo(req)
    }
  }, { status });
}

function forbiddenIdentity(req: Request) {
  return authFailure(req, "forbidden", 403, FORBIDDEN_IDENTITY_CODE);
}

function isForbiddenError(error: unknown) {
  const candidate = recordValue(error);
  const status = Number(candidate?.status ?? candidate?.statusCode ?? 0);
  const code = String(candidate?.code ?? "").toLowerCase();
  const message = String(candidate?.message ?? error ?? "").toLowerCase();
  return status === 403 || code.includes("forbidden") || code.includes("permission")
    || message.includes("forbidden") || message.includes("permission denied");
}

function onboardingState(identity: Record<string, unknown>) {
  const state = String(identity.onboarding_status ?? "started");
  const verificationStatus = String(identity.verification_status ?? "pending");
  const nextStep = state === "started" ? "complete_profile"
    : state === "profile_complete" && verificationStatus === "pending" ? "await_verification"
      : state === "approved" && verificationStatus === "approved" ? "create_deal"
        : state === "rejected" || verificationStatus === "rejected" ? "contact_support"
          : "complete_profile";
  return { state, verification_status: verificationStatus, next_step: nextStep };
}

function sellerResponse(identity: Record<string, unknown>, identityCreated: boolean, accountCreated: boolean) {
  const seller = Object.fromEntries(IDENTITY_FIELDS
    .filter((field) => field !== "base44_user_id")
    .map((field) => [field, identity[field] ?? null]));
  return {
    ok: true,
    created: identityCreated || accountCreated,
    identity_created: identityCreated,
    seller_account_created: accountCreated,
    seller,
    onboarding: onboardingState(identity)
  };
}

async function deterministicSellerId(userId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`siton:base44-seller:${userId}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `b44_${hex.slice(0, 32)}`;
}

async function findSellerAccount(base44: any, sellerId: string) {
  const accounts = await base44.asServiceRole.entities.SellerAccount.filter(
    { seller_id: sellerId }, "-updated_date", 2, 0, [...SELLER_ACCOUNT_FIELDS]
  );
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  if (accounts.length > 1) throw new Error(FORBIDDEN_IDENTITY_CODE);
  return accounts[0] as Record<string, unknown>;
}

async function ensureSellerAccount(base44: any, sellerId: string, businessName: string) {
  const existing = await findSellerAccount(base44, sellerId);
  if (existing) return { account: existing, created: false };
  try {
    const created = await base44.asServiceRole.entities.SellerAccount.create({
      seller_id: sellerId,
      display_name: businessName,
      business_name: businessName,
      verification_status: "pending",
      seller_status: "Active"
    });
    return { account: created as Record<string, unknown>, created: true };
  } catch (error) {
    if (isForbiddenError(error)) throw new Error(FORBIDDEN_IDENTITY_CODE);
    const raced = await findSellerAccount(base44, sellerId);
    if (raced) return { account: raced, created: false };
    throw new Error("seller_account_bootstrap_unavailable");
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const base44 = createClientFromRequest(req);
  let user: Record<string, unknown>;
  try {
    user = await base44.auth.me();
  } catch (error) {
    const candidate = recordValue(error);
    const status = Number(candidate?.status ?? candidate?.statusCode ?? 0);
    if (status === 401) return authFailure(req, hasPresentedCredential(req) ? "expired" : "required", 401);
    if (status === 403) return authFailure(req, "forbidden", 403);
    return authFailure(req, "unavailable", 503);
  }
  const userId = String(user?.id ?? "").trim();
  if (!userId) return authFailure(req, hasPresentedCredential(req) ? "expired" : "required", 401);

  let input: Record<string, unknown> = {};
  try {
    input = recordValue(await req.json()) ?? {};
  } catch {
    input = {};
  }
  if (CLIENT_FORBIDDEN_FIELDS.some((field) => Object.hasOwn(input, field))) return forbiddenIdentity(req);
  if (input.business_name !== undefined && typeof input.business_name !== "string") {
    return Response.json({ ok: false, error: "business_name_invalid" }, { status: 400 });
  }
  const suppliedName = String(input.business_name ?? "").trim();
  if (suppliedName.length > 160) {
    return Response.json({ ok: false, error: "business_name_too_long" }, { status: 400 });
  }
  const trustedUserName = String(user.full_name ?? user.name ?? "").trim().slice(0, 160);
  const businessName = suppliedName || trustedUserName || "New Siton seller";

  try {
    const identities = await base44.asServiceRole.entities.SellerIdentity.filter(
      { base44_user_id: userId }, "-created_date", 2, 0, [...IDENTITY_FIELDS]
    );
    if (Array.isArray(identities) && identities.length > 1) return forbiddenIdentity(req);
    let identity = Array.isArray(identities) && identities.length === 1
      ? identities[0] as Record<string, unknown>
      : null;
    if (identity && String(identity.base44_user_id ?? "") !== userId) return forbiddenIdentity(req);

    let accountCreated = false;
    let sellerAccountId = String(identity?.seller_account_id ?? "").trim();
    if (sellerAccountId) {
      const boundAccount = await findSellerAccount(base44, sellerAccountId);
      if (!boundAccount) return forbiddenIdentity(req);
    } else {
      sellerAccountId = await deterministicSellerId(userId);
      const ensured = await ensureSellerAccount(base44, sellerAccountId, businessName);
      accountCreated = ensured.created;
    }

    if (identity?.id) {
      if (!identity.seller_account_id) {
        identity = await base44.asServiceRole.entities.SellerIdentity.update(identity.id, {
          seller_account_id: sellerAccountId
        });
      }
      return Response.json(sellerResponse(identity, false, accountCreated));
    }

    try {
      identity = await base44.asServiceRole.entities.SellerIdentity.create({
        base44_user_id: userId,
        seller_account_id: sellerAccountId,
        business_name: businessName,
        verification_status: "pending",
        onboarding_status: "started"
      });
      return Response.json(sellerResponse(identity, true, accountCreated), { status: 201 });
    } catch (error) {
      if (isForbiddenError(error)) return forbiddenIdentity(req);
      const raced = await base44.asServiceRole.entities.SellerIdentity.filter(
        { base44_user_id: userId }, "-created_date", 2, 0, [...IDENTITY_FIELDS]
      );
      if (!Array.isArray(raced) || raced.length !== 1
        || String(raced[0]?.seller_account_id ?? "") !== sellerAccountId) return forbiddenIdentity(req);
      return Response.json(sellerResponse(raced[0], false, accountCreated));
    }
  } catch (error) {
    if (String((error as Error)?.message ?? "") === FORBIDDEN_IDENTITY_CODE || isForbiddenError(error)) return forbiddenIdentity(req);
    return authFailure(req, "unavailable", 503);
  }
});
