// ── SELLER DISTRIBUTION HUB (attribution + analytics only) ──────────────────
// A seller mints several distribution links for the same deal and measures
// each one separately. Nothing here is money authority: Siton computes no
// commission and manages no settlement between a seller and a link holder.
//
// Three surfaces share ONE metrics renderer so the seller and the external
// viewer read the same numbers:
//   * DistributionPanel      — embedded in the seller's deal screen
//   * SellerLinkDashboardPage — the per-link mini dashboard (seller)
//   * LinkViewerPage         — the scoped external dashboard (#/link-dashboard)
import React, { useEffect, useMemo, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, EmptyState, StatTile, Toast, copyText, useToast } from "../components";
import { fmtDate, ils, num, pct } from "../util";
import { BarChart } from "./sellerCommand";

type Range = "24h" | "7d" | "30d" | "all";
const RANGES: Array<{ key: Range; label: string }> = [
  { key: "24h", label: "24 שעות" },
  { key: "7d", label: "7 ימים" },
  { key: "30d", label: "30 ימים" },
  { key: "all", label: "כל התקופה" }
];

type MetricKey = "entries" | "unique_visitors" | "joins" | "joined_units" | "charged_units" | "attributed_gross";
const METRICS: Array<{ key: MetricKey; label: string; money?: boolean }> = [
  { key: "entries", label: "כניסות" },
  { key: "unique_visitors", label: "מבקרים ייחודיים" },
  { key: "joins", label: "הצטרפויות" },
  { key: "joined_units", label: "יחידות שהצטרפו" },
  { key: "charged_units", label: "יחידות שחויבו סופית" },
  { key: "attributed_gross", label: "ברוטו מיוחס", money: true }
];

const CHANNEL_SUGGESTIONS = ["whatsapp", "facebook", "instagram", "telegram", "newsletter", "sms", "influencer", "paid", "other"];
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "וואטסאפ", facebook: "פייסבוק", instagram: "אינסטגרם", telegram: "טלגרם", newsletter: "ניוזלטר",
  sms: "SMS", influencer: "משפיען/ית", paid: "קמפיין ממומן", other: "אחר"
};
function channelLabel(channel: unknown): string {
  const raw = String(channel || "").trim();
  return raw ? (CHANNEL_LABELS[raw.toLowerCase()] || raw) : "—";
}

export function absoluteLinkUrl(shareUrl: string): string {
  return `${window.location.origin}${shareUrl}`;
}

function absoluteLoginUrl(loginPath: string): string {
  return `${window.location.origin}${loginPath || "/preview/#/link-dashboard"}`;
}

// ── shared metrics renderer ─────────────────────────────────────────────────

export function LinkMetricTiles({ metrics, compact }: { metrics: Json; compact?: boolean }) {
  const m = metrics || {};
  return (
    <div className="stat-row" style={{ marginBottom: compact ? 0 : 12 }} data-testid="link-metric-tiles">
      <StatTile num={num(m.entries)} label="כניסות" />
      <StatTile num={num(m.unique_visitors)} label="מבקרים ייחודיים" />
      <StatTile num={num(m.joins)} label="הצטרפויות" sub="התחייבות של קונה — עדיין לא מכירה" />
      <StatTile num={num(m.joined_units)} label="יחידות שהצטרפו" />
      <StatTile num={num(m.charged_units)} label="יחידות שחויבו סופית" tone="good" />
      <StatTile num={ils(m.attributed_gross)} label="ברוטו מיוחס (נגבה בפועל)" tone="good" />
      <StatTile num={pct(m.conversion_entry_to_join)} label="המרה: כניסה → הצטרפות" />
      <StatTile num={pct(m.conversion_entry_to_final_charge)} label="המרה: כניסה → חיוב סופי" />
    </div>
  );
}

