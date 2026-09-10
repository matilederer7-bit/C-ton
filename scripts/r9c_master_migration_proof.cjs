const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { runMigrations, checksum } = require('./run_migrations.cjs');
const { MIGRATIONS, MIGRATIONS_DIR } = require('./migration_manifest.cjs');
require('dotenv').config({ quiet: true });
// Landed master at review time. Master advanced past the candidate's original
// baseline d4c7877 (it landed 066_receipt_trust_content), so the financial SQL
// appends as 067/068 and this proof pins the ledger it must actually upgrade.
const BASE = 'c1ce4e4164fd4ee64d124fec29fade97b4557df0';
const SOURCE = '3809b32c11d82e57d6ed106f88dea7a55b76499a';
const git = (...args) => execFileSync('git', args);
const sqlBody = m => fs.readFileSync(path.join(MIGRATIONS_DIR, m.filename), 'utf8');
const ledger = async c => (await c.query('SELECT * FROM siton.migration_ledger ORDER BY position')).rows;
async function schema(c) {
  const queries = [
    `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='siton' ORDER BY table_name,ordinal_position`,
    `SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='siton' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
    `SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='siton' AND NOT t.tgisinternal ORDER BY t.tgname`,
    `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='siton' ORDER BY indexname`
  ];
  const result=[];for(const q of queries)result.push((await c.query(q)).rows);return result;
}
async function assertFinancialSchema(c) {
  for(const name of ['payment_operation_in_flight','payment_capture_settlement_fence','payment_release_conflict']) {
    assert.equal((await c.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='siton' AND p.proname=$1`,[name])).rows[0].n,1,name);
  }
  assert.equal((await c.query("SELECT siton.is_valid_money_transition('ChargeAttempt','AuthReleased') AS ok")).rows[0].ok,true);
  const columns=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='siton' AND table_name='payment_attempts'")).rows.map(r=>r.column_name);
  for(const name of ['dispatch_state','owner_event_uuid','owner_lease_generation','settlement_horizon_at','failure_evidence','negative_finality_authoritative'])assert.ok(columns.includes(name),name);
}
async function main() {
  const base = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(base.hostname),'local databases only');
  const oldManifest = git('show', BASE+':scripts/migration_manifest.cjs').toString('utf8');
  // Evaluate only the pinned, repository-owned manifest in a CommonJS module.
  const Module = require('node:module'); const loaded = new Module(path.resolve('scripts/.r9c-master-manifest.cjs'));
  loaded.filename = path.resolve('scripts/.r9c-master-manifest.cjs'); loaded.paths = module.paths; loaded._compile(oldManifest,loaded.filename);
  const old = loaded.exports.MIGRATIONS;
  const added = MIGRATIONS.slice(old.length);
  assert.equal(old.length,59);assert.deepEqual(MIGRATIONS.slice(0,old.length),old);
  assert.deepEqual(added.map(m=>[m.id,m.position]),[['067',60],['068',61]]);
  assert.equal(old.at(-1).id,'066');
  for(const m of old)assert.equal(sqlBody(m).replace(/\r\n/g,'\n'),git('show',BASE+':src/migrations/'+m.filename).toString('utf8').replace(/\r\n/g,'\n'),'historical migration changed: '+m.id);
  for(const [oldId,m] of [['063',added[0]],['064',added[1]]]) {
    const reviewed=git('show',SOURCE+':src/migrations/'+m.filename.replace(m.id,oldId));
    // Commit blobs must be identical. A Windows checkout may change line endings;
    // the runner still hashes the exact local bytes and never rewrites an old ledger.
    assert.deepEqual(git('show','HEAD:src/migrations/'+m.filename),reviewed,'reviewed SQL blob bytes changed');
    assert.equal(sqlBody(m).replace(/\r\n/g,'\n'),reviewed.toString('utf8').replace(/\r\n/g,'\n'),'reviewed SQL content changed');
  }
  const adminUrl=new URL(base);adminUrl.pathname='/postgres';const admin=new Client({connectionString:adminUrl.toString()});await admin.connect();
  const names=[];const clients=[];const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'siton-r9c-migration-'));
  async function database(kind){const name='siton_r9c_'+kind+'_'+process.pid+'_'+Date.now();await admin.query('CREATE DATABASE "'+name+'"');names.push(name);const u=new URL(base);u.pathname='/'+name;const c=new Client({connectionString:u.toString()});await c.connect();clients.push(c);return {c,url:u.toString()};}
  try {
    const fresh=await database('fresh');await runMigrations(fresh.url);await assertFinancialSchema(fresh.c);
    const freshLedger=await ledger(fresh.c);await runMigrations(fresh.url);assert.deepEqual(await ledger(fresh.c),freshLedger,'fresh rerun changed ledger');
    const freshSchema=await schema(fresh.c);
    console.log('FRESH_DB_PROOF PASS migrations=61 rerun=PASS ledger_unchanged=YES');
    const upgrade=await database('upgrade');await runMigrations(upgrade.url,{migrations:old});const before=await ledger(upgrade.c);
    // A session-local sentinel survives the upgrade without adding a canonical object.
    await upgrade.c.query('CREATE TEMP TABLE r9c_upgrade_sentinel(value int PRIMARY KEY)');await upgrade.c.query('INSERT INTO r9c_upgrade_sentinel VALUES (42)');
    // Preserve representative durable master product data too.
    const seller='10000000-0000-4000-8000-000000000066';
    await upgrade.c.query("INSERT INTO siton.seller_accounts(seller_id,display_name) VALUES ($1,'R9C upgrade sentinel') ON CONFLICT DO NOTHING",[seller]);
    const sellerBefore=(await upgrade.c.query('SELECT * FROM siton.seller_accounts WHERE seller_id=$1',[seller])).rows;
    // Real pre-R9C rows: the upgrade must preserve their truth and keep legacy negatives fenced.
    const deal='20000000-0000-4000-8000-000000000066';
    await upgrade.c.query("INSERT INTO siton.deals(deal_id,seller_id,state,title,price_per_unit,min_units,max_units,threshold_units,deadline,list_price_per_unit) VALUES ($1,$2,'Charging','R9C master upgrade',42,1,3,1,now()+interval '1 day',50)",[deal,seller]);
    const legacy=[
      ['30000000-0000-4000-8000-000000000066','permanent_fail','ChargeFailedCompletion','ChargeFailedRecovery'],
      ['30000000-0000-4000-8000-000000000067','unknown','ChargingAttempt','ChargeAttempt'],
      ['30000000-0000-4000-8000-000000000068','success','ChargedSuccess','ChargedSuccess']
    ];
    for(const [id,result,buyer,money] of legacy){
      await upgrade.c.query('INSERT INTO siton.participants(participant_id,deal_id,buyer_id,qty,buyer_state,money_state,delivery_cost) VALUES ($1,$2,$3,1,$4,$5,5)',[id,deal,'upgrade-'+id,buyer,money]);
      await upgrade.c.query("INSERT INTO siton.payment_attempts(participant_id,deal_id,attempt_type,result_class,correlation_id) VALUES ($1,$2,'charge_start',$3,$4)",[id,deal,result,'legacy-'+id]);
    }
    const participantsBefore=(await upgrade.c.query('SELECT * FROM siton.participants WHERE deal_id=$1 ORDER BY participant_id',[deal])).rows;
    const dealBefore=(await upgrade.c.query('SELECT * FROM siton.deals WHERE deal_id=$1',[deal])).rows;
    await runMigrations(upgrade.url,{migrations:added}); // ONLY newly appended R9C SQL
    await assertFinancialSchema(upgrade.c);
    assert.deepEqual((await ledger(upgrade.c)).slice(0,old.length),before,'master ledger rewritten');
    assert.equal((await upgrade.c.query('SELECT value FROM r9c_upgrade_sentinel')).rows[0].value,42);
    assert.deepEqual((await upgrade.c.query('SELECT * FROM siton.seller_accounts WHERE seller_id=$1',[seller])).rows,sellerBefore,'master data changed');
    assert.deepEqual((await upgrade.c.query('SELECT * FROM siton.participants WHERE deal_id=$1 ORDER BY participant_id',[deal])).rows,participantsBefore,'legacy canonical participants changed');
    assert.deepEqual((await upgrade.c.query('SELECT * FROM siton.deals WHERE deal_id=$1',[deal])).rows,dealBefore,'master 065 list price/deal changed');
    for(const [id,result] of legacy){
      const row=(await upgrade.c.query('SELECT * FROM siton.payment_attempts WHERE participant_id=$1',[id])).rows[0];
      assert.equal(row.result_class,result);assert.equal(row.dispatch_state,'responded');assert.equal(row.settlement_horizon_at,null);assert.equal(row.negative_finality_authoritative,null);
      assert.equal(row.resolved_at===null,result==='unknown');
    }
    assert.equal((await upgrade.c.query("SELECT siton.payment_capture_settlement_fence($1,$2)='infinity'::timestamptz AS fenced",[legacy[0][0],deal])).rows[0].fenced,true,'legacy negative must remain permanently fenced');
    console.log('LEGACY_UPGRADE_PROOF PASS rows=3 outcomes=permanent_fail,unknown,success canonical_states_preserved=YES legacy_negative_fenced=YES master_065_list_price_preserved=YES');
    assert.deepEqual(await schema(upgrade.c),freshSchema,'fresh and upgraded schema differ');
    const after=await ledger(upgrade.c);await runMigrations(upgrade.url);assert.deepEqual(await ledger(upgrade.c),after,'upgrade rerun changed ledger');
    // Exercise SQL idempotency itself, independent of ledger skip behavior.
    for(const m of added)await upgrade.c.query(sqlBody(m));
    assert.deepEqual(await schema(upgrade.c),freshSchema,'raw SQL rerun changed schema');
    assert.deepEqual(await ledger(upgrade.c),after,'raw SQL rerun changed ledger');
    // A different on-disk historical checksum must be rejected, never repaired.
    const first=old[0];fs.writeFileSync(path.join(scratch,first.filename),sqlBody(first)+'\n-- deliberate checksum probe\n');
    await assert.rejects(runMigrations(upgrade.url,{migrations:[first],migrationsDir:scratch}),/migration checksum mismatch: 014/);
    assert.deepEqual(await ledger(upgrade.c),after,'checksum rejection rewrote ledger');
    for(const m of MIGRATIONS)assert.equal(after.find(r=>r.migration_id===m.id).checksum_sha256,checksum(sqlBody(m)));
    console.log('CURRENT_MASTER_UPGRADE_PROOF PASS base='+BASE+' upgrade=59->61 applied_only=067,068 master_ledger_unchanged=YES master_data_preserved=YES schema_matches_fresh=YES full_rerun=PASS raw_sql_rerun=PASS checksum_mismatch=REJECTED');
    console.log('MIGRATION_SQL_SEMANTICS_PRESERVED=YES reviewed_blob_bytes_equal=YES migration_065_unchanged=YES hosted_changes=0');
  } finally {
    for(const c of clients)await c.end();for(const name of names)await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');await admin.end();
    // Only the exact temporary file and empty directory created above are removed.
    const file=path.join(scratch,old[0].filename);if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(scratch);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
