// ── Admin/seller media upload (images through the canonical optimizer; a
// bounded MP4/WebM video for the hero, admin only). The server re-validates
// signature, size, MIME and ownership; this is only the transport. A video
// that is not already a small MP4/WebM (a phone .MOV, a clip over 10 MB) is
// re-encoded in the browser first (./videoConvert, policy in ./videoPrep).
import { productRequest as request } from "./api";
import { optimizeImageFile } from "./images";
import { t } from "./i18n/index.js";
import { planVideoUpload, videoTypeOf } from "./videoPrep";
import { convertVideoForHero, VideoConvertError } from "./videoConvert";
import { reportHandledError } from "./errorReporting";

export const VIDEO_MAX_BYTES = 10 * 1024 * 1024;
/** Any video: the phone picker must offer .MOV too; non-MP4/WebM is converted. */
export const VIDEO_ACCEPT = "video/*";
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

export async function uploadVideoAsset(file: File, onProgress?: (fraction: number) => void): Promise<UploadedAsset> {
  const plan = planVideoUpload(file, VIDEO_MAX_BYTES);
  if (plan === "empty") throw new Error(t("content_assets.the_file_empty"));
  if (plan === "not_video") throw new Error(t("content_assets.that_video_type_supported_mp4"));
  let blob: Blob = file;
  let mime = videoTypeOf(file);
  if (plan === "convert") {
    try { ({ blob, mime } = await convertVideoForHero(file, { maxBytes: VIDEO_MAX_BYTES, onProgress })); }
    catch (err) {
      // Conversion runs on the admin's own device, out of the server's sight:
      // send the diagnostic snapshot to error monitoring so a failure can be fixed.
      const code = err instanceof VideoConvertError ? err.code : "failed";
      const detail = err instanceof VideoConvertError ? err.detail : String((err as Error)?.name || err).slice(0, 120);
      reportHandledError(Object.assign(new Error(`hero_video_convert_${code}: ${detail}`), { name: "HeroVideoConvertError" }));
      throw new Error(videoConvertMessage(err));
    }
  }
  const base64_data = await fileToBase64(blob);
  return await request("/api/admin/content-assets", { method: "POST", body: JSON.stringify({ filename: file.name, mime_type: mime, base64_data }) }, "admin") as UploadedAsset;
}

function videoConvertMessage(err: unknown): string {
  const code = err instanceof VideoConvertError ? err.code : "failed";
  if (code === "too_long") return t("content_assets.video_too_long_to_convert");
  if (code === "unreadable") return t("content_assets.video_cannot_be_read_here");
  if (code === "unsupported_browser") return t("content_assets.browser_cannot_convert_video");
  if (code === "blocked") return t("content_assets.video_playback_blocked");
  if (code === "interrupted") return t("content_assets.video_conversion_interrupted");
  if (code === "stalled") return t("content_assets.video_conversion_stalled");
  if (code === "too_large") return t("content_assets.video_still_too_large");
  return t("content_assets.video_conversion_failed");
}
