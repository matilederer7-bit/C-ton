// Product catalog (071) — pure, DOM-free rules for the seller Product Library
// so filtering, sorting, empty states and revision history are unit-testable
// (tests/product_catalog_validation.ts) and never diverge from the screen.
//
// Ported from the shelf branch codex/amazon-benchmark-upgrade (its legacy
// frontend/product-library.js) onto the canonical React web app.

export type ProductRow = {
  product_id: string;
  name: string;
  category?: string;
  product_type?: string;
  status?: string;
  revision?: number;
  deals_count?: number;
  updated_at?: string;
};

export type ProductLibraryFilters = {
  query?: string;
  status?: "active" | "archived" | "all" | string;
  type?: string;
  sort?: "updated" | "deals" | "name" | string;
};

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  physical_product: "מוצר פיזי",
  voucher: "שובר",
  ticket: "כרטיס לאירוע"
};

export function applyProductLibraryFilters<T extends ProductRow>(rows: T[], filters: ProductLibraryFilters = {}): T[] {
  const query = String(filters.query || "").trim().toLowerCase();
  const status = String(filters.status || "all");
  const type = String(filters.type || "");
  const sort = String(filters.sort || "updated");
  const filtered = rows.filter((row) => {
    if (status !== "all" && String(row.status || "active") !== status) return false;
    if (type && String(row.product_type || "") !== type) return false;
    if (query) {
      const hay = `${row.name || ""} ${row.category || ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  const byName = (a: T, b: T) => String(a.name || "").localeCompare(String(b.name || ""), "he");
  if (sort === "name") return [...filtered].sort(byName);
  if (sort === "deals") {
    return [...filtered].sort((a, b) => Number(b.deals_count || 0) - Number(a.deals_count || 0) || byName(a, b));
  }
  return [...filtered].sort((a, b) => Date.parse(String(b.updated_at || 0)) - Date.parse(String(a.updated_at || 0)) || byName(a, b));
}

export type ProductLibraryEmptyKind = "none" | "library-empty" | "search-empty" | "filter-empty";

// Distinguishes "you have no products" from "nothing matches your search"
// from "nothing matches this filter" — three different next actions.
export function productLibraryEmptyKind(all: ProductRow[], visible: ProductRow[], filters: ProductLibraryFilters = {}): ProductLibraryEmptyKind {
  if (visible.length) return "none";
  if (!all.length) return "library-empty";
  if (String(filters.query || "").trim()) return "search-empty";
  return "filter-empty";
}

export type ProductDealRevisionStatus = {
  snapshotRevision: number | null;
  currentRevision: number;
  isCurrent: boolean;
  isHistorical: boolean;
  isUnknown: boolean;
};

// A Deal is frozen at the Product revision it was created from. Later Product
// edits are informational history for that Deal, never a change to it.
export function productDealRevisionStatus(deal: { product_snapshot_revision?: number | null }, currentRevision: number): ProductDealRevisionStatus {
  const snapshotRevision = Number(deal?.product_snapshot_revision || 0) > 0 ? Number(deal.product_snapshot_revision) : null;
  const isCurrent = snapshotRevision !== null && snapshotRevision === currentRevision;
  const isHistorical = snapshotRevision !== null && snapshotRevision < currentRevision;
  return { snapshotRevision, currentRevision, isCurrent, isHistorical, isUnknown: snapshotRevision === null };
}

// Optional fulfillment estimate (business days from Deal completion), the one
// buyer-facing wording shared with the server projection.
export function deliveryEstimateText(option: { estimated_min_business_days?: number | null; estimated_max_business_days?: number | null; estimate_text?: string | null }): string | null {
  if (option?.estimate_text) return String(option.estimate_text);
  const min = option?.estimated_min_business_days == null ? null : Number(option.estimated_min_business_days);
  const max = option?.estimated_max_business_days == null ? null : Number(option.estimated_max_business_days);
  if (min !== null && max !== null) return min === max ? `${min} ימי עסקים מהשלמת העסקה` : `${min}–${max} ימי עסקים מהשלמת העסקה`;
  if (max !== null) return `עד ${max} ימי עסקים מהשלמת העסקה`;
  if (min !== null) return `לפחות ${min} ימי עסקים מהשלמת העסקה`;
  return null;
}

// Client-side mirror of the server rule (0–365 integers, max ≥ min); the
// server remains the authority and re-validates.
export function validateEstimateRange(minText: string, maxText: string): string | null {
  const parse = (raw: string) => {
    const t = String(raw ?? "").trim();
    if (!t) return null;
    if (!/^\d{1,3}$/.test(t)) return NaN;
    const n = Number(t);
    return n > 365 ? NaN : n;
  };
  const min = parse(minText);
  const max = parse(maxText);
  if (Number.isNaN(min) || Number.isNaN(max)) return "טווח ימי העסקים חייב להיות מספר שלם בין 0 ל-365";
  if (min !== null && max !== null && max < min) return "המקסימום חייב להיות לפחות כמו המינימום";
  return null;
}
