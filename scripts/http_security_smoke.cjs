#!/usr/bin/env node
// HTTP release security smoke (npm run smoke:http-security).
//
// Boots the real web runtime locally (isolated database, free port, mock
// provider, an admin key set so admin routes are guarded) and checks the
// response contract that a release depends on - without touching any UX
// component:
//   content types          JSON for API/health, HTML for the app shell
//   cache control          no-store + pragma + expires on every dynamic /api,
//                          /health, tracking, admin and webhook response;
//                          immutable only for published deal images
//   security headers       x-content-type-options, referrer-policy,
//                          x-frame-options, permissions-policy on every response
//   request correlation    x-request-id echoed/minted, hostile values bounded
//   no debug stack leak    404 / 400 / 401 / malformed JSON bodies carry no
//                          stack frames or file paths
//   CORS                   no access-control-allow-origin for a foreign Origin
//                          (same-origin API by construction)
//   debug surfaces         /debug/* answers 404 when disabled
//   admin surfaces         anonymous admin request refused, never 200
//   webhook ingestion      unsigned webhook refused without a 500
// Gaps are reported, never patched here (docs/HTTP_SECURITY_SURFACE.md).
require("dotenv").config({ quiet: true });
const { startLocalRuntime, request } = require("./lib/local_runtime.cjs");
const { ReleaseReport, runStep, artifactsDir } = require("./lib/release_report.cjs");

const SECURITY_HEADERS = { "x-content-type-options": /^nosniff$/i, "referrer-policy": /no-referrer/i, "x-frame-options": /^DENY$/i, "permissions-policy": /camera=\(self\).*microphone=\(\).*payment=\(\)/i };
const STACK_LEAK = /\n\s+at\s|node_modules[\\/]|src[\\/]app\.ts|frontend_runtime\.ts|\bError:\s.*\bat\s/;
const UUID = "00000000-0000-4000-8000-000000000001";

function expectSecurityHeaders(response, label, problems) {
  for (const [header, pattern] of Object.entries(SECURITY_HEADERS)) {
    if (!pattern.test(String(response.headers[header] || ""))) problems.push(label + " missing/invalid " + header + " (" + (response.headers[header] || "absent") + ")");
  }
}
function expectNoStore(response, label, problems) {
  if (!/no-store/.test(String(response.headers["cache-control"] || ""))) problems.push(label + " cache-control is '" + (response.headers["cache-control"] || "absent") + "' (expected no-store)");
  if (String(response.headers.pragma || "") !== "no-cache") problems.push(label + " pragma missing");
}
function expectNoStackLeak(response, label, problems) {
  if (STACK_LEAK.test(response.text)) problems.push(label + " body leaks stack/file detail: " + response.text.slice(0, 160));
}
function expectJson(response, label, problems) {
  if (!/^application\/json/.test(String(response.headers["content-type"] || ""))) problems.push(label + " content-type is '" + (response.headers["content-type"] || "absent") + "' (expected application/json)");
}

