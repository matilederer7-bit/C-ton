// ADMIN TEAM PROVISIONING — security + behaviour proof (owner round 2026-09-28).
//
// A SuperAdmin adds an admin with a username + password from the admin UI.
// This suite drives the REAL route and the REAL Supabase token verification
// (ES256 tokens signed here, JWKS served over HTTP by this file) against the
// hosted-like runtime shape (APP_DEPLOYMENT_MODE=staging → bearer identities
// only). The same local server plays the admin-provisioner Edge Function, so
// every call the runtime makes toward Supabase Auth is observed.
//
// Proves: anonymous / signed-in non-admin / seller / OpsAdmin callers are
// refused BEFORE anything is created (no Auth call, no row) — including a
// regular user trying to make HIMSELF an admin through the API directly ·
// username format, explicit role and password policy are enforced server-side
// · a SuperAdmin creates an admin: Auth user via the provisioner (with the
// call key), admin_users row with the explicit role and NO password hash,
// audit row naming the actor · the password is in no table and no log line ·
// the new admin authenticates through Supabase (token → /api/admin/auth/me)
// and NOT through the legacy local-password login · usernames are unique
// (case-insensitive, and an Auth-level collision too) · a failed binding rolls
// the Auth user back · the audit rail is append-only · without the provisioner
// key the route answers 503 and creates nothing.

import { strict as assert } from "node:assert";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = `team-${randomUUID().slice(0, 8)}`;
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "ES256", use: "sig" };
const PROVISIONER_KEY = `team-provisioner-${randomUUID()}`;

type ProvisionerCall = { op: string; username?: string; password?: string; auth_user_id?: string; key: string };
const provisionerCalls: ProvisionerCall[] = [];
const authUsers = new Map<string, string>(); // email -> id
let forcedCreateId: string | null = null;

