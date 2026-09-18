import { ReceiptFields, ReceiptEditor, PublicProfileEditor, SellerReceipts, receiptMethodsOf, type ReceiptConfig } from "../receiptContent";
import { productRequest } from "../api";
// Seller-area system messages, empty states and guidance are CMS content —
// the `seller_area` template — resolved with the canonical Hebrew as fallback.
import { resolveSellerCopy } from "../productCopy";
import { useSiteContent } from "../siteContent";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, clearAuthSession, getSellerToken, Json } from "../api";
import { clearOwnerSession, readSellerBindingHint } from "../ownerMode";
import { readSession } from "../session";
import { AuthPanel } from "../auth";
import {
  BrandLoader, Countdown, EmptyState, GroupMeter, Modal, StatusPill, StatTile, Toast, copyText, useToast
} from "../components";
import { t, tKey } from "../i18n/index.js";
import { Tx } from "../i18n/Tx.js";
import { LiveCountdown } from "../livecountdown";
import {
  GEO_OUTCOME_COPY, GEO_OUTCOME_TEST_ID, browserGeoDeps, geoDiagnosticLine, parseManualCoordinates, recordGeoTrace,
  requestPickupLocation, type GeoOutcome
} from "../geo";
import {
  CLOSED_STATES, OPEN_STATES, URGENT_SELLER_STATES, countdownView, dealTypeLabel,
  failReason, fmtDate, formatIsraelDateTime, ils, israelPartsToUtcIso, moneyStateLabel, num, utcIsoToIsraelParts
} from "../util";
import { absoluteShareUrl } from "../viral";
import { CODE_MESSAGE_KEYS } from "../he";
import { DEADLINE_TECHNICAL_MAX_MS, classifyDeadlineMs } from "../deadlinePolicy";
// ROUND 2 (UX-2) — the ONE required-field attention rule (pulsing border on the
// exact control, aria-invalid, scroll/focus anchor, clears when it becomes valid)
import { QUANTITY_INPUT_ATTRS, isPositiveIntegerText } from "../quantityInput";
import { attention, attentionBlock, focusField, sameErrors, settleErrors } from "../fieldAttention";
import { DraftImageManager, LocalImageManager, uploadDealImage, type LocalImage, type ServerImage } from "../images";
import { ActionCenterPanel, ActivityPanel, ChartsPanel, FunnelPanel, KpiStrip, MoneyPanel, ViralPanel } from "./sellerCommand";
import { PropagationTree } from "../propagation";
// SELLER DISTRIBUTION HUB — per-deal distribution links + per-link dashboard
import { DistributionPanel, SellerLinkDashboardPage } from "./distribution";
// P0.7 polish — the buyer preview IS the public deal renderer (preview mode)
import { DealPage } from "./deal";
import { InquiriesPanel, SellerInquiriesPage, SellerInquiryThreadPage } from "./sellerInquiries";
// LAUNCH SPRINT 3 — physical pickup handoff (scanner + per-deal fulfillment list)
import { SellerFulfillmentPage, SellerPickupPage } from "./sellerPickup";
// Product catalog (072) — seller Product Library + create-a-Deal-from-a-Product
import { SellerProductCreatePage, SellerProductLibraryPage, SellerProductPage } from "./sellerProducts";
import { deliveryEstimateText, validateEstimateRange } from "../productLibrary";
// P0.7 — ONE pickup-location rule shared with the server (publish gate, public renderer)
import { PICKUP_PRECISION_COPY, hasUsablePickupLocation, isPickupOptionType, pickupLocationText, pickupPrecision } from "../../../src/pickup_location";

// ── login (the shared truthful auth panel) ─────────────────────────────────
function SellerLogin({ onDone, initialMode }: { onDone: () => void; initialMode?: "login" | "signup" }) {
  return (
    <AuthPanel
      surface="seller"
      title={t("seller.sellers_area")}
      subtitle={t("seller.one_account_all_c_ton")}
      initialMode={initialMode}
      signupLabel={t("seller.open_seller_account")}
      onDone={onDone}
    />
  );
}

// ── LAUNCH POLISH (P1) — why a logged-in identity has no seller account ────
// The server binds a verified login to a PENDING seller account automatically.
// When it refuses (never silently), the reason is explained here instead of
// bouncing the user back to the login form with no clue.
const BINDING_HINT_COPY: Record<string, string> = {
  email_in_use: "seller.binding_hint_copy.email_in_use",
  seller_id_in_use: "seller.binding_hint_copy.seller_id_in_use",
  throttled: "seller.binding_hint_copy.throttled",
  disabled: "seller.binding_hint_copy.disabled",
  email_required: "seller.binding_hint_copy.email_required",
  anonymous_identity: "seller.binding_hint_copy.anonymous_identity"
};
function SellerBindingNotice({ navigate }: { navigate: (h: string) => void }) {
  const hint = readSellerBindingHint();
  const copyKey = BINDING_HINT_COPY[hint];
  if (!copyKey || !readSession()?.access_token) return null;
  return (
    <div style={{ maxWidth: 420, margin: "24px auto -24px" }}>
      <div className="notice err" data-testid="seller-binding-notice" data-binding={hint}>
        <b>{t("seller.the_sign_succeeded_but_account")}</b>
        <div className="small" style={{ marginTop: 4 }}>{t(copyKey)}</div>
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => navigate("#/support")}>{t("seller.support_contact")}</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { clearAuthSession(); clearOwnerSession(); window.location.reload(); }}>{t("seller.sign_out")}</button>
        </div>
      </div>
    </div>
  );
}

// ── LAUNCH POLISH (P3) — "מה קורה מכאן?" the seller journey in one strip ────
// UX CLOSEOUT (Issue #39, item 4): the journey is FOUR steps, not five. The
// standalone "תצוגה מקדימה" stage was removed — previewing a draft is a tool
// the seller may reach for from the deal screen at any time, never a mandatory
// stage they must pass through, and presenting it as one made the path look
// longer and more bureaucratic than it is. The preview ACTION itself is
// untouched (see `draft-preview-open` below); only the journey stage is gone.
//
// What remains: what THEY do (create → publish → share), what SITON does
// (counts joins, holds frames only, charges only on success), when it
// succeeds, what happens if the target is missed. The lit step follows the
// real deal state; nothing here claims a real payment — the demo disclosure
// stays on the strip.
type JourneyStage = 0 | 1 | 2 | 3;
// Title/body are TRANSLATION KEYS (module-level constant).
const JOURNEY_STEPS: { t: string; b: string }[] = [
  { t: "seller.journey_steps.t", b: "seller.journey_steps.b" },
  { t: "seller.journey_steps.t_2", b: "seller.journey_steps.b_2" },
  { t: "seller.journey_steps.t_3", b: "seller.journey_steps.b_3" },
  { t: "seller.journey_steps.t_4", b: "seller.journey_steps.b_4" }
];
const JOURNEY_TERMINAL_STEP = JOURNEY_STEPS.length - 1;
function journeyStageOf(deal: Json | null): JourneyStage {
  if (!deal) return 0;
  const state = String(deal.state || "");
  // A draft that already carries images is one action away from publishing, so
  // "פרסום" is the live step; an empty draft is still being created.
  if (state === "Draft") return (deal.images || []).length ? 1 : 0;
  if (["PendingTarget", "TargetReached", "ClosedForJoining"].includes(state)) return 2;
  return 3;
}
function SellerJourney({ deal, title }: { deal: Json | null; title: string }) {
  const stage = journeyStageOf(deal);
  const state = String(deal?.state || "");
  const terminal = ["Completed", "Failed", "Cancelled"].includes(state);
  const outcome = state === "Completed" ? t("seller.completed_successfully_ready_fulfil")
    : state === "Failed" ? t("seller.target_reached_authorizations_released_nobody")
    : state === "Cancelled" ? t("seller.cancelled_nobody_charged")
    : "";
  return (
    <section className="journey" data-testid="seller-journey" data-stage={stage} aria-label={title}>
      <div className="journey-head">
        <h3>{title}</h3>
        <span className="small">{t("seller.demonstration_environment_real_charges")}</span>
      </div>
      <ol className="journey-steps">
        {JOURNEY_STEPS.map((s, i) => {
          const done = i < stage || (terminal && i === JOURNEY_TERMINAL_STEP);
          const cls = done ? "done" : i === stage ? "now" : "";
          return (
            <li key={s.t} className={`journey-step ${cls}`} data-testid={`journey-step-${i + 1}`} aria-current={i === stage ? "step" : undefined}>
              <span className="j-n" aria-hidden="true">{done ? "✓" : i + 1}</span>
              <div className="j-t">{t(s.t)}</div>
              <div className="j-b">{i === JOURNEY_TERMINAL_STEP && outcome ? outcome : t(s.b)}</div>
            </li>
          );
        })}
      </ol>
      <div className="journey-foot">
        <span><b>{t("seller.what_siton_does")}</b>  {t("seller.it_counts_joins_holds_card")}</span>
      </div>
    </section>
  );
}

// ── controlled Hebrew validation helpers (P0.2-D) ──────────────────────────
// ROUND 2 (UX-2): `focusField` now lives in ../fieldAttention next to the rest
// of the rule, so the marker, the aria state and the scroll anchor cannot drift
// apart. Behaviour is unchanged (smooth scroll to centre + focus).

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span className="field-error">{msg}</span>;
}

// ── dashboard card — ONE obvious primary intent per state (P0.2-J) ─────────
function SellerDealCard({ deal, navigate, showToast }: { deal: Json; navigate: (h: string) => void; showToast: (m: string) => void }) {
  const state = String(deal.state);
  const urgent = URGENT_SELLER_STATES.includes(state);
  const money = deal.money || {};
  const closed = CLOSED_STATES.includes(state);
  const isOpen = OPEN_STATES.includes(state);
  const potential = Number(money.potential_gross || 0);
  const charged = Number(money.charged_gross || 0);
  const showMoney = closed && state !== "Cancelled" ? charged || potential : potential;
  const pending = Number(money.recovery_pending_units || 0);
  const inWindow = state === "CompletionWindow";
  const countdownUntil = inWindow ? deal.completion_window_until : isOpen || state === "ClosedForJoining" ? deal.deadline : null;
  const img = deal.images?.[0]?.url || null;
  const cd = countdownView(countdownUntil);
  const open = () => navigate(`#/seller/deal/${deal.deal_id}`);

  const primaryLabel = state === "Draft" ? t("seller.continue_editing") : closed ? t("seller.view_summary") : t("seller.managing_deal");

  return (
    <div className={`sd-card${urgent ? " urgent" : ""}`}>
      <div className="sd-main" onClick={open} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
        <div className="sd-top">
          <div className="sd-thumb">{img ? <img src={img} alt="" /> : <span className="sd-thumb-type">{dealTypeLabel(String(deal.deal_type || "physical_product"))}</span>}</div>
          <div className="grow">
            <div className="sd-title">{deal.title}</div>
            <StatusPill state={state} />
          </div>
        </div>
        <div className={`sd-money${state === "Failed" ? " lost" : potential <= 0 ? " zero" : ""}`}>
          {potential <= 0 && !charged ? t("seller.x_0_orders_yet") : ils(showMoney)}
          {closed && charged > 0 ? <span className="small muted">  {t("seller.actually_collected")}</span> : null}
        </div>
        {state !== "Draft" ? (
          <div className="sd-quants">
            <span className="q-charged">{t("seller.charged_successfully_v0", { v0: num(money.charged_units || 0) })}</span>
            <span className={`q-pending${inWindow ? " risk" : ""}`}>
              {inWindow ? t("seller.at_risk") : t("seller.pending")}: {num(pending)}
            </span>
            <span className="q-none">{t("seller.not_charged_v0", { v0: num(money.dropped_units || 0) })}</span>
          </div>
        ) : null}
        {countdownUntil && cd && cd.tone !== "over" ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <Countdown until={countdownUntil} label={inWindow ? t("seller.completion_window") : t("seller.to_closing")} />
            {inWindow && cd.tone === "danger" ? <span style={{ color: "var(--pomegranate)", fontWeight: 800 }}>{t("seller.ending_soon_pending_pending", { pending: num(pending) })}</span> : null}
          </div>
        ) : null}
        {state === "Failed" ? <div className="sd-fail-reason">{failReason({ state, joined_units: deal.metrics?.joined_units, threshold_units: deal.threshold_units })}</div> : null}
      </div>
      <div className="sd-actions">
        <button className="btn btn-sm btn-primary" onClick={open}>{primaryLabel}</button>
        {isOpen ? (
          <button className="btn btn-sm btn-ghost" onClick={async () => {
            if (await copyText(absoluteShareUrl(deal.deal_id, null))) showToast(t("seller.link_copied"));
          }}>{t("seller.copy_link")}</button>
        ) : null}
        {closed && state === "Completed" && String(deal.deal_type || "physical_product") === "physical_product" ? (
          <button className="btn btn-sm btn-ghost" data-testid="card-fulfillment-open" onClick={() => navigate(`#/seller/deal/${deal.deal_id}/fulfillment`)}>{t("seller.orders_hand_over")}</button>
        ) : null}
        {closed ? (
          <button className="btn btn-sm btn-ghost" onClick={async () => {
            try {
              const r = await api.duplicateDeal(deal.deal_id);
              const newId = r?.deal?.deal_id || r?.deal_id;
              showToast(t("seller.a_new_draft_created_check"));
              if (newId) navigate(`#/seller/deal/${newId}`);
            } catch (e: any) { showToast(e.message || t("seller.duplicating_failed")); }
          }}>{t("seller.create_similar_deal")}</button>
        ) : null}
      </div>
    </div>
  );
}

// ── UX CLOSEOUT (Issue #39, item 1) — the terminal-deal archive row ────────
// A Completed / Failed / Cancelled deal is history: it must stay REACHABLE but
// must not consume the primary dashboard next to the deals the seller can still
// act on. The archive therefore renders one compact row per deal instead of the
// full card — title, outcome, the money that actually settled, and only the
// actions that still mean something on a closed deal (open the summary, the
// fulfilment list for a completed physical deal, duplicate).
function SellerArchiveRow({ deal, navigate, showToast }: { deal: Json; navigate: (h: string) => void; showToast: (m: string) => void }) {
  const state = String(deal.state);
  const money = deal.money || {};
  const charged = Number(money.charged_gross || 0);
  const open = () => navigate(`#/seller/deal/${deal.deal_id}`);
  return (
    <div className="sd-archive-row" data-testid="seller-archive-row" data-state={state}>
      <div className="sd-archive-main" onClick={open} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
        <span className="sd-archive-title">{deal.title}</span>
        <StatusPill state={state} />
        <span className="sd-archive-money">{state === "Completed" ? ils(charged) : state === "Failed" ? failReason({ state, joined_units: deal.metrics?.joined_units, threshold_units: deal.threshold_units }) : t("seller.cancelled")}</span>
        <span className="sd-archive-when muted small">{fmtDate(deal.last_update_at || deal.created_at)}</span>
      </div>
      <div className="sd-archive-actions">
        <button className="btn btn-sm btn-ghost" data-testid="archive-open" onClick={open}>{t("seller.view_summary")}</button>
        {state === "Completed" && String(deal.deal_type || "physical_product") === "physical_product" ? (
          <button className="btn btn-sm btn-ghost" data-testid="archive-fulfillment-open" onClick={() => navigate(`#/seller/deal/${deal.deal_id}/fulfillment`)}>{t("seller.orders_hand_over")}</button>
        ) : null}
        <button className="btn btn-sm btn-ghost" data-testid="archive-duplicate" onClick={async () => {
          try {
            const r = await api.duplicateDeal(deal.deal_id);
            const newId = r?.deal?.deal_id || r?.deal_id;
            showToast(t("seller.a_new_draft_created_check"));
            if (newId) navigate(`#/seller/deal/${newId}`);
          } catch (e: any) { showToast(e.message || t("seller.duplicating_failed")); }
        }}>{t("seller.create_similar_deal")}</button>
      </div>
    </div>
  );
}

