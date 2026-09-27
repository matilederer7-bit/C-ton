import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import nodePath from "node:path";
import pg from "pg";
import "dotenv/config";
import {
  assertGrowConfig,
  buildGrowPaymentAdapter,
  buildGrowReferenceKeyring,
  deriveGrowReferenceKeyId,
  growConfigFromEnv,
  growReferenceFormat,
  openGrowReference,
  openGrowReferenceDetailed,
  resealGrowReference,
  sealGrowReference,
  type GrowConfig,
  type GrowProviderReference
} from "../src/grow_payment_adapter.js";

// Grow sealed-reference KEYRING (rotation) regression.
//
// Before: one key, format grow_ref_v1 with no key id — rotating
// GROW_REFERENCE_ENCRYPTION_KEY made every stored reference undecryptable.
// Now: new seals are grow_ref_v2.<kid>.…; v1 legacy references still open
// with the primary or any configured previous key; v2 opens by kid; unknown
// kid / tampered ciphertext fail closed with "grow_reference_invalid".
// The re-seal tool (scripts/grow_reference_reseal.cjs) mirrors the crypto and
// is proven interoperable here. No network, no provider call, no money.

const KEY_A = "grow-reference-key-A-test-only-0123456789abcdef";
const KEY_B = "grow-reference-key-B-test-only-fedcba9876543210";
const KEY_C = "grow-reference-key-C-test-only-unrelated-key-000";
const REF: GrowProviderReference = { process_id: "p-100", process_token: "ptoken-100", transaction_id: "tx-100", transaction_token: "tx-token-100" };

const baseConfig: GrowConfig = {
  base_url: "https://sandbox.meshulam.co.il/api/light/server/1.0",
  environment: "sandbox",
  user_id: "sandbox-user",
  page_code: "sandbox-page",
  api_key: "",
  reference_encryption_key: KEY_A,
  success_url: "https://example.invalid/pay/success",
  cancel_url: "https://example.invalid/pay/cancel",
  notify_url: "https://example.invalid/webhooks/payments/grow",
  timeout_ms: 1000,
  paths: { create: "/createPaymentProcess", process_info: "/getPaymentProcessInfo", settle: "/settleSuspendedTransaction", refund: "/refundTransaction", transaction_info: "/getTransactionInfo", approve: "/approveTransaction" }
};

