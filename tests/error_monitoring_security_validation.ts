// ERROR MONITORING NEVER LEAKS PERSONAL DATA OR CREDENTIALS.
//
// src/error_monitoring.ts sends server, worker and relayed browser errors to
// Sentry. Every assertion below inspects the EXACT bytes that would leave the
// process (a capturing transport replaces the network), so a regression that
// lets a phone number, email, card number, token, cookie, authorization
// header, IP address or request body into an event fails here.
//
//   1. disabled without a DSN: no event, no process handlers
//   2. DSN parsing and envelope addressing
//   3. free-text scrubbing (all sensitive classes; UUID correlation ids kept)
//   4. a hostile Error object: only type, scrubbed message and frames leave
//   5. tag allowlist and value policy
//   6. dedupe and per-window budget
//   7. the live Fastify error handler: 5xx captured with the route TEMPLATE,
//      never the URL, body, headers or cookies; 4xx not captured
//   8. /api/client-errors: schema-strict, route shape only, rate-limited,
//      silent 204 when disabled
//   9. the controlled self-test event is opt-in and tagged
//  10. a real child process: an unhandled rejection is reported scrubbed and
//      the process still exits 1, as Node would without a handler

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.NODE_ENV = "test";
process.env.PORT = "3142";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-monitoring";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-monitoring";
process.env.ADMIN_API_KEY = "monitoring-admin-key";
delete process.env.SENTRY_DSN;
delete process.env.SENTRY_SELF_TEST;

const monitoring = await import("../src/error_monitoring.js");
const { app } = await import("../src/app.js");

// A route that fails the way a real handler would, registered before ready().
app.post("/__monitoring-test/boom/:id", async () => {
  throw new Error("database exploded for buyer buyer.real@example.com phone 050-1234567");
});
app.get("/__monitoring-test/bad-request", async () => {
  const error: any = new Error("invalid input from 0501234567");
  error.statusCode = 400;
  throw error;
});
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

// Synthetic sensitive values. Built at runtime so no scanner mistakes this
// file for a leak; every one of them must be absent from every envelope.
const b64url = (value: string) => Buffer.from(value).toString("base64url");
const JWT = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"buyer-monitoring-test"}')}.c2lnbmF0dXJlLW1vbml0b3JpbmctdGVzdA`;
const API_KEY = ["sk", "monitoring", "7f3c9a1b2d4e6f8091a2b3c4d5e6f7a8b9"].join("_");
const SENSITIVE = {
  email: "buyer.real@example.com",
  phone_local: "050-1234567",
  phone_plain: "0501234567",
  phone_intl: "+972501234567",
  card: "4111 1111 1111 1111",
  card_plain: "4111111111111111",
  jwt: JWT,
  bearer: "bearer-secret-value-9f8e7d",
  cookie: "siton_seller_session=cookie-secret-value-1a2b",
  password: "hunter2-monitoring",
  otp: "482913",
  ip: "203.0.113.77",
  api_key: API_KEY,
  query_token: "trackingtokenvalue123abc",
  address: "Herzl Street 12 Tel Aviv",
  amount_payload: "amount_agorot"
} as const;
const DSN = "https://publickey123@o1.ingest.de.sentry.io/4500000000000001";
const DEAL_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

type Envelope = { url: string; headers: Record<string, string>; body: string };
const sent: Envelope[] = [];
const transport = async (envelope: Envelope) => { sent.push(envelope); };

function enable(extra: Record<string, unknown> = {}) {
  monitoring.resetErrorMonitoringForTests();
  sent.length = 0;
  return monitoring.initErrorMonitoring({ service: "web", dsn: DSN, environment: "staging", release: "abc1234", transport, ...extra });
}

function eventOf(envelope: Envelope) {
  const lines = envelope.body.trim().split("\n");
  assert.equal(lines.length, 3, "an envelope is header, item header and one event");
  return JSON.parse(lines[2]!);
}

function assertNoSensitive(text: string, label: string) {
  for (const [name, value] of Object.entries(SENSITIVE)) {
    if (name === "address" || name === "amount_payload") continue; // asserted separately where they could appear
    assert.ok(!text.includes(value), `${label} leaked ${name}`);
  }
  assert.ok(!/cookie-secret|bearer-secret|hunter2/.test(text), `${label} leaked a credential fragment`);
}

