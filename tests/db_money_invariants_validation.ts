// DB-backed control for the READ-ONLY money reconciliation checker
// (scripts/lib/money_invariants.cjs). On an isolated, fully migrated database:
//   1. a financially CONSISTENT dataset (charged, refunded, recovered buyers;
//      settlement -> payout batch -> items; a deal mid-charging with its job;
//      a stale unknown capture and a DLQ row both covered by an open case)
//      makes every invariant PASS;
//   2. corrupting ONE fee row makes the checker FAIL on the fee arithmetic
//      invariant and on exactly the ledger cross-checks that depend on it;
//   3. corrupting ONE participant's evidence (its successful capture attempt
//      removed) FAILs exactly participant.charged_state_has_successful_capture;
//   4. the checker's transaction really is read-only, and the CLI prints no
//      credentials.
// Rows are INSERTed in their final states (INSERT is not transition-guarded)
// together with the audit rows the runtime would have written; no state is
// ever UPDATEd without audit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import "dotenv/config";

process.env.DISABLE_OUTBOX_WORKER = "1";

const require = createRequire(import.meta.url);
const lib = require(path.join(process.cwd(), "scripts", "lib", "money_invariants.cjs"));

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
const SELLER = "seller-money-invariants";

async function runTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function check() {
  const client = await pool.connect();
  try { return await lib.runInvariants(client); } finally { client.release(); }
}

function failing(report: any): string[] {
  return lib.failingNames(report).sort();
}

function describeNonPass(report: any): string {
  return report.results.filter((r: any) => r.status !== "PASS").map(lib.formatResult).join("\n");
}

async function audit(entity: "deal" | "participant", entityId: string, dealId: string, stateType: string, chain: string[]) {
  for (let i = 1; i < chain.length; i += 1) {
    await pool.query(
      `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'test.money_invariants_fixture',$7,$7,$8,'{"fixture":"money_invariants"}'::jsonb, now() - make_interval(mins => $9))`,
      [entity, entityId, dealId, stateType, chain[i - 1], chain[i], `mi:${randomUUID()}`, `mi:${entityId}:${stateType}:${chain[i]}`, 90 - i]
    );
  }
}

const DEAL_TO_COMPLETED = ["Draft", "PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow", "Completed"];
const DEAL_TO_CHARGING = DEAL_TO_COMPLETED.slice(0, 6);
const BUYER_CHARGED = ["NotJoined", "JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargedSuccess"];
const MONEY_CHARGED = ["NoFinancial", "AuthHeld", "AuthLocked", "ChargeAttempt", "ChargedSuccess"];

