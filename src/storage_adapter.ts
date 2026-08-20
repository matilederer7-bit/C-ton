import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { hitTestFault } from "./fault_injection.js";

export type StorageProviderCode = "local" | "s3";
export type StorageAdapterMode = "local" | "object";
export type StorageAdapterCapabilities = { multi_instance_safe: boolean; signed_urls_supported: boolean; immutable_content_addressed: boolean; scale_blocker_for_multi_instance: boolean; scale_notes: string[] };
export type StoredObject = { storage_provider: StorageProviderCode; storage_key: string; size_bytes: number; checksum_sha256?: string | undefined; content_type?: string | undefined };
export type StoredObjectMetadata = { exists: boolean; size_bytes: number | null; checksum_sha256: string | null; content_type: string | null };
export type PutObjectOptions = { contentType?: string; checksumSha256?: string; signal?: AbortSignal };
export type StorageAdapterSummary = { adapter: StorageAdapterMode; storage_provider: StorageProviderCode; configured: boolean; multi_instance_safe: boolean; scale_blocker_for_multi_instance: boolean; notes: string[]; root: string | null; bucket?: string | null; region?: string | null; endpoint_configured?: boolean; signed_url_ttl_seconds?: number | null };

export interface StorageAdapter {
  readonly mode: StorageAdapterMode;
  readonly providerCode: StorageProviderCode;
  capabilities(): StorageAdapterCapabilities;
  put(key: string, content: Buffer, options?: PutObjectOptions): Promise<StoredObject>;
  get(key: string, signal?: AbortSignal): Promise<Buffer>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
  exists(key: string, signal?: AbortSignal): Promise<boolean>;
  metadata(key: string, signal?: AbortSignal): Promise<StoredObjectMetadata>;
  signedReadUrl?(key: string, expiresInSeconds?: number): Promise<string>;
  listKeys(prefix?: string, limit?: number): Promise<string[]>;
  describeForReadiness(): StorageAdapterSummary;
}

function validateStorageKey(key: string) {
  const normalized = String(key || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    const err: any = new Error("invalid_storage_key"); err.statusCode = 400; err.code = "invalid_storage_key"; throw err;
  }
  return normalized;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly mode = "local" as const;
  readonly providerCode = "local" as const;
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  capabilities(): StorageAdapterCapabilities { return { multi_instance_safe: false, signed_urls_supported: false, immutable_content_addressed: true, scale_blocker_for_multi_instance: true, scale_notes: ["local filesystem cannot be shared safely between app instances", "object storage required before horizontal scale or live multi-instance"] }; }
  private resolveSafe(key: string) { const final = resolve(this.root, validateStorageKey(key)); if (!final.startsWith(this.root + sep)) { const err: any = new Error("invalid_storage_key"); err.statusCode = 400; err.code = "invalid_storage_key"; throw err; } return final; }
  async put(key: string, content: Buffer, options: PutObjectOptions = {}): Promise<StoredObject> {
    const normalized = validateStorageKey(key); const final = this.resolveSafe(normalized); const temporary = `${final}.partial-${randomUUID()}`;
    let published = false;
    try { await hitTestFault("storage.before_put"); await mkdir(dirname(final), { recursive: true }); const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); } await hitTestFault("storage.after_bytes_before_publish"); await link(temporary, final); published = true; await hitTestFault("storage.after_put_before_verify"); await rm(temporary, { force: true }); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); if (published) await rm(final, { force: true }).catch(() => undefined); const code = String((error as NodeJS.ErrnoException)?.code || ""); if (["EACCES", "EPERM", "EROFS", "ENOTDIR"].includes(code)) { const err: any = new Error("image upload storage is not writable"); err.statusCode = 500; err.code = "upload_storage_unwritable"; err.cause = error; throw err; } throw error; }
    return { storage_provider: this.providerCode, storage_key: normalized, size_bytes: content.length, checksum_sha256: options.checksumSha256, content_type: options.contentType };
  }
  async get(key: string) { return readFile(this.resolveSafe(key)); }
  async exists(key: string) { try { return (await stat(this.resolveSafe(key))).isFile(); } catch { return false; } }
  async metadata(key: string): Promise<StoredObjectMetadata> { await hitTestFault("storage.before_head"); try { const s = await stat(this.resolveSafe(key)); return { exists: s.isFile(), size_bytes: s.size, checksum_sha256: null, content_type: null }; } catch { return { exists: false, size_bytes: null, checksum_sha256: null, content_type: null }; } }
  async delete(key: string) { await hitTestFault("storage.before_delete"); await rm(this.resolveSafe(key), { force: true }); await hitTestFault("storage.after_delete"); }
  async listKeys(prefix = "", limit = 500) { const keys: string[] = []; const start = prefix ? this.resolveSafe(prefix) : this.root; await this.walk(start, keys, limit); return keys.map((p) => relative(this.root, p).split(sep).join("/")).filter(Boolean); }
  private async walk(dir: string, out: string[], limit: number) { if (out.length >= limit) return; let entries: any[] = []; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { if (out.length >= limit) return; const full = join(dir, entry.name); if (entry.isDirectory()) await this.walk(full, out, limit); else if (entry.isFile()) out.push(full); } }
  async fileSize(key: string) { const metadata = await this.metadata(key); return metadata.size_bytes; }
  describeForReadiness(): StorageAdapterSummary { return { adapter: this.mode, storage_provider: this.providerCode, configured: true, multi_instance_safe: false, scale_blocker_for_multi_instance: true, notes: ["object_storage_required_before_multi_instance", "local filesystem is appropriate for single-instance demo only"], root: this.isProductionLike() ? "<masked>" : this.root }; }
  private isProductionLike() { return process.env.NODE_ENV === "production" || process.env.RENDER === "true"; }
}

