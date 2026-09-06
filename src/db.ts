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

  runtimePool.on("connect", (client: any) => {
    decorateClientQuery(client);
    attachClientErrorGuard(client, kind);
  });
  runtimePool.on("error", (err: any) => {
    // Idle pooled connections can be terminated by the server (failover,
    // restart, administrator command). That must degrade to readiness
    // failures on the next query, never crash the process.
    console.error("[db.pool.error]", {
      kind,
      code: String(err?.code || "unknown")
    });
  });
  return runtimePool;
}

// The shared application pool is labeled by the declared runtime role so a
// Worker deployment identifies itself as siton-worker-runtime in
// pg_stat_activity instead of masquerading as the Web pool.
export const pool = createRuntimePool(
  String(process.env.RUNTIME_ROLE || "").toLowerCase() === "worker" ? "worker" : "web"
);

// pg-pool listens for a client's 'error' event only while that client is IDLE in
// the pool: it removes its listener on checkout and re-adds it on release. A
// backend termination (failover, restart, administrator command, idle-in-
// transaction timeout) that lands while the client is CHECKED OUT — between two
// statements of a transaction, or mid-statement — therefore emits 'error' with
// no listener, and Node turns that into an uncaught exception that kills the
// whole Web or Worker process. This guard is attached once per physical
// connection and never removed; it only records and logs. The failure still
// surfaces exactly where it belongs: the owning transaction's statement rejects
// (pg marks the client not queryable), withTx rolls back and rethrows, and
// pg-pool discards the dead client on release. Nothing is retried, nothing is
// reported committed that was not. Proof: tests/db_client_error_process_survival_validation.ts.
type ClientErrorObservation = { at: string; kind: string; code: string; pid: number | null };
const clientErrorObservations: ClientErrorObservation[] = [];
const CLIENT_ERROR_OBSERVATION_LIMIT = 200;

function attachClientErrorGuard(client: any, kind: string) {
  if (!client || client.__sitonClientErrorGuard) return;
  client.__sitonClientErrorGuard = true;
  client.on("error", (err: any) => {
    const observation = {
      at: new Date().toISOString(),
      kind,
      code: String(err?.code || err?.message || "unknown"),
      pid: typeof client.processID === "number" ? client.processID : null
    };
    clientErrorObservations.push(observation);
    if (clientErrorObservations.length > CLIENT_ERROR_OBSERVATION_LIMIT) clientErrorObservations.shift();
    console.error("[db.client.error]", JSON.stringify(observation));
  });
}

// Read-only view for tests and diagnostics: which checked-out or idle clients
// emitted connection errors since process start (bounded, newest last).
export function dbClientErrorObservations(): ReadonlyArray<ClientErrorObservation> {
  return clientErrorObservations.slice();
}

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

