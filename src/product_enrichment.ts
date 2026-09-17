// Product enrichment — provider seam only. No AI provider is selected, called
// or configured. Keeping the boundary server-side prevents browser keys and
// makes a future enrichment job replaceable without changing Product or Deal
// truth: a provider may only SUGGEST copy, category, search terms or variation
// axes; the seller approves, and published Deal snapshots stay immutable.
//
// Ported from the shelf branch codex/amazon-benchmark-upgrade.

import type { ProductType } from "./product_catalog.js";

export type ProductEnrichmentInput = {
  product_id: string;
  seller_id: string;
  name: string;
  description: string;
  product_type: ProductType;
  category: string;
};

export type ProductEnrichmentSuggestion = {
  short_description?: string;
  category?: string;
  search_terms?: string[];
  variation_axes?: Array<{ name: string; values: string[] }>;
};

export interface ProductEnrichmentProvider {
  readonly providerCode: string;
  suggest(input: ProductEnrichmentInput): Promise<ProductEnrichmentSuggestion>;
}

export const PRODUCT_ENRICHMENT_STATUS = "provider_pending" as const;

export function productEnrichmentReadiness() {
  return {
    enabled: false,
    status: PRODUCT_ENRICHMENT_STATUS,
    authority: "suggestions_only",
    note: "A future provider may suggest copy or variation axes; seller approval remains mandatory and Deal snapshots remain immutable."
  };
}
