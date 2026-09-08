// Shared fixture for the physical pickup / handoff suites. Not a test file
// (tests/helpers is never enumerated by the runner).
//
// Deterministic by construction: money states are moved along the canonical
// transition matrices through the trigger-legal forced path the tracking and
// browser-proof suites already use (one transaction, siton.in_atomic +
// audit/outbox flags + action name per step). No provider call, no real money.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function sellerHeaders(sellerId: string) {
  return { "x-seller-id": sellerId, "content-type": "application/json" };
}

export const BOOKSTORE_PICKUP = {
  option_type: "pickup",
  label: "חנות הספרים — הרצל 12, תל אביב",
  cost: 0,
  sort_order: 0,
  latitude: 32.0668,
  longitude: 34.7647
};
export const BOOKSTORE_DELIVERY = { option_type: "delivery", label: "שליח עד הבית", cost: 20, sort_order: 1 };

export async function ensureSellerReady(app: any, sellerId: string, businessName: string) {
  const r = await app.inject({
    method: "PUT",
    url: "/api/seller/business-profile",
    headers: sellerHeaders(sellerId),
    payload: { business_name: businessName, business_id_number: "515000003", contact_name: "בודק", contact_phone: "0501234567" }
  });
  assert.equal(r.statusCode, 200, r.body);
}

export async function createDeal(
  app: any,
  sellerId: string,
  opts: { title: string; price?: number; minUnits?: number; maxUnits?: number; deliveryOptions?: any[]; extra?: Record<string, unknown> }
) {
  const r = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { ...sellerHeaders(sellerId), "idempotency-key": `pf-${randomUUID().slice(0, 12)}` },
    payload: {
      title: opts.title,
      description_short: "ספר בכריכה קשה",
      description: "תיאור מלא של המוצר",
      price_per_unit: opts.price ?? 60,
      list_price_per_unit: (opts.price ?? 60) + 30,
      min_units: opts.minUnits ?? 3,
      max_units: opts.maxUnits ?? 40,
      deadline: new Date(Date.now() + 3 * 864e5).toISOString(),
      deal_type: "physical_product",
      delivery_options: opts.deliveryOptions ?? [BOOKSTORE_PICKUP, BOOKSTORE_DELIVERY],
      ...(opts.extra || {})
    }
  });
  assert.ok([200, 201].includes(r.statusCode), r.body);
  const j = r.json() as any;
  return String(j.deal_id || j.deal?.deal_id);
}

