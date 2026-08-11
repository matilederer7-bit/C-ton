import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
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

app.post("/v1/deals/sync", async (req: any) => store.syncDeal(req.body || {}));
app.post("/v1/reservations/hold", async (req: any) => store.hold(req.body || {}));
app.post("/v1/reservations/commit", async (req: any) => store.commitReservation(req.body?.reservation_id));
app.post("/v1/reservations/release", async (req: any) => store.releaseReservation(req.body?.reservation_id));
app.post("/v1/inventory/status", async (req: any) => store.inventory(req.body?.deal_id));

const close = async () => {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
};
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
process.on("SIGINT", () => void close().finally(() => process.exit(0)));

await app.listen({ port: PORT, host: HOST });
