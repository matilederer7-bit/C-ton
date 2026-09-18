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
      <StatTile num={num(m.entries)} label={t("pages.distribution.4173c16c")} />
      <StatTile num={num(m.unique_visitors)} label={t("pages.distribution.bc172b78")} />
      <StatTile num={num(m.joins)} label={t("pages.distribution.f8e3bd11")} sub={t("pages.distribution.89ebc796")} />
      <StatTile num={num(m.joined_units)} label={t("pages.distribution.a4bbf059")} />
      <StatTile num={num(m.charged_units)} label={t("pages.distribution.3ceb7529")} tone="good" />
      <StatTile num={ils(m.attributed_gross)} label={t("pages.distribution.c81a2f62")} tone="good" />
      <StatTile num={pct(m.conversion_entry_to_join)} label={t("pages.distribution.70407427")} />
      <StatTile num={pct(m.conversion_entry_to_final_charge)} label={t("pages.distribution.e7f306f1")} />
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
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("pages.distribution.c200b2ff")}</div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label={t("pages.distribution.26c7f2ad")}>
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={`chip${range === r.key ? " active" : ""}`} data-testid={`range-${r.key}`} onClick={() => onRange(r.key)}>{t(r.label)}</button>
          ))}
        </div>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "10px 0" }} role="group" aria-label={t("pages.distribution.e702a626")}>
        {METRICS.map((m) => (
          <button key={m.key} type="button" className={`chip${metric === m.key ? " active" : ""}`} data-testid={`metric-${m.key}`} onClick={() => onMetric(m.key)}>{t(m.label)}</button>
        ))}
      </div>
      <div className="chart-box">
        <div className="chart-title">{t("distribution.chart_title", { metric: t(def.label), bucket: series?.bucket === "hour" ? t("pages.distribution.0b04b3f7") : t("pages.distribution.7c368c6b"), total: def.money ? ils(total) : num(total) })}</div>
        {points.length ? (
          <BarChart points={points} color={def.key === "charged_units" || def.key === "attributed_gross" ? "var(--success)" : "var(--brand)"} height={90} formatValue={def.money ? (v) => ils(v) : undefined} />
        ) : <p className="muted small chart-empty">{t("pages.distribution.6c378795")}</p>}
      </div>
    </div>
  );
}

