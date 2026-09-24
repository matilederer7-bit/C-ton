// WORKER ERROR LOGS NEVER CARRY PERSONAL DATA OR CREDENTIALS.
//
// The outbox worker logs `{ err }` on every failed cycle, heartbeat and fatal
// path. A pg error carries the offending row in `detail`, a provider error can
// echo an Authorization header, and a wrapped error drags its whole `cause`
// chain along. src/log_redaction.ts (errorLogSerializer) keeps only an
// allowlist of error keys, scrubs every string it keeps, and src/worker.ts
// wires it into `logger`.
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
//   6. output stays bounded (5 MB input -> < 64 KB); numbers, binary and
//      __proto__; contract v3 allowlist (only known error keys survive,
//      `omitted_keys` counts the rest; pg detail/hint/where are dropped and
//      quoted spans in a pg message are redacted)
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

// Contract v3: the serializer emits ONLY these keys (plus `omitted_keys`, a
// count, when anything was dropped). cause / errors follow the same rules.
const ALLOWED_KEYS = new Set([
  "type", "message", "stack", "code", "errno", "syscall", "status", "statusCode", "severity", "routine",
  "schema", "table", "column", "constraint", "dataType", "position", "cause", "errors",
  "omitted_keys"
]);

function allowlistViolations(value: unknown, where: string, out: string[], depth = 0) {
  if (value === null || typeof value !== "object" || depth > 12) return;
  if (Array.isArray(value)) { out.push(`${where}: an error serialized as an array`); return; }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") out.push(`${where}.<symbol>`);
    else if (!ALLOWED_KEYS.has(key)) out.push(`${where}.${key}`);
  }
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "omitted_keys")) {
    const count = record.omitted_keys;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) out.push(`${where}.omitted_keys is not a positive integer count`);
  }
  const proto = Object.getPrototypeOf(record);
  if (proto !== Object.prototype && proto !== null) out.push(`${where}: unexpected prototype`);
  if (Object.prototype.hasOwnProperty.call(record, "cause")) allowlistViolations(record.cause, `${where}.cause`, out, depth + 1);
  if (Object.prototype.hasOwnProperty.call(record, "errors")) {
    const errors = record.errors;
    if (!Array.isArray(errors)) out.push(`${where}.errors is not an array`);
    else {
      // At most 20 serialized children; one trailing string marker such as
      // "[30 more errors]" is allowed.
      const objects = errors.filter((child) => child !== null && typeof child === "object").length;
      if (objects > 20 || errors.length > 21) out.push(`${where}.errors has ${errors.length} entries (${objects} objects; max 20)`);
      errors.forEach((child, index) => allowlistViolations(child, `${where}.errors[${index}]`, out, depth + 1));
    }
  }
}

function assertAllowlisted(result: unknown, label: string) {
  const violations: string[] = [];
  allowlistViolations(result, "err", violations);
  assert.deepEqual(violations.slice(0, 10), [], `${label}: output outside the v2 allowlist`);
}