function bucketLabel(iso: string, bucket: string): string {
  const d = new Date(iso);
  if (bucket === "hour") return `${String(d.getHours()).padStart(2, "0")}:00`;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function LinkTimeChart({ series, range, onRange, metric, onMetric }: {
  series: Json | null;
  range: Range;
  onRange: (r: Range) => void;
  metric: MetricKey;
  onMetric: (m: MetricKey) => void;
}) {
  const def = METRICS.find((m) => m.key === metric) || METRICS[0]!;
  const points = ((series?.points as Json[]) || []).map((p) => ({ day: bucketLabel(String(p.t), String(series?.bucket || "day")), value: Number(p[metric] || 0) }));
  const total = points.reduce((s, p) => s + p.value, 0);
  return (
    <div className="panel" data-testid="link-time-chart">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>לאורך זמן</div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="טווח זמן">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={`chip${range === r.key ? " active" : ""}`} data-testid={`range-${r.key}`} onClick={() => onRange(r.key)}>{r.label}</button>
          ))}
        </div>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "10px 0" }} role="group" aria-label="מדד">
        {METRICS.map((m) => (
          <button key={m.key} type="button" className={`chip${metric === m.key ? " active" : ""}`} data-testid={`metric-${m.key}`} onClick={() => onMetric(m.key)}>{m.label}</button>
        ))}
      </div>
      <div className="chart-box">
        <div className="chart-title">{def.label} · {series?.bucket === "hour" ? "לפי שעה" : "לפי יום"} · סה״כ בטווח: {def.money ? ils(total) : num(total)}</div>
        {points.length ? (
          <BarChart points={points} color={def.key === "charged_units" || def.key === "attributed_gross" ? "var(--success)" : "var(--brand)"} height={90} formatValue={def.money ? (v) => ils(v) : undefined} />
        ) : <p className="muted small chart-empty">אין עדיין נתונים בטווח שנבחר.</p>}
      </div>
    </div>
  );
}

export function DistributionDisclaimer({ text }: { text?: string }) {
  return (
    <p className="muted small" data-testid="distribution-disclaimer" style={{ marginTop: 10 }}>
      {text || "הנתונים המוצגים הם נתוני מדידה וייחוס בלבד. סיטון אינה מחשבת או מנהלת עמלה או התחשבנות בין המוכר לבעל הלינק."}
    </p>
  );
}

