import { scrubText } from "./error_monitoring.js";

// Error serializer for hosted logs.
//
// Copying every enumerable property of an error (pino's default) cannot be
// made safe by pattern scrubbing: axios errors carry request/response bodies,
// application errors carry buyer names and addresses, and config objects carry
// credentials whose values have no recognisable shape. So only a fixed
// allowlist of diagnostic fields is emitted; everything else is dropped and
// only counted. Every emitted string is still scrubbed, and PostgreSQL value
// lists in detail/hint/where are removed before scrubbing.

const MAX_DEPTH = 4;
const MAX_ERRORS = 20;
const STACK_MAX_LENGTH = 8000;
const PG_SCAN_MAX_LENGTH = 20_000;

const ALLOWED_KEYS = [
  "type",
  "message",
  "stack",
  "code",
  "errno",
  "syscall",
  "status",
  "statusCode",
  "severity",
  "routine",
  "schema",
  "table",
  "column",
  "constraint",
  "dataType",
  "position",
  "detail",
  "hint",
  "where",
  "cause",
  "errors"
] as const;
const ALLOWED = new Set<string>(ALLOWED_KEYS);
const PG_VALUE_KEYS = new Set(["detail", "hint", "where"]);

const UNREADABLE = Symbol("unreadable");

type Serialized = Record<string, unknown>;

function unserializable(): Serialized {
  return { type: "UnserializableError", message: "[unserializable error]" };
}

function safeRead<T>(read: () => T): T | typeof UNREADABLE {
  try {
    return read();
  } catch {
    return UNREADABLE;
  }
}

// A phone or card number stored as a number is as personal as its string form.
function scrubNumber(value: number | bigint): number | string {
  const text = String(value);
  if (scrubText(text) !== text) return "[redacted:number]";
  // bigint is not JSON-serializable; keep its (safe) digits as text.
  return typeof value === "bigint" ? text : value;
}

// Buffers, typed arrays and DataViews would otherwise serialize byte by byte.
function binaryLength(value: object): number | undefined {
  try {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return (value as ArrayBuffer).byteLength;
    if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return value.byteLength;
  } catch {
    return undefined;
  }
  return undefined;
}

// PostgreSQL does not escape parentheses inside values, so a ")" in a detail
// line cannot be trusted to end a value list: `Key (a)=(x) Jane, Apt 3)` would
// leak the remainder if redaction stopped at the first close. Instead, from the
// first value-list opening, everything up to the LAST ")" in the string (or to
// the end when there is none) is replaced. Text after that last ")" is kept
// only when it is a known pg suffix. Over-redaction is intended. Linear:
// indexOf/lastIndexOf only.
const PG_VALUE_MARKERS = ["=(", "Failing row contains ("];
const PG_FIXED_SUFFIXES = new Set(["", ".", " already exists."]);
const PG_TABLE_SUFFIX_PREFIXES = [" is not present in table \"", " is still referenced from table \""];