const server = createServer((req, res) => {
  const url = String(req.url || "");
  if (url.startsWith("/auth/v1/.well-known/jwks.json")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (url === "/functions/v1/admin-provisioner" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const key = String(req.headers["x-siton-provisioner-key"] || "");
      provisionerCalls.push({ ...body, key });
      res.setHeader("content-type", "application/json");
      if (key !== PROVISIONER_KEY) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, code: "provisioner_unauthorized" })); return; }
      const email = `${body.username}@admins.siton.invalid`;
      if (body.op === "create") {
        if (authUsers.has(email)) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, code: "username_taken" })); return; }
        const id = forcedCreateId || randomUUID();
        forcedCreateId = null;
        authUsers.set(email, id);
        res.end(JSON.stringify({ ok: true, op: "create", auth_user_id: id }));
        return;
      }
      if (body.op === "rollback") {
        const found = authUsers.get(email) === body.auth_user_id;
        if (found) authUsers.delete(email);
        res.end(JSON.stringify({ ok: true, op: "rollback", found }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, code: "unsupported_op" }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const SUPABASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;

// every byte the runtime logs is captured, to prove no password is ever logged
const captured: string[] = [];
for (const stream of [process.stdout, process.stderr] as any[]) {
  const original = stream.write.bind(stream);
  stream.write = (chunk: any, ...rest: any[]) => { captured.push(String(chunk)); return original(chunk, ...rest); };
}

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_JWT_AUD = "authenticated";
process.env.APP_DEPLOYMENT_MODE = "staging";
process.env.APP_ENV = "production";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.ADMIN_API_KEY = `team-admin-${randomUUID()}`;
process.env.SITON_OWNER_EMAIL = "owner-team-test@example.com";
process.env.SITON_ADMIN_PROVISIONER_KEY = PROVISIONER_KEY;

const { app } = await import("../src/app.js");
await app.ready();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message || e}`); failed++; }
}

const b64u = (value: Buffer | string) => Buffer.from(value).toString("base64url");
function mint(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: KID };
  const payload = { iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600, session_id: randomUUID(), ...claims };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = createSign("SHA256").update(input).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(signature)}`;
}
const bearer = (token: string) => (token ? { authorization: `Bearer ${token}` } : {});
const tag = randomUUID().slice(0, 6);
const SUPER = { sub: randomUUID(), email: `team-super-${tag}@example.com` };
const OPS = { sub: randomUUID(), email: `team-ops-${tag}@example.com` };
const SELLER = { sub: randomUUID(), email: `team-seller-${tag}@example.com` };
const PLAIN = { sub: randomUUID(), email: `team-plain-${tag}@example.com` };
const tokens = {
  super: mint({ sub: SUPER.sub, email: SUPER.email }),
  ops: mint({ sub: OPS.sub, email: OPS.email }),
  seller: mint({ sub: SELLER.sub, email: SELLER.email }),
  plain: mint({ sub: PLAIN.sub, email: PLAIN.email })
};
await pool.query(
  `INSERT INTO siton.admin_users (email, display_name, role, status, auth_user_id, mfa_required, provisioned_via, provisioned_at)
   VALUES ($1,'Team Super','SuperAdmin','Active',$2,false,'test_seed',now()), ($3,'Team Ops','OpsAdmin','Active',$4,false,'test_seed',now())`,
  [SUPER.email, SUPER.sub, OPS.email, OPS.sub]
);
await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, login_email, support_email, verification_status, settlement_status, auth_enabled, auth_user_id)
   VALUES ($1,'Team Seller','עסק צוות',$2,$2,'approved','active',true,$3)`,
  [`team-seller-${tag}`, SELLER.email, SELLER.sub]
);

const PASSWORD = `Str0ng-Adm1n-${tag}-pass`;
const username = `ops.${tag}`;
const create = (token: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/admin/team/admins", headers: bearer(token), payload: body });
const adminRows = async (name: string) =>
  (await pool.query(`SELECT * FROM siton.admin_users WHERE lower(username)=lower($1) OR email=$2`, [name, `${name.toLowerCase()}@admins.siton.invalid`])).rows;
const createCalls = () => provisionerCalls.filter((c) => c.op === "create").length;

try {
  await run("anonymous caller is refused (401) — no Auth call, no row", async () => {
    const before = createCalls();
    const res = await create("", { username, password: PASSWORD, role: "SuperAdmin" });
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(createCalls(), before);
    assert.equal((await adminRows(username)).length, 0);
  });

  await run("a signed-in regular user cannot make HIMSELF an admin through the API directly", async () => {
    const before = createCalls();
    for (const body of [
      { username: `self-${tag}`, password: PASSWORD, role: "SuperAdmin" },
      { username: `self-${tag}`, password: PASSWORD, role: "SuperAdmin", auth_user_id: PLAIN.sub, email: PLAIN.email }
    ]) {
      const res = await create(tokens.plain, body);
      assert.ok([401, 403].includes(res.statusCode), `${res.statusCode} ${res.body}`);
    }
    const list = await app.inject({ method: "GET", url: "/api/admin/team/admins", headers: bearer(tokens.plain) });
    assert.ok([401, 403].includes(list.statusCode), list.body);
    assert.equal(createCalls(), before);
    assert.equal((await pool.query(`SELECT 1 FROM siton.admin_users WHERE auth_user_id=$1`, [PLAIN.sub])).rowCount, 0);
    const me = await app.inject({ method: "GET", url: "/api/admin/auth/me", headers: bearer(tokens.plain) });
    assert.ok([401, 403].includes(me.statusCode), me.body);
  });

  await run("a seller token holds no admin authority here (refused, nothing created)", async () => {
    const before = createCalls();
    const res = await create(tokens.seller, { username: `seller-${tag}`, password: PASSWORD, role: "OpsAdmin" });
    assert.ok([401, 403].includes(res.statusCode), `${res.statusCode} ${res.body}`);
    assert.equal(createCalls(), before);
    assert.equal((await pool.query(`SELECT 1 FROM siton.admin_users WHERE auth_user_id=$1`, [SELLER.sub])).rowCount, 0);
  });

  await run("an OpsAdmin (no admin_users.manage) is refused with 403 — only a SuperAdmin manages the team", async () => {
    const before = createCalls();
    const res = await create(tokens.ops, { username: `byops-${tag}`, password: PASSWORD, role: "OpsAdmin" });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal((res.json() as any).error, "ADMIN_PERMISSION_DENIED");
    const list = await app.inject({ method: "GET", url: "/api/admin/team/admins", headers: bearer(tokens.ops) });
    assert.equal(list.statusCode, 403, list.body);
    assert.equal(createCalls(), before);
  });

  await run("username format, explicit role and password policy are enforced server-side (no Auth call)", async () => {
    const before = createCalls();
    const cases: [Record<string, unknown>, string][] = [
      [{ username: "a", password: PASSWORD, role: "OpsAdmin" }, "admin_username_invalid"],
      [{ username: "bad name!", password: PASSWORD, role: "OpsAdmin" }, "admin_username_invalid"],
      [{ username: "1starts-with-digit", password: PASSWORD, role: "OpsAdmin" }, "admin_username_invalid"],
      [{ username, password: PASSWORD }, "admin_role_required"],
      [{ username, password: PASSWORD, role: "Owner" }, "admin_role_required"],
      [{ username, password: "Short1a", role: "OpsAdmin" }, "admin_password_weak"],
      [{ username, password: "abcdefghijklmnop", role: "OpsAdmin" }, "admin_password_weak"],
      [{ username, password: "111111111111a", role: "OpsAdmin" }, "admin_password_weak"],
      [{ username, password: ` ${PASSWORD}`, role: "OpsAdmin" }, "admin_password_weak"],
      [{ username, password: `x1${username}xyz9`, role: "OpsAdmin" }, "admin_password_weak"]
    ];
    for (const [body, error] of cases) {
      const res = await create(tokens.super, body);
      assert.equal(res.statusCode, 400, `${JSON.stringify(body)} → ${res.body}`);
      assert.equal((res.json() as any).error, error, JSON.stringify(body));
    }
    assert.equal(createCalls(), before);
  });

  let created: any;
  await run("a SuperAdmin creates an admin: Auth user server-side, explicit role, no password hash, audit row", async () => {
    const before = createCalls();
    const res = await create(tokens.super, { username: username.toUpperCase(), password: PASSWORD, role: "OpsAdmin", display_name: "מנהלת תפעול" });
    assert.equal(res.statusCode, 200, res.body);
    created = (res.json() as any).admin;
    assert.equal(created.username, username);
    assert.equal(created.role, "OpsAdmin");
    assert.equal(JSON.stringify(res.json()).includes(PASSWORD), false, "the response never echoes the password");
    assert.equal(createCalls(), before + 1);
    const call = provisionerCalls.filter((c) => c.op === "create").at(-1)!;
    assert.equal(call.key, PROVISIONER_KEY, "the runtime authenticates to the provisioner");
    assert.equal(call.username, username);
    assert.equal(call.password, PASSWORD);
    const [row] = await adminRows(username);
    assert.ok(row);
    assert.equal(row.email, `${username}@admins.siton.invalid`);
    assert.equal(row.role, "OpsAdmin");
    assert.equal(row.status, "Active");
    assert.equal(row.password_hash, null);
    assert.equal(row.provisioned_via, "admin_team_create");
    assert.equal(String(row.auth_user_id), authUsers.get(`${username}@admins.siton.invalid`));
    const audit = await pool.query(`SELECT * FROM siton.admin_user_audit WHERE target_admin_user_id=$1`, [row.admin_user_id]);
    assert.equal(audit.rowCount, 1);
    const superRow = (await pool.query(`SELECT admin_user_id FROM siton.admin_users WHERE auth_user_id=$1`, [SUPER.sub])).rows[0];
    assert.equal(audit.rows[0].actor_admin_user_id, superRow.admin_user_id);
    assert.equal(audit.rows[0].event_type, "admin.created");
    assert.equal(audit.rows[0].target_role, "OpsAdmin");
  });

  await run("the password is stored in NO siton table and appears in NO log line", async () => {
    const tables = await pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='siton' AND c.relkind='r'`
    );
    for (const { relname } of tables.rows) {
      const hit = await pool.query(`SELECT 1 FROM siton.${relname} t WHERE row_to_json(t)::text LIKE $1 LIMIT 1`, [`%${PASSWORD}%`]);
      assert.equal(hit.rowCount, 0, `password found in siton.${relname}`);
    }
    assert.equal(captured.some((line) => line.includes(PASSWORD)), false, "password found in the runtime log output");
  });

  await run("the new admin authenticates through Supabase Auth (token → admin identity with the explicit role)", async () => {
    const authUserId = authUsers.get(`${username}@admins.siton.invalid`)!;
    const token = mint({ sub: authUserId, email: `${username}@admins.siton.invalid` });
    const me = await app.inject({ method: "GET", url: "/api/admin/auth/me", headers: bearer(token) });
    assert.equal(me.statusCode, 200, me.body);
    assert.match(me.body, /OpsAdmin/);
    // an OpsAdmin it is: it cannot manage the team itself
    const res = await create(token, { username: `next-${tag}`, password: PASSWORD, role: "SuperAdmin" });
    assert.equal(res.statusCode, 403, res.body);
  });

  await run("no parallel password system: the legacy local-password login refuses the new admin", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email: `${username}@admins.siton.invalid`, password: PASSWORD } });
    assert.equal(res.statusCode, 401, res.body);
  });

  await run("usernames are unique (case-insensitive) — a repeat is 409 before any Auth call", async () => {
    const before = createCalls();
    const res = await create(tokens.super, { username: username.toUpperCase(), password: `${PASSWORD}-2`, role: "ReadOnlyAdmin" });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as any).error, "admin_username_taken");
    assert.equal(createCalls(), before);
    assert.equal((await adminRows(username)).length, 1);
  });

  await run("an Auth-level collision (account already exists in Supabase) is 409 and creates no row", async () => {
    const other = `taken-${tag}`;
    authUsers.set(`${other}@admins.siton.invalid`, randomUUID());
    const res = await create(tokens.super, { username: other, password: PASSWORD, role: "SupportAdmin" });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((await adminRows(other)).length, 0);
  });

  await run("a binding that fails after the Auth user exists rolls the Auth user back", async () => {
    const other = `rollback-${tag}`;
    forcedCreateId = SUPER.sub; // already bound to the SuperAdmin → unique violation on bind
    const res = await create(tokens.super, { username: other, password: PASSWORD, role: "SupportAdmin" });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((await adminRows(other)).length, 0);
    const rollback = provisionerCalls.filter((c) => c.op === "rollback").at(-1);
    assert.ok(rollback, "rollback was requested");
    assert.equal(rollback!.username, other);
    assert.equal(rollback!.auth_user_id, SUPER.sub);
    assert.equal(authUsers.has(`${other}@admins.siton.invalid`), false);
  });

  await run("the admin-team audit rail is append-only", async () => {
    await assert.rejects(pool.query(`UPDATE siton.admin_user_audit SET target_role='SuperAdmin' WHERE target_username=$1`, [username]), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM siton.admin_user_audit WHERE target_username=$1`, [username]), /append-only/);
  });

  await run("the SuperAdmin team list shows the new admin by username (never the synthetic e-mail)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/team/admins", headers: bearer(tokens.super) });
    assert.equal(res.statusCode, 200, res.body);
    const entry = (res.json() as any).admins.find((a: any) => a.username === username);
    assert.ok(entry);
    assert.equal(entry.email, null);
    assert.equal(entry.role, "OpsAdmin");
    assert.equal(res.body.includes(PASSWORD), false);
  });

  await run("without the provisioner key the route answers 503 and creates nothing", async () => {
    const saved = process.env.SITON_ADMIN_PROVISIONER_KEY;
    delete process.env.SITON_ADMIN_PROVISIONER_KEY;
    try {
      const other = `nokey-${tag}`;
      const res = await create(tokens.super, { username: other, password: PASSWORD, role: "SupportAdmin" });
      assert.equal(res.statusCode, 503, res.body);
      assert.equal((res.json() as any).error, "admin_provisioning_unavailable");
      assert.equal((await adminRows(other)).length, 0);
    } finally {
      process.env.SITON_ADMIN_PROVISIONER_KEY = saved;
    }
  });
} finally {
  await app.close();
  await pool.end();
  server.close();
}

console.log(`\nADMIN_TEAM_PROVISIONING ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
