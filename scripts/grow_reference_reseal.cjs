#!/usr/bin/env node
// Grow sealed-reference inventory and re-seal tool (key rotation support).
//
// DRY RUN BY DEFAULT: without --apply it only READS and prints, per stored
// column, how many sealed Grow references exist per format (grow_ref_v1 /
// grow_ref_v2) and key id, and whether the currently configured keyring can
// open them.
//
//   node scripts/grow_reference_reseal.cjs              # inventory (read-only)
//   node scripts/grow_reference_reseal.cjs --apply      # re-seal under primary
//   ... --json                                           # machine-readable report
//
// Target guard: DATABASE_URL must point at a local Postgres
// (scripts/lib/test_db_isolation.cjs LOCAL_HOSTS); any other host is refused
// unless BOTH --allow-hosted and --yes are passed.
//
// Keyring (same env as the adapter, src/grow_payment_adapter.ts):
//   GROW_REFERENCE_ENCRYPTION_KEY            primary (required for --apply)
//   GROW_REFERENCE_ENCRYPTION_KEY_ID         optional primary kid
//   GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS  optional "key" / "kid:key", comma-separated
//
// WHAT --apply REWRITES — deliberately only
// siton.payment_authorization_bindings.provider_reference: it is the
// operational lookup reference the application itself refreshes after
// provider calls (payment_binding.updateProviderReferenceForParticipant), so
// a re-sealed value is indistinguishable from a normal refresh. Each row is
// rewritten with compare-and-set inside ONE transaction; a row no configured
// key can open is left untouched and reported.
//
// WHAT IT NEVER REWRITES — authorization_id / replaced_authorization_id (the
// hosted-flow handle, matched by equality at join/confirm time) and evidence
// columns (payment_attempts.provider_reference, fee/payout rows). Those keep
// their original seal, so an old key must stay in
// GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS until the inventory shows no
// remaining reference under its kid ("retire_safe" in the report).
// JSON payloads (audit_log / outbox) are evidence and are not scanned.
//
// No provider call, no money movement. The crypto below mirrors the adapter
// exactly; tests/grow_payment_reference_keyring_validation.ts proves the two
// interoperate so the copies cannot drift silently.

const crypto = require("node:crypto");
const { LOCAL_HOSTS } = require("./lib/test_db_isolation.cjs");

const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const V1 = "grow_ref_v1";
const V2 = "grow_ref_v2";
const REWRITABLE = { table: "payment_authorization_bindings", column: "provider_reference", key: "binding_id" };
const SCANNED_COLUMN_NAMES = ["provider_reference", "authorization_id", "replaced_authorization_id", "capture_reference"];

function aesKey(secret) {
  if (String(secret || "").length < 32) throw new Error("grow_reference_encryption_key_missing");
  return crypto.createHash("sha256").update(secret).digest();
}

function deriveKeyId(secret) {
  return crypto.createHash("sha256").update("grow_ref_kid:" + String(secret || "")).digest("hex").slice(0, 8);
}

function parsePreviousKeys(raw) {
  return (Array.isArray(raw) ? raw : String(raw || "").split(","))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^([A-Za-z0-9_-]{1,32}):(.+)$/.exec(entry);
      if (match && match[2].length >= 32) return { kid: match[1], secret: match[2] };
      return { kid: deriveKeyId(entry), secret: entry };
    });
}

function buildKeyring({ primary_key, primary_key_id, previous_keys }) {
  const primarySecret = String(primary_key || "");
  aesKey(primarySecret);
  const primaryKid = String(primary_key_id || "").trim() || deriveKeyId(primarySecret);
  if (!KID_PATTERN.test(primaryKid)) throw new Error("grow_reference_key_id_invalid");
  const primary = { kid: primaryKid, secret: primarySecret };
  const byKid = new Map([[primary.kid, primary.secret]]);
  const previous = [];
  for (const key of parsePreviousKeys(previous_keys)) {
    if (key.secret.length < 32) throw new Error("grow_reference_previous_key_invalid");
    if (!KID_PATTERN.test(key.kid)) throw new Error("grow_reference_key_id_invalid");
    if (byKid.has(key.kid)) {
      if (byKid.get(key.kid) !== key.secret) throw new Error("grow_reference_key_id_conflict");
      continue;
    }
    if (key.secret === primary.secret || previous.some((item) => item.secret === key.secret)) continue;
    byKid.set(key.kid, key.secret);
    previous.push(key);
  }
  return { primary, previous };
}

