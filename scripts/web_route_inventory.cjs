const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = process.cwd();
const artifacts = path.join(root, ".ci-artifacts");
fs.mkdirSync(artifacts, { recursive: true });

// Shared with the runtime gate and the surface coverage suites so the static
// report and the behavioural proof can never disagree about what is protected.
const policy = require(path.join(root, "scripts", "protected_route_policy.cjs"));

const sources = ["src/app.ts", "src/frontend_runtime.ts"];
const routePattern = /\bapp\.(get|post|put|patch|delete|options|head)\(\s*["'`]([^"'`]+)["'`]/g;
const frontendPattern = /\b(?:fetch|api)\(\s*([`"'])(\/[^`"']+)\1\s*(?:,\s*\{([\s\S]{0,500}?)\})?/g;

function normalizePath(value) {
  return value
    .replace(/\$\{[^}]+\}/g, ":dynamic")
    .replace(/\?.*$/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function classify(routePath) {
  if (routePath.includes("/mock") || routePath.endsWith("-mock")) return "mock";
  if (routePath.startsWith("/debug/") || routePath.includes("/preview/") || routePath.includes("/demo-")) return "demo";
  if (routePath.includes("/otp/start") || routePath.includes("/otp/request")) return "legacy-compatible";
  return "production";
}

// The guard helpers each protected surface actually uses. Missing one makes this
// report cry "not detected" for dozens of properly guarded routes, which is how a
// genuinely unguarded route would go unnoticed in the noise.
const GUARD_PATTERNS = {
  "/api/admin/": /requireAdminAuth|requireAdminAuthContext|requireAdminRead|requireAdminMutation|requireAdminKey|requireAdminPermission|[Aa]dminIdentity/,
  "/api/seller/": /requireSeller|requireSellerAuthority|resolveRequiredSellerContext|sellerSession|seller_id|sellerId/,
  "/api/affiliate/": /resolveDistributorContext|distributorAuthConfigured|requireDistributor/,
  "/api/distributor/": /resolveDistributorContext|distributorAuthConfigured|requireDistributor|distributorSession/
};

/**
 * authorization_class is deliberately NOT a single free-text field any more.
 * Four values that must never collapse into one another:
 *
 *   "guard-detected"       protected route, a guard helper is present in the handler
 *   "guard-not-detected"   protected route, none found - the gate failure case
 *   "anonymous-by-design"  reviewed exception, reasoned in protected_route_policy
 *   "public-contract"      outside every protected namespace - a different contract,
 *                          never evidence of a missing guard
 *
 * The old report used "not detected" for both a missing guard and a surface it
 * simply had no opinion about, so a real hole and a public route read the same.
 */
function authFor(routePath, handlerText) {
  const klass = policy.classifyRoute(routePath);

  if (klass === "anonymous-by-design") {
    return {
      authorization_class: "anonymous-by-design",
      authentication: "anonymous by design (reviewed)",
      anonymous_by_design_reason: policy.anonymousByDesignReason(routePath),
      role: routePath.startsWith("/api/admin/") ? "admin-login"
        : routePath.startsWith("/api/seller/") ? "seller-login"
          : "distributor-login"
    };
  }

  if (klass === "protected") {
    const namespace = policy.PROTECTED_NAMESPACES.find((prefix) => routePath.startsWith(prefix));
    const detected = GUARD_PATTERNS[namespace].test(handlerText);
    const role = routePath.startsWith("/api/admin/")
      ? (handlerText.match(/requireAdminPermission\([^,]+,[^,]+,\s*["'`]([^"'`]+)/) || [])[1] || "admin"
      : routePath.startsWith("/api/seller/") ? "seller" : "distributor";
    return {
      authorization_class: detected ? "guard-detected" : "guard-not-detected",
      // Static evidence only. The authoritative verdict is behavioural and lives
      // in tests/protected_route_authorization_gate.ts, which probes the live
      // router anonymously and enforces UNGUARDED_PROTECTED_ROUTES = 0.
      authentication: detected ? "guard helper present" : "not detected",
      role
    };
  }

  if (routePath.includes("/tracking") || routePath.includes("/recovery")) {
    return { authorization_class: "public-contract", authentication: "tracking/recovery token", role: "buyer" };
  }
  if (routePath.startsWith("/webhooks/")) {
    return { authorization_class: "public-contract", authentication: "provider signature/secret", role: "provider" };
  }
  return { authorization_class: "public-contract", authentication: "public or flow token", role: "public/buyer" };
}

/**
 * Two admin routes register a handler by NAME rather than inline:
 *
 *   app.get("/api/admin/notifications-status", notificationStatusHandler);
 *
 * A scanner that only reads the registration site sees no guard and calls the
 * route unguarded, even though the named function opens with requireAdminRead.
 * The previous version of this report papered over exactly that with a hardcoded
 * "any path containing /notifications is guarded" special case - which would
 * equally have hidden a genuinely unguarded /api/admin/notifications-* route.
 * Following the reference instead keeps the invariant honest: guard evidence
 * comes from the code that actually runs, never from the path.
 */
function resolveHandlerText(fileText, registrationText) {
  const named = registrationText.match(/^\s*app\.[a-z]+\(\s*["'`][^"'`]+["'`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (!named) return registrationText;
  const declaration = new RegExp(`(?:const|let|function)\\s+${named[1]}\\b`).exec(fileText);
  if (!declaration) return registrationText;
  return registrationText + "\n" + fileText.slice(declaration.index, declaration.index + 20000);
}

const routes = [];
for (const filename of sources) {
  const text = fs.readFileSync(path.join(root, filename), "utf8");
  const matches = [...text.matchAll(routePattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index;
    const end = matches[index + 1]?.index ?? text.length;
    const handler = resolveHandlerText(text, text.slice(start, Math.min(end, start + 20000)));
    const method = match[1].toUpperCase();
    const registeredPath = match[2];
    const routePath = normalizePath(registeredPath);
    const auth = authFor(routePath, handler);
    const successCodes = [...handler.matchAll(/reply\.code\((2\d\d)\)/g)].map((item) => Number(item[1]));
    const errorCodes = [...handler.matchAll(/(?:statusCode\s*=|reply\.code\()([345]\d\d)/g)].map((item) => Number(item[1]));
    const errorNames = [...handler.matchAll(/(?:err|e)\.code\s*=\s*["'`]([^"'`]+)/g)].map((item) => item[1]);
    routes.push({
      method,
      path: routePath,
      source: `${filename}:${text.slice(0, start).split("\n").length}`,
      registered_path: registeredPath,
      ...auth,
      request_schema: /\bschema\s*:/.test(handler) ? "declared" : "not declared",
      response_schema: /\bresponse\s*:/.test(handler) ? "declared" : "not declared",
      success_codes: [...new Set(successCodes.length ? successCodes : [200])],
      error_statuses: [...new Set(errorCodes)],
      error_codes: [...new Set(errorNames)],
      lifecycle: classify(routePath)
    });
  }
}

const frontendText = [
  "frontend/app.js",
  "src/frontend_runtime.ts"
].filter((file) => fs.existsSync(path.join(root, file)))
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
  .join("\n");
const frontendCalls = [];
for (const match of frontendText.matchAll(frontendPattern)) {
  const options = match[3] || "";
  frontendCalls.push({
    method: ((options.match(/\bmethod\s*:\s*["'`]([A-Za-z]+)/) || [])[1] || "GET").toUpperCase(),
    path: normalizePath(match[2])
  });
}

function pathsCompatible(callPath, routePath) {
  const callParts = callPath.split("/");
  const routeParts = routePath.split("/");
  if (callParts.length !== routeParts.length) return false;
  return routeParts.every((part, index) => part.startsWith(":") || part === "*" || part === ":dynamic" || callParts[index] === part || callParts[index] === ":dynamic");
}

for (const route of routes) {
  route.frontend_used = frontendCalls.some((call) => call.method === route.method && pathsCompatible(call.path, route.path));
}
const duplicateRoutes = Object.entries(
  routes.reduce((map, route) => {
    const key = `${route.method} ${route.registered_path}`;
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {})
).filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
const missingRoutes = frontendCalls.filter((call) =>
  !call.path.includes("${") && !routes.some((route) => route.method === call.method && pathsCompatible(call.path, route.path))
);
const productionMockRoutes = routes.filter((route) => route.lifecycle === "mock");
// The gated set: every route in a protected namespace, minus the reviewed
// anonymous-by-design exceptions, whose handler shows no guard helper at all.
// Derived from the live namespace policy, so a protected route added tomorrow is
// covered without editing any list here.
const unguardedProtectedRoutes = routes.filter((route) => route.authorization_class === "guard-not-detected");
const protectedRoutes = routes.filter((route) => route.authorization_class !== "public-contract");
const anonymousByDesignRoutes = routes.filter((route) => route.authorization_class === "anonymous-by-design");
const unusedRoutes = routes.filter((route) =>
  route.path.startsWith("/api/") && !route.frontend_used && !route.path.startsWith("/api/admin/")
);

fs.writeFileSync(path.join(artifacts, "web-fastify-routes.txt"), routes.map((route) => `${route.method} ${route.path}`).join("\n") + "\n");

const report = {
  generated_at: new Date().toISOString(),
  route_count: routes.length,
  frontend_call_count: frontendCalls.length,
  routes,
  duplicate_routes: duplicateRoutes,
  frontend_calls_without_route: missingRoutes,
  routes_without_detected_frontend_use: unusedRoutes,
  mock_routes_registered: productionMockRoutes,
  protected_routes: protectedRoutes.length,
  anonymous_by_design_routes: anonymousByDesignRoutes.map((route) => ({
    method: route.method,
    path: route.path,
    reason: route.anonymous_by_design_reason
  })),
  unguarded_protected_routes: unguardedProtectedRoutes,
  caveats: [
    "Schema status reports explicit Fastify schemas only; handler-level validation is listed through observed status/error codes.",
    "authorization_class is STATIC evidence. The authoritative verdict is behavioural: tests/protected_route_authorization_gate.ts probes the live router anonymously and enforces UNGUARDED_PROTECTED_ROUTES = 0.",
    "public-contract is not evidence of a missing guard. It means the route lives outside every protected namespace and answers a different contract; it is never counted as unguarded."
  ]
};
fs.writeFileSync(path.join(artifacts, "web-route-inventory.json"), JSON.stringify(report, null, 2));

const markdown = [
  "# Web route inventory",
  "",
  `Generated: ${report.generated_at}`,
  `Routes: ${routes.length}; frontend calls: ${frontendCalls.length}`,
  "",
  "| Method | Path | Authorization class | Authentication | Role | Request schema | Response schema | Success | Errors | Frontend | Lifecycle |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...routes.map((route) =>
    `| ${route.method} | \`${route.path}\` | ${route.authorization_class} | ${route.authentication} | ${route.role} | ${route.request_schema} | ${route.response_schema} | ${route.success_codes.join(",")} | ${[...route.error_statuses, ...route.error_codes].join(", ")} | ${route.frontend_used ? "yes" : "no"} | ${route.lifecycle} |`
  ),
  "",
  "## Anonymous by design (reviewed exceptions)",
  "",
  ...anonymousByDesignRoutes.map((route) => `- \`${route.method} ${route.path}\` — ${route.anonymous_by_design_reason}`),
  "",
  "## Findings",
  "",
  `- Duplicate method/path registrations: ${duplicateRoutes.length}`,
  `- Frontend calls without a matching route: ${missingRoutes.length}`,
  `- Mock routes registered: ${productionMockRoutes.length}`,
  `- Protected-namespace routes: ${protectedRoutes.length} (${anonymousByDesignRoutes.length} anonymous by design)`,
  `- **UNGUARDED_PROTECTED_ROUTES: ${unguardedProtectedRoutes.length}** (invariant: 0)`,
  `- Non-admin API routes without detected frontend use: ${unusedRoutes.length}`
].join("\n");
fs.writeFileSync(path.join(artifacts, "web-route-inventory.md"), markdown);
console.log("WEB_ROUTE_INVENTORY_COMPLETE", JSON.stringify({
  routes: routes.length,
  frontend_calls: frontendCalls.length,
  duplicates: duplicateRoutes.length,
  missing_frontend_routes: missingRoutes.length,
  mock_routes: productionMockRoutes.length,
  protected_routes: protectedRoutes.length,
  anonymous_by_design_routes: anonymousByDesignRoutes.length,
  UNGUARDED_PROTECTED_ROUTES: unguardedProtectedRoutes.length
}));

// The gate. Not a threshold anybody may raise: a protected route with no guard
// helper in its handler fails the build. If a new guard helper is introduced,
// adding it to GUARD_PATTERNS is the reviewed action that clears this - which is
// the point, because that review is exactly what a silent hole skips.
if (unguardedProtectedRoutes.length > 0) {
  console.error(`ROUTE_INVENTORY_GATE_FAIL UNGUARDED_PROTECTED_ROUTES=${unguardedProtectedRoutes.length} (invariant: 0)`);
  for (const route of unguardedProtectedRoutes) {
    console.error(`  ${route.method} ${route.path}  (${route.source})`);
  }
  console.error("Either guard the route, add its guard helper to GUARD_PATTERNS, or justify it in scripts/protected_route_policy.cjs ANONYMOUS_BY_DESIGN with a reason.");
  process.exit(1);
}
console.log("ROUTE_INVENTORY_GATE_PASS UNGUARDED_PROTECTED_ROUTES=0");
