import pino from "pino";
import { scrubText } from "./error_monitoring.js";

// Pino's default `err` serializer copies message, stack and every enumerable
// property of an error. Database errors carry `detail`, `hint`, `where`, etc.,
// which can hold customer values (e.g. `Key (phone)=(0501234567)`). This
// serializer keeps the shape of pino's output but scrubs every string in it
// before it reaches hosted logs.

const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 20;
const STACK_MAX_LENGTH = 8000;

const UNSERIALIZABLE = Object.freeze({ type: "UnserializableError", message: "[unserializable error]" });

function scrubValue(value: unknown, key: string | undefined, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return key === "stack" ? scrubText(value, STACK_MAX_LENGTH) : scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return scrubText(value.toString());
  if (typeof value === "symbol" || typeof value === "function") return undefined;
  if (typeof value !== "object") return undefined;

  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
      for (let index = 0; index < limit; index += 1) out.push(safeRead(() => scrubValue(value[index], undefined, depth + 1, seen)));
      if (value.length > MAX_ARRAY_ITEMS) out.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
      return out;
    }
    if (value instanceof Error) return scrubObject(safeStdErr(value), depth, seen);
    if (value instanceof Date) return safeRead(() => value.toISOString());
    return scrubObject(value as Record<string, unknown>, depth, seen);
  } finally {
    seen.delete(value);
  }
}

function scrubObject(source: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(source);
  } catch {
    return { message: "[unreadable object]" };
  }
  let count = 0;
  for (const key of keys) {
    if (count >= MAX_KEYS) {
      out["[truncated_keys]"] = keys.length - MAX_KEYS;
      break;
    }
    count += 1;
    const scrubbed = safeRead(() => scrubValue(source[key], key, depth + 1, seen));
    if (scrubbed !== undefined) out[scrubText(key, 100)] = scrubbed;
  }
  return out;
}

function safeRead(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return "[unreadable]";
  }
}

function safeStdErr(err: Error): Record<string, unknown> {
  try {
    const serialized = pino.stdSerializers.err(err) as unknown;
    if (serialized && typeof serialized === "object") return serialized as Record<string, unknown>;
    return { message: String(serialized) };
  } catch {
    // pino's serializer reads every property directly; a throwing getter
    // aborts it. Rebuild the same shape one guarded read at a time.
    return manualErr(err);
  }
}

function manualErr(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: safeRead(() => err.constructor?.name ?? "Error"),
    message: safeRead(() => err.message),
    stack: safeRead(() => err.stack)
  };
  const cause = safeRead(() => (err as { cause?: unknown }).cause);
  if (cause !== undefined && cause !== "[unreadable]") out.cause = cause;
  let keys: string[] = [];
  try {
    keys = Object.keys(err);
  } catch {
    keys = [];
  }
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (key in out) continue;
    out[key] = safeRead(() => (err as unknown as Record<string, unknown>)[key]);
  }
  return out;
}

export function errorLogSerializer(err: unknown): Record<string, unknown> {
  try {
    const seen = new WeakSet<object>();
    if (err instanceof Error) {
      // Mark the root error seen so a self-referencing cause/property becomes [Circular].
      seen.add(err);
      return scrubObject(safeStdErr(err), 0, seen);
    }
    if (err === null || err === undefined) return { type: typeof err === "undefined" ? "undefined" : "null", message: String(err) };
    if (typeof err === "string") return { type: "string", message: scrubText(err) };
    if (typeof err === "object") {
      const scrubbed = scrubValue(err, undefined, 0, seen);
      if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) return scrubbed as Record<string, unknown>;
      return { type: "object", message: scrubText(String(scrubbed)), value: scrubbed };
    }
    return { type: typeof err, message: scrubText(String(err)) };
  } catch {
    return { ...UNSERIALIZABLE };
  }
}
