require('dotenv').config();
const { Client } = require('pg');

(async () => {
  try {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const cur = await client.query('SELECT current_database() as db');
    console.log('Connected to DB:', cur.rows[0].db);

    const tables = await client.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
    console.log('Public tables:');
    tables.rows.forEach(r => console.log(' -', r.table_name));

    const siton = await client.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name='siton'");
    console.log('Siton schema exists:', siton.rowCount > 0);

    let funcs = { rowCount: 0 };
    try {
      funcs = await client.query("SELECT n.nspname, p.proname, pg_get_functiondef(p.oid) as def FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE pg_get_functiondef(p.oid) ILIKE '%siton%'");
    } catch (e) {
      console.error('pg_get_functiondef query error (ignored):', e.message);
    }
    console.log('Functions containing "siton":', funcs.rowCount);
    if (funcs.rowCount > 0) funcs.rows.forEach(r => console.log(' -', r.nspname + '.' + r.proname));

    let triggers = { rowCount: 0 };
    try {
      triggers = await client.query("SELECT tgname, tgrelid::regclass::text as table, pg_get_triggerdef(oid) as def FROM pg_trigger WHERE pg_get_triggerdef(oid) ILIKE '%siton%'");
    } catch (e) {
      console.error('pg_get_triggerdef query error (ignored):', e.message);
    }
    console.log('Triggers containing "siton":', triggers.rowCount);
    if (triggers.rowCount > 0) triggers.rows.forEach(r => console.log(' -', r.table + ' -> ' + r.tgname));

    await client.end();
    process.exit(0);
  } catch (e) {
    console.error('Inspect DB error:', e);
    process.exit(1);
  }
})();