// ── 1 ──
await run("disabled without a DSN: no event is queued and no process handler is installed", () => {
  monitoring.resetErrorMonitoringForTests();
  assert.equal(monitoring.initErrorMonitoring({ service: "web", dsn: "", transport }), false);
  assert.equal(monitoring.isErrorMonitoringEnabled(), false);
  assert.equal(monitoring.captureException(new Error("x")), null);
  assert.equal(monitoring.installProcessErrorCapture(() => undefined), false);
  assert.deepEqual(monitoring.errorMonitoringSummary(), { enabled: false });
});

// ── 2 ──
await run("DSN parsing: envelope URL and public key; malformed or non-https DSNs disable monitoring", () => {
  assert.deepEqual(monitoring.parseDsn(DSN), { envelopeUrl: "https://o1.ingest.de.sentry.io/api/4500000000000001/envelope/", publicKey: "publickey123" });
  assert.equal(monitoring.parseDsn("http://k@o1.ingest.sentry.io/1"), null);
  assert.equal(monitoring.parseDsn("https://o1.ingest.sentry.io/1"), null);
  assert.equal(monitoring.parseDsn("https://k@o1.ingest.sentry.io/not-a-project"), null);
  assert.equal(monitoring.parseDsn("not a url"), null);
});

await run("a full 40-character commit SHA is kept as the release", async () => {
  const sha = "28523f1c795acdfcb5b7a534da61e00b08d7ed36";
  enable({ release: sha });
  assert.equal((monitoring.errorMonitoringSummary() as any).release, sha);
  monitoring.captureException(new Error("release check"), { service: "browser", tags: { client_release: sha } });
  await monitoring.flushMonitoring();
  const event = eventOf(sent[0]!);
  assert.equal(event.release, sha);
  assert.equal(event.tags.client_release, sha);
});

await run("the startup summary never contains the DSN or its key", () => {
  enable();
  const summary = JSON.stringify(monitoring.errorMonitoringSummary());
  assert.ok(!summary.includes("publickey123") && !summary.includes("ingest"), summary);
  assert.match(summary, /"environment":"staging"/);
  assert.match(summary, /"release":"abc1234"/);
});

// ── 3 ──
await run("scrubText removes every sensitive class and keeps UUID correlation ids", () => {
  const text = [
    `email ${SENSITIVE.email}`, `phone ${SENSITIVE.phone_local} / ${SENSITIVE.phone_plain} / ${SENSITIVE.phone_intl}`,
    `card ${SENSITIVE.card} and ${SENSITIVE.card_plain}`, `jwt ${SENSITIVE.jwt}`,
    `Authorization: Bearer ${SENSITIVE.bearer}`, `cookie: ${SENSITIVE.cookie}`, `password=${SENSITIVE.password}`,
    `otp_code=${SENSITIVE.otp}`, `from ${SENSITIVE.ip}`, `key ${SENSITIVE.api_key}`,
    `GET /api/participants/x/tracking?t=${SENSITIVE.query_token}`, `deal ${DEAL_ID}`
  ].join(" | ");
  const scrubbed = monitoring.scrubText(text, 5_000);
  assertNoSensitive(scrubbed, "scrubText");
  assert.ok(scrubbed.includes(DEAL_ID), "UUID correlation id was removed");
  assert.ok(scrubbed.includes("[redacted:email]") && scrubbed.includes("[redacted:number]") && scrubbed.includes("[redacted:jwt]"), scrubbed);
});

await run("scrubText: a secret straddling the pre-scrub cut does not survive as a prefix", () => {
  // Each JWT shrinks to "[redacted:jwt]", pulling whatever sits at the cut
  // back inside the 1000-character output limit.
  const unit = `${SENSITIVE.jwt}${"x".repeat(40)} `;
  const prefix = unit.repeat(Math.floor(3_600 / unit.length));
  const text = `${prefix}${"y".repeat(4_000 - prefix.length - 11)} ${SENSITIVE.email} and ${SENSITIVE.card_plain}`;
  assert.ok(text.indexOf(SENSITIVE.email) < 4_000 && text.indexOf(SENSITIVE.email) + SENSITIVE.email.length > 4_000, "fixture must straddle the cut");
  const scrubbed = monitoring.scrubText(text);
  assert.ok(!scrubbed.includes("buyer.real"), `email prefix survived: ${scrubbed.slice(-80)}`);
  assert.ok(!/41111111/.test(scrubbed), "card prefix survived");
});