// Dropped key NAMES must not appear either (the count is all that is kept).
function assertNoKeyNames(result: unknown, names: string[], label: string) {
  const text = stringify(result);
  const found = names.filter((name) => text.includes(`"${name}"`));
  assert.deepEqual(found, [], `${label}: dropped key name(s) present: ${text.slice(0, 300)}`);
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
  assert.ok(text.startsWith("{"), `${label}: result does not serialize as an object`);
  assertAllowlisted(result, label);
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
  assertPgEchoDropped(result, "pg error", 3);
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

// ── 6b. Numbers, binary payloads and __proto__ keys ──
// A phone or card stored as a NUMBER never passes through a string scrubber,
// and JSON.stringify writes its digits verbatim. A Buffer serializes as a
// byte array that decodes straight back to the text it carried. Under v2 only
// allowlisted keys carry values, so these are planted on allowlisted keys.

await run("numbers and bigints whose digits look like a phone or card are redacted; ordinary numbers are kept", () => {
  const err: any = new Error("numeric");
  err.errno = 972501234567;
  err.status = 4111111111111111;
  err.statusCode = 972501234567n;
  err.position = 4111111111111111n;
  err.code = 23505;
  err.phone = 972501234567;          // not allowlisted: dropped entirely
  err.cause = Object.assign(new Error("inner"), { errno: 972501234567, status: 42 });
  const result: any = serializeSafely(err, "numbers");
  assertNoLeak(result, "numbers");
  const text = stringify(result);
  assert.ok(!text.includes("972501234567") && !text.includes("4111111111111111"), `numeric digits leaked: ${text.slice(0, 300)}`);
  for (const key of ["errno", "status", "statusCode", "position"]) assert.equal(result[key], "[redacted:number]", `${key} was not redacted`);
  assert.equal(result.code, 23505, "an ordinary number (23505) must stay a number");
  assert.equal(result.phone, undefined, "a non-allowlisted numeric key was kept");
  assert.equal(result.cause?.errno, "[redacted:number]");
  assert.equal(result.cause?.status, 42);

  const ordinary = Object.assign(new Error("ordinary"), { errno: -111, status: 500, statusCode: 42, position: 17, code: 23505 });
  const kept: any = serializeSafely(ordinary, "ordinary numbers");
  assert.equal(kept.errno, -111);
  assert.equal(kept.status, 500);
  assert.equal(kept.statusCode, 42);
  assert.equal(kept.position, 17);
  assert.equal(kept.code, 23505);
});

await run("Buffer, typed arrays, ArrayBuffer and DataView are emitted as `[binary N bytes]`, never their contents", () => {
  const buf = Buffer.from(`buffer ${SENSITIVE.email} ${SENSITIVE.phone_intl}`);
  const u8 = new TextEncoder().encode(`u8 ${SENSITIVE.card_plain}`);
  const u16 = new Uint16Array([0x3530, 0x3130, 0x3332, 0x3534]);
  const ab = new TextEncoder().encode(`ab password=${SENSITIVE.password}`).buffer;
  const dv = new DataView(new TextEncoder().encode(`dv ${SENSITIVE.email_seller}`).buffer);
  const err: any = new Error("binary");
  Object.assign(err, { table: buf, column: u8, constraint: ab, schema: dv, dataType: u16, payload: buf, detail: buf });
  err.cause = { message: "inner", table: buf };
  const result: any = serializeSafely(err, "binary");
  assertNoLeak(result, "binary");
  assert.equal(result.table, `[binary ${buf.byteLength} bytes]`);
  assert.equal(result.column, `[binary ${u8.byteLength} bytes]`);
  assert.equal(result.constraint, `[binary ${ab.byteLength} bytes]`);
  assert.equal(result.schema, `[binary ${dv.byteLength} bytes]`);
  assert.equal(result.dataType, `[binary ${u16.byteLength} bytes]`);
  assert.equal(result.payload, undefined, "a non-allowlisted binary key was kept");
  assert.equal(result.detail, undefined, "detail must be dropped under v3");
  assert.equal(result.cause?.table, `[binary ${buf.byteLength} bytes]`);
  // No byte array anywhere: the decoded bytes would be the secret.
  assert.ok(!/"data"\s*:\s*\[/.test(stringify(result)), "a Buffer was serialized as its byte array");
  // A bare Buffer as the logged value.
  assertNoLeak(serializeSafely(buf, "bare buffer"), "bare buffer");
});

await run("a `__proto__` key is dropped and counted, never becomes the prototype, and never pollutes Object.prototype", () => {
  const err: any = new Error("proto");
  Object.defineProperty(err, "__proto__", {
    value: { polluted: "yes", phone: SENSITIVE.phone_intl, inner: { card: SENSITIVE.card_plain } },
    enumerable: true, writable: true, configurable: true
  });
  err.cause = JSON.parse(`{"message":"inner","__proto__":{"polluted":"yes","isAdmin":true,"email":"${SENSITIVE.email}"},"table":"ok_table"}`);
  assert.ok(Object.prototype.hasOwnProperty.call(err, "__proto__"), "fixture: __proto__ must be an own property");
  const result: any = serializeSafely(err, "__proto__");
  assertNoLeak(result, "__proto__");
  assert.equal(({} as any).polluted, undefined, "Object.prototype was polluted");
  assert.equal(({} as any).isAdmin, undefined, "Object.prototype was polluted");
  assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "__proto__"), "__proto__ was kept");
  assert.equal(Object.getPrototypeOf(result), Object.prototype, "the result was re-parented");
  assert.equal(result.polluted, undefined, "the result inherited from the hostile __proto__ value");
  assert.equal(typeof result.omitted_keys, "number");
  assert.ok(result.omitted_keys >= 1, "the dropped __proto__ key was not counted");
  assert.ok(result.cause && typeof result.cause === "object", "the plain-object cause disappeared");
  assert.ok(!Object.prototype.hasOwnProperty.call(result.cause, "__proto__"), "nested __proto__ was kept");
  assert.equal(result.cause.isAdmin, undefined, "the cause inherited from the hostile __proto__ value");
  assert.equal(result.cause.table, "ok_table");
  assert.equal(typeof result.cause.omitted_keys, "number");
  const text = stringify(result);
  assert.ok(!text.includes('"__proto__"'), "__proto__ key present in the JSON");
  JSON.parse(text);
  assert.equal(({} as any).polluted, undefined);
});

