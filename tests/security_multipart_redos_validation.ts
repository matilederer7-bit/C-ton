// Black-Sky C1/B1 regression (CRITICAL, availability): the multipart parser was
// registered globally (every POST/PUT, anonymous routes included) under the
// 8 MB body limit, and ran `content-disposition:[^\n]*name="([^"]+)"` over each
// part. The regex backtracks quadratically: 320 KB of "content-disposition:"
// without a newline took ~2 s, so one 8 MB request blocked the single event
// loop for minutes. Against the pre-fix code the first case below takes tens of
// seconds (the timing assertion fails); after the fix form bodies are refused
// (415/413) on every route except the Grow callback, capped at 64 KB, and the
// parser is linear.
import { strict as assert } from "node:assert";

process.env.PORT = String(process.env.PORT || "3358");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";

const { app } = await import("../src/app.js");
const { parseMultipartFields } = await import("../src/frontend_runtime.js");

async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const hostile = (bytes: number) => "content-disposition:".repeat(Math.ceil(bytes / 20)).slice(0, bytes);

await run("a 1 MB crafted multipart body on an anonymous JSON route is refused fast, not parsed", async () => {
  const started = Date.now();
  const res = await app.inject({
    method: "POST",
    url: "/api/otp/request",
    headers: { "content-type": "multipart/form-data; boundary=zz" },
    payload: hostile(1024 * 1024)
  });
  const elapsed = Date.now() - started;
  assert.ok([413, 415].includes(res.statusCode), `expected 413/415, got ${res.statusCode} ${res.body.slice(0, 200)}`);
  assert.ok(elapsed < 1500, `refusal took ${elapsed} ms (event loop must not be blocked)`);
});

await run("urlencoded bodies are refused on routes other than the Grow callback", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/otp/request",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "channel=sms&destination=0500000000"
  });
  assert.equal(res.statusCode, 415, res.body);
});

await run("even on the Grow callback a form body over 64 KB is refused (413)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments/grow",
    headers: { "content-type": "multipart/form-data; boundary=zz" },
    payload: hostile(200 * 1024)
  });
  assert.equal(res.statusCode, 413, res.body.slice(0, 200));
});

await run("the linear parser extracts field parts, ignores file parts, and handles 64 KB of hostile input in milliseconds", () => {
  const body = [
    "--B",
    'Content-Disposition: form-data; name="statusCode"',
    "",
    "2",
    "--B",
    'content-disposition: form-data; name="data[transactionId]"',
    "",
    "tx-1",
    "--B",
    'Content-Disposition: form-data; name="upload"; filename="x.txt"',
    "",
    "ignored",
    "--B--",
    ""
  ].join("\r\n");
  assert.deepEqual(parseMultipartFields("multipart/form-data; boundary=B", body), { statusCode: "2", "data[transactionId]": "tx-1" });
  const started = Date.now();
  parseMultipartFields("multipart/form-data; boundary=zz", hostile(64 * 1024));
  parseMultipartFields("multipart/form-data; boundary=zz", ("--zz\r\n" + hostile(4000) + "\r\n\r\nv").repeat(15));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `parser took ${elapsed} ms on 64 KB hostile input`);
});

await app.close();
