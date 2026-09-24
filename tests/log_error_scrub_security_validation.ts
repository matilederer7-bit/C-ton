// WORKER ERROR LOGS NEVER CARRY PERSONAL DATA OR CREDENTIALS.
//
// The outbox worker logs `{ err }` on every failed cycle, heartbeat and fatal
// path. A pg error carries the offending row in `detail`, a provider error can
// echo an Authorization header, and a wrapped error drags its whole `cause`
// chain along. src/log_redaction.ts (errorLogSerializer) scrubs every string
// the pino err serializer would emit; src/worker.ts wires it into `logger`.
//
// This file is adversarial: it tries to make a secret reach the serialized
// output through every channel it can think of, and tries to make the
// serializer throw or explode in size.
//
//   1. pg-style error (detail / hint / where / table / constraint), code kept
//   2. message and stack with email, JWT, bearer, password=, IP, card, phone
//   3. a three-level cause chain and nested custom objects / arrays
//   4. UUID correlation ids and `type` survive
//   5. hostile inputs never throw and always return an object
//   6. output stays bounded (5 MB input -> < 64 KB)
//   7. truncation boundaries do not cut a secret into a surviving fragment
//   8. the live worker logger uses errorLogSerializer, and a real pino line
//      written through it (including via a child logger) carries no secret
//   9. worker call sites always pass an explicit message (pino otherwise
//      copies the RAW err.message into `msg`, bypassing the serializer)

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.PORT = "3143";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-errlogscrub";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-errlogscrub";
process.env.ADMIN_API_KEY = "errlogscrub-admin-key";
delete process.env.SENTRY_DSN;
delete process.env.SENTRY_SELF_TEST;

const { errorLogSerializer } = await import("../src/log_redaction.js");
// Importing the worker module must not start the worker: its entry guard only
// runs main() when the worker file itself is argv[1].
const { logger } = await import("../src/worker.js");
const pinoModule: any = await import("pino");
const pino: any = pinoModule.default ?? pinoModule;
const serializersSym: symbol = pinoModule.symbols?.serializersSym ?? pinoModule.default?.symbols?.serializersSym;

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

// Synthetic sensitive values, built at runtime so no scanner mistakes this
// file for a leak. Every one must be absent from every serialized result.
const b64url = (value: string) => Buffer.from(value).toString("base64url");
const JWT = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"buyer-errlog-test"}')}.c2lnbmF0dXJlLWVycmxvZy10ZXN0`;
const API_KEY = ["sk", "errlog", "7f3c9a1b2d4e6f8091a2b3c4d5e6f7a8b9"].join("_");
const SENSITIVE = {
  email: "buyer.real@example.com",
  email_seller: "seller.private@example.com",
  phone_local: "050-1234567",
  phone_plain: "0501234567",
  phone_intl: "+972501234567",
  card: "4111 1111 1111 1111",
  card_plain: "4111111111111111",
  jwt: JWT,
  bearer: "bearer-secret-value-9f8e7d",
  password: "hunter2-errlog",
  token_pair: "tokvalue-errlog-55aa",
  ip: "203.0.113.77",
  ip_other: "203.0.113.9",
  api_key: API_KEY,
  query_token: "trackingtokenvalue123abc"
} as const;
const DEAL_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

// A leak of any fragment below is also a leak (they only exist inside the
// sensitive values above).
const FRAGMENTS = ["hunter2", "bearer-secret", "tokvalue-errlog", "buyer.real", "seller.private", "1234567", "4111 1111", "41111111", "203.0.113", "trackingtokenvalue"];

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)) ?? "";
}

function findLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const [name, value] of Object.entries(SENSITIVE)) if (text.includes(value)) leaks.push(name);
  for (const fragment of FRAGMENTS) if (text.includes(fragment)) leaks.push(`fragment:${fragment}`);
  return leaks;
}

function assertNoLeak(result: unknown, label: string) {
  const text = stringify(result);
  assert.deepEqual(findLeaks(text), [], `${label} leaked: ${text.slice(0, 400)}`);
}