async function deal(state: string, chain: string[], maxUnits = 10) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,$2,$3,'money invariants fixture',25,1,$4,1,now()+interval '2 days', now() - interval '2 hours')`,
    [dealId, SELLER, state, maxUnits]
  );
  await audit("deal", dealId, dealId, "deal_state", chain);
  return dealId;
}

async function participant(dealId: string, qty: number, buyerChain: string[], moneyChain: string[]) {
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [participantId, dealId, `buyer-${participantId.slice(0, 8)}`, qty, buyerChain[buyerChain.length - 1], moneyChain[moneyChain.length - 1]]
  );
  await audit("participant", participantId, dealId, "buyer_state", buyerChain);
  await audit("participant", participantId, dealId, "money_state", moneyChain);
  return participantId;
}

async function attempt(participantId: string, dealId: string, type: string, result: string, extra: { correlation?: string; evidence?: string; updatedMinutesAgo?: number } = {}) {
  const correlation = extra.correlation || `mi-${type}-${participantId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, resolved_at, failure_evidence, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'responded', CASE WHEN $4 IN ('success','permanent_fail') THEN now() END, $6,
             now() - make_interval(mins => $7), now() - make_interval(mins => $7))`,
    [participantId, dealId, type, result, correlation, extra.evidence || null, extra.updatedMinutesAgo || 0]
  );
  return correlation;
}

// Canonical 8% fee on (gross - VAT); VAT 0 in synthetic mode; 18% VAT on the fee.
function feeAmounts(gross: number, sign: 1 | -1) {
  const base = Math.round(gross * 0.08 * 100) / 100;
  const vat = Math.round(base * 0.18 * 100) / 100;
  const total = Math.round((base + vat) * 100) / 100;
  const net = Math.round((gross - total) * 100) / 100;
  return [gross, 0, gross, base, vat, total, total, net].map((v) => Math.round(v * sign * 100) / 100);
}

async function fee(participantId: string, dealId: string, gross: number, kind: "charge" | "recovery" | "refund") {
  const sign = kind === "refund" ? -1 : 1;
  const [g, vat, feeBase, base, feeVat, total, amount, net] = feeAmounts(gross, sign);
  const eventType = kind === "refund" ? "refund_issued" : kind === "recovery" ? "recovery_captured" : "charge_captured";
  const r = await pool.query(
    `INSERT INTO siton.platform_fee_money_events (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, source_money_state, payout_readiness_status,
       gross_amount, vat_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount)
     VALUES ($1,$2,$3,$4,$5,'mockpay',$6,$7,$8,$9,$10,0.08,0.18,$11,$12,$13,$14,$15) RETURNING money_event_id`,
    [participantId, dealId, SELLER, eventType, kind === "refund" ? "refund_adjustment" : "charge",
      kind === "refund" ? "Refunded" : kind === "recovery" ? "RecoveredCharge" : "ChargedSuccess",
      kind === "refund" ? "reversed_after_refund" : "ready_for_settlement",
      g, vat, feeBase, base, feeVat, total, amount, net]
  );
  return String(r.rows[0].money_event_id);
}

await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, login_email, verification_status, settlement_status, business_name, support_email)
   VALUES ($1,'Money Invariants Seller','mi-seller@siton.test','approved','active','MI Business','support@siton.test')
   ON CONFLICT (seller_id) DO NOTHING`,
  [SELLER]
);

// ── consistent dataset ──────────────────────────────────────────────────────
const completed = await deal("Completed", DEAL_TO_COMPLETED);
const charged = await participant(completed, 2, [...BUYER_CHARGED, "DealCompleted"], MONEY_CHARGED);
await attempt(charged, completed, "charge_start", "success");
const chargedFee = await fee(charged, completed, 50, "charge");

const refunded = await participant(completed, 1, [...BUYER_CHARGED, "DealFailed"], [...MONEY_CHARGED, "Refunded"]);
await attempt(refunded, completed, "charge_start", "success");
await attempt(refunded, completed, "refund", "success");
await fee(refunded, completed, 25, "charge");
await fee(refunded, completed, 25, "refund");

