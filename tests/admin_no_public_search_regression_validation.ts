import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFrontendRuntimeFamily } from "./helpers/route_sources.js";

// Every module extracted from frontend_runtime.ts stays in this scan (scripts/lib/route_modules.cjs).
const runtime = (await readFrontendRuntimeFamily());
const frontend = await readFile("frontend/app.js", "utf8");

assert.match(runtime, /app\.get\(["']\/api\/mall\/deals/);
assert.equal(/app\.get\(["']\/api\/(catalog|search|deals\/search)/i.test(runtime), false);
assert.match(frontend, /חיפוש תפעולי פנימי בלבד/);
assert.match(frontend, /Mall|קניון/);
console.log("PASS admin omnisearch stays internal while bounded public Mall remains canonical");