function serializeSafely(input: unknown, label: string): Record<string, unknown> {
  let result: unknown;
  try {
    result = errorLogSerializer(input);
  } catch (error) {
    throw new Error(`${label}: errorLogSerializer threw ${(error as any)?.name}: ${(error as any)?.message}`);
  }
  assert.ok(result !== null && typeof result === "object" && !Array.isArray(result), `${label}: result is not a plain object`);
  let text = "";
  try { text = stringify(result); } catch (error) {
    throw new Error(`${label}: result is not JSON-serializable (${(error as any)?.message})`);
  }
  assert.ok(text.length > 2, `${label}: result is empty`);
  return result as Record<string, unknown>;
}

const SECRET_SENTENCE =
  `buyer ${SENSITIVE.email} phone ${SENSITIVE.phone_local} alt ${SENSITIVE.phone_intl} ` +
  `card ${SENSITIVE.card} jwt ${JWT} Authorization: Bearer ${SENSITIVE.bearer} ` +
  `password=${SENSITIVE.password} token=${SENSITIVE.token_pair} from ${SENSITIVE.ip} key ${API_KEY} ` +
  `url https://api.example.com/track?t=${SENSITIVE.query_token}`;

// ── 1 ──
// pino's err serializer takes `type` from the constructor name, as pg's own
// DatabaseError class does.
class DatabaseError extends Error {}
class SettlementError extends Error {}

await run("pg unique-violation: detail/hint/where/table/constraint carry no PII, code stays 23505", () => {
  const err: any = new DatabaseError(`duplicate key value violates unique constraint "participants_phone_key" for ${SENSITIVE.phone_plain}`);
  err.code = "23505";
  err.severity = "ERROR";
  err.detail = `Key (phone)=(${SENSITIVE.phone_plain}) already exists.`;
  err.hint = `Contact ${SENSITIVE.email} or retry with token=${SENSITIVE.token_pair}`;
  err.where = `SQL statement "INSERT INTO participants VALUES ('${SENSITIVE.email_seller}', '${SENSITIVE.phone_intl}')" PL/pgSQL function upsert_participant() line 7`;
  err.table = "participants";
  err.constraint = "participants_phone_key";
  err.schema = "public";
  err.routine = "_bt_check_unique";
  const result = serializeSafely(err, "pg error");
  assertNoLeak(result, "pg error");
  assert.equal(result.code, "23505", "the pg error code must survive for triage");
  assert.equal(result.type, "DatabaseError", "type must survive");
  const text = stringify(result);
  assert.ok(text.includes("participants_phone_key"), "non-sensitive constraint name should remain for triage");
});

await run("pg error with Key (a, b)=(x, y) composite detail and a pg column-level detail are scrubbed", () => {
  const err: any = new Error("insert or update violates foreign key constraint");
  err.code = "23503";
  err.detail = `Key (email, phone)=(${SENSITIVE.email}, ${SENSITIVE.phone_local}) is not present in table "sellers".`;
  err.column = "email";
  err.dataType = "text";
  err.internalQuery = `select * from sellers where email = '${SENSITIVE.email_seller}' and card = '${SENSITIVE.card_plain}'`;
  const result = serializeSafely(err, "pg fk error");
  assertNoLeak(result, "pg fk error");
  assert.equal(result.code, "23503");
});

// ── 2 ──
await run("message and stack with email, JWT, bearer, password=, IP, card, phone, API key, query token are scrubbed", () => {
  const err: any = new Error(`provider call failed: ${SECRET_SENTENCE}`);
  err.stack = `Error: provider call failed: ${SECRET_SENTENCE}\n    at callProvider (/app/src/provider.ts:10:5)\n    at ${SENSITIVE.email_seller} (/app/src/x.ts:1:1)`;
  const result = serializeSafely(err, "message+stack");
  assertNoLeak(result, "message+stack");
  assert.equal(typeof result.message, "string");
  assert.equal(typeof result.stack, "string");
  assert.ok(String(result.stack).includes("callProvider"), "stack frames (function names) should survive");
});

await run("sensitive values in non-standard string properties and in the error name are scrubbed", () => {
  const err: any = new Error("request failed");
  err.name = `ProviderError ${SENSITIVE.email}`;
  err.url = `https://api.example.com/v1/charge?card=${SENSITIVE.card_plain}&token=${SENSITIVE.token_pair}`;
  err.responseBody = `{"email":"${SENSITIVE.email}","phone":"${SENSITIVE.phone_intl}"}`;
  err.authorization = `Bearer ${SENSITIVE.bearer}`;
  err.requestHeaders = { authorization: `Bearer ${JWT}`, "x-forwarded-for": SENSITIVE.ip };
  const result = serializeSafely(err, "custom props");
  assertNoLeak(result, "custom props");
});

