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
import { t, tKey } from "../i18n";

type Range = "24h" | "7d" | "30d" | "all";
const RANGES: Array<{ key: Range; label: string }> = [
  { key: "24h", label: "distribution.ranges.label" },
  { key: "7d", label: "distribution.ranges.label_2" },
  { key: "30d", label: "distribution.ranges.label_3" },
  { key: "all", label: "distribution.ranges.label_4" }
];

type MetricKey = "entries" | "unique_visitors" | "joins" | "joined_units" | "charged_units" | "attributed_gross";
const METRICS: Array<{ key: MetricKey; label: string; money?: boolean }> = [
  { key: "entries", label: "distribution.metrics.label" },
  { key: "unique_visitors", label: "distribution.metrics.label_2" },
  { key: "joins", label: "distribution.metrics.label_3" },
  { key: "joined_units", label: "distribution.metrics.label_4" },
  { key: "charged_units", label: "distribution.metrics.label_5" },
  { key: "attributed_gross", label: "distribution.metrics.label_6", money: true }
];

const CHANNEL_SUGGESTIONS = ["whatsapp", "facebook", "instagram", "telegram", "newsletter", "sms", "influencer", "paid", "other"];
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "distribution.channel_labels.whatsapp", facebook: "distribution.channel_labels.facebook", instagram: "distribution.channel_labels.instagram", telegram: "distribution.channel_labels.telegram", newsletter: "distribution.channel_labels.newsletter",
  sms: "SMS", influencer: "distribution.channel_labels.influencer", paid: "distribution.channel_labels.paid", other: "distribution.channel_labels.other"
};
function channelLabel(channel: unknown): string {
  const raw = String(channel || "").trim();
  return raw ? tKey(CHANNEL_LABELS[raw.toLowerCase()], raw) : "—";
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
      <StatTile num={num(m.entries)} label={t("distribution.visits")} />
      <StatTile num={num(m.unique_visitors)} label={t("distribution.unique_visitors")} />
      <StatTile num={num(m.joins)} label={t("distribution.joins")} sub={t("distribution.a_buyer_s_commitment_sale")} />
      <StatTile num={num(m.joined_units)} label={t("distribution.units_joined")} />
      <StatTile num={num(m.charged_units)} label={t("distribution.units_finally_charged")} tone="good" />
      <StatTile num={ils(m.attributed_gross)} label={t("distribution.attributed_gross_actually_collected")} tone="good" />
      <StatTile num={pct(m.conversion_entry_to_join)} label={t("distribution.conversion_visit_join")} />
      <StatTile num={pct(m.conversion_entry_to_final_charge)} label={t("distribution.conversion_visit_final_charge")} />
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
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("distribution.over_time")}</div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label={t("distribution.time_range")}>
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={`chip${range === r.key ? " active" : ""}`} data-testid={`range-${r.key}`} onClick={() => onRange(r.key)}>{t(r.label)}</button>
          ))}
        </div>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "10px 0" }} role="group" aria-label={t("distribution.metric")}>
        {METRICS.map((m) => (
          <button key={m.key} type="button" className={`chip${metric === m.key ? " active" : ""}`} data-testid={`metric-${m.key}`} onClick={() => onMetric(m.key)}>{t(m.label)}</button>
        ))}
      </div>
      <div className="chart-box">
        <div className="chart-title">{t("distribution.chart_title", { metric: t(def.label), bucket: series?.bucket === "hour" ? t("distribution.by_hour") : t("distribution.by_day"), total: def.money ? ils(total) : num(total) })}</div>
        {points.length ? (
          <BarChart points={points} color={def.key === "charged_units" || def.key === "attributed_gross" ? "var(--success)" : "var(--brand)"} height={90} formatValue={def.money ? (v) => ils(v) : undefined} />
        ) : <p className="muted small chart-empty">{t("distribution.there_data_selected_range_yet")}</p>}
      </div>
    </div>
  );
}

