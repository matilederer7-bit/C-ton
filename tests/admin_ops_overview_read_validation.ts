// Admin ops overview reads — behavioural proof for the three read-only admin
// console routes that live in src/admin_ops_overview_routes.ts (Lean
// Refactor): GET /api/admin/payment-ops-status, /api/admin/overview and
// /api/admin/launch-console.
//
// Through the real app and the real database this proves, for each route:
//   * an authorised admin gets 200 and the exact response sections;
//   * an anonymous caller, a wrong ops key, a forged admin session cookie and
//     a forged bearer token are all refused with 401 admin_auth_required;
//   * the figures come from the same sources as before: the payment, webhook,
//     card-on-file and platform-fee tables (payment-ops-status), the canonical
//     settlement rule and money helpers (overview), the per-deal seller legal
//     acceptance and the runtime's notification summary (launch-console);
//   * scoping holds: the overview search only returns matching entities and
//     trims the query, and a seller-terms acceptance only counts for the deal's
//     own seller (the default seller when the deal has none);
//   * the three routes only read: no table they touch, nor the outbox or the
//     audit log, changes when they are called.
// payment-ops-status is money-adjacent: this test only seeds local test rows
// and reads them back; no capture, refund, payout or provider call happens.
// The seeded rows follow the money canon (audited state chains, a successful
// capture attempt and a charge fee row behind every charged participant,
// refunds as signed reversals on a Refunded participant), and the test proves
// it: the money invariants report no failure the fixtures did not find.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";
import { computeCustomerChargeVat } from "../src/vat_authority.js";
import { DEFAULT_SELLER_ID, summarizeMoney } from "../src/product_surface_support.js";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3471");
process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `ops-overview-admin-${randomUUID().slice(0, 8)}`;
process.env.SELLER_SESSION_SECRET = process.env.SELLER_SESSION_SECRET || "seller-session-secret-ops-overview-read-validation";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-ops-overview-read-validation";

