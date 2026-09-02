// P1 seam only. No AI provider is selected or called in the P0 Amazon upgrade.
// Keeping the provider boundary server-side prevents browser keys and makes a
// future enrichment job replaceable without changing Product or Deal truth.

export type ProductEnrichmentInput = {
  product_id: string;
  seller_id: string;
  name: string;
  description: string;
  product_type: "physical_product" | "voucher" | "ticket" | "service";
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
