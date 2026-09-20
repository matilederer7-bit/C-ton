// ── SITON LOCALE DRAFTS ────────────────────────────────────────────────────
//
// Switching language REMOUNTS every screen (see `App.tsx`: the tree is keyed on
// the locale so a modal, a memoised label or an error string already in state
// cannot survive in the previous language). That guarantee is kept exactly as
// it is — and it used to cost the visitor everything they had typed: a support
// enquiry, a half-written deal description, a reply to a buyer, all gone on one
// tap of "English".
//
// This module is the systemic answer. It is DOM-level on purpose: one
// implementation covers every form in the product, including forms that do not
// exist yet, instead of twenty hand-wired components that the twenty-first
// would silently miss.
//
//   1. BEFORE the locale changes (while the old tree is still mounted) every
//      free-text value on screen is captured and written to sessionStorage.
//   2. The locale changes and React remounts everything. Local component state
//      is gone — the store is not, because it lives outside React and outside
//      the remount.
//   3. AFTER the new tree mounts the values are put back, so nothing the
//      visitor wrote is ever lost, in any language.
//   4. If any of the restored values is real free text, the visitor is offered
//      a choice: keep it as written, or replace it with a translation they can
//      edit first. Nothing is ever auto-replaced.
//
// STORAGE. sessionStorage, not localStorage: a draft belongs to one tab and one
// sitting. It survives the remount and a refresh (which is what the product
// needs) and it does NOT outlive the tab, so a shared or public computer cannot
// hand one visitor's half-written enquiry to the next. Keys are namespaced per
// route AND per field identity, so two forms — or the same form on two routes —
// can never read each other's text.
//
// VERSIONS ARE APPEND-ONLY PER LANGUAGE. Each field keeps a map of
// locale -> text. Writing Hebrew never touches the English copy and vice versa,
// so switching he -> en -> he returns the visitor to exactly what they wrote in
// Hebrew, however many times they switch.

import type { Locale } from "./locale.js";

export const DRAFT_STORAGE_KEY = "siton.locale_drafts.v1";

/** A field is worth OFFERING A TRANSLATION for once it holds real prose. */
export const FREE_TEXT_MIN_LENGTH = 12;

/**
 * An answer the visitor already gave, bound to the exact text it was about.
 *
 * Binding the decision to `forOriginal` is what keeps the dialog both quiet and
 * honest: switching back and forth over the same content never asks twice, but
 * the moment the visitor writes something NEW, the old answer no longer applies
 * and they are asked about the new words.
 */
export type FieldDecision = { forOriginal: string; text: string };

export type FieldDraft = {
  /** locale -> the text the visitor had in that language. Append-only. */
  texts: Partial<Record<Locale, string>>;
  /** locale -> the answer already given, and the text it was given about. */
  decisions?: Partial<Record<Locale, FieldDecision>>;
  /** The language the text was FIRST written in. Never rewritten. */
  originLocale: Locale;
  /** A stable, human-meaningful label for the choice dialog. */
  label: string;
  /** True when the field is prose (textarea, or a long text input). */
  freeText: boolean;
};

export type DraftStore = Record<string, FieldDraft>;

export type LiveField = {
  id: string;
  label: string;
  value: string;
  freeText: boolean;
  element: HTMLInputElement | HTMLTextAreaElement;
};

/** Input types that are never prose and must never be offered for translation. */
const NON_PROSE_TYPES = new Set([
  "email", "tel", "url", "password", "hidden", "number", "date", "datetime-local",
  "time", "month", "week", "range", "color", "checkbox", "radio", "file", "submit",
  "button", "image", "reset"
]);