const { app } = await import("../src/app.js");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };
const ROUTES = ["/api/admin/payment-ops-status", "/api/admin/overview", "/api/admin/launch-console"] as const;
const moneyInvariants = createRequire(import.meta.url)(path.join(process.cwd(), "scripts", "lib", "money_invariants.cjs"));
async function failingInvariants(): Promise<string[]> {
  const client = await pool.connect();
  try {
    return moneyInvariants.failingNames(await moneyInvariants.runInvariants(client)).sort();
  } finally {
    client.release();
  }
}

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.stack || error?.message || error}`);
  }
}

async function get(url: string, headers: Record<string, string> = ADMIN) {
  const res = await app.inject({ method: "GET", url, headers });
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res.json() as any;
}
const num = (value: unknown) => Number(value ?? 0);

const tag = `opsov${randomUUID().slice(0, 8)}`;
const sellerId = `ops-overview-seller-${tag}`;
const otherSellerId = `ops-overview-other-${tag}`;

async function seller(id: string, profile: { business: string | null; email: string | null }) {
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
     VALUES ($1,$1,$2,$3,'approved','active') ON CONFLICT (seller_id) DO NOTHING`,
    [id, profile.business, profile.email]
  );
}
// Canonical state chains, audited the way tests/db_money_invariants_validation.ts seeds them.
const DEAL_CHAINS: Record<string, string[]> = {
  Draft: ["Draft"],
  PendingTarget: ["Draft", "PendingTarget"],
  Completed: ["Draft", "PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow", "Completed"]
};
const BUYER_CHARGED = ["NotJoined", "JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargedSuccess"];
const MONEY_CHARGED = ["NoFinancial", "AuthHeld", "AuthLocked", "ChargeAttempt", "ChargedSuccess"];
const PARTICIPANT_CHAINS = {
  charged: { buyer: [...BUYER_CHARGED, "DealCompleted"], money: MONEY_CHARGED },
  refunded: { buyer: [...BUYER_CHARGED, "DealFailed"], money: [...MONEY_CHARGED, "Refunded"] },
  // a failed charge that was never recovered: the authorization is released, no money moved
  dropped: {
    buyer: ["NotJoined", "JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargeFailedCompletion", "Dropped"],
    money: ["NoFinancial", "AuthHeld", "AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "AuthReleased"]
  }
};

async function audit(entity: "deal" | "participant", entityId: string, dealId: string, stateType: string, chain: string[]) {
  for (let i = 1; i < chain.length; i += 1) {
    await pool.query(
      `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'test.ops_overview_fixture',$7,$7,$8,'{"fixture":"ops_overview"}'::jsonb, now() - make_interval(mins => $9))`,
      [entity, entityId, dealId, stateType, chain[i - 1], chain[i], `opsov:${randomUUID()}`, `opsov:${entityId}:${stateType}:${chain[i]}`, 90 - i]
    );
  }
}
async function deal(state: keyof typeof DEAL_CHAINS, price: number, owner: string | null, title = `Ops overview ${tag}`) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units, price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,2,2,50,$5, now()+interval '7 days', $6, clock_timestamp(), clock_timestamp())`,
    [dealId, owner, title, state, price, state === "Draft" ? null : new Date(Date.now() - 2 * 3600_000)]
  );
  await audit("deal", dealId, dealId, "deal_state", DEAL_CHAINS[state]!);
  return dealId;
}
async function participant(dealId: string, path: keyof typeof PARTICIPANT_CHAINS, qty: number, deliveryCost: number) {
  const participantId = randomUUID();
  const chain = PARTICIPANT_CHAINS[path];
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, buyer_name, buyer_phone, delivery_cost, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'0500000000',$8,now(),now())`,
    [participantId, dealId, `buyer-${tag}-${participantId.slice(0, 6)}`, qty, chain.buyer[chain.buyer.length - 1], chain.money[chain.money.length - 1], `Buyer ${tag}`, deliveryCost]
  );
  await audit("participant", participantId, dealId, "buyer_state", chain.buyer);
  await audit("participant", participantId, dealId, "money_state", chain.money);
  return participantId;
}
async function recordAttempt(participantId: string, dealId: string, type: "charge_start" | "refund", correlation: string) {
  await pool.query(
    `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, resolved_at)
     VALUES ($1,$2,$3,'success',$4,'responded',now())`,
    [participantId, dealId, type, correlation]
  );
}
// Canonical 8% fee on (gross - VAT), VAT 0 in synthetic mode, 18% VAT on the fee; a refund is the signed reversal.
async function feeRow(participantId: string, dealId: string, gross: number, kind: "charge" | "refund", correlation: string) {
  const sign = kind === "refund" ? -1 : 1;
  const base = Math.round(gross * 0.08 * 100) / 100;
  const vat = Math.round(base * 0.18 * 100) / 100;
  const total = Math.round((base + vat) * 100) / 100;
  const amounts = [gross, 0, gross, base, vat, total, total, Math.round((gross - total) * 100) / 100].map((v) => Math.round(v * sign * 100) / 100);
  await pool.query(
    `INSERT INTO siton.platform_fee_money_events (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, correlation_id, source_money_state, payout_readiness_status,
       gross_amount, vat_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount)
     VALUES ($1,$2,$3,$4,$5,'mockpay',$6,$7,$8,$9,$10,$11,0.08,0.18,$12,$13,$14,$15,$16)`,
    [participantId, dealId, sellerId, kind === "refund" ? "refund_issued" : "charge_captured", kind === "refund" ? "refund_adjustment" : "charge", correlation,
      kind === "refund" ? "Refunded" : "ChargedSuccess", kind === "refund" ? "reversed_after_refund" : "ready_for_settlement", ...amounts]
  );
  return { gross: amounts[0], total: amounts[5] };
}

