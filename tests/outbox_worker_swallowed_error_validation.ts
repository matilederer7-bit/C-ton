// Black-Sky F-L2 — the outbox reclaim loop survives a failing row (one poisoned
// event must not block the batch) but used to swallow the error with `catch {}`:
// no log, no counter. Proves with a scripted client (no database):
//   * a genuine row failure is rolled back to its savepoint, the loop continues,
//     the failure is COUNTED and LOGGED (event id + error code, no payload)
//   * a lease-lost race is counted separately and is not logged as a failure
import assert from "node:assert/strict";
import { buildOutboxWorkerHelpers } from "../src/outbox_worker_helpers.js";
import { runtimeCounterValue } from "../src/runtime_counters.js";

class PermanentFail extends Error {}
class Deferred extends Error {}

function scriptedClient(rows: any[], failFor: Set<string>, leaseLostFor: Set<string>) {
  const statements: string[] = [];
  let current: string | null = null;
  return {
    statements,
    async query(sql: string, params: unknown[] = []) {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/^\s*(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)/.test(sql) || /set_config/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM siton\.outbox_events/.test(sql) && /FOR UPDATE SKIP LOCKED/.test(sql) && /lease_expires_at <= clock_timestamp\(\)/.test(sql)) {
        return { rows, rowCount: rows.length };
      }
      if (/operational_recovery_audit/.test(sql)) {
        current = String((params as any[]).find((p) => rows.some((r) => r.event_uuid === p)) ?? current);
        if (current && failFor.has(current)) throw Object.assign(new Error("audit insert exploded"), { code: "23514" });
        return { rows: [{ subject_id: current }], rowCount: 1 };
      }
      if (/UPDATE siton\.outbox_events/.test(sql)) {
        const id = String(params[0]);
        if (leaseLostFor.has(id)) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

const row = (id: string) => ({
  event_uuid: id, event_type: "notification_send", aggregate_type: "deal", aggregate_id: id,
  status: "processing", attempt_count: 1, max_attempts: 4, lease_generation: 3,
  worker_id: "dead-worker", lease_expires_at: new Date(0).toISOString(), last_heartbeat_at: null
});

const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const rows = [row("11111111-1111-4111-8111-111111111111"), row("22222222-2222-4222-8222-222222222222"), row("33333333-3333-4333-8333-333333333333")];
const client = scriptedClient(rows, new Set([rows[0]!.event_uuid]), new Set([rows[1]!.event_uuid]));
const helpers = buildOutboxWorkerHelpers({
  withTx: async (fn) => fn(client),
  outboxPollMs: 10,
  outboxMaxAttempts: 4,
  PermanentFailErrorCtor: PermanentFail,
  DeferredEventErrorCtor: Deferred,
  workerId: "test-worker",
  logger: { warn: (obj, msg) => warnings.push({ obj, msg }) }
});

const failedBefore = runtimeCounterValue("outbox_reclaim_row_failed_total");
const lostBefore = runtimeCounterValue("outbox_reclaim_lease_lost_total");
const changed = await helpers.reclaimStuckProcessing(0);

assert.equal(changed, 1, "the healthy third row is still reclaimed after two failing rows");
assert.equal(runtimeCounterValue("outbox_reclaim_row_failed_total") - failedBefore, 1, "the real failure is counted");
assert.equal(runtimeCounterValue("outbox_reclaim_lease_lost_total") - lostBefore, 1, "the lease-lost race is counted separately");
assert.equal(warnings.length, 1, JSON.stringify(warnings));
assert.equal(warnings[0]!.msg, "outbox_reclaim_row_failed");
assert.equal(warnings[0]!.obj.event_uuid, rows[0]!.event_uuid);
assert.equal(warnings[0]!.obj.error_code, "23514");
assert.equal(warnings[0]!.obj.worker_id, "test-worker");
assert.ok(!("payload" in warnings[0]!.obj), "no event payload in the log line");
assert.ok(client.statements.filter((s) => s.startsWith("ROLLBACK TO SAVEPOINT")).length >= 2, "failing rows were rolled back to their savepoints");
console.log("PASS outbox reclaim counts and logs swallowed row errors (F-L2)");
