import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const frontend = await readFile("frontend/app.js", "utf8");

assert.equal(/app\.get\(["']\/api\/(marketplace|catalog|search|deals\/search)/i.test(runtime), false);
assert.match(frontend, /חיפוש תפעולי פנימי בלבד/);
assert.match(frontend, /אינו marketplace, אינו קטלוג ציבורי ואינו חיפוש עסקאות לקונים/);
console.log("PASS admin search did not reintroduce public marketplace/search/catalog");
