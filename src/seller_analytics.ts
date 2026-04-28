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

const CHARGED_MONEY_STATES = ["ChargedSuccess", "RecoveredCharge"] as const;

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

function num(value: unknown) {
  return Number(value || 0);
}

function dateClause(alias: string, cutoff: Date | null, paramIndex: number) {
  return cutoff ? ` AND ${alias}.created_at >= $${paramIndex}` : "";
}

function moneyFromGross(grossAmount: number) {
  return calculatePlatformFeeMoney({ grossAmount: roundMoney(grossAmount) });
}

function dealMoney(row: any) {
  if (num(row.money_event_count) > 0) {
    return {
      gross_amount: roundMoney(num(row.money_gross_amount)),
      platform_fee_base_amount: roundMoney(num(row.money_platform_fee_base_amount)),
      platform_fee_vat_amount: roundMoney(num(row.money_platform_fee_vat_amount)),
      platform_fee_total_amount: roundMoney(num(row.money_platform_fee_total_amount)),
      seller_net_amount: roundMoney(num(row.money_seller_net_amount))
    };
  }
  const money = moneyFromGross(num(row.gross_amount));
  return {
    gross_amount: money.gross_amount,
    platform_fee_base_amount: money.platform_fee_base_amount,
    platform_fee_vat_amount: money.platform_fee_vat_amount,
    platform_fee_total_amount: money.platform_fee_total_amount,
    seller_net_amount: money.seller_net_amount
  };
}

function sumRows<T>(rows: T[], fn: (row: T) => number) {
  return roundMoney(rows.reduce((sum, row) => sum + fn(row), 0));
}

function formatDeal(row: any) {
  const money = dealMoney(row);
  const state = String(row.state || "");
  return {
    deal_id: String(row.deal_id),
    title: String(row.title || ""),
    state,
    created_at: row.created_at ?? null,
    deadline: row.deadline ?? null,
    completed_at: state === "Completed" ? row.updated_at ?? row.created_at ?? null : null,
    min_units: num(row.min_units),
    max_units: num(row.max_units),
    joined_units: num(row.joined_units),
    charged_units: num(row.charged_units),
    gross_amount: money.gross_amount,
    platform_fee_total: money.platform_fee_total_amount,
    seller_net_amount: money.seller_net_amount,
    has_image: Boolean(row.has_image),
    has_excel_export_available: state === "Completed",
    can_duplicate: true
  };
}

function buildWeakDeals(rows: any[], sellerReady: boolean) {
  const weak: any[] = [];
  const push = (row: any, reason: string, labelHe: string, readinessIssue?: string) => {
    if (weak.length >= 5) return;
    weak.push({
      deal_id: String(row.deal_id),
      title: String(row.title || ""),
      state: String(row.state || ""),
      reason,
      label_he: labelHe,
      missing_units_to_target: Math.max(0, num(row.threshold_units) - num(row.joined_units)),
      has_image: Boolean(row.has_image),
      has_seller_profile: Boolean(row.has_seller_profile),
      readiness_issue: readinessIssue ?? null
    });
  };

  for (const row of rows) {
    if (String(row.state) === "Failed") {
      push(row, "failed_below_target", "העסקה לא הושלמה וכדאי להבין מה חסם אותה");
    }
  }
  for (const row of rows) {
    if (ACTIVE_DEAL_STATES.has(String(row.state)) && num(row.joined_units) < num(row.threshold_units)) {
      push(row, "active_missing_units", "העסקה עדיין צריכה עוד יחידות כדי להתקדם");
    }
  }
  for (const row of rows) {
    if (String(row.state) === "Draft" && !row.has_image) {
      push(row, "draft_missing_image", "טיוטה ללא תמונת מוצר", "missing_image");
    }
  }
  if (!sellerReady) {
    for (const row of rows) {
      if (String(row.state) === "Draft") {
        push(row, "seller_profile_not_ready", "פרטי המוכר עדיין לא מוכנים לפרסום", "seller_profile_not_ready");
      }
    }
  }
  return weak.slice(0, 5);
}

