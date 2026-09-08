import React, { useState } from "react";
import { api } from "./api";
import { hebrewError } from "./he";

// ── LAUNCH POLISH 2 (P6) — the smallest useful buyer feedback surface ──────
// ONE question ("היה משהו שלא היה ברור?"), a fixed category list, an optional
// bounded free text. PII-free by construction: the payload carries the deal
// id, the category, the surface and the text — never a name, phone, e-mail or
// the participant id. Asked once per deal per browser (localStorage), never
// forced, never blocks anything. The server stores it on the existing
// operational-cases rail (closed, low priority) and the owner reads the
// aggregate in מדדי פיילוט.
export const FEEDBACK_CATEGORIES: { key: string; label: string }[] = [
  { key: "how_it_works", label: "איך העסקה עובדת" },
  { key: "price", label: "המחיר / ההנחה" },
  { key: "target", label: "מה קורה אם לא מגיעים ליעד" },
  { key: "payment", label: "תשלום" },
  { key: "delivery", label: "משלוח / איסוף" },
  { key: "other", label: "משהו אחר" }
];
export const FEEDBACK_ALL_CLEAR = "all_clear";
export const FEEDBACK_TEXT_MAX = 280;
const STORE_KEY = "siton_feedback_v1";

function readDone(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function markDone(dealId: string, category: string): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...readDone(), [dealId]: category })); } catch { /* best effort */ }
}
export function feedbackGiven(dealId: string): boolean {
  return Boolean(readDone()[dealId]);
}

export function FeedbackPrompt({ dealId, surface, onDone }: {
  dealId: string;
  surface: "join_success" | "tracking";
  onDone?: () => void;
}) {
  const [done, setDone] = useState(() => feedbackGiven(dealId));
  const [category, setCategory] = useState("");
  const [text, setText] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — humans never see it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (done) {
    return <div className="feedback-thanks" data-testid="feedback-thanks">תודה! המשוב עוזר לנו לשפר את הדף לקונים הבאים.</div>;
  }

  const send = async (cat: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api.dealFeedback(dealId, {
        category: cat,
        text: cat === FEEDBACK_ALL_CLEAR ? undefined : (text.trim() || undefined),
        surface,
        website
      });
      markDone(dealId, cat);
      setDone(true);
      onDone?.();
    } catch (err: any) {
      // a repeated/capped feedback is still "received" for the buyer
      if (err?.status === 429) { markDone(dealId, cat); setDone(true); onDone?.(); }
      else setError(hebrewError(err));
    }
    setBusy(false);
  };

  return (
    <div className="feedback-box" data-testid="feedback-prompt" data-surface={surface}>
      <div className="feedback-q">היה משהו שלא היה ברור?</div>
      <div className="feedback-chips" role="group" aria-label="מה לא היה ברור">
        {FEEDBACK_CATEGORIES.map((c) => (
          <button type="button" key={c.key} className={`chip${category === c.key ? " active" : ""}`}
            data-testid={`feedback-chip-${c.key}`} aria-pressed={category === c.key}
            onClick={() => setCategory((cur) => (cur === c.key ? "" : c.key))}>
            {c.label}
          </button>
        ))}
      </div>
      {category ? (
        <div className="feedback-more">
          <input data-testid="feedback-text" value={text} maxLength={FEEDBACK_TEXT_MAX}
            placeholder="אפשר לפרט במשפט (לא חובה, בלי פרטים אישיים)"
            onChange={(e) => setText(e.target.value)} />
          <button type="button" className="btn btn-primary btn-sm" data-testid="feedback-send" disabled={busy} onClick={() => send(category)}>
            {busy ? "שולחים…" : "שליחה"}
          </button>
        </div>
      ) : null}
      <input type="text" className="hp-field" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} />
      <button type="button" className="feedback-clear" data-testid="feedback-all-clear" disabled={busy} onClick={() => send(FEEDBACK_ALL_CLEAR)}>
        הכול היה ברור 👍
      </button>
      {error ? <div className="notice err" style={{ margin: "8px 0 0" }} data-testid="feedback-error">{error}</div> : null}
    </div>
  );
}
