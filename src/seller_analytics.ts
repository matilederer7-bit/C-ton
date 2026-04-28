import { DEFAULT_SELLER_ID } from "./product_surface_support.js";
import { calculatePlatformFeeMoney, roundMoney } from "./platform_fee_money.js";

export const SELLER_ANALYTICS_PERIODS = ["all", "30d", "90d", "year"] as const;
export type SellerAnalyticsPeriod = (typeof SELLER_ANALYTICS_PERIODS)[number];

const DEAL_STATES = [
  "Draft",
  "PendingTarget",
  "TargetReached",
  "ClosedForJoining",
  "ReadyForCharging",
  "Charging",
  "CompletionWindow",
  "Completed",
  "Failed",
  "Cancelled"
] as const;

const ACTIVE_DEAL_STATES = new Set([
  "PendingTarget",
  "TargetReached",
  "ClosedForJoining",
  "ReadyForCharging",
  "Charging",
  "CompletionWindow"
]);

export function normalizeSellerAnalyticsPeriod(value: unknown): SellerAnalyticsPeriod | null {
  const period = String(value || "all").trim() || "all";
  return (SELLER_ANALYTICS_PERIODS as readonly string[]).includes(period)
    ? (period as SellerAnalyticsPeriod)
    : null;
}

function periodCutoff(period: SellerAnalyticsPeriod): Date | null {
  const now = Date.now();
  if (period === "30d") return new Date(now - 30 * 24 * 60 * 60 * 1000);
  if (period === "90d") return new Date(now - 90 * 24 * 60 * 60 * 1000);
  if (period === "year") return new Date(now - 365 * 24 * 60 * 60 * 1000);
  return null;
}

function pct(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return roundMoney((numerator / denominator) * 100);
}

function isPublishReady(row: any) {
  return Boolean(
    String(row?.business_name || "").trim() &&
    (String(row?.support_email || "").trim() || String(row?.support_phone || "").trim())
  );
}

export async function buildSellerAnalytics(c: any, sellerId: string, period: SellerAnalyticsPeriod) {
  const cutoff = periodCutoff(period);
  const dealWhere = cutoff
    ? `COALESCE(d.seller_id, $2) = $1 AND d.created_at >= $3`
    : `COALESCE(d.seller_id, $2) = $1`;
  const dealParams = cutoff ? [sellerId, DEFAULT_SELLER_ID, cutoff.toISOString()] : [sellerId, DEFAULT_SELLER_ID];

  const [sellerResult, statesResult] = await Promise.all([
    c.query(
      `SELECT seller_id, business_name, support_email, support_phone
       FROM siton.seller_accounts
       WHERE seller_id = $1
       LIMIT 1`,
      [sellerId]
    ),
    c.query(
      `SELECT d.state, COUNT(*)::int AS count
       FROM siton.deals d
       WHERE ${dealWhere}
       GROUP BY d.state`,
      dealParams
    )
  ]);

  const seller = sellerResult.rows[0] || {};
  const counts = new Map<string, number>();
  for (const row of statesResult.rows) counts.set(String(row.state), Number(row.count || 0));

  const dealsByState = DEAL_STATES.map((state) => ({
    state,
    count: counts.get(state) || 0
  }));

  const totalDeals = dealsByState.reduce((sum, row) => sum + row.count, 0);
  const draftDeals = counts.get("Draft") || 0;
  const activeDeals = dealsByState
    .filter((row) => ACTIVE_DEAL_STATES.has(row.state))
    .reduce((sum, row) => sum + row.count, 0);
  const completedDeals = counts.get("Completed") || 0;
  const failedDeals = counts.get("Failed") || 0;
  const cancelledDeals = counts.get("Cancelled") || 0;
  const terminalDeals = completedDeals + failedDeals + cancelledDeals;
  const zeroMoney = calculatePlatformFeeMoney({ grossAmount: 0 });

  return {
    generated_at: new Date().toISOString(),
    period,
    seller: {
      seller_id: sellerId,
      business_name: String(seller.business_name || ""),
      is_publish_ready: isPublishReady(seller)
    },
    summary: {
      total_deals: totalDeals,
      draft_deals: draftDeals,
      active_deals: activeDeals,
      completed_deals: completedDeals,
      failed_deals: failedDeals,
      cancelled_deals: cancelledDeals,
      success_rate_percent: pct(completedDeals, terminalDeals),
      gross_collected_total: zeroMoney.gross_amount,
      platform_fee_total: zeroMoney.platform_fee_total_amount,
      seller_net_total: zeroMoney.seller_net_amount,
      total_joined_units: 0,
      total_charged_units: 0,
      total_buyers: 0,
      eligible_buyers: 0,
      average_deal_gross: 0,
      average_units_per_completed_deal: 0
    },
    money: {
      gross_collected_total: zeroMoney.gross_amount,
      products_total: 0,
      delivery_total: 0,
      platform_fee_base_total: zeroMoney.platform_fee_base_amount,
      platform_fee_vat_total: zeroMoney.platform_fee_vat_amount,
      platform_fee_total: zeroMoney.platform_fee_total_amount,
      seller_net_total: zeroMoney.seller_net_amount
    },
    deals_by_state: dealsByState,
    recent_deals: [],
    top_deals: [],
    weak_deals: [],
    buyer_funnel: {
      joined_authorized: 0,
      charged_successfully: 0,
      recovered: 0,
      dropped: 0,
      deal_failed: 0
    },
    attribution: {
      measurement_only: true,
      disclaimer_he: "נתוני ייחוס בלבד. סיטון אינה מחשבת עמלה ואינה מבצעת תשלום למפיצים.",
      links_count: 0,
      attributed_units: 0,
      attributed_gross: 0,
      top_links: []
    },
    action_insights: []
  };
}