export function DistributionDisclaimer({ text }: { text?: string }) {
  return (
    <p className="muted small" data-testid="distribution-disclaimer" style={{ marginTop: 10 }}>
      {text || t("distribution.the_figures_shown_measurement_attribution")}
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
  if (await copyText(url)) notify(t("distribution.link_copied"));
  else notify(t("distribution.copying_failed_select_link_copy"));
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
    if (!internalName) { setFormError(t("distribution.give_link_internal_name")); return; }
    setBusy(true); setFormError("");
    try {
      await api.createDistributionLink(dealId, { internal_name: internalName, channel: channel.trim() || undefined });
      setName(""); setChannel(""); setCreating(false);
      showToast(t("distribution.the_link_created_copy_share"));
      await load();
    } catch (err: any) {
      const code = String(err?.body?.code || err?.body?.error || "");
      setFormError(
        code === "distribution_link_deal_not_open" ? t("distribution.links_only_created_deal_published")
          : err?.status === 409 ? t("distribution.a_link_name_already_exists")
            : String(err?.message || t("distribution.creating_link_failed"))
      );
    }
    setBusy(false);
  };

  const patch = async (link: Json, body: Json, okMsg: string) => {
    try {
      await api.updateDistributionLink(dealId, String(link.link_id), body);
      showToast(okMsg);
      await load();
    } catch (err: any) { showToast(err?.status === 409 ? t("distribution.a_link_name_already_exists_2") : String(err?.message || t("distribution.the_update_failed"))); }
  };

  if (error) return <div className="panel"><div className="panel-title">{t("distribution.distribution_measurement")}</div><p className="muted small">{error}</p></div>;
  if (!payload) return <div className="panel"><div className="panel-title">{t("distribution.distribution_measurement")}</div><BrandLoader label={t("distribution.loading_distribution_links")} minHeight={120} /></div>;

  const totals = payload.totals || {};
  const hasLinks = links.length > 0;

  return (
    <div className="panel" data-testid="distribution-panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("distribution.distribution_measurement_links_deal")}</div>
        {hasLinks && dealOpen ? (
          <button type="button" className="btn btn-sm btn-primary" data-testid="distribution-create-open" onClick={() => setCreating((v) => !v)}>{t("distribution.new_distribution_link")}</button>
        ) : null}
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        {t("distribution.attribution_rule_v0", { v0: String(payload.attribution_rule?.description_he || t("distribution.the_last_link_buyer_came")) })}
      </p>

      {!hasLinks && !creating ? (
        <EmptyState
          title={t("distribution.you_haven_t_created_any")}
          body={dealOpen ? t("distribution.create_link_every_channel_whatsapp") : t("distribution.new_links_only_created_while")}
          action={dealOpen ? <button type="button" className="btn btn-primary" data-testid="distribution-create-first" onClick={() => setCreating(true)}>{t("distribution.create_first_link")}</button> : undefined}
        />
      ) : null}

      {creating ? (
        <form onSubmit={create} className="panel" style={{ marginTop: 12 }} data-testid="distribution-create-form">
          <div className="field-row">
            <div className="field">
              <label htmlFor="dist-link-name">{t("distribution.internal_name")} <span className="hint">{t("distribution.only_see")}</span></label>
              <input id="dist-link-name" data-testid="distribution-link-name" value={name} maxLength={80} placeholder={t("distribution.for_example_whatsapp_group_influencer")} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dist-link-channel">{t("distribution.channel_source")} <span className="hint">{t("distribution.optional")}</span></label>
              <input id="dist-link-channel" data-testid="distribution-link-channel" list="dist-channel-options" value={channel} maxLength={40} placeholder="whatsapp, facebook, newsletter…" onChange={(e) => setChannel(e.target.value)} />
              <datalist id="dist-channel-options">{CHANNEL_SUGGESTIONS.map((c) => <option key={c} value={c}>{tKey(CHANNEL_LABELS[c], c)}</option>)}</datalist>
            </div>
          </div>
          {formError ? <p className="field-error">{formError}</p> : null}
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary" data-testid="distribution-create-submit" disabled={busy}>{busy ? t("distribution.creating") : t("distribution.create_link")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setCreating(false); setFormError(""); }}>{t("distribution.cancel")}</button>
          </div>
        </form>
      ) : null}

      {hasLinks ? (
        <>
          <div className="stat-row" style={{ margin: "12px 0 8px" }} data-testid="distribution-totals">
            <StatTile num={num(totals.entries)} label={t("distribution.visits_all_links")} />
            <StatTile num={num(totals.joins)} label={t("distribution.joins")} />
            <StatTile num={num(totals.charged_units)} label={t("distribution.units_finally_charged")} tone="good" />
            <StatTile num={ils(totals.attributed_gross)} label={t("distribution.attributed_gross")} tone="good" />
          </div>
          <div className="table-wrap">
            <table className="data" data-testid="distribution-links-table">
              <thead>
                <tr>
                  <th>{t("distribution.name")}</th>
                  <th>{t("distribution.channel")}</th>
                  <th>{t("distribution.status")}</th>
                  <th className="num clickable" onClick={() => toggleSort("entries")}>{t("distribution.visits_v0", { v0: sortMark("entries") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("joins")}>{t("distribution.joins_v0", { v0: sortMark("joins") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("joined_units")}>{t("distribution.units_v0", { v0: sortMark("joined_units") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("charged_units")}>{t("distribution.finally_charged_v0", { v0: sortMark("charged_units") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("attributed_gross")}>{t("distribution.attributed_gross_v0", { v0: sortMark("attributed_gross") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("conversion_entry_to_join")}>{t("distribution.conversion_v0", { v0: sortMark("conversion_entry_to_join") })}</th>
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
                          <form onSubmit={async (e) => { e.preventDefault(); const value = String(renaming?.value || "").trim(); setRenaming(null); if (value && value !== link.internal_name) await patch(link, { internal_name: value }, t("distribution.the_name_updated")); }} className="row" style={{ gap: 6 }}>
                            <input autoFocus value={renaming.value} maxLength={80} onChange={(e) => setRenaming({ id: String(link.link_id), value: e.target.value })} data-testid="distribution-rename-input" />
                            <button type="submit" className="btn btn-sm btn-primary">{t("distribution.save")}</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>{t("distribution.cancel")}</button>
                          </form>
                        ) : (
                          <>
                            <b>{link.internal_name}</b>
                            <div className="muted small" dir="ltr" style={{ textAlign: "end" }}>{url}</div>
                            {link.external_access?.enabled ? <span className="channel-chip">{t("distribution.external_access")}</span> : null}
                          </>
                        )}
                      </td>
                      <td>{channelLabel(link.channel)}</td>
                      <td><span className={`status ${disabled ? "Cancelled" : "TargetReached"}`}>{disabled ? t("distribution.disabled") : t("distribution.active")}</span></td>
                      <td className="num">{num(m.entries)}</td>
                      <td className="num">{num(m.joins)}</td>
                      <td className="num">{num(m.joined_units)}</td>
                      <td className="num">{num(m.charged_units)}</td>
                      <td className="num">{ils(m.attributed_gross)}</td>
                      <td className="num">{pct(m.conversion_entry_to_join)}</td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-copy" onClick={async () => { if (await copyText(url)) showToast(t("distribution.link_copied")); else showToast(t("distribution.copying_failed")); }}>{t("distribution.copy")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-share" onClick={() => nativeOrCopy(url, dealTitle, showToast)}>{t("distribution.share")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => shareViaWhatsApp(url, dealTitle)}>{t("distribution.whatsapp")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-rename" onClick={() => setRenaming({ id: String(link.link_id), value: String(link.internal_name) })}>{t("distribution.rename")}</button>
                          <button type="button" className="btn btn-sm btn-primary" data-testid="distribution-open-dashboard" onClick={() => navigate(`#/seller/deal/${dealId}/distribution/${link.link_id}`)}>{t("distribution.performance")}</button>
                          <button type="button" className={`btn btn-sm ${disabled ? "btn-ghost" : "btn-danger-ghost"}`} data-testid="distribution-toggle" onClick={() => patch(link, { status: disabled ? "active" : "disabled" }, disabled ? t("distribution.the_link_re_enabled") : t("distribution.the_link_disabled_history_kept"))}>{disabled ? t("distribution.enable") : t("distribution.disable")}</button>
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
    if (action === "disable" && !window.confirm(t("distribution.revoke_external_access_link_measurement"))) return;
    if (action === "reset_password" && !window.confirm(t("distribution.reset_password_current_password_stop"))) return;
    setBusy(true);
    try {
      const res = await api.distributionExternalAccess(dealId, String(link.link_id), action);
      setCredentials(res.credentials || null);
      notify(action === "enable" ? t("distribution.external_access_enabled") : action === "disable" ? t("distribution.external_access_revoked") : t("distribution.the_password_reset"));
      await onChanged();
    } catch (err: any) { notify(String(err?.message || t("distribution.the_action_failed"))); }
    setBusy(false);
  };

  return (
    <div className="panel" data-testid="external-access-panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("distribution.external_access_link_dashboard")}</div>
        <span className={`status ${access.enabled ? "TargetReached" : "ClosedForJoining"}`} data-testid="external-access-status">{access.enabled ? t("distribution.on") : t("distribution.off")}</span>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        {t("distribution.you_let_outside_person_someone")}</p>
      {access.enabled ? (
        <div className="kv" style={{ margin: "10px 0" }}>
          <span className="k">{t("distribution.username")}</span><span className="v" dir="ltr" data-testid="external-access-username">{access.username}</span>
          <span className="k">{t("distribution.sign_address")}</span><span className="v" dir="ltr">{loginUrl}</span>
          <span className="k">{t("distribution.created")}</span><span className="v">{fmtDate(access.created_at)}</span>
          <span className="k">{t("distribution.last_sign")}</span><span className="v">{access.last_login_at ? fmtDate(access.last_login_at) : t("distribution.has_signed_yet")}</span>
        </div>
      ) : null}
      {credentials ? (
        <div className="panel" style={{ margin: "10px 0", borderColor: "var(--brand)" }} data-testid="external-access-credentials">
          <b>{t("distribution.the_credentials_shown_once_only")}</b>
          <div className="kv" style={{ marginTop: 8 }}>
            <span className="k">{t("distribution.address")}</span><span className="v" dir="ltr">{absoluteLoginUrl(String(credentials.login_path || loginPath))}</span>
            <span className="k">{t("distribution.username")}</span><span className="v" dir="ltr">{credentials.username}</span>
            <span className="k">{t("distribution.password")}</span><span className="v" dir="ltr" data-testid="external-access-password">{credentials.password}</span>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={async () => { const text = t("distribution.sign_link_dashboard_loginpath_username", { loginPath: absoluteLoginUrl(String(credentials.login_path || loginPath)), username: credentials.username, password: credentials.password }); if (await copyText(text)) notify(t("distribution.the_credentials_copied")); }}>{t("distribution.copy_credentials")}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCredentials(null)}>{t("distribution.hide")}</button>
          </div>
        </div>
      ) : null}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {access.enabled ? (
          <>
            <button type="button" className="btn btn-sm btn-ghost" data-testid="external-access-copy-url" onClick={async () => { if (await copyText(loginUrl)) notify(t("distribution.the_sign_address_copied")); }}>{t("distribution.copy_sign_address")}</button>
            <button type="button" className="btn btn-sm btn-ghost" data-testid="external-access-reset" disabled={busy} onClick={() => act("reset_password")}>{t("distribution.reset_password")}</button>
            <button type="button" className="btn btn-sm btn-danger-ghost" data-testid="external-access-disable" disabled={busy} onClick={() => act("disable")}>{t("distribution.revoke_access")}</button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" data-testid="external-access-enable" disabled={busy} onClick={() => act("enable")}>{t("distribution.enable_access_create_credentials")}</button>
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

  const back = <a className="back" href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>{t("distribution.to_deal")}</a>;
  if (error) return <>{back}<EmptyState title={t("distribution.the_link_dashboard_cannot_loaded")} body={error} /></>;
  if (!payload) return <>{back}<BrandLoader label={t("distribution.loading_link_dashboard")} minHeight={320} /></>;

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
            <div className="muted small">{t("distribution.channel_channel_created_created", { channel: channelLabel(link.channel), created_at: fmtDate(link.created_at) })}</div>
          </div>
          <span className={`status ${disabled ? "Cancelled" : "TargetReached"}`}>{disabled ? t("distribution.disabled") : t("distribution.active")}</span>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
          <span className="muted small" dir="ltr">{url}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { if (await copyText(url)) showToast(t("distribution.link_copied")); }}>{t("distribution.copy")}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => nativeOrCopy(url, String(payload.deal?.title || ""), showToast)}>{t("distribution.share")}</button>
        </div>
        <div className="section-title" style={{ margin: "6px 0 8px" }}>{t("distribution.total_since_link_created")}</div>
        <LinkMetricTiles metrics={link.metrics} />
        <div className="section-title" style={{ margin: "6px 0 8px" }}>{t("distribution.in_selected_range_label", { label: tKey(RANGES.find((r) => r.key === range)?.label) })}</div>
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
      setError(String(e?.message || t("distribution.the_data_cannot_loaded")));
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
      setLoginError(status === 429 ? t("distribution.too_many_attempts_try_again") : status === 403 ? t("distribution.access_dashboard_revoked") : status === 503 ? t("distribution.signing_available_right_now") : t("distribution.wrong_username_password"));
    }
    setBusy(false);
  };

  const logout = async () => {
    try { await api.linkViewerLogout(); } catch { /* cookie cleared server-side anyway */ }
    setSession(null); setDashboard(null);
  };

  if (session === undefined) return <BrandLoader label={t("distribution.checking_sign")} minHeight={240} />;

  if (!session) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: "24px auto" }} data-testid="link-viewer-login">
        <div className="panel-title">{t("distribution.sign_link_dashboard")}</div>
        <p className="muted small">{t("distribution.the_deal_s_owner_gave")}</p>
        <form onSubmit={login}>
          <div className="field">
            <label htmlFor="lv-user">{t("distribution.username")}</label>
            <input id="lv-user" data-testid="link-viewer-username" dir="ltr" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lv-pass">{t("distribution.password")}</label>
            <input id="lv-pass" data-testid="link-viewer-password" dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {loginError ? <p className="field-error" data-testid="link-viewer-login-error">{loginError}</p> : null}
          <button type="submit" className="btn btn-primary btn-block" data-testid="link-viewer-login-submit" disabled={busy || !username.trim() || !password}>{busy ? t("distribution.signing") : t("distribution.sign")}</button>
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
            <h2 style={{ margin: "2px 0 0" }} data-testid="link-viewer-link-name">{link.link_name || links[0]?.link_name || t("distribution.your_link")}</h2>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            {dashboard ? <span className={`status ${disabled ? "Cancelled" : "TargetReached"}`} data-testid="link-viewer-status">{disabled ? t("distribution.disabled") : t("distribution.active")}</span> : null}
            <button type="button" className="btn btn-sm btn-ghost" data-testid="link-viewer-logout" onClick={logout}>{t("distribution.sign_out")}</button>
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
            <div className="section-title" style={{ margin: "10px 0 8px" }}>{t("distribution.total_since_link_created")}</div>
            <LinkMetricTiles metrics={dashboard.totals} />
            <div className="section-title" style={{ margin: "6px 0 8px" }}>{t("distribution.in_selected_range_label", { label: tKey(RANGES.find((r) => r.key === range)?.label) })}</div>
            <LinkMetricTiles metrics={dashboard.window} compact />
            <DistributionDisclaimer text={dashboard.disclaimer_he} />
          </>
        ) : <BrandLoader label={t("distribution.loading_metrics")} minHeight={160} />}
      </div>
      {dashboard ? <LinkTimeChart series={dashboard.series} range={range} onRange={setRange} metric={metric} onMetric={setMetric} /> : null}
    </div>
  );
}
