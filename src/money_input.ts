// RED TEAM FIX (Phase 2 §2.2) — one canonical reader for every money amount a
// client can send.
//
// Every money column in the schema is numeric(12,2). The route validators used
// to check the raw JavaScript float and then hand it to PostgreSQL, so the
// value that passed validation and the value that got stored were not the same
// number. Three proven consequences:
//
//   * price_per_unit 0 was refused with 400 "must be a positive number", but
//     0.001 was accepted, stored as 0.00 and PUBLISHED — the exact state the
//     guard exists to prevent, reached through a different input.
//   * delivery cost "abc" became Math.max(0, NaN) === NaN, which numeric
//     accepts verbatim; the deal published, the buyer was shown no delivery
//     price, and the fee engine turned the NaN total into a zero fee.
//   * 1e15 reached the column and surfaced the raw 22003 overflow as a 500.
//
// Reading an amount therefore means reading it AS THE COLUMN WILL HOLD IT:
// round first, then validate the rounded value, then store that same rounded
// value. Nothing downstream can disagree with the guard any more.

/** numeric(12,2): 10 digits before the point, 2 after. */
export const MONEY_SCALE = 2;
export const MONEY_MAX = 9_999_999_999.99;
/** The smallest amount the column can distinguish from zero. */
export const MONEY_EPSILON = 0.01;

export type MoneyInputOptions = {
  /** Field name used in the error message and reason code. */
  field: string;
  /** Lowest acceptable value AFTER rounding. Defaults to MONEY_EPSILON. */
  min?: number;
  /** Highest acceptable value AFTER rounding. Defaults to MONEY_MAX. */
  max?: number;
  /** When true, `undefined`/`null`/"" yields null instead of an error. */
  optional?: boolean;
};

function reject(field: string, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode: 400,
    code: `${field}_invalid`
  });
}

/** Round to the storage scale, half-away-from-zero, without float drift. */
export function toStoredMoney(value: number): number {
  const scaled = value * 100;
  // 1.005*100 is 100.49999999999999 in binary floating point; nudging by one
  // unit in the last place recovers the decimal intent before rounding.
  const corrected = Math.abs(scaled - Math.trunc(scaled) - 0.5) < 1e-9
    ? Math.trunc(scaled) + Math.sign(scaled) * 0.5
    : scaled;
  return Math.sign(corrected) * Math.round(Math.abs(corrected)) / 100;
}

/**
 * Read a client-supplied money amount as numeric(12,2) will store it.
 * Returns the ROUNDED value — callers must persist exactly what comes back.
 */
export function readMoneyAmount(raw: unknown, options: MoneyInputOptions): number {
  const { field } = options;
  const min = options.min ?? MONEY_EPSILON;
  const max = options.max ?? MONEY_MAX;

  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    reject(field, `${field} is required`);
  }
  // Objects and arrays stringify into things Number() sometimes likes ([] is 0,
  // ["7"] is 7). A money amount is a number or the decimal text of one.
  if (typeof raw !== "number" && typeof raw !== "string") {
    reject(field, `${field} must be a number`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    reject(field, `${field} must be a finite number`);
  }
  if (Math.abs(value) > MONEY_MAX) {
    reject(field, `${field} must be at most ${MONEY_MAX}`);
  }
  const stored = toStoredMoney(value);
  if (stored < min) {
    reject(field, min > 0
      // "0.001 is positive" is true and useless: say what the column does.
      ? `${field} must be at least ${min} (amounts are stored to ${MONEY_SCALE} decimal places)`
      : `${field} must not be negative`);
  }
  if (stored > max) {
    reject(field, `${field} must be at most ${max}`);
  }
  return stored;
}

/** The optional variant: absent stays absent, present is read strictly. */
export function readOptionalMoneyAmount(raw: unknown, options: MoneyInputOptions): number | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  return readMoneyAmount(raw, options);
}