function hasDom(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

/** The route the field belongs to, so two screens never share a draft slot. */
function routeScope(): string {
  if (!hasDom()) return "";
  const hash = String(location.hash || "").replace(/^#/, "");
  // Strip volatile ids so returning to the same screen finds the same drafts.
  return hash.split("?")[0] || "/";
}

function fieldKey(el: HTMLInputElement | HTMLTextAreaElement, indexInForm: number): string | null {
  const explicit =
    el.getAttribute("id") ||
    el.getAttribute("data-testid") ||
    el.getAttribute("name");
  if (explicit) return explicit;
  // A field with no identity at all still deserves not to be wiped; fall back to
  // its position inside its form, which is stable across a remount of the same
  // screen.
  return `idx:${indexInForm}`;
}

function labelFor(el: HTMLInputElement | HTMLTextAreaElement): string {
  if (!hasDom()) return "";
  const id = el.getAttribute("id");
  if (id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const text = explicit?.textContent?.trim();
    if (text) return text.replace(/\s+/g, " ").slice(0, 80);
  }
  const wrapping = el.closest("label")?.textContent?.trim();
  if (wrapping) return wrapping.replace(/\s+/g, " ").slice(0, 80);
  const aria = el.getAttribute("aria-label") || el.getAttribute("placeholder");
  if (aria) return String(aria).replace(/\s+/g, " ").slice(0, 80);
  return String(el.getAttribute("id") || el.getAttribute("data-testid") || el.tagName.toLowerCase());
}

function isCapturable(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el.tagName === "TEXTAREA") return true;
  const type = String((el as HTMLInputElement).type || "text").toLowerCase();
  if (NON_PROSE_TYPES.has(type) && type !== "email" && type !== "tel" && type !== "url") {
    // checkbox/radio/file/etc are not text at all.
    return false;
  }
  // email / tel / url ARE captured (losing them is still data loss) but they are
  // never offered for translation — see `isFreeText`.
  return true;
}

/**
 * Identity fields are captured and restored like everything else, but they are
 * never OFFERED for translation: a person's name, their e-mail or their street
 * is not prose, and proposing to rewrite it in another language is nonsense.
 * The signal is the field's own `autocomplete` token, which the forms already
 * set for the browser's benefit — a standards-based answer rather than a list
 * of field names that the next form would fall outside of.
 */
const IDENTITY_AUTOCOMPLETE = new Set([
  "name", "given-name", "additional-name", "family-name", "nickname", "honorific-prefix",
  "honorific-suffix", "username", "email", "tel", "tel-national", "organization",
  "street-address", "address-line1", "address-line2", "address-level1", "address-level2",
  "postal-code", "country", "country-name", "bday", "sex", "url"
]);

function isIdentityField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  const token = String(el.getAttribute("autocomplete") || "").trim().toLowerCase();
  if (!token) return false;
  return token.split(/\s+/).some((part) => IDENTITY_AUTOCOMPLETE.has(part));
}

function isFreeText(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  if (isIdentityField(el)) return false;
  if (el.tagName === "TEXTAREA") return value.trim().length > 0;
  const type = String((el as HTMLInputElement).type || "text").toLowerCase();
  if (type !== "text" && type !== "search") return false;
  return value.trim().length >= FREE_TEXT_MIN_LENGTH;
}

/**
 * Every free-text field currently on screen, with a stable identity.
 * The honeypot (`tabindex="-1"`) and anything hidden is deliberately skipped.
 */
export function collectLiveFields(): LiveField[] {
  if (!hasDom()) return [];
  const scope = routeScope();
  const out: LiveField[] = [];
  const forms = Array.from(document.querySelectorAll("form"));
  const roots: Array<{ root: ParentNode; formIndex: number }> = forms.length
    ? forms.map((form, formIndex) => ({ root: form, formIndex }))
    : [{ root: document, formIndex: 0 }];

  for (const { root, formIndex } of roots) {
    const fields = Array.from(root.querySelectorAll("input, textarea")) as Array<
      HTMLInputElement | HTMLTextAreaElement
    >;
    fields.forEach((el, indexInForm) => {
      if (el.getAttribute("tabindex") === "-1") return; // honeypot
      if (el.disabled || el.readOnly) return;
      if (el.getAttribute("data-locale-draft") === "off") return;
      if (!isCapturable(el)) return;
      const key = fieldKey(el, indexInForm);
      if (!key) return;
      const value = String(el.value ?? "");
      out.push({
        id: `${scope}::form${formIndex}::${key}`,
        label: labelFor(el),
        value,
        freeText: isFreeText(el, value),
        element: el
      });
    });
  }
  return out;
}

