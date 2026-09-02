import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildStorageAdapter, type StorageAdapter, type StorageProviderCode } from "./storage_adapter.js";

// P0.3 — the CLIENT accepts sources up to 50MB and compresses them before
// upload (resize to ~2560px long edge, WebP/JPEG); this server bound caps the
// stored OPTIMIZED artifact, sized to fit the 8MiB JSON body limit after
// base64 inflation.
export const DEAL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DEAL_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type DealImageUploadInput = {
  dealId: string;
  originalFilename?: string | null;
  mimeType: string;
  base64Data: string;
};

export type DealImageFile = {
  storage_provider: StorageProviderCode;
  storage_key: string;
  original_filename: string | null;
  mime_type: string;
  size_bytes: number;
  checksum_sha256: string;
  public_url: string | null;
};

function adapter(): StorageAdapter {
  return buildStorageAdapter();
}

function extensionForMime(mimeType: string) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return "";
}

export function validateImageFile(input: { mimeType: string; content: Buffer }) {
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  if (!DEAL_IMAGE_MIME_TYPES.has(mimeType)) {
    const err: any = new Error("invalid image type");
    err.statusCode = 400;
    err.code = "invalid_image_type";
    throw err;
  }
  if (input.content.length <= 0) {
    const err: any = new Error("image is empty");
    err.statusCode = 400;
    err.code = "invalid_image_file";
    throw err;
  }
  if (input.content.length > DEAL_IMAGE_MAX_BYTES) {
    const err: any = new Error("image too large");
    err.statusCode = 400;
    err.code = "image_too_large";
    throw err;
  }
  const matchesContent =
    (mimeType === "image/png" && input.content.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) ||
    (mimeType === "image/jpeg" && input.content.length >= 3 && input.content[0] === 0xff && input.content[1] === 0xd8 && input.content[2] === 0xff) ||
    (mimeType === "image/webp" && input.content.length >= 12 && input.content.toString("ascii", 0, 4) === "RIFF" && input.content.toString("ascii", 8, 12) === "WEBP");
  if (!matchesContent) {
    const err: any = new Error("image content does not match mime type");
    err.statusCode = 400;
    err.code = "image_content_mismatch";
    throw err;
  }
}

export async function saveDealImage(input: DealImageUploadInput): Promise<DealImageFile> {
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  const buffer = Buffer.from(String(input.base64Data || ""), "base64");
  validateImageFile({ mimeType, content: buffer });

  const originalFilename = input.originalFilename ? String(input.originalFilename).normalize("NFC") : null;
  if (originalFilename && (originalFilename.includes("/") || originalFilename.includes("\\") || originalFilename.includes("\0") || basename(originalFilename) !== originalFilename)) {
    const err: any = new Error("invalid image filename");
    err.statusCode = 400;
    err.code = "invalid_image_filename";
    throw err;
  }

  const safeDealSegment = String(input.dealId || "").replace(/[^a-zA-Z0-9-]/g, "");
  const environmentPrefix = String(process.env.OBJECT_STORAGE_PREFIX || process.env.APP_DEPLOYMENT_MODE || "test").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "test";
  const storageKey = `${environmentPrefix}/deals/${safeDealSegment}/images/${randomUUID()}${extensionForMime(mimeType)}`;
  const checksumSha256 = createHash("sha256").update(buffer).digest("hex");
  const storage = adapter();
  const stored = await storage.put(storageKey, buffer, { contentType: mimeType, checksumSha256 });

  return {
    storage_provider: stored.storage_provider,
    storage_key: stored.storage_key,
    original_filename: originalFilename ? basename(originalFilename) : null,
    mime_type: mimeType,
    size_bytes: stored.size_bytes,
    checksum_sha256: checksumSha256,
    public_url: storage.publicReadUrl ? storage.publicReadUrl(stored.storage_key) : null
  };
}

export async function readDealImage(storageKey: string) {
  return adapter().get(storageKey);
}

export async function deleteDealImageFile(storageKey: string) {
  await adapter().delete(storageKey);
}

export function getDealImagePublicUrl(image: { image_id: string }) {
  return `/api/deal-images/${encodeURIComponent(String(image.image_id))}`;
}

// Prefer the durable storage-CDN URL recorded at upload time; fall back to
// the server proxy for legacy rows that predate canonical Supabase Storage.
export function resolveDealImageUrl(image: { image_id: string; public_url?: string | null | undefined }) {
  const durable = String(image.public_url || "").trim();
  if (/^https:\/\//.test(durable)) return durable;
  return getDealImagePublicUrl(image);
}

export function getDealImageStorageAdapter(): StorageAdapter {
  return adapter();
}
