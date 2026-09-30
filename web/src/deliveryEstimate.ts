import { t } from "./i18n/index.js";
// Optional fulfillment estimate (business days from Deal completion), the one
// buyer-facing wording shared with the server projection.
export function deliveryEstimateText(option: { estimated_min_business_days?: number | null; estimated_max_business_days?: number | null; estimate_text?: string | null }): string | null {
  if (option?.estimate_text) return String(option.estimate_text);
  const min = option?.estimated_min_business_days == null ? null : Number(option.estimated_min_business_days);
  const max = option?.estimated_max_business_days == null ? null : Number(option.estimated_max_business_days);
  if (min !== null && max !== null) return min === max ? t("product_library.min_business_days_deal_completing", { min: min }) : t("product_library.min_max_business_days_deal", { min: min, max: max });
  if (max !== null) return t("product_library.up_max_business_days_deal", { max: max });
  if (min !== null) return t("product_library.at_least_min_business_days", { min: min });
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
  if (Number.isNaN(min) || Number.isNaN(max)) return t("product_library.the_business_day_range_must");
  if (min !== null && max !== null && max < min) return t("product_library.the_maximum_must_least_minimum");
  return null;
}
