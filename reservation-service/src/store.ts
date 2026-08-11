import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;
export type PoolType = InstanceType<typeof Pool>;

type DealStatus = "open" | "closed";
type ReservationStatus = "held" | "committed" | "released" | "expired";

export class ReservationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReservationError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface HoldInput {
  deal_id: string;
  qty: number;
  idempotency_key: string;
  request_hash: string;
}

export interface HoldResult {
  ok: true;
  reservation_id: string;
  deal_id: string;
  qty: number;
  status: "held";
  expires_at: string;
  reserved_units: number;
  max_units: number;
  available_units: number;
  replay: boolean;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ReservationError(400, `invalid_${field}`, `${field} must be a positive integer`);
  }
  return number;
}

function requireNonEmpty(value: unknown, field: string, maxLength: number): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) {
    throw new ReservationError(400, `invalid_${field}`, `${field} is required and must be at most ${maxLength} characters`);
  }
  return text;
}

export class ReservationStore {
  constructor(
    readonly pool: PoolType,
    readonly holdTtlSeconds = Number(process.env.HOLD_TTL_SECONDS || 120)
  ) {
    if (!Number.isInteger(this.holdTtlSeconds) || this.holdTtlSeconds < 5 || this.holdTtlSeconds > 900) {
      throw new Error("HOLD_TTL_SECONDS must be an integer between 5 and 900");
    }
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '20s'");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockDeal(client: pg.PoolClient, dealId: string) {
    const result = await client.query(
      `SELECT deal_id, max_units, reserved_units, status
         FROM siton_inventory.inventory_deals
        WHERE deal_id=$1
        FOR UPDATE`,
      [dealId]
    );
    if (!result.rowCount) throw new ReservationError(404, "inventory_deal_not_found", "inventory deal not found");
    return result.rows[0] as { deal_id: string; max_units: number; reserved_units: number; status: DealStatus };
  }

  private async reclaimExpired(client: pg.PoolClient, dealId: string): Promise<number> {
    const expired = await client.query(
      `UPDATE siton_inventory.inventory_reservations
          SET status='expired', expired_at=now()
        WHERE deal_id=$1 AND status='held' AND expires_at <= now()
        RETURNING qty`,
      [dealId]
    );
    const releasedQty = expired.rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
    if (releasedQty > 0) {
      await client.query(
        `UPDATE siton_inventory.inventory_deals
            SET reserved_units=GREATEST(0, reserved_units-$2), updated_at=now()
          WHERE deal_id=$1`,
        [dealId, releasedQty]
      );
    }
    return releasedQty;
  }

  async syncDeal(input: { deal_id: string; max_units: number; status?: DealStatus }) {
    const dealId = requireNonEmpty(input.deal_id, "deal_id", 80);
    const maxUnits = requirePositiveInteger(input.max_units, "max_units");
    const status: DealStatus = input.status === "closed" ? "closed" : "open";
    return this.transaction(async (client) => {
      const existing = await client.query(
        `SELECT deal_id, max_units, reserved_units, status
           FROM siton_inventory.inventory_deals
          WHERE deal_id=$1
          FOR UPDATE`,
        [dealId]
      );
      if (!existing.rowCount) {
        const inserted = await client.query(
          `INSERT INTO siton_inventory.inventory_deals(deal_id,max_units,reserved_units,status)
           VALUES ($1,$2,0,$3)
           RETURNING deal_id,max_units,reserved_units,status`,
          [dealId, maxUnits, status]
        );
        return { ok: true, ...inserted.rows[0], created: true };
      }
      const row = existing.rows[0];
      if (Number(row.max_units) !== maxUnits) {
        throw new ReservationError(409, "inventory_max_units_immutable", "max_units cannot change after inventory sync", {
          existing_max_units: Number(row.max_units), requested_max_units: maxUnits
        });
      }
      await client.query(
        `UPDATE siton_inventory.inventory_deals SET status=$2, updated_at=now() WHERE deal_id=$1`,
        [dealId, status]
      );
      return { ok: true, deal_id: dealId, max_units: maxUnits, reserved_units: Number(row.reserved_units), status, created: false };
    });
  }

