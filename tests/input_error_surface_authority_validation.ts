// INPUT / QUERY / ERROR SURFACE — what the server does with hostile parameters.
//
// Two invariants, and the second is the one that leaks:
//
//   1. Caller-controlled input produces a BOUNDED 4xx, never a 5xx. A 500 from a
//      value the caller chose means the request reached logic that did not expect
//      it. It is also an availability lever: whatever crashed is reachable by
//      anyone who can type a URL.
//
//   2. An error body never carries internal detail. No stack trace, no SQL, no
//      driver text, no filesystem path, no connection string, no configured
//      secret. An error is allowed to say what is wrong with the request; it is
//      not allowed to describe the server.
//
// The GET surface is enumerated from the LIVE router, so a route added tomorrow
// is fuzzed without editing this file. Only read-only methods are swept: the
// point is to reach parsing, pagination and query construction, not to write
// junk through every mutation in the product.
//
// Deliberately NOT asserted: that any particular hostile value is REJECTED. A
// route is free to ignore an unknown parameter, clamp a silly one, or return an
// empty page. What it may not do is fall over or describe itself. Demanding
// rejection everywhere would be inventing a contract the product never made.
//
// No money, no provider, no e-mail.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3130";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-inputsurface";
process.env.ADMIN_API_KEY = "input-surface-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-inputsurface";
// Rate limiting OFF for this suite, and that is load-bearing rather than
// convenient. A thousands-of-requests sweep exhausts the 200/min per-IP bucket
// within seconds, after which every later probe gets 429 - so the suite would be
// measuring the limiter instead of the routes and every assertion after the
// first sweep would pass vacuously. That is exactly what happened before this
// line existed: an injected route returning an absolute filesystem path was not
// detected, because the probe that should have caught it was rate-limited away.
// The limiter has its own suites (rate_limiter_validation,
// rate_limit_read_budget_validation); this one is about input handling.
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";

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

function enumerateRoutes(printed: string): Array<{ path: string; methods: string[] }> {
  const routes: Array<{ path: string; methods: string[] }> = [];
  const branch: string[] = [];
  for (const raw of printed.split("\n")) {
    if (!raw.trim()) continue;
    const cleaned = raw.replace(/[│├└─]/g, " ");
    const depth = Math.floor((cleaned.length - cleaned.trimStart().length) / 4);
    const text = cleaned.trim();
    const withMethods = text.match(/^(.*?)\s*\(([A-Z, ]+)\)\s*$/);
    const segment = withMethods ? withMethods[1]! : text;
    branch[depth] = segment;
    branch.length = depth + 1;
    if (!withMethods) continue;
    const full = branch.join("");
    routes.push({
      path: full.startsWith("/") ? full : `/${full}`,
      methods: withMethods[2]!.split(",").map((value) => value.trim()).filter(Boolean)
    });
  }
  return routes;
}

function concreteUrl(routePath: string) {
  return routePath.replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => randomUUID());
}

// Values a caller can actually put in a query string. Numeric extremes,
// pagination abuse, type confusion, injection shapes, and unicode/encoding edges.
const HOSTILE_VALUES = [
  "",
  "0",
  "-1",
  "-999999999",
  "NaN",
  "Infinity",
  "-Infinity",
  "1e400",
  "999999999999999999999999",
  "9223372036854775808",          // int64 overflow by one
  "1.7976931348623157e309",
  "null",
  "undefined",
  "true",
  "[]",
  "{}",
  "a".repeat(8192),
  "' OR '1'='1",
  "1; DROP TABLE siton.deals; --",
  "1 UNION SELECT null,null,null",
  "../../../../etc/passwd",
  "%00",
  "\u0000",                       // a raw NUL, not the percent-encoded form
  " ",
  "<script>alert(1)</script>",
  "${jndi:ldap://x/y}",
  "2026-13-45T99:99:99Z",
  "not-a-date",
  "NOT_A_STATE",
  "%%%",
  "%zz"
];

const FUZZED_PARAMS = [
  "limit", "offset", "page", "page_size", "per_page", "count",
  "sort", "sort_by", "order", "order_by", "direction",
  "q", "search", "query", "filter",
  "status", "state", "deal_type", "flag_type", "scope_type", "scope_id",
  "from", "to", "since", "until", "date", "deadline",
  "seller_id", "deal_id", "buyer_id", "thread_id"
];

