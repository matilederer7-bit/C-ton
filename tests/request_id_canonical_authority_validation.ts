// ONE REQUEST ID — normalised once, at creation, and the same everywhere after.
//
// Independent review MEDIUM-2: V7 made Fastify read `x-request-id` for the log
// line while the audit path normalised the same header through safeHeaderId.
// For a well-formed id they matched. For `abc` or a 3000-character value the log
// carried the raw caller string and the audit row carried a freshly minted
// `req:<uuid>`, so exactly the hostile traffic an incident needs to trace could
// not be joined — and a caller could put up to the header limit of bytes into
// every log line of their request.
//
// Property pinned here, A/B on the same route:
//
//   response header  ==  log reqId  ==  audit_log.request_id
//
// for a well-formed id (preserved verbatim), a short id, an oversized id, an id
// with whitespace, and no header at all (generated). The audit row is written by
// a real state transition (deal cancel), not by a fixture.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3142";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-reqid";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-reqid";
process.env.ADMIN_API_KEY = "reqid-admin-key";

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const pinoModule: any = await import("pino");
const streamSym: symbol = pinoModule.symbols?.streamSym ?? pinoModule.default?.symbols?.streamSym;
assert.ok(streamSym, "pino stream symbol unavailable");
async function captureOutput(fn: () => Promise<void>) {
  const logger = (app as any).log;
  const original = logger[streamSym];
  const chunks: string[] = [];
  logger[streamSym] = { write(chunk: any) { chunks.push(String(chunk)); return true; }, flushSync() {}, end() {} };
  try { await fn(); } finally { logger[streamSym] = original; }
  return chunks.join("");
}

const CANONICAL = /^[A-Za-z0-9._:-]{8,160}$/;

// Fixture: a seller who can cancel a draft (an audit-writing transition).
const SELLER = `seller-reqid-${randomUUID().slice(0, 8)}`;
const SELLER_EMAIL = `${SELLER}@siton.test`;
const SELLER_CODE = "RequestIdPass123!";
const { cookie: adminCookie } = await establishNamedAdminSession(app, pool);
assert.equal(
  (await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${SELLER}/provision`,
    headers: { cookie: adminCookie },
    payload: { display_name: SELLER, login_email: SELLER_EMAIL, access_code: SELLER_CODE, auth_enabled: true }
  } as any)).statusCode,
  200,
  "seller provisioning failed"
);
const login = await app.inject({ method: "POST", url: "/api/seller/session/login", payload: { identifier: SELLER_EMAIL, access_code: SELLER_CODE } } as any);
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";

async function draft() {
  const result = await pool.query(
    `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
     VALUES ($1,50,1,20,5,$2,$3,'Draft') RETURNING deal_id`,
    [`Reqid ${randomUUID().slice(0, 8)}`, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), SELLER]
  );
  return String(result.rows[0].deal_id);
}

type Case = { label: string; header: string | null; expectPreserved: boolean };
const CASES: Case[] = [
  { label: "well-formed uuid", header: randomUUID(), expectPreserved: true },
  { label: "short", header: "abc", expectPreserved: false },
  { label: "oversized", header: "x".repeat(3000), expectPreserved: false },
  { label: "whitespace", header: "not a safe id", expectPreserved: false },
  { label: "control characters", header: "id\u0001with\u0002controls", expectPreserved: false },
  { label: "absent", header: null, expectPreserved: false }
];

for (const testCase of CASES) {
  await run(`response header, log reqId and audit request_id agree for a ${testCase.label} request id`, async () => {
    const dealId = await draft();
    const headers: Record<string, string> = { cookie, "content-type": "application/json" };
    if (testCase.header !== null) headers["x-request-id"] = testCase.header;
    let response: any;
    const logs = await captureOutput(async () => {
      response = await app.inject({ method: "POST", url: `/deals/${dealId}/cancel`, headers, payload: { reason: "request id probe" } } as any);
    });
    assert.equal(response.statusCode, 200, `cancel failed: ${response.body}`);

    const echoed = String(response.headers["x-request-id"] || "");
    assert.match(echoed, CANONICAL, `response x-request-id is not canonical: ${JSON.stringify(echoed.slice(0, 60))}`);
    if (testCase.expectPreserved) assert.equal(echoed, testCase.header, "a well-formed caller id must be preserved verbatim");
    else if (testCase.header !== null) assert.notEqual(echoed, testCase.header, "a hostile caller id must be replaced, not echoed");

    const logIds = [...new Set([...logs.matchAll(/"reqId":"([^"]*)"/g)].map((match) => match[1]!))];
    assert.equal(logIds.length, 1, `expected exactly one request id in the log for this request, saw ${JSON.stringify(logIds.map((id) => id.slice(0, 40)))}`);
    assert.equal(logIds[0], echoed, "the log carries a different id than the response");
    if (testCase.header !== null && !testCase.expectPreserved) {
      // A leaked hostile value reaches a pino line as a complete JSON string
      // value (the reqId, an echoed header, an error message) - so that is the
      // form to look for. A bare substring test is wrong for a SHORT value such
      // as "abc": any hex identifier in the captured lines (the minted request
      // id, the deal id in the url) can contain it by chance, which made this
      // proof fail intermittently on CI while the header was correctly replaced.
      // Long values keep a prefix substring check so a TRUNCATED leak of an
      // oversized header is still caught (a 64-character run cannot collide).
      const leakedAsValue = logs.includes(JSON.stringify(testCase.header)) || logs.includes(`"reqId":"${testCase.header}`);
      const leakedTruncated = testCase.header.length >= 64 && logs.includes(testCase.header.slice(0, 64));
      assert.ok(!leakedAsValue && !leakedTruncated, "the raw hostile header value reached the log");
    }

    const audit = await pool.query(`SELECT request_id FROM siton.audit_log WHERE deal_id=$1 AND action_name='deal.cancel' LIMIT 1`, [dealId]);
    assert.equal(audit.rowCount, 1, "the cancel wrote no audit row - the correlation claim cannot be tested");
    assert.equal(String(audit.rows[0].request_id), echoed, `audit request_id (${String(audit.rows[0].request_id).slice(0, 40)}) differs from the log/response id`);
  });
}

