import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const frontendRuntime = await readFile("src/frontend_runtime.ts", "utf8");
const frontendApp = await readFile("frontend/app.js", "utf8");

function routeExists(pattern: RegExp) {
  return pattern.test(frontendRuntime);
}

assert.equal(routeExists(/app\.post\(["']\/api\/admin\/[^"']*(capture|refund|void)[^"']*["']/i), false);
assert.equal(routeExists(/app\.post\(["']\/api\/admin\/[^"']*payout[^"']*["']/i), false);
assert.match(frontendApp, /לא מאפשר שינוי state ידני, capture, refund, void או העברה כספית ישירה/);
console.log("PASS admin has no direct capture/refund/void/payout mutation endpoints");