// Fragments that must never reach a client. Each says something about the server
// rather than about the request.
// NOTE ON ESCAPING: these are matched against the RAW response body, which for a
// JSON error is already escaped - a Windows path arrives as `C:\\Users\\`, not
// `C:\Users\`. A negative control caught this: an injected route that returned a
// real absolute path sailed past a pattern written for the unescaped form. Every
// backslash below therefore tolerates one or two.
const INTERNAL_DETAIL = [
  /\bat [A-Za-z0-9_$.]+ \(.*:\d+:\d+\)/,            // stack frame
  /\b[A-Za-z]:\\{1,2}Users\\{1,2}/i,                // absolute Windows path
  /\/home\/[a-z]+\//i,
  /node_modules/,
  /\bpostgres(?:ql)?:\/\//i,                        // connection string
  /\bpassword=/i,
  /\bsyntax error at or near\b/i,                   // raw driver text
  /\brelation "[^"]+" does not exist/i,
  /\bcolumn "[^"]+" does not exist/i,
  /\bduplicate key value violates\b/i,
  /\bECONNREFUSED\b/,
  /input-surface-admin-key/,                        // the configured secrets
  /admin-session-secret-inputsurface/,
  /seller-session-secret-inputsurface/
];

function assertNoInternalDetail(label: string, body: string) {
  for (const pattern of INTERNAL_DETAIL) {
    assert.ok(!pattern.test(body), `${label} leaked internal detail matching ${pattern}: ${body.slice(0, 300)}`);
  }
}

const allRoutes = enumerateRoutes(app.printRoutes({ commonPrefix: false }));
const getRoutes = allRoutes.filter((route) => route.methods.includes("GET"));

// Real principals, so the sweep reaches past the guards into the query layer.
// Fuzzing only anonymously would measure the guards, which Phase 0 already did.
const SELLER = `seller-fuzz-${randomUUID().slice(0, 8)}`;
const SELLER_EMAIL = `${SELLER}@siton.test`;
const SELLER_CODE = "InputSurfacePass123!";
const { cookie: adminCookie } = await establishNamedAdminSession(app, pool, { role: "SuperAdmin" });
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
const sellerLogin = await app.inject({
  method: "POST",
  url: "/api/seller/session/login",
  payload: { identifier: SELLER_EMAIL, access_code: SELLER_CODE }
} as any);
assert.equal(sellerLogin.statusCode, 200, sellerLogin.body);
const sellerCookie = String(sellerLogin.headers["set-cookie"] || "").split(";")[0] || "";

await run("VACUITY GUARD: both fuzzing principals really are authenticated", async () => {
  const admin = await app.inject({ method: "GET", url: "/api/admin/actions", headers: { cookie: adminCookie } } as any);
  assert.equal(admin.statusCode, 200, `admin principal is not authenticated: ${admin.body}`);
  const seller = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: sellerCookie } } as any);
  assert.equal(seller.statusCode, 200, `seller principal is not authenticated: ${seller.body}`);
  assert.ok(getRoutes.length >= 60, `GET surface looks truncated: ${getRoutes.length}`);
});

function cookieFor(routePath: string) {
  if (routePath.startsWith("/api/admin/")) return adminCookie;
  if (routePath.startsWith("/api/seller/")) return sellerCookie;
  return "";
}