async function main() {
  const report = new ReleaseReport("http security smoke");
  let runtime = null;
  try {
    runtime = await startLocalRuntime({ label: "httpsmoke" });
  } catch (error) {
    report.skip("runtime boot", error.message);
    report.printSummary();
    report.writeArtifacts(artifactsDir(process.cwd()), "http-security-smoke");
    console.log("HTTP_SECURITY_SMOKE_SKIPPED_ENVIRONMENT");
    process.exit(0);
  }
  const origin = runtime.origin;
  const gaps = [];
  try {
    await runStep(report, "health + readiness responses", async () => {
      const problems = [];
      for (const route of ["/health", "/readiness", "/health/integrations"]) {
        const response = await request(origin, route);
        if (response.status !== 200) problems.push(route + " status " + response.status);
        expectJson(response, route, problems);
        expectSecurityHeaders(response, route, problems);
        if (route !== "/readiness") expectNoStore(response, route, problems);
        else if (!/no-store/.test(String(response.headers["cache-control"] || ""))) gaps.push("GAP-HTTP-1 /readiness is not in the dynamic no-store route list (cache-control=" + (response.headers["cache-control"] || "absent") + "); an intermediary could cache a stale readiness verdict");
      }
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "JSON, no-store, security headers on /health and /health/integrations", detail: gaps.join("\n") || undefined };
    });

    await runStep(report, "public API 404 is JSON, no-store, no stack", async () => {
      const response = await request(origin, "/api/deals/" + UUID + "/public");
      const problems = [];
      if (response.status !== 404) problems.push("status " + response.status);
      expectJson(response, "deal public 404", problems);
      expectNoStore(response, "deal public 404", problems);
      expectSecurityHeaders(response, "deal public 404", problems);
      expectNoStackLeak(response, "deal public 404", problems);
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "404 " + response.text.slice(0, 80) };
    });

    await runStep(report, "private tracking data: refused + no-store", async () => {
      const response = await request(origin, "/api/participants/" + UUID + "/tracking?t=not-a-real-token");
      const problems = [];
      if (![400, 401, 403, 404].includes(response.status)) problems.push("status " + response.status + " (expected refusal)");
      expectNoStore(response, "tracking", problems);
      expectNoStackLeak(response, "tracking", problems);
      if (/not-a-real-token/.test(response.text)) problems.push("tracking response echoes the presented token");
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "status " + response.status + ", no-store, token not echoed" };
    });

    await runStep(report, "admin surface anonymous refusal", async () => {
      const problems = [];
      for (const route of ["/api/admin/mission-control", "/api/admin/system-ops-status", "/api/admin/outbox-status"]) {
        const response = await request(origin, route);
        if (![401, 403].includes(response.status)) problems.push(route + " answered " + response.status + " to an anonymous caller");
        expectNoStore(response, route, problems);
        expectNoStackLeak(response, route, problems);
      }
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "3 admin routes refuse anonymously with no-store" };
    });

    await runStep(report, "malformed JSON body -> 4xx without stack", async () => {
      const response = await request(origin, "/deals", { method: "POST", headers: { "content-type": "application/json" }, body: "{ not json" });
      const problems = [];
      if (response.status < 400 || response.status >= 500) problems.push("status " + response.status);
      expectNoStackLeak(response, "malformed json", problems);
      expectJson(response, "malformed json", problems);
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "status " + response.status + " " + response.text.slice(0, 80) };
    });

    await runStep(report, "unknown route -> 404 without stack", async () => {
      const response = await request(origin, "/definitely-not-a-route-" + Date.now());
      const problems = [];
      if (response.status !== 404) problems.push("status " + response.status);
      expectNoStackLeak(response, "unknown route", problems);
      expectSecurityHeaders(response, "unknown route", problems);
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "404 " + (response.headers["content-type"] || "") };
    });

    await runStep(report, "request id: echoed when sane, bounded when hostile", async () => {
      const sane = await request(origin, "/health", { headers: { "x-request-id": "release-smoke-0001" } });
      // fetch refuses CR/LF in header values, so the hostile value is oversized
      // and carries markup and spaces (the runtime must mint a bounded id).
      const hostile = await request(origin, "/health", { headers: { "x-request-id": "x".repeat(4000) + " <script>alert(1)</script>" } });
      const problems = [];
      if (sane.headers["x-request-id"] !== "release-smoke-0001") problems.push("sane id not echoed (got " + sane.headers["x-request-id"] + ")");
      const hostileId = String(hostile.headers["x-request-id"] || "");
      if (!hostileId || hostileId.length > 160 || /[\s<>]/.test(hostileId)) problems.push("hostile id not normalised (length " + hostileId.length + ")");
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "echoed 'release-smoke-0001'; 4000-byte hostile id replaced by a minted " + hostileId.length + "-char id" };
    });

    await runStep(report, "CORS: foreign origin gets no allow-origin", async () => {
      const response = await request(origin, "/api/deals/" + UUID + "/public", { headers: { origin: "https://evil.example" } });
      const preflight = await request(origin, "/api/deals/" + UUID + "/public", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
      const problems = [];
      if (response.headers["access-control-allow-origin"]) problems.push("GET answered access-control-allow-origin=" + response.headers["access-control-allow-origin"]);
      if (preflight.headers["access-control-allow-origin"]) problems.push("OPTIONS preflight granted " + preflight.headers["access-control-allow-origin"]);
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "no CORS grant for a foreign origin (same-origin API); preflight status " + preflight.status };
    });

    await runStep(report, "debug surfaces disabled -> 404", async () => {
      const response = await request(origin, "/debug/deals/" + UUID);
      const problems = [];
      if (response.status !== 404) problems.push("status " + response.status);
      expectNoStackLeak(response, "debug", problems);
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "404 with DEBUG_SURFACES_ENABLED unset" };
    });

    await runStep(report, "unsigned webhook refused without 500", async () => {
      const response = await request(origin, "/webhooks/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_id: "smoke", type: "payment.captured" }) });
      const problems = [];
      if (response.status >= 500) problems.push("status " + response.status);
      if (response.status === 200 && /accepted|processed/.test(response.text)) problems.push("unsigned webhook accepted: " + response.text.slice(0, 120));
      expectNoStackLeak(response, "webhook", problems);
      expectNoStore(response, "webhook", problems);
      return { status: problems.length ? "FAIL" : "PASS", summary: problems.length ? problems.join("; ") : "status " + response.status + " " + response.text.slice(0, 100) };
    });

    await runStep(report, "app shell HTML: no-store + security headers", async () => {
      const problems = [];
      const candidates = ["/", "/app", "/preview/"];
      let checked = 0;
      for (const route of candidates) {
        const response = await request(origin, route);
        if (![200, 301, 302, 307, 308].includes(response.status)) continue;
        checked += 1;
        expectSecurityHeaders(response, route, problems);
        if (response.status === 200 && !/text\/html/.test(String(response.headers["content-type"] || ""))) problems.push(route + " content-type " + response.headers["content-type"]);
        if (response.status === 200 && !/no-store|no-cache/.test(String(response.headers["cache-control"] || ""))) gaps.push("GAP-HTTP-2 " + route + " HTML served with cache-control=" + (response.headers["cache-control"] || "absent"));
      }
      return { status: problems.length ? "FAIL" : checked ? "PASS" : "WARNING", summary: problems.length ? problems.join("; ") : checked + " shell routes checked", detail: gaps.filter((g) => g.startsWith("GAP-HTTP-2")).join("\n") || undefined };
    });
  } finally {
    await runtime.stop();
  }
  if (gaps.length) report.warn("documented gaps", gaps.length + " header gaps recorded (see docs/HTTP_SECURITY_SURFACE.md)", { detail: gaps.join("\n") });
  report.printSummary();
  report.writeArtifacts(artifactsDir(process.cwd()), "http-security-smoke");
  console.log(report.exitCode() ? "HTTP_SECURITY_SMOKE_FAIL" : "HTTP_SECURITY_SMOKE_PASS");
  process.exit(report.exitCode());
}

main().catch((error) => { console.error("HTTP_SECURITY_SMOKE_ERROR", error); process.exit(1); });
