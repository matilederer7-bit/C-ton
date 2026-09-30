// Delivery estimates — the optional business-day range a seller may claim on
// a delivery option (migration 072 columns estimated_min_business_days /
// estimated_max_business_days on siton.deal_delivery_options), counted from
// Deal completion. Pure and dependency-free so the writers, the public/seller
// payload renderers and tests share one rule.

// Shared by the seller delivery-option writers (create, draft patch, delivery
// PUT): one rule for the optional business-day range on a delivery option.
export function normalizeDeliveryEstimate(option: any): {
  estimated_min_business_days: number | null;
  estimated_max_business_days: number | null;
} {
  const minRaw = option?.estimated_min_business_days;
  const maxRaw = option?.estimated_max_business_days;
  const min = minRaw === null || minRaw === undefined || minRaw === "" ? null : Number(minRaw);
  const max = maxRaw === null || maxRaw === undefined || maxRaw === "" ? null : Number(maxRaw);
  if (min !== null && (!Number.isInteger(min) || min < 0 || min > 365)) {
    throw Object.assign(new Error("estimated_min_business_days is invalid"), { statusCode: 400, code: "delivery_estimate_min_invalid" });
  }
  if (max !== null && (!Number.isInteger(max) || max < 0 || max > 365)) {
    throw Object.assign(new Error("estimated_max_business_days is invalid"), { statusCode: 400, code: "delivery_estimate_max_invalid" });
  }
  if (min !== null && max !== null && max < min) {
    throw Object.assign(new Error("estimated delivery range is invalid"), { statusCode: 400, code: "delivery_estimate_range_invalid" });
  }
  return { estimated_min_business_days: min, estimated_max_business_days: max };
}

// Buyer-facing projection of a stored estimate (null when the seller did not
// claim a range). Pure so the public renderer and tests share one rule.
export function describeDeliveryEstimate(row: any): {
  estimated_min_business_days: number | null;
  estimated_max_business_days: number | null;
  estimate_text: string | null;
} {
  const min = row?.estimated_min_business_days === null || row?.estimated_min_business_days === undefined ? null : Number(row.estimated_min_business_days);
  const max = row?.estimated_max_business_days === null || row?.estimated_max_business_days === undefined ? null : Number(row.estimated_max_business_days);
  let estimate_text: string | null = null;
  if (min !== null && max !== null) estimate_text = min === max ? `${min} ימי עסקים מהשלמת העסקה` : `${min}–${max} ימי עסקים מהשלמת העסקה`;
  else if (max !== null) estimate_text = `עד ${max} ימי עסקים מהשלמת העסקה`;
  else if (min !== null) estimate_text = `לפחות ${min} ימי עסקים מהשלמת העסקה`;
  return { estimated_min_business_days: min, estimated_max_business_days: max, estimate_text };
}
