// Local disposable PostgreSQL only. No .env is loaded: supply DATABASE_URL explicitly.
const { Client } = require('pg');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const suites = [
  'seller_pickup_fulfillment_validation', 'pickup_fulfillment_concurrency_validation',
  'seller_fulfillment_security_validation', 'seller_shipping_export_validation',
  'seller_deal_excel_export_validation', 'seller_delivery_excel_export_validation',
  'deal_types_e2e_validation', 'p03_pause_reopen_business_profile_validation',
  'seller_lifecycle_route_authority_validation', 'seller_onboarding_validation',
  'concurrency_proof', 'outbox_worker_recovery_validation',
  'outbox_worker_failure_recovery_validation', 'worker_two_process_fencing_validation',
  'worker_separation_validation', 'buyer_feedback_support_operations_validation',
  'admin_support_cases_validation', 'admin_control_plane_validation',
  'r6_viral_graph_validation', 'platform_fee_payments_8_percent_validation',
  'money_tax_invoice_canon_validation', 'charging_completion_window_validation',
  'full_e2e_gate_validation', 'read_surfaces_truth_alignment_validation',
  'deal_images_validation', 'p05_admin_viral_support_validation', 'admin_launch_console_validation',
  'seller_cancel_ui_validation'
];
async function main() {
  const base = new URL(process.env.DATABASE_URL || 'invalid:');
  if (!['postgres:', 'postgresql:'].includes(base.protocol) ||
      !['localhost','127.0.0.1','[::1]'].includes(base.hostname) ||
      base.search || process.env.NODE_ENV === 'production' || process.env.RENDER || process.env.APP_ENV === 'production') {
    throw new Error('Pilot harness requires explicit local PostgreSQL and refuses production');
  }
  // Allowlist the child environment: hosted provider credentials are never inherited.
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { NODE_ENV:'test', APP_DEPLOYMENT_MODE:'demo-preview', DISABLE_OUTBOX_WORKER:'1',
    PAYMENT_PROVIDER:'mockpay', PAYMENT_PROVIDER_MODE:'mock-backed', PAYMENT_WEBHOOK_PROVIDER:'mockpay',
    PAYMENT_WEBHOOK_SECRET:'mock-webhook-secret', PAYOUT_PROVIDER:'internal-ledger',
    PAYOUT_PROVIDER_MODE:'internal-truth-only', NOTIFICATION_PROVIDER:'log-only',
    NO_NETWORK_REHEARSAL:'1', LOG_LEVEL:'error', PORT:'0',
    NODE_OPTIONS:`--require=${path.join(root,'scripts/deny_external_network.cjs')}` });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-pilot-'));
  const artifact = path.join(root,'.tmp_pilot_results');
  fs.mkdirSync(artifact,{recursive:true});
  const results = [];
  const only = process.argv.find(arg=>arg.startsWith('--only='))?.slice(7);
  if(only && !suites.includes(only)) throw new Error('Unknown suite selection');
  async function run(label, args, database, extra = {}) {
    const started = Date.now();
    const log = fs.createWriteStream(path.join(artifact,label+'.log'));
    const status = await new Promise((resolve,reject) => {
      const child = spawn(process.execPath,args,{cwd:root,env:{...env,...extra,...(database ? {DATABASE_URL:database} : {})},stdio:['ignore','pipe','pipe'],windowsHide:true});
      child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false});
      const timer = setTimeout(()=>{
        if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        else child.kill('SIGKILL');
      },600000);
      child.on('error',reject); child.on('close',code=>{clearTimeout(timer);log.end();resolve(code);});
    });
    results.push({label,status,duration_ms:Date.now()-started});
    console.log(`PILOT_PHASE ${label} ${status===0?'PASS':'FAIL'} ${Date.now()-started}ms`);
    if(status!==0) throw new Error(`${label} failed; inspect .tmp_pilot_results/${label}.log`);
  }
  const url = name => {const u = new URL(base);u.pathname='/'+name;return u.toString();};
  const admin = new Client({connectionString:url('postgres'),connectionTimeoutMillis:5000});
  const names = [];
  let connected = false;
  const prefix = `siton_pilot_${process.pid}_${Date.now()}`;
  try {
    if (!process.argv.includes('--skip-compile')) await run('typescript',[require.resolve('typescript/bin/tsc'),'-p','tsconfig.test.json']);
    for(const gate of ['backend_enforcement_scan','runtime_ddl_scan','architecture_truth_gate','compliance_payment_scan'])await run(gate,[`scripts/${gate}.cjs`]);
    await admin.connect();
    connected = true;
    const template = prefix+'_template'; names.push(template);
    await admin.query(`CREATE DATABASE "${template}"`);
    await run('migrations',['scripts/run_migrations.cjs'],url(template));
    await run('migration_rerun',['scripts/ci_migration_report.cjs'],url(template));
    await run('prerequisites',['scripts/seed_test_prerequisites.cjs'],url(template));
    if(!only){
      const scenario = prefix+'_day'; names.push(scenario);
      await admin.query(`CREATE DATABASE "${scenario}" TEMPLATE "${template}"`);
      const snapshot = path.join(scratch,'restart.json');
      await run('pilot_day',['scripts/closed_pilot_scenario.cjs','day',snapshot],url(scenario));
      await run('process_restart',['scripts/closed_pilot_scenario.cjs','restart',snapshot],url(scenario));
      await run('worker_day',['scripts/closed_pilot_scenario.cjs','workers',snapshot],url(scenario));
    }
    if (!process.argv.includes('--scenario-only')) {
      for (const [index,suite] of suites.entries()) {
        if(only && suite!==only)continue;
        // Existing fault-injection suites require the canonical isolated-test prefix.
        const name = `siton_test_${process.pid}_${prefix.split('_').at(-1)}_${index}`; names.push(name);
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        try { await run(suite,[`.tmp_test_dist/tests/${suite}.js`],url(name)); }
        catch (error) { console.error(error.message); }
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        names.splice(names.indexOf(name),1);
      }
    }
    if(results.some(r=>r.status!==0)) throw new Error('Pilot campaign has failed assertions; see results.json');
    console.log('PILOT_WAR_GAME_PASS');
  } finally {
    const cleanupErrors=[];
    if(connected)for(const name of names.reverse()) {
      try{await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);}catch(e){cleanupErrors.push(e.message);}
    }
    await admin.end().catch(e=>cleanupErrors.push(e.message));
    fs.rmSync(scratch,{recursive:true,force:true});
    fs.writeFileSync(path.join(artifact,only?`${only}-results.json`:'results.json'),JSON.stringify(results,null,2));
    if(cleanupErrors.length)throw new Error(`Disposable resource cleanup failed: ${cleanupErrors.join('; ')}`);
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
