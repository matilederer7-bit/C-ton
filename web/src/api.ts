// Same-origin API client for the canonical Fastify service. Seller auth uses
// Supabase Auth (password grant) → access token → Authorization: Bearer.

export type Json = Record<string, any>;

const TOKEN_KEY = "siton_preview_seller_token";

export function getSellerToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setSellerToken(token: string) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

async function req(path: string, init: RequestInit = {}, auth = false): Promise<Json> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any) };
  if (auth) {
    const t = getSellerToken();
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
  mall: (params: { type?: string; sort?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.type) q.set("type", params.type);
    q.set("sort", params.sort || "newest");
    return req(`/api/mall/deals?${q.toString()}`);
  },
  deal: (id: string) => req(`/api/deals/${id}/public`),
  join: (id: string, payload: Json) =>
    req(`/api/deals/${id}/join`, { method: "POST", headers: { "idempotency-key": `preview-join-${id}-${crypto.randomUUID()}` }, body: JSON.stringify(payload) }),
  // Seller (Supabase Bearer)
  sellerContext: () => req(`/api/seller/context`, {}, true),
  sellerDeals: () => req(`/api/seller/deals`, {}, true),
  createDeal: (payload: Json) =>
    req(`/api/deals`, { method: "POST", headers: { "idempotency-key": `preview-create-${crypto.randomUUID()}` }, body: JSON.stringify(payload) }, true),
  publishDeal: (id: string) =>
    req(`/api/deals/${id}/publish`, { method: "POST", body: JSON.stringify({ seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }) }, true),
  authConfig: (): Promise<{ ok: boolean; supabase_url: string; supabase_anon_key: string; configured: boolean }> =>
    req(`/api/preview/auth-config`) as any
};

// Supabase password sign-in (public anon key + password grant). Returns the
// access token used as the seller Bearer.
export async function supabaseSignIn(cfg: { supabase_url: string; supabase_anon_key: string }, email: string, password: string): Promise<string> {
  const res = await fetch(`${cfg.supabase_url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.supabase_anon_key },
    body: JSON.stringify({ email, password })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.access_token) {
    const err: any = new Error(body?.error_description || body?.msg || "התחברות נכשלה");
    err.status = res.status;
    throw err;
  }
  return String(body.access_token);
}
