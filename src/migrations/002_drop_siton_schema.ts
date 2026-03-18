import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    console.log('Dropping schema siton if exists (dev)');
    await client.query('BEGIN');
    await client.query('DROP SCHEMA IF EXISTS siton CASCADE');
    await client.query('COMMIT');
    console.log('Dropped siton schema');
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('Failed to drop siton schema', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e=>{console.error(e); process.exit(1)});
