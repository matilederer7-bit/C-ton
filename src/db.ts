import { Pool } from "pg";
import { DATABASE_URL, DB_SCHEMA, DEBUG_SQL_LOGGING } from "./runtime_config.js";

export const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000
});

function decorateClientQuery(client: any) {
  if (!DEBUG_SQL_LOGGING || client.__sqlLoggingWrapped) return;

  const originalQuery = client.query.bind(client);
  client.query = async function (text: any, params?: any) {
    try {
      console.log("[db.query]", text, params ?? []);
      return await originalQuery(text, params);
    } catch (err: any) {
      console.error("[db.query.error]", text, params ?? [], err?.message ?? err);
      throw err;
    }
  } as any;
  client.__sqlLoggingWrapped = true;
}

pool.on("connect", (client) => {
  client.query(`SET search_path TO ${DB_SCHEMA}, public`).catch(() => {});
  decorateClientQuery(client);
});

export async function withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  decorateClientQuery(client);

  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  decorateClientQuery(client);
  try {
    await client.query("BEGIN");
    const res = await fn(client);
    await client.query("COMMIT");
    return res;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export default pool;
