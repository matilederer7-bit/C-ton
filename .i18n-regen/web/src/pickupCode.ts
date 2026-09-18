// ── LAUNCH SPRINT 3 — pickup order code, pure helpers ───────────────────────
// No DOM types: compiles under the Vite (DOM) and the root nodenext (node-only)
// projects, so the unit suite can import it directly. Mirrors the server rule
// (src/physical_fulfillment.ts normalizeOrderCodeInput): CT-NNNN-NNNN, eight
// decimal digits, accepted in any typed variant or as the full QR URL.

export const PICKUP_CODE_PREFIX = "CT";
export const PICKUP_CODE_DIGITS = 8;

// Returns the 8 digits or null. Accepts "CT-1234-5678", "ct 1234 5678",
// "12345678", "1234-5678" and "…#/seller/pickup?code=CT-1234-5678".
export function normalizePickupInput(input: unknown): string | null {
  let text = String(input ?? "").trim();
  if (!text || text.length > 512) return null;
  const urlMatch = text.match(/[?&]code=([^&#\s]+)/i);
  if (urlMatch && urlMatch[1]) {
    try { text = decodeURIComponent(urlMatch[1]); } catch { text = urlMatch[1]; }
  }
  const stripped = text.replace(/^\s*ct[\s-]*/i, "").replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(stripped)) return null;
  return stripped;
}

export function formatPickupDigits(digits: string): string {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length !== PICKUP_CODE_DIGITS) return "";
  return `${PICKUP_CODE_PREFIX}-${d.slice(0, 4)}-${d.slice(4)}`;
}

// Live formatting for the manual-entry field: keeps only digits (max 8) and
// shows them as "1234-5678" while typing.
export function formatPickupTyping(raw: string): { digits: string; display: string; complete: boolean } {
  const digits = String(raw || "").replace(/\D/g, "").slice(0, PICKUP_CODE_DIGITS);
  const display = digits.length > 4 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : digits;
  return { digits, display, complete: digits.length === PICKUP_CODE_DIGITS };
}

// What a decoded QR must look like to be OUR credential. Anything else is
// reported as "לא קוד איסוף של סיטון" instead of being sent to the server.
export function pickupCodeFromScan(text: string): string | null {
  const digits = normalizePickupInput(text);
  return digits ? formatPickupDigits(digits) : null;
}

export type ScanOutcome =
  | "idle"
  | "starting"
  | "scanning"
  | "decoded"
  | "not_our_code"
  | "permission_denied"
  | "camera_unavailable"
  | "insecure_context"
  | "unsupported"
  | "stopped"
  | "error";

// Every outcome has product Hebrew and a stable test id (mirrors geo.ts).
export const SCAN_OUTCOME_COPY: Record<ScanOutcome, string> = {
  idle: "המצלמה כבויה. אפשר לסרוק, להקליד קוד או לחפש לפי שם/טלפון.",
  starting: "מפעילים את המצלמה…",
  scanning: "כוונו את המצלמה אל קוד ה-QR של הקונה.",
  decoded: "הקוד נקרא — מאמתים מול השרת…",
  not_our_code: "זה לא קוד איסוף של סיטון. בקשו מהקונה להציג את קוד האיסוף ממסך המעקב, או הקלידו את הקוד.",
  permission_denied: "הדפדפן חסם את המצלמה. אפשר להקליד את הקוד או לחפש לפי שם/טלפון — או לאפשר מצלמה בהגדרות האתר ולנסות שוב.",
  camera_unavailable: "לא נמצאה מצלמה זמינה במכשיר הזה. הקלידו את הקוד או חפשו לפי שם/טלפון.",
  insecure_context: "סריקה במצלמה עובדת רק בחיבור מאובטח (https). הקלידו את הקוד.",
  unsupported: "הדפדפן הזה לא תומך בסריקה. הקלידו את הקוד או חפשו לפי שם/טלפון.",
  stopped: "המצלמה כבויה.",
  error: "הסריקה נכשלה. נסו שוב, או הקלידו את הקוד."
};

export const SCAN_OUTCOME_TEST_ID: Record<ScanOutcome, string> = Object.fromEntries(
  (Object.keys(SCAN_OUTCOME_COPY) as ScanOutcome[]).map((k) => [k, `pickup-scan-${k.replace(/_/g, "-")}`])
) as Record<ScanOutcome, string>;

// Map a getUserMedia failure to a named outcome (DOMException names, no DOM types).
export function classifyCameraError(error: { name?: string; message?: string } | null | undefined): ScanOutcome {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "permission_denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "camera_unavailable";
  if (name === "TypeError" || name === "NotSupportedError") return "unsupported";
  return "error";
}
