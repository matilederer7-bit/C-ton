// ── Admin/seller media upload (images through the canonical optimizer; a
// bounded MP4/WebM video for the hero, admin only). The server re-validates
// signature, size, MIME and ownership; this is only the transport.
import { productRequest as request } from "./api";
import { optimizeImageFile } from "./images";
import { t } from "./i18n";

export const VIDEO_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_ACCEPT = "video/mp4,video/webm";
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export interface UploadedAsset { asset_id: string; url: string; mime_type?: string }

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("content_assets.reading_file_failed")));
    reader.onload = () => { const b64 = String(reader.result || "").split(",")[1] || ""; b64 ? resolve(b64) : reject(new Error(t("content_assets.reading_file_failed"))); };
    reader.readAsDataURL(file);
  });
}

export async function uploadImageAsset(file: File, scope: "seller" | "admin"): Promise<UploadedAsset> {
  const img = await optimizeImageFile(file);
  try { return await request(`/api/${scope}/content-assets`, { method: "POST", body: JSON.stringify({ filename: img.name, mime_type: img.mime, base64_data: img.b64 }) }, scope) as UploadedAsset; }
  finally { URL.revokeObjectURL(img.previewUrl); }
}

export async function uploadVideoAsset(file: File): Promise<UploadedAsset> {
  const mime = String(file.type || "").toLowerCase();
  if (mime !== "video/mp4" && mime !== "video/webm") throw new Error(t("content_assets.that_video_type_supported_mp4"));
  if (file.size > VIDEO_MAX_BYTES) throw new Error(t("content_assets.the_video_larger_than_10mb"));
  if (file.size <= 0) throw new Error(t("content_assets.the_file_empty"));
  const base64_data = await fileToBase64(file);
  return await request("/api/admin/content-assets", { method: "POST", body: JSON.stringify({ filename: file.name, mime_type: mime, base64_data }) }, "admin") as UploadedAsset;
}
