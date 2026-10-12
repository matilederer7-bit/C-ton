// The route-module registry (scripts/lib/route_modules.cjs) is the one list the
// static gates and the text-reading tests use to find "the runtime". This test
// proves the registry is complete and that its runtime twin is identical, so a
// Lean Refactor extraction can no longer narrow a scan by omission.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REFUND_READINESS_ROUTE_MODULES } from "../src/refund_route_readiness.js";
import {
  FRONTEND_RUNTIME_FAMILY,
  FRONTEND_RUNTIME_FAMILY_FILES,
  ROUTE_MODULES,
  ROUTE_MODULE_FILES
} from "./helpers/route_sources.js";

const SRC = join(process.cwd(), "src");

// 1. The runtime copy used by the live refund-readiness scan is byte-identical.
assert.deepEqual([...ROUTE_MODULES], [...REFUND_READINESS_ROUTE_MODULES], "scripts/lib/route_modules.cjs and src/refund_route_readiness.ts must list the same modules in the same order");

// 2. Every file is real.
for (const file of ROUTE_MODULE_FILES) assert.ok(existsSync(join(process.cwd(), file)), `${file} is listed but missing`);

// 3. Every src/*_routes.ts module is listed, so a new extraction cannot be forgotten.
const routeFilesOnDisk = readdirSync(SRC).filter((name) => /_routes\.ts$/.test(name)).map((name) => name.replace(/\.ts$/, "")).sort();
const missing = routeFilesOnDisk.filter((name) => !ROUTE_MODULES.includes(name));
assert.deepEqual(missing, [], "src/*_routes.ts modules missing from scripts/lib/route_modules.cjs (add them to ROUTE_MODULES and, if extracted from frontend_runtime.ts, to FRONTEND_RUNTIME_FAMILY)");

// 4. The two entry modules and the two non-"_routes" route modules are present.
for (const name of ["app", "frontend_runtime", "distribution_hub"]) assert.ok(ROUTE_MODULES.includes(name), `${name} must be a route module`);

// 5. The family is a subset of the registry, starts with frontend_runtime.ts and has no duplicates.
assert.equal(FRONTEND_RUNTIME_FAMILY[0], "frontend_runtime");
assert.deepEqual(FRONTEND_RUNTIME_FAMILY.filter((name) => !ROUTE_MODULES.includes(name)), []);
assert.equal(new Set(FRONTEND_RUNTIME_FAMILY).size, FRONTEND_RUNTIME_FAMILY.length);
assert.equal(new Set(ROUTE_MODULES).size, ROUTE_MODULES.length);
assert.deepEqual([...FRONTEND_RUNTIME_FAMILY_FILES], FRONTEND_RUNTIME_FAMILY.map((name) => `src/${name}.ts`));

// 6. Every listed module really registers routes (a stale entry would hide a rename).
const { readFileSync } = await import("node:fs");
for (const file of ROUTE_MODULE_FILES) {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  assert.ok(/\bapp\.(get|post|put|patch|delete)\(/.test(text), `${file} registers no route; remove it from the registry or fix the rename`);
}

console.log(`ROUTE_MODULE_REGISTRY_PASS modules=${ROUTE_MODULES.length} family=${FRONTEND_RUNTIME_FAMILY.length}`);
