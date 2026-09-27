// Stale-while-revalidate JWKS source (Black-Sky F-M4).
//
// The previous remote source awaited the refresh fetch (8 s timeout) on the
// request path whenever the cached set was older than its TTL, and every
// unknown-kid token forced another fetch. During a Supabase Auth outage each
// authenticated request therefore blocked up to 8 s, and a stream of tokens
// with random kids turned into a stream of outbound fetches.
//
// This source:
//   * serves a cached key set immediately, even when it is past its TTL, and
//     refreshes it in the background (stale-while-revalidate) — requests never
//     wait on a refresh while a usable set exists;
//   * runs at most ONE fetch at a time (single-flight) with a short timeout
//     (default 3 s);
//   * after a failed fetch waits `failureBackoffMs` before trying again, so a
//     cold start during an outage fails fast instead of every request paying
//     the timeout;
//   * rate-limits forced refreshes (unknown kid, key rotation) to one per
//     `minForcedRefreshMs`; a forced refresh that fails falls back to the
//     cached set (the unknown kid is then rejected by the verifier);
//   * rejects (AuthTokenError jwks_unavailable) only when NO usable key set
//     exists: never fetched successfully, or the last good set is older than
//     `maxStaleMs` (default 24 h — a revoked key must not live forever).
// Fail-closed is preserved: a missing key still means the token is rejected.

import { AuthTokenError, type Jwk, type JwksSource } from "./supabase_auth.js";

export type CachedJwksOptions = {
  ttlMs?: number;
  timeoutMs?: number;
  failureBackoffMs?: number;
  minForcedRefreshMs?: number;
  maxStaleMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onEvent?: (event: { kind: "refreshed" | "refresh_failed" | "served_stale"; reason?: string }) => void;
};

export function cachedRemoteJwks(jwksUrl: string, options: CachedJwksOptions = {}): JwksSource & { stats(): Record<string, unknown> } {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const failureBackoffMs = options.failureBackoffMs ?? 5_000;
  const minForcedRefreshMs = options.minForcedRefreshMs ?? 30_000;
  const maxStaleMs = options.maxStaleMs ?? 24 * 60 * 60_000;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  let cache: { keys: Jwk[]; fetchedAt: number } | null = null;
  let inflight: Promise<Jwk[]> | null = null;
  let lastAttemptAt = -Infinity;
  let lastFailureAt = -Infinity;
  let lastFailureReason: string | null = null;
  let fetches = 0;

  async function fetchKeys(): Promise<Jwk[]> {
    fetches += 1;
    lastAttemptAt = now();
    const res = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new AuthTokenError("jwks_fetch_failed");
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => k && typeof k === "object" && typeof k.kty === "string") : [];
    if (!keys.length) throw new AuthTokenError("jwks_empty");
    cache = { keys, fetchedAt: now() };
    lastFailureReason = null;
    options.onEvent?.({ kind: "refreshed" });
    return keys;
  }

  /** Single-flight refresh. Never rejects into an unhandled promise. */
  function refresh(): Promise<Jwk[]> {
    if (!inflight) {
      inflight = fetchKeys()
        .catch((error) => {
          lastFailureAt = now();
          lastFailureReason = error instanceof AuthTokenError ? error.reason : String((error as any)?.name || "jwks_fetch_error");
          options.onEvent?.({ kind: "refresh_failed", reason: lastFailureReason });
          throw error;
        })
        .finally(() => { inflight = null; });
      // A background refresh nobody awaits must not surface as unhandled.
      inflight.catch(() => undefined);
    }
    return inflight;
  }

  const usable = () => Boolean(cache && now() - cache.fetchedAt <= maxStaleMs);
  const inBackoff = () => now() - lastFailureAt < failureBackoffMs;

  return {
    async get(force = false) {
      const at = now();
      if (usable()) {
        const stale = at - cache!.fetchedAt >= ttlMs;
        if (force) {
          // Rotation tolerance, rate-limited: wait for ONE fresh fetch at most
          // every minForcedRefreshMs; otherwise answer from the cached set.
          if (at - lastAttemptAt >= minForcedRefreshMs && !inBackoff()) {
            try { return await refresh(); } catch { return cache!.keys; }
          }
          if (inflight) { try { return await inflight; } catch { return cache!.keys; } }
          return cache!.keys;
        }
        if (stale) {
          if (!inBackoff()) void refresh().catch(() => undefined);
          options.onEvent?.({ kind: "served_stale" });
        }
        return cache!.keys;
      }
      // No usable set: the request has to wait for keys, but a recent failure
      // answers immediately instead of making every request pay the timeout.
      if (inBackoff() && !inflight) throw new AuthTokenError("jwks_unavailable");
      try {
        return await refresh();
      } catch (err) {
        if (err instanceof AuthTokenError) throw err;
        throw new AuthTokenError("jwks_unavailable");
      }
    },
    stats() {
      return {
        fetches,
        cached_keys: cache ? cache.keys.length : 0,
        cache_age_ms: cache ? now() - cache.fetchedAt : null,
        last_failure_reason: lastFailureReason,
        refresh_in_flight: Boolean(inflight)
      };
    }
  };
}