// An HTTP client error (axios-style `config.headers`, `response.headers`)
// carries credentials whose VALUE has no recognisable shape; only the KEY
// says it is secret. Free-text scrubbing alone cannot see that.
await run("values under credential-named keys (cookie, set-cookie, x-api-key, authorization) are redacted whatever their shape", () => {
  const err: any = new Error("upstream 502");
  err.config = { headers: { cookie: `session=${SENSITIVE.password}`, "x-api-key": "tokvalue-errlog-55aa", authorization: "Basic" } };
  err.response = { status: 502, headers: { "set-cookie": [`sid=${SENSITIVE.bearer}; Path=/; HttpOnly`] } };
  const result = serializeSafely(err, "credential keys");
  assertNoLeak(result, "credential keys");
});

// ── 3 ──
await run("a three-level cause chain carries no sensitive value at any level", () => {
  const root: any = new Error(`connect ECONNREFUSED ${SENSITIVE.ip}:5432 user ${SENSITIVE.email}`);
  root.code = "ECONNREFUSED";
  root.address = SENSITIVE.ip_other;
  const middle: any = new Error(`query failed for ${SENSITIVE.phone_local}`, { cause: root });
  middle.detail = `Key (card)=(${SENSITIVE.card_plain})`;
  const top: any = new Error(`outbox event failed: password=${SENSITIVE.password}`, { cause: middle });
  top.stack = `Error: outbox event failed: Authorization: Bearer ${SENSITIVE.bearer}\n    at worker (/app/src/worker.ts:1:1)`;
  const result = serializeSafely(top, "cause chain");
  assertNoLeak(result, "cause chain");
  // The chain must be represented, not silently dropped, or triage is lost.
  assert.ok(stringify(result).includes("ECONNREFUSED"), "the root cause code should survive somewhere in the output");
});

await run("a non-Error cause (plain object, string, array) is scrubbed too", () => {
  const err: any = new Error("wrapped", { cause: { buyer: SENSITIVE.email, nested: [SENSITIVE.phone_intl, { jwt: JWT }] } });
  const result1 = serializeSafely(err, "object cause");
  assertNoLeak(result1, "object cause");
  const err2: any = new Error("wrapped", { cause: `raw ${SENSITIVE.email} ${SENSITIVE.card}` });
  assertNoLeak(serializeSafely(err2, "string cause"), "string cause");
  const err3: any = new Error("wrapped", { cause: [SENSITIVE.api_key, [SENSITIVE.ip, [SENSITIVE.phone_plain]]] });
  assertNoLeak(serializeSafely(err3, "array cause"), "array cause");
});

await run("AggregateError children and nested custom objects / arrays are scrubbed", () => {
  const agg: any = new AggregateError([
    new Error(`child one ${SENSITIVE.email}`),
    Object.assign(new Error("child two"), { detail: `Key (phone)=(${SENSITIVE.phone_plain}) already exists.` }),
    `plain string child ${SENSITIVE.card_plain}`
  ], `batch failed for ${SENSITIVE.email_seller}`);
  agg.payload = {
    buyer: { email: SENSITIVE.email, phones: [SENSITIVE.phone_local, SENSITIVE.phone_intl] },
    headers: [["authorization", `Bearer ${SENSITIVE.bearer}`], ["x-real-ip", SENSITIVE.ip]],
    deep: { a: { b: { c: { d: `password=${SENSITIVE.password}` } } } },
    map: new Map([["k", SENSITIVE.email]]),
    set: new Set([SENSITIVE.phone_intl])
  };
  const result = serializeSafely(agg, "aggregate");
  assertNoLeak(result, "aggregate");
});

await run("a property NAME that carries PII does not leak it", () => {
  const err: any = new Error("keyed");
  err[SENSITIVE.email] = "value";
  err.byUser = { [SENSITIVE.phone_intl]: 1, [`token=${SENSITIVE.token_pair}`]: true };
  const result = serializeSafely(err, "pii keys");
  assertNoLeak(result, "pii keys");
});

