// FORENSIC TRUTH — enough evidence to reconstruct an incident, no secrets in it.
//
// These pull in opposite directions and a test that checks only one is worthless:
//
//   Log too little  -> a security event cannot be reconstructed afterwards, and
//                      "no secrets leaked" is trivially true of a silent server.
//   Log too much    -> the log itself becomes the breach. An Authorization
//                      header or a session cookie in a log line survives longer,
//                      and is read by more people, than the request ever was.
//
// So this file asserts BOTH: distinctive sentinel secrets are pushed through
// every channel a request has (headers, cookies, body, query) while stdout is
// captured, and the capture is then checked for the secrets AND for the evidence
// that must be there.
//
// Capturing stdout is the only honest way to test this. Reading the source for
// `redact:` options would prove what the configuration says, not what the
// process writes - and it is the process that ends up in the log aggregator.
//
// No money, no provider, no e-mail.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.PORT = "3132";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-forensic";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-forensic";

// Sentinels: long, unique, and shaped like the real thing, so a partial or
// transformed leak (base64, truncation, URL-encoding) still shows up as a hit on
// the distinctive middle.
const SENTINEL_ADMIN_KEY = "SENTINELadminkey7f3c1b9e2d5a8c4f6b0e";
const SENTINEL_BEARER = "SENTINELbearerA1B2C3D4E5F6G7H8I9J0KL";
const SENTINEL_COOKIE = "SENTINELcookie55aa77bb99cc11dd33ee";
const SENTINEL_PASSWORD = "SENTINELpasswordQ9w8E7r6T5y4U3i2O1";
const SENTINEL_TOKEN = "SENTINELtokenZ0x9C8v7B6n5M4l3K2j1H";
const SENTINEL_PAN = "SENTINELpan4111111111111111";
const SENTINEL_QUERY = "SENTINELqueryG7h8J9k0L1m2N3b4V5c6X";
const ORDINARY_SEARCH_TERM = "ordinarySearchTermKeepMe";

process.env.ADMIN_API_KEY = SENTINEL_ADMIN_KEY;

const { app } = await import("../src/app.js");
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

/**
 * Capture what the REAL logger emits while `fn` runs.
 *
 * Intercepting `process.stdout.write` does not work and the first version of
 * this file proved it by capturing 0 bytes: Fastify's default pino writes
 * through sonic-boom straight to the file descriptor. So the logger's own
 * destination stream is swapped instead, which means these assertions run
 * against the real serializers and the real formatted line - the thing a log
 * aggregator would actually store - rather than against configuration read out
 * of the source.
 */
const pinoModule = await import("pino");
const streamSym: symbol = (pinoModule as any).symbols?.streamSym
  ?? (pinoModule as any).default?.symbols?.streamSym;
assert.ok(streamSym, "pino stream symbol unavailable - cannot capture real log output");

async function captureOutput(fn: () => Promise<void>) {
  const logger = (app as any).log;
  const original = logger[streamSym];
  assert.ok(original, "the Fastify logger has no destination stream to swap");
  const chunks: string[] = [];
  logger[streamSym] = {
    write(chunk: any) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
    flushSync() {},
    end() {}
  };
  try {
    await fn();
  } finally {
    logger[streamSym] = original;
  }
  return chunks.join("");
}

const SECRETS: Array<[string, string]> = [
  ["admin api key", SENTINEL_ADMIN_KEY],
  ["bearer token", SENTINEL_BEARER],
  ["session cookie", SENTINEL_COOKIE],
  ["password", SENTINEL_PASSWORD],
  ["auth token in body", SENTINEL_TOKEN],
  ["card number", SENTINEL_PAN],
  ["credential in query", SENTINEL_QUERY]
];

