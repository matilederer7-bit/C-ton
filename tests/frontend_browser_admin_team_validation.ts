// ── ADMIN TEAM, IN A REAL BROWSER (owner round 2026-09-28) ──────────────────
//
// Drives the REAL server and the REAL React bundle over CDP, end to end:
//   1. a SuperAdmin passes the admin password step (Supabase password grant),
//      opens "צוות מנהלים" and creates an admin with a USERNAME + password;
//   2. the admin_users row carries the explicit role and no password hash, and
//      an audit row names the SuperAdmin;
//   3. the SuperAdmin signs out; the NEW admin signs in by typing only the
//      username (the login maps it to the synthetic Auth e-mail) and reaches the
//      admin area — as an OpsAdmin, whom the server refuses the team screen;
//   4. the team screen renders without horizontal overflow on a phone.
//
// One local HTTP server plays Supabase: the JWKS the runtime verifies tokens
// against, GoTrue's password grant the browser calls, and the admin-provisioner
// Edge Function the runtime calls. The password grant accepts ONLY the
// credentials the provisioner actually received, so step 3 proves that the
// password set in the UI is the one that signs the new admin in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromiumPath, launchPage, type BrowserPage } from "./helpers/browser_cdp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const port = 3398;
const baseUrl = `http://127.0.0.1:${port}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

// ── the fake Supabase (JWKS + GoTrue password grant + admin-provisioner) ───
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = `team-e2e-${randomUUID().slice(0, 8)}`;
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "ES256", use: "sig" };
const PROVISIONER_KEY = `team-e2e-provisioner-${randomUUID()}`;
const credentials = new Map<string, { password: string; sub: string }>(); // email -> credential
let supabaseUrl = "";
const b64u = (value: Buffer | string) => Buffer.from(value).toString("base64url");
function mint(sub: string, email: string, aal: "aal1" | "aal2" = "aal1"): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600, session_id: randomUUID(), sub, email, aal };
  const input = `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(createSign("SHA256").update(input).sign({ key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
}
const grantEmails: string[] = [];
// Supabase TOTP MFA, as GoTrue answers it: factors per user, a challenge, and a
// verify that returns an AAL2 session. The fake accepts only the code 123456.
const MFA_CODE = "123456";
const emailBySub = new Map<string, string>();
const factorsBySub = new Map<string, { id: string; factor_type: string; status: string }[]>();
const mfaCalls: string[] = [];
const bearerSub = (auth: unknown) => {
  const token = String(auth || "").replace(/^Bearer\s+/i, "");
  try { return String(JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString()).sub || ""); } catch { return ""; }
};
const supabase = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "apikey, content-type, authorization, x-client-info");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  const url = String(req.url || "");
  if (url.startsWith("/auth/v1/.well-known/jwks.json")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const body = raw ? JSON.parse(raw) : {};
    if (url.startsWith("/auth/v1/token") && req.method === "POST") {
      const email = String(body.email || "").toLowerCase();
      grantEmails.push(email);
      const cred = credentials.get(email);
      if (!cred || cred.password !== body.password) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
        return;
      }
      emailBySub.set(cred.sub, email);
      res.end(JSON.stringify({ access_token: mint(cred.sub, email), refresh_token: randomUUID(), expires_in: 3600, token_type: "bearer", user: { id: cred.sub, email } }));
      return;
    }
    const sub = bearerSub(req.headers.authorization);
    if (url === "/auth/v1/user" && req.method === "GET" && sub) {
      res.end(JSON.stringify({ id: sub, email: emailBySub.get(sub), factors: factorsBySub.get(sub) || [] }));
      return;
    }
    if (url === "/auth/v1/factors" && req.method === "POST" && sub) {
      mfaCalls.push("enroll");
      const factor = { id: randomUUID(), factor_type: "totp", status: "unverified" };
      factorsBySub.set(sub, [...(factorsBySub.get(sub) || []), factor]);
      res.end(JSON.stringify({ id: factor.id, type: "totp", totp: { qr_code: "", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/Siton:admin?secret=JBSWY3DPEHPK3PXP&issuer=Siton" } }));
      return;
    }
    const unenroll = url.match(/^\/auth\/v1\/factors\/([0-9a-f-]{36})$/);
    if (unenroll && req.method === "DELETE" && sub) {
      const list = factorsBySub.get(sub) || [];
      const factor = list.find((f) => f.id === unenroll[1]);
      if (!factor) { res.statusCode = 404; res.end(JSON.stringify({ code: "mfa_factor_not_found" })); return; }
      mfaCalls.push("delete");
      factorsBySub.set(sub, list.filter((f) => f.id !== factor.id));
      res.end(JSON.stringify({ id: factor.id }));
      return;
    }
    const factorOp = url.match(/^\/auth\/v1\/factors\/([0-9a-f-]{36})\/(challenge|verify)$/);
    if (factorOp && req.method === "POST" && sub) {
      const factor = (factorsBySub.get(sub) || []).find((f) => f.id === factorOp[1]);
      if (!factor) { res.statusCode = 404; res.end(JSON.stringify({ code: "mfa_factor_not_found" })); return; }
      if (factorOp[2] === "challenge") { mfaCalls.push("challenge"); res.end(JSON.stringify({ id: randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 300 })); return; }
      mfaCalls.push(`verify:${body.code}`);
      if (String(body.code) !== MFA_CODE) { res.statusCode = 422; res.end(JSON.stringify({ code: "mfa_verification_failed", msg: "Invalid TOTP code entered" })); return; }
      factor.status = "verified";
      const email = emailBySub.get(sub) || "";
      res.end(JSON.stringify({ access_token: mint(sub, email, "aal2"), refresh_token: randomUUID(), expires_in: 3600, token_type: "bearer", user: { id: sub, email } }));
      return;
    }
    if (url === "/functions/v1/admin-provisioner" && req.method === "POST") {
      if (req.headers["x-siton-provisioner-key"] !== PROVISIONER_KEY) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, code: "provisioner_unauthorized" })); return; }
      const email = `${body.username}@admins.siton.invalid`;
      if (body.op === "create") {
        if (credentials.has(email)) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, code: "username_taken" })); return; }
        const sub = randomUUID();
        credentials.set(email, { password: String(body.password), sub });
        res.end(JSON.stringify({ ok: true, op: "create", auth_user_id: sub }));
        return;
      }
      res.end(JSON.stringify({ ok: true, op: body.op, found: false }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((resolve) => supabase.listen(0, "127.0.0.1", () => resolve()));
supabaseUrl = `http://127.0.0.1:${(supabase.address() as any).port}`;

// ── page helpers (React-controlled inputs need the native setter) ──────────
const SET_VALUE = `(sel, value) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error('missing ' + sel);
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
}`;
async function set(page: BrowserPage, selector: string, value: string) {
  await page.evaluate(`(${SET_VALUE})(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
  await wait(60);
}
async function click(page: BrowserPage, selector: string) {
  await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing'); el.click(); return true; })()`);
  await wait(250);
}
async function waitFor(page: BrowserPage, expression: string, label: string, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    await wait(150);
  }
  const text = await page.evaluate<string>(`(document.querySelector('main') || document.body).innerText.slice(0, 400)`);
  throw new Error(`timed out waiting for ${label}; page: ${text}`);
}
async function passStepUp(page: BrowserPage, identifier: string, password: string) {
  await page.goto(`${baseUrl}/preview/#/admin`, { waitMs: 800 });
  await waitFor(page, `document.querySelector('[data-testid="stepup-email"]')`, "admin password step");
  await set(page, '[data-testid="stepup-email"]', identifier);
  await set(page, '[data-testid="stepup-password"]', password);
  await click(page, '[data-testid="stepup-submit"]');
  await waitFor(page, `document.querySelector('.admin-shell')`, "admin area after the password step");
}
const thirdPartyNoise = (text: string) => /fonts\.googleapis|fonts\.gstatic|Stylesheet|ERR_CERT_AUTHORITY_INVALID/i.test(text);

if (!chromiumPath()) {
  if (process.env.CI) throw new Error("no Chromium available — the admin team browser gate cannot be skipped in CI");
  console.log("ADMIN_TEAM_BROWSER SKIP — no Chromium available in this environment");
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 2 });
  const tag = randomUUID().slice(0, 6);
  const SUPER = { sub: randomUUID(), email: `team-e2e-super-${tag}@example.com`, password: `Sup3r-Owner-${tag}-pw` };
  credentials.set(SUPER.email, { password: SUPER.password, sub: SUPER.sub });
  await pool.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, auth_user_id, mfa_required, provisioned_via, provisioned_at)
     VALUES ($1,'E2E Super','SuperAdmin','Active',$2,false,'test_seed',now())`,
    [SUPER.email, SUPER.sub]
  );
  const server = spawn(process.execPath, [compiledAppPath], {
    cwd: repoRoot,
    env: {
      ...process.env, PORT: String(port), HOST: "127.0.0.1", DISABLE_OUTBOX_WORKER: "1", APP_DEPLOYMENT_MODE: "staging",
      SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: "e2e-publishable-anon-key", SUPABASE_JWT_AUD: "authenticated",
      SITON_ADMIN_PROVISIONER_KEY: PROVISIONER_KEY, SITON_OWNER_EMAIL: `owner-e2e-${tag}@example.com`,
      ADMIN_API_KEY: `e2e-admin-${randomUUID()}`, RATE_LIMIT_MAX: "5000", RATE_LIMIT_SENSITIVE_MAX: "500"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => { serverLog += String(chunk); });
  server.stderr.on("data", (chunk) => { serverLog += String(chunk); });
  let page: BrowserPage | null = null;
  const username = `ops.e2e${tag.replace(/[^a-z0-9]/g, "")}`.slice(0, 32);
  const NEW_PASSWORD = `N3w-Admin-${tag}-pass`;
  try {
    for (let i = 0; i < 80; i += 1) {
      try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch { /* booting */ }
      if (i === 79) throw new Error(`server did not become healthy:\n${serverLog.slice(-2000)}`);
      await wait(500);
    }
    page = await launchPage(`${baseUrl}/preview/`);
    await page.setViewport({ width: 1440, height: 900 });

    await run("a SuperAdmin passes the password step and opens the admin team screen", async () => {
      await passStepUp(page!, SUPER.email, SUPER.password);
      await page!.goto(`${baseUrl}/preview/#/admin/team`, { waitMs: 600 });
      await waitFor(page!, `document.querySelector('[data-testid="admin-team-form"]') && document.querySelector('[data-testid="admin-team-list"]')`, "team form + list");
      const listed = await page!.evaluate<string>(`document.querySelector('[data-testid="admin-team-list"]').innerText`);
      assert.match(listed, new RegExp(SUPER.email.replace(/[.+]/g, "\\$&")));
    });

    await run("the form refuses a weak password and mismatched confirmation client-side (nothing sent)", async () => {
      await set(page!, '[data-testid="admin-team-username"]', username);
      await set(page!, '[data-testid="admin-team-role"]', "OpsAdmin");
      await set(page!, '[data-testid="admin-team-password"]', "short1");
      await set(page!, '[data-testid="admin-team-password-confirm"]', "short1");
      await click(page!, '[data-testid="admin-team-submit"]');
      await waitFor(page!, `document.querySelector('[data-testid="admin-team-error"]')`, "weak password error");
      await set(page!, '[data-testid="admin-team-password"]', NEW_PASSWORD);
      await set(page!, '[data-testid="admin-team-password-confirm"]', `${NEW_PASSWORD}x`);
      await click(page!, '[data-testid="admin-team-submit"]');
      await waitFor(page!, `/אינן זהות|do not match/.test((document.querySelector('[data-testid="admin-team-error"]') || {}).textContent || '')`, "mismatch error");
      assert.equal(credentials.has(`${username}@admins.siton.invalid`), false, "no Auth user was created");
    });

    await run("the SuperAdmin creates an admin with a username + password; it appears in the list", async () => {
      await set(page!, '[data-testid="admin-team-display-name"]', "מנהל בדיקה");
      await set(page!, '[data-testid="admin-team-password"]', NEW_PASSWORD);
      await set(page!, '[data-testid="admin-team-password-confirm"]', NEW_PASSWORD);
      await click(page!, '[data-testid="admin-team-submit"]');
      // password-only session → the server demands a recent second factor;
      // first use enrolls an authenticator (setup key shown), a wrong code is refused
      await waitFor(page!, `document.querySelector('[data-testid="admin-mfa"]') && document.querySelector('[data-testid="admin-mfa-secret"]')`, "MFA enrollment step");
      assert.equal(credentials.has(`${username}@admins.siton.invalid`), false, "nothing was created before the second factor");
      assert.equal(await page!.evaluate<string>(`document.querySelector('[data-testid="admin-mfa-secret"]').textContent`), "JBSWY3DPEHPK3PXP");
      // cancel the half-done enrollment, then submit again: the abandoned
      // unverified factor is deleted before a fresh one is enrolled
      await click(page!, '[data-testid="admin-mfa"] button[type="button"]');
      await waitFor(page!, `!document.querySelector('[data-testid="admin-mfa"]')`, "MFA step closed on cancel");
      assert.deepEqual(mfaCalls, ["enroll"]);
      await set(page!, '[data-testid="admin-team-password"]', NEW_PASSWORD);
      await set(page!, '[data-testid="admin-team-password-confirm"]', NEW_PASSWORD);
      await click(page!, '[data-testid="admin-team-submit"]');
      await waitFor(page!, `document.querySelector('[data-testid="admin-mfa"]') && document.querySelector('[data-testid="admin-mfa-secret"]')`, "MFA enrollment step after retry");
      assert.deepEqual(mfaCalls, ["enroll", "delete", "enroll"]);
      assert.equal(factorsBySub.get(SUPER.sub)?.length, 1, "only the fresh unverified factor remains");
      await set(page!, '[data-testid="admin-mfa-code"]', "000000");
      await click(page!, '[data-testid="admin-mfa-submit"]');
      await waitFor(page!, `document.querySelector('[data-testid="admin-mfa-error"]')`, "wrong-code error");
      assert.equal(credentials.has(`${username}@admins.siton.invalid`), false, "a wrong code creates nothing");
      await set(page!, '[data-testid="admin-mfa-code"]', MFA_CODE);
      await click(page!, '[data-testid="admin-mfa-submit"]');
      await waitFor(page!, `(document.querySelector('[data-testid="admin-team-list"]') || {}).innerText?.includes(${JSON.stringify(username)})`, "new admin in the list after the second factor");
      assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('[data-testid="admin-mfa"]')`), false, "the MFA step closes after success");
      assert.deepEqual(mfaCalls, ["enroll", "delete", "enroll", "challenge", "verify:000000", "challenge", `verify:${MFA_CODE}`]);
      const fields = await page!.evaluate<{ pw: string; confirm: string; error: boolean }>(`({ pw: document.querySelector('[data-testid="admin-team-password"]').value, confirm: document.querySelector('[data-testid="admin-team-password-confirm"]').value, error: !!document.querySelector('[data-testid="admin-team-error"]') })`);
      assert.deepEqual(fields, { pw: "", confirm: "", error: false }, "the password is cleared from the form after success");
    });

    await run("database: explicit role, no password hash, audit row naming the SuperAdmin", async () => {
      const row = (await pool.query(`SELECT * FROM siton.admin_users WHERE username=$1`, [username])).rows[0];
      assert.ok(row);
      assert.equal(row.role, "OpsAdmin");
      assert.equal(row.password_hash, null);
      assert.equal(row.display_name, "מנהל בדיקה");
      assert.equal(String(row.auth_user_id), credentials.get(`${username}@admins.siton.invalid`)!.sub);
      const audit = await pool.query(
        `SELECT a.* FROM siton.admin_user_audit a JOIN siton.admin_users s ON s.admin_user_id=a.actor_admin_user_id
         WHERE a.target_admin_user_id=$1 AND s.auth_user_id=$2`, [row.admin_user_id, SUPER.sub]);
      assert.equal(audit.rowCount, 1);
      assert.equal(serverLog.includes(NEW_PASSWORD), false, "the password never reaches the server log");
    });

    await run("the new admin signs in by USERNAME only and reaches the admin area as OpsAdmin (team screen refused)", async () => {
      await click(page!, '[data-testid="admin-sign-out"]');
      await wait(1200);
      await passStepUp(page!, username.toUpperCase(), NEW_PASSWORD);
      assert.equal(grantEmails.at(-1), `${username}@admins.siton.invalid`, "the username was mapped to the synthetic Auth e-mail");
      await page!.goto(`${baseUrl}/preview/#/admin/team`, { waitMs: 600 });
      await waitFor(page!, `document.querySelector('[data-testid="admin-team-denied"]')`, "only-super-admin notice");
      assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('[data-testid="admin-team-form"]')`), false);
    });

    await run("a wrong password for the username is refused", async () => {
      await click(page!, '[data-testid="admin-sign-out"]');
      await wait(1200);
      await page!.goto(`${baseUrl}/preview/#/admin`, { waitMs: 800 });
      await waitFor(page!, `document.querySelector('[data-testid="stepup-email"]')`, "admin password step");
      await set(page!, '[data-testid="stepup-email"]', username);
      await set(page!, '[data-testid="stepup-password"]', `${NEW_PASSWORD}-wrong`);
      await click(page!, '[data-testid="stepup-submit"]');
      await waitFor(page!, `document.querySelector('[data-testid="stepup-error"]')`, "login error");
      assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('.admin-shell')`), false);
    });

    await run("phone width: the team screen has no horizontal overflow", async () => {
      await page!.setViewport({ width: 390, height: 844 });
      await passStepUp(page!, SUPER.email, SUPER.password);
      await page!.goto(`${baseUrl}/preview/#/admin/team`, { waitMs: 600 });
      await waitFor(page!, `document.querySelector('[data-testid="admin-team-form"]')`, "team form on a phone");
      const overflow = await page!.evaluate<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
    });

    await run("no page errors along the way", async () => {
      const errors = page!.errors().filter((e) => !thirdPartyNoise(e.text) && !/401|403|400/.test(e.text) && !/^422 .*\/auth\/v1\/factors\/[0-9a-f-]{36}\/verify$/.test(e.text) /* the deliberate wrong MFA code */);
      assert.deepEqual(errors, []);
    });
    console.log("ADMIN_TEAM_BROWSER_PASS");
  } finally {
    await page?.close().catch(() => undefined);
    server.kill("SIGTERM");
    supabase.close();
    await pool.end();
  }
}
