const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Pool } = require('pg');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname,'..');
const phase = process.argv[2];
const snapshotFile = process.argv[3];
const db = new URL(process.env.DATABASE_URL || 'invalid:');
if (!['localhost','127.0.0.1','[::1]'].includes(db.hostname) || !/^\/siton_pilot_\d+_\d+_day$/.test(db.pathname) || process.env.NODE_ENV !== 'test') {
  throw new Error('Scenario requires harness-owned disposable DB');
}
Object.assign(process.env,{RATE_LIMIT_MAX:'100000',RATE_LIMIT_READ_MAX:'100000',RATE_LIMIT_SENSITIVE_MAX:'100000',ADMIN_API_KEY:'pilot-synthetic-admin'});
const imp = file => import(pathToFileURL(path.join(root,'.tmp_test_dist',file)).href);
async function main() {
  const { app } = await imp('src/app.js');
  const { pool: appPool } = await imp('src/db.js');
  const fixture = await imp('tests/helpers/physical_fulfillment_fixture.js');
  const pool = new Pool({connectionString:db.toString(),max:10});
  const timings = {};
  async function request(label, options) {
    const start = performance.now(); const r = await app.inject(options);
    (timings[label] ||= []).push(performance.now()-start); return r;
  }
  async function snapshot() {
    const tables = ['deals','participants','join_idempotency_results','viral_attributions','fulfillment_units','outbox_events','operational_cases','viral_events','viral_metrics_cache'];
    const result = {};
    for(const table of tables) {
      const rows = await pool.query(`SELECT to_jsonb(t) AS row FROM siton.${table} t ORDER BY to_jsonb(t)::text`);
      result[table]=rows.rows.map(r=>r.row);
    }
    return result;
  }
  try {
    if(phase==='workers') {
      let child;
      const jobs=[];
      async function stop() {
        if(!child || child.exitCode!==null)return;
        const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
      }
      async function poll(fn) {
        const deadline=Date.now()+15000;
        while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,25));}
        throw new Error('worker condition timed out');
      }
      function start(){child=spawn(process.execPath,[path.join(root,'.tmp_test_dist/src/worker.js')],{env:{...process.env,OUTBOX_POLL_MS:'25',WORKER_CONCURRENCY:'4',WORKER_ID:'pilot-restart-worker',WORKER_HEARTBEAT_MS:'1000'},stdio:['ignore','ignore','pipe'],windowsHide:true});child.stderr.on('data',b=>process.stderr.write(b));}
      try {
        const draft=(await pool.query("SELECT deal_id FROM siton.deals WHERE state='Draft' ORDER BY deal_id LIMIT 1")).rows[0].deal_id;
        const future=(await pool.query("SELECT event_uuid FROM siton.outbox_events WHERE available_at > now()+interval '1 hour' AND status='pending'")).rows.map(r=>r.event_uuid);
        assert.ok(future.length>0,'future jobs fixture is nonvacuous');
        for(let i=0;i<200;i++) {
          if(i===100)await stop();
          const job=(await pool.query("INSERT INTO siton.outbox_events(event_type,aggregate_type,aggregate_id,payload,status,attempt_count,available_at) VALUES ('deadline_check','deal',$1,'{}','pending',0,now()) RETURNING event_uuid",[draft])).rows[0].event_uuid;
          jobs.push(job);
          if(i===0||i===100){
            const health=await app.inject({method:'GET',url:'/health'});assert.equal(health.statusCode,200,health.body);
            assert.equal((await pool.query('SELECT status FROM siton.outbox_events WHERE event_uuid=$1',[job])).rows[0].status,'pending');start();
          }
          await poll(async()=> (await pool.query('SELECT status FROM siton.outbox_events WHERE event_uuid=$1',[job])).rows[0].status==='sent');
        }
        await stop();
        const effects=await pool.query("SELECT subject_id,count(*)::int AS n FROM siton.operational_recovery_audit WHERE action='completion' AND subject_type='outbox_event' AND subject_id=ANY($1::text[]) GROUP BY subject_id",[jobs]);
        assert.equal(effects.rowCount,200);for(const r of effects.rows)assert.equal(r.n,1);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM siton.outbox_events WHERE event_uuid=ANY($1::uuid[]) AND status='pending'",[future])).rows[0].n,future.length);
        const bad=await pool.query("SELECT count(*)::int AS n FROM siton.outbox_events WHERE status IN ('processing','dead','failed')");assert.equal(bad.rows[0].n,0);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM siton.outbox_dlq')).rows[0].n,0);
        const saved=JSON.parse(fs.readFileSync(snapshotFile,'utf8'));
        const t=await fixture.tracking(app,saved.fulfilled.participant_id,saved.fulfilled.tracking_access_token);assert.equal(t.json().tracking.pickup.state,'fulfilled');
        console.log(`WORKER_DAY_PASS due_jobs=200 exactly_once=200 future_preserved=${future.length} web_alive=YES restart=PASS`);
      } finally {await stop();}
      return;
    }
    if(phase==='restart') {
      const saved=JSON.parse(fs.readFileSync(snapshotFile,'utf8'));
      assert.deepEqual(await snapshot(),saved.truth,'canonical rows survive a genuinely new app process');
      for(const p of saved.tracking) {
        const t=await request('tracking',{method:'GET',url:`/api/participants/${p.participant_id}/tracking?t=${p.tracking_access_token}`});
        assert.equal(t.statusCode,200,t.body);
      }
      const replay=await app.inject(saved.replay.request);
      assert.equal(replay.statusCode,200,replay.body);
      assert.equal(replay.json().participant_id,saved.replay.participant_id);
      const t=await fixture.tracking(app,saved.fulfilled.participant_id,saved.fulfilled.tracking_access_token);
      assert.equal(t.json().tracking.pickup.state,'fulfilled');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM siton.participants')).rows[0].n,saved.truth.participants.length);
      console.log('RESTART_PASS rows=exact tracking=all idempotency=persistent fulfillment=persistent viral=persistent');
      return;
    }
    const sellers=Array.from({length:5},(_,i)=>`pilot-seller-${i}`);
    for(const [i,seller] of sellers.entries()) {
      await pool.query(`INSERT INTO siton.seller_accounts (seller_id,display_name,business_name,support_email,verification_status,settlement_status) VALUES ($1,$1,$1,$2,$3,'active')`,[seller,`seller${i}@example.test`,i===4?'pending':'approved']);
      await fixture.ensureSellerReady(app,seller,`Synthetic pilot seller ${i}`);
    }
    const deals=[];
    for(let i=0;i<12;i++) {
      const type=i===8?'voucher':i===9?'ticket':'physical_product';
      const seller=sellers[i===11?4:i%4];
      const extra={deal_type:type};
      if(type==='voucher') extra.voucher_terms={face_value_amount:100,currency:'ILS',valid_from:new Date(Date.now()-86400000).toISOString(),valid_until:new Date(Date.now()+86400000*30).toISOString(),redemption_location:'Synthetic counter',redemption_instructions:'Show code',terms:'One synthetic meal',is_single_use:true,allow_partial_redemption:false,voucher_code_mode:'system_generated'};
      if(type==='ticket') extra.ticket_terms={event_name:'Synthetic concert',event_starts_at:new Date(Date.now()+86400000*4).toISOString(),event_ends_at:new Date(Date.now()+86400000*4+3600000).toISOString(),venue_name:'Synthetic hall',venue_address:'Test street 1',venue_city:'Test city',entry_instructions:'Show code',ticket_type:'general_admission',seat_mode:'general_admission',transfer_allowed:false};
      const id=await fixture.createDeal(app,seller,{title:`Pilot ${i} ${type}`,price:i<3?60:[1.01,19.99,10000.99,7.77][i%4],minUnits:i===0?25:20,maxUnits:i===0?30:100,extra});
      deals.push({id,seller,type});
      if(i!==11) await fixture.publishDeal(app,seller,id);
    }
    // Canonical demo-preview explicitly allows pending KYC to publish; production guard
    // is exercised separately. Preserve this twelfth deal as Draft for pilot topology.
    const pending=await pool.query('SELECT verification_status FROM siton.seller_accounts WHERE seller_id=$1',[sellers[4]]);
    assert.equal(pending.rows[0].verification_status,'pending');
    process.env.APP_ENV='production';
    try {
      const refused=await app.inject({method:'POST',url:`/deals/${deals[11].id}/publish`,headers:fixture.sellerHeaders(sellers[4]),payload:{seller_terms_accepted:true,seller_critical_terms_accepted:true,seller_threshold_90_accepted:true}});
      assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().code,'seller_kyc_not_approved');
    } finally {delete process.env.APP_ENV;}
    for(const action of ['close_joining','reopen_joining','close_joining']){
      const r=await app.inject({method:'POST',url:`/deals/${deals[10].id}/${action}`,headers:{...fixture.sellerHeaders(deals[10].seller),'idempotency-key':randomUUID()},payload:{}});assert.equal(r.statusCode,200,r.body);
    }
    for(const deal of deals.slice(0,11)) {
      const wrong=sellers[(sellers.indexOf(deal.seller)+1)%4];
      const r=await app.inject({method:'GET',url:`/api/seller/deals/${deal.id}/fulfillment`,headers:fixture.sellerHeaders(wrong)});
      assert.ok([403,404].includes(r.statusCode),r.body);
    }
    const journeys=[]; let index=0;
    async function prepare(deal,extra={}) {
      const n=index++;const otp=await fixture.otpVerify(app,`050${String(8000000+n)}`);
      const pub=await app.inject({method:'GET',url:`/api/deals/${deal.id}/public`});
      const option=(pub.json().deal.delivery_options||[]).find(o=>o.option_type===(n%2?'delivery':'pickup'));
      const payload={...otp,buyer_id:otp.buyer_id,buyer_name:`Synthetic buyer ${n}`,buyer_email:`buyer${n}@example.test`,qty:1,buyer_terms_accepted:true,payment_disclosure_accepted:true,...extra};
      if(option) Object.assign(payload,{delivery_option_id:option.option_id,...(option.option_type==='delivery'?{delivery_address:`Synthetic street ${n}`,delivery_city:'Test city',delivery_notes:'Synthetic door only'}:{})});
      return {method:'POST',url:`/deals/${deal.id}/join`,headers:{'idempotency-key':`pilot-join-${n}`},payload};
    }
    const burst=[];
    for(let i=0;i<40;i++) burst.push(await prepare(deals[0]));
    const wave=await Promise.all(burst.map(r=>request('join_burst',r)));
    assert.equal(wave.filter(r=>r.statusCode===200).length,30,'capacity exactly 30 from 40 competing requests');
    for(const r of wave) assert.ok([200,409,422,400].includes(r.statusCode),r.body);
    for(let i=0;i<wave.length;i++) if(wave[i].statusCode===200) journeys.push({deal:deals[0],request:burst[i],body:wave[i].json()});
    for(let i=1;i<=9;i++) {
      let rootCode,childCode;
      for(let j=0;j<10;j++) {
        const referral=j===1?rootCode:j===2?childCode:j>2?rootCode:undefined;
        const req=await prepare(deals[i],referral?{affiliate_ref:referral}:{});
        const r=await request('join',req);assert.equal(r.statusCode,200,r.body);
        const body=r.json();if(j===0)rootCode=body.viral.personal_share_code;if(j===1)childCode=body.viral.personal_share_code;
        if(j===2)assert.equal(body.viral.generation,2);
        journeys.push({deal:deals[i],request:req,body});
      }
    }
    assert.equal(index,130);assert.equal(journeys.length,120);
    for(let i=0;i<200;i++) {
      const r=await app.inject({method:'POST',url:'/api/viral/events',payload:{event_type:'deal_view',deal_id:deals[i%10].id,client_event_id:randomUUID(),visitor_id:`pilot-visitor-${i}`,session_id:`pilot-session-${i}`}});
      assert.ok([200,201,202].includes(r.statusCode),r.body);
    }
    const feedback=await app.inject({method:'POST',url:`/api/deals/${deals[1].id}/feedback`,payload:{category:'price',text:'Synthetic feedback about delivery cost',surface:'join_success'}});assert.equal(feedback.statusCode,201,feedback.body);
    const contact=await app.inject({method:'POST',url:'/api/support/contact',payload:{name:'Synthetic pilot buyer',email:'pilot-support@example.test',category:'general',message:`Synthetic support incident concerning pilot deal ${deals[1].id}`}});assert.equal(contact.statusCode,201,contact.body);
    const unknown=await app.inject({method:'GET',url:`/api/participants/${journeys[0].body.participant_id}/tracking?t=unknown-pilot-token`});assert.ok([403,404].includes(unknown.statusCode),unknown.body);
    const duplicate=await app.inject(journeys[0].request);assert.equal(duplicate.statusCode,200,duplicate.body);
    assert.equal(duplicate.json().participant_id,journeys[0].body.participant_id);
    const canonical=await pool.query(`SELECT d.deal_id,d.max_units,coalesce(sum(p.qty) FILTER(WHERE p.buyer_state NOT IN ('Dropped','DealFailed')),0)::int AS qty FROM siton.deals d LEFT JOIN siton.participants p USING(deal_id) GROUP BY d.deal_id`);
    for(const row of canonical.rows)assert.ok(row.qty<=row.max_units,'never oversell');
    const crossings=await pool.query(`SELECT count(*)::int AS n FROM siton.audit_log WHERE entity_id=$1 AND action_name='deal.target_reached'`,[deals[0].id]);
    assert.equal(crossings.rows[0].n,1,'threshold crosses once');
    // Fixture-only completed state for read-model/fulfillment reconciliation; full lifecycle is a separate suite.
    for(const deal of deals.slice(1,3)) {
      for(const [n,p] of journeys.filter(j=>j.deal.id===deal.id).entries())await fixture.forceParticipantTo(pool,p.body.participant_id,deal===deals[2] && n<2?'AuthReleased':n===2?'RecoveredCharge':'ChargedSuccess');
      await fixture.forceDealState(pool,deal.id,'Completed');
    }
    const fulfilled=journeys.find(j=>j.deal.id===deals[1].id && !j.request.payload.delivery_address).body;
    const track=await fixture.tracking(app,fulfilled.participant_id,fulfilled.tracking_access_token);
    assert.equal(track.statusCode,200,track.body);const code=track.json().tracking.pickup.order_code;assert.ok(code);
    const resolve=await request('fulfillment_resolve',{method:'GET',url:`/api/seller/fulfillment/resolve?code=${code}`,headers:fixture.sellerHeaders(deals[1].seller)});assert.equal(resolve.statusCode,200,resolve.body);
    const handoff={method:'POST',url:'/api/seller/fulfillment/handoff',headers:{...fixture.sellerHeaders(deals[1].seller),'idempotency-key':'pilot-handoff'},payload:{participant_id:fulfilled.participant_id,source:'list'}};
    for(let i=0;i<2;i++){const r=await app.inject(handoff);assert.equal(r.statusCode,200,r.body);}
    for(const deal of deals.slice(1,3)) {
      const admin=await request('admin_profile',{method:'GET',url:`/api/admin/deals/${deal.id}/profile`,headers:{'x-admin-key':process.env.ADMIN_API_KEY}});assert.equal(admin.statusCode,200,admin.body);
      const fulfillment=admin.json().profile.fulfillment;
      for(const route of ['shipping-export','delivery-handoff/export.xlsx']) {
        const r=await request('export',{method:'GET',url:`/api/seller/deals/${deal.id}/${route}`,headers:fixture.sellerHeaders(deal.seller)});assert.equal(r.statusCode,200,r.body.slice(0,100));
        if(route.endsWith('xlsx')) {
          const ExcelJS=require('exceljs');const wb=new ExcelJS.Workbook();await wb.xlsx.load(r.rawPayload);
          const ws=wb.worksheets[0];const headers=ws.getRow(1).values.slice(1).map(String);const rows=[];
          ws.eachRow((row,n)=>{if(n>1)rows.push(Object.fromEntries(headers.map((h,i)=>[h,row.getCell(i+1).value])));});
          const truth=(await pool.query("SELECT * FROM siton.participants WHERE deal_id=$1 AND money_state IN ('ChargedSuccess','RecoveredCharge')",[deal.id])).rows;
          assert.equal(rows.length,truth.length);
          for(const p of truth){
            assert.ok(['ChargedSuccess','RecoveredCharge'].includes(p.money_state));
            const row=rows.find(r=>r['שם מקבל']===p.buyer_name);assert.ok(row);
            assert.equal(Number(row['כמות']),p.qty);assert.equal(row['מצב תשלום'],'שולם');
            const state=fulfillment.by_participant[p.participant_id].fulfillment_status;
            assert.equal(row['מצב מסירה'],state==='fulfilled'?'נמסר':'ממתין למסירה');
            if(p.delivery_address){assert.equal(row['כתובת'],p.delivery_address);assert.equal(row['עיר'],p.delivery_city);assert.equal(row['הערת משלוח'],p.delivery_notes);}
          }
        }
      }
    }
    for(const [label,url,headers] of [
      ['seller_listing','/api/seller/deals',fixture.sellerHeaders(sellers[0])],
      ['seller_detail',`/api/seller/deals/${deals[0].id}`,fixture.sellerHeaders(sellers[0])],
      ['admin_overview','/api/admin/overview',{'x-admin-key':process.env.ADMIN_API_KEY}]
    ]){
      const r=await request(label,{method:'GET',url,headers});assert.equal(r.statusCode,200,r.body);
      if(label==='admin_overview'){
        const expected=(await pool.query("SELECT coalesce(sum(d.price_per_unit*p.qty+p.delivery_cost),0)::numeric AS gross FROM siton.deals d JOIN siton.participants p USING(deal_id) WHERE d.state='Completed' AND p.money_state IN ('ChargedSuccess','RecoveredCharge')")).rows[0];
        assert.equal(r.json().admin_surface.settlements.seller_workspace.gross_amount,Number(expected.gross),'admin settlement must exclude released/unpaid orders');
        assert.equal(Number(expected.gross),1260,'mixed-state regression is nonvacuous');
        // This existing response field includes VAT on Siton's fee: 100.80 + 18.14.
        assert.equal(r.json().admin_surface.settlements.seller_workspace.platform_fee_amount,118.94);
        assert.equal(r.json().admin_surface.totals.deals,12);
      }
    }
    const { calculatePlatformFeeMoney }=await imp('src/platform_fee_money.js');
    const { computeCustomerChargeVat }=await imp('src/vat_authority.js');
    const orders=(await pool.query('SELECT d.price_per_unit,p.qty,p.delivery_cost FROM siton.participants p JOIN siton.deals d USING(deal_id)')).rows;
    for(const mode of ['synthetic_zero','explicit']){
      process.env.SITON_VAT_MODE=mode;process.env.SITON_VAT_RATE_PRODUCT='0.18';process.env.SITON_VAT_RATE_DELIVERY='0.18';
      for(const p of orders){
        const product=Number(p.price_per_unit)*p.qty,delivery=Number(p.delivery_cost);
        const vat=computeCustomerChargeVat({productGrossAmount:product,deliveryGrossAmount:delivery});
        const money=calculatePlatformFeeMoney({grossAmount:product+delivery,vatAmount:vat.vat_amount});
        const baseCents=Math.round((product+delivery)*100)-Math.round(vat.vat_amount*100);
        assert.equal(Math.round(money.platform_fee_base_amount*100),Math.floor((baseCents*8+50)/100));
        assert.equal(money.platform_fee_rate,0.08);assert.ok(!Object.hasOwn(money,'affiliate_fee_amount'));
      }
    }
    delete process.env.SITON_VAT_MODE;delete process.env.SITON_VAT_RATE_PRODUCT;delete process.env.SITON_VAT_RATE_DELIVERY;
    console.log('FEE_PASS order_checks=240 modes=synthetic_zero,explicit delivery=included buyer_vat=excluded distributor=0');
    const viral=await imp('src/viral_graph.js');
    for(const deal of deals.slice(0,10)){
      const metrics=await viral.recomputeDealViralMetrics(pool,deal.id);
      const paid=(await pool.query("SELECT coalesce(sum(qty),0)::int AS n FROM siton.participants WHERE deal_id=$1 AND money_state IN ('ChargedSuccess','RecoveredCharge')",[deal.id])).rows[0].n;
      assert.equal(metrics.totals.charged_units,paid);
    }
    for(const seller of sellers)await viral.recomputeAggregateViralMetrics(pool,seller);
    await viral.recomputeAggregateViralMetrics(pool,null);
    for(const p of journeys){const r=await request('tracking',{method:'GET',url:`/api/participants/${p.body.participant_id}/tracking?t=${p.body.tracking_access_token}`});assert.equal(r.statusCode,200,r.body);}
    // Take the durable snapshot after lazy read-model/credential issuance.
    const truth=await snapshot();
    assert.equal(truth.participants.length,120,'failed capacity transactions leave no orphan participant');
    assert.equal(truth.join_idempotency_results.length,120);
    assert.equal(truth.viral_attributions.length,120);
    assert.equal(truth.operational_cases.length,2);
    assert.ok(truth.viral_metrics_cache.length>=10);
    fs.writeFileSync(snapshotFile,JSON.stringify({truth,tracking:journeys.map(j=>j.body),fulfilled,replay:{request:journeys[0].request,participant_id:journeys[0].body.participant_id}}));
    console.log('PILOT_DAY_PASS sellers=5 deals=12 synthetic_identities=130 participants=120 burst=40 capacity=30 threshold_crossings=1 oversold=0 duplicate_effect=0');
    console.log('DURABLE_COUNTS '+JSON.stringify(Object.fromEntries(Object.entries(truth).map(([k,v])=>[k,v.length]))));
  } finally {
    for(const [label,values]of Object.entries(timings)){values.sort((a,b)=>a-b);console.log('PERF '+JSON.stringify({label,n:values.length,p50_ms:+values[Math.floor(values.length*.5)].toFixed(1),p95_ms:+values[Math.min(values.length-1,Math.floor(values.length*.95))].toFixed(1),max_ms:+values.at(-1).toFixed(1)}));}
    await app.close();await appPool.end();await pool.end();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
