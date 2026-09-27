// Local lab tool: DROP and re-CREATE the database named in DATABASE_URL.
// Refuses hosted/staging/production targets (scripts/lib/destructive_target_guard.cjs)
// and never prints the connection string.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { assertDestructiveTargetAllowed } = require('./lib/destructive_target_guard.cjs');

(async () => {
  try {
    const url = process.env.DATABASE_URL;
    const { host } = assertDestructiveTargetAllowed(url, { action: 'drop_create_db' });
    const u = new URL(url);
    const target = u.pathname.replace(/^\/+/, '');
    if (!target || target === 'postgres' || target === 'template0' || target === 'template1') {
      throw new Error('drop_create_db refused: will not drop the maintenance database "' + (target || '(none)') + '"');
    }
    u.pathname = '/postgres';
    console.log('Target DB:', target, 'host:', host);
    const client = new Client({ connectionString: u.toString() });
    await client.connect();
    await client.query('DROP DATABASE IF EXISTS "' + target.replace(/"/g, '""') + '"');
    console.log('Dropped', target);
    await client.query('CREATE DATABASE "' + target.replace(/"/g, '""') + '"');
    console.log('Created', target);
    await client.end();
    process.exit(0);
  } catch (e) {
    console.error('drop_create_db:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
