import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R9B — Grow sandbox activation, proven end-to-end against the OFFICIAL Grow
// contract at the application transport boundary (no network): the app runs
// with PAYMENT_PROVIDER=grow / PAYMENT_ENVIRONMENT=sandbox and a controlled
// transport that speaks the documented Grow protocol.
//
// Proven here: J5 create mapping · server-only amounts · pending never
// consumable · callback = non-authoritative hint · authoritative status
// confirms bindings · wrong amount/deal fail closed · Join consumes → AuthHeld
// · J4 settle mapping · capture UNKNOWN → reconcile to exactly one success ·
// duplicate/late events no-op · release honesty (no invented void) · refund
// mapping · approve never sent · guards/placeholders/encryption.

process.env.PORT = "3121";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-grow-sandbox";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.PAYMENT_PROVIDER = "grow";
process.env.PAYMENT_PROVIDER_MODE = "grow";
process.env.PAYMENT_ENVIRONMENT = "sandbox";
process.env.PAYMENT_PROVIDER_BASE_URL = "https://sandbox.meshulam.co.il/api/light/server/1.0";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1000";
process.env.GROW_USER_ID = "grow-sandbox-user";
process.env.GROW_PAGE_CODE = "grow-sandbox-page";
process.env.GROW_REFERENCE_ENCRYPTION_KEY = "grow-sandbox-reference-encryption-key-48-characters!";
process.env.GROW_SUCCESS_URL = "https://siton-staging.example.invalid/pay/success";
process.env.GROW_CANCEL_URL = "https://siton-staging.example.invalid/pay/cancel";
process.env.GROW_NOTIFY_URL = "https://siton-staging.example.invalid/webhooks/payments/grow";

// ---------------------------------------------------------------------------
// Controlled Grow sandbox protocol at the application transport boundary.
// ---------------------------------------------------------------------------
type FakeTransaction = { transactionId: string; transactionToken: string; statusCode: string; status: string; sum: string };
type FakeProcess = { processToken: string; sum: string; tx: FakeTransaction | null };

const fakeGrow = {
  processes: new Map<string, FakeProcess>(),
  seq: 0,
  createCalls: 0,
  lookupCalls: 0,
  settleCalls: 0,
  refundCalls: 0,
  approveCalls: 0,
  settleRequests: [] as Array<Record<string, string>>,
  refundRequests: [] as Array<Record<string, string>>,
  settleMode: "ok" as "ok" | "lose_response" | "reject"
};

function fakeAuthorize(processId: string, sumOverride?: string) {
  const proc = fakeGrow.processes.get(processId);
  if (!proc) throw new Error(`fake process missing: ${processId}`);
  proc.tx = {
    transactionId: `tx-${processId}`,
    transactionToken: `tx-token-${processId}`,
    statusCode: "11",
    status: "עסקה מושהית",
    sum: sumOverride ?? proc.sum
  };
  return proc.tx;
}

