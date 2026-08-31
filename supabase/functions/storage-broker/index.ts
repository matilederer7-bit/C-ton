// Siton storage broker — the ONLY privileged mutation path into Supabase
// Storage for deal media (R7 canonical storage).
//
// Security model:
// - Deployed with verify_jwt disabled; every request must instead carry the
//   x-siton-broker-key header. Only its SHA-256 digest lives here (a digest of
//   a 288-bit random secret is publishable); the plaintext key exists solely
//   in the Render Web/Worker environment, so browsers and Supabase clients
//   can never mutate storage directly.
// - The service-role key never leaves this function's runtime (it is injected
//   by the platform as SUPABASE_SERVICE_ROLE_KEY and is not echoed anywhere).
// - Operations are restricted to ONE bucket, system-generated object keys are
//   re-validated against traversal, size and content-type are enforced again
//   here even though the canonical Fastify boundary already validated them.
// - put never overwrites (upsert:false) and verifies the stored object before
//   reporting success; delete is idempotent.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const BUCKET = "deal-images";
const BROKER_KEY_SHA256 = "747be04baee00a81abb4f17021e3ea55c9fc46f5d92dc9534687896708ce73ae";
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_LIST_KEYS = 1000;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } }
);

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { ok: false, code, ...extra });
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validateKey(raw: unknown): string | null {
  const key = String(raw ?? "").replace(/\\/g, "/");
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("\0")) return null;
  const parts = key.split("/");
  if (parts.length < 2) return null;
  if (parts.some((part) => !part || part === "." || part === ".." || !/^[a-zA-Z0-9._-]+$/.test(part))) return null;
  return key;
}

function validatePrefix(raw: unknown): string | null {
  const prefix = String(raw ?? "").replace(/\\/g, "/");
  if (!prefix) return "";
  if (prefix.length > 512 || prefix.startsWith("/") || prefix.includes("\0")) return null;
  const parts = prefix.split("/");
  const bad = parts.some((part, index) => part === "." || part === ".." || (!part && index !== parts.length - 1) || (part && !/^[a-zA-Z0-9._-]+$/.test(part)));
  if (bad) return null;
  return prefix.replace(/\/+$/, "");
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

type HeadResult = { exists: boolean; size_bytes: number | null; content_type: string | null };

async function headObject(key: string): Promise<HeadResult> {
  const slash = key.lastIndexOf("/");
  const dir = slash >= 0 ? key.slice(0, slash) : "";
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  const { data, error } = await supabase.storage.from(BUCKET).list(dir, { limit: 100, search: name });
  if (error) throw error;
  const match = (data ?? []).find((entry) => entry.name === name && entry.id);
  if (!match) return { exists: false, size_bytes: null, content_type: null };
  const metadata = (match as { metadata?: { size?: number; mimetype?: string } }).metadata ?? {};
  return { exists: true, size_bytes: Number(metadata.size ?? 0), content_type: String(metadata.mimetype ?? "") || null };
}

async function walkKeys(prefix: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [prefix];
  let scannedDirs = 0;
  while (queue.length && out.length < limit && scannedDirs < 200) {
    const dir = queue.shift() as string;
    scannedDirs += 1;
    const { data, error } = await supabase.storage.from(BUCKET).list(dir, { limit: MAX_LIST_KEYS });
    if (error) throw error;
    for (const entry of data ?? []) {
      const full = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.id) {
        out.push(full);
        if (out.length >= limit) break;
      } else {
        queue.push(full);
      }
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  const providedKey = req.headers.get("x-siton-broker-key") ?? "";
  const providedHash = await sha256Hex(new TextEncoder().encode(providedKey));
  if (!providedKey || !timingSafeEqualHex(providedHash, BROKER_KEY_SHA256)) {
    return fail(401, "broker_unauthorized");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }
  const op = String(body.op ?? "");

  try {
    if (op === "put") {
      const key = validateKey(body.key);
      if (!key) return fail(400, "invalid_storage_key");
      const contentType = String(body.content_type ?? "").trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) return fail(400, "invalid_content_type");
      const raw = String(body.content_base64 ?? "");
      if (!raw || raw.length > Math.ceil((MAX_BYTES + 3) * 4 / 3) + 8) return fail(400, "content_too_large");
      const bytes = decodeBase64(raw);
      if (!bytes || bytes.length === 0) return fail(400, "invalid_content");
      if (bytes.length > MAX_BYTES) return fail(400, "content_too_large");
      const expectedChecksum = String(body.checksum_sha256 ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) return fail(400, "checksum_required");
      const actualChecksum = await sha256Hex(bytes);
      if (actualChecksum !== expectedChecksum) return fail(400, "checksum_mismatch");

      const upload = await supabase.storage.from(BUCKET).upload(key, bytes.slice().buffer, {
        contentType,
        upsert: false,
        cacheControl: "31536000"
      });
      if (upload.error) {
        const status = Number((upload.error as { statusCode?: string | number }).statusCode ?? 0);
        const message = String(upload.error.message ?? "");
        if (status === 409 || /already exists|Duplicate/i.test(message)) return fail(409, "storage_object_exists");
        return fail(503, "storage_write_failed", { detail: message.slice(0, 200) });
      }
      const head = await headObject(key);
      if (!head.exists || head.size_bytes !== bytes.length) {
        await supabase.storage.from(BUCKET).remove([key]).catch(() => undefined);
        return fail(503, "storage_verification_failed");
      }
      return json(200, { ok: true, op, key, verified: true, size_bytes: bytes.length, checksum_sha256: actualChecksum, content_type: contentType });
    }

    if (op === "head") {
      const key = validateKey(body.key);
      if (!key) return fail(400, "invalid_storage_key");
      const head = await headObject(key);
      return json(200, { ok: true, op, key, ...head });
    }

    if (op === "get") {
      const key = validateKey(body.key);
      if (!key) return fail(400, "invalid_storage_key");
      const { data, error } = await supabase.storage.from(BUCKET).download(key);
      if (error) {
        const status = Number((error as { statusCode?: string | number }).statusCode ?? 0);
        if (status === 404 || /not.?found/i.test(String(error.message ?? ""))) return fail(404, "storage_object_not_found");
        return fail(503, "storage_read_failed");
      }
      const bytes = new Uint8Array(await data.arrayBuffer());
      return json(200, { ok: true, op, key, content_base64: encodeBase64(bytes), content_type: data.type || null, size_bytes: bytes.length });
    }

    if (op === "delete") {
      const key = validateKey(body.key);
      if (!key) return fail(400, "invalid_storage_key");
      const { data, error } = await supabase.storage.from(BUCKET).remove([key]);
      if (error) return fail(503, "storage_delete_failed", { detail: String(error.message ?? "").slice(0, 200) });
      return json(200, { ok: true, op, key, found: Array.isArray(data) && data.length > 0 });
    }

    if (op === "list") {
      const prefix = validatePrefix(body.prefix);
      if (prefix === null) return fail(400, "invalid_storage_key");
      const limit = Math.max(1, Math.min(MAX_LIST_KEYS, Number(body.limit ?? 500) || 500));
      const keys = await walkKeys(prefix, limit);
      return json(200, { ok: true, op, prefix, keys });
    }

    return fail(400, "unsupported_op");
  } catch (error) {
    return fail(503, "storage_broker_error", { detail: String((error as Error)?.message ?? "").slice(0, 200) });
  }
});