function buildActionInsights(args: {
  sellerReady: boolean;
  completedDeals: number;
  draftMissingImageCount: number;
  activeMissingUnitsCount: number;
}) {
  const insights: any[] = [];
  if (!args.sellerReady) {
    insights.push({
      type: "seller_profile_not_ready",
      severity: "warning",
      message_he: "כדאי להשלים את פרטי המוכר לפני פרסום העסקה הבאה.",
      action: "complete_profile"
    });
  }
  if (args.activeMissingUnitsCount > 0) {
    insights.push({
      type: "active_deals_missing_units",
      severity: "warning",
      message_he: "יש עסקאות פעילות שעדיין צריכות עוד יחידות כדי להתקדם.",
      action: "share_deal"
    });
  }
  if (args.draftMissingImageCount > 0) {
    insights.push({
      type: "drafts_missing_image",
      severity: "warning",
      message_he: "יש טיוטות ללא תמונת מוצר. תמונה טובה יכולה לחזק אמון לפני פרסום.",
      action: "add_image"
    });
  }
  if (args.completedDeals > 0) {
    insights.push({
      type: "completed_deals_excel_available",
      severity: "info",
      message_he: "לעסקאות שהושלמו זמין קובץ Excel עם נתוני העסקה.",
      action: "download_excel"
    });
    insights.push({
      type: "completed_deals_available_to_duplicate",
      severity: "info",
      message_he: "אפשר ליצור טיוטה חדשה על בסיס עסקה שהושלמה.",
      action: "duplicate_deal"
    });
  }
  return insights.slice(0, 6);
}

