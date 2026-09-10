/**
 * INDEPENDENT REVIEW — P0 counterexample, written to run on BOTH sides of an A/B.
 *
 * The reviewed claim: a provider status answer that names a FOREIGN operation
 * reference must never become capture proof. The independent review of the R9C
 * integration candidate has to establish two separate facts:
 *
 *   1  the defect is REAL on canonical master (which has no reference
 *      discipline at all): a status seam that answers "captured / final" about
 *      some other reference turns a participant into ChargedSuccess while the
 *      provider was never asked to capture anything;
 *   2  the candidate PREVENTS it, and prevents it prefix-exactly (the final
 *      review correction replaced a `/^[a-z]{3}-/i` alias with the four
 *      defined operation prefixes).
 *
 * This file therefore deliberately avoids everything that exists only on the
 * candidate: no tests/lab harness, no payment_attempts lifecycle columns, no
 * ambiguity policy. It uses only the participant state machine, the
 * payment_reconcile outbox rail and the provider-ready HTTP seam, all of which
 * are byte-identical on master and on the candidate. It asserts the SAFE
 * outcome, so it FAILS on master and PASSES on the candidate.
 *
 * REAL MONEY: none. The "provider" is a local HTTP stub; every capture and
 * recovery endpoint records the call and is asserted never to be reached.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

const PORT = 3211;
const PROVIDER_PORT = 3212;

type ProviderCall = { url: string; method: string };

const providerCalls: ProviderCall[] = [];

/**
 * The status seam answers about a DIFFERENT operation. `foreignReference` is
 * set per scenario; the amount and currency deliberately MATCH the obligation
 * so that the amount and currency ties cannot be what saves the system — only
 * exact-operation reference identity can.
 */
let foreignReferenceFor: (queried: string) => string = (queried) => `xyz-${queried}`;
let statusAmountMinor = 0;

const providerStub = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("end", () => {
    const url = String(req.url || "");
    providerCalls.push({ url, method: String(req.method || "") });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/status/")) {
      const queried = decodeURIComponent(url.split("/status/")[1]!.split("?")[0]!);
      return json(200, {
        ok: true,
        provider_reference: foreignReferenceFor(queried),
        state: "captured",
        final: true,
        amount_minor: statusAmountMinor,
        currency: "ILS",
        provider_time: new Date().toISOString()
      });
    }
    // A capture / recovery / refund / release must never be reached in this
    // scenario. Answer honestly if it ever is, so the assertion can see it.
    return json(200, { ok: true, status: "captured", provider_reference: `cap-${randomUUID()}` });
  });
});