// ── 4 ──
await run("a UUID correlation id in the message survives and `type` survives", () => {
  const err: any = new SettlementError(`deal ${DEAL_ID} failed to settle for ${SENSITIVE.email}`);
  err.deal_id = DEAL_ID;
  const result = serializeSafely(err, "uuid");
  assertNoLeak(result, "uuid");
  assert.equal(result.type, "SettlementError");
  assert.ok(String(result.message).includes(DEAL_ID), "the UUID in the message must survive");
  assert.ok(stringify(result).includes(`"${DEAL_ID}"`) || stringify(result).includes(DEAL_ID), "the UUID property must survive");
});

await run("`type` of a plain Error and a subclass are kept", () => {
  class OutboxDeliveryError extends Error {}
  const plain = serializeSafely(new Error("x"), "plain type");
  assert.equal(plain.type, "Error");
  const sub = serializeSafely(new OutboxDeliveryError(`to ${SENSITIVE.email}`), "subclass type");
  assert.equal(sub.type, "OutboxDeliveryError");
  assertNoLeak(sub, "subclass type");
});

// ── 5 ──
await run("a circular error (self reference, cause cycle, object cycle) never throws and does not leak", () => {
  const err: any = new Error(`circular ${SENSITIVE.email}`);
  err.self = err;
  const other: any = new Error(`other ${SENSITIVE.phone_intl}`, { cause: err });
  err.cause = other;
  const bag: any = { email: SENSITIVE.email_seller };
  bag.loop = bag;
  bag.list = [bag, err];
  err.bag = bag;
  const result = serializeSafely(err, "circular");
  assertNoLeak(result, "circular");
});

await run("a property getter that throws (including on message and stack) never throws", () => {
  const err: any = new Error(`getter ${SENSITIVE.email}`);
  Object.defineProperty(err, "boom", { enumerable: true, get() { throw new Error(`getter exploded ${SENSITIVE.phone_intl}`); } });
  assertNoLeak(serializeSafely(err, "throwing getter"), "throwing getter");

  const err2: any = new Error("x");
  Object.defineProperty(err2, "message", { enumerable: false, configurable: true, get() { throw new Error("no message for you"); } });
  Object.defineProperty(err2, "stack", { enumerable: false, configurable: true, get() { throw new Error("no stack for you"); } });
  serializeSafely(err2, "throwing message/stack getters");

  const err3: any = new Error("x");
  err3.toJSON = () => { throw new Error(`toJSON exploded ${SENSITIVE.email}`); };
  err3.nested = { toString() { throw new Error("toString exploded"); }, toJSON() { throw new Error("nested toJSON"); } };
  assertNoLeak(serializeSafely(err3, "throwing toJSON"), "throwing toJSON");
});

await run("a Proxy error whose traps throw never throws", () => {
  const trap = () => { throw new Error(`trap ${SENSITIVE.email}`); };
  const hostile = new Proxy(new Error("proxied"), { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, has: trap });
  assertNoLeak(serializeSafely(hostile, "proxy"), "proxy");
  const hostilePlain = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  assertNoLeak(serializeSafely(hostilePlain, "proxy plain"), "proxy plain");
});

await run("odd property types (BigInt, Symbol, function, Buffer, Date, non-string message) never throw or leak", () => {
  const err: any = new Error("odd");
  err.big = 10n ** 30n;
  err.sym = Symbol(`sym ${SENSITIVE.email}`);
  err[Symbol("hidden")] = SENSITIVE.phone_intl;
  err.fn = function leak() { return SENSITIVE.email; };
  err.when = new Date(0);
  err.invalidDate = new Date(Number.NaN);
  err.buf = Buffer.from(`buffer ${SENSITIVE.email}`);
  err.u8 = new TextEncoder().encode(SENSITIVE.phone_intl);
  assertNoLeak(serializeSafely(err, "odd types"), "odd types");
  const err2: any = new Error("x");
  Object.defineProperty(err2, "message", { value: { email: SENSITIVE.email, card: SENSITIVE.card }, enumerable: true, configurable: true });
  assertNoLeak(serializeSafely(err2, "object message"), "object message");
  const nullProto = Object.assign(Object.create(null), { message: `null proto ${SENSITIVE.email}`, code: "E_NULL" });
  assertNoLeak(serializeSafely(nullProto, "null prototype"), "null prototype");
});

