import React from "react";
import { Json } from "../api";
import { ils, num } from "../util";
import { t } from "../i18n";

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
  if (!points.length) return <p className="muted small chart-empty">{t("pages.seller_command.955bf25e")}</p>;
  const max = Math.max(1, ...points.map((p) => p.value));
  const bw = 100 / points.length;
  return (
    <svg className="bar-chart" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={t("pages.seller_command.6259d164")}>
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
        <div className="kpi-group-title">{t("pages.seller_command.4d569790")}</div>
        <div className="kpi-row">
          <Kpi label={t("pages.seller_command.15ea281e")} value={num(s.active_deals)} />
          <Kpi label={t("pages.seller_command.8a0c3e3e")} value={num(s.completed_deals)} />
          <Kpi label={t("pages.seller_command.c56222a4")} value={num(Number(s.failed_deals || 0) + Number(s.cancelled_deals || 0))} />
          <Kpi label={t("pages.seller_command.8415948e")} value={num(s.draft_deals)} />
        </div>
      </div>
      <div className="kpi-group">
        <div className="kpi-group-title">{t("pages.seller_command.6d9c8f34")}</div>
        <div className="kpi-row">
          <Kpi label={t("pages.seller_command.861fb062")} value={num(s.total_buyers)} />
          <Kpi label={t("pages.seller_command.58ddbd40")} value={num(s.total_joined_units)} tone="potential" />
          <Kpi label={t("pages.seller_command.f7171ade")} value={num(s.total_charged_units)} tone="charged" />
        </div>
      </div>
      <div className="kpi-group">
        <div className="kpi-group-title">{t("pages.seller_command.845fe268")}</div>
        <div className="kpi-row">
          <Kpi label={t("pages.seller_command.b287c622")} value={ils(o.gross_expected_amount)} tone="potential" hint={t("pages.seller_command.96022b62")} />
          <Kpi label={t("pages.seller_command.901bb0a2")} value={ils(s.gross_collected_total)} tone="charged" />
          <Kpi label={t("pages.seller_command.cc7cbf08")} value={ils(o.expected_platform_fee_total_amount)} tone="potential" />
          <Kpi label={t("pages.seller_command.3b458b4b")} value={ils(m.platform_fee_total)} tone="charged" />
          <Kpi label={t("pages.seller_command.5fbe73a1")} value={ils(o.expected_seller_net_amount)} tone="potential" />
          <Kpi label={t("pages.seller_command.49ecbe39")} value={ils(s.seller_net_total)} tone="net" />
        </div>
      </div>
    </div>
  );
}

