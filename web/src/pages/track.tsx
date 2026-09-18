import { BuyerEntitlement } from "../receiptContent";
import React, { useEffect, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, Countdown, EmptyState, GroupMeter, ShareActions, StatusPill, Toast, copyText, useToast } from "../components";
import { fmtDate, formatIsraelDateTime, ils, initialOf, num, timeAgo } from "../util";
import { NOTIFICATIONS_OFF_LINE_KEY, INQUIRY_PRIVACY_LINE_KEY, PILOT_MOCK_MONEY_LINE_KEY, notificationsLine } from "../buyerCopy";
// Fixed tracking copy (the hold explanation, the return/ask headline and the
// empty-state titles) is CMS content — the `deal_page` template. The
// status headline, subline and next steps stay server-derived: they are
// projections of canonical state and must never be editable.
import { resolveDealCopy, resolveTrackCopy } from "../productCopy";
import { useSiteContent } from "../siteContent";
import { FeedbackPrompt } from "../feedback";
import { PickupCard } from "../pickupCard";
import { t } from "../i18n";

// מסך המעקב של הקונה — מקור האמת היחיד מרגע ההצטרפות ועד ההכרעה.
// LAUNCH POLISH 2 (P4/P5/P6/P7/P8): the page answers, in order — what is my
// status, what still has to happen and until when, how I get back here (and
// the honest "no e-mail/SMS in the pilot" line), how I ask the seller, how I
// help the deal succeed, one feedback question. Every sentence derives from
// the server payload; nothing here promises a notification that does not exist.

const OPEN_STATES = ["PendingTarget", "TargetReached"];

function nextSteps(tr: Json): string[] {
  const state = String(tr.deal_state || "");
  const current = Number(tr.progress?.current_units || 0);
  const threshold = Number(tr.threshold_units || tr.progress?.target_units || 1);
  const toTarget = Math.max(0, threshold - current);
  const deadline = formatIsraelDateTime(tr.deadline);
  if (OPEN_STATES.includes(state)) {
    return [
      toTarget > 0 ? t("pages.track.500dde1f", { toTarget: num(toTarget) }) : t("pages.track.fac55fb6"),
      deadline ? t("pages.track.5c358b26", { deadline: deadline }) : "",
      t("pages.track.822a6dda")
    ].filter(Boolean);
  }
  if (["ClosedForJoining", "ReadyForCharging", "Charging"].includes(state)) {
    return [t("pages.track.337c7446"), t("pages.track.a7add917")];
  }
  if (state === "CompletionWindow") return [t("pages.track.ffa27dd3")];
  if (state === "Completed") return [t("pages.track.191d5c6d"), tr.delivery_method_label ? t("pages.track.f5b2f4e3", { delivery_method_label: tr.delivery_method_label }) : t("pages.track.7ee9fb46")];
  if (state === "Failed") return [t("pages.track.af3962b7")];
  if (state === "Cancelled") return [t("pages.track.a02a2ef4")];
  return [];
}