export function readStore(): DraftStore {
  if (!hasDom()) return {};
  try {
    const raw = window.sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DraftStore) : {};
  } catch {
    return {}; // private mode, blocked storage, corrupt value — never throw
  }
}

function writeStore(store: DraftStore): void {
  if (!hasDom()) return;
  try {
    window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage full or blocked: the in-memory tree still holds the text */
  }
}

export function clearDraftStore(): void {
  if (!hasDom()) return;
  try { window.sessionStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Save what is on screen RIGHT NOW under `locale`.
 *
 * Append-only across languages: the entry for another locale is never touched,
 * and `originLocale` is written once and then left alone, so no number of
 * switches can overwrite where the text came from.
 */
export function captureDrafts(locale: Locale): DraftStore {
  const store = readStore();
  for (const field of collectLiveFields()) {
    if (!field.value.trim()) continue;
    const existing = store[field.id];
    store[field.id] = {
      texts: { ...(existing?.texts || {}), [locale]: field.value },
      ...(existing?.decisions ? { decisions: existing.decisions } : {}),
      originLocale: existing?.originLocale ?? locale,
      label: field.label || existing?.label || "",
      freeText: field.freeText || Boolean(existing?.freeText)
    };
  }
  writeStore(store);
  return store;
}

/** Record one field's text for one language without disturbing the others. */
export function rememberFieldText(id: string, locale: Locale, text: string): void {
  const store = readStore();
  const existing = store[id];
  if (!existing) return;
  store[id] = { ...existing, texts: { ...existing.texts, [locale]: text } };
  writeStore(store);
}

/**
 * Remember that the visitor has ALREADY answered for `forOriginal`, and what
 * they chose. Stored per language and bound to the text it was about, so a
 * later edit re-opens the question instead of silently inheriting an old answer.
 */
export function recordDecision(id: string, locale: Locale, forOriginal: string, text: string): void {
  const store = readStore();
  const existing = store[id];
  if (!existing) return;
  store[id] = {
    ...existing,
    texts: { ...existing.texts, [locale]: text },
    decisions: { ...(existing.decisions || {}), [locale]: { forOriginal, text } }
  };
  writeStore(store);
}

/**
 * Put `text` into a React-controlled field.
 *
 * A bare `el.value = x` is discarded on the next render because React tracks
 * the previous value on the node; going through the prototype setter and then
 * dispatching `input` is what makes React adopt it as real user input.
 */
export function applyValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Restore saved text into the fields on screen for `locale`.
 *
 * A field that has never held text in `locale` falls back to the text it was
 * written in — that is the whole point: the UI changes language, the visitor's
 * own words do not disappear. Returns the ids actually restored.
 */
export function restoreDrafts(locale: Locale): string[] {
  if (!hasDom()) return [];
  const store = readStore();
  if (!Object.keys(store).length) return [];
  const restored: string[] = [];
  for (const field of collectLiveFields()) {
    const draft = store[field.id];
    if (!draft) continue;
    const preferred = draft.texts[locale];
    const fallback = draft.texts[draft.originLocale];
    const text = preferred !== undefined ? preferred : fallback;
    if (text === undefined) continue;
    if (field.value === text) { restored.push(field.id); continue; }
    if (field.value.trim() && field.value !== text) {
      // Something already typed in the new tree wins over a stale draft: never
      // overwrite live input.
      continue;
    }
    applyValue(field.element, text);
    restored.push(field.id);
  }
  return restored;
}

export type DraftChoice = {
  id: string;
  label: string;
  /** What the visitor actually wrote, in the language they wrote it in. */
  original: string;
  originalLocale: Locale;
  /** Pre-filled, editable. Never applied unless the visitor confirms. */
  suggestion: string;
};

/**
 * The fields worth asking about after a switch from `from` to `to`.
 *
 * Only real prose is offered — a phone number or an e-mail address is restored
 * silently because "translating" it is meaningless. An empty form produces an
 * empty list, so a visitor with nothing typed never sees a dialog.
 */
export function pendingChoices(from: Locale, to: Locale, suggest: TranslationSuggester): DraftChoice[] {
  if (from === to) return [];
  const store = readStore();
  const choices: DraftChoice[] = [];
  for (const field of collectLiveFields()) {
    const draft = store[field.id];
    if (!draft || !draft.freeText) continue;
    const original = draft.texts[from];
    if (!original || !original.trim()) continue;
    // Already answered FOR THIS EXACT TEXT: switching back and forth over the
    // same content must not ask twice (`restoreDrafts` has already put the
    // right version back on screen). A decision is deliberately bound to the
    // original it was about, so writing something NEW re-opens the question
    // instead of inheriting a stale answer.
    const decided = draft.decisions?.[to];
    if (decided && decided.forOriginal.trim() === original.trim()) continue;
    // Nothing would change: the target language already holds exactly this
    // text, so there is no version to choose between. This is the ordinary
    // case of switching straight back to the language the text was written in.
    const existingForTarget = draft.texts[to];
    if (existingForTarget !== undefined && existingForTarget.trim() === original.trim()) continue;
    const suggestion = suggest(original, from, to);
    if (suggestion === null) continue;
    choices.push({
      id: field.id,
      label: draft.label,
      original,
      originalLocale: from,
      suggestion
    });
  }
  return choices;
}

/** Write a confirmed choice into the live field AND into the store. */
export function commitChoice(id: string, locale: Locale, text: string): boolean {
  const field = collectLiveFields().find((candidate) => candidate.id === id);
  rememberFieldText(id, locale, text);
  if (!field) return false;
  applyValue(field.element, text);
  return true;
}

// ── Translation suggestions ────────────────────────────────────────────────
//
// A suggester turns the visitor's text into a proposal in the new language, or
// returns null when it has nothing to propose.
//
// There is deliberately NO machine-translation engine wired in here. Siton has
// no translation provider, and sending a visitor's text to one would mean
// shipping buyer personal data — a support enquiry carries a name, an e-mail and
// a phone number — to a third party. That is an owner decision about privacy and
// cost, not something a code change should make silently. Until such a provider
// is authorised, the proposal starts from the visitor's own words and is fully
// editable, so the visitor can write the other language themselves and nothing
// is ever auto-replaced behind their back.

// ── The switch that is in flight ───────────────────────────────────────────
//
// The capture happens in the OLD tree and the restore in the NEW one, with a
// full remount in between, so "which switch is this?" cannot live in React
// state. It is written next to the drafts, read once by the new tree, and
// cleared as soon as it has been handled.

const PENDING_SWITCH_KEY = "siton.locale_switch.v1";

export type PendingSwitch = { from: Locale; to: Locale };

export function markPendingSwitch(from: Locale, to: Locale): void {
  if (!hasDom()) return;
  try {
    window.sessionStorage.setItem(PENDING_SWITCH_KEY, JSON.stringify({ from, to }));
  } catch { /* blocked storage */ }
}

export function takePendingSwitch(): PendingSwitch | null {
  if (!hasDom()) return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_SWITCH_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PENDING_SWITCH_KEY);
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.from === "he" || parsed.from === "en") && (parsed.to === "he" || parsed.to === "en")) {
      return parsed as PendingSwitch;
    }
    return null;
  } catch {
    return null;
  }
}

export type TranslationSuggester = (text: string, from: Locale, to: Locale) => string | null;

/** The default: propose the visitor's own text, editable, never auto-applied. */
export const identitySuggester: TranslationSuggester = (text) => text;

let suggester: TranslationSuggester = identitySuggester;

/** Seam for a future, owner-authorised translation provider. */
export function setTranslationSuggester(next: TranslationSuggester | null): void {
  suggester = next || identitySuggester;
}

export function currentSuggester(): TranslationSuggester {
  return suggester;
}
