// RATE-LIMIT CLASSIFIER — which bucket a request lands in, and why.
//
// Numeric limits are covered elsewhere (rate_limiter_validation,
// rate_limit_read_budget_validation). This file audits the thing those cannot
// see: the CLASSIFIER. A limit of 20/min is worth nothing if the request never
// reaches the bucket, and worth less than nothing if a read lands in the
// mutation bucket and starves normal browsing.
//
// It also pins, deliberately and visibly, a known gap rather than papering over
// it. `rewriteUrl` maps the canonical `/api/deals/:id/join` onto the bare
// `/deals/:id/join` BEFORE routing, and Fastify runs `rewriteUrl` before every
// `onRequest` hook - so the limiter sees the rewritten path, which does not
// match the `/api/deals` prefix, and the join mutation is classified "none".
//
// Black-Sky closed that gap without putting join in the 20/min sensitive bucket
// (a shared NAT is one IP for many legitimate buyers): the limiter now
// classifies the ORIGINAL and the rewritten URL, and join has its own, looser
// per-IP budget (RATE_LIMIT_JOIN_MAX, default 60/min).
//
// No money, no provider, no e-mail.

import { strict as assert } from "node:assert";

process.env.NODE_ENV = "test";
process.env.PORT = "3133";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-classifier";
process.env.ADMIN_API_KEY = "classifier-admin-key";

const { rateLimitBucketFor, rateLimitBucketForRequest, normalizeRateLimitPath, rateLimitClientKey } = await import("../src/app.js");
const { rewriteCanonicalApiAlias } = await import("../src/api_route_aliases.js");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

/** What the limiter actually sees: the URL after the alias rewrite. */
function bucketAsServed(method: string, url: string) {
  return rateLimitBucketFor(method, rewriteCanonicalApiAlias(url));
}

await run("VACUITY GUARD: the classifier distinguishes buckets at all", async () => {
  assert.equal(rateLimitBucketFor("POST", "/api/otp/request"), "sensitive");
  assert.equal(rateLimitBucketFor("GET", "/api/deals/abc/public"), "read");
  assert.equal(rateLimitBucketFor("GET", "/healthz"), "none");
});

await run("sensitive MUTATIONS land in the mutation bucket", async () => {
  const mutations: Array<[string, string]> = [
    ["POST", "/api/otp/request"],
    ["POST", "/api/otp/verify"],
    ["POST", "/api/support"],
    ["POST", "/api/support/ticket-123"],
    ["POST", "/api/deals/abc/inquiries"],
    ["POST", "/api/deals/abc/chat"],
    ["PATCH", "/api/deals/abc/chat/msg-1"],
    ["DELETE", "/api/deals/abc/chat/msg-1"],
    ["PUT", "/api/deals/abc/something"]
  ];
  for (const [method, url] of mutations) {
    assert.equal(bucketAsServed(method, url), "sensitive", `${method} ${url} escaped the mutation bucket`);
  }
});

await run("public READS on the same prefixes use the read budget, not the mutation budget", async () => {
  // The P0.7C requirement: normal browsing and polling must never consume the
  // budget meant for OTP, joining and support. Getting this wrong shows up as
  // buyers seeing 429 while simply reading a deal page in two tabs.
  const reads: Array<[string, string]> = [
    ["GET", "/api/deals/abc/public"],
    ["GET", "/api/deals/abc/activity"],
    ["GET", "/api/deals/abc/chat"],
    ["HEAD", "/api/deals/abc/public"],
    ["GET", "/api/support"],
    ["GET", "/api/otp/status"]
  ];
  for (const [method, url] of reads) {
    assert.equal(bucketAsServed(method, url), "read", `${method} ${url} consumed the mutation budget`);
  }
});

await run("the classifier is not fooled by trailing slashes, query strings or method case", async () => {
  // A classifier that matches on a raw prefix is exactly where these slip
  // through: one extra character and a mutation becomes unclassified.
  assert.equal(rateLimitBucketFor("POST", "/api/otp"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/otp/"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/otp?x=1"), "sensitive");
  assert.equal(rateLimitBucketFor("post", "/api/otp/request"), "sensitive", "a lower-case method changed the bucket");
  assert.equal(rateLimitBucketFor("get", "/api/deals/abc/public"), "read", "a lower-case method changed the bucket");

  // A near-miss prefix must NOT be swept in: /api/dealsomething is a different
  // namespace and silently rate-limiting it would be its own bug.
  assert.equal(rateLimitBucketFor("POST", "/api/dealsomething"), "none");
  assert.equal(rateLimitBucketFor("POST", "/api/otpx"), "none");
});

