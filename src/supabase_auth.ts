// Supabase Auth access-token verification for the Fastify runtime.
//
// Verifies asymmetric (ES256/RS256/EdDSA) Supabase access tokens against the
// project JWKS with node:crypto only (no extra dependency). It checks the
// signature, issuer, audience, time claims, subject UUID and that the token is
// an *authenticated* user token. It deliberately does NOT read user_metadata,
// app_metadata role, or any caller-supplied actor id — those never authorize.
// Authorization is resolved separately and freshly from canonical Postgres.
//
// Failures always throw AuthTokenError (fail closed). No token material or
// signature bytes are ever logged.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export class AuthTokenError extends Error {
  readonly statusCode = 401;
  constructor(readonly reason: string) {
    super(`auth_token_invalid:${reason}`);
    this.name = "AuthTokenError";
  }
}

export interface VerifiedToken {
  sub: string;
  role: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  session_id?: string;
  email?: string;
  phone?: string;
  aal?: string;
}

export type Jwk = {
  kid?: string;
  kty: string;
  alg?: string;
  crv?: string;
  [k: string]: unknown;
};

export interface JwksSource {
  // Returns the current key set; refresh(true) forces a re-fetch (used once on
  // an unknown kid to tolerate key rotation).
  get(force?: boolean): Promise<Jwk[]>;
}

