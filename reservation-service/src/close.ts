import pg from "pg";
import { ReservationError } from "./store.js";

type PoolType = InstanceType<typeof pg.Pool>;

function requireUuid(value: unknown, field: string) {
  const text = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new ReservationError(400, `invalid_${field}`, `${field} must be a valid UUID`);
  }
  return text;
}

export async function closeInventory(pool: PoolType, dealIdInput: unknown, maxUnitsInput: unknown) {
  const dealId = requireUuid(dealIdInput, "deal_id");
  const maxUnits = Number(maxUnitsInput);
  if (!Number.isInteger(maxUnits) || maxUnits < 1) {
    throw new ReservationError(400, "invalid_max_units", "max_units must be a positive integer");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '20s'");
    const dealResult = await client.query(
      `SELECT deal_id,max_units,reserved_units,committed_units,status
         FROM siton_inventory.inventory_deals
        WHERE deal_id=$1
        FOR UPDATE`,
      [dealId]
    );
    if (!dealResult.rowCount) throw new ReservationError(404, "inventory_deal_not_found", "inventory deal not found");
    const deal = dealResult.rows[0];
    if (Number(deal.max_units) !== maxUnits) {
      throw new ReservationError(409, "inventory_max_units_mismatch", "max_units does not match synced inventory", {
        existing_max_units: Number(deal.max_units), requested_max_units: maxUnits
      });
    }

    const expired = await client.query(
      `UPDATE siton_inventory.inventory_reservations
          SET status='expired', expired_at=now()
        WHERE deal_id=$1 AND status='held' AND expires_at <= now()
        RETURNING qty`,
      [dealId]
    );
    const expiredQty = expired.rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
    if (expiredQty > 0) {
      await client.query(
        `UPDATE siton_inventory.inventory_deals
            SET reserved_units=GREATEST(committed_units,reserved_units-$2), updated_at=now()
          WHERE deal_id=$1`,
        [dealId, expiredQty]
      );
    }

    const active = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(qty),0)::int AS qty
         FROM siton_inventory.inventory_reservations
        WHERE deal_id=$1 AND status='held'`,
      [dealId]
    );
    const activeCount = Number(active.rows[0]?.count || 0);
    const activeQty = Number(active.rows[0]?.qty || 0);
    if (activeCount > 0) {
      throw new ReservationError(409, "inventory_holds_in_flight", "inventory cannot close while active Holds are in flight", {
        active_holds: activeCount,
        active_hold_units: activeQty
      });
    }

    const updated = await client.query(
      `UPDATE siton_inventory.inventory_deals
          SET status='closed', updated_at=now()
        WHERE deal_id=$1
        RETURNING deal_id,max_units,reserved_units,committed_units,status`,
      [dealId]
    );
    await client.query("COMMIT");
    const row = updated.rows[0];
    return {
      ok: true,
      deal_id: String(row.deal_id),
      max_units: Number(row.max_units),
      reserved_units: Number(row.reserved_units),
      committed_units: Number(row.committed_units),
      status: String(row.status)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
