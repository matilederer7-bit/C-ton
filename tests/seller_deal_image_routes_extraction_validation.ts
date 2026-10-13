import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile("src/app.ts", "utf8");
const routes = await readFile("src/seller_deal_image_routes.ts", "utf8");

function occurrences(text: string, needle: string) {
  return text.split(needle).length - 1;
}

function assertBefore(src: string, first: string, second: string, message: string) {
  const firstIndex = src.indexOf(first);
  const secondIndex = src.indexOf(second);
  assert.ok(firstIndex >= 0, `${message}: missing ${first}`);
  assert.ok(secondIndex >= 0, `${message}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, message);
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
assertBefore(upload, "requireSellerAuthority(req, c)", 'requireUuid(dealId, "deal_id")', "upload auth must precede id validation");
assertBefore(upload, 'ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate")', 'requireUuid(dealId, "deal_id")', "upload seller-status guard must precede id validation");
assertBefore(upload, "assertSellerDealImageQuota", "saveDealImage({", "seller quota must be checked before bytes reach storage");
assert.match(upload, /hitTestFault\("http\.upload\.after_commit_before_response"\)/, "upload response-loss boundary must remain");

const reorderStart = uploadEnd;
const reorderEnd = routes.indexOf('app.delete("/api/seller/deals/:dealId/images/:imageId"', reorderStart);
const reorder = routes.slice(reorderStart, reorderEnd);
assertBefore(reorder, "requireSellerAuthorityWithoutBody(req, c)", 'requireUuid(dealId, "deal_id")', "reorder auth must precede id validation");
assertBefore(reorder, 'ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate")', 'requireUuid(dealId, "deal_id")', "reorder seller-status guard must precede id validation");
assert.match(reorder, /DEAL_IMAGE_ORDER_STALE/, "stale image ordering contract must remain");

const deletion = routes.slice(reorderEnd);
assertBefore(deletion, "requireSellerAuthority(req, c)", 'requireUuid(dealId, "deal_id")', "delete auth must precede id validation");
assertBefore(deletion, 'ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate")', 'requireUuid(dealId, "deal_id")', "delete seller-status guard must precede id validation");
assert.match(deletion, /retained_shared/, "shared storage objects must remain protected");
assert.match(deletion, /enqueueStorageCleanupTask\(removed\.storage_provider, removed\.storage_key, "deal_image_deleted"\)/);
assert.match(deletion, /hitTestFault\("http\.delete\.after_commit_before_response"\)/);

console.log("Seller deal image route extraction validation passed.");
