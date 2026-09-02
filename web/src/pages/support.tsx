import React, { useEffect, useState } from "react";
import { api } from "../api";
import { hebrewError } from "../he";
import { getPreviewMeta } from "../previewMeta";

// ── Public Support / Contact center (P0.2-S) ────────────────────────────────
// The form creates a canonical support case the Admin Support screen sees —
// no email transport is required for the case to exist, and no fake support
// address is ever displayed (the address appears only when SUPPORT_EMAIL is
// configured).

const CATEGORIES: { key: string; label: string }[] = [
  { key: "general", label: "שאלה כללית" },
  { key: "deal", label: "בעיה בעסקה שהצטרפתי אליה" },
  { key: "payment", label: "תשלומים וחיובים" },
  { key: "seller", label: "שאלת מוכר" },
  { key: "report", label: "דיווח על תוכן" }
];

export function SupportPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [category, setCategory] = useState("general");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — humans never see it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sentCase, setSentCase] = useState("");
  const [supportEmail, setSupportEmail] = useState("");

  useEffect(() => {
    getPreviewMeta().then((meta) => setSupportEmail(String(meta?.support_email || "")));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = "יש להזין שם";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) errs.email = "יש להזין כתובת אימייל תקינה";
    if (message.trim().length < 10) errs.message = "כתבו לנו כמה מילים על הפנייה (לפחות 10 תווים)";
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setError("");
    try {
      const r = await api.supportContact({
        name: name.trim(), email: email.trim(), phone: phone.trim() || undefined,
        category, message: message.trim(), website
      });
      setSentCase(String(r.case_id || "נקלטה"));
    } catch (err: any) {
      setError(hebrewError(err));
      setBusy(false);
    }
  };

  if (sentCase) {
    return (
      <div style={{ maxWidth: 560, margin: "40px auto" }}>
        <div className="panel" style={{ textAlign: "center" }}>
          <div style={{ fontSize: "2.2rem" }}>✅</div>
          <h2>הפנייה נקלטה</h2>
          <p className="muted">
            הפנייה שלכם נפתחה במערכת התמיכה של C-ton והצוות יטפל בה.
          </p>
          <a className="btn btn-primary" href="#/">חזרה לדף הבית</a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560, margin: "24px auto" }}>
      <div className="panel">
        <h2>תמיכה ויצירת קשר</h2>
        <p className="muted small">
          נתקלתם בבעיה או שיש לכם שאלה? מלאו את הטופס והפנייה תיפתח ישירות אצל צוות C-ton.
          {supportEmail ? <> אפשר גם לכתוב לנו ל-<a href={`mailto:${supportEmail}`} dir="ltr">{supportEmail}</a>.</> : null}
        </p>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label>שם <span className="req">*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={fieldErrors.name ? "invalid" : ""} />
            {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
          </div>
          <div className="field-row">
            <div className="field">
              <label>אימייל <span className="req">*</span></label>
              <input dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={fieldErrors.email ? "invalid" : ""} />
              {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
            </div>
            <div className="field">
              <label>טלפון <span className="hint">(לא חובה)</span></label>
              <input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
            </div>
          </div>
          <div className="field">
            <label>נושא הפנייה</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>תוכן הפנייה <span className="req">*</span></label>
            <textarea rows={5} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} className={fieldErrors.message ? "invalid" : ""} />
            {fieldErrors.message ? <span className="field-error">{fieldErrors.message}</span> : null}
          </div>
          {/* honeypot — visually hidden WITHOUT offscreen positioning (an
              offscreen left offset created a huge horizontal scroll in RTL) */}
          <input type="text" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off"
            aria-hidden="true" name="website"
            style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clipPath: "inset(50%)", border: 0, opacity: 0 }} />
          {error ? <div className="notice err">{error}</div> : null}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "שולחים…" : "שליחת הפנייה"}</button>
        </form>
      </div>
    </div>
  );
}