const HUGE_BYTES = 5 * 1024 * 1024;
await run("a 5 MB message/stack/detail never throws, does not leak, and the result JSON is < 64 KB", () => {
  const unit = `${SENSITIVE.email} ${SENSITIVE.phone_local} ${SENSITIVE.card} password=${SENSITIVE.password} `;
  const huge = unit.repeat(Math.ceil(HUGE_BYTES / unit.length)).slice(0, HUGE_BYTES);
  const err: any = new Error(huge);
  err.stack = huge;
  err.detail = huge;
  err.list = [huge, huge];
  err.nested = { a: huge };
  const started = Date.now();
  const result = serializeSafely(err, "5MB");
  const elapsed = Date.now() - started;
  const text = stringify(result);
  assert.ok(text.length < 64 * 1024, `result is ${text.length} bytes`);
  assertNoLeak(result, "5MB");
  assert.ok(elapsed < 5_000, `serializing took ${elapsed} ms`);
});

await run("very many properties and a very long array stay bounded", () => {
  const err: any = new Error("wide");
  for (let index = 0; index < 20_000; index += 1) err[`p${index}`] = `${SENSITIVE.email} ${index}`;
  err.arr = Array.from({ length: 100_000 }, () => SENSITIVE.phone_intl);
  const result = serializeSafely(err, "wide");
  assert.ok(stringify(result).length < 64 * 1024, `wide result is ${stringify(result).length} bytes`);
  assertNoLeak(result, "wide");
});

await run("deep nesting (depth 100) in properties and in the cause chain never throws, stays bounded, does not leak", () => {
  let nested: any = { secret: SENSITIVE.email };
  for (let depth = 0; depth < 100; depth += 1) nested = { level: depth, child: nested, phone: SENSITIVE.phone_intl };
  const err: any = new Error("deep");
  err.nested = nested;
  let arr: any = [SENSITIVE.card_plain];
  for (let depth = 0; depth < 100; depth += 1) arr = [arr, SENSITIVE.ip];
  err.arr = arr;
  const r1 = serializeSafely(err, "deep props");
  assertNoLeak(r1, "deep props");
  assert.ok(stringify(r1).length < 64 * 1024);

  let chain: any = new Error(`root ${SENSITIVE.email}`);
  for (let depth = 0; depth < 100; depth += 1) chain = new Error(`level ${depth} ${SENSITIVE.phone_local}`, { cause: chain });
  const r2 = serializeSafely(chain, "deep cause");
  assertNoLeak(r2, "deep cause");
  assert.ok(stringify(r2).length < 64 * 1024);
});

await run("non-Error values (string with email, null, undefined, number, boolean, plain object, array) return a safe object", () => {
  const inputs: Array<[string, unknown]> = [
    ["string", `raw failure for ${SENSITIVE.email} at ${SENSITIVE.ip}`],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["NaN", Number.NaN],
    ["boolean", false],
    ["bigint", 12345678901234567890n],
    ["symbol", Symbol(SENSITIVE.email)],
    ["function", () => SENSITIVE.email],
    ["plain object", { message: `obj ${SENSITIVE.email}`, code: "E_PLAIN", detail: `Key (phone)=(${SENSITIVE.phone_plain})`, nested: { jwt: JWT } }],
    ["array", [SENSITIVE.email, { card: SENSITIVE.card_plain }]],
    ["Error-like with stack", { name: "Fake", message: "fake", stack: `Fake: ${SENSITIVE.email}\n    at x (/a.ts:1:1)` }]
  ];
  for (const [label, input] of inputs) assertNoLeak(serializeSafely(input, label), label);
});

