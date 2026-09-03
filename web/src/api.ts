// Same-origin API client for the canonical Fastify service.
//
// ONE Supabase session (access + refresh token, see session.ts) may carry more
// than one capability; each surface sends the same access token and the SERVER
// decides authority per route (seller routes require the seller capability,
// admin routes the admin capability). The session refreshes itself via the
// supported GoTrue refresh grant, so a login stays usable for days on the same
// device without ever storing the password.
//
// Every error surfaced from here is Hebrew (see he.ts) — raw provider/backend
// text never reaches the user.

import { hebrewError } from "./he";
import { beginSession, ensureFreshSession, endSession, surfaceAccessToken, type AuthSessionPayload } from "./session";

export type Json = Record<string, any>;

export const getSellerToken = () => surfaceAccessToken("seller");
export const getAdminToken = () => surfaceAccessToken("admin");
// legacy setters kept for the few explicit-logout call sites
export const clearAuthSession = () => endSession();

function guestModeActive(): boolean {
  try { return localStorage.getItem("siton_guest_mode_v1") === "1"; } catch { return false; }
}

async function req(path: string, init: RequestInit = {}, auth: "none" | "seller" | "admin" = "none"): Promise<Json> {
  if (guestModeActive()) auth = "none";
  const buildHeaders = (): Record<string, string> => {
    // JSON content-type ONLY when a body is actually sent — Fastify rejects a
    // bodyless DELETE that declares application/json.
    const headers: Record<string, string> = {
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...(init.headers as any)
    };
    if (auth !== "none") {
      const t = auth === "seller" ? getSellerToken() : getAdminToken();
      if (t) headers["authorization"] = `Bearer ${t}`;
    }
    return headers;
  };
  if (auth !== "none") await ensureFreshSession();
  let res = await fetch(path, { ...init, headers: buildHeaders() });
  if (res.status === 401 && auth !== "none") {
    // access token may have just expired — one forced refresh, one retry
    const alive = await ensureFreshSession(true);
    if (alive) res = await fetch(path, { ...init, headers: buildHeaders() });
  }
  const text = await res.text();
  let body: Json = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const raw: any = { status: res.status, body, message: body?.message || body?.error };
    const err: any = new Error(hebrewError(raw));
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  // ── public ──────────────────────────────────────────────────────────────
  mall: (params: { type?: string; sort?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.type) q.set("type", params.type);
    q.set("sort", params.sort || "newest");
    return req(`/api/mall/deals?${q.toString()}`);
  },
  deal: (id: string) => req(`/api/deals/${id}/public`),
  activity: (id: string) => req(`/api/deals/${id}/activity`),
  chat: (id: string, visitorId = "") => req(`/api/deals/${id}/chat?limit=100${visitorId ? `&visitor_id=${encodeURIComponent(visitorId)}` : ""}`),
  chatPost: (id: string, payload: Json) => req(`/api/deals/${id}/chat`, { method: "POST", body: JSON.stringify(payload) }),
  chatReact: (id: string, messageId: string, payload: Json) =>
    req(`/api/deals/${id}/chat/${messageId}/reaction`, { method: "POST", body: JSON.stringify(payload) }),
  join: (id: string, payload: Json) =>
    req(`/api/deals/${id}/join`, { method: "POST", headers: { "idempotency-key": `preview-join-${id}-${crypto.randomUUID()}` }, body: JSON.stringify(payload) }),
  tracking: (participantId: string, token: string) =>
    req(`/api/participants/${participantId}/tracking`, { headers: { authorization: `Bearer ${token}` } }),
  impact: (participantId: string, token: string) =>
    req(`/api/participants/${participantId}/impact`, { headers: { authorization: `Bearer ${token}` } }),
  authConfig: (): Promise<{ ok: boolean; supabase_url: string; supabase_anon_key: string; configured: boolean }> =>
    req(`/api/preview/auth-config`) as any,
  supportContact: (payload: Json) =>
    req(`/api/support/contact`, { method: "POST", body: JSON.stringify(payload) }),
  previewMeta: () => req(`/api/preview/meta`),
  // P0.7 — internal buyer → seller inquiry (the DEAL determines the seller server-side)
  dealInquiry: (id: string, payload: Json) =>
    req(`/api/deals/${id}/inquiries`, { method: "POST", body: JSON.stringify(payload) }),
  inquiryThread: (threadId: string, token: string) =>
    req(`/api/inquiries/${threadId}?t=${encodeURIComponent(token)}`),
  inquiryFollowUp: (threadId: string, payload: Json) =>
    req(`/api/inquiries/${threadId}/messages`, { method: "POST", body: JSON.stringify(payload) }),

  // ── seller (Supabase Bearer, seller capability) ─────────────────────────
  sellerContext: () => req(`/api/seller/context`, {}, "seller"),
  sellerDeals: () => req(`/api/seller/deals`, {}, "seller"),
  sellerDeal: (id: string) => req(`/api/seller/deals/${id}`, {}, "seller"),
  sellerDraft: (id: string) => req(`/api/seller/deals/${id}/draft`, {}, "seller"),
  sellerAnalytics: (period = "all", dealId = "") =>
    req(`/api/seller/analytics?period=${encodeURIComponent(period)}${dealId ? `&deal_id=${encodeURIComponent(dealId)}` : ""}`, {}, "seller"),
  sellerDealViral: (id: string) => req(`/api/seller/deals/${id}/viral`, {}, "seller"),
  sellerDealViralTree: (id: string, params: { parent?: string; source?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.parent) q.set("parent", params.parent);
    if (params.source) q.set("source", params.source);
    if (params.limit) q.set("limit", String(params.limit));
    return req(`/api/seller/deals/${id}/viral-tree?${q.toString()}`, {}, "seller");
  },
  sellerDealPropagation: (id: string) => req(`/api/seller/deals/${id}/propagation`, {}, "seller"),
  // P0.7 — seller command center: customer inquiries (seller-scoped server-side)
  sellerInquiries: (scope: "open" | "all" = "open") => req(`/api/seller/inquiries?scope=${scope}`, {}, "seller"),
  sellerInquiry: (threadId: string) => req(`/api/seller/inquiries/${threadId}`, {}, "seller"),
  sellerInquiryReply: (threadId: string, payload: Json) =>
    req(`/api/seller/inquiries/${threadId}/reply`, { method: "POST", body: JSON.stringify(payload) }, "seller"),
  updateDealDelivery: (id: string, payload: Json) =>
    req(`/api/seller/deals/${id}/delivery`, { method: "PUT", body: JSON.stringify(payload) }, "seller"),
  createDeal: (payload: Json) =>
    req(`/api/deals`, { method: "POST", headers: { "idempotency-key": `preview-create-${crypto.randomUUID()}` }, body: JSON.stringify(payload) }, "seller"),
  updateDraft: (id: string, payload: Json) =>
    req(`/api/seller/deals/${id}/draft`, { method: "PATCH", body: JSON.stringify(payload) }, "seller"),
  duplicateDeal: (id: string) =>
    req(`/api/seller/deals/${id}/duplicate`, { method: "POST", headers: { "idempotency-key": `preview-dup-${crypto.randomUUID()}` }, body: JSON.stringify({}) }, "seller"),
  publishDeal: (id: string) =>
    req(`/api/deals/${id}/publish`, { method: "POST", body: JSON.stringify({ seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }) }, "seller"),
  closeJoining: (id: string) =>
    req(`/api/deals/${id}/close_joining`, { method: "POST", body: JSON.stringify({}) }, "seller"),
  reopenJoining: (id: string) =>
    req(`/api/deals/${id}/reopen_joining`, { method: "POST", body: JSON.stringify({}) }, "seller"),
  deleteDeal: (id: string) =>
    req(`/api/seller/deals/${id}`, { method: "DELETE" }, "seller"),
  sellerBusinessProfile: () => req(`/api/seller/business-profile`, {}, "seller"),
  saveSellerBusinessProfile: (payload: Json) =>
    req(`/api/seller/business-profile`, { method: "PUT", body: JSON.stringify(payload) }, "seller"),

  // ── admin (Supabase Bearer, admin capability — server-validated) ────────
  adminMe: () => req(`/api/admin/auth/me`, {}, "admin"),
  adminOverview: () => req(`/api/admin/r6/overview`, {}, "admin"),
  adminDeals: (params: { state?: string; q?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.state) q.set("state", params.state);
    if (params.q) q.set("q", params.q);
    return req(`/api/admin/r6/deals?${q.toString()}`, {}, "admin");
  },
  adminDealProfile: (id: string) => req(`/api/admin/deals/${id}/profile`, {}, "admin"),
  adminDealOps: (id: string) => req(`/api/admin/deals/${id}/ops-summary`, {}, "admin"),
  adminDealViral: (id: string) => req(`/api/admin/deals/${id}/viral`, {}, "admin"),
  adminSellers: () => req(`/api/admin/r6/sellers`, {}, "admin"),
  adminSellerDetail: (id: string) => req(`/api/admin/r6/sellers/${encodeURIComponent(id)}`, {}, "admin"),
  adminSellerViral: (id: string) => req(`/api/admin/sellers/${encodeURIComponent(id)}/viral`, {}, "admin"),
  adminBuyers: (q = "") => req(`/api/admin/r6/buyers?q=${encodeURIComponent(q)}`, {}, "admin"),
  adminGrowth: () => req(`/api/admin/growth`, {}, "admin"),
  adminSystemStatus: () => req(`/api/admin/system-status`, {}, "admin"),
  adminOutboxStatus: () => req(`/api/admin/outbox-status`, {}, "admin"),
  adminNotificationsStatus: () => req(`/api/admin/notifications-status`, {}, "admin"),
  adminPayoutStatus: () => req(`/api/admin/payout-status`, {}, "admin"),
  adminPaymentOps: () => req(`/api/admin/payment-ops-status`, {}, "admin"),
  adminDealViralTree: (id: string, params: { parent?: string; source?: string; depth?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.parent) q.set("parent", params.parent);
    if (params.source) q.set("source", params.source);
    if (params.depth) q.set("depth", String(params.depth));
    if (params.limit) q.set("limit", String(params.limit));
    return req(`/api/admin/deals/${id}/viral-tree?${q.toString()}`, {}, "admin");
  },
  adminDealPropagation: (id: string) => req(`/api/admin/deals/${id}/propagation`, {}, "admin"),
  adminSupportCases: () => req(`/api/admin/support-cases`, {}, "admin"),
  adminSupportCase: (id: string) => req(`/api/admin/support-cases/${id}`, {}, "admin"),
  adminSupportReply: (id: string, payload: Json) =>
    req(`/api/admin/support-cases/${id}/reply`, { method: "POST", body: JSON.stringify(payload) }, "admin"),
  adminSupportCaseUpdate: (id: string, payload: Json) =>
    req(`/api/admin/support-cases/${id}`, { method: "PATCH", body: JSON.stringify(payload) }, "admin"),
  adminMissionControl: () => req(`/api/admin/mission-control`, {}, "admin"),
  adminUserProfile: (buyerId: string) => req(`/api/admin/users/${encodeURIComponent(buyerId)}/profile`, {}, "admin"),
  adminAudit: (q = "") => req(`/api/admin/r6/audit?q=${encodeURIComponent(q)}`, {}, "admin"),
  adminViralRecompute: (dealId: string) =>
    req(`/api/admin/viral/recompute`, { method: "POST", body: JSON.stringify({ deal_id: dealId }) }, "admin")
};

