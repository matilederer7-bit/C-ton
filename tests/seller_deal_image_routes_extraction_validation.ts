import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile("src/app.ts", "utf8");
const routes = await readFile("src/seller_deal_image_routes.ts", "utf8");

function occurrences(text: string, needle: string) {
  return text.split(needle).length - 1;
}

const registrations = [
  ['app.post("/api/seller/deals/:dealId/images"', "upload"],
  ['app.patch("/api/seller/deals/:dealId/images/order"', "reorder"],
  ['app.delete("/api/seller/deals/:dealId/images/:imageId"', "delete"]
] as const;

for (const [registration, label] of registrations) {
  assert.equal(occurrences(routes, registration), 1, `${label} route must be registered exactly once in the extracted module`);
  assert.equal(occurrences(app, registration), 0, `${label} route handler must not remain in app.ts`);
}

assert.equal(
  occurrences(app, "registerSellerDealImageRoutes(app, {"),
  1,
  "app.ts must wire the extracted seller image module exactly once"
);
assert.match(app, /import \{ registerSellerDealImageRoutes \} from "\.\/seller_deal_image_routes\.js";/);
assert.doesNotMatch(routes, /from "\.\/app\.js"/, "route module must not import app.ts");

const uploadStart = routes.indexOf('app.post("/api/seller/deals/:dealId/images"');
const uploadEnd = routes.indexOf('app.patch("/api/seller/deals/:dealId/images/order"', uploadStart);
const upload = routes.slice(uploadStart, uploadEnd);
assert.ok(upload.indexOf("requireSellerAuthority(req, c)") < upload.indexOf('requireUuid(dealId, "deal_id")'), "upload auth must precede id validation");
assert.ok(upload.indexOf("assertSellerDealImageQuota") < upload.indexOf("saveDealImage({"), "seller quota must be checked before bytes reach storage");
assert.match(upload, /hitTestFault\("http\.upload\.after_commit_before_response"\)/, "upload response-loss boundary must remain");

const reorderStart = uploadEnd;
const reorderEnd = routes.indexOf('app.delete("/api/seller/deals/:dealId/images/:imageId"', reorderStart);
const reorder = routes.slice(reorderStart, reorderEnd);
assert.ok(reorder.indexOf("requireSellerAuthorityWithoutBody(req, c)") < reorder.indexOf('requireUuid(dealId, "deal_id")'), "reorder auth must precede id validation");
assert.match(reorder, /DEAL_IMAGE_ORDER_STALE/, "stale image ordering contract must remain");

const deletion = routes.slice(reorderEnd);
assert.ok(deletion.indexOf("requireSellerAuthority(req, c)") < deletion.indexOf('requireUuid(dealId, "deal_id")'), "delete auth must precede id validation");
assert.match(deletion, /retained_shared/, "shared storage objects must remain protected");
assert.match(deletion, /enqueueStorageCleanupTask\(removed\.storage_provider, removed\.storage_key, "deal_image_deleted"\)/);
assert.match(deletion, /hitTestFault\("http\.delete\.after_commit_before_response"\)/);

console.log("Seller deal image route extraction validation passed.");
