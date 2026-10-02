// ── Hero video preparation policy (pure, DOM-free) ───────────────────────────
// A phone hands the CMS whatever its camera recorded: an iPhone .MOV (HEVC,
// `video/quicktime`), a WebM/MP4 well above the 10 MB hero ceiling, sometimes a
// file with no MIME type at all. The server, the storage broker and the bucket
// only accept MP4/WebM up to 10 MB, and a visitor's browser can only play H.264
// MP4 or WebM everywhere. So the editor uploads a file as-is only when it is
// already a small MP4/WebM; anything else is re-encoded in the admin's browser
// (web/src/videoConvert.ts) into a muted, size-bounded MP4 or WebM first.
// These rules are pinned in tests/cms_video_prep_validation.ts.

export const DIRECT_VIDEO_TYPES: readonly string[] = ["video/mp4", "video/webm"];
/** Longest hero clip the editor will convert; a hero loop is a few seconds. */
export const HERO_VIDEO_MAX_SECONDS = 60;
/** Longest edge of the converted video (720p-class). */
export const HERO_VIDEO_MAX_EDGE = 1280;
export const HERO_VIDEO_MAX_BITRATE = 2_500_000;
/** Share of the byte ceiling the encoder may plan for (encoders overshoot). */
export const HERO_VIDEO_BUDGET_SHARE = 0.8;

const EXTENSION_TYPES: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", qt: "video/quicktime",
  "3gp": "video/3gpp", "3g2": "video/3gpp2", mkv: "video/x-matroska", avi: "video/x-msvideo", hevc: "video/hevc"
};

/** The file's MIME type, falling back to its extension when the browser gives none. */
export function videoTypeOf(file: { type?: string; name?: string }): string {
  const declared = String(file.type || "").trim().toLowerCase();
  if (declared) return declared;
  const ext = String(file.name || "").toLowerCase().split(".").pop() || "";
  return EXTENSION_TYPES[ext] || "";
}

export type VideoUploadPlan = "direct" | "convert" | "not_video" | "empty";

/** Upload as-is only a small MP4/WebM; convert every other video. */
export function planVideoUpload(file: { type?: string; name?: string; size: number }, maxBytes: number): VideoUploadPlan {
  if (!(file.size > 0)) return "empty";
  const type = videoTypeOf(file);
  if (!type.startsWith("video/")) return "not_video";
  return DIRECT_VIDEO_TYPES.includes(type) && file.size <= maxBytes ? "direct" : "convert";
}

/** Encoder bitrate that keeps a clip of `durationSec` under the byte ceiling; 0 = too long to fit. */
export function heroVideoBitrate(durationSec: number, maxBytes: number): number {
  if (!(durationSec > 0) || durationSec > HERO_VIDEO_MAX_SECONDS) return 0;
  const budget = Math.floor((maxBytes * HERO_VIDEO_BUDGET_SHARE * 8) / durationSec);
  return Math.min(HERO_VIDEO_MAX_BITRATE, budget);
}

/** Scale (width, height) so the longest edge is at most `maxEdge`, keeping even sizes. */
export function scaledVideoSize(width: number, height: number, maxEdge = HERO_VIDEO_MAX_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Recorder formats in order of preference: MP4 (plays everywhere, incl. older iOS), then WebM. */
export const RECORDER_CANDIDATES: readonly { recorderType: string; uploadType: string }[] = [
  { recorderType: "video/mp4;codecs=avc1.42E01E", uploadType: "video/mp4" },
  { recorderType: "video/mp4;codecs=avc1", uploadType: "video/mp4" },
  { recorderType: "video/mp4", uploadType: "video/mp4" },
  { recorderType: "video/webm;codecs=vp9", uploadType: "video/webm" },
  { recorderType: "video/webm;codecs=vp8", uploadType: "video/webm" },
  { recorderType: "video/webm", uploadType: "video/webm" }
];

export function pickRecorderType(isTypeSupported: (type: string) => boolean): { recorderType: string; uploadType: string } | null {
  for (const candidate of RECORDER_CANDIDATES) {
    try { if (isTypeSupported(candidate.recorderType)) return candidate; } catch { /* unsupported probe */ }
  }
  return null;
}

/** The container actually in the bytes — the same signatures the server checks (src/content_media.ts). */
export function sniffVideoContainer(head: Uint8Array): "video/mp4" | "video/webm" | null {
  if (head.length >= 12 && String.fromCharCode(head[4] ?? 0, head[5] ?? 0, head[6] ?? 0, head[7] ?? 0) === "ftyp") return "video/mp4";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return null;
}
