// Canonical actor resolution for verified Supabase identities.
//
// After a Supabase access token is cryptographically verified, the ONLY thing
// trusted from it is the subject UUID (auth.users.id). Authority is resolved
// FRESH from canonical Postgres on every request: the sub is looked up against
// seller_accounts / admin_users / affiliate_accounts by auth_user_id, and the
// actor's live status is re-checked. JWT role/user_metadata is never consulted.
//
// Binding ambiguity policy: a sub that resolves to zero or more than one actor
// binding fails closed (no actor). One Supabase user is at most one SITON actor.

import type { SupabaseVerifier, VerifiedToken } from "./supabase_auth.js";
import { AuthTokenError } from "./supabase_auth.js";

export type ResolvedActorType = "seller" | "admin" | "distributor";

export interface ResolvedActor {
  type: ResolvedActorType;
  sub: string;
  token: VerifiedToken;
  seller?: { seller_id: string; display_name: string; auth_enabled: boolean; seller_status: string };
  admin?: { admin_user_id: string; email: string; role: string; status: string };
  distributor?: { affiliate_id: string; auth_enabled: boolean; verification_status: string };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };

export function bearerToken(req: any): string {
  const header = String(req?.headers?.["authorization"] || req?.headers?.["Authorization"] || "").trim();
  if (!/^bearer\s+/i.test(header)) return "";
  return header.replace(/^bearer\s+/i, "").trim();
}

// Resolves a verified Supabase token to at most one canonical actor. Returns
// null when there is no token. Throws AuthTokenError when a token is present but
// invalid, or when the binding is ambiguous/absent (fail closed).
export async function resolveSupabaseActor(
  req: any,
  db: Queryable,
  verifier: SupabaseVerifier | null
): Promise<ResolvedActor | null> {
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

  const bindings: ResolvedActor[] = [];
  if (sellerRes.rowCount) {
    if (sellerRes.rowCount > 1) throw new AuthTokenError("ambiguous_binding");
    const r = sellerRes.rows[0];
    bindings.push({ type: "seller", sub, token: verified, seller: { seller_id: String(r.seller_id), display_name: String(r.display_name || r.seller_id), auth_enabled: Boolean(r.auth_enabled), seller_status: String(r.seller_status) } });
  }
  if (adminRes.rowCount) {
    if (adminRes.rowCount > 1) throw new AuthTokenError("ambiguous_binding");
    const r = adminRes.rows[0];
    bindings.push({ type: "admin", sub, token: verified, admin: { admin_user_id: String(r.admin_user_id), email: String(r.email), role: String(r.role), status: String(r.status) } });
  }
  if (distRes.rowCount) {
    if (distRes.rowCount > 1) throw new AuthTokenError("ambiguous_binding");
    const r = distRes.rows[0];
    bindings.push({ type: "distributor", sub, token: verified, distributor: { affiliate_id: String(r.affiliate_id), auth_enabled: Boolean(r.auth_enabled), verification_status: String(r.verification_status) } });
  }

  // Cross-role uniqueness: a sub bound as more than one actor type is a security
  // error, not a reason to select the most privileged match.
  if (bindings.length > 1) throw new AuthTokenError("cross_role_binding");
  if (bindings.length === 0) throw new AuthTokenError("no_actor_binding");
  return bindings[0] as ResolvedActor;
}
