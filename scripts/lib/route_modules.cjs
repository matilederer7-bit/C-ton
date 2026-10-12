// Single registry of the route-bearing source modules.
//
// Every static gate and every text-reading test that scans "the runtime" must
// read the same set of files, otherwise a Lean Refactor extraction silently
// narrows a security, money or legal scan (PR #191 and the PR #239 Codex P2
// were exactly that). The two lists below are the only place a new route
// module is added; tests/route_module_registry_validation.ts proves that
// every src/*_routes.ts file is listed and that the runtime copy in
// src/refund_route_readiness.ts (REFUND_READINESS_ROUTE_MODULES) is identical.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Every src module that registers HTTP routes (app.get / post / put / patch / delete),
// in the order the refund-readiness scan and the route inventory use.
const ROUTE_MODULES = Object.freeze([
  "app",
  "frontend_runtime",
  "receipt_content_routes",
  "distribution_hub",
  "admin_mission_control_routes",
  "operational_health_routes",
  "seller_deal_image_routes",
  "support_routes",
  "seller_fulfillment_routes",
  "admin_control_center_routes",
  "admin_growth_routes",
  "admin_demo_readiness_routes",
  "admin_ops_overview_routes",
  "admin_operational_status_routes"
]);

// src/frontend_runtime.ts plus every module whose route blocks were moved out of
// it verbatim by the Lean Refactor. A scanner that used to read frontend_runtime.ts
// alone reads this whole family, so an extraction never narrows it.
//
// Independently derivable (tests/route_module_registry_validation.ts proves it
// both ways): the family minus frontend_runtime, plus FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED,
// is exactly the set of modules frontend_runtime.ts imports a register*() function
// from; each family member's header records the move out of frontend_runtime.ts.
const FRONTEND_RUNTIME_FAMILY = Object.freeze([
  "frontend_runtime",
  "admin_mission_control_routes",
  "support_routes",
  "seller_fulfillment_routes",
  "admin_control_center_routes",
  "admin_growth_routes",
  "admin_demo_readiness_routes",
  "admin_ops_overview_routes",
  "admin_operational_status_routes"
]);

// Modules frontend_runtime.ts wires with register*(app, ...) but whose text was
// never part of frontend_runtime.ts: they are their own feature modules, listed
// in ROUTE_MODULES and scanned by every gate that reads all route modules.
const FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED = Object.freeze([
  "receipt_content_routes",
  "distribution_hub"
]);

function routeModuleFiles(names) {
  return names.map((name) => "src/" + name + ".ts");
}

// Reads the named modules from `root` and joins them with "\n", the shape every
// inline concatenation used before this registry existed.
function readRouteModules(names, root) {
  const base = root || process.cwd();
  return routeModuleFiles(names).map((file) => fs.readFileSync(path.join(base, file), "utf8")).join("\n");
}

module.exports = {
  ROUTE_MODULES,
  FRONTEND_RUNTIME_FAMILY,
  FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED,
  ROUTE_MODULE_FILES: Object.freeze(routeModuleFiles(ROUTE_MODULES)),
  FRONTEND_RUNTIME_FAMILY_FILES: Object.freeze(routeModuleFiles(FRONTEND_RUNTIME_FAMILY)),
  routeModuleFiles,
  readRouteModules
};
