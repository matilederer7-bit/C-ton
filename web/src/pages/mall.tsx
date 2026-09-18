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
    return { text: t("pages.mall.3c35f254", { remaining_units: num(deal.remaining_units) }), hot: true };
  }
  if (cd && cd.tone === "danger") return { text: t("pages.mall.5f0a8707"), hot: true };
  if (cd && cd.tone === "warn") return { text: t("pages.mall.e28fc25f", { text: cd.text }), hot: false };
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
          <span className="price-unit">{t("pages.mall.98f13081")}</span>
          {Number(deal.list_price_per_unit) > Number(deal.price_per_unit)
            ? <span className="price-was" dir="ltr" aria-label={t("pages.mall.36bb7801")}>{ils(deal.list_price_per_unit)}</span>
            : null}
          {deal.availability.can_join && toTarget > 0
            ? <span className="muted small" style={{ marginInlineStart: "auto" }}>{t("pages.mall.895df89e", { toTarget: num(toTarget) })}</span>
            : null}
        </div>
        <div className="card-foot">
          <Countdown until={deal.deadline} overText={t("pages.mall.7270e065")} />
          <span>{deal.availability.can_join ? t("pages.mall.f072e651") : t("pages.mall.0318e24b")}</span>
        </div>
      </div>
    </a>
  );
}

const TYPE_FILTERS = [
  { key: "", label: "הכל" },
  { key: "physical_product", label: "מוצרים" },
  { key: "voucher", label: "שוברים" },
  { key: "ticket", label: "כרטיסים" }
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
        <div className="hero-kicker">{t("pages.mall.ccc41545")}</div>
        <h1>{t("pages.mall.f9f9b02d")}</h1>
        <p>
          {t("pages.mall.69a53e1d")}</p>
        {liveDeals > 0 ? (
          <div className="hero-live">
            <span className="live-dot" aria-hidden="true" />
            {num(liveDeals)} עסקאות פתוחות עכשיו · {num(liveUnits)} יחידות כבר הצטרפו
          </div>
        ) : null}
      </section>

      <div className="filters" role="tablist" aria-label={t("pages.mall.963c93c4")}>
        {TYPE_FILTERS.map((f) => (
          <button key={f.key} className={`chip${type === f.key ? " active" : ""}`} onClick={() => setType(f.key)}>
            {f.label}
          </button>
        ))}
        <button className={`chip${onlyOpen ? " active" : ""}`} onClick={() => setOnlyOpen((v) => !v)} style={{ marginInlineStart: "auto" }}>
          {onlyOpen ? "✓ " : ""}פתוחות להצטרפות
        </button>
      </div>

      {error ? <div className="notice err">{error}</div> : null}
      {!visible ? <SkeletonCards /> : visible.length === 0 ? (
        <EmptyState
          title={t("pages.mall.557da7e7")}
          body={t("pages.mall.cd87995a")}
          action={!onlyOpen ? undefined : <button className="btn btn-ghost" onClick={() => setOnlyOpen(false)}>{t("pages.mall.072cd4ef")}</button>}
        />
      ) : (
        <div className="grid">
          {visible.map((d) => (
            <DealCard key={d.deal_id} deal={d} onOpen={() => navigate(`#/deal/${d.deal_id}`)} />
          ))}
        </div>
      )}

      <div className="center" style={{ paddingTop: 34 }}>
        <p className="muted small">{t("pages.mall.a67f58a2")}</p>
        <a className="btn btn-ghost" href="#/seller">{t("pages.mall.18359a36")}</a>
      </div>
    </>
  );
}
