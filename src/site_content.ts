// ── Site content (CMS) — server authority over the template-driven pages ────
//
// Persistence stays siton.site_content (one row per page key, value_jsonb).
// value_jsonb is the PUBLISHED page; draft_jsonb (migration 069) is the
// owner's unpublished working copy. The public site reads only value_jsonb;
// preview reads draft ?? published behind the admin guard. Every stored page is
// a template page ({ blocks: [...] }) validated by the ONE shared schema in
// web/src/content/cmsTemplates.ts. Rows written before the block model (flat
// { title, sub, ... }) are converted deterministically on read and the next
// write stores the block shape.
import { LEGAL_NAV_LABEL_KEYS, LEGAL_PAGES } from "./legal_pages.js";
import {
  PAGE_CONTRACTS, legalPageContract, validatePage, normalizePage, projectLegacy, missingEnglishContent, assetRefs, CmsValidationError,
  type PageContract, type PageContent
} from "../web/src/content/cmsTemplates.js";
import { failure, type Db } from "./receipt_trust.js";

export const CONTENT_SECTIONS: Record<string, PageContract> = {
  ...PAGE_CONTRACTS,
  ...Object.fromEntries(Object.entries(LEGAL_PAGES).map(([key, page]) => [`legal_${key}`, legalPageContract(LEGAL_NAV_LABEL_KEYS[key as keyof typeof LEGAL_NAV_LABEL_KEYS], { title: page.title, body: page.body })]))
};

export function contractOf(key: string): PageContract {
  if (!Object.hasOwn(CONTENT_SECTIONS, key)) failure("invalid_content");
  return CONTENT_SECTIONS[key]!;
}

/** Strict validation of a page payload (draft or publish). Rejects malformed structure, HTML, bad links, foreign assets. */
export function validateContent(key: string, value: unknown): PageContent {
  const contract = contractOf(key);
  try { return validatePage(value, contract); }
  catch (err) { if (err instanceof CmsValidationError) failure(err.code); throw err; }
}

/** Every referenced asset must be an admin upload of the kind the field expects. */
export async function verifyContentAssets(c: Db, page: PageContent) {
  for (const ref of assetRefs(page)) {
    const id = ref.url.split("/").pop();
    const asset = (await c.query(`SELECT mime_type FROM siton.content_assets WHERE asset_id=$1 AND owner_ref LIKE 'admin:%'`, [id])).rows[0];
    if (!asset) failure(ref.kind === "image" ? "invalid_content_image" : "invalid_content_video");
    if (!String(asset.mime_type).startsWith(`${ref.kind}/`)) failure(ref.kind === "image" ? "invalid_content_image" : "invalid_content_video");
  }
}

export type SectionState = {
  label: string; description: string;
  contract: { locked: PageContract["locked"]; addable: PageContract["addable"]; maxBlocks: number };
  published: PageContent; draft: PageContent | null;
  /** normalized draft when one is stored — the raw stored draft is re-validated at publish time */
  revision: number; updated_at: string | null; updated_by: string | null;
  draft_updated_at: string | null; draft_updated_by: string | null; published_at: string | null;
  /** compatibility: the flat legacy projection of the PUBLISHED page (the pre-block `value` shape the server-rendered legal route and older clients read) */
  value: Record<string, string>;
  /** the same projection read in English — each field falls back to the Hebrew one when no English value was written */
  value_en: Record<string, string>;
  /** Siton-owned content values on this page that have NO English version and are therefore served as Hebrew */
  missing_english: string[];
};

export async function readContent(c: Db): Promise<Record<string, SectionState>> {
  const rows = (await c.query(`SELECT content_key, value_jsonb, draft_jsonb, revision, updated_at, updated_by, draft_updated_at, draft_updated_by, published_at FROM siton.site_content`)).rows;
  return Object.fromEntries(Object.entries(CONTENT_SECTIONS).map(([key, contract]) => {
    const row = rows.find((r: any) => r.content_key === key);
    const published = normalizePage(row?.value_jsonb, contract);
    const draft = row?.draft_jsonb ? normalizePage(row.draft_jsonb, contract) : null;
    const state: SectionState = {
      label: contract.label, description: contract.description,
      contract: { locked: contract.locked, addable: contract.addable, maxBlocks: contract.maxBlocks },
      published, draft,
      value: projectLegacy(published, contract),
      value_en: projectLegacy(published, contract, "en"),
      missing_english: missingEnglishContent(published),
      revision: row?.revision || 0, updated_at: row?.updated_at || null, updated_by: row?.updated_by || null,
      draft_updated_at: row?.draft_updated_at || null, draft_updated_by: row?.draft_updated_by || null, published_at: row?.published_at || null
    };
    return [key, state];
  }));
}

/** The public projection: ENABLED blocks only (hidden content never leaves the server) plus the flat legacy fields older bundles still read. */
export function publicContent(sections: Record<string, SectionState>, mode: "published" | "preview" = "published") {
  return Object.fromEntries(Object.entries(sections).map(([key, s]) => {
    const page = mode === "preview" ? (s.draft || s.published) : s.published;
    // The blocks carry BOTH languages (fields/fields_en); the client resolves
    // them for the language it is showing, so one response serves either.
    return [key, {
      ...projectLegacy(page, CONTENT_SECTIONS[key]!),
      value_en: projectLegacy(page, CONTENT_SECTIONS[key]!, "en"),
      blocks: page.blocks.filter(b => b.enabled)
    }];
  }));
}
