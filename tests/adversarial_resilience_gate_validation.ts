import { strict as assert } from "node:assert";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

process.env.PORT = String(process.env.PORT || "3491");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.ADMIN_API_KEY = "resilience-admin-key";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 24
});

const { app } = await import("../src/app.js");

const SELLER = `seller-resilience-${Date.now()}`;
const ADMIN_KEY = "resilience-admin-key";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function testIp(label: string) {
  const hash = Math.abs(Array.from(label).reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
  return `10.${hash % 220}.${Math.floor(hash / 220) % 220}.${(hash % 250) + 1}`;
}

function webhookHeaders(payload: Record<string, unknown>, secret = "mock-webhook-secret") {
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(payload);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return {
    "x-webhook-signature": `sha256=${digest}`,
    "x-webhook-timestamp": String(timestamp)
  };
}

async function createDeal(maxUnits: number, label: string, overrides: Record<string, unknown> = {}) {
  const key = `resilience-create-${label}-${randomUUID()}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-seller-id": SELLER,
      "x-request-id": key,
      "idempotency-key": key,
      "x-forwarded-for": testIp(key)
    },
    payload: {
      seller_id: SELLER,
      title: `Resilience ${label}`,
      price_per_unit: 42,
      min_units: 1,
      max_units: maxUnits,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      ...overrides
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as any).deal_id as string;
}

async function publishDeal(dealId: string, label: string) {
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_phone)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (seller_id) DO UPDATE
       SET business_name=EXCLUDED.business_name,
           support_phone=EXCLUDED.support_phone,
           updated_at=now()`,
    [SELLER, "Resilience Seller", "Resilience Seller Ltd", "0501234567"]
  );
  const key = `resilience-publish-${label}-${randomUUID()}`;
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-seller-id": SELLER,
      "x-request-id": key,
      "idempotency-key": key,
      "x-forwarded-for": testIp(key)
    },
    payload: { seller_terms_accepted: true }
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function verifiedOtp(label: string) {
  const phoneDigits = String(
    Math.abs(Array.from(`${label}-${Date.now()}-${Math.random()}`).reduce((sum, ch) => sum + ch.charCodeAt(0), 0))
  )
    .padStart(7, "0")
    .slice(-7);
  const start = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    headers: { "x-forwarded-for": testIp(`otp-start-${label}`) },
    payload: { phone: `050${phoneDigits}` }
  });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    headers: { "x-forwarded-for": testIp(`otp-verify-${label}`) },
    payload: { otp_session_id: started.otp_session_id, code: started.development_code }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const verified = verify.json() as any;
  return {
    buyer_id: verified.buyer_id as string,
    otp_token: verified.otp_token as string,
    otp_challenge_id: (verified.challenge_id || verified.otp_session_id) as string
  };
}

async function joinDeal(args: {
  dealId: string;
  buyerId: string;
  qty?: number;
  label: string;
  otp?: Awaited<ReturnType<typeof verifiedOtp>>;
  idemKey?: string;
}) {
  const otp = args.otp ?? (await verifiedOtp(args.label));
  const key = args.idemKey || `resilience-join-${args.label}-${randomUUID()}`;
  const response = await app.inject({
    method: "POST",
    url: `/deals/${args.dealId}/join`,
    headers: {
      "x-request-id": key,
      "idempotency-key": key,
      "x-forwarded-for": testIp(key)
    },
    payload: {
      buyer_id: args.buyerId,
      qty: args.qty ?? 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.otp_challenge_id,
      authorization_id: `auth-${key}`,
      authorization_provider: "mockpay"
    }
  });
  return response;
}

async function capacityEvidence(dealId: string) {
  const result = await pool.query(
    `SELECT
       d.max_units,
       COUNT(p.participant_id)::int AS participants,
       COALESCE(SUM(p.qty),0)::int AS qty_sum
     FROM siton.deals d
     LEFT JOIN siton.participants p
       ON p.deal_id=d.deal_id
      AND p.buyer_state NOT IN ('DealFailed','Dropped')
     WHERE d.deal_id=$1
     GROUP BY d.max_units`,
    [dealId]
  );
  return result.rows[0] as { max_units: number; participants: number; qty_sum: number };
}

async function cleanupSellerDeals() {
  const deals = await pool.query(`SELECT deal_id FROM siton.deals WHERE seller_id LIKE 'seller-resilience-%'`);
  for (const row of deals.rows) {
    await pool.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.idempotency_log WHERE entity_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1)`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.payment_attempts WHERE participant_id IN (SELECT participant_id FROM siton.participants WHERE deal_id=$1)`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.deal_chat_messages WHERE deal_id=$1`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.deal_images WHERE deal_id=$1`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.outbox_dlq WHERE aggregate_id=$1`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [row.deal_id]);
    await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [row.deal_id]);
  }
  await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id LIKE 'seller-resilience-%'`);
}

