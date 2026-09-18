import React, { useEffect, useState } from "react";
import { api } from "../api";
import { localizedError } from "../he";
import { getPreviewMeta } from "../previewMeta";
import { resolveSupportCopy } from "../productCopy";
import { useSiteContent } from "../siteContent";
import { t } from "../i18n";

// ── Public Support / Contact center (P0.2-S) ────────────────────────────────
// The form creates a canonical support case the Admin Support screen sees —
// no email transport is required for the case to exist, and no fake support
// address is ever displayed (the address appears only when SUPPORT_EMAIL is
// configured).
//
// UX CLOSEOUT (Issue #39, item 5): a deal-scoped inquiry now carries the deal.
// The buyer pastes the deal link (or arrives from the deal with it already
// filled in) and the SERVER resolves link → deal → seller. The same submission
// becomes the seller's inquiry thread, so a question about a specific deal
// reaches the person who can actually answer it instead of dying in an
// admin-only queue. Nothing here names a seller — the browser cannot.

const CATEGORIES: { key: string; label: string; deal: "required" | "optional" | "none" }[] = [
  { key: "general", label: "שאלה כללית", deal: "none" },
  { key: "deal", label: "בעיה בעסקה שהצטרפתי אליה", deal: "required" },
  { key: "payment", label: "תשלומים וחיובים", deal: "optional" },
  { key: "seller", label: "שאלת מוכר", deal: "none" },
  { key: "report", label: "דיווח על תוכן", deal: "optional" }
];

const DEAL_SCOPE = new Map(CATEGORIES.map((c) => [c.key, c.deal]));
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function SupportPage({ dealRef = "" }: { dealRef?: string } = {}) {
  const copy = resolveSupportCopy(useSiteContent());
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [category, setCategory] = useState(dealRef ? "deal" : "general");
  const [deal, setDeal] = useState(dealRef);
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — humans never see it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sentCase, setSentCase] = useState("");
  const [sentToSeller, setSentToSeller] = useState(false);
  const [supportEmail, setSupportEmail] = useState("");

  useEffect(() => {
    getPreviewMeta().then((meta) => setSupportEmail(String(meta?.support_email || "")));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = t("pages.support.11374f97");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) errs.email = t("pages.support.574b1fc6");
    if (message.trim().length < 10) errs.message = t("pages.support.6b6aec4c");
    const scope = DEAL_SCOPE.get(category) || "none";
    if (scope === "required" && !UUID_ANYWHERE.test(deal.trim())) {
      errs.deal = t("pages.support.3288f056");
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setError("");
    try {
      const r = await api.supportContact({
        name: name.trim(), email: email.trim(), phone: phone.trim() || undefined,
        category, message: message.trim(), website,
        ...(scope === "none" ? {} : { deal_ref: deal.trim() || undefined })
      });
      setSentToSeller(Boolean(r.thread_id));
      setSentCase(String(r.case_id || t("pages.support.e955d14f")));
    } catch (err: any) {
      setError(localizedError(err));
      setBusy(false);
    }
  };

  if (sentCase) {
    return (
      <div style={{ maxWidth: 560, margin: "40px auto" }}>
        <div className="panel" style={{ textAlign: "center" }}>
          <h1>{copy.sent_title}</h1>
          <p className="muted">{copy.sent_body}</p>
          {sentToSeller ? (
            <p className="muted small" data-testid="support-sent-to-seller">
              {t("pages.support.e8c2a09f")}</p>
          ) : null}
          <a className="btn btn-primary" href="#/">{t("pages.support.9fa52cda")}</a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560, margin: "24px auto" }}>
      <div className="panel">
        {/* the page's own main heading — the support route had no h1 at all */}
        <h1>{copy.title}</h1>
        <p className="muted small">
          {copy.intro}
          {supportEmail ? <>  {t("pages.support.af6fe8a8")}<a href={`mailto:${supportEmail}`} dir="ltr">{supportEmail}</a>.</> : null}
        </p>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label>{t("pages.support.8b1aa6b1")} <span className="req">*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={fieldErrors.name ? "invalid" : ""} />
            {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
          </div>
          <div className="field-row">
            <div className="field">
              <label>{t("pages.support.15dbea0f")} <span className="req">*</span></label>
              <input dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={fieldErrors.email ? "invalid" : ""} />
              {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
            </div>
            <div className="field">
              <label>{t("pages.support.737232c2")} <span className="hint">{t("pages.support.9fbd1f49")}</span></label>
              <input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
            </div>
          </div>
          <div className="field">
            <label>{t("pages.support.6f1fefdc")}</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          {(DEAL_SCOPE.get(category) || "none") !== "none" ? (
            <div className="field" data-testid="support-deal-field">
              <label>
                קישור לעסקה {DEAL_SCOPE.get(category) === "required" ? <span className="req">*</span> : <span className="hint">{t("pages.support.9fbd1f49")}</span>}
              </label>
              <input dir="ltr" value={deal} onChange={(e) => setDeal(e.target.value)} data-testid="support-deal-ref"
                placeholder="https://…/d/…" className={fieldErrors.deal ? "invalid" : ""} />
              <span className="hint">
                {t("pages.support.4184e405")}</span>
              {fieldErrors.deal ? <span className="field-error">{fieldErrors.deal}</span> : null}
            </div>
          ) : null}
          <div className="field">
            <label>{t("pages.support.99707260")} <span className="req">*</span></label>
            <textarea rows={5} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} className={fieldErrors.message ? "invalid" : ""} />
            {fieldErrors.message ? <span className="field-error">{fieldErrors.message}</span> : null}
          </div>
          {/* honeypot — visually hidden WITHOUT offscreen positioning (an
              offscreen left offset created a huge horizontal scroll in RTL) */}
          <input type="text" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off"
            aria-hidden="true" name="website"
            style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clipPath: "inset(50%)", border: 0, opacity: 0 }} />
          {error ? <div className="notice err">{error}</div> : null}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t("pages.support.ea12faeb") : t("pages.support.18a3d8cf")}</button>
        </form>
      </div>
    </div>
  );
}