await run("scrubText: a space-separated card or phone straddling the cut leaves no digit group", () => {
  const unit = `${SENSITIVE.jwt}${"x".repeat(40)} `;
  const prefix = unit.repeat(Math.floor(3_600 / unit.length));
  for (const secret of [SENSITIVE.card, "050 123 4567 8", "+972 (50) 123-4567", "(050) 123.4567"]) {
    const filler = 4_000 - prefix.length - 1 - Math.floor(secret.length / 2);
    const text = `${prefix}${"y".repeat(filler)} ${secret} tail`;
    const scrubbed = monitoring.scrubText(text);
    assert.ok(!/\b4111\b|\b050\b|\b123\b|\(50\)|\b972\b/.test(scrubbed), `digit group survived: ${scrubbed.slice(-60)}`);
  }
});

await run("scrubText: a secret straddling the cut in whitespace-free JSON leaves no prefix", () => {
  // No whitespace anywhere; long emails shrink when scrubbed. The secret is
  // placed both at the cut itself and 512 characters before it (where a
  // bounded step-back used to fall back to a fixed floor).
  const filler = Array.from({ length: 400 }, (_, i) => `"u${i}.${"l".repeat(80)}@example.com"`).join(",");
  for (const boundary of [4_000, 3_488]) {
    for (let overlap = 4; overlap <= 12; overlap += 1) {
      const head = `{"deal":"${DEAL_ID}","list":[${filler}`.slice(0, boundary - overlap);
      const text = `${head},"${SENSITIVE.email}",${filler}]}`;
      const at = text.indexOf(SENSITIVE.email);
      assert.ok(at < boundary && at + SENSITIVE.email.length > boundary && text.length > 4_000 && !/\s/.test(text), "fixture must straddle the boundary without whitespace");
      const scrubbed = monitoring.scrubText(text, 1_000);
      assert.ok(!scrubbed.includes("buyer.real"), `boundary ${boundary} overlap ${overlap}: ${scrubbed.slice(-50)}`);
      assert.ok(scrubbed.includes(DEAL_ID), "correlation id lost");
    }
  }
});

await run("scrubText: long text without whitespace keeps its leading correlation id and stays fast", () => {
  const text = `deal ${DEAL_ID} ` + `{"k":"${"v".repeat(6_000)}"}`;
  const started = Date.now();
  const scrubbed = monitoring.scrubText(text);
  assert.ok(scrubbed.includes(DEAL_ID), "correlation id lost");
  monitoring.scrubText("a".repeat(31_998) + " b" + "c".repeat(10), 8_000);
  monitoring.scrubText("a-".repeat(16_000), 8_000);
  monitoring.scrubText("?a".repeat(16_000), 8_000);

  assert.ok(Date.now() - started < 500, `scrubText took ${Date.now() - started} ms`);
});

await run("scrubText: phone numbers with parentheses or dots are redacted", () => {
  for (const phone of ["+972 (50) 123-4567", "(050) 123 4567", "050.123.4567", "+972-(0)50-1234567"]) {
    const scrubbed = monitoring.scrubText(`call ${phone} now`);
    assert.ok(!/\d{3}/.test(scrubbed.replace("[redacted:number]", "")), `${phone} -> ${scrubbed}`);
  }
  assert.equal(monitoring.scrubText("released 2026-09-24 at 11:45"), "released 2026-09-24 at 11:45");
  const started = Date.now();
  monitoring.scrubText("1(".repeat(16_000), 8_000);
  monitoring.scrubText("1 ".repeat(16_000), 8_000);
  assert.ok(Date.now() - started < 500, "number rule is not linear");
});

