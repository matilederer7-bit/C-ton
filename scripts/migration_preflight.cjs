#!/usr/bin/env node
// Migration preflight (npm run migrations:preflight).
//
// Answers: "Can commit X migrate from the canonical previous production
// schema safely?" using ONLY disposable local databases created through
// scripts/lib/test_db_isolation.cjs. Never touches a hosted database. Never
// alters a migration file.
//
// Static (no database):
//   manifest integrity - duplicate ids/filenames, position gaps, missing or
//   orphan files, ordering anomalies (documented ones are INFO), lone CR,
//   BOM, empty files, multiple COMMITs per file
// Database scenarios (each on its own isolated database):
//   fresh install            all migrations on an empty database, rerun is a no-op
//   upstream upgrade         migrations of --base (default origin/master) first,
//                            then this checkout's manifest on top
//   partial ledger           first half applied, then the rest (staging-style catch-up)
//   CRLF-written ledger      rows stored with CRLF-era checksums are accepted as
//                            line-ending variants, never as content drift
//   checksum drift           a tampered checksum is refused
//   dirty ledger             a failed row blocks every later run
//   failing migration        a mid-file failure is atomic (no partial objects),
//                            the ledger row is marked failed, the next run refuses
//   schema drift             fresh-install schema == upgrade-path schema
//
// Exit 1 on any FAIL. Set --base <ref> to compare against a different ref;
// --skip-db for the static half only.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tools = require("./lib/migration_tools.cjs");
const isolation = require("./lib/test_db_isolation.cjs");
const { runMigrations } = require("./run_migrations.cjs");
const { ReleaseReport, runStep, SkippedEnvironmentError, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();
const args = process.argv.slice(2);
const baseRef = (args.find((item) => item.startsWith("--base=")) || "--base=origin/master").slice(7);
const skipDb = args.includes("--skip-db");

async function silently(fn) {
  const original = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = original; }
}

