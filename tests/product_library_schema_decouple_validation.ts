import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("src/app.ts", "utf8");
const schema = fs.readFileSync("src/schema_contract.ts", "utf8");
const migration072 = fs.readFileSync("src/migrations/072_product_catalog_and_fulfillment_estimates.sql", "utf8");

function runtimeSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = dir + "/" + entry.name;
    if (entry.isDirectory()) {
      if (full === "src/migrations") continue;
      out.push(...runtimeSourceFiles(full));
    } else if (/\.(?:ts|js|cjs|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// PR C1 is runtime-only decoupling. Product Library tables/columns still exist
// until the separately reviewed forward migration (C2), but runtime code must
// no longer query product_images or fail readiness on that table.
for (const file of runtimeSourceFiles("src")) {
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, /siton\.product_images/i, `runtime must not query siton.product_images after C1: ${file}`);
}
assert.doesNotMatch(schema, /["']product_images["']/, "readiness must not require product_images after C1");

// The old Product-backed create replay is independent of the Product tables.
// Preserve the original request hash input + deferred-validation path so an
// idempotent retry created before Product Library removal still recovers its
// stored response instead of getting a new 400.
assert.match(app, /const legacyProductId = typeof body\.product_id === "string"/);
assert.match(app, /const deferLegacyValidation = Boolean\(createIdempotencyKey && legacyProductId\)/);
assert.match(app, /product_id:\s*legacyProductId \|\| null/);
assert.match(app, /String\(prior\.rows\[0\]\.request_hash \|\| ""\) !== createRequestHash/);

// C1 never edits migration 072 and never retires the delivery-estimate feature
// that happened to land in the same historical migration.
assert.match(migration072, /CREATE TABLE IF NOT EXISTS siton\.products/);
assert.match(migration072, /CREATE TABLE IF NOT EXISTS siton\.product_images/);
assert.match(migration072, /estimated_min_business_days/);
assert.match(migration072, /estimated_max_business_days/);

console.log("PASS Product Library C1: runtime decoupled from product_images, legacy replay and delivery estimates preserved");