const ALLOWED_ALGS = new Set(["ES256", "RS256", "EdDSA"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64urlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSegment(segment: string): any {
  try {
    return JSON.parse(base64urlToBuffer(segment).toString("utf8"));
  } catch {
    throw new AuthTokenError("malformed_segment");
  }
}

function verifySignature(alg: string, jwk: Jwk, signingInput: string, signature: Buffer): boolean {
  let keyObject;
  try {
    keyObject = createPublicKey({ key: jwk as any, format: "jwk" });
  } catch {
    throw new AuthTokenError("bad_jwk");
  }
  const data = Buffer.from(signingInput, "utf8");
  if (alg === "ES256") {
    // JWT ES256 signatures are raw r||s (IEEE P1363), not DER.
    return cryptoVerify("sha256", data, { key: keyObject, dsaEncoding: "ieee-p1363" } as any, signature);
  }
  if (alg === "RS256") {
    return cryptoVerify("sha256", data, keyObject, signature);
  }
  if (alg === "EdDSA") {
    // Ed25519: hash is null in node's API.
    return cryptoVerify(null, data, keyObject, signature);
  }
  throw new AuthTokenError("unsupported_alg");
}

export interface VerifyOptions {
  issuer: string;
  audience: string | string[];
  jwks: JwksSource;
  now?: () => number; // seconds
  clockToleranceSec?: number;
}

export async function verifySupabaseAccessToken(token: unknown, opts: VerifyOptions): Promise<VerifiedToken> {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw) throw new AuthTokenError("missing");
  const parts = raw.split(".");
  if (parts.length !== 3) throw new AuthTokenError("not_a_jwt");
  const headerB64 = parts[0] as string;
  const payloadB64 = parts[1] as string;
  const signatureB64 = parts[2] as string;

  const header = decodeSegment(headerB64);
  const alg = String(header?.alg || "");
  if (!ALLOWED_ALGS.has(alg)) throw new AuthTokenError("alg_not_allowed");
  const kid = header?.kid ? String(header.kid) : "";

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64urlToBuffer(signatureB64);

  async function findKey(force: boolean): Promise<Jwk | null> {
    const keys = await opts.jwks.get(force);
    if (kid) return keys.find((k) => k.kid === kid) || null;
    // No kid: only safe when the JWKS has exactly one key.
    return keys.length === 1 ? (keys[0] as Jwk) : null;
  }

  let jwk = await findKey(false);
  if (!jwk) jwk = await findKey(true); // one forced refresh tolerates rotation
  if (!jwk) throw new AuthTokenError("unknown_kid");
  if (jwk.alg && jwk.alg !== alg) throw new AuthTokenError("alg_mismatch");

  let valid: boolean;
  try {
    valid = verifySignature(alg, jwk, signingInput, signature);
  } catch (err) {
    if (err instanceof AuthTokenError) throw err;
    throw new AuthTokenError("verify_failed");
  }
  if (!valid) throw new AuthTokenError("bad_signature");

  const payload = decodeSegment(payloadB64);
  const now = Math.floor((opts.now ? opts.now() : Date.now() / 1000));
  const skew = opts.clockToleranceSec ?? 5;

  if (String(payload?.iss || "") !== opts.issuer) throw new AuthTokenError("issuer");
  const audClaim = payload?.aud;
  const expectedAud = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
  const audValues = Array.isArray(audClaim) ? audClaim.map(String) : [String(audClaim || "")];
  if (!audValues.some((a) => expectedAud.includes(a))) throw new AuthTokenError("audience");

  if (typeof payload?.exp !== "number" || payload.exp + skew < now) throw new AuthTokenError("expired");
  if (typeof payload?.iat === "number" && payload.iat - skew > now) throw new AuthTokenError("iat_future");
  if (typeof payload?.nbf === "number" && payload.nbf - skew > now) throw new AuthTokenError("not_yet_valid");

  const sub = String(payload?.sub || "");
  if (!UUID_RE.test(sub)) throw new AuthTokenError("subject");

  // Only genuine end-user sessions authorize. anon / service_role tokens and
  // tokens without an authenticated role are rejected outright.
  const role = String(payload?.role || "");
  if (role !== "authenticated") throw new AuthTokenError("not_authenticated_role");

  const out: VerifiedToken = {
    sub,
    role,
    aud: audValues[0] as string,
    iss: opts.issuer,
    exp: payload.exp,
    iat: typeof payload.iat === "number" ? payload.iat : now
  };
  if (payload?.session_id) out.session_id = String(payload.session_id);
  if (payload?.email) out.email = String(payload.email);
  if (payload?.phone) out.phone = String(payload.phone);
  if (payload?.aal) out.aal = String(payload.aal);
  return out;
}

// ---- JWKS sources -------------------------------------------------------

// A static, in-memory key set (used by tests and by any pinned deployment).
export function staticJwks(keys: Jwk[]): JwksSource {
  return { async get() { return keys; } };
}

// Fetches and caches the project JWKS from Supabase, with a bounded TTL and a
// single forced refresh path for unknown-kid tolerance. Fails closed: a fetch
// error surfaces as an unknown-kid/verify failure rather than accepting a token.
export function remoteJwks(jwksUrl: string, ttlMs = 10 * 60_000): JwksSource {
  let cache: { keys: Jwk[]; fetchedAt: number } | null = null;
  let inflight: Promise<Jwk[]> | null = null;
  async function fetchKeys(): Promise<Jwk[]> {
    const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new AuthTokenError("jwks_fetch_failed");
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    if (!keys.length) throw new AuthTokenError("jwks_empty");
    cache = { keys, fetchedAt: Date.now() };
    return keys;
  }
  return {
    async get(force = false) {
      const fresh = cache && Date.now() - cache.fetchedAt < ttlMs;
      if (!force && fresh) return cache!.keys;
      if (!inflight) {
        inflight = fetchKeys().finally(() => { inflight = null; });
      }
      try {
        return await inflight;
      } catch (err) {
        // On a refresh failure keep serving a still-cached set if present.
        if (!force && cache) return cache.keys;
        if (err instanceof AuthTokenError) throw err;
        throw new AuthTokenError("jwks_unavailable");
      }
    }
  };
}

export interface SupabaseVerifier {
  verify(token: unknown): Promise<VerifiedToken>;
  issuer: string;
  audience: string;
}

// Builds a verifier from the runtime environment. SUPABASE_URL is required; the
// issuer and JWKS URL are derived from it. Audience defaults to 'authenticated'.
export function buildSupabaseVerifier(env: NodeJS.ProcessEnv = process.env, jwksOverride?: JwksSource): SupabaseVerifier | null {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!url) return null;
  const issuer = `${url}/auth/v1`;
  const audience = String(env.SUPABASE_JWT_AUD || "authenticated").trim();
  const jwks = jwksOverride || remoteJwks(`${url}/auth/v1/.well-known/jwks.json`);
  return {
    issuer,
    audience,
    verify: (token: unknown) => verifySupabaseAccessToken(token, { issuer, audience, jwks })
  };
}
