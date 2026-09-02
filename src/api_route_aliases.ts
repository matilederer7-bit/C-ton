// R0 fixed /api as the canonical public namespace. The Deal lifecycle routes
// predate that decision and live at the bare paths. These aliases rewrite the
// /api form onto the exact same Fastify route before routing happens, so there
// is one business implementation and zero duplicate handlers.
//
// Only the canonical lifecycle set is rewritten. Existing /api routes that are
// real routes of their own (/api/deals/:id/public, /api/deals/:id/chat,
// /api/deal-images/...) never match and are untouched.
const DEAL_LIFECYCLE_ALIAS =
  /^\/api(\/deals(?:\/[^/?#]+\/(?:publish|join|close_joining|reopen_joining|prepare_charging|charging\/start|cancel))?)([?#].*)?$/;

export function rewriteCanonicalApiAlias(url: string): string {
  const match = DEAL_LIFECYCLE_ALIAS.exec(url);
  if (!match) return url;
  return `${match[1]}${match[2] || ""}`;
}
