// ── ROUND 2 (UX-2) — "the exact control that is missing", made obvious ──────
//
// Owner finding: a failed continue showed a sentence ("בחרו לפחות אפשרות
// אספקה אחת למוצר.") that the eye slid straight past. A message is not a
// signal: the CONTROL itself has to ask for attention, and it has to stop the
// moment the value becomes valid.
//
// One rule, one class, no global hack:
//   * `attention(errors, key)` decorates exactly the control that failed —
//     the pulsing border comes from `.needs-attention` (styles.css), which
//     collapses to a static border under `prefers-reduced-motion`.
//   * `aria-invalid` rides along, so the state is not colour-only.
//   * Errors are only ever REMOVED while the user works (see `settleErrors`):
//     typing into field A must never light up field B.
//
// Pure module (no DOM, no React) so the rules stay unit-testable.

/** Attributes the failing control carries. `extra` keeps a caller's own classes. */
export function attention(
  errors: Record<string, string>,
  key: string,
  extra = ""
): { className: string; "aria-invalid": "true" | undefined; id: string } {
  const failed = Boolean(errors[key]);
  const classes = [extra.trim(), failed ? "invalid needs-attention" : ""].filter(Boolean).join(" ");
  return { className: classes, "aria-invalid": failed ? "true" : undefined, id: `f-${key}` };
}

/** The same signal for a non-input control (a fieldset, a card group, a notice). */
export function attentionBlock(
  errors: Record<string, string>,
  key: string,
  extra = ""
): { className: string; "aria-invalid": "true" | undefined; id: string; tabIndex: number } {
  return { ...attention(errors, key, extra), tabIndex: -1 };
}

// While the user is fixing things we only ever DROP errors: `next` is the
// freshly computed truth for the step, `shown` is what is currently on screen.
// A key stays lit only while it is still failing — so a text field clears on
// the first valid character and a select/toggle/number clears the moment its
// value becomes valid, with no re-validation nagging about untouched fields.
export function settleErrors(
  shown: Record<string, string>,
  next: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(shown)) if (next[key]) out[key] = next[key];
  return out;
}

/** True when settling would change nothing (lets callers skip a setState). */
export function sameErrors(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** Bring the first failing control into view and focus it. */
export function focusField(key: string): void {
  const el = document.getElementById(`f-${key}`) || document.querySelector<HTMLElement>(`[data-field="${key}"]`);
  if (!el) return;
  try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { el.scrollIntoView(); }
  (el as HTMLElement).focus?.({ preventScroll: true } as FocusOptions);
}
