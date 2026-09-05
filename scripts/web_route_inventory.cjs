const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = process.cwd();
const artifacts = path.join(root, ".ci-artifacts");
fs.mkdirSync(artifacts, { recursive: true });

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

function authFor(routePath, handlerText) {
  if (routePath.startsWith("/api/admin/")) {
    if (routePath.includes("/notifications")) return { authentication: "admin session/key", role: "admin" };
    if (routePath === "/api/admin/auth/logout") return { authentication: "admin session if present", role: "admin" };
    if (routePath === "/api/admin/auth/mfa/verify") return { authentication: "MFA challenge", role: "admin-login" };
    if (routePath === "/api/admin/auth/login") return { authentication: "credentials", role: "admin-login" };
    return {
      // These are the guard helpers the admin surface actually uses. Missing one
      // makes this report cry "not detected" for dozens of properly guarded routes,
      // which is how a genuinely unguarded route would go unnoticed. The runtime
      // proof is tests/admin_route_auth_coverage_validation.ts.
      authentication: /requireAdminAuth|requireAdminAuthContext|requireAdminRead|requireAdminMutation|requireAdminKey|requireAdminPermission|[Aa]dminIdentity/.test(handlerText)
        ? "admin session/key"
        : "not detected",
      role: (handlerText.match(/requireAdminPermission\([^,]+,[^,]+,\s*["'`]([^"'`]+)/) || [])[1] || "admin"
    };
  }
  if (routePath.startsWith("/api/seller/") || routePath === "/deals" || routePath.startsWith("/deals/")) {
    return {
      // resolveRequiredSellerContext is the seller-side guard helper; without it
      // properly guarded seller routes are reported as unauthenticated.
      authentication: /requireSeller|resolveRequiredSellerContext|sellerSession|seller_id|sellerId/.test(handlerText) ? "seller identity/session" : "not detected",
      role: "seller"
    };
  }
  if (routePath.includes("/tracking") || routePath.includes("/recovery")) return { authentication: "tracking/recovery token", role: "buyer" };
  if (routePath.startsWith("/api/affiliate/")) return { authentication: "affiliate identity not detected", role: "distributor" };
  if (routePath.startsWith("/webhooks/")) return { authentication: "provider signature/secret", role: "provider" };
  return { authentication: "public or flow token", role: "public/buyer" };
}

const routes = [];
for (const filename of sources) {
  const text = fs.readFileSync(path.join(root, filename), "utf8");
  const matches = [...text.matchAll(routePattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index;
    const end = matches[index + 1]?.index ?? text.length;
    const handler = text.slice(start, Math.min(end, start + 20000));
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
const unguardedAdminRoutes = routes.filter((route) =>
  route.path.startsWith("/api/admin/") &&
  route.path !== "/api/admin/auth/login" &&
  route.authentication === "not detected"
);
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
  admin_routes_without_detected_guard: unguardedAdminRoutes,
  caveats: [
    "Schema status reports explicit Fastify schemas only; handler-level validation is listed through observed status/error codes.",
    "Authentication classification is static evidence and is verified separately by real-HTTP authorization tests."
  ]
};
fs.writeFileSync(path.join(artifacts, "web-route-inventory.json"), JSON.stringify(report, null, 2));

const markdown = [
  "# Web route inventory",
  "",
  `Generated: ${report.generated_at}`,
  `Routes: ${routes.length}; frontend calls: ${frontendCalls.length}`,
  "",
  "| Method | Path | Authentication | Role | Request schema | Response schema | Success | Errors | Frontend | Lifecycle |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...routes.map((route) =>
    `| ${route.method} | \`${route.path}\` | ${route.authentication} | ${route.role} | ${route.request_schema} | ${route.response_schema} | ${route.success_codes.join(",")} | ${[...route.error_statuses, ...route.error_codes].join(", ")} | ${route.frontend_used ? "yes" : "no"} | ${route.lifecycle} |`
  ),
  "",
  "## Findings",
  "",
  `- Duplicate method/path registrations: ${duplicateRoutes.length}`,
  `- Frontend calls without a matching route: ${missingRoutes.length}`,
  `- Mock routes registered: ${productionMockRoutes.length}`,
  `- Admin routes without a statically detected guard: ${unguardedAdminRoutes.length}`,
  `- Non-admin API routes without detected frontend use: ${unusedRoutes.length}`
].join("\n");
fs.writeFileSync(path.join(artifacts, "web-route-inventory.md"), markdown);
console.log("WEB_ROUTE_INVENTORY_COMPLETE", JSON.stringify({
  routes: routes.length,
  frontend_calls: frontendCalls.length,
  duplicates: duplicateRoutes.length,
  missing_frontend_routes: missingRoutes.length,
  mock_routes: productionMockRoutes.length,
  unguarded_admin_routes: unguardedAdminRoutes.length
}));
