const assert=require('node:assert/strict');
const fs=require('node:fs'); const {createHash}=require('node:crypto'); const {Client}=require('pg');
const {runMigrations}=require('./run_migrations.cjs'); const {MIGRATIONS}=require('./migration_manifest.cjs');
require('dotenv').config({quiet:true});
const digest=s=>createHash('sha256').update(s.replace(/^\uFEFF/,'')).digest('hex');
(async()=>{
 const base=new URL(process.env.DATABASE_URL); assert.ok(['localhost','127.0.0.1'].includes(base.hostname));
 const admin=new Client({connectionString:base.toString()}); await admin.connect();
 const old=await admin.query("SELECT checksum_sha256 FROM siton.migration_ledger WHERE migration_id='014'");
 const body=fs.readFileSync('src/migrations/014_demo_preview_bootstrap.sql','utf8');
 console.log('LOCAL_014_CHECKSUM '+JSON.stringify({matches_worktree:old.rows[0]?.checksum_sha256===digest(body),matches_lf:old.rows[0]?.checksum_sha256===digest(body.replace(/\r\n/g,'\n')),matches_crlf:old.rows[0]?.checksum_sha256===digest(body.replace(/\r?\n/g,'\r\n'))}));
 const name='siton_final_review_migration_'+process.pid+'_'+Date.now();
 await admin.query('CREATE DATABASE "'+name+'"'); const url=new URL(base); url.pathname='/'+name;
 const c=new Client({connectionString:url.toString()}); await c.connect();
 try {
  const oldChain=MIGRATIONS.filter(m=>!['063','064'].includes(m.id));
  await runMigrations(url.toString(),{migrations:oldChain});
  await c.query("CREATE TABLE siton.final_review_sentinel AS SELECT 42 AS value");
  await runMigrations(url.toString()); await runMigrations(url.toString());
  assert.equal((await c.query('SELECT value FROM siton.final_review_sentinel')).rows[0].value,42);
  assert.equal((await c.query("SELECT count(*)::int n FROM siton.migration_ledger WHERE status='succeeded'")).rows[0].n,MIGRATIONS.length);
  const before=(await c.query("SELECT checksum_sha256 FROM siton.migration_ledger WHERE migration_id='014'")).rows[0].checksum_sha256;
  await c.query("UPDATE siton.migration_ledger SET checksum_sha256=$1 WHERE migration_id='014'",['0'.repeat(64)]);
  await assert.rejects(runMigrations(url.toString()),/checksum mismatch: 014/);
  assert.equal((await c.query("SELECT checksum_sha256 FROM siton.migration_ledger WHERE migration_id='014'")).rows[0].checksum_sha256,'0'.repeat(64));
  await c.query("UPDATE siton.migration_ledger SET checksum_sha256=$1 WHERE migration_id='014'",[before]);
  await runMigrations(url.toString());
  console.log('FINAL_MIGRATION_PROOF PASS upgrade='+oldChain.length+'->'+MIGRATIONS.length+' rerun=PASS sentinel=42 simulated_mismatch=REJECTED ledger_not_normalized=PASS');
 } finally {await c.end(); await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)'); await admin.end();}
})().catch(e=>{console.error(e);process.exitCode=1});