function shareViaWhatsApp(url: string, title: string) {
  const text = `${title}\n${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}

async function nativeOrCopy(url: string, title: string, notify: (m: string) => void) {
  const nav: any = typeof navigator !== "undefined" ? navigator : null;
  if (nav?.share) {
    try { await nav.share({ title, url }); return; } catch { /* user dismissed — fall back to copy */ }
  }
  if (await copyText(url)) notify("הקישור הועתק");
  else notify("ההעתקה נכשלה — סמנו את הקישור והעתיקו ידנית");
}

// ── seller: panel inside the deal screen ────────────────────────────────────

type SortKey = "created_at" | "entries" | "unique_visitors" | "joins" | "joined_units" | "charged_units" | "attributed_gross" | "conversion_entry_to_join" | "conversion_entry_to_final_charge";

export function DistributionPanel({ dealId, dealTitle, dealOpen, navigate }: { dealId: string; dealTitle: string; dealOpen: boolean; navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "created_at", dir: "desc" });
  const [toast, showToast] = useToast();

  const load = () => api.sellerDistribution(dealId).then((p) => { setPayload(p); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id); }, [dealId]);

  const links: Json[] = useMemo(() => {
    const rows = [...((payload?.links as Json[]) || [])];
    const dir = sort.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = sort.key === "created_at" ? Date.parse(String(a.created_at)) : Number(a.metrics?.[sort.key] || 0);
      const bv = sort.key === "created_at" ? Date.parse(String(b.created_at)) : Number(b.metrics?.[sort.key] || 0);
      return (av - bv) * dir;
    });
    return rows;
  }, [payload, sort]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === "desc" ? " ▼" : " ▲") : "");

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const internalName = name.trim();
    if (!internalName) { setFormError("יש לתת ללינק שם פנימי"); return; }
    setBusy(true); setFormError("");
    try {
      await api.createDistributionLink(dealId, { internal_name: internalName, channel: channel.trim() || undefined });
      setName(""); setChannel(""); setCreating(false);
      showToast("הלינק נוצר — אפשר להעתיק ולשתף");
      await load();
    } catch (err: any) {
      const code = String(err?.body?.code || err?.body?.error || "");
      setFormError(
        code === "distribution_link_deal_not_open" ? "אפשר ליצור לינקים רק לעסקה שפורסמה ופתוחה להצטרפות"
          : err?.status === 409 ? "כבר קיים לינק עם השם הזה לעסקה"
            : String(err?.message || "יצירת הלינק נכשלה")
      );
    }
    setBusy(false);
  };

  const patch = async (link: Json, body: Json, okMsg: string) => {
    try {
      await api.updateDistributionLink(dealId, String(link.link_id), body);
      showToast(okMsg);
      await load();
    } catch (err: any) { showToast(err?.status === 409 ? "כבר קיים לינק עם השם הזה" : String(err?.message || "העדכון נכשל")); }
  };

  if (error) return <div className="panel"><div className="panel-title">הפצה ומדידה</div><p className="muted small">{error}</p></div>;
  if (!payload) return <div className="panel"><div className="panel-title">הפצה ומדידה</div><BrandLoader label="טוענים לינקי הפצה…" minHeight={120} /></div>;

  const totals = payload.totals || {};
  const hasLinks = links.length > 0;

  return (
    <div className="panel" data-testid="distribution-panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>הפצה ומדידה — לינקים לעסקה</div>
        {hasLinks && dealOpen ? (
          <button type="button" className="btn btn-sm btn-primary" data-testid="distribution-create-open" onClick={() => setCreating((v) => !v)}>+ לינק הפצה חדש</button>
        ) : null}
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        כל לינק מודד בנפרד מה הוא הביא: כניסות, הצטרפויות, יחידות שחויבו סופית וברוטו שנגבה בפועל. הקונה רואה תמיד את אותו דף עסקה — המדידה נעשית מאחורי הקלעים.
        כלל הייחוס: {String(payload.attribution_rule?.description_he || "הלינק האחרון שהקונה נכנס דרכו לפני ההצטרפות.")}
      </p>

      {!hasLinks && !creating ? (
        <EmptyState
          icon="🔗"
          title="עדיין לא יצרת לינקי הפצה"
          body={dealOpen ? "צרו לינק לכל ערוץ (קבוצת וואטסאפ, קמפיין, משפיען) ותראו בדיוק מה כל אחד הביא." : "לינקים חדשים אפשר ליצור רק בזמן שהעסקה פתוחה להצטרפות."}
          action={dealOpen ? <button type="button" className="btn btn-primary" data-testid="distribution-create-first" onClick={() => setCreating(true)}>צור לינק ראשון</button> : undefined}
        />
      ) : null}

      {creating ? (
        <form onSubmit={create} className="panel" style={{ marginTop: 12 }} data-testid="distribution-create-form">
          <div className="field-row">
            <div className="field">
              <label htmlFor="dist-link-name">שם פנימי <span className="hint">(רק אתם רואים אותו)</span></label>
              <input id="dist-link-name" data-testid="distribution-link-name" value={name} maxLength={80} placeholder="למשל: WhatsApp קבוצה א / משפיען יוסי" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dist-link-channel">ערוץ / מקור <span className="hint">(אופציונלי)</span></label>
              <input id="dist-link-channel" data-testid="distribution-link-channel" list="dist-channel-options" value={channel} maxLength={40} placeholder="whatsapp, facebook, newsletter…" onChange={(e) => setChannel(e.target.value)} />
              <datalist id="dist-channel-options">{CHANNEL_SUGGESTIONS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}</datalist>
            </div>
          </div>
          {formError ? <p className="field-error">{formError}</p> : null}
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary" data-testid="distribution-create-submit" disabled={busy}>{busy ? "יוצרים…" : "צור לינק"}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setCreating(false); setFormError(""); }}>ביטול</button>
          </div>
        </form>
      ) : null}

      {hasLinks ? (
        <>
          <div className="stat-row" style={{ margin: "12px 0 8px" }} data-testid="distribution-totals">
            <StatTile num={num(totals.entries)} label="כניסות (כל הלינקים)" />
            <StatTile num={num(totals.joins)} label="הצטרפויות" />
            <StatTile num={num(totals.charged_units)} label="יחידות שחויבו סופית" tone="good" />
            <StatTile num={ils(totals.attributed_gross)} label="ברוטו מיוחס" tone="good" />
          </div>
          <div className="table-wrap">
            <table className="data" data-testid="distribution-links-table">
              <thead>
                <tr>
                  <th>שם</th>
                  <th>ערוץ</th>
                  <th>סטטוס</th>
                  <th className="num clickable" onClick={() => toggleSort("entries")}>כניסות{sortMark("entries")}</th>
                  <th className="num clickable" onClick={() => toggleSort("joins")}>הצטרפויות{sortMark("joins")}</th>
                  <th className="num clickable" onClick={() => toggleSort("joined_units")}>יחידות{sortMark("joined_units")}</th>
                  <th className="num clickable" onClick={() => toggleSort("charged_units")}>חויבו סופית{sortMark("charged_units")}</th>
                  <th className="num clickable" onClick={() => toggleSort("attributed_gross")}>ברוטו מיוחס{sortMark("attributed_gross")}</th>
                  <th className="num clickable" onClick={() => toggleSort("conversion_entry_to_join")}>המרה{sortMark("conversion_entry_to_join")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map((link) => {
                  const m = link.metrics || {};
                  const url = absoluteLinkUrl(String(link.share_url));
                  const disabled = link.status === "disabled";
                  return (
                    <tr key={String(link.link_id)} data-testid="distribution-link-row">
                      <td>
                        {renaming && renaming.id === link.link_id ? (
                          <form onSubmit={async (e) => { e.preventDefault(); const value = String(renaming?.value || "").trim(); setRenaming(null); if (value && value !== link.internal_name) await patch(link, { internal_name: value }, "השם עודכן"); }} className="row" style={{ gap: 6 }}>
                            <input autoFocus value={renaming.value} maxLength={80} onChange={(e) => setRenaming({ id: String(link.link_id), value: e.target.value })} data-testid="distribution-rename-input" />
                            <button type="submit" className="btn btn-sm btn-primary">שמירה</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>ביטול</button>
                          </form>
                        ) : (
                          <>
                            <b>{link.internal_name}</b>
                            <div className="muted small" dir="ltr" style={{ textAlign: "end" }}>{url}</div>
                            {link.external_access?.enabled ? <span className="channel-chip">גישה חיצונית פעילה</span> : null}
                          </>
                        )}
                      </td>
                      <td>{channelLabel(link.channel)}</td>
                      <td><span className={`status ${disabled ? "Cancelled" : "TargetReached"}`}>{disabled ? "מושבת" : "פעיל"}</span></td>
                      <td className="num">{num(m.entries)}</td>
                      <td className="num">{num(m.joins)}</td>
                      <td className="num">{num(m.joined_units)}</td>
                      <td className="num">{num(m.charged_units)}</td>
                      <td className="num">{ils(m.attributed_gross)}</td>
                      <td className="num">{pct(m.conversion_entry_to_join)}</td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-copy" onClick={async () => { if (await copyText(url)) showToast("הקישור הועתק"); else showToast("ההעתקה נכשלה"); }}>העתק</button>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-share" onClick={() => nativeOrCopy(url, dealTitle, showToast)}>שתף</button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => shareViaWhatsApp(url, dealTitle)}>וואטסאפ</button>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-rename" onClick={() => setRenaming({ id: String(link.link_id), value: String(link.internal_name) })}>שנה שם</button>
                          <button type="button" className="btn btn-sm btn-primary" data-testid="distribution-open-dashboard" onClick={() => navigate(`#/seller/deal/${dealId}/distribution/${link.link_id}`)}>ביצועים</button>
                          <button type="button" className={`btn btn-sm ${disabled ? "btn-ghost" : "btn-danger-ghost"}`} data-testid="distribution-toggle" onClick={() => patch(link, { status: disabled ? "active" : "disabled" }, disabled ? "הלינק הופעל מחדש" : "הלינק הושבת — ההיסטוריה נשמרת")}>{disabled ? "הפעל" : "השבת"}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <DistributionDisclaimer text={payload.disclaimer_he} />
        </>
      ) : null}
      <Toast msg={toast} />
    </div>
  );
}

