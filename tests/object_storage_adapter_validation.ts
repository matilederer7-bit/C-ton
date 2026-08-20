import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildStorageAdapter, LocalStorageAdapter, resetStorageAdapterForTests, S3CompatibleStorageAdapter } from "../src/storage_adapter.js";

const base = { endpoint: "http://minio.invalid:9000", region: "us-east-1", bucket: "private-bucket", accessKeyId: "access-key", secretAccessKey: "secret-key", forcePathStyle: true, timeoutMs: 1000, signedUrlTtlSeconds: 60 };
const objects = new Map<string, { body: Buffer; contentType: string; checksum: string }>();
const client = {
  async send(command: any) {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "PutObjectCommand") {
      if (objects.has(input.Key)) { const error: any = new Error("exists"); error.name = "PreconditionFailed"; error.$metadata = { httpStatusCode: 412 }; throw error; }
      objects.set(input.Key, { body: Buffer.from(input.Body), contentType: input.ContentType, checksum: input.Metadata.checksum_sha256 });
      return {};
    }
    if (name === "HeadObjectCommand") {
      const row = objects.get(input.Key); if (!row) { const error: any = new Error("missing"); error.name = "NotFound"; error.$metadata = { httpStatusCode: 404 }; throw error; }
      return { ContentLength: row.body.length, ContentType: row.contentType, Metadata: { checksum_sha256: row.checksum } };
    }
    if (name === "GetObjectCommand") {
      const row = objects.get(input.Key); if (!row) { const error: any = new Error("missing"); error.name = "NoSuchKey"; throw error; }
      return { Body: { transformToByteArray: async () => row.body } };
    }
    if (name === "DeleteObjectCommand") { objects.delete(input.Key); return {}; }
    if (name === "ListObjectsV2Command") return { Contents: [...objects.keys()].filter((key) => !input.Prefix || key.startsWith(input.Prefix)).map((Key) => ({ Key })) };
    throw new Error(`unexpected command ${name}`);
  }
};

const content = Buffer.from("object-storage-contract");
const checksum = createHash("sha256").update(content).digest("hex");
const adapter = new S3CompatibleStorageAdapter(base, client as any);
const key = "sandbox/deals/00000000-0000-0000-0000-000000000001/images/generated.png";
const stored = await adapter.put(key, content, { contentType: "image/png", checksumSha256: checksum });
assert.equal(stored.storage_provider, "s3");
assert.deepEqual(await adapter.get(key), content);
assert.deepEqual(await adapter.metadata(key), { exists: true, size_bytes: content.length, checksum_sha256: checksum, content_type: "image/png" });
assert.equal(await adapter.exists(key), true);
assert.deepEqual(await adapter.listKeys("sandbox/deals"), [key]);
assert.deepEqual(await adapter.listKeys("sandbox/deals/"), [key]);
assert.deepEqual(await adapter.listKeys(""), [key]);
await assert.rejects(() => adapter.put(key, content), (error: any) => error.code === "storage_object_exists");
await adapter.delete(key);
await adapter.delete(key);
assert.equal(await adapter.exists(key), false);
assert.equal(adapter.describeForReadiness().bucket, "<configured>");
assert.equal(adapter.capabilities().multi_instance_safe, true);

let verificationDeleteCount = 0;
const verificationObjects = new Set<string>();
const verificationFailureClient = {
  async send(command: any) {
    const name = command.constructor.name;
    if (name === "PutObjectCommand") { verificationObjects.add(command.input.Key); return {}; }
    if (name === "HeadObjectCommand") { const error: any = new Error("head denied"); error.name = "AccessDenied"; error.$metadata = { httpStatusCode: 403 }; throw error; }
    if (name === "DeleteObjectCommand") { verificationDeleteCount++; verificationObjects.delete(command.input.Key); return {}; }
    throw new Error(`unexpected command ${name}`);
  }
};
const verificationAdapter = new S3CompatibleStorageAdapter(base, verificationFailureClient as any);
const verificationKey = `${key}.verification-failure`;
await assert.rejects(() => verificationAdapter.put(verificationKey, content, { contentType: "image/png", checksumSha256: checksum }), (error: any) => error.code === "storage_access_denied");
assert.equal(verificationDeleteCount, 1);
assert.equal(verificationObjects.has(verificationKey), false);

const missingBucketClient = {
  async send() {
    const error: any = new Error("bucket missing");
    error.name = "NoSuchBucket";
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  }
};
const missingBucketAdapter = new S3CompatibleStorageAdapter(base, missingBucketClient as any);
await assert.rejects(() => missingBucketAdapter.get(key), (error: any) => error.code === "storage_bucket_not_found");
await assert.rejects(() => missingBucketAdapter.metadata(key), (error: any) => error.code === "storage_bucket_not_found");

resetStorageAdapterForTests();
assert.throws(() => buildStorageAdapter({ STORAGE_ADAPTER: "object" }), /object storage configuration invalid/);
resetStorageAdapterForTests();
assert.throws(() => buildStorageAdapter({ STORAGE_ADAPTER: "object", OBJECT_STORAGE_REGION: "us-east-1", OBJECT_STORAGE_BUCKET: "placeholder", OBJECT_STORAGE_ACCESS_KEY_ID: "test", OBJECT_STORAGE_SECRET_ACCESS_KEY: "dummy" }), /unsafe=/);
resetStorageAdapterForTests();
assert.ok(buildStorageAdapter({ STORAGE_ADAPTER: "local", DEAL_IMAGE_UPLOAD_DIR: process.cwd() }) instanceof LocalStorageAdapter);
resetStorageAdapterForTests();
console.log("PASS canonical S3-compatible adapter enforces metadata, checksum, no-overwrite, idempotent delete, masking and fail-closed config");
