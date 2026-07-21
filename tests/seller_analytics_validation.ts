import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = String(process.env.PORT || "3483");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { calculatePlatformFeeMoney } = await import("../src/platform_fee_money.js");

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

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
];

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function seedSeller(label: string, ready = true) {
  const sellerId = `analytics-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.seller_accounts
       (seller_id, display_name, business_name, support_email)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (seller_id) DO UPDATE
     SET business_name=EXCLUDED.business_name, support_email=EXCLUDED.support_email`,
    [
      sellerId,
      `Analytics ${label} Seller`,
      ready ? `Analytics ${label} Seller` : null,
      ready ? `${label}@example.test` : null
    ]
  );
  return sellerId;
}

async function seedDeal(args: {
  sellerId: string;
  state: string;
  title: string;
  price?: number;
  minUnits?: number;
  maxUnits?: number;
  thresholdUnits?: number;
  createdAt?: Date;
  deadline?: Date;
  completionWindowUntil?: Date;
  hasImage?: boolean;
}) {
  const dealId = randomUUID();
  const createdAt = args.createdAt || new Date();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, completion_window_until, created_at, updated_at)
     VALUES ($1,$2,$3,$4::siton.deal_state,$5,$6,$7,$8,
             $10,
             CASE WHEN $4::text='Draft' THEN NULL ELSE $9::timestamptz END,
             $11,
             $9,$9)`,
    [
      dealId,
      args.sellerId,
      args.title,
      args.state,
      args.thresholdUnits ?? 2,
      args.minUnits ?? 2,
      args.maxUnits ?? 20,
      args.price ?? 75,
      createdAt.toISOString(),
      (args.deadline || new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)).toISOString(),
      args.completionWindowUntil ? args.completionWindowUntil.toISOString() : null
    ]
  );
  if (args.hasImage) {
    await pool.query(
      `INSERT INTO siton.deal_images
         (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type, size_bytes, sort_order, is_primary)
       VALUES ($1,'local',$2,$3,'analytics.png','image/png',128,0,true)`,
      [dealId, `deal-images/${dealId}/analytics.png`, `/uploads/deal-images/${dealId}/analytics.png`]
    );
  }
  return dealId;
}

async function seedParticipant(args: {
  dealId: string;
  buyerId: string;
  qty: number;
  buyerState: string;
  moneyState: string;
  deliveryCost?: number;
  createdAt?: Date;
}) {
  const participantId = randomUUID();
  const createdAt = args.createdAt || new Date();
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state,
        buyer_name, buyer_phone, buyer_email, delivery_address, delivery_city, delivery_notes,
        delivery_cost, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'Buyer Name','+972501234567','buyer@example.test',
             'Hidden Street 1','Hidden City','Hidden note',$7,$8,$8)`,
    [
      participantId,
      args.dealId,
      args.buyerId,
      args.qty,
      args.buyerState,
      args.moneyState,
      args.deliveryCost ?? 0,
      createdAt.toISOString()
    ]
  );
  return participantId;
}

