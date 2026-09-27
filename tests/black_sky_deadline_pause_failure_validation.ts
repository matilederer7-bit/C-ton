// BLACK-SKY COMBINATION 3 — the deadline arrives in the middle of a pause.
//
// Real HTTP handlers (app.inject), real worker code (processOutboxEventById),
// real migrated disposable database, black-box provider stub for the hold
// releases. Every race is fired with Promise.all inside one process so the
// three operations contend on the same rows and pool.
//
//   D3a COMBINES (3): deal PAUSED (ClosedForJoining) BELOW threshold when its
//        deadline passes + the seller calls prepare_charging concurrently + a
//        late join races the deadline_check job.
//       EXPECTED (fail closed): Failed, never charged. prepare_charging 409,
//        join 409, zero capture requests, every hold released at the provider
//        exactly once (AuthReleased), invariants PASS.
//
//   D3b COMBINES (3): deal PAUSED AT threshold when its deadline passes +
//        prepare_charging + a late join, all racing the deadline_check.
//       EXPECTED: ReadyForCharging (charged path), never Failed — never both;
//        no hold released, join 409, invariants PASS.
//
//   D3c COMBINES (2+): OPEN deal below threshold, deadline passes + a late join
//        and a second late join race the deadline_check.
//       EXPECTED: both joins 409 deal_deadline_passed (no participant, no
//        binding consumed), deal Failed, the existing hold released once.

import assert from "node:assert/strict";
import { bootBlackBox, makeRunner, type SeededDeal } from "./blackbox/harness.js";
import { auditSeededDeal, runMoneyInvariantsOrThrow } from "./support/black_sky_chaos.js";

const bb = await bootBlackBox({ tag: "bs-deadline", port: 3412, env: { COMPLETION_WINDOW_MINUTES: "30" } });
const { run, summary } = makeRunner("black_sky_deadline_pause");
const { provider, app } = bb;
const SELLER = "seller-blackbox";

async function pausedOrOpenDeal(args: { state: "ClosedForJoining" | "PendingTarget"; threshold: number; participants: number }): Promise<SeededDeal> {
  const d = await bb.seedDeal({
    state: args.state, threshold_units: args.threshold, min_units: 1, max_units: 10,
    deadline: new Date(Date.now() - 60_000),
    participants: Array.from({ length: args.participants }, () => ({ buyer_state: "JoinedAuthorized", money_state: "AuthHeld" }))
  });
  if (args.state === "ClosedForJoining") {
    await bb.pool.query(`UPDATE siton.deals SET close_reason='manual', closed_for_joining_at=now() WHERE deal_id=$1`, [d.deal_id]);
  }
  await auditSeededDeal(bb.pool, d.deal_id);
  return d;
}

const prepare = (dealId: string, key: string) => app.inject({
  method: "POST", url: `/deals/${dealId}/prepare_charging`,
  headers: { "x-seller-id": SELLER, "x-request-id": `bs-prep-${key}`, "idempotency-key": `bs-prep-${key}`, "content-type": "application/json" },
  payload: {}
});
const lateJoin = (dealId: string, key: string) => app.inject({
  method: "POST", url: `/deals/${dealId}/join`,
  headers: { "x-request-id": `bs-join-${key}`, "idempotency-key": `bs-join-${key}`, "content-type": "application/json", "x-forwarded-for": "10.9.0.3" },
  payload: { buyer_id: `buyer-late-${key}`, qty: 1, buyer_terms_accepted: true, payment_disclosure_accepted: true, authorization_id: `auth-late-${key}`, authorization_provider: "payrail-http" }
});