export function ActionCenterPanel({ items, navigate }: { items: Json[]; navigate: (h: string) => void }) {
  if (!items?.length) {
    return (
      <div className="panel">
        <div className="panel-title">{t("pages.seller_command.3a9a1a3a")}</div>
        <p className="muted small" style={{ marginBottom: 0 }}>{t("pages.seller_command.b92b5ba7")}</p>
      </div>
    );
  }
  const go = (item: Json) => {
    if (item.action === "open_business_profile") navigate("#/seller/profile");
    else if (item.action === "open_inquiries") navigate("#/seller/inquiries");
    else if (item.deal_id) navigate(`#/seller/deal/${item.deal_id}`);
  };
  return (
    <div className="panel">
      <div className="panel-title">{t("pages.seller_command.3a9a1a3a")} <span className="count">({items.length})</span></div>
      <div className="action-center" data-testid="action-center">
        {items.map((item, i) => (
          <button key={`${item.type}-${item.deal_id || i}`} className={`action-item ${item.severity}`} onClick={() => go(item)}>
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
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("pages.seller_command.bf99e582")}</div>
        <span className="staging-flag">{t("pages.seller_command.fe8b3617")}</span>
      </div>
      <div className="money-grid" style={{ marginTop: 12 }}>
        <div className="money-cell potential">
          <span className="lbl">{t("pages.seller_command.b18482e3")}</span>
          <span className="val">{ils(o.gross_expected_amount)}</span>
        </div>
        <div className="money-cell charged">
          <span className="lbl">{t("pages.seller_command.901bb0a2")}</span>
          <span className="val">{ils(m.gross_collected_total)}</span>
        </div>
        <div className="money-cell">
          <span className="lbl">{t("pages.seller_command.bf0c31ef")}</span>
          <span className="val">{ils(m.platform_fee_total)}</span>
        </div>
        <div className="money-cell net">
          <span className="lbl">{t("pages.seller_command.2207002b")}</span>
          <span className="val">{ils(m.seller_net_total)}</span>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
        {t("pages.seller_command.58a8132b")}</p>
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
      <div className="panel-title">{t("pages.seller_command.f5207669", { window_days: num(series.window_days) })}</div>
      <div className="charts-grid">
        <div className="chart-box">
          <div className="chart-title">{t("pages.seller_command.c3b7ac10")}</div>
          <BarChart points={joins.map((r) => ({ day: r.day, value: Number(r.units || 0) }))} color="var(--brand)" />
        </div>
        <div className="chart-box">
          <div className="chart-title">{t("pages.seller_command.119e56ca")}</div>
          <BarChart points={joins.map((r) => ({ day: r.day, value: Number(r.joins || 0) }))} color="var(--brand-hi)" />
        </div>
        <div className="chart-box">
          <div className="chart-title">{t("pages.seller_command.e2c31709")}</div>
          <BarChart points={charged.map((r) => ({ day: r.day, value: Number(r.charged_gross || 0) }))} color="var(--accent-cyan)" formatValue={(v) => ils(v)} />
        </div>
        <div className="chart-box">
          <div className="chart-title">{t("pages.seller_command.ee1b09e2")}</div>
          <BarChart points={traffic.map((r) => ({ day: r.day, value: Number(r.views || 0) }))} color="var(--ink-faint)" />
        </div>
      </div>
    </div>
  );
}

export function FunnelPanel({ analytics }: { analytics: Json }) {
  const f = analytics.funnel || {};
  const steps = [
    { label: t("pages.seller_command.b336c9e5"), value: Number(f.views || 0) },
    { label: t("pages.seller_command.8dfdbedf"), value: Number(f.join_starts || 0) },
    { label: t("pages.seller_command.f8e3bd11"), value: Number(f.joins || 0) },
    { label: t("pages.seller_command.9d0d3874"), value: Number(f.charged_buyers || 0) }
  ];
  const collected = steps.some((s) => s.value > 0);
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="panel">
      <div className="panel-title">{t("pages.seller_command.a22c6aa3", { window_days: num(f.window_days) })}</div>
      {!collected ? (
        <p className="muted small" style={{ marginBottom: 0 }}>{t("pages.seller_command.7d36f4a4")}</p>
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
            <p className="muted small" style={{ margin: "6px 0 0" }}>{t("pages.seller_command.9f8bc77d", { unique_visitors: num(f.unique_visitors) })}</p>
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
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("pages.seller_command.8168662d")}</div>
        {dealScope ? (
          <button className="btn btn-sm btn-primary" data-testid="open-viral-tree" onClick={() => navigate(`#/seller/deal/${dealScope}/viral`)}>
            {t("pages.seller_command.c559769a")}</button>
        ) : null}
      </div>
      {!hasData ? (
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          {t("pages.seller_command.75d680b5")}</p>
      ) : (
        <>
          <div className="stat-row" style={{ margin: "12px 0 4px" }}>
            <div className="stat-tile"><span className="num">{num(v.direct_joins)}</span><span className="lbl">{t("pages.seller_command.0616f3b3")}</span></div>
            <div className="stat-tile"><span className="num">{num(v.referred_joins)}</span><span className="lbl">{t("pages.seller_command.b2cad7cb")}</span></div>
            <div className="stat-tile"><span className="num">{num(v.max_generation)}</span><span className="lbl">{t("pages.seller_command.1c694f3c")}</span></div>
            <div className="stat-tile"><span className="num">{num(v.attributed_units)}</span><span className="lbl">{t("pages.seller_command.7945eab3")}</span></div>
            <div className="stat-tile good"><span className="num">{ils(v.attributed_charged_gmv)}</span><span className="lbl">{t("pages.seller_command.96d6d95b")}</span></div>
          </div>
          {(v.top_referrers as Json[])?.length ? (
            <>
              <div className="section-title" style={{ margin: "10px 0 8px" }}>{t("pages.seller_command.e4d38adb")}</div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{t("pages.seller_command.3cffea29")}</th><th>{t("pages.seller_command.a559f0b8")}</th><th className="num">{t("pages.seller_command.ee76c8f8")}</th><th className="num">{t("pages.seller_command.5170f234")}</th><th className="num">{t("pages.seller_command.91f92e27")}</th><th /></tr></thead>
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
                            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`#/seller/deal/${r.deal_id}/viral`)}>{t("pages.seller_command.e4137110")}</button>
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
        <div className="panel-title">{t("pages.seller_command.bd7c4f06")}</div>
        <p className="muted small" style={{ marginBottom: 0 }}>{t("pages.seller_command.8b55e5ae")}</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="panel-title">{t("pages.seller_command.bd7c4f06")}</div>
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