async function seedMoneyEvent(args: {
  sellerId: string;
  dealId: string;
  participantId: string;
  gross: number;
  sourceMoneyState: "ChargedSuccess" | "RecoveredCharge";
  createdAt?: Date;
}) {
  const money = calculatePlatformFeeMoney({ grossAmount: args.gross });
  await pool.query(
    `INSERT INTO siton.platform_fee_money_events
       (participant_id, deal_id, seller_id, event_type, logical_entry_type,
        provider_code, provider_event_id, provider_reference, correlation_id, source_money_state,
        payout_readiness_status, gross_amount, vat_amount, fee_base_amount,
        platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount,
        platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount,
        seller_net_amount, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'charge',
             'analytics-test',$5,NULL,$6,$7,
             'ready_for_settlement',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
    [
      args.participantId,
      args.dealId,
      args.sellerId,
      args.sourceMoneyState === "RecoveredCharge" ? "recovery_captured" : "charge_captured",
      `analytics-${randomUUID()}`,
      `analytics-${args.participantId}`,
      args.sourceMoneyState,
      money.gross_amount,
      money.vat_amount,
      money.fee_base_amount,
      money.platform_fee_rate,
      money.platform_fee_vat_rate,
      money.platform_fee_base_amount,
      money.platform_fee_vat_amount,
      money.platform_fee_total_amount,
      money.platform_fee_amount,
      money.seller_net_amount,
      (args.createdAt || new Date()).toISOString()
    ]
  );
  return money;
}

async function seedAttribution(args: {
  dealId: string;
  participantId: string;
  shareCode: string;
  label: string;
}) {
  const affiliateId = randomUUID();
  await pool.query(
    `INSERT INTO siton.affiliate_accounts (affiliate_id, affiliate_code, display_name, verification_status)
     VALUES ($1,$2,$3,'verified')`,
    [affiliateId, `analytics-${args.shareCode}-${randomUUID().slice(0, 6)}`, args.label]
  );
  await pool.query(
    `INSERT INTO siton.affiliate_attributions (affiliate_id, deal_id, participant_id, share_code)
     VALUES ($1,$2,$3,$4)`,
    [affiliateId, args.dealId, args.participantId, args.shareCode]
  );
  return affiliateId;
}

async function cleanup(sellerIds: string[], dealIds: string[], affiliateIds: string[]) {
  for (const affiliateId of affiliateIds) {
    await pool.query(`DELETE FROM siton.affiliate_accounts WHERE affiliate_id=$1`, [affiliateId]).catch(() => undefined);
  }
  for (const dealId of dealIds) {
    await pool.query(`DELETE FROM siton.platform_fee_money_events WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.deal_images WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  }
  for (const sellerId of sellerIds) {
    await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [sellerId]).catch(() => undefined);
  }
}

async function getAnalytics(sellerId: string, query = "") {
  return app.inject({
    method: "GET",
    url: `/api/seller/analytics${query}`,
    headers: { "x-seller-id": sellerId }
  });
}

function assertShape(payload: any) {
  for (const key of [
    "generated_at",
    "period",
    "seller",
    "overview",
    "deals",
    "summary",
    "money",
    "deals_by_state",
    "recent_deals",
    "top_deals",
    "weak_deals",
    "buyer_funnel",
    "attribution",
    "action_insights"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `missing ${key}`);
  }
}

