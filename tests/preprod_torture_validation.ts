import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function ensureFrontendAssets() {
  await mkdir(frontendTarget, { recursive: true });
  await cp(frontendSource, frontendTarget, { recursive: true, force: true });
}

async function createDeal(
  title: string,
  suffix: string,
  overrides: Record<string, unknown> = {}
) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `preprod-create-${unique}`,
      "idempotency-key": `preprod-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 42,
      min_units: 8,
      max_units: 10,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      ...overrides
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function post(
  url: string,
  requestId: string,
  payload: Record<string, unknown> = {}
) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "x-request-id": requestId,
      "idempotency-key": requestId
    },
    payload
  });
}

async function publishDeal(dealId: string, suffix: string) {
  const response = await post(`/deals/${dealId}/publish`, `preprod-publish-${suffix}`);
  assert.equal(response.statusCode, 200);
}

async function buildChargingParticipant(
  suffix: string,
  buyerId: string,
  qty = 8
) {
  const created = await createDeal(`Preprod Charging ${suffix}`, suffix, {
    min_units: qty,
    max_units: qty
  });
  await publishDeal(created.deal_id, suffix);

  const join = await post(`/deals/${created.deal_id}/join`, `preprod-join-${suffix}`, {
    buyer_id: buyerId,
    qty
  });
  assert.equal(join.statusCode, 200);
  const joinJson = join.json() as any;

  const closeJoining = await post(
    `/deals/${created.deal_id}/close_joining`,
    `preprod-close-${suffix}`
  );
  assert.equal(closeJoining.statusCode, 200);

  const prepare = await post(
    `/deals/${created.deal_id}/prepare_charging`,
    `preprod-prepare-${suffix}`
  );
  assert.equal(prepare.statusCode, 200);

  const start = await post(
    `/deals/${created.deal_id}/charging/start`,
    `preprod-start-${suffix}`
  );
  assert.equal(start.statusCode, 200);

  return {
    deal_id: created.deal_id,
    participant_id: joinJson.participant_id as string
  };
}

async function pushWebhook(args: {
  eventType: string;
  dealId?: string | null;
  participantId?: string | null;
  providerReference?: string;
  eventId?: string;
}) {
  return app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: {
      "x-webhook-secret": "mock-webhook-secret"
    },
    payload: {
      event_id:
        args.eventId ??
        `${args.eventType}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      event_type: args.eventType,
      deal_id: args.dealId ?? undefined,
      participant_id: args.participantId ?? undefined,
      payload: {
        participant_id: args.participantId ?? undefined,
        deal_id: args.dealId ?? undefined,
        provider_reference: args.providerReference ?? `${args.eventType}-ref`
      }
    }
  });
}

async function debugDeal(dealId: string) {
  const previousEnabled = process.env.DEBUG_SURFACES_ENABLED;
  const previousAccessKey = process.env.DEBUG_SURFACES_ACCESS_KEY;
  process.env.DEBUG_SURFACES_ENABLED = "1";
  process.env.DEBUG_SURFACES_ACCESS_KEY = "preprod-debug-key";
  try {
    const blocked = await app.inject({
      method: "GET",
      url: `/debug/deals/${dealId}`
    });
    assert.equal(blocked.statusCode, 403);

    const response = await app.inject({
      method: "GET",
      url: `/debug/deals/${dealId}`,
      headers: {
        "x-debug-access-key": "preprod-debug-key"
      }
    });
    assert.equal(response.statusCode, 200);
    return response.json() as any;
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.DEBUG_SURFACES_ENABLED;
    } else {
      process.env.DEBUG_SURFACES_ENABLED = previousEnabled;
    }
    if (previousAccessKey === undefined) {
      delete process.env.DEBUG_SURFACES_ACCESS_KEY;
    } else {
      process.env.DEBUG_SURFACES_ACCESS_KEY = previousAccessKey;
    }
  }
}

async function authorizeBuyer(suffix: string) {
  const otpStart = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    payload: {
      phone: `05077${suffix.padStart(5, "0").slice(0, 5)}`
    }
  });
  assert.equal(otpStart.statusCode, 200);
  const otpStartJson = otpStart.json() as any;

  const otpVerify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: {
      otp_session_id: otpStartJson.otp_session_id,
      code: otpStartJson.development_code
    }
  });
  assert.equal(otpVerify.statusCode, 200);
  const otpVerifyJson = otpVerify.json() as any;

  const payment = await app.inject({
    method: "POST",
    url: "/api/payments/authorize-mock",
    payload: {
      holder_name: `Preprod Buyer ${suffix}`,
      card_number: "4111111111111111",
      expiry: "12/28",
      cvv: "123"
    }
  });
  assert.equal(payment.statusCode, 200);

  return {
    buyer_id: otpVerifyJson.buyer_id as string
  };
}

