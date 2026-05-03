import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "20000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "20000";

const { app } = await import("../src/app.js");
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DATABASE_URL });

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createDeal(suffix: string) {
  const unique = `recovery-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const create = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `recovery-create-${unique}`,
      "idempotency-key": `recovery-create-${unique}`
    },
    payload: {
      title: `Recovery Deal ${unique}`,
      price_per_unit: 42,
      min_units: 10,
      max_units: 20,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      delivery_options: [
        { option_type: "pickup", label: "Pickup", cost: 0, sort_order: 0 }
      ]
    }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal_id as string;

  const publish = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-request-id": `recovery-publish-${unique}`,
      "idempotency-key": `recovery-publish-${unique}`
    },
    payload: { seller_terms_accepted: true }
  });
  assert.equal(publish.statusCode, 200, publish.body);
  return dealId;
}

let phoneSeq = (Date.now() % 9_000_000) + 1_000_000;
function uniquePhone() {
  phoneSeq += 1;
  return `050${String(phoneSeq).padStart(7, "0").slice(-7)}`;
}

async function joinDeal(dealId: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const otpRequest = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    payload: { phone: uniquePhone(), deal_id: dealId }
  });
  assert.equal(otpRequest.statusCode, 200, otpRequest.body);
  const otpRequested = otpRequest.json() as any;
  const otpVerify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: {
      otp_session_id: otpRequested.otp_session_id,
      code: otpRequested.development_code
    }
  });
  assert.equal(otpVerify.statusCode, 200, otpVerify.body);
  const otp = otpVerify.json() as any;

  const dealPublic = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(dealPublic.statusCode, 200, dealPublic.body);
  const deliveryOptionId = (dealPublic.json() as any).deal.delivery_options[0].option_id as string;

  const join = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: {
      "x-request-id": `recovery-join-${unique}`,
      "idempotency-key": `recovery-join-${unique}`
    },
    payload: {
      buyer_id: `buyer-${unique}`,
      qty: 5,
      delivery_option_id: deliveryOptionId,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.challenge_id || otp.otp_session_id,
      authorization_id: `auth-${unique}`,
      authorization_provider: "mockpay"
    }
  });
  assert.equal(join.statusCode, 200, join.body);
  return (join.json() as { participant_id: string }).participant_id;
}

const DEAL_STATE_PATH: Record<string, string[]> = {
  PendingTarget: ["PendingTarget"],
  TargetReached: ["PendingTarget", "TargetReached"],
  ClosedForJoining: ["PendingTarget", "TargetReached", "ClosedForJoining"],
  ReadyForCharging: ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging"],
  Charging: ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging"],
  CompletionWindow: ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"],
  Completed: ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow", "Completed"],
  Failed: ["PendingTarget", "Failed"]
};

const BUYER_STATE_PATH: Record<string, string[]> = {
  JoinedAuthorized: ["JoinedAuthorized"],
  LockedIn: ["JoinedAuthorized", "LockedIn"],
  ChargingAttempt: ["JoinedAuthorized", "LockedIn", "ChargingAttempt"],
  ChargedSuccess: ["JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargedSuccess"],
  ChargeFailedCompletion: ["JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargeFailedCompletion"],
  Recovered: ["JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargeFailedCompletion", "Recovered"],
  Dropped: ["JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargeFailedCompletion", "Dropped"],
  DealCompleted: ["JoinedAuthorized", "LockedIn", "ChargingAttempt", "ChargedSuccess", "DealCompleted"],
  DealFailed: ["JoinedAuthorized", "DealFailed"]
};

const MONEY_STATE_PATH: Record<string, string[]> = {
  AuthHeld: ["AuthHeld"],
  AuthLocked: ["AuthHeld", "AuthLocked"],
  ChargeAttempt: ["AuthHeld", "AuthLocked", "ChargeAttempt"],
  ChargedSuccess: ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargedSuccess"],
  ChargeFailedRecovery: ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargeFailedRecovery"],
  RecoveredCharge: ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "RecoveredCharge"],
  AuthReleased: ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "AuthReleased"],
  Refunded: ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargedSuccess", "Refunded"]
};

async function setStates(participantId: string, args: {
  dealState?: string;
  buyerState?: string;
  moneyState?: string;
  completionWindowUntil?: string | null;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('app.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    await client.query(`SELECT set_config('siton.action_name', 'test.recovery_setup', true)`);

    const dealRow = await client.query(
      `SELECT d.deal_id, d.state, d.completion_window_until
       FROM siton.participants p
       JOIN siton.deals d ON d.deal_id = p.deal_id
       WHERE p.participant_id=$1`,
      [participantId]
    );
    const dealId = dealRow.rows[0]?.deal_id as string | undefined;
    const currentDealState = dealRow.rows[0]?.state as string | undefined;
    const currentWindow = dealRow.rows[0]?.completion_window_until as string | null | undefined;

    if (dealId && args.dealState) {
      const targetPath = DEAL_STATE_PATH[args.dealState];
      assert.ok(targetPath, `unsupported deal state ${args.dealState}`);
      const startIdx = targetPath.indexOf(currentDealState || "PendingTarget");
      const stepsToWalk = startIdx === -1 ? targetPath : targetPath.slice(startIdx + 1);
      for (const next of stepsToWalk) {
        if (next === "CompletionWindow") {
          // window must be set in the SAME update to land at CompletionWindow with a future window
          const windowValue = args.completionWindowUntil ?? new Date(Date.now() + 30 * 60_000).toISOString();
          if (currentWindow == null) {
            await client.query(
              `UPDATE siton.deals SET state=$2, completion_window_until=$3 WHERE deal_id=$1`,
              [dealId, next, windowValue]
            );
          } else {
            await client.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, next]);
          }
        } else {
          await client.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, next]);
        }
      }
      // If window already set and we want to override (impossible after first set due to immutability trigger),
      // we accept the original window. Tests must request the desired window in the SAME call that lands at CompletionWindow.
    }

    if (args.buyerState) {
      const targetPath = BUYER_STATE_PATH[args.buyerState];
      assert.ok(targetPath, `unsupported buyer state ${args.buyerState}`);
      // Always walk the full path from JoinedAuthorized — this is fresh-join state
      const currentBuyerRow = await client.query(`SELECT buyer_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
      const currentBuyer = currentBuyerRow.rows[0]?.buyer_state as string | undefined;
      const startIdx = targetPath.indexOf(currentBuyer || "JoinedAuthorized");
      const stepsToWalk = startIdx === -1 ? targetPath : targetPath.slice(startIdx + 1);
      for (const next of stepsToWalk) {
        await client.query(`UPDATE siton.participants SET buyer_state=$2 WHERE participant_id=$1`, [participantId, next]);
      }
    }

    if (args.moneyState) {
      const targetPath = MONEY_STATE_PATH[args.moneyState];
      assert.ok(targetPath, `unsupported money state ${args.moneyState}`);
      const currentMoneyRow = await client.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
      const currentMoney = currentMoneyRow.rows[0]?.money_state as string | undefined;
      const startIdx = targetPath.indexOf(currentMoney || "AuthHeld");
      const stepsToWalk = startIdx === -1 ? targetPath : targetPath.slice(startIdx + 1);
      for (const next of stepsToWalk) {
        await client.query(`UPDATE siton.participants SET money_state=$2 WHERE participant_id=$1`, [participantId, next]);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function moveToRecovery(participantId: string, args?: { withinWindow?: boolean }) {
  const within = args?.withinWindow !== false;
  const completionWindowUntil = within
    ? new Date(Date.now() + 30 * 60_000).toISOString()
    : new Date(Date.now() - 5 * 60_000).toISOString();
  await setStates(participantId, {
    dealState: "CompletionWindow",
    buyerState: "ChargeFailedCompletion",
    moneyState: "ChargeFailedRecovery",
    completionWindowUntil
  });
}

async function readOutboxRecoveryEvents(dealId: string) {
  const result = await pool.query(
    `SELECT event_uuid, status, payload
     FROM siton.outbox_events
     WHERE event_type='recovery_deal' AND aggregate_id=$1
     ORDER BY created_at ASC`,
    [dealId]
  );
  return result.rows as Array<{ event_uuid: string; status: string; payload: any }>;
}

async function readBuyerPaymentMethods(buyerId: string) {
  const result = await pool.query(
    `SELECT provider_code, provider_payment_method_id, status, last_authorized_at
     FROM siton.buyer_payment_methods
     WHERE buyer_id=$1
     ORDER BY created_at ASC`,
    [buyerId]
  );
  return result.rows;
}

async function tracking(participantId: string) {
  const r = await app.inject({ method: "GET", url: `/api/participants/${participantId}/tracking` });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as any;
}

async function main() {
  const dealId = await createDeal("primary");
  const participantId = await joinDeal(dealId, "alpha");

  await runTest("recovery CTA hidden for non-recovery state (JoinedAuthorized)", async () => {
    const body = await tracking(participantId);
    assert.notEqual(body.tracking.personal_status.status, "payment_update_required");
  });

  await runTest("recovery CTA appears with absolute /app/recovery link when in-window", async () => {
    await moveToRecovery(participantId, { withinWindow: true });
    const body = await tracking(participantId);
    assert.equal(body.tracking.personal_status.action_required, true);
    assert.equal(body.tracking.personal_status.status, "payment_update_required");
    assert.match(String(body.tracking.personal_status.cta?.href), /^\/app\/recovery\//);
    assert.match(String(body.tracking.personal_status.cta?.label), /תשלום/);
  });

  await runTest("recovery API forbidden when participant is in ChargedSuccess", async () => {
    const dealOk = await createDeal("forbidden-charged");
    const pid = await joinDeal(dealOk, "charged");
    await setStates(pid, {
      dealState: "CompletionWindow",
      buyerState: "ChargedSuccess",
      moneyState: "ChargedSuccess",
      completionWindowUntil: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `forbidden-charged-${Date.now()}` },
      payload: {}
    });
    // ChargedSuccess maps to "already_recovered" so callers can re-link to tracking.
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json() as any;
    assert.equal(body.status, "already_recovered");
    assert.match(String(body.next_url), /^\/app\/track\//);
  });

  await runTest("recovery API forbidden when participant is RecoveredCharge", async () => {
    const dealOk = await createDeal("forbidden-recovered");
    const pid = await joinDeal(dealOk, "recovered");
    await setStates(pid, {
      dealState: "CompletionWindow",
      buyerState: "Recovered",
      moneyState: "RecoveredCharge",
      completionWindowUntil: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `recovered-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as any).status, "already_recovered");
  });

  await runTest("recovery API forbidden when participant is Dropped", async () => {
    const dealOk = await createDeal("forbidden-dropped");
    const pid = await joinDeal(dealOk, "dropped");
    await setStates(pid, {
      dealState: "CompletionWindow",
      buyerState: "Dropped",
      moneyState: "AuthReleased",
      completionWindowUntil: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `dropped-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 409, r.body);
    const body = r.json() as any;
    assert.equal(body.error, "FORBIDDEN_ACTION");
  });

  await runTest("recovery API forbidden when participant is DealFailed", async () => {
    const dealOk = await createDeal("forbidden-dealfailed");
    const pid = await joinDeal(dealOk, "dealfailed");
    await setStates(pid, {
      dealState: "CompletionWindow",
      buyerState: "DealFailed",
      moneyState: "ChargeFailedRecovery",
      completionWindowUntil: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `dealfailed-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((r.json() as any).error, "FORBIDDEN_ACTION");
  });

  await runTest("recovery API forbidden when participant is DealCompleted", async () => {
    const dealOk = await createDeal("forbidden-dealcompleted");
    const pid = await joinDeal(dealOk, "dealcompleted");
    await setStates(pid, {
      dealState: "CompletionWindow",
      buyerState: "DealCompleted",
      moneyState: "ChargedSuccess",
      completionWindowUntil: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `dealcompleted-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as any).status, "already_recovered");
  });

  await runTest("recovery API rejects when completion window has elapsed", async () => {
    const dealOk = await createDeal("window-elapsed");
    const pid = await joinDeal(dealOk, "elapsed");
    await moveToRecovery(pid, { withinWindow: false });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `elapsed-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((r.json() as any).error, "NOT_IN_WINDOW");
  });

  await runTest("recovery API rejects when deal is not in CompletionWindow", async () => {
    const dealOk = await createDeal("not-completion-window");
    const pid = await joinDeal(dealOk, "notcw");
    await setStates(pid, {
      dealState: "Charging",
      buyerState: "ChargeFailedCompletion",
      moneyState: "ChargeFailedRecovery",
      completionWindowUntil: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `notcw-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 409);
    assert.equal((r.json() as any).error, "FORBIDDEN_ACTION");
  });

  await runTest("recovery API enqueues recovery_deal outbox job for valid in-window participant", async () => {
    const dealOk = await createDeal("queue-success");
    const pid = await joinDeal(dealOk, "queue");
    await moveToRecovery(pid, { withinWindow: true });
    const idemKey = `queue-${Date.now()}`;
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": idemKey },
      payload: {}
    });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.status, "recovery_queued");
    assert.equal(body.participant_id, pid);
    assert.equal(body.deal_id, dealOk);
    assert.equal(body.qty, 5);
    assert.equal(body.completion_amount, 5 * 42);
    assert.match(String(body.next_url), new RegExp(`^/app/track/${pid}`));

    const events = await readOutboxRecoveryEvents(dealOk);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.status, "pending");
    assert.equal(event.payload?.triggered_by, "participant.recovery_request");
    assert.equal(event.payload?.participant_id, pid);
  });

  await runTest("recovery API is idempotent on the same idempotency-key", async () => {
    const dealOk = await createDeal("idempotency");
    const pid = await joinDeal(dealOk, "idem");
    await moveToRecovery(pid, { withinWindow: true });
    const key = `idem-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const first = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": key },
      payload: {}
    });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": key },
      payload: {}
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(first.json(), second.json());

    const events = await readOutboxRecoveryEvents(dealOk);
    assert.equal(events.length, 1, "should not enqueue a second recovery_deal job for the same idempotency key");
  });

  await runTest("recovery API does not enqueue duplicate recovery_deal when one is already pending", async () => {
    const dealOk = await createDeal("partial-uniq");
    const pid = await joinDeal(dealOk, "puniq");
    await moveToRecovery(pid, { withinWindow: true });
    const r1 = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `puniq-1-${Date.now()}` },
      payload: {}
    });
    assert.equal(r1.statusCode, 200);
    const r2 = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `puniq-2-${Date.now()}` },
      payload: {}
    });
    assert.equal(r2.statusCode, 200);
    const body2 = r2.json() as any;
    assert.equal(body2.ok, true);
    assert.equal(body2.status, "recovery_queued");
    assert.equal(body2.already_pending, true);

    const events = await readOutboxRecoveryEvents(dealOk);
    assert.equal(events.length, 1, "partial unique index should prevent duplicate pending recovery_deal");
  });

  await runTest("recovery API rejects raw card data", async () => {
    const dealOk = await createDeal("raw-card");
    const pid = await joinDeal(dealOk, "rawcard");
    await moveToRecovery(pid, { withinWindow: true });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `rawcard-${Date.now()}` },
      payload: { card_number: "4111111111111111", cvv: "123", expiry: "12/30" }
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal((r.json() as any).error, "raw_card_data_forbidden");

    const events = await readOutboxRecoveryEvents(dealOk);
    assert.equal(events.length, 0, "raw-card request must not enqueue any recovery job");
  });

  await runTest("recovery API persists optional payment_method_id token reference (no raw data)", async () => {
    const dealOk = await createDeal("token-ref");
    const pid = await joinDeal(dealOk, "token");
    await moveToRecovery(pid, { withinWindow: true });
    // Look up the buyer_id we generated
    const buyerRow = await pool.query(`SELECT buyer_id FROM siton.participants WHERE participant_id=$1`, [pid]);
    const buyerId = buyerRow.rows[0].buyer_id as string;

    const tokenId = `pm-${Date.now()}`;
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `token-${Date.now()}` },
      payload: { payment_method_id: tokenId, provider_code: "mockpay" }
    });
    assert.equal(r.statusCode, 200, r.body);

    const methods = await readBuyerPaymentMethods(buyerId);
    assert.ok(methods.some((m: any) => m.provider_payment_method_id === tokenId && m.status === "active"));
  });

  await runTest("recovery API rejects unknown participant id with 404", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/00000000-0000-0000-0000-000000000000/recovery`,
      headers: { "idempotency-key": `missing-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 404);
    assert.equal((r.json() as any).error, "participant_not_found");
  });

  await runTest("recovery API rejects malformed participant id with 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/not-a-uuid/recovery`,
      headers: { "idempotency-key": `bad-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 400);
  });

  await runTest("recovery API does not allow quantity changes", async () => {
    const dealOk = await createDeal("qty-mutation");
    const pid = await joinDeal(dealOk, "qty");
    await moveToRecovery(pid, { withinWindow: true });
    const before = await pool.query(`SELECT qty FROM siton.participants WHERE participant_id=$1`, [pid]);
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `qty-${Date.now()}` },
      payload: { qty: 999 }
    });
    assert.equal(r.statusCode, 200, r.body);
    const after = await pool.query(`SELECT qty FROM siton.participants WHERE participant_id=$1`, [pid]);
    assert.equal(Number(before.rows[0].qty), Number(after.rows[0].qty), "qty must not change via recovery");
  });

  await runTest("recovery API does not transition state directly in the request thread", async () => {
    const dealOk = await createDeal("no-state-change");
    const pid = await joinDeal(dealOk, "nostate");
    await moveToRecovery(pid, { withinWindow: true });
    const before = await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [pid]);
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `nostate-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 200, r.body);
    const after = await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [pid]);
    assert.equal(before.rows[0].buyer_state, after.rows[0].buyer_state, "buyer_state must not change in request thread");
    assert.equal(before.rows[0].money_state, after.rows[0].money_state, "money_state must not change in request thread");
  });

  await runTest("recovery API response does not leak payment tokens or PII", async () => {
    const dealOk = await createDeal("no-pii");
    const pid = await joinDeal(dealOk, "pii");
    await moveToRecovery(pid, { withinWindow: true });
    const r = await app.inject({
      method: "POST",
      url: `/api/participants/${pid}/recovery`,
      headers: { "idempotency-key": `pii-${Date.now()}` },
      payload: {}
    });
    assert.equal(r.statusCode, 200);
    const text = JSON.stringify(r.json());
    assert.doesNotMatch(text, /4111111111111111|cvv|cvc|authorization_id|payment_token|secret/i);
  });

  await runTest("tracking endpoint hides recovery CTA when window has elapsed", async () => {
    const dealOk = await createDeal("tracking-window-closed");
    const pid = await joinDeal(dealOk, "windowclosed");
    await moveToRecovery(pid, { withinWindow: false });
    const body = await tracking(pid);
    assert.equal(body.tracking.personal_status.action_required, false);
    assert.equal(body.tracking.personal_status.cta, null);
  });

  await runTest("frontend ships the recovery route and submission scaffold", async () => {
    const appJs = await readFile("frontend/app.js", "utf8");
    assert.match(appJs, /\["recovery", \/\^\\\/app\\\/recovery/);
    assert.match(appJs, /renderRecoveryPage/);
    assert.match(appJs, /loadRecovery\b/);
    assert.match(appJs, /submitRecoveryRequest\b/);
    assert.match(appJs, /data-action="recovery-submit"/);
    // Recovery surface must not introduce marketplace / catalog / commission concepts.
    const recoverySlice = appJs.slice(appJs.indexOf("function renderRecoveryPage"), appJs.indexOf("function renderHome()"));
    assert.doesNotMatch(recoverySlice, /marketplace|catalog|public discovery|commission|payout/i);
    // Recovery surface must not capture raw card data.
    assert.doesNotMatch(recoverySlice, /card_number|cardNumber|cvv|cvc|expiry/i);
  });
}

try {
  await main();
  await pool.end();
  await app.close();
  process.exit(0);
} catch (error) {
  await pool.end().catch(() => undefined);
  await app.close().catch(() => undefined);
  console.error(error);
  process.exit(1);
}
