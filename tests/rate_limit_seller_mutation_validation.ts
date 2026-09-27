// Black-Sky C4 (owner decision C) — seller mutations have their OWN budget,
// keyed by the authenticated seller identity first and by IP second.
//
// Proves, through the live onRequest hook with the DEFAULT budgets:
//   * a legitimate intensive editing burst by one seller (well above the
//     heaviest real suite and any human click cadence) never sees a 429;
//   * abuse by one seller is refused at the per-identity ceiling while a
//     second seller on the SAME IP keeps working (identity isolation);
//   * rotating identities from one IP is bounded by the per-IP ceiling;
//   * buyer join, OTP, admin auth and payment paths keep their own budgets.
import { strict as assert } from "node:assert";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = "3149";
delete process.env.RATE_LIMIT_MAX;
delete process.env.RATE_LIMIT_SENSITIVE_MAX;
delete process.env.RATE_LIMIT_SELLER_MUTATION_MAX;
delete process.env.RATE_LIMIT_SELLER_MUTATION_IP_MAX;
process.env.RATE_LIMIT_WINDOW_MS = "600000"; // one window for the whole file

const { app, rateLimitBucketFor, rateLimitBucketForRequest, sellerMutationIdentityKey } = await import("../src/app.js");

const SELLER_BUDGET = 90;
const IP_BUDGET = 150;
const SENSITIVE_BUDGET = 20;
const DEAL = "00000000-0000-4000-8000-000000000001";

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.message}`); failed++; }
}

// A draft edit on a deal that does not exist: the limiter counts BEFORE the
// handler, so 404 = admitted, 429 = refused, with no rows written.
async function draftEdit(sellerId: string | null, ip: string) {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${DEAL}/draft`,
    headers: { "x-forwarded-for": ip, "content-type": "application/json", ...(sellerId ? { "x-seller-id": sellerId } : {}) },
    payload: { title: "edit" }
  });
  return res.statusCode;
}

async function codes(n: number, sellerId: string | null, ip: string) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await draftEdit(sellerId, ip));
  return out;
}

await run("classifier: seller create/edit/publish (bare and /api alias) land in seller_mutation; join, OTP, admin, payments do not", async () => {
  assert.equal(rateLimitBucketFor("POST", "/deals"), "seller_mutation");
  assert.equal(rateLimitBucketFor("PATCH", `/api/seller/deals/${DEAL}/draft`), "seller_mutation");
  assert.equal(rateLimitBucketFor("POST", `/api/seller/deals/${DEAL}/images`), "seller_mutation");
  for (const action of ["publish", "close_joining", "reopen_joining", "prepare_charging", "charging/start", "cancel"]) {
    assert.equal(rateLimitBucketFor("POST", `/deals/${DEAL}/${action}`), "seller_mutation", action);
    assert.equal(rateLimitBucketFor("POST", `/api/deals/${DEAL}/${action}`), "seller_mutation", `alias ${action}`);
    assert.equal(rateLimitBucketForRequest("POST", `/api/deals/${DEAL}/${action}`, `/deals/${DEAL}/${action}`), "seller_mutation");
  }
  assert.equal(rateLimitBucketFor("GET", `/api/seller/deals/${DEAL}`), "none", "seller reads are not mutations");
  // Never weakened:
  assert.equal(rateLimitBucketFor("POST", `/deals/${DEAL}/join`), "join");
  assert.equal(rateLimitBucketFor("POST", `/api/deals/${DEAL}/join`), "join");
  assert.equal(rateLimitBucketFor("POST", "/api/otp/request"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/admin/auth/login"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/payments/authorize"), "join");
  assert.equal(rateLimitBucketFor("POST", "/api/payments/status"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/seller/session/login"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", `/api/deals/${DEAL}/chat`), "sensitive", "public deal writes stay tight");
});

await run("identity key: bearer, session cookie and demo header are distinct signals; none -> null", async () => {
  const c1 = sellerMutationIdentityKey({ cookie: "siton_seller_session=tok-a" }, false);
  const c2 = sellerMutationIdentityKey({ cookie: "siton_seller_session=tok-b" }, false);
  assert.ok(c1 && c2 && c1 !== c2 && c1.startsWith("c:"));
  assert.ok(String(sellerMutationIdentityKey({ authorization: "Bearer x.y.z" }, false)).startsWith("b:"));
  assert.equal(sellerMutationIdentityKey({ "x-seller-id": "s-1" }, true), "id:s-1");
  assert.equal(sellerMutationIdentityKey({ "x-seller-id": "s-1" }, false), null, "outside demo-preview the header is not an identity");
  assert.equal(sellerMutationIdentityKey({}, false), null, "no cookie, bearer or demo context: no identity");
  assert.equal(sellerMutationIdentityKey({}, true), "id:seller-default", "demo preview always acts as a seller");
});

