// LOG SERIALIZATION IS TOTAL — it never throws on attacker-controlled input.
//
// Independent review HIGH-1: the request-URL redaction added for V6 called
// decodeURIComponent on every raw query-string KEY. A key with malformed
// percent-encoding threw URIError inside pino's serializer while Fastify was
// writing the "incoming request" line, and that exception escapes the request
// handler: one anonymous `GET /health?%zz=1` took the whole web process down.
//
// A logging function runs on EVERY request before any routing decision, so its
// only acceptable failure mode is "log something less useful". This file pins
// the property at three levels:
//
//   1. app.inject with malformed keys resolves instead of throwing
//   2. the REAL pino `req` serializer (pulled off the live logger, not a copy)
//      survives a fixed hostile corpus plus a deterministic fuzz run
//   3. redaction still holds on the same surface: a credential in a query value
//      never reaches the serialized line, while an ordinary parameter does
//
// Failing fuzz cases are written to .ci-artifacts/log-serializer-fuzz-failures.json
// with the seed, so a red run can be reproduced exactly.

import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.PORT = "3141";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-logfuzz";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-logfuzz";
process.env.ADMIN_API_KEY = "logfuzz-admin-key";

const { app } = await import("../src/app.js");
await app.ready();

const pinoModule: any = await import("pino");
const serializersSym: symbol = pinoModule.symbols?.serializersSym ?? pinoModule.default?.symbols?.serializersSym;
assert.ok(serializersSym, "pino serializers symbol unavailable");
const reqSerializer: ((request: any) => any) | undefined = (app as any).log?.[serializersSym]?.req;
assert.equal(typeof reqSerializer, "function", "the live logger has no `req` serializer to test");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const SENTINEL = "SENTINELtokenR4nd0mV4lu3ThatMustNotAppear";
const KEEP = "ordinaryParamKeepMe";

function fakeRequest(url: string) {
  return { method: "GET", url, headers: { host: "fuzz.local" }, host: "fuzz.local", ip: "127.0.0.1", socket: { remotePort: 4242, remoteAddress: "127.0.0.1" } };
}

function serialize(url: string) {
  return JSON.stringify(reqSerializer!(fakeRequest(url)));
}

// ── 1. The request path itself must not throw ────────────────────────────────

const MALFORMED_KEYS = [
  "/health?%zz=1",
  "/health?%=1",
  "/health?%E0%A4%A=1",
  "/health?%%%%=1&%2=x",
  "/health?%C3=1",
  "/health?%F0%9F=1",
  "/health?%2=1&ok=1",
  "/health?%zz",
  "/health?=%zz",
  "/health?&&%zz=1&&",
  "/api/deals/00000000-0000-0000-0000-000000000000/public?%zz=1"
];

await run("app.inject with a malformed percent-encoded query KEY resolves instead of throwing", async () => {
  const thrown: string[] = [];
  for (const url of MALFORMED_KEYS) {
    try {
      const response = await app.inject({ method: "GET", url });
      assert.ok(response.statusCode > 0, `no status for ${url}`);
    } catch (error) {
      thrown.push(`${url} -> ${(error as any)?.name}: ${(error as any)?.message}`);
    }
  }
  assert.deepEqual(thrown, [], "a malformed query key escaped the request path as an exception");
});

await run("a malformed query VALUE keeps working too", async () => {
  const response = await app.inject({ method: "GET", url: "/health?a=%zz&b=%" });
  assert.equal(response.statusCode, 200, response.body);
});

// ── 2. The real serializer over a hostile corpus ─────────────────────────────

const HOSTILE_URLS = [
  ...MALFORMED_KEYS,
  "/x?%",
  "/x?%%",
  "/x?%%%",
  "/x?%2",
  "/x?%2G=1",
  "/x?%G2=1",
  "/x?%E2%82=1",                 // truncated 3-byte sequence
  "/x?%ED%A0%80=1",              // encoded surrogate half
  "/x?%FF%FE=1",
  "/x?%C0%AF=1",                 // overlong encoding
  "/x?" + "%".repeat(512),
  "/x?" + "%z".repeat(256) + "=1",
  "/x?" + "k".repeat(8192) + "=v",
  "/x?" + "%41".repeat(2048) + "=v",
  "/x?a%3Db=1&c%26d=2&e%3Ff=3",  // encoded separators inside keys
  "/x?t=1&t=2&T=3&%74=4&%54=5",  // duplicate and case/encoding variants of a sensitive key
  "/x?=1&=2&&&",                 // empty keys
  "/x?a==b&c=d=e",
  "/x?ключ=значение&מפתח=ערך&日本=語",
  "/x?%D7%9E%D7%A4%D7%AA%D7%97=1",
  "/x?\u0000=1",
  "/x?a=\u0000",
  "/x?\u0001\u0002=\u0003",
  "/x?a\rb=1",
  "/x?a\nb=1",
  "/x?a\tb=1",
  "/x?\uD83D=1",                 // lone high surrogate
  "/x?\uDE00=1",                 // lone low surrogate
  "/x?a=1#%zz",
  "/x?a=1;b=2",
  "/x??=1",
  "/x?a=1?b=2",
  "/x?+=1&a+b=c+d",
  "//x//?//=//",
  "?%zz=1",
  "%zz",
  ""
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "%", "%z", "%zz", "%2", "%2G", "%E0%A4%A", "%C3", "%F0%9F", "%ED%A0%80", "%25", "%%",
  "&", "=", "?", "#", "+", ";", "/", "//",
  "t", "token", "%74", "%54OKEN", "access_token", "key", "q", "state",
  "%00", "\u0000", "\u0001", "\r", "\n", "\t",
  "日本", "עברית", "\uD83D", "\uDE00", "é", "%C3%A9",
  "a".repeat(64), "%41".repeat(32), "1", "0", "-1"
];

