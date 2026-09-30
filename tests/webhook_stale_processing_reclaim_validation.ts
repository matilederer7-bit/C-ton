// Black-Sky A-F3 — a webhook row claimed as 'processing' whose processor died
// (crash after claim, before markEvent) must not swallow every later replay of
// that event for ever. A STALE claim is re-claimable by exactly one redelivery
// (and the maintenance sweep returns it to 'pending'); a fresh claim and every
// final status keep their dedup semantics.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { buildWebhookIngestion } = await import("../src/webhook_ingestion.js");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
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

const ingestion: any = buildWebhookIngestion({ withTx });
const provider = "payrail-http";
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

// Simulate "the processor died N minutes ago": age both the first-claim instant
// and the claim stamp (whichever the implementation reads). received_at is an
// immutable identity column since migration 078, so time travel runs on ONE
// connection with the enforcement triggers bypassed (the same technique the
// suites use to age an immutable deal deadline); runtime code never does this.
async function ageClaim(eventId: string, minutes: number) {
  const c = await pool.connect();
  try {
    await c.query(`SET session_replication_role = replica`);
    await c.query(
      `UPDATE siton.webhook_events
       SET received_at = received_at - ($3::text || ' minutes')::interval,
           payload_jsonb = CASE WHEN payload_jsonb ? 'claimed_at'
             THEN jsonb_set(payload_jsonb, '{claimed_at}', to_jsonb(((payload_jsonb->>'claimed_at')::timestamptz - ($3::text || ' minutes')::interval)))
             ELSE payload_jsonb END
       WHERE provider=$1 AND event_id=$2`,
      [provider, eventId, String(minutes)]
    );
  } finally {
    await c.query(`SET session_replication_role = origin`).catch(() => {});
    c.release();
  }
}

