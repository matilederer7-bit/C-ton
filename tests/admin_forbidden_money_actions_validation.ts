import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFrontendRuntimeFamily } from "./helpers/route_sources.js";

// Every module extracted from frontend_runtime.ts stays in this scan (scripts/lib/route_modules.cjs).
const frontendRuntime = (await readFrontendRuntimeFamily());
const frontendApp = await readFile("frontend/app.js", "utf8");

function routeExists(pattern: RegExp) {
  return pattern.test(frontendRuntime);
}

assert.equal(routeExists(/app\.post\(["']\/api\/admin\/[^"']*(capture|refund|void)[^"']*["']/i), false);
assert.equal(routeExists(/app\.post\(["']\/api\/admin\/[^"']*payout[^"']*["']/i), false);
assert.match(frontendApp, /לא מאפשר שינוי סטייט ידני, חיוב, זיכוי, ביטול חיוב או העברה כספית ישירה/);

console.log("PASS admin has no direct capture/refund/void/payout mutation endpoints");