// ── seller: per-link mini dashboard ─────────────────────────────────────────

function ExternalAccessPanel({ dealId, link, loginPath, onChanged, notify }: { dealId: string; link: Json; loginPath: string; onChanged: () => Promise<void>; notify: (m: string) => void }) {
  const access = link.external_access || {};
  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState<Json | null>(null);
  const loginUrl = absoluteLoginUrl(String(access.login_path || loginPath));

  const act = async (action: "enable" | "disable" | "reset_password") => {
    if (busy) return;
    if (action === "disable" && !window.confirm("לבטל את הגישה החיצונית? הלינק והמדידה נשארים; רק זכות הצפייה מתבטלת.")) return;
    if (action === "reset_password" && !window.confirm("לאפס את הסיסמה? הסיסמה הנוכחית תפסיק לעבוד וכל ההתחברויות הפעילות ינותקו.")) return;
    setBusy(true);
    try {
      const res = await api.distributionExternalAccess(dealId, String(link.link_id), action);
      setCredentials(res.credentials || null);
      notify(action === "enable" ? "הגישה החיצונית הופעלה" : action === "disable" ? "הגישה החיצונית בוטלה" : "הסיסמה אופסה");
      await onChanged();
    } catch (err: any) { notify(String(err?.message || "הפעולה נכשלה")); }
    setBusy(false);
  };

  return (
    <div className="panel" data-testid="external-access-panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>גישה חיצונית לדשבורד הלינק</div>
        <span className={`status ${access.enabled ? "TargetReached" : "ClosedForJoining"}`} data-testid="external-access-status">{access.enabled ? "פעילה" : "כבויה"}</span>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        אפשר לתת לאדם חיצוני (למשל מי שמפיץ עבורכם) להיכנס בשם משתמש וסיסמה ולראות רק את המדדים המצרפיים של הלינק הזה: בלי שמות, טלפונים, פרטי קונים או עסקאות אחרות. צפייה בלבד.
      </p>
      {access.enabled ? (
        <div className="kv" style={{ margin: "10px 0" }}>
          <span className="k">שם משתמש</span><span className="v" dir="ltr" data-testid="external-access-username">{access.username}</span>
          <span className="k">כתובת כניסה</span><span className="v" dir="ltr">{loginUrl}</span>
          <span className="k">נוצר בתאריך</span><span className="v">{fmtDate(access.created_at)}</span>
          <span className="k">כניסה אחרונה</span><span className="v">{access.last_login_at ? fmtDate(access.last_login_at) : "עדיין לא נכנס/ה"}</span>
        </div>
      ) : null}
      {credentials ? (
        <div className="panel" style={{ margin: "10px 0", borderColor: "var(--brand)" }} data-testid="external-access-credentials">
          <b>פרטי הכניסה — מוצגים פעם אחת בלבד</b>
          <div className="kv" style={{ marginTop: 8 }}>
            <span className="k">כתובת</span><span className="v" dir="ltr">{absoluteLoginUrl(String(credentials.login_path || loginPath))}</span>
            <span className="k">שם משתמש</span><span className="v" dir="ltr">{credentials.username}</span>
            <span className="k">סיסמה</span><span className="v" dir="ltr" data-testid="external-access-password">{credentials.password}</span>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={async () => { const text = `כניסה לדשבורד הלינק:\n${absoluteLoginUrl(String(credentials.login_path || loginPath))}\nשם משתמש: ${credentials.username}\nסיסמה: ${credentials.password}`; if (await copyText(text)) notify("פרטי הכניסה הועתקו"); }}>העתק פרטי כניסה</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCredentials(null)}>הסתר</button>
          </div>
        </div>
      ) : null}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {access.enabled ? (
          <>
            <button type="button" className="btn btn-sm btn-ghost" data-testid="external-access-copy-url" onClick={async () => { if (await copyText(loginUrl)) notify("כתובת הכניסה הועתקה"); }}>העתק כתובת כניסה</button>
            <button type="button" className="btn btn-sm btn-ghost" data-testid="external-access-reset" disabled={busy} onClick={() => act("reset_password")}>אפס סיסמה</button>
            <button type="button" className="btn btn-sm btn-danger-ghost" data-testid="external-access-disable" disabled={busy} onClick={() => act("disable")}>בטל גישה</button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" data-testid="external-access-enable" disabled={busy} onClick={() => act("enable")}>הפעל גישה וצור פרטי כניסה</button>
        )}
      </div>
    </div>
  );
}

