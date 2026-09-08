// SPRINT 4 (A9) — quantities are TYPED, never stepped.
//
// Owner rule: "In quantities I do not want arrows. I want pure number typing."
// One pure, DOM-free rule shared by every quantity field (buyer join qty,
// seller min / max units): the field is a plain text-like input with a numeric
// keyboard, it accepts DIGITS ONLY (so a decimal can never be typed, let alone
// silently accepted), and it reports a value only when the typed integer sits
// inside the caller's [min, max] window. Zero / negative / empty never become
// a value. Canonical business constraints (server-side positive integer, the
// 1000-unit DB cap, min <= max) are NOT redefined here — the window is the
// caller's, this module only decides what the keyboard produced.

export interface QuantityParse {
  /** the digits that survive filtering — what the field should display */
  digits: string;
  /** the accepted integer, or null when the text is empty / out of window */
  value: number | null;
  /** Hebrew reason when value is null (empty text has no message — it is a pause, not an error) */
  error: string | null;
}

/** Keep only ASCII digits; strip leading zeros so "007" reads as 7 (and "0" stays "0"). */
export function quantityDigits(raw: unknown): string {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  return trimmed.length > 9 ? trimmed.slice(0, 9) : trimmed;
}

export function parseQuantityInput(raw: unknown, min: number, max: number): QuantityParse {
  const lo = Math.max(1, Math.floor(Number(min) || 1));
  const hi = Math.max(lo, Math.floor(Number(max) || lo));
  const digits = quantityDigits(raw);
  if (!digits) return { digits, value: null, error: null };
  const n = Number(digits);
  if (!Number.isInteger(n) || n < lo) {
    return { digits, value: null, error: lo === 1 ? "הכמות חייבת להיות לפחות יחידה אחת" : `הכמות חייבת להיות לפחות ${lo}` };
  }
  if (n > hi) return { digits, value: null, error: `ניתן להזמין עד ${hi} יחידות` };
  return { digits, value: n, error: null };
}

/** True when the string is a whole positive integer (what the seller forms send as min/max). */
export function isPositiveIntegerText(raw: unknown): boolean {
  const s = String(raw ?? "").trim();
  return /^[0-9]+$/.test(s) && Number(s) >= 1;
}

/** Attributes every quantity field carries: text-like, numeric keyboard, digits only, no spinner. */
export const QUANTITY_INPUT_ATTRS = {
  type: "text",
  inputMode: "numeric",
  pattern: "[0-9]*",
  autoComplete: "off",
  dir: "ltr"
} as const;