const recovered = await participant(completed, 3,
  ["NotJoined", "JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargeFailedCompletion", "Recovered", "DealCompleted"],
  ["NoFinancial", "AuthHeld", "AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "RecoveredCharge"]);
await attempt(recovered, completed, "charge_start", "permanent_fail", { evidence: "dispatch_response" });
await attempt(recovered, completed, "recovery", "success");
await fee(recovered, completed, 75, "recovery");

// settlement = the deal's ledger: gross 150, fee 4.72+2.36-2.36+7.08, refunds 25, net 45.28+22.64-22.64+67.92
const batchId = randomUUID();
const settlementId = randomUUID();
await pool.query(
  `INSERT INTO siton.seller_payout_batches (payout_batch_id, seller_id, trigger_deal_id, payout_status, provider_code, correlation_id, idempotency_key, settlement_count, item_count, gross_collected, platform_fee_total, refunds_total, reserve_amount, seller_net_payable, payout_amount)
   VALUES ($1,$2,$3,'batched','mockpayout','mi-payout',$4,1,2,150,11.80,25,0,113.20,113.20)`,
  [batchId, SELLER, completed, `seller-payout-batch:${completed}`]
);
await pool.query(
  `INSERT INTO siton.seller_settlements (seller_settlement_id, seller_id, deal_id, payout_batch_id, payout_status, gross_collected, platform_fee_total, refunds_total, reserve_amount, seller_net_payable, payout_amount, source_money_event_count, final_truth_basis, idempotency_key)
   VALUES ($1,$2,$3,$4,'batched',150,11.80,25,0,113.20,113.20,4,'deal_completed_money_truth',$5)`,
  [settlementId, SELLER, completed, batchId, `seller-settlement:${completed}`]
);
for (const [pid, gross, feeTotal, net, buyerState, moneyState] of [[charged, 50, 4.72, 45.28, "DealCompleted", "ChargedSuccess"], [recovered, 75, 7.08, 67.92, "DealCompleted", "RecoveredCharge"]] as const) {
  await pool.query(
    `INSERT INTO siton.seller_payout_batch_items (payout_batch_id, seller_settlement_id, participant_id, deal_id, seller_id, payout_status, correlation_id, idempotency_key, gross_collected, platform_fee_total, refunds_total, reserve_amount, seller_net_payable, payout_amount, source_money_event_count, buyer_state_at_batch, money_state_at_batch)
     VALUES ($1,$2,$3,$4,$5,'batched','mi-payout',$6,$7,$8,0,0,$9,$9,1,$10,$11)`,
    [batchId, settlementId, pid, completed, SELLER, `seller-payout-item:${pid}`, gross, feeTotal, net, buyerState, moneyState]
  );
}

// a deal mid-charging: its charge_deal job is pending; one capture is UNKNOWN
// for 30 minutes and an operational case covers it (and an old DLQ row).
const charging = await deal("Charging", DEAL_TO_CHARGING);
const unknownBuyer = await participant(charging, 1, ["NotJoined", "JoinedAuthorized", "LockedIn", "ChargingAttempt"], ["NoFinancial", "AuthHeld", "AuthLocked", "ChargeAttempt"]);
const unknownCorrelation = await attempt(unknownBuyer, charging, "charge_start", "unknown", { updatedMinutesAgo: 30 });
await pool.query(
  `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
   VALUES ('charge_deal','deal',$1,'{"fixture":"money_invariants"}','pending',0, now() + interval '100 years')`,
  [charging]
);
await pool.query(
  `INSERT INTO siton.outbox_dlq (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, max_attempts, last_error, created_at, updated_at)
   VALUES ('payment_reconcile','participant',$1,'{"fixture":"money_invariants"}','failed',10,10,'fixture', now() - interval '2 hours', now() - interval '2 hours')`,
  [unknownBuyer]
);
await pool.query(
  `INSERT INTO siton.operational_cases (case_type, status, priority, source, deal_id, subject, auto_key, correlation_id)
   VALUES ('PaymentMismatch','Open','High','System',$1,'unresolved capture (fixture)',$2,$3)`,
  [charging, `payment-outcome-unresolved:${unknownBuyer}:charge_start:${unknownCorrelation}`, unknownCorrelation]
);

await runTest("consistent dataset: every money invariant PASSes", async () => {
  const report = await check();
  assert.equal(report.overall, "PASS", describeNonPass(report));
  assert.deepEqual(failing(report), []);
  const byName = Object.fromEntries(report.results.map((r: any) => [r.name, r]));
  // the checks that the fixture actually exercises are PASS, not SKIPPED
  for (const name of ["fee.total_equals_base_plus_vat", "participant.refund_not_exceeding_charge", "participant.charged_state_has_successful_capture",
    "deal.charging_has_live_work", "payment.stale_unresolved_attempt_has_reconcile_or_case", "outbox.dlq_older_than_1h_without_open_case",
    "audit.participant_money_state_has_latest_transition", "payouts.settlement_matches_fee_ledger", "payouts.batch_items_sum_matches_batch"]) {
    assert.equal(byName[name].status, "PASS", name + ": " + lib.formatResult(byName[name]));
  }
  assert.equal(byName["fee.total_equals_base_plus_vat"].exact_mismatch, 0);
});

await runTest("the checker transaction is READ ONLY (a write inside it is refused by PostgreSQL)", async () => {
  const client = await pool.connect();
  try {
    await client.query(lib.SESSION.begin);
    await assert.rejects(
      () => client.query(`UPDATE siton.platform_fee_money_events SET seller_net_amount = 0 WHERE money_event_id = $1`, [chargedFee]),
      /read-only transaction/
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const still = await pool.query(`SELECT seller_net_amount FROM siton.platform_fee_money_events WHERE money_event_id=$1`, [chargedFee]);
  assert.equal(Number(still.rows[0].seller_net_amount), 45.28);
});

await runTest("one corrupted fee row: FAIL on the arithmetic invariant and the ledger cross-checks, with its id sampled", async () => {
  await pool.query(`UPDATE siton.platform_fee_money_events SET seller_net_amount = 40.00 WHERE money_event_id = $1`, [chargedFee]);
  try {
    const report = await check();
    assert.equal(report.overall, "FAIL");
    assert.deepEqual(failing(report), [
      "fee.seller_net_equals_gross_minus_fee_total",   // 40.00 <> 50 - 4.72
      "payouts.batch_item_matches_participant_ledger", // the item still says 45.28
      "payouts.settlement_matches_fee_ledger"          // the settlement still says 113.20
    ], describeNonPass(report));
    const arithmetic = report.results.find((r: any) => r.name === "fee.seller_net_equals_gross_minus_fee_total");
    assert.equal(arithmetic.count, 1);
    assert.deepEqual(arithmetic.samples, [chargedFee]);
    assert.match(lib.formatResult(arithmetic), new RegExp(`^MONEY_INVARIANT FAIL\\s+fee\\.seller_net_equals_gross_minus_fee_total count=1 exact_mismatch=1 samples=\\[${chargedFee}\\]$`));
  } finally {
    await pool.query(`UPDATE siton.platform_fee_money_events SET seller_net_amount = 45.28 WHERE money_event_id = $1`, [chargedFee]);
  }
  assert.equal((await check()).overall, "PASS", "repairing the row returns to PASS");
});

await runTest("one corrupted participant (capture evidence removed): FAIL exactly participant.charged_state_has_successful_capture", async () => {
  const removed = await pool.query(
    `DELETE FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type='charge_start' AND result_class='success' RETURNING correlation_id`,
    [charged]
  );
  assert.equal(removed.rowCount, 1);
  const report = await check();
  assert.deepEqual(failing(report), ["participant.charged_state_has_successful_capture"], describeNonPass(report));
  const row = report.results.find((r: any) => r.name === "participant.charged_state_has_successful_capture");
  assert.deepEqual(row.samples, [charged]);
  await attempt(charged, completed, "charge_start", "success", { correlation: String(removed.rows[0].correlation_id) });
  assert.equal((await check()).overall, "PASS");
});

await runTest("one participant pushed past its evidence (charged state without ledger/audit): FAIL by name", async () => {
  const ghost = randomUUID();
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state) VALUES ($1,$2,'ghost-buyer',1,'DealCompleted','ChargedSuccess')`,
    [ghost, completed]
  );
  try {
    const report = await check();
    assert.deepEqual(failing(report), [
      "audit.participant_buyer_state_has_latest_transition",
      "audit.participant_money_state_has_latest_transition",
      "participant.charged_state_has_charge_fee_row",
      "participant.charged_state_has_successful_capture"
    ], describeNonPass(report));
    for (const r of report.results.filter((x: any) => x.status === "FAIL")) assert.deepEqual(r.samples, [ghost]);
  } finally {
    await pool.query(`DELETE FROM siton.participants WHERE participant_id=$1`, [ghost]);
  }
});

await runTest("CLI against the database: PASS, host+db only", async () => {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "money_invariants.cjs")], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, DOTENV_CONFIG_QUIET: "true", DATABASE_URL, MONEY_INVARIANTS_DATABASE_URL: "" }
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /MONEY_INVARIANTS_PASS/);
  assert.match(output, /MONEY_INVARIANTS_SUMMARY overall=PASS/);
  const parsed = new URL(DATABASE_URL);
  assert.match(output, new RegExp(`db=${decodeURIComponent(parsed.pathname.slice(1))}`));
  if (parsed.password) assert.ok(!output.includes(decodeURIComponent(parsed.password)), "password printed");
  assert.equal(output.split("\n").filter((l) => l.startsWith("MONEY_INVARIANT ")).length, lib.INVARIANTS.length);
});

await pool.end();
console.log("PASS db money invariants validation");