await run("scrubText: a repeated credential keyword stays linear (bounded key name)", () => {
  const started = Date.now();
  monitoring.scrubText("token".repeat(6_400), 8_000);
  monitoring.scrubText("a-token=".repeat(4_000), 8_000);
  assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`);
});

await run("scrubText: a quoted multi-word credential is redacted through its closing quote", () => {
  const text = `login failed password="correct horse battery staple" secret='blue green red' token: "a b c" api_key=plain next`;
  const scrubbed = monitoring.scrubText(text);
  for (const word of ["horse", "battery", "staple", "green", "red'", " b c", "plain"]) assert.ok(!scrubbed.includes(word), `${word} survived: ${scrubbed}`);
  assert.ok(scrubbed.startsWith("login failed password=[redacted]") && scrubbed.endsWith(" next"), scrubbed);
  const json = monitoring.scrubText(`request failed: {"password":"correct horse battery staple","api_key": "k1 k2","user":"ok"} and {'secret':'s1 s2'}`);
  for (const word of ["horse", "staple", "k1", "k2", "s1", "s2"]) assert.ok(!json.includes(word), `JSON-quoted key leaked ${word}: ${json}`);
  assert.ok(json.includes('"user":"ok"'), `unrelated JSON field was damaged: ${json}`);
  const escaped = monitoring.scrubText(String.raw`{"password":"correct \"horse\" battery staple","user":"ok"} and secret='it\'s blue green'`);
  for (const word of ["horse", "battery", "staple", "blue", "green"]) assert.ok(!escaped.includes(word), `escaped quote leaked ${word}: ${escaped}`);
  assert.ok(escaped.includes('"user":"ok"'), `field after an escaped credential was damaged: ${escaped}`);
  const embedded = monitoring.scrubText(String.raw`request failed: {\"password\":\"correct horse battery staple\",\"user\":\"ok\"} and {\'secret\':\'blue green\'}`);
  for (const word of ["horse", "battery", "staple", "blue", "green"]) assert.ok(!embedded.includes(word), `escaped JSON leaked ${word}: ${embedded}`);
  assert.ok(embedded.includes(String.raw`\"user\":\"ok\"`), `field after escaped JSON credential was damaged: ${embedded}`);
  const long = monitoring.scrubText(`password="${"q".repeat(600)}" tail`);
  assert.ok(!long.includes("qqq"), `suffix of a long quoted credential survived: ${long}`);
  const unclosed = monitoring.scrubText(`secret='${"w".repeat(900)}`);
  assert.ok(!unclosed.includes("www"), "suffix of an unclosed long credential survived");
  const started = Date.now();
  monitoring.scrubText(`password="${"x ".repeat(20_000)}`, 8_000);
  monitoring.scrubText(`password="`.repeat(4_000), 8_000);
  monitoring.scrubText(`password="${"\\\"".repeat(10_000)}`, 8_000);
  monitoring.scrubText(`password=\\"${"a".repeat(30_000)}`, 8_000);
  assert.ok(Date.now() - started < 100, "unclosed quote is not linear");
});

await run("scrubText leaves an ordinary engineering message intact and bounds length", () => {
  const plain = "duplicate key value violates unique constraint deals_pkey";
  assert.equal(monitoring.scrubText(plain), plain);
  assert.ok(monitoring.scrubText("x".repeat(10_000)).length <= 1_001);
});

// ── 4 ──
await run("a hostile Error: attached headers, body, request and config never leave; message is scrubbed", async () => {
  enable();
  const error: any = new Error(`charge failed for ${SENSITIVE.email} card ${SENSITIVE.card} deal ${DEAL_ID}`);
  error.headers = { authorization: `Bearer ${SENSITIVE.bearer}`, cookie: SENSITIVE.cookie };
  error.request = { body: { phone: SENSITIVE.phone_plain, address: SENSITIVE.address, amount_agorot: 125_000 } };
  error.config = { data: `password=${SENSITIVE.password}` };
  error.response = { data: { token: SENSITIVE.jwt } };
  const id = monitoring.captureException(error, { tags: { request_id: "req:abcdef12", route: "/api/deals/:id/join" } });
  assert.match(String(id), /^[0-9a-f]{32}$/);
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 1);
  const body = sent[0]!.body;
  assertNoSensitive(body, "envelope");
  assert.ok(!body.includes(SENSITIVE.address) && !body.includes(SENSITIVE.amount_payload), "request payload leaked");
  const event = eventOf(sent[0]!);
  assert.equal(event.environment, "staging");
  assert.equal(event.release, "abc1234");
  assert.equal(event.level, "error");
  assert.equal(event.platform, "node");
  assert.deepEqual(Object.keys(event).sort(), ["contexts", "environment", "event_id", "exception", "level", "platform", "release", "tags", "timestamp"]);
  const exception = event.exception.values[0];
  assert.equal(exception.type, "Error");
  assert.ok(exception.value.includes(DEAL_ID), "deal id should remain for correlation");
  const frames = exception.stacktrace.frames;
  assert.ok(frames.length > 0, "stack frames missing");
  assert.ok(frames.at(-1).filename.includes("error_monitoring_security_validation"), `top frame should be this test, got ${frames.at(-1).filename}`);
  assert.ok(frames.every((frame: any) => !frame.filename.startsWith("file://") && !frame.filename.startsWith(process.cwd() + "/")), "absolute paths leaked into frames");
  assert.deepEqual(event.tags, { request_id: "req:abcdef12", route: "/api/deals/:id/join", service: "web" });
  assert.equal(sent[0]!.url, "https://o1.ingest.de.sentry.io/api/4500000000000001/envelope/");
  assert.match(sent[0]!.headers["x-sentry-auth"]!, /sentry_key=publickey123/);
});