export function SellerLinkDashboardPage({ dealId, linkId, navigate }: { dealId: string; linkId: string; navigate: (h: string) => void }) {
  const [range, setRange] = useState<Range>("7d");
  const [metric, setMetric] = useState<MetricKey>("entries");
  const [payload, setPayload] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [toast, showToast] = useToast();

  const load = () => api.sellerDistributionLink(dealId, linkId, range).then((p) => { setPayload(p); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id); }, [dealId, linkId, range]);

  const back = <a className="back" href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>→ לעסקה</a>;
  if (error) return <>{back}<EmptyState icon="⚠️" title="לא ניתן לטעון את דשבורד הלינק" body={error} /></>;
  if (!payload) return <>{back}<BrandLoader label="טוענים את דשבורד הלינק…" minHeight={320} /></>;

  const link = payload.link || {};
  const url = absoluteLinkUrl(String(link.share_url || ""));
  const disabled = link.status === "disabled";
  return (
    <>
      {back}
      <div className="panel" data-testid="seller-link-dashboard">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="muted small">{payload.deal?.title}</div>
            <h2 style={{ margin: "2px 0 0" }} data-testid="seller-link-dashboard-name">{link.internal_name}</h2>
            <div className="muted small">ערוץ: {channelLabel(link.channel)} · נוצר {fmtDate(link.created_at)}</div>
          </div>
          <span className={`status ${disabled ? "Cancelled" : "TargetReached"}`}>{disabled ? "מושבת" : "פעיל"}</span>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
          <span className="muted small" dir="ltr">{url}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { if (await copyText(url)) showToast("הקישור הועתק"); }}>העתק</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => nativeOrCopy(url, String(payload.deal?.title || ""), showToast)}>שתף</button>
        </div>
        <div className="section-title" style={{ margin: "6px 0 8px" }}>סה״כ מאז יצירת הלינק</div>
        <LinkMetricTiles metrics={link.metrics} />
        <div className="section-title" style={{ margin: "6px 0 8px" }}>בטווח שנבחר ({RANGES.find((r) => r.key === range)?.label})</div>
        <LinkMetricTiles metrics={payload.window} compact />
        <DistributionDisclaimer text={payload.disclaimer_he} />
      </div>
      <LinkTimeChart series={payload.series} range={range} onRange={setRange} metric={metric} onMetric={setMetric} />
      <ExternalAccessPanel dealId={dealId} link={link} loginPath={String(payload.login_path || "/preview/#/link-dashboard")} onChanged={load} notify={showToast} />
      <Toast msg={toast} />
    </>
  );
}