await cleanupSellerDeals();

await run("load: 150-way join storm preserves max_units and clean rejections", async () => {
  const dealId = await createDeal(20, "join-storm");
  await publishDeal(dealId, "join-storm");
  const otp = await verifiedOtp("join-storm-suite");

  const responses = await Promise.all(
    Array.from({ length: 150 }, (_value, index) =>
      joinDeal({
        dealId,
        buyerId: `buyer-storm-${index}`,
        label: `storm-${index}`,
        otp
      })
    )
  );
  const statusCounts = new Map<number, number>();
  for (const response of responses) statusCounts.set(response.statusCode, (statusCounts.get(response.statusCode) || 0) + 1);
  const evidence = await capacityEvidence(dealId);

  assert.equal(statusCounts.get(200), 20);
  assert.ok((statusCounts.get(409) || 0) >= 120, `expected clean 409 rejections, got ${JSON.stringify([...statusCounts])}`);
  assert.equal(evidence.max_units, 20);
  assert.equal(evidence.qty_sum, 20);
  assert.equal(evidence.participants, 20);
});

await run("load: same buyer storm allows repeat purchases but remains bounded", async () => {
  const dealId = await createDeal(6, "same-buyer");
  await publishDeal(dealId, "same-buyer");
  const otp = await verifiedOtp("same-buyer-suite");
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_value, index) =>
      joinDeal({
        dealId,
        buyerId: "buyer-repeat-resilience",
        label: `same-buyer-${index}`,
        otp
      })
    )
  );
  const succeeded = responses.filter((response) => response.statusCode === 200).length;
  const evidence = await capacityEvidence(dealId);
  const buyerRows = await pool.query(
    `SELECT COUNT(*)::int AS rows FROM siton.participants WHERE deal_id=$1 AND buyer_id=$2`,
    [dealId, "buyer-repeat-resilience"]
  );

  assert.equal(succeeded, 6);
  assert.equal(evidence.qty_sum, 6);
  assert.equal(Number(buyerRows.rows[0].rows), 6);
});

await run("load: last unit race admits one winner and no negative inventory", async () => {
  const dealId = await createDeal(1, "last-unit");
  await publishDeal(dealId, "last-unit");
  const otp = await verifiedOtp("last-unit-suite");
  const responses = await Promise.all(
    Array.from({ length: 60 }, (_value, index) =>
      joinDeal({
        dealId,
        buyerId: `buyer-last-${index}`,
        label: `last-${index}`,
        otp
      })
    )
  );
  const succeeded = responses.filter((response) => response.statusCode === 200).length;
  const evidence = await capacityEvidence(dealId);
  const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  const publicJson = publicDeal.json() as any;

  assert.equal(succeeded, 1);
  assert.equal(evidence.qty_sum, 1);
  assert.equal(publicJson.metrics.remaining_units, 0);
});

await run("abuse: OTP wrong-code storm locks safely and never verifies", async () => {
  const start = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    headers: { "x-forwarded-for": testIp("otp-abuse") },
    payload: { phone: `050${String(Date.now()).slice(-7)}` }
  });
  assert.equal(start.statusCode, 200, start.body);
  const challengeId = (start.json() as any).otp_session_id;

  const attempts = [];
  for (let index = 0; index < 8; index += 1) {
    attempts.push(
      await app.inject({
        method: "POST",
        url: "/api/otp/verify",
        headers: { "x-forwarded-for": testIp("otp-abuse") },
        payload: { otp_session_id: challengeId, code: "000000" }
      })
    );
  }
  assert.ok(attempts.some((response) => response.statusCode === 423), attempts.map((response) => response.statusCode).join(","));
  assert.ok(attempts.every((response) => response.statusCode !== 200));
  assert.doesNotMatch(attempts.map((response) => response.body).join("\n"), /050\d{7}/);
});

await run("abuse: recovery outside ChargeFailedCompletion is forbidden and side-effect free", async () => {
  const dealId = await createDeal(4, "bad-recovery");
  await publishDeal(dealId, "bad-recovery");
  const join = await joinDeal({ dealId, buyerId: "buyer-recovery-abuse", label: "bad-recovery" });
  assert.equal(join.statusCode, 200, join.body);
  const participantId = (join.json() as any).participant_id as string;

  const recovery = await app.inject({
    method: "POST",
    url: `/api/participants/${participantId}/recovery`,
    headers: {
      "idempotency-key": `bad-recovery-${randomUUID()}`,
      "x-forwarded-for": testIp("bad-recovery")
    },
    payload: { payment_method_id: "pm_not_used" }
  });
  assert.equal(recovery.statusCode, 409, recovery.body);
  assert.match(recovery.body, /FORBIDDEN_ACTION|NOT_IN_WINDOW/);

  const row = await pool.query(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [participantId]
  );
  assert.equal(row.rows[0].buyer_state, "JoinedAuthorized");
  assert.equal(row.rows[0].money_state, "AuthHeld");
});

