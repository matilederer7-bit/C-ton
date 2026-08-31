// R7 — SupabaseBrokerStorageAdapter contract validation against a faked
// storage-broker protocol: put/verify, duplicate protection, idempotent
// delete, traversal rejection, error mapping, timeout reconciliation, and the
// public CDN read URL used by Mall/Deal surfaces.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SupabaseBrokerStorageAdapter, buildStorageAdapter, resetStorageAdapterForTests } from "../src/storage_adapter.js";

const config = { brokerUrl: "https://project.supabase.co/functions/v1/storage-broker", brokerKey: "sbk_valid-broker-key", supabaseUrl: "https://project.supabase.co", bucket: "deal-images", timeoutMs: 500 };

type FakeObject = { bytes: Buffer; contentType: string };
const objects = new Map<string, FakeObject>();
const calls: string[] = [];
let rejectAuth = false;
let failNextPutWithTimeout = false;
let dropUploadedBytesOnTimeout = false;

const fakeFetch = (async (_url: any, init: any) => {
  const body = JSON.parse(String(init.body));
  calls.push(String(body.op));
  const respond = (status: number, payload: Record<string, unknown>) =>
    ({ status, json: async () => payload }) as unknown as Response;
  if (rejectAuth || String(init.headers["x-siton-broker-key"]) !== config.brokerKey) {
    return respond(401, { ok: false, code: "broker_unauthorized" });
  }
  const key = String(body.key || "");
  if (body.op === "put") {
    if (failNextPutWithTimeout) {
      failNextPutWithTimeout = false;
      if (!dropUploadedBytesOnTimeout) objects.set(key, { bytes: Buffer.from(String(body.content_base64), "base64"), contentType: String(body.content_type) });
      const error: any = new Error("timeout"); error.name = "TimeoutError"; throw error;
    }
    if (objects.has(key)) return respond(409, { ok: false, code: "storage_object_exists" });
    const bytes = Buffer.from(String(body.content_base64), "base64");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== String(body.checksum_sha256)) return respond(400, { ok: false, code: "checksum_mismatch" });
    objects.set(key, { bytes, contentType: String(body.content_type) });
    return respond(200, { ok: true, verified: true, size_bytes: bytes.length, checksum_sha256: checksum });
  }
  if (body.op === "head") {
    const row = objects.get(key);
    if (!row) return respond(200, { ok: true, exists: false, size_bytes: null, content_type: null });
    return respond(200, { ok: true, exists: true, size_bytes: row.bytes.length, content_type: row.contentType });
  }
  if (body.op === "get") {
    const row = objects.get(key);
    if (!row) return respond(404, { ok: false, code: "storage_object_not_found" });
    return respond(200, { ok: true, content_base64: row.bytes.toString("base64"), content_type: row.contentType, size_bytes: row.bytes.length });
  }
  if (body.op === "delete") {
    const found = objects.delete(key);
    return respond(200, { ok: true, found });
  }
  if (body.op === "list") {
    const prefix = String(body.prefix || "");
    const keys = [...objects.keys()].filter((candidate) => !prefix || candidate.startsWith(`${prefix}/`) || candidate === prefix);
    return respond(200, { ok: true, keys: keys.slice(0, Number(body.limit || 500)) });
  }
  return respond(400, { ok: false, code: "unsupported_op" });
}) as unknown as typeof fetch;

const adapter = new SupabaseBrokerStorageAdapter(config, fakeFetch);
const content = Buffer.from("supabase-broker-contract");
const checksum = createHash("sha256").update(content).digest("hex");
const key = "staging/deals/00000000-0000-0000-0000-000000000001/images/generated.png";

// 1) put stores, verifies and reports the canonical provider code.
const stored = await adapter.put(key, content, { contentType: "image/png", checksumSha256: checksum });
assert.equal(stored.storage_provider, "supabase");
assert.equal(stored.size_bytes, content.length);
assert.equal(stored.checksum_sha256, checksum);

// 2) reads, metadata, existence and listing round-trip.
assert.deepEqual(await adapter.get(key), content);
assert.deepEqual(await adapter.metadata(key), { exists: true, size_bytes: content.length, checksum_sha256: null, content_type: "image/png" });
assert.equal(await adapter.exists(key), true);
assert.deepEqual(await adapter.listKeys("staging/deals"), [key]);