// ── 6c. Contract v2: allowlist ──
// Free-text scrubbing cannot recognise a name or a street address, and a
// credential with a short opaque value has no shape at all. The only safe
// rule is to drop every key that is not on the allowlist.

const PERSON_NAME = ["Jane", "Doe"].join(" ");
const STREET = ["12", "Herzl", "St"].join(" ");
const PERSON_FRAGMENTS = [PERSON_NAME, STREET, "Jane", "Herzl"];
const DB_URL = ["postgres", "://", "svc_worker", ":", "pw7h3kq", "@", "db.internal.example.com", ":5432/siton"].join("");
const REPO_CREDENTIALS: Record<string, string> = {
  "x-admin-key": ["adm", "9x7q"].join("-"),
  DATABASE_URL: DB_URL,
  SITON_STORAGE_BROKER_KEY: ["brk", "4f2a"].join("-"),
  GROW_REFERENCE_ENCRYPTION_KEY: ["grw", "81kq"].join("-")
};
const DROPPED_NAMES = ["buyer_name", "delivery_address", "response", "config", "request", "body", "env", ...Object.keys(REPO_CREDENTIALS)];

function assertNoPerson(result: unknown, label: string) {
  const text = stringify(result);
  const found = PERSON_FRAGMENTS.filter((fragment) => text.includes(fragment));
  assert.deepEqual(found, [], `${label} leaked a name or address: ${text.slice(0, 400)}`);
}

function assertNoRepoCredential(result: unknown, label: string) {
  const text = stringify(result);
  const found = Object.entries(REPO_CREDENTIALS).filter(([, value]) => text.includes(value)).map(([key]) => key);
  if (text.includes("pw7h3kq") || text.includes("svc_worker")) found.push("DATABASE_URL fragment");
  assert.deepEqual(found, [], `${label} leaked a credential value: ${text.slice(0, 400)}`);
}

await run("names and addresses under arbitrary keys (buyer_name, delivery_address, response.data, config.data, request.body) never appear", () => {
  const err: any = new Error("provider rejected the order");
  err.buyer_name = PERSON_NAME;
  err.delivery_address = STREET;
  err.response = { status: 422, data: { buyer: { name: PERSON_NAME, address: STREET } } };
  err.config = { url: "/orders", data: JSON.stringify({ buyer_name: PERSON_NAME, delivery_address: STREET }) };
  err.request = { body: { name: PERSON_NAME, address: STREET } };
  err.status = 422;
  const result: any = serializeSafely(err, "person keys");
  assertNoPerson(result, "person keys");
  assertNoKeyNames(result, DROPPED_NAMES, "person keys");
  assert.equal(result.status, 422, "an allowlisted key was dropped");
  assert.equal(typeof result.omitted_keys, "number");
  assert.ok(result.omitted_keys >= 5, `omitted_keys=${result.omitted_keys}, expected at least 5`);
});

await run("repo credential keys (x-admin-key, DATABASE_URL, SITON_STORAGE_BROKER_KEY, GROW_REFERENCE_ENCRYPTION_KEY) with short opaque values never appear", () => {
  const err: any = new Error("storage broker call failed");
  Object.assign(err, REPO_CREDENTIALS);
  err.config = { headers: { "x-admin-key": REPO_CREDENTIALS["x-admin-key"] } };
  err.env = { ...REPO_CREDENTIALS };
  err.cause = Object.assign(new Error("inner"), REPO_CREDENTIALS);
  const agg: any = new AggregateError([Object.assign(new Error("child"), REPO_CREDENTIALS)], "batch");
  for (const [label, input] of [["top", err], ["aggregate", agg]] as const) {
    const result = serializeSafely(input, `repo credentials ${label}`);
    assertNoRepoCredential(result, `repo credentials ${label}`);
    assertNoKeyNames(result, DROPPED_NAMES, `repo credentials ${label}`);
  }
});