await run("a rejected non-Error value is reported scrubbed", async () => {
  enable();
  monitoring.captureException({ message: `lookup failed for ${SENSITIVE.phone_intl}`, secret: SENSITIVE.password });
  monitoring.captureException(`plain string with ${SENSITIVE.email}`);
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 2);
  for (const envelope of sent) assertNoSensitive(envelope.body, "non-error envelope");
});

// ── 5 ──
await run("tags: unknown keys are dropped and values that carry PII or odd characters are dropped", () => {
  const tags = monitoring.sanitizeTags({
    route: "/api/deals/:id",
    user_email: SENSITIVE.email,
    debug_payload: "harmless-looking-value",
    phone: SENSITIVE.phone_plain,
    request_id: `req ${SENSITIVE.email}`,
    method: "POST",
    status_code: 500,
    worker_id: "siton-worker-1-5fa4fa06-f9a1-4cc5-a17c-47506b84acbc",
    error_code: SENSITIVE.phone_plain
  });
  assert.deepEqual(tags, { route: "/api/deals/:id", method: "POST", status_code: "500", worker_id: "siton-worker-1-5fa4fa06-f9a1-4cc5-a17c-47506b84acbc" });
});

// ── 6 ──
await run("identical errors are deduplicated and a burst is capped per window", async () => {
  enable({ maxEventsPerWindow: 3 });
  for (let i = 0; i < 5; i += 1) monitoring.captureException(new Error("same failure"));
  for (let i = 0; i < 10; i += 1) monitoring.captureException(new Error(`distinct failure ${i}`));
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 3);
});

await run("a failing transport never throws into the caller", async () => {
  monitoring.resetErrorMonitoringForTests();
  monitoring.initErrorMonitoring({ service: "web", dsn: DSN, transport: async () => { throw new Error("network down"); } });
  assert.doesNotThrow(() => monitoring.captureException(new Error("x")));
  await monitoring.flushMonitoring();
});

// ── 7 ──
await run("live Fastify error handler: a 5xx is captured with route template, method, status and request id only", async () => {
  enable();
  const response = await app.inject({
    method: "POST",
    url: `/__monitoring-test/boom/${SENSITIVE.query_token}?t=${SENSITIVE.query_token}&phone=${SENSITIVE.phone_plain}`,
    headers: {
      authorization: `Bearer ${SENSITIVE.bearer}`,
      cookie: SENSITIVE.cookie,
      "x-forwarded-for": SENSITIVE.ip,
      "x-request-id": "req-monitoring-0001",
      "content-type": "application/json"
    },
    payload: { card_number: SENSITIVE.card_plain, email: SENSITIVE.email, address: SENSITIVE.address, amount_agorot: 99_000 }
  });
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).error, "internal_error");
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 1, "exactly one event for one 5xx");
  const body = sent[0]!.body;
  assertNoSensitive(body, "5xx envelope");
  assert.ok(!body.includes(SENSITIVE.address) && !body.includes(SENSITIVE.amount_payload) && !body.includes(SENSITIVE.query_token), "request material leaked");
  const event = eventOf(sent[0]!);
  assert.deepEqual(event.tags, {
    method: "POST",
    request_id: "req-monitoring-0001",
    route: "/__monitoring-test/boom/:id",
    service: "web",
    status_code: "500"
  });
  assert.equal(event.exception.values[0].mechanism.type, "fastify_error_handler");
  assert.equal(event.exception.values[0].mechanism.handled, false);
});

