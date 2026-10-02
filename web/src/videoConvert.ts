// ── Hero video conversion in the admin's browser ─────────────────────────────
// Re-encodes any video the browser can play (an iPhone .MOV, a long WebM, …)
// into a muted, size-bounded MP4 (or WebM where MP4 recording is unavailable):
// the clip plays once in a hidden <video>, each frame is drawn onto a canvas
// at most HERO_VIDEO_MAX_EDGE wide, and MediaRecorder records the canvas
// stream at a bitrate planned to stay under the byte ceiling. It takes about
// as long as the clip itself. No audio: the hero video always plays muted.
// The policy (when to convert, sizes, bitrate, formats) lives in ./videoPrep.
//
// Failure is always bounded and clean: one deadline covers the whole pipeline,
// a hidden page (screen locked, app switched) stops it at once, a recorder
// error stops it, a playback that stops advancing is resumed and, if it stays
// stuck, stopped with "stalled", and the recorder, its stream and the <video>
// are released on every path. Every failure carries a diagnostic `detail`.
//
// The clip plays as a small VISIBLE preview in the corner: Chromium browsers on
// Android (Chrome, Brave, …) pause a muted video they consider invisible, which
// froze the first version mid-way (owner test on staging, 2026-10-02: stuck at 17%).
import { heroVideoBitrate, pickRecorderType, scaledVideoSize, sniffVideoContainer } from "./videoPrep";
import { VideoConvertError, browserLabel, type VideoConvertErrorCode } from "./videoErrors";
import { transcodeWithWebCodecs } from "./videoTranscode";

export { VideoConvertError, type VideoConvertErrorCode } from "./videoErrors";

/** Seconds without playback progress before the conversion is declared stuck. */
export const STALL_LIMIT_SECONDS = 8;

/** Time allowed to open the file and learn its duration, before the per-clip deadline applies. */
const OPEN_DEADLINE_MS = 30_000;

function once(target: EventTarget, ok: string, fail?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const onFail = () => { cleanup(); reject(new VideoConvertError("unreadable")); };
    const cleanup = () => { target.removeEventListener(ok, onOk); if (fail) target.removeEventListener(fail, onFail); };
    target.addEventListener(ok, onOk);
    if (fail) target.addEventListener(fail, onFail);
  });
}

function settle(target: EventTarget, event: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); target.removeEventListener(event, done); resolve(); };
    const timer = setTimeout(done, ms);
    target.addEventListener(event, done);
  });
}

/** Recorder-made WebM (screen or in-app recordings) reports no duration until its end is seeked. */
async function knownDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  const found = settle(video, "durationchange", 5000);
  video.currentTime = 1e7;
  await found;
  return video.duration;
}

/**
 * Convert a hero video: WebCodecs first (frame by frame, never stuck on a slow
 * device); the real-time canvas + MediaRecorder path only where the browser
 * has no usable WebCodecs H.264 encoder.
 */
export async function convertVideoForHero(
  file: Blob,
  opts: { maxBytes: number; onProgress?: (fraction: number) => void }
): Promise<{ blob: Blob; mime: "video/mp4" | "video/webm" }> {
  let skipped = "";
  try {
    return await transcodeWithWebCodecs(file, opts);
  } catch (err) {
    if (!(err instanceof VideoConvertError) || err.code !== "unsupported_browser") throw err;
    skipped = err.detail;
  }
  try {
    return await convertRealtime(file, opts);
  } catch (err) {
    // Keep why WebCodecs was skipped next to the fallback's own failure.
    if (err instanceof VideoConvertError && skipped) err.detail = `${err.detail} | webcodecs_skipped: ${skipped}`.slice(0, 900);
    throw err;
  }
}

