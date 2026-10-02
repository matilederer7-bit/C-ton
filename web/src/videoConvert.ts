// ── Hero video conversion in the admin's browser ─────────────────────────────
// Re-encodes any video the browser can play (an iPhone .MOV, a long WebM, …)
// into a muted, size-bounded MP4 (or WebM where MP4 recording is unavailable):
// the clip plays once in a hidden <video>, each frame is drawn onto a canvas
// at most HERO_VIDEO_MAX_EDGE wide, and MediaRecorder records the canvas
// stream at a bitrate planned to stay under the byte ceiling. It takes about
// as long as the clip itself. No audio: the hero video always plays muted.
// The policy (when to convert, sizes, bitrate, formats) lives in ./videoPrep.
import { heroVideoBitrate, pickRecorderType, scaledVideoSize, sniffVideoContainer } from "./videoPrep";

export type VideoConvertErrorCode = "unsupported_browser" | "unreadable" | "too_long" | "too_large" | "failed";

export class VideoConvertError extends Error {
  constructor(readonly code: VideoConvertErrorCode) { super(code); this.name = "VideoConvertError"; }
}

function once<T extends Event>(target: EventTarget, ok: string, fail?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onOk = (e: Event) => { cleanup(); resolve(e as T); };
    const onFail = () => { cleanup(); reject(new VideoConvertError("unreadable")); };
    const cleanup = () => { target.removeEventListener(ok, onOk); if (fail) target.removeEventListener(fail, onFail); };
    target.addEventListener(ok, onOk);
    if (fail) target.addEventListener(fail, onFail);
  });
}

export async function convertVideoForHero(
  file: Blob,
  opts: { maxBytes: number; onProgress?: (fraction: number) => void }
): Promise<{ blob: Blob; mime: "video/mp4" | "video/webm" }> {
  const canRecord = typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement !== "undefined"
    && typeof HTMLCanvasElement.prototype.captureStream === "function";
  const format = canRecord ? pickRecorderType((type) => MediaRecorder.isTypeSupported(type)) : null;
  if (!format) throw new VideoConvertError("unsupported_browser");

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.preload = "auto";
  // Kept in the document (mobile Safari does not decode detached or display:none
  // video) but invisible and out of the way.
  video.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(video);
  let raf = 0;
  try {
    const loaded = once(video, "loadeddata", "error");
    video.src = url;
    await loaded;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) throw new VideoConvertError("unreadable");
    const bitrate = heroVideoBitrate(duration, opts.maxBytes);
    if (!bitrate) throw new VideoConvertError("too_long");

    const size = scaledVideoSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new VideoConvertError("unsupported_browser");
    const draw = () => { ctx.drawImage(video, 0, 0, size.width, size.height); };
    draw();

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: format.recorderType, videoBitsPerSecond: bitrate });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = once(recorder, "stop");

    const tick = () => {
      draw();
      opts.onProgress?.(Math.min(0.99, video.currentTime / duration));
      if (!video.ended) raf = requestAnimationFrame(tick);
    };
    const ended = once(video, "ended", "error");
    recorder.start(1000);
    await video.play().catch(() => { throw new VideoConvertError("unreadable"); });
    raf = requestAnimationFrame(tick);
    // A stalled decoder must not hang the editor forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new VideoConvertError("failed")), (duration * 3 + 30) * 1000); });
    try { await Promise.race([ended, deadline]); }
    finally { clearTimeout(timer); cancelAnimationFrame(raf); draw(); if (recorder.state !== "inactive") recorder.stop(); }
    await stopped;
    stream.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: format.uploadType });
    if (!blob.size) throw new VideoConvertError("failed");
    if (blob.size > opts.maxBytes) throw new VideoConvertError("too_large");
    const container = sniffVideoContainer(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    if (!container) throw new VideoConvertError("failed");
    opts.onProgress?.(1);
    return { blob: container === format.uploadType ? blob : new Blob([blob], { type: container }), mime: container };
  } finally {
    cancelAnimationFrame(raf);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