await run("live Fastify error handler: a 4xx is not reported", async () => {
  enable();
  const response = await app.inject({ method: "GET", url: "/__monitoring-test/bad-request" });
  assert.equal(response.statusCode, 400);
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 0);
});

// ── 8 ──
const clientReport = (overrides: Record<string, unknown> = {}) => ({
  source: "web",
  type: "TypeError",
  message: `Cannot read properties of undefined (phone ${SENSITIVE.phone_plain}, ${SENSITIVE.email})`,
  stack: `TypeError: boom\n    at renderTracking (https://siton-staging-web.onrender.com/preview/assets/index-abc123.js?v=1:1:2345)\n    at https://siton-staging-web.onrender.com/preview/assets/index-abc123.js:1:999`,
  route: `/track/${SENSITIVE.query_token}?t=${SENSITIVE.query_token}`,
  release: "abc1234",
  ...overrides
});

await run("/api/client-errors while disabled: 204 and nothing sent", async () => {
  monitoring.resetErrorMonitoringForTests();
  sent.length = 0;
  const response = await app.inject({ method: "POST", url: "/api/client-errors", payload: clientReport() });
  assert.equal(response.statusCode, 204);
  assert.equal(sent.length, 0);
});

await run("/api/client-errors: relayed as a browser event with route shape only, scrubbed", async () => {
  enable();
  const response = await app.inject({
    method: "POST",
    url: "/api/client-errors",
    headers: { cookie: SENSITIVE.cookie, authorization: `Bearer ${SENSITIVE.bearer}`, "x-forwarded-for": SENSITIVE.ip },
    payload: clientReport()
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 1);
  assertNoSensitive(sent[0]!.body, "browser envelope");
  assert.ok(!sent[0]!.body.includes(SENSITIVE.query_token), "tracking token leaked through the route");
  const event = eventOf(sent[0]!);
  assert.equal(event.platform, "javascript");
  assert.equal(event.tags.service, "browser");
  assert.equal(event.tags.client_route, "/track/:param");
  assert.equal(event.tags.client_source, "web");
  assert.equal(event.tags.client_release, "abc1234");
  const frames = event.exception.values[0].stacktrace.frames;
  assert.equal(frames.at(-1).function, "renderTracking");
  assert.equal(frames.at(-1).filename, "/preview/assets/index-abc123.js");
  assert.ok(frames.every((frame: any) => !frame.filename.includes("onrender.com")), "origin leaked into frames");
});

await run("/api/client-errors: malformed, unknown-source and oversized reports are dropped silently", async () => {
  enable();
  const cases = [
    { payload: { ...clientReport(), source: "attacker" } },
    { payload: { ...clientReport(), message: 42 } },
    { payload: { ...clientReport(), message: "" } },
    { payload: { ...clientReport(), stack: "x".repeat(8_001) } },
    { payload: [clientReport()] }
  ];
  for (const item of cases) {
    const response = await app.inject({ method: "POST", url: "/api/client-errors", payload: item.payload as any });
    assert.equal(response.statusCode, 204);
  }
  const oversized = await app.inject({ method: "POST", url: "/api/client-errors", payload: { ...clientReport(), padding: "x".repeat(20_000) } });
  assert.equal(oversized.statusCode, 413);
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 0);
});

await run("/api/client-errors: at most 10 reports per minute per IP are relayed", async () => {
  enable();
  for (let i = 0; i < 15; i += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/client-errors",
      remoteAddress: "198.51.100.23",
      payload: clientReport({ message: `distinct browser failure ${i}` })
    });
    assert.equal(response.statusCode, 204);
  }
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 10);
});