export async function publishDeal(app: any, sellerId: string, dealId: string) {
  const r = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: { ...sellerHeaders(sellerId), "idempotency-key": `pf-pub-${randomUUID().slice(0, 8)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(r.statusCode, 200, r.body);
}

export async function otpVerify(app: any, phone: string) {
  const s = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone } });
  assert.equal(s.statusCode, 200, s.body);
  const sj = s.json() as any;
  const v = await app.inject({ method: "POST", url: "/api/otp/verify", payload: { otp_session_id: sj.otp_session_id, code: sj.development_code } });
  assert.equal(v.statusCode, 200, v.body);
  const vj = v.json() as any;
  return { buyer_id: String(vj.buyer_id), otp_token: String(vj.otp_token), otp_challenge_id: String(vj.challenge_id || vj.otp_session_id) };
}

export async function deliveryOption(app: any, dealId: string, optionType: string) {
  const r = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(r.statusCode, 200, r.body);
  const opt = ((r.json() as any).deal.delivery_options || []).find((o: any) => o.option_type === optionType);
  assert.ok(opt, `no ${optionType} option on deal ${dealId}`);
  return opt;
}

export async function joinDeal(
  app: any,
  dealId: string,
  args: { phone: string; name: string; qty: number; optionType: "pickup" | "delivery"; email?: string; address?: string; city?: string; notes?: string }
) {
  const otp = await otpVerify(app, args.phone);
  // Voucher/ticket deals carry no delivery options; physical deals must name one.
  const pub = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  const hasOptions = Array.isArray((pub.json() as any).deal?.delivery_options) && (pub.json() as any).deal.delivery_options.length > 0;
  const opt = hasOptions ? await deliveryOption(app, dealId, args.optionType) : null;
  const payload: any = {
    buyer_id: otp.buyer_id,
    buyer_name: args.name,
    qty: args.qty,
    ...(opt ? { delivery_option_id: opt.option_id } : {}),
    buyer_terms_accepted: true,
    payment_disclosure_accepted: true,
    payment_method: "credit_card",
    otp_token: otp.otp_token,
    otp_challenge_id: otp.otp_challenge_id
  };
  if (args.email) payload.buyer_email = args.email;
  if (args.address) payload.delivery_address = args.address;
  if (args.city) payload.delivery_city = args.city;
  if (args.notes) payload.delivery_notes = args.notes;
  const r = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: { "content-type": "application/json", "idempotency-key": `pf-join-${randomUUID().slice(0, 10)}` },
    payload
  });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json() as any;
  assert.ok(j.participant_id && j.tracking_access_token, r.body);
  return { participant_id: String(j.participant_id), tracking_access_token: String(j.tracking_access_token), buyer_id: otp.buyer_id };
}

const DEAL_PATHS: Record<string, Array<{ to: string; action: string }>> = {
  Completed: [
    { to: "TargetReached", action: "deal.target_reached" },
    { to: "ClosedForJoining", action: "deal.close_joining" },
    { to: "ReadyForCharging", action: "deal.prepare_charging" },
    { to: "Charging", action: "charging.start" },
    { to: "CompletionWindow", action: "charging.to_completion_window" },
    { to: "Completed", action: "charging.finalize_completed" }
  ],
  Failed: [{ to: "Failed", action: "deal.deadline_check" }]
};

async function forcedTx(pool: any, actionName: string, fn: (client: any) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('app.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    await client.query(`SELECT set_config('siton.action_name', $1, true)`, [actionName]);
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function forceDealState(pool: any, dealId: string, state: "Completed" | "Failed") {
  const path = DEAL_PATHS[state];
  assert.ok(path, `unsupported forced state ${state}`);
  await forcedTx(pool, path[0]!.action, async (client) => {
    for (const step of path) {
      await client.query(`SELECT set_config('siton.action_name', $1, true)`, [step.action]);
      await client.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, step.to]);
    }
  });
}

// Legal paths from the post-join state (JoinedAuthorized / AuthHeld).
export const PARTICIPANT_PATHS: Record<string, { buyer: string[]; money: string[] }> = {
  AuthHeld: { buyer: [], money: [] },
  AuthLocked: { buyer: ["LockedIn"], money: ["AuthLocked"] },
  ChargeAttempt: { buyer: ["LockedIn", "ChargingAttempt"], money: ["AuthLocked", "ChargeAttempt"] },
  ChargeFailedRecovery: {
    buyer: ["LockedIn", "ChargingAttempt", "ChargeFailedCompletion"],
    money: ["AuthLocked", "ChargeAttempt", "ChargeFailedRecovery"]
  },
  AuthReleased: {
    buyer: ["LockedIn", "ChargingAttempt", "ChargeFailedCompletion", "Dropped"],
    money: ["AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "AuthReleased"]
  },
  ChargedSuccess: {
    buyer: ["LockedIn", "ChargingAttempt", "ChargedSuccess", "DealCompleted"],
    money: ["AuthLocked", "ChargeAttempt", "ChargedSuccess"]
  },
  RecoveredCharge: {
    buyer: ["LockedIn", "ChargingAttempt", "ChargeFailedCompletion", "Recovered", "DealCompleted"],
    money: ["AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "RecoveredCharge"]
  },
  Refunded: {
    buyer: ["LockedIn", "ChargingAttempt", "ChargedSuccess", "DealCompleted"],
    money: ["AuthLocked", "ChargeAttempt", "ChargedSuccess", "Refunded"]
  }
};

export async function forceParticipantTo(pool: any, participantId: string, target: keyof typeof PARTICIPANT_PATHS) {
  const path = PARTICIPANT_PATHS[target];
  assert.ok(path, `unsupported participant target ${String(target)}`);
  await forcedTx(pool, "test.physical_fulfillment_fixture", async (client) => {
    for (const buyerState of path.buyer) {
      await client.query(`UPDATE siton.participants SET buyer_state=$2 WHERE participant_id=$1`, [participantId, buyerState]);
    }
    for (const moneyState of path.money) {
      await client.query(`UPDATE siton.participants SET money_state=$2 WHERE participant_id=$1`, [participantId, moneyState]);
    }
  });
}

export async function participantStates(pool: any, participantId: string) {
  const r = await pool.query(`SELECT buyer_state, money_state, deal_id FROM siton.participants WHERE participant_id=$1`, [participantId]);
  return r.rows[0] as { buyer_state: string; money_state: string; deal_id: string };
}

export async function tracking(app: any, participantId: string, token: string) {
  return app.inject({ method: "GET", url: `/api/participants/${participantId}/tracking?t=${encodeURIComponent(token)}` });
}

// The strings that must never appear in a QR payload or an error body.
export function piiStrings(args: { name: string; phone: string; email?: string; participantId: string; token?: string }) {
  const out = [args.name, args.phone, args.participantId];
  if (args.email) out.push(args.email);
  if (args.token) out.push(args.token);
  return out;
}

export function assertNoPii(haystack: string, pii: string[], label: string) {
  for (const needle of pii) {
    if (!needle) continue;
    assert.ok(!haystack.includes(needle), `${label} leaks "${needle.slice(0, 12)}…"`);
  }
}