await run("`omitted_keys` is a count only: absent when nothing is dropped, exact for one key, and not attacker-controlled", () => {
  const clean = serializeSafely(Object.assign(new Error("clean"), { code: "E1" }), "clean");
  assert.ok(!Object.prototype.hasOwnProperty.call(clean, "omitted_keys"), "omitted_keys present although nothing was dropped");
  const one = serializeSafely(Object.assign(new Error("one"), { buyer_name: PERSON_NAME }), "one dropped");
  assert.equal(one.omitted_keys, 1);
  assertNoPerson(one, "one dropped");
  assertNoKeyNames(one, ["buyer_name"], "one dropped");
  // An attacker who sets `omitted_keys` itself must not smuggle text through it.
  const forged = serializeSafely(Object.assign(new Error("forged"), { omitted_keys: PERSON_NAME, delivery_address: STREET }), "forged count");
  assert.equal(typeof forged.omitted_keys, "number", "omitted_keys was taken from the input");
  assertNoPerson(forged, "forged count");
});

// Contract v3: pg `detail`, `hint` and `where` echo the offending row, SQL
// literals and JSON input in too many shapes to redact reliably (three
// separate leaks were found here), so they are DROPPED and counted. Every
// payload below must vanish together with its key.


function assertPgEchoDropped(result: any, label: string, planted: number) {
  for (const key of ["detail", "hint", "where"]) assert.ok(!Object.prototype.hasOwnProperty.call(result, key), `${label}: \`${key}\` survived`);
  assert.equal(typeof result.omitted_keys, "number", `${label}: omitted_keys missing`);
  assert.ok(result.omitted_keys >= planted, `${label}: omitted_keys=${result.omitted_keys}, expected >= ${planted}`);
}

await run("pg `Key (...)=(...)` and `Failing row contains (...)` in detail/hint/where are dropped; code, table, constraint survive", () => {
  const unique = Object.assign(new DatabaseError(`duplicate key value violates unique constraint "participants_buyer_name_key"`), {
    code: "23505", severity: "ERROR", routine: "_bt_check_unique", table: "participants", constraint: "participants_buyer_name_key", schema: "public",
    detail: `Key (buyer_name)=(${PERSON_NAME}) already exists.`,
    hint: `Compare Key (buyer_name, delivery_address)=(${PERSON_NAME}, ${STREET}) with the existing row.`,
    where: `SQL function "upsert" statement 1: Key (delivery_address)=(${STREET})`
  });
  const r1: any = serializeSafely(unique, "pg Key detail");
  assertNoPerson(r1, "pg Key detail");
  assertPgEchoDropped(r1, "pg Key detail", 3);
  assert.equal(r1.code, "23505");
  assert.equal(r1.table, "participants");
  assert.equal(r1.constraint, "participants_buyer_name_key");
  assert.equal(r1.schema, "public");

  const notNull = Object.assign(new DatabaseError(`null value in column "phone" of relation "participants" violates not-null constraint`), {
    code: "23502", severity: "ERROR", routine: "ExecConstraints", table: "participants", column: "phone", constraint: "participants_phone_not_null",
    detail: `Failing row contains (${DEAL_ID}, ${PERSON_NAME}, ${STREET}, null).`
  });
  const r2: any = serializeSafely(notNull, "pg Failing row");
  assertNoPerson(r2, "pg Failing row");
  assertPgEchoDropped(r2, "pg Failing row", 1);
  assert.equal(r2.code, "23502");
  assert.equal(r2.column, "phone");
  assert.equal(r2.constraint, "participants_phone_not_null");
});

