// ── LAUNCH SPRINT 3 — seller camera scanner (browser side) ──────────────────
// Product rules (docs/PHYSICAL_FULFILLMENT_PICKUP.md §6):
//   * the camera is requested ONLY from the seller's explicit tap, never on load
//   * native BarcodeDetector when the platform has it (Android Chrome/Edge,
//     Samsung Internet); otherwise the small jsQR decoder is loaded lazily as a
//     separate chunk (iOS Safari, desktop) — the main bundle never carries it
//   * every failure is a named outcome with product Hebrew (pickupCode.ts)
//   * the typed-code and search fallbacks are always available; the scanner
//     never traps the seller behind a permission prompt
//   * a decoded value is only accepted when it is OUR credential shape
import { classifyCameraError, pickupCodeFromScan, type ScanOutcome } from "./pickupCode";

type Decoder = (video: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>;

async function nativeDecoder(): Promise<Decoder | null> {
  const BD = (globalThis as any).BarcodeDetector;
  if (typeof BD !== "function") return null;
  try {
    const formats: string[] = typeof BD.getSupportedFormats === "function" ? await BD.getSupportedFormats() : ["qr_code"];
    if (!formats.includes("qr_code")) return null;
    const detector = new BD({ formats: ["qr_code"] });
    return async (video) => {
      if (!video.videoWidth) return null;
      const found = await detector.detect(video);
      const hit = Array.isArray(found) ? found.find((b: any) => b && b.rawValue) : null;
      return hit ? String(hit.rawValue) : null;
    };
  } catch {
    return null;
  }
}

async function jsqrDecoder(): Promise<Decoder | null> {
  try {
    const mod: any = await import("jsqr");
    const jsQR = mod.default || mod;
    return async (video, canvas) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      // Downscale large frames: QR modules stay readable and decoding stays cheap on phones.
      const scale = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      return result && result.data ? String(result.data) : null;
    };
  } catch {
    return null;
  }
}

export interface ScannerHandle {
  stop: () => void;
}

export interface ScannerArgs {
  decodeCode?: (raw: string) => string | null;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onOutcome: (outcome: ScanOutcome, detail?: string) => void;
  onCode: (code: string, raw: string) => void;
  intervalMs?: number;
}

export function cameraSupported(): { ok: boolean; outcome: ScanOutcome | null } {
  if (typeof navigator === "undefined" || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return { ok: false, outcome: "unsupported" };
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) return { ok: false, outcome: "insecure_context" };
  return { ok: true, outcome: null };
}

// Starts the camera + decode loop. Resolves once the stream is live (or an
// outcome was reported). Returns a handle whose stop() releases the camera.
export async function startPickupScanner(args: ScannerArgs): Promise<ScannerHandle> {
  let stopped = false;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (stream) for (const track of stream.getTracks()) { try { track.stop(); } catch { /* ignore */ } }
    try { args.video.pause(); (args.video as any).srcObject = null; } catch { /* ignore */ }
    args.onOutcome("stopped");
  };
  const support = cameraSupported();
  if (!support.ok) {
    args.onOutcome(support.outcome || "unsupported");
    return { stop: () => undefined };
  }
  args.onOutcome("starting");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  } catch (error: any) {
    args.onOutcome(classifyCameraError(error), String(error?.name || ""));
    return { stop: () => undefined };
  }
  if (stopped) { for (const track of stream.getTracks()) track.stop(); return { stop }; }
  (args.video as any).srcObject = stream;
  args.video.setAttribute("playsinline", "true");
  args.video.muted = true;
  try { await args.video.play(); } catch { /* autoplay policies: the stream still renders once the user tapped */ }
  const decoder = (await nativeDecoder()) || (await jsqrDecoder());
  if (!decoder) {
    stop();
    args.onOutcome("unsupported");
    return { stop };
  }
  args.onOutcome("scanning");
  const interval = Math.max(80, Number(args.intervalMs || 160));
  const tick = async () => {
    if (stopped) return;
    try {
      const raw = await decoder(args.video, args.canvas);
      if (raw && !stopped) {
        const code = args.decodeCode ? args.decodeCode(raw) : pickupCodeFromScan(raw);
        if (code) {
          args.onOutcome("decoded", code);
          args.onCode(code, raw);
          stop();
          return;
        }
        args.onOutcome("not_our_code", raw.slice(0, 80));
      }
    } catch {
      // a single bad frame is not a failure; keep scanning
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, interval);
  return { stop };
}
