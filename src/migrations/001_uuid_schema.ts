import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running migration 001_uuid_schema: resetting dev schema to UUID-only');
    await client.query('BEGIN');

    // Drop tables if exist (dev reset)
    await client.query('DROP TABLE IF EXISTS idempotency_log CASCADE');
    await client.query('DROP TABLE IF EXISTS outbox_events CASCADE');
    await client.query('DROP TABLE IF EXISTS participants CASCADE');
    await client.query('DROP TABLE IF EXISTS deals CASCADE');

    // Create deals table with canonical uuid primary key
    await client.query(`
      CREATE TABLE deals (
        deal_uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text,
        units_sold integer DEFAULT 0 NOT NULL,
        max_units integer,
        status text DEFAULT 'open' NOT NULL,
        deadline timestamptz,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )
    `);

    // Create participants table
    await client.query(`
      CREATE TABLE participants (
        participant_uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_uuid uuid NOT NULL REFERENCES deals(deal_uuid) ON DELETE CASCADE,
        qty integer NOT NULL,
        idempotency_key text,
        buyer_id text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )
    `);

    // Outbox events
    await client.query(`
      CREATE TABLE outbox_events (
        event_uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_id uuid NOT NULL,
        aggregate_type text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz DEFAULT now(),
        sent boolean DEFAULT false NOT NULL
      )
    `);

    // Idempotency keys
    await client.query(`
      CREATE TABLE idempotency_log (
        id text PRIMARY KEY,
        endpoint text NOT NULL,
        request_hash text,
        response jsonb,
        created_at timestamptz DEFAULT now()
      )
    `);

    // Indexes
    await client.query('CREATE INDEX idx_participants_deal_uuid ON participants(deal_uuid)');
    await client.query("CREATE INDEX idx_deals_state ON deals(status)");
    await client.query('CREATE INDEX idx_outbox_sent ON outbox_events(sent)');

    // Insert sample deal
    const dr = await client.query("SELECT COUNT(*) as c FROM deals");
    if (Number(dr.rows[0].c) === 0) {
      const r = await client.query("INSERT INTO deals (title, max_units) VALUES ($1,$2) RETURNING deal_uuid", ['Sample Deal', 10]);
      console.log('Inserted sample deal', r.rows[0]);
    }

    await client.query('COMMIT');
    console.log('Migration 001 complete');
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('Migration failed', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e)=>{ console.error(e); process.exit(1); });
