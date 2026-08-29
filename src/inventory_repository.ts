import { createHash } from "node:crypto";

export type InventoryQueryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type InventoryResult = Record<string, unknown> & { ok: true };

export class InventoryRepositoryError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(result: Record<string, unknown>) {
    super(String(result.message || "canonical inventory operation failed"));
    this.name = "InventoryRepositoryError";
    this.statusCode = Number(result.http_status || 500);
    this.code = String(result.code || "inventory_operation_failed");
    this.details = result.details ?? null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function inventorySha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function canonicalInventoryKey(purpose: string, parts: unknown): string {
  return `${purpose}:${inventorySha256(parts)}`;
}

async function callInventory(
  db: InventoryQueryable,
  operation: string,
  payload: Record<string, unknown>
): Promise<InventoryResult> {
  const result = await db.query(
    "SELECT public.siton_inventory_rpc($1, $2::jsonb) AS result",
    [operation, JSON.stringify(payload)]
  );
  const value = result.rows[0]?.result as Record<string, unknown> | undefined;
  if (!value || value.ok !== true) throw new InventoryRepositoryError(value || {});
  return value as InventoryResult;
}

export function buildInventoryRepository(db: InventoryQueryable) {
  return {
    probe: () => callInventory(db, "probe", {}),

    sync: (input: { dealId: string; maxUnits: number; minUnits: number; idempotencyKey: string }) => {
      const canonical = {
        deal_id: input.dealId,
        max_units: input.maxUnits,
        min_units: input.minUnits,
        idempotency_key: input.idempotencyKey
      };
      return callInventory(db, "sync", {
        ...canonical,
        _action_request_hash: inventorySha256(canonical)
      });
    },

    close: (input: { dealId: string; maxUnits: number; idempotencyKey: string }) => {
      const canonical = {
        deal_id: input.dealId,
        max_units: input.maxUnits,
        idempotency_key: input.idempotencyKey
      };
      return callInventory(db, "close", {
        ...canonical,
        _action_request_hash: inventorySha256(canonical)
      });
    },

    hold: (input: { dealId: string; qty: number; idempotencyKey: string; requestHash: string }) =>
      callInventory(db, "hold", {
        deal_id: input.dealId,
        qty: input.qty,
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash
      }),

    commit: (input: { reservationId: string; authorizationEvidenceHash: string }) =>
      callInventory(db, "commit", {
        reservation_id: input.reservationId,
        authorization_evidence_hash: input.authorizationEvidenceHash
      }),

    release: (input: { reservationId: string }) =>
      callInventory(db, "release", { reservation_id: input.reservationId }),

    lookup: (input: { dealId: string; idempotencyKey: string }) =>
      callInventory(db, "lookup", {
        deal_id: input.dealId,
        idempotency_key: input.idempotencyKey
      }),

    reservationStatus: (input: { reservationId: string }) =>
      callInventory(db, "reservation_status", { reservation_id: input.reservationId }),

    status: (input: { dealId: string }) =>
      callInventory(db, "status", { deal_id: input.dealId })
  };
}
