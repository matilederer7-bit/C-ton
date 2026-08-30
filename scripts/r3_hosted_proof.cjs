// R3 hosted proof harness for the Render-deployed Fastify Web runtime.
//
// Usage:
//   node scripts/r3_hosted_proof.cjs --base-url=https://<service>.onrender.com
//
// Optional database-identity section (runs only when the Web login secret is
// present in the environment — e.g. from the Render service shell or an
// operator machine that holds the secret):
//   R3_WEB_DATABASE_URL=<siton_web_login connection string> node scripts/r3_hosted_proof.cjs --base-url=...
//
// This script never prints connection strings, passwords or secret values.
// Failures print only status codes, PostgreSQL error codes and check names.

const SECRET_PATTERNS = [
  /postgres(?:ql)?:\/\/\S*@/i,
  /password/i,
  /DATABASE_URL/,
  /SELLER_SESSION_SECRET/,
  /ADMIN_API_KEY/,
  /\bat\s+\S+\.(?:ts|js):\d+/ // stack-trace frames
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function assertNoLeak(name, text) {
  const leak = SECRET_PATTERNS.find((pattern) => pattern.test(text));
  record(name, !leak, leak ? `response matches forbidden pattern ${String(leak)}` : "no secret material in response");
}

async function httpProofs(baseUrl) {
  const health = await fetch(`${baseUrl}/health`);
  const healthBody = await health.text();
  record("health_200", health.status === 200, `status=${health.status}`);
  record("health_shape", healthBody.trim() === JSON.stringify({ ok: true }), healthBody.slice(0, 120));

  const readiness = await fetch(`${baseUrl}/readiness`);
  const readinessBody = await readiness.json().catch(() => ({}));
  record("readiness_200", readiness.status === 200, `status=${readiness.status}`);
  record(
    "readiness_identity_is_web_profile",
    readinessBody.runtime_role === "siton_web_runtime",
    `runtime_role=${String(readinessBody.runtime_role || "absent")}`
  );
  record(
    "readiness_canonical_inventory",
    readinessBody.inventory === "siton_inventory_rpc_v1",
    `inventory=${String(readinessBody.inventory || "absent")}`
  );

  // Error safety: malformed input must return a sanitized envelope.
  const badJoin = await fetch(`${baseUrl}/deals/not-a-uuid/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bogus: true })
  });
  const badJoinText = await badJoin.text();
  record("invalid_request_client_error", badJoin.status >= 400 && badJoin.status < 500, `status=${badJoin.status}`);
  assertNoLeak("invalid_request_no_secret_leak", badJoinText);

  const unknown = await fetch(`${baseUrl}/definitely-not-a-route`);
  assertNoLeak("unknown_route_no_secret_leak", await unknown.text());

  // /api namespace aliases route to the same lifecycle implementation.
  const bare = await fetch(`${baseUrl}/deals/not-a-uuid/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const aliased = await fetch(`${baseUrl}/api/deals/not-a-uuid/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  record("api_alias_parity", bare.status === aliased.status, `bare=${bare.status} alias=${aliased.status}`);

  const publicRead = await fetch(`${baseUrl}/api/deals/00000000-0000-4000-8000-000000000000/public`);
  record(
    "api_public_deal_read_reachable",
    [200, 404].includes(publicRead.status),
    `status=${publicRead.status}`
  );

  const headersProbe = await fetch(`${baseUrl}/health`);
  record(
    "security_headers_present",
    headersProbe.headers.get("x-content-type-options") === "nosniff" &&
      headersProbe.headers.get("x-frame-options") === "DENY",
    "x-content-type-options / x-frame-options"
  );
}

async function databaseIdentityProofs(connectionString) {
  const { Client } = require("pg");
  const client = new Client({ connectionString, application_name: "r3-hosted-proof" });
  await client.connect();
  try {
    const identity = await client.query(
      "SELECT current_user AS effective, session_user AS session"
    );
    const effective = identity.rows[0].effective;
    const session = identity.rows[0].session;
    record("db_effective_role_is_web_profile", effective === "siton_web_runtime", `current_user=${effective}`);
    record("db_session_role_is_login_principal", session === "siton_web_login", `session_user=${session}`);
    record(
      "db_not_admin",
      !["postgres", "supabase_admin", "service_role"].includes(effective) &&
        !["postgres", "supabase_admin", "service_role"].includes(session),
      "no administrative identity"
    );

    async function expectDenied(name, sql) {
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("ROLLBACK");
        record(name, false, "statement unexpectedly succeeded");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const code = String((error && error.code) || "unknown");
        record(name, ["42501", "0LP01"].includes(code) || /permission denied|only roles with/i.test(String(error.message)), `code=${code}`);
      }
    }

    await expectDenied("db_ddl_denied", "CREATE TABLE siton.r3_proof_forbidden(id int)");
    await expectDenied("db_direct_inventory_denied", "SELECT count(*) FROM siton_inventory.inventory_deals");
    await expectDenied("db_worker_only_outbox_delete_denied", "DELETE FROM siton.outbox_events WHERE false");
    await expectDenied("db_browser_escalation_denied", "GRANT siton_web_runtime TO authenticated");
    await expectDenied("db_cross_profile_set_role_denied", "SET ROLE siton_worker_runtime");

    const rpcProbe = await client.query(
      "SELECT public.siton_inventory_rpc('probe', '{}'::jsonb) AS result"
    );
    const probe = rpcProbe.rows[0].result || {};
    record(
      "db_inventory_rpc_probe",
      probe.ok === true && probe.service === "siton_inventory_rpc",
      `service=${String(probe.service || "absent")}`
    );

    const webRead = await client.query("SELECT count(*)::int AS n FROM siton.deals");
    record("db_web_business_read", Number.isInteger(webRead.rows[0].n), "siton.deals readable");
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const baseUrlArg = process.argv.find((arg) => arg.startsWith("--base-url="));
  const baseUrl = baseUrlArg ? baseUrlArg.slice("--base-url=".length).replace(/\/+$/, "") : "";
  if (!baseUrl) {
    console.error("Missing --base-url=https://<render-service>");
    process.exit(2);
  }

  await httpProofs(baseUrl);

  if (process.env.R3_WEB_DATABASE_URL) {
    await databaseIdentityProofs(process.env.R3_WEB_DATABASE_URL);
  } else {
    console.log("SKIP database-identity section — R3_WEB_DATABASE_URL not present in this environment");
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\nR3_HOSTED_PROOF ${failed.length === 0 ? "PASS" : "FAIL"} passed=${results.length - failed.length} failed=${failed.length}`);
  // Let the event loop drain (undici keep-alive sockets) instead of a hard
  // process.exit, which trips a libuv teardown assert on Windows.
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  // Never echo raw error objects — they can carry connection details.
  console.error(`R3_HOSTED_PROOF ERROR ${String((error && error.code) || error.name || "unknown")}`);
  process.exitCode = 1;
});