(globalThis as Record<string, unknown>).__SITON_GROW_TEST_TRANSPORT__ = async (request: { url: string; body: URLSearchParams }) => {
  const fields = Object.fromEntries(request.body.entries());
  const ok = (data: unknown) => ({ status: 200, body: { status: 1, err: "", data } });
  const err = (message: string) => ({ status: 200, body: { status: 0, err: { id: 400, message }, data: "" } });

  if (request.url.endsWith("/createPaymentProcess")) {
    fakeGrow.createCalls += 1;
    assert.equal(fields.chargeType, "2", "J5 must use the official Suspended Charge chargeType");
    assert.equal(fields.pageCode, "grow-sandbox-page");
    assert.equal(fields.userId, "grow-sandbox-user");
    assert.equal("apiKey" in fields, false, "undocumented apiKey must not be transmitted");
    fakeGrow.seq += 1;
    const processId = `gp-${fakeGrow.seq}`;
    fakeGrow.processes.set(processId, { processToken: `ptoken-${fakeGrow.seq}`, sum: String(fields.sum), tx: null });
    return ok({ processId, processToken: `ptoken-${fakeGrow.seq}`, url: `https://sandbox.meshulam.co.il/hosted/${processId}` });
  }
  if (request.url.endsWith("/getPaymentProcessInfo")) {
    fakeGrow.lookupCalls += 1;
    const proc = fakeGrow.processes.get(String(fields.processId));
    if (!proc || proc.processToken !== fields.processToken) return err("process not found");
    return ok({ processId: fields.processId, processToken: fields.processToken, transactions: proc.tx ? [proc.tx] : [] });
  }
  if (request.url.endsWith("/getTransactionInfo")) {
    fakeGrow.lookupCalls += 1;
    for (const proc of fakeGrow.processes.values()) {
      if (proc.tx && proc.tx.transactionId === fields.transactionId && proc.tx.transactionToken === fields.transactionToken) {
        return ok({ ...proc.tx });
      }
    }
    return err("transaction not found");
  }
  if (request.url.endsWith("/settleSuspendedTransaction")) {
    fakeGrow.settleCalls += 1;
    fakeGrow.settleRequests.push(fields);
    assert.equal(fields.userId, "grow-sandbox-user", "official settle contract requires userId");
    assert.equal("processId" in fields, false, "official settle contract identifies money by transaction credentials");
    for (const proc of fakeGrow.processes.values()) {
      if (proc.tx && proc.tx.transactionId === fields.transactionId && proc.tx.transactionToken === fields.transactionToken) {
        if (fakeGrow.settleMode === "reject") return err("settle rejected");
        // Money moves at Grow BEFORE the response can be lost.
        proc.tx.statusCode = "2";
        proc.tx.status = "שולם";
        proc.tx.sum = String(fields.sum);
        if (fakeGrow.settleMode === "lose_response") throw new Error("socket hang up after dispatch");
        return ok({ transactionId: proc.tx.transactionId, transactionToken: proc.tx.transactionToken });
      }
    }
    return err("transaction not found");
  }
  if (request.url.endsWith("/refundTransaction")) {
    fakeGrow.refundCalls += 1;
    fakeGrow.refundRequests.push(fields);
    for (const proc of fakeGrow.processes.values()) {
      if (proc.tx && proc.tx.transactionId === fields.transactionId && proc.tx.transactionToken === fields.transactionToken) {
        return ok({});
      }
    }
    return err("transaction not found");
  }
  if (request.url.endsWith("/approveTransaction")) {
    fakeGrow.approveCalls += 1;
    return ok({});
  }
  return { status: 404, body: { status: 0, err: "unknown endpoint" } };
};

const { app, processOutboxEventById } = await import(`../src/app.js?grow-sandbox-${Date.now()}`);
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
    failed += 1;
  }
}

async function seedDeal(prefix: string, pricePerUnit = 10) {
  const seller = `${prefix}-seller`;
  await pool.query(
    `INSERT INTO siton.seller_accounts(seller_id, display_name, auth_enabled) VALUES ($1,$2,false)
     ON CONFLICT (seller_id) DO NOTHING`,
    [seller, `${prefix} seller`]
  );
  const deal = await pool.query(
    `INSERT INTO siton.deals(seller_id,title,price_per_unit,state,min_units,max_units,threshold_units,deadline,published_at)
     VALUES ($1,$2,$3,'PendingTarget',2,50,10, now()+interval '1 day', now()) RETURNING deal_id`,
    [seller, `${prefix} deal`, pricePerUnit]
  );
  return deal.rows[0].deal_id as string;
}

async function authorizeGrow(dealId: string, buyerId: string, qty: number, spoofAmountMinor?: number) {
  const response = await app.inject({
    method: "POST",
    url: "/api/payments/authorize",
    payload: {
      payer_name: "Israel Israeli",
      payer_phone: "0501234567",
      payer_email: "buyer@example.invalid",
      deal_id: dealId,
      buyer_id: buyerId,
      qty,
      // Browser-supplied amounts must be ignored — the server computes truth.
      ...(spoofAmountMinor !== undefined ? { amount_minor: spoofAmountMinor } : {})
    }
  });
  return response;
}

async function joinDeal(dealId: string, buyerId: string, qty: number, authorizationId: string) {
  return app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: buyerId,
      qty,
      payment_disclosure_accepted: true,
      authorization_id: authorizationId,
      authorization_provider: "grow"
    }
  });
}

