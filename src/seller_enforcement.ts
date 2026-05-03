export const SELLER_STATUSES = ["Active", "UnderReview", "Restricted", "Suspended", "Banned"] as const;

export type SellerStatus = (typeof SELLER_STATUSES)[number];
export type SellerAction = "create_draft" | "publish" | "operate";

export function normalizeSellerStatus(value: unknown): SellerStatus {
  const text = String(value || "").trim();
  return (SELLER_STATUSES as readonly string[]).includes(text) ? (text as SellerStatus) : "Active";
}

export function isSellerStatus(value: unknown): value is SellerStatus {
  return (SELLER_STATUSES as readonly string[]).includes(String(value || "").trim());
}

export function sellerStatusBlocksAction(statusValue: unknown, action: SellerAction) {
  const status = normalizeSellerStatus(statusValue);
  if (status === "Active" || status === "UnderReview") return false;
  if (status === "Restricted") return action === "publish";
  return true;
}

export function sellerStatusErrorCode(statusValue: unknown) {
  const status = normalizeSellerStatus(statusValue);
  if (status === "Restricted") return "SELLER_RESTRICTED";
  if (status === "Suspended") return "SELLER_SUSPENDED";
  if (status === "Banned") return "SELLER_BANNED";
  return "";
}

export function sellerStatusMessage(statusValue: unknown) {
  const status = normalizeSellerStatus(statusValue);
  if (status === "Restricted") return "seller is restricted from publishing new deals";
  if (status === "Suspended") return "seller is suspended from new seller actions";
  if (status === "Banned") return "seller is banned from seller actions";
  return "seller is active";
}

export function sellerStatusHebrewNotice(statusValue: unknown) {
  const status = normalizeSellerStatus(statusValue);
  if (status === "Restricted") {
    return "חשבונך מוגבל זמנית מפרסום עסקאות חדשות. עסקאות קיימות אינן משתנות אוטומטית.";
  }
  if (status === "Suspended") return "חשבונך הושעה זמנית מפעולות מוכר.";
  if (status === "Banned") return "חשבונך חסום מפעולות מוכר.";
  return "";
}
