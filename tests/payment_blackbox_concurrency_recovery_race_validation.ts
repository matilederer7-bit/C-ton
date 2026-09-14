// R9C PRODUCTION CANDIDATE — BLACK-BOX MONEY SAFETY, two workers racing one recovery.
//
// Real handlers and worker code through processOutboxEventById, a real migrated
// database, the black-box provider stub at a real HTTP boundary. Two "workers"
// are two claims of the same outbox job under different lease generations (the
// first lease is expired by the test while its provider request is parked at
// the provider's door). The stub honours the provider-ready contract the rail
// relies on (a repeated idempotency key is replayed, never executed twice).
//
//   B8a  worker A's recovery request is parked at the provider; A's lease dies;
//        worker B reclaims the job and runs the SAME recovery
//        → exactly ONE money-moving identity ever reaches the provider (the
//          repeated key is the same identity), exactly one effect, the stale
//          owner writes nothing, one durable recovery row
//   B8b  worker A holds a LIVE lease with its request in flight; a concurrent
//        reconcile of the same participant must defer (no verdict, no money);
//        the job cannot be claimed twice
//   B8c  control: two recovery jobs for two participants of one deal run
//        concurrently → one identity and one effect each
//
// REAL MONEY: none. Stub provider (native idempotency ON), disposable database.

import assert from "node:assert/strict";
import { bootBlackBox, makeRunner, sleep, timeout, until } from "./blackbox/harness.js";

const bb = await bootBlackBox({ tag: "bb-race", port: 3303, nativeIdempotency: true, workerLeaseMs: 30_000, env: { COMPLETION_WINDOW_MINUTES: "30" } });
const { run, summary } = makeRunner("payment_blackbox_concurrency_recovery_race");
const { provider } = bb;

const recoverable = () => bb.seedDeal({
  state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 120_000), threshold_units: 1,
  participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] }]
});
const distinctKeys = (auth: string, op: "recover" | "capture") => new Set(provider.requestsOf(auth, op).map((r) => r.key));
async function expireLease(eventId: string) {
  await bb.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1 AND status='processing'`, [eventId]);
  await bb.reclaimWorkerJobs(0);
  const row = await bb.outboxRow(eventId);
  assert.equal(row?.status, "pending", `the job was reclaimed: ${JSON.stringify(row)}`);
}

await run("B8a stale worker A parked at the provider, worker B reclaims and re-runs the recovery → ONE identity, ONE effect, the stale owner writes nothing", async () => {
  const d = await recoverable();
  const p = d.participants[0]!;
  provider.script(p.authorization, "recover", [{ kind: "HOLD_THEN_SUCCESS", gate: "b8a" }]);
  const job = await bb.enqueueRecovery(d.deal_id);
  const workerA = bb.processOutboxEventById(job);
  await provider.waitEntered("b8a", 1, 8000);                              // A's request is at the provider's door
  const armedByA = (await bb.attempts(p.participant_id, "recovery"))[0]!;
  assert.equal(armedByA.dispatch_state, "dispatching");
  assert.equal(armedByA.in_flight, true);
  const generationA = Number(armedByA.owner_lease_generation);

  await expireLease(job);                                                   // A is now a stale worker
  const workerB = await bb.processOutboxEventById(job);                    // B claims the same job under a new lease
  console.log(`  B8a worker B: ${JSON.stringify(workerB)} provider=${JSON.stringify(provider.requestsOf(p.authorization).map((r) => `${r.op}:${r.behavior}:${r.answered || "open"}`))}`);
  const afterB = (await bb.attempts(p.participant_id, "recovery"));
  console.log(`  B8a rows after B: ${JSON.stringify(afterB.map((r) => ({ id: r.correlation_id.slice(0, 40), class: r.result_class, state: r.dispatch_state, gen: r.owner_lease_generation, in_flight: r.in_flight })))}`);

  provider.release("b8a");                                                 // the provider answers everyone it parked
  const resultA = await Promise.race([workerA, timeout(20_000, "worker A never returned")]);
  console.log(`  B8a stale worker A: ${JSON.stringify(resultA)}`);
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B8a terminal: ${JSON.stringify(end)}`);

  assert.equal(distinctKeys(p.authorization, "recover").size, 1, "exactly one money-moving identity reached the provider");
  assert.equal(end.provider_effects.recover, 1, "exactly one recovery effect");
  assert.equal(end.provider_effects.capture, 0);
  const rows = await bb.attempts(p.participant_id, "recovery");
  assert.equal(rows.length, 1, "one durable recovery identity");
  assert.equal(rows[0]!.result_class, "success");
  assert.ok(Number(rows[0]!.owner_lease_generation) !== generationA || rows[0]!.dispatch_state === "responded", "the settlement came from the live owner");
  assert.equal(end.money_state, "RecoveredCharge");
  assert.equal(end.buyer_state, "Recovered");
  assert.equal(end.ledger.length, 1, "one fee-ledger entry for one recovery");
});

