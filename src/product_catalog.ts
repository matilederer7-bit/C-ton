import { createHash } from "node:crypto";
import { assertRequiredTables } from "./schema_contract.js";
import { DEAL_TYPES, type DealType } from "./deal_types.js";

export const PRODUCT_TYPES = DEAL_TYPES;
export type ProductType = DealType;
export const PRODUCT_STATUSES = ["active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type ProductImageSnapshot = {
  product_image_id: string;
  storage_provider: string;
  storage_key: string;
  public_url: string | null;
  original_filename: string | null;
  mime_type: string;
  size_bytes: number;
  checksum_sha256: string | null;
  sort_order: number;
  is_primary: boolean;
};

export type ProductSnapshot = {
  schema_version: 1;
  product_id: string;
  product_revision: number;
  name: string;
  short_description: string;
  long_description: string;
  product_type: ProductType;
  category: string;
  type_attributes: Record<string, unknown>;
  fulfillment_defaults: Record<string, unknown>;
  images: ProductImageSnapshot[];
  content_hash: string;
};

function text(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function optionalDate(value: unknown, field: string): string | null {
  const raw = text(value, 80);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw Object.assign(new Error(`${field} must be a valid ISO date`), {
      statusCode: 400,
      code: `${field}_invalid`
    });
  }
  return new Date(ms).toISOString();
}

function validationError(message: string, code: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code });
}

function variationAxes(value: unknown): Array<{ name: string; values: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((raw) => {
    const axis = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const name = text(axis.name, 80);
    const values = Array.isArray(axis.values)
      ? [...new Set(axis.values.map((item) => text(item, 80)).filter(Boolean))].slice(0, 30)
      : [];
    if (!name || !values.length) validationError("variation axes require a name and values", "product_variation_invalid");
    return { name, values };
  });
}

export function normalizeProductType(value: unknown): ProductType {
  const normalized = text(value, 40);
  if (!(PRODUCT_TYPES as readonly string[]).includes(normalized)) {
    validationError(`product_type must be one of ${PRODUCT_TYPES.join(", ")}`, "product_type_invalid");
  }
  return normalized as ProductType;
}

export function validateProductAttributes(
  productType: ProductType,
  raw: unknown
): Record<string, unknown> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};

  if (productType === "physical_product") {
    const weightRaw = input.weight_grams;
    const weight = weightRaw === null || weightRaw === undefined || weightRaw === "" ? null : Number(weightRaw);
    if (weight !== null && (!Number.isFinite(weight) || weight <= 0 || weight > 1_000_000)) {
      validationError("weight_grams must be a positive number", "physical_weight_invalid");
    }
    return {
      variation_axes: variationAxes(input.variation_axes),
      stock_note: text(input.stock_note, 300),
      weight_grams: weight,
      dimensions: text(input.dimensions, 160),
      color: text(input.color, 120),
      size: text(input.size, 120)
    };
  }

  if (productType === "voucher") {
    const redemptionLocation = text(input.redemption_location, 500);
    const redemptionInstructions = text(input.redemption_instructions, 1000);
    if (!redemptionLocation) validationError("redemption_location is required for voucher products", "voucher_location_required");
    if (!redemptionInstructions) validationError("redemption_instructions is required for voucher products", "voucher_instructions_required");
    const validFrom = optionalDate(input.valid_from, "voucher_valid_from");
    const validUntil = optionalDate(input.valid_until, "voucher_valid_until");
    if (validFrom && validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
      validationError("voucher valid_until must be after valid_from", "voucher_period_invalid");
    }
    return {
      variation_axes: variationAxes(input.variation_axes),
      valid_from: validFrom,
      valid_until: validUntil,
      redemption_location: redemptionLocation,
      redemption_instructions: redemptionInstructions,
      usage_restrictions: text(input.usage_restrictions ?? input.terms, 2000)
    };
  }

  if (productType === "ticket") {
    const eventName = text(input.event_name, 200);
    const eventStartsAt = optionalDate(input.event_starts_at, "ticket_event_starts_at");
    const venueName = text(input.venue_name, 200);
    const entryInstructions = text(input.entry_instructions, 1000);
    if (!eventName) validationError("event_name is required for ticket products", "ticket_event_name_required");
    if (!eventStartsAt) validationError("event_starts_at is required for ticket products", "ticket_event_starts_at_required");
    if (!venueName) validationError("venue_name is required for ticket products", "ticket_venue_required");
    if (!entryInstructions) validationError("entry_instructions is required for ticket products", "ticket_entry_instructions_required");
    const eventEndsAt = optionalDate(input.event_ends_at, "ticket_event_ends_at");
    if (eventEndsAt && Date.parse(eventEndsAt) <= Date.parse(eventStartsAt)) {
      validationError("event_ends_at must be after event_starts_at", "ticket_event_period_invalid");
    }
    return {
      variation_axes: variationAxes(input.variation_axes),
      event_name: eventName,
      event_starts_at: eventStartsAt,
      event_ends_at: eventEndsAt,
      venue_name: venueName,
      venue_address: text(input.venue_address, 300),
      venue_city: text(input.venue_city, 100),
      entry_instructions: entryInstructions,
      ticket_type: text(input.ticket_type, 80) || "general_admission"
    };
  }

  const locationMode = text(input.service_location_mode, 40) || "onsite";
  if (!["online", "onsite", "customer_location", "hybrid"].includes(locationMode)) {
    validationError("service_location_mode is invalid", "service_location_mode_invalid");
  }
  const location = text(input.service_location, 500);
  if (["onsite", "hybrid"].includes(locationMode) && !location) {
    validationError("service_location is required for onsite or hybrid services", "service_location_required");
  }
  const redemptionInstructions = text(input.redemption_instructions, 1000);
  if (!redemptionInstructions) {
    validationError("redemption_instructions is required for service products", "service_instructions_required");
  }
  const validFrom = optionalDate(input.valid_from, "service_valid_from");
  const validUntil = optionalDate(input.valid_until, "service_valid_until");
  if (validFrom && validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    validationError("service valid_until must be after valid_from", "service_period_invalid");
  }
  return {
    variation_axes: variationAxes(input.variation_axes),
    service_location_mode: locationMode,
    service_location: location,
    valid_from: validFrom,
    valid_until: validUntil,
    redemption_instructions: redemptionInstructions,
    usage_restrictions: text(input.usage_restrictions, 2000),
    appointment_required: input.appointment_required === true
  };
}

