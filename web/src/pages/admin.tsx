import { ContentAdmin } from "../receiptContent";
﻿import React, { useEffect, useMemo, useState } from "react";
import { api, clearAuthSession, getAdminToken, Json } from "../api";
import { clearOwnerSession } from "../ownerMode";
import { lockAdmin } from "../adminGate";
import { revokeSurface } from "../session";
import { AuthPanel } from "../auth";
import { BrandLoader, Countdown, EmptyState, Modal, Spinner, StatTile, StatusPill, Toast, useToast } from "../components";
import { BrandMark } from "../brand";
import { PropagationTree } from "../propagation";
import { buyerStateLabel, fmtDate, ils, israelPartsToUtcIso, moneyStateLabel, notificationStatusLabel, num, pct, stateLabel, timeAgo } from "../util";
// SHELF REINTEGRATION (PR #7 residual slice) — the admin virality time range.
import { DEFAULT_GROWTH_RANGE, GROWTH_RANGE_PRESETS, growthRangeLabel, growthRangeParams, validateCustomRange, type GrowthRange } from "../growthRange";
import { t, tKey } from "../i18n/index.js";

// ── login (the shared truthful auth panel + server-side admin verification) ─
function AdminLogin({ onDone }: { onDone: () => void }) {
  return (
    <AuthPanel
      surface="admin"
      title={t("admin.the_c_ton_control_centre")}
      subtitle={t("admin.system_administrators_only_every_action")}
      signupLabel={t("admin.initial_setup_owner_account")}
      verify={async () => {
        const me = await api.adminMe().catch((err: any) => {
          if (err.status === 401 || err.status === 403) { revokeSurface("admin"); throw new Error(t("admin.this_account_administrator_permission")); }
          throw err;
        });
        if (!me?.ok && !me?.identity) { revokeSurface("admin"); throw new Error(t("admin.this_account_administrator_permission")); }
      }}
      onDone={onDone}
    />
  );
}

// ── generic hooks ──────────────────────────────────────────────────────────
function useFetch<T = Json>(fn: () => Promise<T>, deps: unknown[] = [], intervalMs = 0): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = () => fn().then((d) => { setData(d); setError(""); }).catch((e: any) => setError(e.message || t("admin.error")));
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
      <span><b>{t("admin.length_sellers_awaiting_approval", { length: num(pending.length) })}</b> — {pending.slice(0, 3).map((s: Json) => s.business_name || s.display_name || s.seller_id).join(" · ")}{pending.length > 3 ? " …" : ""}</span>
      <button className="btn btn-sm btn-primary" style={{ marginInlineStart: "auto" }} onClick={() => navigate("#/admin/sellers")}>{t("admin.to_approve_now")}</button>
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
      <h1>{t("admin.overview_whole_system")}</h1>
      <PendingSellersAlert navigate={navigate} />
      <div className="stat-row">
        <StatTile num={num(d.deals?.active || 0)} label={t("admin.active_deals")} sub={t("admin.total_v0", { v0: num(d.deals?.total || 0) })} />
        <StatTile num={num(d.sellers?.active || 0)} label={t("admin.active_sellers")} />
        <StatTile num={num(d.participants?.total || 0)} label={t("admin.participations")} sub={t("admin.v0_buyers", { v0: num(d.participants?.distinct_buyers || 0) })} />
        <StatTile num={num(d.participants?.units_joined || 0)} label={t("admin.units_joined")} />
        <StatTile num={num(d.participants?.units_charged || 0)} label={t("admin.units_actually_charged")} tone="good" />
      </div>
      <div className="stat-row">
        <StatTile num={ils(money.potential_gross_volume || 0)} label={t("admin.authorization_volume_potential_revenue")} />
        <StatTile num={ils(money.charged_gross_volume || 0)} label={t("admin.actually_collected")} tone="good" />
        <StatTile num={ils(money.platform_fee_projection || 0)} label={t("admin.c_ton_fee_forecast_authorizations")} />
        <StatTile num={ils(money.platform_fee_actual || 0)} label={t("admin.actual_c_ton_fee_collected")} tone="good" />
      </div>
      <div className="stat-row">
        <StatTile num={num(ops.outbox_pending || 0)} label={t("admin.job_queue")} tone={Number(ops.outbox_pending) > 20 ? "warn" : undefined} />
        <StatTile num={num(ops.dlq_size || 0)} label="DLQ" tone={Number(ops.dlq_size) > 0 ? "bad" : "good"} />
        <StatTile num={workerOk ? t("admin.active") : t("admin.not_reported")} label="Worker" tone={workerOk ? "good" : "bad"} sub={workerAge !== undefined ? t("admin.heartbeat_workerage_s_ago", { workerAge: num(workerAge) }) : ""} />
        <StatTile num={num(d.participants?.in_recovery || 0)} label={t("admin.in_completion_window")} tone={Number(d.participants?.in_recovery) > 0 ? "warn" : undefined} sub={t("admin.v0_units", { v0: num(d.participants?.units_in_recovery || 0) })} />
        <StatTile num={num(ops.payment_permanent_failures_24h || 0)} label={t("admin.final_charge_failures_24h")} tone={Number(ops.payment_permanent_failures_24h) > 0 ? "warn" : undefined} />
        <StatTile num={num(ops.open_support_tickets || 0) + Number(ops.open_operational_cases || 0)} label={t("admin.open_enquiries_exceptions")} />
      </div>

      <div className="panel">
        <div className="panel-title">{t("admin.deals_state")}</div>
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
          <div className="panel-title">{t("admin.virality_overview")} <button className="btn btn-sm btn-ghost" style={{ marginInlineStart: "auto" }} onClick={() => navigate("#/admin/growth")}>{t("admin.to_full_dashboard")}</button></div>
          <div className="stat-row" style={{ marginBottom: 0 }}>
            <StatTile num={num(viral.attributed_participants || 0)} label={t("admin.joins_sharing")} />
            <StatTile num={pct(viral.viral_share_of_joins || 0)} label={t("admin.viral_share_all_joins")} />
            <StatTile num={ils(viral.attributed_charged_gmv || 0)} label={t("admin.charged_gross_originating_sharing")} tone="good" />
            <StatTile num={num(viral.max_generation || 0)} label={t("admin.maximum_chain_depth")} />
          </div>
        </div>
      ) : null}

      <PilotMetricsPanel navigate={navigate} />

      {ops.recent_dlq?.length ? (
        <div className="panel">
          <div className="panel-title">{t("admin.recent_failures_dlq")}</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t("admin.type")}</th><th>{t("admin.entity")}</th><th>{t("admin.error")}</th><th>{t("admin.when")}</th></tr></thead>
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
  if (error) return <div className="panel"><div className="panel-title">{t("admin.pilot_metrics")}</div><Err msg={error} /></div>;
  if (!data) return null;
  const m = data as Json;
  const s = m.sellers || {}, dl = m.deals || {}, b = m.buyers || {}, inq = m.inquiries || {};
  const pctText = (v: unknown) => (v === null || v === undefined ? "—" : `${v}%`);
  return (
    <div className="panel" data-testid="pilot-metrics">
      <div className="panel-title">{t("admin.pilot_metrics.title", { days: num(days) })}
        <span className="row" style={{ marginInlineStart: "auto", gap: 6 }}>
          {[7, 30, 90].map((d) => <button key={d} className={`btn btn-sm ${d === days ? "btn-primary" : "btn-ghost"}`} onClick={() => setDays(d)}>{t("admin.d_days", { d: d })}</button>)}
        </span>
      </div>
      <div className="stat-row" style={{ marginBottom: 8 }}>
        <StatTile num={num(s.signed_up || 0)} label={t("admin.sellers_registered_total")} sub={t("admin.v0_window", { v0: num(s.signed_up_in_window || 0) })} />
        <StatTile num={num(s.pending_approval || 0)} label={t("admin.awaiting_approval")} tone={Number(s.pending_approval) > 0 ? "warn" : undefined} />
        <StatTile num={num(s.created_a_deal || 0)} label={t("admin.sellers_who_created_deal")} />
        <StatTile num={num(s.published_a_deal || 0)} label={t("admin.sellers_who_published")} />
        <StatTile num={num(s.repeat_publishers || 0)} label={t("admin.returning_sellers_2_publications")} tone="good" />
      </div>
      <div className="stat-row" style={{ marginBottom: 8 }}>
        <StatTile num={num(dl.drafts_created || 0)} label={t("admin.drafts_created")} />
        <StatTile num={num(dl.published || 0)} label={t("admin.published")} />
        {/* LAUNCH POLISH (P7) — what is live RIGHT NOW (open for joining), from the same aggregate */}
        <StatTile num={num(dl.open_now || 0)} label={t("admin.open_joining_now")} sub={t("admin.v0_close_charge", { v0: num(dl.settling || 0) })} />
        <StatTile num={num(dl.reached_threshold || 0)} label={t("admin.reached_target")} tone="good" />
        <StatTile num={num(dl.completed || 0)} label={t("admin.completed")} tone="good" />
        <StatTile num={num(dl.failed || 0)} label={t("admin.failed")} tone={Number(dl.failed) > 0 ? "warn" : undefined} />
      </div>
      <div className="stat-row" style={{ marginBottom: 0 }}>
        <StatTile num={num(b.deal_views || 0)} label={t("admin.deal_views")} sub={t("admin.v0_visitors", { v0: num(b.unique_visitors || 0) })} />
        <StatTile num={num(b.join_starts || 0)} label={t("admin.join_attempts")} sub={t("admin.v0_rejected", { v0: num(b.join_failures || 0) })} />
        <StatTile num={num(b.joins || 0)} label={t("admin.actually_joined")} sub={t("admin.v0_buyers", { v0: num(b.distinct_buyers || 0) })} tone="good" />
        <StatTile num={pctText(b.view_to_join_pct)} label={t("admin.view_join_conversion")} sub={t("admin.attempt_join_join_start_join", { join_start_to_join_pct: pctText(b.join_start_to_join_pct) })} />
        {/* LAUNCH POLISH (P7) — unresolved inquiries are the owner's daily nudge to sellers */}
        <StatTile num={num(Math.max(0, Number(inq.threads || 0) - Number(inq.answered || 0)))} label={t("admin.enquiries_awaiting_reply")}
          sub={t("admin.v0_total_v1_answered", { v0: num(inq.threads || 0), v1: num(inq.answered || 0) })}
          tone={Number(inq.threads || 0) - Number(inq.answered || 0) > 0 ? "warn" : "good"} />
      </div>
      {(m.per_seller || []).some((r: Json) => r.verification_status === "pending") ? (
        <p className="small" style={{ marginTop: 10 }}>
          {t("admin.sellers_awaiting_approval")}{" "}
          <a href="#/admin/sellers" onClick={(e) => { e.preventDefault(); navigate("#/admin/sellers"); }}>{t("admin.to_seller_list_2")}</a>
        </p>
      ) : null}
      {/* LAUNCH POLISH 2 (P6) — what buyers said was unclear (aggregate, PII-free) */}
      <BuyerFeedbackSummary feedback={m.feedback} />
    </div>
  );
}

