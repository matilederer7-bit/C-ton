export function ils(minorOrMajor: number): string {
  const n = Number(minorOrMajor || 0);
  return "₪" + n.toLocaleString("he-IL", { maximumFractionDigits: 0 });
}

export const DEAL_TYPE_LABEL: Record<string, string> = {
  physical_product: "מוצר",
  voucher: "שובר",
  ticket: "כרטיס"
};

export function dealTypeLabel(t: string): string {
  return DEAL_TYPE_LABEL[t] || "מוצר";
}

// Map canonical deal state to a shopper-facing status. TargetReached is NOT
// "completed" — the group buy continues.
export function statusView(state: string): { label: string; cls: string } {
  switch (state) {
    case "Draft": return { label: "טיוטה", cls: "closed" };
    case "PendingTarget": return { label: "פתוח להצטרפות", cls: "open" };
    case "TargetReached": return { label: "היעד הושג — עדיין אפשר להצטרף", cls: "reached" };
    case "ClosedForJoining": return { label: "סגור להצטרפות", cls: "closed" };
    case "CompletionWindow":
    case "Charging": return { label: "בעיבוד", cls: "reached" };
    case "Completed": return { label: "הושלם", cls: "completed" };
    case "Cancelled": return { label: "בוטל", cls: "closed" };
    default: return { label: state || "—", cls: "closed" };
  }
}

export function deadlineView(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "הסתיים";
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `נותרו ${hours} שעות`;
  const days = Math.floor(hours / 24);
  return `נותרו ${days} ימים`;
}

export function num(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