async function dealAuditTargets(dealId: string) {
  return (await bb.pool.query(`SELECT to_state FROM siton.audit_log WHERE entity_type='deal' AND entity_id=$1 AND action_name <> 'test.black_sky_fixture' ORDER BY created_at`, [dealId])).rows.map((r) => String(r.to_state));
}
async function participantCount(dealId: string) {
  return Number((await bb.pool.query(`SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId])).rows[0].n);
}

await run("D3a paused below threshold + deadline + concurrent prepare_charging + late join → Failed, never charged, holds released exactly once", async () => {
  const d = await pausedOrOpenDeal({ state: "ClosedForJoining", threshold: 3, participants: 1 });
  const deadlineJob = await bb.enqueue("deadline_check", "deal", d.deal_id, { deal_id: d.deal_id });
  const [deadline, prep, join] = await Promise.all([bb.processOutboxEventById(deadlineJob), prepare(d.deal_id, `d3a-${d.deal_id}`), lateJoin(d.deal_id, `d3a-${d.deal_id}`)]);
  console.log(`  D3a race: deadline=${JSON.stringify(deadline)} prepare=${prep.statusCode} ${prep.body.slice(0, 100)} join=${join.statusCode} ${join.body.slice(0, 100)}`);
  assert.equal(deadline?.status, "sent", JSON.stringify(deadline));
  assert.equal(prep.statusCode, 409, `prepare_charging must refuse: ${prep.body}`);
  assert.equal(join.statusCode, 409, `late join must refuse: ${join.body}`);
  assert.equal((await bb.deal(d.deal_id)).state, "Failed");
  assert.equal(await participantCount(d.deal_id), 1, "the late join created nothing");

  await bb.drain({ dealIds: [d.deal_id] });
  for (const p of d.participants) {
    const row = await bb.participant(p.participant_id);
    assert.equal(row.buyer_state, "DealFailed");
    assert.equal(row.money_state, "AuthReleased", "the hold is released with provider proof");
    assert.equal(provider.requestsOf(p.authorization, "capture").length, 0, "never charged");
    assert.equal(provider.effectsOf(p.authorization).release, 1, "released exactly once");
  }
  const targets = await dealAuditTargets(d.deal_id);
  assert.ok(targets.includes("Failed") && !targets.includes("ReadyForCharging") && !targets.includes("Charging"), `never both: ${targets}`);
  await runMoneyInvariantsOrThrow("D3a");
});

await run("D3b paused AT threshold + deadline + concurrent prepare_charging + late join → ReadyForCharging, never Failed, no hold released", async () => {
  const d = await pausedOrOpenDeal({ state: "ClosedForJoining", threshold: 2, participants: 2 });
  const deadlineJob = await bb.enqueue("deadline_check", "deal", d.deal_id, { deal_id: d.deal_id });
  const [deadline, prep, join] = await Promise.all([bb.processOutboxEventById(deadlineJob), prepare(d.deal_id, `d3b-${d.deal_id}`), lateJoin(d.deal_id, `d3b-${d.deal_id}`)]);
  console.log(`  D3b race: deadline=${JSON.stringify(deadline)} prepare=${prep.statusCode} ${prep.body.slice(0, 100)} join=${join.statusCode}`);
  assert.equal(deadline?.status, "sent", "a met threshold is not failed by the deadline check");
  assert.equal(prep.statusCode, 200, prep.body);
  assert.equal(join.statusCode, 409, join.body);
  assert.equal((await bb.deal(d.deal_id)).state, "ReadyForCharging");
  await bb.drain({ dealIds: [d.deal_id], types: ["deadline_check", "payment_release"] });
  for (const p of d.participants) {
    const row = await bb.participant(p.participant_id);
    assert.equal(row.buyer_state, "LockedIn");
    assert.equal(row.money_state, "AuthLocked");
    assert.equal(provider.moneyRequestsOf(p.authorization).length, 0, "no release, no capture yet");
  }
  const targets = await dealAuditTargets(d.deal_id);
  assert.ok(targets.includes("ReadyForCharging") && !targets.includes("Failed"), `never both: ${targets}`);
  assert.equal(await participantCount(d.deal_id), 2);
  await runMoneyInvariantsOrThrow("D3b");
});

await run("D3c open deal below threshold, deadline passed + two late joins racing the deadline_check → joins 409, Failed, hold released once", async () => {
  const d = await pausedOrOpenDeal({ state: "PendingTarget", threshold: 5, participants: 1 });
  const deadlineJob = await bb.enqueue("deadline_check", "deal", d.deal_id, { deal_id: d.deal_id });
  const [joinA, deadline, joinB] = await Promise.all([lateJoin(d.deal_id, `d3c-a-${d.deal_id}`), bb.processOutboxEventById(deadlineJob), lateJoin(d.deal_id, `d3c-b-${d.deal_id}`)]);
  console.log(`  D3c race: joinA=${joinA.statusCode} ${joinA.body.slice(0, 100)} deadline=${JSON.stringify(deadline)} joinB=${joinB.statusCode}`);
  assert.equal(joinA.statusCode, 409, joinA.body);
  assert.equal(joinB.statusCode, 409, joinB.body);
  assert.equal(await participantCount(d.deal_id), 1, "no late participant");
  assert.equal((await bb.deal(d.deal_id)).state, "Failed");
  await bb.drain({ dealIds: [d.deal_id] });
  const p = d.participants[0]!;
  assert.equal((await bb.participant(p.participant_id)).money_state, "AuthReleased");
  assert.equal(provider.effectsOf(p.authorization).release, 1);
  assert.equal(provider.requestsOf(p.authorization, "capture").length, 0);
  await runMoneyInvariantsOrThrow("D3c");
});

const failed = summary();
await bb.close();
process.exit(failed ? 1 : 0);
