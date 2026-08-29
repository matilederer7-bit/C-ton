import { Pool } from "pg";
import { DATABASE_URL, DB_SCHEMA, DEBUG_SQL_LOGGING } from "./runtime_config.js";

if (!/^[a-z_][a-z0-9_]*$/.test(DB_SCHEMA)) {
  throw new Error("DB_SCHEMA must be a valid PostgreSQL identifier");
}

export function createRuntimePool(kind: "web" | "worker" = "web", max?: number) {
  const runtimePool = new Pool({
    connectionString: DATABASE_URL,
    application_name: `siton-${kind}-runtime`,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: process.env.NODE_ENV === "test" ? 100 : 30_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    ...(max ? { max } : {})
  });

  runtimePool.on("connect", decorateClientQuery);
  return runtimePool;
}

export const pool = createRuntimePool("web");

function decorateClientQuery(client: any) {
  if (!DEBUG_SQL_LOGGING || client.__sqlLoggingWrapped) return;

  const originalQuery = client.query.bind(client);
  client.query = async function (...args: any[]) {
    const startedAt = Date.now();
    try {
      const result = await originalQuery(...args);
      console.log("[db.query]", { duration_ms: Date.now() - startedAt });
      return result;
    } catch (err: any) {
      console.error("[db.query.error]", {
        duration_ms: Date.now() - startedAt,
        code: String(err?.code || "unknown")
      });
      throw err;
    }
  } as any;
  client.__sqlLoggingWrapped = true;
}

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