export async function buildSellerAnalytics(c: any, sellerId: string, period: SellerAnalyticsPeriod) {
  const cutoff = periodCutoff(period);
  const dealWhere = cutoff
    ? `COALESCE(d.seller_id, $2) = $1 AND d.created_at >= $3`
    : `COALESCE(d.seller_id, $2) = $1`;
  const dealParams = cutoff ? [sellerId, DEFAULT_SELLER_ID, cutoff.toISOString()] : [sellerId, DEFAULT_SELLER_ID];
  const participantParams = cutoff ? [sellerId, DEFAULT_SELLER_ID, cutoff.toISOString()] : [sellerId, DEFAULT_SELLER_ID];
  const moneyEventParams = cutoff ? [sellerId, cutoff.toISOString()] : [sellerId];

  const [sellerResult, statesResult, participantSummaryResult, moneyEventSummaryResult, fallbackMoneyResult, dealRowsResult, attributionResult] = await Promise.all([
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
    ),
    c.query(
      `SELECT
         COALESCE(SUM(p.qty),0) AS total_joined_units,
         COUNT(DISTINCT p.buyer_id)::int AS total_buyers,
         COUNT(*) FILTER (WHERE p.buyer_state='JoinedAuthorized')::int AS joined_authorized,
         COUNT(*) FILTER (WHERE p.money_state='ChargedSuccess')::int AS charged_successfully,
         COUNT(*) FILTER (WHERE p.money_state='RecoveredCharge')::int AS recovered,
         COUNT(*) FILTER (WHERE p.buyer_state='Dropped')::int AS dropped,
         COUNT(*) FILTER (WHERE p.buyer_state='DealFailed')::int AS deal_failed
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       WHERE COALESCE(d.seller_id, $2) = $1${dateClause("p", cutoff, 3)}`,
      participantParams
    ),
    c.query(
      `SELECT
         COUNT(*)::int AS event_count,
         COALESCE(SUM(m.gross_amount),0) AS gross_collected_total,
         COALESCE(SUM(p.qty * d.price_per_unit),0) AS products_total,
         COALESCE(SUM(p.delivery_cost),0) AS delivery_total,
         COALESCE(SUM(m.platform_fee_base_amount),0) AS platform_fee_base_total,
         COALESCE(SUM(m.platform_fee_vat_amount),0) AS platform_fee_vat_total,
         COALESCE(SUM(m.platform_fee_total_amount),0) AS platform_fee_total,
         COALESCE(SUM(m.seller_net_amount),0) AS seller_net_total,
         COALESCE(SUM(p.qty),0) AS total_charged_units,
         COUNT(DISTINCT p.buyer_id)::int AS eligible_buyers
       FROM siton.platform_fee_money_events m
       JOIN siton.participants p ON p.participant_id = m.participant_id
       JOIN siton.deals d ON d.deal_id = m.deal_id
       WHERE m.seller_id = $1
         AND m.logical_entry_type='charge'${dateClause("m", cutoff, 2)}`,
      moneyEventParams
    ),
    c.query(
      `SELECT
         COALESCE(SUM(p.qty * d.price_per_unit + COALESCE(p.delivery_cost,0)),0) AS gross_collected_total,
         COALESCE(SUM(p.qty * d.price_per_unit),0) AS products_total,
         COALESCE(SUM(COALESCE(p.delivery_cost,0)),0) AS delivery_total,
         COALESCE(SUM(p.qty),0) AS total_charged_units,
         COUNT(DISTINCT p.buyer_id)::int AS eligible_buyers
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       WHERE COALESCE(d.seller_id, $2) = $1
         AND p.money_state IN ('ChargedSuccess','RecoveredCharge')${dateClause("p", cutoff, 3)}`,
      participantParams
    ),
    c.query(
      `SELECT
         d.deal_id::text,
         d.title,
         d.state,
         d.min_units,
         d.max_units,
         d.threshold_units,
         d.deadline,
         d.created_at,
         d.updated_at,
         EXISTS (SELECT 1 FROM siton.deal_images img WHERE img.deal_id=d.deal_id) AS has_image,
         (
           NULLIF(btrim(COALESCE(sa.business_name, '')), '') IS NOT NULL
           AND (
             NULLIF(btrim(COALESCE(sa.support_email, '')), '') IS NOT NULL
             OR NULLIF(btrim(COALESCE(sa.support_phone, '')), '') IS NOT NULL
           )
         ) AS has_seller_profile,
         COALESCE(pa.joined_units,0) AS joined_units,
         COALESCE(pa.charged_units,0) AS charged_units,
         COALESCE(pa.buyers_count,0) AS buyers_count,
         COALESCE(pa.products_total,0) AS products_total,
         COALESCE(pa.delivery_total,0) AS delivery_total,
         COALESCE(pa.gross_amount,0) AS gross_amount,
         COALESCE(ma.money_event_count,0) AS money_event_count,
         COALESCE(ma.money_gross_amount,0) AS money_gross_amount,
         COALESCE(ma.money_platform_fee_base_amount,0) AS money_platform_fee_base_amount,
         COALESCE(ma.money_platform_fee_vat_amount,0) AS money_platform_fee_vat_amount,
         COALESCE(ma.money_platform_fee_total_amount,0) AS money_platform_fee_total_amount,
         COALESCE(ma.money_seller_net_amount,0) AS money_seller_net_amount
       FROM siton.deals d
       LEFT JOIN siton.seller_accounts sa ON sa.seller_id = COALESCE(d.seller_id, $2)
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(p.qty),0) AS joined_units,
           COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS charged_units,
           COUNT(DISTINCT p.buyer_id) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge'))::int AS buyers_count,
           COALESCE(SUM(p.qty * d.price_per_unit) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS products_total,
           COALESCE(SUM(COALESCE(p.delivery_cost,0)) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS delivery_total,
           COALESCE(SUM(p.qty * d.price_per_unit + COALESCE(p.delivery_cost,0)) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS gross_amount
         FROM siton.participants p
         WHERE p.deal_id=d.deal_id
       ) pa ON true
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*)::int AS money_event_count,
           COALESCE(SUM(m.gross_amount),0) AS money_gross_amount,
           COALESCE(SUM(m.platform_fee_base_amount),0) AS money_platform_fee_base_amount,
           COALESCE(SUM(m.platform_fee_vat_amount),0) AS money_platform_fee_vat_amount,
           COALESCE(SUM(m.platform_fee_total_amount),0) AS money_platform_fee_total_amount,
           COALESCE(SUM(m.seller_net_amount),0) AS money_seller_net_amount
         FROM siton.platform_fee_money_events m
         WHERE m.deal_id=d.deal_id
           AND m.seller_id=$1
           AND m.logical_entry_type='charge'
       ) ma ON true
       WHERE ${dealWhere}
       ORDER BY d.created_at DESC`,
      dealParams
    ),
    c.query(
      `SELECT
         aa.share_code AS attribution_key,
         af.display_name AS label,
         COUNT(aa.participant_id)::int AS joins_count,
         COALESCE(SUM(p.qty),0) AS attributed_units,
         COALESCE(SUM(
           CASE WHEN p.money_state IN ('ChargedSuccess','RecoveredCharge')
             THEN p.qty * d.price_per_unit + COALESCE(p.delivery_cost,0)
             ELSE 0
           END
         ),0) AS attributed_gross
       FROM siton.affiliate_attributions aa
       JOIN siton.affiliate_accounts af ON af.affiliate_id=aa.affiliate_id
       JOIN siton.participants p ON p.participant_id=aa.participant_id
       JOIN siton.deals d ON d.deal_id=aa.deal_id
       WHERE COALESCE(d.seller_id, $2) = $1${dateClause("aa", cutoff, 3)}
       GROUP BY aa.share_code, af.display_name
       ORDER BY attributed_gross DESC, attributed_units DESC, joins_count DESC
       LIMIT 20`,
      participantParams
    )
  ]);

  const seller = sellerResult.rows[0] || {};
  const sellerReady = isPublishReady(seller);
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
  const participantSummary = participantSummaryResult.rows[0] || {};
  const moneyEvents = moneyEventSummaryResult.rows[0] || {};
  const fallbackMoney = fallbackMoneyResult.rows[0] || {};
  const useStoredMoney = num(moneyEvents.event_count) > 0;
  const fallbackCalculatedMoney = moneyFromGross(num(fallbackMoney.gross_collected_total));
  const moneyTotals = useStoredMoney
    ? {
        gross_collected_total: roundMoney(num(moneyEvents.gross_collected_total)),
        products_total: roundMoney(num(moneyEvents.products_total)),
        delivery_total: roundMoney(num(moneyEvents.delivery_total)),
        platform_fee_base_total: roundMoney(num(moneyEvents.platform_fee_base_total)),
        platform_fee_vat_total: roundMoney(num(moneyEvents.platform_fee_vat_total)),
        platform_fee_total: roundMoney(num(moneyEvents.platform_fee_total)),
        seller_net_total: roundMoney(num(moneyEvents.seller_net_total)),
        total_charged_units: num(moneyEvents.total_charged_units),
        eligible_buyers: num(moneyEvents.eligible_buyers)
      }
    : {
        gross_collected_total: fallbackCalculatedMoney.gross_amount,
        products_total: roundMoney(num(fallbackMoney.products_total)),
        delivery_total: roundMoney(num(fallbackMoney.delivery_total)),
        platform_fee_base_total: fallbackCalculatedMoney.platform_fee_base_amount,
        platform_fee_vat_total: fallbackCalculatedMoney.platform_fee_vat_amount,
        platform_fee_total: fallbackCalculatedMoney.platform_fee_total_amount,
        seller_net_total: fallbackCalculatedMoney.seller_net_amount,
        total_charged_units: num(fallbackMoney.total_charged_units),
        eligible_buyers: num(fallbackMoney.eligible_buyers)
      };
  const dealRows = dealRowsResult.rows as any[];
  const recentDeals = dealRows.slice(0, 10).map(formatDeal);
  const topDeals = dealRows
    .map((row) => {
      const money = dealMoney(row);
      return {
        deal_id: String(row.deal_id),
        title: String(row.title || ""),
        gross_amount: money.gross_amount,
        seller_net_amount: money.seller_net_amount,
        charged_units: num(row.charged_units),
        buyers_count: num(row.buyers_count),
        success_percent: pct(num(row.charged_units), Math.max(1, num(row.threshold_units))),
        completed_at: String(row.state) === "Completed" ? row.updated_at ?? row.created_at ?? null : null
      };
    })
    .filter((row) => row.gross_amount > 0 || row.charged_units > 0)
    .sort((a, b) => b.gross_amount - a.gross_amount || b.charged_units - a.charged_units)
    .slice(0, 5);
  const weakDeals = buildWeakDeals(dealRows, sellerReady);
  const attributionRows = attributionResult.rows as any[];
  const activeMissingUnitsCount = dealRows.filter(
    (row) => ACTIVE_DEAL_STATES.has(String(row.state)) && num(row.joined_units) < num(row.threshold_units)
  ).length;
  const draftMissingImageCount = dealRows.filter((row) => String(row.state) === "Draft" && !row.has_image).length;

  return {
    generated_at: new Date().toISOString(),
    period,
    seller: {
      seller_id: sellerId,
      business_name: String(seller.business_name || ""),
      is_publish_ready: sellerReady
    },
    summary: {
      total_deals: totalDeals,
      draft_deals: draftDeals,
      active_deals: activeDeals,
      completed_deals: completedDeals,
      failed_deals: failedDeals,
      cancelled_deals: cancelledDeals,
      success_rate_percent: pct(completedDeals, terminalDeals),
      gross_collected_total: moneyTotals.gross_collected_total,
      platform_fee_total: moneyTotals.platform_fee_total,
      seller_net_total: moneyTotals.seller_net_total,
      total_joined_units: num(participantSummary.total_joined_units),
      total_charged_units: moneyTotals.total_charged_units,
      total_buyers: num(participantSummary.total_buyers),
      eligible_buyers: moneyTotals.eligible_buyers,
      average_deal_gross: completedDeals > 0 ? roundMoney(moneyTotals.gross_collected_total / completedDeals) : 0,
      average_units_per_completed_deal: completedDeals > 0 ? roundMoney(moneyTotals.total_charged_units / completedDeals) : 0
    },
    money: {
      gross_collected_total: moneyTotals.gross_collected_total,
      products_total: moneyTotals.products_total,
      delivery_total: moneyTotals.delivery_total,
      platform_fee_base_total: moneyTotals.platform_fee_base_total,
      platform_fee_vat_total: moneyTotals.platform_fee_vat_total,
      platform_fee_total: moneyTotals.platform_fee_total,
      seller_net_total: moneyTotals.seller_net_total
    },
    deals_by_state: dealsByState,
    recent_deals: recentDeals,
    top_deals: topDeals,
    weak_deals: weakDeals,
    buyer_funnel: {
      joined_authorized: num(participantSummary.joined_authorized),
      charged_successfully: num(participantSummary.charged_successfully),
      recovered: num(participantSummary.recovered),
      dropped: num(participantSummary.dropped),
      deal_failed: num(participantSummary.deal_failed)
    },
    attribution: {
      measurement_only: true,
      disclaimer_he: "נתוני ייחוס בלבד. סיטון אינה מחשבת עמלה ואינה מבצעת תשלום למפיצים.",
      links_count: attributionRows.length,
      attributed_units: sumRows(attributionRows, (row) => num(row.attributed_units)),
      attributed_gross: sumRows(attributionRows, (row) => num(row.attributed_gross)),
      top_links: attributionRows.slice(0, 5).map((row) => ({
        link_id: String(row.attribution_key || ""),
        label: String(row.label || row.attribution_key || ""),
        attributed_units: num(row.attributed_units),
        attributed_gross: roundMoney(num(row.attributed_gross)),
        joins_count: num(row.joins_count)
      }))
    },
    action_insights: buildActionInsights({
      sellerReady,
      completedDeals,
      draftMissingImageCount,
      activeMissingUnitsCount
    })
  };
}