try {
  await run("a replay of an event whose processor died after the claim is processed again (stale claim reclaimed)", async () => {
    const eventId = `evt-stale-${randomUUID()}`;
    const first = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    assert.equal(first.should_process, true);
    // ...worker dies here: markEvent never runs.
    await ageClaim(eventId, 10);
    const replay = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: { replay: true } });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.should_process, true, "the provider's replay must not be swallowed by a dead claim");
    assert.equal(replay.status, "processing");
  });

  await run("concurrent replays of a stale claim: exactly one reclaims it", async () => {
    const eventId = `evt-stale-race-${randomUUID()}`;
    await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    await ageClaim(eventId, 10);
    const replays = await Promise.all(Array.from({ length: 8 }, () => ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} })));
    assert.equal(replays.filter((r: any) => r.should_process === true).length, 1, "exactly one replay re-enters processing");
    // the winner re-stamped the claim: an immediate further replay is a plain duplicate
    const after = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    assert.equal(after.should_process, false);
  });

  await run("negative: a FRESH processing claim is still an in-flight duplicate (no double processing)", async () => {
    const eventId = `evt-fresh-${randomUUID()}`;
    await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    await ageClaim(eventId, 1); // below the staleness bound
    const replay = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    assert.equal(replay.should_process, false);
    assert.equal(replay.status, "processing");
  });

  await run("negative: processed / ignored events are never reclaimed, however old", async () => {
    for (const status of ["processed", "ignored"] as const) {
      const eventId = `evt-final-${status}-${randomUUID()}`;
      const claim = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
      await ingestion.markEvent(provider, eventId, status, "done", claim.claim_token);
      await ageClaim(eventId, 120);
      const replay = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
      assert.equal(replay.should_process, false, `${status} is final`);
      assert.equal(replay.status, status);
    }
  });

  await run("maintenance sweep returns stale processing rows to pending (bounded, idempotent), fresh ones untouched", async () => {
    assert.equal(typeof ingestion.reclaimStaleProcessing, "function", "a sweep path must exist");
    const stale = `evt-sweep-stale-${randomUUID()}`;
    const fresh = `evt-sweep-fresh-${randomUUID()}`;
    await ingestion.claimEvent({ provider, event_id: stale, event_type: "charge_captured", payload: {} });
    await ingestion.claimEvent({ provider, event_id: fresh, event_type: "charge_captured", payload: {} });
    await ageClaim(stale, 30);
    const swept = await ingestion.reclaimStaleProcessing(1000);
    assert.ok(swept >= 1);
    const rows = await pool.query(`SELECT event_id, status FROM siton.webhook_events WHERE provider=$1 AND event_id = ANY($2::text[])`, [provider, [stale, fresh]]);
    const byId = new Map(rows.rows.map((r: any) => [r.event_id, r.status]));
    assert.equal(byId.get(stale), "pending");
    assert.equal(byId.get(fresh), "processing");
    assert.equal(await ingestion.reclaimStaleProcessing(1000) >= 0, true);
    const again = await pool.query(`SELECT status FROM siton.webhook_events WHERE provider=$1 AND event_id=$2`, [provider, stale]);
    assert.equal(again.rows[0].status, "pending", "a second sweep is a no-op");
    const next = await ingestion.claimEvent({ provider, event_id: stale, event_type: "charge_captured", payload: {} });
    assert.equal(next.should_process, true, "the next delivery processes the swept event");
  });
  // ── Claim fencing (Codex review on PR #99) ──────────────────────────────
  // Processor A claims and stalls past the stale bound; processor B reclaims
  // and finishes. When A wakes, its markEvent must be a no-op: it can neither
  // overwrite B's terminal status nor make the event re-claimable again.
  async function statusOf(eventId: string) {
    const r = await pool.query(`SELECT status, payload_jsonb->>'classification_reason' AS reason FROM siton.webhook_events WHERE provider=$1 AND event_id=$2`, [provider, eventId]);
    return r.rows[0] as { status: string; reason: string | null };
  }

  for (const [bStatus, aStatus] of [["processed", "failed"], ["ignored", "failed"], ["failed", "processed"], ["processed", "ignored"]] as const) {
    await run(`fencing: stalled A cannot overwrite B's terminal '${bStatus}' with '${aStatus}'`, async () => {
      const eventId = `evt-fence-${bStatus}-${aStatus}-${randomUUID()}`;
      const a = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
      assert.equal(a.should_process, true);
      assert.ok(a.claim_token, "every claim carries a token");
      await ageClaim(eventId, 30); // A stalls past the stale bound
      const b = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
      assert.equal(b.should_process, true, "B reclaims the stale claim");
      assert.ok(b.claim_token && b.claim_token !== a.claim_token, "a reclaim mints a NEW token");
      const bDone = await ingestion.markEvent(provider, eventId, bStatus, "b-final", b.claim_token);
      assert.ok(bDone, "the current claimant finishes the event");
      const aLate = await ingestion.markEvent(provider, eventId, aStatus, "a-stale", a.claim_token);
      assert.equal(aLate, null, "the stalled claimant's markEvent is a no-op");
      assert.deepEqual(await statusOf(eventId), { status: bStatus, reason: "b-final" }, "B's terminal status survives");
      if (bStatus !== "failed") {
        const replay = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
        assert.equal(replay.should_process, false, "a finished event is not made re-claimable by the stale claimant");
      }
    });
  }

  await run("fencing: a stalled claimant cannot finish a row the sweep returned to pending, nor a row re-claimed while it slept", async () => {
    const eventId = `evt-fence-sweep-${randomUUID()}`;
    const a = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    await ageClaim(eventId, 30);
    assert.ok(await ingestion.reclaimStaleProcessing(1000) >= 1);
    assert.equal(await ingestion.markEvent(provider, eventId, "processed", "a-stale", a.claim_token), null, "A is fenced by the sweep");
    assert.equal((await statusOf(eventId)).status, "pending");
    const c = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    assert.equal(c.should_process, true);
    assert.equal(await ingestion.markEvent(provider, eventId, "processed", "a-stale", a.claim_token), null, "A is still fenced after the next claim");
    assert.equal((await statusOf(eventId)).status, "processing", "C's claim is untouched by A");
    assert.ok(await ingestion.markEvent(provider, eventId, "processed", "c-final", c.claim_token));
    assert.deepEqual(await statusOf(eventId), { status: "processed", reason: "c-final" });
  });

  await run("fencing: terminal states never move back — not even the SAME claimant can re-finish, and no token finishes nothing", async () => {
    for (const status of ["processed", "ignored", "failed"] as const) {
      const eventId = `evt-fence-terminal-${status}-${randomUUID()}`;
      const a = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
      assert.ok(await ingestion.markEvent(provider, eventId, status, "first", a.claim_token));
      for (const other of ["processed", "ignored", "failed", "pending"] as const) {
        assert.equal(await ingestion.markEvent(provider, eventId, other, "again", a.claim_token), null, `${status} -> ${other} by the same claimant is a no-op`);
      }
      assert.equal(await ingestion.markEvent(provider, eventId, "processed", "no-token", null), null, "a null token finishes nothing");
      assert.deepEqual(await statusOf(eventId), { status, reason: "first" });
    }
  });

  await run("fencing: concurrent finishes by the stalled and the current claimant — only the current one lands", async () => {
    const eventId = `evt-fence-race-${randomUUID()}`;
    const a = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    await ageClaim(eventId, 30);
    const b = await ingestion.claimEvent({ provider, event_id: eventId, event_type: "charge_captured", payload: {} });
    const [aRes, bRes] = await Promise.all([
      ingestion.markEvent(provider, eventId, "failed", "a-stale", a.claim_token),
      ingestion.markEvent(provider, eventId, "processed", "b-final", b.claim_token)
    ]);
    assert.equal(aRes, null);
    assert.ok(bRes);
    assert.deepEqual(await statusOf(eventId), { status: "processed", reason: "b-final" });
  });
} finally {
  await pool.query(`DELETE FROM siton.webhook_events WHERE provider=$1 AND event_id LIKE 'evt-%'`, [provider]).catch(() => undefined);
  await pool.end().catch(() => undefined);
}

if (failed > 0) {
  console.error(`FAILED ${failed} webhook stale-processing checks`);
  process.exit(1);
}
console.log("All webhook stale-processing checks passed.");
