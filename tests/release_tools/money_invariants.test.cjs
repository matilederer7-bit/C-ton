// Unit controls for the READ-ONLY money reconciliation checker
// (scripts/lib/money_invariants.cjs + scripts/money_invariants.cjs). No
// database: a recording fake client proves the transaction discipline, and
// the CLI is driven against a closed port to prove the password never prints.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const lib = require(path.join(REPO_ROOT, "scripts", "lib", "money_invariants.cjs"));

const GROUPS = ["fee", "participant", "deal", "payment", "inventory", "outbox", "audit", "payouts"];
const WRITE_OR_SIDE_EFFECT = /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|ALTER|CREATE|DROP|GRANT|REVOKE|COPY|CALL|VACUUM|ANALYZE|LOCK|REFRESH|COMMENT|SECURITY)\b|\bFOR\s+(UPDATE|SHARE|NO KEY)\b|nextval|setval|pg_advisory|set_config|pg_terminate|pg_cancel|dblink|lo_import|pg_read_file/i;

// A fake pg client. `catalog` lists "schema.table" -> columns; `answer(sql)`
// returns rows for invariant queries (default: zero violations).
function fakeClient({ catalog, answer, readOnly = "on" } = {}) {
  const queries = [];
  // Default catalog: every table/column any invariant requires.
  const merged = {};
  for (const inv of lib.INVARIANTS) for (const [t, cols] of Object.entries(inv.requires || {})) merged[t] = [...new Set([...(merged[t] || []), ...cols])];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql === lib.SESSION.verify) return { rows: [{ ro: readOnly }] };
      if (sql === lib.SESSION.catalog) return { rows: Object.entries(catalog ? catalog : merged).flatMap(([t, cols]) => cols.map((c) => ({ t, c }))) };
      if (/^SELECT count\(\*\)::int AS n/.test(sql)) return answer ? answer(sql) : { rows: [{ n: 0, samples: null }] };
      return { rows: [] };
    }
  };
}

test("query set shape: unique names, known groups, SELECT returning `id`, declared requirements", () => {
  const names = lib.INVARIANTS.map((inv) => inv.name);
  assert.equal(new Set(names).size, names.length, "duplicate invariant names");
  assert.ok(names.length >= 30, "expected the full invariant set, got " + names.length);
  for (const inv of lib.INVARIANTS) {
    assert.match(inv.name, /^[a-z]+\.[a-z0-9_]+$/, inv.name);
    assert.ok(GROUPS.includes(inv.group), inv.name + " group " + inv.group);
    assert.equal(inv.name.split(".")[0], inv.group, inv.name);
    assert.ok(inv.description && inv.description.length > 10, inv.name + " needs a description");
    for (const sql of [inv.sql, inv.exactSql].filter(Boolean)) {
      assert.match(sql.trim(), /^SELECT\b/i, inv.name);
      assert.match(sql, /\bAS id\b/, inv.name + " must project the violating id as `id`");
      assert.doesNotMatch(sql, WRITE_OR_SIDE_EFFECT, inv.name + " contains a write / side effect");
      assert.doesNotMatch(sql, /;/, inv.name + " must be a single statement");
    }
    assert.ok(inv.requires && Object.keys(inv.requires).length, inv.name + " must declare the tables it reads (for SKIPPED)");
    for (const table of Object.keys(inv.requires)) assert.match(table, /^(siton|siton_inventory)\.[a-z_]+$/, inv.name + " " + table);
    assert.ok(inv.mode === undefined || inv.mode === "info", inv.name);
  }
  const required = [
    "fee.total_equals_base_plus_vat", "fee.seller_net_equals_gross_minus_fee_total", "fee.sign_matches_entry_type",
    "fee.abs_fee_le_abs_gross", "fee.rate_is_8_percent", "fee.fee_base_excludes_vat",
    "participant.refund_not_exceeding_charge", "participant.at_most_one_charge_row", "participant.at_most_one_refund_row",
    "participant.charged_state_has_charge_fee_row", "participant.charged_state_has_successful_capture", "participant.charge_fee_row_implies_charged_state",
    "deal.joined_units_within_max_units", "deal.completed_has_charged_participant", "deal.charging_has_live_work",
    "payment.stale_unresolved_attempt_has_reconcile_or_case",
    "inventory.counters_match_reservations", "outbox.dlq_older_than_1h_without_open_case",
    "audit.deal_state_has_latest_transition", "audit.participant_buyer_state_has_latest_transition", "audit.participant_money_state_has_latest_transition",
    "payouts.amounts_non_negative", "payouts.paid_not_exceeding_payout", "payouts.settlement_matches_fee_ledger"
  ];
  for (const name of required) assert.ok(names.includes(name), "missing invariant " + name);
  assert.equal(lib.PLATFORM_FEE_RATE, 0.08);
  assert.equal(lib.TOLERANCE, 0.01);
  // tolerance checks carry an exactness twin
  for (const name of ["fee.total_equals_base_plus_vat", "fee.seller_net_equals_gross_minus_fee_total"]) {
    const inv = lib.INVARIANTS.find((i) => i.name === name);
    assert.match(inv.sql, /> 0\.01/);
    assert.match(inv.exactSql, /<>/);
  }
});

