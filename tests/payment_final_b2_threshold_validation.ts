import assert from "node:assert/strict";
import { bootLab, makeRunner } from "./lab/runtime.js";
const lab = await bootLab({tag:"b2-threshold",port:3173,env:{COMPLETION_WINDOW_MINUTES:"-1"}});
const {run,summary}=makeRunner("payment_final_b2_threshold");
for (const successIndex of [3,0]) await run("three declines; only buyer " + successIndex + " succeeds", async()=>{
  const d=await lab.seedDeal({state:"Charging",threshold_units:2,participants:[3,2,2,1].map(qty=>({qty,buyer_state:"ChargingAttempt",money_state:"ChargeAttempt"}))});
  for (const [i,p] of d.participants.entries()) lab.sim.script(p.authorization,"capture",[{kind:i===successIndex?"SUCCESS":"DECLINED"}]);
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({dealIds:[d.deal_id],types:["charge_deal"]});
  assert.equal(d.participants.reduce((n,p)=>n+lab.sim.effectsOf(p.authorization).capture,0),1);
  assert.equal((await lab.pool.query("SELECT count(*)::int AS n FROM siton.payment_attempts WHERE deal_id=$1 AND attempt_type='charge_start' AND result_class='permanent_fail'",[d.deal_id])).rows[0].n,3);
  const final=(await lab.liveEvents([d.deal_id],["finalize_deal"]))[0]!.event_uuid;
  await lab.processOutboxEventById(final);
  const expected=successIndex===3?"Failed":"Completed";
  assert.equal((await lab.deal(d.deal_id)).state,expected);
  console.log("B2_THRESHOLD_PROOF qty="+d.participants[successIndex]!.qty+" threshold=2 three_declines=3 expected="+expected);
});
const failed=summary(); await lab.close(); process.exit(failed?1:0);
