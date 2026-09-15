import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { trackingMode } from "../src/participant_tracking_security.js";

// Real route on the isolated test DB: every nonempty combination of supported
// production signals must refuse a known participant, not merely an unknown id.
process.env.DISABLE_OUTBOX_WORKER = "1";
const { app } = await import("../src/app.js");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const keys = ["NODE_ENV", "APP_ENV", "RENDER", "RENDER_EXTERNAL_URL", "TRACKING_LEGACY_COMPAT", "APP_DEPLOYMENT_MODE"];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const signals = { NODE_ENV: "production", APP_ENV: "production", RENDER: "true", RENDER_EXTERNAL_URL: "https://example.invalid" };
const deal = randomUUID(), participant = randomUUID();
let cases = 0;
try {
  await pool.query(`INSERT INTO siton.deals(deal_id,title,price_per_unit,min_units,max_units,threshold_units,deadline) VALUES($1,'UX tracking fixture',1,1,2,1,now()+interval '1 day')`, [deal]);
  await pool.query(`INSERT INTO siton.participants(participant_id,deal_id,buyer_id,qty,buyer_name,buyer_phone,buyer_email) VALUES($1,$2,'private-buyer-id',1,'PRIVATE BUYER','0501234567','private-buyer@example.invalid')`, [participant,deal]);
  for (let mask = 1; mask < 16; mask++) {
    for (const deployment of [undefined, "demo-preview", "production"]) {
      for (const compat of [undefined, "0"]) {
        for (const key of keys) delete process.env[key];
        Object.entries(signals).forEach(([key,value],index)=>{if(mask & (1<<index)) process.env[key]=value;});
        if(deployment) process.env.APP_DEPLOYMENT_MODE=deployment;
        if(compat) process.env.TRACKING_LEGACY_COMPAT=compat;
        assert.equal(trackingMode().legacy_links_allowed,false,`mask=${mask}, deployment=${deployment}, compat=${compat}`);
        const response = await app.inject({method:"GET",url:`/api/participants/${participant}/tracking`});
        assert.equal(response.statusCode,401,response.body);
        assert.equal(response.json().error,"tracking_token_required");
        assert.doesNotMatch(response.body,/PRIVATE BUYER|0501234567|private-buyer|buyer_name|buyer_phone|buyer_email/);
        cases++;
      }
    }
  }
  for (const key of keys) delete process.env[key];
  process.env.NODE_ENV="test";
  process.env.APP_DEPLOYMENT_MODE="demo-preview";
  process.env.TRACKING_LEGACY_COMPAT="1";
  assert.equal(trackingMode().legacy_links_allowed,true,"intentional local demo compatibility remains available");
  // Explicit override is existing configuration, not the production default.
  process.env.NODE_ENV="production";
  assert.equal(trackingMode().live_blocked_without_tracking_tokens,true,"unsafe explicit override blocks live readiness");
  console.log(`PASS UX production tracking: ${cases} real anonymous requests denied; explicit demo compatibility retained`);
} finally {
  for(const key of keys) { if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key]; }
  await pool.query('DELETE FROM siton.participants WHERE participant_id=$1',[participant]);
  await pool.query('DELETE FROM siton.deals WHERE deal_id=$1',[deal]);
  await pool.end(); await app.close();
}