export type S3CompatibleStorageConfig = { endpoint?: string | undefined; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean; timeoutMs: number; signedUrlTtlSeconds: number };

function storageError(error: any, operation: string): never {
  const name = String(error?.name || error?.Code || "");
  if (name === "NoSuchBucket") { const err: any = new Error("storage_bucket_not_found"); err.statusCode = 503; err.code = "storage_bucket_not_found"; throw err; }
  if (["NoSuchKey", "NotFound"].includes(name) || Number(error?.$metadata?.httpStatusCode) === 404) { const err: any = new Error("storage_object_not_found"); err.statusCode = 404; err.code = "storage_object_not_found"; throw err; }
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(name) || Number(error?.$metadata?.httpStatusCode) === 403) { const err: any = new Error("storage_access_denied"); err.statusCode = 503; err.code = "storage_access_denied"; throw err; }
  if (["TimeoutError", "AbortError"].includes(name)) { const err: any = new Error("storage_timeout"); err.statusCode = 504; err.code = "storage_timeout"; throw err; }
  if (name === "PreconditionFailed" || Number(error?.$metadata?.httpStatusCode) === 412) { const err: any = new Error("storage_object_exists"); err.statusCode = 409; err.code = "storage_object_exists"; throw err; }
  const err: any = new Error(`storage_${operation}_failed`); err.statusCode = 503; err.code = `storage_${operation}_failed`; err.cause = error; throw err;
}

