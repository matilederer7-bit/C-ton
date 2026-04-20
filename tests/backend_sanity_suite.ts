import assert from "node:assert/strict";
import { app, assertValidTransition, BUYER_TRANSITIONS, DEAL_TRANSITIONS, MONEY_TRANSITIONS } from "../src/app.js";
import { buildOutboxWorkerHelpers } from "../src/outbox_worker_helpers.js";
import { summarizeMoney } from "../src/product_surface_support.js";

class PermanentFailError extends Error {}
class DeferredEventError extends Error {
  retryAt: Date;

  constructor(message: string, retryAt: Date) {
    super(message);
    this.retryAt = retryAt;
  }
}

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await runTest("health endpoint responds with ok", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  });

  await runTest("canonical state transitions stay intact", async () => {
    assert.ok(DEAL_TRANSITIONS.PendingTarget?.includes("TargetReached"));
    assert.ok(!DEAL_TRANSITIONS.PendingTarget?.includes("Completed"));
    assert.ok(BUYER_TRANSITIONS.NotJoined?.includes("JoinedAuthorized"));
    assert.ok(MONEY_TRANSITIONS.AuthHeld?.includes("AuthLocked"));
    assert.doesNotThrow(() => assertValidTransition("deal_state", "Draft", "PendingTarget"));
    assert.throws(
      () => assertValidTransition("deal_state", "Draft", "Completed"),
      /Illegal deal_state transition Draft to Completed/
    );
  });

  await runTest("deal transitions match DB enforcement (no post-publish Cancelled)", async () => {
    // Cancellation is only permitted from Draft — DB trigger mirrors this.
    assert.deepEqual(DEAL_TRANSITIONS.Draft, ["PendingTarget", "Cancelled"]);
    assert.deepEqual(DEAL_TRANSITIONS.PendingTarget, ["TargetReached", "Failed"]);
    assert.deepEqual(DEAL_TRANSITIONS.TargetReached, ["ClosedForJoining"]);
    assert.deepEqual(DEAL_TRANSITIONS.ClosedForJoining, ["ReadyForCharging"]);
    assert.deepEqual(DEAL_TRANSITIONS.ReadyForCharging, ["Charging"]);
    assert.deepEqual(DEAL_TRANSITIONS.Charging, ["CompletionWindow"]);
    assert.deepEqual(DEAL_TRANSITIONS.CompletionWindow, ["Completed", "Failed"]);
    for (const from of [
      "PendingTarget",
      "TargetReached",
      "ClosedForJoining",
      "ReadyForCharging",
      "Charging",
      "CompletionWindow"
    ]) {
      assert.throws(
        () => assertValidTransition("deal_state", from, "Cancelled"),
        new RegExp(`Illegal deal_state transition ${from} to Cancelled`)
      );
    }
    assert.throws(
      () => assertValidTransition("deal_state", "Charging", "Failed"),
      /Illegal deal_state transition Charging to Failed/
    );
  });

  await runTest("deal creation rejects deadline shorter than 2 hours", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Too-soon deadline",
        price_per_unit: 10,
        min_units: 5,
        max_units: 10,
        deadline: new Date(Date.now() + 60 * 60_000).toISOString() // 1h
      }
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as any;
    assert.match(String(body.error || ""), /at least 2 hours/i);
  });

  await runTest("deal creation rejects deadline longer than 7 days", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Too-far deadline",
        price_per_unit: 10,
        min_units: 5,
        max_units: 10,
        deadline: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString() // 8d
      }
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as any;
    assert.match(String(body.error || ""), /within 7 days/i);
  });

  await runTest("deal creation rejects invalid deadline string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Bad deadline",
        price_per_unit: 10,
        min_units: 5,
        max_units: 10,
        deadline: "not-a-date"
      }
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as any;
    assert.match(String(body.error || ""), /deadline must be a valid ISO date/i);
  });

  await runTest("outbox retry helper increments attempts on temporary failures", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const helpers = buildOutboxWorkerHelpers({
      withTx: async <T>(fn: (c: any) => Promise<T>) =>
        fn({
          query: async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rowCount: 1, rows: [] };
          }
        }),
      outboxPollMs: 1000,
      outboxMaxAttempts: 4,
      PermanentFailErrorCtor: PermanentFailError,
      DeferredEventErrorCtor: DeferredEventError
    });

    await helpers.markOutboxFailed("event-1", 1, new Error("temporary_fail"));

    assert.ok(calls.some((call) => call.sql.includes("attempt_count=attempt_count+1")));
    assert.ok(calls.some((call) => call.sql.includes("SET status='pending'")));
  });

  await runTest("outbox permanent failures move directly to dlq", async () => {
    const calls: string[] = [];
    const helpers = buildOutboxWorkerHelpers({
      withTx: async <T>(fn: (c: any) => Promise<T>) =>
        fn({
          query: async (sql: string) => {
            calls.push(sql);
            return { rowCount: 1, rows: [] };
          }
        }),
      outboxPollMs: 1000,
      outboxMaxAttempts: 4,
      PermanentFailErrorCtor: PermanentFailError,
      DeferredEventErrorCtor: DeferredEventError
    });

    await helpers.markOutboxFailed("event-2", 0, new PermanentFailError("boom"));

    assert.ok(calls.some((sql) => sql.includes("INSERT INTO siton.outbox_dlq")));
    assert.ok(calls.some((sql) => sql.includes("DELETE FROM siton.outbox_events")));
  });

  // ── Wave 2: Siton fee base includes delivery, excludes VAT, no affiliate fee
  await runTest("siton fee base includes delivery: price=100 qty=2 delivery=20 → base=220 fee=17.6", () => {
    const base = 100 * 2 + 20;
    const summary = summarizeMoney({ grossAmount: base, commissionRate: 0.08 });
    assert.equal(summary.gross_amount, 220);
    assert.equal(summary.siton_fee_amount, 17.6);
    assert.equal(summary.seller_net_amount, 202.4);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(summary, "affiliate_fee_amount"),
      "affiliate_fee_amount must not appear in summarizeMoney output"
    );
  });

  await runTest("siton fee base with no delivery: price=50 qty=1 delivery=0 → base=50 fee=4", () => {
    const base = 50 * 1 + 0;
    const summary = summarizeMoney({ grossAmount: base, commissionRate: 0.08 });
    assert.equal(summary.gross_amount, 50);
    assert.equal(summary.siton_fee_amount, 4);
    assert.equal(summary.seller_net_amount, 46);
  });

  await runTest("summarizeMoney has no affiliate field and no VAT field", () => {
    const summary = summarizeMoney({ grossAmount: 220, commissionRate: 0.08 });
    const keys = Object.keys(summary);
    for (const forbidden of ["affiliate_fee_amount", "affiliate_fee_rate", "vat", "vat_amount", "tax_amount"]) {
      assert.ok(!keys.includes(forbidden), `forbidden key "${forbidden}" present in summarizeMoney output`);
    }
  });

  await runTest("affiliate overview is attribution-only (no commission/payout/PII fields)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/affiliate/overview" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as any;
    assert.ok(body.affiliate_surface, "affiliate_surface must be present");
    const surface = body.affiliate_surface;
    const surfaceJson = JSON.stringify(surface);
    // Money-model keys must not leak.
    for (const forbidden of [
      "commission_amount",
      "commission_rate",
      "payout_status",
      "payout_method",
      "payout_details",
      "affiliate_fee_amount",
      "balance",
      "amount_owed"
    ]) {
      assert.ok(
        !surfaceJson.includes(`"${forbidden}"`),
        `affiliate overview leaked money field "${forbidden}"`
      );
    }
    // PII keys must not leak.
    for (const forbidden of ["buyer_id", "buyer_phone", "buyer_email", "phone", "email"]) {
      assert.ok(
        !surfaceJson.includes(`"${forbidden}"`),
        `affiliate overview leaked PII field "${forbidden}"`
      );
    }
    // Allowed aggregate counters must be present.
    assert.ok(typeof surface.totals?.total_attributions === "number");
    assert.ok(typeof surface.totals?.total_units === "number");
    assert.ok(typeof surface.totals?.active_campaigns === "number");
  });

  await runTest("distributor payout endpoints stay fail-closed (410 affiliate_payout_model_removed)", async () => {
    const payoutProfile = await app.inject({
      method: "POST",
      url: "/api/affiliate/payout-profile",
      payload: { payout_method: "bank_transfer", payout_details: "IL00TEST" }
    });
    assert.equal(payoutProfile.statusCode, 410);
    const payoutBody = payoutProfile.json() as any;
    assert.equal(payoutBody.error, "affiliate_payout_model_removed");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
