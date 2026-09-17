// SPRINT 4 (A8) — windowed virality metrics for the admin dashboard.
//
// Every number here is computed LIVE for the requested [from, to) window
// (growth_window.ts) — joins, attributed joins, charged units / GMV that
// came through sharing, funnel events, link events, personal links created,
// sharing participants, generation depth, and the top deals / sellers of the
// window. Nothing here reads the lifetime cache; the lifetime rollup stays a
// separate, explicitly labelled block on the same screen.
//
// Semantics mirror the lifetime engine (viral_graph.ts) so the two blocks are
// comparable: an "attributed" join is a viral_attributions row whose origin
// is not 'none'; a "charged" unit is money_state ChargedSuccess/RecoveredCharge;
// GMV = qty × price_per_unit + delivery_cost (buyer VAT is not part of it).

import type { GrowthWindow } from "./growth_window.js";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const SUCCESS_STATES_SQL = `('ChargedSuccess','RecoveredCharge')`;

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

export interface GrowthWindowMetrics {
  joins: number;
  attributed_joins: number;
  viral_coefficient: number;
  viral_share_of_joins: number;
  charged_units: number;
  charged_gmv: number;
  attributed_charged_units: number;
  attributed_charged_gmv: number;
  viral_share_of_charged: number;
  sharing_participants: number;
  max_generation: number;
  personal_links: number;
  share_button_clicks: number;
  deal_views: number;
  link_clicks: number;
  link_entries: number;
  funnel_events: Record<string, number>;
  top_deals: Array<{ deal_id: string; deal_title: string; seller_id: string; attributed_participants: number; attributed_charged_units: number; attributed_charged_gmv: number; max_generation: number }>;
  top_sellers: Array<{ seller_id: string; seller_name: string | null; attributed_participants: number; attributed_charged_gmv: number; deals: number }>;
}