export function normalizeFulfillmentDefaults(raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const minRaw = input.estimated_min_business_days;
  const maxRaw = input.estimated_max_business_days;
  const min = minRaw === null || minRaw === undefined || minRaw === "" ? null : Number(minRaw);
  const max = maxRaw === null || maxRaw === undefined || maxRaw === "" ? null : Number(maxRaw);
  if (min !== null && (!Number.isInteger(min) || min < 0 || min > 365)) {
    validationError("estimated_min_business_days must be an integer from 0 to 365", "fulfillment_estimate_min_invalid");
  }
  if (max !== null && (!Number.isInteger(max) || max < 0 || max > 365)) {
    validationError("estimated_max_business_days must be an integer from 0 to 365", "fulfillment_estimate_max_invalid");
  }
  if (min !== null && max !== null && max < min) {
    validationError("estimated_max_business_days must be at least estimated_min_business_days", "fulfillment_estimate_range_invalid");
  }
  return {
    estimated_min_business_days: min,
    estimated_max_business_days: max,
    estimate_anchor: "deal_completed"
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function buildProductSnapshot(product: any, images: any[]): ProductSnapshot {
  const content = {
    schema_version: 1 as const,
    product_id: String(product.product_id),
    product_revision: Number(product.revision || 1),
    name: text(product.name, 200),
    short_description: text(product.short_description, 200),
    long_description: text(product.long_description, 4000),
    product_type: normalizeProductType(product.product_type),
    category: text(product.category, 160),
    type_attributes: validateProductAttributes(normalizeProductType(product.product_type), product.type_attributes),
    fulfillment_defaults: normalizeFulfillmentDefaults(product.fulfillment_defaults),
    images: images.map((image) => ({
      product_image_id: String(image.product_image_id),
      storage_provider: String(image.storage_provider),
      storage_key: String(image.storage_key),
      public_url: image.public_url ? String(image.public_url) : null,
      original_filename: image.original_filename ? String(image.original_filename) : null,
      mime_type: String(image.mime_type),
      size_bytes: Number(image.size_bytes || 0),
      checksum_sha256: image.checksum_sha256 ? String(image.checksum_sha256) : null,
      sort_order: Number(image.sort_order || 0),
      is_primary: Boolean(image.is_primary)
    }))
  };
  return {
    ...content,
    content_hash: createHash("sha256").update(canonicalJson(content)).digest("hex")
  };
}

let ensurePromise: Promise<void> | null = null;
export async function ensureProductCatalogTables(
  withTx: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T>
): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = withTx((c) => assertRequiredTables(c, ["products", "product_images", "deal_service_terms"]));
  }
  await ensurePromise;
}

export function resetProductCatalogContractForTests(): void {
  ensurePromise = null;
}