async function bindingByAuthorization(authorizationId: string) {
  const r = await pool.query(
    `SELECT * FROM siton.payment_authorization_bindings WHERE authorization_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [authorizationId]
  );
  return r.rows[0] || null;
}

function processIdFromCreateOrder(order: number) {
  return `gp-${order}`;
}

async function postGrowCallback(fields: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/webhooks/payments/grow",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString()
  });
}

async function confirmViaStatus(authorizationId: string) {
  return app.inject({
    method: "POST",
    url: "/api/payments/status",
    payload: { provider_reference: authorizationId, operation: "authorization" }
  });
}

/** Full good path: authorize → provider authorization → status confirm → join. */
async function establishAuthHeld(prefix: string, qty = 2, pricePerUnit = 10) {
  const dealId = await seedDeal(prefix, pricePerUnit);
  const buyerId = `${prefix}-buyer`;
  const authorizeResponse = await authorizeGrow(dealId, buyerId, qty);
  assert.equal(authorizeResponse.statusCode, 200, authorizeResponse.body);
  const authorization = authorizeResponse.json() as { authorization_id: string; correlation_id: string };
  const processId = processIdFromCreateOrder(fakeGrow.seq);
  fakeAuthorize(processId);
  const confirm = await confirmViaStatus(authorization.authorization_id);
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal(confirm.json().state, "authorized");
  const joinResponse = await joinDeal(dealId, buyerId, qty, authorization.authorization_id);
  assert.equal([200, 201].includes(joinResponse.statusCode), true, joinResponse.body);
  const participant = await pool.query(
    `SELECT participant_id, money_state, buyer_state FROM siton.participants WHERE deal_id=$1 AND buyer_id=$2`,
    [dealId, buyerId]
  );
  assert.equal(participant.rows[0].money_state, "AuthHeld");
  return {
    dealId,
    buyerId,
    processId,
    participantId: participant.rows[0].participant_id as string,
    authorizationId: authorization.authorization_id,
    correlationId: authorization.correlation_id,
    amountMinor: Math.round(qty * pricePerUnit * 100)
  };
}

async function enqueueChargeDeal(dealId: string) {
  const eventId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // DB state-transition enforcement allows test-seeded transitions only
    // under an explicit test.% action name (migration 053 contract).
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('app.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    await client.query(`SELECT set_config('siton.action_name','test.grow_charge_seed', true)`);
    // Walk the CANONICAL threshold/locking chain step by step — the DB
    // transition matrix (008/053) enforces it even for test seeds.
    for (const [buyerState, moneyState] of [["LockedIn", "AuthLocked"], ["ChargingAttempt", "ChargeAttempt"]]) {
      await client.query(
        `UPDATE siton.participants SET buyer_state=$2, money_state=$3 WHERE deal_id=$1`,
        [dealId, buyerState, moneyState]
      );
    }
    for (const dealState of ["TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging"]) {
      await client.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, dealState]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'charge_deal','deal',$2,$3,'pending',0, now())`,
    [eventId, dealId, JSON.stringify({ deal_id: dealId })]
  );
  return eventId;
}

async function pendingOutboxEvent(eventType: string, aggregateId: string) {
  const r = await pool.query(
    `SELECT event_uuid FROM siton.outbox_events WHERE event_type=$1 AND aggregate_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1`,
    [eventType, aggregateId]
  );
  return r.rows[0]?.event_uuid as string | undefined;
}

