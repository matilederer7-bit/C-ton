import React, { useEffect, useMemo, useState } from "react";
import { api, clearAuthSession, getAdminToken, Json } from "../api";
import { clearOwnerSession } from "../ownerMode";
import { lockAdmin } from "../adminGate";
import { revokeSurface } from "../session";
import { AuthPanel } from "../auth";
import { BrandLoader, Countdown, EmptyState, Modal, Spinner, StatTile, StatusPill, Toast, useToast } from "../components";
import { BrandMark } from "../brand";
import { PropagationTree } from "../propagation";
import { buyerStateLabel, fmtDate, ils, israelPartsToUtcIso, moneyStateLabel, NOTIFICATION_STATUS_LABELS, num, pct, stateLabel, timeAgo } from "../util";
import { DEFAULT_GROWTH_RANGE, GROWTH_RANGE_PRESETS, growthRangeLabel, growthRangeParams, validateCustomRange, type GrowthRange } from "../growthRange";

// ── login (the shared truthful auth panel + server-side admin verification) ─
function AdminLogin({ onDone }: { onDone: () => void }) {
  return (
    <AuthPanel
      surface="admin"
      title="מרכז הבקרה של C-ton"
      subtitle="כניסה למנהלי מערכת בלבד. כל פעולה מתועדת."
      signupLabel="הקמה ראשונית של חשבון הבעלים"
      verify={async () => {
        const me = await api.adminMe().catch((err: any) => {
          if (err.status === 401 || err.status === 403) { revokeSurface("admin"); throw new Error("לחשבון זה אין הרשאת ניהול"); }
          throw err;
        });
        if (!me?.ok && !me?.identity) { revokeSurface("admin"); throw new Error("לחשבון זה אין הרשאת ניהול"); }
      }}
      onDone={onDone}
    />
  );
}