test("runs inside ONE `BEGIN TRANSACTION READ ONLY`, verifies it, and always rolls back", async () => {
  const client = fakeClient();
  const report = await lib.runInvariants(client);
  assert.equal(client.queries[0], "BEGIN TRANSACTION READ ONLY");
  assert.equal(client.queries[1], "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  assert.ok(client.queries.includes(lib.SESSION.verify));
  assert.equal(client.queries[client.queries.length - 1], "ROLLBACK");
  assert.equal(client.queries.filter((q) => /^BEGIN\b/i.test(q)).length, 1);
  assert.ok(!client.queries.some((q) => /^COMMIT\b/i.test(q)), "the checker must never COMMIT");
  for (const q of client.queries) {
    if (/^(BEGIN TRANSACTION READ ONLY|SET TRANSACTION ISOLATION LEVEL REPEATABLE READ|SET LOCAL statement_timeout|SAVEPOINT money_invariant|RELEASE SAVEPOINT money_invariant|ROLLBACK)/.test(q)) continue;
    assert.match(q.trim(), /^SELECT\b/, "unexpected statement: " + q.slice(0, 80));
    assert.doesNotMatch(q, WRITE_OR_SIDE_EFFECT, q.slice(0, 120));
  }
  assert.equal(report.overall, "PASS");
  assert.equal(report.counts.PASS, lib.INVARIANTS.length);
});

test("refuses to run when the transaction is not read-only, and still rolls back", async () => {
  const client = fakeClient({ readOnly: "off" });
  await assert.rejects(() => lib.runInvariants(client), /not read-only/);
  assert.equal(client.queries[client.queries.length - 1], "ROLLBACK");
  assert.ok(!client.queries.some((q) => /^SELECT count\(\*\)/.test(q)), "no invariant may run outside a read-only transaction");
});

test("absent tables/columns are SKIPPED, violations FAIL with <=5 samples, INFO never fails, a broken query is ERROR", async () => {
  // Only the fee table exists: everything else must be SKIPPED, not FAIL.
  const feeOnly = { "siton.platform_fee_money_events": [...lib.INVARIANTS[0].requires["siton.platform_fee_money_events"], "money_event_id"] };
  let report = await lib.runInvariants(fakeClient({ catalog: feeOnly }));
  const skipped = report.results.filter((r) => r.status === "SKIPPED");
  assert.ok(skipped.length > 10, "expected most invariants skipped");
  assert.ok(skipped.every((r) => /absent: /.test(r.reason)));
  assert.equal(report.overall, "PASS");

  const ids = ["a", "b", "c", "d", "e"];
  report = await lib.runInvariants(fakeClient({
    answer: (sql) => {
      if (sql.includes("platform_fee_total_amount) - (platform_fee_base_amount + platform_fee_vat_amount)")) return { rows: [{ n: 7, samples: ids }] };
      if (sql.includes("q.updated_at < now() - interval '1 hour'")) return { rows: [{ n: 2, samples: ["x", "y"] }] };
      if (sql.includes("platform_fee_rate <>")) throw new Error("relation does not exist at postgresql://u:TopSecret@h/db");
      return { rows: [{ n: 0, samples: null }] };
    }
  }));
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["fee.total_equals_base_plus_vat"].status, "FAIL");
  assert.equal(byName["fee.total_equals_base_plus_vat"].count, 7);
  assert.deepEqual(byName["fee.total_equals_base_plus_vat"].samples, ids);
  assert.equal(byName["outbox.dlq_older_than_1h_without_open_case"].status, "INFO");
  assert.equal(byName["fee.rate_is_8_percent"].status, "ERROR");
  assert.doesNotMatch(byName["fee.rate_is_8_percent"].reason, /TopSecret/);
  assert.equal(byName["fee.seller_net_equals_gross_minus_fee_total"].status, "PASS", "one ERROR must not hide the others");
  assert.equal(report.overall, "FAIL");
  assert.deepEqual(lib.failingNames(report).sort(), ["fee.rate_is_8_percent", "fee.total_equals_base_plus_vat"]);
  const line = lib.formatResult(byName["fee.total_equals_base_plus_vat"]);
  assert.match(line, /^MONEY_INVARIANT FAIL\s+fee\.total_equals_base_plus_vat count=7 exact_mismatch=\d+ samples=\[a,b,c,d,e\]$/);
  assert.match(lib.wrapCount("SELECT 1 AS id"), /\[1:5\]/);
});

