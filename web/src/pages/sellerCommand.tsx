import React from "react";
import { Json } from "../api";
import { ils, num } from "../util";
import { t, tKey } from "../i18n/index.js";

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
  if (!points.length) return <p className="muted small chart-empty">{t("seller_command.there_data_selected_period_yet")}</p>;
  const max = Math.max(1, ...points.map((p) => p.value));
  const bw = 100 / points.length;
  return (
    <svg className="bar-chart" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={t("seller_command.bar_chart")}>
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
        <div className="kpi-group-title">{t("seller_command.deals")}</div>
        <div className="kpi-row">
          <Kpi label={t("seller_command.activity")} value={num(s.active_deals)} />
          <Kpi label={t("seller_command.completed")} value={num(s.completed_deals)} />
          <Kpi label={t("seller_command.did_complete")} value={num(Number(s.failed_deals || 0) + Number(s.cancelled_deals || 0))} />
          <Kpi label={t("seller_command.drafts")} value={num(s.draft_deals)} />
        </div>
      </div>
      <div className="kpi-group">
        <div className="kpi-group-title">{t("seller_command.buyers_units")}</div>
        <div className="kpi-row">
          <Kpi label={t("seller_command.joining")} value={num(s.total_buyers)} />
          <Kpi label={t("seller_command.units_ordered")} value={num(s.total_joined_units)} tone="potential" />
          <Kpi label={t("seller_command.units_charged")} value={num(s.total_charged_units)} tone="charged" />
        </div>
      </div>
      <div className="kpi-group">
        <div className="kpi-group-title">{t("seller_command.money_expected_against_actual")}</div>
        <div className="kpi-row">
          <Kpi label={t("seller_command.potential_turnover_authorizations")} value={ils(o.gross_expected_amount)} tone="potential" hint={t("seller_command.authorizations_placed_money_collected_yet")} />
          <Kpi label={t("seller_command.turnover_actually_charged")} value={ils(s.gross_collected_total)} tone="charged" />
          <Kpi label={t("seller_command.expected_c_ton_fee_8")} value={ils(o.expected_platform_fee_total_amount)} tone="potential" />
          <Kpi label={t("seller_command.actual_c_ton_fee")} value={ils(m.platform_fee_total)} tone="charged" />
          <Kpi label={t("seller_command.expected_net_seller")} value={ils(o.expected_seller_net_amount)} tone="potential" />
          <Kpi label={t("seller_command.actual_net_seller")} value={ils(s.seller_net_total)} tone="net" />
        </div>
      </div>
    </div>
  );
}

export function ActionCenterPanel({ items, navigate }: { items: Json[]; navigate: (h: string) => void }) {
  if (!items?.length) {
    return (
      <div className="panel">
        <div className="panel-title">{t("seller_command.needs_handling")}</div>
        <p className="muted small" style={{ marginBottom: 0 }}>{t("seller_command.nothing_needs_handling_right_now")}</p>
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
      <div className="panel-title">{t("seller_command.needs_handling")} <span className="count">({items.length})</span></div>
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
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("seller_command.money")}</div>
        <span className="staging-flag">{t("seller_command.demonstration_environment_real_money")}</span>
      </div>
      <div className="money-grid" style={{ marginTop: 12 }}>
        <div className="money-cell potential">
          <span className="lbl">{t("seller_command.potential_turnover_authorizations_placed")}</span>
          <span className="val">{ils(o.gross_expected_amount)}</span>
        </div>
        <div className="money-cell charged">
          <span className="lbl">{t("seller_command.turnover_actually_charged")}</span>
          <span className="val">{ils(m.gross_collected_total)}</span>
        </div>
        <div className="money-cell">
          <span className="lbl">{t("seller_command.c_ton_fee_8_vat")}</span>
          <span className="val">{ils(m.platform_fee_total)}</span>
        </div>
        <div className="money-cell net">
          <span className="lbl">{t("seller_command.net_seller_actual")}</span>
          <span className="val">{ils(m.seller_net_total)}</span>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
        {t("seller_command.potential_money_received_these_card")}</p>
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
      <div className="panel-title">{t("seller_command.trends_last_window_days_days", { window_days: num(series.window_days) })}</div>
      <div className="charts-grid">
        <div className="chart-box">
          <div className="chart-title">{t("seller_command.units_ordered_per_day")}</div>
          <BarChart points={joins.map((r) => ({ day: r.day, value: Number(r.units || 0) }))} color="var(--brand)" />
        </div>
        <div className="chart-box">
          <div className="chart-title">{t("seller_command.joins_per_day")}</div>
          <BarChart points={joins.map((r) => ({ day: r.day, value: Number(r.joins || 0) }))} color="var(--brand-hi)" />
        </div>
        <div className="chart-box">
          <div className="chart-title">{t("seller_command.turnover_charged_per_day")}</div>
          <BarChart points={charged.map((r) => ({ day: r.day, value: Number(r.charged_gross || 0) }))} color="var(--accent-cyan)" formatValue={(v) => ils(v)} />
        </div>
        <div className="chart-box">
          <div className="chart-title">{t("seller_command.deal_page_views_per_day")}</div>
          <BarChart points={traffic.map((r) => ({ day: r.day, value: Number(r.views || 0) }))} color="var(--ink-faint)" />
        </div>
      </div>
    </div>
  );
}

