// Storage-broker addressing scope (Black-Sky E5).
//
// Pure, dependency-free module shared by the Deno Edge Function (index.ts
// imports it as "./scope.ts") and the Node test suite
// (tests/storage_broker_scope_validation.ts), so the rule that is deployed is
// the rule that is tested.
//
// Before E5 the broker accepted ANY syntactically clean key for put/get/head/
// delete and an EMPTY prefix for list: one leaked broker key could enumerate
// and delete every object in the bucket, including objects of another
// deployment namespace sharing it. The broker holds no seller identity (per-
// seller authorization lives in the Fastify runtime), so the enforceable
// owner scope here is:
//   1. the object must live under an ALLOWED deployment namespace (the
//      runtime's OBJECT_STORAGE_PREFIX, e.g. "staging"), configured on the
//      function as SITON_BROKER_ALLOWED_PREFIXES (default "staging");
//   2. the object key must have the exact shape the runtime generates:
//      <namespace>/deals/<owner-segment>/images/<object-name>
//   3. list must name a prefix inside an allowed namespace — never the bucket
//      root — and walks only below it.

export const DEFAULT_ALLOWED_NAMESPACES = ["staging"] as const;

const SEGMENT = /^[a-zA-Z0-9._-]+$/;
const NAMESPACE = /^[a-zA-Z0-9_-]{1,64}$/;
const OWNER_SEGMENT = /^[a-zA-Z0-9-]{1,64}$/;
const OBJECT_NAME = /^[a-zA-Z0-9-]{1,64}\.(jpg|jpeg|png|webp|mp4|webm)$/;

export function parseAllowedNamespaces(raw: string | null | undefined): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [...DEFAULT_ALLOWED_NAMESPACES];
  const out = text.split(",").map((item) => item.trim()).filter((item) => NAMESPACE.test(item));
  // A configured-but-garbled list must fail closed (nothing allowed), never
  // silently fall back to the default.
  return out;
}

/** Syntactic key validation (traversal, charset, length). */
export function validateKey(raw: unknown): string | null {
  const key = String(raw ?? "").replace(/\\/g, "/");
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("\0")) return null;
  const parts = key.split("/");
  if (parts.length < 2) return null;
  if (parts.some((part) => !part || part === "." || part === ".." || !SEGMENT.test(part))) return null;
  return key;
}

/** Syntactic prefix validation; returns "" for an empty prefix. */
export function validatePrefix(raw: unknown): string | null {
  const prefix = String(raw ?? "").replace(/\\/g, "/");
  if (!prefix) return "";
  if (prefix.length > 512 || prefix.startsWith("/") || prefix.includes("\0")) return null;
  const parts = prefix.split("/");
  const bad = parts.some((part, index) => part === "." || part === ".." || (!part && index !== parts.length - 1) || (part && !SEGMENT.test(part)));
  if (bad) return null;
  return prefix.replace(/\/+$/, "");
}

/** A key the broker may address: syntactically valid, canonical shape, allowed namespace. */
export function scopedKey(raw: unknown, allowedNamespaces: readonly string[]): string | null {
  const key = validateKey(raw);
  if (!key) return null;
  const parts = key.split("/");
  if (parts.length !== 5) return null;
  const [namespace, deals, owner, images, name] = parts as [string, string, string, string, string];
  if (!allowedNamespaces.includes(namespace)) return null;
  if (deals !== "deals" || images !== "images") return null;
  if (!OWNER_SEGMENT.test(owner) || !OBJECT_NAME.test(name)) return null;
  return key;
}

/**
 * A list prefix the broker may walk: must be a namespace (or deeper path)
 * inside an allowed namespace. The bucket root ("") is refused.
 */
export function scopedListPrefix(raw: unknown, allowedNamespaces: readonly string[]): string | null {
  const prefix = validatePrefix(raw);
  if (prefix === null || prefix === "") return null;
  const parts = prefix.split("/");
  const namespace = parts[0] as string;
  if (!allowedNamespaces.includes(namespace)) return null;
  if (parts.length >= 2 && parts[1] !== "deals") return null;
  if (parts.length >= 3 && !OWNER_SEGMENT.test(parts[2] as string)) return null;
  if (parts.length >= 4 && parts[3] !== "images") return null;
  if (parts.length > 4) return null;
  return prefix;
}
