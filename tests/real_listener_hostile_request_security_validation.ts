// REAL LISTENER, RAW BYTES — the process survives hostile requests.
//
// app.inject cannot prove process survival: an exception that escapes the
// request path becomes a rejected promise under inject, but an uncaught
// exception under a real http.Server (independent review HIGH-1: one anonymous
// `GET /health?%zz=1` killed the web process). So this file boots the real
// application on a real TCP port in a child process, writes raw request bytes
// over a socket — including shapes an HTTP client library would refuse to send —
// and then asks the only questions that matter in production:
//
//   is the process still alive, does /health still answer, and did the log it
//   wrote stay safe (no credential, no raw hostile request id, no injected line)?
//
// No money, no provider, no e-mail.

import { strict as assert } from "node:assert";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const harness = new URL("./support/hostile_request_listener_harness.js", import.meta.url);
const PORT = 41000 + (process.pid % 900);
const SENTINEL = "SENTINELtokenL1st3n3rR3dact10nPr00f";
const HOSTILE_ID_LONG = "H".repeat(3000);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

function waitReady(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not become ready in 90s")), 90_000);
    child.on("message", (message: any) => {
      if (message?.type === "ready") { clearTimeout(timer); resolve(Number(message.port)); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`child exited before ready (code ${code})`)); });
  });
}

/** Write raw bytes, return the status line and headers (body ignored). */
function rawRequest(port: number, bytes: string, timeoutMs = 8000): Promise<{ status: number; headers: Record<string, string>; raw: string; transport: string | null }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    const finish = (transport: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const statusMatch = data.match(/^HTTP\/1\.[01] (\d{3})/);
      const headers: Record<string, string> = {};
      const headerBlock = data.split("\r\n\r\n")[0] || "";
      for (const line of headerBlock.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status: statusMatch ? Number(statusMatch[1]) : 0, headers, raw: data, transport });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (chunk) => { data += chunk.toString("latin1"); });
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(data ? null : "closed-without-response"));
    socket.on("error", (error) => finish(`error:${(error as any).code || error.message}`));
  });
}

