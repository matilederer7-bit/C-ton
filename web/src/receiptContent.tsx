import React, { useEffect, useRef, useState } from "react";
import { productRequest as request, type Json } from "./api";
import { QrCode } from "./qrcode";
import { PickupCard } from "./pickupCard";
import { optimizeImageFile } from "./images";
import { ChoiceCard, StatusPill } from "./components";
import { cameraSupported, startPickupScanner, type ScannerHandle } from "./pickupScan";
import { BRAND_LOGO_URL } from "./config";

export type ReceiptConfig = { method: string; instructions: string; url: string };
const OPTIONS = [
  ["qr", "QR / ברקוד", "הקונה יקבל קוד סריקה אישי לאחר השלמת העסקה"],
  ["code", "קוד מימוש", "הקונה יקבל קוד אישי למימוש"],
  ["name_phone", "שם וטלפון", "המימוש יתבצע לפי שם וטלפון של הקונה"],
  ["digital_link", "קישור דיגיטלי", "הקונה יקבל קישור לאחר השלמת העסקה"],
  ["instructions", "הוראות מהמוכר", "הקונה יקבל את הוראות המימוש שתגדירו"]
];
// ROUND 2 (UX-4) — the receipt method now uses THE Siton selection card, so a
// chosen option is unmistakable (orange border + tint, orange-filled
// indicator) instead of a bare native radio. The indicator is the ROUND
// single-select dot on purpose: siton.deals.receipt_config carries exactly ONE
// "method", so a square multi-select would promise something the canonical
// contract cannot store. See docs/UX_PRODUCT_POLISH_ROUND_2.md (BACKEND GAP 1).
export function ReceiptFields({ value, onChange, disabled = false, attention }: { value: ReceiptConfig; onChange: (v: ReceiptConfig) => void; disabled?: boolean; attention?: boolean }) {
  return <fieldset className={`receipt-fields${attention ? " attention-block needs-attention" : ""}`} disabled={disabled} id="f-receipt" tabIndex={-1} aria-invalid={attention ? "true" : undefined}>
    <legend>איך הקונה יקבל את מה ששילם עליו?</legend>
    <div className="choice-group" data-testid="receipt-methods">
      {OPTIONS.map(([key, title, help]) => <ChoiceCard key={key} mode="one" name="receipt-method" value={key}
        testId="receipt-method-option" checked={value.method === key} title={title!} help={help}
        onSelect={() => onChange({ ...value, method: key! })} />)}
    </div>
    {value.method === "digital_link" ? <label className="field">קישור מאובטח
      <input type="url" dir="ltr" required maxLength={2000} value={value.url} onChange={e => onChange({ ...value, url: e.target.value })} placeholder="https://" />
      <span className="muted small">לכתובת אישית לכל קונה אפשר להוסיף {'{code}'} לקישור.</span>
    </label> : null}
    {value.method === "instructions" || value.method === "code" || value.method === "qr" ? <label className="field">הוראות מימוש {value.method === "instructions" ? "" : "(לא חובה)"}
      <textarea rows={3} required={value.method === "instructions"} maxLength={1000} value={value.instructions} onChange={e => onChange({ ...value, instructions: e.target.value })} />
    </label> : null}
  </fieldset>;
}
export function ReceiptEditor({ dealId, state }: { dealId: string; state: string }) {
  const [value, setValue] = useState<ReceiptConfig | null>(null), [editable, setEditable] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { let alive = true; request(`/api/seller/deals/${dealId}/receipt`, {}, "seller").then(r => { if (alive) { setValue(r.receipt); setEditable(r.editable); } }).catch(e => { if (alive) setMessage(e.message); }); return () => { alive = false; }; }, [dealId, state]);
  return <div className="panel">{value ? <form onSubmit={async e => { e.preventDefault(); try { await request(`/api/seller/deals/${dealId}/receipt`, { method: "PUT", body: JSON.stringify(value) }, "seller"); setMessage("אופן המימוש נשמר"); } catch (err: any) { setMessage(err.message); } }}>
    <ReceiptFields value={value} onChange={setValue} disabled={!editable} />
    {editable ? <button className="btn btn-primary">שמירת אופן המימוש</button> : <p className="muted small">אופן המימוש נקבע בפרסום העסקה.</p>}
  </form> : null}<p role="status">{message}</p></div>;
}
// ROUND 2 (UX-5) — the seller's public identity in the product's own visual
// language: the logo/photo they uploaded, the display name, the About text and
// the safe public history the backend already computes. Public facts only —
// no e-mail, no phone, no address, no internal identifiers.
function SellerIdentity({ seller, compact = false }: { seller: Json; compact?: boolean }) {
  const about = String(seller.about || "");
  return <>
    <div className="seller-identity">
      {seller.image ? <img className={`seller-avatar${compact ? " sm" : ""}`} src={seller.image} alt="" data-testid="seller-profile-image" /> : null}
      <div className="seller-identity-name" data-testid="seller-display-name">{seller.name}</div>
    </div>
    {about ? <p className="seller-about" data-testid="seller-about">{compact && about.length > 140 ? `${about.slice(0, 140)}…` : about}</p> : null}
    <p className="seller-stats" data-testid="seller-stats">
      <span><b>{seller.stats.published}</b> עסקאות שפורסמו</span>
      <span><b>{seller.stats.completed}</b> הושלמו בהצלחה</span>
      {seller.stats.success_rate !== null ? <span><b>{seller.stats.success_rate}%</b> הצלחה</span> : null}
    </p>
  </>;
}
export function DealReceiptInfo({ dealId, onReady }: { dealId: string; onReady: (ready: boolean) => void }) {
  const [data, setData] = useState<Json | null>(null), [names, setNames] = useState<string[]>([]), [error, setError] = useState("");
  useEffect(() => { let alive = true; setData(null); onReady(false); request(`/api/deals/${dealId}/receipt-info`).then(r => { if (alive) { setData(r); onReady(true); } }).catch(() => { if (alive) setError("פרטי המימוש אינם זמינים כרגע. נסו לרענן לפני ההצטרפות."); }); request(`/api/deals/${dealId}/public-names`).then(r => { if (alive) setNames(r.names); }).catch(() => undefined); return () => { alive = false; }; }, [dealId]);
  return <section className="panel" data-testid="receipt-before-join">
    <div className="panel-title">אם העסקה תושלם, תקבלו…</div>
    <p>{data?.label || error || "טוענים את פרטי המימוש…"}</p>
    {data?.seller ? <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <SellerIdentity seller={data.seller} compact />
      <p style={{ margin: "10px 0 0" }}><a href={`#/public-seller/${data.seller.id}`} data-testid="seller-profile-link">לפרופיל המוכר ולעסקאות נוספות ←</a></p>
    </div> : null}
    {names.length ? <p className="muted small" style={{ marginTop: 10 }}>בחרו לשתף שהצטרפו: {names.join(" · ")}</p> : null}
  </section>;
}
export function PublicSellerPage({ id }: { id: string }) {
  const [page, setPage] = useState(0);
  const [seller, setSeller] = useState<Json | null>(null), [error, setError] = useState("");
  useEffect(() => { let alive = true; setSeller(null); request(`/api/public-sellers/${id}?page=${page}`).then(r => { if (alive) setSeller(r.seller); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [id, page]);
  if (!seller) return <p role="status">{error || "טוענים פרופיל…"}</p>;
  return <>
    <section className="panel">
      <SellerIdentity seller={seller} />
      <p className="muted small" style={{ margin: "12px 0 0" }}>שיעור ההצלחה: עסקאות שהושלמו מתוך העסקאות שפורסמו והסתיימו, כולל כישלונות וביטולים.</p>
    </section>
    <div className="panel">
      <div className="panel-title">עסקאות המוכר</div>
      {seller.deals.length ? <div className="grid">{seller.deals.map((d: Json) => (
        <a className="card" key={d.deal_id} href={`#/deal/${d.deal_id}`} aria-label={String(d.title)}>
          <div className="card-body">
            <div className="card-head"><div className="card-title">{d.title}</div><StatusPill state={d.state} /></div>
            <div className="card-price-row"><span className="price">₪{Number(d.price_per_unit).toLocaleString("he-IL")}</span><span className="price-unit">ליחידה</span></div>
          </div>
        </a>
      ))}</div> : <p className="muted small">למוכר הזה עוד אין עסקאות שפורסמו.</p>}
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        {page > 0 ? <button className="btn btn-ghost btn-sm" onClick={() => setPage(page - 1)}>לעסקאות הקודמות</button> : null}
        {seller.has_more ? <button className="btn btn-ghost btn-sm" onClick={() => setPage(page + 1)}>לעסקאות נוספות</button> : null}
      </div>
    </div>
  </>;
}
export function BuyerEntitlement({ participantId, token, pickup }: { participantId: string; token: string; pickup?: Json }) {
  const [data, setData] = useState<Json | null>(null), [error, setError] = useState("");
  useEffect(() => { let active = true;
    const load = () => request(`/api/participants/${participantId}/entitlement`, { headers: { authorization: `Bearer ${token}` } }).then(r => { if (active) { setData(r); setError(""); } }).catch(e => { if (active) { setData(null); setError(e.message); } });
    void load(); const timer = window.setInterval(load, 20000); return () => { active = false; clearInterval(timer); };
  }, [participantId, token]);
  const receipt = data?.entitlement;
  return <section className="panel"><h2>המימוש שלי</h2>
    {error ? <p role="alert">{error}</p> : !data ? <p>טוענים…</p> : !receipt ? <p>פרטי המימוש יופיעו כאן אחרי שהעסקה תושלם והתשלום יאושר.</p> : <>
      {!data.configured && pickup?.applicable ? <PickupCard pickup={pickup} /> : <>
        <h3>{receipt.title} · {receipt.quantity} יחידות</h3><p>{receipt.status === "redeemed" ? "כבר מומש" : "זכאי למימוש"}</p>
        {receipt.method === "name_phone" ? <p>הציגו למוכר את השם והטלפון שמסרתם בהצטרפות.</p> : null}
        {receipt.status !== "redeemed" && receipt.method === "qr" && receipt.code ? <QrCode value={`${location.origin}/preview/#/seller/receipts?code=${encodeURIComponent(receipt.code)}`} size={200} label="קוד QR למימוש" /> : null}
        {receipt.code ? <p className="receipt-code" dir="ltr">{receipt.code}</p> : null}
        {receipt.url && receipt.status !== "redeemed" ? <a className="btn btn-primary" href={receipt.url} target="_blank" rel="noopener noreferrer">פתיחת הקישור שלי</a> : null}
        <p style={{ whiteSpace: "pre-wrap" }}>{receipt.instructions}</p>
      </>}
    </>}
    {/* ROUND 2 (UX-4) — a genuine opt-in: the SQUARE indicator says "this one
        is independent", and its inside fills with the canonical orange. */}
    {data ? <ChoiceCard mode="many" testId="public-name-opt-in" checked={!!data.public_name_opt_in}
      title="הציגו את שמי בין המצטרפים לעסקה (שם פרטי בלבד)"
      onSelect={async checked => { try { await request(`/api/participants/${participantId}/public-name`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ opt_in: checked }) }); setData({ ...data, public_name_opt_in: checked }); } catch (err: any) { setError(err.message); } }} /> : null}
  </section>;
}
export function SellerReceipts({ initialCode = "" }: { initialCode?: string }) {
  const [q, setQ] = useState(initialCode), [orders, setOrders] = useState<Json[]>([]), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null), scanner = useRef<ScannerHandle | null>(null);
  const search = async (query = q) => { setBusy(true); try { const r = await request(`/api/seller/receipts?q=${encodeURIComponent(query)}`, {}, "seller"); setOrders(r.orders); setMessage(r.orders.length ? "" : "לא נמצאה זכאות תקפה לחיפוש הזה"); } catch (e: any) { setOrders([]); setMessage(e.message); } finally { setBusy(false); } };
  useEffect(() => { void search(initialCode); return () => { scanner.current?.stop(); }; }, []);
  return <><h1>מימוש רכישות</h1><p>סרקו QR או חפשו לפי קוד, שם או טלפון. מוצגות רק רכישות ששולמו בעסקאות שלכם.</p>
    <form className="panel stack" onSubmit={e => { e.preventDefault(); void search(); }}><label>קוד, שם או טלפון<input value={q} onChange={e => setQ(e.target.value)} maxLength={150} /></label><button className="btn btn-primary" disabled={busy}>בדיקה</button></form>
    {cameraSupported().ok ? <button className="btn btn-ghost" onClick={async () => {
      if (scanning) { scanner.current?.stop(); setScanning(false); return; }
      try { scanner.current = await startPickupScanner({ video: video.current!, canvas: document.createElement("canvas"), decodeCode: raw => { const match = raw.match(/[A-F0-9]{4}(?:-[A-F0-9]{4}){7}/i); return match?.[0] || null; }, onCode: raw => { let code = raw; try { code = new URL(raw).hash.split("code=")[1] || raw; code = decodeURIComponent(code); } catch {} setQ(code); void search(code); scanner.current?.stop(); setScanning(false); }, onOutcome: outcome => { if (outcome === "scanning") { setScanning(true); return; } if (outcome === "starting" || outcome === "decoded") return; if (outcome === "stopped") { setScanning(false); return; } if (outcome === "not_our_code") { setMessage("לא זוהה קוד מימוש. אפשר להקליד את הקוד."); return; } setMessage("המצלמה אינה זמינה. אפשר להקליד את הקוד."); setScanning(false); } }); } catch { setMessage("המצלמה אינה זמינה. אפשר להקליד את הקוד."); }
    }}>{scanning ? "כיבוי מצלמה" : "סריקת QR"}</button> : null}
    <video ref={video} playsInline muted style={{ display: scanning ? "block" : "none", maxWidth: "100%" }} />
    <p role="status">{message}</p><div className="stack">{orders.map(o => <section className="panel" key={o.participant_id}>
      <h3>{o.name} · {o.title}</h3><p>{o.phone} · {o.quantity} יחידות · {o.status === "redeemed" ? "כבר מומש" : "תקף למימוש"}</p>
      {o.status !== "redeemed" ? <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await request(`/api/seller/receipts/${o.participant_id}/redeem`, { method: "POST", body: "{}" }, "seller"); await search(); setMessage("המימוש נרשם"); } catch (e: any) { setMessage(e.message); } finally { setBusy(false); } }}>אישור מימוש — {o.remaining_quantity} יחידות</button> : null}
    </section>)}</div></>;
}
async function upload(file: File, scope: "seller" | "admin") {
  const img = await optimizeImageFile(file);
  try { return await request(`/api/${scope}/content-assets`, { method: "POST", body: JSON.stringify({ filename: img.name, mime_type: img.mime, base64_data: img.b64 }) }, scope); }
  finally { URL.revokeObjectURL(img.previewUrl); }
}
export function PublicProfileEditor() {
  const [value, setValue] = useState<Json | null>(null), [message, setMessage] = useState("");
  useEffect(() => { request("/api/seller/public-profile", {}, "seller").then(r => setValue({ name: r.profile.name, about: r.profile.about, image_id: r.image_id, image: r.profile.image })).catch(e => setMessage(e.message)); }, []);
  return <section className="panel"><h2>הפרופיל הציבורי שלי</h2>{value ? <form className="stack" onSubmit={async e => { e.preventDefault(); try { await request("/api/seller/public-profile", { method: "PUT", body: JSON.stringify(value) }, "seller"); setMessage("הפרופיל נשמר"); } catch (e: any) { setMessage(e.message); } }}>
    <label>שם לתצוגה<input required maxLength={120} value={value.name} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
    <label>אודות<textarea rows={4} maxLength={1000} value={value.about} onChange={e => setValue({ ...value, about: e.target.value })} /></label>
    {value.image ? <img className="seller-avatar" src={value.image} alt="תמונת הפרופיל" /> : null}
    <label>לוגו העסק או תמונה אישית<input type="file" accept="image/png,image/jpeg,image/webp" onChange={async e => { if (!e.target.files?.[0]) return; try { const img = await upload(e.target.files[0], "seller"); setValue({ ...value, image_id: img.asset_id, image: img.url }); } catch (err: any) { setMessage(err.message); } }} /></label>
    <button className="btn btn-primary">שמירת הפרופיל</button>
  </form> : null}<p role="status">{message}</p></section>;
}
export function useSiteContent() {
  const [content, setContent] = useState<Json>({});
  useEffect(() => { let alive = true; const load = () => request("/api/site-content").then(r => { if (alive) setContent(r.content); }).catch(() => undefined); void load(); window.addEventListener("site-content-updated", load); return () => { alive = false; window.removeEventListener("site-content-updated", load); }; }, []);
  return content;
}
// ROUND 2 (UX-9) — the legal / content documents read as part of C-ton instead
// of as a bare dump: the Siton document shell (orange section markers, a
// measured line length, RTL-safe wrapping) plus a chip strip so a reader can
// move between the legal documents without returning to the footer. The ONE
// canonical source is unchanged — the CMS-backed /api/site-content projection
// of src/legal_pages.ts.
const LEGAL_NAV: [string, string][] = [
  ["legal_terms", "תקנון"],
  ["legal_privacy", "מדיניות פרטיות"],
  ["legal_refunds", "ביטולים והחזרים"],
  ["legal_payments", "מדיניות תשלומים"]
];
export function ContentPage({ section }: { section: string }) {
  const all = useSiteContent();
  const content = all[section];
  const blocks = String(content?.body || "").replace(/^# [^\n]+\r?\n/, "").trim().split(/\n\s*\n/);
  const isLegal = section.startsWith("legal_");
  return <>
    {isLegal ? <nav className="legal-nav" aria-label="מסמכים משפטיים">
      {LEGAL_NAV.filter(([key]) => all[key]).map(([key, label]) => (
        <a key={key} className={`chip${key === section ? " active" : ""}`} href={`#/content/${key}`} data-testid={`legal-nav-${key}`}>{label}</a>
      ))}
    </nav> : null}
    <article className="panel content-doc" data-testid="content-doc" data-section={section}>
      <h1>{content?.title || "טוענים…"}</h1>
      {blocks.map((block, i) => {
        if (/^#{1,3} /.test(block)) return <h2 key={i}>{block.replace(/^#{1,3} /, "")}</h2>;
        if (block.split("\n").every(line => line.startsWith("- "))) return <ul key={i}>{block.split("\n").map((line, j) => <li key={j}>{line.slice(2)}</li>)}</ul>;
        return <p key={i} style={{ whiteSpace: "pre-wrap" }}>{block}</p>;
      })}
    </article>
  </>;
}
export function ContentAdmin() {
  const [sections, setSections] = useState<Json>({}), [key, setKey] = useState("home"), [value, setValue] = useState<Json>({}), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { request("/api/admin/site-content", {}, "admin").then(r => { setSections(r.sections); setValue(r.sections.home.value); }).catch(e => setMessage(e.message)); }, []);
  const section = sections[key];
  return <><h1>ניהול תוכן האתר</h1><p>עדכון התוכן בתוך מבנה העמודים הקיים.</p>
    <label>עמוד או אזור<select value={key} disabled={busy} onChange={e => { setKey(e.target.value); setValue(sections[e.target.value].value); setMessage(""); }}>{Object.entries(sections).map(([k, s]) => <option value={k} key={k}>{s.label}</option>)}</select></label>
    {section ? <form className="panel stack" onSubmit={async e => { e.preventDefault(); setBusy(true); try { const r = await request(`/api/admin/site-content/${key}`, { method: "PUT", body: JSON.stringify({ value, revision: section.revision }) }, "admin"); setSections(r.sections); window.dispatchEvent(new Event("site-content-updated")); setMessage("התוכן נשמר ויוצג באתר"); } catch (e: any) { setMessage(e.status === 409 ? "התוכן עודכן בידי מנהל אחר. רעננו את העמוד לפני השמירה." : e.message); } finally { setBusy(false); } }}>
      {Object.entries(section.fields).map(([field, raw]) => { const f = raw as Json; return <label key={field}>{f.label}
        {f.image ? <><img src={value[field] || BRAND_LOGO_URL} alt="תמונה נוכחית" style={{ maxWidth: "100%", maxHeight: 220 }} /><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={async e => { if (!e.target.files?.[0]) return; setBusy(true); try { const img = await upload(e.target.files[0], "admin"); setValue(v => ({ ...v, [field]: img.url })); } catch (err: any) { setMessage(err.message); } finally { setBusy(false); } }} /></> : f.multiline ? <textarea rows={field === "body" ? 16 : 4} value={value[field] || ""} maxLength={f.max} onChange={e => setValue({ ...value, [field]: e.target.value })} /> : <input value={value[field] || ""} maxLength={f.max} onChange={e => setValue({ ...value, [field]: e.target.value })} />}
      </label>; })}
      <button className="btn btn-primary" disabled={busy}>שמירה</button><p className="muted small">{section.updated_at ? `עודכן: ${new Date(section.updated_at).toLocaleString("he-IL")}` : "התוכן המקורי של האתר"}</p>
    </form> : null}<p role="status">{message}</p></>;
}