function referenceFormat(value) {
  const parts = String(value || "").split(".");
  if (parts[0] === V1 && parts.length === 4) return { format: "v1", kid: null };
  if (parts[0] === V2 && parts.length === 5 && KID_PATTERN.test(parts[1] || "")) return { format: "v2", kid: parts[1] };
  return { format: "unrecognized", kid: null };
}

function decryptWith(secret, aad, ivRaw, tagRaw, ciphertextRaw) {
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("grow_reference_invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(secret), iv);
  if (aad !== null) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]);
}

function referenceFromClear(clear) {
  const parsed = JSON.parse(clear.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || !String(parsed.process_id || "").trim() || !String(parsed.process_token || "").trim()) {
    throw new Error("grow_reference_invalid");
  }
  return parsed;
}

/** Returns { reference, format, kid } or throws "grow_reference_invalid". */
function openReference(value, ring) {
  const all = [ring.primary, ...ring.previous];
  try {
    const parts = String(value || "").split(".");
    if (parts[0] === V2 && parts.length === 5) {
      const [, kid, ivRaw, tagRaw, ciphertextRaw] = parts;
      const key = all.find((item) => item.kid === kid);
      if (key && ivRaw && tagRaw && ciphertextRaw) {
        return { reference: referenceFromClear(decryptWith(key.secret, V2 + "." + kid, ivRaw, tagRaw, ciphertextRaw)), format: "v2", kid };
      }
    } else if (parts[0] === V1 && parts.length === 4) {
      const [, ivRaw, tagRaw, ciphertextRaw] = parts;
      for (const key of all) {
        let clear;
        try { clear = decryptWith(key.secret, null, ivRaw, tagRaw, ciphertextRaw); } catch { continue; }
        return { reference: referenceFromClear(clear), format: "v1", kid: key.kid };
      }
    }
  } catch {
    // uniform fail-closed error below
  }
  throw new Error("grow_reference_invalid");
}

