// Single source of truth for "which routes must refuse an anonymous caller".
//
// Shared by the runtime gate (tests/protected_route_authorization_gate.ts), the
// surface coverage suites, the seller lifecycle proof and the static report
// (web_route_inventory.cjs), so they can never drift into disagreeing about what
// is protected.
//
// DESIGN RULES
//
//   1. Membership is derived from the LIVE Fastify router, never from a
//      hand-written route list. Two signals decide it, and either is enough:
//        - route metadata: a route registered with `config.authority` set to a
//          protected principal (seller | admin | distributor). This is the
//          robust signal - it follows the route wherever its path lives.
//        - namespace: a path under one of PROTECTED_NAMESPACES. This is the
//          safety net for routes that carry no metadata yet.
//      A route added tomorrow is covered the moment it is registered.
//
//   2. The only hand-maintained list is the anonymous-by-design allowlist. It
//      is small, every entry carries a reason, and every entry carries a
//      BEHAVIOURAL EXPECTATION that the gate executes: the exact anonymous
//      request it accepts and the answer that proves it is an intentional
//      anonymous entry point rather than a guard refusal. A stale, bogus or
//      unexercised entry fails the gate. There is no count threshold.

// Every route under these prefixes must answer an anonymous caller with an
// authorization refusal, and must do so BEFORE it looks at server state or at
// the shape of the caller's input.
const PROTECTED_NAMESPACES = [
  "/api/admin/",
  "/api/seller/",
  "/api/affiliate/",
  "/api/distributor/"
];

// Route metadata values (Fastify `config.authority`) that mark a route as
// protected regardless of its path.
const PROTECTED_AUTHORITIES = ["seller", "admin", "distributor"];

// Response bodies that are ONLY a guard refusal. An allowlisted route whose
// anonymous answer is one of these is not "anonymous by design" - it is a
// guarded route someone listed by mistake (or on purpose, to hide it).
const GUARD_REFUSAL_ERRORS = [
  "admin_auth_required",
  "ADMIN_IDENTITY_REQUIRED",
  "ADMIN_PERMISSION_DENIED",
  "MFA_REQUIRED",
  "seller_auth_required",
  "SELLER_AUTH_REQUIRED",
  "seller_auth_expired",
  "distributor_auth_required",
  "distributor_auth_unavailable",
  "forbidden"
];

// Routes inside a protected namespace that answer an anonymous caller by design.
//
// Adding an entry here is a security decision. It needs:
//   reason  - why the route cannot require the credential, and why answering
//             anonymously discloses nothing about server state
//   probe   - the exact anonymous request the gate sends
//   expect  - the statuses AND a body marker that only this intentional
//             anonymous behaviour produces (a bare guard refusal is rejected by
//             the gate whatever the marker says)
const ANONYMOUS_BY_DESIGN = [
  {
    path: "/api/admin/auth/login",
    reason: "Credential entry point. It cannot require the session it issues. Wrong credentials and unknown accounts answer identically, so it is not an account oracle.",
    probe: { method: "POST", payload: {} },
    expect: { status: [400, 401], marker: /admin_credentials_required|admin_credentials_invalid/ }
  },
  {
    path: "/api/admin/auth/logout",
    reason: "Idempotent session teardown. Clearing a cookie that was never set is a success; the response carries no admin data.",
    probe: { method: "POST", payload: {} },
    expect: { status: [200], marker: /"ok":true/ }
  },
  {
    path: "/api/admin/auth/mfa/verify",
    reason: "Second factor of the login flow. The caller holds a challenge id issued by login, never an admin session. Unknown and expired challenges both answer 401, so it never reveals whether a challenge id exists.",
    probe: { method: "POST", payload: {} },
    expect: { status: [400, 401], marker: /mfa_challenge/ }
  },
  {
    path: "/api/seller/session",
    reason: "The browser asks 'am I signed in?'. It reports the unauthenticated state instead of failing, and returns no seller data when there is no session.",
    probe: { method: "GET" },
    expect: { status: [200], marker: /"authenticated":false/ }
  },
  {
    path: "/api/seller/session/login",
    reason: "Credential entry point for the seller surface. Same reasoning as the admin login.",
    probe: { method: "POST", payload: {} },
    expect: { status: [400, 401], marker: /seller_auth_invalid_credentials|SELLER_AUTH_INVALID_CREDENTIALS|identifier/ }
  },
  {
    path: "/api/seller/session/logout",
    reason: "Idempotent session teardown. No seller data in the response.",
    probe: { method: "POST", payload: {} },
    expect: { status: [200], marker: /"authenticated":false/ }
  },
  {
    path: "/api/distributor/session",
    reason: "Distributor equivalent of the seller session probe: reports authentication state, returns no distributor data when unauthenticated.",
    // Unlike the seller session probe (which answers 200 ok:true when signed
    // out), this endpoint reports the signed-out state as 401
    // `distributor_auth_required` - a body that is, by shape, a guard refusal.
    // `state_probe` is the reviewed acknowledgement of that: the gate honours it
    // ONLY for a route whose path ends in `/session` (the auth-state endpoint
    // naming a data route cannot wear without becoming a different route) whose
    // body reports `"authenticated":false` and discloses no principal data. It
    // is what lets a genuine state probe carry a guard-refusal-shaped body while
    // a data route (e.g. /api/seller/deals) crafted into this list cannot.
    state_probe: true,
    probe: { method: "GET" },
    expect: { status: [200, 401], marker: /"authenticated":false/ }
  },
  {
    path: "/api/distributor/session/login",
    reason: "Credential entry point for the distributor surface.",
    probe: { method: "POST", payload: {} },
    expect: { status: [400, 401], marker: /distributor_auth_invalid_credentials|identifier/ }
  },
  {
    path: "/api/distributor/session/logout",
    reason: "Idempotent session teardown. No distributor data in the response.",
    probe: { method: "POST", payload: {} },
    expect: { status: [200], marker: /"ok":true/ }
  },
  {
    path: "/api/affiliate/links/visit",
    reason: "Public click/entry tracking. Share links are handed to anonymous buyers by design, so the recorder must accept them. It writes only click and entry events keyed by a source code the visitor already holds, and returns no campaign, distributor or buyer data.",
    probe: { method: "POST", payload: {} },
    expect: { status: [400], marker: /deal_id must be a valid uuid|affiliate_visit_invalid/ }
  }
];