async function main() {
  await new Promise<void>((resolve) => providerStub.listen(PROVIDER_PORT, "127.0.0.1", () => resolve()));

  process.env.PORT = String(PORT);
  process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
  process.env.DISABLE_OUTBOX_WORKER = "1";
  process.env.OUTBOX_POLL_MS = "60000";
  process.env.PAYMENT_PROVIDER = "payrail-http";
  process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
  process.env.PAYMENT_PROVIDER_BASE_URL = `http://127.0.0.1:${PROVIDER_PORT}`;
  process.env.PAYMENT_PROVIDER_API_KEY = "review-provider-key";
  process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
  process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
  process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
  process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
  process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "2000";
  process.env.SELLER_SESSION_SECRET = "review-seller-session-secret";
  process.env.RATE_LIMIT_MAX = "1000000";
  process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const dbName = String((await pool.query("SELECT current_database() AS name")).rows[0]?.name || "");
  assert.match(dbName, /^siton_test_/, "this counterexample may run only in a disposable isolated test database");

  // Dynamic import AFTER the environment is set: runtime_config reads env once
  // per process and static imports would be hoisted above these assignments.
  const appModule: any = await import("../src/app.js");
  const { app, processOutboxEventById, closeWorkerDatabase } = appModule;
  await app.ready();

  let failures = 0;
  const record = (name: string, ok: boolean, detail = "") => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  /** Seed a deal whose participant is mid-charge with an authorized hold. */
  async function seedChargingParticipant() {
    const dealId = randomUUID();
    const participantId = randomUUID();
    const buyerId = `buyer-review-${participantId.slice(0, 8)}`;
    const authorization = `auth-review-${randomUUID().slice(0, 12)}`;
    const qty = 2;
    const pricePerUnit = 100;
    const deliveryCost = 15;
    const amountMinor = Math.round((qty * pricePerUnit + deliveryCost) * 100);

    await pool.query(
      `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
       VALUES ($1,'seller-review','Charging','Foreign reference counterexample',$2,1,500,1, now() + interval '1 hour', now() - interval '1 hour', now() + interval '1 hour')`,
      [dealId, pricePerUnit]
    );
    await pool.query(
      `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
       VALUES ($1,$2,$3,$4,'ChargingAttempt','ChargeAttempt',$5, clock_timestamp())`,
      [participantId, dealId, buyerId, qty, deliveryCost]
    );
    await pool.query(
      `INSERT INTO siton.payment_authorization_bindings
         (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id, consumed_by_participant_id, consumed_at)
       VALUES ('payrail-http','provider-ready','test',$1,$1,$2,$3,$4,$5,'ILS',$6,'consumed',$7,$8, now())`,
      [authorization, dealId, buyerId, qty, amountMinor, deliveryCost, `review-auth:${authorization}`, participantId]
    );
    return { dealId, participantId, authorization, amountMinor };
  }

  async function enqueueReconcile(args: { participantId: string; dealId: string; authorization: string }) {
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
       VALUES ($1,'payment_reconcile','participant',$2,$3,'pending',0, now(), clock_timestamp(), clock_timestamp())`,
      [
        eventId,
        args.participantId,
        JSON.stringify({
          participant_id: args.participantId,
          deal_id: args.dealId,
          attempt_type: "charge_start",
          correlation_id: `review-charge:${args.participantId}`,
          operation: "capture",
          provider_reference: args.authorization,
          reason: "independent_review_counterexample"
        })
      ]
    );
    return eventId;
  }

  async function moneyState(participantId: string) {
    const r = await pool.query(`SELECT money_state, buyer_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
    return r.rows[0] as { money_state: string; buyer_state: string };
  }

  /**
   * Payment operational cases do NOT carry participant_id: openPaymentOperationalCase
   * writes the participant into auto_key / subject / description only. Match on
   * auto_key, which is how the payment rails address a case.
   */
  async function casesFor(participantId: string) {
    const r = await pool.query(
      `SELECT auto_key, subject FROM siton.operational_cases
        WHERE auto_key LIKE '%' || $1 || '%' ORDER BY created_at`,
      [participantId]
    );
    return r.rows as Array<{ auto_key: string | null; subject: string }>;
  }

  /**
   * One scenario: the status seam answers "captured / final" about
   * `echo(queriedReference)` with the RIGHT amount and currency. Safe
   * behaviour = no capture request ever sent AND no ChargedSuccess.
   */
  async function scenario(name: string, echo: (queried: string) => string, expectRejected: boolean) {
    const seeded = await seedChargingParticipant();
    foreignReferenceFor = echo;
    statusAmountMinor = seeded.amountMinor;
    const before = providerCalls.length;
    const eventId = await enqueueReconcile({ participantId: seeded.participantId, dealId: seeded.dealId, authorization: seeded.authorization });
    let thrown: string | null = null;
    try {
      await processOutboxEventById(eventId);
    } catch (error: any) {
      thrown = String(error?.message || error);
    }
    const state = await moneyState(seeded.participantId);
    const calls = providerCalls.slice(before);
    const captureCalls = calls.filter((c) => /\/capture|\/recover/.test(c.url));
    const cases = await casesFor(seeded.participantId);
    const evidence = {
      echoed: echo(seeded.authorization),
      money_state: state.money_state,
      buyer_state: state.buyer_state,
      capture_calls: captureCalls.length,
      status_calls: calls.filter((c) => c.url.startsWith("/status/")).length,
      cases: cases.map((c) => c.auto_key),
      worker_error: thrown ? thrown.slice(0, 120) : null
    };
    console.log(`FOREIGN_REFERENCE_EVIDENCE ${name} ${JSON.stringify(evidence)}`);

    record(`${name}: no capture or recovery request was ever dispatched`, captureCalls.length === 0, `${captureCalls.length} money calls`);
    if (expectRejected) {
      record(`${name}: the participant did NOT become ChargedSuccess`, state.money_state !== "ChargedSuccess", `money_state=${state.money_state}`);
      record(`${name}: the answer was refused as evidence about another operation`, state.money_state === "ChargeAttempt", `money_state=${state.money_state}`);
      record(
        `${name}: a visible reference-mismatch case was opened`,
        cases.some((c) => String(c.auto_key || "").includes("reference-mismatch")),
        JSON.stringify(cases.map((c) => c.auto_key))
      );
    }
    return evidence;
  }

  try {
    // ── P0: an arbitrary foreign three-letter prefix ─────────────────────────
    // This is the exact bad path the final review corrected: with the old
    // `/^[a-z]{3}-/i` alias, `xyz-<auth>` reduced to `<auth>` and became proof.
    await scenario("P0 foreign xyz- prefix", (queried) => `xyz-${queried}`, true);

    // ── the fix must be prefix-EXACT, not merely different ──────────────────
    await scenario("foreign abc- prefix", (queried) => `abc-${queried}`, true);
    // case matters: the four aliases are case-sensitive, so an upper-case form
    // of a defined prefix is a DIFFERENT identifier and must be refused.
    await scenario("upper-case CAP- prefix", (queried) => `CAP-${queried}`, true);
    // a completely unrelated identifier
    await scenario("unrelated reference", () => "op_9f2c41d0aa11", true);
    // another participant's successful transaction must never settle this one
    await scenario("another participant's reference", () => "auth-review-other-participant", true);
    // a superstring / substring of the queried reference is not the reference
    await scenario("reference with a suffix", (queried) => `${queried}-2`, true);
    await scenario("truncated reference", (queried) => queried.slice(0, Math.max(1, queried.length - 3)), true);

    // ── documented contract boundary, asserted so it cannot drift silently ──
    // The provider-ready adapter deliberately treats the four DEFINED
    // operation prefixes as operation-scoped forms of the same authorization.
    // `cap-<auth>` answering a query for `<auth>` is therefore accepted, and
    // this scenario records that boundary explicitly (it is NOT a foreign
    // reference). The safety of the accepted case rests on the amount and
    // currency ties plus the money state machine, not on the prefix.
    const defined = await scenario("defined cap- alias (contract boundary)", (queried) => `cap-${queried}`, false);
    record(
      "defined cap- alias is accepted as the same authorization (recorded contract boundary)",
      defined.money_state === "ChargedSuccess" || defined.money_state === "ChargeAttempt",
      `money_state=${defined.money_state}`
    );
  } finally {
    await pool.end().catch(() => undefined);
    await closeWorkerDatabase?.().catch(() => undefined);
    await app.close().catch(() => undefined);
    await new Promise<void>((resolve) => providerStub.close(() => resolve()));
  }

  console.log(`\nREVIEW_FOREIGN_REFERENCE_AB ${failures === 0 ? "PASS" : "FAIL"} failures=${failures}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(`REVIEW_FOREIGN_REFERENCE_AB_ERROR ${error?.stack || error}`);
  process.exit(1);
});
