// ── Canonical client session ────────────────────────────────────────────────
// ONE Supabase session (access + refresh token) powers every surface. The
// supported GoTrue refresh-token grant keeps the login usable for days on the
// same device WITHOUT storing the password, faking expiry, or weakening
// server validation — every privileged route still validates the (fresh)
// access token and the canonical capability bindings on each request.
//
// surfaces: which experiences this session may expose client-side (the server
// re-authorizes independently; these flags only gate which token getters
// return the access token).

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  surfaces: { seller: boolean; admin: boolean };
}

const SESSION_KEY = "siton_session_v1";
// legacy per-surface access-token keys (pre-P0.2) — read once for migration,
// then retired; they held only a 1-hour access token with no refresh.
const LEGACY_SELLER_KEY = "siton_preview_seller_token";
const LEGACY_ADMIN_KEY = "siton_preview_admin_token";
const GUEST_KEY = "siton_guest_mode_v1";

function guestModeActive(): boolean {
  try { return localStorage.getItem(GUEST_KEY) === "1"; } catch { return false; }
}

export function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.access_token !== "string" || typeof s.refresh_token !== "string") return null;
    return {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: Number(s.expires_at || 0),
      surfaces: { seller: Boolean(s.surfaces?.seller), admin: Boolean(s.surfaces?.admin) }
    };
  } catch { return null; }
}

function writeSession(s: StoredSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* noop */ }
}

export interface AuthSessionPayload {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
}

export function beginSession(payload: AuthSessionPayload, surface: "seller" | "admin"): void {
  const prev = readSession();
  const expiresAt = Number(payload.expires_at || 0) ||
    Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600);
  writeSession({
    access_token: String(payload.access_token || ""),
    refresh_token: String(payload.refresh_token || ""),
    expires_at: expiresAt,
    surfaces: {
      seller: surface === "seller" || Boolean(prev?.surfaces.seller),
      admin: surface === "admin" || Boolean(prev?.surfaces.admin)
    }
  });
  // retire legacy single-token keys
  try { localStorage.removeItem(LEGACY_SELLER_KEY); localStorage.removeItem(LEGACY_ADMIN_KEY); } catch { /* noop */ }
}

export function grantSurface(surface: "seller" | "admin"): void {
  const s = readSession();
  if (!s) return;
  s.surfaces[surface] = true;
  writeSession(s);
}

// The server denied this surface outright (capability missing) — stop exposing
// it client-side without ending the whole session (the other surface may still
// be perfectly valid).
export function revokeSurface(surface: "seller" | "admin"): void {
  const s = readSession();
  if (!s) return;
  s.surfaces[surface] = false;
  writeSession(s);
}

export function endSession(): void {
  writeSession(null);
  try { localStorage.removeItem(LEGACY_SELLER_KEY); localStorage.removeItem(LEGACY_ADMIN_KEY); } catch { /* noop */ }
}

// Access token for a surface. Guest mode strictly returns "" (privileges are
// only ever REMOVED by guest mode). Falls back to a legacy key once so a
// pre-P0.2 login keeps working until it naturally expires.
export function surfaceAccessToken(surface: "seller" | "admin"): string {
  if (guestModeActive()) return "";
  const s = readSession();
  if (s && s.surfaces[surface] && s.access_token) return s.access_token;
  try { return localStorage.getItem(surface === "seller" ? LEGACY_SELLER_KEY : LEGACY_ADMIN_KEY) || ""; } catch { return ""; }
}

// ── refresh ─────────────────────────────────────────────────────────────────
let cachedAuthCfg: { supabase_url: string; supabase_anon_key: string } | null = null;
async function authCfg(): Promise<{ supabase_url: string; supabase_anon_key: string } | null> {
  if (cachedAuthCfg) return cachedAuthCfg;
  try {
    const res = await fetch("/api/preview/auth-config");
    const body = await res.json();
    if (body?.configured) cachedAuthCfg = { supabase_url: body.supabase_url, supabase_anon_key: body.supabase_anon_key };
    return cachedAuthCfg;
  } catch { return null; }
}

let refreshInFlight: Promise<boolean> | null = null;

// Refresh when the access token is near (or past) expiry. force=true refreshes
// regardless (used after a 401). Single-flight. Returns true when a usable
// session remains afterwards.
export async function ensureFreshSession(force = false): Promise<boolean> {
  const s = readSession();
  if (!s || !s.refresh_token) return Boolean(s?.access_token);
  const secondsLeft = s.expires_at - Math.floor(Date.now() / 1000);
  if (!force && secondsLeft > 300) return true;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const cfg = await authCfg();
        if (!cfg) return true; // cannot refresh now; keep current token
        const res = await fetch(`${cfg.supabase_url}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { "content-type": "application/json", apikey: cfg.supabase_anon_key },
          body: JSON.stringify({ refresh_token: s.refresh_token })
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body?.access_token) {
          const cur = readSession();
          writeSession({
            access_token: String(body.access_token),
            refresh_token: String(body.refresh_token || s.refresh_token),
            expires_at: Number(body.expires_at || 0) || Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600),
            surfaces: cur?.surfaces || s.surfaces
          });
          return true;
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          // refresh token revoked/invalid — the session is genuinely over
          endSession();
          return false;
        }
        return true; // transient (network/5xx): keep the session, retry later
      } catch { return true; }
      finally { /* released below */ }
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// Keep the session silently fresh while the app is open.
export function startSessionHeartbeat(): void {
  void ensureFreshSession();
  try { setInterval(() => { void ensureFreshSession(); }, 4 * 60_000); } catch { /* noop */ }
}