export function FunnelPanel({ analytics }: { analytics: Json }) {
  const f = analytics.funnel || {};
  const steps = [
    { label: t("seller_command.deal_page_views"), value: Number(f.views || 0) },
    { label: t("seller_command.join_starts"), value: Number(f.join_starts || 0) },
    { label: t("seller_command.joins"), value: Number(f.joins || 0) },
    { label: t("seller_command.buyers_charged_successfully"), value: Number(f.charged_buyers || 0) }
  ];
  const collected = steps.some((s) => s.value > 0);
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="panel">
      <div className="panel-title">{t("seller_command.funnel_last_window_days_days", { window_days: num(f.window_days) })}</div>
      {!collected ? (
        <p className="muted small" style={{ marginBottom: 0 }}>{t("seller_command.there_exposure_join_data_selected")}</p>
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
            <p className="muted small" style={{ margin: "6px 0 0" }}>{t("seller_command.unique_visitors_unique_visitors", { unique_visitors: num(f.unique_visitors) })}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "seller_command.channel_labels.whatsapp", telegram: "seller_command.channel_labels.telegram", facebook: "seller_command.channel_labels.facebook", x: "X",
  email: "seller_command.channel_labels.email", copy: "seller_command.channel_labels.copy", native: "seller_command.channel_labels.native", other: "seller_command.channel_labels.other"
};

export function ViralPanel({ analytics, dealScope, navigate }: { analytics: Json; dealScope: string; navigate: (h: string) => void }) {
  const v = analytics.viral || {};
  const channels: Json[] = analytics.share_channels || [];
  const hasData = Number(v.referred_joins || 0) > 0 || Number(v.direct_joins || 0) > 0;
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("seller_command.viral_distribution")}</div>
        {dealScope ? (
          <button className="btn btn-sm btn-primary" data-testid="open-viral-tree" onClick={() => navigate(`#/seller/deal/${dealScope}/viral`)}>
            {t("seller_command.open_viral_tree")}</button>
        ) : null}
      </div>
      {!hasData ? (
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          {t("seller_command.there_attributed_joins_yet_everyone")}</p>
      ) : (
        <>
          <div className="stat-row" style={{ margin: "12px 0 4px" }}>
            <div className="stat-tile"><span className="num">{num(v.direct_joins)}</span><span className="lbl">{t("seller_command.joined_directly")}</span></div>
            <div className="stat-tile"><span className="num">{num(v.referred_joins)}</span><span className="lbl">{t("seller_command.came_through_friends")}</span></div>
            <div className="stat-tile"><span className="num">{num(v.max_generation)}</span><span className="lbl">{t("seller_command.generations_chain")}</span></div>
            <div className="stat-tile"><span className="num">{num(v.attributed_units)}</span><span className="lbl">{t("seller_command.units_sharing")}</span></div>
            <div className="stat-tile good"><span className="num">{ils(v.attributed_charged_gmv)}</span><span className="lbl">{t("seller_command.charged_thanks_sharing")}</span></div>
          </div>
          {(v.top_referrers as Json[])?.length ? (
            <>
              <div className="section-title" style={{ margin: "10px 0 8px" }}>{t("seller_command.top_distributors")}</div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{t("seller_command.participant")}</th><th>{t("seller_command.deal")}</th><th className="num">{t("seller_command.brought")}</th><th className="num">{t("seller_command.units")}</th><th className="num">{t("seller_command.charged")}</th><th /></tr></thead>
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
                            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`#/seller/deal/${r.deal_id}/viral`)}>{t("seller_command.to_tree")}</button>
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
                  {tKey(CHANNEL_LABELS[String(ch.channel)], ch.channel)} · {num(ch.clicks)}
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
        <div className="panel-title">{t("seller_command.recent_activity")}</div>
        <p className="muted small" style={{ marginBottom: 0 }}>{t("seller_command.no_activity_yet_publish_deal")}</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="panel-title">{t("seller_command.recent_activity")}</div>
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