// ── 7 ──
// scrubText truncates BEFORE it scrubs. If the cut lands inside a secret, the
// surviving prefix no longer matches its pattern (a 7-digit phone prefix, an
// email local part without its domain) and would be written verbatim. Filler
// made of long emails shrinks ~13x under scrubbing, so the cut point moves
// well inside the final output. Several plausible cut points are probed.
await run("a secret cut in half by a truncation boundary does not survive as a fragment", () => {
  const unit = `${"a".repeat(200)}@example.com `;
  function filler(length: number) {
    let text = "";
    while (text.length + unit.length <= length) text += unit;
    return text + " ".repeat(length - text.length);
  }
  const leaks: string[] = [];
  const secrets = [SENSITIVE.phone_plain, SENSITIVE.email, SENSITIVE.card_plain, `password=${SENSITIVE.password}`];
  for (const cut of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 65_536]) {
    for (const secret of secrets) {
      for (const keep of [7, 8, 9, 10, 11, 12]) {
        if (keep >= secret.length) continue;
        const message = filler(cut - keep) + secret + " tail";
        for (const field of ["message", "detail"] as const) {
          const err: any = new Error(field === "message" ? message : "boundary");
          if (field === "detail") err.detail = message;
          let result: unknown;
          try { result = errorLogSerializer(err); } catch { leaks.push(`cut=${cut} keep=${keep} ${field}: threw`); continue; }
          const found = findLeaks(stringify(result));
          if (found.length) leaks.push(`cut=${cut} keep=${keep} ${field}: ${found.join(",")}`);
        }
      }
    }
  }
  assert.deepEqual(leaks.slice(0, 10), [], `${leaks.length} boundary cases leaked a fragment`);
});

// ── 8 ──
await run("the live worker logger uses errorLogSerializer for `err` (and so do its children)", () => {
  assert.ok(serializersSym, "pino serializers symbol unavailable");
  assert.equal((logger as any)[serializersSym]?.err, errorLogSerializer, "worker logger err serializer is not errorLogSerializer");
  const child = (logger as any).child({ worker_id: "test-worker" });
  assert.equal(child[serializersSym]?.err, errorLogSerializer, "child logger lost the err serializer");
});

function hostileError() {
  const root: any = new Error(`connect failed ${SENSITIVE.ip}`);
  const err: any = new Error(`worker cycle failed for ${SENSITIVE.email} deal ${DEAL_ID}`, { cause: root });
  err.code = "23505";
  err.detail = `Key (phone)=(${SENSITIVE.phone_plain}) already exists.`;
  err.hint = `Authorization: Bearer ${SENSITIVE.bearer}`;
  err.stack = `Error: ${SECRET_SENTENCE}\n    at cycle (/app/src/worker.ts:130:7)`;
  err.self = err;
  return err;
}

await run("a real pino line written with errorLogSerializer (root and child logger) carries no sensitive value", () => {
  const chunks: string[] = [];
  const destination = { write(chunk: string) { chunks.push(String(chunk)); return true; } };
  const testLogger = pino({ level: "info", serializers: { err: errorLogSerializer } }, destination);
  testLogger.error({ err: hostileError(), worker_id: "w1" }, "worker_cycle_failed");
  testLogger.child({ worker_id: "w2" }).error({ err: hostileError() }, "worker_cycle_failed");
  testLogger.child({ worker_id: "w3" }).child({ attempt: 2 }).warn({ attempt: 2, err: hostileError() }, "worker_waiting_for_migrated_database");
  assert.equal(chunks.length, 3, `expected 3 log lines, got ${chunks.length}`);
  for (const line of chunks) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.err?.code, "23505", "code must survive in the log line");
    assert.equal(typeof parsed.err?.type, "string");
    assert.ok(line.includes(DEAL_ID), "the correlation UUID should survive in the log line");
    assert.deepEqual(findLeaks(line), [], `log line leaked: ${line.slice(0, 400)}`);
  }
});

// ── 9 ──
// pino copies the RAW err.message into `msg` when no message argument is
// given (`logger.error({ err })` or `logger.error(err)`), which bypasses the
// serializer entirely. Every worker call site must pass an explicit message.
await run("every worker log call that carries an error passes an explicit message string", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "worker.ts"), "utf8");
  const offenders: string[] = [];
  const callPattern = /logger\.(trace|debug|info|warn|error|fatal)\(([^;]*?)\);/gs;
  for (const match of source.matchAll(callPattern)) {
    const args = match[2]!;
    const carriesError = /\berr\s*:/.test(args) || /^\s*(error|err|e)\s*$/.test(args);
    if (!carriesError) continue;
    if (!/\}\s*,\s*["'`]/.test(args)) offenders.push(match[0].replace(/\s+/g, " ").slice(0, 120));
  }
  assert.deepEqual(offenders, [], "a worker log call relies on pino's default msg (raw err.message)");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
