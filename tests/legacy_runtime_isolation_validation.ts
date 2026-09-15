// OVERNIGHT HARDENING — the canonical Node runtime must not be able to reach
// the excluded surfaces: the Base44 edge functions, the legacy Render config,
// the external Stripe sandbox drivers, or the scripted lab payment provider.
// Their directories stay in the repository as history / separate deploy
// targets; this proof pins that nothing under src/ imports them, and that the
// only payment providers the runtime can construct are the ones the
// production guards reason about.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|js|cjs|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const IMPORT = /(?:import\s+(?:[^'"]*?from\s+)?|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
const FORBIDDEN_TARGETS = [/(^|\/)base44(\/|$)/, /(^|\/)legacy(\/|$)/, /(^|\/)external-tests(\/|$)/, /(^|\/)supabase\/functions(\/|$)/];

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error: any) { failed += 1; console.error(`FAIL ${name}: ${error?.message || error}`); }
}

const files = walk(SRC);
const imports = new Map<string, string[]>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const targets: string[] = [];
  for (const match of text.matchAll(IMPORT)) targets.push(String(match[1]));
  imports.set(relative(ROOT, file).replace(/\\/g, "/"), targets);
}

check("src/ never imports base44/, legacy/, external-tests/ or the Supabase edge functions", () => {
  const offenders: string[] = [];
  for (const [file, targets] of imports) {
    for (const target of targets) {
      if (FORBIDDEN_TARGETS.some((pattern) => pattern.test(target))) offenders.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(files.length > 50, `sanity: ${files.length} runtime files scanned`);
});

check("src/ never references a Base44 SDK, entity or invoke() call", () => {
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/base44|Base44|\.entities\.\w+\.(list|filter|create|update)\(|createClient\(\s*\{\s*appId/.test(text)) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

check("the scripted lab provider (synthetic_payment_provider) is reachable from tests only, never from src/", () => {
  const importers = [...imports].filter(([, targets]) => targets.some((t) => /synthetic_payment_provider/.test(t))).map(([file]) => file);
  assert.deepEqual(importers, [], "src/ must not construct the scripted lab provider");
});

check("payment_provider.ts only constructs providers the production guards know (grow, stripe, provider-ready http, mock)", () => {
  const text = readFileSync(join(SRC, "payment_provider.ts"), "utf8");
  const factories = [...text.matchAll(/function (build\w+PaymentProvider)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(factories, ["buildGrowCanonicalPaymentProvider", "buildMockPaymentProvider", "buildProviderReadyPaymentProvider", "buildStripePaymentProvider"].sort());
  assert.ok(/export function buildPaymentProvider\(/.test(text), "single selection entry point");
  const guards = readFileSync(join(SRC, "production_guards.ts"), "utf8");
  for (const token of ["mock", "grow", "stripe"]) assert.ok(guards.includes(token), `production guards reason about ${token}`);
});

check("no route module registers a Render-legacy or Base44 HTTP path", () => {
  const routeFiles = ["app.ts", "frontend_runtime.ts", "receipt_content_routes.ts"].map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
  const paths = [...routeFiles.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)].map((m) => String(m[1]));
  assert.ok(paths.length > 150, `sanity: ${paths.length} routes`);
  const legacy = paths.filter((p) => /base44|\/legacy\/|\/render\//i.test(p));
  assert.deepEqual(legacy, []);
});

if (failed) {
  console.error(`FAILED ${failed} legacy runtime isolation checks`);
  process.exit(1);
}
console.log("All legacy runtime isolation checks passed.");
