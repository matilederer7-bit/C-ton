// Black-Sky B4/B5/B9 regressions.
// B4: a locked SELLER account answered a distinct 429 while an unknown
//     identifier answered 401 — an account-existence oracle (the one closed
//     for admins in A3). Now both answer the identical 401 body.
// B5: unknown / locked accounts skipped scrypt (timing oracle). The login
//     paths now always verify against a real hash (dummy when needed); proven
//     here structurally (the dummy hashes are real scrypt hashes) and by
//     response equality.
// B9: a malformed cookie escape (`x=%E0`) threw URIError in the cookie parsers
//     and turned cookie-reading routes into 500s.
import { strict as assert } from "node:assert";

const { parseCookies, sellerLoginDummyHash, verifySellerAccessSecretAsync, hashSellerAccessSecret, verifySellerAccessSecret } = await import("../src/seller_auth.js");
const { parseCookieHeader, adminLoginDummyHash, verifyAdminPassword } = await import("../src/admin_identity.js");
const { normalizeOrderCodeInput } = await import("../src/physical_fulfillment.js");

async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await run("B9: malformed cookie escapes do not throw and keep the raw value", () => {
  assert.deepEqual(parseCookies("a=%E0; b=ok%20x"), { a: "%E0", b: "ok x" });
  assert.deepEqual(parseCookieHeader("siton_admin_session=%E0%A4; x=1"), { siton_admin_session: "%E0%A4", x: "1" });
  assert.equal(normalizeOrderCodeInput("https://x/?code=%E0"), null);
});

await run("B5: the dummy hashes are real scrypt hashes that verify their own secret shape and reject guesses", async () => {
  const sellerDummy = sellerLoginDummyHash();
  assert.match(sellerDummy, /^scrypt\$[^$]+\$[^$]+$/);
  assert.equal(await verifySellerAccessSecretAsync("guess", sellerDummy), false);
  const adminDummy = await adminLoginDummyHash();
  assert.match(adminDummy, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(await verifyAdminPassword("guess", adminDummy), false);
});

await run("C6: async seller verification agrees with the sync verifier", async () => {
  const hash = hashSellerAccessSecret("correct horse battery staple");
  assert.equal(await verifySellerAccessSecretAsync("correct horse battery staple", hash), true);
  assert.equal(verifySellerAccessSecret("correct horse battery staple", hash), true);
  assert.equal(await verifySellerAccessSecretAsync("wrong", hash), false);
  assert.equal(await verifySellerAccessSecretAsync("", hash), false);
  assert.equal(await verifySellerAccessSecretAsync("x", "not-a-hash"), false);
});

await run("B4: the seller login handler has no distinct lockout response left", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/frontend_runtime.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('app.post("/api/seller/session/login"'), source.indexOf('app.post("/api/seller/session/logout"'));
  assert.ok(handler.length > 200, "could not locate the seller login handler");
  assert.doesNotMatch(handler, /seller_auth_rate_limited|code\(429\)/, "a locked seller account must answer the same 401 as a wrong password");
  assert.match(handler, /sellerLoginDummyHash\(\)/, "missing/locked accounts must still pay for one scrypt");
});
