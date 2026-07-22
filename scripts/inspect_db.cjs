const { Client } = require("pg");
require("dotenv").config({ quiet: true });

async function inspect(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const database = (await client.query("SELECT current_database() AS name")).rows[0].name;
    const schemas = (await client.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
       ORDER BY schema_name`
    )).rows;
    const tables = (await client.query(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_type='BASE TABLE' AND table_schema NOT LIKE 'pg_%'
       AND table_schema <> 'information_schema' ORDER BY table_schema, table_name`
    )).rows;
    const columns = (await client.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM information_schema.columns WHERE table_schema='siton'
       ORDER BY table_name, ordinal_position`
    )).rows;
    const indexes = (await client.query(
      `SELECT schemaname AS table_schema, tablename AS table_name, indexname, indexdef
       FROM pg_indexes WHERE schemaname='siton' ORDER BY tablename,indexname`
    )).rows;
    const constraints = (await client.query(
      `SELECT n.nspname AS table_schema,c.relname AS table_name,con.conname,
              con.contype,pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='siton' ORDER BY c.relname,con.conname`
    )).rows;
    const foreignKeys = constraints.filter((row) => row.contype === "f");
    const functions = (await client.query(
      `SELECT n.nspname AS function_schema,p.proname AS function_name,
              pg_get_function_identity_arguments(p.oid) AS arguments
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='siton' ORDER BY p.proname`
    )).rows;
    const triggers = (await client.query(
      `SELECT n.nspname AS table_schema,c.relname AS table_name,t.tgname AS trigger_name,
              pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='siton' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`
    )).rows;
    const ledgerExists = tables.some((row) => row.table_schema === "siton" && row.table_name === "migration_ledger");
    if (!ledgerExists) throw new Error("siton.migration_ledger is missing");
    const ledger = (await client.query(
      `SELECT migration_id,position,filename,checksum_sha256,started_at,completed_at,status,error_message
       FROM siton.migration_ledger ORDER BY position`
    )).rows;
    const result = { database, schemas, tables, columns, indexes, constraints, foreign_keys: foreignKeys, functions, triggers, migration_ledger: ledger };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  inspect().catch((error) => {
    console.error(`DB_INSPECTION_FAILED ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { inspect };
