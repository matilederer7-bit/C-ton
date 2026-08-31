import { useEffect, useState, useCallback } from "react";
import { api, getSellerToken, setSellerToken, supabaseSignIn, type Json } from "./api";
import { ils, dealTypeLabel, statusView, deadlineView, num } from "./util";

// ---- tiny hash router ---------------------------------------------------
function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const parts = hash.replace(/^#\/?/, "").split("/");
  return { hash, seg: parts, go: (h: string) => { window.location.hash = h; } };
}

function Spinner({ label }: { label?: string }) {
  return <div className="center"><div><div className="spinner" style={{ margin: "0 auto 12px" }} />{label && <div className="muted">{label}</div>}</div></div>;
}

function DealCard({ d, go }: { d: Json; go: (h: string) => void }) {
  const s = statusView(String(d.state || d.canonical_state || ""));
  const joined = num(d.joined_units);
  const threshold = Math.max(1, num(d.threshold_units, 1));
  const pct = Math.max(0, Math.min(100, num(d.progress_to_target_pct, (joined / threshold) * 100)));
  const img = d.primary_image?.url || d.primary_thumbnail_url || "";
  return (
    <div className="card" onClick={() => go(`#/deal/${d.deal_id}`)} style={{ cursor: "pointer" }}>
      <div className="card-media">
        {img ? <img src={img} alt={d.title} loading="lazy" /> : <div className="placeholder">🛍️</div>}
        <span className="card-type">{dealTypeLabel(String(d.deal_type || "physical_product"))}</span>
      </div>
      <div className="card-body">
        <span className={`status ${s.cls}`} style={{ alignSelf: "flex-start" }}>{s.label}</span>
        <h3 className="card-title">{d.title}</h3>
        {d.description && <p className="card-desc">{d.description}</p>}
        <div className="progress"><span style={{ width: `${pct}%` }} /></div>
        <div className="progress-meta">
          <span>{joined} הצטרפו</span>
          <span>יעד {threshold}</span>
        </div>
        <div className="card-foot">
          <div className="price">{ils(num(d.price_per_unit))}<small> ליחידה</small></div>
          <span className="muted" style={{ fontSize: 13 }}>{deadlineView(d.deadline)}</span>
        </div>
      </div>
    </div>
  );
}

// ---- Mall ---------------------------------------------------------------
function Mall({ go }: { go: (h: string) => void }) {
  const [deals, setDeals] = useState<Json[] | null>(null);
  const [type, setType] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    setDeals(null); setErr("");
    api.mall({ type }).then((r) => setDeals(r.deals || [])).catch((e) => setErr(e.message));
  }, [type]);
  return (
    <div className="container">
      <div className="hero">
        <span className="staging-flag">סביבת הדגמה · נתוני בדיקה</span>
        <h1>קונים יחד, משלמים פחות.</h1>
        <p>מצטרפים לעסקה קבוצתית, וכשמגיעים ליעד — כולם מקבלים את המחיר. פשוט, שקוף והוגן.</p>
      </div>
      <div className="filters">
        {[["", "הכול"], ["physical_product", "מוצרים"], ["voucher", "שוברים"], ["ticket", "כרטיסים"]].map(([v, l]) => (
          <button key={v} className={`chip ${type === v ? "active" : ""}`} onClick={() => setType(v)}>{l}</button>
        ))}
      </div>
      {err && <div className="notice err" style={{ marginTop: 16 }}>{err}</div>}
      {!deals && !err && <div className="grid">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="card"><div className="card-media skeleton" /><div className="card-body"><div className="skeleton" style={{ height: 18, width: "70%" }} /><div className="skeleton" style={{ height: 14, width: "90%" }} /><div className="skeleton" style={{ height: 8 }} /></div></div>)}</div>}
      {deals && deals.length === 0 && !err && <div className="center"><div><div style={{ fontSize: 42 }}>🫙</div><div className="muted">אין עדיין עסקאות פעילות בקטגוריה הזו.</div></div></div>}
      {deals && deals.length > 0 && <div className="grid">{deals.map((d) => <DealCard key={d.deal_id} d={d} go={go} />)}</div>}
    </div>
  );
}

