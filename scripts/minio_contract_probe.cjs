const { createHash, randomUUID } = require("node:crypto");

async function main() {
  const { S3CompatibleStorageAdapter } = await import("../.demo_dist/src/storage_adapter.js");
  const base = {
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION,
    bucket: process.env.OBJECT_STORAGE_BUCKET,
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: true,
    timeoutMs: 1500,
    signedUrlTtlSeconds: 10
  };
  const adapter = new S3CompatibleStorageAdapter(base);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const checksum = createHash("sha256").update(png).digest("hex");
  const key = `ci/contracts/${randomUUID()}.png`;
  const stored = await adapter.put(key, png, { contentType: "image/png", checksumSha256: checksum });
  if (stored.checksum_sha256 !== checksum) throw new Error("put checksum mismatch");
  const metadata = await adapter.metadata(key);
  if (!metadata.exists || metadata.size_bytes !== png.length || metadata.checksum_sha256 !== checksum || metadata.content_type !== "image/png") throw new Error(`metadata mismatch ${JSON.stringify(metadata)}`);
  if (!(await adapter.listKeys("ci/contracts")).includes(key)) throw new Error("list missing uploaded object");
  const downloaded = await adapter.get(key);
  if (!downloaded.equals(png)) throw new Error("download mismatch");
  await adapter.put(`${key}-other`, png, { contentType: "image/png", checksumSha256: checksum });
  await adapter.put(`${key}-same-filename`, png, { contentType: "image/png", checksumSha256: checksum });
  await adapter.put(key, png, { contentType: "image/png", checksumSha256: checksum }).then(() => { throw new Error("overwrite unexpectedly succeeded"); }, (error) => { if (error.code !== "storage_object_exists") throw error; });
  const unsigned = `${base.endpoint}/${base.bucket}/${key}`;
  const anonymous = await fetch(unsigned);
  if (anonymous.status !== 403) throw new Error(`private bucket anonymous read returned ${anonymous.status}`);
  const signed = await adapter.signedReadUrl(key, 10);
  const signedRead = await fetch(signed);
  const signedBody = Buffer.from(await signedRead.arrayBuffer());
  if (!signedRead.ok || !signedBody.equals(png)) throw new Error(`signed read failed status=${signedRead.status} bytes=${signedBody.length}`);
  await new Promise((resolve) => setTimeout(resolve, 11100));
  const expired = await fetch(signed);
  if (expired.status !== 403) throw new Error(`expired signed URL returned ${expired.status}`);

  const reader = new S3CompatibleStorageAdapter({ ...base, accessKeyId: "siton-ci-reader", secretAccessKey: "siton-ci-reader-secret" });
  await reader.get(key);
  await reader.put(`ci/contracts/reader-${randomUUID()}.png`, png).then(() => { throw new Error("read-only write unexpectedly succeeded"); }, (error) => { if (error.code !== "storage_access_denied") throw error; });
  const writer = new S3CompatibleStorageAdapter({ ...base, accessKeyId: "siton-ci-writer", secretAccessKey: "siton-ci-writer-secret" });
  const writeOnlyKey = `ci/contracts/writer-${randomUUID()}.png`;
  await writer.put(writeOnlyKey, png, { contentType: "image/png", checksumSha256: checksum }).then(() => { throw new Error("write-only verification unexpectedly succeeded"); }, (error) => { if (error.code !== "storage_access_denied") throw error; });
  await writer.delete(writeOnlyKey);

  const wrongCredentials = new S3CompatibleStorageAdapter({ ...base, accessKeyId: "wrong", secretAccessKey: "wrong-secret" });
  await wrongCredentials.get(key).then(() => { throw new Error("wrong credentials unexpectedly succeeded"); }, (error) => { if (error.code !== "storage_access_denied") throw error; });
  const missingBucket = new S3CompatibleStorageAdapter({ ...base, bucket: "missing-private-bucket" });
  await missingBucket.get(key).then(() => { throw new Error("missing bucket unexpectedly succeeded"); }, (error) => { if (error.code !== "storage_bucket_not_found") throw error; });
  const unavailable = new S3CompatibleStorageAdapter({ ...base, endpoint: "http://127.0.0.1:1", timeoutMs: 300 });
  await unavailable.get(key).then(() => { throw new Error("unavailable endpoint unexpectedly succeeded"); }, (error) => { if (!["storage_read_failed", "storage_timeout"].includes(error.code)) throw error; });

  await adapter.delete(key);
  await adapter.delete(key);
  if (await adapter.exists(key)) throw new Error("idempotent delete left object present");
  await adapter.delete(`${key}-other`);
  await adapter.delete(`${key}-same-filename`);
  console.log("MINIO_CONTRACT_PASS", JSON.stringify({ upload: "pass", metadata: "pass", checksum: "pass", download: "pass", delete: "pass", repeat_delete: "pass", signed_url: "pass", signed_url_expiry: "pass", private_bucket: "pass", no_overwrite: "pass", missing_bucket: "pass", bad_credentials: "pass", missing_write_permission: "pass", missing_read_permission: "pass", unavailable_endpoint: "pass" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
