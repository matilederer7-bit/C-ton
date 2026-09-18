import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { GroupMeter, SkeletonCards, EmptyState, StatusPill, Countdown } from "../components";
import { countdownView, dealTypeLabel, ils, num } from "../util";
import { t } from "../i18n";

type MallDeal = {
  deal_id: string;
  title: string;
  description_excerpt?: string;
  deal_type: string;
  state: string;
  price_per_unit: number;
  list_price_per_unit?: number | null;
  seller_business_name?: string | null;
  joined_units: number;
  threshold_units: number;
  max_units: number;
  remaining_units: number;
  deadline: string;
  primary_image: { url: string } | null;
  availability: { can_join: boolean; reason_code: string | null };
};

function urgencyBadge(deal: MallDeal): { text: string; hot: boolean } | null {
  if (!deal.availability.can_join) return null;
  const cd = countdownView(deal.deadline);
  if (deal.remaining_units > 0 && deal.remaining_units <= Math.max(3, deal.max_units * 0.1)) {
    return { text: t("mall.only_remaining_units_units_left", { remaining_units: num(deal.remaining_units) }), hot: true };
  }
  if (cd && cd.tone === "danger") return { text: t("mall.closing_soon"), hot: true };
  if (cd && cd.tone === "warn") return { text: t("mall.closing_text", { text: cd.text }), hot: false };
  return null;
}

function DealCard({ deal, onOpen }: { deal: MallDeal; onOpen: () => void }) {
  const badge = urgencyBadge(deal);
  const toTarget = Math.max(0, deal.threshold_units - deal.joined_units);
  return (
    <a
      className="card"
      href={`#/deal/${deal.deal_id}`}
      onClick={(e) => { e.preventDefault(); onOpen(); }}
      aria-label={deal.title}
    >
      <div className="card-media">
        {deal.primary_image?.url
          ? <img src={deal.primary_image.url} alt={deal.title} loading="lazy" />
          : <div className="placeholder">{dealTypeLabel(deal.deal_type)}</div>}
        <span className="card-type">{dealTypeLabel(deal.deal_type)}</span>
        {badge ? <span className={`card-urgency${badge.hot ? " hot" : ""}`}>{badge.text}</span> : null}
      </div>
      <div className="card-body">
        <div className="card-head">
          <div>
            <div className="card-title">{deal.title}</div>
            {deal.seller_business_name ? <div className="card-seller">{deal.seller_business_name}</div> : null}
          </div>
          <StatusPill state={deal.state} />
        </div>
        <div className="card-desc">{deal.description_excerpt || ""}</div>
        <GroupMeter joined={deal.joined_units} threshold={deal.threshold_units} max={deal.max_units} showFlag={false} />
        <div className="card-price-row">
          <span className="price">{ils(deal.price_per_unit)}</span>
          <span className="price-unit">{t("mall.per_unit")}</span>
          {Number(deal.list_price_per_unit) > Number(deal.price_per_unit)
            ? <span className="price-was" dir="ltr" aria-label={t("mall.list_price")}>{ils(deal.list_price_per_unit)}</span>
            : null}
          {deal.availability.can_join && toTarget > 0
            ? <span className="muted small" style={{ marginInlineStart: "auto" }}>{t("mall.totarget_target", { toTarget: num(toTarget) })}</span>
            : null}
        </div>
        <div className="card-foot">
          <Countdown until={deal.deadline} overText={t("mall.joining_ended")} />
          <span>{deal.availability.can_join ? t("mall.open_joining") : t("mall.joining_closed")}</span>
        </div>
      </div>
    </a>
  );
}

const TYPE_FILTERS = [
  { key: "", label: "mall.type_filters.label" },
  { key: "physical_product", label: "mall.type_filters.label_2" },
  { key: "voucher", label: "mall.type_filters.label_3" },
  { key: "ticket", label: "mall.type_filters.label_4" }
];

export function Mall({ navigate }: { navigate: (hash: string) => void }) {
  const [deals, setDeals] = useState<MallDeal[] | null>(null);
  const [error, setError] = useState("");
  const [type, setType] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    setDeals(null);
    api.mall(type ? { type } : {})
      .then((res) => { if (alive) setDeals((res.deals || res.items || []) as MallDeal[]); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [type]);

  const visible = useMemo(() => {
    if (!deals) return null;
    const list = onlyOpen ? deals.filter((d) => d.availability?.can_join) : deals;
    // Open deals closest to target first — the "almost there" story sells.
    return [...list].sort((a, b) => {
      const ao = a.availability?.can_join ? 0 : 1;
      const bo = b.availability?.can_join ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ar = Math.max(0, a.threshold_units - a.joined_units) / Math.max(1, a.threshold_units);
      const br = Math.max(0, b.threshold_units - b.joined_units) / Math.max(1, b.threshold_units);
      return ar - br;
    });
  }, [deals, onlyOpen]);

  const liveUnits = useMemo(
    () => (deals || []).filter((d) => d.availability?.can_join).reduce((s, d) => s + Number(d.joined_units || 0), 0),
    [deals]
  );
  const liveDeals = (deals || []).filter((d) => d.availability?.can_join).length;

  return (
    <>
      <section className="hero">
        <div className="hero-kicker">{t("mall.buying_together_paying_less")}</div>
        <h1>{t("mall.the_price_drops_everyone_joins")}</h1>
        <p>
          {t("mall.every_c_ton_deal_goes")}</p>
        {liveDeals > 0 ? (
          <div className="hero-live">
            <span className="live-dot" aria-hidden="true" />
            {t("mall.live_summary", { deals: num(liveDeals), units: num(liveUnits) })}
          </div>
        ) : null}
      </section>

      <div className="filters" role="tablist" aria-label={t("mall.filter_deals")}>
        {TYPE_FILTERS.map((f) => (
          <button key={f.key} className={`chip${type === f.key ? " active" : ""}`} onClick={() => setType(f.key)}>
            {t(f.label)}
          </button>
        ))}
        <button className={`chip${onlyOpen ? " active" : ""}`} onClick={() => setOnlyOpen((v) => !v)} style={{ marginInlineStart: "auto" }}>
          {onlyOpen ? "✓ " : ""}{t("mall.only_open_filter")}
        </button>
      </div>

      {error ? <div className="notice err">{error}</div> : null}
      {!visible ? <SkeletonCards /> : visible.length === 0 ? (
        <EmptyState
          title={t("mall.there_open_deals_right_now")}
          body={t("mall.new_deals_open_all_time")}
          action={!onlyOpen ? undefined : <button className="btn btn-ghost" onClick={() => setOnlyOpen(false)}>{t("mall.show_all_deals")}</button>}
        />
      ) : (
        <div className="grid">
          {visible.map((d) => (
            <DealCard key={d.deal_id} deal={d} onOpen={() => navigate(`#/deal/${d.deal_id}`)} />
          ))}
        </div>
      )}

      <div className="center" style={{ paddingTop: 34 }}>
        <p className="muted small">{t("mall.selling_open_group_deal_own")}</p>
        <a className="btn btn-ghost" href="#/seller">{t("mall.sellers_area")}</a>
      </div>
    </>
  );
}
