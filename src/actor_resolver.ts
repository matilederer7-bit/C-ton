// Canonical actor resolution for verified Supabase identities.
//
// After a Supabase access token is cryptographically verified, the ONLY thing
// trusted from it is the subject UUID (auth.users.id) and its email claim.
// Authority is resolved FRESH from canonical Postgres on every request: the sub
// is looked up against seller_accounts / admin_users / affiliate_accounts by
// auth_user_id, and each actor's live status is re-checked. JWT role and
// user_metadata are never consulted.
//
// R6 capability policy: one authenticated principal MAY hold more than one
// Siton application capability (e.g. the owner is an admin and may also hold a
// seller binding). Authority stays EXPLICIT: a route requiring seller
// authority reads only the seller capability; a route requiring admin
// authority reads only the admin capability. Nothing here ever "picks" the
// most privileged capability on the caller's behalf, and a capability that
// resolves to more than one row for the same sub still fails closed.

import type { SupabaseVerifier, VerifiedToken } from "./supabase_auth.js";
import { AuthTokenError } from "./supabase_auth.js";

export interface SellerCapability {
  seller_id: string;
  display_name: string;
  auth_enabled: boolean;
  seller_status: string;
}

export interface AdminCapability {
  admin_user_id: string;
  email: string;
  role: string;
  status: string;
}

export interface DistributorCapability {
  affiliate_id: string;
  auth_enabled: boolean;
  verification_status: string;
}

export interface ResolvedCapabilities {
  sub: string;
  email: string;
  token: VerifiedToken;
  seller: SellerCapability | null;
  admin: AdminCapability | null;
  distributor: DistributorCapability | null;
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };

export function bearerToken(req: any): string {
  const header = String(req?.headers?.["authorization"] || req?.headers?.["Authorization"] || "").trim();
  if (!/^bearer\s+/i.test(header)) return "";
  return header.replace(/^bearer\s+/i, "").trim();
}

// Resolves a verified Supabase token to its full capability set. Returns null
// when there is no token. Throws AuthTokenError when a token is present but
// invalid, or when any single capability binding is duplicated (fail closed).
// A token with zero capabilities resolves to an empty set — the route-level
// requirement ("this route needs seller/admin authority") produces the denial,
// so an owner mid-provisioning gets a precise error rather than a generic one.
export async function resolveSupabaseCapabilities(
  req: any,
  db: Queryable,
  verifier: SupabaseVerifier | null
): Promise<ResolvedCapabilities | null> {
  if (!verifier) return null;
  const token = bearerToken(req);
  if (!token) return null;
  // Only engage for well-formed JWTs. Other Bearer schemes (e.g. opaque
  // participant tracking tokens) are not Supabase identities and are left for
  // their own handlers rather than being rejected here.
  if (token.split(".").length !== 3) return null;

  const verified = await verifier.verify(token); // throws on invalid
  const sub = verified.sub;

  const [sellerRes, adminRes, distRes] = await Promise.all([
    db.query(
      `SELECT seller_id, display_name, auth_enabled, COALESCE(seller_status,'Active') AS seller_status
       FROM siton.seller_accounts WHERE auth_user_id = $1 LIMIT 2`,
      [sub]
    ),
    db.query(
      `SELECT admin_user_id, email, role, status
       FROM siton.admin_users WHERE auth_user_id = $1 LIMIT 2`,
      [sub]
    ),
    db.query(
      `SELECT affiliate_id, auth_enabled, COALESCE(verification_status,'pending') AS verification_status
       FROM siton.affiliate_accounts WHERE auth_user_id = $1 LIMIT 2`,
      [sub]
    )
  ]);

  // A sub bound to two rows of the SAME capability is a data integrity fault:
  // there is no way to know which seller/admin/distributor the principal is.
  if ((sellerRes.rowCount ?? 0) > 1 || (adminRes.rowCount ?? 0) > 1 || (distRes.rowCount ?? 0) > 1) {
    throw new AuthTokenError("ambiguous_binding");
  }

  const sellerRow = sellerRes.rows[0];
  const adminRow = adminRes.rows[0];
  const distRow = distRes.rows[0];

  return {
    sub,
    email: String((verified as any).email || "").toLowerCase(),
    token: verified,
    seller: sellerRow
      ? {
          seller_id: String(sellerRow.seller_id),
          display_name: String(sellerRow.display_name || sellerRow.seller_id),
          auth_enabled: Boolean(sellerRow.auth_enabled),
          seller_status: String(sellerRow.seller_status)
        }
      : null,
    admin: adminRow
      ? {
          admin_user_id: String(adminRow.admin_user_id),
          email: String(adminRow.email),
          role: String(adminRow.role),
          status: String(adminRow.status)
        }
      : null,
    distributor: distRow
      ? {
          affiliate_id: String(distRow.affiliate_id),
          auth_enabled: Boolean(distRow.auth_enabled),
          verification_status: String(distRow.verification_status)
        }
      : null
  };
}
