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

// PostgreSQL messages quote the offending input (`invalid input syntax for
// type json: "{"buyer_name": "Jane Doe"}"`, SQL literals in single quotes) and
// do not escape quotes inside it, so quote pairs cannot be trusted. For
// pg-shaped errors one span is replaced: from the first quote of either kind
// to the last quote of either kind (to the end when there is only one). Text
// before the first quote is kept. Identifiers this may hide are still reported
// in table/column/constraint/schema/dataType. Linear: indexOf/lastIndexOf.
function redactQuotedSpan(text: string): string {
  const firstDouble = text.indexOf("\"");
  const firstSingle = text.indexOf("'");
  if (firstDouble === -1 && firstSingle === -1) return text;
  const first = firstDouble === -1 ? firstSingle : firstSingle === -1 ? firstDouble : Math.min(firstDouble, firstSingle);
  const last = Math.max(text.lastIndexOf("\""), text.lastIndexOf("'"));
  const head = `${text.slice(0, first)}"[redacted]"`;
  return last === first ? head : head + text.slice(last + 1);
}

function scrubString(key: string, value: string, pgShaped: boolean): string {
  if (key === "stack") return scrubText(pgShaped ? redactQuotedSpan(value) : value, STACK_MAX_LENGTH);
  if (key === "message" && pgShaped) return scrubText(redactQuotedSpan(value));
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

// One budget shared by the whole serialization of a single log call, so nested
// AggregateErrors cannot multiply into a multi-megabyte line: at most
// MAX_NODES error nodes (root, causes and errors children combined) and at most
// MAX_TOTAL_CHARS characters of emitted string values.
const MAX_NODES = 50;
const MAX_TOTAL_CHARS = 64 * 1024;
const BUDGET_OMITTED = "[omitted: log size budget]";

interface Context {
  seen: WeakSet<object>;
  nodes: number;
  chars: number;
}

function takeChars(ctx: Context, text: string): string {
  if (ctx.chars <= 0) return BUDGET_OMITTED;
  if (text.length <= ctx.chars) {
    ctx.chars -= text.length;
    return text;
  }
  const kept = text.slice(0, ctx.chars);
  ctx.chars = 0;
  return `${kept}…[truncated: log size budget]`;
}

// Scalar diagnostic value, or undefined when the value is not emittable.
function scrubScalar(key: string, value: unknown, pgShaped: boolean, ctx: Context): unknown {
  if (value === null) return null;
  if (typeof value === "string") return ctx.chars <= 0 ? BUDGET_OMITTED : takeChars(ctx, scrubString(key, value, pgShaped));
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

function omittedMarker(count: number): string {
  return `[${count} more errors omitted]`;
}

function serializeNested(value: unknown, depth: number, ctx: Context): unknown {
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (value !== null && typeof value === "object" && ctx.seen.has(value)) return "[Circular]";
  if (ctx.nodes <= 0) return omittedMarker(1);
  return serialize(value, depth, ctx);
}

function scrubMessage(ctx: Context, text: string): string {
  return ctx.chars <= 0 ? BUDGET_OMITTED : takeChars(ctx, scrubText(text));
}

function serialize(value: unknown, depth: number, ctx: Context): Serialized {
  ctx.nodes -= 1;
  if (value === null || value === undefined) return { type: value === null ? "null" : "undefined", message: String(value) };
  if (typeof value === "string") return { type: "string", message: scrubMessage(ctx, value) };
  if (typeof value !== "object" && typeof value !== "function") {
    return { type: typeof value, message: scrubMessage(ctx, String(value)) };
  }
  const source = value as Record<string, unknown>;
  const binary = binaryLength(source);
  if (binary !== undefined) return { type: "binary", message: `[binary ${binary} bytes]` };

  ctx.seen.add(source);
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
        out.cause = serializeNested(raw, depth + 1, ctx);
        continue;
      }
      if (key === "errors") {
        if (Array.isArray(raw)) {
          const length = safeRead(() => raw.length);
          const total = typeof length === "number" ? length : 0;
          const items: unknown[] = [];
          const limit = Math.min(total, MAX_ERRORS);
          let index = 0;
          for (; index < limit; index += 1) {
            if (ctx.nodes <= 0) break;
            const item = safeRead(() => raw[index]);
            items.push(item === UNREADABLE ? "[unreadable]" : serializeNested(item, depth + 1, ctx));
          }
          // Children not serialized (budget or per-array cap); nested ones
          // below them are not counted, so the number is a lower bound.
          if (total > index) items.push(omittedMarker(total - index));
          out.errors = items;
        } else {
          out.errors = serializeNested(raw, depth + 1, ctx);
        }
        continue;
      }
      const scalar = scrubScalar(key, raw, pgShaped, ctx);
      if (scalar === undefined) omitted += 1;
      else out[key] = scalar;
    }
    if (omitted > 0) out.omitted_keys = omitted;
    return out;
  } finally {
    ctx.seen.delete(source);
  }
}

export function errorLogSerializer(err: unknown): Record<string, unknown> {
  try {
    return serialize(err, 0, { seen: new WeakSet<object>(), nodes: MAX_NODES, chars: MAX_TOTAL_CHARS });
  } catch {
    return unserializable();
  }
}