test("target description and error text never carry credentials", () => {
  const url = "postgresql://siton_backup_ro:Sup3r-S3cret%21@db.example.supabase.co:6543/postgres?sslmode=require";
  const described = lib.describeTarget(url);
  assert.equal(described, "host=db.example.supabase.co:6543 db=postgres");
  assert.doesNotMatch(described, /S3cret|siton_backup_ro/);
  assert.equal(lib.describeTarget("not a url"), "host=(unparsed) db=(unparsed)");
  assert.doesNotMatch(lib.redact("connect failed for " + url), /S3cret/);
  assert.doesNotMatch(lib.redact("password=hunter2 host=x"), /hunter2/);
});

test("CLI: prints host+db only, never the password, and exits 2 when it cannot connect", () => {
  const secret = "N3verPrintMe";
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "money_invariants.cjs")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, DOTENV_CONFIG_QUIET: "true", MONEY_INVARIANTS_DATABASE_URL: "postgresql://ro_user:" + secret + "@127.0.0.1:1/siton_prod" }
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /host=127\.0\.0\.1:1 db=siton_prod/);
  assert.match(output, /read-only transaction/);
  assert.match(output, /MONEY_INVARIANTS_ERROR/);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /ro_user/);
});

test("CLI source: read-only by construction, no URL flag, npm script registered", () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, "scripts", "money_invariants.cjs"), "utf8");
  const libSource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "lib", "money_invariants.cjs"), "utf8");
  assert.match(libSource, /begin: "BEGIN TRANSACTION READ ONLY"/);
  assert.doesNotMatch(cli, /console\.log\([^)]*\burl\b(?!\))/, "the CLI must not log the raw URL");
  assert.doesNotMatch(cli, /--database-url|--url/);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:money-invariants"], "node scripts/money_invariants.cjs");
});

test("rehearsal negative control names only real invariants", () => {
  const rehearsal = fs.readFileSync(path.join(REPO_ROOT, "scripts", "db_backup_restore_rehearsal.cjs"), "utf8");
  const block = rehearsal.match(/NEGATIVE_CONTROL_EXPECTED_FAILURES = \[([\s\S]*?)\]\.sort\(\)/);
  assert.ok(block, "negative control list present");
  const expected = [...block[1].matchAll(/"([a-z]+\.[a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(expected.length >= 5);
  const names = new Set(lib.INVARIANTS.map((inv) => inv.name));
  for (const name of expected) assert.ok(names.has(name), "negative control expects unknown invariant " + name);
  assert.match(rehearsal, /BEGIN|audit_log is append-only|append-only/);
  assert.match(rehearsal, /DB_BACKUP_RESTORE_REHEARSAL_PASS/);
});
