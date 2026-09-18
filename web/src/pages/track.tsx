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
import { t } from "../i18n/index.js";

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
      toTarget > 0 ? t("track.totarget_more_units_needed_deal", { toTarget: num(toTarget) }) : t("track.the_target_reached_joining_stays"),
      deadline ? t("track.deadline_deadline", { deadline: deadline }) : "",
      t("track.target_reached_then_charge_made")
    ].filter(Boolean);
  }
  if (["ClosedForJoining", "ReadyForCharging", "Charging"].includes(state)) {
    return [t("track.joining_closed_deal_closing_charging"), t("track.this_screen_updates_itself_there")];
  }
  if (state === "CompletionWindow") return [t("track.completion_window_some_charges_did")];
  if (state === "Completed") return [t("track.the_deal_completed"), tr.delivery_method_label ? t("track.how_receive_delivery_method_label", { delivery_method_label: tr.delivery_method_label }) : t("track.the_seller_arranging_how_receive")];
  if (state === "Failed") return [t("track.the_deal_did_go_ahead")];
  if (state === "Cancelled") return [t("track.the_deal_cancelled_charge_made")];
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
          if (status === 401 || status === 403) setError({ kind: "link", message: t("track.the_link_valid_copied_full") });
          else if (status === 404) setError({ kind: "gone", message: t("track.we_could_find_join_check") });
          else if (!status) setError({ kind: "network", message: t("track.we_could_load_tracking_screen") });
          else if (status === 429 || status >= 500) setError({ kind: "busy", message: t("track.the_server_did_answer_time") });
          else setError({ kind: "other", message: String(e?.message || t("track.something_went_wrong_try_again")) });
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
            {error.kind === "network" || error.kind === "busy" ? <button className="btn btn-primary" data-testid="track-retry" onClick={() => window.location.reload()}>{t("track.try_again")}</button> : null}
            <a className="btn btn-ghost" href="#/support" data-testid="track-support">{t("track.support")}</a>
          </div>
        } />
    );
  }
  if (!payload?.tracking) return <BrandLoader label={t("track.loading_tracking_screen")} minHeight={420} />;

  const tr = payload.tracking;
  const toneClass = tr.tone === "success" ? "ok" : tr.tone === "danger" ? "err" : "info";
  const inCompletionWindow = tr.buyer_state === "ChargeFailedCompletion";
  const steps = nextSteps(tr);
  const dealHash = `#/deal/${tr.deal_id}`;
  const askHash = `#/deal/${tr.deal_id}?inquiry=1`;
  const deadlineText = formatIsraelDateTime(tr.deadline);
  const copyHere = async () => {
    if (await copyText(window.location.href)) showToast(t("track.the_tracking_link_copied"));
    else showToast(t("track.copying_failed_select_link_copy"));
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
                <b>{t("track.a_payment_method_update_needed")}</b>  {t("track.the_charge_did_go_through")}<div style={{ marginTop: 6 }}>
                  {t("track.left_completion_window")} <Countdown until={tr.completion_window_until} overText={t("track.the_completion_window_ended")} />
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
              {t("track.you_v0_other_participants_deal", { v0: num(Math.max(0, Number(tr.progress?.participants_count || 1) - 1)) })}</p>
            <div className="kv">
              <span className="k">{t("track.end_joining")}</span>
              <span className="v"><Countdown until={tr.deadline} overText={t("track.passed")} />{deadlineText ? <div className="muted small" style={{ fontWeight: 400 }}>{deadlineText}</div> : null}</span>
            </div>
            {steps.length ? (
              <div className="track-next" data-testid="track-next">
                <div className="track-next-title">{t("track.what_else_needs_happen")}</div>
                <ul>{steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-title">{t("track.my_join_details")}</div>
            <div className="kv">
              <span className="k">{t("track.number_units")}</span><span className="v">{num(tr.qty)}</span>
              <span className="k">{t("track.price_per_unit")}</span><span className="v">{ils(tr.price_per_unit)}</span>
              {tr.delivery_method_label ? (<><span className="k">{t("track.how_receive")}</span><span className="v">{tr.delivery_method_label}</span></>) : null}
              {Number(tr.delivery_cost) > 0 ? (<><span className="k">{t("track.delivery")}</span><span className="v">{ils(tr.delivery_cost)}</span></>) : null}
              <span className="k">{t("track.amount_held_authorization")}</span><span className="v">{ils(tr.estimated_total)}</span>
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
              <button type="button" className="btn btn-ghost btn-sm" data-testid="track-copy-link" onClick={copyHere}>{t("track.copy_tracking_link")}</button>
              <a className="btn btn-ghost btn-sm" data-testid="track-deal-link" href={dealHash}>{t("track.to_deal_page")}</a>
            </div>
            <div className="track-ask" style={{ marginTop: 12 }}>
              <a className="btn btn-primary btn-sm" data-testid="track-ask-seller" href={askHash}>{t("track.a_question_seller")}</a>
              <p className="muted small" style={{ margin: "6px 0 0" }}>{t("track.inquiry_privacy_line_reply_appears", { iNQUIRY_PRIVACY_LINE: t(INQUIRY_PRIVACY_LINE_KEY, { product: t("buyer_copy.product_name") }) })}</p>
            </div>
          </div>

          {tr.fulfillment?.units?.length ? (
            <div className="panel">
              <div className="panel-title">{t("track.my_redemptions")}</div>
              <div className="stack">
                {tr.fulfillment.units.map((u: Json) => (
                  <div key={u.fulfillment_unit_id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                    <span>{t("track.unit_unit_index", { unit_index: u.unit_index })}</span>
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
                  <div className="impact-stat"><div className="num">{num(impact.direct_children)}</div><div className="lbl">{t("track.joiners_brought")}</div></div>
                  <div className="impact-stat"><div className="num">{num(impact.units_joined_via_branch)}</div><div className="lbl">{t("track.units_through_chain")}</div></div>
                  <div className="impact-stat"><div className="num">{num(impact.branch_depth)}</div><div className="lbl">{t("track.generations_branch")}</div></div>
                </div>
                {Number(impact.descendants) > 0 ? (
                  <p className="muted small" style={{ marginTop: 10, textAlign: "center" }}>
                    {t("track.descendants_people_joined_branch_total", { descendants: num(impact.descendants) })}</p>
                ) : (
                  <p className="muted small" style={{ marginTop: 10, textAlign: "center" }}>
                    {t("track.share_personal_link_everyone_who")}</p>
                )}
              </>
            ) : <p className="muted small">{t("track.loading")}</p>}
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
              <div className="panel-title">{t("track.what_happened_deal")}</div>
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
            <div className="panel-title">{t("track.personal_status")}</div>
            {/* The server emits { title, detail, cta, action_required } (buildTrackingPersonalStatus);
                the older headline/body keys are kept as a fallback only. */}
            <p style={{ marginBottom: 4 }}><b>{tr.personal_status?.title || tr.personal_status?.headline || tr.headline}</b></p>
            {tr.personal_status?.detail || tr.personal_status?.body ? <p className="muted small">{tr.personal_status.detail || tr.personal_status.body}</p> : null}
            {tr.personal_status?.cta?.href && tr.personal_status?.cta?.label ? (
              <p style={{ marginBottom: 8 }}>
                <a className="btn btn-primary btn-sm" data-testid="track-personal-cta" href={String(tr.personal_status.cta.href)}>{String(tr.personal_status.cta.label)}</a>
              </p>
            ) : null}
            <p className="muted small" style={{ marginBottom: 0 }}>{t("track.updated_generated", { generated_at: fmtDate(tr.live?.generated_at) })}</p>
          </div>
        </div>
      </div>
      <Toast msg={toast} />
    </>
  );
}
