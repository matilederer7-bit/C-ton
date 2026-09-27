// Content-Security-Policy for every HTML response (red-team residual "CSP not
// yet set"). Applied centrally by the onSend hook in app.ts so no HTML surface
// (React app under /preview, legacy shell under /app, share redirect, legal
// pages, payment return pages) can ship without it.
//
// Policy shape:
//   * scripts: same-origin files only, plus the SHA-256 of each KNOWN, TRUSTED
//     inline <script> block — registered at startup from the shipped shell
//     templates (web/dist/index.html, frontend/index.html) and the constant
//     share-redirect snippet. The policy is NEVER derived from the outgoing
//     response (Codex on PR #97): a stored/reflected injection that reached an
//     HTML template as <script>…</script> would otherwise be hashed and
//     blessed by its own response. An unregistered inline script is blocked.
//     No 'unsafe-inline', no 'unsafe-eval', no third-party script hosts.
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

export function inlineScriptHash(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of String(html || "").matchAll(INLINE_SCRIPT_RE)) {
    const body = match[1] ?? "";
    if (!body.trim()) continue;
    hashes.push(inlineScriptHash(body));
  }
  return hashes;
}

// The fixed allow-list of trusted inline scripts. Populated ONLY at startup by
// the code that owns the shell templates (registerTrustedInlineScripts /
// registerTrustedInlineScript); request handling never adds to it.
const trustedInlineScriptHashes = new Set<string>();

export function registerTrustedInlineScript(body: string) {
  if (String(body || "").trim()) trustedInlineScriptHashes.add(inlineScriptHash(body));
  invalidatePolicyCache();
}

export function registerTrustedInlineScripts(html: string) {
  for (const match of String(html || "").matchAll(INLINE_SCRIPT_RE)) {
    const body = match[1] ?? "";
    if (body.trim()) trustedInlineScriptHashes.add(inlineScriptHash(body));
  }
  invalidatePolicyCache();
}

export function trustedInlineScriptHashList(): string[] {
  return [...trustedInlineScriptHashes];
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

export function buildContentSecurityPolicy(env: NodeJS.ProcessEnv = process.env, scriptHashes: string[] = trustedInlineScriptHashList()): string {
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

let cachedPolicy: { key: string; value: string } | null = null;
function invalidatePolicyCache() { cachedPolicy = null; }

// The one policy every HTML response carries (per SUPABASE_URL). It depends
// only on startup-registered hashes and env, never on the response body.
export function contentSecurityPolicy(env: NodeJS.ProcessEnv = process.env): string {
  const key = String(env.SUPABASE_URL || "");
  if (cachedPolicy && cachedPolicy.key === key) return cachedPolicy.value;
  const value = buildContentSecurityPolicy(env);
  cachedPolicy = { key, value };
  return value;
}

export function isHtmlContentType(contentType: unknown): boolean {
  return /^text\/html\b/i.test(String(contentType || ""));
}
