import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PUBLIC_MALL_DEAL_FIELDS } from "../src/mall_read_model.js";

const fromRoot = (relative: string) => path.join(process.cwd(), relative);
const read = (relative: string) => fs.readFileSync(fromRoot(relative), "utf8");
const json = (relative: string) => JSON.parse(read(relative));
const require = createRequire(import.meta.url);
const { evaluateSnapshot, validateMallExtension, validateRegistry, validateRuntimeManifest } = require(fromRoot("scripts/base44_canonical_integrity_gate.cjs"));
const registry = json("config/base44-canonical-registry.json");
const callers = json("config/base44-canonical-callers.json");
const clean = json("tests/fixtures/base44_integrity_clean_snapshot.json");

const entities = new Map([
  ["MallDealProjection", "base44/entities/mall-deal-projection.jsonc"],
  ["DiscoveryEvent", "base44/entities/discovery-event.jsonc"],
  ["DealImage", "base44/entities/deal-image.jsonc"],
  ["SellerIdentity", "base44/entities/seller-identity.jsonc"]
]);
for (const [name, file] of entities) {
  const schema = json(file);
  assert.equal(schema.name, name);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  for (const operation of ["create", "read", "update", "delete"]) {
    assert.ok(Object.hasOwn(schema.rls, operation), `${name} needs explicit ${operation} RLS`);
  }
}

const projectionSchema = json(entities.get("MallDealProjection")!);
assert.deepEqual(
  new Set(Object.keys(projectionSchema.properties)),
  new Set(["source_deal_record_id", "source_image_record_id", "published_sort_key", ...PUBLIC_MALL_DEAL_FIELDS])
);
for (const internalField of ["source_deal_record_id", "source_image_record_id", "published_sort_key"]) {
  assert.equal(PUBLIC_MALL_DEAL_FIELDS.includes(internalField as never), false);
  assert.ok(projectionSchema.properties[internalField].rls.read);
  assert.ok(projectionSchema.properties[internalField].rls.write);
}
assert.notEqual(projectionSchema.rls.create, true);
assert.notEqual(projectionSchema.rls.update, true);
assert.notEqual(projectionSchema.rls.delete, true);
for (const privateEntity of ["DiscoveryEvent", "DealImage", "SellerIdentity"]) {
  assert.notEqual(json(entities.get(privateEntity)!).rls.read, true, `${privateEntity} must not be public-readable`);
}