async function feeLedgerRows(participantId: string) {
  const r = await pool.query(
    `SELECT logical_entry_type, gross_amount, vat_amount, fee_base_amount, platform_fee_rate,
            platform_fee_base_amount, platform_fee_total_amount, seller_net_amount
     FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at ASC`,
    [participantId]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------

await runTest("J5 create maps the official contract with the SERVER-computed amount and an opaque sealed reference", async () => {
  const dealId = await seedDeal("grow-t1", 10);
  const response = await authorizeGrow(dealId, "grow-t1-buyer", 2, 1 /* spoofed browser amount */);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.provider, "grow");
  assert.equal(body.authorization, "pending_provider_confirmation");
  assert.equal(String(body.payment_url).startsWith("https://sandbox.meshulam.co.il/hosted/"), true);
  assert.equal(String(body.authorization_id).startsWith("grow_ref_v1."), true);
  assert.equal(response.body.includes("ptoken-"), false, "raw process credentials must never reach the browser");
  // Server-side truth: 2 × 10 ILS = sum 20.00, regardless of the spoofed browser amount.
  const proc = fakeGrow.processes.get(processIdFromCreateOrder(fakeGrow.seq));
  assert.equal(proc?.sum, "20.00");
  const binding = await bindingByAuthorization(body.authorization_id);
  assert.equal(binding.status, "pending_provider_confirmation");
  assert.equal(Number(binding.amount_minor), 2000);
  assert.equal(binding.provider_code, "grow");
  assert.equal(binding.provider_environment, "sandbox");
  assert.equal(String(binding.provider_reference).startsWith("grow_ref_v1."), true);
});

await runTest("pending authorization is never consumable as AuthHeld", async () => {
  const dealId = await seedDeal("grow-t2", 10);
  const response = await authorizeGrow(dealId, "grow-t2-buyer", 2);
  const authorizationId = response.json().authorization_id as string;
  const join = await joinDeal(dealId, "grow-t2-buyer", 2, authorizationId);
  assert.equal(join.statusCode, 402, join.body);
  assert.equal(join.json().code ?? join.json().error, "payment_authorization_not_confirmed");
});

await runTest("callback is a structurally-validated NON-authoritative hint: it cannot authorize when Grow says pending", async () => {
  const dealId = await seedDeal("grow-t3", 10);
  const response = await authorizeGrow(dealId, "grow-t3-buyer", 2);
  const authorization = response.json() as { authorization_id: string; correlation_id: string };
  const processId = processIdFromCreateOrder(fakeGrow.seq);
  const proc = fakeGrow.processes.get(processId)!;
  // A (potentially forged) callback claims suspended-success — but the
  // authoritative lookup still reports NO transaction.
  const callback = await postGrowCallback({
    processId,
    processToken: proc.processToken,
    statusCode: "11",
    sum: "20.00",
    cField1: authorization.correlation_id
  });
  assert.equal(callback.statusCode, 200, callback.body);
  assert.equal(callback.json().money_from_callback, false);
  assert.equal(String(callback.json().reason).includes("provider_state_pending"), true, callback.body);
  const binding = await bindingByAuthorization(authorization.authorization_id);
  assert.equal(binding.status, "pending_provider_confirmation", "callback content must never flip a binding");
  // Structurally invalid callback fails closed.
  const invalid = await postGrowCallback({ statusCode: "11" });
  assert.equal(invalid.statusCode, 400);
  // Uncorrelated callback creates no work.
  const unmatched = await postGrowCallback({ processId: "gp-9999", processToken: "nope", statusCode: "11", cField1: "corr-unknown" });
  assert.equal(unmatched.statusCode, 200);
  assert.equal(unmatched.json().reason, "no_matching_server_binding");
});

await runTest("authoritative status lookup confirms the binding; callback after authorization stays evidence-only", async () => {
  const dealId = await seedDeal("grow-t4", 10);
  const response = await authorizeGrow(dealId, "grow-t4-buyer", 2);
  const authorization = response.json() as { authorization_id: string; correlation_id: string };
  const processId = processIdFromCreateOrder(fakeGrow.seq);
  const tx = fakeAuthorize(processId);
  const confirm = await confirmViaStatus(authorization.authorization_id);
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal(confirm.json().state, "authorized");
  const binding = await bindingByAuthorization(authorization.authorization_id);
  assert.equal(binding.status, "authorized");
  assert.equal(binding.status_reason, "provider_status_confirmed");
  // The refreshed binding reference is sealed and carries no plaintext tokens.
  assert.equal(String(binding.provider_reference).startsWith("grow_ref_v1."), true);
  assert.equal(String(binding.provider_reference).includes(tx.transactionToken), false);
  // A duplicate/late callback about the now-authorized binding records evidence only.
  const proc = fakeGrow.processes.get(processId)!;
  const late = await postGrowCallback({
    processId,
    processToken: proc.processToken,
    transactionId: tx.transactionId,
    transactionToken: tx.transactionToken,
    statusCode: "11",
    sum: "20.00",
    cField1: authorization.correlation_id
  });
  assert.equal(late.statusCode, 200);
  assert.equal(String(late.json().reason).includes("evidence_only"), true, late.body);
  const evidence = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.webhook_events WHERE provider='grow'`);
  assert.equal(evidence.rows[0].n > 0, true, "callback evidence must be preserved");
});

await runTest("a provider-reported amount that contradicts the binding fails the binding closed", async () => {
  const dealId = await seedDeal("grow-t5", 10);
  const response = await authorizeGrow(dealId, "grow-t5-buyer", 2);
  const authorization = response.json() as { authorization_id: string };
  fakeAuthorize(processIdFromCreateOrder(fakeGrow.seq), "25.00");
  const confirm = await confirmViaStatus(authorization.authorization_id);
  assert.equal(confirm.statusCode, 409, confirm.body);
  assert.equal(confirm.json().error, "payment_binding_amount_mismatch");
  const binding = await bindingByAuthorization(authorization.authorization_id);
  assert.equal(binding.status, "failed");
  assert.equal(binding.status_reason, "provider_amount_mismatch");
});

await runTest("an authorization bound to one deal can never join another deal", async () => {
  const dealA = await seedDeal("grow-t6a", 10);
  const dealB = await seedDeal("grow-t6b", 10);
  const response = await authorizeGrow(dealA, "grow-t6-buyer", 2);
  const authorization = response.json() as { authorization_id: string };
  fakeAuthorize(processIdFromCreateOrder(fakeGrow.seq));
  const confirm = await confirmViaStatus(authorization.authorization_id);
  assert.equal(confirm.json().state, "authorized");
  const join = await joinDeal(dealB, "grow-t6-buyer", 2, authorization.authorization_id);
  assert.equal(join.statusCode, 402, join.body);
  assert.equal(join.json().code ?? join.json().error, "payment_authorization_not_found");
});

await runTest("authorized binding is consumed exactly once by Join → AuthHeld", async () => {
  const flow = await establishAuthHeld("grow-t7");
  const binding = await bindingByAuthorization(flow.authorizationId);
  assert.equal(binding.status, "consumed");
  assert.equal(binding.consumed_by_participant_id, flow.participantId);
  const replay = await joinDeal(flow.dealId, flow.buyerId, 2, flow.authorizationId);
  assert.equal([409, 402].includes(replay.statusCode), true, replay.body);
});

await runTest("J4 capture settles through the Worker with the official contract and lands ChargedSuccess + ledger + 8% fee", async () => {
  const flow = await establishAuthHeld("grow-t8");
  const settleCallsBefore = fakeGrow.settleCalls;
  const eventId = await enqueueChargeDeal(flow.dealId);
  const outcome = await processOutboxEventById(eventId);
  assert.equal(outcome?.status, "sent", JSON.stringify(outcome));
  assert.equal(fakeGrow.settleCalls, settleCallsBefore + 1);
  const settleRequest = fakeGrow.settleRequests.at(-1)!;
  assert.equal(settleRequest.sum, "20.00", "J4 amount must be Siton's authoritative server truth");
  assert.equal(settleRequest.transactionId, `tx-${flow.processId}`);
  const participant = await pool.query(
    `SELECT money_state, buyer_state FROM siton.participants WHERE participant_id=$1`,
    [flow.participantId]
  );
  assert.equal(participant.rows[0].money_state, "ChargedSuccess");
  assert.equal(participant.rows[0].buyer_state, "ChargedSuccess");
  const ledger = await feeLedgerRows(flow.participantId);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].logical_entry_type, "charge");
  // Siton fee invariant: 8% of the VAT-exclusive customer charge base
  // (20.00 gross incl. delivery, synthetic VAT 0 ⇒ base 20.00, fee 1.60).
  assert.equal(Number(ledger[0].gross_amount), 20);
  assert.equal(Number(ledger[0].vat_amount), 0);
  assert.equal(Number(ledger[0].fee_base_amount), 20);
  assert.equal(Number(ledger[0].platform_fee_rate), 0.08);
  assert.equal(Number(ledger[0].platform_fee_base_amount), 1.6);
  // Seller net invariant: gross minus the total platform fee, nothing else —
  // and no distributor commission exists anywhere in the ledger.
  assert.equal(Number(ledger[0].platform_fee_total_amount) + Number(ledger[0].seller_net_amount), Number(ledger[0].gross_amount));
  const deal = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [flow.dealId]);
  assert.equal(deal.rows[0].state, "CompletionWindow");
});

await runTest("capture UNKNOWN (Grow succeeded, response lost) reconciles to exactly ONE success with no second money call", async () => {
  const flow = await establishAuthHeld("grow-t9");
  fakeGrow.settleMode = "lose_response";
  const settleCallsBefore = fakeGrow.settleCalls;
  const eventId = await enqueueChargeDeal(flow.dealId);
  const outcome = await processOutboxEventById(eventId);
  assert.equal(outcome?.status, "sent", JSON.stringify(outcome));
  fakeGrow.settleMode = "ok";
  assert.equal(fakeGrow.settleCalls, settleCallsBefore + 1);
  // Money is UNKNOWN — never guessed, never blind-retried.
  const pendingState = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId]);
  assert.equal(pendingState.rows[0].money_state, "ChargeAttempt");
  const attempt = await pool.query(
    `SELECT result_class FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type='charge_start' ORDER BY created_at DESC LIMIT 1`,
    [flow.participantId]
  );
  assert.equal(attempt.rows[0].result_class, "unknown");
  const reconcileEvent = await pendingOutboxEvent("payment_reconcile", flow.participantId);
  assert.ok(reconcileEvent, "UNKNOWN capture must schedule payment_reconcile");
  const reconcileOutcome = await processOutboxEventById(reconcileEvent);
  assert.equal(reconcileOutcome?.status, "sent", JSON.stringify(reconcileOutcome));
  // Exactly one canonical success, exactly one ledger consequence, ZERO extra settles.
  assert.equal(fakeGrow.settleCalls, settleCallsBefore + 1, "reconciliation must never re-run the money call");
  const resolved = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId]);
  assert.equal(resolved.rows[0].money_state, "ChargedSuccess");
  assert.equal((await feeLedgerRows(flow.participantId)).length, 1, "no duplicate Siton fee");
  // Repeated reconciliation after resolution is a no-op.
  const duplicateEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'payment_reconcile','participant',$2,$3,'pending',0, now())`,
    [duplicateEventId, flow.participantId, JSON.stringify({
      participant_id: flow.participantId,
      deal_id: flow.dealId,
      attempt_type: "charge_start",
      correlation_id: `late-${randomUUID().slice(0, 8)}`,
      operation: "capture",
      provider_reference: null,
      reason: "duplicate_reconcile_probe"
    })]
  );
  assert.equal((await processOutboxEventById(duplicateEventId))?.status, "sent");
  assert.equal((await feeLedgerRows(flow.participantId)).length, 1);
  assert.equal(fakeGrow.settleCalls, settleCallsBefore + 1);
  // Duplicate + late capture-hint callbacks after the terminal state: evidence only.
  const proc = fakeGrow.processes.get(flow.processId)!;
  for (let i = 0; i < 2; i += 1) {
    const late = await postGrowCallback({
      processId: flow.processId,
      processToken: proc.processToken,
      transactionId: proc.tx!.transactionId,
      transactionToken: proc.tx!.transactionToken,
      statusCode: "2",
      sum: "20.00",
      cField1: flow.correlationId
    });
    assert.equal(late.statusCode, 200);
    assert.equal(late.json().money_from_callback, false);
  }
  assert.equal((await feeLedgerRows(flow.participantId)).length, 1);
  const final = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId]);
  assert.equal(final.rows[0].money_state, "ChargedSuccess");
});

