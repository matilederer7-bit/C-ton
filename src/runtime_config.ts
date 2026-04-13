import dotenv from "dotenv";
import { parseSellerAuthCredentials } from "./seller_auth.js";

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
export const DEBUG_SURFACES_ENABLED = process.env.DEBUG_SURFACES_ENABLED === "1";
export const DEBUG_SURFACES_ACCESS_KEY = process.env.DEBUG_SURFACES_ACCESS_KEY || "";
export const DEBUG_SURFACES_ACTIVE = DEBUG_SURFACES_ENABLED && Boolean(DEBUG_SURFACES_ACCESS_KEY.trim());
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
export const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || "mockpay";
export const PAYMENT_PROVIDER_MODE = process.env.PAYMENT_PROVIDER_MODE || "mock-backed";
export const PAYMENT_PROVIDER_BASE_URL = process.env.PAYMENT_PROVIDER_BASE_URL || "";
export const PAYMENT_PROVIDER_API_KEY = process.env.PAYMENT_PROVIDER_API_KEY || "";
export const PAYMENT_PROVIDER_PUBLIC_KEY = process.env.PAYMENT_PROVIDER_PUBLIC_KEY || "";
export const PAYMENT_PROVIDER_AUTH_PATH = process.env.PAYMENT_PROVIDER_AUTH_PATH || "/authorize";
export const PAYMENT_PROVIDER_CAPTURE_PATH = process.env.PAYMENT_PROVIDER_CAPTURE_PATH || "/capture";
export const PAYMENT_PROVIDER_TIMEOUT_MS = readNumberEnv("PAYMENT_PROVIDER_TIMEOUT_MS", 8000);
export const PAYMENT_PROVIDER_CURRENCY = process.env.PAYMENT_PROVIDER_CURRENCY || "ILS";
export const PAYMENT_WEBHOOK_PROVIDER = process.env.PAYMENT_WEBHOOK_PROVIDER || PAYMENT_PROVIDER;
export const PAYMENT_AUTH_DECLINE_SUFFIX = process.env.PAYMENT_AUTH_DECLINE_SUFFIX || "0000";
export const NOTIFICATION_PROVIDER = process.env.NOTIFICATION_PROVIDER || "log-only";
export const APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
export const IS_DEMO_PREVIEW = APP_DEPLOYMENT_MODE === "demo-preview";
export const SELLER_AUTH_MODE = IS_DEMO_PREVIEW ? "demo-context" : "server-session";
export const SELLER_SESSION_SECRET = String(process.env.SELLER_SESSION_SECRET || "").trim();
export const SELLER_AUTH_CREDENTIALS = parseSellerAuthCredentials(process.env.SELLER_AUTH_CREDENTIALS);
export const SELLER_AUTH_CONFIGURED = IS_DEMO_PREVIEW
  ? true
  : Boolean(SELLER_SESSION_SECRET) && SELLER_AUTH_CREDENTIALS.length > 0;
export const DEMO_PAYMENT_WEBHOOK_SECRET = "mock-webhook-secret";
const RAW_PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "";
export const PAYMENT_WEBHOOK_SECRET =
  RAW_PAYMENT_WEBHOOK_SECRET || (IS_DEMO_PREVIEW ? DEMO_PAYMENT_WEBHOOK_SECRET : "");
export const PAYMENT_WEBHOOK_SECRET_IS_DEFAULT =
  !RAW_PAYMENT_WEBHOOK_SECRET || RAW_PAYMENT_WEBHOOK_SECRET === DEMO_PAYMENT_WEBHOOK_SECRET;
export const PAYMENT_WEBHOOK_SECRET_IS_SAFE = IS_DEMO_PREVIEW
  ? true
  : Boolean(RAW_PAYMENT_WEBHOOK_SECRET) && RAW_PAYMENT_WEBHOOK_SECRET !== DEMO_PAYMENT_WEBHOOK_SECRET;

// Admin API key — if set, all /api/admin/* routes require x-admin-key header to match.
// Leave empty for demo/dev (open access). Set in production deployments.
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