await run("no GET route answers a hostile query parameter with a server fault", async () => {
  // The full cross product is ~48k requests and does not fit a test budget, so
  // the sweep has two halves and BOTH are needed.
  //
  // A rotating stride alone was the first design and a negative control killed
  // it: an injected route that faulted on `limit=NaN` was never caught, because
  // the stride gave each route a different slice and that pair simply never
  // landed there. Aggregate coverage is not per-route coverage.
  //
  //   CORE    every route meets every high-signal value on the parameters that
  //           actually reach parsing, pagination and query construction. This is
  //           what makes a single faulting route detectable.
  //   STRIDE  breadth across the long tail of parameter names, walked
  //           continuously across the route list.
  const CORE_PARAMS = ["limit", "offset", "state", "sort", "q"];
  const CORE_VALUES = ["NaN", "-1", "1e400", "' OR '1'='1", "a".repeat(1024), "NOT_A_STATE", "%00"];
  const STRIDE_PROBES_PER_ROUTE = 12;

  const faults: string[] = [];
  let cursor = 0;
  let probes = 0;
  for (const route of getRoutes) {
    const cookie = cookieFor(route.path);
    const headersFor = () => {
      const headers: Record<string, string> = { "x-request-id": randomUUID() };
      if (cookie) headers.cookie = cookie;
      return headers;
    };

    for (const param of CORE_PARAMS) {
      for (const value of CORE_VALUES) {
        const url = `${concreteUrl(route.path)}?${param}=${encodeURIComponent(value)}`;
        const response = await app.inject({ method: "GET", url, headers: headersFor() } as any);
        probes += 1;
        if (response.statusCode >= 500) {
          faults.push(`${route.path} ?${param}=${value.slice(0, 40)} -> ${response.statusCode}`);
        }
      }
    }

    for (let index = 0; index < STRIDE_PROBES_PER_ROUTE; index += 1) {
      const param = FUZZED_PARAMS[cursor % FUZZED_PARAMS.length]!;
      const value = HOSTILE_VALUES[Math.floor(cursor / FUZZED_PARAMS.length) % HOSTILE_VALUES.length]!;
      cursor += 1;
      const url = `${concreteUrl(route.path)}?${param}=${encodeURIComponent(value)}`;
      const response = await app.inject({ method: "GET", url, headers: headersFor() } as any);
      probes += 1;
      if (response.statusCode >= 500) {
        faults.push(`${route.path} ?${param}=${value.slice(0, 40)} -> ${response.statusCode}`);
      }
    }
  }
  console.log(`  query fuzz: ${probes} probes over ${getRoutes.length} GET routes, ${faults.length} faults`);
  assert.deepEqual(
    [...new Set(faults)].slice(0, 25),
    [],
    "caller-controlled query parameters produced server faults"
  );
});

await run("no GET route describes the server in an error body", async () => {
  // A narrower, deeper sweep: the shapes most likely to reach a driver or a
  // formatter, checked for what comes BACK rather than only for the status.
  const revealing = ["' OR '1'='1", "1; DROP TABLE siton.deals; --", "NaN", "1e400", "NOT_A_STATE"];
  for (const route of getRoutes) {
    const cookie = cookieFor(route.path);
    for (const value of revealing) {
      for (const param of ["limit", "state"]) {
        const url = `${concreteUrl(route.path)}?${param}=${encodeURIComponent(value)}`;
        const headers: Record<string, string> = { "x-request-id": randomUUID() };
        if (cookie) headers.cookie = cookie;
        const response = await app.inject({ method: "GET", url, headers } as any);
        assertNoInternalDetail(`GET ${route.path}?${param}`, response.body || "");
      }
    }
  }
});

await run("a malformed path parameter is a bounded 4xx, never a fault", async () => {
  const parametric = allRoutes.filter((route) => route.path.includes(":") && route.methods.includes("GET"));
  assert.ok(parametric.length > 0, "no parametric GET routes enumerated");
  const hostileIds = [
    "not-a-uuid",
    "../../etc/passwd",
    "%00",
    "0".repeat(4096),
    "' OR '1'='1",
    "00000000-0000-0000-0000-00000000000",     // one char short
    "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"
  ];
  const faults: string[] = [];
  for (const route of parametric) {
    const cookie = cookieFor(route.path);
    for (const hostile of hostileIds) {
      const url = route.path.replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => encodeURIComponent(hostile));
      const headers: Record<string, string> = { "x-request-id": randomUUID() };
      if (cookie) headers.cookie = cookie;
      const response = await app.inject({ method: "GET", url, headers } as any);
      if (response.statusCode >= 500) faults.push(`${route.path} <- ${hostile.slice(0, 30)} -> ${response.statusCode}`);
      assertNoInternalDetail(`GET ${route.path} with ${hostile.slice(0, 20)}`, response.body || "");
    }
  }
  assert.deepEqual([...new Set(faults)].slice(0, 25), [], "malformed path parameters produced server faults");
});

