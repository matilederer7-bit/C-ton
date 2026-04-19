import assert from "node:assert/strict";
import { app, assertValidTransition, BUYER_TRANSITIONS, DEAL_TRANSITIONS, MONEY_TRANSITIONS } from "../src/app.js";
import { buildOutboxWorkerHelpers } from "../src/outbox_worker_helpers.js";

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
