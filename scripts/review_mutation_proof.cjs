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
 * R9C ROUND 4 — ORACLE mutants (OM-*). The dispatch-time legality oracle
 * (tests/lab/dispatch_legality.ts + tests/lab/oracle.ts) is itself a defence
 * that must be proven non-vacuous: each OM mutant re-introduces one way an
 * oracle can be fooled by hindsight — evidence from after the dispatch, the
 * round-3 late_money_effect exemption, UNKNOWN read as failed — and the
 * temporal negative controls MUST go red. These mutate TEST source only; the
 * src/ clean-tree guard still applies and the exact bytes are restored.
 *
 * Usage:  node scripts/review_mutation_proof.cjs [RM-1 RM-2 ... OM-1a ...]
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
    id: "RM-8",
    invariant: "an unreadable capture-side identity evidence set is never answered as \"not a dual capture\"",
    layer: "readCaptureSideIdentityEvidence fail-closed (Codex round-3 blocker)",
    edits: [
      {
        file: "src/app.ts",
        from: `  } catch (cause) {
    // NOT an empty set. The evidence is unknown, and unknown is its own answer.
    return { outcome: "unreadable", cause };
  }`,
        // the pre-fix swallow: a read error becomes an empty evidence set, which
        // is spelled exactly like "no other capture succeeded"
        to: `  } catch (cause) {
    void cause;
    rows = [];
  }`
      }
    ],
    suites: ["review_payment_dual_capture_durable_escalation_validation.ts"]
  },
  {
    id: "RM-9",
    invariant: "a reported real money effect converges the identity, which is what blocks a release of money that really moved",
    layer: "late-effect identity convergence (the candidate's FR-3 contract)",
    edits: [
      {
        file: "src/app.ts",
        from: `  const settleReportedIdentity = Boolean(correlation);`,
        to: `  const settleReportedIdentity = false && Boolean(correlation);`
      }
    ],
    suites: ["review_payment_dual_capture_escalation_validation.ts"]
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
  },
  // ── R9C ROUND 4 — oracle soundness mutants (test source) ──────────────────
  {
    id: "OM-1a",
    invariant: "M1: a status read positioned AFTER a dispatch never counts as evidence for that dispatch",
    layer: "dispatch_legality E2 provider-order guard",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `      for (const r of requests) {
        if (r.seq >= before.seq) break;
        if (r.seq <= target.seq) continue;`,
        // hindsight: the E2 scan no longer stops at the dispatch position
        to: `      for (const r of requests) {
        if (r.seq <= target.seq) continue;`
      }
    ],
    suites: ["review_oracle_temporal_negative_validation.ts"]
  },
  {
    id: "OM-1b",
    invariant: "M1: an operator verdict or provider callback recorded AFTER the arm instant never counts as evidence for that dispatch",
    layer: "dispatch_legality E3/E4 arm-instant guard",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `      if (operatorAt !== null && operatorAt <= armedAt) return { kind: "operator", at: new Date(operatorAt).toISOString() };`,
        to: `      if (operatorAt !== null) return { kind: "operator", at: new Date(operatorAt).toISOString() };`
      },
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `        if (at === null || at >= armedAt) continue;
        if (!CALLBACK_FAILED[target.family].includes(cb.event_type)) continue;`,
        to: `        if (at === null) continue;
        if (!CALLBACK_FAILED[target.family].includes(cb.event_type)) continue;`
      }
    ],
    suites: ["review_oracle_temporal_negative_validation.ts"]
  },
  {
    id: "OM-2",
    invariant: "M2: a late_money_effect note on the previous identity is NOT pre-dispatch failure evidence (the round-3 exemption Codex rejected)",
    layer: "oracle.ts final-note exemption re-introduced",
    edits: [
      {
        file: "tests/lab/oracle.ts",
        from: `      for (const x of legality.violations) v(x.code, pid, x.detail);`,
        to: `      const convergedLate = attempts.some((a) => a.result_class === "success" && String(a.outcome_note || "").startsWith("late_money_effect:"));
      for (const x of legality.violations) if (!(convergedLate && x.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN")) v(x.code, pid, x.detail);`
      }
    ],
    suites: ["review_oracle_temporal_negative_validation.ts"]
  },
  {
    id: "OM-3",
    invariant: "M3: an UNKNOWN / ambiguous provider answer (5xx, pending) is never read as a declared failure",
    layer: "dispatch_legality isDeclaredFailure",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `  if (answered === "200-ok-false") return true;`,
        to: `  if (answered === "200-ok-false" || answered === "503" || answered === "200-pending" || answered === "lost") return true;`
      }
    ],
    suites: ["review_oracle_temporal_negative_validation.ts"]
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