// ── dashboard ──────────────────────────────────────────────────────────────
function SellerDashboard({ navigate }: { navigate: (h: string) => void }) {
  const copy = resolveSellerCopy(useSiteContent());
  const [surface, setSurface] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number>(Date.now());
  const [now, setNow] = useState(Date.now());
  const [bizStatuses, setBizStatuses] = useState<Json | null>(null);
  // P0.4-2 — command-center analytics: ONE bounded aggregate call (no N+1)
  const [analytics, setAnalytics] = useState<Json | null>(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [aPeriod, setAPeriod] = useState<"7d" | "30d" | "all">("all");
  const [aDeal, setADeal] = useState("");
  // P0.7 — customer inquiries (seller-scoped server-side)
  const [inquiries, setInquiries] = useState<Json | null>(null);
  const [inquiriesError, setInquiriesError] = useState("");
  const [toast, showToast] = useToast();

  // P0.4-1: a single transient 401 right after login must not nuke a fresh
  // legitimate session (the api layer already refresh-retries once) — retry
  // the LOAD once before concluding the session is genuinely dead.
  const authRetriedRef = useRef(false);
  const load = () =>
    api.sellerDeals()
      .then((r) => { setSurface(r.seller_surface); setUpdatedAt(Date.now()); setError(""); authRetriedRef.current = false; })
      .catch((e) => {
        if (e.status === 401 || e.status === 403) {
          if (!authRetriedRef.current) {
            authRetriedRef.current = true;
            setTimeout(() => { void load(); }, 1200);
            return;
          }
          clearAuthSession(); clearOwnerSession(); window.location.reload();
        } else setError(e.message);
      });

  useEffect(() => {
    load();
    api.sellerBusinessProfile().then((r) => setBizStatuses(r.statuses || null)).catch(() => undefined);
    const loadInquiries = () => api.sellerInquiries("open").then((r) => { setInquiries(r); setInquiriesError(""); }).catch((e) => setInquiriesError(e.message));
    loadInquiries();
    const id = setInterval(load, 25_000);
    const inqId = setInterval(loadInquiries, 30_000);
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => { clearInterval(id); clearInterval(inqId); clearInterval(tick); };
  }, []);

  useEffect(() => {
    let alive = true;
    setAnalyticsError("");
    api.sellerAnalytics(aPeriod, aDeal)
      .then((r) => { if (alive) setAnalytics(r); })
      .catch((e) => { if (alive) setAnalyticsError(e.message); });
    return () => { alive = false; };
  }, [aPeriod, aDeal]);

  const deals: Json[] = surface?.deals || [];
  // Issue #39 item 1 — three buckets, not two: what needs attention now, what
  // is still live, and the terminal archive that must not crowd either of them.
  const { urgentDeals, activeDeals, archivedDeals } = useMemo(() => {
    const byRecency = (a: Json, b: Json) => Date.parse(b.last_update_at || b.created_at) - Date.parse(a.last_update_at || a.created_at);
    const urgent = deals
      .filter((d) => URGENT_SELLER_STATES.includes(String(d.state)))
      .sort((a, b) => Date.parse(a.completion_window_until || a.deadline || 0) - Date.parse(b.completion_window_until || b.deadline || 0));
    const rest = deals.filter((d) => !URGENT_SELLER_STATES.includes(String(d.state)));
    return {
      urgentDeals: urgent,
      activeDeals: rest.filter((d) => !CLOSED_STATES.includes(String(d.state))).sort(byRecency),
      archivedDeals: rest.filter((d) => CLOSED_STATES.includes(String(d.state))).sort(byRecency)
    };
  }, [deals]);

  if (!surface && !error) return <BrandLoader label={t("seller.loading_dashboard")} minHeight={420} />;

  const stale = now - updatedAt > 60_000;
  const profile = surface?.seller_profile || {};
  const totalCharged = deals.reduce((s, d) => s + Number(d.money?.charged_gross || 0), 0);
  const totalPotential = deals.filter((d) => !CLOSED_STATES.includes(String(d.state))).reduce((s, d) => s + Number(d.money?.potential_gross || 0), 0);

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>{profile.business_name || profile.display_name || t("seller.my_seller")}</h1>
          <span className="dash-updated">{t("seller.updates_automatically_updated_v0_seconds", { v0: Math.max(0, Math.round((now - updatedAt) / 1000)) })}</span>
          {stale ? <span className="stale-badge" style={{ marginInlineStart: 8 }}>{t("seller.the_figures_may_current_refresh")}</span> : null}
        </div>
        <div className="row" style={{ marginInlineStart: "auto" }}>
          <button className="btn btn-sm btn-ghost" onClick={load} aria-label={t("seller.refresh")}>{t("seller.refresh_2")}</button>
          <a className="btn btn-sm btn-ghost" href="#/seller/receipts">{t("seller.redeeming_purchases")}</a>
          <button className="btn btn-sm btn-ghost" onClick={() => navigate("#/seller/profile")}>{t("seller.business_profile")}</button>
          {/* 071 — Product Library: reusable products the seller creates deals from */}
          <button className="btn btn-sm btn-ghost" data-testid="dash-product-library" onClick={() => navigate("#/seller/products")}>{t("seller.the_product_library")}</button>
          {/* LAUNCH SPRINT 3 — the counter action: no need to find the deal first */}
          <button className="btn btn-sm btn-ghost" data-testid="dash-pickup-scan" onClick={() => navigate("#/seller/pickup")}>{t("seller.pickup_scan")}</button>
          <button className="btn btn-primary" onClick={() => navigate("#/seller/new")}>{t("seller.create_new_deal")}</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { clearAuthSession(); clearOwnerSession(); window.location.reload(); }}>{t("seller.sign_out")}</button>
        </div>
      </div>

      {/* LAUNCH MODE — a self-registered seller is pending until the owner approves; say so plainly */}
      {String(profile.verification_status || "") === "pending" ? (
        <div className="notice info" data-testid="seller-pending-approval">
          <b>{copy.pending_title}</b> {copy.pending_body}
        </div>
      ) : null}
      {String(profile.verification_status || "") === "rejected" ? (
        <div className="notice err" data-testid="seller-rejected">
          <b>{copy.rejected_title}</b> {copy.rejected_body} <a href="#/support" onClick={(e) => { e.preventDefault(); navigate("#/support"); }}>{t("seller.support_contact")}</a>.
        </div>
      ) : null}
      {/* LAUNCH POLISH (P3) — a seller who never published sees the whole path once, compactly */}
      {deals.every((d) => !d.published_at) ? <SellerJourney deal={null} title={copy.journey_title} /> : null}
      {bizStatuses && (!bizStatuses.profile_complete || !bizStatuses.settlement_ready) ? (
        <div className="notice info" style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>
            <b>{copy.profile_incomplete_title}</b> — {!bizStatuses.profile_complete ? t("seller.the_business_contact_details_missing") : t("seller.the_bank_account_details_receiving")}.
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => navigate("#/seller/profile")}>{t("seller.complete_profile")}</button>
        </div>
      ) : null}

      {error ? <div className="notice err">{error}</div> : null}

      {/* P0.4-2A — global seller KPI strip (canonical analytics; potential vs charged vs net) */}
      {analytics ? <KpiStrip analytics={analytics} /> : (
        <div className="stat-row">
          <StatTile num={num(surface?.totals?.live_deals || 0)} label={t("seller.live_deals")} />
          <StatTile num={ils(totalPotential)} label={t("seller.active_deal_volume_authorizations")} />
          <StatTile num={ils(totalCharged)} label={t("seller.actually_collected")} tone="good" />
          <StatTile num={num(surface?.totals?.completed_deals || 0)} label={t("seller.completed")} />
        </div>
      )}

      {/* P0.4-2H — action center, high on the page */}
      {analytics ? <ActionCenterPanel items={analytics.action_center || []} navigate={navigate} /> : null}

      {/* P0.7 — customer inquiries live in the command center (never a parallel dashboard) */}
      <InquiriesPanel data={inquiries} error={inquiriesError} navigate={navigate} />

      {urgentDeals.length ? (
        <>
          <div className="section-title">{t("seller.needs_attention_now")} <span className="count">({urgentDeals.length})</span></div>
          <div className="sd-grid">
            {urgentDeals.map((d) => <SellerDealCard key={d.deal_id} deal={d} navigate={navigate} showToast={showToast} />)}
          </div>
        </>
      ) : null}

      <div className="section-title">{t("seller.my_deals")} <span className="count">({activeDeals.length})</span></div>
      {deals.length === 0 ? (
        <EmptyState title={copy.empty_title}
          body={copy.empty_body}
          action={<button className="btn btn-primary" onClick={() => navigate("#/seller/new")}>{copy.empty_cta}</button>} />
      ) : activeDeals.length === 0 && urgentDeals.length === 0 ? (
        <p className="muted" data-testid="seller-no-active-deals">{t("seller.there_active_deals_right_now")}</p>
      ) : (
        <div className="sd-grid">
          {activeDeals.map((d) => <SellerDealCard key={d.deal_id} deal={d} navigate={navigate} showToast={showToast} />)}
        </div>
      )}

      {/* Issue #39 item 1 — terminal deals: collapsed by default, one line each */}
      {archivedDeals.length ? (
        <details className="sd-archive" data-testid="seller-archive">
          <summary data-testid="seller-archive-toggle">
            {t("seller.archive_finished_deals")} <span className="count" data-testid="seller-archive-count">({archivedDeals.length})</span>
          </summary>
          <div className="sd-archive-list">
            {archivedDeals.map((d) => <SellerArchiveRow key={d.deal_id} deal={d} navigate={navigate} showToast={showToast} />)}
          </div>
        </details>
      ) : null}

      {/* P0.4-2G/C/D/F/I — money, trends, funnel, viral, activity */}
      {analytics ? (
        <>
          <MoneyPanel analytics={analytics} />
          <div className="panel analytics-filters" data-testid="analytics-filters">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>{t("seller.period")}</span>
              {([["7d", t("seller.x_7_days")], ["30d", t("seller.x_30_days")], ["all", t("seller.all_time")]] as const).map(([value, label]) => (
                <button key={value} className={`btn btn-sm ${aPeriod === value ? "btn-primary" : "btn-ghost"}`} onClick={() => setAPeriod(value)}>{label}</button>
              ))}
              <span style={{ fontWeight: 700, marginInlineStart: 12 }}>{t("seller.deal")}</span>
              <select value={aDeal} onChange={(e) => setADeal(e.target.value)} style={{ maxWidth: 240 }}>
                <option value="">{t("seller.all_deals")}</option>
                {deals.map((d) => <option key={d.deal_id} value={d.deal_id}>{d.title}</option>)}
              </select>
            </div>
          </div>
          <ChartsPanel analytics={analytics} />
          <FunnelPanel analytics={analytics} />
          <ViralPanel analytics={analytics} dealScope={aDeal} navigate={navigate} />
          <ActivityPanel items={analytics.recent_activity || []} />
        </>
      ) : analyticsError ? (
        <div className="notice err">{t("seller.loading_analytics_failed_analyticserror", { analyticsError: analyticsError })}</div>
      ) : (
        <div className="panel"><p className="muted small" style={{ margin: 0 }}>{t("seller.loading_analytics")}</p></div>
      )}
      <Toast msg={toast} />
    </>
  );
}

// ── deadline picker (P0.2-F): calendar date + exact time, Israel wall clock ─
function DeadlinePicker(props: {
  date: string; time: string;
  onDate: (v: string) => void; onTime: (v: string) => void;
  error?: string;
  idPrefix?: string;
}) {
  const prefix = props.idPrefix || "deadline";
  const iso = israelPartsToUtcIso(props.date, props.time);
  const todayIsrael = utcIsoToIsraelParts(new Date().toISOString()).date;
  // LONG_HORIZON_DEALS — no payment-derived maximum: the picker only refuses
  // the technical sanity ceiling shared with the server (web/src/deadlinePolicy.ts).
  const maxIsrael = utcIsoToIsraelParts(new Date(Date.now() + DEADLINE_TECHNICAL_MAX_MS).toISOString()).date;
  const longHorizon = iso ? classifyDeadlineMs(Date.parse(iso)).long_horizon : false;
  return (
    <div className="field">
      <label>{t("seller.joining_deadline")} <span className="req">*</span> <span className="hint">{t("seller.israel_time")}</span></label>
      <div className="deadline-row">
        <input id={`f-${prefix}-date`} dir="ltr" type="date" value={props.date} min={todayIsrael} max={maxIsrael}
          className={props.error ? "invalid" : ""} onChange={(e) => props.onDate(e.target.value)} />
        <input id={`f-${prefix}-time`} dir="ltr" type="time" value={props.time}
          className={props.error ? "invalid" : ""} onChange={(e) => props.onTime(e.target.value)} />
      </div>
      <FieldError msg={props.error} />
      {iso && !props.error ? (
        <span className="deadline-confirm">✓ {formatIsraelDateTime(iso)}</span>
      ) : null}
      <span className="hint">{t("seller.at_least_two_hours_publishing")}</span>
      {longHorizon && !props.error ? <LongHorizonWarning /> : null}
    </div>
  );
}

// Advisory only (strictly > 1 year): cards may expire, be replaced or blocked
// over a long horizon, so some buyers may need to update their payment method
// before completion. The worker renews an expired authorization from the
// stored payment method; this warning never blocks the seller.
function LongHorizonWarning() {
  return (
    <div className="notice warn" data-testid="long-horizon-warning">
      <strong>{t("seller.note")}</strong>  {t("seller.this_deal_set_up_long")}</div>
  );
}

function validateDeadline(date: string, time: string): { iso: string | null; error: string } {
  if (!date || !time) return { iso: null, error: t("seller.choose_date_time_deadline") };
  const iso = israelPartsToUtcIso(date, time);
  if (!iso) return { iso: null, error: t("seller.choose_valid_date_time") };
  const policy = classifyDeadlineMs(Date.parse(iso));
  if (!policy.ok) return { iso, error: CODE_MESSAGE_KEYS[policy.code] ? t(CODE_MESSAGE_KEYS[policy.code]!) : policy.code };
  return { iso, error: "" };
}

