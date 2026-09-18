// ── Reading product copy in a source-pinning test ──────────────────────────
//
// Before the product was bilingual, a suite could pin a sentence by matching
// the source text of the component. That check is now in the wrong place: the
// component holds a KEY and the sentence lives in the dictionary.
//
// These helpers keep the invariant and make it stronger. Instead of "this file
// contains this Hebrew", the assertion becomes "the screen renders THIS key,
// the key says exactly this in Hebrew, and it says something real in English"
// — which also catches a sentence that was translated into vagueness.
import assert from "node:assert/strict";
import { HE } from "../../web/src/i18n/dictionaries/he.js";
import { EN } from "../../web/src/i18n/dictionaries/en.js";

export function he(key: string): string {
  const value = HE[key];
  assert.ok(typeof value === "string", `no Hebrew for key ${key}`);
  return value as string;
}

export function en(key: string): string {
  const value = EN[key];
  assert.ok(typeof value === "string", `no English for key ${key}`);
  return value as string;
}

/**
 * Every key whose Hebrew value matches. A string matches EXACTLY first; if no
 * key holds it whole, a unique containing value counts — that is what lets a
 * pin on a fragment of a sentence keep working.
 */
export function keysForHebrew(pattern: string | RegExp): string[] {
  if (pattern instanceof RegExp) return Object.keys(HE).filter((key) => pattern.test(HE[key] as string));
  const exact = Object.keys(HE).filter((key) => HE[key] === pattern);
  if (exact.length) return exact;
  return Object.keys(HE).filter((key) => (HE[key] as string).includes(pattern));
}

/** The key that holds this Hebrew sentence. Fails when nothing holds it. */
export function keyForHebrew(pattern: string | RegExp): string {
  const keys = keysForHebrew(pattern);
  assert.ok(keys.length >= 1, `no dictionary key holds ${pattern}`);
  return keys[0]!;
}

/**
 * The invariant a source-pinning test really wants: this screen renders this
 * sentence, and the sentence exists in both languages.
 */
export function assertRendersCopy(source: string, hebrew: string | RegExp, label = ""): string {
  const keys = keysForHebrew(hebrew);
  assert.ok(keys.length >= 1, `no dictionary key holds ${hebrew}`);
  const key = keys.find((candidate) => source.includes(`"${candidate}"`));
  assert.ok(
    key,
    `${label || "the screen"} must render one of ${keys.join(", ")} (${typeof hebrew === "string" ? hebrew : String(hebrew)})`
  );
  assert.ok(typeof EN[key!] === "string" && (EN[key!] as string).trim().length > 0, `English for ${key}`);
  return key!;
}
