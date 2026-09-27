// Content-Security-Policy for every HTML response (red-team residual "CSP not
// yet set"). Applied centrally by the onSend hook in app.ts so no HTML surface
// (React app under /preview, legacy shell under /app, share redirect, legal
// pages, payment return pages) can ship without it.
//
// Policy shape:
//   * scripts: same-origin files only, plus the SHA-256 of each inline
//     <script> block actually present in THIS document (the SPA shells carry a
//     small pre-hydration language script; the share redirect carries a
//     location.replace). No 'unsafe-inline', no 'unsafe-eval', no third-party
//     script hosts.
//   * styles: same-origin + Google Fonts stylesheet + inline styles (React
//     style props / pre-hydration <style>); fonts from Google Fonts.
//   * images: same-origin, data:/blob: (uploads, QR), and https: (product
//     images served from the object store / Supabase public buckets).
//   * connect: same-origin API + Supabase (browser auth for the seller login)
//     + the payment provider hosts (hosted checkout status) — nothing else.
//   * frames: the page may not be framed (frame-ancestors 'none', matching
//     X-Frame-Options: DENY) and may only frame the payment provider hosts.
//   * base-uri/object-src locked; forms post same-origin only.
import { createHash } from "node:crypto";

const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of String(html || "").matchAll(INLINE_SCRIPT_RE)) {
    const body = match[1] ?? "";
    if (!body.trim()) continue;
    hashes.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return hashes;
}

function supabaseConnectSources(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>(["https://*.supabase.co", "https://*.supabase.in", "wss://*.supabase.co"]);
  const configured = String(env.SUPABASE_URL || "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      out.add(`${url.protocol}//${url.host}`);
      out.add(`wss://${url.host}`);
    } catch {
      // ignore an unparsable SUPABASE_URL; the wildcard entries still apply
    }
  }
  return [...out];
}

const PAYMENT_HOSTS = ["https://secure.meshulam.co.il", "https://sandbox.meshulam.co.il", "https://*.stripe.com"];

export function buildContentSecurityPolicy(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const scriptHashes = inlineScriptHashes(html);
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'", ...PAYMENT_HOSTS]],
    ["script-src", ["'self'", ...scriptHashes]],
    ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]],
    ["font-src", ["'self'", "data:", "https://fonts.gstatic.com"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["media-src", ["'self'", "blob:", "data:"]],
    ["connect-src", ["'self'", ...supabaseConnectSources(env), ...PAYMENT_HOSTS, "https://*.ingest.sentry.io", "https://*.ingest.de.sentry.io"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["frame-src", [...PAYMENT_HOSTS]]
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

// Bounded per-document cache: the SPA shells are a handful of distinct
// documents; hashing them once per process is enough.
const cache = new Map<string, string>();
const CACHE_LIMIT = 64;

export function contentSecurityPolicyFor(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash("sha256").update(html, "utf8").digest("hex") + "|" + String(env.SUPABASE_URL || "");
  const hit = cache.get(key);
  if (hit) return hit;
  const value = buildContentSecurityPolicy(html, env);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

export function isHtmlContentType(contentType: unknown): boolean {
  return /^text\/html\b/i.test(String(contentType || ""));
}