  async hold(input: HoldInput): Promise<HoldResult> {
    const dealId = requireNonEmpty(input.deal_id, "deal_id", 80);
    const qty = requirePositiveInteger(input.qty, "qty");
    const idempotencyKey = requireNonEmpty(input.idempotency_key, "idempotency_key", 200);
    const requestHash = requireNonEmpty(input.request_hash, "request_hash", 128);

    return this.transaction(async (client) => {
      let deal = await this.lockDeal(client, dealId);
      await this.reclaimExpired(client, dealId);
      deal = await this.lockDeal(client, dealId);
      if (deal.status !== "open") throw new ReservationError(409, "inventory_deal_closed", "deal inventory is closed");

      const prior = await client.query(
        `SELECT reservation_id, request_hash, qty, status, expires_at, canonical_response
           FROM siton_inventory.inventory_reservations
          WHERE deal_id=$1 AND idempotency_key=$2`,
        [dealId, idempotencyKey]
      );
      if (prior.rowCount) {
        const row = prior.rows[0] as { request_hash: string; status: ReservationStatus; canonical_response: HoldResult };
        if (String(row.request_hash) !== requestHash) {
          throw new ReservationError(409, "idempotency_payload_mismatch", "idempotency key was already used with a different payload");
        }
        if (row.status === "held" || row.status === "committed") {
          return { ...row.canonical_response, replay: true };
        }
        throw new ReservationError(409, `reservation_${row.status}`, `reservation is already ${row.status}`);
      }

      const remaining = Number(deal.max_units) - Number(deal.reserved_units);
      if (qty > remaining) {
        throw new ReservationError(409, "inventory_exhausted", "requested quantity exceeds available inventory", {
          requested_qty: qty,
          available_units: Math.max(0, remaining)
        });
      }

      const reservationId = randomUUID();
      const expiresAt = new Date(Date.now() + this.holdTtlSeconds * 1000).toISOString();
      const nextReserved = Number(deal.reserved_units) + qty;
      const response: HoldResult = {
        ok: true,
        reservation_id: reservationId,
        deal_id: dealId,
        qty,
        status: "held",
        expires_at: expiresAt,
        reserved_units: nextReserved,
        max_units: Number(deal.max_units),
        available_units: Number(deal.max_units) - nextReserved,
        replay: false
      };

      await client.query(
        `INSERT INTO siton_inventory.inventory_reservations
          (reservation_id,deal_id,idempotency_key,request_hash,qty,status,expires_at,canonical_response)
         VALUES ($1,$2,$3,$4,$5,'held',$6,$7)`,
        [reservationId, dealId, idempotencyKey, requestHash, qty, expiresAt, JSON.stringify(response)]
      );
      const updated = await client.query(
        `UPDATE siton_inventory.inventory_deals
            SET reserved_units=reserved_units+$2, updated_at=now()
          WHERE deal_id=$1 AND reserved_units+$2 <= max_units
          RETURNING reserved_units,max_units`,
        [dealId, qty]
      );
      if (updated.rowCount !== 1) {
        throw new ReservationError(409, "inventory_exhausted", "inventory ceiling rejected reservation");
      }
      return response;
    });
  }

  async commitReservation(reservationIdInput: unknown) {
    const reservationId = requireNonEmpty(reservationIdInput, "reservation_id", 80);
    return this.transaction(async (client) => {
      const lookup = await client.query(`SELECT deal_id FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`, [reservationId]);
      if (!lookup.rowCount) throw new ReservationError(404, "reservation_not_found", "reservation not found");
      const dealId = String(lookup.rows[0].deal_id);
      await this.lockDeal(client, dealId);
      await this.reclaimExpired(client, dealId);
      const result = await client.query(
        `SELECT reservation_id,deal_id,qty,status,expires_at
           FROM siton_inventory.inventory_reservations
          WHERE reservation_id=$1
          FOR UPDATE`,
        [reservationId]
      );
      const row = result.rows[0] as { reservation_id: string; deal_id: string; qty: number; status: ReservationStatus; expires_at: string };
      if (row.status === "committed") return { ok: true, reservation_id: reservationId, status: "committed", replay: true };
      if (row.status !== "held") throw new ReservationError(409, `reservation_${row.status}`, `reservation is already ${row.status}`);
      const updated = await client.query(
        `UPDATE siton_inventory.inventory_reservations
            SET status='committed', committed_at=now()
          WHERE reservation_id=$1 AND status='held'
          RETURNING reservation_id`,
        [reservationId]
      );
      if (updated.rowCount !== 1) throw new ReservationError(409, "reservation_state_conflict", "reservation state changed concurrently");
      return { ok: true, reservation_id: reservationId, status: "committed", replay: false };
    });
  }

  async releaseReservation(reservationIdInput: unknown) {
    const reservationId = requireNonEmpty(reservationIdInput, "reservation_id", 80);
    return this.transaction(async (client) => {
      const lookup = await client.query(`SELECT deal_id FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`, [reservationId]);
      if (!lookup.rowCount) throw new ReservationError(404, "reservation_not_found", "reservation not found");
      const dealId = String(lookup.rows[0].deal_id);
      await this.lockDeal(client, dealId);
      await this.reclaimExpired(client, dealId);
      const result = await client.query(
        `SELECT reservation_id,deal_id,qty,status
           FROM siton_inventory.inventory_reservations
          WHERE reservation_id=$1
          FOR UPDATE`,
        [reservationId]
      );
      const row = result.rows[0] as { qty: number; status: ReservationStatus };
      if (row.status === "released") return { ok: true, reservation_id: reservationId, status: "released", replay: true };
      if (row.status === "committed") throw new ReservationError(409, "reservation_already_committed", "committed reservation cannot be released by the pre-commit compensation path");
      if (row.status === "expired") throw new ReservationError(409, "reservation_expired", "reservation already expired");
      const updated = await client.query(
        `UPDATE siton_inventory.inventory_reservations
            SET status='released', released_at=now()
          WHERE reservation_id=$1 AND status='held'
          RETURNING qty`,
        [reservationId]
      );
      if (updated.rowCount !== 1) throw new ReservationError(409, "reservation_state_conflict", "reservation state changed concurrently");
      await client.query(
        `UPDATE siton_inventory.inventory_deals
            SET reserved_units=GREATEST(0,reserved_units-$2), updated_at=now()
          WHERE deal_id=$1`,
        [dealId, Number(updated.rows[0].qty)]
      );
      return { ok: true, reservation_id: reservationId, status: "released", replay: false };
    });
  }

  async inventory(dealIdInput: unknown) {
    const dealId = requireNonEmpty(dealIdInput, "deal_id", 80);
    return this.transaction(async (client) => {
      let deal = await this.lockDeal(client, dealId);
      await this.reclaimExpired(client, dealId);
      deal = await this.lockDeal(client, dealId);
      return {
        ok: true,
        deal_id: dealId,
        status: deal.status,
        max_units: Number(deal.max_units),
        reserved_units: Number(deal.reserved_units),
        available_units: Number(deal.max_units) - Number(deal.reserved_units)
      };
    });
  }
}