// ---- Deal detail + Join -------------------------------------------------
function JoinModal({ deal, onClose }: { deal: Json; onClose: () => void }) {
  const [form, setForm] = useState({ buyer_name: "", buyer_id: "", qty: 1, terms: false, disclosure: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Json | null>(null);
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    setErr("");
    if (!form.buyer_name.trim()) return setErr("נא למלא שם.");
    if (!/^0\d{8,9}$/.test(form.buyer_id.replace(/\D/g, ""))) return setErr("נא למלא מספר טלפון תקין.");
    if (!form.terms || !form.disclosure) return setErr("יש לאשר את התנאים כדי להצטרף.");
    setBusy(true);
    try {
      const r = await api.join(deal.deal_id, {
        buyer_id: form.buyer_id.replace(/\D/g, ""),
        buyer_name: form.buyer_name.trim(),
        qty: Number(form.qty) || 1,
        buyer_terms_accepted: true,
        payment_disclosure_accepted: true
      });
      setDone(r);
    } catch (e: any) { setErr(e.message || "ההצטרפות נכשלה."); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{done ? "הצטרפת לעסקה! 🎉" : "הצטרפות לעסקה"}</h3><button className="x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {done ? (
            <div className="stack">
              <div className="notice ok">נרשמת בהצלחה. שמרנו לך קוד מעקב אישי — רק דרכו אפשר לצפות בהשתתפות שלך.</div>
              <div className="field"><label>קוד מעקב אישי</label><input readOnly value={String(done.tracking_access_token || "").slice(0, 28) + "…"} /></div>
              <button className="btn btn-primary btn-block" onClick={onClose}>סגירה</button>
            </div>
          ) : (
            <div className="stack">
              <div className="notice info">אין צורך בהרשמה או בקוד אימות — פשוט מצטרפים. ההשתתפות מאובטחת דרך קוד מעקב שנוצר בשרת.</div>
              <div className="field"><label>שם מלא</label><input value={form.buyer_name} onChange={(e) => set("buyer_name", e.target.value)} placeholder="ישראל ישראלי" /></div>
              <div className="field"><label>טלפון</label><input value={form.buyer_id} onChange={(e) => set("buyer_id", e.target.value)} placeholder="05x-xxxxxxx" inputMode="tel" /></div>
              <div className="field"><label>כמות</label><input type="number" min={1} value={form.qty} onChange={(e) => set("qty", e.target.value)} /></div>
              <label className="check"><input type="checkbox" checked={form.terms} onChange={(e) => set("terms", e.target.checked)} /><span>אני מאשר/ת את תנאי העסקה הקבוצתית.</span></label>
              <label className="check"><input type="checkbox" checked={form.disclosure} onChange={(e) => set("disclosure", e.target.checked)} /><span>הבנתי שהחיוב יתבצע רק כאשר העסקה מגיעה ליעד.</span></label>
              {err && <div className="notice err">{err}</div>}
              <button className="btn btn-primary btn-block btn-lg" onClick={submit} disabled={busy}>{busy ? "מצטרפים…" : "הצטרפות לעסקה"}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DealDetail({ id, go }: { id: string; go: (h: string) => void }) {
  const [deal, setDeal] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [joining, setJoining] = useState(false);
  useEffect(() => {
    setDeal(null); setErr("");
    api.deal(id).then((r) => setDeal(r.deal || r)).catch((e) => setErr(e.status === 404 ? "העסקה לא נמצאה או אינה פומבית." : e.message));
  }, [id]);
  if (err) return <div className="container"><a className="back" onClick={() => go("#/")}>→ חזרה למול</a><div className="notice err">{err}</div></div>;
  if (!deal) return <Spinner label="טוען עסקה…" />;
  const s = statusView(String(deal.state || deal.canonical_state || ""));
  const joined = num(deal.joined_units);
  const threshold = Math.max(1, num(deal.threshold_units, 1));
  const pct = Math.max(0, Math.min(100, num(deal.progress_to_target_pct, (joined / threshold) * 100)));
  const img = deal.primary_image?.url || deal.primary_thumbnail_url || "";
  const canJoin = deal.availability?.can_join ?? ["PendingTarget", "TargetReached"].includes(String(deal.state));
  return (
    <div className="container">
      <a className="back" onClick={() => go("#/")}>→ חזרה למול</a>
      <div className="detail">
        <div className="detail-media">{img ? <img src={img} alt={deal.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div className="placeholder">🛍️</div>}</div>
        <div className="panel">
          <span className={`status ${s.cls}`}>{s.label}</span>
          <h1>{deal.title}</h1>
          <div className="seller-line">מאת {deal.seller?.business_name || deal.business_name || deal.seller_display_name || "מוכר סיטון"} · {dealTypeLabel(String(deal.deal_type || "physical_product"))}</div>
          {deal.description && <div className="desc-block">{deal.description}</div>}
          <div style={{ margin: "10px 0 16px" }}>
            <div className="progress"><span style={{ width: `${pct}%` }} /></div>
            <div className="progress-meta" style={{ marginTop: 6 }}><span>{joined} הצטרפו</span><span>יעד {threshold}</span></div>
          </div>
          <div className="kv"><span className="k">מחיר ליחידה</span><span className="v">{ils(num(deal.price_per_unit))}</span></div>
          <div className="kv"><span className="k">מצטרפים</span><span className="v">{joined}{deal.max_units ? ` / ${num(deal.max_units)}` : ""}</span></div>
          <div className="kv"><span className="k">מועד אחרון</span><span className="v">{deadlineView(deal.deadline) || "—"}</span></div>
          <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 18 }} disabled={!canJoin} onClick={() => setJoining(true)}>
            {canJoin ? "הצטרפות לעסקה" : "העסקה סגורה להצטרפות"}
          </button>
        </div>
      </div>
      {joining && <JoinModal deal={deal} onClose={() => { setJoining(false); api.deal(id).then((r) => setDeal(r.deal || r)).catch(() => {}); }} />}
    </div>
  );
}

// ---- Seller -------------------------------------------------------------
function SellerLogin({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      const cfg = await api.authConfig();
      if (!cfg.configured) throw new Error("התחברות מוכרים אינה מוגדרת בסביבה זו.");
      const token = await supabaseSignIn(cfg, email.trim(), password);
      setSellerToken(token);
      onAuthed();
    } catch (e: any) { setErr(e.message || "התחברות נכשלה."); }
    finally { setBusy(false); }
  };
  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>כניסת מוכרים</h1>
        <p className="muted" style={{ marginTop: -4, marginBottom: 16 }}>התחברות מאובטחת דרך זהות Supabase.</p>
        <div className="field"><label>אימייל</label><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="seller@example.com" dir="ltr" /></div>
        <div className="field"><label>סיסמה</label><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" dir="ltr" onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
        {err && <div className="notice err" style={{ marginBottom: 12 }}>{err}</div>}
        <button className="btn btn-primary btn-block btn-lg" onClick={submit} disabled={busy}>{busy ? "מתחבר…" : "התחברות"}</button>
      </div>
    </div>
  );
}

function CreateDealForm({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ title: "", description: "", price_per_unit: "", min_units: "5", max_units: "50", deal_type: "physical_product" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ t: string; k: string } | null>(null);
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));
  const submit = async () => {
    setMsg(null);
    if (!f.title.trim()) return setMsg({ t: "נא למלא כותרת.", k: "err" });
    if (!(Number(f.price_per_unit) > 0)) return setMsg({ t: "נא למלא מחיר תקין.", k: "err" });
    setBusy(true);
    try {
      const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
      await api.createDeal({
        title: f.title.trim(), description: f.description.trim(), deal_type: f.deal_type,
        price_per_unit: Number(f.price_per_unit), min_units: Number(f.min_units) || 5, max_units: Number(f.max_units) || 50,
        deadline, delivery_options: [{ option_type: "pickup", label: "איסוף עצמי", cost: 0 }],
        ...(f.deal_type === "voucher" ? { voucher_terms: { redemption_instructions: "מימוש בבית העסק", valid_until: deadline } } : {}),
        ...(f.deal_type === "ticket" ? { ticket_terms: { event_name: f.title.trim(), event_date: deadline, venue: "יוגדר" } } : {})
      });
      setMsg({ t: "הטיוטה נוצרה בהצלחה.", k: "ok" });
      setF({ title: "", description: "", price_per_unit: "", min_units: "5", max_units: "50", deal_type: "physical_product" });
      onCreated();
    } catch (e: any) { setMsg({ t: e.message || "יצירת הטיוטה נכשלה.", k: "err" }); }
    finally { setBusy(false); }
  };
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>עסקה חדשה</h3>
      <div className="field"><label>כותרת</label><input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="שם המוצר או השירות" /></div>
      <div className="field"><label>תיאור</label><textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={3} placeholder="פרטים על העסקה" /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field"><label>סוג</label><select value={f.deal_type} onChange={(e) => set("deal_type", e.target.value)}><option value="physical_product">מוצר</option><option value="voucher">שובר</option><option value="ticket">כרטיס</option></select></div>
        <div className="field"><label>מחיר ליחידה (₪)</label><input value={f.price_per_unit} onChange={(e) => set("price_per_unit", e.target.value)} inputMode="numeric" placeholder="0" /></div>
        <div className="field"><label>יעד מינימלי</label><input value={f.min_units} onChange={(e) => set("min_units", e.target.value)} inputMode="numeric" /></div>
        <div className="field"><label>מקסימום יחידות</label><input value={f.max_units} onChange={(e) => set("max_units", e.target.value)} inputMode="numeric" /></div>
      </div>
      {msg && <div className={`notice ${msg.k}`} style={{ marginBottom: 12 }}>{msg.t}</div>}
      <button className="btn btn-primary btn-block" onClick={submit} disabled={busy}>{busy ? "יוצר…" : "יצירת טיוטה"}</button>
    </div>
  );
}

