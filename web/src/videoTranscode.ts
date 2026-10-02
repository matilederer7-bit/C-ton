// ── Hero video transcoding with WebCodecs (preferred path) ───────────────────
// Owner test on staging, 2026-10-02 (Android, Brave 154): the real-time path
// (play the clip, record a canvas — ./videoConvert) froze at 4.6 s of a 27.5 s
// 1080x1920 MP4 with `ready=2 paused=false`: the phone could not decode and
// re-encode at playback speed at the same time. This path does not play the
// clip at all: it demuxes the file, decodes and re-encodes frame by frame at
// whatever speed the device manages (WebCodecs, via the `mediabunny` library),
// and muxes a muted MP4 (H.264) or WebM (VP8/VP9).
//
// Every step is bounded: one abort covers the whole function from its first
// line — no progress for TRANSCODE_STALL_SECONDS, an overall deadline, or a
// hidden page with no progress — and every await races against it, including
// the conversion itself. A decoder that silently stops producing frames (which
// the library's own cancel() cannot interrupt) therefore still ends in a clear,
// reported "stalled" instead of an endless spinner.
//
// The library is loaded on demand (admin editor only), never on public pages.
// Any engine-level unsupported case throws `unsupported_browser` so the caller
// can fall back to the real-time path.
import { heroVideoBitrate, scaledVideoSize, sniffVideoContainer } from "./videoPrep";
import { VideoConvertError, type VideoConvertErrorCode, browserLabel } from "./videoErrors";

/** No progress at all for this long means the device stopped working on it. */
export const TRANSCODE_STALL_SECONDS = 30;
/** Ceiling for everything before the clip's duration is known (load, open, probe). */
const OPEN_DEADLINE_MS = 60_000;
const OUTPUT_FRAME_RATE = 30;

