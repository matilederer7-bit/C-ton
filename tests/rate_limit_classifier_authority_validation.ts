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
// That is NOT fixed here, on purpose. Every fix that puts join into the
// sensitive bucket applies a 20/min PER-IP limit to it, and a shared NAT - a
// school, an office, a mobile carrier - is one IP for hundreds of legitimate
// buyers. Throttling them is a product and identity decision, not a patch. The
// proposed design is recorded in the audit document; this test makes the current
// behaviour explicit so it cannot drift in either direction unnoticed.
//
// No money, no provider, no e-mail.

import { strict as assert } from "node:assert";

process.env.NODE_ENV = "test";
process.env.PORT = "3133";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-classifier";
process.env.ADMIN_API_KEY = "classifier-admin-key";

const { rateLimitBucketFor } = await import("../src/app.js");
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

await run("KNOWN GAP, pinned: the /api join alias is rewritten out of the sensitive bucket", async () => {
  // Documented rather than fixed. The rewrite happens before every onRequest
  // hook, so the limiter never sees the /api form.
  assert.equal(
    rewriteCanonicalApiAlias("/api/deals/abc/join"),
    "/deals/abc/join",
    "the alias rewrite no longer maps join - re-evaluate this gap"
  );
  assert.equal(
    rateLimitBucketFor("POST", "/api/deals/abc/join"),
    "sensitive",
    "the classifier would bucket the /api form correctly if it ever saw it"
  );
  assert.equal(
    bucketAsServed("POST", "/api/deals/abc/join"),
    "none",
    "join is now bucketed - if this was an intentional fix, update the audit's OPEN item and check the shared-NAT impact"
  );

  // The bare collection route is rewritten too, so the mall listing also sits
  // outside both budgets. Reads are cheap and the global per-IP bucket still
  // applies, but it is part of the same gap and is pinned with it.
  assert.equal(
    bucketAsServed("GET", "/api/deals"),
    "none",
    "the /api deal listing is now bucketed - update the audit's OPEN item"
  );

  // Same for the other rewritten lifecycle mutations.
  for (const action of ["publish", "close_joining", "reopen_joining", "prepare_charging", "cancel"]) {
    assert.equal(
      bucketAsServed("POST", `/api/deals/abc/${action}`),
      "none",
      `${action} bucketing changed - re-check the alias/limiter interaction`
    );
  }
});

await run("join is not unprotected, it is protected by something other than the IP bucket", async () => {
  // The gap above is survivable only because join carries its own guards. If
  // these ever move, the missing IP bucket stops being an acceptable trade.
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const source = nodeFs.readFileSync(nodePath.join(process.cwd(), "src", "app.ts"), "utf8");
  const joinSource = source.slice(source.indexOf('app.post("/deals/:id/join"'));
  assert.ok(joinSource.length > 0, "could not locate the join handler to verify its guards");
  const window = joinSource.slice(0, 12000);
  assert.match(window, /pg_advisory_xact_lock/, "join no longer takes an advisory lock per buyer+idempotency key");
  assert.match(window, /FOR UPDATE/, "join no longer locks the deal row, so capacity is racy");
  assert.match(window, /idempotency/i, "join no longer keys on an idempotency record");
  assert.match(window, /max_units_exceeded/, "join no longer enforces the capacity ceiling");

  // The global per-IP bucket still applies to everything, including join.
  assert.ok(Number(process.env.RATE_LIMIT_MAX ?? 200) >= 0, "global bucket configuration is unreadable");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
