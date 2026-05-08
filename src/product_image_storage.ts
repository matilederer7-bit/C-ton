import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { buildStorageAdapter, type StorageAdapter } from "./storage_adapter.js";

export const DEAL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DEAL_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type DealImageUploadInput = {
  dealId: string;
  originalFilename?: string | null;
  mimeType: string;
  base64Data: string;
};

export type DealImageFile = {
  storage_provider: "local" | "object";
  storage_key: string;
  original_filename: string | null;
  mime_type: string;
  size_bytes: number;
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

export function validateImageFile(input: { mimeType: string; sizeBytes: number }) {
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  if (!DEAL_IMAGE_MIME_TYPES.has(mimeType)) {
    const err: any = new Error("invalid image type");
    err.statusCode = 400;
    err.code = "invalid_image_type";
    throw err;
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    const err: any = new Error("image is empty");
    err.statusCode = 400;
    err.code = "invalid_image_file";
    throw err;
  }
  if (input.sizeBytes > DEAL_IMAGE_MAX_BYTES) {
    const err: any = new Error("image too large");
    err.statusCode = 400;
    err.code = "image_too_large";
    throw err;
  }
}

export async function saveDealImage(input: DealImageUploadInput): Promise<DealImageFile> {
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  const buffer = Buffer.from(String(input.base64Data || ""), "base64");
  validateImageFile({ mimeType, sizeBytes: buffer.length });

  const safeDealSegment = String(input.dealId || "").replace(/[^a-zA-Z0-9-]/g, "");
  const storageKey = `${safeDealSegment}/${randomUUID()}${extensionForMime(mimeType)}`;
  const stored = await adapter().put(storageKey, buffer);

  return {
    storage_provider: stored.storage_provider,
    storage_key: stored.storage_key,
    original_filename: input.originalFilename ? basename(String(input.originalFilename)) : null,
    mime_type: mimeType,
    size_bytes: stored.size_bytes
  };
}

export async function readDealImage(storageKey: string) {
  return adapter().get(storageKey);
}

export async function deleteDealImageFile(storageKey: string) {
  await adapter().delete(storageKey).catch(() => undefined);
}

export function getDealImagePublicUrl(image: { image_id: string }) {
  return `/api/deal-images/${encodeURIComponent(String(image.image_id))}`;
}

export function getDealImageStorageAdapter(): StorageAdapter {
  return adapter();
}
