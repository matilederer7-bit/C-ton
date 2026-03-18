import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/c-ton';

export const pool = new Pool({ connectionString });

// Ensure each new connection uses the public schema regardless of server defaults
pool.on('connect', (client) => {
  // best-effort: do not await here, errors will surface on first query
  client.query("SET search_path TO public").catch(()=>{});
  // decorate client.query so all pooled clients log SQL for debugging
  const orig = client.query.bind(client);
  client.query = async function (text: any, params?: any) {
    try {
      console.log('[db.query]', text, params ?? []);
      return await orig(text, params);
    } catch (err: any) {
      console.error('[db.query.error]', text, params ?? [], err?.message ?? err, '\ncaller stack:', new Error().stack);
      throw err;
    }
  } as any;
});

export async function withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // decorate client.query to log queries and errors (temporary, for debugging)
  const origQuery = client.query.bind(client);
  client.query = async function (text: any, params?: any) {
    try {
      console.log('[db.query]', text, params ?? []);
      const res = await origQuery(text, params);
      return res;
    } catch (err: any) {
      console.error('[db.query.error]', text, params ?? [], err?.message ?? err, '\ncaller stack:', new Error().stack);
      throw err;
    }
  } as any;

  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally {
    client.release();
  }
}

export default pool;