const functionNames = ["list-mall-deals", "record-mall-event", "siton-seller-bootstrap", "siton-seller-deal-image", "project-mall-deal"];
for (const name of functionNames) {
  const config = json(`base44/functions/${name}/function.jsonc`);
  assert.equal(config.name, name);
  assert.equal(config.entry, "index.ts");
  if (name !== "project-mall-deal") assert.equal(config.automations, undefined);
  const source = read(`base44/functions/${name}/index.ts`);
  assert.match(source, /createClientFromRequest/);
  assert.doesNotMatch(source, /entities\.(?:Deal|Participant|MoneyLedgerEvent|SellerSettlement|SellerPayoutBatch)\.(?:create|update|delete)/);
  assert.doesNotMatch(source, /(?:commission|payout|charge|refund|ledger)_?(?:amount|rate|state)?\s*:/i);
}
const listSource = read("base44/functions/list-mall-deals/index.ts");
assert.match(listSource, /PUBLIC_FIELDS/);
assert.match(listSource, /encodeCursor/);
assert.match(listSource, /decodeCursor/);
assert.match(listSource, /filters,/);
assert.match(listSource, /next_cursor/);
assert.match(listSource, /visibility:\s*"public"/);
assert.match(listSource, /asServiceRole\.entities\.MallDealProjection\.filter/);
assert.match(listSource, /sort === "oldest" \? "published_sort_key" : "-published_sort_key"/);
assert.doesNotMatch(listSource, /SELECT\s+\*/i);
const eventSource = read("base44/functions/record-mall-event/index.ts");
for (const forbidden of ["ip_address", "user_agent", "buyer_email", "buyer_phone", "payment_reference"]) {
  assert.doesNotMatch(eventSource, new RegExp(`['\"]${forbidden}['\"]\\s*:`));
}
assert.match(read("base44/functions/siton-seller-bootstrap/index.ts"), /base44\.auth\.me\(\)/);
const sellerBootstrap = read("base44/functions/siton-seller-bootstrap/index.ts");
assert.match(sellerBootstrap, /entities\.SellerAccount\.create/);
assert.match(sellerBootstrap, /seller_identity_forbidden/);
for (const stableCode of ["SELLER_AUTH_REQUIRED", "SELLER_SESSION_EXPIRED", "SELLER_FORBIDDEN", "SELLER_AUTH_UNAVAILABLE"]) {
  assert.match(sellerBootstrap, new RegExp(stableCode));
}
assert.match(sellerBootstrap, /product_code:\s*productCode/);
assert.match(sellerBootstrap, /return_to:\s*safeReturnTo\(req\)/);
assert.match(sellerBootstrap, /isForbiddenError/);
assert.match(sellerBootstrap, /deterministicSellerId/);
assert.match(sellerBootstrap, /seller_account_id:\s*sellerAccountId/);
assert.match(sellerBootstrap, /coherentIdentityRows/);
assert.match(sellerBootstrap, /SellerIdentity\.bulkUpdate/);
const sellerIdentitySchema = json(entities.get("SellerIdentity")!);
assert.deepEqual(sellerIdentitySchema.rls.create, { user_condition: { role: "admin" } });
assert.doesNotMatch(sellerBootstrap, /input\.(?:user_id|base44_user_id|seller_id|seller_account_id)/);
const identitySchema = json(entities.get("SellerIdentity")!);
assert.ok(identitySchema.required.includes("seller_account_id"));
assert.ok(identitySchema.properties.seller_account_id.rls.write);
assert.ok(identitySchema.properties.base44_user_id.rls.write);
const sellerImageSource = read("base44/functions/siton-seller-deal-image/index.ts");
assert.match(sellerImageSource, /base44\.auth\.me\(\)/);
assert.match(sellerImageSource, /entities\.SellerIdentity\.filter/);
assert.match(sellerImageSource, /entities\.Deal\.filter/);
assert.match(sellerImageSource, /String\(deals\[0\]\?\.seller_id/);
assert.match(sellerImageSource, /bytesMatchMime/);
assert.match(sellerImageSource, /MAX_IMAGES\s*=\s*5/);
assert.match(sellerImageSource, /MAX_IMAGE_BYTES\s*=\s*2\s*\*\s*1024\s*\*\s*1024/);
assert.match(sellerImageSource, /integrations\.Core\.UploadFile/);
assert.match(sellerImageSource, /primaryCount[^]*image_primary_invalid[^]*DealImage\.bulkUpdate/);
assert.doesNotMatch(sellerImageSource, /input\.(?:user_id|base44_user_id|seller_id|seller_account_id)/);
const projectionConfig = json("base44/functions/project-mall-deal/function.jsonc");
assert.deepEqual(projectionConfig.automations.map((automation: any) => automation.entity_name), ["Deal", "DealImage"]);
for (const automation of projectionConfig.automations) {
  assert.deepEqual(automation.event_types, ["create", "update", "delete"]);
  assert.equal(automation.is_active, true);
}
const projectSource = read("base44/functions/project-mall-deal/index.ts");
assert.match(projectSource, /admin_required/);
for (const payloadField of ["event", "data", "old_data", "payload_too_large"]) assert.match(projectSource, new RegExp(payloadField));
assert.match(projectSource, /entities\.Deal\.get\(entityId\)/);
assert.match(projectSource, /entities\.DealImage\.get\(entityId\)/);
assert.match(projectSource, /delete_deal/);
assert.match(projectSource, /source_deal_record_id/);
assert.match(projectSource, /source_image_record_id/);
assert.match(projectSource, /participants_count/);
assert.match(projectSource, /business_name.*display_name/s);
assert.match(projectSource, /DealImage\.bulkUpdate/);
assert.match(projectSource, /is_published:\s*true/);
assert.match(projectSource, /published_sort_key:\s*`\$\{publishedAt\}\|\$\{dealId\}`/);
assert.match(projectSource, /const keeper = await existingProjection\(base44, dealId\)/);
assert.match(eventSource, /input\.client_event_id \?\? input\.session_id/);
assert.match(eventSource, /boundedRetryToken/);
assert.match(eventSource, /crypto\.subtle\.digest\("SHA-256"/);
assert.match(eventSource, /canonicalDealType = String\(publicDeals\[0\]\?\.deal_type/);
assert.match(eventSource, /canonicalMallStatus = String\(publicDeals\[0\]\?\.mall_status/);
assert.doesNotMatch(eventSource, /eventRecord\.deal_type = dealType/);
assert.doesNotMatch(eventSource, /eventRecord\.mall_status = mallStatus/);
assert.match(eventSource, /coalesceEventKey/);
assert.match(eventSource, /DiscoveryEvent\.delete\(duplicateId\)/);

assert.deepEqual(validateMallExtension(registry, callers), []);
assert.deepEqual(validateRegistry(registry, callers), []);
const runtimeManifest = json("base44/runtime-manifest.json");
assert.deepEqual(validateRuntimeManifest(runtimeManifest), []);
const renderRegression = structuredClone(runtimeManifest);
renderRegression.production_runtime = "render";
assert.ok(validateRuntimeManifest(renderRegression).some((finding: { code: string }) => finding.code === "invalid_base44_runtime_authority"));
const authorityRegression = structuredClone(runtimeManifest);
authorityRegression.public_discovery.owns_state_or_money = true;
assert.ok(validateRuntimeManifest(authorityRegression).some((finding: { code: string }) => finding.code === "invalid_base44_mall_runtime"));
const publishRegression = structuredClone(runtimeManifest);
publishRegression.publish_performed = true;
assert.ok(validateRuntimeManifest(publishRegression).some((finding: { code: string }) => finding.code === "invalid_base44_publish_boundary"));
assert.equal(registry.functions.length, 3, "Stage 32A canonical registry remains stable");
assert.equal(registry.entities.length, 25, "Stage 32A entity-pair registry remains stable");
assert.deepEqual(evaluateSnapshot(clean), []);
const projectionLeak = structuredClone(clean);
projectionLeak.mall_projections[0].buyer_email = "leak@example.invalid";
assert.ok(evaluateSnapshot(projectionLeak).some((finding: { code: string }) => finding.code === "mall_projection_private_field"));
const stateDrift = structuredClone(clean);
stateDrift.mall_projections[0].mall_status = "succeeded";
assert.ok(evaluateSnapshot(stateDrift).some((finding: { code: string }) => finding.code === "mall_projection_state_mismatch"));
const telemetryLeak = structuredClone(clean);
telemetryLeak.discovery_events[0].ip_address = "127.0.0.1";
assert.ok(evaluateSnapshot(telemetryLeak).some((finding: { code: string }) => finding.code === "discovery_event_pii_field"));

const migration = read("src/migrations/049_mall_discovery_read_model.sql");
assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.discovery_events/);
assert.match(migration, /idx_deals_mall_type_published/);
assert.match(migration, /idx_deals_mall_state_published/);
assert.match(migration, /idx_deal_images_mall_order/);
assert.doesNotMatch(migration, /WHERE public_url IS NOT NULL/);
assert.match(migration, /acquisition_source IN \('direct', 'mall', 'distributor', 'other'\)/);
assert.doesNotMatch(migration, /(?:buyer_email|buyer_phone|ip_address|user_agent|payment_reference)/i);

console.log("PASS Base44 Mall schemas, RLS, allowlists, canonical registry, drift gate and non-authoritative functions");