export async function computeGrowthWindowMetrics(db: Queryable, window: GrowthWindow): Promise<GrowthWindowMetrics> {
  const bounds = [window.from, window.to];
  // $1 = from (nullable → open start), $2 = to (exclusive)
  const inWindow = (column: string) => `(($1::timestamptz IS NULL OR ${column} >= $1::timestamptz) AND ${column} < $2::timestamptz)`;

  const core = await db.query(
    `SELECT COUNT(*)::int AS joins,
            COUNT(*) FILTER (WHERE va.origin_ref_type IS NOT NULL AND va.origin_ref_type <> 'none')::int AS attributed_joins,
            COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL}), 0)::int AS charged_units,
            COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL}), 0)::numeric(14,2) AS charged_gmv,
            COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL} AND va.origin_ref_type IS NOT NULL AND va.origin_ref_type <> 'none'), 0)::int AS attributed_charged_units,
            COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL} AND va.origin_ref_type IS NOT NULL AND va.origin_ref_type <> 'none'), 0)::numeric(14,2) AS attributed_charged_gmv,
            COUNT(DISTINCT va.parent_participant_id) FILTER (WHERE va.parent_participant_id IS NOT NULL)::int AS sharing_participants,
            COALESCE(MAX(va.generation), 0)::int AS max_generation
     FROM siton.participants p
     JOIN siton.deals d ON d.deal_id = p.deal_id
     LEFT JOIN siton.viral_attributions va ON va.participant_id = p.participant_id
     WHERE p.buyer_state <> 'NotJoined' AND ${inWindow("p.created_at")}`,
    bounds
  );
  const c = core.rows[0] || {};

  const funnel = await db.query(
    `SELECT event_type, COUNT(*)::int AS cnt FROM siton.viral_events WHERE ${inWindow("created_at")} GROUP BY event_type`,
    bounds
  );
  const funnelEvents: Record<string, number> = {};
  for (const row of funnel.rows) funnelEvents[String(row.event_type)] = Number(row.cnt || 0);

  const linkEvents = await db.query(
    `SELECT event_type, COUNT(*)::int AS cnt FROM siton.affiliate_link_events WHERE ${inWindow("created_at")} GROUP BY event_type`,
    bounds
  );
  const links: Record<string, number> = {};
  for (const row of linkEvents.rows) links[String(row.event_type)] = Number(row.cnt || 0);

  const personalLinks = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM siton.affiliate_links WHERE origin_type = 'participant' AND ${inWindow("created_at")}`,
    bounds
  );

  const topDeals = await db.query(
    `SELECT d.deal_id, d.title AS deal_title, d.seller_id,
            COUNT(*)::int AS attributed_participants,
            COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL}), 0)::int AS attributed_charged_units,
            COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL}), 0)::numeric(14,2) AS attributed_charged_gmv,
            COALESCE(MAX(va.generation), 0)::int AS max_generation
     FROM siton.viral_attributions va
     JOIN siton.participants p ON p.participant_id = va.participant_id
     JOIN siton.deals d ON d.deal_id = p.deal_id
     WHERE va.origin_ref_type <> 'none' AND ${inWindow("va.created_at")}
     GROUP BY d.deal_id, d.title, d.seller_id
     ORDER BY attributed_participants DESC, attributed_charged_gmv DESC
     LIMIT 10`,
    bounds
  );

  const topSellers = await db.query(
    `SELECT d.seller_id, MAX(sa.display_name) AS seller_name,
            COUNT(*)::int AS attributed_participants,
            COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL}), 0)::numeric(14,2) AS attributed_charged_gmv,
            COUNT(DISTINCT d.deal_id)::int AS deals
     FROM siton.viral_attributions va
     JOIN siton.participants p ON p.participant_id = va.participant_id
     JOIN siton.deals d ON d.deal_id = p.deal_id
     LEFT JOIN siton.seller_accounts sa ON sa.seller_id = d.seller_id
     WHERE va.origin_ref_type <> 'none' AND ${inWindow("va.created_at")}
     GROUP BY d.seller_id
     ORDER BY attributed_participants DESC, attributed_charged_gmv DESC
     LIMIT 10`,
    bounds
  );

  const joins = Number(c.joins || 0);
  const attributedJoins = Number(c.attributed_joins || 0);
  const chargedUnits = Number(c.charged_units || 0);
  const attributedChargedUnits = Number(c.attributed_charged_units || 0);
  return {
    joins,
    attributed_joins: attributedJoins,
    viral_coefficient: ratio(attributedJoins, joins),
    viral_share_of_joins: ratio(attributedJoins, joins),
    charged_units: chargedUnits,
    charged_gmv: Number(c.charged_gmv || 0),
    attributed_charged_units: attributedChargedUnits,
    attributed_charged_gmv: Number(c.attributed_charged_gmv || 0),
    viral_share_of_charged: ratio(attributedChargedUnits, chargedUnits),
    sharing_participants: Number(c.sharing_participants || 0),
    max_generation: Number(c.max_generation || 0),
    personal_links: Number(personalLinks.rows[0]?.cnt || 0),
    share_button_clicks: funnelEvents.share_button_click || 0,
    deal_views: funnelEvents.deal_view || 0,
    link_clicks: links.click || 0,
    link_entries: links.entry || 0,
    funnel_events: funnelEvents,
    top_deals: topDeals.rows.map((r: any) => ({
      deal_id: String(r.deal_id), deal_title: String(r.deal_title || ""), seller_id: String(r.seller_id || ""),
      attributed_participants: Number(r.attributed_participants || 0), attributed_charged_units: Number(r.attributed_charged_units || 0),
      attributed_charged_gmv: Number(r.attributed_charged_gmv || 0), max_generation: Number(r.max_generation || 0)
    })),
    top_sellers: topSellers.rows.map((r: any) => ({
      seller_id: String(r.seller_id || ""), seller_name: r.seller_name ? String(r.seller_name) : null,
      attributed_participants: Number(r.attributed_participants || 0), attributed_charged_gmv: Number(r.attributed_charged_gmv || 0), deals: Number(r.deals || 0)
    }))
  };
}
