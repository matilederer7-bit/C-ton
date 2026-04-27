/**
 * Provider-ready OTP rail.
 *
 * Constraints:
 * - The OTP code itself is NEVER stored in plaintext. Only a salted hash.
 * - The provider stays log/dev. No real SMS/Email is dispatched here.
 * - Notifications and delivery attempts never mutate deal/participant/money state.
 * - Verified challenges expose a short `otp_token` (HMAC over challenge_id +
 *   destination_hash + purpose + verified_at). The token is the proof that join
 *   needs; it does not replace the full session/auth layer.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type pg from "pg";

import { isProductionLikeEnv } from "./runtime_config.js";

export type OtpChannel = "sms" | "email";
export type OtpPurpose = "buyer_join" | "buyer_recovery" | "seller_login";
export type OtpStatus = "pending" | "verified" | "expired" | "locked" | "cancelled";
export type OtpProviderMode = "dev" | "real" | "disabled" | "log-only";
export type OtpDeliveryResult = "success" | "temporary_fail" | "permanent_fail" | "skipped";

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_DEFAULT_MAX_ATTEMPTS = 3;
export const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60_000;
export const OTP_RATE_LIMIT_MAX_REQUESTS = 5;
export const OTP_TOKEN_TTL_MS = 15 * 60_000;

export const OTP_CHANNELS: readonly OtpChannel[] = ["sms", "email"];
export const OTP_PURPOSES: readonly OtpPurpose[] = ["buyer_join", "buyer_recovery", "seller_login"];

export class OtpValidationError extends Error {
  constructor(readonly code: string, readonly statusCode = 400, message = code) {
    super(message);
    this.name = "OtpValidationError";
  }
}

export function isOtpChannel(value: string): value is OtpChannel {
  return (OTP_CHANNELS as readonly string[]).includes(value);
}

export function isOtpPurpose(value: string): value is OtpPurpose {
  return (OTP_PURPOSES as readonly string[]).includes(value);
}

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function getOtpHashSalt(): string {
  return process.env.OTP_HASH_SALT || "siton-otp-salt-default";
}

function getOtpTokenSecret(): string {
  // Reuse seller session secret if available — single source of HMAC truth.
  // In dev/test fall back to a stable string so test scenarios are reproducible.
  return (
    process.env.OTP_TOKEN_SECRET ||
    process.env.SELLER_SESSION_SECRET ||
    "siton-otp-token-secret-default"
  );
}

export function hashOtpCode(code: string, challengeId: string): string {
  return createHmac("sha256", getOtpHashSalt())
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

export function hashDestination(channel: OtpChannel, destination: string): string {
  const normalized = normalizeDestination(channel, destination);
  return createHash("sha256").update(`${channel}:${normalized}`).digest("hex");
}

export function normalizeDestination(channel: OtpChannel, destination: string): string {
  const raw = String(destination || "").trim();
  if (channel === "sms") {
    const digits = raw.replace(/\D/g, "");
    return digits;
  }
  return raw.toLowerCase();
}

export function maskDestination(channel: OtpChannel, destination: string): string {
  const raw = String(destination || "").trim();
  if (channel === "sms") {
    const digits = raw.replace(/\D/g, "");
    if (digits.length <= 4) return "***";
    return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
  }
  const at = raw.indexOf("@");
  if (at <= 1) return "***";
  const local = raw.slice(0, at);
  const domain = raw.slice(at);
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(2, local.length - 1))}${domain}`;
}

export function validateDestination(channel: OtpChannel, destination: string): void {
  if (channel === "sms") {
    const digits = String(destination || "").replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      throw new OtpValidationError("invalid_destination", 400, "destination must be 7-15 digit phone");
    }
    return;
  }
  const value = String(destination || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new OtpValidationError("invalid_destination", 400, "destination must be a valid email");
  }
}

export function buildOtpIdempotencyKey(args: {
  channel: OtpChannel;
  destinationHash: string;
  purpose: OtpPurpose;
  dealId?: string | null;
}): string {
  const window = Math.floor(Date.now() / OTP_TTL_MS);
  return [
    args.channel,
    args.destinationHash,
    args.purpose,
    args.dealId || "",
    window
  ].join(":");
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export type OtpDispatchInput = {
  challenge_id: string;
  channel: OtpChannel;
  destination_display: string | null;
  purpose: OtpPurpose;
  code: string;
};

export type OtpDispatchResult = {
  status: OtpDeliveryResult;
  provider_message_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

export interface OtpProvider {
  readonly providerCode: string;
  readonly mode: OtpProviderMode;
  send(input: OtpDispatchInput): Promise<OtpDispatchResult>;
}

class LogOtpProvider implements OtpProvider {
  readonly providerCode = "log";
  readonly mode: OtpProviderMode;

  constructor(mode: OtpProviderMode = "dev", private logger: Pick<Console, "info"> = console) {
    this.mode = mode;
  }

  async send(input: OtpDispatchInput): Promise<OtpDispatchResult> {
    if (this.mode === "disabled") {
      return { status: "skipped", error_code: "otp_provider_disabled", error_message: "OTP provider disabled" };
    }
    // Never log the OTP code itself in production-like environments.
    const safeCode = isProductionLikeEnv() ? "[redacted]" : input.code;
    this.logger.info("[otp.log]", {
      challenge_id: input.challenge_id,
      channel: input.channel,
      purpose: input.purpose,
      destination_display: input.destination_display,
      code: safeCode
    });
    return {
      status: "success",
      provider_message_id: `log_${randomBytes(8).toString("hex")}`
    };
  }
}

export function buildOtpProvider(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "info"> = console
): OtpProvider {
  const requested = (env.OTP_PROVIDER || "log").trim().toLowerCase();
  const modeEnv = (env.OTP_PROVIDER_MODE || "dev").trim().toLowerCase();
  if (requested !== "log") {
    logger.info("[otp] external providers are not enabled; using log/dev provider", {
      requested_provider: requested
    });
  }
  if (modeEnv === "disabled") return new LogOtpProvider("disabled", logger);
  return new LogOtpProvider("dev", logger);
}

export function getOtpProviderSummary(provider: OtpProvider) {
  return {
    provider: provider.providerCode,
    mode: provider.mode,
    external_delivery: false
  };
}

// ─── DB DDL bootstrap ─────────────────────────────────────────────────────────

export async function ensureOtpRailTables(
  withTx: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>
): Promise<void> {
  await withTx(async (c) => {
    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.otp_challenges (
        challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
        destination_hash TEXT NOT NULL,
        destination_display TEXT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('buyer_join','buyer_recovery','seller_login')),
        code_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','verified','expired','locked','cancelled')),
        expires_at TIMESTAMPTZ NOT NULL,
        verified_at TIMESTAMPTZ NULL,
        max_attempts INT NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
        attempts_count INT NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
        resend_count INT NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
        idempotency_key TEXT NOT NULL UNIQUE,
        deal_id UUID NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_error TEXT NULL
      )`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.otp_delivery_attempts (
        attempt_id BIGSERIAL PRIMARY KEY,
        challenge_id UUID NOT NULL REFERENCES siton.otp_challenges(challenge_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_mode TEXT NOT NULL,
        result_status TEXT NOT NULL CHECK (result_status IN ('success','temporary_fail','permanent_fail','skipped')),
        provider_message_id TEXT NULL,
        error_code TEXT NULL,
        error_message TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_otp_challenges_destination ON siton.otp_challenges (destination_hash, created_at DESC)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_otp_challenges_status_expires ON siton.otp_challenges (status, expires_at)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_otp_challenges_deal ON siton.otp_challenges (deal_id, created_at DESC)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_otp_delivery_attempts_challenge ON siton.otp_delivery_attempts (challenge_id, created_at)`);
  });
}

// ─── Request flow ─────────────────────────────────────────────────────────────

export type RequestOtpInput = {
  channel: string;
  destination: string;
  purpose: string;
  deal_id?: string | null;
};

export type RequestOtpResult = {
  challenge_id: string;
  status: OtpStatus;
  expires_at: string;
  destination_display: string;
  reused: boolean;
};

export async function requestOtpChallenge(
  db: pg.Pool | pg.PoolClient,
  provider: OtpProvider,
  input: RequestOtpInput
): Promise<RequestOtpResult> {
  if (!isOtpChannel(input.channel)) throw new OtpValidationError("invalid_channel", 400, "channel must be sms or email");
  if (!isOtpPurpose(input.purpose)) throw new OtpValidationError("invalid_purpose", 400, "unsupported purpose");
  validateDestination(input.channel, input.destination);

  const channel: OtpChannel = input.channel;
  const purpose: OtpPurpose = input.purpose;
  const destinationHash = hashDestination(channel, input.destination);
  const destinationDisplay = maskDestination(channel, input.destination);
  const dealId = input.deal_id ? String(input.deal_id) : null;

  // Rate limit: ≤ OTP_RATE_LIMIT_MAX_REQUESTS in OTP_RATE_LIMIT_WINDOW_MS per destination.
  const rate = await db.query(
    `SELECT COUNT(*)::int AS recent_count
     FROM siton.otp_challenges
     WHERE destination_hash=$1
       AND created_at > now() - ($2::int || ' milliseconds')::interval`,
    [destinationHash, OTP_RATE_LIMIT_WINDOW_MS]
  );
  const recentCount = Number(rate.rows[0]?.recent_count || 0);
  if (recentCount >= OTP_RATE_LIMIT_MAX_REQUESTS) {
    throw new OtpValidationError("otp_rate_limited", 429, "too many otp requests for this destination");
  }

  const idempotencyKey = buildOtpIdempotencyKey({ channel, destinationHash, purpose, dealId });
  // Reuse an active pending challenge for the same window (idempotent request).
  const existing = await db.query(
    `SELECT challenge_id, status, expires_at, destination_display
     FROM siton.otp_challenges
     WHERE idempotency_key=$1 AND status='pending' AND expires_at > now()
     LIMIT 1`,
    [idempotencyKey]
  );
  if (existing.rowCount) {
    const row = existing.rows[0] as any;
    return {
      challenge_id: String(row.challenge_id),
      status: "pending",
      expires_at: new Date(row.expires_at).toISOString(),
      destination_display: String(row.destination_display || destinationDisplay),
      reused: true
    };
  }

  const challengeId = randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const code = generateOtpCode();
  const codeHash = hashOtpCode(code, challengeId);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  const inserted = await db.query(
    `INSERT INTO siton.otp_challenges
       (challenge_id, channel, destination_hash, destination_display, purpose,
        code_hash, status, expires_at, max_attempts, attempts_count, resend_count,
        idempotency_key, deal_id)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::timestamptz,$8,0,0,$9,$10)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING challenge_id, expires_at, destination_display`,
    [
      challengeId,
      channel,
      destinationHash,
      destinationDisplay,
      purpose,
      codeHash,
      expiresAt,
      OTP_DEFAULT_MAX_ATTEMPTS,
      idempotencyKey,
      dealId
    ]
  );

  if (!inserted.rowCount) {
    // Concurrent insert won the race — fall back to whatever is now active.
    const fallback = await db.query(
      `SELECT challenge_id, expires_at, destination_display
       FROM siton.otp_challenges
       WHERE idempotency_key=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [idempotencyKey]
    );
    if (!fallback.rowCount) throw new OtpValidationError("otp_request_failed", 500, "could not persist challenge");
    const row = fallback.rows[0] as any;
    return {
      challenge_id: String(row.challenge_id),
      status: "pending",
      expires_at: new Date(row.expires_at).toISOString(),
      destination_display: String(row.destination_display || destinationDisplay),
      reused: true
    };
  }

  // Dispatch via provider — log/dev only. Failure does not roll back the challenge.
  let dispatch: OtpDispatchResult;
  try {
    dispatch = await provider.send({
      challenge_id: challengeId,
      channel,
      destination_display: destinationDisplay,
      purpose,
      code
    });
  } catch (err: any) {
    dispatch = {
      status: "temporary_fail",
      error_code: "otp_provider_exception",
      error_message: String(err?.message || err)
    };
  }

  await db.query(
    `INSERT INTO siton.otp_delivery_attempts
       (challenge_id, provider, provider_mode, result_status,
        provider_message_id, error_code, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      challengeId,
      provider.providerCode,
      provider.mode,
      dispatch.status,
      dispatch.provider_message_id || null,
      dispatch.error_code || null,
      dispatch.error_message || null
    ]
  );

  return {
    challenge_id: challengeId,
    status: "pending",
    expires_at: expiresAt,
    destination_display: destinationDisplay,
    reused: false
  };
}

// ─── Verify flow ──────────────────────────────────────────────────────────────

export type VerifyOtpInput = {
  challenge_id: string;
  code: string;
};

export type VerifyOtpResult = {
  challenge_id: string;
  status: "verified";
  destination_hash: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  deal_id: string | null;
  verified_at: string;
  otp_token: string;
};

function getTestBypassCode(): string | null {
  if (isProductionLikeEnv()) return null;
  const bypass = String(process.env.OTP_TEST_BYPASS_CODE || "").trim();
  return bypass || null;
}

export async function verifyOtpChallenge(
  db: pg.Pool | pg.PoolClient,
  input: VerifyOtpInput
): Promise<VerifyOtpResult> {
  const challengeId = String(input.challenge_id || "").trim();
  const code = String(input.code || "").trim();
  if (!challengeId) throw new OtpValidationError("otp_invalid", 400, "challenge_id required");
  if (!/^\d{4,8}$/.test(code)) throw new OtpValidationError("otp_invalid", 400, "code must be 4-8 digits");

  const row = await db.query(
    `SELECT challenge_id, channel, destination_hash, purpose, deal_id, code_hash,
            status, expires_at, max_attempts, attempts_count
     FROM siton.otp_challenges
     WHERE challenge_id=$1
     LIMIT 1`,
    [challengeId]
  );
  if (!row.rowCount) throw new OtpValidationError("otp_invalid", 400, "challenge not found");
  const challenge = row.rows[0] as any;

  if (challenge.status === "locked") throw new OtpValidationError("otp_locked", 423, "too many attempts");
  if (challenge.status === "cancelled") throw new OtpValidationError("otp_cancelled", 400, "challenge cancelled");
  if (challenge.status === "verified") {
    // Idempotent re-verify: re-issue token if still within TTL window.
    const verifiedAt = new Date().toISOString();
    return {
      challenge_id: challengeId,
      status: "verified",
      destination_hash: String(challenge.destination_hash),
      channel: challenge.channel as OtpChannel,
      purpose: challenge.purpose as OtpPurpose,
      deal_id: challenge.deal_id ? String(challenge.deal_id) : null,
      verified_at: verifiedAt,
      otp_token: signOtpToken({
        challenge_id: challengeId,
        destination_hash: String(challenge.destination_hash),
        purpose: challenge.purpose as OtpPurpose,
        verified_at: verifiedAt
      })
    };
  }
  if (Date.parse(challenge.expires_at) <= Date.now()) {
    await db.query(`UPDATE siton.otp_challenges SET status='expired', updated_at=now() WHERE challenge_id=$1`, [challengeId]);
    throw new OtpValidationError("otp_expired", 410, "challenge expired");
  }

  const maxAttempts = Number(challenge.max_attempts);
  const attempts = Number(challenge.attempts_count);

  // Test-only bypass — never active in production-like environments.
  const bypass = getTestBypassCode();
  const matches = bypass && code === bypass
    ? true
    : timingSafeEqualStrings(hashOtpCode(code, challengeId), String(challenge.code_hash));

  if (!matches) {
    const newAttempts = attempts + 1;
    if (newAttempts >= maxAttempts) {
      await db.query(
        `UPDATE siton.otp_challenges SET attempts_count=$2, status='locked', updated_at=now() WHERE challenge_id=$1`,
        [challengeId, newAttempts]
      );
      throw new OtpValidationError("otp_locked", 423, "too many attempts");
    }
    await db.query(
      `UPDATE siton.otp_challenges SET attempts_count=$2, last_error='otp_invalid', updated_at=now() WHERE challenge_id=$1`,
      [challengeId, newAttempts]
    );
    throw new OtpValidationError("otp_invalid", 400, "incorrect code");
  }

  const verifiedAt = new Date().toISOString();
  await db.query(
    `UPDATE siton.otp_challenges
     SET status='verified', verified_at=$2::timestamptz, attempts_count=$3, last_error=NULL, updated_at=now()
     WHERE challenge_id=$1`,
    [challengeId, verifiedAt, attempts + 1]
  );

  return {
    challenge_id: challengeId,
    status: "verified",
    destination_hash: String(challenge.destination_hash),
    channel: challenge.channel as OtpChannel,
    purpose: challenge.purpose as OtpPurpose,
    deal_id: challenge.deal_id ? String(challenge.deal_id) : null,
    verified_at: verifiedAt,
    otp_token: signOtpToken({
      challenge_id: challengeId,
      destination_hash: String(challenge.destination_hash),
      purpose: challenge.purpose as OtpPurpose,
      verified_at: verifiedAt
    })
  };
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ─── Token / verification reference ───────────────────────────────────────────

export type OtpTokenPayload = {
  challenge_id: string;
  destination_hash: string;
  purpose: OtpPurpose;
  verified_at: string;
};

// JSON body is more robust than dot-delimited because verified_at is an ISO
// timestamp that contains literal dots.
export function signOtpToken(payload: OtpTokenPayload): string {
  const json = JSON.stringify({
    c: payload.challenge_id,
    d: payload.destination_hash,
    p: payload.purpose,
    v: payload.verified_at
  });
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const sig = createHmac("sha256", getOtpTokenSecret()).update(encoded).digest("hex").slice(0, 32);
  return `v1.${encoded}.${sig}`;
}

export function verifyOtpToken(token: string): OtpTokenPayload | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const encodedBody = parts[1];
  const sig = parts[2];
  if (!encodedBody || !sig) return null;
  const expectedSig = createHmac("sha256", getOtpTokenSecret()).update(encodedBody).digest("hex").slice(0, 32);
  if (!timingSafeEqualStrings(sig, expectedSig)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const challenge_id = String(parsed?.c || "");
  const destination_hash = String(parsed?.d || "");
  const purpose = String(parsed?.p || "");
  const verified_at = String(parsed?.v || "");
  if (!challenge_id || !destination_hash || !purpose || !verified_at) return null;
  if (!isOtpPurpose(purpose)) return null;
  // Token TTL guard.
  const verifiedMs = Date.parse(verified_at);
  if (!Number.isFinite(verifiedMs)) return null;
  if (Date.now() - verifiedMs > OTP_TOKEN_TTL_MS) return null;
  return { challenge_id, destination_hash, purpose, verified_at };
}

// ─── Join enforcement helper ──────────────────────────────────────────────────

export type EnsureJoinOtpVerifiedInput = {
  otp_token?: string | null;
  otp_challenge_id?: string | null;
  deal_id: string;
  channel?: OtpChannel;
  destination?: string;
};

export type EnsureJoinOtpVerifiedResult = {
  challenge_id: string;
  destination_hash: string;
  purpose: OtpPurpose;
  channel: OtpChannel;
};

/**
 * Verify that a join request carries a valid `buyer_join` OTP proof.
 * Accepts either a signed `otp_token` (preferred) or a `otp_challenge_id` that
 * is currently `verified` in the DB.
 */
