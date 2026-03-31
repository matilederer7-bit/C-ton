import dotenv from "dotenv";

dotenv.config();

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/siton";
export const DB_SCHEMA = process.env.DB_SCHEMA || "siton";
export const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

export const PORT = readNumberEnv("PORT", 3000);
export const HOST = process.env.HOST || "0.0.0.0";
export const COMPLETION_WINDOW_MINUTES = readNumberEnv("COMPLETION_WINDOW_MINUTES", 15);
export const OUTBOX_POLL_MS = readNumberEnv("OUTBOX_POLL_MS", 1000);
export const OUTBOX_MAX_ATTEMPTS = readNumberEnv("OUTBOX_MAX_ATTEMPTS", 4);

export const MOCK_SEED = process.env.MOCK_SEED ? Number(process.env.MOCK_SEED) : null;

export const DEBUG_SQL_LOGGING = process.env.DEBUG_SQL_LOGGING === "1";
export const DEBUG_JOIN_LOGGING = process.env.DEBUG_JOIN_LOGGING === "1";
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
export const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || "mockpay";
export const PAYMENT_WEBHOOK_PROVIDER = process.env.PAYMENT_WEBHOOK_PROVIDER || PAYMENT_PROVIDER;
export const PAYMENT_AUTH_DECLINE_SUFFIX = process.env.PAYMENT_AUTH_DECLINE_SUFFIX || "0000";
export const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "mock-webhook-secret";
export const NOTIFICATION_PROVIDER = process.env.NOTIFICATION_PROVIDER || "log-only";
