import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;
export type PoolType = InstanceType<typeof Pool>;

type DealStatus = "open" | "closed";
type DealTargetState = "PendingTarget" | "TargetReached";
type ReservationStatus = "held" | "committed" | "released" | "expired";

type LockedDeal = {
  deal_id: string;
  max_units: number;
  min_units: number;
  reserved_units: number;
  committed_units: number;
  status: DealStatus;
  deal_state: DealTargetState;
};

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
  status: "held" | "committed";
  expires_at: string;
  reserved_units: number;
  committed_units: number;
  max_units: number;
  min_units: number;
  deal_state: DealTargetState;
  available_units: number;
  replay: boolean;
  renewed?: boolean;
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

function requireUuid(value: unknown, field: string): string {
  const text = requireNonEmpty(value, field, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new ReservationError(400, `invalid_${field}`, `${field} must be a valid UUID`);
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

  private async lockDeal(client: pg.PoolClient, dealId: string): Promise<LockedDeal> {
    const result = await client.query(
      `SELECT deal_id, max_units, min_units, reserved_units, committed_units, status, deal_state
         FROM siton_inventory.inventory_deals
        WHERE deal_id=$1
        FOR UPDATE`,
      [dealId]
    );
    if (!result.rowCount) throw new ReservationError(404, "inventory_deal_not_found", "inventory deal not found");
    const row = result.rows[0];
    return {
      deal_id: String(row.deal_id),
      max_units: Number(row.max_units),
      min_units: Number(row.min_units),
      reserved_units: Number(row.reserved_units),
      committed_units: Number(row.committed_units),
      status: String(row.status) as DealStatus,
      deal_state: String(row.deal_state) as DealTargetState
    };
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
            SET reserved_units=GREATEST(committed_units, reserved_units-$2), updated_at=now()
          WHERE deal_id=$1`,
        [dealId, releasedQty]
      );
    }
    return releasedQty;
  }

  private responseFrom(args: {
    reservationId: string;
    dealId: string;
    qty: number;
    status: "held" | "committed";
    expiresAt: string;
    deal: LockedDeal;
    replay: boolean;
    renewed?: boolean;
  }): HoldResult {
    return {
      ok: true,
      reservation_id: args.reservationId,
      deal_id: args.dealId,
      qty: args.qty,
      status: args.status,
      expires_at: args.expiresAt,
      reserved_units: Number(args.deal.reserved_units),
      committed_units: Number(args.deal.committed_units),
      max_units: Number(args.deal.max_units),
      min_units: Number(args.deal.min_units),
      deal_state: args.deal.deal_state,
      available_units: Number(args.deal.max_units) - Number(args.deal.reserved_units),
      replay: args.replay,
      ...(args.renewed ? { renewed: true } : {})
    };
  }

  async syncDeal(input: { deal_id: string; max_units: number; min_units?: number; status?: DealStatus }) {
    const dealId = requireUuid(input.deal_id, "deal_id");
    const maxUnits = requirePositiveInteger(input.max_units, "max_units");
    const minUnits = input.min_units === undefined ? maxUnits : requirePositiveInteger(input.min_units, "min_units");
    if (minUnits > maxUnits) throw new ReservationError(400, "invalid_min_units", "min_units cannot exceed max_units");
    const status: DealStatus = input.status === "closed" ? "closed" : "open";
    return this.transaction(async (client) => {
      const existing = await client.query(
        `SELECT deal_id, max_units, min_units, reserved_units, committed_units, status, deal_state
           FROM siton_inventory.inventory_deals
          WHERE deal_id=$1
          FOR UPDATE`,
        [dealId]
      );
      if (!existing.rowCount) {
        const inserted = await client.query(
          `INSERT INTO siton_inventory.inventory_deals(deal_id,max_units,min_units,reserved_units,committed_units,status,deal_state)
           VALUES ($1,$2,$3,0,0,$4,'PendingTarget')
           RETURNING deal_id,max_units,min_units,reserved_units,committed_units,status,deal_state`,
          [dealId, maxUnits, minUnits, status]
        );
        return { ok: true, ...inserted.rows[0], created: true };
      }
      const row = existing.rows[0];
      if (Number(row.max_units) !== maxUnits || Number(row.min_units) !== minUnits) {
        throw new ReservationError(409, "inventory_thresholds_immutable", "max_units and min_units cannot change after inventory sync", {
          existing_max_units: Number(row.max_units), requested_max_units: maxUnits,
          existing_min_units: Number(row.min_units), requested_min_units: minUnits
        });
      }
      await this.reclaimExpired(client, dealId);
      const updated = await client.query(
        `UPDATE siton_inventory.inventory_deals SET status=$2, updated_at=now() WHERE deal_id=$1
         RETURNING deal_id,max_units,min_units,reserved_units,committed_units,status,deal_state`,
        [dealId, status]
      );
      return { ok: true, ...updated.rows[0], created: false };
    });
  }

  async hold(input: HoldInput): Promise<HoldResult> {
    const dealId = requireUuid(input.deal_id, "deal_id");
    const qty = requirePositiveInteger(input.qty, "qty");
    const idempotencyKey = requireNonEmpty(input.idempotency_key, "idempotency_key", 200);
    const requestHash = requireNonEmpty(input.request_hash, "request_hash", 128);

    return this.transaction(async (client) => {
      let deal = await this.lockDeal(client, dealId);
      await this.reclaimExpired(client, dealId);
      deal = await this.lockDeal(client, dealId);
      if (deal.status !== "open") throw new ReservationError(409, "inventory_deal_closed", "deal inventory is closed");

      const prior = await client.query(
        `SELECT reservation_id, request_hash, qty, status, expires_at, canonical_response, hold_generation
           FROM siton_inventory.inventory_reservations
          WHERE deal_id=$1 AND idempotency_key=$2`,
        [dealId, idempotencyKey]
      );
      if (prior.rowCount) {
        const row = prior.rows[0] as {
          reservation_id: string;
          request_hash: string;
          qty: number;
          status: ReservationStatus;
          expires_at: string;
          hold_generation: number;
        };
        if (String(row.request_hash) !== requestHash || Number(row.qty) !== qty) {
          throw new ReservationError(409, "idempotency_payload_mismatch", "idempotency key was already used with a different payload");
        }
        if (row.status === "held" || row.status === "committed") {
          return this.responseFrom({
            reservationId: String(row.reservation_id), dealId, qty,
            status: row.status,
            expiresAt: new Date(row.expires_at).toISOString(),
            deal,
            replay: true
          });
        }

        const remaining = Number(deal.max_units) - Number(deal.reserved_units);
        if (qty > remaining) {
          throw new ReservationError(409, "inventory_exhausted", "requested quantity exceeds available inventory", {
            requested_qty: qty,
            available_units: Math.max(0, remaining)
          });
        }
        const expiresAt = new Date(Date.now() + this.holdTtlSeconds * 1000).toISOString();
        await client.query(
          `UPDATE siton_inventory.inventory_reservations
              SET status='held', hold_generation=hold_generation+1, expires_at=$2,
                  released_at=NULL, expired_at=NULL, committed_at=NULL
            WHERE reservation_id=$1`,
          [row.reservation_id, expiresAt]
        );
        const updatedDeal = await client.query(
          `UPDATE siton_inventory.inventory_deals
              SET reserved_units=reserved_units+$2, updated_at=now()
            WHERE deal_id=$1 AND reserved_units+$2 <= max_units
            RETURNING deal_id,max_units,min_units,reserved_units,committed_units,status,deal_state`,
          [dealId, qty]
        );
        if (updatedDeal.rowCount !== 1) throw new ReservationError(409, "inventory_exhausted", "inventory ceiling rejected renewed reservation");
        deal = {
          deal_id: String(updatedDeal.rows[0].deal_id),
          max_units: Number(updatedDeal.rows[0].max_units),
          min_units: Number(updatedDeal.rows[0].min_units),
          reserved_units: Number(updatedDeal.rows[0].reserved_units),
          committed_units: Number(updatedDeal.rows[0].committed_units),
          status: String(updatedDeal.rows[0].status) as DealStatus,
          deal_state: String(updatedDeal.rows[0].deal_state) as DealTargetState
        };
        const response = this.responseFrom({ reservationId: String(row.reservation_id), dealId, qty, status: "held", expiresAt, deal, replay: true, renewed: true });
        await client.query(`UPDATE siton_inventory.inventory_reservations SET canonical_response=$2 WHERE reservation_id=$1`, [row.reservation_id, JSON.stringify(response)]);
        return response;
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
      const updatedDeal = await client.query(
        `UPDATE siton_inventory.inventory_deals
            SET reserved_units=reserved_units+$2, updated_at=now()
          WHERE deal_id=$1 AND reserved_units+$2 <= max_units
          RETURNING deal_id,max_units,min_units,reserved_units,committed_units,status,deal_state`,
        [dealId, qty]
      );
      if (updatedDeal.rowCount !== 1) throw new ReservationError(409, "inventory_exhausted", "inventory ceiling rejected reservation");
      deal = {
        deal_id: String(updatedDeal.rows[0].deal_id),
        max_units: Number(updatedDeal.rows[0].max_units),
        min_units: Number(updatedDeal.rows[0].min_units),
        reserved_units: Number(updatedDeal.rows[0].reserved_units),
        committed_units: Number(updatedDeal.rows[0].committed_units),
        status: String(updatedDeal.rows[0].status) as DealStatus,
        deal_state: String(updatedDeal.rows[0].deal_state) as DealTargetState
      };
      const response = this.responseFrom({ reservationId, dealId, qty, status: "held", expiresAt, deal, replay: false });
      await client.query(
        `INSERT INTO siton_inventory.inventory_reservations
          (reservation_id,deal_id,idempotency_key,request_hash,qty,status,hold_generation,expires_at,canonical_response)
         VALUES ($1,$2,$3,$4,$5,'held',1,$6,$7)`,
        [reservationId, dealId, idempotencyKey, requestHash, qty, expiresAt, JSON.stringify(response)]
      );
      return response;
    });
  }

  async commitReservation(reservationIdInput: unknown) {
    const reservationId = requireUuid(reservationIdInput, "reservation_id");
    return this.transaction(async (client) => {
      const lookup = await client.query(`SELECT deal_id FROM siton_inventory.inventory_reservations WHERE reservation_id=$1`, [reservationId]);
      if (!lookup.rowCount) throw new ReservationError(404, "reservation_not_found", "reservation not found");
      const dealId = String(lookup.rows[0].deal_id);
      let deal = await this.lockDeal(client, dealId);
      await this.reclaimExpired(client, dealId);
      deal = await this.lockDeal(client, dealId);
      const result = await client.query(
        `SELECT reservation_id,deal_id,qty,status,expires_at
           FROM siton_inventory.inventory_reservations
          WHERE reservation_id=$1
          FOR UPDATE`,
        [reservationId]
      );
      const row = result.rows[0] as { reservation_id: string; deal_id: string; qty: number; status: ReservationStatus; expires_at: string };
      if (row.status === "committed") {
        const priorAudit = await client.query(
          `SELECT audit_id FROM siton_inventory.deal_state_audit
            WHERE deal_id=$1 AND action_name='deal.target_reached'
            LIMIT 1`,
          [dealId]
        );
        return {
          ok: true, reservation_id: reservationId, status: "committed", replay: true,
          reserved_units: deal.reserved_units, committed_units: deal.committed_units,
          max_units: deal.max_units, min_units: deal.min_units, deal_state: deal.deal_state,
          target_transitioned: false,
          target_audit_id: priorAudit.rowCount ? String(priorAudit.rows[0].audit_id) : null
        };
      }
      if (row.status !== "held") throw new ReservationError(409, `reservation_${row.status}`, `reservation is already ${row.status}`);
      const updatedReservation = await client.query(
        `UPDATE siton_inventory.inventory_reservations
            SET status='committed', committed_at=now()
          WHERE reservation_id=$1 AND status='held'
          RETURNING qty`,
        [reservationId]
      );
      if (updatedReservation.rowCount !== 1) throw new ReservationError(409, "reservation_state_conflict", "reservation state changed concurrently");
      const updatedDeal = await client.query(
        `UPDATE siton_inventory.inventory_deals
            SET committed_units=committed_units+$2, updated_at=now()
          WHERE deal_id=$1 AND committed_units+$2 <= reserved_units
          RETURNING max_units,min_units,reserved_units,committed_units,deal_state`,
        [dealId, Number(updatedReservation.rows[0].qty)]
      );
      if (updatedDeal.rowCount !== 1) throw new ReservationError(409, "inventory_commit_invariant_failed", "committed units would exceed reserved units");

      const committedUnits = Number(updatedDeal.rows[0].committed_units);
      const minUnits = Number(updatedDeal.rows[0].min_units);
      let dealState = String(updatedDeal.rows[0].deal_state) as DealTargetState;
      let targetTransitioned = false;
      let targetAuditId: string | null = null;

      if (dealState === "PendingTarget" && committedUnits >= minUnits) {
        targetAuditId = randomUUID();
        const transitioned = await client.query(
          `UPDATE siton_inventory.inventory_deals
              SET deal_state='TargetReached', updated_at=now()
            WHERE deal_id=$1 AND deal_state='PendingTarget' AND committed_units >= min_units
            RETURNING deal_state`,
          [dealId]
        );
        if (transitioned.rowCount !== 1) throw new ReservationError(409, "target_transition_conflict", "target state changed concurrently");
        await client.query(
          `INSERT INTO siton_inventory.deal_state_audit
            (audit_id,deal_id,source_reservation_id,action_name,from_state,to_state,idempotency_key,committed_units,min_units)
           VALUES ($1,$2,$3,'deal.target_reached','PendingTarget','TargetReached',$4,$5,$6)`,
          [targetAuditId, dealId, reservationId, `target-reached:${dealId}`, committedUnits, minUnits]
        );
        dealState = "TargetReached";
        targetTransitioned = true;
      }

      return {
        ok: true, reservation_id: reservationId, status: "committed", replay: false,
        max_units: Number(updatedDeal.rows[0].max_units), min_units: minUnits,
        reserved_units: Number(updatedDeal.rows[0].reserved_units), committed_units: committedUnits,
        deal_state: dealState, target_transitioned: targetTransitioned, target_audit_id: targetAuditId
      };
    });
  }

  async releaseReservation(reservationIdInput: unknown) {
    const reservationId = requireUuid(reservationIdInput, "reservation_id");
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
      if (row.status === "expired") return { ok: true, reservation_id: reservationId, status: "expired", replay: true };
      const updated = await client.query(
        `UPDATE siton_inventory.inventory_reservations
            SET status='released', released_at=now()
          WHERE reservation_id=$1 AND status='held'
          RETURNING qty`,
        [reservationId]
      );
      if (updated.rowCount !== 1) throw new ReservationError(409, "reservation_state_conflict", "reservation state changed concurrently");
      const updatedDeal = await client.query(
        `UPDATE siton_inventory.inventory_deals
            SET reserved_units=GREATEST(committed_units,reserved_units-$2), updated_at=now()
          WHERE deal_id=$1
          RETURNING max_units,reserved_units,committed_units`,
        [dealId, Number(updated.rows[0].qty)]
      );
      return {
        ok: true,
        reservation_id: reservationId,
        status: "released",
        replay: false,
        max_units: Number(updatedDeal.rows[0].max_units),
        reserved_units: Number(updatedDeal.rows[0].reserved_units),
        committed_units: Number(updatedDeal.rows[0].committed_units)
      };
    });
  }

  async inventory(dealIdInput: unknown) {
    const dealId = requireUuid(dealIdInput, "deal_id");
    return this.transaction(async (client) => {
      let deal = await this.lockDeal(client, dealId);
      await this.reclaimExpired(client, dealId);
      deal = await this.lockDeal(client, dealId);
      return {
        ok: true,
        deal_id: dealId,
        status: deal.status,
        deal_state: deal.deal_state,
        max_units: Number(deal.max_units),
        min_units: Number(deal.min_units),
        reserved_units: Number(deal.reserved_units),
        committed_units: Number(deal.committed_units),
        available_units: Number(deal.max_units) - Number(deal.reserved_units)
      };
    });
  }
}
