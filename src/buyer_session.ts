import { createHash, randomBytes } from "node:crypto";

import { isProductionLikeEnv } from "./runtime_config.js";
import { parseCookies } from "./seller_auth.js";

export const BUYER_SESSION_COOKIE = "siton_buyer_session";
export const BUYER_SESSION_TTL_SECONDS = 60 * 60 * 24;

export function buyerSessionSecret(env: NodeJS.ProcessEnv = process.env) {
  const configured = String(env.BUYER_SESSION_SECRET || env.OTP_TOKEN_SECRET || "").trim();
  if (configured) return configured;
  return isProductionLikeEnv(env) ? "" : "siton-buyer-session-local-only";
}

export function buyerSessionConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(buyerSessionSecret(env));
}

export function createBuyerSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashBuyerSessionToken(token: unknown, env: NodeJS.ProcessEnv = process.env) {
  const raw = String(token || "").trim();
  const secret = buyerSessionSecret(env);
  if (!raw || !secret) return null;
  return createHash("sha256").update(`${secret}:${raw}`).digest("hex");
}

export function readBuyerSessionToken(req: any) {
  return String(parseCookies(req?.headers?.cookie)[BUYER_SESSION_COOKIE] || "").trim();
}

export function serializeBuyerSessionCookie(token: string, options?: { secure?: boolean }) {
  return `${BUYER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${BUYER_SESSION_TTL_SECONDS}${options?.secure ? "; Secure" : ""}`;
}

export function serializeExpiredBuyerSessionCookie(options?: { secure?: boolean }) {
  return `${BUYER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options?.secure ? "; Secure" : ""}`;
}