// 3) overwrite protection: the same key can never be replaced silently.
await assert.rejects(() => adapter.put(key, content), (error: any) => error.code === "storage_object_exists" && error.statusCode === 409);

// 4) delete is idempotent (double delete stays quiet).
await adapter.delete(key);
await adapter.delete(key);
assert.equal(await adapter.exists(key), false);

// 5) traversal and malformed keys are rejected before any network call.
for (const badKey of ["../escape.png", "a//b.png", "/rooted.png", "plain.png\0", ""]) {
  await assert.rejects(() => adapter.get(badKey), (error: any) => error.code === "invalid_storage_key");
}

// 6) an invalid broker key maps to storage_access_denied (fail closed, 503).
rejectAuth = true;
await assert.rejects(() => adapter.metadata(key), (error: any) => error.code === "storage_access_denied" && error.statusCode === 503);
rejectAuth = false;

// 7) missing object read maps to storage_object_not_found.
await assert.rejects(() => adapter.get(key), (error: any) => error.code === "storage_object_not_found" && error.statusCode === 404);

// 8) PUT timeout with the object actually stored reconciles to success
//    (outcome-unknown writes must not orphan verified stable keys).
failNextPutWithTimeout = true;
dropUploadedBytesOnTimeout = false;
const reconciled = await adapter.put(key, content, { contentType: "image/png", checksumSha256: checksum });
assert.equal(reconciled.size_bytes, content.length);
assert.equal(await adapter.exists(key), true);
await adapter.delete(key);

// 9) PUT timeout with nothing stored fails closed with storage_timeout and
//    leaves no object behind.
failNextPutWithTimeout = true;
dropUploadedBytesOnTimeout = true;
await assert.rejects(() => adapter.put(key, content, { contentType: "image/png", checksumSha256: checksum }), (error: any) => error.code === "storage_timeout");
assert.equal(await adapter.exists(key), false);

// 10) the public CDN read URL is derived from the storage key, encoded per
//     segment, and never leaks credentials.
const cdn = adapter.publicReadUrl(key);
assert.equal(cdn, `https://project.supabase.co/storage/v1/object/public/deal-images/${key}`);
assert.ok(!cdn.includes(config.brokerKey));
assert.throws(() => adapter.publicReadUrl("../escape.png"), (error: any) => error.code === "invalid_storage_key");

// 11) capabilities/readiness: durable, multi-instance-safe, no privileged
//     secret claims.
assert.equal(adapter.capabilities().multi_instance_safe, true);
const readiness = adapter.describeForReadiness();
assert.equal(readiness.storage_provider, "supabase");
assert.equal(readiness.multi_instance_safe, true);
assert.equal(readiness.scale_blocker_for_multi_instance, false);

// 12) buildStorageAdapter honors STORAGE_ADAPTER=supabase and fails closed on
//     missing or placeholder configuration.
resetStorageAdapterForTests();
assert.throws(
  () => buildStorageAdapter({ STORAGE_ADAPTER: "supabase" } as NodeJS.ProcessEnv),
  (error: any) => error.code === "object_storage_configuration_invalid"
);
resetStorageAdapterForTests();
assert.throws(
  () => buildStorageAdapter({ STORAGE_ADAPTER: "supabase", SUPABASE_URL: "https://project.supabase.co", SITON_STORAGE_BROKER_KEY: "placeholder-key" } as NodeJS.ProcessEnv),
  (error: any) => error.code === "object_storage_configuration_invalid"
);
resetStorageAdapterForTests();
const built = buildStorageAdapter({ STORAGE_ADAPTER: "supabase", SUPABASE_URL: "https://project.supabase.co/", SITON_STORAGE_BROKER_KEY: "sbk_sufficiently-random-value" } as NodeJS.ProcessEnv);
assert.equal(built.providerCode, "supabase");
assert.equal(built.mode, "object");
resetStorageAdapterForTests();

console.log("r7_supabase_broker_storage_validation: all assertions passed");
