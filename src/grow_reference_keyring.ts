// Grow provider-reference keyring: types, parsing and validation.
//
// A standalone module (node:crypto only) so the boot-time production guard
// (src/production_guards.ts) validates the keyring with the SAME rules the
// adapter uses at decrypt time, without importing the payment adapter and
// its runtime configuration. src/grow_payment_adapter.ts re-exports these.
import { createHash } from "node:crypto";

export type GrowReferenceKey = { kid: string; secret: string };
export type GrowReferenceKeyring = { primary: GrowReferenceKey; previous: GrowReferenceKey[] };

export const GROW_REFERENCE_KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function assertEncryptionKeyLength(secret: string) {
  if (String(secret || "").length < 32) throw new Error("grow_reference_encryption_key_missing");
}

export function deriveGrowReferenceKeyId(secret: string) {
  return createHash("sha256").update(`grow_ref_kid:${String(secret || "")}`).digest("hex").slice(0, 8);
}

/** Parse GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS entries ("key" or "kid:key"). */
export function parseGrowPreviousKeys(raw: string | readonly string[] | undefined | null): GrowReferenceKey[] {
  const entries = (Array.isArray(raw) ? raw : String(raw || "").split(","))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const match = /^([A-Za-z0-9_-]{1,32}):(.+)$/.exec(entry);
    if (match && match[2]!.length >= 32) return { kid: match[1]!, secret: match[2]! };
    return { kid: deriveGrowReferenceKeyId(entry), secret: entry };
  });
}

/**
 * Build and validate a keyring. Throws (configuration error, never at
 * decrypt time) when the primary is missing/short, a kid is malformed, a
 * previous key is short, or one kid names two different secrets.
 */
export function buildGrowReferenceKeyring(input: { primary_key: string; primary_key_id?: string | null; previous_keys?: string | readonly string[] | null }): GrowReferenceKeyring {
  const primarySecret = String(input.primary_key || "");
  assertEncryptionKeyLength(primarySecret);
  const primaryKid = String(input.primary_key_id || "").trim() || deriveGrowReferenceKeyId(primarySecret);
  if (!GROW_REFERENCE_KID_PATTERN.test(primaryKid)) throw new Error("grow_reference_key_id_invalid");
  const primary = { kid: primaryKid, secret: primarySecret };
  const previous: GrowReferenceKey[] = [];
  const byKid = new Map<string, string>([[primary.kid, primary.secret]]);
  for (const key of parseGrowPreviousKeys(input.previous_keys)) {
    if (key.secret.length < 32) throw new Error("grow_reference_previous_key_invalid");
    if (!GROW_REFERENCE_KID_PATTERN.test(key.kid)) throw new Error("grow_reference_key_id_invalid");
    const existing = byKid.get(key.kid);
    if (existing !== undefined) {
      if (existing !== key.secret) throw new Error("grow_reference_key_id_conflict");
      continue;
    }
    if (key.secret === primary.secret || previous.some((item) => item.secret === key.secret)) continue;
    byKid.set(key.kid, key.secret);
    previous.push(key);
  }
  return { primary, previous };
}
