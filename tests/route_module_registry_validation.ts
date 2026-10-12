// The route-module registry (scripts/lib/route_modules.cjs) is the one list the
// static gates and the text-reading tests use to find "the runtime". This test
// proves, in both directions, that the registry matches what the source tree
// actually does, so a Lean Refactor extraction can no longer narrow a scan by
// omission:
//
//   1. ROUTE_MODULES == every src/*.ts file that registers a route
//      (app.get/post/put/patch/delete), whatever the file is called.
//   2. FRONTEND_RUNTIME_FAMILY (minus frontend_runtime itself) plus
//      FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED == every module frontend_runtime.ts
//      imports a register*Routes() function from, with the two sets disjoint.
//   3. ROUTE_MODULES == REFUND_READINESS_ROUTE_MODULES (the runtime copy).
//
// The checks are pure functions over (registry, discovered) and are re-run on
// mutated inputs below, so removing a family member, forgetting a new registrar
// or keeping a stale entry each provably fails.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REFUND_READINESS_ROUTE_MODULES } from "../src/refund_route_readiness.js";
import {
  FRONTEND_RUNTIME_FAMILY,
  FRONTEND_RUNTIME_FAMILY_FILES,
  FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED,
  ROUTE_MODULES,
  ROUTE_MODULE_FILES
} from "./helpers/route_sources.js";

const SRC = join(process.cwd(), "src");
const ROUTE_REGISTRATION = /\bapp\.(get|post|put|patch|delete)\(/;
// `import { registerXxxRoutes } from "./<module>.js"` — the route-registrar convention every
// extracted module follows (helpers such as content_security_policy export register* functions
// that are not route registrars, so the name must end in Routes).
const REGISTER_IMPORT = /^import\s*\{[^}]*\bregister[A-Za-z]*Routes\b[^}]*\}\s*from\s*"\.\/([A-Za-z0-9_]+)\.js";/gm;

type Registry = {
  routeModules: readonly string[];
  family: readonly string[];
  wiredNotExtracted: readonly string[];
};
type Discovered = {
  registrars: readonly string[];      // src modules that register at least one route
  wiredByRuntime: readonly string[];  // modules frontend_runtime.ts imports register*Routes() from
};

const sorted = (list: readonly string[]) => [...list].sort();

function discover(): Discovered {
  const registrars = readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => ROUTE_REGISTRATION.test(readFileSync(join(SRC, name), "utf8")))
    .map((name) => name.replace(/\.ts$/, ""));
  const runtime = readFileSync(join(SRC, "frontend_runtime.ts"), "utf8");
  const wiredByRuntime = [...runtime.matchAll(REGISTER_IMPORT)].map((match) => String(match[1]));
  return { registrars: sorted(registrars), wiredByRuntime: sorted([...new Set(wiredByRuntime)]) };
}

function validateRegistry(registry: Registry, discovered: Discovered) {
  const { routeModules, family, wiredNotExtracted } = registry;
  assert.equal(new Set(routeModules).size, routeModules.length, "ROUTE_MODULES has a duplicate");
  assert.equal(new Set(family).size, family.length, "FRONTEND_RUNTIME_FAMILY has a duplicate");

  // 1. Registry == registrars, both ways (an unlisted registrar and a stale entry both fail).
  assert.deepEqual(sorted(routeModules), discovered.registrars,
    "ROUTE_MODULES must list exactly the src/*.ts modules that register routes (app.<method>(); add new route modules to scripts/lib/route_modules.cjs, remove renamed ones)");

  // 2. Family derived from the runtime's own wiring, both ways. The exception list is
  //    pinned here on purpose: demoting a family member into it would keep the union
  //    intact, so growing the list is a reviewed decision that must change this test.
  assert.deepEqual(sorted(wiredNotExtracted), ["distribution_hub", "receipt_content_routes"],
    "FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED changed: a module wired by frontend_runtime.ts but not extracted from it is a reviewed exception, update this pin deliberately");
  assert.equal(family[0], "frontend_runtime", "the family starts with frontend_runtime");
  const extracted = family.slice(1);
  assert.deepEqual(extracted.filter((name) => wiredNotExtracted.includes(name)), [],
    "a module cannot be both in FRONTEND_RUNTIME_FAMILY and FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED");
  assert.deepEqual(sorted([...extracted, ...wiredNotExtracted]), discovered.wiredByRuntime,
    "FRONTEND_RUNTIME_FAMILY (minus frontend_runtime) plus FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED must be exactly the modules frontend_runtime.ts imports register*Routes() from (a removed family member or a new extraction both fail here)");
  for (const name of [...family, ...wiredNotExtracted]) {
    assert.ok(routeModules.includes(name), `${name} is in the family lists but not in ROUTE_MODULES`);
  }
}

const registry: Registry = {
  routeModules: ROUTE_MODULES,
  family: FRONTEND_RUNTIME_FAMILY,
  wiredNotExtracted: FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED
};
const discovered = discover();

// Real registry against the real tree.
validateRegistry(registry, discovered);
assert.deepEqual([...ROUTE_MODULES], [...REFUND_READINESS_ROUTE_MODULES],
  "scripts/lib/route_modules.cjs and src/refund_route_readiness.ts must list the same modules in the same order");
assert.deepEqual([...ROUTE_MODULE_FILES], ROUTE_MODULES.map((name) => `src/${name}.ts`));
assert.deepEqual([...FRONTEND_RUNTIME_FAMILY_FILES], FRONTEND_RUNTIME_FAMILY.map((name) => `src/${name}.ts`));
assert.ok(discovered.registrars.length >= 14, `sanity: ${discovered.registrars.length} registrars`);
assert.ok(discovered.wiredByRuntime.length >= 10, `sanity: ${discovered.wiredByRuntime.length} modules wired by frontend_runtime.ts`);

// Mutation proofs: each omission class the registry exists to prevent must fail.
const fails = (label: string, mutated: Registry, input: Discovered = discovered) => {
  assert.throws(() => validateRegistry(mutated, input), `mutation must fail: ${label}`);
};
for (const victim of FRONTEND_RUNTIME_FAMILY.slice(1)) {
  fails(`family without ${victim}`, { ...registry, family: FRONTEND_RUNTIME_FAMILY.filter((name) => name !== victim) });
}
for (const victim of ROUTE_MODULES) {
  fails(`registry without ${victim}`, { ...registry, routeModules: ROUTE_MODULES.filter((name) => name !== victim) });
}
fails("stale registry entry", { ...registry, routeModules: [...ROUTE_MODULES, "renamed_away_routes"] });
fails("new registrar not in the registry", registry, { ...discovered, registrars: sorted([...discovered.registrars, "zz_probe_routes"]) });
fails("new extraction wired by the runtime but not in the family", registry, { ...discovered, wiredByRuntime: sorted([...discovered.wiredByRuntime, "zz_probe_routes"]) });
fails("family member demoted into the exception list", {
  ...registry,
  family: FRONTEND_RUNTIME_FAMILY.filter((name) => name !== "support_routes"),
  wiredNotExtracted: [...FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED, "support_routes"]
});
fails("module in both the family and the exception list", {
  ...registry,
  family: [...FRONTEND_RUNTIME_FAMILY, String(FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED[0])]
});

console.log(`ROUTE_MODULE_REGISTRY_PASS modules=${ROUTE_MODULES.length} family=${FRONTEND_RUNTIME_FAMILY.length} wired_not_extracted=${FRONTEND_RUNTIME_WIRED_NOT_EXTRACTED.length}`);
