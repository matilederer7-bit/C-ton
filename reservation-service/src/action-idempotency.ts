import { createHash } from "node:crypto";
import pg from "pg";
import { ReservationError } from "./store.js";

const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function requireKey(value: unknown) {
  const text = String(value || "").trim();
  if (!text || text.length > 200) throw new ReservationError(400, "invalid_idempotency_key", "idempotency_key is required and must be at most 200 characters");
  return text;
}

function requestHash(payload: unknown) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function replayStored(row: any) {
  const statusCode = Number(row.response_status || 200);
  const response = row.canonical_response || {};
  if (statusCode >= 400) {
    throw new ReservationError(statusCode, String(response.code || "idempotent_error"), String(response.error || "idempotent action failed"), response.details || undefined);
  }
  return response;
}

export async function runIdempotentDealAction<T extends Record<string, unknown>>(args: {
  pool: PoolType;
  operation: "sync" | "close";
  dealId: string;
  idempotencyKey: unknown;
  requestPayload: Record<string, unknown>;
  execute: () => Promise<T>;
}) {
  const key = requireKey(args.idempotencyKey);
  const hash = requestHash(args.requestPayload);
  const advisoryName = `siton_inventory:${args.operation}:${args.dealId}:${key}`;
  const lockClient = await args.pool.connect();

  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtextextended($1,0))`, [advisoryName]);

    const current = await lockClient.query(
      `SELECT request_hash,status,response_status,canonical_response
         FROM siton_inventory.inventory_action_idempotency
        WHERE operation=$1 AND deal_id=$2 AND idempotency_key=$3`,
      [args.operation, args.dealId, key]
    );

    if (current.rowCount) {
      const row = current.rows[0];
      if (String(row.request_hash) !== hash) {
        throw new ReservationError(409, "idempotency_payload_mismatch", "idempotency key was already used with a different payload");
      }
      if (String(row.status) === "completed") return replayStored(row) as T;
      await lockClient.query(
        `UPDATE siton_inventory.inventory_action_idempotency
            SET lease_until=now()+interval '30 seconds', updated_at=now()
          WHERE operation=$1 AND deal_id=$2 AND idempotency_key=$3 AND status='processing'`,
        [args.operation, args.dealId, key]
      );
    } else {
      await lockClient.query(
        `INSERT INTO siton_inventory.inventory_action_idempotency
          (operation,deal_id,idempotency_key,request_hash,status,lease_until,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'processing',now()+interval '30 seconds',now(),now())`,
        [args.operation, args.dealId, key, hash]
      );
    }

    try {
      const raw = await args.execute();
      const canonical = { ...raw, replay: false } as Record<string, unknown>;
      await lockClient.query(
        `UPDATE siton_inventory.inventory_action_idempotency
            SET status='completed',response_status=200,canonical_response=$4,lease_until=now(),updated_at=now()
          WHERE operation=$1 AND deal_id=$2 AND idempotency_key=$3`,
        [args.operation, args.dealId, key, JSON.stringify(canonical)]
      );
      return canonical as T;
    } catch (error: any) {
      if (error instanceof ReservationError && error.statusCode >= 400 && error.statusCode < 500) {
        const canonical = { ok: false, error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) };
        await lockClient.query(
          `UPDATE siton_inventory.inventory_action_idempotency
              SET status='completed',response_status=$4,canonical_response=$5,lease_until=now(),updated_at=now()
            WHERE operation=$1 AND deal_id=$2 AND idempotency_key=$3`,
          [args.operation, args.dealId, key, error.statusCode, JSON.stringify(canonical)]
        );
      } else {
        await lockClient.query(
          `DELETE FROM siton_inventory.inventory_action_idempotency
            WHERE operation=$1 AND deal_id=$2 AND idempotency_key=$3 AND status='processing'`,
          [args.operation, args.dealId, key]
        ).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [advisoryName]).catch(() => undefined);
    lockClient.release();
  }
}
