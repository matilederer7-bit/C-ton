import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// support, seller fulfillment, admin control-center (R6), admin growth and admin demo-readiness routes moved out of frontend_runtime.ts (Lean Refactor); they stay in this scan
const frontendRuntime = (await readFile("src/frontend_runtime.ts", "utf8")) + "\n" + (await readFile("src/support_routes.ts", "utf8")) + "\n" + (await readFile("src/seller_fulfillment_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_control_center_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_growth_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_demo_readiness_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_ops_overview_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_operational_status_routes.ts", "utf8"));
const frontendApp = await readFile("frontend/app.js", "utf8");

function routeExists(pattern: RegExp) {
  return pattern.test(frontendRuntime);
}

assert.equal(routeExists(/app\.post\(["']\/api\/admin\/[^"']*(capture|refund|void)[^"']*["']/i), false);
assert.equal(routeExists(/app\.post\(["']\/api\/admin\/[^"']*payout[^"']*["']/i), false);
assert.match(frontendApp, /לא מאפשר שינוי סטייט ידני, חיוב, זיכוי, ביטול חיוב או העברה כספית ישירה/);

console.log("PASS admin has no direct capture/refund/void/payout mutation endpoints");
