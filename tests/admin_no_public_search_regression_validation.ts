import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// support, seller fulfillment, admin control-center (R6), admin growth and admin demo-readiness routes moved out of frontend_runtime.ts (Lean Refactor); they stay in this scan
const runtime = (await readFile("src/frontend_runtime.ts", "utf8")) + "\n" + (await readFile("src/support_routes.ts", "utf8")) + "\n" + (await readFile("src/seller_fulfillment_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_control_center_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_growth_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_demo_readiness_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_ops_overview_routes.ts", "utf8"));
const frontend = await readFile("frontend/app.js", "utf8");

assert.match(runtime, /app\.get\(["']\/api\/mall\/deals/);
assert.equal(/app\.get\(["']\/api\/(catalog|search|deals\/search)/i.test(runtime), false);
assert.match(frontend, /חיפוש תפעולי פנימי בלבד/);
assert.match(frontend, /Mall|קניון/);
console.log("PASS admin omnisearch stays internal while bounded public Mall remains canonical");