export function TrackPage({ participantId, token }: { participantId: string; token: string }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [impact, setImpact] = useState<Json | null>(null);
  const [error, setError] = useState<{ kind: "link" | "gone" | "network" | "busy" | "other"; message: string } | null>(null);
  const [toast, showToast] = useToast();
  const [notifLine, setNotifLine] = useState(t(NOTIFICATIONS_OFF_LINE_KEY));
  const content = useSiteContent();
  const trackCopy = resolveTrackCopy(content);
  const shareTitle = resolveDealCopy(content).shareTitle;

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.tracking(participantId, token)
        .then((r) => { if (alive) { setPayload(r); setError(null); } })
        .catch((e) => {
          if (!alive || payload) return;
          const status = Number(e?.status || 0);
          if (status === 401 || status === 403) setError({ kind: "link", message: t("pages.track.4cfa76ca") });
          else if (status === 404) setError({ kind: "gone", message: t("pages.track.16d152a4") });
          else if (!status) setError({ kind: "network", message: t("pages.track.d9949a0a") });
          else if (status === 429 || status >= 500) setError({ kind: "busy", message: t("pages.track.14e9efe6") });
          else setError({ kind: "other", message: String(e?.message || t("pages.track.c882f368")) });
        });
    load();
    const id = setInterval(load, 6_000);
    return () => { alive = false; clearInterval(id); };
  }, [participantId, token]);

  useEffect(() => {
    api.impact(participantId, token).then((r) => setImpact(r.impact)).catch(() => undefined);
    notificationsLine().then(setNotifLine).catch(() => undefined);
  }, [participantId, token]);

  if (error) {
    return (
      <EmptyState
        level={1}
        title={error.kind === "network" ? trackCopy.networkTitle : error.kind === "busy" ? trackCopy.busyTitle : trackCopy.noAccessTitle} body={error.message}
        action={
          <div className="row" style={{ justifyContent: "center" }}>
            {error.kind === "network" || error.kind === "busy" ? <button className="btn btn-primary" data-testid="track-retry" onClick={() => window.location.reload()}>{t("pages.track.8c634e7d")}</button> : null}
            <a className="btn btn-ghost" href="#/support" data-testid="track-support">{t("pages.track.3bc1abed")}</a>
          </div>
        } />
    );
  }
  if (!payload?.tracking) return <BrandLoader label={t("pages.track.73041d19")} minHeight={420} />;

  const tr = payload.tracking;
  const toneClass = tr.tone === "success" ? "ok" : tr.tone === "danger" ? "err" : "info";
  const inCompletionWindow = tr.buyer_state === "ChargeFailedCompletion";
  const steps = nextSteps(tr);
  const dealHash = `#/deal/${tr.deal_id}`;
  const askHash = `#/deal/${tr.deal_id}?inquiry=1`;
  const deadlineText = formatIsraelDateTime(tr.deadline);
  const copyHere = async () => {
    if (await copyText(window.location.href)) showToast(t("pages.track.1c955db8"));
    else showToast(t("pages.track.29807e19"));
  };

  return (
    <>
      <div className="track-hero">
        <StatusPill state={tr.deal_state} />
        <h1 style={{ marginTop: 10 }}>{tr.deal_title}</h1>
        <p className="muted">{tr.deal_status?.text || ""}</p>
      </div>

      <div className="deal-layout">
        <div className="stack">
          <div className="panel" data-testid="track-status">
            <div className={`notice ${toneClass}`} style={{ marginTop: 0 }}>
              <b>{tr.headline}</b>
              {tr.subline ? <div className="small" style={{ marginTop: 4 }}>{tr.subline}</div> : null}
            </div>
            {inCompletionWindow && tr.completion_window_until ? (
              <div className="notice err">
                <b>{t("pages.track.1daab001")}</b>  {t("pages.track.05c76970")}<div style={{ marginTop: 6 }}>
                  {t("pages.track.c593ec0e")} <Countdown until={tr.completion_window_until} overText={t("pages.track.1ce2874a")} />
                </div>
              </div>
            ) : null}
            <div style={{ margin: "14px 0 6px" }}>
              <GroupMeter
                large
                joined={Number(tr.progress?.current_units || 0)}
                threshold={Number(tr.threshold_units || 1)}
                max={Number(tr.max_units || 1)}
                showFlag
              />
            </div>
            <p className="muted small" style={{ textAlign: "center" }}>
              {t("pages.track.4754aa09", { v0: num(Math.max(0, Number(tr.progress?.participants_count || 1) - 1)) })}</p>
            <div className="kv">
              <span className="k">{t("pages.track.93d280ac")}</span>
              <span className="v"><Countdown until={tr.deadline} overText={t("pages.track.8fe6a546")} />{deadlineText ? <div className="muted small" style={{ fontWeight: 400 }}>{deadlineText}</div> : null}</span>
            </div>
            {steps.length ? (
              <div className="track-next" data-testid="track-next">
                <div className="track-next-title">{t("pages.track.091df284")}</div>
                <ul>{steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-title">{t("pages.track.da839092")}</div>
            <div className="kv">
              <span className="k">{t("pages.track.24b6980b")}</span><span className="v">{num(tr.qty)}</span>
              <span className="k">{t("pages.track.86b1b870")}</span><span className="v">{ils(tr.price_per_unit)}</span>
              {tr.delivery_method_label ? (<><span className="k">{t("pages.track.bd008360")}</span><span className="v">{tr.delivery_method_label}</span></>) : null}
              {Number(tr.delivery_cost) > 0 ? (<><span className="k">{t("pages.track.ee0500fa")}</span><span className="v">{ils(tr.delivery_cost)}</span></>) : null}
              <span className="k">{t("pages.track.8fa44e13")}</span><span className="v">{ils(tr.estimated_total)}</span>
            </div>
            <div className="order-note" style={{ marginTop: 12 }}>
              {trackCopy.holdNote}
              <div className="muted small" style={{ marginTop: 4 }}>{t(PILOT_MOCK_MONEY_LINE_KEY)}</div>
            </div>
          </div>

          {/* LAUNCH SPRINT 3 — physical pickup credential: only when the server
              says the order is canonically eligible; "handed over" afterwards */}
          <BuyerEntitlement participantId={participantId} token={token} pickup={tr.pickup} />

          {/* LAUNCH POLISH 2 (P4/P7) — how I get back here + how I ask the seller */}
          <div className="panel" data-testid="track-return">
            <div className="panel-title">{trackCopy.returnTitle}</div>
            <p className="small" style={{ marginTop: 0 }} data-testid="track-notif-line">{notifLine}</p>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" data-testid="track-copy-link" onClick={copyHere}>{t("pages.track.e96fdefa")}</button>
              <a className="btn btn-ghost btn-sm" data-testid="track-deal-link" href={dealHash}>{t("pages.track.64f23a35")}</a>
            </div>
            <div className="track-ask" style={{ marginTop: 12 }}>
              <a className="btn btn-primary btn-sm" data-testid="track-ask-seller" href={askHash}>{t("pages.track.5783968f")}</a>
              <p className="muted small" style={{ margin: "6px 0 0" }}>{t("pages.track.c28d5f8a", { iNQUIRY_PRIVACY_LINE: t(INQUIRY_PRIVACY_LINE_KEY, { product: t("buyer_copy.product_name") }) })}</p>
            </div>
          </div>

          {tr.fulfillment?.units?.length ? (
            <div className="panel">
              <div className="panel-title">{t("pages.track.acae58c0")}</div>
              <div className="stack">
                {tr.fulfillment.units.map((u: Json) => (
                  <div key={u.fulfillment_unit_id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                    <span>{t("pages.track.ca24599d", { unit_index: u.unit_index })}</span>
                    <span className="muted">•••{u.code_display_last4 || "—"}</span>
                    <span className="status Completed">{u.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="stack">
          {/* LAUNCH POLISH 2 (P5) — the share loop: the deal depends on aggregation */}
          <div className="panel" data-testid="track-share">
            <div className="panel-title">{shareTitle}</div>
            {impact ? (
              <>
                <div className="impact-stats">
                  <div className="impact-stat"><div className="num">{num(impact.direct_children)}</div><div className="lbl">{t("pages.track.b7a11090")}</div></div>
                  <div className="impact-stat"><div className="num">{num(impact.units_joined_via_branch)}</div><div className="lbl">{t("pages.track.48e7d0fd")}</div></div>
                  <div className="impact-stat"><div className="num">{num(impact.branch_depth)}</div><div className="lbl">{t("pages.track.aee58469")}</div></div>
                </div>
                {Number(impact.descendants) > 0 ? (
                  <p className="muted small" style={{ marginTop: 10, textAlign: "center" }}>
                    {t("pages.track.d1dad7d2", { descendants: num(impact.descendants) })}</p>
                ) : (
                  <p className="muted small" style={{ marginTop: 10, textAlign: "center" }}>
                    {t("pages.track.c7f2680d")}</p>
                )}
              </>
            ) : <p className="muted small">{t("pages.track.8447dd09")}</p>}
            <div style={{ marginTop: 12 }}>
              <ShareActions
                layout="loop"
                dealId={tr.deal_id}
                title={tr.deal_title}
                price={Number(tr.price_per_unit)}
                code={impact?.personal_share_code || null}
                onNotify={showToast}
              />
            </div>
          </div>

          {/* LAUNCH POLISH 2 (P6) — one question, once per deal, never forced */}
          <div className="panel" data-testid="track-feedback">
            <FeedbackPrompt dealId={String(tr.deal_id)} surface="tracking" />
          </div>

          {Array.isArray(tr.activity_feed) && tr.activity_feed.length ? (
            <div className="panel">
              <div className="panel-title">{t("pages.track.6ed18605")}</div>
              <div className="ticker">
                {tr.activity_feed.slice(0, 10).map((a: Json, i: number) => (
                  <div className="ticker-item" key={i}>
                    <span className="ticker-avatar">{initialOf(String(a.label || a.text || "•"))}</span>
                    <span>{a.text || a.label}</span>
                    <span className="ticker-time">{a.at ? timeAgo(a.at) : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="panel">
            <div className="panel-title">{t("pages.track.f8d8625a")}</div>
            {/* The server emits { title, detail, cta, action_required } (buildTrackingPersonalStatus);
                the older headline/body keys are kept as a fallback only. */}
            <p style={{ marginBottom: 4 }}><b>{tr.personal_status?.title || tr.personal_status?.headline || tr.headline}</b></p>
            {tr.personal_status?.detail || tr.personal_status?.body ? <p className="muted small">{tr.personal_status.detail || tr.personal_status.body}</p> : null}
            {tr.personal_status?.cta?.href && tr.personal_status?.cta?.label ? (
              <p style={{ marginBottom: 8 }}>
                <a className="btn btn-primary btn-sm" data-testid="track-personal-cta" href={String(tr.personal_status.cta.href)}>{String(tr.personal_status.cta.label)}</a>
              </p>
            ) : null}
            <p className="muted small" style={{ marginBottom: 0 }}>{t("pages.track.59fb2a9a", { generated_at: fmtDate(tr.live?.generated_at) })}</p>
          </div>
        </div>
      </div>
      <Toast msg={toast} />
    </>
  );
}
