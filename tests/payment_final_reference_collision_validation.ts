import assert from "node:assert/strict";
import {bootLab,makeRunner} from "./lab/runtime.js";
const lab=await bootLab({tag:"reference-collision",port:3174});
const {run,summary}=makeRunner("payment_final_reference_collision");
await run("foreign three-letter reference prefix cannot establish a capture",async()=>{
 const d=await lab.seedDeal({state:"Charging",threshold_units:1,participants:[{buyer_state:"ChargingAttempt",money_state:"ChargeAttempt"}]});
 const p=d.participants[0]!;
 lab.sim.script(p.authorization,"capture",[{kind:"NO_EFFECT_503"}]);
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const response=await originalFetch(input,init);
  if(String(input).includes("/status/")) {
   const body=await response.json() as any;
   return new Response(JSON.stringify({...body,provider_reference:"xyz-"+p.authorization,state:"captured",final:true,amount_minor:p.amount_minor,currency:"ILS"}),{status:200,headers:{"content-type":"application/json"}});
  }
  return response;
 };
 try {
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({dealIds:[d.deal_id],types:["charge_deal","payment_reconcile"],maxRounds:8});
  const participant=await lab.participant(p.participant_id);
  const attempts=await lab.attempts(p.participant_id);
  console.log("REFERENCE_COLLISION_EVIDENCE "+JSON.stringify({money_state:participant.money_state,effects:lab.sim.effectsOf(p.authorization),attempts:attempts.map(a=>a.result_class)}));
  assert.equal(lab.sim.effectsOf(p.authorization).capture,0);
  assert.notEqual(participant.money_state,"ChargedSuccess","foreign reference created false canonical capture");
  assert.ok(!attempts.some(a=>a.result_class==="success"),"foreign reference created false success identity");
  assert.ok((await lab.cases(p.participant_id)).some(c=>c.auto_key.includes("reference-mismatch")));
 }finally{globalThis.fetch=originalFetch;}
});
const failed=summary(); await lab.close(); process.exit(failed?1:0);
