import React from "react";
import { Json } from "../api";
import { ils, num } from "../util";

// ── Seller Command Center panels (P0.4-2) ───────────────────────────────────
// Every figure comes from the canonical /api/seller/analytics payload — no
// second analytics universe, no fabricated values. Money semantics are
// explicit: POTENTIAL (held frames) ≠ CHARGED (actually collected) ≠ NET.

// tiny dependency-free bar chart (SVG) — value bars over day buckets
export function BarChart({ points, color = "var(--brand)", height = 72, formatValue }: {
  points: { day: string; value: number }[];
  color?: string;
  height?: number;
  formatValue?: (v: number) => string;
}) {
  if (!points.length) return <p className="muted small chart-empty">אין עדיין נתונים בתקופה שנבחרה.</p>;
  const max = Math.max(1, ...points.map((p) => p.value));
  const bw = 100 / points.length;
  return (
    <svg className="bar-chart" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label="גרף עמודות">
      {points.map((p, i) => {
        const h = Math.max(1.5, (p.value / max) * (height - 6));
        return (
          <rect key={p.day} x={i * bw + bw * 0.15} y={height - h} width={bw * 0.7} height={h} rx={1}
            fill={color} opacity={p.value === 0 ? 0.25 : 0.9}>
            <title>{`${p.day}: ${formatValue ? formatValue(p.value) : num(p.value)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function Kpi({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone?: "potential" | "charged" | "net" | "plain"; hint?: string }) {
  return (
    <div className={`kpi ${tone || "plain"}`} title={hint}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
    </div>
  );
}

export function KpiStrip({ analytics }: { analytics: Json }) {
  const s = analytics.summary || {};
  const o = analytics.overview || {};
  const m = analytics.money || {};
  return (
    <div className="kpi-strip" data-testid="kpi-strip">
      <div className="kpi-group">
        <div className="kpi-group-title">עסקאות</div>
        <div className="kpi-row">
          <Kpi label="פעילות" value={num(s.active_deals)} />
          <Kpi label="הושלמו" value={num(s.completed_deals)} />
          <Kpi label="לא הושלמו" value={num(Number(s.failed_deals || 0) + Number(s.cancelled_deals || 0))} />
          <Kpi label="טיוטות" value={num(s.draft_deals)} />
        </div>
      </div>
      <div className="kpi-group">
        <div className="kpi-group-title">קונים ויחידות</div>
        <div className="kpi-row">
          <Kpi label="מצטרפים" value={num(s.total_buyers)} />
          <Kpi label="יחידות שהוזמנו" value={num(s.total_joined_units)} tone="potential" />
          <Kpi label="יחידות שחויבו" value={num(s.total_charged_units)} tone="charged" />
        </div>
      </div>
      <div className="kpi-group">
        <div className="kpi-group-title">כסף — צפוי מול בפועל</div>
        <div className="kpi-row">
          <Kpi label="מחזור פוטנציאלי (מסגרות)" value={ils(o.gross_expected_amount)} tone="potential" hint="מסגרות שנתפסו — עדיין לא כסף שנגבה" />
          <Kpi label="מחזור שחויב בפועל" value={ils(s.gross_collected_total)} tone="charged" />
          <Kpi label="עמלת C-ton צפויה (8%)" value={ils(o.expected_platform_fee_total_amount)} tone="potential" />
          <Kpi label="עמלת C-ton בפועל" value={ils(m.platform_fee_total)} tone="charged" />
          <Kpi label="נטו צפוי למוכר" value={ils(o.expected_seller_net_amount)} tone="potential" />
          <Kpi label="נטו בפועל למוכר" value={ils(s.seller_net_total)} tone="net" />
        </div>
      </div>
    </div>
  );
}

const SEVERITY_ICON: Record<string, string> = { critical: "🚨", warning: "⚠️", info: "💡" };

export function ActionCenterPanel({ items, navigate }: { items: Json[]; navigate: (h: string) => void }) {
  if (!items?.length) {
    return (
      <div className="panel">
        <div className="panel-title">🎯 דורש טיפול</div>
        <p className="muted small" style={{ marginBottom: 0 }}>אין כרגע פעולות שדורשות טיפול — הכול תקין.</p>
      </div>
    );
  }
  const go = (item: Json) => {
    if (item.action === "open_business_profile") navigate("#/seller/profile");
    else if (item.deal_id) navigate(`#/seller/deal/${item.deal_id}`);
  };
  return (
    <div className="panel">
      <div className="panel-title">🎯 דורש טיפול <span className="count">({items.length})</span></div>
      <div className="action-center" data-testid="action-center">
        {items.map((item, i) => (
          <button key={`${item.type}-${item.deal_id || i}`} className={`action-item ${item.severity}`} onClick={() => go(item)}>
            <span className="ico">{SEVERITY_ICON[String(item.severity)] || "•"}</span>
            <span className="grow" style={{ textAlign: "start" }}>
              {item.deal_title ? <b>{item.deal_title}: </b> : null}{item.message_he}
            </span>
            <span aria-hidden="true">←</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MoneyPanel({ analytics }: { analytics: Json }) {
  const m = analytics.money || {};
  const o = analytics.overview || {};
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>💰 כספים</div>
        <span className="staging-flag">סביבת הדגמה — אין כסף אמיתי</span>
      </div>
      <div className="money-grid" style={{ marginTop: 12 }}>
        <div className="money-cell potential">
          <span className="lbl">מחזור פוטנציאלי (מסגרות שנתפסו)</span>
          <span className="val">{ils(o.gross_expected_amount)}</span>
        </div>
        <div className="money-cell charged">
          <span className="lbl">מחזור שחויב בפועל</span>
          <span className="val">{ils(m.gross_collected_total)}</span>
        </div>
        <div className="money-cell">
          <span className="lbl">עמלת C-ton (8% + מע״מ) — בפועל</span>
          <span className="val">{ils(m.platform_fee_total)}</span>
        </div>
        <div className="money-cell net">
          <span className="lbl">נטו למוכר — בפועל</span>
          <span className="val">{ils(m.seller_net_total)}</span>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
        פוטנציאלי אינו כסף שהתקבל: אלו מסגרות אשראי שנתפסו וישוחררו אוטומטית אם עסקה לא תיסגר.
        חיוב מתבצע רק בסגירת עסקה מוצלחת; העמלה נגבית מהסכום שנגבה בפועל בלבד.
      </p>
    </div>
  );
}

export function ChartsPanel({ analytics }: { analytics: Json }) {
  const series = analytics.series || {};
  const joins: Json[] = series.joins_daily || [];
  const charged: Json[] = series.charged_daily || [];
  const traffic: Json[] = series.funnel_daily || [];
  return (
    <div className="panel">
      <div className="panel-title">📈 מגמות ({num(series.window_days)} ימים אחרונים)</div>
      <div className="charts-grid">
        <div className="chart-box">
          <div className="chart-title">יחידות שהוזמנו ליום</div>
          <BarChart points={joins.map((r) => ({ day: r.day, value: Number(r.units || 0) }))} color="var(--brand)" />
        </div>
        <div className="chart-box">
          <div className="chart-title">הצטרפויות ליום</div>
          <BarChart points={joins.map((r) => ({ day: r.day, value: Number(r.joins || 0) }))} color="var(--brand-hi)" />
        </div>
        <div className="chart-box">
          <div className="chart-title">מחזור שחויב ליום</div>
          <BarChart points={charged.map((r) => ({ day: r.day, value: Number(r.charged_gross || 0) }))} color="var(--accent-cyan)" formatValue={(v) => ils(v)} />
        </div>
        <div className="chart-box">
          <div className="chart-title">צפיות בדף העסקה ליום</div>
          <BarChart points={traffic.map((r) => ({ day: r.day, value: Number(r.views || 0) }))} color="var(--ink-faint)" />
        </div>
      </div>
    </div>
  );
}

export function FunnelPanel({ analytics }: { analytics: Json }) {
  const f = analytics.funnel || {};
  const steps = [
    { label: "צפיות בדף העסקה", value: Number(f.views || 0) },
    { label: "התחלות הצטרפות", value: Number(f.join_starts || 0) },
    { label: "הצטרפויות", value: Number(f.joins || 0) },
    { label: "קונים שחויבו בהצלחה", value: Number(f.charged_buyers || 0) }
  ];
  const collected = steps.some((s) => s.value > 0);
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="panel">
      <div className="panel-title">🔻 משפך ({num(f.window_days)} ימים אחרונים)</div>
      {!collected ? (
        <p className="muted small" style={{ marginBottom: 0 }}>עדיין אין נתוני חשיפה והצטרפות בתקופה שנבחרה.</p>
      ) : (
        <div className="funnel">
          {steps.map((s) => (
            <div className="funnel-step" key={s.label}>
              <span className="funnel-label">{s.label}</span>
              <div className="funnel-bar-track">
                <div className="funnel-bar" style={{ width: `${Math.max(3, (s.value / max) * 100)}%` }} />
              </div>
              <span className="funnel-value">{num(s.value)}</span>
            </div>
          ))}
          {Number(f.unique_visitors || 0) > 0 ? (
            <p className="muted small" style={{ margin: "6px 0 0" }}>מבקרים ייחודיים: {num(f.unique_visitors)}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "וואטסאפ", telegram: "טלגרם", facebook: "פייסבוק", x: "X",
  email: "אימייל", copy: "העתקת קישור", native: "שיתוף מהמכשיר", other: "אחר"
};

export function ViralPanel({ analytics, dealScope, navigate }: { analytics: Json; dealScope: string; navigate: (h: string) => void }) {
  const v = analytics.viral || {};
  const channels: Json[] = analytics.share_channels || [];
  const hasData = Number(v.referred_joins || 0) > 0 || Number(v.direct_joins || 0) > 0;
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>🌱 הפצה ויראלית</div>
        {dealScope ? (
          <button className="btn btn-sm btn-primary" data-testid="open-viral-tree" onClick={() => navigate(`#/seller/deal/${dealScope}/viral`)}>
            פתיחת העץ הוויראלי
          </button>
        ) : null}
      </div>
      {!hasData ? (
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          עדיין אין הצטרפויות משויכות. כל מצטרף מקבל קישור אישי — כששיתופים יביאו חברים, הנתונים יופיעו כאן.
        </p>
      ) : (
        <>
          <div className="stat-row" style={{ margin: "12px 0 4px" }}>
            <div className="stat-tile"><span className="num">{num(v.direct_joins)}</span><span className="lbl">הצטרפו ישירות</span></div>
            <div className="stat-tile"><span className="num">{num(v.referred_joins)}</span><span className="lbl">הגיעו דרך חברים</span></div>
            <div className="stat-tile"><span className="num">{num(v.max_generation)}</span><span className="lbl">דורות בשרשרת</span></div>
            <div className="stat-tile"><span className="num">{num(v.attributed_units)}</span><span className="lbl">יחידות משיתוף</span></div>
            <div className="stat-tile good"><span className="num">{ils(v.attributed_charged_gmv)}</span><span className="lbl">חויב בזכות שיתוף</span></div>
          </div>
          {(v.top_referrers as Json[])?.length ? (
            <>
              <div className="section-title" style={{ margin: "10px 0 8px" }}>מפיצים מובילים</div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>משתתף</th><th>עסקה</th><th className="num">הביא/ה</th><th className="num">יחידות</th><th className="num">חויב</th><th /></tr></thead>
                  <tbody>
                    {(v.top_referrers as Json[]).map((r, i) => (
                      <tr key={i}>
                        <td>{r.display}</td>
                        <td>{r.deal_title}</td>
                        <td className="num">{num(r.direct_joins)}</td>
                        <td className="num">{num(r.units)}</td>
                        <td className="num">{ils(r.charged_gmv)}</td>
                        <td>
                          {r.deal_id ? (
                            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`#/seller/deal/${r.deal_id}/viral`)}>לעץ ←</button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {channels.length ? (
            <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
              {channels.map((ch) => (
                <span key={String(ch.channel)} className="channel-chip">
                  {CHANNEL_LABELS[String(ch.channel)] || String(ch.channel)} · {num(ch.clicks)}
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function ActivityPanel({ items }: { items: Json[] }) {
  if (!items?.length) {
    return (
      <div className="panel">
        <div className="panel-title">🕐 פעילות אחרונה</div>
        <p className="muted small" style={{ marginBottom: 0 }}>עדיין אין פעילות — פרסמו עסקה ושתפו אותה.</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="panel-title">🕐 פעילות אחרונה</div>
      <div className="activity-list" data-testid="recent-activity">
        {items.map((item, i) => (
          <div className="activity-item" key={i}>
            <span className={`activity-dot ${item.kind}`} aria-hidden="true" />
            <span className="grow">
              <b>{item.deal_title}</b> — {item.message_he}
            </span>
            <span className="activity-time">{new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(String(item.at)))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
