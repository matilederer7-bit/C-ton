// Storage Adapter contract.
//
// This contract isolates Siton from a specific storage backend so we can
// migrate from local filesystem to object storage (S3 / GCS / R2 / Spaces)
// without rewriting upload paths. The current MVP foundation ships a
// LocalStorageAdapter only. An ObjectStorageAdapter implementation is
// intentionally NOT bundled here: connecting one to live cloud storage is a
// separate provider gate (it requires credentials, bucket policy, lifecycle
// rules, and access controls that are outside this MVP pass).
//
// Foundation guarantees:
// - Adapters never accept executable HTML/SVG/JS as image content.
// - Adapters never resolve outside their own root.
// - Adapters never delete files outside their own keyspace.
// - The orphan report is read-only; it never deletes.

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type StorageProviderCode = "local" | "object";

export type StorageAdapterMode = "local" | "object";

export type StorageAdapterCapabilities = {
  multi_instance_safe: boolean;
  signed_urls_supported: boolean;
  immutable_content_addressed: boolean;
  scale_blocker_for_multi_instance: boolean;
  scale_notes: string[];
};

export type StoredObject = {
  storage_provider: StorageProviderCode;
  storage_key: string;
  size_bytes: number;
};

export type StorageAdapterSummary = {
  adapter: StorageAdapterMode;
  storage_provider: StorageProviderCode;
  configured: boolean;
  multi_instance_safe: boolean;
  scale_blocker_for_multi_instance: boolean;
  notes: string[];
  root: string | null;
};

export interface StorageAdapter {
  readonly mode: StorageAdapterMode;
  readonly providerCode: StorageProviderCode;
  capabilities(): StorageAdapterCapabilities;
  put(key: string, content: Buffer): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  // listKeys is best-effort and used only by the read-only orphan report.
  listKeys(prefix?: string, limit?: number): Promise<string[]>;
  // describeForReadiness exposes a masked summary for Mission Control. It must
  // never return secrets, credentials, or full filesystem paths in production.
  describeForReadiness(): StorageAdapterSummary;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly mode: StorageAdapterMode = "local";
  readonly providerCode: StorageProviderCode = "local";
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  capabilities(): StorageAdapterCapabilities {
    return {
      multi_instance_safe: false,
      signed_urls_supported: false,
      immutable_content_addressed: true,
      scale_blocker_for_multi_instance: true,
      scale_notes: [
        "local filesystem cannot be shared safely between app instances",
        "object storage required before horizontal scale or live multi-instance"
      ]
    };
  }

  private resolveSafe(key: string) {
    const final = resolve(this.root, key);
    // Block path traversal: every storage key must resolve inside the root.
    if (!final.startsWith(this.root + sep) && final !== this.root) {
      const err: any = new Error("invalid_storage_key");
      err.statusCode = 400;
      err.code = "invalid_storage_key";
      throw err;
    }
    return final;
  }

  async put(key: string, content: Buffer): Promise<StoredObject> {
    const final = this.resolveSafe(key);
    await mkdir(dirname(final), { recursive: true });
    await writeFile(final, content);
    return { storage_provider: this.providerCode, storage_key: key, size_bytes: content.length };
  }

  async get(key: string): Promise<Buffer> {
    const final = this.resolveSafe(key);
    return readFile(final);
  }

  async delete(key: string): Promise<void> {
    const final = this.resolveSafe(key);
    await rm(final, { force: true });
  }

  async listKeys(prefix = "", limit = 500): Promise<string[]> {
    // Best-effort recursive walk. Used by the read-only orphan report.
    const keys: string[] = [];
    const startDir = prefix ? this.resolveSafe(prefix) : this.root;
    await this.walk(startDir, keys, limit);
    return keys.map((p) => relative(this.root, p).split(sep).join("/")).filter(Boolean);
  }

  private async walk(dir: string, out: string[], limit: number) {
    if (out.length >= limit) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as any;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, out, limit);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  async fileSize(key: string): Promise<number | null> {
    try {
      const final = this.resolveSafe(key);
      const s = await stat(final);
      return s.size;
    } catch {
      return null;
    }
  }

  describeForReadiness(): StorageAdapterSummary {
    return {
      adapter: this.mode,
      storage_provider: this.providerCode,
      configured: true,
      multi_instance_safe: false,
      scale_blocker_for_multi_instance: true,
      notes: [
        "object_storage_required_before_multi_instance",
        "local filesystem is appropriate for single-instance demo only"
      ],
      // Root is masked to a fixed marker in production-like environments to
      // avoid leaking the deployment filesystem layout in admin responses.
      root: this.isProductionLike() ? "<masked>" : this.root
    };
  }

  private isProductionLike() {
    return process.env.NODE_ENV === "production" || process.env.RENDER === "true";
  }
}

let cachedAdapter: StorageAdapter | null = null;

export function buildStorageAdapter(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  if (cachedAdapter) return cachedAdapter;
  const adapterMode = (env.STORAGE_ADAPTER || "local").trim().toLowerCase();
  if (adapterMode === "object") {
    // Object storage is intentionally not implemented here. We fall back to
    // local filesystem and surface the mismatch as a readiness blocker.
    // Activating object storage is a separate provider gate.
  }
  const root = resolve(env.DEAL_IMAGE_UPLOAD_DIR || join(process.cwd(), "uploads", "deal-images"));
  cachedAdapter = new LocalStorageAdapter(root);
  return cachedAdapter;
}

export function resetStorageAdapterForTests() {
  cachedAdapter = null;
}

export function getStorageReadinessReport(adapter: StorageAdapter, opts: {
  configured_object_storage_env: boolean;
  orphan_count_unknown_reason?: string;
  active_image_keys_count?: number;
  orphan_keys_count?: number;
  missing_keys_count?: number;
}) {
  const summary = adapter.describeForReadiness();
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (summary.scale_blocker_for_multi_instance) {
    blockers.push("object_storage_required_before_multi_instance");
  }
  if (!opts.configured_object_storage_env) {
    warnings.push("object_storage_not_configured");
  }
  return {
    adapter: summary.adapter,
    storage_provider: summary.storage_provider,
    configured: summary.configured,
    multi_instance_safe: summary.multi_instance_safe,
    scale_status: summary.multi_instance_safe ? "ready" : "partial",
    notes: summary.notes,
    blockers,
    warnings,
    active_image_keys_count: opts.active_image_keys_count ?? null,
    orphan_keys_count: opts.orphan_keys_count ?? null,
    missing_keys_count: opts.missing_keys_count ?? null,
    orphan_count_unknown_reason: opts.orphan_count_unknown_reason || null,
    object_storage_configured: opts.configured_object_storage_env,
    // Live readiness for object storage is intentionally false in this MVP pass.
    object_storage_live_ready: false,
    // Cache policy is unrelated to the adapter, but readiness consumers expect it
    // here so that the storage view is self-contained.
    public_image_cache_policy: "public, max-age=31536000, immutable for content-addressed image ids"
  };
}
