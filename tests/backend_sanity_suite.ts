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