await run("pg value lists with ')', nested parentheses or newlines inside a value do not leak (detail/hint/where dropped)", () => {
  const cases = [
    `Failing row contains (${DEAL_ID}, x) ${PERSON_NAME}, ${STREET}, null).`,
    `Failing row contains (${DEAL_ID}, (${PERSON_NAME}, ${STREET}), null).`,
    `Failing row contains (${DEAL_ID}, line one\n${PERSON_NAME}, ${STREET}, null).`,
    `Key (delivery_address)=(Apt 3) ${STREET}) already exists.`,
    `Key (lower(buyer_name))=(${PERSON_NAME}) already exists.`,
    `Key (buyer_name)=(${PERSON_NAME}) already exists.\nKey (delivery_address)=(${STREET}) already exists.`
  ];
  const leaks: string[] = [];
  for (const detail of cases) {
    const err = Object.assign(new DatabaseError("violation"), { code: "23505", severity: "ERROR", table: "participants", detail, hint: detail, where: detail });
    const result: any = serializeSafely(err, "pg hostile list");
    assertPgEchoDropped(result, "pg hostile list", 3);
    const text = stringify(result);
    const found = PERSON_FRAGMENTS.filter((fragment) => text.includes(fragment));
    if (found.length) leaks.push(`${JSON.stringify(detail).slice(0, 70)} -> ${found.join(",")}`);
  }
  assert.deepEqual(leaks, [], "a pg value list leaked");
});

await run("cause chains and AggregateError children obey the same allowlist, the 20-error bound and the depth bound", () => {
  const leafCause = Object.assign(new Error("leaf"), { buyer_name: PERSON_NAME, response: { data: { address: STREET } }, code: "ELEAF" });
  const midCause = Object.assign(new Error("mid", { cause: leafCause }), { delivery_address: STREET, request: { body: { name: PERSON_NAME } } });
  const top = Object.assign(new Error("top", { cause: midCause }), { config: { data: PERSON_NAME } });
  const r1 = serializeSafely(top, "cause allowlist");
  assertNoPerson(r1, "cause allowlist");
  assertNoKeyNames(r1, DROPPED_NAMES, "cause allowlist");

  const children = Array.from({ length: 50 }, (_, index) => Object.assign(new Error(`child ${index}`), { buyer_name: PERSON_NAME, delivery_address: STREET, code: `E${index}` }));
  const agg: any = new AggregateError(children, "batch failed");
  agg.request = { body: { name: PERSON_NAME } };
  const r2: any = serializeSafely(agg, "aggregate allowlist");
  assertNoPerson(r2, "aggregate allowlist");
  assertNoKeyNames(r2, DROPPED_NAMES, "aggregate allowlist");
  assert.ok(Array.isArray(r2.errors), "AggregateError children are not emitted under `errors`");
  const childObjects = r2.errors.filter((child: unknown) => child !== null && typeof child === "object");
  assert.ok(childObjects.length >= 1 && childObjects.length <= 20, `errors has ${childObjects.length} serialized children`);
  for (const child of r2.errors) if (child && typeof child === "object") assert.equal(typeof child.omitted_keys, "number", "a child's dropped keys were not counted");

  // Depth 4: a 10-deep chain never nests beyond the bound.
  let chain: any = new Error("root");
  for (let depth = 0; depth < 10; depth += 1) chain = new Error(`level ${depth}`, { cause: chain });
  let node: any = serializeSafely(chain, "cause depth");
  let levels = 0;
  while (node && typeof node === "object" && node.cause && typeof node.cause === "object") { node = node.cause; levels += 1; }
  assert.ok(levels <= 5, `cause nested ${levels} levels deep`);
});

// ── 6d. SQL literals, JSON tokens and quoted spans ──
// pg echoes the offending INPUT: single-quoted SQL literals in CONTEXT
// ("SQL statement ..."), `Token "..." is invalid.` and the raw JSON line for
// bad JSON, and double-quoted values in the MESSAGE itself
// (`invalid input syntax for type integer: "..."`). Under v3 detail / hint /
// where are dropped, and in a pg-shaped error (string `severity`, or a
// 5-character SQLSTATE `code` plus `routine`) every quoted span in `message`
// is redacted. Identifiers stay available in table / column / constraint /
// schema / dataType.

const SQL_ADDRESS = ["Herzl", "5", "Tel", "Aviv"].join(" ");
const SQL_FRAGMENTS = [...PERSON_FRAGMENTS, SQL_ADDRESS, "Tel Aviv", "Brien", "Doe"];

function sqlLeaks(result: unknown): string[] {
  const text = stringify(result);
  return SQL_FRAGMENTS.filter((fragment) => text.includes(fragment));
}

