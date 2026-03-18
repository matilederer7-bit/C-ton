require('dotenv').config();
const { Client } = require('pg');

(async () => {
  try {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    console.log('Running select from outbox_events');
    const r = await client.query('SELECT event_uuid, event_type, payload FROM outbox_events WHERE sent = false ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED');
    console.log('Query succeeded, rows:', r.rowCount);
    await client.end();
  } catch (e) {
    console.error('Query error:', e);
    process.exit(1);
  }
})();