export class S3CompatibleStorageAdapter implements StorageAdapter {
  readonly mode = "object" as const;
  readonly providerCode = "s3" as const;
  private readonly client: S3Client;
  constructor(private readonly config: S3CompatibleStorageConfig, client?: S3Client) {
    this.client = client || new S3Client({ ...(config.endpoint ? { endpoint: config.endpoint } : {}), region: config.region, forcePathStyle: config.forcePathStyle, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  }
  capabilities(): StorageAdapterCapabilities { return { multi_instance_safe: true, signed_urls_supported: true, immutable_content_addressed: true, scale_blocker_for_multi_instance: false, scale_notes: ["private S3-compatible bucket", "short-lived signed reads supported"] }; }
  private signal(signal?: AbortSignal) { return signal || AbortSignal.timeout(this.config.timeoutMs); }
  async put(key: string, content: Buffer, options: PutObjectOptions = {}): Promise<StoredObject> {
    const normalized = validateStorageKey(key); const checksumHex = options.checksumSha256 || createHash("sha256").update(content).digest("hex");
    try { await hitTestFault("storage.before_put"); await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: normalized, Body: content, ContentLength: content.length, ContentType: options.contentType || "application/octet-stream", CacheControl: "private, max-age=0, no-store", ChecksumSHA256: Buffer.from(checksumHex, "hex").toString("base64"), Metadata: { checksum_sha256: checksumHex }, IfNoneMatch: "*" }), { abortSignal: this.signal(options.signal) }); }
    catch (error: any) {
      const timeout = ["TimeoutError", "AbortError"].includes(String(error?.name || ""));
      if (!timeout) storageError(error, "write");
      // PUT timeouts are outcome-unknown: reconcile the stable key before retrying.
      try {
        const reconciled = await this.metadata(normalized, options.signal);
        if (reconciled.exists && reconciled.size_bytes === content.length && reconciled.checksum_sha256 === checksumHex) {
          return { storage_provider: this.providerCode, storage_key: normalized, size_bytes: content.length, checksum_sha256: checksumHex, content_type: options.contentType };
        }
      } catch { /* cleanup below is the fail-closed outcome */ }
      await this.delete(normalized).catch(() => undefined);
      storageError(error, "write");
    }
    let head: StoredObjectMetadata; try { await hitTestFault("storage.after_put_before_verify"); head = await this.metadata(normalized, options.signal); } catch (error) { await this.delete(normalized).catch(() => undefined); throw error; } if (!head.exists || head.size_bytes !== content.length || head.checksum_sha256 !== checksumHex) { await this.delete(normalized).catch(() => undefined); const err: any = new Error("storage_verification_failed"); err.statusCode = 503; err.code = "storage_verification_failed"; throw err; }
    return { storage_provider: this.providerCode, storage_key: normalized, size_bytes: content.length, checksum_sha256: checksumHex, content_type: options.contentType };
  }
  async get(key: string, signal?: AbortSignal) { try { const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: validateStorageKey(key) }), { abortSignal: this.signal(signal) }); if (!result.Body) throw new Error("empty_storage_body"); return Buffer.from(await result.Body.transformToByteArray()); } catch (error) { storageError(error, "read"); } }
  async metadata(key: string, signal?: AbortSignal): Promise<StoredObjectMetadata> { try { await hitTestFault("storage.before_head"); const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: validateStorageKey(key) }), { abortSignal: this.signal(signal) }); return { exists: true, size_bytes: Number(result.ContentLength || 0), checksum_sha256: String(result.Metadata?.checksum_sha256 || "") || null, content_type: result.ContentType || null }; } catch (error: any) { const name = String(error?.name || error?.Code || ""); if (name === "NoSuchBucket") storageError(error, "metadata"); if (name === "NotFound" || Number(error?.$metadata?.httpStatusCode) === 404) return { exists: false, size_bytes: null, checksum_sha256: null, content_type: null }; storageError(error, "metadata"); } }
  async exists(key: string, signal?: AbortSignal) { return (await this.metadata(key, signal)).exists; }
  async delete(key: string, signal?: AbortSignal) { try { await hitTestFault("storage.before_delete"); await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: validateStorageKey(key) }), { abortSignal: this.signal(signal) }); await hitTestFault("storage.after_delete"); } catch (error) { storageError(error, "delete"); } }
  async signedReadUrl(key: string, expiresInSeconds = this.config.signedUrlTtlSeconds) { const ttl = Math.max(1, Math.min(3600, Number(expiresInSeconds || this.config.signedUrlTtlSeconds))); try { return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.bucket, Key: validateStorageKey(key), ResponseContentDisposition: "inline" }), { expiresIn: ttl }); } catch (error) { storageError(error, "sign"); } }
  async listKeys(prefix = "", limit = 500) { try { const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix ? validateStorageKey(prefix) : undefined, MaxKeys: Math.max(1, Math.min(1000, limit)) }), { abortSignal: this.signal() }); return (result.Contents || []).map((item) => String(item.Key || "")).filter(Boolean); } catch (error) { storageError(error, "list"); } }
  describeForReadiness(): StorageAdapterSummary { return { adapter: this.mode, storage_provider: this.providerCode, configured: true, multi_instance_safe: true, scale_blocker_for_multi_instance: false, notes: ["private_bucket_required", "s3_compatible_adapter_configured"], root: null, bucket: "<configured>", region: this.config.region, endpoint_configured: Boolean(this.config.endpoint), signed_url_ttl_seconds: this.config.signedUrlTtlSeconds }; }
}

