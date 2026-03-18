require('dotenv').config();
const { Client } = require('pg');

(async () => {
  try {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error('DATABASE_URL not set');
      process.exit(1);
    }
    const u = new URL(url);
    const target = u.pathname.replace(/^\/+/, '');
    const admin = target === 'postgres' ? 'template1' : 'postgres';
    const adminUrl = url.replace('/' + target, '/' + admin);
    console.log('Target DB:', target, 'Admin DB used:', admin);
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    await client.query('DROP DATABASE IF EXISTS "' + target + '"');
    console.log('Dropped', target);
    await client.query('CREATE DATABASE "' + target + '"');
    console.log('Created', target);
    await client.end();
    process.exit(0);
  } catch (e) {
    console.error('Error during drop/create:', e);
    process.exit(1);
  }
})();
