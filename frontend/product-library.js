const PRODUCT_TYPES = new Set(["physical_product", "voucher", "ticket", "service"]);
const PRODUCT_STATUSES = new Set(["all", "active", "archived"]);
const PRODUCT_SORTS = new Set(["updated", "name", "deals"]);

export function normalizeProductLibraryFilters(filters = {}) {
  const status = PRODUCT_STATUSES.has(String(filters.status || "")) ? String(filters.status) : "all";
  const type = PRODUCT_TYPES.has(String(filters.type || "")) ? String(filters.type) : "all";
  const sort = PRODUCT_SORTS.has(String(filters.sort || "")) ? String(filters.sort) : "updated";
  return { query: String(filters.query || "").trim().slice(0, 120), status, type, sort };
}

export function applyProductLibraryFilters(products, filters = {}) {
  const normalized = normalizeProductLibraryFilters(filters);
  const needle = normalized.query.toLocaleLowerCase("he");
  const visible = (Array.isArray(products) ? products : []).filter((product) => {
    if (normalized.status !== "all" && product?.status !== normalized.status) return false;
    if (normalized.type !== "all" && product?.product_type !== normalized.type) return false;
    if (!needle) return true;
    return [product?.name, product?.category]
      .some((value) => String(value || "").toLocaleLowerCase("he").includes(needle));
  });
  return visible.sort((left, right) => {
    if (normalized.sort === "name") {
      return String(left?.name || "").localeCompare(String(right?.name || ""), "he", { sensitivity: "base" });
    }
    if (normalized.sort === "deals") {
      return Number(right?.deals_count || 0) - Number(left?.deals_count || 0)
        || String(right?.updated_at || "").localeCompare(String(left?.updated_at || ""));
    }
    return String(right?.updated_at || "").localeCompare(String(left?.updated_at || ""));
  });
}

export function productDealRevisionStatus(deal, currentRevision) {
  const snapshotRevision = Number(deal?.product_snapshot_revision || deal?.product_snapshot?.product_revision || 0);
  const current = Number(currentRevision || 1);
  return {
    snapshotRevision,
    currentRevision: current,
    isCurrent: snapshotRevision > 0 && snapshotRevision === current,
    isHistorical: snapshotRevision > 0 && snapshotRevision < current,
    isUnknown: snapshotRevision < 1
  };
}

export function productLibraryEmptyKind(allProducts, visibleProducts, filters = {}) {
  if (!(Array.isArray(allProducts) && allProducts.length)) return "library-empty";
  if (Array.isArray(visibleProducts) && visibleProducts.length) return "has-results";
  return normalizeProductLibraryFilters(filters).query ? "search-empty" : "filter-empty";
}
