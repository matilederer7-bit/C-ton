// ── Product copy from the CMS ───────────────────────────────────────────────
//
// The deal page, the buyer tracking screen, the seller dashboard and the
// support form speak fixed sentences. They live in the CMS as locked blocks
// (pages `deal_page`, `seller_area`, `support_page` in content/cmsTemplates),
// so the owner can reword them without a deploy, while the structure, the
// numbers and every state-derived status stay canonical.
//
// This module is PURE (no DOM, no React) so the fallback rule is testable:
// an empty, partial or unavailable CMS payload always resolves to the
// canonical Hebrew defaults of the page contract — a content edit can never
// blank a sentence the flow depends on.
import { PAGE_CONTRACTS, contractFor, localizedPage, normalizePage, type Block, type PageContent } from "./content/cmsTemplates.js";
import { getLocale } from "./i18n/locale.js";

type Json = Record<string, any>;

function defaultsOf(key: string): Block[] {
  return (PAGE_CONTRACTS[key] || contractFor(key)).defaults();
}
/** A field of a named block, falling back to that block's canonical default when empty. */
function field(page: PageContent, key: string, blockId: string, name: string): string {
  const value = page.blocks.find((b) => b.id === blockId)?.fields?.[name];
  if (typeof value === "string" && value.trim()) return value;
  const fallback = defaultsOf(key).find((b) => b.id === blockId)?.fields?.[name];
  return typeof fallback === "string" ? fallback : "";
}
function items(page: PageContent, key: string, blockId: string): Record<string, string>[] {
  const list = page.blocks.find((b) => b.id === blockId)?.items;
  if (Array.isArray(list) && list.length) return list;
  return defaultsOf(key).find((b) => b.id === blockId)?.items || [];
}
/**
 * The stored page for a key, normalized against its contract (never partial)
 * and read in the ACTIVE language — these are the recurring product sentences
 * a buyer reads on every deal, so they follow the language like the rest.
 */
export function productPage(content: Json | null | undefined, key: string): PageContent {
  return localizedPage(normalizePage(content?.[key], contractFor(key)), getLocale());
}

export interface DealCopy {
  explainer: string; whyGroupPrice: string; afterTap: string; holdNotice: string; shareTitle: string;
  howTitle: string; howSteps: { n: string; title: string; body: string }[];
}
export function resolveDealCopy(content: Json | null | undefined): DealCopy {
  const page = productPage(content, "deal_page");
  const f = (id: string, name: string) => field(page, "deal_page", id, name);
  return {
    explainer: f("deal", "explainer"), whyGroupPrice: f("deal", "why_group_price"),
    afterTap: f("deal", "after_tap"), holdNotice: f("deal", "hold_notice"), shareTitle: f("deal", "share_title"),
    howTitle: f("how", "title"),
    howSteps: items(page, "deal_page", "how").map((s, i) => ({ n: String(i + 1), title: String(s.title || ""), body: String(s.body || "") }))
  };
}

export interface TrackCopy { holdNote: string; returnTitle: string; noAccessTitle: string; networkTitle: string; busyTitle: string }
export function resolveTrackCopy(content: Json | null | undefined): TrackCopy {
  const page = productPage(content, "deal_page");
  const f = (name: string) => field(page, "deal_page", "track", name);
  return { holdNote: f("hold_note"), returnTitle: f("return_title"), noAccessTitle: f("no_access_title"), networkTitle: f("network_title"), busyTitle: f("busy_title") };
}

export interface SellerCopy {
  empty_title: string; empty_body: string; empty_cta: string; journey_title: string;
  pending_title: string; pending_body: string; rejected_title: string; rejected_body: string; profile_incomplete_title: string;
}
export function resolveSellerCopy(content: Json | null | undefined): SellerCopy {
  const page = productPage(content, "seller_area");
  const f = (name: string) => field(page, "seller_area", "seller", name);
  return {
    empty_title: f("empty_title"), empty_body: f("empty_body"), empty_cta: f("empty_cta"), journey_title: f("journey_title"),
    pending_title: f("pending_title"), pending_body: f("pending_body"), rejected_title: f("rejected_title"),
    rejected_body: f("rejected_body"), profile_incomplete_title: f("profile_incomplete_title")
  };
}

export interface SupportCopy { title: string; intro: string; sent_title: string; sent_body: string }
export function resolveSupportCopy(content: Json | null | undefined): SupportCopy {
  const page = productPage(content, "support_page");
  const f = (name: string) => field(page, "support_page", "support", name);
  return { title: f("title"), intro: f("intro"), sent_title: f("sent_title"), sent_body: f("sent_body") };
}