await runTest("release honesty: no invented void — a live J5 hold stays honestly held; provider-declared no-hold releases", async () => {
  const flow = await establishAuthHeld("grow-t10");
  const releaseEventId = randomUUID();
  const enqueueRelease = async (id: string) => pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'payment_release','participant',$2,$3,'pending',0, now())`,
    [id, flow.participantId, JSON.stringify({ participant_id: flow.participantId, deal_id: flow.dealId, reason: "deal_failed_test" })]
  );
  await enqueueRelease(releaseEventId);
  const outcome = await processOutboxEventById(releaseEventId);
  assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
  const stillHeld = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId]);
  assert.equal(stillHeld.rows[0].money_state, "AuthHeld", "AuthReleased must never be fabricated for an active hold");
  const releaseCase = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.operational_cases WHERE auto_key=$1`,
    [`payment-release-failed:${flow.participantId}`]
  );
  assert.equal(releaseCase.rows[0].n, 1, "an unreleasable hold must open a visible operational case");
  // Provider now authoritatively declares the transaction failed (no hold).
  const proc = fakeGrow.processes.get(flow.processId)!;
  proc.tx!.statusCode = "6";
  proc.tx!.status = "נכשל";
  const secondReleaseId = randomUUID();
  await enqueueRelease(secondReleaseId);
  assert.equal((await processOutboxEventById(secondReleaseId))?.status, "sent");
  const released = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId]);
  assert.equal(released.rows[0].money_state, "AuthReleased");
});