const ANONYMOUS_BY_DESIGN_PATHS = new Set(ANONYMOUS_BY_DESIGN.map((entry) => entry.path));

/** A route the anonymous-caller invariant applies to, by namespace. */
function isProtectedNamespace(routePath) {
  return PROTECTED_NAMESPACES.some((prefix) => String(routePath).startsWith(prefix));
}

/** A route the invariant applies to, by declared capability metadata. */
function isProtectedByAuthority(config) {
  const authority = config && typeof config === "object" ? config.authority : undefined;
  return typeof authority === "string" && PROTECTED_AUTHORITIES.includes(authority);
}

function anonymousByDesignReason(routePath) {
  const entry = ANONYMOUS_BY_DESIGN.find((item) => item.path === routePath);
  return entry ? entry.reason : null;
}

function anonymousByDesignEntry(routePath) {
  return ANONYMOUS_BY_DESIGN.find((item) => item.path === routePath) || null;
}

/**
 * Three disjoint classes, deliberately NOT collapsed into one another:
 *
 *   "protected"            - must refuse an anonymous caller (the invariant)
 *   "anonymous-by-design"  - reviewed, reasoned, behaviourally proven exception
 *   "public"               - outside every protected namespace and carrying no
 *                            protected authority metadata; a different contract
 *
 * `config` is the route's Fastify config (from the onRoute registry). It is
 * optional so path-only callers keep working, but metadata wins when present:
 * a route that declares seller authority is protected wherever it lives.
 */
function classifyRoute(routePath, config) {
  if (ANONYMOUS_BY_DESIGN_PATHS.has(routePath)) return "anonymous-by-design";
  if (isProtectedByAuthority(config)) return "protected";
  if (!isProtectedNamespace(routePath)) return "public";
  return "protected";
}

/**
 * True when a JSON body is a guard refusal - the shape every guarded route in
 * the product produces for an anonymous caller. Used by the gate to reject
 * allowlist entries that merely describe a guarded route.
 *
 * A body counts as a guard refusal whenever its `error` OR `code` is one of the
 * canonical GUARD_REFUSAL_ERRORS, REGARDLESS of any additional keys. The earlier
 * version returned false as soon as the body carried an extra field (e.g. a
 * seller refusal's `product_code`/`seller_auth`), which let a still-guarded
 * protected route (/api/seller/deals) be listed as anonymous-by-design with a
 * crafted marker matching `"authenticated":false`. The extra keys of an auth
 * refusal ARE part of the refusal, not evidence of an anonymous entry point, so
 * they must not excuse it. Genuine anonymous entry points do not carry a
 * guard-refusal error at all (the seller session probe answers ok:true; login
 * routes answer credential errors; the affiliate recorder answers a validation
 * error) - the sole exception is the distributor session state probe, which the
 * gate handles through the `state_probe` allowlist flag, never here.
 */
function isBareGuardRefusal(body) {
  let parsed;
  try { parsed = JSON.parse(String(body || "")); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  return GUARD_REFUSAL_ERRORS.includes(String(parsed.error || "")) || GUARD_REFUSAL_ERRORS.includes(String(parsed.code || ""));
}

// An anonymous caller must get an authorization answer, not a fact about server
// state. 503 is allowed only where the surface fails closed because its identity
// provider is not configured - it discloses nothing and is not a "yes".
const AUTHORIZATION_REFUSAL_CODES = [401, 403];
const FAIL_CLOSED_CODES = [503];

module.exports = {
  PROTECTED_NAMESPACES,
  PROTECTED_AUTHORITIES,
  GUARD_REFUSAL_ERRORS,
  ANONYMOUS_BY_DESIGN,
  ANONYMOUS_BY_DESIGN_PATHS,
  AUTHORIZATION_REFUSAL_CODES,
  FAIL_CLOSED_CODES,
  isProtectedNamespace,
  isProtectedByAuthority,
  anonymousByDesignReason,
  anonymousByDesignEntry,
  classifyRoute,
  isBareGuardRefusal
};