function SellerDashboard({ onLogout }: { onLogout: () => void }) {
  const [ctx, setCtx] = useState<Json | null>(null);
  const [deals, setDeals] = useState<Json[] | null>(null);
  const [err, setErr] = useState("");
  const [publishing, setPublishing] = useState("");
  const load = useCallback(() => {
    setErr("");
    api.sellerContext().then(setCtx).catch((e) => { if (e.status === 401) onLogout(); else setErr(e.message); });
    api.sellerDeals().then((r) => setDeals(r.deals || [])).catch((e) => { if (e.status === 401) onLogout(); else setErr(e.message); });
  }, [onLogout]);
  useEffect(load, [load]);
  const publish = async (id: string) => {
    setPublishing(id); setErr("");
    try { await api.publishDeal(id); load(); } catch (e: any) { setErr(e.message || "הפרסום נכשל."); } finally { setPublishing(""); }
  };
  return (
    <div className="container">
      <div className="dash-head">
        <div><h1 style={{ margin: 0 }}>לוח המוכר</h1><div className="muted">{ctx?.seller_auth?.seller?.business_name || ctx?.seller?.business_name || "מחובר"}</div></div>
        <button className="btn btn-ghost" onClick={onLogout}>יציאה</button>
      </div>
      {err && <div className="notice err" style={{ margin: "12px 0" }}>{err}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20, marginTop: 14 }}>
        <CreateDealForm onCreated={load} />
        <div>
          <div className="section-title">העסקאות שלי</div>
          {!deals && <Spinner label="טוען…" />}
          {deals && deals.length === 0 && <div className="muted" style={{ padding: "18px 2px" }}>עוד אין עסקאות. צור/י טיוטה ראשונה למעלה.</div>}
          <div className="stack" style={{ marginTop: 10 }}>
            {deals?.map((d) => {
              const s = statusView(String(d.state));
              return (
                <div key={d.deal_id} className="deal-row">
                  <div className="thumb">{d.primary_image?.url ? <img src={d.primary_image.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "🛍️"}</div>
                  <div className="grow">
                    <div className="t">{d.title}</div>
                    <div className="muted" style={{ fontSize: 13 }}><span className={`status ${s.cls}`}>{s.label}</span> · {ils(num(d.price_per_unit))}</div>
                  </div>
                  <div className="row-actions">
                    {String(d.state) === "Draft"
                      ? <button className="btn btn-primary" onClick={() => publish(d.deal_id)} disabled={publishing === d.deal_id}>{publishing === d.deal_id ? "מפרסם…" : "פרסום"}</button>
                      : <a className="btn btn-ghost" href={`#/deal/${d.deal_id}`}>צפייה</a>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Seller() {
  const [authed, setAuthed] = useState(() => Boolean(getSellerToken()));
  if (!authed) return <SellerLogin onAuthed={() => setAuthed(true)} />;
  return <SellerDashboard onLogout={() => { setSellerToken(""); setAuthed(false); }} />;
}

// ---- Root ---------------------------------------------------------------
export function App() {
  const { seg, go } = useRoute();
  const page = seg[0] || "";
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/"><span className="brand-mark">ס</span><span>סיטון<span className="brand-sub"> · קבוצות קנייה</span></span></a>
          <div className="topbar-spacer" />
          <a className={`nav-link ${page === "" || page === "deal" ? "active" : ""}`} href="#/">המול</a>
          <a className={`nav-link ${page === "seller" ? "active" : ""}`} href="#/seller">מוכרים</a>
        </div>
      </header>
      <main style={{ flex: 1 }}>
        {page === "" && <Mall go={go} />}
        {page === "deal" && <DealDetail id={seg[1]} go={go} />}
        {page === "seller" && <Seller />}
      </main>
      <footer className="footer">סיטון · סביבת הדגמה (Staging). הנתונים לבדיקה בלבד ואינם מייצגים עסקאות אמיתיות.</footer>
    </div>
  );
}
