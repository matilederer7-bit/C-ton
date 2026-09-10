import React, { useEffect, useRef, useState } from "react";
import { productRequest as request, type Json } from "./api";
import { QrCode } from "./qrcode";
import { PickupCard } from "./pickupCard";
import { optimizeImageFile } from "./images";
import { StatusPill } from "./components";
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
export function ReceiptFields({ value, onChange, disabled = false }: { value: ReceiptConfig; onChange: (v: ReceiptConfig) => void; disabled?: boolean }) {
  return <fieldset className="receipt-fields" disabled={disabled}>
    <legend>איך הקונה יקבל את מה ששילם עליו?</legend>
    {OPTIONS.map(([key, title, help]) => <label key={key} className="receipt-option">
      <input type="radio" name="receipt-method" checked={value.method === key} onChange={() => onChange({ ...value, method: key! })} />
      <span><b>{title}</b><span className="muted small" style={{ display: "block" }}>{help}</span></span>
    </label>)}
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
function SellerIdentity({ seller, compact = false }: { seller: Json; compact?: boolean }) {
  return <><div className="row">{seller.image ? <img className="seller-avatar" src={seller.image} alt={seller.name} /> : null}<h2>{seller.name}</h2></div>
    {seller.about ? <p style={{ whiteSpace: "pre-wrap" }}>{compact && seller.about.length > 140 ? `${seller.about.slice(0, 140)}…` : seller.about}</p> : null}
    <p>{seller.stats.published} עסקאות שפורסמו · {seller.stats.completed} הושלמו בהצלחה{seller.stats.success_rate !== null ? ` · ${seller.stats.success_rate}% הצלחה` : ""}</p>
  </>;
}
export function DealReceiptInfo({ dealId, onReady }: { dealId: string; onReady: (ready: boolean) => void }) {
  const [data, setData] = useState<Json | null>(null), [names, setNames] = useState<string[]>([]), [error, setError] = useState("");
  useEffect(() => { let alive = true; setData(null); onReady(false); request(`/api/deals/${dealId}/receipt-info`).then(r => { if (alive) { setData(r); onReady(true); } }).catch(() => { if (alive) setError("פרטי המימוש אינם זמינים כרגע. נסו לרענן לפני ההצטרפות."); }); request(`/api/deals/${dealId}/public-names`).then(r => { if (alive) setNames(r.names); }).catch(() => undefined); return () => { alive = false; }; }, [dealId]);
  return <section className="panel" data-testid="receipt-before-join"><h3>אם העסקה תושלם, תקבלו…</h3>
    <p>{data?.label || error || "טוענים את פרטי המימוש…"}</p>
    {data?.seller ? <><SellerIdentity seller={data.seller} compact /><a href={`#/public-seller/${data.seller.id}`}>צפו בפרופיל המוכר</a></> : null}
    {names.length ? <p className="muted small">בחרו לשתף שהצטרפו: {names.join(" · ")}</p> : null}
  </section>;
}
export function PublicSellerPage({ id }: { id: string }) {
  const [page, setPage] = useState(0);
  const [seller, setSeller] = useState<Json | null>(null), [error, setError] = useState("");
  useEffect(() => { let alive = true; setSeller(null); request(`/api/public-sellers/${id}?page=${page}`).then(r => { if (alive) setSeller(r.seller); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [id, page]);
  if (!seller) return <p role="status">{error || "טוענים פרופיל…"}</p>;
  return <><section className="panel"><SellerIdentity seller={seller} /><p className="muted small">שיעור ההצלחה: עסקאות שהושלמו מתוך העסקאות שפורסמו והסתיימו, כולל כישלונות וביטולים.</p></section>
    <h2>עסקאות המוכר</h2><div className="grid">{seller.deals.map((d: Json) => <a className="panel" key={d.deal_id} href={`#/deal/${d.deal_id}`}><h3>{d.title}</h3><StatusPill state={d.state} /><p>₪{Number(d.price_per_unit).toLocaleString("he-IL")}</p></a>)}</div>
    <div className="row">{page > 0 ? <button className="btn btn-ghost" onClick={() => setPage(page - 1)}>לעסקאות הקודמות</button> : null}{seller.has_more ? <button className="btn btn-ghost" onClick={() => setPage(page + 1)}>לעסקאות נוספות</button> : null}</div>
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
    {data ? <label className="receipt-option"><input type="checkbox" checked={!!data.public_name_opt_in} onChange={async e => { const checked = e.target.checked; try { await request(`/api/participants/${participantId}/public-name`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ opt_in: checked }) }); setData({ ...data, public_name_opt_in: checked }); } catch (err: any) { setError(err.message); } }} />הציגו את שמי בין המצטרפים לעסקה (שם פרטי בלבד)</label> : null}
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
export function ContentPage({ section }: { section: string }) {
  const content = useSiteContent()[section];
  const blocks = String(content?.body || "").replace(/^# [^\n]+\r?\n/, "").trim().split(/\n\s*\n/);
  return <article className="panel"><h1>{content?.title || "טוענים…"}</h1>{blocks.map((block, i) => {
    if (/^#{1,3} /.test(block)) return <h2 key={i}>{block.replace(/^#{1,3} /, "")}</h2>;
    if (block.split("\n").every(line => line.startsWith("- "))) return <ul key={i}>{block.split("\n").map((line, j) => <li key={j}>{line.slice(2)}</li>)}</ul>;
    return <p key={i} style={{ whiteSpace: "pre-wrap" }}>{block}</p>;
  })}</article>;
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
