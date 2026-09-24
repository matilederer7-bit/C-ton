import { scrubText } from "./error_monitoring.js";

// Error serializer for hosted logs.
//
// Copying every enumerable property of an error (pino's default) cannot be
// made safe by pattern scrubbing: axios errors carry request/response bodies,
// application errors carry buyer names and addresses, and config objects carry
// credentials whose values have no recognisable shape. So only a fixed
// allowlist of diagnostic fields is emitted; everything else is dropped and
// only counted. Every emitted string is still scrubbed. PostgreSQL detail,
// hint and where echo row values and input in shapes that pattern redaction
// kept missing, so they are not emitted at all; quoted spans in pg messages
// are redacted.

const MAX_DEPTH = 4;
const MAX_ERRORS = 20;
const STACK_MAX_LENGTH = 8000;

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
  "cause",
  "errors"
] as const;
const ALLOWED = new Set<string>(ALLOWED_KEYS);

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

// PostgreSQL messages quote the offending input: `invalid input syntax for
// type integer: "Jane"`, `Expected ":", but found "Jane Doe".`, SQL literals in
// single quotes. For pg-shaped errors every quoted span is replaced; the
// identifiers it may also hide are still reported in table/column/constraint/
// schema/dataType. An unclosed quote redacts to the end. Linear: indexOf only.
function redactQuotedSpans(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    let next = -1;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (char === "\"" || char === "'") {
        next = cursor;
        break;
      }
    }
    if (next === -1) {
      out += text.slice(index);
      break;
    }
    const quote = text[next] === "'" ? "'" : "\"";
    out += `${text.slice(index, next)}${quote}[redacted]`;
    const close = text.indexOf(quote, next + 1);
    if (close === -1) break;
    out += quote;
    index = close + 1;
  }
  return out;
}

function scrubString(key: string, value: string, pgShaped: boolean): string {
  if (key === "stack") return scrubText(pgShaped ? redactQuotedSpans(value) : value, STACK_MAX_LENGTH);
  if (key === "message" && pgShaped) return scrubText(redactQuotedSpans(value));
  return scrubText(value);
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function isPgShaped(source: Record<string, unknown>): boolean {
  const severity = safeRead(() => source.severity);
  if (typeof severity === "string") return true;
  const code = safeRead(() => source.code);
  const routine = safeRead(() => source.routine);
  return typeof code === "string" && SQLSTATE.test(code) && routine !== undefined && routine !== UNREADABLE;
}

// Scalar diagnostic value, or undefined when the value is not emittable.
function scrubScalar(key: string, value: unknown, pgShaped: boolean): unknown {
  if (value === null) return null;
  if (typeof value === "string") return scrubString(key, value, pgShaped);
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
    const pgShaped = isPgShaped(source);
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
      const scalar = scrubScalar(key, raw, pgShaped);
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