function assertNoForbiddenFields(payload: any) {
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const forbidden of [
    "buyer_phone",
    "buyer_email",
    "delivery_address",
    "payment_token",
    "provider_reference",
    "storage_key",
    "authorization_id",
    "payment_method",
    "commission",
    "payout",
    "balance",
    "withdrawal",
    "revenue_share",
    "affiliate_fee"
  ]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not be exposed`);
  }
}

function stateCount(payload: any, state: string) {
  return Number(payload.deals_by_state.find((row: any) => row.state === state)?.count || 0);
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

const sellerA = await seedSeller("a");
const sellerB = await seedSeller("b");
const sellerEmpty = await seedSeller("empty", false);
const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

const draftDeal = await seedDeal({ sellerId: sellerA, state: "Draft", title: "Analytics Draft" });
const activeDeal = await seedDeal({ sellerId: sellerA, state: "PendingTarget", title: "Analytics Active", minUnits: 10, thresholdUnits: 9 });
const nearDeadlineDeal = await seedDeal({
  sellerId: sellerA,
  state: "PendingTarget",
  title: "Analytics Near Deadline",
  minUnits: 6,
  thresholdUnits: 6,
  deadline: new Date(Date.now() + 3 * 60 * 60 * 1000)
});
const completionWindowDeal = await seedDeal({
  sellerId: sellerA,
  state: "CompletionWindow",
  title: "Analytics Completion Window",
  minUnits: 2,
  thresholdUnits: 2,
  deadline: new Date(Date.now() + 60 * 60 * 1000),
  completionWindowUntil: new Date(Date.now() + 8 * 60 * 60 * 1000)
});
const completedSmall = await seedDeal({ sellerId: sellerA, state: "Completed", title: "Analytics Completed Small", price: 100, hasImage: true });
const completedBig = await seedDeal({ sellerId: sellerA, state: "Completed", title: "Analytics Completed Big", price: 200, hasImage: true });
const failedDeal = await seedDeal({ sellerId: sellerA, state: "Failed", title: "Analytics Failed" });
const cancelledDeal = await seedDeal({ sellerId: sellerA, state: "Cancelled", title: "Analytics Cancelled" });
const oldCompleted = await seedDeal({
  sellerId: sellerA,
  state: "Completed",
  title: "Analytics Old Completed",
  price: 100,
  createdAt: oldDate,
  hasImage: true
});
const sellerBDeal = await seedDeal({ sellerId: sellerB, state: "Completed", title: "Other Seller Completed", price: 999, hasImage: true });

const dealIds = [draftDeal, activeDeal, nearDeadlineDeal, completionWindowDeal, completedSmall, completedBig, failedDeal, cancelledDeal, oldCompleted, sellerBDeal];
const affiliateIds: string[] = [];

const activeParticipant = await seedParticipant({
  dealId: activeDeal,
  buyerId: "buyer-active",
  qty: 3,
  buyerState: "JoinedAuthorized",
  moneyState: "AuthHeld"
});
const charged1 = await seedParticipant({
  dealId: completedSmall,
  buyerId: "buyer-charged-1",
  qty: 2,
  buyerState: "DealCompleted",
  moneyState: "ChargedSuccess",
  deliveryCost: 10
});
const recovered1 = await seedParticipant({
  dealId: completedSmall,
  buyerId: "buyer-recovered-1",
  qty: 1,
  buyerState: "DealCompleted",
  moneyState: "RecoveredCharge",
  deliveryCost: 5
});
await seedParticipant({
  dealId: completedSmall,
  buyerId: "buyer-dropped",
  qty: 5,
  buyerState: "Dropped",
  moneyState: "AuthReleased"
});
await seedParticipant({
  dealId: completedSmall,
  buyerId: "buyer-failed",
  qty: 4,
  buyerState: "DealFailed",
  moneyState: "AuthReleased"
});
const chargedTop = await seedParticipant({
  dealId: completedBig,
  buyerId: "buyer-top",
  qty: 3,
  buyerState: "DealCompleted",
  moneyState: "ChargedSuccess",
  deliveryCost: 20
});
await seedParticipant({
  dealId: failedDeal,
  buyerId: "buyer-failed-deal",
  qty: 2,
  buyerState: "DealFailed",
  moneyState: "AuthReleased"
});
await seedParticipant({
  dealId: nearDeadlineDeal,
  buyerId: "buyer-near-deadline",
  qty: 2,
  buyerState: "JoinedAuthorized",
  moneyState: "AuthHeld"
});
await seedParticipant({
  dealId: completionWindowDeal,
  buyerId: "buyer-completion-window",
  qty: 2,
  buyerState: "ChargeFailedCompletion",
  moneyState: "ChargeFailedRecovery"
});
const oldCharged = await seedParticipant({
  dealId: oldCompleted,
  buyerId: "buyer-old",
  qty: 10,
  buyerState: "DealCompleted",
  moneyState: "ChargedSuccess",
  createdAt: oldDate
});
await seedParticipant({
  dealId: sellerBDeal,
  buyerId: "buyer-other-seller",
  qty: 9,
  buyerState: "DealCompleted",
  moneyState: "ChargedSuccess",
  deliveryCost: 1
});

const moneyRows = [
  await seedMoneyEvent({ sellerId: sellerA, dealId: completedSmall, participantId: charged1, gross: 210, sourceMoneyState: "ChargedSuccess" }),
  await seedMoneyEvent({ sellerId: sellerA, dealId: completedSmall, participantId: recovered1, gross: 105, sourceMoneyState: "RecoveredCharge" }),
  await seedMoneyEvent({ sellerId: sellerA, dealId: completedBig, participantId: chargedTop, gross: 620, sourceMoneyState: "ChargedSuccess" }),
  await seedMoneyEvent({ sellerId: sellerA, dealId: oldCompleted, participantId: oldCharged, gross: 1000, sourceMoneyState: "ChargedSuccess", createdAt: oldDate })
];

affiliateIds.push(await seedAttribution({
  dealId: completedSmall,
  participantId: charged1,
  shareCode: "share-small",
  label: "Small Share"
}));
affiliateIds.push(await seedAttribution({
  dealId: completedBig,
  participantId: chargedTop,
  shareCode: "share-big",
  label: "Big Share"
}));

const expectedAll = {
  gross: round2(moneyRows.reduce((sum, row) => sum + row.gross_amount, 0)),
  feeBase: round2(moneyRows.reduce((sum, row) => sum + row.platform_fee_base_amount, 0)),
  feeVat: round2(moneyRows.reduce((sum, row) => sum + row.platform_fee_vat_amount, 0)),
  feeTotal: round2(moneyRows.reduce((sum, row) => sum + row.platform_fee_total_amount, 0)),
  sellerNet: round2(moneyRows.reduce((sum, row) => sum + row.seller_net_amount, 0))
};
const expectedRecent = {
  gross: 935,
  feeTotal: round2(moneyRows.slice(0, 3).reduce((sum, row) => sum + row.platform_fee_total_amount, 0))
};

try {
  await run("endpoint exists, returns full shape, and counts seller states", async () => {
    const res = await getAnalytics(sellerA);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assertShape(body);
    assert.equal(body.period, "all");
    assert.equal(body.seller.seller_id, sellerA);
    assert.equal(body.seller.business_name, "Analytics a Seller");
    assert.equal(body.seller.is_publish_ready, true);
    assert.equal(body.summary.total_deals, 9);
    assert.equal(body.summary.draft_deals, 1);
    assert.equal(body.summary.active_deals, 3);
    assert.equal(body.summary.completed_deals, 3);
    assert.equal(body.summary.failed_deals, 1);
    assert.equal(body.summary.cancelled_deals, 1);
    assert.equal(body.summary.success_rate_percent, 60);
    assert.deepEqual(body.deals_by_state.map((row: any) => row.state), DEAL_STATES);
    assert.equal(stateCount(body, "PendingTarget"), 2);
    assertNoForbiddenFields(body);
  });

  await run("phase 1 compact overview and deals shape is present", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assert.ok(body.generated_at);
    assert.ok(body.overview);
    assert.ok(Array.isArray(body.deals));
    assert.equal(body.overview.active_deals_count, 4);
    assert.equal(body.overview.completed_deals_count, 3);
    assert.equal(body.overview.failed_deals_count, 2);
    assert.equal(body.overview.risk_deals_count, 3);
    assert.equal(body.overview.total_joined_units, 34);
    assert.equal(body.overview.total_charged_units, 16);
    assert.equal(body.overview.gross_collected_amount, expectedAll.gross);
    assert.equal(body.overview.platform_fee_total_amount, expectedAll.feeTotal);
    assert.equal(body.overview.seller_net_amount, expectedAll.sellerNet);

    const compact = body.deals.find((deal: any) => deal.deal_id === completedSmall);
    assert.ok(compact);
    assert.equal(compact.status_label, "הושלמה");
    assert.equal(compact.current_units, 12);
    assert.equal(compact.charged_units, 3);
    assert.equal(compact.pending_units, 0);
    assert.equal(compact.failed_units, 9);
    assert.equal(compact.progress_to_minimum_percent, 100);
    assert.equal(compact.gross_collected_amount, 315);
  });

  await run("money totals use stored canonical platform fee events", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assert.equal(body.money.gross_collected_total, expectedAll.gross);
    assert.equal(body.money.products_total, 1900);
    assert.equal(body.money.delivery_total, 35);
    assert.equal(body.money.platform_fee_base_total, expectedAll.feeBase);
    assert.equal(body.money.platform_fee_vat_total, expectedAll.feeVat);
    assert.equal(body.money.platform_fee_total, expectedAll.feeTotal);
    assert.equal(body.money.seller_net_total, expectedAll.sellerNet);
    assert.equal(body.summary.gross_collected_total, expectedAll.gross);
    assert.equal(body.summary.platform_fee_total, expectedAll.feeTotal);
    assert.equal(body.summary.seller_net_total, expectedAll.sellerNet);
    assert.equal(body.summary.total_charged_units, 16);
    assert.equal(body.summary.eligible_buyers, 4);
  });

  await run("dropped and failed participants are excluded from collected money but counted in funnel", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assert.equal(body.summary.total_joined_units, 34);
    assert.equal(body.summary.total_buyers, 10);
    assert.equal(body.buyer_funnel.joined_authorized, 2);
    assert.equal(body.buyer_funnel.charged_successfully, 3);
    assert.equal(body.buyer_funnel.recovered, 1);
    assert.equal(body.buyer_funnel.dropped, 1);
    assert.equal(body.buyer_funnel.deal_failed, 2);
    assert.equal(body.money.gross_collected_total, 1935);
  });

  await run("recent deals are own-seller only and expose safe flags", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assert.ok(body.recent_deals.length >= 9);
    assert.ok(body.recent_deals.every((deal: any) => deal.deal_id !== sellerBDeal));
    const completed = body.recent_deals.find((deal: any) => deal.deal_id === completedSmall);
    assert.ok(completed);
    assert.equal(completed.has_excel_export_available, true);
    assert.equal(completed.can_duplicate, true);
    assert.equal(completed.has_image, true);
    assert.equal(completed.gross_amount, 315);
  });

  await run("top deals are sorted by gross and charged units", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assert.ok(body.top_deals.length >= 2);
    assert.equal(body.top_deals[0].deal_id, oldCompleted);
    assert.equal(body.top_deals[0].gross_amount, 1000);
    assert.equal(body.top_deals[1].deal_id, completedBig);
    assert.equal(body.top_deals[1].gross_amount, 620);
  });

  await run("weak deals include failed, under-target active, and draft readiness issues", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    const reasons = body.weak_deals.map((deal: any) => deal.reason);
    assert.ok(reasons.includes("failed_below_target"));
    assert.ok(reasons.includes("active_missing_units"));
    assert.ok(reasons.includes("draft_missing_image"));
    const activeWeak = body.weak_deals.find((deal: any) => deal.deal_id === activeDeal);
    assert.equal(activeWeak.missing_units_to_target, 6);
  });

  await run("compact risk and progress rules match phase 1 definitions", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    const completion = body.deals.find((deal: any) => deal.deal_id === completionWindowDeal);
    assert.ok(completion);
    assert.equal(completion.risk_level, "high");
    assert.ok(completion.risk_reasons.includes("חלון השלמה פתוח"));
    assert.ok(completion.risk_reasons.includes("יש יחידות בהמתנה להשלמה"));

    const nearDeadline = body.deals.find((deal: any) => deal.deal_id === nearDeadlineDeal);
    assert.ok(nearDeadline);
    assert.equal(nearDeadline.risk_level, "high");
    assert.equal(nearDeadline.progress_to_minimum_percent, 33);

    const active = body.deals.find((deal: any) => deal.deal_id === activeDeal);
    assert.ok(active);
    assert.equal(active.progress_to_minimum_percent, 30);
    assert.equal(active.risk_level, "medium");
    assert.ok(active.risk_reasons.includes("יש יחידות בהמתנה להשלמה"));
  });

  await run("attribution remains measurement only with no payout semantics", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assert.equal(body.attribution.measurement_only, true);
    assert.match(body.attribution.disclaimer_he, /נתוני ייחוס בלבד/);
    assert.equal(body.attribution.links_count, 2);
    assert.equal(body.attribution.attributed_units, 5);
    assert.equal(body.attribution.attributed_gross, 830);
    assert.equal(body.attribution.top_links[0].link_id, "share-big");
    assertNoForbiddenFields(body);
  });

  await run("action insights are data-backed and bounded", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assert.ok(body.action_insights.length <= 6);
    const types = body.action_insights.map((insight: any) => insight.type);
    assert.ok(types.includes("completed_deals_excel_available"));
    assert.ok(types.includes("completed_deals_available_to_duplicate"));
    assert.ok(types.includes("drafts_missing_image"));
    assert.ok(types.includes("active_deals_missing_units"));
  });

  await run("period filter keeps 30d metrics scoped to recent records", async () => {
    const res = await getAnalytics(sellerA, "?period=30d");
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.equal(body.period, "30d");
    assert.equal(body.summary.total_deals, 8);
    assert.equal(body.summary.completed_deals, 2);
    assert.equal(body.summary.success_rate_percent, 50);
    assert.equal(body.money.gross_collected_total, expectedRecent.gross);
    assert.equal(body.money.platform_fee_total, expectedRecent.feeTotal);
    assert.equal(body.summary.total_charged_units, 6);
    assert.equal(body.summary.eligible_buyers, 3);
    assert.equal(body.top_deals[0].deal_id, completedBig);
  });

  await run("valid periods and invalid period handling remain stable", async () => {
    for (const period of ["90d", "year"]) {
      const res = await getAnalytics(sellerA, `?period=${period}`);
      assert.equal(res.statusCode, 200, `${period}: ${res.body}`);
      assert.equal((res.json() as any).period, period);
    }
    const invalid = await getAnalytics(sellerA, "?period=week");
    assert.equal(invalid.statusCode, 400);
    assert.equal((invalid.json() as any).code, "invalid_period");
  });

  await run("seller isolation and external seller_id override protection stay enforced", async () => {
    const sellerBRes = await getAnalytics(sellerB);
    assert.equal(sellerBRes.statusCode, 200, sellerBRes.body);
    const sellerBBody = sellerBRes.json() as any;
    assert.equal(sellerBBody.seller.seller_id, sellerB);
    assert.equal(sellerBBody.summary.total_deals, 1);
    assert.equal(sellerBBody.summary.completed_deals, 1);

    const queryRes = await getAnalytics(sellerA, `?period=all&seller_id=${encodeURIComponent(sellerB)}`);
    assert.equal(queryRes.statusCode, 200, queryRes.body);
    assert.equal((queryRes.json() as any).seller.seller_id, sellerA);
    assert.equal((queryRes.json() as any).summary.total_deals, 9);

    const bodyRes = await app.inject({
      method: "GET",
      url: "/api/seller/analytics",
      headers: { "content-type": "application/json", "x-seller-id": sellerA },
      payload: { seller_id: sellerB }
    });
    assert.equal(bodyRes.statusCode, 200, bodyRes.body);
    assert.equal((bodyRes.json() as any).seller.seller_id, sellerA);
    assert.equal((bodyRes.json() as any).summary.total_deals, 9);
  });

  await run("empty seller receives full zero response", async () => {
    const res = await getAnalytics(sellerEmpty);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assertShape(body);
    assert.equal(body.summary.total_deals, 0);
    assert.equal(body.overview.active_deals_count, 0);
    assert.equal(body.money.gross_collected_total, 0);
    assert.deepEqual(body.deals, []);
    assert.deepEqual(body.recent_deals, []);
    assert.deepEqual(body.top_deals, []);
    assert.deepEqual(body.weak_deals, []);
    assertNoForbiddenFields(body);
  });

  await run("response does not leak buyer PII or internal references", async () => {
    const body = (await getAnalytics(sellerA)).json() as any;
    assertNoForbiddenFields(body);
  });
} finally {
  await cleanup([sellerA, sellerB, sellerEmpty], dealIds, affiliateIds);
  void activeParticipant;
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