function sealReference(reference, ring) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(ring.primary.secret), iv);
  cipher.setAAD(Buffer.from(V2 + "." + ring.primary.kid, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(reference), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [V2, ring.primary.kid, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Re-seal under the primary; unchanged when already v2 under the primary kid. */
function resealReference(value, ring) {
  const opened = openReference(value, ring);
  if (opened.format === "v2" && opened.kid === ring.primary.kid) return { value, changed: false, from: { format: opened.format, kid: opened.kid } };
  return { value: sealReference(opened.reference, ring), changed: true, from: { format: opened.format, kid: opened.kid } };
}

function keyringFromEnv(env = process.env) {
  if (!String(env.GROW_REFERENCE_ENCRYPTION_KEY || "")) return null;
  return buildKeyring({
    primary_key: env.GROW_REFERENCE_ENCRYPTION_KEY,
    primary_key_id: env.GROW_REFERENCE_ENCRYPTION_KEY_ID,
    previous_keys: env.GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS
  });
}

function quoteIdentifier(value) {
  return "\"" + String(value).replace(/"/g, "\"\"") + "\"";
}

/** Classify one stored value for the inventory. */
function classify(value, ring) {
  const shape = referenceFormat(value);
  let opens = null;
  let openedBy = null;
  if (ring && shape.format !== "unrecognized") {
    try { openedBy = openReference(value, ring).kid; opens = true; } catch { opens = false; }
  }
  const needsKid = openedBy || shape.kid;
  return { format: shape.format, kid: shape.kid, opens, opened_by_kid: openedBy, needs_kid: needsKid };
}

async function scannedColumns(client) {
  const found = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema='siton' AND column_name = ANY($1::text[])
        AND data_type IN ('text','character varying')
      ORDER BY table_name, column_name`,
    [SCANNED_COLUMN_NAMES]
  );
  return found.rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

async function inventory(client, ring) {
  const report = { columns: [], kids: {}, unopenable_total: 0 };
  for (const { table, column } of await scannedColumns(client)) {
    const rows = await client.query(
      `SELECT ${quoteIdentifier(column)} AS value FROM siton.${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} LIKE 'grow\\_ref\\_%'`
    );
    const buckets = new Map();
    for (const { value } of rows.rows) {
      const info = classify(value, ring);
      const bucketKey = [info.format, info.kid || "-", info.opens === null ? "unchecked" : info.opens ? "opens" : "UNOPENABLE", info.opened_by_kid || "-"].join("|");
      buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + 1);
      if (info.opens === false) report.unopenable_total += 1;
      if (info.needs_kid) report.kids[info.needs_kid] = (report.kids[info.needs_kid] || 0) + 1;
    }
    const rewritable = table === REWRITABLE.table && column === REWRITABLE.column;
    report.columns.push({
      table: "siton." + table,
      column,
      rewritten_by_apply: rewritable,
      total: rows.rowCount,
      breakdown: [...buckets.entries()].map(([bucketKey, count]) => {
        const [format, kid, state, openedBy] = bucketKey.split("|");
        return { format, kid: kid === "-" ? null : kid, state, opened_by_kid: openedBy === "-" ? null : openedBy, count };
      })
    });
  }
  if (ring) {
    report.primary_kid = ring.primary.kid;
    report.previous_kids = ring.previous.map((key) => key.kid);
    // A previous key may be removed from configuration only when no stored
    // reference (in any column, rewritable or not) still needs it.
    report.retire_safe = Object.fromEntries(ring.previous.map((key) => [key.kid, !report.kids[key.kid]]));
  }
  return report;
}

async function applyReseal(client, ring) {
  const result = { examined: 0, resealed: 0, already_current: 0, unopenable: 0, raced: 0 };
  await client.query("BEGIN");
  try {
    const rows = await client.query(
      `SELECT ${REWRITABLE.key} AS id, ${REWRITABLE.column} AS value
         FROM siton.${REWRITABLE.table}
        WHERE ${REWRITABLE.column} LIKE 'grow\\_ref\\_%'
        FOR UPDATE`
    );
    for (const row of rows.rows) {
      result.examined += 1;
      let resealed;
      try { resealed = resealReference(row.value, ring); } catch { result.unopenable += 1; continue; }
      if (!resealed.changed) { result.already_current += 1; continue; }
      const updated = await client.query(
        `UPDATE siton.${REWRITABLE.table} SET ${REWRITABLE.column}=$3 WHERE ${REWRITABLE.key}=$1 AND ${REWRITABLE.column}=$2`,
        [row.id, row.value, resealed.value]
      );
      if (updated.rowCount === 1) result.resealed += 1;
      else result.raced += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  return result;
}

function assertTarget(databaseUrl, argv) {
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("DATABASE_URL is missing or not a valid URL"); }
  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return { host, hosted: false };
  if (argv.includes("--allow-hosted") && argv.includes("--yes")) return { host, hosted: true };
  throw new Error("grow_reference_reseal refuses non-local PostgreSQL host '" + host + "' without --allow-hosted --yes");
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: node scripts/grow_reference_reseal.cjs [--apply] [--json] [--allow-hosted --yes]");
    return 0;
  }
  const apply = argv.includes("--apply");
  const asJson = argv.includes("--json");
  const target = assertTarget(env.DATABASE_URL, argv);
  const ring = keyringFromEnv(env);
  if (apply && !ring) throw new Error("--apply requires GROW_REFERENCE_ENCRYPTION_KEY (the primary key new seals use)");
  const { Client } = require("pg");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const before = await inventory(client, ring);
    const output = { mode: apply ? "apply" : "dry_run", target_host: target.host, hosted: target.hosted, keyring_configured: Boolean(ring), inventory: before };
    if (apply) {
      output.apply = await applyReseal(client, ring);
      output.inventory_after = await inventory(client, ring);
    }
    if (asJson) console.log(JSON.stringify(output, null, 2));
    else {
      console.log("GROW_REFERENCE_RESEAL mode=" + output.mode + " host=" + target.host + " keyring=" + (ring ? "primary:" + ring.primary.kid + " previous:" + ring.previous.map((key) => key.kid).join(",") : "not_configured"));
      for (const col of before.columns) {
        console.log("  " + col.table + "." + col.column + " total=" + col.total + (col.rewritten_by_apply ? " (rewritten by --apply)" : " (never rewritten)"));
        for (const bucket of col.breakdown) console.log("    format=" + bucket.format + " kid=" + (bucket.kid || "-") + " " + bucket.state + (bucket.opened_by_kid ? " opened_by=" + bucket.opened_by_kid : "") + " count=" + bucket.count);
      }
      if (before.retire_safe) console.log("  retire_safe " + JSON.stringify(before.retire_safe));
      if (output.apply) console.log("  APPLY " + JSON.stringify(output.apply));
      else console.log("  dry run; re-run with --apply to re-seal " + REWRITABLE.table + "." + REWRITABLE.column + " under the primary key");
    }
    return before.unopenable_total > 0 ? 3 : 0;
  } finally {
    await client.end();
  }
}

module.exports = {
  deriveKeyId,
  parsePreviousKeys,
  buildKeyring,
  referenceFormat,
  openReference,
  sealReference,
  resealReference,
  keyringFromEnv,
  classify,
  inventory,
  applyReseal,
  assertTarget,
  main
};

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => {
    console.error("grow_reference_reseal failed: " + String((error && error.message) || error));
    process.exit(2);
  });
}