await run(`legitimate burst: one seller makes ${SELLER_BUDGET} edits in one window with ZERO 429 (default budget)`, async () => {
  const got = await codes(SELLER_BUDGET, "seller-legit", "203.0.113.10");
  assert.equal(got.filter((c) => c === 429).length, 0, JSON.stringify(got.filter((c) => c !== 404)));
  assert.ok(got.every((c) => c === 404), "vacuity: every admitted request reached the handler (404 for the fixture deal)");
});

await run("abuse: the same seller's next edit is refused (429) while a second seller on the SAME IP keeps working", async () => {
  assert.equal(await draftEdit("seller-legit", "203.0.113.10"), 429);
  assert.equal(await draftEdit("seller-legit", "198.51.100.77"), 429, "rotating the IP does not reset the per-seller budget");
  assert.equal(await draftEdit("seller-other", "203.0.113.10"), 404, "an unrelated seller on the same IP is not punished");
});

await run(`IP ceiling: rotating seller identities from ONE IP is refused after ${IP_BUDGET} seller mutations`, async () => {
  const ip = "203.0.113.20";
  let admitted = 0;
  let first429 = -1;
  for (let i = 0; i < IP_BUDGET + 5; i++) {
    // 40 per identity: each stays under its own 90 budget, so only the IP ceiling can refuse.
    const code = await draftEdit(`rotating-${Math.floor(i / 40)}`, ip);
    if (code === 429) { if (first429 < 0) first429 = i; }
    else admitted++;
  }
  assert.equal(admitted, IP_BUDGET, `admitted ${admitted}, first 429 at index ${first429}`);
  assert.equal(first429, IP_BUDGET);
});

await run("buyer join budget is untouched by seller traffic on the same IP", async () => {
  const ip = "203.0.113.10"; // seller-legit exhausted its budget here
  const res = await app.inject({ method: "POST", url: `/deals/${DEAL}/join`, headers: { "x-forwarded-for": ip, "content-type": "application/json" }, payload: {} });
  assert.notEqual(res.statusCode, 429, `join must not share the seller bucket, got ${res.statusCode}`);
});

await app.close();

// Production-shaped instance (internal-runtime, real seller sessions): a
// seller-surface write with NO identity signal is an unauthenticated public
// write and stays in the tight bucket; a session cookie moves the caller to
// its own identity budget (the handler still answers 401 for a forged one).
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-rate-limit-test-0001";
process.env.PORT = "3150";
const { app: prodApp } = await import(`../src/app.js?internal-runtime-${Date.now()}`);

async function prodDraftEdit(ip: string, cookie?: string) {
  const res = await prodApp.inject({
    method: "PATCH",
    url: `/api/seller/deals/${DEAL}/draft`,
    headers: { "x-forwarded-for": ip, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: { title: "edit" }
  });
  return res.statusCode;
}

await run(`no identity (internal-runtime): a seller-surface write without session or bearer stays in the tight public bucket (${SENSITIVE_BUDGET})`, async () => {
  const got: number[] = [];
  for (let i = 0; i < SENSITIVE_BUDGET + 2; i++) got.push(await prodDraftEdit("203.0.113.40"));
  assert.ok(got.slice(0, SENSITIVE_BUDGET).every((c) => c === 401), `unauthenticated writes are 401, got ${JSON.stringify(got)}`);
  assert.deepEqual(got.slice(SENSITIVE_BUDGET), [429, 429]);
});

await run("session cookie (internal-runtime): the caller is keyed by its session, not by the exhausted public bucket", async () => {
  const code = await prodDraftEdit("203.0.113.40", "siton_seller_session=not-a-real-token");
  assert.equal(code, 401, "a forged session is refused by auth, not by the public bucket");
});

await prodApp.close();
console.log(`\nRATE_LIMIT_SELLER_MUTATION ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