async function main() {
  await ensureFrontendAssets();

  await runTest("torture matrix mixed load preserves capacity and buyer-flow coherence", async () => {
    const created = await createDeal("Preprod Mixed Load Deal", "mixed-load");
    await publishDeal(created.deal_id, "mixed-load");

    const authorizations = await Promise.all(
      Array.from({ length: 12 }, async (_value, index) => authorizeBuyer(String(index + 1)))
    );

    const publicRequests = Array.from({ length: 12 }, () =>
      app.inject({ method: "GET", url: `/api/deals/${created.deal_id}/public` })
    );
    const shellRequests = Array.from({ length: 12 }, () =>
      app.inject({ method: "GET", url: `/app/deal/${created.deal_id}` })
    );
    const joinRequests = authorizations.map((auth, index) =>
      post(`/deals/${created.deal_id}/join`, `preprod-mixed-join-${index}-${Date.now()}`, {
        buyer_id: auth.buyer_id,
        qty: 1
      })
    );

    const [publicResponses, shellResponses, joinResponses] = await Promise.all([
      Promise.all(publicRequests),
      Promise.all(shellRequests),
      Promise.all(joinRequests)
    ]);

    assert.ok(publicResponses.every((response: any) => response.statusCode === 200));
    assert.ok(shellResponses.every((response: any) => response.statusCode === 200));
    assert.ok(joinResponses.every((response: any) => response.statusCode === 200 || response.statusCode === 409));

    const debug = await debugDeal(created.deal_id);
    const joinedUnits = debug.participants.reduce(
      (sum: number, participant: any) => sum + Number(participant.qty),
      0
    );

    assert.equal(debug.deal.max_units, 10);
    assert.equal(debug.participants.length, 10);
    assert.equal(joinedUnits, 10);
    assert.equal(debug.outbox.length, 1);
    assert.equal(debug.outbox[0].event_type, "deadline_check");
    assert.equal(debug.dlq.length, 0);

    const publicDeal = await app.inject({
      method: "GET",
      url: `/api/deals/${created.deal_id}/public`
    });
    const publicJson = publicDeal.json() as any;
    assert.equal(publicJson.availability.reasonCode, "stock_exhausted");
    assert.equal(publicJson.metrics.remaining_units, 0);
  });

  await runTest("soak-like repeated reads and tracking stay coherent without silent degradation", async () => {
    const created = await createDeal("Preprod Soak Deal", "soak");
    await publishDeal(created.deal_id, "soak");

    const auth = await authorizeBuyer("801");
    const join = await post(`/deals/${created.deal_id}/join`, `preprod-soak-join-${Date.now()}`, {
      buyer_id: auth.buyer_id,
      qty: 2
    });
    assert.equal(join.statusCode, 200);
    const joinJson = join.json() as any;

    for (let iteration = 0; iteration < 40; iteration += 1) {
      const publicDeal = await app.inject({
        method: "GET",
        url: `/api/deals/${created.deal_id}/public`
      });
      const tracking = await app.inject({
        method: "GET",
        url: `/api/participants/${joinJson.participant_id}/tracking`
      });
      assert.equal(publicDeal.statusCode, 200);
      assert.equal(tracking.statusCode, 200);
      assert.equal((tracking.json() as any).tracking.buyer_state, "JoinedAuthorized");
    }

    const debug = await debugDeal(created.deal_id);
    assert.equal(debug.outbox.length, 1);
    assert.equal(debug.dlq.length, 0);
  });

  await runTest("restart-and-recovery-adjacent drill keeps outbox and reconciliation coherent under ugly ordering", async () => {
    const charging = await buildChargingParticipant("recovery-drill", "buyer-preprod-recovery");

    const earlyRecovery = await pushWebhook({
      eventType: "recovery_captured",
      dealId: charging.deal_id,
      participantId: charging.participant_id
    });
    assert.equal(earlyRecovery.statusCode, 202);
    assert.equal((earlyRecovery.json() as any).reconciliation.status, "ignored");

    const trackingDuringCharge = await app.inject({
      method: "GET",
      url: `/api/participants/${charging.participant_id}/tracking`
    });
    assert.equal(trackingDuringCharge.statusCode, 200);
    assert.equal((trackingDuringCharge.json() as any).tracking.buyer_state, "ChargingAttempt");

    const chargeFailed = await pushWebhook({
      eventType: "charge_failed",
      dealId: charging.deal_id,
      participantId: charging.participant_id
    });
    assert.equal(chargeFailed.statusCode, 202);
    assert.equal((chargeFailed.json() as any).reconciliation.status, "processed");

    const lateChargeDuplicate = await pushWebhook({
      eventType: "charge_failed",
      dealId: charging.deal_id,
      participantId: charging.participant_id
    });
    assert.equal(lateChargeDuplicate.statusCode, 202);
    assert.equal((lateChargeDuplicate.json() as any).reconciliation.status, "ignored");

    const recoveryCaptured = await pushWebhook({
      eventType: "recovery_captured",
      dealId: charging.deal_id,
      participantId: charging.participant_id
    });
    assert.equal(recoveryCaptured.statusCode, 202);
    assert.equal((recoveryCaptured.json() as any).reconciliation.status, "processed");

    const lateRecoveryDuplicate = await pushWebhook({
      eventType: "recovery_captured",
      dealId: charging.deal_id,
      participantId: charging.participant_id
    });
    assert.equal(lateRecoveryDuplicate.statusCode, 202);
    assert.equal((lateRecoveryDuplicate.json() as any).reconciliation.status, "ignored");

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${charging.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.tracking.buyer_state, "Recovered");
    assert.equal(trackingJson.tracking.money_state, "RecoveredCharge");

    const debug = await debugDeal(charging.deal_id);
    assert.equal(debug.dlq.length, 0);
    assert.ok(
      debug.payment_attempts.every((attempt: any) =>
        ["charge_start", "recovery", "refund", "deadline_check", "cancel_refund"].includes(
          attempt.attempt_type
        )
      )
    );
    assert.ok(
      debug.outbox.every((event: any) =>
        ["pending", "processing", "sent", "failed"].includes(event.status)
      )
    );
  });

  await runTest("cross-flow abuse across stale session, direct routes, and retries does not create false success", async () => {
    const paymentWithoutOtp = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Route Jumper",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123"
      }
    });
    assert.equal(paymentWithoutOtp.statusCode, 200);

    const confirmationShell = await app.inject({
      method: "GET",
      url: "/app/join/00000000-0000-0000-0000-000000000000/confirmation"
    });
    assert.equal(confirmationShell.statusCode, 200);

    const missingTracking = await app.inject({
      method: "GET",
      url: "/api/participants/00000000-0000-0000-0000-000000000000/tracking"
    });
    assert.equal(missingTracking.statusCode, 404);

    const missingOtp = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: "missing-session",
        code: "123456"
      }
    });
    assert.equal(missingOtp.statusCode, 404);
  });

  await runTest("rc drill under pressure keeps health, integrations, routes, and webhook auth operational", async () => {
    const created = await createDeal("Preprod RC Drill Deal", "rc-drill");
    await publishDeal(created.deal_id, "rc-drill");

    const pressureRequests = await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        app.inject({
          method: "GET",
          url: index % 2 === 0 ? "/health" : "/health/integrations"
        })
      )
    );
    assert.ok(pressureRequests.every((response: any) => response.statusCode === 200));

    const keyRoutes = await Promise.all([
      app.inject({ method: "GET", url: `/api/deals/${created.deal_id}/public` }),
      app.inject({ method: "GET", url: `/app/deal/${created.deal_id}` }),
      app.inject({
        method: "POST",
        url: "/webhooks/payments/mock",
        headers: { "x-webhook-secret": "wrong-secret" },
        payload: {
          event_id: `unauthorized-${Date.now()}`,
          event_type: "charge_captured",
          payload: {}
        }
      })
    ]);

    assert.equal(keyRoutes[0].statusCode, 200);
    assert.equal(keyRoutes[1].statusCode, 200);
    assert.equal(keyRoutes[2].statusCode, 401);

    const debug = await debugDeal(created.deal_id);
    assert.equal(debug.dlq.length, 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
