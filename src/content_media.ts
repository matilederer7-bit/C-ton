// ── Admin CMS media: images through the canonical image adapter, plus a
// bounded hero VIDEO path that reuses the same storage adapter and key layout
// (so the storage orphan report keeps recognizing every content asset).
// Video is admin-only: sellers keep the image-only contract. The MIME allow-list
// is mirrored by the siton.content_assets CHECK constraint (migration 069).
import { createHash, randomUUID } from "node:crypto";
import { getDealImageStorageAdapter, saveDealImage, type DealImageFile } from "./product_image_storage.js";

export const CONTENT_VIDEO_MAX_BYTES = 10 * 1024 * 1024;
export const CONTENT_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);
/** JSON body ceiling for the admin upload route: base64 of a 10 MB video plus envelope. */
export const CONTENT_UPLOAD_BODY_LIMIT = 15 * 1024 * 1024;

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code });
}

export function validateVideoFile(input: { mimeType: string; content: Buffer }) {
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  if (!CONTENT_VIDEO_MIME_TYPES.has(mimeType)) reject("invalid_video_mime", "unsupported video type");
  if (!input.content.length) reject("invalid_video_content", "empty video");
  if (input.content.length > CONTENT_VIDEO_MAX_BYTES) reject("video_too_large", "video exceeds the size limit");
  const c = input.content;
  // MP4/ISO-BMFF: "ftyp" box at offset 4. WebM/Matroska: EBML header 1A 45 DF A3.
  const isMp4 = c.length >= 12 && c.toString("ascii", 4, 8) === "ftyp";
  const isWebm = c.length >= 4 && c[0] === 0x1a && c[1] === 0x45 && c[2] === 0xdf && c[3] === 0xa3;
  if (!((mimeType === "video/mp4" && isMp4) || (mimeType === "video/webm" && isWebm))) reject("invalid_video_content", "video content does not match mime type");
  return mimeType;
}

export async function saveContentVideo(input: { ownerId: string; mimeType: string; base64Data: string }): Promise<DealImageFile> {
  const buffer = Buffer.from(String(input.base64Data || ""), "base64");
  const mimeType = validateVideoFile({ mimeType: input.mimeType, content: buffer });
  const environmentPrefix = String(process.env.OBJECT_STORAGE_PREFIX || process.env.APP_DEPLOYMENT_MODE || "test").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "test";
  const safeSegment = String(input.ownerId || "").replace(/[^a-zA-Z0-9-]/g, "");
  const storageKey = `${environmentPrefix}/deals/${safeSegment}/images/${randomUUID()}${mimeType === "video/mp4" ? ".mp4" : ".webm"}`;
  const checksumSha256 = createHash("sha256").update(buffer).digest("hex");
  const storage = getDealImageStorageAdapter();
  const stored = await storage.put(storageKey, buffer, { contentType: mimeType, checksumSha256 });
  return {
    storage_provider: stored.storage_provider, storage_key: stored.storage_key, original_filename: null,
    mime_type: mimeType, size_bytes: stored.size_bytes, checksum_sha256: checksumSha256,
    public_url: storage.publicReadUrl ? storage.publicReadUrl(stored.storage_key) : null
  };
}

/** One entry point for admin uploads: image (canonical adapter) or video (bounded). */
export async function saveAdminContentAsset(input: { ownerId: string; mimeType: unknown; base64Data: unknown; filename?: unknown }): Promise<DealImageFile> {
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  if (mimeType.startsWith("video/")) return saveContentVideo({ ownerId: input.ownerId, mimeType, base64Data: String(input.base64Data || "") });
  return saveDealImage({ dealId: input.ownerId, mimeType, base64Data: String(input.base64Data || ""), originalFilename: input.filename ? String(input.filename) : null });
}

/** Byte-range slicing for video playback (Safari refuses to play without 206 support). */
export function sliceRange(header: unknown, size: number): { start: number; end: number } | null | "invalid" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m) return null;
  if (m[1] === "" && m[2] === "") return "invalid";
  let start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[2] === "" || m[1] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}
