// Admin team provisioning (owner round 2026-09-28): an existing SuperAdmin
// adds another admin from the admin UI with a USERNAME and a password.
//
// Identity stays inside the project's existing Supabase Auth — no parallel
// password system:
//   * the username maps to a synthetic, undeliverable Auth e-mail
//     <username>@admins.siton.invalid, so the admin signs in through the very
//     same Supabase password grant as every other admin (the login screen maps
//     a bare username to that address);
//   * the Auth user is created SERVER-SIDE ONLY, by the admin-provisioner Edge
//     Function through the Auth Admin API. The service-role key lives only in
//     that function; this runtime holds just the provisioner call key
//     (SITON_ADMIN_PROVISIONER_KEY), which never reaches a browser;
//   * the password travels request → this process → the Edge Function →
//     Supabase Auth (which stores only its hash). It is never written to a
//     table, a log line, an audit row or a response.
// Authority is canonical Postgres: the new admin is an admin only through the
// siton.admin_users row (explicit role) bound to the created Auth user id,
// written together with its audit row by the SuperAdmin-only route.

export const ADMIN_LOGIN_DOMAIN = "admins.siton.invalid";
export const ADMIN_USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;
export const ADMIN_PASSWORD_MIN = 12;
export const ADMIN_PASSWORD_MAX = 128;
export const ADMIN_TEAM_ROLES = ["SuperAdmin", "OpsAdmin", "SupportAdmin", "ReadOnlyAdmin"] as const;
export type AdminTeamRole = typeof ADMIN_TEAM_ROLES[number];

export function normalizeAdminUsername(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return ADMIN_USERNAME_RE.test(value) ? value : null;
}

export function adminLoginEmailForUsername(username: string): string {
  return `${username}@${ADMIN_LOGIN_DOMAIN}`;
}

// A reasonable policy, checked here before anything leaves the process (the
// Edge Function and Supabase Auth re-check length on their side).
export function adminPasswordProblem(password: unknown, username: string): string | null {
  if (typeof password !== "string") return "password_required";
  if (password.length < ADMIN_PASSWORD_MIN) return "password_too_short";
  if (password.length > ADMIN_PASSWORD_MAX) return "password_too_long";
  if (password.trim() !== password) return "password_edge_whitespace";
  if (!/[A-Za-z֐-׿]/.test(password) || !/[0-9]/.test(password)) return "password_needs_letter_and_digit";
  if (new Set(password).size < 5) return "password_too_repetitive";
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "password_contains_username";
  return null;
}

export function isAdminTeamRole(value: unknown): value is AdminTeamRole {
  return (ADMIN_TEAM_ROLES as readonly string[]).includes(String(value ?? ""));
}

export interface AdminProvisionerConfig { url: string; key: string; timeoutMs: number }

export function adminProvisionerConfig(env: NodeJS.ProcessEnv = process.env): AdminProvisionerConfig | null {
  const key = String(env.SITON_ADMIN_PROVISIONER_KEY || "").trim();
  const supabaseUrl = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const url = String(env.SITON_ADMIN_PROVISIONER_URL || "").trim() || (supabaseUrl ? `${supabaseUrl}/functions/v1/admin-provisioner` : "");
  if (!key || !url || /^(placeholder|changeme|test|example|dummy|xxx|ci-placeholder)/i.test(key)) return null;
  return { url, key, timeoutMs: Math.max(1000, Number(env.SITON_ADMIN_PROVISIONER_TIMEOUT_MS || 15000)) };
}

export type ProvisionerResult =
  | { ok: true; auth_user_id: string }
  | { ok: false; code: string; status: number };

async function callProvisioner(cfg: AdminProvisionerConfig, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-siton-provisioner-key": cfg.key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export async function provisionAdminAuthUser(cfg: AdminProvisionerConfig, username: string, password: string): Promise<ProvisionerResult> {
  try {
    const { status, body } = await callProvisioner(cfg, { op: "create", username, password });
    const id = String(body?.auth_user_id || "").toLowerCase();
    if (status === 200 && body?.ok === true && /^[0-9a-f-]{36}$/.test(id)) return { ok: true, auth_user_id: id };
    return { ok: false, code: String(body?.code || "auth_create_failed"), status };
  } catch {
    return { ok: false, code: "provisioner_unreachable", status: 503 };
  }
}

export async function rollbackAdminAuthUser(cfg: AdminProvisionerConfig, username: string, authUserId: string): Promise<boolean> {
  try {
    const { status, body } = await callProvisioner(cfg, { op: "rollback", username, auth_user_id: authUserId });
    return status === 200 && body?.ok === true;
  } catch {
    return false;
  }
}
