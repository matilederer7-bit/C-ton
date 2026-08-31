// Same-origin API client for the canonical Fastify service.
//
// One Supabase Auth identity (password grant → access token) may carry more
// than one capability; each surface sends the token and the SERVER decides
// authority per route (seller routes require the seller capability, admin
// routes the admin capability). Tokens are kept per-surface so logging out of
// one surface never silently logs out another.

export type Json = Record<string, any>;

const SELLER_TOKEN_KEY = "siton_preview_seller_token";
const ADMIN_TOKEN_KEY = "siton_preview_admin_token";

function readKey(key: string): string {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
function writeKey(key: string, value: string) {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* noop */ }
}

export const getSellerToken = () => readKey(SELLER_TOKEN_KEY);
export const setSellerToken = (t: string) => writeKey(SELLER_TOKEN_KEY, t);
export const getAdminToken = () => readKey(ADMIN_TOKEN_KEY);
export const setAdminToken = (t: string) => writeKey(ADMIN_TOKEN_KEY, t);

async function req(path: string, init: RequestInit = {}, auth: "none" | "seller" | "admin" = "none"): Promise<Json> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any) };
  if (auth !== "none") {
    const t = auth === "seller" ? getSellerToken() : getAdminToken();
    if (t) headers["authorization"] = `Bearer ${t}`;
  }
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: Json = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err: any = new Error(body?.message || body?.error || `בקשה נכשלה (${res.status})`);
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
  chat: (id: string) => req(`/api/deals/${id}/chat?limit=50`),
  chatPost: (id: string, payload: Json) => req(`/api/deals/${id}/chat`, { method: "POST", body: JSON.stringify(payload) }),
  join: (id: string, payload: Json) =>
    req(`/api/deals/${id}/join`, { method: "POST", headers: { "idempotency-key": `preview-join-${id}-${crypto.randomUUID()}` }, body: JSON.stringify(payload) }),
  tracking: (participantId: string, token: string) =>
    req(`/api/participants/${participantId}/tracking`, { headers: { authorization: `Bearer ${token}` } }),
  impact: (participantId: string, token: string) =>
    req(`/api/participants/${participantId}/impact`, { headers: { authorization: `Bearer ${token}` } }),
  authConfig: (): Promise<{ ok: boolean; supabase_url: string; supabase_anon_key: string; configured: boolean }> =>
    req(`/api/preview/auth-config`) as any,

  // ── seller (Supabase Bearer, seller capability) ─────────────────────────
  sellerContext: () => req(`/api/seller/context`, {}, "seller"),
  sellerDeals: () => req(`/api/seller/deals`, {}, "seller"),
  sellerDeal: (id: string) => req(`/api/seller/deals/${id}`, {}, "seller"),
  sellerDraft: (id: string) => req(`/api/seller/deals/${id}/draft`, {}, "seller"),
  sellerAnalytics: () => req(`/api/seller/analytics`, {}, "seller"),
  sellerDealViral: (id: string) => req(`/api/seller/deals/${id}/viral`, {}, "seller"),
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
  adminSupportCases: () => req(`/api/admin/support-cases`, {}, "admin"),
  adminMissionControl: () => req(`/api/admin/mission-control`, {}, "admin"),
  adminUserProfile: (buyerId: string) => req(`/api/admin/users/${encodeURIComponent(buyerId)}/profile`, {}, "admin"),
  adminAudit: (q = "") => req(`/api/admin/r6/audit?q=${encodeURIComponent(q)}`, {}, "admin"),
  adminViralRecompute: (dealId: string) =>
    req(`/api/admin/viral/recompute`, { method: "POST", body: JSON.stringify({ deal_id: dealId }) }, "admin")
};

// ── Supabase auth (password grant / signup, public anon key) ──────────────
export interface SupabaseCfg { supabase_url: string; supabase_anon_key: string }

export async function supabaseSignIn(cfg: SupabaseCfg, email: string, password: string): Promise<string> {
  const res = await fetch(`${cfg.supabase_url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.supabase_anon_key },
    body: JSON.stringify({ email, password })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.access_token) {
    const msg = String(body?.error_description || body?.msg || "");
    const err: any = new Error(
      /not confirmed/i.test(msg) ? "המייל טרם אומת — בדקו את תיבת הדואר ולחצו על קישור האימות"
      : /invalid/i.test(msg) ? "אימייל או סיסמה שגויים"
      : msg || "התחברות נכשלה"
    );
    err.status = res.status;
    throw err;
  }
  return String(body.access_token);
}

// First-time owner/seller signup: the password is typed by its owner in the
// browser and goes ONLY to Supabase — it never touches the Siton server.
export async function supabaseSignUp(cfg: SupabaseCfg, email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const res = await fetch(`${cfg.supabase_url}/auth/v1/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.supabase_anon_key },
    body: JSON.stringify({ email, password })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(body?.error_description || body?.msg || "");
    const err: any = new Error(/already registered/i.test(msg) ? "החשבון כבר קיים — נסו להתחבר" : msg || "הרשמה נכשלה");
    err.status = res.status;
    throw err;
  }
  return { needsConfirmation: !body?.access_token };
}