// ── external: the scoped link dashboard (#/link-dashboard) ──────────────────

export function LinkViewerPage() {
  const [session, setSession] = useState<Json | null | undefined>(undefined);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<Range>("7d");
  const [metric, setMetric] = useState<MetricKey>("entries");
  const [selected, setSelected] = useState("");
  const [dashboard, setDashboard] = useState<Json | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.linkViewerSession().then((s) => setSession(s.link_viewer || null)).catch(() => setSession(null));
  }, []);

  const loadDashboard = () => {
    if (!session) return;
    api.linkViewerDashboard(range, selected).then((d) => { setDashboard(d); setError(""); }).catch((e) => {
      if (e?.status === 401) { setSession(null); setDashboard(null); return; }
      setError(String(e?.message || "לא ניתן לטעון את הנתונים"));
    });
  };
  useEffect(() => { loadDashboard(); const id = setInterval(loadDashboard, 60_000); return () => clearInterval(id); }, [session, range, selected]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setLoginError("");
    try {
      const res = await api.linkViewerLogin(username.trim(), password);
      setSession(res.link_viewer || null);
      setPassword("");
    } catch (err: any) {
      const status = Number(err?.status || 0);
      setLoginError(status === 429 ? "יותר מדי ניסיונות — נסו שוב בעוד כמה דקות" : status === 403 ? "הגישה לדשבורד הזה בוטלה" : status === 503 ? "הכניסה אינה זמינה כרגע" : "שם המשתמש או הסיסמה שגויים");
    }
    setBusy(false);
  };

  const logout = async () => {
    try { await api.linkViewerLogout(); } catch { /* cookie cleared server-side anyway */ }
    setSession(null); setDashboard(null);
  };

  if (session === undefined) return <BrandLoader label="בודקים התחברות…" minHeight={240} />;

  if (!session) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: "24px auto" }} data-testid="link-viewer-login">
        <div className="panel-title">כניסה לדשבורד לינק</div>
        <p className="muted small">קיבלתם מבעל העסקה שם משתמש וסיסמה לצפייה במדדי הלינק שלכם.</p>
        <form onSubmit={login}>
          <div className="field">
            <label htmlFor="lv-user">שם משתמש</label>
            <input id="lv-user" data-testid="link-viewer-username" dir="ltr" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lv-pass">סיסמה</label>
            <input id="lv-pass" data-testid="link-viewer-password" dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {loginError ? <p className="field-error" data-testid="link-viewer-login-error">{loginError}</p> : null}
          <button type="submit" className="btn btn-primary btn-block" data-testid="link-viewer-login-submit" disabled={busy || !username.trim() || !password}>{busy ? "מתחברים…" : "כניסה"}</button>
        </form>
        <DistributionDisclaimer />
      </div>
    );
  }

  const links: Json[] = (session.links as Json[]) || [];
  const link = dashboard?.link || {};
  const disabled = link.status === "disabled";
  return (
    <div data-testid="link-viewer-dashboard">
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="muted small">{dashboard?.deal?.title || links[0]?.deal_title || ""}</div>
            <h2 style={{ margin: "2px 0 0" }} data-testid="link-viewer-link-name">{link.link_name || links[0]?.link_name || "הלינק שלכם"}</h2>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            {dashboard ? <span className={`status ${disabled ? "Cancelled" : "TargetReached"}`} data-testid="link-viewer-status">{disabled ? "מושבת" : "פעיל"}</span> : null}
            <button type="button" className="btn btn-sm btn-ghost" data-testid="link-viewer-logout" onClick={logout}>יציאה</button>
          </div>
        </div>
        {links.length > 1 ? (
          <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "10px 0" }}>
            {links.map((l) => (
              <button key={String(l.link_id)} type="button" className={`chip${(selected || links[0]?.link_id) === l.link_id ? " active" : ""}`} onClick={() => setSelected(String(l.link_id))}>{l.link_name}</button>
            ))}
          </div>
        ) : null}
        {error ? <p className="field-error">{error}</p> : null}
        {dashboard ? (
          <>
            <div className="section-title" style={{ margin: "10px 0 8px" }}>סה״כ מאז יצירת הלינק</div>
            <LinkMetricTiles metrics={dashboard.totals} />
            <div className="section-title" style={{ margin: "6px 0 8px" }}>בטווח שנבחר ({RANGES.find((r) => r.key === range)?.label})</div>
            <LinkMetricTiles metrics={dashboard.window} compact />
            <DistributionDisclaimer text={dashboard.disclaimer_he} />
          </>
        ) : <BrandLoader label="טוענים מדדים…" minHeight={160} />}
      </div>
      {dashboard ? <LinkTimeChart series={dashboard.series} range={range} onRange={setRange} metric={metric} onMetric={setMetric} /> : null}
    </div>
  );
}
