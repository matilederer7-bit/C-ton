import { createHash, randomBytes } from "node:crypto";

import { isProductionLikeEnv } from "./runtime_config.js";
import { parseCookies } from "./seller_auth.js";

export const DISTRIBUTOR_SESSION_COOKIE = "siton_distributor_session";
export const DISTRIBUTOR_SESSION_TTL_SECONDS = 60 * 60 * 12;

export function distributorSessionSecret(env: NodeJS.ProcessEnv = process.env) {
  return String(env.DISTRIBUTOR_SESSION_SECRET || "").trim();
}

export function distributorAuthConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(distributorSessionSecret(env));
}

export function createDistributorSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashDistributorSessionToken(token: unknown, env: NodeJS.ProcessEnv = process.env) {
  const raw = String(token || "").trim();
  const secret = distributorSessionSecret(env);
  if (!raw || !secret) return null;
  return createHash("sha256").update(`${secret}:${raw}`).digest("hex");
}

export function readDistributorSessionToken(req: any) {
  return String(parseCookies(req?.headers?.cookie)[DISTRIBUTOR_SESSION_COOKIE] || "").trim();
}

export function serializeDistributorSessionCookie(token: string, options?: { secure?: boolean }) {
  return `${DISTRIBUTOR_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DISTRIBUTOR_SESSION_TTL_SECONDS}${options?.secure ? "; Secure" : ""}`;
}

export function serializeExpiredDistributorSessionCookie(options?: { secure?: boolean }) {
  return `${DISTRIBUTOR_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options?.secure ? "; Secure" : ""}`;
}

export function distributorCookieSecure(env: NodeJS.ProcessEnv = process.env) {
  return isProductionLikeEnv(env);
}
