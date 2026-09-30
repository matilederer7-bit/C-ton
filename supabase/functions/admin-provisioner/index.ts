// Siton admin provisioner — the ONLY path that creates a Supabase Auth user
// for a new admin (owner round 2026-09-28: "add an admin with a username and a
// password from the admin UI").
//
// Security model (mirrors storage-broker):
// - Deployed with verify_jwt disabled; every request must carry the
//   x-siton-provisioner-key header. Only its SHA-256 digest lives here; the
//   plaintext key exists solely in the Render Web environment, so browsers and
//   Supabase clients can never reach this function's privileged operations.
// - The service-role key never leaves this function's runtime (injected by
//   the platform as SUPABASE_SERVICE_ROLE_KEY, never echoed).
// - WHO may create an admin is decided by the Fastify route
//   (POST /api/admin/team/admins: a named SuperAdmin identity, permission
//   admin_users.manage). This function only performs the Auth Admin API call,
//   and is confined to the synthetic admin login domain: it can create — or
//   roll back — ONLY users whose e-mail is <username>@admins.siton.invalid, so
//   even a leaked key can neither touch an existing customer account nor mint
//   an account that could receive mail.
// - The password is passed straight to auth.admin.createUser; it is never
//   logged, stored or returned. Supabase Auth keeps only its bcrypt hash.
// - A created user carries no privilege by itself: admin authority comes only
//   from a siton.admin_users row bound to its id, written by the Fastify route
//   in the same transaction as the audit row.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const PROVISIONER_KEY_SHA256 = "0f49854a04c6b828ec251773395fca90ba2046c43b7857d904e97b3cf80dbea2";
const ADMIN_LOGIN_DOMAIN = "admins.siton.invalid";
const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } }
);

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, code: string) => json(status, { ok: false, code });

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function loginEmail(raw: unknown): string | null {
  const username = String(raw ?? "").trim();
  return USERNAME_RE.test(username) ? `${username}@${ADMIN_LOGIN_DOMAIN}` : null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  const providedKey = req.headers.get("x-siton-provisioner-key") ?? "";
  if (!providedKey || !timingSafeEqualHex(await sha256Hex(providedKey), PROVISIONER_KEY_SHA256)) {
    return fail(401, "provisioner_unauthorized");
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }
  const op = String(body.op ?? "");
  try {
    if (op === "create") {
      const email = loginEmail(body.username);
      if (!email) return fail(400, "invalid_username");
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 12 || password.length > 128) return fail(400, "weak_password");
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { siton_admin_provisioned: true }
      });
      if (error || !data?.user?.id) {
        const message = String(error?.message ?? "");
        const code = String((error as { code?: string } | null)?.code ?? "");
        if (code === "email_exists" || /already been registered|already exists/i.test(message)) return fail(409, "username_taken");
        if (code === "weak_password" || /password/i.test(message)) return fail(400, "weak_password");
        return fail(503, "auth_create_failed");
      }
      return json(200, { ok: true, op, auth_user_id: data.user.id });
    }

    if (op === "rollback") {
      // Compensation when the Fastify transaction that binds the admin row
      // fails after the Auth user was created. Only a provisioner-created user
      // on the admin domain, never any other account.
      const id = String(body.auth_user_id ?? "").toLowerCase();
      const email = loginEmail(body.username);
      if (!UUID_RE.test(id) || !email) return fail(400, "invalid_rollback_target");
      const { data, error } = await supabase.auth.admin.getUserById(id);
      if (error || !data?.user) return json(200, { ok: true, op, found: false });
      if (String(data.user.email ?? "").toLowerCase() !== email || data.user.app_metadata?.siton_admin_provisioned !== true) {
        return fail(403, "rollback_target_mismatch");
      }
      const removed = await supabase.auth.admin.deleteUser(id);
      if (removed.error) return fail(503, "auth_rollback_failed");
      return json(200, { ok: true, op, found: true });
    }

    return fail(400, "unsupported_op");
  } catch {
    // never echo error details: they could carry request fragments
    return fail(503, "provisioner_error");
  }
});