const FEEDBACK_LABEL_HE: Record<string, string> = {
  how_it_works: "admin.feedback_label_he.how_it_works", price: "admin.feedback_label_he.price", target: "admin.feedback_label_he.target",
  payment: "admin.feedback_label_he.payment", delivery: "admin.feedback_label_he.delivery", other: "admin.feedback_label_he.other", all_clear: "admin.feedback_label_he.all_clear", unknown: "admin.feedback_label_he.unknown"
};
function BuyerFeedbackSummary({ feedback }: { feedback: Json | undefined }) {
  const total = Number(feedback?.total || 0);
  const rows: Json[] = Array.isArray(feedback?.by_category) ? feedback!.by_category : [];
  const recent: Json[] = Array.isArray(feedback?.recent) ? feedback!.recent : [];
  return (
    <div className="feedback-summary" data-testid="pilot-feedback" data-total={total} style={{ marginTop: 14, borderTop: "1px dashed var(--line-strong)", paddingTop: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>{t("admin.buyer_feedback_there_anything_wasn", { total: num(total) })}</div>
      {total === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>{t("admin.no_feedback_window_yet_question")}</p>
      ) : (
        <>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {rows.map((r) => (
              <span key={String(r.category)} className={`chip${r.category === "all_clear" ? " active" : ""}`} data-testid={`pilot-feedback-${String(r.category)}`}>
                {tKey(FEEDBACK_LABEL_HE[String(r.category)], String(r.category))} · {num(r.count)}
              </span>
            ))}
          </div>
          {recent.length ? (
            <ul className="small" style={{ margin: "10px 0 0", paddingInlineStart: 18, color: "var(--ink-soft)" }}>
              {recent.slice(0, 6).map((r, i) => (
                <li key={i}><b>{tKey(FEEDBACK_LABEL_HE[String(r.category)], String(r.category))}:</b> {String(r.text || "")} <span className="muted">· {fmtDate(r.at)}</span></li>
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
      <h1>{t("admin.deals")}</h1>
      <div className="row" style={{ marginBottom: 14 }}>
        <input placeholder={t("admin.search_name_id_seller")} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        {states.map((s) => (
          <button key={s || "all"} className={`chip${state === s ? " active" : ""}`} onClick={() => setState(s)}>{s ? stateLabel(s) : t("admin.all")}</button>
        ))}
      </div>
      <Err msg={error} />
      {!data ? <Spinner /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>{t("admin.deal")}</th><th>{t("admin.seller")}</th><th>{t("admin.state")}</th><th className="num">{t("admin.joined")}</th><th className="num">{t("admin.charged_2")}</th>
              <th className="num">{t("admin.potential")}</th><th className="num">{t("admin.collected")}</th><th className="num">{t("admin.viral")}</th><th>{t("admin.deadline")}</th>
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
                  <td><Countdown until={d.deadline} overText={t("admin.passed")} /></td>
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
            <button className="vtree-toggle" onClick={(e) => { e.stopPropagation(); void toggle(); }} aria-label={open ? t("admin.collapse_branch") : t("admin.expand_branch")} aria-expanded={open}>
              {loading ? "…" : open ? "−" : "+"}
            </button>
          ) : <span className="vtree-leaf-dot" aria-hidden="true">•</span>}
          <span className="vtree-name">{node.display}</span>
          <span className="vtree-gen">{t("admin.generation_generation", { generation: num(node.generation) })}</span>
          <span className="vtree-badge">{t("admin.direct_units_units", { direct_units: num(node.direct_units) })}</span>
          {node.charged ? <span className="vtree-badge charged">{t("admin.charged")}</span> : node.active ? <span className="vtree-badge">{t("admin.authorization")}</span> : <span className="vtree-badge dropped">{t("admin.dropped")}</span>}
          {node.has_children ? (
            <span className="vtree-badge branch">
              {t("admin.direct_children_direct_branch_subtree", { direct_children: num(node.direct_children), subtree_joins: num(node.subtree_joins), subtree_charged_units: num(node.subtree_charged_units) })}</span>
          ) : null}
        </div>
      </div>
      {open && children ? (
        <div className="vtree-children">
          {children.length ? children.map((c) => (
            <TreeBranch key={c.participant_id} node={c} dealId={dealId} depth={depth + 1} onSelect={onSelect} selectedId={selectedId} />
          )) : <p className="muted small">{t("admin.nobody_joined_through_participant_s")}</p>}
          {truncated ? <p className="muted small">{t("admin.the_first_60_branch_shown")}</p> : null}
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
      <p className="muted small grow">{t("admin.virality_data_been_computed_deal")}</p>
      {onRecompute ? <button className="btn btn-sm btn-ghost" onClick={onRecompute}>{t("admin.compute_now")}</button> : null}
    </div>
  );
  const v = (vm.viral || {}) as Json;
  const f = (vm.funnel || {}) as Json;
  const gens = Object.entries((v.generation_distribution || {}) as Record<string, number>).sort((a, b) => Number(a[0]) - Number(b[0]));
  const maxGen = Math.max(1, ...gens.map(([, n]) => Number(n)));
  return (
    <>
      <div className="stat-row">
        <StatTile num={num(v.attributed_participants || 0)} label={t("admin.joins_sharing")} sub={t("admin.v0_total", { v0: pct(v.viral_share_of_joins || 0) })} />
        <StatTile num={num(v.attributed_charged_units || 0)} label={t("admin.units_charged_distribution")} tone="good" />
        <StatTile num={ils(v.attributed_charged_gmv || 0)} label={t("admin.charged_gross_distribution")} tone="good" />
        <StatTile num={num(v.personal_links || 0)} label={t("admin.personal_links")} />
        <StatTile num={num(v.sharing_participants || 0)} label={t("admin.active_sharers")} sub={t("admin.v0_children_average", { v0: Number(v.avg_children_per_sharer || 0).toFixed(1) })} />
        <StatTile num={String(v.direct_viral_coefficient ?? 0)} label={t("admin.viral_coefficient_joins")} sub={t("admin.in_money_v0", { v0: v.charged_viral_coefficient ?? 0 })} />
      </div>
      <div className="stat-row">
        <StatTile num={num(f.deal_views || 0)} label={t("admin.page_views")} />
        <StatTile num={num(f.share_clicks || 0)} label={t("admin.share_clicks")} />
        <StatTile num={num(f.link_entries || 0)} label={t("admin.visits_links")} />
        <StatTile num={pct(f.visit_to_join_rate || 0)} label={t("admin.conversion_visit_join")} />
        <StatTile num={pct(f.shared_visit_to_charged_rate || 0)} label={t("admin.conversion_visit_successful_charge")} />
      </div>
      {gens.length ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-title">{t("admin.generation_distribution")}</div>
          <div className="gen-bars" style={{ paddingTop: 18, paddingBottom: 22 }}>
            {gens.map(([g, n]) => (
              <div key={g} className="gen-bar" style={{ height: `${Math.max(8, (Number(n) / maxGen) * 100)}%` }}>
                <span className="gen-val">{num(n)}</span>
                <span className="gen-lbl">{t("admin.generation_g", { g: g })}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {(vm.top_sources as Json[])?.length ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-title">{t("admin.top_sources_first_last_touch")}</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t("admin.source")}</th><th>{t("admin.type")}</th><th className="num">{t("admin.clicks")}</th><th className="num">{t("admin.visits")}</th><th className="num">{t("admin.joins_branch")}</th><th className="num">{t("admin.units_charged_2")}</th><th className="num">{t("admin.charged_gross")}</th></tr></thead>
              <tbody>
                {(vm.top_sources as Json[]).slice(0, 10).map((s) => (
                  <tr key={s.link_id}>
                    <td><b>{s.owner_display || s.internal_name}</b> <span className="muted small" dir="ltr">{s.source_code}</span></td>
                    <td>{s.origin_type === "participant" ? t("admin.participant") : s.origin_type === "distributor" ? t("admin.distributor") : s.origin_type}</td>
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
          {t("admin.computed_by_worker", { at: computedAt ? fmtDate(computedAt) : "—" })} {stale ? t("admin.may_current") : ""}
          {onRecompute ? <button className="btn btn-sm btn-ghost" style={{ marginInlineStart: 8 }} onClick={onRecompute}>{t("admin.refresh_computation")}</button> : null}
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
        <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>{t("admin.distribution_tree_2")}</button>
        <button className={mode === "analytics" ? "active" : ""} onClick={() => setMode("analytics")}>{t("admin.analytics")}</button>
      </div>
      {mode === "tree" ? (
        <div className="panel">
          <div className="panel-title">{t("admin.distribution_tree")}</div>
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
    try { await api.adminViralRecompute(dealId); showToast(t("admin.the_virality_computation_been_queued")); setTimeout(reloadViral, 4000); }
    catch (e: any) { showToast(e.message || t("admin.failed_2")); }
  };

  return (
    <>
      <a className="back" href="#/admin/deals" onClick={(e) => { e.preventDefault(); navigate("#/admin/deals"); }}>{t("admin.to_deal_list")}</a>
      <div className="row" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>{deal.title}</h1>
        <StatusPill state={String(deal.state)} />
        <button className="btn btn-sm btn-ghost" style={{ marginInlineStart: "auto" }} onClick={() => navigate(`#/admin/seller/${encodeURIComponent(deal.seller_id)}`)}>{t("admin.to_seller_seller_id", { seller_id: deal.seller_id })}</button>
        <a className="btn btn-sm btn-ghost" href={`#/deal/${dealId}`} target="_blank">{t("admin.public_page")}</a>
      </div>
      <div className="stat-row">
        <StatTile num={`${num(joinedUnits)} / ${num(deal.max_units)}`} label={t("admin.joined_maximum")} sub={t("admin.minimum_min_units_threshold_threshold", { min_units: num(deal.min_units), threshold_units: num(deal.threshold_units) })} />
        <StatTile num={num(chargedUnits)} label={t("admin.units_actually_charged_2")} tone="good" />
        <StatTile num={ils(potential)} label={t("admin.potential_authorizations")} />
        <StatTile num={ils(gross)} label={t("admin.actually_collected")} tone="good" />
        <StatTile num={ils(Math.round(gross * 0.08 * 100) / 100)} label={t("admin.c_ton_fee_8_what")} />
        <StatTile num={<Countdown until={deal.completion_window_until || deal.deadline} overText={t("admin.passed")} />} label={deal.completion_window_until ? t("admin.completion_window") : t("admin.deadline")} />
        {/* LAUNCH SPRINT 3 — physical handoff truth for support: awaiting vs handed over (server-computed) */}
        {p.fulfillment?.applicable ? (
          <>
            <StatTile num={num(p.fulfillment.awaiting)} label={t("admin.awaiting_handover")} tone={Number(p.fulfillment.awaiting) > 0 ? "warn" : undefined} />
            <StatTile num={num(p.fulfillment.fulfilled)} label={t("admin.handed_over")} tone="good" />
          </>
        ) : null}
      </div>

      <div className="tabbar">
        {[["summary", t("admin.participants_money")], ["viral", t("admin.virality_tree")], ["ops", t("admin.operations_queue")], ["audit", t("admin.audit_log")]].map(([k, l]) => (
          <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k!)}>{l}</button>
        ))}
      </div>

      {tab === "summary" ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{t("admin.buyer")}</th><th>{t("admin.phone")}</th><th className="num">{t("admin.quantity")}</th><th>{t("admin.buyer_state")}</th><th>{t("admin.money_state")}</th><th>{t("admin.fulfilment")}</th><th>{t("admin.handover")}</th><th>{t("admin.source")}</th><th>{t("admin.when")}</th></tr></thead>
            <tbody>
              {participants.map((x) => {
                const f = p.fulfillment?.by_participant?.[String(x.participant_id)] || null;
                const fulfillmentText = !f || f.fulfillment_status === "none" ? "—"
                  : f.fulfillment_status === "fulfilled" ? t("admin.handed_over_fulfilled_v1", { fulfilled_at: fmtDate(f.fulfilled_at), v1: f.order_code_last4 ? ` · •${f.order_code_last4}` : "" })
                    : f.fulfillment_status === "awaiting" ? t("admin.pending_v0", { v0: f.order_code_last4 ? ` · •${f.order_code_last4}` : "" }) : t("admin.do_hand_over");
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
            <div className="panel-title">{t("admin.the_deal_s_job_queue")}</div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{t("admin.type")}</th><th>{t("admin.status")}</th><th className="num">{t("admin.attempts")}</th><th>{t("admin.available")}</th><th>{t("admin.created")}</th></tr></thead>
                <tbody>
                  {(p.outbox || []).map((o: Json, i: number) => (
                    <tr key={i}><td>{o.event_type}</td><td>{o.status}</td><td className="num">{num(o.attempt_count)}</td><td>{fmtDate(o.available_at)}</td><td>{fmtDate(o.created_at)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <div className="panel-title">{t("admin.charge_attempts")}</div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{t("admin.type")}</th><th>{t("admin.result")}</th><th>{t("admin.correlation_id")}</th><th>{t("admin.when")}</th></tr></thead>
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
              <div className="panel-title">{t("admin.deal_notifications")}</div>
              <div className="row">{Object.entries(ops.notifications as Record<string, unknown>).map(([k, v]) => <span key={k} className="chip">{k}: {String(v)}</span>)}</div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "audit" ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{t("admin.entity")}</th><th>{t("admin.change")}</th><th>{t("admin.action")}</th><th>{t("admin.when")}</th></tr></thead>
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
function PendingSellersQueue({ pending, navigate, onChanged }: { pending: Json[]; navigate: (h: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [confirmReject, setConfirmReject] = useState("");
  const [msg, setMsg] = useState("");
  if (!pending.length) return <div className="notice ok" data-testid="pending-sellers-empty">{t("admin.no_sellers_waiting_approval")}</div>;
  const decide = async (s: Json, decision: "approve" | "reject") => {
    if (busy) return;
    setBusy(String(s.seller_id)); setMsg("");
    try {
      await api.adminSellerKycDecision(String(s.seller_id), decision, decision === "approve" ? "pilot_approved" : "pilot_rejected");
      setMsg(decision === "approve" ? t("admin.display_name_approved_they_publish", { display_name: s.business_name || s.display_name }) : t("admin.display_name_rejected", { display_name: s.business_name || s.display_name }));
      setConfirmReject("");
      onChanged();
    } catch (e: any) { setMsg(e.message || t("admin.the_action_failed")); }
    setBusy("");
  };
  return (
    <section className="pending-queue" data-testid="pending-sellers-queue" aria-label={t("admin.sellers_awaiting_approval_2")}>
      <div className="panel-title">{t("admin.awaiting_approval")} <span className="count">({num(pending.length)})</span></div>
      <p className="small muted" style={{ margin: "0 0 4px" }}>{t("admin.a_seller_who_registered_own")}</p>
      {pending.map((s) => (
        <div className="pending-row" key={s.seller_id} data-testid="pending-seller-row" data-seller-id={s.seller_id}>
          <div className="who">
            <b>{s.business_name || s.display_name || s.seller_id}</b>
            <span className="small" dir="ltr">{s.login_email || s.seller_id}</span>
            <div className="small">
              {t("admin.seller_row_meta", { registered: s.created_at ? timeAgo(s.created_at) : "—", bound: s.supabase_bound ? t("admin.verified_sign") : t("admin.no_sign_link"), drafts: num(s.deals_total || 0) })}
            </div>
          </div>
          <div className="acts">
            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`#/admin/seller/${encodeURIComponent(String(s.seller_id))}`)}>{t("admin.open")}</button>
            {confirmReject === s.seller_id ? (
              <button className="btn btn-sm btn-danger" data-testid="pending-reject-confirm" disabled={Boolean(busy)} onClick={() => decide(s, "reject")}>{t("admin.confirm_rejection")}</button>
            ) : (
              <button className="btn btn-sm btn-ghost btn-danger-ghost" data-testid="pending-reject" disabled={Boolean(busy)} onClick={() => setConfirmReject(String(s.seller_id))}>{t("admin.reject")}</button>
            )}
            <button className="btn btn-sm btn-primary" data-testid="pending-approve" disabled={Boolean(busy)} onClick={() => decide(s, "approve")}>
              {busy === s.seller_id ? t("admin.one_moment") : t("admin.approve_seller")}
            </button>
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
      <h1>{t("admin.sellers")}</h1>
      <PendingSellersQueue pending={pending} navigate={navigate} onChanged={() => setVersion((v) => v + 1)} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr>
            <th>{t("admin.seller")}</th><th>{t("admin.status")}</th><th className="num">{t("admin.deals")}</th><th className="num">{t("admin.activity")}</th><th className="num">{t("admin.completed")}</th><th className="num">{t("admin.failed")}</th>
            <th className="num">{t("admin.units_charged")}</th><th className="num">{t("admin.potential")}</th><th className="num">{t("admin.collected")}</th><th className="num">{t("admin.actual_fee")}</th><th>{t("admin.recent_activity")}</th>
          </tr></thead>
          <tbody>
            {((data as Json).sellers || []).map((s: Json) => (
              <tr key={s.seller_id} className="clickable" onClick={() => navigate(`#/admin/seller/${encodeURIComponent(s.seller_id)}`)}>
                <td><b>{s.business_name || s.display_name}</b><div className="muted small" dir="ltr">{s.login_email || s.seller_id}</div></td>
                <td>
                  <span className={`status ${s.seller_status === "Active" ? "Completed" : "Failed"}`}>{s.seller_status}</span>
                  {s.supabase_bound ? <span className="tree-badge charged" style={{ marginInlineStart: 6 }}>Auth✓</span> : null}
                  {/* LAUNCH MODE — who is waiting for the owner's approval */}
                  {s.verification_status === "pending" ? <span className="tree-badge" style={{ marginInlineStart: 6, background: "var(--saffron-tint)", color: "var(--saffron)" }}>{t("admin.awaiting_approval_2")}</span> : null}
                  {s.verification_status === "rejected" ? <span className="tree-badge" style={{ marginInlineStart: 6 }}>{t("admin.rejected")}</span> : null}
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
      await api.adminSellerKycDecision(String(seller.seller_id), decision, decision === "approve" ? "pilot_approved" : "pilot_rejected");
      setMsg(decision === "approve" ? t("admin.the_seller_approved_they_publish") : t("admin.the_seller_rejected"));
      setConfirmReject(false);
      onChanged();
    } catch (e: any) { setMsg(e.message || t("admin.the_action_failed")); }
    setBusy(false);
  };
  return (
    <div className={`notice ${status === "approved" ? "ok" : status === "rejected" ? "err" : "info"}`} data-testid="seller-approval" data-status={status} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>
        <b>{t("admin.seller_approval")}</b>{" "}
        {status === "approved" ? t("admin.approved") : status === "rejected" ? t("admin.rejected") : t("admin.awaiting_approval_2")}
        {" · "}
        <b data-testid="seller-can-publish">{status === "approved" ? t("admin.can_publish") : t("admin.cannot_publish_drafts_only")}</b>
      </span>
      <span className="row" style={{ marginInlineStart: "auto", gap: 8 }}>
        {status !== "approved" ? <button className="btn btn-sm btn-primary" data-testid="seller-approve" disabled={busy} onClick={() => decide("approve")}>{t("admin.approve_seller")}</button> : null}
        {status !== "rejected" ? (
          confirmReject
            ? <button className="btn btn-sm btn-danger" data-testid="seller-reject-confirm" disabled={busy} onClick={() => decide("reject")}>{t("admin.confirm_rejection")}</button>
            : <button className="btn btn-sm btn-ghost btn-danger-ghost" data-testid="seller-reject" disabled={busy} onClick={() => setConfirmReject(true)}>{t("admin.reject_2")}</button>
        ) : null}
      </span>
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
      <a className="back" href="#/admin/sellers" onClick={(e) => { e.preventDefault(); navigate("#/admin/sellers"); }}>{t("admin.to_seller_list")}</a>
      <div className="row" style={{ marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>{s.business_name || s.display_name}</h1>
        <span className={`status ${s.seller_status === "Active" ? "Completed" : "Failed"}`}>{s.seller_status}</span>
        {s.supabase_bound ? <span className="tree-badge charged">{t("admin.linked_supabase_identity")}</span> : <span className="tree-badge">{t("admin.no_auth_link")}</span>}
      </div>
      <p className="muted small" dir="ltr">{s.login_email || ""} · {s.seller_id}</p>
      <SellerApprovalPanel seller={s} onChanged={reload} />
      {/* LAUNCH POLISH (P4) — who is this seller, in one glance (no KYC infrastructure: the profile they typed) */}
      <div className="id-block" data-testid="seller-identity">
        <div><div className="k">{t("admin.business_name")}</div><div className="v">{s.business_name || t("admin.not_filled_yet")}</div></div>
        <div><div className="k">{t("admin.contact")}</div><div className="v">{s.contact_name || "—"}</div></div>
        <div><div className="k">{t("admin.phone")}</div><div className="v" dir="ltr">{s.support_phone || "—"}</div></div>
        <div><div className="k">{t("admin.support_e_mail")}</div><div className="v" dir="ltr">{s.support_email || "—"}</div></div>
        <div><div className="k">{t("admin.business_id")}</div><div className="v" dir="ltr">{s.business_identifier || "—"}</div></div>
        <div><div className="k">{t("admin.account_origin")}</div><div className="v">{s.self_signup ? t("admin.registered_own_supabase") : s.admin_note === "owner_email_claim" ? t("admin.the_owner_account") : /pilot_manual/.test(String(s.admin_note || "")) ? t("admin.linked_hand_pilot") : s.supabase_bound ? t("admin.linked_sign") : t("admin.an_account_sign_link")}</div></div>
        <div><div className="k">{t("admin.registered")}</div><div className="v">{fmtDate(s.created_at)}</div></div>
        <div><div className="k">{t("admin.last_sign")}</div><div className="v">{s.last_login_at ? fmtDate(s.last_login_at) : "—"}</div></div>
        {s.business_description ? <div style={{ gridColumn: "1 / -1" }}><div className="k">{t("admin.description")}</div><div className="v" style={{ fontWeight: 400 }}>{s.business_description}</div></div> : null}
      </div>
      {(d.warnings || []).length ? (
        <div className="notice err"><b>{t("admin.system_warnings")}</b> {(d.warnings as string[]).join(" · ")}</div>
      ) : null}
      <div className="stat-row">
        <StatTile num={num((d.deals || []).length)} label={t("admin.deals")} />
        <StatTile num={ils(d.money?.potential_gross || 0)} label={t("admin.potential_authorizations")} />
        <StatTile num={ils(d.money?.charged_gross || 0)} label={t("admin.actually_collected")} tone="good" />
        <StatTile num={ils(d.money?.platform_fee_actual || 0)} label={t("admin.actual_c_ton_fee")} />
        <StatTile num={ils(d.money?.seller_net_actual || 0)} label={t("admin.actual_net_seller")} />
      </div>

      <div className="tabbar">
        {[["deals", t("admin.deals")], ["viral", t("admin.virality")], ["support", t("admin.support_fulfilment")], ["audit", t("admin.audit_log")]].map(([k, l]) => (
          <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k!)}>{l}</button>
        ))}
      </div>

      {tab === "deals" ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{t("admin.deal")}</th><th>{t("admin.state")}</th><th className="num">{t("admin.joined")}</th><th className="num">{t("admin.charged_2")}</th><th className="num">{t("admin.in_completion")}</th><th className="num">{t("admin.potential")}</th><th className="num">{t("admin.collected")}</th><th>{t("admin.deadline")}</th></tr></thead>
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
            <div className="panel-title">{t("admin.support_enquiries")}</div>
            {(d.support_tickets || []).length ? (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>{t("admin.subject")}</th><th>{t("admin.priority")}</th><th>{t("admin.status")}</th><th>{t("admin.when")}</th></tr></thead>
                <tbody>{(d.support_tickets as Json[]).map((t) => <tr key={t.ticket_id}><td>{t.title}</td><td>{t.priority}</td><td>{t.status}</td><td>{fmtDate(t.created_at)}</td></tr>)}</tbody>
              </table></div>
            ) : <p className="muted small">{t("admin.there_open_enquiries")}</p>}
          </div>
          <div className="panel">
            <div className="panel-title">{t("admin.fulfilment_status")}</div>
            {Object.keys(d.delivery_status_counts || {}).length ? (
              <div className="row">{Object.entries(d.delivery_status_counts as Record<string, number>).map(([k, v]) => <span className="chip" key={k}>{k}: {num(v)}</span>)}</div>
            ) : <p className="muted small">{t("admin.no_fulfilment_data_yet")}</p>}
          </div>
        </>
      ) : null}
      {tab === "audit" ? (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>{t("admin.entity")}</th><th>{t("admin.change")}</th><th>{t("admin.action")}</th><th>{t("admin.when")}</th></tr></thead>
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
  return <span className={`vbadge ${value ? "ok" : "no"}`} title={value ? t("admin.label_verified_2", { label: label }) : t("admin.label_verified", { label: label })}>{value ? "✓" : "○"} {label}</span>;
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
      <h1>{t("admin.buyers_participants")}</h1>
      <p className="muted small" style={{ marginTop: -6 }}>{t("admin.e_mail_phone_sensitive_information")}</p>
      {data ? (
        <div className="stat-row">
          <StatTile num={num(buyers.length)} label={t("admin.unique_buyers")} />
          <StatTile num={num(totalUnitsCharged)} label={t("admin.units_actually_charged")} tone="good" />
          <StatTile num={ils(totalCharged)} label={t("admin.actually_collected")} tone="good" />
          <StatTile num={num(inRecovery)} label={t("admin.completing_charge")} tone={inRecovery > 0 ? "warn" : undefined} />
        </div>
      ) : null}
      <input placeholder={t("admin.search_name_phone_e_mail")} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 14 }} />
      <Err msg={error} />
      {!data ? <Spinner /> : buyers.length === 0 ? (
        <EmptyState title={t("admin.no_matching_buyers")} body={q ? t("admin.try_another_search") : t("admin.there_participations_system_yet")} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>{t("admin.name")}</th><th>{t("admin.phone")}</th><th>{t("admin.e_mail")}</th><th>{t("admin.verification")}</th>
              <th className="num">{t("admin.part")}</th><th className="num">{t("admin.deals")}</th>
              <th className="num">{t("admin.units_joined_2")}</th><th className="num">{t("admin.units_charged")}</th><th className="num">{t("admin.collected")}</th>
              <th>{t("admin.buyer_status")}</th><th>{t("admin.money_status")}</th><th>{t("admin.recent_activity")}</th>
            </tr></thead>
            <tbody>
              {buyers.map((b: Json) => (
                <tr key={b.buyer_id}>
                  <td>{b.buyer_name || "—"}</td>
                  <td dir="ltr">{b.buyer_phone || (String(b.buyer_id).match(/^[0-9+]/) ? b.buyer_id : "—")}</td>
                  <td dir="ltr" className="small">{b.buyer_email || <span className="muted">—</span>}</td>
                  <td><VerifyBadge value={Boolean(b.phone_verified)} label={t("admin.phone")} /> <VerifyBadge value={Boolean(b.email_verified)} label={t("admin.e_mail_2")} /></td>
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
      {state ? moneyStateLabel(state) : "—"}{recovery > 0 && !risk ? t("admin.recovery_completion", { recovery: num(recovery) }) : ""}
    </span>
  );
}

// ── growth (global virality) ───────────────────────────────────────────────
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
      <h1>{t("admin.virality")}</h1>
      <div className="panel" data-testid="growth-range">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="small muted">{t("admin.time_range")}</span>
          {GROWTH_RANGE_PRESETS.map((p) => (
            <button key={p.days} type="button" className={`chip-btn${range.kind === "days" && range.days === p.days ? " active" : ""}`}
              data-testid={`growth-range-${p.days}`} onClick={() => { setCustomOpen(false); setRange({ kind: "days", days: p.days }); }}>
              {p.label}
            </button>
          ))}
          <button type="button" className={`chip-btn${range.kind === "custom" || customOpen ? " active" : ""}`} data-testid="growth-range-custom"
            onClick={() => setCustomOpen((v) => !v)}>{t("admin.custom_range")}</button>
          <button type="button" className={`chip-btn${range.kind === "all" ? " active" : ""}`} data-testid="growth-range-all"
            onClick={() => { setCustomOpen(false); setRange({ kind: "all" }); }}>{t("admin.all_time")}</button>
        </div>
        {customOpen ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }} data-testid="growth-custom-range">
            <div className="field" style={{ marginBottom: 0, flex: "1 1 150px" }}>
              <label>{t("admin.from_date")}</label>
              <input type="date" dir="ltr" data-testid="growth-custom-from" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0, flex: "1 1 150px" }}>
              <label>{t("admin.to_date")}</label>
              <input type="date" dir="ltr" data-testid="growth-custom-to" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
            <button type="button" className="btn btn-sm btn-primary" data-testid="growth-custom-apply" onClick={applyCustom}>{t("admin.show")}</button>
            {customError ? <span className="small" style={{ color: "var(--pomegranate)", flexBasis: "100%" }} data-testid="growth-custom-error">{customError}</span> : null}
            <span className="hint" style={{ flexBasis: "100%" }}>{t("admin.whole_days_israel_time")}</span>
          </div>
        ) : null}
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }} data-testid="growth-window-label" data-window-kind={range.kind}>
          {t("admin.showing")} <b>{windowLabel}</b>
        </p>
      </div>
      {error ? <Err msg={error} /> : null}
      {!data ? <Spinner /> : null}
      {w ? (
        <>
          <div className="stat-row" data-testid="growth-windowed">
            <StatTile num={num(w.joins || 0)} label={t("admin.joins_windowlabel", { windowLabel: windowLabel })} />
            <StatTile num={num(w.attributed_joins || 0)} label={t("admin.joins_sharing")} tone="good" />
            <StatTile num={String(w.viral_coefficient ?? 0)} label={t("admin.viral_coefficient_range")} />
            <StatTile num={pct(w.viral_share_of_joins || 0)} label={t("admin.share_joins_sharing")} />
            <StatTile num={ils(w.attributed_charged_gmv || 0)} label={t("admin.charged_gmv_originating_sharing")} tone="good" />
            <StatTile num={num(w.attributed_charged_units || 0)} label={t("admin.units_charged_sharing")} />
          </div>
          <div className="stat-row">
            <StatTile num={num(w.personal_links || 0)} label={t("admin.personal_links_created")} />
            <StatTile num={num(w.sharing_participants || 0)} label={t("admin.participants_who_brought_friends")} />
            <StatTile num={num(w.share_button_clicks || 0)} label={t("admin.share_button_clicks")} />
            <StatTile num={num(w.link_entries || 0)} label={t("admin.visits_links")} />
            <StatTile num={num(w.deal_views || 0)} label={t("admin.deal_views")} />
            <StatTile num={num(w.max_generation || 0)} label={t("admin.chain_depth_range")} />
          </div>
          {(w.top_deals as Json[])?.length ? (
            <div className="panel">
              <div className="panel-title">{t("admin.most_viral_deals_windowlabel", { windowLabel: windowLabel })}</div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>{t("admin.deal")}</th><th className="num">{t("admin.joins_sharing")}</th><th className="num">{t("admin.units_charged_2")}</th><th className="num">{t("admin.charged_gmv")}</th><th className="num">{t("admin.depth")}</th></tr></thead>
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
          ) : <p className="muted small" data-testid="growth-window-empty">{t("admin.no_joins_sharing_selected_range")}</p>}
          {(w.top_sellers as Json[])?.length ? (
            <div className="panel">
              <div className="panel-title">{t("admin.most_viral_sellers_windowlabel", { windowLabel: windowLabel })}</div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>{t("admin.seller")}</th><th className="num">{t("admin.joins_sharing")}</th><th className="num">{t("admin.charged_gmv_sharing")}</th><th className="num">{t("admin.deals")}</th></tr></thead>
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
          <div className="panel-title">{t("admin.cumulative_since_launch_all_time")}</div>
          {!lifetime ? <p className="muted small">{t("admin.there_cumulative_virality_data_yet")}</p> : (
            <>
              <div className="stat-row">
                <StatTile num={String(lifetime.viral_coefficient ?? 0)} label={t("admin.viral_coefficient_all_time")} />
                <StatTile num={pct(lifetime.viral_share_of_joins || 0)} label={t("admin.share_joins_sharing_all_time")} />
                <StatTile num={pct(lifetime.viral_share_of_charged || 0)} label={t("admin.charge_rate_sharing_all_time")} />
                <StatTile num={ils(lifetime.attributed_charged_gmv || 0)} label={t("admin.charged_gmv_sharing_all_time")} />
                <StatTile num={num(lifetime.max_generation || 0)} label={t("admin.maximum_chain_depth_all_time")} />
              </div>
              {(data as Json)?.lifetime?.computed_at ? (
                <p className="muted small" style={{ marginBottom: 0 }}>
                  {t("admin.computed_last_at", { at: fmtDate(String((data as Json).lifetime.computed_at)) })}{(data as Json).lifetime.stale ? t("admin.awaiting_recomputation") : ""}
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
  if (s < 60) return t("admin.s_s", { s: Math.round(s) });
  if (s < 3600) return t("admin.v0_m", { v0: Math.round(s / 60) });
  return t("admin.v0_h", { v0: (s / 3600).toFixed(1) });
}

function OperationsScreen() {
  const { data, error, reload } = useFetch(() => api.adminOutboxStatus(), [], 15_000);
  if (error) return <><h1>{t("admin.operations_queue_worker")}</h1><Err msg={error} /></>;
  if (!data) return <><h1>{t("admin.operations_queue_worker")}</h1><Spinner /></>;
  const d = data as Json;
  const o = d.outbox || {};
  const w = d.worker || {};
  const instances: Json[] = w.instances || [];
  const dlq = Number(o.dlq || 0);
  const stuck = Number(o.stuck_candidates || 0);
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{t("admin.operations_queue_worker")}</h1>
        <button className="btn btn-sm btn-ghost" onClick={reload}>{t("admin.refresh")}</button>
      </div>
      <div className="stat-row">
        <StatTile num={w.running ? t("admin.active") : t("admin.not_reported")} label="Worker" tone={w.running ? "good" : "bad"} sub={t("admin.v0_instances", { v0: num(w.active_count || 0) })} />
        <StatTile num={num(o.due_now ?? o.pending ?? 0)} label={t("admin.to_run_now_active_queue")} tone={Number(o.due_now ?? 0) > 20 ? "warn" : undefined} />
        <StatTile num={num(o.scheduled_future ?? 0)} label={t("admin.scheduled_future")} sub={o.next_scheduled_in_s != null ? t("admin.next_next_scheduled_s", { next_scheduled_in_s: ageLabel(o.next_scheduled_in_s) }) : t("admin.none")} />
        <StatTile num={num(o.processing || 0)} label={t("admin.being_processed_now")} />
        <StatTile num={num(o.sent || 0)} label={t("admin.completed")} tone="good" />
      </div>
      <div className="stat-row">
        <StatTile num={num(o.failed || 0)} label={t("admin.failed")} tone={Number(o.failed) > 0 ? "warn" : undefined} />
        <StatTile num={num(dlq)} label={t("admin.dlq_dead_letters")} tone={dlq > 0 ? "bad" : "good"} />
        <StatTile num={num(stuck)} label={t("admin.stuck_leases")} tone={stuck > 0 ? "warn" : "good"} sub={t("admin.threshold_v0_s", { v0: num((o.stuck_timeout_ms || 0) / 1000) })} />
        <StatTile num={ageLabel(o.oldest_due_age_s)} label={t("admin.the_oldest_pending_run")} tone={Number(o.oldest_due_age_s) > 300 ? "warn" : undefined} />
      </div>
      {Number(o.scheduled_future ?? 0) > 0 && Number(o.due_now ?? 0) === 0 ? (
        <div className="notice info">{t("admin.all_scheduled_future_pending_jobs", { scheduled_future: num(o.scheduled_future) })}</div>
      ) : null}
      <div className="panel">
        <div className="panel-title">{t("admin.worker_runs_heartbeat")}</div>
        {instances.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>{t("admin.worker_id")}</th><th>{t("admin.status")}</th><th>{t("admin.last_heartbeat")}</th><th>{t("admin.enabled")}</th><th>{t("admin.refresh")}</th></tr></thead>
            <tbody>{instances.map((r) => (
              <tr key={r.worker_id}>
                <td dir="ltr" className="small">{r.worker_id}</td>
                <td><span className={`status ${r.status === "ready" ? "Completed" : "ClosedForJoining"}`}>{r.status}</span></td>
                <td>{timeAgo(r.heartbeat_at)}</td>
                <td>{timeAgo(r.started_at)}</td>
                <td>{r.fresh ? <span className="vbadge ok">{t("admin.fresh")}</span> : <span className="vbadge no">{t("admin.stale")}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <EmptyState title={t("admin.no_worker_instances_reported")} body={t("admin.if_worker_running_heartbeat_appear")} />}
      </div>
      {dlq > 0 ? <div className="notice err">{t("admin.there_dlq_jobs_dlq_manual", { dlq: num(dlq) })}</div> : null}
    </>
  );
}

function PaymentsScreen() {
  const { data, error } = useFetch(() => api.adminPaymentOps(), [], 30_000);
  if (error) return <><h1>{t("admin.payments_settlement")}</h1><Err msg={error} /></>;
  if (!data) return <><h1>{t("admin.payments_settlement")}</h1><Spinner /></>;
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
      <h1>{t("admin.payments_settlement")}</h1>
      <div className={`notice ${synthetic ? "info" : "err"}`}>
        {synthetic
          ? <><b>{t("admin.synthetic_provider_mockpay")}</b>  {t("admin.every_amount_here_synthetic_test")}</>
          : <><b>{t("admin.real_provider_active")}</b> {String(prov.provider || "")} · {String(prov.mode || "")}</>}
      </div>
      <div className="stat-row">
        <StatTile num={ils(ledger.gross_charged || 0)} label={synthetic ? t("admin.synthetic_gross_collected") : t("admin.gross_collected")} tone="good" />
        <StatTile num={ils(ledger.fee_total || 0)} label={t("admin.c_ton_fee_base_vat")} sub={t("admin.base_v0_vat_v1", { v0: ils(ledger.fee_base || 0), v1: ils(ledger.fee_vat || 0) })} />
        <StatTile num={num(ledger.entries || 0)} label={t("admin.ledger_records")} />
        <StatTile num={num(ledger.refund_entries || 0)} label={t("admin.refunds")} tone={Number(ledger.refund_entries) > 0 ? "warn" : undefined} />
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>{ledger.note}</p>
      <div className="panel">
        <div className="panel-title">{t("admin.charge_attempts_type")}</div>
        {byType.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>{t("admin.type")}</th><th className="num">{t("admin.successes")}</th><th className="num">{t("admin.temporary_failure")}</th><th className="num">{t("admin.permanent_failure")}</th><th className="num">{t("admin.unknown")}</th></tr></thead>
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
        ) : <p className="muted small">{t("admin.no_charge_attempts_yet")}</p>}
      </div>
      <div className="panel">
        <div className="panel-title">{t("admin.recent_charge_attempts_correlation_ids")}</div>
        {attempts.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>{t("admin.when")}</th><th>{t("admin.deal")}</th><th>{t("admin.buyer")}</th><th>{t("admin.type")}</th><th>{t("admin.result")}</th><th>{t("admin.correlation_id")}</th></tr></thead>
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
        ) : <p className="muted small">{t("admin.no_charge_attempts_yet")}</p>}
      </div>
      {ledgerRows.length ? (
        <div className="panel">
          <div className="panel-title">{t("admin.recent_fee_ledger_records")}</div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>{t("admin.when")}</th><th>{t("admin.deal")}</th><th>{t("admin.type")}</th><th className="num">{t("admin.gross")}</th><th className="num">{t("admin.c_ton_fee")}</th><th>{t("admin.correlation")}</th></tr></thead>
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
  if (error) return <><h1>{t("admin.notifications")}</h1><Err msg={error} /></>;
  if (!data) return <><h1>{t("admin.notifications")}</h1><Spinner /></>;
  const d = data as Json;
  const n = d.notifications || {};
  const prov = n.provider || {};
  const logOnly = !prov.external_delivery;
  const events: Json[] = (d.recent_events || []).filter((e: Json) => filter === "all" || e.status === filter);
  return (
    <>
      <h1>{t("admin.notifications")}</h1>
      <div className={`notice ${logOnly ? "info" : "err"}`}>
        {logOnly
          ? <><b>{t("admin.log_only_synthetic")}</b>  {t("admin.notifications_written_log_only_sent")}</>
          : <><b>{t("admin.real_sending_active")}</b> {String(prov.code)} · {String(prov.mode)}</>}
      </div>
      <div className="stat-row">
        <StatTile num={num(n.sent || 0)} label={logOnly ? t("admin.processed_log_only") : t("admin.sent")} tone="good" />
        <StatTile num={num(n.pending || 0)} label={t("admin.pending")} tone={Number(n.pending) > 20 ? "warn" : undefined} />
        <StatTile num={num(n.failed || 0)} label={t("admin.failed")} tone={Number(n.failed) > 0 ? "bad" : "good"} />
        <StatTile num={num(n.skipped || 0)} label={t("admin.skipped")} />
        <StatTile num={ageLabel(n.oldest_pending_age_s)} label={t("admin.oldest_pending")} />
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {["all", "sent", "pending", "failed", "skipped"].map((f) => (
          <button key={f} className={`chip-btn${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f === "all" ? t("admin.all") : notificationStatusLabel(f)}</button>
        ))}
      </div>
      <div className="panel">
        <div className="panel-title">{t("admin.recent_notification_events")}</div>
        {events.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>{t("admin.when")}</th><th>{t("admin.event_type")}</th><th>{t("admin.recipient")}</th><th>{t("admin.channel")}</th><th>{t("admin.adapter")}</th><th>{t("admin.status")}</th><th className="num">{t("admin.attempts")}</th><th>{t("admin.deal")}</th><th>{t("admin.last_error")}</th></tr></thead>
            <tbody>{events.map((e) => (
              <tr key={e.notification_id}>
                <td>{fmtDate(e.created_at)}</td>
                <td dir="ltr" className="small">{e.event_type}</td>
                <td className="small">{e.recipient_type}</td>
                <td className="small">{e.channel}</td>
                <td><span className="vbadge no" title="log-only synthetic adapter">{e.adapter}{e.adapter_mode && e.adapter_mode !== e.adapter ? `/${e.adapter_mode}` : ""}</span></td>
                <td><span className={`status small ${NOTIF_STATUS_TONE[String(e.status)] || "ClosedForJoining"}`}>{notificationStatusLabel(String(e.status))}</span></td>
                <td className="num">{num(e.attempts)}</td>
                <td className="small">{e.deal_title || "—"}</td>
                <td className="small" style={{ color: e.last_error ? "var(--pomegranate)" : undefined }}>{e.last_error || "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <EmptyState title={t("admin.no_notification_events")} body={t("admin.notifications_created_automatically_deal_events")} />}
      </div>
    </>
  );
}

const CASE_TYPE_HE: Record<string, string> = {
  RefundRequest: "admin.case_type_he.refund_request",
  DeliveryIssue: "admin.case_type_he.delivery_issue",
  SellerRisk: "admin.case_type_he.seller_risk",
  BuyerComplaint: "admin.case_type_he.buyer_complaint",
  PaymentMismatch: "admin.case_type_he.payment_mismatch",
  InvoiceIssue: "admin.case_type_he.invoice_issue",
  ContentReport: "admin.case_type_he.content_report",
  SystemException: "admin.case_type_he.system_exception",
  Other: "admin.case_type_he.other"
};
const CASE_STATUS_HE: Record<string, string> = {
  Open: "admin.case_status_he.open",
  NeedsSeller: "admin.case_status_he.needs_seller",
  NeedsAdmin: "admin.case_status_he.needs_admin",
  // P0.5: an admin customer-reply moves the case here — presented as answered
  WaitingExternal: "admin.case_status_he.waiting_external",
  Resolved: "admin.case_status_he.resolved",
  Closed: "admin.case_status_he.closed"
};
const CASE_PRIORITY_HE: Record<string, string> = { Low: "admin.case_priority_he.low", Normal: "admin.case_priority_he.normal", High: "admin.case_priority_he.high", Urgent: "admin.case_priority_he.urgent" };
const CASE_SOURCE_HE: Record<string, string> = { Admin: "admin.case_source_he.admin", Buyer: "admin.case_source_he.buyer", Seller: "admin.case_source_he.seller", System: "admin.case_source_he.system" };

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

  if (error) return <><button className="btn btn-sm btn-ghost" onClick={onBack}>{t("admin.to_enquiry_list")}</button><Err msg={error} /></>;
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
        ? t("admin.the_internal_note_saved")
        : r.email_delivery?.note_he || t("admin.the_reply_saved_external_e"));
      reload();
    } catch (e: any) { setSendError(e.message || t("admin.sending_failed")); }
    setBusy(false);
  };

  const setStatus = async (status: string, resolutionNote?: string) => {
    setBusy(true); setSendError("");
    try {
      await api.adminSupportCaseUpdate(caseId, resolutionNote ? { status, resolution_note: resolutionNote } : { status });
      reload();
    } catch (e: any) { setSendError(e.message || t("admin.updating_status_failed")); }
    setBusy(false);
  };

  return (
    <div data-testid="support-case-detail">
      <button className="btn btn-sm btn-ghost" onClick={onBack}>{t("admin.to_enquiry_list")}</button>
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{c.subject || t("admin.enquiry_2")}</h2>
          <span className={`status ${["Resolved", "Closed"].includes(String(c.status)) ? "Completed" : String(c.status) === "WaitingExternal" ? "TargetReached" : String(c.status) === "NeedsAdmin" ? "CompletionWindow" : "PendingTarget"}`} data-testid="case-status">
            {tKey(CASE_STATUS_HE[String(c.status)], c.status)}
          </span>
        </div>
        <div className="kv" style={{ marginTop: 10 }}>
          <span className="k">{t("admin.enquiry")}</span><span className="v" dir="ltr">{String(c.case_id || "").slice(0, 8)}</span>
          <span className="k">{t("admin.category")}</span><span className="v">{tKey(CASE_TYPE_HE[String(c.case_type)], c.case_type)}</span>
          <span className="k">{t("admin.source")}</span><span className="v">{tKey(CASE_SOURCE_HE[String(c.source)], c.source)}</span>
          <span className="k">{t("admin.priority")}</span><span className="v">{tKey(CASE_PRIORITY_HE[String(c.priority)], c.priority)}</span>
          {c.buyer_ref ? (<><span className="k">{t("admin.sender_s_e_mail")}</span><span className="v" dir="ltr">{c.buyer_ref}</span></>) : null}
          {c.deal_title ? (<><span className="k">{t("admin.deal")}</span><span className="v">{c.deal_title}</span></>) : null}
          <span className="k">{t("admin.opened")}</span><span className="v">{fmtDate(c.created_at)}</span>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
          {String(c.status) !== "NeedsAdmin" && !["Resolved", "Closed"].includes(String(c.status)) ? (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setStatus("NeedsAdmin")}>{t("admin.mark_being_handled")}</button>
          ) : null}
          {["Resolved", "Closed"].includes(String(c.status)) ? (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setStatus("NeedsAdmin")}>{t("admin.reopen")}</button>
          ) : (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => {
              const note = window.prompt(t("admin.closing_note_required"), t("admin.handled_sender"));
              if (note && note.trim()) void setStatus("Resolved", note.trim());
            }}>{t("admin.close_enquiry")}</button>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">{t("admin.conversation")}</div>
        <div className="case-thread" data-testid="case-thread">
          <div className="case-msg customer">
            <div className="case-msg-head">{t("admin.the_sender_created", { created_at: fmtDate(c.created_at) })}</div>
            <div className="case-msg-body">{c.description || "—"}</div>
          </div>
          {messages.map((m) => (
            <div key={m.message_id} className={`case-msg ${m.sender_type === "Admin" ? "admin" : m.sender_type === "InternalNote" ? "internal" : "customer"}`}>
              <div className="case-msg-head">
                {m.sender_type === "Admin" ? t("admin.the_c_ton_team") : m.sender_type === "InternalNote" ? t("admin.internal_note_sent_sender") : t("admin.the_sender")}
                {" · "}{fmtDate(m.created_at)}
                {m.sender_type === "Admin" ? (
                  <span className="case-delivery" data-testid="delivery-state">
                    {" · "}{String(m.delivery_status) === "Sent" ? t("admin.sent_e_mail") : String(m.delivery_status) === "Queued" ? t("admin.queued_sending") : t("admin.saved_e_mail_sent")}
                  </span>
                ) : null}
              </div>
              <div className="case-msg-body">{m.body}</div>
            </div>
          ))}
        </div>
        <div className="case-composer">
          <textarea rows={3} placeholder={t("admin.type_reply")} value={replyText} maxLength={4000}
            onChange={(e) => setReplyText(e.target.value)} data-testid="reply-input" />
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
              <span>{t("admin.internal_note_only_meant_sender")}</span>
            </label>
            <button className="btn btn-primary" disabled={busy || replyText.trim().length < 2} data-testid="reply-send" onClick={() => { void send(); }}>
              {busy ? t("admin.sending") : internal ? t("admin.save_note") : t("admin.send_reply")}
            </button>
          </div>
          {notice ? <div className="notice info" data-testid="reply-notice">{notice}</div> : null}
          {sendError ? <div className="notice err">{sendError}</div> : null}
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {t("admin.external_e_mail_sending_active")}</p>
        </div>
      </div>
    </div>
  );
}

function SupportScreen() {
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  if (openCaseId) return <><h1>{t("admin.support_enquiries_2")}</h1><SupportCaseDetail caseId={openCaseId} onBack={() => setOpenCaseId(null)} /></>;
  return <JsonStatScreen title={t("admin.support_enquiries_2")} fetcher={() => api.adminSupportCases()} render={(d) => {
    const cases: Json[] = d.cases || d.support_cases || [];
    const summary = d.summary || {};
    return (
      <>
        <div className="stat-row">
          <StatTile num={num(summary.open_count || 0)} label={t("admin.open_enquiries")} />
          <StatTile num={num(summary.needs_admin_count || 0)} label={t("admin.with_team")} tone={Number(summary.needs_admin_count) > 0 ? "warn" : undefined} />
          <StatTile num={num(summary.urgent_count || 0)} label={t("admin.urgent")} tone={Number(summary.urgent_count) > 0 ? "bad" : "good"} />
          <StatTile num={num(summary.older_than_48h_count || 0)} label={t("admin.pending_over_48_hours")} tone={Number(summary.older_than_48h_count) > 0 ? "warn" : undefined} />
        </div>
        {cases.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>{t("admin.subject")}</th><th>{t("admin.category")}</th><th>{t("admin.source")}</th><th>{t("admin.priority")}</th><th>{t("admin.status")}</th><th>{t("admin.details")}</th><th>{t("admin.when")}</th><th /></tr></thead>
            <tbody>{cases.map((c, i) => (
              <tr key={c.case_id || i} className="case-row" onClick={() => setOpenCaseId(String(c.case_id))} style={{ cursor: "pointer" }}>
                <td><b>{c.subject || "—"}</b>{c.buyer_ref ? <div className="muted small" dir="ltr">{c.buyer_ref}</div> : null}</td>
                <td>{tKey(CASE_TYPE_HE[String(c.case_type)], c.case_type)}</td>
                <td>{tKey(CASE_SOURCE_HE[String(c.source)], c.source)}</td>
                <td>{tKey(CASE_PRIORITY_HE[String(c.priority)], c.priority)}</td>
                <td><span className={`status ${["Resolved", "Closed"].includes(String(c.status)) ? "Completed" : String(c.status) === "NeedsAdmin" ? "CompletionWindow" : "PendingTarget"}`}>{tKey(CASE_STATUS_HE[String(c.status)], c.status)}</span></td>
                <td className="small" style={{ maxWidth: 340, whiteSpace: "pre-wrap" }}>{String(c.description || "").slice(0, 220)}</td>
                <td>{fmtDate(c.created_at)}</td>
                <td><button className="btn btn-sm btn-ghost" data-testid="case-open" onClick={(e) => { e.stopPropagation(); setOpenCaseId(String(c.case_id)); }}>{t("admin.open_2")}</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <EmptyState title={t("admin.no_open_enquiries")} />}
      </>
    );
  }} />;
}

function AuditScreen() {
  const [q, setQ] = useState("");
  const { data, error } = useFetch(() => api.adminAudit(q), [q]);
  return (
    <>
      <h1>{t("admin.audit_log")}</h1>
      <input placeholder={t("admin.search_action_id_correlation")} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 14 }} />
      <Err msg={error} />
      {!data ? <Spinner /> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>{t("admin.when")}</th><th>{t("admin.deal")}</th><th>{t("admin.entity")}</th><th>{t("admin.change")}</th><th>{t("admin.action")}</th></tr></thead>
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
  if (error) return <><h1>{t("admin.system_health")}</h1><Err msg={error} /></>;
  if (!data) return <><h1>{t("admin.system_health")}</h1><Spinner /></>;
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
    { label: t("admin.database_connection"), ok: dbOk },
    { label: t("admin.storage"), ok: Boolean(storage.durable), warn: !storage.durable },
    { label: t("admin.job_queue"), ok: activeOutbox < 50, warn: activeOutbox >= 50 },
    { label: "DLQ", ok: dlq === 0, warn: false },
    { label: t("admin.migrations_schema"), ok: true }
  ];
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{t("admin.system_health")}</h1>
        <button className="btn btn-sm btn-ghost" onClick={reload}>{t("admin.refresh")}</button>
      </div>

      <div className="panel">
        <div className="panel-title">{t("admin.safety_mode_synthetic_safety")}</div>
        <div className="safety-row">
          <SafetyBadge on={Boolean(badges.real_money)} label="Real Money" />
          <SafetyBadge on={Boolean(badges.grow)} label="Grow" />
          <SafetyBadge on={Boolean(badges.real_sms)} label="Real SMS" />
          <SafetyBadge on={Boolean(badges.real_email)} label="Real Email" />
          <SafetyBadge on={Boolean(badges.real_invoice)} label="Real Invoice" />
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>{t("admin.every_flag_should_off_stage")}</p>
      </div>

      <div className="panel">
        <div className="panel-title">{t("admin.health_console")}</div>
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
        <StatTile num={num(activeOutbox)} label={t("admin.active_jobs_queue")} tone={activeOutbox > 50 ? "warn" : undefined} />
        <StatTile num={num(dlq)} label="DLQ" tone={dlq > 0 ? "bad" : "good"} />
        <StatTile num={num(counts.failed_webhooks || 0)} label={t("admin.failed_webhooks")} tone={Number(counts.failed_webhooks) > 0 ? "warn" : undefined} />
        <StatTile num={num(counts.open_support_tickets || 0)} label={t("admin.open_support_enquiries")} />
      </div>

      <div className="panel-grid-2">
        <div className="panel">
          <div className="panel-title">{t("admin.storage")}</div>
          <div className="kv">
            <span className="k">{t("admin.provider")}</span><span className="v" dir="ltr">{storage.provider || "—"}</span>
            <span className="k">{t("admin.adapter")}</span><span className="v" dir="ltr">{storage.adapter || "—"}</span>
            <span className="k">{t("admin.durable")}</span><span className="v">{storage.durable ? <span className="vbadge ok">{t("admin.yes")}</span> : <span className="vbadge no">{t("admin.no")}</span>}</span>
            <span className="k">{t("admin.safe_run_multiple_instances")}</span><span className="v">{storage.multi_instance_safe ? <span className="vbadge ok">{t("admin.yes")}</span> : <span className="vbadge no">{t("admin.no")}</span>}</span>
            <span className="k">{t("admin.scale_status")}</span><span className="v" dir="ltr">{storage.scale_status || "—"}</span>
          </div>
        </div>
        <div className="panel">
          <div className="panel-title">{t("admin.providers_activation_states")}</div>
          <div className="kv">
            <span className="k">{t("admin.payments")}</span><span className="v" dir="ltr">{payment.provider || "—"} · {payment.mode || "—"}</span>
            <span className="k">{t("admin.notifications")}</span><span className="v" dir="ltr">{notif.provider || "—"} · {notif.external_delivery ? "external" : "log-only"}</span>
            <span className="k">{t("admin.deployment_state")}</span><span className="v" dir="ltr">{s.deployment?.mode || "—"}</span>
          </div>
        </div>
      </div>
      {Array.isArray(s.notes) && s.notes.length ? (
        <div className="panel">
          <div className="panel-title">{t("admin.system_notes")}</div>
          <ul className="notes-list">{s.notes.map((note: string, i: number) => <li key={i}>{note}</li>)}</ul>
        </div>
      ) : null}
    </>
  );
}

// ── shell ──────────────────────────────────────────────────────────────────
// Grouped IA: commerce first (the operator's daily work), growth second,
// platform plumbing last.
// Group label and item label are TRANSLATION KEYS (module-level constant).
const NAV_GROUPS: { label: string; items: [string, string][] }[] = [
  { label: "", items: [["overview", "admin.nav_groups.items"]] },
  { label: "admin.nav_groups.label", items: [["deals", "admin.nav_groups.items_2"], ["sellers", "admin.nav_groups.items_3"], ["buyers", "admin.nav_groups.items_4"]] },
  { label: "admin.nav_groups.label_2", items: [["growth", "admin.nav_groups.items_5"]] },
  { label: "admin.nav_groups.label_3", items: [["operations", "admin.nav_groups.items_6"], ["payments", "admin.nav_groups.items_7"], ["notifications", "admin.nav_groups.items_8"], ["support", "admin.nav_groups.items_9"]] },
  { label: "admin.nav_groups.label_4", items: [["content", "admin.nav_groups.items_10"], ["audit", "admin.nav_groups.items_11"], ["system", "admin.nav_groups.items_12"]] }
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
  if (!verified) return <Spinner label={t("admin.verifying_permissions")} />;

  const [screenRaw, param] = sub.length ? sub : ["overview"];
  const screen = screenRaw || "overview";
  const stateParam = typeof window !== "undefined" && window.location.hash.includes("state=")
    ? new URLSearchParams(window.location.hash.split("?")[1] || "").get("state") || undefined
    : undefined;

  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label={t("admin.admin_navigation")}>
        <div className="admin-nav-title"><BrandMark size={26} />  {t("admin.c_ton_admin")}</div>
        {NAV_GROUPS.map((group) => (
          <React.Fragment key={group.label || "root"}>
            {group.label ? <div className="admin-nav-group">{t(group.label)}</div> : null}
            {group.items.map(([key, label]) => (
              <button key={key} className={screen.startsWith(key) || (key === "deals" && screen === "deal") || (key === "sellers" && screen === "seller") ? "active" : ""} onClick={() => navigate(`#/admin/${key}`)}>
                {t(label)}
              </button>
            ))}
          </React.Fragment>
        ))}
        <button style={{ marginTop: "auto", opacity: .7 }} data-testid="admin-lock" onClick={() => { lockAdmin(); window.location.hash = "#/"; window.location.reload(); }}>{t("admin.lock_admin")}</button>
        <button style={{ opacity: .7 }} onClick={() => { clearAuthSession(); clearOwnerSession(); window.location.hash = "#/"; window.location.reload(); }}>{t("admin.sign_out")}</button>
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
        {screen === "content" ? <ContentAdmin /> : null}
      </main>
    </div>
  );
}