/** The real-time fallback engine (exported for its browser test). */
export async function convertRealtime(
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
  // A small, fully visible preview in the corner while the clip is prepared (see
  // the header: browsers pause or skip invisible muted video).
  video.setAttribute("data-testid", "hero-video-converting");
  video.style.cssText = "position:fixed;left:12px;bottom:12px;width:120px;height:auto;max-height:200px;border-radius:10px;"
    + "box-shadow:0 4px 18px rgba(0,0,0,.28);background:#000;z-index:2147483000;pointer-events:none";
  document.body.appendChild(video);
  let stage = "open";

  // Every failure source funnels into one rejection the pipeline races against.
  let abort: (code: VideoConvertErrorCode) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { abort = (code) => reject(new VideoConvertError(code)); });
  aborted.catch(() => undefined);
  const guard = <T>(p: Promise<T>) => Promise.race([p, aborted]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => abort("failed"), ms); };
  const onHidden = () => { if (document.hidden) abort("interrupted"); };
  document.addEventListener("visibilitychange", onHidden);

  let raf = 0;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  try {
    arm(OPEN_DEADLINE_MS);
    const loaded = once(video, "loadeddata", "error");
    video.src = url;
    // Called while still inside the file-picker gesture where the browser allows
    // it: mobile Safari restricts play() outside a user gesture (e.g. in Low Power
    // Mode), and an element that has played once may play again later.
    let unlocking = true;
    video.play().then(() => { if (unlocking) video.pause(); }, () => undefined);
    await guard(loaded);
    stage = "duration";
    const duration = await guard(knownDuration(video));
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) throw new VideoConvertError("unreadable");
    const bitrate = heroVideoBitrate(duration, opts.maxBytes);
    if (!bitrate) throw new VideoConvertError("too_long");
    arm((duration * 3 + 30) * 1000);
    unlocking = false;
    video.pause();
    if (video.currentTime > 0) {
      const rewound = settle(video, "seeked", 5000);
      video.currentTime = 0;
      await guard(rewound);
    }

    const size = scaledVideoSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new VideoConvertError("unsupported_browser");
    const draw = () => { ctx.drawImage(video, 0, 0, size.width, size.height); };
    draw();

    stage = "play";
    const ended = once(video, "ended", "error");
    // A browser may never start, pause, or starve the decoder mid-way: resume
    // it, and give up with "stalled" if the position does not move for
    // STALL_LIMIT_SECONDS — from the first play() on, not only once recording.
    let lastTime = video.currentTime;
    let stuckFor = 0;
    watchdog = setInterval(() => {
      if (video.ended) return;
      if (video.currentTime > lastTime + 0.05) { lastTime = video.currentTime; stuckFor = 0; return; }
      stuckFor += 1;
      if (video.paused && stage !== "play") video.play().catch(() => undefined);
      if (stuckFor >= STALL_LIMIT_SECONDS) abort("stalled");
    }, 1000);
    try { await guard(video.play()); }
    catch (err) {
      if (err instanceof VideoConvertError) throw err;
      throw new VideoConvertError((err as { name?: string })?.name === "NotAllowedError" ? "blocked" : "unreadable");
    }

    stage = "record";
    stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: format.recorderType, videoBitsPerSecond: bitrate });
    recorder = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = () => abort("failed");
    const stopped = once(rec, "stop");
    rec.start(1000);
    const tick = () => {
      try { draw(); } catch { stage = "draw"; abort("failed"); return; }
      opts.onProgress?.(Math.min(0.99, video.currentTime / duration));
      if (!video.ended) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    await guard(ended);
    cancelAnimationFrame(raf);
    draw();
    stage = "stop";
    rec.stop();
    // The recorder must hand over its data promptly; never sit at 99%.
    const stopTimer = setTimeout(() => abort("failed"), 10_000);
    try { await guard(stopped); } finally { clearTimeout(stopTimer); }

    stage = "finish";
    const blob = new Blob(chunks, { type: format.uploadType });
    if (!blob.size) throw new VideoConvertError("failed");
    if (blob.size > opts.maxBytes) throw new VideoConvertError("too_large");
    const container = sniffVideoContainer(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    if (!container) throw new VideoConvertError("failed");
    opts.onProgress?.(1);
    return { blob: container === format.uploadType ? blob : new Blob([blob], { type: container }), mime: container };
  } catch (err) {
    const failure = err instanceof VideoConvertError ? err : new VideoConvertError("failed");
    const d = Number.isFinite(video.duration) ? video.duration.toFixed(1) : String(video.duration);
    failure.detail = `engine=realtime stage=${stage} t=${video.currentTime.toFixed(1)}/${d} ready=${video.readyState} net=${video.networkState}`
      + ` paused=${video.paused} frame=${video.videoWidth}x${video.videoHeight} src=${(file.type || "?").slice(0, 40)}`
      + ` mb=${(file.size / 1048576).toFixed(1)} rec=${format.recorderType} browser=${browserLabel()}`
      + `${failure === err ? "" : ` cause=${String((err as Error)?.name || err).slice(0, 60)}`}`;
    throw failure;
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    document.removeEventListener("visibilitychange", onHidden);
    cancelAnimationFrame(raf);
    if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch { /* already stopping */ } }
    stream?.getTracks().forEach((track) => track.stop());
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