function isKnownPgSuffix(suffix: string): boolean {
  if (PG_FIXED_SUFFIXES.has(suffix)) return true;
  for (const prefix of PG_TABLE_SUFFIX_PREFIXES) {
    if (!suffix.startsWith(prefix) || !suffix.endsWith("\".")) continue;
    const table = suffix.slice(prefix.length, suffix.length - 2);
    // A table name: no quotes, whitespace-free, short.
    if (table.length > 0 && table.length <= 128 && !/["\s]/.test(table)) return true;
  }
  return false;
}

function redactPgValueLists(input: string): string {
  const text = input.length > PG_SCAN_MAX_LENGTH ? input.slice(0, PG_SCAN_MAX_LENGTH) : input;
  let start = -1;
  let open = -1;
  for (const marker of PG_VALUE_MARKERS) {
    const found = text.indexOf(marker);
    if (found !== -1 && (start === -1 || found < start)) {
      start = found;
      open = found + marker.length;
    }
  }
  if (open === -1) return text;
  const lastClose = text.lastIndexOf(")");
  const prefix = text.slice(0, open) + "[redacted]";
  if (lastClose < open) return prefix;
  const suffix = text.slice(lastClose + 1);
  return prefix + ")" + (isKnownPgSuffix(suffix) ? suffix : "");
}

function scrubString(key: string, value: string): string {
  if (key === "stack") return scrubText(value, STACK_MAX_LENGTH);
  if (PG_VALUE_KEYS.has(key)) return scrubText(redactPgValueLists(value));
  return scrubText(value);
}

// Scalar diagnostic value, or undefined when the value is not emittable.
function scrubScalar(key: string, value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string") return scrubString(key, value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? scrubNumber(value) : value;
  if (typeof value === "bigint") return scrubNumber(value);
  if (typeof value === "object") {
    const binary = binaryLength(value);
    if (binary !== undefined) return `[binary ${binary} bytes]`;
  }
  return undefined;
}

function errorTypeName(value: Error): string {
  const name = safeRead(() => {
    const ctor = value.constructor;
    if (typeof ctor === "function" && typeof ctor.name === "string" && ctor.name) return ctor.name;
    return typeof value.name === "string" && value.name ? value.name : "Error";
  });
  return typeof name === "string" ? scrubText(name, 100) : "Error";
}

function serializeNested(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (value !== null && typeof value === "object" && seen.has(value)) return "[Circular]";
  return serialize(value, depth, seen);
}

function serialize(value: unknown, depth: number, seen: WeakSet<object>): Serialized {
  if (value === null || value === undefined) return { type: value === null ? "null" : "undefined", message: String(value) };
  if (typeof value === "string") return { type: "string", message: scrubText(value) };
  if (typeof value !== "object" && typeof value !== "function") {
    return { type: typeof value, message: scrubText(String(value)) };
  }
  const source = value as Record<string, unknown>;
  const binary = binaryLength(source);
  if (binary !== undefined) return { type: "binary", message: `[binary ${binary} bytes]` };

  seen.add(source);
  try {
    const out: Serialized = {};
    let omitted = 0;

    const ownKeys = safeRead(() => Object.keys(source));
    if (ownKeys === UNREADABLE) omitted += 1;
    else for (const key of ownKeys) if (!ALLOWED.has(key)) omitted += 1;

    const isError = value instanceof Error;
    for (const key of ALLOWED_KEYS) {
      const raw = safeRead(() => source[key]);
      if (raw === UNREADABLE) {
        out[key] = "[unreadable]";
        continue;
      }
      if (key === "type") {
        if (isError) {
          out.type = errorTypeName(value as Error);
          continue;
        }
        if (raw === undefined) continue;
      }
      if (raw === undefined) continue;
      if (key === "cause") {
        out.cause = serializeNested(raw, depth + 1, seen);
        continue;
      }
      if (key === "errors") {
        if (Array.isArray(raw)) {
          const length = raw.length;
          const items: unknown[] = [];
          for (let index = 0; index < Math.min(length, MAX_ERRORS); index += 1) {
            const item = safeRead(() => raw[index]);
            items.push(item === UNREADABLE ? "[unreadable]" : serializeNested(item, depth + 1, seen));
          }
          if (length > MAX_ERRORS) items.push(`[${length - MAX_ERRORS} more errors]`);
          out.errors = items;
        } else {
          out.errors = serializeNested(raw, depth + 1, seen);
        }
        continue;
      }
      const scalar = scrubScalar(key, raw);
      if (scalar === undefined) omitted += 1;
      else out[key] = scalar;
    }
    if (omitted > 0) out.omitted_keys = omitted;
    return out;
  } finally {
    seen.delete(source);
  }
}

export function errorLogSerializer(err: unknown): Record<string, unknown> {
  try {
    return serialize(err, 0, new WeakSet<object>());
  } catch {
    return unserializable();
  }
}