const FUZZ_SEED = 20260906;
const FUZZ_CASES = 3000;

function generateFuzzUrls(seed: number, count: number) {
  const random = mulberry32(seed);
  const urls: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const pieceCount = 1 + Math.floor(random() * 12);
    let url = random() < 0.9 ? "/p?" : random() < 0.5 ? "/p" : "";
    for (let piece = 0; piece < pieceCount; piece += 1) url += PIECES[Math.floor(random() * PIECES.length)];
    // One in five carries a real credential shape somewhere in the value position.
    if (random() < 0.2) url += `&t=${SENTINEL}`;
    if (random() < 0.2) url += `&q=${KEEP}`;
    urls.push(url);
  }
  return urls;
}

const failures: Array<{ case: string; error: string }> = [];
function tryCase(url: string) {
  try {
    const out = serialize(url);
    assert.equal(typeof out, "string");
    return out;
  } catch (error) {
    failures.push({ case: url, error: `${(error as any)?.name}: ${(error as any)?.message}` });
    return null;
  }
}

await run("the real pino request serializer never throws on the fixed hostile corpus", async () => {
  for (const url of HOSTILE_URLS) tryCase(url);
  assert.deepEqual(failures.map((item) => `${JSON.stringify(item.case).slice(0, 80)} -> ${item.error}`), [], "serializer threw");
});

await run(`the real pino request serializer never throws across ${FUZZ_CASES} seeded fuzz cases (seed ${FUZZ_SEED})`, async () => {
  const before = failures.length;
  for (const url of generateFuzzUrls(FUZZ_SEED, FUZZ_CASES)) tryCase(url);
  const fresh = failures.slice(before);
  assert.deepEqual(fresh.slice(0, 10).map((item) => `${JSON.stringify(item.case).slice(0, 80)} -> ${item.error}`), [], `${fresh.length} fuzz cases threw`);
});

// ── 3. Redaction still holds on the same surface ─────────────────────────────

await run("a credential in a query value never reaches the serialized line, an ordinary parameter does", async () => {
  const leaks: string[] = [];
  const redactedShapes = [
    `/api/inquiries/x?t=${SENTINEL}&q=${KEEP}`,
    `/x?token=${SENTINEL}`,
    `/x?TOKEN=${SENTINEL}`,
    `/x?%74=${SENTINEL}`,            // percent-encoded key "t"
    `/x?access_token=${SENTINEL}&q=${KEEP}`,
    `/x?a=1&t=${SENTINEL}&b=2`,
    `/x?t=${SENTINEL}&t=${SENTINEL}`,
    `/x?%zz=1&t=${SENTINEL}`,        // malformed neighbour must not disable redaction
    `/x?t=${SENTINEL}&%zz=1`
  ];
  for (const url of redactedShapes) {
    const out = tryCase(url);
    if (out === null) { leaks.push(`${url} -> threw`); continue; }
    if (out.includes(SENTINEL)) leaks.push(`${url} -> credential present`);
    if (!/\[redacted\]/.test(out)) leaks.push(`${url} -> no visible redaction marker`);
  }
  assert.deepEqual(leaks, [], "credential material reached the serialized request line");
  const kept = tryCase(`/x?q=${KEEP}&t=${SENTINEL}`);
  assert.ok(kept && kept.includes(KEEP), "an ordinary parameter was redacted away");
  assert.ok(kept && kept.includes("/x?"), "the route disappeared from the serialized line");
});

await run("fuzz cases that carry a credential never leak it, whatever surrounds it", async () => {
  const leaks: string[] = [];
  for (const url of generateFuzzUrls(FUZZ_SEED + 1, FUZZ_CASES)) {
    // Only a `t=` pair that the application itself would parse as the `t`
    // parameter counts: it must sit after the first '?' as its own '&'-delimited
    // pair. A credential-shaped string in the PATH is not a query parameter and
    // the product never reads it as one.
    const marker = url.indexOf(`&t=${SENTINEL}`);
    const question = url.indexOf("?");
    if (marker === -1 || question === -1 || question > marker) continue;
    const out = tryCase(url);
    if (out !== null && out.includes(SENTINEL)) leaks.push(url);
  }
  assert.deepEqual(leaks.slice(0, 10), [], `${leaks.length} fuzz cases leaked the credential`);
});

// ── Persist evidence ─────────────────────────────────────────────────────────

const artifactDir = path.join(process.cwd(), ".ci-artifacts");
mkdirSync(artifactDir, { recursive: true });
writeFileSync(
  path.join(artifactDir, "log-serializer-fuzz-failures.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), seed: FUZZ_SEED, cases: FUZZ_CASES, fixed_corpus: HOSTILE_URLS.length, failures }, null, 2)
);

console.log(`SUMMARY passed=${passed} failed=${failed} fuzz_cases=${FUZZ_CASES * 2} corpus=${HOSTILE_URLS.length} serializer_throws=${failures.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