await run("pagination cannot be used to ask for an unbounded page", async () => {
  // Seed enough rows that an unclamped limit would visibly return more than a
  // sane page. Without the seed a bounded and an unbounded route look identical.
  for (let index = 0; index < 40; index += 1) {
    await pool.query(
      `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
       VALUES ($1,50,1,20,5,$2,$3,'Draft')`,
      [`Fuzz page ${index} ${randomUUID().slice(0, 6)}`, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), SELLER]
    );
  }
  const unbounded: string[] = [];
  for (const url of ["/api/seller/deals", "/api/admin/actions", "/api/admin/control-flags"]) {
    const cookie = cookieFor(url);
    for (const limit of ["1000000", "999999999999", "-1", "1e400"]) {
      const response = await app.inject({
        method: "GET",
        url: `${url}?limit=${limit}&page_size=${limit}&per_page=${limit}`,
        headers: { cookie, "x-request-id": randomUUID() }
      } as any);
      if (response.statusCode >= 500) unbounded.push(`${url}?limit=${limit} -> ${response.statusCode}`);
      // A route may clamp, reject, or ignore the parameter. What it must not do
      // is serve an unbounded body because the caller asked nicely.
      const size = Buffer.byteLength(response.body || "", "utf8");
      if (size > 5_000_000) unbounded.push(`${url}?limit=${limit} -> ${size} bytes`);
    }
  }
  assert.deepEqual(unbounded, [], "a caller-supplied page size produced an unbounded or failing response");
});

await run("hostile JSON bodies on write routes are bounded 4xx, never faults", async () => {
  // A small, targeted set: the point is parser and validator behaviour, not to
  // write junk through every mutation in the product.
  const targets: Array<[string, string, string]> = [
    ["POST", "/deals", sellerCookie],
    ["PATCH", `/api/seller/deals/${randomUUID()}/draft`, sellerCookie],
    ["PUT", `/api/seller/deals/${randomUUID()}/delivery`, sellerCookie],
    ["POST", `/api/seller/inquiries/${randomUUID()}/reply`, sellerCookie]
  ];
  const hostileBodies: Array<[string, unknown]> = [
    ["negative quantity", { title: "x", price_per_unit: -1, min_units: -5, max_units: -10, threshold_units: -1 }],
    ["numeric overflow", { title: "x", price_per_unit: 1e400, min_units: 9e99, max_units: Number.MAX_SAFE_INTEGER + 1 }],
    ["NaN-ish strings", { title: "x", price_per_unit: "NaN", min_units: "Infinity", threshold_units: "-Infinity" }],
    ["wrong types", { title: [], description: {}, price_per_unit: [1, 2], delivery_options: "not-an-array" }],
    ["deep nesting", { title: "x", meta: JSON.parse("[".repeat(200) + "]".repeat(200)) }],
    ["huge string", { title: "a".repeat(200000), message: "b".repeat(200000) }],
    ["null everywhere", { title: null, price_per_unit: null, delivery_options: null, message: null }],
    ["invalid enum", { title: "x", state: "NOT_A_STATE", deal_type: "NOT_A_TYPE" }],
    ["invalid timestamp", { title: "x", deadline: "2026-13-45T99:99:99Z" }],
    ["prototype pollution", JSON.parse('{"__proto__":{"polluted":true},"title":"x"}')]
  ];
  const faults: string[] = [];
  for (const [method, url, cookie] of targets) {
    for (const [label, payload] of hostileBodies) {
      const response = await app.inject({
        method,
        url,
        headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
        payload
      } as any);
      if (response.statusCode >= 500) faults.push(`${method} ${url.split("/").slice(0, 4).join("/")} [${label}] -> ${response.statusCode}`);
      assertNoInternalDetail(`${method} ${url} [${label}]`, response.body || "");
    }
  }
  assert.deepEqual([...new Set(faults)], [], "hostile JSON bodies produced server faults");
  assert.equal(({} as any).polluted, undefined, "a request body polluted Object.prototype");
});

console.log(`SUMMARY passed=${passed} failed=${failed} get_routes=${getRoutes.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
