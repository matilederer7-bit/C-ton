// P0.7 — ONE canonical "usable pickup location" rule, shared by the Web runtime
// (publish readiness, delivery editing, public/seller payload derivation, the
// seller Action Center) and the React app (wizard validation, publish checklist,
// public renderer). The web bundle imports this file directly, so the buyer
// preview and the public page can never disagree with the server.
//
// Canonical model (migrations 014/016 + 057): a delivery option carries a
// seller-typed `label` (the wizard asks for "כתובת / מיקום האיסוף") and
// optional explicit coordinates. There is NO separate address column and no
// fallback to any seller-profile address: only what was configured for THIS
// option is ever shown. A label that is merely the generic option-type name
// ("איסוף עצמי") is not a location.

export const PICKUP_OPTION_TYPES = ["pickup", "distribution_point"] as const;

export type PickupLikeOption = {
  option_type?: string | null;
  label?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
};

const GENERIC_LABELS = new Set([
  "איסוף עצמי",
  "איסוף",
  "נקודת חלוקה",
  "נקודת איסוף",
  "משלוח",
  "pickup",
  "self pickup",
  "self-pickup",
  "distribution point",
  "delivery"
]);

export function isPickupOptionType(optionType: unknown): boolean {
  return (PICKUP_OPTION_TYPES as readonly string[]).includes(String(optionType || ""));
}

function normalizeLabel(label: unknown): string {
  return String(label ?? "")
    .replace(/[\u0000-\u001f\u007f\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\-–—_/]/g, " ")
    .replace(/[.,:;!?"'׳״()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function finiteCoordinate(value: unknown, limit: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** Explicit coordinates configured for this option, or null. */
export function pickupCoordinates(option: PickupLikeOption | null | undefined): { latitude: number; longitude: number } | null {
  const latitude = finiteCoordinate(option?.latitude, 90);
  const longitude = finiteCoordinate(option?.longitude, 180);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

/**
 * The human-readable location text for a pickup-type option: the seller's
 * label unless it is empty or just the generic option-type name.
 */
export function pickupLocationText(option: PickupLikeOption | null | undefined): string | null {
  if (!isPickupOptionType(option?.option_type)) return null;
  const label = normalizeLabel(option?.label);
  if (!label) return null;
  if (GENERIC_LABELS.has(comparableLabel(label))) return null;
  return label;
}

/** Address text OR explicit coordinates — enough for a buyer to get there. */
export function hasUsablePickupLocation(option: PickupLikeOption | null | undefined): boolean {
  if (!isPickupOptionType(option?.option_type)) return true; // not a pickup option — nothing required
  return pickupLocationText(option) !== null || pickupCoordinates(option) !== null;
}

/** Pickup-type options that lack a usable location (publish blockers). */
export function pickupOptionsMissingLocation<T extends PickupLikeOption>(options: readonly T[] | null | undefined): T[] {
  return (options || []).filter((option) => isPickupOptionType(option.option_type) && !hasUsablePickupLocation(option));
}

/** Free map link from the canonical coordinates only (never from an address guess). */
export function pickupMapUrl(option: PickupLikeOption | null | undefined): string | null {
  const coords = pickupCoordinates(option);
  if (!coords) return null;
  return `https://www.google.com/maps/search/?api=1&query=${coords.latitude},${coords.longitude}`;
}

/** Directions link (opens the native map app on phones) from canonical coordinates only. */
export function pickupDirectionsUrl(option: PickupLikeOption | null | undefined): string | null {
  const coords = pickupCoordinates(option);
  if (!coords) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${coords.latitude},${coords.longitude}`;
}

/**
 * Public/seller payload projection for one delivery option — the SAME
 * derivation feeds the public deal JSON and the seller deal JSON, so the buyer
 * preview and the public page render identical pickup information.
 */
export function describePickupLocation(option: PickupLikeOption | null | undefined): {
  location_text: string | null;
  has_location: boolean;
  map_url: string | null;
} {
  const isPickup = isPickupOptionType(option?.option_type);
  return {
    location_text: isPickup ? pickupLocationText(option) : null,
    has_location: isPickup ? hasUsablePickupLocation(option) : false,
    map_url: isPickup ? pickupMapUrl(option) : null
  };
}