function pgError(fields: Record<string, string>, message = "violation") {
  return Object.assign(new DatabaseError(message), { code: "22P02", severity: "ERROR", routine: "pg_input_error", table: "buyers", ...fields });
}

// Every echo payload from the v2 era, planted in detail, hint and where.
const ECHO_PAYLOADS = [
  `SQL statement "INSERT INTO t VALUES ('${PERSON_NAME}', '${SQL_ADDRESS}')" PL/pgSQL function add_buyer() line 3 at SQL statement`,
  `Token "Jane" is invalid.`,
  `Token "${PERSON_NAME}" is invalid. Token "${STREET}" is invalid.`,
  `Token "${PERSON_NAME} is invalid and never closed`,
  `Expected end of input. Token "Herzl" is invalid.`,
  `Token "Jane" is invalid.\nToken "Herzl`,
  `Token ""Token "Jane" is invalid.`,
  `SQL statement "INSERT INTO buyers (name, city) VALUES ('O''Brien', '${SQL_ADDRESS}')"`,
  `Key (name)=(O'Brien) already exists.`,
  `'O''Brien'`,
  `invalid input syntax for type integer: '${PERSON_NAME} ${STREET}`,
  `'${PERSON_NAME}' then more text '`,
  `JSON data, line 1: {"buyer_name": "${PERSON_NAME}", "address": "${STREET}", }`,
  `Expected ":", but found "${PERSON_NAME}".`,
  `Check constraint "orders_amount_check" on table "buyers": '${PERSON_NAME}'`
];

await run("SQL-literal, Token, O''Brien, lone-quote and JSON-echo payloads in detail/hint/where never appear, and the keys are dropped and counted", () => {
  const leaks: string[] = [];
  for (const payload of ECHO_PAYLOADS) {
    const result: any = serializeSafely(pgError({ detail: payload, hint: payload, where: payload }), "echo payload");
    assertPgEchoDropped(result, `echo payload ${JSON.stringify(payload).slice(0, 40)}`, 3);
    const found = sqlLeaks(result);
    if (found.length) leaks.push(`${JSON.stringify(payload).slice(0, 60)} -> ${found.join(",")}`);
  }
  assert.deepEqual(leaks, [], "an echo payload leaked");
  // Also when the error is NOT pg-shaped: detail / hint / where are dropped regardless.
  const plain: any = serializeSafely(Object.assign(new Error("plain"), { detail: ECHO_PAYLOADS[0]!, hint: ECHO_PAYLOADS[12]!, where: ECHO_PAYLOADS[13]! }), "non-pg echo");
  assertPgEchoDropped(plain, "non-pg echo", 3);
  assert.deepEqual(sqlLeaks(plain), [], "non-pg echo leaked");
  // And inside a cause / AggregateError child.
  const wrapped: any = serializeSafely(new AggregateError([pgError({ detail: ECHO_PAYLOADS[0]! })], "batch", { cause: pgError({ where: ECHO_PAYLOADS[12]! }) }), "nested echo");
  assert.deepEqual(sqlLeaks(wrapped), [], "nested echo leaked");
});

await run("pg message `invalid input syntax for type integer: \"Jane Doe\"` redacts the quoted span", () => {
  const result: any = serializeSafely(pgError({}, `invalid input syntax for type integer: "${PERSON_NAME}"`), "pg integer");
  assert.deepEqual(sqlLeaks(result), [], `pg integer leaked: ${stringify(result).slice(0, 300)}`);
  assert.ok(String(result.message).includes('"[redacted]"'), `message: ${result.message}`);
  assert.ok(String(result.message).includes("invalid input syntax for type integer"), "the non-quoted text should survive");
});