// Regression for the intermittent CI failure of the "short" case: the hostile
// value "abc" is also a substring of ordinary hex identifiers. When the deal id
// in the logged url happens to contain it, a bare substring check reports a
// leak that never happened. Force that coincidence and require the proof to
// still distinguish "the header was replaced" from "a hex id contains abc".
await run("a short hostile id that is also a substring of an unrelated identifier in the log is still recognised as replaced (no false positive)", async () => {
  const forcedDealId = `0abc0000-0000-4000-8000-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
     VALUES ($1,$2,50,1,20,5,$3,$4,'Draft')`,
    [forcedDealId, `Reqid forced ${randomUUID().slice(0, 8)}`, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), SELLER]
  );
  let response: any;
  const logs = await captureOutput(async () => {
    response = await app.inject({ method: "POST", url: `/deals/${forcedDealId}/cancel`, headers: { cookie, "content-type": "application/json", "x-request-id": "abc" }, payload: { reason: "request id probe" } } as any);
  });
  assert.equal(response.statusCode, 200, `cancel failed: ${response.body}`);
  const echoed = String(response.headers["x-request-id"] || "");
  assert.match(echoed, CANONICAL);
  assert.notEqual(echoed, "abc", "a hostile caller id must be replaced, not echoed");
  assert.ok(logs.includes(forcedDealId), "the forced deal id must appear in the captured log for this regression to mean anything");
  assert.ok(logs.includes("abc"), "VACUOUS: the log does not even contain the token as a substring - the coincidence was not forced");
  assert.ok(!logs.includes(JSON.stringify("abc")) && !logs.includes('"reqId":"abc'), "the raw hostile header value reached the log as a value");
});

await run("a CR/LF in the request id cannot forge a log line", async () => {
  // Node refuses raw CR/LF in header values on the wire; inject bypasses the
  // parser, which makes this the harder case: the value reaches the app as-is.
  const logs = await captureOutput(async () => {
    await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": 'x"\r\n{"level":30,"msg":"forged"}\r\n' } } as any);
  });
  assert.ok(!logs.includes('"msg":"forged"\n') && !/^\{"level":30,"msg":"forged"\}/m.test(logs), "a forged log line was injected through the request id");
  const ids = [...logs.matchAll(/"reqId":"([^"]*)"/g)].map((match) => match[1]!);
  assert.ok(ids.length > 0 && ids.every((id) => CANONICAL.test(id)), `non-canonical id in the log: ${JSON.stringify(ids)}`);
});

await run("an internal fault is logged under the same canonical id as its request", async () => {
  // The error handler must log through the request-scoped logger; a root-logger
  // line has no reqId and cannot be joined to anything. A deterministic fault is
  // armed at the transaction boundary so the route really does fail with 500.
  const { armTestFault } = await import("../src/fault_injection.js");
  const requestId = randomUUID();
  armTestFault("db.before_begin", { kind: "throw", code: "REQID_PROBE_FAULT" }, 1);
  let response: any;
  const logs = await captureOutput(async () => {
    response = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { "x-request-id": requestId, cookie } } as any);
  });
  assert.equal(response.statusCode, 500, `the armed fault did not produce a 500: ${response.statusCode} ${response.body}`);
  const errorLines = logs.split("\n").filter((line) => line.includes('"level":50'));
  assert.ok(errorLines.length > 0, "the fault was not logged at error level");
  const orphanErrorLines = errorLines.filter((line) => !line.includes(`"reqId":"${requestId}"`));
  assert.deepEqual(orphanErrorLines.map((line) => line.slice(0, 120)), [], "an error line was written without the canonical request id");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