// ── create wizard — saves a Draft and lands INSIDE the deal (P0.2-G) ───────
// Translation keys (module-level constant).
const WIZARD_STEPS = ["seller.wizard_steps", "seller.wizard_steps_2", "seller.wizard_steps_3", "seller.wizard_steps_4", "seller.wizard_steps_5"];
// 071 — ISO → the value a datetime-local input expects (local wall clock)
function toWizardLocalDateTime(iso: unknown): string {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
type WizardDealType = "physical_product" | "voucher" | "ticket";
// 071 — est_min/est_max: optional fulfillment estimate (business days from Deal completion)
type DeliveryDraft = { option_type: string; label: string; cost: string; latitude: number | null; longitude: number | null; est_min: string; est_max: string };

// P0.6A — pickup GPS with the bounded explicit-click strategy (web/src/geo.ts).
// Location is requested ONLY on the seller's click (never on load, never
// watchPosition). Attempt 1 normal accuracy → attempt 2 high accuracy only on
// TIMEOUT/UNAVAILABLE; a denial never retries. Site-level and OS-level denials
// get different, honest recovery guidance (a website cannot override either),
// every failure auto-opens the manual coordinates fallback, and the address
// field always suffices — the seller is never trapped.
function LocationCapture({ row, onSet }: { row: DeliveryDraft; onSet: (lat: number | null, lng: number | null) => void }) {
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ n: 1 | 2; high: boolean } | null>(null);
  const [outcome, setOutcome] = useState<GeoOutcome | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualError, setManualError] = useState("");
  const [mLat, setMLat] = useState("");
  const [mLng, setMLng] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  if (row.option_type === "delivery") return null;

  const capture = async () => {
    if (inFlight.current) return; // one bounded request per click, never stacked
    inFlight.current = true;
    setOutcome(null); setManualError(""); setAttempt(null); setPending(true);
    recordGeoTrace({ step: "click" });
    let result: GeoOutcome;
    try {
      result = await requestPickupLocation(browserGeoDeps(), {
        trace: recordGeoTrace,
        onAttempt: (n, high) => { if (mounted.current) setAttempt({ n, high }); }
      });
    } finally {
      inFlight.current = false;
    }
    if (!mounted.current) return;
    setPending(false); setAttempt(null);
    if (result.kind === "success" && result.latitude != null && result.longitude != null) {
      onSet(result.latitude, result.longitude);
      return;
    }
    setOutcome(result);
    setShowManual(true); // manual fallback is first-class: never trap the seller
  };

  const applyManual = () => {
    const parsed = parseManualCoordinates(mLat, mLng);
    if (!parsed.ok) { setManualError(parsed.error); return; }
    setManualError("");
    setOutcome(null);
    onSet(parsed.latitude, parsed.longitude);
  };

  if (row.latitude != null && row.longitude != null) {
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${row.latitude},${row.longitude}`;
    return (
      <div className="row" style={{ gap: 8, marginTop: -4, marginBottom: 10, flexWrap: "wrap" }}>
        <span className="small" style={{ fontWeight: 700, color: "var(--accent-cyan)" }} data-testid="geo-captured">
          {t("seller.location_captured_v0_v1", { v0: row.latitude.toFixed(4), v1: row.longitude.toFixed(4) })}</span>
        <a className="btn btn-sm btn-ghost" href={mapUrl} target="_blank" rel="noreferrer">{t("seller.show_map")}</a>
        <button type="button" className="btn btn-sm btn-ghost" data-testid="geo-remove" onClick={() => onSet(null, null)}>{t("seller.remove_location")}</button>
      </div>
    );
  }

  const copy = outcome && outcome.kind !== "success" ? GEO_OUTCOME_COPY[outcome.kind] : null;
  const failureTestId = outcome && outcome.kind !== "success" ? GEO_OUTCOME_TEST_ID[outcome.kind] : "";
  const pendingLabel = attempt?.n === 2 ? t("seller.trying_again_high_accuracy_mode") : t("seller.requesting_access_location");

  return (
    <div className="stack" style={{ gap: 6, marginTop: -4, marginBottom: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-sm btn-ghost" disabled={pending} data-testid="use-my-location"
          data-geo-pending={pending ? "1" : "0"} data-geo-attempt={attempt ? String(attempt.n) : ""}
          onClick={() => { void capture(); }}>
          {pending ? pendingLabel : t("seller.use_my_location")}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" style={{ opacity: .7 }} data-testid="geo-manual-toggle"
          onClick={() => setShowManual((v) => !v)}>
          {t("seller.enter_coordinates_manually")}</button>
      </div>
      <span className="hint">{t("seller.optional_gives_buyers_navigation_button")}</span>

      {copy && outcome ? (
        <div className={`notice ${copy.denial ? "err" : "info"}`} data-testid={failureTestId} data-geo-kind={outcome.kind} style={{ marginTop: 2 }}>
          <b>{t(copy.title)}</b>
          <div className="small" style={{ marginTop: 4 }}>
            {copy.note ? <div>{t(copy.note)}</div> : null}
            {copy.steps.map((step, i) => <div key={i}>{i + 1}. {t(step)}</div>)}
          </div>
          {copy.retryable ? (
            <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} disabled={pending}
              data-testid={copy.denial ? "geo-recheck" : "geo-retry"} onClick={() => { void capture(); }}>
              {copy.denial ? t("seller.check_again") : t("seller.try_again")}
            </button>
          ) : null}
          <code className="small" dir="ltr" data-testid="geo-diag"
            style={{ display: "block", marginTop: 6, opacity: .75, wordBreak: "break-all", textAlign: "left" }}>
            {geoDiagnosticLine(outcome)}
          </code>
        </div>
      ) : null}

      {showManual ? (
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }} data-testid="geo-manual">
          <div className="field" style={{ marginBottom: 0, flex: "1 1 110px" }}>
            <label>{t("seller.latitude_lat")}</label>
            <input dir="ltr" inputMode="decimal" data-testid="geo-manual-lat" value={mLat} onChange={(e) => setMLat(e.target.value)} placeholder="32.0668" />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: "1 1 110px" }}>
            <label>{t("seller.longitude_lng")}</label>
            <input dir="ltr" inputMode="decimal" data-testid="geo-manual-lng" value={mLng} onChange={(e) => setMLng(e.target.value)} placeholder="34.7647" />
          </div>
          <button type="button" className="btn btn-sm btn-ghost" data-testid="geo-manual-apply" onClick={applyManual}>{t("seller.save")}</button>
        </div>
      ) : null}
      {manualError ? <span className="field-error" data-testid="geo-manual-error">{manualError}</span> : null}
    </div>
  );
}

// 071 — optional fulfillment estimate on a delivery option (business days from
// Deal completion). Required at publish time only for Product-backed Deals.
function estimateTextFor(row: DeliveryDraft): string | null {
  return deliveryEstimateText({
    estimated_min_business_days: row.est_min.trim() ? Number(row.est_min) : null,
    estimated_max_business_days: row.est_max.trim() ? Number(row.est_max) : null
  });
}
function DeliveryEstimateInputs({ row, index, onChange, error }: { row: DeliveryDraft; index: number; onChange: (min: string, max: string) => void; error?: string }) {
  const preview = estimateTextFor(row);
  return (
    <div className="field" style={{ marginBottom: 8 }} data-testid={`delivery-estimate-${index}`}>
      <label>{t("seller.estimated_delivery_time")} <span className="hint">{t("seller.business_days_deal_completing_optional")}</span></label>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <input dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 100 }} value={row.est_min} aria-label={t("seller.minimum_business_days")} data-testid={`delivery-est-min-${index}`} onChange={(e) => onChange(e.target.value, row.est_max)} />
        <span>{t("seller.until")}</span>
        <input dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 100 }} value={row.est_max} aria-label={t("seller.maximum_business_days")} data-testid={`delivery-est-max-${index}`} onChange={(e) => onChange(row.est_min, e.target.value)} />
        {preview ? <span className="muted small">{t("seller.shown_buyers_preview", { preview: preview })}</span> : null}
      </div>
      <FieldError msg={error} />
    </div>
  );
}

function deliveryEstimatePayload(row: DeliveryDraft): { estimated_min_business_days?: number; estimated_max_business_days?: number } {
  return {
    ...(row.est_min.trim() ? { estimated_min_business_days: Number(row.est_min) } : {}),
    ...(row.est_max.trim() ? { estimated_max_business_days: Number(row.est_max) } : {})
  };
}

function CreateWizard({ navigate, productId }: { navigate: (h: string) => void; productId?: string | null }) {
  // 071 — a Deal created FROM a Product: the Product owns name, copy, type and
  // typed attributes (frozen server-side into the Deal snapshot); the wizard
  // only asks for what the DEAL decides — price, quantities, delivery, deadline.
  const [product, setProduct] = useState<Json | null>(null);
  const [productError, setProductError] = useState("");
  const productEstDefaults = {
    min: product?.fulfillment_defaults?.estimated_min_business_days == null ? "" : String(product.fulfillment_defaults.estimated_min_business_days),
    max: product?.fulfillment_defaults?.estimated_max_business_days == null ? "" : String(product.fulfillment_defaults.estimated_max_business_days)
  };
  const [receipt, setReceipt] = useState<ReceiptConfig>({ method: "qr", methods: ["qr"], instructions: "", url: "" });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  // step 1
  const [dealType, setDealType] = useState<WizardDealType>("physical_product");
  const [title, setTitle] = useState("");
  const [shortDesc, setShortDesc] = useState("");
  const [longDesc, setLongDesc] = useState("");
  const [price, setPrice] = useState("");
  const [listPrice, setListPrice] = useState(""); // LAUNCH MODE — regular price (optional)
  const [images, setImages] = useState<LocalImage[]>([]);
  const [uploadStatus, setUploadStatus] = useState("");
  // step 2
  const [minUnits, setMinUnits] = useState("10");
  const [maxUnits, setMaxUnits] = useState("50");
  // step 3
  const [delivery, setDelivery] = useState<DeliveryDraft[]>([
    { option_type: "pickup", label: "", cost: "0", latitude: null, longitude: null, est_min: "", est_max: "" }
  ]);
  const [voucherFaceValue, setVoucherFaceValue] = useState("");
  const [voucherValidUntil, setVoucherValidUntil] = useState("");
  const [redemptionLocation, setRedemptionLocation] = useState("");
  const [redemptionInstructions, setRedemptionInstructions] = useState("");
  const [voucherTerms, setVoucherTerms] = useState("");
  const [eventName, setEventName] = useState("");
  const [eventStartsAt, setEventStartsAt] = useState("");
  const [eventEndsAt, setEventEndsAt] = useState("");
  const [venueName, setVenueName] = useState("");
  const [venueAddress, setVenueAddress] = useState("");
  const [venueCity, setVenueCity] = useState("");
  const [entryInstructions, setEntryInstructions] = useState("");
  const [ticketType, setTicketType] = useState("general_admission");
  const [seatMode, setSeatMode] = useState("general_admission");
  const [transferAllowed, setTransferAllowed] = useState(false);
  // step 4 — exact Israel-time deadline
  const [deadlineDate, setDeadlineDate] = useState("");
  const [deadlineTime, setDeadlineTime] = useState("18:00");

  useEffect(() => {
    if (!productId) return;
    let alive = true;
    api.sellerProduct(productId).then((r) => {
      if (!alive) return;
      const p = r.product as Json;
      if (String(p.status) !== "active") { setProductError(t("seller.the_product_archived_restore_product")); return; }
      setProduct(p);
      const type = String(p.product_type || "physical_product") as WizardDealType;
      setDealType(type);
      setTitle(String(p.name || ""));
      setShortDesc(String(p.short_description || ""));
      setLongDesc(String(p.long_description || ""));
      const attrs = (p.type_attributes || {}) as Json;
      if (type === "voucher") {
        setRedemptionLocation(String(attrs.redemption_location || ""));
        setRedemptionInstructions(String(attrs.redemption_instructions || ""));
        setVoucherTerms(String(attrs.usage_restrictions || ""));
        if (attrs.valid_until) setVoucherValidUntil(String(attrs.valid_until).slice(0, 10));
      }
      if (type === "ticket") {
        setEventName(String(attrs.event_name || ""));
        if (attrs.event_starts_at) setEventStartsAt(toWizardLocalDateTime(attrs.event_starts_at));
        if (attrs.event_ends_at) setEventEndsAt(toWizardLocalDateTime(attrs.event_ends_at));
        setVenueName(String(attrs.venue_name || "")); setVenueAddress(String(attrs.venue_address || "")); setVenueCity(String(attrs.venue_city || ""));
        setEntryInstructions(String(attrs.entry_instructions || ""));
      }
      const d = (p.fulfillment_defaults || {}) as Json;
      const min = d.estimated_min_business_days == null ? "" : String(d.estimated_min_business_days);
      const max = d.estimated_max_business_days == null ? "" : String(d.estimated_max_business_days);
      setDelivery((rows) => rows.map((row) => ({ ...row, est_min: row.est_min || min, est_max: row.est_max || max })));
    }).catch((e) => { if (alive) setProductError(e.message || t("seller.the_product_cannot_loaded")); });
    return () => { alive = false; };
  }, [productId]);
  const productImages: Json[] = product?.images || [];

  const priceNum = Number(price);
  const minNum = Math.max(1, Number(minUnits) || 0);
  const maxNum = Number(maxUnits) || 0;
  const threshold = Math.ceil(0.9 * minNum);
  const deadlineCheck = validateDeadline(deadlineDate, deadlineTime);

  // Explicit, explained validation (P0.2-D): the button never silently does
  // nothing — a failed step marks each field, shows a Hebrew message under it,
  // and scrolls to the first problem.
  const validateStep = (s: number): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (s === 0) {
      if (productId && !product) errs.product = productError || t("seller.waiting_product_load");
      if (!product && !title.trim()) errs.title = t("seller.enter_name_deal");
      if (!product && !shortDesc.trim()) errs.short = t("seller.enter_short_description_sentence_sells");
      if (!(priceNum > 0)) errs.price = t("seller.enter_price_per_unit");
      if (listPrice.trim() && !(Number(listPrice) > priceNum)) errs.listPrice = t("seller.the_list_price_must_higher");
      if (images.length === 0 && productImages.length === 0) errs.images = t("seller.upload_least_one_image");
    }
    if (s === 1) {
      if (!isPositiveIntegerText(minUnits)) errs.min = t("seller.enter_minimum_quantity");
      if (!isPositiveIntegerText(maxUnits) || !(maxNum >= minNum)) errs.max = t("seller.the_maximum_quantity_must_least");
    }
    if (s === 2) {
      if (dealType === "physical_product" && !delivery.some((d) => d.label.trim())) errs.delivery = t("seller.add_least_one_delivery_option");
      if (dealType === "voucher") {
        if (!(Number(voucherFaceValue) > 0)) errs.voucherFace = t("seller.enter_voucher_value");
        if (!voucherValidUntil || new Date(`${voucherValidUntil}T23:59:59`).getTime() <= Date.now()) errs.voucherValid = t("seller.choose_future_validity_date_voucher");
        if (!redemptionLocation.trim()) errs.voucherLocation = t("seller.enter_redemption_place");
        if (!redemptionInstructions.trim()) errs.voucherInstructions = t("seller.enter_redemption_instructions");
        if (!voucherTerms.trim()) errs.voucherTerms = t("seller.enter_voucher_terms");
      }
      if (dealType === "ticket") {
        if (!eventName.trim()) errs.eventName = t("seller.enter_event_name");
        if (!eventStartsAt || new Date(eventStartsAt).getTime() <= Date.now()) errs.eventStart = t("seller.choose_future_date_event");
        if (!venueName.trim()) errs.venueName = t("seller.enter_event_venue");
        if (!venueCity.trim()) errs.venueCity = t("seller.enter_city");
        if (!entryInstructions.trim()) errs.entry = t("seller.enter_entry_instructions");
        if (eventEndsAt && new Date(eventEndsAt).getTime() <= new Date(eventStartsAt).getTime()) errs.eventEnd = t("seller.the_deadline_must_after_start");
      }
    }
    // P0.7 — self-pickup / distribution point must carry a usable location
    if (s === 2 && dealType === "physical_product" && !errs.delivery) {
      const configured = delivery.filter((d) => d.label.trim());
      if (configured.some((d) => !hasUsablePickupLocation(d))) {
        errs.delivery = t("seller.pickup_distribution_point_needs_address");
      }
    }
    if (s === 2 && dealType === "physical_product") {
      delivery.forEach((d, i) => {
        if (!d.label.trim()) return;
        const estError = validateEstimateRange(d.est_min, d.est_max);
        if (estError) errs[`delivery-estimate-${i}`] = estError;
        else if (product && (!d.est_min.trim() || !d.est_max.trim())) errs[`delivery-estimate-${i}`] = t("seller.a_deal_created_product_needs");
      });
    }
    if (s === 2 && receiptMethodsOf(receipt).includes("instructions") && !receipt.instructions.trim()) errs.receipt = t("seller.enter_redemption_instructions");
    if (s === 2 && receiptMethodsOf(receipt).includes("digital_link")) {
      try { const u = new URL(receipt.url); if (u.protocol !== "https:" || u.username || u.password) errs.receipt = t("seller.enter_valid_https_link"); } catch { errs.receipt = t("seller.enter_valid_https_link"); }
    }
    if (s === 3 && deadlineCheck.error) errs.deadline = deadlineCheck.error;
    return errs;
  };

  // ROUND 2 (UX-2) — a lit control goes dark the instant its value becomes
  // valid: a text field clears on the first valid character, a select / number
  // / option group the moment its value passes. Errors are only ever REMOVED
  // here, never added, so typing in one field can't light up another.
  useEffect(() => {
    if (!Object.keys(errors).length) return;
    const settled = settleErrors(errors, validateStep(step));
    if (!sameErrors(errors, settled)) setErrors(settled);
  });

  const continueStep = () => {
    const errs = validateStep(step);
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) { focusField(first); return; }
    setStep(step + 1);
  };

  const save = async () => {
    if (busy) return;
    for (let s = 0; s <= 3; s++) {
      const errs = validateStep(s);
      if (Object.keys(errs).length) { setStep(s); setErrors(errs); focusField(Object.keys(errs)[0]!); return; }
    }
    setBusy(true); setError("");
    try {
      const typeSpecific = dealType === "voucher" ? {
        delivery_options: [],
        voucher_terms: {
          face_value_amount: Number(voucherFaceValue),
          currency: "ILS",
          valid_until: new Date(`${voucherValidUntil}T23:59:59`).toISOString(),
          redemption_location: redemptionLocation.trim(),
          redemption_instructions: redemptionInstructions.trim(),
          terms: voucherTerms.trim(),
          is_single_use: true,
          allow_partial_redemption: false,
          voucher_code_mode: "system_generated"
        }
      } : dealType === "ticket" ? {
        delivery_options: [],
        ticket_terms: {
          event_name: eventName.trim(),
          event_starts_at: new Date(eventStartsAt).toISOString(),
          event_ends_at: eventEndsAt ? new Date(eventEndsAt).toISOString() : null,
          venue_name: venueName.trim(),
          venue_address: venueAddress.trim(),
          venue_city: venueCity.trim(),
          entry_instructions: entryInstructions.trim(),
          ticket_type: ticketType,
          seat_mode: seatMode,
          transfer_allowed: transferAllowed
        }
      } : {
        delivery_options: delivery
          .filter((d) => d.label.trim())
          .map((d, i) => ({
            option_type: d.option_type, label: d.label.trim(), cost: Math.max(0, Number(d.cost) || 0), sort_order: i,
            ...(d.latitude != null && d.longitude != null ? { latitude: d.latitude, longitude: d.longitude } : {}),
            ...deliveryEstimatePayload(d)
          }))
      };
      const created = await api.createDeal({
        // 071 — the server takes name/copy/type from the Product snapshot when product_id is set
        ...(product ? { product_id: String(product.product_id) } : {}),
        title: title.trim(),
        description: longDesc.trim(),
        description_short: shortDesc.trim(),
        price_per_unit: priceNum,
        ...(listPrice.trim() ? { list_price_per_unit: Number(listPrice) } : {}),
        min_units: minNum,
        max_units: maxNum,
        deadline: deadlineCheck.iso,
        deal_type: dealType,
        ...typeSpecific
      });
      const dealId = created?.deal?.deal_id || created?.deal_id;
      if (!dealId) throw new Error(t("seller.creating_deal_failed_try_again"));
      try {
        await productRequest(`/api/seller/deals/${dealId}/receipt`, { method: "PUT", body: JSON.stringify(receipt) }, "seller");
      } catch {
        setError(t("seller.the_draft_saved_but_redemption"));
        setTimeout(() => navigate(`#/seller/deal/${dealId}`), 2200);
        return;
      }
      // Upload images while still a Draft; a failed upload keeps the Draft
      // and the deal screen's image manager offers a retry.
      for (let i = 0; i < images.length; i += 1) {
        const img = images[i]!;
        setUploadStatus(t("seller.uploading_image_v0_length", { v0: i + 1, length: images.length }));
        try {
          await uploadDealImage(dealId, img, {
            isPrimary: i === 0,
            sortOrder: i,
            onProgress: (pct) => setUploadStatus(t("seller.uploading_image_v0_length_pct", { v0: i + 1, length: images.length, pct: pct }))
          });
        } catch (imgErr: any) {
          setUploadStatus("");
          setError(t("seller.the_draft_saved_but_uploading", { name: img.name }));
          setTimeout(() => navigate(`#/seller/deal/${dealId}`), 2200);
          return;
        }
      }
      setUploadStatus("");
      // Land INSIDE the deal — its screen shows the Draft banner + publish CTA.
      navigate(`#/seller/deal/${dealId}`);
    } catch (err: any) {
      setUploadStatus("");
      setError(err.message || t("seller.saving_failed_try_again"));
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("seller.to_dashboard")}</a>
      <div className="panel">
        <h2>{t("seller.create_group_deal")}</h2>
        <div className="wizard-steps">
          {WIZARD_STEPS.map((s, i) => (
            <div key={s} className={`wizard-step${i === step ? " active" : i < step ? " done" : ""}`}>{i + 1}. {t(s)}</div>
          ))}
        </div>

        {step === 0 && productId ? (
          productError ? <div className="notice err" data-testid="wizard-product-error">{productError} <a href="#/seller/products" onClick={(e) => { e.preventDefault(); navigate("#/seller/products"); }}>{t("seller.to_product_library")}</a></div>
          : !product ? <div className="notice info">{t("seller.loading_product")}</div>
          : (
            <div className="notice info product-locked-summary" data-testid="wizard-product-summary">
              <Tx k="seller.product_summary" vars={{ name: <b>{t("seller.a_deal_product_name", { name: product.name })}</b>, type: dealTypeLabel(String(product.product_type)), revision: num(product.revision || 1) }} />
              <div className="small muted" style={{ marginTop: 4 }}>{product.short_description}</div>
              <div className="small muted" style={{ marginTop: 4 }}>{t("seller.the_name_description_type_come")} <a href={`#/seller/products/${product.product_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/products/${product.product_id}`); }}>{t("seller.to_product")}</a></div>
              {productImages.length ? <div className="small muted" style={{ marginTop: 4 }}>{t("seller.the_product_s_length_images", { length: num(productImages.length) })}</div> : null}
            </div>
          )
        ) : null}
        {step === 0 ? (
          <>
            {!productId ? <div className="field">
              <label htmlFor="deal-type">{t("seller.deal_type")}</label>
              <select id="deal-type" data-testid="deal-type" value={dealType} onChange={(e) => setDealType(e.target.value as WizardDealType)}>
                <option value="physical_product">{t("seller.physical_product")}</option>
                <option value="voucher">{t("seller.voucher")}</option>
                <option value="ticket">{t("seller.event_ticket")}</option>
              </select>
              <span className="hint">{t("seller.the_next_step_asks_only")}</span>
            </div> : null}
            {!productId ? <><div className="field">
              <label htmlFor="f-title">{t("seller.deal_name")} <span className="req">*</span></label>
              <input {...attention(errors, "title")} data-testid="deal-title" value={title}
                onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={t("seller.for_example_5_kg_pack")} />
              <FieldError msg={errors.title} />
            </div>
            <div className="field">
              <label htmlFor="f-short">{t("seller.short_description")} <span className="req">*</span> <span className="hint">{t("seller.the_sentence_sells_appears_top")}</span></label>
              <input {...attention(errors, "short")} data-testid="deal-short" value={shortDesc}
                onChange={(e) => setShortDesc(e.target.value)} maxLength={200} placeholder={t("seller.for_example_olives_half_price")} />
              <FieldError msg={errors.short} />
            </div>
            <div className="field">
              <label htmlFor="f-long">{t("seller.full_description")} <span className="hint">{t("seller.optional_everything_matters_buyers_appears")}</span></label>
              <textarea {...attention(errors, "long")} data-testid="deal-long" rows={6} value={longDesc} onChange={(e) => setLongDesc(e.target.value)} maxLength={4000}
                placeholder={t("seller.what_exactly_get_how_arrives")} />
            </div></> : null}
            <div className="field">
              <label htmlFor="f-price">{t("seller.price_per_unit")} <span className="req">*</span></label>
              <input {...attention(errors, "price")} data-testid="deal-price" dir="ltr" type="number" min={1} step="0.5"
                value={price} onChange={(e) => setPrice(e.target.value)} />
              <FieldError msg={errors.price} />
              <span className="hint">{t("seller.the_price_locked_after_publishing")}</span>
            </div>
            <div className="field">
              <label htmlFor="f-listPrice">{t("seller.list_price_per_unit")} <span className="hint">{t("seller.optional_list_price_outside_group")}</span></label>
              <input {...attention(errors, "listPrice")} data-testid="deal-list-price" dir="ltr" type="number" min={1} step="0.5"
                value={listPrice} onChange={(e) => setListPrice(e.target.value)} placeholder={priceNum > 0 ? String(Math.round(priceNum * 1.3)) : ""} />
              <FieldError msg={errors.listPrice} />
              {listPrice.trim() && Number(listPrice) > priceNum && priceNum > 0
                ? <span className="hint">{t("seller.shown_buyers_saving_v0_off", { v0: Math.round((1 - priceNum / Number(listPrice)) * 100) })}</span>
                : null}
            </div>
            <div {...attentionBlock(errors, "images", "field")}>
              <label>{t("seller.images_label")} {productImages.length ? <span className="hint">{t("seller.optional_length_images_come_product", { length: num(productImages.length) })}</span> : <span className="req">*</span>}</label>
              <LocalImageManager images={images} onChange={setImages} />
              <FieldError msg={errors.images} />
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="field-row">
              <div className="field">
                <label htmlFor="f-min">{t("seller.minimum_quantity")} <span className="req">*</span></label>
                <input {...attention(errors, "min")} data-testid="deal-min" {...QUANTITY_INPUT_ATTRS}
                  value={minUnits} onChange={(e) => setMinUnits(e.target.value)} />
                <FieldError msg={errors.min} />
                <span className="hint">{t("seller.the_target_group_needs_reach")}</span>
              </div>
              <div className="field">
                <label htmlFor="f-max">{t("seller.maximum_quantity_stock")} <span className="req">*</span></label>
                <input {...attention(errors, "max")} data-testid="deal-max" {...QUANTITY_INPUT_ATTRS}
                  value={maxUnits} onChange={(e) => setMaxUnits(e.target.value)} />
                <FieldError msg={errors.max} />
                <span className="hint">{t("seller.when_reached_sale_closes")}</span>
              </div>
            </div>
            <div className="notice info">
              <Tx k="seller.final_success_threshold" vars={{ rule: <b>{t("seller.x_90_minimum")}</b>, units: num(threshold) }} />
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <ReceiptFields value={receipt} onChange={setReceipt} attention={Boolean(errors.receipt)} /><FieldError msg={errors.receipt} />
            {dealType === "physical_product" ? <>
            <div {...attentionBlock(errors, "delivery", "notice info attention-block")} data-testid="delivery-required-notice">{t("seller.choose_least_one_delivery_option")}</div>
            <FieldError msg={errors.delivery} />
            {delivery.map((d, i) => (
              <React.Fragment key={i}>
                <div className="row" style={{ marginBottom: 10, alignItems: "flex-end" }}>
                  <div className="field" style={{ marginBottom: 0, flex: "1 1 130px" }}>
                    <label>{t("seller.type")}</label>
                    <select value={d.option_type} onChange={(e) => {
                      const t = e.target.value;
                      setDelivery(delivery.map((x, j) => j === i ? { ...x, option_type: t, ...(t === "delivery" ? { latitude: null, longitude: null } : {}) } : x));
                    }}>
                      <option value="pickup">{t("seller.pickup")}</option>
                      <option value="delivery">{t("seller.delivery")}</option>
                      <option value="distribution_point">{t("seller.distribution_point")}</option>
                    </select>
                  </div>
                  <div className="field grow" style={{ marginBottom: 0, flex: "2 1 180px" }}>
                    <label>{isPickupOptionType(d.option_type) ? t("seller.pickup_address_location") : t("seller.description")}</label>
                    <input data-testid={`delivery-label-${i}`} value={d.label} onChange={(e) => setDelivery(delivery.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder={isPickupOptionType(d.option_type) ? t("seller.for_example_12_herzl_st") : t("seller.for_example_courier_delivery_door")} />
                  </div>
                  <div className="field" style={{ marginBottom: 0, flex: "1 1 100px" }}>
                    <label>{t("seller.cost")}</label>
                    <input dir="ltr" type="number" min={0} value={d.cost} onChange={(e) => setDelivery(delivery.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} />
                  </div>
                  {delivery.length > 1 ? <button className="x" onClick={() => setDelivery(delivery.filter((_, j) => j !== i))} aria-label={t("seller.remove")}>✕</button> : null}
                </div>
                <LocationCapture row={d} onSet={(lat, lng) => setDelivery(delivery.map((x, j) => j === i ? { ...x, latitude: lat, longitude: lng } : x))} />
                <DeliveryEstimateInputs row={d} index={i} error={errors[`delivery-estimate-${i}`]} onChange={(min, max) => setDelivery(delivery.map((x, j) => j === i ? { ...x, est_min: min, est_max: max } : x))} />
              </React.Fragment>
            ))}
            {delivery.length < 5 ? <button className="btn btn-sm btn-ghost" onClick={() => setDelivery([...delivery, { option_type: "delivery", label: "", cost: "0", latitude: null, longitude: null, est_min: productEstDefaults.min, est_max: productEstDefaults.max }])}>{t("seller.add_option")}</button> : null}
            </> : null}

            {dealType === "voucher" ? <>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="f-voucherFace">{t("seller.the_voucher_s_face_value")} <span className="req">*</span></label>
                  <input {...attention(errors, "voucherFace")} data-testid="voucher-face-value" dir="ltr" type="number" min={1} step="0.5" value={voucherFaceValue} onChange={(e) => setVoucherFaceValue(e.target.value)} />
                  <FieldError msg={errors.voucherFace} />
                </div>
                <div className="field">
                  <label htmlFor="f-voucherValid">{t("seller.valid_until")} <span className="req">*</span></label>
                  <input {...attention(errors, "voucherValid")} data-testid="voucher-valid-until" dir="ltr" type="date" value={voucherValidUntil} onChange={(e) => setVoucherValidUntil(e.target.value)} />
                  <FieldError msg={errors.voucherValid} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="f-voucherLocation">{t("seller.redemption_place")} <span className="req">*</span></label>
                <input {...attention(errors, "voucherLocation")} data-testid="voucher-location" value={redemptionLocation} onChange={(e) => setRedemptionLocation(e.target.value)} maxLength={500} placeholder={t("seller.at_business_s_branches_website")} />
                <FieldError msg={errors.voucherLocation} />
              </div>
              <div className="field">
                <label htmlFor="f-voucherInstructions">{t("seller.redemption_instructions")} <span className="req">*</span></label>
                <textarea {...attention(errors, "voucherInstructions")} data-testid="voucher-instructions" rows={3} value={redemptionInstructions} onChange={(e) => setRedemptionInstructions(e.target.value)} maxLength={1000} placeholder={t("seller.how_code_shown_redeemed")} />
                <FieldError msg={errors.voucherInstructions} />
              </div>
              <div className="field">
                <label htmlFor="f-voucherTerms">{t("seller.voucher_terms")} <span className="req">*</span></label>
                <textarea {...attention(errors, "voucherTerms")} data-testid="voucher-terms" rows={3} value={voucherTerms} onChange={(e) => setVoucherTerms(e.target.value)} maxLength={2000} placeholder={t("seller.limits_combining_offers_redemption_policy")} />
                <FieldError msg={errors.voucherTerms} />
              </div>
              <div className="notice info">{t("seller.the_voucher_code_issued_automatically")}</div>
            </> : null}

            {dealType === "ticket" ? <>
              <div className="field">
                <label htmlFor="f-eventName">{t("seller.event_name")} <span className="req">*</span></label>
                <input {...attention(errors, "eventName")} data-testid="ticket-event-name" value={eventName} onChange={(e) => setEventName(e.target.value)} maxLength={200} />
                <FieldError msg={errors.eventName} />
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="f-eventStart">{t("seller.starts")} <span className="req">*</span></label>
                  <input {...attention(errors, "eventStart")} data-testid="ticket-start" dir="ltr" type="datetime-local" value={eventStartsAt} onChange={(e) => setEventStartsAt(e.target.value)} />
                  <FieldError msg={errors.eventStart} />
                </div>
                <div className="field">
                  <label htmlFor="f-eventEnd">{t("seller.ends")} <span className="hint">{t("seller.optional")}</span></label>
                  <input {...attention(errors, "eventEnd")} dir="ltr" type="datetime-local" value={eventEndsAt} onChange={(e) => setEventEndsAt(e.target.value)} />
                  <FieldError msg={errors.eventEnd} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="f-venueName">{t("seller.event_venue")} <span className="req">*</span></label>
                  <input {...attention(errors, "venueName")} data-testid="ticket-venue" value={venueName} onChange={(e) => setVenueName(e.target.value)} maxLength={200} />
                  <FieldError msg={errors.venueName} />
                </div>
                <div className="field">
                  <label htmlFor="f-venueCity">{t("seller.city")} <span className="req">*</span></label>
                  <input {...attention(errors, "venueCity")} data-testid="ticket-city" value={venueCity} onChange={(e) => setVenueCity(e.target.value)} maxLength={100} />
                  <FieldError msg={errors.venueCity} />
                </div>
              </div>
              <div className="field"><label>{t("seller.address")}</label><input value={venueAddress} onChange={(e) => setVenueAddress(e.target.value)} maxLength={300} /></div>
              <div className="field">
                <label htmlFor="f-entry">{t("seller.entry_instructions")} <span className="req">*</span></label>
                <textarea {...attention(errors, "entry")} data-testid="ticket-entry" rows={3} value={entryInstructions} onChange={(e) => setEntryInstructions(e.target.value)} maxLength={1000} />
                <FieldError msg={errors.entry} />
              </div>
              <div className="field-row">
                <div className="field"><label>{t("seller.ticket_type")}</label><select value={ticketType} onChange={(e) => setTicketType(e.target.value)}><option value="general_admission">{t("seller.general_admission")}</option><option value="vip">VIP</option><option value="reserved_external">{t("seller.a_reserved_seat_external_system")}</option><option value="other">{t("seller.other")}</option></select></div>
                <div className="field"><label>{t("seller.seating")}</label><select value={seatMode} onChange={(e) => setSeatMode(e.target.value)}><option value="general_admission">{t("seller.no_reserved_seat")}</option><option value="external_seating">{t("seller.seating_external_system")}</option></select></div>
              </div>
              <label className="check"><input type="checkbox" checked={transferAllowed} onChange={(e) => setTransferAllowed(e.target.checked)} /><span>{t("seller.the_ticket_transferred_someone_else")}</span></label>
            </> : null}
          </>
        ) : null}

        {step === 3 ? (
          <>
            <DeadlinePicker
              date={deadlineDate} time={deadlineTime}
              onDate={(v) => setDeadlineDate(v)} onTime={(v) => setDeadlineTime(v)}
              error={errors.deadline || (deadlineDate && deadlineTime ? deadlineCheck.error : "")}
            />
            <div className="notice info">
              {t("seller.completion_window_charge_failures")} <b>{t("seller.x_24_hours")}</b>  {t("seller.the_system_default_c_ton")} <b>{t("seller.x_8_vat")}</b>  {t("seller.from_amount_actually_collected_only")}</div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h3>{t("seller.deal_summary")}</h3>
            {images.length ? (
              <div className="img-strip">
                {images.map((img, i) => (
                  <span key={img.id} className={`img-strip-thumb${i === 0 ? " primary" : ""}`}>
                    <img src={img.previewUrl} alt={img.name} />
                    {i === 0 ? <em>{t("seller.main")}</em> : null}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="kv" style={{ marginBottom: 14 }}>
              <span className="k">{t("seller.type")}</span><span className="v">{dealTypeLabel(dealType)}</span>
              <span className="k">{t("seller.name")}</span><span className="v">{title}</span>
              <span className="k">{t("seller.short_description")}</span><span className="v" style={{ fontWeight: 500 }}>{shortDesc}</span>
              <span className="k">{t("seller.price_per_unit_2")}</span><span className="v">{ils(priceNum)}</span>
              <span className="k">{t("seller.minimum")}</span><span className="v">{t("seller.minnum_units", { minNum: num(minNum) })}</span>
              <span className="k">{t("seller.maximum_stock")}</span><span className="v">{t("seller.maxnum_units", { maxNum: num(maxNum) })}</span>
              <span className="k">{t("seller.success_threshold_90")}</span><span className="v">{t("seller.threshold_charged_units", { threshold: num(threshold) })}</span>
              <span className="k">{t("seller.deadline")}</span><span className="v">{deadlineCheck.iso ? formatIsraelDateTime(deadlineCheck.iso) : "—"}</span>
              {product ? <><span className="k">{t("seller.product")}</span><span className="v">{t("seller.name_revision_v1", { name: product.name, v1: num(product.revision || 1) })}</span></> : null}
              {dealType === "physical_product" ? <><span className="k">{t("seller.fulfilment")}</span><span className="v">{delivery.filter((d) => d.label.trim()).map((d) => `${d.label}${estimateTextFor(d) ? ` (${estimateTextFor(d)})` : ""}`).join(" · ")}</span></> : null}
              {dealType === "voucher" ? <>
                <span className="k">{t("seller.voucher_value")}</span><span className="v">{ils(Number(voucherFaceValue))}</span>
                <span className="k">{t("seller.redemption")}</span><span className="v">{redemptionLocation}</span>
              </> : null}
              {dealType === "ticket" ? <>
                <span className="k">{t("seller.event")}</span><span className="v">{eventName}</span>
                <span className="k">{t("seller.place")}</span><span className="v">{venueName} · {venueCity}</span>
              </> : null}
              <span className="k">{t("seller.c_ton_fee")}</span><span className="v">{t("seller.x_8_vat_what_actually_collected")}</span>
            </div>
            <div className="notice info">
              {t("seller.the_deal_saved_draft_nothing")}</div>
          </>
        ) : null}

        {error ? <div className="notice err">{error}</div> : null}
        {uploadStatus ? <div className="notice info">{uploadStatus}</div> : null}
        <div className="wizard-nav">
          {step > 0 ? <button className="btn btn-ghost" onClick={() => { setErrors({}); setStep(step - 1); }}>{t("seller.back_2")}</button> : <span />}
          {step < 4
            ? <button data-testid="wizard-next" className="btn btn-primary" onClick={continueStep}>{t("seller.continue")}</button>
            : <button data-testid="wizard-save" className="btn btn-primary btn-lg" disabled={busy} onClick={save}>{busy ? (uploadStatus || t("seller.saving")) : t("seller.save_go_deal")}</button>}
        </div>
      </div>
    </div>
  );
}

// ── live/closed deal screen ────────────────────────────────────────────────
function whatHappensNow(deal: Json, chargedUnits: number): string {
  const state = String(deal.state);
  const joined = Number(deal.metrics?.joined_units ?? 0);
  const threshold = Number(deal.threshold_units || 0);
  switch (state) {
    case "PendingTarget":
      return joined >= threshold
        ? t("seller.if_ended_now_deal_would")
        : t("seller.if_deadline_arrived_now_deal", { joined: num(Math.max(0, threshold - joined)) });
    case "TargetReached": return t("seller.the_minimum_reached_deadline_early");
    case "ClosedForJoining":
      return String(deal.close_reason || "") === "manual"
        ? t("seller.joining_paused_request_buyer_charged")
        : t("seller.the_list_closed_system_preparing");
    case "ReadyForCharging": return t("seller.the_deal_locked_charges_start");
    case "Charging": return t("seller.the_charges_being_made_now");
    case "CompletionWindow":
      return chargedUnits >= threshold
        ? t("seller.the_90_threshold_already_been")
        : t("seller.if_completion_window_ended_now", { threshold: num(threshold), chargedUnits: num(chargedUnits) });
    case "Completed": return t("seller.the_deal_completed_start_fulfilling");
    case "Failed": return t("seller.the_deal_did_complete_every");
    case "Cancelled": return t("seller.the_deal_cancelled_authorizations_released");
    default: return "";
  }
}

// ── Draft edit panel (P0.2: the seller can actually edit the Draft) ────────
function DraftEditPanel({ deal, onSaved, showToast }: { deal: Json; onSaved: () => void; showToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(String(deal.title || ""));
  const [shortDesc, setShortDesc] = useState(String(deal.description_short || ""));
  const [longDesc, setLongDesc] = useState(String(deal.description || ""));
  const [price, setPrice] = useState(String(deal.price_per_unit ?? ""));
  const [listPrice, setListPrice] = useState(deal.list_price_per_unit == null ? "" : String(deal.list_price_per_unit));
  const [minUnits, setMinUnits] = useState(String(deal.min_units ?? ""));
  const [maxUnits, setMaxUnits] = useState(String(deal.max_units ?? ""));
  const initialParts = utcIsoToIsraelParts(deal.deadline);
  const [deadlineDate, setDeadlineDate] = useState(initialParts.date);
  const [deadlineTime, setDeadlineTime] = useState(initialParts.time || "18:00");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // P0.4-4 parity — type-specific terms are editable in Draft too
  const dealType = String(deal.deal_type || "physical_product");
  const vt = deal.voucher_terms || {};
  const tt = deal.ticket_terms || {};
  const [vFace, setVFace] = useState(String(vt.face_value_amount ?? ""));
  const [vValid, setVValid] = useState(vt.valid_until ? String(vt.valid_until).slice(0, 10) : "");
  const [vLocation, setVLocation] = useState(String(vt.redemption_location || ""));
  const [vInstructions, setVInstructions] = useState(String(vt.redemption_instructions || ""));
  const [vTerms, setVTerms] = useState(String(vt.terms || ""));
  const [tEventName, setTEventName] = useState(String(tt.event_name || ""));
  const [tStart, setTStart] = useState(tt.event_starts_at ? String(tt.event_starts_at).slice(0, 16) : "");
  const [tVenue, setTVenue] = useState(String(tt.venue_name || ""));
  const [tCity, setTCity] = useState(String(tt.venue_city || ""));
  const [tEntry, setTEntry] = useState(String(tt.entry_instructions || ""));

  // ROUND 2 (UX-2) — the edit form validates through ONE function, so the
  // pulsing marker can be re-evaluated live as the seller corrects a field
  // (same rule as the create wizard) instead of only on submit.
  const validateEdit = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = t("seller.enter_name_deal");
    if (!(Number(price) > 0)) errs.price = t("seller.enter_price_per_unit");
    if (listPrice.trim() && !(Number(listPrice) > Number(price))) errs.listPrice = t("seller.the_list_price_must_higher");
    if (!isPositiveIntegerText(minUnits)) errs.min = t("seller.enter_minimum_quantity");
    if (!isPositiveIntegerText(maxUnits) || !(Number(maxUnits) >= Number(minUnits))) errs.max = t("seller.the_maximum_quantity_must_least");
    const dl = validateDeadline(deadlineDate, deadlineTime);
    if (dl.error) errs.editDeadline = dl.error;
    if (dealType === "voucher") {
      if (!(Number(vFace) > 0)) errs.vFace = t("seller.enter_voucher_value");
      if (!vValid) errs.vValid = t("seller.choose_validity_period_voucher");
    }
    if (dealType === "ticket") {
      if (!tEventName.trim()) errs.tEventName = t("seller.enter_event_name");
      if (!tStart) errs.tStart = t("seller.choose_date_event");
    }
    return errs;
  };

  useEffect(() => {
    if (!Object.keys(errors).length) return;
    const settled = settleErrors(errors, validateEdit());
    if (!sameErrors(errors, settled)) setErrors(settled);
  });

  const save = async () => {
    if (busy) return;
    const errs = validateEdit();
    const minN = Number(minUnits), maxN = Number(maxUnits);
    const dl = validateDeadline(deadlineDate, deadlineTime);
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) { focusField(first === "editDeadline" ? "edit-deadline-date" : first); return; }
    setBusy(true);
    try {
      await api.updateDraft(String(deal.deal_id), {
        // 071 — a Product-backed Draft's name/copy are snapshot-owned (server 409s on them)
        ...(deal.product_id ? {} : { title: title.trim(), description: longDesc.trim(), description_short: shortDesc.trim() }),
        price_per_unit: Number(price),
        list_price_per_unit: listPrice.trim() ? Number(listPrice) : null,
        min_units: minN,
        max_units: maxN,
        deadline: dl.iso,
        ...(dealType === "voucher" ? {
          voucher_terms: {
            ...vt,
            face_value_amount: Number(vFace),
            currency: vt.currency || "ILS",
            valid_until: new Date(`${vValid}T23:59:59`).toISOString(),
            redemption_location: vLocation.trim(),
            redemption_instructions: vInstructions.trim(),
            terms: vTerms.trim(),
            is_single_use: vt.is_single_use ?? true,
            allow_partial_redemption: vt.allow_partial_redemption ?? false,
            voucher_code_mode: vt.voucher_code_mode || "system_generated"
          }
        } : {}),
        ...(dealType === "ticket" ? {
          ticket_terms: {
            ...tt,
            event_name: tEventName.trim(),
            event_starts_at: new Date(tStart).toISOString(),
            venue_name: tVenue.trim(),
            venue_city: tCity.trim(),
            entry_instructions: tEntry.trim()
          }
        } : {})
      });
      showToast(t("seller.the_draft_saved"));
      setOpen(false);
      onSaved();
    } catch (e: any) {
      showToast(e.message || t("seller.saving_failed"));
    }
    setBusy(false);
  };

  if (!open) {
    return (
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="panel-title" style={{ marginBottom: 0 }}>{t("seller.deal_details")}</div>
          <button className="btn btn-sm btn-ghost" data-testid="draft-edit-open" onClick={() => setOpen(true)}>{t("seller.edit_details")}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="panel-title">{t("seller.edit_deal_details")}</div>
      <div className="field">
        <label htmlFor="f-title">{t("seller.deal_name")} <span className="req">*</span></label>
        <input {...attention(errors, "title")} value={title} disabled={Boolean(deal.product_id)} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        {deal.product_id ? <span className="hint" data-testid="draft-product-locked">{t("seller.the_name_description_come_product")}</span> : null}
        <FieldError msg={errors.title} />
      </div>
      <div className="field">
        <label>{t("seller.short_description")} <span className="hint">{t("seller.up_200_characters")}</span></label>
        <input value={shortDesc} disabled={Boolean(deal.product_id)} onChange={(e) => setShortDesc(e.target.value)} maxLength={200} />
      </div>
      <div className="field">
        <label>{t("seller.full_description")}</label>
        <textarea rows={6} value={longDesc} disabled={Boolean(deal.product_id)} onChange={(e) => setLongDesc(e.target.value)} maxLength={4000} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="f-price">{t("seller.price_per_unit")} <span className="req">*</span></label>
          <input {...attention(errors, "price")} dir="ltr" type="number" min={1} step="0.5" value={price} onChange={(e) => setPrice(e.target.value)} />
          <FieldError msg={errors.price} />
        </div>
        <div className="field">
          <label htmlFor="f-listPrice">{t("seller.list_price")} <span className="hint">{t("seller.optional")}</span></label>
          <input {...attention(errors, "listPrice")} dir="ltr" type="number" min={1} step="0.5" value={listPrice} onChange={(e) => setListPrice(e.target.value)} />
          <FieldError msg={errors.listPrice} />
        </div>
        <div className="field">
          <label htmlFor="f-min">{t("seller.minimum_quantity")} <span className="req">*</span></label>
          <input {...attention(errors, "min")} {...QUANTITY_INPUT_ATTRS} value={minUnits} onChange={(e) => setMinUnits(e.target.value)} />
          <FieldError msg={errors.min} />
        </div>
        <div className="field">
          <label htmlFor="f-max">{t("seller.maximum_stock")} <span className="req">*</span></label>
          <input {...attention(errors, "max")} {...QUANTITY_INPUT_ATTRS} value={maxUnits} onChange={(e) => setMaxUnits(e.target.value)} />
          <FieldError msg={errors.max} />
        </div>
      </div>
      <DeadlinePicker idPrefix="edit-deadline" date={deadlineDate} time={deadlineTime} onDate={setDeadlineDate} onTime={setDeadlineTime} error={errors.editDeadline} />
      {dealType === "voucher" ? (
        <>
          <div className="section-title" style={{ margin: "12px 0 8px" }}>{t("seller.voucher_details")}</div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="f-vFace">{t("seller.face_value")} <span className="req">*</span></label>
              <input {...attention(errors, "vFace")} dir="ltr" type="number" min={1} value={vFace} onChange={(e) => setVFace(e.target.value)} />
              <FieldError msg={errors.vFace} />
            </div>
            <div className="field">
              <label htmlFor="f-vValid">{t("seller.valid_until")} <span className="req">*</span></label>
              <input {...attention(errors, "vValid")} dir="ltr" type="date" value={vValid} onChange={(e) => setVValid(e.target.value)} />
              <FieldError msg={errors.vValid} />
            </div>
          </div>
          <div className="field"><label>{t("seller.redemption_place")}</label><input value={vLocation} onChange={(e) => setVLocation(e.target.value)} maxLength={500} /></div>
          <div className="field"><label>{t("seller.redemption_instructions")}</label><textarea rows={2} value={vInstructions} onChange={(e) => setVInstructions(e.target.value)} maxLength={1000} /></div>
          <div className="field"><label>{t("seller.voucher_terms")}</label><textarea rows={2} value={vTerms} onChange={(e) => setVTerms(e.target.value)} maxLength={2000} /></div>
        </>
      ) : null}
      {dealType === "ticket" ? (
        <>
          <div className="section-title" style={{ margin: "12px 0 8px" }}>{t("seller.event_details")}</div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="f-tEventName">{t("seller.event_name")} <span className="req">*</span></label>
              <input {...attention(errors, "tEventName")} value={tEventName} onChange={(e) => setTEventName(e.target.value)} maxLength={200} />
              <FieldError msg={errors.tEventName} />
            </div>
            <div className="field">
              <label htmlFor="f-tStart">{t("seller.starts")} <span className="req">*</span></label>
              <input {...attention(errors, "tStart")} dir="ltr" type="datetime-local" value={tStart} onChange={(e) => setTStart(e.target.value)} />
              <FieldError msg={errors.tStart} />
            </div>
          </div>
          <div className="field-row">
            <div className="field"><label>{t("seller.event_venue")}</label><input value={tVenue} onChange={(e) => setTVenue(e.target.value)} maxLength={200} /></div>
            <div className="field"><label>{t("seller.city")}</label><input value={tCity} onChange={(e) => setTCity(e.target.value)} maxLength={100} /></div>
          </div>
          <div className="field"><label>{t("seller.entry_instructions")}</label><textarea rows={2} value={tEntry} onChange={(e) => setTEntry(e.target.value)} maxLength={1000} /></div>
        </>
      ) : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>{t("seller.cancel")}</button>
        <button className="btn btn-primary" data-testid="draft-edit-save" disabled={busy} onClick={save}>{busy ? t("seller.saving") : t("seller.save_changes")}</button>
      </div>
    </div>
  );
}

// ── delivery & pickup (P0.4-4): ALWAYS visible, safely editable ────────────
// The server decides editability (seller_actions.delivery_editable): Draft
// always; published only while ZERO buyers ever relied on the options. Locked
// deals still SHOW everything with an explicit explanation — never hidden.
const DELIVERY_TYPE_NAMES: Record<string, string> = { delivery: "seller.delivery_type_names.delivery", pickup: "seller.delivery_type_names.pickup", distribution_point: "seller.delivery_type_names.distribution_point" };

function mapsPlaceUrl(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function DeliverySection({ deal, options, editable, lockReason, onSaved, showToast }: {
  deal: Json;
  options: Json[];
  editable: boolean;
  lockReason: string | null;
  onSaved: () => void;
  showToast: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<DeliveryDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const dealType = String(deal.deal_type || "physical_product");
  const validateDelivery = () => {
    const errors: Record<string, string> = {};
    if (!rows.some(row => row.label.trim())) errors[rows.length ? "delivery-label-0" : "delivery-options"] = t("seller.at_least_one_delivery_option");
    else if (String(deal.state) !== "Draft") rows.forEach((row, index) => {
      if (row.label.trim() && !hasUsablePickupLocation(row)) errors[`delivery-label-${index}`] = t("seller.pickup_distribution_point_needs_address_2");
    });
    rows.forEach((row, index) => {
      if (!row.label.trim()) return;
      const estError = validateEstimateRange(row.est_min, row.est_max);
      if (estError) errors[`delivery-estimate-${index}`] = estError;
      else if (deal.product_id && (!row.est_min.trim() || !row.est_max.trim())) errors[`delivery-estimate-${index}`] = t("seller.a_deal_created_product_needs_2");
    });
    return errors;
  };
  useEffect(() => {
    const next = settleErrors(fieldErrors, validateDelivery());
    if (!sameErrors(fieldErrors, next)) setFieldErrors(next);
  });

  if (dealType !== "physical_product") {
    return (
      <div className="panel" data-testid="delivery-section">
        <div className="panel-title">{t("seller.delivery_shipping")}</div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {dealType === "voucher" ? t("seller.a_voucher_deal_redemption_digital") : t("seller.a_ticket_deal_entry_ticket")}
        </p>
      </div>
    );
  }

  const beginEdit = () => {
    setFieldErrors({});
    setRows((options || []).map((o) => ({
      option_type: String(o.option_type || "pickup"),
      label: String(o.label || ""),
      cost: String(Number(o.cost || 0)),
      latitude: o.latitude == null ? null : Number(o.latitude),
      longitude: o.longitude == null ? null : Number(o.longitude),
      est_min: o.estimated_min_business_days == null ? "" : String(o.estimated_min_business_days),
      est_max: o.estimated_max_business_days == null ? "" : String(o.estimated_max_business_days)
    })));
    setError("");
    setEditing(true);
  };

  const save = async () => {
    if (busy) return;
    const clean = rows.filter((r) => r.label.trim());
    const errors = validateDelivery();
    setFieldErrors(errors);
    const first = Object.keys(errors)[0];
    if (first) { focusField(first); return; }
    setBusy(true); setError("");
    try {
      await api.updateDealDelivery(String(deal.deal_id), {
        delivery_options: clean.map((r, i) => ({
          option_type: r.option_type, label: r.label.trim(), cost: Math.max(0, Number(r.cost) || 0), sort_order: i,
          ...(r.latitude != null && r.longitude != null ? { latitude: r.latitude, longitude: r.longitude } : {}),
          ...deliveryEstimatePayload(r)
        }))
      });
      showToast(t("seller.the_delivery_options_saved"));
      setEditing(false);
      onSaved();
    } catch (e: any) { setError(e.message || t("seller.saving_failed")); }
    setBusy(false);
  };

  return (
    <div className="panel" data-testid="delivery-section">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("seller.delivery_shipping")}</div>
        {editable && !editing ? (
          <button className="btn btn-sm btn-ghost" data-testid="delivery-edit-open" onClick={beginEdit}>{t("seller.edit")}</button>
        ) : null}
      </div>

      {!editable ? (
        <p className="muted small" style={{ margin: "8px 0 0" }} data-testid="delivery-locked-note">
          {lockReason === "buyer_reliance"
            ? t("seller.this_detail_cannot_changed_once")
            : lockReason === "deal_state"
              ? t("seller.this_detail_cannot_changed_deal")
              : t("seller.this_detail_cannot_changed_once_2")}
        </p>
      ) : null}

      {!editing ? (
        (options || []).length ? (
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {(options || []).map((o) => {
              const nav = mapsPlaceUrl(o.latitude == null ? null : Number(o.latitude), o.longitude == null ? null : Number(o.longitude));
              return (
                <div className="delivery-view-row" key={String(o.option_id)}>
                  <span className="ico" aria-hidden="true" data-option-type={String(o.option_type)} />
                  <span className="grow">
                    <b>{tKey(DELIVERY_TYPE_NAMES[String(o.option_type)], o.option_type)}</b> — {o.label}
                    {isPickupOptionType(o.option_type) ? (
                      hasUsablePickupLocation(o) ? (
                        <span className="pickup-loc" data-testid="seller-pickup-location"> · {pickupLocationText(o) || `${Number(o.latitude).toFixed(4)}, ${Number(o.longitude).toFixed(4)}`}
                          <span className={`small ${pickupPrecision(o) === "exact" ? "muted" : "pickup-precision-warn"}`} data-testid={`pickup-precision-${pickupPrecision(o)}`}> · {PICKUP_PRECISION_COPY[pickupPrecision(o)]}</span>
                        </span>
                      ) : (
                        <span className="pickup-missing" data-testid="pickup-location-missing">  {t("seller.a_pickup_address_location_missing")}</span>
                      )
                    ) : null}
                  </span>
                  <span className="delivery-cost">{Number(o.cost) ? ils(o.cost) : t("seller.free")}</span>
                  {deliveryEstimateText(o) ? <span className="muted small" data-testid="seller-delivery-estimate">{deliveryEstimateText(o)}</span> : null}
                  {nav ? <a className="btn btn-sm btn-ghost" href={nav} target="_blank" rel="noreferrer">{t("seller.show_map")}</a> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted small" style={{ margin: "8px 0 0" }}>{t("seller.no_delivery_options_been_set")}</p>
        )
      ) : (
        <div className="stack" style={{ gap: 4, marginTop: 10 }}>
          {rows.map((d, i) => (
            <React.Fragment key={i}>
              <div className="row" style={{ marginBottom: 6, alignItems: "flex-end" }}>
                <div className="field" style={{ marginBottom: 0, flex: "1 1 120px" }}>
                  <label>{t("seller.type")}</label>
                  <select value={d.option_type} onChange={(e) => {
                    const t = e.target.value;
                    setRows(rows.map((x, j) => j === i ? { ...x, option_type: t, ...(t === "delivery" ? { latitude: null, longitude: null } : {}) } : x));
                  }}>
                    <option value="pickup">{t("seller.pickup")}</option>
                    <option value="delivery">{t("seller.delivery")}</option>
                    <option value="distribution_point">{t("seller.distribution_point")}</option>
                  </select>
                </div>
                <div className="field grow" style={{ marginBottom: 0, flex: "2 1 160px" }}>
                  <label>{isPickupOptionType(d.option_type) ? t("seller.pickup_address_location") : t("seller.description")}</label>
                  <input {...attention(fieldErrors, `delivery-label-${i}`)} aria-label={isPickupOptionType(d.option_type) ? t("seller.pickup_address_location") : t("seller.delivery_description")} value={d.label} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder={isPickupOptionType(d.option_type) ? t("seller.for_example_12_herzl_st") : t("seller.for_example_courier_delivery_door")} />
                  <FieldError msg={fieldErrors[`delivery-label-${i}`]} />
                </div>
                <div className="field" style={{ marginBottom: 0, flex: "1 1 90px" }}>
                  <label>{t("seller.cost")}</label>
                  <input dir="ltr" type="number" min={0} value={d.cost} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} />
                </div>
                {rows.length > 1 ? <button className="x" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t("seller.remove")}>✕</button> : null}
              </div>
              <LocationCapture row={d} onSet={(lat, lng) => setRows(rows.map((x, j) => j === i ? { ...x, latitude: lat, longitude: lng } : x))} />
              <DeliveryEstimateInputs row={d} index={i} error={fieldErrors[`delivery-estimate-${i}`]} onChange={(min, max) => setRows(rows.map((x, j) => j === i ? { ...x, est_min: min, est_max: max } : x))} />
            </React.Fragment>
          ))}
          {rows.length < 5 ? (
            <button {...attention(fieldErrors, "delivery-options", "btn btn-sm btn-ghost")} style={{ alignSelf: "flex-start" }}
              onClick={() => setRows([...rows, { option_type: "delivery", label: "", cost: "0", latitude: null, longitude: null, est_min: "", est_max: "" }])}>
              {t("seller.add_option")}</button>
          ) : null}
          <FieldError msg={fieldErrors["delivery-options"]} />
          {error ? <div className="notice err">{error}</div> : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>{t("seller.cancel")}</button>
            <button className="btn btn-primary" data-testid="delivery-save" disabled={busy} onClick={save}>{busy ? t("seller.saving") : t("seller.save_delivery_options")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 071 — Product association: which Product (and revision) this Deal froze,
// or, for a Draft without a Product, the one-tap "save as Product" promotion.
function ProductLinkPanel({ deal, isDraft, onChanged, showToast, navigate }: { deal: Json; isDraft: boolean; onChanged: () => void; showToast: (m: string) => void; navigate: (h: string) => void }) {
  const [busy, setBusy] = useState(false);
  const snapshot = deal.product_snapshot as Json | null;
  if (deal.product_id) {
    return (
      <div className="panel" data-testid="product-link-panel" data-product-id={String(deal.product_id)}>
        <div className="panel-title">{t("seller.the_product_library_2")}</div>
        <p className="muted small" style={{ margin: 0 }}>
          {t("seller.deal_from_product_prefix")} <a href={`#/seller/products/${deal.product_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/products/${deal.product_id}`); }}><b>{snapshot?.name || deal.title}</b></a>
          {snapshot?.product_revision ? <> {t("seller.revision_product_revision", { product_revision: num(snapshot.product_revision) })}</> : null}{t("seller.deal_from_product_suffix")}
        </p>
      </div>
    );
  }
  if (!isDraft) return null;
  const promote = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.promoteDealToProduct(String(deal.deal_id));
      showToast(t("seller.the_draft_saved_product_library"));
      onChanged();
      if (r?.product?.product_id) navigate(`#/seller/products/${r.product.product_id}`);
    } catch (e: any) { showToast(e.message || t("seller.saving_product_failed")); }
    setBusy(false);
  };
  return (
    <div className="panel" data-testid="product-link-panel" data-product-id="">
      <div className="panel-title">{t("seller.save_product_library")}</div>
      <p className="muted small">{t("seller.save_draft_s_details_images")}</p>
      <button className="btn btn-sm btn-ghost" data-testid="deal-promote-product" disabled={busy} onClick={() => void promote()}>{busy ? t("seller.saving") : t("seller.save_product")}</button>
    </div>
  );
}

// ── type-specific terms (P0.4-4 parity): always VIEWABLE on management ─────
function TypeTermsPanel({ deal }: { deal: Json }) {
  const dealType = String(deal.deal_type || "physical_product");
  if (dealType === "voucher" && deal.voucher_terms) {
    const v = deal.voucher_terms;
    return (
      <div className="panel" data-testid="type-terms">
        <div className="panel-title">{t("seller.voucher_details")}</div>
        <div className="kv">
          <span className="k">{t("seller.face_value_2")}</span><span className="v">{ils(v.face_value_amount)}</span>
          <span className="k">{t("seller.valid_until")}</span><span className="v">{fmtDate(v.valid_until)}</span>
          <span className="k">{t("seller.redemption_place")}</span><span className="v">{v.redemption_location || "—"}</span>
          <span className="k">{t("seller.redemption_instructions")}</span><span className="v" style={{ fontWeight: 500 }}>{v.redemption_instructions || "—"}</span>
          <span className="k">{t("seller.terms")}</span><span className="v" style={{ fontWeight: 500 }}>{v.terms || "—"}</span>
        </div>
        {String(deal.state) === "Draft" ? (
          <p className="muted small" style={{ margin: "10px 0 0" }}>{t("seller.the_voucher_details_edited_while")}</p>
        ) : (
          <p className="muted small" style={{ margin: "10px 0 0" }}>{t("seller.the_voucher_terms_cannot_changed")}</p>
        )}
      </div>
    );
  }
  if (dealType === "ticket" && deal.ticket_terms) {
    const t = deal.ticket_terms;
    return (
      <div className="panel" data-testid="type-terms">
        <div className="panel-title">{t("seller.event_details")}</div>
        <div className="kv">
          <span className="k">{t("seller.event")}</span><span className="v">{t.event_name || "—"}</span>
          <span className="k">{t("seller.starts_2")}</span><span className="v">{fmtDate(t.event_starts_at)}</span>
          {t.event_ends_at ? (<><span className="k">{t("seller.ends_2")}</span><span className="v">{fmtDate(t.event_ends_at)}</span></>) : null}
          <span className="k">{t("seller.place")}</span><span className="v">{[t.venue_name, t.venue_city].filter(Boolean).join(" · ") || "—"}</span>
          {t.venue_address ? (<><span className="k">{t("seller.address")}</span><span className="v">{t.venue_address}</span></>) : null}
          <span className="k">{t("seller.entry_instructions")}</span><span className="v" style={{ fontWeight: 500 }}>{t.entry_instructions || "—"}</span>
          <span className="k">{t("seller.ticket_transfer")}</span><span className="v">{t.transfer_allowed ? t("seller.allowed") : t("seller.not_allowed")}</span>
        </div>
        {String(deal.state) === "Draft" ? (
          <p className="muted small" style={{ margin: "10px 0 0" }}>{t("seller.the_event_details_edited_while")}</p>
        ) : (
          <p className="muted small" style={{ margin: "10px 0 0" }}>{t("seller.the_event_details_cannot_changed")}</p>
        )}
      </div>
    );
  }
  return null;
}

// ── seller PROPAGATION tree (P0.5-2): SAME canonical engine, own deal only ──
function SellerViralTreePage({ dealId, navigate }: { dealId: string; navigate: (h: string) => void }) {
  const [title, setTitle] = useState("");
  useEffect(() => {
    api.sellerDeal(dealId).then((r) => setTitle(String(r.deal?.title || ""))).catch(() => undefined);
  }, [dealId]);
  return (
    <>
      <a className="back" href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>{t("seller.to_deal")}</a>
      <div className="panel">
        <div className="panel-title">{t("seller.distribution_tree_v0", { v0: title || t("seller.my_deal") })}</div>
        <PropagationTree
          dealId={dealId}
          dealTitle={title}
          fetchers={{ fetchPropagation: api.sellerDealPropagation, fetchLevel: api.sellerDealViralTree }}
        />
      </div>
    </>
  );
}

// ── publish flow (P0.2-H): readiness checklist + exact blockers, no silence ─
function PublishModal(props: { deal: Json; onClose: () => void; onPublished: () => void }) {
  const { deal } = props;
  const [ack1, setAck1] = useState(false);
  const [ack2, setAck2] = useState(false);
  const [attentionRequested, setAttentionRequested] = useState(false);
  const consentErrors: Record<string, string> = {};
  if (attentionRequested && !ack1) consentErrors["publish-terms"] = "required";
  if (attentionRequested && !ack2) consentErrors["publish-threshold"] = "required";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const images: Json[] = deal.images || [];
  const deliveryOptions: Json[] = deal.delivery_options || [];
  const threshold = Math.ceil(0.9 * Number(deal.min_units || 0));
  const deadlineMs = Date.parse(String(deal.deadline || ""));
  const isPhysical = String(deal.deal_type || "physical_product") === "physical_product";

  const checks: { label: string; ok: boolean; blocker: string | null }[] = [
    { label: t("seller.name_price"), ok: Boolean(String(deal.title || "").trim()) && Number(deal.price_per_unit) > 0, blocker: t("seller.the_deal_missing_name_price") },
    { label: t("seller.target_quantities"), ok: Number(deal.min_units) >= 1 && Number(deal.max_units) >= Number(deal.min_units), blocker: t("seller.fill_both_minimum_maximum_quantity") },
    {
      label: t("seller.a_future_deadline"),
      ok: Number.isFinite(deadlineMs) && deadlineMs - Date.now() > 30 * 60_000,
      blocker: t("seller.the_deadline_passed_too_close")
    },
    { label: t("seller.main_image"), ok: images.length > 0, blocker: t("seller.upload_least_one_image") },
    ...(isPhysical ? [{ label: t("seller.delivery_option"), ok: deliveryOptions.length > 0, blocker: t("seller.add_least_one_delivery_option") }] : []),
    // P0.7 — the same pickup rule the server enforces at publish
    ...(isPhysical && deliveryOptions.some((o) => isPickupOptionType(o.option_type))
      ? [{ label: t("seller.pickup_location"), ok: deliveryOptions.every((o) => hasUsablePickupLocation(o)), blocker: t("seller.pickup_distribution_point_missing_address") }]
      : [])
  ];
  const blockers = checks.filter((c) => !c.ok).map((c) => c.blocker!).filter(Boolean);
  const ready = blockers.length === 0;

  const publish = async () => {
    if (busy) return;
    if (!ack1 || !ack2) { setAttentionRequested(true); setError(t("seller.both_conditions_must_accepted_before")); focusField(!ack1 ? "publish-terms" : "publish-threshold"); return; }
    setBusy(true); setError("");
    try {
      await api.publishDeal(String(deal.deal_id));
      props.onPublished();
    } catch (e: any) {
      setError(e.message || t("seller.publishing_failed_try_again"));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("seller.publish_deal")}
      onClose={props.onClose}
      footer={
        <>
          {error ? <div className="notice err" style={{ marginTop: 0 }}>{error}</div> : null}
          {!ready ? (
            <div className="notice err" style={{ marginTop: 0 }}>
              <b>{t("seller.not_ready_publish_yet")}</b>
              <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          ) : null}
          <button className="btn btn-join btn-block" data-testid="publish-confirm" disabled={busy || !ready} onClick={publish}>
            {busy ? t("seller.publishing") : t("seller.publish_deal")}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("seller.just_before_deal_goes_live")}</p>
      <div className="publish-checklist">
        {checks.map((c) => (
          <div key={c.label} className={`publish-check${c.ok ? " ok" : " missing"}`}>
            <span>{c.ok ? "✓" : "•"}</span> {c.label}
          </div>
        ))}
      </div>
      <div className="kv" style={{ margin: "14px 0" }}>
        <span className="k">{t("seller.price_per_unit_2")}</span><span className="v">{ils(deal.price_per_unit)}</span>
        {Number(deal.list_price_per_unit) > Number(deal.price_per_unit) ? <>
          <span className="k">{t("seller.list_price_shown_saving")}</span><span className="v">{t("seller.list_price_per_unit_saving", { list_price_per_unit: ils(deal.list_price_per_unit), v1: Math.round((1 - Number(deal.price_per_unit) / Number(deal.list_price_per_unit)) * 100) })}</span>
        </> : null}
        <span className="k">{t("seller.target_minimum")}</span><span className="v">{t("seller.min_units_units", { min_units: num(deal.min_units) })}</span>
        <span className="k">{t("seller.success_threshold_90")}</span><span className="v">{t("seller.threshold_charged_units", { threshold: num(threshold) })}</span>
        <span className="k">{t("seller.deadline")}</span><span className="v">{formatIsraelDateTime(deal.deadline) || "—"}</span>
      </div>
      <div className="publish-warning">
        <label className="check">
          <input {...attention(consentErrors, "publish-terms")} data-testid="publish-lock-terms" type="checkbox" checked={ack1} onChange={(e) => { setAck1(e.target.checked); setError(""); }} />
          <span>{t("seller.i_read_understood_after_publishing")} <b>{t("seller.cannot_changed")}</b>  {t("seller.price_quantities_deadline_fees")}</span>
        </label>
        <label className="check" style={{ marginBottom: 0 }}>
          <input {...attention(consentErrors, "publish-threshold")} data-testid="publish-lock-threshold" type="checkbox" checked={ack2} onChange={(e) => { setAck2(e.target.checked); setError(""); }} />
          <span>{t("seller.i_confirm_terms_final_including", { threshold: num(threshold) })}</span>
        </label>
      </div>
    </Modal>
  );
}

function SellerDealScreen({ dealId, navigate }: { dealId: string; navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [viral, setViral] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reopening, setReopening] = useState(false);
  // LAUNCH POLISH (P2) — permanent cancellation. ONE intent key per opened
  // confirmation: a double-click or a retry replays the same server operation.
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelRefusal, setCancelRefusal] = useState("");
  const cancelIntentKey = useRef("");
  const [toast, showToast] = useToast();

  const load = () => api.sellerDeal(dealId).then(setPayload).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    api.sellerDealViral(dealId).then(setViral).catch(() => undefined);
    return () => clearInterval(id);
  }, [dealId]);

  if (error) return <EmptyState title={t("seller.the_deal_cannot_loaded")} body={error} />;
  if (!payload?.deal) return <BrandLoader label={t("seller.loading_deal")} minHeight={420} />;

  const deal = payload.deal;
  // delivery options come as a sibling collection on this endpoint
  if (!deal.delivery_options) deal.delivery_options = payload.delivery_options || [];
  const state = String(deal.state);
  const participants: Json[] = payload.participants || [];
  const chargedRows = participants.filter((p) => ["ChargedSuccess", "RecoveredCharge"].includes(String(p.money_state)));
  const pendingRows = participants.filter((p) => String(p.money_state) === "ChargeFailedRecovery");
  const droppedRows = participants.filter((p) => ["Dropped", "DealFailed"].includes(String(p.buyer_state)) || String(p.money_state) === "AuthReleased");
  const chargedUnits = chargedRows.reduce((s, p) => s + Number(p.qty || 0), 0);
  const pendingUnits = pendingRows.reduce((s, p) => s + Number(p.qty || 0), 0);
  const droppedUnits = droppedRows.reduce((s, p) => s + Number(p.qty || 0), 0);
  const joined = Number(deal.metrics?.joined_units ?? participants.reduce((s, p) => s + Number(p.qty || 0), 0));
  const isOpen = OPEN_STATES.includes(state);
  const isDraft = state === "Draft";
  const closed = CLOSED_STATES.includes(state);
  const inWindow = state === "CompletionWindow";
  const gross = chargedRows.reduce((s, p) => s + Number(p.qty) * Number(deal.price_per_unit) + Number(p.delivery_cost || 0), 0);
  const fee = Math.round(gross * 0.08 * 100) / 100;
  const vm = viral?.metrics as Json | null;
  const deletable = isDraft || (isOpen && participants.length === 0);
  // P0.3-14 — a MANUAL close is a reversible pause (deadline still ahead,
  // capacity not full, nothing charged); deadline/capacity/system closes are not.
  const paused = state === "ClosedForJoining" && String(deal.close_reason || "") === "manual";
  const canReopen = paused
    && Date.parse(String(deal.deadline || "")) > Date.now()
    && joined < Number(deal.max_units || 0);

  const reopen = async () => {
    if (reopening) return;
    setReopening(true);
    try {
      await api.reopenJoining(dealId);
      showToast(t("seller.joining_been_reopened"));
      await load();
    } catch (e: any) { showToast(e.message || t("seller.reopening_failed")); }
    setReopening(false);
  };

  return (
    <>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("seller.to_dashboard")}</a>

      {paused ? (
        <div className="paused-banner" data-testid="paused-banner">
          <div>
            <b>{t("seller.joining_paused")}</b>
            <div className="small">
              {t("seller.paused_joining_note")}{" "}
              {canReopen ? t("seller.it_reopened_long_deadline_passed") : t("seller.the_deadline_passed_stock_run")}
            </div>
          </div>
          {canReopen ? (
            <button className="btn btn-primary" data-testid="reopen-joining" disabled={reopening} onClick={reopen}>
              {reopening ? t("seller.opening") : t("seller.reopen_joining")}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Draft: impossible-to-miss banner + dominant publish CTA (P0.2-G/H) */}
      {isDraft ? (
        <div className="draft-banner" data-testid="draft-banner">
          <div>
            <b>{t("seller.draft_deal_published_yet")}</b>
            <div className="small">{t("seller.buyers_cannot_see_when_everything")}</div>
          </div>
          <button className="btn btn-join" data-testid="publish-open" onClick={() => setPublishing(true)}>{t("seller.publish_deal")}</button>
        </div>
      ) : null}

      {/* LAUNCH POLISH (P3) — where this deal is on the path, in one glance */}
      <SellerJourney deal={deal} title={t("seller.how_does_deal_work")} />

      {/* constant header: name, image, big colored status */}
      <div className="panel">
        <div className="sd-top">
          <div className="sd-thumb">{deal.images?.[0]?.url ? <img src={deal.images[0].url} alt="" /> : <span className="sd-thumb-type">{dealTypeLabel(String(deal.deal_type || "physical_product"))}</span>}</div>
          <div className="grow">
            <h1 style={{ margin: 0, fontSize: "1.3rem" }}>{deal.title}</h1>
            <div className="row">
              <StatusPill state={state} />
              <span className="muted small">{dealTypeLabel(String(deal.deal_type || "physical_product"))}</span>
            </div>
          </div>
        </div>

        {/* P0.3-13 — the status stands alone above; the countdown lives in its
            own labeled block, never fused into the status sentence. */}
        {inWindow || state === "Charging" ? (
          <div className="seller-countdown-block">
            <span className="lbl">{t("seller.the_completion_window_ends")}</span>
            <LiveCountdown deadline={deal.completion_window_until} compact />
          </div>
        ) : isOpen ? (
          <div className="seller-countdown-block" data-testid="seller-countdown">
            <span className="lbl">{t("seller.joining_ends")}</span>
            <LiveCountdown deadline={deal.deadline} compact />
          </div>
        ) : null}

        {!isDraft ? (
          <div style={{ margin: "18px 0 8px" }}>
            <GroupMeter large joined={joined} threshold={Number(deal.threshold_units)} max={Number(deal.max_units)} showFlag />
          </div>
        ) : null}

        {!isDraft ? (
          <div className="sd-quants" style={{ fontSize: "1rem", marginTop: 12 }}>
            <span className="q-charged">{t("seller.charged_successfully_chargedunits", { chargedUnits: num(chargedUnits) })}</span>
            <span className={`q-pending${inWindow ? " risk" : ""}`}>{inWindow ? t("seller.awaiting_final_approval") : t("seller.pending")}: {num(pendingUnits)}</span>
            <span className="q-none">{t("seller.not_charged_droppedunits", { droppedUnits: num(droppedUnits) })}</span>
          </div>
        ) : null}
        {inWindow && pendingRows.length ? (
          <p className="small" style={{ color: "var(--saffron)", marginTop: 6 }}>
            {t("seller.a_message_sent_length_buyers", { length: num(pendingRows.length) })}</p>
        ) : null}

        {!isDraft ? (
          <div className="notice info" style={{ marginTop: 14 }}>
            <b>{t("seller.what_happens_now")}</b> {whatHappensNow(deal, chargedUnits)}
          </div>
        ) : (
          <div className="kv" style={{ marginTop: 14 }}>
            <span className="k">{t("seller.price_per_unit_2")}</span><span className="v">{ils(deal.price_per_unit)}</span>
            <span className="k">{t("seller.target_minimum")}</span><span className="v">{t("seller.min_units_units", { min_units: num(deal.min_units) })}</span>
            <span className="k">{t("seller.deadline")}</span><span className="v">{formatIsraelDateTime(deal.deadline) || "—"}</span>
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          {isOpen ? (
            <>
              <button className="btn btn-primary" onClick={async () => {
                if (await copyText(absoluteShareUrl(dealId, null))) showToast(t("seller.link_copied"));
              }}>{t("seller.share_link")}</button>
              <a className="btn btn-ghost" href={`#/deal/${dealId}`} target="_blank">{t("seller.view_public_page")}</a>
              <button className="btn btn-ghost" data-testid="pause-joining-open" onClick={() => setConfirmClose(true)}>{t("seller.pause_joining")}</button>
            </>
          ) : isDraft ? (
            <a className="btn btn-ghost" data-testid="draft-preview-open" href={`#/seller/deal/${dealId}/preview`} target="_blank">{t("seller.preview_buyer")}</a>
          ) : closed ? (
            <>
              {/* LAUNCH SPRINT 3 — a completed physical deal is now an operational
                  handoff queue: the list + the counter scanner come first */}
              {state === "Completed" && String(deal.deal_type || "physical_product") === "physical_product" ? (
                <>
                  <button className="btn btn-primary" data-testid="deal-fulfillment-open" onClick={() => navigate(`#/seller/deal/${dealId}/fulfillment`)}>{t("seller.orders_hand_over")}</button>
                  <button className="btn btn-ghost" data-testid="deal-pickup-scan" onClick={() => navigate("#/seller/pickup")}>{t("seller.pickup_scan")}</button>
                </>
              ) : null}
              <button className="btn btn-ghost" onClick={async () => {
                try {
                  const r = await api.duplicateDeal(dealId);
                  const newId = r?.deal?.deal_id || r?.deal_id;
                  if (newId) { showToast(t("seller.a_draft_created_dates_must")); navigate(`#/seller/deal/${newId}`); }
                } catch (e: any) { showToast(e.message || t("seller.duplicating_failed")); }
              }}>{t("seller.create_similar_deal")}</button>
            </>
          ) : (
            <span className="muted small">{t("seller.the_deal_locked_viewing_only")}</span>
          )}
          {deletable ? (
            <button className="btn btn-ghost btn-danger-ghost" data-testid="deal-delete-open" onClick={() => setConfirmDelete(true)}>{t("seller.delete_deal_2")}</button>
          ) : null}
          {/* LAUNCH POLISH (P2) — visible, not prominent: ghost + last in the row.
              Offered for every non-terminal, pre-charging state; the SERVER
              decides (Draft only today — a live deal is refused with a clear
              explanation and the pause alternative). Never shown once money
              may be moving (ReadyForCharging/Charging/CompletionWindow). */}
          {(isDraft || isOpen || paused) && !closed ? (
            <button className="btn btn-sm btn-ghost btn-danger-ghost" data-testid="deal-cancel-open" style={{ marginInlineStart: "auto" }}
              onClick={() => { cancelIntentKey.current = crypto.randomUUID(); setCancelRefusal(""); setConfirmCancel(true); }}>
              {t("seller.cancel_deal")}</button>
          ) : null}
        </div>
      </div>

      {isDraft ? <DraftEditPanel deal={deal} onSaved={load} showToast={showToast} /> : null}

      {/* P0.4-4 — delivery/pickup: ALWAYS visible; editability decided server-side */}
      <DeliverySection
        deal={deal}
        options={payload.delivery_options || deal.delivery_options || []}
        editable={Boolean(payload.seller_actions?.delivery_editable)}
        lockReason={payload.seller_actions?.delivery_lock_reason || null}
        onSaved={load}
        showToast={showToast}
      />
      <TypeTermsPanel deal={deal} />
      <ProductLinkPanel deal={deal} isDraft={isDraft} onChanged={load} showToast={showToast} navigate={navigate} />
      <ReceiptEditor dealId={dealId} state={String(deal.state)} />

      {isDraft ? (
        <div className="panel">
          <div className="panel-title">{t("seller.the_deal_s_images")}</div>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("seller.adding_deleting_only_possible_draft")}</p>
          <DraftImageManager
            dealId={dealId}
            images={(deal.images || []) as ServerImage[]}
            onChanged={load}
          />
        </div>
      ) : isOpen ? (
        <div className="panel">
          <div className="panel-title">{t("seller.image_order_main_image")}</div>
          <DraftImageManager
            dealId={dealId}
            images={(deal.images || []) as ServerImage[]}
            onChanged={load}
            arrangeOnly
          />
        </div>
      ) : null}

      {closed && state === "Completed" ? (
        <div className="panel">
          <div className="panel-title">{t("seller.money_based_charges_actually_made")}</div>
          <div className="stat-row" style={{ marginBottom: 0 }}>
            <StatTile num={ils(gross)} label={t("seller.gross_collected")} tone="good" />
            <StatTile num={ils(fee)} label={t("seller.c_ton_fee_8")} />
            <StatTile num={ils(Math.round((gross - fee * 1.18) * 100) / 100)} label={t("seller.estimated_net_seller")} sub={t("seller.expected_transfer_within_3_7")} />
            <StatTile num={num(chargedUnits)} label={t("seller.charged_units")} />
          </div>
        </div>
      ) : null}

      {closed || inWindow || state === "Charging" ? (
        <div className="panel">
          <div className="panel-title">{t("seller.buyers_panel_title", { suffix: state === "Completed" ? t("seller.finally_charged") : "" })}</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t("seller.buyer")}</th><th>{t("seller.phone")}</th><th className="num">{t("seller.quantity")}</th><th>{t("seller.how_receive")}</th><th>{t("seller.payment_state")}</th></tr></thead>
              <tbody>
                {(state === "Completed" ? chargedRows : participants).slice(0, 100).map((p) => (
                  <tr key={p.participant_id}>
                    <td>{p.buyer_name || "—"}</td>
                    <td dir="ltr">{p.buyer_phone || p.buyer_id}</td>
                    <td className="num">{num(p.qty)}</td>
                    <td>{p.delivery_method_label || "—"}</td>
                    <td><span className={`status ${["ChargedSuccess", "RecoveredCharge"].includes(String(p.money_state)) ? "Completed" : String(p.money_state) === "ChargeFailedRecovery" ? "CompletionWindow" : "ClosedForJoining"}`}>{moneyStateLabel(String(p.money_state))}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state === "Completed" ? (
            <div className="row" style={{ marginTop: 10 }}>
              {String(deal.deal_type || "physical_product") === "physical_product" ? (
                <button className="btn btn-sm btn-primary" data-testid="buyers-fulfillment-open" onClick={() => navigate(`#/seller/deal/${dealId}/fulfillment`)}>{t("seller.orders_hand_over")}</button>
              ) : null}
              <a className="btn btn-sm btn-ghost" href={`/api/seller/deals/${dealId}/export.xlsx`} target="_blank">{t("seller.download_delivery_list_excel")}</a>
            </div>
          ) : null}
        </div>
      ) : null}

      {!isDraft ? (
        <DistributionPanel dealId={dealId} dealTitle={String(deal.title || "")} dealOpen={isOpen} navigate={navigate} />
      ) : null}

      {!isDraft ? (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div className="panel-title" style={{ marginBottom: 0 }}>{t("seller.viral_distribution_deal")}</div>
            <button className="btn btn-sm btn-primary" data-testid="open-viral-tree" onClick={() => navigate(`#/seller/deal/${dealId}/viral`)}>
              {t("seller.open_viral_tree")}</button>
          </div>
          {vm ? (
            <>
              <div className="stat-row" style={{ marginBottom: 10 }}>
                <StatTile num={num((vm.viral as Json)?.attributed_participants || 0)} label={t("seller.joins_through_sharing")} />
                <StatTile num={num((vm.viral as Json)?.attributed_charged_units || 0)} label={t("seller.units_charged_distribution")} tone="good" />
                <StatTile num={ils((vm.viral as Json)?.attributed_charged_gmv || 0)} label={t("seller.charged_gross_distribution")} />
                <StatTile num={num((vm.viral as Json)?.max_generation || 0)} label={t("seller.chain_depth_generations")} />
                <StatTile num={num((vm.viral as Json)?.sharing_participants || 0)} label={t("seller.participants_who_brought_friends")} />
              </div>
              {(vm.top_sharers as Json[])?.length ? (
                <>
                  <div className="section-title" style={{ margin: "10px 0 8px" }}>{t("seller.top_personal_distributors")}</div>
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>{t("seller.participant")}</th><th className="num">{t("seller.brought_directly")}</th><th className="num">{t("seller.across_branch")}</th><th className="num">{t("seller.charged_units")}</th><th className="num">{t("seller.depth")}</th></tr></thead>
                      <tbody>
                        {(vm.top_sharers as Json[]).slice(0, 8).map((s) => (
                          <tr key={s.participant_id}>
                            <td>{s.display}</td>
                            <td className="num">{num(s.direct_children)}</td>
                            <td className="num">{num(s.subtree_joins)}</td>
                            <td className="num">{num(s.subtree_charged_units)}</td>
                            <td className="num">{num(s.max_depth)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : <p className="muted small">{t("seller.no_share_brought_join_yet")}</p>}
              {viral?.stale ? <p className="muted small" style={{ marginTop: 8 }}>{t("seller.the_figures_computed_background_updated", { computed_at: fmtDate(viral.computed_at) })}</p> : null}
            </>
          ) : <p className="muted small">{t("seller.the_distribution_figures_computed_after")}</p>}
        </div>
      ) : null}

      {publishing ? (
        <PublishModal
          deal={deal}
          onClose={() => setPublishing(false)}
          onPublished={() => { setPublishing(false); showToast(t("seller.the_deal_published_now_share")); load(); }}
        />
      ) : null}

      {confirmClose ? (
        <Modal title={t("seller.pause_joining_deal")} onClose={() => setConfirmClose(false)}>
          <p>{t("seller.new_buyers_able_join_existing")}</p>
          <p className="muted small">{t("seller.joining_reopened_long_deadline_passed")}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={() => setConfirmClose(false)}>{t("seller.cancel")}</button>
            <button className="btn btn-danger" data-testid="pause-joining-confirm" onClick={async () => {
              try { await api.closeJoining(dealId); setConfirmClose(false); showToast(t("seller.joining_been_paused")); load(); }
              catch (e: any) { showToast(e.message || t("seller.pausing_failed")); setConfirmClose(false); }
            }}>{t("seller.pause_now")}</button>
          </div>
        </Modal>
      ) : null}

      {confirmDelete ? (
        <Modal title={t("seller.delete_deal_2")} onClose={() => setConfirmDelete(false)}>
          <p><b>{t("seller.delete_deal")}</b>  {t("seller.this_action_cannot_undone")}</p>
          <p className="muted small">{t("seller.deletion_only_possible_while_deal")}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>{t("seller.cancel")}</button>
            <button className="btn btn-danger" data-testid="deal-delete-confirm" onClick={async () => {
              try {
                await api.deleteDeal(dealId);
                showToast(t("seller.the_deal_deleted"));
                navigate("#/seller");
              } catch (e: any) { showToast(e.message || t("seller.the_deletion_failed")); setConfirmDelete(false); }
            }}>{t("seller.delete_permanently")}</button>
          </div>
        </Modal>
      ) : null}

      {/* LAUNCH POLISH (P2) — cancel confirmation: what cancel means, how it
          differs from pause, and the server's answer verbatim in Hebrew. No
          financial consequence is invented: the copy states only what the
          canonical rules guarantee (nobody is charged in the pilot; frames are
          released when a deal ends without success). */}
      {confirmCancel ? (
        <Modal title={t("seller.cancel_deal_permanently")} onClose={() => { if (!cancelling) setConfirmCancel(false); }}>
          <div className="cancel-compare" data-testid="cancel-vs-pause">
            <div className="is-cancel">
              <b>{t("seller.cancel")}</b>
              {t("seller.final_deal_closes_cannot_reopened")}</div>
            <div className="is-pause">
              <b>{t("seller.pause_alternative")}</b>
              {t("seller.temporary_only_stops_new_joins")}</div>
          </div>
          <p className="muted small">
            {t("seller.cancel_server_decides")}
            {!isDraft ? t("seller.a_deal_already_published_may") : "."}
          </p>
          {cancelRefusal ? (
            <div className="notice err" data-testid="cancel-refused">
              <b>{t("seller.the_cancellation_refused_server")}</b>
              <div className="small" style={{ marginTop: 4 }}>{cancelRefusal}</div>
              {isOpen ? (
                <button className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} data-testid="cancel-refused-pause"
                  onClick={() => { setConfirmCancel(false); setConfirmClose(true); }}>
                  {t("seller.pause_joining_instead")}</button>
              ) : null}
            </div>
          ) : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" disabled={cancelling} onClick={() => setConfirmCancel(false)}>{t("seller.back")}</button>
            {!cancelRefusal ? (
              <button className="btn btn-danger" data-testid="deal-cancel-confirm" disabled={cancelling} onClick={async () => {
                if (cancelling) return;
                setCancelling(true);
                try {
                  await api.cancelDeal(dealId, cancelIntentKey.current);
                  setConfirmCancel(false);
                  showToast(t("seller.the_deal_cancelled"));
                  await load(); // refresh the seller state immediately after success
                } catch (e: any) {
                  const code = String(e?.body?.code || e?.body?.error || "");
                  setCancelRefusal(
                    code === "STATE_CONFLICT" && !isDraft
                      ? t("seller.a_deal_already_published_cannot")
                      : code === "STATE_CONFLICT"
                        ? t("seller.the_deal_state_changed_meantime")
                        : String(e?.message || t("seller.the_cancellation_failed_try_again"))
                  );
                }
                setCancelling(false);
              }}>{cancelling ? t("seller.cancelling") : t("seller.cancel_deal_permanently_2")}</button>
            ) : null}
          </div>
        </Modal>
      ) : null}
      <Toast msg={toast} />
    </>
  );
}

// ── business onboarding (P0.3-8) ───────────────────────────────────────────
// Statuses are SEPARATE truths: form completeness is derived, verification
// and provider onboarding are real external processes — nothing here
// auto-approves anything. The full bank account number is WRITE-ONLY: the
// server returns only last4, and an empty input keeps the stored number.
const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: "osek_patur", label: "seller.entity_types.label" },
  { value: "osek_murshe", label: "seller.entity_types.label_2" },
  { value: "company", label: "seller.entity_types.label_3" },
  { value: "amuta", label: "seller.entity_types.label_4" },
  { value: "partnership", label: "seller.entity_types.label_5" },
  { value: "other", label: "seller.entity_types.label_6" }
];

const VERIFICATION_LABELS: Record<string, string> = {
  pending: "seller.verification_labels.pending", approved: "seller.verification_labels.approved", verified: "seller.verification_labels.verified", rejected: "seller.verification_labels.rejected"
};
const GROW_LABELS: Record<string, string> = {
  not_started: "seller.grow_labels.not_started", in_progress: "seller.grow_labels.in_progress", completed: "seller.grow_labels.completed"
};

function StatusBadge({ ok, okText, missingText }: { ok: boolean; okText: string; missingText: string }) {
  return <span className={`status ${ok ? "Completed" : "ClosedForJoining"}`}>{ok ? okText : missingText}</span>;
}

function BusinessProfilePage({ navigate }: { navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [bankNumber, setBankNumber] = useState("");
  const [toast, showToast] = useToast();

  const adopt = (r: Json) => {
    setPayload(r);
    const p = r.business_profile || {};
    setForm({
      business_name: p.business_name || "", legal_name: p.legal_name || "",
      business_id_number: p.business_id_number || "", entity_type: p.entity_type || "",
      contact_name: p.contact_name || "", contact_phone: p.contact_phone || "",
      contact_email: p.contact_email || "", finance_email: p.finance_email || "",
      business_address: p.business_address || "", bank_account_holder: p.bank_account_holder || "",
      bank_name: p.bank_name || "", bank_branch: p.bank_branch || ""
    });
    setBankNumber("");
  };

  useEffect(() => {
    api.sellerBusinessProfile().then(adopt).catch((e) => setError(e.message));
  }, []);

  if (error && !payload) return <EmptyState title={t("seller.the_business_profile_cannot_loaded")} body={error} />;
  if (!payload) return <BrandLoader label={t("seller.loading_business_profile")} minHeight={420} />;

  const statuses = payload.statuses || {};
  const last4 = payload.business_profile?.bank_account_last4 || "";
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const r = await api.saveSellerBusinessProfile({ ...form, bank_account_number: bankNumber });
      adopt(r);
      showToast(t("seller.the_business_profile_saved"));
    } catch (e: any) { setError(e.message || t("seller.saving_failed")); }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("seller.to_dashboard")}</a>

      <div className="panel">
        <div className="panel-title">{t("seller.business_account_state")}</div>
        <div className="kv">
          <span className="k">{t("seller.business_details")}</span>
          <span className="v"><StatusBadge ok={Boolean(statuses.profile_complete)} okText={t("seller.completed")} missingText={t("seller.details_missing")} /></span>
          <span className="k">{t("seller.business_verification")}</span>
          <span className="v"><span className="status ClosedForJoining">{tKey(VERIFICATION_LABELS[String(statuses.verification_status)], statuses.verification_status || t("seller.under_review"))}</span></span>
          <span className="k">{t("seller.settlement_details")}</span>
          <span className="v"><StatusBadge ok={Boolean(statuses.settlement_ready)} okText={t("seller.ready")} missingText={t("seller.bank_details_missing")} /></span>
          <span className="k">{t("seller.connection_payment_provider")}</span>
          <span className="v"><span className="status ClosedForJoining">{tKey(GROW_LABELS[String(statuses.grow_onboarding)], t("seller.not_started"))}</span></span>
        </div>
        <p className="muted small" style={{ marginBottom: 0, marginTop: 10 }}>
          {t("seller.verifying_business_connecting_payment_provider")}</p>
      </div>

      <div className="panel">
        <div className="panel-title">{t("seller.business_details")}</div>
        <div className="field-row">
          <div className="field"><label>{t("seller.business_name")} <span className="req">*</span></label><input value={form.business_name || ""} onChange={set("business_name")} maxLength={200} /></div>
          <div className="field"><label>{t("seller.registered_legal_name")}</label><input value={form.legal_name || ""} onChange={set("legal_name")} maxLength={200} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>{t("seller.company_dealer_number")} <span className="req">*</span></label><input dir="ltr" inputMode="numeric" value={form.business_id_number || ""} onChange={set("business_id_number")} maxLength={20} /></div>
          <div className="field">
            <label>{t("seller.legal_form")}</label>
            <select value={form.entity_type || ""} onChange={set("entity_type")}>
              <option value="">{t("seller.choose")}</option>
              {ENTITY_TYPES.map((opt) => <option key={opt.value} value={opt.value}>{t(opt.label)}</option>)}
            </select>
          </div>
        </div>
        <div className="field"><label>{t("seller.business_address")}</label><input value={form.business_address || ""} onChange={set("business_address")} maxLength={200} /></div>
      </div>

      <div className="panel">
        <div className="panel-title">{t("seller.contact_settlement")}</div>
        <div className="field-row">
          <div className="field"><label>{t("seller.contact_name")} <span className="req">*</span></label><input value={form.contact_name || ""} onChange={set("contact_name")} maxLength={120} /></div>
          <div className="field"><label>{t("seller.phone")}</label><input dir="ltr" inputMode="tel" value={form.contact_phone || ""} onChange={set("contact_phone")} maxLength={30} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>{t("seller.contact_e_mail")}</label><input dir="ltr" inputMode="email" value={form.contact_email || ""} onChange={set("contact_email")} maxLength={200} /></div>
          <div className="field"><label>{t("seller.e_mail_invoices_finance")}</label><input dir="ltr" inputMode="email" value={form.finance_email || ""} onChange={set("finance_email")} maxLength={200} /></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">{t("seller.a_bank_account_receive_funds")}</div>
        <div className="field-row">
          <div className="field"><label>{t("seller.account_holder_s_name")}</label><input value={form.bank_account_holder || ""} onChange={set("bank_account_holder")} maxLength={120} /></div>
          <div className="field"><label>{t("seller.bank")}</label><input value={form.bank_name || ""} onChange={set("bank_name")} maxLength={100} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>{t("seller.branch")}</label><input dir="ltr" inputMode="numeric" value={form.bank_branch || ""} onChange={set("bank_branch")} maxLength={10} /></div>
          <div className="field">
            <label>{t("seller.account_number")}</label>
            <input dir="ltr" inputMode="numeric" autoComplete="off" value={bankNumber} onChange={(e) => setBankNumber(e.target.value)}
              placeholder={last4 ? t("seller.saved_ending_last4", { last4: last4 }) : ""} maxLength={30} />
            <span className="hint">{last4 ? t("seller.the_full_number_stored_encrypted") : t("seller.the_full_number_stored_server")}</span>
          </div>
        </div>
      </div>

      {error ? <div className="notice err">{error}</div> : null}
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 24 }}>
        <button className="btn btn-primary btn-lg" data-testid="business-profile-save" disabled={busy} onClick={save}>
          {busy ? t("seller.saving") : t("seller.save_business_profile")}
        </button>
      </div>
      <Toast msg={toast} />
    </div>
  );
}

// ── entry ──────────────────────────────────────────────────────────────────
export function SellerArea({ sub, query, navigate }: { sub: string[]; query?: URLSearchParams; navigate: (h: string) => void }) {
  const [authed, setAuthed] = useState(Boolean(getSellerToken()));
  // a login that ends WITHOUT a seller surface (binding refused) must still
  // re-render so the explanation notice appears — bump forces it
  const [, bump] = useState(0);
  if (!authed) {
    return (
      <>
        <SellerBindingNotice navigate={navigate} />
        <SellerLogin initialMode={query?.get("signup") ? "signup" : "login"}
          onDone={() => { setAuthed(Boolean(getSellerToken())); bump((n) => n + 1); }} />
      </>
    );
  }
  if (sub[0] === "inquiries" && sub[1]) return <SellerInquiryThreadPage threadId={sub[1]} navigate={navigate} />;
  if (sub[0] === "inquiries") return <SellerInquiriesPage navigate={navigate} />;
  // LAUNCH SPRINT 3 — global pickup scanner (a phone camera opening the buyer's
  // QR lands here with ?code=…) + the per-deal "הזמנות למסירה" list
  if (sub[0] === "pickup") return <SellerPickupPage navigate={navigate} initialCode={query?.get("code") || null} />;
  if (sub[0] === "deal" && sub[1] && sub[2] === "fulfillment") return <SellerFulfillmentPage dealId={sub[1]} navigate={navigate} />;
  if (sub[0] === "new") return <CreateWizard navigate={navigate} productId={query?.get("product") || null} />;
  // 071 — Product Library
  if (sub[0] === "products" && sub[1] === "new") return <SellerProductCreatePage navigate={navigate} />;
  if (sub[0] === "products" && sub[1]) return <SellerProductPage productId={sub[1]} navigate={navigate} />;
  if (sub[0] === "products") return <SellerProductLibraryPage navigate={navigate} />;
  if (sub[0] === "receipts") return <SellerReceipts initialCode={query?.get("code") || ""} />;
  if (sub[0] === "profile") return <><PublicProfileEditor /><BusinessProfilePage navigate={navigate} /></>;
  if (sub[0] === "deal" && sub[1] && sub[2] === "viral") return <SellerViralTreePage dealId={sub[1]} navigate={navigate} />;
  if (sub[0] === "deal" && sub[1] && sub[2] === "distribution" && sub[3]) return <SellerLinkDashboardPage dealId={sub[1]} linkId={sub[3]} navigate={navigate} />;
  // P0.7 polish — seller-authorized buyer preview (Draft included): SAME renderer, read-only mode
  if (sub[0] === "deal" && sub[1] && sub[2] === "preview") return <DealPage dealId={sub[1]} navigate={navigate} preview />;
  if (sub[0] === "deal" && sub[1]) return <SellerDealScreen dealId={sub[1]} navigate={navigate} />;
  return <SellerDashboard navigate={navigate} />;
}