await runTest("refund maps to the official refundTransaction contract through the provider-neutral path", async () => {
  const { buildGrowCanonicalPaymentProvider } = await import(`../src/payment_provider.js?grow-refund-${Date.now()}`);
  const provider = buildGrowCanonicalPaymentProvider();
  const flow = await establishAuthHeld("grow-t11");
  fakeAuthorize(flow.processId); // ensure tx exists (already authorized in helper)
  const binding = await bindingByAuthorization(flow.authorizationId);
  const refund = await provider.refund({
    capture_reference: binding.provider_reference,
    amount_minor: 2000,
    currency: "ILS",
    correlation_id: `refund-${randomUUID().slice(0, 8)}`
  });
  assert.equal(refund.result_class, "success");
  assert.equal(refund.reconciliation_event_type, "refund_issued");
  const refundRequest = fakeGrow.refundRequests.at(-1)!;
  assert.equal(refundRequest.refundSum, "20.00");
  assert.equal(refundRequest.userId, "grow-sandbox-user");
  assert.equal(refundRequest.transactionId, `tx-${flow.processId}`);
});

await runTest("provider summary + guards report Grow sandbox capabilities honestly and fail closed on separation violations", async () => {
  const { buildPaymentProvider, getPaymentProviderSummary, missingMandatoryCapabilities } = await import(`../src/payment_provider.js?grow-summary-${Date.now()}`);
  const provider = buildPaymentProvider();
  assert.equal(provider.providerCode, "grow");
  assert.deepEqual(missingMandatoryCapabilities(provider), []);
  const summary = getPaymentProviderSummary(provider);
  assert.equal(summary.provider, "grow");
  assert.equal(summary.environment, "sandbox");
  assert.equal(summary.capability_gaps.length, 0);
  const detail = summary.provider_detail as Record<string, unknown>;
  assert.equal(detail.sandbox, true);
  assert.equal(detail.approve_transaction_policy, "never_sent_for_j4j5");
  assert.equal(detail.release_strategy, "automatic_expiry_observed_via_status_reconciliation");
  assert.equal(detail.native_void_endpoint, false);
  assert.equal(detail.callback_native_authentication, "none_documented");

  const { assertProductionRuntimeGuards } = await import(`../src/production_guards.js?grow-guards-${Date.now()}`);
  const baseEnv = { ...process.env };
  assertProductionRuntimeGuards("web", baseEnv as NodeJS.ProcessEnv);
  assert.throws(
    () => assertProductionRuntimeGuards("web", { ...baseEnv, GROW_USER_ID: "placeholder-user" } as NodeJS.ProcessEnv),
    /GROW_USER_ID/
  );
  assert.throws(
    () => assertProductionRuntimeGuards("web", { ...baseEnv, PAYMENT_PROVIDER_BASE_URL: "https://secure.meshulam.co.il/api/light/server/1.0" } as NodeJS.ProcessEnv),
    /sandbox\.meshulam\.co\.il/
  );
  assert.throws(
    () => assertProductionRuntimeGuards("web", { ...baseEnv, PAYMENT_ENVIRONMENT: "live" } as NodeJS.ProcessEnv),
    /live/
  );
});

await runTest("approveTransaction was NEVER sent across the entire J4/J5 sandbox flow (official rule)", async () => {
  assert.equal(fakeGrow.approveCalls, 0);
});

console.log(`\nGrow sandbox activation: ${passed} passed, ${failed} failed`);
await app.close();
await pool.end();
// Windows libuv teardown drain (see R9A gotcha).
await new Promise((resolve) => setTimeout(resolve, 700));
process.exit(failed ? 1 : 0);
