import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// support routes moved out of frontend_runtime.ts (Lean Refactor); they stay in this scan
const runtime = (await readFile("src/frontend_runtime.ts", "utf8")) + "\n" + (await readFile("src/support_routes.ts", "utf8"));
const frontend = await readFile("frontend/app.js", "utf8");

assert.match(runtime, /app\.get\(["']\/api\/mall\/deals/);
assert.equal(/app\.get\(["']\/api\/(catalog|search|deals\/search)/i.test(runtime), false);
assert.match(frontend, /חיפוש תפעולי פנימי בלבד/);
assert.match(frontend, /Mall|קניון/);
console.log("PASS admin omnisearch stays internal while bounded public Mall remains canonical");
