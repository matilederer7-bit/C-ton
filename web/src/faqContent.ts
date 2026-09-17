// ── ROUND 2 (UX-7A) — the FAQ collection, behind ONE resolver ───────────────
//
// Owner intent: the admin CMS should manage the FAQ — add / edit / remove /
// reorder questions, persisted and reloaded safely.
//
// GAP CLOSED (SITE CMS): the FAQ is a `faq` block of the `home` page — an
// ordered {q, a} collection persisted in siton.site_content through the shared
// template schema (web/src/content/cmsTemplates.ts), edited in the admin
// content editor (add / edit / delete / reorder / hide) and published only
// through the draft → publish workflow. See docs/SITE_CMS.md.
//
// This module stays the ONE place the landing reads its FAQ from: it accepts
// the persisted block items (or the legacy flat pairs) and falls back to the
// canonical Hebrew list, so corrupt or empty data can never blank the section.
//
// Pure module (no DOM, no React) so the ordering/validation rule is testable.

export interface FaqItem { q: string; a: string }

const MAX_ITEMS = 40;
const MAX_Q = 300;
const MAX_A = 2000;

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

/** A well-formed pair: both sides present after cleaning. */
export function normalizeFaqItem(raw: unknown): FaqItem | null {
  if (!raw || typeof raw !== "object") return null;
  const q = clean((raw as any).q, MAX_Q);
  const a = clean((raw as any).a, MAX_A);
  return q && a ? { q, a } : null;
}

/**
 * Resolve the ordered FAQ the landing should render.
 *
 * `cms` is whatever /api/site-content returns for the FAQ section (today:
 * nothing). Accepted shapes, in order of preference:
 *   1. { items: [{q, a}, ...] } — the eventual ordered collection;
 *   2. an array of {q, a} directly;
 *   3. flat numbered pairs { faq_1_q, faq_1_a, faq_2_q, ... } — the only shape
 *      a string-only content store could express, ordered by index.
 * Anything malformed is ignored and the canonical fallback is used, so a bad
 * CMS payload can never blank the FAQ section.
 */
export function resolveFaqItems(cms: unknown, fallback: FaqItem[]): FaqItem[] {
  const fromList = (list: unknown): FaqItem[] =>
    Array.isArray(list) ? list.map(normalizeFaqItem).filter((i): i is FaqItem => i !== null).slice(0, MAX_ITEMS) : [];

  if (cms && typeof cms === "object" && !Array.isArray(cms)) {
    const items = fromList((cms as any).items);
    if (items.length) return items;
    // flat numbered pairs
    const rec = cms as Record<string, unknown>;
    const indexes = new Set<number>();
    for (const key of Object.keys(rec)) {
      const m = /^faq_(\d{1,3})_(q|a)$/.exec(key);
      if (m) indexes.add(Number(m[1]));
    }
    const flat = [...indexes].sort((x, y) => x - y)
      .map((i) => normalizeFaqItem({ q: rec[`faq_${i}_q`], a: rec[`faq_${i}_a`] }))
      .filter((i): i is FaqItem => i !== null)
      .slice(0, MAX_ITEMS);
    if (flat.length) return flat;
  }
  const direct = fromList(cms);
  if (direct.length) return direct;
  return fallback.map(normalizeFaqItem).filter((i): i is FaqItem => i !== null);
}