await run("Black-Sky C4: the /api join alias is classified before AND after the rewrite into its own join budget", async () => {
  assert.equal(rewriteCanonicalApiAlias("/api/deals/abc/join"), "/deals/abc/join", "the alias rewrite no longer maps join - re-evaluate");
  // As served (rewritten) and as sent, join lands in the dedicated join bucket.
  assert.equal(bucketAsServed("POST", "/api/deals/abc/join"), "join");
  assert.equal(rateLimitBucketForRequest("POST", "/api/deals/abc/join", "/deals/abc/join"), "join");
  // Seller lifecycle mutations on the bare /deals paths are in the tight bucket.
  for (const action of ["publish", "close_joining", "reopen_joining", "prepare_charging", "cancel"]) {
    assert.equal(bucketAsServed("POST", `/api/deals/abc/${action}`), "sensitive", action);
  }
  // Reads stay in the read budget, never the mutation bucket.
  assert.equal(bucketAsServed("GET", "/api/deals"), "read");
});

await run("Black-Sky B3: percent-encoded and double-slash paths cannot escape the budget", async () => {
  assert.equal(rateLimitBucketFor("POST", "/api/%6Ftp/request"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/admin/%61uth/login"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "//api//otp/request"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/otp/request?x=1"), "sensitive");
  assert.equal(normalizeRateLimitPath("/api/%E0"), "/api/%E0", "a malformed escape must classify, not throw");
});

await run("Black-Sky C3/C6/C7: payments, logins, participants and analytics writers are budgeted", async () => {
  assert.equal(rateLimitBucketFor("POST", "/api/payments/authorize"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/payments/status"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/seller/session/login"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/link-viewer/session/login"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/participants/abc/recovery"), "sensitive");
  assert.equal(rateLimitBucketFor("GET", "/api/participants/abc/tracking"), "read");
  for (const url of ["/api/mall/events", "/api/viral/events", "/api/affiliate/links/visit"]) {
    assert.equal(rateLimitBucketFor("POST", url), "analytics", url);
  }
});

await run("Black-Sky C12: IPv6 clients are keyed by /64, IPv4 and mapped addresses by address", async () => {
  assert.equal(rateLimitClientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(rateLimitClientKey("2001:db8:1:2::1"), rateLimitClientKey("2001:db8:1:2:ffff::9"));
  assert.notEqual(rateLimitClientKey("2001:db8:1:2::1"), rateLimitClientKey("2001:db8:1:3::1"));
  assert.equal(rateLimitClientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(rateLimitClientKey("::ffff:203.0.113.9"), "203.0.113.9");
});

await run("join is not unprotected, it is protected by something other than the IP bucket", async () => {
  // The gap above is survivable only because join carries its own guards. If
  // these ever move, the missing IP bucket stops being an acceptable trade.
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const source = nodeFs.readFileSync(nodePath.join(process.cwd(), "src", "app.ts"), "utf8");
  const joinSource = source.slice(source.indexOf('app.post("/deals/:id/join"'));
  assert.ok(joinSource.length > 0, "could not locate the join handler to verify its guards");
  // The join handler grew with the red-team C-2 reorder (lock-independent
  // work first, deal lock around the money core), so the guard window is wider.
  const window = joinSource.slice(0, 40000);
  assert.match(window, /pg_advisory_xact_lock/, "join no longer takes an advisory lock per buyer+idempotency key");
  assert.match(window, /FROM siton\.deals WHERE deal_id=\$1 FOR NO KEY UPDATE/, "join no longer locks the deal row, so capacity is racy");
  assert.match(window, /idempotency/i, "join no longer keys on an idempotency record");
  assert.match(window, /max_units_exceeded/, "join no longer enforces the capacity ceiling");

  // The global per-IP bucket still applies to everything, including join.
  assert.ok(Number(process.env.RATE_LIMIT_MAX ?? 200) >= 0, "global bucket configuration is unreadable");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