export async function ensureJoinOtpVerified(
  db: pg.Pool | pg.PoolClient,
  input: EnsureJoinOtpVerifiedInput
): Promise<EnsureJoinOtpVerifiedResult> {
  const token = String(input.otp_token || "").trim();
  const challengeId = String(input.otp_challenge_id || "").trim();
  if (!token && !challengeId) {
    throw new OtpValidationError("otp_required", 400, "otp_token or otp_challenge_id is required for join");
  }

  let payload: OtpTokenPayload | null = null;
  if (token) {
    payload = verifyOtpToken(token);
    if (!payload) throw new OtpValidationError("otp_not_verified", 400, "otp_token is invalid or expired");
  }

  const lookupId = payload?.challenge_id || challengeId;
  const row = await db.query(
    `SELECT challenge_id, channel, destination_hash, purpose, status, deal_id, expires_at, verified_at
     FROM siton.otp_challenges WHERE challenge_id=$1 LIMIT 1`,
    [lookupId]
  );
  if (!row.rowCount) throw new OtpValidationError("otp_not_verified", 400, "challenge not found");
  const challenge = row.rows[0] as any;
  if (challenge.purpose !== "buyer_join") throw new OtpValidationError("otp_not_verified", 400, "wrong otp purpose");
  if (challenge.status !== "verified") throw new OtpValidationError("otp_not_verified", 400, "challenge not verified");

  // If the challenge was bound to a deal, it must match.
  if (challenge.deal_id && String(challenge.deal_id) !== String(input.deal_id)) {
    throw new OtpValidationError("otp_not_verified", 400, "challenge bound to a different deal");
  }

  // Token TTL — challenge must have been verified recently.
  if (challenge.verified_at && Date.now() - Date.parse(challenge.verified_at) > OTP_TOKEN_TTL_MS) {
    throw new OtpValidationError("otp_not_verified", 400, "verification expired");
  }

  // If destination provided, confirm it matches the challenge so a verified token
  // for one buyer cannot be reused with a different buyer_id.
  if (input.channel && input.destination) {
    const expectedHash = hashDestination(input.channel, input.destination);
    if (expectedHash !== String(challenge.destination_hash)) {
      throw new OtpValidationError("otp_not_verified", 400, "destination does not match verified challenge");
    }
  }

  return {
    challenge_id: String(challenge.challenge_id),
    destination_hash: String(challenge.destination_hash),
    purpose: challenge.purpose as OtpPurpose,
    channel: challenge.channel as OtpChannel
  };
}