/** Exercise every channel a caller controls, including failing paths. */
async function noisyTraffic() {
  const secretHeaders = {
    authorization: `Bearer ${SENTINEL_BEARER}`,
    cookie: `siton_admin_session=${SENTINEL_COOKIE}; siton_seller_session=${SENTINEL_COOKIE}`,
    "x-admin-key": SENTINEL_ADMIN_KEY,
    "x-request-id": randomUUID(),
    "content-type": "application/json"
  };

  // Reads, refused reads, a route that does not exist, and writes that fail
  // validation - error paths are where a handler is most tempted to log context.
  await app.inject({ method: "GET", url: "/api/admin/actions", headers: secretHeaders } as any);
  await app.inject({ method: "GET", url: "/api/seller/deals", headers: secretHeaders } as any);
  // `t` is the buyer's inquiry-thread access token - a credential in a query
  // string, and the reason the URL serializer redacts. `q` is an ordinary search
  // term and must SURVIVE: redacting everything would trade one problem for an
  // undebuggable log.
  await app.inject({ method: "GET", url: `/api/admin/actions?t=${encodeURIComponent(SENTINEL_QUERY)}`, headers: secretHeaders } as any);
  await app.inject({ method: "GET", url: `/api/inquiries/${randomUUID()}?t=${encodeURIComponent(SENTINEL_QUERY)}`, headers: secretHeaders } as any);
  await app.inject({ method: "GET", url: `/api/admin/actions?token=${encodeURIComponent(SENTINEL_QUERY)}&q=${ORDINARY_SEARCH_TERM}`, headers: secretHeaders } as any);
  await app.inject({ method: "GET", url: "/api/definitely/not/a/route", headers: secretHeaders } as any);
  await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    headers: secretHeaders,
    payload: { email: "forensic@siton.test", password: SENTINEL_PASSWORD }
  } as any);
  await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    headers: secretHeaders,
    payload: { identifier: "forensic@siton.test", access_code: SENTINEL_PASSWORD }
  } as any);
  await app.inject({
    method: "POST",
    url: "/deals",
    headers: secretHeaders,
    payload: { title: "forensic", auth_token: SENTINEL_TOKEN, card_number: SENTINEL_PAN, password: SENTINEL_PASSWORD }
  } as any);
  await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${randomUUID()}/draft`,
    headers: secretHeaders,
    payload: { title: "forensic", token: SENTINEL_TOKEN }
  } as any);
}

let captured = "";

await run("VACUITY GUARD: the server actually logs something during this traffic", async () => {
  captured = await captureOutput(noisyTraffic);
  assert.ok(
    captured.length > 200,
    `almost nothing was logged (${captured.length} bytes) - "no secrets leaked" would be trivially true of a silent server`
  );
  assert.match(captured, /"level"\s*:\s*\d+/, "captured output does not look like structured logs");
});

await run("no credential, token, password or card number reaches the logs", async () => {
  const leaked: string[] = [];
  for (const [label, secret] of SECRETS) {
    if (captured.includes(secret)) leaked.push(label);
    // A URL-encoded or partially-quoted copy is still a leak.
    if (captured.includes(encodeURIComponent(secret))) leaked.push(`${label} (url-encoded)`);
    // The distinctive middle catches truncation and re-wrapping.
    const core = secret.slice(8, 24);
    if (core.length >= 12 && captured.includes(core)) leaked.push(`${label} (fragment)`);
  }
  assert.deepEqual([...new Set(leaked)], [], "secret material reached the logs");
});

await run("redaction removes credentials without destroying the log's usefulness", async () => {
  // The failure mode on the other side: redact everything and the log stops
  // being able to answer "what was this request?". The route and the ordinary
  // search term must still be there, and the credential must be visibly MASKED
  // rather than silently dropped, so a reader can tell a redaction from an
  // absent parameter.
  assert.ok(captured.includes(ORDINARY_SEARCH_TERM), "an ordinary query parameter was redacted away - the log lost debuggability");
  assert.ok(captured.includes("/api/inquiries/"), "the requested route is missing from the logs");
  assert.match(captured, /t=\[redacted\]|token=\[redacted\]/, "the credential parameter was dropped rather than visibly masked");
});

await run("no raw Authorization header or cookie jar is logged, under any spelling", async () => {
  // Header NAMES appearing is fine and often useful; their VALUES are not. This
  // catches a serializer that was widened to log `req.headers` wholesale.
  const forbidden = [
    /"authorization"\s*:\s*"Bearer /i,
    /"cookie"\s*:\s*"[^"]*siton_(admin|seller)_session=[^";]/i,
    /"x-admin-key"\s*:\s*"[^"]{8}/i,
    /"set-cookie"\s*:\s*"[^"]*siton_(admin|seller)_session=[^";]/i
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(captured), `a credential-bearing header value was logged, matching ${pattern}`);
  }
});

await run("a security-relevant refusal still leaves enough evidence to reconstruct it", async () => {
  // The other half of the invariant. If the answer to "no secrets" is "we log
  // nothing", an incident cannot be investigated at all.
  const requestId = randomUUID();
  const evidence = await captureOutput(async () => {
    await app.inject({
      method: "GET",
      url: "/api/admin/actions",
      headers: { "x-request-id": requestId, "x-admin-key": "wrong-key-entirely" }
    } as any);
  });
  assert.ok(evidence.includes(requestId), "the request id is not in the logs, so the refusal cannot be correlated");
  assert.match(evidence, /"url"\s*:\s*"\/api\/admin\/actions/, "the refused route is not recorded");
  assert.match(evidence, /"statusCode"\s*:\s*(401|403)/, "the refusal status is not recorded");
  assert.ok(!evidence.includes("wrong-key-entirely"), "the rejected credential itself was logged");
});

await run("an internal fault is logged with a correlatable id and no request secrets", async () => {
  const requestId = randomUUID();
  const evidence = await captureOutput(async () => {
    // A malformed path parameter: a real error path, not a synthetic throw.
    await app.inject({
      method: "GET",
      url: "/api/seller/deals/not-a-uuid/draft",
      headers: {
        "x-request-id": requestId,
        cookie: `siton_seller_session=${SENTINEL_COOKIE}`,
        authorization: `Bearer ${SENTINEL_BEARER}`
      }
    } as any);
  });
  assert.ok(evidence.includes(requestId), "the failing request has no correlatable id in the logs");
  assert.ok(!evidence.includes(SENTINEL_COOKIE), "a session cookie was logged alongside a failure");
  assert.ok(!evidence.includes(SENTINEL_BEARER), "a bearer token was logged alongside a failure");
});

console.log(`SUMMARY passed=${passed} failed=${failed} captured_bytes=${captured.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