export function webCodecsAvailable(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

export async function transcodeWithWebCodecs(
  file: Blob,
  opts: { maxBytes: number; onProgress?: (fraction: number) => void; stallSeconds?: number }
): Promise<{ blob: Blob; mime: "video/mp4" | "video/webm" }> {
  if (!webCodecsAvailable()) throw new VideoConvertError("unsupported_browser");
  const stallMs = (opts.stallSeconds ?? TRANSCODE_STALL_SECONDS) * 1000;
  let stage = "load";
  let progress = 0;
  let duration = Number.NaN;
  let frame = "?";
  let codec = "?";
  let discarded = "";

  // One abort for the whole run; every await below races against it.
  let abort: (code: VideoConvertErrorCode) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { abort = (code) => reject(new VideoConvertError(code)); });
  aborted.catch(() => undefined);
  const guard = <T>(p: Promise<T>) => Promise.race([p, aborted]);
  let lastMove = Date.now();
  let deadlineAt = Date.now() + OPEN_DEADLINE_MS;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastMove > stallMs) abort("stalled");
    else if (now > deadlineAt) abort("failed");
    else if (document.hidden && now - lastMove > 5000) abort("interrupted");
  }, 1000);
  const step = (name: string) => { stage = name; lastMove = Date.now(); };

  let input: { dispose?: () => void } | undefined;
  let conversion: { cancel: () => Promise<void> } | undefined;
  let finished = false;
  opts.onProgress?.(0);
  try {
    const mb = await guard(import("mediabunny"));
    step("open");
    const src = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    input = src as unknown as { dispose?: () => void };
    const track = await guard(src.getPrimaryVideoTrack());
    if (!track) throw new VideoConvertError("unreadable");
    const [displayWidth, displayHeight] = await guard(Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]));
    frame = `${displayWidth}x${displayHeight}`;
    duration = await guard(src.computeDuration());
    const bitrate = heroVideoBitrate(duration, opts.maxBytes);
    if (!bitrate) throw new VideoConvertError(duration > 0 ? "too_long" : "unreadable");
    const size = scaledVideoSize(displayWidth, displayHeight);
    if (!size.width) throw new VideoConvertError("unreadable");

    // H.264 in MP4 plays everywhere (incl. older iOS); VP8 (fast) or VP9 in WebM
    // where the browser has no H.264 encoder (open-source Chromium builds). The
    // server accepts both containers. An explicit bitrate (not a quality factor);
    // the probe uses the very same Quality object the conversion will.
    step("probe");
    const quality = new mb.Quality({ bitrate });
    const candidates = [
      { codec: "avc" as const, mime: "video/mp4" as const },
      { codec: "vp8" as const, mime: "video/webm" as const },
      { codec: "vp9" as const, mime: "video/webm" as const }
    ];
    let chosen: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (await guard(mb.canEncodeVideo(c.codec, { width: size.width, height: size.height, quality }))) { chosen = c; break; }
    }
    if (!chosen) throw new VideoConvertError("unsupported_browser");
    codec = chosen.codec;

    step("init");
    const target = new mb.BufferTarget();
    const format = chosen.mime === "video/mp4" ? new mb.Mp4OutputFormat({ fastStart: "in-memory" }) : new mb.WebMOutputFormat();
    const output = new mb.Output({ format, target });
    const conv = await guard(mb.Conversion.init({
      input: src,
      output,
      tracks: "primary",
      video: { width: size.width, height: size.height, fit: "fill", codec: chosen.codec, quality, frameRate: OUTPUT_FRAME_RATE, forceTranscode: true },
      audio: { discard: true },
      showWarnings: false
    }));
    conversion = conv;
    if (!conv.isValid) {
      discarded = conv.discardedTracks.map((d) => `${d.track.type}:${d.reason}`).join(",").slice(0, 120);
      throw new VideoConvertError("unsupported_browser");
    }

    step("transcode");
    deadlineAt = Date.now() + (duration * 10 + 120) * 1000;
    conv.onProgress = (p: number) => {
      if (p > progress) { progress = p; lastMove = Date.now(); }
      opts.onProgress?.(Math.min(0.99, p));
    };
    await guard(conv.execute());

    step("finish");
    if (!target.buffer || !target.buffer.byteLength) throw new VideoConvertError("failed");
    const blob = new Blob([target.buffer], { type: chosen.mime });
    if (blob.size > opts.maxBytes) throw new VideoConvertError("too_large");
    if (sniffVideoContainer(new Uint8Array(target.buffer, 0, Math.min(16, target.buffer.byteLength))) !== chosen.mime) throw new VideoConvertError("failed");
    finished = true;
    opts.onProgress?.(1);
    return { blob, mime: chosen.mime };
  } catch (err) {
    // A library that fails to load falls back to the real-time engine; a file
    // the demuxer cannot open is unreadable; anything else is a reported failure.
    const failure = err instanceof VideoConvertError ? err
      : new VideoConvertError(stage === "load" ? "unsupported_browser" : stage === "open" ? "unreadable" : "failed");
    const d = Number.isFinite(duration) ? duration.toFixed(1) : String(duration);
    failure.detail = `engine=webcodecs codec=${codec} stage=${stage} progress=${progress.toFixed(2)} duration=${d} frame=${frame}`
      + ` src=${(file.type || "?").slice(0, 40)} mb=${(file.size / 1048576).toFixed(1)} browser=${browserLabel()}`
      + `${discarded ? ` discarded=${discarded}` : ""}${failure === err ? "" : ` cause=${String((err as Error)?.name || "").slice(0, 40)}:${String((err as Error)?.message || err).slice(0, 120)}`}`;
    throw failure;
  } finally {
    clearInterval(watchdog);
    // Best effort: a decoder that never answers may keep the library's own
    // promise pending, but the caller has already been released by the guard.
    if (conversion && !finished) conversion.cancel().catch(() => undefined);
    try { input?.dispose?.(); } catch { /* best effort */ }
  }
}