// ── generic hooks ──────────────────────────────────────────────────────────
function useFetch<T = Json>(fn: () => Promise<T>, deps: unknown[] = [], intervalMs = 0): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = () => fn().then((d) => { setData(d); setError(""); }).catch((e: any) => setError(e.message || "שגיאה"));
  useEffect(() => {
    setData(null);
    load();
    if (intervalMs) {
      const id = setInterval(load, intervalMs);
      return () => clearInterval(id);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload: load };
}

function Err({ msg }: { msg: string }) {
  return msg ? <div className="notice err">{msg}</div> : null;
}

// ── overview ───────────────────────────────────────────────────────────────
// LAUNCH POLISH (P4) — the owner sees waiting sellers BEFORE any other number.
function PendingSellersAlert({ navigate }: { navigate: (h: string) => void }) {
  const { data } = useFetch(() => api.adminSellers(), [], 60_000);
  const pending = ((data as Json)?.sellers || []).filter((s: Json) => s.verification_status === "pending");
  if (!pending.length) return null;
  return (
    <div className="notice err" data-testid="pending-sellers-alert" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span><b>{num(pending.length)} מוכרים ממתינים לאישור</b> — {pending.slice(0, 3).map((s: Json) => s.business_name || s.display_name || s.seller_id).join(" · ")}{pending.length > 3 ? " …" : ""}</span>
      <button className="btn btn-sm btn-primary" style={{ marginInlineStart: "auto" }} onClick={() => navigate("#/admin/sellers")}>לאישור עכשיו ←</button>
    </div>
  );
}

function Overview({ navigate }: { navigate: (h: string) => void }) {
  const { data, error } = useFetch(() => api.adminOverview(), [], 30_000);
  if (error) return <Err msg={error} />;
  if (!data) return <BrandLoader minHeight={360} />;
  const d = data as Json;
  const ops = d.operations || {};
  const money = d.money || {};
  const viral = d.viral?.metrics || null;
  const workerAge = ops.workers?.[0]?.heartbeat_age_seconds;
  const workerOk = workerAge !== undefined && workerAge < 120;
  const stateOrder = ["Draft", "PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow", "Completed", "Failed", "Cancelled"];

  return (
    <>
      <h1>תמונת מצב — כל המערכת</h1>
      <PendingSellersAlert navigate={navigate} />
      <div className="stat-row">
        <StatTile num={num(d.deals?.active || 0)} label="עסקאות פעילות" sub={`סה״כ ${num(d.deals?.total || 0)}`} />
        <StatTile num={num(d.sellers?.active || 0)} label="מוכרים פעילים" />
        <StatTile num={num(d.participants?.total || 0)} label="השתתפויות" sub={`${num(d.participants?.distinct_buyers || 0)} קונים`} />
        <StatTile num={num(d.participants?.units_joined || 0)} label="יחידות שהצטרפו" />
        <StatTile num={num(d.participants?.units_charged || 0)} label="יחידות שחויבו בפועל" tone="good" />
      </div>
      <div className="stat-row">
        <StatTile num={ils(money.potential_gross_volume || 0)} label="נפח מסגרות (פוטנציאל — לא הכנסה)" />
        <StatTile num={ils(money.charged_gross_volume || 0)} label="נגבה בפועל" tone="good" />
        <StatTile num={ils(money.platform_fee_projection || 0)} label="עמלת C-ton — צפי מהמסגרות" />
        <StatTile num={ils(money.platform_fee_actual || 0)} label="עמלת C-ton בפועל (מכסף שנגבה בלבד)" tone="good" />
      </div>
      <div className="stat-row">
        <StatTile num={num(ops.outbox_pending || 0)} label="תור עבודות" tone={Number(ops.outbox_pending) > 20 ? "warn" : undefined} />
        <StatTile num={num(ops.dlq_size || 0)} label="DLQ" tone={Number(ops.dlq_size) > 0 ? "bad" : "good"} />
        <StatTile num={workerOk ? "פעיל" : "לא מדווח"} label="Worker" tone={workerOk ? "good" : "bad"} sub={workerAge !== undefined ? `דופק לפני ${num(workerAge)} שנ׳` : ""} />
        <StatTile num={num(d.participants?.in_recovery || 0)} label="בחלון השלמה" tone={Number(d.participants?.in_recovery) > 0 ? "warn" : undefined} sub={`${num(d.participants?.units_in_recovery || 0)} יחידות`} />
        <StatTile num={num(ops.payment_permanent_failures_24h || 0)} label="כשלי חיוב סופיים (24ש)" tone={Number(ops.payment_permanent_failures_24h) > 0 ? "warn" : undefined} />
        <StatTile num={num(ops.open_support_tickets || 0) + Number(ops.open_operational_cases || 0)} label="פניות/חריגים פתוחים" />
      </div>

      <div className="panel">
        <div className="panel-title">עסקאות לפי מצב</div>
        <div className="row">
          {stateOrder.filter((s) => d.deals?.by_state?.[s]).map((s) => (
            <button key={s} className="chip" onClick={() => navigate(`#/admin/deals?state=${s}`)}>
              <StatusPill state={s} /> <b style={{ marginInlineStart: 6 }}>{num(d.deals.by_state[s])}</b>
            </button>
          ))}
        </div>
      </div>

      {viral ? (
        <div className="panel">
          <div className="panel-title">🌱 ויראליות — מבט על <button className="btn btn-sm btn-ghost" style={{ marginInlineStart: "auto" }} onClick={() => navigate("#/admin/growth")}>לדשבורד המלא ←</button></div>
          <div className="stat-row" style={{ marginBottom: 0 }}>
            <StatTile num={num(viral.attributed_participants || 0)} label="הצטרפויות משיתוף" />
            <StatTile num={pct(viral.viral_share_of_joins || 0)} label="שיעור ויראלי מכלל ההצטרפויות" />
            <StatTile num={ils(viral.attributed_charged_gmv || 0)} label="ברוטו מחויב שמקורו בשיתוף" tone="good" />
            <StatTile num={num(viral.max_generation || 0)} label="עומק שרשרת מקסימלי" />
          </div>
        </div>
      ) : null}

      <PilotMetricsPanel navigate={navigate} />

      {ops.recent_dlq?.length ? (
        <div className="panel">
          <div className="panel-title">⚠️ כשלים אחרונים (DLQ)</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>סוג</th><th>ישות</th><th>שגיאה</th><th>מתי</th></tr></thead>
              <tbody>
                {ops.recent_dlq.map((r: Json, i: number) => (
                  <tr key={i}><td>{r.event_type}</td><td dir="ltr">{String(r.aggregate_id).slice(0, 8)}…</td><td>{r.last_error}</td><td>{fmtDate(r.archived_at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

// LAUNCH MODE — the pilot's learning panel: sellers in → created → published;
// buyers viewed → tried → joined (conversion); thresholds; repeat sellers.
function PilotMetricsPanel({ navigate }: { navigate: (h: string) => void }) {
  const [days, setDays] = useState(30);
  const { data, error } = useFetch(() => api.adminPilotMetrics(days), [days], 60_000);
  if (error) return <div className="panel"><div className="panel-title">📊 מדדי פיילוט</div><Err msg={error} /></div>;
  if (!data) return null;
  const m = data as Json;
  const s = m.sellers || {}, dl = m.deals || {}, b = m.buyers || {}, inq = m.inquiries || {};
  const pctText = (v: unknown) => (v === null || v === undefined ? "—" : `${v}%`);
  return (
    <div className="panel" data-testid="pilot-metrics">
      <div className="panel-title">
        📊 מדדי פיילוט — {num(days)} הימים האחרונים
        <span className="row" style={{ marginInlineStart: "auto", gap: 6 }}>
          {[7, 30, 90].map((d) => <button key={d} className={`btn btn-sm ${d === days ? "btn-primary" : "btn-ghost"}`} onClick={() => setDays(d)}>{d} ימים</button>)}
        </span>
      </div>
      <div className="stat-row" style={{ marginBottom: 8 }}>
        <StatTile num={num(s.signed_up || 0)} label="מוכרים נרשמו (סה״כ)" sub={`${num(s.signed_up_in_window || 0)} בחלון`} />
        <StatTile num={num(s.pending_approval || 0)} label="ממתינים לאישור" tone={Number(s.pending_approval) > 0 ? "warn" : undefined} />
        <StatTile num={num(s.created_a_deal || 0)} label="מוכרים שיצרו עסקה" />
        <StatTile num={num(s.published_a_deal || 0)} label="מוכרים שפרסמו" />
        <StatTile num={num(s.repeat_publishers || 0)} label="מוכרים חוזרים (2+ פרסומים)" tone="good" />
      </div>
      <div className="stat-row" style={{ marginBottom: 8 }}>
        <StatTile num={num(dl.drafts_created || 0)} label="טיוטות נוצרו" />
        <StatTile num={num(dl.published || 0)} label="פורסמו" />
        {/* LAUNCH POLISH (P7) — what is live RIGHT NOW (open for joining), from the same aggregate */}
        <StatTile num={num(dl.open_now || 0)} label="פתוחות להצטרפות עכשיו" sub={`${num(dl.settling || 0)} בסגירה/חיוב`} />
        <StatTile num={num(dl.reached_threshold || 0)} label="הגיעו ליעד" tone="good" />
        <StatTile num={num(dl.completed || 0)} label="הושלמו" tone="good" />
        <StatTile num={num(dl.failed || 0)} label="נכשלו" tone={Number(dl.failed) > 0 ? "warn" : undefined} />
      </div>
      <div className="stat-row" style={{ marginBottom: 0 }}>
        <StatTile num={num(b.deal_views || 0)} label="צפיות בעסקאות" sub={`${num(b.unique_visitors || 0)} מבקרים`} />
        <StatTile num={num(b.join_starts || 0)} label="ניסיונות הצטרפות" sub={`${num(b.join_failures || 0)} נדחו`} />
        <StatTile num={num(b.joins || 0)} label="הצטרפו בפועל" sub={`${num(b.distinct_buyers || 0)} קונים`} tone="good" />
        <StatTile num={pctText(b.view_to_join_pct)} label="המרה צפייה→הצטרפות" sub={`ניסיון→הצטרפות ${pctText(b.join_start_to_join_pct)}`} />
        {/* LAUNCH POLISH (P7) — unresolved inquiries are the owner's daily nudge to sellers */}
        <StatTile num={num(Math.max(0, Number(inq.threads || 0) - Number(inq.answered || 0)))} label="פניות ממתינות למענה"
          sub={`${num(inq.threads || 0)} סה״כ · ${num(inq.answered || 0)} נענו`}
          tone={Number(inq.threads || 0) - Number(inq.answered || 0) > 0 ? "warn" : "good"} />
      </div>
      {(m.per_seller || []).some((r: Json) => r.verification_status === "pending") ? (
        <p className="small" style={{ marginTop: 10 }}>
          יש מוכרים שממתינים לאישור —{" "}
          <a href="#/admin/sellers" onClick={(e) => { e.preventDefault(); navigate("#/admin/sellers"); }}>לרשימת המוכרים</a>
        </p>
      ) : null}
      {/* LAUNCH POLISH 2 (P6) — what buyers said was unclear (aggregate, PII-free) */}
      <BuyerFeedbackSummary feedback={m.feedback} />
    </div>
  );
}

const FEEDBACK_LABEL_HE: Record<string, string> = {
  how_it_works: "איך העסקה עובדת", price: "המחיר / ההנחה", target: "מה קורה אם לא מגיעים ליעד",
  payment: "תשלום", delivery: "משלוח / איסוף", other: "משהו אחר", all_clear: "הכול היה ברור", unknown: "לא ידוע"
};
function BuyerFeedbackSummary({ feedback }: { feedback: Json | undefined }) {
  const total = Number(feedback?.total || 0);
  const rows: Json[] = Array.isArray(feedback?.by_category) ? feedback!.by_category : [];
  const recent: Json[] = Array.isArray(feedback?.recent) ? feedback!.recent : [];
  return (
    <div className="feedback-summary" data-testid="pilot-feedback" data-total={total} style={{ marginTop: 14, borderTop: "1px dashed var(--line-strong)", paddingTop: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>🗣️ משוב קונים — ״היה משהו שלא היה ברור?״ ({num(total)})</div>
      {total === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>עדיין אין משובים בחלון הזה. השאלה מוצגת לקונים אחרי ההצטרפות ובמסך המעקב.</p>
      ) : (
        <>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {rows.map((r) => (
              <span key={String(r.category)} className={`chip${r.category === "all_clear" ? " active" : ""}`} data-testid={`pilot-feedback-${String(r.category)}`}>
                {FEEDBACK_LABEL_HE[String(r.category)] || String(r.category)} · {num(r.count)}
              </span>
            ))}
          </div>
          {recent.length ? (
            <ul className="small" style={{ margin: "10px 0 0", paddingInlineStart: 18, color: "var(--ink-soft)" }}>
              {recent.slice(0, 6).map((r, i) => (
                <li key={i}><b>{FEEDBACK_LABEL_HE[String(r.category)] || String(r.category)}:</b> {String(r.text || "")} <span className="muted">· {fmtDate(r.at)}</span></li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── deals ──────────────────────────────────────────────────────────────────
function DealsScreen({ navigate, initialState }: { navigate: (h: string) => void; initialState?: string }) {
  const [state, setState] = useState(initialState || "");
  const [q, setQ] = useState("");
  const { data, error } = useFetch(() => api.adminDeals({ state, q }), [state, q]);
  const states = ["", "PendingTarget", "TargetReached", "Charging", "CompletionWindow", "Completed", "Failed", "Draft", "Cancelled"];
  return (
    <>
      <h1>עסקאות</h1>
      <div className="row" style={{ marginBottom: 14 }}>
        <input placeholder="חיפוש שם / מזהה / מוכר…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        {states.map((s) => (
          <button key={s || "all"} className={`chip${state === s ? " active" : ""}`} onClick={() => setState(s)}>{s ? stateLabel(s) : "הכל"}</button>
        ))}
      </div>
      <Err msg={error} />
      {!data ? <Spinner /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>עסקה</th><th>מוכר</th><th>מצב</th><th className="num">הצטרפו</th><th className="num">חויבו</th>
              <th className="num">פוטנציאל ₪</th><th className="num">נגבה ₪</th><th className="num">ויראלי</th><th>דדליין</th>
            </tr></thead>
            <tbody>
              {((data as Json).deals || []).map((d: Json) => (
                <tr key={d.deal_id} className="clickable" onClick={() => navigate(`#/admin/deal/${d.deal_id}`)}>
                  <td><b>{d.title}</b></td>
                  <td>{d.business_name || d.seller_display_name || d.seller_id}</td>
                  <td><StatusPill state={String(d.state)} /></td>
                  <td className="num">{num(d.joined_units)} / {num(d.max_units)}</td>
                  <td className="num">{num(d.charged_units)}</td>
                  <td className="num">{ils(d.potential_gross)}</td>
                  <td className="num">{ils(d.charged_gross)}</td>
                  <td className="num">{num(d.viral_joins)}</td>
                  <td><Countdown until={d.deadline} overText="עבר" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── viral tree explorer — a VISUAL hierarchy ───────────────────────────────
// The primary view reads as an actual tree: node cards, trunk + elbow
// connectors, children nested visually beneath their parent, expand/collapse
// with lazy loading per branch (never a full dump). Node click opens branch
// metrics in the details panel. Uses only the canonical /viral-tree endpoint.
type TreeNode = Json;

function TreeBranch({ node, dealId, depth, onSelect, selectedId }: { node: TreeNode; dealId: string; depth: number; onSelect: (n: TreeNode) => void; selectedId: string | null }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const toggle = async () => {
    if (children) { setOpen(!open); return; }
    setLoading(true);
    try {
      const r = await api.adminDealViralTree(dealId, { parent: node.participant_id, limit: 60 });
      setChildren((r as Json).nodes || []);
      setTruncated(Boolean((r as Json).truncated));
      setOpen(true);
    } catch { setChildren([]); }
    finally { setLoading(false); }
  };
  const selected = selectedId === node.participant_id;
  return (
    <div className="vtree-branch">
      <div className="vtree-node">
        <div
          className={`vtree-card${selected ? " selected" : ""}${depth === 0 ? " root-card" : ""}`}
          role="button" tabIndex={0}
          onClick={() => onSelect(node)}
          onKeyDown={(e) => { if (e.key === "Enter") onSelect(node); }}
        >
          {node.has_children ? (
            <button className="vtree-toggle" onClick={(e) => { e.stopPropagation(); void toggle(); }} aria-label={open ? "כיווץ ענף" : "הרחבת ענף"} aria-expanded={open}>
              {loading ? "…" : open ? "−" : "+"}
            </button>
          ) : <span className="vtree-leaf-dot" aria-hidden="true">•</span>}
          <span className="vtree-name">{node.display}</span>
          <span className="vtree-gen">דור {num(node.generation)}</span>
          <span className="vtree-badge">{num(node.direct_units)} יח׳</span>
          {node.charged ? <span className="vtree-badge charged">חויב ✓</span> : node.active ? <span className="vtree-badge">מסגרת</span> : <span className="vtree-badge dropped">נשר</span>}
          {node.has_children ? (
            <span className="vtree-badge branch">
              {num(node.direct_children)} ישירים · ענף: {num(node.subtree_joins)} הצטרפויות / {num(node.subtree_charged_units)} מחויבות
            </span>
          ) : null}
        </div>
      </div>
      {open && children ? (
        <div className="vtree-children">
          {children.length ? children.map((c) => (
            <TreeBranch key={c.participant_id} node={c} dealId={dealId} depth={depth + 1} onSelect={onSelect} selectedId={selectedId} />
          )) : <p className="muted small">אין מצטרפים דרך הקישור של המשתתף הזה.</p>}
          {truncated ? <p className="muted small">מוצגים 60 הראשונים בענף זה.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function useIsWide(minWidth = 900): boolean {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia(`(min-width: ${minWidth}px)`).matches; } catch { return true; }
  });
  useEffect(() => {
    try {
      const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
      const onChange = () => setWide(mq.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    } catch { return undefined; }
  }, [minWidth]);
  return wide;
}

// P0.5-2 — the TRUE propagation tree (deal → origin sources → every
// participant → generations). ONE canonical component serves admin + seller;
// only the endpoints differ.
function ViralTreeExplorer({ dealId, dealTitle }: { dealId: string; dealTitle?: string }) {
  return (
    <PropagationTree
      dealId={dealId}
      dealTitle={dealTitle || ""}
      fetchers={{ fetchPropagation: api.adminDealPropagation, fetchLevel: api.adminDealViralTree }}
    />
  );
}

function ViralMetricsBlock({ vm, stale, computedAt, onRecompute }: { vm: Json | null; stale?: boolean; computedAt?: string | null; onRecompute?: () => void }) {
  if (!vm) return (
    <div className="row">
      <p className="muted small grow">עדיין לא חושבו נתוני ויראליות לעסקה זו.</p>
      {onRecompute ? <button className="btn btn-sm btn-ghost" onClick={onRecompute}>חשב עכשיו</button> : null}
    </div>
  );
  const v = (vm.viral || {}) as Json;
  const f = (vm.funnel || {}) as Json;
  const gens = Object.entries((v.generation_distribution || {}) as Record<string, number>).sort((a, b) => Number(a[0]) - Number(b[0]));
  const maxGen = Math.max(1, ...gens.map(([, n]) => Number(n)));
  return (
    <>
      <div className="stat-row">
        <StatTile num={num(v.attributed_participants || 0)} label="הצטרפויות משיתוף" sub={`${pct(v.viral_share_of_joins || 0)} מהכלל`} />
        <StatTile num={num(v.attributed_charged_units || 0)} label="יחידות מחויבות מהפצה" tone="good" />
        <StatTile num={ils(v.attributed_charged_gmv || 0)} label="ברוטו מחויב מהפצה" tone="good" />
        <StatTile num={num(v.personal_links || 0)} label="לינקים אישיים" />
        <StatTile num={num(v.sharing_participants || 0)} label="משתפים פעילים" sub={`ממוצע ${Number(v.avg_children_per_sharer || 0).toFixed(1)} ילדים`} />
        <StatTile num={String(v.direct_viral_coefficient ?? 0)} label="מקדם ויראלי (הצטרפויות)" sub={`בכסף: ${v.charged_viral_coefficient ?? 0}`} />
      </div>
      <div className="stat-row">
        <StatTile num={num(f.deal_views || 0)} label="צפיות בדף" />
        <StatTile num={num(f.share_clicks || 0)} label="לחיצות שיתוף" />
        <StatTile num={num(f.link_entries || 0)} label="כניסות מלינקים" />
        <StatTile num={pct(f.visit_to_join_rate || 0)} label="המרה: כניסה → הצטרפות" />
        <StatTile num={pct(f.shared_visit_to_charged_rate || 0)} label="המרה: כניסה → חיוב מוצלח" />
      </div>
      {gens.length ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-title">התפלגות דורות</div>
          <div className="gen-bars" style={{ paddingTop: 18, paddingBottom: 22 }}>
            {gens.map(([g, n]) => (
              <div key={g} className="gen-bar" style={{ height: `${Math.max(8, (Number(n) / maxGen) * 100)}%` }}>
                <span className="gen-val">{num(n)}</span>
                <span className="gen-lbl">דור {g}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {(vm.top_sources as Json[])?.length ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-title">מקורות מובילים (first/last touch)</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>מקור</th><th>סוג</th><th className="num">קליקים</th><th className="num">כניסות</th><th className="num">הצטרפויות (ענף)</th><th className="num">יח׳ מחויבות</th><th className="num">ברוטו מחויב</th></tr></thead>
              <tbody>
                {(vm.top_sources as Json[]).slice(0, 10).map((s) => (
                  <tr key={s.link_id}>
                    <td><b>{s.owner_display || s.internal_name}</b> <span className="muted small" dir="ltr">{s.source_code}</span></td>
                    <td>{s.origin_type === "participant" ? "משתתף" : s.origin_type === "distributor" ? "מפיץ" : s.origin_type}</td>
                    <td className="num">{num(s.clicks)}</td>
                    <td className="num">{num(s.entries)}</td>
                    <td className="num">{num(s.subtree_joins)}</td>
                    <td className="num">{num(s.subtree_charged_units)}</td>
                    <td className="num">{ils(s.subtree_charged_gmv)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {stale !== undefined ? (
        <p className="muted small">
          חושב ברקע ע״י ה־Worker · עודכן {computedAt ? fmtDate(computedAt) : "—"} {stale ? "· ייתכן שאינו עדכני" : ""}
          {onRecompute ? <button className="btn btn-sm btn-ghost" style={{ marginInlineStart: 8 }} onClick={onRecompute}>רענון חישוב</button> : null}
        </p>
      ) : null}
    </>
  );
}

function ViralTab({ dealId, dealTitle, vm, viralRes, onRecompute }: { dealId: string; dealTitle?: string; vm: Json | null; viralRes: Json | null; onRecompute: () => void }) {
  const [mode, setMode] = useState<"tree" | "analytics">("tree");
  return (
    <>
      <div className="mode-toggle">
        <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>🌳 עץ הפצה</button>
        <button className={mode === "analytics" ? "active" : ""} onClick={() => setMode("analytics")}>📊 אנליטיקה</button>
      </div>
      {mode === "tree" ? (
        <div className="panel">
          <div className="panel-title">עץ ההפצה</div>
          <ViralTreeExplorer dealId={dealId} dealTitle={dealTitle} />
        </div>
      ) : (
        <ViralMetricsBlock vm={vm} stale={viralRes?.stale} computedAt={viralRes?.computed_at} onRecompute={onRecompute} />
      )}
    </>
  );
}

// ── deal drilldown ─────────────────────────────────────────────────────────
function DealDetail({ dealId, navigate }: { dealId: string; navigate: (h: string) => void }) {
  const { data: profileRes, error } = useFetch(() => api.adminDealProfile(dealId), [dealId], 30_000);
  const { data: viralRes, reload: reloadViral } = useFetch(() => api.adminDealViral(dealId), [dealId]);
  const { data: opsRes } = useFetch(() => api.adminDealOps(dealId), [dealId]);
  const [tab, setTab] = useState("summary");
  const [toast, showToast] = useToast();
  if (error) return <Err msg={error} />;
  if (!profileRes) return <Spinner />;
  const p = (profileRes as Json).profile || {};
  const deal = p.deal || {};
  const participants: Json[] = p.participants || [];
  const charged = participants.filter((x) => ["ChargedSuccess", "RecoveredCharge"].includes(String(x.money_state)));
  const chargedUnits = charged.reduce((s, x) => s + Number(x.qty || 0), 0);
  const joinedUnits = participants.filter((x) => !["DealFailed", "Dropped"].includes(String(x.buyer_state))).reduce((s, x) => s + Number(x.qty || 0), 0);
  const gross = charged.reduce((s, x) => s + Number(x.qty) * Number(deal.price_per_unit || 0) + Number(x.delivery_cost || 0), 0);
  const potential = participants.filter((x) => !["DealFailed", "Dropped"].includes(String(x.buyer_state))).reduce((s, x) => s + Number(x.qty) * Number(deal.price_per_unit || 0) + Number(x.delivery_cost || 0), 0);
  const vm = (viralRes as Json | null)?.metrics as Json | null;
  const ops = (opsRes as Json | null)?.summary || (opsRes as Json | null) || {};

  const recompute = async () => {
    try { await api.adminViralRecompute(dealId); showToast("חישוב ויראליות נכנס לתור"); setTimeout(reloadViral, 4000); }
    catch (e: any) { showToast(e.message || "נכשל"); }
  };

  return (
    <>
      <a className="back" href="#/admin/deals" onClick={(e) => { e.preventDefault(); navigate("#/admin/deals"); }}>→ לרשימת העסקאות</a>
      <div className="row" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>{deal.title}</h1>
        <StatusPill state={String(deal.state)} />
        <button className="btn btn-sm btn-ghost" style={{ marginInlineStart: "auto" }} onClick={() => navigate(`#/admin/seller/${encodeURIComponent(deal.seller_id)}`)}>למוכר: {deal.seller_id}</button>
        <a className="btn btn-sm btn-ghost" href={`#/deal/${dealId}`} target="_blank">דף ציבורי</a>
      </div>
      <div className="stat-row">
        <StatTile num={`${num(joinedUnits)} / ${num(deal.max_units)}`} label="הצטרפו / מקסימום" sub={`מינימום ${num(deal.min_units)} · סף ${num(deal.threshold_units)}`} />
        <StatTile num={num(chargedUnits)} label="יחידות מחויבות בפועל" tone="good" />
        <StatTile num={ils(potential)} label="פוטנציאל (מסגרות)" />
        <StatTile num={ils(gross)} label="נגבה בפועל" tone="good" />
        <StatTile num={ils(Math.round(gross * 0.08 * 100) / 100)} label="עמלת C-ton (8% מהנגבה)" />
        <StatTile num={<Countdown until={deal.completion_window_until || deal.deadline} overText="עבר" />} label={deal.completion_window_until ? "חלון השלמה" : "דדליין"} />
        {/* LAUNCH SPRINT 3 — physical handoff truth for support: awaiting vs handed over (server-computed) */}
        {p.fulfillment?.applicable ? (
          <>
            <StatTile num={num(p.fulfillment.awaiting)} label="ממתינות למסירה" tone={Number(p.fulfillment.awaiting) > 0 ? "warn" : undefined} />
            <StatTile num={num(p.fulfillment.fulfilled)} label="נמסרו" tone="good" />
          </>
        ) : null}
      </div>

      <div className="tabbar">
        {[["summary", "משתתפים וכסף"], ["viral", "ויראליות ועץ"], ["ops", "תפעול ותור"], ["audit", "יומן פעולות"]].map(([k, l]) => (
          <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k!)}>{l}</button>
        ))}
      </div>

      {tab === "summary" ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>קונה</th><th>טלפון</th><th className="num">כמות</th><th>מצב קונה</th><th>מצב כסף</th><th>אספקה</th><th>מסירה</th><th>מקור</th><th>מתי</th></tr></thead>
            <tbody>
              {participants.map((x) => {
                const f = p.fulfillment?.by_participant?.[String(x.participant_id)] || null;
                const fulfillmentText = !f || f.fulfillment_status === "none" ? "—"
                  : f.fulfillment_status === "fulfilled" ? `נמסר ${fmtDate(f.fulfilled_at)}${f.order_code_last4 ? ` · •${f.order_code_last4}` : ""}`
                    : f.fulfillment_status === "awaiting" ? `ממתין${f.order_code_last4 ? ` · •${f.order_code_last4}` : ""}` : "אין למסור";
                return (
                <tr key={x.participant_id}>
                  <td>{x.buyer_name || "—"}</td>
                  <td dir="ltr">{x.buyer_phone || x.buyer_id}</td>
                  <td className="num">{num(x.qty)}</td>
                  <td>{buyerStateLabel(String(x.buyer_state))}</td>
                  <td><span className={`status ${["ChargedSuccess", "RecoveredCharge"].includes(String(x.money_state)) ? "Completed" : String(x.money_state) === "ChargeFailedRecovery" ? "CompletionWindow" : "ClosedForJoining"}`}>{moneyStateLabel(String(x.money_state))}</span></td>
                  <td>{x.delivery_method_label || "—"}</td>
                  <td>{fulfillmentText}</td>
                  <td>{x.acquisition_source || "direct"}</td>
                  <td>{fmtDate(x.created_at)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "viral" ? <ViralTab dealId={dealId} dealTitle={String(deal.title || "")} vm={vm} viralRes={viralRes as Json | null} onRecompute={recompute} /> : null}

      {tab === "ops" ? (
        <>
          <div className="panel">
            <div className="panel-title">תור עבודות של העסקה</div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>סוג</th><th>סטטוס</th><th className="num">ניסיונות</th><th>זמין מ־</th><th>נוצר</th></tr></thead>
                <tbody>
                  {(p.outbox || []).map((o: Json, i: number) => (
                    <tr key={i}><td>{o.event_type}</td><td>{o.status}</td><td className="num">{num(o.attempt_count)}</td><td>{fmtDate(o.available_at)}</td><td>{fmtDate(o.created_at)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <div className="panel-title">ניסיונות חיוב</div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>סוג</th><th>תוצאה</th><th>מזהה קורלציה</th><th>מתי</th></tr></thead>
                <tbody>
                  {(p.payment_attempts || []).map((a: Json, i: number) => (
                    <tr key={i}><td>{a.attempt_type}</td><td>{a.result_class}</td><td dir="ltr" className="small">{a.correlation_id}</td><td>{fmtDate(a.created_at)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {ops.notifications ? (
            <div className="panel">
              <div className="panel-title">התראות לעסקה</div>
              <div className="row">{Object.entries(ops.notifications as Record<string, unknown>).map(([k, v]) => <span key={k} className="chip">{k}: {String(v)}</span>)}</div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "audit" ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>ישות</th><th>שינוי</th><th>פעולה</th><th>מתי</th></tr></thead>
            <tbody>
              {(p.audit || []).map((a: Json, i: number) => (
                <tr key={i}>
                  <td>{a.entity_type}</td>
                  <td>{a.from_state} ← {a.to_state}</td>
                  <td dir="ltr" className="small">{a.action_name}</td>
                  <td>{fmtDate(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Toast msg={toast} />
    </>
  );
}

// ── sellers ────────────────────────────────────────────────────────────────
// LAUNCH POLISH (P4) — the pending queue: every self-registered seller waiting
// for the owner, with WHO they are and approve/reject right here (no need to
// open the seller). Target: signup → approval in under a minute.
function KycRejectionFields({ reason, note, setReason, setNote, disabled }: {
  reason: string; note: string; setReason: (v: string) => void; setNote: (v: string) => void; disabled: boolean;
}) {
  return <div data-testid="kyc-rejection-fields" style={{ flexBasis: "100%", minWidth: 0, width: "100%" }}>
    <label className="field">סיבת דחייה למוכר (אופציונלי)
      <textarea data-testid="kyc-seller-reason" maxLength={300} value={reason} disabled={disabled} onChange={(e) => setReason(e.target.value)} />
      <span className="small muted">הטקסט הזה מיועד למוכר ויכול להופיע בהודעת הדחייה.</span>
    </label>
    <label className="field">הערה פנימית למנהל
      <textarea data-testid="kyc-admin-note" maxLength={2000} value={note} disabled={disabled} onChange={(e) => setNote(e.target.value)} />
      <span className="small muted">לשימוש פנימי בלבד — לא נשלחת בהודעה למוכר.</span>
    </label>
  </div>;
}

function PendingSellersQueue({ pending, navigate, onChanged }: { pending: Json[]; navigate: (h: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [confirmReject, setConfirmReject] = useState("");
  const [sellerReason, setSellerReason] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [msg, setMsg] = useState("");
  if (!pending.length) return <div className="notice ok" data-testid="pending-sellers-empty">אין מוכרים שממתינים לאישור.</div>;
  const decide = async (s: Json, decision: "approve" | "reject") => {
    if (busy) return;
    setBusy(String(s.seller_id)); setMsg("");
    try {
      await api.adminSellerKycDecision(String(s.seller_id), decision, decision === "approve" ? "pilot_approved" : adminNote, sellerReason);
      setMsg(decision === "approve" ? `${s.business_name || s.display_name} אושר — יכול לפרסם.` : `${s.business_name || s.display_name} נדחה.`);
      setConfirmReject("");
      onChanged();
    } catch (e: any) { setMsg(e.message || "הפעולה נכשלה"); }
    setBusy("");
  };
  return (
    <section className="pending-queue" data-testid="pending-sellers-queue" aria-label="מוכרים ממתינים לאישור">
      <div className="panel-title">⏳ ממתינים לאישור <span className="count">({num(pending.length)})</span></div>
      <p className="small muted" style={{ margin: "0 0 4px" }}>מוכר שנרשם עצמאית יכול להכין טיוטות; פרסום נפתח רק אחרי ״אשר מוכר״.</p>
      {pending.map((s) => (
        <div className="pending-row" key={s.seller_id} data-testid="pending-seller-row" data-seller-id={s.seller_id}>
          <div className="who">
            <b>{s.business_name || s.display_name || s.seller_id}</b>
            <span className="small" dir="ltr">{s.login_email || s.seller_id}</span>
            <div className="small">
              נרשם {s.created_at ? timeAgo(s.created_at) : "—"} · {s.supabase_bound ? "התחברות מאומתת" : "ללא קישור התחברות"} · טיוטות: {num(s.deals_total || 0)}
            </div>
          </div>
          <div className="acts">
            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`#/admin/seller/${encodeURIComponent(String(s.seller_id))}`)}>פתיחה</button>
            {confirmReject === s.seller_id ? (
              <button className="btn btn-sm btn-danger" data-testid="pending-reject-confirm" disabled={Boolean(busy)} onClick={() => decide(s, "reject")}>אישור הדחייה</button>
            ) : (
              <button className="btn btn-sm btn-ghost btn-danger-ghost" data-testid="pending-reject" disabled={Boolean(busy)} onClick={() => { setSellerReason(""); setAdminNote(""); setConfirmReject(String(s.seller_id)); }}>דחייה</button>
            )}
            <button className="btn btn-sm btn-primary" data-testid="pending-approve" disabled={Boolean(busy)} onClick={() => decide(s, "approve")}>
              {busy === s.seller_id ? "רגע…" : "אשר מוכר"}
            </button>
            {confirmReject === s.seller_id ? <KycRejectionFields reason={sellerReason} note={adminNote} setReason={setSellerReason} setNote={setAdminNote} disabled={Boolean(busy)} /> : null}
          </div>
        </div>
      ))}
      {msg ? <div className="small" style={{ marginTop: 8 }} data-testid="pending-queue-msg">{msg}</div> : null}
    </section>
  );
}

function SellersScreen({ navigate }: { navigate: (h: string) => void }) {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch(() => api.adminSellers(), [version]);
  if (error) return <Err msg={error} />;
  if (!data) return <Spinner />;
  const sellers: Json[] = (data as Json).sellers || [];
  const pending = sellers.filter((s) => s.verification_status === "pending");
  return (
    <>
      <h1>מוכרים</h1>
      <PendingSellersQueue pending={pending} navigate={navigate} onChanged={() => setVersion((v) => v + 1)} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr>
            <th>מוכר</th><th>סטטוס</th><th className="num">עסקאות</th><th className="num">פעילות</th><th className="num">הושלמו</th><th className="num">נכשלו</th>
            <th className="num">יח׳ חויבו</th><th className="num">פוטנציאל ₪</th><th className="num">נגבה ₪</th><th className="num">עמלה בפועל</th><th>פעילות אחרונה</th>
          </tr></thead>
          <tbody>
            {((data as Json).sellers || []).map((s: Json) => (
              <tr key={s.seller_id} className="clickable" onClick={() => navigate(`#/admin/seller/${encodeURIComponent(s.seller_id)}`)}>
                <td><b>{s.business_name || s.display_name}</b><div className="muted small" dir="ltr">{s.login_email || s.seller_id}</div></td>
                <td>
                  <span className={`status ${s.seller_status === "Active" ? "Completed" : "Failed"}`}>{s.seller_status}</span>
                  {s.supabase_bound ? <span className="tree-badge charged" style={{ marginInlineStart: 6 }}>Auth✓</span> : null}
                  {/* LAUNCH MODE — who is waiting for the owner's approval */}
                  {s.verification_status === "pending" ? <span className="tree-badge" style={{ marginInlineStart: 6, background: "var(--amber, #d9931c)", color: "#1b1b1b" }}>ממתין לאישור</span> : null}
                  {s.verification_status === "rejected" ? <span className="tree-badge" style={{ marginInlineStart: 6 }}>נדחה</span> : null}
                </td>
                <td className="num">{num(s.deals_total)}</td>
                <td className="num">{num(s.deals_active)}</td>
                <td className="num">{num(s.deals_completed)}</td>
                <td className="num">{num(s.deals_failed)}</td>
                <td className="num">{num(s.charged_units)}</td>
                <td className="num">{ils(s.potential_gross)}</td>
                <td className="num">{ils(s.charged_gross)}</td>
                <td className="num">{ils(s.platform_fee_actual)}</td>
                <td>{s.last_activity_at ? timeAgo(s.last_activity_at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// LAUNCH MODE — the closed-market gate: a self-registered seller stays
// "pending" (drafts only) until the owner approves here. Uses the existing
// server decision route; nothing else changes on the account.
function SellerApprovalPanel({ seller, onChanged }: { seller: Json; onChanged: () => void }) {
  const [sellerReason, setSellerReason] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // LAUNCH POLISH (P4) — inline two-step reject (window.confirm is invisible
  // on some mobile browsers and blocks the tab); approve stays one tap.
  const [confirmReject, setConfirmReject] = useState(false);
  const status = String(seller.verification_status || "pending");
  const decide = async (decision: "approve" | "reject") => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      await api.adminSellerKycDecision(String(seller.seller_id), decision, decision === "approve" ? "pilot_approved" : adminNote, sellerReason);
      setMsg(decision === "approve" ? "המוכר אושר — יכול לפרסם עסקאות." : "המוכר נדחה.");
      setConfirmReject(false);
      onChanged();
    } catch (e: any) { setMsg(e.message || "הפעולה נכשלה"); }
    setBusy(false);
  };
  return (
    <div className={`notice ${status === "approved" ? "ok" : status === "rejected" ? "err" : "info"}`} data-testid="seller-approval" data-status={status} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>
        <b>אישור מוכר:</b>{" "}
        {status === "approved" ? "מאושר" : status === "rejected" ? "נדחה" : "ממתין לאישור"}
        {" · "}
        <b data-testid="seller-can-publish">{status === "approved" ? "יכול לפרסם ✓" : "לא יכול לפרסם (טיוטות בלבד)"}</b>
      </span>
      <span className="row" style={{ marginInlineStart: "auto", gap: 8 }}>
        {status !== "approved" ? <button className="btn btn-sm btn-primary" data-testid="seller-approve" disabled={busy} onClick={() => decide("approve")}>אשר מוכר</button> : null}
        {status !== "rejected" ? (
          confirmReject
            ? <button className="btn btn-sm btn-danger" data-testid="seller-reject-confirm" disabled={busy} onClick={() => decide("reject")}>אישור הדחייה</button>
            : <button className="btn btn-sm btn-ghost btn-danger-ghost" data-testid="seller-reject" disabled={busy} onClick={() => { setSellerReason(""); setAdminNote(""); setConfirmReject(true); }}>דחה</button>
        ) : null}
      </span>
      {confirmReject ? <KycRejectionFields reason={sellerReason} note={adminNote} setReason={setSellerReason} setNote={setAdminNote} disabled={busy} /> : null}
      {msg ? <span className="small" style={{ flexBasis: "100%" }}>{msg}</span> : null}
    </div>
  );
}

function SellerDetail({ sellerId, navigate }: { sellerId: string; navigate: (h: string) => void }) {
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  const { data, error } = useFetch(() => api.adminSellerDetail(sellerId), [sellerId, version]);
  const [tab, setTab] = useState("deals");
  if (error) return <Err msg={error} />;
  if (!data) return <BrandLoader minHeight={360} />;
  const d = data as Json;
  const s = d.seller || {};
  const vm = d.viral?.metrics as Json | null;
  return (
    <>
      <a className="back" href="#/admin/sellers" onClick={(e) => { e.preventDefault(); navigate("#/admin/sellers"); }}>→ לרשימת המוכרים</a>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>{s.business_name || s.display_name}</h1>
        <span className={`status ${s.seller_status === "Active" ? "Completed" : "Failed"}`}>{s.seller_status}</span>
        {s.supabase_bound ? <span className="tree-badge charged">זהות Supabase מקושרת</span> : <span className="tree-badge">ללא קישור Auth</span>}
      </div>
      <p className="muted small" dir="ltr">{s.login_email || ""} · {s.seller_id}</p>
      <SellerApprovalPanel seller={s} onChanged={reload} />
      {/* LAUNCH POLISH (P4) — who is this seller, in one glance (no KYC infrastructure: the profile they typed) */}
      <div className="id-block" data-testid="seller-identity">
        <div><div className="k">שם העסק</div><div className="v">{s.business_name || "— (טרם מולא)"}</div></div>
        <div><div className="k">איש קשר</div><div className="v">{s.contact_name || "—"}</div></div>
        <div><div className="k">טלפון</div><div className="v" dir="ltr">{s.support_phone || "—"}</div></div>
        <div><div className="k">אימייל תמיכה</div><div className="v" dir="ltr">{s.support_email || "—"}</div></div>
        <div><div className="k">מזהה עסק</div><div className="v" dir="ltr">{s.business_identifier || "—"}</div></div>
        <div><div className="k">מקור החשבון</div><div className="v">{s.self_signup ? "נרשם עצמאית (Supabase)" : s.admin_note === "owner_email_claim" ? "חשבון הבעלים" : /pilot_manual/.test(String(s.admin_note || "")) ? "קושר ידנית (פיילוט)" : s.supabase_bound ? "התחברות מקושרת" : "חשבון ללא קישור התחברות"}</div></div>
        <div><div className="k">נרשם</div><div className="v">{fmtDate(s.created_at)}</div></div>
        <div><div className="k">התחברות אחרונה</div><div className="v">{s.last_login_at ? fmtDate(s.last_login_at) : "—"}</div></div>
        {s.business_description ? <div style={{ gridColumn: "1 / -1" }}><div className="k">תיאור</div><div className="v" style={{ fontWeight: 400 }}>{s.business_description}</div></div> : null}
      </div>
      {(d.warnings || []).length ? (
        <div className="notice err"><b>אזהרות מערכת:</b> {(d.warnings as string[]).join(" · ")}</div>
      ) : null}
      <div className="stat-row">
        <StatTile num={num((d.deals || []).length)} label="עסקאות" />
        <StatTile num={ils(d.money?.potential_gross || 0)} label="פוטנציאל (מסגרות)" />
        <StatTile num={ils(d.money?.charged_gross || 0)} label="נגבה בפועל" tone="good" />
        <StatTile num={ils(d.money?.platform_fee_actual || 0)} label="עמלת C-ton בפועל" />
        <StatTile num={ils(d.money?.seller_net_actual || 0)} label="נטו למוכר בפועל" />
      </div>

      <div className="tabbar">
        {[["deals", "עסקאות"], ["viral", "ויראליות"], ["support", "תמיכה ואספקה"], ["audit", "יומן פעולות"]].map(([k, l]) => (
          <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k!)}>{l}</button>
        ))}
      </div>

      {tab === "deals" ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>עסקה</th><th>מצב</th><th className="num">הצטרפו</th><th className="num">חויבו</th><th className="num">בהשלמה</th><th className="num">פוטנציאל ₪</th><th className="num">נגבה ₪</th><th>דדליין</th></tr></thead>
            <tbody>
              {(d.deals || []).map((x: Json) => (
                <tr key={x.deal_id} className="clickable" onClick={() => navigate(`#/admin/deal/${x.deal_id}`)}>
                  <td><b>{x.title}</b></td>
                  <td><StatusPill state={String(x.state)} /></td>
                  <td className="num">{num(x.joined_units)}</td>
                  <td className="num">{num(x.charged_units)}</td>
                  <td className="num">{num(x.in_recovery)}</td>
                  <td className="num">{ils(x.potential_gross)}</td>
                  <td className="num">{ils(x.charged_gross)}</td>
                  <td>{fmtDate(x.deadline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {tab === "viral" ? <ViralMetricsBlock vm={vm} stale={d.viral?.stale} computedAt={d.viral?.computed_at} /> : null}
      {tab === "support" ? (
        <>
          <div className="panel">
            <div className="panel-title">פניות תמיכה</div>
            {(d.support_tickets || []).length ? (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>נושא</th><th>עדיפות</th><th>סטטוס</th><th>מתי</th></tr></thead>
                <tbody>{(d.support_tickets as Json[]).map((t) => <tr key={t.ticket_id}><td>{t.title}</td><td>{t.priority}</td><td>{t.status}</td><td>{fmtDate(t.created_at)}</td></tr>)}</tbody>
              </table></div>
            ) : <p className="muted small">אין פניות פתוחות.</p>}
          </div>
          <div className="panel">
            <div className="panel-title">סטטוס אספקה</div>
            {Object.keys(d.delivery_status_counts || {}).length ? (
              <div className="row">{Object.entries(d.delivery_status_counts as Record<string, number>).map(([k, v]) => <span className="chip" key={k}>{k}: {num(v)}</span>)}</div>
            ) : <p className="muted small">אין נתוני אספקה עדיין.</p>}
          </div>
        </>
      ) : null}
      {tab === "audit" ? (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>ישות</th><th>שינוי</th><th>פעולה</th><th>מתי</th></tr></thead>
          <tbody>{(d.audit_tail || []).map((a: Json, i: number) => (
            <tr key={i}><td>{a.entity_type}</td><td>{a.from_state} ← {a.to_state}</td><td dir="ltr" className="small">{a.action_name}</td><td>{fmtDate(a.created_at)}</td></tr>
          ))}</tbody>
        </table></div>
      ) : null}
    </>
  );
}

// ── buyers ─────────────────────────────────────────────────────────────────
function VerifyBadge({ value, label }: { value: boolean; label: string }) {
  return <span className={`vbadge ${value ? "ok" : "no"}`} title={value ? `${label} מאומת` : `${label} לא מאומת`}>{value ? "✓" : "○"} {label}</span>;
}

// SPRINT 4 (A6) — the search is intent-sensitive (letters → name, digits →
// phone, @ → e-mail, CT-… → order code, UUID → id) and every row says why it
// matched. Typing is debounced so the roster does not flicker per keystroke.
function BuyersScreen() {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const id = setTimeout(() => setQ(typed.trim()), 250); return () => clearTimeout(id); }, [typed]);
  const { data, error } = useFetch(() => api.adminBuyers(q), [q]);
  const buyers: Json[] = (data as Json)?.buyers || [];
  const search = ((data as Json)?.search || {}) as Json;
  const totalCharged = buyers.reduce((s, b) => s + Number(b.charged_gross || 0), 0);
  const totalUnitsCharged = buyers.reduce((s, b) => s + Number(b.units_charged || 0), 0);
  const inRecovery = buyers.reduce((s, b) => s + Number(b.in_recovery || 0), 0);
  return (
    <>
      <h1>קונים ומשתתפים</h1>
      <p className="muted small" style={{ marginTop: -6 }}>אימייל וטלפון הם מידע רגיש לצוות הניהול בלבד — אינם נחשפים בשום משטח ציבורי/מוכר/ויראלי.</p>
      {data ? (
        <div className="stat-row">
          <StatTile num={num(buyers.length)} label="קונים ייחודיים" />
          <StatTile num={num(totalUnitsCharged)} label="יחידות שחויבו בפועל" tone="good" />
          <StatTile num={ils(totalCharged)} label="נגבה בפועל" tone="good" />
          <StatTile num={num(inRecovery)} label="בהשלמת חיוב" tone={inRecovery > 0 ? "warn" : undefined} />
        </div>
      ) : null}
      <div className="stack" style={{ gap: 4, marginBottom: 14, maxWidth: 420 }}>
        <input data-testid="buyer-search" placeholder="שם (אותיות) · טלפון (ספרות) · אימייל · קוד הזמנה CT-…" value={typed} onChange={(e) => setTyped(e.target.value)} />
        {q && search.label_he ? (
          <span className="small muted" data-testid="buyer-search-intent" data-intent={String(search.intent || "")}>{String(search.label_he)}</span>
        ) : (
          <span className="small muted">אותיות מחפשות בשם בלבד; ספרות בטלפון; @ באימייל; CT-1234-5678 בקוד הזמנה.</span>
        )}
      </div>
      <Err msg={error} />
      {!data ? <Spinner /> : buyers.length === 0 ? (
        <EmptyState icon="👤" title="אין קונים תואמים" body={q ? `לא נמצאה ${String(search.match_label_he || search.label_he || "התאמה").replace("חיפוש לפי", "התאמה ב")} עבור ״${q}״.` : "עדיין אין השתתפויות במערכת."} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>שם</th>{q ? <th>התאמה</th> : null}<th>טלפון</th><th>אימייל</th><th>אימות</th>
              <th className="num">השת׳</th><th className="num">עסקאות</th>
              <th className="num">יח׳ הצטרפו</th><th className="num">יח׳ חויבו</th><th className="num">נגבה ₪</th>
              <th>סטטוס קונה</th><th>סטטוס כסף</th><th>פעילות אחרונה</th>
            </tr></thead>
            <tbody>
              {buyers.map((b: Json) => (
                <tr key={b.buyer_id} data-testid="buyer-row" data-buyer-name={String(b.buyer_name || "")}>
                  <td data-testid="buyer-row-name">{b.buyer_name || "—"}</td>
                  {q ? <td><span className="status small" data-testid="buyer-row-match">{String((b.match as Json)?.label_he || "—")}</span></td> : null}
                  <td dir="ltr">{b.buyer_phone || (String(b.buyer_id).match(/^[0-9+]/) ? b.buyer_id : "—")}</td>
                  <td dir="ltr" className="small">{b.buyer_email || <span className="muted">—</span>}</td>
                  <td><VerifyBadge value={Boolean(b.phone_verified)} label="טלפון" /> <VerifyBadge value={Boolean(b.email_verified)} label="מייל" /></td>
                  <td className="num">{num(b.participations)}</td>
                  <td className="num">{num(b.deals)}</td>
                  <td className="num">{num(b.units_joined)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{num(b.units_charged)}</td>
                  <td className="num">{ils(b.charged_gross)}</td>
                  <td>{b.latest_buyer_state ? <span className="status small">{buyerStateLabel(String(b.latest_buyer_state))}</span> : "—"}</td>
                  <td><MoneyPill state={String(b.latest_money_state || "")} recovery={Number(b.in_recovery || 0)} /></td>
                  <td>{timeAgo(b.last_activity_at || b.last_join_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MoneyPill({ state, recovery }: { state: string; recovery: number }) {
  const good = ["ChargedSuccess", "RecoveredCharge"].includes(state);
  const risk = state === "ChargeFailedRecovery";
  return (
    <span className={`status small ${good ? "Completed" : risk ? "CompletionWindow" : "ClosedForJoining"}`}>
      {state ? moneyStateLabel(state) : "—"}{recovery > 0 && !risk ? ` (${num(recovery)} בהשלמה)` : ""}
    </span>
  );
}

// ── growth (global virality) ───────────────────────────────────────────────
// SPRINT 4 (A8) — WINDOWED virality. The selected range (default 7 days;
// 7 / 30 / 90 / custom Israel-local days / all time) drives the actual
// numbers; the lifetime rollup is a separate block labelled as lifetime so no
// card silently mixes windows.
function GrowthScreen({ navigate }: { navigate: (h: string) => void }) {
  const [range, setRange] = useState<GrowthRange>(DEFAULT_GROWTH_RANGE);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customError, setCustomError] = useState("");
  const params = useMemo(() => growthRangeParams(range, israelPartsToUtcIso), [range]);
  const { data, error } = useFetch(() => api.adminGrowth(params), [params], 60_000);
  const applyCustom = () => {
    const problem = validateCustomRange(customFrom, customTo);
    setCustomError(problem || "");
    if (!problem) setRange({ kind: "custom", from: customFrom, to: customTo });
  };
  const w = ((data as Json)?.windowed || null) as Json | null;
  const lifetime = ((data as Json)?.lifetime?.metrics || (data as Json)?.platform?.metrics || null) as Json | null;
  const windowLabel = growthRangeLabel(range);
  return (
    <>
      <h1>ויראליות</h1>
      <div className="panel" data-testid="growth-range">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="small muted">טווח זמן:</span>
          {GROWTH_RANGE_PRESETS.map((p) => (
            <button key={p.days} type="button" className={`chip-btn${range.kind === "days" && range.days === p.days ? " active" : ""}`}
              data-testid={`growth-range-${p.days}`} onClick={() => { setCustomOpen(false); setRange({ kind: "days", days: p.days }); }}>
              {p.label}
            </button>
          ))}
          <button type="button" className={`chip-btn${range.kind === "custom" || customOpen ? " active" : ""}`} data-testid="growth-range-custom"
            onClick={() => setCustomOpen((v) => !v)}>טווח מותאם</button>
          <button type="button" className={`chip-btn${range.kind === "all" ? " active" : ""}`} data-testid="growth-range-all"
            onClick={() => { setCustomOpen(false); setRange({ kind: "all" }); }}>כל הזמן</button>
        </div>
        {customOpen ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }} data-testid="growth-custom-range">
            <div className="field" style={{ marginBottom: 0, flex: "1 1 150px" }}>
              <label>מתאריך</label>
              <input type="date" dir="ltr" data-testid="growth-custom-from" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0, flex: "1 1 150px" }}>
              <label>עד תאריך</label>
              <input type="date" dir="ltr" data-testid="growth-custom-to" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
            <button type="button" className="btn btn-sm btn-primary" data-testid="growth-custom-apply" onClick={applyCustom}>הצגה</button>
            {customError ? <span className="small" style={{ color: "var(--pomegranate)", flexBasis: "100%" }} data-testid="growth-custom-error">{customError}</span> : null}
            <span className="hint" style={{ flexBasis: "100%" }}>ימים שלמים לפי שעון ישראל.</span>
          </div>
        ) : null}
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }} data-testid="growth-window-label" data-window-kind={range.kind}>
          מוצג: <b>{windowLabel}</b>
        </p>
      </div>
      {error ? <Err msg={error} /> : null}
      {!data ? <Spinner /> : null}
      {w ? (
        <>
          <div className="stat-row" data-testid="growth-windowed">
            <StatTile num={num(w.joins || 0)} label={`הצטרפויות (${windowLabel})`} />
            <StatTile num={num(w.attributed_joins || 0)} label="הצטרפויות משיתוף" tone="good" />
            <StatTile num={String(w.viral_coefficient ?? 0)} label="מקדם ויראלי בטווח" />
            <StatTile num={pct(w.viral_share_of_joins || 0)} label="שיעור הצטרפויות משיתוף" />
            <StatTile num={ils(w.attributed_charged_gmv || 0)} label="GMV מחויב שמקורו בשיתוף" tone="good" />
            <StatTile num={num(w.attributed_charged_units || 0)} label="יחידות מחויבות משיתוף" />
          </div>
          <div className="stat-row">
            <StatTile num={num(w.personal_links || 0)} label="לינקים אישיים שנוצרו" />
            <StatTile num={num(w.sharing_participants || 0)} label="משתתפים שהביאו חברים" />
            <StatTile num={num(w.share_button_clicks || 0)} label="לחיצות על כפתור שיתוף" />
            <StatTile num={num(w.link_entries || 0)} label="כניסות מלינקים" />
            <StatTile num={num(w.deal_views || 0)} label="צפיות בעסקאות" />
            <StatTile num={num(w.max_generation || 0)} label="עומק שרשרת בטווח" />
          </div>
          {(w.top_deals as Json[])?.length ? (
            <div className="panel">
              <div className="panel-title">עסקאות מובילות בויראליות ({windowLabel})</div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>עסקה</th><th className="num">הצטרפויות משיתוף</th><th className="num">יח׳ מחויבות</th><th className="num">GMV מחויב</th><th className="num">עומק</th></tr></thead>
                <tbody>{(w.top_deals as Json[]).map((t) => (
                  <tr key={t.deal_id} className="clickable" onClick={() => navigate(`#/admin/deal/${t.deal_id}`)}>
                    <td><b>{t.deal_title || t.deal_id}</b></td>
                    <td className="num">{num(t.attributed_participants)}</td>
                    <td className="num">{num(t.attributed_charged_units)}</td>
                    <td className="num">{ils(t.attributed_charged_gmv)}</td>
                    <td className="num">{num(t.max_generation)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          ) : <p className="muted small" data-testid="growth-window-empty">אין הצטרפויות משיתוף בטווח שנבחר.</p>}
          {(w.top_sellers as Json[])?.length ? (
            <div className="panel">
              <div className="panel-title">מוכרים מובילים בויראליות ({windowLabel})</div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>מוכר</th><th className="num">הצטרפויות משיתוף</th><th className="num">GMV מחויב משיתוף</th><th className="num">עסקאות</th></tr></thead>
                <tbody>{(w.top_sellers as Json[]).map((t) => (
                  <tr key={t.seller_id} className="clickable" onClick={() => navigate(`#/admin/seller/${encodeURIComponent(t.seller_id)}`)}>
                    <td><b>{t.seller_name || t.seller_id}</b></td>
                    <td className="num">{num(t.attributed_participants)}</td>
                    <td className="num">{ils(t.attributed_charged_gmv)}</td>
                    <td className="num">{num(t.deals)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          ) : null}
        </>
      ) : null}
      {data ? (
        <div className="panel" data-testid="growth-lifetime">
          <div className="panel-title">מצטבר מאז ההשקה (כל הזמן)</div>
          {!lifetime ? <p className="muted small">עדיין אין נתוני ויראליות מצטברים — הם יחושבו אוטומטית אחרי הצטרפויות.</p> : (
            <>
              <div className="stat-row">
                <StatTile num={String(lifetime.viral_coefficient ?? 0)} label="מקדם ויראלי (כל הזמן)" />
                <StatTile num={pct(lifetime.viral_share_of_joins || 0)} label="שיעור הצטרפויות משיתוף (כל הזמן)" />
                <StatTile num={pct(lifetime.viral_share_of_charged || 0)} label="שיעור חיובים משיתוף (כל הזמן)" />
                <StatTile num={ils(lifetime.attributed_charged_gmv || 0)} label="GMV מחויב משיתוף (כל הזמן)" />
                <StatTile num={num(lifetime.max_generation || 0)} label="עומק שרשרת מקסימלי (כל הזמן)" />
              </div>
              {(data as Json)?.lifetime?.computed_at ? (
                <p className="muted small" style={{ marginBottom: 0 }}>
                  חושב לאחרונה: {fmtDate(String((data as Json).lifetime.computed_at))}{(data as Json).lifetime.stale ? " · ממתין לחישוב מחדש" : ""}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

// ── operations / payments / notifications / support / system ───────────────
function JsonStatScreen({ title, fetcher, render }: { title: string; fetcher: () => Promise<Json>; render: (d: Json) => React.ReactNode }) {
  const { data, error } = useFetch(fetcher, [], 30_000);
  return (
    <>
      <h1>{title}</h1>
      <Err msg={error} />
      {!data ? <Spinner /> : render(data as Json)}
    </>
  );
}

function ageLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const s = Number(seconds);
  if (s < 60) return `${Math.round(s)} שנ׳`;
  if (s < 3600) return `${Math.round(s / 60)} דק׳`;
  return `${(s / 3600).toFixed(1)} שע׳`;
}

function OperationsScreen() {
  const { data, error, reload } = useFetch(() => api.adminOutboxStatus(), [], 15_000);
  if (error) return <><h1>תפעול — תור ו־Worker</h1><Err msg={error} /></>;
  if (!data) return <><h1>תפעול — תור ו־Worker</h1><Spinner /></>;
  const d = data as Json;
  const o = d.outbox || {};
  const w = d.worker || {};
  const instances: Json[] = w.instances || [];
  const dlq = Number(o.dlq || 0);
  const stuck = Number(o.stuck_candidates || 0);
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>תפעול — תור ו־Worker</h1>
        <button className="btn btn-sm btn-ghost" onClick={reload}>רענון</button>
      </div>
      <div className="stat-row">
        <StatTile num={w.running ? "פעיל" : "לא מדווח"} label="Worker" tone={w.running ? "good" : "bad"} sub={`${num(w.active_count || 0)} מופעים`} />
        <StatTile num={num(o.due_now ?? o.pending ?? 0)} label="לביצוע עכשיו (תור פעיל)" tone={Number(o.due_now ?? 0) > 20 ? "warn" : undefined} />
        <StatTile num={num(o.scheduled_future ?? 0)} label="מתוזמן לעתיד" sub={o.next_scheduled_in_s != null ? `הבא בעוד ${ageLabel(o.next_scheduled_in_s)}` : "אין"} />
        <StatTile num={num(o.processing || 0)} label="בעיבוד כעת" />
        <StatTile num={num(o.sent || 0)} label="הושלמו" tone="good" />
      </div>
      <div className="stat-row">
        <StatTile num={num(o.failed || 0)} label="נכשלו" tone={Number(o.failed) > 0 ? "warn" : undefined} />
        <StatTile num={num(dlq)} label="DLQ (מכתבים מתים)" tone={dlq > 0 ? "bad" : "good"} />
        <StatTile num={num(stuck)} label="חכירות תקועות" tone={stuck > 0 ? "warn" : "good"} sub={`סף ${num((o.stuck_timeout_ms || 0) / 1000)} שנ׳`} />
        <StatTile num={ageLabel(o.oldest_due_age_s)} label="הממתין הוותיק (לביצוע)" tone={Number(o.oldest_due_age_s) > 300 ? "warn" : undefined} />
      </div>
      {Number(o.scheduled_future ?? 0) > 0 && Number(o.due_now ?? 0) === 0 ? (
        <div className="notice info">כל {num(o.scheduled_future)} העבודות הממתינות מתוזמנות לעתיד (למשל בדיקות דדליין) — זו עבודה מתוזמנת, לא צבר תקוע.</div>
      ) : null}
      <div className="panel">
        <div className="panel-title">מופעי Worker (heartbeat)</div>
        {instances.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>מזהה Worker</th><th>סטטוס</th><th>דופק אחרון</th><th>הופעל</th><th>רענון</th></tr></thead>
            <tbody>{instances.map((r) => (
              <tr key={r.worker_id}>
                <td dir="ltr" className="small">{r.worker_id}</td>
                <td><span className={`status ${r.status === "ready" ? "Completed" : "ClosedForJoining"}`}>{r.status}</span></td>
                <td>{timeAgo(r.heartbeat_at)}</td>
                <td>{timeAgo(r.started_at)}</td>
                <td>{r.fresh ? <span className="vbadge ok">✓ טרי</span> : <span className="vbadge no">○ ישן</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <EmptyState icon="⚙️" title="אין מופעי Worker מדווחים" body="אם ה־Worker רץ, ה־heartbeat יופיע תוך שניות." />}
      </div>
      {dlq > 0 ? <div className="notice err">יש {num(dlq)} עבודות ב־DLQ — נדרשת בדיקה ידנית. ה־Worker ריבוני; אין פעולות המשנות DealState כאן.</div> : null}
    </>
  );
}

function PaymentsScreen() {
  const { data, error } = useFetch(() => api.adminPaymentOps(), [], 30_000);
  if (error) return <><h1>תשלומים וסליקה</h1><Err msg={error} /></>;
  if (!data) return <><h1>תשלומים וסליקה</h1><Spinner /></>;
  const d = data as Json;
  const prov = d.provider || {};
  const synthetic = String(prov.mode || prov.provider_mode || "").match(/mock|synthetic|demo|internal/i) || String(prov.provider || "").match(/mock/i);
  const ledger = d.fee_ledger || {};
  const attempts: Json[] = d.recent_attempts || [];
  const ledgerRows: Json[] = d.recent_ledger || [];
  const byType: Json[] = d.attempts_by_type || [];
  const resultTone = (rc: string) => rc === "success" ? "Completed" : rc === "permanent_fail" ? "Failed" : rc === "temporary_fail" ? "CompletionWindow" : "ClosedForJoining";
  return (
    <>
      <h1>תשלומים וסליקה</h1>
      <div className={`notice ${synthetic ? "info" : "err"}`}>
        {synthetic
          ? <><b>ספק סינתטי / MOCKPAY</b> — כל הסכומים כאן הם כסף בדיקה סינתטי, לא מזומן אמיתי שהתקבל. ספק אמיתי: 0 קריאות.</>
          : <><b>ספק אמיתי פעיל:</b> {String(prov.provider || "")} · {String(prov.mode || "")}</>}
      </div>
      <div className="stat-row">
        <StatTile num={ils(ledger.gross_charged || 0)} label={synthetic ? "ברוטו סינתטי שנגבה" : "ברוטו שנגבה"} tone="good" />
        <StatTile num={ils(ledger.fee_total || 0)} label="עמלת C-ton (בסיס+מע״מ)" sub={`בסיס ${ils(ledger.fee_base || 0)} · מע״מ ${ils(ledger.fee_vat || 0)}`} />
        <StatTile num={num(ledger.entries || 0)} label="רשומות ליבון (ledger)" />
        <StatTile num={num(ledger.refund_entries || 0)} label="החזרים" tone={Number(ledger.refund_entries) > 0 ? "warn" : undefined} />
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>{ledger.note}</p>
      <div className="panel">
        <div className="panel-title">ניסיונות חיוב לפי סוג</div>
        {byType.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>סוג</th><th className="num">הצלחות</th><th className="num">כשל זמני</th><th className="num">כשל קבוע</th><th className="num">לא ידוע</th></tr></thead>
            <tbody>{byType.map((r) => (
              <tr key={r.attempt_type}>
                <td dir="ltr">{r.attempt_type}</td>
                <td className="num" style={{ color: "var(--success)" }}>{num(r.success)}</td>
                <td className="num">{num(r.temporary_fail)}</td>
                <td className="num" style={{ color: Number(r.permanent_fail) > 0 ? "var(--pomegranate)" : undefined }}>{num(r.permanent_fail)}</td>
                <td className="num">{num(r.unknown)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted small">אין עדיין ניסיונות חיוב.</p>}
      </div>
      <div className="panel">
        <div className="panel-title">ניסיונות חיוב אחרונים (עם מזהי קורלציה)</div>
        {attempts.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>מתי</th><th>עסקה</th><th>קונה</th><th>סוג</th><th>תוצאה</th><th>מזהה קורלציה</th></tr></thead>
            <tbody>{attempts.map((r) => (
              <tr key={r.attempt_id}>
                <td>{fmtDate(r.created_at)}</td>
                <td className="small">{r.deal_title || (r.deal_id ? String(r.deal_id).slice(0, 8) : "—")}</td>
                <td className="small">{r.buyer_name || "—"}</td>
                <td dir="ltr" className="small">{r.attempt_type}</td>
                <td><span className={`status small ${resultTone(String(r.result_class))}`}>{r.result_class}</span></td>
                <td dir="ltr" className="small mono">{String(r.correlation_id || "").slice(0, 40)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted small">אין עדיין ניסיונות חיוב.</p>}
      </div>
      {ledgerRows.length ? (
        <div className="panel">
          <div className="panel-title">רשומות ליבון עמלה אחרונות</div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>מתי</th><th>עסקה</th><th>סוג</th><th className="num">ברוטו</th><th className="num">עמלת C-ton</th><th>קורלציה</th></tr></thead>
            <tbody>{ledgerRows.map((r, i) => (
              <tr key={i}>
                <td>{fmtDate(r.created_at)}</td>
                <td className="small">{r.deal_title || "—"}</td>
                <td dir="ltr" className="small">{r.event_type}</td>
                <td className="num">{ils(r.gross_amount)}</td>
                <td className="num">{ils(r.platform_fee_total_amount)}</td>
                <td dir="ltr" className="small mono">{String(r.correlation_id || "").slice(0, 30)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      ) : null}
    </>
  );
}

const NOTIF_STATUS_TONE: Record<string, string> = { sent: "Completed", failed: "Failed", pending: "ClosedForJoining", processing: "CompletionWindow", skipped: "Draft", cancelled: "Cancelled" };

function NotificationsScreen() {
  const { data, error } = useFetch(() => api.adminNotificationsStatus(), [], 30_000);
  const [filter, setFilter] = useState("all");
  if (error) return <><h1>התראות</h1><Err msg={error} /></>;
  if (!data) return <><h1>התראות</h1><Spinner /></>;
  const d = data as Json;
  const n = d.notifications || {};
  const prov = n.provider || {};
  const logOnly = !prov.external_delivery;
  const events: Json[] = (d.recent_events || []).filter((e: Json) => filter === "all" || e.status === filter);
  return (
    <>
      <h1>התראות</h1>
      <div className={`notice ${logOnly ? "info" : "err"}`}>
        {logOnly
          ? <><b>LOG-ONLY / סינתטי</b> — התראות נרשמות ביומן בלבד ואינן נשלחות לקונים אמיתיים. SMS/מייל אמיתיים: 0.</>
          : <><b>שליחה אמיתית פעילה:</b> {String(prov.code)} · {String(prov.mode)}</>}
      </div>
      <div className="stat-row">
        <StatTile num={num(n.sent || 0)} label={logOnly ? "עובדו (log-only)" : "נשלחו"} tone="good" />
        <StatTile num={num(n.pending || 0)} label="ממתינים" tone={Number(n.pending) > 20 ? "warn" : undefined} />
        <StatTile num={num(n.failed || 0)} label="נכשלו" tone={Number(n.failed) > 0 ? "bad" : "good"} />
        <StatTile num={num(n.skipped || 0)} label="דולגו" />
        <StatTile num={ageLabel(n.oldest_pending_age_s)} label="ממתין ותיק" />
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {["all", "sent", "pending", "failed", "skipped"].map((f) => (
          <button key={f} className={`chip-btn${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f === "all" ? "הכל" : NOTIFICATION_STATUS_LABELS[f] || f}</button>
        ))}
      </div>
      <div className="panel">
        <div className="panel-title">אירועי התראה אחרונים</div>
        {events.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>מתי</th><th>סוג אירוע</th><th>נמען</th><th>ערוץ</th><th>אדפטר</th><th>סטטוס</th><th className="num">ניסיונות</th><th>עסקה</th><th>שגיאה אחרונה</th></tr></thead>
            <tbody>{events.map((e) => (
              <tr key={e.notification_id}>
                <td>{fmtDate(e.created_at)}</td>
                <td dir="ltr" className="small">{e.event_type}</td>
                <td className="small">{e.recipient_type}</td>
                <td className="small">{e.channel}</td>
                <td><span className="vbadge no" title="log-only synthetic adapter">{e.adapter}{e.adapter_mode && e.adapter_mode !== e.adapter ? `/${e.adapter_mode}` : ""}</span></td>
                <td><span className={`status small ${NOTIF_STATUS_TONE[String(e.status)] || "ClosedForJoining"}`}>{NOTIFICATION_STATUS_LABELS[String(e.status)] || e.status}</span></td>
                <td className="num">{num(e.attempts)}</td>
                <td className="small">{e.deal_title || "—"}</td>
                <td className="small" style={{ color: e.last_error ? "var(--pomegranate)" : undefined }}>{e.last_error || "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <EmptyState icon="🔔" title="אין אירועי התראה" body="התראות נוצרות אוטומטית מאירועי עסקה." />}
      </div>
    </>
  );
}

const CASE_TYPE_HE: Record<string, string> = {
  RefundRequest: "בקשת החזר",
  DeliveryIssue: "בעיית אספקה",
  SellerRisk: "סיכון מוכר",
  BuyerComplaint: "פניית קונה",
  PaymentMismatch: "אי-התאמת תשלום",
  InvoiceIssue: "בעיית חשבונית",
  ContentReport: "דיווח על תוכן",
  SystemException: "חריגת מערכת",
  Other: "אחר"
};
const CASE_STATUS_HE: Record<string, string> = {
  Open: "חדש",
  NeedsSeller: "ממתין למוכר",
  NeedsAdmin: "בטיפול",
  // P0.5: an admin customer-reply moves the case here — presented as answered
  WaitingExternal: "נענה — ממתין לפונה",
  Resolved: "נסגר בהצלחה",
  Closed: "נסגר"
};
const CASE_PRIORITY_HE: Record<string, string> = { Low: "נמוכה", Normal: "רגילה", High: "גבוהה", Urgent: "דחופה" };
const CASE_SOURCE_HE: Record<string, string> = { Admin: "צוות", Buyer: "קונה", Seller: "מוכר", System: "מערכת" };

// P0.5-3 — a support case is a conversation: open a case → see the customer's
// original message + the full thread → reply. A saved reply is presented
// HONESTLY: external email is disabled in this environment, so the UI never
// claims the customer received anything.
function SupportCaseDetail({ caseId, onBack }: { caseId: string; onBack: () => void }) {
  const { data, error, reload } = useFetch(() => api.adminSupportCase(caseId), [caseId]);
  const [replyText, setReplyText] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [sendError, setSendError] = useState("");

  if (error) return <><button className="btn btn-sm btn-ghost" onClick={onBack}>→ לרשימת הפניות</button><Err msg={error} /></>;
  if (!data) return <Spinner />;
  const c = (data as Json).case || {};
  const messages: Json[] = (data as Json).messages || [];

  const send = async () => {
    if (busy || replyText.trim().length < 2) return;
    setBusy(true); setSendError(""); setNotice("");
    try {
      const r = await api.adminSupportReply(caseId, { body: replyText.trim(), internal });
      setReplyText("");
      setNotice(internal
        ? "ההערה הפנימית נשמרה."
        : r.email_delivery?.note_he || "התשובה נשמרה. שליחת מייל חיצונית אינה פעילה כרגע בסביבה זו.");
      reload();
    } catch (e: any) { setSendError(e.message || "השליחה נכשלה"); }
    setBusy(false);
  };

  const setStatus = async (status: string, resolutionNote?: string) => {
    setBusy(true); setSendError("");
    try {
      await api.adminSupportCaseUpdate(caseId, resolutionNote ? { status, resolution_note: resolutionNote } : { status });
      reload();
    } catch (e: any) { setSendError(e.message || "עדכון הסטטוס נכשל"); }
    setBusy(false);
  };

  return (
    <div data-testid="support-case-detail">
      <button className="btn btn-sm btn-ghost" onClick={onBack}>→ לרשימת הפניות</button>
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{c.subject || "פנייה"}</h2>
          <span className={`status ${["Resolved", "Closed"].includes(String(c.status)) ? "Completed" : String(c.status) === "WaitingExternal" ? "TargetReached" : String(c.status) === "NeedsAdmin" ? "CompletionWindow" : "PendingTarget"}`} data-testid="case-status">
            {CASE_STATUS_HE[String(c.status)] || c.status}
          </span>
        </div>
        <div className="kv" style={{ marginTop: 10 }}>
          <span className="k">מס׳ פנייה</span><span className="v" dir="ltr">{String(c.case_id || "").slice(0, 8)}</span>
          <span className="k">קטגוריה</span><span className="v">{CASE_TYPE_HE[String(c.case_type)] || c.case_type}</span>
          <span className="k">מקור</span><span className="v">{CASE_SOURCE_HE[String(c.source)] || c.source}</span>
          <span className="k">עדיפות</span><span className="v">{CASE_PRIORITY_HE[String(c.priority)] || c.priority}</span>
          {c.buyer_ref ? (<><span className="k">אימייל הפונה</span><span className="v" dir="ltr">{c.buyer_ref}</span></>) : null}
          {c.deal_title ? (<><span className="k">עסקה</span><span className="v">{c.deal_title}</span></>) : null}
          <span className="k">נפתחה</span><span className="v">{fmtDate(c.created_at)}</span>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
          {String(c.status) !== "NeedsAdmin" && !["Resolved", "Closed"].includes(String(c.status)) ? (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setStatus("NeedsAdmin")}>סימון בטיפול</button>
          ) : null}
          {["Resolved", "Closed"].includes(String(c.status)) ? (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setStatus("NeedsAdmin")}>פתיחה מחדש</button>
          ) : (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => {
              const note = window.prompt("הערת סגירה (חובה):", "טופל מול הפונה");
              if (note && note.trim()) void setStatus("Resolved", note.trim());
            }}>סגירת הפנייה</button>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">💬 שיחה</div>
        <div className="case-thread" data-testid="case-thread">
          <div className="case-msg customer">
            <div className="case-msg-head">הפונה · {fmtDate(c.created_at)}</div>
            <div className="case-msg-body">{c.description || "—"}</div>
          </div>
          {messages.map((m) => (
            <div key={m.message_id} className={`case-msg ${m.sender_type === "Admin" ? "admin" : m.sender_type === "InternalNote" ? "internal" : "customer"}`}>
              <div className="case-msg-head">
                {m.sender_type === "Admin" ? "צוות C-ton" : m.sender_type === "InternalNote" ? "הערה פנימית (לא נשלחת לפונה)" : "הפונה"}
                {" · "}{fmtDate(m.created_at)}
                {m.sender_type === "Admin" ? (
                  <span className="case-delivery" data-testid="delivery-state">
                    {" · "}{String(m.delivery_status) === "Sent" ? "נשלח במייל" : String(m.delivery_status) === "Queued" ? "בתור לשליחה" : "נשמר (ללא שליחת מייל)"}
                  </span>
                ) : null}
              </div>
              <div className="case-msg-body">{m.body}</div>
            </div>
          ))}
        </div>
        <div className="case-composer">
          <textarea rows={3} placeholder="הקלדת תשובה…" value={replyText} maxLength={4000}
            onChange={(e) => setReplyText(e.target.value)} data-testid="reply-input" />
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
              <span>הערה פנימית בלבד (לא מיועדת לפונה)</span>
            </label>
            <button className="btn btn-primary" disabled={busy || replyText.trim().length < 2} data-testid="reply-send" onClick={() => { void send(); }}>
              {busy ? "שולחים…" : internal ? "שמירת הערה" : "שליחת תשובה"}
            </button>
          </div>
          {notice ? <div className="notice info" data-testid="reply-notice">{notice}</div> : null}
          {sendError ? <div className="notice err">{sendError}</div> : null}
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            שליחת מייל חיצונית אינה פעילה בסביבה זו — תשובות נשמרות בשרשור הפנייה בלבד.
          </p>
        </div>
      </div>
    </div>
  );
}

function SupportScreen() {
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  if (openCaseId) return <><h1>תמיכה ופניות</h1><SupportCaseDetail caseId={openCaseId} onBack={() => setOpenCaseId(null)} /></>;
  return <JsonStatScreen title="תמיכה ופניות" fetcher={() => api.adminSupportCases()} render={(d) => {
    const cases: Json[] = d.cases || d.support_cases || [];
    const summary = d.summary || {};
    return (
      <>
        <div className="stat-row">
          <StatTile num={num(summary.open_count || 0)} label="פניות פתוחות" />
          <StatTile num={num(summary.needs_admin_count || 0)} label="בטיפול הצוות" tone={Number(summary.needs_admin_count) > 0 ? "warn" : undefined} />
          <StatTile num={num(summary.urgent_count || 0)} label="דחופות" tone={Number(summary.urgent_count) > 0 ? "bad" : "good"} />
          <StatTile num={num(summary.older_than_48h_count || 0)} label="ממתינות מעל 48 שעות" tone={Number(summary.older_than_48h_count) > 0 ? "warn" : undefined} />
        </div>
        {cases.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>נושא</th><th>קטגוריה</th><th>מקור</th><th>עדיפות</th><th>סטטוס</th><th>פרטים</th><th>מתי</th><th /></tr></thead>
            <tbody>{cases.map((c, i) => (
              <tr key={c.case_id || i} className="case-row" onClick={() => setOpenCaseId(String(c.case_id))} style={{ cursor: "pointer" }}>
                <td><b>{c.subject || "—"}</b>{c.buyer_ref ? <div className="muted small" dir="ltr">{c.buyer_ref}</div> : null}</td>
                <td>{CASE_TYPE_HE[String(c.case_type)] || c.case_type}</td>
                <td>{CASE_SOURCE_HE[String(c.source)] || c.source}</td>
                <td>{CASE_PRIORITY_HE[String(c.priority)] || c.priority}</td>
                <td><span className={`status ${["Resolved", "Closed"].includes(String(c.status)) ? "Completed" : String(c.status) === "NeedsAdmin" ? "CompletionWindow" : "PendingTarget"}`}>{CASE_STATUS_HE[String(c.status)] || c.status}</span></td>
                <td className="small" style={{ maxWidth: 340, whiteSpace: "pre-wrap" }}>{String(c.description || "").slice(0, 220)}</td>
                <td>{fmtDate(c.created_at)}</td>
                <td><button className="btn btn-sm btn-ghost" data-testid="case-open" onClick={(e) => { e.stopPropagation(); setOpenCaseId(String(c.case_id)); }}>פתיחה ←</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <EmptyState icon="✅" title="אין פניות פתוחות" />}
      </>
    );
  }} />;
}

function AuditScreen() {
  const [q, setQ] = useState("");
  const { data, error } = useFetch(() => api.adminAudit(q), [q]);
  return (
    <>
      <h1>יומן פעולות</h1>
      <input placeholder="חיפוש פעולה / מזהה / correlation…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 14 }} />
      <Err msg={error} />
      {!data ? <Spinner /> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>מתי</th><th>עסקה</th><th>ישות</th><th>שינוי</th><th>פעולה</th></tr></thead>
          <tbody>{((data as Json).audit || []).map((a: Json) => (
            <tr key={a.audit_id}>
              <td>{fmtDate(a.created_at)}</td>
              <td>{a.deal_title || (a.deal_id ? String(a.deal_id).slice(0, 8) : "—")}</td>
              <td>{a.entity_type} · {a.state_type}</td>
              <td>{a.from_state} ← {a.to_state}</td>
              <td dir="ltr" className="small">{a.action_name}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function HealthDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`hdot ${ok ? "ok" : warn ? "warn" : "bad"}`} />;
}

function SafetyBadge({ on, label }: { on: boolean; label: string }) {
  return <span className={`safety-badge ${on ? "on" : "off"}`}>{label}: {on ? "ON" : "OFF"}</span>;
}

function SystemScreen() {
  const { data, error, reload } = useFetch(() => api.adminSystemStatus(), [], 20_000);
  if (error) return <><h1>בריאות המערכת</h1><Err msg={error} /></>;
  if (!data) return <><h1>בריאות המערכת</h1><Spinner /></>;
  const s = (data as Json).system_status || {};
  const counts = s.operational_counts || {};
  const storage = s.storage || {};
  const badges = s.safety_badges || {};
  const integ = s.integrations || {};
  const payment = integ.payment || {};
  const notif = integ.notifications || {};
  const appOk = s.app_health?.ok;
  const dbOk = true; // reaching this endpoint proves DB connectivity (it queried the DB)
  const dlq = Number(counts.dlq_count || 0);
  const activeOutbox = Number(counts.active_outbox || 0);
  const health = [
    { label: "Web (readiness)", ok: Boolean(appOk) },
    { label: "מסד נתונים (חיבור)", ok: dbOk },
    { label: "אחסון (Storage)", ok: Boolean(storage.durable), warn: !storage.durable },
    { label: "תור עבודות", ok: activeOutbox < 50, warn: activeOutbox >= 50 },
    { label: "DLQ", ok: dlq === 0, warn: false },
    { label: "מיגרציות/סכימה", ok: true }
  ];
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>בריאות המערכת</h1>
        <button className="btn btn-sm btn-ghost" onClick={reload}>רענון</button>
      </div>

      <div className="panel">
        <div className="panel-title">מצב בטיחות (Synthetic Safety)</div>
        <div className="safety-row">
          <SafetyBadge on={Boolean(badges.real_money)} label="Real Money" />
          <SafetyBadge on={Boolean(badges.grow)} label="Grow" />
          <SafetyBadge on={Boolean(badges.real_sms)} label="Real SMS" />
          <SafetyBadge on={Boolean(badges.real_email)} label="Real Email" />
          <SafetyBadge on={Boolean(badges.real_invoice)} label="Real Invoice" />
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>כל הדגלים אמורים להיות OFF בשלב זה. הם נגזרים ממצב הספקים בפועל, לא מקודדים ידנית.</p>
      </div>

      <div className="panel">
        <div className="panel-title">קונסולת בריאות</div>
        <div className="health-grid">
          {health.map((h) => (
            <div key={h.label} className="health-item">
              <HealthDot ok={h.ok} warn={h.warn} />
              <span>{h.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="stat-row">
        <StatTile num={num(activeOutbox)} label="עבודות פעילות בתור" tone={activeOutbox > 50 ? "warn" : undefined} />
        <StatTile num={num(dlq)} label="DLQ" tone={dlq > 0 ? "bad" : "good"} />
        <StatTile num={num(counts.failed_webhooks || 0)} label="Webhooks שנכשלו" tone={Number(counts.failed_webhooks) > 0 ? "warn" : undefined} />
        <StatTile num={num(counts.open_support_tickets || 0)} label="פניות תמיכה פתוחות" />
      </div>

      <div className="panel-grid-2">
        <div className="panel">
          <div className="panel-title">אחסון (Storage)</div>
          <div className="kv">
            <span className="k">ספק</span><span className="v" dir="ltr">{storage.provider || "—"}</span>
            <span className="k">אדפטר</span><span className="v" dir="ltr">{storage.adapter || "—"}</span>
            <span className="k">עמיד (durable)</span><span className="v">{storage.durable ? <span className="vbadge ok">✓ כן</span> : <span className="vbadge no">○ לא</span>}</span>
            <span className="k">בטוח לריבוי מופעים</span><span className="v">{storage.multi_instance_safe ? <span className="vbadge ok">✓ כן</span> : <span className="vbadge no">○ לא</span>}</span>
            <span className="k">סטטוס סקייל</span><span className="v" dir="ltr">{storage.scale_status || "—"}</span>
          </div>
        </div>
        <div className="panel">
          <div className="panel-title">ספקים ומצבי הפעלה</div>
          <div className="kv">
            <span className="k">תשלומים</span><span className="v" dir="ltr">{payment.provider || "—"} · {payment.mode || "—"}</span>
            <span className="k">התראות</span><span className="v" dir="ltr">{notif.provider || "—"} · {notif.external_delivery ? "external" : "log-only"}</span>
            <span className="k">מצב פריסה</span><span className="v" dir="ltr">{s.deployment?.mode || "—"}</span>
          </div>
        </div>
      </div>
      {Array.isArray(s.notes) && s.notes.length ? (
        <div className="panel">
          <div className="panel-title">הערות מערכת</div>
          <ul className="notes-list">{s.notes.map((note: string, i: number) => <li key={i}>{note}</li>)}</ul>
        </div>
      ) : null}
    </>
  );
}

// ── shell ──────────────────────────────────────────────────────────────────
// Grouped IA: commerce first (the operator's daily work), growth second,
// platform plumbing last.
const NAV_GROUPS: { label: string; items: [string, string][] }[] = [
  { label: "", items: [["overview", "תמונת מצב"]] },
  { label: "מסחר", items: [["deals", "עסקאות"], ["sellers", "מוכרים"], ["buyers", "קונים"]] },
  { label: "צמיחה", items: [["growth", "ויראליות"]] },
  { label: "תפעול", items: [["operations", "תור ו-Worker"], ["payments", "תשלומים"], ["notifications", "התראות"], ["support", "תמיכה"]] },
  { label: "מערכת", items: [["audit", "יומן פעולות"], ["system", "בריאות מערכת"]] }
];

export function AdminArea({ sub, navigate }: { sub: string[]; navigate: (h: string) => void }) {
  const [authed, setAuthed] = useState(Boolean(getAdminToken()));
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    if (!authed) return;
    api.adminMe().then(() => setVerified(true)).catch((e: any) => {
      if (e.status === 401 || e.status === 403) { revokeSurface("admin"); setAuthed(false); }
      else setVerified(true); // network hiccup: keep the shell, screens will surface errors
    });
  }, [authed]);

  if (!authed) return <AdminLogin onDone={() => { setAuthed(true); }} />;
  if (!verified) return <Spinner label="מאמתים הרשאות…" />;

  const [screenRaw, param] = sub.length ? sub : ["overview"];
  const screen = screenRaw || "overview";
  const stateParam = typeof window !== "undefined" && window.location.hash.includes("state=")
    ? new URLSearchParams(window.location.hash.split("?")[1] || "").get("state") || undefined
    : undefined;

  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="ניווט ניהול">
        <div className="admin-nav-title"><BrandMark size={26} /> C-ton · ניהול</div>
        {NAV_GROUPS.map((group) => (
          <React.Fragment key={group.label || "root"}>
            {group.label ? <div className="admin-nav-group">{group.label}</div> : null}
            {group.items.map(([key, label]) => (
              <button key={key} className={screen.startsWith(key) || (key === "deals" && screen === "deal") || (key === "sellers" && screen === "seller") ? "active" : ""} onClick={() => navigate(`#/admin/${key}`)}>
                {label}
              </button>
            ))}
          </React.Fragment>
        ))}
        <button style={{ marginTop: "auto", opacity: .7 }} data-testid="admin-lock" onClick={() => { lockAdmin(); window.location.hash = "#/"; window.location.reload(); }}>נעילת מנהל</button>
        <button style={{ opacity: .7 }} onClick={() => { clearAuthSession(); clearOwnerSession(); window.location.hash = "#/"; window.location.reload(); }}>יציאה</button>
      </nav>
      <main className="admin-main">
        {screen === "overview" ? <Overview navigate={navigate} /> : null}
        {screen === "deals" ? <DealsScreen navigate={navigate} initialState={stateParam} /> : null}
        {screen === "deal" && param ? <DealDetail dealId={param} navigate={navigate} /> : null}
        {screen === "sellers" ? <SellersScreen navigate={navigate} /> : null}
        {screen === "seller" && param ? <SellerDetail sellerId={decodeURIComponent(param)} navigate={navigate} /> : null}
        {screen === "buyers" ? <BuyersScreen /> : null}
        {screen === "growth" ? <GrowthScreen navigate={navigate} /> : null}
        {screen === "operations" ? <OperationsScreen /> : null}
        {screen === "payments" ? <PaymentsScreen /> : null}
        {screen === "notifications" ? <NotificationsScreen /> : null}
        {screen === "support" ? <SupportScreen /> : null}
        {screen === "audit" ? <AuditScreen /> : null}
        {screen === "system" ? <SystemScreen /> : null}
      </main>
    </div>
  );
}
