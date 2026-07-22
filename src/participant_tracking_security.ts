import { assertRequiredTables } from "./schema_contract.js";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { isProductionLikeEnv } from "./runtime_config.js";

export const PARTICIPANT_TRACKING_TOKEN_TTL_DAYS = 45;

export type TrackingPurpose = "tracking" | "recovery" | "receipt" | "support";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

let ensurePromise: Promise<void> | null = null;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createParticipantTrackingToken() {
  return randomBytes(32).toString("base64url");
}

export function hashParticipantTrackingToken(token: string) {
  return sha256(`participant-tracking:${token}`);
}

export function extractTrackingToken(req: any) {
  const auth = String(req?.headers?.authorization || "").trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return String(req?.query?.t || req?.query?.token || req?.body?.tracking_token || "").trim();
}

export function trackingMode() {
  const legacyAllowed = process.env.TRACKING_LEGACY_COMPAT === "1" || !isProductionLikeEnv();
  return {
    mode: legacyAllowed ? "mixed" : "tokenized",
    token_format: "random_high_entropy_hash_only",
    production_requires_tracking_tokens: true,
    legacy_links_allowed: legacyAllowed,
    live_blocked_without_tracking_tokens: isProductionLikeEnv() && legacyAllowed
  };
}

export async function ensureParticipantTrackingTables(withTx: <T>(fn: (c: any) => Promise<T>) => Promise<T>) {
  if (!ensurePromise) {
    ensurePromise = withTx(async (c) => assertRequiredTables(c, ["participant_tracking_tokens"]));
  }
  await ensurePromise;
}

export async function issueParticipantTrackingToken(c: Queryable, input: {
  participant_id: string;
  deal_id: string;
  purpose: TrackingPurpose;
  issued_via?: string | null;
  correlation_id?: string | null;
}) {
  const token = createParticipantTrackingToken();
  const tokenHash = hashParticipantTrackingToken(token);
  const result = await c.query(
    `INSERT INTO siton.participant_tracking_tokens
       (participant_id, deal_id, token_hash, purpose, status, expires_at, issued_via, correlation_id)
     VALUES ($1,$2,$3,$4,'Active',now()+($5 || ' days')::interval,$6,$7)
     RETURNING tracking_token_id, participant_id, deal_id, purpose, status, expires_at`,
    [
      input.participant_id,
      input.deal_id,
      tokenHash,
      input.purpose,
      String(PARTICIPANT_TRACKING_TOKEN_TTL_DAYS),
      input.issued_via || null,
      input.correlation_id || null
    ]
  );
  return { token, record: result.rows[0] };
}

export async function revokeParticipantTrackingTokens(c: Queryable, participantId: string, purpose?: TrackingPurpose) {
  const params: unknown[] = [participantId];
  const purposeClause = purpose ? `AND purpose=$2` : "";
  if (purpose) params.push(purpose);
  await c.query(
    `UPDATE siton.participant_tracking_tokens
     SET status='Revoked', revoked_at=now()
     WHERE participant_id=$1 ${purposeClause} AND status='Active'`,
    params
  );
}

export async function verifyParticipantTrackingAccess(c: Queryable, input: {
  participant_id: string;
  deal_id?: string | null;
  token: string;
  purposes: TrackingPurpose[];
}) {
  const tokenHash = hashParticipantTrackingToken(input.token);
  const result = await c.query(
    `SELECT tracking_token_id, participant_id, deal_id, purpose, status, expires_at
     FROM siton.participant_tracking_tokens
     WHERE token_hash=$1
       AND participant_id=$2
       AND purpose = ANY($3::text[])
     LIMIT 1`,
    [tokenHash, input.participant_id, input.purposes]
  );
  const row = result.rows[0];
  if (!row) return { ok: false as const, error: "tracking_token_invalid" };
  if (input.deal_id && String(row.deal_id) !== String(input.deal_id)) return { ok: false as const, error: "tracking_token_wrong_participant" };
  if (String(row.status) !== "Active") return { ok: false as const, error: "tracking_token_inactive" };
  const expiresAt = Date.parse(String(row.expires_at));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await c.query(`UPDATE siton.participant_tracking_tokens SET status='Expired' WHERE tracking_token_id=$1`, [row.tracking_token_id]);
    return { ok: false as const, error: "tracking_token_expired" };
  }
  const storedHash = Buffer.from(tokenHash, "hex");
  const recomputedHash = Buffer.from(hashParticipantTrackingToken(input.token), "hex");
  if (storedHash.length !== recomputedHash.length || !timingSafeEqual(storedHash, recomputedHash)) {
    return { ok: false as const, error: "tracking_token_invalid" };
  }
  await c.query(`UPDATE siton.participant_tracking_tokens SET last_used_at=now() WHERE tracking_token_id=$1`, [row.tracking_token_id]);
  return { ok: true as const, record: row };
}