await run("/api/client-errors: a flood from rotating spoofed IPs is capped globally and cannot starve server errors", async () => {
  enable();
  for (let i = 0; i < 40; i += 1) {
    await app.inject({
      method: "POST",
      url: "/api/client-errors",
      headers: { "x-forwarded-for": `198.51.100.${i + 1}` },
      payload: clientReport({ message: `flood ${i}` })
    });
  }
  const response = await app.inject({ method: "POST", url: "/__monitoring-test/boom/after-flood" });
  assert.equal(response.statusCode, 500);
  await monitoring.flushMonitoring();
  const services = sent.map((envelope) => eventOf(envelope).tags.service);
  assert.equal(services.filter((service) => service === "browser").length, 10, "browser budget is not global");
  assert.equal(services.filter((service) => service === "web").length, 1, "server error was starved by the browser flood");
});

await run("/api/client-errors: personal data or tokens inside stack-frame paths are scrubbed", async () => {
  enable();
  await app.inject({
    method: "POST",
    url: "/api/client-errors",
    payload: clientReport({
      stack: `Error: x\n    at load (https://evil.example/${SENSITIVE.email}/${SENSITIVE.jwt}/app.js:1:2)\n    at go@https://evil.example/u/${SENSITIVE.phone_plain}/x.js:3:4`
    })
  });
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 1);
  assertNoSensitive(sent[0]!.body, "frame paths");
  const frames = eventOf(sent[0]!).exception.values[0].stacktrace.frames;
  assert.equal(frames.length, 2);
  assert.ok(frames.some((frame: any) => frame.filename.includes("[redacted:email]")), JSON.stringify(frames));
});

await run("normalizeClientRoute collapses ids and tokens", () => {
  assert.equal(monitoring.normalizeClientRoute("#/deal/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b"), "/deal/:param");
  assert.equal(monitoring.normalizeClientRoute("/app/track/AbC123xyz?t=1"), "/app/track/:param");
  assert.equal(monitoring.normalizeClientRoute("#/seller/profile"), "/seller/profile");
  assert.equal(monitoring.normalizeClientRoute(""), "/");
});

// ── 9 ──
await run("self-test event is opt-in, tagged, warning level and never thrown", async () => {
  enable();
  assert.equal(monitoring.captureSelfTestIfRequested("web"), null);
  process.env.SENTRY_SELF_TEST = "1";
  try {
    const id = monitoring.captureSelfTestIfRequested("worker");
    assert.match(String(id), /^[0-9a-f]{32}$/);
  } finally {
    delete process.env.SENTRY_SELF_TEST;
  }
  await monitoring.flushMonitoring();
  assert.equal(sent.length, 1);
  const event = eventOf(sent[0]!);
  assert.equal(event.level, "warning");
  assert.equal(event.tags.self_test, "true");
  assert.equal(event.tags.service, "worker");
  assert.equal(event.exception.values[0].type, "MonitoringSelfTestError");
  assert.equal(event.exception.values[0].mechanism.type, "self_test");
});

// ── 10 ──
await run("child process: an unhandled rejection is reported scrubbed and the process still exits 1", () => {
  const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "error_monitoring.js")).href;
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    m.initErrorMonitoring({ service: "worker", dsn: ${JSON.stringify(DSN)}, environment: "staging", release: "r1",
      transport: async (e) => { process.stdout.write("ENVELOPE " + e.body.replace(/\\n/g, " ") + "\\n"); } });
    m.installProcessErrorCapture(() => process.stdout.write("LOGGED_FATAL\\n"));
    Promise.reject(new Error("worker died for ${SENSITIVE.phone_intl} ${SENSITIVE.email}"));
    setTimeout(() => process.stdout.write("STILL_ALIVE\\n"), 5000);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 1, `exit status ${child.status}; stderr ${child.stderr}`);
  assert.ok(child.stdout.includes("LOGGED_FATAL"), "fatal was not logged");
  assert.ok(child.stdout.includes("ENVELOPE "), "no envelope was sent before exit");
  assert.ok(!child.stdout.includes("STILL_ALIVE"), "process kept running after an unhandled rejection");
  assertNoSensitive(child.stdout, "child envelope");
  assert.match(child.stdout, /"mechanism":\{"type":"onunhandledrejection","handled":false\}/);
  assert.match(child.stdout, /"level":"fatal"/);
});

await app.close();
monitoring.resetErrorMonitoringForTests();
console.log(`\nerror_monitoring_security_validation: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
process.exit(0);