function requiredExternalStorageConfig(env: NodeJS.ProcessEnv): S3CompatibleStorageConfig {
  const value = (name: string) => String(env[name] || "").trim();
  const missing = ["OBJECT_STORAGE_REGION", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"].filter((name) => !value(name));
  const forbidden = /^(placeholder|changeme|test|example|dummy|xxx|ci-placeholder)/i;
  const unsafe = ["OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"].filter((name) => forbidden.test(value(name)));
  if (missing.length || unsafe.length) { const err: any = new Error(`object storage configuration invalid: missing=${missing.join(",") || "none"}; unsafe=${unsafe.join(",") || "none"}`); err.code = "object_storage_configuration_invalid"; throw err; }
  return { endpoint: value("OBJECT_STORAGE_ENDPOINT") || undefined, region: value("OBJECT_STORAGE_REGION"), bucket: value("OBJECT_STORAGE_BUCKET"), accessKeyId: value("OBJECT_STORAGE_ACCESS_KEY_ID"), secretAccessKey: value("OBJECT_STORAGE_SECRET_ACCESS_KEY"), forcePathStyle: value("OBJECT_STORAGE_FORCE_PATH_STYLE") === "1", timeoutMs: Math.max(100, Number(value("OBJECT_STORAGE_TIMEOUT_MS") || 8000)), signedUrlTtlSeconds: Math.max(1, Math.min(3600, Number(value("OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS") || 300))) };
}

let cachedAdapter: StorageAdapter | null = null;
export function buildStorageAdapter(env: NodeJS.ProcessEnv = process.env): StorageAdapter { if (cachedAdapter) return cachedAdapter; const mode = String(env.STORAGE_ADAPTER || "local").trim().toLowerCase(); if (mode === "object" || mode === "s3") { cachedAdapter = new S3CompatibleStorageAdapter(requiredExternalStorageConfig(env)); return cachedAdapter; } if (mode !== "local") { const err: any = new Error("unsupported storage adapter"); err.code = "unsupported_storage_adapter"; throw err; } cachedAdapter = new LocalStorageAdapter(resolve(env.DEAL_IMAGE_UPLOAD_DIR || env.UPLOAD_DIR || join(process.cwd(), "uploads", "deal-images"))); return cachedAdapter; }
export function resetStorageAdapterForTests() { cachedAdapter = null; }
export function getStorageReadinessReport(adapter: StorageAdapter, opts: { configured_object_storage_env: boolean; orphan_count_unknown_reason?: string; active_image_keys_count?: number; orphan_keys_count?: number; missing_keys_count?: number }) { const summary = adapter.describeForReadiness(); const blockers = summary.scale_blocker_for_multi_instance ? ["object_storage_required_before_multi_instance"] : []; const warnings = opts.configured_object_storage_env ? [] : ["object_storage_not_configured"]; return { adapter: summary.adapter, storage_provider: summary.storage_provider, configured: summary.configured, multi_instance_safe: summary.multi_instance_safe, scale_status: summary.multi_instance_safe ? "ready" : "partial", notes: summary.notes, blockers, warnings, active_image_keys_count: opts.active_image_keys_count ?? null, orphan_keys_count: opts.orphan_keys_count ?? null, missing_keys_count: opts.missing_keys_count ?? null, orphan_count_unknown_reason: opts.orphan_count_unknown_reason || null, object_storage_configured: opts.configured_object_storage_env, object_storage_live_ready: summary.multi_instance_safe && opts.configured_object_storage_env, public_image_cache_policy: "public, max-age=31536000, immutable for content-addressed image ids" }; }