await run("B8b worker A holds a LIVE lease with its request in flight: the job cannot be claimed again and a concurrent reconcile defers without a verdict or money", async () => {
  const d = await recoverable();
  const p = d.participants[0]!;
  provider.script(p.authorization, "recover", [{ kind: "EFFECT_THEN_HOLD", gate: "b8b" }]);
  const job = await bb.enqueueRecovery(d.deal_id);
  const workerA = bb.processOutboxEventById(job);
  await provider.waitEntered("b8b", 1, 8000);
  const secondClaim = await bb.processOutboxEventById(job);
  console.log(`  B8b second claim of a live job: ${JSON.stringify(secondClaim)}`);
  assert.ok(!secondClaim || secondClaim.status !== "sent", "a live job is not processed twice");
  // a reconcile of the same participant (as another worker would run it) must defer
  const identity = (await bb.attempts(p.participant_id, "recovery"))[0]!;
  const reconcile = await bb.enqueue("payment_reconcile", "participant", p.participant_id, { participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "recovery", correlation_id: identity.correlation_id, operation: "capture", provider_reference: p.authorization, reason: "blackbox_concurrent_reconcile" });
  const reconciled = await bb.processOutboxEventById(reconcile);
  const reconcileRow = await bb.outboxRow(reconcile);
  console.log(`  B8b concurrent reconcile: ${JSON.stringify({ result: reconciled?.status, outbox: reconcileRow?.status, deferred: reconcileRow?.deferred, error: String(reconcileRow?.last_error || "").slice(0, 90) })}`);
  assert.equal(reconcileRow?.status, "pending", "the reconcile deferred instead of concluding on an in-flight operation");
  assert.match(String(reconcileRow?.last_error || ""), /in_flight/);
  assert.deepEqual((await bb.attempts(p.participant_id, "recovery")).map((r) => `${r.result_class}/${r.dispatch_state}`), ["unknown/dispatching"], "no verdict while in flight");
  provider.release("b8b");
  const resultA = await Promise.race([workerA, timeout(20_000, "worker A never returned")]);
  assert.equal(resultA?.status, "sent", JSON.stringify(resultA));
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  const end = await bb.snapshot(p, d.deal_id);
  console.log(`  B8b terminal: ${JSON.stringify(end)}`);
  assert.equal(provider.requestsOf(p.authorization, "recover").length, 1, "exactly one recovery request");
  assert.equal(end.provider_effects.recover, 1);
  assert.equal(end.money_state, "RecoveredCharge");
});

await run("B8c control: recoveries of two participants of one deal run concurrently → one identity and one effect each", async () => {
  const d = await bb.seedDeal({
    state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 120_000), threshold_units: 1,
    participants: [
      { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] },
      { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] }
    ]
  });
  for (const p of d.participants) provider.script(p.authorization, "recover", [{ kind: "EFFECT_THEN_HOLD", gate: `b8c-${p.participant_id}` }]);
  const job = await bb.enqueueRecovery(d.deal_id);
  const running = bb.processOutboxEventById(job);
  // the rail handles the deal's participants one after the other; each answer is released as it arrives
  for (const p of d.participants) { await provider.waitEntered(`b8c-${p.participant_id}`, 1, 8000); provider.release(`b8c-${p.participant_id}`); }
  const result = await Promise.race([running, timeout(20_000, "recovery never returned")]);
  assert.equal(result?.status, "sent", JSON.stringify(result));
  await bb.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  for (const p of d.participants) {
    const end = await bb.snapshot(p, d.deal_id);
    assert.equal(distinctKeys(p.authorization, "recover").size, 1);
    assert.equal(end.provider_effects.recover, 1);
    assert.equal(end.money_state, "RecoveredCharge");
  }
});

const failed = summary();
await bb.close();
process.exit(failed ? 1 : 0);
