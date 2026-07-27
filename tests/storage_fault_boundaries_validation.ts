import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LocalStorageAdapter, S3CompatibleStorageAdapter } from "../src/storage_adapter.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { armTestFault, resetTestFaults } from "../src/fault_injection.js";

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "test";
const config = { endpoint: "http://fault.invalid", region: "test", bucket: "private", accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true, timeoutMs: 100, signedUrlTtlSeconds: 10 };
const content = Buffer.from("deterministic-storage-fault");
const checksum = createHash("sha256").update(content).digest("hex");

for (let run = 0; run < 10; run += 1) {
  const objects = new Map<string, { body: Buffer; checksum: string }>();
  let deletes = 0;
  const client = { async send(command: any) {
    const name = command.constructor.name;
    const key = String(command.input.Key);
    if (name === "PutObjectCommand") { objects.set(key, { body: Buffer.from(command.input.Body), checksum: command.input.Metadata.checksum_sha256 }); return {}; }
    if (name === "HeadObjectCommand") { const row = objects.get(key); if (!row) { const error: any = new Error("missing"); error.name = "NotFound"; throw error; } return { ContentLength: row.body.length, Metadata: { checksum_sha256: row.checksum }, ContentType: "image/png" }; }
    if (name === "DeleteObjectCommand") { deletes += 1; objects.delete(key); return {}; }
    throw new Error(`unexpected ${name}`);
  }};
  const adapter = new S3CompatibleStorageAdapter(config, client as any);
  const key = `fault/${run}/image.png`;

  armTestFault("storage.after_put_before_verify", { kind: "throw", code: "lost_after_put" });
  await assert.rejects(() => adapter.put(key, content, { checksumSha256: checksum }), (error: any) => error.code === "storage_write_failed" || error.code === "lost_after_put");
  assert.equal(objects.has(key), false, "successful remote PUT followed by failure must be compensated");
  assert.equal(deletes, 1);

  armTestFault("storage.before_put", { kind: "throw", code: "put_unavailable" });
  await assert.rejects(() => adapter.put(`${key}.before`, content, { checksumSha256: checksum }));
  assert.equal(objects.has(`${key}.before`), false);

  await adapter.put(key, content, { checksumSha256: checksum });
  armTestFault("storage.after_delete", { kind: "throw", code: "response_lost_after_delete" });
  await assert.rejects(() => adapter.delete(key), (error: any) => error.code === "storage_delete_failed");
  assert.equal(objects.has(key), false, "delete side effect is durable despite response loss");
  await adapter.delete(key);
  assert.equal(objects.has(key), false, "retry is idempotent");
  resetTestFaults();
}
const localRoot = await mkdtemp(join(tmpdir(), "siton-storage-fault-"));
try {
  const local = new LocalStorageAdapter(localRoot);
  const localKey = "partial/image.png";
  armTestFault("storage.after_bytes_before_publish", { kind: "throw", code: "partial_write_interrupted" });
  await assert.rejects(() => local.put(localKey, content, { checksumSha256: checksum }), (error: any) => error.code === "partial_write_interrupted");
  assert.equal(await local.exists(localKey), false);
  assert.deepEqual(await readdir(join(localRoot, "partial")), [], "partial files must be removed before another Web can see them");
  await local.put(localKey, content, { checksumSha256: checksum });
  assert.equal(await local.exists(localKey), true);
} finally {
  resetTestFaults();
  await rm(localRoot, { recursive: true, force: true });
}
let timeoutDeleteAttempts = 0;
const beforeAcceptClient = { async send(command: any) {
  const name = command.constructor.name;
  if (name === "PutObjectCommand") { const error: any = new Error("timeout before accept"); error.name = "TimeoutError"; throw error; }
  if (name === "HeadObjectCommand") { const error: any = new Error("missing"); error.name = "NotFound"; throw error; }
  if (name === "DeleteObjectCommand") { timeoutDeleteAttempts += 1; return {}; }
  throw new Error(`unexpected ${name}`);
}};
await assert.rejects(() => new S3CompatibleStorageAdapter(config, beforeAcceptClient as any).put("timeout/before.png", content, { checksumSha256: checksum }), (error: any) => error.code === "storage_timeout");
assert.equal(timeoutDeleteAttempts, 1);

const accepted = new Map<string, { body: Buffer; checksum: string }>();
let acceptedPuts = 0;
const afterAcceptClient = { async send(command: any) {
  const name = command.constructor.name; const key = String(command.input.Key);
  if (name === "PutObjectCommand") { acceptedPuts += 1; accepted.set(key, { body: Buffer.from(command.input.Body), checksum: command.input.Metadata.checksum_sha256 }); const error: any = new Error("response lost"); error.name = "TimeoutError"; throw error; }
  if (name === "HeadObjectCommand") { const row = accepted.get(key)!; return { ContentLength: row.body.length, Metadata: { checksum_sha256: row.checksum } }; }
  if (name === "DeleteObjectCommand") { accepted.delete(key); return {}; }
  throw new Error(`unexpected ${name}`);
}};
const reconciled = await new S3CompatibleStorageAdapter(config, afterAcceptClient as any).put("timeout/after.png", content, { checksumSha256: checksum });
assert.equal(reconciled.storage_key, "timeout/after.png");
assert.equal(acceptedPuts, 1, "outcome-unknown PUT must reconcile instead of retrying blindly");
assert.equal(accepted.size, 1);

let headTimeoutObject = true;
const headTimeoutClient = { async send(command: any) {
  const name = command.constructor.name;
  if (name === "PutObjectCommand") return {};
  if (name === "HeadObjectCommand") { const error: any = new Error("head timeout"); error.name = "TimeoutError"; throw error; }
  if (name === "DeleteObjectCommand") { headTimeoutObject = false; return {}; }
  throw new Error(`unexpected ${name}`);
}};
await assert.rejects(() => new S3CompatibleStorageAdapter(config, headTimeoutClient as any).put("timeout/head.png", content, { checksumSha256: checksum }), (error: any) => error.code === "storage_timeout");
assert.equal(headTimeoutObject, false);

console.log("PASS storage timeout boundaries reconcile before/after acceptance and fail closed on HEAD timeout");console.log("PASS storage fault boundaries are deterministic across 10 runs with cleanup and idempotent delete recovery");