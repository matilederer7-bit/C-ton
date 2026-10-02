// ── Hero video conversion: shared failure type and diagnostics ───────────────
// Used by both conversion engines (./videoTranscode — WebCodecs, preferred —
// and ./videoConvert — real-time canvas + MediaRecorder fallback).

export type VideoConvertErrorCode =
  | "unsupported_browser" | "unreadable" | "blocked" | "interrupted" | "stalled" | "too_long" | "too_large" | "failed";

export class VideoConvertError extends Error {
  /** Diagnostic snapshot (engine, stage, position, states, format); no file content, no personal data. */
  detail = "";
  constructor(readonly code: VideoConvertErrorCode) { super(code); this.name = "VideoConvertError"; }
}

/** Coarse browser identity for diagnostics (brand + version, platform, mobile); never anything personal. */
export function browserLabel(): string {
  const data = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean } }).userAgentData;
  if (data?.brands?.length) {
    const brands = data.brands.filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand}/${b.version}`).join(",");
    return `${brands};${data.platform || "?"};${data.mobile ? "mobile" : "desktop"}`.slice(0, 120);
  }
  return String(navigator.userAgent || "?").slice(0, 120);
}