// Rows the three routes read or could write: every row must stay byte-identical across the calls.
const WATCHED_TABLES = [
  "payment_attempts", "platform_fee_money_events", "webhook_events", "payment_webhook_security_events", "buyer_payment_methods",
  "deals", "participants", "seller_accounts", "support_tickets", "legal_acceptances", "notification_events",
  "outbox_events", "outbox_dlq", "audit_log"
];
async function tableFingerprints() {
  const out: Record<string, string> = {};
  for (const table of WATCHED_TABLES) {
    const row = (await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM siton.${table} t`)).rows[0];
    out[table] = `${row.n}:${row.digest}`;
  }
  return out;
}

const invariantsBefore = await failingInvariants();
await seller(sellerId, { business: `Ops Overview ${tag}`, email: `${tag}@example.test` });
await seller(otherSellerId, { business: `Other ${tag}`, email: `other-${tag}@example.test` });

await run("every route refuses anonymous, wrong-key, forged-session and forged-bearer callers with 401", async () => {
  const forged = [
    {},
    { "x-admin-key": "not-the-admin-key" },
    { cookie: `siton_admin_session=${randomUUID()}.${randomUUID()}` },
    { authorization: `Bearer ${randomUUID()}` },
    { cookie: `siton_admin_session=${randomUUID()}`, "x-admin-key": `${process.env.ADMIN_API_KEY}x` }
  ];
  for (const url of ROUTES) {
    for (const headers of forged) {
      const res = await app.inject({ method: "GET", url, headers: headers as any });
      assert.equal(res.statusCode, 401, `${url} ${JSON.stringify(Object.keys(headers))}: ${res.body}`);
      assert.equal(res.json().error, "admin_auth_required", url);
      assert.ok(!res.body.includes(String(process.env.ADMIN_API_KEY)), "the key is never echoed");
    }
  }
});

await run("payment-ops-status: exact sections, figures from the payment, webhook, card-on-file and fee-ledger tables", async () => {
  const before = await get("/api/admin/payment-ops-status");
  const dealId = await deal("Completed", 100, sellerId, `Payment ops ${tag}`);
  const participantId = await participant(dealId, "charged", 1, 8);
  const correlation = `corr-${tag}`;
  await recordAttempt(participantId, dealId, "charge_start", correlation);
  // a refunded order: its charge, then the signed refund reversal
  const refundedId = await participant(dealId, "refunded", 1, 0);
  await recordAttempt(refundedId, dealId, "charge_start", `${correlation}-r-charge`);
  await recordAttempt(refundedId, dealId, "refund", `${correlation}-r-refund`);
  await pool.query(
    `INSERT INTO siton.webhook_events (provider, event_id, payload_jsonb, status) VALUES ('mockpay',$1,'{}'::jsonb,'processed'), ('mockpay',$2,'{}'::jsonb,'ignored')`,
    [`evt-${tag}-1`, `evt-${tag}-2`]
  );
  await pool.query(`INSERT INTO siton.payment_webhook_security_events (provider, event_id, failure_reason) VALUES ('mockpay',$1,'signature_mismatch')`, [`evt-${tag}-sig`]);
  await pool.query(
    `INSERT INTO siton.buyer_payment_methods (buyer_id, provider_code, provider_payment_method_id, status) VALUES ($1,'mockpay',$2,'active'), ($1,'mockpay',$3,'revoked')`,
    [`buyer-${tag}`, `pm-${tag}-1`, `pm-${tag}-2`]
  );
  const charged = await feeRow(participantId, dealId, 108, "charge", correlation);
  const refundedCharge = await feeRow(refundedId, dealId, 100, "charge", `${correlation}-r-charge`);
  // the refund reversal: never part of the charged gross, counted as a refund entry, netted in the fee total
  const refund = await feeRow(refundedId, dealId, 100, "refund", `${correlation}-r-refund`);
  assert.deepEqual([charged, refundedCharge, refund], [{ gross: 108, total: 10.2 }, { gross: 100, total: 9.44 }, { gross: -100, total: -9.44 }], "canonical fee rows");
  const body = await get("/api/admin/payment-ops-status");

  assert.deepEqual(Object.keys(body), ["ok", "provider", "attempts_by_type", "webhook_reconciliation", "webhook_security", "buyer_payment_methods", "fee_ledger", "recent_attempts", "recent_ledger"]);
  assert.equal(body.ok, true);
  // the provider block is the runtime's provider summary, the same one the demo-readiness check reports
  const readiness = await get("/api/admin/demo-readiness");
  assert.equal(body.provider.provider, readiness.providers.payment.provider);
  assert.equal(body.provider.mode, readiness.providers.payment.mode);
  assert.equal(body.provider.configured, readiness.providers.payment.configured);
  assert.equal(body.provider.mock_backed, readiness.providers.payment.is_mock);

  const charge = (b: any) => b.attempts_by_type.find((row: any) => row.attempt_type === "charge_start") || { success: 0, temporary_fail: 0, permanent_fail: 0, unknown: 0 };
  assert.equal(charge(body).success - charge(before).success, 2, "two more successful charge attempts");
  const refunds = (b: any) => b.attempts_by_type.find((row: any) => row.attempt_type === "refund") || { success: 0 };
  assert.equal(refunds(body).success - refunds(before).success, 1, "one more successful refund attempt");
  const attemptTruth = (await pool.query(`SELECT attempt_type, COUNT(*)::int AS n FROM siton.payment_attempts GROUP BY attempt_type ORDER BY attempt_type`)).rows;
  assert.deepEqual(body.attempts_by_type.map((row: any) => row.attempt_type), attemptTruth.map((row: any) => row.attempt_type), "grouped by attempt type, ordered");
  for (const row of body.attempts_by_type) {
    const total = attemptTruth.find((t: any) => t.attempt_type === row.attempt_type)!.n;
    assert.equal(row.success + row.temporary_fail + row.permanent_fail + row.unknown, total, `${row.attempt_type}: every attempt counted once`);
  }

  assert.equal(body.webhook_reconciliation.processed - before.webhook_reconciliation.processed, 1);
  assert.equal(body.webhook_reconciliation.ignored - before.webhook_reconciliation.ignored, 1);
  const hooks = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status='ignored')::int AS ignored, COUNT(*)::int AS total FROM siton.webhook_events`)).rows[0];
  assert.equal(body.webhook_reconciliation.duplicate_rate, Number((hooks.ignored / hooks.total).toFixed(4)), "duplicate rate = ignored / all webhook events");

  assert.equal(body.webhook_security.signature_failures - before.webhook_security.signature_failures, 1);
  assert.ok(body.webhook_security.latest_signature_failure_at, "latest signature failure reported");

  assert.equal(body.buyer_payment_methods.active - before.buyer_payment_methods.active, 1);
  assert.equal(body.buyer_payment_methods.revoked - before.buyer_payment_methods.revoked, 1);
  assert.equal(body.buyer_payment_methods.hosted_payment_only, true);

  const ledgerTruth = (await pool.query(
    `SELECT COALESCE(SUM(gross_amount) FILTER (WHERE logical_entry_type='charge'),0)::numeric(14,2) AS gross_charged,
            COALESCE(SUM(platform_fee_base_amount),0)::numeric(14,2) AS fee_base,
            COALESCE(SUM(platform_fee_vat_amount),0)::numeric(14,2) AS fee_vat,
            COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_total,
            COUNT(*)::int AS entries,
            COUNT(*) FILTER (WHERE event_type='refund_issued')::int AS refund_entries
       FROM siton.platform_fee_money_events`
  )).rows[0];
  for (const key of ["gross_charged", "fee_base", "fee_vat", "fee_total", "entries", "refund_entries"]) {
    assert.equal(body.fee_ledger[key], Number(ledgerTruth[key]), `fee_ledger.${key} is the ledger's own figure`);
  }
  assert.equal(Number((body.fee_ledger.gross_charged - before.fee_ledger.gross_charged).toFixed(2)), 208, "only charge entries make the charged gross (108 + 100; the -100 reversal is excluded)");
  assert.equal(Number((body.fee_ledger.fee_total - before.fee_ledger.fee_total).toFixed(2)), 10.2, "the fee total nets the signed reversal (10.20 + 9.44 - 9.44)");
  assert.equal(body.fee_ledger.entries - before.fee_ledger.entries, 3);
  assert.equal(body.fee_ledger.refund_entries - before.fee_ledger.refund_entries, 1);
  assert.equal(body.fee_ledger.note, "Siton fee = 8% of the authoritative charge base (incl. delivery, excl. VAT), from successful charges only");

  const attempt = body.recent_attempts.find((row: any) => row.correlation_id === correlation);
  assert.ok(attempt, "the new attempt is in the recent list");
  assert.deepEqual(Object.keys(attempt), ["attempt_id", "attempt_type", "result_class", "correlation_id", "created_at", "deal_id", "deal_title", "buyer_name"]);
  assert.equal(attempt.deal_id, dealId);
  assert.equal(attempt.deal_title, `Payment ops ${tag}`);
  assert.equal(attempt.buyer_name, `Buyer ${tag}`);
  assert.ok(body.recent_attempts.length <= 40);
  const entry = body.recent_ledger.find((row: any) => row.correlation_id === correlation);
  assert.ok(entry, "the new ledger entry is in the recent list");
  assert.deepEqual(entry, {
    event_type: "charge_captured",
    logical_entry_type: "charge",
    correlation_id: correlation,
    created_at: entry.created_at,
    gross_amount: 108,
    platform_fee_total_amount: 10.2,
    deal_id: dealId,
    deal_title: `Payment ops ${tag}`
  });
  assert.ok(body.recent_ledger.length <= 25);
});

