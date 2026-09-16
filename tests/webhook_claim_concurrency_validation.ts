// OVERNIGHT HARDENING — webhook claim under concurrent duplicate delivery.
//
// Providers retry and fan out: the same (provider, event_id) can arrive on two
// web instances in the same millisecond. claimEvent used to be check-then-insert:
// both deliveries passed the SELECT, the second INSERT hit the primary key and
// the caller answered a 5xx. Money truth was never at risk (the PRIMARY KEY
// held), but a provider that sees 5xx keeps retrying, and the operator sees
// server faults for an ordinary duplicate. The claim is now insert-or-read:
// exactly ONE delivery may process, every other one is the idempotent
// duplicate answer, and no claim ever throws for a duplicate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.DISABLE_OUTBOX_WORKER = "1";

const { buildWebhookIngestion } = await import("../src/webhook_ingestion.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 40
});

async function withTx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

const ingestion = buildWebhookIngestion({ withTx });

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

const provider = `payrail-http`;

try {
  for (const fanOut of [2, 8, 25]) {
    await run(`${fanOut} concurrent deliveries of one event: exactly one claim, no failure`, async () => {
      const eventId = `evt-race-${randomUUID()}`;
      const settled = await Promise.allSettled(
        Array.from({ length: fanOut }, (_, index) =>
          ingestion.claimEvent({
            provider,
            event_id: eventId,
            event_type: "authorization.captured",
            payload: { attempt: index, event_id: eventId }
          })
        )
      );
      const rejected = settled.filter((item) => item.status === "rejected") as PromiseRejectedResult[];
      assert.equal(rejected.length, 0, `no delivery may fail on a duplicate: ${rejected.map((r) => String(r.reason?.message || r.reason)).join(" | ")}`);
      const results = settled.map((item) => (item as PromiseFulfilledResult<any>).value);
      const winners = results.filter((r) => r.duplicate === false && r.should_process === true);
      const duplicates = results.filter((r) => r.duplicate === true);
      assert.equal(winners.length, 1, "exactly one delivery processes");
      assert.equal(duplicates.length, fanOut - 1, "every other delivery is the idempotent duplicate answer");
      for (const r of duplicates) {
        assert.equal(r.accepted, true);
        assert.equal(r.should_process, false, "a duplicate of an in-flight (processing) event must not process again");
        assert.equal(r.status, "processing");
      }
      const rows = await pool.query(`SELECT count(*)::int AS n FROM siton.webhook_events WHERE provider=$1 AND event_id=$2`, [provider, eventId]);
      assert.equal(rows.rows[0].n, 1, "one durable row per (provider, event_id)");
    });
  }

  await run("a duplicate after the winner finished is still a duplicate that does not reprocess", async () => {
    const eventId = `evt-after-${randomUUID()}`;
    const first = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "authorization.captured", payload: {} });
    assert.equal(first.duplicate, false);
    await ingestion.markEvent(provider, eventId, "processed");
    const again = await Promise.all([
      ingestion.claimEvent({ provider, event_id: eventId, event_type: "authorization.captured", payload: {} }),
      ingestion.claimEvent({ provider, event_id: eventId, event_type: "authorization.captured", payload: {} })
    ]);
    for (const r of again) {
      assert.equal(r.duplicate, true);
      assert.equal(r.should_process, false);
      assert.equal(r.status, "processed");
    }
  });

  await run("a failed event may be re-claimed exactly once under concurrent retries", async () => {
    const eventId = `evt-retry-${randomUUID()}`;
    const first = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "authorization.captured", payload: {} });
    assert.equal(first.duplicate, false);
    await ingestion.markEvent(provider, eventId, "failed", "provider timeout");
    const retries = await Promise.all(
      Array.from({ length: 6 }, () => ingestion.claimEvent({ provider, event_id: eventId, event_type: "authorization.captured", payload: { retry: true } }))
    );
    const reprocess = retries.filter((r) => r.should_process === true);
    assert.equal(reprocess.length, 1, "exactly one retry re-enters processing");
    assert.ok(retries.every((r) => r.duplicate === true), "retries are duplicates of the stored event");
    const row = await pool.query(`SELECT status FROM siton.webhook_events WHERE provider=$1 AND event_id=$2`, [provider, eventId]);
    assert.equal(row.rows[0].status, "processing");
  });

  await run("cleanup: proof rows removed", async () => {
    await pool.query(`DELETE FROM siton.webhook_events WHERE provider=$1 AND event_id LIKE 'evt-%'`, [provider]);
  });
} finally {
  await pool.end().catch(() => undefined);
}

if (failed > 0) {
  console.error(`FAILED ${failed} webhook claim concurrency checks`);
  process.exit(1);
}
console.log("All webhook claim concurrency checks passed.");