/** Exact legacy v1 algorithm (pre-keyring adapter) to produce stored-format fixtures. */
function legacySealV1(reference: GrowProviderReference, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(reference), "utf8"), cipher.final()]);
  return `grow_ref_v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function tamper(value: string, partIndex: number) {
  const parts = value.split(".");
  const bytes = Buffer.from(parts[partIndex]!, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  parts[partIndex] = bytes.toString("base64url");
  return parts.join(".");
}

const tool = createRequire(import.meta.url)(nodePath.join(process.cwd(), "scripts", "grow_reference_reseal.cjs"));

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await check("legacy grow_ref_v1 references still open (plain-string key API unchanged)", () => {
  const legacy = legacySealV1(REF, KEY_A);
  assert.deepEqual(openGrowReference(legacy, KEY_A), REF);
  assert.deepEqual(growReferenceFormat(legacy), { format: "v1", kid: null });
});

await check("new seals are grow_ref_v2.<kid> and round-trip; default kid is a domain-separated 8-hex hash (never a slice of the AES key)", () => {
  const sealed = sealGrowReference(REF, KEY_A);
  const kid = deriveGrowReferenceKeyId(KEY_A);
  assert.match(kid, /^[0-9a-f]{8}$/);
  assert.notEqual(kid, createHash("sha256").update(KEY_A).digest("hex").slice(0, 8), "kid must not reveal AES key bits");
  assert.equal(sealed.startsWith(`grow_ref_v2.${kid}.`), true);
  assert.deepEqual(growReferenceFormat(sealed), { format: "v2", kid });
  assert.deepEqual(openGrowReference(sealed, KEY_A), REF);
  assert.equal(sealed.includes("ptoken-100"), false);
  const explicit = buildGrowReferenceKeyring({ primary_key: KEY_A, primary_key_id: "a" });
  const withKid = sealGrowReference(REF, explicit);
  assert.equal(withKid.startsWith("grow_ref_v2.a."), true);
  assert.deepEqual(openGrowReference(withKid, explicit), REF);
});

await check("rotation: seal with A (kid a) → primary B with A previous → old v1+v2 refs open, new seals use B; B-only ring cannot open A refs", () => {
  const ringA = buildGrowReferenceKeyring({ primary_key: KEY_A, primary_key_id: "a" });
  const oldV2 = sealGrowReference(REF, ringA);
  const oldV1 = legacySealV1(REF, KEY_A);
  const ringB = buildGrowReferenceKeyring({ primary_key: KEY_B, primary_key_id: "b", previous_keys: `a:${KEY_A}` });
  assert.deepEqual(openGrowReferenceDetailed(oldV2, ringB), { reference: REF, format: "v2", kid: "a" });
  assert.deepEqual(openGrowReferenceDetailed(oldV1, ringB), { reference: REF, format: "v1", kid: "a" });
  const fresh = sealGrowReference(REF, ringB);
  assert.equal(fresh.startsWith("grow_ref_v2.b."), true);
  assert.deepEqual(openGrowReferenceDetailed(fresh, ringB), { reference: REF, format: "v2", kid: "b" });
  // A previous key given without a kid gets the derived kid.
  const ringDerived = buildGrowReferenceKeyring({ primary_key: KEY_B, previous_keys: [KEY_A] });
  assert.deepEqual(openGrowReference(oldV1, ringDerived), REF);
  assert.deepEqual(openGrowReference(sealGrowReference(REF, KEY_A), ringDerived), REF);
  // Without A configured, A's refs fail closed.
  const bOnly = buildGrowReferenceKeyring({ primary_key: KEY_B, primary_key_id: "b" });
  assert.throws(() => openGrowReference(oldV2, bOnly), /^Error: grow_reference_invalid$/);
  assert.throws(() => openGrowReference(oldV1, bOnly), /^Error: grow_reference_invalid$/);
  // Re-seal moves a ref onto the primary; already-current refs do not churn.
  const moved = resealGrowReference(oldV1, ringB);
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.from, { format: "v1", kid: "a" });
  assert.deepEqual(openGrowReferenceDetailed(moved.value, bOnly), { reference: REF, format: "v2", kid: "b" });
  assert.deepEqual(resealGrowReference(fresh, ringB), { value: fresh, changed: false, from: { format: "v2", kid: "b" } });
});

await check("unknown kid, kid swap, tampered iv/tag/ciphertext, bad framing → the same fail-closed grow_reference_invalid (never garbage, never a crash)", () => {
  const ring = buildGrowReferenceKeyring({ primary_key: KEY_B, primary_key_id: "b", previous_keys: `a:${KEY_A}` });
  const sealed = sealGrowReference(REF, ring);
  const parts = sealed.split(".");
  const cases = [
    ["unknown kid", ["grow_ref_v2", "zzz", ...parts.slice(2)].join(".")],
    ["kid swapped to another configured key", ["grow_ref_v2", "a", ...parts.slice(2)].join(".")],
    ["tampered iv", tamper(sealed, 2)],
    ["tampered tag", tamper(sealed, 3)],
    ["tampered ciphertext", tamper(sealed, 4)],
    ["tampered legacy v1 ciphertext", tamper(legacySealV1(REF, KEY_A), 3)],
    ["v2 relabelled as v1", ["grow_ref_v1", ...parts.slice(2)].join(".")],
    ["truncated", parts.slice(0, 4).join(".")],
    ["unknown version", ["grow_ref_v9", ...parts.slice(1)].join(".")],
    ["empty", ""],
    ["unrelated key", sealGrowReference(REF, KEY_C)]
  ] as const;
  for (const [label, value] of cases) {
    assert.throws(() => openGrowReference(value, ring), (error: Error) => error.message === "grow_reference_invalid", label);
  }
  // A valid ciphertext that is not a reference payload is also rejected.
  assert.throws(() => openGrowReference(sealGrowReference({ process_id: "", process_token: "" }, ring), ring), /grow_reference_invalid/);
});

await check("keyring configuration is validated fail-closed (short previous key, bad kid, kid conflict) and read from the environment", () => {
  assert.throws(() => buildGrowReferenceKeyring({ primary_key: "short" }), /grow_reference_encryption_key_missing/);
  assert.throws(() => buildGrowReferenceKeyring({ primary_key: KEY_A, previous_keys: "short-previous" }), /grow_reference_previous_key_invalid/);
  assert.throws(() => buildGrowReferenceKeyring({ primary_key: KEY_A, primary_key_id: "bad.kid" }), /grow_reference_key_id_invalid/);
  assert.throws(() => buildGrowReferenceKeyring({ primary_key: KEY_A, primary_key_id: "x", previous_keys: `x:${KEY_B}` }), /grow_reference_key_id_conflict/);
  const saved = { ...process.env };
  try {
    process.env.GROW_REFERENCE_ENCRYPTION_KEY_ID = "b";
    process.env.GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS = ` a:${KEY_A} , ${KEY_C} `;
    const fromEnv = growConfigFromEnv();
    assert.equal(fromEnv.reference_encryption_key_id, "b");
    const config = { ...baseConfig, reference_encryption_key: KEY_B, reference_encryption_key_id: fromEnv.reference_encryption_key_id!, reference_previous_keys: fromEnv.reference_previous_keys! };
    assertGrowConfig(config);
    const summary = buildGrowPaymentAdapter({ config, transport: async () => { throw new Error("no network"); } }).configurationSummary() as Record<string, unknown>;
    assert.equal(summary.reference_primary_key_id, "b");
    assert.equal(summary.reference_previous_key_count, 2);
    assert.equal(summary.reference_seal_format, "grow_ref_v2");
    assert.equal(JSON.stringify(summary).includes(KEY_A), false, "no key material in the summary");
    assert.throws(() => assertGrowConfig({ ...config, reference_previous_keys: "too-short" }), /GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS_entries_must_be_at_least_32_characters/);
    assert.equal(buildGrowPaymentAdapter({ config: { ...config, reference_encryption_key_id: "bad kid!" } }).configured, false);
  } finally {
    for (const name of ["GROW_REFERENCE_ENCRYPTION_KEY_ID", "GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS"]) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});


await check("adapter after rotation: settles a reference sealed under the old key, returns a reference sealed under the new primary; an unopenable reference never reaches the provider", async () => {
  const oldRef = legacySealV1(REF, KEY_A);
  const urls: string[] = [];
  const rotated = buildGrowPaymentAdapter({
    config: { ...baseConfig, reference_encryption_key: KEY_B, reference_encryption_key_id: "b", reference_previous_keys: `a:${KEY_A}` },
    transport: async (request) => { urls.push(request.url); return { status: 200, body: { status: 1, err: "", data: { transactionId: "tx-100", transactionToken: "tx-token-100" } } }; }
  });
  const captured = await rotated.capture(oldRef, 1000);
  assert.equal(captured.result_class, "success");
  assert.equal(String(captured.provider_reference).startsWith("grow_ref_v2.b."), true);
  assert.deepEqual(openGrowReference(String(captured.provider_reference), buildGrowReferenceKeyring({ primary_key: KEY_B, primary_key_id: "b" })), REF);
  const status = await rotated.status(oldRef);
  assert.equal(status.error_code, null);
  const bOnly = buildGrowPaymentAdapter({
    config: { ...baseConfig, reference_encryption_key: KEY_B, reference_encryption_key_id: "b" },
    transport: async (request) => { urls.push(`UNEXPECTED ${request.url}`); return { status: 200, body: { status: 1 } }; }
  });
  const invalidStatus = await bOnly.status(oldRef);
  assert.equal(invalidStatus.error_code, "grow_reference_invalid");
  assert.equal(invalidStatus.final, false);
  await assert.rejects(() => bOnly.capture(oldRef, 1000), /grow_reference_invalid/);
  assert.equal(urls.some((url) => url.startsWith("UNEXPECTED")), false, "no provider request for an unopenable reference");
});

await check("re-seal tool crypto interoperates with the adapter in both directions and guards hosted targets", () => {
  const ring = tool.buildKeyring({ primary_key: KEY_B, primary_key_id: "b", previous_keys: `a:${KEY_A}` });
  const tsRing = buildGrowReferenceKeyring({ primary_key: KEY_B, primary_key_id: "b", previous_keys: `a:${KEY_A}` });
  assert.equal(tool.deriveKeyId(KEY_A), deriveGrowReferenceKeyId(KEY_A));
  // adapter-sealed → tool opens; tool-sealed → adapter opens
  assert.deepEqual(tool.openReference(sealGrowReference(REF, tsRing), ring).reference, REF);
  assert.deepEqual(tool.openReference(legacySealV1(REF, KEY_A), ring).kid, "a");
  assert.deepEqual(openGrowReferenceDetailed(tool.sealReference(REF, ring), tsRing), { reference: REF, format: "v2", kid: "b" });
  assert.throws(() => tool.openReference(tamper(sealGrowReference(REF, tsRing), 4), ring), /grow_reference_invalid/);
  assert.deepEqual(tool.referenceFormat("grow_ref_v2.b.x.y.z"), growReferenceFormat("grow_ref_v2.b.x.y.z"));
  // target guard
  assert.deepEqual(tool.assertTarget("postgresql://postgres@127.0.0.1:5433/x", []), { host: "127.0.0.1", hosted: false });
  assert.throws(() => tool.assertTarget("postgresql://u@db.example.supabase.co:5432/postgres", []), /refuses non-local/);
  assert.throws(() => tool.assertTarget("postgresql://u@db.example.supabase.co:5432/postgres", ["--allow-hosted"]), /refuses non-local/);
  assert.throws(() => tool.assertTarget("postgresql://u@db.example.supabase.co:5432/postgres", ["--yes"]), /refuses non-local/);
  assert.equal(tool.assertTarget("postgresql://u@db.example.supabase.co:5432/postgres", ["--allow-hosted", "--yes"]).hosted, true);
});

await check("re-seal tool on an isolated database: dry-run inventory per format/kid; --apply re-seals ONLY bindings.provider_reference in one transaction and leaves authorization_id untouched", async () => {
  const databaseUrl = String(process.env.DATABASE_URL || "");
  assert.ok(databaseUrl, "DATABASE_URL is required (isolated test database)");
  tool.assertTarget(databaseUrl, []);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const dealId = randomUUID();
    await client.query(
      `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
       VALUES ($1,'seller-grow-keyring','Charging','keyring deal',10,1,50,1,now()+interval '1 day',now())`,
      [dealId]
    );
    const ringA = buildGrowReferenceKeyring({ primary_key: KEY_A, primary_key_id: "a" });
    const v1Handle = legacySealV1(REF, KEY_A);
    const v2Old = sealGrowReference(REF, ringA);
    const foreign = sealGrowReference(REF, KEY_C);
    const rows = [
      { authorization_id: v1Handle, provider_reference: v1Handle },
      { authorization_id: v2Old, provider_reference: v2Old },
      { authorization_id: foreign, provider_reference: foreign }
    ];
    for (const [index, row] of rows.entries()) {
      await client.query(
        `INSERT INTO siton.payment_authorization_bindings
           (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id)
         VALUES ('grow','grow','sandbox',$1,$2,$3,$4,1,1000,'ILS',0,'authorized',$5)`,
        [row.authorization_id, row.provider_reference, dealId, `keyring-buyer-${index}`, `keyring-corr-${dealId}-${index}`]
      );
    }
    const ringB = tool.buildKeyring({ primary_key: KEY_B, primary_key_id: "b", previous_keys: `a:${KEY_A}` });
    const before = await tool.inventory(client, ringB);
    const bindingsRef = before.columns.find((col: any) => col.table === "siton.payment_authorization_bindings" && col.column === "provider_reference");
    const bindingsAuth = before.columns.find((col: any) => col.table === "siton.payment_authorization_bindings" && col.column === "authorization_id");
    assert.equal(bindingsRef.rewritten_by_apply, true);
    assert.equal(bindingsAuth.rewritten_by_apply, false);
    assert.equal(bindingsRef.total, 3);
    const count = (col: any, format: string, state: string) => col.breakdown.filter((b: any) => b.format === format && b.state === state).reduce((sum: number, b: any) => sum + b.count, 0);
    assert.equal(count(bindingsRef, "v1", "opens"), 1);
    assert.equal(count(bindingsRef, "v2", "opens"), 1);
    assert.equal(count(bindingsRef, "v2", "UNOPENABLE"), 1);
    assert.equal(before.unopenable_total, 2, "the foreign-key row in both columns");
    assert.equal(before.retire_safe.a, false, "old key still needed");

    const applied = await tool.applyReseal(client, ringB);
    assert.deepEqual({ resealed: applied.resealed, unopenable: applied.unopenable, raced: applied.raced }, { resealed: 2, unopenable: 1, raced: 0 });
    const after = await client.query(`SELECT authorization_id, provider_reference FROM siton.payment_authorization_bindings WHERE deal_id=$1 ORDER BY buyer_id`, [dealId]);
    const tsRingB = buildGrowReferenceKeyring({ primary_key: KEY_B, primary_key_id: "b", previous_keys: `a:${KEY_A}` });
    assert.equal(after.rows[0].authorization_id, v1Handle, "identifier column never rewritten");
    assert.equal(after.rows[1].authorization_id, v2Old, "identifier column never rewritten");
    for (const index of [0, 1]) {
      assert.equal(String(after.rows[index].provider_reference).startsWith("grow_ref_v2.b."), true);
      assert.deepEqual(openGrowReference(after.rows[index].provider_reference, tsRingB), REF);
    }
    assert.equal(after.rows[2].provider_reference, foreign, "unopenable row left untouched");
    // Idempotent: a second apply changes nothing.
    const again = await tool.applyReseal(client, ringB);
    assert.equal(again.resealed, 0);
    // authorization_id still carries key a → not yet safe to retire.
    assert.equal((await tool.inventory(client, ringB)).retire_safe.a, false);
    await client.query(`DELETE FROM siton.payment_authorization_bindings WHERE deal_id=$1`, [dealId]);
    await client.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
  } finally {
    await client.end();
  }
});

console.log(`GROW_PAYMENT_REFERENCE_KEYRING_VALIDATION passed=${passed}`);