await run("overview: exact sections, a scoped and trimmed search, settlement from charged money through the money helpers", async () => {
  const dealId = await deal("Completed", 100, sellerId, `Overview ${tag}`);
  const chargedId = await participant(dealId, "charged", 2, 20);
  await recordAttempt(chargedId, dealId, "charge_start", `overview-${tag}`);
  await feeRow(chargedId, dealId, 220, "charge", `overview-${tag}`);
  await participant(dealId, "dropped", 3, 20);
  const draftId = await deal("Draft", 40, sellerId, `Unrelated draft ${randomUUID().slice(0, 8)}`);

  const body = await get(`/api/admin/overview?q=${encodeURIComponent(`  ${tag}  `)}`);
  assert.deepEqual(Object.keys(body), ["ok", "q", "admin_surface"]);
  assert.equal(body.q, tag, "the query is trimmed");
  const surface = body.admin_surface;
  assert.deepEqual(Object.keys(surface), ["totals", "deals", "exceptional_deals", "search_results", "kyc_queue", "settlements", "support_tickets", "forensics"]);
  assert.deepEqual(Object.keys(surface.totals), ["deals", "live", "exceptional", "draft"]);
  assert.ok(surface.deals.length <= 20 && surface.exceptional_deals.length <= 12);

  const results = surface.search_results;
  assert.ok(results.some((row: any) => row.entity_type === "deal" && row.entity_id === dealId), "the matching deal is found");
  assert.ok(results.some((row: any) => row.entity_type === "participant" && row.detail === dealId), "a matching participant is found");
  assert.ok(!results.some((row: any) => row.entity_id === draftId), "a deal that does not match is not returned");
  for (const row of results) {
    assert.ok([row.entity_id, row.headline, row.detail].some((field) => String(field || "").toLowerCase().includes(tag)), `every result matches the query: ${JSON.stringify(row)}`);
  }
  assert.ok(results.length <= 30);
  const longQuery = await get(`/api/admin/overview?q=${"x".repeat(300)}`);
  assert.equal(longQuery.q.length, 200, "the query is capped at 200 characters");
  const noQuery = await get("/api/admin/overview");
  assert.deepEqual(noQuery.admin_surface.search_results, [], "no query, no search");

  // Settlement: the 100 most recent deals, Completed only, successful money only,
  // then the platform fee through the canonical VAT authority and money summary.
  const truth = (await pool.query(
    `WITH recent AS (SELECT deal_id, state, price_per_unit FROM siton.deals ORDER BY created_at DESC LIMIT 100)
     SELECT COUNT(DISTINCT r.deal_id) FILTER (WHERE r.state='Completed')::int AS completed,
            COALESCE(SUM(r.price_per_unit * p.qty) FILTER (WHERE r.state='Completed' AND p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::float8 AS product,
            COALESCE(SUM(p.delivery_cost) FILTER (WHERE r.state='Completed' AND p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::float8 AS delivery
       FROM recent r LEFT JOIN siton.participants p ON p.deal_id = r.deal_id`
  )).rows[0];
  const workspace = noQuery.admin_surface.settlements.seller_workspace;
  assert.deepEqual(Object.keys(workspace), ["completed_deals", "gross_amount", "platform_fee_amount"]);
  assert.equal(workspace.completed_deals, truth.completed);
  assert.equal(workspace.gross_amount, truth.product + truth.delivery, "gross = successful product money + successful delivery");
  const vat = computeCustomerChargeVat({ productGrossAmount: truth.product, deliveryGrossAmount: truth.delivery });
  assert.equal(workspace.platform_fee_amount, summarizeMoney({ grossAmount: truth.product + truth.delivery, vatAmount: vat.vat_amount }).siton_fee_amount, "fee from the canonical money helpers");
  assert.equal(noQuery.admin_surface.totals.deals, Math.min(100, num((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.deals`)).rows[0].n)));
  assert.deepEqual(Object.keys(noQuery.admin_surface.forensics), ["dlq_count", "failed_webhooks", "ignored_webhooks", "pending_webhooks", "recent_audit_events"]);
});

await run("launch-console: exact sections; a seller-terms acceptance counts only for the deal's own seller; notification summary from the runtime", async () => {
  const before = await get("/api/admin/launch-console");
  const dealId = await deal("PendingTarget", 50, sellerId, `Launch ${tag}`);
  const afterDeal = await get("/api/admin/launch-console");
  assert.equal(afterDeal.launch_readiness.deals_missing_legal_acceptance - before.launch_readiness.deals_missing_legal_acceptance, 1, "a published deal without its seller's acceptance is flagged");
  assert.equal(afterDeal.launch_readiness.deals_missing_images - before.launch_readiness.deals_missing_images, 1, "a deal without an image is flagged");
  assert.equal(afterDeal.launch_readiness.deals_missing_seller_profile - before.launch_readiness.deals_missing_seller_profile, 0, "the seller profile is complete");

  const accept = (actor: string, deal: string) => pool.query(
    `INSERT INTO siton.legal_acceptances (actor_type, actor_ref, deal_id, acceptance_type, policy_version) VALUES ('seller',$1,$2,'seller_publish_terms','test-v1')`,
    [actor, deal]
  );
  await accept(otherSellerId, dealId);
  const wrongSeller = await get("/api/admin/launch-console");
  assert.equal(wrongSeller.launch_readiness.deals_missing_legal_acceptance, afterDeal.launch_readiness.deals_missing_legal_acceptance, "another seller's acceptance does not count");
  assert.equal(wrongSeller.legal.seller_publish_acceptances - afterDeal.legal.seller_publish_acceptances, 1, "but it is still an acceptance on record");
  await accept(sellerId, dealId);
  const accepted = await get("/api/admin/launch-console");
  assert.equal(accepted.launch_readiness.deals_missing_legal_acceptance, before.launch_readiness.deals_missing_legal_acceptance, "the deal's own seller's acceptance clears it");

  // a deal without a seller is read as the default seller's
  const orphanId = await deal("PendingTarget", 50, null, `Launch default ${tag}`);
  await accept(DEFAULT_SELLER_ID, orphanId);
  const body = await get("/api/admin/launch-console");
  assert.equal(body.launch_readiness.deals_missing_legal_acceptance, before.launch_readiness.deals_missing_legal_acceptance, "the default seller's acceptance counts for a seller-less deal");

  assert.deepEqual(Object.keys(body), ["ok", "generated_at", "system", "sellers", "deals", "launch_readiness", "notifications", "legal", "recent_deals", "recent_warnings"]);
  assert.deepEqual(Object.keys(body.system), ["status", "warnings"]);
  assert.deepEqual(Object.keys(body.launch_readiness), ["deals_missing_images", "deals_missing_seller_profile", "deals_missing_legal_acceptance", "completed_deals_with_excel_available"]);
  assert.deepEqual(Object.keys(body.legal), ["seller_publish_acceptances", "buyer_join_acceptances", "buyer_payment_disclosures"]);
  const orphan = body.recent_deals.find((row: any) => row.deal_id === orphanId);
  assert.ok(orphan, "the newest deal is in the recent list");
  assert.deepEqual(Object.keys(orphan), ["deal_id", "title", "state", "seller_id", "seller_business_name", "has_image", "has_seller_profile", "has_seller_terms_acceptance", "has_excel_export_available", "created_at", "updated_at"]);
  assert.equal(orphan.seller_id, DEFAULT_SELLER_ID);
  assert.equal(orphan.has_seller_terms_acceptance, true);
  const own = body.recent_deals.find((row: any) => row.deal_id === dealId);
  assert.ok(own && own.seller_id === sellerId && own.has_seller_profile === true && own.has_image === false && own.has_seller_terms_acceptance === true, JSON.stringify(own));

  const readiness = await get("/api/admin/demo-readiness");
  const notifications = readiness.providers.notifications;
  assert.equal(body.notifications.provider, notifications.provider);
  assert.equal(body.notifications.mode, notifications.mode);
  assert.equal(body.notifications.external_delivery, notifications.external_delivery);
  const sellers = (await pool.query(`SELECT COUNT(*)::int AS n FROM siton.seller_accounts`)).rows[0].n;
  assert.equal(body.sellers.total, sellers);
  const expectedStatus = body.system.warnings.some((w: any) => w.severity === "red") ? "red" : body.system.warnings.length ? "yellow" : "green";
  assert.equal(body.system.status, expectedStatus);
  assert.ok(body.system.warnings.some((w: any) => w.code === "deals_missing_images" && w.severity === "yellow"));
  assert.deepEqual(body.recent_warnings, body.system.warnings.slice(0, 10));
});

await run("the three routes only read: no watched table changes (rows or contents) across repeated calls", async () => {
  const before = await tableFingerprints();
  for (let i = 0; i < 2; i += 1) {
    for (const url of ROUTES) await get(url);
    await get(`/api/admin/overview?q=${tag}`);
  }
  assert.deepEqual(await tableFingerprints(), before, "row counts and row contents unchanged");
});

await run("the seeded fixtures follow the money canon: no money invariant fails that did not fail before", async () => {
  const after = await failingInvariants();
  assert.deepEqual(after.filter((name) => !invariantsBefore.includes(name)), [], `new failing invariants: ${after.join(", ")}`);
});

await pool.end();
await app.close();
if (failed) {
  console.error(`admin_ops_overview_read_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS admin_ops_overview_read_validation");
process.exit(0);