await run("pg `invalid input syntax for type json` messages with echoed values leak nothing (double, single, unclosed, many spans)", () => {
  const messages = [
    // pg quotes the input WITHOUT escaping embedded quotes, so an input that
    // itself contains `"` breaks naive open/close pairing:
    `invalid input syntax for type integer: "x" ${PERSON_NAME} "y"`,
    `invalid input syntax for type json: "{"buyer_name": "${PERSON_NAME}", "address": "${STREET}"}"`,
    `invalid input syntax for type json: "{\\"buyer_name\\": \\"${PERSON_NAME}\\"}"`,
    `invalid input syntax for type json: '{"buyer_name": "${PERSON_NAME}", "address": "${STREET}"}'`,
    `invalid input syntax for type json at "${PERSON_NAME}" near "${STREET}"`,
    `invalid input syntax for type json: "${PERSON_NAME}, ${STREET}`,
    `invalid input syntax for type json: '${PERSON_NAME}`,
    `invalid input syntax for type json: "a" 'b' "${PERSON_NAME}" '${STREET}' "c`
  ];
  const leaks: string[] = [];
  for (const message of messages) {
    for (const shape of [{ severity: "ERROR" }, { severity: undefined, routine: "json_errsave_error" }] as const) {
      const err: any = new DatabaseError(message);
      err.code = "22P02";
      if (shape.severity) err.severity = shape.severity;
      if ("routine" in shape) err.routine = shape.routine;
      const result: any = serializeSafely(err, "pg json message");
      const found = sqlLeaks(result);
      if (found.length) leaks.push(`${JSON.stringify(message).slice(0, 60)} (${shape.severity ? "severity" : "code+routine"}) -> ${found.join(",")}`);
    }
  }
  assert.deepEqual(leaks, [], "a pg json message leaked");
});

await run("pg unique violation: quoted constraint is redacted in the message but the `constraint` field survives", () => {
  const err = pgError({ code: "23505", constraint: "buyers_phone_key", table: "buyers", column: "phone", dataType: "text", schema: "public",
    detail: `Key (phone)=(${SENSITIVE.phone_plain}) already exists.` }, `duplicate key value violates unique constraint "buyers_phone_key"`);
  const result: any = serializeSafely(err, "pg unique v3");
  assertNoLeak(result, "pg unique v3");
  assertPgEchoDropped(result, "pg unique v3", 1);
  assert.ok(String(result.message).includes('"[redacted]"'), `message: ${result.message}`);
  assert.ok(!String(result.message).includes("buyers_phone_key"), "the quoted span in a pg message was kept");
  assert.equal(result.constraint, "buyers_phone_key");
  assert.equal(result.table, "buyers");
  assert.equal(result.column, "phone");
  assert.equal(result.schema, "public");
  assert.equal(result.dataType, "text");
  assert.equal(result.code, "23505");
});

await run("a non-pg Error whose message has quotes keeps non-sensitive quoted text (scrubText only)", () => {
  const nonPg: any[] = [
    new Error(`unknown outbox event type "invoice.issue" for handler 'grow'`),
    Object.assign(new Error(`unknown outbox event type "invoice.issue" for handler 'grow'`), { code: "ERR_UNKNOWN_EVENT" }),
    Object.assign(new Error(`unknown outbox event type "invoice.issue" for handler 'grow'`), { code: "ABCDE" })   // SQLSTATE-shaped code but no routine
  ];
  for (const err of nonPg) {
    const result: any = serializeSafely(err, "non-pg quotes");
    assert.ok(String(result.message).includes('"invoice.issue"'), `double-quoted text lost: ${result.message}`);
    assert.ok(String(result.message).includes("'grow'"), `single-quoted text lost: ${result.message}`);
  }
  // scrubText still applies inside quotes of a non-pg message.
  const sensitive: any = serializeSafely(new Error(`send failed to "${SENSITIVE.email}" via '${SENSITIVE.phone_intl}'`), "non-pg sensitive quotes");
  assertNoLeak(sensitive, "non-pg sensitive quotes");
});

await run("quoted-span redaction is linear: 100 KB of quotes in a pg message in < 200 ms", () => {
  serializeSafely(pgError({}, `x "a" 'b'`), "warm-up");
  const inputs = [
    "'".repeat(100_000),
    '"'.repeat(100_000),
    `'"`.repeat(50_000),
    `Token "`.repeat(15_000),
    `a'b"`.repeat(25_000)
  ];
  const started = Date.now();
  for (const message of inputs) {
    const result = serializeSafely(pgError({ detail: message, hint: message, where: message }, message), "linear");
    assert.ok(stringify(result).length < 64 * 1024, "linear-case output is not bounded");
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `redaction took ${elapsed} ms`);
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
        for (const field of ["message", "table"] as const) {
          const err: any = new Error(field === "message" ? message : "boundary");
          if (field === "table") err.table = message;
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
