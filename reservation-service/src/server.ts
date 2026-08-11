import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { closeInventory } from "./close.js";
import { ReservationError, ReservationStore } from "./store.js";
const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const SHARED_SECRET = String(process.env.RESERVATION_SERVICE_SHARED_SECRET || "").trim();
const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || "0.0.0.0");
const SIGNATURE_WINDOW_SECONDS = Number(process.env.SIGNATURE_WINDOW_SECONDS || 300);

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (SHARED_SECRET.length < 32) throw new Error("RESERVATION_SERVICE_SHARED_SECRET must be at least 32 characters");

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function requireUuid(value: unknown, field: string) {
  const text = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new ReservationError(400, `invalid_${field}`, `${field} must be a valid UUID`);
  }
  return text;
}

function requireText(value: unknown, field: string, maxLength: number) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) throw new ReservationError(400, `invalid_${field}`, `${field} is required and must be at most ${maxLength} characters`);
  return text;
}

function reservationResponse(row: any) {
  return {
    ok: true,
    reservation_id: String(row.reservation_id),
    deal_id: String(row.deal_id),
    idempotency_key: row.idempotency_key ? String(row.idempotency_key) : undefined,
    request_hash: row.request_hash ? String(row.request_hash) : undefined,
    qty: Number(row.qty),
    status: String(row.status),
    hold_generation: Number(row.hold_generation),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    committed_at: row.committed_at ? new Date(row.committed_at).toISOString() : null,
    released_at: row.released_at ? new Date(row.released_at).toISOString() : null,
    expired_at: row.expired_at ? new Date(row.expired_at).toISOString() : null,
    max_units: Number(row.max_units),
    reserved_units: Number(row.reserved_units),
    committed_units: Number(row.committed_units),
    inventory_status: String(row.inventory_status)
  };
}

function verifySignature(req: any) {
  const timestampText = String(req.headers["x-siton-timestamp"] || "").trim();
  const signature = String(req.headers["x-siton-signature"] || "").trim().toLowerCase();
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new ReservationError(401, "reservation_auth_invalid", "invalid reservation service authentication");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > SIGNATURE_WINDOW_SECONDS) {
    throw new ReservationError(401, "reservation_auth_expired", "reservation service signature expired");
  }
  const path = String(req.url || "").split("?")[0];
  const bodyHash = createHash("sha256").update(stableStringify(req.body ?? null)).digest("hex");
  const message = `${timestampText}\n${String(req.method).toUpperCase()}\n${path}\n${bodyHash}`;
  const expected = createHmac("sha256", SHARED_SECRET).update(message).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ReservationError(401, "reservation_auth_invalid", "invalid reservation service authentication");
  }
}

const pool = new Pool({ connectionString: DATABASE_URL, max: Number(process.env.DB_POOL_MAX || 30) });
const store = new ReservationStore(pool);
const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 64 * 1024 });

app.setErrorHandler((error: any, _req, reply) => {
  if (error instanceof ReservationError) {
    return reply.code(error.statusCode).send({ ok: false, error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  }
  app.log.error({ err: error }, "reservation service unhandled error");
  return reply.code(500).send({ ok: false, error: "internal_error", code: "internal_error" });
});

app.get("/health", async () => ({ ok: true, service: "siton-reservation-service" }));

app.addHook("preHandler", async (req) => {
  if (String(req.url).split("?")[0] === "/health") return;
  verifySignature(req);
});

app.post("/v1/deals/sync", async (req: any) => store.syncDeal({ ...(req.body || {}), status: "open" }));
app.post("/v1/deals/close", async (req: any) => closeInventory(pool, req.body?.deal_id, req.body?.max_units));
app.post("/v1/reservations/hold", async (req: any) => store.hold(req.body || {}));
app.post("/v1/reservations/commit", async (req: any) => store.commitReservation(req.body?.reservation_id));
app.post("/v1/reservations/release", async (req: any) => store.releaseReservation(req.body?.reservation_id));
app.post("/v1/reservations/lookup", async (req: any) => {
  const dealId = requireUuid(req.body?.deal_id, "deal_id");
  const idempotencyKey = requireText(req.body?.idempotency_key, "idempotency_key", 200);
  const result = await pool.query(
    `SELECT r.reservation_id, r.deal_id, r.idempotency_key, r.request_hash, r.qty, r.status, r.hold_generation,
            r.expires_at, r.created_at, r.committed_at, r.released_at, r.expired_at,
            d.max_units, d.reserved_units, d.committed_units, d.status AS inventory_status
       FROM siton_inventory.inventory_reservations r
       JOIN siton_inventory.inventory_deals d ON d.deal_id=r.deal_id
      WHERE r.deal_id=$1 AND r.idempotency_key=$2
      LIMIT 1`,
    [dealId, idempotencyKey]
  );
  if (!result.rowCount) return { ok: true, found: false, deal_id: dealId, idempotency_key: idempotencyKey };
  return { ...reservationResponse(result.rows[0]), found: true };
});
app.post("/v1/reservations/status", async (req: any) => {
  const reservationId = requireUuid(req.body?.reservation_id, "reservation_id");
  const result = await pool.query(
    `SELECT r.reservation_id, r.deal_id, r.idempotency_key, r.request_hash, r.qty, r.status, r.hold_generation,
            r.expires_at, r.created_at, r.committed_at, r.released_at, r.expired_at,
            d.max_units, d.reserved_units, d.committed_units, d.status AS inventory_status
       FROM siton_inventory.inventory_reservations r
       JOIN siton_inventory.inventory_deals d ON d.deal_id=r.deal_id
      WHERE r.reservation_id=$1
      LIMIT 1`,
    [reservationId]
  );
  if (!result.rowCount) throw new ReservationError(404, "reservation_not_found", "reservation not found");
  return reservationResponse(result.rows[0]);
});
app.post("/v1/inventory/status", async (req: any) => store.inventory(req.body?.deal_id));

const close = async () => {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
};
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
process.on("SIGINT", () => void close().finally(() => process.exit(0)));

await app.listen({ port: PORT, host: HOST });
