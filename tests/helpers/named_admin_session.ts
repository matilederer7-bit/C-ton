// Shared test helper: establish a NAMED admin session (cookie) for exercising
// admin mutation routes that (post-R5C) require a named identity rather than the
// shared bootstrap key. Not a test file itself (lives under tests/helpers, which
// the group runner does not enumerate).

export async function establishNamedAdminSession(
  app: any,
  pool: any,
  opts?: { role?: string; email?: string }
): Promise<{ cookie: string; email: string }> {
  const { hashAdminPassword } = await import("../../src/admin_identity.js");
  const email = opts?.email || `zzz-named-admin-${Date.now()}-${Math.random().toString(16).slice(2)}@siton.local`;
  const password = "NamedAdminPassword123!";
  const passwordHash = await hashAdminPassword(password);
  await pool.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
     VALUES ($1,$1,$2,'Active',$3,true,true)
     ON CONFLICT (email) DO UPDATE
       SET role=EXCLUDED.role, status='Active', password_hash=EXCLUDED.password_hash,
           mfa_required=true, mfa_enabled=true, updated_at=now()`,
    [email, opts?.role || "SuperAdmin", passwordHash]
  );
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`named admin login failed (${login.statusCode}): ${login.body}`);
  const body = login.json();
  let cookie = "";
  if (body.mfa_challenge_id) {
    const verify = await app.inject({
      method: "POST",
      url: "/api/admin/auth/mfa/verify",
      payload: { mfa_challenge_id: body.mfa_challenge_id, code: body.dev_code }
    });
    if (verify.statusCode !== 200) throw new Error(`named admin mfa failed (${verify.statusCode}): ${verify.body}`);
    cookie = String(verify.headers["set-cookie"] || "").split(";")[0] || "";
  } else {
    cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";
  }
  if (!/siton_admin_session=/.test(cookie)) throw new Error("named admin session cookie missing");
  return { cookie, email };
}
