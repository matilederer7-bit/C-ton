#!/usr/bin/env node
/**
 * INDEPENDENT REVIEW — anti-vacuity proof for the reviewer's own suites.
 *
 * A green counterexample proves nothing unless removing the defence turns it
 * red. This applies one deliberate defect at a time to a throwaway working
 * copy of the source, runs the reviewer's suites that are supposed to catch
 * it, records whether they went RED, and restores the exact pre-mutation
 * bytes. A mutant that stays GREEN is reported honestly, never hidden.
 *
 * Every mutant here reverts one layer of the exact-operation identity defence
 * that the R9C integration candidate adds, including the final review's own
 * correction (RM-1 restores the `/^[a-z]{3}-/i` alias that made a foreign
 * `xyz-` reference look like the queried authorization).
 *
 * Usage:  node scripts/review_mutation_proof.cjs [RM-1 RM-2 ...]
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MUTANTS = [
  {
    id: "RM-1",
    invariant: "an arbitrary three-letter prefix never aliases the queried provider reference",
    layer: "provider-ready adapter reference discipline (the final review's own correction)",
    edits: [
      {
        file: "src/payment_provider.ts",
        from: `const bareReference = (value: unknown) => String(value || "").trim().replace(/^(cap|rec|ref|rel)-/, "");`,
        to: `const bareReference = (value: unknown) => String(value || "").trim().replace(/^[a-z]{3}-/i, "");`
      }
    ],
    suites: ["review_payment_foreign_reference_ab_validation.ts", "review_payment_reference_identity_rails_validation.ts"]
  },
  {
    id: "RM-2",
    invariant: "the reconcile rail refuses a status answer that names another operation",
    layer: "handlePaymentReconcileEvent reference-mismatch guard",
    edits: [
      {
        file: "src/app.ts",
        from: `  if (status.reference_matches_query === false) {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${participantId}:\${attemptType}\`,`,
        to: `  if ((status.reference_matches_query as unknown as string) === "never") {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${participantId}:\${attemptType}\`,`
      }
    ],
    suites: ["review_payment_foreign_reference_ab_validation.ts", "review_payment_reference_identity_rails_validation.ts"]
  },
  {
    id: "RM-3",
    invariant: "the recovery pre-flight refuses foreign evidence before authorising a second capture",
    layer: "verifyOriginalCaptureBeforeRecovery foreignRead guard",
    edits: [
      {
        file: "src/app.ts",
        from: `  const foreignRead = reads.find((r) => r.reference_matches_query === false || (expectedCurrencyAll && r.currency && String(r.currency).toUpperCase() !== expectedCurrencyAll));`,
        to: `  const foreignRead = reads.find((r) => Number(1) === 2);`
      }
    ],
    suites: ["review_payment_reference_identity_rails_validation.ts"]
  },
  {
    id: "RM-5",
    invariant: "a SECOND capture for one obligation is escalated, never absorbed as an idempotent replay",
    layer: "recordLateMoneyEffectException dual-capture detection (F-12, fixed by this review)",
    edits: [
      {
        file: "src/app.ts",
        from: `  const dualCapture =
    captureEffect && capturedMoneyStates.includes(moneyState) && (await captureSideDualSuccess(args.target, args.event));`,
        to: `  const dualCapture =
    captureEffect && capturedMoneyStates.includes(moneyState) && Number(1) === 2 && (await captureSideDualSuccess(args.target, args.event));`
      }
    ],
    suites: ["review_payment_dual_capture_escalation_validation.ts"]
  },
  {
    id: "RM-6",
    invariant: "dual capture is decided by COUNTING distinct executed capture-side identities, not by a replay test that its own evidence defeats",
    layer: "captureSideExecutedIdentities / dual-capture predicate (Codex blocker, root cause 2)",
    edits: [
      {
        file: "src/app.ts",
        from: `  const captureIdentities = captureEffect ? await captureSideExecutedIdentities({ target: args.target, event: args.event }) : [];
  const dualCapture = captureIdentities.length >= 2;`,
        // the pre-fix predicate: "every executed identity differs from the
        // reported one", which the reported identity's own committed success
        // permanently defeats
        to: `  const captureIdentities = captureEffect ? await captureSideExecutedIdentities({ target: args.target, event: args.event }) : [];
  const reportedIdentity = String(args.event.correlation_id || args.target.correlation_id || "").trim();
  const dualCapture = captureIdentities.length >= 2
    && captureIdentities.every((identity) => !identity.endsWith(\`:\${reportedIdentity}\`));`
      }
    ],
    suites: ["review_payment_dual_capture_durable_escalation_validation.ts"]
  },
  {
    id: "RM-7",
    invariant: "a known double capture is never acknowledged as handled unless its escalation is durably committed with the money evidence",
    layer: "atomic, error-propagating escalation (Codex blocker, root cause 1)",
    edits: [
      {
        file: "src/app.ts",
        from: `    await openPaymentOperationalCaseInTx(c, escalation);`,
        // the pre-fix architecture: the case written on its OWN transaction by
        // the suppressing wrapper, so its failure is invisible and the money
        // evidence commits alone
        to: `    await openPaymentOperationalCase(escalation);`
      }
    ],
    suites: ["review_payment_dual_capture_durable_escalation_validation.ts"]
  },
  {
    id: "RM-4",
    invariant: "prior-attempt resolution refuses a status answer about another operation before reusing an identity",
    layer: "resolvePriorProviderAttempt reference-mismatch guard",
    edits: [
      {
        file: "src/app.ts",
        from: `  if (status.reference_matches_query === false) {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${args.participant_id}:\${args.attempt_type}\`,`,
        to: `  if ((status.reference_matches_query as unknown as string) === "never") {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${args.participant_id}:\${args.attempt_type}\`,`
      }
    ],
    suites: ["review_payment_reference_identity_rails_validation.ts"]
  }
];

function normalizeEol(text, eol) {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}

function gitClean() {
  const status = spawnSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" });
  return String(status.stdout || "").trim() === "";
}

function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const toRun = requested.length ? MUTANTS.filter((m) => requested.includes(m.id)) : MUTANTS;
  if (!toRun.length) throw new Error(`no mutant matched ${JSON.stringify(requested)}`);
  if (!gitClean()) throw new Error("src/ has uncommitted changes; refusing to mutate an unclean tree");

  const report = [];
  for (const mutant of toRun) {
    const originals = new Map();
    try {
      for (const edit of mutant.edits) {
        const current = fs.readFileSync(edit.file, "utf8");
        originals.set(edit.file, current);
        const eol = current.includes("\r\n") ? "\r\n" : "\n";
        const from = normalizeEol(edit.from, eol);
        if (!current.includes(from)) {
          console.error(`  ANCHOR_MISSING ${mutant.id} in ${edit.file}`);
          process.exit(3);
        }
        fs.writeFileSync(edit.file, current.replace(from, () => normalizeEol(edit.to, eol)));
      }
      console.log(`\n[${mutant.id}] ${mutant.layer}\n         invariant: ${mutant.invariant}`);

      const suiteResults = [];
      for (const suite of mutant.suites) {
        const started = Date.now();
        const run = spawnSync(process.execPath, ["scripts/review_ab_driver.cjs", suite], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: process.env
        });
        const out = `${run.stdout || ""}\n${run.stderr || ""}`;
        const compileFailed = /error TS\d+/.test(out) || /TypeScript compilation failed/.test(out);
        // A mutant is KILLED only by a genuine test failure, never by a setup or
        // compile error: that would prove nothing about the invariant.
        const testFailure = /^FAIL /m.test(out) || /failed=[1-9]/.test(out) || /failures=[1-9]/.test(out);
        const killed = testFailure && !compileFailed;
        const firstFailure = (out.match(/^FAIL .*/m) || [""])[0].slice(0, 160);
        suiteResults.push({
          suite,
          killed,
          compile_failed: compileFailed,
          exit: run.status,
          duration_ms: Date.now() - started,
          first_failure: firstFailure || null
        });
        console.log(`  ${killed ? "KILLED " : compileFailed ? "INVALID" : "SURVIVED"} ${suite} (${Date.now() - started}ms)${firstFailure ? `\n            ${firstFailure}` : ""}`);
      }
      report.push({ id: mutant.id, invariant: mutant.invariant, layer: mutant.layer, killed: suiteResults.some((r) => r.killed), suites: suiteResults });
    } finally {
      for (const [file, body] of originals) fs.writeFileSync(file, body);
    }
  }

  if (!gitClean()) throw new Error("src/ was not restored to committed bytes after mutation");

  const killed = report.filter((r) => r.killed).length;
  const outDir = path.join(process.cwd(), ".review-artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "review-mutations.json"), JSON.stringify({ generated_at: new Date().toISOString(), killed, total: report.length, report }, null, 2));
  console.log(`\nREVIEW_MUTATION_PROOF killed=${killed}/${report.length} survived=${report.length - killed}`);
  for (const row of report.filter((r) => !r.killed)) console.log(`  SURVIVED ${row.id}: ${row.invariant}`);
  process.exit(killed === report.length ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(`REVIEW_MUTATION_PROOF_ERROR ${error?.message || error}`);
  process.exit(1);
}
