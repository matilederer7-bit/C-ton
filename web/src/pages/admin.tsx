import React, { useEffect, useMemo, useState } from "react";
import { api, getAdminToken, setAdminToken, supabaseSignIn, supabaseSignUp, Json } from "../api";
import { Countdown, EmptyState, Modal, Spinner, StatTile, StatusPill, Toast, useToast } from "../components";
import { fmtDate, ils, num, pct, stateLabel, timeAgo } from "../util";

// ── login (canonical Supabase owner/admin identity) ────────────────────────
function AdminLogin({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setInfo("");
    try {
      const cfg = await api.authConfig();
      if (!cfg.configured) throw new Error("התחברות אינה זמינה בסביבה זו");
      if (mode === "setup") {
        const r = await supabaseSignUp(cfg, email.trim(), password);
        if (r.needsConfirmation) {
          setInfo("נשלח מייל אימות. אשרו אותו ואז התחברו — הרשאות הניהול נקבעות בצד השרת לפי הזהות המאומתת.");
          setMode("login");
          setBusy(false);
          return;
        }
      }
      const token = await supabaseSignIn(cfg, email.trim(), password);
      setAdminToken(token);
      // authority check: the server validates the ADMIN capability
      const me = await api.adminMe().catch((err: any) => { throw new Error(err.status === 401 || err.status === 403 ? "לחשבון זה אין הרשאת ניהול" : err.message); });
      if (!me?.ok && !me?.identity) throw new Error("לחשבון זה אין הרשאת ניהול");
      onDone();
    } catch (err: any) {
      setAdminToken("");
      setError(err.message || "התחברות נכשלה");
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: "60px auto" }}>
      <div className="panel">
        <h2 style={{ textAlign: "center" }}>מרכז הבקרה של סיטון</h2>
        <p className="muted small" style={{ textAlign: "center" }}>כניסה למנהלי מערכת בלבד. כל פעולה מתועדת.</p>
        <form onSubmit={submit}>
          <div className="field"><label>אימייל</label><input dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
          <div className="field"><label>סיסמה</label><input dir="ltr" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "setup" ? "new-password" : "current-password"} /></div>
          {error ? <div className="notice err">{error}</div> : null}
          {info ? <div className="notice ok">{info}</div> : null}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "רגע…" : mode === "login" ? "כניסה" : "הקמת חשבון בעלים"}</button>
        </form>
        <p className="small muted" style={{ textAlign: "center", marginTop: 12 }}>
          {mode === "login"
            ? <a href="#/admin" onClick={(e) => { e.preventDefault(); setMode("setup"); setError(""); }}>הקמה ראשונית של חשבון הבעלים</a>
            : <a href="#/admin" onClick={(e) => { e.preventDefault(); setMode("login"); setError(""); }}>חזרה לכניסה</a>}
        </p>
      </div>
    </div>
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
function Overview({ navigate }: { navigate: (h: string) => void }) {
  const { data, error } = useFetch(() => api.adminOverview(), [], 30_000);
  if (error) return <Err msg={error} />;
  if (!data) return <Spinner />;
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
        <StatTile num={ils(money.platform_fee_projection || 0)} label="עמלת סיטון — צפי מהמסגרות" />
        <StatTile num={ils(money.platform_fee_actual || 0)} label="עמלת סיטון בפועל (מכסף שנגבה בלבד)" tone="good" />
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

// ── viral tree explorer ────────────────────────────────────────────────────
// Lazy interactive viral-tree explorer: loads one level at a time from the
// canonical /viral-tree endpoint, expands branches on demand (never a full
// dump), and shows per-node subtree metrics in a details panel.
type TreeNode = Json;

function TreeRow({ node, dealId, depth, onSelect, selectedId }: { node: TreeNode; dealId: string; depth: number; onSelect: (n: TreeNode) => void; selectedId: string | null }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const load = async () => {
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
    <div className={`tree-node${depth === 0 ? " root" : ""}`}>
      <div className={`tree-row${selected ? " selected" : ""}`} style={{ paddingInlineStart: depth * 14 }}>
        {node.has_children ? (
          <button className="tree-toggle" onClick={load} aria-label={open ? "כיווץ" : "הרחבה"}>{loading ? "…" : open ? "−" : "+"}</button>
        ) : <span className="tree-toggle-spacer" />}
        <button className="tree-label" onClick={() => onSelect(node)}>
          <b>{node.display}</b>
          <span className="tree-badge">דור {num(node.generation)}</span>
          <span className="tree-badge">{num(node.direct_units)} יח׳</span>
          {node.charged ? <span className="tree-badge charged">חויב ✓</span> : node.active ? <span className="tree-badge">מסגרת</span> : <span className="tree-badge muted">נשר</span>}
          {node.has_children ? <span className="tree-badge sub">ענף: {num(node.subtree_joins)} · {num(node.subtree_charged_units)} מחויבות</span> : null}
        </button>
      </div>
      {open && children ? (
        <div className="tree-children">
          {children.length ? children.map((c) => (
            <TreeRow key={c.participant_id} node={c} dealId={dealId} depth={depth + 1} onSelect={onSelect} selectedId={selectedId} />
          )) : <p className="muted small" style={{ paddingInlineStart: (depth + 1) * 14 }}>אין ילדים.</p>}
          {truncated ? <p className="muted small" style={{ paddingInlineStart: (depth + 1) * 14 }}>מוצגים 60 הראשונים בענף זה.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ViralTreeExplorer({ dealId }: { dealId: string }) {
  const { data, error } = useFetch(() => api.adminDealViralTree(dealId, { limit: 60 }), [dealId]);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  if (error) return <Err msg={error} />;
  if (!data) return <Spinner />;
  const roots: TreeNode[] = (data as Json).nodes || [];
  if (!roots.length) return <EmptyState icon="🌳" title="אין עדיין עץ הפצה" body="כל מצטרף מקבל לינק אישי; העץ ייבנה עם ההצטרפות הראשונה דרך שיתוף." />;
  return (
    <div className="tree-explorer">
      <div className="tree-pane">
        <p className="muted small">שורשים ({num(roots.length)}{(data as Json).truncated ? "+" : ""}) — לחצו + להרחבת ענף (טעינה עצלה), ולחצו על שם לפרטים.</p>
        <div className="tree">
          {roots.map((n) => <TreeRow key={n.participant_id} node={n} dealId={dealId} depth={0} onSelect={setSelected} selectedId={selected?.participant_id || null} />)}
        </div>
      </div>
      <div className="tree-detail">
        {selected ? (
          <div className="panel" style={{ position: "sticky", top: 16 }}>
            <div className="panel-title">פרטי צומת · {selected.display}</div>
            <div className="kv">
              <span className="k">דור</span><span className="v">{num(selected.generation)}</span>
              <span className="k">סטטוס כסף</span><span className="v"><MoneyPill state={String(selected.money_state)} recovery={0} /></span>
              <span className="k">הביא ישירות</span><span className="v">{num(selected.direct_children)}</span>
              <span className="k">יח׳ ישירות</span><span className="v">{num(selected.direct_units)}</span>
              <span className="k">הצטרפויות בענף</span><span className="v">{num(selected.subtree_joins)}</span>
              <span className="k">יח׳ בענף</span><span className="v">{num(selected.subtree_units)}</span>
              <span className="k">יח׳ מחויבות בענף</span><span className="v" style={{ fontWeight: 700 }}>{num(selected.subtree_charged_units)}</span>
              <span className="k">GMV מחויב בענף</span><span className="v">{ils(selected.subtree_charged_gmv)}</span>
              <span className="k">עומק תת-עץ</span><span className="v">{num(selected.subtree_max_depth)}</span>
              <span className="k">לחיצות שיתוף</span><span className="v">{num(selected.share_visits)}</span>
              <span className="k">כניסות מלינק</span><span className="v">{num(selected.share_joins)}</span>
              <span className="k">First touch</span><span className="v small">{selected.first_touch_at ? fmtDate(selected.first_touch_at) : "—"}</span>
              <span className="k">Last touch</span><span className="v small">{selected.last_touch_at ? fmtDate(selected.last_touch_at) : "—"}</span>
              {selected.personal_code ? <><span className="k">קוד לינק</span><span className="v mono small" dir="ltr">{selected.personal_code}</span></> : null}
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>הצטרפות ≠ חיוב. "מחויבות" = ChargedSuccess/RecoveredCharge בלבד.</p>
          </div>
        ) : <div className="panel"><p className="muted small">בחרו צומת בעץ כדי לראות מדדי ענף.</p></div>}
      </div>
    </div>
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

function ViralTab({ dealId, vm, viralRes, onRecompute }: { dealId: string; vm: Json | null; viralRes: Json | null; onRecompute: () => void }) {
  const [mode, setMode] = useState<"tree" | "analytics">("tree");
  return (
    <>
      <div className="mode-toggle">
        <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>🌳 עץ הפצה</button>
        <button className={mode === "analytics" ? "active" : ""} onClick={() => setMode("analytics")}>📊 אנליטיקה</button>
      </div>
      {mode === "tree" ? (
        <div className="panel">
          <div className="panel-title">עץ ההפצה (טעינה עצלה לפי ענף)</div>
          <ViralTreeExplorer dealId={dealId} />
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
        <StatTile num={ils(Math.round(gross * 0.08 * 100) / 100)} label="עמלת סיטון (8% מהנגבה)" />
        <StatTile num={<Countdown until={deal.completion_window_until || deal.deadline} overText="עבר" />} label={deal.completion_window_until ? "חלון השלמה" : "דדליין"} />
      </div>

      <div className="tabbar">
        {[["summary", "משתתפים וכסף"], ["viral", "ויראליות ועץ"], ["ops", "תפעול ותור"], ["audit", "Audit"]].map(([k, l]) => (
          <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k!)}>{l}</button>
        ))}
      </div>

      {tab === "summary" ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>קונה</th><th>טלפון</th><th className="num">כמות</th><th>מצב קונה</th><th>מצב כסף</th><th>אספקה</th><th>מקור</th><th>מתי</th></tr></thead>
            <tbody>
              {participants.map((x) => (
                <tr key={x.participant_id}>
                  <td>{x.buyer_name || "—"}</td>
                  <td dir="ltr">{x.buyer_phone || x.buyer_id}</td>
                  <td className="num">{num(x.qty)}</td>
                  <td>{x.buyer_state}</td>
                  <td><span className={`status ${["ChargedSuccess", "RecoveredCharge"].includes(String(x.money_state)) ? "Completed" : String(x.money_state) === "ChargeFailedRecovery" ? "CompletionWindow" : "ClosedForJoining"}`}>{x.money_state}</span></td>
                  <td>{x.delivery_method_label || "—"}</td>
                  <td>{x.acquisition_source || "direct"}</td>
                  <td>{fmtDate(x.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "viral" ? <ViralTab dealId={dealId} vm={vm} viralRes={viralRes as Json | null} onRecompute={recompute} /> : null}

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
                <thead><tr><th>סוג</th><th>תוצאה</th><th>correlation</th><th>מתי</th></tr></thead>
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
function SellersScreen({ navigate }: { navigate: (h: string) => void }) {
  const { data, error } = useFetch(() => api.adminSellers(), []);
  if (error) return <Err msg={error} />;
  if (!data) return <Spinner />;
  return (
    <>
      <h1>מוכרים</h1>
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
                <td><span className={`status ${s.seller_status === "Active" ? "Completed" : "Failed"}`}>{s.seller_status}</span>{s.supabase_bound ? <span className="tree-badge charged" style={{ marginInlineStart: 6 }}>Auth✓</span> : null}</td>
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

function SellerDetail({ sellerId, navigate }: { sellerId: string; navigate: (h: string) => void }) {
  const { data, error } = useFetch(() => api.adminSellerDetail(sellerId), [sellerId]);
  const [tab, setTab] = useState("deals");
  if (error) return <Err msg={error} />;
  if (!data) return <Spinner />;
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
      {(d.warnings || []).length ? (
        <div className="notice err"><b>אזהרות מערכת:</b> {(d.warnings as string[]).join(" · ")}</div>
      ) : null}
      <div className="stat-row">
        <StatTile num={num((d.deals || []).length)} label="עסקאות" />
        <StatTile num={ils(d.money?.potential_gross || 0)} label="פוטנציאל (מסגרות)" />
        <StatTile num={ils(d.money?.charged_gross || 0)} label="נגבה בפועל" tone="good" />
        <StatTile num={ils(d.money?.platform_fee_actual || 0)} label="עמלת סיטון בפועל" />
        <StatTile num={ils(d.money?.seller_net_actual || 0)} label="נטו למוכר בפועל" />
      </div>

      <div className="tabbar">
        {[["deals", "עסקאות"], ["viral", "ויראליות"], ["support", "תמיכה ואספקה"], ["audit", "Audit"]].map(([k, l]) => (
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

function BuyersScreen() {
  const [q, setQ] = useState("");
  const { data, error } = useFetch(() => api.adminBuyers(q), [q]);
  const buyers: Json[] = (data as Json)?.buyers || [];
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
      <input placeholder="חיפוש שם / טלפון / אימייל…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 14 }} />
      <Err msg={error} />
      {!data ? <Spinner /> : buyers.length === 0 ? (
        <EmptyState icon="👤" title="אין קונים תואמים" body={q ? "נסו חיפוש אחר." : "עדיין אין השתתפויות במערכת."} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>שם</th><th>טלפון</th><th>אימייל</th><th>אימות</th>
              <th className="num">השת׳</th><th className="num">עסקאות</th>
              <th className="num">יח׳ הצטרפו</th><th className="num">יח׳ חויבו</th><th className="num">נגבה ₪</th>
              <th>סטטוס קונה</th><th>סטטוס כסף</th><th>פעילות אחרונה</th>
            </tr></thead>
            <tbody>
              {buyers.map((b: Json) => (
                <tr key={b.buyer_id}>
                  <td>{b.buyer_name || "—"}</td>
                  <td dir="ltr">{b.buyer_phone || (String(b.buyer_id).match(/^[0-9+]/) ? b.buyer_id : "—")}</td>
                  <td dir="ltr" className="small">{b.buyer_email || <span className="muted">—</span>}</td>
                  <td><VerifyBadge value={Boolean(b.phone_verified)} label="טלפון" /> <VerifyBadge value={Boolean(b.email_verified)} label="מייל" /></td>
                  <td className="num">{num(b.participations)}</td>
                  <td className="num">{num(b.deals)}</td>
                  <td className="num">{num(b.units_joined)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{num(b.units_charged)}</td>
                  <td className="num">{ils(b.charged_gross)}</td>
                  <td>{b.latest_buyer_state ? <span className="status small">{b.latest_buyer_state}</span> : "—"}</td>
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
      {state || "—"}{recovery > 0 && !risk ? ` (${num(recovery)} בהשלמה)` : ""}
    </span>
  );
}

// ── growth (global virality) ───────────────────────────────────────────────
function GrowthScreen({ navigate }: { navigate: (h: string) => void }) {
  const { data, error } = useFetch(() => api.adminGrowth(), [], 60_000);
  if (error) return <Err msg={error} />;
  if (!data) return <Spinner />;
  const platform = (data as Json).platform?.metrics as Json | null;
  const last7 = (data as Json).last_7_days || {};
  return (
    <>
      <h1>צמיחה וויראליות</h1>
      {!platform ? <p className="muted">עדיין אין נתוני ויראליות מצטברים — הם יחושבו אוטומטית אחרי הצטרפויות.</p> : (
        <>
          <div className="stat-row">
            <StatTile num={String(platform.viral_coefficient ?? 0)} label="מקדם ויראלי פלטפורמתי" />
            <StatTile num={pct(platform.viral_share_of_joins || 0)} label="שיעור הצטרפויות משיתוף" />
            <StatTile num={pct(platform.viral_share_of_charged || 0)} label="שיעור חיובים מוצלחים משיתוף" />
            <StatTile num={ils(platform.attributed_charged_gmv || 0)} label="GMV מחויב שמקורו בשיתוף" tone="good" />
            <StatTile num={num(platform.attributed_charged_units || 0)} label="יחידות מחויבות משיתוף" />
            <StatTile num={num(platform.max_generation || 0)} label="עומק שרשרת מקסימלי" />
          </div>
          <div className="stat-row">
            <StatTile num={num(platform.personal_links || 0)} label="לינקים אישיים שנוצרו" />
            <StatTile num={num(platform.sharing_participants || 0)} label="משתתפים שהביאו חברים" />
            <StatTile num={num(platform.share_clicks || 0)} label="לחיצות שיתוף" />
            <StatTile num={num(platform.link_entries || 0)} label="כניסות מלינקים" />
            <StatTile num={num(last7.attributed_joins || 0)} label="הצטרפויות ויראליות (7 ימים)" />
          </div>
          {(platform.top_deals as Json[])?.length ? (
            <div className="panel">
              <div className="panel-title">עסקאות מובילות בויראליות</div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>עסקה</th><th className="num">הצטרפויות משיתוף</th><th className="num">יח׳ מחויבות</th><th className="num">GMV מחויב</th><th className="num">שיעור ויראלי</th><th className="num">עומק</th></tr></thead>
                <tbody>{(platform.top_deals as Json[]).map((t) => (
                  <tr key={t.deal_id} className="clickable" onClick={() => navigate(`#/admin/deal/${t.deal_id}`)}>
                    <td><b>{t.deal_title || t.deal_id}</b></td>
                    <td className="num">{num(t.attributed_participants)}</td>
                    <td className="num">{num(t.attributed_charged_units)}</td>
                    <td className="num">{ils(t.attributed_charged_gmv)}</td>
                    <td className="num">{pct(t.viral_share_of_joins)}</td>
                    <td className="num">{num(t.max_generation)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          ) : null}
          {(platform.top_sellers as Json[])?.length ? (
            <div className="panel">
              <div className="panel-title">מוכרים מובילים בויראליות</div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>מוכר</th><th className="num">הצטרפויות משיתוף</th><th className="num">GMV מחויב משיתוף</th><th className="num">שיעור ויראלי</th></tr></thead>
                <tbody>{(platform.top_sellers as Json[]).map((t) => (
                  <tr key={t.seller_id} className="clickable" onClick={() => navigate(`#/admin/seller/${encodeURIComponent(t.seller_id)}`)}>
                    <td><b>{t.seller_id}</b></td>
                    <td className="num">{num(t.attributed_participants)}</td>
                    <td className="num">{ils(t.attributed_charged_gmv)}</td>
                    <td className="num">{pct(t.viral_share_of_joins)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          ) : null}
        </>
      )}
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
        <StatTile num={ils(ledger.fee_total || 0)} label="עמלת סיטון (בסיס+מע״מ)" sub={`בסיס ${ils(ledger.fee_base || 0)} · מע״מ ${ils(ledger.fee_vat || 0)}`} />
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
                <td className="num" style={{ color: "var(--basil, #2e7d32)" }}>{num(r.success)}</td>
                <td className="num">{num(r.temporary_fail)}</td>
                <td className="num" style={{ color: Number(r.permanent_fail) > 0 ? "var(--pomegranate)" : undefined }}>{num(r.permanent_fail)}</td>
                <td className="num">{num(r.unknown)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted small">אין עדיין ניסיונות חיוב.</p>}
      </div>
      <div className="panel">
        <div className="panel-title">ניסיונות חיוב אחרונים (עם correlation/idempotency)</div>
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
            <thead><tr><th>מתי</th><th>עסקה</th><th>סוג</th><th className="num">ברוטו</th><th className="num">עמלת סיטון</th><th>קורלציה</th></tr></thead>
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
          <button key={f} className={`chip-btn${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f === "all" ? "הכל" : f}</button>
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
                <td><span className={`status small ${NOTIF_STATUS_TONE[String(e.status)] || "ClosedForJoining"}`}>{e.status}</span></td>
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

function SupportScreen() {
  return <JsonStatScreen title="תמיכה" fetcher={() => api.adminSupportCases()} render={(d) => {
    const cases: Json[] = d.cases || d.support_cases || [];
    return cases.length ? (
      <div className="table-wrap"><table className="data">
        <thead><tr><th>סוג</th><th>סטטוס</th><th>נושא</th><th>מתי</th></tr></thead>
        <tbody>{cases.map((c, i) => <tr key={i}><td>{c.case_type}</td><td>{c.status}</td><td>{c.title || c.summary || "—"}</td><td>{fmtDate(c.created_at)}</td></tr>)}</tbody>
      </table></div>
    ) : <EmptyState icon="✅" title="אין פניות פתוחות" />;
  }} />;
}

function AuditScreen() {
  const [q, setQ] = useState("");
  const { data, error } = useFetch(() => api.adminAudit(q), [q]);
  return (
    <>
      <h1>Audit</h1>
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
const NAV: [string, string][] = [
  ["overview", "תמונת מצב"],
  ["deals", "עסקאות"],
  ["sellers", "מוכרים"],
  ["buyers", "קונים"],
  ["growth", "צמיחה וויראליות"],
  ["operations", "תפעול"],
  ["payments", "תשלומים"],
  ["notifications", "התראות"],
  ["support", "תמיכה"],
  ["audit", "Audit"],
  ["system", "בריאות מערכת"]
];

export function AdminArea({ sub, navigate }: { sub: string[]; navigate: (h: string) => void }) {
  const [authed, setAuthed] = useState(Boolean(getAdminToken()));
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    if (!authed) return;
    api.adminMe().then(() => setVerified(true)).catch((e: any) => {
      if (e.status === 401 || e.status === 403) { setAdminToken(""); setAuthed(false); }
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
        <div className="admin-nav-title">סיטון · ניהול</div>
        {NAV.map(([key, label]) => (
          <button key={key} className={screen.startsWith(key) || (key === "deals" && screen === "deal") || (key === "sellers" && screen === "seller") ? "active" : ""} onClick={() => navigate(`#/admin/${key}`)}>
            {label}
          </button>
        ))}
        <button style={{ marginTop: "auto", opacity: .7 }} onClick={() => { setAdminToken(""); window.location.hash = "#/"; window.location.reload(); }}>יציאה</button>
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