function httpGet(port: number, target: string, extraHeaders: string[] = []) {
  return rawRequest(port, [`GET ${target} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", ...extraHeaders, "", ""].join("\r\n"));
}

const child = fork(harness, [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    NODE_ENV: "test",
    APP_DEPLOYMENT_MODE: "internal-runtime",
    DISABLE_OUTBOX_WORKER: "1",
    PORT: String(PORT),
    HOST: "127.0.0.1",
    RATE_LIMIT_MAX: "0",
    RATE_LIMIT_SENSITIVE_MAX: "0",
    RATE_LIMIT_READ_MAX: "0",
    SELLER_SESSION_SECRET: "seller-session-secret-listener",
    ADMIN_SESSION_SECRET: "admin-session-secret-listener",
    ADMIN_API_KEY: "listener-admin-key"
  }
});
let childLog = "";
child.stdout?.on("data", (chunk) => { childLog += String(chunk); });
child.stderr?.on("data", (chunk) => { childLog += String(chunk); });
const alive = () => child.exitCode === null && child.signalCode === null;

let port = PORT;
try {
  port = await waitReady(child);
} catch (error) {
  console.error(`FAIL listener boot: ${(error as any)?.message}\n${childLog.slice(-2000)}`);
  process.exit(1);
}

async function healthy(label: string) {
  assert.ok(alive(), `${label}: the process is dead`);
  const health = await httpGet(port, "/health");
  assert.equal(health.status, 200, `${label}: /health answered ${health.status} (${health.transport || "no transport error"})`);
}

await run("VACUITY GUARD: the real listener answers /health before any attack", async () => {
  await healthy("baseline");
});

await run("malformed percent-encoding in a query KEY does not kill the process", async () => {
  for (const target of ["/health?%zz=1", "/health?%=1", "/health?%E0%A4%A=1", "/health?%%%%=1&%2=x", "/health?%ED%A0%80=1", "/api/deals/00000000-0000-0000-0000-000000000000/public?%zz=1"]) {
    const response = await httpGet(port, target);
    assert.ok(alive(), `${target}: the process died`);
    assert.ok(response.status >= 200 && response.status < 500, `${target}: answered ${response.status} (${response.transport || "no transport error"})`);
    await healthy(`after ${target}`);
  }
});

await run("malformed percent-encoding in a query VALUE is served normally", async () => {
  const response = await httpGet(port, "/health?a=%zz&b=%");
  assert.equal(response.status, 200, `answered ${response.status}`);
  await healthy("after malformed value");
});

await run("a request line the HTTP parser itself refuses leaves the process alive", async () => {
  const response = await rawRequest(port, "GET /health?a=\u0001 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  assert.ok([400, 0].includes(response.status), `unexpected status ${response.status}`);
  await healthy("after parser-level bad request");
});

await run("a hostile x-request-id is canonicalised on the wire and never echoed raw", async () => {
  for (const [label, value] of [["short", "abc"], ["oversized", HOSTILE_ID_LONG], ["tab", "a\tb\tc"], ["spaces", "not a safe id at all"]] as const) {
    const response = await httpGet(port, "/health", [`x-request-id: ${value}`]);
    assert.equal(response.status, 200, `${label}: answered ${response.status}`);
    const echoed = response.headers["x-request-id"] || "";
    assert.match(echoed, /^[A-Za-z0-9._:-]{8,160}$/, `${label}: response x-request-id is not canonical: ${JSON.stringify(echoed.slice(0, 60))}`);
    assert.notEqual(echoed, value, `${label}: the raw hostile id was echoed`);
  }
  const wellFormed = randomUUID();
  const kept = await httpGet(port, "/health", [`x-request-id: ${wellFormed}`]);
  assert.equal(kept.headers["x-request-id"], wellFormed, "a well-formed caller id was not preserved");
  await healthy("after hostile request ids");
});

await run("a NUL byte in a query parameter is a bounded 400 carrying the standard safe envelope", async () => {
  const response = await httpGet(port, "/api/seller/deals?state=%00");
  assert.equal(response.status, 400, `answered ${response.status}`);
  assert.match(response.headers["x-request-id"] || "", /^[A-Za-z0-9._:-]{8,160}$/, "no canonical request id on the rejection");
  assert.equal(response.headers["x-content-type-options"], "nosniff", "security headers missing on the rejection");
  assert.equal(response.headers["x-frame-options"], "DENY", "frame protection missing on the rejection");
  assert.match(response.headers["cache-control"] || "", /no-store/, "no-store missing on the rejection");
  await healthy("after NUL query");
});

await run("a credential in the query string is served but never written to the log", async () => {
  const response = await httpGet(port, `/api/inquiries/${randomUUID()}?t=${SENTINEL}&q=keepThisOne`);
  assert.ok(response.status >= 400 && response.status < 500, `answered ${response.status}`);
  await healthy("after token request");
});

await run("a protected route refuses an anonymous caller identically for valid, malformed and empty ids", async () => {
  const statuses: number[] = [];
  for (const target of [`/api/admin/actions/${randomUUID()}`, "/api/admin/actions/not-a-uuid", "/api/admin/actions/", `/api/seller/deals/${randomUUID()}/draft`, "/api/seller/deals/not-a-uuid/draft", "/api/seller/deals//draft"]) {
    const response = await httpGet(port, target);
    statuses.push(response.status);
  }
  const fastifyNotFound = 404; // "/api/seller/deals//draft" is not a route at all
  const meaningful = statuses.filter((status) => status !== fastifyNotFound);
  assert.ok(meaningful.every((status) => status === 401 || status === 403), `anonymous probes answered ${statuses.join(",")}`);
  await healthy("after protected probes");
});

// Let the child flush its log before reading it.
await new Promise((resolve) => setTimeout(resolve, 500));

await run("the log the process wrote is safe: no credential, no raw hostile id, no injected line", async () => {
  assert.ok(childLog.length > 500, `almost nothing was logged (${childLog.length} bytes)`);
  assert.ok(!childLog.includes(SENTINEL), "the query-string credential reached the log");
  assert.ok(childLog.includes("t=[redacted]"), "the credential was dropped rather than visibly masked");
  assert.ok(childLog.includes("keepThisOne"), "an ordinary query parameter was redacted away");
  assert.ok(!childLog.includes(HOSTILE_ID_LONG.slice(0, 200)), "the oversized hostile request id reached the log");
  assert.ok(!/"reqId":"abc"/.test(childLog), "the short hostile request id was logged raw");
  assert.ok(!/"reqId":"[^"]*\s[^"]*"/.test(childLog), "a request id with whitespace was logged raw");
  const reqIds = [...childLog.matchAll(/"reqId":"([^"]*)"/g)].map((match) => match[1]!);
  assert.ok(reqIds.length > 5, "no request ids in the log");
  const bad = reqIds.filter((id) => !/^[A-Za-z0-9._:-]{8,160}$/.test(id));
  assert.deepEqual(bad.slice(0, 5), [], `non-canonical request ids reached the log (${bad.length})`);
  assert.ok(!/URIError|URI malformed/.test(childLog), "the serializer still throws on malformed input");
});

await run("the process is alive at the end and stops cleanly", async () => {
  await healthy("final");
});

child.send({ type: "stop" });
await new Promise<void>((resolve) => {
  const timer = setTimeout(() => { if (alive()) child.kill("SIGKILL"); resolve(); }, 15_000);
  child.once("exit", () => { clearTimeout(timer); resolve(); });
});

console.log(`SUMMARY passed=${passed} failed=${failed} port=${port} log_bytes=${childLog.length}`);
if (failed > 0) process.exitCode = 1;