export function DistributionDisclaimer({ text }: { text?: string }) {
  return (
    <p className="muted small" data-testid="distribution-disclaimer" style={{ marginTop: 10 }}>
      {text || t("pages.distribution.75427438")}
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
  if (await copyText(url)) notify(t("pages.distribution.4aa70f6f"));
  else notify(t("pages.distribution.29807e19"));
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
    if (!internalName) { setFormError(t("pages.distribution.03e9b98f")); return; }
    setBusy(true); setFormError("");
    try {
      await api.createDistributionLink(dealId, { internal_name: internalName, channel: channel.trim() || undefined });
      setName(""); setChannel(""); setCreating(false);
      showToast(t("pages.distribution.9f152979"));
      await load();
    } catch (err: any) {
      const code = String(err?.body?.code || err?.body?.error || "");
      setFormError(
        code === "distribution_link_deal_not_open" ? t("pages.distribution.b3175714")
          : err?.status === 409 ? t("pages.distribution.8a2115e0")
            : String(err?.message || t("pages.distribution.72f18984"))
      );
    }
    setBusy(false);
  };

  const patch = async (link: Json, body: Json, okMsg: string) => {
    try {
      await api.updateDistributionLink(dealId, String(link.link_id), body);
      showToast(okMsg);
      await load();
    } catch (err: any) { showToast(err?.status === 409 ? t("pages.distribution.bd943572") : String(err?.message || t("pages.distribution.b2c36342"))); }
  };

  if (error) return <div className="panel"><div className="panel-title">{t("pages.distribution.88c12402")}</div><p className="muted small">{error}</p></div>;
  if (!payload) return <div className="panel"><div className="panel-title">{t("pages.distribution.88c12402")}</div><BrandLoader label={t("pages.distribution.65e20f68")} minHeight={120} /></div>;

  const totals = payload.totals || {};
  const hasLinks = links.length > 0;

  return (
    <div className="panel" data-testid="distribution-panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("pages.distribution.210e2a62")}</div>
        {hasLinks && dealOpen ? (
          <button type="button" className="btn btn-sm btn-primary" data-testid="distribution-create-open" onClick={() => setCreating((v) => !v)}>{t("pages.distribution.d37e8982")}</button>
        ) : null}
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        {t("pages.distribution.301d97a9", { v0: String(payload.attribution_rule?.description_he || t("pages.distribution.cc649e07")) })}
      </p>

      {!hasLinks && !creating ? (
        <EmptyState
          title={t("pages.distribution.21fafc7c")}
          body={dealOpen ? t("pages.distribution.6155cebc") : t("pages.distribution.03325a77")}
          action={dealOpen ? <button type="button" className="btn btn-primary" data-testid="distribution-create-first" onClick={() => setCreating(true)}>{t("pages.distribution.81ea77b1")}</button> : undefined}
        />
      ) : null}

      {creating ? (
        <form onSubmit={create} className="panel" style={{ marginTop: 12 }} data-testid="distribution-create-form">
          <div className="field-row">
            <div className="field">
              <label htmlFor="dist-link-name">{t("pages.distribution.851bcb48")} <span className="hint">{t("pages.distribution.d810728a")}</span></label>
              <input id="dist-link-name" data-testid="distribution-link-name" value={name} maxLength={80} placeholder={t("pages.distribution.632ed52e")} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dist-link-channel">{t("pages.distribution.25b5eb11")} <span className="hint">{t("pages.distribution.2127163b")}</span></label>
              <input id="dist-link-channel" data-testid="distribution-link-channel" list="dist-channel-options" value={channel} maxLength={40} placeholder="whatsapp, facebook, newsletter…" onChange={(e) => setChannel(e.target.value)} />
              <datalist id="dist-channel-options">{CHANNEL_SUGGESTIONS.map((c) => <option key={c} value={c}>{tKey(CHANNEL_LABELS[c], c)}</option>)}</datalist>
            </div>
          </div>
          {formError ? <p className="field-error">{formError}</p> : null}
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary" data-testid="distribution-create-submit" disabled={busy}>{busy ? t("pages.distribution.20a07b21") : t("pages.distribution.561aa793")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setCreating(false); setFormError(""); }}>{t("pages.distribution.a7c55a8d")}</button>
          </div>
        </form>
      ) : null}

      {hasLinks ? (
        <>
          <div className="stat-row" style={{ margin: "12px 0 8px" }} data-testid="distribution-totals">
            <StatTile num={num(totals.entries)} label={t("pages.distribution.08db92ad")} />
            <StatTile num={num(totals.joins)} label={t("pages.distribution.f8e3bd11")} />
            <StatTile num={num(totals.charged_units)} label={t("pages.distribution.3ceb7529")} tone="good" />
            <StatTile num={ils(totals.attributed_gross)} label={t("pages.distribution.da753a1a")} tone="good" />
          </div>
          <div className="table-wrap">
            <table className="data" data-testid="distribution-links-table">
              <thead>
                <tr>
                  <th>{t("pages.distribution.8b1aa6b1")}</th>
                  <th>{t("pages.distribution.6163da3a")}</th>
                  <th>{t("pages.distribution.c184d0ed")}</th>
                  <th className="num clickable" onClick={() => toggleSort("entries")}>{t("pages.distribution.79560ec3", { v0: sortMark("entries") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("joins")}>{t("pages.distribution.4bf935ea", { v0: sortMark("joins") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("joined_units")}>{t("pages.distribution.72f87bcf", { v0: sortMark("joined_units") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("charged_units")}>{t("pages.distribution.3459e9c9", { v0: sortMark("charged_units") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("attributed_gross")}>{t("pages.distribution.db68d3df", { v0: sortMark("attributed_gross") })}</th>
                  <th className="num clickable" onClick={() => toggleSort("conversion_entry_to_join")}>{t("pages.distribution.47f8993f", { v0: sortMark("conversion_entry_to_join") })}</th>
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
                          <form onSubmit={async (e) => { e.preventDefault(); const value = String(renaming?.value || "").trim(); setRenaming(null); if (value && value !== link.internal_name) await patch(link, { internal_name: value }, t("pages.distribution.cb4bbdfc")); }} className="row" style={{ gap: 6 }}>
                            <input autoFocus value={renaming.value} maxLength={80} onChange={(e) => setRenaming({ id: String(link.link_id), value: e.target.value })} data-testid="distribution-rename-input" />
                            <button type="submit" className="btn btn-sm btn-primary">{t("pages.distribution.e6932339")}</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>{t("pages.distribution.a7c55a8d")}</button>
                          </form>
                        ) : (
                          <>
                            <b>{link.internal_name}</b>
                            <div className="muted small" dir="ltr" style={{ textAlign: "end" }}>{url}</div>
                            {link.external_access?.enabled ? <span className="channel-chip">{t("pages.distribution.74e5ec85")}</span> : null}
                          </>
                        )}
                      </td>
                      <td>{channelLabel(link.channel)}</td>
                      <td><span className={`status ${disabled ? "Cancelled" : "TargetReached"}`}>{disabled ? t("pages.distribution.dc93098c") : t("pages.distribution.91181c78")}</span></td>
                      <td className="num">{num(m.entries)}</td>
                      <td className="num">{num(m.joins)}</td>
                      <td className="num">{num(m.joined_units)}</td>
                      <td className="num">{num(m.charged_units)}</td>
                      <td className="num">{ils(m.attributed_gross)}</td>
                      <td className="num">{pct(m.conversion_entry_to_join)}</td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-copy" onClick={async () => { if (await copyText(url)) showToast(t("pages.distribution.4aa70f6f")); else showToast(t("pages.distribution.f4e443b7")); }}>{t("pages.distribution.57210c1c")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-share" onClick={() => nativeOrCopy(url, dealTitle, showToast)}>{t("pages.distribution.6d33c292")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => shareViaWhatsApp(url, dealTitle)}>{t("pages.distribution.39b36186")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="distribution-rename" onClick={() => setRenaming({ id: String(link.link_id), value: String(link.internal_name) })}>{t("pages.distribution.022436d7")}</button>
                          <button type="button" className="btn btn-sm btn-primary" data-testid="distribution-open-dashboard" onClick={() => navigate(`#/seller/deal/${dealId}/distribution/${link.link_id}`)}>{t("pages.distribution.cf6d81fb")}</button>
                          <button type="button" className={`btn btn-sm ${disabled ? "btn-ghost" : "btn-danger-ghost"}`} data-testid="distribution-toggle" onClick={() => patch(link, { status: disabled ? "active" : "disabled" }, disabled ? t("pages.distribution.300e9a12") : t("pages.distribution.3a56089d"))}>{disabled ? t("pages.distribution.3fd88909") : t("pages.distribution.e98b6315")}</button>
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
    if (action === "disable" && !window.confirm(t("pages.distribution.07d824a8"))) return;
    if (action === "reset_password" && !window.confirm(t("pages.distribution.ea274530"))) return;
    setBusy(true);
    try {
      const res = await api.distributionExternalAccess(dealId, String(link.link_id), action);
      setCredentials(res.credentials || null);
      notify(action === "enable" ? t("pages.distribution.85a60d7f") : action === "disable" ? t("pages.distribution.95e3aa1d") : t("pages.distribution.1d71ab25"));
      await onChanged();
    } catch (err: any) { notify(String(err?.message || t("pages.distribution.d11a2bcd"))); }
    setBusy(false);
  };

  return (
    <div className="panel" data-testid="external-access-panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("pages.distribution.b3f6864b")}</div>
        <span className={`status ${access.enabled ? "TargetReached" : "ClosedForJoining"}`} data-testid="external-access-status">{access.enabled ? t("pages.distribution.bf556864") : t("pages.distribution.ccd3fbcc")}</span>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        {t("pages.distribution.ce36953c")}</p>
      {access.enabled ? (
        <div className="kv" style={{ margin: "10px 0" }}>
          <span className="k">{t("pages.distribution.65784d97")}</span><span className="v" dir="ltr" data-testid="external-access-username">{access.username}</span>
          <span className="k">{t("pages.distribution.1c26c5de")}</span><span className="v" dir="ltr">{loginUrl}</span>
          <span className="k">{t("pages.distribution.dd323867")}</span><span className="v">{fmtDate(access.created_at)}</span>
          <span className="k">{t("pages.distribution.15fdbec4")}</span><span className="v">{access.last_login_at ? fmtDate(access.last_login_at) : t("pages.distribution.daabfdd4")}</span>
        </div>
      ) : null}
      {credentials ? (
        <div className="panel" style={{ margin: "10px 0", borderColor: "var(--brand)" }} data-testid="external-access-credentials">
          <b>{t("pages.distribution.2f27b2c9")}</b>
          <div className="kv" style={{ marginTop: 8 }}>
            <span className="k">{t("pages.distribution.daab1ad0")}</span><span className="v" dir="ltr">{absoluteLoginUrl(String(credentials.login_path || loginPath))}</span>
            <span className="k">{t("pages.distribution.65784d97")}</span><span className="v" dir="ltr">{credentials.username}</span>
            <span className="k">{t("pages.distribution.0b490b5e")}</span><span className="v" dir="ltr" data-testid="external-access-password">{credentials.password}</span>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={async () => { const text = t("pages.distribution.06e302c5", { loginPath: absoluteLoginUrl(String(credentials.login_path || loginPath)), username: credentials.username, password: credentials.password }); if (await copyText(text)) notify(t("pages.distribution.85143d9f")); }}>{t("pages.distribution.d3720bdc")}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCredentials(null)}>{t("pages.distribution.cf56e937")}</button>
          </div>
        </div>
      ) : null}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {access.enabled ? (
          <>
            <button type="button" className="btn btn-sm btn-ghost" data-testid="external-access-copy-url" onClick={async () => { if (await copyText(loginUrl)) notify(t("pages.distribution.a55d4bc9")); }}>{t("pages.distribution.384abc1f")}</button>
            <button type="button" className="btn btn-sm btn-ghost" data-testid="external-access-reset" disabled={busy} onClick={() => act("reset_password")}>{t("pages.distribution.9e3cd21b")}</button>
            <button type="button" className="btn btn-sm btn-danger-ghost" data-testid="external-access-disable" disabled={busy} onClick={() => act("disable")}>{t("pages.distribution.74bf1116")}</button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" data-testid="external-access-enable" disabled={busy} onClick={() => act("enable")}>{t("pages.distribution.17e10da4")}</button>
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

  const back = <a className="back" href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>{t("pages.distribution.fbd4509a")}</a>;
  if (error) return <>{back}<EmptyState title={t("pages.distribution.13c05699")} body={error} /></>;
  if (!payload) return <>{back}<BrandLoader label={t("pages.distribution.0243ec76")} minHeight={320} /></>;

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
            <div className="muted small">{t("pages.distribution.8ce9a707", { channel: channelLabel(link.channel), created_at: fmtDate(link.created_at) })}</div>
          </div>
          <span className={`status ${disabled ? "Cancelled" : "TargetReached"}`}>{disabled ? t("pages.distribution.dc93098c") : t("pages.distribution.91181c78")}</span>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
          <span className="muted small" dir="ltr">{url}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { if (await copyText(url)) showToast(t("pages.distribution.4aa70f6f")); }}>{t("pages.distribution.57210c1c")}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => nativeOrCopy(url, String(payload.deal?.title || ""), showToast)}>{t("pages.distribution.6d33c292")}</button>
        </div>
        <div className="section-title" style={{ margin: "6px 0 8px" }}>{t("pages.distribution.3c743f5c")}</div>
        <LinkMetricTiles metrics={link.metrics} />
        <div className="section-title" style={{ margin: "6px 0 8px" }}>{t("pages.distribution.5149a792", { label: tKey(RANGES.find((r) => r.key === range)?.label) })}</div>
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
      setError(String(e?.message || t("pages.distribution.71f28ff8")));
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
      setLoginError(status === 429 ? t("pages.distribution.b0901dd7") : status === 403 ? t("pages.distribution.ce34cbc6") : status === 503 ? t("pages.distribution.d06c39e8") : t("pages.distribution.557289fc"));
    }
    setBusy(false);
  };

  const logout = async () => {
    try { await api.linkViewerLogout(); } catch { /* cookie cleared server-side anyway */ }
    setSession(null); setDashboard(null);
  };

  if (session === undefined) return <BrandLoader label={t("pages.distribution.aefda595")} minHeight={240} />;

  if (!session) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: "24px auto" }} data-testid="link-viewer-login">
        <div className="panel-title">{t("pages.distribution.aeb7ae4b")}</div>
        <p className="muted small">{t("pages.distribution.f9e75a47")}</p>
        <form onSubmit={login}>
          <div className="field">
            <label htmlFor="lv-user">{t("pages.distribution.65784d97")}</label>
            <input id="lv-user" data-testid="link-viewer-username" dir="ltr" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lv-pass">{t("pages.distribution.0b490b5e")}</label>
            <input id="lv-pass" data-testid="link-viewer-password" dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {loginError ? <p className="field-error" data-testid="link-viewer-login-error">{loginError}</p> : null}
          <button type="submit" className="btn btn-primary btn-block" data-testid="link-viewer-login-submit" disabled={busy || !username.trim() || !password}>{busy ? t("pages.distribution.bcefb976") : t("pages.distribution.2f6783cd")}</button>
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
            <h2 style={{ margin: "2px 0 0" }} data-testid="link-viewer-link-name">{link.link_name || links[0]?.link_name || t("pages.distribution.05f9c194")}</h2>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            {dashboard ? <span className={`status ${disabled ? "Cancelled" : "TargetReached"}`} data-testid="link-viewer-status">{disabled ? t("pages.distribution.dc93098c") : t("pages.distribution.91181c78")}</span> : null}
            <button type="button" className="btn btn-sm btn-ghost" data-testid="link-viewer-logout" onClick={logout}>{t("pages.distribution.b939061e")}</button>
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
            <div className="section-title" style={{ margin: "10px 0 8px" }}>{t("pages.distribution.3c743f5c")}</div>
            <LinkMetricTiles metrics={dashboard.totals} />
            <div className="section-title" style={{ margin: "6px 0 8px" }}>{t("pages.distribution.5149a792", { label: tKey(RANGES.find((r) => r.key === range)?.label) })}</div>
            <LinkMetricTiles metrics={dashboard.window} compact />
            <DistributionDisclaimer text={dashboard.disclaimer_he} />
          </>
        ) : <BrandLoader label={t("pages.distribution.9de74bc0")} minHeight={160} />}
      </div>
      {dashboard ? <LinkTimeChart series={dashboard.series} range={range} onRange={setRange} metric={metric} onMetric={setMetric} /> : null}
    </div>
  );
}