// ── Supabase auth (password grant / signup / resend / recovery) ─────────────
export interface SupabaseCfg { supabase_url: string; supabase_anon_key: string }

function authRedirectTo(): string {
  return `${window.location.origin}/preview/`;
}

async function authPost(cfg: SupabaseCfg, path: string, payload: Json): Promise<{ res: Response; body: Json }> {
  const res = await fetch(`${cfg.supabase_url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.supabase_anon_key },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

// Sign-in returns the FULL session payload (access + refresh) and records it
// as the canonical client session for the requested surface.
export async function supabaseSignIn(cfg: SupabaseCfg, email: string, password: string, surface: "seller" | "admin"): Promise<string> {
  const { res, body } = await authPost(cfg, `/auth/v1/token?grant_type=password`, { email, password });
  if (!res.ok || !body?.access_token) {
    const msg = String(body?.error_description || body?.msg || body?.error || "");
    const err: any = new Error(hebrewError({ status: res.status, message: msg }, "התחברות נכשלה — נסו שוב"));
    err.status = res.status;
    throw err;
  }
  beginSession(body as AuthSessionPayload, surface);
  return String(body.access_token);
}

export interface SignUpResult {
  // "session"  — auto-confirmed, session started
  // "confirmation_requested" — a NEW account's confirmation request was accepted
  // "ambiguous" — Supabase deliberately answers repeated/existing signups
  //               ambiguously; the app must NOT claim an email was sent
  outcome: "session" | "confirmation_requested" | "ambiguous";
}

// First-time signup: the password is typed by its owner in the browser and
// goes ONLY to Supabase — it never touches the C-ton server.
export async function supabaseSignUp(cfg: SupabaseCfg, email: string, password: string, surface: "seller" | "admin"): Promise<SignUpResult> {
  const { res, body } = await authPost(cfg, `/auth/v1/signup`, {
    email, password,
    options: { email_redirect_to: authRedirectTo() },
    // GoTrue also accepts top-level redirect for older API shapes
    email_redirect_to: authRedirectTo()
  });
  if (!res.ok) {
    const msg = String(body?.error_description || body?.msg || body?.error || "");
    const err: any = new Error(hebrewError({ status: res.status, message: msg }, "הרשמה נכשלה — נסו שוב"));
    err.status = res.status;
    throw err;
  }
  if (body?.access_token) { beginSession(body as AuthSessionPayload, surface); return { outcome: "session" }; }
  // A brand-new signup returns identities for the new user; a REPEATED signup
  // for an existing confirmed account returns an obfuscated user with no
  // identities. Only claim a confirmation request when it is truthful.
  const identities = Array.isArray(body?.identities) ? body.identities : (Array.isArray(body?.user?.identities) ? body.user.identities : null);
  if (identities && identities.length > 0) return { outcome: "confirmation_requested" };
  return { outcome: "ambiguous" };
}

// Re-request the signup confirmation email (supported GoTrue resend flow).
export async function supabaseResendConfirmation(cfg: SupabaseCfg, email: string): Promise<void> {
  const { res, body } = await authPost(cfg, `/auth/v1/resend`, {
    type: "signup", email,
    options: { email_redirect_to: authRedirectTo() }
  });
  if (!res.ok) {
    const msg = String(body?.error_description || body?.msg || body?.error || "");
    throw new Error(hebrewError({ status: res.status, message: msg }, "שליחת בקשת האימות נכשלה — נסו שוב מאוחר יותר"));
  }
}

// Password recovery request.
export async function supabaseRecoverPassword(cfg: SupabaseCfg, email: string): Promise<void> {
  const { res, body } = await authPost(cfg, `/auth/v1/recover`, {
    email,
    options: { email_redirect_to: authRedirectTo() }
  });
  if (!res.ok) {
    const msg = String(body?.error_description || body?.msg || body?.error || "");
    throw new Error(hebrewError({ status: res.status, message: msg }, "בקשת איפוס הסיסמה נכשלה — נסו שוב מאוחר יותר"));
  }
}
