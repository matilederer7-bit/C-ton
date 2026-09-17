// ── UX CLOSEOUT (Issue #39, item 5) — public support ↔ deal/seller context ──
//
// The public contact form used to create an admin-only operational case with no
// deal and no seller, so a buyer writing "my order in deal X never arrived"
// produced a record the relevant seller could never see and an admin could not
// route. This module holds the pure, testable half of the fix: which support
// categories are deal-scoped, and how a buyer-supplied deal REFERENCE is turned
// into a candidate deal id.
//
// The reference is only ever a LOOKUP KEY. The runtime resolves it against
// `siton.deals` and takes the seller from the DEAL row — exactly like
// `POST /api/deals/:dealId/inquiries` does. Nothing a browser sends can name a
// seller, and an unpublished or unknown deal resolves to nothing.

/**
 * Categories whose inquiries belong to a specific deal (and therefore to that
 * deal's seller). `general` is a Siton question and `seller` is a seller asking
 * Siton about their own account — both stay admin-only and are never projected
 * to a seller, even if a deal reference is supplied.
 */
export const DEAL_SCOPED_SUPPORT_CATEGORIES = Object.freeze(["deal", "payment", "report"] as const);

/** Categories for which a resolvable deal reference is mandatory. */
export const DEAL_REFERENCE_REQUIRED_CATEGORIES = Object.freeze(["deal"] as const);

export function isDealScopedSupportCategory(category: unknown): boolean {
  return (DEAL_SCOPED_SUPPORT_CATEGORIES as readonly string[]).includes(String(category ?? ""));
}

export function supportCategoryRequiresDeal(category: unknown): boolean {
  return (DEAL_REFERENCE_REQUIRED_CATEGORIES as readonly string[]).includes(String(category ?? ""));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Pull a deal id out of whatever a buyer pastes: the bare id, a public deal
 * link (`https://host/d/<id>`), a hash route (`https://host/preview/#/deal/<id>`),
 * a tracking link carrying `?deal=<id>`, or the same with a `?ref=` attribution
 * suffix. Returns the lower-cased id, or null when there is nothing to resolve.
 *
 * Deliberately permissive about SHAPE and strict about IDENTITY: it recognises
 * a uuid anywhere in the string, and the caller then proves that uuid names a
 * real published deal. A string containing several uuids is rejected rather
 * than guessed at, so a paste that mixes two links never silently binds the
 * inquiry to the wrong seller.
 */
export function extractDealReference(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2000) return null;
  const matches = raw.match(new RegExp(UUID.source, "gi")) || [];
  const distinct = Array.from(new Set(matches.map((m) => m.toLowerCase())));
  if (distinct.length !== 1) return null;
  return distinct[0]!;
}