await run("inputs: XSS strings are bounded and frontend render path escapes buyer-visible text", async () => {
  const xssTitle = `<script>alert(1)</script>`;
  const xssImg = `<img src=x onerror=alert(1)>`;
  const dealId = await createDeal(3, "xss", { title: xssTitle });
  await publishDeal(dealId, "xss");
  const chat = await app.inject({
    method: "POST",
    url: `/api/deals/${dealId}/chat`,
    payload: { display_name: xssImg, body: xssTitle }
  });
  assert.equal(chat.statusCode, 201, chat.body);

  const frontend = await readFile("frontend/app.js", "utf8");
  assert.match(frontend, /function esc\(/);
  assert.match(frontend, /<strong>\$\{esc\(message\.display_name/);
  assert.match(frontend, /<p>\$\{esc\(message\.body/);
  assert.match(frontend, /alt="[^"]*\$\{esc\(.*deal/);
});

await run("inputs: SQL-ish params and oversized payloads fail cleanly", async () => {
  const probes = [
    await app.inject({ method: "GET", url: "/api/deals/'%20OR%20'1'%3D'1/public" }),
    await app.inject({ method: "GET", url: "/api/participants/');%20DROP%20TABLE%20siton.deals;%20--/tracking" }),
    await app.inject({ method: "GET", url: "/api/admin/support-cases/not-a-uuid", headers: { "x-admin-key": ADMIN_KEY } })
  ];
  assert.ok(probes.every((response) => [400, 404, 405].includes(response.statusCode)), probes.map((r) => r.statusCode).join(","));
  assert.ok(probes.every((response) => !/stack|at .*\.ts:/i.test(response.body)), probes.map((r) => r.body).join("\n"));

  const longTitle = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { "x-seller-id": SELLER, "x-forwarded-for": testIp("long-title") },
    payload: {
      seller_id: SELLER,
      title: "x".repeat(201),
      price_per_unit: 42,
      min_units: 1,
      max_units: 2,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    }
  });
  assert.equal(longTitle.statusCode, 400, longTitle.body);

  const dealId = await createDeal(2, "oversized-chat");
  await publishDeal(dealId, "oversized-chat");
  const longChat = await app.inject({
    method: "POST",
    url: `/api/deals/${dealId}/chat`,
    payload: { display_name: "buyer", body: "x".repeat(501) }
  });
  assert.equal(longChat.statusCode, 400, longChat.body);
});

await run("auth: admin surfaces fail closed without or with wrong ADMIN_API_KEY", async () => {
  const adminUrls = [
    "/api/admin/demo-readiness",
    "/api/admin/outbox-status",
    "/api/admin/system-ops-status",
    "/api/admin/support-cases",
    "/api/admin/invoice-status",
    "/api/admin/payout-status"
  ];
  for (const url of adminUrls) {
    const missing = await app.inject({ method: "GET", url });
    const wrong = await app.inject({ method: "GET", url, headers: { "x-admin-key": "wrong" } });
    assert.equal(missing.statusCode, 401, `${url} missing key returned ${missing.statusCode}`);
    assert.equal(wrong.statusCode, 401, `${url} wrong key returned ${wrong.statusCode}`);
    assert.doesNotMatch(`${missing.body}\n${wrong.body}`, /resilience-admin-key|DATABASE_URL|postgres/i);
  }
});

await run("auth: seller ownership and forbidden constitutional surfaces stay blocked", async () => {
  const dealId = await createDeal(2, "seller-isolation");
  const otherSeller = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}`,
    headers: { "x-seller-id": `${SELLER}-other` }
  });
  assert.ok([403, 404].includes(otherSeller.statusCode), otherSeller.body);

  const forbidden = await Promise.all([
    app.inject({ method: "GET", url: "/api/marketplace" }),
    app.inject({ method: "GET", url: "/api/search?q=x" }),
    app.inject({ method: "GET", url: "/api/catalog" }),
    app.inject({ method: "GET", url: "/api/affiliate/payouts" }),
    app.inject({ method: "GET", url: "/api/affiliate/commission" }),
    app.inject({ method: "POST", url: "/api/admin/capture", headers: { "x-admin-key": ADMIN_KEY } }),
    app.inject({ method: "POST", url: "/api/admin/refund", headers: { "x-admin-key": ADMIN_KEY } }),
    app.inject({ method: "POST", url: "/api/admin/void", headers: { "x-admin-key": ADMIN_KEY } })
  ]);
  assert.ok(forbidden.every((response) => [404, 405].includes(response.statusCode)), forbidden.map((r) => r.statusCode).join(","));
});

await run("webhook/idempotency: bad signatures, duplicates, and parallel same-key joins are safe", async () => {
  const badPayload = { event_id: `bad-sig-${randomUUID()}`, event_type: "charge_captured", payload: {} };
  const badSig = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: webhookHeaders(badPayload, "wrong-secret"),
    payload: badPayload
  });
  assert.equal(badSig.statusCode, 401, badSig.body);

  const duplicatePayload = { event_id: `dup-${randomUUID()}`, event_type: "provider_ping", payload: {} };
  const first = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: webhookHeaders(duplicatePayload),
    payload: duplicatePayload
  });
  const second = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: webhookHeaders(duplicatePayload),
    payload: duplicatePayload
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);

  const dealId = await createDeal(4, "parallel-idem");
  await publishDeal(dealId, "parallel-idem");
  const otp = await verifiedOtp("parallel-idem");
  const idemKey = `same-key-${randomUUID()}`;
  const joins = await Promise.all(
    Array.from({ length: 12 }, () =>
      joinDeal({
        dealId,
        buyerId: "buyer-parallel-idem",
        label: "parallel-idem",
        otp,
        idemKey
      })
    )
  );
  const successes = joins.filter((response) => response.statusCode === 200);
  assert.ok(successes.length >= 1);
  assert.equal(new Set(successes.map((response) => (response.json() as any).participant_id)).size, 1);
  const evidence = await capacityEvidence(dealId);
  assert.equal(evidence.qty_sum, 1);
  assert.equal(evidence.participants, 1);
});

await run("outbox: pending, stale processing, and DLQ are visible to admin status", async () => {
  const dealId = await createDeal(2, "outbox-visibility");
  const staleEventId = randomUUID();
  const dlqEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status,
       attempt_count, available_at, processing_started_at, created_at, updated_at
     ) VALUES ($1,'deadline_check','deal',$2,$3,'processing',2,now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '20 minutes')`,
    [staleEventId, dealId, JSON.stringify({ deal_id: dealId, resilience_probe: true })]
  );
  await pool.query(
    `INSERT INTO siton.outbox_dlq (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status,
       attempt_count, available_at, last_error, created_at, updated_at
     ) VALUES ($1,'deadline_check','deal',$2,$3,'failed',10,now()-interval '30 minutes','resilience final failure',now()-interval '30 minutes',now()-interval '30 minutes')`,
    [dlqEventId, dealId, JSON.stringify({ deal_id: dealId, resilience_probe: true })]
  );

  const status = await app.inject({
    method: "GET",
    url: "/api/admin/outbox-status",
    headers: { "x-admin-key": ADMIN_KEY }
  });
  assert.equal(status.statusCode, 200, status.body);
  const body = status.json() as any;
  assert.ok(JSON.stringify(body).includes("processing"));
  assert.ok(Number(body.outbox?.dlq ?? body.summary?.dlq_count ?? body.dlq_count ?? 0) >= 1, JSON.stringify(body));
  assert.ok(Number(body.outbox?.stuck_candidates ?? 0) >= 1, JSON.stringify(body));
});

await run("storage: image upload rejects MIME abuse, oversized bodies, and filename traversal", async () => {
  const dealId = await createDeal(2, "storage");
  const invalidMime = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": SELLER },
    payload: {
      image_base64: Buffer.from("not-image").toString("base64"),
      mime_type: "text/html",
      original_filename: "x.png"
    }
  });
  assert.equal(invalidMime.statusCode, 400, invalidMime.body);

  const tooLarge = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": SELLER },
    payload: {
      image_base64: Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64"),
      mime_type: "image/png",
      original_filename: "large.png"
    }
  });
  assert.equal(tooLarge.statusCode, 400, tooLarge.body);

  const traversal = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": SELLER },
    payload: {
      image_base64: Buffer.from("tiny").toString("base64"),
      mime_type: "image/png",
      original_filename: "../../evil.png"
    }
  });
  assert.equal(traversal.statusCode, 201, traversal.body);
  const row = await pool.query(
    `SELECT storage_key, original_filename FROM siton.deal_images WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [dealId]
  );
  assert.doesNotMatch(String(row.rows[0].storage_key), /\.\.|\\/);
  assert.equal(row.rows[0].original_filename, "evil.png");
});

try {
  await cleanupSellerDeals();
} finally {
  await pool.end();
  await app.close();
}

console.log("Adversarial resilience gate validation passed.");