async function main() {
  const report = new ReleaseReport("migration preflight", { meta: { base_ref: baseRef } });
  const analysis = tools.analyzeManifest(root);

  // --- static -------------------------------------------------------------
  await runStep(report, "manifest integrity", async () => {
    const fails = analysis.findings.filter((f) => f.severity === "FAIL");
    const warns = analysis.findings.filter((f) => f.severity === "WARNING");
    const infos = analysis.findings.filter((f) => f.severity === "INFO");
    const detail = analysis.findings.map((f) => f.severity + " " + f.code + " " + f.message).join("\n");
    const summary = analysis.files.length + " migrations, high-water " + analysis.high_water + ", crlf_in_worktree=" + analysis.files.filter((f) => f.has_crlf).length + ", explicit_tx=" + analysis.files.filter((f) => f.explicit_transaction).length + ", known_anomalies=" + infos.length;
    if (fails.length) return { status: "FAIL", summary: fails.length + " manifest problems; " + summary, detail };
    if (warns.length) return { status: "WARNING", summary: warns.length + " warnings; " + summary, detail };
    return { status: "PASS", summary, detail: detail || undefined };
  });

  await runStep(report, "line-ending policy", async () => {
    const crlf = analysis.files.filter((f) => f.has_crlf).length;
    const gitattributes = fs.existsSync(path.join(root, ".gitattributes")) ? fs.readFileSync(path.join(root, ".gitattributes"), "utf8") : "";
    const pinned = /\*\.sql\s+text\s+eol=lf/.test(gitattributes);
    return {
      status: pinned ? "PASS" : "WARNING",
      summary: (pinned ? ".gitattributes pins *.sql to LF; " : "no .gitattributes eol=lf pin for *.sql; ") + crlf + "/" + analysis.files.length + " files carry CRLF in this checkout; the runner hashes the LF-normalised body so checksums are platform independent"
    };
  });

  if (skipDb) {
    report.printSummary();
    report.writeArtifacts(artifactsDir(root), "migration-preflight");
    process.exit(report.exitCode());
  }

  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    report.skip("database scenarios", "DATABASE_URL not set; static half only");
    report.printSummary();
    report.writeArtifacts(artifactsDir(root), "migration-preflight");
    process.exit(report.exitCode());
  }
  try { isolation.assertLocalBase(baseUrl); } catch (error) {
    report.skip("database scenarios", error.message);
    report.printSummary();
    report.writeArtifacts(artifactsDir(root), "migration-preflight");
    process.exit(report.exitCode());
  }
  try {
    await tools.withClient(isolation.withDatabase(baseUrl, "postgres"), (client) => client.query("SELECT 1"));
  } catch (error) {
    report.skip("database scenarios", "local PostgreSQL unreachable: " + error.message);
    report.printSummary();
    report.writeArtifacts(artifactsDir(root), "migration-preflight");
    process.exit(report.exitCode());
  }

  const created = [];
  const isolated = async (purpose) => { const db = await isolation.createIsolatedDatabase({ baseUrl, purpose }); created.push(db); return db; };
  let freshSnapshot = null;

  try {
    // --- fresh install --------------------------------------------------
    await runStep(report, "fresh install + idempotent rerun", async () => {
      const db = await isolated("mpfresh");
      const first = await silently(() => runMigrations(db.url));
      const second = await silently(() => runMigrations(db.url));
      const ledger = await tools.readLedger(db.url);
      const compared = tools.compareLedger(ledger, analysis);
      if (first.newly_applied !== analysis.files.length) throw new Error("fresh install applied " + first.newly_applied + " of " + analysis.files.length);
      if (second.newly_applied !== 0) throw new Error("rerun applied " + second.newly_applied + " migrations (not idempotent)");
      if (compared.counts.match !== analysis.files.length) throw new Error("ledger checksums after fresh install: " + JSON.stringify(compared.counts));
      freshSnapshot = await tools.schemaSnapshot(db.url);
      return { status: "PASS", summary: "applied " + first.newly_applied + ", rerun applied 0, ledger " + compared.counts.match + "/" + analysis.files.length + " match; schema: " + freshSnapshot.columns.length + " columns, " + freshSnapshot.constraints.length + " constraints, " + freshSnapshot.indexes.length + " indexes" };
    });

    // --- upstream upgrade -----------------------------------------------
    await runStep(report, "upgrade from " + baseRef, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siton-mig-base-"));
      try {
        let base;
        try { base = tools.materializeRef(root, baseRef, tmp); } catch (error) { throw new SkippedEnvironmentError("base ref unavailable: " + error.message); }
        const db = await isolated("mpupgrade");
        const baseRun = await silently(() => runMigrations(db.url, { migrations: base.migrations, migrationsDir: base.dir }));
        const upgrade = await silently(() => runMigrations(db.url));
        const ledger = await tools.readLedger(db.url);
        const compared = tools.compareLedger(ledger, analysis);
        const shared = base.migrations.filter((m) => analysis.files.some((f) => f.id === m.id)).length;
        const changedShared = compared.rows.filter((row) => row.classification === "real_content_mismatch");
        if (changedShared.length) throw new Error("migrations already applied upstream were EDITED on this branch: " + changedShared.map((r) => r.filename).join(", "));
        if (compared.missing.length) throw new Error("upgrade left migrations unapplied: " + compared.missing.map((m) => m.filename).join(", "));
        const upgradeSnapshot = await tools.schemaSnapshot(db.url);
        const drift = freshSnapshot ? tools.diffSnapshots(freshSnapshot, upgradeSnapshot) : null;
        const driftCount = drift ? Object.values(drift).reduce((sum, item) => sum + item.only_left.length + item.only_right.length, 0) : null;
        const detail = drift && driftCount ? JSON.stringify(drift, null, 2).slice(0, 4000) : undefined;
        const summary = "base " + base.migrations.length + " migrations applied (" + baseRun.newly_applied + "), branch added " + upgrade.newly_applied + " on top, shared " + shared + " unchanged; schema drift fresh-vs-upgrade = " + driftCount;
        if (driftCount) return { status: "FAIL", summary, detail };
        return { status: "PASS", summary };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    // --- partial ledger (staging-style catch-up) -------------------------
    await runStep(report, "partial ledger catch-up", async () => {
      const db = await isolated("mppartial");
      const half = Math.max(1, Math.floor(analysis.migrations.length / 2));
      const firstHalf = await silently(() => runMigrations(db.url, { migrations: analysis.migrations.slice(0, half) }));
      const rest = await silently(() => runMigrations(db.url));
      if (firstHalf.newly_applied !== half || rest.newly_applied !== analysis.migrations.length - half) throw new Error("expected " + half + " then " + (analysis.migrations.length - half) + ", got " + firstHalf.newly_applied + " then " + rest.newly_applied);
      return { status: "PASS", summary: half + " applied first, " + rest.newly_applied + " caught up, ledger contiguous" };
    });

    // --- CRLF-written ledger --------------------------------------------
    await runStep(report, "CRLF-era ledger checksums accepted as line-ending variants", async () => {
      const db = await isolated("mpcrlf");
      await silently(() => runMigrations(db.url));
      const rewritten = await tools.withClient(db.url, async (client) => {
        let count = 0;
        for (const file of analysis.files) {
          await client.query("UPDATE siton.migration_ledger SET checksum_sha256=$2 WHERE migration_id=$1", [file.id, file.checksum_crlf]);
          count += 1;
        }
        return count;
      });
      const rerun = await silently(() => runMigrations(db.url));
      const compared = tools.compareLedger(await tools.readLedger(db.url), analysis);
      if (rerun.eol_variants !== rewritten) throw new Error("expected " + rewritten + " eol variants, runner reported " + rerun.eol_variants);
      if (rerun.newly_applied !== 0) throw new Error("runner re-applied migrations over an EOL-variant ledger");
      if (compared.counts.line_ending_only_mismatch !== rewritten) throw new Error("doctor classification: " + JSON.stringify(compared.counts));
      return { status: "PASS", summary: rewritten + " rows rewritten with CRLF checksums; runner accepted all as EOL variants, applied 0; doctor classifies all " + rewritten + " as line_ending_only_mismatch" };
    });

    // --- checksum drift -------------------------------------------------
    await runStep(report, "tampered checksum refused", async () => {
      const db = await isolated("mpdrift");
      await silently(() => runMigrations(db.url));
      const target = analysis.files[Math.floor(analysis.files.length / 2)];
      await tools.withClient(db.url, (client) => client.query("UPDATE siton.migration_ledger SET checksum_sha256='0000000000000000000000000000000000000000000000000000000000000000' WHERE migration_id=$1", [target.id]));
      let error = null;
      try { await silently(() => runMigrations(db.url)); } catch (caught) { error = caught; }
      if (!error || !/checksum mismatch/.test(error.message)) throw new Error("runner did not refuse a tampered checksum: " + (error ? error.message : "no error"));
      const compared = tools.compareLedger(await tools.readLedger(db.url), analysis);
      if (compared.counts.real_content_mismatch !== 1) throw new Error("doctor classification: " + JSON.stringify(compared.counts));
      return { status: "PASS", summary: "runner refused (" + error.message + "); doctor classifies 1 real_content_mismatch" };
    });

    // --- dirty ledger ---------------------------------------------------
    await runStep(report, "dirty ledger blocks the run", async () => {
      const db = await isolated("mpdirty");
      await silently(() => runMigrations(db.url));
      const target = analysis.files[analysis.files.length - 1];
      await tools.withClient(db.url, (client) => client.query("UPDATE siton.migration_ledger SET status='failed', error_message='simulated' WHERE migration_id=$1", [target.id]));
      let error = null;
      try { await silently(() => runMigrations(db.url)); } catch (caught) { error = caught; }
      if (!error || !/ledger is dirty/.test(error.message)) throw new Error("runner did not refuse a dirty ledger: " + (error ? error.message : "no error"));
      return { status: "PASS", summary: error.message };
    });

    // --- failing migration atomicity ------------------------------------
    for (const variant of [
      { label: "implicit transaction", body: "CREATE TABLE siton.zz_preflight_probe (id INT);\nINSERT INTO siton.zz_preflight_probe VALUES (1);\nSELECT 1/0;\n" },
      { label: "explicit BEGIN/COMMIT", body: "BEGIN;\nCREATE TABLE siton.zz_preflight_probe (id INT);\nINSERT INTO siton.zz_preflight_probe VALUES (1);\nSELECT 1/0;\nCOMMIT;\n" }
    ]) {
      await runStep(report, "failing migration is atomic (" + variant.label + ")", async () => {
        const db = await isolated("mpfail");
        await silently(() => runMigrations(db.url));
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siton-mig-fail-"));
        try {
          const filename = "999_preflight_failure_probe.sql";
          fs.writeFileSync(path.join(tmp, filename), variant.body);
          const migrations = analysis.migrations.concat([{ id: "999", filename, position: analysis.migrations.length + 1 }]);
          // Existing migrations resolve from the real dir; the probe from tmp.
          const dirFor = (name) => (name === filename ? tmp : path.join(root, "src", "migrations"));
          let error = null;
          try {
            await silently(() => runMigrations(db.url, { migrations, migrationsDir: tmp, resolveDir: dirFor }));
          } catch (caught) { error = caught; }
          if (!error || !/migration failed: 999/.test(error.message)) throw new Error("expected the probe migration to fail, got " + (error ? error.message : "success"));
          const state = await tools.withClient(db.url, async (client) => ({
            probe_table: (await client.query("SELECT to_regclass('siton.zz_preflight_probe') AS t")).rows[0].t,
            row: (await client.query("SELECT status, error_message FROM siton.migration_ledger WHERE migration_id='999'")).rows[0]
          }));
          if (state.probe_table) throw new Error("partial effects survived: siton.zz_preflight_probe exists after a failed migration");
          if (!state.row || state.row.status !== "failed") throw new Error("ledger row for the failed migration is " + JSON.stringify(state.row));
          let second = null;
          try { await silently(() => runMigrations(db.url)); } catch (caught) { second = caught; }
          if (!second || !/ledger is dirty at 999/.test(second.message)) throw new Error("next run did not refuse the dirty ledger: " + (second ? second.message : "success"));
          return { status: "PASS", summary: "no partial objects, ledger row failed with message, next run refused (" + second.message + ")" };
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  } finally {
    for (const db of created) await db.drop().catch(() => undefined);
  }

  report.printSummary();
  report.writeArtifacts(artifactsDir(root), "migration-preflight");
  console.log(report.exitCode() ? "MIGRATION_PREFLIGHT_FAIL" : "MIGRATION_PREFLIGHT_PASS high_water=" + analysis.high_water + " migrations=" + analysis.files.length);
  process.exit(report.exitCode());
}

main().catch((error) => { console.error("MIGRATION_PREFLIGHT_ERROR", error); process.exit(1); });
