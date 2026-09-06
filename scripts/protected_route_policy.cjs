// Single source of truth for "which routes must refuse an anonymous caller".
//
// Shared by the runtime gate (tests/protected_route_authorization_gate.ts), the
// two surface coverage suites, and the static report (web_route_inventory.cjs),
// so those four can never drift into disagreeing about what is protected.
//
// DESIGN RULE: membership is derived from the LIVE Fastify router by namespace,
// never from a hand-written route list. A protected route added tomorrow is
// covered the moment it is registered — nobody has to remember to list it. The
// only hand-maintained list is the anonymous-by-design allowlist below, which is
// deliberately tiny, individually reasoned, and asserted to stay that way.

// Every route under these prefixes must answer an anonymous caller with an
// authorization refusal, and must do so BEFORE it looks at server state.
const PROTECTED_NAMESPACES = [
  "/api/admin/",
  "/api/seller/",
  "/api/affiliate/",
  "/api/distributor/"
];

// Routes inside a protected namespace that answer an anonymous caller by design.
// Adding an entry here is a security decision: it needs a reason that says why
// the route cannot require the credential, and why answering anonymously
// discloses nothing about server state.
const ANONYMOUS_BY_DESIGN = [
  {
    path: "/api/admin/auth/login",
    reason: "Credential entry point. It cannot require the session it issues. Wrong credentials and unknown accounts answer identically, so it is not an account oracle."
  },
  {
    path: "/api/admin/auth/logout",
    reason: "Idempotent session teardown. Clearing a cookie that was never set is a success; the response carries no admin data."
  },
  {
    path: "/api/admin/auth/mfa/verify",
    reason: "Second factor of the login flow. The caller holds a challenge id issued by login, never an admin session. Unknown and expired challenges both answer 401, so it never reveals whether a challenge id exists."
  },
  {
    path: "/api/seller/session",
    reason: "The browser asks 'am I signed in?'. It reports the unauthenticated state instead of failing, and returns no seller data when there is no session."
  },
  {
    path: "/api/seller/session/login",
    reason: "Credential entry point for the seller surface. Same reasoning as the admin login."
  },
  {
    path: "/api/seller/session/logout",
    reason: "Idempotent session teardown. No seller data in the response."
  },
  {
    path: "/api/distributor/session",
    reason: "Distributor equivalent of the seller session probe: reports authentication state, returns no distributor data when unauthenticated."
  },
  {
    path: "/api/distributor/session/login",
    reason: "Credential entry point for the distributor surface."
  },
  {
    path: "/api/distributor/session/logout",
    reason: "Idempotent session teardown. No distributor data in the response."
  },
  {
    path: "/api/affiliate/links/visit",
    reason: "Public click/entry tracking. Share links are handed to anonymous buyers by design, so the recorder must accept them. It writes only click and entry events keyed by a source code the visitor already holds, and returns no campaign, distributor or buyer data."
  }
];

const ANONYMOUS_BY_DESIGN_PATHS = new Set(ANONYMOUS_BY_DESIGN.map((entry) => entry.path));

/** A route the anonymous-caller invariant applies to. */
function isProtectedNamespace(routePath) {
  return PROTECTED_NAMESPACES.some((prefix) => String(routePath).startsWith(prefix));
}

function anonymousByDesignReason(routePath) {
  const entry = ANONYMOUS_BY_DESIGN.find((item) => item.path === routePath);
  return entry ? entry.reason : null;
}

/**
 * Three disjoint classes, deliberately NOT collapsed into one another:
 *
 *   "protected"            - must refuse an anonymous caller (the invariant)
 *   "anonymous-by-design"  - reviewed, reasoned exception inside a protected namespace
 *   "public"               - outside every protected namespace; a different contract
 *
 * Conflating these is the failure mode this module exists to prevent: a public
 * route and an unguarded protected route must never land in the same bucket.
 */
function classifyRoute(routePath) {
  if (!isProtectedNamespace(routePath)) return "public";
  if (ANONYMOUS_BY_DESIGN_PATHS.has(routePath)) return "anonymous-by-design";
  return "protected";
}

// An anonymous caller must get an authorization answer, not a fact about server
// state. 503 is allowed only where the surface fails closed because its identity
// provider is not configured - it discloses nothing and is not a "yes".
const AUTHORIZATION_REFUSAL_CODES = [401, 403];
const FAIL_CLOSED_CODES = [503];

module.exports = {
  PROTECTED_NAMESPACES,
  ANONYMOUS_BY_DESIGN,
  ANONYMOUS_BY_DESIGN_PATHS,
  AUTHORIZATION_REFUSAL_CODES,
  FAIL_CLOSED_CODES,
  isProtectedNamespace,
  anonymousByDesignReason,
  classifyRoute
};
